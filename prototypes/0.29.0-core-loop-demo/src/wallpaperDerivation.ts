/**
 * 🖼️🩹 Wallpaper read-repair (#80 S6 — walls-migration completeness pass)
 *
 * The commit that retired the freestanding brick-wall / window-wall furniture
 * kinds (df26789) removed them from FURNITURE_DEFS, so `isFurnitureRecord` now
 * silently drops any legacy record referencing those kinds. A room-doc from a
 * v0.32.x client where the owner had painted a whole side wall with segments
 * would therefore lose that design entirely on upgrade — the octagon hull
 * would render as bare colour on the walls the segments used to cover.
 *
 * This module closes that gap the way issue #80 asks: read-repair AT READ
 * TIME, no doc rewrite. It scans RAW furniture records for the retired wall
 * kinds and returns an implicit `HullWallpapers` map that the world merges
 * UNDER the explicit `wallpaperLayoutDoc` — so an owner who has since chosen a
 * different covering wins over the derivation, but an untouched legacy room
 * still shows its brick.
 *
 * ── Trust boundary ────────────────────────────────────────────────────────────
 * A raw doc value could be anything a peer sent (junk, hostile shapes, records
 * from newer clients). Every field we read is shape-guarded first; nothing
 * that fails the guard reaches the derivation. Failing safe means "no implicit
 * wallpaper for that surface", never a crash and never a fabricated covering.
 *
 * ── Purity ────────────────────────────────────────────────────────────────────
 * No THREE, no Yjs, no `document` — the caller pulls raw values and hands them
 * in as an iterable. That keeps this module cheaply unit-testable with plain
 * arrays and lets the same code run in the vitest environment without any
 * DOM/canvas fixtures.
 */

import type { HullSurface } from './hullSection';
import type { NarrowAxis } from './hullSection';
import type { WallpaperPresetId } from './wallpaper';

/**
 * The retired freestanding wall furniture kinds this module knows how to map
 * to hull wallpaper. Both used brown brick as the base look (0x8a4a3a):
 *  - `brick-wall`  — solid brick slab, 4 m wide, replaced a side wall.
 *  - `window-wall` — brick-framed glazing on the same 4 m footprint. Only the
 *    brick FRAME survives as a covering: the GLAZING IS NOT DERIVED — this
 *    module writes no window records, so an upgraded room shows solid brick
 *    where the glass used to be until the owner re-adds panes with the
 *    octagon's own window editor (windowLayoutDoc + hole cutter).
 *
 * `casino-gold-wall` is DELIBERATELY NOT in this set: it is a decorative
 * furniture item ATTACHED to the wall (mount:"exterior-wall") — the current
 * build still registers and places it, so it stays a real 3D mesh rather than
 * a flat re-skin. The issue text explicitly permits "items attached to the
 * wall" alongside surface coverings.
 */
export const LEGACY_WALL_KINDS: ReadonlySet<string> = new Set([
  'brick-wall',
  'window-wall',
]);

/**
 * The minimum shape we need to see on a raw record to place its wallpaper.
 * `kind` picks the preset, `x`/`z` pick the hull surface. `rot` is irrelevant
 * (a wall segment lay flat against the wall regardless of its build's rot).
 */
export interface LegacyWallRecord {
  kind: string;
  x: number;
  z: number;
}

/**
 * Type-narrow a raw doc value to a legacy wall record. Fields we don't read
 * are ignored (a peer that stamped extra keys is not a threat). A non-object,
 * an unknown kind, or non-finite coords all fail SAFE — the derivation
 * returns "no covering for that surface", never crashes.
 */
export function isLegacyWallRecord(value: unknown): value is LegacyWallRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<LegacyWallRecord>;
  return (
    typeof r.kind === 'string' &&
    LEGACY_WALL_KINDS.has(r.kind) &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.z)
  );
}

/**
 * The wallpaper preset the retired `kind` used to render as. Both retired
 * wall kinds shared the brown-brick base colour, so both map to `brick`; the
 * table is a table (not a return statement) so a future retirement — say a
 * `tile-wall` — extends it in one place without touching the derivation logic.
 */
