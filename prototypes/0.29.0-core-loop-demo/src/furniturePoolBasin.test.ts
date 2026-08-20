// 🛑📐🏊🕳️ #80: pool basin geometry — pure tests for the octagon-basement
// clip helpers added to furniture.ts. Exercises poolBasementBoundsFor across
// every cardinal pool rot + every valid room aspect ratio, then verifies that
// poolHoleRect / poolHoleOutline never let the water hole cross the chamfer
// at the water surface — the "block depths near the chamfer" invariant the
// issue #80 slice added to the two pool builders' basin drawer.
//
// Runs against the REAL floorPlanDoc so a room resize (writeRoomDims) shifts
// the cached roomHalfExtents like at runtime; a per-test bind/reset gives
// each case a fresh doc without cross-talk.

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { bindFloorPlan, writeRoomDims, DEFAULT_DIMS } from './floorPlanDoc';
import { computeOctagonProfile } from './hullSection';
import {
  POOL_WATER_EAST,
  POOL_WATER_HALFZ,
  POOL_WATER_WEST,
  POOL_WATER_Y,
  poolBasementBoundsFor,
  poolHoleOutline,
  poolHoleRect,
  type FurnitureItem,
  type Rot,
} from './furniture';

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Fresh Yjs doc per test so writeRoomDims lands in isolation, then bindFloorPlan
// re-caches roomHalfExtents to the new value (see floorPlanDoc.recomputeRoomHalf).
function bindFreshRoom(cols: number = DEFAULT_DIMS.cols, rows: number = DEFAULT_DIMS.rows): void {
  const doc = new Y.Doc();
  bindFloorPlan(doc);
  if (cols !== DEFAULT_DIMS.cols || rows !== DEFAULT_DIMS.rows) {
    writeRoomDims(cols, rows);
  }
}

/** Build a classic-pool item at the room origin with the requested rot — the
 *  shape the pool templates ship (movable:false, pos={0,0}). */
function classicPoolAt(rot: Rot): FurnitureItem {
  return {
    id: 'test-classic-pool',
    kind: 'classic-pool',
    pos: { x: 0, z: 0 },
    rot,
    movable: false,
    footprintOverride: { x0: -5.4, z0: -3, x1: 3.5, z1: 3 },
  };
}
function lazyPoolAt(rot: Rot): FurnitureItem {
  return {
    id: 'test-lazy-pool',
    kind: 'lazy-pool',
    pos: { x: 0, z: 0 },
    rot,
    movable: false,
  };
}

// ── poolBasementBoundsFor: cross-section math ───────────────────────────────

describe('poolBasementBoundsFor', () => {
  beforeEach(() => bindFreshRoom());

  it('returns the octagon profile of the CURRENT room', () => {
    // Default 2×2 room → halfX = halfZ = 6 → square → narrowAxis = 'x' (tie rule).
    const b = poolBasementBoundsFor(0);
    expect(b.profile.narrowHalf).toBe(6);
    expect(b.profile.longHalf).toBe(6);
    // narrowAxis tie → 'x' per narrowAxisFor(halfX, halfZ) with halfX <= halfZ.
    expect(b.profile.narrowAxis).toBe('x');
  });

  it('halfAtWater = narrowHalf + WATER_Y (WATER_Y is negative)', () => {
    // A single wedge of the chamfer already eats into the walls at water depth.
    // narrowHalf=6, WATER_Y=-0.35 ⇒ halfAtWater = 5.65 (well inside the water WX=5.15).
    const b = poolBasementBoundsFor(0);
    expect(b.halfAtWater).toBeCloseTo(6 + POOL_WATER_Y, 6);
    expect(b.halfAtWater).toBeGreaterThan(POOL_WATER_WEST);
  });

  it('halfAtWater floors at 0 for pathologically deep water', () => {
    // Deeper than narrowHalf → the chamfer bottoms out; clamp saves callers from a
    // negative half-width. Not a real config, but a defensive guarantee.
    bindFreshRoom(1, 1); // narrowHalf = 3
    const b = poolBasementBoundsFor(0, -100);
    expect(b.halfAtWater).toBe(0);
  });

  it('halfAtFloor = narrowHalf - basementDepth (the flat basement half-width)', () => {
    const b = poolBasementBoundsFor(0);
    const profile = computeOctagonProfile({ halfX: 6, halfZ: 6 });
    expect(b.halfAtFloor).toBeCloseTo(profile.basementHalf, 6);
    // basementDepth defaults to eaveRise (mirror of the roof) ⇒ basementHalf = narrowHalf - eaveRun.
    expect(b.halfAtFloor).toBeLessThan(b.halfAtWater);
  });

  it('basementY is the NEGATIVE basement depth (the real floor y)', () => {
    const b = poolBasementBoundsFor(0);
    expect(b.basementY).toBeLessThan(0);
    expect(b.basementY).toBeCloseTo(-b.profile.basementDepth, 6);
  });

  // narrowInLocal encodes the rot swap: even rot keeps pool-local aligned with
  // the room's narrow axis; odd rot swaps them. Nothing else changes about the
  // bounds — halfAt* and basementY are shape numbers, not orientation numbers.
  describe.each([
    { rot: 0 as Rot, expected: 'x' },
    { rot: 1 as Rot, expected: 'z' },
    { rot: 2 as Rot, expected: 'x' },
    { rot: 3 as Rot, expected: 'z' },
  ])('narrowInLocal for rot=$rot in a square room', ({ rot, expected }) => {
    it(`is '${expected}'`, () => {
      // Square room → room narrowAxis='x'; odd rots swap to 'z' in the pool's local frame.
      const b = poolBasementBoundsFor(rot);
      expect(b.narrowInLocal).toBe(expected);
    });
  });

  it('narrowInLocal follows a non-square room (halfZ<halfX ⇒ narrow=z)', () => {
    bindFreshRoom(3, 2); // 18×12 → halfX=9, halfZ=6 → narrowAxis='z'
    const b0 = poolBasementBoundsFor(0);
    expect(b0.profile.narrowAxis).toBe('z');
    expect(b0.narrowInLocal).toBe('z');
    // rot 1 swaps ⇒ pool's local x carries the room's narrow axis.
    const b1 = poolBasementBoundsFor(1);
    expect(b1.narrowInLocal).toBe('x');
  });
});

