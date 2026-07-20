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

import { FURNITURE, buildSeatList, isBridgeClick } from './furniture';
import { GRID_SIZE, walkable, worldToCol, worldToRow } from './pathfinding';

export interface Seat {
  id: string;
  clickBox: { x0: number; z0: number; x1: number; z1: number };
  front: { x: number; z: number };
  /** 🌉 Optional scripted walk waypoints between `front` and the seat (the
   *  hot-tub footbridge): walked with the walk pose, y snapping to each
   *  point's deck height; reversed on stand-up. */
  path?: Array<{ x: number; y: number; z: number }>;
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

/** Find the seat whose click box contains the world-space floor point.
 *
 *  Priority (NOT plain list order): the pool's swim clickBoxes blanket the
 *  entire water surface — including the hot-tub island and its footbridge —
 *  and the pool item precedes the hot tub in FURNITURE order, so a single
 *  first-hit pass would route every tub/bridge click into a wade-in swim.
 *  1. solid seats (chairs, loungers, bunks, the hot tub, the dive board)
 *  2. 🌉 the footbridge deck → the tub's southmost seat (facing the bridge)
 *  3. open-water swim seats
 */
export function findSeatAt(x: number, z: number): Seat | null {
  const inBox = (seat: Seat) => {
    const b = seat.clickBox;
    return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
  };
  for (const seat of SEATS) {
    if (!seat.swim && inBox(seat)) return seat;
  }
  if (isBridgeClick(FURNITURE, x, z)) {
    let best: Seat | null = null;
    for (const seat of SEATS) {
      if (!seat.id.startsWith('pool-hot-tub:')) continue;
      if (!best || seat.sit.z > best.sit.z) best = seat;
    }
    if (best) return best;
  }
  for (const seat of SEATS) {
    if (seat.swim && inBox(seat)) return seat;
  }
  return null;
}
