/**
 * 🚚 stationMove — a station leaving its planet for another under its own
 * thrusters: planning, the record, and how the station list follows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ORBIT_EPOCH_MS, setStationTrimResolver } from './orbits';
import { courseOnScreen, screenOffset, stationBodies } from './map';
import {
  bindPlanetSummaryDoc,
  cleanStationSummary,
  mergeStation,
  foldOwnStation,
  summaryForStation,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import { AU_KM, planPlanetTransfer, planetSunPointAt } from './solarOrbits';
import { FUEL_PER_KMS, planRecordHop } from './stationDirectory';
import { FUEL_METER_MAX, bindShipDoc, fuelDrawDeficit, readFuelLevel, writeFuelLevel } from './shipDoc';
import { TRIM_FUEL, bindStationKeepingDoc, planTrim, readOrbitTrim, writeTrimBurn } from './stationKeeping';
import {
  TUG_ACCEL_KMS2,
  TUG_MIN_ENGINES,
  MOVE_HORIZON_MS,
  bindStationMoveDoc,
  cancelTowLeftBehind,
  concurrentMoves,
  isCancelPin,
  isPinMove,
  pinSettledArrival,
  pinSettledArrivals,
  isPlausibleMove,
  compareMoves,
  dockLockedByMove,
  cleanMove,
  freeSlotAround,
  isTowing,
  moveTransitPointAt,
  describeTowRefusal,
  planStationTow,
  planTow,
  quoteTow,
  towFuelCost,
  towPointAt,
  towHoldsDock,
  installStationMoveResolver,
  isStationMove,
  movePhase,
  moveFuelCost,
  quoteMove,
  planStationMove,
  readMoveFuelDrawn,
  readRememberedMoves,
  readStationMove,
  rememberedMoveFor,
  FOLD_ITEMS_MAX,
  MOVE_ENTRIES_KEEP,
  MOVE_SCAN_MAX,
  MOVE_SETTLED_KEEP,
  SWEEP_BATCH,
  rememberMove,
  rememberMovesIn,
  roomDocLockedByMove,
  subscribeStationMove,
  writeStationMove,
} from './stationMove';
import type { MoveContext, StationMove, TowContext } from './stationMove';
import {
  DEFAULT_STATION_ID,
  DEFAULT_STATION_RECORD,
  knownSlotsAround,
  listStations,
  registerStation,
  setKnownPlacesResolver,
  setStationMoveResolver,
  stationInTransit,
} from './stations';
import type { KnownPlace, StationRecord } from './stations';
import type { AtlasEntry } from './stationAtlas';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const SOV = 'planet-sovereign';
const ARIS = 'planet-aris';
const NOW = ORBIT_EPOCH_MS + 5_000_000_000;

beforeEach(() => store.clear());
afterEach(() => { setStationMoveResolver(null); setKnownPlacesResolver(null); unbindPlanetSummaryForTest(); });

const ctx = (over: Partial<MoveContext> = {}): MoveContext => {
  const stations = listStations({}, [], NOW);
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

const moveTo = (to = ARIS): StationMove => {
  const plan = planStationMove(ctx(), to);
  if (!plan.ok) throw new Error(plan.refusal);
  return plan.move;
};

/** The pin pinSettledArrival writes once `m` has arrived where it was bound. */
const pinOf = (m: StationMove): StationMove => ({
  ...m, fromPlanetId: m.toPlanetId, fromSlot: m.toSlot, departAt: m.arriveAt, arriveAt: m.arriveAt + 1,
  mode: 'thrusters', tugRoomId: undefined, bookedAt: m.arriveAt, settles: m, fuel: 0, fuelDrawn: 0,
});

