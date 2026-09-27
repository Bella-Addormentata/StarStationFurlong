/**
 * 🪐 Per-planet summary — the peer guards, the merge rules (newest record,
 * newest trim), who may move a station's slot, learned stations pinning the
 * same slot on every install, new record fields passing through, two installs
 * sharing one room doc, the trim resolver, station-id aliases for flight
 * records, and the ship / solar-system reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ORBIT_EPOCH_MS, orbitForSlot, setStationTrimResolver, stationOrbit } from './orbits';
import {
  LEARNED_PREFIX,
  SHIP_STALE_MS,
  bindPlanetSummaryDoc,
  cleanShipSummary,
  cleanStationSummary,
  foldOwnStation,
  installTrimResolver,
  learnedRecord,
  mergeStation,
  publishPlanetSummary,
  readStore,
  refreshTrims,
  registerLearnedStations,
  resolveStationAlias,
  shipsAroundPlanet,
  summaryForStation,
  systemStationNames,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import type { PlanetSummaryContext, ShipStatusInput, StationSummary } from './planetSummary';
import type { OrbitTrim } from './stationKeeping';
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
const ARIS = 'planet-aris';
const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);

const summary = (over: Partial<StationSummary> = {}): StationSummary => ({
  welcomeRoomId: 'room-hab',
  name: 'HAB RING',
  planetId: SOV,
  orbitSlot: 2,
  updatedAt: T0,
  ...over,
});

const trim = (over: Partial<OrbitTrim> = {}): OrbitTrim => ({
  planetId: SOV,
  slot: 2,
  dRadiusKm: 4,
  dPhase: 0.01,
  at: T0,
  last: 'raise',
  ...over,
});

const record = (over: Partial<StationRecord> = {}): StationRecord => ({
  id: 'hab',
  name: 'HAB RING',
  planetId: SOV,
  orbitSlot: 2,
  welcomeRoomId: 'room-hab',
  ...over,
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

describe('guards', () => {
  it('accepts a well-formed station summary and copies only known fields', () => {
    const s = cleanStationSummary({ ...summary(), trim: { ...trim(), fuelDrawn: 7 }, junk: 1 }, T0);
    expect(s).toEqual({ ...summary(), trim: { ...trim() } });
    expect(s?.trim).not.toHaveProperty('fuelDrawn');
  });

  it('refuses bad shapes, slots and future stamps', () => {
    expect(cleanStationSummary(null, T0)).toBeNull();
    expect(cleanStationSummary([summary()], T0)).toBeNull();
    expect(cleanStationSummary(summary({ name: '' }), T0)).toBeNull();
    expect(cleanStationSummary(summary({ welcomeRoomId: 'x'.repeat(200) }), T0)).toBeNull();
    expect(cleanStationSummary(summary({ orbitSlot: 16 }), T0)).toBeNull();
    expect(cleanStationSummary(summary({ orbitSlot: 1.5 }), T0)).toBeNull();
    expect(cleanStationSummary(summary({ updatedAt: T0 + 7 * 3600 * 1000 }), T0)).toBeNull();
  });

  it('strips credential-named fields from ext at any depth', () => {
    const s = cleanStationSummary({ ...summary(), ext: { seed: 'x', welcomeLink: 'y', note: { pass: 'z', ok: 1 }, passage: 'public' } }, T0);
    expect(s?.ext).toEqual({ note: { ok: 1 }, passage: 'public' });
  });

  it('breaks a same-moment tie the same way on every client', () => {
    const a = summary({ orbitSlot: 3, trim: trim({ dRadiusKm: 1 }) });
    const b = summary({ orbitSlot: 5, trim: trim({ dRadiusKm: 2 }) });
    const ab = mergeStation(a, b) ?? a;
    const ba = mergeStation(b, a) ?? b;
    expect(ab).toEqual(ba);
  });

  it('drops a malformed trim but keeps the record', () => {
    const s = cleanStationSummary({ ...summary(), trim: { ...trim(), dRadiusKm: 999 } }, T0);
    expect(s).toEqual(summary());
  });

  it('drops a trim stamped further ahead than the gossip skew', () => {
    const far = cleanStationSummary({ ...summary(), trim: trim({ at: T0 + 7 * 3600 * 1000 }) }, T0);
    expect(far).toEqual(summary());
    const near = cleanStationSummary({ ...summary(), trim: trim({ at: T0 + 3600 * 1000 }) }, T0);
    expect(near?.trim?.at).toBe(T0 + 3600 * 1000);
  });

  it('carries unknown record fields in ext, bounded and without known keys', () => {
    const move = { toPlanetId: ARIS, arriveAt: T0 + 1000 };
    const s = cleanStationSummary({ ...summary(), ext: { move, id: 'evil', orbitSlot: 9 } }, T0);
    expect(s?.ext).toEqual({ move });
    expect(cleanStationSummary({ ...summary(), ext: { big: 'x'.repeat(2000) } }, T0)?.ext).toBeUndefined();
    expect(cleanStationSummary({ ...summary(), ext: [1, 2] }, T0)?.ext).toBeUndefined();
  });

  it('checks ship summaries', () => {
    const ship = { roomId: 'room-ship', name: 'FERRY', planetId: SOV, status: 'in-flight', fromRoom: 'a', toRoom: 'b', departedAt: T0, etaAt: T0 + 60_000, updatedAt: T0 };
    expect(cleanShipSummary(ship, T0)).toEqual(ship);
    expect(cleanShipSummary({ ...ship, status: 'warp' }, T0)).toBeNull();
    expect(cleanShipSummary({ ...ship, etaAt: Infinity }, T0)).toBeNull();
    expect(cleanShipSummary({ ...ship, seed: 'secret' }, T0)).not.toHaveProperty('seed');
  });
});

describe('merge', () => {
  it('takes the newer record and, separately, the newer trim', () => {
    const older = summary({ name: 'OLD', updatedAt: T0, trim: trim({ at: T0 + 5000 }) });
    const newer = summary({ name: 'NEW', updatedAt: T0 + 1, trim: trim({ at: T0, dRadiusKm: -2 }) });
    const merged = mergeStation(older, newer);
    expect(merged?.name).toBe('NEW');
    expect(merged?.trim?.at).toBe(T0 + 5000);
  });

  it('reports no change for the same summary', () => {
    expect(mergeStation(summary(), summary())).toBeNull();
    expect(mergeStation(summary({ updatedAt: T0 + 1 }), summary())).toBeNull();
  });
});

describe('this client\'s own station', () => {
  it('publishes a trim only when it names the station\'s planet and slot', () => {
    expect(summaryForStation(record(), trim(), T0).trim).toBeDefined();
    expect(summaryForStation(record(), trim({ slot: 3 }), T0).trim).toBeUndefined();
  });

  it('an owned record moves its slot with a newer stamp', () => {
    const known = summary({ orbitSlot: 2, updatedAt: T0 });
    const next = foldOwnStation(known, record({ orbitSlot: 5 }), null, T0 + 10);
    expect(next?.orbitSlot).toBe(5);
    expect(next?.ownerId).toBe('hab');
    expect(next!.updatedAt).toBeGreaterThan(known.updatedAt);
  });

  it('a derived station never overwrites the slot already known', () => {
    const known = summary({ orbitSlot: 2 });
    const derived = record({ id: 'station:room-hab', orbitSlot: 1, derived: true });
    expect(foldOwnStation(known, derived, null, T0 + 10)).toBeNull();
  });

  it('a derived station still adds a newer trim', () => {
    const known = summary({ orbitSlot: 2 });
    const derived = record({ id: 'station:room-hab', orbitSlot: 1, derived: true });
    const next = foldOwnStation(known, derived, trim({ slot: 1, at: T0 + 5 }), T0 + 10);
    // The trim names slot 1 (this client's derived slot), and the station
    // flies slot 2 here — so it does not apply and nothing changes.
    expect(next).toBeNull();
    const applies = foldOwnStation(known, derived, trim({ slot: 2, at: T0 + 5 }), T0 + 10);
    expect(applies?.trim?.at).toBe(T0 + 5);
    expect(applies?.orbitSlot).toBe(2);
  });
});

describe('learned stations', () => {
  it('register under shared: ids and pin the published slot', () => {
    expect(registerLearnedStations(SOV, [summary({ orbitSlot: 7 })])).toBe(1);
    const st = listStations().find((s) => s.welcomeRoomId === 'room-hab');
    expect(st?.id).toBe(`${LEARNED_PREFIX}room-hab`);
    expect(st?.orbitSlot).toBe(7);
    // Unchanged: nothing written again.
    expect(registerLearnedStations(SOV, [summary({ orbitSlot: 7 })])).toBe(0);
  });

  it('leave a place this install saved itself alone', () => {
    expect(registerStation(record({ id: 'mine', orbitSlot: 3 }))).toBe(true);
    expect(registerLearnedStations(SOV, [summary({ orbitSlot: 7 })])).toBe(0);
    expect(listStations().find((s) => s.welcomeRoomId === 'room-hab')?.id).toBe('mine');
  });

  it('only register stations around the given planet', () => {
    expect(registerLearnedStations(SOV, [summary({ planetId: ARIS })])).toBe(0);
    expect(readStationRecords()).toEqual([]);
  });

  it('drop learned records from another planet when asked to prune, never this install\'s own', () => {
    registerStation(record({ id: 'mine', welcomeRoomId: 'room-mine', planetId: ARIS, orbitSlot: 3 }));
    registerLearnedStations(SOV, [summary()]);
    expect(readStationRecords().map((r) => r.id)).toContain(`${LEARNED_PREFIX}room-hab`);
    // Not pruning (this client's planet unknown): the learned record stays.
    registerLearnedStations(ARIS, []);
    expect(readStationRecords().map((r) => r.id)).toContain(`${LEARNED_PREFIX}room-hab`);
    expect(registerLearnedStations(ARIS, [], { prune: true })).toBe(1);
    expect(readStationRecords().map((r) => r.id)).toEqual(['mine']);
  });

  it('carry new record fields through to the record they register', () => {
    const move = { toPlanetId: ARIS };
    expect(learnedRecord(summary({ ext: { move } }))).toMatchObject({ move, id: 'shared:room-hab', orbitSlot: 2 });
  });
});

// ── Two installs, one room doc ───────────────────────────────────────────────

function install(stationId: string | null, over: Partial<PlanetSummaryContext> = {}): PlanetSummaryContext {
  return {
    currentStation: () => (stationId ? listStations().find((s) => s.id === stationId) ?? null : null),
    localTrim: () => null,
    ship: () => null,
    ...over,
  };
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
}

describe('sharing through the room doc', () => {
  it('a station and its trim reach another install, which flies the same orbit', () => {
    // Install A owns HAB RING in slot 2 and has trimmed it.
    const a = new Map<string, string>();
    store = a;
    registerStation(record());
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install('hab', { localTrim: () => trim() }));
    expect(readStore().stations['room-hab']?.trim?.dRadiusKm).toBe(4);

    // Install B has never heard of it; it joins the same room.
    unbindPlanetSummaryForTest();
    store = new Map();
    const docB = new Y.Doc();
    sync(docA, docB);
    bindPlanetSummaryDoc(docB, install(null));
    installTrimResolver();
    const learned = listStations().find((s) => s.welcomeRoomId === 'room-hab');
    expect(learned?.id).toBe('shared:room-hab');
    expect(learned?.orbitSlot).toBe(2);
    const orbit = stationOrbit(learned!);
    expect(orbit.radiusKm).toBeCloseTo(orbitForSlot(SOV, 2).radiusKm + 4, 6);
  });

  it('a later trim from a peer replaces the older one live', () => {
    registerStation(record());
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install('hab', { localTrim: () => trim() }));
    installTrimResolver();
    const peer = new Y.Doc();
    sync(doc, peer);
    peer.getMap('stationSummaries').set('room-hab', { ...summary(), trim: trim({ at: T0 + 60_000, dRadiusKm: -6 }) });
    sync(peer, doc);
    const hab = listStations().find((s) => s.id === 'hab')!;
    expect(stationOrbit(hab).radiusKm).toBeCloseTo(orbitForSlot(SOV, 2).radiusKm - 6, 6);
  });

  it('ignores junk a peer writes into the maps', () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null));
    const peer = new Y.Doc();
    peer.getMap('stationSummaries').set('room-x', { name: 'no room id' });
    peer.getMap('stationSummaries').set('room-y', summary({ welcomeRoomId: 'room-z' }));
    peer.getMap('shipSummaries').set('s', 42);
    sync(peer, doc);
    expect(readStore().stations).toEqual({});
    expect(readStore().ships).toEqual({});
  });

  it('prunes the shared maps to their newest valid entries on publish', () => {
    const doc = new Y.Doc();
    const now = Date.now();
    const map = doc.getMap('stationSummaries');
    for (let i = 0; i < 300; i++) map.set(`junk-${i}`, { name: 'junk' });
    for (let i = 0; i < 70; i++) {
      const id = `room-${String(i).padStart(3, '0')}`;
      map.set(id, summary({ welcomeRoomId: id, name: `S${i}`, updatedAt: now - (70 - i) * 1000 }));
    }
    // One prune pass visits a bounded number of keys (64 * 4), so no single
    // transaction deletes more than that; later passes finish the job.
    let mostDeleted = 0;
    map.observe((e) => {
      let n = 0;
      e.changes.keys.forEach((c) => { if (c.action === 'delete') n++; });
      mostDeleted = Math.max(mostDeleted, n);
    });
    bindPlanetSummaryDoc(doc, install(null));
    publishPlanetSummary(now);
    publishPlanetSummary(now);
    expect(mostDeleted).toBeLessThanOrEqual(256);
    const keys = [...map.keys()];
    expect(keys.some((k) => k.startsWith('junk-'))).toBe(false);
    expect(keys).toHaveLength(64);
    // The oldest six went; the newest stayed.
    expect(keys).not.toContain('room-000');
    expect(keys).toContain('room-069');
    // …and entries the first bounded pull never reached are read right after.
    expect(readStore(now).stations['room-069']?.name).toBe('S69');
  });

  it('never publishes a seed', () => {
    registerStation(record());
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install('hab'));
    expect(JSON.stringify(doc.getMap('stationSummaries').toJSON())).not.toMatch(/seed|pass/i);
  });

  it('keeps the untrimmed slot orbit when no trim is known', () => {
    registerStation(record());
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install('hab'));
    installTrimResolver();
    refreshTrims();
    const hab = listStations().find((s) => s.id === 'hab')!;
    expect(stationOrbit(hab)).toEqual(orbitForSlot(SOV, 2));
  });
});

describe('ships and the solar system', () => {
  const ship: ShipStatusInput = { roomId: 'room-ship', name: 'FERRY', planetId: SOV, status: 'docked', fromRoom: 'room-hab' };

  it('publishes the ship this client stands in, and lists ships per planet', () => {
    let status = ship;
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null, { ship: () => status }));
    expect(shipsAroundPlanet(SOV).map((s) => s.name)).toEqual(['FERRY']);
    expect(shipsAroundPlanet(ARIS)).toEqual([]);
    status = { ...ship, status: 'in-flight', toRoom: 'room-b', departedAt: T0, etaAt: T0 + 60_000 };
    publishPlanetSummary(Date.now() + 1);
    expect(doc.getMap('shipSummaries').get('room-ship')).toMatchObject({ status: 'in-flight', toRoom: 'room-b' });
  });

  it('settles a same-moment pair of ship values the same way in the doc', () => {
    const doc = new Y.Doc();
    const now = Date.now();
    const a = { ...ship, status: 'docked' as const, updatedAt: now };
    const b = { ...ship, status: 'in-flight' as const, toRoom: 'room-b', departedAt: now, etaAt: now + 60_000, updatedAt: now };
    const winner = JSON.stringify(b) > JSON.stringify(a) ? b : a;
    const loser = winner === a ? b : a;
    doc.getMap('shipSummaries').set('room-ship', loser);
    bindPlanetSummaryDoc(doc, install(null, { ship: () => null }));
    store.set('ssf-planet-summary', JSON.stringify({ stations: {}, ships: { 'room-ship': winner } }));
    publishPlanetSummary(now);
    expect(doc.getMap('shipSummaries').get('room-ship')).toEqual(winner);
  });

  it('forgets a ship not heard from in a day', () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null, { ship: () => ship }));
    expect(shipsAroundPlanet(SOV, Date.now() + SHIP_STALE_MS + 1000)).toEqual([]);
  });

  it('refreshes an unchanged ship\'s stamp once an hour, so it never goes stale aboard', () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null, { ship: () => ship }));
    const first = (doc.getMap('shipSummaries').get('room-ship') as { updatedAt: number }).updatedAt;
    publishPlanetSummary(first + 60_000);
    expect((doc.getMap('shipSummaries').get('room-ship') as { updatedAt: number }).updatedAt).toBe(first);
    publishPlanetSummary(first + 3600 * 1000);
    expect((doc.getMap('shipSummaries').get('room-ship') as { updatedAt: number }).updatedAt).toBe(first + 3600 * 1000);
  });

  it('gives the rest of the system as names only', () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null));
    const peer = new Y.Doc();
    peer.getMap('stationSummaries').set('room-far', summary({ welcomeRoomId: 'room-far', name: 'ARIS DEEP', planetId: ARIS, updatedAt: Date.now() }));
    sync(peer, doc);
    expect(systemStationNames(SOV)).toEqual([{ name: 'ARIS DEEP', planetId: ARIS }]);
    // Not registered as a station here: it orbits another planet.
    expect(listStations().some((s) => s.welcomeRoomId === 'room-far')).toBe(false);
  });
});

describe('station id aliases (flight records cross installs)', () => {
  it('maps derived and learned ids to the station this install lists for that room', () => {
    registerStation(record({ id: 'mine' }));
    expect(resolveStationAlias('mine')).toBe('mine');
    expect(resolveStationAlias('station:room-hab')).toBe('mine');
    expect(resolveStationAlias('shared:room-hab')).toBe('mine');
    expect(resolveStationAlias('station:room-nowhere')).toBeNull();
  });

  it('maps another install\'s saved id through the summary that carries it', () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null));
    const peer = new Y.Doc();
    peer.getMap('stationSummaries').set('room-hab', { ...summary({ updatedAt: Date.now() }), ownerId: 'their-hab' });
    sync(peer, doc);
    expect(resolveStationAlias('their-hab')).toBe('shared:room-hab');
    expect(resolveStationAlias('someone-else')).toBeNull();
  });
});

it('epoch sanity: fixtures sit after the orbital epoch', () => {
  expect(T0).toBeGreaterThan(ORBIT_EPOCH_MS);
});
