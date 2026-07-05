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

// ── Left-wall armchairs ×5 (backrest at the wall, facing +x) ─────────────────
// Obstacle strip x -4.82..-3.78 inflates to x ≤ -3.40; front points sit at
// x = -3.30 so the approach never fights the collision resolver.
[-3.8, -2.4, -1.0, 0.4, 1.8].forEach((z, i) => {
  SEATS.push({
    id: `armchair-left-${i}`,
    clickBox: { x0: -4.82, z0: z - 0.7, x1: -3.78, z1: z + 0.7 },
    front: { x: -3.30, z },
    sit: { x: -4.3, z },
    faceAngle: Math.PI / 2,
  });
});

// ── Right-wall armchairs ×5 (facing -x) ──────────────────────────────────────
[-3.8, -2.4, -1.0, 0.4, 1.8].forEach((z, i) => {
  SEATS.push({
    id: `armchair-right-${i}`,
    clickBox: { x0: 3.78, z0: z - 0.7, x1: 4.82, z1: z + 0.7 },
    front: { x: 3.30, z },
    sit: { x: 4.3, z },
    faceAngle: -Math.PI / 2,
  });
});

// ── Back 3-seater sofa (z=-1.5, facing +z) ───────────────────────────────────
// Sofa inflates to z ≤ -0.50; front points at z = -0.40.
(
  [
    { x: -0.72, x0: -1.50, x1: -0.36 },
    { x: 0.0, x0: -0.36, x1: 0.36 },
    { x: 0.72, x0: 0.36, x1: 1.50 },
  ] as const
).forEach((c, i) => {
  SEATS.push({
    id: `sofa-back-${i}`,
    clickBox: { x0: c.x0, z0: -2.12, x1: c.x1, z1: -0.88 },
    front: { x: c.x, z: -0.40 },
    sit: { x: c.x, z: -1.5 },
    faceAngle: 0,
  });
});

// ── Front 3-seater sofa (z=+3.2, facing -z) ──────────────────────────────────
// The coffee table blocks a straight frontal approach (no walkable gap
// between the inflated table and sofa boxes), so the two outer cushions are
// approached from the open sides — mirroring the old NPC sit-zone design.
// The middle cushion is intentionally not clickable.
SEATS.push({
  id: 'sofa-front-left',
  clickBox: { x0: -1.5, z0: 2.58, x1: 0.0, z1: 3.82 },
  front: { x: -2.0, z: 2.85 },
  sit: { x: -0.72, z: 3.2 },
  faceAngle: Math.PI,
});
SEATS.push({
  id: 'sofa-front-right',
  clickBox: { x0: 0.0, z0: 2.58, x1: 1.5, z1: 3.82 },
  front: { x: 2.0, z: 2.85 },
  sit: { x: 0.72, z: 3.2 },
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
