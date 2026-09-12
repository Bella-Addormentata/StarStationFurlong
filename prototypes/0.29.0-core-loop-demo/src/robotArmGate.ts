/**
 * 🦾 ROBOT ARM construction gate (issue #62, owner design ruling).
 *
 * The first DIEGETIC construction gate for a new pairing: before a fresh
 * module may be docked at a door, a station-mounted robot arm must already be
 * present on that door's wall, within arm's reach of the door centre. Without
 * one, the INITIATE seam (docking a paired module) AND the PROVISION seam
 * (minting a fresh module at this door) both refuse with the same
 * player-facing message. Both seams share the same skip lanes
 * (paired / transient / auto-accept walkthrough) so the compatibility rule
 * — "gate applies to NEW pairings only" — reads identically at either
 * entry point; the pairing ACCEPT seam is unchanged (a joiner accepts on
 * trust of the initiator's local gate).
 *
 * This module is deliberately PURE — no Yjs, no three.js, no DOM, no
 * subscriptions. It exposes ONE predicate the caller (docking.ts) evaluates at
 * the same seams the #67 construction policy is checked, and it is the sole
 * artefact the vitest suite drives.
 *
 * Contract summary (ISO/IEC 25000 · functional suitability; ISO/IEC 5055 ·
 * technical security · deterministic pure functions):
 *  - Inputs are the door's pose (wall + centre coordinates + tangent axis) and
 *    the caller's arm inventory (readonly array — never mutated).
 *  - An arm COVERS a door when it sits on the SAME wall AND its along-wall
 *    distance to the door centre is ≤ radius (default DEFAULT_ARM_REACH).
 *  - Nearest-arm-wins when several qualify (deterministic tie-break — the
 *    lower id string wins so the answer is stable across peers).
 *  - `{ok:false, reason}` never encodes exception data; the reason is the
 *    exact string surfaced to the player at the INITIATE alert.
 *
 * The compatibility rule the OWNER pinned in the issue thread ("gate applies
 * to NEW pairings only") is enforced by the CALLER, not here: docking.ts skips
 * the check when the door is already `pairedSuccessfully` or the pairing is a
 * TRANSIENT adapter berth (#67 D2). That keeps this predicate side-effect free
 * and independently testable.
 */

import type { FurnitureItem, FurnitureKind, Rot } from './furniture';
import type { PhysicalDoorPose } from './doorLayout';
import type { DoorWall } from './doorLayoutDoc';

/** The furniture kind that satisfies the arm gate. Widened as a const so
 *  callers can filter their inventory without spelling the literal twice. */
export const ROBOT_ARM_KIND: FurnitureKind = 'robot-arm';

/**
 * Along-wall reach radius (metres) an arm covers from its mount. Set to a
 * conservative 4.0 m — twice hull.EXT_DOOR_BAND (1.8 m) plus grace, so an arm
 * mounted anywhere inside the door's exterior docking corridor qualifies, and
 * the number lands on the integer grid every mount snaps to (see hull.ts
 * snapExteriorPos / doorLayout.snapDoorLateral). Widening it later never
 * refuses a formerly-accepted arm; narrowing it might, hence the honest
 * default rather than a small experimental one.
 */
export const DEFAULT_ARM_REACH = 4.0;

/**
 * Which wall a hull-mounted item claims, given its rot. Mirrors hull.ROT_WALL
 * exactly — the wall-derived rot mapping is the ONLY thing furniture-exterior
 * placement carries about the wall a mount sits on, so the arm inherits it.
 * Kept LOCAL to this module so the pure gate has zero runtime dependency on
 * hull.ts / three.js; a matching-values test in robotArmGate.test.ts catches
 * any drift the day it happens.
 */
const WALL_FOR_ROT: Record<Rot, DoorWall> = {
  0: 'y+',
  1: 'x+',
  2: 'y-',
  3: 'x-',
};

