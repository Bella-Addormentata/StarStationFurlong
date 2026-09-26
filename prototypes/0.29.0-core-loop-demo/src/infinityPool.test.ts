/**
 * 🏊 infinity-pool — the reference's terraced water as a narrow pool on the
 * room's front edge, with no far bank.
 *
 * One pure function of the room (infinityPoolColumns) decides the tiles; the
 * geometry, the floor hole and the blocked area all read it. These cases pin
 * the decision: the pool runs wall to wall along the front edge, every column
 * is one wet step then water to the edge, the doors keep their dry lanes, the
 * floor hole stays strictly inside the floor, and a plank bridge opens a lane.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFloorPlan, roomHalfExtents, writeRoomDims } from './floorPlanDoc';
import { bindDoorLayoutDoc } from './doorLayoutDoc';
import {
  buildObstacleList,
  floorCutOutlines,
  infinityPoolColumns,
  infinityPoolEdgeZ,
  infinityPoolLevel,
  infinityPoolMetrics,
  infinityPoolOutlines,
  infinityPoolTiles,
  isFloorCutKind,
  isPoolKind,
  type FurnitureItem,
} from './furniture';

const POOL: FurnitureItem = { id: 'p', kind: 'infinity-pool', pos: { x: 2, z: -1 }, rot: 0, movable: true };

const blockedBy = (boxes: Array<{ x0: number; z0: number; x1: number; z1: number }>) =>
  (x: number, z: number): boolean =>
    boxes.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);

beforeAll(() => {
  bindFloorPlan(new Y.Doc()); // default 2×2 ⇒ half = 6
  bindDoorLayoutDoc(new Y.Doc()); // unseeded ⇒ the four default doors
});

describe('the tiles', () => {
  it('is a floor-cut kind but not a swim kind', () => {
    expect(isFloorCutKind('infinity-pool')).toBe(true);
    expect(isPoolKind('infinity-pool')).toBe(false);
  });

  it('runs wall to wall along the front edge', () => {
    const { halfX, halfZ } = roomHalfExtents();
    const cols = infinityPoolColumns();
    // Every column but the front door's landing (the pool is one row deep there).
    expect(cols.length).toBeGreaterThanOrEqual(9);
    expect(cols[0].i).toBe(-6);
    expect(cols[cols.length - 1].i).toBe(5);
    for (const c of cols) {
      expect(c.i).toBeGreaterThanOrEqual(-halfX);
      expect(c.i).toBeLessThan(halfX);
      expect(c.top).toBeGreaterThanOrEqual(-halfZ);
      expect(c.bot).toBeLessThan(halfZ);
    }
    // No far bank: away from the front door, the water reaches the last row.
    expect(cols.filter((c) => c.bot === halfZ - 1).length).toBeGreaterThanOrEqual(9);
  });

  it('is narrow — one wet step, then one or two tiles of water', () => {
    const { waterW } = infinityPoolMetrics();
    expect(waterW).toBe(1);
    for (const c of infinityPoolColumns()) {
      const levels = [];
      for (let j = c.top; j <= c.bot; j++) levels.push(infinityPoolLevel(c, j));
      const water = levels.filter((l) => l === 'water').length;
      const wet = levels.filter((l) => l === 'wet').length;
      expect(wet).toBeLessThanOrEqual(1);
      expect(water).toBeGreaterThanOrEqual(1);
      expect(water).toBeLessThanOrEqual(waterW + 1);
      // Wet, if present, is the first row — the step is on the ROOM side.
      if (wet) expect(levels[0]).toBe('wet');
    }
  });

  it('has a shore that wanders by whole tiles, one at a time', () => {
    const cols = infinityPoolColumns();
    const w0s = cols.map((c) => c.w0);
    expect(new Set(w0s).size).toBe(2); // one row deep here, two at the bends
    for (let k = 1; k < cols.length; k++) expect(Math.abs(cols[k].w0 - cols[k - 1].w0)).toBeLessThanOrEqual(1);
    // Winding: the shore changes row at least four times across the room.
    let changes = 0;
    for (let k = 1; k < w0s.length; k++) if (w0s[k] !== w0s[k - 1]) changes++;
    expect(changes).toBeGreaterThanOrEqual(4);
    // Narrowest at the west wall, bowing into the room after it.
    expect(infinityPoolEdgeZ(-5.5)).toBeGreaterThan(infinityPoolEdgeZ(-4.2));
  });

  it('keeps a dry lane in front of every door', () => {
    const { halfX, halfZ } = roomHalfExtents();
    for (const t of infinityPoolTiles().values()) {
      const cx = t.i + 0.5, cz = t.j + 0.5;
      expect(Math.hypot(cx + halfX, cz)).toBeGreaterThanOrEqual(1.5); // west door
      expect(Math.hypot(cx - halfX, cz)).toBeGreaterThanOrEqual(1.5); // east door
      expect(Math.hypot(cx, cz - halfZ)).toBeGreaterThanOrEqual(1.5); // south door — a landing cut out of the pool
      expect(Math.hypot(cx, cz + halfZ)).toBeGreaterThanOrEqual(1.5); // north door
    }
    // …and every column that survives the landing still holds water.
    for (const c of infinityPoolColumns()) expect(infinityPoolLevel(c, c.bot)).toBe('water');
  });
});

describe('the floor hole', () => {
  it('is a staircase polygon per run of columns, strictly inside the floor', () => {
    const { halfX, halfZ } = roomHalfExtents();
    const polys = infinityPoolOutlines();
    expect(polys.length).toBeGreaterThanOrEqual(1);
    expect(polys.length).toBeLessThanOrEqual(2); // the front door's landing may split it
    const poly = polys[0];
    expect(poly.length).toBeGreaterThan(8);
    for (const p of poly) {
      expect(p.x).toBeGreaterThan(-halfX);
      expect(p.x).toBeLessThan(halfX);
      expect(p.z).toBeGreaterThan(-halfZ);
      expect(p.z).toBeLessThan(halfZ);
    }
    // Rectilinear: every edge is axis-aligned.
    for (let k = 1; k < poly.length; k++) {
      expect(poly[k].x === poly[k - 1].x || poly[k].z === poly[k - 1].z).toBe(true);
    }
    // It reaches the front edge (up to the sliver the triangulator needs).
    expect(Math.max(...poly.map((p) => p.z))).toBeCloseTo(halfZ - 0.05, 5);
  });

  it('is what the floor cuts for a room holding the pool', () => {
    expect(floorCutOutlines([POOL])).toEqual(infinityPoolOutlines());
    expect(floorCutOutlines([])).toEqual([]);
  });
});

describe('walking', () => {
  it('blocks exactly its own tiles, wherever the item was dropped', () => {
    const blocked = blockedBy(buildObstacleList([POOL]));
    const tiles = infinityPoolTiles();
    for (let i = -6; i < 6; i++) for (let j = -6; j < 6; j++) {
      expect(blocked(i + 0.5, j + 0.5)).toBe(tiles.has(`${i},${j}`));
    }
  });

  it('a plank bridge over it is a pier you can walk, and only that', () => {
    const c = infinityPoolColumns().find((col) => col.i === 3)!;
    const bridge: FurnitureItem = {
      id: 'b', kind: 'plank-bridge', pos: { x: 3, z: (c.top + c.bot + 1) / 2 }, rot: 0, movable: true,
    };
    const blocked = blockedBy(buildObstacleList([POOL, bridge]));
    for (let j = c.top; j <= c.bot; j++) {
      expect(blocked(3.3, j + 0.5)).toBe(false); // on the planks
      expect(blocked(2.7, j + 0.5)).toBe(false);
      expect(blocked(4.3, j + 0.5)).toBe(true); // beside them, still water
    }
  });
});

describe('in a 5×5 module', () => {
  beforeAll(() => writeRoomDims(5, 5));

  it('is two tiles of water widening to three, still on the edge', () => {
    const mt = infinityPoolMetrics();
    expect(mt.waterW).toBe(2);
    const { halfZ } = roomHalfExtents();
    const cols = infinityPoolColumns();
    expect(cols.filter((c) => c.bot === halfZ - 1).length).toBeGreaterThan(cols.length - 4);
    for (const c of cols) {
      const water = c.bot - c.w0 + 1;
      expect(water).toBeGreaterThanOrEqual(1); // ≥2 away from the door landing
      expect(water).toBeLessThanOrEqual(3);
      expect(infinityPoolLevel(c, c.top)).toBe(c.top < c.w0 ? 'wet' : 'water');
    }
  });
});
