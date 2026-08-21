/**
 * Solitaire (Klondike) engine tests — move legality on tableau, foundation
 * transitions, auto-flip of exposed cards, and a scripted win path.
 */

import { describe, expect, it } from 'vitest';
import { cardOf } from './cards';
import {
  applySolitaireMove, canPlaceOnFoundation, canPlaceOnEmptyTableau, canStackTableau,
  dealSolitaire, initialSolitaireState, isSolitaireState, isValidRun,
  legalSolitaireMoves,
} from './solitaire';
import type { SolitaireState, SolitaireTableauCard } from './solitaire';

const c = (suit: 0 | 1 | 2 | 3, rank: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14) => cardOf(suit, rank);
const up = (card: number): SolitaireTableauCard => ({ card, faceUp: true });
const down = (card: number): SolitaireTableauCard => ({ card, faceUp: false });

/** Empty playing state with easy-to-address piles for direct manipulation. */
function playing(seed = 1): SolitaireState {
  return {
    ...initialSolitaireState(seed),
    status: 'playing',
    tableau: [[], [], [], [], [], [], []],
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
  };
}

describe('solitaire: setup', () => {
  it('initialSolitaireState is a valid waiting state', () => {
    const s = initialSolitaireState(2025);
    expect(s.status).toBe('waiting');
    expect(s.tableau.length).toBe(7);
    expect(s.tableau.every((p) => p.length === 0)).toBe(true);
    expect(isSolitaireState(s)).toBe(true);
  });

  it('dealSolitaire lays out 28 tableau + 24 stock, top face-up', () => {
    const s = dealSolitaire(initialSolitaireState(99));
    expect(s.status).toBe('playing');
    for (let i = 0; i < 7; i++) {
      expect(s.tableau[i].length).toBe(i + 1);
      // Top card face-up, rest face-down.
      for (let j = 0; j < i; j++) expect(s.tableau[i][j].faceUp).toBe(false);
      expect(s.tableau[i][i].faceUp).toBe(true);
    }
    expect(s.stock.length).toBe(24);
    expect(s.waste.length).toBe(0);
    // All 52 cards present between tableau + stock, no dupes.
    const cards = new Set([
      ...s.tableau.flat().map((t) => t.card),
      ...s.stock,
    ]);
    expect(cards.size).toBe(52);
  });

  it('dealSolitaire is reproducible from seed', () => {
    const a = dealSolitaire(initialSolitaireState(2025));
    const b = dealSolitaire(initialSolitaireState(2025));
    expect(a).toEqual(b);
  });
});

describe('solitaire: legality helpers', () => {
  it('canStackTableau enforces alternating colour, -1 rank', () => {
    // 5♥ on 6♠ — legal (red on black, one less).
    expect(canStackTableau(c(3, 6), c(2, 5))).toBe(true);
    // 5♦ on 6♥ — illegal (both red).
    expect(canStackTableau(c(2, 6), c(1, 5))).toBe(false);
    // 5♥ on 7♠ — illegal (rank jump).
    expect(canStackTableau(c(3, 7), c(2, 5))).toBe(false);
    // K on Q — never legal (child must be one LESS than parent).
    expect(canStackTableau(c(0, 12), c(0, 13))).toBe(false);
  });

  it('canPlaceOnFoundation enforces same-suit ascending starting at Ace', () => {
    // Ace on empty ♠ pile — legal.
    expect(canPlaceOnFoundation([], c(3, 14))).toBe(true);
    // 2♠ on empty — illegal.
    expect(canPlaceOnFoundation([], c(3, 2))).toBe(false);
    // 2♠ on [A♠] — legal.
    expect(canPlaceOnFoundation([c(3, 14)], c(3, 2))).toBe(true);
    // 2♥ on [A♠] — illegal (suit mismatch).
    expect(canPlaceOnFoundation([c(3, 14)], c(2, 2))).toBe(false);
  });

  it('canPlaceOnEmptyTableau requires a King', () => {
    expect(canPlaceOnEmptyTableau(c(0, 13))).toBe(true);
    expect(canPlaceOnEmptyTableau(c(0, 12))).toBe(false);
    expect(canPlaceOnEmptyTableau(c(0, 14))).toBe(false);
  });

  it('isValidRun rejects unstacked runs', () => {
    // Valid: K♠, Q♥, J♠
    const pile: SolitaireTableauCard[] = [up(c(3, 13)), up(c(2, 12)), up(c(3, 11))];
    expect(isValidRun(pile, 0)).toBe(true);
    // Break the alternation: K♠, Q♠, J♥
    const bad: SolitaireTableauCard[] = [up(c(3, 13)), up(c(3, 12)), up(c(2, 11))];
    expect(isValidRun(bad, 0)).toBe(false);
    // Face-down inside disqualifies.
    const withDown: SolitaireTableauCard[] = [down(c(3, 13)), up(c(2, 12))];
    expect(isValidRun(withDown, 0)).toBe(false);
    expect(isValidRun(withDown, 1)).toBe(true);
  });
});

