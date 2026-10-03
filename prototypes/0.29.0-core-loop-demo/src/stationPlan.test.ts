/**
 * 🗺️ The holotable's station plan (#192): a known station's atlas laid flat,
 * docked ships beside their gates, module owners, and the ships at or near
 * the station from the planet's shared summary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindStationAtlasDoc, cleanAtlasOwner, harvestIntoAtlas, readAtlas } from './stationAtlas';
import { moduleContains, planModuleAt, stationPlan, visitingShips } from './stationPlan';
import type { ShipSummary } from './planetSummary';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const seed = (room: string) => `ssf://room#room=${room}`;

beforeEach(() => store.clear());

/** HUB ↔ DOCKS by a gangway; DOCKS has a ship docked at gate 2 and a free
 *  gate 3; a second station, FAR, shares nothing with them. */
function station(): void {
  harvestIntoAtlas({
    roomId: 'room-a', name: 'HUB', dims: { cols: 2, rows: 3 },
    doors: [{ doorId: 'east', targetSeed: seed('room-b'), wall: 'x+', lateral: 0, farDoor: 'west', farWall: 'x-', farLateral: 0, transient: false }],
    owner: { id: 'p-ada', name: 'Ada' },
  });
  harvestIntoAtlas({
    roomId: 'room-b', name: 'DOCKS',
    doors: [
      { doorId: 'west', targetSeed: seed('room-a'), wall: 'x-', lateral: 0, farDoor: 'east', farWall: 'x+', farLateral: 0, transient: false },
      { doorId: 'south', targetSeed: seed('ship-1'), wall: 'y+', lateral: 0, transient: true },
    ],
    gates: { south: 2, east: 3 },
    owner: { id: 'p-bo' },
  });
  harvestIntoAtlas({
    roomId: 'ship-1', name: 'SKIFF',
    doors: [{ doorId: 'north', targetSeed: seed('room-b'), wall: 'y-', lateral: 0, transient: true }],
  });
  harvestIntoAtlas({ roomId: 'far-1', name: 'FAR', doors: [] });
}

