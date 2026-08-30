/**
 * Poker (heads-up NL Hold'em) tests — hand ranking against a golden table,
 * betting state-machine transitions, showdown resolution, and shape-guard.
 */

import { describe, expect, it } from 'vitest';
import { cardOf } from './cards';
import {
  applyPokerAction, beginPoker, callAmount, chooseBotAction, compareHands,
  dealHand, evaluate5, evaluate7, evaluateBest, initialPokerState,
  isPokerState, legalActions, nextHand, pokerForfeit,
  readVisiblePokerState,
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
      // Enough remaining deck to safely open the turn (burn+card=2) and the
      // river (burn+card=2) — the new isPokerState per-street guard requires
      // deck.length >= 4 on flop so a hostile peer can't plant a short-deck
      // state that would drive dealCommunity to shift undefined.
      deck: [c(2, 8), c(3, 9), c(2, 10), c(3, 11)],
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

// ── Round-2 audit regressions (MAJOR / MAJOR / MINOR) ───────────────────────

describe('poker: chooseBotAction never emits an action applyPokerAction will reject', () => {
  // Round-2 audit finding #1 (MAJOR). Before this fix the bot unconditionally
  // returned `kind: 'bet'` when `canCheck` was true — but the canonical case
  // for `canCheck` in the BB seat preflop is "the button already limped, so my
  // streetBet (=BB=10) matches the standing bet (=10)". The 'bet' handler
  // rejects when currentBet !== 0 ("must raise instead"), the bot pump then
  // re-fires the same rejected action every 0.9s, and the whole hand freezes
  // in the doc with no UI signal (only RESET recovers). Triggered by any pair
  // 66+ or AKs (holeStrength ≥ 0.65) preflop after a button-call, which
  // happens within a handful of hands. The bot must instead emit an action
  // the state machine actually accepts.
  it('BB with a strong pair does not emit rejected bet after a button-limp preflop', () => {
    // Deterministic in-progress preflop state: BB posted 10, button called
    // to match (streetBet 10 each, currentBet 10, callAmount(BB) = 0, so the
    // bot's canCheck path fires). Give BB a pocket queen (strength ≥ 0.65).
    const s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'preflop',
      players: {
        button: {
          id: 'A', stack: 990, streetBet: 10, handBet: 10,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: false,
        },
        bigBlind: {
          id: null, stack: 990, streetBet: 10, handBet: 10,
          holeCards: [c(2, 12), c(3, 12)], folded: false, allIn: false, // QQ
        },
      },
      community: [],
      toAct: 'bigBlind',
      currentBet: 10,
      minRaise: 10,
      pot: 20,
      deck: [c(0, 2), c(0, 3), c(0, 4), c(0, 5), c(0, 6), c(0, 7), c(0, 8), c(0, 9)],
      actions: [{ seat: 'button', kind: 'call', amount: 5, street: 'preflop' }],
      bot: true,
    };
    expect(isPokerState(s)).toBe(true);
    const action = chooseBotAction(s, 'bigBlind');
    expect(action).not.toBeNull();
    // A raise is the correct action here. Critically: the action must NOT be
    // rejected by applyPokerAction (which is how the pre-fix deadlock
    // presented — same input in and same input out, forever).
    expect(action?.kind).not.toBe('bet'); // 'bet' would be rejected here
    const next = applyPokerAction(s, action!);
    expect(next).not.toBe(s); // action was accepted → state advanced
  });

  it('takes the free check when the opponent is already all-in', () => {
    // Extension of the fix (see chooseBotAction opponentCanRespond gate): an
    // opponent who is all-in or folded can't call a raise, so a raise into
    // them just piles chips into an uncontested pot. The bot should check.
    const s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'flop',
      players: {
        button: {
          id: 'A', stack: 0, streetBet: 0, handBet: 30,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: true, // all-in
        },
        bigBlind: {
          id: null, stack: 970, streetBet: 0, handBet: 30,
          holeCards: [c(2, 12), c(3, 12)], folded: false, allIn: false, // QQ
        },
      },
      community: [c(0, 14), c(1, 5), c(3, 2)],
      toAct: 'bigBlind',
      currentBet: 0,
      minRaise: 10,
      pot: 60,
      // Same per-street guard requirement as the flop test above: deck must
      // hold enough cards to open the remaining streets.
      deck: [c(0, 6), c(0, 7), c(0, 8), c(0, 9)],
      actions: [],
      bot: true,
    };
    expect(isPokerState(s)).toBe(true);
    const action = chooseBotAction(s, 'bigBlind');
    // Free-check: the bot must not pump chips into an uncontestable pot.
    expect(action?.kind).toBe('check');
  });
});