describe('solitaire: apply moves', () => {
  it('draw moves top of stock to waste', () => {
    const s = playing();
    s.stock = [c(0, 5), c(0, 6), c(0, 7)];
    const next = applySolitaireMove(s, { type: 'draw' });
    expect(next.stock).toEqual([c(0, 6), c(0, 7)]);
    expect(next.waste).toEqual([c(0, 5)]);
    expect(next.moves).toBe(1);
  });

  it('draw with empty stock recycles waste (reversed)', () => {
    const s = playing();
    s.stock = [];
    s.waste = [c(0, 5), c(0, 6), c(0, 7)]; // 7 is on top
    const next = applySolitaireMove(s, { type: 'draw' });
    expect(next.waste).toEqual([]);
    // Reversed so the FIRST drawn (5) returns to top.
    expect(next.stock).toEqual([c(0, 7), c(0, 6), c(0, 5)]);
    expect(next.redeals).toBe(1);
  });

  it('waste-to-foundation for an ace', () => {
    const s = playing();
    s.waste = [c(3, 14)]; // A♠ on top
    const next = applySolitaireMove(s, { type: 'waste-to-foundation' });
    expect(next.waste).toEqual([]);
    expect(next.foundations[3]).toEqual([c(3, 14)]);
    expect(next.moves).toBe(1);
  });

  it('waste-to-foundation rejects wrong suit/rank', () => {
    const s = playing();
    s.waste = [c(2, 2)]; // 2♥ on empty foundation — illegal (need ace)
    const next = applySolitaireMove(s, { type: 'waste-to-foundation' });
    expect(next).toEqual(s);
  });

  it('waste-to-tableau adds card face-up', () => {
    const s = playing();
    s.waste = [c(2, 5)]; // 5♥
    s.tableau[0] = [up(c(3, 6))]; // 6♠ — legal target
    const next = applySolitaireMove(s, { type: 'waste-to-tableau', to: 0 });
    expect(next.waste).toEqual([]);
    expect(next.tableau[0]).toEqual([up(c(3, 6)), up(c(2, 5))]);
  });

  it('waste-to-empty-tableau needs a King', () => {
    const s = playing();
    s.waste = [c(0, 5)]; // 5♣ — not a King
    s.tableau[0] = [];
    const next = applySolitaireMove(s, { type: 'waste-to-tableau', to: 0 });
    expect(next).toEqual(s);
    // Now try with a king.
    s.waste = [c(0, 13)];
    const ok = applySolitaireMove(s, { type: 'waste-to-tableau', to: 0 });
    expect(ok.tableau[0]).toEqual([up(c(0, 13))]);
  });

  it('tableau-to-tableau moves a valid run and flips the exposed card', () => {
    const s = playing();
    // Source pile 0: [X (down), K♠ (up), Q♥ (up), J♠ (up)]
    // Destination pile 1: []
    // Move J♠ headed run? — J♠ alone can't go to empty (only Kings), but the
    // whole run headed by K♠ can. Move from fromIndex=1.
    s.tableau[0] = [down(c(0, 2)), up(c(3, 13)), up(c(2, 12)), up(c(3, 11))];
    s.tableau[1] = [];
    const next = applySolitaireMove(s, { type: 'tableau-to-tableau', from: 0, fromIndex: 1, to: 1 });
    expect(next.tableau[1]).toEqual([up(c(3, 13)), up(c(2, 12)), up(c(3, 11))]);
    // Source: newly-exposed card auto-flips.
    expect(next.tableau[0]).toEqual([up(c(0, 2))]);
  });

  it('tableau-to-foundation moves the top card and flips exposed', () => {
    const s = playing();
    s.tableau[0] = [down(c(0, 5)), up(c(3, 14))]; // A♠ on top
    const next = applySolitaireMove(s, { type: 'tableau-to-foundation', from: 0 });
    expect(next.tableau[0]).toEqual([up(c(0, 5))]);
    expect(next.foundations[3]).toEqual([c(3, 14)]);
  });

  it('foundation-to-tableau moves one card back (unblock)', () => {
    const s = playing();
    s.foundations[0] = [c(0, 14)]; // A♣ on foundation
    s.tableau[0] = [up(c(1, 2))]; // 2♦ on tableau
    // Ace on 2♦? Rank 14 vs rank 2 — not one-less. Illegal.
    const bad = applySolitaireMove(s, { type: 'foundation-to-tableau', suit: 0, to: 0 });
    expect(bad).toEqual(s);
    // Now try with 3♦ (rank 3) and 2♠ (rank 2) — legal.
    s.foundations[0] = [c(0, 14), c(0, 2)]; // ...2♣ on top
    s.tableau[0] = [up(c(1, 3))]; // 3♦
    const ok = applySolitaireMove(s, { type: 'foundation-to-tableau', suit: 0, to: 0 });
    expect(ok.foundations[0]).toEqual([c(0, 14)]);
    expect(ok.tableau[0]).toEqual([up(c(1, 3)), up(c(0, 2))]);
  });

  it('legal move list is empty when nothing is playable', () => {
    const s = playing();
    expect(legalSolitaireMoves(s)).toEqual([]);
  });
});

