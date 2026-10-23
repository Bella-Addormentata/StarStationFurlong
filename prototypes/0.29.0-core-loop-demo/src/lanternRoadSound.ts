/**
 * 🏮🔊 Lantern Road's sound chip: the effects and the music, rendered as
 * samples for the cabinet's speaker (arcadeSpeaker.ts) the way the NES
 * cabinet's emulator feeds it, so the double-wide cabinet sounds for the
 * page at it and nowhere else, through the same volume, queue and gesture
 * gate as a ROM.
 *
 * The chip is a small software APU in the 8-bit manner: pulse waves with a
 * duty, a triangle for the bass, a 15-bit shift-register noise for drums,
 * whooshes and smoke, and no samples or files to load, so the game carries
 * its sound the way it carries its art: in code, under the app's licence.
 * Nothing here touches the AudioContext or the game's state; frame() is a
 * pure function of what it has rendered so far, and a test can listen.
 *
 * EFFECTS come from the game's cues (games/lanternRoad.ts LrCue): a frame
 * that was stepped with a cue list says what happened in it, and each kind
 * of cue is a little program of stages, a tone or a noise sliding from one
 * pitch to another over so many frames, on up to two channels at once.
 * One of each kind a frame: four players jumping together is one jump,
 * panned to the first of them. Cues carry where they happened along the
 * road, and the chip pans them across the two tubes: a coin on the left
 * tube rings in the left speaker.
 *
 * MUSIC is read off the state, not the cues, so a page that comes to the
 * cabinet mid-game plays the right tune: the road's theme while the group
 * walks (looped), the Great Lantern's while it is coming down or fighting,
 * silence while it burns out and the gate stands open, and the STAGE CLEAR
 * jingle once through on the card. The road's theme keeps the game's frame
 * count and the jingle the card's, so every page at the cabinet is on the
 * same bar, and a page that gets its speaker late comes in where the tune
 * is rather than at bar one. Three tunes in data (LR_TUNES), each a few
 * tracks of [note, sixteenths] pairs, written for the game in D minor, the
 * tuned effects in the same key. Music is on by default and can be left
 * out (createLanternRoadSound's `music`), which a cabinet switch can use
 * later.
 */

import { CLEAR_FRAMES, LR_VIEW_W, type LrCue, type LrCueKind, type LrState } from './games/lanternRoad';

/** The game's frames a second: a frame of sound is this long. */
export const LR_SOUND_FPS = 60;

export interface LrSoundChip {
  /**
   * Render the sound of one frame, just stepped: the state after it and the
   * cues it collected, as stereo samples (−1..1) into `push`. Every frame
   * must come through here, cues or none: the music runs on it.
   */
  frame(s: LrState, cues: readonly LrCue[], push: (left: number, right: number) => void): void;
}

export interface LrSoundOptions {
  /** Play the tunes as well as the effects (default on). */
  music?: boolean;
}

// ── Waves ────────────────────────────────────────────────────────────────────

type Wave = 'pulse' | 'tri' | 'noise';

/** An oscillator's state: the phase of a tone, the shift register of a noise. */
interface Osc {
  phase: number;
  lfsr: number;
  acc: number;
}

/** The noise's shift register at rest: a mixed word, so a noise doesn't open
 *  on a run of one level (seeded with 1 it gives fourteen alike: a thump). */
const LFSR_SEED = 0x2d5a;

const newOsc = (): Osc => ({ phase: 0, lfsr: LFSR_SEED, acc: 0 });

function resetOsc(o: Osc): void {
  o.phase = 0;
  o.lfsr = LFSR_SEED;
  o.acc = 0;
}