describe('poker: dealHand handles all-in-from-blinds without deadlocking', () => {
  // Round-2 audit finding #2 (MAJOR). Before this fix, `dealHand` capped SB/BB
  // at each poster's stack and marked them `allIn = true` when the stack hit
  // zero — then unconditionally set `toAct: 'button'`. If button.stack ≤ SB,
  // button is all-in from posting but toAct=button; applyPokerAction's
  // `if (p.allIn) return state` guard silently rejects every action they
  // attempt, and the opposite seat never gets a turn — hand freezes, RESET
  // only. Reachable via natural chip-bleed over a long match. legalActions
  // still returned ['fold','check'/'call'] so the UI showed enabled buttons
  // that no-op'd.
  it('button.stack <= smallBlind: button goes all-in, toAct passes to bigBlind', () => {
    const s0: PokerState = {
      ...beginPoker(initialPokerState(1), {
        button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
      }),
    };
    // Force the drained scenario at a fresh hand seam. `handsPlayed = 0`
    // keeps the SB seat = button (no rotation).
    const drained: PokerState = {
      ...s0,
      players: {
        button: { ...s0.players.button, stack: 3, streetBet: 0, handBet: 0, folded: false, allIn: false },
        bigBlind: { ...s0.players.bigBlind, stack: 1000, streetBet: 0, handBet: 0, folded: false, allIn: false },
      },
      status: 'hand-over',
      handsPlayed: 0,
    };
    const dealt = dealHand(drained);
    // Post-fix expectations (also asserting round-3 unmatched-blind refund).
    expect(dealt.status).toBe('playing');
    expect(dealt.players.button.allIn).toBe(true);    // all-in from SB
    expect(dealt.players.button.stack).toBe(0);
    expect(dealt.players.bigBlind.allIn).toBe(false); // still has stack
    // toAct is bigBlind (they hold the fold-or-continue decision).
    expect(dealt.toAct).toBe('bigBlind');
    // currentBet is min(sb-post, bb-post) = 3 (matched cap after refund of
    // the 7 chips BB posted that button couldn't match). Pre-round-3 this
    // was 10 with pot=13 — a 3-chip winner could walk with 13 chips they
    // never contested against. See dealHand refund block.
    expect(dealt.currentBet).toBe(3);
    expect(dealt.pot).toBe(6);
    expect(dealt.players.bigBlind.stack).toBe(997); // 1000 - 3 posted
  });

  it('deadlocked-case: bigBlind can now advance the hand end-to-end', () => {
    // Drive the fix through to terminal state — the pre-fix hang manifested
    // here (every action from any seat rejected).
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const drained: PokerState = {
      ...s0,
      players: {
        button: { ...s0.players.button, stack: 3, streetBet: 0, handBet: 0, folded: false, allIn: false },
        bigBlind: { ...s0.players.bigBlind, stack: 1000, streetBet: 0, handBet: 0, folded: false, allIn: false },
      },
      status: 'hand-over',
      handsPlayed: 0,
    };
    let dealt = dealHand(drained);
    // A single check from BB must close the street (opponent-can-act gate)
    // and cascade through the community deal to terminal state.
    dealt = applyPokerAction(dealt, { seat: 'bigBlind', kind: 'check' });
    expect(['hand-over', 'match-over']).toContain(dealt.status);
    expect(dealt.street).toBe('complete');
    expect(dealt.community.length).toBe(5); // ran all community cards
    expect(dealt.lastShowdown).not.toBeNull();
  });

  it('bigBlind.stack <= bigBlind: BB all-in from BB, button can still act', () => {
    // Symmetric edge: BB is drained, button has stack. `toAct` stays on
    // button (default heads-up rule); the opponent-can-act gate closes the
    // street after button's check so the hand runs out.
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const drained: PokerState = {
      ...s0,
      players: {
        button: { ...s0.players.button, stack: 1000, streetBet: 0, handBet: 0, folded: false, allIn: false },
        bigBlind: { ...s0.players.bigBlind, stack: 5, streetBet: 0, handBet: 0, folded: false, allIn: false },
      },
      status: 'hand-over',
      handsPlayed: 0,
    };
    let dealt = dealHand(drained);
    expect(dealt.players.bigBlind.allIn).toBe(true);
    expect(dealt.players.bigBlind.stack).toBe(0);
    expect(dealt.toAct).toBe('button');
    // callAmount(button) = 0 (both posted 5), so a check is legal.
    dealt = applyPokerAction(dealt, { seat: 'button', kind: 'check' });
    expect(['hand-over', 'match-over']).toContain(dealt.status);
    expect(dealt.street).toBe('complete');
    expect(dealt.community.length).toBe(5);
  });

  it('both all-in from blinds (with refund): matched at 3, BB retains 2 residual, closes on a check', () => {
    // Round-3 unmatched-blind refund changes the shape here: BB posts 5
    // (all-in), refund is 5-3=2 → BB.stack=2, streetBet=3, allIn=false.
    // The matched pot is 3+3=6, and BB now holds a fold-or-continue decision
    // (opponent all-in, but BB technically has 2 chips left that they can
    // walk away with by folding). A single check from BB closes preflop
    // (opponent-can-act gate) and cascades to showdown.
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const drained: PokerState = {
      ...s0,
      players: {
        button: { ...s0.players.button, stack: 3, streetBet: 0, handBet: 0, folded: false, allIn: false },
        bigBlind: { ...s0.players.bigBlind, stack: 5, streetBet: 0, handBet: 0, folded: false, allIn: false },
      },
      status: 'hand-over',
      handsPlayed: 0,
    };
    let dealt = dealHand(drained);
    expect(dealt.players.button.allIn).toBe(true);
    expect(dealt.players.button.stack).toBe(0);
    expect(dealt.players.bigBlind.allIn).toBe(false); // refunded 2 → 2 residual
    expect(dealt.players.bigBlind.stack).toBe(2);
    expect(dealt.currentBet).toBe(3);
    expect(dealt.pot).toBe(6);
    expect(dealt.toAct).toBe('bigBlind');
    expect(dealt.status).toBe('playing');
    // Close preflop with BB's check → showdown.
    dealt = applyPokerAction(dealt, { seat: 'bigBlind', kind: 'check' });
    expect(['hand-over', 'match-over']).toContain(dealt.status);
    expect(dealt.street).toBe('complete');
    expect(dealt.community.length).toBe(5);
    // Chips conserved: 3 + 5 = 8 total across both stacks post-showdown
    // (BB's 2 residual chips plus the 6-chip pot both accounted for).
    expect(dealt.players.button.stack + dealt.players.bigBlind.stack).toBe(8);
  });

  it('shape guard still accepts every dealt corner-case state', () => {
    // Round-2 audit callout: dealt state must still validate — otherwise a
    // peer receiving it via LWW would reject the read.
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    for (const [buttonStack, bigBlindStack] of [
      [3, 1000], [1000, 5], [3, 5], [8, 1000], [1000, 8],
    ] as const) {
      const drained: PokerState = {
        ...s0,
        players: {
          button: { ...s0.players.button, stack: buttonStack, streetBet: 0, handBet: 0, folded: false, allIn: false },
          bigBlind: { ...s0.players.bigBlind, stack: bigBlindStack, streetBet: 0, handBet: 0, folded: false, allIn: false },
        },
        status: 'hand-over',
        handsPlayed: 0,
      };
      const dealt = dealHand(drained);
      expect(isPokerState(dealt)).toBe(true);
    }
  });
});