describe('solitaire: win detection', () => {
  it('completing all four foundations flips status to won', () => {
    const s = playing();
    // Pre-fill three foundations completely, then move the final King into the fourth.
    for (let suit = 0; suit < 3; suit++) {
      s.foundations[suit] = [];
      for (let rank = 14; rank <= 14 + 12; rank++) {
        // Ascending sequence: A, 2, 3, ..., K
        const r = ((rank - 14) === 0 ? 14 : (rank - 14) + 1) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
        s.foundations[suit].push(cardOf(suit as 0 | 1 | 2 | 3, r));
      }
    }
    // Fill spades except the last (K♠).
    const spades: number[] = [];
    for (let r = 14; r <= 14; r++) spades.push(cardOf(3, 14));
    for (let r = 2; r <= 12; r++) spades.push(cardOf(3, r as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12));
    // spades = [A♠, 2♠, ..., Q♠] (12 cards)
    s.foundations[3] = spades;
    // K♠ waiting on tableau.
    s.tableau[0] = [up(c(3, 13))];
    // Sanity: each foundation should have 13 or 12 respectively.
    expect(s.foundations[0].length).toBe(13);
    expect(s.foundations[3].length).toBe(12);
    const next = applySolitaireMove(s, { type: 'tableau-to-foundation', from: 0 });
    expect(next.status).toBe('won');
    expect(next.foundations[3].length).toBe(13);
  });
});

describe('solitaire: shape guard', () => {
  it('accepts a freshly dealt state', () => {
    const s = dealSolitaire(initialSolitaireState(2025));
    expect(isSolitaireState(s)).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isSolitaireState(null)).toBe(false);
    expect(isSolitaireState({})).toBe(false);
    expect(isSolitaireState({ kind: 'chess' })).toBe(false);
  });

  it('rejects tableau with wrong number of piles', () => {
    const s = dealSolitaire(initialSolitaireState(1));
    const bad = { ...s, tableau: s.tableau.slice(0, 6) };
    expect(isSolitaireState(bad)).toBe(false);
  });

  it('rejects bad cards in stock/waste', () => {
    const s = dealSolitaire(initialSolitaireState(1));
    expect(isSolitaireState({ ...s, stock: [99] })).toBe(false);
    expect(isSolitaireState({ ...s, waste: [-1] })).toBe(false);
  });
});
