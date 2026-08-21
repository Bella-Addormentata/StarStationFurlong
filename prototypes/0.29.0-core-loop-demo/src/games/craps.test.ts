/**
 * 🎲 Craps engine — comprehensive vitest suite (#69 G3).
 *
 * Mirrors roulette's verified-payout-table approach: every bet type is pinned
 * to a table of `(inputs, expected)` cases so the engine's payout math and
 * felt-state semantics survive future refactors. What we cover here:
 *
 *   • Come-out roll semantics (naturals, craps, point set) for pass/dontpass
 *   • Point-phase settlement (point made, seven-out, stays working) for pass/dontpass
 *   • Come / don't come travel: come-out cases, then travel + settle over
 *     multi-roll sequences via resolveCrapsRound (the round-level stamp)
 *   • True odds payout tables for passodds/comeodds AND lay-odds tables for
 *     dontpassodds/dontcomeodds — with fractional-payout floor rounding pinned
 *   • Field 2/12 double payout + the 3,4,9,10,11 single
 *   • Place bets: off on come-out, standard 9:5/7:5/7:6 odds when hit,
 *     seven-out kill, and STACK-AGGREGATED rounding (six 1-chip PLACE 6 pays 7,
 *     not six 0s from per-chip floor)
 *   • Any-7 (4:1) and any-craps (7:1)
 *   • canPlaceBet phase gating (line closed during a point; come/odds require it)
 *   • isCrapsBet trust-boundary rejection of malformed peer writes
 *   • crapsMaxOdds 3x/4x/5x schedule
 *   • rollCall stickman narration
 *   • nextPoint / shooterHandOver state transitions
 *   • initialCrapsState / isCrapsTableState shape guard round-trip
 *
 * These tests are PURE — no doc, no DOM, no crypto — so they run in ~10 ms and
 * pin the engine's contract for the croupier + backend + UI wiring above it.
 */

import { describe, expect, it } from 'vitest';
import {
  type CrapsBet,
  type CrapsBetType,
  type CrapsTableState,
  POINT_NUMBERS,
  canPlaceBet,
  crapsBetLabel,
  crapsMaxOdds,
  initialCrapsState,
  isCrapsBet,
  isCrapsTableState,
  layOddsPayout,
  nextPoint,
  resolveCrapsBet,
  resolveCrapsRound,
  rollCall,
  shooterHandOver,
  trueOddsPayout,
} from './craps';

// ── Tiny helper: build a bet without repeating the boilerplate. ─────────────
const bet = (type: CrapsBetType, amount: number, pick?: number, point?: number): CrapsBet => {
  const b: CrapsBet = { type, amount };
  if (pick !== undefined) b.pick = pick;
  if (point !== undefined) b.point = point;
  return b;
};

// ── POINT / STATE-TRANSITION HELPERS ────────────────────────────────────────
describe('point / state transitions', () => {
  it('POINT_NUMBERS is exactly {4,5,6,8,9,10}', () => {
    expect([...POINT_NUMBERS].sort((a, b) => a - b)).toEqual([4, 5, 6, 8, 9, 10]);
  });

  it('nextPoint: come-out sets on point number, else stays come-out', () => {
    for (const s of [4, 5, 6, 8, 9, 10]) expect(nextPoint(null, s)).toBe(s);
    for (const s of [2, 3, 7, 11, 12]) expect(nextPoint(null, s)).toBeNull();
  });

  it('nextPoint: point phase clears on point made or 7', () => {
    for (const p of [4, 5, 6, 8, 9, 10]) {
      expect(nextPoint(p, p)).toBeNull();   // point made
      expect(nextPoint(p, 7)).toBeNull();   // seven-out
      // Any other sum keeps the same point.
      for (const s of [2, 3, 11, 12]) expect(nextPoint(p, s)).toBe(p);
    }
  });

  it('shooterHandOver: only a point-phase 7 ends the hand', () => {
    expect(shooterHandOver(null, 7)).toBe(false);  // come-out natural, not a hand-ender
    expect(shooterHandOver(null, 2)).toBe(false);
    for (const p of [4, 5, 6, 8, 9, 10]) {
      expect(shooterHandOver(p, 7)).toBe(true);    // seven-out
      expect(shooterHandOver(p, p)).toBe(false);   // point made (same shooter comes out again)
      expect(shooterHandOver(p, 11)).toBe(false);
    }
  });
});

// ── PASS LINE ───────────────────────────────────────────────────────────────
describe('pass line', () => {
  // Table: [d1, d2, pointBefore, expected credited, expected keep]
  const comeOutCases: Array<[number, number, number, boolean, string]> = [
    // Naturals — win 1:1
    [3, 4, 20, false, '7 natural'],
    [5, 6, 20, false, '11 natural'],
    [6, 5, 20, false, '11 natural mirror'],
    // Craps — lose
    [1, 1, 0, false, '2 craps'],
    [1, 2, 0, false, '3 craps'],
    [6, 6, 0, false, '12 craps'],
    // Point set — stays
    [1, 3, 0, true, 'point 4'],
    [2, 3, 0, true, 'point 5'],
    [3, 3, 0, true, 'point 6'],
    [4, 4, 0, true, 'point 8'],
    [4, 5, 0, true, 'point 9'],
    [5, 5, 0, true, 'point 10'],
  ];
  it.each(comeOutCases)(
    'come-out: d1=%d d2=%d → credited=%d keep=%s (%s)',
    (d1, d2, credited, keep, _label) => {
      const r = resolveCrapsBet(bet('pass', 10), d1, d2, null);
      expect(r.credited).toBe(credited);
      expect(r.keep).toBe(keep);
    },
  );

  it('point phase: point made pays 1:1, 7 loses, else stays', () => {
    // Point 8, roll 8 → win 20; roll 7 → lose; roll anything else → stay.
    expect(resolveCrapsBet(bet('pass', 10), 4, 4, 8)).toEqual(
      { credited: 20, keep: false, outcome: 'win' },
    );
    expect(resolveCrapsBet(bet('pass', 10), 3, 4, 8)).toEqual(
      { credited: 0, keep: false, outcome: 'lose' },
    );
    expect(resolveCrapsBet(bet('pass', 10), 2, 3, 8)).toEqual(
      { credited: 0, keep: true, outcome: 'stay' },
    );
  });
});

