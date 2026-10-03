/**
 * ⚓🚦 Numbered gates — the port's stored number (doorPolicy), the station's
 * gates in the atlas and its gossip, the station record's berth list, the
 * shared per-planet summary, and the ship's destinations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_GATE,
  bindDoorPolicy,
  dockGatesIn,
  fitDockPortIn,
  gateAccessIn,
  nextFreeGate,
  readGateAccess,
  readDockGates,
  readUnnumberedPorts,
  readDoorPolicy,
  writeDoorPolicy,
} from './doorPolicy';
import {
  bindStationAtlasDoc,
  freeGateNumber,
  freeGateNumberHere,
  harvestIntoAtlas,
  steppedGateNumberHere,
  readAtlas,
  stationGates,
  withSharedAtlasOf,
} from './stationAtlas';
import { cleanBerths, listStations, registerStation } from './stations';
import type { StationBerthRecord } from './stations';
import { cleanStationSummary, foldOwnStation, mergeStation, registerLearnedStations, summaryForStation } from './planetSummary';
import type { StationSummary } from './planetSummary';
import { destinationsFromRecords } from './stationDirectory';
import { farDockPatch } from './dockRules';
import { arrivalBerths } from './shipArrival';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const seed = (room: string) => `ssf://room#room=${room}`;

beforeEach(() => store.clear());

/** A two-room station: room-a ↔ room-b by a gangway. room-a has gate 1 on
 *  its north port; room-b has gate 2 (a ship docked) and gate 3. */
function twoRoomStation(): void {
  harvestIntoAtlas({
    roomId: 'room-a', name: 'HUB',
    doors: [{ doorId: 'east', targetSeed: seed('room-b'), transient: false }],
    gates: { north: 1 },
  });
  harvestIntoAtlas({
    roomId: 'room-b', name: 'DOCKS',
    doors: [
      { doorId: 'west', targetSeed: seed('room-a'), transient: false },
      { doorId: 'south', targetSeed: seed('ship-1'), transient: true },
    ],
    gates: { south: 2, east: 3 },
  });
}

describe('the gate on a dock port', () => {
  it('is kept only on a port, and only as a whole number in range', () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    writeDoorPolicy('north', { passage: 'public', construction: 'owner', adapter: true, gate: 4 });
    expect(readDoorPolicy('north').gate).toBe(4);
    writeDoorPolicy('east', { passage: 'public', construction: 'owner', adapter: false, gate: 5 });
    expect(readDoorPolicy('east').gate).toBeUndefined();
    doc.getMap('doorPolicy').set('west', { adapter: true, gate: 2.5 });
    doc.getMap('doorPolicy').set('south', { adapter: true, gate: MAX_GATE + 1 });
    expect(readDoorPolicy('west').gate).toBeUndefined();
    expect(readDoorPolicy('south').gate).toBeUndefined();
    expect(readDockGates()).toEqual({ north: 4 });
  });

  it('is cleared when the port is removed', () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    writeDoorPolicy('north', { passage: 'public', construction: 'owner', adapter: true, gate: 4 });
    writeDoorPolicy('north', { ...readDoorPolicy('north'), adapter: false });
    writeDoorPolicy('north', { ...readDoorPolicy('north'), adapter: true });
    expect(readDoorPolicy('north').gate).toBeUndefined();
  });

  it('is given to a port a DOCK fits in the far room', () => {
    const far = new Y.Doc();
    fitDockPortIn(far, 'south', 7);
    expect(dockGatesIn(far)).toEqual({ south: 7 });
    // An existing port keeps its number.
    fitDockPortIn(far, 'south', 9);
    expect(dockGatesIn(far)).toEqual({ south: 7 });
  });

  it('counts only ports on doors the room has', () => {
    const far = new Y.Doc();
    far.getMap('doorLayout').set('south', { id: 'south', wall: 'y+', lateral: 0, placed: true });
    fitDockPortIn(far, 'south', 2);
    far.getMap('doorPolicy').set('d:phantom1', { passage: 'public', construction: 'owner', adapter: true, gate: 1 });
    expect(dockGatesIn(far)).toEqual({ south: 2 });
  });

  it("lists no gate on a door the room's layout has removed", () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    // The layout is authoritative once it holds records: only 'north' remains.
    doc.getMap('doorLayout').set('north', { id: 'north', wall: 'y+', lateral: 0, placed: true });
    doc.getMap('doorPolicy').set('north', { passage: 'public', construction: 'owner', adapter: true, gate: 1 });
    doc.getMap('doorPolicy').set('south', { passage: 'public', construction: 'owner', adapter: true, gate: 2, gateAccess: 'closed' });
    doc.getMap('doorPolicy').set('east', { passage: 'public', construction: 'owner', adapter: true });
    expect(readDockGates()).toEqual({ north: 1 });
    expect(readGateAccess()).toEqual({});
    expect(readUnnumberedPorts()).toEqual([]);
  });

  it('finds a live gate however many stale policy keys come first', () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    for (let i = 0; i < 300; i++) {
      doc.getMap('doorPolicy').set(`d:stale${String(i).padStart(4, '0')}`, { passage: 'public', construction: 'owner', adapter: true, gate: 1 });
    }
    doc.getMap('doorLayout').set('d:live', { id: 'd:live', wall: 'y+', lateral: 0, placed: true });
    doc.getMap('doorPolicy').set('d:live', { passage: 'public', construction: 'owner', adapter: true, gate: 5 });
    expect(readDockGates()).toEqual({ 'd:live': 5 });
    expect(dockGatesIn(doc)).toEqual({ 'd:live': 5 });
  });

  it('finds a live gate however many malformed layout keys come first', () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    for (let i = 0; i < 1100; i++) doc.getMap('doorLayout').set(`d:junk${String(i).padStart(4, '0')}`, { nope: true });
    doc.getMap('doorLayout').set('d:live', { id: 'd:live', wall: 'y+', lateral: 0, placed: true });
    doc.getMap('doorPolicy').set('d:live', { passage: 'public', construction: 'owner', adapter: true, gate: 5 });
    expect(readDockGates()).toEqual({ 'd:live': 5 });
    expect(dockGatesIn(doc)).toEqual({ 'd:live': 5 });
  });

  it('finds a live gate however many valid non-port doors come first', () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    for (let i = 0; i < 300; i++) {
      const id = `d:plain${String(i).padStart(4, '0')}`;
      doc.getMap('doorLayout').set(id, { id, wall: 'y+', lateral: 0, placed: true });
    }
    doc.getMap('doorLayout').set('d:live', { id: 'd:live', wall: 'y+', lateral: 0, placed: true });
    doc.getMap('doorPolicy').set('d:live', { passage: 'public', construction: 'owner', adapter: true, gate: 5 });
    expect(readDockGates()).toEqual({ 'd:live': 5 });
    expect(dockGatesIn(doc)).toEqual({ 'd:live': 5 });
  });

  it('takes the lowest number free in the station', () => {
    expect(nextFreeGate([])).toBe(1);
    expect(nextFreeGate([1, 2, 4])).toBe(3);
    twoRoomStation();
    // room-a's own live gates stand in for its atlas entry.
    expect(freeGateNumber(readAtlas(), 'room-a', { north: 1 })).toBe(4);
    expect(freeGateNumber(readAtlas(), 'room-a', {})).toBe(1);
  });
});

