/**
 * 🎶 createSpeakerVoice — the state machine, on fake clocks.
 *
 * A fake AudioContext whose currentTime we advance by hand and a fake
 * <audio> element stand in for the browser; the voice is driven frame by
 * frame through update(). Pinned: the entry round on walking in, the loop
 * while the switch is on, stop() holding until the switch cycles, the
 * music-box fallback when a recording refuses to play (once, not every
 * frame), the reset on a party-doc epoch change, and disposal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindPartyDoc } from './partyDoc';
import { createSpeakerVoice, tuneSeconds, REST_BEATS, beatSeconds, TRACKS, isSpeakerPlaying, stopSpeakerLocally } from './partyAudio';

// ── Fakes ────────────────────────────────────────────────────────────────────
class FakeParam {
  value = 0;
  setValueAtTime(v: number) { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; return this; }
  setTargetAtTime(v: number) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  detune = new FakeParam();
  delayTime = new FakeParam();
  type = '';
  connect(n: FakeNode) { return n; }
  disconnect() {}
}
let oscStarts = 0;
class FakeOsc extends FakeNode {
  start() { oscStarts++; }
  stop() {}
}
const gains: FakeNode[] = []; // every gain node made, in order: a voice's master is its first
class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = new FakeNode();
  resume() { return Promise.resolve(); }
  createGain() { const g = new FakeNode(); gains.push(g); return g; }
  createDelay() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createOscillator() { return new FakeOsc(); }
  createMediaElementSource() { return new FakeNode(); }
}
let refusePlay = false;
const audios: FakeAudio[] = [];
class FakeAudio {
  src = '';
  paused = true;
  currentTime = 0;
  duration = 30;
  preload = '';
  crossOrigin = '';
  plays = 0;
  listeners = new Map<string, Array<() => void>>();
  constructor() { audios.push(this); }
  addEventListener(ev: string, fn: () => void) { this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]); }
  play() {
    this.plays++;
    if (refusePlay) return Promise.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' }));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() {}
}

// ONE context for the file: partyAudio caches the AudioContext it makes
// for the page's lifetime, so every test must drive that same clock.
const ctx = new FakeAudioContext();
const g = globalThis as unknown as Record<string, unknown>;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ctx.currentTime = 0;
  oscStarts = 0;
  refusePlay = false;
  audios.length = 0;
  g.window = { AudioContext: function () { return ctx; }, location: { href: 'http://test/' } };
  g.Audio = FakeAudio;
  bindPartyDoc(new Y.Doc());
});
afterEach(() => {
  delete g.window;
  delete g.Audio;
});

const inRoom = (voice: ReturnType<typeof createSpeakerVoice>, on = false, track = 'sung') =>
  voice.update(0.016, { on, inRoom: true, distance: 1, track });
const outside = (voice: ReturnType<typeof createSpeakerVoice>) =>
  voice.update(0.016, { on: false, inRoom: false, distance: 1 });

describe('createSpeakerVoice', () => {
  it('strikes up the recording the moment the player walks in, switch or no switch', async () => {
    const voice = createSpeakerVoice('sp');
    outside(voice);
    expect(audios).toHaveLength(0);
    inRoom(voice);
    await flush();
    expect(audios).toHaveLength(1);
    expect(audios[0].plays).toBe(1);
    expect(audios[0].src).toContain('happy-birthday-sung.ogg');
    expect(voice.playing()).toBe(true);
    expect(isSpeakerPlaying('sp')).toBe(true);
    // One round only while the switch is off: past its end, nothing new.
    audios[0].currentTime = 30;
    ctx.currentTime = 40;
    inRoom(voice);
    expect(audios[0].plays).toBe(1);
    expect(voice.playing()).toBe(false);
    voice.dispose();
  });

  it('loops while the switch is on, a rest after each round, and stops when it goes off', async () => {
    const voice = createSpeakerVoice('sp');
    inRoom(voice, true);
    await flush();
    expect(audios[0].plays).toBe(1);
    // A 30 s recording: the next round is due REST_BEATS after it ends.
    const rest = REST_BEATS * beatSeconds();
    ctx.currentTime = 30 + rest - 1;
    inRoom(voice, true);
    expect(audios[0].plays).toBe(1);
    ctx.currentTime = 30 + rest + 0.1;
    inRoom(voice, true);
    await flush();
    expect(audios[0].plays).toBe(2);
    // Switch off: the recording is paused after the fade.
    inRoom(voice, false);
    await new Promise((r) => setTimeout(r, 900));
    expect(audios[0].paused).toBe(true);
    voice.dispose();
  });

  it('keeps the switch-off fade: the gain is not re-aimed while no round is on', async () => {
    const before = gains.length;
    const voice = createSpeakerVoice('sp');
    inRoom(voice, true);
    await flush();
    const master = gains[before];
    expect(master.gain.value).toBeGreaterThan(0); // aimed at the distance level
    inRoom(voice, false); // silence(0.8): ramped to 0…
    expect(master.gain.value).toBe(0);
    for (let i = 0; i < 30; i++) { ctx.currentTime += 0.016; inRoom(voice, false); }
    expect(master.gain.value).toBe(0); // …and left there
    voice.dispose();
  });

  it('ignores recording metadata that arrives after the fallback to the music box', async () => {
    refusePlay = true;
    const voice = createSpeakerVoice('sp');
    inRoom(voice);
    await flush();
    inRoom(voice); // the synth round, about sixteen seconds
    ctx.currentTime = 1;
    expect(voice.beat()?.bpm).toBe(92);
    for (const fn of audios[0].listeners.get('loadedmetadata') ?? []) fn(); // the 30 s file, late
    ctx.currentTime = 25; // past the synth round, inside the recording's length
    expect(voice.playing()).toBe(false);
    voice.dispose();
  });

  it('stop() holds the loop until the switch has gone off and on again', async () => {
    const voice = createSpeakerVoice('sp');
    inRoom(voice, true);
    await flush();
    stopSpeakerLocally('sp');
    expect(voice.playing()).toBe(false);
    // Still on: held — no new round however long we wait.
    ctx.currentTime = 100;
    inRoom(voice, true);
    await flush();
    expect(audios[0].plays).toBe(1);
    // Off, then on: the loop is back.
    inRoom(voice, false);
    inRoom(voice, true);
    await flush();
    expect(audios[0].plays).toBe(2);
    voice.dispose();
  });

  it('falls back to the music box ONCE when the recording refuses to play', async () => {
    refusePlay = true;
    const voice = createSpeakerVoice('sp');
    inRoom(voice);
    await flush(); // the rejected play() marks the file broken
    inRoom(voice); // …and this frame re-arms the round on the synth
    const after = oscStarts;
    expect(after).toBeGreaterThan(0);
    // Not every frame: the synth round is scheduled exactly once.
    for (let i = 0; i < 20; i++) { ctx.currentTime += 0.016; inRoom(voice); }
    expect(oscStarts).toBe(after);
    expect(voice.beat()?.bpm).toBe(TRACKS.find((t) => t.id === 'music-box')!.bpm);
    voice.dispose();
  });

  it('plays the music box outright for the music-box track, in time', () => {
    const voice = createSpeakerVoice('sp');
    inRoom(voice, false, 'music-box');
    expect(oscStarts).toBeGreaterThan(0);
    expect(audios).toHaveLength(0);
    ctx.currentTime = 0.05 + tuneSeconds() / 2;
    const b = voice.beat()!;
    expect(b.bpm).toBe(92);
    expect(b.beat).toBeCloseTo(12.5, 1);
    voice.dispose();
  });

  it('starts over in the next room: a new party doc resets presence, loop and hold', async () => {
    const voice = createSpeakerVoice('sp');
    inRoom(voice, true);
    await flush();
    stopSpeakerLocally('sp'); // held here…
    bindPartyDoc(new Y.Doc()); // …but this is another room now
    inRoom(voice, true);
    await flush();
    // Walked in again: the entry round plays despite the earlier hold.
    expect(audios[0].plays).toBe(2);
    voice.dispose();
  });

  it('is silenced and forgotten on dispose', async () => {
    const voice = createSpeakerVoice('sp');
    inRoom(voice, true);
    await flush();
    voice.dispose();
    await new Promise((r) => setTimeout(r, 500));
    expect(audios[0].paused).toBe(true);
    expect(isSpeakerPlaying('sp')).toBe(false);
  });
});