// ── DON'T PASS ──────────────────────────────────────────────────────────────
describe("don't pass", () => {
  it('come-out: 2/3 win, 12 pushes, 7/11 lose, point sets', () => {
    // Win 1:1
    expect(resolveCrapsBet(bet('dontpass', 10), 1, 1, null).credited).toBe(20);
    expect(resolveCrapsBet(bet('dontpass', 10), 1, 2, null).credited).toBe(20);
    // Bar 12 → push (stake back)
    expect(resolveCrapsBet(bet('dontpass', 10), 6, 6, null)).toEqual(
      { credited: 10, keep: false, outcome: 'push' },
    );
    // Lose
    expect(resolveCrapsBet(bet('dontpass', 10), 3, 4, null).credited).toBe(0);
    expect(resolveCrapsBet(bet('dontpass', 10), 5, 6, null).credited).toBe(0);
    // Point set → stays
    expect(resolveCrapsBet(bet('dontpass', 10), 1, 3, null).keep).toBe(true);
  });

  it('point phase: 7 wins, point made loses, else stays', () => {
    expect(resolveCrapsBet(bet('dontpass', 10), 3, 4, 6).credited).toBe(20);
    expect(resolveCrapsBet(bet('dontpass', 10), 3, 3, 6).credited).toBe(0);
    expect(resolveCrapsBet(bet('dontpass', 10), 4, 4, 6).keep).toBe(true);
  });
});

// ── COME / DON'T COME (with resolveCrapsRound to exercise travel) ───────────
describe('come / dontcome', () => {
  it('come come-out (this roll): 7/11 win, 2/3/12 lose, point sets → travel', () => {
    // 7 wins
    expect(resolveCrapsBet(bet('come', 10), 3, 4, 5)).toEqual(
      { credited: 20, keep: false, outcome: 'win' },
    );
    // 11 wins
    expect(resolveCrapsBet(bet('come', 10), 6, 5, 5).credited).toBe(20);
    // 2 loses
    expect(resolveCrapsBet(bet('come', 10), 1, 1, 5).credited).toBe(0);
    // 3 loses
    expect(resolveCrapsBet(bet('come', 10), 1, 2, 5).credited).toBe(0);
    // 12 loses
    expect(resolveCrapsBet(bet('come', 10), 6, 6, 5).credited).toBe(0);
    // Point sets → travel to 8
    const t = resolveCrapsBet(bet('come', 10), 4, 4, 5);
    expect(t.keep).toBe(true);
    expect(t.travelPoint).toBe(8);
  });

  it('come with come point: matches → win, 7 → lose, else stays', () => {
    // Come bet living on 8.
    expect(resolveCrapsBet(bet('come', 10, undefined, 8), 4, 4, 8).credited).toBe(20);
    expect(resolveCrapsBet(bet('come', 10, undefined, 8), 3, 4, 8).credited).toBe(0);
    expect(resolveCrapsBet(bet('come', 10, undefined, 8), 3, 3, 8).keep).toBe(true);
  });

  it("dontcome come-out: 2/3 win, 12 pushes, 7/11 lose, point sets → travel", () => {
    expect(resolveCrapsBet(bet('dontcome', 10), 1, 1, 5).credited).toBe(20);
    expect(resolveCrapsBet(bet('dontcome', 10), 6, 6, 5)).toEqual(
      { credited: 10, keep: false, outcome: 'push' },
    );
    expect(resolveCrapsBet(bet('dontcome', 10), 3, 4, 5).credited).toBe(0);
    expect(resolveCrapsBet(bet('dontcome', 10), 6, 5, 5).credited).toBe(0);
    const t = resolveCrapsBet(bet('dontcome', 10), 4, 5, 5);
    expect(t.keep).toBe(true);
    expect(t.travelPoint).toBe(9);
  });

  it('dontcome with come point: 7 wins, point loses, else stays', () => {
    expect(resolveCrapsBet(bet('dontcome', 10, undefined, 9), 3, 4, 9).credited).toBe(20);
    expect(resolveCrapsBet(bet('dontcome', 10, undefined, 9), 4, 5, 9).credited).toBe(0);
    expect(resolveCrapsBet(bet('dontcome', 10, undefined, 9), 3, 3, 9).keep).toBe(true);
  });

  it('resolveCrapsRound stamps travelPoint onto the surviving come bet', () => {
    // Player has a fresh COME bet during a point-6 phase. Roll = 4+4 = 8, so
    // the come bet travels to 8. Next roll = 4+4 = 8 again, so the (stamped)
    // come bet wins.
    const r1 = resolveCrapsRound({ alice: [bet('come', 10)] }, 4, 4, 6);
    // No payout yet (bet just traveled), and the stamped bet is in `remaining`.
    expect(r1.payouts).toEqual({});
    expect(r1.remaining.alice).toEqual([{ type: 'come', amount: 10, point: 8 }]);

    // Feed the stamped list back in on the next roll.
    const r2 = resolveCrapsRound({ alice: r1.remaining.alice }, 4, 4, 6);
    expect(r2.payouts).toEqual({ alice: 20 });
    expect(r2.remaining.alice).toEqual([]);
  });

  it('resolveCrapsRound stamps a DON\'T COME bet + 7-out settles it as a win', () => {
    // Point-6 phase. dontcome placed, roll 5+5=10 → travel to 10.
    const r1 = resolveCrapsRound({ bob: [bet('dontcome', 10)] }, 5, 5, 6);
    expect(r1.remaining.bob).toEqual([{ type: 'dontcome', amount: 10, point: 10 }]);
    // Next roll 3+4=7. Point-phase 7 → the pass line loses, but the traveled
    // dontcome (living on 10) WINS because it wanted the 7 before its number.
    const r2 = resolveCrapsRound({ bob: r1.remaining.bob }, 3, 4, 6);
    expect(r2.payouts).toEqual({ bob: 20 });
    expect(r2.remaining.bob).toEqual([]);
  });

  it('a natural 7 on the come-bet come-out wins for come, loses for dontcome', () => {
    // Simultaneously seven-out on the pass line and win on the come bet.
    const r = resolveCrapsRound(
      { alice: [bet('pass', 5), bet('come', 5)] },
      3, 4, 6, // point 6, 7-out
    );
    // pass 5 loses (0), come 5 wins on the 7 → 10 credited.
    expect(r.payouts).toEqual({ alice: 10 });
    // Both resolved; nothing stays.
    expect(r.remaining.alice).toEqual([]);
  });
});

