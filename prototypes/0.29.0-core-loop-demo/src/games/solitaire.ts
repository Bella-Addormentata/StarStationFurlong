/**
 * KLONDIKE SOLITAIRE (single-player) — the second card-felt game (#45).
 *
 * Pure functions over a plain-JSON SolitaireState (checkers.ts / chess.ts
 * discipline). The state lives in the room doc so the felt survives rejoins
 * (and other clients at the table can spectate — Klondike is single-player,
 * so no adversary means the "cards are technically public" concern from
 * games-plan.md does not apply here).
 *
 * RULES (standard Klondike, DRAW-ONE or DRAW-THREE — both modes are shipped;
 * default is DRAW-THREE, matching the classic Windows / physical deal, with
 * a DRAW-ONE toggle for the more forgiving practice mode):
 *  - 7 TABLEAU piles: pile i (0-based) is dealt i+1 cards, only the TOP card
 *    face-up. Piles descend by rank in ALTERNATING COLOURS. Only a KING
 *    (rank 13) may occupy an empty tableau pile.
 *  - 4 FOUNDATIONS (one per suit): ascend by rank in the SAME suit, starting
 *    with the ACE (2 of ♣ on Ace of ♣, etc.). WIN when all 52 cards sit on
 *    foundations.
 *  - STOCK / WASTE:
 *      · DRAW-ONE: one card per DRAW moves from stock (top) to waste (top).
 *      · DRAW-THREE: up to three cards per DRAW move stock→waste in order,
 *        so `waste[waste.length - 1]` remains the freshly-drawn top and only
 *        that card is playable (standard rule — the 3-card fan is display only).
 *    When stock is empty and waste is non-empty, a `draw` RECYCLES the
 *    waste back to stock preserving the original draw order (see recycle
 *    convention comment in `applySolitaireMove`) — deterministic and
 *    unlimited (v1).
 *  - MOVES:
 *      • waste → tableau: waste top onto legal tableau pile.
 *      • waste → foundation: waste top onto legal foundation.
 *      • tableau → tableau: move a face-up run (one or more cards, starting
 *        at any face-up card in the source pile) onto a legal destination.
 *        The run must already be a valid descending-alternating-colour run.
 *      • tableau → foundation: move ONLY the top card (single-card rule).
 *      • foundation → tableau: allowed (rare — for unblocking); one card only.
 *      • draw: stock → waste (1 or 3 cards per `drawMode`). Recycle waste ⇢
 *        stock when stock is empty and waste is non-empty (single call).
 *      • undo: pop the previous state off the undo history (see below).
 *  - Flipping a newly-exposed tableau top card face-up happens AUTOMATICALLY
 *    after any move that empties the top face-up cluster of a source pile.
 *
 * UNDO HISTORY (bounded, per-move)
 *   Every non-`undo` transition PUSHES a snapshot of the pre-move state onto
 *   `undoHistory` before applying the move. `undo` pops the most recent
 *   snapshot back to become the new current state (dropping its own history
 *   ancestor from that snapshot's tail — the popped state itself sits on top
 *   of the history that produced it). The stack is capped (see
 *   MAX_UNDO_HISTORY) so a marathon session cannot grow the room doc without
 *   bound; the oldest snapshot is dropped when the cap is hit. Snapshots are
 *   deep clones of the RENDERABLE fields (tableau/stock/waste/foundations/…)
 *   with `undoHistory: []` (we don't recursively store the history-of-history
 *   — that would multiply doc size by the max depth).
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

/** Draw-per-tap mode. 1 = draw-one (forgiving), 3 = draw-three (classic). */
export type SolitaireDrawMode = 1 | 3;

/** Hard cap on the undo history size so the room doc stays bounded even in a
 *  marathon session. 128 moves is plenty for practical play — most games
 *  don't exceed ~150 total moves, and undoing further than a handful is rare. */
export const MAX_UNDO_HISTORY = 128;

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
  /** Cards moved per DRAW (1 or 3). Fixed for the lifetime of the deal. */
  drawMode: SolitaireDrawMode;
  /** Bounded stack of pre-move snapshots (see MAX_UNDO_HISTORY). Each entry
   *  has `undoHistory: []` (no recursive nesting). Oldest at index 0. */
  undoHistory: SolitaireSnapshot[];
}

