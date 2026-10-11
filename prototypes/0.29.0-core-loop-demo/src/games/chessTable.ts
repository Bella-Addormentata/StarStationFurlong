/**
 * ♟ Fully-3D chess — the pure half of playing chess ON the game table.
 *
 * Chess follows checkers (#227) off the popup: the pieces are real meshes on
 * the table's board face and every click lands on that face. This module is
 * checkersTable.ts's sibling and holds everything about that which needs no
 * DOM, THREE or Yjs:
 *
 *  - which end of the table each color plays from (the board-face geometry
 *    itself is shared with checkers — games/checkersTable.ts cellFromUV /
 *    cellCenterLocal — one 8×8 face, one picker);
 *  - the seat / bot / forfeit / reset transitions the old chess panel ran
 *    inline;
 *  - `clickChessCell`, the whole click rule: before a game, clicking a piece
 *    takes that side; on your turn, click a piece then a destination
 *    (promotion uses the caller's chosen piece, queen by default);
 *  - the local move marks and the status line.
 *
 * Every transition returns a NEW ChessState (or null for "nothing to write"),
 * the games/chess.ts contract. The stored state format is untouched.
 */

import {
  applyChessMove,
  chessPieceColor,
  inCheck,
  initialChessState,
  legalChessMoves,
  otherChessColor,
  B_KING,
  W_KING,
} from './chess';
import type { ChessColor, ChessPromotion, ChessState } from './chess';
import type { BoardMarks } from './checkersTable';

/** Promotion choices, in the order the ⚙ card offers them. */
export const PROMOTION_CHOICES: readonly ChessPromotion[] = ['queen', 'rook', 'bishop', 'knight'];
/** What a pawn becomes when the player has not picked otherwise. */
export const DEFAULT_PROMOTION: ChessPromotion = 'queen';

/** Which end of the table a color plays from: white's home rank (row 7)
 *  sits at the device front (−z), black's (row 0) at the far end (+z) — the
 *  same lay-down as checkers' red/black. Matches furniture.ts
 *  gameTableStands (s0 at −z, s1 at +z). */
export function chessStandIndexFor(color: ChessColor): 0 | 1 {
  return color === 'white' ? 0 : 1;
}

/** The six piece shapes, in board-code order (|code| − 1). */
export const CHESS_PIECE_TYPES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as const;
export type ChessPieceType = (typeof CHESS_PIECE_TYPES)[number];

/** A board code's 3D piece: its shape and color, or null for an empty or
 *  junk cell (a malformed peer board must not index past the meshes). */
export function chessPieceOf(v: number): { type: ChessPieceType; color: ChessColor } | null {
  const color = chessPieceColor(v);
  const type = CHESS_PIECE_TYPES[Math.abs(v) - 1];
  return color && type && Number.isInteger(v) ? { type, color } : null;
}

// ── Seats and turns ───────────────────────────────────────────────────────────

export function chessSeatOf(s: ChessState, myId: string): ChessColor | null {
  return s.players.white === myId ? 'white' : s.players.black === myId ? 'black' : null;
}

/** May `myId` move right now (seated, their turn, and not the bot's side)? */
export function isMyChessTurn(s: ChessState, myId: string): boolean {
  const seat = chessSeatOf(s, myId);
  return s.status === 'playing' && seat !== null && s.turn === seat
    && !(s.bot && s.turn === 'black');
}

/** Can `myId` sit as `color` (pre-game, open, not already the other side)? */
export function canClaimChess(s: ChessState, color: ChessColor, myId: string): boolean {
  return s.status === 'waiting'
    && s.players[color] === null
    && !(s.bot && color === 'black')
    && s.players[otherChessColor(color)] !== myId;
}

/** Take a side. Both seats filled starts the game. */
export function claimChessSide(s: ChessState, color: ChessColor, myId: string): ChessState | null {
  if (!canClaimChess(s, color, myId)) return null;
  const players = { ...s.players, [color]: myId };
  const status = players.white && players.black ? 'playing' as const : s.status;
  return { ...s, players, status };
}

/** Is VS BOT on offer to `myId` (black open, white open or theirs)? */
export function canStartChessBot(s: ChessState, myId: string): boolean {
  return s.status === 'waiting' && s.players.black === null
    && (s.players.white === null || s.players.white === myId);
}

/** Single-player: `myId` plays white, the trivial bot holds black. */
export function startChessBot(s: ChessState, myId: string): ChessState | null {
  if (!canStartChessBot(s, myId)) return null;
  return { ...s, players: { ...s.players, white: myId }, bot: true, status: 'playing' };
}

/** Concede: the other side wins. Seated players only, mid-game only. */
export function forfeitChess(s: ChessState, myId: string): ChessState | null {
  if (s.status !== 'playing') return null;
  const seat = chessSeatOf(s, myId);
  if (!seat) return null;
  return { ...s, status: seat === 'white' ? 'black-won' : 'white-won' };
}

/**
 * RESET gate (the old panel's chess rule, with the owner check moved onto
 * the room's shared edit gate as checkers did): anyone once the game is
 * over, vs the bot, or while neither side is claimed; seated players or
 * whoever may edit the room (editMode.canEditRoom) once a side is claimed.
 */