// ── TRUE ODDS (pass / come) ─────────────────────────────────────────────────
describe('true odds (passodds / comeodds)', () => {
  it('trueOddsPayout table', () => {
    expect(trueOddsPayout(4)).toEqual([2, 1]);
    expect(trueOddsPayout(5)).toEqual([3, 2]);
    expect(trueOddsPayout(6)).toEqual([6, 5]);
    expect(trueOddsPayout(8)).toEqual([6, 5]);
    expect(trueOddsPayout(9)).toEqual([3, 2]);
    expect(trueOddsPayout(10)).toEqual([2, 1]);
  });

  // Table: [point, stake, expected credited-on-hit (stake + true-odds win)]
  // 4/10 → 2:1  → stake + stake*2
  // 5/9  → 3:2  → stake + floor(stake*3/2)
  // 6/8  → 6:5  → stake + floor(stake*6/5)
  const oddsCases: Array<[number, number, number]> = [
    [4, 10, 30],    // 10 + 20
    [5, 10, 25],    // 10 + 15
    [6, 10, 22],    // 10 + 12
    [8, 25, 55],    // 25 + 30
    [9, 20, 50],    // 20 + 30
    [10, 15, 45],   // 15 + 30
    // Fractional flooring on a 6/8 stake of 3 → 3 + floor(3*6/5) = 3 + 3 = 6
    [6, 3, 6],
    // Fractional flooring on a 5/9 stake of 5 → 5 + floor(5*3/2) = 5 + 7 = 12
    [5, 5, 12],
  ];
  it.each(oddsCases)(
    'passodds point=%d stake=%d → credited=%d on hit',
    (point, stake, credited) => {
      const b = bet('passodds', stake, point);
      // Roll the point (one of the (d1,d2) pairs that sums to `point`).
      const d1 = Math.min(point - 1, 6);
      const d2 = point - d1;
      expect(resolveCrapsBet(b, d1, d2, point).credited).toBe(credited);
    },
  );

  it('passodds: 7-out loses (stake gone)', () => {
    expect(resolveCrapsBet(bet('passodds', 10, 6), 3, 4, 6).credited).toBe(0);
    expect(resolveCrapsBet(bet('passodds', 10, 6), 3, 4, 6).keep).toBe(false);
  });

  it('passodds: any other roll stays working', () => {
    expect(resolveCrapsBet(bet('passodds', 10, 6), 5, 5, 6).keep).toBe(true);
    expect(resolveCrapsBet(bet('passodds', 10, 6), 5, 5, 6).credited).toBe(0);
  });

  it('comeodds settles on ITS backed point, not the pass line point', () => {
    // Point 6, but comeodds backs a come point of 8.
    const b = bet('comeodds', 10, 8);
    // Roll 8 → win at 6:5 → 10 + 12 = 22
    expect(resolveCrapsBet(b, 4, 4, 6).credited).toBe(22);
    // Roll the pass point 6 → comeodds ignores it, stays.
    expect(resolveCrapsBet(b, 3, 3, 6).keep).toBe(true);
    // 7 → loses (like passodds).
    expect(resolveCrapsBet(b, 3, 4, 6).credited).toBe(0);
  });

  // Regression: passodds/comeodds are OFF on the pass-line come-out (standard
  // casino rule the block comment names). The felt's canPlaceBet gate blocks
  // placement while pointBefore is null, but a hostile peer can bypass it and
  // write a shape-valid odds bet directly into `bets:<id>:<pid>` — so the
  // ENGINE must also refuse to settle it on come-out. Every roll must stay,
  // regardless of whether the sum matches the backed point or is a 7.
  it('passodds during come-out stays regardless of roll (peer-write guard)', () => {
    for (const pick of [4, 5, 6, 8, 9, 10]) {
      const b = bet('passodds', 10, pick);
      // Sum that would ordinarily WIN (matches the backed point) → stay.
      const d1 = Math.min(pick - 1, 6);
      const d2 = pick - d1;
      expect(resolveCrapsBet(b, d1, d2, null)).toEqual(
        { credited: 0, keep: true, outcome: 'stay' },
      );
      // Sum that would ordinarily LOSE (7-out) → stay.
      expect(resolveCrapsBet(b, 3, 4, null)).toEqual(
        { credited: 0, keep: true, outcome: 'stay' },
      );
      // A neutral sum also stays.
      expect(resolveCrapsBet(b, 5, 6, null)).toEqual(
        { credited: 0, keep: true, outcome: 'stay' },
      );
    }
  });

  it('comeodds during come-out stays regardless of roll (peer-write guard)', () => {
    for (const pick of [4, 5, 6, 8, 9, 10]) {
      const b = bet('comeodds', 10, pick);
      // Match on backed point → stay (not the usual 22-on-6 payout).
      const d1 = Math.min(pick - 1, 6);
      const d2 = pick - d1;
      expect(resolveCrapsBet(b, d1, d2, null).keep).toBe(true);
      expect(resolveCrapsBet(b, d1, d2, null).credited).toBe(0);
      // 7 during come-out → stay (not the usual lose).
      expect(resolveCrapsBet(b, 3, 4, null).keep).toBe(true);
      expect(resolveCrapsBet(b, 3, 4, null).credited).toBe(0);
    }
  });

  // resolveCrapsRound-level regression: a hostile peer's passodds injected
  // during come-out must not siphon a true-odds payout out of the aggregate.
  it('resolveCrapsRound rejects come-out passodds settlement (peer-write guard)', () => {
    // Roll 8 on the come-out (would ordinarily be worth 22 at 6:5 true odds).
    const r = resolveCrapsRound(
      { hostile: [bet('passodds', 100, 8)] },
      4, 4, null,
    );
    expect(r.payouts).toEqual({});                                 // no siphon
    expect(r.remaining.hostile).toEqual([bet('passodds', 100, 8)]); // just stays
  });
});