describe('poker: pokerForfeit awards the pot as well as the residual stack', () => {
  // Round-2 audit finding #3 (MINOR). The old inline forfeit in devices.ts
  // moved the forfeiter's remaining stack to the opponent and set
  // match-over, but never awarded `state.pot`. A mid-hand rage-quit therefore
  // left the SB+BB (≥ 15 chips) orphaned in the terminal state — the recap
  // announced the winner "takes the stack" while the pot chips sat
  // unaccounted for. Correct escape hatch: award the pot first (as if the
  // forfeiter folded), then transfer the residual stack.
  it('mid-hand forfeit: opponent receives BOTH the pot and the residual stack', () => {
    // Fresh deal — button posts SB=5, BB posts 10, pot=15.
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const buttonStackBefore = s0.players.button.stack; // 995 after SB
    const bigBlindStackBefore = s0.players.bigBlind.stack; // 990 after BB
    const potBefore = s0.pot; // 15
    expect(potBefore).toBeGreaterThanOrEqual(15);
    const forfeited = pokerForfeit(s0, 'button');
    expect(forfeited.status).toBe('match-over');
    expect(forfeited.street).toBe('complete');
    expect(forfeited.toAct).toBeNull();
    // Chip conservation across the transition — every chip on the table
    // must live either in the winner's stack or (transiently) in state.pot.
    expect(forfeited.pot).toBe(0);
    // Opponent receives: their prior stack + the pot + the forfeiter's stack.
    expect(forfeited.players.bigBlind.stack).toBe(
      bigBlindStackBefore + potBefore + buttonStackBefore,
    );
    expect(forfeited.players.button.stack).toBe(0);
    // Recap reports the opponent as the winner of the abandoned pot.
    expect(forfeited.lastShowdown?.winner).toBe('bigBlind');
    expect(forfeited.lastShowdown?.pot).toBe(potBefore);
    // Terminal state still passes the shape guard.
    expect(isPokerState(forfeited)).toBe(true);
  });

  it('chip conservation over a forfeit round-trip', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 250, bot: false,
    });
    const totalBefore = s0.players.button.stack + s0.players.bigBlind.stack + s0.pot;
    const forfeited = pokerForfeit(s0, 'button');
    const totalAfter = forfeited.players.button.stack + forfeited.players.bigBlind.stack + forfeited.pot;
    expect(totalAfter).toBe(totalBefore); // no chips stranded, no chips minted
  });

  it('forfeit by the bigBlind seat mirrors the button case', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 400, bot: false,
    });
    const buttonBefore = s0.players.button.stack;
    const bigBlindBefore = s0.players.bigBlind.stack;
    const potBefore = s0.pot;
    const forfeited = pokerForfeit(s0, 'bigBlind');
    expect(forfeited.lastShowdown?.winner).toBe('button');
    expect(forfeited.players.button.stack).toBe(
      buttonBefore + potBefore + bigBlindBefore,
    );
    expect(forfeited.players.bigBlind.stack).toBe(0);
    expect(forfeited.pot).toBe(0);
  });

  it('idempotent on non-playing state (LWW-safe against double writers)', () => {
    // Two peers each fire forfeit — the loser under LWW writes the same
    // terminal state, so double-crediting stacks would corrupt chip totals.
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 500, bot: false,
    });
    const once = pokerForfeit(s0, 'button');
    const twice = pokerForfeit(once, 'button'); // status !== 'playing' now
    expect(twice).toBe(once); // untouched — no double credit
  });
});

