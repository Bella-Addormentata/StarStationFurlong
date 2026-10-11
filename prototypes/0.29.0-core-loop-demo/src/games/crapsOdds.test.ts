/**
 * Craps odds tests: pass / don't pass odds and come / don't come odds at true
 * odds (2:1 · 3:2 · 6:5) and their lay inverses (1:2 · 2:3 · 5:6), the 3-4-5x
 * cap (6x on the lay side), and the come-out rule (come odds off, lay odds
 * working).
 *
 * Pure: no DOM, no THREE, no Yjs.
 */

import { describe, expect, it } from 'vitest';
import {
  canPlaceBet,
  crapsBetLabel,
  isCrapsBet,
  MAX_LAY_MULTIPLE,
  MAX_ODDS_MULTIPLE,
  maxOddsStake,
  oddsPayout,
  oddsRoom,
  resolveCrapsBet,
  resolveCrapsRound,
  type CrapsBet,
} from './craps';

const bet = (type: CrapsBet['type'], amount = 10, pick?: number): CrapsBet =>
  pick === undefined ? { type, amount } : { type, amount, pick };

/** A non-pair throw for each sum (pairs only on 2 and 12). */
const DICE: Record<number, [number, number]> = {
  2: [1, 1], 3: [1, 2], 4: [1, 3], 5: [2, 3], 6: [2, 4], 7: [3, 4],
  8: [3, 5], 9: [4, 5], 10: [4, 6], 11: [5, 6], 12: [6, 6],
};

/** One player's roll: what came back, and what stayed on the felt. */
function roll(bets: CrapsBet[], sum: number, pointBefore: number | null) {
  const [d1, d2] = DICE[sum];
  const r = resolveCrapsRound({ p: bets }, d1, d2, pointBefore);
  return { paid: r.payouts.p ?? 0, kept: r.remaining.p };
}

describe('odds bet shapes', () => {
  it('validates the four odds types', () => {
    expect(isCrapsBet(bet('passodds'))).toBe(true);
    expect(isCrapsBet(bet('dontpassodds'))).toBe(true);
    expect(isCrapsBet(bet('comeodds', 10, 8))).toBe(true);
    expect(isCrapsBet(bet('dontcomeodds', 10, 4))).toBe(true);
    // Line odds back the table's point: no pick of their own.
    expect(isCrapsBet(bet('passodds', 10, 6))).toBe(false);
    expect(isCrapsBet(bet('dontpassodds', 10, 6))).toBe(false);
    // Come odds must name a point number.
    expect(isCrapsBet(bet('comeodds'))).toBe(false);
    expect(isCrapsBet(bet('comeodds', 10, 7))).toBe(false);
    expect(isCrapsBet(bet('dontcomeodds', 10, 11))).toBe(false);
    expect(isCrapsBet({ type: 'comeodds', pick: 6.5, amount: 10 })).toBe(false);
    expect(isCrapsBet({ type: 'passodds', amount: 0 })).toBe(false);
    expect(isCrapsBet({ type: 'buyodds', amount: 10 })).toBe(false);
  });

  it('labels them', () => {
    expect(crapsBetLabel(bet('passodds'))).toBe('PASS LINE ODDS');
    expect(crapsBetLabel(bet('dontpassodds'))).toBe("DON'T PASS LAY ODDS");
    expect(crapsBetLabel(bet('comeodds', 10, 9))).toBe('COME ODDS 9');
    expect(crapsBetLabel(bet('dontcomeodds', 10, 5))).toBe("DON'T COME LAY ODDS 5");
  });

  it('opens line odds only with a point on; come odds whenever', () => {
    expect(canPlaceBet('passodds', null)).toBe(false);
    expect(canPlaceBet('dontpassodds', null)).toBe(false);
    expect(canPlaceBet('passodds', 6)).toBe(true);
    expect(canPlaceBet('dontpassodds', 6)).toBe(true);
    expect(canPlaceBet('comeodds', null)).toBe(true);
    expect(canPlaceBet('dontcomeodds', 8)).toBe(true);
  });
});