describe('planning a thruster move', () => {
  it('leaves at the next launch window and takes the Hohmann transfer time', () => {
    const plan = planStationMove(ctx(), ARIS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const t = planPlanetTransfer(DEFAULT_STATION_RECORD, { id: 'x', planetId: ARIS, orbitSlot: 0 }, NOW)!;
    expect(plan.move).toMatchObject({
      stationId: DEFAULT_STATION_ID,
      fromPlanetId: SOV,
      fromSlot: 0,
      toPlanetId: ARIS,
      toSlot: 0,
      departAt: t.departAt,
      arriveAt: t.arriveAt,
      mode: 'thrusters',
    });
    expect(isStationMove(plan.move)).toBe(true);
  });

  it('prices both burns on delta-v and on the modules pushed, and runs the meter on', () => {
    const plan = planStationMove(ctx(), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.move.fuel).toBe(Math.ceil(plan.quote.plan.deltaVKmS * FUEL_PER_KMS * 3));
    expect(plan.move.fuelDrawn).toBe(7 + plan.move.fuel);
    expect(moveFuelCost(1, 0)).toBe(FUEL_PER_KMS); // at least one module
  });

  it('refuses in the helm\'s order', () => {
    expect(planStationMove(ctx({ bolted: false }), ARIS)).toMatchObject({ ok: false, refusal: 'not-bolted' });
    expect(planStationMove(ctx({ station: null }), ARIS)).toMatchObject({ ok: false, refusal: 'no-station' });
    expect(planStationMove(ctx({ modules: 0 }), ARIS)).toMatchObject({ ok: false, refusal: 'unknown-layout', quote: null });
    expect(quoteMove(ctx().station, ctx().stations, ARIS, 0, NOW)).toBeNull();
    expect(planStationMove(ctx({ commander: false }), ARIS)).toMatchObject({ ok: false, refusal: 'not-commander' });
    expect(planStationMove(ctx(), SOV)).toMatchObject({ ok: false, refusal: 'same-planet' });
    expect(planStationMove(ctx({ engines: 0 }), ARIS)).toMatchObject({ ok: false, refusal: 'no-thrusters' });
    const dry = planStationMove(ctx({ fuel: 5 }), ARIS);
    expect(dry).toMatchObject({ ok: false, refusal: 'no-fuel' });
    expect(dry.ok ? null : dry.quote?.fuel).toBeGreaterThan(5);
    const busy = { ...ctx().station!, move: moveTo() };
    expect(planStationMove(ctx({ station: busy }), ARIS)).toMatchObject({ ok: false, refusal: 'moving' });
  });

  it('asks for the lowest free orbit at the destination', () => {
    const taken: StationRecord[] = [{ id: 'aris-hub', name: 'HUB', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'r' }];
    expect(freeSlotAround(ARIS, taken)).toBe(1);
    const plan = planStationMove(ctx({ stations: [...ctx().stations, ...taken] }), ARIS);
    expect(plan.ok && plan.move.toSlot).toBe(1);
  });
});

describe('the station list follows a move', () => {
  it('keeps the station at home until it arrives, then lists it at the new planet', () => {
    const move = moveTo();
    setStationMoveResolver((st) => (st.id === move.stationId ? move : null));
    const at = (t: number) => listStations({}, [], t).find((s) => s.id === DEFAULT_STATION_ID)!;

    const before = at(move.departAt - 1);
    expect(before).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    expect(movePhase(move, move.departAt - 1)).toBe('scheduled');
    expect(stationInTransit(before, move.departAt - 1)).toBe(false);

    const mid = (move.departAt + move.arriveAt) / 2;
    expect(stationInTransit(at(mid), mid)).toBe(true);

    const after = at(move.arriveAt);
    expect(after).toMatchObject({ planetId: ARIS, orbitSlot: 0 });
    expect(after.move).toBeUndefined();
  });

  it('frees a station\'s old slot while it is between planets', () => {
    const move = moveTo();
    setStationMoveResolver((st) => (st.id === move.stationId ? move : null));
    const mid = (move.departAt + move.arriveAt) / 2;
    // A station that wants Furlong's slot takes it once Furlong has left,
    // not before.
    const other: StationRecord = { id: 'yard', name: 'YARD', planetId: SOV, orbitSlot: 0, welcomeRoomId: 'y' };
    const yardAt = (t: number) => listStations({}, [other], t).find((s) => s.id === 'yard')!;
    expect(yardAt(move.departAt - 1).orbitSlot).toBe(1);
    expect(yardAt(mid).orbitSlot).toBe(0);
    const listed = listStations({}, [], mid);
    expect(freeSlotAround(SOV, listed, undefined, mid)).toBe(0);
    expect(freeSlotAround(SOV, listStations({}, [], move.departAt - 1), undefined, move.departAt - 1)).toBe(1);
    // Its destination slot is not offered to the next move there, booked
    // before it arrives or on its way; once it is there, it simply holds it.
    expect(freeSlotAround(ARIS, listStations({}, [], move.departAt - 1), undefined, move.departAt - 1)).not.toBe(move.toSlot);
    expect(freeSlotAround(ARIS, listed, undefined, mid)).not.toBe(move.toSlot);
    expect(freeSlotAround(ARIS, listStations({}, [], move.arriveAt + 1), undefined, move.arriveAt + 1)).not.toBe(move.toSlot);
  });

  it('refuses ship hops to or from a station in transit', () => {
    const move = moveTo();
    setStationMoveResolver((st) => (st.id === move.stationId ? move : null));
    const mid = (move.departAt + move.arriveAt) / 2;
    const other: StationRecord = { id: 'yard', name: 'YARD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'y' };
    const furlong = listStations({}, [other], mid).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(planRecordHop(other, furlong, mid)).toBeNull();
    expect(planRecordHop(furlong, other, mid)).toBeNull();
    const home = listStations({}, [other], move.departAt - 1).find((s) => s.id === DEFAULT_STATION_ID)!;
    const early = move.departAt - 10 * 3_600_000;
    expect(planRecordHop(other, home, early)).not.toBeNull();
  });

  it('refuses a hop that would arrive after the station has left', () => {
    const move = moveTo();
    setStationMoveResolver((st) => (st.id === move.stationId ? move : null));
    const other: StationRecord = { id: 'yard', name: 'YARD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'y' };
    const justBefore = move.departAt - 1_000;
    const home = listStations({}, [other], justBefore).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(stationInTransit(home, justBefore)).toBe(false);
    expect(planRecordHop(other, home, justBefore)).toBeNull();
    expect(planRecordHop(home, other, justBefore)).toBeNull();
  });

  it('lets a ship leave a station that only moves after the ship has left', () => {
    const other: StationRecord = { id: 'yard', name: 'YARD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'y' };
    const early = moveTo().departAt - 10 * 3_600_000;
    const hop = planRecordHop({ ...DEFAULT_STATION_RECORD }, other, early)!;
    expect(hop).not.toBeNull();
    // The source leaves after the burn (still inside the flight): fine.
    const later: StationMove = { ...moveTo(), departAt: hop.departAt + 1, arriveAt: hop.departAt + 3_600_000 };
    expect(planRecordHop({ ...DEFAULT_STATION_RECORD, move: later }, other, early)).not.toBeNull();
    // The source is still on its way to its new orbit at the burn: refused.
    const landing: StationMove = { ...later, departAt: early - 1000, arriveAt: hop.departAt - 1 };
    expect(planRecordHop({ ...DEFAULT_STATION_RECORD, move: landing }, other, early)).toBeNull();
    // The destination leaves before the ship arrives: refused.
    expect(planRecordHop({ ...DEFAULT_STATION_RECORD }, { ...other, move: { ...later, stationId: 'yard', welcomeRoomId: 'y' } }, early))
      .toBeNull();
  });

  it('keeps a station listed when its move lands on a full planet', () => {
    const move = moveTo();
    setStationMoveResolver((st) => (st.id === move.stationId ? move : null));
    const full: StationRecord[] = Array.from({ length: 16 }, (_, i) => (
      { id: `aris-${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, welcomeRoomId: `a${i}` }));
    // Sixteen stations already fill Aris; the mover is listed after them,
    // so it loses the race for a slot there.
    const moved: StationRecord = { id: 'mover', name: 'MOVER', planetId: SOV, orbitSlot: 4, welcomeRoomId: 'm' };
    const mover = { ...move, stationId: 'mover', welcomeRoomId: 'm', fromSlot: 4 };
    setStationMoveResolver((st) => (st.welcomeRoomId === 'm' ? mover : null));
    const list = listStations({}, [...full, moved], move.arriveAt + 1);
    expect(list.filter((s) => s.planetId === ARIS)).toHaveLength(16);
    expect(list.find((s) => s.id === 'mover')).toMatchObject({ planetId: SOV, orbitSlot: 4 });
  });

  it('keeps a bounced arrival listed when its home filled up while it was away', () => {
    const move = moveTo();
    const full: StationRecord[] = Array.from({ length: 16 }, (_, i) => (
      { id: `aris-${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, welcomeRoomId: `a${i}` }));
    // Its home slot was let go in transit, and Sovereign filled up behind it.
    const home: StationRecord[] = Array.from({ length: 15 }, (_, i) => (
      { id: `sov-${i + 1}`, name: `S${i + 1}`, planetId: SOV, orbitSlot: i + 1, welcomeRoomId: `s${i + 1}` }));
    const moved: StationRecord = { id: 'mover', name: 'MOVER', planetId: SOV, orbitSlot: 4, welcomeRoomId: 'm' };
    const mover = { ...move, stationId: 'mover', welcomeRoomId: 'm', fromSlot: 4 };
    setStationMoveResolver((st) => (st.welcomeRoomId === 'm' ? mover : null));
    const list = listStations({}, [...full, ...home, moved], move.arriveAt + 1);
    expect(list.filter((s) => s.planetId === ARIS)).toHaveLength(16);
    expect(list.filter((s) => s.planetId === SOV && s.id !== 'mover')).toHaveLength(16);
    // Both planets full: it stays home, sharing its old slot, not dropped.
    expect(list.find((s) => s.id === 'mover')).toMatchObject({ planetId: SOV, orbitSlot: 4 });
    // A vacancy at the other planet later never pulls it across without a
    // transfer: it bounced home, and home it stays.
    const later = listStations({}, [...full.slice(1), ...home, moved], move.arriveAt + 2);
    expect(later.find((s) => s.id === 'mover')).toMatchObject({ planetId: SOV, orbitSlot: 4 });
  });

  it('keeps every incumbent when the first-listed station arrives at a full planet, for good', () => {
    const move = moveTo();
    // Sixteen stations at Aris; the last one leaves for Sovereign after the
    // default station has arrived (and is back before now).
    const full: StationRecord[] = Array.from({ length: 16 }, (_, i) => (
      { id: `aris-${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, welcomeRoomId: `a${i}` }));
    const leaves: StationMove = {
      ...move, stationId: 'aris-15', welcomeRoomId: 'a15', fromPlanetId: ARIS, fromSlot: 15, toPlanetId: SOV, toSlot: 6,
      departAt: move.arriveAt + 1000, arriveAt: move.arriveAt + 2000,
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'a15' ? leaves : null));
    const atArrival = listStations({}, full, move.arriveAt + 1);
    expect(atArrival.filter((s) => s.planetId === ARIS).map((s) => s.id)).toEqual(full.map((r) => r.id));
    expect(atArrival.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    // Aris now has a free slot, and the default station still stays home: it
    // bounced when it arrived, and a vacancy later never pulls it across.
    const later = listStations({}, full, leaves.arriveAt + 1);
    expect(later.filter((s) => s.planetId === ARIS)).toHaveLength(15);
    expect(later.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV, orbitSlot: 0 });

    // A second arrival after the vacancy finds room: the bounced station
    // counts where it settled (home), not where it was headed.
    const second: StationMove = {
      ...move, stationId: 'late', welcomeRoomId: 'late', fromSlot: 9, departAt: leaves.arriveAt + 10, arriveAt: leaves.arriveAt + 20,
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move
      : st.welcomeRoomId === 'a15' ? leaves : st.welcomeRoomId === 'late' ? second : null));
    const lateRec: StationRecord = { id: 'late', name: 'LATE', planetId: SOV, orbitSlot: 9, welcomeRoomId: 'late' };
    const withSecond = listStations({}, [...full, lateRec], second.arriveAt + 1);
    expect(withSecond.find((s) => s.id === 'late')).toMatchObject({ planetId: ARIS });
    expect(withSecond.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV });
  });

  it('keeps a bounced arrival bounced when a station it counted turns out to have left', () => {
    const move = moveTo();
    const full: StationRecord[] = Array.from({ length: 16 }, (_, i) => (
      { id: `aris-${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, welcomeRoomId: `a${i}` }));
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    expect(listStations({}, full, move.arriveAt + 1).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: SOV });
    // Later this install learns one of the sixteen had left before the
    // default station arrived: the bounce this install saw still stands.
    const left: StationMove = {
      ...move, stationId: 'aris-15', welcomeRoomId: 'a15', fromPlanetId: ARIS, fromSlot: 15, toPlanetId: SOV, toSlot: 6,
      departAt: move.departAt, arriveAt: move.arriveAt - 1000,
    };
    // Many more arrivals since (other stations', well past the 128 the log
    // once kept) never push its outcome out.
    for (let k = 0; k < 200; k++) {
      // Fifty stations, each arriving again and again with a new move.
      const room = `o${k % 50}`;
      const other: StationMove = { ...move, stationId: room, welcomeRoomId: room, toPlanetId: SOV, fromPlanetId: ARIS,
        departAt: move.departAt + k, arriveAt: move.arriveAt + k };
      setStationMoveResolver((st) => (st.welcomeRoomId === room ? other : null));
      listStations({}, [{ id: room, name: 'O', planetId: ARIS, orbitSlot: 0, welcomeRoomId: room }], move.arriveAt + 1000);
    }
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'a15' ? left : null));
    expect(listStations({}, full, move.arriveAt + 2).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: SOV });
    // A move differing only in its arrival is a different move: decided afresh.
    const sooner = { ...move, arriveAt: move.arriveAt - 1 };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? sooner : st.welcomeRoomId === 'a15' ? left : null));
    expect(listStations({}, full, move.arriveAt + 2).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: ARIS });
  });

  it('lets an arrival into the slot a station still on its way out has left', () => {
    const inbound = { ...moveTo(), bookedAt: moveTo().departAt };
    const T = inbound.arriveAt;
    // Fifteen stations stay at Aris; the sixteenth left before T and is
    // still between planets now.
    const residents: StationRecord[] = Array.from({ length: 15 }, (_, i) => (
      { id: `aris-${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, welcomeRoomId: `a${i}` }));
    const leaver: StationRecord = { id: 'leaver', name: 'L', planetId: ARIS, orbitSlot: 15, welcomeRoomId: 'l-room' };
    const outbound: StationMove = {
      stationId: 'leaver', welcomeRoomId: 'l-room', fromPlanetId: ARIS, fromSlot: 15, toPlanetId: SOV, toSlot: 5,
      departAt: T - 1000, arriveAt: T + 10 * 86_400_000, mode: 'thrusters', fuel: 1, fuelDrawn: 1, bookedAt: T - 2000,
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? inbound : st.welcomeRoomId === 'l-room' ? outbound : null));
    const listed = listStations({}, [...residents, leaver], T + 5);
    expect(listed.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS, orbitSlot: 15 });
    expect(stationInTransit(listed.find((s) => s.id === 'leaver')!, T + 5)).toBe(true);
  });

  it('keeps a booked slot for its arrival from clash losers, derived stations and new records', () => {
    // Furlong books Aris slot 2; two records there clash for slot 1.
    const move = { ...moveTo(), toSlot: 2, bookedAt: moveTo().departAt };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    const winner: StationRecord = { id: 'aris-a', name: 'A', planetId: ARIS, orbitSlot: 1, welcomeRoomId: 'a' };
    const loser: StationRecord = { id: 'aris-b', name: 'B', planetId: ARIS, orbitSlot: 1, welcomeRoomId: 'b' };
    const mid = (move.departAt + move.arriveAt) / 2;
    for (const t of [move.departAt - 1, mid]) {
      expect(listStations({}, [winner, loser], t).find((s) => s.id === 'aris-b')).toMatchObject({ planetId: ARIS, orbitSlot: 3 });
    }
    const landed = listStations({}, [winner, loser], move.arriveAt + 1);
    expect(landed.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS, orbitSlot: 2 });
    expect(landed.find((s) => s.id === 'aris-b')).toMatchObject({ planetId: ARIS, orbitSlot: 3 });

    // A record saved here for that slot is refused while the move is booked
    // (one mirrored from a peer stands where its own install put it).
    vi.useFakeTimers({ now: mid, toFake: ['Date'] });
    try {
      const squatter: StationRecord = { id: 'squat', name: 'SQUAT', planetId: ARIS, orbitSlot: 2, welcomeRoomId: 'sq' };
      expect(registerStation(squatter)).toBe(false);
      expect(registerStation({ ...squatter, orbitSlot: 4 })).toBe(true);
      expect(registerStation(squatter, { reservations: false })).toBe(true);
      // Saved there, it keeps its slot through a rename.
      expect(registerStation({ ...squatter, name: 'SQUATTER' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // With Furlong gone, Aris station A books Sovereign slot 0: a derived
    // station, which takes the lowest free slot there, passes over it, and
    // A finds it on arrival.
    const away = move;
    const inbound: StationMove = {
      ...away, stationId: 'aris-a', welcomeRoomId: 'a', fromPlanetId: ARIS, fromSlot: 1, toPlanetId: SOV, toSlot: 0,
      departAt: away.departAt + 1, arriveAt: away.arriveAt + 1000,
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? away : st.welcomeRoomId === 'a' ? inbound : null));
    const atlas = { 'd-room': { roomId: 'd-room', name: 'DERIVED', doors: {}, lastSeen: 0 } };
    const derivedAt = (t: number) => listStations(atlas, [winner], t).find((s) => s.derived);
    expect(derivedAt(away.departAt - 1)).toMatchObject({ planetId: SOV, orbitSlot: 1 });
    expect(derivedAt((away.departAt + away.arriveAt) / 2)).toMatchObject({ planetId: SOV, orbitSlot: 1 });
    const home = listStations(atlas, [winner], inbound.arriveAt + 1);
    expect(home.find((s) => s.id === 'aris-a')).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    expect(home.find((s) => s.derived)).toMatchObject({ planetId: SOV, orbitSlot: 1 });
  });

  it('counts the stations heard of around another planet where it picks a slot there', () => {
    const pending: StationMove = {
      ...moveTo(), stationId: 'k2', welcomeRoomId: 'k2', fromPlanetId: SOV, fromSlot: 5, toPlanetId: ARIS, toSlot: 2,
    };
    // Two Aris residents and a station on its way there, none listed here.
    const known: KnownPlace[] = [
      { welcomeRoomId: 'k0', planetId: ARIS, orbitSlot: 0 },
      { welcomeRoomId: 'k1', planetId: ARIS, orbitSlot: 1 },
      { welcomeRoomId: 'k2', planetId: SOV, orbitSlot: 5, move: pending },
    ];
    setKnownPlacesResolver(() => known);
    const listed = listStations({}, [], NOW);
    expect(listed.some((s) => s.planetId === ARIS)).toBe(false);
    expect(freeSlotAround(ARIS, listed, undefined, NOW)).toBe(3);
    const plan = planStationMove(ctx(), ARIS);
    expect(plan.ok && plan.move.toSlot).toBe(3);
    // One listed here counts where the list has it, not twice.
    const k0: StationRecord = { id: 'k0-rec', name: 'K0', planetId: ARIS, orbitSlot: 4, welcomeRoomId: 'k0' };
    expect(freeSlotAround(ARIS, listStations({}, [k0], NOW), undefined, NOW)).toBe(0);
    // A clash there settles with them as on an install that lists them: k0
    // keeps slot 0 by the global order, and the losers pass over the slot
    // k2 is booked into.
    const clash: StationRecord[] = [
      { id: 'x', name: 'X', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'x' },
      { id: 'y', name: 'Y', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'y' },
    ];
    const clashed = listStations({}, clash, NOW);
    expect(clashed.find((s) => s.id === 'x')).toMatchObject({ planetId: ARIS, orbitSlot: 3 });
    expect(clashed.find((s) => s.id === 'y')).toMatchObject({ planetId: ARIS, orbitSlot: 4 });
  });

  it('counts two stations heard of in one slot where the list settles them, in two', () => {
    setKnownPlacesResolver(() => [
      { welcomeRoomId: 'k0', planetId: ARIS, orbitSlot: 0 },
      { welcomeRoomId: 'k1', planetId: ARIS, orbitSlot: 0 },
    ]);
    const listed = listStations({}, [], NOW);
    expect(listed.some((s) => s.planetId === ARIS)).toBe(false);
    expect(knownSlotsAround(ARIS, listed.map((s) => s.welcomeRoomId), NOW)).toEqual({ taken: new Set([0, 1]), reserved: new Set() });
    expect(freeSlotAround(ARIS, listed, undefined, NOW)).toBe(2);
  });

  it('places a station whose rooms no record claims where its summary has it, by its welcome room', () => {
    // A learned station dropped once this install was at another planet: its
    // rooms are still in the atlas, and its summary says where it is. Its
    // welcome room is the room the atlas would derive it from, and then not.
    for (const [w, v] of [['a-room', 'b-room'], ['w-room', 'v-room']]) {
      const atlas: Record<string, AtlasEntry> = {
        [w]: { roomId: w, name: 'HUB', doors: { 'x+': { targetSeed: `ssf://room#room=${v}`, targetRoomId: v } }, lastSeen: 0 },
        [v]: { roomId: v, name: 'ANNEX', doors: {}, lastSeen: 0 },
      };
      const ofIt = (list: StationRecord[]) => list.filter((s) => s.welcomeRoomId === w || s.welcomeRoomId === v);
      // Never moved, around Aris: listed there once, its slot taken.
      setKnownPlacesResolver(() => [{ welcomeRoomId: w, planetId: ARIS, orbitSlot: 0 }]);
      let listed = listStations(atlas, [], NOW);
      expect(ofIt(listed)).toEqual([{ id: `station:${w}`, name: 'HUB', planetId: ARIS, orbitSlot: 0, welcomeRoomId: w, derived: true }]);
      expect(freeSlotAround(ARIS, listed, undefined, NOW)).toBe(1);
      // On its way there from Sovereign: the slot it is bound for stays booked.
      const inbound: StationMove = {
        ...moveTo(), stationId: 'hub', welcomeRoomId: w, fromPlanetId: SOV, fromSlot: 6, toPlanetId: ARIS, toSlot: 0,
      };
      setKnownPlacesResolver(() => [{ welcomeRoomId: w, planetId: SOV, orbitSlot: 6, move: inbound }]);
      setStationMoveResolver((st) => (st.welcomeRoomId === w ? inbound : null));
      listed = listStations(atlas, [], NOW);
      expect(ofIt(listed)).toEqual([expect.objectContaining({ id: `station:${w}`, planetId: SOV, orbitSlot: 6, move: inbound })]);
      expect(freeSlotAround(ARIS, listed, undefined, NOW)).toBe(1);
      setStationMoveResolver(null);
      // Two summaries naming its rooms, in either order: one station, the
      // same one everywhere (the first welcome room).
      const both: KnownPlace[] = [{ welcomeRoomId: v, planetId: ARIS, orbitSlot: 5 }, { welcomeRoomId: w, planetId: ARIS, orbitSlot: 0 }];
      const first = w < v ? both[1] : both[0];
      for (const order of [both, [...both].reverse()]) {
        setKnownPlacesResolver(() => order);
        expect(ofIt(listStations(atlas, [], NOW))).toEqual([expect.objectContaining({
          welcomeRoomId: first.welcomeRoomId, planetId: ARIS, orbitSlot: first.orbitSlot,
        })]);
      }
    }
  });

  it('holds the slot of a station heard of whose rooms it knows, by a welcome room too long to anchor one', () => {
    const w = 'w'.repeat(125);
    const atlas: Record<string, AtlasEntry> = {
      [w]: { roomId: w, name: 'HUB', doors: { 'x+': { targetSeed: 'ssf://room#room=v-room', targetRoomId: 'v-room' } }, lastSeen: 0 },
      'v-room': { roomId: 'v-room', name: 'ANNEX', doors: {}, lastSeen: 0 },
    };
    setKnownPlacesResolver(() => [{ welcomeRoomId: w, planetId: ARIS, orbitSlot: 0 }]);
    // `station:` and that room run past an id's length: heard of only, never
    // listed by it, and its slot still taken.
    const listed = listStations(atlas, [], NOW);
    expect(listed.some((s) => s.welcomeRoomId === w || s.planetId === ARIS)).toBe(false);
    expect(knownSlotsAround(ARIS, listed.map((s) => s.welcomeRoomId), NOW, atlas)).toEqual({ taken: new Set([0]), reserved: new Set() });
  });

  it('bounces an arrival off a planet it only knows is full from the summaries', () => {
    const move = { ...moveTo(), bookedAt: moveTo().departAt };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    setKnownPlacesResolver(() => Array.from({ length: 16 }, (_, i) => ({ welcomeRoomId: `k${i}`, planetId: ARIS, orbitSlot: i })));
    const listed = listStations({}, [], move.arriveAt + 1);
    expect(listed.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    expect(listed.filter((s) => s.planetId === ARIS)).toHaveLength(0);
  });

  it('counts each station where it was when an arrival got there, whatever pin it carries now', () => {
    const move = { ...moveTo(), bookedAt: moveTo().departAt };
    const T = move.arriveAt;
    // k0 held Aris slot 0 when this station got there, and left it for
    // Sovereign only later: a late install reads its arrival pin there.
    const left: StationMove = {
      stationId: 'k0', welcomeRoomId: 'k0', fromPlanetId: ARIS, fromSlot: 0, toPlanetId: SOV, toSlot: 5,
      departAt: T + 1000, arriveAt: T + 5000, mode: 'thrusters', bookedAt: T + 1000, fuel: 1, fuelDrawn: 1,
    };
    const pin: StationMove = {
      ...left, fromPlanetId: SOV, fromSlot: 5, departAt: left.arriveAt, arriveAt: left.arriveAt + 1,
      bookedAt: left.arriveAt + 10, settles: left, fuel: 0, fuelDrawn: 0,
    };
    // A tow of k0 leaving the moment this station got there, cancelled: k0
    // never left.
    const tow: StationMove = { ...left, mode: 'tug', tugRoomId: 'tug-room', departAt: T, bookedAt: T };
    const cancel: StationMove = {
      ...tow, mode: 'thrusters', tugRoomId: undefined, toPlanetId: ARIS, toSlot: 0, departAt: T + 1, arriveAt: T + 2,
      bookedAt: T + 10, settles: tow, fuel: 0, fuelDrawn: 0,
    };
    for (const k0 of [pin, cancel]) {
      store.clear();
      setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'k0' ? k0 : null));
      setKnownPlacesResolver(() => Array.from({ length: 16 }, (_, i) => ({ welcomeRoomId: `k${i}`, planetId: ARIS, orbitSlot: i })));
      const listed = listStations({}, [], pin.arriveAt + 1);
      expect(listed.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    }
    // k0 got to Aris that same moment, found it full and went home: from
    // then on its pin says where it is, never the planet it bounced off.
    const bounced: StationMove = { ...left, fromPlanetId: SOV, fromSlot: 5, toPlanetId: ARIS, toSlot: 0, departAt: move.departAt, arriveAt: T, bookedAt: move.departAt };
    const home: StationMove = {
      ...bounced, toPlanetId: SOV, toSlot: 5, departAt: T, arriveAt: T + 1, bookedAt: T + 10, settles: bounced, fuel: 0, fuelDrawn: 0,
    };
    store.clear();
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'k0' ? home : null));
    setKnownPlacesResolver(() => Array.from({ length: 16 }, (_, i) => ({ welcomeRoomId: `k${i}`, planetId: i ? ARIS : SOV, orbitSlot: i || 5 })));
    expect(listStations({}, [], T + 2).find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS });
  });

  it('counts a station whose pin leaves the moment an arrival gets there where the pin holds it', () => {
    const move = { ...moveTo(), bookedAt: moveTo().departAt };
    const T = move.arriveAt;
    // k0 got to Aris slot 0 that very moment, as its pin says; or a tow of
    // k0 left the moment before and was cancelled, the cancel leaving at T.
    // Either way k0 held Aris slot 0 when this station got there.
    const came: StationMove = {
      stationId: 'k0', welcomeRoomId: 'k0', fromPlanetId: SOV, fromSlot: 5, toPlanetId: ARIS, toSlot: 0,
      departAt: move.departAt, arriveAt: T, mode: 'thrusters', bookedAt: move.departAt, fuel: 1, fuelDrawn: 1,
    };
    const pin: StationMove = {
      ...came, fromPlanetId: ARIS, fromSlot: 0, departAt: T, arriveAt: T + 1, bookedAt: T + 10, settles: came, fuel: 0, fuelDrawn: 0,
    };
    const tow: StationMove = {
      ...came, fromPlanetId: ARIS, fromSlot: 0, toPlanetId: SOV, toSlot: 5, departAt: T - 1, arriveAt: T + 100_000,
      bookedAt: T - 1, mode: 'tug', tugRoomId: 'tug-room',
    };
    const cancel: StationMove = {
      ...tow, mode: 'thrusters', tugRoomId: undefined, toPlanetId: ARIS, toSlot: 0, departAt: T, arriveAt: T + 1,
      bookedAt: T + 10, settles: tow, fuel: 0, fuelDrawn: 0,
    };
    for (const k0 of [pin, cancel]) {
      store.clear();
      setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'k0' ? k0 : null));
      setKnownPlacesResolver(() => Array.from({ length: 16 }, (_, i) => ({ welcomeRoomId: `k${i}`, planetId: ARIS, orbitSlot: i })));
      // Aris was full: this station went home.
      expect(listStations({}, [], T + 2).find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    }
    // Neither pin is a station between planets, even for its millisecond.
    expect(stationInTransit({ move: pin }, T)).toBe(false);
    expect(stationInTransit({ move: cancel }, T)).toBe(false);
    expect(stationInTransit({ move: came }, T - 1)).toBe(true);
  });

  it('bounces an arrival with no slot to take, its own gone and the rest kept for arrivals on their way, when home has room', () => {
    const move = { ...moveTo(), bookedAt: moveTo().departAt };
    const T = move.arriveAt;
    // Another station bound for Aris slot 15, leaving after this one got there.
    const inbound: StationMove = {
      ...move, stationId: 'r', welcomeRoomId: 'r', fromPlanetId: SOV, fromSlot: 9, toSlot: 15,
      departAt: T + 1000, arriveAt: T + 100_000, bookedAt: T + 1000,
    };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'r' ? inbound : null));
    // Aris slots 0-14 held, slot 0 (the one this move booked) by a station
    // that did not know it was coming; with Sovereign full too, or not.
    const places = (homeFull: boolean, comingToo = true): KnownPlace[] => [
      ...Array.from({ length: 15 }, (_, i) => ({ welcomeRoomId: `k${i}`, planetId: ARIS, orbitSlot: i })),
      ...(comingToo ? [{ welcomeRoomId: 'r', planetId: SOV, orbitSlot: 9 }] : []),
      ...(homeFull ? Array.from({ length: 16 }, (_, i) => ({ welcomeRoomId: `h${i}`, planetId: SOV, orbitSlot: i })) : []),
    ];
    const furlong = (t: number) => listStations({}, [], t).find((s) => s.id === DEFAULT_STATION_ID);
    setKnownPlacesResolver(() => places(false));
    expect(furlong(T + 50_000)).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    // …for good: once the other has arrived too.
    expect(furlong(T + 200_000)).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    // With no room at home either, it shares the slot its move booked.
    store.clear();
    setKnownPlacesResolver(() => places(true));
    expect(furlong(T + 50_000)).toMatchObject({ planetId: ARIS, orbitSlot: 0 });
    // One settled at Aris stays there, whatever is kept there later.
    store.clear();
    setKnownPlacesResolver(() => places(false, false));
    expect(furlong(T + 50_000)).toMatchObject({ planetId: ARIS, orbitSlot: 15 });
    setKnownPlacesResolver(() => places(false));
    expect(furlong(T + 50_000)).toMatchObject({ planetId: ARIS });
  });

  it('refuses a record that would crowd a full planet, and leaves its arrival where it settled', () => {
    const move = { ...moveTo(), toSlot: 15, bookedAt: moveTo().departAt };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    setKnownPlacesResolver(() => Array.from({ length: 15 }, (_, i) => ({ welcomeRoomId: `k${i}`, planetId: ARIS, orbitSlot: i })));
    vi.useFakeTimers({ now: move.arriveAt + 60_000, toFake: ['Date'] });
    try {
      const newcomer: StationRecord = { id: 'newcomer', name: 'NEW', planetId: ARIS, orbitSlot: 15, welcomeRoomId: 'n-room' };
      // Not settled yet when the record is tried, too: only the list as it
      // stands settles it.
      expect(registerStation(newcomer, { reservations: false })).toBe(false);
      expect(registerStation(newcomer)).toBe(false);
      expect(listStations().find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS, orbitSlot: 15 });
      expect(listStations().some((s) => s.id === 'newcomer')).toBe(false);
      expect(registerStation({ ...newcomer, planetId: SOV, orbitSlot: 3 })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an arrival next to a station heard of as an install listing it does', () => {
    // Furlong books Aris slot 3; a station registered there since is listed
    // on one install and only heard of on another.
    const move = { ...moveTo(), toSlot: 3, bookedAt: moveTo().departAt };
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    const resident: StationRecord = { id: 'res', name: 'RES', planetId: ARIS, orbitSlot: 3, welcomeRoomId: 'res-room' };
    const after = move.arriveAt + 1;
    const listing = listStations({}, [resident, { ...resident, id: 'two', orbitSlot: 1, welcomeRoomId: 'two-room' }], after);
    expect(listing.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS, orbitSlot: 4 });
    store.clear();
    setKnownPlacesResolver(() => [
      { welcomeRoomId: 'res-room', planetId: ARIS, orbitSlot: 3 },
      { welcomeRoomId: 'two-room', planetId: ARIS, orbitSlot: 1 },
    ]);
    const heard = listStations({}, [], after);
    expect(heard.find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS, orbitSlot: 4 });
    expect(heard.some((s) => s.welcomeRoomId === 'res-room' || s.welcomeRoomId === 'two-room')).toBe(false);
  });

  it('keeps the last free slot for the station booked into it, over a clash loser and a derived station', () => {
    // Fourteen stations beside Furlong leave Sovereign slot 15 free, and a
    // station at Aris books it.
    const residents: StationRecord[] = Array.from({ length: 14 }, (_, i) => (
      { id: `sov-${i + 1}`, name: `S${i + 1}`, planetId: SOV, orbitSlot: i + 1, welcomeRoomId: `s${i + 1}` }));
    const aris: StationRecord = { id: 'aris-a', name: 'A', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'a' };
    const inbound: StationMove = {
      ...moveTo(), stationId: 'aris-a', welcomeRoomId: 'a', fromPlanetId: ARIS, fromSlot: 0, toPlanetId: SOV, toSlot: 15,
    };
    setStationMoveResolver((st) => (st.welcomeRoomId === 'a' ? inbound : null));
    const atlas = { 'd-room': { roomId: 'd-room', name: 'DERIVED', doors: {}, lastSeen: 0 } };
    const late: StationRecord = { id: 'late', name: 'LATE', planetId: SOV, orbitSlot: 1, welcomeRoomId: 'z-late' };
    // While it is on its way, neither a derived station nor a record that
    // loses a clash takes it: they go unlisted.
    for (const t of [inbound.departAt - 1, (inbound.departAt + inbound.arriveAt) / 2]) {
      const list = listStations(atlas, [...residents, aris, late], t);
      expect(list.some((s) => s.derived || s.id === 'late')).toBe(false);
      expect(list.filter((s) => s.planetId === SOV && s.orbitSlot === 15)).toEqual([]);
    }
    // It lands there.
    const landed = listStations(atlas, [...residents, aris, late], inbound.arriveAt + 1);
    expect(landed.find((s) => s.id === 'aris-a')).toMatchObject({ planetId: SOV, orbitSlot: 15 });
    expect(landed.some((s) => s.derived || s.id === 'late')).toBe(false);
  });

  it('shares where an arrival settled, so installs that judged it differently agree', () => {
    const move = { ...moveTo(), bookedAt: moveTo().departAt };
    const full: StationRecord[] = Array.from({ length: 16 }, (_, i) => (
      { id: `aris-${i}`, name: `A${i}`, planetId: ARIS, orbitSlot: i, welcomeRoomId: `a${i}` }));
    // This install saw Aris full: the station bounced home, and it pins that.
    bindStationMoveDoc(new Y.Doc());
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? readStationMove() ?? move : null));
    const t = move.arriveAt + 5;
    const here = listStations({}, full, t).find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(here).toMatchObject({ planetId: SOV });
    expect(pinSettledArrival(here, t)).toBe(true);
    const pin = readStationMove()!;
    expect(pin).toMatchObject({ fromPlanetId: SOV, toPlanetId: SOV, fromSlot: here.orbitSlot, departAt: move.arriveAt });
    expect(isPinMove(pin)).toBe(true);
    expect(isStationMove(pin)).toBe(true);
    // Another install knew no one at Aris and would have let it land; given
    // the pin (the station's latest move), it lists it home too.
    store.clear();
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? pin : null));
    expect(listStations({}, [], t + 1).find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: SOV });
    // A pinned station is not pinned again.
    expect(pinSettledArrival(here, t + 2)).toBe(false);
  });

  it('pins every listed station that arrived, aboard or not', () => {
    const move = { ...moveTo(), bookedAt: moveTo().departAt };
    const far: StationMove = { ...move, stationId: 'far', welcomeRoomId: 'far-room', fromSlot: 3, toSlot: 4 };
    const farRecord: StationRecord = { id: 'far', name: 'FAR', planetId: SOV, orbitSlot: 3, welcomeRoomId: 'far-room' };
    const t = move.arriveAt + 5;
    vi.useFakeTimers({ now: t, toFake: ['Date'] });
    try {
      bindStationMoveDoc(new Y.Doc());
      installStationMoveResolver();
      // This game's room belongs to neither station.
      expect(rememberMove(move, t)).toBe(true);
      expect(rememberMove(far, t)).toBe(true);
      expect(pinSettledArrivals(listStations({}, [farRecord], t), t)).toBe(2);
      const pins = readRememberedMoves().filter(isPinMove);
      expect(pins.map((p) => p.welcomeRoomId).sort()).toEqual([move.welcomeRoomId, 'far-room'].sort());
      expect(pinSettledArrivals(listStations({}, [farRecord], t + 1), t + 1)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets an unknown planet id share a slot with the planet it reads as', () => {
    const odd: StationMove = { ...moveTo(), stationId: 'odd', welcomeRoomId: 'o', toPlanetId: 'planet-unknown', toSlot: 0 };
    setStationMoveResolver((st) => (st.welcomeRoomId === 'o' ? odd : null));
    const rec: StationRecord = { id: 'odd', name: 'ODD', planetId: ARIS, orbitSlot: 3, welcomeRoomId: 'o' };
    const list = listStations({}, [rec], odd.arriveAt + 1);
    const taken = list.filter((s) => s.planetId === SOV).map((s) => s.orbitSlot);
    expect(new Set(taken).size).toBe(taken.length);
    expect(list.find((s) => s.id === 'odd')).toMatchObject({ planetId: SOV });
  });

  it('holds every dock of a station between planets, and only then', () => {
    const move = moveTo();
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : null));
    const room = DEFAULT_STATION_RECORD.welcomeRoomId;
    const mid = (move.departAt + move.arriveAt) / 2;
    expect(dockLockedByMove([room], move.departAt - 1)).toBe(false);
    expect(dockLockedByMove(['ship-room', room], mid)).toBe(true);
    expect(dockLockedByMove(['ship-room'], mid)).toBe(false);
    expect(dockLockedByMove([room], move.arriveAt)).toBe(false);
  });
});

