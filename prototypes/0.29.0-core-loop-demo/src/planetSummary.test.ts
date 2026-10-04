/**
 * 🪐 Per-planet summary — the peer guards, the merge rules (newest record,
 * newest trim), who may move a station's slot, learned stations pinning the
 * same slot on every install, new record fields passing through, two installs
 * sharing one room doc, the trim resolver, station-id aliases for flight
 * records, and the ship / solar-system reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ORBIT_EPOCH_MS, orbitForSlot, planTransfer, setStationTrimResolver, stationOrbit } from './orbits';
import {
  LEARNED_PREFIX,
  MAX_TRIM_GONE,
  SHIP_HEARTBEAT_MS,
  SHIP_STALE_MS,
  bindPlanetSummaryDoc,
  cleanShipSummary,
  cleanStationSummary,
  foldOwnStation,
  installKnownPlacesResolver,
  installTrimResolver,
  learnedRecord,
  legEndFields,
  mergeStation,
  publishPlanetSummary,
  ROUTE_SUMMARY_REFRESH_MS,
  readStore,
  refreshTrims,
  registerLearnedStations,
  resolveStationAlias,
  shipsAroundPlanet,
  subscribePlanetSummary,
  summaryForStation,
  summaryLegEnds,
  summaryPlanet,
  systemStationNames,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import type { PlanetSummaryContext, ShipStatusInput, StationSummary } from './planetSummary';
import type { RouteFlightPlaces } from './pilotRoute';
import type { OrbitTrim } from './stationKeeping';
import {
  DEFAULT_PLANET_ID, MAX_ORBIT_SLOTS, knownSlotsAround, listStations, readStationRecords, registerStation, setKnownPlacesResolver,
  setStationMoveResolver,
} from './stations';
import type { StationMove, StationRecord } from './stations';
import { freeSlotAround, installStationMoveResolver, rememberMove, rememberedMoveFor } from './stationMove';
import { directoryFromStationRecords, localStationId, setStationDirectory } from './stationDirectory';
import { bindShipDoc, readFlightRecord, writeFlightRecord } from './shipDoc';

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
    // Arrived but not pinned yet, it may have bounced home off a full
    // planet: a newer trim of the planet it left stands, on its old slot or
    // the next free one there.
    for (const slot of [2, 3]) {
      expect(mergeStation(flown, { ...first, trim: trim({ slot, at: T0 + 2500 }) }, T0 + 3000)?.trim)
        .toMatchObject({ planetId: SOV, slot });
    }
  });

  it("keeps a pinned arrival's trim over a newer one of the orbit its record was first stamped in", () => {
    // A derived station first stamped at SOV slot 2, its arrival at ARIS
    // slot 5 since pinned, flying a trim there.
    const move: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: T0, arriveAt: T0 + 1000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const pin: StationMove = {
      ...move, fromPlanetId: ARIS, fromSlot: 5, departAt: T0 + 1000, arriveAt: T0 + 1001, bookedAt: T0 + 1500,
      settles: move, fuel: 0, fuelDrawn: 0,
    };
    const settled = summary({ orbitSlot: 2, trim: trim({ planetId: ARIS, slot: 5, at: T0 + 2000 }), move: pin });
    // A newer trim of SOV — the very slot the record names, or another — is
    // no trim of the station's, and the one it flies stays.
    for (const slot of [2, 3]) {
      expect(mergeStation(settled, { ...settled, trim: trim({ slot, at: T0 + 2500 }) }, T0 + 3000)).toBeNull();
      const merged = mergeStation({ ...settled, trim: trim({ slot, at: T0 + 2500 }) }, settled, T0 + 3000);
      expect(merged?.trim).toMatchObject({ planetId: ARIS, slot: 5 });
    }
  });

  it("keeps a trim of the place a pin settled the station at, whichever install's record stands", () => {
    // Two installs saved HAB RING under their own ids. The one that stands
    // (the smaller id) still names SOV slot 2, but the arrival pin put the
    // station at ARIS slot 5, where the other install flies and trims it.
    const move: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: T0, arriveAt: T0 + 1000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const pin: StationMove = {
      ...move, fromPlanetId: ARIS, fromSlot: 5, departAt: T0 + 1000, arriveAt: T0 + 1001, bookedAt: T0 + 1500,
      settles: move, fuel: 0, fuelDrawn: 0,
    };
    const a = summary({ ownerId: 'a-hab', orbitSlot: 2, move: pin });
    const b = summary({ ownerId: 'b-hab', planetId: ARIS, orbitSlot: 5, move: pin, trim: trim({ planetId: ARIS, slot: 5, at: T0 + 2000 }) });
    for (const merged of [mergeStation(a, b, T0 + 3000), mergeStation(b, a, T0 + 3000)]) {
      expect(merged?.ownerId).toBe('a-hab');
      expect(merged?.trim).toMatchObject({ planetId: ARIS, slot: 5 });
    }
    // Not a trim of another slot there.
    expect(mergeStation(a, { ...b, trim: trim({ planetId: ARIS, slot: 6, at: T0 + 2000 }) }, T0 + 3000)?.trim).toBeUndefined();
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

  it("does not republish over another install's identical record, past its own id as an alias", () => {
    const known = summary({ ownerId: 'alpha', updatedAt: T0 });
    const aliased = foldOwnStation(known, record({ id: 'beta' }), null, T0 + 10);
    expect(aliased).toEqual({ ...known, ownerAliases: ['beta'] });
    expect(foldOwnStation(aliased!, record({ id: 'beta' }), null, T0 + 20)).toBeNull();
  });

  it('checks ship summaries', () => {
    const ship = { roomId: 'room-ship', name: 'FERRY', planetId: SOV, status: 'in-flight', fromRoom: 'a', toRoom: 'b', departedAt: T0, etaAt: T0 + 60_000, updatedAt: T0 };
    expect(cleanShipSummary(ship, T0)).toEqual(ship);
    expect(cleanShipSummary({ ...ship, status: 'warp' }, T0)).toBeNull();
    expect(cleanShipSummary({ ...ship, etaAt: Infinity }, T0)).toBeNull();
    expect(cleanShipSummary({ ...ship, seed: 'secret' }, T0)).not.toHaveProperty('seed');
  });

  it('keeps a route ferry\'s gate, next stop, departure and status; a bad one drops alone', () => {
    const ship = {
      roomId: 'room-ship', name: 'FERRY', planetId: SOV, status: 'docked', fromRoom: 'a',
      gate: 2, nextStopRoom: 'room-b', departAt: T0 + 60_000, routeStatus: 'boarding', routeRun: T0 - 60_000, routeNews: T0 - 30_000, updatedAt: T0,
    };
    expect(cleanShipSummary(ship, T0)).toEqual(ship);
    for (const [field, bad] of [['gate', 0], ['gate', 100], ['gate', 1.5], ['nextStopRoom', ''], ['nextStopRoom', 'r'.repeat(129)],
      ['departAt', Infinity], ['routeStatus', 'teleporting'], ['routeStatus', 3], ['routeRun', 0], ['routeRun', 1.5], ['routeRun', 'x'],
      ['routeNews', 0], ['routeNews', 1.5], ['routeNews', 'x'],
      // Far-future ordering stamps (past the 6 h skew every stamp gets).
      ['routeRun', T0 + 6 * 3600_000 + 1], ['routeNews', T0 + 6 * 3600_000 + 1]] as const) {
      const clean = cleanShipSummary({ ...ship, [field]: bad }, T0);
      expect(clean).not.toBeNull();
      expect(clean).not.toHaveProperty(field);
      expect(clean?.status).toBe('docked');
    }
    // A clock a little ahead is still a stamp.
    const ahead = { ...ship, routeRun: T0 + 60_000, routeNews: T0 + 6 * 3600_000 };
    expect(cleanShipSummary(ahead, T0)).toEqual(ahead);
  });

  it('🚚 keeps a ferry leg\'s copied ends only all four together, on one planet', () => {
    const ship = {
      roomId: 'room-ship', name: 'FERRY', planetId: SOV, status: 'in-flight', fromRoom: 'a', toRoom: 'b', departedAt: T0, etaAt: T0 + 60_000,
      fromPlanetId: SOV, fromSlot: 1, toPlanetId: SOV, toSlot: 3, updatedAt: T0,
    };
    expect(cleanShipSummary(ship, T0)).toEqual(ship);
    expect(cleanShipSummary({ ...ship, fromPlanetId: ARIS, toPlanetId: ARIS }, T0)).toMatchObject({ fromPlanetId: ARIS, toSlot: 3 });
    for (const [field, bad] of [['fromPlanetId', ''], ['fromPlanetId', 7], ['fromSlot', -1], ['fromSlot', 16], ['fromSlot', 1.5],
      ['toPlanetId', 'p'.repeat(129)], ['toSlot', '3'], ['toSlot', undefined],
      // A leg never crosses planets.
      ['toPlanetId', ARIS]] as const) {
      const clean = cleanShipSummary({ ...ship, [field]: bad }, T0);
      expect(clean).not.toBeNull();
      for (const f of ['fromPlanetId', 'fromSlot', 'toPlanetId', 'toSlot']) expect(clean).not.toHaveProperty(f);
      expect(clean).toMatchObject({ status: 'in-flight', fromRoom: 'a', toRoom: 'b', etaAt: T0 + 60_000 });
    }
  });

  it('🏁 keeps "no run flies" only as said, and never beside a route status', () => {
    const idle = { roomId: 'room-ship', name: 'FERRY', planetId: SOV, status: 'docked', fromRoom: 'a', routeIdle: true, updatedAt: T0 };
    expect(cleanShipSummary(idle, T0)).toEqual(idle);
    expect(cleanShipSummary({ ...idle, routeIdle: 'yes' }, T0)).not.toHaveProperty('routeIdle');
    expect(cleanShipSummary({ ...idle, routeStatus: 'boarding' }, T0)).not.toHaveProperty('routeIdle');
  });
});

/** HAB RING moved from Sovereign to Aris (its first record still says
 *  Sovereign) and its arrival was pinned there; then a tug booked to tow it
 *  was outbid by the yard's tow on the same tug. */
