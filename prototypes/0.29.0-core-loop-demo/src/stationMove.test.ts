/**
 * 🚚 stationMove — a station leaving its planet for another under its own
 * thrusters: planning, the record, and how the station list follows it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ORBIT_EPOCH_MS } from './orbits';
import { planPlanetTransfer } from './solarOrbits';
import { FUEL_PER_KMS, planRecordHop } from './stationDirectory';
import { bindStationKeepingDoc, readFuelDrawn } from './stationKeeping';
import {
  bindStationMoveDoc,
  freeSlotAround,
  installStationMoveResolver,
  isStationMove,
  movePhase,
  moveFuelCost,
  planStationMove,
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
afterEach(() => setStationMoveResolver(null));

const ctx = (over: Partial<MoveContext> = {}): MoveContext => {
  const stations = listStations({}, [], NOW);
  return {
    bolted: true,
    station: stations.find((s) => s.id === DEFAULT_STATION_ID)!,
    stations,
    commander: true,
    engines: 2,
    fuel: 10_000,
    meter: 7,
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
    setStationMoveResolver((id) => (id === move.stationId ? move : null));
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
    setStationMoveResolver((id) => (id === move.stationId ? move : null));
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
    bindStationKeepingDoc(doc);
    bindStationMoveDoc(doc);
    const move = moveTo();
    writeStationMove(move);
    expect(readFuelDrawn()).toBe(move.fuelDrawn);
  });
});
