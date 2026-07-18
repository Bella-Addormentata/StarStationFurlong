/**
 * Chess rules engine — issue #45 (the board face's second game).
 *
 * Same discipline as checkers.ts: pure functions over a plain-JSON ChessState
 * (no DOM, no THREE, no Yjs) — the state object is exactly what the room
 * doc's `games` map stores, every transition is "read → compute NEW state →
 * transacted write", and a `kind: 'chess'` discriminator tells the table UI
 * which game lives on a table (legacy kind-less entries are checkers).
 *
 * RULES (full standard chess, with two documented v1 scope choices):
 *  - All piece moves, castling (rights tracked; no castling out of / through /
 *    into check), en passant, pawn promotion (AUTO-QUEEN in v1 — an
 *    under-promotion picker is UI noise the game doesn't need yet).
 *  - CHECK is annotated for the UI; moving into check is illegal (legalMoves
 *    filters king safety).
 *  - END: checkmate → winner; stalemate → draw. NO 50-move rule / threefold
 *    repetition in v1 (same cut as checkers — stuck games end via RESET).
 *  - WHITE MOVES FIRST. Row 0 is BLACK's home rank (the UI draws it at the
 *    top for both players — one shared board, like a physical table).
 */

// ── Piece codes: positive white, negative black (JSON-friendly ints) ─────────
export const W_PAWN = 1, W_KNIGHT = 2, W_BISHOP = 3, W_ROOK = 4, W_QUEEN = 5, W_KING = 6;
export const B_PAWN = -1, B_KNIGHT = -2, B_BISHOP = -3, B_ROOK = -4, B_QUEEN = -5, B_KING = -6;

export type ChessColor = 'white' | 'black';
export type ChessStatus = 'waiting' | 'playing' | 'white-won' | 'black-won' | 'draw';

export interface ChessState {
  kind: 'chess';
  /** 64 cells row-major; row 0 = black home rank, row 7 = white home rank. */
  board: number[];
  turn: ChessColor;
  players: { white: string | null; black: string | null };
  status: ChessStatus;
  /** Castling rights still available (rook/king unmoved). */
  castling: { wk: boolean; wq: boolean; bk: boolean; bq: boolean };
  /** En-passant TARGET square (behind a just-double-stepped pawn), or null. */
  enPassant: number | null;
  /** Single-player: black is a trivial local AI (the white claimant pumps it). */
  bot: boolean;
  /** Last move made (UI highlight); null on a fresh board. */
  last: { from: number; to: number } | null;
}

export interface ChessMove {
  from: number;
  to: number;
  /** Marks the special mechanics applyMove must perform. */
  special?: 'castle-k' | 'castle-q' | 'en-passant' | 'promote';
}

// ── Construction ─────────────────────────────────────────────────────────────

export function initialChessState(): ChessState {
  const board = new Array<number>(64).fill(0);
  const back = [4, 2, 3, 5, 6, 3, 2, 4]; // R N B Q K B N R
  for (let c = 0; c < 8; c++) {
    board[0 * 8 + c] = -back[c];  // black back rank
    board[1 * 8 + c] = B_PAWN;
    board[6 * 8 + c] = W_PAWN;
    board[7 * 8 + c] = back[c];   // white back rank
  }
  return {
    kind: 'chess',
    board,
    turn: 'white',
    players: { white: null, black: null },
    status: 'waiting',
    castling: { wk: true, wq: true, bk: true, bq: true },
    enPassant: null,
    bot: false,
    last: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function chessPieceColor(v: number): ChessColor | null {
  return v > 0 ? 'white' : v < 0 ? 'black' : null;
}

export function otherChessColor(c: ChessColor): ChessColor {
  return c === 'white' ? 'black' : 'white';
}

const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]] as const;
const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]] as const;
const ROOK_D = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
const BISHOP_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const;

