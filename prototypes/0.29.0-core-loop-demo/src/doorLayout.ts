import type { DoorId } from "./doors";

export type DoorLayoutKind = "legacy" | "pool-pairs";

export interface PhysicalDoorPose {
  wall: DoorId;
  x: number;
  z: number;
  outwardYaw: number;
  frameYaw: number;
  front: { x: number; z: number };
  through: { x: number; z: number };
  faceAngle: number;
  tangent: "x" | "z";
}

const LEGACY: Record<DoorId, PhysicalDoorPose> = {
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

// Keep the camera-near south and east edges clear while preserving stable
// logical IDs for room documents and pairings.
const POOL_PAIRS: Record<DoorId, PhysicalDoorPose> = {
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

export function physicalDoorPose(
  id: DoorId,
  lateralDelta = 0,
): PhysicalDoorPose {
  const base = activeLayout === "pool-pairs" ? POOL_PAIRS[id] : LEGACY[id];
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
