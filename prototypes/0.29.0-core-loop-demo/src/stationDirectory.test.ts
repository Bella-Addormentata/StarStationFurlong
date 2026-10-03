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
  FUEL_PER_KMS,
  HOME_PLANET_ID,
  localStationId,
  findStation,
  planHop,
  planRecordHop,
  isKnownStation,
  listStations,
  setStationDirectory,
  stationHere,
  type StationDestination,
} from './stationDirectory';
import { planTransfer } from './orbits';
import { isFlightRecord } from './shipDoc';

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

  it("never offers the ship's own one-module station", () => {
    setStationDirectory({
      stations: () => [station('a', 'p1'), station('b', 'p1'), station('ship', 'p1')],
      here: () => 'a',
      own: () => 'ship',
    });
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
    { id: 'odd', name: 'ODD', planetId: 'planet-sovereign', orbitSlot: 2, welcomeRoomId: 'odd-1', berthDoor: 'not-a-door' },
  ];
  const seeds: Record<string, string> = { 'home-1': 'seed-home', 'mod-2': 'seed-mod', 'odd-1': 'seed-odd' };

  it('prices each hop by orbit slot, capped', () => {
    const out = destinationsFromRecords(records, (rid) => seeds[rid]);
    expect(out[0].fuelCost).toBe(FUEL_BASE);
    expect(out[1].fuelCost).toBe(FUEL_BASE + FUEL_PER_SLOT);
    expect(out[0].travelMs).toBe(TRAVEL_MS_MIN);
    expect(out[1].travelMs).toBeGreaterThan(TRAVEL_MS_MIN);
    expect(out[2].travelMs).toBe(TRAVEL_MS_MAX);
  });

  it('gives a berth only where the berth door is named and this client holds a seed', () => {
    const out = destinationsFromRecords(records, (rid) => seeds[rid]);
    expect(out[0].berth).toBeUndefined();
    expect(out[1].berth).toEqual({ address: 'seed-mod', farDoor: 'north' });
    expect(out[2].berth).toBeUndefined();
    // A berth door the doors doc would strip is no berth door.
    expect(out[3].berth).toBeUndefined();
  });

  it('names every berth room, even ones this client holds no seed for', () => {
    const gated = [{ ...records[1], berths: [{ roomId: 'mod-2', doorId: 'north', gate: 1 }, { roomId: 'mod-9', doorId: 'east', gate: 2 }] }];
    const [out] = destinationsFromRecords(gated, (rid) => seeds[rid]);
    expect(out.berths?.map((b) => b.address)).toEqual(['seed-mod']);
    expect(out.berthRooms).toEqual(['mod-2', 'mod-9']);
  });

  it('works as the live directory', () => {
    setStationDirectory(directoryFromStationRecords(() => records, (rid) => seeds[rid], () => 'furlong-station'));
    expect(destinationsFrom('furlong-station').map((s) => s.id)).toEqual(['station:mod-2', 'far', 'odd']);
    expect(findStation('station:mod-2').berth?.address).toBe('seed-mod');
  });
});