describe('the odds tables', () => {
  it('pays true odds on the right side and the inverse on the lay', () => {
    const right = [4, 5, 6, 8, 9, 10].map((n) => oddsPayout('passodds', n));
    expect(right).toEqual([[2, 1], [3, 2], [6, 5], [6, 5], [3, 2], [2, 1]]);
    expect([4, 5, 6, 8, 9, 10].map((n) => oddsPayout('comeodds', n))).toEqual(right);
    const lay = [4, 5, 6, 8, 9, 10].map((n) => oddsPayout('dontpassodds', n));
    expect(lay).toEqual([[1, 2], [2, 3], [5, 6], [5, 6], [2, 3], [1, 2]]);
    expect([4, 5, 6, 8, 9, 10].map((n) => oddsPayout('dontcomeodds', n))).toEqual(lay);
  });

  it('caps the odds at 3-4-5x the flat bet, and the lay at 6x', () => {
    expect(MAX_ODDS_MULTIPLE).toEqual({ 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 });
    expect(MAX_LAY_MULTIPLE).toBe(6);
    expect(maxOddsStake('passodds', 4, 10)).toBe(30);
    expect(maxOddsStake('comeodds', 9, 10)).toBe(40);
    expect(maxOddsStake('passodds', 8, 10)).toBe(50);
    for (const n of [4, 5, 6, 8, 9, 10]) expect(maxOddsStake('dontcomeodds', n, 10)).toBe(60);
    expect(maxOddsStake('passodds', 7, 10)).toBe(0);
    expect(maxOddsStake('passodds', 6, 0)).toBe(0);
  });

  it('a full lay wins what full right-side odds would: 3x / 4x / 5x the flat', () => {
    for (const n of [4, 5, 6, 8, 9, 10]) {
      const [num, den] = oddsPayout('dontpassodds', n);
      expect((maxOddsStake('dontpassodds', n, 10) * num) / den).toBe(10 * MAX_ODDS_MULTIPLE[n]);
    }
  });
});

describe('pass line odds', () => {
  const cases: Array<[number, number, number]> = [
    // point, odds stake, odds credit on the point (stake + true-odds winnings)
    [4, 30, 30 + 60],
    [10, 30, 30 + 60],
    [5, 40, 40 + 60],
    [9, 20, 20 + 30],
    [6, 50, 50 + 60],
    [8, 25, 25 + 30],
  ];
  for (const [point, odds, credit] of cases) {
    it(`pays the point ${point} at true odds`, () => {
      const r = roll([bet('pass', 10), bet('passodds', odds)], point, point);
      expect(r.paid).toBe(20 + credit);
      expect(r.kept).toEqual([]);
    });
  }

  it('loses with the line on a seven-out', () => {
    const r = roll([bet('pass', 10), bet('passodds', 50)], 7, 6);
    expect(r.paid).toBe(0);
    expect(r.kept).toEqual([]);
  });

  it('rides with the line on any other number', () => {
    const bets = [bet('pass', 10), bet('passodds', 25), bet('passodds', 5)];
    const r = roll(bets, 9, 6);
    expect(r.paid).toBe(0);
    expect(r.kept).toEqual(bets);
  });

  it('pays the whole stack at once, so small chips keep their fractions', () => {
    // Three $1 chips at 3:2 on the 5: 3 + 4 (4.5 rounded down), not 3 × (1 + 1).
    const r = roll([bet('pass', 1), bet('passodds', 1), bet('passodds', 1), bet('passodds', 1)], 5, 5);
    expect(r.paid).toBe(2 + 3 + 4);
  });
});