// ── LAY ODDS (dontpass / dontcome) ──────────────────────────────────────────
describe('lay odds (dontpassodds / dontcomeodds)', () => {
  it('layOddsPayout table', () => {
    expect(layOddsPayout(4)).toEqual([1, 2]);
    expect(layOddsPayout(5)).toEqual([2, 3]);
    expect(layOddsPayout(6)).toEqual([5, 6]);
    expect(layOddsPayout(8)).toEqual([5, 6]);
    expect(layOddsPayout(9)).toEqual([2, 3]);
    expect(layOddsPayout(10)).toEqual([1, 2]);
  });

  // Table: [point, stake, expected credited on 7-out (stake + lay-odds win)]
  // 4/10 → 1:2 → stake + floor(stake/2)
  // 5/9  → 2:3 → stake + floor(stake*2/3)
  // 6/8  → 5:6 → stake + floor(stake*5/6)
  const layCases: Array<[number, number, number]> = [
    [4, 20, 30],    // 20 + 10
    [5, 30, 50],    // 30 + 20
    [6, 24, 44],    // 24 + 20
    [8, 12, 22],    // 12 + 10
    [9, 6, 10],     // 6  + 4
    [10, 40, 60],   // 40 + 20
    // Flooring on a 4/10 stake of 3 → 3 + floor(3/2) = 3 + 1 = 4
    [4, 3, 4],
    // Flooring on a 5/9 stake of 7 → 7 + floor(7*2/3) = 7 + 4 = 11
    [5, 7, 11],
  ];
  it.each(layCases)(
    'dontpassodds point=%d stake=%d → credited=%d on 7-out',
    (point, stake, credited) => {
      const b = bet('dontpassodds', stake, point);
      expect(resolveCrapsBet(b, 3, 4, point).credited).toBe(credited);
    },
  );

  it('dontpassodds: point made loses; other numbers stay', () => {
    expect(resolveCrapsBet(bet('dontpassodds', 20, 4), 2, 2, 4).credited).toBe(0);
    expect(resolveCrapsBet(bet('dontpassodds', 20, 4), 2, 2, 4).keep).toBe(false);
    expect(resolveCrapsBet(bet('dontpassodds', 20, 4), 5, 5, 4).keep).toBe(true);
  });

  it('dontcomeodds settles on ITS backed point', () => {
    const b = bet('dontcomeodds', 30, 5);
    // Roll 7 → wins at 2:3 → 30 + 20 = 50
    expect(resolveCrapsBet(b, 3, 4, 6).credited).toBe(50);
    // Roll 5 → loses
    expect(resolveCrapsBet(b, 2, 3, 6).credited).toBe(0);
    // Roll 6 (the pass point) → dontcomeodds ignores it
    expect(resolveCrapsBet(b, 3, 3, 6).keep).toBe(true);
  });

  // Mirror of the pass/comeodds come-out guard — the ENGINE must not honour a
  // peer-injected dontpassodds/dontcomeodds during a pass-line come-out. Every
  // roll must stay, regardless of whether the sum is a 7 (would ordinarily win
  // lay odds) or matches the backed point (would ordinarily lose).
  it('dontpassodds during come-out stays regardless of roll (peer-write guard)', () => {
    for (const pick of [4, 5, 6, 8, 9, 10]) {
      const b = bet('dontpassodds', 12, pick);
      // 7 would normally WIN lay odds → stay instead.
      expect(resolveCrapsBet(b, 3, 4, null)).toEqual(
        { credited: 0, keep: true, outcome: 'stay' },
      );
      // Match on the backed point would normally LOSE → stay instead.
      const d1 = Math.min(pick - 1, 6);
      const d2 = pick - d1;
      expect(resolveCrapsBet(b, d1, d2, null)).toEqual(
        { credited: 0, keep: true, outcome: 'stay' },
      );
    }
  });

  it('dontcomeodds during come-out stays regardless of roll (peer-write guard)', () => {
    for (const pick of [4, 5, 6, 8, 9, 10]) {
      const b = bet('dontcomeodds', 12, pick);
      expect(resolveCrapsBet(b, 3, 4, null).keep).toBe(true);
      expect(resolveCrapsBet(b, 3, 4, null).credited).toBe(0);
      const d1 = Math.min(pick - 1, 6);
      const d2 = pick - d1;
      expect(resolveCrapsBet(b, d1, d2, null).keep).toBe(true);
      expect(resolveCrapsBet(b, d1, d2, null).credited).toBe(0);
    }
  });

  it('resolveCrapsRound rejects come-out dontpassodds settlement (peer-write guard)', () => {
    // Roll 7 on the come-out (would ordinarily be worth 12 + floor(12*5/6) = 22
    // at 5:6 lay odds against a backed point of 6). Must stay, not pay.
    const r = resolveCrapsRound(
      { hostile: [bet('dontpassodds', 12, 6)] },
      3, 4, null,
    );
    expect(r.payouts).toEqual({});                                     // no siphon
    expect(r.remaining.hostile).toEqual([bet('dontpassodds', 12, 6)]); // just stays
  });
});

