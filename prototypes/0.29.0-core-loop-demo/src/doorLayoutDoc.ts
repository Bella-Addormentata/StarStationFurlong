/**
 * 🚪 Door LAYOUT sync (#28 doors decouple, slice 4)
 *
 * WHICH doors a room has — id → {wall, lateral, size, enabled} — lives in a
 * room-doc `doorLayout` Y.Map, so a joiner sees the host's door set on entry and
 * the owner's future add / remove / move (slice 5+) propagates to everyone.
 * Before this, doors were a fixed code constant (the 4 cardinals) instantiated
 * identically on every client with no way to add or remove one.
 *
 * DELIBERATELY SEPARATE from two neighbours that sound the same:
 *  - the door PAIRING store (doorsDoc.ts, the `doors` map) — which room a port
 *    is docked to. Untouched; keyed by the stable cardinal PORT.
 *  - the door POSITION store (floorPlanDoc.ts `door:${id}` lateral) — the live
 *    slide. Untouched; still the sole source of a door's position.
 * This map answers only "which doors exist, on which wall". In slice 4 the
 * `lateral`/`enabled` values are SEED defaults + forward-compat for free doors;
 * position stays owned by floorPlan and runtime `enabled` stays owned by the
 * room (fireplace / casino), so behaviour is identical to the old literal.
 *
 * Rebinds per join like furniture / games / roomInfo (main.ts T0 seam). Reads
 * cross the peer trust boundary → shape-guarded by isDoorLayoutRecord.
 */

import * as Y from 'yjs';
import { findDoor } from './doors';
import { readDoorDeltas } from './floorPlanDoc';

export type DoorWall = 'north' | 'south' | 'east' | 'west';

/** Serializable door-membership record — one per door id. Plain JSON, the same
 *  discipline as the furniture map. */
export interface DoorLayoutRecord {
  id: string;
  wall: DoorWall;
  /** Along-wall slide (forward-compat / the slice-5 hand-off; NOT the live
   *  position in slice 4 — floorPlan owns that). Seeded from the current delta. */
  lateral: number;
  /** Leaf-width class. #91 collapsed doors to ONE size: this is still accepted
   *  (and still written) for backward/forward compat, but readAllDoorLayout
   *  normalizes every record to 'large' — nothing downstream branches on it. */
  size?: 'small' | 'large';
  /** SEED walkability only — runtime `enabled` is owned by the room
   *  (updateNorthDoorForFireplace / casino force-enable / DEV toggle). */
  enabled?: boolean;
}

let boundDoc: Y.Doc | null = null;
let doorLayoutMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy + isolate (the furnitureDoc guard): a listener may unsubscribe
  // mid-notify, and this runs inside Yjs's observe callback — one throwing
  // reconcile must not kill the others or Yjs's transaction cleanup.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[doorLayout] listener threw during doc notify:', err);
    }
  }
}

export function bindDoorLayoutDoc(doc: Y.Doc): void {
  boundDoc = doc;
  doorLayoutMap = doc.getMap('doorLayout');
  doorLayoutMap.observe(() => notify());
  notify(); // reconcile from the fresh doc (mirror of bindFurnitureDoc)
}

export function subscribeDoorLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    doorLayoutMap !== null
  );
}

const WALLS: readonly DoorWall[] = ['north', 'south', 'east', 'west'];

/** Shape guard (doc reads cross a trust boundary — see module header). */
export function isDoorLayoutRecord(value: unknown): value is DoorLayoutRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<DoorLayoutRecord>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.wall === 'string' &&
    WALLS.includes(r.wall as DoorWall) &&
    Number.isFinite(r.lateral) &&
    (r.size === undefined || r.size === 'small' || r.size === 'large') &&
    (r.enabled === undefined || typeof r.enabled === 'boolean')
  );
}

