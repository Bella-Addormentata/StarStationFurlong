/**
 * 🎶 Party audio — the speaker's "Happy Birthday".
 *
 * Two sources, one graph. The speaker prefers a bundled RECORDING (TRACKS:
 * three free-licensed renditions in public/audio — sung, choir, jazz trio —
 * licences in public/audio/LICENSES.md), played through an <audio> element
 * routed into the same WebAudio master as everything else, so distance and
 * the hall apply to it. The fourth track, and the fallback whenever a file
 * fails to load, is SYNTHESISED: a score (HAPPY_BIRTHDAY, in F, 3/4) on a
 * celesta-like voice — a sine with a touch of 2nd and 3rd harmonic, a fast
 * attack and a long exponential decay — over a soft broken-chord
 * accompaniment and a little hall echo. Elegant rather than loud (owner
 * ruling 2026-09-25): a music box at a garden party, not a PA system.
 *
 * WHEN it plays (createSpeakerVoice, driven per frame by the speaker's
 * PropAnimHandle):
 *   · the local player ENTERS the room → one round, whatever the speaker's
 *     switch says. The fanfare is the welcome. Local only: no doc write, so
 *     peers are not restarted by every joiner.
 *   · the speaker is ON (`speaker:<itemId>`, the dance floor's switch) → the
 *     tune loops with a rest between rounds; OFF stops it with a short fade.
 *   · volume falls with the player's distance from the speaker — full within
 *     3 m, down to a murmur across the room.
 *
 * The score and its timing are pure data (tested); only the synthesis touches
 * the AudioContext, and it is created lazily on the first play, after the
 * click that entered the room has satisfied the autoplay policy.
 */

/** 🎵 The bundled recordings (public/audio, licences in public/audio/LICENSES.md).
 *  `file: null` is the synthesised music box. The speaker's doc `track`
 *  names one of these ids; an unknown id falls back to the first. */
