/**
 * 🔭 Cupola end wall — the pure geometry of a room whose END WALL is an
 * eight-sided observation cupola (the ISS cupola, a starship's bridge glass).
 *
 * A cupola is a WALL TYPE, not a module type: any ordinary module can make one
 * of its two octagon END CAPS a cupola (floorPlan `cupola` key, floorPlanDoc).
 * The room keeps its size, its floor plan and every other wall; only the last
 * `depth` metres at that end change. There the octagon barrel tapers into a
 * frustum: each of the octagon's 8 edges runs inward at 45° to a smaller,
 * ALIGNED octagon — the flat tip window standing in the end plane:
 *
 *        plan view (square room, cupola on y+)           end-on (tip window)
 *
 *      ┌──────────────────────┐  ← y− cap               base octagon ┌──┐
 *      │                      │                          (the room) /    \
 *      │        floor         │                                    │ ┌┐ │ tip
 *      │                      │  b0 = longHalf − depth             │ └┘ │
 *      └┐                    ┌┘ ← corners cut at 45°               \    /
 *        └──────────────────┘   ← tip window (y+)                  └──┘
 *
 * The tapering is an OFFSET, not a scale, so every frustum face leans at the
 * same 45°: the two vertical walls step in by `depth` (the floor corners are
 * cut at exactly 45°, both walls keep their full height), the ridge drops by
 * `depth` and the basement floor rises by it. Ridge and basement keep their
 * widths, which keeps every face a PLANAR trapezoid (checked in cupola.test).
 *
 * The cupola sits INSIDE the room's footprint, so the module's envelope — its
 * docking, its place in the station, its exterior layout — is unchanged. The
 * cupola wall takes no doors (the window wall is all glass).
 *
 * THREE-free and side-effect-free, like hullSection.ts, so the walkable floor,
 * the door rules and the hull builder all read one source.
 */

import {
  computeOctagonProfile,
  narrowAxisFor,
  type HullSectionOpts,
  type NarrowAxis,
  type OctagonProfile,
  type SectionPoint,
} from './hullSection';

/** A room wall in the plan-view axis vocabulary (doorLayoutDoc.DoorWall). */
export type CupolaWall = 'x+' | 'x-' | 'y+' | 'y-';

export const CUPOLA_WALLS: readonly CupolaWall[] = ['x+', 'x-', 'y+', 'y-'];

/** The deepest a cupola runs into its room (m). Narrow rooms get less — see
 *  cupolaDepth. */
export const CUPOLA_MAX_DEPTH = 2;

/** Which end cap (−/+ on the extrude axis) the cupola replaces. */
export type CupolaCap = 'cap-neg' | 'cap-pos';

/** The two END walls of a room of these half-extents — the walls where the
 *  octagon shows, so the only walls a cupola can align with. A square room
 *  extrudes along z (narrowAxisFor ties → 'x'), so its ends are y− and y+. */
export function cupolaEndWalls(halfX: number, halfZ: number): [CupolaWall, CupolaWall] {
  return narrowAxisFor(halfX, halfZ) === 'x' ? ['y-', 'y+'] : ['x-', 'x+'];
}

/** The end cap a wall is, or null when the wall is a side wall. */
export function cupolaCap(narrowAxis: NarrowAxis, wall: CupolaWall): CupolaCap | null {
  const onLongAxis = narrowAxis === 'x' ? wall === 'y-' || wall === 'y+' : wall === 'x-' || wall === 'x+';
  if (!onLongAxis) return null;
  return wall === 'x-' || wall === 'y-' ? 'cap-neg' : 'cap-pos';
}

/**
 * How far the cupola runs into the room (= how far each face steps in). At
 * most CUPOLA_MAX_DEPTH, and short enough that the tapered eaves and basement
 * chamfers keep some length (80 % of each) and at least 60 % of the room's
 * length is left square. A 12 m wide room gets the full 2 m; a one-tile (6 m)
 * wide room about 1.4 m.
 */
export function cupolaDepth(profile: OctagonProfile): number {
  let d = Math.min(CUPOLA_MAX_DEPTH, 0.8 * profile.eaveRun, 0.4 * profile.longHalf);
  if (profile.basementDepth > 0) d = Math.min(d, 0.8 * profile.basementDepth);
  return Math.max(0, d);
}

/**
 * The tip window's outline: the base octagon offset inward by `depth` (see the
 * module header). Same vertex order as OctagonProfile.outline, so edge i of the
 * base and edge i of the tip bound frustum face i.
 */
export function cupolaTipOutline(profile: OctagonProfile, depth: number): SectionPoint[] {
  const { narrowHalf, wallHeight, ridgeHalf, ridgeY, basementDepth, basementHalf } = profile;
  const wallA = narrowHalf - depth;
  const ridgeTip = ridgeY - depth;
  // The basement floor rises by `depth` unless there is no basement to lift.
  const lift = Math.min(depth, basementDepth);
  const baseY = -(basementDepth - lift);
  const baseHalf = basementHalf - depth + lift;
  return [
    { a: -wallA, y: 0 },
    { a: -wallA, y: wallHeight },
    { a: -ridgeHalf, y: ridgeTip },
    { a: ridgeHalf, y: ridgeTip },
    { a: wallA, y: wallHeight },
    { a: wallA, y: 0 },
    { a: baseHalf, y: baseY },
    { a: -baseHalf, y: baseY },
  ];
}

