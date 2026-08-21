/**
 * Poker (heads-up NL Hold'em) tests — hand ranking against a golden table,
 * betting state-machine transitions, showdown resolution, and shape-guard.
 */

import { describe, expect, it } from 'vitest';
import { cardOf } from './cards';
import {
  applyPokerAction, beginPoker, callAmount, chooseBotAction, compareHands,
  evaluate5, evaluate7, evaluateBest, initialPokerState, isPokerState,
  legalActions, nextHand, readVisiblePokerState,
} from './poker';
import type { PokerState } from './poker';

const c = (suit: 0 | 1 | 2 | 3, rank: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14) => cardOf(suit, rank);

describe('poker: hand ranking table', () => {
  it('categorises every category', () => {
    // Royal / straight-flush.
    const sf = evaluate5([c(0, 10), c(0, 11), c(0, 12), c(0, 13), c(0, 14)]);
    expect(sf.category).toBe('straight-flush');
    expect(sf.categoryRank).toBe(8);

    // Wheel straight-flush (A-2-3-4-5 of clubs).
    const wsf = evaluate5([c(0, 14), c(0, 2), c(0, 3), c(0, 4), c(0, 5)]);
    expect(wsf.category).toBe('straight-flush');
    expect(wsf.tiebreak[0]).toBe(5); // wheel high = 5

    // Four-of-a-kind.
    const four = evaluate5([c(0, 9), c(1, 9), c(2, 9), c(3, 9), c(0, 2)]);
    expect(four.category).toBe('four-of-a-kind');

    // Full house.
    const full = evaluate5([c(0, 8), c(1, 8), c(2, 8), c(3, 4), c(0, 4)]);
    expect(full.category).toBe('full-house');

    // Flush.
    const flush = evaluate5([c(2, 3), c(2, 6), c(2, 9), c(2, 11), c(2, 14)]);
    expect(flush.category).toBe('flush');

    // Straight.
    const str = evaluate5([c(0, 5), c(1, 6), c(2, 7), c(3, 8), c(0, 9)]);
    expect(str.category).toBe('straight');
    expect(str.tiebreak[0]).toBe(9);

    // Wheel straight (not flush).
    const wheel = evaluate5([c(0, 14), c(1, 2), c(2, 3), c(3, 4), c(0, 5)]);
    expect(wheel.category).toBe('straight');
    expect(wheel.tiebreak[0]).toBe(5);

    // Three of a kind.
    const trip = evaluate5([c(0, 7), c(1, 7), c(2, 7), c(3, 2), c(0, 3)]);
    expect(trip.category).toBe('three-of-a-kind');

    // Two pair.
    const twop = evaluate5([c(0, 10), c(1, 10), c(2, 3), c(3, 3), c(0, 5)]);
    expect(twop.category).toBe('two-pair');
    expect(twop.tiebreak).toEqual([10, 3, 5]);

    // Pair.
    const pair = evaluate5([c(0, 12), c(1, 12), c(2, 5), c(3, 8), c(0, 2)]);
    expect(pair.category).toBe('pair');

    // High card.
    const hc = evaluate5([c(0, 2), c(1, 4), c(2, 7), c(3, 11), c(0, 14)]);
    expect(hc.category).toBe('high-card');
    expect(hc.tiebreak).toEqual([14, 11, 7, 4, 2]);
  });

  it('orders categories correctly', () => {
    const sf = evaluate5([c(0, 10), c(0, 11), c(0, 12), c(0, 13), c(0, 14)]);
    const four = evaluate5([c(0, 9), c(1, 9), c(2, 9), c(3, 9), c(0, 2)]);
    const full = evaluate5([c(0, 8), c(1, 8), c(2, 8), c(3, 4), c(0, 4)]);
    const flush = evaluate5([c(2, 3), c(2, 6), c(2, 9), c(2, 11), c(2, 14)]);
    const str = evaluate5([c(0, 5), c(1, 6), c(2, 7), c(3, 8), c(0, 9)]);
    const trip = evaluate5([c(0, 7), c(1, 7), c(2, 7), c(3, 2), c(0, 3)]);
    const twop = evaluate5([c(0, 10), c(1, 10), c(2, 3), c(3, 3), c(0, 5)]);
    const pair = evaluate5([c(0, 12), c(1, 12), c(2, 5), c(3, 8), c(0, 2)]);
    const hc = evaluate5([c(0, 2), c(1, 4), c(2, 7), c(3, 11), c(0, 14)]);
    const ordered = [sf, four, full, flush, str, trip, twop, pair, hc];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareHands(ordered[i], ordered[i + 1])).toBeGreaterThan(0);
    }
  });

  it('tiebreaks pairs by kicker', () => {
    const kk_a = evaluate5([c(0, 13), c(1, 13), c(2, 14), c(3, 5), c(0, 2)]);
    const kk_q = evaluate5([c(2, 13), c(3, 13), c(0, 12), c(1, 5), c(0, 2)]);
    expect(compareHands(kk_a, kk_q)).toBeGreaterThan(0);
  });

  it('evaluate7 picks the best 5', () => {
    // Hole: A♣ K♣, Board: Q♣ J♣ 10♣ 2♦ 3♥ → royal flush.
    const h = evaluate7([c(0, 14), c(0, 13), c(0, 12), c(0, 11), c(0, 10), c(1, 2), c(2, 3)]);
    expect(h.category).toBe('straight-flush');
    expect(h.tiebreak[0]).toBe(14);
  });
});

