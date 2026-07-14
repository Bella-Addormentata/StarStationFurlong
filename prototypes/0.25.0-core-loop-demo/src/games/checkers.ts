/**
 * Checkers rules engine — v1 of issue #45 (brainstorming/games-plan.md).
 *
 * Pure functions over a plain-JSON CheckersState: no DOM, no THREE, no Yjs —
 * the state object is exactly what the room doc's `games` map stores (one
 * entry per game-table furniture item; see games/gamesDoc.ts), so every
 * transition here is "read state → compute NEW state → transacted write".
 *
 * RULES CHOICES (standard American checkers / English draughts — documented
 * per the #45 v1 scope decision):
 *  - 8×8 board, play on the 32 dark squares ((row+col) odd), 12 men per side.
 *  - BLACK MOVES FIRST (the standard darker-side-first rule).
 *  - CAPTURES ARE MANDATORY: when any jump is available, only jumps are legal.
 *  - MULTI-JUMPS MUST CONTINUE: after a jump, if the SAME piece can jump
 *    again the turn does not pass — `chain` pins further moves to that piece.
 *    With several capture options the mover chooses freely (American rules
 *    have no maximum-capture obligation).
 *  - CROWNING: a man reaching the far row becomes a king and THE MOVE ENDS
 *    there, even if the new king could jump onward (standard rule).
 *  - WIN: a player with no legal move on their turn loses (covers both "no
 *    pieces left" and "all pieces blocked").
 *  - NO DRAW ADJUDICATION in v1 (no 40-move rule, no threefold repetition) —
 *    stuck games end via the UI's RESET/FORFEIT. Documented scope cut.
 *
 * Board layout: 64-cell row-major array, index = row*8+col. Row 0 is the
 * BLACK home row (black men move toward +row), rows 5–7 are RED's (red men
 * move toward -row). The UI draws row 0 at the top for both players — a
 * fixed orientation, deliberately (one shared board, like a physical table).
 */

// ── Piece codes (plain numbers — JSON-friendly for the room doc) ──────────────
export const EMPTY = 0;
export const RED_MAN = 1;
export const RED_KING = 2;
export const BLACK_MAN = 3;
export const BLACK_KING = 4;

export type CheckersColor = 'red' | 'black';
export type CheckersStatus = 'waiting' | 'playing' | 'red-won' | 'black-won';

/** Doc-synced game state — plain JSON, no Y types nested inside (the same
 *  contract as the `players` map entries in main.ts). */
export interface CheckersState {
  /** 64 cells, row-major, piece codes above. */
  board: number[];
  turn: CheckersColor;
  /** Seat claims — player ids from identity.ts, first two claimants. */
  players: { red: string | null; black: string | null };
  status: CheckersStatus;
  /**
   * Cell index of a piece mid multi-jump: the turn has NOT passed and only
   * further jumps by this piece are legal. null outside a jump sequence.
   */
  chain: number | null;
  /** Single-player mode: the black seat is a trivial local AI driven by the
   *  red claimant's client (see the bot pump in devices.ts). */
  bot: boolean;
}

export interface CheckersMove {
  from: number;
  to: number;
  /** Cell index of the jumped piece, or null for a quiet move. */
  captured: number | null;
}

// ── State construction ────────────────────────────────────────────────────────

/** Fresh table: starting board, no seats claimed, waiting for players. */
export function initialState(): CheckersState {
  const board = new Array<number>(64).fill(EMPTY);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r * 8 + c] = BLACK_MAN;
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r * 8 + c] = RED_MAN;
  }
  return {
    board,
    turn: 'black', // standard rules: black opens
    players: { red: null, black: null },
    status: 'waiting',
    chain: null,
    bot: false,
  };
}

// ── Piece helpers ─────────────────────────────────────────────────────────────

export function pieceColor(v: number): CheckersColor | null {
  if (v === RED_MAN || v === RED_KING) return 'red';
  if (v === BLACK_MAN || v === BLACK_KING) return 'black';
  return null;
}

export function isKing(v: number): boolean {
  return v === RED_KING || v === BLACK_KING;
}

export function otherColor(color: CheckersColor): CheckersColor {
  return color === 'red' ? 'black' : 'red';
}

/** Diagonal step directions for a piece (men forward-only, kings both). */
function moveDirs(v: number): ReadonlyArray<readonly [number, number]> {
  switch (v) {
    case RED_MAN: return [[-1, -1], [-1, 1]];             // red climbs toward row 0
    case BLACK_MAN: return [[1, -1], [1, 1]];             // black descends toward row 7
    case RED_KING:
    case BLACK_KING: return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    default: return [];
  }
}

// ── Move generation ───────────────────────────────────────────────────────────

