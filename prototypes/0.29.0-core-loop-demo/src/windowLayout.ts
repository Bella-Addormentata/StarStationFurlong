/**
 * 🪟 Window placement geometry (#80 S4) — the PURE side-wall math for the window
 * editor, the octagon-side counterpart of doorLayout.ts (whose walls are the
 * four cardinals). A window sits on an octagon SIDE wall ('neg'/'pos' = the
 * narrow-axis ∓/± faces of hullSection.ts); its `along` is the position on the
 * wall's LONG (extrude) axis and `y` is its centre height. THREE-free so the
 * mapping can be reasoned about / property-tested in isolation, exactly like
 * hullSection.ts and doorLayout.ts.
 *
 * The current room's octagon profile (which floor axis is narrow, and the
 * narrow/long half-extents) comes from floorPlanDoc.roomHalfExtents() via
 * computeOctagonProfile — so every helper here tracks a live room resize.
 */

import { computeOctagonProfile, sectionToWorld } from './hullSection';
import { roomHalfExtents } from './floorPlanDoc';
import type { WindowWall } from './windowLayoutDoc';

/** Keep an opening this far off the gable corners (matches octagonHull's clamp). */
const WALL_INSET = 0.05;
/** Click-box / ghost thickness across the wall (fat enough to be an easy target). */
export const WINDOW_BOX_THICKNESS = 0.5;

/** The current room's octagon profile (narrowAxis, narrowHalf, longHalf, …). */
function profile() {
  const { halfX, halfZ } = roomHalfExtents();
  return computeOctagonProfile({ halfX, halfZ });
}

/**
 * Map a clicked FLOOR point (world x, z) to the nearest side wall + along-wall
 * coordinate. The two side walls sit at ±narrowHalf on the NARROW axis and run
 * along the LONG axis, so the perpendicular (narrow-axis) coordinate's SIGN
 * picks the wall and the parallel (long-axis) coordinate IS the along value.
 *   narrowAxis='x' ⇒ wall by sign of x, along = z.
 *   narrowAxis='z' ⇒ wall by sign of z, along = x.
 */
export function wallAndAlongFromPoint(px: number, pz: number): { wall: WindowWall; along: number } {
  const p = profile();
  return p.narrowAxis === 'x'
    ? { wall: px < 0 ? 'neg' : 'pos', along: pz }
    : { wall: pz < 0 ? 'neg' : 'pos', along: px };
}

/** Snap an along-wall coordinate to the 1 m lattice (windows sit on metre lines,
 *  the same feel as the pool's 1 m floor-hole cells). */
export function snapWindowAlong(along: number): number {
  return Math.round(along);
}

/** Clamp `along` so a `w`-wide opening stays within the wall run, off the caps
 *  (mirrors octagonHull.wallGeometry's own clamp so the ghost matches the hole). */
export function clampWindowAlong(along: number, w: number): number {
  const limit = profile().longHalf - w / 2 - WALL_INSET;
  if (limit <= 0) return 0;
  return Math.max(-limit, Math.min(limit, along));
}

/** World-space centre of a window on its side wall (place the click-box / ghost). */
export function windowCenterWorld(wall: WindowWall, along: number, y: number): { x: number; y: number; z: number } {
  const p = profile();
  const a = wall === 'neg' ? -p.narrowHalf : p.narrowHalf;
  return sectionToWorld(p.narrowAxis, a, y, along);
}

/**
 * Box dimensions (world) for a `w`×`h` opening — `w` runs ALONG the wall, `h` is
 * height, and the box is thin across the wall. The wall faces the narrow axis,
 * so narrowAxis='x' ⇒ thin in x with `w` along z; narrowAxis='z' ⇒ thin in z
 * with `w` along x. Axis-aligned — no rotation needed on the mesh.
 */
export function windowBoxDims(w: number, h: number): { sx: number; sy: number; sz: number } {
  const p = profile();
  return p.narrowAxis === 'x'
    ? { sx: WINDOW_BOX_THICKNESS, sy: h, sz: w }
    : { sx: w, sy: h, sz: WINDOW_BOX_THICKNESS };
}
