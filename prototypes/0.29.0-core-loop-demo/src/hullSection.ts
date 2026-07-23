/**
 * 🛑📐 Octagon hull cross-section — the ONE pure source of the room's 3D shell
 * profile (issue #80 S1).
 *
 * Issue #80 turns each room's cross-section from today's flat open-top box into
 * an OCTAGON-ish barrel: vertical walls of a FIXED height, a 3-section 45° roof
 * above them, and — mirrored below the floor — a basement void (the space the
 * swimming-pool water will eventually live in, so we never render imaginary
 * space under the floor). The octagon is taken on the room's NARROWER floor
 * dimension and EXTRUDED along the longer one (a 6×12 room ⇒ octagon on the 6
 * side, extruded over the 12), so this module is a 2-D cross-section + an
 * extrude length; `octagonHull.ts` turns it into Three.js meshes and `world.ts`
 * renders it behind the `?octagon=1` flag.
 *
 * This file is DELIBERATELY THREE-free and side-effect-free so the geometry can
 * be property-tested in isolation (scratchpad hull-section-golden.mjs) — the
 * same discipline as the door pose generator (doorLayout.ts poseFromWall).
 *
 * ── Cross-section (narrow axis `a` horizontal, `y` up) ───────────────────────
 *
 *            ridgeL •───────────• ridgeR         y = ridgeY  (= wallHeight + e)
 *                  /             \                     ┐
 *      left eave  /               \  right eave        │ roof: 3 EQUAL-LENGTH
 *                /                 \                    │ sections, eaves @ 45°
 *      wallTopL •                   • wallTopR    y = wallHeight
 *               │                   │                  ┐
 *   left wall   │   (central box)   │   right wall     │ vertical, FIXED height
 *               │                   │                  │ (independent of layout)
 *      base L  •·······│·······│·····• base R    y = 0  ← the WALKABLE floor
 *               \      (floor)      /                   ┐
 *   left chamfer \                 /  right chamfer      │ basement: mirror of
 *                 \               /                      │ the roof, 45° down
 *        bfloorL •───────────────• bfloorR       y = -basementDepth
 *                     (basement floor)
 *
 * Eight straight sides — left wall, left eave, ridge, right eave, right wall,
 * right chamfer, basement floor, left chamfer — hence "octagon". The floor at
 * y=0 is an internal horizontal divider, not part of the outline.
 *
 * "3 sections that are equal length" (issue text) with 45° eaves is exactly
 * determined: eave surface length = eaveRun·√2, ridge length = ridgeWidth, and
 * ridgeWidth + 2·eaveRun = W ⇒ eaveRun = W/(2+√2), ridge = eaveRun·√2. That is
 * `EQUAL_LENGTH_RUN_FRACTION` below. The interpretation is an owner-tunable knob
 * (`roofRunFraction`) — e.g. 1/3 gives three equal HORIZONTAL thirds instead.
 */

export type NarrowAxis = 'x' | 'z';

/** A point on the cross-section: `a` = narrow-axis coord, `y` = height. */
export interface SectionPoint {
  a: number;
  y: number;
}

export interface HullSectionOpts {
  /** Room half-extents in metres (floorPlanDoc.roomHalfExtents()). */
  halfX: number;
  halfZ: number;
  /** Vertical wall height — FIXED regardless of floor layout. Default 4 (the
   *  legacy world.addSideWalls wallHeight). */
  wallHeight?: number;
  /** Eave horizontal run as a fraction of the cross-section width W = 2·narrowHalf.
   *  Default = equal-LENGTH sections (eaves @ 45°). Clamped to (0, 0.5). */
  roofRunFraction?: number;
  /** Basement depth in metres. Default = eave rise (a roof mirror). 0 ⇒ no
   *  basement (a flat floor, no void below). */
  basementDepth?: number;
}

/** Eave run fraction that makes the 3 roof sections EQUAL LENGTH with 45° eaves:
 *  ridge = eaveRun·√2 and ridge + 2·eaveRun = W ⇒ eaveRun = W/(2+√2). */
export const EQUAL_LENGTH_RUN_FRACTION = 1 / (2 + Math.SQRT2); // ≈ 0.29289

export const DEFAULT_WALL_HEIGHT = 4;

/** The eight ordered edges of the octagon cross-section. `from`/`to` index
 *  `OctagonProfile.outline`; `kind` classifies the surface for rendering + fade. */
export type SectionEdgeKind =
  | 'wall' // vertical side wall (doors branch off these — the "central box")
  | 'roof-eave' // 45° roof slope
  | 'roof-ridge' // flat roof top
  | 'basement-chamfer' // 45° basement slope
  | 'basement-floor'; // flat basement bottom

export interface SectionEdge {
  kind: SectionEdgeKind;
  from: number;
  to: number;
}