/** The next sample (−1..1) of a wave at `hz` (a noise's shifts a second). */
function osc(o: Osc, wave: Wave, duty: number, hz: number, sampleRate: number): number {
  if (wave === 'noise') {
    o.acc += hz / sampleRate;
    while (o.acc >= 1) {
      o.acc -= 1;
      const bit = (o.lfsr ^ (o.lfsr >> 1)) & 1;
      o.lfsr = (o.lfsr >> 1) | (bit << 14);
    }
    return o.lfsr & 1 ? 1 : -1;
  }
  o.phase += hz / sampleRate;
  if (o.phase >= 1) o.phase -= Math.floor(o.phase);
  // A pulse up for `duty` of its cycle, its two levels set so it carries no
  // offset: a narrow one would otherwise sit below zero and step on every gap.
  if (wave === 'pulse') return o.phase < duty ? 2 * (1 - duty) : -2 * duty;
  return 4 * Math.abs(o.phase - 0.5) - 1;
}

const midiHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

// ── Effects ──────────────────────────────────────────────────────────────────

/** One stage of an effect: a wave sliding from one pitch to another. */
export interface LrFxStage {
  wave: Wave;
  /** Pulse width, 0..1 (pulse only). */
  duty: number;
  /** Hz at the start and the end (a noise's shifts a second); the slide between is exponential. */
  from: number;
  to: number;
  /** Frames. */
  len: number;
  /** Level, 0..1: the wave's half swing (a narrow pulse peaks above it). */
  vol: number;
  /** The level over the stage: fading out, held (with a short fade at the end), or fading with a flutter. */
  env: 'fade' | 'hold' | 'flutter';
  /** Semitones added to the pitch, one every other frame round the list (a sparkle). */
  arp?: readonly number[];
}

/** An effect: layers, each a run of stages on a channel of its own. */
export type LrFx = readonly (readonly LrFxStage[])[];

const pulse = (from: number, to: number, len: number, vol: number, duty = 0.25, env: LrFxStage['env'] = 'fade', arp?: readonly number[]): LrFxStage =>
  ({ wave: 'pulse', duty, from, to, len, vol, env, arp });
const tri = (from: number, to: number, len: number, vol: number, env: LrFxStage['env'] = 'fade'): LrFxStage =>
  ({ wave: 'tri', duty: 0.5, from, to, len, vol, env });
const noise = (from: number, to: number, len: number, vol: number, env: LrFxStage['env'] = 'fade'): LrFxStage =>
  ({ wave: 'noise', duty: 0.5, from, to, len, vol, env });

/** The sound of each cue. `clear` has none of its own: the music plays its
 *  jingle. The tuned ones (coin, heal, bonus, gate) sit in the road's D
 *  minor, so a coin never argues with the bass. */