/** Snapshot of a SolitaireState without the recursive undoHistory field. */
export type SolitaireSnapshot = Omit<SolitaireState, 'undoHistory'> & {
  undoHistory: [];
};

// ── Move descriptor (union — the applyMove tag is `type`) ────────────────────

export type SolitaireMove =
  /** Draw one or three cards from stock → waste (per drawMode). Recycles
   *  the waste when stock empty. */
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
  | { type: 'foundation-to-tableau'; suit: number; to: number }
  /** Pop the previous state off the undo history and make it current. */
  | { type: 'undo' };

// ── Construction ─────────────────────────────────────────────────────────────

/** Fresh waiting-to-start table; no cards dealt (deal() flips 'playing').
 *  `drawMode` defaults to 3 (classic Klondike) — the caller can toggle it
 *  via `setSolitaireDrawMode` before dealing. */
export function initialSolitaireState(
  seed: number,
  drawMode: SolitaireDrawMode = 3,
): SolitaireState {
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
    drawMode,
    undoHistory: [],
  };
}

/** Return a copy of `state` with `drawMode` set. Legal only in 'waiting'
 *  (before the deal) — changing it mid-hand would silently invalidate
 *  the undo history's mode invariant. */
export function setSolitaireDrawMode(
  state: SolitaireState,
  drawMode: SolitaireDrawMode,
): SolitaireState {
  if (state.status !== 'waiting') return state;
  return { ...state, drawMode };
}

/**
 * Deal a fresh Klondike game onto `state` — pile i gets i+1 cards, top card
 * face-up, remainder becomes the stock (28 dealt to tableau; 24 in stock).
 * Clears any prior undo history (a fresh hand starts fresh).
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
    undoHistory: [],
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

  // undo — legal whenever a snapshot exists to restore.
  if (state.undoHistory.length > 0) {
    moves.push({ type: 'undo' });
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
 *
 * Snapshots the pre-move state onto `undoHistory` for every kind other than
 * `undo` itself; `undo` never records a snapshot (undoing an undo would
 * duplicate the stack) — instead it POPS the top snapshot. This is the
 * standard classic-solitaire undo semantics.
 */
