import { describe, expect, it } from 'vitest';
import {
  applyChessMove,
  initialChessState,
  isChessState,
  legalChessMoves,
  B_KING,
  B_PAWN,
  B_ROOK,
  W_BISHOP,
  W_KING,
  W_KNIGHT,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
} from './chess';
import type { ChessState } from './chess';
import { cellCenterLocal } from './checkersTable';
import {
  CHESS_PIECE_TYPES,
  DEFAULT_PROMOTION,
  canResetChessTable,
  checkSquare,
  chessBoardMarks,
  chessPieceOf,
  chessStandIndexFor,
  chessStatusLine,
  claimChessSide,
  clickChessCell,
  forfeitChess,
  pruneChessSelection,
  startChessBot,
} from './chessTable';

const WHITE = 'player-white';
const BLACK = 'player-black';
const STRANGER = 'player-stranger';

const sq = (file: string, rank: number): number => (8 - rank) * 8 + (file.charCodeAt(0) - 97);

function playing(): ChessState {
  return { ...initialChessState(), players: { white: WHITE, black: BLACK }, status: 'playing' };
}

/** A playing state on a custom board (kings in the corners unless given). */
function withBoard(cells: Record<number, number>, extra: Partial<ChessState> = {}): ChessState {
  const board = new Array<number>(64).fill(0);
  for (const [k, v] of Object.entries(cells)) board[Number(k)] = v;
  return {
    ...playing(),
    board,
    castling: { wk: false, wq: false, bk: false, bq: false },
    ...extra,
  };
}

describe('ends and pieces', () => {
  it('seats white at the −z end (its home rank) and black at +z', () => {
    expect(chessStandIndexFor('white')).toBe(0);
    expect(chessStandIndexFor('black')).toBe(1);
    // Row 7 (white home) lies toward −z on the shared board face.
    expect(cellCenterLocal(sq('e', 1)).z).toBeLessThan(0);
    expect(cellCenterLocal(sq('e', 8)).z).toBeGreaterThan(0);
  });

  it('maps every board code to one of six shapes and junk to nothing', () => {
    expect(chessPieceOf(W_PAWN)).toEqual({ type: 'pawn', color: 'white' });
    expect(chessPieceOf(B_KING)).toEqual({ type: 'king', color: 'black' });
    expect(chessPieceOf(W_KNIGHT)?.type).toBe('knight');
    expect(chessPieceOf(0)).toBeNull();
    expect(chessPieceOf(7)).toBeNull();
    expect(chessPieceOf(1.5)).toBeNull();
    expect(new Set(CHESS_PIECE_TYPES).size).toBe(6);
  });
});

describe('taking a side by clicking a piece', () => {
  it('claims the clicked piece\'s color and starts once both are taken', () => {
    const a = clickChessCell(initialChessState(), WHITE, null, sq('e', 2));
    expect(a.write?.players.white).toBe(WHITE);
    expect(a.write?.status).toBe('waiting');
    const b = clickChessCell(a.write, BLACK, null, sq('d', 8));
    expect(b.write?.players.black).toBe(BLACK);
    expect(b.write?.status).toBe('playing');
  });

  it('does nothing on an empty square, a taken side, or a second seat', () => {
    expect(clickChessCell(initialChessState(), WHITE, null, sq('e', 4)).write).toBeNull();
    const s = claimChessSide(initialChessState(), 'white', WHITE)!;
    expect(clickChessCell(s, STRANGER, null, sq('a', 2)).write).toBeNull();
    expect(clickChessCell(s, WHITE, null, sq('a', 7)).write).toBeNull();
  });

  it('keeps black for the bot', () => {
    const s = startChessBot(initialChessState(), WHITE)!;
    expect(s).toMatchObject({ bot: true, status: 'playing', players: { white: WHITE, black: null } });
    expect(startChessBot(claimChessSide(initialChessState(), 'white', WHITE)!, STRANGER)).toBeNull();
  });
});

