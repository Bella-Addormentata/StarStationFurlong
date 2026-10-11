/**
 * Craps engine tests — #69 G3 payouts plus the #226 felt (come / don't come,
 * big 6/8, hardways, the one-roll propositions) and the shooter ring.
 *
 * Pure: no DOM, no THREE, no Yjs.
 */

import { describe, expect, it } from 'vitest';
import {
  canPlaceBet,
  crapsBetLabel,
  hasLineBet,
  initialCrapsState,
  isCrapsBet,
  isCrapsTableState,
  pickShooter,
  pointWasOn,
  resolveCrapsBet,
  resolveCrapsRound,
  type CrapsBet,
} from './craps';

const bet = (type: CrapsBet['type'], amount = 10, pick?: number): CrapsBet =>
  pick === undefined ? { type, amount } : { type, amount, pick };

describe('craps bet shapes', () => {
  it('accepts every felt bet with the right pick', () => {
    expect(isCrapsBet(bet('come'))).toBe(true);
    expect(isCrapsBet(bet('come', 10, 6))).toBe(true);
    expect(isCrapsBet(bet('dontcome', 10, 4))).toBe(true);
    expect(isCrapsBet(bet('hard', 10, 8))).toBe(true);
    expect(isCrapsBet(bet('big6'))).toBe(true);
    expect(isCrapsBet(bet('yo'))).toBe(true);
  });

  it('rejects impossible picks', () => {
    expect(isCrapsBet(bet('hard', 10, 5))).toBe(false);
    expect(isCrapsBet(bet('hard'))).toBe(false);
    expect(isCrapsBet(bet('come', 10, 7))).toBe(false);
    expect(isCrapsBet(bet('field', 10, 4))).toBe(false);
    expect(isCrapsBet(bet('place', 10, 3))).toBe(false);
    expect(isCrapsBet({ type: 'horn', amount: 5 })).toBe(false);
  });

  it('validates the shooter fields on the table record', () => {
    expect(isCrapsTableState({ ...initialCrapsState(), shooter: 'p1', lastShooter: 'p2' })).toBe(true);
    expect(isCrapsTableState({ ...initialCrapsState(), shooter: '' })).toBe(false);
    expect(isCrapsTableState({ ...initialCrapsState(), shooter: 7 })).toBe(false);
    expect(isCrapsTableState({ ...initialCrapsState(), lastShooter: 'x'.repeat(200) })).toBe(false);
  });
});

describe('when a bet may go down', () => {
  it('opens the line on the come-out and the come box once a point is on', () => {
    expect(canPlaceBet('pass', null)).toBe(true);
    expect(canPlaceBet('pass', 6)).toBe(false);
    expect(canPlaceBet('come', null)).toBe(false);
    expect(canPlaceBet('come', 6)).toBe(true);
    expect(canPlaceBet('dontcome', 9)).toBe(true);
    expect(canPlaceBet('hard', null)).toBe(true);
  });
});

describe('come and don\'t come', () => {
  it('wins a come bet on a 7 or 11 straight away', () => {
    expect(resolveCrapsBet(bet('come'), 3, 4, 6)).toEqual({ credited: 20, keep: false, outcome: 'win' });
    expect(resolveCrapsBet(bet('come'), 5, 6, 6).credited).toBe(20);
  });

  it('loses a come bet on craps', () => {
    expect(resolveCrapsBet(bet('come'), 1, 1, 6).outcome).toBe('lose');
  });

  it('moves a come bet to the number rolled', () => {
    const r = resolveCrapsBet(bet('come'), 4, 4, 6);
    expect(r.keep).toBe(true);
    expect(r.moved).toEqual({ type: 'come', pick: 8, amount: 10 });
  });

  it('pays a travelled come bet when its number repeats, and loses it on a 7', () => {
    expect(resolveCrapsBet(bet('come', 10, 8), 2, 6, 6).credited).toBe(20);
    expect(resolveCrapsBet(bet('come', 10, 8), 2, 5, 6).outcome).toBe('lose');
    expect(resolveCrapsBet(bet('come', 10, 8), 2, 4, 6).outcome).toBe('stay');
  });

  it('keeps a travelled come bet working on the come-out', () => {
    expect(resolveCrapsBet(bet('come', 10, 5), 2, 3, null).credited).toBe(20);
  });

  it('bars the 12 on don\'t come and pays it on a 7 after it travels', () => {
    expect(resolveCrapsBet(bet('dontcome'), 6, 6, 6)).toEqual({ credited: 10, keep: false, outcome: 'push' });
    expect(resolveCrapsBet(bet('dontcome'), 1, 2, 6).credited).toBe(20);
    expect(resolveCrapsBet(bet('dontcome'), 5, 2, 6).outcome).toBe('lose');
    expect(resolveCrapsBet(bet('dontcome'), 2, 2, 6).moved).toEqual({ type: 'dontcome', pick: 4, amount: 10 });
    expect(resolveCrapsBet(bet('dontcome', 10, 4), 3, 4, 6).credited).toBe(20);
    expect(resolveCrapsBet(bet('dontcome', 10, 4), 1, 3, 6).outcome).toBe('lose');
  });

  it('carries the moved come bet into the next roll\'s felt', () => {
    const { payouts, remaining } = resolveCrapsRound({ p1: [bet('come', 5)] }, 3, 3, 9);
    expect(payouts).toEqual({});
    expect(remaining.p1).toEqual([{ type: 'come', pick: 6, amount: 5 }]);
  });
});

