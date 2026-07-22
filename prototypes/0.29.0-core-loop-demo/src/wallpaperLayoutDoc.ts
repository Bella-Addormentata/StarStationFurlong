/**
 * 🖼️ Wallpaper LAYOUT sync (#80 S6) — a sibling of windowLayoutDoc for WALL
 * COVERINGS. WHICH covering each octagon hull surface wears — surface → preset —
 * lives in a room-doc `wallpaperLayout` Y.Map, so a joiner sees the host's
 * coverings on entry and the owner's paint / clear propagates to everyone. The
 * covering is a tiled material the hull paints onto that strip's face
 * (world.collectWallpaper → buildOctagonHull); the same discipline as
 * windowLayoutDoc / doorLayoutDoc / furnitureDoc.
 *
 * Keyed by SURFACE (not a uuid): a surface wears at most ONE covering, so the
 * surface id IS the key — painting overwrites, clearing deletes. `plain` is the
 * absence of a record (no covering → the bare hull colour), never stored.
 *
 * Rebinds per join at the main.ts T0 seam. Reads cross the peer trust boundary →
 * shape-guarded by isWallpaperLayoutRecord.
 */

import * as Y from 'yjs';
import { SURFACES } from './hullSection';
import type { HullSurface } from './hullSection';
import { isWallpaperPreset, type WallpaperPresetId } from './wallpaper';

export type { HullSurface };
export type { WallpaperPresetId };

/** Serializable wallpaper record — one per painted surface. Plain JSON. */
export interface WallpaperLayoutRecord {
  /** The hull surface this covering is painted onto (also the Y.Map key). */
  surface: HullSurface;
  /** Which covering preset — never `plain` (that's the absence of a record). */
  preset: WallpaperPresetId;
}

let boundDoc: Y.Doc | null = null;
let wallpaperMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[wallpaperLayout] listener threw during doc notify:', err);
    }
  }
}

export function bindWallpaperLayoutDoc(doc: Y.Doc): void {
  boundDoc = doc;
  wallpaperMap = doc.getMap('wallpaperLayout');
  wallpaperMap.observe(() => notify());
  notify();
}

export function subscribeWallpaperLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    wallpaperMap !== null
  );
}

/** Shape guard (doc reads cross a trust boundary). A record with an unknown
 *  surface or preset (a newer peer, or a `plain` that shouldn't be stored) is
 *  silently dropped — coverings are preview-only + start empty. */
export function isWallpaperLayoutRecord(value: unknown): value is WallpaperLayoutRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<WallpaperLayoutRecord>;
  return (
    typeof r.surface === 'string' &&
    SURFACES.includes(r.surface as HullSurface) &&
    isWallpaperPreset(r.preset) &&
    r.preset !== 'plain'
  );
}

/** Snapshot the coverings as surface → preset (malformed / mis-keyed skipped). */
export function readAllWallpaper(): Map<HullSurface, WallpaperPresetId> {
  const out = new Map<HullSurface, WallpaperPresetId>();
  if (!docAlive()) return out;
  for (const [key, value] of wallpaperMap!.entries()) {
    if (isWallpaperLayoutRecord(value) && value.surface === key) {
      out.set(value.surface, value.preset);
    }
  }
  return out;
}

/** Number of painted surfaces (coverings start EMPTY — no default seed). */
export function wallpaperLayoutDocSize(): number {
  return docAlive() ? wallpaperMap!.size : 0;
}

/**
 * Paint (or clear) one surface's covering. `plain` CLEARS it (deletes the
 * record) — a surface wears at most one covering, so the surface id is the key.
 * Owner-only in practice (editor-gated).
 */
export function writeWallpaper(surface: HullSurface, preset: WallpaperPresetId): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    if (preset === 'plain') {
      wallpaperMap!.delete(surface); // 'plain' = clear the covering (no record)
    } else {
      wallpaperMap!.set(surface, { surface, preset });
    }
  });
}
