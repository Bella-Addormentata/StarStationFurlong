/**
 * 🪐 A ship docked at a station this install has not learned yet is placed
 * at no planet (main.ts's planetShipStatus reads null), so nothing goes out
 * for it. When that station's summary arrives, the ship is placed, and what
 * this client says of it goes out then, not at the next heartbeat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setStationTrimResolver } from './orbits';
import { bindPlanetSummaryDoc, unbindPlanetSummaryForTest } from './planetSummary';
import type { PlanetSummaryContext, ShipStatusInput, StationSummary } from './planetSummary';
import { DEFAULT_PLANET_ID, listStations } from './stations';

let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const SOV = DEFAULT_PLANET_ID;

/** Like main.ts's planetShipStatus: the ship's planet is the planet of the
 *  station its flight record names, read from the station list. */
function ship(): ShipStatusInput | null {
  const at = listStations().find((st) => st.welcomeRoomId === 'room-dock');
  return at ? { roomId: 'room-skiff', name: 'SKIFF', planetId: at.planetId, status: 'docked', fromRoom: 'room-dock' } : null;
}

const ctx: PlanetSummaryContext = { currentStation: () => null, localTrim: () => null, ship };

const dock = (): StationSummary => ({
  welcomeRoomId: 'room-dock', name: 'DOCK SEVEN', planetId: SOV, orbitSlot: 3, ownerId: 'a-dock', updatedAt: Date.now(),
});

beforeEach(() => {
  store = new Map();
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});
afterEach(() => {
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});

describe('a ship placed by a station learned later', () => {
  it("goes out as soon as the station's summary arrives", () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, ctx);
    expect(doc.getMap('shipSummaries').size).toBe(0);
    // Another install in the room publishes the station.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getMap('stationSummaries').set('room-dock', dock());
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(listStations().some((st) => st.welcomeRoomId === 'room-dock')).toBe(true);
    expect(doc.getMap('shipSummaries').get('room-skiff')).toMatchObject({
      roomId: 'room-skiff', name: 'SKIFF', planetId: SOV, status: 'docked', fromRoom: 'room-dock',
    });
  });
});
