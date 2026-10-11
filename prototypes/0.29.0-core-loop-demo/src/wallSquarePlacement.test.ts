/**
 * 🧱 Furniture on the squares along the walls. The placement gate used to keep
 * every footprint 1 m inside the walls, so the whole outer ring of squares
 * refused every piece with a footprint. A footprint may now stand flush
 * against a wall, but still not in a doorway or under a hung wall panel.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// editMode reads the URL flags off `window` at import time and pulls in the
// device-focus controller, which listens on it; the gate under test is pure
// and never touches the DOM.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { location: { search: '' }, addEventListener() {}, removeEventListener() {} };
});
vi.mock('./deviceFocus', () => ({ isDeviceFocusActive: () => false, deviceFocus: {} }));
import { FURNITURE } from './furniture';
import type { FurnitureItem } from './furniture';
import { validatePlacement } from './editMode';
import { roomHalfExtents } from './floorPlanDoc';

const ctx = { playerPositions: [], floodFrom: { x: 0, z: 0 }, requiredReachable: [] };
const chair: FurnitureItem = { id: 'test-chair', kind: 'armchair-left', pos: { x: 0, z: 0 }, rot: 0, movable: true };

describe('placement on the squares along the walls', () => {
  let saved: FurnitureItem[] = [];
  beforeEach(() => {
    saved = FURNITURE.splice(0, FURNITURE.length);
  });
  afterEach(() => {
    FURNITURE.splice(0, FURNITURE.length, ...saved);
  });

  it('takes a 1×1 piece on every wall square clear of the doorways', () => {
    const { halfX, halfZ } = roomHalfExtents();
    const edge = halfX - 0.5;
    for (const pos of [
      { x: edge, z: 3.5 }, { x: -edge, z: -3.5 },
      { x: 3.5, z: halfZ - 0.5 }, { x: -3.5, z: -(halfZ - 0.5) },
      { x: edge, z: halfZ - 0.5 }, // the corner square
    ]) {
      expect(validatePlacement(chair, pos, 0, ctx)).toEqual({ ok: true });
    }
  });

  it('still refuses a piece past the wall', () => {
    const { halfX } = roomHalfExtents();
    expect(validatePlacement(chair, { x: halfX + 0.5, z: 3.5 }, 0, ctx)).toEqual({ ok: false, reason: 'out of bounds' });
  });

  it('keeps a doorway clear', () => {
    // An unseeded room has the four built-in doors, each centred on its wall.
    const { halfX } = roomHalfExtents();
    const verdict = validatePlacement(chair, { x: halfX - 0.5, z: 0.5 }, 0, ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(/^in the way of /);
  });

  it('keeps a hung wall panel clear', () => {
    const { halfX } = roomHalfExtents();
    const terminal = FURNITURE_TERMINAL(halfX);
    FURNITURE.push(terminal);
    const verdict = validatePlacement(chair, { x: halfX - 0.5, z: terminal.pos.z }, 0, ctx);
    expect(verdict.ok).toBe(false);
  });

  it('keeps an extent-less piece (a rug, a tree) 1 m inside the walls', () => {
    const { halfX } = roomHalfExtents();
    const rug: FurnitureItem = { id: 'test-rug', kind: 'chandelier', pos: { x: 0, z: 0 }, rot: 0, movable: true };
    expect(validatePlacement(rug, { x: halfX - 0.5, z: 3.5 }, 0, ctx).ok).toBe(false);
    expect(validatePlacement(rug, { x: halfX - 1, z: 3.5 }, 0, ctx).ok).toBe(true);
  });
});

function FURNITURE_TERMINAL(halfX: number): FurnitureItem {
  return { id: 'test-terminal', kind: 'wall-computer', pos: { x: halfX, z: 3.5 }, rot: 3, movable: true };
}
