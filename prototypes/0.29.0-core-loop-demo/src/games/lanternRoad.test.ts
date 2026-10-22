import { describe, expect, it } from 'vitest';
import {
  CLEAR_FRAMES, LR_COLS, LR_GATE_COL, LR_LEVEL_W, LR_MAP, LR_PLAYER_H, LR_PLAYER_W, LR_ROWS, LR_TILE, LR_VIEW_W, MAX_HP,
  PAD_A, PAD_B, PAD_DOWN, PAD_LEFT, PAD_PRESENT, PAD_RIGHT, SUB, checkLanternRoad, createLanternRoad, isLedge, isSolid,
  isUp, restoreLanternRoad, safeSpot, staffBox, stepLanternRoad, type LrState,
} from './lanternRoad';

const run = (s: LrState, frames: number, pads: (f: number) => readonly number[]) => {
  for (let f = 0; f < frames; f++) stepLanternRoad(s, pads(f));
};
const only = (pad: number) => [PAD_PRESENT | pad, 0, 0, 0];
const px = (sub: number) => sub / SUB;

/** A road with no enemies in it, to test moving about. */
const quiet = (seed = 1): LrState => {
  const s = createLanternRoad(seed);
  s.enemies = [];
  return s;
};

describe('the road', () => {
  it('is twelve even rows with the gate near the end', () => {
    expect(LR_MAP).toHaveLength(LR_ROWS);
    for (const row of LR_MAP) expect(row).toHaveLength(LR_COLS);
    expect(LR_COLS).toBe(192);
    expect(LR_GATE_COL).toBeGreaterThan(LR_COLS - 16);
    // Ground under the start and under the gate.
    expect(isSolid(2, LR_ROWS - 2)).toBe(true);
    expect(isSolid(LR_GATE_COL, LR_ROWS - 2)).toBe(true);
    expect(isLedge(10, 8)).toBe(true);
    // Off either end is a wall.
    expect(isSolid(-1, 5)).toBe(true);
    expect(isSolid(LR_COLS, 5)).toBe(true);
  });

  it('finds somewhere to stand, even over the river', () => {
    for (const x of [0, 40, 1100, 1700, 3000]) {
      const spot = safeSpot(x);
      const col = Math.floor((spot.x + LR_PLAYER_W / 2) / (LR_TILE * SUB));
      const row = (spot.y + LR_PLAYER_H) / (LR_TILE * SUB);
      expect(isSolid(col, row) || isLedge(col, row)).toBe(true);
      expect(isSolid(col, row - 1)).toBe(false);
    }
  });
});

