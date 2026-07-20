/**
 * 🧱 Floor-plan doc — #66 S1 (door-slide), per brainstorming/floorplan-grid-plan.md
 *
 * One room-doc map `floorPlan` (furnitureDoc skeleton; T0 rebind):
 *   'meta'           → { v: 1 }
 *   `t:${i},${j}`    → TileRecord (seeded for forward-compat; S1 renders the
 *                      legacy square regardless — tiles activate in S3)
 *   `door:${DoorId}` → DoorPlacement { x, z } — the opening centre ON the
 *                      wall centerline, 0.5 m lattice.
 *
 * S1 CONSUMPTION MODEL — DELTAS, NOT ABSOLUTES: every anchor site (DOORS
 * walk targets, door 3D groups, vestibule/projection poses, exterior collars,
 * the north-door blocking zone) applies `placement − legacy` along the wall's
 * lateral axis to its own base value. Unmoved doors ⇒ delta 0 ⇒ bit-identical
 * legacy behavior (the plan's compatibility bar); the absolute derived
 * registry lands with S2's generation refactor.
 *
 * Gates (plan §6.2): owner-only UI on the write side; PAIRED doors cannot
 * move ("unpair first" — so #62 chain math never re-solves live); same-facing
 * slides only (a door's id IS its facing); 0.5 m lattice; clamped so the
 * opening + posts stay inside the wall run clear of corners.
 */

import * as Y from 'yjs';
import type { DoorId } from './doors';

export const DOOR_LATTICE = 0.5;
/** |lateral| bound keeping opening+posts inside the 11.8 run for BOTH door
 *  sizes (large: 1.2 half-opening + 0.3 post + margin from the ±5.9 corner). */
export const DOOR_LATERAL_LIMIT = 4.0;

/** Legacy placements verbatim (doors.ts front points project onto the wall). */
export const LEGACY_PLACEMENTS: Record<DoorId, { x: number; z: number }> = {
  north: { x: 0, z: -6 },
  south: { x: 0, z: 6 },
  east: { x: 6, z: -0.5 },
  west: { x: -6, z: -0.5 },
};

/** The slide axis per facing: n/s doors slide in x, e/w doors slide in z. */
export function lateralOf(doorId: DoorId, p: { x: number; z: number }): number {
  return doorId === 'north' || doorId === 'south' ? p.x : p.z;
}

// ── 📐 Room dimensions (rectangular-rooms-plan.md — #66 R0) ──────────────────
// A room is a W×H rectangle of 6 m tiles, centred on the origin. Today's room
// is exactly 2×2 tiles (walls at ±6). `floorPlan.dims → { cols, rows }`; absent
// or malformed ⇒ default 2×2 (bit-identical legacy). Everything spatial derives
// from roomHalfExtents(): halfX = cols·3, halfZ = rows·3.
export const TILE_SIZE = 6;
export const ROOM_TILE_MIN = 1;
export const ROOM_TILE_MAX = 5; // envelope: up to 5×5 tiles = 30×30 m (owner ruling 2026-07-20)
/** The default room in tiles — 2×2 = today's 12×12 (halfX = halfZ = 6). */
export const DEFAULT_DIMS: RoomDims = { cols: 2, rows: 2 };

export interface RoomDims { cols: number; rows: number }

/** Cached half-extents in metres — read cheaply per-cell in the walkable bake;
 *  recomputed only when the floorPlan map changes (see recomputeRoomHalf). */
let roomHalf = { halfX: DEFAULT_DIMS.cols * TILE_SIZE / 2, halfZ: DEFAULT_DIMS.rows * TILE_SIZE / 2 };

const BASE_TILES = [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const;

let boundDoc: Y.Doc | null = null;
let planMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[floorPlan] listener threw:', e); }
  }
}

export function bindFloorPlan(doc: Y.Doc): void {
  boundDoc = doc;
  planMap = doc.getMap('floorPlan');
  planMap.observe(() => { recomputeRoomHalf(); notify(); });
  recomputeRoomHalf();
  notify();
}

