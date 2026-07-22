/**
 * 🪟 Window placement geometry (#80 S4) — the PURE-ish surface math for the
 * window editor, generalised from the two vertical side walls to ANY of the 8
 * octagon hull surfaces (walls, roof eaves, ridge, basement chamfers, basement
 * floor). A window lives on a `surface` at (along, across): `along` is the
 * position on the extrude/long axis (world coord, same for every strip);
 * `across` is the distance along that strip's cross-section edge from its p0
 * (walls → height above the floor; eaves → up-slope distance; …). The per-
 * surface edge orientation lives in hullSection.surfaceEdge (THREE-free +
 * golden-tested); this module layers the world-frame + click helpers on top.
 *
 * The current room's octagon profile comes from floorPlanDoc.roomHalfExtents()
 * via computeOctagonProfile, so every helper tracks a live room resize.
 */

import * as THREE from 'three';
import { computeOctagonProfile, sectionToWorld, surfaceEdge } from './hullSection';
import type { HullSurface } from './hullSection';
import { roomHalfExtents } from './floorPlanDoc';
import { readAllWindowLayout } from './windowLayoutDoc';
import type { HullWindows, WindowOpening } from './octagonHull';

/** Keep an opening this far off the strip ends (matches octagonHull's clamp). */
const WALL_INSET = 0.05;
/** Click-box / ghost thickness across the surface (a fat, reliable target). */
export const WINDOW_BOX_THICKNESS = 0.5;

/** The current room's octagon profile (narrowAxis, edges, half-extents, …). */
function profile() {
  const { halfX, halfZ } = roomHalfExtents();
  return computeOctagonProfile({ halfX, halfZ });
}

/** World-space centre of a window at (along, across) on `surface`. */
export function surfaceCenterWorld(
  surface: HullSurface,
  along: number,
  across: number,
): { x: number; y: number; z: number } {
  const p = profile();
  const { p0, dir } = surfaceEdge(p, surface);
  return sectionToWorld(p.narrowAxis, p0.a + dir.a * across, p0.y + dir.y * across, along);
}

/**
 * Orthonormal WORLD frame of a surface for orienting the ghost / click-box:
 *  - uDir = the extrude (long/along) axis unit,
 *  - vDir = the cross-section edge direction (the `across` axis) in world,
 *  - normal = uDir × vDir (the surface's thickness axis; right-handed).
 * uDir ⊥ vDir always (uDir is the extrude axis, vDir lies in the cross-section
 * plane), so the basis is a proper rotation.
 */
export function surfaceBasis(surface: HullSurface): {
  uDir: THREE.Vector3;
  vDir: THREE.Vector3;
  normal: THREE.Vector3;
} {
  const p = profile();
  const { dir } = surfaceEdge(p, surface);
  const uDir = p.narrowAxis === 'x'
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(1, 0, 0);
  // The edge direction (a, y) mapped to world (a direction → extrude comp 0).
  const vw = sectionToWorld(p.narrowAxis, dir.a, dir.y, 0);
  const vDir = new THREE.Vector3(vw.x, vw.y, vw.z).normalize();
  const normal = new THREE.Vector3().crossVectors(uDir, vDir).normalize();
  return { uDir, vDir, normal };
}

/** Snap an along/across coordinate to the 1 m lattice (windows sit on metre
 *  lines, the same feel as the pool's 1 m floor-hole cells). */
export function snapWindowAlong(value: number): number {
  return Math.round(value);
}

/** Clamp `along` so a `w`-wide opening stays within the strip run, off the ends
 *  (mirrors octagonHull.stripGeometry's own clamp so the ghost matches the hole). */
export function clampWindowAlong(along: number, w: number): number {
  const limit = profile().longHalf - w / 2 - WALL_INSET;
  if (limit <= 0) return 0;
  return Math.max(-limit, Math.min(limit, along));
}

/** Clamp `across` so an `h`-tall opening stays within the surface's edge span
 *  [0, edgeLen]. A strip too thin for the window just centres it. */
export function clampWindowAcross(surface: HullSurface, across: number, h: number): number {
  const { edgeLen } = surfaceEdge(profile(), surface);
  const lo = h / 2 + WALL_INSET;
  const hi = edgeLen - h / 2 - WALL_INSET;
  if (hi <= lo) return edgeLen / 2;
  return Math.max(lo, Math.min(hi, across));
}

/** The surface's edge span (m) — how far `across` can range [0, edgeLen]. */
export function surfaceEdgeLen(surface: HullSurface): number {
  return surfaceEdge(profile(), surface).edgeLen;
}

/**
 * Convenience: map a clicked FLOOR point (world x, z) to the nearer of the two
 * vertical SIDE walls — the sane default surface when arming the editor. The
 * two walls sit at ±narrowHalf on the narrow axis, so the perpendicular
 * coordinate's sign picks the wall and the parallel one is `along`.
 */
export function frontWallFromPoint(px: number, pz: number): { surface: HullSurface; along: number } {
  const p = profile();
  return p.narrowAxis === 'x'
    ? { surface: px < 0 ? 'wall-neg' : 'wall-pos', along: pz }
    : { surface: pz < 0 ? 'wall-neg' : 'wall-pos', along: px };
}

/**
 * 🪟 The current room's window openings, bucketed by hull surface — the ONE
 * source for both the interior hull (octagonHull) and the exterior shell
 * (exteriorView), plus the `?octagon=1&window=1` demo pane. Reads the synced
 * layout doc; malformed records are already dropped by readAllWindowLayout.
 */
export function collectWindowOpenings(): HullWindows {
  const out: HullWindows = {};
  const push = (surface: HullSurface, o: WindowOpening) => {
    (out[surface] ??= []).push(o);
  };
  for (const rec of readAllWindowLayout().values()) {
    push(rec.surface, { along: rec.along, across: rec.across, w: rec.w, h: rec.h, r: rec.r });
  }
  // Standalone demo window (?octagon=1&window=1) for a quick preview.
  if (new URLSearchParams(window.location.search).get('window') === '1') {
    push('wall-neg', { along: 0, across: 2, w: 3, h: 1.8, r: 0.5 });
  }
  return out;
}
