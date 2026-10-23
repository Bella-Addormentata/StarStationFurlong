import { describe, expect, it } from 'vitest';
import {
  BOSS_DYING_FRAMES, CLEAR_FRAMES, DYING_FRAMES, FLAME_FRAMES, LR_ARENA_CAM, LR_COLS, LR_GATE_COL, LR_LEVEL_W, LR_MAP,
  LR_PLAYER_H, LR_PLAYER_W, LR_ROWS, LR_TILE, LR_VIEW_W, MAX_HP, PAD_A, PAD_B, PAD_DOWN, PAD_LEFT, PAD_PRESENT,
  PAD_RIGHT, PUFF_FRAMES, SUB, TAG_FRAMES, WAVE_FRAMES, bossBox, checkLanternRoad, createLanternRoad, isLedge, isSolid,
  isUp, restoreLanternRoad, safeSpot, shotBox, staffBox, stepLanternRoad, type LrState,
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
  it('stays shut while its guardian is about', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    p.hurt = 9999;
    s.cam = LR_ARENA_CAM;
    p.x = (LR_GATE_COL - 1) * LR_TILE * SUB;
    p.y = 7 * LR_TILE * SUB;
    run(s, 60, () => only(PAD_RIGHT));
    expect(s.phase).toBe('play');
    expect(s.boss.stage).not.toBe('done');
  });

  it('clears the road, holds the card, then starts a new lap with scores kept', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const p = s.players[0]!;
    s.boss.stage = 'done';
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
    // And the guardian waits at the shrine again.
    expect(s.boss.stage).toBe('wait');
  });
});

/** The road at the shrine with `n` players standing on the street. */
function atShrine(n: number, seed = 3): LrState {
  const s = quiet(seed);
  const pads = [0, 1, 2, 3].map((seat) => (seat < n ? PAD_PRESENT : 0));
  run(s, 2, () => pads);
  s.cam = LR_ARENA_CAM;
  s.players.forEach((p, seat) => {
    if (!p.on) return;
    p.x = (LR_ARENA_CAM + 180 + seat * 40) * SUB;
    p.y = (LR_ROWS - 2) * LR_TILE * SUB - LR_PLAYER_H;
    p.hurt = 0;
  });
  return s;
}