describe('players', () => {
  it('join when their seat is held and leave a moment after it empties', () => {
    const s = quiet();
    run(s, 2, () => [PAD_PRESENT, 0, PAD_PRESENT, 0]);
    expect(s.players.map((p) => p.on)).toEqual([true, false, true, false]);
    run(s, 10, () => [PAD_PRESENT, 0, 0, 0]);
    expect(s.players[2]!.on).toBe(true); // a dropped frame or two is not leaving
    run(s, 30, () => [PAD_PRESENT, 0, 0, 0]);
    expect(s.players[2]!.on).toBe(false);
  });

  it('land on the street and walk both ways', () => {
    const s = quiet();
    run(s, 60, () => only(0));
    const p = s.players[0]!;
    expect(p.ground).toBe(true);
    expect((p.y + LR_PLAYER_H) % (LR_TILE * SUB)).toBe(0);
    const x0 = p.x;
    run(s, 60, () => only(PAD_RIGHT));
    expect(px(p.x - x0)).toBeGreaterThan(70);
    expect(p.face).toBe(1);
    run(s, 30, () => only(PAD_LEFT));
    expect(p.face).toBe(-1);
  });

  it('jump about three and a half tiles, lower if A is let go early', () => {
    const high = quiet();
    run(high, 60, () => only(0));
    const ground = high.players[0]!.y;
    let top = ground;
    run(high, 60, () => {
      top = Math.min(top, high.players[0]!.y);
      return only(PAD_A);
    });
    expect(px(ground - top)).toBeGreaterThan(50);
    expect(px(ground - top)).toBeLessThan(60);

    const low = quiet();
    run(low, 60, () => only(0));
    let lowTop = ground;
    run(low, 60, (f) => {
      lowTop = Math.min(lowTop, low.players[0]!.y);
      return only(f < 4 ? PAD_A : 0);
    });
    expect(px(ground - lowTop)).toBeLessThan(25);
  });

  it('stand on a bridge and drop through it with down and A', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    // Over the first bridge (row 8, columns 10–15), falling.
    p.x = 12 * LR_TILE * SUB;
    p.y = 4 * LR_TILE * SUB;
    run(s, 60, () => only(0));
    expect(p.ground).toBe(true);
    expect((p.y + LR_PLAYER_H) / (LR_TILE * SUB)).toBe(8);
    run(s, 2, () => only(PAD_DOWN | PAD_A));
    run(s, 40, () => only(0));
    expect((p.y + LR_PLAYER_H) / (LR_TILE * SUB)).toBe(10);
  });

  it('lose a heart in the river and come back on solid ground', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    s.cam = 1100;
    p.x = (1100 + 200) * SUB;
    p.y = 10 * LR_TILE * SUB;
    run(s, 40, () => only(0));
    expect(p.hp).toBe(MAX_HP - 1);
    expect(p.ground).toBe(true);
  });

  it('stay inside the picture: its edges are walls', () => {
    const s = quiet();
    run(s, 420, () => [PAD_PRESENT | PAD_RIGHT, PAD_PRESENT | PAD_LEFT, PAD_PRESENT, PAD_PRESENT]);
    for (const p of s.players) {
      expect(px(p.x)).toBeGreaterThanOrEqual(s.cam);
      expect(px(p.x + LR_PLAYER_W)).toBeLessThanOrEqual(s.cam + LR_VIEW_W);
    }
    // The leader is held at the right edge, the straggler at the left.
    expect(px(s.players[0]!.x + LR_PLAYER_W)).toBeGreaterThan(s.cam + LR_VIEW_W - 10);
  });

  it('pull the camera along when they all go right', () => {
    const s = quiet();
    // Up to the first barrels, the bots' business to jump.
    run(s, 400, () => [PAD_PRESENT | PAD_RIGHT, PAD_PRESENT | PAD_RIGHT, 0, 0]);
    expect(s.cam).toBeGreaterThan(250);
  });
});

describe('enemies', () => {
  it('go down to two swings of the staff (an oni) and score', () => {
    const s = createLanternRoad(5);
    s.enemies = s.enemies.filter((e) => e.kind === 'oni').slice(0, 1);
    const oni = s.enemies[0]!;
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    // Stand just left of it, facing it.
    p.x = oni.x - 18 * SUB;
    p.y = oni.y + 16 * SUB - LR_PLAYER_H;
    s.cam = Math.max(0, Math.min(LR_LEVEL_W - LR_VIEW_W, Math.floor(px(p.x)) - 200));
    p.hurt = 999;
    let swings = 0;
    run(s, 120, (f) => {
      if (f % 30 === 0) swings++;
      return only(f % 30 === 0 ? PAD_B : 0);
    });
    expect(oni.dying > 0 || oni.gone).toBe(true);
    expect(p.score).toBeGreaterThanOrEqual(100);
    expect(swings).toBeGreaterThanOrEqual(2);
  });

  it('hurt a player who walks into one, then knock them out after three', () => {
    const s = createLanternRoad(5);
    s.enemies = s.enemies.filter((e) => e.kind === 'oni').slice(0, 1);
    const oni = s.enemies[0]!;
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    s.cam = Math.max(0, Math.floor(px(oni.x)) - 200);
    for (let hit = 1; hit <= 3; hit++) {
      p.hurt = 0;
      p.ko = 0;
      p.x = oni.x;
      p.y = oni.y;
      oni.stun = 0;
      run(s, 1, () => only(0));
      expect(p.hp).toBe(MAX_HP - hit);
    }
    expect(p.ko).toBeGreaterThan(0);
    expect(isUp(p)).toBe(false);
    run(s, 200, () => only(0));
    expect(isUp(p)).toBe(true);
    expect(p.hp).toBe(MAX_HP);
  });

  it('only swing in the middle of the swing', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    run(s, 1, () => only(PAD_B));
    expect(staffBox(p)).toBeNull();
    run(s, 5, () => only(0));
    expect(staffBox(p)).not.toBeNull();
  });
});

