// planetSummary.ts tests: the gates of the room a visitor stands in go out as
// that room's first-hand reading only once this visit has read them (main.ts's
// harvest, after the room's state lands). Until then they are the atlas's copy
// from an earlier visit or from gossip, and never replace a newer reading.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindPlanetSummaryDoc, publishPlanetSummary, unbindPlanetSummaryForTest } from './planetSummary';
import type { StationSummary } from './planetSummary';
import { harvestIntoAtlas } from './stationAtlas';
import { listStations, registerStation } from './stations';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

beforeEach(() => store.clear());
afterEach(() => unbindPlanetSummaryForTest());

describe('the gates of the room a visitor stands in', () => {
  it('go out as its reading only once this visit has read them', () => {
    const now = Date.now();
    registerStation({ id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b' });
    // An earlier visit left room-b's port in this atlas as gate 2.
    harvestIntoAtlas({ roomId: 'room-b', name: 'HUB', doors: [], gates: { south: 2 } });
    // Since then a peer read room-b first-hand: its port is gate 3 now.
    const doc = new Y.Doc();
    const newer: StationSummary = {
      welcomeRoomId: 'room-b', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, updatedAt: now - 60_000,
      berths: [{ roomId: 'room-b', doorId: 'east', gate: 3 }], berthsAt: now - 60_000,
    };
    doc.getMap('stationSummaries').set('room-b', newer);
    let read = false;
    bindPlanetSummaryDoc(doc, {
      currentStation: () => listStations().find((s) => s.id === 'hub') ?? null,
      localTrim: () => null,
      ship: () => null,
      currentRoom: () => 'room-b',
      gatesReadHere: () => read,
    });
    const published = () => (doc.getMap('stationSummaries').get('room-b') as StationSummary | undefined)?.berths;
    // Bound before this visit read the room: the atlas's old gate stays out.
    expect(published()).toEqual([{ roomId: 'room-b', doorId: 'east', gate: 3 }]);
    publishPlanetSummary(now + 1000);
    expect(published()).toEqual([{ roomId: 'room-b', doorId: 'east', gate: 3 }]);
    // This visit's harvest reads the room: its gates are news now.
    harvestIntoAtlas({ roomId: 'room-b', name: 'HUB', doors: [], gates: { east: 3, west: 4 } });
    read = true;
    publishPlanetSummary(now + 2000);
    expect(published()).toEqual([
      { roomId: 'room-b', doorId: 'east', gate: 3 },
      { roomId: 'room-b', doorId: 'west', gate: 4 },
    ]);
  });

  it("go out as gossip any peer's reading beats, for a station with no known list", () => {
    registerStation({ id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b' });
    harvestIntoAtlas({ roomId: 'room-b', name: 'HUB', doors: [], gates: { south: 2 } });
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, {
      currentStation: () => listStations().find((s) => s.id === 'hub') ?? null,
      localTrim: () => null,
      ship: () => null,
      currentRoom: () => 'room-b',
      gatesReadHere: () => false,
    });
    const first = doc.getMap('stationSummaries').get('room-b') as StationSummary;
    expect(first.berths).toEqual([{ roomId: 'room-b', doorId: 'south', gate: 2 }]);
    // No room of it is stamped as read here: any first-hand reading wins.
    expect(first.berthRoomsAt).toEqual({ 'room-b': 0 });
  });

  it('go out stamped as read once this visit reads them, though unchanged', () => {
    // room-c lists no gate: its reading says so all the same.
    for (const [room, gates] of [['room-b', { south: 2 }], ['room-c', {}]] as const) {
      store.clear();
      registerStation({ id: 'hub', name: 'HUB', planetId: 'planet-sovereign', orbitSlot: 3, welcomeRoomId: 'room-b' });
      harvestIntoAtlas({ roomId: 'room-b', name: 'HUB', doors: [{ doorId: 'east', targetSeed: 'ssf://room#room=room-c', transient: false }], gates: { south: 2 } });
      harvestIntoAtlas({ roomId: 'room-c', name: 'WING', doors: [{ doorId: 'west', targetSeed: 'ssf://room#room=room-b', transient: false }], gates: {} });
      const doc = new Y.Doc();
      let read = false;
      bindPlanetSummaryDoc(doc, {
        currentStation: () => listStations().find((s) => s.id === 'hub') ?? null,
        localTrim: () => null,
        ship: () => null,
        currentRoom: () => room,
        gatesReadHere: () => read,
      });
      const stampOf = () => {
        const s = doc.getMap('stationSummaries').get('room-b') as StationSummary;
        return s.berthRoomsAt?.[room] ?? (s.berths?.some((b) => b.roomId === room) ? s.berthsAt : undefined);
      };
      expect(stampOf()).toBe(0);
      // The harvest finds the gates as the atlas had them.
      harvestIntoAtlas({ roomId: room, name: room, doors: [], gates });
      read = true;
      publishPlanetSummary(Date.now() + 1000);
      expect(stampOf()).toBeGreaterThan(0);
      unbindPlanetSummaryForTest();
    }
  });
});
