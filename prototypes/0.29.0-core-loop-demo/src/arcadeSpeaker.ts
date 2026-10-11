/**
 * 🕹️ The arcade cabinet's speaker: collects the emulator's samples for one
 * NES frame, then queues them as a short AudioBuffer right behind the last
 * one, so the chunks play back to back.
 *
 * The AudioContext is made when the cabinet is focused, which is not a user
 * gesture, so it may start suspended; the cabinet calls resume() from its key
 * handler (a gesture) on the first press.
 */

/** How far ahead of the audio clock a chunk is queued after a gap. */
const LEAD_S = 0.06;
/** Queue further ahead than this (the tab was hidden, the game ran fast)
 *  and the queue restarts at LEAD_S instead of drifting behind the picture. */
const MAX_AHEAD_S = 0.3;
/** Cabinet volume: chiptune square waves are loud next to room audio. */
const VOLUME = 0.35;
/** Samples buffered per chunk: a few frames' worth at 48 kHz. */
const CAPACITY = 8192;

export class ArcadeSpeaker {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private left = new Float32Array(CAPACITY);
  private right = new Float32Array(CAPACITY);
  private count = 0;
  private nextTime = 0;
  /** Chunks queued on the audio clock and not yet ended (clear() stops them). */
  private queued = new Set<AudioBufferSourceNode>();
  readonly sampleRate: number;

  constructor() {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        this.ctx = new Ctor();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = VOLUME;
        this.gain.connect(this.ctx.destination);
      }
    } catch {
      this.ctx = null; // No audio device: the games run silent.
    }
    this.sampleRate = this.ctx?.sampleRate ?? 48000;
  }

  /** Call from a user gesture: browsers start contexts made without one suspended. */
  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** The emulator's per-sample callback. */
  readonly push = (l: number, r: number): void => {
    if (this.count >= CAPACITY) return;
    this.left[this.count] = l;
    this.right[this.count] = r;
    this.count++;
  };

  /** Queue what was collected since the last flush. */
  flush(): void {
    const ctx = this.ctx;
    const n = this.count;
    this.count = 0;
    if (!ctx || !this.gain || n === 0 || ctx.state !== 'running') return;
    const buffer = ctx.createBuffer(2, n, this.sampleRate);
    buffer.copyToChannel(this.left.subarray(0, n), 0);
    buffer.copyToChannel(this.right.subarray(0, n), 1);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = ctx.currentTime;
    if (this.nextTime < now || this.nextTime > now + MAX_AHEAD_S) this.nextTime = now + LEAD_S;
    source.onended = () => this.queued.delete(source);
    this.queued.add(source);
    source.start(this.nextTime);
    this.nextTime += n / this.sampleRate;
  }

  /** Silence the cabinet now (back to the menu): drop what is buffered and
   *  stop what is already queued, so the next game starts a fresh queue. */
  clear(): void {
    this.count = 0;
    for (const source of this.queued) {
      try {
        source.stop();
      } catch {
        /* never started: nothing to stop */
      }
    }
    this.queued.clear();
    this.nextTime = 0;
  }

  close(): void {
    this.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }
}
