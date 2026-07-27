import { roomHalfExtents } from "./floorPlanDoc";
import type { DoorWall } from "./doorLayoutDoc";

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

/** 🚪 The cardinal/free split in one predicate: the 4 cardinal ids are the
 *  structural berths (legacy pose tables, floorPlan slide store, pairing wire);
 *  everything else is a free `d:` door that owns its position in its layout
 *  record. #91 hoisted this here — docking.ts and editMode.ts each had a
 *  private copy and world.ts/main.ts had none, which is how free door ids kept
 *  reaching cardinal-only code and throwing. */
export function isCardinalDoorId(id: string): id is PhysicalDoorId {
  return id === "north" || id === "south" || id === "east" || id === "west";
}

// 🧱 #66 R1 + #28 S1: door/port poses DERIVE from the room's half-extents
// (walls at ±half) instead of hardcoding ±6, so the layout scales with a
// rectangular room. Insets: stand-point 1.5 m inside the wall, through-point
// 1.0 m outside. Default 2×2 room ⇒ {6,6} reproduces the legacy ±6 / ±4.5 / ±7
// tables bit-for-bit. PAIR_OFFSET spaces the two doors that share a wall in the
// pairs layout — an INTEGER (was 2.7), because #91 locks every door centre to
// the grid lines (see the geometry contract below); 3.0 keeps the paired doors
// 6 m apart. The old EW_LATERAL quirk (e/w STAND points −0.5 off the door
// centre, so the avatar walked through half a metre off the visible opening)
// is retired with #91: stand === centre for every door. The stand-vs-centre
// SEAM in poseFromWall is kept — synced pairs data and future asymmetric
// layouts still speak through it.
const FRONT_INSET = 1.5;
const THROUGH_OUTSET = 1.0;
const PAIR_OFFSET = 3.0;
const HALF_PI = Math.PI / 2;

// ── 🚪 #91: THE door's physical grid contract ────────────────────────────────
// One door size (the big door — the small door is removed for now, owner
// ruling on #91), and its centre is LOCKED to the floor grid: grid lines sit
// at INTEGER world coordinates (GridHelper spans are multiples of TILE_SIZE=6;
// furniture snapAxis shares the phase), so a door centre is always an integer
// and the 2.0 m opening spans [n−1, n+1] — exactly 2 grid cells, flush on the
// lines. Every consumer (frame geometry, validators, blocking zones, aperture
// checks, the terminal wireframe) derives from THESE constants so the physical
// door and the editor's collision model can never drift apart again (the old
// 2.4/1.4 openings matched NO whole number of cells while the validators
// assumed 2/1).
/** Opening width — exactly 2 grid cells; centre on an integer grid line. */
export const DOOR_OPENING_WIDTH = 2.0;
/** Side-post width, one each side of the opening. */
export const DOOR_POST_WIDTH = 0.3;
/** Full frame width (opening + both posts) = 2.6. */
export const DOOR_FRAME_WIDTH = DOOR_OPENING_WIDTH + 2 * DOOR_POST_WIDTH;
/** One sliding leaf covers half the opening. */
export const DOOR_LEAF_WIDTH = DOOR_OPENING_WIDTH / 2;
/** Leaf-centre offset when SHUT: the two leaves meet with a 0.02 seam overlap
 *  (the old 0.62-for-2.4 / 0.37-for-1.4 literals encoded exactly this). */
export const DOOR_LEAF_SHUT_OFFSET = DOOR_LEAF_WIDTH / 2 + 0.02;
/** Leaf-centre offset when OPEN — the leaf has cleared the opening. */
export const DOOR_LEAF_OPEN_OFFSET = DOOR_LEAF_SHUT_OFFSET + DOOR_LEAF_WIDTH - 0.02;

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

/**
 * 🚪 #28 S6b / #91: snap an along-wall lateral to the floor's 1 m grid — the
 * SAME lattice furniture uses (furniture.ts snapAxis). With ONE door size whose
 * opening is an even 2 cells, the centre always lands on the integer n, i.e.
 * ON the line between two grid squares (the #91 rule). The `size` parameter is
 * kept so old records still type-check while they are read-normalized away.
 */
export function snapDoorLateral(_size: "small" | "large", lateral: number): number {
  return Math.round(lateral);
}

/**
 * 🚪 #28 S6b: the INVERSE of poseFromWall — given a clicked floor point, pick the
 * nearest wall and the along-wall lateral of that point. Distance to each wall
 * from the current room half-extents (walls at ±half): north |pz+halfZ|, south
 * |pz−halfZ|, west |px+halfX|, east |px−halfX|; the argmin wins. The lateral is
 * the point's coordinate ALONG that wall (x for n/s, z for e/w) — the raw value
 * the editor then snaps + clamps before placing a door.
 */
export function wallAndLateralFromPoint(
  px: number,
  pz: number,
): { wall: DoorWall; lateral: number } {
  const { halfX, halfZ } = roomHalfExtents();
  const dists: Array<{ wall: DoorWall; d: number }> = [
    { wall: "north", d: Math.abs(pz + halfZ) },
    { wall: "south", d: Math.abs(pz - halfZ) },
    { wall: "west", d: Math.abs(px + halfX) },
    { wall: "east", d: Math.abs(px - halfX) },
  ];
  let best = dists[0];
  for (const cand of dists) if (cand.d < best.d) best = cand;
  const lateral = best.wall === "north" || best.wall === "south" ? px : pz;
  return { wall: best.wall, lateral };
}

/** A cardinal door's fixed slot in a layout: which physical wall it sits on and
 *  its base centre/stand lateral (before any owner slide delta). */
interface DoorSlot {
  wall: PhysicalDoorId;
  centre: number;
  stand: number;
}

/** Legacy layout: the 4 doors on their own cardinal walls, centred.
 *  #91 retired the e/w −0.5 stand offset — the avatar now walks through the
 *  middle of the opening it can see. NOTE the floorPlan STORE still encodes
 *  e/w placements against a −0.5 base (floorPlanDoc LEGACY_PLACEMENTS): that
 *  is wire data and stays put; only these walk/stand points moved. */
function legacySlot(id: PhysicalDoorId): DoorSlot {
  switch (id) {
    case "north":
      return { wall: "north", centre: 0, stand: 0 };
    case "south":
      return { wall: "south", centre: 0, stand: 0 };
    case "west":
      return { wall: "west", centre: 0, stand: 0 };
    case "east":
      return { wall: "east", centre: 0, stand: 0 };
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

/**
 * 🚪↔🛰️ #28 S3: the DOOR → PORT map — which structural docking port a door
 * serves. Today doors ARE the 4 cardinal ports, so this is identity. Slice 5
 * makes it geometric: a free door resolves to the port it ALIGNS to (same wall,
 * lateral within tolerance), or stays itself when it already is a port / aligns
 * to none. Pairing + transit reads route the door through this one hop, so the
 * door↔port alignment becomes a single-function change when doors go free.
 */
export function portForDoor(doorId: PortId): PortId {
  return doorId;
}
