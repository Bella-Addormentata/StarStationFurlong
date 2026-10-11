/**
 * ♟ The game table's 3D chess set as built. The table is built for real
 * (buildItemGroup), with a stand-in canvas for its painted faces, and the
 * handle is driven the way World drives it: lay a chess board out, then
 * pick cells by raycasting straight down — a hit on a piece must report
 * ITS cell, and laying checkers out must clear the chess set.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { buildItemGroup } = await import('./furniture');
const { initialChessState } = await import('./games/chess');
const { initialState } = await import('./games/checkers');
const { cellCenterLocal, BOARD_SQ_M } = await import('./games/checkersTable');
type Handle = import('./devices').GameTableTopHandle;

function buildTable(): { group: THREE.Group; handle: Handle; top: THREE.Object3D } {
  const group = buildItemGroup({ id: 'game-table-1', kind: 'game-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  let handle: Handle | null = null;
  let top: THREE.Object3D | null = null;
  group.traverse((obj) => {
    if (obj.userData.gameTableTop) handle = obj.userData.gameTableTop as Handle;
    if (obj.name === 'gameTableTop') top = obj;
  });
  group.updateMatrixWorld(true);
  return { group, handle: handle!, top: top! };
}

/** Instances live per InstancedMesh; sum the shown ones. */
function shownPieces(group: THREE.Group): number {
  let n = 0;
  group.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) n += obj.count;
  });
  return n;
}

/** A ray straight down onto a cell centre, in world space. */
function rayDown(top: THREE.Object3D, idx: number): THREE.Raycaster {
  const { x, z } = cellCenterLocal(idx);
  const from = top.localToWorld(new THREE.Vector3(x, 1, z));
  return new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0));
}

describe('the 3D chess set', () => {
  it('lays out all 32 pieces and picks the cell under each', () => {
    const { group, handle, top } = buildTable();
    const s = initialChessState();
    handle.setChess(s.board, 'white', { last: null, check: null });
    group.updateMatrixWorld(true);
    expect(shownPieces(group)).toBe(32);
    for (let idx = 0; idx < 64; idx++) {
      expect(handle.pickCell(rayDown(top, idx)), `cell ${idx}`).toBe(idx);
    }
  });

  it('gives each piece type its own mesh, sized inside a square', () => {
    const { group, handle } = buildTable();
    handle.setChess(initialChessState().board, null, null);
    const heights = new Map<THREE.BufferGeometry, number>();
    group.traverse((obj) => {
      if (!(obj instanceof THREE.InstancedMesh) || obj.count === 0) return;
      obj.geometry.computeBoundingBox();
      const box = obj.geometry.boundingBox!;
      expect(box.max.x - box.min.x).toBeLessThan(BOARD_SQ_M);
      expect(box.max.z - box.min.z).toBeLessThan(BOARD_SQ_M);
      heights.set(obj.geometry, box.max.y - box.min.y);
    });
    // Six shapes (white and black share them), all distinct heights.
    expect(heights.size).toBe(6);
    expect(new Set([...heights.values()].map((h) => h.toFixed(4))).size).toBe(6);
  });

  it('clears the chess set when checkers (or nothing) is laid out', () => {
    const { group, handle } = buildTable();
    handle.setChess(initialChessState().board, 'white', null);
    handle.setBoard(initialState().board, 'black');
    expect(shownPieces(group)).toBe(24);
    handle.setChess(null, null, null);
    expect(shownPieces(group)).toBe(0);
  });

  it('ignores junk codes from a malformed peer board', () => {
    const { group, handle } = buildTable();
    const board = new Array<number>(64).fill(99);
    board[0] = -6;
    handle.setChess(board, null, null);
    expect(shownPieces(group)).toBe(1);
  });
});