export interface Track {
  id: string;
  title: string;
  credit: string;
  file: string | null;
  /** Beats per minute — exact for the music box (its score), listened-for
   *  on the recordings (they carry no tempo data). The dancer's clock. */
  bpm: number;
}
export const TRACKS: Track[] = [
  {
    id: 'sung',
    title: 'Happy Birthday — sung (English & German)',
    credit: 'Alexander Stephens & Hanns Christian Müller · CC BY-SA 3.0 · Wikimedia Commons',
    file: '/audio/happy-birthday-sung.ogg',
    bpm: 72,
  },
  {
    id: 'choir',
    title: 'Happy Birthday — choir',
    credit: 'Tom Kincaid / VOLE.wtf · CC0',
    file: '/audio/happy-birthday-choir.mp3',
    bpm: 100,
  },
  {
    id: 'jazz',
    title: 'Happy Birthday — jazz trio',
    credit: 'Tom Kincaid / VOLE.wtf · CC0',
    file: '/audio/happy-birthday-jazz-trio.mp3',
    bpm: 120,
  },
  {
    id: 'music-box',
    title: 'Happy Birthday — music box',
    credit: 'synthesised in WebAudio',
    file: null,
    bpm: 92, // == TEMPO_BPM
  },
];
export function trackById(id: string): Track {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
export function nextTrackId(id: string): string {
  const i = TRACKS.findIndex((t) => t.id === id);
  return TRACKS[(i + 1) % TRACKS.length].id;
}

import { partyDocEpoch } from './partyDoc';

export interface Note {
  /** MIDI note number, or null for a rest. */
  midi: number | null;
  /** Length in beats (3/4 time). */
  beats: number;
}

export const TEMPO_BPM = 92;
export const BEATS_PER_BAR = 3;
/** Silence between rounds while the speaker loops, in beats. */
export const REST_BEATS = 6;

// F major: C4 60 · D4 62 · E4 64 · F4 65 · G4 67 · A4 69 · Bb4 70 · C5 72.
// A one-beat pickup ("Hap-py"), then eight bars.
export const HAPPY_BIRTHDAY: Note[] = [
  { midi: 60, beats: 0.75 }, { midi: 60, beats: 0.25 },
  { midi: 62, beats: 1 }, { midi: 60, beats: 1 }, { midi: 65, beats: 1 },
  { midi: 64, beats: 2 }, { midi: 60, beats: 0.75 }, { midi: 60, beats: 0.25 },
  { midi: 62, beats: 1 }, { midi: 60, beats: 1 }, { midi: 67, beats: 1 },
  { midi: 65, beats: 2 }, { midi: 60, beats: 0.75 }, { midi: 60, beats: 0.25 },
  { midi: 72, beats: 1 }, { midi: 69, beats: 1 }, { midi: 65, beats: 1 },
  { midi: 64, beats: 1 }, { midi: 62, beats: 1 }, { midi: 70, beats: 0.75 }, { midi: 70, beats: 0.25 },
  { midi: 69, beats: 1 }, { midi: 65, beats: 1 }, { midi: 67, beats: 1 },
  { midi: 65, beats: 3 },
];

/** Accompaniment, one chord per bar after the pickup (bar 1 starts at beat 1).
 *  Voiced low and close so it sits under the melody. */
export const HAPPY_BIRTHDAY_CHORDS: Array<{ bar: number; midi: number[] }> = [
  { bar: 1, midi: [53, 57, 60] }, // F
  { bar: 2, midi: [48, 52, 55, 58] }, // C7
  { bar: 3, midi: [48, 52, 55, 58] }, // C7
  { bar: 4, midi: [53, 57, 60] }, // F
  { bar: 5, midi: [53, 57, 60, 63] }, // F7 — leaning into the Bb
  { bar: 6, midi: [46, 50, 53] }, // Bb
  { bar: 7, midi: [48, 52, 55, 58] }, // C7
  { bar: 8, midi: [53, 57, 60] }, // F
];

export function beatSeconds(): number {
  return 60 / TEMPO_BPM;
}

export function tuneBeats(): number {
  return HAPPY_BIRTHDAY.reduce((n, note) => n + note.beats, 0);
}

/** One round of the tune, in seconds (no rest). */
export function tuneSeconds(): number {
  return tuneBeats() * beatSeconds();
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Every melody note as (startBeat, midi, beats) — the timing the synth and
 *  the tests both read. */
export function melodyEvents(): Array<{ at: number; midi: number; beats: number }> {
  const out: Array<{ at: number; midi: number; beats: number }> = [];
  let at = 0;
  for (const n of HAPPY_BIRTHDAY) {
    if (n.midi !== null) out.push({ at, midi: n.midi, beats: n.beats });
    at += n.beats;
  }
  return out;
}

/** The accompaniment as (startBeat, midi, beats, bass): a broken chord, one
 *  note per beat cycling through the voicing, with the root an octave down on
 *  the bar's first beat. */
export function accompanimentEvents(): Array<{ at: number; midi: number; beats: number; bass: boolean }> {
  const out: Array<{ at: number; midi: number; beats: number; bass: boolean }> = [];
  for (const ch of HAPPY_BIRTHDAY_CHORDS) {
    const barStart = 1 + (ch.bar - 1) * BEATS_PER_BAR; // after the one-beat pickup
    for (let b = 0; b < BEATS_PER_BAR; b++) {
      out.push({ at: barStart + b, midi: ch.midi[b % ch.midi.length], beats: 1, bass: false });
    }
    out.push({ at: barStart, midi: ch.midi[0] - 12, beats: BEATS_PER_BAR, bass: true });
  }
  return out;
}

// ── Synthesis ───────────────────────────────────────────────────────────────

type Ctx = AudioContext;
let shared: Ctx | null = null;

function ensureContext(): Ctx | null {
  if (typeof window === "undefined") return null;
  const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!shared) {
    try {
      shared = new AC();
    } catch {
      return null;
    }
  }
  if (shared.state === "suspended") {
    // Needs a user gesture to have happened — the click that entered the room
    // is one. If it has not, the promise rejects quietly and the notes wait:
    // currentTime does not advance while suspended, so nothing piles up.
    shared.resume().catch(() => {});
  }
  return shared;
}

/** A celesta-ish note: fundamental + soft 2nd and 3rd partials, a fast
 *  attack, a long exponential decay. `hold` lengthens the decay for held
 *  notes so the last "you" rings. */
function celesta(ctx: Ctx, dest: AudioNode, hz: number, t0: number, hold: number, gain: number): OscillatorNode[] {
  const decay = 1.2 + hold * 0.6;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  env.connect(dest);
  const oscs: OscillatorNode[] = [];
  for (const [mult, part, detune] of [[1, 1, 0], [2, 0.32, 3], [3, 0.1, -2]] as const) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(hz * mult, t0);
    o.detune.setValueAtTime(detune, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(part, t0);
    o.connect(g).connect(env);
    o.start(t0);
    o.stop(t0 + decay + 0.05);
    oscs.push(o);
  }
  return oscs;
}

/** The accompaniment voice: a triangle through a low-pass, quiet and short. */
function pluck(ctx: Ctx, dest: AudioNode, hz: number, t0: number, seconds: number, gain: number, bass: boolean): OscillatorNode[] {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.5, seconds * (bass ? 1.6 : 0.9)));
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(bass ? 700 : 1400, t0);
  const o = ctx.createOscillator();
  o.type = bass ? "sine" : "triangle";
  o.frequency.setValueAtTime(hz, t0);
  o.connect(lp).connect(env).connect(dest);
  o.start(t0);
  o.stop(t0 + Math.max(0.5, seconds * 1.6) + 0.05);
  return [o];
}

