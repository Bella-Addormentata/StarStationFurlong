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

const LEGACY: Record<PhysicalDoorId, PhysicalDoorPose> = {
  north: {
    wall: "north",
    x: 0,
    z: -6,
    outwardYaw: Math.PI,
    frameYaw: 0,
    front: { x: 0, z: -4.5 },
    through: { x: 0, z: -7 },
    faceAngle: Math.PI,
    tangent: "x",
  },
  south: {
    wall: "south",
    x: 0,
    z: 6,
    outwardYaw: 0,
    frameYaw: Math.PI,
    front: { x: 0, z: 4.5 },
    through: { x: 0, z: 7 },
    faceAngle: 0,
    tangent: "x",
  },
  west: {
    wall: "west",
    x: -6,
    z: 0,
    outwardYaw: -Math.PI / 2,
    frameYaw: Math.PI / 2,
    front: { x: -4.5, z: -0.5 },
    through: { x: -7, z: -0.5 },
    faceAngle: -Math.PI / 2,
    tangent: "z",
  },
  east: {
    wall: "east",
    x: 6,
    z: 0,
    outwardYaw: Math.PI / 2,
    frameYaw: -Math.PI / 2,
    front: { x: 4.5, z: -0.5 },
    through: { x: 7, z: -0.5 },
    faceAngle: Math.PI / 2,
    tangent: "z",
  },
};

// Keep the camera-near south/east edges clear. Existing IDs remain stable for
// room-doc pairings; only their physical slots change. Shared by the
// "casino-pairs" AND "pool-pairs" layout kinds.
const CASINO_PAIRS: Record<PhysicalDoorId, PhysicalDoorPose> = {
  north: {
    wall: "north",
    x: -2.7,
    z: -6,
    outwardYaw: Math.PI,
    frameYaw: 0,
    front: { x: -2.7, z: -4.5 },
    through: { x: -2.7, z: -7 },
    faceAngle: Math.PI,
    tangent: "x",
  },
  south: {
    wall: "north",
    x: 2.7,
    z: -6,
    outwardYaw: Math.PI,
    frameYaw: 0,
    front: { x: 2.7, z: -4.5 },
    through: { x: 2.7, z: -7 },
    faceAngle: Math.PI,
    tangent: "x",
  },
  west: {
    wall: "west",
    x: -6,
    z: -2.7,
    outwardYaw: -Math.PI / 2,
    frameYaw: Math.PI / 2,
    front: { x: -4.5, z: -2.7 },
    through: { x: -7, z: -2.7 },
    faceAngle: -Math.PI / 2,
    tangent: "z",
  },
  east: {
    wall: "west",
    x: -6,
    z: 2.7,
    outwardYaw: -Math.PI / 2,
    frameYaw: Math.PI / 2,
    front: { x: -4.5, z: 2.7 },
    through: { x: -7, z: 2.7 },
    faceAngle: -Math.PI / 2,
    tangent: "z",
  },
};

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
  const source = activeLayout === "legacy" ? LEGACY : CASINO_PAIRS;
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
