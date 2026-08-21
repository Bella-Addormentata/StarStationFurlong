/**
 * 🧱 floorPlanDoc — #66 tests.
 *
 * Two intents in one suite:
 *
 *  1. S2 zero-diff bar. The generation refactor's compatibility promise (plan
 *     §3.1) is that a room untouched by the new features renders bit-identical
 *     to legacy. Concretely: a doc with NO dims key ⇒ 2×2 tiles ⇒ ±6 walls ⇒
 *     legacy door placements ⇒ zero deltas. Regressions here (a stray meta.v
 *     bump, a defaultPlacement drift) would silently move every door on every
 *     already-shipped room. Zero-diff is asserted as SPECIFIC BYTES against the
 *     legacy record (halfExtents = 6, deltas = 0, placements === LEGACY, and
 *     the on-the-wire door key still exactly ±6), so a "close but not equal"
 *     shift can't sneak past.
 *
 *  2. S3 dims read/write. The rectangular-rooms API — sanitize on read AND
 *     write, envelope + integer + shape guards, meta.v/minClient advisory only
 *     when dims are non-default, dims-driven doorWallCoord + doorLateralLimit —
 *     each with a positive AND a negative case (round-trip vs the specific
 *     hostile write that would break it).
 *
 * Discipline follows treasuryDoc.test.ts: fresh Y.Doc per test, bindFloorPlan,
 * hostile writes exercised through `doc.getMap('floorPlan').set(...)` (the
 * write-side sanitizer never touched), and specific-value assertions on both
 * the read API and the raw map contents.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindFloorPlan,
  subscribeFloorPlan,
  seedFloorPlan,
  readRoomDims,
  writeRoomDims,
  roomHalfExtents,
  roomWalkBounds,
  roomPlaceBounds,
  readDoorPlacement,
  writeDoorPlacement,
  readDoorDeltas,
  doorLateralLimitForWall,
  LEGACY_PLACEMENTS,
  DEFAULT_DIMS,
  TILE_SIZE,
  ROOM_TILE_MIN,
  ROOM_TILE_MAX,
  WALL_CLEARANCE,
} from './floorPlanDoc';
import { bindFurnitureDoc, writeFurnitureItem } from './furnitureDoc';
import type { DoorId } from './doors';

/** All four door ids — the test surface for placement / delta / wall coord. */
const DOORS: DoorId[] = ['north', 'south', 'east', 'west'];

let doc: Y.Doc;
let plan: Y.Map<unknown>;

beforeEach(() => {
  doc = new Y.Doc();
  bindFloorPlan(doc);
  // 🧱 #66 S3 (audit remediation): writeRoomDims consults the furniture doc to
  // refuse a shrink that would strand items. Bind the SAME Y.Doc so the check
  // sees an empty map by default (existing tests behave unchanged), and the
  // dedicated stranded-furniture tests can populate it deliberately.
  bindFurnitureDoc(doc);
  plan = doc.getMap('floorPlan');
});

// ── 1. S2 zero-diff bar ──────────────────────────────────────────────────────