describe('poker: betting state machine', () => {
  function fresh(seed = 100): PokerState {
    return beginPoker(initialPokerState(seed), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
  }

  it('deal posts blinds and BUTTON acts first preflop', () => {
    const s = fresh();
    expect(s.status).toBe('playing');
    expect(s.street).toBe('preflop');
    expect(s.toAct).toBe('button');
    expect(s.players.button.streetBet).toBe(5);   // SB
    expect(s.players.bigBlind.streetBet).toBe(10); // BB
    expect(s.pot).toBe(15);
    expect(s.currentBet).toBe(10);
    expect(s.community.length).toBe(0);
    // Hole cards dealt.
    expect(s.players.button.holeCards).not.toBeNull();
    expect(s.players.bigBlind.holeCards).not.toBeNull();
  });

  it('legalActions reflects the current situation', () => {
    const s = fresh();
    // Button facing a 10 raise (BB) with 5 in — needs to call 5 or fold or raise.
    expect(legalActions(s, 'button').sort()).toEqual(['call', 'fold', 'raise'].sort());
    // Big blind can't act — not their turn.
    expect(legalActions(s, 'bigBlind')).toEqual([]);
  });

  it('call/check sequence through a full flop', () => {
    let s = fresh();
    // Button calls preflop.
    s = applyPokerAction(s, { seat: 'button', kind: 'call' });
    expect(s.toAct).toBe('bigBlind');
    expect(s.pot).toBe(20);
    expect(s.players.button.streetBet).toBe(10); // matched
    // Big blind checks their option (limped pot).
    s = applyPokerAction(s, { seat: 'bigBlind', kind: 'check' });
    // Street closes, community[3] dealt, BB acts first postflop.
    expect(s.street).toBe('flop');
    expect(s.community.length).toBe(3);
    expect(s.toAct).toBe('bigBlind');
    expect(s.currentBet).toBe(0);
  });

  it('raise then call moves the pot correctly', () => {
    let s = fresh();
    // Button raises to 30.
    s = applyPokerAction(s, { seat: 'button', kind: 'raise', amount: 30 });
    expect(s.currentBet).toBe(30);
    expect(s.pot).toBe(40); // SB 5 → +25 to reach 30; +10 BB → 5+30+10 = 45 wait
    // Actually: pot was 15 (SB 5 + BB 10). Button's total street bet becomes 30,
    // delta = 30 - 5 = 25. So pot = 15 + 25 = 40. Good.
    expect(s.toAct).toBe('bigBlind');
    // BB calls the raise.
    s = applyPokerAction(s, { seat: 'bigBlind', kind: 'call' });
    // BB adds 20 to match 30. Pot = 40 + 20 = 60. Street closes → flop.
    expect(s.pot).toBe(60);
    expect(s.street).toBe('flop');
  });

  it('fold ends the hand and awards pot to opponent', () => {
    let s = fresh();
    const startingBB = s.players.bigBlind.stack;
    // Button folds preflop.
    s = applyPokerAction(s, { seat: 'button', kind: 'fold' });
    expect(s.status).toBe('hand-over');
    // Big blind gets the pot (SB + BB = 15).
    expect(s.players.bigBlind.stack).toBe(startingBB + 15);
    expect(s.lastShowdown?.winner).toBe('bigBlind');
  });

  it('rejects illegal actions (unchanged state)', () => {
    const s = fresh();
    // Big blind acts out of turn.
    const t = applyPokerAction(s, { seat: 'bigBlind', kind: 'check' });
    expect(t).toBe(s);
    // Button checks when facing 10 raise — illegal.
    const u = applyPokerAction(s, { seat: 'button', kind: 'check' });
    expect(u).toBe(s);
    // Button raises to 5 — below current bet.
    const v = applyPokerAction(s, { seat: 'button', kind: 'raise', amount: 5 });
    expect(v).toBe(s);
    // Bet when there's already a bet — must raise.
    const w = applyPokerAction(s, { seat: 'button', kind: 'bet', amount: 40 });
    expect(w).toBe(s);
  });

  it('nextHand rotates the button', () => {
    let s = fresh();
    s = applyPokerAction(s, { seat: 'button', kind: 'fold' });
    expect(s.status).toBe('hand-over');
    const buttonId = s.players.button.id;
    const bigBlindId = s.players.bigBlind.id;
    const next = nextHand(s, s.seed + 1);
    // Ids swap seats (button holder rotates).
    expect(next.players.button.id).toBe(bigBlindId);
    expect(next.players.bigBlind.id).toBe(buttonId);
    expect(next.status).toBe('playing');
    expect(next.street).toBe('preflop');
    expect(next.handsPlayed).toBe(1);
  });

  it('callAmount computes what a seat still needs', () => {
    const s = fresh();
    expect(callAmount(s, 'button')).toBe(5);
    expect(callAmount(s, 'bigBlind')).toBe(0);
  });
});

describe('poker: showdown / hand-over integration', () => {
  it('runs to showdown when both players go all-in', () => {
    // Force a small stack scenario by starting with 30 chips each.
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 30, bot: false,
    });
    // Button raises all-in (25 more on top of the 5 SB = 30 total).
    s = applyPokerAction(s, { seat: 'button', kind: 'raise', amount: 30 });
    expect(s.players.button.allIn).toBe(true);
    // BB calls all-in (they had 20 left after the 10 blind).
    s = applyPokerAction(s, { seat: 'bigBlind', kind: 'call' });
    // Both all-in — engine runs streets to river and awards pot. The end
    // status is terminal (hand-over on a split; match-over if one player
    // busts). Either outcome is valid heads-up when both players are all-in
    // for their entire stack.
    expect(['hand-over', 'match-over']).toContain(s.status);
    expect(s.street).toBe('complete');
    expect(s.community.length).toBe(5); // all streets dealt
    expect(s.lastShowdown).not.toBeNull();
    // Pot ≤ 60 (30 each), stacks total = 60 (chips are conserved).
    expect(s.players.button.stack + s.players.bigBlind.stack).toBe(60);
  });
});

