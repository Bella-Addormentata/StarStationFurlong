import { roomHalfExtents } from "./floorPlanDoc";
import type { DoorWall } from "./doorLayoutDoc";

export type PhysicalDoorId = "north" | "south" | "east" | "west";

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

/** 🚪 The cardinal/free split in one predicate. It no longer decides where a
 *  door IS — every door poses from its own layout record now — but the 4
 *  cardinal ids are still the structural berths: the floorPlan slide store and
 *  the pairing wire are keyed on them. #91 hoisted this here — docking.ts and
 *  editMode.ts each had a private copy and world.ts/main.ts had none, which is
 *  how free door ids kept reaching cardinal-only code and throwing. */
export function isCardinalDoorId(id: string): id is PhysicalDoorId {
  return id === "north" || id === "south" || id === "east" || id === "west";
}

// 🧱 #66 R1 + #28 S1: door/port poses DERIVE from the room's half-extents
// (walls at ±half) instead of hardcoding ±6, so the layout scales with a
// rectangular room. Insets: stand-point 1.5 m inside the wall, through-point
// 1.0 m outside. Default 2×2 room ⇒ {6,6} reproduces the legacy ±6 / ±4.5 / ±7
// tables bit-for-bit. The old EW_LATERAL quirk (e/w STAND points −0.5 off the
// door centre, so the avatar walked through half a metre off the visible
// opening) is retired with #91: stand === centre for every door. The
// stand-vs-centre SEAM in poseFromWall is kept — synced data and future
// asymmetric openings still speak through it.
const FRONT_INSET = 1.5;
const THROUGH_OUTSET = 1.0;
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
 * For every clean door `standLateral === centreLateral`. This is now THE pose
 * generator for every door in the room, cardinal or free.
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

/**
 * 🚪 The room's live door records, pushed here by world.reconcileDoorLayout —
 * which already receives exactly this map (stored records, or the room's
 * defaults when unseeded) on bind and on every door change, so there is no new
 * subscription and no import cycle back into the doc layer.
 *
 * This replaces the module global that used to hold a LAYOUT KIND. That global
 * was the whole reason a "casino door" was a different thing from a regular
 * door: `physicalDoorPose` switched on it to pick one of two four-slot tables,
 * which can express neither an empty wall nor a wall with three doors on it.
 * A record per door expresses both, and one code path serves every door.
 */
let doorRecords: ReadonlyMap<string, { wall: PhysicalDoorId; lateral: number }> =
  new Map();

export function setDoorRecords(
  records: ReadonlyMap<string, { wall: PhysicalDoorId; lateral: number }>,
): void {
  doorRecords = records;
}

/**
 * Where a door physically is: its own record's wall and base lateral, plus the
 * owner's floor-plan slide passed in by the caller.
 *
 * Before a room's first reconcile the map is empty — reachable only at boot,
 * when docking.buildPorts constructs the four berths before any room is
 * entered. The fallback poses a cardinal centred on its own wall, which is
 * exactly what the retired global's "legacy" default produced there, so boot
 * geometry is unchanged.
 */
export function physicalDoorPose(
  // `string`, not PhysicalDoorId: free `d:` ids already reach here through
  // casts at the call sites, so the narrow type was advertising a guarantee it
  // did not have. Widening it makes the guard below the real contract.
  id: string,
  lateralDelta = 0,
): PhysicalDoorPose {
  return physicalDoorPoseOrNull(id, lateralDelta) ?? fallbackPose(id);
}

/**
 * 🚪 The same lookup, but honest about a miss: `null` means "this client does
 * not know where that door is", which is a real state and NOT the same as "it
 * is on the north wall". Callers that would otherwise make a decision from a
 * guessed pose — module-overlap clash tests, exterior projections of a FAR
 * room's door — must use this and degrade permissively, because a confident
 * wrong answer there refuses a legitimate dock or draws a module in the wrong
 * place. Callers that only need *some* pose to render local scenery can keep
 * using physicalDoorPose.
 */
export function physicalDoorPoseOrNull(
  id: string,
  lateralDelta = 0,
): PhysicalDoorPose | null {
  const rec = doorRecords.get(id);
  if (rec) {
    const lateral = rec.lateral + lateralDelta;
    return poseFromWall(rec.wall, lateral, lateral);
  }
  // No record. A CARDINAL id is still self-describing — it names its own wall,
  // which is what the retired layout global's "legacy" default produced at boot
  // before any room is entered, so that path stays bit-identical.
  if (isCardinalDoorId(id)) return poseFromWall(id, lateralDelta, lateralDelta);
  return null;
}

/**
 * 🚪 TOTALITY GUARD. `poseFromWall`'s switch has no `default` arm — deliberately,
 * so the compiler proves every legitimate caller passes a doc-validated wall —
 * which means handing it a door ID that is not a wall name returns `undefined`
 * and the first property read throws.
 *
 * That is reachable: a free `d:` id belonging to a room this client is not in
 * (a far room's door, or a key gossiped by a peer) is absent from the record
 * snapshot, and the old `rec?.wall ?? id` fell straight through to
 * `poseFromWall("d:abc", …)`. The blast radius is the whole exterior render,
 * per frame, from a value that persists in localStorage — so it must degrade,
 * loudly, not crash.
 */
const warnedUnknownDoors = new Set<string>();
function fallbackPose(id: string): PhysicalDoorPose {
  if (!warnedUnknownDoors.has(id)) {
    warnedUnknownDoors.add(id);
    console.warn(
      `[doorLayout] no pose for door "${id}" — it is not a cardinal and has no ` +
        `record in this room. Rendering it at the north wall centre. This is a ` +
        `bug in whatever supplied the id, not in the door.`,
    );
  }
  return poseFromWall("north", 0, 0);
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
