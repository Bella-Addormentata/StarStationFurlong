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
import { bindFloorPlan, writeRoomDims } from './floorPlanDoc';
import { bindRobotDoc, readRobotConfig } from './robotDoc';
import { bindDoorLayoutDoc, seedDoorLayoutEmpty, doorSetIsMarkedEmpty } from './doorLayoutDoc';
import { bindFurnitureDoc, subscribeFurniture, readAllFurniture, peerIdTag } from './furnitureDoc';
import { ROOM_TEMPLATES, placeFitting, templateItemsFor, overlayEnvelopeBoxes, roomOccupancy, addRoomTemplateItems, applyRoomTemplate, reconcileConcurrentAdds, type PlacementSpec } from './roomTemplates';
import { FURNITURE, buildObstacleList, roomDoorPoints, itemOccupancyBox, wallMountHungOver, poolWaterContains, poolBasinAt, type Box, type FurnitureItem } from './furniture';

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

describe('what + ADD counts as occupied', () => {
  it('boxes a dance floor already in the room by its pad, and the set keeps off it', () => {
    const floor: FurnitureItem = { id: 'old-floor', kind: 'dance-floor', pos: { x: -2, z: 2 }, rot: 0, movable: true };
    expect(buildObstacleList([floor])).toHaveLength(0); // no footprint of its own…
    const pads = overlayEnvelopeBoxes([floor, { id: 'b', kind: 'beach-ball', pos: { x: 0, z: 0 }, rot: 0, movable: true }]);
    expect(pads).toHaveLength(1); // …but a 4.1 m pad for fitting
    expect(pads[0].x0).toBeCloseTo(-4.05, 6); expect(pads[0].x1).toBeCloseTo(0.05, 6);
    expect(pads[0].z0).toBeCloseTo(-0.05, 6); expect(pads[0].z1).toBeCloseTo(4.05, 6);
    const fitted = layout(pads);
    for (const b of boxesOf(fitted)) expect(overlaps(b, pads[0])).toBe(false);
    // A second floor, if it lands, lands off the first.
    const second = fitted.find((i) => i.kind === 'dance-floor');
    if (second) expect(overlaps(overlayEnvelopeBoxes([second])[0], pads[0])).toBe(false);
  });

  it('counts a wall-hung terminal by its slab, so a rose slot over it is taken', () => {
    const terminal: FurnitureItem = { id: 't', kind: 'wall-computer', pos: { x: 1, z: -5.97 }, rot: 0, movable: true };
    expect(buildObstacleList([terminal])).toHaveLength(0);
    const slab = itemOccupancyBox(terminal)!;
    expect(slab).toBeDefined();
    expect(slab.x0).toBeLessThan(1);
    expect(slab.x1).toBeGreaterThan(1);
    // The rose slot's band: 1 m of wall and the metre of floor before it.
    const band: Box = { x0: 0.5, x1: 1.5, z0: -6, z1: -5 };
    expect(overlaps(band, slab)).toBe(true);
    // Standing furniture still counts by its floor box; decoration by nothing.
    expect(itemOccupancyBox({ id: 'c', kind: 'beach-crate', pos: { x: 0, z: 0 }, rot: 0, movable: true })).toEqual(buildObstacleList([{ id: 'c', kind: 'beach-crate', pos: { x: 0, z: 0 }, rot: 0, movable: true }])[0]);
    expect(itemOccupancyBox({ id: 'b', kind: 'birthday-balloons', pos: { x: 0, z: 0 }, rot: 0, movable: true })).toBeNull();
  });
});

describe('+ ADD', () => {
  it('reports skipped pieces against what THIS room holds, and a second press lands fewer', () => {
    // An unseeded doc shows the default lobby (34 pieces) in a 2×2 room. The
    // World mirrors the doc's records into FURNITURE once it has any
    // (world.ts reconcileFurniture); here a bare mirror stands in for it.
    const before = [...FURNITURE];
    const unsubscribe = subscribeFurniture(() => {
      const recs = readAllFurniture();
      if (recs.size === 0) return;
      FURNITURE.splice(0, FURNITURE.length, ...[...recs].map(([id, r]) => ({ id, kind: r.kind, pos: { x: r.x, z: r.z }, rot: r.rot, movable: r.movable })));
    });
    bindFurnitureDoc(new Y.Doc());
    expect(FURNITURE.length).toBeGreaterThan(0);
    const occupied = roomOccupancy(FURNITURE);
    const first = addRoomTemplateItems('party-2')!;
    expect(first).not.toBeNull();
    // What landed is the set fitted around the lobby; what was skipped is
    // measured against the set fitted to THIS room when empty — never
    // against a 30 m room's fuller inventory.
    expect(first.placed).toBe(layout(occupied).length);
    expect(first.skipped).toBe(layout().length - first.placed);
    expect(first.skipped).toBeLessThan(party.layout!({ halfX: 15, halfZ: 15 }).length - first.placed);
    expect(FURNITURE.length).toBe(first.placed); // the doc's records now
    const second = addRoomTemplateItems('party-2')!;
    expect(second.placed).toBeLessThan(first.placed);
    expect(second.skipped).toBe(layout().length - second.placed);
    unsubscribe();
    FURNITURE.splice(0, FURNITURE.length, ...before);
  });
});

