/**
 * 🪐 stations — planet + orbit records over atlas components, and the list the
 * holotable (and later ship destinations) reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AtlasEntry } from './stationAtlas';
import { atlasComponent, atlasComponents, berthDoorIds } from './stationAtlas';
import {
  DEFAULT_PLANET_ID,
  DEFAULT_STATION_ID,
  DEFAULT_STATION_RECORD,
  MAX_ORBIT_SLOTS,
  currentStation,
  dockedStationFor,
  isStationRoom,
  listStations,
  planetForRoom,
  readStationRecords,
  registerStation,
  removeStation,
  setRoomStationResolver,
  setStationRoomSource,
  stationForRoom,
  stationRoomCause,
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

  it('counts only rooms the atlas holds an entry of its own for, whatever a door calls a room', () => {
    // Exactly 64 known rooms (MAX_ENTRIES). The atlas inherits a value under
    // each odd name but holds no entry for it, so those rooms must not use up
    // the cap and split the station.
    const odd = ['constructor', '__proto__', 'toString'];
    const real = Array.from({ length: 62 }, (_, i) => `real-${i}`);
    const atlas = atlasOf(room('hub', [...odd, 'spine']), room('spine', real), ...real.map((rid) => room(rid)));
    expect(atlasComponent(atlas, 'hub').size).toBe(64 + odd.length);
    expect(atlasComponents(atlas)).toHaveLength(1);
    for (const rid of odd) expect(atlasComponent(atlas, rid).size).toBe(0);
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

  it('names a derived station STATION when its anchor room\'s name is not a string', () => {
    const atlas = atlasOf(room('odd'));
    (atlas.odd as unknown as { name: unknown }).name = 42;
    expect(listStations(atlas, []).find((st) => st.derived)?.name).toBe('STATION');
  });

  it('never anchors a derived station on a room the atlas holds no entry for, whatever it is called', () => {
    for (const odd of ['constructor', '__proto__', 'toString']) {
      const derived = listStations(atlasOf(room('yard', [odd])), []).filter((st) => st.derived);
      expect(derived).toEqual([expect.objectContaining({ id: 'station:yard', name: 'YARD', welcomeRoomId: 'yard' })]);
      // A room the atlas does hold under that name is a room like any other.
      const held = atlasOf(room(odd, ['yard']), room('yard'));
      expect(Object.prototype.hasOwnProperty.call(held, odd)).toBe(true);
      expect(listStations(held, []).filter((st) => st.derived).map((st) => st.id)).toEqual([`station:${odd}`]);
    }
  });

  it('treats a dock recorded before the berth flag existed as a berth too', () => {
    // An upgrade: persisted (or older-client) entries carry the dock chain but
    // no flag — and a dock is always transient.
    const dock = [{ kind: 'dock' as const }, { kind: 'dock' as const }];
    const atlas = atlasOf(room('a1'), room('ship'), room('b1'));
    atlas.a1.doors['d:berth'] = { targetSeed: '', targetRoomId: 'ship', segments: dock };
    atlas.ship.doors['d:dock'] = { targetSeed: '', targetRoomId: 'b1', segments: dock, transient: false };
    expect(atlasComponents(atlas).map((c) => [...c].sort())).toEqual([['a1'], ['ship'], ['b1']]);
  });

  it('counts both records of a berth as the berth, however the other side is flagged', () => {
    // The ship's own records came from an older client: no flag, no dock chain.
    const atlas = atlasOf(room('a1', ['a2']), room('a2', ['a1']), room('b1'), room('ship'));
    atlas.a1.doors['d:berth'] = { targetSeed: '', targetRoomId: 'ship', transient: true };
    atlas.ship.doors['d:old'] = { targetSeed: '', targetRoomId: 'a1' }; // the only unnamed record back
    atlas.b1.doors['d:port'] = { targetSeed: '', targetRoomId: 'ship', transient: true, farDoor: 'd:dock' };
    atlas.ship.doors['d:dock'] = { targetSeed: '', targetRoomId: 'b1' }; // named by the port
    expect(atlasComponents(atlas).map((c) => [...c].sort())).toEqual([['a1', 'a2'], ['b1'], ['ship']]);
  });

  it('still joins two rooms by a separate permanent connection beside a berth', () => {
    const atlas = atlasOf(room('a1'), room('ship'));
    atlas.a1.doors['d:berth'] = { targetSeed: '', targetRoomId: 'ship', transient: true, farDoor: 'd:dock' };
    atlas.ship.doors['d:dock'] = { targetSeed: '', targetRoomId: 'a1' };
    expect(atlasComponents(atlas)).toHaveLength(2);
    // A gangway between the same two rooms, each end naming the other.
    atlas.a1.doors['d:tube'] = { targetSeed: '', targetRoomId: 'ship', farDoor: 'd:hatch' };
    atlas.ship.doors['d:hatch'] = { targetSeed: '', targetRoomId: 'a1', farDoor: 'd:tube' };
    expect(atlasComponents(atlas)).toHaveLength(1);
  });

  it('lets an unnamed berth take only one unflagged record opposite', () => {
    const atlas = atlasOf(room('a1'), room('ship'));
    atlas.a1.doors['d:berth'] = { targetSeed: '', targetRoomId: 'ship', transient: true };
    atlas.ship.doors['d:old'] = { targetSeed: '', targetRoomId: 'a1' };
    expect(atlasComponents(atlas)).toHaveLength(2);
    // A second unflagged record back is a second connection: structure.
    atlas.ship.doors['d:tube'] = { targetSeed: '', targetRoomId: 'a1' };
    expect(atlasComponents(atlas)).toHaveLength(1);
  });

  it('pairs an unnamed berth flagged at both ends with itself, not with a gangway beside it', () => {
    const atlas = atlasOf(room('a1'), room('ship'));
    atlas.a1.doors['d:berth'] = { targetSeed: '', targetRoomId: 'ship', transient: true };
    atlas.ship.doors['d:dock'] = { targetSeed: '', targetRoomId: 'a1', transient: true };
    // A permanent gangway between the same rooms; no record names its far door.
    atlas.a1.doors['d:tube'] = { targetSeed: '', targetRoomId: 'ship' };
    atlas.ship.doors['d:hatch'] = { targetSeed: '', targetRoomId: 'a1' };
    const berths = berthDoorIds(atlas);
    expect([...(berths.get('a1') ?? [])]).toEqual(['d:berth']);
    expect([...(berths.get('ship') ?? [])]).toEqual(['d:dock']);
    expect(atlasComponents(atlas)).toHaveLength(1);
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

  it('settles a slot clash the same way on every install, whatever order it saved its records in', () => {
    // Two installs, each with its own station first and the other's learned
    // record second, both wanting slot 1.
    const want1 = (id: string, welcomeRoomId: string): StationRecord =>
      ({ id, name: id.toUpperCase(), planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId });
    const slots = (records: StationRecord[]) =>
      Object.fromEntries(listStations({}, records).map((st) => [st.welcomeRoomId, st.orbitSlot]));
    const onA = slots([want1('home', 'room-a'), want1('shared:room-b', 'room-b')]);
    const onB = slots([want1('home', 'room-b'), want1('shared:room-a', 'room-a')]);
    expect(onA).toEqual({ [WELCOME]: 0, 'room-a': 1, 'room-b': 2 });
    expect(onB).toEqual(onA);
    // The list itself keeps record order.
    expect(listStations({}, [want1('b', 'room-b'), want1('a', 'room-a')]).map((st) => st.id))
      .toEqual([DEFAULT_STATION_ID, 'b', 'a']);
  });

  it('moves only the station that lost a slot clash', () => {
    const at = (room: string, orbitSlot: number): StationRecord =>
      ({ id: room, name: room.toUpperCase(), planetId: DEFAULT_PLANET_ID, orbitSlot, welcomeRoomId: room });
    // room-b and room-c hold the slots they want; room-a then wants room-b's
    // and wins it. room-b moves on past room-c, which stays put.
    const stations = listStations({}, [at('room-b', 1), at('room-c', 2), at('room-a', 1)]);
    expect(stations.map((st) => [st.id, st.orbitSlot]))
      .toEqual([[DEFAULT_STATION_ID, 0], ['room-b', 3], ['room-c', 2], ['room-a', 1]]);
  });

  it('lists a record naming an unknown planet at the default planet, in a slot free there', () => {
    const lost: StationRecord = {
      id: 'lost', name: 'LOST', planetId: 'planet-nope', orbitSlot: 0, welcomeRoomId: 'far-room',
    };
    const stations = listStations({}, [lost]);
    expect(stations.find((s) => s.id === 'lost')).toMatchObject({ planetId: DEFAULT_PLANET_ID, orbitSlot: 1 });
    expect(stationsAroundPlanet(DEFAULT_PLANET_ID, stations).map((s) => s.id)).toEqual([DEFAULT_STATION_ID, 'lost']);
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

  it('places a docked ship at the station a resolver names, and falls back to the atlas', () => {
    const atlas = atlasOf(room('b1'), room('ship'));
    atlas.b1.doors['d:port'] = { targetSeed: '', targetRoomId: 'ship', transient: true };
    expect(registerStation({ id: 'aris-yard', name: 'ARIS YARD', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'b1' })).toBe(true);
    // The berth is not structure: by the atlas alone the ship is a place of its own.
    expect(stationForRoom('ship', atlas)?.id).toBe('station:ship');
    expect(planetForRoom('ship', atlas).id).toBe(DEFAULT_PLANET_ID);
    try {
      // Ship travel knows the room the dock leads into, and asks the atlas about it.
      let calls = 0;
      setRoomStationResolver((roomId) => {
        calls++;
        return roomId === 'ship' ? stationForRoom('b1', atlas)?.id ?? null : null;
      });
      expect(stationForRoom('ship', atlas)?.id).toBe('aris-yard');
      expect(calls).toBe(1); // its own lookup went straight to the atlas
      expect(planetForRoom('ship', atlas).id).toBe('planet-aris');
      setStationRoomSource(() => 'ship');
      expect(currentStation()?.id).toBe('aris-yard');
      // A station that is not listed, or a resolver that throws, falls back to the atlas.
      setRoomStationResolver(() => 'nowhere');
      expect(stationForRoom('ship', atlas)?.id).toBe('station:ship');
      setRoomStationResolver(() => { throw new Error('no dock'); });
      expect(stationForRoom('ship', atlas)?.id).toBe('station:ship');
    } finally {
      setRoomStationResolver(null);
      setStationRoomSource(() => '');
    }
  });

  it('tells a station room that wears ship fittings from a ship', () => {
    expect(registerStation({ id: 'aris-yard', name: 'ARIS YARD', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'b1' })).toBe(true);
    const seed = (roomId: string) => `ssf://join#room=${roomId}`;
    const dock = (roomId: string) => ({ paired: true as const, connectedRoomAddress: seed(roomId), transient: true });
    const gangway = (roomId: string) => ({ paired: true as const, connectedRoomAddress: seed(roomId) });
    // A saved station's (or the built-in one's) welcome room, docked or not.
    expect(isStationRoom('b1', [])).toBe(true);
    expect(isStationRoom('b1', [dock('ship')])).toBe(true);
    expect(isStationRoom(DEFAULT_STATION_RECORD.welcomeRoomId, [])).toBe(true);
    // A module bolted into a station by structure.
    expect(isStationRoom('helm-room', [gangway('a1')])).toBe(true);
    // A lone module, free or docked, is a ship.
    expect(isStationRoom('ship', [])).toBe(false);
    expect(isStationRoom('ship', [dock('b1')])).toBe(false);
    expect(isStationRoom('', [])).toBe(false);
    // Why, for the helm: a welcome room stays one with its gangways, and a
    // module bolted in is free once its gangway is down.
    expect(stationRoomCause('b1', [gangway('a1')])).toBe('welcome-room');
    expect(stationRoomCause('helm-room', [gangway('a1'), dock('ship')])).toBe('bolted');
    expect(stationRoomCause('ship', [dock('b1')])).toBeNull();
    // A one-module station: its welcome room with no gangway (a docked ship
    // is no part of it), free to fly by hand but still never to DEPART.
    expect(stationRoomCause('b1', [])).toBe('lone-station');
    expect(stationRoomCause('b1', [dock('ship')])).toBe('lone-station');
    // A pairing whose address names no room (a peer's junk, or one the
    // parser throws on), or names this room itself, joins it to no other
    // room, as the atlas reads it: it bolts nothing.
    const junk = (address: string) => ({ paired: true as const, connectedRoomAddress: address });
    expect(stationRoomCause('ship', [junk('ssf://join#room=%')])).toBeNull();
    expect(stationRoomCause('ship', [junk('not a pass')])).toBeNull();
    expect(stationRoomCause('ship', [gangway('ship')])).toBeNull();
    expect(stationRoomCause('b1', [gangway('b1'), junk('ssf://join#room=%')])).toBe('lone-station');
    expect(stationRoomCause('ship', [junk('ssf://join#room=%'), gangway('a1')])).toBe('bolted');
  });

  it('finds the station a lone module is docked at from its live doors', () => {
    // Station A (two rooms), a lone room with a saved record around Aris, and
    // lone modules with no record of their own.
    const atlas = atlasOf(room('a1', ['a2']), room('a2', ['a1']), room('b1'), room('ship'), room('pod'));
    expect(registerStation({ id: 'aris-yard', name: 'ARIS YARD', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'b1' })).toBe(true);
    const seed = (roomId: string) => `ssf://join#room=${roomId}`;
    const dock = (roomId: string) => ({ paired: true as const, connectedRoomAddress: seed(roomId), transient: true });
    const gangway = (roomId: string) => ({ paired: true as const, connectedRoomAddress: seed(roomId) });
    expect(dockedStationFor('ship', [dock('a1')], atlas)).toBe('station:a1');
    expect(dockedStationFor('ship', [dock('b1')], atlas)).toBe('aris-yard');
    // Two lone modules docked together stay where they are…
    expect(dockedStationFor('ship', [dock('pod')], atlas)).toBeNull();
    // …a station never moves to the ship visiting it…
    expect(dockedStationFor('b1', [dock('ship')], atlas)).toBeNull();
    expect(dockedStationFor('a2', [dock('ship')], atlas)).toBeNull();
    expect(dockedStationFor('a2', [dock('b1')], atlas)).toBeNull(); // the atlas holds its gangway
    // …a module bolted into structure is the atlas's to place, and undocked
    // ports (tombstones) count for nothing.
    expect(dockedStationFor('ship', [gangway('pod'), dock('a1')], atlas)).toBeNull();
    expect(dockedStationFor('ship', [{ paired: false as const, retiredAddress: seed('a1') }], atlas)).toBeNull();
    // A pairing whose address names no room (peer-written junk) is no
    // structure: the real dock beside it still places the ship.
    expect(dockedStationFor('ship', [{ paired: true as const, connectedRoomAddress: 'not a room' }, dock('b1')], atlas)).toBe('aris-yard');
    // Installed as the room-station resolver, it gives a docked ship its host's planet.
    try {
      setRoomStationResolver((roomId) => (roomId === 'ship' ? dockedStationFor(roomId, [dock('b1')], atlas) : null));
      expect(planetForRoom('ship', atlas).id).toBe('planet-aris');
    } finally {
      setRoomStationResolver(null);
    }
  });

  it('finds a docked ship past pairings that name no other room', () => {
    // Peer-written: an address the parser throws on, or a pairing back to the
    // module itself, bolts it into nothing and hides no real dock.
    const atlas = atlasOf(room('b1'), room('ship'));
    expect(registerStation({ id: 'aris-yard', name: 'ARIS YARD', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'b1' })).toBe(true);
    const dock = { paired: true as const, connectedRoomAddress: 'ssf://join#room=b1', transient: true };
    const junk = (address: string) => ({ paired: true as const, connectedRoomAddress: address });
    expect(dockedStationFor('ship', [junk('ssf://join#room=%'), dock], atlas)).toBe('aris-yard');
    expect(dockedStationFor('ship', [{ ...junk('ssf://join#room=%'), transient: true }, dock], atlas)).toBe('aris-yard');
    expect(dockedStationFor('ship', [junk('ssf://join#room=ship'), dock], atlas)).toBe('aris-yard');
  });

  it('picks the planet backdrop from the station, Sovereign when unknown', () => {
    const atlas = twoStations();
    expect(planetForRoom('nowhere', atlas).id).toBe(DEFAULT_PLANET_ID);
    registerStation({ id: 'aris-forge', name: 'ARIS FORGE', planetId: 'planet-aris', orbitSlot: 0, welcomeRoomId: 'yard-a' });
    expect(planetForRoom('yard-b', atlas).id).toBe('planet-aris');
    expect(planetForRoom('lounge', atlas).id).toBe(DEFAULT_PLANET_ID);
  });

  it('keeps structure in place when a full planet lists no station for it', () => {
    // Furlong and fifteen lone stations fill Sovereign, so neither the
    // two-room yard nor the lone pod (anchored last) is listed. The yard's
    // pairing is recorded on z2 alone, so z1's live doors show only its dock.
    const lone = Array.from({ length: MAX_ORBIT_SLOTS - 1 }, (_, i) => room(`a${String(i).padStart(2, '0')}`));
    const atlas = atlasOf(...lone, room('z1'), room('z2', ['z1']), room('zz'));
    expect(listStations(atlas, []).filter((s) => ['z1', 'z2', 'zz'].includes(s.welcomeRoomId))).toEqual([]);
    const dock = { paired: true as const, connectedRoomAddress: `ssf://join#room=${WELCOME}`, transient: true };
    expect(dockedStationFor('z1', [dock], atlas)).toBeNull();
    // A lone module the full planet left out still moves to its host.
    expect(dockedStationFor('zz', [dock], atlas)).toBe(DEFAULT_STATION_ID);
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

  it('keeps a renamed record\'s claim on a slot it shares with a later record', () => {
    const a = { id: 'a', name: 'A', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'room-a' };
    const b = { id: 'b', name: 'B', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'room-b' };
    expect(registerStation(a)).toBe(true);
    expect(registerStation(b)).toBe(true);
    const slots = () => listStations({}).map((st) => [st.id, st.orbitSlot]);
    expect(slots()).toEqual([[DEFAULT_STATION_ID, 0], ['a', 1], ['b', 2]]);
    expect(registerStation({ ...a, name: 'A PRIME' })).toBe(true);
    expect(slots()).toEqual([[DEFAULT_STATION_ID, 0], ['a', 1], ['b', 2]]);
    expect(readStationRecords().map((r) => r.name)).toEqual(['A PRIME', 'B']);
  });

  it('refuses to move a saved record into a station a later record holds', () => {
    const base = { name: 'X', planetId: DEFAULT_PLANET_ID, orbitSlot: 2 };
    expect(registerStation({ ...base, id: 'x', welcomeRoomId: 'far-1' })).toBe(true);
    expect(registerStation({ ...base, id: 'y', welcomeRoomId: 'far-2' })).toBe(true);
    expect(registerStation({ ...base, id: 'x', welcomeRoomId: 'far-2' })).toBe(false);
    expect(listStations({}).map((st) => [st.id, st.welcomeRoomId]))
      .toEqual([[DEFAULT_STATION_ID, WELCOME], ['x', 'far-1'], ['y', 'far-2']]);
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
    expect(registerStation({ ...base, berthDoor: 'not a door' })).toBe(false); // doorsDoc would drop it
    expect(readStationRecords()).toEqual([]);
    expect(registerStation({ ...base, berthDoor: 'd:3' })).toBe(true);
    store.set('ssf-stations', JSON.stringify([{ ...base, berthDoor: 'not a door' }]));
    expect(readStationRecords()).toEqual([]);
  });

  it('refuses a record once its planet has no free orbit slot', () => {
    // The built-in station holds one of Sovereign's slots.
    for (let i = 1; i < MAX_ORBIT_SLOTS; i++) {
      expect(registerStation({ id: `s${i}`, name: `S${i}`, planetId: DEFAULT_PLANET_ID, orbitSlot: i, welcomeRoomId: `r${i}` })).toBe(true);
    }
    expect(registerStation({ id: 'full', name: 'FULL', planetId: DEFAULT_PLANET_ID, orbitSlot: 0, welcomeRoomId: 'rx' })).toBe(false);
    // Nor may a record win a saved station's slot and leave it nowhere to go.
    expect(registerStation({ id: 'rival', name: 'RIVAL', planetId: DEFAULT_PLANET_ID, orbitSlot: 5, welcomeRoomId: 'a-room' })).toBe(false);
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

/** Runs `fn` against a stand-in document whose elements appear on first
 *  lookup, for the holotable's DOM paths. */
