/**
 * KLONDIKE SOLITAIRE (single-player) — the second card-felt game (#45).
 *
 * Pure functions over a plain-JSON SolitaireState (checkers.ts / chess.ts
 * discipline). The state lives in the room doc so the felt survives rejoins
 * (and other clients at the table can spectate — Klondike is single-player,
 * so no adversary means the "cards are technically public" concern from
 * games-plan.md does not apply here).
 *
 * RULES (standard Klondike, DRAW-ONE — the most forgiving default; a
 * DRAW-THREE toggle is out of scope for v1):
 *  - 7 TABLEAU piles: pile i (0-based) is dealt i+1 cards, only the TOP card
 *    face-up. Piles descend by rank in ALTERNATING COLOURS. Only a KING
 *    (rank 13) may occupy an empty tableau pile.
 *  - 4 FOUNDATIONS (one per suit): ascend by rank in the SAME suit, starting
 *    with the ACE (2 of ♣ on Ace of ♣, etc.). WIN when all 52 cards sit on
 *    foundations.
 *  - STOCK / WASTE: draw one card face-up from stock to waste per DRAW. When
 *    stock is empty, RECYCLE the waste back to stock (order preserved so the
 *    same draw sequence repeats — deterministic).
 *  - MOVES:
 *      • waste → tableau: waste top onto legal tableau pile.
 *      • waste → foundation: waste top onto legal foundation.
 *      • tableau → tableau: move a face-up run (one or more cards, starting
 *        at any face-up card in the source pile) onto a legal destination.
 *        The run must already be a valid descending-alternating-colour run.
 *      • tableau → foundation: move ONLY the top card (single-card rule).
 *      • foundation → tableau: allowed (rare — for unblocking); one card only.
 *      • draw: stock → waste (single card). Recycle waste ⇢ stock when stock
 *        is empty and waste is non-empty (single call).
 *  - Flipping a newly-exposed tableau top card face-up happens AUTOMATICALLY
 *    after any move that empties the top face-up cluster of a source pile.
 *
 * DOC / RACE DISCIPLINE
 *   Only the CLAIMED seat holder may write; a whole-value LWW write settles
 *   any accidental races (e.g. the player double-clicks). Every transition
 *   is `read → applyMove(state, move) → transacted write`; a rebind after a
 *   rejoin brings the shared observers along.
 */

import type { Card } from './cards';
import { isCard, isDeck, isRed, rankOf, shuffledDeck, suitOf } from './cards';

// ── State ────────────────────────────────────────────────────────────────────

export type SolitairePileKind = 'tableau' | 'stock' | 'waste' | 'foundation';
export type SolitaireStatus = 'waiting' | 'playing' | 'won';

/** A tableau card with its face state (face-up ⇔ visible/playable top). */
export interface SolitaireTableauCard {
  card: Card;
  faceUp: boolean;
}

export interface SolitaireState {
  kind: 'solitaire';
  /** The single-player seat — S2 player id, or null (waiting). */
  player: string | null;
  status: SolitaireStatus;
  /** 7 tableau piles; index 0 = pile 1 (1 card), index 6 = pile 7 (7 cards). */
  tableau: SolitaireTableauCard[][];
  /** Face-down draw pile; index 0 = TOP (drawn next). */
  stock: Card[];
  /** Face-up discard pile; LAST index = top (the playable card). */
  waste: Card[];
  /** 4 foundations by SUIT INDEX (see cards.ts SUIT_GLYPH). Each ascends
   *  from Ace (rank 2 is only playable on rank 3, etc — standard). */
  foundations: [Card[], Card[], Card[], Card[]];
  /** Deterministic shuffle seed (locked at start; same on both peers). */
  seed: number;
  /** Move count for the UI. Bumped by every successful applyMove call. */
  moves: number;
  /** Rebound draws — for a future "Redeals allowed" cap; v1 leaves this open. */
  redeals: number;
}

// ── Move descriptor (union — the applyMove tag is `type`) ────────────────────

export type SolitaireMove =
  /** Draw one card from stock → waste. Recycles the waste when stock empty. */
  | { type: 'draw' }
  /** Move top of waste → tableau pile `to`. */
  | { type: 'waste-to-tableau'; to: number }
  /** Move top of waste → foundation for its suit. */
  | { type: 'waste-to-foundation' }
  /** Move a face-up run starting at `from`,`fromIndex` → tableau pile `to`. */
  | { type: 'tableau-to-tableau'; from: number; fromIndex: number; to: number }
  /** Move top of tableau pile `from` → foundation for its suit. */
  | { type: 'tableau-to-foundation'; from: number }
  /** Move top of foundation for suit `suit` → tableau pile `to`. */
  | { type: 'foundation-to-tableau'; suit: number; to: number };