describe('the station atlas', () => {
  it('lists every gate of the station in gate order, taken ones marked', () => {
    twoRoomStation();
    expect(stationGates(readAtlas(), 'room-b')).toEqual([
      { roomId: 'room-a', doorId: 'north', gate: 1, occupied: false },
      { roomId: 'room-b', doorId: 'south', gate: 2, occupied: true },
      { roomId: 'room-b', doorId: 'east', gate: 3, occupied: false },
    ]);
    // The docked ship is not part of the station, and has no gates.
    expect(stationGates(readAtlas(), 'ship-1')).toEqual([]);
  });

  it('gossips gates to peers, cleans junk, and keeps them through an older client\'s silence', () => {
    twoRoomStation();
    const doc = new Y.Doc();
    bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
    expect((doc.getMap('atlas').get('room-b') as { gates?: unknown }).gates).toEqual({ south: 2, east: 3 });

    store.clear();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const b = peer.getMap('atlas').get('room-b') as Record<string, unknown>;
    peer.getMap('atlas').set('room-b', { ...b, gates: { south: 2, east: 3.5, ['x'.repeat(100)]: 4 }, updatedAt: Date.now() + 1 });
    bindStationAtlasDoc(peer, { roomId: 'room-z', isPassagePublic: () => false });
    expect(readAtlas()['room-b']?.gates).toEqual({ south: 2 });
    // An older client's entry carries no gates: what we knew stands.
    const { gates: _g, ...silent } = peer.getMap('atlas').get('room-b') as Record<string, unknown>;
    peer.getMap('atlas').set('room-b', { ...silent, updatedAt: Date.now() + 2 });
    expect(readAtlas()['room-b']?.gates).toEqual({ south: 2 });
  });
});

describe('gate gossip that doors alone would skip', () => {
  it("takes an older doc copy's gates when our newer copy of the room has none", () => {
    harvestIntoAtlas({
      roomId: 'room-b', name: 'DOCKS',
      doors: [
        { doorId: 'west', targetSeed: seed('room-a'), transient: false },
        { doorId: 'north', targetSeed: seed('room-c'), transient: false },
      ],
    });
    expect(readAtlas()['room-b']?.gates).toBeUndefined();
    const doc = new Y.Doc();
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'DOCKS', updatedAt: 1,
      doors: { west: { targetRoomId: 'room-a', farDoor: 'east', transient: false } },
      gates: { south: 2 }, gateAccess: { south: { access: 'closed' } },
    });
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    const b = readAtlas()['room-b']!;
    expect(b.gates).toEqual({ south: 2 });
    expect(b.gateAccess).toEqual({ south: { access: 'closed' } });
    expect(Object.keys(b.doors).sort()).toEqual(['north', 'west']);
  });

  it('keeps a real gate\'s access when a doc copy carries access for many other doors', () => {
    twoRoomStation();
    const doc = new Y.Doc();
    const gateAccess: Record<string, unknown> = {};
    for (let i = 0; i < 120; i++) gateAccess[`junk-${i}`] = { access: 'pass' };
    gateAccess.south = { access: 'closed' };
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'DOCKS', updatedAt: Date.now() + 60_000,
      doors: { west: { targetRoomId: 'room-a', farDoor: 'east', transient: false } },
      gates: { south: 2 }, gateAccess,
    });
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    expect(readAtlas()['room-b']?.gateAccess).toEqual({ south: { access: 'closed' } });
  });

  it("adds our gates to an equally new doc copy that has none, keeping its doors and size", () => {
    twoRoomStation();
    // Our own (older) record of room-b also knows an older size.
    harvestIntoAtlas({
      roomId: 'room-b', name: 'DOCKS', dims: { cols: 5, rows: 5 },
      doors: [
        { doorId: 'west', targetSeed: seed('room-a'), transient: false },
        { doorId: 'south', targetSeed: seed('ship-1'), transient: true },
      ],
      gates: { south: 2, east: 3 },
    });
    const doc = new Y.Doc();
    // An older client's copy of room-b: as new as ours, as many doors, no gates.
    const door = { targetRoomId: 'room-a', farDoor: 'east', transient: false };
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'DOCKS', updatedAt: readAtlas()['room-b']!.lastSeen, dims: { cols: 4, rows: 3 },
      doors: { west: door, south: { targetRoomId: 'ship-1', transient: true } },
    });
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    const b = doc.getMap('atlas').get('room-b') as { gates?: unknown; doors: Record<string, unknown> };
    expect(b.gates).toEqual({ south: 2, east: 3 });
    expect(b.doors.west).toEqual(door);
    // Its newer size stands too.
    expect((b as { dims?: unknown }).dims).toEqual({ cols: 4, rows: 3 });
  });

  it('carries the gates of a room known without door pairings', () => {
    harvestIntoAtlas({ roomId: 'room-lone', name: 'LONE', doors: [], gates: { north: 7 } });
    const doc = new Y.Doc();
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    expect((doc.getMap('atlas').get('room-lone') as { gates?: unknown } | undefined)?.gates).toEqual({ north: 7 });
  });
});