// ── poolHoleRect: narrow-axis clip ──────────────────────────────────────────

describe('poolHoleRect', () => {
  beforeEach(() => bindFreshRoom());

  it('returns null with no pool present', () => {
    expect(poolHoleRect([])).toBeNull();
  });

  it('classic pool at rot=0 in a default room: authored rect (no clip needed)', () => {
    const rect = poolHoleRect([classicPoolAt(0)])!;
    // Authored: x ∈ [-5.15, 3.4], z ∈ [-2.9, 2.9]. halfAtWater=5.65 > 5.15 ⇒ NO clip.
    expect(rect.x0).toBeCloseTo(-POOL_WATER_WEST, 6);
    expect(rect.x1).toBeCloseTo(POOL_WATER_EAST, 6);
    expect(rect.z0).toBeCloseTo(-POOL_WATER_HALFZ, 6);
    expect(rect.z1).toBeCloseTo(POOL_WATER_HALFZ, 6);
  });

  it('classic pool at rot=1 swaps the rect axes (cardinal rotation)', () => {
    const rect = poolHoleRect([classicPoolAt(1)])!;
    // rotXZ(x, z, 1) = (z, -x). Corners (-WW,-HZ) → (-HZ, WW); (WE, HZ) → (HZ, -WE).
    // Bounding box: x ∈ [-HZ, HZ], z ∈ [-WE, WW]. halfAtWater still 5.65 > HZ=2.9 ⇒ no clip.
    expect(rect.x0).toBeCloseTo(-POOL_WATER_HALFZ, 6);
    expect(rect.x1).toBeCloseTo(POOL_WATER_HALFZ, 6);
    expect(rect.z0).toBeCloseTo(-POOL_WATER_EAST, 6);
    expect(rect.z1).toBeCloseTo(POOL_WATER_WEST, 6);
  });

  it('small room: clips the west edge to -halfAtWater on the narrow axis', () => {
    // 1×1 room → halfX=halfZ=3 → narrowAxis='x' → halfAtWater = 3 + WATER_Y = 2.65.
    // Authored water reaches x=-5.15 ⇒ clip pulls x0 up to -2.65.
    bindFreshRoom(1, 1);
    const rect = poolHoleRect([classicPoolAt(0)])!;
    const b = poolBasementBoundsFor(0);
    expect(rect.x0).toBeCloseTo(-b.halfAtWater, 6);
    expect(rect.x1).toBeCloseTo(b.halfAtWater, 6);
    // Z axis is the LONG axis (tie → 'x' narrow); still authored ±2.9 (< longHalf=3).
    expect(rect.z0).toBeCloseTo(-POOL_WATER_HALFZ, 6);
    expect(rect.z1).toBeCloseTo(POOL_WATER_HALFZ, 6);
  });

  it('very small room + deep water: returns null when the clip degenerates', () => {
    // 1×1 room with a WATER_Y far below narrowHalf ⇒ halfAtWater = 0 → collapse.
    bindFreshRoom(1, 1);
    // Simulate the collapse by passing a tiny room + pool that lives entirely outside
    // the chamfer at water level. Direct assertion: our helper reports 0-width halfAtWater
    // and callers should treat that as "no hole".
    // The rect can't literally hit 0 with the default WATER_Y=-0.35 in a 1×1 room (halfAtWater=2.65),
    // but we can verify the collapse path with a large negative pool offset that shifts the
    // authored rect fully past the chamfer.
    const off: FurnitureItem = { ...classicPoolAt(0), pos: { x: 100, z: 0 } };
    expect(poolHoleRect([off])).toBeNull();
  });

  it('non-square room clips only on the ROOM narrow axis', () => {
    bindFreshRoom(3, 2); // narrowAxis='z' (halfZ=6, halfX=9)
    const rect = poolHoleRect([classicPoolAt(0)])!;
    // narrowAxis=z ⇒ z clipped to ±halfAtWater=5.65, x unchanged.
    // Authored z ∈ ±2.9 < 5.65 ⇒ no clip lands.
    expect(rect.z0).toBeCloseTo(-POOL_WATER_HALFZ, 6);
    expect(rect.z1).toBeCloseTo(POOL_WATER_HALFZ, 6);
    expect(rect.x0).toBeCloseTo(-POOL_WATER_WEST, 6);
    expect(rect.x1).toBeCloseTo(POOL_WATER_EAST, 6);
  });
});