describe('S2 zero-diff: an untouched room reproduces legacy bit-for-bit', () => {
  it('unbound dims fall back to DEFAULT_DIMS = 2×2 (halfX=halfZ=6)', () => {
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
    expect(roomHalfExtents()).toEqual({ halfX: 6, halfZ: 6 });
    // Belt-and-braces: the DEFAULT_DIMS constant itself did not drift.
    expect(DEFAULT_DIMS).toEqual({ cols: 2, rows: 2 });
    expect(TILE_SIZE).toBe(6);
  });

  it('walkable + placement boxes derive from the same 6 m halfExtents', () => {
    // Numbers matched to the WALL_CLEARANCE (0.5 m) + placement-inset (1 m)
    // rulings in floorPlanDoc: a regression in either constant would show up
    // here rather than at a distant call site.
    expect(roomWalkBounds()).toEqual({ boundX: 6 - WALL_CLEARANCE, boundZ: 6 - WALL_CLEARANCE });
    expect(roomPlaceBounds()).toEqual({ boundX: 6 - 1.0, boundZ: 6 - 1.0 });
  });

  it('every default-room door reads exactly the LEGACY placement (zero deltas)', () => {
    for (const id of DOORS) {
      expect(readDoorPlacement(id)).toEqual(LEGACY_PLACEMENTS[id]);
    }
    const deltas = readDoorDeltas();
    for (const id of DOORS) expect(deltas[id]).toBe(0);
  });

  it('doorLateralLimitForWall matches the legacy 4.0 cap on the default room', () => {
    for (const w of ['x+', 'x-', 'y+', 'y-'] as const) {
      expect(doorLateralLimitForWall(w)).toBe(4.0);
    }
  });

  it('seedFloorPlan writes LEGACY door records byte-identical to the ±6 wall', () => {
    seedFloorPlan();
    // Raw wire values, not just the sanitized read: a drift in seedFloorPlan
    // would land a wrong z on north/south or wrong x on east/west and only
    // surface as a "door on the wrong wall" bug months later.
    expect(plan.get('door:north')).toEqual({ x: 0, z: -6 });
    expect(plan.get('door:south')).toEqual({ x: 0, z: 6 });
    expect(plan.get('door:east')).toEqual({ x: 6, z: -0.5 });
    expect(plan.get('door:west')).toEqual({ x: -6, z: -0.5 });
    // A seeded, but never-resized, room stays at meta.v=1 — v=2 is the
    // advisory tripwire reserved for non-default dims.
    expect(plan.get('meta')).toEqual({ v: 1 });
  });

  it('writing default dims does NOT stamp meta.v=2 / minClient (advisory reserved for changes)', () => {
    writeRoomDims(2, 2);
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
    // A default-dims write may create the dims key, but it must NOT trip the
    // advisory — a well-behaved client re-asserting the current shape can't
    // fabricate an "older clients won't render this" alert on a normal room.
    const meta = plan.get('meta') as { v?: number } | undefined;
    expect(meta?.v).not.toBe(2);
    const roomInfo = doc.getMap('roomInfo');
    expect(roomInfo.get('minClient')).toBeUndefined();
  });
});

// ── 2. S3 dims read/write ────────────────────────────────────────────────────

describe('writeRoomDims: sanitization on the write side', () => {
  it('rejects a non-integer axis (defense in depth; UI also disables)', () => {
    writeRoomDims(2.5, 2);
    expect(plan.get('dims')).toBeUndefined();
    writeRoomDims(2, 2.5);
    expect(plan.get('dims')).toBeUndefined();
  });

  it('rejects Infinity / NaN / non-number', () => {
    writeRoomDims(NaN, 2);
    writeRoomDims(2, Infinity);
    writeRoomDims('3' as unknown as number, 2);
    expect(plan.get('dims')).toBeUndefined();
  });

  it('rejects an axis below ROOM_TILE_MIN', () => {
    writeRoomDims(ROOM_TILE_MIN - 1, 2);
    expect(plan.get('dims')).toBeUndefined();
    writeRoomDims(0, 0);
    expect(plan.get('dims')).toBeUndefined();
  });

  it('rejects an axis above ROOM_TILE_MAX', () => {
    writeRoomDims(ROOM_TILE_MAX + 1, 2);
    expect(plan.get('dims')).toBeUndefined();
    writeRoomDims(9999, 9999);
    expect(plan.get('dims')).toBeUndefined();
  });

  it('accepts the ROOM_TILE_MIN and ROOM_TILE_MAX boundary values', () => {
    writeRoomDims(ROOM_TILE_MIN, ROOM_TILE_MIN);
    expect(readRoomDims()).toEqual({ cols: ROOM_TILE_MIN, rows: ROOM_TILE_MIN });
    writeRoomDims(ROOM_TILE_MAX, ROOM_TILE_MAX);
    expect(readRoomDims()).toEqual({ cols: ROOM_TILE_MAX, rows: ROOM_TILE_MAX });
    // A rectangular (non-square) shape must also round-trip; the API is not
    // secretly square-only.
    writeRoomDims(3, 5);
    expect(readRoomDims()).toEqual({ cols: 3, rows: 5 });
  });
});

