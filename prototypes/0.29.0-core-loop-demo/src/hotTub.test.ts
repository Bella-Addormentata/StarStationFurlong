/**
 * ♨️ Hot tub — issue #187, "make it a little bit bigger, four seats, leave a
 * little space between avatars".
 *
 * The tub always DECLARED four spots. Two of them could never be clicked:
 * the first two boxes were an east half and a west half of the full 3×3
 * footprint, findSeatAt returns the first box that contains the point, so the
 * south and north boxes listed after them were shadowed outright. These cases
 * pin the three things the issue asked for, in the order it asked for them:
 *
 *  1. four DISTINCT seats come back from four clicks on the tub, and the four
 *     boxes partition the footprint — no shadowed seat, no dead patch;
 *  2. the occupants are far enough apart to read as four foxes rather than
 *     one mass, with the arithmetic spelled out rather than asserted;
 *  3. the basin is big enough to hold them — which is the size increase, and
 *     the reason the water disc grew.
 *
 * Plus the couplings a radius change could silently break: both tub kinds
 * share one seat list, the bridge still lands someone in the tub, and the
 * pedestal (which the island, the river hole and the deck standoff are all
 * cut to) did not move.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFloorPlan } from './floorPlanDoc';
import { bindDoorLayoutDoc } from './doorLayoutDoc';
import {
  FURNITURE,
  FURNITURE_DEFS,
  HOT_TUB_R,
  OUTDOOR_FURNITURE,
  bridgeDeckY,
  getPoolIsland,
  hotTubBridgeLanding,
  isBridgeClick,
  islandHotTub,
  type FurnitureItem,
  type SeatTemplate,
} from './furniture';
import { ROOM_TEMPLATES } from './roomTemplates';
import { rebuildObstacles } from './obstacles';
import {
  rebakeWalkableGrid,
  walkable,
  worldToCol,
  worldToRow,
} from './pathfinding';
import { SEATS, findSeatAt, rebuildSeats, type Seat } from './seats';
import { PLAYER_R } from './player';

/** Tube radius of the glow torus, stated in both builders rather than in the
 *  table — the ring's outer edge is HOT_TUB_R.glow + this. */
const GLOW_TUBE = 0.04;

/** The lazy pool's tub sits at the room origin; the classic deck tub does not. */
const LAZY_TUB = { x: 0, z: 0 };
const CLASSIC_TUB = { x: -3.7, z: -3.7 };

const classicPoolItems = ROOM_TEMPLATES.find((t) => t.id === 'pool-2')!.items!;

/** The furniture the suite found, put back so no other file inherits a pool. */
const ORIGINAL_FURNITURE = [...FURNITURE];

/**
 * Swap the room, exactly the way the app does it: records into FURNITURE,
 * then the three derived rebuilds in their required order (obstacles → grid
 * → seats; seats.ts documents that order).
 */
const loadRoom = (items: readonly FurnitureItem[]): void => {
  FURNITURE.splice(
    0,
    FURNITURE.length,
    ...items.map((i) => ({ ...i, pos: { ...i.pos } })),
  );
  rebuildObstacles();
  rebakeWalkableGrid();
  rebuildSeats();
};

/** The loaded room's tub — the island tub or the Classic Lido's corner tub. */
const loadedTub = (): FurnitureItem =>
  FURNITURE.find((i) => i.kind === 'hot-tub' || i.kind === 'classic-hot-tub')!;

/** The tub's own seats, in registry order. */
const tubSeats = (): Seat[] =>
  SEATS.filter((s) => s.id.startsWith(`${loadedTub().id}:`));

const hypot = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

beforeAll(() => {
  bindFloorPlan(new Y.Doc()); // default 2×2 ⇒ half = 6, the pool rooms' size
  bindDoorLayoutDoc(new Y.Doc()); // unseeded ⇒ the four default doors
});

afterAll(() => {
  FURNITURE.splice(0, FURNITURE.length, ...ORIGINAL_FURNITURE);
  rebuildObstacles();
  rebakeWalkableGrid();
  rebuildSeats();
});