/** Schedule one full round of the tune into `dest`, starting at ctx time t0.
 *  Returns the oscillators (so a stop can silence them) and the round's end. */
function scheduleRound(ctx: Ctx, dest: AudioNode, t0: number): { oscs: OscillatorNode[]; end: number } {
  const bs = beatSeconds();
  const oscs: OscillatorNode[] = [];
  for (const ev of melodyEvents()) {
    oscs.push(...celesta(ctx, dest, midiToHz(ev.midi), t0 + ev.at * bs, ev.beats, 0.22));
  }
  for (const ev of accompanimentEvents()) {
    oscs.push(...pluck(ctx, dest, midiToHz(ev.midi), t0 + ev.at * bs, ev.beats * bs, ev.bass ? 0.07 : 0.045, ev.bass));
  }
  return { oscs, end: t0 + tuneSeconds() };
}

export interface SpeakerVoice {
  /** Per-frame drive: the speaker's doc switch and track, the local player's
   *  presence and their distance from the speaker in metres. */
  update(dt: number, state: { on: boolean; inRoom: boolean; distance: number; track?: string }): void;
  /** Is anything sounding right now (the entry round or the loop)? */
  playing(): boolean;
  /** 🕺 Where the music is: beats since the current round began, and the
   *  track's tempo — null between rounds. What the dancer keeps time to. */
  beat(): { beat: number; bpm: number } | null;
  /** 🔇 Stop, locally: fades out whatever is sounding, including the entry
   *  round. The loop only resumes if the doc switch is turned on again. */
  stop(): void;
  /** Silence everything and release the graph (item removed / room left). */
  dispose(): void;
}

// ── The room's voices, by speaker item id, so the UI can ask and stop them ──
const voices = new Map<string, SpeakerVoice>();

export function isSpeakerPlaying(itemId: string): boolean {
  return voices.get(itemId)?.playing() ?? false;
}

/** 🔇 Click-to-stop: silence this speaker on THIS client. */
export function stopSpeakerLocally(itemId: string): void {
  voices.get(itemId)?.stop();
}

/** 🕺 The beat this speaker is on right now (null while silent). */
export function speakerBeat(itemId: string): { beat: number; bpm: number } | null {
  return voices.get(itemId)?.beat() ?? null;
}

/** Full volume within this radius of the speaker… */
const NEAR_M = 3;
/** …fading to FAR_GAIN at this radius. */
const FAR_M = 12;
const FAR_GAIN = 0.12;
const MASTER = 0.8;