describe('poker: visibility (read-side hole cards)', () => {
  it('hides opponent cards for the viewer', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    const viewedByB = readVisiblePokerState(s, 'B');
    expect(viewedByB.players.button.holeCards).not.toBeNull();
    expect(viewedByB.players.bigBlind.holeCards).toBeNull();
    const spectator = readVisiblePokerState(s, 'Spec');
    expect(spectator.players.button.holeCards).toBeNull();
    expect(spectator.players.bigBlind.holeCards).toBeNull();
  });

  it('reveals both hands at showdown', () => {
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 30,
    });
    s = applyPokerAction(s, { seat: 'button', kind: 'raise', amount: 30 });
    s = applyPokerAction(s, { seat: 'bigBlind', kind: 'call' });
    // Now hand-over / showdown complete.
    const visible = readVisiblePokerState(s, 'someoneElse');
    expect(visible.players.button.holeCards).not.toBeNull();
    expect(visible.players.bigBlind.holeCards).not.toBeNull();
  });
});

describe('poker: shape guard', () => {
  it('accepts a fresh dealt state', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    expect(isPokerState(s)).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isPokerState(null)).toBe(false);
    expect(isPokerState({ kind: 'chess' })).toBe(false);
  });

  it('rejects bad hole cards', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    const bad = {
      ...s,
      players: {
        ...s.players,
        button: { ...s.players.button, holeCards: [99, 0] },
      },
    };
    expect(isPokerState(bad)).toBe(false);
  });

  it('rejects negative stacks', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    const bad = {
      ...s,
      players: {
        ...s.players,
        button: { ...s.players.button, stack: -5 },
      },
    };
    expect(isPokerState(bad)).toBe(false);
  });

  // Regression for the doc-boundary MAJOR: previously isPokerState never
  // validated s.lastShowdown, so a hostile peer writing an object with an
  // invalid winner ('not-a-seat') would slip through, and the devices.ts
  // render path would deref `s.players['not-a-seat'].id` → TypeError.
  it('accepts a state with lastShowdown null (initial state)', () => {
    const s = initialPokerState(1);
    expect(s.lastShowdown).toBeNull();
    expect(isPokerState(s)).toBe(true);
  });

  it('accepts a state with a valid lastShowdown after fold', () => {
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    s = applyPokerAction(s, { seat: 'button', kind: 'fold' });
    expect(s.status).toBe('hand-over');
    expect(s.lastShowdown).not.toBeNull();
    expect(isPokerState(s)).toBe(true);
  });

  it('rejects lastShowdown with an invalid winner seat', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    const bad = {
      ...s,
      status: 'hand-over',
      lastShowdown: { winner: 'not-a-seat', pot: 0, buttonHand: null, bigBlindHand: null },
    };
    expect(isPokerState(bad)).toBe(false);
  });

  it('rejects lastShowdown that is not an object', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    // A stray primitive (or the field omitted entirely, since it's required).
    expect(isPokerState({ ...s, lastShowdown: 42 })).toBe(false);
    expect(isPokerState({ ...s, lastShowdown: 'hand-over' })).toBe(false);
    // Undefined = the field was omitted → not the declared shape.
    const omitted = { ...s } as Record<string, unknown>;
    delete omitted.lastShowdown;
    expect(isPokerState(omitted)).toBe(false);
  });

  it('rejects lastShowdown with a non-integer pot', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    const bad = {
      ...s,
      status: 'hand-over',
      lastShowdown: { winner: 'button', pot: 'DELETE', buttonHand: null, bigBlindHand: null },
    };
    expect(isPokerState(bad)).toBe(false);
  });

  it('rejects lastShowdown with a malformed buttonHand', () => {
    const s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    const bad = {
      ...s,
      status: 'hand-over',
      lastShowdown: {
        winner: 'button', pot: 0,
        buttonHand: { category: 'not-a-category', categoryRank: 99, tiebreak: 'nope', best5: [] },
        bigBlindHand: null,
      },
    };
    expect(isPokerState(bad)).toBe(false);
  });
});

