/**
 * The 3D felts (#226): every printed box takes a real bet, nothing overlaps,
 * everything sits on the felt, and the click hit-test finds what's printed.
 */

import { describe, expect, it } from 'vitest';
import { isCrapsBet } from './craps';
import { isRouletteBet } from './roulette';
import {
  assignSlots,
  chipSlots,
  CRAPS_LAYOUT,
  CRAPS_NUMBERS,
  crapsChipRect,
  crapsDealerPlaced,
  crapsNumberBox,
  crapsOddsBaseRect,
  dealerSpot,
  CHIP_RADIUS,
  ROULETTE_CHIP_COLORS,
  rouletteChipColor,
  crapsPuckSpot,
  hitRegion,
  hitSettings,
  nearestInDirection,
  regionCenter,
  inRect,
  rectCentre,
  ROULETTE_LAYOUT,
  ROULETTE_WHEEL,
  rouletteCell,
  spotKey,
  type FeltLayout,
  type FeltRect,
} from './casinoLayout';

const overlaps = (a: FeltRect, b: FeltRect) =>
  a.x0 < b.x1 - 1e-9 && b.x0 < a.x1 - 1e-9 && a.z0 < b.z1 - 1e-9 && b.z0 < a.z1 - 1e-9;

function checkLayout<B>(layout: FeltLayout<B>, valid: (b: B) => boolean): void {
  const ids = new Set<string>();
  for (const rg of layout.regions) {
    expect(ids.has(rg.id), `duplicate id ${rg.id}`).toBe(false);
    ids.add(rg.id);
    expect(valid({ ...rg.bet, amount: 1 }), `${rg.id} takes a real bet`).toBe(true);
    for (const r of [...rg.rects, rg.chipRect]) {
      expect(r.x0 >= layout.felt.x0 - 1e-9 && r.x1 <= layout.felt.x1 + 1e-9, `${rg.id} inside x`).toBe(true);
      expect(r.z0 >= layout.felt.z0 - 1e-9 && r.z1 <= layout.felt.z1 + 1e-9, `${rg.id} inside z`).toBe(true);
    }
    // The centre of every rect hits its own region.
    for (const r of rg.rects) expect(hitRegion(layout, rectCentre(r))?.id).toBe(rg.id);
  }
  const all = layout.regions.flatMap((rg) => rg.rects.map((r) => ({ id: rg.id, r })));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].id === all[j].id) continue;
      expect(overlaps(all[i].r, all[j].r), `${all[i].id} overlaps ${all[j].id}`).toBe(false);
    }
  }
  // The settings button sits on plain felt.
  const b = layout.settings;
  expect(hitRegion(layout, { x: b.x, z: b.z })).toBeNull();
  expect(hitSettings(layout, { x: b.x, z: b.z })).toBe(true);
  expect(hitSettings(layout, { x: b.x + b.r * 1.5, z: b.z })).toBe(false);
}