export const LR_FX: Readonly<Record<LrCueKind, LrFx>> = {
  jump: [[pulse(260, 880, 9, 0.16)]],
  drop: [[pulse(520, 180, 7, 0.12)]],
  swing: [[noise(14000, 3000, 6, 0.1)]],
  hit: [[pulse(200, 90, 6, 0.2, 0.125, 'hold')], [noise(9000, 3000, 3, 0.1)]],
  beaten: [[noise(7000, 1500, 14, 0.16)], [pulse(440, 110, 12, 0.08, 0.5)]],
  // A5 up to D6.
  coin: [[pulse(880, 880, 4, 0.14, 0.5, 'hold'), pulse(1175, 1175, 12, 0.14, 0.5)]],
  // D5 F5 A5 D6.
  heal: [[
    pulse(587, 587, 3, 0.12, 0.25, 'hold'), pulse(698, 698, 3, 0.12, 0.25, 'hold'), pulse(880, 880, 3, 0.12, 0.25, 'hold'),
    pulse(1175, 1175, 12, 0.12, 0.25),
  ]],
  // A5 C6 D6 F6, sparkling over F, Bb and C.
  bonus: [[
    pulse(880, 880, 3, 0.13, 0.5, 'hold'), pulse(1047, 1047, 3, 0.13, 0.5, 'hold'), pulse(1175, 1175, 3, 0.13, 0.5, 'hold'),
    pulse(1397, 1397, 16, 0.13, 0.5, 'fade', [0, 5, 7]),
  ]],
  hurt: [[pulse(420, 140, 14, 0.18, 0.5, 'flutter')]],
  ko: [[pulse(660, 80, 36, 0.18, 0.25)], [noise(4000, 1000, 10, 0.08)]],
  fall: [[pulse(700, 120, 26, 0.14, 0.25, 'hold'), noise(6000, 1500, 12, 0.14)]],
  puff: [[noise(3000, 800, 10, 0.11)]],
  'boss-enter': [[tri(90, 36, 100, 0.3, 'flutter')], [pulse(110, 55, 70, 0.1, 0.125)]],
  'boss-fire': [[noise(12000, 2500, 16, 0.15)], [pulse(900, 260, 12, 0.09, 0.25)]],
  'boss-shake': [[noise(2500, 2500, 40, 0.09, 'flutter')]],
  'boss-slam': [[noise(1800, 400, 24, 0.26)], [tri(80, 24, 30, 0.3)]],
  'boss-hit': [[pulse(280, 120, 7, 0.2, 0.125, 'hold')], [noise(9000, 2000, 4, 0.1)]],
  'boss-down': [[noise(10000, 600, 100, 0.2)], [pulse(880, 55, 100, 0.12, 0.25)]],
  // D6 F#6 A6 D7 over D5: the one bright chord, with the street silent.
  gate: [
    [
      pulse(1175, 1175, 6, 0.14, 0.5, 'hold'), pulse(1480, 1480, 6, 0.14, 0.5, 'hold'), pulse(1760, 1760, 6, 0.14, 0.5, 'hold'),
      pulse(2349, 2349, 30, 0.14, 0.5),
    ],
    [tri(587, 587, 40, 0.12)],
  ],
  clear: [],
};

/** Effects sounding at once (a two-layer effect takes two): four players'
 *  doings and the Great Lantern's besides. */
const FX_CHANNELS = 8;

interface FxChannel {
  stages: readonly LrFxStage[] | null;
  stage: number;
  /** Frames into the stage. */
  f: number;
  /** Frames since it was struck: one struck this frame is never given up. */
  age: number;
  left: number;
  right: number;
  osc: Osc;
}

/** Frames a channel has left to play. */
function framesLeft(ch: FxChannel): number {
  if (!ch.stages) return 0;
  let left = ch.stages[ch.stage]!.len - ch.f;
  for (let i = ch.stage + 1; i < ch.stages.length; i++) left += ch.stages[i]!.len;
  return left;
}

/** The level of a stage `f` frames in. */
function stageLevel(st: LrFxStage, f: number): number {
  const t = f / st.len;
  switch (st.env) {
    case 'hold':
      return st.vol * Math.min(1, (st.len - f) / 2);
    case 'flutter':
      return st.vol * (1 - t) * (f & 2 ? 0.45 : 1);
    default:
      return st.vol * (1 - t);
  }
}

/** The pitch of a stage `f` frames in. */
function stageHz(st: LrFxStage, f: number): number {
  let hz = st.from * Math.pow(st.to / st.from, f / st.len);
  if (st.arp) hz *= Math.pow(2, st.arp[(f >> 1) % st.arp.length]! / 12);
  return hz;
}

// ── Music ────────────────────────────────────────────────────────────────────

export interface LrTrack {
  wave: Wave;
  /** Pulse width (pulse only). */
  duty?: number;
  vol: number;
  /** [note, sixteenths] pairs: a MIDI number, 0 for a rest; on a noise track a drum (LR_DRUMS). */
  notes: readonly (readonly [number, number])[];
}

export interface LrTune {
  /** Frames a sixteenth lasts. */
  step: number;
  /** Round again at the end, or stop. */
  loop: boolean;
  tracks: readonly LrTrack[];
}

export type LrTuneId = 'road' | 'boss' | 'clear';