// ── Round-3 audit regressions (BLOCKER / MAJOR / MAJOR / MAJOR / MAJOR) ─────

describe('poker: dealHand refunds unmatched blinds when one poster is short-stack', () => {
  // Round-3 audit finding (poker.ts:283). Heads-up removes SIDE pots, not
  // UNMATCHED-BET refunds. When one seat can't cover the full blind, the
  // over-committed portion of the other seat's post must be returned to
  // their stack — otherwise the short-stack seat can win chips they were
  // never risked to win. Pre-fix: stacks 3/1000 with 5/10 blinds produced
  // pot=13, and if the 3-chip player took it they'd walk with 13 (winning
  // 7 chips of BB money that BB never had a chance to fold on).
  it('SB-short: opponent (BB) refund of the uncalled amount', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    // Force the drained scenario: button has only 3 chips vs BB's 1000.
    const drained: PokerState = {
      ...s0,
      players: {
        button: { ...s0.players.button, stack: 3, streetBet: 0, handBet: 0, folded: false, allIn: false },
        bigBlind: { ...s0.players.bigBlind, stack: 1000, streetBet: 0, handBet: 0, folded: false, allIn: false },
      },
      status: 'hand-over',
      handsPlayed: 0,
    };
    const dealt = dealHand(drained);
    // Matched-pot cap = min(3, 10) = 3. Button all-in for 3, BB posts 3
    // (7-chip refund). Total pot contest = 6 chips.
    expect(dealt.players.button.streetBet).toBe(3);
    expect(dealt.players.bigBlind.streetBet).toBe(3);
    expect(dealt.players.button.handBet).toBe(3);
    expect(dealt.players.bigBlind.handBet).toBe(3);
    expect(dealt.pot).toBe(6);
    expect(dealt.players.button.allIn).toBe(true);
    expect(dealt.players.button.stack).toBe(0);
    // BB stack: started 1000, posted the matched 3 (7 refunded from the
    // 10 attempted post) → 1000 - 3 = 997.
    expect(dealt.players.bigBlind.stack).toBe(997);
    // Chip conservation: refunded chips remain accounted for in stack+pot.
    const preTotal = drained.players.button.stack + drained.players.bigBlind.stack;
    const postTotal = dealt.players.button.stack + dealt.players.bigBlind.stack + dealt.pot;
    expect(postTotal).toBe(preTotal);
  });

  it('BB-short: opponent (button/SB) refund of the uncalled amount', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    // Symmetric edge: BB has only 4 chips; SB=5, BB=10 blinds. Matched cap =
    // min(5, 4) = 4. Button posts 5 attempted → refund 1 → posts 4.
    const drained: PokerState = {
      ...s0,
      players: {
        button: { ...s0.players.button, stack: 1000, streetBet: 0, handBet: 0, folded: false, allIn: false },
        bigBlind: { ...s0.players.bigBlind, stack: 4, streetBet: 0, handBet: 0, folded: false, allIn: false },
      },
      status: 'hand-over',
      handsPlayed: 0,
    };
    const dealt = dealHand(drained);
    expect(dealt.players.button.streetBet).toBe(4);
    expect(dealt.players.bigBlind.streetBet).toBe(4);
    expect(dealt.pot).toBe(8);
    expect(dealt.players.button.stack).toBe(996);
    expect(dealt.players.bigBlind.stack).toBe(0);
    expect(dealt.players.bigBlind.allIn).toBe(true);
    const preTotal = drained.players.button.stack + drained.players.bigBlind.stack;
    const postTotal = dealt.players.button.stack + dealt.players.bigBlind.stack + dealt.pot;
    expect(postTotal).toBe(preTotal);
  });

  it('both posters cover both blinds → no refund, canonical pot', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    // Baseline case (both cover their blinds fully). Canonical pot = SB+BB.
    expect(s0.pot).toBe(15);
    expect(s0.players.button.streetBet).toBe(5);
    expect(s0.players.bigBlind.streetBet).toBe(10);
  });
});