describe('the craps felt', () => {
  it('is a sound layout', () => {
    checkLayout(CRAPS_LAYOUT, (b) => isCrapsBet(b));
  });

  it('prints every bet on both ends, and the propositions once in the middle', () => {
    const count = (key: string) => CRAPS_LAYOUT.regions.filter((r) => spotKey(r.bet) === key).length;
    for (const k of ['pass:', 'dontpass:', 'come:', 'dontcome:', 'field:', 'big6:', 'big8:', 'passodds:', 'dontpassodds:']) {
      expect(count(k), k).toBe(2);
    }
    for (const n of CRAPS_NUMBERS) {
      for (const t of ['place', 'comeodds', 'dontcomeodds']) expect(count(`${t}:${n}`)).toBe(2);
    }
    for (const k of ['anyseven:', 'anycraps:', 'hard:4', 'hard:6', 'hard:8', 'hard:10', 'two:', 'three:', 'yo:', 'twelve:']) {
      expect(count(k), k).toBe(1);
    }
  });

  it('wraps the pass line around the end of the table', () => {
    expect(hitRegion(CRAPS_LAYOUT, { x: 1.33, z: 0.3 })?.id).toBe('pass@+');
    expect(hitRegion(CRAPS_LAYOUT, { x: -1.33, z: 0.3 })?.id).toBe('pass@-');
    expect(hitRegion(CRAPS_LAYOUT, { x: 0.8, z: -0.36 })?.id).toBe('pass@+');
    // The corner behind the end strip is still the line.
    expect(hitRegion(CRAPS_LAYOUT, { x: 1.33, z: -0.4 })?.id).toBe('pass@+');
  });

  it('prints the odds behind the line, the lay odds by the don\'t pass, and odds bands in every number box', () => {
    for (const side of [-1, 1] as const) {
      const tag = side > 0 ? '+' : '-';
      // Behind the pass line = between it and the −z player rail.
      expect(hitRegion(CRAPS_LAYOUT, { x: 0.8 * side, z: -0.4 })?.id).toBe(`passodds@${tag}`);
      const pass = CRAPS_LAYOUT.regions.find((r) => r.id === `pass@${tag}`)!;
      const odds = CRAPS_LAYOUT.regions.find((r) => r.id === `passodds@${tag}`)!;
      expect(odds.rects[0].z1).toBeLessThanOrEqual(pass.rects[0].z0 + 1e-9);
      // The pass line's caption stays on its long strip.
      expect(inRect(pass.rects[0], regionCenter(pass))).toBe(true);
      expect(CRAPS_LAYOUT.regions.some((r) => r.id === `dontpassodds@${tag}`)).toBe(true);
      for (const n of CRAPS_NUMBERS) {
        const box = crapsNumberBox(n, side);
        const at = (z: number) => hitRegion(CRAPS_LAYOUT, { x: (box.x0 + box.x1) / 2, z })?.id;
        expect(at(box.z0 + 0.02)).toBe(`comeodds:${n}@${tag}`);
        expect(at((box.z0 + box.z1) / 2)).toBe(`place:${n}@${tag}`);
        expect(at(box.z1 - 0.02)).toBe(`dontcomeodds:${n}@${tag}`);
        // Odds chips ride on the come / don't come chips they back.
        for (const t of ['come', 'dontcome'] as const) {
          const flat = crapsChipRect({ type: t, pick: n }, side)!;
          const o = crapsChipRect({ type: t === 'come' ? 'comeodds' : 'dontcomeodds', pick: n }, side)!;
          expect(o).toEqual(flat);
          expect(crapsOddsBaseRect({ type: t === 'come' ? 'comeodds' : 'dontcomeodds', pick: n }, side)).toEqual(flat);
          expect(o.x0 >= box.x0 && o.x1 <= box.x1 + 1e-9 && o.z0 >= box.z0 - 1e-9 && o.z1 <= box.z1 + 1e-9).toBe(true);
        }
      }
    }
    expect(crapsChipRect({ type: 'passodds' }, 1)).toEqual(CRAPS_LAYOUT.regions.find((x) => x.id === 'passodds@+')!.chipRect);
  });

  it('reads 4 to 10 left to right on both ends', () => {
    // Left to right for a player on the −z rail facing +z is +x → −x.
    for (const side of [-1, 1] as const) {
      const xs = CRAPS_NUMBERS.map((n) => crapsNumberBox(n, side).x0);
      expect([...xs].sort((a, b) => b - a)).toEqual(xs);
    }
  });

  it('moves the puck onto the point, and parks it off in the don\'t come bar', () => {
    const on = crapsPuckSpot(8, 1);
    expect(inRect(crapsNumberBox(8, 1), on)).toBe(true);
    const off = crapsPuckSpot(null, -1);
    expect(hitRegion(CRAPS_LAYOUT, off)?.id).toBe('dontcome@-');
  });

  it('puts travelled come bets in their number box', () => {
    const r = crapsChipRect({ type: 'come', pick: 5 }, 1)!;
    const box = crapsNumberBox(5, 1);
    expect(r.x0 >= box.x0 && r.x1 <= box.x1 && r.z0 >= box.z0 && r.z1 <= box.z1).toBe(true);
    expect(crapsChipRect({ type: 'pass' }, -1)).toEqual(CRAPS_LAYOUT.regions.find((x) => x.id === 'pass@-')!.chipRect);
    expect(crapsChipRect({ type: 'anyseven' }, -1)).not.toBeNull();
  });
});