/** A noise track's notes. */
export const LR_DRUMS = { kick: 1, snare: 2, hat: 3 } as const;
const { kick: K, snare: S, hat: H } = LR_DRUMS;

/** Each drum: the noise's shifts a second at the start and the end, frames, and its level against the track's. */
const DRUM: Readonly<Record<number, { from: number; to: number; len: number; gain: number }>> = {
  [K]: { from: 1200, to: 300, len: 5, gain: 1.4 },
  [S]: { from: 5000, to: 2500, len: 7, gain: 1 },
  [H]: { from: 15000, to: 12000, len: 2, gain: 0.6 },
};

type Notes = readonly (readonly [number, number])[];

const bar = (...notes: Notes): Notes => notes;
/** A bar of eighths. */
const eighths = (...notes: number[]): Notes => notes.map((n) => [n, 2] as const);
/** A bar of offbeat eighths: a rest, then the note, four times. */
const offbeats = (...notes: number[]): Notes => notes.flatMap((n) => [[0, 2], [n, 2]] as const);
const BEAT = eighths(K, H, S, H, K, H, S, H);
const FILL = eighths(K, H, S, S, K, S, S, S);
const DRIVE = eighths(K, H, K, H, S, H, K, H);

// D minor pentatonic with the festival's flattened second and sixth where
// the Great Lantern wants them. D4 = 62.
export const LR_TUNES: Readonly<Record<LrTuneId, LrTune>> = {
  // The road: a walking tune, eight bars at 150 to the beat, round and round.
  road: {
    step: 6,
    loop: true,
    tracks: [
      {
        wave: 'pulse', duty: 0.25, vol: 0.1,
        notes: [
          ...bar([74, 3], [74, 1], [72, 2], [69, 2], [67, 4], [69, 2], [72, 2]),
          ...bar([74, 3], [74, 1], [77, 2], [74, 2], [72, 6], [0, 2]),
          ...bar([69, 3], [69, 1], [67, 2], [65, 2], [62, 4], [65, 2], [67, 2]),
          ...bar([69, 6], [72, 2], [69, 4], [67, 2], [65, 2]),
          ...bar([74, 3], [74, 1], [72, 2], [69, 2], [67, 4], [69, 2], [72, 2]),
          ...bar([74, 3], [74, 1], [77, 2], [79, 2], [81, 6], [0, 2]),
          ...bar([79, 3], [79, 1], [77, 2], [74, 2], [72, 4], [74, 2], [77, 2]),
          ...bar([74, 4], [72, 2], [69, 2], [67, 2], [65, 2], [62, 4]),
        ],
      },
      {
        wave: 'pulse', duty: 0.125, vol: 0.05,
        notes: [
          ...offbeats(65, 69, 65, 69),
          ...offbeats(65, 69, 64, 67),
          ...offbeats(62, 65, 60, 65),
          ...offbeats(60, 64, 59, 62),
          ...offbeats(65, 69, 65, 69),
          ...offbeats(65, 69, 64, 67),
          ...offbeats(62, 65, 60, 65),
          ...offbeats(60, 64, 62, 65),
        ],
      },
      {
        wave: 'tri', vol: 0.14,
        notes: [
          ...eighths(38, 38, 45, 38, 38, 45, 38, 45),
          ...eighths(38, 38, 45, 38, 36, 36, 43, 36),
          ...eighths(34, 34, 41, 34, 41, 41, 48, 41),
          ...eighths(45, 45, 52, 45, 43, 43, 50, 43),
          ...eighths(38, 38, 45, 38, 38, 45, 38, 45),
          ...eighths(38, 38, 45, 38, 36, 36, 43, 36),
          ...eighths(34, 34, 41, 34, 41, 41, 48, 41),
          ...eighths(45, 45, 52, 45, 38, 38, 45, 38),
        ],
      },
      {
        wave: 'noise', vol: 0.07,
        notes: [...BEAT, ...BEAT, ...BEAT, ...FILL, ...BEAT, ...BEAT, ...BEAT, ...FILL],
      },
    ],
  },
  // The Great Lantern: faster, on the festival scale, a pulse under it.
  boss: {
    step: 5,
    loop: true,
    tracks: [
      {
        wave: 'pulse', duty: 0.5, vol: 0.1,
        notes: [
          ...bar([74, 2], [75, 2], [74, 2], [70, 2], [67, 4], [70, 2], [74, 2]),
          ...bar([75, 2], [74, 2], [70, 2], [67, 2], [69, 8]),
          ...bar([74, 2], [75, 2], [74, 2], [70, 2], [67, 4], [70, 2], [74, 2]),
          ...bar([79, 2], [75, 2], [74, 2], [70, 2], [69, 4], [62, 4]),
          ...bar([81, 2], [82, 2], [81, 2], [77, 2], [74, 4], [77, 2], [81, 2]),
          ...bar([82, 2], [81, 2], [77, 2], [74, 2], [76, 8]),
          ...bar([81, 2], [82, 2], [81, 2], [77, 2], [74, 4], [77, 2], [81, 2]),
          ...bar([86, 2], [82, 2], [81, 2], [77, 2], [75, 4], [74, 4]),
        ],
      },
      {
        wave: 'pulse', duty: 0.25, vol: 0.05,
        notes: [
          ...Array.from({ length: 4 * 8 }, () => [[62, 1], [0, 1]] as const).flat(),
          ...Array.from({ length: 4 * 8 }, () => [[69, 1], [0, 1]] as const).flat(),
        ],
      },
      {
        // The flattened step comes on the third beat, except under the held
        // notes of bars 2 and 6, where it waits for the last eighth.
        wave: 'tri', vol: 0.15,
        notes: [
          ...eighths(38, 38, 38, 38, 39, 39, 38, 38),
          ...eighths(38, 38, 38, 38, 38, 38, 39, 38),
          ...eighths(38, 38, 38, 38, 39, 39, 38, 38),
          ...eighths(38, 38, 34, 34, 45, 45, 43, 41),
          ...eighths(45, 45, 45, 45, 46, 46, 45, 45),
          ...eighths(45, 45, 45, 45, 45, 45, 46, 45),
          ...eighths(45, 45, 45, 45, 46, 46, 45, 45),
          ...eighths(45, 45, 41, 41, 39, 39, 38, 38),
        ],
      },
      {
        wave: 'noise', vol: 0.07,
        notes: [...DRIVE, ...DRIVE, ...DRIVE, ...FILL, ...DRIVE, ...DRIVE, ...DRIVE, ...FILL],
      },
    ],
  },
  // STAGE CLEAR: a fanfare, once, inside the card's time (CLEAR_FRAMES).
  clear: {
    step: 6,
    loop: false,
    tracks: [
      {
        wave: 'pulse', duty: 0.5, vol: 0.12,
        notes: [
          ...bar([62, 2], [65, 2], [69, 2], [74, 2], [0, 2], [74, 2], [77, 2], [81, 2]),
          ...bar([81, 4], [79, 2], [77, 2], [81, 8]),
          ...bar([0, 16]),
        ],
      },
      {
        wave: 'pulse', duty: 0.25, vol: 0.06,
        notes: [
          ...bar([0, 8], [69, 2], [0, 2], [72, 2], [74, 2]),
          ...bar([77, 4], [74, 2], [74, 2], [77, 8]),
          ...bar([0, 16]),
        ],
      },
      {
        wave: 'tri', vol: 0.14,
        notes: [
          ...bar([38, 4], [41, 4], [45, 4], [50, 4]),
          ...bar([38, 4], [43, 4], [38, 8]),
          ...bar([0, 16]),
        ],
      },
      {
        wave: 'noise', vol: 0.07,
        notes: [...eighths(K, H, S, H, K, H, S, H), ...bar([K, 4], [S, 4], [K, 8]), ...bar([0, 16])],
      },
    ],
  },
};

