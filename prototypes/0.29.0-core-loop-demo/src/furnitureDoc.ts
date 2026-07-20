/**
 * 🪑 Furniture layout sync (issue #60 E4)
 *
 * The room's PLACED furniture layout lives in a room-doc `furniture` Y.Map,
 * keyed by furniture item id, so a joiner sees the host's arrangement on entry
 * and the owner's live edits (move / remove / DEV-spawn) propagate to everyone.
 * Before E4 the layout was a code-defined constant instantiated identically on
 * every client with edits kept local — a joiner always saw the default room.
 *
 * Ownership: edit mode is owner-gated, so only the room owner WRITES here. Any
 * value READ is still treated as untrusted (a peer could write junk) and
 * shape-checked by isFurnitureRecord before it drives the world.
 *
 * Rebinds per join exactly like players / games / roomInfo (main.ts T0 seam):
 * bindFurnitureDoc attaches to the FRESH doc and re-notifies subscribers, and
 * the previous doc's observers die with its doc.destroy() on leaveRoom.
 *
 * The removed-item personal inventory (roomInventory.ts) stays LOCAL — it is a
 * private stash, not shared room truth; only what is PLACED is synced here.
 */

import * as Y from 'yjs';
import { FURNITURE, FURNITURE_DEFS } from './furniture';
import type { FurnitureItem, FurnitureKind, Rot } from './furniture';

/** Serializable placement — one per furniture item id. Plain JSON (no nested
 *  Y types), the same discipline as the players/games maps. */
export interface FurnitureRecord {
  kind: FurnitureKind;
  x: number;
  z: number;
  rot: Rot;
  /** false for fixed room structure (the wall computer). */
  movable: boolean;
  /** 🛰️ Hull stacking (hull.ts): id of the exterior item this one is mounted
   *  on. Absent ⇒ wall/interior. Plain string — LWW rides it like the rest. */
  mountParent?: string;
}

let boundDoc: Y.Doc | null = null;
let furnitureMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy: a listener may unsubscribe mid-notify. Isolate: this runs inside the
  // Yjs observe callback — one throwing reconcile must not kill the others or
  // Yjs's transaction cleanup (same guard as gamesDoc).
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[furniture] listener threw during doc notify:', err);
    }
  }
}

export function bindFurnitureDoc(doc: Y.Doc): void {
  boundDoc = doc;
  furnitureMap = doc.getMap('furniture');
  furnitureMap.observe(() => notify());
  notify(); // reconcile from the fresh doc (mirror of rebuildChatLog / bindGamesDoc)
}

export function subscribeFurniture(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    furnitureMap !== null
  );
}

const ROT_VALUES: readonly number[] = [0, 1, 2, 3];

/** Shape guard (doc reads cross a trust boundary — see module header). */
export function isFurnitureRecord(value: unknown): value is FurnitureRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<FurnitureRecord>;
  return (
    typeof r.kind === 'string' &&
    Object.prototype.hasOwnProperty.call(FURNITURE_DEFS, r.kind) &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.z) &&
    ROT_VALUES.includes(r.rot as number) &&
    typeof r.movable === 'boolean' &&
    (r.mountParent === undefined || typeof r.mountParent === 'string')
  );
}

/** Kinds whose movability is KIND-DERIVED, overriding the stored record flag.
 *  Migration seam (owner request, floor-plan work): rooms seeded before the
 *  fireplace became movable carry `movable: false` in their doc forever —
 *  the override frees them without touching stored data. */
const MOVABLE_KIND_OVERRIDE: Partial<Record<FurnitureKind, boolean>> = {
  'fireplace-wall': true,
  // Owner request (2026-07-18): the bar (stools ride along — they are part
  // of the build) moves and stows like everything else now.
  'bar-corner': true,
  // Owner request (2026-07-20): the pool + hot tub are movable/removable
  // furniture now — corrects any room doc still holding the old movable:false.
  'lazy-pool': true,
  'hot-tub': true,
};

/** Snapshot the whole layout as id → validated record (malformed entries are
 *  skipped, not fatal — a bad peer write degrades to "that item is absent"). */
export function readAllFurniture(): Map<string, FurnitureRecord> {
  const out = new Map<string, FurnitureRecord>();
  if (!docAlive()) return out;
  for (const [id, value] of furnitureMap!.entries()) {
    if (isFurnitureRecord(value)) {
      const override = MOVABLE_KIND_OVERRIDE[value.kind];
      out.set(id, override === undefined ? value : { ...value, movable: override });
    }
  }
  return out;
}

/** Number of entries currently in the map (0 ⇒ unseeded — keep local defaults). */
export function furnitureDocSize(): number {
  return docAlive() ? furnitureMap!.size : 0;
}

function toRecord(item: FurnitureItem): FurnitureRecord {
  const rec: FurnitureRecord = {
    kind: item.kind, x: item.pos.x, z: item.pos.z, rot: item.rot, movable: item.movable,
  };
  if (item.mountParent !== undefined) rec.mountParent = item.mountParent;
  return rec;
}

/** Publish one item's placement (spawn / move). Owner-only in practice. */
export function writeFurnitureItem(item: FurnitureItem): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    furnitureMap!.set(item.id, toRecord(item));
  });
}

/** Remove one item from the shared layout (edit-mode ✕ REMOVE). */
export function deleteFurnitureItem(id: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    furnitureMap!.delete(id);
  });
}

/**
 * Owner-only seed: on the first claim of a room, publish the current (default)
 * layout so joiners converge to it. Idempotent — a no-op once the map has any
 * entry, so re-entering an already-seeded room never clobbers live edits.
 */
export function seedFurnitureDefaults(): void {
  if (!docAlive() || furnitureMap!.size > 0) return;
  boundDoc!.transact(() => {
    for (const item of FURNITURE) {
      furnitureMap!.set(item.id, toRecord(item));
    }
  });
}