describe('poker: raise below currentBet is rejected (not accepted as an all-in raise)', () => {
  // Round-3 audit finding (poker.ts:405). Pre-fix, `amount === maxTarget`
  // (all-in) bypassed the minimum-raise check even when amount < currentBet,
  // so a short-stack "raise" to 70 when currentBet=100 was accepted AND
  // currentBet was lowered to 70 (corrupting the state machine — the
  // opponent's callAmount went negative, legalActions fell out of sync).
  // Such a short stack's only legal aggression is CALL (all-in for what
  // they have); the engine must reject the "raise" and let them call.
  it('raise to amount below currentBet is rejected', () => {
    // Construct a mid-flop state: button opened with a big bet, BB has a
    // short stack. BB attempts to "raise" to less than the standing bet.
    const s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'flop',
      players: {
        button: {
          id: 'A', stack: 900, streetBet: 100, handBet: 100,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: false,
        },
        bigBlind: {
          id: 'W', stack: 50, streetBet: 20, handBet: 20,
          holeCards: [c(2, 13), c(1, 7)], folded: false, allIn: false,
        },
      },
      community: [c(0, 14), c(1, 5), c(3, 2)],
      toAct: 'bigBlind',
      currentBet: 100,
      minRaise: 100,
      pot: 220,
      deck: [c(2, 8), c(3, 9), c(2, 10), c(3, 11)],
      actions: [{ seat: 'button', kind: 'bet', amount: 100, street: 'flop' }],
      bot: false,
    };
    expect(isPokerState(s)).toBe(true);
    // BB's maxTarget = 50 + 20 = 70; currentBet = 100. A "raise" to 70 is
    // BELOW currentBet, must be rejected (their only legal aggression is
    // CALL — they'll be all-in for 50 more chips).
    const next = applyPokerAction(s, { seat: 'bigBlind', kind: 'raise', amount: 70 });
    expect(next).toBe(s); // unchanged — action refused
    // currentBet NOT corrupted:
    expect(next.currentBet).toBe(100);
    // A CALL is still legal (goes all-in for the 50 they have).
    const called = applyPokerAction(s, { seat: 'bigBlind', kind: 'call' });
    expect(called).not.toBe(s);
    expect(called.players.bigBlind.allIn).toBe(true);
    expect(called.players.bigBlind.stack).toBe(0);
  });

  it('raise into an already-all-in opponent is rejected', () => {
    // The old raise branch had no opponent-can-act check; a bet/raise into a
    // shoved opponent just piled chips into an uncontestable pot without
    // changing the outcome. Reject it — a raise requires someone to raise AT.
    const s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'flop',
      players: {
        button: {
          id: 'A', stack: 0, streetBet: 100, handBet: 100,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: true,
        },
        bigBlind: {
          id: 'W', stack: 900, streetBet: 100, handBet: 100,
          holeCards: [c(2, 13), c(1, 7)], folded: false, allIn: false,
        },
      },
      community: [c(0, 14), c(1, 5), c(3, 2)],
      toAct: 'bigBlind',
      currentBet: 100,
      minRaise: 100,
      pot: 200,
      deck: [c(2, 8), c(3, 9), c(2, 10), c(3, 11)],
      actions: [{ seat: 'button', kind: 'call', amount: 0, street: 'flop' }],
      bot: false,
    };
    expect(isPokerState(s)).toBe(true);
    // Even a legal-looking raise-to-300 is refused (opponent is all-in).
    const next = applyPokerAction(s, { seat: 'bigBlind', kind: 'raise', amount: 300 });
    expect(next).toBe(s);
  });
});

