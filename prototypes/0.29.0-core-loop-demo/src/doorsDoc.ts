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
  clampExtBays, clampFlexBendFine, clampFlexStretch, clampExtStretch, type ConnectorSegment,
} from './adapter';
import type { DoorWall } from './doorLayoutDoc';
import { normalizeWall } from './doorLayoutDoc';

/**
 * Serializable pairing record — one per door id. Plain JSON (no nested Y
 * types), a DISCRIMINATED UNION on `paired`.
 *
 * REDONE 2026-08 (owner ruling: no backwards compatibility): the old shape
 * was one struct doing two jobs — a live pairing, and a tombstone smuggled in
 * as `paired: false` with the retired address squatting in
 * `connectedRoomAddress`. Both jobs get their own arm now, and the v0.30.x
 * "legacy fields always written, never renamed" invariant (§3.5) is deleted.
 *
 * The important addition is `farWall`. A pairing used to describe the far
 * side by DOOR ID alone, and an id says nothing about where a door is — the
 * old design got away with it because cardinal names doubled as positions.
 * They no longer do (a record can put "east" on the west wall), and free
 * `d:` doors never did. Everything that needs the far door's orientation —
 * the gray-box projection, the exterior neighbour shells, atlas hop
 * composition — reads the WALL from the record instead of guessing it from
 * the id, and an absent wall means "unknown", not "north".
 */
export interface DoorPairing {
  paired: true;
  /** Seed link of the room this door is docked to. */
  connectedRoomAddress: string;
  /** Ordered connector chain (flex joints + extensions). Absent ⇒ straight
   *  vestibule. Unknown segment kinds fail sanitize ⇒ straight. */
  segments?: ConnectorSegment[];
  /** The FAR room's door this connection lands on — any door, cardinal or
   *  free `d:`. */
  farDoor?: string;
  /** The WALL that far door sits on — what actually orients the far module.
   *  Written by the first walk-through's mirror (the traveler just departed
   *  through that door and knows), or from the atlas when the far room's
   *  geometry is already gossiped. Absent ⇒ orientation unknown. */
  farWall?: DoorWall;
  /** …and WHERE along that wall (the far door's along-wall centre). An
   *  off-centre far door shifts the whole far module sideways relative to the
   *  tube; without this every peer would draw it centred until they visited.
   *  Absent ⇒ assume centred. */
  farLateral?: number;
  /** Far room ring-orientation: 0 = square, 45 = diamond (octagon ring). */
  farYawDeg?: 0 | 45;
  /** #67 D2: TRANSIENT guest berth (docking-adapter pairing) — no chains, no
   *  station-graph permanence, either side may detach. */
  transient?: boolean;
  /** ⚓ #163: when this DOCK was made (writer clock, epoch ms) — docks only.
   *  Compared against a dock tombstone's `undockedAt`: a dock newer than the
   *  undock is a deliberate re-dock the mirror may apply; an older one is a
   *  stale berth it must refuse. */
  dockedAt?: number;
}

/** ⚓ #163: what an undocked PORT remembers of its last berth, so DOCK can
 *  make the same connection again (and the far side can be told it ended). */
export interface DockBerthMemory {
  /** The far door the dock landed on, when known. */
  farDoor?: string;
  farWall?: DoorWall;
  farLateral?: number;
  /** When the dock was released (writer clock, epoch ms). */
  undockedAt: number;
}

/** ⏏ An UNDOCK leaves this rather than deleting the entry: only one room doc
 *  is bound at a time, so an undock can never reach the far room's mirror
 *  record — and the lazy mirror-write would read a plain delete as "never
 *  docked" and helpfully re-create the pairing on the next walk-through. The
 *  retired address lets it refuse exactly that module and no other. */
export interface DoorTombstone {
  paired: false;
  retiredAddress: string;
  /** ⚓ #163: present when the retired connection was a DOCK — the berth
   *  memory DOCK re-docks to. Absent on a plain undock, and dropped when the
   *  door's port is removed (the berth is closed, nothing may re-dock). */
  dock?: DockBerthMemory;
}

export type DoorRecord = DoorPairing | DoorTombstone;

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
  const r = value as { paired?: unknown; connectedRoomAddress?: unknown; retiredAddress?: unknown };
  if (r.paired === true) return typeof r.connectedRoomAddress === 'string';
  if (r.paired === false) return typeof r.retiredAddress === 'string';
  return false;
}

/** #62 P2 geometry sanitizer: peer-written geometry is UNTRUSTED — every
 *  segment param is clamped to the parts catalog, an unknown segment kind or
 *  malformed list drops the WHOLE chain (⇒ legacy straight-gangway render,
 *  never a crash, identical on every client), and farDoor/farYawDeg must be
 *  exact enum values or they vanish. */
