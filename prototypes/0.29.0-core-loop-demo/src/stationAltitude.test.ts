/**
 * 🎚️ Altitude changes (issue 191) — the station helm's ALT window picks an
 * altitude around the station's planet and flies there on a Hohmann
 * transfer, written as a StationMove with mode 'orbit'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MIN_ALTITUDE_KM,
  MIN_ORBIT_SEPARATION_KM,
  ORBIT_EPOCH_MS,
  angleAt,
  baseOrbit,
  circularOrbit,
  maxAltitudeKm,
  orbitChangePointAt,
  orbitForSlot,
  planOrbitChange,
  planTransfer,
  slotPosition,
  stationOrbit,
  wrapAngle,
  setStationTrimResolver as setStationTrimResolverForTest,
} from './orbits';
import { stationBodies } from './map';
import { cleanStationSummary, mergeStation, summaryForStation, unbindPlanetSummaryForTest } from './planetSummary';
import type { StationSummary } from './planetSummary';
import { FUEL_PER_KMS } from './stationDirectory';
import { applyBurn, planTrim, trimFor } from './stationKeeping';
import type { OrbitTrim, TrimContext } from './stationKeeping';
import {
  altitudeConflict,
  bindStationMoveDoc,
  cleanMove,
  compareMoves,
  decidingClaimsOf,
  describeAltitudeRefusal,
  describeMove,
  dockLockedByMove,
  freeSlotAround,
  installStationMoveResolver,
  isAbortedAltitudeChange,
  isPinMove,
  isStationMove,
  moveTransitPointAt,
  orbitChangeTransitPointAt,
  orbitsToKeepClear,
  planStationAltitude,
  planStationMove,
  readMoveFuelDrawn,
  readRememberedMoves,
  readStationMove,
  rememberMove,
  MOVE_FINAL_MS,
  MOVE_LOG_KEEP_MS,
  stationAltitudeKm,
  stationPointWithMoveAt,
  writeStationMove,
} from './stationMove';
import type { MoveContext, StationMove } from './stationMove';
import { altitudeDigits, turnAltitudeDigit } from './stationHelm';
import { refreshDraftStops } from './helmRoute';
import type { RouteDraft } from './helmRoute';
import { routeStopFromWire } from './shipRoute';
import type { RouteStop } from './shipRoute';
import {
  DEFAULT_STATION_ID,
  DEFAULT_STATION_RECORD,
  isOrbitChange,
  listStations,
  planetById,
  setStationMoveResolver,
  stationInTransit,
  stationLeftPlanet,
} from './stations';
import type { StationRecord } from './stations';
import { adriftAt, adriftPlace, altitudeChangedSince, altitudeChangesSince, altitudeMoveKey, lostAltitudeClaims, onPlaceOrbit, setAltitudeHistory } from './stations';
import { castOffPlaces, shipPlaceId } from './shipArrival';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const SOV = 'planet-sovereign';
const NOW = ORBIT_EPOCH_MS + 5_000_000_000;
const SOV_R = planetById(SOV).radiusKm;

beforeEach(() => store.clear());
afterEach(() => { setStationMoveResolver(null); setAltitudeHistory(null); unbindPlanetSummaryForTest(); });

const OTHER: StationRecord = { id: 'other', name: 'OTHER', planetId: SOV, orbitSlot: 1, welcomeRoomId: 'other-room' };

const ctx = (over: Partial<MoveContext> = {}, records: StationRecord[] = []): MoveContext => {
  const stations = listStations({}, records, NOW);
  return {
    bolted: true,
    station: stations.find((s) => s.id === DEFAULT_STATION_ID)!,
    stations,
    commander: true,
    engines: 2,
    fuel: 10_000,
    drawn: 7,
    deficit: 0,
    modules: 3,
    now: NOW,
    ...over,
  };
};

const climbTo = (altitudeKm: number, over: Partial<MoveContext> = {}): StationMove => {
  const plan = planStationAltitude(ctx(over), altitudeKm);
  if (!plan.ok) throw new Error(plan.refusal);
  return plan.move;
};

/** Another station's altitude change from its slot's orbit, flown as the
 *  planner would plan it (the move guard checks the transfer). */
const climbOf = (id: string, room: string, slot: number, toAlt: number, bookedAt: number): StationMove => {
  const plan = planOrbitChange(orbitForSlot(SOV, slot), SOV_R + toAlt, bookedAt)!;
  return {
    stationId: id, welcomeRoomId: room, fromPlanetId: SOV, fromSlot: slot, toPlanetId: SOV, toSlot: slot,
    departAt: plan.departAt, arriveAt: plan.arriveAt, mode: 'orbit', bookedAt, fuel: 5, fuelDrawn: 5,
    orbit: { fromRadiusKm: plan.from.radiusKm, fromPhase0: plan.from.phase0, toRadiusKm: plan.to.radiusKm, toPhase0: plan.to.phase0 },
  };
};

describe('the transfer between two altitudes', () => {
  const from = orbitForSlot(SOV, 0);

  it('leaves at once and arrives opposite, on the new circle', () => {
    for (const r2 of [from.radiusKm + 600, from.radiusKm - 150]) {
      const plan = planOrbitChange(from, r2, NOW + 0.4)!;
      expect(plan.departAt).toBe(NOW + 1);
      expect(Number.isInteger(plan.arriveAt)).toBe(true);
      expect(plan.to.radiusKm).toBe(r2);
      // Continuous at both burns.
      const start = orbitChangePointAt(plan, plan.departAt);
      expect(start.radiusKm).toBeCloseTo(from.radiusKm, 6);
      expect(start.angle).toBeCloseTo(angleAt(from, plan.departAt), 9);
      const end = orbitChangePointAt(plan, plan.arriveAt - 1);
      expect(end.radiusKm).toBeCloseTo(r2, 0);
      const arrived = angleAt(plan.to, plan.arriveAt);
      expect(wrapAngle(arrived - angleAt(from, plan.departAt))).toBeCloseTo(Math.PI, 6);
      expect(Math.abs(wrapAngle(end.angle - arrived + Math.PI) - Math.PI)).toBeLessThan(1e-3);
      expect(plan.deltaVKmS).toBeGreaterThan(0);
      // Halfway, between the two radii.
      const mid = orbitChangePointAt(plan, (plan.departAt + plan.arriveAt) / 2);
      expect(mid.radiusKm).toBeGreaterThan(Math.min(from.radiusKm, r2));
      expect(mid.radiusKm).toBeLessThan(Math.max(from.radiusKm, r2));
    }
  });

  it('plans nothing for the same radius or a nonsense one', () => {
    expect(planOrbitChange(from, from.radiusKm, NOW)).toBeNull();
    expect(planOrbitChange(from, NaN, NOW)).toBeNull();
    expect(planOrbitChange(from, -5, NOW)).toBeNull();
  });
});

describe('a station flying an altitude orbit', () => {
  it('flies its own orbit in place of the slot\'s, and only one it can fly', () => {
    const orbit = { radiusKm: SOV_R + 900, phase0: 1.25 };
    const st = { ...DEFAULT_STATION_RECORD, orbit };
    expect(baseOrbit(st)).toMatchObject({ radiusKm: SOV_R + 900, phase0: 1.25, altitudeKm: 900 });
    expect(stationOrbit(st).radiusKm).toBe(SOV_R + 900);
    // Inside the atmosphere, or past the top slot: the slot's orbit.
    expect(baseOrbit({ ...st, orbit: { radiusKm: SOV_R + 50, phase0: 0 } }).radiusKm).toBe(orbitForSlot(SOV, 0).radiusKm);
    expect(baseOrbit({ ...st, orbit: { radiusKm: SOV_R + maxAltitudeKm(SOV) + 10, phase0: 0 } }).radiusKm)
      .toBe(orbitForSlot(SOV, 0).radiusKm);
    // Ships plan their transfers to it.
    const t = planTransfer({ ...OTHER, orbitSlot: 0, orbit: { radiusKm: SOV_R + 2_000, phase0: 0 } }, st, NOW)!;
    expect(t.to.radiusKm).toBe(SOV_R + 900);
  });

  it('places each altitude among the slots for schematic maps', () => {
    expect(slotPosition(SOV, orbitForSlot(SOV, 3).radiusKm)).toBeCloseTo(3, 9);
    const between = slotPosition(SOV, (orbitForSlot(SOV, 1).radiusKm + orbitForSlot(SOV, 2).radiusKm) / 2);
    expect(between).toBeGreaterThan(1);
    expect(between).toBeLessThan(2);
  });
});

