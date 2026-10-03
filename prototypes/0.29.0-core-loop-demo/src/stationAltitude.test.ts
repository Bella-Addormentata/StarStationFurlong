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
import { cleanStationSummary, summaryForStation, unbindPlanetSummaryForTest } from './planetSummary';
import { FUEL_PER_KMS } from './stationDirectory';
import { applyBurn, planTrim, trimFor } from './stationKeeping';
import type { OrbitTrim, TrimContext } from './stationKeeping';
import {
  altitudeConflict,
  bindStationMoveDoc,
  cleanMove,
  describeAltitudeRefusal,
  describeMove,
  dockLockedByMove,
  freeSlotAround,
  installStationMoveResolver,
  isPinMove,
  isStationMove,
  moveTransitPointAt,
  orbitChangeTransitPointAt,
  orbitsToKeepClear,
  planStationAltitude,
  planStationMove,
  readStationMove,
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
afterEach(() => { setStationMoveResolver(null); unbindPlanetSummaryForTest(); });

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
  const climbOf = (id: string, room: string, slot: number, toAlt: number, bookedAt: number): StationMove => ({
    stationId: id, welcomeRoomId: room, fromPlanetId: SOV, fromSlot: slot, toPlanetId: SOV, toSlot: slot,
    departAt: bookedAt, arriveAt: bookedAt + 60_000, mode: 'orbit', bookedAt, fuel: 5, fuelDrawn: 5,
    orbit: { fromRadiusKm: orbitForSlot(SOV, slot).radiusKm, fromPhase0: 0, toRadiusKm: SOV_R + toAlt, toPhase0: 0 },
  });

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
    // Booked one after the other arrived: both fly (the planner keeps them apart).
    const later = climbOf('other', 'other-room', 1, 1_020, NOW + 60_001);
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? mine : st.id === 'other' ? later : null));
    expect(listStations({}, [OTHER], NOW + 200_000).find((s) => s.id === 'other')?.orbit?.radiusKm).toBe(SOV_R + 1_020);
  });

  it('keeps the altitude flown until a later move leaves, and for good when it is cancelled', () => {
    const climbed = { ...ctx().station!, orbit: { radiusKm: SOV_R + 1_000, phase0: 0.5 } };
    const plan = planStationMove(ctx({ station: climbed }), 'planet-aris');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.move.fromOrbit).toEqual(climbed.orbit);
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
