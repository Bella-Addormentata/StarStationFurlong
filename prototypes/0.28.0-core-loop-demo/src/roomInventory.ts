/**
 * Room furniture inventory — issue #53 (remove furniture → inventory → re-place).
 *
 * A lightweight per-room list of furniture KINDS removed from the room in
 * edit mode, waiting to be re-placed. Deliberately NOT the storage trunk's
 * TrunkState: the trunk is 8 tool + 4 outfit slots keyed to the ITEM_DEFS
 * catalogue (hand-held items with icons and flavor text) — furniture is a
 * different shape entirely (an unbounded list of FurnitureKind entries, no
 * slot layout, no catalogue ids), so squeezing it into the trunk's 12 slots
 * would be dishonest. It gets its own parallel store instead, mirroring the
 * trunk's storage conventions (per-room localStorage key, defensive parsing,
 * best-effort writes).
 *
 * localStorage `ssf-room-inventory:<roomId>` — one key per room, like
 * items.ts's `ssf-trunk:<roomId>:<itemId>`. LOCAL ONLY until E4 furniture
 * sync, with one honest quirk to note: the ROOM LAYOUT resets on reload
 * (FURNITURE is code-defined until E4 persistence) while this inventory
 * persists, so removing a BUILT-IN piece and reloading yields both the piece
 * (back at its default spot) and the inventory entry. E4's persisted layout
 * is what retires that duplication; documenting beats pretending.
 *
 * Every mutation fires a `ssf-room-inventory-changed` window CustomEvent so
 * live UIs (the DEV menu's INVENTORY section) can refresh without polling —
 * and without this module knowing any consumer exists.
 */

import { FURNITURE_DEFS } from './furniture';
import type { FurnitureKind } from './furniture';
import { getDefaultRoomId } from './identity';

export interface RoomInventoryEntry {
  kind: FurnitureKind;
  /** Epoch ms when the piece was stowed (display/ordering only). */
  storedAt: number;
}

/** Fired on every add/take so open UIs can refresh (detail: { roomId }). */
export const ROOM_INVENTORY_EVENT = 'ssf-room-inventory-changed';

/** One key per room — plan mirror of items.ts trunkStorageKey. */
export function roomInventoryKey(roomId: string): string {
  return `ssf-room-inventory:${roomId}`;
}

/**
 * Stable room id for per-room local state — the same window-global reader as
 * World.activeRoomId / devMenu.activeRoomId (main.ts publishes the bootstrap
 * roomId on join; getDefaultRoomId() is the per-install default fallback).
 */
export function activeRoomId(): string {
  const id = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
  return typeof id === 'string' && id.length > 0 ? id : getDefaultRoomId();
}

/**
 * Load a room's furniture inventory. Unknown kinds are dropped (a catalogue
 * rename can never wedge the UI — same rule as loadTrunkState) and malformed
 * payloads collapse to empty. try/catch throughout: localStorage throws in
 * some privacy modes and stowage must never take the app down.
 */
export function loadRoomInventory(roomId: string): RoomInventoryEntry[] {
  try {
    const raw = localStorage.getItem(roomInventoryKey(roomId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: RoomInventoryEntry[] = [];
    for (const e of parsed) {
      const kind = (e as Partial<RoomInventoryEntry>)?.kind;
      if (typeof kind !== 'string' || !(kind in FURNITURE_DEFS)) continue;
      const storedAt = (e as Partial<RoomInventoryEntry>).storedAt;
      entries.push({
        kind: kind as FurnitureKind,
        storedAt: typeof storedAt === 'number' ? storedAt : 0,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function saveRoomInventory(roomId: string, entries: RoomInventoryEntry[]): void {
  try {
    localStorage.setItem(roomInventoryKey(roomId), JSON.stringify(entries));
  } catch {
    /* local stowage is best-effort */
  }
  window.dispatchEvent(new CustomEvent(ROOM_INVENTORY_EVENT, { detail: { roomId } }));
}

/** Append a removed piece's kind to the room inventory (edit mode's ✕ REMOVE). */
export function addToRoomInventory(roomId: string, kind: FurnitureKind): void {
  const entries = loadRoomInventory(roomId);
  entries.push({ kind, storedAt: Date.now() });
  saveRoomInventory(roomId, entries);
}

/**
 * Pop the entry at `index` — but only if it still holds `kind`, guarding a
 * stale UI row against a list that changed underneath it (another tab, or a
 * remove landing while the panel was open). Returns the entry, or null when
 * the row was stale.
 */
export function takeFromRoomInventory(
  roomId: string,
  index: number,
  kind: FurnitureKind,
): RoomInventoryEntry | null {
  const entries = loadRoomInventory(roomId);
  // Number.isInteger also rejects NaN, which slips past both < comparisons.
  if (!Number.isInteger(index) || index < 0 || index >= entries.length || entries[index].kind !== kind) {
    return null;
  }
  const [entry] = entries.splice(index, 1);
  saveRoomInventory(roomId, entries);
  return entry;
}