describe("don't pass lay odds", () => {
  const cases: Array<[number, number, number]> = [
    // point, lay stake, lay credit on a 7 (stake + inverse-odds winnings)
    [4, 60, 60 + 30],
    [10, 20, 20 + 10],
    [5, 60, 60 + 40],
    [9, 30, 30 + 20],
    [6, 60, 60 + 50],
    [8, 12, 12 + 10],
  ];
  for (const [point, lay, credit] of cases) {
    it(`lays the ${point} at ${oddsPayout('dontpassodds', point).join(':')}`, () => {
      const r = roll([bet('dontpass', 10), bet('dontpassodds', lay)], 7, point);
      expect(r.paid).toBe(20 + credit);
      expect(r.kept).toEqual([]);
    });
  }

  it('loses when the point is made', () => {
    const r = roll([bet('dontpass', 10), bet('dontpassodds', 60)], 4, 4);
    expect(r.paid).toBe(0);
    expect(r.kept).toEqual([]);
  });

  it('rides on any other number', () => {
    const bets = [bet('dontpass', 10), bet('dontpassodds', 60)];
    expect(roll(bets, 11, 4).kept).toEqual(bets);
  });
});

describe('come odds', () => {
  it('pays a come point at true odds with a point on', () => {
    for (const [n, odds, credit] of [[4, 30, 90], [5, 40, 100], [6, 50, 110], [8, 50, 110], [9, 40, 100], [10, 30, 90]]) {
      const r = roll([bet('come', 10, n), bet('comeodds', odds, n)], n, n === 5 ? 6 : 5);
      expect(r.paid, `come ${n}`).toBe(20 + credit);
      expect(r.kept).toEqual([]);
    }
  });

  it('loses with the come bet on a seven-out', () => {
    const r = roll([bet('come', 10, 8), bet('comeodds', 50, 8)], 7, 5);
    expect(r.paid).toBe(0);
    expect(r.kept).toEqual([]);
  });

  it('only backs the come bet on its own number', () => {
    const bets = [bet('come', 10, 8), bet('come', 10, 5), bet('comeodds', 50, 8)];
    const r = roll(bets, 5, 9);
    // The come 5 wins; the 8 and its odds ride.
    expect(r.paid).toBe(20);
    expect(r.kept).toEqual([bet('come', 10, 8), bet('comeodds', 50, 8)]);
  });

  describe('on the come-out roll the odds are OFF', () => {
    const bets = [bet('come', 10, 8), bet('comeodds', 50, 8)];

    it('the come bet wins on its number, the odds come back unpaid', () => {
      const r = roll(bets, 8, null);
      expect(r.paid).toBe(20 + 50);
      expect(r.kept).toEqual([]);
    });

    it('the come bet loses on a 7, the odds come back', () => {
      const r = roll(bets, 7, null);
      expect(r.paid).toBe(50);
      expect(r.kept).toEqual([]);
    });

    it('anything else leaves both up', () => {
      const r = roll(bets, 6, null);
      expect(r.paid).toBe(0);
      expect(r.kept).toEqual(bets);
    });
  });
});

describe("don't come lay odds", () => {
  it('lay every number at the inverse odds on a 7', () => {
    for (const [n, credit] of [[4, 60 + 30], [5, 60 + 40], [6, 60 + 50], [8, 60 + 50], [9, 60 + 40], [10, 60 + 30]]) {
      const r = roll([bet('dontcome', 10, n), bet('dontcomeodds', 60, n)], 7, 5);
      expect(r.paid, `lay ${n}`).toBe(20 + credit);
    }
  });

  it('loses when its number comes', () => {
    const r = roll([bet('dontcome', 10, 4), bet('dontcomeodds', 60, 4)], 4, 9);
    expect(r.paid).toBe(0);
    expect(r.kept).toEqual([]);
  });

  it('stays WORKING on the come-out roll', () => {
    const won = roll([bet('dontcome', 10, 4), bet('dontcomeodds', 60, 4)], 7, null);
    expect(won.paid).toBe(20 + 90);
    const lost = roll([bet('dontcome', 10, 4), bet('dontcomeodds', 60, 4)], 4, null);
    expect(lost.paid).toBe(0);
    expect(lost.kept).toEqual([]);
  });
});

