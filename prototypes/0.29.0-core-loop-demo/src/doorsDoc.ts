/**
 * 🚪 Door-pairing sync (issue #64)
 *
 * A room's DOCKED-MODULE door pairings live in a room-doc `doors` Y.Map, keyed by
 * door id ('north'|'south'|'east'|'west') → { connectedRoomAddress, paired }, so a
 * module another user docks to a door becomes visible + enterable for EVERYONE in
 * the room. Before this, docking state was purely local (DoorDockingPortSystem's
 * private doorState): the user who docked saw the adjacent-room projection and
 * could transit, but every other user's door read unpaired — no projection, and
 * transit failed with "No room docked at this port."
 *
 * Rebinds per join exactly like players / games / roomInfo / furniture (main.ts T0
 * seam): bindDoorsDoc attaches to the FRESH doc and re-notifies subscribers, and
 * the previous doc's observers die with its doc.destroy() on leaveRoom.
 *
 * Trust: any value READ is untrusted (a peer could write junk) and shape-checked
 * by isDoorRecord before it drives the world, same discipline as furnitureDoc.
 */

import * as Y from 'yjs';
import {
  clampExtBays, clampFlexBend, clampFlexStretch, type ConnectorSegment,
} from './adapter';

/**
 * Serializable pairing — one per door id. Plain JSON (no nested Y types).
 *
 * #62 P2: the three geometry fields are ADDITIVE and OPTIONAL — v0.30.x
 * readers typeof-check only the two legacy fields and ignore extras, so old
 * clients render the legacy straight gangway and keep working transit. The
 * legacy fields are always written, never renamed (compat invariant §3.5).
 */
export interface DoorRecord {
  connectedRoomAddress: string;
  paired: boolean;
  /** Ordered connector chain (flex joints + extensions). Absent ⇒ legacy
   *  straight vestibule. Unknown segment kinds fail sanitize ⇒ legacy. */
  segments?: ConnectorSegment[];
  /** The FAR room's door this connection lands on (arrival-door override). */
  farDoor?: 'north' | 'south' | 'east' | 'west';
  /** Far room ring-orientation: 0 = square, 45 = diamond (octagon ring). */
  farYawDeg?: 0 | 45;
  /** #67 D2: TRANSIENT guest berth (docking-adapter pairing) — no chains, no
   *  station-graph permanence, either side may detach. Additive; legacy
   *  readers ignore it. */
  transient?: boolean;
}

const DOOR_IDS = ['north', 'south', 'east', 'west'] as const;

let boundDoc: Y.Doc | null = null;
let doorsMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy: a listener may unsubscribe mid-notify. Isolate: this runs inside the
  // Yjs observe callback — one throwing reconcile must not kill the others.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[doors] listener threw during doc notify:', err);
    }
  }
}

export function bindDoorsDoc(doc: Y.Doc): void {
  boundDoc = doc;
  doorsMap = doc.getMap('doors');
  doorsMap.observe(() => notify());
  notify(); // reconcile from the fresh doc (mirror of bindFurnitureDoc)
}

export function subscribeDoors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    doorsMap !== null
  );
}

/** Shape guard (doc reads cross a trust boundary — see module header). */
export function isDoorRecord(value: unknown): value is DoorRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<DoorRecord>;
  return typeof r.connectedRoomAddress === 'string' && typeof r.paired === 'boolean';
}

/** #62 P2 geometry sanitizer: peer-written geometry is UNTRUSTED — every
 *  segment param is clamped to the parts catalog, an unknown segment kind or
 *  malformed list drops the WHOLE chain (⇒ legacy straight-gangway render,
 *  never a crash, identical on every client), and farDoor/farYawDeg must be
 *  exact enum values or they vanish. */
function sanitizeDoorGeometry(r: DoorRecord): DoorRecord {
  const out: DoorRecord = { connectedRoomAddress: r.connectedRoomAddress, paired: r.paired };
  if (Array.isArray(r.segments) && r.segments.length > 0 && r.segments.length <= 8) {
    const clean: ConnectorSegment[] = [];
    let ok = true;
    for (const s of r.segments) {
      if (!s || typeof s !== 'object') { ok = false; break; }
      if (s.kind === 'flex') {
        clean.push({
          kind: 'flex',
          bendDeg: clampFlexBend(typeof s.bendDeg === 'number' && Number.isFinite(s.bendDeg) ? s.bendDeg : 0),
          stretch: clampFlexStretch(typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0),
        });
      } else if (s.kind === 'ext') {
        clean.push({
          kind: 'ext',
          bays: clampExtBays(typeof s.bays === 'number' && Number.isFinite(s.bays) ? s.bays : 2),
          skin: s.skin === 'solid' ? 'solid' : 'ribbed',
        });
      } else {
        ok = false; // unknown kind (newer client) — fall back to legacy render
        break;
      }
    }
    if (ok) out.segments = clean;
  }
  if (r.farDoor === 'north' || r.farDoor === 'south' || r.farDoor === 'east' || r.farDoor === 'west') {
    out.farDoor = r.farDoor;
  }
  if (r.farYawDeg === 0 || r.farYawDeg === 45) out.farYawDeg = r.farYawDeg;
  if (r.transient === true) out.transient = true;
  return out;
}

/** Snapshot every valid door pairing as id → SANITIZED record (only the four
 *  real door ids; malformed entries are skipped, not fatal). */
export function readAllDoors(): Map<string, DoorRecord> {
  const out = new Map<string, DoorRecord>();
  if (!docAlive()) return out;
  for (const id of DOOR_IDS) {
    const value = doorsMap!.get(id);
    if (isDoorRecord(value)) out.set(id, sanitizeDoorGeometry(value));
  }
  return out;
}

/** Optional connection geometry a publisher attaches to a pairing (#62 P2). */
export interface DoorGeometry {
  segments?: ConnectorSegment[];
  farDoor?: DoorRecord['farDoor'];
  farYawDeg?: DoorRecord['farYawDeg'];
  transient?: boolean;
}

/** Publish one door's pairing (whoever docked a module). The two legacy
 *  fields are ALWAYS written (v0.30.x compat); geometry rides along when the
 *  connection was assembled from parts. */
export function writeDoorPairing(doorId: string, address: string, geometry?: DoorGeometry): void {
  if (!docAlive()) return;
  const record: DoorRecord = { connectedRoomAddress: address, paired: true };
  if (geometry?.segments && geometry.segments.length > 0) record.segments = geometry.segments;
  if (geometry?.farDoor) record.farDoor = geometry.farDoor;
  if (geometry?.farYawDeg !== undefined) record.farYawDeg = geometry.farYawDeg;
  if (geometry?.transient === true) record.transient = true;
  boundDoc!.transact(() => {
    doorsMap!.set(doorId, record);
  });
}

/** Remove a door's pairing from the shared layout (reject / unpair). */
export function deleteDoorPairing(doorId: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorsMap!.delete(doorId);
  });
}
