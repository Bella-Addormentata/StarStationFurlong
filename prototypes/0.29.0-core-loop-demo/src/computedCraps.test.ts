/**
 * 🎲🧮 Computed craps rules (computedCraps.ts): the canonical felt, the
 * stamp, the table-rules check, one roll, the shooter and the dice, with
 * games/craps.ts's own rules underneath, unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  addedOver, basisOf, canonFelt, CARRY_POINTS, changeOk, diceOf, EMPTY_CARRY, feltCanon, feltSum, isCanonFelt, MAX_CRAPS_SPOTS,
  MAX_FELT_STAKE, MAX_RIDERS, minPerSpot, nullProtoCopy, own, playRoll, RING, sameFelt, shooterStep, spotKey,
  standingOf,
} from './computedCraps';
import type { CrapsCarry, RollIn, RollSlip } from './computedCraps';
import { canon } from './computedFold';
import { CRAPS_LAYOUT, spotKey as layoutSpotKey } from './games/casinoLayout';
import { canPlaceBet, canTakeDown, POINT_NUMBERS, resolveCrapsRound } from './games/craps';
import type { CrapsBet, CrapsBetType } from './games/craps';
import { combineSeeds } from './games/diceFairness';
import { diceFromMaterial, diceFromMaterialSync } from './games/fairDice';

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

const POINTS: (number | null)[] = [null, 4, 5, 6, 8, 9, 10];
const NUMS = [4, 5, 6, 8, 9, 10];
const ALL_DICE: [number, number][] = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) ALL_DICE.push([a, b]);

/** Every spot a craps felt has (49). */
const SPOTS: CrapsBet[] = [
  ...(['pass', 'dontpass', 'come', 'dontcome', 'field', 'big6', 'big8', 'anyseven', 'anycraps', 'two', 'three', 'yo',
    'twelve', 'passodds', 'dontpassodds'] as CrapsBetType[]).map((type) => ({ type, amount: 1 })),
  ...NUMS.map((pick) => ({ type: 'place' as const, pick, amount: 1 })),
  ...[4, 6, 8, 10].map((pick) => ({ type: 'hard' as const, pick, amount: 1 })),
  ...NUMS.map((pick) => ({ type: 'comeodds' as const, pick, amount: 1 })),
  ...NUMS.map((pick) => ({ type: 'dontcomeodds' as const, pick, amount: 1 })),
  ...NUMS.map((pick) => ({ type: 'come' as const, pick, amount: 1 })),
  ...NUMS.map((pick) => ({ type: 'dontcome' as const, pick, amount: 1 })),
];
const TYPES = [...new Set(SPOTS.map((s) => s.type))];

