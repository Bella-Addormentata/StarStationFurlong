/**
 * 🎲🎡 Whose chips are whose on the felt: at craps the crew sets the number
 * boxes and the centre by where each player stands (the same spot in every
 * box), with come odds riding on the come bet; at roulette everyone plays
 * chips of their own stand's colour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.stubGlobal('window', { location: { search: '' }, addEventListener: () => undefined, removeEventListener: () => undefined });

const {
  bindCasinoDoc, writeCrapsTableState, writeMyBets, writeMyCrapsBets, writeMySeat, writeTableState,
} = await import('./casinoDoc');
const { casinoTablesFrame } = await import('./casinoTableSession');
const { FURNITURE, FURNITURE_DEFS } = await import('./furniture');
const { crapsChipRect, rouletteChipColor, ROULETTE_CHIP_COLORS } = await import('./games/casinoLayout');
type CasinoTableVisualHandle = import('./casinoTable3d').CasinoTableVisualHandle;
type FeltStack = import('./casinoTable3d').FeltStack;

/** A table handle that only remembers the felt chips it was last given. */
function fakeTable(game: 'craps' | 'roulette'): { h: CasinoTableVisualHandle; chips: () => readonly FeltStack[] } {
  let last: readonly FeltStack[] = [];
  const h = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_t, key) => {
      if (key === 'game') return game;
      if (key === 'diceState') return () => 'rest';
      if (key === 'wheelSpinning') return () => false;
      if (key === 'setFeltChips') return (s: readonly FeltStack[]) => { last = s; };
      return () => undefined;
    },
  }) as unknown as CasinoTableVisualHandle;
  return { h, chips: () => last };
}

function addTable(id: string, kind: 'craps-table' | 'roulette-table'): void {
  if (!FURNITURE.some((i) => i.id === id)) FURNITURE.push({ id, kind, pos: { x: 0, z: 0 }, rot: 0, movable: true });
}

const seat = (stand: number) => ({ stand, angle: 0, at: Date.now() });

