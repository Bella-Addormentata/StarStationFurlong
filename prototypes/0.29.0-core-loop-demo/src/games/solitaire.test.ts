/**
 * Solitaire (Klondike) engine tests — move legality on tableau, foundation
 * transitions, auto-flip of exposed cards, a scripted win path, and (new in
 * this round) draw-3 mode + undo history semantics + recycle determinism.
 */

import { describe, expect, it } from 'vitest';
import { cardOf } from './cards';
import {
  applySolitaireMove, canPlaceOnFoundation, canPlaceOnEmptyTableau, canStackTableau,
  dealSolitaire, initialSolitaireState, isSolitaireState, isValidRun,
  legalSolitaireMoves, MAX_UNDO_HISTORY, setSolitaireDrawMode,
} from './solitaire';
import type { SolitaireState, SolitaireTableauCard } from './solitaire';

const c = (suit: 0 | 1 | 2 | 3, rank: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14) => cardOf(suit, rank);
const up = (card: number): SolitaireTableauCard => ({ card, faceUp: true });
const down = (card: number): SolitaireTableauCard => ({ card, faceUp: false });

/** Empty playing state with easy-to-address piles for direct manipulation.
 *  Defaults to draw-one (drawMode: 1) so single-card scripted draws work
 *  without extra tuning; draw-3 tests override it explicitly. */