describe('planning an altitude change', () => {
  it('writes a move that stays in its planet and slot and carries both orbits', () => {
    const plan = planStationAltitude(ctx(), 1_000);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const from = stationOrbit(ctx().station!);
    expect(plan.move).toMatchObject({
      stationId: DEFAULT_STATION_ID,
      fromPlanetId: SOV,
      toPlanetId: SOV,
      fromSlot: 0,
      toSlot: 0,
      mode: 'orbit',
      departAt: NOW,
      bookedAt: NOW,
      orbit: { fromRadiusKm: from.radiusKm, fromPhase0: from.phase0, toRadiusKm: SOV_R + 1_000 },
    });
    expect(plan.move.fuel).toBe(Math.ceil(plan.quote.plan.deltaVKmS * FUEL_PER_KMS * 3));
    expect(plan.move.fuelDrawn).toBe(7 + plan.move.fuel);
    expect(isStationMove(plan.move)).toBe(true);
    expect(isPinMove(plan.move)).toBe(false);
    expect(isOrbitChange(plan.move)).toBe(true);
    expect(cleanMove(plan.move)).toEqual(plan.move);
  });

  it('refuses in the helm\'s order', () => {
    expect(planStationAltitude(ctx({ bolted: false }), 1_000)).toMatchObject({ ok: false, refusal: 'not-bolted' });
    expect(planStationAltitude(ctx({ station: null }), 1_000)).toMatchObject({ ok: false, refusal: 'no-station' });
    expect(planStationAltitude(ctx({ commander: false }), 1_000)).toMatchObject({ ok: false, refusal: 'not-commander' });
    expect(planStationAltitude(ctx(), MIN_ALTITUDE_KM - 1)).toMatchObject({ ok: false, refusal: 'too-low' });
    expect(planStationAltitude(ctx(), maxAltitudeKm(SOV) + 1)).toMatchObject({ ok: false, refusal: 'too-high' });
    expect(planStationAltitude(ctx(), 400)).toMatchObject({ ok: false, refusal: 'same-altitude' });
    expect(planStationAltitude(ctx({ modules: 0 }), 1_000)).toMatchObject({ ok: false, refusal: 'unknown-layout', quote: null });
    expect(planStationAltitude(ctx({ engines: 0 }), 1_000)).toMatchObject({ ok: false, refusal: 'no-thrusters' });
    const broke = planStationAltitude(ctx({ fuel: 1 }), 1_000);
    expect(broke).toMatchObject({ ok: false, refusal: 'no-fuel' });
    if (!broke.ok) expect(broke.quote?.fuel).toBeGreaterThan(1);
    // A move already under way holds it.
    const climbing = climbTo(1_000);
    const station = { ...ctx().station!, move: climbing };
    expect(planStationAltitude(ctx({ station }), 1_200)).toMatchObject({ ok: false, refusal: 'moving' });
    expect(planStationMove(ctx({ station }), 'planet-aris')).toMatchObject({ ok: false, refusal: 'moving' });
  });

  it('keeps clear of every other station\'s orbit, and of the open slots\' orbits', () => {
    const otherAlt = orbitForSlot(SOV, 1).altitudeKm;
    const near = planStationAltitude(ctx({}, [OTHER]), Math.round(otherAlt) + MIN_ORBIT_SEPARATION_KM - 5);
    expect(near).toMatchObject({ ok: false, refusal: 'too-close', near: { name: 'OTHER' } });
    if (!near.ok) {
      expect(describeAltitudeRefusal(near.refusal, near.quote, 0, ctx().station, near.near ?? null)).toMatch(/OTHER's orbit/);
    }
    expect(planStationAltitude(ctx({}, [OTHER]), Math.round(otherAlt) + MIN_ORBIT_SEPARATION_KM + 5).ok).toBe(true);
    // Slot 2 is open: its orbit is kept for the next station to come.
    const openAlt = Math.round(orbitForSlot(SOV, 2).altitudeKm);
    const lane = planStationAltitude(ctx({}, [OTHER]), openAlt + 10);
    expect(lane).toMatchObject({ ok: false, refusal: 'too-close' });
    if (!lane.ok) expect(lane.near?.name).toBeUndefined();
    // The station's own slot is its own to come back to.
    const climbed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0 } };
    expect(altitudeConflict(orbitForSlot(SOV, 0).radiusKm, orbitsToKeepClear(climbed, ctx().stations, NOW))).toBeNull();
  });

  it('keeps clear of where another station\'s altitude change is taking it', () => {
    const otherClimb: StationMove = {
      stationId: 'other', welcomeRoomId: 'other-room', fromPlanetId: SOV, fromSlot: 1, toPlanetId: SOV, toSlot: 1,
      departAt: NOW - 1_000, arriveAt: NOW + 60_000, mode: 'orbit', bookedAt: NOW - 1_000, fuel: 5, fuelDrawn: 5,
      orbit: { fromRadiusKm: orbitForSlot(SOV, 1).radiusKm, fromPhase0: 0, toRadiusKm: SOV_R + 1_500, toPhase0: 0 },
    };
    setStationMoveResolver((st) => (st.id === 'other' ? otherClimb : null));
    expect(planStationAltitude(ctx({}, [OTHER]), 1_520)).toMatchObject({ ok: false, refusal: 'too-close', near: { name: 'OTHER' } });
  });
});

describe('the record and the station list', () => {
  it('refuses a malformed altitude change', () => {
    const move = climbTo(1_000);
    expect(isStationMove({ ...move, toSlot: 1 })).toBe(false);
    expect(isStationMove({ ...move, toPlanetId: 'planet-aris' })).toBe(false);
    expect(isStationMove({ ...move, orbit: undefined })).toBe(false);
    expect(isStationMove({ ...move, orbit: { ...move.orbit!, toRadiusKm: Infinity } })).toBe(false);
    expect(isStationMove({ ...move, tugRoomId: 'tug' })).toBe(false);
    expect(isStationMove({ ...move, mode: 'thrusters' })).toBe(false);
  });

  it('lists the station in its slot the whole way, on its new orbit once there', () => {
    const move = climbTo(1_000);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    const mid = Math.round((move.departAt + move.arriveAt) / 2);
    const during = listStations({}, [OTHER], mid).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(during).toMatchObject({ planetId: SOV, orbitSlot: 0, move });
    expect(during.orbit).toEqual({ radiusKm: move.orbit!.fromRadiusKm, phase0: move.orbit!.fromPhase0 });
    expect(stationInTransit(during, mid)).toBe(true);
    expect(stationLeftPlanet(during, mid)).toBe(false);
    // Its slot stays its own: nobody is offered it.
    expect(freeSlotAround(SOV, listStations({}, [OTHER], mid), 'nobody', mid)).toBe(2);
    // On the transfer, not between planets.
    expect(moveTransitPointAt(move, mid)).toBeNull();
    const p = orbitChangeTransitPointAt(move, mid)!;
    expect(p.radiusKm).toBeGreaterThan(move.orbit!.fromRadiusKm);
    expect(stationPointWithMoveAt(during, mid)).toEqual(p);
    // No ship docks with it, leaves it or reaches it until it arrives.
    expect(dockLockedByMove([DEFAULT_STATION_RECORD.welcomeRoomId], mid)).toBe(true);
    expect(describeMove(move, mid)).toMatch(/^Changing orbit to 1,000 km: arriving in/);

    const after = listStations({}, [OTHER], move.arriveAt + 5).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(after).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    expect(after.move).toBeUndefined();
    expect(after.orbit).toEqual({ radiusKm: SOV_R + 1_000, phase0: move.orbit!.toPhase0 });
    expect(stationAltitudeKm(after)).toBeCloseTo(1_000, 6);
    expect(dockLockedByMove([DEFAULT_STATION_RECORD.welcomeRoomId], move.arriveAt + 5)).toBe(false);
    // Where the transfer ends, the new orbit carries on.
    expect(stationPointWithMoveAt(after, move.arriveAt).angle).toBeCloseTo(
      orbitChangeTransitPointAt(move, move.arriveAt - 1)!.angle, 2);
    expect(describeMove(move, move.arriveAt)).toBe('Orbiting at 1,000 km.');
    // The holotable draws it between the slot rings it sits between.
    const body = stationBodies([after], move.arriveAt + 5)[0];
    expect(body.orbitRadius).toBeGreaterThan(stationBodies([DEFAULT_STATION_RECORD])[0].orbitRadius);
  });

  it('goes through the room doc and the remembered list like any move', () => {
    bindStationMoveDoc(new Y.Doc());
    installStationMoveResolver();
    const move = climbTo(1_000);
    expect(writeStationMove(move)).toBe(true);
    expect(readStationMove()).toEqual(move);
    bindStationMoveDoc(new Y.Doc());
    expect(listStations({}, [], move.arriveAt + 1).find((s) => s.id === DEFAULT_STATION_ID)?.orbit?.radiusKm)
      .toBe(SOV_R + 1_000);
  });

  it('rides the planet summary to other installs', () => {
    const move = climbTo(1_000);
    const station = { ...ctx().station!, move };
    const summary = cleanStationSummary(summaryForStation(station, null, NOW), NOW)!;
    expect(summary.move).toEqual(move);
    // The orbit the list derives from it is never published as an extra.
    const listed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0 } };
    expect(summaryForStation(listed, null, NOW).ext).toBeUndefined();
  });
});