describe('the Great Lantern', () => {
  it('comes down once the group reaches the shrine, holds the picture, and the yokai flee', () => {
    const s = createLanternRoad(5);
    run(s, 2, () => only(0));
    expect(s.boss.stage).toBe('wait');
    const p = s.players[0]!;
    p.hurt = 9999;
    s.cam = LR_ARENA_CAM - 200;
    p.x = (LR_ARENA_CAM + 120) * SUB;
    p.y = 7 * LR_TILE * SUB;
    run(s, 10, () => only(0));
    expect(s.boss.stage).toBe('wait');
    p.x = (LR_ARENA_CAM + 170) * SUB;
    run(s, 1, () => only(0));
    expect(s.boss.stage).toBe('enter');
    expect(s.boss.maxHp).toBe(16 + 4);
    // Every yokai still on the street goes up in smoke, no points for it.
    expect(s.enemies.every((e) => e.gone || e.dying > 0)).toBe(true);
    expect(p.score).toBe(0);
    // The picture slides onto the shrine and stays, however they walk.
    run(s, 130, () => only(PAD_LEFT));
    expect(s.boss.stage).toBe('fight');
    expect(s.cam).toBe(LR_ARENA_CAM);
    expect(px(p.x)).toBeGreaterThanOrEqual(LR_ARENA_CAM);
  });

  it('takes more hits with more players', () => {
    const one = atShrine(1);
    const four = atShrine(4);
    run(one, 2, () => only(0));
    run(four, 2, () => [PAD_PRESENT, PAD_PRESENT, PAD_PRESENT, PAD_PRESENT]);
    expect(four.boss.maxHp - one.boss.maxHp).toBe(12);
  });

  it('spits fire that burns where it lands, and slams down to send waves both ways', () => {
    const s = atShrine(2);
    for (const p of s.players) p.hurt = 99999;
    const seen = new Set<string>();
    let waves = 0;
    let flames = 0;
    run(s, 900, () => {
      seen.add(s.boss.move);
      flames = Math.max(flames, s.shots.filter((sh) => sh.kind === 'flame').length);
      waves = Math.max(waves, s.shots.filter((sh) => sh.kind === 'wave').length);
      return [PAD_PRESENT, PAD_PRESENT, 0, 0];
    });
    for (const move of ['drift', 'spit', 'shake', 'fall', 'dazed', 'rise']) expect(seen.has(move), move).toBe(true);
    expect(flames).toBeGreaterThan(0);
    expect(waves).toBe(2);
  });

  it('hurts a player who stands in a flame', () => {
    const s = atShrine(1);
    const p = s.players[0]!;
    run(s, 2, () => only(0));
    // A flame right where they stand.
    s.shots.push({ kind: 'flame', x: p.x, y: p.y + LR_PLAYER_H - 12 * SUB, vx: 0, vy: 0, t: FLAME_FRAMES });
    run(s, 1, () => only(0));
    expect(p.hp).toBe(MAX_HP - 1);
  });

  const STREET = (LR_ROWS - 2) * LR_TILE * SUB;

  it('spends a fireball on the player it hits, so it never lands as a flame', () => {
    const s = atShrine(1);
    const p = s.players[0]!;
    run(s, 2, () => only(0));
    // Falling onto their head: it hits this frame and would reach the street the next.
    const fire = shotBox('fire');
    s.shots.push({ kind: 'fire', x: p.x, y: STREET - fire.h - 5, vx: 0, vy: 0, t: 0 });
    run(s, 1, () => only(0));
    expect(p.hp).toBe(MAX_HP - 1);
    expect(s.shots).toEqual([expect.objectContaining({ kind: 'fire', t: -1 })]);
    run(s, 1, () => only(0));
    expect(s.shots).toEqual([]);
  });

  /** A wave rolling at a player who stands on the street at the shrine. */
  function waveAt(jump: boolean): LrState {
    const s = atShrine(1);
    const p = s.players[0]!;
    run(s, 2, () => only(0));
    const wave = shotBox('wave');
    s.shots.push({ kind: 'wave', x: p.x - wave.w - 24 * SUB, y: STREET - wave.h, vx: 40, vy: 0, t: WAVE_FRAMES });
    run(s, 50, (f) => only(jump && f < 16 ? PAD_A : 0));
    return s;
  }

  it('knocks down a player who stands in a wave', () => {
    expect(waveAt(false).players[0]!.hp).toBe(MAX_HP - 1);
  });

  it('rolls under a player who jumps it', () => {
    const s = waveAt(true);
    const p = s.players[0]!;
    expect(p.hp).toBe(MAX_HP);
    // It went on past them.
    expect(s.shots.some((sh) => sh.kind === 'wave' && sh.x > p.x + LR_PLAYER_W)).toBe(true);
  });

  it('goes down to staffs while it sits dazed, then burns out and opens the gate', () => {
    const s = atShrine(1);
    const p = s.players[0]!;
    run(s, 2, () => only(0));
    p.hurt = 999999;
    const b = s.boss;
    // Skip ahead to it sitting dazed on the street, right in front of them.
    b.stage = 'fight';
    b.move = 'dazed';
    b.t = 150;
    b.maxHp = 20;
    b.hp = 20;
    b.x = p.x + LR_PLAYER_W + 4 * SUB;
    b.y = (LR_ROWS - 2) * LR_TILE * SUB - bossBox().h;
    const hp = b.hp;
    run(s, 140, (f) => only(f % 24 === 0 ? PAD_B : 0));
    expect(b.hp).toBeLessThan(hp);
    expect(p.score).toBeGreaterThan(0);
    // Finish it off.
    b.hp = 1;
    b.move = 'dazed';
    b.t = 150;
    b.hurt = 0;
    run(s, 30, (f) => only(f % 24 === 0 ? PAD_B : 0));
    expect(b.stage).toBe('dying');
    expect(p.score).toBeGreaterThanOrEqual(3000);
    expect(s.shots).toEqual([]);
    run(s, BOSS_DYING_FRAMES, () => only(0));
    expect(b.stage).toBe('done');
    // Now the gate lets them through.
    p.x = (LR_GATE_COL - 1) * LR_TILE * SUB;
    run(s, 60, () => only(PAD_RIGHT));
    expect(s.phase).toBe('clear');
  });
});

describe('dropping in and out', () => {
  it('a player who steps up mid-road drops in beside the others, from zero, in a puff', () => {
    const s = quiet();
    run(s, 2, () => only(0));
    const lead = s.players[0]!;
    lead.score = 1234;
    s.cam = 1500;
    lead.x = (1500 + 300) * SUB;
    lead.y = 0;
    run(s, 60, () => only(0));
    // Seat 3 was played earlier by someone else, who left a score behind.
    s.players[3]!.score = 999;
    run(s, 1, () => [PAD_PRESENT, 0, 0, PAD_PRESENT]);
    const p = s.players[3]!;
    expect(p.on).toBe(true);
    expect(p.score).toBe(0);
    expect(p.tag).toBeGreaterThan(TAG_FRAMES - 3);
    expect(Math.abs(px(p.x) - px(lead.x))).toBeLessThan(60);
    expect(s.puffs.some((puff) => puff.seat === 3 && puff.t === PUFF_FRAMES)).toBe(true);
    // The tag fades.
    run(s, TAG_FRAMES, () => [PAD_PRESENT, 0, 0, PAD_PRESENT]);
    expect(p.tag).toBe(0);
  });

  it('a player who steps away goes in a puff', () => {
    const s = quiet();
    run(s, 2, () => [PAD_PRESENT, PAD_PRESENT, 0, 0]);
    s.puffs = [];
    run(s, 40, () => [PAD_PRESENT, 0, 0, 0]);
    expect(s.players[1]!.on).toBe(false);
    expect(s.puffs.filter((puff) => puff.seat === 1)).toHaveLength(1);
  });
});

