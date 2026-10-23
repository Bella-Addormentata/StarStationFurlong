/**
 * 🏮🔊 Lantern Road's sound chip: it keeps time at any sample rate, stays
 * inside −1..1, strikes an effect for a cue and pans it to its tube, gives
 * up the right channel when all are busy, reads the tune off the state and
 * comes in on the game's clock, and renders the same samples for the same
 * frames.
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
const effectsOnly = (rate = 48000): LrSoundChip => createLanternRoadSound(rate, { music: false });
/** A state on the STAGE CLEAR card, `left` frames of it to go. */
const onCard = (left = CLEAR_FRAMES): LrState => {
  const s = createLanternRoad(1);
  s.phase = 'clear';
  s.phaseT = left;
  return s;
};

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
    const quiet = render(effectsOnly(), s, 10);
    expect(peak(quiet.left)).toBe(0);
    expect(peak(quiet.right)).toBe(0);
    // Every effect struck at once, over the music, and the frames after.
    const all = (Object.keys(LR_FX) as LrCueKind[]).map((kind) => cue(kind));
    const loud = render(createLanternRoadSound(48000), s, 30, all);
    const loudest = Math.max(peak(loud.left), peak(loud.right));
    expect(loudest).toBeGreaterThan(0.3);
    expect(loudest).toBeLessThanOrEqual(1);
  });

  it('strikes an effect for a cue, rings on every frame of it, and is gone the frame after', () => {
    const s = createLanternRoad(1);
    const chip = effectsOnly();
    const len = fxFrames('coin');
    expect(rms(render(chip, s, 1, [cue('coin')]).left)).toBeGreaterThan(0.05);
    for (let f = 1; f < len; f++) expect(peak(render(chip, s, 1).left), `frame ${f}`).toBeGreaterThan(0);
    const after = render(chip, s, 3);
    expect(peak(after.left)).toBe(0);
    expect(peak(after.right)).toBe(0);
  });

  it('is heard over the music', () => {
    const s = createLanternRoad(1);
    const plain = render(createLanternRoadSound(48000), s, 4);
    const struck = render(createLanternRoadSound(48000), s, 4, [cue('hit')]);
    expect(struck.left).not.toEqual(plain.left);
    expect(rms(struck.left)).toBeGreaterThan(rms(plain.left));
  });

  it('pans a cue to the tube it happened on, at the table\'s level in the middle', () => {
    const s = createLanternRoad(1);
    s.cam = 1000;
    const onLeft = render(effectsOnly(), s, 1, [cue('jump', 1000 + 20)]);
    expect(rms(onLeft.left)).toBeGreaterThan(rms(onLeft.right) * 3);
    const onRight = render(effectsOnly(), s, 1, [cue('jump', 1000 + 490)]);
    expect(rms(onRight.right)).toBeGreaterThan(rms(onRight.left) * 3);
    const middle = render(effectsOnly(), s, 1, [cue('jump', 1000 + 256)]);
    expect(rms(middle.left)).toBeCloseTo(rms(middle.right), 6);
    // Off the picture altogether: still a side, never louder than one.
    const far = render(effectsOnly(), s, 1, [cue('jump', 5000)]);
    expect(rms(far.right)).toBeCloseTo(rms(onRight.right), 2);
    expect(peak(far.left)).toBeLessThan(1e-12); // cos(π/2) is not quite 0
    // Constant power: a side is 3 dB over the middle, never more.
    expect(rms(far.right) / rms(middle.right)).toBeCloseTo(Math.SQRT2, 6);
  });

  it('strikes one of each kind a frame: four jumps are one jump', () => {
    const s = createLanternRoad(1);
    const one = render(effectsOnly(), s, 4, [cue('jump', 100)]);
    const four = render(effectsOnly(), s, 4, [cue('jump', 100), cue('jump', 300), cue('jump', 400), cue('jump', 500)]);
    expect(four.left).toEqual(one.left);
    expect(four.right).toEqual(one.right);
  });

  it('gives up the channel nearest its end when all are busy, and never one struck this frame', () => {
    const s = createLanternRoad(1);
    // Eight layers fill the channels; the slam's noise (24 frames) ends soonest.
    const busy = [cue('boss-enter'), cue('boss-down'), cue('boss-slam'), cue('gate')];
    const chipA = effectsOnly();
    const chipB = effectsOnly();
    render(chipA, s, 1, busy);
    render(chipB, s, 1, busy);
    const kept = render(chipA, s, 20);
    const jumped = render(chipB, s, 20, [cue('jump')]);
    expect(jumped.left).not.toEqual(kept.left);
    // Only the slam's noise could have gone, whichever channel it sat on; the
    // longest layers (the rumble, the burn-out) are still there. The channels
    // are summed in another order here, so the last bit may differ.
    const chipC = effectsOnly();
    render(chipC, s, 1, [cue('boss-enter'), cue('boss-down'), cue('gate'), cue('boss-slam')]);
    const slamLast = render(chipC, s, 20, [cue('jump')]);
    const apart = (a: readonly number[], b: readonly number[]): number => a.reduce((m, x, i) => Math.max(m, Math.abs(x - (b[i] ?? NaN))), 0);
    expect(apart(slamLast.left, jumped.left)).toBeLessThan(1e-9);
    // A ninth layer in the frame that filled the channels is dropped, not written over one of them.
    const eight = render(effectsOnly(), s, 4, busy);
    const nine = render(effectsOnly(), s, 4, [...busy, cue('coin')]);
    expect(apart(nine.left, eight.left)).toBe(0);
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
    // The fight carries the tune on from its entrance (30 frames in), not from the top.
    s.boss.stage = 'fight';
    expect(tuneFor(s)).toBe('boss');
    const fought = render(chip, s, 30);
    const entering = createLanternRoad(1);
    entering.boss.stage = 'enter';
    const straight = createLanternRoadSound(48000);
    render(straight, entering, 30);
    expect(fought.left).toEqual(render(straight, entering, 30).left);

    s.boss.stage = 'dying';
    expect(tuneFor(s)).toBeNull();
    expect(peak(render(chip, s, 10).left)).toBe(0);
    s.boss.stage = 'done';
    expect(tuneFor(s)).toBeNull();

    s.phase = 'clear';
    s.phaseT = CLEAR_FRAMES;
    expect(tuneFor(s)).toBe('clear');
    expect(LR_CLEAR_JINGLE_FRAMES).toBeLessThan(CLEAR_FRAMES);
    const jingle = render(chip, s, LR_CLEAR_JINGLE_FRAMES);
    expect(rms(jingle.left)).toBeGreaterThan(0.02);
    // Over before the card is: the rest of the card is quiet.
    expect(peak(render(chip, s, CLEAR_FRAMES - LR_CLEAR_JINGLE_FRAMES).left)).toBe(0);

    // The next lap: the road again, where the game's clock says.
    s.phase = 'play';
    s.boss.stage = 'wait';
    const again = render(createLanternRoadSound(48000), s, 30);
    expect(render(chip, s, 30).left).toEqual(again.left);
  });

  it('comes in on the card\'s clock, so a page that first sees the card late never has the jingle cut off', () => {
    // A speaker that arrives with 200 frames of the card to go: the jingle's
    // last 128 frames, then quiet; one that arrives with 50 to go hears nothing.
    const late = createLanternRoadSound(48000);
    const first = render(late, onCard(200), 1);
    expect(rms(first.left)).toBeGreaterThan(0.02);
    render(late, onCard(199), LR_CLEAR_JINGLE_FRAMES - 160 - 1);
    expect(peak(render(late, onCard(40), 40).left)).toBe(0);
    expect(peak(render(createLanternRoadSound(48000), onCard(50), 50).left)).toBe(0);
    // From the card's first frame it is the whole jingle.
    const whole = render(createLanternRoadSound(48000), onCard(), LR_CLEAR_JINGLE_FRAMES);
    expect(rms(whole.left)).toBeGreaterThan(0.02);
  });

  it('keeps the road\'s theme on the game\'s clock, so every page is on the same bar', () => {
    const length = tuneSteps(LR_TUNES.road) * LR_TUNES.road.step;
    const atFrame = (frame: number): number[] => {
      const s = createLanternRoad(1);
      s.frame = frame;
      return render(createLanternRoadSound(48000), s, 1).left;
    };
    expect(atFrame(100)).not.toEqual(atFrame(0));
    expect(atFrame(length)).toEqual(atFrame(0));
    expect(atFrame(length * 3 + 100)).toEqual(atFrame(100));
  });

  it('loops the road and the Great Lantern, and not the jingle', () => {
    for (const [id, loops] of [['road', true], ['boss', true], ['clear', false]] as const) {
      const s = id === 'clear' ? onCard() : createLanternRoad(1);
      if (id === 'boss') s.boss.stage = 'fight';
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
          if (st.arp) expect(st.arp.length).toBeGreaterThan(0);
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