describe('station keeping on an altitude orbit', () => {
  const orbit = { radiusKm: SOV_R + 1_000, phase0: 0.5 };
  const climbed: StationRecord = { ...DEFAULT_STATION_RECORD, orbit };
  const keep = (station: StationRecord, trim: OrbitTrim | null = null): TrimContext => ({
    bolted: true, station, trim, commander: true, engines: 1, fuel: 50, now: NOW,
  });

  it('trims the altitude orbit, and starts over after a change', () => {
    const plan = planTrim(keep(climbed), 'raise');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.burn.base).toEqual(orbit);
    expect(plan.trim).toMatchObject({ base: orbit, dRadiusKm: 2 });
    expect(trimFor(climbed, plan.trim)).toBe(plan.trim);
    // The slot's trim no longer applies up here, nor this one back there.
    const slotTrim = planTrim(keep(DEFAULT_STATION_RECORD), 'raise');
    if (!slotTrim.ok) throw new Error(slotTrim.refusal);
    expect(slotTrim.burn.base).toBeUndefined();
    expect(trimFor(climbed, slotTrim.trim)).toBeNull();
    expect(trimFor(DEFAULT_STATION_RECORD, plan.trim)).toBeNull();
    // A burn on the new orbit does not carry the old one's trim over.
    const next = applyBurn(slotTrim.trim, { ...plan.burn, at: NOW + 10_000 })!;
    expect(next.dRadiusKm).toBe(2);
  });

  it('reads the base from a record that carries its latest move instead (a planet summary)', () => {
    const move = climbTo(1_000);
    const plan = planTrim(keep({ ...DEFAULT_STATION_RECORD, orbit: { radiusKm: move.orbit!.toRadiusKm, phase0: move.orbit!.toPhase0 } }), 'lower');
    if (!plan.ok) throw new Error(plan.refusal);
    const summaryLike = { ...DEFAULT_STATION_RECORD, move };
    expect(trimFor(summaryLike, plan.trim)).toBe(plan.trim);
  });

  it('flies the trimmed altitude orbit', () => {
    const circle = circularOrbit(planetById(SOV), orbit.radiusKm, orbit.phase0);
    expect(baseOrbit(climbed)).toMatchObject({ radiusKm: circle.radiusKm, phase0: circle.phase0 });
  });
});

describe('the ALT window', () => {
  it('turns one thumbwheel, carrying into the digits above, within 0 to 999,999', () => {
    expect(turnAltitudeDigit(400, 2, 1)).toBe(500);
    expect(turnAltitudeDigit(950, 2, 1)).toBe(1_050);
    expect(turnAltitudeDigit(400, 0, -3)).toBe(397);
    expect(turnAltitudeDigit(50, 3, -1)).toBe(0);
    expect(turnAltitudeDigit(999_000, 4, 2)).toBe(999_999);
    expect(turnAltitudeDigit(400, 9, 1)).toBe(100_400); // the top wheel at most
  });

  it('shows six digits with the leading zeros unlit', () => {
    expect(altitudeDigits(1_250)).toEqual({ digits: [0, 0, 1, 2, 5, 0], leading: 2 });
    expect(altitudeDigits(0)).toEqual({ digits: [0, 0, 0, 0, 0, 0], leading: 5 });
  });
});

describe('ferry routes to a station on an altitude orbit', () => {
  const stop: RouteStop = {
    stationId: DEFAULT_STATION_ID, name: 'FURLONG', planetId: SOV, orbitSlot: 0,
    berth: { roomId: 'r', farDoor: 'x+', anyGate: true }, waitSecs: 60,
  };

  it('copies the orbit with the stop on save, and drops it once the station is back on its slot', () => {
    const draft: RouteDraft = { stops: [stop], shape: 'backAndForth', shipPort: 'S', robotDockId: null, homeRefuel: true };
    const orbit = { radiusKm: SOV_R + 1_000, phase0: 0.25 };
    const listed = [{ ...DEFAULT_STATION_RECORD, orbit }];
    const saved = refreshDraftStops(draft, listed, (id) => id, NOW);
    expect(saved.stops[0].orbit).toEqual(orbit);
    expect(refreshDraftStops(saved, [DEFAULT_STATION_RECORD], (id) => id, NOW).stops[0].orbit).toBeUndefined();
  });

  it('keeps it on the wire, and refuses a malformed one', () => {
    const orbit = { radiusKm: SOV_R + 1_000, phase0: 0.25 };
    expect(routeStopFromWire({ ...stop, orbit })).toEqual({ ...stop, orbit });
    expect(routeStopFromWire(stop)).toEqual(stop);
    expect(routeStopFromWire({ ...stop, orbit: { radiusKm: 'far', phase0: 0 } })).toBeNull();
  });
});

describe('Copilot round 1', () => {

  it('keeps every other slot\'s own orbit clear, held or not', () => {
    // OTHER holds slot 1 but flies 1,500 km: slot 1's own orbit stays kept.
    const other = { ...OTHER, orbit: { radiusKm: SOV_R + 1_500, phase0: 0 } };
    const slot1 = Math.round(orbitForSlot(SOV, 1).altitudeKm);
    const st = listStations({}, [], NOW)[0];
    expect(altitudeConflict(SOV_R + slot1 + 10, orbitsToKeepClear(st, [st, other], NOW))?.name).toBeUndefined();
    expect(altitudeConflict(SOV_R + slot1 + 10, orbitsToKeepClear(st, [st, other], NOW))).not.toBeNull();
  });

  it('measures the separation from base orbits, not trimmed ones', () => {
    const base = { radiusKm: SOV_R + 1_000, phase0: 0 };
    const other = { ...OTHER, orbit: base };
    setStationTrimResolverForTest((s, slot) => (s.id === 'other' ? { radiusKm: slot.radiusKm + 20, phase0: slot.phase0 } : null));
    try {
      const st = listStations({}, [], NOW)[0];
      // 970 km is 50 km from the trimmed 1,020 km, but only 30 from the base.
      expect(altitudeConflict(SOV_R + 970, orbitsToKeepClear(st, [st, other], NOW))?.name).toBe('OTHER');
    } finally {
      setStationTrimResolverForTest(null);
    }
  });

  it('aborts the later of two concurrent altitude changes that end too close', () => {
    const mine = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW);
    const theirs = climbOf('other', 'other-room', 1, 1_020, NOW + 5);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? mine : st.id === 'other' ? theirs : null));
    const after = listStations({}, [OTHER], NOW + 120_000);
    expect(after.find((s) => s.id === DEFAULT_STATION_ID)?.orbit?.radiusKm).toBe(SOV_R + 1_000);
    expect(after.find((s) => s.id === 'other')?.orbit?.radiusKm).toBe(orbitForSlot(SOV, 1).radiusKm);
    const during = listStations({}, [OTHER], NOW + 30_000).find((s) => s.id === 'other')!;
    expect(during.move).toBeUndefined();
    // Booked offline after the first had already arrived: still the later
    // booking, still aborted.
    const later = climbOf('other', 'other-room', 1, 1_020, NOW + 60_001);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? mine : st.id === 'other' ? later : null));
    expect(listStations({}, [OTHER], NOW + 200_000).find((s) => s.id === 'other')?.orbit?.radiusKm)
      .toBe(orbitForSlot(SOV, 1).radiusKm);
    // Far enough apart: both fly.
    const apart = climbOf('other', 'other-room', 1, 1_100, NOW + 5);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? mine : st.id === 'other' ? apart : null));
    expect(listStations({}, [OTHER], NOW + 200_000).find((s) => s.id === 'other')?.orbit?.radiusKm).toBe(SOV_R + 1_100);
  });

  it('an aborted altitude change neither locks docks nor draws fuel', () => {
    bindStationMoveDoc(new Y.Doc());
    installStationMoveResolver();
    const theirs = climbOf('other', 'other-room', 1, 1_020, NOW);
    const mine = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW + 5);
    expect(writeStationMove(mine)).toBe(true);
    const drawnAlone = readMoveFuelDrawn();
    expect(drawnAlone).toBe(5);
    expect(dockLockedByMove([DEFAULT_STATION_RECORD.welcomeRoomId], NOW + 30_000)).toBe(true);
    // This install learns the other station booked that orbit first.
    expect(rememberMove(theirs, NOW + 10)).toBe(true);
    expect(isAbortedAltitudeChange(mine)).toBe(true);
    expect(readMoveFuelDrawn()).toBe(0);
    expect(dockLockedByMove([DEFAULT_STATION_RECORD.welcomeRoomId], NOW + 30_000)).toBe(false);
    // Back on the orbit it left: here its slot's own (no orbit of its own).
    const me = listStations({}, [OTHER], NOW + 120_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(me.move).toBeUndefined();
    expect(me.orbit?.radiusKm ?? orbitForSlot(SOV, 0).radiusKm).toBe(orbitForSlot(SOV, 0).radiusKm);
  });

  it('keeps the altitude flown until a later move leaves, and for good when it is cancelled', () => {
    const climbed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0.5 } };
    const plan = planStationMove(ctx({ station: climbed }), 'planet-aris');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.move.fromOrbit).toEqual({ ...climbed.orbit, since: ORBIT_EPOCH_MS });
    expect(isStationMove(plan.move)).toBe(true);
    expect(cleanMove(plan.move)).toEqual(plan.move);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? plan.move : null));
    const waiting = listStations({}, [], plan.move.departAt - 1).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(waiting.orbit).toEqual(climbed.orbit);
    const cancel: StationMove = {
      ...plan.move, fromOrbit: undefined, toPlanetId: SOV, toSlot: 0, departAt: plan.move.departAt + 1,
      arriveAt: plan.move.departAt + 2, settles: plan.move, fuel: 0, fuelDrawn: 0,
    };
    delete cancel.fromOrbit;
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? cancel : null));
    expect(listStations({}, [], plan.move.arriveAt + 10).find((s) => s.id === DEFAULT_STATION_ID)?.orbit).toEqual(climbed.orbit);
  });
});

