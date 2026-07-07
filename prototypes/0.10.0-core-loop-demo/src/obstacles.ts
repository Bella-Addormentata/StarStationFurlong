/**
 * Shared obstacle AABB list (XZ plane).
 * All items are perfectly aligned to the modular 1.0m grid system.
 * Room boundaries are [-6.0, 6.0], with grid squares aligned to whole integers.
 */
export interface Box { x0: number; z0: number; x1: number; z1: number }

export const OBSTACLES: Box[] = [
  // Fireplace / bookcase wall (covers 10x1 tiles at the very back)
  { x0: -5.00, z0: -6.00, x1:  5.00, z1: -5.00 },
  
  // Back 3-seater sofa (spans exactly 3x1 tiles: x in [-1.5, 1.5], z in [-2.0, -1.0])
  { x0: -1.50, z0: -2.00, x1:  1.50, z1: -1.00 },
  
  // Front 3-seater sofa (spans exactly 3x1 tiles: x in [-1.5, 1.5], z in [3.0, 4.0])
  { x0: -1.50, z0:  3.00, x1:  1.50, z1:  4.00 },
  
  // Left-wall armchairs (4 single 1x1 tiles spaced by 1 empty tile at x=-4.5)
  { x0: -5.00, z0: -4.00, x1: -4.00, z1: -3.00 },
  { x0: -5.00, z0: -2.00, x1: -4.00, z1: -1.00 },
  { x0: -5.00, z0:  0.00, x1: -4.00, z1:  1.00 },
  { x0: -5.00, z0:  2.00, x1: -4.00, z1:  3.00 },
  
  // Right-wall armchairs (4 single 1x1 tiles spaced by 1 empty tile at x=4.5)
  { x0:  4.00, z0: -4.00, x1:  5.00, z1: -3.00 },
  { x0:  4.00, z0: -2.00, x1:  5.00, z1: -1.00 },
  { x0:  4.00, z0:  0.00, x1:  5.00, z1:  1.00 },
  { x0:  4.00, z0:  2.00, x1:  5.00, z1:  3.00 },
  
  // Coffee table — back zone (spans exactly 2x1 tiles: x in [-1.0, 1.0], z in [-4.0, -3.0])
  { x0: -1.00, z0: -4.00, x1:  1.00, z1: -3.00 },
  
  // Coffee table — front zone (spans exactly 2x1 tiles: x in [-1.0, 1.0], z in [1.0, 2.0])
  { x0: -1.00, z0:  1.00, x1:  1.00, z1:  2.00 },
  
  // Bar cabinet + stools (spans exactly 1x2 tiles in the corner: x in [4.0, 5.0], z in [3.0, 5.0])
  { x0:  4.00, z0:  3.00, x1:  5.00, z1:  5.00 },
  
  // Corner Lamp tables (single 1x1 tiles)
  { x0: -5.00, z0: -5.00, x1: -4.00, z1: -4.00 }, // Back-L
  { x0:  4.00, z0: -5.00, x1:  5.00, z1: -4.00 }, // Back-R
  { x0: -5.00, z0:  3.00, x1: -4.00, z1:  4.00 }, // Front-L
  { x0:  4.00, z0:  4.00, x1:  5.00, z1:  5.00 }, // Front-R (adjacent to bar)
];
