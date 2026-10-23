/**
 * 🏮🔊 Lantern Road's sound chip: it keeps time at any sample rate, stays
 * inside −1..1, strikes an effect for a cue and pans it to its tube, reads
 * the tune off the state, and renders the same samples for the same frames.
 */

import { describe, expect, it } from 'vitest';
import { CLEAR_FRAMES, createLanternRoad, type LrCue, type LrCueKind, type LrState } from './games/lanternRoad';
import {
  LR_CLEAR_JINGLE_FRAMES, LR_FX, LR_TUNES, createLanternRoadSound, tuneFor, tuneSteps, type LrSoundChip,
} from './lanternRoadSound';

/** `frames` frames of `s`, with `cues` on the first: the two channels. */
function render(chip: LrSoundChip, s: LrState, frames: number, cues: readonly LrCue[] = []): { left: number[]; right: number[] } {
  const left: number[] = [];
  const right: number[] = [];
  for (let f = 0; f < frames; f++) {
    chip.frame(s, f === 0 ? cues : [], (l, r) => {
      left.push(l);
      right.push(r);
    });
  }
  return { left, right };
}

const peak = (xs: readonly number[]): number => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rms = (xs: readonly number[]): number => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / Math.max(1, xs.length));
const cue = (kind: LrCueKind, x = 256): LrCue => ({ kind, x });
/** Frames an effect's longest layer lasts. */
const fxFrames = (kind: LrCueKind): number => Math.max(0, ...LR_FX[kind].map((layer) => layer.reduce((n, st) => n + st.len, 0)));

