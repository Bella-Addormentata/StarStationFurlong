/**
 * 🗺️ Wall computer — station-overview projection helpers (#33 M-station)
 *
 * The wall computer's focused DOM UI (devices.ts createRoomTerminalUI) paints
 * a small STATION OVERVIEW below the room wireframe: this module holds the
 * PURE math that composes what to draw. Every function here is a plain data
 * transform with no DOM / no localStorage / no globals — that is what lets
 * the whole file be exercised from vitest without a browser (see
 * wallComputerMap.test.ts).
 *
 * The station overview is a phone-sized inset, so the helpers are careful
 * about two things:
 *   1. FIT — a station whose atlas layout is off-centre still lands centred
 *      with equal aspect ratio (fitPointsToCanvas keeps the x/z scale equal
 *      so a rectangle is never squashed into a square).
 *   2. HONEST FOOTPRINTS — each module is drawn as an ORIENTED rectangle at
 *      its true dims when the atlas learned them (dims present) and at the
 *      uniform MODULE_HALF fallback otherwise. The pane is not free to guess
 *      a size it does not know — that is why atlas gossip carries dims.
 *
 * Small-station cap: the wall computer covers the sparse case (≤ 12 modules,
 * two rings of the octagon plus a few extras); the map table's STATION page
 * covers everything larger. See brainstorming/device-maps-plan.md §2.
 */

import type { AtlasPose } from './stationAtlas';
import {
  DEFAULT_DIMS, ROOM_TILE_MAX, ROOM_TILE_MIN, TILE_SIZE,
  type RoomDims,
} from './floorPlanDoc';

// ── 🎯 Small-station threshold ────────────────────────────────────────────────

/** The wall computer draws the overview when the known-module count is at or
 *  below this cap; above it, the pane tells the player to walk to a map table
 *  (Stage C of the device-maps plan). 12 fits the owner's octagon (8 rooms)
 *  plus a few overflow docks — beyond that, the small canvas reads as noise. */
export const SMALL_STATION_MAX = 12;

/** True while a station is small enough that its overview reads on the wall
 *  computer's inset canvas. `moduleCount` includes the CURRENT room. */
export function isSmallStation(moduleCount: number): boolean {
  return Number.isFinite(moduleCount)
    && moduleCount >= 1
    && moduleCount <= SMALL_STATION_MAX;
}

// ── 📐 Module footprint helpers ───────────────────────────────────────────────

/** The fallback half-extent when a neighbour's dims are not known — matches
 *  MODULE_HALF in stationAtlas.ts / adapter.ts's ROOM_HALF and the exterior
 *  view's uniform 11.8 box. Keeping the number here is deliberate: the pure
 *  helpers must not import from the atlas file's internals just to reuse it. */
export const MODULE_HALF_FALLBACK = 5.9;

/** The room contract in floorPlanDoc allows only integer tile counts in
 *  [ROOM_TILE_MIN, ROOM_TILE_MAX] (1..5). Anything else — non-integer, out of
 *  range, non-numeric, or hostile localStorage — collapses or blows out the
 *  footprint, so this pane treats it as "we don't know this module's size" and
 *  falls back to the uniform MODULE_HALF_FALLBACK box. readAtlas() is
 *  UNVALIDATED (localStorage can hold anything an older / hostile client
 *  wrote), and this is the last line of defence before the value drives the
 *  canvas fit. */
export function areDimsRoomValid(dims: RoomDims | null | undefined): boolean {
  if (!dims) return false;
  const inRange = (n: unknown): boolean =>
    typeof n === 'number' && Number.isInteger(n)
    && n >= ROOM_TILE_MIN && n <= ROOM_TILE_MAX;
  return inRange(dims.cols) && inRange(dims.rows);
}

/** A module's half-extents (metres) from its tile dims: halfX = cols · 3,
 *  halfZ = rows · 3 (TILE_SIZE / 2). Missing / hostile / out-of-envelope dims
 *  fall back to MODULE_HALF_FALLBACK on BOTH axes — the same envelope
 *  readRoomDims enforces for the local plan. `usedFallback` is returned so
 *  callers (stationPlacements) can mark placements dimsUnknown when the
 *  gossiped value failed the envelope: the outline reads as a guess (dashed)
 *  rather than lying that a squashed shape is the true room. */
