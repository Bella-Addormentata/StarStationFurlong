/**
 * 🚪 Door layout — the single physical-pose authority for the four doors.
 *
 * Unifies two refactors that both reworked door geometry (unified-doorlayout-plan.md):
 *  - #66 R1 (rectangular rooms): door positions DERIVE from the room size.
 *  - #71/#72 (casino/pool): a richer per-door pose + a LAYOUT SWAP so a room can
 *    re-slot its four logical doors onto shared walls ("pairs" layout).
 *
 * `physicalDoorPose(id, delta)` is the one call every door-geometry site uses
 * (doors.ts walk targets, docking.ts port groups, adapter.ts vestibule/chain/
 * projection). It returns the FULL pose for the active layout with the slide
 * `delta` applied along the door's tangent. Every coordinate is derived from
 * `roomHalfExtents()`, so the default 2×2 room reproduces the legacy ±6 poses
 * bit-for-bit while a rectangle scales correctly.
 *
 * Logical door IDs stay {north,south,east,west} for room-doc pairings; a layout
 * only changes where each ID physically sits (the "pairs" layout puts all four
 * on the north+west walls to keep the camera-near south/east edges clear).
 */

import type { DoorId } from './doors';
import { roomHalfExtents } from './floorPlanDoc';

/** Alias kept for parity with the casino/pool branches' imports. */
export type PhysicalDoorId = DoorId;

/** `casino-pairs` and `pool-pairs` are the same physical arrangement — both map
 *  to the derived PAIRS table; the distinct names let either room set it. */
export type DoorLayoutKind = 'legacy' | 'casino-pairs' | 'pool-pairs';

export interface PhysicalDoorPose {
  /** Which wall this door physically sits on (legacy: its own cardinal). */
  wall: DoorId;
  /** Door-group centre on the wall. */
  x: number;
  z: number;
  /** Outward normal yaw (vestibule/chain face this way; +z outward = 0). */
  outwardYaw: number;
  /** Door-frame group yaw (the 3D port group's rotation). */
  frameYaw: number;
  /** Walkable stand-point just inside the room. */
  front: { x: number; z: number };
  /** Scripted point past the threshold, outside the room. */
  through: { x: number; z: number };
  /** 8-way logical facing toward the door from `front`. */
  faceAngle: number;
  /** The slide axis: n/s doors slide in x, e/w in z. */
  tangent: 'x' | 'z';
}

// Legacy geometry insets (walls at ±half): stand-point 1.5 m inside, through
// 1.0 m outside; e/w doors carry the −0.5 lateral base. PAIR_OFFSET spaces the
// two doors that share a wall in the pairs layout.
const FRONT_INSET = 1.5;
const THROUGH_OUTSET = 1.0;
const EW_LATERAL = -0.5;
const PAIR_OFFSET = 2.7;
const HALF_PI = Math.PI / 2;

/** The 4 legacy cardinal poses, derived from the room's half-extents. Default
 *  2×2 room ⇒ north{0,-6}/front{0,-4.5}/through{0,-7}, etc. — the legacy table. */
function legacyTable(halfX: number, halfZ: number): Record<DoorId, PhysicalDoorPose> {
  return {
    north: { wall: 'north', x: 0, z: -halfZ, outwardYaw: Math.PI, frameYaw: 0,
      front: { x: 0, z: -(halfZ - FRONT_INSET) }, through: { x: 0, z: -(halfZ + THROUGH_OUTSET) },
      faceAngle: Math.PI, tangent: 'x' },
    south: { wall: 'south', x: 0, z: halfZ, outwardYaw: 0, frameYaw: Math.PI,
      front: { x: 0, z: halfZ - FRONT_INSET }, through: { x: 0, z: halfZ + THROUGH_OUTSET },
      faceAngle: 0, tangent: 'x' },
    west: { wall: 'west', x: -halfX, z: 0, outwardYaw: -HALF_PI, frameYaw: HALF_PI,
      front: { x: -(halfX - FRONT_INSET), z: EW_LATERAL }, through: { x: -(halfX + THROUGH_OUTSET), z: EW_LATERAL },
      faceAngle: -HALF_PI, tangent: 'z' },
    east: { wall: 'east', x: halfX, z: 0, outwardYaw: HALF_PI, frameYaw: -HALF_PI,
      front: { x: halfX - FRONT_INSET, z: EW_LATERAL }, through: { x: halfX + THROUGH_OUTSET, z: EW_LATERAL },
      faceAngle: HALF_PI, tangent: 'z' },
  };
}

/** The "pairs" layout (casino/pool): logical south rides the north wall beside
 *  north, logical east rides the west wall beside west — camera-near south/east
 *  edges stay clear. Wall coords derive; the ±PAIR_OFFSET spacing is fixed. */
function pairsTable(halfX: number, halfZ: number): Record<DoorId, PhysicalDoorPose> {
  return {
    north: { wall: 'north', x: -PAIR_OFFSET, z: -halfZ, outwardYaw: Math.PI, frameYaw: 0,
      front: { x: -PAIR_OFFSET, z: -(halfZ - FRONT_INSET) }, through: { x: -PAIR_OFFSET, z: -(halfZ + THROUGH_OUTSET) },
      faceAngle: Math.PI, tangent: 'x' },
    south: { wall: 'north', x: PAIR_OFFSET, z: -halfZ, outwardYaw: Math.PI, frameYaw: 0,
      front: { x: PAIR_OFFSET, z: -(halfZ - FRONT_INSET) }, through: { x: PAIR_OFFSET, z: -(halfZ + THROUGH_OUTSET) },
      faceAngle: Math.PI, tangent: 'x' },
    west: { wall: 'west', x: -halfX, z: -PAIR_OFFSET, outwardYaw: -HALF_PI, frameYaw: HALF_PI,
      front: { x: -(halfX - FRONT_INSET), z: -PAIR_OFFSET }, through: { x: -(halfX + THROUGH_OUTSET), z: -PAIR_OFFSET },
      faceAngle: -HALF_PI, tangent: 'z' },
    east: { wall: 'west', x: -halfX, z: PAIR_OFFSET, outwardYaw: -HALF_PI, frameYaw: HALF_PI,
      front: { x: -(halfX - FRONT_INSET), z: PAIR_OFFSET }, through: { x: -(halfX + THROUGH_OUTSET), z: PAIR_OFFSET },
      faceAngle: -HALF_PI, tangent: 'z' },
  };
}

let activeLayout: DoorLayoutKind = 'legacy';

export function setActiveDoorLayout(layout: DoorLayoutKind): void {
  activeLayout = layout;
}

export function activeDoorLayout(): DoorLayoutKind {
  return activeLayout;
}

/**
 * The physical pose of one door under the active layout, with its slide `delta`
 * applied along the tangent axis. Derived from `roomHalfExtents()` fresh each
 * call (cheap; picks up a room-size or layout change immediately).
 */
export function physicalDoorPose(id: DoorId, lateralDelta = 0): PhysicalDoorPose {
  const { halfX, halfZ } = roomHalfExtents();
  const table = activeLayout === 'legacy' ? legacyTable(halfX, halfZ) : pairsTable(halfX, halfZ);
  const base = table[id];
  const dx = base.tangent === 'x' ? lateralDelta : 0;
  const dz = base.tangent === 'z' ? lateralDelta : 0;
  return {
    ...base,
    x: base.x + dx,
    z: base.z + dz,
    front: { x: base.front.x + dx, z: base.front.z + dz },
    through: { x: base.through.x + dx, z: base.through.z + dz },
  };
}