// ── FIELD ───────────────────────────────────────────────────────────────────
describe('field', () => {
  // Sum → expected credited for a 5-chip field bet.
  const cases: Array<[number, number]> = [
    [2, 15],   // 2:1
    [3, 10],   // 1:1
    [4, 10],
    [5, 0],    // loses
    [6, 0],
    [7, 0],
    [8, 0],
    [9, 10],
    [10, 10],
    [11, 10],
    [12, 15],  // 2:1
  ];
  it.each(cases)('sum=%d → credited=%d', (sum, credited) => {
    // Any (d1,d2) that adds to `sum`, capped 1–6.
    const d1 = Math.min(sum - 1, 6);
    const d2 = sum - d1;
    const r = resolveCrapsBet(bet('field', 5), d1, d2, null);
    expect(r.credited).toBe(credited);
    // Field is always one-and-done.
    expect(r.keep).toBe(false);
  });
});

// ── PLACE ───────────────────────────────────────────────────────────────────
describe('place', () => {
  it('is OFF on the come-out (stays working, no win/lose)', () => {
    for (const p of [4, 5, 6, 8, 9, 10]) {
      // Roll the number on the come-out — a place would win in-phase, but here
      // it's off, so it stays.
      const d1 = Math.min(p - 1, 6);
      const d2 = p - d1;
      const r = resolveCrapsBet(bet('place', 5, p), d1, d2, null);
      expect(r.keep).toBe(true);
      expect(r.credited).toBe(0);
    }
    // A 7 on the come-out doesn't kill place either (real-felt rule).
    expect(resolveCrapsBet(bet('place', 5, 6), 3, 4, null).keep).toBe(true);
  });

  it('WINNINGS only (stake stays working); pays casino odds', () => {
    // Stake 5 examples per number:
    //   4/10 → 9:5 → winnings 9
    //   5/9  → 7:5 → winnings 7
    //   6/8  → 7:6 → floor(5*7/6) = 5
    const cases: Array<[number, number]> = [
      [4, 9], [10, 9],
      [5, 7], [9, 7],
      [6, 5], [8, 5],
    ];
    for (const [num, winnings] of cases) {
      const d1 = Math.min(num - 1, 6);
      const d2 = num - d1;
      const r = resolveCrapsBet(bet('place', 5, num), d1, d2, 4); // some point on
      expect(r.credited).toBe(winnings);
      expect(r.keep).toBe(true);
      expect(r.outcome).toBe('win');
    }
  });

  it('seven-out kills every place bet', () => {
    for (const p of [4, 5, 6, 8, 9, 10]) {
      const r = resolveCrapsBet(bet('place', 5, p), 3, 4, p); // 7-out on any point
      expect(r.credited).toBe(0);
      expect(r.keep).toBe(false);
    }
  });

  it('resolveCrapsRound aggregates stacked PLACE stakes before rounding', () => {
    // Six 1-chip PLACE 6 bets on the same pick should pay 7 (6*7/6), NOT six
    // 0-payouts from Math.floor(1*7/6) each.
    const bets = Array.from({ length: 6 }, () => bet('place', 1, 6));
    const r = resolveCrapsRound({ alice: bets }, 3, 3, 4); // point 4, roll 6
    expect(r.payouts).toEqual({ alice: 7 });
    // All six stay working (place is a stay-on-win bet).
    expect(r.remaining.alice).toHaveLength(6);
  });

  it('resolveCrapsRound pays PLACE 4 winnings 9:5 for a stack', () => {
    // Two 5-chip PLACE 4 bets = 10 total on the 4 → 10*9/5 = 18 winnings.
    const bets = [bet('place', 5, 4), bet('place', 5, 4)];
    const r = resolveCrapsRound({ alice: bets }, 1, 3, 8);
    expect(r.payouts).toEqual({ alice: 18 });
  });
});

