/**
 * 🌊 beach-river — the band, the banks and the bridge.
 *
 * The river is the first prop whose blocked area is NOT one rectangle, and the
 * whole design rests on three things being true at once:
 *   · the WATER is unwalkable,
 *   · the DRY SAND at the bends is walkable — a bounding box would have taken
 *     the banks and the far side of the room with it,
 *   · the BRIDGE is walkable end to end, over water.
 * Break any one and the room is either a lake you cannot cross or a floor with
 * a river painted on it. These cases pin all three against the real functions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFloorPlan, writeRoomDims } from './floorPlanDoc';
import {
  buildObstacleList,
  isPoolKind,
  poolCutContains,
  poolHoleCells,
  poolHoleRect,
  poolWaterContains,
  type FurnitureItem,
} from './furniture';

// The river SIZES ITSELF FROM THE ROOM (furniture.ts riverMetrics), so these
// cases have to say which room they are in. 5×5 is the biggest envelope and
// the one the band's full 2.6 m half-width is reached in; the last block below
// checks a 2×2 room instead.
beforeAll(() => {
  bindFloorPlan(new Y.Doc());
  writeRoomDims(5, 5); // 30×30 m ⇒ halfX = halfZ = 15
});

/** The template's pose: river across the front, bridge crossing it at x 5.5. */
const RIVER: FurnitureItem = {
  id: 'r', kind: 'beach-river', pos: { x: 0, z: 7.0 }, rot: 0, movable: false,
};
const BRIDGE: FurnitureItem = {
  id: 'b', kind: 'plank-bridge', pos: { x: 5.5, z: 7.8 }, rot: 0, movable: false,
};

// The centre line the builder, the hole cutter and the strips all share. At
// 5×5 the amplitude clamps to its maximum 1.8 and the water to 2.6.
const AMP = 1.8;
const centreZ = (x: number): number => 7.0 + AMP * Math.sin(0.38 * x + 0.6);

const blockedBy = (boxes: Array<{ x0: number; z0: number; x1: number; z1: number }>) =>
  (x: number, z: number): boolean =>
    boxes.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);

describe('the water band', () => {
  it('counts as a pool kind, so every pool-shaped question finds it', () => {
    expect(isPoolKind('beach-river')).toBe(true);
    expect(isPoolKind('cake-table')).toBe(false);
  });

  it('holds water on the centre line all the way across', () => {
    for (let x = -14; x <= 14; x += 2) {
      expect(poolWaterContains([RIVER], x, centreZ(x))).toBe(true);
    }
  });

  it('stops at the bank, not at a straight line', () => {
    for (let x = -14; x <= 14; x += 2) {
      expect(poolWaterContains([RIVER], x, centreZ(x) - 2.4)).toBe(true);
      expect(poolWaterContains([RIVER], x, centreZ(x) + 2.4)).toBe(true);
      expect(poolWaterContains([RIVER], x, centreZ(x) - 3.0)).toBe(false);
      expect(poolWaterContains([RIVER], x, centreZ(x) + 3.0)).toBe(false);
    }
  });

  it('BENDS — the same z is water at one end and dry sand at the other', () => {
    // The property a bounding box cannot have, and the reason the banks are
    // walkable at all. The amplitude (1.8) is smaller than the half-width
    // (2.6), so the band always overlaps itself in the middle — the place to
    // look is the OUTER edge of the widest bend.
    const xFar = 2.554; // where the centre line reaches its maximum
    const xNear = -1.58; // a quarter-period back, at its mean
    const z = centreZ(xFar) + 2.4; // just inside the far bank there…
    expect(poolWaterContains([RIVER], xFar, z)).toBe(true);
    expect(poolWaterContains([RIVER], xNear, z)).toBe(false); // …dry sand here
  });

  it('ends at its own length', () => {
    expect(poolWaterContains([RIVER], 16, centreZ(16))).toBe(false);
    expect(poolWaterContains([RIVER], -16, centreZ(-16))).toBe(false);
  });

  it('reports a bbox that contains the whole band', () => {
    const rect = poolHoleRect([RIVER])!;
    expect(rect).not.toBeNull();
    for (let x = -14; x <= 14; x += 1) {
      expect(centreZ(x) - 3.4).toBeGreaterThanOrEqual(rect.z0 - 1e-6);
      expect(centreZ(x) + 3.4).toBeLessThanOrEqual(rect.z1 + 1e-6);
    }
  });
});

describe('the bridge', () => {
  it('is standing OVER the water, not in it', () => {
    // Mid-span, dead centre of the channel — water without the bridge.
    expect(poolWaterContains([RIVER], 5.5, centreZ(5.5))).toBe(true);
    expect(poolWaterContains([RIVER, BRIDGE], 5.5, centreZ(5.5))).toBe(false);
  });

  it('does not dry out the rest of the river', () => {
    expect(poolWaterContains([RIVER, BRIDGE], -5, centreZ(-5))).toBe(true);
    expect(poolWaterContains([RIVER, BRIDGE], 11, centreZ(11))).toBe(true);
  });
});