describe('poker: evaluateBest handles 5..7 cards without padding', () => {
  // Regression for the padCards MINOR: holeStrength used to pad the community
  // with duplicates of community[0] to reach 7 cards, so evaluate7's C(7,5)
  // combos included samples with 3 copies of the same card — evaluate5 has no
  // dedup, so it reported false trips/full-house on any high-card board.
  // evaluateBest evaluates from the REAL card set (no padding) instead.
  it('is equivalent to evaluate5 on exactly 5 cards', () => {
    const cards = [c(0, 10), c(0, 11), c(0, 12), c(0, 13), c(0, 14)];
    const a = evaluateBest(cards);
    const b = evaluate5(cards);
    expect(a.category).toBe(b.category);
    expect(a.categoryRank).toBe(b.categoryRank);
    expect(a.tiebreak).toEqual(b.tiebreak);
  });

  it('is equivalent to evaluate7 on exactly 7 cards', () => {
    const cards = [c(0, 14), c(0, 13), c(0, 12), c(0, 11), c(0, 10), c(1, 2), c(2, 3)];
    const a = evaluateBest(cards);
    const b = evaluate7(cards);
    expect(a.category).toBe(b.category);
    expect(a.categoryRank).toBe(b.categoryRank);
    expect(a.tiebreak).toEqual(b.tiebreak);
  });

  it('picks the best straight from 6 cards (turn = 2 hole + 4 community)', () => {
    // Hole: 9♠ 8♠, Board: 7♥ 6♦ 5♣ 2♠ → straight to 9.
    const h = evaluateBest([c(3, 9), c(3, 8), c(2, 7), c(1, 6), c(0, 5), c(3, 2)]);
    expect(h.category).toBe('straight');
    expect(h.tiebreak[0]).toBe(9);
  });

  it('does NOT report trips from a single high community card (flop, 5 cards)', () => {
    // The audit's failure scenario: community=[A♣,5♦,2♠], hole=[K♥,7♦].
    // Real best-5-of-5 is high-card ace-king. Padding used to lift this to
    // trips because 3 copies of A♣ appeared in some C(7,5) combo. Not any more.
    const community = [c(0, 14), c(1, 5), c(3, 2)]; // A♣ 5♦ 2♠
    const hole = [c(2, 13), c(1, 7)];               // K♥ 7♦
    const h = evaluateBest([...hole, ...community]);
    expect(h.category).toBe('high-card');
    expect(h.categoryRank).toBe(0);
  });

  it('rejects too-few or too-many cards', () => {
    expect(() => evaluateBest([c(0, 2), c(0, 3), c(0, 4), c(0, 5)])).toThrow();
    expect(() => evaluateBest([
      c(0, 2), c(0, 3), c(0, 4), c(0, 5), c(0, 6), c(0, 7), c(0, 8), c(0, 9),
    ])).toThrow();
  });

  it('bot no longer over-raises high-card-with-community-ace boards', () => {
    // Direct end-to-end check of the padCards regression at the bot level.
    // Set up a hand-in-progress where the bot (bigBlind) faces a check-through
    // to the flop with a weak high-card hand and a community ace: previously
    // the bot inflated this to trips-category strength and raised. Now it
    // sees plain high-card and takes the cheap check.
    let s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'flop',
      players: {
        button: {
          id: 'A', stack: 990, streetBet: 0, handBet: 10,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: false,
        },
        bigBlind: {
          id: null, stack: 990, streetBet: 0, handBet: 10,
          holeCards: [c(2, 13), c(1, 7)], folded: false, allIn: false, // K♥ 7♦
        },
      },
      community: [c(0, 14), c(1, 5), c(3, 2)], // A♣ 5♦ 2♠
      toAct: 'bigBlind',
      currentBet: 0,
      minRaise: 10,
      pot: 20,
      deck: [c(2, 8), c(3, 9)],
      actions: [],
      bot: true,
    };
    // Sanity: fresh state passes the shape guard.
    expect(isPokerState(s)).toBe(true);
    const action = chooseBotAction(s, 'bigBlind');
    // Weak hand on a checked flop — should check, never bet/raise.
    expect(action?.kind === 'check' || action?.kind === 'fold').toBe(true);
  });
});