describe('Copilot round 3', () => {
  const orbitOf = (list: StationRecord[], id: string) => list.find((s) => s.id === id)?.orbit?.radiusKm;
  const THIRD: StationRecord = { id: 'third', name: 'THIRD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'third-room' };

  it('refuses altitude changes outside the planet\'s band or onto another slot\'s orbit', () => {
    const ok = climbOf('other', 'other-room', 1, 1_000, NOW);
    expect(isStationMove(ok)).toBe(true);
    const withOrbit = (o: Partial<NonNullable<StationMove['orbit']>>) => ({ ...ok, orbit: { ...ok.orbit!, ...o } });
    expect(isStationMove(withOrbit({ toRadiusKm: SOV_R + 150 }))).toBe(false);
    expect(isStationMove(withOrbit({ toRadiusKm: SOV_R + maxAltitudeKm(SOV) + 10 }))).toBe(false);
    expect(isStationMove(withOrbit({ fromRadiusKm: 10 }))).toBe(false);
    // Slot 0's own orbit (400 km) belongs to slot 0, not this slot-1 station.
    expect(isStationMove(withOrbit({ toRadiusKm: orbitForSlot(SOV, 0).radiusKm + 20 }))).toBe(false);
    // A trimmed start is fine, flown as the transfer it makes.
    const trimmed = planOrbitChange(circularOrbit(planetById(SOV), orbitForSlot(SOV, 1).radiusKm + 15, 0.3), SOV_R + 1_000, NOW)!;
    expect(isStationMove({
      ...ok, departAt: trimmed.departAt, arriveAt: trimmed.arriveAt,
      orbit: { fromRadiusKm: trimmed.from.radiusKm, fromPhase0: trimmed.from.phase0, toRadiusKm: SOV_R + 1_000, toPhase0: trimmed.to.phase0 },
    })).toBe(true);
    // Its times and new orbit must be that transfer's.
    expect(isStationMove({ ...ok, arriveAt: ok.departAt + 1 })).toBe(false);
    expect(isStationMove(withOrbit({ toPhase0: ok.orbit!.toPhase0 + 0.5 }))).toBe(false);
    const thrust: StationMove = {
      ...ok, mode: 'thrusters', toPlanetId: 'planet-aris', orbit: undefined, fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0, since: NOW },
    };
    delete thrust.orbit;
    expect(isStationMove(thrust)).toBe(true);
    expect(cleanMove(thrust).fromOrbit).toEqual({ radiusKm: SOV_R + 1_000, phase0: 0, since: NOW });
    expect(isStationMove({ ...thrust, fromOrbit: { radiusKm: SOV_R + 50, phase0: 0 } })).toBe(false);
  });

  it('only an accepted claim defeats a later one', () => {
    const a = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW);
    const b = climbOf('other', 'other-room', 1, 1_040, NOW + 5);
    const c = climbOf('third', 'third-room', 2, 1_080, NOW + 10);
    const moves: Record<string, StationMove> = { [DEFAULT_STATION_ID]: a, other: b, third: c };
    setStationMoveResolver((st) => moves[st.id] ?? null);
    const after = listStations({}, [OTHER, THIRD], NOW + 200_000);
    expect(orbitOf(after, DEFAULT_STATION_ID)).toBe(SOV_R + 1_000);
    expect(orbitOf(after, 'other')).toBe(orbitForSlot(SOV, 1).radiusKm);
    expect(orbitOf(after, 'third')).toBe(SOV_R + 1_080);
  });

  it('weighs an altitude kept by a later move, and keeps its claim time', () => {
    // OTHER climbed to 1,000 km, then booked a move to Aris that keeps it there
    // until it leaves; this station, offline, books 1,020 km after the climb.
    const leave: StationMove = {
      stationId: 'other', welcomeRoomId: 'other-room', fromPlanetId: SOV, fromSlot: 1, toPlanetId: 'planet-aris', toSlot: 0,
      departAt: NOW + 5_000_000, arriveAt: NOW + 9_000_000, mode: 'thrusters', bookedAt: NOW + 100_000, fuel: 5, fuelDrawn: 10,
      fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0, since: NOW },
    };
    const mine = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_020, NOW + 50_000);
    setStationMoveResolver((st) => (st.id === 'other' ? leave : st.id === DEFAULT_STATION_ID ? mine : null));
    const during = listStations({}, [OTHER], NOW + 200_000);
    expect(orbitOf(during, DEFAULT_STATION_ID)).toBe(orbitForSlot(SOV, 0).radiusKm);
    expect(orbitOf(during, 'other')).toBe(SOV_R + 1_000);
    // A kept altitude claimed after the change it clashes with gives way.
    const late = { ...leave, fromOrbit: { ...leave.fromOrbit!, since: NOW + 60_000 } };
    setStationMoveResolver((st) => (st.id === 'other' ? late : st.id === DEFAULT_STATION_ID ? mine : null));
    const swapped = listStations({}, [OTHER], NOW + 200_000);
    expect(orbitOf(swapped, DEFAULT_STATION_ID)).toBe(SOV_R + 1_020);
    expect(orbitOf(swapped, 'other')).toBeUndefined();
    // The planner stamps when the kept altitude was claimed.
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW) : null));
    const climbed = listStations({}, [], NOW + 200_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    const plan = planStationMove(ctx({ station: climbed, now: NOW + 200_000 }), 'planet-aris');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.move.fromOrbit).toEqual({ radiusKm: SOV_R + 1_000, phase0: climbed.orbit!.phase0, since: NOW });
  });

  it('draws the altitude kept until departure on the holotable', () => {
    const leave: StationMove = {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: NOW + 5_000_000, arriveAt: NOW + 9_000_000, mode: 'thrusters',
      bookedAt: NOW, fuel: 5, fuelDrawn: 5, fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0 },
    };
    const station = { ...DEFAULT_STATION_RECORD, move: leave, orbit: { radiusKm: SOV_R + 1_000, phase0: 0 } };
    const body = stationBodies([station], NOW)[0];
    const slot0 = stationBodies([DEFAULT_STATION_RECORD], NOW)[0].orbitRadius;
    expect(body.placeAt!(NOW).radius).toBeGreaterThan(slot0);
    // A kept altitude the list dropped (another station claimed it first)
    // is drawn at the slot, as listed.
    const dropped = stationBodies([{ ...DEFAULT_STATION_RECORD, move: leave }], NOW)[0];
    expect(dropped.placeAt!(NOW).radius).toBeCloseTo(slot0, 6);
  });

  it('tells an arriving ship its station changed altitude, even when a later move hides it', () => {
    const climb = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW);
    const leave: StationMove = {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: NOW + 5_000_000, arriveAt: NOW + 9_000_000, mode: 'thrusters',
      bookedAt: NOW + 100_000, fuel: 5, fuelDrawn: 10, fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0, since: NOW },
    };
    const station = { id: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? leave : null));
    setAltitudeHistory(() => [climb]);
    try {
      // Cast off before the climb: refused. After it had arrived: fine.
      expect(altitudeChangedSince(station, NOW - 1_000, NOW + 200_000)).toBe(true);
      expect(altitudeChangedSince(station, NOW + 70_000, NOW + 200_000)).toBe(false);
      // A late install that knows only the later move still sees the climb
      // by when the orbit that move leaves was claimed.
      setAltitudeHistory(() => []);
      expect(altitudeChangedSince(station, NOW - 1_000, NOW + 200_000)).toBe(true);
      expect(altitudeChangedSince(station, NOW + 70_000, NOW + 200_000)).toBe(false);
      // A climb another station's earlier claim aborted never happened.
      const theirs = climbOf('other', 'other-room', 1, 1_020, NOW - 10);
      setAltitudeHistory(() => [climb, theirs]);
      expect(altitudeChangedSince(station, NOW - 1_000, NOW + 200_000)).toBe(false);
    } finally {
      setAltitudeHistory(null);
    }
  });
});