function on(r: number, c: number): boolean {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

/** Is `square` attacked by `by`? (Board-only — en passant can't attack a square.) */
export function isAttacked(board: number[], square: number, by: ChessColor): boolean {
  const r = Math.floor(square / 8), c = square % 8;
  const sign = by === 'white' ? 1 : -1;
  // Pawns: white attacks toward -row, black toward +row.
  const pr = r + (by === 'white' ? 1 : -1);
  for (const dc of [-1, 1]) {
    if (on(pr, c + dc) && board[pr * 8 + c + dc] === sign * W_PAWN) return true;
  }
  for (const [dr, dc] of KNIGHT_D) {
    if (on(r + dr, c + dc) && board[(r + dr) * 8 + c + dc] === sign * W_KNIGHT) return true;
  }
  for (const [dr, dc] of KING_D) {
    if (on(r + dr, c + dc) && board[(r + dr) * 8 + c + dc] === sign * W_KING) return true;
  }
  for (const [dr, dc] of ROOK_D) {
    for (let i = 1; i < 8; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (!on(rr, cc)) break;
      const v = board[rr * 8 + cc];
      if (v === 0) continue;
      if (v === sign * W_ROOK || v === sign * W_QUEEN) return true;
      break;
    }
  }
  for (const [dr, dc] of BISHOP_D) {
    for (let i = 1; i < 8; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (!on(rr, cc)) break;
      const v = board[rr * 8 + cc];
      if (v === 0) continue;
      if (v === sign * W_BISHOP || v === sign * W_QUEEN) return true;
      break;
    }
  }
  return false;
}

function kingSquare(board: number[], color: ChessColor): number {
  const k = color === 'white' ? W_KING : B_KING;
  for (let i = 0; i < 64; i++) if (board[i] === k) return i;
  return -1; // malformed board (shape guard keeps kings present in practice)
}

/** Is `color`'s king in check on this board? */
export function inCheck(board: number[], color: ChessColor): boolean {
  const k = kingSquare(board, color);
  return k >= 0 && isAttacked(board, k, otherChessColor(color));
}

// ── Move generation ──────────────────────────────────────────────────────────

/** Pseudo-legal moves for one piece (king safety filtered by legalChessMoves). */
function pseudoMoves(s: ChessState, idx: number): ChessMove[] {
  const v = s.board[idx];
  const color = chessPieceColor(v);
  if (!color) return [];
  const r = Math.floor(idx / 8), c = idx % 8;
  const moves: ChessMove[] = [];
  const mine = (t: number) => chessPieceColor(t) === color;
  const abs = Math.abs(v);

  if (abs === W_PAWN) {
    const dir = color === 'white' ? -1 : 1;
    const startRow = color === 'white' ? 6 : 1;
    const promoRow = color === 'white' ? 0 : 7;
    // Forward one / two.
    if (on(r + dir, c) && s.board[(r + dir) * 8 + c] === 0) {
      moves.push({ from: idx, to: (r + dir) * 8 + c, special: r + dir === promoRow ? 'promote' : undefined });
      if (r === startRow && s.board[(r + dir * 2) * 8 + c] === 0) {
        moves.push({ from: idx, to: (r + dir * 2) * 8 + c });
      }
    }
    // Captures + en passant.
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!on(rr, cc)) continue;
      const t = rr * 8 + cc;
      if (s.board[t] !== 0 && !mine(s.board[t])) {
        moves.push({ from: idx, to: t, special: rr === promoRow ? 'promote' : undefined });
      } else if (s.enPassant === t) {
        moves.push({ from: idx, to: t, special: 'en-passant' });
      }
    }
    return moves;
  }

  if (abs === W_KNIGHT || abs === W_KING) {
    for (const [dr, dc] of abs === W_KNIGHT ? KNIGHT_D : KING_D) {
      const rr = r + dr, cc = c + dc;
      if (!on(rr, cc)) continue;
      const t = rr * 8 + cc;
      if (!mine(s.board[t])) moves.push({ from: idx, to: t });
    }
    if (abs === W_KING) {
      // Castling: rights + empty lane + not out of/through check (into-check
      // is filtered with every other move by the king-safety pass).
      const home = color === 'white' ? 7 : 0;
      const kIdx = home * 8 + 4;
      if (idx === kIdx && !inCheck(s.board, color)) {
        const enemy = otherChessColor(color);
        const canK = color === 'white' ? s.castling.wk : s.castling.bk;
        const canQ = color === 'white' ? s.castling.wq : s.castling.bq;
        if (canK
          && s.board[home * 8 + 5] === 0 && s.board[home * 8 + 6] === 0
          && !isAttacked(s.board, home * 8 + 5, enemy)) {
          moves.push({ from: idx, to: home * 8 + 6, special: 'castle-k' });
        }
        if (canQ
          && s.board[home * 8 + 3] === 0 && s.board[home * 8 + 2] === 0 && s.board[home * 8 + 1] === 0
          && !isAttacked(s.board, home * 8 + 3, enemy)) {
          moves.push({ from: idx, to: home * 8 + 2, special: 'castle-q' });
        }
      }
    }
    return moves;
  }

  // Sliders.
  const dirs = abs === W_ROOK ? ROOK_D : abs === W_BISHOP ? BISHOP_D : [...ROOK_D, ...BISHOP_D];
  for (const [dr, dc] of dirs) {
    for (let i = 1; i < 8; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (!on(rr, cc)) break;
      const t = rr * 8 + cc;
      if (s.board[t] === 0) { moves.push({ from: idx, to: t }); continue; }
      if (!mine(s.board[t])) moves.push({ from: idx, to: t });
      break;
    }
  }
  return moves;
}