describe('writeRoomDims: advisory stamps on NON-default dims (plan §3.5)', () => {
  it('stamps meta.v=2 and roomInfo.minClient on a non-default write', () => {
    writeRoomDims(3, 3);
    expect(plan.get('meta')).toEqual({ v: 2 });
    const roomInfo = doc.getMap('roomInfo');
    expect(roomInfo.get('minClient')).toBe('0.32.36');
  });

  it('a per-axis non-default (default × non-default) still trips the advisory', () => {
    writeRoomDims(2, 3);
    expect(plan.get('meta')).toEqual({ v: 2 });
    expect(doc.getMap('roomInfo').get('minClient')).toBe('0.32.36');
  });
});

describe('readRoomDims: sanitization on the read side (hostile-write repair)', () => {
  it('non-object dims payload ⇒ default fallback', () => {
    plan.set('dims', 'nope');
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
    plan.set('dims', null);
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
  });

  it('missing cols OR rows ⇒ default fallback (never lopsided)', () => {
    plan.set('dims', { cols: 3 });
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
    plan.set('dims', { rows: 4 });
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
  });

  it('non-integer axis ⇒ default fallback', () => {
    plan.set('dims', { cols: 2.5, rows: 3 });
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
  });

  it('out-of-range axis ⇒ default fallback (envelope enforced on read too)', () => {
    plan.set('dims', { cols: 99, rows: 2 });
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
    plan.set('dims', { cols: 3, rows: 0 });
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
  });
});

describe('roomHalfExtents: dims-driven and observer-fresh', () => {
  it('3×3 tiles ⇒ halfX=halfZ=9', () => {
    writeRoomDims(3, 3);
    expect(roomHalfExtents()).toEqual({ halfX: 9, halfZ: 9 });
  });

  it('rectangular 4×2 ⇒ halfX=12, halfZ=6', () => {
    writeRoomDims(4, 2);
    expect(roomHalfExtents()).toEqual({ halfX: 12, halfZ: 6 });
  });

  it('the MAX 5×5 ⇒ halfX=halfZ=15 (matches pre-baked pathfinding envelope)', () => {
    writeRoomDims(ROOM_TILE_MAX, ROOM_TILE_MAX);
    expect(roomHalfExtents()).toEqual({ halfX: 15, halfZ: 15 });
  });

  it('walkable + placement bounds track the fresh dims (grew room ⇒ grew boxes)', () => {
    writeRoomDims(3, 3);
    expect(roomWalkBounds()).toEqual({ boundX: 9 - WALL_CLEARANCE, boundZ: 9 - WALL_CLEARANCE });
    expect(roomPlaceBounds()).toEqual({ boundX: 8, boundZ: 8 });
  });
});