/** How many sixteenths a tune lasts (its first track's; the tests check they all agree). */
export function tuneSteps(tune: LrTune): number {
  return tune.tracks[0]?.notes.reduce((n, [, steps]) => n + steps, 0) ?? 0;
}

/** Which tune the state calls for, or none. */
export function tuneFor(s: LrState): LrTuneId | null {
  if (s.phase === 'clear') return 'clear';
  const stage = s.boss.stage;
  if (stage === 'enter' || stage === 'fight') return 'boss';
  if (stage === 'dying' || stage === 'done') return null;
  return 'road';
}

/** A note as the sequencer plays it: when it starts, in frames, and for how long. */
interface NoteEvent {
  at: number;
  len: number;
  note: number;
}

interface TrackState {
  track: LrTrack;
  events: NoteEvent[];
  /** Frames the track lasts. */
  length: number;
  /** The event at or before the position. */
  cursor: number;
  osc: Osc;
}

function trackStates(tune: LrTune): TrackState[] {
  return tune.tracks.map((track) => {
    const events: NoteEvent[] = [];
    let at = 0;
    for (const [note, steps] of track.notes) {
      const len = steps * tune.step;
      events.push({ at, len, note });
      at += len;
    }
    return { track, events, length: at, cursor: 0, osc: newOsc() };
  });
}