describe('Copilot round 5', () => {

  it('refuses a pin of an altitude change', () => {
    const climb = climbOf('other', 'other-room', 1, 1_000, NOW);
    expect(isStationMove({ ...climb, departAt: NOW + 70_000, arriveAt: NOW + 70_001, settles: climb })).toBe(false);
  });

  it('a concurrent altitude change its own station passed over claims no orbit', () => {
    bindStationMoveDoc(new Y.Doc());
    installStationMoveResolver();
    const now = Date.now();
    const x1 = climbOf('other', 'other-room', 1, 1_000, now);
    const x2 = climbOf('other', 'other-room', 1, 1_500, now + 10);
    // Booked within moments (two tabs): one order picks the one that flies.
    const [winner, loser] = compareMoves(x1, x2) > 0 ? [x1, x2] : [x2, x1];
    // Both in the other station's room log, as two tabs would write them.
    expect(writeStationMove(x1)).toBe(true);
    expect(writeStationMove(x2)).toBe(true);
    const nearLoser = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0,
      loser.orbit!.toRadiusKm - SOV_R + 20, now + 5);
    const nearWinner = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0,
      winner.orbit!.toRadiusKm - SOV_R + 20, now + 15);
    expect(isAbortedAltitudeChange(nearLoser)).toBe(false);
    expect(isAbortedAltitudeChange(nearWinner)).toBe(true);
  });

  it('the distant view keeps a flight\'s old orbit when a later move hides the climb', () => {
    const climb = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW);
    const leave: StationMove = {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: NOW + 5_000_000, arriveAt: NOW + 9_000_000, mode: 'thrusters',
      bookedAt: NOW + 100_000, fuel: 5, fuelDrawn: 10, fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0, since: NOW },
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? leave : null));
    setAltitudeHistory(() => [climb]);
    try {
      const first = altitudeChangesSince({ id: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId },
        NOW - 1_000, NOW + 200_000)[0];
      expect(first?.orbit?.fromRadiusKm).toBe(orbitForSlot(SOV, 0).radiusKm);
    } finally {
      setAltitudeHistory(null);
    }
  });

  it('a lost altitude change leaves the orbit before it held', () => {
    // A holds 1,000 km, B 2,000 km; A asks for 2,020 km and loses to B; then
    // C asks for 1,020 km: A is still at 1,000 km, so C loses.
    const aHold = climbOf('a', 'a-room', 0, 1_000, NOW);
    const bHold = climbOf('b', 'b-room', 1, 2_000, NOW + 10);
    const aTry = { ...climbOf('a', 'a-room', 0, 2_020, NOW + 200_000), orbit: undefined } as StationMove;
    const aPlan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_000, aHold.orbit!.toPhase0), SOV_R + 2_020, NOW + 200_000)!;
    const aFails: StationMove = {
      ...aTry, departAt: aPlan.departAt, arriveAt: aPlan.arriveAt,
      orbit: { fromRadiusKm: aPlan.from.radiusKm, fromPhase0: aPlan.from.phase0, toRadiusKm: aPlan.to.radiusKm, toPhase0: aPlan.to.phase0 },
    };
    const cTry = climbOf('c', 'c-room', 2, 1_020, NOW + 400_000);
    const lost = lostAltitudeClaims([aHold, bHold, aFails, cTry]);
    expect(lost.has(altitudeMoveKey(aFails))).toBe(true);
    expect(lost.has(altitudeMoveKey(cTry))).toBe(true);
    expect(lost.has(altitudeMoveKey(aHold))).toBe(false);
  });

  it('a lost altitude change still holds the orbit it leaves, for an install that never saw the climb there', () => {
    const bHold = climbOf('b', 'b-room', 1, 2_000, NOW + 10);
    const aPlan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_000, 0.4), SOV_R + 2_020, NOW + 200_000)!;
    const aFails: StationMove = {
      stationId: 'a', welcomeRoomId: 'a-room', fromPlanetId: SOV, fromSlot: 0, toPlanetId: SOV, toSlot: 0,
      departAt: aPlan.departAt, arriveAt: aPlan.arriveAt, mode: 'orbit', bookedAt: NOW + 200_000, fuel: 5, fuelDrawn: 5,
      orbit: {
        fromRadiusKm: aPlan.from.radiusKm, fromPhase0: aPlan.from.phase0, toRadiusKm: aPlan.to.radiusKm,
        toPhase0: aPlan.to.phase0, fromSince: NOW,
      },
    };
    expect(isStationMove(aFails)).toBe(true);
    expect(cleanMove(aFails).orbit?.fromSince).toBe(NOW);
    const cTry = climbOf('c', 'c-room', 2, 1_020, NOW + 400_000);
    const lost = lostAltitudeClaims([bHold, aFails, cTry]);
    expect(lost.has(altitudeMoveKey(aFails))).toBe(true);
    expect(lost.has(altitudeMoveKey(cTry))).toBe(true);
    // Once a move of A's flies, the old orbit is free again.
    const later = climbOf('c', 'c-room', 2, 1_020, NOW + 400_000);
    const aWins = { ...aFails, orbit: { ...aFails.orbit!, toRadiusKm: SOV_R + 3_000 } };
    expect(lostAltitudeClaims([bHold, aWins, later]).has(altitudeMoveKey(later))).toBe(false);
  });

  it('the planner stamps when the orbit an altitude change leaves was claimed', () => {
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, NOW) : null));
    const climbed = listStations({}, [], NOW + 200_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    const plan = planStationAltitude(ctx({ station: climbed, now: NOW + 200_000 }), 1_200);
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.move.orbit?.fromSince).toBe(NOW);
    // From the slot's own orbit: nothing to stamp.
    setStationMoveResolver(null);
    expect(climbTo(1_200).orbit?.fromSince).toBeUndefined();
  });

  const changeFrom = (fromRadiusKm: number, toAlt: number, bookedAt: number, fromSince: number): StationMove => {
    const plan = planOrbitChange(circularOrbit(planetById(SOV), fromRadiusKm, 0), SOV_R + toAlt, bookedAt)!;
    return {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: SOV, toSlot: 0, departAt: plan.departAt, arriveAt: plan.arriveAt, mode: 'orbit', bookedAt, fuel: 5, fuelDrawn: 5,
      orbit: { fromRadiusKm, fromPhase0: 0, toRadiusKm: plan.to.radiusKm, toPhase0: plan.to.phase0, fromSince },
    };
  };
  const THIRD2: StationRecord = { id: 'third', name: 'THIRD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'third-room' };

  it('an aborted change whose old orbit was lost too falls back to the slot', () => {
    const mine = changeFrom(SOV_R + 1_020, 3_000, NOW + 100_000, NOW + 50);
    const other = climbOf('other', 'other-room', 1, 1_000, NOW);
    const third = climbOf('third', 'third-room', 2, 3_020, NOW);
    const moves: Record<string, StationMove> = { [DEFAULT_STATION_ID]: mine, other, third };
    setStationMoveResolver((st) => moves[st.id] ?? null);
    const me = listStations({}, [OTHER, THIRD2], NOW + 10_000_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(me.move).toBeUndefined();
    expect(me.orbit).toBeUndefined();
  });

  it('an aborted change from a trim past the band\'s edge stays at the edge', () => {
    const top = SOV_R + maxAltitudeKm(SOV);
    const mine = changeFrom(top + 15, 3_000, NOW + 100_000, NOW + 50);
    const third = climbOf('third', 'third-room', 2, 3_020, NOW);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? mine : st.id === 'third' ? third : null));
    const me = listStations({}, [THIRD2], NOW + 10_000_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(me.orbit?.radiusKm).toBeCloseTo(top, 6);
  });
});

