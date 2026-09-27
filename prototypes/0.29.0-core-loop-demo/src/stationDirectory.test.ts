// stationDirectory.ts tests: the seam ship destinations read through — the
// static table, a swapped-in source, same-planet filtering, and the adapter
// over the station record (stations.ts).

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STATIONS,
  FUEL_BASE,
  FUEL_PER_SLOT,
  TRAVEL_MS_MAX,
  TRAVEL_MS_MIN,
  destinationsFrom,
  destinationsFromRecords,
  directoryFromStationRecords,
  findStation,
  isKnownStation,
  listStations,
  setStationDirectory,
  stationHere,
  type StationDestination,
} from './stationDirectory';

afterEach(() => setStationDirectory(null));

const station = (id: string, planetId: string, extra: Partial<StationDestination> = {}): StationDestination => ({
  id, name: id.toUpperCase(), planetId, fuelCost: 10, travelMs: TRAVEL_MS_MIN, ...extra,
});

describe('the static table', () => {
  it('serves three stations around one planet, home first', () => {
    expect(listStations()).toBe(DEFAULT_STATIONS);
    expect(listStations()[0].id).toBe('furlong-station');
    expect(new Set(listStations().map((s) => s.planetId)).size).toBe(1);
  });

  it('resolves unknown ids to home and says they are unknown', () => {
    expect(findStation('nowhere').id).toBe('furlong-station');
    expect(isKnownStation('nowhere')).toBe(false);
    expect(isKnownStation('high-orbit')).toBe(true);
  });

  it('offers every other station around the same planet', () => {
    expect(destinationsFrom('furlong-station').map((s) => s.id)).toEqual(['high-orbit', 'l4-anchorage']);
    expect(destinationsFrom('high-orbit').map((s) => s.id)).toEqual(['furlong-station', 'l4-anchorage']);
  });
});

describe('a swapped-in directory', () => {
  it('limits destinations to the departure planet', () => {
    setStationDirectory({
      stations: () => [station('a', 'p1'), station('b', 'p1'), station('c', 'p2')],
    });
    expect(destinationsFrom('a').map((s) => s.id)).toEqual(['b']);
    expect(destinationsFrom('c')).toEqual([]);
  });

  it('never offers the station the ship belongs to right now', () => {
    setStationDirectory({
      stations: () => [station('a', 'p1'), station('b', 'p1'), station('ship', 'p1')],
      here: () => 'ship',
    });
    expect(stationHere()).toBe('ship');
    expect(destinationsFrom('a').map((s) => s.id)).toEqual(['b']);
  });

  it('ignores a `here` the directory does not list', () => {
    setStationDirectory({ stations: () => [station('a', 'p1')], here: () => 'ghost' });
    expect(stationHere()).toBeNull();
  });

  it('falls back to the table when the source is empty, and null restores it', () => {
    setStationDirectory({ stations: () => [] });
    expect(listStations()).toBe(DEFAULT_STATIONS);
    setStationDirectory({ stations: () => [station('a', 'p1')] });
    expect(listStations().map((s) => s.id)).toEqual(['a']);
    setStationDirectory(null);
    expect(listStations()).toBe(DEFAULT_STATIONS);
  });
});

describe('the station record as destinations', () => {
  const records = [
    { id: 'furlong-station', name: 'FURLONG', planetId: 'planet-sovereign', orbitSlot: 0, welcomeRoomId: 'home-1' },
    { id: 'station:mod-2', name: 'MOD 2', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'mod-2', berthDoor: 'north' },
    { id: 'far', name: 'FAR', planetId: 'planet-sovereign', orbitSlot: 30, welcomeRoomId: 'far-1' },
  ];
  const seeds: Record<string, string> = { 'home-1': 'seed-home', 'mod-2': 'seed-mod' };

  it('prices each hop by orbit slot, capped', () => {
    const out = destinationsFromRecords(records, (rid) => seeds[rid]);
    expect(out[0].fuelCost).toBe(FUEL_BASE);
    expect(out[1].fuelCost).toBe(FUEL_BASE + FUEL_PER_SLOT);
    expect(out[0].travelMs).toBe(TRAVEL_MS_MIN);
    expect(out[1].travelMs).toBeGreaterThan(TRAVEL_MS_MIN);
    expect(out[2].travelMs).toBe(TRAVEL_MS_MAX);
  });

  it('gives a berth only where this client holds a seed for the welcome room', () => {
    const out = destinationsFromRecords(records, (rid) => seeds[rid]);
    expect(out[0].berth).toEqual({ address: 'seed-home' });
    expect(out[1].berth).toEqual({ address: 'seed-mod', farDoor: 'north' });
    expect(out[2].berth).toBeUndefined();
  });

  it('works as the live directory', () => {
    setStationDirectory(directoryFromStationRecords(() => records, (rid) => seeds[rid], () => 'furlong-station'));
    expect(destinationsFrom('furlong-station').map((s) => s.id)).toEqual(['station:mod-2', 'far']);
    expect(findStation('station:mod-2').berth?.address).toBe('seed-mod');
  });
});