/**
 * Along-wall coordinate for a pose on the given wall — x for the y± walls
 * (their tangent is x), z for the x± walls. Mirrors hull.alongOf but stays
 * inline so this module carries no runtime hull import.
 */
function alongOnWall(wall: DoorWall, pos: { x: number; z: number }): number {
  return wall === 'y+' || wall === 'y-' ? pos.x : pos.z;
}

/** Caller may narrow the radius (finer tests, later balance passes). */
export interface RobotArmGateOptions {
  /** Along-wall reach (metres). Default DEFAULT_ARM_REACH. */
  radius?: number;
}

/**
 * Predicate result. `ok=true` names the winning arm; `ok=false` carries the
 * exact player-facing reason string (docking.ts pipes it straight to alert()).
 */
export type RobotArmGateResult =
  | { ok: true; arm: FurnitureItem }
  | { ok: false; reason: string };

/**
 * 🦾 The pure gate predicate: does ANY arm cover the door?
 *
 * Traversal:
 *  1. Filter `arms` to the ROBOT_ARM_KIND — callers may pass a full FURNITURE
 *     list and this stays honest without needing them to pre-filter.
 *  2. Keep arms whose rot-derived wall matches `door.wall` (a hull-mounted arm
 *     lives on exactly ONE wall; a different wall can never reach across the
 *     hull to the door).
 *  3. Compute along-wall distance to the door centre (|arm_along −
 *     door_along|); keep arms within `radius` metres.
 *  4. Choose the CLOSEST — deterministic tie-break by id string so two peers
 *     with identical inventories always agree on the arm named in the
 *     accept-side render.
 *
 * @param door  Any object with the pose fields this predicate needs.
 * @param arms  The station's furniture inventory (unfiltered is fine).
 * @param opts  Optional radius override.
 * @returns `{ok:true, arm}` when at least one arm covers the door; otherwise
 *          `{ok:false, reason}` with a player-facing sentence.
 */
export function armCoversDoor(
  door: Pick<PhysicalDoorPose, 'wall' | 'x' | 'z'>,
  arms: readonly FurnitureItem[],
  opts: RobotArmGateOptions = {},
): RobotArmGateResult {
  const radius = opts.radius ?? DEFAULT_ARM_REACH;
  if (!(radius > 0)) {
    // Defensive: a non-positive radius means NO arm ever covers a door, which
    // is a caller bug we'd rather surface than silently accept.
    return { ok: false, reason: 'internal error: arm reach radius must be positive' };
  }

  const armsOnly = arms.filter((i) => i.kind === ROBOT_ARM_KIND);
  if (armsOnly.length === 0) {
    return {
      ok: false,
      reason: 'no ROBOT ARM installed — mount one on the station hull before docking a new module.',
    };
  }

  const doorAlong = alongOnWall(door.wall, { x: door.x, z: door.z });
  type Candidate = { arm: FurnitureItem; distance: number };
  const covers: Candidate[] = [];
  for (const arm of armsOnly) {
    const armWall = WALL_FOR_ROT[arm.rot];
    if (armWall !== door.wall) continue;
    const armAlong = alongOnWall(door.wall, arm.pos);
    const distance = Math.abs(armAlong - doorAlong);
    if (distance <= radius) covers.push({ arm, distance });
  }

  if (covers.length === 0) {
    // Same wall vs off-wall are distinct player-diagnosable states: an arm on
    // the wrong wall reads differently from an arm too far along the right
    // wall. Reporting the closer failure keeps the guidance actionable.
    const sameWall = armsOnly.filter((a) => WALL_FOR_ROT[a.rot] === door.wall);
    if (sameWall.length > 0) {
      return {
        ok: false,
        reason:
          `ROBOT ARM on this wall is too far from the door — mount it within ${radius} m of the door centre.`,
      };
    }
    return {
      ok: false,
      reason:
        `no ROBOT ARM on this door's wall (${door.wall}) — the arm must sit on the SAME wall as the door.`,
    };
  }

  // Deterministic ordering: closest wins, ties broken by ascending id string.
  covers.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.arm.id < b.arm.id ? -1 : a.arm.id > b.arm.id ? 1 : 0;
  });
  return { ok: true, arm: covers[0].arm };
}