/** Board after mechanically performing a move (no legality/status logic). */
function performOnBoard(s: ChessState, move: ChessMove): number[] {
  const board = s.board.slice();
  const v = board[move.from];
  board[move.from] = 0;
  board[move.to] = v;
  if (move.special === 'promote') {
    board[move.to] = v > 0 ? W_QUEEN : B_QUEEN; // v1: auto-queen (documented)
  } else if (move.special === 'en-passant') {
    const dir = v > 0 ? 1 : -1; // captured pawn sits BEHIND the target square
    board[move.to + dir * 8] = 0;
  } else if (move.special === 'castle-k') {
    const home = v > 0 ? 7 : 0;
    board[home * 8 + 5] = board[home * 8 + 7];
    board[home * 8 + 7] = 0;
  } else if (move.special === 'castle-q') {
    const home = v > 0 ? 7 : 0;
    board[home * 8 + 3] = board[home * 8 + 0];
    board[home * 8 + 0] = 0;
  }
  return board;
}

/** Every legal move for the side to move (king safety enforced). */
export function legalChessMoves(s: ChessState): ChessMove[] {
  if (s.status !== 'playing') return [];
  const out: ChessMove[] = [];
  for (let idx = 0; idx < 64; idx++) {
    if (chessPieceColor(s.board[idx]) !== s.turn) continue;
    for (const m of pseudoMoves(s, idx)) {
      if (!inCheck(performOnBoard(s, m), s.turn)) out.push(m);
    }
  }
  return out;
}

/**
 * Apply a move that MUST come from legalChessMoves — returns a NEW state:
 * rights/en-passant bookkeeping, turn passing, checkmate/stalemate detection.
 */
export function applyChessMove(s: ChessState, move: ChessMove): ChessState {
  const board = performOnBoard(s, move);
  const v = s.board[move.from];
  const castling = { ...s.castling };
  // King moves burn both rights; rook moves/captures burn their side's.
  if (v === W_KING) { castling.wk = false; castling.wq = false; }
  if (v === B_KING) { castling.bk = false; castling.bq = false; }
  const touch = (sq: number) => {
    if (sq === 7 * 8 + 7) castling.wk = false;
    if (sq === 7 * 8 + 0) castling.wq = false;
    if (sq === 0 * 8 + 7) castling.bk = false;
    if (sq === 0 * 8 + 0) castling.bq = false;
  };
  touch(move.from);
  touch(move.to);
  // Double pawn step opens an en-passant window for exactly one reply.
  const enPassant = Math.abs(v) === W_PAWN && Math.abs(move.to - move.from) === 16
    ? (move.from + move.to) / 2
    : null;

  const next = otherChessColor(s.turn);
  const handover: ChessState = {
    ...s, board, castling, enPassant, turn: next, last: { from: move.from, to: move.to },
  };
  if (legalChessMoves(handover).length === 0) {
    if (inCheck(board, next)) {
      return { ...handover, status: s.turn === 'white' ? 'white-won' : 'black-won' };
    }
    return { ...handover, status: 'draw' }; // stalemate
  }
  return handover;
}

// ── Trivial AI (capture-preferring random, checkers-bot sibling) ─────────────

export function chooseChessBotMove(s: ChessState): ChessMove | null {
  const moves = legalChessMoves(s);
  if (moves.length === 0) return null;
  const captures = moves.filter((m) => s.board[m.to] !== 0 || m.special === 'en-passant');
  const pool = captures.length > 0 ? captures : moves;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Shape guard (doc reads cross a trust boundary) ───────────────────────────

export function isChessState(value: unknown): value is ChessState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<ChessState>;
  if (s.kind !== 'chess') return false;
  const playerOk = (p: unknown) => p === null || typeof p === 'string';
  const cast = s.castling as Partial<ChessState['castling']> | undefined;
  return Array.isArray(s.board) && s.board.length === 64
    && s.board.every((v) => Number.isInteger(v) && (v as number) >= B_KING && (v as number) <= W_KING)
    && (s.turn === 'white' || s.turn === 'black')
    && typeof s.players === 'object' && s.players !== null
    && playerOk(s.players.white) && playerOk(s.players.black)
    && ['waiting', 'playing', 'white-won', 'black-won', 'draw'].includes(s.status as string)
    && !!cast && typeof cast.wk === 'boolean' && typeof cast.wq === 'boolean'
    && typeof cast.bk === 'boolean' && typeof cast.bq === 'boolean'
    && (s.enPassant === null || (Number.isInteger(s.enPassant) && (s.enPassant as number) >= 0 && (s.enPassant as number) < 64))
    && typeof s.bot === 'boolean'
    && (s.last === null || (typeof s.last === 'object' && s.last !== null
      && Number.isInteger((s.last as { from: unknown }).from) && Number.isInteger((s.last as { to: unknown }).to)));
}