// ── STACK AGGREGATION FOR ODDS BETS (per-chip flooring is a real bug) ───────
describe('resolveCrapsRound stack aggregation on odds', () => {
  it('passodds: five 1-chips on point 6 pay 11 (5 + floor(30/5)), not 10', () => {
    // Point 6 is on; roll 3+3 = 6. Per-chip payout would be 5 * (1+floor(6/5))
    // = 5 * (1+1) = 10. Aggregate: 5 + floor(30/5) = 5 + 6 = 11. The dealer
    // stacks your chips and pays from the stack — so we do too.
    const bets = Array.from({ length: 5 }, () => bet('passodds', 1, 6));
    const r = resolveCrapsRound({ alice: bets }, 3, 3, 6);
    expect(r.payouts).toEqual({ alice: 11 });
    // Odds bets are one-and-done on a decision — the felt is clear.
    expect(r.remaining.alice).toEqual([]);
  });

  it('dontpassodds: three 1-chips on point 4 pay 4 (3 + floor(3/2)), not 3', () => {
    // Lay 4 is 1:2. Per-chip: 3 * (1 + floor(1/2)) = 3 * (1+0) = 3. Aggregate:
    // 3 + floor(3/2) = 3 + 1 = 4.
    const bets = Array.from({ length: 3 }, () => bet('dontpassodds', 1, 4));
    const r = resolveCrapsRound({ alice: bets }, 3, 4, 4); // 7-out
    expect(r.payouts).toEqual({ alice: 4 });
  });

  it('comeodds and passodds on the SAME pick pay independently', () => {
    // Both back point 6 (one from the pass line, one from a come point).
    const bets = [
      bet('passodds', 5, 6),
      bet('comeodds', 5, 6),
    ];
    // Roll 3+3 = 6, point 6 on.
    const r = resolveCrapsRound({ alice: bets }, 3, 3, 6);
    // Each single 5-chip bet pays 5 + floor(30/5) = 11. Two bets, different
    // stack keys → total 22.
    expect(r.payouts).toEqual({ alice: 22 });
  });

  it('dontcomeodds settles on a 7 without touching same-pick passodds', () => {
    // Point 6 on. Player has passodds 10 on 6 AND dontcomeodds 10 on 6 (came
    // from a don't come bet that traveled to 6). Roll 3+4 = 7.
    // passodds: 7-out loses (0). dontcomeodds: 7 wins → 10 + floor(50/6) = 18.
    const bets = [bet('passodds', 10, 6), bet('dontcomeodds', 10, 6)];
    const r = resolveCrapsRound({ alice: bets }, 3, 4, 6);
    expect(r.payouts).toEqual({ alice: 18 });
    expect(r.remaining.alice).toEqual([]);
  });

  it('mixed place + odds stack pay correctly together', () => {
    // Point 6 on; player has: pass 10, passodds 10 on 6, place 5 on 6 (twice).
    // Roll 3+3 = 6, point made.
    //   pass 10 wins → 20.
    //   passodds 10 on 6 → 10 + floor(60/5) = 22.
    //   place 5+5 = 10 stack on 6 → floor(70/6) = 11 (winnings only).
    const bets = [
      bet('pass', 10),
      bet('passodds', 10, 6),
      bet('place', 5, 6),
      bet('place', 5, 6),
    ];
    const r = resolveCrapsRound({ alice: bets }, 3, 3, 6);
    expect(r.payouts).toEqual({ alice: 20 + 22 + 11 });
    // Place bets stay working; pass + passodds are resolved.
    expect(r.remaining.alice).toEqual([
      bet('place', 5, 6),
      bet('place', 5, 6),
    ]);
  });
});

// ── ONE-ROLL PROPS ──────────────────────────────────────────────────────────
describe('any 7 / any craps', () => {
  it('any 7 pays 4:1 (credited = amount*5)', () => {
    // Wins on 7 regardless of point.
    expect(resolveCrapsBet(bet('anyseven', 4), 3, 4, null).credited).toBe(20);
    expect(resolveCrapsBet(bet('anyseven', 4), 3, 4, 6).credited).toBe(20);
    // Anything else loses.
    for (const [d1, d2] of [[1, 1], [3, 3], [4, 4]] as Array<[number, number]>) {
      expect(resolveCrapsBet(bet('anyseven', 4), d1, d2, null).credited).toBe(0);
    }
  });

  it('any craps pays 7:1 (credited = amount*8) on 2/3/12', () => {
    for (const [d1, d2] of [[1, 1], [1, 2], [6, 6]] as Array<[number, number]>) {
      expect(resolveCrapsBet(bet('anycraps', 3), d1, d2, null).credited).toBe(24);
    }
    expect(resolveCrapsBet(bet('anycraps', 3), 3, 4, null).credited).toBe(0);
  });
});

// ── canPlaceBet — phase gating ─────────────────────────────────────────────
describe('canPlaceBet', () => {
  it('pass / dontpass: come-out only', () => {
    expect(canPlaceBet('pass', null)).toBe(true);
    expect(canPlaceBet('pass', 6)).toBe(false);
    expect(canPlaceBet('dontpass', null)).toBe(true);
    expect(canPlaceBet('dontpass', 6)).toBe(false);
  });
  it('come / dontcome: point ON only', () => {
    expect(canPlaceBet('come', null)).toBe(false);
    expect(canPlaceBet('come', 6)).toBe(true);
    expect(canPlaceBet('dontcome', null)).toBe(false);
    expect(canPlaceBet('dontcome', 6)).toBe(true);
  });
  it('passodds / dontpassodds / comeodds / dontcomeodds: point ON only', () => {
    for (const t of ['passodds', 'dontpassodds', 'comeodds', 'dontcomeodds'] as CrapsBetType[]) {
      expect(canPlaceBet(t, null)).toBe(false);
      expect(canPlaceBet(t, 8)).toBe(true);
    }
  });
  it('field / place / anyseven / anycraps: always allowed', () => {
    for (const t of ['field', 'place', 'anyseven', 'anycraps'] as CrapsBetType[]) {
      expect(canPlaceBet(t, null)).toBe(true);
      expect(canPlaceBet(t, 8)).toBe(true);
    }
  });
});

