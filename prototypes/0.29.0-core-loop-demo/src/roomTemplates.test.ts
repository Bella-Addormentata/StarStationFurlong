/**
 * 🧩 Fitted placement — the beach party set generated INTO a room.
 *
 * placeFitting is reached through the party template's `layout`; these pin
 * the branches that decide whether a generated room stays usable: seeded
 * collisions (a set added to a furnished room fits around it), rigid-group
 * rollback (a pergola with a post missing is no pergola, and its boxes are
 * handed back), the two door-layout readings (defaults for an unseeded room,
 * none for an authoritative-empty one), the sea/raft coupling, and the
 * keep-clear ground + ADD passes for players and stand-points.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFloorPlan } from './floorPlanDoc';
import { bindDoorLayoutDoc, seedDoorLayoutEmpty, doorSetIsMarkedEmpty } from './doorLayoutDoc';
import { ROOM_TEMPLATES, placeFitting, type PlacementSpec } from './roomTemplates';
import { buildObstacleList, roomDoorPoints, type Box, type FurnitureItem } from './furniture';

const HALF = { halfX: 6, halfZ: 6 }; // the default 2×2 module
const party = ROOM_TEMPLATES.find((t) => t.id === 'party-2')!;
const layout = (seed: readonly Box[] = []): FurnitureItem[] => party.layout!(HALF, seed);
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
const boxesOf = (items: FurnitureItem[]): Box[] => buildObstacleList(items);
const kinds = (items: FurnitureItem[]): string[] => items.map((i) => i.kind);

beforeEach(() => {
  bindFloorPlan(new Y.Doc());
  bindDoorLayoutDoc(new Y.Doc()); // unseeded ⇒ the four default doors
});

describe('seeded collisions', () => {
  it('fits around furniture already in the room instead of through it', () => {
    const fresh = layout();
    const cake = fresh.find((i) => i.kind === 'cake-table')!;
    expect(cake).toBeDefined();
    // Something already standing exactly where the cake would go.
    const seed: Box[] = [{ x0: cake.pos.x - 1.2, z0: cake.pos.z - 0.8, x1: cake.pos.x + 1.2, z1: cake.pos.z + 0.8 }];
    const fitted = layout(seed);
    for (const b of boxesOf(fitted)) for (const s of seed) expect(overlaps(b, s)).toBe(false);
    // The set still lands — nudged, not abandoned.
    expect(fitted.length).toBeGreaterThan(fresh.length * 0.7);
  });

  it('leaves the sea AND its raft out when the sea\'s corner is taken', () => {
    const fresh = layout();
    expect(kinds(fresh)).toContain('beach-sea');
    expect(kinds(fresh)).toContain('beach-raft');
    const raft = fresh.find((i) => i.kind === 'beach-raft')!;
    // Furniture sitting in the sea's corner, under the raft.
    const seed: Box[] = [{ x0: raft.pos.x - 1, z0: raft.pos.z - 1, x1: raft.pos.x + 1, z1: raft.pos.z + 1 }];
    const fitted = layout(seed);
    expect(kinds(fitted)).not.toContain('beach-sea');
    expect(kinds(fitted)).not.toContain('beach-raft'); // no raft beached on the floor
  });
});

describe('rigid groups', () => {
  it('drops the whole group when one member cannot land, and hands its boxes back', () => {
    // Two crates as a rigid pair, then a loose crate that wants the first
    // crate's spot. With the second crate blocked, the pair is out — and the
    // first crate's box must be handed back, or the loose crate could not land.
    const specs: PlacementSpec[] = [
      { kind: 'beach-crate', at: [0, 0], group: 'pair' },
      { kind: 'beach-crate', at: [0.3, 0], group: 'pair' }, // 1.8 m east
      { kind: 'beach-crate', at: [0, 0] },
    ];
    // Unblocked: the pair lands and takes (0,0); the loose crate, whose only
    // spot is (0,0) (every nudge of the centre IS the centre), does not.
    const noBlock = placeFitting(specs, 6, 6, 't');
    expect(noBlock).toHaveLength(2);

    const blockSecond: Box[] = [{ x0: 1.2, z0: -0.6, x1: 2.4, z1: 0.6 }];
    const blocked = placeFitting(specs, 6, 6, 't', blockSecond);
    expect(blocked).toHaveLength(1); // the pair is gone as a whole…
    expect(blocked[0].pos).toEqual({ x: 0, z: 0 }); // …and its first box was handed back
  });
});

describe('doors', () => {
  // The reserved lane: the 2 m opening plus a post each side, 0.8 m deep.
  const southLane: Box = { x0: -1.12, z0: 5.2, x1: 1.12, z1: 6 };

  it('keeps every default doorway and its approach lane clear', () => {
    expect(roomDoorPoints()).toHaveLength(4);
    for (const b of boxesOf(layout())) expect(overlaps(b, southLane)).toBe(false);
  });

  it('reserves nothing for a room whose owner removed every door', () => {
    const doc = new Y.Doc();
    bindDoorLayoutDoc(doc);
    seedDoorLayoutEmpty();
    expect(doorSetIsMarkedEmpty()).toBe(true);
    expect(roomDoorPoints()).toHaveLength(0); // no phantom defaults
    // …so the set may use the wall where the south door used to be.
    const withDoors = layout().length;
    bindDoorLayoutDoc(doc);
    expect(layout().length).toBeGreaterThanOrEqual(withDoors);
  });
});

describe('keep-clear ground (+ ADD)', () => {
  it('lands nothing on a player or a stand-point boxed by the caller', () => {
    const fresh = layout();
    const speaker = fresh.find((i) => i.kind === 'party-speaker')!;
    // A fox standing where the speaker would go, and a stand-point in front of the bar.
    const keep: Box[] = [
      { x0: speaker.pos.x - 0.5, z0: speaker.pos.z - 0.5, x1: speaker.pos.x + 0.5, z1: speaker.pos.z + 0.5 },
      { x0: -0.44, z0: -0.44, x1: 0.44, z1: 0.44 },
    ];
    const fitted = layout(keep);
    for (const b of boxesOf(fitted)) for (const k of keep) expect(overlaps(b, k)).toBe(false);
  });
});
