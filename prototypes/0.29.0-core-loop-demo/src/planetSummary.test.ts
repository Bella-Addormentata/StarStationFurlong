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
  MAX_TRIM_GONE,
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
  subscribePlanetSummary,
  summaryForStation,
  summaryPlanet,
  systemStationNames,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import type { PlanetSummaryContext, ShipStatusInput, StationSummary } from './planetSummary';
import type { OrbitTrim } from './stationKeeping';
import { DEFAULT_PLANET_ID, listStations, readStationRecords, registerStation, setStationMoveResolver } from './stations';
import type { StationMove, StationRecord } from './stations';
import { rememberMove } from './stationMove';

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
    const s = cleanStationSummary({ ...summary(), trim: { ...trim(), fuelDrawn: 7, junk: 2 }, junk: 1 }, T0);
    expect(s).toEqual({ ...summary(), trim: { ...trim(), fuelDrawn: 7 } });
  });

  it('settles trims whose last burns share a moment on the one with more burns, in either order', () => {
    const lower = summary({ trim: trim({ dRadiusKm: -2, fuelDrawn: 1 }) });
    const raise = summary({ trim: trim({ dRadiusKm: 2, fuelDrawn: 1 }) });
    const both = summary({ trim: trim({ dRadiusKm: 0, fuelDrawn: 2 }) });
    for (const [a, b] of [[lower, raise], [raise, lower]]) {
      const partial = mergeStation(a, b) ?? a;
      expect(mergeStation(partial, both)?.trim?.dRadiusKm).toBe(0);
      expect(mergeStation(both, partial)).toBeNull();
    }
  });

  it('settles a same-moment trim from a build without fuel counts on the one that has them, in either order', () => {
    const old = summary({ trim: trim({ dRadiusKm: 2 }) });
    const counted = summary({ trim: trim({ dRadiusKm: 0, fuelDrawn: 2 }) });
    expect((mergeStation(old, counted) ?? old).trim?.dRadiusKm).toBe(0);
    expect(mergeStation(counted, old)).toBeNull();
  });

  it("keeps a newer trim the standing record's own install flies on another slot", () => {
    // A slot clash moved this station off the slot its record asks for; its
    // own republish carries the record unchanged with the flown slot's trim.
    const first = summary({ orbitSlot: 2, trim: trim({ slot: 2, at: T0 }) });
    const same = { ...first, trim: trim({ slot: 3, at: T0 + 40 }) };
    expect(mergeStation(first, same)?.trim?.slot).toBe(3);
    // …but never a trim of another planet.
    expect(mergeStation(first, { ...first, trim: trim({ planetId: ARIS, slot: 3, at: T0 + 40 }) })).toBeNull();
  });

  it('keeps the trim a moved station flies at its new planet', () => {
    // First stamped around SOV; since moved to ARIS. Its own republish
    // carries the record unchanged with the trim of the orbit it flies now.
    const move: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: T0, arriveAt: T0 + 1000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const first = summary({ orbitSlot: 2, move });
    const flown = { ...first, trim: trim({ planetId: ARIS, slot: 5, at: T0 + 2000 }) };
    expect(mergeStation(first, flown, T0 + 3000)?.trim).toMatchObject({ planetId: ARIS, slot: 5 });
    // Before it arrived, a trim at ARIS is no trim of the station's.
    expect(mergeStation(first, flown, T0 + 500)).toBeNull();
    // …nor, once there, one of the planet it left.
    expect(mergeStation(first, { ...first, trim: trim({ slot: 3, at: T0 + 2000 }) }, T0 + 3000)).toBeNull();
  });

  it("keeps the standing record's trim over a newer one for another slot", () => {
    const first = summary({ orbitSlot: 2, trim: trim({ slot: 2, at: T0 }) });
    const late = summary({ orbitSlot: 1, updatedAt: T0 + 50, trim: trim({ slot: 1, at: T0 + 40 }) });
    const merged = mergeStation(first, late) ?? first;
    expect(merged.orbitSlot).toBe(2);
    expect(merged.trim?.slot).toBe(2);
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
    // `move` is a typed field now (stationMove.ts): a newer build's field
    // this one does not know rides ext instead.
    const tow = { toPlanetId: ARIS, arriveAt: T0 + 1000 };
    const s = cleanStationSummary({ ...summary(), ext: { tow, move: tow, id: 'evil', orbitSlot: 9 } }, T0);
    expect(s?.ext).toEqual({ tow });
    expect(cleanStationSummary({ ...summary(), ext: { big: 'x'.repeat(2000) } }, T0)?.ext).toBeUndefined();
    expect(cleanStationSummary({ ...summary(), ext: [1, 2] }, T0)?.ext).toBeUndefined();
    // An oversized value is dropped without walking all of it.
    let reads = 0;
    const huge = new Proxy(new Array(1_000_000).fill(0), {
      get: (t, k, r) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r); },
    });
    expect(cleanStationSummary({ ...summary(), ext: { huge } }, T0)?.ext).toBeUndefined();
    expect(reads).toBeLessThan(1000);
  });

  it("saves a learned station's extra fields, and does not rewrite it when they are unchanged", () => {
    const tow = { toPlanetId: ARIS, arriveAt: T0 + 1000 };
    const s = summary({ ext: { tow } });
    expect(registerLearnedStations(SOV, [s])).toBe(1);
    expect((readStationRecords().find((r) => r.welcomeRoomId === 'room-hab') as unknown as { tow?: unknown }).tow).toEqual(tow);
    expect(registerLearnedStations(SOV, [s])).toBe(0);
  });

  it("drops a learned station's extra field once the summary no longer carries it", () => {
    const tow = { toPlanetId: ARIS, arriveAt: T0 + 1000 };
    registerLearnedStations(SOV, [summary({ ext: { tow } })]);
    expect(registerLearnedStations(SOV, [summary()])).toBe(1);
    expect(readStationRecords().find((r) => r.welcomeRoomId === 'room-hab')).not.toHaveProperty('tow');
  });

  it('leaves out a berth a station record could not hold, keeping the station', () => {
    const s = cleanStationSummary({ ...summary(), berthDoor: 'not a door' }, T0);
    expect(s).not.toBeNull();
    expect(s).not.toHaveProperty('berthDoor');
  });

  it('lets one of two installs that own the same place stand for good, in either order', () => {
    const a = summary({ ownerId: 'alpha', orbitSlot: 2, updatedAt: T0 });
    const b = summary({ ownerId: 'beta', orbitSlot: 3, updatedAt: T0 + 50 });
    expect((mergeStation(a, b) ?? a).orbitSlot).toBe(2);
    expect(mergeStation(b, a)?.orbitSlot).toBe(2);
    // The losing install republishing, newer each time, changes nothing
    // once its id is kept as an alias.
    const settled = mergeStation(a, b)!;
    expect(settled.ownerAliases).toEqual(['beta']);
    expect(mergeStation(settled, { ...b, updatedAt: T0 + 5000 })).toBeNull();
  });

  it("does not republish over another install's identical record", () => {
    const known = summary({ ownerId: 'alpha', updatedAt: T0 });
    expect(foldOwnStation(known, record({ id: 'beta' }), null, T0 + 10)).toBeNull();
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
  it('takes the owner\'s newer record and, separately, the newer trim', () => {
    const older = summary({ name: 'OLD', ownerId: 'hab', updatedAt: T0, trim: trim({ at: T0 + 5000 }) });
    const newer = summary({ name: 'NEW', ownerId: 'hab', updatedAt: T0 + 1, trim: trim({ at: T0, dRadiusKm: -2 }) });
    const merged = mergeStation(older, newer);
    expect(merged?.name).toBe('NEW');
    expect(merged?.trim?.at).toBe(T0 + 5000);
  });

  it('keeps the first record nobody owns, and lets an owned one replace it', () => {
    const first = summary({ orbitSlot: 2, updatedAt: T0 });
    const late = summary({ orbitSlot: 4, updatedAt: T0 + 60_000 });
    // A late install's first publish does not move a derived station…
    expect(mergeStation(first, late)).toBeNull();
    expect(mergeStation(late, first)?.orbitSlot).toBe(2);
    // …but its owner's record does, whenever it was stamped.
    const owners = summary({ orbitSlot: 5, ownerId: 'hab', updatedAt: T0 - 1 });
    expect(mergeStation(first, owners)?.orbitSlot).toBe(5);
    expect(mergeStation(owners, late)).toBeNull();
  });

  it('reports no change for the same summary', () => {
    expect(mergeStation(summary(), summary())).toBeNull();
    expect(mergeStation(summary({ ownerId: 'hab', updatedAt: T0 + 1 }), summary({ ownerId: 'hab' }))).toBeNull();
    expect(mergeStation(summary(), summary({ updatedAt: T0 + 1 }))).toBeNull();
  });

  it('keeps each helm room\'s take-back, so a replayed trim of one room stays gone', () => {
    const fromA = summary({ trim: { ...trim(), from: 'room-a', readAt: T0 + 1 } });
    let s = mergeStation(fromA, summary({ trimGone: [{ from: 'room-a', readAt: T0 + 2 }] }))!;
    expect(s.trim).toBeUndefined();
    s = mergeStation(s, summary({ trimGone: [{ from: 'room-b', readAt: T0 + 3 }] }))!;
    expect(s.trimGone?.map((g) => g.from)).toEqual(['room-a', 'room-b']);
    // An offline peer replays room A's trim from before its take-back.
    expect(mergeStation(s, fromA)?.trim ?? s.trim).toBeUndefined();
    // Room B's own later reading still counts.
    const fromB = summary({ trim: { ...trim({ dRadiusKm: 6 }), from: 'room-b', readAt: T0 + 4 } });
    expect(mergeStation(s, fromB)?.trim?.dRadiusKm).toBe(6);
  });

  it('keeps a forgotten room\'s take-back as a floor past the cap', () => {
    const fromA = summary({ trim: { ...trim(), from: 'room-a', readAt: T0 + 1 } });
    let s = mergeStation(fromA, summary({ trimGone: [{ from: 'room-a', readAt: T0 + 2 }] }))!;
    // More rooms than the list keeps take back their trims later.
    for (let i = 0; i < MAX_TRIM_GONE + 5; i++) {
      s = mergeStation(s, summary({ trimGone: [{ from: `room-${1000 + i}`, readAt: T0 + 10 + i }] }))!;
    }
    expect(s.trimGone!.length).toBeLessThanOrEqual(MAX_TRIM_GONE + 1);
    expect(s.trimGone!.some((g) => g.from === 'room-a')).toBe(false);
    // Room A's pre-rollback reading is replayed: still gone.
    expect(mergeStation(s, fromA)?.trim ?? s.trim).toBeUndefined();
  });

  it('settles a merged record with a cleaned copy of itself, whatever order its fields were added in', () => {
    const withTrim = (owner: string) => summary({ ownerId: owner, trim: { ...trim(), from: 'room-hab', readAt: T0 } });
    const x = mergeStation(withTrim('beta'), withTrim('alpha'))!;
    expect(x.ownerAliases).toEqual(['beta']);
    const c = cleanStationSummary(x, T0 + 1)!;
    expect(JSON.stringify(c)).toBe(JSON.stringify(x));
    expect(mergeStation(c, x)).toBeNull();
    expect(mergeStation(x, c)).toBeNull();
  });

  it('reads a single take-back as the first builds sent it', () => {
    expect(cleanStationSummary({ ...summary(), trimGone: { from: 'room-a', readAt: T0 } }, T0)?.trimGone)
      .toEqual([{ from: 'room-a', readAt: T0 }]);
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

  it('supersedes a room\'s earlier readings when it changes under another room\'s trim', () => {
    const now = T0 + 60_000;
    const known = summary({ ownerId: 'hab', trim: { ...trim({ at: T0 + 10 }), from: 'room-b', readAt: T0 + 20 } });
    // Room A takes back its burn while room B's later one stands.
    const s1 = foldOwnStation(known, record(), trim({ at: T0 + 1, dRadiusKm: 1 }), now, 'room-a', true)!;
    expect(s1.trim?.from).toBe('room-b');
    expect(s1.trimGone?.find((g) => g.from === 'room-a')?.readAt).toBe(now);
    // Room B is then cleared, and an offline peer replays A's old reading.
    const s2 = mergeStation(s1, summary({ trimGone: [{ from: 'room-b', readAt: now + 1 }] }))!;
    expect(s2.trim).toBeUndefined();
    const old = summary({ trim: { ...trim({ at: T0 + 5, dRadiusKm: 9 }), from: 'room-a', readAt: T0 + 30 } });
    expect(mergeStation(s2, old)?.trim ?? s2.trim).toBeUndefined();
    // Room A's next reading still stands.
    const s3 = foldOwnStation(s2, record(), trim({ at: T0 + 1, dRadiusKm: 1 }), now + 5, 'room-a')!;
    expect(s3.trim?.dRadiusKm).toBe(1);
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

  it('places a moved station by its move, wherever its record was first stamped', () => {
    const move: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: T0, arriveAt: T0 + 1000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const moved = summary({ move });
    expect(summaryPlanet(moved, T0 + 1)).toBe(SOV);
    expect(summaryPlanet(moved, T0 + 1000)).toBe(ARIS);
    expect(summaryPlanet(summary({ move: { ...move, departAt: T0 + 1001, arriveAt: T0 + 1002, settles: move } }), T0)).toBe(ARIS);
    setStationMoveResolver((st) => (st.welcomeRoomId === 'room-hab' ? move : null));
    try {
      // Around its new planet it registers, and a prune there keeps it.
      expect(registerLearnedStations(ARIS, [moved])).toBe(1);
      expect(registerLearnedStations(ARIS, [moved], { prune: true })).toBe(0);
      expect(listStations().find((st) => st.welcomeRoomId === 'room-hab')?.planetId).toBe(ARIS);
      // Around its old one it does not.
      expect(registerLearnedStations(SOV, [moved], { prune: true })).toBe(1);
      expect(readStationRecords()).toEqual([]);
    } finally {
      setStationMoveResolver(null);
    }
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
  it('spreads a trim its room took back, to an older one and to none', () => {
    registerStation(record());
    let local: OrbitTrim | null = trim({ at: T0 + 1000, dRadiusKm: 4 });
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install('hab', { localTrim: () => local, currentRoom: () => 'room-hab' }));
    // Another install learns the trim.
    const other = new Map<string, string>();
    const seen = (): number | undefined => {
      const keep = store;
      store = other;
      const docB = new Y.Doc();
      sync(docA, docB);
      unbindPlanetSummaryForTest();
      bindPlanetSummaryDoc(docB, install(null));
      const d = readStore().stations['room-hab']?.trim?.dRadiusKm;
      unbindPlanetSummaryForTest();
      store = keep;
      bindPlanetSummaryDoc(docA, install('hab', { localTrim: () => local, currentRoom: () => 'room-hab' }));
      return d;
    };
    expect(seen()).toBe(4);
    // A stale level write won in the helm room: the trim is back to an older burn.
    local = trim({ at: T0, dRadiusKm: 2 });
    publishPlanetSummary(Date.now() + 1000);
    expect(seen()).toBe(2);
    // …and then to none at all.
    local = null;
    publishPlanetSummary(Date.now() + 2000);
    expect(seen()).toBeUndefined();
  });

  it('publishes a remembered move of a station this game is not aboard', () => {
    registerStation(record());
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install('hab'));
    expect(readStore().stations['room-hab']?.move).toBeUndefined();
    // Now aboard a tug elsewhere, which cancels that station's tow.
    unbindPlanetSummaryForTest();
    bindPlanetSummaryDoc(docA, install(null));
    const now = Date.now();
    const tow: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: now, arriveAt: now + 86_400_000, mode: 'tug', tugRoomId: 'tug', fuel: 10, fuelDrawn: 10, bookedAt: now,
    };
    const cancel: StationMove = {
      ...tow, toPlanetId: SOV, toSlot: 2, departAt: now + 1, arriveAt: now + 2, mode: 'thrusters', tugRoomId: undefined,
      fuel: 0, fuelDrawn: 0, settles: tow,
    };
    expect(rememberMove(tow, now)).toBe(true);
    expect(rememberMove(cancel, now)).toBe(true);
    publishPlanetSummary(now + 10);
    expect(readStore().stations['room-hab']?.move).toMatchObject({ settles: { mode: 'tug' }, toPlanetId: SOV });
    expect((docA.getMap('stationSummaries').get('room-hab') as StationSummary).move?.settles).toBeDefined();
  });

  it('two installs that each saved one place fly the standing record\'s slot', () => {
    // Install A saved HAB RING as 'a-hab' in slot 2 and published it.
    store = new Map();
    registerStation(record({ id: 'a-hab', orbitSlot: 2 }));
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install('a-hab'));
    // Install B saved the same place as 'b-hab' in slot 5, then joins.
    unbindPlanetSummaryForTest();
    store = new Map();
    registerStation(record({ id: 'b-hab', orbitSlot: 5 }));
    const docB = new Y.Doc();
    sync(docA, docB);
    bindPlanetSummaryDoc(docB, install('b-hab'));
    // The smaller owner id stands; B keeps its id and flies A's slot.
    expect(readStore().stations['room-hab']?.ownerId).toBe('a-hab');
    const b = listStations().find((s) => s.id === 'b-hab');
    expect(b?.orbitSlot).toBe(2);
    // Nothing left to republish over.
    const before = JSON.stringify(docB.getMap('stationSummaries').toJSON());
    publishPlanetSummary(Date.now() + 1000);
    expect(JSON.stringify(docB.getMap('stationSummaries').toJSON())).toBe(before);
  });

  it('moves this install\'s place to the standing record\'s planet', () => {
    // Install A saved HAB RING around ARIS in slot 2 and published it.
    registerStation(record({ id: 'a-hab', planetId: ARIS, orbitSlot: 2 }));
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install('a-hab'));
    // Install B saved the same place around the home planet, then joins.
    unbindPlanetSummaryForTest();
    store = new Map();
    registerStation(record({ id: 'b-hab', orbitSlot: 5 }));
    const docB = new Y.Doc();
    sync(docA, docB);
    bindPlanetSummaryDoc(docB, install('b-hab'));
    const b = listStations().find((s) => s.id === 'b-hab');
    expect(b?.planetId).toBe(ARIS);
    expect(b?.orbitSlot).toBe(2);
  });

  it('shares the trim of a station a slot clash moved, and every install flies it', () => {
    // Two stations nobody owns were each first published for ARIS slot 2;
    // room-a keeps it, so room-z flies the next free slot everywhere.
    const doc = new Y.Doc();
    const at = Date.now() - 1000;
    for (const room of ['room-a', 'room-z']) {
      doc.getMap('stationSummaries').set(room, {
        welcomeRoomId: room, name: room.toUpperCase(), planetId: ARIS, orbitSlot: 2, updatedAt: at,
      });
    }
    registerLearnedStations(ARIS, Object.values(doc.getMap('stationSummaries').toJSON() as Record<string, StationSummary>));
    const z = listStations().find((s) => s.welcomeRoomId === 'room-z')!;
    expect(z.orbitSlot).toBe(3);
    // A burn in room-z trims the orbit it flies.
    const burn = trim({ planetId: ARIS, slot: 3, at: at + 500 });
    bindPlanetSummaryDoc(doc, install(z.id, { localTrim: () => burn, currentRoom: () => 'room-z' }));
    expect(readStore().stations['room-z']?.orbitSlot).toBe(2);
    expect(readStore().stations['room-z']?.trim?.slot).toBe(3);
    // Another install learns both stations and flies room-z trimmed.
    unbindPlanetSummaryForTest();
    store = new Map();
    const other = new Y.Doc();
    sync(doc, other);
    bindPlanetSummaryDoc(other, install(null, { ship: () => null }));
    registerLearnedStations(ARIS, Object.values(readStore().stations));
    refreshTrims();
    installTrimResolver();
    const seen = listStations().find((s) => s.welcomeRoomId === 'room-z')!;
    expect(seen.orbitSlot).toBe(3);
    expect(stationOrbit(seen).radiusKm).toBeCloseTo(orbitForSlot(ARIS, 3).radiusKm + 4, 6);
  });

  it('places a one-room off-home station that is no ship by its shared summary', () => {
    const doc = new Y.Doc();
    doc.getMap('stationSummaries').set('room-x', {
      welcomeRoomId: 'room-x', name: 'ARIS DEPOT', planetId: ARIS, orbitSlot: 3, updatedAt: Date.now() - 1000,
    });
    const derived = { id: 'station:room-x', name: 'ROOM X', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'room-x', derived: true as const };
    bindPlanetSummaryDoc(doc, install(null, {
      currentStation: () => derived, currentRoom: () => 'room-x', notShipRoom: () => 'room-x',
    }));
    expect(listStations().find((s) => s.id === 'shared:room-x')?.planetId).toBe(ARIS);
  });

  it('keeps an unplaced ship\'s own entry when newer ships fill the list', () => {
    const doc = new Y.Doc();
    const now = Date.now();
    doc.getMap('shipSummaries').set('room-ship', {
      roomId: 'room-ship', name: 'FERRY', planetId: ARIS, status: 'docked', updatedAt: now - 60_000,
    });
    for (let i = 0; i < 40; i++) {
      doc.getMap('shipSummaries').set(`room-s${i}`, {
        roomId: `room-s${i}`, name: `S${i}`, planetId: SOV, status: 'docked', updatedAt: now - 1000 + i,
      });
    }
    const standIn = { id: 'station:room-ship', name: 'FERRY', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'room-ship', derived: true as const };
    bindPlanetSummaryDoc(doc, install(null, { currentStation: () => standIn, currentRoom: () => 'room-ship', notShipRoom: () => null }));
    expect(readStore().ships['room-ship']?.planetId).toBe(ARIS);
    expect(doc.getMap('shipSummaries').has('room-ship')).toBe(true);
  });

  it('places a fresh install standing in a ship by the ship\'s shared summary', () => {
    const doc = new Y.Doc();
    doc.getMap('stationSummaries').set('room-x', {
      welcomeRoomId: 'room-x', name: 'ARIS DEPOT', planetId: ARIS, orbitSlot: 3, updatedAt: Date.now() - 1000,
    });
    doc.getMap('shipSummaries').set('room-ship', {
      roomId: 'room-ship', name: 'FERRY', planetId: ARIS, status: 'docked', fromRoom: 'room-x', updatedAt: Date.now() - 1000,
    });
    // The ship's own one-room stand-in sits on the default planet.
    const standIn = { id: 'station:room-ship', name: 'FERRY', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'room-ship', derived: true as const };
    bindPlanetSummaryDoc(doc, install(null, { currentStation: () => standIn, currentRoom: () => 'room-ship' }));
    expect(listStations().find((s) => s.id === 'shared:room-x')?.planetId).toBe(ARIS);
  });

  it('places a fresh install by its own ship\'s summary however long the ship stood empty', () => {
    const doc = new Y.Doc();
    const old = Date.now() - 2 * SHIP_STALE_MS;
    doc.getMap('stationSummaries').set('room-x', {
      welcomeRoomId: 'room-x', name: 'ARIS DEPOT', planetId: ARIS, orbitSlot: 3, updatedAt: old,
    });
    doc.getMap('shipSummaries').set('room-ship', {
      roomId: 'room-ship', name: 'FERRY', planetId: ARIS, status: 'docked', fromRoom: 'room-x', updatedAt: old,
    });
    doc.getMap('shipSummaries').set('room-gone', {
      roomId: 'room-gone', name: 'HULK', planetId: ARIS, status: 'docked', updatedAt: old,
    });
    const standIn = { id: 'station:room-ship', name: 'FERRY', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'room-ship', derived: true as const };
    bindPlanetSummaryDoc(doc, install(null, { currentStation: () => standIn, currentRoom: () => 'room-ship' }));
    expect(listStations().find((s) => s.id === 'shared:room-x')?.planetId).toBe(ARIS);
    // The entry stays for its own room, but other ships long gone go, and
    // neither is listed as a ship around the planet.
    expect(doc.getMap('shipSummaries').has('room-ship')).toBe(true);
    expect(doc.getMap('shipSummaries').has('room-gone')).toBe(false);
    expect(shipsAroundPlanet(ARIS)).toEqual([]);
  });

  it('never publishes a ship\'s own one-room stand-in as a station', () => {
    const doc = new Y.Doc();
    const standIn = { id: 'station:room-ship', name: 'FERRY', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'room-ship', derived: true as const };
    bindPlanetSummaryDoc(doc, install(null, { currentStation: () => standIn, currentRoom: () => 'room-ship' }));
    expect(doc.getMap('stationSummaries').has('room-ship')).toBe(false);
    expect(readStore().stations['room-ship']).toBeUndefined();
    // The same one-room place, known to be no ship, is a station.
    unbindPlanetSummaryForTest();
    bindPlanetSummaryDoc(doc, install(null, {
      currentStation: () => standIn, currentRoom: () => 'room-ship', notShipRoom: () => 'room-ship',
    }));
    expect(doc.getMap('stationSummaries').has('room-ship')).toBe(true);
  });

  it('tells its own views about what it just published', () => {
    registerStation(record());
    let local: OrbitTrim | null = null;
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install('hab', { localTrim: () => local, currentRoom: () => 'room-hab' }));
    let heard = 0;
    const stop = subscribePlanetSummary(() => { heard++; });
    local = trim({ at: T0 + 1000 });
    publishPlanetSummary(Date.now() + 1000);
    stop();
    expect(heard).toBeGreaterThan(0);
  });

  it('places a fresh install standing in an off-home station by the room\'s shared summary', () => {
    const doc = new Y.Doc();
    doc.getMap('stationSummaries').set('room-x', {
      welcomeRoomId: 'room-x', name: 'ARIS DEPOT', planetId: ARIS, orbitSlot: 3, updatedAt: Date.now() - 1000,
    });
    // This install only knows the room from its atlas: a derived record on the
    // default planet.
    const derived = { id: 'station:room-x', name: 'ROOM X', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'room-x', derived: true as const };
    bindPlanetSummaryDoc(doc, install(null, { currentStation: () => derived }));
    const learned = listStations().find((s) => s.id === 'shared:room-x');
    expect(learned?.planetId).toBe(ARIS);
    expect(learned?.orbitSlot).toBe(3);
  });

  it('keeps extras near the cap on a record whose core fields are long', () => {
    const extra = { note: 'x'.repeat(900) };
    const out = summaryForStation({ ...record(), name: 'N'.repeat(60), ...extra } as never, null, T0);
    expect(out.ext).toEqual(extra);
  });

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

  it('writes the winner back when a peer\'s value loses the merge', () => {
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null));
    // The first published (unowned) record stands here…
    const peer1 = new Y.Doc();
    peer1.getMap('stationSummaries').set('room-hab', summary({ orbitSlot: 2, updatedAt: T0 }));
    sync(peer1, doc);
    // …and a later first publish from an install that was offline reaches the map.
    const peer2 = new Y.Doc();
    peer2.getMap('stationSummaries').set('room-hab', summary({ orbitSlot: 1, updatedAt: T0 + 50 }));
    sync(peer2, doc);
    expect(readStore().stations['room-hab']?.orbitSlot).toBe(2);
    expect((doc.getMap('stationSummaries').get('room-hab') as StationSummary).orbitSlot).toBe(2);
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

  it('keeps its own station through a flood of newer peer summaries', () => {
    registerStation(record());
    const doc = new Y.Doc();
    const now = Date.now();
    const map = doc.getMap('stationSummaries');
    map.set('room-hab', summary({ updatedAt: now - 60 * 60 * 1000 }));
    for (let i = 0; i < 70; i++) {
      const id = `room-${String(i).padStart(3, '0')}`;
      // Stamped an hour ahead: inside the allowed skew, newer than ours.
      map.set(id, summary({ welcomeRoomId: id, name: `S${i}`, orbitSlot: 3, updatedAt: now + 60 * 60 * 1000 }));
    }
    bindPlanetSummaryDoc(doc, install('hab'));
    publishPlanetSummary(now);
    expect(map.has('room-hab')).toBe(true);
    expect(readStore(now).stations['room-hab']).toBeDefined();
  });

  it("keeps this planet's other stations through a flood from another planet", () => {
    registerStation(record());
    const doc = new Y.Doc();
    const now = Date.now();
    const map = doc.getMap('stationSummaries');
    map.set('room-near', summary({ welcomeRoomId: 'room-near', name: 'NEAR', orbitSlot: 5, updatedAt: now - 60 * 60 * 1000 }));
    for (let i = 0; i < 70; i++) {
      const id = `room-${String(i).padStart(3, '0')}`;
      map.set(id, summary({ welcomeRoomId: id, name: `S${i}`, planetId: ARIS, orbitSlot: 3, updatedAt: now + 60 * 60 * 1000 }));
    }
    bindPlanetSummaryDoc(doc, install('hab'));
    publishPlanetSummary(now);
    expect(map.has('room-near')).toBe(true);
    expect(readStore(now).stations['room-near']).toBeDefined();
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

  it('keeps the ship entry while a ship\'s planet is not placed yet', () => {
    let status: ShipStatusInput | null = ship;
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null, { ship: () => status, notShipRoom: () => null }));
    status = null; // still a ship, but its stations are not listed yet
    publishPlanetSummary(Date.now() + 1);
    expect(shipsAroundPlanet(SOV).map((s) => s.name)).toEqual(['FERRY']);
  });

  it('withdraws the ship entry when the room stops being a ship', () => {
    let status: ShipStatusInput | null = ship;
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, install(null, { ship: () => status, notShipRoom: () => (status ? null : 'room-ship') }));
    expect(shipsAroundPlanet(SOV).map((s) => s.name)).toEqual(['FERRY']);
    status = null; // bolted into a station
    publishPlanetSummary(Date.now() + 1);
    expect(shipsAroundPlanet(SOV)).toEqual([]);
    expect(doc.getMap('shipSummaries').get('room-ship')).toMatchObject({ retired: true });
    // Another install that still holds the old entry learns the withdrawal.
    const other = new Y.Doc();
    sync(doc, other);
    unbindPlanetSummaryForTest();
    store.set('ssf-planet-summary', JSON.stringify({ stations: {}, ships: { 'room-ship': { ...ship, updatedAt: Date.now() - 1000 } } }));
    expect(shipsAroundPlanet(SOV).map((s) => s.name)).toEqual(['FERRY']);
    bindPlanetSummaryDoc(other, install(null));
    expect(shipsAroundPlanet(SOV)).toEqual([]);
  });

  it('stamps a local ship change past a peer stamp that runs ahead', () => {
    let status = ship;
    const doc = new Y.Doc();
    const ahead = Date.now() + 3600 * 1000;
    doc.getMap('shipSummaries').set('room-ship', { ...ship, updatedAt: ahead });
    bindPlanetSummaryDoc(doc, install(null, { ship: () => status }));
    status = { ...ship, status: 'in-flight', toRoom: 'room-b', departedAt: T0, etaAt: T0 + 60_000 };
    publishPlanetSummary(Date.now());
    expect(doc.getMap('shipSummaries').get('room-ship')).toMatchObject({ status: 'in-flight', updatedAt: ahead + 1 });
  });

  it('keeps the same ships when more than fit share one stamp, whatever the arrival order', () => {
    const now = Date.now();
    const keys = Array.from({ length: 40 }, (_, i) => `room-s${String(i).padStart(2, '0')}`);
    const kept = (order: string[]) => {
      unbindPlanetSummaryForTest();
      store.clear();
      const doc = new Y.Doc();
      for (const k of order) doc.getMap('shipSummaries').set(k, { ...ship, roomId: k, updatedAt: now });
      bindPlanetSummaryDoc(doc, install(null));
      return Object.keys(readStore(now).ships).sort();
    };
    expect(kept(keys)).toEqual(kept([...keys].reverse()));
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
  it('resolves a losing install\'s owner id to the standing record\'s room', () => {
    const merged = mergeStation(summary({ ownerId: 'beta' }), summary({ ownerId: 'alpha' }))!;
    expect(merged.ownerId).toBe('alpha');
    expect(merged.ownerAliases).toEqual(['beta']);
    // A later republish by the winner keeps the alias.
    expect(mergeStation(merged, summary({ ownerId: 'alpha', updatedAt: T0 + 5 }))?.ownerAliases).toEqual(['beta']);
    store.set('ssf-planet-summary', JSON.stringify({ stations: { 'room-hab': merged }, ships: {} }));
    registerStation(record({ id: 'mine' }));
    expect(resolveStationAlias('beta')).toBe('mine');
    expect(cleanStationSummary({ ...merged, ownerAliases: ['beta', 'alpha', 7] }, T0)?.ownerAliases).toEqual(['beta']);
  });

  it('maps derived and learned ids to the station this install lists for that room', () => {
    registerStation(record({ id: 'mine' }));
    expect(resolveStationAlias('mine')).toBe('mine');
    expect(resolveStationAlias('station:room-hab')).toBe('mine');
    expect(resolveStationAlias('shared:room-hab')).toBe('mine');
    expect(resolveStationAlias('station:room-nowhere')).toBeNull();
  });

  it("resolves a learned id by its room even when a local record has that id", () => {
    // A hand-made record whose id only looks learned (another room).
    registerStation(record({ id: 'shared:room-hab', welcomeRoomId: 'room-odd', orbitSlot: 4 }));
    registerStation(record({ id: 'mine' }));
    expect(resolveStationAlias('shared:room-hab')).toBe('mine');
    // …and it is the install's own: no prune takes it.
    expect(registerLearnedStations(ARIS, [], { prune: true })).toBe(0);
    expect(readStationRecords().some((r) => r.id === 'shared:room-hab')).toBe(true);
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