// ── isCrapsBet — trust boundary ─────────────────────────────────────────────
describe('isCrapsBet (peer-write guard)', () => {
  it('accepts each valid bet shape', () => {
    // pass/dontpass/come/dontcome/field/anyseven/anycraps: NO pick.
    for (const t of ['pass', 'dontpass', 'come', 'dontcome', 'field', 'anyseven', 'anycraps'] as CrapsBetType[]) {
      expect(isCrapsBet({ type: t, amount: 5 })).toBe(true);
    }
    // Place / odds: pick required and must be a point number.
    for (const p of [4, 5, 6, 8, 9, 10]) {
      expect(isCrapsBet({ type: 'place', amount: 5, pick: p })).toBe(true);
      expect(isCrapsBet({ type: 'passodds', amount: 5, pick: p })).toBe(true);
      expect(isCrapsBet({ type: 'dontpassodds', amount: 5, pick: p })).toBe(true);
      expect(isCrapsBet({ type: 'comeodds', amount: 5, pick: p })).toBe(true);
      expect(isCrapsBet({ type: 'dontcomeodds', amount: 5, pick: p })).toBe(true);
    }
    // Come / dontcome may carry an optional stamped point.
    expect(isCrapsBet({ type: 'come', amount: 5, point: 8 })).toBe(true);
    expect(isCrapsBet({ type: 'dontcome', amount: 5, point: 4 })).toBe(true);
  });

  it('rejects unknown type / bad amount / missing or bad pick', () => {
    expect(isCrapsBet({ type: 'nope', amount: 5 })).toBe(false);
    expect(isCrapsBet({ type: 'pass', amount: 0 })).toBe(false);
    expect(isCrapsBet({ type: 'pass', amount: -1 })).toBe(false);
    expect(isCrapsBet({ type: 'pass', amount: 1.5 })).toBe(false);
    // place with no pick
    expect(isCrapsBet({ type: 'place', amount: 5 })).toBe(false);
    // place with 7 (not a point number)
    expect(isCrapsBet({ type: 'place', amount: 5, pick: 7 })).toBe(false);
    // odds with no pick or wrong pick
    expect(isCrapsBet({ type: 'passodds', amount: 5 })).toBe(false);
    expect(isCrapsBet({ type: 'passodds', amount: 5, pick: 3 })).toBe(false);
    // pass with a stray pick
    expect(isCrapsBet({ type: 'pass', amount: 5, pick: 4 })).toBe(false);
    // stray point on a type that shouldn't carry one
    expect(isCrapsBet({ type: 'pass', amount: 5, point: 6 })).toBe(false);
    // bad stamped point (not a point number)
    expect(isCrapsBet({ type: 'come', amount: 5, point: 7 })).toBe(false);
  });

  it('rejects non-objects / null / arrays', () => {
    expect(isCrapsBet(null)).toBe(false);
    expect(isCrapsBet('pass')).toBe(false);
    expect(isCrapsBet(42)).toBe(false);
    // Arrays: typeof is 'object' but no matching shape → guard rejects on the
    // string-`type` check.
    expect(isCrapsBet([])).toBe(false);
  });
});

// ── crapsMaxOdds — 3x/4x/5x ─────────────────────────────────────────────────
describe('crapsMaxOdds (3x/4x/5x)', () => {
  it('caps by point', () => {
    expect(crapsMaxOdds(10, 4)).toBe(30);
    expect(crapsMaxOdds(10, 10)).toBe(30);
    expect(crapsMaxOdds(10, 5)).toBe(40);
    expect(crapsMaxOdds(10, 9)).toBe(40);
    expect(crapsMaxOdds(10, 6)).toBe(50);
    expect(crapsMaxOdds(10, 8)).toBe(50);
  });
  it('non-point input returns 0', () => {
    expect(crapsMaxOdds(10, 7)).toBe(0);
    expect(crapsMaxOdds(10, 11)).toBe(0);
  });
  it('handles a zero / negative flat stake gracefully', () => {
    expect(crapsMaxOdds(0, 6)).toBe(0);
    expect(crapsMaxOdds(-5, 6)).toBe(0);
  });
});

// ── crapsBetLabel ───────────────────────────────────────────────────────────
describe('crapsBetLabel', () => {
  it('renders every bet type', () => {
    expect(crapsBetLabel(bet('pass', 5))).toBe('PASS LINE');
    expect(crapsBetLabel(bet('dontpass', 5))).toBe("DON'T PASS");
    expect(crapsBetLabel(bet('come', 5))).toBe('COME');
    expect(crapsBetLabel(bet('come', 5, undefined, 8))).toBe('COME 8');
    expect(crapsBetLabel(bet('dontcome', 5))).toBe("DON'T COME");
    expect(crapsBetLabel(bet('dontcome', 5, undefined, 4))).toBe("DON'T COME 4");
    expect(crapsBetLabel(bet('passodds', 5, 6))).toBe('PASS ODDS 6');
    expect(crapsBetLabel(bet('dontpassodds', 5, 8))).toBe("DON'T PASS ODDS 8");
    expect(crapsBetLabel(bet('comeodds', 5, 5))).toBe('COME ODDS 5');
    expect(crapsBetLabel(bet('dontcomeodds', 5, 10))).toBe("DON'T COME ODDS 10");
    expect(crapsBetLabel(bet('field', 5))).toBe('FIELD');
    expect(crapsBetLabel(bet('place', 5, 6))).toBe('PLACE 6');
    expect(crapsBetLabel(bet('anyseven', 5))).toBe('ANY 7');
    expect(crapsBetLabel(bet('anycraps', 5))).toBe('ANY CRAPS');
  });
});