describe('the sound chip', () => {
  it('renders a frame of samples at any rate and keeps time over a second', () => {
    const s = createLanternRoad(1);
    expect(render(createLanternRoadSound(48000), s, 1).left).toHaveLength(800);
    expect(render(createLanternRoadSound(44100), s, 1).left).toHaveLength(735);
    // 22050 doesn't divide by 60: 367 or 368 a frame, 22050 over the second.
    const odd = createLanternRoadSound(22050);
    const sizes = new Set<number>();
    let total = 0;
    for (let f = 0; f < 60; f++) {
      const n = render(odd, s, 1).left.length;
      sizes.add(n);
      total += n;
    }
    expect(total).toBe(22050);
    expect([...sizes].sort()).toEqual([367, 368]);
    // A rate that is not one: the chip runs at 48 kHz rather than not at all.
    expect(render(createLanternRoadSound(NaN), s, 1).left).toHaveLength(800);
  });

  it('is silent with nothing to play, and never leaves −1..1 however much there is', () => {
    const s = createLanternRoad(1);
    const quiet = render(createLanternRoadSound(48000, { music: false }), s, 10);
    expect(peak(quiet.left)).toBe(0);
    expect(peak(quiet.right)).toBe(0);
    // Every effect at once, over the music, four frames running.
    const chip = createLanternRoadSound(48000);
    const all = (Object.keys(LR_FX) as LrCueKind[]).map((kind) => cue(kind));
    let loudest = 0;
    for (let f = 0; f < 4; f++) {
      const out = render(chip, s, 1, all);
      loudest = Math.max(loudest, peak(out.left), peak(out.right));
    }
    expect(loudest).toBeGreaterThan(0.3);
    expect(loudest).toBeLessThanOrEqual(1);
  });

  it('strikes an effect for a cue and lets it die away', () => {
    const s = createLanternRoad(1);
    const chip = createLanternRoadSound(48000, { music: false });
    const first = render(chip, s, 1, [cue('coin')]);
    expect(rms(first.left)).toBeGreaterThan(0.05);
    // Still ringing on its last frame, gone the frame after.
    const len = fxFrames('coin');
    const rest = render(chip, s, len - 2);
    expect(peak(rest.left)).toBeGreaterThan(0);
    const after = render(chip, s, 3);
    expect(peak(after.left.slice(800))).toBe(0);
    expect(peak(after.right.slice(800))).toBe(0);
  });

  it('pans a cue to the tube it happened on', () => {
    const s = createLanternRoad(1);
    s.cam = 1000;
    const onLeft = render(createLanternRoadSound(48000, { music: false }), s, 1, [cue('jump', 1000 + 20)]);
    expect(rms(onLeft.left)).toBeGreaterThan(rms(onLeft.right) * 3);
    const onRight = render(createLanternRoadSound(48000, { music: false }), s, 1, [cue('jump', 1000 + 490)]);
    expect(rms(onRight.right)).toBeGreaterThan(rms(onRight.left) * 3);
    const middle = render(createLanternRoadSound(48000, { music: false }), s, 1, [cue('jump', 1000 + 256)]);
    expect(rms(middle.left)).toBeCloseTo(rms(middle.right), 6);
    // Off the picture altogether: still a side, never louder than one.
    const far = render(createLanternRoadSound(48000, { music: false }), s, 1, [cue('jump', 5000)]);
    expect(rms(far.right)).toBeCloseTo(rms(onRight.right), 2);
  });

  it('strikes one of each kind a frame: four jumps are one jump', () => {
    const s = createLanternRoad(1);
    const one = render(createLanternRoadSound(48000, { music: false }), s, 4, [cue('jump', 100)]);
    const four = render(createLanternRoadSound(48000, { music: false }), s, 4, [cue('jump', 100), cue('jump', 300), cue('jump', 400), cue('jump', 500)]);
    expect(four.left).toEqual(one.left);
    expect(four.right).toEqual(one.right);
  });

  it('plays the road, then the Great Lantern, nothing while it burns out, and the jingle once', () => {
    const s = createLanternRoad(1);
    expect(tuneFor(s)).toBe('road');
    const chip = createLanternRoadSound(48000);
    const road = render(chip, s, 30);
    expect(rms(road.left)).toBeGreaterThan(0.02);
    expect(road.left).toEqual(road.right); // the music sits in the middle

    s.boss.stage = 'enter';
    expect(tuneFor(s)).toBe('boss');
    const boss = render(chip, s, 30);
    expect(rms(boss.left)).toBeGreaterThan(0.02);
    expect(boss.left).not.toEqual(road.left);
    s.boss.stage = 'fight';
    expect(tuneFor(s)).toBe('boss');

    s.boss.stage = 'dying';
    expect(tuneFor(s)).toBeNull();
    expect(peak(render(chip, s, 10).left)).toBe(0);
    s.boss.stage = 'done';
    expect(tuneFor(s)).toBeNull();

    s.phase = 'clear';
    expect(tuneFor(s)).toBe('clear');
    expect(LR_CLEAR_JINGLE_FRAMES).toBeLessThan(CLEAR_FRAMES);
    const jingle = render(chip, s, LR_CLEAR_JINGLE_FRAMES);
    expect(rms(jingle.left)).toBeGreaterThan(0.02);
    // Over before the card is: the rest of the card is quiet.
    expect(peak(render(chip, s, CLEAR_FRAMES - LR_CLEAR_JINGLE_FRAMES).left)).toBe(0);

    // The next lap: the road again, from its start.
    s.phase = 'play';
    s.boss.stage = 'wait';
    const again = render(createLanternRoadSound(48000), s, 30);
    expect(render(chip, s, 30).left).toEqual(again.left);
  });

  it('loops the road and the Great Lantern, and not the jingle', () => {
    for (const [id, loops] of [['road', true], ['boss', true], ['clear', false]] as const) {
      const s = createLanternRoad(1);
      if (id === 'boss') s.boss.stage = 'fight';
      if (id === 'clear') s.phase = 'clear';
      const tune = LR_TUNES[id];
      const length = tuneSteps(tune) * tune.step;
      const chip = createLanternRoadSound(48000);
      render(chip, s, length + 2);
      const after = render(chip, s, 30);
      expect(tune.loop).toBe(loops);
      if (loops) expect(rms(after.left)).toBeGreaterThan(0.02);
      else expect(peak(after.left)).toBe(0);
    }
  });

  it('is written in time: every track of a tune is as long as the others, and every stage is a sound', () => {
    for (const tune of Object.values(LR_TUNES)) {
      const steps = tuneSteps(tune);
      expect(steps % 16).toBe(0); // whole bars
      for (const track of tune.tracks) {
        expect(track.notes.reduce((n, [, len]) => n + len, 0)).toBe(steps);
        for (const [note, len] of track.notes) {
          expect(len).toBeGreaterThan(0);
          if (track.wave === 'noise') expect(note).toBeLessThanOrEqual(3);
          else expect(note === 0 || (note >= 24 && note <= 108)).toBe(true);
        }
        expect(track.vol).toBeGreaterThan(0);
        expect(track.vol).toBeLessThanOrEqual(0.2);
      }
    }
    for (const [kind, fx] of Object.entries(LR_FX)) {
      expect(fx.length, kind).toBeLessThanOrEqual(2);
      for (const layer of fx) {
        expect(layer.length).toBeGreaterThan(0);
        for (const st of layer) {
          expect(st.len).toBeGreaterThan(0);
          expect(st.vol).toBeGreaterThan(0);
          expect(st.vol).toBeLessThanOrEqual(0.35);
          expect(st.from).toBeGreaterThan(0);
          expect(st.to).toBeGreaterThan(0);
          if (st.wave === 'pulse') {
            expect(st.duty).toBeGreaterThan(0);
            expect(st.duty).toBeLessThan(1);
          }
        }
      }
    }
    // Only the jingle marks a clear.
    expect(LR_FX.clear).toEqual([]);
  });

  it('renders the same samples for the same frames', () => {
    const play = (): number[] => {
      const s = createLanternRoad(5);
      const chip = createLanternRoadSound(44100);
      const out: number[] = [];
      for (let f = 0; f < 90; f++) {
        if (f === 40) s.boss.stage = 'fight';
        const cues = f % 7 === 0 ? [cue('swing', f * 5), cue('hit', f * 5 + 20)] : f === 50 ? [cue('boss-slam', 300)] : [];
        chip.frame(s, cues, (l, r) => out.push(l, r));
      }
      return out;
    };
    expect(play()).toEqual(play());
  });
});
