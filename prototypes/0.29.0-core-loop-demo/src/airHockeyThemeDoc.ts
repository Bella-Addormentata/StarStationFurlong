/**
 * 🏒 Air-hockey theme sync (#184) — a sibling of wallpaperLayoutDoc for TABLE
 * SKINS. WHICH colour theme each air-hockey table wears — item id → theme id —
 * lives in a room-doc `airHockeyTheme` Y.Map, so a joiner sees the host's
 * tables in the right colours on entry and the owner's recolour propagates to
 * everyone. The same discipline as windowLayoutDoc / doorLayoutDoc /
 * wallpaperLayoutDoc / furnitureDoc.
 *
 * Keyed by ITEM ID (not kind): two tables in one room are recoloured
 * independently, and a table wears at most ONE theme, so the item id IS the
 * key — recolouring overwrites, resetting deletes. `arctic` is the absence of
 * a record (the default look, which is itself the #184 fix), never stored;
 * that is what makes every pre-existing room pick up the lighter table with no
 * migration.
 *
 * A record is NOT cleaned up when its table is deleted. That is deliberate and
 * matches furnitureDoc's own behaviour for a re-added item: the map is tiny
 * (one short string per recoloured table), and a stale key is inert — nothing
 * reads a theme except a table that exists, and a table re-added with the same
 * id is very likely the same table the owner just moved.
 *
 * Rebinds per join at the main.ts T0 seam. Reads cross the peer trust boundary
 * → shape-guarded by isAirHockeyThemeRecord.
 */

import * as Y from 'yjs';
import {
  DEFAULT_AIR_HOCKEY_THEME,
  isAirHockeyThemeId,
  type AirHockeyThemeId,
} from './airHockeyTheme';

export type { AirHockeyThemeId };

/** Serializable theme record — one per recoloured table. Plain JSON. */
export interface AirHockeyThemeRecord {
  /** The furniture item this skin belongs to (also the Y.Map key). */
  itemId: string;
  /** Which theme — never the default (that's the absence of a record). */
  theme: AirHockeyThemeId;
}

let boundDoc: Y.Doc | null = null;
let themeMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[airHockeyTheme] listener threw during doc notify:', err);
    }
  }
}

export function bindAirHockeyThemeDoc(doc: Y.Doc): void {
  boundDoc = doc;
  themeMap = doc.getMap('airHockeyTheme');
  themeMap.observe(() => notify());
  notify();
}

export function subscribeAirHockeyTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    themeMap !== null
  );
}

/** Shape guard (doc reads cross a trust boundary). A record with a missing id
 *  or an unknown theme (a newer peer, or a default that shouldn't be stored)
 *  is silently dropped — the table then renders in the default skin, which is
 *  the legible one. */
export function isAirHockeyThemeRecord(value: unknown): value is AirHockeyThemeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<AirHockeyThemeRecord>;
  return (
    typeof r.itemId === 'string' &&
    r.itemId.length > 0 &&
    isAirHockeyThemeId(r.theme) &&
    r.theme !== DEFAULT_AIR_HOCKEY_THEME
  );
}

/**
 * Snapshot the skins as item id → theme (malformed / mis-keyed skipped).
 *
 * Completes the standard doc surface (every sibling exposes a readAllX) and is
 * pinned by the tests, but World does NOT use it: it repaints per table, and a
 * per-item `.get()` beats allocating a whole Map on every doc notify.
 */
export function readAllAirHockeyThemes(): Map<string, AirHockeyThemeId> {
  const out = new Map<string, AirHockeyThemeId>();
  if (!docAlive()) return out;
  for (const [key, value] of themeMap!.entries()) {
    if (isAirHockeyThemeRecord(value) && value.itemId === key) {
      out.set(value.itemId, value.theme);
    }
  }
  return out;
}

/**
 * The theme ONE table wears. The default for an unrecorded table, which is
 * every table until someone recolours it — so builders can call this
 * unconditionally.
 */
export function readAirHockeyTheme(itemId: string): AirHockeyThemeId {
  if (!docAlive()) return DEFAULT_AIR_HOCKEY_THEME;
  const value = themeMap!.get(itemId);
  return isAirHockeyThemeRecord(value) && value.itemId === itemId
    ? value.theme
    : DEFAULT_AIR_HOCKEY_THEME;
}

/** Number of recoloured tables (skins start EMPTY — no default seed). */
export function airHockeyThemeDocSize(): number {
  return docAlive() ? themeMap!.size : 0;
}

/**
 * Recolour one table. The default theme RESETS it (deletes the record) — a
 * table wears at most one skin, so the item id is the key. Owner-only in
 * practice (editor-gated by canEditRoom).
 */
export function writeAirHockeyTheme(itemId: string, theme: AirHockeyThemeId): void {
  if (!docAlive() || itemId.length === 0) return;
  boundDoc!.transact(() => {
    if (theme === DEFAULT_AIR_HOCKEY_THEME) {
      themeMap!.delete(itemId); // the default = no record
    } else {
      themeMap!.set(itemId, { itemId, theme });
    }
  });
}