describe('one wall mount over another', () => {
  const item = (id: string, kind: FurnitureItem['kind'], x: number, z: number, rot: 0 | 1 | 2 | 3): FurnitureItem =>
    ({ id, kind, pos: { x, z }, rot, movable: true });
  const terminal = item('term', 'wall-computer', 1, -5.97, 0); // north wall

  it('finds the terminal under a rose hung on the same stretch of wall, and nothing a metre along', () => {
    expect(wallMountHungOver('climbing-rose', { x: 1.2, z: -5.97 }, 0, [terminal])?.id).toBe('term');
    expect(wallMountHungOver('climbing-rose', { x: 3, z: -5.97 }, 0, [terminal])).toBeNull();
    // …and the terminal cannot be re-hung inside a rose either.
    const rose = item('rose', 'climbing-rose', 1, -5.97, 0);
    expect(wallMountHungOver('wall-computer', { x: 1.3, z: -5.97 }, 0, [rose])?.id).toBe('rose');
    // Itself is not in its own way.
    expect(wallMountHungOver('wall-computer', { x: 1.3, z: -5.97 }, 0, [terminal], 'term')).toBeNull();
  });

  it('lets the two walls\' corner pieces meet, and shoulder-to-shoulder roses touch', () => {
    const northCorner = item('n', 'climbing-rose', -5.5, -5.97, 0);
    expect(wallMountHungOver('climbing-rose', { x: -5.97, z: -5.5 }, 1, [northCorner])).toBeNull();
    // ROSE WALLS hangs one per metre: slabs touching, not overlapping.
    expect(wallMountHungOver('climbing-rose', { x: -4.5, z: -5.97 }, 0, [northCorner])).toBeNull();
    // Floor furniture is not a wall mount: no slab, no verdict here.
    expect(wallMountHungOver('beach-crate', { x: 1, z: -5.5 }, 0, [terminal])).toBeNull();
  });
});

describe('the banner', () => {
  it('hangs over the cake WHERE THE CAKE LANDED, and not at all without a cake', () => {
    const fresh = layout();
    const cake = fresh.find((i) => i.kind === 'cake-table')!;
    expect(fresh.find((i) => i.kind === 'birthday-banner')!.pos).toEqual(cake.pos);
    // A crate on the cake's far corner: the cake takes its first nudge, and
    // the banner goes with it.
    const corner: Box[] = [{ x0: cake.pos.x + 0.78, z0: cake.pos.z - 0.52, x1: cake.pos.x + 1.1, z1: cake.pos.z - 0.02 }];
    const fitted = layout(corner);
    const moved = fitted.find((i) => i.kind === 'cake-table')!;
    expect(moved).toBeDefined();
    expect(moved.pos).not.toEqual(cake.pos);
    expect(fitted.find((i) => i.kind === 'birthday-banner')!.pos).toEqual(moved.pos);
    // …and so do the gifts, one each side of the cake as fitted.
    const gifts = fitted.filter((i) => i.kind === 'gift-box').map((g) => [+(g.pos.x - moved.pos.x).toFixed(2), +(g.pos.z - moved.pos.z).toFixed(2)]);
    expect(gifts).toEqual([[-1.6, 0.3], [1.6, 0.3]]);
    // The whole cake spot taken, nudges included: no cake, so no banner
    // hanging over whatever stands there, and no gifts beside nothing.
    const taken: Box[] = [{ x0: cake.pos.x - 1.2, z0: cake.pos.z - 0.8, x1: cake.pos.x + 1.2, z1: cake.pos.z + 0.8 }];
    const without = layout(taken);
    expect(kinds(without)).not.toContain('cake-table');
    expect(kinds(without)).not.toContain('birthday-banner');
    expect(kinds(without)).not.toContain('gift-box');
    // Likewise from the specs alone (every nudge of the centre is the centre).
    const specs: PlacementSpec[] = [{ kind: 'cake-table', at: [0, 0] }, { kind: 'birthday-banner', over: 'cake-table' }];
    expect(placeFitting(specs, 6, 6, 't', [{ x0: -2, z0: -2, x1: 2, z1: 2 }])).toHaveLength(0);
  });
});

