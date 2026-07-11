/**
 * Seats — clickable sit targets derived from the lobby furniture.
 *
 * Every seat defines:
 *  - clickBox   : world-space XZ box; a floor click inside it selects the seat
 *  - front      : the walkable stand-point at the front of the seat (outside
 *                 the inflated collision AABBs, so A* + collision can reach it)
 *  - sit        : where the avatar's root rests while seated (inside the
 *                 furniture footprint — reached by a scripted slide that
 *                 bypasses collision)
 *  - faceAngle  : logical facing while seated — the avatar's BACK is toward
 *                 the backrest (atan2(nx, nz) convention: +z=0, +x=π/2,
 *                 -z=π, -x=-π/2)
 *
 * Geometry matches the furniture AABBs in obstacles.ts / world.ts.
 */

export interface Seat {
  id: string;
  clickBox: { x0: number; z0: number; x1: number; z1: number };
  front: { x: number; z: number };
  sit: { x: number; z: number };
  faceAngle: number;
}

const SEATS: Seat[] = [];

// ── Left-wall armchairs ×4 (backrest at the wall, facing +x) ─────────────────
[-3.5, -1.5, 0.5, 2.5].forEach((z, i) => {
  SEATS.push({
    id: `armchair-left-${i}`,
    clickBox: { x0: -5.00, z0: z - 0.5, x1: -4.00, z1: z + 0.5 },
    front: { x: -3.50, z },
    sit: { x: -4.50, z },
    faceAngle: Math.PI / 2,
  });
});

// ── Right-wall armchairs ×4 (facing -x) ──────────────────────────────────────
[-3.5, -1.5, 0.5, 2.5].forEach((z, i) => {
  SEATS.push({
    id: `armchair-right-${i}`,
    clickBox: { x0: 4.00, z0: z - 0.5, x1: 5.00, z1: z + 0.5 },
    front: { x: 3.50, z },
    sit: { x: 4.50, z },
    faceAngle: -Math.PI / 2,
  });
});

// ── Back 3-seater sofa (z=-1.5, facing +z) ───────────────────────────────────
(
  [
    { x: -1.0, x0: -1.50, x1: -0.50 },
    { x: 0.0, x0: -0.50, x1: 0.50 },
    { x: 1.0, x0: 0.50, x1: 1.50 },
  ] as const
).forEach((c, i) => {
  SEATS.push({
    id: `sofa-back-${i}`,
    clickBox: { x0: c.x0, z0: -2.00, x1: c.x1, z1: -1.00 },
    front: { x: c.x, z: -0.50 },
    sit: { x: c.x, z: -1.50 },
    faceAngle: 0,
  });
});

// ── Front 3-seater sofa (z=+3.5, facing -z) ──────────────────────────────────
SEATS.push({
  id: 'sofa-front-left',
  clickBox: { x0: -1.50, z0: 3.00, x1: 0.0, z1: 4.00 },
  front: { x: -2.00, z: 3.50 },
  sit: { x: -1.00, z: 3.50 },
  faceAngle: Math.PI,
});
SEATS.push({
  id: 'sofa-front-right',
  clickBox: { x0: 0.0, z0: 3.00, x1: 1.50, z1: 4.00 },
  front: { x: 2.00, z: 3.50 },
  sit: { x: 1.00, z: 3.50 },
  faceAngle: Math.PI,
});

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