function sanitizeDoorGeometry(r: DoorRecord): DoorRecord {
  // Tombstones carry no chain — only the ⚓ dock berth memory, bounded the
  // same way as a pairing's far geometry (it is fed back into one by DOCK).
  if (!r.paired) {
    const out: DoorTombstone = { paired: false, retiredAddress: r.retiredAddress };
    const memory = sanitizeBerthMemory(r.dock);
    if (memory) out.dock = memory;
    return out;
  }
  const out: DoorPairing = { paired: true, connectedRoomAddress: r.connectedRoomAddress };
  if (Array.isArray(r.segments) && r.segments.length > 0 && r.segments.length <= 8) {
    const clean: ConnectorSegment[] = [];
    let ok = true;
    for (const s of r.segments) {
      if (!s || typeof s !== 'object') { ok = false; break; }
      if (s.kind === 'dock') {
        // ⚓ #163: a docking-adapter half has no parameters to clamp.
        clean.push({ kind: 'dock' });
      } else if (s.kind === 'flex') {
        clean.push({
          kind: 'flex',
          // 🛬 FINE clamp (range only, no detent snap): solved jetbridge
          // bends (e.g. 40.1°) survive the wire and render as solved.
          bendDeg: clampFlexBendFine(typeof s.bendDeg === 'number' && Number.isFinite(s.bendDeg) ? s.bendDeg : 0),
          stretch: clampFlexStretch(typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0),
        });
      } else if (s.kind === 'ext') {
        clean.push({
          kind: 'ext',
          bays: clampExtBays(typeof s.bays === 'number' && Number.isFinite(s.bays) ? s.bays : 2),
          skin: s.skin === 'solid' ? 'solid' : 'ribbed',
          // 🛬 Telescoping delta (additive; legacy readers ignore → rigid).
          stretch: clampExtStretch(typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0),
        });
      } else {
        ok = false; // unknown kind (newer client) — fall back to legacy render
        break;
      }
    }
    if (ok) out.segments = clean;
  }
  // 🚪 Bounded, not enumerated: same shape rule as a pairing KEY, so a peer
  // cannot smuggle an arbitrary string into the pose and arrival paths.
  // Every consumer degrades safely on a miss anyway — findDoor returns null
  // and the adapter falls back to the departure heading.
  if (typeof r.farDoor === 'string' && isAcceptableDoorKey(r.farDoor)) {
    out.farDoor = r.farDoor;
  }
  // farWall drives the far module's ROTATION straight into the renderer and
  // arrives from a peer — a real wall in either vocabulary (normalizeWall maps
  // legacy compass values) or it vanishes ("unknown"), which every consumer
  // renders as no rotation rather than a guess. This list was compass-only
  // after the axis rename, so every farWall written since was being STRIPPED.
  const fw = normalizeWall(r.farWall);
  if (fw) out.farWall = fw;
  // Same discipline as farWall: geometry from a peer, bounded or dropped.
  // ±32 comfortably covers the largest room's wall run (5 tiles = ±15).
  if (typeof r.farLateral === 'number' && Number.isFinite(r.farLateral)
      && Math.abs(r.farLateral) <= 32) {
    out.farLateral = r.farLateral;
  }
  if (r.farYawDeg === 0 || r.farYawDeg === 45) out.farYawDeg = r.farYawDeg;
  if (r.transient === true) out.transient = true;
  if (isSaneStamp(r.dockedAt)) out.dockedAt = r.dockedAt;
  return out;
}

/** A writer-clock stamp we will compare: finite and positive. (No future
 *  bound: a peer inflating its own stamp only makes its OWN dock look newer
 *  than an undock of that same door — the posture of every honest-client
 *  record here, #67 D3.) */
function isSaneStamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** ⚓ Shape-check a tombstone's berth memory: the stamp is required (it is what
 *  the re-dock rule compares), the geometry is optional and bounded exactly
 *  like a pairing's far fields. Anything else ⇒ no memory (a plain tombstone). */
function sanitizeBerthMemory(v: unknown): DockBerthMemory | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const m = v as Partial<DockBerthMemory>;
  if (!isSaneStamp(m.undockedAt)) return undefined;
  const out: DockBerthMemory = { undockedAt: m.undockedAt };
  if (typeof m.farDoor === 'string' && isAcceptableDoorKey(m.farDoor)) out.farDoor = m.farDoor;
  const fw = normalizeWall(m.farWall);
  if (fw) out.farWall = fw;
  if (typeof m.farLateral === 'number' && Number.isFinite(m.farLateral)
      && Math.abs(m.farLateral) <= 32) {
    out.farLateral = m.farLateral;
  }
  return out;
}