describe('Copilot round 10', () => {
  afterEach(() => { setStationMoveResolver(null); });
  const changeFrom = (fromRadiusKm: number, toAlt: number, bookedAt: number, fromSince: number): StationMove => {
    const plan = planOrbitChange(circularOrbit(planetById(SOV), fromRadiusKm, 0), SOV_R + toAlt, bookedAt)!;
    return {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: SOV, toSlot: 0, departAt: plan.departAt, arriveAt: plan.arriveAt, mode: 'orbit', bookedAt, fuel: 5, fuelDrawn: 5,
      orbit: { fromRadiusKm, fromPhase0: 0, toRadiusKm: plan.to.radiusKm, toPhase0: plan.to.phase0, fromSince },
    };
  };

  it('a change whose source claim lost loses its destination too, and that defeats no later claim', () => {
    // B holds 1,000 km; A says it came from 1,020 km and aims for a clear 3,000 km.
    const other = climbOf('other', 'other-room', 1, 1_000, NOW);
    const mine = changeFrom(SOV_R + 1_020, 3_000, NOW + 100_000, NOW + 50);
    const later = climbOf('third', 'third-room', 2, 3_020, NOW + 200_000);
    const lost = lostAltitudeClaims([other, mine, later]);
    expect(lost.has(`${altitudeMoveKey(mine)}|from`)).toBe(true);
    expect(lost.has(altitudeMoveKey(mine))).toBe(true);
    expect(lost.has(altitudeMoveKey(later))).toBe(false);
    // Listed back on its slot's orbit, not flying from the rejected one.
    const moves: Record<string, StationMove> = { [DEFAULT_STATION_ID]: mine, other };
    setStationMoveResolver((st) => moves[st.id] ?? null);
    const me = listStations({}, [OTHER], NOW + 10_000_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(me.move).toBeUndefined();
    expect(me.orbit).toBeUndefined();
  });

  it('weighs the source first even when it was claimed at the booking time or after', () => {
    const other = climbOf('other', 'other-room', 1, 1_000, NOW);
    for (const since of [NOW + 100_000, NOW + 150_000]) {
      const mine = changeFrom(SOV_R + 1_020, 3_000, NOW + 100_000, since);
      expect(lostAltitudeClaims([other, mine]).has(altitudeMoveKey(mine))).toBe(true);
    }
    // With a clear source, the destination stands.
    const clear = changeFrom(SOV_R + 1_500, 3_000, NOW + 100_000, NOW + 50);
    expect(lostAltitudeClaims([other, clear]).size).toBe(0);
  });

  it('refuses a route stop whose orbit its planet\'s stations can\'t fly', () => {
    const stop: RouteStop = {
      stationId: DEFAULT_STATION_ID, name: 'FURLONG', planetId: SOV, orbitSlot: 0,
      berth: { roomId: 'r', farDoor: 'x+', anyGate: true }, waitSecs: 60,
    };
    expect(routeStopFromWire({ ...stop, orbit: { radiusKm: SOV_R + MIN_ALTITUDE_KM, phase0: 0 } })).not.toBeNull();
    expect(routeStopFromWire({ ...stop, orbit: { radiusKm: SOV_R + 50, phase0: 0 } })).toBeNull();
    expect(routeStopFromWire({ ...stop, orbit: { radiusKm: SOV_R + maxAltitudeKm(SOV) + 10, phase0: 0 } })).toBeNull();
  });
});

describe('Copilot round 10 (on PR 205)', () => {
  it('refuses a source claim stamped after the move was booked', () => {
    const plan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_000, 0), SOV_R + 3_000, NOW)!;
    const change: StationMove = {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: SOV, toSlot: 0, departAt: plan.departAt, arriveAt: plan.arriveAt, mode: 'orbit', bookedAt: NOW, fuel: 5, fuelDrawn: 5,
      orbit: { fromRadiusKm: SOV_R + 1_000, fromPhase0: 0, toRadiusKm: plan.to.radiusKm, toPhase0: plan.to.phase0, fromSince: NOW },
    };
    expect(isStationMove(change)).toBe(true);
    expect(isStationMove({ ...change, orbit: { ...change.orbit!, fromSince: NOW + 1 } })).toBe(false);
    // A legacy record with no booking time is held to its departure.
    const { bookedAt: _b, ...legacy } = change;
    expect(isStationMove({ ...legacy, orbit: { ...change.orbit!, fromSince: plan.departAt } })).toBe(true);
    expect(isStationMove({ ...legacy, orbit: { ...change.orbit!, fromSince: plan.departAt + 1 } })).toBe(false);

    const hop = climbOf('x', 'x-room', 1, 1_000, NOW);
    const thruster: StationMove = {
      ...hop, mode: 'thrusters', orbit: undefined, toPlanetId: 'planet-aris', toSlot: 3, bookedAt: NOW,
      fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0, since: NOW - 10 },
    };
    delete (thruster as { orbit?: unknown }).orbit;
    expect(isStationMove(thruster)).toBe(true);
    expect(isStationMove({ ...thruster, fromOrbit: { ...thruster.fromOrbit!, since: NOW + 1 } })).toBe(false);
  });
});

describe('Copilot round 11', () => {
  it('refuses an unstamped change that leaves a custom orbit, not the slot\'s', () => {
    const slotR = orbitForSlot(SOV, 0).radiusKm;
    const mk = (fromRadiusKm: number, fromSince?: number): StationMove => {
      const plan = planOrbitChange(circularOrbit(planetById(SOV), fromRadiusKm, 0), SOV_R + 3_000, NOW)!;
      return {
        stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
        toPlanetId: SOV, toSlot: 0, departAt: plan.departAt, arriveAt: plan.arriveAt, mode: 'orbit', bookedAt: NOW, fuel: 5, fuelDrawn: 5,
        orbit: {
          fromRadiusKm, fromPhase0: 0, toRadiusKm: plan.to.radiusKm, toPhase0: plan.to.phase0,
          ...(fromSince !== undefined ? { fromSince } : {}),
        },
      };
    };
    expect(isStationMove(mk(slotR))).toBe(true);
    expect(isStationMove(mk(slotR + 15))).toBe(true); // a trimmed slot orbit
    expect(isStationMove(mk(SOV_R + 1_020))).toBe(false);
    expect(isStationMove(mk(SOV_R + 1_020, NOW - 10))).toBe(true);
  });
});

describe('Copilot round 13', () => {
  it('keeps an old claim that still beats some station\'s latest altitude change remembered', () => {
    store.clear();
    const aHold = climbOf('a', 'a-room', 0, 1_000, NOW);
    const nextAt = aHold.arriveAt + 1_000;
    const nextPlan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_000, aHold.orbit!.toPhase0), SOV_R + 3_000, nextAt)!;
    const aNext: StationMove = {
      ...aHold, departAt: nextPlan.departAt, arriveAt: nextPlan.arriveAt, bookedAt: nextAt,
      orbit: {
        fromRadiusKm: nextPlan.from.radiusKm, fromPhase0: nextPlan.from.phase0, toRadiusKm: nextPlan.to.radiusKm,
        toPhase0: nextPlan.to.phase0, fromSince: NOW,
      },
    };
    const next2At = aNext.arriveAt + 1_000;
    const next2Plan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 3_000, nextPlan.to.phase0), SOV_R + 2_000, next2At)!;
    const aNext2: StationMove = {
      ...aHold, departAt: next2Plan.departAt, arriveAt: next2Plan.arriveAt, bookedAt: next2At,
      orbit: {
        fromRadiusKm: next2Plan.from.radiusKm, fromPhase0: next2Plan.from.phase0, toRadiusKm: next2Plan.to.radiusKm,
        toPhase0: next2Plan.to.phase0, fromSince: nextAt,
      },
    };
    const bLose = climbOf('b', 'b-room', 1, 1_020, aHold.arriveAt + 500);
    expect(isStationMove(aNext)).toBe(true);
    expect(isStationMove(aNext2)).toBe(true);
    expect(lostAltitudeClaims([aHold, aNext, aNext2, bLose]).has(altitudeMoveKey(bLose))).toBe(true);
    // A's latest alone no longer shows the 1,000 km claim that beat B.
    expect(lostAltitudeClaims([aNext2, bLose]).has(altitudeMoveKey(bLose))).toBe(false);
    const late = Math.max(aNext2.arriveAt, bLose.arriveAt) + MOVE_LOG_KEEP_MS + MOVE_FINAL_MS + 10_000_000;
    const soon = aNext2.arriveAt + 1_000;
    for (const m of [aHold, aNext, aNext2, bLose]) rememberMove(m, soon);
    expect(readRememberedMoves()).toHaveLength(4);
    // Time passes: the next move learned trims the history.
    const cMove = climbOf('c', 'c-room', 3, 6_000, late);
    expect(rememberMove(cMove, late)).toBe(true);
    // Only what decides it is kept: aNext's stamped source claim suffices.
    expect(readRememberedMoves().map(altitudeMoveKey).sort()).toEqual([aNext, aNext2, bLose, cMove].map(altitudeMoveKey).sort());
    expect(lostAltitudeClaims(readRememberedMoves()).has(altitudeMoveKey(bLose))).toBe(true);
    // With no loser left to decide, old history ages out as usual.
    store.clear();
    for (const m of [aHold, aNext, aNext2]) rememberMove(m, soon);
    rememberMove(cMove, late);
    expect(readRememberedMoves().map(altitudeMoveKey).sort()).toEqual([aNext2, cMove].map(altitudeMoveKey).sort());
    store.clear();
  });

  it('refuses an unstamped held orbit that is not the slot\'s own', () => {
    const climbed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0.5 } };
    const plan = planStationMove(ctx({ station: climbed }), 'planet-aris');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(isStationMove(plan.move)).toBe(true);
    const { since: _s, ...bare } = plan.move.fromOrbit!;
    expect(isStationMove({ ...plan.move, fromOrbit: bare })).toBe(false);
    const slotR = orbitForSlot(SOV, plan.move.fromSlot).radiusKm;
    expect(isStationMove({ ...plan.move, fromOrbit: { radiusKm: slotR + 10, phase0: 0 } })).toBe(true);
  });
});

