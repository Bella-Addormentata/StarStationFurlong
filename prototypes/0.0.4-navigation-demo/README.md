# StarStation Furlong: Navigation Demo

This prototype builds on `03-character-model-demo` and introduces hybrid point-and-click / WASD navigation.

It includes:
- Everything from `03-character-model-demo` (orthographic camera, locked view, rigged voxel character, lobby room)
- **Point-and-click pathfinding** — click anywhere on the floor to send the player there via A*
- **Visual waypoint reticle** — an animated neon marker pulses at the destination while the player walks
- **Hybrid navigation modes** — WASD always overrides and clears the waypoint path immediately

## Key Concepts

### 1. Grid-based Pathfinding (`src/pathfinding.ts`)

The walkable floor is modelled as a 22×22 cell grid (`CELL_SIZE = 0.5 m`). Each cell is tested against the room's obstacle list at module load time and cached as a boolean `walkable[row][col]` grid.

The A* implementation uses:
- **8-directional neighbours** (N, S, E, W, NW, NE, SW, SE)
- **Octile distance** heuristic for admissible estimation
- **Diagonal cost = √2** — straight moves cost 1.0, diagonal moves cost ≈ 1.414
- **Corner-cutting prevention** — diagonal moves require both cardinal neighbours to be walkable

```
// Run A* and get world-space waypoints
const path = findPath(startRow, startCol, goalRow, goalCol);
// → [{ x, z }, { x, z }, …] ordered from first step to goal
```

### 2. Click Detection (`src/main.ts` + `src/world.ts`)

An invisible `THREE.PlaneGeometry` sits flush with the floor with `userData.isTile = true`. A `THREE.Raycaster` processes every canvas click:

```typescript
raycaster.setFromCamera(mouse, camera);
const hits = raycaster.intersectObject(clickPlane, false);
for (const hit of hits) {
  if (hit.object.userData.isTile) {
    world.navigateTo(hit.point.x, hit.point.z);
    break;
  }
}
```

### 3. Dual Navigation Mode (`src/player.ts`)

`Player` tracks a `NavigationMode` (`'MANUAL'` | `'WAYPOINT'`).

| Mode | Trigger | Behaviour |
|------|---------|-----------|
| `MANUAL` | Default / any WASD key | Continuous physics movement |
| `WAYPOINT` | Floor click | Follow A* node-by-node at `SPEED` m/s |

**WASD always interrupts**: detecting any WASD input clears the waypoint queue immediately and reverts to `MANUAL`.

```typescript
if (manualInput) {
  this.navMode = 'MANUAL';
  this._clearPath();          // also removes the neon reticle
}
```

### 4. Waypoint Reticle (`src/waypoint.ts`)

`WaypointReticle` is a flat neon `THREE.PlaneGeometry` that:
- Pulses in scale via `1.0 + 0.2 * sin(elapsed * 6)`
- Rotates slowly for a subtle spinning effect
- Is disposed automatically when `remove()` is called (path complete or WASD interrupt)

## Controls

| Input | Action |
|-------|--------|
| `W A S D` | MANUAL movement (always interrupts waypoint nav) |
| `🖱 Click floor` | Navigate to clicked position via A* |

## Running

```bash
cd prototypes/0.0.4-navigation-demo
npm install
npm run dev
```

## Architecture

```
src/
  main.ts           — entry point, raycasting click handler
  world.ts          — room, furniture, invisible click plane, navigateTo()
  player.ts         — dual-mode navigation (MANUAL / WAYPOINT)
  pathfinding.ts    — A* with 8-directional grid, obstacle map
  waypoint.ts       — animated neon destination reticle
  voxelCharacter.ts — rigged voxel humanoid (unchanged from 03)
  npc.ts            — ambient NPC (unchanged from 03)
  input.ts          — WASD keyboard input
  renderer.ts       — orthographic camera + pixelation pass
```