// ── Construction ─────────────────────────────────────────────────────────────

/** Fresh waiting-to-start table; no cards dealt (deal() flips 'playing'). */
export function initialSolitaireState(seed: number): SolitaireState {
  return {
    kind: 'solitaire',
    player: null,
    status: 'waiting',
    tableau: [[], [], [], [], [], [], []],
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
    seed: seed | 0 || 1,
    moves: 0,
    redeals: 0,
  };
}

/**
 * Deal a fresh Klondike game onto `state` — pile i gets i+1 cards, top card
 * face-up, remainder becomes the stock (28 dealt to tableau; 24 in stock).
 */
export function dealSolitaire(state: SolitaireState): SolitaireState {
  const deck = shuffledDeck(state.seed);
  const tableau: SolitaireTableauCard[][] = [[], [], [], [], [], [], []];
  let idx = 0;
  for (let pile = 0; pile < 7; pile++) {
    for (let row = 0; row <= pile; row++) {
      tableau[pile].push({ card: deck[idx++], faceUp: row === pile });
    }
  }
  const stock = deck.slice(idx);
  return {
    ...state,
    status: 'playing',
    tableau,
    stock,
    waste: [],
    foundations: [[], [], [], []],
    moves: 0,
    redeals: 0,
  };
}

// ── Move legality helpers ────────────────────────────────────────────────────

/** True if `child` may sit on `parent` in a tableau pile (alt-colour, -1). */
export function canStackTableau(parent: Card, child: Card): boolean {
  if (rankOf(parent) - rankOf(child) !== 1) return false;
  return isRed(parent) !== isRed(child);
}

/** True if `card` may go onto the given foundation (same suit, ascending
 *  ACE→2→…→K). Note the encoding-wrap: cards.ts has ACE=rank 14 (high for
 *  poker/war), so the foundation SUCCESSOR of the Ace is rank 2 — this
 *  encoding-quirk is why we can't just do `top + 1`. */
export function canPlaceOnFoundation(foundation: Card[], card: Card): boolean {
  if (foundation.length === 0) return rankOf(card) === 14; // ACE starts
  const top = foundation[foundation.length - 1];
  if (suitOf(card) !== suitOf(top)) return false;
  const expected = rankOf(top) === 14 ? 2 : rankOf(top) + 1;
  return rankOf(card) === expected;
}

/** True if a card may head an empty tableau pile — Klondike allows only Kings. */
export function canPlaceOnEmptyTableau(card: Card): boolean {
  return rankOf(card) === 13;
}

/**
 * True if the face-up run in pile `from` beginning at `fromIndex` is a valid
 * descending-alternating-colour sequence (a legal tableau→tableau move
 * requires the whole moved run to already satisfy the pile rule).
 */
export function isValidRun(pile: SolitaireTableauCard[], fromIndex: number): boolean {
  if (fromIndex < 0 || fromIndex >= pile.length) return false;
  if (!pile[fromIndex].faceUp) return false;
  for (let i = fromIndex; i < pile.length - 1; i++) {
    const cur = pile[i];
    const next = pile[i + 1];
    if (!cur.faceUp || !next.faceUp) return false;
    if (!canStackTableau(cur.card, next.card)) return false;
  }
  return true;
}