/** A simple player: run right, jump at walls and gaps, swing often. At the
 *  shrine: go to the Great Lantern, face it, swing, and jump its waves. */
function bot(s: LrState, seat: number, f: number): number {
  const p = s.players[seat]!;
  let pad = PAD_PRESENT | PAD_RIGHT;
  if (f % 20 === seat * 5) pad |= PAD_B;
  if (!isUp(p)) return pad;
  const b = s.boss;
  if (b.stage === 'fight') {
    const mid = p.x + LR_PLAYER_W / 2;
    const bossMid = b.x + bossBox().w / 2;
    const gap = bossMid - mid;
    pad = PAD_PRESENT | (f % 16 === seat * 4 ? PAD_B : 0);
    // Close in, but a body's width short, and face it.
    if (Math.abs(gap) > (bossBox().w / 2 + 6 * SUB)) pad |= gap > 0 ? PAD_RIGHT : PAD_LEFT;
    else if (p.face !== (gap > 0 ? 1 : -1)) pad |= gap > 0 ? PAD_RIGHT : PAD_LEFT;
    const wave = s.shots.some((sh) => sh.kind === 'wave' && Math.abs(sh.x - p.x) < 40 * SUB
      && (sh.vx > 0) === (sh.x < p.x));
    if (p.ground && wave && !(p.pad & PAD_A)) pad |= PAD_A;
    else if (!p.ground && p.vy < 0) pad |= PAD_A;
    return pad;
  }
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
  it('four bots reach the shrine, put out the Great Lantern and go through the gate', () => {
    const s = createLanternRoad(42);
    let f = 0;
    while (s.phase === 'play' && f < 60 * 60 * 6) {
      const frame = f;
      stepLanternRoad(s, [0, 1, 2, 3].map((seat) => bot(s, seat, frame)));
      f++;
    }
    expect(s.phase).toBe('clear');
    expect(s.boss.stage).toBe('done');
  });

  it('one bot alone can do it too', () => {
    const s = createLanternRoad(9);
    let f = 0;
    while (s.phase === 'play' && f < 60 * 60 * 8) {
      const frame = f;
      stepLanternRoad(s, [bot(s, 0, frame), 0, 0, 0]);
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
    expect(bad((s) => { s.v = 1; })).toBeNull();
    expect(bad((s) => { s.players = []; })).toBeNull();
    expect(bad((s) => { (s.players as Array<Record<string, unknown>>)[0]!.x = 1.5; })).toBeNull();
    expect(bad((s) => { (s.players as Array<Record<string, unknown>>)[0]!.hp = 99; })).toBeNull();
    expect(bad((s) => { (s.enemies as unknown[]).push({ kind: 'dragon' }); })).toBeNull();
    expect(bad((s) => { s.items = new Array(1000).fill((s.items as unknown[])[0]); })).toBeNull();
    expect(bad((s) => { s.cam = -5; })).toBeNull();
    expect(bad((s) => { s.phase = 'boss'; })).toBeNull();
    // Past the puff of smoke's last frame: the painter would draw a
    // negative radius.
    expect(bad((s) => { (s.enemies as Array<Record<string, unknown>>)[0]!.dying = 255; })).toBeNull();
    expect(bad((s) => { (s.enemies as Array<Record<string, unknown>>)[0]!.dying = DYING_FRAMES; })).not.toBeNull();
    // The guardian, its fire and the puffs are checked too: the painter
    // reads their timers as fractions.
    expect(bad((s) => { (s.boss as Record<string, unknown>).stage = 'asleep'; })).toBeNull();
    expect(bad((s) => { (s.boss as Record<string, unknown>).hp = 50; })).toBeNull();
    expect(bad((s) => { Object.assign(s.boss as object, { stage: 'dying', t: BOSS_DYING_FRAMES + 1 }); })).toBeNull();
    expect(bad((s) => { s.shots = [{ kind: 'flame', x: 0, y: 0, vx: 0, vy: 0, t: FLAME_FRAMES + 1 }]; })).toBeNull();
    expect(bad((s) => { s.shots = [{ kind: 'flame', x: 0, y: 0, vx: 0, vy: 0, t: FLAME_FRAMES }]; })).not.toBeNull();
    expect(bad((s) => { s.puffs = [{ x: 0, y: 0, seat: 0, t: PUFF_FRAMES + 1 }]; })).toBeNull();
    expect(bad((s) => { s.puffs = [{ x: 0, y: 0, seat: 9, t: 1 }]; })).toBeNull();
  });

  it('carries a save taken mid-fight on exactly', () => {
    const pads = (s: LrState, f: number) => [0, 1, 2, 3].map((seat) => (seat < 2 ? bot(s, seat, f) : 0));
    const a = atShrine(2, 11);
    for (let f = 0; f < 700; f++) stepLanternRoad(a, pads(a, f));
    expect(a.boss.stage).toBe('fight');
    const c = restoreLanternRoad(JSON.parse(JSON.stringify(a)))!;
    expect(c).not.toBeNull();
    for (let f = 700; f < 1600; f++) {
      stepLanternRoad(a, pads(a, f));
      stepLanternRoad(c, pads(c, f));
    }
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});