describe('planning a hop', () => {
  it('leaves now at the flat cost when the directory has no planner', () => {
    expect(planHop('furlong-station', 'high-orbit', 1000)).toEqual({ departAt: 1000, arriveAt: 1000 + TRAVEL_MS_MIN, fuelCost: 25 });
    expect(planHop('furlong-station', 'furlong-station', 1000)).toBeNull();
    expect(planHop('furlong-station', 'nowhere', 1000)).toBeNull();
    expect(planHop('nowhere', 'high-orbit', 1000)).toBeNull();
  });

  it('follows the circular-orbit model over station records', () => {
    const records = [
      { id: 'low', name: 'LOW', planetId: 'planet-sovereign', orbitSlot: 0, welcomeRoomId: 'r0' },
      { id: 'high', name: 'HIGH', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'r1' },
      { id: 'twin', name: 'TWIN', planetId: 'planet-sovereign', orbitSlot: 0, welcomeRoomId: 'r2' },
    ];
    setStationDirectory(directoryFromStationRecords(() => records, () => undefined, () => null));
    const now = Date.UTC(2026, 8, 27);
    const hop = planHop('low', 'high', now)!;
    const t = planTransfer(records[0], records[1], now)!;
    // Whole milliseconds, rounded up (a flight record stores only those).
    expect(hop.departAt).toBe(Math.ceil(t.departAt));
    expect(hop.arriveAt).toBe(Math.ceil(t.arriveAt));
    expect(hop.departAt).toBeGreaterThanOrEqual(now);
    expect(hop.fuelCost).toBe(Math.ceil(t.deltaVKmS * FUEL_PER_KMS));
    expect(hop.windowEveryMs).toBe(t.synodicMs);
    // Two stations sharing one orbit have no transfer between them.
    expect(planHop('low', 'twin', now)).toBeNull();
  });

  it('plans hops a flight record accepts as they are', () => {
    const records = [
      { id: 'low', name: 'LOW', planetId: 'planet-sovereign', orbitSlot: 0, welcomeRoomId: 'r0' },
      { id: 'high', name: 'HIGH', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'r1' },
    ];
    setStationDirectory(directoryFromStationRecords(() => records, () => undefined, () => null));
    const now = Date.now();
    for (const at of [now, now + 0.25, now + 1234.5]) {
      const hop = planHop('low', 'high', at)!;
      expect(Number.isSafeInteger(hop.departAt) && Number.isSafeInteger(hop.arriveAt)).toBe(true);
      expect(isFlightRecord({
        status: 'in-flight', locationId: 'low', destinationId: 'high', departedAt: hop.departAt, etaAt: hop.arriveAt,
      })).toBe(true);
    }
  });

  it('prices a low hop so one tank flies more than one', () => {
    const now = Date.UTC(2026, 8, 27);
    const low = { id: 'a', name: 'A', planetId: 'planet-sovereign', orbitSlot: 0, welcomeRoomId: 'a' };
    const next = { id: 'b', name: 'B', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'b' };
    const cost = planRecordHop(low, next, now)!.fuelCost;
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThanOrEqual(50);
  });
});

describe('station ids written on another install', () => {
  const records = [
    { id: 'furlong-station', name: 'FURLONG', planetId: HOME_PLANET_ID, orbitSlot: 0, welcomeRoomId: 'room-home' },
    { id: 'shared:room-hab', name: 'HAB', planetId: HOME_PLANET_ID, orbitSlot: 2, welcomeRoomId: 'room-hab' },
  ];
  const aliases: Record<string, string> = { 'station:room-hab': 'shared:room-hab', 'their-hab': 'shared:room-hab', ghost: 'nowhere' };

  it('read as this install\'s id through the directory\'s resolver', () => {
    setStationDirectory(directoryFromStationRecords(() => records, () => undefined, () => null, () => null, (id) => aliases[id] ?? null));
    expect(localStationId('furlong-station')).toBe('furlong-station');
    expect(localStationId('station:room-hab')).toBe('shared:room-hab');
    expect(localStationId('their-hab')).toBe('shared:room-hab');
    // An alias to nothing listed, or no alias at all: left as written.
    expect(localStationId('ghost')).toBe('ghost');
    expect(localStationId('unknown')).toBe('unknown');
  });

  it('ask the resolver before taking a listed id as written', () => {
    // A local record whose id collides with a portable id for another room.
    const clash = [...records, { id: 'shared:room-odd', name: 'ODD', planetId: HOME_PLANET_ID, orbitSlot: 3, welcomeRoomId: 'room-x' }];
    const byRoom: Record<string, string> = { 'shared:room-odd': 'shared:room-hab' };
    setStationDirectory(directoryFromStationRecords(() => clash, () => undefined, () => null, () => null, (id) => byRoom[id] ?? null));
    expect(localStationId('shared:room-odd')).toBe('shared:room-hab');
  });

  it('are taken as written without a resolver', () => {
    setStationDirectory(directoryFromStationRecords(() => records, () => undefined, () => null));
    expect(localStationId('station:room-hab')).toBe('station:room-hab');
  });
});
