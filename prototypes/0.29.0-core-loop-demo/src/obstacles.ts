/**
 * Shared obstacle AABB list (XZ plane) — DERIVED from the furniture registry.
 *
 * OBSTACLES keeps its original export shape (a mutable array constant) so
 * consumers (player.ts collision resolver, pathfinding.ts grid bake) need no
 * import changes; rebuildObstacles() mutates it in place whenever the
 * furniture layout changes.
 *
 * All boxes are aligned to the modular 1.0m grid system. Room boundaries are
 * [-6.0, 6.0]; boundary walls stay implicit (enforced by pathfinding bounds
 * and the player BOUND clamp), exactly as before.
 */
import { FURNITURE, buildObstacleList } from './furniture';
import type { Box } from './furniture';

export type { Box };

export const OBSTACLES: Box[] = [];

/** Collision radius — the player's collision resolver (player.ts) keeps this
 *  far from every box; exported for the E3 move-furniture player-overlap
 *  check. */
export const PLAYER_R = 0.38;

/**
 * 🧍 #345: whether a player can stand right at (x, z): their collision
 * radius clear of every box, as the collision resolver (player.ts) allows.
 * The walk grid promises less (cell centres against the raw boxes): a spot
 * in a free cell can be 0.38 m or less from a box behind it, and a player
 * sent there stops short.
 */
export function playerFitsAt(x: number, z: number, boxes: readonly Box[] = OBSTACLES): boolean {
  return boxes.every(
    (b) => !(x > b.x0 - PLAYER_R && x < b.x1 + PLAYER_R && z > b.z0 - PLAYER_R && z < b.z1 + PLAYER_R),
  );
}

/** Re-derive OBSTACLES from the furniture registry, mutating in place. */
export function rebuildObstacles(): void {
  OBSTACLES.length = 0;
  OBSTACLES.push(...buildObstacleList(FURNITURE));
}

rebuildObstacles();
