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

/** 🚪↔🛰️ #28 decouple, Slice 1: a docking PORT (structural berth) and a free
 *  DOOR share ONE geometry primitive — a pose on a wall at a lateral position.
 *  `PortId`/`DoorId` are both just strings here; the seam is created without a
 *  wire change (ports stay the 4 cardinal ids for now). Free doors and ports
 *  will both derive their pose from `poseFromWall` in later slices. */
export type PortId = string;

// 🧱 #66 R1 + #28 S1: door/port poses DERIVE from the room's half-extents
// (walls at ±half) instead of hardcoding ±6, so the layout scales with a
// rectangular room. Insets: stand-point 1.5 m inside the wall, through-point
// 1.0 m outside. Default 2×2 room ⇒ {6,6} reproduces the legacy ±6 / ±4.5 / ±7
// tables bit-for-bit. PAIR_OFFSET spaces the two doors that share a wall in the
// pairs layout. EW_LATERAL is a legacy quirk: e/w doors sit their STAND point
// −0.5 off the door centre (n/s and the pairs layout have no such offset), so
// centre-lateral and stand-lateral are tracked separately below to preserve it.
const FRONT_INSET = 1.5;
const THROUGH_OUTSET = 1.0;
const EW_LATERAL = -0.5;
const PAIR_OFFSET = 2.7;
const HALF_PI = Math.PI / 2;

/**
 * The single pose generator. Given a wall, the along-wall lateral of the door
 * CENTRE, and (optionally, for the legacy e/w quirk) a distinct lateral for the
 * stand/through points, derive the full pose from the current room half-extents.
 * For every clean door `standLateral === centreLateral`. This reproduces
 * `legacyTable`/`pairsTable` bit-for-bit for the 4 cardinals (see poseFromSlot).
 */
export function poseFromWall(
  wall: PhysicalDoorId,
  centreLateral: number,
  standLateral: number = centreLateral,
): PhysicalDoorPose {
  const { halfX, halfZ } = roomHalfExtents();
  switch (wall) {
    case "north":
      return {
        wall,
        x: centreLateral,
        z: -halfZ,
        outwardYaw: Math.PI,
        frameYaw: 0,
        front: { x: standLateral, z: -(halfZ - FRONT_INSET) },
        through: { x: standLateral, z: -(halfZ + THROUGH_OUTSET) },
        faceAngle: Math.PI,
        tangent: "x",
      };
    case "south":
      return {
        wall,
        x: centreLateral,
        z: halfZ,
        outwardYaw: 0,
        frameYaw: Math.PI,
        front: { x: standLateral, z: halfZ - FRONT_INSET },
        through: { x: standLateral, z: halfZ + THROUGH_OUTSET },
        faceAngle: 0,
        tangent: "x",
      };
    case "west":
      return {
        wall,
        x: -halfX,
        z: centreLateral,
        outwardYaw: -HALF_PI,
        frameYaw: HALF_PI,
        front: { x: -(halfX - FRONT_INSET), z: standLateral },
        through: { x: -(halfX + THROUGH_OUTSET), z: standLateral },
        faceAngle: -HALF_PI,
        tangent: "z",
      };
    case "east":
      return {
        wall,
        x: halfX,
        z: centreLateral,
        outwardYaw: HALF_PI,
        frameYaw: -HALF_PI,
        front: { x: halfX - FRONT_INSET, z: standLateral },
        through: { x: halfX + THROUGH_OUTSET, z: standLateral },
        faceAngle: HALF_PI,
        tangent: "z",
      };
  }
}

/** A cardinal door's fixed slot in a layout: which physical wall it sits on and
 *  its base centre/stand lateral (before any owner slide delta). */
interface DoorSlot {
  wall: PhysicalDoorId;
  centre: number;
  stand: number;
}

/** Legacy layout: the 4 doors on their own cardinal walls; e/w carry the
 *  −0.5 stand offset (EW_LATERAL). */
function legacySlot(id: PhysicalDoorId): DoorSlot {
  switch (id) {
    case "north":
      return { wall: "north", centre: 0, stand: 0 };
    case "south":
      return { wall: "south", centre: 0, stand: 0 };
    case "west":
      return { wall: "west", centre: 0, stand: EW_LATERAL };
    case "east":
      return { wall: "east", centre: 0, stand: EW_LATERAL };
  }
}

/** Paired layout ("casino-pairs" / "pool-pairs" aliases): logical south rides
 *  the north wall and logical east rides the west wall, spaced ±PAIR_OFFSET.
 *  Keeps the camera-near south/east edges clear. Stand === centre (no quirk). */
function pairsSlot(id: PhysicalDoorId): DoorSlot {
  switch (id) {
    case "north":
      return { wall: "north", centre: -PAIR_OFFSET, stand: -PAIR_OFFSET };
    case "south":
      return { wall: "north", centre: PAIR_OFFSET, stand: PAIR_OFFSET };
    case "west":
      return { wall: "west", centre: -PAIR_OFFSET, stand: -PAIR_OFFSET };
    case "east":
      return { wall: "west", centre: PAIR_OFFSET, stand: PAIR_OFFSET };
  }
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
  const slot = activeLayout === "legacy" ? legacySlot(id) : pairsSlot(id);
  return poseFromWall(
    slot.wall,
    slot.centre + lateralDelta,
    slot.stand + lateralDelta,
  );
}

/** 🛰️ #28 S1: the structural PORT pose. Ports are, for now, exactly the 4
 *  cardinal berths, so this aliases `physicalDoorPose`. Later slices split the
 *  pairing/mesh (which keys off ports) from the free-door layer; keeping this
 *  name lets those call sites read against "port" while the wire stays cardinal. */
export function physicalPortPose(
  id: PortId,
  lateralDelta = 0,
): PhysicalDoorPose {
  return physicalDoorPose(id as PhysicalDoorId, lateralDelta);
}