describe('the record in the room doc and on this install', () => {
  it('writes the move to the room, remembers it, and lists the station moved from any room', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const move = moveTo();
    expect(writeStationMove(move)).toBe(true);
    expect(readStationMove()).toEqual(move);
    expect(readRememberedMoves()).toEqual([move]);
    // Another room's doc knows nothing, and the install still does.
    bindStationMoveDoc(new Y.Doc());
    expect(listStations({}, [], move.arriveAt + 1).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: ARIS });
  });

  it('keeps the latest move of every station the summaries can carry', () => {
    const move = moveTo();
    for (let i = 0; i < 64; i++) rememberMove({ ...move, stationId: `s${i}`, welcomeRoomId: `w${i}` });
    expect(readRememberedMoves()).toHaveLength(64);
  });

  it('refuses a move leaving or lasting past the horizon, wherever it comes from', () => {
    const move = moveTo();
    const far = { ...move, departAt: NOW + MOVE_HORIZON_MS + 1, arriveAt: NOW + MOVE_HORIZON_MS + 2 };
    expect(isPlausibleMove(move, NOW)).toBe(true);
    expect(isPlausibleMove(far, NOW)).toBe(false);
    expect(isPlausibleMove({ ...move, arriveAt: move.departAt + MOVE_HORIZON_MS + 1 }, NOW)).toBe(false);
    expect(rememberMove(far, NOW)).toBe(false);
    expect(readRememberedMoves()).toEqual([]);
    const summary = cleanStationSummary({ ...summaryForStation(ctx().station!, null, NOW), move: far }, NOW);
    expect(summary?.move).toBeUndefined();
  });

  it('remembers a move a peer wrote into the room', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const move = moveTo();
    doc.getMap('stationKeeping').set('move', move);
    expect(readRememberedMoves()).toEqual([move]);
  });

  it('ignores malformed moves and never lets an older one replace a newer', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    doc.getMap('stationKeeping').set('move', { stationId: 'x', mode: 'warp' });
    expect(readStationMove()).toBeNull();
    const move = moveTo();
    expect(rememberMove(move)).toBe(true);
    expect(rememberMove({ ...move, departAt: move.departAt - 10, toSlot: 3 })).toBe(false);
    expect(readRememberedMoves()).toEqual([move]);
  });

  it('draws the move\'s fuel through the tank\'s meter', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    bindStationMoveDoc(doc);
    writeFuelLevel(9_000, 10_000);
    // The room's first move: nothing drawn before it.
    const move = { ...moveTo(), fuelDrawn: moveTo().fuel };
    writeStationMove(move);
    expect(readMoveFuelDrawn()).toBe(move.fuel);
    expect(readFuelLevel()).toBe(9_000 - move.fuel);
  });

  it('a trim burn and a move started at once from two tabs both pay, whichever tab Yjs favours', () => {
    for (const [burner, mover] of [[900, 100], [100, 900]]) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = burner;
      b.clientID = mover;
      const bind = (doc: Y.Doc) => {
        bindShipDoc(doc);
        bindStationKeepingDoc(doc);
        bindStationMoveDoc(doc);
      };
      bind(a);
      writeFuelLevel(9_000, 10_000);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

      const c = ctx();
      const trim = planTrim({
        bolted: true, station: c.station, trim: readOrbitTrim(), commander: true, engines: 1,
        fuel: readFuelLevel(), now: NOW,
      }, 'raise');
      if (!trim.ok) throw new Error(trim.refusal);
      writeTrimBurn(trim.burn);
      bind(b);
      const plan = planStationMove(ctx({ fuel: readFuelLevel(), drawn: readMoveFuelDrawn(), deficit: fuelDrawDeficit('stationMove') }), ARIS);
      if (!plan.ok) throw new Error(plan.refusal);
      writeStationMove(plan.move);

      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(readFuelLevel()).toBe(9_000 - TRIM_FUEL - plan.move.fuel);
      bind(a);
      expect(readFuelLevel()).toBe(9_000 - TRIM_FUEL - plan.move.fuel);
    }
  });
});