describe('what you can walk on', () => {
  // Lazily: a describe body runs BEFORE beforeAll, so building the obstacle
  // list here would build it against the default room, not the 5×5 one.
  const blocked = (x: number, z: number): boolean =>
    blockedBy(buildObstacleList([RIVER, BRIDGE]))(x, z);

  it('blocks the water', () => {
    // Sampled at CELL CENTRES (i + 0.5) — what the walkable-grid bake asks.
    for (const x of [-12.5, -6.5, 0.5, 9.5, 12.5]) {
      expect(blocked(x, centreZ(x))).toBe(true);
    }
  });

  it('blocks the water on the strip SEAMS too, not just mid-strip', () => {
    // Integer x lands exactly on the boundary between two obstacle strips, and
    // blocked-ness is a strict inequality — so this is the case a seam without
    // overlap would miss. (The bridge lane, x ∈ [4.6, 6.4], is open by design.)
    for (let x = -14; x <= 14; x += 1) {
      if (x >= 4 && x <= 7) continue;
      expect(blocked(x, centreZ(x))).toBe(true);
    }
  });

  it('leaves the DRY SAND at the bends walkable', () => {
    // Past the EXCAVATION (3.4), not merely past the waterline: the wet shelf
    // between them is 30 cm below a floor the engine draws flat, so it is
    // scenery you look at, not ground you stand on.
    for (let x = -13.5; x <= 13.5; x += 1) {
      expect(blocked(x, centreZ(x) - 4.0)).toBe(false);
      expect(blocked(x, centreZ(x) + 4.0)).toBe(false);
    }
  });

  it('blocks the wet shelf as well as the water', () => {
    for (const x of [-10.5, -2.5, 6.5, 12.5]) {
      expect(blocked(x, centreZ(x) + 3.0)).toBe(true); // shelf: cut, not water
      expect(blocked(x, centreZ(x) - 3.0)).toBe(true);
    }
  });

  it('leaves the FAR BANK walkable — otherwise the loungers are decoration', () => {
    for (const x of [-11, -4.6, 1.6, 9.6, 13.6]) {
      expect(blocked(x, 13.5)).toBe(false);
    }
  });

  it('opens a lane the whole way across the bridge', () => {
    // Every half metre from the near bank to the far bank, on the bridge's
    // centre line. One blocked cell in here and the crossing is a dead end.
    for (let z = 3.6; z <= 12.0; z += 0.5) {
      expect(blocked(5.5, z)).toBe(false);
    }
  });

  it('does not open that lane anywhere else', () => {
    // A metre off the bridge, mid-channel, is still water.
    expect(blocked(3.2, centreZ(3.2))).toBe(true);
    expect(blocked(7.8, centreZ(7.8))).toBe(true);
  });

  it('blocks nothing at all once the river is removed', () => {
    expect(buildObstacleList([BRIDGE])).toHaveLength(0);
  });
});

describe('the floor hole', () => {
  const cells = (): Set<string> => poolHoleCells([RIVER, BRIDGE]);

  it('cuts only cells that are actually excavated', () => {
    const cut = cells();
    expect(cut.size).toBeGreaterThan(80);
    for (const key of cut) {
      const [i, j] = key.split(',').map(Number);
      expect(poolCutContains([RIVER, BRIDGE], i + 0.5, j + 0.5)).toBe(true);
    }
  });

  it('cuts wider than the waterline, or the wet shelf would be buried', () => {
    // The shelf renders 30 cm down; if the hole stopped at the waterline the
    // solid floor would sit over it and the terracing would never be seen.
    const x = 2.554; // the widest bend
    expect(poolWaterContains([RIVER], x, centreZ(x) + 3.0)).toBe(false);
    expect(poolCutContains([RIVER], x, centreZ(x) + 3.0)).toBe(true);
  });

  it('leaves the bridge its floor — a hole under the planks is a hole', () => {
    for (let j = 4; j <= 11; j++) {
      expect(cells().has(`5,${j}`)).toBe(false);
    }
  });

  it('cuts the channel where there is no bridge', () => {
    // Column x ∈ [-6,-5): the centre line is ≈ 7 + 1.8·sin(-1.49) ≈ 5.2.
    const j = Math.floor(centreZ(-5.5));
    expect(cells().has(`-6,${j}`)).toBe(true);
  });
});


describe('it sizes itself to the room', () => {
  // A 30 m channel authored for a 5×5 module hangs out through the walls of a
  // 2×2 one, and the reference's own widths would leave a 12 m room with no
  // bank at all. The river reaches wall to wall and narrows instead.
  it('reaches the walls of a small room without overflowing them', () => {
    bindFloorPlan(new Y.Doc());
    writeRoomDims(2, 2); // 12×12 m ⇒ half = 6
    try {
      const small = { ...RIVER, pos: { x: 0, z: 2.5 } };
      const rect = poolHoleRect([small])!;
      expect(rect.x0).toBeGreaterThanOrEqual(-6);
      expect(rect.x1).toBeLessThanOrEqual(6);
      // …and it is narrower than the 5×5 channel, not the same band clipped.
      expect(rect.z1 - rect.z0).toBeLessThan(6.8 + 2 * 1.8);
      // Still a river: water down the middle, dry land on both banks.
      expect(poolWaterContains([small], 0, 2.5)).toBe(true);
      expect(poolWaterContains([small], 0, -4.5)).toBe(false);
    } finally {
      bindFloorPlan(new Y.Doc());
      writeRoomDims(5, 5);
    }
  });
});