/** Every legal move from the current state (UI hints + tests). */
export function legalSolitaireMoves(state: SolitaireState): SolitaireMove[] {
  if (state.status !== 'playing') return [];
  const moves: SolitaireMove[] = [];

  // draw / recycle — always legal if there's anything to draw or recycle.
  if (state.stock.length > 0 || state.waste.length > 0) {
    moves.push({ type: 'draw' });
  }

  // waste → foundation
  if (state.waste.length > 0) {
    const top = state.waste[state.waste.length - 1];
    if (canPlaceOnFoundation(state.foundations[suitOf(top)], top)) {
      moves.push({ type: 'waste-to-foundation' });
    }
  }

  // waste → tableau
  if (state.waste.length > 0) {
    const top = state.waste[state.waste.length - 1];
    for (let to = 0; to < 7; to++) {
      const pile = state.tableau[to];
      if (pile.length === 0) {
        if (canPlaceOnEmptyTableau(top)) moves.push({ type: 'waste-to-tableau', to });
      } else {
        const dst = pile[pile.length - 1];
        if (dst.faceUp && canStackTableau(dst.card, top)) {
          moves.push({ type: 'waste-to-tableau', to });
        }
      }
    }
  }

  // tableau → foundation (top card only)
  for (let from = 0; from < 7; from++) {
    const pile = state.tableau[from];
    if (pile.length === 0) continue;
    const top = pile[pile.length - 1];
    if (!top.faceUp) continue;
    if (canPlaceOnFoundation(state.foundations[suitOf(top.card)], top.card)) {
      moves.push({ type: 'tableau-to-foundation', from });
    }
  }

  // tableau → tableau (every valid face-up run onto every legal destination)
  for (let from = 0; from < 7; from++) {
    const src = state.tableau[from];
    if (src.length === 0) continue;
    for (let i = 0; i < src.length; i++) {
      if (!src[i].faceUp) continue;
      if (!isValidRun(src, i)) continue;
      const head = src[i];
      for (let to = 0; to < 7; to++) {
        if (to === from) continue;
        const dst = state.tableau[to];
        // A move that just re-sits the same pile onto an empty target does
        // nothing useful — only allow if it EXPOSES a face-down card or is
        // an internal split (some fromIndex > 0). Standard "empty pile only
        // takes a King (or a King-headed run)" still applies.
        if (dst.length === 0) {
          if (!canPlaceOnEmptyTableau(head.card)) continue;
          if (i === 0) continue; // no-op: moving the whole pile
          moves.push({ type: 'tableau-to-tableau', from, fromIndex: i, to });
        } else {
          const dstTop = dst[dst.length - 1];
          if (dstTop.faceUp && canStackTableau(dstTop.card, head.card)) {
            moves.push({ type: 'tableau-to-tableau', from, fromIndex: i, to });
          }
        }
      }
    }
  }

  // foundation → tableau (one card only; used to unblock a colour block)
  for (let suit = 0; suit < 4; suit++) {
    const found = state.foundations[suit];
    if (found.length === 0) continue;
    const top = found[found.length - 1];
    for (let to = 0; to < 7; to++) {
      const dst = state.tableau[to];
      if (dst.length === 0) {
        if (canPlaceOnEmptyTableau(top)) moves.push({ type: 'foundation-to-tableau', suit, to });
      } else {
        const dstTop = dst[dst.length - 1];
        if (dstTop.faceUp && canStackTableau(dstTop.card, top)) {
          moves.push({ type: 'foundation-to-tableau', suit, to });
        }
      }
    }
  }

  return moves;
}

// ── State transitions ────────────────────────────────────────────────────────

/**
 * Try to apply `move` to `state`. Returns a NEW state on success, or the
 * original state unchanged if the move is illegal. Never mutates inputs.
 * Bumps `moves`; auto-flips a newly exposed tableau top; sets status='won'
 * when every foundation carries all 13 cards.
 */