describe('poker: fold does not expose the folder\'s cards', () => {
  // Regression for the NOTE finding — after awardUncontested, street='complete'
  // used to reveal BOTH holeCards via readVisiblePokerState. Standard poker
  // mucks the folder's hand.
  it('spectators do not see the folder\'s hole cards after a fold', () => {
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    s = applyPokerAction(s, { seat: 'button', kind: 'fold' });
    const spec = readVisiblePokerState(s, 'someoneElse');
    expect(spec.players.button.folded).toBe(true);
    expect(spec.players.button.holeCards).toBeNull(); // mucked
    // Winner's cards remain visible (see doc comment — the raw doc already
    // holds them, and the demo felt keeps the recap informative).
    expect(spec.players.bigBlind.holeCards).not.toBeNull();
  });

  it('the folder still sees their own hole cards after folding', () => {
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000,
    });
    s = applyPokerAction(s, { seat: 'button', kind: 'fold' });
    // The player who folded is still 'B' — their view keeps their own cards.
    const own = readVisiblePokerState(s, 'B');
    expect(own.players.button.holeCards).not.toBeNull();
  });

  it('a non-fold showdown still reveals both hands (regression guard for the fix)', () => {
    // Both go all-in, run to showdown, no fold. Both hands must remain visible.
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 30,
    });
    s = applyPokerAction(s, { seat: 'button', kind: 'raise', amount: 30 });
    s = applyPokerAction(s, { seat: 'bigBlind', kind: 'call' });
    const spec = readVisiblePokerState(s, 'someoneElse');
    expect(spec.players.button.holeCards).not.toBeNull();
    expect(spec.players.bigBlind.holeCards).not.toBeNull();
  });
});

describe('poker: determinism', () => {
  it('same seed → same deal', () => {
    const a = beginPoker(initialPokerState(2027), { button: 'B', bigBlind: 'W' });
    const b = beginPoker(initialPokerState(2027), { button: 'B', bigBlind: 'W' });
    expect(a.players.button.holeCards).toEqual(b.players.button.holeCards);
    expect(a.players.bigBlind.holeCards).toEqual(b.players.bigBlind.holeCards);
    expect(a.deck).toEqual(b.deck);
  });
});