/** Frames into a note before its vibrato comes in. */
const VIBRATO_FROM = 12;

/** The pitch and level of a track at `pos` frames into its tune, or null for silence. */
function trackVoice(t: TrackState, pos: number): { hz: number; level: number } | null {
  const { events } = t;
  if (events.length === 0 || pos >= t.length) return null;
  if (pos < events[t.cursor]!.at) t.cursor = 0;
  while (t.cursor + 1 < events.length && events[t.cursor + 1]!.at <= pos) t.cursor++;
  const ev = events[t.cursor]!;
  if (ev.note === 0) return null;
  const f = pos - ev.at;
  if (t.track.wave === 'noise') {
    const drum = DRUM[ev.note];
    if (!drum || f >= drum.len) return null;
    const hz = drum.from * Math.pow(drum.to / drum.from, f / drum.len);
    return { hz, level: t.track.vol * drum.gain * (1 - f / drum.len) };
  }
  // The last frame is a gap, so a repeated note is heard twice.
  if (f >= ev.len - 1) return null;
  let hz = midiHz(ev.note);
  if (t.track.wave === 'pulse' && f >= VIBRATO_FROM) {
    hz *= 1 + 0.004 * Math.sin(((f - VIBRATO_FROM) * 2 * Math.PI * 5.5) / LR_SOUND_FPS);
  }
  return { hz, level: t.track.vol * (1 - 0.35 * (f / ev.len)) };
}

// ── The chip ─────────────────────────────────────────────────────────────────

/** Keep the mix inside −1..1: untouched up to the knee, squeezed above it. */
function limit(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.7) return x;
  const over = a - 0.7;
  return Math.min(1, 0.7 + over / (1 + over * 3)) * Math.sign(x);
}

/** A voice this frame: its wave, pitch and level on each side. */
interface Voice {
  osc: Osc;
  wave: Wave;
  duty: number;
  hz: number;
  left: number;
  right: number;
}