export function subscribeFloorPlan(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && planMap !== null;
}

/** Idempotent (no-op once any tile key exists): meta + the 4 base tiles + the
 *  four LEGACY door placements verbatim, one transact. Called lazily at the
 *  first structure commit — existing docs never grow unprompted (plan §3.1).
 *  Also stamps the roomInfo.minClient advisory (plan §3.5 convention). */
export function seedFloorPlan(): void {
  if (!docAlive()) return;
  for (const key of planMap!.keys()) {
    if (typeof key === 'string' && key.startsWith('t:')) return; // already seeded
  }
  boundDoc!.transact(() => {
    planMap!.set('meta', { v: 1 });
    for (const [i, j] of BASE_TILES) planMap!.set(`t:${i},${j}`, {});
    for (const id of ['north', 'south', 'east', 'west'] as DoorId[]) {
      planMap!.set(`door:${id}`, { ...LEGACY_PLACEMENTS[id] });
    }
    const roomInfo = boundDoc!.getMap('roomInfo');
    if (!roomInfo.get('minClient')) roomInfo.set('minClient', '0.32.1');
  });
}

/** 🧱 #66 R1: the wall coordinate a door's opening sits on, DERIVED from the
 *  room size — n/s doors on the ±halfZ walls, e/w on the ±halfX walls. Default
 *  2×2 room ⇒ ±6, matching LEGACY_PLACEMENTS exactly. This replaces the S1
 *  hard-coded ±6 equality that silently reverted any door on a moved wall. */
function doorWallCoord(doorId: DoorId): number {
  const { halfX, halfZ } = roomHalfExtents();
  switch (doorId) {
    case 'north': return -halfZ;
    case 'south': return halfZ;
    case 'east': return halfX;
    case 'west': return -halfX;
  }
}

/** 🧱 #66 R1: the along-wall slide clamp for a door, derived from ITS wall's
 *  run — n/s doors slide in X (wall run 2·halfX), e/w in Z (run 2·halfZ). The
 *  opening + posts must stay clear of the corner (~2 m inset), and we never
 *  exceed the legacy DOOR_LATERAL_LIMIT cap. Default 2×2 room ⇒ min(4.0, 6−2)
 *  = 4.0, exactly the legacy bound (byte-identical). A narrow rectangle (e.g. a
 *  1-tile axis, half=3) shrinks it to 1.0 so a door can never slide off-wall. */
const DOOR_LATERAL_CLEARANCE = 2.0;
function doorLateralLimit(doorId: DoorId): number {
  const { halfX, halfZ } = roomHalfExtents();
  const half = doorId === 'north' || doorId === 'south' ? halfX : halfZ;
  return Math.max(0, Math.min(DOOR_LATERAL_LIMIT, half - DOOR_LATERAL_CLEARANCE));
}

/** A door's default (un-slid) placement for the CURRENT room size: the derived
 *  wall coord plus the legacy lateral base. The read-side fallback — so an
 *  absent/malformed record degrades to THIS room's wall, not the old ±6. */
function defaultPlacement(doorId: DoorId): { x: number; z: number } {
  const legacy = LEGACY_PLACEMENTS[doorId];
  const wall = doorWallCoord(doorId);
  return doorId === 'north' || doorId === 'south'
    ? { x: legacy.x, z: wall }
    : { x: wall, z: legacy.z };
}

/** Owner UI: place a door's opening centre (lateral along its wall; the wall
 *  coordinate is pinned by the facing AND the room size). Snapped + clamped
 *  here as well as on read — write-side prevention, read-side repair. */
export function writeDoorPlacement(doorId: DoorId, lateral: number): void {
  if (!docAlive() || !Number.isFinite(lateral)) return;
  const snapped = Math.round(lateral / DOOR_LATTICE) * DOOR_LATTICE;
  const limit = doorLateralLimit(doorId);
  const clamped = Math.max(-limit, Math.min(limit, snapped));
  const wall = doorWallCoord(doorId);
  const p = doorId === 'north' || doorId === 'south'
    ? { x: clamped, z: wall }
    : { x: wall, z: clamped };
  boundDoc!.transact(() => {
    planMap!.set(`door:${doorId}`, p);
  });
}

