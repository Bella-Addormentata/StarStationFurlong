// devices.ts tests: the holotable's "you are here" (holotableStation) for a
// ship. A flight under way is at no station, even should engine, tank or
// helm come off mid-trip: main.ts's room-station resolver keeps following
// the flight then (followsFlightRecord), so the room's own station would
// name where the flight left or is bound.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FURNITURE } from './furniture';
import type { FurnitureItem } from './furniture';
import { bindShipDoc, readFlightRecord, writeFlightRecord } from './shipDoc';
import { flightCapable, followsFlightRecord, setStationRoomCheck } from './stationDirectory';
import { DEFAULT_PLANET_ID, registerStation, setRoomStationResolver, setStationRoomSource } from './stations';

// devices.ts hangs debug handles on window as it loads.
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
let holotableStation: typeof import('./devices').holotableStation;
let isShipReady: typeof import('./devices').isShipReady;
beforeAll(async () => {
  ({ holotableStation, isShipReady } = await import('./devices'));
});

let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const T0 = Date.now();
const fitting = (kind: string): FurnitureItem =>
  ({ id: kind, kind: kind as FurnitureItem['kind'], pos: { x: 0, z: 0 }, rot: 0, movable: true });
let saved: FurnitureItem[] = [];

beforeEach(() => {
  store = new Map();
  saved = FURNITURE.splice(0, FURNITURE.length, fitting('engine-block'), fitting('fuel-tank'), fitting('helm-console'));
  bindShipDoc(new Y.Doc());
  registerStation({ id: 'alpha', name: 'ALPHA', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'room-alpha' });
  registerStation({ id: 'beta', name: 'BETA', planetId: DEFAULT_PLANET_ID, orbitSlot: 2, welcomeRoomId: 'room-beta' });
  setStationRoomSource(() => 'room-ship');
  // As main.ts places the room: by its flight record, while it follows it.
  setRoomStationResolver(() => {
    const flight = readFlightRecord();
    return followsFlightRecord(flight.status, flightCapable(isShipReady())) ? flight.locationId : null;
  });
});
afterEach(() => {
  FURNITURE.splice(0, FURNITURE.length, ...saved);
  setRoomStationResolver(null);
  setStationRoomSource(() => '');
  setStationRoomCheck(null);
});

const lose = (kind: string) => FURNITURE.splice(FURNITURE.findIndex((i) => i.kind === kind), 1);

describe('the holotable\'s "you are here" for a ship', () => {
  it('is no station while a flight is under way, even after a fitting comes off', () => {
    expect(writeFlightRecord({ status: 'in-flight', locationId: 'alpha', destinationId: 'beta', departedAt: T0, etaAt: T0 + 60_000 })).toBe(true);
    expect(holotableStation()).toBeNull();
    for (const kind of ['engine-block', 'fuel-tank', 'helm-console']) {
      lose(kind);
      expect(isShipReady()).toBe(false);
      expect(holotableStation()).toBeNull();
    }
  });

  it('is where it is docked, and a module that never flew is its own station', () => {
    expect(writeFlightRecord({ status: 'docked', locationId: 'beta' })).toBe(true);
    expect(holotableStation()?.id).toBe('beta');
    // Without the fittings the docked record is only a default: the room is
    // where the atlas puts it (here, nowhere it knows).
    lose('helm-console');
    expect(holotableStation()).toBeNull();
  });

  it("is a station's own room's own station, whatever its record says", () => {
    registerStation({ id: 'home', name: 'HOME', planetId: DEFAULT_PLANET_ID, orbitSlot: 3, welcomeRoomId: 'room-ship' });
    setStationRoomCheck(() => 'welcome-room');
    expect(writeFlightRecord({ status: 'in-flight', locationId: 'alpha', destinationId: 'beta', departedAt: T0, etaAt: T0 + 60_000 })).toBe(true);
    expect(holotableStation()?.id).toBe('home');
  });

  it('is no station while flown by hand, a ship or a one-module station flying by itself', () => {
    expect(writeFlightRecord({ status: 'docked', locationId: 'beta' })).toBe(true);
    expect(writeFlightRecord({ status: 'free-flight', locationId: 'beta' })).toBe(true);
    expect(holotableStation()).toBeNull();
    registerStation({ id: 'home', name: 'HOME', planetId: DEFAULT_PLANET_ID, orbitSlot: 3, welcomeRoomId: 'room-ship' });
    setStationRoomCheck(() => 'welcome-room');
    lose('engine-block');
    expect(holotableStation()).toBeNull();
  });
});