const bet = (type: CrapsBetType, amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const felt = (...bets: CrapsBet[]): CrapsBet[] => canonFelt(bets);
const carry = (p: number, w: Record<string, CrapsBet[]>, extra: Partial<CrapsCarry> = {}): CrapsCarry =>
  ({ p, w: nullProtoCopy(w), ...extra });
const slip = (b: CrapsBet[], opts: { t?: number; basisOk?: boolean } = {}): RollSlip =>
  ({ b, basisOk: opts.basisOk ?? true, ...(opts.t !== undefined ? { t: opts.t } : {}) });
const roll = (sIn: CrapsCarry, slips: Record<string, RollSlip>, dice: [number, number] | null, extra: Partial<RollIn> = {}) =>
  playRoll({
    sIn, slips: new Map(Object.entries(slips)), decided: dice ? 'reveals' : null,
    counted: Object.keys(slips), dice, ...extra,
  });

/** A random per-chip list: chips of 1–25 on random spots, several to a spot. */
function randomChips(rand: () => number, max = 12): CrapsBet[] {
  const n = 1 + Math.floor(rand() * max);
  return Array.from({ length: n }, () => {
    const s = SPOTS[Math.floor(rand() * SPOTS.length)];
    return bet(s.type, 1 + Math.floor(rand() * 25), s.pick);
  });
}

describe('the canonical felt', () => {
  it('one entry per spot, summed and sorted, with no stray field', () => {
    const f = felt(bet('place', 6, 6), bet('pass', 10), bet('place', 6, 6), bet('come', 5), bet('come', 5, 8));
    expect(f).toEqual([
      { type: 'come', amount: 5 }, { type: 'come', pick: 8, amount: 5 }, { type: 'pass', amount: 10 },
      { type: 'place', pick: 6, amount: 12 },
    ]);
    expect(isCanonFelt(f)).toBe(true);
    expect(Object.keys(f[0])).toEqual(['type', 'amount']);
  });

  it('refuses a felt out of order, a spot twice, a stray field or pick, a bad amount, or too much', () => {
    expect(isCanonFelt([bet('pass', 1), bet('field', 1)])).toBe(false);
    expect(isCanonFelt([bet('pass', 1), bet('pass', 1)])).toBe(false);
    expect(isCanonFelt([{ type: 'pass', amount: 1, x: 1 }])).toBe(false);
    expect(isCanonFelt([{ type: 'pass', pick: 4, amount: 1 }])).toBe(false);
    expect(isCanonFelt([{ type: 'place', amount: 1 }])).toBe(false);
    expect(isCanonFelt([{ type: 'place', pick: 7, amount: 1 }])).toBe(false);
    expect(isCanonFelt([bet('pass', 0)])).toBe(false);
    expect(isCanonFelt([bet('pass', 1.5)])).toBe(false);
    expect(isCanonFelt([bet('pass', MAX_FELT_STAKE + 1)])).toBe(false);
    expect(isCanonFelt([bet('field', MAX_FELT_STAKE / 2), bet('pass', MAX_FELT_STAKE / 2 + 1)])).toBe(false);
    expect(isCanonFelt('pass')).toBe(false);
    expect(isCanonFelt([null])).toBe(false);
    expect(isCanonFelt([new (class { type = 'pass'; amount = 1; })()])).toBe(false);
  });

  it('a spot may hold more than one record may (merged chips), up to MAX_FELT_STAKE', () => {
    expect(isCanonFelt([bet('pass', 5e9)])).toBe(true);
    expect(isCanonFelt([bet('pass', MAX_FELT_STAKE)])).toBe(true);
  });

  it('every spot of the felt fits, once: MAX_CRAPS_SPOTS', () => {
    const all = canonFelt(SPOTS);
    expect(all).toHaveLength(MAX_CRAPS_SPOTS);
    expect(isCanonFelt(all)).toBe(true);
    expect(isCanonFelt([...all, bet('pass', 1)])).toBe(false);
  });

  it('spot names are the felt\'s own, on every spot the felt draws and every travelled come bet', () => {
    for (const r of CRAPS_LAYOUT.regions) expect(spotKey(r.bet)).toBe(layoutSpotKey(r.bet));
    for (const s of SPOTS) expect(spotKey(s)).toBe(layoutSpotKey(s));
    // The felt's regions plus the twelve travelled come and don't come spots are all 49.
    const drawn = new Set(CRAPS_LAYOUT.regions.map((r) => layoutSpotKey(r.bet)));
    for (const n of NUMS) drawn.add(`come:${n}`).add(`dontcome:${n}`);
    expect(drawn).toEqual(new Set(SPOTS.map(spotKey)));
  });

  it('minPerSpot, addedOver and sameFelt', () => {
    const C = felt(bet('pass', 10), bet('place', 12, 6));
    const B = felt(bet('pass', 10), bet('place', 6, 6), bet('field', 5));
    expect(minPerSpot(B, C)).toEqual(felt(bet('pass', 10), bet('place', 6, 6)));
    expect(addedOver(B, C)).toBe(5);
    expect(feltSum(minPerSpot(B, C)) + addedOver(B, C)).toBe(feltSum(B));
    expect(sameFelt(B, felt(...B))).toBe(true);
    expect(sameFelt(B, C)).toBe(false);
  });
});

describe('the stamp', () => {
  it('spells the felt as canon does', () => {
    const rand = rng(3);
    for (let i = 0; i < 200; i++) {
      const f = canonFelt(randomChips(rand));
      expect(feltCanon(f)).toBe(canon(f));
    }
  });

  it('hashes the point and only the player\'s own riding bets', () => {
    const S = carry(6, { alice: felt(bet('pass', 10)), bob: felt(bet('place', 12, 8)) });
    expect(basisOf(S, 'alice')).toMatch(/^[0-9a-f]{32}$/);
    expect(basisOf(S, 'alice')).toBe(basisOf(carry(6, { alice: felt(bet('pass', 10)) }), 'alice'));
    expect(basisOf(S, 'alice')).not.toBe(basisOf(carry(8, { alice: felt(bet('pass', 10)) }), 'alice'));
    expect(basisOf(S, 'alice')).not.toBe(basisOf(carry(6, { alice: felt(bet('pass', 15)) }), 'alice'));
    // Someone with nothing riding: only the point.
    expect(basisOf(S, 'carol')).toBe(basisOf(carry(6, {}), 'dave'));
    expect(basisOf(S, 'carol')).not.toBe(basisOf(EMPTY_CARRY, 'carol'));
  });

  it('player ids that look like built-in names read no prototype', () => {
    const S = carry(0, {});
    for (const pid of ['constructor', 'toString', 'hasOwnProperty', '__defineGetter__']) {
      expect(own(S.w, pid)).toEqual([]);
      expect(basisOf(S, pid)).toBe(basisOf(EMPTY_CARRY, 'nobody'));
      expect(own(EMPTY_CARRY.w, pid)).toEqual([]);
    }
    const riding = carry(0, { constructor: felt(bet('field', 5)) });
    expect(own(riding.w, 'constructor')).toEqual(felt(bet('field', 5)));
  });
});

describe('the table rules', () => {
  /** What the felt's buttons let a player do in one window, from C. */
  function honestChange(C: CrapsBet[], point: number | null, rand: () => number): CrapsBet[] {
    let list = [...C];
    for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) {
      if (rand() < 0.6) {
        const s = SPOTS[Math.floor(rand() * SPOTS.length)];
        // The felt only places come bets in the box; a travelled one moves on its own.
        if ((s.type === 'come' || s.type === 'dontcome') && s.pick !== undefined) continue;
        if (!canPlaceBet(s.type, point)) continue;
        list.push(bet(s.type, 1 + Math.floor(rand() * 20), s.pick));
      } else {
        const down = canonFelt(list).filter((b) => canTakeDown(b, point));
        if (!down.length) continue;
        const b = down[Math.floor(rand() * down.length)];
        const n = 1 + Math.floor(rand() * b.amount);
        list = canonFelt([...list, bet(b.type, -n, b.pick)]);
      }
    }
    return canonFelt(list);
  }

  it('every honest felt action passes', () => {
    const rand = rng(11);
    for (let i = 0; i < 3000; i++) {
      const point = POINTS[Math.floor(rand() * POINTS.length)];
      // C as a hand could have left it: anything that may stand with this point.
      const C = canonFelt(randomChips(rand).filter((b) => point !== null || (b.type !== 'passodds' && b.type !== 'dontpassodds')));
      const B = honestChange(C, point, rand);
      expect(changeOk(C, B, point), `${JSON.stringify(C)} → ${JSON.stringify(B)} at ${point}`).toBe(true);
    }
  });

  it('every cheat the felt\'s buttons stop today fails it', () => {
    const pass = felt(bet('pass', 10));
    // A pass line taken down on its point, or cut.
    expect(changeOk(pass, [], 6)).toBe(false);
    expect(changeOk(pass, felt(bet('pass', 5)), 6)).toBe(false);
    // A come bet that travelled, taken down or cut.
    const come6 = felt(bet('come', 10, 6));
    expect(changeOk(come6, [], 8)).toBe(false);
    expect(changeOk(come6, felt(bet('come', 4, 6)), 8)).toBe(false);
    // A don't pass placed, or raised, mid-point.
    expect(changeOk([], felt(bet('dontpass', 10)), 4)).toBe(false);
    expect(changeOk(felt(bet('dontpass', 5)), felt(bet('dontpass', 10)), 4)).toBe(false);
    // A forged don't come (or come) on a number.
    expect(changeOk([], felt(bet('dontcome', 10, 4)), 6)).toBe(false);
    expect(changeOk(felt(bet('dontcome', 5, 4)), felt(bet('dontcome', 10, 4)), 6)).toBe(false);
    expect(changeOk([], felt(bet('come', 10, 4)), 6)).toBe(false);
    // A pass line placed while a point is on.
    expect(changeOk([], pass, 6)).toBe(false);
    // Line bets in the wrong phase: line odds on a come-out, the come box on a come-out.
    expect(changeOk(pass, felt(bet('pass', 10), bet('passodds', 10)), null)).toBe(false);
    expect(changeOk([], felt(bet('come', 10)), null)).toBe(false);
    expect(changeOk([], felt(bet('dontcome', 10)), null)).toBe(false);
  });

  it('allows what stays free: the don\'t side down, a travelled don\'t come down, odds and props either way', () => {
    expect(changeOk(felt(bet('dontpass', 10)), [], 6)).toBe(true);
    expect(changeOk(felt(bet('dontcome', 10, 4)), [], 6)).toBe(true);
    expect(changeOk(felt(bet('pass', 10)), felt(bet('pass', 10), bet('passodds', 50)), 6)).toBe(true);
    expect(changeOk(felt(bet('place', 12, 6), bet('hard', 5, 8)), felt(bet('field', 5)), 6)).toBe(true);
    expect(changeOk([], felt(bet('pass', 10), bet('dontpass', 5)), null)).toBe(true);
    expect(changeOk(felt(bet('pass', 10)), [], null)).toBe(true);
  });
});