/** Sanitized read of one door's placement (default when absent/malformed):
 *  finite, on the 0.5 lattice, within the lateral bound, wall coord exact. */
export function readDoorPlacement(doorId: DoorId): { x: number; z: number } {
  const fallback = defaultPlacement(doorId);
  if (!docAlive()) return fallback;
  const raw = planMap!.get(`door:${doorId}`) as Partial<{ x: number; z: number }> | undefined;
  if (!raw || typeof raw.x !== 'number' || typeof raw.z !== 'number'
    || !Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return fallback;
  const northSouth = doorId === 'north' || doorId === 'south';
  const wall = northSouth ? raw.z : raw.x;
  const lateral = northSouth ? raw.x : raw.z;
  if (wall !== doorWallCoord(doorId)) return fallback;
  if (!Number.isInteger(lateral * 2) || Math.abs(lateral) > doorLateralLimit(doorId)) return fallback;
  return { ...raw } as { x: number; z: number };
}

/**
 * The S1 currency: per-door LATERAL DELTA from the legacy placement.
 * 0 everywhere ⇒ today's room, bit-identical.
 */
export function readDoorDeltas(): Record<DoorId, number> {
  const out = {} as Record<DoorId, number>;
  for (const id of ['north', 'south', 'east', 'west'] as DoorId[]) {
    out[id] = lateralOf(id, readDoorPlacement(id)) - lateralOf(id, LEGACY_PLACEMENTS[id]);
  }
  return out;
}

// ── 📐 Room dimensions read/write (R0 — no consumers yet) ────────────────────

function sanitizeTileCount(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (n < ROOM_TILE_MIN || n > ROOM_TILE_MAX) return null;
  return n;
}

/** Sanitized read of the room's tile dimensions. Absent or malformed on EITHER
 *  axis ⇒ the whole thing falls back to DEFAULT_DIMS (2×2) — a partially-written
 *  or hostile `dims` can never yield a lopsided room. */
export function readRoomDims(): RoomDims {
  if (!docAlive()) return { ...DEFAULT_DIMS };
  const raw = planMap!.get('dims') as Partial<RoomDims> | undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DIMS };
  const cols = sanitizeTileCount(raw.cols);
  const rows = sanitizeTileCount(raw.rows);
  if (cols === null || rows === null) return { ...DEFAULT_DIMS };
  return { cols, rows };
}

/** Cached half-extents in metres derived from the sanitized dims. Cheap enough
 *  to call per walkable-cell; the doc read happens only on recomputeRoomHalf. */
export function roomHalfExtents(): { halfX: number; halfZ: number } {
  return roomHalf;
}

function recomputeRoomHalf(): void {
  const { cols, rows } = readRoomDims();
  roomHalf = { halfX: cols * TILE_SIZE / 2, halfZ: rows * TILE_SIZE / 2 };
}

/** Owner UI: set the room's rectangular size in 6 m tiles. Sanitized here as
 *  well as on read. Bumps meta.v→2 + minClient so a pre-rectangle client that
 *  loads a resized room is warned (it would render the legacy 2×2 walls). */
export function writeRoomDims(cols: number, rows: number): void {
  if (!docAlive()) return;
  const c = sanitizeTileCount(cols);
  const r = sanitizeTileCount(rows);
  if (c === null || r === null) return;
  boundDoc!.transact(() => {
    planMap!.set('dims', { cols: c, rows: r });
    const nonDefault = c !== DEFAULT_DIMS.cols || r !== DEFAULT_DIMS.rows;
    if (nonDefault) {
      planMap!.set('meta', { v: 2 });
      const roomInfo = boundDoc!.getMap('roomInfo');
      roomInfo.set('minClient', '0.32.36');
    }
  });
}