describe("a far room doc's shared atlas", () => {
  const entry = (roomId: string, updatedAt: number, doors: Record<string, unknown>, gates?: Record<string, number>) => ({
    roomId, name: roomId, updatedAt, doors, ...(gates ? { gates } : {}),
  });

  it("walks the far room's station however many other entries the doc holds", () => {
    const doc = new Y.Doc();
    const shared = doc.getMap('atlas');
    for (let i = 0; i < 300; i++) shared.set(`other-${String(i).padStart(3, '0')}`, entry(`other-${String(i).padStart(3, '0')}`, 1, {}));
    shared.set('far-dock', entry('far-dock', 5, { 'd:hall': { targetRoomId: 'far-hub', farDoor: 'd:in', transient: false } }));
    shared.set('far-hub', entry('far-hub', 5, { 'd:in': { targetRoomId: 'far-dock', farDoor: 'd:hall', transient: false } }, { 'd:p1': 1, 'd:p2': 2 }));
    const atlas = withSharedAtlasOf(doc, readAtlas(), 'far-dock');
    expect(freeGateNumber(atlas, 'far-dock', {})).toBe(3);
    // Only that station is read.
    expect(atlas['other-000']).toBeUndefined();
  });

  it('lets no junk door keys use up the gate numbers ahead of a real gate', () => {
    const gates: Record<string, number> = {};
    for (let i = 1; i <= 99; i++) gates[`junk-${i}`] = i;
    gates['d:p2'] = 2;
    const doc = new Y.Doc();
    const shared = doc.getMap('atlas');
    shared.set('far-dock', entry('far-dock', 5, { 'd:hall': { targetRoomId: 'far-hub', farDoor: 'd:in', transient: false } }));
    shared.set('far-hub', entry('far-hub', 5, { 'd:in': { targetRoomId: 'far-dock', farDoor: 'd:hall', transient: false } }, gates));
    const atlas = withSharedAtlasOf(doc, readAtlas(), 'far-dock');
    expect(atlas['far-hub'].gates).toEqual({ 'd:p2': 2 });
    // A port fitted in the dock still finds a number.
    expect(freeGateNumber(atlas, 'far-dock', {})).toBe(1);
    // Gossip reads it the same way.
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    expect(readAtlas()['far-hub']?.gates).toEqual({ 'd:p2': 2 });
  });

  it('keeps the same gates from the same pairs in any order', () => {
    // 99 numbers plus a second port on 5: the same 99 stand whatever order
    // the keys come in.
    const pairs: Array<[string, number]> = Array.from({ length: 99 }, (_, i) => [`d:${String(i + 1).padStart(8, '0')}`, i + 1]);
    pairs.push(['d:0000000a', 5]);
    const read = (order: Array<[string, number]>) => {
      const doc = new Y.Doc();
      doc.getMap('atlas').set('far-hub', entry('far-hub', 5, {}, Object.fromEntries(order)));
      return withSharedAtlasOf(doc, {}, 'far-hub')['far-hub'].gates;
    };
    const forward = read(pairs);
    expect(Object.keys(forward ?? {})).toHaveLength(99);
    expect(read([...pairs].reverse())).toEqual(forward);
    expect(forward?.['d:00000005']).toBe(5);
  });

  it("numbers a port fitted here past the gates of a room only the bound doc still holds", () => {
    const doc = new Y.Doc();
    const shared = doc.getMap('atlas');
    shared.set('here', entry('here', 5, { 'd:hall': { targetRoomId: 'hub', farDoor: 'd:in', transient: false } }));
    shared.set('hub', entry('hub', 5, { 'd:in': { targetRoomId: 'here', farDoor: 'd:hall', transient: false } }, { 'd:p1': 1 }));
    bindStationAtlasDoc(doc, { roomId: 'here', isPassagePublic: () => false });
    // The local atlas has let 'hub' go (evicted past MAX_ENTRIES).
    const local = readAtlas();
    delete local.hub;
    store.set('ssf-station-atlas', JSON.stringify(local));
    expect(freeGateNumber(readAtlas(), 'here', {})).toBe(1);
    expect(freeGateNumberHere('here', {})).toBe(2);
  });

  it("renumbers a gate by hand past the gates of a room only the bound doc still holds", () => {
    const doc = new Y.Doc();
    const shared = doc.getMap('atlas');
    shared.set('here', entry('here', 5, { 'd:hall': { targetRoomId: 'hub', farDoor: 'd:in', transient: false } }));
    shared.set('hub', entry('hub', 5, { 'd:in': { targetRoomId: 'here', farDoor: 'd:hall', transient: false } }, { 'd:p1': 2, 'd:p2': 3 }));
    bindStationAtlasDoc(doc, { roomId: 'here', isPassagePublic: () => false });
    const local = readAtlas();
    delete local.hub;
    store.set('ssf-station-atlas', JSON.stringify(local));
    const own = { 'd:a': 1, 'd:b': 4 };
    // Up from 1 steps over the hub's 2 and 3, and this room's 4.
    expect(steppedGateNumberHere('here', own, 'd:a', 1, 1)).toBe(5);
    // Down from 4 steps over 3 and 2 to 1, which only d:b's own old number frees.
    expect(steppedGateNumberHere('here', own, 'd:b', 4, -1)).toBe(null);
    expect(steppedGateNumberHere('here', { 'd:b': 4 }, 'd:b', 4, -1)).toBe(1);
    expect(steppedGateNumberHere('here', own, 'd:a', 1, -1)).toBe(null);
  });

  it("follows a newer doc copy's re-paired door to the far station's other rooms", () => {
    // We once saw far-dock's hall lead to a room that has since gone.
    harvestIntoAtlas({ roomId: 'far-dock', name: 'DOCK', doors: [{ doorId: 'd:hall', targetSeed: seed('old-room'), transient: false }] });
    const doc = new Y.Doc();
    const shared = doc.getMap('atlas');
    shared.set('far-dock', entry('far-dock', Date.now() + 60_000, { 'd:hall': { targetRoomId: 'far-hub', farDoor: 'd:in', transient: false } }));
    shared.set('far-hub', entry('far-hub', 5, { 'd:in': { targetRoomId: 'far-dock', farDoor: 'd:hall', transient: false } }, { 'd:p1': 1 }));
    expect(freeGateNumber(withSharedAtlasOf(doc, readAtlas(), 'far-dock'), 'far-dock', {})).toBe(2);
  });

  it("drops a door a newer doc copy no longer lists, so a removed module's gates don't count", () => {
    // We once saw far-dock joined to far-old, which used every gate number.
    harvestIntoAtlas({ roomId: 'far-dock', name: 'DOCK', doors: [{ doorId: 'd:aft', targetSeed: seed('far-old'), transient: false }] });
    const all: Record<string, number> = {};
    for (let g = 1; g <= 99; g++) all[`d:g${String(g).padStart(6, '0')}`] = g;
    const doc = new Y.Doc();
    const shared = doc.getMap('atlas');
    shared.set('far-old', entry('far-old', 5, {}, all));
    // The newer copy: that module has been unbolted.
    shared.set('far-dock', entry('far-dock', Date.now() + 60_000, {}));
    const atlas = withSharedAtlasOf(doc, readAtlas(), 'far-dock');
    expect(atlas['far-dock'].doors['d:aft']).toBeUndefined();
    expect(freeGateNumber(atlas, 'far-dock', {})).toBe(1);
  });

  it("keeps our seed for a door a newer doc copy still pairs the same way", () => {
    harvestIntoAtlas({ roomId: 'far-dock', name: 'DOCK', doors: [{ doorId: 'd:hall', targetSeed: seed('far-hub'), transient: false }] });
    const doc = new Y.Doc();
    doc.getMap('atlas').set('far-dock', entry('far-dock', Date.now() + 60_000, { 'd:hall': { targetRoomId: 'far-hub', farDoor: 'd:in', transient: false } }));
    expect(withSharedAtlasOf(doc, readAtlas(), 'far-dock')['far-dock'].doors['d:hall'].targetSeed).toBe(seed('far-hub'));
  });

  it("takes the doc's gates for a known room when the doc's copy is newer", () => {
    harvestIntoAtlas({ roomId: 'room-hub', name: 'HUB', doors: [], gates: { 'd:p1': 1 } });
    const doc = new Y.Doc();
    doc.getMap('atlas').set('room-hub', entry('room-hub', Date.now() + 60_000, {}, { 'd:p1': 1, 'd:p2': 2 }));
    expect(withSharedAtlasOf(doc, readAtlas(), 'room-hub')['room-hub'].gates).toEqual({ 'd:p1': 1, 'd:p2': 2 });
    // An older copy leaves what this client saw alone.
    doc.getMap('atlas').set('room-hub', entry('room-hub', 1, {}, { 'd:p9': 9 }));
    expect(withSharedAtlasOf(doc, readAtlas(), 'room-hub')['room-hub'].gates).toEqual({ 'd:p1': 1 });
  });
});