describe('moves between installs', () => {
  const yard = (id: string): StationRecord => ({ id, name: 'YARD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'yard-lobby' });
  const yardMove = (): StationMove => {
    const stations = listStations({}, [yard('mine-1')], NOW);
    const plan = planStationMove(ctx({ station: stations.find((s) => s.id === 'mine-1')!, stations }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    return plan.move;
  };

  it('matches a move to the station by its welcome room, whatever id the writer used', () => {
    const move = yardMove();
    expect(move).toMatchObject({ stationId: 'mine-1', welcomeRoomId: 'yard-lobby' });
    rememberMove(move);
    installStationMoveResolver();
    // Another install knows the same station as a learned record.
    const there = listStations({}, [yard('shared:yard-lobby')], move.arriveAt + 1)
      .find((s) => s.id === 'shared:yard-lobby')!;
    expect(there).toMatchObject({ planetId: ARIS });
    // …and a different station with the writer's id is not moved.
    const other = { ...yard('mine-1'), welcomeRoomId: 'elsewhere' };
    expect(listStations({}, [other], move.arriveAt + 1).find((s) => s.id === 'mine-1'))
      .toMatchObject({ planetId: SOV });
  });

  it('rides the per-planet summary: published, merged by departure, learned on pull', () => {
    const move = yardMove();
    rememberMove(move);
    const station = listStations({}, [yard('mine-1')], NOW).find((s) => s.id === 'mine-1')!;
    const summary = summaryForStation(station, null, NOW);
    expect(summary.move).toEqual(move);
    expect(summary.ext).toBeUndefined();
    expect(cleanStationSummary(summary, NOW)?.move).toEqual(move);
    // A move for another room is not this summary's.
    expect(cleanStationSummary({ ...summary, move: { ...move, welcomeRoomId: 'x' } }, NOW)?.move).toBeUndefined();
    const later = { ...move, departAt: move.departAt + 1000, arriveAt: move.arriveAt + 1000 };
    expect(mergeStation(summary, { ...summary, move: later })?.move).toEqual(later);
    expect(mergeStation({ ...summary, move: later }, summary)).toBeNull();
    // Two moves leaving the same millisecond: one winner, whatever the order.
    const twin = { ...move, toSlot: move.toSlot + 1 };
    const winner = compareMoves(twin, move) > 0 ? twin : move;
    expect(mergeStation({ ...summary, move }, { ...summary, move: twin })?.move ?? move).toEqual(winner);
    expect(mergeStation({ ...summary, move: twin }, { ...summary, move })?.move ?? twin).toEqual(winner);

    // A second install pulls the summary from a room doc and learns the move.
    store.clear();
    const doc = new Y.Doc();
    doc.getMap('stationSummaries').set('yard-lobby', summary);
    bindPlanetSummaryDoc(doc, { currentStation: () => null, localTrim: () => null, ship: () => null });
    expect(readRememberedMoves()).toEqual([move]);
  });

  it('holds a dock at any room of a station a far room\'s summaries say is moving, and learns that move', () => {
    const move = yardMove();
    rememberMove(move);
    const summary = summaryForStation(listStations({}, [yard('mine-1')], NOW).find((s) => s.id === 'mine-1')!, null, NOW);
    expect(summary.move).toEqual(move);
    store.clear();
    // The berth's room: nothing booked there, the move only gossiped. Its
    // station is listed here, with the second room the ship docks at.
    const doc = new Y.Doc();
    doc.getMap('stationSummaries').set('yard-lobby', summary);
    store.set('ssf-station-atlas', JSON.stringify({
      'yard-lobby': { roomId: 'yard-lobby', name: 'LOBBY', doors: { 'x+': { targetSeed: 'ssf://room#room=yard-annex', targetRoomId: 'yard-annex' } }, lastSeen: 0 },
      'yard-annex': { roomId: 'yard-annex', name: 'ANNEX', doors: {}, lastSeen: 0 },
    }));
    expect(registerStation(yard('mine-1'))).toBe(true);
    const mid = Math.floor((move.departAt + move.arriveAt) / 2);
    expect(roomDocLockedByMove(doc, 'yard-annex', mid)).toBe(true);
    expect(roomDocLockedByMove(doc, 'yard-annex', move.departAt - 1)).toBe(false);
    expect(roomDocLockedByMove(doc, 'yard-annex', move.arriveAt)).toBe(false);
    expect(roomDocLockedByMove(new Y.Doc(), 'yard-annex', mid)).toBe(false);
    // Refused there, this install remembers it, and so carries it on.
    expect(readRememberedMoves()).toEqual([]);
    rememberMovesIn(doc);
    expect(readRememberedMoves()).toEqual([move]);
    expect(roomDocLockedByMove(new Y.Doc(), 'yard-annex', mid)).toBe(true);
  });

  it('carries a derived station\'s move although its first record stands', () => {
    const move = yardMove();
    const known = { ...summaryForStation(listStations({}, [yard('mine-1')], NOW).find((s) => s.id === 'mine-1')!, null, NOW - 60_000) };
    delete (known as { ownerId?: string }).ownerId;
    const later = { ...known, updatedAt: NOW, orbitSlot: known.orbitSlot + 1, move };
    const next = mergeStation(known, later)!;
    expect(next.orbitSlot).toBe(known.orbitSlot);
    expect(next.updatedAt).toBe(known.updatedAt);
    expect(next.move).toEqual(move);
  });

  it('freshens the summary\'s stamp when a move goes out, so the caps keep it', () => {
    const station = listStations({}, [yard('mine-1')], NOW).find((s) => s.id === 'mine-1')!;
    const known = summaryForStation(station, null, NOW - 60_000);
    const move = yardMove();
    rememberMove(move);
    const moving = listStations({}, [yard('mine-1')], NOW).find((s) => s.id === 'mine-1')!;
    const next = foldOwnStation(known, moving, null, NOW);
    expect(next?.move).toEqual(move);
    expect(next!.updatedAt).toBeGreaterThan(known.updatedAt);
  });
});

describe('tugs: a torch tow', () => {
  const towCtx = (over: Partial<TowContext> = {}): TowContext => {
    const stations = listStations({}, [], NOW);
    return {
      station: stations.find((s) => s.id === DEFAULT_STATION_ID)!,
      stations,
      tugRoomId: 'tug-room',
      commander: true,
      engines: TUG_MIN_ENGINES,
      fuel: 10_000,
      drawn: 3,
      deficit: 0,
      modules: 2,
      now: NOW,
      ...over,
    };
  };
  const angleGap = (a: number, b: number) => {
    const d = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.abs(d);
  };

  it('leaves at once and takes hours, not days, wherever the planets are', () => {
    for (let k = 0; k < 12; k++) {
      const t0 = NOW + k * 9 * 3_600_000;
      const plan = planTow(SOV, ARIS, t0)!;
      expect(plan.departAt).toBe(t0);
      const hours = plan.transferMs / 3_600_000;
      expect(hours).toBeGreaterThan(6);
      expect(hours).toBeLessThan(16);
      // Constant thrust: Δv = a·t, and the course is 2·√(d/a) long.
      const tS = (plan.transferMs / 1000) * 60;
      expect(plan.deltaVKmS).toBeCloseTo(TUG_ACCEL_KMS2 * tS, 0);
      expect(tS).toBeCloseTo(2 * Math.sqrt(plan.distanceKm / TUG_ACCEL_KMS2), -3);
    }
    expect(planTow(SOV, SOV, NOW)).toBeNull();
  });

  it('writes a tug move that starts at the old planet and ends on the new one', () => {
    const plan = planStationTow(towCtx(), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const move = plan.move;
    expect(move).toMatchObject({ mode: 'tug', tugRoomId: 'tug-room', departAt: NOW, fromPlanetId: SOV, toPlanetId: ARIS });
    expect(isStationMove(move)).toBe(true);
    expect(move.fuel).toBe(towFuelCost(plan.quote.plan.deltaVKmS, 2));
    expect(move.fuelDrawn).toBe(3 + move.fuel);
    const start = moveTransitPointAt(move, move.departAt + 1)!;
    const from = planetSunPointAt(SOV, move.departAt);
    expect(start.radiusKm / from.radiusKm).toBeCloseTo(1, 3);
    expect(angleGap(start.angle, from.angle)).toBeLessThan(1e-3);
    const end = towPointAt(move, move.arriveAt);
    const to = planetSunPointAt(ARIS, move.arriveAt);
    expect(end.radiusKm / to.radiusKm).toBeCloseTo(1, 6);
    expect(angleGap(end.angle, to.angle)).toBeLessThan(1e-6);
    expect(moveTransitPointAt(move, move.arriveAt)).toBeNull();
    expect(moveTransitPointAt({ ...move, toPlanetId: SOV }, move.departAt + 1)).toBeNull();
    // The station list follows the tow like any move.
    setStationMoveResolver(() => move);
    expect(stationInTransit(listStations({}, [], NOW + 1).find((s) => s.id === DEFAULT_STATION_ID)!, NOW + 1)).toBe(true);
    expect(listStations({}, [], move.arriveAt).find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS });
  });

  it('refuses a weak ship, a dry one, and a station already moving', () => {
    expect(planStationTow(towCtx({ station: null }), ARIS)).toMatchObject({ ok: false, refusal: 'not-docked' });
    expect(planStationTow(towCtx({ commander: false }), ARIS)).toMatchObject({ ok: false, refusal: 'not-commander' });
    expect(planStationTow(towCtx({ engines: TUG_MIN_ENGINES - 1 }), ARIS)).toMatchObject({ ok: false, refusal: 'too-weak' });
    expect(planStationTow(towCtx({ fuel: 1 }), ARIS)).toMatchObject({ ok: false, refusal: 'no-fuel' });
    expect(planStationTow(towCtx(), SOV)).toMatchObject({ ok: false, refusal: 'same-planet' });
    const busy = { ...towCtx().station!, move: moveTo() };
    expect(planStationTow(towCtx({ station: busy }), ARIS)).toMatchObject({ ok: false, refusal: 'moving' });
  });

  it('🚏 refuses while a ferry route runs on the tug (STOP it first)', () => {
    expect(planStationTow(towCtx({ routeRunning: true }), ARIS)).toMatchObject({ ok: false, refusal: 'route-running' });
    expect(planStationTow(towCtx({ routeRunning: false }), ARIS).ok).toBe(true);
    expect(describeTowRefusal('route-running', null, 0)).toMatch(/Stop the ferry route/);
  });

  it('keeps the tug\'s room on the record and holds that tug while it tows', () => {
    const plan = planStationTow(towCtx(), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    expect(isStationMove({ ...plan.move, tugRoomId: undefined })).toBe(false);
    expect(cleanMove(plan.move).tugRoomId).toBe('tug-room');
    expect(cleanMove(moveTo())).not.toHaveProperty('tugRoomId');
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(plan.move);
    expect(isTowing('tug-room', NOW + 1)).toBe(true);
    expect(isTowing('other-room', NOW + 1)).toBe(false);
    expect(isTowing('tug-room', plan.move.arriveAt)).toBe(false);
  });

  it('two moves written at once both land, and only the one that flies is paid for, everywhere', () => {
    const plan = planStationTow(towCtx(), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const a = plan.move;
    const b = { ...a, toSlot: a.toSlot + 1, fuel: a.fuel + 5 };
    const winner = compareMoves(a, b) > 0 ? a : b;
    const loser = winner === a ? b : a;
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    d1.clientID = 1; d2.clientID = 2;
    bindStationMoveDoc(d1);
    writeStationMove(a);
    bindStationMoveDoc(d2);
    writeStationMove(b);
    // Offline tabs meet.
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    for (const d of [d1, d2]) {
      store.clear();
      bindStationMoveDoc(d);
      expect(readStationMove()).toEqual(winner);
      expect(readMoveFuelDrawn()).toBe(winner.fuel);
      expect(isTowing('tug-room', NOW + 1)).toBe(true);
      expect(readRememberedMoves()).toEqual([winner]);
    }
    // A room holding only the loser (another room's doc wrote the winner)
    // neither tows nor pays once the winner is known here.
    store.clear();
    rememberMove(winner);
    const d3 = new Y.Doc();
    bindStationMoveDoc(d3);
    writeStationMove(loser);
    expect(readStationMove()).toBeNull();
    expect(readMoveFuelDrawn()).toBe(0);
  });

  it('charges one move written twice (two tabs, one millisecond) once', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    d1.clientID = 1; d2.clientID = 2;
    bindStationMoveDoc(d1);
    writeStationMove(plan.move);
    bindStationMoveDoc(d2);
    writeStationMove(plan.move);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
    bindStationMoveDoc(d1);
    expect(readMoveFuelDrawn()).toBe(plan.move.fuel);
  });

  it('cancels a tow whose tug flew off on a DEPART written at the same time', () => {
    const plan = planStationTow(towCtx(), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(plan.move);
    // Still docked: the tow stands.
    expect(cancelTowLeftBehind('tug-room', { status: 'docked' }, NOW + 1)).toBe(false);
    expect(isTowing('tug-room', NOW + 1)).toBe(true);
    // The tug is flying: the tow is cancelled, not flown, held or paid for.
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight' }, NOW + 1)).toBe(true);
    expect(isTowing('tug-room', NOW + 2)).toBe(false);
    expect(towHoldsDock(['tug-room'], NOW + 2)).toBe(false);
    expect(readMoveFuelDrawn()).toBe(0);
    const cancel = readStationMove()!;
    expect(cancel).toMatchObject({ mode: 'thrusters', toPlanetId: SOV, toSlot: plan.move.fromSlot, fuel: 0 });
    expect(isStationMove(cancel)).toBe(true);
    setStationMoveResolver(() => cancel);
    expect(listStations({}, [], NOW + 10).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: SOV, orbitSlot: plan.move.fromSlot });
    // Once is enough.
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight' }, NOW + 3)).toBe(false);
  });

  it('lets a cancelled tow kept in remembered history release the dock', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const plan = planStationTow(towCtx(), ARIS);
      if (!plan.ok) throw new Error(plan.refusal);
      bindStationMoveDoc(new Y.Doc());
      writeStationMove(plan.move);
      expect(towHoldsDock(['tug-room'], NOW + 1)).toBe(true);
      expect(cancelTowLeftBehind('tug-room', { status: 'in-flight' }, NOW + 1)).toBe(true);
      // The tow stays remembered as history beside its cancel, holding nothing.
      expect(readRememberedMoves().some((m) => m.mode === 'tug' && !m.settles)).toBe(true);
      expect(towHoldsDock(['tug-room'], NOW + 2)).toBe(false);
      // With another room bound, the remembered pair alone lets go too.
      bindStationMoveDoc(new Y.Doc());
      expect(towHoldsDock(['tug-room'], NOW + 2)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a move booked at the same time beat a tow that would have flown first', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const tow = plan.move;
    expect(tow.bookedAt).toBe(NOW);
    // Another tab booked the station's own thruster move at the same moment,
    // for a window days after the tow would have landed.
    const later: StationMove = {
      ...moveTo(), stationId: tow.stationId, welcomeRoomId: tow.welcomeRoomId,
      departAt: tow.arriveAt + 3 * 86_400_000, arriveAt: tow.arriveAt + 5 * 86_400_000, bookedAt: NOW,
    };
    expect(concurrentMoves(tow, later)).toBe(true);
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(tow);
    rememberMove(later, NOW);
    // The later move wins everywhere, so the tow holds nothing and costs nothing.
    expect(readStationMove()).toBeNull();
    expect(isTowing('tug-room', NOW + 1)).toBe(false);
    expect(readMoveFuelDrawn()).toBe(0);
    // A move booked after the tow landed is not concurrent: both fly.
    const next = { ...later, bookedAt: tow.arriveAt + 1 };
    expect(concurrentMoves(tow, next)).toBe(false);
    store.clear();
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(tow);
    rememberMove(next, NOW);
    expect(readMoveFuelDrawn()).toBe(tow.fuel);
  });

  it('still charges a move booked after a concurrent loser dropped out of the meter', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const lost = plan.move;
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(lost);
    expect(readMoveFuelDrawn()).toBe(lost.fuel);
    // A concurrent winner from another room: the tank had recorded the
    // loser's fuel, and the meter falls back below that reading.
    const winner: StationMove = { ...lost, toSlot: lost.toSlot + 1, departAt: lost.departAt + 1, arriveAt: lost.arriveAt + 1, tugRoomId: 'other-tug' };
    rememberMove(winner, NOW);
    expect(readMoveFuelDrawn()).toBe(0);
    // The next move books drawn 0 plus that deficit: the meter covers both.
    const next: StationMove = {
      ...moveTo(), stationId: 'yard', welcomeRoomId: 'yard-room', bookedAt: winner.arriveAt + 1,
      fuel: 50, fuelDrawn: 0 + lost.fuel + 50,
    };
    writeStationMove(next);
    expect(readMoveFuelDrawn()).toBe(lost.fuel + 50);
  });

  it('ranks a pin as the move it settles, so a losing move\'s pin loses too', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const lost = plan.move;
    const won: StationMove = { ...lost, toSlot: lost.toSlot + 1, departAt: lost.departAt + 1, arriveAt: lost.arriveAt + 1, tugRoomId: 'other-tug' };
    const pin: StationMove = {
      ...lost, fromPlanetId: ARIS, fromSlot: lost.toSlot, toPlanetId: ARIS, toSlot: lost.toSlot, mode: 'thrusters',
      tugRoomId: undefined, departAt: lost.arriveAt, arriveAt: lost.arriveAt + 1, bookedAt: lost.arriveAt + 5, fuel: 0, fuelDrawn: 0,
      settles: lost,
    };
    expect(isStationMove(cleanMove(pin))).toBe(true);
    expect(compareMoves(pin, lost)).toBeGreaterThan(0);
    expect(compareMoves(won, pin)).toBeGreaterThan(0);
    // Remembered in either order, the winner stands; the pin stays as
    // recent history, so what it could decide is still known.
    const station = { id: lost.stationId, welcomeRoomId: lost.welcomeRoomId };
    rememberMove(pin, lost.arriveAt + 10);
    rememberMove(won, lost.arriveAt + 10);
    expect(readRememberedMoves()).toEqual([cleanMove(won), cleanMove(pin)]);
    expect(rememberedMoveFor(station)).toEqual(cleanMove(won));
    store.clear();
    rememberMove(won, lost.arriveAt + 10);
    expect(rememberMove(pin, lost.arriveAt + 10)).toBe(true);
    expect(rememberMove(pin, lost.arriveAt + 10)).toBe(false);
    expect(rememberedMoveFor(station)).toEqual(cleanMove(won));
  });

  it('keeps a winner learned elsewhere after the station\'s next move, so its loser stays unpaid', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const t0 = Date.now() - 2 * 86_400_000;
    const at = (depart: number, booked: number, slot: number, fuel: number): StationMove => ({
      ...moveTo(), departAt: depart, arriveAt: depart + 3_600_000, bookedAt: booked, toSlot: slot, fuel, fuelDrawn: fuel,
    });
    const lost = at(t0, t0 - 1000, 3, 10);
    writeStationMove(lost);
    // Another room's concurrent move wins; this room's goes unpaid.
    const won = at(t0 + 1, t0 - 500, 4, 7);
    rememberMove(won);
    expect(readMoveFuelDrawn()).toBe(0);
    // The station's next move, booked after the winner arrived, is now its
    // latest: the loser stays beaten.
    rememberMove(at(t0 + 7_200_000, won.arriveAt + 1, 5, 2));
    expect(readMoveFuelDrawn()).toBe(0);
  });

  it('lets a cancel lose with its tow, and refuses a pin of an implausible move', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const tow = plan.move;
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(tow);
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight' }, NOW + 1)).toBe(true);
    const cancel = readStationMove()!;
    expect(cancel.settles).toEqual(cleanMove(tow));
    // A concurrent move leaving the same millisecond that beats the tow beats its cancel.
    const rival = [{ ...tow, toSlot: tow.toSlot + 1 }, { ...tow, toSlot: tow.toSlot + 2 }]
      .find((m) => compareMoves(m, tow) > 0)!;
    expect(compareMoves(rival, cancel)).toBeGreaterThan(0);
    // A pin wrapping a move decades away is refused like that move.
    const far = { ...tow, departAt: NOW + 20 * 365 * 86_400_000, arriveAt: NOW + 20 * 365 * 86_400_000 + 1000 };
    expect(isPlausibleMove({ ...cancel, settles: far }, NOW)).toBe(false);
    expect(isPlausibleMove(cancel, NOW)).toBe(true);
  });

  it('cancels a tow whose tug left mid-tow even when that shows up after the ETA, over any arrival pin', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const tow = plan.move;
    const after = tow.arriveAt + 60_000;
    // A partitioned replica saw the tow arrive and pinned it at Aris.
    const pin: StationMove = {
      ...tow, fromPlanetId: ARIS, fromSlot: tow.toSlot, toPlanetId: ARIS, mode: 'thrusters', tugRoomId: undefined,
      departAt: tow.arriveAt, arriveAt: tow.arriveAt + 1, bookedAt: tow.arriveAt + 10, fuel: 0, fuelDrawn: 0, settles: tow,
    };
    const d1 = new Y.Doc();
    d1.clientID = 1;
    bindStationMoveDoc(d1);
    writeStationMove(tow);
    writeStationMove(pin);
    expect(readStationMove()).toEqual(cleanMove(pin));
    // A tug that left after the tow ended is its own business.
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight', castOffAt: tow.arriveAt + 5 }, after)).toBe(false);
    // Its DEPART cast off an hour into the tow, learned only now.
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight', castOffAt: tow.departAt + 3_600_000 }, after)).toBe(true);
    const cancel = readStationMove()!;
    expect(isCancelPin(cancel)).toBe(true);
    expect(compareMoves(cancel, pin)).toBeGreaterThan(0);
    expect(readMoveFuelDrawn()).toBe(0);
    // Merged either way round with a replica holding only the pin, the cancel stands.
    const d2 = new Y.Doc();
    d2.clientID = 2;
    store.clear();
    bindStationMoveDoc(d2);
    writeStationMove(tow);
    writeStationMove(pin);
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    expect(readStationMove()).toEqual(cancel);
    setStationMoveResolver(() => readStationMove());
    expect(listStations({}, [], after).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: SOV, orbitSlot: tow.fromSlot });
    // Once cancelled, nothing more is written.
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight', castOffAt: tow.departAt + 3_600_000 }, after)).toBe(false);
  });

  it('draws a moving station on the holotable around its old planet, in flight, then around its new one', () => {
    setStationTrimResolver((st, slot) => (st.id === DEFAULT_STATION_ID
      ? { radiusKm: slot.radiusKm * 1.01, phase0: slot.phase0 + 0.3 } : null));
    try {
      const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
      if (!plan.ok) throw new Error(plan.refusal);
      for (const move of [moveTo(), plan.move]) {
        const home = stationBodies([DEFAULT_STATION_RECORD], NOW)[0];
        const moving = stationBodies([{ ...DEFAULT_STATION_RECORD, move }], NOW)[0];
        const place = moving.placeAt!;
        // Before the burn: where it always was, its trim included.
        const before = move.departAt - 1000;
        const p0 = place(before);
        expect(p0).toMatchObject({ parentId: SOV, radius: home.orbitRadius });
        expect(p0.angle).toBeCloseTo(home.angleAt!(before), 9);
        // Under way: on its course around the sun, a planet's distance out.
        const mid = (move.departAt + move.arriveAt) / 2;
        const p1 = place(mid);
        const course = moveTransitPointAt(move, mid)!;
        expect(p1.parentId).toBeUndefined();
        expect(p1.angle).toBeCloseTo(course.angle, 12);
        expect(p1.radius).toBeCloseTo((course.radiusKm / AU_KM) * 180, 9);
        // Arrived: around the new planet, in the slot it asked for.
        const there = stationBodies([{ ...DEFAULT_STATION_RECORD, planetId: ARIS, orbitSlot: move.toSlot }], NOW)[0];
        const p2 = place(move.arriveAt + 1000);
        expect(p2).toMatchObject({ parentId: ARIS, radius: there.orbitRadius });
        // Its course is drawn from the burn to arrival, and the marker rides
        // it: never farther from a point of it than two points are apart.
        expect(home.course).toBeUndefined();
        const drawn = moving.course!;
        expect(drawn.until).toBe(move.arriveAt);
        const xy = (p: { angle: number; radius: number }) => screenOffset(p.angle, p.radius);
        const apart = (a: { dx: number; dy: number }, b: { dx: number; dy: number }) => Math.hypot(a.dx - b.dx, a.dy - b.dy);
        const first = moveTransitPointAt(move, move.departAt)!;
        expect(apart(xy(drawn.points[0]), xy({ angle: first.angle, radius: (first.radiusKm / AU_KM) * 180 }))).toBeLessThan(1e-9);
        const gap = Math.max(...drawn.points.slice(1).map((p, i) => apart(xy(p), xy(drawn.points[i]))));
        expect(Math.min(...drawn.points.map((p) => apart(xy(p), xy(p1))))).toBeLessThanOrEqual(gap);
        // On screen while it is under way (or yet to leave), gone once there.
        expect(courseOnScreen(moving, mid, 100, 100, 1)).toHaveLength(drawn.points.length);
        expect(courseOnScreen(moving, before, 100, 100, 1)).toHaveLength(drawn.points.length);
        expect(courseOnScreen(moving, move.arriveAt, 100, 100, 1)).toEqual([]);
        // Built once it has arrived, it has none.
        expect(stationBodies([{ ...DEFAULT_STATION_RECORD, move }], move.arriveAt)[0].course).toBeUndefined();
      }
    } finally {
      setStationTrimResolver(null);
    }
  });

  it('cancels a tow whose tug let go of the station with its flight record still docked', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(plan.move);
    const docked = { status: 'docked' };
    // Still holding the station: nothing to do (and nothing when unknown).
    expect(cancelTowLeftBehind('tug-room', docked, NOW + 1, () => true)).toBe(false);
    expect(cancelTowLeftBehind('tug-room', docked, NOW + 1)).toBe(false);
    // Let go mid-tow: cancelled.
    expect(cancelTowLeftBehind('tug-room', docked, NOW + 2, (w) => w !== plan.move.welcomeRoomId)).toBe(true);
    expect(isCancelPin(readStationMove()!)).toBe(true);
    // After the tow arrived an undock is just an undock.
    store.clear();
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(plan.move);
    expect(cancelTowLeftBehind('tug-room', docked, plan.move.arriveAt + 1, () => false)).toBe(false);
    // …and one let go during the tow, learned of only after it arrived, is
    // judged by the UNDOCK's own stamp: cancelled. A release from before the
    // tow was booked is not this tow's.
    store.clear();
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(plan.move);
    const since: number[] = [];
    const releasedMidTow = (_w: string, from: number) => { since.push(from); return plan.move.departAt + 5; };
    expect(cancelTowLeftBehind('tug-room', docked, plan.move.arriveAt + 1, releasedMidTow)).toBe(true);
    expect(since[0]).toBe(plan.move.bookedAt ?? plan.move.departAt);
    expect(isCancelPin(readStationMove()!)).toBe(true);
    store.clear();
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(plan.move);
    expect(cancelTowLeftBehind('tug-room', docked, plan.move.arriveAt + 1, () => plan.move.arriveAt + 1)).toBe(false);
  });

  it('refuses a nest of pins at the first step', () => {
    const base = moveTo();
    let nest: Record<string, unknown> = { ...base };
    for (let k = 0; k < 100_000; k++) nest = { ...base, settles: nest };
    expect(isStationMove(nest)).toBe(false);
    expect(isStationMove({ ...pinOf(base), settles: { ...base } })).toBe(true);
  });

  it('refuses a move between two slots of one planet, an unknown planet read as the default one', () => {
    const base = moveTo();
    expect(base.fromPlanetId).toBe(SOV);
    expect(isStationMove({ ...base, toPlanetId: SOV, toSlot: base.fromSlot + 1 })).toBe(false);
    expect(isStationMove({ ...base, toPlanetId: 'planet-nowhere', toSlot: base.fromSlot + 1 })).toBe(false);
    expect(isStationMove({ ...base, toPlanetId: 'planet-nowhere', toSlot: base.fromSlot })).toBe(false);
    // Going nowhere, written as such, still reads.
    expect(isStationMove({ ...base, toPlanetId: SOV, toSlot: base.fromSlot })).toBe(true);
  });

  it('takes a pin only in the form one is written: an arrival as the move got there, a cancel of a tow as it left', () => {
    const move = moveTo();
    const arrived = pinOf(move);
    expect(isStationMove(arrived)).toBe(true);
    // At either end (home after a bounce), in any slot the list put it in.
    const home = { ...arrived, fromPlanetId: SOV, toPlanetId: SOV, fromSlot: 7, toSlot: 7 };
    expect(isStationMove(home)).toBe(true);
    // Never before the move got there, nor anywhere else, nor anything but
    // a zero-fuel millisecond in one place.
    expect(isStationMove({ ...arrived, departAt: move.arriveAt - 60_000, arriveAt: move.arriveAt - 59_999 })).toBe(false);
    expect(isStationMove({ ...arrived, departAt: move.arriveAt + 1, arriveAt: move.arriveAt + 2 })).toBe(false);
    const stay: StationMove = { ...move, toPlanetId: SOV, toSlot: move.fromSlot };
    expect(isStationMove(stay)).toBe(true);
    expect(isStationMove({ ...pinOf(stay), fromPlanetId: ARIS, toPlanetId: ARIS })).toBe(false);
    expect(isStationMove({ ...arrived, arriveAt: arrived.arriveAt + 1 })).toBe(false);
    expect(isStationMove({ ...arrived, fuel: 1 })).toBe(false);
    expect(isStationMove({ ...arrived, fuelDrawn: 1 })).toBe(false);
    expect(isStationMove({ ...arrived, toSlot: arrived.toSlot + 1 })).toBe(false);
    expect(isStationMove({ ...arrived, mode: 'tug', tugRoomId: 'tug-room' })).toBe(false);
    // A cancel: a tow's, the millisecond after it left, where it left from.
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const tow = plan.move;
    const cancel: StationMove = {
      ...tow, toPlanetId: tow.fromPlanetId, toSlot: tow.fromSlot, departAt: tow.departAt + 1, arriveAt: tow.departAt + 2,
      mode: 'thrusters', tugRoomId: undefined, bookedAt: tow.departAt + 10, settles: tow, fuel: 0, fuelDrawn: 0,
    };
    expect(isCancelPin(cancel)).toBe(true);
    expect(isStationMove(cancel)).toBe(true);
    expect(isStationMove({ ...cancel, settles: { ...tow, mode: 'thrusters', tugRoomId: undefined } })).toBe(false);
    expect(isStationMove({ ...cancel, departAt: tow.departAt + 2, arriveAt: tow.departAt + 3 })).toBe(false);
    expect(isStationMove({ ...cancel, fromPlanetId: tow.toPlanetId, toPlanetId: tow.toPlanetId })).toBe(false);
    expect(isStationMove({ ...cancel, fromSlot: tow.fromSlot + 1, toSlot: tow.fromSlot + 1 })).toBe(false);
  });

  it('refuses a move booked after it leaves: only a pin is written once what it records is over', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const tow = plan.move;
    // A peer's rival of that tow, leaving beside it but stamped as booked
    // once it landed: it would read as booked after it (concurrentMoves), so
    // neither would beat the other and both would be paid for.
    const rival: StationMove = {
      ...tow, toSlot: tow.toSlot + 1, tugRoomId: 'other-tug',
      departAt: tow.departAt + 1, arriveAt: tow.arriveAt + 1, bookedAt: tow.arriveAt + 1,
    };
    expect(concurrentMoves(tow, rival)).toBe(false);
    expect(isStationMove(rival)).toBe(false);
    expect(isStationMove({ ...rival, bookedAt: rival.departAt })).toBe(true);
    // One that goes nowhere (a pin) may be stamped later.
    expect(isStationMove({ ...rival, toPlanetId: rival.fromPlanetId, toSlot: rival.fromSlot })).toBe(true);
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    writeStationMove(tow);
    doc.getMap('stationMoves').set(`move:9:${rival.departAt}:${rival.welcomeRoomId}`, rival);
    expect(readMoveFuelDrawn()).toBe(tow.fuel);
    expect(readStationMove()).toEqual(cleanMove(tow));
  });

  it('cancels every tow a tug left behind, not only the latest', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const a = plan.move;
    // Two offline tabs of one tug each towed another station (the second
    // booked first, so the first outranks it).
    const b: StationMove = {
      ...a, stationId: 'yard', welcomeRoomId: 'yard-room', toSlot: a.toSlot + 1, departAt: a.departAt - 1, bookedAt: a.departAt - 1,
    };
    const d1 = new Y.Doc(); d1.clientID = 1;
    const d2 = new Y.Doc(); d2.clientID = 2;
    bindStationMoveDoc(d1);
    writeStationMove(a);
    bindStationMoveDoc(d2);
    writeStationMove(b);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
    store.clear();
    bindStationMoveDoc(d1);
    // One tug, one set of tanks: only the tow that ranks first is paid for.
    expect(readMoveFuelDrawn()).toBe(a.fuel);
    // Still docked to the first station only: the second tow is cancelled.
    const docked = { status: 'docked' };
    expect(cancelTowLeftBehind('tug-room', docked, NOW + 1, (w) => w === a.welcomeRoomId)).toBe(true);
    expect(readMoveFuelDrawn()).toBe(a.fuel);
    // The tow still under way holds the tug, whichever record sorts first,
    // with nothing remembered on this install.
    store.clear();
    expect(isTowing('tug-room', NOW + 1)).toBe(true);
    expect(towHoldsDock(['tug-room'], NOW + 1)).toBe(true);
    // The tug flies off: the first is cancelled too.
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight' }, NOW + 2)).toBe(true);
    expect(readMoveFuelDrawn()).toBe(0);
    expect(cancelTowLeftBehind('tug-room', { status: 'in-flight' }, NOW + 3)).toBe(false);
  });

  it('flies and pays for one of two tows a tug booked at once, and cancels the other', () => {
    // Two offline tabs of one tug, each seeing a full tank, each towed another
    // station: together they would draw more than the tanks hold.
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const a = plan.move;
    const b: StationMove = { ...a, stationId: 'yard', welcomeRoomId: 'yard-room', toSlot: a.toSlot + 1, departAt: a.departAt + 1, arriveAt: a.arriveAt + 1 };
    const d1 = new Y.Doc(); d1.clientID = 1;
    const d2 = new Y.Doc(); d2.clientID = 2;
    bindStationMoveDoc(d1);
    writeStationMove(a);
    bindStationMoveDoc(d2);
    writeStationMove(b);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
    store.clear();
    bindStationMoveDoc(d1);
    // The later departure outranks: only it stands and is paid for.
    expect(readMoveFuelDrawn()).toBe(b.fuel);
    expect(readStationMove()?.welcomeRoomId).toBe('yard-room');
    // Docked to both, the tug still spreads the loss as a cancel of the first,
    // once.
    const docked = { status: 'docked' };
    expect(cancelTowLeftBehind('tug-room', docked, NOW + 1)).toBe(true);
    expect(cancelTowLeftBehind('tug-room', docked, NOW + 2)).toBe(false);
    const cancel = rememberedMoveFor({ id: a.stationId, welcomeRoomId: a.welcomeRoomId });
    expect(cancel && isCancelPin(cancel)).toBe(true);
    expect(cancel?.settles?.welcomeRoomId).toBe(a.welcomeRoomId);
    expect(readMoveFuelDrawn()).toBe(b.fuel);
    // The winner still holds the tug.
    expect(isTowing('tug-room', NOW + 2)).toBe(true);
  });

  it('cancels an outbid tow the log has bundled past its cap', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const a = plan.move;
    const b: StationMove = { ...a, stationId: 'yard', welcomeRoomId: 'yard-room', toSlot: a.toSlot + 1, departAt: a.departAt + 1, arriveAt: a.arriveAt + 1 };
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    writeStationMove(b);
    // A sweep has moved the losing tow into a bundle.
    doc.getMap('stationMoves').set('moveFold:0:0000000000000000', { settled: {}, entries: { [`move:7:${a.departAt}:${a.stationId}`]: a } });
    store.clear();
    expect(readMoveFuelDrawn()).toBe(b.fuel);
    expect(cancelTowLeftBehind('tug-room', { status: 'docked' }, NOW + 1)).toBe(true);
    const cancel = rememberedMoveFor({ id: a.stationId, welcomeRoomId: a.welcomeRoomId });
    expect(cancel && isCancelPin(cancel)).toBe(true);
    expect(cancelTowLeftBehind('tug-room', { status: 'docked' }, NOW + 2)).toBe(false);
  });

  it('lists a station where it was while another station\'s tow by the same tug outranks its own', () => {
    bindStationMoveDoc(new Y.Doc());
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const a = plan.move;
    const b: StationMove = { ...a, stationId: 'yard', welcomeRoomId: 'yard-room', toSlot: a.toSlot + 1, departAt: a.departAt + 1, arriveAt: a.arriveAt + 1 };
    // Heard of both (planet summaries, say), and of no cancel yet.
    expect(rememberMove(a, NOW)).toBe(true);
    expect(rememberMove(b, NOW)).toBe(true);
    installStationMoveResolver();
    const mid = (b.departAt + b.arriveAt) / 2;
    const yard: StationRecord = { id: 'yard', name: 'YARD', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'yard-room' };
    const list = listStations({}, [yard], mid);
    expect(stationInTransit(list.find((s) => s.id === 'yard')!, mid)).toBe(true);
    const home = list.find((s) => s.id === DEFAULT_STATION_ID)!;
    expect(home).toMatchObject({ planetId: SOV, orbitSlot: 0 });
    expect(stationInTransit(home, mid)).toBe(false);
    expect(rememberedMoveFor({ id: a.stationId, welcomeRoomId: a.welcomeRoomId })).toBeNull();
  });

  it("leaves a station heard of where it was while another station's tow by the same tug outranks its own", () => {
    bindStationMoveDoc(new Y.Doc());
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    // The outbid tow is of a station this install only hears of.
    const a: StationMove = { ...plan.move, stationId: 'far', welcomeRoomId: 'far-room', fromSlot: 6 };
    const b: StationMove = { ...plan.move, stationId: 'yard', welcomeRoomId: 'yard-room', toSlot: a.toSlot + 1, departAt: a.departAt + 1, arriveAt: a.arriveAt + 1 };
    expect(rememberMove(a, NOW)).toBe(true);
    expect(rememberMove(b, NOW)).toBe(true);
    setKnownPlacesResolver(() => [{ welcomeRoomId: 'far-room', planetId: SOV, orbitSlot: 6, move: a }]);
    const mid = (b.departAt + b.arriveAt) / 2;
    // With no move resolver installed, its summary's move is all there is.
    expect(knownSlotsAround(ARIS, [], mid, {}).reserved.has(a.toSlot)).toBe(true);
    // The installed one has heard both tows and keeps the outbid one from
    // flying, as on an install that lists the station: it holds its slot at
    // home and books none at Aris.
    installStationMoveResolver();
    expect(rememberedMoveFor({ id: 'heard:far-room', welcomeRoomId: 'far-room' })).toBeNull();
    expect(knownSlotsAround(SOV, [], mid, {}).taken.has(6)).toBe(true);
    expect(knownSlotsAround(ARIS, [], mid, {}).reserved.has(a.toSlot)).toBe(false);
  });

  it('holds the tow\'s dock from either end, by the room record or a remembered move', () => {
    const plan = planStationTow(towCtx(), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    // The station's room: no move in its doc, but the install remembers it.
    bindStationMoveDoc(new Y.Doc());
    rememberMove(plan.move);
    expect(towHoldsDock(['station-room', 'tug-room'], NOW + 1)).toBe(true);
    expect(towHoldsDock(['station-room', 'other-room'], NOW + 1)).toBe(false);
    expect(towHoldsDock(['tug-room'], plan.move.arriveAt)).toBe(false);
  });

  it('refuses to price a tow of a station whose layout this ship cannot see', () => {
    expect(planStationTow(towCtx({ modules: 0 }), ARIS)).toMatchObject({ ok: false, refusal: 'unknown-layout', quote: null });
    expect(quoteTow(towCtx().station, towCtx().stations, ARIS, 0, NOW)).toBeNull();
    expect(quoteTow(towCtx().station, towCtx().stations, ARIS, 1, NOW)).not.toBeNull();
    expect(planStationTow(towCtx({ modules: 1 }), ARIS)).toMatchObject({ ok: true });
  });

  it('lets the winner\'s arrival pin keep beating the move its flight beat', () => {
    const plan = planStationTow(towCtx({ drawn: 0 }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    const a = plan.move;
    const b = { ...a, toSlot: a.toSlot + 1, fuel: a.fuel + 5, fuelDrawn: a.fuelDrawn + 5 };
    const winner = compareMoves(a, b) > 0 ? a : b;
    const loser = winner === a ? b : a;
    // The winner arrived and was pinned long after the loser would have
    // landed: the pin itself is not concurrent with the loser.
    const pin: StationMove = {
      ...winner, fromPlanetId: winner.toPlanetId, fromSlot: winner.toSlot, departAt: winner.arriveAt,
      arriveAt: winner.arriveAt + 1, mode: 'thrusters', tugRoomId: undefined, bookedAt: winner.arriveAt + 86_400_000,
      settles: winner, fuel: 0, fuelDrawn: 0,
    };
    expect(concurrentMoves(pin, loser)).toBe(false);
    // This install only remembers the pin (it replaced the winner).
    rememberMove(pin, NOW);
    expect(readRememberedMoves()).toEqual([cleanMove(pin)]);
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(loser);
    expect(readStationMove()).toBeNull();
    expect(readMoveFuelDrawn()).toBe(0);
    // A cancel of the winner beats the winner's arrival pin, too.
    const cancel: StationMove = {
      ...pin, fromPlanetId: winner.fromPlanetId, fromSlot: winner.fromSlot, toPlanetId: winner.fromPlanetId, toSlot: winner.fromSlot,
      departAt: winner.departAt + 1, arriveAt: winner.departAt + 2, bookedAt: NOW + 5,
    };
    expect(isCancelPin(cancel)).toBe(true);
    store.clear();
    bindStationMoveDoc(new Y.Doc());
    writeStationMove(winner);
    writeStationMove(pin);
    expect(readStationMove()).toEqual(cleanMove(pin));
    writeStationMove(cancel);
    expect(readStationMove()).toEqual(cleanMove(cancel));
    expect(readMoveFuelDrawn()).toBe(0);
  });
});

describe('the move log stays bounded', () => {
  const keys = (doc: Y.Doc) => [...doc.getMap('stationMoves').keys()];
  const hop = (k: number, fuel: number, drawn: number): StationMove => {
    const at = NOW + k * 10 * 86_400_000;
    return {
      stationId: 'yard', welcomeRoomId: 'yard-room', fromPlanetId: SOV, fromSlot: 2, toPlanetId: ARIS, toSlot: 3,
      departAt: at, arriveAt: at + 86_400_000, mode: 'thrusters', bookedAt: at - 1000, fuel, fuelDrawn: drawn,
    };
  };

  it('prunes moves that arrived long ago and keeps the meter where it was', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    let drawn = 0;
    for (let k = 0; k < 20; k++) {
      drawn += 10 + k;
      writeStationMove(hop(k, 10 + k, drawn));
      expect(readMoveFuelDrawn()).toBe(drawn);
    }
    // Every earlier move arrived days ago: only the one standing when the
    // last move was written, that move, and the settled total are left.
    expect(keys(doc).filter((k) => k.startsWith('move:'))).toHaveLength(2);
    expect(keys(doc).filter((k) => k.startsWith('moveSettled:'))).toHaveLength(1);
    expect(readStationMove()).toEqual(hop(19, 29, drawn));
    // A reload reads the same meter.
    const again = new Y.Doc();
    Y.applyUpdate(again, Y.encodeStateAsUpdate(doc));
    bindStationMoveDoc(again);
    expect(readMoveFuelDrawn()).toBe(drawn);
  });

  it('ignores a settled record that is malformed or past the meter\'s range, and clears it', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    writeStationMove(hop(0, 10, 10));
    const map = doc.getMap('stationMoves');
    map.set('moveSettled:9:1', { through: Date.now(), drawn: 0 });
    map.set('moveSettled:9:2', { n: 2, drawn: 1e15, floor: 0 });
    map.set('moveSettled:9:3', { n: 1.5, drawn: 3, floor: 0 });
    expect(readMoveFuelDrawn()).toBe(10);
    writeStationMove(hop(1, 5, 15));
    expect(readMoveFuelDrawn()).toBe(15);
    expect([...map.keys()].filter((k) => k.startsWith('moveSettled:9:'))).toEqual([]);
  });

  it('keeps every writer\'s settled fuel when two replicas prune at once', () => {
    // Writer 11 wrote three yard moves; replica B has only seen the first two.
    const x = new Y.Doc();
    x.clientID = 11;
    const xs = x.getMap('stationMoves');
    xs.set(`move:11:${hop(0, 0, 0).departAt}`, hop(0, 10, 10));
    xs.set(`move:11:${hop(1, 0, 0).departAt}`, hop(1, 20, 30));
    const early = Y.encodeStateAsUpdate(x);
    xs.set(`move:11:${hop(2, 0, 0).departAt}`, hop(2, 5, 35));
    const a = new Y.Doc(); a.clientID = 21; Y.applyUpdate(a, Y.encodeStateAsUpdate(x));
    const b = new Y.Doc(); b.clientID = 22; Y.applyUpdate(b, early);
    // Each books another station's move offline, pruning what it can.
    bindStationMoveDoc(a);
    writeStationMove({ ...hop(3, 7, 42), stationId: 'dock-a', welcomeRoomId: 'dock-a-room' });
    bindStationMoveDoc(b);
    writeStationMove({ ...hop(3, 7, 37), stationId: 'dock-b', welcomeRoomId: 'dock-b-room' });
    expect([...a.getMap('stationMoves').keys()]).toContain('moveSettled:11:2');
    expect([...b.getMap('stationMoves').keys()]).toContain('moveSettled:11:1');
    // They meet: the larger record covers the smaller, and nothing is lost.
    for (const [from, to] of [[a, b], [b, a], [x, a], [a, x]]) Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
    for (const d of [a, b, x]) Y.applyUpdate(d, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      store.clear();
      bindStationMoveDoc(d);
      expect(readMoveFuelDrawn()).toBe(10 + 20 + 5 + 7 + 7);
    }
    expect([...a.getMap('stationMoves').keys()].filter((k) => k.startsWith('move:11:'))).toEqual([`move:11:${hop(2, 0, 0).departAt}`]);
  });

  it('reads a bounded number of keys and clears junk a peer wrote', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    for (let i = 0; i < 1000; i++) map.set(`move:666:${i}`, { junk: i });
    expect(readMoveFuelDrawn()).toBe(0);
    // One write clears the whole flood: its own entry is read and paid for
    // at once, here and by a peer.
    writeStationMove(hop(0, 10, 10));
    expect([...map.keys()].filter((k) => k.startsWith('move:666:'))).toEqual([]);
    expect(readMoveFuelDrawn()).toBe(10);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    store.clear();
    bindStationMoveDoc(peer);
    expect(readStationMove()?.fuel).toBe(10);
  });

  it('keeps a write visible past a flood of well-formed entries a peer wrote', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    // Valid-looking moves of other stations, booked long ago.
    doc.transact(() => {
      for (let i = 0; i < 400; i++) {
        map.set(`move:666:${i}:s${i}`, { ...hop(0, 0, 0), stationId: `s${i}`, welcomeRoomId: `s${i}-room`, bookedAt: NOW - 10_000 - i });
      }
    });
    const mine = { ...hop(1, 9, 9), bookedAt: NOW + 5 };
    writeStationMove(mine);
    expect(map.size).toBeLessThanOrEqual(MOVE_SCAN_MAX);
    expect(readStationMove()).toEqual(mine);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    store.clear();
    bindStationMoveDoc(peer);
    expect(readStationMove()).toEqual(mine);
  });

  it('keeps every charge when a zero-fuel write caps the log', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    const zero = { ...hop(1, 0, 0), stationId: 'z', welcomeRoomId: 'z-room', bookedAt: NOW + 5 };
    // Settled records past the cap, each with a charge of its own.
    doc.transact(() => {
      for (let i = 0; i < MOVE_SETTLED_KEEP + 1; i++) map.set(`moveSettled:${100 + i}:1`, { n: 1, drawn: 1, floor: 1, recent: [] });
    });
    expect(readMoveFuelDrawn()).toBe(MOVE_SETTLED_KEEP + 1);
    writeStationMove(zero);
    expect([...map.keys()].filter((k) => k.startsWith('moveSettled:')).length).toBeLessThanOrEqual(MOVE_SETTLED_KEEP);
    expect(readMoveFuelDrawn()).toBe(MOVE_SETTLED_KEEP + 1);
    // Entries past the cap, each paid for, and still under way.
    const doc2 = new Y.Doc();
    bindStationMoveDoc(doc2);
    const map2 = doc2.getMap('stationMoves');
    const n = MOVE_ENTRIES_KEEP + 2;
    doc2.transact(() => {
      for (let i = 0; i < n; i++) {
        map2.set(`move:7:${i}:s${i}`, { ...hop(0, 1, 1), stationId: `s${i}`, welcomeRoomId: `s${i}-room`, bookedAt: NOW - 10_000 - i });
      }
    });
    expect(readMoveFuelDrawn()).toBe(n);
    writeStationMove(zero);
    expect([...map2.keys()].filter((k) => k.startsWith('move:')).length).toBeLessThanOrEqual(MOVE_ENTRIES_KEEP + 1);
    expect(readMoveFuelDrawn()).toBe(n);
    // A peer that folds the same surplus writes the same record: no double charge.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc2));
    store.clear();
    bindStationMoveDoc(peer);
    writeStationMove({ ...zero, departAt: zero.departAt + 1, arriveAt: zero.arriveAt + 1 });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(peer));
    expect(readMoveFuelDrawn()).toBe(n);
  });

  it('counts a record two replicas bundle at once only once', () => {
    const base = new Y.Doc();
    const baseMap = base.getMap('stationMoves');
    base.transact(() => {
      for (let i = 0; i < MOVE_SETTLED_KEEP + 2; i++) baseMap.set(`moveSettled:${100 + i}:1`, { n: 1, drawn: 1, floor: 1, recent: [] });
    });
    const zero = { ...hop(1, 0, 0), stationId: 'z', welcomeRoomId: 'z-room', bookedAt: NOW + 5 };
    // A bundles the two records past the cap; B, which also holds one more,
    // bundles three at the same time, two of them the same as A's.
    const a = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    bindStationMoveDoc(a);
    writeStationMove(zero);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
    b.getMap('stationMoves').set('moveSettled:099:1', { n: 1, drawn: 1, floor: 1, recent: [] });
    store.clear();
    bindStationMoveDoc(b);
    writeStationMove({ ...zero, departAt: zero.departAt + 1, arriveAt: zero.arriveAt + 1 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      store.clear();
      bindStationMoveDoc(d);
      expect(readMoveFuelDrawn()).toBe(MOVE_SETTLED_KEEP + 3);
    }
    // The next sweep joins the two replicas' bundles; nothing is lost or doubled.
    writeStationMove({ ...zero, departAt: zero.departAt + 2, arriveAt: zero.arriveAt + 2 });
    expect(readMoveFuelDrawn()).toBe(MOVE_SETTLED_KEEP + 3);
  });

  it('reads a bundle up to its cap and refuses one past it, however often it is read', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    const entries = (n: number, from: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [
      `move:9:${i}:b${from + i}`, { ...hop(0, 1, 1), stationId: `b${from + i}`, welcomeRoomId: `b${from + i}-room` },
    ]));
    map.set('moveFold:1:0000000000000001', { settled: {}, entries: entries(FOLD_ITEMS_MAX, 0) });
    map.set('moveFold:2:0000000000000002', { settled: {}, entries: entries(FOLD_ITEMS_MAX + 1, 100) });
    for (let pass = 0; pass < 2; pass++) {
      store.clear();
      bindStationMoveDoc(doc);
      expect(rememberedMoveFor({ id: 'b0', welcomeRoomId: 'b0-room' })).not.toBeNull();
      expect(rememberedMoveFor({ id: 'b100', welcomeRoomId: 'b100-room' })).toBeNull();
    }
    // The next write clears the one past the cap.
    writeStationMove(hop(1, 1, 1));
    expect(map.has('moveFold:2:0000000000000002')).toBe(false);
  });

  it('bundles entries under the longest keys a write makes, and still counts them', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    // The largest client id, a departure with four decimals, and a welcome
    // room as long as an id may be.
    const departAt = NOW + 0.2725;
    const n = MOVE_ENTRIES_KEEP + 2;
    const keys: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < n; i++) {
        const room = `${i}-`.padEnd(128, 'r');
        const key = `move:4294967295:${departAt}:${room}`;
        keys.push(key);
        map.set(key, { ...hop(0, 1, 1), stationId: `s${i}`, welcomeRoomId: room, departAt, bookedAt: NOW - 10_000 - i });
      }
    });
    expect(keys[0].length).toBeGreaterThan(160);
    expect(readMoveFuelDrawn()).toBe(n);
    writeStationMove({ ...hop(1, 0, 0), stationId: 'z', welcomeRoomId: 'z-room', bookedAt: NOW + 5 });
    expect([...map.keys()].some((k) => k.startsWith('moveFold:'))).toBe(true);
    expect(keys.filter((k) => map.has(k)).length).toBeLessThan(n);
    for (let pass = 0; pass < 2; pass++) {
      store.clear();
      bindStationMoveDoc(doc);
      expect(readMoveFuelDrawn()).toBe(n);
    }
  });

  it('clears a settled record without its recent list instead of failing a write', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    doc.transact(() => {
      for (let i = 0; i < MOVE_SETTLED_KEEP + 1; i++) map.set(`moveSettled:${100 + i}:1`, { n: 1, drawn: 0, floor: 0 });
    });
    expect(readMoveFuelDrawn()).toBe(0);
    expect(writeStationMove(hop(0, 10, 10))).toBe(true);
    expect([...map.keys()].filter((k) => k.startsWith('moveSettled:'))).toEqual([]);
    expect(readMoveFuelDrawn()).toBe(10);
  });

  it('finds a station\'s move in a bundle once the log outgrows its cap', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const doc = new Y.Doc();
      bindStationMoveDoc(doc);
      const map = doc.getMap('stationMoves');
      // The yard's move, booked first; then more moves still under way than
      // the log keeps at its top level, each of another station.
      const yard = { ...hop(0, 5, 5), bookedAt: NOW - 1_000_000 };
      writeStationMove(yard);
      doc.transact(() => {
        for (let i = 0; i < MOVE_ENTRIES_KEEP + 8; i++) {
          map.set(`move:666:${i}:o${i}`, { ...hop(0, 1, 1), stationId: `o${i}`, welcomeRoomId: `o${i}-room`, bookedAt: NOW - 1000 + i });
        }
      });
      // The next write's sweep bundles the yard's move.
      writeStationMove({ ...hop(0, 0, 0), stationId: 'other', welcomeRoomId: 'other-room', bookedAt: NOW });
      expect([...map.values()].some((v) => (v as StationMove).welcomeRoomId === 'yard-room')).toBe(false);
      // A fresh install reading this room still places the yard by it.
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      store.clear();
      bindStationMoveDoc(peer);
      expect(rememberedMoveFor({ id: 'yard', welcomeRoomId: 'yard-room' })).toEqual(yard);
      expect(readRememberedMoves().some((m) => m.welcomeRoomId === 'yard-room')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a flood of moves still under way, so a fresh install finds the move written after it', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout'] });
    try {
      const doc = new Y.Doc();
      bindStationMoveDoc(doc);
      const map = doc.getMap('stationMoves');
      doc.transact(() => {
        for (let i = 0; i < 3 * SWEEP_BATCH; i++) {
          map.set(`move:666:${i}:f${i}`, { ...hop(0, 1, 1), stationId: `f${i}`, welcomeRoomId: `f${i}-room`, bookedAt: NOW - 10_000 - i });
        }
      });
      const mine = { ...hop(0, 9, 9), departAt: NOW + 3_600_000, arriveAt: NOW + 25 * 3_600_000, bookedAt: NOW + 5 };
      expect(writeStationMove(mine)).toBe(true);
      vi.runAllTimers();
      expect(map.size).toBeLessThanOrEqual(MOVE_SCAN_MAX);
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      store.clear();
      bindStationMoveDoc(peer);
      expect(readStationMove()).toEqual(mine);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a flood bigger than one sweep over the turns that follow', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    doc.transact(() => {
      for (let i = 0; i < 3 * SWEEP_BATCH; i++) map.set(`junk:${i}`, i);
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      writeStationMove(hop(0, 10, 10));
      // The write itself walked one pass's worth (and its prune one scan).
      const left = [...map.keys()].filter((k) => k.startsWith('junk:')).length;
      expect(left).toBeGreaterThanOrEqual(2 * SWEEP_BATCH - MOVE_SCAN_MAX);
      expect(left).toBeLessThanOrEqual(2 * SWEEP_BATCH);
      vi.runAllTimers();
      expect([...map.keys()].filter((k) => k.startsWith('junk:'))).toEqual([]);
      expect(readMoveFuelDrawn()).toBe(10);
      expect(readStationMove()?.fuel).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the meter in range when several writers\' settled totals add past it', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const map = doc.getMap('stationMoves');
    map.set('moveSettled:1:1', { n: 1, drawn: FUEL_METER_MAX, floor: 0, recent: [] });
    map.set('moveSettled:2:1', { n: 1, drawn: FUEL_METER_MAX, floor: 0, recent: [] });
    expect(readMoveFuelDrawn()).toBe(FUEL_METER_MAX);
    // A move planned on top of it is still well-formed.
    const plan = planStationMove(ctx({ drawn: readMoveFuelDrawn() }), ARIS);
    if (!plan.ok) throw new Error(plan.refusal);
    expect(isStationMove(plan.move)).toBe(true);
  });

  it('takes back a recently pruned move\'s fuel when a rival learned late beats it', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const t0 = Date.now() - 3 * 86_400_000;
    const at = (depart: number, fuel: number, drawn: number, booked: number): StationMove => ({
      ...hop(0, fuel, drawn), departAt: depart, arriveAt: depart + 3_600_000, bookedAt: booked,
    });
    const m = at(t0, 10, 10, t0 - 1000);
    const next = at(t0 + 2 * 3_600_000, 5, 5, m.arriveAt + 600_000);
    writeStationMove(m);
    writeStationMove(next);
    writeStationMove({ ...at(t0 + 4 * 3_600_000, 7, 7, t0 + 3 * 3_600_000), stationId: 'dock', welcomeRoomId: 'dock-room' });
    const settled = [...doc.getMap('stationMoves').entries()].filter(([k]) => k.startsWith('moveSettled:'));
    expect(settled).toHaveLength(1);
    expect((settled[0][1] as { recent: StationMove[] }).recent).toEqual([m]);
    expect(readMoveFuelDrawn()).toBe(10 + 5 + 7);
    // An offline tab booked the station elsewhere at the same moment, and
    // wins; its entry reaches this room only now.
    const rival: StationMove = { ...m, departAt: m.departAt + 1, arriveAt: m.arriveAt + 1, toSlot: m.toSlot + 1, fuel: 3, fuelDrawn: 3 };
    expect(compareMoves(rival, m)).toBeGreaterThan(0);
    doc.getMap('stationMoves').set(`move:99:${rival.departAt}:yard-room`, rival);
    expect(readMoveFuelDrawn()).toBe(3 + 5 + 7);
  });

  it('pays once for a move two offline writers each settled, after it is final', () => {
    const DAY = 86_400_000;
    const t0 = Date.now();
    vi.useFakeTimers({ now: t0, toFake: ['Date'] });
    try {
      const move = (station: string, depart: number, fuel: number): StationMove => ({
        ...hop(0, fuel, fuel), stationId: station, welcomeRoomId: `${station}-room`,
        departAt: depart, arriveAt: depart + 3_600_000, bookedAt: depart - 1000,
      });
      // The same move, then a later one of its station, then one elsewhere
      // (whose write prunes the first), on two replicas that never met.
      const m = move('yard', t0 - 3 * DAY, 10);
      const n = move('yard', t0 - 2 * DAY, 5);
      const y = move('dock', t0 - 2 * DAY, 7);
      const replica = (id: number) => {
        const d = new Y.Doc(); d.clientID = id;
        bindStationMoveDoc(d);
        for (const x of [m, n, y]) writeStationMove(x);
        return d;
      };
      const d1 = replica(1);
      const d2 = replica(2);
      const recents = (d: Y.Doc) => [...d.getMap('stationMoves').entries()]
        .filter(([k]) => k.startsWith('moveSettled:')).map(([, v]) => (v as { recent: StationMove[] }).recent);
      expect(recents(d1)).toEqual([[m]]);
      expect(recents(d2)).toEqual([[m]]);
      Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
      store.clear();
      bindStationMoveDoc(d1);
      expect(readMoveFuelDrawn()).toBe(10 + 5 + 7);
      // A week on, both stations move again, and each writer's old entries
      // leave the log: the move both held becomes final once.
      vi.setSystemTime(t0 + 8 * DAY);
      writeStationMove(move('yard', t0 + 7 * DAY, 1));
      writeStationMove(move('dock', t0 + 7 * DAY, 2));
      writeStationMove(move('mill', t0 + 7 * DAY, 3));
      expect(recents(d1).flat()).toEqual([]);
      expect(readMoveFuelDrawn()).toBe(10 + 5 + 7 + 1 + 2 + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the fuel meter when a move learned elsewhere beats this room\'s', async () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const m = hop(0, 10, 10);
    writeStationMove(m);
    await Promise.resolve();
    expect(readMoveFuelDrawn()).toBe(10);
    let heard = 0;
    const off = subscribeStationMove(() => { heard++; });
    try {
      // A concurrent move of the same station that wins, learned from a
      // planet summary: this room's move goes unpaid, and the meter hears.
      const rival: StationMove = { ...m, departAt: m.departAt + 1, arriveAt: m.arriveAt + 1, toSlot: m.toSlot + 1 };
      expect(rememberMove(rival)).toBe(true);
      expect(heard).toBe(0);
      await Promise.resolve();
      expect(heard).toBe(1);
      expect(readMoveFuelDrawn()).toBe(0);
      // Nothing new: nothing heard.
      expect(rememberMove(rival)).toBe(false);
      await Promise.resolve();
      expect(heard).toBe(1);
    } finally {
      off();
    }
  });

  it('follows a move written here even when this install cannot store it', () => {
    const setItem = (globalThis as { localStorage: { setItem: unknown } }).localStorage.setItem;
    (globalThis as { localStorage: { setItem: unknown } }).localStorage.setItem = () => { throw new Error('full'); };
    try {
      installStationMoveResolver();
      bindStationMoveDoc(new Y.Doc());
      const move = moveTo();
      expect(writeStationMove(move)).toBe(true);
      expect(readRememberedMoves()).toEqual([]);
      expect(listStations({}, [], move.arriveAt + 1).find((s) => s.id === DEFAULT_STATION_ID)).toMatchObject({ planetId: ARIS });
    } finally {
      (globalThis as { localStorage: { setItem: unknown } }).localStorage.setItem = setItem;
    }
  });

  it('keeps a loser next to the move that beat it, so it stays unpaid', () => {
    const doc = new Y.Doc();
    bindStationMoveDoc(doc);
    const a = hop(0, 10, 10);
    const b = { ...a, departAt: a.departAt + 1, toSlot: 4, fuel: 15, fuelDrawn: 15 };
    writeStationMove(a);
    writeStationMove(b);
    const winner = compareMoves(a, b) > 0 ? a : b;
    expect(readMoveFuelDrawn()).toBe(winner.fuel);
    // A later move of another station prunes nothing the pair needs.
    writeStationMove({ ...hop(1, 7, winner.fuel + 7), stationId: 'dock', welcomeRoomId: 'dock-room' });
    expect(keys(doc).filter((k) => k.startsWith('move:'))).toHaveLength(3);
    expect(readMoveFuelDrawn()).toBe(winner.fuel + 7);
    // Once the yard has moved on, the old pair folds into the settled total
    // at the next write.
    writeStationMove(hop(2, 5, winner.fuel + 12));
    expect(keys(doc).filter((k) => k.startsWith('move:'))).toHaveLength(4);
    writeStationMove(hop(3, 4, winner.fuel + 16));
    const left = keys(doc).filter((k) => k.startsWith('move:')).map((k) => Number(k.split(':')[2]));
    expect(left.sort()).toEqual([hop(1, 0, 0).departAt, hop(2, 0, 0).departAt, hop(3, 0, 0).departAt]);
    expect(readMoveFuelDrawn()).toBe(winner.fuel + 16);
  });
});