/** A cupola resolved against one room size: everything the floor, the walk
 *  rules, the door rules and the hull need. */
export interface CupolaPlan {
  wall: CupolaWall;
  cap: CupolaCap;
  profile: OctagonProfile;
  /** −1 / +1: which end of the extrude axis. */
  sign: -1 | 1;
  depth: number;
  /** Extrude-axis coordinate where the taper starts (the base octagon). */
  b0: number;
  /** Extrude-axis coordinate of the tip window (the room's end plane). */
  tipB: number;
}

/** Resolve a stored cupola wall against a room size. Null when there is no
 *  cupola, or the wall is not an end wall at this size (a resize turned it
 *  into a side wall) — the room then renders plain, and the setting comes back
 *  if the room is resized back. */
export function cupolaPlan(
  opts: HullSectionOpts,
  wall: CupolaWall | null | undefined,
): CupolaPlan | null {
  if (!wall) return null;
  const profile = computeOctagonProfile(opts);
  const cap = cupolaCap(profile.narrowAxis, wall);
  if (!cap) return null;
  const depth = cupolaDepth(profile);
  if (depth <= 0) return null;
  const sign = cap === 'cap-pos' ? 1 : -1;
  return {
    wall,
    cap,
    profile,
    sign,
    depth,
    b0: sign * (profile.longHalf - depth),
    tipB: sign * profile.longHalf,
  };
}

/** A plan-view point split into the cross-section axis `a` and extrude `b`. */
function toAB(plan: CupolaPlan, x: number, z: number): { a: number; b: number } {
  return plan.profile.narrowAxis === 'x' ? { a: x, b: z } : { a: z, b: x };
}

/**
 * How far (m) a plan point stands INSIDE the cupola's two cut corners —
 * negative when it is out in a cut-off corner. Points short of the taper are
 * measured against the extended 45° line, which is what the walk clamp wants.
 * The cut line runs from (±narrowHalf, b0) to (±(narrowHalf − depth), tipB):
 * inside ⇔ |a| + sign·b ≤ narrowHalf + longHalf − depth.
 */
export function cupolaCornerClearance(plan: CupolaPlan, x: number, z: number): number {
  const { a, b } = toAB(plan, x, z);
  const k = plan.profile.narrowHalf + plan.profile.longHalf - plan.depth;
  return (k - Math.abs(a) - plan.sign * b) / Math.SQRT2;
}

/**
 * Push a plan point back inside the cut corners with `clearance` to spare
 * (a no-op for points already clear). Moves straight along the cut's normal,
 * so a player walking into the glass slides along it.
 */
export function clampOutOfCupolaCorners(
  plan: CupolaPlan,
  x: number,
  z: number,
  clearance: number,
): { x: number; z: number } {
  const short = clearance - cupolaCornerClearance(plan, x, z);
  if (short <= 0) return { x, z };
  const { a, b } = toAB(plan, x, z);
  const step = short / Math.SQRT2;
  const a2 = a - (a < 0 ? -1 : 1) * step;
  const b2 = b - plan.sign * step;
  return plan.profile.narrowAxis === 'x' ? { x: a2, z: b2 } : { x: b2, z: a2 };
}

/** The floor outline in world XZ (CCW seen from above): the room rectangle
 *  with the two cupola-end corners cut at 45°. */
export function cupolaFloorOutline(plan: CupolaPlan): Array<{ x: number; z: number }> {
  const { narrowHalf: n, longHalf: l, narrowAxis } = plan.profile;
  const s = plan.sign;
  const d = plan.depth;
  // In (a, b): the far end is plain, the cupola end steps in by d.
  const ab: Array<{ a: number; b: number }> = [
    { a: -n, b: -s * l },
    { a: n, b: -s * l },
    { a: n, b: s * (l - d) },
    { a: n - d, b: s * l },
    { a: -(n - d), b: s * l },
    { a: -n, b: s * (l - d) },
  ];
  const pts = ab.map(({ a, b }) => (narrowAxis === 'x' ? { x: a, z: b } : { x: b, z: a }));
  // Normalise winding so consumers can rely on it (signed area in x/z).
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.z - q.x * p.z;
  }
  return area < 0 ? pts.reverse() : pts;
}

/**
 * The along-wall span a SIDE wall keeps clear of the taper: a side wall runs
 * the extrude axis, and past `b0` it is cupola glass, not wall. Returns the
 * [lo, hi] run of the side walls in their own lateral coordinate.
 */
export function cupolaSideWallRun(plan: CupolaPlan): { lo: number; hi: number } {
  const l = plan.profile.longHalf;
  return plan.sign > 0 ? { lo: -l, hi: plan.b0 } : { lo: plan.b0, hi: l };
}

/** True when an axis-aligned plan box stays `clearance` inside the cut
 *  corners (the region is convex, so its four corners decide). */
export function boxClearOfCupolaCorners(
  plan: CupolaPlan,
  box: { x0: number; x1: number; z0: number; z1: number },
  clearance: number,
): boolean {
  for (const x of [box.x0, box.x1]) {
    for (const z of [box.z0, box.z1]) {
      if (cupolaCornerClearance(plan, x, z) < clearance) return false;
    }
  }
  return true;
}