describe('big 6 / big 8', () => {
  it('pays even money and stays up', () => {
    expect(resolveCrapsBet(bet('big6'), 2, 4, null)).toEqual({ credited: 10, keep: true, outcome: 'win' });
    expect(resolveCrapsBet(bet('big8'), 4, 4, 5).credited).toBe(10);
  });

  it('loses to a 7, even on the come-out', () => {
    expect(resolveCrapsBet(bet('big6'), 3, 4, null).outcome).toBe('lose');
    expect(resolveCrapsBet(bet('big8'), 3, 3, 5).outcome).toBe('stay');
  });
});

describe('hardways', () => {
  it('pays 9:1 on a hard 6 or 8 and 7:1 on a hard 4 or 10, then stays up', () => {
    expect(resolveCrapsBet(bet('hard', 10, 6), 3, 3, 5)).toEqual({ credited: 90, keep: true, outcome: 'win' });
    expect(resolveCrapsBet(bet('hard', 10, 8), 4, 4, 5).credited).toBe(90);
    expect(resolveCrapsBet(bet('hard', 10, 4), 2, 2, 5).credited).toBe(70);
    expect(resolveCrapsBet(bet('hard', 10, 10), 5, 5, 5).credited).toBe(70);
  });

  it('loses the easy way and to a 7', () => {
    expect(resolveCrapsBet(bet('hard', 10, 6), 2, 4, 5).outcome).toBe('lose');
    expect(resolveCrapsBet(bet('hard', 10, 6), 2, 5, 5).outcome).toBe('lose');
  });

  it('is off on the come-out', () => {
    expect(resolveCrapsBet(bet('hard', 10, 6), 3, 3, null).outcome).toBe('stay');
    expect(resolveCrapsBet(bet('hard', 10, 6), 3, 4, null).outcome).toBe('stay');
  });
});

describe('one-roll propositions', () => {
  it('pays 30:1 on two and twelve and 15:1 on three and eleven', () => {
    expect(resolveCrapsBet(bet('two'), 1, 1, null).credited).toBe(310);
    expect(resolveCrapsBet(bet('twelve'), 6, 6, 4).credited).toBe(310);
    expect(resolveCrapsBet(bet('three'), 1, 2, 4).credited).toBe(160);
    expect(resolveCrapsBet(bet('yo'), 5, 6, null).credited).toBe(160);
  });

  it('comes off the felt when it misses', () => {
    expect(resolveCrapsBet(bet('yo'), 5, 5, null)).toEqual({ credited: 0, keep: false, outcome: 'lose' });
  });
});

describe('the existing felt still pays the same', () => {
  it('pays place bets on the full stack', () => {
    const one: CrapsBet = { type: 'place', pick: 6, amount: 1 };
    const { payouts } = resolveCrapsRound({ p: [one, one, one, one, one, one] }, 3, 3, 5);
    expect(payouts.p).toBe(7);
  });

  it('labels the new bets in plain words', () => {
    expect(crapsBetLabel(bet('come'))).toBe('COME');
    expect(crapsBetLabel(bet('come', 1, 9))).toBe('COME 9');
    expect(crapsBetLabel(bet('hard', 1, 8))).toBe('HARD 8');
    expect(crapsBetLabel(bet('yo'))).toBe('YO 11');
  });
});

describe('the shooter ring', () => {
  const seated = [
    { pid: 'a', angle: 0.1 },
    { pid: 'b', angle: 1.5 },
    { pid: 'c', angle: 3.0 },
  ];

  it('passes the dice clockwise from the last shooter', () => {
    expect(pickShooter(seated, () => true, 'a')).toBe('b');
    expect(pickShooter(seated, () => true, 'c')).toBe('a');
  });

  it('skips players without a line bet', () => {
    expect(pickShooter(seated, (p) => p !== 'b', 'a')).toBe('c');
  });

  it('lets a lone eligible player keep shooting', () => {
    expect(pickShooter(seated, (p) => p === 'a', 'a')).toBe('a');
  });

  it('starts from the first stand when the last shooter has gone', () => {
    expect(pickShooter(seated, () => true, 'gone')).toBe('a');
    expect(pickShooter(seated, () => true)).toBe('a');
  });

  it('hands the dice to the stickman when nobody may shoot', () => {
    expect(pickShooter(seated, () => false, 'a')).toBeNull();
    expect(pickShooter([], () => true)).toBeNull();
  });

  it('needs a pass or don\'t pass bet to shoot', () => {
    expect(hasLineBet([bet('field'), bet('place', 5, 6)])).toBe(false);
    expect(hasLineBet([bet('dontpass')])).toBe(true);
  });
});

describe('pointWasOn', () => {
  const settled = (point: number | null, result: number, sevenOut = false) => ({ point, result, sevenOut });
  it('reads the point in force before a settled roll', () => {
    expect(pointWasOn(settled(6, 6))).toBe(false); // come-out set the point
    expect(pointWasOn(settled(null, 6))).toBe(true); // the point was made
    expect(pointWasOn(settled(8, 5))).toBe(true); // a roll that decided nothing
    expect(pointWasOn(settled(null, 7, true))).toBe(true); // seven-out
    expect(pointWasOn(settled(null, 7))).toBe(false); // come-out natural
    expect(pointWasOn(settled(null, 12))).toBe(false); // come-out craps
    expect(pointWasOn(settled(9, 2))).toBe(true); // craps with a point on
  });
});