describe('four seats, all of them reachable', () => {
  beforeAll(() => loadRoom(OUTDOOR_FURNITURE));

  it('declares four', () => {
    expect(FURNITURE_DEFS['hot-tub'].seats).toHaveLength(4);
    expect(tubSeats()).toHaveLength(4);
  });

  it('returns a DIFFERENT seat for each quadrant of the tub', () => {
    // The #187 regression. Before the fix these four clicks returned two
    // seats: the east half for both +x points and the west half for both -x
    // ones, with the other two spots unreachable by any click at all.
    const picks = [
      [0.75, -0.75], // NE
      [0.75, 0.75], // SE
      [-0.75, 0.75], // SW
      [-0.75, -0.75], // NW
    ].map(([x, z]) => findSeatAt(LAZY_TUB.x + x, LAZY_TUB.z + z));

    expect(picks.every((s) => s !== null)).toBe(true);
    expect(new Set(picks.map((s) => s!.id)).size).toBe(4);
    for (const seat of picks) expect(seat!.id.startsWith('pool-hot-tub:')).toBe(true);
  });

  it('puts every seat in its own quadrant and nobody in anyone else\'s', () => {
    for (const seat of tubSeats()) {
      const b = seat.clickBox;
      expect(seat.sit.x).toBeGreaterThan(b.x0);
      expect(seat.sit.x).toBeLessThan(b.x1);
      expect(seat.sit.z).toBeGreaterThan(b.z0);
      expect(seat.sit.z).toBeLessThan(b.z1);
      expect(findSeatAt(seat.sit.x, seat.sit.z)!.id).toBe(seat.id);
    }
  });

  it('partitions the 3×3 footprint — no shadowed seat, no dead patch', () => {
    // Sample the whole footprint off the box edges (shared edges resolve to
    // whichever box is listed first, which is fine but not what is under
    // test). Every point must land on the tub, and all four must be used.
    const hit = new Set<string>();
    for (let x = -1.45; x <= 1.45; x += 0.1) {
      for (let z = -1.45; z <= 1.45; z += 0.1) {
        const seat = findSeatAt(LAZY_TUB.x + x, LAZY_TUB.z + z);
        expect(seat, `no seat at local (${x.toFixed(2)}, ${z.toFixed(2)})`).not.toBeNull();
        expect(seat!.id.startsWith('pool-hot-tub:')).toBe(true);
        hit.add(seat!.id);
      }
    }
    expect(hit.size).toBe(4);
  });

  it('overlaps no two click boxes', () => {
    const boxes = tubSeats().map((s) => s.clickBox);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        // Strict interiors: touching along a shared edge is the partition.
        const overlap = a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
        expect(overlap, `seats ${i} and ${j} overlap`).toBe(false);
      }
    }
  });
});

describe('space between the avatars', () => {
  beforeAll(() => loadRoom(OUTDOOR_FURNITURE));

  it('leaves 0.4 m between neighbours instead of 0.12 m', () => {
    // Four bodies on a ring, a quarter turn apart: centre-to-centre is
    // r·√2 and the gap between the two bodies is that less 2·PLAYER_R. The
    // old ring radius of 0.62 gave 0.12 m — shoulder to shoulder.
    const sits = tubSeats().map((s) => s.sit);
    const neighbours: number[] = [];
    for (let i = 0; i < sits.length; i++) {
      for (let j = i + 1; j < sits.length; j++) {
        const d = hypot(sits[i], sits[j]);
        // A quarter turn apart, not opposite.
        if (d < 1.4) neighbours.push(d);
      }
    }
    expect(neighbours).toHaveLength(4); // the four sides of the square
    for (const d of neighbours) {
      expect(d - 2 * PLAYER_R).toBeGreaterThan(0.35);
      expect(d).toBeCloseTo(0.82 * Math.SQRT2, 6);
    }
    expect(0.62 * Math.SQRT2 - 2 * PLAYER_R).toBeLessThan(0.13); // what it was
  });

  it('never lets two occupants intersect', () => {
    const sits = tubSeats().map((s) => s.sit);
    for (let i = 0; i < sits.length; i++) {
      for (let j = i + 1; j < sits.length; j++) {
        expect(hypot(sits[i], sits[j])).toBeGreaterThan(2 * PLAYER_R);
      }
    }
  });

  it('seats everyone at the same depth, chest above the waterline', () => {
    for (const seat of tubSeats()) {
      expect(seat.sitY).toBe(0.28);
      expect(seat.sitY).toBeLessThan(0.565); // HOT_TUB_WATER_Y
      expect(seat.swim).toBe(false); // a tub is a seat, not open water
      expect(seat.lie).toBe(false);
    }
  });

  it('faces every occupant inward, on a detent the rig snaps to', () => {
    for (const seat of tubSeats()) {
      // faceAngle is atan2(nx, nz) of the facing vector: +z=0, +x=π/2.
      const n = { x: Math.sin(seat.faceAngle), z: Math.cos(seat.faceAngle) };
      const toCentre = { x: -seat.sit.x, z: -seat.sit.z };
      const len = Math.hypot(toCentre.x, toCentre.z);
      expect(n.x * (toCentre.x / len) + n.z * (toCentre.z / len)).toBeCloseTo(1, 6);
      // 8-way detents — the avatar rig's snap increment.
      expect(((seat.faceAngle / (Math.PI / 4)) % 1 + 1) % 1).toBeCloseTo(0, 6);
    }
  });
});