describe('the gate', () => {
  it('clears the road, holds the card, then starts a new lap with scores kept', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    s.cam = LR_LEVEL_W - LR_VIEW_W;
    p.x = (LR_GATE_COL - 1) * LR_TILE * SUB;
    p.y = 7 * LR_TILE * SUB;
    run(s, 60, () => only(PAD_RIGHT));
    expect(s.phase).toBe('clear');
    const score = p.score;
    expect(score).toBeGreaterThanOrEqual(1000);
    run(s, CLEAR_FRAMES, () => only(0));
    expect(s.phase).toBe('play');
    expect(s.laps).toBe(1);
    expect(s.cam).toBe(0);
    expect(p.score).toBe(score);
  });
});

/** A simple player: run right, jump at walls and gaps, swing often. */
function bot(s: LrState, seat: number, f: number): number {
  const p = s.players[seat]!;
  let pad = PAD_PRESENT | PAD_RIGHT;
  if (f % 20 === seat * 5) pad |= PAD_B;
  if (!isUp(p)) return pad;
  const col = Math.floor((p.x + LR_PLAYER_W) / (LR_TILE * SUB));
  const feetRow = Math.floor((p.y + LR_PLAYER_H) / (LR_TILE * SUB));
  const wall = isSolid(col + 1, feetRow - 1) || isSolid(col + 1, feetRow - 2);
  const gap = !isSolid(col + 1, feetRow) && !isLedge(col + 1, feetRow) && !isSolid(col + 2, feetRow + 1);
  // Hold A through the jump; let go to land and press again.
  if (p.ground && (wall || gap) && !(p.pad & PAD_A)) pad |= PAD_A;
  else if (!p.ground && p.vy < 0) pad |= PAD_A;
  return pad;
}

describe('a whole game', () => {
  it('four bots reach the shrine gate', () => {
    const s = createLanternRoad(42);
    let f = 0;
    while (s.phase === 'play' && f < 60 * 60 * 3) {
      const frame = f;
      stepLanternRoad(s, [0, 1, 2, 3].map((seat) => bot(s, seat, frame)));
      f++;
    }
    expect(s.phase).toBe('clear');
  });

  it('is the same game from the same pads, and a save state carries on exactly', () => {
    const pads = (s: LrState, f: number) => [0, 1, 2, 3].map((seat) => (f > seat * 90 ? bot(s, seat, f) : 0));
    const a = createLanternRoad(7);
    const b = createLanternRoad(7);
    for (let f = 0; f < 1500; f++) {
      stepLanternRoad(a, pads(a, f));
      stepLanternRoad(b, pads(b, f));
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Save, carry the state over as JSON, and keep going on both.
    const c = restoreLanternRoad(JSON.parse(JSON.stringify(a)))!;
    expect(c).not.toBeNull();
    for (let f = 1500; f < 3000; f++) {
      stepLanternRoad(a, pads(a, f));
      stepLanternRoad(c, pads(c, f));
      if (f % 32 === 0) expect(checkLanternRoad(c)).toBe(checkLanternRoad(a));
    }
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('a different seed is a different game (the umbrellas hop differently)', () => {
    const a = createLanternRoad(1);
    const b = createLanternRoad(2);
    expect(a.rng).not.toBe(b.rng);
  });
});

describe('save states from a peer', () => {
  it('refuses anything that is not a state', () => {
    const good = createLanternRoad(3);
    run(good, 30, () => only(PAD_RIGHT));
    expect(restoreLanternRoad(JSON.parse(JSON.stringify(good)))).not.toBeNull();
    const bad = (patch: (s: Record<string, unknown>) => void) => {
      const s = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      patch(s);
      return restoreLanternRoad(s);
    };
    expect(restoreLanternRoad(null)).toBeNull();
    expect(restoreLanternRoad('state')).toBeNull();
    expect(bad((s) => { s.v = 2; })).toBeNull();
    expect(bad((s) => { s.players = []; })).toBeNull();
    expect(bad((s) => { (s.players as Array<Record<string, unknown>>)[0]!.x = 1.5; })).toBeNull();
    expect(bad((s) => { (s.players as Array<Record<string, unknown>>)[0]!.hp = 99; })).toBeNull();
    expect(bad((s) => { (s.enemies as unknown[]).push({ kind: 'dragon' }); })).toBeNull();
    expect(bad((s) => { s.items = new Array(1000).fill((s.items as unknown[])[0]); })).toBeNull();
    expect(bad((s) => { s.cam = -5; })).toBeNull();
    expect(bad((s) => { s.phase = 'boss'; })).toBeNull();
  });
});
