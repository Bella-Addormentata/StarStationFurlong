/**
 * 💰 The settle's chip moves at craps (crapsSettleShow.ts): spot by spot,
 * the same money the table pays (resolveCrapsRound), and the moves made of
 * it: losers into the house, stakes that come down and the winnings out of
 * the house onto each winner's rail, nothing for a stack that stays up, and
 * the table's own record overruling the felt as shown.
 */

import { describe, expect, it } from 'vitest';
import type { FeltStack } from './casinoTable3d';
import { chipsOf, crapsBettorSettle, crapsSettleMoves } from './crapsSettleShow';
import type { SettleInput } from './crapsSettleShow';
import { resolveCrapsRound } from './games/craps';
import type { CrapsBet, CrapsBetType } from './games/craps';
import type { FeltPoint } from './games/casinoLayout';

const bet = (type: CrapsBetType, amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const key = (b: { type: string; pick?: number }) => `${b.type}:${b.pick ?? ''}`;

/** A seeded run of numbers in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POINTS = [null, 4, 5, 6, 8, 9, 10];

/** A felt a player could have down with `point` on: every kind of bet, some
 *  more than once, odds within and past their cap. */
function feltFor(r: () => number, point: number | null): CrapsBet[] {
  const n = (k: number) => Math.floor(r() * k);
  const amount = () => [1, 5, 5, 10, 25, 100][n(6)];
  const num = () => [4, 5, 6, 8, 9, 10][n(6)];
  const out: CrapsBet[] = [];
  const kinds: Array<() => CrapsBet> = [
    () => bet('pass', amount()), () => bet('dontpass', amount()), () => bet('come', amount()),
    () => bet('dontcome', amount()), () => bet('come', amount(), num()), () => bet('dontcome', amount(), num()),
    () => bet('place', amount(), num()), () => bet('hard', amount(), [4, 6, 8, 10][n(4)]), () => bet('field', amount()),
    () => bet('big6', amount()), () => bet('big8', amount()), () => bet('anyseven', amount()), () => bet('anycraps', amount()),
    () => bet('two', amount()), () => bet('three', amount()), () => bet('yo', amount()), () => bet('twelve', amount()),
  ];
  for (let i = 0, k = 1 + n(9); i < k; i++) out.push(kinds[n(kinds.length)]());
  // Odds on what's there (some over the cap, some with nothing to back).
  if (point !== null && r() < 0.6) out.push(bet('passodds', amount() * (1 + n(8))));
  if (point !== null && r() < 0.4) out.push(bet('dontpassodds', amount() * (1 + n(8))));
  for (const b of [...out]) {
    if (b.type === 'come' && b.pick !== undefined && r() < 0.5) out.push(bet('comeodds', amount() * (1 + n(6)), b.pick));
    if (b.type === 'dontcome' && b.pick !== undefined && r() < 0.5) out.push(bet('dontcomeodds', amount() * (1 + n(8)), b.pick));
  }
  if (r() < 0.2) out.push(bet('comeodds', 10, num()));
  return out;
}

describe('a bettor’s roll, spot by spot', () => {
  it('pays what the table pays: credited, net and what stays up, over every roll of random felts', () => {
    const r = rng(7);
    for (let trial = 0; trial < 400; trial++) {
      const point = POINTS[trial % POINTS.length];
      const felt = feltFor(r, point);
      for (let d1 = 1; d1 <= 6; d1++) {
        for (let d2 = 1; d2 <= 6; d2++) {
          const want = resolveCrapsRound({ p: felt }, d1, d2, point);
          const got = crapsBettorSettle(felt, d1, d2, point);
          const credited = want.payouts.p ?? 0;
          const stake = felt.reduce((a, b) => a + b.amount, 0);
          const stays = (want.remaining.p ?? []).reduce((a, b) => a + b.amount, 0);
          const ctx = `${JSON.stringify(felt)} @ ${point} rolled ${d1}${d2}`;
          expect(got.credited, ctx).toBe(credited);
          expect(got.net, ctx).toBe(credited + stays - stake);
          // Every chip of a spot comes back, goes to the house, or stays.
          for (const [k, sp] of got.spots) {
            const had = felt.filter((b) => key(b) === k).reduce((a, b) => a + b.amount, 0);
            expect(sp.back + sp.lost, `${ctx} ${k}`).toBeLessThanOrEqual(had);
            expect(sp.won, `${ctx} ${k}`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('a seven-out: the pass line and its odds and the place numbers lose; the don’t pass wins and comes down', () => {
    const s = crapsBettorSettle([bet('pass', 10), bet('passodds', 20), bet('place', 12, 6), bet('dontpass', 5)], 3, 4, 6);
    expect(s.spots.get('pass:')).toEqual({ back: 0, won: 0, lost: 10 });
    expect(s.spots.get('passodds:')).toEqual({ back: 0, won: 0, lost: 20 });
    expect(s.spots.get('place:6')).toEqual({ back: 0, won: 0, lost: 12 });
    expect(s.spots.get('dontpass:')).toEqual({ back: 5, won: 5, lost: 0 });
    expect(s.credited).toBe(10);
    expect(s.net).toBe(5 - 42);
    expect(s.decided).toBe(true);
  });

  it('a place number that comes pays its winnings and stays up; a roll that decides nothing is undecided', () => {
    const s = crapsBettorSettle([bet('place', 6, 6), bet('place', 6, 6)], 2, 4, 8);
    // 7:6 on the whole 12, as the table pays it.
    expect(s.spots.get('place:6')).toEqual({ back: 0, won: 14, lost: 0 });
    expect(crapsBettorSettle([bet('place', 6, 6)], 4, 5, 8).decided).toBe(false);
  });

  it('losing odds past the cap: the chips past it come back, the rest go to the house', () => {
    // 3x on a 4: 30 of the 50 are working.
    const s = crapsBettorSettle([bet('pass', 10), bet('passodds', 50)], 3, 4, 4);
    expect(s.spots.get('passodds:')).toEqual({ back: 20, won: 0, lost: 30 });
  });
});

// ── The moves ────────────────────────────────────────────────────────────────

const HOUSE: FeltPoint = { x: -0.26, z: 0.36 };
const RAILS: Record<string, FeltPoint> = { a: { x: -0.9, z: -0.5 }, b: { x: 0.9, z: -0.5 } };

/** One drawn stack per bettor per spot (as layoutStacks tags them). */
function stacksOf(felt: Record<string, CrapsBet[]>, me: string): FeltStack[] {
  const out: FeltStack[] = [];
  let x = -1;
  for (const [pid, bets] of Object.entries(felt)) {
    const by = new Map<string, number>();
    for (const b of bets) by.set(key(b), (by.get(key(b)) ?? 0) + b.amount);
    for (const [spot, amount] of by) {
      x += 0.1;
      out.push({ x, z: pid === 'a' ? -0.3 : 0.3, chips: chipsOf(amount, 60), dim: pid !== me, pid, spot });
    }
  }
  return out;
}

function input(before: Record<string, CrapsBet[]>, after: Record<string, CrapsBet[]>, dice: [number, number], point: number | null, over: Partial<SettleInput> = {}): SettleInput {
  return {
    before, after, stacks: stacksOf(before, 'a'), dice, pointBefore: point,
    verdict: { agrees: () => true, paidNothing: () => false },
    railOf: (pid) => RAILS[pid] ?? { x: 0, z: -0.5 },
    house: HOUSE, me: 'a', ...over,
  };
}

/** What a roll leaves riding, as the table prunes it. */
const riding = (felt: Record<string, CrapsBet[]>, d1: number, d2: number, point: number | null) => resolveCrapsRound(felt, d1, d2, point).remaining;

describe('the settle’s chip moves', () => {
  it('a natural: the pass line comes down with its winnings out of the house; the don’t pass and the field go to the house', () => {
    const before = { a: [bet('pass', 10)], b: [bet('dontpass', 5), bet('field', 25)] };
    const m = crapsSettleMoves(input(before, riding(before, 3, 4, null), [3, 4], null));
    expect(m.house).toEqual(HOUSE);
    expect(m.lost.map((s) => [s.pid, s.spot, s.chips])).toEqual([['b', 'dontpass:', [5]], ['b', 'field:', [25]]]);
    expect(m.lost.every((s) => s.dim)).toBe(true);
    expect(m.back).toEqual([{ s: expect.objectContaining({ pid: 'a', spot: 'pass:', chips: [5, 5] }), to: RAILS.a, order: 0, mine: true }]);
    expect(m.paid).toEqual([{ chips: [5, 5], to: RAILS.a, order: 0, mine: true, dim: false }]);
  });

  it('a place bet that comes is paid and stays where it is; one that doesn’t, and a come bet that travels, move nothing', () => {
    const before = { a: [bet('place', 12, 6), bet('place', 10, 9), bet('come', 5)], b: [bet('place', 6, 8)] };
    const m = crapsSettleMoves(input(before, riding(before, 3, 3, 4), [3, 3], 4));
    expect(m.lost).toEqual([]);
    expect(m.back).toEqual([]);
    expect(m.paid).toEqual([{ chips: [5, 5, 1, 1, 1, 1], to: RAILS.a, order: 0, mine: true, dim: false }]);
  });

  it('a come bet on its number that comes, with another travelling onto it: the winner still comes down; a don’t come replaced the same way still goes to the house', () => {
    const before = {
      a: [bet('come', 5, 6), bet('come', 5)],
      b: [bet('dontcome', 5, 6), bet('dontcome', 5)],
    };
    const after = riding(before, 2, 4, 8);
    // (The felt after looks the same at 6: the travellers took their places.)
    expect(after).toEqual({ a: [bet('come', 5, 6)], b: [bet('dontcome', 5, 6)] });
    const m = crapsSettleMoves(input(before, after, [2, 4], 8));
    expect(m.back.map((b) => [b.s.pid, b.s.spot, b.s.chips])).toEqual([['a', 'come:6', [5]]]);
    expect(m.paid.map((p) => [p.to, p.chips])).toEqual([[RAILS.a, [5]]]);
    expect(m.lost.map((s) => [s.pid, s.spot, s.chips])).toEqual([['b', 'dontcome:6', [5]]]);
  });

  it('winners are paid one after another in player order, others’ payouts drawn dim', () => {
    const before = { b: [bet('field', 5)], a: [bet('field', 1)] };
    const m = crapsSettleMoves(input(before, riding(before, 1, 1, null), [1, 1], null));
    expect(m.paid.map((p) => [p.to, p.order, p.mine, p.dim, p.chips])).toEqual([
      [RAILS.a, 0, true, false, [1, 1]],
      [RAILS.b, 1, false, true, [5, 5]],
    ]);
  });

  it('losing odds past the cap: the working chips go to the house off the top, the rest back to the rail', () => {
    const before = { a: [bet('pass', 10), bet('passodds', 50)] };
    const stacks: FeltStack[] = [
      { x: 0, z: -0.3, chips: [10], dim: false, pid: 'a', spot: 'pass:' },
      { x: 0, z: -0.3, chips: [25, 25], dim: false, pid: 'a', spot: 'passodds:', lift: 1 },
    ];
    const m = crapsSettleMoves(input(before, riding(before, 3, 4, 4), [3, 4], 4, { stacks }));
    expect(m.back.map((b) => [b.s.chips, b.s.lift])).toEqual([[[5, 5, 5, 5], 1]]);
    expect(m.lost.map((s) => [s.spot, s.chips, s.lift ?? 0])).toEqual([['pass:', [10], 0], ['passodds:', [25, 5], 5]]);
    expect(m.paid).toEqual([]);
  });

  it('a bettor whose record isn’t what the felt as shown makes moves nothing; one it paid nothing loses every chip that left', () => {
    const before = { a: [bet('pass', 10), bet('place', 6, 6)], b: [bet('pass', 5)] };
    // The record wiped both felts (a forfeit): a paid nothing, b's record
    // says something else again.
    const after = {};
    const m = crapsSettleMoves(input(before, after, [5, 6], null, {
      verdict: { agrees: () => false, paidNothing: (pid) => pid === 'a' },
    }));
    expect(m.lost.map((s) => [s.pid, s.spot])).toEqual([['a', 'pass:'], ['a', 'place:6']]);
    expect(m.back).toEqual([]);
    expect(m.paid).toEqual([]);
  });

  it('a payout of any size draws a bounded stack, largest chips first', () => {
    expect(chipsOf(31_000, 20)).toEqual([...Array(31).fill(1000)].slice(0, 20));
    expect(chipsOf(1_641, 20)).toEqual([1000, 500, 100, 25, 5, 5, 5, 1]);
  });
});