describe('poker: legalActions hides aggression when the opponent can\'t respond or player can\'t exceed', () => {
  // Round-3 audit finding (poker.ts:336). legalActions unconditionally
  // advertised 'bet'/'raise' whenever !p.allIn — the UI then let the human
  // pick a raise target that the state machine would refuse (or worse,
  // pick one that corrupted the pot into an uncontestable ghost pool).
  it('opponent all-in: no raise offered', () => {
    const s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'flop',
      players: {
        button: {
          id: 'A', stack: 0, streetBet: 100, handBet: 100,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: true,
        },
        bigBlind: {
          id: 'W', stack: 900, streetBet: 100, handBet: 100,
          holeCards: [c(2, 13), c(1, 7)], folded: false, allIn: false,
        },
      },
      community: [c(0, 14), c(1, 5), c(3, 2)],
      toAct: 'bigBlind',
      currentBet: 100,
      minRaise: 100,
      pot: 200,
      deck: [c(2, 8), c(3, 9), c(2, 10), c(3, 11)],
      actions: [{ seat: 'button', kind: 'call', amount: 0, street: 'flop' }],
      bot: false,
    };
    expect(isPokerState(s)).toBe(true);
    const acts = legalActions(s, 'bigBlind');
    expect(acts).not.toContain('raise');
    expect(acts).not.toContain('bet');
    // check/fold still there (the matched amount means BB can check through).
    expect(acts).toContain('check');
    expect(acts).toContain('fold');
  });

  it('player cannot exceed currentBet with maxBet: no raise offered', () => {
    // BB's max possible street-bet is exactly currentBet — a "raise" would
    // not actually raise. Only CALL (all-in) is legally aggressive here.
    const s: PokerState = {
      ...initialPokerState(1),
      status: 'playing',
      street: 'flop',
      players: {
        button: {
          id: 'A', stack: 900, streetBet: 100, handBet: 100,
          holeCards: [c(0, 3), c(1, 4)], folded: false, allIn: false,
        },
        bigBlind: {
          // maxBet = stack + streetBet = 80 + 20 = 100. Cannot exceed 100.
          id: 'W', stack: 80, streetBet: 20, handBet: 20,
          holeCards: [c(2, 13), c(1, 7)], folded: false, allIn: false,
        },
      },
      community: [c(0, 14), c(1, 5), c(3, 2)],
      toAct: 'bigBlind',
      currentBet: 100,
      minRaise: 100,
      pot: 220,
      deck: [c(2, 8), c(3, 9), c(2, 10), c(3, 11)],
      actions: [{ seat: 'button', kind: 'bet', amount: 100, street: 'flop' }],
      bot: false,
    };
    expect(isPokerState(s)).toBe(true);
    const acts = legalActions(s, 'bigBlind');
    expect(acts).not.toContain('raise');
    expect(acts).toContain('call'); // all-in call is the only aggression
    expect(acts).toContain('fold');
  });

  it('normal preflop: raise IS offered when both conditions hold', () => {
    // Regression guard for the fix — the base case (both seats have chips
    // and the opponent can respond) still offers raise.
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    expect(legalActions(s0, 'button')).toContain('raise');
  });
});