describe('the roulette felt', () => {
  it('is a sound layout', () => {
    checkLayout(ROULETTE_LAYOUT, (b) => isRouletteBet(b));
  });

  it('keeps clear of the wheel', () => {
    for (const rg of ROULETTE_LAYOUT.regions) {
      for (const r of rg.rects) expect(r.x0).toBeGreaterThan(ROULETTE_WHEEL.x + ROULETTE_WHEEL.r);
    }
  });

  it('lays the numbers out the classic way', () => {
    // 1 nearest the player rail, 3 the far side, 34 at the far end.
    expect(rouletteCell(1).z0).toBeLessThan(rouletteCell(3).z0);
    expect(rouletteCell(34).x0).toBeGreaterThan(rouletteCell(1).x0);
    expect(hitRegion(ROULETTE_LAYOUT, rectCentre(rouletteCell(17)))?.bet).toEqual({ type: 'straight', pick: 17 });
  });

  it('has every number, column, dozen and even-money box', () => {
    expect(ROULETTE_LAYOUT.regions.length).toBe(37 + 3 + 3 + 6);
  });
});

describe('chip slots', () => {
  it('always offers at least one stack position', () => {
    expect(chipSlots({ x0: 0, z0: 0, x1: 0.01, z1: 0.01 }).length).toBe(1);
    expect(chipSlots({ x0: 0, z0: 0, x1: 0.3, z1: 0.06 }).length).toBeGreaterThan(3);
  });

  it('sets each player\'s chips nearest where they stand', () => {
    const slots = chipSlots({ x0: -0.5, z0: 0, x1: 0.5, z1: 0.05 });
    const got = assignSlots(slots, [
      { pid: 'left', anchor: { x: -0.6, z: -1 } },
      { pid: 'right', anchor: { x: 0.6, z: -1 } },
    ]);
    expect(got.get('left')!.x).toBeLessThan(0);
    expect(got.get('right')!.x).toBeGreaterThan(0);
    expect(got.get('left')).not.toEqual(got.get('right'));
  });

  it('shares slots once there are more players than room', () => {
    const got = assignSlots([{ x: 0, z: 0 }], [
      { pid: 'a', anchor: null },
      { pid: 'b', anchor: null },
    ]);
    expect(got.size).toBe(2);
  });
});