describe('craps chips by position', () => {
  const TABLE = 'craps-chip-spot-test';
  const stands = FURNITURE_DEFS['craps-table'].stands!;
  // Two players on the +x end: the near rail corner and the end.
  const NEAR = stands.findIndex((s) => s.stand.x > 0.5 && s.stand.z < 0);
  const END = stands.findIndex((s) => s.stand.x > 1.5);

  beforeEach(() => {
    bindCasinoDoc(new Y.Doc());
    addTable(TABLE, 'craps-table');
    writeCrapsTableState(TABLE, {
      kind: 'craps', phase: 'betting', round: 3, point: 6, dice: null, result: null, resultAt: 0, payouts: null,
      phaseDeadline: Date.now() + 10_000,
    });
  });

  it('sets each player at their own spot, the same in every box', () => {
    writeMySeat(TABLE, 'player-a', seat(NEAR));
    writeMySeat(TABLE, 'player-b', seat(END));
    writeMyCrapsBets(TABLE, 'player-a', [{ type: 'place', pick: 4, amount: 5 }, { type: 'place', pick: 10, amount: 5 }]);
    writeMyCrapsBets(TABLE, 'player-b', [{ type: 'place', pick: 4, amount: 25 }, { type: 'place', pick: 10, amount: 25 }]);
    const { h, chips } = fakeTable('craps');
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const r4 = crapsChipRect({ type: 'place', pick: 4 }, 1)!;
    const r10 = crapsChipRect({ type: 'place', pick: 10 }, 1)!;
    const of = (denom: number, r: typeof r4) => chips().find((s) => s.chips[0] === denom && s.x >= r.x0 && s.x <= r.x1)!;
    const a4 = of(5, r4), a10 = of(5, r10), b4 = of(25, r4), b10 = of(25, r10);
    expect(Math.hypot(a4.x - b4.x, a4.z - b4.z)).toBeGreaterThan(0.04);
    // Same corner of each box.
    expect(a4.x - r4.x0).toBeCloseTo(a10.x - r10.x0, 9);
    expect(a4.z).toBeCloseTo(a10.z, 9);
    expect(b4.x - r4.x0).toBeCloseTo(b10.x - r10.x0, 9);
    // Near-rail player low in the box, the end player at its outer edge.
    expect(a4.z).toBeLessThan(b4.z);
    expect(b4.x).toBeGreaterThan(a4.x);
  });

  it('keeps two players\' travelled come bets apart, odds riding on top', () => {
    writeMySeat(TABLE, 'player-a', seat(NEAR));
    writeMySeat(TABLE, 'player-b', seat(END));
    writeMyCrapsBets(TABLE, 'player-a', [
      { type: 'come', pick: 8, amount: 5 }, { type: 'come', pick: 8, amount: 5 }, { type: 'comeodds', pick: 8, amount: 25 },
    ]);
    writeMyCrapsBets(TABLE, 'player-b', [{ type: 'come', pick: 8, amount: 1 }]);
    const { h, chips } = fakeTable('craps');
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const flatA = chips().find((s) => s.chips.length === 2 && s.chips[0] === 5)!;
    const odds = chips().find((s) => s.chips[0] === 25)!;
    const flatB = chips().find((s) => s.chips[0] === 1)!;
    expect(Math.hypot(flatA.x - flatB.x, flatA.z - flatB.z)).toBeGreaterThan(0.04);
    expect(odds.lift).toBe(2);
    // Squarely on top: a heel would reach into a neighbour's stack.
    expect(odds.x).toBeCloseTo(flatA.x, 9);
    expect(odds.z).toBeCloseTo(flatA.z, 9);
  });

  it('keeps a bettor who left the table clear of the seated players\' spots', () => {
    writeMySeat(TABLE, 'player-a', seat(NEAR));
    writeMySeat(TABLE, 'player-b', seat(END));
    for (const pid of ['player-a', 'player-b', 'player-gone']) {
      writeMyCrapsBets(TABLE, pid, [{ type: 'place', pick: 6, amount: 5 }, { type: 'anyseven', amount: 5 }]);
    }
    const { h, chips } = fakeTable('craps');
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const all = chips();
    expect(all).toHaveLength(6); // nobody's live bet is hidden
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z)).toBeGreaterThanOrEqual(0.042 - 1e-9);
      }
    }
  });

  it('keeps two players sharing a stand apart, odds and all', () => {
    // With no free stand the table seats a newcomer at a taken one.
    writeMySeat(TABLE, 'player-a', seat(NEAR));
    writeMySeat(TABLE, 'player-b', seat(NEAR));
    for (const [pid, d] of [['player-a', 5], ['player-b', 25]] as const) {
      writeMyCrapsBets(TABLE, pid, [
        { type: 'place', pick: 6, amount: d }, { type: 'come', pick: 8, amount: d }, { type: 'comeodds', pick: 8, amount: d },
      ]);
    }
    const { h, chips } = fakeTable('craps');
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const all = chips();
    expect(all).toHaveLength(6);
    const ground = all.filter((s) => !s.lift);
    for (let i = 0; i < ground.length; i++) {
      for (let j = i + 1; j < ground.length; j++) {
        expect(Math.hypot(ground[i].x - ground[j].x, ground[i].z - ground[j].z)).toBeGreaterThanOrEqual(0.042 - 1e-9);
      }
    }
    // Each player's odds ride on their own come bet.
    for (const d of [5, 25]) {
      const odds = all.filter((s) => s.chips[0] === d && s.lift === 1);
      expect(odds).toHaveLength(1);
      const flat = ground.find((s) => s.chips[0] === d && Math.abs(s.x - odds[0].x) < 1e-9 && Math.abs(s.z - odds[0].z) < 1e-9);
      expect(flat).toBeDefined();
    }
  });

  it('never piles centre bets on each other, in stand order', () => {
    // Every stand bets the 0.17 m-wide yo box.
    stands.forEach((_, i) => {
      writeMySeat(TABLE, `player-${i}`, seat(i));
      writeMyCrapsBets(TABLE, `player-${i}`, [{ type: 'yo', amount: 5 }]);
    });
    const { h, chips } = fakeTable('craps');
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const all = chips();
    expect(all).toHaveLength(stands.length);
    // The box holds six stacks: the first six stands get one each.
    const distinct = new Set(all.map((s) => `${s.x.toFixed(4)},${s.z.toFixed(4)}`));
    expect(distinct.size).toBe(6);
    // Two bettors always come out apart, whichever stands they are at.
    bindCasinoDoc(new Y.Doc());
    writeCrapsTableState(TABLE, {
      kind: 'craps', phase: 'betting', round: 4, point: null, dice: null, result: null, resultAt: 0, payouts: null,
      phaseDeadline: Date.now() + 10_000,
    });
    for (const i of [3, 4]) {
      writeMySeat(TABLE, `player-${i}`, seat(i));
      writeMyCrapsBets(TABLE, `player-${i}`, [{ type: 'yo', amount: 5 }]);
    }
    const two = fakeTable('craps');
    casinoTablesFrame(1 / 60, new Map([[TABLE, two.h]]));
    const [p, q] = two.chips();
    expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThanOrEqual(0.042 - 1e-9);
  });
});

