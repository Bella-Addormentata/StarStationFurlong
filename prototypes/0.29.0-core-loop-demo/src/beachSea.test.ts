/**
 * 🌊 beach-sea — flat water in the front corner of a sand floor.
 * The tiles you see, the tiles you cannot walk on and the dry lanes in front
 * of the doors are one decision (seaWaterTiles); these pin that decision.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFloorPlan, roomHalfExtents } from './floorPlanDoc';
import { bindDoorLayoutDoc } from './doorLayoutDoc';
import { buildObstacleList, seaWaterTiles, type FurnitureItem } from './furniture';

const SEA: FurnitureItem = { id: 's', kind: 'beach-sea', pos: { x: 0, z: 0 }, rot: 0, movable: true };

beforeAll(() => {
  bindFloorPlan(new Y.Doc()); // default 2×2 ⇒ half = 6
  bindDoorLayoutDoc(new Y.Doc()); // unseeded ⇒ the four default doors
});

describe('the sea', () => {
  it('lies inside the room, in the west-south corner', () => {
    const { halfX, halfZ } = roomHalfExtents();
    const tiles = seaWaterTiles();
    expect(tiles.length).toBeGreaterThan(8);
    for (const [i, j] of tiles) {
      expect(i).toBeGreaterThanOrEqual(-halfX);
      expect(i).toBeLessThan(halfX);
      expect(j).toBeGreaterThanOrEqual(-halfZ);
      expect(j).toBeLessThan(halfZ);
    }
    // Deepest against a side wall, and it reaches the front wall.
    expect(tiles.some(([i]) => i === -halfX || i === halfX - 1)).toBe(true);
    expect(tiles.some(([, j]) => j === halfZ - 1)).toBe(true);
  });

  it('keeps a dry lane in front of every door', () => {
    const { halfX, halfZ } = roomHalfExtents();
    for (const [i, j] of seaWaterTiles()) {
      const cx = i + 0.5, cz = j + 0.5;
      expect(Math.hypot(cx + halfX, cz - 0)).toBeGreaterThanOrEqual(1.6); // west door at (−halfX, 0)
      expect(Math.hypot(cx - halfX, cz - 0)).toBeGreaterThanOrEqual(1.6); // east door at (+halfX, 0)
      expect(Math.hypot(cx - 0, cz - halfZ)).toBeGreaterThanOrEqual(1.6); // south door at (0, +halfZ)
    }
  });

  it('blocks exactly its own tiles', () => {
    const boxes = buildObstacleList([SEA]);
    const blocked = (x: number, z: number) => boxes.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
    const set = new Set(seaWaterTiles().map(([i, j]) => `${i},${j}`));
    for (let i = -6; i < 6; i++) for (let j = -6; j < 6; j++) {
      expect(blocked(i + 0.5, j + 0.5)).toBe(set.has(`${i},${j}`));
    }
  });
});
