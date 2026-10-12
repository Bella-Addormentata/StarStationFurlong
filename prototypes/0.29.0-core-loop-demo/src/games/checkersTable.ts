/**
 * 🎲 Fully-3D checkers (#227) — the pure half of playing ON the table.
 *
 * Issue #227 retires the checkers popup: the pieces are real meshes on the
 * game table's board face and every click lands on that face. This module
 * holds everything about that which needs no DOM, THREE or Yjs, so it can be
 * tested directly:
 *
 *  - the board-face geometry (texture pixels ↔ cells ↔ table-local metres),
 *    shared by the builder's painter, its 3D pieces and the click picker so
 *    the three can never disagree about where a square is;
 *  - the seat / bot / forfeit / reset transitions the old popup ran inline;
 *  - `clickCell`, the whole click rule: before a game, clicking a piece takes
 *    that side; on your turn, click a piece then a destination.
 *
 * Every transition returns a NEW CheckersState (or null for "nothing to
 * write"), the games/checkers.ts contract.
 */

import { initialState, legalMoves, applyMove, pieceColor, otherColor } from './checkers';
import type { CheckersColor, CheckersState } from './checkers';

// ── Board-face geometry ───────────────────────────────────────────────────────

/** Board texture size (px, square). */
export const BOARD_TEX_PX = 512;
/** Frame width around the 8×8 squares (px). */
export const BOARD_PAD_PX = 32;
/** One square (px): (512 − 2·32) / 8 = 56. */
export const BOARD_SQ_PX = (BOARD_TEX_PX - BOARD_PAD_PX * 2) / 8;
/** Side of the board plane on the table top (m) — the texture spans it. */
export const BOARD_SIZE_M = 0.74;
/** One square on the table (m). */
export const BOARD_SQ_M = (BOARD_SQ_PX / BOARD_TEX_PX) * BOARD_SIZE_M;

/**
 * Cell under a board-plane UV (three.js intersection.uv), or null on the
 * frame / off the board. A CanvasTexture flips Y, so canvas y = (1 − v)·512.
 */
export function cellFromUV(u: number, v: number): number | null {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  const c = Math.floor((u * BOARD_TEX_PX - BOARD_PAD_PX) / BOARD_SQ_PX);
  const r = Math.floor(((1 - v) * BOARD_TEX_PX - BOARD_PAD_PX) / BOARD_SQ_PX);
  if (r < 0 || r > 7 || c < 0 || c > 7) return null;
  return r * 8 + c;
}

/**
 * Centre of a cell in TABLE-TOP-LOCAL metres (the flippable top group's
 * frame, board face up). The builder lays the plane with rotateX(−π/2) then
 * rotateY(π), so canvas-up (row 0) lands at +z — away from the device front
 * at −z — and canvas-left (col 0) at +x, the front viewer's left.
 */
export function cellCenterLocal(idx: number): { x: number; z: number } {
  const r = Math.floor(idx / 8);
  const c = idx % 8;
  const u = (BOARD_PAD_PX + (c + 0.5) * BOARD_SQ_PX) / BOARD_TEX_PX;
  const v = 1 - (BOARD_PAD_PX + (r + 0.5) * BOARD_SQ_PX) / BOARD_TEX_PX;
  return { x: -(u - 0.5) * BOARD_SIZE_M, z: (v - 0.5) * BOARD_SIZE_M };
}

/** Which end of the table a color plays from: red's home rows (5–7) sit at
 *  the device front (−z), black's (0–2) at the far end (+z). The stand index
 *  matches furniture.ts gameTableStands (s0 at −z, s1 at +z). */
export function standIndexFor(color: CheckersColor): 0 | 1 {
  return color === 'red' ? 0 : 1;
}

// ── Seats and turns ───────────────────────────────────────────────────────────

export function seatOf(s: CheckersState, myId: string): CheckersColor | null {
  return s.players.red === myId ? 'red' : s.players.black === myId ? 'black' : null;
}

/** May `myId` move right now (seated, their turn, and not the bot's side)? */
export function isMyTurn(s: CheckersState, myId: string): boolean {
  const seat = seatOf(s, myId);
  return s.status === 'playing' && seat !== null && s.turn === seat
    && !(s.bot && s.turn === 'black');
}

/** Can `myId` sit as `color` (pre-game, open, not already the other side)? */
export function canClaim(s: CheckersState, color: CheckersColor, myId: string): boolean {
  return s.status === 'waiting'
    && s.players[color] === null
    && !(s.bot && color === 'black')
    && s.players[otherColor(color)] !== myId;
}

/** Take a side. Both seats filled starts the game. */
export function claimSide(s: CheckersState, color: CheckersColor, myId: string): CheckersState | null {
  if (!canClaim(s, color, myId)) return null;
  const players = { ...s.players, [color]: myId };
  const status = players.red && players.black ? 'playing' as const : s.status;
  return { ...s, players, status };
}

/** Is VS BOT on offer to `myId` (black open, red open or theirs)? */
export function canStartBot(s: CheckersState, myId: string): boolean {
  return s.status === 'waiting' && s.players.black === null
    && (s.players.red === null || s.players.red === myId);
}

/** Single-player: `myId` plays red, the trivial bot holds black. */
export function startBot(s: CheckersState, myId: string): CheckersState | null {
  if (!canStartBot(s, myId)) return null;
  return { ...s, players: { ...s.players, red: myId }, bot: true, status: 'playing' };
}