describe('the station plan', () => {
  it('places the station modules from the root, and docked ships apart', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    expect(plan.modules.map((m) => m.roomId)).toEqual(['room-a', 'room-b']);
    expect(plan.ships.map((m) => m.roomId)).toEqual(['ship-1']);
    const [hub, docks] = plan.modules;
    expect(hub).toMatchObject({ x: 0, z: 0, hops: 0, kind: 'module', halfX: 6, halfZ: 9 });
    // The far module sits east of the hub, on the far side of the gangway.
    expect(docks.x).toBeGreaterThan(hub.halfX);
    expect(Math.abs(docks.z)).toBeLessThan(1e-6);
    // Unknown size reads as the default 2×2 room.
    expect(docks).toMatchObject({ halfX: 6, halfZ: 6 });
    expect(docks.dims).toBeUndefined();
  });

  it('never pulls an unconnected station into the plan', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-b');
    const ids = [...plan.modules, ...plan.ships].map((m) => m.roomId);
    expect(ids).not.toContain('far-1');
    expect(plan.rootRoomId).toBe('room-b');
    expect(plan.modules[0]).toMatchObject({ roomId: 'room-b', x: 0, z: 0 });
  });

  it('does not walk on through a docked ship', () => {
    station();
    // The ship also lists a berth at another station's room: it must not
    // bring that station along.
    harvestIntoAtlas({
      roomId: 'ship-1', name: 'SKIFF',
      doors: [
        { doorId: 'north', targetSeed: seed('room-b'), wall: 'y-', lateral: 0, transient: true },
        { doorId: 'south', targetSeed: seed('far-1'), wall: 'y+', lateral: 0, transient: true },
      ],
    });
    const plan = stationPlan(readAtlas(), 'room-a');
    expect([...plan.modules, ...plan.ships].map((m) => m.roomId)).not.toContain('far-1');
  });

  it('lists each module\'s gates, which are taken, and where a ship is docked', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    const docks = plan.modules.find((m) => m.roomId === 'room-b')!;
    expect(docks.gates).toEqual([
      { doorId: 'south', gate: 2, occupied: true },
      { doorId: 'east', gate: 3, occupied: false },
    ]);
    expect(docks.links).toEqual([
      { doorId: 'south', toRoomId: 'ship-1', berth: true },
      { doorId: 'west', toRoomId: 'room-a', berth: false },
    ]);
    expect(plan.ships[0].dockedAt).toEqual({ roomId: 'room-b', doorId: 'south', gate: 2 });
  });

  it('carries each module\'s owner and marks the room you stand in', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a', 'room-b');
    expect(plan.modules[0].owner).toEqual({ id: 'p-ada', name: 'Ada' });
    expect(plan.modules[1].owner).toEqual({ id: 'p-bo' });
    expect(plan.modules.map((m) => m.here)).toEqual([false, true]);
  });

  it('shows a long chain of modules whole, past any hop count', () => {
    const n = 40;
    for (let i = 0; i < n; i++) {
      const doors = [];
      if (i > 0) doors.push({ doorId: 'west', targetSeed: seed(`c${i - 1}`), wall: 'x-' as const, lateral: 0, farDoor: 'east', farWall: 'x+' as const, farLateral: 0, transient: false });
      if (i < n - 1) doors.push({ doorId: 'east', targetSeed: seed(`c${i + 1}`), wall: 'x+' as const, lateral: 0, farDoor: 'west', farWall: 'x-' as const, farLateral: 0, transient: false });
      harvestIntoAtlas({ roomId: `c${i}`, name: `C${i}`, doors });
    }
    const plan = stationPlan(readAtlas(), 'c0');
    expect(plan.modules).toHaveLength(n);
    expect(plan.modules.at(-1)).toMatchObject({ roomId: `c${n - 1}`, hops: n - 1 });
  });

  it('places a module joined by a pairing only its own side recorded', () => {
    // Forward: the hub records the gangway.
    harvestIntoAtlas({ roomId: 'f-hub', name: 'HUB', doors: [{ doorId: 'east', targetSeed: seed('f-bar'), wall: 'x+', lateral: 0, farDoor: 'west', farWall: 'x-', farLateral: 0, transient: false }] });
    harvestIntoAtlas({ roomId: 'f-bar', name: 'BAR', doors: [] });
    const forward = stationPlan(readAtlas(), 'f-hub').modules.find((m) => m.roomId === 'f-bar')!;
    // Reverse: only the bar records it.
    harvestIntoAtlas({ roomId: 'r-hub', name: 'HUB', doors: [] });
    harvestIntoAtlas({ roomId: 'r-bar', name: 'BAR', doors: [{ doorId: 'west', targetSeed: seed('r-hub'), wall: 'x-', lateral: 0, farDoor: 'east', farWall: 'x+', farLateral: 0, transient: false }] });
    const plan = stationPlan(readAtlas(), 'r-hub');
    expect(plan.modules.map((m) => m.roomId)).toEqual(['r-hub', 'r-bar']);
    const bar = plan.modules[1];
    expect(bar.x).toBeCloseTo(forward.x, 6);
    expect(bar.z).toBeCloseTo(forward.z, 6);
    expect(Math.cos(bar.rotY - forward.rotY)).toBeCloseTo(1, 6);
    // The hub links to the bar through the door the bar's record names.
    expect(plan.modules[0].links).toEqual([{ doorId: 'east', toRoomId: 'r-bar', berth: false }]);
  });

  it('keeps a second connection only the far room recorded', () => {
    // Two gangways between the same rooms: the hub recorded one, the bar
    // alone recorded the other.
    harvestIntoAtlas({ roomId: 'p-hub', name: 'HUB', doors: [{ doorId: 'east', targetSeed: seed('p-bar'), wall: 'x+', lateral: 0, farDoor: 'west', farWall: 'x-', farLateral: 0, transient: false }] });
    harvestIntoAtlas({ roomId: 'p-bar', name: 'BAR', doors: [
      { doorId: 'west', targetSeed: seed('p-hub'), wall: 'x-', lateral: 0, farDoor: 'east', farWall: 'x+', farLateral: 0, transient: false },
      { doorId: 'd:2', targetSeed: seed('p-hub'), wall: 'x-', lateral: 3, farDoor: 'd:9', farWall: 'x+', farLateral: 3, transient: false },
    ] });
    const hub = stationPlan(readAtlas(), 'p-hub').modules[0];
    expect(hub.links).toEqual([
      { doorId: 'd:9', toRoomId: 'p-bar', berth: false },
      { doorId: 'east', toRoomId: 'p-bar', berth: false },
    ]);
  });

  it('matches unnamed records berths first, as berthDoorIds does', () => {
    // The hub recorded one unnamed gangway to the bar; the bar recorded an
    // unnamed gangway and then a berth back. The berth is the hub's record
    // (berthDoorIds pairs it so), and the bar's gangway is a second
    // connection only the bar wrote down.
    harvestIntoAtlas({ roomId: 'u-hub', name: 'HUB', doors: [{ doorId: 'east', targetSeed: seed('u-bar'), transient: false }] });
    harvestIntoAtlas({ roomId: 'u-bar', name: 'BAR', doors: [
      { doorId: 'west', targetSeed: seed('u-hub'), transient: false },
      { doorId: 'dock', targetSeed: seed('u-hub'), transient: true },
    ] });
    const hub = stationPlan(readAtlas(), 'u-hub').modules.find((m) => m.roomId === 'u-hub')!;
    expect(hub.links).toHaveLength(2);
    expect(hub.links).toEqual(expect.arrayContaining([
      { doorId: 'east', toRoomId: 'u-bar', berth: true },
      { doorId: '~u-bar:west', toRoomId: 'u-bar', berth: false },
    ]));
  });

  it('docks a ship whose berth only the ship recorded', () => {
    harvestIntoAtlas({ roomId: 'q-hub', name: 'HUB', doors: [], gates: { south: 4 } });
    harvestIntoAtlas({ roomId: 'q-ship', name: 'SKIFF', doors: [{ doorId: 'north', targetSeed: seed('q-hub'), wall: 'y-', lateral: 0, farDoor: 'south', farWall: 'y+', farLateral: 0, transient: true }] });
    const plan = stationPlan(readAtlas(), 'q-hub');
    expect(plan.ships.map((m) => m.roomId)).toEqual(['q-ship']);
    expect(plan.modules[0].gates).toEqual([{ doorId: 'south', gate: 4, occupied: true }]);
    expect(plan.ships[0].dockedAt).toEqual({ roomId: 'q-hub', doorId: 'south', gate: 4 });
  });

  it('is empty for a room the atlas does not know', () => {
    station();
    const plan = stationPlan(readAtlas(), 'nowhere');
    expect(plan.modules).toEqual([]);
    expect(plan.ships).toEqual([]);
  });

  it('finds the module under a point, ships first, and respects rotation', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    expect(planModuleAt(plan, 0, 0)?.roomId).toBe('room-a');
    expect(planModuleAt(plan, 0, 8.5)?.roomId).toBe('room-a'); // 3 rows: 9 m half
    const ship = plan.ships[0];
    expect(planModuleAt(plan, ship.x, ship.z)?.roomId).toBe('ship-1');
    expect(planModuleAt(plan, 500, 500)).toBeNull();
    // A long module turned a quarter: its length now runs along z.
    const turned = { x: 0, z: 0, rotY: Math.PI / 2, halfX: 10, halfZ: 2 };
    expect(moduleContains(turned, 0, 9)).toBe(true);
    expect(moduleContains(turned, 9, 0)).toBe(false);
  });

  it('bounds every module and ship', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    expect(plan.bounds.minX).toBeLessThanOrEqual(-6);
    expect(plan.bounds.maxX).toBeGreaterThan(plan.modules[1].x);
    expect(plan.bounds.minZ).toBeLessThanOrEqual(-9);
  });
});

