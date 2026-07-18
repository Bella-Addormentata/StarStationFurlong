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
  planMap.observe(() => notify());
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

/** Owner UI: place a door's opening centre (lateral along its wall; the wall
 *  coordinate is pinned by the facing). Snapped + clamped here as well as on
 *  read — write-side prevention, read-side repair. */
export function writeDoorPlacement(doorId: DoorId, lateral: number): void {
  if (!docAlive() || !Number.isFinite(lateral)) return;
  const snapped = Math.round(lateral / DOOR_LATTICE) * DOOR_LATTICE;
  const clamped = Math.max(-DOOR_LATERAL_LIMIT, Math.min(DOOR_LATERAL_LIMIT, snapped));
  const legacy = LEGACY_PLACEMENTS[doorId];
  const p = doorId === 'north' || doorId === 'south'
    ? { x: clamped, z: legacy.z }
    : { x: legacy.x, z: clamped };
  boundDoc!.transact(() => {
    planMap!.set(`door:${doorId}`, p);
  });
}

/** Sanitized read of one door's placement (legacy when absent/malformed):
 *  finite, on the 0.5 lattice, within the lateral bound, wall coord exact. */
export function readDoorPlacement(doorId: DoorId): { x: number; z: number } {
  const legacy = LEGACY_PLACEMENTS[doorId];
  if (!docAlive()) return { ...legacy };
  const raw = planMap!.get(`door:${doorId}`) as Partial<{ x: number; z: number }> | undefined;
  if (!raw || typeof raw.x !== 'number' || typeof raw.z !== 'number'
    || !Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return { ...legacy };
  const northSouth = doorId === 'north' || doorId === 'south';
  const wall = northSouth ? raw.z : raw.x;
  const lateral = northSouth ? raw.x : raw.z;
  if (wall !== (northSouth ? legacy.z : legacy.x)) return { ...legacy };
  if (!Number.isInteger(lateral * 2) || Math.abs(lateral) > DOOR_LATERAL_LIMIT) return { ...legacy };
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
