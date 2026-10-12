/**
 * 🪐 Two installs that each saved one place: the install whose record lost
 * (mergeStation's rival owners) takes the standing record whole, under its
 * own id: its name, its berth and a newer build's fields, not only its
 * planet and slot, so every install registers the same station.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setStationTrimResolver } from './orbits';
import {
  bindPlanetSummaryDoc,
  foldOwnStation,
  publishPlanetSummary,
  readStore,
  registerLearnedStations,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import type { PlanetSummaryContext, StationSummary } from './planetSummary';
import { DEFAULT_PLANET_ID, listStations, readStationRecords, registerStation } from './stations';
import type { StationRecord } from './stations';

// Each "install" is its own localStorage.
let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const SOV = DEFAULT_PLANET_ID;
const T0 = Date.UTC(2026, 9, 3, 21, 0, 0);
// A newer build's record field, unknown here and on every branch below.
const beacon = { color: 'amber', pulseMs: 800 };

const record = (over: Partial<StationRecord> & Record<string, unknown> = {}): StationRecord => ({
  id: 'b-hab',
  name: 'HAB B',
  planetId: SOV,
  orbitSlot: 5,
  welcomeRoomId: 'room-hab',
  ...over,
});

/** What another install's standing record of the same place says. */
const standing = (over: Partial<StationSummary> = {}): StationSummary => ({
  welcomeRoomId: 'room-hab',
  name: 'HAB RING',
  planetId: SOV,
  orbitSlot: 2,
  berthDoor: 'd:3',
  ownerId: 'a-hab',
  ext: { beacon },
  updatedAt: T0,
  ...over,
});

const saved = (id: string) => readStationRecords().find((r) => r.id === id) as
  (StationRecord & Record<string, unknown>) | undefined;

function install(stationId: string): PlanetSummaryContext {
  return {
    currentStation: () => listStations().find((s) => s.id === stationId) ?? null,
    localTrim: () => null,
    ship: () => null,
  };
}

beforeEach(() => {
  store = new Map();
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});
afterEach(() => {
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});

describe("a losing install's own record of a place", () => {
  it("takes the standing record's name, berth and newer fields under its own id", () => {
    registerStation(record({ berthDoor: 'd:5', paint: 'red' }));
    expect(registerLearnedStations(SOV, [standing()])).toBe(1);
    expect(saved('b-hab')).toEqual({
      beacon, id: 'b-hab', name: 'HAB RING', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'room-hab', berthDoor: 'd:3',
    });
    // Nothing is left to change.
    expect(registerLearnedStations(SOV, [standing()])).toBe(0);
  });

  it('follows the standing record when only its name, berth or extra fields differ', () => {
    registerStation(record({ orbitSlot: 2, berthDoor: 'd:3' }));
    expect(registerLearnedStations(SOV, [standing({ ext: undefined })])).toBe(1);
    expect(saved('b-hab')?.name).toBe('HAB RING');
    // A berth the standing record no longer names goes here too…
    expect(registerLearnedStations(SOV, [standing({ ext: undefined, berthDoor: undefined })])).toBe(1);
    expect(saved('b-hab')).not.toHaveProperty('berthDoor');
    // …and so does a field it no longer carries.
    expect(registerLearnedStations(SOV, [standing()])).toBe(1);
    expect(saved('b-hab')?.beacon).toEqual(beacon);
    expect(registerLearnedStations(SOV, [standing({ ext: undefined, berthDoor: undefined })])).toBe(1);
    expect(saved('b-hab')).not.toHaveProperty('beacon');
  });

  it('stays as it is while its own install is the one standing', () => {
    registerStation(record({ berthDoor: 'd:5', paint: 'red' }));
    const before = saved('b-hab');
    expect(registerLearnedStations(SOV, [standing({ ownerId: 'b-hab' })])).toBe(0);
    expect(registerLearnedStations(SOV, [standing({ ownerId: undefined })])).toBe(0);
    expect(saved('b-hab')).toEqual(before);
  });

  it('two installs sharing one room doc register the same station, with nothing to republish', () => {
    // Install A saved HAB RING as 'a-hab', berth d:3, with a newer field.
    registerStation(record({ id: 'a-hab', name: 'HAB RING', orbitSlot: 2, berthDoor: 'd:3', beacon }));
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install('a-hab'));
    // Install B saved the same place as 'b-hab' under another name and berth.
    unbindPlanetSummaryForTest();
    store = new Map();
    registerStation(record({ berthDoor: 'd:5' }));
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    bindPlanetSummaryDoc(docB, install('b-hab'));
    expect(readStore().stations['room-hab']?.ownerId).toBe('a-hab');
    // B's own id stays known as the place's alias, so a flight record
    // written on B still resolves on every other install.
    expect(readStore().stations['room-hab']?.ownerAliases).toEqual(['b-hab']);
    const b = listStations().find((s) => s.id === 'b-hab') as (StationRecord & Record<string, unknown>) | undefined;
    expect(b).toMatchObject({ name: 'HAB RING', orbitSlot: 2, berthDoor: 'd:3', beacon });
    const before = JSON.stringify(docB.getMap('stationSummaries').toJSON());
    publishPlanetSummary(Date.now() + 1000);
    expect(JSON.stringify(docB.getMap('stationSummaries').toJSON())).toBe(before);
  });
});

describe("an install's own record that says what the known one says", () => {
  const known = (over: Partial<StationSummary> = {}): StationSummary => ({
    welcomeRoomId: 'room-hab', name: 'HAB B', planetId: SOV, orbitSlot: 5, updatedAt: T0, ...over,
  });

  it('goes out under the known stamp: the smaller owner id stands, and the other is kept as an alias', () => {
    const next = foldOwnStation(known({ ownerId: 'zeta-hab' }), record(), null, T0 + 10)!;
    expect(next).toMatchObject({ ownerId: 'b-hab', ownerAliases: ['zeta-hab'], updatedAt: T0 });
    expect(foldOwnStation(next, record(), null, T0 + 20)).toBeNull();
    // The larger id's own install keeps the smaller one standing.
    expect(foldOwnStation(next, record({ id: 'zeta-hab' }), null, T0 + 30)).toBeNull();
  });

  it('claims a place nobody owned, without freshening its stamp', () => {
    expect(foldOwnStation(known(), record(), null, T0 + 10)).toMatchObject({ ownerId: 'b-hab', updatedAt: T0 });
  });
});
