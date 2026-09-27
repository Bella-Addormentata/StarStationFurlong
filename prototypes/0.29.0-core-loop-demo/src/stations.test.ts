/**
 * 🪐 stations — planet + orbit records over atlas components, and the list the
 * holotable (and later ship destinations) reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AtlasEntry } from './stationAtlas';
import { atlasComponent, atlasComponents } from './stationAtlas';
import {
  DEFAULT_PLANET_ID,
  DEFAULT_STATION_ID,
  DEFAULT_STATION_RECORD,
  MAX_ORBIT_SLOTS,
  listStations,
  planetForRoom,
  readStationRecords,
  registerStation,
  removeStation,
  stationForRoom,
  stationsAroundPlanet,
} from './stations';
import type { StationRecord } from './stations';
import { SolarSystemMap, screenOffset, stationBodies } from './map';
import { DEFAULT_STATION } from './defaultStation';
import { ORBIT_EPOCH_MS } from './orbits';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

beforeEach(() => store.clear());

/** A room whose doors pair with `links`. */
function room(roomId: string, links: string[] = [], name = roomId.toUpperCase()): AtlasEntry {
  const doors: AtlasEntry['doors'] = {};
  links.forEach((t, i) => { doors[`d:${i}`] = { targetSeed: '', targetRoomId: t }; });
  return { roomId, name, doors, lastSeen: 0 };
}

function atlasOf(...entries: AtlasEntry[]): Record<string, AtlasEntry> {
  return Object.fromEntries(entries.map((e) => [e.roomId, e]));
}

const WELCOME = DEFAULT_STATION.welcomeRoomId;

/** The default station (welcome room + a neighbour) and a second, separate
 *  two-room station. */
function twoStations(): Record<string, AtlasEntry> {
  return atlasOf(
    room(WELCOME, ['lounge']),
    room('lounge', [WELCOME]),
    room('yard-b', ['yard-a']),
    room('yard-a', []), // pairing recorded on one side only still joins them
  );
}

describe('atlas components', () => {
  it('walks pairings both ways and keeps separate stations apart', () => {
    const atlas = twoStations();
    expect([...atlasComponent(atlas, 'yard-a')].sort()).toEqual(['yard-a', 'yard-b']);
    expect(atlasComponents(atlas).map((c) => [...c].sort())).toEqual([
      [WELCOME, 'lounge'].sort(),
      ['yard-a', 'yard-b'],
    ]);
  });

  it('does not let unknown door targets crowd a real neighbour out of its component', () => {
    const unknown = Array.from({ length: 63 }, (_, i) => `ghost-${i}`);
    const atlas = atlasOf(room('hub', [...unknown, 'real']), room('real', []));
    expect(atlasComponent(atlas, 'hub').has('real')).toBe(true);
    expect(atlasComponents(atlas)).toHaveLength(1);
    expect(listStations(atlas, []).filter((s) => s.derived)).toHaveLength(1);
  });

  it('never lets a ship\'s berth join or bridge stations', () => {
    const berth = (target: string) => ({ targetSeed: '', targetRoomId: target, transient: true as const });
    const atlas = atlasOf(
      room('a1', ['a2']),
      room('a2', ['a1']),
      room('b1'),
      room('ship'),
    );
    // Station A still records the ship it hosted (a stale berth — the dock
    // never saw it leave), and the ship is now docked at station B.
    atlas.a1.doors['d:berth'] = berth('ship');
    atlas.ship.doors['d:dock'] = berth('b1');
    atlas.b1.doors['d:port'] = berth('ship');
    expect(atlasComponents(atlas).map((c) => [...c].sort())).toEqual([['a1', 'a2'], ['b1'], ['ship']]);
    expect(listStations(atlas, []).filter((st) => st.derived).map((st) => st.id))
      .toEqual(['station:a1', 'station:b1', 'station:ship']);
    expect(stationForRoom('a2', atlas)?.id).toBe('station:a1');
  });

  it('holds derived stations to the saved-record limits on ids and names', () => {
    const longId = `r${'x'.repeat(200)}`;
    const atlas = atlasOf(room(longId), room('ok', [], 'N'.repeat(500)));
    const derived = listStations(atlas, []).filter((st) => st.derived);
    expect(derived.map((st) => st.id)).toEqual(['station:ok']);
    expect(derived[0].name).toHaveLength(64);
  });

  it('returns nothing for a room the atlas does not hold', () => {
    expect(atlasComponent(twoStations(), 'nowhere').size).toBe(0);
  });
});

