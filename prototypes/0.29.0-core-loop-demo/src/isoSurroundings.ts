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

/** A footprint on the ground, in the current room's frame (room centre at 0). */
export interface XZBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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

/**
 * Does something outside the room stand between the iso camera and the room?
 * True when the box's centre lies on the camera's side of the room AND the box
 * overlaps the room across the screen. The camera is orthographic, so "across
 * the screen" is the ground axis square to the camera's direction; anything
 * out to the side of the room on that axis never covers it, however tall.
 */
export function blocksRoomView(box: XZBox, room: RoomHalf, cam: CamDir): boolean {
  const cx = (box.minX + box.maxX) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  if (cx * cam.x + cz * cam.z <= 0) return false; // behind the room, or square to it
  const sx = cam.z;
  const sz = -cam.x;
  const reach = room.halfX * Math.abs(sx) + room.halfZ * Math.abs(sz);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [box.minX, box.maxX]) {
    for (const z of [box.minZ, box.maxZ]) {
      const s = x * sx + z * sz;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
  }
  return hi > -reach + SCREEN_MARGIN && lo < reach - SCREEN_MARGIN;
}

/** A module's ground footprint from its atlas pose: centre, heading and floor
 *  half-extents (the octagon's widest point is its floor box). */
export function poseFootprint(
  pose: { x: number; z: number; rotY: number },
  half: RoomHalf,
): XZBox {
  const cos = Math.cos(pose.rotY);
  const sin = Math.sin(pose.rotY);
  // three.js turns +x toward −z for a positive rotation.y.
  const ex = Math.abs(half.halfX * cos) + Math.abs(half.halfZ * sin);
  const ez = Math.abs(half.halfX * sin) + Math.abs(half.halfZ * cos);
  return { minX: pose.x - ex, maxX: pose.x + ex, minZ: pose.z - ez, maxZ: pose.z + ez };
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
  private holdUntil = -Infinity;

  /** A room was just entered at `now` (ms). */
  start(now: number): void {
    this.on = true;
    this.holdUntil = now + REVEAL_HOLD_MS;
  }

  /** Stop at once (the view left the room, say). */
  cancel(): void {
    this.on = false;
  }

  /** Whether the reveal is on at `now`. `busy` = the arrival is still going
   *  on; while it is, the reveal stays on however long a frame takes (a join
   *  can stall the page), and the hold counts from its end. Only a reveal
   *  already on is held: a door walk later in the visit starts nothing. */
  update(now: number, busy: boolean): boolean {
    if (!this.on) return false;
    if (busy) {
      this.holdUntil = now + REVEAL_HOLD_MS;
      return true;
    }
    if (now > this.holdUntil) this.on = false;
    return this.on;
  }
}