export interface OctagonProfile {
  narrowAxis: NarrowAxis;
  /** Half-width on the narrow axis — the cross-section radius. */
  narrowHalf: number;
  /** Half-length on the extrude axis. */
  longHalf: number;
  wallHeight: number;
  /** Eave horizontal run (= rise, since 45°). */
  eaveRun: number;
  /** Half-width of the flat roof ridge. */
  ridgeHalf: number;
  /** y of the ridge (roof peak). */
  ridgeY: number;
  basementDepth: number;
  /** Half-width of the flat basement floor (= ridgeHalf when mirrored). */
  basementHalf: number;
  /** Closed octagon outline, CCW in (a, y), 8 points. */
  outline: SectionPoint[];
  /** The 8 edges, classified. */
  edges: SectionEdge[];
}

/** Which floor axis carries the octagon cross-section. Ties (square rooms) →
 *  'x', so a square room extrudes along z (gable ends face ±z). */
export function narrowAxisFor(halfX: number, halfZ: number): NarrowAxis {
  return halfX <= halfZ ? 'x' : 'z';
}

/**
 * Compute the octagon cross-section + extrude length from room half-extents.
 * Pure: identical inputs → identical output on every client.
 */
export function computeOctagonProfile(opts: HullSectionOpts): OctagonProfile {
  const { halfX, halfZ } = opts;
  const wallHeight = opts.wallHeight ?? DEFAULT_WALL_HEIGHT;

  const narrowAxis = narrowAxisFor(halfX, halfZ);
  const narrowHalf = Math.min(halfX, halfZ);
  const longHalf = Math.max(halfX, halfZ);
  const W = 2 * narrowHalf;

  // Eave run (horizontal). 45° ⇒ rise === run. Clamp the fraction so the ridge
  // stays positive (< 0.5) and the eave stays present (> 0).
  const frac = clamp(opts.roofRunFraction ?? EQUAL_LENGTH_RUN_FRACTION, 1e-3, 0.5 - 1e-3);
  const eaveRun = W * frac;
  const eaveRise = eaveRun; // 45°
  const ridgeHalf = narrowHalf - eaveRun;
  const ridgeY = wallHeight + eaveRise;

  // Basement mirrors the roof by default (depth = eave rise). The chamfer stays
  // at 45°, so its horizontal run === basementDepth and the flat basement floor
  // half-width shrinks by that run (clamped ≥ 0 for very deep basements).
  const basementDepth = Math.max(0, opts.basementDepth ?? eaveRise);
  const basementHalf = Math.max(0, narrowHalf - basementDepth);

  // Outline CCW: up the left wall, across the roof, down the right wall, across
  // the basement (see the diagram above). Indices are referenced by `edges`.
  const outline: SectionPoint[] = [
    { a: -narrowHalf, y: 0 }, // 0 left wall base
    { a: -narrowHalf, y: wallHeight }, // 1 left wall top
    { a: -ridgeHalf, y: ridgeY }, // 2 ridge left
    { a: ridgeHalf, y: ridgeY }, // 3 ridge right
    { a: narrowHalf, y: wallHeight }, // 4 right wall top
    { a: narrowHalf, y: 0 }, // 5 right wall base
    { a: basementHalf, y: -basementDepth }, // 6 basement floor right
    { a: -basementHalf, y: -basementDepth }, // 7 basement floor left
  ];

  const edges: SectionEdge[] = [
    { kind: 'wall', from: 0, to: 1 },
    { kind: 'roof-eave', from: 1, to: 2 },
    { kind: 'roof-ridge', from: 2, to: 3 },
    { kind: 'roof-eave', from: 3, to: 4 },
    { kind: 'wall', from: 4, to: 5 },
    { kind: 'basement-chamfer', from: 5, to: 6 },
    { kind: 'basement-floor', from: 6, to: 7 },
    { kind: 'basement-chamfer', from: 7, to: 0 },
  ];

  return {
    narrowAxis,
    narrowHalf,
    longHalf,
    wallHeight,
    eaveRun,
    ridgeHalf,
    ridgeY,
    basementDepth,
    basementHalf,
    outline,
    edges,
  };
}

/**
 * Map a cross-section point (a, y) + an along-extrude coordinate `b` into world
 * (x, y, z). `narrowAxis='x'` ⇒ a→x, b→z; `narrowAxis='z'` ⇒ a→z, b→x.
 */
export function sectionToWorld(
  narrowAxis: NarrowAxis,
  a: number,
  y: number,
  b: number,
): { x: number; y: number; z: number } {
  return narrowAxis === 'x' ? { x: a, y, z: b } : { x: b, y, z: a };
}

/**
 * Outward XZ normal (unit) of a VERTICAL hull face. The four vertical faces are
 * the two side walls (at ±narrowHalf on the narrow axis) and the two extruded
 * END CAPS (at ±longHalf on the long axis). `which` picks the face; the result
 * feeds the camera-facing transparency fade (a generalisation of the #51 door
 * fade), so near faces can hide their outside skin while far faces show their
 * inside surface.
 */