export function createLanternRoadSound(sampleRate: number, opts: LrSoundOptions = {}): LrSoundChip {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const music = opts.music ?? true;
  const perFrame = rate / LR_SOUND_FPS;
  /** Samples owed: a rate that doesn't divide by 60 (22050) renders 367 or 368 a frame and keeps time over a second. */
  let owed = 0;

  const channels: FxChannel[] = Array.from({ length: FX_CHANNELS }, () => ({
    stages: null, stage: 0, f: 0, age: 0, left: 0, right: 0, osc: newOsc(),
  }));
  let tune: LrTuneId | null = null;
  let tracks: TrackState[] = [];
  let pos = 0;
  const voices: Voice[] = [];

  const strike = (c: LrCue, cam: number): void => {
    const fx = LR_FX[c.kind];
    if (!fx || fx.length === 0) return;
    // Across the two tubes: constant power, scaled so the middle of the
    // picture is the table's level and a side is 3 dB over it.
    const pan = Math.max(-1, Math.min(1, ((c.x - cam) / LR_VIEW_W) * 2 - 1));
    const angle = ((pan + 1) * Math.PI) / 4;
    const left = Math.cos(angle) * Math.SQRT2;
    const right = Math.sin(angle) * Math.SQRT2;
    for (const layer of fx) {
      let ch = channels.find((k) => k.stages === null);
      if (!ch) {
        // All busy: the one nearest its end gives way, never one struck this
        // frame (then the layer is dropped instead).
        let nearest: FxChannel | null = null;
        for (const k of channels) if (k.age > 0 && (!nearest || framesLeft(k) < framesLeft(nearest))) nearest = k;
        if (!nearest) continue;
        ch = nearest;
      }
      ch.stages = layer;
      ch.stage = 0;
      ch.f = 0;
      ch.age = 0;
      ch.left = left;
      ch.right = right;
      resetOsc(ch.osc);
    }
  };

  return {
    frame(s, cues, push): void {
      // The music: which tune, and where in it.
      const want = music ? tuneFor(s) : null;
      if (want !== tune) {
        tune = want;
        tracks = want ? trackStates(LR_TUNES[want]) : [];
        // Where to come in: the road's theme keeps the game's clock and the
        // fanfare the card's (CLEAR_FRAMES down to 0), so a page that first
        // sees the card late never has it cut off; the Great Lantern's
        // starts as it comes down.
        const length = tracks[0]?.length ?? 0;
        pos = want === 'road' && length > 0 ? s.frame % length : want === 'clear' ? Math.max(0, CLEAR_FRAMES - s.phaseT) : 0;
      }
      // The effects: one of each kind a frame, the first of them.
      const seen = new Set<LrCueKind>();
      for (const c of cues) {
        if (seen.has(c.kind)) continue;
        seen.add(c.kind);
        strike(c, s.cam);
      }

      // This frame's voices.
      voices.length = 0;
      for (const t of tracks) {
        const v = trackVoice(t, pos);
        if (v) voices.push({ osc: t.osc, wave: t.track.wave, duty: t.track.duty ?? 0.5, hz: v.hz, left: v.level, right: v.level });
      }
      for (const ch of channels) {
        if (!ch.stages) continue;
        const st = ch.stages[ch.stage]!;
        const level = stageLevel(st, ch.f);
        voices.push({ osc: ch.osc, wave: st.wave, duty: st.duty, hz: stageHz(st, ch.f), left: level * ch.left, right: level * ch.right });
      }

      // The samples.
      owed += perFrame;
      const n = Math.floor(owed);
      owed -= n;
      for (let i = 0; i < n; i++) {
        let left = 0;
        let right = 0;
        for (const v of voices) {
          const x = osc(v.osc, v.wave, v.duty, v.hz, rate);
          left += x * v.left;
          right += x * v.right;
        }
        push(limit(left), limit(right));
      }

      // On to the next frame.
      if (tune) {
        const length = tracks[0]?.length ?? 0;
        pos++;
        if (LR_TUNES[tune].loop && length > 0 && pos >= length) pos -= length;
      }
      for (const ch of channels) {
        if (!ch.stages) continue;
        ch.age++;
        if (++ch.f >= ch.stages[ch.stage]!.len) {
          ch.f = 0;
          if (++ch.stage >= ch.stages.length) ch.stages = null;
        }
      }
    },
  };
}

/** Frames the STAGE CLEAR jingle lasts: it must finish inside the card (CLEAR_FRAMES), which the tests check. */
export const LR_CLEAR_JINGLE_FRAMES = tuneSteps(LR_TUNES.clear) * LR_TUNES.clear.step;
