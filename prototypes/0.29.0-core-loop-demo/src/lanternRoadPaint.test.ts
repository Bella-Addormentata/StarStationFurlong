/**
 * 🏮 Lantern Road's painter, the parts that are arithmetic rather than
 * pixels: where the seat tags of players standing together go.
 */
import { describe, expect, it } from 'vitest';
import { LR_PLAYER_W, PAD_PRESENT, SUB, TAG_FRAMES, createLanternRoad, stepLanternRoad } from './games/lanternRoad';
import { tagLifts } from './lanternRoadPaint';

/** Four players just joined, standing where `xs` says (game pixels). */
function standing(xs: readonly number[]) {
  const s = createLanternRoad(1);
  stepLanternRoad(s, [PAD_PRESENT, PAD_PRESENT, PAD_PRESENT, PAD_PRESENT]);
  s.players.forEach((p, seat) => {
    p.x = xs[seat]! * SUB;
    p.y = 100 * SUB;
    p.tag = TAG_FRAMES;
  });
  return s;
}

describe('seat tags', () => {
  it('stay put for players standing apart', () => {
    expect(tagLifts(standing([40, 80, 120, 160]))).toEqual([0, 0, 0, 0]);
  });

  it('stack for players standing in one spot, in seat order', () => {
    const lifts = tagLifts(standing([100, 100, 104, 300]));
    expect(lifts[0]).toBe(0);
    expect(lifts[1]).toBeGreaterThan(0);
    expect(lifts[2]).toBeGreaterThan(lifts[1]!);
    expect(lifts[3]).toBe(0);
  });

  it('stack by where the tags are printed, one that has risen included', () => {
    // A tag rises 4 pixels over its first frames: a player standing a tag's
    // height lower, whose tag has risen, prints it right over a new one.
    const s = standing([100, 100, 300, 400]);
    s.players[1]!.y = 109 * SUB;
    s.players[1]!.tag = TAG_FRAMES - 16;
    expect(tagLifts(s)[1]).toBeGreaterThan(0);
    // And one that hasn't risen yet still clears it.
    s.players[1]!.tag = TAG_FRAMES;
    expect(tagLifts(s)[1]).toBe(0);
  });

  it('only count tags that are showing', () => {
    const s = standing([100, 100 + LR_PLAYER_W / SUB / 2, 100, 100]);
    s.players[0]!.tag = 0;
    s.players[2]!.on = false;
    s.players[3]!.ko = 60;
    expect(tagLifts(s)).toEqual([0, 0, 0, 0]);
  });
});