describe('listStations', () => {
  it('always lists the built-in Furlong station, even with an empty atlas', () => {
    expect(listStations({}, [])).toEqual([DEFAULT_STATION_RECORD]);
    expect(DEFAULT_STATION_RECORD.id).toBe('furlong-station');
    expect(DEFAULT_STATION_RECORD.welcomeRoomId).toBe(WELCOME);
  });

  it('derives a second station orbiting Sovereign from another atlas component', () => {
    const stations = listStations(twoStations(), []);
    expect(stations.map((s) => s.id)).toEqual([DEFAULT_STATION_ID, 'station:yard-a']);
    const around = stationsAroundPlanet(DEFAULT_PLANET_ID, stations);
    expect(around.map((s) => [s.id, s.orbitSlot])).toEqual([[DEFAULT_STATION_ID, 0], ['station:yard-a', 1]]);
    expect(around[1]).toMatchObject({ name: 'YARD-A', welcomeRoomId: 'yard-a', derived: true });
  });

  it('is deterministic whatever order the atlas holds its entries in', () => {
    const a = atlasOf(room('z1'), room('m1'), room('a1'));
    const b = atlasOf(room('a1'), room('z1'), room('m1'));
    expect(listStations(a, [])).toEqual(listStations(b, []));
  });

  it('lets a saved record claim a component and move it to another planet', () => {
    const record: StationRecord = {
      id: 'aris-forge', name: 'ARIS FORGE', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'yard-b',
    };
    const stations = listStations(twoStations(), [record]);
    expect(stations.map((s) => s.id)).toEqual([DEFAULT_STATION_ID, 'aris-forge']);
    expect(stationsAroundPlanet('planet-aris', stations).map((s) => s.id)).toEqual(['aris-forge']);
    expect(stationForRoom('yard-a', twoStations(), stations)?.id).toBe('aris-forge');
  });

  it('lists one station per place: a record inside a listed station is dropped', () => {
    const insideFurlong: StationRecord = {
      id: 'lounge-2', name: 'LOUNGE', planetId: DEFAULT_PLANET_ID, orbitSlot: 3, welcomeRoomId: 'lounge',
    };
    const yard: StationRecord = {
      id: 'yard', name: 'YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 4, welcomeRoomId: 'yard-a',
    };
    const yardAgain: StationRecord = { ...yard, id: 'yard-2', welcomeRoomId: 'yard-b' };
    const offAtlas: StationRecord = { ...yard, id: 'far', welcomeRoomId: 'far-room', orbitSlot: 5 };
    const offAtlasAgain: StationRecord = { ...offAtlas, id: 'far-2', orbitSlot: 6 };
    const stations = listStations(twoStations(), [insideFurlong, yard, yardAgain, offAtlas, offAtlasAgain]);
    expect(stations.map((s) => s.id)).toEqual([DEFAULT_STATION_ID, 'yard', 'far']);
  });

  it('refuses to register a record for a room of a station already listed', () => {
    for (const e of Object.values(twoStations())) {
      const atlas = JSON.parse(store.get('ssf-station-atlas') ?? '{}');
      atlas[e.roomId] = e;
      store.set('ssf-station-atlas', JSON.stringify(atlas));
    }
    const base = { name: 'X', planetId: DEFAULT_PLANET_ID, orbitSlot: 2 };
    expect(registerStation({ ...base, id: 'dup', welcomeRoomId: 'lounge' })).toBe(false);
    expect(registerStation({ ...base, id: 'yard', welcomeRoomId: 'yard-b' })).toBe(true);
  });

  it('bumps a record whose orbit slot is already taken to the next free one', () => {
    const clash: StationRecord = {
      id: 'l4', name: 'L4 YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 0, welcomeRoomId: 'yard-a',
    };
    const stations = listStations(twoStations(), [clash]);
    expect(stations.find((s) => s.id === 'l4')?.orbitSlot).toBe(1);
  });
});

describe('stationForRoom / planetForRoom', () => {
  it('finds the station from any room of it', () => {
    const atlas = twoStations();
    expect(stationForRoom('lounge', atlas)?.id).toBe(DEFAULT_STATION_ID);
    expect(stationForRoom('yard-b', atlas)?.id).toBe('station:yard-a');
    expect(stationForRoom('nowhere', atlas)).toBeNull();
  });

  it('picks the planet backdrop from the station, Sovereign when unknown', () => {
    const atlas = twoStations();
    expect(planetForRoom('nowhere', atlas).id).toBe(DEFAULT_PLANET_ID);
    registerStation({ id: 'aris-forge', name: 'ARIS FORGE', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'yard-a' });
    expect(planetForRoom('yard-b', atlas).id).toBe('planet-aris');
    expect(planetForRoom('lounge', atlas).id).toBe(DEFAULT_PLANET_ID);
  });
});