export function applySolitaireMove(state: SolitaireState, move: SolitaireMove): SolitaireState {
  if (state.status !== 'playing') return state;
  switch (move.type) {
    case 'draw': {
      if (state.stock.length > 0) {
        // Standard draw-one: move the TOP card of stock to the TOP of waste.
        const stock = state.stock.slice();
        const drawn = stock.shift()!;
        const waste = [...state.waste, drawn];
        return commit({ ...state, stock, waste });
      }
      if (state.waste.length > 0) {
        // Recycle waste back to stock (reverse so the first-drawn returns to
        // the top — deterministic draw sequence, unlimited redeals per v1).
        const stock = state.waste.slice().reverse();
        return commit({ ...state, stock, waste: [], redeals: state.redeals + 1 });
      }
      return state;
    }
    case 'waste-to-foundation': {
      if (state.waste.length === 0) return state;
      const top = state.waste[state.waste.length - 1];
      const suit = suitOf(top);
      if (!canPlaceOnFoundation(state.foundations[suit], top)) return state;
      const foundations = cloneFoundations(state.foundations);
      foundations[suit] = [...foundations[suit], top];
      return finish(commit({
        ...state,
        waste: state.waste.slice(0, -1),
        foundations,
      }));
    }
    case 'waste-to-tableau': {
      if (state.waste.length === 0) return state;
      const top = state.waste[state.waste.length - 1];
      if (!canPlaceCardOnTableau(state.tableau[move.to], top)) return state;
      const tableau = cloneTableau(state.tableau);
      tableau[move.to] = [...tableau[move.to], { card: top, faceUp: true }];
      return commit({
        ...state,
        waste: state.waste.slice(0, -1),
        tableau,
      });
    }
    case 'tableau-to-tableau': {
      const src = state.tableau[move.from];
      if (!src || move.fromIndex < 0 || move.fromIndex >= src.length) return state;
      if (!isValidRun(src, move.fromIndex)) return state;
      const dst = state.tableau[move.to];
      if (!dst) return state;
      const head = src[move.fromIndex].card;
      if (dst.length === 0) {
        if (!canPlaceOnEmptyTableau(head)) return state;
        if (move.fromIndex === 0) return state; // no-op whole-pile shift
      } else {
        const dstTop = dst[dst.length - 1];
        if (!dstTop.faceUp || !canStackTableau(dstTop.card, head)) return state;
      }
      const run = src.slice(move.fromIndex);
      const newSrc = src.slice(0, move.fromIndex);
      // Auto-flip newly exposed top face-down card.
      if (newSrc.length > 0 && !newSrc[newSrc.length - 1].faceUp) {
        newSrc[newSrc.length - 1] = { ...newSrc[newSrc.length - 1], faceUp: true };
      }
      const newDst = [...dst, ...run];
      const tableau = cloneTableau(state.tableau);
      tableau[move.from] = newSrc;
      tableau[move.to] = newDst;
      return commit({ ...state, tableau });
    }
    case 'tableau-to-foundation': {
      const pile = state.tableau[move.from];
      if (!pile || pile.length === 0) return state;
      const top = pile[pile.length - 1];
      if (!top.faceUp) return state;
      const suit = suitOf(top.card);
      if (!canPlaceOnFoundation(state.foundations[suit], top.card)) return state;
      const newPile = pile.slice(0, -1);
      if (newPile.length > 0 && !newPile[newPile.length - 1].faceUp) {
        newPile[newPile.length - 1] = { ...newPile[newPile.length - 1], faceUp: true };
      }
      const tableau = cloneTableau(state.tableau);
      tableau[move.from] = newPile;
      const foundations = cloneFoundations(state.foundations);
      foundations[suit] = [...foundations[suit], top.card];
      return finish(commit({ ...state, tableau, foundations }));
    }
    case 'foundation-to-tableau': {
      const found = state.foundations[move.suit];
      if (!found || found.length === 0) return state;
      const top = found[found.length - 1];
      if (!canPlaceCardOnTableau(state.tableau[move.to], top)) return state;
      const foundations = cloneFoundations(state.foundations);
      foundations[move.suit] = found.slice(0, -1);
      const tableau = cloneTableau(state.tableau);
      tableau[move.to] = [...tableau[move.to], { card: top, faceUp: true }];
      return commit({ ...state, tableau, foundations });
    }
    default: {
      // exhaustive-check ceremony — a new SolitaireMove kind fails to compile.
      const never: never = move;
      void never;
      return state;
    }
  }
}

function canPlaceCardOnTableau(pile: SolitaireTableauCard[], card: Card): boolean {
  if (pile.length === 0) return canPlaceOnEmptyTableau(card);
  const top = pile[pile.length - 1];
  return top.faceUp && canStackTableau(top.card, card);
}

function cloneTableau(t: SolitaireTableauCard[][]): SolitaireTableauCard[][] {
  return t.map((pile) => pile.slice());
}

function cloneFoundations(f: SolitaireState['foundations']): SolitaireState['foundations'] {
  return [f[0].slice(), f[1].slice(), f[2].slice(), f[3].slice()];
}

/** Bump move counter — every successful applyMove passes through here. */
function commit(state: SolitaireState): SolitaireState {
  return { ...state, moves: state.moves + 1 };
}

/** Set status='won' when every foundation carries 13 cards. */
function finish(state: SolitaireState): SolitaireState {
  const total = state.foundations.reduce((a, f) => a + f.length, 0);
  if (total === 52) return { ...state, status: 'won' };
  return state;
}

// ── Shape guard (peers write the doc; malformed reads render as no game) ─────

export function isSolitaireState(value: unknown): value is SolitaireState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<SolitaireState>;
  if (s.kind !== 'solitaire') return false;
  const tableauCardOk = (c: unknown): c is SolitaireTableauCard =>
    typeof c === 'object' && c !== null
    && isCard((c as SolitaireTableauCard).card)
    && typeof (c as SolitaireTableauCard).faceUp === 'boolean';
  const pilesOk = Array.isArray(s.tableau) && s.tableau.length === 7
    && s.tableau.every((p) => Array.isArray(p) && p.every(tableauCardOk));
  const foundationsOk = Array.isArray(s.foundations) && s.foundations.length === 4
    && s.foundations.every(isDeck);
  return (s.player === null || typeof s.player === 'string')
    && ['waiting', 'playing', 'won'].includes(s.status as string)
    && pilesOk
    && isDeck(s.stock)
    && isDeck(s.waste)
    && foundationsOk
    && Number.isInteger(s.seed)
    && Number.isInteger(s.moves) && (s.moves as number) >= 0
    && Number.isInteger(s.redeals) && (s.redeals as number) >= 0;
}
