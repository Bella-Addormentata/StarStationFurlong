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
  areDimsRoomValid,
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
  it('scales the default 2x2 room to +/- 6m and reports no fallback', () => {
    expect(moduleHalfExtents({ cols: 2, rows: 2 })).toEqual({
      halfX: 6, halfZ: 6, usedFallback: false,
    });
  });

  it('handles rectangular rooms (cols != rows)', () => {
    expect(moduleHalfExtents({ cols: 5, rows: 1 })).toEqual({
      halfX: 15, halfZ: 3, usedFallback: false,
    });
    expect(moduleHalfExtents({ cols: 1, rows: 4 })).toEqual({
      halfX: 3, halfZ: 12, usedFallback: false,
    });
  });

  it('falls back to the uniform MODULE_HALF_FALLBACK when dims are unknown', () => {
    for (const missing of [null, undefined]) {
      const half = moduleHalfExtents(missing);
      expect(half.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
      expect(half.halfZ).toBeCloseTo(MODULE_HALF_FALLBACK);
      expect(half.usedFallback).toBe(true);
    }
  });

  it('falls back if either dims axis is non-finite', () => {
    const halfA = moduleHalfExtents({ cols: Number.NaN, rows: 2 });
    expect(halfA.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
    expect(halfA.usedFallback).toBe(true);
    const halfB = moduleHalfExtents({ cols: 2, rows: Number.POSITIVE_INFINITY });
    expect(halfB.halfZ).toBeCloseTo(MODULE_HALF_FALLBACK);
    expect(halfB.usedFallback).toBe(true);
  });

  it('falls back for out-of-envelope integer dims (below 1 or above 5)', () => {
    // {cols: 0, rows: 2} would collapse the footprint on the x axis; the
    // room contract forbids it (ROOM_TILE_MIN = 1). Same for values above
    // ROOM_TILE_MAX = 5, which would blow the fit — a hostile atlas gossip
    // once past the shared-doc guard would still be caught here.
    for (const dims of [{ cols: 0, rows: 2 }, { cols: 2, rows: 0 }, { cols: 6, rows: 2 }, { cols: 2, rows: 999 }]) {
      const half = moduleHalfExtents(dims);
      expect(half.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
      expect(half.halfZ).toBeCloseTo(MODULE_HALF_FALLBACK);
      expect(half.usedFallback).toBe(true);
    }
  });

  it('falls back for non-integer dims (fractional cols/rows fail the envelope)', () => {
    // Number.isFinite would accept 2.5 — the room contract does not.
    const half = moduleHalfExtents({ cols: 2.5, rows: 2 });
    expect(half.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
    expect(half.usedFallback).toBe(true);
  });
});

describe('areDimsRoomValid', () => {
  // The envelope helper (small but load-bearing) — every code path that
  // reads unvalidated dims must funnel through it before drawing.
  it('accepts every integer in the room contract envelope', () => {
    for (let c = 1; c <= 5; c++) for (let r = 1; r <= 5; r++) {
      expect(areDimsRoomValid({ cols: c, rows: r })).toBe(true);
    }
  });

  it('rejects null, undefined, zero, over-envelope, non-integer, and hostile shapes', () => {
    expect(areDimsRoomValid(null)).toBe(false);
    expect(areDimsRoomValid(undefined)).toBe(false);
    expect(areDimsRoomValid({ cols: 0, rows: 2 })).toBe(false);
    expect(areDimsRoomValid({ cols: 2, rows: 6 })).toBe(false);
    expect(areDimsRoomValid({ cols: 2.5, rows: 2 })).toBe(false);
    // Hostile shapes: string / negative / NaN.
    expect(areDimsRoomValid({ cols: '2' as unknown as number, rows: 2 })).toBe(false);
    expect(areDimsRoomValid({ cols: -1, rows: 2 })).toBe(false);
    expect(areDimsRoomValid({ cols: Number.NaN, rows: 2 })).toBe(false);
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

  it('marks a neighbour dimsUnknown when dims fail the room envelope', () => {
    // localStorage / readAtlas is unvalidated: a peer or an older client can
    // seed dims that pass Number.isFinite but fail the room contract (0
    // collapses the footprint; > 5 blows out the fit). The pane must render
    // the fallback outline (dashed) rather than lie that the shape is real.
    const poses = [
      { roomId: 'ZERO', name: 'Zero', x: 12, z: 0, rotY: 0, hops: 1, dims: { cols: 0, rows: 2 } },
      { roomId: 'HUGE', name: 'Huge', x: -12, z: 0, rotY: 0, hops: 1, dims: { cols: 6, rows: 2 } },
    ] as AtlasPose[];
    const [, zero, huge] = stationPlacements(currentId, 'Cur', { cols: 2, rows: 2 }, poses);
    expect(zero.dimsUnknown).toBe(true);
    expect(zero.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
    expect(zero.halfZ).toBeCloseTo(MODULE_HALF_FALLBACK);
    expect(huge.dimsUnknown).toBe(true);
    expect(huge.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
  });

  it('marks the CURRENT room dimsUnknown when its own dims fail the envelope', () => {
    // Symmetric with the neighbour case above: a broken local floorPlan
    // (never expected in practice, but readRoomDims is the only safety net)
    // is still drawn as a guess, not painted over with silent fallback dims
    // that appear authoritative.
    const [current] = stationPlacements(currentId, 'Cur', { cols: 12, rows: 3 } as unknown as null, []);
    expect(current.dimsUnknown).toBe(true);
    expect(current.halfX).toBeCloseTo(MODULE_HALF_FALLBACK);
  });
});

describe('projectModuleFootprintCorners', () => {
  it('returns four corners in local order at rotY=0', () => {
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

  it('rotates 45 degrees about the placement centre using the atlas convention', () => {
    // 🧭 rotY convention pin: atlasLayout / Three.js `rotation.y` compose as
    // `x' = x·cos + z·sin`, `z' = -x·sin + z·cos`. At rotY = π/4 the local
    // corner (-halfX, -halfZ) rotates to (-√2·halfX, 0). A DIFFERENT rotation
    // sign (the pre-fix version) would send it to (0, -√2·halfX) — same |r|,
    // wrong direction. The old square-only assertion could not tell them
    // apart; this case now does.
    const half = 6;
    const corners = projectModuleFootprintCorners({
      x: 0, z: 0, rotY: Math.PI / 4, halfX: half, halfZ: half,
    });
    expect(corners[0].x).toBeCloseTo(-Math.SQRT2 * half);
    expect(corners[0].z).toBeCloseTo(0);
    // All four corners still lie on the enclosing circle of radius √(halfX²+halfZ²).
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

  it('directionally matches the atlas / Three.js rotation for a long thin module', () => {
    // 🧭 Directional pin (Copilot's reviewer note): the previous mirror-signed
    // implementation produced the same bounding box for a thin module rotated
    // through π/2, so the mirror was invisible to axis-span tests. This case
    // asserts WHICH corner ends up WHERE — differences the old sign silently
    // reversed. Pose: long along local X, quarter-turn about origin.
    const halfX = 15;
    const halfZ = 3;
    const corners = projectModuleFootprintCorners({
      x: 0, z: 0, rotY: Math.PI / 2, halfX, halfZ,
    });
    // Corner 0 is local (-halfX, -halfZ). Under the atlas convention at rotY=π/2
    //   x' = -halfX·0 + -halfZ·1 = -halfZ
    //   z' = -(-halfX)·1 + -halfZ·0 =  halfX
    // If the old (mirror) sign were still in effect it would land at
    // (halfZ, -halfX) instead — the two conventions swap +z/−z here.
    expect(corners[0].x).toBeCloseTo(-halfZ);
    expect(corners[0].z).toBeCloseTo(halfX);
    // Full corner walk under the atlas convention.
    expect(corners[1].x).toBeCloseTo(-halfZ);
    expect(corners[1].z).toBeCloseTo(-halfX);
    expect(corners[2].x).toBeCloseTo(halfZ);
    expect(corners[2].z).toBeCloseTo(-halfX);
    expect(corners[3].x).toBeCloseTo(halfZ);
    expect(corners[3].z).toBeCloseTo(halfX);
  });

  it('agrees with the atlas composition on an off-origin quarter-turn placement', () => {
    // Regression pin: composing the same rotY through atlasLayout's own
    // formula `(x·cos + z·sin, -x·sin + z·cos)` must produce the same
    // corner coordinates as projectModuleFootprintCorners for any pose.
    // Cross-checking with a manual computation ensures the two never drift
    // out of sync (if atlasLayout ever changes its convention, this pins
    // the pane to update in lockstep).
    const placement = { x: 20, z: -7, rotY: Math.PI / 3, halfX: 9, halfZ: 4 };
    const corners = projectModuleFootprintCorners(placement);
    const cos = Math.cos(placement.rotY);
    const sin = Math.sin(placement.rotY);
    const local: Array<[number, number]> = [
      [-placement.halfX, -placement.halfZ],
      [ placement.halfX, -placement.halfZ],
      [ placement.halfX,  placement.halfZ],
      [-placement.halfX,  placement.halfZ],
    ];
    for (let i = 0; i < 4; i++) {
      const [sx, sz] = local[i];
      const expected = {
        x: placement.x + sx * cos + sz * sin,
        z: placement.z - sx * sin + sz * cos,
      };
      expect(corners[i].x).toBeCloseTo(expected.x);
      expect(corners[i].z).toBeCloseTo(expected.z);
    }
  });
});

describe('fitPointsToCanvas', () => {
  it('returns a centred zero-scale viewport for the empty set', () => {
    const v = fitPointsToCanvas([], 300, 20);
    expect(v.scale).toBe(0);
    expect(v.offsetX).toBe(150);
    expect(v.offsetZ).toBe(150);
  });

  it('takes maxScale for a rangeless single-point input and centres it', () => {
    // Contract: when both x and z ranges are zero the fit cannot be data-
    // driven; the rangeless branch picks maxScale (defaults to 40) so a lone
    // point renders as large as the pane allows rather than pixel-tiny. This
    // is what the code actually does — the previous test title claimed
    // "clamps to minScale" but toBeGreaterThan(0) would have passed for
    // either branch.
    const v = fitPointsToCanvas([{ x: 5, z: -2 }], 400, 40);
    expect(v.scale).toBe(40);
    // The one point projects to the exact canvas centre regardless of scale.
    const p = projectPoint({ x: 5, z: -2 }, v);
    expect(p.x).toBeCloseTo(200);
    expect(p.z).toBeCloseTo(200);
  });

  it('honours an explicit maxScale on a rangeless single-point input', () => {
    // Pins the same rangeless branch when the caller supplies a maxScale
    // (e.g. the wall computer passes { maxScale: 40 }). The centre of the
    // pane is still on the point.
    const v = fitPointsToCanvas([{ x: 0, z: 0 }], 400, 40, { maxScale: 12 });
    expect(v.scale).toBe(12);
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