const PRESET_FOR_LEGACY_KIND: Readonly<Record<string, WallpaperPresetId>> = {
  'brick-wall': 'brick',
  'window-wall': 'brick',
};

/**
 * How close to the room edge a segment had to sit to count as "covering" that
 * wall. MODELED ON the retired `world.updateSideWallCoverage` (pre-df26789),
 * which treated a segment at `|x| > 5` in a 6 m-half room as covering the
 * side wall — a 1 m margin, STRICT comparison, always measured on X. This
 * derivation deliberately WIDENS that band to 1.5 m INCLUSIVE
 * (`narrowHalf - EDGE_MARGIN`, compared with >=): a legacy segment nudged
 * slightly off flush still repairs, and the band stays proportional if the
 * room resizes. A segment deep in the middle of the room (e.g. an owner
 * staging pieces on the floor) is still correctly ignored.
 */
export const EDGE_MARGIN = 1.5;

/**
 * The hull surface a legacy segment covered, from its (x, z) position and the
 * room's cross-section axis. Returns null if the segment sat too far from any
 * side wall to count as covering it (interior placement — the old sideWall
 * coverage rule ignored it too).
 *
 * The octagon hull picks its narrow axis by `narrowAxisFor(halfX, halfZ)`;
 * `wall-neg` is the narrow-axis side at −narrowHalf, `wall-pos` at +narrowHalf.
 * Legacy rooms were 12 m × 12 m ⇒ narrowAxis='x' (the tie rule in
 * narrowAxisFor) ⇒ x-based coord picks the surface, mirroring the old rule.
 * A resized narrow-axis-z room reads its z-coord instead — future-proof for a
 * resize that flips the extrude axis (owner can widen columns past rows).
 */
export function surfaceForLegacyRecord(
  rec: LegacyWallRecord,
  narrowHalf: number,
  narrowAxis: NarrowAxis,
): HullSurface | null {
  const a = narrowAxis === 'x' ? rec.x : rec.z;
  const threshold = Math.max(narrowHalf - EDGE_MARGIN, 0);
  if (a <= -threshold) return 'wall-neg';
  if (a >= threshold) return 'wall-pos';
  return null;
}

/**
 * Derive implicit wallpaper coverings from raw furniture records.
 *
 * Scans `rawFurnitureRecords` for retired wall furniture, maps each to the
 * matching hull surface (side wall on the narrow axis), and returns a
 * `HullSurface → WallpaperPresetId` map. Multiple segments on the same wall
 * collapse to a single covering — the same wall wears one preset either way,
 * so the last-write-in-iteration wins is deterministic (all our retired kinds
 * currently map to the same `brick` preset, so the "last wins" question is
 * moot today; the code stays correct if that ever stops being true).
 *
 * Explicit `wallpaperLayoutDoc` records are handled by `mergeWithExplicit`
 * (below) — the derivation is deliberately additive and unaware of them.
 */
export function deriveLegacyWallpapers(
  rawFurnitureRecords: Iterable<unknown>,
  narrowHalf: number,
  narrowAxis: NarrowAxis,
): Partial<Record<HullSurface, WallpaperPresetId>> {
  const out: Partial<Record<HullSurface, WallpaperPresetId>> = {};
  for (const raw of rawFurnitureRecords) {
    if (!isLegacyWallRecord(raw)) continue;
    const surface = surfaceForLegacyRecord(raw, narrowHalf, narrowAxis);
    if (surface === null) continue;
    const preset = PRESET_FOR_LEGACY_KIND[raw.kind];
    if (preset === undefined) continue; // defensive: kind in set but table gap
    out[surface] = preset;
  }
  return out;
}

/**
 * Merge derived (implicit) and explicit wallpaper maps — explicit wins on
 * every surface the owner has painted. A `plain` explicit is impossible in
 * practice (writeWallpaper deletes on plain), but if one slips through from a
 * hostile peer we let it override the derivation — the owner's choice, even
 * "clear it", is authoritative over a legacy-record guess.
 */
export function mergeWithExplicit(
  derived: Partial<Record<HullSurface, WallpaperPresetId>>,
  explicit: Partial<Record<HullSurface, WallpaperPresetId>>,
): Partial<Record<HullSurface, WallpaperPresetId>> {
  return { ...derived, ...explicit };
}