describe('poker: isPokerState rejects short-deck / stale-community active states', () => {
  // Round-3 audit finding (poker.ts:1117). The trust-boundary guard used to
  // accept any deck-array length, so a hostile peer could plant a state with
  // status='playing', an empty deck, and the next transition would call
  // dealCommunity → deck.shift()! → undefined appended to community, then
  // handed to evaluate7 which would throw or produce garbage. Guard the
  // engine's own invariants at the boundary.
  it('rejects a preflop playing state with a short deck', () => {
    const good = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    expect(isPokerState(good)).toBe(true);
    // Truncate the deck below the preflop cascade requirement (≥ 8).
    const bad = { ...good, deck: good.deck.slice(0, 5) };
    expect(isPokerState(bad)).toBe(false);
  });

  it('rejects a flop playing state with a short deck', () => {
    const good = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    // Fabricate a flop state with mismatched deck.
    const bad: PokerState = {
      ...good,
      street: 'flop',
      community: [c(0, 2), c(0, 3), c(0, 4)],
      deck: [c(0, 5)], // < 4 = insufficient for turn+river
    };
    expect(isPokerState(bad)).toBe(false);
  });

  it('rejects a flop playing state with wrong community length', () => {
    const good = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const bad: PokerState = {
      ...good,
      street: 'flop',
      // community should have EXACTLY 3 cards on the flop.
      community: [c(0, 2), c(0, 3)],
      deck: good.deck.slice(0, 40),
    };
    expect(isPokerState(bad)).toBe(false);
  });

  it('rejects a playing state with null hole cards', () => {
    const good = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const bad = {
      ...good,
      players: {
        ...good.players,
        button: { ...good.players.button, holeCards: null },
      },
    };
    expect(isPokerState(bad)).toBe(false);
  });

  it('accepts terminal states (hand-over/match-over) regardless of deck length', () => {
    // The guard only enforces per-street invariants on ACTIVE states — a
    // terminal state has no upcoming dealCommunity call, so its deck is
    // unconstrained (this preserves the fold/showdown terminal states).
    let s = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    s = applyPokerAction(s, { seat: 'button', kind: 'fold' });
    expect(s.status).toBe('hand-over');
    // Even if we manually drain the deck, the terminal state remains valid.
    expect(isPokerState({ ...s, deck: [] })).toBe(true);
  });

  it('rejects a playing state at street=showdown (engine invariant)', () => {
    // showdown/complete always come with status='hand-over' or 'match-over'
    // (the transitions call endHand). A playing + showdown state is
    // inconsistent — no legitimate write produces it.
    const good = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const bad: PokerState = { ...good, street: 'showdown', community: [c(0,2), c(0,3), c(0,4), c(0,5), c(0,6)] };
    expect(isPokerState(bad)).toBe(false);
  });
});

describe('poker: pokerForfeit marks the forfeiter folded so their hole cards are mucked', () => {
  // Round-3 audit finding (poker.ts:675). Before the fix, pokerForfeit set
  // street='complete' but never marked folded=true. readVisiblePokerState's
  // showdown-visible branch (street==='showdown' || 'complete') then REVEALED
  // both hole-card hands to spectators — a forfeit is documented as
  // fold-equivalent and standard poker mucks the folder's hand.
  it('spectator sees the forfeiter\'s cards mucked (not revealed)', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const forfeited = pokerForfeit(s0, 'button');
    expect(forfeited.players.button.folded).toBe(true);
    const spec = readVisiblePokerState(forfeited, 'someoneElse');
    expect(spec.players.button.holeCards).toBeNull(); // mucked
    // Winner's cards still visible in the recap (see the same convention as
    // the fold-mucking test — a determined peer can read raw doc anyway).
    expect(spec.players.bigBlind.holeCards).not.toBeNull();
  });

  it('the forfeiter still sees their own cards after forfeit', () => {
    const s0 = beginPoker(initialPokerState(1), {
      button: 'B', bigBlind: 'W', startingStack: 1000, bot: false,
    });
    const forfeited = pokerForfeit(s0, 'button');
    const own = readVisiblePokerState(forfeited, 'B'); // 'B' was button
    expect(own.players.button.holeCards).not.toBeNull();
  });
});

