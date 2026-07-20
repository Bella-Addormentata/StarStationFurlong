/**
 * Pathfinding — A* with 8-directional movement
 *
 * Grid coordinates map to world space via:
 *   worldX = (gridCol - GRID_HALF) * CELL_SIZE
 *   worldZ = (gridRow - GRID_HALF) * CELL_SIZE
 *
 * Movement costs:
 *   straight step  = 1.0
 *   diagonal step  = √2 ≈ 1.414
 *
 * The obstacle map is derived from the same AABB list used for collision
 * resolution so pathfinding never routes the player through furniture.
 */

import { OBSTACLES } from './obstacles';
import type { Box } from './obstacles';
import { roomHalfExtents, ROOM_TILE_MAX, TILE_SIZE } from './floorPlanDoc';

// ── Grid constants ────────────────────────────────────────────────────────────
/** World-space size of each grid cell (metres) */
export const CELL_SIZE = 0.5;
/** The grid is SQUARE and static — sized once to cover the largest room the
 *  envelope allows (ROOM_TILE_MAX tiles ⇒ ±MAX_HALF m walls), plus a cell of
 *  margin, so `GRID_HALF`-as-origin-offset and the `r·GRID_SIZE+c` key math
 *  stay valid on both axes for any room up to the limit. Cells outside the
 *  CURRENT room's walkable box are simply baked blocked (see rebakeWalkableGrid).
 *  Default 2×2 room: only the ±5 cells are walkable, so A* cost is unchanged. */
const MAX_HALF = (ROOM_TILE_MAX * TILE_SIZE) / 2; // 15 m at 5×5 tiles
/** Number of cells along each axis (covers ±(MAX_HALF+1) m, rounded to even). */
export const GRID_SIZE = 2 * Math.ceil((MAX_HALF + 1) / CELL_SIZE);
/** Half-extent used to convert between grid and world coordinates */
export const GRID_HALF = GRID_SIZE / 2;

// ── Obstacle AABBs (world-space, imported from shared obstacles module) ────────
// Same boxes used by the player collision resolver, so the pathfinder
// never routes the player through furniture it would collide with.

// ── Pre-baked walkable grid ────────────────────────────────────────────────────
/**
 * walkable[row][col] === true  → cell centre is free of obstacles.
 * Baked once at module load; call rebakeWalkableGrid() again whenever
 * OBSTACLES changes (rows are refilled in place, so existing references to
 * the array stay valid).
 */
export const walkable: boolean[][] = [];

/** Re-bake the walkable grid from the current OBSTACLES list, in place. */
export function rebakeWalkableGrid(): void {
  // Walkable box = 1 m inside each wall, per axis (walls at ±half ⇒ ±(half−1)).
  // Default 2×2 room: half=6 ⇒ ±5.0, exactly the legacy boundary.
  const { halfX, halfZ } = roomHalfExtents();
  const boundX = halfX - 1.0, boundZ = halfZ - 1.0;
  for (let row = 0; row < GRID_SIZE; row++) {
    const cells = walkable[row] ?? (walkable[row] = []);
    for (let col = 0; col < GRID_SIZE; col++) {
      const wx = (col - GRID_HALF + 0.5) * CELL_SIZE;
      const wz = (row - GRID_HALF + 0.5) * CELL_SIZE;
      let blocked = false;
      for (const b of OBSTACLES) {
        if (wx > b.x0 && wx < b.x1 && wz > b.z0 && wz < b.z1) {
          blocked = true;
          break;
        }
      }
      // Also mark cells outside the walkable room boundary as blocked
      if (Math.abs(wx) > boundX || Math.abs(wz) > boundZ) blocked = true;
      cells[col] = !blocked;
    }
  }
}

rebakeWalkableGrid();

// ── Coordinate conversions ────────────────────────────────────────────────────
/** Convert a world coordinate to the nearest grid column index. */
export function worldToCol(wx: number): number {
  return Math.floor(wx / CELL_SIZE + GRID_HALF);
}

/** Convert a world coordinate to the nearest grid row index. */
export function worldToRow(wz: number): number {
  return Math.floor(wz / CELL_SIZE + GRID_HALF);
}

/** Convert a grid column to its world-space X centre. */
export function colToWorld(col: number): number {
  return (col - GRID_HALF + 0.5) * CELL_SIZE;
}

/** Convert a grid row to its world-space Z centre. */
export function rowToWorld(row: number): number {
  return (row - GRID_HALF + 0.5) * CELL_SIZE;
}

// ── A* implementation ─────────────────────────────────────────────────────────
interface Node {
  row: number;
  col: number;
  g: number;   // cost from start
  h: number;   // heuristic estimate to goal
  f: number;   // g + h
  parent: Node | null;
}

const SQRT2 = Math.SQRT2;

/** Octile distance heuristic — admissible for 8-directional grids. */
function octile(dr: number, dc: number): number {
  const mn = Math.min(dr, dc);
  const mx = Math.max(dr, dc);
  return SQRT2 * mn + (mx - mn);
}

/**
 * Run A* from (startRow, startCol) to (goalRow, goalCol).
 * Returns an ordered array of world-space waypoints [{ x, z }, …] from the
 * first step after the start position up to and including the goal, or an
 * empty array when no path exists.
 */