describe('subscribeFloorPlan: writeRoomDims fires the shared subscription', () => {
  it('notifies listeners on a dims write (so world can reconcile)', () => {
    // A fresh doc + bindFloorPlan already fired the initial notify from
    // bind; register AFTER the bind so we only count the dims-write signal.
    let fired = 0;
    const unsub = subscribeFloorPlan(() => { fired++; });
    writeRoomDims(3, 3);
    expect(fired).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it('a rejected write (out-of-range) does NOT fire the subscription', () => {
    let fired = 0;
    const unsub = subscribeFloorPlan(() => { fired++; });
    writeRoomDims(9999, 9999); // rejected by sanitizeTileCount
    expect(fired).toBe(0); // no map mutation ⇒ no notify
    unsub();
  });
});

// ── 3. Dims-driven door geometry (S1 currency, S3 room-frame invariants) ─────

// ── 4. audit-remediation guards (writeRoomDims result contract + shrink safety
// + advisory downgrade) ─────────────────────────────────────────────────────

describe('writeRoomDims: result contract (audit remediation)', () => {
  it('returns { ok: true } on a successful write', () => {
    const result = writeRoomDims(3, 3);
    expect(result).toEqual({ ok: true });
    expect(readRoomDims()).toEqual({ cols: 3, rows: 3 });
  });

  it('returns { ok: false, reason: "invalid-dims" } for a non-integer axis', () => {
    const result = writeRoomDims(2.5, 2);
    expect(result).toEqual({ ok: false, reason: 'invalid-dims' });
    expect(plan.get('dims')).toBeUndefined();
  });

  it('returns { ok: false, reason: "invalid-dims" } for out-of-envelope input', () => {
    const belowMin = writeRoomDims(ROOM_TILE_MIN - 1, 2);
    expect(belowMin).toEqual({ ok: false, reason: 'invalid-dims' });
    const aboveMax = writeRoomDims(ROOM_TILE_MAX + 1, 2);
    expect(aboveMax).toEqual({ ok: false, reason: 'invalid-dims' });
    const nan = writeRoomDims(NaN, 2);
    expect(nan).toEqual({ ok: false, reason: 'invalid-dims' });
  });
});

describe('writeRoomDims: shrink-would-strand-furniture guard (audit Fix 3)', () => {
  it('refuses a shrink that would leave a placed item past the new wall', () => {
    // Author a room at 4×4 (halfX=halfZ=12) with a lamp near the edge of the
    // WALK box (±11, safely inside the ±11 placement bound). A shrink to 2×2
    // brings the placement bound down to ±5 — the lamp at (10, 0) now sits
    // 5 m past the new wall.
    writeRoomDims(4, 4);
    writeFurnitureItem({
      id: 'test-stranded-lamp',
      kind: 'lamp-table',
      pos: { x: 10, z: 0 },
      rot: 0,
      movable: true,
    });
    const result = writeRoomDims(2, 2);
    expect(result).toEqual({ ok: false, reason: 'stranded-furniture' });
    // The refusal is a genuine gate — dims + advisory unchanged.
    expect(readRoomDims()).toEqual({ cols: 4, rows: 4 });
    expect(plan.get('meta')).toEqual({ v: 2 });
    expect(doc.getMap('roomInfo').get('minClient')).toBe('0.32.36');
  });

  it('allows a shrink when every item is still inside the new placement box', () => {
    writeRoomDims(4, 4);
    writeFurnitureItem({
      id: 'test-safe-lamp',
      kind: 'lamp-table',
      pos: { x: 2, z: 2 }, // well inside a 2×2 room's ±5 placement bound
      rot: 0,
      movable: true,
    });
    const result = writeRoomDims(2, 2);
    expect(result).toEqual({ ok: true });
    expect(readRoomDims()).toEqual({ cols: 2, rows: 2 });
  });

  it('growth NEVER checks the strand condition (the new box strictly contains the old)', () => {
    // Put an item on the current 2×2 room's placement edge (x=5, z=0), then
    // grow to 3×3. The check would still pass, but this asserts the semantic:
    // growth must succeed regardless of item layout.
    writeFurnitureItem({
      id: 'test-grow-lamp',
      kind: 'lamp-table',
      pos: { x: 5, z: 0 },
      rot: 0,
      movable: true,
    });
    const result = writeRoomDims(3, 3);
    expect(result).toEqual({ ok: true });
    expect(readRoomDims()).toEqual({ cols: 3, rows: 3 });
  });

  it('same-size write is not a shrink and never gates on furniture', () => {
    writeRoomDims(3, 3);
    writeFurnitureItem({
      id: 'test-edge-lamp',
      kind: 'lamp-table',
      pos: { x: 7.5, z: 0 }, // inside 3×3 (bound ±8)
      rot: 0,
      movable: true,
    });
    const result = writeRoomDims(3, 3);
    expect(result).toEqual({ ok: true });
  });
});

describe('writeRoomDims: advisory downgrade on shrink-to-default (audit Fix 4)', () => {
  it('shrink from advisory dims BACK to 2×2 clears meta.v=2 and 0.32.36 minClient', () => {
    // Author a 3×3 room — this stamps meta.v=2 + minClient='0.32.36'.
    writeRoomDims(3, 3);
    expect(plan.get('meta')).toEqual({ v: 2 });
    expect(doc.getMap('roomInfo').get('minClient')).toBe('0.32.36');
    // Shrink back to the default 2×2. No furniture, so the shrink is allowed.
    const result = writeRoomDims(2, 2);
    expect(result).toEqual({ ok: true });
    // Advisory is downgraded: the room is legacy-shaped again, so an older
    // client that gates on minClient shouldn't be refused entry.
    expect(plan.get('meta')).toEqual({ v: 1 });
    expect(doc.getMap('roomInfo').get('minClient')).toBe('0.32.1');
  });

  it('shrink-to-default does NOT fabricate an advisory when the doc has none (Case-C invariant)', () => {
    // A fresh doc that never grew has NO meta and NO minClient. Writing the
    // default dims must NOT stamp an advisory to downgrade — the room stays
    // as-is and would still boot on the oldest clients.
    writeRoomDims(2, 2);
    // meta may exist (previous test showed dims-write is a separate concern)
    // but must not be v=2, and minClient must not be pinned to a version.
    const meta = plan.get('meta') as { v?: number } | undefined;
    expect(meta?.v).not.toBe(2);
    expect(doc.getMap('roomInfo').get('minClient')).toBeUndefined();
  });

  it('downgrade is DEFENSIVE — leaves a foreign advisory alone', () => {
    // A theoretical future advisory stamped by a newer release (meta.v=3, a
    // different minClient string) must be left intact: this release did not
    // raise it, so this release must not lower it. The write still lands.
    plan.set('meta', { v: 3 });
    doc.getMap('roomInfo').set('minClient', '0.99.0');
    const result = writeRoomDims(2, 2);
    expect(result).toEqual({ ok: true });
    expect(plan.get('meta')).toEqual({ v: 3 });
    expect(doc.getMap('roomInfo').get('minClient')).toBe('0.99.0');
  });

  it('a non-default write keeps meta.v=2 + minClient="0.32.36" (Case B seed remains)', () => {
    // 4×2 (rectangular) is non-default; the advisory must be stamped.
    const result = writeRoomDims(4, 2);
    expect(result).toEqual({ ok: true });
    expect(plan.get('meta')).toEqual({ v: 2 });
    expect(doc.getMap('roomInfo').get('minClient')).toBe('0.32.36');
  });
});

describe('door placement tracks dims changes (walls in the LOCAL frame stay axis-aligned)', () => {
  it('growing to 3×3 moves each door onto its FRESH wall (default lateral)', () => {
    writeRoomDims(3, 3);
    // n/s walls now at ±9; e/w walls now at ±9. Default lateral preserved.
    expect(readDoorPlacement('north')).toEqual({ x: 0, z: -9 });
    expect(readDoorPlacement('south')).toEqual({ x: 0, z: 9 });
    expect(readDoorPlacement('east')).toEqual({ x: 9, z: -0.5 });
    expect(readDoorPlacement('west')).toEqual({ x: -9, z: -0.5 });
    // All zero deltas — a resize alone must not synthesize a slide.
    const deltas = readDoorDeltas();
    for (const id of DOORS) expect(deltas[id]).toBe(0);
  });

  it('a stale door record stuck on the OLD wall is repaired to the fresh default', () => {
    // Author a slid door at 2×2 (wall z=−6), then grow — the stale wall coord
    // no longer matches doorWallCoord and readDoorPlacement must fall back.
    writeDoorPlacement('north', 1.0);
    expect(readDoorPlacement('north')).toEqual({ x: 1, z: -6 });
    writeRoomDims(3, 3);
    // The record now has the wrong wall (z=−6) for the 3×3 room (z=−9); read
    // must repair to the fresh default (x=0, z=−9), never render a floating door.
    expect(readDoorPlacement('north')).toEqual({ x: 0, z: -9 });
  });

  it('a 1-tile axis shrinks the door lateral limit so a door cannot slide off-wall', () => {
    // halfX = 3 ⇒ n/s lateral limit = max(0, min(4.0, 3-2)) = 1.0.
    // halfZ = 3 ⇒ e/w lateral limit = 1.0 by the same math.
    writeRoomDims(1, 1);
    expect(doorLateralLimitForWall('y-')).toBe(1.0);
    expect(doorLateralLimitForWall('y+')).toBe(1.0);
    expect(doorLateralLimitForWall('x-')).toBe(1.0);
    expect(doorLateralLimitForWall('x+')).toBe(1.0);
    // A slide beyond the shrunk limit is clamped INWARD onto the lattice.
    writeDoorPlacement('north', 3.5);
    // For n/s the on-grid lattice is the whole integers (base=0). Clamp inward
    // from 3.5 to ≤ 1.0 lands on 1 exactly.
    const north = readDoorPlacement('north');
    expect(north.x).toBeLessThanOrEqual(1.0);
    expect(north.x).toBeGreaterThanOrEqual(-1.0);
    // The wall coord follows the shrunk room, not the legacy ±6.
    expect(north.z).toBe(-3);
  });
});