export function verticalFaceNormal(
  narrowAxis: NarrowAxis,
  which: 'wall-neg' | 'wall-pos' | 'cap-neg' | 'cap-pos',
): { x: number; z: number } {
  const sign = which === 'wall-neg' || which === 'cap-neg' ? -1 : 1;
  const onNarrow = which === 'wall-neg' || which === 'wall-pos';
  // Walls face along the narrow axis; caps face along the long axis.
  const facesX = onNarrow ? narrowAxis === 'x' : narrowAxis === 'z';
  return facesX ? { x: sign, z: 0 } : { x: 0, z: sign };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Hull SURFACES (#80 S4 — windows on ANY strip) ────────────────────────────

/**
 * The 8 extruded strips of the octagon barrel, one per cross-section edge — the
 * surfaces a window (rounded-rect hole + glass) can sit on. Named by region +
 * side so they survive a room resize (the coordinates scale; the surface set
 * and their order never change). Index-aligned to `SURFACE_BY_EDGE`.
 */
export type HullSurface =
  | 'wall-neg'
  | 'roof-neg'
  | 'ridge'
  | 'roof-pos'
  | 'wall-pos'
  | 'basement-pos'
  | 'floor'
  | 'basement-neg';

/** All 8 surfaces (schema guard + editor selector cycle). */
export const SURFACES: readonly HullSurface[] = [
  'wall-neg',
  'roof-neg',
  'ridge',
  'roof-pos',
  'wall-pos',
  'basement-pos',
  'floor',
  'basement-neg',
];

/** Edge index (in `OctagonProfile.edges` order) → the surface on that strip. */
export const SURFACE_BY_EDGE: readonly HullSurface[] = [
  'wall-neg', // 0 wall (−narrowHalf)
  'roof-neg', // 1 roof-eave (−a)
  'ridge', // 2 roof-ridge
  'roof-pos', // 3 roof-eave (+a)
  'wall-pos', // 4 wall (+narrowHalf)
  'basement-pos', // 5 basement-chamfer (+a)
  'floor', // 6 basement-floor
  'basement-neg', // 7 basement-chamfer (−a)
];

/** A hull surface's cross-section edge, oriented for the `across` coordinate. */
export interface StripEdge {
  /** Reference origin in the cross-section (a, y): `across`=0 sits here. */
  p0: SectionPoint;
  /** Unit direction of INCREASING `across` in the (a, y) plane. */
  dir: SectionPoint;
  /** Length of the strip's cross-section edge (m): `across` ∈ [0, edgeLen]. */
  edgeLen: number;
}

/**
 * The cross-section edge of one hull surface, oriented so `across` reads
 * intuitively: WALLS 0..wallHeight up from the floor (byte-identical to the old
 * per-wall `y`); ROOF eaves up-slope from the wall top; BASEMENT chamfers
 * down-slope from the floor edge; RIDGE / FLOOR from the −a end to the +a end.
 *
 * Pure and side-effect-free. A window at (along, across) on `surface` maps to
 * world by: a = p0.a + dir.a·across, y = p0.y + dir.y·across, then
 * sectionToWorld(narrowAxis, a, y, along). `p0 + dir·edgeLen` lands exactly on
 * the matching outline vertex for every surface (golden-tested).
 */
export function surfaceEdge(profile: OctagonProfile, surface: HullSurface): StripEdge {
  const { narrowHalf, wallHeight, ridgeHalf, ridgeY, basementHalf, basementDepth } = profile;
  const s2 = Math.SQRT1_2; // 45° eave / chamfer components
  const eaveLen = profile.eaveRun * Math.SQRT2;
  const chamferLen = basementDepth * Math.SQRT2;
  switch (surface) {
    case 'wall-neg':
      return { p0: { a: -narrowHalf, y: 0 }, dir: { a: 0, y: 1 }, edgeLen: wallHeight };
    case 'wall-pos':
      return { p0: { a: narrowHalf, y: 0 }, dir: { a: 0, y: 1 }, edgeLen: wallHeight };
    case 'roof-neg':
      return { p0: { a: -narrowHalf, y: wallHeight }, dir: { a: s2, y: s2 }, edgeLen: eaveLen };
    case 'roof-pos':
      return { p0: { a: narrowHalf, y: wallHeight }, dir: { a: -s2, y: s2 }, edgeLen: eaveLen };
    case 'ridge':
      return { p0: { a: -ridgeHalf, y: ridgeY }, dir: { a: 1, y: 0 }, edgeLen: 2 * ridgeHalf };
    case 'basement-pos':
      return { p0: { a: narrowHalf, y: 0 }, dir: { a: -s2, y: -s2 }, edgeLen: chamferLen };
    case 'basement-neg':
      return { p0: { a: -narrowHalf, y: 0 }, dir: { a: s2, y: -s2 }, edgeLen: chamferLen };
    case 'floor':
      return { p0: { a: -basementHalf, y: -basementDepth }, dir: { a: 1, y: 0 }, edgeLen: 2 * basementHalf };
  }
}