export function moduleHalfExtents(
  dims: RoomDims | null | undefined,
): { halfX: number; halfZ: number; usedFallback: boolean } {
  if (!areDimsRoomValid(dims)) {
    return { halfX: MODULE_HALF_FALLBACK, halfZ: MODULE_HALF_FALLBACK, usedFallback: true };
  }
  return {
    halfX: dims!.cols * TILE_SIZE / 2,
    halfZ: dims!.rows * TILE_SIZE / 2,
    usedFallback: false,
  };
}

/** A single module's placement on the wall-computer's station canvas: its
 *  world-space centre (from the atlas pose, or {0,0} for the current room),
 *  its orientation and its half-extents. Everything downstream — the outline
 *  polygon, the label position, the fit — reads from this one shape. */
export interface StationModulePlacement {
  roomId: string;
  name: string;
  x: number;
  z: number;
  rotY: number;
  halfX: number;
  halfZ: number;
  /** True for the current room (drawn in the "you are here" gold accent). */
  isCurrent: boolean;
  /** Graph distance from the current room; 0 for the current room itself. */
  hops: number;
  /** True when the atlas did NOT know this module's dims — the outline uses
   *  the fallback size and the UI may hint at that (e.g. dashed vs solid). */
  dimsUnknown: boolean;
}

/**
 * Compose the current room + every atlas-known neighbour into one flat list
 * of oriented placements, ordered so the CURRENT room is first (the UI paints
 * neighbours underneath it and the current-room accent last).
 *
 * The atlas layout arrives without the current room (`atlasLayout()` deletes
 * it before returning); we place the current room at the origin here so the
 * downstream fit + draw sees a single homogeneous list.
 */
export function stationPlacements(
  currentRoomId: string,
  currentName: string,
  currentDims: RoomDims | null | undefined,
  poses: AtlasPose[],
): StationModulePlacement[] {
  const out: StationModulePlacement[] = [];
  // 🧭 Current room at the origin, oriented as the room's local frame (rotY=0).
  //    Its dims come from the local floorPlan (never the atlas), so an unknown
  //    dims here really only happens with a broken doc and the fallback kicks
  //    in the same way — no special-casing.
  const currentSize = moduleHalfExtents(currentDims);
  out.push({
    roomId: currentRoomId,
    name: currentName || 'This module',
    x: 0,
    z: 0,
    rotY: 0,
    halfX: currentSize.halfX,
    halfZ: currentSize.halfZ,
    isCurrent: true,
    hops: 0,
    // 🛑📐 dimsUnknown tracks whether the shape drawn is a GUESS (fallback
    //     box). The single source of truth is moduleHalfExtents's usedFallback
    //     — an out-of-envelope value (e.g. {cols: 0, rows: 2} or non-integer)
    //     took the fallback path and must read as guessed, even though the
    //     `currentDims` object was truthy.
    dimsUnknown: currentSize.usedFallback,
  });
  for (const pose of poses) {
    if (!pose || !pose.roomId || pose.roomId === currentRoomId) continue;
    const size = moduleHalfExtents(pose.dims);
    out.push({
      roomId: pose.roomId,
      name: pose.name || 'Module',
      x: Number.isFinite(pose.x) ? pose.x : 0,
      z: Number.isFinite(pose.z) ? pose.z : 0,
      rotY: Number.isFinite(pose.rotY) ? pose.rotY : 0,
      halfX: size.halfX,
      halfZ: size.halfZ,
      isCurrent: false,
      hops: Number.isFinite(pose.hops) && pose.hops > 0 ? pose.hops : 1,
      // Same discipline as above: usedFallback covers both missing dims and
      // dims that failed the room envelope.
      dimsUnknown: size.usedFallback,
    });
  }
  return out;
}

// ── 🎯 Projection ────────────────────────────────────────────────────────────

/** Just the fields projectModuleFootprintCorners needs — lets callers pass
 *  either a full StationModulePlacement or a bare pose from anywhere. */
export interface PlacementPose {
  x: number;
  z: number;
  rotY: number;
  halfX: number;
  halfZ: number;
}

/**
 * The four world-space corners of one module's oriented footprint. The local
 * corner order is [-halfX,-halfZ], [+halfX,-halfZ], [+halfX,+halfZ],
 * [-halfX,+halfZ] before rotation.
 *
 * 🧭 The rotY convention MUST match the atlas / exterior transform:
 * atlasLayout composes hops as `wx = x·cos + z·sin`, `wz = -x·sin + z·cos`
 * (identical to Three.js `rotation.y` on `mod.rotation.y = pose.rotY` — see
 * exteriorView.ts). Any other sign choice MIRRORS every non-square module's
 * orientation on the overview relative to the 3D scene the pane is trying to
 * echo, so the overview would disagree with what the room camera shows.
 * (An earlier version used the opposite matrix, which agreed only with itself
 * — the square-only tests concealed the mirror; a directional rectangular
 * case now pins the sign.)
 */
