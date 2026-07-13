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

export type DoorId = 'north' | 'south' | 'east' | 'west';

export interface DoorTarget {
  id: DoorId;
  enabled: boolean;            // false = visible but not walkable (north/fireplace)
  front:   { x: number; z: number };   // walkable stand point
  through: { x: number; z: number };   // scripted point past threshold
  faceAngle: number;           // 8-way facing toward door from front
}

export const DOORS: DoorTarget[] = [
  { id: 'north', enabled: false, front: { x: 0,    z: -4.5 }, through: { x: 0,    z: -7.0 }, faceAngle: Math.PI },
  { id: 'south', enabled: true,  front: { x: 0,    z:  4.5 }, through: { x: 0,    z:  7.0 }, faceAngle: 0 },
  { id: 'west',  enabled: true,  front: { x: -4.5, z: -0.5 }, through: { x: -7.0, z: -0.5 }, faceAngle: -Math.PI / 2 },
  { id: 'east',  enabled: true,  front: { x:  4.5, z: -0.5 }, through: { x:  7.0, z: -0.5 }, faceAngle:  Math.PI / 2 },
];

/** Find a door by its id, or null when the id is unknown. */
export function findDoor(id: string): DoorTarget | null {
  for (const door of DOORS) {
    if (door.id === id) return door;
  }
  return null;
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
}