/** A door id we will accept as a pairing key: one of the four structural
 *  berths, or an editor-minted free door. Deliberately an id-SHAPE test and
 *  NOT `hasDoorLayout(id)` — bindDoorsDoc runs notify() synchronously and
 *  main.ts binds it BEFORE bindDoorLayoutDoc, so a cross-doc lookup here is
 *  false on every join and would silently drop every free-door pairing, with
 *  no recovery (reconcileDoorLayout never re-runs reconcileDoors). */
function isAcceptableDoorKey(id: string): boolean {
  if (id.length > MAX_KEY_LEN) return false;
  return (
    (DOOR_IDS as readonly string[]).includes(id) ||
    // 🧭 Axis-label ids: seedDoorLayoutSingle names a module's birth door
    // after its wall, which the axis rename turned into 'x-'/'y+'… — and this
    // filter, still speaking only legacy names and d:, silently DROPPED every
    // pairing keyed by one. The write-only black hole came back for exactly
    // the newest doors: walk into a fresh module and the mirror written for
    // the way home was unreadable — "There is no module connected" (owner
    // report, 2026-08-10). Ids are opaque names; all three shapes are legal.
    (AXIS_IDS as readonly string[]).includes(id) ||
    id.startsWith('d:')
  );
}

const AXIS_IDS = ['x+', 'x-', 'y+', 'y-'] as const;

/** Bounds replacing the DoS fence the fixed four-id loop gave us for free:
 *  before, whatever a peer wrote we read exactly four entries. Mirrors the
 *  station atlas's MAX_ENTRIES discipline. */
const MAX_KEY_LEN = 64;
const MAX_PAIRINGS = 64;

/**
 * Snapshot every valid door pairing as id → SANITIZED record (malformed
 * entries are skipped, not fatal).
 *
 * 🚪 This loop WAS the four-door keyspace. Nothing on the wire ever constrained
 * it — `doors` is a plain string-keyed Y.Map and writeDoorPairing /
 * deleteDoorPairing / writeDoorTombstone all take `doorId: string` unvalidated
 * — so a free door's pairing was already being written and gossiped, and read
 * by nobody, including its own author after a rejoin. A silent write-only black
 * hole rather than a throw, which is why nothing ever surfaced it. Iterating
 * the map is what makes a free door dockable; every cardinal-ism downstream
 * (reconcileDoors, the arrival mirror, the atlas harvest) reads through here.
 */
export function readAllDoors(): Map<string, DoorRecord> {
  if (!docAlive()) return new Map<string, DoorRecord>();
  return readDoorsMap(doorsMap!);
}

function readDoorsMap(map: Y.Map<unknown>): Map<string, DoorRecord> {
  const out = new Map<string, DoorRecord>();
  for (const [id, value] of map.entries()) {
    if (out.size >= MAX_PAIRINGS) break;
    if (!isAcceptableDoorKey(id)) continue;
    if (isDoorRecord(value)) out.set(id, sanitizeDoorGeometry(value));
  }
  return out;
}

/**
 * ⚓ #163: the same sanitized snapshot, read from ANY doc — the far-room dock
 * write (farDoorWrite.ts) holds a second, short-lived doc that is not the
 * bound one. Same guard and sanitizer, so both ends of a dock are judged by
 * one set of rules.
 */
export function readAllDoorsFrom(doc: Y.Doc): Map<string, DoorRecord> {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return new Map<string, DoorRecord>();
  return readDoorsMap(doc.getMap('doors'));
}

/** ⚓ #163: write one door record into ANY doc (see readAllDoorsFrom) — the
 *  record must come from buildDoorPairing / buildDoorTombstone, so the far
 *  side is written in exactly the shape the near side is. */
export function writeDoorRecordTo(doc: Y.Doc, doorId: string, record: DoorRecord): void {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return;
  doc.transact(() => {
    doc.getMap('doors').set(doorId, record);
  });
}

/**
 * ⚓ #163: run several door writes as ONE transaction on the bound room doc.
 * Every door store (doors, doorPolicy, doorLayout) is bound to that same doc,
 * so their own transact() calls nest into this one and peers — including a
 * far room's background DOCK session reading this room — see the writes land
 * together or not at all. Runs `fn` bare when no doc is bound (the writes
 * inside no-op on their own).
 */
export function transactDoorWrites(fn: () => void): void {
  if (docAlive()) boundDoc!.transact(fn);
  else fn();
}

/** Optional connection geometry a publisher attaches to a pairing (#62 P2). */
export interface DoorGeometry {
  segments?: ConnectorSegment[];
  farDoor?: DoorPairing['farDoor'];
  farWall?: DoorPairing['farWall'];
  farLateral?: DoorPairing['farLateral'];
  farYawDeg?: DoorPairing['farYawDeg'];
  transient?: boolean;
  dockedAt?: DoorPairing['dockedAt'];
}

/** The one pairing-record shape every writer produces (near side, mirror,
 *  and the far-room dock write). */
