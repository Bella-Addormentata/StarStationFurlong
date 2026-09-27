/**
 * 🚏📋 Departures — a stop room's mirror of each ferry's route and
 * checkpoints (build notes A6): the key codec, the route entry's guard
 * (never a pass), the far writer's decision in one transaction (newest route
 * entry, one key per event with the newer observation kept, other runs gone,
 * the timetable's own pruning, the ferry cap), the reader's checks, the
 * publish order (the stop concerned first), and the board's gate setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  DEPARTURES_MAP,
  MAX_DEPARTURE_FERRIES,
  applyDeparturesPublish,
  bindDeparturesDoc,
  boardGate,
  boardSettingFromWire,
  departureCheckpointKey,
  departureFerriesIn,
  departureRouteFromWire,
  departureRouteKey,
  departureRouteNewer,
  departureRouteToWire,
  parseDepartureKey,
  publishRoomOrder,
  readBoardSetting,
  readDepartureFerries,
  writeBoardSetting,
} from './departuresDoc';
import type { DeparturesPublish } from './departuresDoc';
import {
  dockCheckpoint,
  holdCheckpoint,
  renewedHold,
  skipCheckpoint,
  startCheckpoint,
  stopAt,
} from './pilotRoute';
import { routeToWire } from './shipRoute';
import type { RouteCheckpoint, RouteStop, ShipRoute, StartCheckpoint } from './shipRoute';

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const SHIP = 'ship-room-1';

function stop(i: number, slot: number): RouteStop {
  return {
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    berth: { roomId: `room-${i}`, farDoor: 'x+', gate: i + 1, anyGate: true },
    waitSecs: 60,
  };
}

function running(slots: number[] = [0, 1], run = T0, over: Partial<ShipRoute> = {}): ShipRoute {
  return {
    stops: slots.map((s, i) => stop(i, s)),
    shape: 'backAndForth',
    shipPort: 'x-',
    robotDockId: 'dock-1',
    startedAt: run,
    startStop: 0,
    ...over,
  };
}

function start(route: ShipRoute): StartCheckpoint {
  return startCheckpoint(route, { at: route.startedAt!, pilot: 'robot', fuel: 100 })!;
}

function pub(route: ShipRoute, checkpoints: RouteCheckpoint[], at = T0, over: Partial<DeparturesPublish> = {}): DeparturesPublish {
  return { shipRoomId: SHIP, name: 'Ferry One', capacity: 100, route, checkpoints, at, ...over };
}

function keys(doc: Y.Doc): string[] {
  return [...doc.getMap(DEPARTURES_MAP).keys()].sort();
}

function countUpdates(doc: Y.Doc): { readonly n: number } {
  const c = { n: 0 };
  doc.on('update', () => { c.n++; });
  return c;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('departures keys', () => {
  it('the route and each checkpoint sit behind the ferry’s ship room id, and parse back', () => {
    expect(departureRouteKey(SHIP)).toBe('ship-room-1:route');
    expect(parseDepartureKey('ship-room-1:route')).toEqual({ ship: SHIP, kind: 'route' });
    const k = departureCheckpointKey(SHIP, T0, 3, 'hold');
    expect(k).toBe(`ship-room-1:ckpt:${T0}:3:hold`);
    expect(parseDepartureKey(k)).toEqual({ ship: SHIP, kind: 'ckpt', run: T0, legSeq: 3, ckpt: 'hold' });
  });

  it('refuses keys it can’t read back unambiguously', () => {
    for (const bad of [
      'route', ':route', `:ckpt:${T0}:0:start`, `a:ckpt:b:ckpt:${T0}:0:start`, `${SHIP}:ckpt:${T0}:0:teleport`,
      `${SHIP}:ckpt:0${T0}:0:start`, `${'r'.repeat(129)}:route`, `${SHIP}:routes`, 42, null,
    ]) {
      expect(parseDepartureKey(bad)).toBeNull();
    }
  });
});

describe('the route entry', () => {
  it('round-trips, and never carries a pass', () => {
    const route = running();
    const wire = departureRouteToWire({ shipRoomId: SHIP, name: 'Ferry One', capacity: 100, route, at: T0 });
    expect(departureRouteFromWire(wire, SHIP)).toEqual({ shipRoomId: SHIP, name: 'Ferry One', capacity: 100, route, at: T0 });
    // An extra field (a pass smuggled beside the route) is not kept.
    const smuggled = { ...wire, pass: 'secret', route: { ...(wire.route as object), seed: 'secret' } };
    expect(JSON.stringify(departureRouteFromWire(smuggled, SHIP))).not.toContain('secret');
    // A berth carrying an address is no route at all.
    const withAddress = JSON.parse(JSON.stringify(wire));
    withAddress.route.stops[0].berth.address = { roomId: 'room-0', pass: 'secret' };
    expect(departureRouteFromWire(withAddress, SHIP)).toBeNull();
  });

  it('is checked: its key’s ship, a name, a capacity, a time, a route', () => {
    const wire = departureRouteToWire({ shipRoomId: SHIP, name: 'Ferry One', capacity: 100, route: running(), at: T0 });
    expect(departureRouteFromWire(wire, 'another-ship')).toBeNull();
    for (const bad of [
      { ...wire, name: '' }, { ...wire, name: 'n'.repeat(65) }, { ...wire, capacity: -1 }, { ...wire, capacity: Number.NaN },
      { ...wire, at: Number.POSITIVE_INFINITY }, { ...wire, route: { ...(wire.route as object), shape: 'spiral' } }, null, [wire],
    ]) {
      expect(departureRouteFromWire(bad, SHIP)).toBeNull();
    }
  });

  it('newest wins: a newer START always, STOP within a run, else the later publish', () => {
    const a = { route: running([0, 1], T0), at: T0 + 10 * MIN };
    const b = { route: running([0, 1], T0 + MIN), at: T0 };
    expect(departureRouteNewer(b, a)).toBe(true);
    expect(departureRouteNewer(a, b)).toBe(false);
    const stopped = { route: { ...a.route, stoppedAt: T0 + MIN }, at: T0 };
    expect(departureRouteNewer(stopped, a)).toBe(true);
    expect(departureRouteNewer(a, stopped)).toBe(false);
    const finished = { route: { ...a.route, startedAt: undefined, startStop: undefined }, at: T0 + 20 * MIN };
    expect(departureRouteNewer(finished, a)).toBe(true);
    expect(departureRouteNewer({ ...a, at: a.at }, a)).toBe(false);
  });

  it('🏁 a finish naming its run beats every snapshot of that run, whatever the clocks say', () => {
    const run = running([0, 1], T0);
    const { startedAt: _s, startStop: _p, ...idle } = run;
    const finish = { route: idle, at: T0 + 20 * MIN, endedRun: T0 };
    // A rider's running snapshot of that run, stamped LATER (clock skew).
    const late = { route: run, at: T0 + 25 * MIN };
    const lateStopped = { route: { ...run, stoppedAt: T0 + 19 * MIN }, at: T0 + 25 * MIN };
    expect(departureRouteNewer(late, finish)).toBe(false);
    expect(departureRouteNewer(lateStopped, finish)).toBe(false);
    expect(departureRouteNewer(finish, late)).toBe(true);
    // A newer START beats it; an older run's snapshot never does.
    const next = { route: running([0, 1], T0 + 30 * MIN), at: T0 + 10 * MIN };
    expect(departureRouteNewer(next, finish)).toBe(true);
    expect(departureRouteNewer(finish, next)).toBe(false);
    expect(departureRouteNewer({ route: running([0, 1], T0 - MIN), at: T0 + 40 * MIN }, finish)).toBe(false);
    // Two finishes: the later run's.
    expect(departureRouteNewer({ ...finish, endedRun: T0 + MIN, at: T0 }, finish)).toBe(true);
    // It round-trips, only on a route with no run.
    const wire = departureRouteToWire({ shipRoomId: SHIP, name: 'F', capacity: 100, ...finish });
    expect(departureRouteFromWire(wire, SHIP)?.endedRun).toBe(T0);
    expect(departureRouteToWire({ shipRoomId: SHIP, name: 'F', capacity: 100, route: run, at: T0, endedRun: T0 })).not.toHaveProperty('endedRun');
    expect(departureRouteFromWire({ ...wire, endedRun: 'x' }, SHIP)).not.toHaveProperty('endedRun');
  });
});

describe('a publish applied to a stop room', () => {
  it('START writes the ferry’s route and its start entry, in one transaction', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    const updates = countUpdates(doc);
    expect(applyDeparturesPublish(doc, pub(route, [s]), T0).wrote).toBe(true);
    expect(updates.n).toBe(1);
    expect(keys(doc)).toEqual([departureCheckpointKey(SHIP, T0, 0, 'start'), departureRouteKey(SHIP)].sort());
    const [f] = departureFerriesIn(doc.getMap(DEPARTURES_MAP));
    expect(f).toMatchObject({ shipRoomId: SHIP, name: 'Ferry One', capacity: 100, route, at: T0 });
    expect(f.checkpoints).toEqual([s]);
    // The same news again writes nothing.
    expect(applyDeparturesPublish(doc, pub(route, [s]), T0).wrote).toBe(false);
    expect(updates.n).toBe(1);
  });

  it('merges one key per event: a lagging publish never puts an older sighting over a newer one', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + SEC });
    applyDeparturesPublish(doc, pub(route, [s, renewedHold(hold, hold.at + 2 * MIN)], T0 + 3 * MIN), s.arriveAt + 3 * MIN);
    // An older snapshot (it saw only the first sighting) arrives late.
    expect(applyDeparturesPublish(doc, pub(route, [s, hold], T0 + MIN), s.arriveAt + 3 * MIN).wrote).toBe(false);
    const [f] = departureFerriesIn(doc.getMap(DEPARTURES_MAP));
    expect(f.at).toBe(T0 + 3 * MIN);
    expect(f.checkpoints.find((e) => e.kind === 'hold')).toMatchObject({ seenAt: hold.at + 2 * MIN });
  });

  it('a lagging publisher still adds an entry the room lacks (its own run only)', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    applyDeparturesPublish(doc, pub(route, [s], T0 + 5 * MIN), s.arriveAt);
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + SEC });
    expect(applyDeparturesPublish(doc, pub(route, [s, hold], T0 + MIN), s.arriveAt + 2 * SEC).wrote).toBe(true);
    expect(departureFerriesIn(doc.getMap(DEPARTURES_MAP))[0].checkpoints.map((e) => e.kind)).toEqual(['start', 'hold']);
    // An older run's publish adds nothing.
    const old = running([0, 1], T0 - 60 * MIN);
    expect(applyDeparturesPublish(doc, pub(old, [start(old)], T0 + 9 * MIN), s.arriveAt).wrote).toBe(false);
  });

  it('a new START takes every key of the old run with it', () => {
    const doc = new Y.Doc();
    const route = running();
    applyDeparturesPublish(doc, pub(route, [start(route)]), T0);
    const next = running([0, 1], T0 + 30 * MIN);
    expect(applyDeparturesPublish(doc, pub(next, [start(next)], T0 + 30 * MIN), T0 + 30 * MIN).wrote).toBe(true);
    expect(keys(doc)).toEqual([departureCheckpointKey(SHIP, T0 + 30 * MIN, 0, 'start'), departureRouteKey(SHIP)].sort());
  });

  it('a finished route stays listed but running no more, its checkpoints gone', () => {
    const doc = new Y.Doc();
    const route = running();
    applyDeparturesPublish(doc, pub(route, [start(route)]), T0);
    const { startedAt: _s, startStop: _p, ...finished } = route;
    expect(applyDeparturesPublish(doc, pub(finished, [], T0 + 20 * MIN), T0 + 20 * MIN).wrote).toBe(true);
    expect(keys(doc)).toEqual([departureRouteKey(SHIP)]);
    const [f] = departureFerriesIn(doc.getMap(DEPARTURES_MAP));
    expect(f.route.startedAt).toBeUndefined();
    expect(f.checkpoints).toEqual([]);
  });

  it('🏁 a late running snapshot never puts a finished ferry back on the board', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    applyDeparturesPublish(doc, pub(route, [s], T0), T0);
    const { startedAt: _s, startStop: _p, ...finished } = route;
    expect(applyDeparturesPublish(doc, pub(finished, [], T0 + 20 * MIN, { endedRun: T0 }), T0 + 20 * MIN).wrote).toBe(true);
    // A rider's snapshot of the ended run arrives after it, stamped later.
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + SEC });
    expect(applyDeparturesPublish(doc, pub(route, [s, hold], T0 + 21 * MIN), T0 + 21 * MIN).wrote).toBe(false);
    expect(keys(doc)).toEqual([departureRouteKey(SHIP)]);
    const [f] = departureFerriesIn(doc.getMap(DEPARTURES_MAP));
    expect(f.route.startedAt).toBeUndefined();
    expect(f.endedRun).toBe(T0);
  });

  it('prunes as the ship does: entries below the newest timed one go, start kept', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + SEC });
    const dock = dockCheckpoint(route, 1, { at: s.arriveAt + 30 * SEC, stayStart: s.arriveAt + 25 * SEC, pilot: 'robot' })!;
    applyDeparturesPublish(doc, pub(route, [s, hold, dock]), dock.at + SEC);
    const at = () => departureFerriesIn(doc.getMap(DEPARTURES_MAP))[0].checkpoints.map((e) => `${e.legSeq}:${e.kind}`);
    expect(at()).toEqual(['0:start', '1:hold', '1:dock']);
    // A skip at stay 2 becomes the anchor: stay 1's entries go.
    const skip = skipCheckpoint(route, 2, { at: dock.arriveAt + SEC, pilot: 'robot', why: 'gone' })!;
    expect(applyDeparturesPublish(doc, pub(route, [s, skip], T0 + MIN), skip.at + SEC).wrote).toBe(true);
    expect(at()).toEqual(['0:start', '2:skip']);
  });

  it('drops malformed checkpoints and ones naming the wrong stop, and refuses a malformed publish', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    const wrongStop = { ...holdCheckpoint(route, 1, { at: s.arriveAt + SEC }), stationId: 'st-0' };
    applyDeparturesPublish(doc, pub(route, [s, wrongStop]), s.arriveAt + 2 * SEC);
    expect(departureFerriesIn(doc.getMap(DEPARTURES_MAP))[0].checkpoints.map((e) => e.kind)).toEqual(['start']);
    const other = new Y.Doc();
    expect(applyDeparturesPublish(other, pub(route, [s], T0, { shipRoomId: `a:ckpt:b` }), T0).wrote).toBe(false);
    expect(applyDeparturesPublish(other, pub(route, [s], T0 + 24 * 3600 * SEC), T0).wrote).toBe(false);
    expect(applyDeparturesPublish(other, pub({ ...route, shape: 'spiral' as never }, [s]), T0).wrote).toBe(false);
    expect(keys(other)).toEqual([]);
  });

  it('a full room lets the ferry published longest ago go', () => {
    const doc = new Y.Doc();
    const route = running();
    const s = start(route);
    for (let i = 0; i < MAX_DEPARTURE_FERRIES; i++) {
      applyDeparturesPublish(doc, pub(route, [s], T0 + i * SEC, { shipRoomId: `ship-${String(i).padStart(2, '0')}` }), T0 + i * SEC);
    }
    expect(departureFerriesIn(doc.getMap(DEPARTURES_MAP))).toHaveLength(MAX_DEPARTURE_FERRIES);
    applyDeparturesPublish(doc, pub(route, [s], T0 + MIN, { shipRoomId: 'ship-new' }), T0 + MIN);
    const ships = departureFerriesIn(doc.getMap(DEPARTURES_MAP)).map((f) => f.shipRoomId);
    expect(ships).toHaveLength(MAX_DEPARTURE_FERRIES);
    expect(ships).toContain('ship-new');
    expect(ships).not.toContain('ship-00');
    expect(keys(doc).some((k) => k.startsWith('ship-00:'))).toBe(false);
  });
});

describe('reading a room’s departures', () => {
  it('keeps only the current run’s entries for its stops, sorted, and skips junk', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(DEPARTURES_MAP);
    const route = running();
    const s = start(route);
    map.set(departureRouteKey(SHIP), departureRouteToWire({ shipRoomId: SHIP, name: 'F', capacity: 100, route, at: T0 }));
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + SEC });
    const { kind: _k, legSeq: _l, ...holdWire } = hold;
    map.set(departureCheckpointKey(SHIP, T0, 1, 'hold'), holdWire);
    const { kind: _k2, legSeq: _l2, ...startWire } = s;
    map.set(departureCheckpointKey(SHIP, T0, 0, 'start'), startWire);
    map.set(departureCheckpointKey(SHIP, T0 - 5, 0, 'start'), startWire); // another run
    map.set(departureCheckpointKey(SHIP, T0, 2, 'hold'), holdWire); // stay 2 is stop 0, not st-1
    map.set(departureCheckpointKey('ghost', T0, 0, 'start'), startWire); // no route entry
    map.set('junk', { hello: 1 });
    map.set(departureRouteKey('bad'), { shipRoomId: 'other', name: 'x', capacity: 1, at: 1, route: routeToWire(route) });
    const ferries = departureFerriesIn(map);
    expect(ferries.map((f) => f.shipRoomId)).toEqual([SHIP]);
    expect(ferries[0].checkpoints.map((e) => `${e.legSeq}:${e.kind}`)).toEqual(['0:start', '1:hold']);
    expect(stopAt(route, 2)).toBe(0);
  });

  it('the bound room: the same objects until the map changes; a board’s setting', () => {
    const doc = new Y.Doc();
    bindDeparturesDoc(doc);
    const route = running();
    applyDeparturesPublish(doc, pub(route, [start(route)]), T0);
    const a = readDepartureFerries();
    expect(readDepartureFerries()).toBe(a);
    applyDeparturesPublish(doc, pub(route, [start(route), holdCheckpoint(route, 1, { at: start(route).arriveAt + SEC })], T0 + MIN), start(route).arriveAt + 2 * SEC);
    expect(readDepartureFerries()).not.toBe(a);
    expect(readBoardSetting('board-1')).toBeNull();
    expect(writeBoardSetting('board-1', { gate: 2 })).toBe(true);
    expect(readBoardSetting('board-1')).toEqual({ gate: 2 });
    expect(writeBoardSetting('board-1', { all: true })).toBe(true);
    expect(readBoardSetting('board-1')).toEqual({ all: true });
    expect(writeBoardSetting('board-1', { gate: 0 })).toBe(false);
    expect(writeBoardSetting('board-1', null)).toBe(true);
    expect(readBoardSetting('board-1')).toBeNull();
  });
});

describe('where a publish goes', () => {
  it('the stop the change concerns first, then every other stop once', () => {
    const route = running([0, 1, 2]);
    expect(publishRoomOrder(route, null)).toEqual(['room-0', 'room-1', 'room-2']);
    expect(publishRoomOrder(route, 1)).toEqual(['room-1', 'room-0', 'room-2']);
    expect(publishRoomOrder(route, 3)).toEqual(['room-1', 'room-0', 'room-2']); // back and forth: stay 3 is stop 1
    expect(publishRoomOrder({ ...route, startStop: 2 }, null)).toEqual(['room-2', 'room-0', 'room-1']);
    const shared = running([0, 1]);
    shared.stops[1] = { ...shared.stops[1], berth: { ...shared.stops[0].berth } };
    expect(publishRoomOrder(shared, 1)).toEqual(['room-0']);
  });
});

describe('a board’s gate setting', () => {
  it('reads all gates, one gate, or nothing', () => {
    expect(boardSettingFromWire({ all: true })).toEqual({ all: true });
    expect(boardSettingFromWire({ gate: 3 })).toEqual({ gate: 3 });
    for (const bad of [{ gate: 0 }, { gate: 100 }, { gate: 2.5 }, { all: true, gate: 2 }, { all: 'yes' }, null, 3]) {
      expect(boardSettingFromWire(bad)).toBeNull();
    }
  });

  it('defaults to the gate in its room when there is exactly one', () => {
    expect(boardGate(null, [2])).toBe(2);
    expect(boardGate(null, [2, 2])).toBe(2);
    expect(boardGate(null, [2, 3])).toBeNull();
    expect(boardGate(null, [])).toBeNull();
    expect(boardGate({ all: true }, [2])).toBeNull();
    expect(boardGate({ gate: 5 }, [2])).toBe(5);
  });
});