describe('the basin is big enough to hold them — the size increase', () => {
  beforeAll(() => loadRoom(OUTDOOR_FURNITURE));

  it('keeps every body inside the water, clear of the rim', () => {
    const rimInnerFace = HOT_TUB_R.cap - HOT_TUB_R.capTube;
    for (const seat of tubSeats()) {
      const bodyEdge = hypot(seat.sit, LAZY_TUB) + PLAYER_R;
      expect(bodyEdge).toBeLessThan(HOT_TUB_R.water);
      expect(rimInnerFace - bodyEdge).toBeGreaterThan(0.15);
    }
  });

  it('explains the size increase: at the old basin they would be wedged in', () => {
    // Why the tub had to grow and not merely gain two click boxes. A ring
    // wide enough to leave 0.4 m between four foxes puts each body's outer
    // edge at 1.20. The OLD rim's inner face was 1.26 — six centimetres of
    // water showing all the way round, four occupants pressed against the
    // wall. The new one is 1.41, which is the "little space" #187 asked for.
    const OLD_RIM_INNER_FACE = 1.36 - 0.1; // cap − capTube, before #187
    const bodyEdge = (2 * PLAYER_R + 0.4) / Math.SQRT2 + PLAYER_R;
    expect(bodyEdge).toBeCloseTo(1.2, 2);
    expect(OLD_RIM_INNER_FACE - bodyEdge).toBeLessThan(0.07);
    expect(HOT_TUB_R.cap - HOT_TUB_R.capTube - bodyEdge).toBeCloseTo(0.21, 2);
  });

  it('nests the basin inside the rim inside the drum', () => {
    expect(HOT_TUB_R.water).toBeLessThan(HOT_TUB_R.shadow);
    expect(HOT_TUB_R.shadow).toBeLessThan(HOT_TUB_R.cap + HOT_TUB_R.capTube);
    expect(HOT_TUB_R.cap + HOT_TUB_R.capTube).toBeLessThanOrEqual(HOT_TUB_R.drum);
    // The LED ring lives in the drum's y-band, so the wall is what hides
    // or shows it. Pin the clearance, not the cap: an LED threaded through
    // the tile would be the visible defect.
    expect(HOT_TUB_R.glow + GLOW_TUBE).toBeLessThan(HOT_TUB_R.drum);
    expect(HOT_TUB_R.drum - (HOT_TUB_R.glow + GLOW_TUBE)).toBeCloseTo(0.05, 2);
    expect(HOT_TUB_R.jets).toBeLessThan(HOT_TUB_R.foam);
    expect(HOT_TUB_R.foam).toBeLessThan(HOT_TUB_R.water);
  });

  it('leaves the pedestal exactly where the island and the deck expect it', () => {
    // Deliberately NOT part of the growth. The lazy pool's island cylinder
    // (r 1.65 at its base) is cut for this number, the river's hole and the
    // swimmer's exclusion ellipse are sized off that island, and at the
    // classic tub it is what a walker's body meets at the 3×3 obstacle edge.
    expect(HOT_TUB_R.pedestal).toBe(1.7);
    expect(HOT_TUB_R.drum).toBeLessThan(HOT_TUB_R.pedestal); // a visible lip
  });

  it('keeps the 3×3 footprint, so the placement lattice does not shift', () => {
    // An odd tile extent centres on n+0.5; an even one on n. The basin grew
    // inside the pedestal precisely so this stays odd.
    for (const kind of ['hot-tub', 'classic-hot-tub'] as const) {
      expect(FURNITURE_DEFS[kind].footprint).toEqual({ w: 3, d: 3 });
    }
    for (const seat of tubSeats()) {
      const b = seat.clickBox;
      expect(b.x0).toBeGreaterThanOrEqual(LAZY_TUB.x - 1.5);
      expect(b.x1).toBeLessThanOrEqual(LAZY_TUB.x + 1.5);
      expect(b.z0).toBeGreaterThanOrEqual(LAZY_TUB.z - 1.5);
      expect(b.z1).toBeLessThanOrEqual(LAZY_TUB.z + 1.5);
    }
  });
});

