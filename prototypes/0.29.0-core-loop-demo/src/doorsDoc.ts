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

/** Serializable pairing — one per door id. Plain JSON (no nested Y types). */
export interface DoorRecord {
  connectedRoomAddress: string;
  paired: boolean;
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

/** Snapshot every valid door pairing as id → record (only the four real door
 *  ids; malformed entries are skipped, not fatal). */
export function readAllDoors(): Map<string, DoorRecord> {
  const out = new Map<string, DoorRecord>();
  if (!docAlive()) return out;
  for (const id of DOOR_IDS) {
    const value = doorsMap!.get(id);
    if (isDoorRecord(value)) out.set(id, value);
  }
  return out;
}

/** Publish one door's pairing (whoever docked a module). */
export function writeDoorPairing(doorId: string, address: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorsMap!.set(doorId, { connectedRoomAddress: address, paired: true });
  });
}

/** Remove a door's pairing from the shared layout (reject / unpair). */
export function deleteDoorPairing(doorId: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorsMap!.delete(doorId);
  });
}