describe('the settle enforces what the felt checks', () => {
  it('pays odds only up to the cap; the rest comes back as it was', () => {
    // $10 on the pass line, point 6: 5x is $50 of odds; $100 is down.
    const win = roll([bet('pass', 10), bet('passodds', 100)], 6, 6);
    expect(win.paid).toBe(20 + 50 + 60 + 50);
    const lose = roll([bet('pass', 10), bet('passodds', 100)], 7, 6);
    expect(lose.paid).toBe(50);
  });

  it('caps the lay at 6x', () => {
    const r = roll([bet('dontpass', 10), bet('dontpassodds', 100)], 7, 4);
    expect(r.paid).toBe(20 + 60 + 30 + 40);
  });

  it('returns odds with no flat bet behind them', () => {
    for (const odds of [bet('passodds', 30), bet('dontpassodds', 30), bet('comeodds', 30, 8), bet('dontcomeodds', 30, 8)]) {
      for (const sum of [4, 7, 8, 11]) {
        const r = roll([odds], sum, 4);
        expect(r.paid, `${odds.type} on ${sum}`).toBe(30);
        expect(r.kept).toEqual([]);
      }
    }
    // A come bet on another number doesn't back come odds on the 8.
    expect(roll([bet('come', 10, 6), bet('comeodds', 30, 8)], 8, 4).paid).toBe(30);
  });

  it('returns line odds with no point to back', () => {
    const r = roll([bet('pass', 10), bet('passodds', 30)], 7, null);
    // The pass line wins its natural; the stray odds come back.
    expect(r.paid).toBe(20 + 30);
    expect(r.kept).toEqual([]);
  });

  it('a lone odds bet resolves as if fully backed', () => {
    const [d1, d2] = DICE[6];
    expect(resolveCrapsBet(bet('passodds', 50), d1, d2, 6)).toEqual({ credited: 110, keep: false, outcome: 'win' });
    expect(resolveCrapsBet(bet('comeodds', 50, 6), d1, d2, null)).toEqual({ credited: 50, keep: false, outcome: 'push' });
    const [s1, s2] = DICE[7];
    expect(resolveCrapsBet(bet('dontcomeodds', 30, 4), s1, s2, null).credited).toBe(45);
  });
});

describe('oddsRoom (the felt check)', () => {
  it('needs a point for line odds', () => {
    expect(oddsRoom([bet('pass', 10)], 'passodds', undefined, null).reason).toMatch(/POINT/);
  });

  it('needs the flat bet', () => {
    expect(oddsRoom([], 'passodds', undefined, 6).reason).toBe('NO PASS LINE BET TO BACK');
    expect(oddsRoom([], 'dontpassodds', undefined, 6).reason).toBe("NO DON'T PASS BET TO BACK");
    expect(oddsRoom([bet('come', 10, 5)], 'comeodds', 8, 6).reason).toBe('NO COME BET ON 8 TO BACK');
    // A come bet still in the come box has no number to back yet.
    expect(oddsRoom([bet('dontcome', 10)], 'dontcomeodds', 8, 6).reason).toBe("NO DON'T COME BET ON 8 TO BACK");
  });

  it('counts what is already up toward the cap', () => {
    const bets = [bet('pass', 5), bet('pass', 5), bet('passodds', 25)];
    expect(oddsRoom(bets, 'passodds', undefined, 6)).toEqual({ room: 25, reason: null });
    expect(oddsRoom([...bets, bet('passodds', 25)], 'passodds', undefined, 6).reason).toMatch(/MAXIMUM/);
    expect(oddsRoom([bet('dontcome', 10, 9)], 'dontcomeodds', 9, null)).toEqual({ room: 60, reason: null });
    expect(oddsRoom([bet('come', 10, 4), bet('comeodds', 10, 4)], 'comeodds', 4, 6)).toEqual({ room: 20, reason: null });
  });
});