export function applySolitaireMove(state: SolitaireState, move: SolitaireMove): SolitaireState {
  if (move.type === 'undo') {
    // Undo is legal whenever there's a snapshot to restore, regardless of
    // status (a `won` state can be undone if the player wants to try a
    // different closing sequence — the win transition sets status via the
    // `finish` helper which is inside the pre-move snapshot's applyMove
    // frame, so popping restores the pre-win state).
    if (state.undoHistory.length === 0) return state;
    const history = state.undoHistory.slice();
    const restored = history.pop()!;
    return {
      ...restored,
      // Rehydrate: the snapshot stored an empty history sentinel; restore
      // the truncated history stack as the current one.
      undoHistory: history,
    };
  }
  if (state.status !== 'playing') return state;
  // Snapshot the pre-move state (drop the recursive undoHistory field per
  // MAX_UNDO_HISTORY doctrine) BEFORE we build the successor. Snapshots
  // include the current move counter so undoing restores it exactly.
  const snapshot = takeSnapshot(state);
  switch (move.type) {
    case 'draw': {
      if (state.stock.length > 0) {
        // Draw one OR three cards per `drawMode`. Each drawn card is pushed
        // to waste in order (so waste[waste.length - 1] is the freshly-drawn
        // top and remains the sole playable card; the 3-card fan is a UI
        // convention, not a legality rule).
        const stock = state.stock.slice();
        const waste = state.waste.slice();
        const n = Math.min(state.drawMode, stock.length);
        for (let i = 0; i < n; i++) waste.push(stock.shift()!);
        return commit(pushUndo(state, snapshot), { stock, waste });
      }
      if (state.waste.length > 0) {
        // Recycle waste back to stock. WASTE APPEND CONVENTION: cards were
        // pushed to waste in draw order so `waste[0]` is the FIRST card ever
        // drawn and `waste[waste.length - 1]` is the LAST (currently top).
        // STOCK CONVENTION: `stock[0]` is the NEXT card to be drawn.
        // Therefore preserving the deterministic draw sequence requires
        // stock = waste (SAME ORDER, no reverse) so the first `draw` after
        // recycle produces the same card that was drawn first at cycle 1.
        // (Regression from Copilot review: pre-fix used `.reverse()`, which
        // put the most-recently-drawn card on top of the stock and immediately
        // re-drew it — breaking determinism and the classic recycle rule.)
        const stock = state.waste.slice();
        return commit(pushUndo(state, snapshot), {
          stock, waste: [], redeals: state.redeals + 1,
        });
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
      return finish(commit(pushUndo(state, snapshot), {
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
      return commit(pushUndo(state, snapshot), {
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
      return commit(pushUndo(state, snapshot), { tableau });
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
      return finish(commit(pushUndo(state, snapshot), { tableau, foundations }));
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
      return commit(pushUndo(state, snapshot), { tableau, foundations });
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
  return t.map((pile) => pile.slice().map((c) => ({ ...c })));
}

function cloneFoundations(f: SolitaireState['foundations']): SolitaireState['foundations'] {
  return [f[0].slice(), f[1].slice(), f[2].slice(), f[3].slice()];
}

/** Deep(ish) snapshot of state with a sentinel empty undoHistory. Used both
 *  when pushing pre-move history and when comparing snapshots for tests. */
function takeSnapshot(state: SolitaireState): SolitaireSnapshot {
  return {
    kind: 'solitaire',
    player: state.player,
    status: state.status,
    tableau: cloneTableau(state.tableau),
    stock: state.stock.slice(),
    waste: state.waste.slice(),
    foundations: cloneFoundations(state.foundations),
    seed: state.seed,
    moves: state.moves,
    redeals: state.redeals,
    drawMode: state.drawMode,
    // The snapshot itself carries no history — we never nest histories.
    undoHistory: [],
  };
}

/** Push `snapshot` onto `state.undoHistory` (dropping the oldest when full).
 *  Returns a shallow-copy state so the caller can chain `commit`. */
function pushUndo(state: SolitaireState, snapshot: SolitaireSnapshot): SolitaireState {
  const history = state.undoHistory.slice();
  history.push(snapshot);
  if (history.length > MAX_UNDO_HISTORY) history.shift();
  return { ...state, undoHistory: history };
}

/** Bump move counter and merge the successor patch. Every successful applyMove
 *  passes through here (undo excluded — undo restores an earlier `moves`). */
function commit(state: SolitaireState, patch: Partial<SolitaireState>): SolitaireState {
  return { ...state, ...patch, moves: state.moves + 1 };
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
  const drawModeOk = s.drawMode === 1 || s.drawMode === 3;
  // Undo history entries must be well-shaped snapshots. We do NOT recurse into
  // history-of-history — those are always the empty [] sentinel by construction.
  const historyEntryOk = (h: unknown): boolean => {
    if (typeof h !== 'object' || h === null) return false;
    const q = h as Partial<SolitaireSnapshot>;
    if (q.kind !== 'solitaire') return false;
    const tPilesOk = Array.isArray(q.tableau) && q.tableau.length === 7
      && q.tableau.every((p) => Array.isArray(p) && p.every(tableauCardOk));
    const tFoundationsOk = Array.isArray(q.foundations) && q.foundations.length === 4
      && q.foundations.every(isDeck);
    const tDrawModeOk = q.drawMode === 1 || q.drawMode === 3;
    // Nested undoHistory sentinel: must be an empty array.
    const nestedHistoryOk = Array.isArray(q.undoHistory) && q.undoHistory.length === 0;
    return (q.player === null || typeof q.player === 'string')
      && ['waiting', 'playing', 'won'].includes(q.status as string)
      && tPilesOk
      && isDeck(q.stock)
      && isDeck(q.waste)
      && tFoundationsOk
      && Number.isInteger(q.seed)
      && Number.isInteger(q.moves) && (q.moves as number) >= 0
      && Number.isInteger(q.redeals) && (q.redeals as number) >= 0
      && tDrawModeOk
      && nestedHistoryOk;
  };
  const undoOk = Array.isArray(s.undoHistory)
    && s.undoHistory.length <= MAX_UNDO_HISTORY
    && s.undoHistory.every(historyEntryOk);
  return (s.player === null || typeof s.player === 'string')
    && ['waiting', 'playing', 'won'].includes(s.status as string)
    && pilesOk
    && isDeck(s.stock)
    && isDeck(s.waste)
    && foundationsOk
    && Number.isInteger(s.seed)
    && Number.isInteger(s.moves) && (s.moves as number) >= 0
    && Number.isInteger(s.redeals) && (s.redeals as number) >= 0
    && drawModeOk
    && undoOk;
}