/** Concede: the other side wins. Seated players only, mid-game only. */
export function forfeit(s: CheckersState, myId: string): CheckersState | null {
  if (s.status !== 'playing') return null;
  const seat = seatOf(s, myId);
  if (!seat) return null;
  return { ...s, status: seat === 'red' ? 'black-won' : 'red-won', chain: null };
}

/**
 * RESET gate: anyone once the game is over or vs the bot (the bot holds no
 * real seat, so a departed red claimant must not pin the table — review F5
 * of #45); seated players or whoever may edit the room otherwise.
 * `mayEditRoom` is the shared ownership gate (editMode.canEditRoom), the same
 * one air hockey and alligators reset through, so a legacy room stays
 * read-only and venture shareholders count (#141).
 */
export function canResetTable(s: CheckersState | null, myId: string, mayEditRoom: boolean): boolean {
  if (!s) return false;
  if (s.status === 'red-won' || s.status === 'black-won') return true;
  if (s.bot) return true;
  return seatOf(s, myId) !== null || mayEditRoom;
}

// ── The click rule ────────────────────────────────────────────────────────────

export interface ClickResult {
  /** New state to write, or null for a local-only change. */
  write: CheckersState | null;
  /** The local selection after the click (never written to the doc). */
  selected: number | null;
}

/**
 * One click on cell `idx` of the 3D board.
 *  - Waiting: clicking a piece takes that piece's side.
 *  - Playing, my turn: a selected piece + one of its destinations moves (a
 *    multi-jump keeps the chained piece selected); clicking another movable
 *    piece reselects; anything else clears the selection.
 *  - Otherwise (spectating, off-turn, finished): nothing.
 */
export function clickCell(
  s: CheckersState | null,
  myId: string,
  selected: number | null,
  idx: number,
): ClickResult {
  const state = s ?? initialState();
  if (idx < 0 || idx > 63) return { write: null, selected };
  if (state.status === 'waiting') {
    const color = pieceColor(state.board[idx]);
    return { write: color ? claimSide(state, color, myId) : null, selected: null };
  }
  if (!isMyTurn(state, myId)) return { write: null, selected: null };
  const moves = legalMoves(state);
  if (selected !== null) {
    const move = moves.find((m) => m.from === selected && m.to === idx);
    if (move) {
      const next = applyMove(state, move);
      return { write: next, selected: next.chain };
    }
  }
  const pick = pieceColor(state.board[idx]) === state.turn && moves.some((m) => m.from === idx);
  return { write: null, selected: pick ? idx : null };
}

/**
 * The selection that survives a doc change: kept while it is still one of my
 * movable pieces, else the live chain piece (a multi-jump in progress), else
 * nothing (an opponent move, a reset, the bot's reply).
 */
export function pruneSelection(s: CheckersState | null, myId: string, selected: number | null): number | null {
  if (!s || !isMyTurn(s, myId)) return null;
  if (selected !== null && legalMoves(s).some((m) => m.from === selected)) return selected;
  return s.chain;
}

/** Local board highlights for the painter: what to draw for `myId`. */
export interface BoardMarks {
  /** The selected piece's cell. */
  selected: number | null;
  /** Legal destinations of the selected piece. */
  targets: number[];
  /** Pieces that can move this turn (forced captures shown honestly). */
  movable: number[];
  /** Cell under the pointer, when clicking it would do something. */
  hover: number | null;
}

export function boardMarks(
  s: CheckersState | null,
  myId: string,
  selected: number | null,
  hover: number | null,
): BoardMarks {
  const none: BoardMarks = { selected: null, targets: [], movable: [], hover: null };
  if (!s) return none;
  if (s.status === 'waiting') {
    // Pre-game: hover a piece of a side you could take.
    const color = hover !== null ? pieceColor(s.board[hover]) : null;
    return { ...none, hover: color && canClaim(s, color, myId) ? hover : null };
  }
  if (!isMyTurn(s, myId)) return none;
  const moves = legalMoves(s);
  const movable = [...new Set(moves.map((m) => m.from))];
  const targets = selected !== null ? moves.filter((m) => m.from === selected).map((m) => m.to) : [];
  const live = hover !== null && (movable.includes(hover) || targets.includes(hover)) ? hover : null;
  return { selected, targets, movable, hover: live };
}

/** One-line status for the HUD strip. */
export function statusLine(s: CheckersState | null, myId: string): string {
  if (!s) return 'CHECKERS';
  if (s.status === 'waiting') {
    const open = (['red', 'black'] as const).filter((c) => canClaim(s, c, myId));
    if (open.length === 2) return 'CLICK A RED OR BLACK PIECE TO TAKE THAT SIDE';
    if (open.length === 1) return `CLICK A ${open[0].toUpperCase()} PIECE TO TAKE THAT SIDE`;
    return 'WAITING FOR AN OPPONENT';
  }
  if (s.status === 'red-won') return 'RED WINS';
  if (s.status === 'black-won') return 'BLACK WINS';
  const yours = isMyTurn(s, myId) ? ' · YOUR MOVE' : '';
  const chain = s.chain !== null ? ' · KEEP JUMPING WITH THE SAME PIECE' : '';
  return `${s.turn.toUpperCase()} TO MOVE${yours}${chain}`;
}