describe('saved records', () => {
  it('round-trips, replaces by id, and removes', () => {
    const r = { id: 'l4', name: 'L4 YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 2, welcomeRoomId: 'yard-a' };
    expect(registerStation(r)).toBe(true);
    expect(registerStation({ ...r, name: 'L4 DEPOT' })).toBe(true);
    expect(readStationRecords()).toEqual([{ ...r, name: 'L4 DEPOT' }]);
    removeStation('l4');
    expect(readStationRecords()).toEqual([]);
  });

  it('refuses invalid records and shadowing the default station', () => {
    const base = { id: 'x', name: 'X', planetId: DEFAULT_PLANET_ID, orbitSlot: 0, welcomeRoomId: 'r' };
    expect(registerStation({ ...base, id: DEFAULT_STATION_ID })).toBe(false);
    expect(registerStation({ ...base, orbitSlot: -1 })).toBe(false);
    expect(registerStation({ ...base, orbitSlot: 1.5 })).toBe(false);
    expect(registerStation({ ...base, welcomeRoomId: '' })).toBe(false);
    expect(registerStation({ ...base, id: 'planet-sovereign' })).toBe(false);
    expect(registerStation({ ...base, id: 'belt-ring' })).toBe(false);
    expect(registerStation({ ...base, id: 'station:yard-a' })).toBe(false);
    expect(readStationRecords()).toEqual([]);
  });

  it('refuses a record once its planet has no free orbit slot', () => {
    // The built-in station holds one of Sovereign's slots.
    for (let i = 1; i < MAX_ORBIT_SLOTS; i++) {
      expect(registerStation({ id: `s${i}`, name: `S${i}`, planetId: DEFAULT_PLANET_ID, orbitSlot: i, welcomeRoomId: `r${i}` })).toBe(true);
    }
    expect(registerStation({ id: 'full', name: 'FULL', planetId: DEFAULT_PLANET_ID, orbitSlot: 0, welcomeRoomId: 'rx' })).toBe(false);
    expect(stationsAroundPlanet(DEFAULT_PLANET_ID, listStations({}))).toHaveLength(MAX_ORBIT_SLOTS);
    // Another planet still has room.
    expect(registerStation({ id: 'aris', name: 'ARIS', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'ry' })).toBe(true);
  });

  it('survives a corrupt store and maps unknown planets to the default', () => {
    store.set('ssf-stations', '{not json');
    expect(readStationRecords()).toEqual([]);
    store.set('ssf-stations', JSON.stringify([
      { id: 'a', name: 'A', planetId: 'planet-nope', orbitSlot: 1, welcomeRoomId: 'r' },
      { junk: true },
    ]));
    expect(readStationRecords()).toEqual([
      { id: 'a', name: 'A', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'r' },
    ]);
  });
});

describe('solar map station bodies', () => {
  it('keeps the Furlong body where it always was, now moving on its true orbit', () => {
    const [furlong] = stationBodies([DEFAULT_STATION_RECORD]);
    expect(furlong).toMatchObject({ id: 'furlong-station', parentId: 'planet-sovereign', orbitRadius: 35 });
    expect(furlong.angleAt!(ORBIT_EPOCH_MS)).toBeCloseTo(2.1, 12);
    expect(furlong.description).toContain('400 km up · 7.67 km/s · one orbit every 1m 32s.');
  });

  it('shows both stations around Sovereign on the holotable and marks the current one', () => {
    const atlas = twoStations();
    const stations = listStations(atlas, []);
    const map = new SolarSystemMap();
    map.refreshStations(stations, stationForRoom('yard-b', atlas, stations));
    expect(map.stationIds()).toEqual([DEFAULT_STATION_ID, 'station:yard-a']);
    expect(map.getPlayerLocationId()).toBe('station:yard-a');
    const bodies = stationBodies(stations);
    expect(bodies.every((b) => b.parentId === 'planet-sovereign')).toBe(true);
    expect(bodies[1].orbitRadius).toBeGreaterThan(bodies[0].orbitRadius);
  });

  it('rebinds the selection when a station is renamed', () => {
    const map = new SolarSystemMap();
    const rec = { id: 'l4', name: 'L4 YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'r' };
    map.refreshStations(listStations({}, [rec]), null);
    (map as unknown as { selectedBody: unknown }).selectedBody = stationBodies([rec])[0];
    map.refreshStations(listStations({}, [{ ...rec, name: 'L4 DEPOT' }]), null);
    expect((map as unknown as { selectedBody: { name: string } }).selectedBody.name).toBe('L4 DEPOT');
  });

  it('looks down from the north: a growing angle turns counter-clockwise on screen', () => {
    const a = screenOffset(0, 10);
    const b = screenOffset(Math.PI / 2, 10);
    expect(a.dx).toBeCloseTo(10, 12);
    expect(b.dy).toBeCloseTo(-10, 12); // up the screen (canvas y grows downward)
  });

  it('updates "you are here" before repainting a kept selection', () => {
    const els = new Map<string, { style: Record<string, string>; textContent: string; innerHTML: string; disabled?: boolean }>();
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, { style: {}, textContent: '', innerHTML: '' });
        return els.get(id);
      },
    };
    try {
      const atlas = twoStations();
      const stations = listStations(atlas, []);
      const map = new SolarSystemMap();
      (map as unknown as { container: unknown }).container = {}; // mounted, for the repaint path
      map.refreshStations(stations, stationForRoom('lounge', atlas, stations));
      (map as unknown as { selectedBody: unknown }).selectedBody = stationBodies(stations)[0]; // Furlong
      map.refreshStations(stations, stationForRoom('yard-b', atlas, stations));
      expect(els.get('map-player-loc')?.textContent).toBe('YARD-A');
      expect(els.get('map-travel-btn')?.textContent).toBe('TRAVEL TO FURLONG LOBBY STATION');
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('defaults to Furlong as the player location, as before', () => {
    expect(new SolarSystemMap().getPlayerLocationId()).toBe('furlong-station');
  });
});
