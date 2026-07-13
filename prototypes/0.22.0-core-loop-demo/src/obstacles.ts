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

/** Re-derive OBSTACLES from the furniture registry, mutating in place. */
export function rebuildObstacles(): void {
  OBSTACLES.length = 0;
  OBSTACLES.push(...buildObstacleList(FURNITURE));
}

rebuildObstacles();