/**
 * 🦾 The pure REACH direction the winning arm should animate toward (unit x
 * along-wall + y up + z outward from the wall, in the arm's LOCAL rot-0 frame
 * as furniture builders use it — hull.WALL_ROT rotates the arm group so that
 * local +z always points AWAY from the room). Independent of any three.js
 * math library so both the animator (docking.ts) and its tests use one
 * source of truth.
 *
 * Returns { yaw, pitch }: yaw is the shoulder swing about local Y (radians;
 * positive turns the reach toward +x = along-wall); pitch is the elbow lift
 * about local X (radians; 0 = fully extended along +z, π/2 = folded up).
 * When the door sits AT the arm's along-wall centre, yaw is 0; when off-side,
 * yaw is signed toward the door.
 *
 * `progress` in [0,1] eases idle-to-reach: at 0 the arm folds up (idle
 * pitch), at 1 it extends toward the door (reach pitch). Callers pass an
 * eased t; this function is a stateless mapping — the animator owns the
 * time integration and the eased curve.
 */
export interface ArmReachPose {
  /** Shoulder swing about local Y (positive toward local +x = along-wall). */
  shoulderYaw: number;
  /** Elbow lift about local X (0 = fully extended toward door). */
  elbowPitch: number;
}

/** Idle fold: elbow tucked up 90° (arm rests folded against the plate). */
const IDLE_ELBOW_PITCH = Math.PI / 2;
/** Reach: elbow slightly bent (0.35 rad) so the reach reads as effort, not a stick. */
const REACH_ELBOW_PITCH = 0.35;

export function armReachPose(
  door: Pick<PhysicalDoorPose, 'wall' | 'x' | 'z'>,
  arm: Pick<FurnitureItem, 'pos' | 'rot'>,
  progress: number,
): ArmReachPose {
  const t = Math.max(0, Math.min(1, progress));
  // Along-wall delta from the arm's mount to the door centre. Signed so the
  // shoulder swings the right way; the local +x axis of an exterior-wall mount
  // is the along-wall direction after the WALL_ROT alignment.
  const armWall = WALL_FOR_ROT[arm.rot];
  const armAlong = alongOnWall(armWall, arm.pos);
  const doorAlong = alongOnWall(armWall, { x: door.x, z: door.z });
  const delta = doorAlong - armAlong;
  // Fixed "reach forward" the yaw is measured against: 2 m out from the wall
  // is a plausible arm reach and keeps atan2 well-conditioned near zero delta.
  const REACH_FORWARD = 2.0;
  const targetYaw = Math.atan2(delta, REACH_FORWARD);
  // The arm's along-wall LOCAL axis flips sign between the y+ / y- walls
  // vs the x+ / x- walls, because WALL_ROT (0/1/2/3) rotates the local
  // frame accordingly:
  //   y+ rot 0 : local +x = world +x  → delta.x maps to +yaw directly
  //   x+ rot 1 : local +x = world -z  → delta.z maps to -yaw
  //   y- rot 2 : local +x = world -x  → delta.x maps to -yaw
  //   x- rot 3 : local +x = world +z  → delta.z maps to +yaw
  // Both x- and y+ read positively; x+ and y- read negatively.
  const sign = armWall === 'y-' || armWall === 'x+' ? -1 : 1;
  const shoulderYaw = sign * targetYaw * t; // idle → 0 yaw (folded straight up)
  const elbowPitch = IDLE_ELBOW_PITCH * (1 - t) + REACH_ELBOW_PITCH * t;
  return { shoulderYaw, elbowPitch };
}