describe('the station record', () => {
  it('lists the station\'s gates as its berths, and names the lowest welcome-room gate as berthDoor', () => {
    twoRoomStation();
    expect(registerStation({ id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b' })).toBe(true);
    const hub = listStations().find((s) => s.id === 'hub')!;
    expect(hub.berths).toEqual([
      { roomId: 'room-a', doorId: 'north', gate: 1 },
      { roomId: 'room-b', doorId: 'south', gate: 2, occupied: true },
      { roomId: 'room-b', doorId: 'east', gate: 3 },
    ]);
    expect(hub.berthDoor).toBe('south');
  });

  it('replaces a berthDoor that is no longer a welcome-room gate, and drops it when there are none', () => {
    registerStation({ id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, welcomeRoomId: 'room-far', berthDoor: 'north' });
    harvestIntoAtlas({ roomId: 'room-far', name: 'FAR', doors: [], gates: { east: 6, south: 4 } });
    expect(listStations().find((s) => s.id === 'far')?.berthDoor).toBe('south');
    harvestIntoAtlas({ roomId: 'room-far', name: 'FAR', doors: [], gates: {} });
    expect(listStations().find((s) => s.id === 'far')?.berthDoor).toBeUndefined();
  });

  it('keeps a learned berth list for a station this install has not mapped, and reads berthDoor as one berth', () => {
    registerStation({
      id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, welcomeRoomId: 'room-far',
      berths: [{ roomId: 'room-far', doorId: 'east', gate: 5, occupied: true }, { roomId: '', doorId: 'west' }],
    });
    registerStation({ id: 'old', name: 'OLD', planetId: 'planet-sovereign', orbitSlot: 5, welcomeRoomId: 'room-old', berthDoor: 'north' });
    const list = listStations();
    // Saved without the local occupied flag; junk dropped.
    expect(list.find((s) => s.id === 'far')?.berths).toEqual([{ roomId: 'room-far', doorId: 'east', gate: 5 }]);
    expect(list.find((s) => s.id === 'old')?.berths).toEqual([{ roomId: 'room-old', doorId: 'north' }]);
  });

  it('drops learned gates once this atlas knows the room has none, and keeps "none" as news', () => {
    registerStation({
      id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, welcomeRoomId: 'room-far', berthDoor: 'east',
      berths: [{ roomId: 'room-far', doorId: 'east', gate: 5 }],
    });
    // The last port was removed: this client's harvest shows no gates.
    harvestIntoAtlas({ roomId: 'room-far', name: 'FAR', doors: [], gates: {} });
    const far = listStations().find((s) => s.id === 'far')!;
    expect(far.berths).toEqual([]);
    // The empty list is published, stamped, and wins over the older one.
    const out = summaryForStation(far, null, 5_000);
    expect(out.berths).toEqual([]);
    expect(out.berthsAt).toBe(5_000);
    const known: StationSummary = {
      welcomeRoomId: 'room-far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, updatedAt: 1_000,
      berths: [{ roomId: 'room-far', doorId: 'east', gate: 5 }], berthsAt: 1_000,
    };
    expect(mergeStation(known, out)?.berths).toEqual([]);
  });

  it('keeps learned gates in rooms this atlas has not harvested beside the ones it has', () => {
    registerStation({
      id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, welcomeRoomId: 'room-far',
      berths: [{ roomId: 'room-far', doorId: 'east', gate: 1 }, { roomId: 'room-wing', doorId: 'north', gate: 2 }],
    });
    // This client has seen room-far (gate 3 now), never room-wing.
    harvestIntoAtlas({ roomId: 'room-far', name: 'FAR', doors: [], gates: { south: 3 } });
    expect(listStations().find((s) => s.id === 'far')?.berths).toEqual([
      { roomId: 'room-wing', doorId: 'north', gate: 2 },
      { roomId: 'room-far', doorId: 'south', gate: 3 },
    ]);
  });

  it('offers no berth at all for a station known to have no gates', () => {
    const [dest] = destinationsFromRecords([{
      id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, welcomeRoomId: 'room-far', berthDoor: 'east', berths: [],
    }], seed);
    expect(dest.berths).toEqual([]);
    expect(dest.berth).toBeUndefined();
    const remembered = { address: seed('room-far'), farDoor: 'east' } as Parameters<typeof arrivalBerths>[0]['remembered'];
    expect(arrivalBerths({ station: dest, remembered })).toEqual([]);
  });

  it('registers a learned station\'s last gate going away', () => {
    const summary: StationSummary = {
      welcomeRoomId: 'room-far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, updatedAt: 1_000,
      berthDoor: 'east',
    };
    registerLearnedStations('planet-sovereign', [summary]);
    expect(listStations().find((s) => s.welcomeRoomId === 'room-far')?.berths).toEqual([{ roomId: 'room-far', doorId: 'east' }]);
    expect(registerLearnedStations('planet-sovereign', [{ ...summary, berths: [], berthsAt: 2_000 }])).toBe(1);
    expect(listStations().find((s) => s.welcomeRoomId === 'room-far')?.berths).toEqual([]);
  });

  it('never lets ports sharing a number push another gate out', () => {
    const gates: Record<string, number> = {};
    for (let i = 0; i < 120; i++) gates[`d:dup${String(i).padStart(4, '0')}`] = 1;
    gates['d:real'] = 2;
    const doc = new Y.Doc();
    doc.getMap('atlas').set('room-far', { roomId: 'room-far', name: 'FAR', updatedAt: 5, doors: {}, gates });
    expect(withSharedAtlasOf(doc, readAtlas(), 'room-far')['room-far'].gates?.['d:real']).toBe(2);
  });

  it('keeps all 99 gates of one room through the atlas and its gossip', () => {
    const gates: Record<string, number> = {};
    for (let i = 1; i <= 99; i++) gates[`d:${String(i).padStart(8, '0')}`] = i;
    harvestIntoAtlas({ roomId: 'room-full', name: 'FULL', doors: [], gates });
    registerStation({ id: 'full', name: 'FULL', planetId: 'planet-sovereign', orbitSlot: 7, welcomeRoomId: 'room-full' });
    expect(listStations().find((s) => s.id === 'full')?.berths).toHaveLength(99);
    const doc = new Y.Doc();
    doc.getMap('atlas').set('room-far', { roomId: 'room-far', name: 'FAR', updatedAt: 5, doors: {}, gates });
    expect(Object.keys(withSharedAtlasOf(doc, readAtlas(), 'room-far')['room-far'].gates ?? {})).toHaveLength(99);
  });

  it('puts a learned gate list in gate order, whatever order a peer sent', () => {
    expect(cleanBerths([
      { roomId: 'room-b', doorId: 'west' },
      { roomId: 'room-b', doorId: 'east', gate: 3 },
      { roomId: 'room-a', doorId: 'north', gate: 1 },
      { roomId: 'room-b', doorId: 'south', gate: 2 },
    ]).map((b) => b.gate)).toEqual([1, 2, 3, undefined]);
  });

  it('keeps every gate number when a peer floods the list with one number', () => {
    const flood = Array.from({ length: 99 }, (_, i) => ({ roomId: 'room-x', doorId: `d:${String(i).padStart(8, '0')}`, gate: 1 }));
    const out = cleanBerths([...flood, { roomId: 'room-a', doorId: 'north', gate: 2 }]);
    expect(out).toHaveLength(99);
    expect(out.some((b) => b.gate === 2)).toBe(true);
  });

  it('keeps the same berths from the same list in any order', () => {
    // 99 numbers plus a second port on gate 5: one port has to go, and it
    // must be the same one whichever order the list comes in.
    const list: StationBerthRecord[] = Array.from({ length: 99 }, (_, i) => ({ roomId: 'room-a', doorId: `d:${String(i + 1).padStart(8, '0')}`, gate: i + 1 }));
    list.push({ roomId: 'room-b', doorId: 'north', gate: 5 });
    // One port listed twice, differently: the same copy stands either way.
    const twice: StationBerthRecord[] = [
      { roomId: 'room-c', doorId: 'east', gate: 7 },
      { roomId: 'room-c', doorId: 'east', gate: 7, access: 'closed' },
    ];
    for (const v of [list, twice]) {
      const forward = cleanBerths(v);
      expect(cleanBerths([...v].reverse())).toEqual(forward);
      expect(cleanBerths([...v.slice(40), ...v.slice(0, 40)])).toEqual(forward);
    }
    expect(cleanBerths(list).find((b) => b.gate === 5)).toEqual({ roomId: 'room-a', doorId: 'd:00000005', gate: 5 });
  });

  it('keeps the strictest copy of a port listed twice, whatever numbers the copies carry', () => {
    const port = { roomId: 'room-c', doorId: 'east' };
    const open: StationBerthRecord = { ...port, gate: 1 };
    const closed: StationBerthRecord = { ...port, gate: 2, access: 'closed' };
    expect(cleanBerths([open, closed])).toEqual([closed]);
    expect(cleanBerths([closed, open])).toEqual([closed]);
    const pass: StationBerthRecord = { ...port, gate: 1, access: 'pass' };
    const reserved: StationBerthRecord = { ...port, gate: 3, access: 'reserved', reservedFor: 'ship-1' };
    expect(cleanBerths([pass, open, reserved])).toEqual([reserved]);
    expect(cleanBerths([open, pass])).toEqual([pass]);
  });

  it('merges full gate lists from two rooms alike in either order', () => {
    const T = Date.UTC(2026, 8, 27, 10, 0, 0);
    const summary = (over: Partial<StationSummary>): StationSummary => ({
      welcomeRoomId: 'room-a', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, updatedAt: T, ownerId: 'hub', ...over,
    });
    const a = summary({
      berths: Array.from({ length: 99 }, (_, i) => ({ roomId: 'room-a', doorId: `d:${String(i + 1).padStart(8, '0')}`, gate: i + 1 })),
      berthsAt: T,
    });
    const b = summary({ berths: [{ roomId: 'room-b', doorId: 'north', gate: 5 }], berthsAt: T + 5 });
    const ab = (mergeStation(a, b) ?? a).berths;
    const ba = (mergeStation(b, a) ?? b).berths;
    expect(ab).toHaveLength(99);
    expect(ba).toEqual(ab);
  });

  it('rejects a peer gate list longer than any station lists, rather than trusting a prefix', () => {
    const flood = Array.from({ length: 396 }, (_, i) => ({ roomId: 'room-x', doorId: `d:${String(i).padStart(8, '0')}`, gate: 1 }));
    expect(cleanBerths([...flood, { roomId: 'room-a', doorId: 'north', gate: 2 }])).toEqual([]);
  });

  it("keeps a record's extra fields beside a long gate list", () => {
    const berths = Array.from({ length: 40 }, (_, i) => ({ roomId: 'room-far', doorId: `d:${String(i + 1).padStart(8, '0')}`, gate: i + 1 }));
    registerStation({ id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 4, welcomeRoomId: 'room-far', berths, tow: { by: 'tug' } } as Parameters<typeof registerStation>[0]);
    const saved = JSON.parse(store.get('ssf-stations') ?? '[]') as Array<Record<string, unknown>>;
    expect(saved.find((r) => r.id === 'far')?.tow).toEqual({ by: 'tug' });
  });

  it('lists every gate up to the highest number', () => {
    const gates: Record<string, number> = {};
    for (let i = 1; i <= 20; i++) gates[`d:${String(i).padStart(8, '0')}`] = i;
    harvestIntoAtlas({ roomId: 'room-big', name: 'BIG', doors: [], gates });
    registerStation({ id: 'big', name: 'BIG', planetId: 'planet-sovereign', orbitSlot: 6, welcomeRoomId: 'room-big' });
    expect(listStations().find((s) => s.id === 'big')?.berths).toHaveLength(20);
  });
});

describe('the per-planet summary', () => {
  const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
  const base = (over: Partial<StationSummary> = {}): StationSummary => ({
    welcomeRoomId: 'room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, updatedAt: T0, ...over,
  });

  it('drops a summary\'s gates when its room stamps are oversized', () => {
    const stamps: Record<string, number> = {};
    for (let i = 0; i < 200; i++) stamps[`room-${i}`] = T0;
    const s = cleanStationSummary({
      ...base(), berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0, berthRoomsAt: stamps,
    }, T0);
    expect(s?.berths).toBeUndefined();
    expect(s?.name).toBe('HUB');
  });

  it('keeps every listed room\'s own gate stamp when room tombstones overflow the cap', () => {
    const berths = Array.from({ length: 99 }, (_, i) => ({ roomId: `room-${String(i).padStart(2, '0')}`, doorId: 'south', gate: i + 1 }));
    const full = base({ ownerId: 'hub', berths, berthsAt: T0 });
    // A later reading of a room that no longer lists any gate.
    const gone = base({ ownerId: 'hub', berths: [], berthsAt: T0 + 5, berthRoomsAt: { 'room-zz': T0 + 5 } });
    for (const merged of [mergeStation(full, gone)!, mergeStation(gone, full)!]) {
      expect(merged.berths).toHaveLength(99);
      for (const b of merged.berths!) expect(merged.berthRoomsAt?.[b.roomId] ?? merged.berthsAt).toBe(T0);
    }
  });

  it('keeps a room\'s removal beside a full list, so an older copy cannot bring its gate back', () => {
    const berths = Array.from({ length: 99 }, (_, i) => ({ roomId: `room-${String(i).padStart(2, '0')}`, doorId: 'south', gate: i + 1 }));
    const full = base({ ownerId: 'hub', berths, berthsAt: T0 });
    const gone = base({ ownerId: 'hub', berths: [], berthsAt: T0 + 5, berthRoomsAt: { 'room-zz': T0 + 5 } });
    // An offline copy from before room-zz's gate was removed.
    const old = base({ ownerId: 'hub', berths: [{ roomId: 'room-zz', doorId: 'north', gate: 1 }], berthsAt: T0 + 1 });
    for (const merged of [mergeStation(full, gone)!, mergeStation(gone, full)!]) {
      expect(merged.berthRoomsAt?.['room-zz']).toBe(T0 + 5);
      const again = cleanStationSummary(merged, T0 + 10)!;
      expect(again.berthRoomsAt?.['room-zz']).toBe(T0 + 5);
      const after = mergeStation(again, old) ?? again;
      expect(after.berths!.some((b) => b.roomId === 'room-zz')).toBe(false);
    }
  });

  it('keeps the removal of every room a full list held', () => {
    const rooms = Array.from({ length: 99 }, (_, i) => `room-${String(i).padStart(2, '0')}`);
    const full = base({ ownerId: 'hub', berths: rooms.map((roomId, i) => ({ roomId, doorId: 'south', gate: i + 1 })), berthsAt: T0 });
    const stamps: Record<string, number> = {};
    for (const room of rooms) stamps[room] = T0 + 5;
    const cleared = base({ ownerId: 'hub', berths: [], berthsAt: T0 + 5, berthRoomsAt: stamps });
    for (const merged of [mergeStation(full, cleared) ?? full, mergeStation(cleared, full) ?? cleared]) {
      const again = cleanStationSummary(merged, T0 + 10)!;
      expect(again.berths).toEqual([]);
      expect(Object.keys(again.berthRoomsAt ?? {})).toHaveLength(99);
      expect(mergeStation(again, full) ?? again).toEqual(again);
    }
  });

  it('moves the legacy berth to the welcome room\'s lowest merged gate, or drops it', () => {
    const known = base({ berthDoor: 'south', berths: [{ roomId: 'room-b', doorId: 'south', gate: 1 }], berthsAt: T0 });
    // The welcome room renumbered: south is gone, east and west are its gates.
    const moved = mergeStation(known, base({
      berths: [{ roomId: 'room-b', doorId: 'west', gate: 3 }, { roomId: 'room-b', doorId: 'east', gate: 2 }], berthsAt: T0 + 5,
    }))!;
    expect(moved.berthDoor).toBe('east');
    // Then it lists none at all.
    const none = mergeStation(moved, base({ berths: [], berthsAt: T0 + 9, berthRoomsAt: { 'room-b': T0 + 9 } }))!;
    expect(none.berthDoor).toBeUndefined();
  });

  it('settles a merged gate list with a cleaned copy of itself', () => {
    const one = base({ ownerId: 'beta', trim: { planetId: 'planet-sovereign', slot: 3, dRadiusKm: 1, dPhase: 0, at: T0, last: 'raise' } as never });
    const two = base({ ownerId: 'alpha', berths: [{ roomId: 'room-b', doorId: 'east', gate: 2 }], berthsAt: T0 + 5 });
    const merged = mergeStation(one, two)!;
    const copy = cleanStationSummary(merged, T0 + 10)!;
    expect(JSON.stringify(copy)).toBe(JSON.stringify(merged));
    expect(mergeStation(copy, merged)).toBeNull();
    expect(mergeStation(merged, copy)).toBeNull();
  });

  it('shares gates without the local occupied flag', () => {
    const s = summaryForStation({
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b', derived: true,
      berths: [{ roomId: 'room-b', doorId: 'south', gate: 2, occupied: true }],
    }, null, T0);
    expect(s.berths).toEqual([{ roomId: 'room-b', doorId: 'south', gate: 2 }]);
    expect(s.berthsAt).toBe(T0);
  });

  it('takes the newer gate list apart from the record', () => {
    const older = base({ name: 'NEW', ownerId: 'hub', updatedAt: T0 + 5, berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0 });
    const newer = base({ ownerId: 'hub', berths: [{ roomId: 'room-b', doorId: 'east', gate: 3 }], berthsAt: T0 + 9 });
    const merged = mergeStation(older, newer)!;
    expect(merged.name).toBe('NEW');
    expect(merged.berths).toEqual([{ roomId: 'room-b', doorId: 'east', gate: 3 }]);
  });

  it('settles gate lists read the same moment alike, in either merge order', () => {
    const one = base({ ownerId: 'hub', berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0 });
    const two = base({ ownerId: 'hub', berths: [{ roomId: 'room-b', doorId: 'east', gate: 3 }], berthsAt: T0 });
    expect(mergeStation(one, two)?.berths ?? one.berths).toEqual(mergeStation(two, one)?.berths ?? two.berths);
  });

  it('lets any visitor update a derived station\'s gates, though not its slot', () => {
    const known = base({ orbitSlot: 3, berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0 });
    const here = {
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-b', derived: true as const,
      berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }, { roomId: 'room-b', doorId: 'east', gate: 3 }],
    };
    const next = foldOwnStation(known, here, null, T0 + 60_000, 'room-b')!;
    expect(next.orbitSlot).toBe(3);
    expect(next.berths).toHaveLength(2);
    expect(next.berthsAt).toBe(T0 + 60_000);
    // Unchanged gates change nothing.
    expect(foldOwnStation(next, here, null, T0 + 120_000, 'room-b')).toBeNull();
  });

  it("stamps only the visitor's room fresh on a station's first publication", () => {
    const here = {
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-b', derived: true as const,
      berths: [{ roomId: 'room-a', doorId: 'west', gate: 5 }, { roomId: 'room-b', doorId: 'south', gate: 2 }],
    };
    const first = foldOwnStation(undefined, here, null, T0 + 60_000, 'room-b')!;
    // An earlier summary read room-a first-hand: its gate 1 beats our atlas's old gate 5.
    const earlier = base({ berths: [{ roomId: 'room-a', doorId: 'west', gate: 1 }], berthsAt: T0, berthRoomsAt: { 'room-b': T0 } });
    const want = [{ roomId: 'room-a', doorId: 'west', gate: 1 }, { roomId: 'room-b', doorId: 'south', gate: 2 }];
    expect(mergeStation(earlier, first)?.berths).toEqual(want);
    expect(mergeStation(first, earlier)?.berths).toEqual(want);
  });

  it("keeps the known per-room gate stamps when an owned record changes", () => {
    const known = base({
      ownerId: 'hub',
      berths: [{ roomId: 'room-a', doorId: 'west', gate: 1 }, { roomId: 'room-b', doorId: 'south', gate: 2 }],
      berthsAt: T0,
    });
    // Our own record, renamed; our atlas still shows room-a's old gate 5.
    const mineRec = {
      id: 'hub', name: 'HUB PRIME', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b',
      berths: [{ roomId: 'room-a', doorId: 'west', gate: 5 }, { roomId: 'room-b', doorId: 'south', gate: 2 }],
    };
    const next = foldOwnStation(known, mineRec, null, T0 + 60_000, 'room-b')!;
    expect(next.name).toBe('HUB PRIME');
    expect(next.berths).toEqual(known.berths);
  });

  it("replaces only the gates of the room the visitor stands in", () => {
    const known = base({
      berths: [{ roomId: 'room-a', doorId: 'west', gate: 1 }, { roomId: 'room-b', doorId: 'south', gate: 2 }],
      berthsAt: T0,
    });
    // An old atlas still shows room-a's port as gate 5; only room-b is first-hand.
    const here = {
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-b', derived: true as const,
      berths: [
        { roomId: 'room-a', doorId: 'west', gate: 5 },
        { roomId: 'room-b', doorId: 'south', gate: 2 }, { roomId: 'room-b', doorId: 'east', gate: 3 },
      ],
    };
    const next = foldOwnStation(known, here, null, T0 + 60_000, 'room-b')!;
    expect(next.berths).toEqual([
      { roomId: 'room-a', doorId: 'west', gate: 1 },
      { roomId: 'room-b', doorId: 'south', gate: 2 }, { roomId: 'room-b', doorId: 'east', gate: 3 },
    ]);
    expect(foldOwnStation(next, here, null, T0 + 120_000, 'room-b')).toBeNull();
  });

  it('keeps a gate-less room as news when the known summary had no gate list yet', () => {
    const known = base();
    delete known.berths;
    delete known.berthsAt;
    const here = {
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-b', derived: true as const,
      berths: [] as StationBerthRecord[],
    };
    const next = foldOwnStation(known, here, null, T0 + 60_000, 'room-b')!;
    expect(next.berths).toEqual([]);
    // An older peer list still showing a gate there cannot bring it back.
    const older = base({ berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0 });
    expect(mergeStation(next, older)?.berths ?? next.berths).toEqual([]);
    expect(mergeStation(older, next)?.berths).toEqual([]);
  });

  it('keeps each room\'s newest gates when two visitors publish from stale copies', () => {
    const known = base({
      berths: [{ roomId: 'room-a', doorId: 'west', gate: 1 }, { roomId: 'room-b', doorId: 'south', gate: 2 }],
      berthsAt: T0,
    });
    const station = (berths: StationBerthRecord[]) => ({
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-b', derived: true as const, berths,
    });
    // A visitor in room-a closes its gate 1 and opens gate 4 instead.
    const inA = foldOwnStation(known, station([
      { roomId: 'room-a', doorId: 'north', gate: 4 }, { roomId: 'room-b', doorId: 'south', gate: 2 },
    ]), null, T0 + 60_000, 'room-a')!;
    // Later, a visitor in room-b, still holding the old room-a gate, adds gate 3.
    const inB = foldOwnStation(known, station([
      { roomId: 'room-a', doorId: 'west', gate: 1 },
      { roomId: 'room-b', doorId: 'south', gate: 2 }, { roomId: 'room-b', doorId: 'east', gate: 3 },
    ]), null, T0 + 120_000, 'room-b')!;
    const want = [
      { roomId: 'room-b', doorId: 'south', gate: 2 }, { roomId: 'room-b', doorId: 'east', gate: 3 },
      { roomId: 'room-a', doorId: 'north', gate: 4 },
    ];
    expect(mergeStation(inA, inB)?.berths).toEqual(want);
    expect(mergeStation(inB, inA)?.berths).toEqual(want);
    // Merged either way, the result is one value.
    expect(mergeStation(inA, inB)).toEqual(mergeStation(inB, inA));
  });
});

describe('ship destinations', () => {
  it('offer every gate this client holds a pass for, in gate order', () => {
    const [dest] = destinationsFromRecords([{
      id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b', berthDoor: 'south',
      berths: [
        { roomId: 'room-a', doorId: 'north', gate: 1 },
        { roomId: 'room-b', doorId: 'south', gate: 2, occupied: true },
        { roomId: 'room-c', doorId: 'east', gate: 3 },
      ],
    }], (room) => (room === 'room-c' ? undefined : seed(room)));
    expect(dest.berths).toEqual([
      { address: seed('room-a'), farDoor: 'north', gate: 1 },
      { address: seed('room-b'), farDoor: 'south', gate: 2, occupied: true },
    ]);
    // The public berth names its gate.
    expect(dest.berth).toEqual({ address: seed('room-b'), farDoor: 'south', gate: 2, occupied: true });
  });

  it('drops a public berth that is not one of the listed gates', () => {
    const [dest] = destinationsFromRecords([{
      id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b', berthDoor: 'west',
      berths: [{ roomId: 'room-c', doorId: 'east', gate: 3 }],
    }], (room) => (room === 'room-c' ? undefined : seed(room)));
    expect(dest.berths).toEqual([]);
    expect(dest.berth).toBeUndefined();
  });
});

describe('an arriving ship\'s memory', () => {
  it('is not asked in a room whose listed gates it matches none of', () => {
    const station = { berths: [{ address: seed('room-far'), farDoor: 'east', gate: 1, access: 'closed' as const }] };
    // A legacy memory without its door.
    const remembered = { address: seed('room-far') } as Parameters<typeof arrivalBerths>[0]['remembered'];
    expect(arrivalBerths({ station, remembered })).toEqual([]);
    // One of the room's open gates, remembered, is asked.
    const open = { berths: [...station.berths, { address: seed('room-far'), farDoor: 'west', gate: 2 }] };
    const west = { address: seed('room-far'), farDoor: 'west' } as Parameters<typeof arrivalBerths>[0]['remembered'];
    expect(arrivalBerths({ station: open, remembered: west }).map((b) => b.farDoor)).toEqual(['west']);
  });

  it('reaches a gate this client holds no pass for through the ship\'s memory of it', () => {
    const [dest] = destinationsFromRecords([{
      id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b',
      berths: [
        { roomId: 'room-c', doorId: 'east', gate: 3, access: 'reserved', reservedFor: 'ship-1' },
        { roomId: 'room-c', doorId: 'west', gate: 4, access: 'closed' },
      ],
    }], () => undefined);
    expect(dest.berths).toEqual([]);
    const east = { address: seed('room-c'), farDoor: 'east' } as Parameters<typeof arrivalBerths>[0]['remembered'];
    expect(arrivalBerths({ station: dest, remembered: east, shipRoomId: 'ship-1' }).map((b) => b.gate)).toEqual([3]);
    // Reserved for another ship, or closed: still not asked.
    expect(arrivalBerths({ station: dest, remembered: east, shipRoomId: 'ship-2' })).toEqual([]);
    const west = { address: seed('room-c'), farDoor: 'west' } as Parameters<typeof arrivalBerths>[0]['remembered'];
    expect(arrivalBerths({ station: dest, remembered: west, shipRoomId: 'ship-1' }).map((b) => b.gate)).toEqual([3]);
  });
});

describe('who may dock at a gate', () => {
  const near = { roomId: 'ship-1', address: seed('ship-1'), doorId: 'north' };

  it('is stored on the port, cleaned, and cleared with it', () => {
    const doc = new Y.Doc();
    bindDoorPolicy(doc);
    writeDoorPolicy('north', { passage: 'public', construction: 'owner', adapter: true, gate: 1, gateAccess: 'reserved', reservedFor: 'ship-1' });
    writeDoorPolicy('east', { passage: 'public', construction: 'owner', adapter: true, gate: 2, gateAccess: 'closed' });
    doc.getMap('doorPolicy').set('west', { adapter: true, gate: 3, gateAccess: 'reserved' }); // no ship named
    doc.getMap('doorPolicy').set('south', { adapter: true, gate: 4, gateAccess: 'vip' });
    // A restriction that cannot be read closes the gate rather than open it.
    expect(readGateAccess()).toEqual({
      north: { access: 'reserved', reservedFor: 'ship-1' },
      east: { access: 'closed' },
      west: { access: 'closed' },
      south: { access: 'closed' },
    });
    writeDoorPolicy('east', { ...readDoorPolicy('east'), adapter: false });
    expect(readDoorPolicy('east').gateAccess).toBeUndefined();
  });

  it('is enforced at the far end of a DOCK', () => {
    const berth = { exists: true, portFlag: true };
    const dock = (gate: Parameters<typeof farDockPatch>[5]) => farDockPatch(undefined, berth, near, 5000, undefined, gate);
    expect(dock(undefined).action).toBe('write');
    expect(dock({ access: 'open' }).action).toBe('write');
    expect(dock({ access: 'closed' })).toEqual({ action: 'refuse', reason: 'not-allowed' });
    expect(dock({ access: 'reserved', reservedFor: 'ship-2' })).toEqual({ action: 'refuse', reason: 'not-allowed' });
    expect(dock({ access: 'reserved', reservedFor: 'ship-1' }).action).toBe('write');
    expect(dock({ access: 'pass', granted: false })).toEqual({ action: 'refuse', reason: 'not-allowed' });
    expect(dock({ access: 'pass', granted: true }).action).toBe('write');
  });

  it('reads the owner\'s grant at the door for a gate open to granted captains', () => {
    const far = new Y.Doc();
    far.getMap('doorPolicy').set('south', { adapter: true, gate: 2, gateAccess: 'pass' });
    far.getMap('doorGrants').set('south|pub-a', { doorId: 'south', pub: 'pub-a', name: 'A', grantedAt: 1 });
    expect(gateAccessIn(far, 'south', 'pub-a')).toEqual({ access: 'pass', granted: true });
    expect(gateAccessIn(far, 'south', 'pub-b')).toEqual({ access: 'pass', granted: false });
    expect(gateAccessIn(far, 'north')).toEqual({ access: 'open', granted: false });
  });

  it('refuses a DOCK at a gate whose stored access cannot be read', () => {
    const far = new Y.Doc();
    const policies = far.getMap('doorPolicy');
    policies.set('north', { adapter: true, gate: 1, gateAccess: 'reserved' }); // no ship named
    policies.set('east', { adapter: true, gate: 2, gateAccess: 'reserved', reservedFor: 'x'.repeat(129) });
    policies.set('south', { adapter: true, gate: 3, gateAccess: 'vip' });
    policies.set('west', { adapter: true, gate: 4, gateAccess: 7 });
    far.getMap('doorGrants').set('south|pub-a', { doorId: 'south', pub: 'pub-a', name: 'A', grantedAt: 1 });
    const berth = { exists: true, portFlag: true };
    for (const door of ['north', 'east', 'south', 'west']) {
      const access = gateAccessIn(far, door, 'pub-a');
      expect(access.access).toBe('closed');
      expect(farDockPatch(undefined, berth, near, 5000, undefined, access)).toEqual({ action: 'refuse', reason: 'not-allowed' });
    }
    // Only no access at all, or an explicit open, leaves a gate open.
    policies.set('north', { adapter: true, gate: 1 });
    policies.set('east', { adapter: true, gate: 2, gateAccess: 'open' });
    expect(gateAccessIn(far, 'north')).toEqual({ access: 'open', granted: false });
    expect(gateAccessIn(far, 'east')).toEqual({ access: 'open', granted: false });
  });

  it('closes a gate whose access a peer sent unreadable, in the atlas and in a station\'s berths', () => {
    twoRoomStation();
    const doc = new Y.Doc();
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'DOCKS', updatedAt: Date.now() + 60_000,
      doors: { west: { targetRoomId: 'room-a', farDoor: 'east', transient: false } },
      gates: { south: 2, east: 3, north: 4, 'd:00000005': 5 },
      gateAccess: { south: { access: 'reserved' }, east: { access: 'vip' }, north: 'closed', 'd:00000005': { access: 'open' } },
    });
    bindStationAtlasDoc(doc, { roomId: 'room-z', isPassagePublic: () => false });
    expect(readAtlas()['room-b']?.gateAccess).toEqual({
      south: { access: 'closed' }, east: { access: 'closed' }, north: { access: 'closed' },
    });

    expect(cleanBerths([
      { roomId: 'room-b', doorId: 'south', gate: 2, access: 'reserved' },
      { roomId: 'room-b', doorId: 'east', gate: 3, access: 'vip' },
      { roomId: 'room-b', doorId: 'north', gate: 4, access: 'open' },
      { roomId: 'room-b', doorId: 'd:00000005', gate: 5 },
    ])).toEqual([
      { roomId: 'room-b', doorId: 'south', gate: 2, access: 'closed' },
      { roomId: 'room-b', doorId: 'east', gate: 3, access: 'closed' },
      { roomId: 'room-b', doorId: 'north', gate: 4 },
      { roomId: 'room-b', doorId: 'd:00000005', gate: 5 },
    ]);
  });

  it('travels with the gates to the station record', () => {
    harvestIntoAtlas({
      roomId: 'room-a', name: 'HUB', doors: [],
      gates: { north: 1, east: 2 },
      gateAccess: { east: { access: 'reserved', reservedFor: 'ship-9' } },
    });
    expect(stationGates(readAtlas(), 'room-a')).toEqual([
      { roomId: 'room-a', doorId: 'north', gate: 1, occupied: false },
      { roomId: 'room-a', doorId: 'east', gate: 2, occupied: false, access: 'reserved', reservedFor: 'ship-9' },
    ]);
    registerStation({ id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-a' });
    const hub = listStations().find((st) => st.id === 'hub')!;
    expect(hub.berths?.[1]).toEqual({ roomId: 'room-a', doorId: 'east', gate: 2, access: 'reserved', reservedFor: 'ship-9' });
    // The summary keeps it (cleanBerths).
    expect(summaryForStation(hub, null, 1).berths?.[1]).toMatchObject({ access: 'reserved', reservedFor: 'ship-9' });
  });

  it('decides which gates an arriving ship asks, and in what order', () => {
    const g = (n: number, extra: object = {}) => ({ address: seed('room-a'), farDoor: `d:0000000${n}`, gate: n, ...extra });
    const order = (shipRoomId: string) => arrivalBerths({
      station: { berths: [
        g(1, { access: 'closed' }),
        g(2, { access: 'pass' }),
        g(3),
        g(4, { access: 'reserved', reservedFor: 'ship-1' }),
        g(5, { access: 'reserved', reservedFor: 'ship-2' }),
      ] },
      remembered: null,
      shipRoomId,
    }).map((b) => b.gate);
    // Its own reserved gate first, then open ones, then granted-captain gates;
    // never a closed gate or another ship's.
    expect(order('ship-1')).toEqual([4, 3, 2]);
    expect(order('ship-3')).toEqual([3, 2]);
  });

  it('asks granted-captain gates after every open one, taken-looking ones too', () => {
    const g = (n: number, extra: object = {}) => ({ address: seed('room-a'), farDoor: `d:0000000${n}`, gate: n, ...extra });
    const order = arrivalBerths({
      station: { berths: [g(1, { access: 'pass' }), g(2, { occupied: true }), g(3, { access: 'pass', occupied: true }), g(4)] },
      remembered: null,
    }).map((b) => b.gate);
    expect(order).toEqual([4, 2, 1, 3]);
  });

  it('does not ask a remembered berth the station now closes or reserves for another ship', () => {
    const g = (n: number, extra: object = {}) => ({ address: seed('room-a'), farDoor: `d:0000000${n}`, gate: n, ...extra });
    const remembered = { address: seed('room-a'), farDoor: 'd:00000001' } as Parameters<typeof arrivalBerths>[0]['remembered'];
    const ask = (access: object) => arrivalBerths({
      station: { berths: [g(1, access), g(2)] }, remembered, shipRoomId: 'ship-1',
    }).map((b) => b.farDoor);
    expect(ask({ access: 'closed' })).toEqual(['d:00000002']);
    expect(ask({ access: 'reserved', reservedFor: 'ship-2' })).toEqual(['d:00000002']);
    expect(ask({ access: 'reserved', reservedFor: 'ship-1' })).toEqual(['d:00000001', 'd:00000002']);
  });
});