describe('moving on your turn', () => {
  it('selects a movable piece, then moves it to a legal destination', () => {
    const s = playing();
    const pick = clickChessCell(s, WHITE, null, sq('e', 2));
    expect(pick).toEqual({ write: null, selected: sq('e', 2) });
    const go = clickChessCell(s, WHITE, pick.selected, sq('e', 4));
    expect(go.write?.board[sq('e', 4)]).toBe(W_PAWN);
    expect(go.write?.turn).toBe('black');
    expect(go.write?.enPassant).toBe(sq('e', 3));
    expect(go.selected).toBeNull();
  });

  it('ignores off-turn clicks, spectators, and illegal destinations', () => {
    const s = playing();
    expect(clickChessCell(s, BLACK, null, sq('e', 7))).toEqual({ write: null, selected: null });
    expect(clickChessCell(s, STRANGER, null, sq('e', 2))).toEqual({ write: null, selected: null });
    const bad = clickChessCell(s, WHITE, sq('e', 2), sq('e', 5));
    expect(bad.write).toBeNull();
    // A piece with no moves (the boxed-in king) can't be selected.
    expect(clickChessCell(s, WHITE, null, sq('e', 1)).selected).toBeNull();
  });

  it('castles by clicking the king then its two-step square', () => {
    const s = withBoard(
      { [sq('e', 1)]: W_KING, [sq('h', 1)]: W_ROOK, [sq('e', 8)]: B_KING },
      { castling: { wk: true, wq: false, bk: false, bq: false } },
    );
    const go = clickChessCell(s, WHITE, sq('e', 1), sq('g', 1));
    expect(go.write?.board[sq('g', 1)]).toBe(W_KING);
    expect(go.write?.board[sq('f', 1)]).toBe(W_ROOK);
    expect(go.write?.board[sq('h', 1)]).toBe(0);
    expect(go.write?.castling.wk).toBe(false);
  });

  it('takes en passant by clicking the pawn then the empty target square', () => {
    const s = withBoard(
      { [sq('e', 5)]: W_PAWN, [sq('d', 5)]: B_PAWN, [sq('a', 1)]: W_KING, [sq('h', 8)]: B_KING },
      { enPassant: sq('d', 6) },
    );
    const go = clickChessCell(s, WHITE, sq('e', 5), sq('d', 6));
    expect(go.write?.board[sq('d', 6)]).toBe(W_PAWN);
    expect(go.write?.board[sq('d', 5)]).toBe(0);
  });
});

describe('promotion', () => {
  const promo = (): ChessState => withBoard({
    [sq('a', 7)]: W_PAWN, [sq('e', 1)]: W_KING, [sq('h', 5)]: B_KING,
  });

  it('defaults to a queen', () => {
    expect(DEFAULT_PROMOTION).toBe('queen');
    const go = clickChessCell(promo(), WHITE, sq('a', 7), sq('a', 8));
    expect(go.write?.board[sq('a', 8)]).toBe(W_QUEEN);
  });

  it('honours the chosen piece, for either color, keeping the state shape', () => {
    for (const [choice, code] of [['rook', W_ROOK], ['bishop', W_BISHOP], ['knight', W_KNIGHT]] as const) {
      const go = clickChessCell(promo(), WHITE, sq('a', 7), sq('a', 8), choice);
      expect(go.write?.board[sq('a', 8)]).toBe(code);
      expect(isChessState(go.write)).toBe(true);
    }
    const black = withBoard(
      { [sq('h', 2)]: B_PAWN, [sq('a', 8)]: B_KING, [sq('e', 4)]: W_KING },
      { turn: 'black' },
    );
    const go = clickChessCell(black, BLACK, sq('h', 2), sq('h', 1), 'knight');
    expect(go.write?.board[sq('h', 1)]).toBe(-W_KNIGHT);
  });

  it('judges mate with the promoted piece, not a queen', () => {
    // A back-rank mate only a rook (or queen) on a8 delivers — promoting to
    // a knight must leave the game running.
    const s = withBoard({
      [sq('a', 7)]: W_PAWN, [sq('g', 1)]: W_KING,
      [sq('h', 8)]: B_KING, [sq('g', 7)]: B_PAWN, [sq('h', 7)]: B_PAWN,
    });
    expect(clickChessCell(s, WHITE, sq('a', 7), sq('a', 8), 'rook').write?.status).toBe('white-won');
    expect(clickChessCell(s, WHITE, sq('a', 7), sq('a', 8), 'knight').write?.status).toBe('playing');
  });

  it('the engine still auto-queens a move that names nothing (bot, older peers)', () => {
    const s = promo();
    const move = legalChessMoves(s).find((m) => m.special === 'promote')!;
    expect(applyChessMove(s, move).board[sq('a', 8)]).toBe(W_QUEEN);
  });
});