const batchTags = (ids: string[]): string[] => [...new Set(ids.map((id) => id.slice(id.lastIndexOf('~') + 1)))];

describe('+ ADD from two peers', () => {
  it('mints ids the other peer cannot, so both sets survive the merge', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    bindFurnitureDoc(a);
    const tagA = peerIdTag();
    expect(tagA).toBe(a.clientID.toString(36));
    addRoomTemplateItems('party-2');
    const idsA = [...readAllFurniture().keys()];
    expect(idsA.length).toBeGreaterThan(0);
    for (const id of idsA) expect(id.includes(`~${tagA}.`)).toBe(true);
    bindFurnitureDoc(b); // the other peer, same room, same press
    addRoomTemplateItems('party-2');
    const idsB = [...readAllFurniture().keys()];
    expect(idsB.length).toBe(idsA.length);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]); // no id in common…
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); // …so the merge keeps both sets whole
    expect(a.getMap('furniture').size).toBe(idsA.length + idsB.length);
    // …and the race is then SETTLED: the two presses fitted the same room and
    // landed on the same coordinates, so one batch — the same one on every
    // peer, by tag order — is removed.
    bindFurnitureDoc(a);
    const removed = reconcileConcurrentAdds();
    expect(removed.length).toBe(idsA.length);
    expect(a.getMap('furniture').size).toBe(idsA.length);
    const loser = [...batchTags(idsA), ...batchTags(idsB)].sort()[1];
    for (const id of removed) expect(id.endsWith(`~${loser}`)).toBe(true);
    expect(reconcileConcurrentAdds()).toEqual([]); // settled once
  });

  it('leaves two presses made one after the other alone: the second fitted around the first', () => {
    bindFurnitureDoc(new Y.Doc());
    const mirror = subscribeFurniture(() => {
      const recs = readAllFurniture();
      if (recs.size === 0) return;
      FURNITURE.splice(0, FURNITURE.length, ...[...recs].map(([id, r]) => ({ id, kind: r.kind, pos: { x: r.x, z: r.z }, rot: r.rot, movable: r.movable })));
    });
    const before = [...FURNITURE];
    const first = addRoomTemplateItems('party-2')!;
    const second = addRoomTemplateItems('party-2')!;
    expect(second.placed).toBeGreaterThan(0);
    expect(reconcileConcurrentAdds()).toEqual([]);
    expect(readAllFurniture().size).toBe(first.placed + second.placed);
    mirror();
    FURNITURE.splice(0, FURNITURE.length, ...before);
  });
});

describe('a fixed manifest in a small room', () => {
  it('keeps only what a 1×1 room can hold, and still hangs a terminal on its own wall', () => {
    writeRoomDims(1, 1); // 6 m square: 3 m half-extents
    const party1 = ROOM_TEMPLATES.find((t) => t.id === 'party-1')!;
    expect(party1.layout).toBeUndefined();
    const items = templateItemsFor(party1);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(party1.items.length);
    // Every centre inside the walls; every box at most the wall-flush
    // allowance past them (a cabinet against the wall is allowed that).
    for (const i of items) { expect(Math.abs(i.pos.x)).toBeLessThanOrEqual(3); expect(Math.abs(i.pos.z)).toBeLessThanOrEqual(3); }
    for (const b of boxesOf(items)) {
      expect(b.x0).toBeGreaterThanOrEqual(-3.6); expect(b.x1).toBeLessThanOrEqual(3.6);
      expect(b.z0).toBeGreaterThanOrEqual(-3.6); expect(b.z1).toBeLessThanOrEqual(3.6);
    }
    expect(kinds(items)).not.toContain('bar-corner'); // authored at x 5.24
    expect(kinds(items)).not.toContain('cake-table'); // authored at z −4.2
    expect(kinds(items)).not.toContain('dance-floor'); // a 4 m pad, judged whole: past the walls
    expect(kinds(items)).toContain('chandelier'); // the middle stays
    const terminal = items.find((i) => i.kind === 'wall-computer')!;
    expect(terminal).toBeDefined();
    expect(Math.abs(terminal.pos.z)).toBeCloseTo(2.97, 2); // this room's wall, not the 2×2's
    // In the 2×2 room the manifest is untouched.
    writeRoomDims(2, 2);
    expect(templateItemsFor(party1)).toHaveLength(party1.items.length);
  });
});

