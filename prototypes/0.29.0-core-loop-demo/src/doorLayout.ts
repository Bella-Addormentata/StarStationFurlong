import { roomHalfExtents } from "./floorPlanDoc";

export type PhysicalDoorId = "north" | "south" | "east" | "west";
/** "casino-pairs" and "pool-pairs" are ALIASES of the same paired
 *  arrangement (their pose tables were merged — they matched exactly):
 *  logical SOUTH on the north wall, EAST on the west wall. Both names are
 *  kept so each room's intent stays readable at the call site. */
export type DoorLayoutKind = "legacy" | "casino-pairs" | "pool-pairs";

export interface PhysicalDoorPose {
  wall: "north" | "south" | "east" | "west";
  x: number;
  z: number;
  outwardYaw: number;
  frameYaw: number;
  front: { x: number; z: number };
  through: { x: number; z: number };
  faceAngle: number;
  tangent: "x" | "z";
}

// 🧱 #66 R1: door poses DERIVE from the room's half-extents (walls at ±half)
// instead of hardcoding ±6, so the door layout scales with a rectangular room.
// Insets: stand-point 1.5 m inside the wall, through-point 1.0 m outside; e/w
// doors carry the −0.5 lateral base. Default 2×2 room ⇒ {6,6} reproduces the
// legacy ±6 / ±4.5 / ±7 tables bit-for-bit. PAIR_OFFSET spaces the two doors
// that share a wall in the pairs layout.
const FRONT_INSET = 1.5;
const THROUGH_OUTSET = 1.0;
const EW_LATERAL = -0.5;
const PAIR_OFFSET = 2.7;
const HALF_PI = Math.PI / 2;

/** The 4 legacy cardinal poses, derived from the room's half-extents. */
function legacyTable(
  halfX: number,
  halfZ: number,
): Record<PhysicalDoorId, PhysicalDoorPose> {
  return {
    north: {
      wall: "north",
      x: 0,
      z: -halfZ,
      outwardYaw: Math.PI,
      frameYaw: 0,
      front: { x: 0, z: -(halfZ - FRONT_INSET) },
      through: { x: 0, z: -(halfZ + THROUGH_OUTSET) },
      faceAngle: Math.PI,
      tangent: "x",
    },
    south: {
      wall: "south",
      x: 0,
      z: halfZ,
      outwardYaw: 0,
      frameYaw: Math.PI,
      front: { x: 0, z: halfZ - FRONT_INSET },
      through: { x: 0, z: halfZ + THROUGH_OUTSET },
      faceAngle: 0,
      tangent: "x",
    },
    west: {
      wall: "west",
      x: -halfX,
      z: 0,
      outwardYaw: -HALF_PI,
      frameYaw: HALF_PI,
      front: { x: -(halfX - FRONT_INSET), z: EW_LATERAL },
      through: { x: -(halfX + THROUGH_OUTSET), z: EW_LATERAL },
      faceAngle: -HALF_PI,
      tangent: "z",
    },
    east: {
      wall: "east",
      x: halfX,
      z: 0,
      outwardYaw: HALF_PI,
      frameYaw: -HALF_PI,
      front: { x: halfX - FRONT_INSET, z: EW_LATERAL },
      through: { x: halfX + THROUGH_OUTSET, z: EW_LATERAL },
      faceAngle: HALF_PI,
      tangent: "z",
    },
  };
}

// Keep the camera-near south/east edges clear. Existing IDs remain stable for
// room-doc pairings; only their physical slots change. Shared by the
// "casino-pairs" AND "pool-pairs" layout kinds. Wall coords derive from the
// room size; the ±PAIR_OFFSET spacing along the shared wall is fixed.
function pairsTable(
  halfX: number,
  halfZ: number,
): Record<PhysicalDoorId, PhysicalDoorPose> {
  return {
    north: {
      wall: "north",
      x: -PAIR_OFFSET,
      z: -halfZ,
      outwardYaw: Math.PI,
      frameYaw: 0,
      front: { x: -PAIR_OFFSET, z: -(halfZ - FRONT_INSET) },
      through: { x: -PAIR_OFFSET, z: -(halfZ + THROUGH_OUTSET) },
      faceAngle: Math.PI,
      tangent: "x",
    },
    south: {
      wall: "north",
      x: PAIR_OFFSET,
      z: -halfZ,
      outwardYaw: Math.PI,
      frameYaw: 0,
      front: { x: PAIR_OFFSET, z: -(halfZ - FRONT_INSET) },
      through: { x: PAIR_OFFSET, z: -(halfZ + THROUGH_OUTSET) },
      faceAngle: Math.PI,
      tangent: "x",
    },
    west: {
      wall: "west",
      x: -halfX,
      z: -PAIR_OFFSET,
      outwardYaw: -HALF_PI,
      frameYaw: HALF_PI,
      front: { x: -(halfX - FRONT_INSET), z: -PAIR_OFFSET },
      through: { x: -(halfX + THROUGH_OUTSET), z: -PAIR_OFFSET },
      faceAngle: -HALF_PI,
      tangent: "z",
    },
    east: {
      wall: "west",
      x: -halfX,
      z: PAIR_OFFSET,
      outwardYaw: -HALF_PI,
      frameYaw: HALF_PI,
      front: { x: -(halfX - FRONT_INSET), z: PAIR_OFFSET },
      through: { x: -(halfX + THROUGH_OUTSET), z: PAIR_OFFSET },
      faceAngle: -HALF_PI,
      tangent: "z",
    },
  };
}

let activeLayout: DoorLayoutKind = "legacy";

export function setActiveDoorLayout(layout: DoorLayoutKind): void {
  activeLayout = layout;
}

export function activeDoorLayout(): DoorLayoutKind {
  return activeLayout;
}

export function physicalDoorPose(
  id: PhysicalDoorId,
  lateralDelta = 0,
): PhysicalDoorPose {
  const { halfX, halfZ } = roomHalfExtents();
  const source =
    activeLayout === "legacy"
      ? legacyTable(halfX, halfZ)
      : pairsTable(halfX, halfZ);
  const base = source[id];
  const dx = base.tangent === "x" ? lateralDelta : 0;
  const dz = base.tangent === "z" ? lateralDelta : 0;
  return {
    ...base,
    x: base.x + dx,
    z: base.z + dz,
    front: { x: base.front.x + dx, z: base.front.z + dz },
    through: { x: base.through.x + dx, z: base.through.z + dz },
  };
}
