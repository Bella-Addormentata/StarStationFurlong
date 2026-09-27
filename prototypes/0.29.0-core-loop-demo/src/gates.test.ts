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
  nextFreeGate,
  readDockGates,
  readDoorPolicy,
  writeDoorPolicy,
} from './doorPolicy';
import {
  bindStationAtlasDoc,
  freeGateNumber,
  harvestIntoAtlas,
  readAtlas,
  stationGates,
} from './stationAtlas';
import { listStations, registerStation } from './stations';
import { foldOwnStation, mergeStation, summaryForStation } from './planetSummary';
import type { StationSummary } from './planetSummary';
import { destinationsFromRecords } from './stationDirectory';

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
});

describe('the per-planet summary', () => {
  const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
  const base = (over: Partial<StationSummary> = {}): StationSummary => ({
    welcomeRoomId: 'room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, updatedAt: T0, ...over,
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
    const older = base({ name: 'NEW', updatedAt: T0 + 5, berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0 });
    const newer = base({ berths: [{ roomId: 'room-b', doorId: 'east', gate: 3 }], berthsAt: T0 + 9 });
    const merged = mergeStation(older, newer)!;
    expect(merged.name).toBe('NEW');
    expect(merged.berths).toEqual([{ roomId: 'room-b', doorId: 'east', gate: 3 }]);
  });

  it('lets any visitor update a derived station\'s gates, though not its slot', () => {
    const known = base({ orbitSlot: 3, berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }], berthsAt: T0 });
    const here = {
      id: 'station:room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-b', derived: true as const,
      berths: [{ roomId: 'room-b', doorId: 'south', gate: 2 }, { roomId: 'room-b', doorId: 'east', gate: 3 }],
    };
    const next = foldOwnStation(known, here, null, T0 + 60_000)!;
    expect(next.orbitSlot).toBe(3);
    expect(next.berths).toHaveLength(2);
    expect(next.berthsAt).toBe(T0 + 60_000);
    // Unchanged gates change nothing.
    expect(foldOwnStation(next, here, null, T0 + 120_000)).toBeNull();
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
});