describe('marks and status', () => {
  it('shows movable pieces and the selection\'s targets only to the mover', () => {
    const s = playing();
    const mine = chessBoardMarks(s, WHITE, sq('g', 1), null);
    expect(mine.movable).toContain(sq('g', 1));
    expect(mine.movable).toContain(sq('e', 2));
    expect(mine.movable).not.toContain(sq('e', 1));
    expect(mine.targets.sort()).toEqual([sq('f', 3), sq('h', 3)].sort());
    expect(chessBoardMarks(s, BLACK, null, null).movable).toEqual([]);
    expect(chessBoardMarks(s, STRANGER, null, null).movable).toEqual([]);
  });

  it('hovers only claimable pieces before the game', () => {
    const s = claimChessSide(initialChessState(), 'white', WHITE)!;
    expect(chessBoardMarks(s, STRANGER, null, sq('e', 7)).hover).toBe(sq('e', 7));
    expect(chessBoardMarks(s, STRANGER, null, sq('e', 2)).hover).toBeNull();
  });

  it('drops a stale selection after the turn passes', () => {
    const s = playing();
    expect(pruneChessSelection(s, WHITE, sq('e', 2))).toBe(sq('e', 2));
    const after = clickChessCell(s, WHITE, sq('e', 2), sq('e', 4)).write!;
    expect(pruneChessSelection(after, WHITE, sq('e', 4))).toBeNull();
  });

  it('says whose move it is, and flags check', () => {
    expect(chessStatusLine(playing(), WHITE)).toBe('WHITE TO MOVE · YOUR MOVE');
    expect(chessStatusLine(playing(), BLACK)).toBe('WHITE TO MOVE');
    expect(chessStatusLine(initialChessState(), WHITE)).toBe('CLICK A WHITE OR BLACK PIECE TO TAKE THAT SIDE');
    const checked = withBoard({ [sq('e', 1)]: W_KING, [sq('e', 8)]: B_ROOK, [sq('a', 8)]: B_KING });
    expect(chessStatusLine(checked, WHITE)).toBe('WHITE TO MOVE · YOUR MOVE · CHECK');
    expect(checkSquare(checked)).toBe(sq('e', 1));
    expect(checkSquare(playing())).toBeNull();
    expect(chessStatusLine({ ...playing(), status: 'draw' }, WHITE)).toBe('DRAW — STALEMATE');
  });
});

describe('options-card transitions', () => {
  it('forfeits to the other side, for seated players only', () => {
    expect(forfeitChess(playing(), WHITE)?.status).toBe('black-won');
    expect(forfeitChess(playing(), BLACK)?.status).toBe('white-won');
    expect(forfeitChess(playing(), STRANGER)).toBeNull();
  });

  it('resets through the room\'s shared edit gate, not the raw owner', () => {
    expect(canResetChessTable(playing(), STRANGER, false)).toBe(false);
    expect(canResetChessTable(playing(), STRANGER, true)).toBe(true);
    expect(canResetChessTable(playing(), WHITE, false)).toBe(true);
    expect(canResetChessTable({ ...playing(), status: 'white-won' }, STRANGER, false)).toBe(true);
    expect(canResetChessTable({ ...playing(), bot: true }, STRANGER, false)).toBe(true);
    expect(canResetChessTable(initialChessState(), STRANGER, false)).toBe(true);
    expect(canResetChessTable(null, WHITE, true)).toBe(false);
  });
});