export function projectModuleFootprintCorners(
  placement: PlacementPose,
): Array<{ x: number; z: number }> {
  const cos = Math.cos(placement.rotY);
  const sin = Math.sin(placement.rotY);
  const out: Array<{ x: number; z: number }> = [];
  const corners: Array<[number, number]> = [
    [-placement.halfX, -placement.halfZ],
    [ placement.halfX, -placement.halfZ],
    [ placement.halfX,  placement.halfZ],
    [-placement.halfX,  placement.halfZ],
  ];
  for (const [sx, sz] of corners) {
    // Same rotation matrix as atlasLayout / Three.js rotation.y so the
    // overview footprint agrees with the exterior view for the same pose.
    out.push({
      x: placement.x + sx * cos + sz * sin,
      z: placement.z - sx * sin + sz * cos,
    });
  }
  return out;
}

// ── 🎯 Viewport fit ──────────────────────────────────────────────────────────

/** The canvas transform fitPointsToCanvas returns: world → canvas is
 *  `cx = offsetX + wx · scale`, `cz = offsetZ + wz · scale`. Canvas z runs
 *  down (north-up == world −z on top). Same convention drawWireframe uses. */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetZ: number;
}

export interface FitBounds {
  /** Lower bound on scale (metres → pixels); prevents a single-point fit from
   *  producing an infinite scale. Default 0.5 (a lonely module reads modestly). */
  minScale?: number;
  /** Upper bound; default 40 (a squeezed pair of adjacent tiles never blows up). */
  maxScale?: number;
}

/**
 * Fit a set of world-space points into a square `canvasSize` canvas with
 * `padding` px kept clear on all sides, returning the shared x/z scale + the
 * centring offsets. Equal-aspect (the smaller of the two axis-scales wins) so
 * a rectangle never comes out squashed. An empty / degenerate set returns a
 * centred zero-scale viewport (safe for later callers — they just see the
 * origin at the canvas centre and nothing renders).
 *
 * The optional bounds clamp keeps the viewport sane for pathological inputs
 * (a station with one module ⇒ range 0 ⇒ pre-clamp scale ∞; a giant sparse
 * station ⇒ tiny scale that would collapse everything onto one pixel).
 */
export function fitPointsToCanvas(
  points: Array<{ x: number; z: number }>,
  canvasSize: number,
  padding: number,
  bounds?: FitBounds,
): Viewport {
  const minScale = bounds?.minScale ?? 0.5;
  const maxScale = bounds?.maxScale ?? 40;
  const usable = Math.max(1, canvasSize - padding * 2);
  const centre = canvasSize / 2;
  if (!points || points.length === 0) {
    return { scale: 0, offsetX: centre, offsetZ: centre };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)
      || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    return { scale: 0, offsetX: centre, offsetZ: centre };
  }
  const rangeX = Math.max(0, maxX - minX);
  const rangeZ = Math.max(0, maxZ - minZ);
  // 🎯 Equal-aspect scale: the axis with the wider range picks the scale.
  //    A single point (range 0 on both axes) hits the min-scale clamp below.
  let scale: number;
  if (rangeX <= 0 && rangeZ <= 0) {
    scale = maxScale;
  } else {
    const sx = rangeX > 0 ? usable / rangeX : Infinity;
    const sz = rangeZ > 0 ? usable / rangeZ : Infinity;
    scale = Math.min(sx, sz);
  }
  scale = Math.min(maxScale, Math.max(minScale, scale));
  // 📐 Centre the point cloud's midpoint on the canvas centre; the offsets
  //    solve `centre = offset + midpoint · scale`.
  const midX = (minX + maxX) / 2;
  const midZ = (minZ + maxZ) / 2;
  return {
    scale,
    offsetX: centre - midX * scale,
    offsetZ: centre - midZ * scale,
  };
}

/** Convenience: world point → canvas point through a viewport. */
export function projectPoint(
  point: { x: number; z: number },
  viewport: Viewport,
): { x: number; z: number } {
  return {
    x: viewport.offsetX + point.x * viewport.scale,
    z: viewport.offsetZ + point.z * viewport.scale,
  };
}

// ── 🎯 Convenience: default RoomDims (re-export the same value the room's
//     local plan falls back to, so tests can import from one place). ─────────
export const WALL_COMPUTER_DEFAULT_DIMS: RoomDims = { ...DEFAULT_DIMS };