function outbidTow(now: number): { moved: StationMove; pin: StationMove; tow: StationMove; rival: StationMove } {
  const moved: StationMove = {
    stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
    departAt: now - 20_000, arriveAt: now - 10_000, mode: 'thrusters', fuel: 10, fuelDrawn: 10, bookedAt: now - 25_000,
  };
  const pin: StationMove = {
    ...moved, fromPlanetId: ARIS, fromSlot: 5, departAt: moved.arriveAt, arriveAt: moved.arriveAt + 1,
    fuel: 0, fuelDrawn: 0, bookedAt: now - 9000, settles: moved,
  };
  const tow: StationMove = {
    stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: ARIS, fromSlot: 5, toPlanetId: SOV, toSlot: 3,
    departAt: now + 1000, arriveAt: now + 86_400_000, mode: 'tug', tugRoomId: 'tug', fuel: 10, fuelDrawn: 10, bookedAt: now,
  };
  const rival: StationMove = {
    ...tow, stationId: 'yard', welcomeRoomId: 'room-yard', fromPlanetId: SOV, fromSlot: 4, toPlanetId: ARIS, toSlot: 6,
    departAt: now + 1001, arriveAt: now + 86_400_001,
  };
  return { moved, pin, tow, rival };
}

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

  it('keeps what a station follows instead of its latest move only beside that move', () => {
    const now = Date.now();
    const { pin, tow } = outbidTow(now);
    const withTow = summary({ move: tow });
    const beside = summary({ move: tow, stands: pin });
    // Published beside the very move it ranks below…
    expect(cleanStationSummary(beside, now)?.stands).toEqual(pin);
    // …and never alone, beside a move it ranks above, or as that move.
    expect(cleanStationSummary(summary({ stands: pin }), now)?.stands).toBeUndefined();
    expect(cleanStationSummary(summary({ move: pin, stands: tow }), now)?.stands).toBeUndefined();
    expect(cleanStationSummary(summary({ move: tow, stands: tow }), now)?.stands).toBeUndefined();
    // A reader places the station by it: long after the tow was due, at the
    // planet its arrival settled, not the one the tow was bound for.
    expect(summaryPlanet(beside, tow.arriveAt + 1)).toBe(ARIS);
    expect(summaryPlanet(withTow, tow.arriveAt + 1)).toBe(SOV);
    // Merged, it stays beside its move, whichever side brought it…
    expect(mergeStation(withTow, beside, now)?.stands).toEqual(pin);
    expect(mergeStation(beside, withTow, now)).toBeNull();
    // …and goes once a later move of the station comes without it.
    const later: StationMove = { ...tow, departAt: tow.departAt + 5000, arriveAt: tow.arriveAt + 5000 };
    const merged = mergeStation(beside, summary({ move: later }), now);
    expect(merged?.move).toEqual(later);
    expect(merged?.stands).toBeUndefined();
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

  it('a derived station that moved publishes the trim of the orbit its move put it in', () => {
    // First stamped around SOV slot 2; since moved to ARIS slot 5, where
    // this install lists it and its room trims that orbit.
    const move: StationMove = {
      stationId: 'station:room-hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: T0, arriveAt: T0 + 1000, bookedAt: T0, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const known = summary({ orbitSlot: 2, move });
    const derived = record({ id: 'station:room-hab', planetId: ARIS, orbitSlot: 5, derived: true });
    rememberMove(move);
    installStationMoveResolver();
    try {
      const next = foldOwnStation(known, derived, trim({ planetId: ARIS, slot: 5, at: T0 + 2000 }), T0 + 3000);
      expect(next?.trim).toMatchObject({ planetId: ARIS, slot: 5 });
      // The record that stands is still its first stamp.
      expect(next).toMatchObject({ planetId: SOV, orbitSlot: 2 });
      // A trim of the orbit it left goes nowhere.
      expect(foldOwnStation(known, derived, trim({ slot: 2, at: T0 + 2000 }), T0 + 3000)).toBeNull();
    } finally {
      setStationMoveResolver(null);
    }
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

  it('keeps a learned station between planets where it left from until it arrives, a prune there included', () => {
    const now = Date.now();
    const move: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: now - 1000, arriveAt: now + 86_400_000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const moving = summary({ move });
    setStationMoveResolver((st) => (st.welcomeRoomId === 'room-hab' ? move : null));
    try {
      expect(registerLearnedStations(SOV, [moving])).toBe(1);
      expect(registerLearnedStations(SOV, [moving], { prune: true })).toBe(0);
      expect(listStations().find((st) => st.welcomeRoomId === 'room-hab')?.planetId).toBe(SOV);
      // Around where it is bound, not yet.
      expect(registerLearnedStations(ARIS, [moving], { prune: true })).toBe(1);
      expect(readStationRecords()).toEqual([]);
    } finally {
      setStationMoveResolver(null);
    }
  });

  it('keep this client at the planet its list settled a bounced arrival at, before the pin is shared', () => {
    const now = Date.now();
    // Learned here, around this planet: the station this client is aboard,
    // and a neighbour.
    expect(registerLearnedStations(SOV, [summary(), summary({ welcomeRoomId: 'room-x', name: 'X', orbitSlot: 4 })])).toBe(2);
    const doc = new Y.Doc();
    const map = doc.getMap('stationSummaries');
    // ARIS is full…
    for (let i = 0; i < MAX_ORBIT_SLOTS; i++) {
      map.set(`room-a${i}`, summary({ welcomeRoomId: `room-a${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, updatedAt: now }));
    }
    // …when HAB RING gets there: it bounces home, and no pin is shared yet.
    const move: StationMove = {
      stationId: 'hab', welcomeRoomId: 'room-hab', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 5,
      departAt: now - 2000, arriveAt: now - 1000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    map.set('room-hab', summary({ updatedAt: now, move }));
    map.set('room-x', summary({ welcomeRoomId: 'room-x', name: 'X', orbitSlot: 4, updatedAt: now }));
    installKnownPlacesResolver();
    installStationMoveResolver();
    try {
      bindPlanetSummaryDoc(doc, install(`${LEARNED_PREFIX}room-hab`));
      expect(listStations().find((st) => st.welcomeRoomId === 'room-hab')).toMatchObject({ planetId: SOV, orbitSlot: 2 });
      // Still around this planet with its neighbour: nothing pruned here,
      // nothing registered around ARIS.
      expect(readStationRecords().map((r) => r.id).sort()).toEqual([`${LEARNED_PREFIX}room-hab`, `${LEARNED_PREFIX}room-x`]);
      expect(systemStationNames(SOV).some((st) => st.name === 'HAB RING')).toBe(false);
    } finally {
      setKnownPlacesResolver(null);
      setStationMoveResolver(null);
    }
  });

  it('register in a slot a move here is bound for, where their own install put them', () => {
    expect(registerStation(record({ id: 'mine', welcomeRoomId: 'room-mine', orbitSlot: 3 }))).toBe(true);
    const move: StationMove = {
      stationId: 'mine', welcomeRoomId: 'room-mine', fromPlanetId: SOV, fromSlot: 3, toPlanetId: ARIS, toSlot: 7,
      departAt: T0 + 1000, arriveAt: T0 + 2000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    setStationMoveResolver((st) => (st.welcomeRoomId === 'room-mine' ? move : null));
    try {
      // Saved here, a record for the booked slot is refused…
      expect(registerStation(record({ id: 'squat', welcomeRoomId: 'room-squat', planetId: ARIS, orbitSlot: 7 }))).toBe(false);
      // …but a learned one stands where its own install put it.
      expect(registerLearnedStations(ARIS, [summary({ planetId: ARIS, orbitSlot: 7 })])).toBe(1);
      expect(listStations().find((s) => s.welcomeRoomId === 'room-hab')).toMatchObject({ planetId: ARIS, orbitSlot: 7 });
    } finally {
      setStationMoveResolver(null);
      vi.useRealTimers();
    }
  });

  it('tell slot picks about the stations heard of around other planets, never listing them', () => {
    const move: StationMove = {
      stationId: 'c', welcomeRoomId: 'room-c', fromPlanetId: SOV, fromSlot: 9, toPlanetId: ARIS, toSlot: 2,
      departAt: T0 + 1000, arriveAt: T0 + 2000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    const storeOf = (...stations: StationSummary[]) =>
      JSON.stringify({ stations: Object.fromEntries(stations.map((st) => [st.welcomeRoomId, st])), ships: {} });
    store.set('ssf-planet-summary', storeOf(
      summary({ welcomeRoomId: 'room-a', planetId: ARIS, orbitSlot: 0 }),
      summary({ welcomeRoomId: 'room-b', planetId: ARIS, orbitSlot: 1 }),
      summary({ welcomeRoomId: 'room-c', planetId: SOV, orbitSlot: 9, move }),
    ));
    installKnownPlacesResolver();
    try {
      expect(knownSlotsAround(ARIS, [], T0)).toEqual({ taken: new Set([0, 1]), reserved: new Set([2]) });
      const listed = listStations(undefined, undefined, T0);
      expect(listed.some((st) => st.planetId === ARIS)).toBe(false);
      expect(freeSlotAround(ARIS, listed, undefined, T0)).toBe(3);
      // A change to the store is read at once.
      store.set('ssf-planet-summary', storeOf(summary({ welcomeRoomId: 'room-a', planetId: ARIS, orbitSlot: 0 })));
      expect(freeSlotAround(ARIS, listed, undefined, T0)).toBe(1);
    } finally {
      setKnownPlacesResolver(null);
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

  it('shares what a station follows beside its tow another outbid, so a fresh install still places it', () => {
    const now = Date.now();
    const { moved, pin, tow, rival } = outbidTow(now);
    // Install A, aboard the tug, knows both stations as first recorded and
    // every move: HAB RING's tow lost the tug to the yard's.
    const docA = new Y.Doc();
    docA.getMap('stationSummaries').set('room-hab', summary({ updatedAt: now }));
    docA.getMap('stationSummaries').set('room-yard', summary({ welcomeRoomId: 'room-yard', name: 'YARD', orbitSlot: 4, updatedAt: now }));
    bindPlanetSummaryDoc(docA, install(null));
    for (const m of [moved, pin, tow, rival]) expect(rememberMove(m, now)).toBe(true);
    publishPlanetSummary(now + 10);
    const hab = docA.getMap('stationSummaries').get('room-hab') as StationSummary;
    expect(hab.move).toMatchObject({ mode: 'tug', toPlanetId: SOV });
    expect(hab.stands).toMatchObject({ toPlanetId: ARIS, toSlot: 5, settles: { fromPlanetId: SOV } });
    // Install B has only the summaries, standing in a station around Aris.
    unbindPlanetSummaryForTest();
    store = new Map();
    registerStation(record({ id: 'b-home', name: 'B HOME', planetId: ARIS, orbitSlot: 1, welcomeRoomId: 'room-b' }));
    const docB = new Y.Doc();
    sync(docA, docB);
    installStationMoveResolver();
    const habAt = () => rememberedMoveFor({ id: `${LEARNED_PREFIX}room-hab`, welcomeRoomId: 'room-hab' });
    try {
      bindPlanetSummaryDoc(docB, install('b-home'));
      // It learns the yard's tow too, so HAB RING's never flies: the station
      // follows where its arrival settled, not its record at Sovereign.
      expect(habAt()).toMatchObject({ toPlanetId: ARIS, toSlot: 5 });
      expect(listStations().find((st) => st.welcomeRoomId === 'room-hab')).toMatchObject({ planetId: ARIS, orbitSlot: 5 });
      // The same summaries without it leave a fresh install nothing to follow.
      unbindPlanetSummaryForTest();
      store = new Map();
      const docC = new Y.Doc();
      const { stands: _unused, ...withoutStands } = hab;
      docC.getMap('stationSummaries').set('room-hab', withoutStands);
      docC.getMap('stationSummaries').set('room-yard', docA.getMap('stationSummaries').get('room-yard'));
      bindPlanetSummaryDoc(docC, install(null));
      expect(habAt()).toBeNull();
    } finally {
      setStationMoveResolver(null);
    }
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

  it("keeps a station that moved to this planet through a flood from the one it left", () => {
    registerStation(record());
    const doc = new Y.Doc();
    const now = Date.now();
    const map = doc.getMap('stationSummaries');
    // First stamped around ARIS, since moved here.
    const move: StationMove = {
      stationId: 'came', welcomeRoomId: 'room-came', fromPlanetId: ARIS, fromSlot: 3, toPlanetId: SOV, toSlot: 6,
      departAt: now - 2 * 3_600_000, arriveAt: now - 3_600_000, mode: 'thrusters', fuel: 10, fuelDrawn: 10,
    };
    map.set('room-came', summary({ welcomeRoomId: 'room-came', name: 'CAME', planetId: ARIS, orbitSlot: 3, updatedAt: now - 3 * 3_600_000, move }));
    for (let i = 0; i < 70; i++) {
      const id = `room-${String(i).padStart(3, '0')}`;
      map.set(id, summary({ welcomeRoomId: id, name: `S${i}`, planetId: ARIS, orbitSlot: 3, updatedAt: now + 60 * 60 * 1000 }));
    }
    bindPlanetSummaryDoc(doc, install('hab'));
    publishPlanetSummary(now);
    expect(readStore(now).stations['room-came']).toBeDefined();
    expect(map.has('room-came')).toBe(true);
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

  it('🚏 re-stamps an unchanged ferry summary once it is 15 minutes old, and only a ferry\'s', () => {
    const ferry: ShipStatusInput = { ...ship, gate: 2, nextStopRoom: 'room-b', routeStatus: 'holding' };
    let status: ShipStatusInput = ferry;
    const doc = new Y.Doc();
    const t0 = Date.now();
    bindPlanetSummaryDoc(doc, install(null, { ship: () => status }));
    const stamp = () => (doc.getMap('shipSummaries').get('room-ship') as { updatedAt: number }).updatedAt;
    const first = stamp();
    publishPlanetSummary(t0 + ROUTE_SUMMARY_REFRESH_MS - 60_000);
    expect(stamp()).toBe(first);
    publishPlanetSummary(first + ROUTE_SUMMARY_REFRESH_MS);
    expect(stamp()).toBe(first + ROUTE_SUMMARY_REFRESH_MS);
    // A ship on no route keeps its stamp until the hourly heartbeat.
    status = ship;
    publishPlanetSummary(first + ROUTE_SUMMARY_REFRESH_MS + 1);
    const plain = stamp();
    publishPlanetSummary(plain + 2 * ROUTE_SUMMARY_REFRESH_MS);
    expect(stamp()).toBe(plain);
    publishPlanetSummary(plain + SHIP_HEARTBEAT_MS);
    expect(stamp()).toBe(plain + SHIP_HEARTBEAT_MS);
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

  it('🚚 says a leg\'s copied ends only in flight, and reads them back under this install\'s ids', () => {
    const places: RouteFlightPlaces = {
      from: { id: 'st-x', planetId: SOV, orbitSlot: 1 },
      to: { id: 'st-y', planetId: 'planet-nowhere', orbitSlot: 3 },
    };
    // An unknown planet reads as the default one, as the station list reads it.
    expect(legEndFields(places)).toEqual({ fromPlanetId: SOV, fromSlot: 1, toPlanetId: SOV, toSlot: 3 });
    expect(legEndFields({ ...places, to: null })).toEqual({});
    expect(legEndFields(null)).toEqual({});
    const s = { fromRoom: 'room-a', toRoom: 'room-b', ...legEndFields(places) };
    expect(summaryLegEnds(s, (room) => (room === 'room-a' ? 'st-a' : undefined))).toEqual([
      { id: 'st-a', planetId: SOV, orbitSlot: 1 },
      { id: 'room-b', planetId: SOV, orbitSlot: 3 },
    ]);
    // An older client's relay drops the copies: the reader places the ends.
    expect(summaryLegEnds({ fromRoom: 'room-a', toRoom: 'room-b' })).toBeNull();
    expect(summaryLegEnds({ ...s, toRoom: undefined })).toBeNull();
  });

  it('🚚 an install that first hears of a leg after its next stop moved planets places it where the route copied the stop', () => {
    // The ferry's game: its route copied ALPHA (slot 1) and BRAVO (slot 3)
    // around SOVEREIGN, and its timetable flies the leg between them.
    const now = Date.now();
    const departedAt = now - 60_000;
    const places: RouteFlightPlaces = {
      from: { id: 'f-alpha', planetId: SOV, orbitSlot: 1 },
      to: { id: 'f-bravo', planetId: SOV, orbitSlot: 3 },
    };
    const leg: ShipStatusInput = {
      ...ship, status: 'in-flight', fromRoom: 'room-alpha', toRoom: 'room-bravo', departedAt, etaAt: now + 3600_000,
      ...legEndFields(places),
    };
    const docA = new Y.Doc();
    bindPlanetSummaryDoc(docA, install(null, { ship: () => leg }));
    // Another install, which lists BRAVO at ARIS PRIME now (its move arrived
    // before the leg left), hears of the leg for the first time.
    unbindPlanetSummaryForTest();
    store = new Map();
    registerStation(record({ id: 'o-alpha', name: 'ALPHA', orbitSlot: 1, welcomeRoomId: 'room-alpha' }));
    registerStation(record({ id: 'o-bravo', name: 'BRAVO', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'room-bravo' }));
    const docB = new Y.Doc();
    sync(docA, docB);
    bindPlanetSummaryDoc(docB, install('o-alpha'));
    const heard = readStore().ships['room-ship'];
    expect(heard).toMatchObject({ fromPlanetId: SOV, fromSlot: 1, toPlanetId: SOV, toSlot: 3 });
    const all = listStations();
    const listed = (room: string) => all.find((s) => s.welcomeRoomId === room)!;
    // Its station list gives the leg no course (its ends are on two planets)…
    expect(planTransfer(listed('room-alpha'), listed('room-bravo'), departedAt - 1)).toBeNull();
    // …but the copies the ferry published do, around SOVEREIGN.
    const ends = summaryLegEnds(heard, (room) => all.find((s) => s.welcomeRoomId === room)?.id)!;
    expect(ends).toEqual([
      { id: 'o-alpha', planetId: SOV, orbitSlot: 1 },
      { id: 'o-bravo', planetId: SOV, orbitSlot: 3 },
    ]);
    const plan = planTransfer(ends[0], ends[1], departedAt - 1);
    expect(plan?.from.planet.id).toBe(SOV);
    expect(plan?.to.radiusKm).toBe(orbitForSlot(SOV, 3).radiusKm);
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

  it('never lets a peer summary claim an open-orbit place as one of its ids', () => {
    // A peer publishes HAB RING with an adrift place as its owner id, or
    // among its aliases.
    const adrift = 'adrift:planet-aris:3';
    registerStation(record({ id: 'mine' }));
    setStationDirectory(directoryFromStationRecords(
      () => listStations(), () => undefined, () => null, () => null, (id) => resolveStationAlias(id),
    ));
    try {
      for (const claim of [summary({ ownerId: adrift }), summary({ ownerId: 'alpha', ownerAliases: [adrift] })]) {
        unbindPlanetSummaryForTest();
        const doc = new Y.Doc();
        doc.getMap('stationSummaries').set('room-hab', claim);
        bindPlanetSummaryDoc(doc, install(null));
        expect(resolveStationAlias(adrift)).toBe('mine');
        // A ship adrift there stays there: no summary moves it to a station.
        expect(localStationId(adrift)).toBe(adrift);
        bindShipDoc(new Y.Doc());
        expect(writeFlightRecord({ status: 'docked', locationId: adrift })).toBe(true);
        expect(readFlightRecord().locationId).toBe(adrift);
      }
    } finally {
      setStationDirectory(null);
    }
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