describe('a module owner in the atlas', () => {
  it('keeps only a sane id and name', () => {
    expect(cleanAtlasOwner({ id: 'p', name: 'Ada' })).toEqual({ id: 'p', name: 'Ada' });
    expect(cleanAtlasOwner({ id: 'p', name: 7 })).toEqual({ id: 'p' });
    expect(cleanAtlasOwner({ id: 'p', name: 'x'.repeat(65) })).toEqual({ id: 'p' });
    expect(cleanAtlasOwner({ id: '' })).toBeUndefined();
    expect(cleanAtlasOwner({ id: 'x'.repeat(129) })).toBeUndefined();
    expect(cleanAtlasOwner('p')).toBeUndefined();
  });

  it('survives a harvest that could not read it', () => {
    station();
    harvestIntoAtlas({ roomId: 'room-a', name: 'HUB', doors: [] });
    expect(readAtlas()['room-a'].owner).toEqual({ id: 'p-ada', name: 'Ada' });
  });

  it('is cleared by a harvest that saw the room ownerless, and that travels', () => {
    station();
    const doc = new Y.Doc();
    bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
    // Later, the room's owner is gone (same doors as before).
    const later = Date.now() + 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    harvestIntoAtlas({
      roomId: 'room-a', name: 'HUB',
      doors: [{ doorId: 'east', targetSeed: seed('room-b'), wall: 'x+', lateral: 0, farDoor: 'west', farWall: 'x-', farLateral: 0, transient: false }],
      owner: null,
    });
    expect(readAtlas()['room-a'].owner).toBeNull();
    expect(stationPlan(readAtlas(), 'room-a').modules[0].owner).toBeNull();
    bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
    expect((doc.getMap('atlas').get('room-a') as { owner?: unknown }).owner).toBeNull();
    // A peer that knew the old owner drops it on the ownerless record.
    store.clear();
    harvestIntoAtlas({ roomId: 'room-a', name: 'HUB', doors: [], owner: { id: 'p-ada' } });
    const mine = readAtlas();
    mine['room-a'].lastSeen = 0;
    store.set('ssf-station-atlas', JSON.stringify(mine));
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    expect(readAtlas()['room-a'].owner).toBeNull();
    clock.mockRestore();
  });

  it('travels through the shared atlas to a client that never stood there', () => {
    station();
    const doc = new Y.Doc();
    bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
    const shared = doc.getMap('atlas').get('room-b') as { owner?: unknown };
    expect(shared.owner).toEqual({ id: 'p-bo' });
    // A fresh install binds the same doc and learns the owners.
    store.clear();
    bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
    expect(readAtlas()['room-b'].owner).toEqual({ id: 'p-bo' });
  });

  it('refuses a shared entry whose owner is malformed', () => {
    const doc = new Y.Doc();
    doc.getMap('atlas').set('room-x', {
      roomId: 'room-x', name: 'X', doors: { e: { targetRoomId: 'room-y' } },
      owner: { id: 42 }, updatedAt: 1,
    });
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    expect(readAtlas()['room-x']).toBeUndefined();
  });

  it('is added to a doc copy that lacks it, even one as new as ours', () => {
    const doc = new Y.Doc();
    const later = Date.now() + 60_000;
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'DOCKS', doors: { west: { targetRoomId: 'room-a' } }, updatedAt: later,
    });
    harvestIntoAtlas({
      roomId: 'room-b', name: 'DOCKS',
      doors: [{ doorId: 'west', targetSeed: seed('room-a'), transient: false }],
      owner: { id: 'p-bo', name: 'Bo' },
    });
    bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
    const shared = doc.getMap('atlas').get('room-b') as { owner?: unknown; updatedAt: number };
    expect(shared.owner).toEqual({ id: 'p-bo', name: 'Bo' });
    expect(shared.updatedAt).toBe(later + 1);
  });
});