describe('the footbridge still lands someone in the tub', () => {
  beforeAll(() => loadRoom(OUTDOOR_FURNITURE));

  it('arrives at the island end, west of centre', () => {
    expect(hotTubBridgeLanding(FURNITURE)).toEqual({ x: -0.2, z: 1.18 });
  });

  it('picks the spot nearest where the walk ends, not just a southern one', () => {
    // There are TWO southern seats now, so "greatest sit.z" no longer says
    // which. The bridge runs at x -0.2, so the south-WEST spot is the one it
    // actually arrives at.
    const landing = hotTubBridgeLanding(FURNITURE)!;
    const picked = findSeatAt(-0.2, 2.6); // on the deck, past the footprint
    expect(picked).not.toBeNull();
    expect(picked!.id.startsWith('pool-hot-tub:')).toBe(true);
    expect(picked!.sit.x).toBeLessThan(0);
    expect(picked!.sit.z).toBeGreaterThan(0);
    const nearest = tubSeats().reduce((a, b) =>
      hypot(a.sit, landing) <= hypot(b.sit, landing) ? a : b,
    );
    expect(picked!.id).toBe(nearest.id);
  });

  it('walks the arch rather than teleporting over it', () => {
    const picked = findSeatAt(-0.2, 2.6)!;
    expect(picked.path?.length).toBeGreaterThan(0);
    // Every waypoint is on the bridge centreline and above the deck.
    for (const p of picked.path!) {
      expect(p.x).toBeCloseTo(-0.2, 6);
      expect(p.y).toBeGreaterThan(0.3);
    }
    // All four spots share the one dry-land approach: the shore — and it has
    // to be a cell the walker can actually stand on, or the walk never starts.
    for (const seat of tubSeats()) {
      expect(seat.front.z).toBeGreaterThan(1.5);
      expect(
        walkable[worldToRow(seat.front.z)]?.[worldToCol(seat.front.x)],
      ).toBe(true);
    }
  });

  it('still leaves the tub itself clickable all the way to its south edge', () => {
    // The bridge's padded click strip reaches z 0.98, inside the footprint.
    // The tub's own boxes are checked first, so clicking the tub seats you in
    // the half you clicked rather than always in the bridge's seat.
    expect(findSeatAt(0.75, 1.2)!.sit.x).toBeGreaterThan(0); // SE spot
    expect(findSeatAt(-0.75, 1.2)!.sit.x).toBeLessThan(0); // SW spot
  });
});

