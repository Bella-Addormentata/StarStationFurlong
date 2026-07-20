/**
 * Seats — clickable sit targets DERIVED from the furniture registry
 * (SeatTemplates on each FurnitureDef; see furniture.ts).
 *
 * Every seat defines:
 *  - clickBox   : world-space XZ box; a floor click inside it selects the seat
 *  - front      : the walkable stand-point at the front of the seat (outside
 *                 the inflated collision AABBs, so A* + collision can reach it).
 *                 Computed: the template's preferred front offset is used
 *                 exactly when its grid cell is walkable, otherwise the
 *                 nearest walkable cell around the footprint is substituted
 *                 (generalises the hand-tuned front-sofa side approaches).
 *  - sit        : where the avatar's root rests while seated (inside the
 *                 furniture footprint — reached by a scripted slide that
 *                 bypasses collision)
 *  - faceAngle  : logical facing while seated — the avatar's BACK is toward
 *                 the backrest (atan2(nx, nz) convention: +z=0, +x=π/2,
 *                 -z=π, -x=-π/2)
 *
 * SEATS keeps its array identity: rebuildSeats() refills it in place, so it
 * stays in sync after obstacle/grid rebuilds (call order: rebuildObstacles →
 * rebakeWalkableGrid → rebuildSeats).
 */

import { FURNITURE, buildSeatList } from './furniture';
import { GRID_SIZE, walkable, worldToCol, worldToRow } from './pathfinding';

export interface Seat {
  id: string;
  clickBox: { x0: number; z0: number; x1: number; z1: number };
  front: { x: number; z: number };
  sit: { x: number; z: number };
  faceAngle: number;
  /** 🛏️ Avatar-root height while on the seat (bunk mattress tops); 0 = floor. */
  sitY: number;
  /** 🛏️ true ⇒ occupant lies down (rig 'sleep' pose) instead of sitting. */
  lie: boolean;
  /** 🏊 true ⇒ occupant renders the 'swim' pose (pool water seat). */
  swim: boolean;
  /** 🏊‍♂️ true ⇒ high-dive launch pad (click pool water → parabolic dive). */
  dive: boolean;
}

export const SEATS: Seat[] = [];

/** Re-derive SEATS from the furniture registry + current walkable grid. */
export function rebuildSeats(): void {
  SEATS.length = 0;
  SEATS.push(...buildSeatList(FURNITURE, (x, z) => {
    const row = worldToRow(z);
    const col = worldToCol(x);
    return row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE && walkable[row][col];
  }));
}

rebuildSeats();

/** Find the seat whose click box contains the world-space floor point. */
export function findSeatAt(x: number, z: number): Seat | null {
  for (const seat of SEATS) {
    const b = seat.clickBox;
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) {
      return seat;
    }
  }
  return null;
}
