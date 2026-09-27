/**
 * 🚚 stationMove — a station leaving its planet for another under its own
 * thrusters: planning, the record, and how the station list follows it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ORBIT_EPOCH_MS } from './orbits';
import {
  bindPlanetSummaryDoc,
  cleanStationSummary,
  mergeStation,
  foldOwnStation,
  summaryForStation,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import { planPlanetTransfer, planetSunPointAt } from './solarOrbits';
import { FUEL_PER_KMS, planRecordHop } from './stationDirectory';
import { bindShipDoc, fuelDrawDeficit, readFuelLevel, writeFuelLevel } from './shipDoc';
import { TRIM_FUEL, bindStationKeepingDoc, planTrim, readOrbitTrim, writeTrimBurn } from './stationKeeping';
import {
  TUG_ACCEL_KMS2,
  TUG_MIN_ENGINES,
  MOVE_HORIZON_MS,
  bindStationMoveDoc,
  cancelTowLeftBehind,
  concurrentMoves,
  isPinMove,
  pinSettledArrival,
  isPlausibleMove,
  compareMoves,
  dockLockedByMove,
  cleanMove,
  freeSlotAround,
  isTowing,
  moveTransitPointAt,
  planStationTow,
  planTow,
  towFuelCost,
  towPointAt,
  towHoldsDock,
  installStationMoveResolver,
  isStationMove,
  movePhase,
  moveFuelCost,
  planStationMove,
  readMoveFuelDrawn,
  readRememberedMoves,
  readStationMove,
  rememberMove,
  writeStationMove,
} from './stationMove';
import type { MoveContext, StationMove, TowContext } from './stationMove';
import {
  DEFAULT_STATION_ID,
  DEFAULT_STATION_RECORD,
  listStations,
  setStationMoveResolver,
  stationInTransit,
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
const ARIS = 'planet-aris';
const NOW = ORBIT_EPOCH_MS + 5_000_000_000;

beforeEach(() => store.clear());
afterEach(() => { setStationMoveResolver(null); unbindPlanetSummaryForTest(); });

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
    setStationMoveResolver((st) => (st.id === DEFAULT_STATION_ID ? move : st.welcomeRoomId === 'a15' ? left : null));
    expect(listStations({}, full, move.arriveAt + 2).find((s) => s.id === DEFAULT_STATION_ID))
      .toMatchObject({ planetId: SOV });
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
    const move = moveTo();
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
    const plan = planStationTow(towCtx(), ARIS);
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
    expect(cancelTowLeftBehind('tug-room', 'docked', NOW + 1)).toBe(false);
    expect(isTowing('tug-room', NOW + 1)).toBe(true);
    // The tug is flying: the tow is cancelled, not flown, held or paid for.
    expect(cancelTowLeftBehind('tug-room', 'in-flight', NOW + 1)).toBe(true);
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
    expect(cancelTowLeftBehind('tug-room', 'in-flight', NOW + 3)).toBe(false);
  });

  it('lets a move booked at the same time beat a tow that would have flown first', () => {
    const plan = planStationTow(towCtx(), ARIS);
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
});
