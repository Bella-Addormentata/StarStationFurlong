/**
 * Doors — clickable walk-through targets for the four docking ports.
 *
 * Every door defines:
 *  - enabled   : false = rendered but not walkable (the north port sits
 *                behind the fireplace wall, so it can never be approached)
 *  - front     : the walkable stand-point just inside the room in front of
 *                the doorway (outside the inflated collision AABBs, so A* +
 *                collision can reach it)
 *  - through   : a scripted point past the threshold, outside the room —
 *                reached by a scripted walk that bypasses collision and the
 *                manual-movement BOUND clamp
 *  - faceAngle : 8-way logical facing toward the door while standing at
 *                `front` (atan2(nx, nz) convention: +z=0, +x=π/2, -z=π,
 *                -x=-π/2)
 *
 * Geometry matches the door groups placed by docking.ts buildPorts().
 */

import { physicalDoorPose } from "./doorLayout";
import type { PhysicalDoorId } from "./doorLayout";
import type { DoorLayoutRecord } from "./doorLayoutDoc";

export type DoorId = PhysicalDoorId;

export interface DoorTarget {
  id: DoorId;
  enabled: boolean; // false = visible but not walkable (north/fireplace)
  front: { x: number; z: number }; // walkable stand point
  through: { x: number; z: number }; // scripted point past threshold
  faceAngle: number; // 8-way facing toward door from front
}

export const DOORS: DoorTarget[] = [
  {
    id: "north",
    enabled: false,
    front: { x: 0, z: -4.5 },
    through: { x: 0, z: -7.0 },
    faceAngle: Math.PI,
  },
  {
    id: "south",
    enabled: true,
    front: { x: 0, z: 4.5 },
    through: { x: 0, z: 7.0 },
    faceAngle: 0,
  },
  {
    id: "west",
    enabled: true,
    front: { x: -4.5, z: -0.5 },
    through: { x: -7.0, z: -0.5 },
    faceAngle: -Math.PI / 2,
  },
  {
    id: "east",
    enabled: true,
    front: { x: 4.5, z: -0.5 },
    through: { x: 7.0, z: -0.5 },
    faceAngle: Math.PI / 2,
  },
];

/**
 * 🚪↔🛰️ #28 S4: reconcile DOORS MEMBERSHIP from the synced door-layout map
 * (doorLayoutDoc). Remove doors absent from the registry, add new ones; leave
 * existing entries alone — their position is (re)set by applyDoorSlideDeltas and
 * their runtime `enabled` is owned by the room (updateNorthDoorForFireplace /
 * casino). DOORS is mutated IN PLACE — never reassigned — because it is imported
 * as a live binding across the app (world / devMenu / editMode). For the steady
 * 4-cardinal state this is a no-op, so behaviour is identical to the old literal.
 */
export function rebuildDoors(records: Map<string, DoorLayoutRecord>): void {
  for (let i = DOORS.length - 1; i >= 0; i--) {
    if (!records.has(DOORS[i].id)) DOORS.splice(i, 1);
  }
  for (const rec of records.values()) {
    if (DOORS.some((d) => d.id === rec.id)) continue; // existing — untouched
    const pose = physicalDoorPose(rec.id as DoorId, 0);
    DOORS.push({
      id: rec.id as DoorId,
      enabled: rec.enabled ?? true,
      front: { x: pose.front.x, z: pose.front.z },
      through: { x: pose.through.x, z: pose.through.z },
      faceAngle: pose.faceAngle,
    });
  }
}

/** Find a door by its id, or null when the id is unknown. */
export function findDoor(id: string): DoorTarget | null {
  for (const door of DOORS) {
    if (door.id === id) return door;
  }
  return null;
}

// ── 🧱 #66 S1: door-slide — walk targets follow the placement ────────────────
// The active room layout owns each physical wall pose; floor-plan deltas move
// that pose along its wall. `enabled` remains owned by room behavior.
/** Re-derive every door's walk points from its slide delta (0 = legacy). */
export function applyDoorSlideDeltas(deltas: Record<DoorId, number>): void {
  for (const door of DOORS) {
    const pose = physicalDoorPose(door.id, deltas[door.id] ?? 0);
    door.front.x = pose.front.x;
    door.front.z = pose.front.z;
    door.through.x = pose.through.x;
    door.through.z = pose.through.z;
    door.faceAngle = pose.faceAngle;
  }
}

/**
 * Hooks the player's door-walk sequence uses to drive the door hardware.
 * Keeps the Player decoupled from the docking system — World wires the two
 * together when it hands these hooks to navigateToDoor().
 */
export interface DoorSequenceHooks {
  /**
   * Ask the door to open. Returns false immediately when the request is
   * denied (locked port); otherwise the door starts sliding and calls
   * onOpened exactly once when fully open.
   */
  requestOpen(onOpened: () => void): boolean;
  /** Ask the door to slide closed (fire-and-forget). */
  requestClose(): void;
  /** Fired when the avatar reaches the `through` point past the threshold. */
  onThrough(): void;
  /**
   * Adapter transit branch point (T1 of issue #30), consulted right after
   * onThrough() at the THROUGH completion. Return true to walk on into the
   * docking vestibule (ADAPTER_OUT → ADAPTER_HOLD) instead of the PEEK
   * look-around; absent or false keeps the pre-T1 peek-and-return behavior
   * exactly. The hook is where the World spawns the vestibule visuals.
   */
  beginTransit?: () => boolean;
  /**
   * Fired exactly once when the avatar reaches the vestibule hold point and
   * enters ADAPTER_HOLD (T1). The room swap (leaveRoom→joinRoom) kicks off
   * here — mid-hold, behind the full-screen fade.
   */
  onAdapterHold?: () => void;
}