export function canResetChessTable(s: ChessState | null, myId: string, mayEditRoom: boolean): boolean {
  if (!s) return false;
  if (s.status !== 'waiting' && s.status !== 'playing') return true;
  if (s.bot) return true;
  // Before the game, anyone may clear an empty table, but not a side
  // someone has already claimed while they wait for an opponent.
  if (s.status === 'waiting' && !s.players.white && !s.players.black) return true;
  return chessSeatOf(s, myId) !== null || mayEditRoom;
}

// ── The click rule ────────────────────────────────────────────────────────────

export interface ChessClickResult {
  /** New state to write, or null for a local-only change. */
  write: ChessState | null;
  /** The local selection after the click (never written to the doc). */
  selected: number | null;
}

/**
 * One click on cell `idx` of the 3D board.
 *  - Waiting: clicking a piece takes that piece's side.
 *  - Playing, my turn: a selected piece + one of its destinations moves
 *    (castling = click the king then its two-step square; en passant = click
 *    the pawn then the empty target square; a promotion becomes `promotion`);
 *    clicking another movable piece reselects; anything else clears.
 *  - Otherwise (spectating, off-turn, finished): nothing.
 */
export function clickChessCell(
  s: ChessState | null,
  myId: string,
  selected: number | null,
  idx: number,
  promotion: ChessPromotion = DEFAULT_PROMOTION,
): ChessClickResult {
  const state = s ?? initialChessState();
  if (!Number.isInteger(idx) || idx < 0 || idx > 63) return { write: null, selected };
  if (state.status === 'waiting') {
    const color = chessPieceColor(state.board[idx]);
    return { write: color ? claimChessSide(state, color, myId) : null, selected: null };
  }
  if (!isMyChessTurn(state, myId)) return { write: null, selected: null };
  const moves = legalChessMoves(state);
  if (selected !== null) {
    const move = moves.find((m) => m.from === selected && m.to === idx);
    if (move) {
      const next = applyChessMove(
        state,
        move.special === 'promote' ? { ...move, promoteTo: promotion } : move,
      );
      return { write: next, selected: null };
    }
  }
  const pick = chessPieceColor(state.board[idx]) === state.turn && moves.some((m) => m.from === idx);
  return { write: null, selected: pick ? idx : null };
}

/** The selection that survives a doc change: kept while it is still one of
 *  my movable pieces, else nothing (an opponent move, a reset, the bot). */
export function pruneChessSelection(s: ChessState | null, myId: string, selected: number | null): number | null {
  if (!s || selected === null || !isMyChessTurn(s, myId)) return null;
  return legalChessMoves(s).some((m) => m.from === selected) ? selected : null;
}

/** Local board highlights for the painter (same shape as checkers'). */
export function chessBoardMarks(
  s: ChessState | null,
  myId: string,
  selected: number | null,
  hover: number | null,
): BoardMarks {
  const none: BoardMarks = { selected: null, targets: [], movable: [], hover: null };
  if (!s) return none;
  if (s.status === 'waiting') {
    const color = hover !== null ? chessPieceColor(s.board[hover]) : null;
    return { ...none, hover: color && canClaimChess(s, color, myId) ? hover : null };
  }
  if (!isMyChessTurn(s, myId)) return none;
  const moves = legalChessMoves(s);
  const movable = [...new Set(moves.map((m) => m.from))];
  const targets = selected !== null ? moves.filter((m) => m.from === selected).map((m) => m.to) : [];
  const live = hover !== null && (movable.includes(hover) || targets.includes(hover)) ? hover : null;
  return { selected, targets, movable, hover: live };
}

/** The checked king's square while a game runs, else null — painted for
 *  everyone with the last-move echo. */
export function checkSquare(s: ChessState | null): number | null {
  if (!s || s.status !== 'playing' || !inCheck(s.board, s.turn)) return null;
  const k = s.board.indexOf(s.turn === 'white' ? W_KING : B_KING);
  return k >= 0 ? k : null;
}

/** One-line status for the HUD strip. */
export function chessStatusLine(s: ChessState | null, myId: string): string {
  if (!s) return 'CHESS';
  if (s.status === 'waiting') {
    const open = (['white', 'black'] as const).filter((c) => canClaimChess(s, c, myId));
    if (open.length === 2) return 'CLICK A WHITE OR BLACK PIECE TO TAKE THAT SIDE';
    if (open.length === 1) return `CLICK A ${open[0].toUpperCase()} PIECE TO TAKE THAT SIDE`;
    return 'WAITING FOR AN OPPONENT';
  }
  // (A forfeit lands on the same statuses, so no "checkmate" claim here.)
  if (s.status === 'white-won') return 'WHITE WINS';
  if (s.status === 'black-won') return 'BLACK WINS';
  if (s.status === 'draw') return 'DRAW — STALEMATE';
  const yours = isMyChessTurn(s, myId) ? ' · YOUR MOVE' : '';
  const check = inCheck(s.board, s.turn) ? ' · CHECK' : '';
  return `${s.turn.toUpperCase()} TO MOVE${yours}${check}`;
}
