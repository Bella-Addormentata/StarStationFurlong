/**
 * 🏙️ What the isometric room view shows around the room (owner request): the
 * tubes on its doors and the modules they lead to.
 *
 *  - FAR side: the tubes and the adjacent modules behind the room, and those
 *    off to its sides, are drawn solid. They never cover the room.
 *  - NEAR side: anything that stands between the camera and the room stays
 *    see-through, so it never hides the room. A near tube the pointer rests on
 *    (out past the floor grid, where clicks on it already walk you through)
 *    shows half solid, and goes solid once you walk through it.
 *  - Entering a room shows everything solid for a moment (while the swap and
 *    the walk-in run, and a little after), then the near side fades away.
 *
 * Pure: world.ts feeds it boxes and the camera's direction; the tests pin it.
 */

/** A point on the ground, in the current room's frame (room centre at 0). */
export interface XZPoint {
  x: number;
  z: number;
}

/** The current room's floor half-extents (floorPlanDoc.roomHalfExtents). */
export interface RoomHalf {
  halfX: number;
  halfZ: number;
}

/** A unit direction on the ground, from the room centre toward the camera. */
export interface CamDir {
  x: number;
  z: number;
}

/** How solid a near tube shows while the pointer rests on it. */
export const HOVER_OPACITY = 0.5;

/** How long the room-entry reveal holds everything solid once the arrival
 *  (the swap's curtain, the walk-in) is over, before the near side fades. */
export const REVEAL_HOLD_MS = 1500;

/** Tolerance (m) at the room's screen edges: a box that only touches the
 *  room's outline on screen (a tube on a side wall, say) does not cover it. */
const SCREEN_MARGIN = 0.25;

/** The iso camera's ground direction for a rig yaw: the same direction the
 *  octagon hull's cutaway and the #51 door fade use (base offset (+x, +z),
 *  turned by the 45° detents). */
export function isoCameraDir(yaw: number): CamDir {
  return {
    x: (Math.cos(yaw) + Math.sin(yaw)) * Math.SQRT1_2,
    z: (Math.cos(yaw) - Math.sin(yaw)) * Math.SQRT1_2,
  };
}

/** The four corners of an axis-aligned box on the ground (a tube's bounds). */
export function boxCorners(minX: number, maxX: number, minZ: number, maxZ: number): XZPoint[] {
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}

/**
 * Does something outside the room stand between the iso camera and the room?
 * `corners` outline its footprint on the ground (a module's turned floor box,
 * a tube's bounds). True when the footprint's centre lies on the camera's
 * side of the room AND it overlaps the room across the screen. The camera is
 * orthographic, so "across the screen" is the ground axis square to the
 * camera's direction; anything out to the side of the room on that axis
 * never covers it, however tall.
 */
export function blocksRoomView(corners: readonly XZPoint[], room: RoomHalf, cam: CamDir): boolean {
  if (corners.length === 0) return false;
  let cx = 0;
  let cz = 0;
  for (const c of corners) {
    cx += c.x;
    cz += c.z;
  }
  cx /= corners.length;
  cz /= corners.length;
  if (cx * cam.x + cz * cam.z <= 0) return false; // behind the room, or square to it
  const sx = cam.z;
  const sz = -cam.x;
  const reach = room.halfX * Math.abs(sx) + room.halfZ * Math.abs(sz);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of corners) {
    const s = c.x * sx + c.z * sz;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  return hi > -reach + SCREEN_MARGIN && lo < reach - SCREEN_MARGIN;
}

/** A module's ground footprint from its atlas pose: the four corners of its
 *  floor box (the octagon's widest point), turned with the module, so a
 *  module set at 45° is measured by its own outline, not a box around it. */
export function poseFootprint(
  pose: { x: number; z: number; rotY: number },
  half: RoomHalf,
): XZPoint[] {
  const cos = Math.cos(pose.rotY);
  const sin = Math.sin(pose.rotY);
  // three.js's rotation.y: local (x, z) → (x·cos + z·sin, −x·sin + z·cos).
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) => {
    const lx = sx * half.halfX;
    const lz = sz * half.halfZ;
    return { x: pose.x + lx * cos + lz * sin, z: pose.z - lx * sin + lz * cos };
  });
}

/**
 * The opacity a paired door's tube aims for in the iso room view.
 * `proximity` is the existing fade from the player's distance to the door
 * (see world.ts's VESTIBULE_FADE_RANGE); `crossing` is a walk-through or
 * transit on this door.
 */
export function isoVestibuleTarget(o: {
  blocks: boolean;
  revealing: boolean;
  crossing: boolean;
  hovered: boolean;
  proximity: number;
}): number {
  if (!o.blocks || o.revealing || o.crossing) return 1;
  return Math.max(o.proximity, o.hovered ? HOVER_OPACITY : 0);
}

/** The opacity an adjacent module aims for in the iso room view. */
export function isoModuleTarget(o: { blocks: boolean; revealing: boolean }): number {
  return !o.blocks || o.revealing ? 1 : 0;
}

/**
 * The room-entry reveal: on while the arrival is still going on (the room
 * swap's curtain, the walk-in through the arrival door) and for
 * REVEAL_HOLD_MS after it ends; then off until the next entry.
 */
export class EntryReveal {
  private on = false;
  private busy = false;
  private holdUntil = -Infinity;

  /** A room was just entered at `now` (ms). */
  start(now: number): void {
    this.on = true;
    this.busy = false;
    this.holdUntil = now + REVEAL_HOLD_MS;
  }

  /** Stop at once (the view left the room, say). */
  cancel(): void {
    this.on = false;
    this.busy = false;
  }

  /** Whether the reveal is on at `now`. `busy` = the arrival is still going
   *  on; while it is, the reveal stays on however long a frame takes (a join
   *  can stall the page), and the hold counts from the first frame that sees
   *  it over (frames paused in a background tab don't eat the hold). Only a
   *  reveal already on is held: a door walk later in the visit starts nothing. */
  update(now: number, busy: boolean): boolean {
    if (!this.on) return false;
    if (busy) {
      this.busy = true;
      return true;
    }
    if (this.busy) {
      this.busy = false;
      this.holdUntil = now + REVEAL_HOLD_MS;
    }
    if (now > this.holdUntil) this.on = false;
    return this.on;
  }
}