describe('roulette colour chips', () => {
  const TABLE = 'roulette-colour-test';

  beforeEach(() => {
    bindCasinoDoc(new Y.Doc());
    addTable(TABLE, 'roulette-table');
    writeTableState(TABLE, {
      kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null,
    });
  });

  it('draws every player\'s chips in their stand\'s colour', () => {
    writeMySeat(TABLE, 'player-a', seat(2));
    writeMySeat(TABLE, 'player-b', seat(3));
    writeMyBets(TABLE, 'player-a', 1, [{ type: 'straight', pick: 17, amount: 5 }]);
    writeMyBets(TABLE, 'player-b', 1, [{ type: 'straight', pick: 17, amount: 25 }]);
    writeMyBets(TABLE, 'player-gone', 1, [{ type: 'red', amount: 1 }]);
    const { h, chips } = fakeTable('roulette');
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    expect(chips().find((s) => s.chips[0] === 5)!.color).toBe(rouletteChipColor(2));
    expect(chips().find((s) => s.chips[0] === 25)!.color).toBe(rouletteChipColor(3));
    // Bets of someone no longer at the table stay plain value chips.
    expect(chips().find((s) => s.chips[0] === 1)!.color).toBeUndefined();
  });

  it('gives two players at one stand different colours, rail and hand too', () => {
    writeMySeat(TABLE, 'player-a', seat(2));
    writeMySeat(TABLE, 'player-b', seat(2));
    writeMyBets(TABLE, 'player-a', 1, [{ type: 'straight', pick: 17, amount: 5 }]);
    writeMyBets(TABLE, 'player-b', 1, [{ type: 'straight', pick: 17, amount: 25 }]);
    let own: string | null | undefined;
    const base = fakeTable('roulette');
    const h = new Proxy(base.h as unknown as Record<PropertyKey, unknown>, {
      get: (t, key) => (key === 'setOwnChipColor' ? (c: string | null) => { own = c; } : t[key]),
    }) as unknown as CasinoTableVisualHandle;
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const a = base.chips().find((s) => s.chips[0] === 5)!.color;
    const b = base.chips().find((s) => s.chips[0] === 25)!.color;
    expect(a).toBe(rouletteChipColor(2)); // first in player order keeps the stand's colour
    expect(b).not.toBe(a);
    expect(ROULETTE_CHIP_COLORS).toContain(b);
    // This page isn't seated here, so its own rail stays value chips.
    expect(own).toBeNull();
  });
});
