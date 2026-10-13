import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initialState, legalMoves, EMPTY, RED_MAN, BLACK_MAN } from './checkers';
import type { CheckersState } from './checkers';
import {
  BOARD_SIZE_M,
  BOARD_SQ_M,
  boardMarks,
  canResetTable,
  cellCenterLocal,
  cellFromUV,
  claimSide,
  clickCell,
  forfeit,
  pruneSelection,
  standIndexFor,
  startBot,
  statusLine,
} from './checkersTable';

const RED = 'player-red';
const BLACK = 'player-black';
const STRANGER = 'player-stranger';

function playing(): CheckersState {
  return { ...initialState(), players: { red: RED, black: BLACK }, status: 'playing' };
}

describe('board-face geometry', () => {
  it('maps every cell centre back to itself through the builder\'s plane', () => {
    // Build the plane exactly as furniture.ts buildGameTable lays it down and
    // raycast straight down onto each cell centre: the UV the hit reports must
    // decode to the same cell. Pins the painter, the pieces and the picker
    // to one geometry.
    const geo = new THREE.PlaneGeometry(BOARD_SIZE_M, BOARD_SIZE_M);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(Math.PI);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    for (let idx = 0; idx < 64; idx++) {
      const { x, z } = cellCenterLocal(idx);
      ray.set(new THREE.Vector3(x, 1, z), new THREE.Vector3(0, -1, 0));
      const uv = ray.intersectObject(mesh)[0]?.uv;
      expect(uv, `cell ${idx}`).toBeDefined();
      expect(cellFromUV(uv!.x, uv!.y)).toBe(idx);
    }
  });

  it('puts row 0 (black home) at +z and column 0 on the front viewer\'s left (+x)', () => {
    expect(cellCenterLocal(0).z).toBeGreaterThan(0);
    expect(cellCenterLocal(63).z).toBeLessThan(0);
    expect(cellCenterLocal(0).x).toBeGreaterThan(0);
    expect(cellCenterLocal(7).x).toBeLessThan(0);
    // Neighbouring cells are one square apart.
    expect(Math.abs(cellCenterLocal(0).x - cellCenterLocal(1).x)).toBeCloseTo(BOARD_SQ_M, 6);
  });

  it('returns null on the frame and for junk UVs', () => {
    expect(cellFromUV(0.01, 0.5)).toBeNull();
    expect(cellFromUV(0.5, 0.99)).toBeNull();
    expect(cellFromUV(Number.NaN, 0.5)).toBeNull();
  });

  it('sends red to the −z end and black to the +z end', () => {
    expect(standIndexFor('red')).toBe(0);
    expect(standIndexFor('black')).toBe(1);
  });
});

describe('taking a side by clicking a piece', () => {
  it('claims the clicked piece\'s color and starts once both are taken', () => {
    const redIdx = initialState().board.indexOf(RED_MAN);
    const blackIdx = initialState().board.indexOf(BLACK_MAN);
    const a = clickCell(initialState(), RED, null, redIdx);
    expect(a.write?.players.red).toBe(RED);
    expect(a.write?.status).toBe('waiting');
    const b = clickCell(a.write, BLACK, null, blackIdx);
    expect(b.write?.players.black).toBe(BLACK);
    expect(b.write?.status).toBe('playing');
  });

  it('does nothing on an empty square, a taken side, or a second seat', () => {
    const empty = initialState().board.indexOf(EMPTY);
    expect(clickCell(initialState(), RED, null, empty).write).toBeNull();
    const s = claimSide(initialState(), 'red', RED)!;
    const redIdx = s.board.indexOf(RED_MAN);
    expect(clickCell(s, STRANGER, null, redIdx).write).toBeNull();
    const blackIdx = s.board.indexOf(BLACK_MAN);
    expect(clickCell(s, RED, null, blackIdx).write).toBeNull();
  });
});

describe('moving on your turn', () => {
  it('selects a movable piece, then moves it to a legal destination', () => {
    const s = playing(); // black opens
    const move = legalMoves(s)[0];
    const pick = clickCell(s, BLACK, null, move.from);
    expect(pick.write).toBeNull();
    expect(pick.selected).toBe(move.from);
    const go = clickCell(s, BLACK, pick.selected, move.to);
    expect(go.write?.board[move.to]).toBe(BLACK_MAN);
    expect(go.write?.turn).toBe('red');
    expect(go.selected).toBeNull();
  });

  it('ignores clicks from the side not to move and from spectators', () => {
    const s = playing();
    const redIdx = s.board.indexOf(RED_MAN);
    expect(clickCell(s, RED, null, redIdx)).toEqual({ write: null, selected: null });
    expect(clickCell(s, STRANGER, null, 0)).toEqual({ write: null, selected: null });
  });

  it('keeps the jumping piece selected mid multi-jump', () => {
    // Black man at (2,1) jumps red at (3,2) to (4,3), then red at (5,4) to (6,5).
    const board = new Array<number>(64).fill(EMPTY);
    board[2 * 8 + 1] = BLACK_MAN;
    board[3 * 8 + 2] = RED_MAN;
    board[5 * 8 + 4] = RED_MAN;
    board[7 * 8 + 0] = RED_MAN; // red keeps a piece so the game goes on
    const s: CheckersState = { ...playing(), board };
    const first = clickCell(s, BLACK, 2 * 8 + 1, 4 * 8 + 3);
    expect(first.write?.chain).toBe(4 * 8 + 3);
    expect(first.selected).toBe(4 * 8 + 3);
    expect(pruneSelection(first.write, BLACK, null)).toBe(4 * 8 + 3);
  });
});

describe('marks and status', () => {
  it('shows movable pieces and the selection\'s destinations only to the mover', () => {
    const s = playing();
    const from = legalMoves(s)[0].from;
    const mine = boardMarks(s, BLACK, from, null);
    expect(mine.movable.length).toBeGreaterThan(0);
    expect(mine.targets.length).toBeGreaterThan(0);
    expect(boardMarks(s, RED, null, null).movable).toEqual([]);
    expect(boardMarks(s, STRANGER, null, null).movable).toEqual([]);
  });

  it('says whose move it is', () => {
    expect(statusLine(playing(), BLACK)).toBe('BLACK TO MOVE · YOUR MOVE');
    expect(statusLine(playing(), RED)).toBe('BLACK TO MOVE');
    expect(statusLine(initialState(), RED)).toBe('CLICK A RED OR BLACK PIECE TO TAKE THAT SIDE');
  });
});

describe('options-card transitions', () => {
  it('starts a bot game with the clicker as red', () => {
    const s = startBot(initialState(), RED)!;
    expect(s).toMatchObject({ bot: true, status: 'playing', players: { red: RED, black: null } });
    expect(startBot(claimSide(initialState(), 'red', RED)!, STRANGER)).toBeNull();
  });

  it('forfeits to the other side, for seated players only', () => {
    expect(forfeit(playing(), RED)?.status).toBe('black-won');
    expect(forfeit(playing(), STRANGER)).toBeNull();
  });

  it('resets through the room\'s shared edit gate, not the raw owner', () => {
    expect(canResetTable(playing(), STRANGER, false)).toBe(false);
    expect(canResetTable(playing(), STRANGER, true)).toBe(true);
    expect(canResetTable(playing(), RED, false)).toBe(true);
    expect(canResetTable({ ...playing(), status: 'red-won' }, STRANGER, false)).toBe(true);
    expect(canResetTable(null, RED, true)).toBe(false);
  });
});