describe('ships at or near a station', () => {
  const ship = (over: Partial<ShipSummary>): ShipSummary => ({
    roomId: 'ship-x', name: 'X', planetId: 'planet-sovereign', status: 'docked', updatedAt: 1, ...over,
  });

  it('merges the docked ships on the plan with the planet summary', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    const list = visitingShips(plan, [
      ship({ roomId: 'ship-1', name: 'SKIFF', status: 'docked', fromRoom: 'room-a', gate: 2, routeStatus: 'boarding' }),
      ship({ roomId: 'ship-2', name: 'BARGE', status: 'in-flight', toRoom: 'room-a', etaAt: 5000 }),
      ship({ roomId: 'ship-3', name: 'TUG', status: 'in-flight', fromRoom: 'room-a', departedAt: 4000 }),
      ship({ roomId: 'ship-4', name: 'ELSEWHERE', status: 'docked', fromRoom: 'far-1' }),
    ], 'room-a');
    expect(list).toEqual([
      { roomId: 'ship-1', name: 'SKIFF', state: 'docked', gate: 2, routeStatus: 'boarding', onPlan: true },
      { roomId: 'ship-2', name: 'BARGE', state: 'arriving', at: 5000, onPlan: false },
      { roomId: 'ship-3', name: 'TUG', state: 'leaving', at: 4000, onPlan: false },
    ]);
  });

  it('lists a ship still docking here as arriving until it says docked', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    // An arrived ship's record keeps no destination: the summary names the
    // station it is docking at in fromRoom. Its berth may already be on the plan.
    const list = visitingShips(plan, [
      ship({ roomId: 'ship-1', name: 'SKIFF', status: 'redocking', fromRoom: 'room-a', etaAt: 3000 }),
      ship({ roomId: 'ship-2', name: 'BARGE', status: 'redocking', toRoom: 'room-a', etaAt: 5000 }),
      ship({ roomId: 'ship-3', name: 'TUG', status: 'redocking', fromRoom: 'far-1', etaAt: 4000 }),
    ], 'room-a');
    expect(list).toEqual([
      { roomId: 'ship-1', name: 'SKIFF', state: 'arriving', gate: 2, at: 3000, onPlan: true },
      { roomId: 'ship-2', name: 'BARGE', state: 'arriving', at: 5000, onPlan: false },
    ]);
  });

  it('drops a stale berth when the ship says it is somewhere else', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    expect(visitingShips(plan, [], 'room-a').map((s) => s.roomId)).toEqual(['ship-1']);
    const list = visitingShips(plan, [ship({ roomId: 'ship-1', status: 'docked', fromRoom: 'far-1' })], 'room-a');
    expect(list).toEqual([]);
  });

  it('skips retired ships and the station\'s own rooms', () => {
    station();
    const plan = stationPlan(readAtlas(), 'room-a');
    const list = visitingShips(plan, [
      ship({ roomId: 'ship-9', status: 'docked', fromRoom: 'room-a', retired: true }),
      ship({ roomId: 'room-b', status: 'docked', fromRoom: 'room-a' }),
    ], 'room-a');
    expect(list.map((s) => s.roomId)).toEqual(['ship-1']);
    // A retired ship's berth on the plan is no visitor either.
    expect(visitingShips(plan, [ship({ roomId: 'ship-1', status: 'docked', retired: true })], 'room-a')).toEqual([]);
  });
});