describe('the dancer', () => {
  it('comes with the set: PLACE and + ADD each land a dock configured to dance', () => {
    expect(kinds(layout())).toContain('charging-dock');
    bindRobotDoc(new Y.Doc());
    bindFurnitureDoc(new Y.Doc());
    applyRoomTemplate('party-2');
    const placedDocks = [...readAllFurniture()].filter(([, r]) => r.kind === 'charging-dock').map(([id]) => id);
    expect(placedDocks).toHaveLength(1);
    expect(readRobotConfig(placedDocks[0])?.routine).toBe('dance');
    // + ADD writes ids of its own (the peer tag); its dock is configured too.
    bindRobotDoc(new Y.Doc());
    bindFurnitureDoc(new Y.Doc());
    addRoomTemplateItems('party-2');
    const addedDocks = [...readAllFurniture()].filter(([, r]) => r.kind === 'charging-dock').map(([id]) => id);
    expect(addedDocks).toHaveLength(1);
    expect(addedDocks[0]).not.toBe(placedDocks[0]);
    expect(readRobotConfig(addedDocks[0])?.routine).toBe('dance');
  });
});

describe('a race is a matter of seconds', () => {
  const rec = (kind: string, x: number, z: number) => ({ kind, x, z, rot: 0, movable: true });
  it('never lets an old batch\'s leftovers settle a fresh press, and settles a pair made within the window', () => {
    const doc = new Y.Doc();
    bindFurnitureDoc(doc);
    const m = doc.getMap('furniture');
    const now = Date.now();
    const old = (now - 3_600_000).toString(36); // an hour ago, edited down to two pieces
    m.set(`p-cake-table-1~a.1.${old}`, rec('cake-table', 2.52, -4.68));
    m.set(`p-beach-ball-2~a.1.${old}`, rec('beach-ball', 1.8, 5.16));
    const fresh = (now - 2_000).toString(36); // a press just now, coinciding on both
    m.set(`p-cake-table-1~b.1.${fresh}`, rec('cake-table', 2.52, -4.68));
    m.set(`p-beach-ball-2~b.1.${fresh}`, rec('beach-ball', 1.8, 5.16));
    m.set(`p-gift-box-3~b.1.${fresh}`, rec('gift-box', 0.92, -4.38));
    expect(reconcileConcurrentAdds()).toEqual([]);
    expect(m.size).toBe(5);
    // The same coincidence from a press 4 s after the fresh one IS a race: the
    // later tag loses.
    const racing = (now - 1_000).toString(36);
    m.set(`p-cake-table-1~c.1.${racing}`, rec('cake-table', 2.52, -4.68));
    m.set(`p-beach-ball-2~c.1.${racing}`, rec('beach-ball', 1.8, 5.16));
    const removed = reconcileConcurrentAdds();
    expect(removed.sort()).toEqual([`p-beach-ball-2~c.1.${racing}`, `p-cake-table-1~c.1.${racing}`]);
    expect(m.size).toBe(5);
  });
});

describe('two pools', () => {
  const pool = (id: string, x: number, z: number): FurnitureItem => ({ id, kind: 'classic-pool', pos: { x, z }, rot: 0, movable: true });
  it('judges each point by its OWN pool, and a swimmer keeps the pool they are in', () => {
    const items = [pool('p1', -8, 0), pool('p2', 8, 0)];
    expect(poolWaterContains(items, -8, 0)).toBe(true);
    expect(poolWaterContains(items, 8, 0)).toBe(true); // the second pool was reported dry
    expect(poolWaterContains(items, 0, 0)).toBe(false);
    const b2 = poolBasinAt(items, 8, 0)!;
    expect(b2.x0).toBeGreaterThan(0); // the second pool's rectangle, not the first's
    expect(poolBasinAt(items, -8, 0)!.x1).toBeLessThan(0);
    // Out of the water: the nearest pool's.
    expect(poolBasinAt(items, 5, 0)!.x0).toBeGreaterThan(0);
    expect(poolBasinAt([], 0, 0)).toBeNull();
  });
});

describe('what + ADD keeps off', () => {
  it('includes the slab of a wall-hung terminal, so no hedge is generated over it', () => {
    const terminal: FurnitureItem = { id: 't', kind: 'wall-computer', pos: { x: -4.72, z: -5.97 }, rot: 0, movable: true };
    expect(buildObstacleList([terminal])).toHaveLength(0);
    const occ = roomOccupancy([terminal]);
    expect(occ).toHaveLength(1);
    expect(occ[0].x0).toBeLessThan(-4.72); expect(occ[0].x1).toBeGreaterThan(-4.72);
    // The hedge wants a plant at (-4.72, -5.72) — the slot the terminal hangs over.
    const fresh = layout();
    expect(fresh.some((i) => i.kind === 'jungle-plant' && Math.abs(i.pos.x + 4.72) < 0.01 && Math.abs(i.pos.z + 5.72) < 0.01)).toBe(true);
    const fitted = layout(occ);
    for (const b of boxesOf(fitted)) expect(overlaps(b, occ[0])).toBe(false);
  });
});