export function findPath(
  startRow: number, startCol: number,
  goalRow:  number, goalCol:  number,
): Array<{ x: number; z: number }> {
  // Clamp goal to grid bounds
  goalRow  = Math.max(0, Math.min(GRID_SIZE - 1, goalRow));
  goalCol  = Math.max(0, Math.min(GRID_SIZE - 1, goalCol));
  startRow = Math.max(0, Math.min(GRID_SIZE - 1, startRow));
  startCol = Math.max(0, Math.min(GRID_SIZE - 1, startCol));

  if (!walkable[goalRow][goalCol]) return [];
  if (startRow === goalRow && startCol === goalCol) return [];

  const key = (r: number, c: number) => r * GRID_SIZE + c;

  const openSet  = new Map<number, Node>();
  const closedSet = new Set<number>();

  const startNode: Node = {
    row: startRow, col: startCol,
    g: 0,
    h: octile(Math.abs(goalRow - startRow), Math.abs(goalCol - startCol)),
    f: 0,
    parent: null,
  };
  startNode.f = startNode.g + startNode.h;
  openSet.set(key(startRow, startCol), startNode);

  // 8-directional neighbours
  const dirs = [
    [-1,  0, 1      ], [ 1,  0, 1      ], [ 0, -1, 1      ], [ 0,  1, 1      ],
    [-1, -1, SQRT2  ], [-1,  1, SQRT2  ], [ 1, -1, SQRT2  ], [ 1,  1, SQRT2  ],
  ] as const;

  while (openSet.size > 0) {
    // Find node with lowest f in open set
    let current: Node | null = null;
    for (const node of openSet.values()) {
      if (!current || node.f < current.f) current = node;
    }
    if (!current) break;

    const ck = key(current.row, current.col);
    openSet.delete(ck);
    closedSet.add(ck);

    // Goal reached — reconstruct path
    if (current.row === goalRow && current.col === goalCol) {
      const path: Array<{ x: number; z: number }> = [];
      let n: Node | null = current;
      while (n && (n.row !== startRow || n.col !== startCol)) {
        path.unshift({ x: colToWorld(n.col), z: rowToWorld(n.row) });
        n = n.parent;
      }
      return path;
    }

    for (const [dr, dc, cost] of dirs) {
      const nr = current.row + dr;
      const nc = current.col + dc;
      if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) continue;
      if (!walkable[nr][nc]) continue;

      // For diagonal moves, require both cardinal neighbours to be walkable
      // (prevents cutting through obstacle corners)
      if (dr !== 0 && dc !== 0) {
        if (!walkable[current.row + dr][current.col] ||
            !walkable[current.row][current.col + dc]) continue;
      }

      const nk = key(nr, nc);
      if (closedSet.has(nk)) continue;

      const tentativeG = current.g + cost;

      const existing = openSet.get(nk);
      if (existing && tentativeG >= existing.g) continue;

      const h = octile(Math.abs(goalRow - nr), Math.abs(goalCol - nc));
      const node: Node = {
        row: nr, col: nc,
        g: tentativeG,
        h,
        f: tentativeG + h,
        parent: current,
      };

      openSet.set(nk, node);
    }
  }

  return []; // no path found
}

// ── Scratch-grid reachability (E3 of #25 — move-furniture connectivity gate) ──

/**
 * Flood-fill reachability over a SCRATCH grid baked from the given obstacle
 * list — the helper the edit-room plan promised for E3 validity (§2.4).
 * Entirely side-effect free: the real `walkable` grid is untouched, so a
 * candidate furniture layout can be probed without committing it.
 *
 * The scratch bake uses the exact rebakeWalkableGrid() rules (cell-centre
 * containment + the ±5.0 room boundary) and the flood fill expands with the
 * same 8-directional + corner-cut rule as findPath (a diagonal step requires
 * both flanking cardinal cells to be walkable), so "reachable" here means
 * precisely "A* could route there".
 *
 * Returns reachable[row][col], flooded from the cell containing
 * (startX, startZ). When the start cell itself is blocked in the scratch
 * grid, every cell reads unreachable.
 */
export function computeReachable(
  obstacles: readonly Box[],
  startX: number,
  startZ: number,
): boolean[][] {
  // Bake the scratch walkable grid (same rules as rebakeWalkableGrid).
  const { halfX, halfZ } = roomHalfExtents();
  const boundX = halfX - 1.0, boundZ = halfZ - 1.0;
  const scratch: boolean[][] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const cells: boolean[] = [];
    for (let col = 0; col < GRID_SIZE; col++) {
      const wx = (col - GRID_HALF + 0.5) * CELL_SIZE;
      const wz = (row - GRID_HALF + 0.5) * CELL_SIZE;
      let blocked = false;
      for (const b of obstacles) {
        if (wx > b.x0 && wx < b.x1 && wz > b.z0 && wz < b.z1) {
          blocked = true;
          break;
        }
      }
      if (Math.abs(wx) > boundX || Math.abs(wz) > boundZ) blocked = true;
      cells.push(!blocked);
    }
    scratch.push(cells);
  }

  const reachable: boolean[][] = scratch.map((row) => row.map(() => false));
  const startRow = Math.max(0, Math.min(GRID_SIZE - 1, worldToRow(startZ)));
  const startCol = Math.max(0, Math.min(GRID_SIZE - 1, worldToCol(startX)));
  if (!scratch[startRow][startCol]) return reachable;

  const dirs = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ] as const;

  reachable[startRow][startCol] = true;
  const stack: Array<[number, number]> = [[startRow, startCol]];
  while (stack.length > 0) {
    const [r, c] = stack.pop()!;
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) continue;
      if (!scratch[nr][nc] || reachable[nr][nc]) continue;
      // Corner-cut rule (mirrors findPath): a diagonal expansion needs both
      // flanking cardinal cells walkable.
      if (dr !== 0 && dc !== 0 && (!scratch[r + dr][c] || !scratch[r][c + dc])) continue;
      reachable[nr][nc] = true;
      stack.push([nr, nc]);
    }
  }
  return reachable;
}