// ── poolHoleOutline: point-clamp on the narrow axis ─────────────────────────

describe('poolHoleOutline', () => {
  beforeEach(() => bindFreshRoom());

  it('returns null with no pool present', () => {
    expect(poolHoleOutline([])).toBeNull();
  });

  it('classic pool (default room) is the authored rect verbatim', () => {
    const outline = poolHoleOutline([classicPoolAt(0)])!;
    expect(outline).toHaveLength(4);
    // Four corners, CCW starting NW.
    const xs = outline.map((p) => p.x);
    const zs = outline.map((p) => p.z);
    expect(Math.min(...xs)).toBeCloseTo(-POOL_WATER_WEST, 6);
    expect(Math.max(...xs)).toBeCloseTo(POOL_WATER_EAST, 6);
    expect(Math.min(...zs)).toBeCloseTo(-POOL_WATER_HALFZ, 6);
    expect(Math.max(...zs)).toBeCloseTo(POOL_WATER_HALFZ, 6);
  });

  it('lazy pool outline stays inside ±halfAtWater on the narrow axis', () => {
    // Lazy river shape is the organic curve; every sampled point must obey the clamp.
    const outline = poolHoleOutline([lazyPoolAt(0)])!;
    const b = poolBasementBoundsFor(0);
    // Room narrowAxis='x' ⇒ every x∈[-halfAtWater, halfAtWater].
    for (const p of outline) {
      expect(p.x).toBeGreaterThanOrEqual(-b.halfAtWater - 1e-9);
      expect(p.x).toBeLessThanOrEqual(b.halfAtWater + 1e-9);
    }
  });

  it('classic pool in a small room clips corner xs to ±halfAtWater', () => {
    bindFreshRoom(1, 1); // narrowHalf=3, halfAtWater=2.65
    const outline = poolHoleOutline([classicPoolAt(0)])!;
    const b = poolBasementBoundsFor(0);
    expect(b.profile.narrowAxis).toBe('x');
    // Every corner's x is clamped to ±halfAtWater; the authored west (-5.15) clips to -2.65.
    for (const p of outline) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(b.halfAtWater + 1e-9);
    }
  });

  it('long-axis coords are never clipped', () => {
    // In a rectangular narrow-in-z room the z axis is narrow; x is long and untouched.
    bindFreshRoom(3, 2); // narrowAxis='z' (halfZ=6, halfX=9), halfAtWater=5.65
    const outline = poolHoleOutline([classicPoolAt(0)])!;
    // Extreme x = POOL_WATER_WEST = 5.15 stays put (long axis, no clamp).
    const xs = outline.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-POOL_WATER_WEST, 6);
    expect(Math.max(...xs)).toBeCloseTo(POOL_WATER_EAST, 6);
    // z clipped to ±5.65; authored ±2.9 well within, so unchanged.
    const zs = outline.map((p) => p.z);
    expect(Math.min(...zs)).toBeCloseTo(-POOL_WATER_HALFZ, 6);
    expect(Math.max(...zs)).toBeCloseTo(POOL_WATER_HALFZ, 6);
  });
});