describe('merged felts pay what per-chip felts pay', () => {
  it('for all 19 bet types, every point and all 36 dice, odds over the cap and odds with nothing behind them', () => {
    const rand = rng(29);
    let cases = 0;
    const seen = new Set<string>();
    const differ: unknown[] = [];
    for (let i = 0; i < 400; i++) {
      const chips = randomChips(rand, 18);
      // Now and then odds far over the cap, or odds with no flat bet at all.
      if (i % 5 === 0) chips.push(bet('passodds', 500), bet('comeodds', 77, NUMS[i % 6]));
      if (i % 7 === 0) chips.push(bet('dontcomeodds', 33, NUMS[(i + 3) % 6]));
      for (const c of chips) seen.add(c.type);
      const merged = canonFelt(chips);
      for (const point of POINTS) {
        for (const [d1, d2] of ALL_DICE) {
          const a = resolveCrapsRound({ bettor: chips }, d1, d2, point);
          const b = resolveCrapsRound({ bettor: merged }, d1, d2, point);
          // (Compared by hand and checked once at the end: 100,800 expects
          // take most of vitest's 5 s.)
          const left = JSON.stringify(canonFelt(a.remaining.bettor));
          const right = JSON.stringify(canonFelt(b.remaining.bettor));
          if ((b.payouts.bettor ?? 0) !== (a.payouts.bettor ?? 0) || right !== left) {
            differ.push({ i, point, dice: [d1, d2], paid: [a.payouts.bettor ?? 0, b.payouts.bettor ?? 0], left, right });
          }
          cases++;
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect([...seen].sort()).toEqual([...TYPES].sort());
    expect(TYPES).toHaveLength(19);
    expect(cases).toBe(400 * 7 * 36);
  });
});

describe('the dice', () => {
  it('the synchronous draw is the async one, on 2,000 inputs', async () => {
    const rand = rng(41);
    for (let i = 0; i < 2000; i++) {
      const base = `probe-${i}-${Math.floor(rand() * 1e9)}`;
      expect(diceFromMaterialSync(base)).toEqual(await diceFromMaterial(base));
    }
  });

  it('diceOf is combineSeeds over the counted seeds, in any order', async () => {
    const seeds = ['a'.repeat(64), 'b'.repeat(64), '0123'.repeat(16)];
    for (let r = 1; r <= 50; r++) {
      expect(diceOf('ct:craps-1:k0', r, seeds)).toEqual(await combineSeeds(seeds, 'ct:craps-1:k0', r));
      expect(diceOf('ct:craps-1:k0', r, [...seeds].reverse())).toEqual(diceOf('ct:craps-1:k0', r, seeds));
    }
  });
});

describe('one roll', () => {
  it('a pass line rides on a point, and its chips stay on the felt', () => {
    const out = roll(EMPTY_CARRY, { alice: slip(felt(bet('pass', 10)), { t: 3 }) }, [2, 4]);
    expect(out.pointAfter).toBe(6);
    expect(out.deltas.get('alice')).toBe(0);
    expect(out.amounts.has('alice')).toBe(false); // nothing decided on it
    expect(own(out.sOut.w, 'alice')).toEqual(felt(bet('pass', 10)));
    expect(out.sOut.p).toBe(6);
  });

  it('the chips table: wins, a seven-out, a push and a late seed', () => {
    // Place 6 hits: +14, the stake stays.
    let out = roll(carry(5, { alice: felt(bet('place', 12, 6)) }), {}, [3, 3]);
    expect(out.amounts.get('alice')).toBe(14);
    expect(out.credited.get('alice')).toBe(14);
    expect(own(out.sOut.w, 'alice')).toEqual(felt(bet('place', 12, 6)));
    // Point made with odds: +22 shown, 42 back.
    out = roll(carry(6, { alice: felt(bet('pass', 10), bet('passodds', 10)) }), {}, [2, 4]);
    expect(out.amounts.get('alice')).toBe(22);
    expect(out.credited.get('alice')).toBe(42);
    expect(out.sOut.w).toEqual(Object.create(null));
    // Seven out: −72, nothing back.
    out = roll(carry(6, { alice: felt(bet('pass', 10), bet('passodds', 50), bet('place', 12, 6)) }), {}, [3, 4]);
    expect(out.amounts.get('alice')).toBe(-72);
    expect(out.sevenOut).toBe(true);
    // Don't pass on a come-out twelve: a push.
    out = roll(EMPTY_CARRY, { alice: slip(felt(bet('dontpass', 10)), { t: 1 }) }, [6, 6]);
    expect(out.amounts.get('alice')).toBe(0);
    expect(out.pushes.has('alice')).toBe(true);
    // A late seed: the new field bet is lost, the riding pass plays.
    out = roll(carry(6, { alice: felt(bet('pass', 10)) }), { alice: slip(felt(bet('pass', 10), bet('field', 5)), { t: 1 }), bob: slip(felt(bet('field', 1)), { t: 2 }) },
      [4, 5], { decided: 'forfeit', counted: ['bob'] });
    expect(out.lost.get('alice')).toBe(5);
    expect(out.amounts.get('alice')).toBe(-5);
    expect(out.credited.get('alice')).toBe(0);
    expect(own(out.sOut.w, 'alice')).toEqual(felt(bet('pass', 10)));
    expect(out.pushes.has('alice')).toBe(false);
  });

  it('wins and losses that cancel are ±0, not a push', () => {
    const out = roll(EMPTY_CARRY, { alice: slip(felt(bet('pass', 10), bet('field', 10)), { t: 1 }) }, [3, 4]);
    expect(out.amounts.get('alice')).toBe(0);
    expect(out.pushes.has('alice')).toBe(false);
  });

  it('a late seed costs nothing when the player added nothing, and take-downs stand', () => {
    const C = felt(bet('place', 12, 6), bet('place', 12, 8));
    const out = roll(carry(4, { alice: C }), { alice: slip(felt(bet('place', 12, 6)), { t: 1 }), bob: slip(felt(bet('field', 1)), { t: 2 }) },
      [5, 5], { decided: 'forfeit', counted: ['bob'] });
    expect(out.lost.get('alice')).toBe(0);
    expect(own(out.sOut.w, 'alice')).toEqual(felt(bet('place', 12, 6)));
  });

  it('a void keeps every felt with chips as its player left it, the point and the shooter', () => {
    const sIn = carry(6, { alice: felt(bet('pass', 10)), bob: felt(bet('place', 6, 8)) }, { h: 'alice', i: 1 });
    const out = roll(sIn, { alice: slip(felt(bet('pass', 10), bet('place', 6, 8))), bob: slip([]), carol: slip(felt(bet('field', 5))) }, null,
      { decided: 'void', counted: [] });
    expect(out.sOut.p).toBe(6);
    expect(out.sOut.h).toBe('alice');
    expect(out.sOut.i).toBe(1);
    expect(Object.keys(out.sOut.w).sort()).toEqual(['alice', 'carol']);
    expect(own(out.sOut.w, 'alice')).toEqual(felt(bet('pass', 10), bet('place', 6, 8)));
    for (const pid of ['alice', 'bob', 'carol']) expect(out.deltas.get(pid)).toBe(0);
  });

  it('a stale stamp or a rule break plays the bets as they stood', () => {
    const C = felt(bet('pass', 10));
    let out = roll(carry(6, { alice: C }), { alice: slip(felt(bet('field', 5)), { basisOk: false }) }, [1, 1]);
    expect(out.fates.get('alice')).toBe('basis');
    expect(out.felts.get('alice')).toEqual(C);
    out = roll(carry(6, { alice: C }), { alice: slip([]) }, [1, 1]);
    expect(out.fates.get('alice')).toBe('illegal');
    expect(own(out.sOut.w, 'alice')).toEqual(C);
  });

  it('a 32nd player is turned away, riders (gone ones too) first, then newcomers in pid order', () => {
    const w: Record<string, CrapsBet[]> = {};
    for (let i = 0; i < MAX_RIDERS - 1; i++) w[`r${String(i).padStart(2, '0')}`] = felt(bet('place', 6, 6));
    const out = roll(carry(4, w), { zed: slip(felt(bet('field', 5))), amy: slip(felt(bet('field', 5))) }, [1, 2]);
    expect(out.fates.get('amy')).toBe('ok');
    expect(out.fates.get('zed')).toBe('full');
    expect(out.felts.get('zed')).toEqual([]);
    expect(Object.keys(out.sOut.w).length).toBeLessThanOrEqual(MAX_RIDERS);
  });

  it('riders with ids like built-in names ride, pay and keep their own felts', () => {
    const sIn = carry(6, { constructor: felt(bet('pass', 10)), toString: felt(bet('place', 6, 6)) });
    const out = roll(sIn, { hasOwnProperty: slip(felt(bet('field', 5)), { t: 2 }) }, [3, 3]);
    expect(out.credited.get('constructor')).toBe(20);
    expect(out.credited.get('toString')).toBe(7);
    expect(own(out.sOut.w, 'toString')).toEqual(felt(bet('place', 6, 6)));
    expect(own(out.sOut.w, 'constructor')).toEqual([]);
    expect(Object.getPrototypeOf(out.sOut.w)).toBeNull();
  });

  it('undecided, it only says what each player has on the felt', () => {
    const out = roll(carry(6, { alice: felt(bet('pass', 10)) }), { bob: slip(felt(bet('field', 5))) }, null);
    expect(out.stakes).toEqual(new Map([['alice', 10], ['bob', 5]]));
    expect(out.deltas.size).toBe(0);
    expect(out.sOut.p).toBe(6);
  });

  it('chips are conserved roll by roll: free chips change by exactly what came back', () => {
    const rand = rng(57);
    const players = ['alice', 'bob', 'carol', 'dave', 'constructor'];
    let S: CrapsCarry = EMPTY_CARRY;
    for (let n = 0; n < 4000; n++) {
      const point = S.p === 0 ? null : S.p;
      const slips: Record<string, RollSlip> = {};
      for (const pid of players) {
        if (rand() < 0.4) continue;
        const C = own(S.w, pid);
        let B = canonFelt([...C, ...randomChips(rand, 3).filter((b) => canPlaceBet(b.type, point)
          && !((b.type === 'come' || b.type === 'dontcome') && b.pick !== undefined))]);
        if (rand() < 0.1) B = []; // a cheat's take-down-all, or an honest one
        slips[pid] = slip(B, { t: 1 + Math.floor(rand() * 7), basisOk: rand() < 0.95 });
      }
      const pids = Object.keys(slips);
      const v = rand();
      const decided = !pids.length ? 'void' : v < 0.05 ? 'void' : v < 0.25 ? 'forfeit' : 'reveals';
      const counted = decided === 'void' ? [] : decided === 'forfeit' ? pids.filter((_, i) => i === 0 || rand() < 0.5) : pids;
      const dice: [number, number] = [1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 6)];
      const out = playRoll({ sIn: S, slips: new Map(Object.entries(slips)), decided, counted, dice: decided === 'void' ? null : dice });
      for (const pid of new Set([...Object.keys(S.w), ...pids])) {
        const heldBefore = out.stakes.get(pid)!;
        const heldAfter = feltSum(own(out.sOut.w, pid));
        // free = bought + nets − held: Δfree = delta − (heldAfter − heldBefore) = credited.
        expect(out.deltas.get(pid)! - (heldAfter - heldBefore), `roll ${n} ${pid}`).toBe(out.credited.get(pid));
      }
      // A seven-out clears the felt.
      if (out.sevenOut) expect(Object.keys(out.sOut.w)).toEqual([]);
      for (const pid of Object.keys(out.sOut.w)) expect(isCanonFelt(own(out.sOut.w, pid)) && own(out.sOut.w, pid).length > 0).toBe(true);
      S = out.sOut;
    }
  });
});

describe('who shoots', () => {
  const seat = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it('the ring follows the stands clockwise, after the old shooter, the old shooter last', () => {
    // RING: stand 3 first, then 4, 5, 7, 2, 1, 6.
    const seated = seat({ alice: 1, bob: 4, carol: 6 });
    expect(shooterStep(carry(0, {}, { h: 'bob' }), seated, true, 6, null).h).toBe('alice');
    expect(shooterStep(carry(0, {}, { h: 'alice' }), seated, true, 6, null).h).toBe('carol');
    expect(shooterStep(carry(0, {}, { h: 'carol' }), seated, true, 6, null).h).toBe('bob');
    expect(RING.indexOf(4)).toBeLessThan(RING.indexOf(1));
  });

  it('a lone shooter who sevens out gets the dice back', () => {
    const out = roll(carry(6, { alice: felt(bet('pass', 10)) }, { h: 'alice', i: 1 }), { alice: slip(felt(bet('pass', 10)), { t: 3 }) }, [3, 4]);
    expect(out.sevenOut).toBe(true);
    expect(out.sOut.h).toBe('alice');
    expect(out.sOut.a).toBe('alice');
    expect(out.sOut.i).toBe(1);
  });

  it('a seven-out with nobody counted at a stand leaves the dice with the stickman', () => {
    const out = roll(carry(6, { alice: felt(bet('pass', 10)) }, { h: 'alice', i: 1 }), {}, [3, 4]);
    expect(out.sOut.h).toBeUndefined();
    expect(out.sOut.a).toBe('alice');
    expect(out.sOut.i).toBeUndefined();
  });

  it('the stickman\'s hand goes at once to a player counted at a stand, even mid-point', () => {
    const out = roll(carry(6, { bob: felt(bet('pass', 10)) }), { alice: slip(felt(bet('place', 6, 8)), { t: 5 }) }, [2, 3]);
    expect(out.pointAfter).toBe(6);
    expect(out.sOut.h).toBe('alice');
    expect(out.sOut.i).toBe(1);
  });

  it('a shooter with no bet down on a come-out loses the dice, whatever the roll', () => {
    for (const dice of [[3, 4], [2, 2], [1, 1]] as [number, number][]) {
      const out = roll(carry(0, {}, { h: 'alice', i: 1 }), { alice: slip([], { t: 3 }), bob: slip(felt(bet('pass', 10)), { t: 4 }) }, dice);
      expect(out.sOut.h, `${dice}`).toBe('bob');
    }
  });

  it('a shooter whose seed is late on the roll that makes the point loses the dice', () => {
    const sIn = carry(6, { alice: felt(bet('pass', 10)) }, { h: 'alice', i: 1 });
    const out = roll(sIn, { alice: slip(felt(bet('pass', 10)), { t: 3 }), bob: slip(felt(bet('field', 1)), { t: 4 }) }, [3, 3],
      { decided: 'forfeit', counted: ['bob'] });
    expect(out.pointAfter).toBeNull();
    expect(out.sOut.h).toBe('bob');
  });

  it('a shooter whose seed is late mid-point keeps the dice, not in play', () => {
    const sIn = carry(6, { alice: felt(bet('pass', 10)) }, { h: 'alice', i: 1 });
    const out = roll(sIn, { alice: slip(felt(bet('pass', 10)), { t: 3 }), bob: slip(felt(bet('field', 1)), { t: 4 }) }, [4, 4],
      { decided: 'forfeit', counted: ['bob'] });
    expect(out.pointAfter).toBe(6);
    expect(out.sOut.h).toBe('alice');
    expect(out.sOut.i).toBeUndefined();
  });

  it('a shooter away while the stickman makes the point loses the dice; away mid-point keeps them', () => {
    const sIn = carry(6, { alice: felt(bet('pass', 10)) }, { h: 'alice', i: 1 });
    // alice rides off the table (no stand on her slip); bob is at his.
    let out = roll(sIn, { alice: slip(felt(bet('pass', 10))), bob: slip(felt(bet('field', 1)), { t: 4 }) }, [3, 3]);
    expect(out.sOut.h).toBe('bob');
    out = roll(sIn, { alice: slip(felt(bet('pass', 10))), bob: slip(felt(bet('field', 1)), { t: 4 }) }, [4, 4]);
    expect(out.sOut.h).toBe('alice');
    expect(out.sOut.i).toBeUndefined();
    // Gone with no slip at all: the same.
    out = roll(sIn, { bob: slip(felt(bet('field', 1)), { t: 4 }) }, [4, 4]);
    expect(out.sOut.h).toBe('alice');
  });

  it('a counted take-down-all doesn\'t take the dice; a pid over 128 chars never holds them', () => {
    let out = roll(EMPTY_CARRY, { alice: slip([], { t: 3 }) }, [2, 3]);
    expect(out.sOut.h).toBeUndefined();
    const long = 'x'.repeat(129);
    out = roll(EMPTY_CARRY, { [long]: slip(felt(bet('pass', 1)), { t: 3 }) }, [2, 3]);
    expect(out.sOut.h).toBeUndefined();
  });

  it('a void leaves the dice where they were', () => {
    const sIn = carry(0, {}, { h: 'alice', a: 'bob', i: 1 });
    const out = roll(sIn, { carol: slip(felt(bet('pass', 5)), { t: 2 }) }, null, { decided: 'void', counted: [] });
    expect(out.sOut.h).toBe('alice');
    expect(out.sOut.a).toBe('bob');
    expect(out.sOut.i).toBe(1);
  });
});

describe('what the felt holds while no close is in', () => {
  it('a version that applies, else the riding bets; riders with no version at theirs', () => {
    const sIn = carry(6, { alice: felt(bet('pass', 10)), bob: felt(bet('place', 6, 6)) });
    const held = standingOf(sIn, new Map([
      ['alice', slip(felt(bet('pass', 10), bet('field', 5)))],
      ['carol', slip(felt(bet('field', 2)))],
      ['dave', slip(felt(bet('pass', 3)))], // a rule break: a pass line mid-point
    ]));
    expect(held).toEqual(new Map([['alice', 15], ['bob', 6], ['carol', 2]]));
    expect(standingOf(sIn, new Map([['alice', slip(felt(bet('field', 5)), { basisOk: false })]])).get('alice')).toBe(10);
  });
});

describe('the point numbers', () => {
  it('the carry points are craps.ts\'s, plus 0 for a come-out', () => {
    expect(CARRY_POINTS).toEqual(new Set([0, ...POINT_NUMBERS]));
  });
});