function playing(seed = 1, drawMode: 1 | 3 = 1): SolitaireState {
  return {
    ...initialSolitaireState(seed, drawMode),
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
    expect(s.drawMode).toBe(3); // classic default
    expect(s.undoHistory).toEqual([]);
    expect(isSolitaireState(s)).toBe(true);
  });

  it('initialSolitaireState honours a drawMode override', () => {
    const s1 = initialSolitaireState(1, 1);
    expect(s1.drawMode).toBe(1);
    const s3 = initialSolitaireState(1, 3);
    expect(s3.drawMode).toBe(3);
  });

  it('setSolitaireDrawMode toggles while waiting, no-ops mid-hand', () => {
    const w = initialSolitaireState(1, 3);
    const toOne = setSolitaireDrawMode(w, 1);
    expect(toOne.drawMode).toBe(1);
    const dealt = dealSolitaire({ ...w, status: 'waiting' });
    // Once we're playing, drawMode toggle is refused (would invalidate undo).
    const noop = setSolitaireDrawMode(dealt, 1);
    expect(noop).toBe(dealt);
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
    // Deal clears undo history.
    expect(s.undoHistory).toEqual([]);
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
  it('draw (mode 1) moves top of stock to waste', () => {
    const s = playing(1, 1);
    s.stock = [c(0, 5), c(0, 6), c(0, 7)];
    const next = applySolitaireMove(s, { type: 'draw' });
    expect(next.stock).toEqual([c(0, 6), c(0, 7)]);
    expect(next.waste).toEqual([c(0, 5)]);
    expect(next.moves).toBe(1);
  });

  it('draw (mode 3) moves up to three cards to waste preserving order', () => {
    const s = playing(1, 3);
    s.stock = [c(0, 5), c(0, 6), c(0, 7), c(0, 8)];
    const next = applySolitaireMove(s, { type: 'draw' });
    expect(next.stock).toEqual([c(0, 8)]);
    // Waste has 3 cards drawn in order — 7 is the playable top.
    expect(next.waste).toEqual([c(0, 5), c(0, 6), c(0, 7)]);
  });

  it('draw (mode 3) draws whatever remains when stock < 3', () => {
    const s = playing(1, 3);
    s.stock = [c(0, 5), c(0, 6)];
    const next = applySolitaireMove(s, { type: 'draw' });
    expect(next.stock).toEqual([]);
    expect(next.waste).toEqual([c(0, 5), c(0, 6)]);
  });

  // Regression for Copilot review comment on solitaire.ts:297.
  // With stock[0]=top and waste[last]=top, waste=[5,6,7] means 5 was drawn
  // first. To preserve the deterministic draw sequence (5, then 6, then 7),
  // the recycle MUST produce stock=[5,6,7] (same order — no reverse).
  // Pre-fix used `.reverse()` which gave stock=[7,6,5] and the very next
  // draw served 7, i.e. the just-drawn top card AGAIN — determinism broken,
  // the classic recycle rule violated, and any hand that recycles blew up.
  it('draw with empty stock recycles waste preserving draw order', () => {
    const s = playing(1, 1);
    s.stock = [];
    s.waste = [c(0, 5), c(0, 6), c(0, 7)]; // 7 is currently the playable top
    const next = applySolitaireMove(s, { type: 'draw' });
    expect(next.waste).toEqual([]);
    // Preserved (NOT reversed) so the first-drawn (5) returns to the top.
    expect(next.stock).toEqual([c(0, 5), c(0, 6), c(0, 7)]);
    expect(next.redeals).toBe(1);
    // Next draw is 5 — the same card that was drawn first at cycle 1.
    const after = applySolitaireMove(next, { type: 'draw' });
    expect(after.waste).toEqual([c(0, 5)]);
    expect(after.stock).toEqual([c(0, 6), c(0, 7)]);
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

describe('solitaire: undo history', () => {
  it('every successful non-undo transition pushes a pre-move snapshot', () => {
    const s = playing(1, 1);
    s.stock = [c(0, 5), c(0, 6), c(0, 7)];
    const after1 = applySolitaireMove(s, { type: 'draw' });
    expect(after1.undoHistory.length).toBe(1);
    // Snapshot is the state BEFORE the draw.
    expect(after1.undoHistory[0].stock).toEqual([c(0, 5), c(0, 6), c(0, 7)]);
    expect(after1.undoHistory[0].waste).toEqual([]);
    // Snapshot's nested undoHistory is the empty [] sentinel (no nesting).
    expect(after1.undoHistory[0].undoHistory).toEqual([]);
    const after2 = applySolitaireMove(after1, { type: 'draw' });
    expect(after2.undoHistory.length).toBe(2);
  });

  it('undo restores the previous state exactly, minus its own history entry', () => {
    const s = playing(1, 1);
    s.stock = [c(0, 5), c(0, 6)];
    const drawn = applySolitaireMove(s, { type: 'draw' });
    expect(drawn.waste).toEqual([c(0, 5)]);
    const undone = applySolitaireMove(drawn, { type: 'undo' });
    // Board matches the pre-draw state.
    expect(undone.stock).toEqual([c(0, 5), c(0, 6)]);
    expect(undone.waste).toEqual([]);
    // History drained to empty (that was the only snapshot).
    expect(undone.undoHistory).toEqual([]);
    // Move counter restored to pre-draw value (0), not incremented.
    expect(undone.moves).toBe(0);
  });

  it('undo across a full sequence returns to earlier states one at a time', () => {
    let s = playing(1, 1);
    s.stock = [c(0, 5), c(0, 6), c(0, 7)];
    s = applySolitaireMove(s, { type: 'draw' }); // waste=[5]
    s = applySolitaireMove(s, { type: 'draw' }); // waste=[5,6]
    s = applySolitaireMove(s, { type: 'draw' }); // waste=[5,6,7]
    expect(s.waste).toEqual([c(0, 5), c(0, 6), c(0, 7)]);
    expect(s.undoHistory.length).toBe(3);
    s = applySolitaireMove(s, { type: 'undo' });
    expect(s.waste).toEqual([c(0, 5), c(0, 6)]);
    s = applySolitaireMove(s, { type: 'undo' });
    expect(s.waste).toEqual([c(0, 5)]);
    s = applySolitaireMove(s, { type: 'undo' });
    expect(s.waste).toEqual([]);
    // History fully drained.
    expect(s.undoHistory).toEqual([]);
    // Further undo is a no-op (no snapshot to restore).
    const noop = applySolitaireMove(s, { type: 'undo' });
    expect(noop).toBe(s);
  });

  it('undo across a foundation move restores the card AND the tableau flip', () => {
    const s = playing(1, 1);
    // Tableau: [X (down), A♠ (up)] → foundation. Auto-flip exposes X.
    s.tableau[0] = [down(c(0, 5)), up(c(3, 14))];
    const promoted = applySolitaireMove(s, { type: 'tableau-to-foundation', from: 0 });
    expect(promoted.tableau[0]).toEqual([up(c(0, 5))]);
    expect(promoted.foundations[3]).toEqual([c(3, 14)]);
    // Undo restores BOTH the moved card AND the face-down/face-up state.
    const undone = applySolitaireMove(promoted, { type: 'undo' });
    expect(undone.tableau[0]).toEqual([down(c(0, 5)), up(c(3, 14))]);
    expect(undone.foundations[3]).toEqual([]);
  });

  it('undo is a legal move in legalSolitaireMoves whenever history exists', () => {
    const s = playing(1, 1);
    s.stock = [c(0, 5)];
    expect(legalSolitaireMoves(s).some((m) => m.type === 'undo')).toBe(false);
    const drawn = applySolitaireMove(s, { type: 'draw' });
    expect(legalSolitaireMoves(drawn).some((m) => m.type === 'undo')).toBe(true);
  });

  it('undo history is bounded to MAX_UNDO_HISTORY entries (oldest dropped)', () => {
    let s = playing(1, 1);
    // Seed enough stock so we can draw MAX+5 times.
    s.stock = Array.from({ length: MAX_UNDO_HISTORY + 5 }, (_, i) => (i % 52));
    for (let i = 0; i < MAX_UNDO_HISTORY + 5; i++) {
      s = applySolitaireMove(s, { type: 'draw' });
    }
    // History capped at MAX_UNDO_HISTORY — the excess snapshots dropped from
    // the FRONT (oldest first), keeping the most-recent MAX entries.
    expect(s.undoHistory.length).toBe(MAX_UNDO_HISTORY);
  });

  it('undo does NOT record a snapshot of itself (no undo-of-undo doubling)', () => {
    const s = playing(1, 1);
    s.stock = [c(0, 5)];
    const drawn = applySolitaireMove(s, { type: 'draw' });
    const undone = applySolitaireMove(drawn, { type: 'undo' });
    // Draining the snapshot leaves history empty — undo did NOT push a new one.
    expect(undone.undoHistory.length).toBe(0);
    expect(applySolitaireMove(undone, { type: 'undo' })).toBe(undone);
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

  it('rejects an unknown drawMode value', () => {
    const s = dealSolitaire(initialSolitaireState(1));
    expect(isSolitaireState({ ...s, drawMode: 2 })).toBe(false);
    expect(isSolitaireState({ ...s, drawMode: '3' })).toBe(false);
  });

  it('rejects undoHistory that is not an array or exceeds cap', () => {
    const s = dealSolitaire(initialSolitaireState(1));
    expect(isSolitaireState({ ...s, undoHistory: 'nope' })).toBe(false);
    const overCap = Array.from(
      { length: MAX_UNDO_HISTORY + 1 },
      () => ({ ...s, undoHistory: [] }),
    );
    expect(isSolitaireState({ ...s, undoHistory: overCap })).toBe(false);
  });

  it('rejects undoHistory entries with a non-empty nested history (no recursive nesting)', () => {
    const s = dealSolitaire(initialSolitaireState(1));
    const nested = { ...s, undoHistory: [{ ...s, undoHistory: [{ ...s, undoHistory: [] }] }] };
    expect(isSolitaireState(nested)).toBe(false);
  });
});
