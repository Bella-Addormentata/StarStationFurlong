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
  summaryForStation,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import { planPlanetTransfer } from './solarOrbits';
import { FUEL_PER_KMS, planRecordHop } from './stationDirectory';
import { bindShipDoc, fuelDrawDeficit, readFuelLevel, writeFuelLevel } from './shipDoc';
import { TRIM_FUEL, bindStationKeepingDoc, planTrim, readOrbitTrim, writeOrbitTrim } from './stationKeeping';
import {
  bindStationMoveDoc,
  freeSlotAround,
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
import type { MoveContext, StationMove } from './stationMove';
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
    expect(planRecordHop(other, home, move.departAt - 1)).not.toBeNull();
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
    expect(readMoveFuelDrawn()).toBe(move.fuelDrawn);
    expect(readFuelLevel()).toBe(9_000 - move.fuelDrawn);
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
        fuel: readFuelLevel(), deficit: fuelDrawDeficit(), now: NOW,
      }, 'raise');
      if (!trim.ok) throw new Error(trim.refusal);
      writeOrbitTrim(trim.trim);
      bind(b);
      const plan = planStationMove(ctx({ fuel: readFuelLevel(), drawn: readMoveFuelDrawn(), deficit: fuelDrawDeficit() }), ARIS);
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

    // A second install pulls the summary from a room doc and learns the move.
    store.clear();
    const doc = new Y.Doc();
    doc.getMap('stationSummaries').set('yard-lobby', summary);
    bindPlanetSummaryDoc(doc, { currentStation: () => null, localTrim: () => null, ship: () => null });
    expect(readRememberedMoves()).toEqual([move]);
  });
});