/** All moves for ONE piece; capturesOnly gates the quiet steps. */
function movesForPiece(board: number[], idx: number, capturesOnly: boolean): CheckersMove[] {
  const v = board[idx];
  const color = pieceColor(v);
  if (!color) return [];
  const r = Math.floor(idx / 8);
  const c = idx % 8;
  const moves: CheckersMove[] = [];
  for (const [dr, dc] of moveDirs(v)) {
    const r1 = r + dr, c1 = c + dc;
    if (r1 < 0 || r1 > 7 || c1 < 0 || c1 > 7) continue;
    const over = board[r1 * 8 + c1];
    if (over === EMPTY) {
      if (!capturesOnly) moves.push({ from: idx, to: r1 * 8 + c1, captured: null });
      continue;
    }
    if (pieceColor(over) === color) continue;
    const r2 = r + dr * 2, c2 = c + dc * 2;
    if (r2 < 0 || r2 > 7 || c2 < 0 || c2 > 7) continue;
    if (board[r2 * 8 + c2] === EMPTY) {
      moves.push({ from: idx, to: r2 * 8 + c2, captured: r1 * 8 + c1 });
    }
  }
  return moves;
}

/**
 * Every legal move for the side to move, honoring mandatory captures and a
 * live multi-jump chain. Empty array ⇔ the side to move has lost (callers
 * only ask while status === 'playing'; applyMove sets the -won status).
 */
export function legalMoves(state: CheckersState): CheckersMove[] {
  if (state.status !== 'playing') return [];
  // Mid multi-jump: only further captures by the chained piece.
  if (state.chain !== null) {
    return movesForPiece(state.board, state.chain, /* capturesOnly */ true);
  }
  const captures: CheckersMove[] = [];
  const quiet: CheckersMove[] = [];
  for (let idx = 0; idx < 64; idx++) {
    if (pieceColor(state.board[idx]) !== state.turn) continue;
    for (const m of movesForPiece(state.board, idx, false)) {
      (m.captured !== null ? captures : quiet).push(m);
    }
  }
  return captures.length > 0 ? captures : quiet; // forced-capture rule
}

/**
 * Apply a move that MUST come from legalMoves(state) — returns a NEW state
 * (inputs never mutated; the old object may still be live in a Yjs read).
 * Handles capture removal, crowning (which ends the move), chain
 * continuation, turn passing and win detection.
 */
export function applyMove(state: CheckersState, move: CheckersMove): CheckersState {
  const board = state.board.slice();
  const v = board[move.from];
  board[move.from] = EMPTY;
  if (move.captured !== null) board[move.captured] = EMPTY;

  const toRow = Math.floor(move.to / 8);
  const crowned =
    (v === RED_MAN && toRow === 0) ? RED_KING :
    (v === BLACK_MAN && toRow === 7) ? BLACK_KING :
    null;
  board[move.to] = crowned ?? v;

  // Multi-jump continuation: same piece, another capture available, and the
  // move did NOT crown (crowning ends the move — see header rules).
  if (move.captured !== null && crowned === null) {
    const more = movesForPiece(board, move.to, /* capturesOnly */ true);
    if (more.length > 0) {
      return { ...state, board, chain: move.to };
    }
  }

  // Turn passes; the mover wins if the opponent has no reply.
  const next = otherColor(state.turn);
  const handover: CheckersState = { ...state, board, turn: next, chain: null };
  if (legalMoves(handover).length === 0) {
    return { ...handover, status: state.turn === 'red' ? 'red-won' : 'black-won' };
  }
  return handover;
}

// ── Trivial AI (#45 v1 single-player) ─────────────────────────────────────────

/**
 * Random legal move, capture-preferring. Captures are already forced by
 * legalMoves when available; the explicit filter documents the preference and
 * keeps it correct if the forced-capture rule is ever made optional.
 */
export function chooseBotMove(state: CheckersState): CheckersMove | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  const captures = moves.filter((m) => m.captured !== null);
  const pool = captures.length > 0 ? captures : moves;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Shape guard (doc reads cross a trust boundary — peers write this map) ─────

/** True when a doc-read value has the CheckersState shape (defensive: any
 *  peer can write the `games` map; malformed entries render as "no game"). */
export function isCheckersState(value: unknown): value is CheckersState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<CheckersState>;
  return Array.isArray(s.board) && s.board.length === 64
    && s.board.every((v) => typeof v === 'number' && v >= EMPTY && v <= BLACK_KING)
    && (s.turn === 'red' || s.turn === 'black')
    && typeof s.players === 'object' && s.players !== null
    && ['waiting', 'playing', 'red-won', 'black-won'].includes(s.status as string)
    && (s.chain === null || typeof s.chain === 'number')
    && typeof s.bot === 'boolean';
}