export function createSpeakerVoice(itemId: string): SpeakerVoice {
  let ctx: Ctx | null = null;
  let master: GainNode | null = null;
  let live: OscillatorNode[] = []; // everything scheduled and not yet stopped
  let roundEnd = -1; // ctx time the current/last round ends; <0 = none
  let wasInRoom = false;
  /** The party doc this voice's presence / loop / hold belong to: a room
   *  swap keeps the World and may reuse a same-id speaker's group, so the
   *  state is reset when the doc's epoch changes — the next room gets its
   *  entry round, and a hold does not follow you (Copilot review, PR #169). */
  let epoch = partyDocEpoch();
  /** Seconds the player has been continuously OUT of the room. Presence
   *  blinks for a frame or two as a room builds (the walk-in flipped
   *  true → false → true a second apart), and that blink paused the entry
   *  recording before it had started — so "left" needs 0.6 s of absence. */
  let away = 0;
  let looping = false;
  /** Set by stop(): the doc switch has to go off→on again to restart. */
  let held = false;
  /** 🎵 The recording: one <audio> per voice, routed into the same master so
   *  distance and the hall apply to it too. A track that fails to load flips
   *  `fileBroken` and the music box takes over. */
  let trackId = TRACKS[0].id;
  let audio: HTMLAudioElement | null = null;
  let audioSrc: MediaElementAudioSourceNode | null = null;
  let fileBroken = false;
  /** The current round was started on the recording (so a refused play()
   *  means "fall back", once) — cleared the moment the music box takes over. */
  let fileRound = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  const graph = (): boolean => {
    if (master) return true;
    ctx = ensureContext();
    if (!ctx) return false;
    master = ctx.createGain();
    master.gain.setValueAtTime(0, ctx.currentTime);
    // A little hall: a short feedback delay, dulled, mixed in quietly.
    const delay = ctx.createDelay(1.0);
    delay.delayTime.setValueAtTime(0.27, ctx.currentTime);
    const fb = ctx.createGain();
    fb.gain.setValueAtTime(0.3, ctx.currentTime);
    const dull = ctx.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.setValueAtTime(2400, ctx.currentTime);
    const wet = ctx.createGain();
    wet.gain.setValueAtTime(0.28, ctx.currentTime);
    master.connect(ctx.destination);
    master.connect(delay);
    delay.connect(dull).connect(fb).connect(delay);
    dull.connect(wet).connect(ctx.destination);
    return true;
  };

  const ensureAudio = (): HTMLAudioElement | null => {
    if (!ctx || !master || typeof Audio === 'undefined') return null;
    if (!audio) {
      audio = new Audio();
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
      audio.addEventListener('error', () => { fileBroken = true; });
      audio.addEventListener('loadedmetadata', () => {
        // A round is as long as the file, once we know it — while the round
        // IS the file: metadata that arrives after the voice fell back to
        // the music box would stretch the synth's round to the recording's
        // length (Copilot review, PR #169).
        if (audio && ctx && fileRound && roundEnd > 0 && Number.isFinite(audio.duration)) roundEnd = roundStart + audio.duration;
      });
      audioSrc = ctx.createMediaElementSource(audio);
      audioSrc.connect(master);
    }
    return audio;
  };
  let roundStart = 0;
  const startRound = (at: number) => {
    if (!graph() || !ctx || !master) return;
    const t0 = Math.max(at, ctx.currentTime + 0.05);
    const track = trackById(trackId);
    if (track.file && !fileBroken) {
      const el = ensureAudio();
      if (el) {
        if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
        const src = new URL(track.file, window.location.href).href;
        if (el.src !== src) { el.src = src; fileBroken = false; }
        const delayMs = Math.max(0, (t0 - ctx.currentTime) * 1000);
        roundStart = t0;
        roundEnd = t0 + (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 60);
        fileRound = true;
        const go = () => {
          if (!audio || audio !== el) return;
          el.currentTime = 0;
          el.play().catch((e: unknown) => {
            fileBroken = true;
            const err = e as { name?: string; message?: string } | undefined;
            console.warn('[partyAudio] the recording would not play — music box instead:', err?.name, err?.message);
          });
        };
        // Timers are throttled in background tabs; anything under a beat or
        // so starts now rather than late.
        if (delayMs < 400) go();
        else setTimeout(go, delayMs);
        // If the file is unusable we find out on 'error'; the next update
        // sees fileBroken and re-arms the round on the music box.
        return;
      }
    }
    // The music box never plays over a recording.
    if (audio) { audio.pause(); if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; } }
    fileRound = false;
    const r = scheduleRound(ctx, master, t0);
    live.push(...r.oscs);
    roundStart = t0;
    roundEnd = r.end;
    // Forget oscillators that have surely finished.
    if (live.length > 600) live = live.slice(-400);
  };

  const silence = (fadeSeconds: number, _why: string) => {
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + fadeSeconds);
    for (const o of live) {
      try {
        o.stop(now + fadeSeconds + 0.02);
      } catch {
        /* already stopped */
      }
    }
    live = [];
    roundEnd = -1;
    if (audio) {
      // Whatever its state (a play() may still be pending on a loading file),
      // the recording stops once the fade is done.
      const el = audio;
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => { el.pause(); pauseTimer = null; }, fadeSeconds * 1000 + 30);
    }
  };

  const voice: SpeakerVoice = {
    update(_dt, { on, inRoom, distance, track }) {
      const now_epoch = partyDocEpoch();
      if (now_epoch !== epoch) {
        epoch = now_epoch;
        silence(0.2, 'room-swap');
        wasInRoom = false;
        away = 0;
        looping = false;
        held = false;
      }
      if (track && track !== trackId) {
        // A new track mid-round: cut over and, if music was wanted, restart on it.
        const wanted = looping || (ctx !== null && roundEnd > 0 && ctx.currentTime < roundEnd);
        trackId = track;
        fileBroken = false;
        if (wanted) { silence(0.3, 'track-switch'); startRound(ctx ? ctx.currentTime + 0.35 : 0); }
      }
      if (!inRoom) {
        away += _dt;
        if (wasInRoom && away > 0.6) {
          silence(0.6, 'left-room');
          wasInRoom = false;
          looping = false;
          held = false;
        }
        return;
      }
      away = 0;
      // 🎉 The fox has just walked in: strike up, whatever the switch says.
      if (!wasInRoom) {
        wasInRoom = true;
        startRound(0);
      }
      if (!on) held = false; // the switch went off: a later "on" may start it again
      if (on && !looping && !held) {
        looping = true;
        if (roundEnd < 0) startRound(0);
      } else if (!on && looping) {
        looping = false;
        // The switch is a stop, not a "finish the verse": fade out now.
        silence(0.8, 'switch-off');
      }
      if (!ctx || !master) return;
      const now = ctx.currentTime;
      // A recording that failed to load or play: fall back to the music box
      // — ONCE. `fileRound` is what makes this edge-triggered: the synth
      // round clears it, so this cannot re-arm every frame (it did, and
      // scheduled a fresh round of oscillators per frame — caught while
      // verifying PR #169's beat sync).
      // Any broken FILE round, playing or not: a decode error can land after
      // play() has started the element (Copilot review, PR #169) — startRound
      // pauses it before the synth.
      if (fileBroken && fileRound && roundEnd > 0 && now < roundEnd) {
        roundEnd = -1;
        startRound(0);
      }
      // Loop: queue the next round a rest after this one ends.
      if (looping && roundEnd > 0 && now > roundEnd + REST_BEATS * beatSeconds() - 0.3) {
        startRound(roundEnd + REST_BEATS * beatSeconds());
      }
      // Distance: full near the speaker, a murmur across the room — while a
      // round is on. silence() has just ramped the gain to 0; re-aiming it
      // at an audible level here undid that fade every frame, and a stopped
      // recording stayed audible until its delayed pause (Copilot review,
      // PR #169).
      if (roundEnd > 0) {
        const f = Math.min(1, Math.max(0, (distance - NEAR_M) / (FAR_M - NEAR_M)));
        const g = MASTER * (1 - f * (1 - FAR_GAIN));
        master.gain.setTargetAtTime(g, now, 0.15);
      }
    },
    playing() {
      return !!ctx && roundEnd > 0 && ctx.currentTime < roundEnd + 1.5;
    },
    beat() {
      if (!ctx || roundEnd < 0 || ctx.currentTime >= roundEnd) return null;
      const track = trackById(trackId);
      // A recording reports its own clock (it may have started late, loading);
      // the music box runs on the context clock it was scheduled against.
      const onFile = fileRound && !!audio && !audio.paused;
      const seconds = onFile ? audio!.currentTime : ctx.currentTime - roundStart;
      // Between the music box's tempo and the recording's: whichever is sounding.
      const bpm = onFile ? track.bpm : TEMPO_BPM;
      if (seconds < 0) return null;
      return { beat: (seconds * bpm) / 60, bpm };
    },
    stop() {
      silence(0.5, 'stop');
      looping = false;
      held = true;
    },
    dispose() {
      silence(0.3, 'dispose');
      if (audio) { const el = audio; setTimeout(() => { el.pause(); el.removeAttribute('src'); el.load(); }, 400); audio = null; }
      if (audioSrc) { const src = audioSrc; setTimeout(() => src.disconnect(), 500); audioSrc = null; }
      if (master) {
        const mnode = master;
        setTimeout(() => mnode.disconnect(), 500);
      }
      master = null;
      if (voices.get(itemId) === voice) voices.delete(itemId);
    },
  };
  voices.set(itemId, voice);
  return voice;
}
