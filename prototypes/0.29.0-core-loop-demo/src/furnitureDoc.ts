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
import { DEFAULT_LOBBY_FURNITURE, FURNITURE_DEFS } from './furniture';
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
  // 🖥️ Owner request: the room terminal is selectable + movable in edit mode
  // (wall-snapped — snapInteriorWall). Every room seeded before this shipped
  // holds `movable: false` for it, and without the override those rooms could
  // never move theirs. Movable ≠ removable: editMode.removeSelected still
  // refuses, because this panel is the only way back into EDIT ROOM.
  'wall-computer': true,
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

/** Remove several items in ONE transaction (a losing + ADD batch, see
 *  roomTemplates.reconcileConcurrentAdds) — one reconcile, not one per item. */
export function deleteFurnitureItems(ids: readonly string[]): void {
  if (!docAlive() || ids.length === 0) return;
  boundDoc!.transact(() => {
    for (const id of ids) furnitureMap!.delete(id);
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
    // The frozen manifest — NOT the live FURNITURE array, which mirrors the
    // room you came from (see DEFAULT_LOBBY_FURNITURE).
    for (const item of DEFAULT_LOBBY_FURNITURE) {
      furnitureMap!.set(item.id, toRecord(item));
    }
  });
}

/**
 * 🏗️ Room templates (dev tool): atomically REPLACE the whole room layout with
 * `items` — clear every existing record then place the template — in ONE
 * transaction, so the furniture reconcile rebuilds the room exactly once (no
 * per-item thrash) and every peer converges to the same layout. Owner-only in
 * practice, like the other writers.
 */
/**
 * ➕ ADD items to the room, keeping everything already in it.
 *
 * The additive sibling of replaceAllFurniture, and the one a template set
 * should normally use: a room's structure is fixed once it is built, so what
 * people actually do is put things IN the room they have, not swap the room
 * for a different one. Ids are made unique against what is already there, so
 * adding the same set twice gives two of everything rather than silently
 * overwriting the first. Returns the ids written.
 */
/** 🏷️ A tag no OTHER peer mints: the bound doc's Yjs client id (random per
 *  doc instance), for ids written by several peers into one map. addFurniture
 *  de-duplicates only against the local map — two peers adding the same set
 *  at once otherwise pick identical ids and the map's per-key LWW keeps one
 *  of each pair (Copilot review, PR #169). '' with no doc bound. */
export function peerIdTag(): string {
  return boundDoc ? boundDoc.clientID.toString(36) : '';
}

export function addFurniture(items: FurnitureItem[]): string[] {
  if (!docAlive()) return [];
  const taken = new Set(furnitureMap!.keys());
  const written: string[] = [];
  boundDoc!.transact(() => {
    for (const item of items) {
      let id = item.id;
      for (let n = 2; taken.has(id); n++) id = `${item.id}-${n}`;
      taken.add(id);
      written.push(id);
      furnitureMap!.set(id, toRecord({ ...item, id }));
    }
  });
  return written;
}

export function replaceAllFurniture(items: FurnitureItem[]): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    for (const id of [...furnitureMap!.keys()]) furnitureMap!.delete(id);
    for (const item of items) furnitureMap!.set(item.id, toRecord(item));
  });
}

// The pristine default layout lives in furniture.ts as DEFAULT_LOBBY_FURNITURE
// (one frozen snapshot for every reader — the migration below, the new-room
// seed above, and the Grand Lobby template — rather than a private copy here
// and a live alias elsewhere).

/**
 * 🛋️ One-time floor-plan migration (owner request: nothing parked in front
 * of the paired doors): UPSERT every default item — snap the ones present in
 * the doc back to the current default arrangement AND add the ones missing
 * entirely (rooms seeded before newer defaults existed never received them:
 * the owner's lobby predated the clone vat, so the fox's spawn tube was
 * absent). Caller gates it with a roomInfo marker so it runs ONCE per room;
 * user-spawned items (unique ids) are untouched, and retired defaults are
 * purged separately right after (main.ts).
 */
export function migrateDefaultLayout(): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    for (const item of DEFAULT_LOBBY_FURNITURE) {
      furnitureMap!.set(item.id, toRecord(item));
    }
  });
}

/** Default poses from BEFORE #165 grew the clone vat to 2×2 — the only poses
 *  relocateLegacyDefaultVat moves anything from. */
const LEGACY_VAT_POSE = { x: -4.7, z: -4.9, rot: 0 };
const LEGACY_CORNER_TREE_POSE = { x: -5.3, z: -5.3, rot: 0 };

/**
 * 🧬 One-time #165 migration: the clone vat is a 2×2 tank centred on the NW
 * corner square now. A room whose DEFAULT vat still sits at the old 1×1
 * default pose gets it moved to the new default, and the corner cherry tree
 * the bigger tank would swallow moves to its new default too — but only
 * while the tree is still at ITS old default and the vat now fills that
 * corner. Anything the owner moved, and DEV-spawned vats (unique ids), keep
 * their spot. Caller marker-gates it (main.ts), like migrateDefaultLayout.
 */
export function relocateLegacyDefaultVat(): void {
  if (!docAlive()) return;
  const vat = DEFAULT_LOBBY_FURNITURE.find((item) => item.id === 'clone-vat');
  const tree = DEFAULT_LOBBY_FURNITURE.find((item) => item.id === 'cherry-tree-back-left');
  if (!vat || !tree) return;
  const isAt = (id: string, pose: { x: number; z: number; rot: number }) => {
    const rec = furnitureMap!.get(id);
    return (
      isFurnitureRecord(rec) &&
      rec.x === pose.x &&
      rec.z === pose.z &&
      rec.rot === pose.rot
    );
  };
  boundDoc!.transact(() => {
    if (isAt(vat.id, LEGACY_VAT_POSE)) {
      furnitureMap!.set(vat.id, toRecord(vat));
    }
    if (
      isAt(vat.id, { x: vat.pos.x, z: vat.pos.z, rot: vat.rot }) &&
      isAt(tree.id, LEGACY_CORNER_TREE_POSE)
    ) {
      furnitureMap!.set(tree.id, toRecord(tree));
    }
  });
}