function withFakeDocument(fn: (els: Map<string, { style: Record<string, string>; textContent: string }>) => void): void {
  const els = new Map<string, { style: Record<string, string>; textContent: string; innerHTML: string; disabled?: boolean }>();
  (globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, { style: {}, textContent: '', innerHTML: '' });
      return els.get(id);
    },
  };
  try {
    fn(els);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
}

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
    withFakeDocument((els) => {
      const atlas = twoStations();
      const stations = listStations(atlas, []);
      const map = new SolarSystemMap();
      (map as unknown as { container: unknown }).container = {}; // mounted, for the repaint path
      map.refreshStations(stations, stationForRoom('lounge', atlas, stations));
      (map as unknown as { selectedBody: unknown }).selectedBody = stationBodies(stations)[0]; // Furlong
      map.refreshStations(stations, stationForRoom('yard-b', atlas, stations));
      expect(els.get('map-player-loc')?.textContent).toBe('YARD-A');
      expect(els.get('map-travel-btn')?.textContent).toBe('TRAVEL TO FURLONG LOBBY STATION');
    });
  });

  it('hides the details of a selected station that is gone', () => {
    withFakeDocument((els) => {
      const rec = { id: 'l4', name: 'L4 YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'r' };
      const map = new SolarSystemMap();
      (map as unknown as { container: unknown }).container = {};
      const internals = map as unknown as { selectedBody: unknown };
      internals.selectedBody = stationBodies([rec])[0];
      map.refreshStations(listStations({}, [rec]), DEFAULT_STATION_RECORD);
      expect(els.get('map-selection-details')?.style.display).toBe('flex');
      map.refreshStations(listStations({}, []), DEFAULT_STATION_RECORD);
      expect(internals.selectedBody).toBeNull();
      expect(els.get('map-selection-details')?.style.display).toBe('none');
    });
  });

  it('shows the location as unknown when no listed station holds the current room', () => {
    withFakeDocument((els) => {
      const rec = { id: 'l4', name: 'L4 YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'r' };
      const stations = listStations({}, [rec]);
      const map = new SolarSystemMap();
      (map as unknown as { container: unknown }).container = {};
      map.refreshStations(stations, DEFAULT_STATION_RECORD);
      // A trip under way keeps the station it left from.
      const internals = map as unknown as { travelDestination: unknown; selectedBody: unknown };
      internals.travelDestination = stationBodies(stations)[1];
      map.refreshStations(stations, null);
      expect(map.getPlayerLocationId()).toBe(DEFAULT_STATION_ID);
      // With no trip, a room no station holds is somewhere unknown, not Furlong.
      internals.travelDestination = null;
      internals.selectedBody = stationBodies(stations)[0]; // Furlong
      map.refreshStations(stations, null);
      expect(map.getPlayerLocationId()).toBe('');
      expect(els.get('map-player-loc')?.textContent).toBe('UNKNOWN');
      expect(els.get('map-travel-btn')?.textContent).toBe('TRAVEL TO FURLONG LOBBY STATION');
    });
  });

  it('keeps a holotable trip on its destination\'s refreshed body, and calls it off when the station is gone', () => {
    const rec = { id: 'l4', name: 'L4 YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: 'r' };
    const map = new SolarSystemMap();
    map.refreshStations(listStations({}, [rec]), null);
    const internals = map as unknown as { travelDestination: { id: string; name: string } | null };
    internals.travelDestination = stationBodies([rec])[0];
    map.refreshStations(listStations({}, [{ ...rec, name: 'L4 DEPOT' }]), null);
    expect(internals.travelDestination?.name).toBe('L4 DEPOT');
    map.refreshStations(listStations({}, []), DEFAULT_STATION_RECORD);
    expect(internals.travelDestination).toBeNull();
    expect(map.getPlayerLocationId()).toBe(DEFAULT_STATION_ID);
  });

  it('defaults to Furlong as the player location, as before', () => {
    expect(new SolarSystemMap().getPlayerLocationId()).toBe('furlong-station');
  });
});