/**
 * Snapshot the whole door set as id → validated record (malformed entries are
 * skipped — a bad peer write degrades to "that door is absent").
 *
 * 🚪 #91 READ-NORMALIZATION: every record is coerced to the one door size and
 * an on-grid centre here, at the read boundary. Rooms authored before #91 hold
 * `size:'small'` records at mid-cell laterals (n+0.5); rewriting them would
 * need owner write access in every room, so instead the whole app simply never
 * SEES the old shape — a visitor in someone else's stale room renders the same
 * on-grid doors the owner does. The shape guard still ACCEPTS 'small' (never
 * reject stored data); it just stops propagating past this line.
 */
export function readAllDoorLayout(): Map<string, DoorLayoutRecord> {
  const out = new Map<string, DoorLayoutRecord>();
  if (!docAlive()) return out;
  for (const [id, value] of doorLayoutMap!.entries()) {
    if (isDoorLayoutRecord(value) && value.id === id) {
      out.set(id, { ...value, size: 'large', lateral: Math.round(value.lateral) });
    }
  }
  return out;
}

/** Number of entries (0 ⇒ unseeded — reconcile keeps the local cardinal defaults). */
export function doorLayoutDocSize(): number {
  return docAlive() ? doorLayoutMap!.size : 0;
}

/** Cheap membership test — no snapshot, no allocation. Some callers ask this
 *  per door per FRAME (the first-person auto-door pass reaches it through
 *  canPass → readDoorPolicy), so they must not build a whole Map to find out. */
export function hasDoorLayout(id: string): boolean {
  return docAlive() && doorLayoutMap!.has(id);
}

/** Publish one door's membership (add / move — slice 5+). Owner-only in practice. */
export function writeDoorLayout(rec: DoorLayoutRecord): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.set(rec.id, rec);
  });
}

/** Remove one door from the shared set (slice 6 editor). */
export function deleteDoorLayout(id: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.delete(id);
  });
}

/**
 * Owner-only seed: on the first claim of a room, publish the current cardinal
 * door set so joiners converge to it. Idempotent — a no-op once the map has any
 * entry, so re-entering an already-seeded room never clobbers live edits.
 *
 * 🚪 #91 QUAD-ADD FIX: seed only the cardinals that ACTUALLY EXIST right now
 * (`findDoor` non-null). This function is the SEED-FIRST partner of every
 * editor write, so it used to fire in rooms showing fewer than four doors and
 * publish all four anyway — the reconcile then materialized up to four extra
 * doors alongside the one the owner was placing ("adding a door adds 4 doors").
 * Publishing exactly the visible set makes the seed a visual no-op, which is
 * what seed-first always meant. `enabled` snapshots live door state (north sits
 * behind the hearth) — no force-true fallback, so a door can never come back
 * walkable that was not.
 */
/**
 * 🛰️🚪 A freshly provisioned MODULE is born with exactly ONE door — the one
 * leading back to the room it was added from — centred on its wall (owner
 * ruling). Shares seedDoorLayoutDefaults' idempotency contract: a no-op once
 * the map has any entry, so it can never fight a live edit.
 *
 * `wall` must be one of the room's OCTAGON-cross-section walls (west/east on a
 * square room — see hullSection.narrowAxisFor); the caller picks it. The record
 * uses lateral 0 so the door sits dead-centre, which requires the room to run
 * the "legacy" door layout — the paired layouts park a cardinal ±PAIR_OFFSET
 * off-centre. main.ts stamps that on the module at claim time.
 */
export function seedDoorLayoutSingle(wall: DoorWall): void {
  if (!docAlive() || doorLayoutMap!.size > 0) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.set(wall, {
      id: wall,
      wall,
      lateral: 0,
      size: 'large',
      enabled: true,
    });
  });
}

export function seedDoorLayoutDefaults(): void {
  if (!docAlive() || doorLayoutMap!.size > 0) return;
  const deltas = readDoorDeltas();
  boundDoc!.transact(() => {
    for (const wall of WALLS) {
      const door = findDoor(wall);
      if (!door) continue;
      doorLayoutMap!.set(wall, {
        id: wall,
        wall,
        lateral: deltas[wall] ?? 0,
        size: 'large',
        enabled: door.enabled,
      });
    }
  });
}