describe('Copilot round 14', () => {
  it('keeps the evidence a held orbit that lost still needs, pins included', () => {
    store.clear();
    // A holds 1,000 km; B, booking a move while flying 1,020 km it says it
    // held since after A's claim, loses that held orbit.
    const aHold = climbOf('a', 'a-room', 0, 1_000, NOW);
    const nextAt = aHold.arriveAt + 1_000;
    const nextPlan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_000, aHold.orbit!.toPhase0), SOV_R + 3_000, nextAt)!;
    const aNext: StationMove = {
      ...aHold, departAt: nextPlan.departAt, arriveAt: nextPlan.arriveAt, bookedAt: nextAt,
      orbit: {
        fromRadiusKm: nextPlan.from.radiusKm, fromPhase0: nextPlan.from.phase0, toRadiusKm: nextPlan.to.radiusKm,
        toPhase0: nextPlan.to.phase0, fromSince: NOW,
      },
    };
    const next2At = aNext.arriveAt + 1_000;
    const next2Plan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 3_000, nextPlan.to.phase0), SOV_R + 2_000, next2At)!;
    const aNext2: StationMove = {
      ...aHold, departAt: next2Plan.departAt, arriveAt: next2Plan.arriveAt, bookedAt: next2At,
      orbit: {
        fromRadiusKm: next2Plan.from.radiusKm, fromPhase0: next2Plan.from.phase0, toRadiusKm: next2Plan.to.radiusKm,
        toPhase0: next2Plan.to.phase0, fromSince: nextAt,
      },
    };
    const bMove: StationMove = {
      stationId: 'b', welcomeRoomId: 'b-room', fromPlanetId: SOV, fromSlot: 1, toPlanetId: 'planet-aris', toSlot: 0,
      departAt: aHold.arriveAt + 3_000_000, arriveAt: aHold.arriveAt + 9_000_000, mode: 'tug', tugRoomId: 'tug-room', bookedAt: aHold.arriveAt + 600,
      fuel: 5, fuelDrawn: 5, fromOrbit: { radiusKm: SOV_R + 1_020, phase0: 0, since: aHold.arriveAt + 500 },
    };
    // Cancelled: a pin keeps the held orbit for good.
    const bPin: StationMove = {
      ...bMove, fromOrbit: undefined, mode: 'thrusters', tugRoomId: undefined, toPlanetId: SOV, toSlot: 1,
      departAt: bMove.departAt + 1, arriveAt: bMove.departAt + 2, settles: bMove, fuel: 0, fuelDrawn: 0, bookedAt: bMove.departAt,
    };
    delete bPin.fromOrbit;
    delete bPin.tugRoomId;
    expect(isStationMove(bPin)).toBe(true);
    expect(lostAltitudeClaims([aHold, aNext, aNext2, bPin]).has(altitudeMoveKey(bPin))).toBe(true);
    expect(lostAltitudeClaims([aNext2, bPin]).has(altitudeMoveKey(bPin))).toBe(false);
    const soon = aNext2.arriveAt + 1_000;
    for (const m of [aHold, aNext, aNext2, bPin]) rememberMove(m, soon);
    const late = Math.max(aNext2.arriveAt, bPin.arriveAt) + MOVE_LOG_KEEP_MS + MOVE_FINAL_MS + 10_000_000;
    rememberMove(climbOf('c', 'c-room', 3, 6_000, late), late);
    expect(lostAltitudeClaims(readRememberedMoves()).has(altitudeMoveKey(bPin))).toBe(true);
    store.clear();
  });
});

describe('Copilot round 15', () => {
  it('refuses a held orbit within 50 km of another slot\'s own', () => {
    const climbed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0.5 } };
    const plan = planStationMove(ctx({ station: climbed }), 'planet-aris');
    if (!plan.ok) throw new Error(plan.refusal);
    const slot1 = orbitForSlot(SOV, 1).radiusKm;
    expect(isStationMove({ ...plan.move, fromOrbit: { ...plan.move.fromOrbit!, radiusKm: slot1 + 30 } })).toBe(false);
    expect(isStationMove({ ...plan.move, fromOrbit: { ...plan.move.fromOrbit!, radiusKm: slot1 + 60 } })).toBe(true);
  });

  it('weighs and restores the base orbit a trimmed altitude change leaves, not the trim', () => {
    setStationTrimResolverForTest((s, slot) => (s.id === DEFAULT_STATION_ID ? { radiusKm: slot.radiusKm + 10, phase0: slot.phase0 } : null));
    try {
      const move = climbTo(3_000);
      const slot0 = orbitForSlot(SOV, 0);
      expect(move.orbit!.fromRadiusKm).toBeCloseTo(slot0.radiusKm + 10, 6);
      expect(move.orbit!.fromBase).toEqual({ radiusKm: slot0.radiusKm, phase0: slot0.phase0 });
      expect(isStationMove(move)).toBe(true);
      expect(cleanMove(move).orbit?.fromBase).toEqual(move.orbit!.fromBase);
      // A base more than a trim from where it flies from is refused.
      expect(isStationMove({ ...move, orbit: { ...move.orbit!, fromBase: { radiusKm: slot0.radiusKm + 40, phase0: 0 } } })).toBe(false);
    } finally {
      setStationTrimResolverForTest(null);
    }
    // B holds 1,000 km; A's base is 1,050 km, trimmed to 1,040 km: its
    // source claim is clear (50 km), though the trimmed orbit is not.
    const bHold = climbOf('b', 'b-room', 1, 1_000, NOW);
    const plan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_040, 0), SOV_R + 3_000, NOW + 100_000)!;
    const aTry: StationMove = {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: SOV, toSlot: 0, departAt: plan.departAt, arriveAt: plan.arriveAt, mode: 'orbit', bookedAt: NOW + 100_000, fuel: 5, fuelDrawn: 5,
      orbit: {
        fromRadiusKm: SOV_R + 1_040, fromPhase0: 0, toRadiusKm: plan.to.radiusKm, toPhase0: plan.to.phase0, fromSince: NOW + 50,
        fromBase: { radiusKm: SOV_R + 1_050, phase0: 0.1 },
      },
    };
    expect(isStationMove(aTry)).toBe(true);
    expect(lostAltitudeClaims([bHold, aTry]).has(`${altitudeMoveKey(aTry)}|from`)).toBe(false);
    // Aborted by a claim on its destination: back on its base, untrimmed.
    const third = climbOf('third', 'third-room', 2, 3_020, NOW);
    const moves: Record<string, StationMove> = { [DEFAULT_STATION_ID]: aTry, b: bHold, third };
    setStationMoveResolver((st) => moves[st.id] ?? null);
    const THIRD: StationRecord = { id: 'third', name: 'THIRD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'third-room' };
    const B: StationRecord = { id: 'b', name: 'B', planetId: SOV, orbitSlot: 1, welcomeRoomId: 'b-room' };
    const me = listStations({}, [B, THIRD], NOW + 10_000_000).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(me.orbit).toEqual({ radiusKm: SOV_R + 1_050, phase0: 0.1 });
  });
});

