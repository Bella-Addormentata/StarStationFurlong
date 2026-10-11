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
  crapsNumberBox,
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
    for (const k of ['pass:', 'dontpass:', 'come:', 'dontcome:', 'field:', 'big6:', 'big8:']) {
      expect(count(k), k).toBe(2);
    }
    for (const n of CRAPS_NUMBERS) expect(count(`place:${n}`)).toBe(2);
    for (const k of ['anyseven:', 'anycraps:', 'hard:4', 'hard:6', 'hard:8', 'hard:10', 'two:', 'three:', 'yo:', 'twelve:']) {
      expect(count(k), k).toBe(1);
    }
  });

  it('wraps the pass line around the end of the table', () => {
    expect(hitRegion(CRAPS_LAYOUT, { x: 1.33, z: 0.3 })?.id).toBe('pass@+');
    expect(hitRegion(CRAPS_LAYOUT, { x: -1.33, z: 0.3 })?.id).toBe('pass@-');
    expect(hitRegion(CRAPS_LAYOUT, { x: 0.8, z: -0.4 })?.id).toBe('pass@+');
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