// ── rollCall — stickman narration ───────────────────────────────────────────
describe('rollCall', () => {
  it('come-out calls', () => {
    expect(rollCall(7, null, null)).toBe('7 — A NATURAL, PASS WINS');
    expect(rollCall(11, null, null)).toBe('11 — A NATURAL, PASS WINS');
    expect(rollCall(2, null, null)).toBe('2 — CRAPS, LINE LOSES');
    expect(rollCall(3, null, null)).toBe('3 — CRAPS, LINE LOSES');
    expect(rollCall(12, null, null)).toBe('12 — CRAPS, LINE LOSES');
    expect(rollCall(6, null, 6)).toBe('6 — THE POINT IS 6');
  });
  it('point-phase calls', () => {
    expect(rollCall(7, 6, null)).toBe('7 — SEVEN OUT');
    expect(rollCall(6, 6, null)).toBe('6 — WINNER, POINT MADE');
    expect(rollCall(9, 6, 6)).toBe('9 — ROLL AGAIN, POINT IS 6');
  });
});

// ── initialCrapsState / isCrapsTableState — shape round-trip ────────────────
describe('table state shape', () => {
  it('initialCrapsState passes the shape guard', () => {
    const s = initialCrapsState();
    expect(isCrapsTableState(s)).toBe(true);
  });

  it('shape guard rejects malformed peer writes', () => {
    // wrong kind
    expect(isCrapsTableState({ ...initialCrapsState(), kind: 'roulette' })).toBe(false);
    // bad phase
    const bad: unknown = { ...initialCrapsState(), phase: 'idle' };
    expect(isCrapsTableState(bad)).toBe(false);
    // non-point `point`
    expect(isCrapsTableState({ ...initialCrapsState(), point: 7 })).toBe(false);
    // dice out of range
    expect(isCrapsTableState({ ...initialCrapsState(), dice: [0, 3] })).toBe(false);
    expect(isCrapsTableState({ ...initialCrapsState(), dice: [1, 7] })).toBe(false);
    // dice wrong arity
    expect(isCrapsTableState({ ...initialCrapsState(), dice: [1, 2, 3] as unknown as [number, number] })).toBe(false);
    // payouts with a negative entry
    expect(isCrapsTableState({ ...initialCrapsState(), payouts: { alice: -1 } })).toBe(false);
  });

  it('a settled state with fairness + sevenOut round-trips through the guard', () => {
    const settled: CrapsTableState = {
      ...initialCrapsState(),
      phase: 'settled',
      round: 2,
      point: null,
      dice: [3, 4],
      result: 7,
      resultAt: 1_700_000_000_000,
      payouts: { alice: 10 },
      sevenOut: true,
      fairness: { mode: 'rng' },
    };
    expect(isCrapsTableState(settled)).toBe(true);
  });
});

// ── Multi-roll scenario: a full shooter hand ───────────────────────────────
describe('shooter-hand scenario (integration)', () => {
  it('flat pass 10 + odds 20 on point 6, then made → 10*2 + (20 + 20*6/5) = 62', () => {
    // Round 1: come-out, roll 3+3 = 6 → point set.
    const r1 = resolveCrapsRound(
      { alice: [bet('pass', 10)] },
      3, 3, null,
    );
    expect(r1.payouts).toEqual({});
    expect(r1.remaining.alice).toEqual([bet('pass', 10)]);
    // Between rolls the player backs the pass line with 20 in odds (point 6).
    const armed = [...r1.remaining.alice, bet('passodds', 20, 6)];
    // Round 2: roll 3+3 = 6 → point MADE. Pass returns 20; odds returns 20 + 24 = 44.
    const r2 = resolveCrapsRound({ alice: armed }, 3, 3, 6);
    expect(r2.payouts).toEqual({ alice: 20 + 44 });
    // Both resolved; nothing stays.
    expect(r2.remaining.alice).toEqual([]);
  });

  it('point-phase 7-out: pass line loses AND every place bet dies', () => {
    // Point 8 established (prior). Player has pass 10, place 6 for 5, place 8 for 6.
    const bets = [bet('pass', 10), bet('place', 5, 6), bet('place', 6, 8)];
    const r = resolveCrapsRound({ alice: bets }, 3, 4, 8); // 7-out
    expect(r.payouts).toEqual({});
    expect(r.remaining.alice).toEqual([]);
  });

  it('multi-player independent resolutions', () => {
    // Alice: pass on come-out; Bob: dontpass on come-out.
    const bets = { alice: [bet('pass', 10)], bob: [bet('dontpass', 10)] };
    // Roll 12 → alice loses (craps), bob pushes (bar 12).
    const r = resolveCrapsRound(bets, 6, 6, null);
    expect(r.payouts).toEqual({ bob: 10 });
    expect(r.remaining.alice).toEqual([]);
    expect(r.remaining.bob).toEqual([]);
  });
});
