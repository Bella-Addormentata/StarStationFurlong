/**
 * Shared obstacle AABB list (XZ plane).
 *
 * These boxes represent the furniture footprints used for both collision
 * resolution (player, NPC) and pathfinding.  Keeping a single source of
 * truth prevents the three systems from drifting out of sync.
 */
export interface Box { x0: number; z0: number; x1: number; z1: number }

export const OBSTACLES: Box[] = [
  // Fireplace / bookcase wall (full width, front face z≈-5.55, depth 0.46)
  { x0: -5.00, z0: -5.95, x1:  5.00, z1: -5.08 },
  // Back 3-seater sofa (seat centre 0, -1.5 — size 2.4 × 0.96)
  { x0: -1.50, z0: -2.12, x1:  1.50, z1: -0.88 },
  // Front 3-seater sofa (seat centre 0, +3.2)
  { x0: -1.50, z0:  2.58, x1:  1.50, z1:  3.82 },
  // Left-wall armchairs × 5 merged (x=-4.3, z=-3.8/−2.4/−1.0/0.4/1.8)
  { x0: -4.82, z0: -4.32, x1: -3.78, z1:  2.32 },
  // Right-wall armchairs × 5 merged (x=+4.3)
  { x0:  3.78, z0: -4.32, x1:  4.82, z1:  2.32 },
  // Coffee table — back zone (centre 0, -3.3  size 1.6 × 0.9)
  { x0: -0.94, z0: -3.82, x1:  0.94, z1: -2.78 },
  // Coffee table — front zone (centre 0, +1.5  size 1.6 × 0.9)
  { x0: -0.94, z0:  1.02, x1:  0.94, z1:  1.98 },
  // Bar cabinet + stools (x≈5.24, z≈3.10, body 0.58 × 2.80 + stools)
  { x0:  4.48, z0:  1.48, x1:  5.92, z1:  4.72 },
  // Lamp table back-L (centre -4.3, -4.7)
  { x0: -4.62, z0: -5.02, x1: -3.98, z1: -4.38 },
  // Lamp table back-R (centre +4.3, -4.7)
  { x0:  3.98, z0: -5.02, x1:  4.62, z1: -4.38 },
  // Lamp table front-L (centre -3.8, +3.2)
  { x0: -4.12, z0:  2.88, x1: -3.48, z1:  3.52 },
  // Lamp table front-R (centre +3.8, +3.2)
  { x0:  3.48, z0:  2.88, x1:  4.12, z1:  3.52 },
];