export function buildDoorPairing(address: string, geometry?: DoorGeometry): DoorPairing {
  const record: DoorPairing = { paired: true, connectedRoomAddress: address };
  if (geometry?.segments && geometry.segments.length > 0) record.segments = geometry.segments;
  if (geometry?.farDoor) record.farDoor = geometry.farDoor;
  if (geometry?.farWall) record.farWall = geometry.farWall;
  if (geometry?.farLateral !== undefined) record.farLateral = geometry.farLateral;
  if (geometry?.farYawDeg !== undefined) record.farYawDeg = geometry.farYawDeg;
  if (geometry?.transient === true) record.transient = true;
  if (geometry?.dockedAt !== undefined) record.dockedAt = geometry.dockedAt;
  return record;
}

/** Publish one door's pairing (whoever docked a module); geometry rides along
 *  when the connection was assembled from parts or the far side is known. */
export function writeDoorPairing(doorId: string, address: string, geometry?: DoorGeometry): void {
  if (!docAlive()) return;
  const record = buildDoorPairing(address, geometry);
  boundDoc!.transact(() => {
    doorsMap!.set(doorId, record);
  });
}

/**
 * 🧹 Reap pairing records whose DOOR no longer exists.
 *
 * removeSelectedDoor only calls deleteDoorLayout, so before free doors could
 * pair this was harmless — a deleted door had no pairing. Now it matters: an
 * orphan record keeps publishing a phantom neighbour to every peer's exterior
 * view and offering transit into it, forever.
 *
 * A reaper rather than an inline delete in the editor, because a door deletion
 * also arrives from a PEER, which removeSelectedDoor never sees.
 *
 * `liveDoorIds` must be the room's REAL door set. The caller is responsible for
 * not calling this for an UNSEEDED room, where "no records" means "this room
 * predates the store" rather than "every door was deleted" — reaping there
 * would wipe every pairing in the room the first time anyone joined.
 */
export function reapOrphanPairings(liveDoorIds: ReadonlySet<string>): string[] {
  if (!docAlive()) return [];
  const dead: string[] = [];
  for (const id of doorsMap!.keys()) {
    // No cardinal exemption. It was here to stop an UNSEEDED room — which
    // reads as "no records at all" — from looking like every door had been
    // deleted; but the caller already refuses to reap in that state, so all
    // the exemption actually did was make a deleted CARDINAL door keep its
    // pairing forever, publishing a phantom neighbour to every peer's
    // exterior and offering transit into it. Exactly the defect the reaper
    // exists to prevent, exempted for the doors most likely to have one.
    if (!liveDoorIds.has(id)) dead.push(id);
  }
  if (dead.length === 0) return [];
  boundDoc!.transact(() => {
    for (const id of dead) doorsMap!.delete(id);
  });
  return dead;
}

/** Remove a door's pairing from the shared layout (reject / unpair). */
export function deleteDoorPairing(doorId: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorsMap!.delete(doorId);
  });
}

/**
 * ⏏ #91: UNDOCK leaves a TOMBSTONE — an explicit "this door is not paired"
 * record — rather than deleting the entry.
 *
 * Only one room doc is bound at a time, so an undock can never reach the far
 * room's mirror record. That stale mirror still offers transit back; on arrival
 * the lazy mirror-write saw NO record here (a plain delete is indistinguishable
 * from "never docked") and helpfully re-created the pairing. One walk-through
 * silently undid the undock for everyone. A present-but-unpaired record renders
 * exactly like an absent one — reconcileDoors routes it to clearRemotePairing —
 * but it is proof the connection was deliberately taken down.
 *
 * It keeps the RETIRED ADDRESS so it can refuse precisely that module and no
 * other: an address-less tombstone would suppress the mirror on this door
 * forever, stranding any future connection built from the far side.
 *
 * ⚓ #163: an undocked DOCK also keeps its berth memory (`dock`) — see
 * DockBerthMemory.
 */
export function writeDoorTombstone(
  doorId: string,
  retiredAddress = '',
  dock?: DockBerthMemory,
): void {
  if (!docAlive()) return;
  const record = buildDoorTombstone(retiredAddress, dock);
  boundDoc!.transact(() => {
    doorsMap!.set(doorId, record);
  });
}

/** The one tombstone shape every writer produces (see buildDoorPairing). */
export function buildDoorTombstone(retiredAddress: string, dock?: DockBerthMemory): DoorTombstone {
  const record: DoorTombstone = { paired: false, retiredAddress };
  if (dock) {
    const memory: DockBerthMemory = { undockedAt: dock.undockedAt };
    if (dock.farDoor) memory.farDoor = dock.farDoor;
    if (dock.farWall) memory.farWall = dock.farWall;
    if (dock.farLateral !== undefined) memory.farLateral = dock.farLateral;
    record.dock = memory;
  }
  return record;
}
