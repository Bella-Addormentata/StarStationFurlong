/**
 * Wall-computer station-overview helpers — the pure math the DOM UI paints.
 *
 * These tests cover the shape of the helpers exposed for #33 (in-device
 * maps): the module-count threshold, module footprint sizing, atlas pose
 * composition, the oriented-rectangle projection, and the equal-aspect
 * viewport fit. Every case here is a plain data transform — no DOM, no
 * localStorage, no globals — so the suite runs headless under vitest.
 */

import { describe, expect, it } from 'vitest';
import type { AtlasPose } from './stationAtlas';
import {
  MODULE_HALF_FALLBACK,
  SMALL_STATION_MAX,
  fitPointsToCanvas,
  isSmallStation,
  moduleHalfExtents,
  projectModuleFootprintCorners,
  projectPoint,
  stationPlacements,
} from './wallComputerMap';

describe('isSmallStation', () => {
  it('accepts 1 up through SMALL_STATION_MAX', () => {
    expect(isSmallStation(1)).toBe(true);
    expect(isSmallStation(8)).toBe(true);
    expect(isSmallStation(SMALL_STATION_MAX)).toBe(true);
  });

  it('rejects 0 and negatives (empty atlas is never rendered)', () => {
    expect(isSmallStation(0)).toBe(false);
    expect(isSmallStation(-3)).toBe(false);
  });

  it('rejects counts above the cap (map-table territory)', () => {
    expect(isSmallStation(SMALL_STATION_MAX + 1)).toBe(false);
    expect(isSmallStation(999)).toBe(false);
  });

  it('rejects non-finite inputs defensively', () => {
    expect(isSmallStation(Number.NaN)).toBe(false);
    expect(isSmallStation(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('moduleHalfExtents', () => {
  it('scales the default 2x2 room to +/- 6m', () => {
    expect(moduleHalfExtents({ cols: 2, rows: 2 })).toEqual({ halfX: 6, halfZ: 6 });
  });

  it('handles rectangular rooms (cols != rows)', () => {
    expect(moduleHalfExtents({ cols: 5, rows: 1 })).toEqual({ halfX: 15, halfZ: 3 });
    expect(moduleHalfExtents({ cols: 1, rows: 4 })).toEqual({ halfX: 3, halfZ: 12 });
  });

  it('falls back to the uniform MODULE_HALF_FALLBACK when dims are unknown', () => {
    for (const missing of [null, undefined]) {
      const half = moduleHalfExtents(missing);
      expect(half.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
      expect(half.halfZ).toBeCloseTo(MODULE_HALF_FALLBACK);
    }
  });

  it('falls back if either dims axis is non-finite', () => {
    const halfA = moduleHalfExtents({ cols: Number.NaN, rows: 2 });
    expect(halfA.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
    const halfB = moduleHalfExtents({ cols: 2, rows: Number.POSITIVE_INFINITY });
    expect(halfB.halfZ).toBeCloseTo(MODULE_HALF_FALLBACK);
  });
});

describe('stationPlacements', () => {
  const currentId = 'ROOM-CUR';

  it('always places the current room at the origin with hops=0', () => {
    const placements = stationPlacements(currentId, 'Living Cell', { cols: 2, rows: 2 }, []);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      roomId: currentId,
      isCurrent: true,
      x: 0,
      z: 0,
      rotY: 0,
      hops: 0,
      dimsUnknown: false,
    });
    expect(placements[0].halfX).toBeCloseTo(6);
    expect(placements[0].halfZ).toBeCloseTo(6);
  });

  it('carries current-room dimsUnknown when dims are missing', () => {
    const [current] = stationPlacements(currentId, 'Unknown', null, []);
    expect(current.dimsUnknown).toBe(true);
    expect(current.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
  });

  it('places neighbours after the current room, in the order given', () => {
    const poses: AtlasPose[] = [
      { roomId: 'A', name: 'A-mod', x: 15, z: 0, rotY: 0, hops: 1, dims: { cols: 2, rows: 2 } },
      { roomId: 'B', name: 'B-mod', x: -12, z: 8, rotY: Math.PI / 2, hops: 2 },
    ];
    const placements = stationPlacements(currentId, 'Cur', { cols: 2, rows: 2 }, poses);
    expect(placements.map((p) => p.roomId)).toEqual([currentId, 'A', 'B']);
    expect(placements[1].isCurrent).toBe(false);
    expect(placements[1].dimsUnknown).toBe(false);
    expect(placements[2].dimsUnknown).toBe(true);
    expect(placements[2].halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
    expect(placements[2].hops).toBe(2);
  });

  it('drops atlas poses that duplicate the current room or lack an id', () => {
    const poses = [
      { roomId: currentId, name: 'echo', x: 5, z: 5, rotY: 0, hops: 0 },
      { roomId: '', name: 'blank', x: 1, z: 1, rotY: 0, hops: 1 },
      { roomId: 'GOOD', name: 'Good', x: 3, z: 4, rotY: 0, hops: 1 },
    ] as AtlasPose[];
    const placements = stationPlacements(currentId, 'Cur', { cols: 2, rows: 2 }, poses);
    expect(placements.map((p) => p.roomId)).toEqual([currentId, 'GOOD']);
  });

  it('sanitizes non-finite pose fields to safe defaults', () => {
    const poses: AtlasPose[] = [
      // Intentionally corrupt values — a hostile / stale doc must not crash the
      // renderer. The placement should degrade to the origin with rotY=0.
      { roomId: 'X', name: 'X-mod', x: Number.NaN, z: Number.POSITIVE_INFINITY, rotY: Number.NaN, hops: -5 },
    ];
    const [, x] = stationPlacements(currentId, 'Cur', { cols: 2, rows: 2 }, poses);
    expect(x.x).toBe(0);
    expect(x.z).toBe(0);
    expect(x.rotY).toBe(0);
    // hops < 1 clamps up to 1 for neighbours (0 is the current room's slot).
    expect(x.hops).toBe(1);
  });
});

describe('projectModuleFootprintCorners', () => {
  it('returns four corners in local CW order at rotY=0', () => {
    const corners = projectModuleFootprintCorners({
      x: 0, z: 0, rotY: 0, halfX: 6, halfZ: 6,
    });
    expect(corners).toHaveLength(4);
    expect(corners[0]).toEqual({ x: -6, z: -6 });
    expect(corners[1]).toEqual({ x:  6, z: -6 });
    expect(corners[2]).toEqual({ x:  6, z:  6 });
    expect(corners[3]).toEqual({ x: -6, z:  6 });
  });

  it('translates the whole footprint to the placement centre', () => {
    const corners = projectModuleFootprintCorners({
      x: 10, z: -4, rotY: 0, halfX: 3, halfZ: 3,
    });
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(7);
      expect(c.x).toBeLessThanOrEqual(13);
      expect(c.z).toBeGreaterThanOrEqual(-7);
      expect(c.z).toBeLessThanOrEqual(-1);
    }
    // Diagonally opposite corners' midpoint is the placement centre.
    const midX = (corners[0].x + corners[2].x) / 2;
    const midZ = (corners[0].z + corners[2].z) / 2;
    expect(midX).toBeCloseTo(10);
    expect(midZ).toBeCloseTo(-4);
  });

  it('rotates 45 degrees about the placement centre', () => {
    const half = 6;
    const corners = projectModuleFootprintCorners({
      x: 0, z: 0, rotY: Math.PI / 4, halfX: half, halfZ: half,
    });
    // Corner (-halfX, -halfZ) rotates to (0, -sqrt(2)·halfX).
    expect(corners[0].x).toBeCloseTo(0);
    expect(corners[0].z).toBeCloseTo(-Math.SQRT2 * half);
    // Every corner is at the same |r| = sqrt(halfX^2 + halfZ^2).
    const r = Math.hypot(half, half);
    for (const c of corners) {
      expect(Math.hypot(c.x, c.z)).toBeCloseTo(r);
    }
  });

  it('handles rectangular (non-square) footprints under rotation', () => {
    const halfX = 15;
    const halfZ = 3;
    const corners = projectModuleFootprintCorners({
      x: 0, z: 0, rotY: Math.PI / 2, halfX, halfZ,
    });
    // A quarter turn maps (halfX, 0) → (0, halfX), so the projected footprint
    // spans ±halfX on the z axis and ±halfZ on the x axis.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    expect(maxX - minX).toBeCloseTo(halfZ * 2);
    expect(maxZ - minZ).toBeCloseTo(halfX * 2);
  });
});

describe('fitPointsToCanvas', () => {
  it('returns a centred zero-scale viewport for the empty set', () => {
    const v = fitPointsToCanvas([], 300, 20);
    expect(v.scale).toBe(0);
    expect(v.offsetX).toBe(150);
    expect(v.offsetZ).toBe(150);
  });

  it('clamps to minScale for a single point (rangeless input)', () => {
    const v = fitPointsToCanvas([{ x: 5, z: -2 }], 400, 40);
    expect(v.scale).toBeGreaterThan(0);
    // The one point projects to the exact canvas centre.
    const p = projectPoint({ x: 5, z: -2 }, v);
    expect(p.x).toBeCloseTo(200);
    expect(p.z).toBeCloseTo(200);
  });

  it('picks the smaller axis-scale so rectangles are not squashed', () => {
    // A pair of points 20m apart in x and 4m apart in z; the x range dominates
    // and both axes must share the x-derived scale (equal aspect).
    const v = fitPointsToCanvas(
      [ { x: -10, z: -2 }, { x: 10, z: 2 } ],
      420, 30,
    );
    const usable = 420 - 30 * 2;
    expect(v.scale).toBeCloseTo(usable / 20);
    // The z-span at that scale must fit inside the padded canvas.
    const zSpanPx = 4 * v.scale;
    expect(zSpanPx).toBeLessThanOrEqual(usable + 1e-6);
  });

  it('centres the extent midpoint on the canvas centre', () => {
    const v = fitPointsToCanvas(
      [ { x: -4, z: 0 }, { x: 20, z: 6 } ],
      300, 20,
    );
    const midX = (-4 + 20) / 2;   // 8
    const midZ = (0 + 6) / 2;     // 3
    expect(v.offsetX + midX * v.scale).toBeCloseTo(150);
    expect(v.offsetZ + midZ * v.scale).toBeCloseTo(150);
  });

  it('honours the maxScale clamp for very tightly-packed points', () => {
    const v = fitPointsToCanvas(
      [ { x: 0, z: 0 }, { x: 0.1, z: 0 } ],
      400, 20,
      { maxScale: 12 },
    );
    expect(v.scale).toBe(12);
  });

  it('honours the minScale clamp for sprawling atlases', () => {
    const v = fitPointsToCanvas(
      [ { x: -10000, z: 0 }, { x: 10000, z: 0 } ],
      300, 20,
      { minScale: 0.02 },
    );
    expect(v.scale).toBeGreaterThanOrEqual(0.02);
  });

  it('ignores non-finite points defensively without collapsing to zero', () => {
    const v = fitPointsToCanvas(
      [
        { x: Number.NaN, z: 0 },
        { x: -5, z: -5 },
        { x: Number.POSITIVE_INFINITY, z: 3 },
        { x: 5, z: 5 },
      ],
      300, 20,
    );
    // Effective extent is the two well-formed points.
    const usable = 300 - 20 * 2;
    expect(v.scale).toBeCloseTo(usable / 10);
  });
});

describe('projectPoint composed with a station fit', () => {
  it('maps the current room to the canvas centre when it is the only module', () => {
    const placements = stationPlacements(
      'ONLY', 'Only Room', { cols: 2, rows: 2 }, [],
    );
    const corners = projectModuleFootprintCorners(placements[0]);
    const v = fitPointsToCanvas(corners, 400, 40);
    // The four corners of the (only) module frame the canvas centre.
    let sumX = 0, sumZ = 0;
    for (const c of corners) {
      const p = projectPoint(c, v);
      sumX += p.x;
      sumZ += p.z;
    }
    expect(sumX / corners.length).toBeCloseTo(200);
    expect(sumZ / corners.length).toBeCloseTo(200);
  });

  it('keeps two docked modules inside the padded canvas', () => {
    const poses: AtlasPose[] = [
      // A neighbour 18m east of the current 2x2 room.
      { roomId: 'EAST', name: 'East', x: 18, z: 0, rotY: 0, hops: 1, dims: { cols: 2, rows: 2 } },
    ];
    const placements = stationPlacements(
      'CUR', 'Cur', { cols: 2, rows: 2 }, poses,
    );
    const points: Array<{ x: number; z: number }> = [];
    for (const p of placements) {
      for (const c of projectModuleFootprintCorners(p)) points.push(c);
    }
    const canvasSize = 320;
    const padding = 24;
    const v = fitPointsToCanvas(points, canvasSize, padding);
    for (const p of points) {
      const proj = projectPoint(p, v);
      expect(proj.x).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(proj.x).toBeLessThanOrEqual(canvasSize - padding + 1e-6);
      expect(proj.z).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(proj.z).toBeLessThanOrEqual(canvasSize - padding + 1e-6);
    }
  });
});