describe('dealer positions', () => {
  // The craps stands (furniture.ts crapsStands), stickman first.
  const stands = [
    { x: 0, z: 1.5 }, { x: -0.9, z: 1.5 }, { x: 0.9, z: 1.5 },
    { x: -0.9, z: -1.5 }, { x: 0, z: -1.5 }, { x: 0.9, z: -1.5 },
    { x: -2, z: 0 }, { x: 2, z: 0 },
  ];
  const sideOf = (p: { x: number }) => (p.x < 0 ? -1 : 1) as -1 | 1;

  it('sets the number boxes and the centre by position, line bets by the player', () => {
    expect(crapsDealerPlaced({ type: 'place', pick: 6 })).toBe(true);
    expect(crapsDealerPlaced({ type: 'come', pick: 6 })).toBe(true);
    expect(crapsDealerPlaced({ type: 'dontcome', pick: 4 })).toBe(true);
    expect(crapsDealerPlaced({ type: 'comeodds', pick: 6 })).toBe(true);
    expect(crapsDealerPlaced({ type: 'hard', pick: 8 })).toBe(true);
    expect(crapsDealerPlaced({ type: 'yo' })).toBe(true);
    for (const type of ['pass', 'passodds', 'dontpass', 'field', 'big6', 'come', 'dontcome'] as const) {
      expect(crapsDealerPlaced({ type }), type).toBe(false);
    }
  });

  it('gives every player a stack spot of their own inside each box', () => {
    const boxes: Array<{ r: FeltRect; side: -1 | 0 | 1 }> = [];
    for (const side of [-1, 1] as const) {
      for (const n of CRAPS_NUMBERS) {
        for (const type of ['place', 'come', 'dontcome'] as const) {
          boxes.push({ r: crapsChipRect({ type, pick: n }, side)!, side });
        }
      }
    }
    for (const rg of CRAPS_LAYOUT.regions) if (rg.side === 0) boxes.push({ r: rg.chipRect, side: 0 });
    for (const { r, side } of boxes) {
      const here = stands.filter((p) => side === 0 || sideOf(p) === side);
      const spots = here.map((p) => dealerSpot(r, p, side));
      for (const q of spots) {
        expect(q.x - CHIP_RADIUS).toBeGreaterThanOrEqual(r.x0 - 1e-9);
        expect(q.x + CHIP_RADIUS).toBeLessThanOrEqual(r.x1 + 1e-9);
        expect(q.z - CHIP_RADIUS).toBeGreaterThanOrEqual(r.z0 - 1e-9);
        expect(q.z + CHIP_RADIUS).toBeLessThanOrEqual(r.z1 + 1e-9);
      }
      // On the number boxes the stacks of one end never pile on each other.
      if (side !== 0) {
        for (let i = 0; i < spots.length; i++) {
          for (let j = i + 1; j < spots.length; j++) {
            const d = Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z);
            expect(d).toBeGreaterThan(CHIP_RADIUS * 2 - 0.001);
          }
        }
      }
    }
  });

  it('is the table in miniature: near rail low, far rail high, the end at the outer edge', () => {
    for (const side of [-1, 1] as const) {
      const r = crapsChipRect({ type: 'place', pick: 6 }, side)!;
      const near = dealerSpot(r, { x: 0.9 * side, z: -1.5 }, side);
      const far = dealerSpot(r, { x: 0.9 * side, z: 1.5 }, side);
      const end = dealerSpot(r, { x: 2 * side, z: 0 }, side);
      expect(near.z).toBeLessThan(far.z);
      expect(Math.abs(end.x)).toBeGreaterThan(Math.abs(near.x));
      expect(near.x).toBeCloseTo(far.x);
    }
    // The same spot in every box: place 4 and place 10 put a player at the
    // same corner of each.
    const at = (n: number) => {
      const r = crapsChipRect({ type: 'place', pick: n }, 1)!;
      const q = dealerSpot(r, { x: 2, z: 0 }, 1);
      return { dx: q.x - r.x0, dz: q.z - r.z0 };
    };
    expect(at(4).dx).toBeCloseTo(at(10).dx, 9);
    expect(at(4).dz).toBeCloseTo(at(10).dz, 9);
  });

  it('rides odds on the bet they back', () => {
    expect(crapsOddsBaseRect({ type: 'comeodds', pick: 5 }, 1)).toEqual(crapsChipRect({ type: 'come', pick: 5 }, 1));
    expect(crapsOddsBaseRect({ type: 'passodds' }, 1)).toBeNull();
  });

  it('gives every roulette stand a colour of its own, none the felt\'s', () => {
    expect(new Set([0, 1, 2, 3, 4, 5].map(rouletteChipColor)).size).toBe(6);
    for (const c of ROULETTE_CHIP_COLORS) expect(['#000000', '#7A1E1E', '#C8102E']).not.toContain(c);
    expect(rouletteChipColor(6)).toBe(rouletteChipColor(0));
  });
});

describe('keyboard play', () => {
  it('anchors every box inside itself, so it hit-tests as that box', () => {
    for (const layout of [CRAPS_LAYOUT, ROULETTE_LAYOUT] as FeltLayout<unknown>[]) {
      for (const rg of layout.regions) expect(hitRegion(layout, regionCenter(rg))?.id).toBe(rg.id);
    }
  });

  it('arrows step to the nearest point that way, preferring straight lines', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.6, y: 0.5 }, { x: 0, y: 1 }, { x: -1, y: 0.1 }];
    expect(nearestInDirection(pts, 0, 1, 0)).toBe(1);
    expect(nearestInDirection(pts, 0, 0, 1)).toBe(3);
    expect(nearestInDirection(pts, 0, -1, 0)).toBe(4);
    expect(nearestInDirection(pts, 0, 0, -1)).toBe(-1);
    expect(nearestInDirection([null, { x: 1, y: 0 }], 0, 1, 0)).toBe(-1);
  });

  it('reaches every box on both felts', () => {
    for (const layout of [CRAPS_LAYOUT, ROULETTE_LAYOUT] as FeltLayout<unknown>[]) {
      const pts = layout.regions.map((rg) => { const c = regionCenter(rg); return { x: -c.x, y: c.z }; });
      const seen = new Set([0]);
      const queue = [0];
      while (queue.length) {
        const i = queue.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = nearestInDirection(pts, i, dx, dy);
          if (j >= 0 && !seen.has(j)) { seen.add(j); queue.push(j); }
        }
      }
      expect(seen.size).toBe(layout.regions.length);
    }
  });
});
