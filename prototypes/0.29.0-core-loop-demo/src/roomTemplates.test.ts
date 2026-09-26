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
import { ROOM_TEMPLATES, placeFitting, templateItemsFor, type PlacementSpec } from './roomTemplates';
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
    // A crate that wants the middle of the south doorway's lane.
    // (0, 4.8): its 1 m box reaches z 5.3 — inside the wall margin, inside the lane.
    const wantsLane: PlacementSpec[] = [{ kind: 'beach-crate', at: [0, 0.8] }];
    // Under the four default doors the lane is reserved: the crate is nudged
    // away from it (or not placed at all).
    expect(roomDoorPoints()).toHaveLength(4);
    const withDoors = placeFitting(wantsLane, 6, 6, 't');
    for (const b of boxesOf(withDoors)) expect(overlaps(b, southLane)).toBe(false);
    // With an authoritative-EMPTY door set there is no door there to keep
    // clear: the same crate lands exactly where it asked.
    bindDoorLayoutDoc(new Y.Doc());
    seedDoorLayoutEmpty();
    expect(doorSetIsMarkedEmpty()).toBe(true);
    expect(roomDoorPoints()).toHaveLength(0);
    const noDoors = placeFitting(wantsLane, 6, 6, 't');
    expect(noDoors).toHaveLength(1);
    expect(noDoors[0].pos).toEqual({ x: 0, z: 4.8 });
    expect(boxesOf(noDoors).some((b) => overlaps(b, southLane))).toBe(true);
  });
});

describe('walkable overlays', () => {
  it('fits the dance floor by its whole 4 m pad — inside the walls, off the furniture', () => {
    const floor = layout().find((i) => i.kind === 'dance-floor')!;
    expect(floor).toBeDefined();
    expect(floor.pos.x + 2.05).toBeLessThanOrEqual(6 - 0.3);
    expect(floor.pos.z + 2.05).toBeLessThanOrEqual(6 - 0.3);
    // And nothing the set placed stands on it — the pad is kept clear while fitting.
    const pad: Box = { x0: floor.pos.x - 2.05, z0: floor.pos.z - 2.05, x1: floor.pos.x + 2.05, z1: floor.pos.z + 2.05 };
    for (const b of boxesOf(layout())) expect(overlaps(b, pad)).toBe(false);
  });
});

describe('keep-clear ground (+ ADD)', () => {
  it('lands nothing on a player or a stand-point boxed by the caller', () => {
    const fresh = layout();
    const cake = fresh.find((i) => i.kind === 'cake-table')!;
    expect(cake).toBeDefined();
    // A fox standing where the cake would go, and a stand-point mid-room.
    const keep: Box[] = [
      { x0: cake.pos.x - 0.5, z0: cake.pos.z - 0.5, x1: cake.pos.x + 0.5, z1: cake.pos.z + 0.5 },
      { x0: -0.44, z0: -0.44, x1: 0.44, z1: 0.44 },
    ];
    const fitted = layout(keep);
    for (const b of boxesOf(fitted)) for (const k of keep) expect(overlaps(b, k)).toBe(false);
  });
});

describe('the fitted set\'s terminal', () => {
  it('stands where its front is dry, even in a doorless room where the sea reaches the middle of the south wall', () => {
    bindDoorLayoutDoc(new Y.Doc());
    seedDoorLayoutEmpty();
    const items = templateItemsFor(party);
    const terminal = items.find((i) => i.kind === 'wall-computer')!;
    expect(terminal).toBeDefined();
    // On some wall's mount plane, its front 1 m into the room from there.
    const onWall = Math.abs(Math.abs(terminal.pos.x) - 5.97) < 0.01 || Math.abs(Math.abs(terminal.pos.z) - 5.97) < 0.01;
    expect(onWall).toBe(true);
    const front = { x: terminal.pos.x, z: terminal.pos.z };
    if (terminal.rot === 2) front.z -= 1.0; else if (terminal.rot === 0) front.z += 1.0; else if (terminal.rot === 3) front.x -= 1.0; else front.x += 1.0;
    const reach = 0.44;
    for (const b of buildObstacleList(items.filter((i) => i.kind !== 'wall-computer'))) {
      const inside = front.x > b.x0 - reach && front.x < b.x1 + reach && front.z > b.z0 - reach && front.z < b.z1 + reach;
      expect(inside).toBe(false);
    }
  });
});

describe('the default room', () => {
  it('ships the whole party — cake, banner, floor, speaker, gifts, bar, sea — in a 2×2 module', () => {
    const k = kinds(layout());
    for (const need of ['beach-sea', 'beach-raft', 'cake-table', 'birthday-banner', 'dance-floor', 'party-speaker', 'gift-box', 'tiki-bar-counter', 'tiki-back-bar', 'tiki-bar-stool']) {
      expect(k, `${need} missing from the default layout`).toContain(need);
    }
    // The speaker stands at the floor's end, off the pad.
    const floor = layout().find((i) => i.kind === 'dance-floor')!;
    const speaker = layout().find((i) => i.kind === 'party-speaker')!;
    const pad: Box = { x0: floor.pos.x - 2.05, z0: floor.pos.z - 2.05, x1: floor.pos.x + 2.05, z1: floor.pos.z + 2.05 };
    expect(overlaps(boxesOf([speaker])[0], pad)).toBe(false);
    expect(Math.hypot(speaker.pos.x - floor.pos.x, speaker.pos.z - floor.pos.z)).toBeLessThan(4);
  });
});