describe('Copilot round 16', () => {
  it('carries the claims that keep another station\'s altitude change lost beside the latest move', () => {
    store.clear();
    // A climbs to 1,000 km, then on to 3,000 and back to 2,000; B's later
    // climb to 1,020 km loses to A's first claim, which A's latest hides.
    const aHold = climbOf('a', 'a-room', 0, 1_000, NOW);
    const nextAt = aHold.arriveAt + 1_000;
    const nextPlan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 1_000, aHold.orbit!.toPhase0), SOV_R + 3_000, nextAt)!;
    const aNext: StationMove = {
      ...aHold, departAt: nextPlan.departAt, arriveAt: nextPlan.arriveAt, bookedAt: nextAt,
      orbit: {
        fromRadiusKm: nextPlan.from.radiusKm, fromPhase0: nextPlan.from.phase0, toRadiusKm: nextPlan.to.radiusKm,
        toPhase0: nextPlan.to.phase0, fromSince: NOW,
      },
    };
    const next2At = aNext.arriveAt + 1_000;
    const next2Plan = planOrbitChange(circularOrbit(planetById(SOV), SOV_R + 3_000, nextPlan.to.phase0), SOV_R + 2_000, next2At)!;
    const aNext2: StationMove = {
      ...aHold, departAt: next2Plan.departAt, arriveAt: next2Plan.arriveAt, bookedAt: next2At,
      orbit: {
        fromRadiusKm: next2Plan.from.radiusKm, fromPhase0: next2Plan.from.phase0, toRadiusKm: next2Plan.to.radiusKm,
        toPhase0: next2Plan.to.phase0, fromSince: nextAt,
      },
    };
    const bLose = climbOf('b', 'b-room', 1, 1_020, aHold.arriveAt + 500);
    const soon = aNext2.arriveAt + 1_000;
    for (const m of [aHold, aNext, aNext2, bLose]) rememberMove(m, soon);
    const claims = decidingClaimsOf('a-room');
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => compareMoves(c, aNext2) < 0)).toBe(true);
    expect(decidingClaimsOf('b-room')).toEqual([]);
    // They ride A's summary, and a fresh install that learns only the two
    // summaries still finds B's climb lost.
    const summary: StationSummary = { welcomeRoomId: 'a-room', name: 'A', planetId: SOV, orbitSlot: 0, updatedAt: soon, move: aNext2, claims };
    const heard = cleanStationSummary(JSON.parse(JSON.stringify(summary)), soon)!;
    expect(heard.claims).toEqual(claims);
    store.clear();
    rememberMove(bLose, soon);
    rememberMove(heard.move!, soon);
    expect(lostAltitudeClaims(readRememberedMoves()).has(altitudeMoveKey(bLose))).toBe(false);
    for (const c of heard.claims!) rememberMove(c, soon);
    expect(lostAltitudeClaims(readRememberedMoves()).has(altitudeMoveKey(bLose))).toBe(true);
    // A claim that does not rank below the move, or another station's, is dropped.
    expect(cleanStationSummary({ ...summary, move: aNext, claims: [aNext2] }, soon)!.claims).toBeUndefined();
    expect(cleanStationSummary({ ...summary, claims: [bLose] }, soon)!.claims).toBeUndefined();
    expect(cleanStationSummary({ ...summary, claims: [{ ...aHold, orbit: undefined }] }, soon)!.claims).toBeUndefined();
    // Merging keeps both sides' claims, once each.
    const merged = mergeStation({ ...summary, claims: [aNext] }, { ...summary, claims: [aHold, aNext] }, soon)!;
    expect(merged.claims).toEqual([aNext, aHold]);
    store.clear();
  });

  it('counts a held orbit claimed in the very millisecond of cast-off', () => {
    const leave: StationMove = {
      stationId: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId, fromPlanetId: SOV, fromSlot: 0,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: NOW + 5_000_000, arriveAt: NOW + 9_000_000, mode: 'thrusters',
      bookedAt: NOW + 100_000, fuel: 5, fuelDrawn: 10, fromOrbit: { radiusKm: SOV_R + 1_000, phase0: 0, since: NOW },
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? leave : null));
    setAltitudeHistory(() => []);
    const station = { id: DEFAULT_STATION_ID, welcomeRoomId: DEFAULT_STATION_RECORD.welcomeRoomId };
    expect(altitudeChangedSince(station, NOW, NOW + 200_000)).toBe(true);
    expect(altitudeChangedSince(station, NOW + 1, NOW + 200_000)).toBe(false);
  });
});

describe('open-orbit places at a station\'s own altitude', () => {
  it('names the altitude in the adrift id, and reads it back only when its planet\'s stations can fly it', () => {
    const orbit = { radiusKm: SOV_R + 1_234.5, phase0: 0.75 };
    const id = adriftAt(SOV, 2, orbit);
    expect(id).toBe(`adrift:${SOV}:2@${orbit.radiusKm},${orbit.phase0}`);
    expect(adriftPlace(id)).toEqual({ planetId: SOV, orbitSlot: 2, orbit });
    // The slot's own orbit, or none it could fly: the slot alone.
    expect(adriftAt(SOV, 2)).toBe(`adrift:${SOV}:2`);
    expect(adriftAt(SOV, 2, { radiusKm: 1, phase0: 0 })).toBe(`adrift:${SOV}:2`);
    expect(adriftPlace(`adrift:${SOV}:2`)).toEqual({ planetId: SOV, orbitSlot: 2 });
    // Malformed or out of band: no place.
    for (const bad of [`adrift:${SOV}:2@`, `adrift:${SOV}:2@1,`, `adrift:${SOV}:2@x,0`, `adrift:${SOV}:2@1,2,3`, `adrift:${SOV}:2@10,0`]) {
      expect(adriftPlace(bad)).toBeNull();
    }
    expect(onPlaceOrbit(orbit, { ...orbit, phase0: orbit.phase0 + 2 * Math.PI })).toBe(true);
    expect(onPlaceOrbit(orbit, undefined)).toBe(false);
    expect(onPlaceOrbit(undefined, undefined)).toBe(true);
  });

  it('keeps the altitude a destination flew at cast-off in the flight record', () => {
    const at = Date.now() - 10 * 86_400_000;
    const climb = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, at);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? climb : null));
    const { destinationAt } = castOffPlaces(adriftAt(SOV, 3), DEFAULT_STATION_ID);
    expect(adriftPlace(destinationAt!)).toMatchObject({ planetId: SOV, orbitSlot: 0, orbit: { radiusKm: SOV_R + 1_000 } });
  });

  it('a redocking ship waits at the kept altitude until its station flies it again', () => {
    const at = Date.now() - 10 * 86_400_000;
    const climb = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, at);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? climb : null));
    const destinationAt = castOffPlaces(adriftAt(SOV, 3), DEFAULT_STATION_ID).destinationAt!;
    const rec = { status: 'redocking' as const, locationId: DEFAULT_STATION_ID, departedAt: at, etaAt: at + 1, destinationAt };
    expect(shipPlaceId(rec, Date.now(), null)).toBe(DEFAULT_STATION_ID);
    // Back on its slot's orbit since: the same slot, but not that place.
    setStationMoveResolver(null);
    expect(shipPlaceId(rec, Date.now(), null)).toBe(destinationAt);
  });

  it('a flight record from before kept places still finds the altitude its station left', () => {
    store.clear();
    const climbed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0.5 } };
    const plan = planStationMove(ctx({ station: climbed }), 'planet-aris');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(rememberMove(plan.move, NOW)).toBe(true);
    const leftAt = plan.move.departAt - 1_000;
    const rec = { status: 'redocking' as const, locationId: DEFAULT_STATION_ID, departedAt: leftAt, etaAt: leftAt + 1, castOffAt: leftAt };
    const place = adriftPlace(shipPlaceId(rec, plan.move.departAt + 1, null));
    expect(place).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    expect(place?.orbit?.radiusKm).toBeCloseTo(SOV_R + 1_000, 6);
    store.clear();
  });

  it('a slot orbit spelled out in the place is the slot\'s own', () => {
    const at = Date.now() - 10 * 86_400_000;
    const slot = orbitForSlot(SOV, 0);
    const destinationAt = adriftAt(SOV, 0, { radiusKm: slot.radiusKm, phase0: slot.phase0 });
    // One place, one id: the slot's orbit is never spelled out, nor read back.
    expect(destinationAt).toBe(adriftAt(SOV, 0));
    expect(adriftPlace(`adrift:${SOV}:0@${slot.radiusKm},${slot.phase0 + 2 * Math.PI}`)).toEqual({ planetId: SOV, orbitSlot: 0 });
    const rec = { status: 'redocking' as const, locationId: DEFAULT_STATION_ID, departedAt: at, etaAt: at + 1, destinationAt };
    expect(shipPlaceId(rec, Date.now(), null)).toBe(DEFAULT_STATION_ID);
  });

  it('a place kept before places named an altitude says nothing of it', () => {
    // Cast off for a station flying 1,000 km, under the old id (slot only):
    // it has not moved, so the ship is beside it, not left at the slot.
    const at = Date.now() - 10 * 86_400_000;
    const climb = climbOf(DEFAULT_STATION_ID, DEFAULT_STATION_RECORD.welcomeRoomId, 0, 1_000, at);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? climb : null));
    const rec = { status: 'redocking' as const, locationId: DEFAULT_STATION_ID, departedAt: at + 86_400_000, etaAt: at + 86_400_001, destinationAt: adriftAt(SOV, 0) };
    expect(shipPlaceId(rec, Date.now(), null)).toBe(DEFAULT_STATION_ID);
  });
});
