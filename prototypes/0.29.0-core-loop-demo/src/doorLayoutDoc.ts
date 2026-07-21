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
  /** Leaf-width class; default 'small'. */
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

/** Snapshot the whole door set as id → validated record (malformed entries are
 *  skipped — a bad peer write degrades to "that door is absent"). */
export function readAllDoorLayout(): Map<string, DoorLayoutRecord> {
  const out = new Map<string, DoorLayoutRecord>();
  if (!docAlive()) return out;
  for (const [id, value] of doorLayoutMap!.entries()) {
    if (isDoorLayoutRecord(value) && value.id === id) out.set(id, value);
  }
  return out;
}

/** Number of entries (0 ⇒ unseeded — reconcile keeps the local cardinal defaults). */
export function doorLayoutDocSize(): number {
  return docAlive() ? doorLayoutMap!.size : 0;
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
 * entry, so re-entering an already-seeded room never clobbers live edits. Size
 * defaults match buildPorts' config (east/west large, north/south small);
 * `enabled` snapshots the current door state (north sits behind the hearth).
 */
export function seedDoorLayoutDefaults(): void {
  if (!docAlive() || doorLayoutMap!.size > 0) return;
  const deltas = readDoorDeltas();
  boundDoc!.transact(() => {
    for (const wall of WALLS) {
      const door = findDoor(wall);
      doorLayoutMap!.set(wall, {
        id: wall,
        wall,
        lateral: deltas[wall] ?? 0,
        size: wall === 'east' || wall === 'west' ? 'large' : 'small',
        enabled: door ? door.enabled : true,
      });
    }
  });
}