describe('the classic deck tub is the same tub', () => {
  beforeAll(() => loadRoom(classicPoolItems));

  it('shares ONE seat list with the lazy pool\'s tub', () => {
    // The duplicate list is why #187 was one bug in two places.
    const a: readonly SeatTemplate[] | undefined = FURNITURE_DEFS['hot-tub'].seats;
    const b: readonly SeatTemplate[] | undefined = FURNITURE_DEFS['classic-hot-tub'].seats;
    expect(a).toBe(b);
  });

  it('gives all four of its spots a distinct click too', () => {
    const picks = [
      [0.75, -0.75],
      [0.75, 0.75],
      [-0.75, 0.75],
      [-0.75, -0.75],
    ].map(([x, z]) => findSeatAt(CLASSIC_TUB.x + x, CLASSIC_TUB.z + z));
    expect(picks.every((s) => s !== null)).toBe(true);
    expect(new Set(picks.map((s) => s!.id)).size).toBe(4);
  });

  it('keeps its occupants spaced and inside the water', () => {
    const sits = tubSeats().map((s) => s.sit);
    expect(sits).toHaveLength(4);
    for (const sit of sits) {
      expect(hypot(sit, CLASSIC_TUB) + PLAYER_R).toBeLessThan(HOT_TUB_R.water);
    }
    for (let i = 0; i < sits.length; i++) {
      for (let j = i + 1; j < sits.length; j++) {
        expect(hypot(sits[i], sits[j])).toBeGreaterThan(2 * PLAYER_R + 0.35);
      }
    }
  });

  it('still reaches a dry-land approach the walker can stand on', () => {
    // Its own per-quadrant fronts, through computeFront's walkable fallback
    // where a preferred point is off the deck. What has to hold is that each
    // point is real — inside the room and on a walkable cell.
    const fronts = tubSeats().map((s) => s.front);
    expect(fronts).toHaveLength(4);
    for (const front of fronts) {
      expect(Math.abs(front.x)).toBeLessThanOrEqual(5.5);
      expect(Math.abs(front.z)).toBeLessThanOrEqual(5.5);
      expect(walkable[worldToRow(front.z)]?.[worldToCol(front.x)]).toBe(true);
    }
  });
});

describe('the Classic Lido deck tub has no footbridge', () => {
  // The bridge is drawn by the lazy pool alone. The deck tub used to share
  // the island tub's id, "pool-hot-tub", and every bridge rule keyed on that
  // id: an arched 6-waypoint walk over open deck, a click strip over the pool
  // that routed into the tub, and a swim-exclusion island in the pool's
  // north-west corner. Rooms seeded before the rename still hold the old id,
  // so both ids are checked: the fix keys on what the bridge belongs to.
  for (const tubId of ['lido-hot-tub', 'pool-hot-tub']) {
    describe(`with the tub's id "${tubId}"`, () => {
      beforeAll(() =>
        loadRoom(
          classicPoolItems.map((i) =>
            i.kind === 'classic-hot-tub' ? { ...i, id: tubId } : i,
          ),
        ),
      );

      it('finds no island tub, no landing and no island', () => {
        expect(islandHotTub(FURNITURE)).toBeNull();
        expect(hotTubBridgeLanding(FURNITURE)).toBeNull();
        expect(getPoolIsland(FURNITURE)).toBeNull();
      });

      it('has no bridge to click or to stand on', () => {
        // The middle of the strip the phantom bridge used to claim.
        const x = CLASSIC_TUB.x - 0.2;
        const z = CLASSIC_TUB.z + 2.2;
        expect(isBridgeClick(FURNITURE, x, z)).toBe(false);
        expect(bridgeDeckY(FURNITURE, x, z)).toBeNull();
        const seat = findSeatAt(x, z);
        expect(seat?.id.startsWith(`${tubId}:`) ?? false).toBe(false);
      });

      it('walks straight up to the tub instead of over an arch', () => {
        for (const seat of tubSeats()) {
          expect(seat.path).toBeUndefined();
          // An approach beside THIS tub, not the lazy pool's shore across
          // the room (which every seat used to be sent to).
          expect(hypot(seat.front, CLASSIC_TUB)).toBeLessThan(3);
        }
      });
    });
  }
});

describe('islandHotTub', () => {
  it('is the lazy pool\'s tub, found by kind and place rather than id', () => {
    const tub = islandHotTub(OUTDOOR_FURNITURE);
    expect(tub?.kind).toBe('hot-tub');
    expect(tub?.pos).toEqual({ x: 0, z: 0 });
  });

  it('is nobody once the tub has been carried off the island', () => {
    const moved = OUTDOOR_FURNITURE.map((i) =>
      i.kind === 'hot-tub' ? { ...i, pos: { x: 3, z: 4 } } : i,
    );
    expect(islandHotTub(moved)).toBeNull();
  });
});
