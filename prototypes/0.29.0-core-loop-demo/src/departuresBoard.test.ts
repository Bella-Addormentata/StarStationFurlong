/**
 * 🚏📋 Departures board — the rows a stop's board works out from a ferry's
 * mirrored route and checkpoints, with its own berth door as the live dock
 * (build notes A6): BOARDING, ON TIME (arriving, or on its way with the
 * arrival), NOT DOCKED, HOLDING FOR BERTH, DELAYED (the new time, waiting for
 * a rider, time unknown), PAUSED and ROUTE BLOCKED; the gate filter; rows
 * from ship summaries "as of" their time; and the route fields a ferry puts
 * in its own ShipSummary (A9 item 7).
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_ARRIVING_MS,
  MAX_BOARD_ROWS,
  ROUTE_STATUSES,
  SUMMARY_ROW_MAX_AGE_MS,
  boardView,
  ferryDocksHere,
  ferryName,
  ferryRow,
  routePortGate,
  routeSummaryFields,
  rowText,
  statusFromWire,
  statusToWire,
  summaryRow,
} from './departuresBoard';
import type { BoardDock, BoardHere } from './departuresBoard';
import type { DepartureFerry } from './departuresDoc';
import { formatClock } from './helmRoute';
import {
  ROBOT_TAKEOVER_MS,
  holdCheckpoint,
  legWindowAfter,
  liveDockFrom,
  pauseCheckpoint,
  renewedHold,
  routeFlightAt,
  routeLegFuel,
  skipCheckpoint,
  startCheckpoint,
} from './pilotRoute';
import type { ShipSummary } from './planetSummary';
import { DB_SCREEN_ROWS } from './furniture';
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

function running(over: Partial<ShipRoute> = {}): ShipRoute {
  return {
    stops: [stop(0, 0), stop(1, 1)],
    shape: 'backAndForth',
    shipPort: 'x-',
    robotDockId: 'dock-1',
    startedAt: T0,
    startStop: 0,
    ...over,
  };
}

function start(route: ShipRoute, pilot: 'robot' | 'person' = 'robot'): StartCheckpoint {
  return startCheckpoint(route, { at: T0, pilot, fuel: 100 })!;
}

function ferry(route: ShipRoute, checkpoints: RouteCheckpoint[], name = 'Ferry One', ship = SHIP): DepartureFerry {
  return { shipRoomId: ship, name, capacity: 100, route, at: T0, checkpoints };
}

/** A board in stop `i`'s berth room, seeing the ferry's `docks` there (or
 *  none; one with no far door reads as the route port's). */
function boardAt(i: number, docks: BoardDock | readonly BoardDock[] | null = null): BoardHere {
  const list: readonly BoardDock[] = docks === null ? [] : 'dockedAt' in docks ? [docks] : docks;
  return {
    isHere: (s) => s.berth.roomId === `room-${i}`,
    docksOf: (ship) => (ship === SHIP ? list : []),
  };
}

describe('status words', () => {
  it('travel as short words and read back', () => {
    for (const w of ROUTE_STATUSES) expect(statusToWire(statusFromWire(w))).toBe(w);
    expect(statusFromWire('holding')).toBe('HOLDING FOR BERTH');
    expect(statusToWire('ROUTE BLOCKED')).toBe('blocked');
  });
});

describe('a ferry docked at this board’s stop', () => {
  const route = running();
  const s = start(route);

  it('BOARDING while the berth holds it, with its departure, destination and gate', () => {
    const r = ferryRow(ferry(route, [s]), boardAt(0, { dockedAt: T0 + 2 * SEC }), T0 + 10 * SEC);
    expect(r).toEqual({
      shipRoomId: SHIP, ferry: 'Ferry One', dir: 'to', place: 'Stop 1', gate: 1, at: s.departAt, status: 'BOARDING',
    });
  });

  it('a gate change shows the gate it really took', () => {
    const r = ferryRow(ferry(route, [s]), boardAt(0, { dockedAt: T0 + 2 * SEC, gate: 4 }), T0 + 10 * SEC);
    expect(r).toMatchObject({ gate: 4, status: 'BOARDING' });
  });

  it('🛟 the gate and BOARDING are the route port’s: another ship door’s pairing only holds the stay', () => {
    // The route port is the ship's 'x-'; 'y+' is a guest or second dock.
    const port: BoardDock = { dockedAt: T0 + 2 * SEC, gate: 3, farDoor: 'x-' };
    const guest: BoardDock = { dockedAt: T0 + 5 * SEC, gate: 2, farDoor: 'y+' };
    expect(ferryDocksHere([guest, port], 'x-')).toEqual({ port, at: T0 + 5 * SEC, held: T0 + 5 * SEC });
    expect(ferryDocksHere([{ dockedAt: T0, gate: 4 }], 'x-')).toEqual({ port: { dockedAt: T0, gate: 4 }, at: T0, held: null });
    expect(ferryDocksHere([], 'x-')).toEqual({ port: null, at: null, held: null });
    expect(ferryRow(ferry(route, [s]), boardAt(0, [guest, port]), T0 + 10 * SEC)).toMatchObject({ gate: 3, status: 'BOARDING' });
    // A guest pairing alone never shows BOARDING at its own gate.
    const alone = ferryRow(ferry(route, [s]), boardAt(0, guest), T0 + BOARD_ARRIVING_MS + SEC);
    expect(alone).toMatchObject({ gate: 1, status: 'NOT DOCKED' });
    // The board's timetable is the riders' (the same docks, as they read them).
    for (const now of [T0 + 10 * SEC, s.departAt + 20 * SEC, s.departAt + 10 * MIN]) {
      const riders = routeFlightAt(route, [s], liveDockFrom(
        [{ roomId: 'room-0', dockedAt: port.dockedAt, doorId: 'x-' }, { roomId: 'room-0', dockedAt: guest.dockedAt, doorId: 'y+' }],
        undefined,
        { routePort: 'x-' },
      ), now, 100)!;
      const row = ferryRow(ferry(route, [s]), boardAt(0, [guest, port]), now);
      if (riders.status === 'docked' && riders.stopIndex === 0) expect(row).toMatchObject({ dir: 'to', gate: 3 });
      else expect(row?.status).not.toBe('BOARDING');
    }
  });

  it('ON TIME while it arrives, then NOT DOCKED when this berth never took it', () => {
    const arriving = ferryRow(ferry(route, [s]), boardAt(0), T0 + BOARD_ARRIVING_MS - SEC);
    expect(arriving).toMatchObject({ status: 'ON TIME', note: 'arriving', at: s.departAt });
    const not = ferryRow(ferry(route, [s]), boardAt(0), T0 + BOARD_ARRIVING_MS + SEC);
    expect(not).toMatchObject({ status: 'NOT DOCKED', at: s.departAt, dir: 'to', place: 'Stop 1' });
  });

  it('DELAYED, waiting for a rider, when the robot’s departure passed with nobody aboard to cast off', () => {
    const r = ferryRow(ferry(route, [s]), boardAt(0, { dockedAt: T0 + 2 * SEC }), s.departAt + 20 * SEC);
    expect(r).toMatchObject({ status: 'DELAYED', note: 'waiting for a rider', at: s.departAt });
  });

  it('DELAYED with the new time while a person’s missed departure waits for the robot captain', () => {
    const p = start(route, 'person');
    const now = p.departAt + 30 * SEC;
    const f = routeFlightAt(route, [p], null, now, 100)!;
    expect(f.takeoverAt).toBe(p.departAt + ROBOT_TAKEOVER_MS);
    const r = ferryRow(ferry(route, [p]), boardAt(0, { dockedAt: T0 + 2 * SEC }), now);
    expect(r).toMatchObject({ status: 'DELAYED', at: f.departsAt, note: `now ${formatClock(f.departsAt)}` });
    expect(f.departsAt!).toBeGreaterThan(p.departAt + ROBOT_TAKEOVER_MS - 1);
  });

  it('DELAYED, time unknown, when a person pilot with no robot captain let it pass', () => {
    const people = running({ robotDockId: undefined });
    const p = start(people, 'person');
    const r = ferryRow(ferry(people, [p]), boardAt(0, { dockedAt: T0 + 2 * SEC }), p.departAt + 30 * SEC);
    expect(r).toMatchObject({ status: 'DELAYED', note: 'time unknown', at: p.departAt });
  });

  it('PAUSED, time unknown, once flown off the route', () => {
    const pause = pauseCheckpoint(route, 0, { at: T0 + 20 * SEC });
    const r = ferryRow(ferry(route, [s, pause]), boardAt(0), T0 + 30 * SEC);
    expect(r).toMatchObject({ status: 'PAUSED', at: null, note: 'time unknown', dir: 'to', place: 'Stop 1' });
    // The other stop's board shows where it paused.
    expect(ferryRow(ferry(route, [s, pause]), boardAt(1), T0 + 30 * SEC)).toMatchObject({ status: 'PAUSED', dir: 'from', place: 'Stop 0', gate: 2 });
  });

  it('leaves the board once STOP ends the route here', () => {
    const stopped = running({ stoppedAt: T0 + 5 * SEC });
    expect(ferryRow(ferry(stopped, [s]), boardAt(0, { dockedAt: T0 }), T0 + 10 * SEC)).toBeNull();
  });
});

describe('a ferry holding, or skipping, at this board’s stop', () => {
  const route = running();
  const s = start(route);

  it('HOLDING FOR BERTH since the hold began, and how long it waits once docked', () => {
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + 5 * SEC });
    const r = ferryRow(ferry(route, [s, hold]), boardAt(1), s.arriveAt + 20 * SEC);
    expect(r).toMatchObject({
      status: 'HOLDING FOR BERTH', at: hold.since, dir: 'to', place: 'Stop 0', gate: 2,
      note: `since ${formatClock(hold.since)} · leaves at least 1 min after it docks`,
    });
    // Elsewhere its arrival is not known.
    expect(ferryRow(ferry(route, [s, hold]), boardAt(0), s.arriveAt + 20 * SEC)).toMatchObject({
      status: 'DELAYED', note: 'time unknown', dir: 'from', place: 'Stop 1', at: null,
    });
  });

  it('ROUTE BLOCKED when the berth is gone or shut to it; NOT DOCKED passing on SKIP STOP', () => {
    const at = s.arriveAt + 5 * SEC;
    const gone = skipCheckpoint(route, 1, { at, pilot: 'robot', why: 'gone' })!;
    expect(ferryRow(ferry(route, [s, gone]), boardAt(1), at + SEC)).toMatchObject({ status: 'ROUTE BLOCKED', note: 'berth removed', at: null });
    const shut = skipCheckpoint(route, 1, { at, pilot: 'robot', why: 'shut' })!;
    expect(ferryRow(ferry(route, [s, shut]), boardAt(1), at + SEC)).toMatchObject({ status: 'ROUTE BLOCKED', note: 'gate closed to this ferry' });
    const helm = skipCheckpoint(route, 1, { at, pilot: 'robot', why: 'helm' })!;
    expect(ferryRow(ferry(route, [s, helm]), boardAt(1), at + SEC)).toMatchObject({ status: 'NOT DOCKED', note: 'not stopping here', at: helm.departAt });
  });

  it('⛔ a stop found gone leaves a two-stop route BLOCKED: "Stop 1 is gone", here and elsewhere', () => {
    const gone = skipCheckpoint(route, 1, { at: s.arriveAt + 5 * SEC, pilot: 'robot', why: 'gone' })!;
    const t = gone.arriveAt + SEC; // back at stop 0: the only stop left
    expect(ferryRow(ferry(route, [s, gone]), boardAt(0), t)).toMatchObject({ status: 'ROUTE BLOCKED', note: 'Stop 1 is gone', at: null });
    expect(ferryRow(ferry(route, [s, gone]), boardAt(1), t)).toMatchObject({
      status: 'ROUTE BLOCKED', note: 'Stop 1 is gone · stopped at Stop 0', dir: 'from', at: null,
    });
  });
});

describe('a ferry on its way', () => {
  const route = running();
  const s = start(route);

  it('ON TIME with its arrival, from where it left', () => {
    const r = ferryRow(ferry(route, [s]), boardAt(1), s.departAt + SEC);
    expect(r).toEqual({ shipRoomId: SHIP, ferry: 'Ferry One', dir: 'from', place: 'Stop 0', gate: 2, at: s.arriveAt, status: 'ON TIME' });
  });

  it('the stop it just left shows its next call there, from the schedule', () => {
    const back = legWindowAfter(route, 1, s.arriveAt + MIN)!;
    const r = ferryRow(ferry(route, [s]), boardAt(0), s.departAt + SEC);
    expect(r).toMatchObject({ dir: 'from', place: 'Stop 1', gate: 1, at: back.arriveAt, status: 'ON TIME' });
  });

  it('shows nothing at a station the route never calls at, or once the route is over', () => {
    expect(ferryRow(ferry(route, [s]), boardAt(7), s.departAt + SEC)).toBeNull();
    const { startedAt: _a, startStop: _b, ...finished } = route;
    expect(ferryRow(ferry(finished, []), boardAt(0), s.departAt + SEC)).toBeNull();
    // STOP pressed: the ferry ends at its next stop, and the stop behind it
    // has no next call.
    const stopped = running({ stoppedAt: s.departAt + SEC });
    expect(ferryRow(ferry(stopped, [s]), boardAt(0), s.departAt + 2 * SEC)).toBeNull();
    expect(ferryRow(ferry(stopped, [s]), boardAt(1), s.departAt + 2 * SEC)).toMatchObject({ status: 'ON TIME', at: s.arriveAt });
  });
});

describe('⛽ a later call, with the timetable’s fuel rules', () => {
  const loop = (over: Partial<ShipRoute> = {}) => running({ stops: [stop(0, 0), stop(1, 1), stop(2, 2)], shape: 'loop', ...over });
  const cost = (r: ShipRoute, a: number, b: number) => routeLegFuel(r, a, b)!;

  it('shows no call the fuel can’t reach: the timetable ends the route before it', () => {
    const route = loop();
    const low = cost(route, 0, 1) + cost(route, 1, 2) - 1;
    const s = startCheckpoint(route, { at: T0, pilot: 'robot', fuel: low })!;
    const full = start(route);
    // Docked at stop 0, and in flight to stop 1: stop 2's board.
    for (const now of [T0 + 10 * SEC, s.departAt + SEC]) {
      expect(ferryRow(ferry(route, [s]), boardAt(2), now)).toBeNull();
      const w = legWindowAfter(route, 1, full.arriveAt + MIN)!;
      expect(ferryRow(ferry(route, [full]), boardAt(2), now)).toMatchObject({ dir: 'from', place: 'Stop 1', at: w.arriveAt, status: 'ON TIME' });
    }
    // …and the timetable agrees: it ends at stop 1, out of fuel.
    const w = legWindowAfter(route, 1, s.arriveAt + MIN)!;
    expect(routeFlightAt(route, [s], null, w.departAt + SEC, 100)).toMatchObject({ status: 'docked', stopIndex: 1, ended: 'fuel' });
  });

  it('counts the home refill: a call after the home stop is shown only when the tanks refill there', () => {
    const cap = 200;
    const trip = (homeRefuel: boolean) => {
      const route = loop(homeRefuel ? { homeRefuel: true } : {});
      // Enough for 0→1→2→0, not for 0→1 again.
      const fuel = cost(route, 0, 1) + cost(route, 1, 2) + cost(route, 2, 0) + cost(route, 0, 1) - 1;
      const s = startCheckpoint(route, { at: T0, pilot: 'robot', fuel })!;
      const w1 = legWindowAfter(route, 1, s.arriveAt + MIN)!;
      const w2 = legWindowAfter(route, 2, w1.arriveAt + MIN)!;
      const w3 = legWindowAfter(route, 3, w2.arriveAt + MIN)!;
      const now = w2.departAt + SEC;
      expect(routeFlightAt(route, [s], null, now, cap)).toMatchObject({ status: 'in-flight', stopIndex: 2, nextStopIndex: 0 });
      return { row: ferryRow({ ...ferry(route, [s]), capacity: cap }, boardAt(1), now), w3 };
    };
    const refilled = trip(true);
    expect(refilled.row).toMatchObject({ dir: 'from', place: 'Stop 0', at: refilled.w3.arriveAt, status: 'ON TIME' });
    expect(trip(false).row).toBeNull();
  });
});

describe('the board', () => {
  const route = running();
  const s = start(route);
  const other = running({ startedAt: T0 + MIN });
  const s2 = startCheckpoint(other, { at: T0 + MIN, pilot: 'robot', fuel: 100 })!;

  it('lists every ferry soonest first, or only its gate’s', () => {
    const second = ferry(other, [s2], 'Ferry Two', 'ship-room-2');
    const here: BoardHere = {
      isHere: (st) => st.berth.roomId === 'room-0',
      docksOf: (ship) => (ship === SHIP ? [{ dockedAt: T0 + SEC, gate: 1 }] : ship === 'ship-room-2' ? [{ dockedAt: T0 + MIN, gate: 3 }] : []),
    };
    const now = T0 + 70 * SEC;
    const all = boardView({ ferries: [second, ferry(route, [s])], here, gate: null, now });
    expect(all.title).toBe('DEPARTURES · ALL GATES');
    expect(all.rows.map((r) => r.ferry)).toEqual(
      s.departAt <= s2.departAt ? ['Ferry One', 'Ferry Two'] : ['Ferry Two', 'Ferry One'],
    );
    const gate3 = boardView({ ferries: [second, ferry(route, [s])], here, gate: 3, now });
    expect(gate3.title).toBe('DEPARTURES · GATE 3');
    expect(gate3.rows.map((r) => r.ferry)).toEqual(['Ferry Two']);
  });

  it('adds ferries it holds no departures for from ship summaries, as of their time, and caps its rows', () => {
    const summary = (i: number, over: Partial<ShipSummary> = {}): ShipSummary => ({
      roomId: `ship-s${i}`, name: `Liner ${i}`, planetId: SOV, status: 'docked', fromRoom: 'welcome-0',
      nextStopRoom: 'room-1', departAt: T0 + (i + 1) * MIN, gate: 2, routeStatus: 'boarding', updatedAt: T0, ...over,
    });
    const here = boardAt(0);
    const isHereRoom = (room: string) => room === 'welcome-0' || room === 'room-0';
    const placeOf = (room: string | undefined) => (room === 'room-1' ? 'Stop 1' : room === 'welcome-9' ? 'Far' : '?');
    const v = boardView({
      ferries: [ferry(route, [s])],
      here,
      gate: null,
      summaries: [summary(0), summary(1, { roomId: SHIP })],
      isHereRoom,
      placeOf,
      now: T0 + 5 * SEC,
    });
    // SHIP comes from the departures map, not its summary.
    expect(v.rows.filter((r) => r.shipRoomId === SHIP)).toHaveLength(1);
    expect(v.rows.find((r) => r.shipRoomId === 'ship-s0')).toMatchObject({
      dir: 'to', place: 'Stop 1', at: T0 + MIN, status: 'BOARDING', gate: 2, asOf: T0,
    });
    const many = boardView({
      ferries: [], here, gate: 2, summaries: Array.from({ length: 10 }, (_, i) => summary(i)), isHereRoom, placeOf, now: T0,
    });
    expect(many.rows).toHaveLength(MAX_BOARD_ROWS);
    // …and the in-world screen draws every one of them.
    expect(DB_SCREEN_ROWS).toBe(MAX_BOARD_ROWS);
    expect(many.rows.map((r) => r.at)).toEqual([...many.rows.map((r) => r.at)].sort((a, b) => a! - b!));
  });

  it('a hold renewal this room missed: the summary’s news is the hold’s newest sighting', () => {
    const hold = holdCheckpoint(route, 1, { at: s.arriveAt + 5 * SEC });
    // The keeper renews the hold each minute; this room's copy kept only the
    // first sighting, which has gone unwatched by now.
    const renewed = renewedHold(hold, hold.at + 3 * MIN);
    const now = renewed.seenAt + 30 * SEC;
    const f = routeFlightAt(route, [s, renewed], null, now, 100)!;
    const fields = routeSummaryFields(route, f, [s, renewed], null, now);
    expect(fields).toMatchObject({ routeStatus: 'holding', routeRun: T0, routeNews: renewed.seenAt });
    const summary: ShipSummary = {
      roomId: SHIP, name: 'Ferry One', planetId: SOV, status: 'in-flight', fromRoom: 'room-0', toRoom: 'room-1',
      ...fields, updatedAt: renewed.seenAt,
    };
    const view = (mirror: RouteCheckpoint[]) => boardView({
      ferries: [ferry(route, mirror)], here: boardAt(1), gate: null, summaries: [summary],
      isHereRoom: (room) => room === 'room-1', placeOf: () => 'Stop 0', now,
    }).rows;
    // The lapsed copy gives way to the ship's word…
    expect(view([s, hold])).toEqual([expect.objectContaining({ status: 'HOLDING FOR BERTH', asOf: renewed.seenAt })]);
    // …and a copy that has the renewal keeps its own row.
    const own = view([s, renewed]);
    expect(own).toEqual([expect.objectContaining({ status: 'HOLDING FOR BERTH' })]);
    expect(own[0].asOf).toBeUndefined();
  });

  it('a summary the ferry wrote after its last publish here wins where they disagree', () => {
    const here = boardAt(0, { dockedAt: T0 + 2 * SEC });
    const isHereRoom = (room: string) => room === 'room-0';
    const placeOf = (room: string | undefined) => (room === 'room-1' ? 'Stop 1' : '?');
    const now = T0 + 10 * SEC;
    const mine = (over: Partial<ShipSummary> = {}): ShipSummary => ({
      roomId: SHIP, name: 'Ferry One', planetId: SOV, status: 'docked', fromRoom: 'room-0', nextStopRoom: 'room-1',
      departAt: s.departAt, gate: 1, routeStatus: 'boarding', updatedAt: T0 + 5 * SEC, ...over,
    });
    const view = (summary: ShipSummary, f = ferry(route, [s])) =>
      boardView({ ferries: [f], here, gate: null, summaries: [summary], isHereRoom, placeOf, now }).rows;
    // Agreeing: the map's own row, read from the clock now.
    const same = view(mine());
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ status: 'BOARDING', gate: 1, at: s.departAt });
    expect(same[0].asOf).toBeUndefined();
    // Another gate, or the same status at another time: the newer word.
    expect(view(mine({ gate: 3 }))).toEqual([expect.objectContaining({ gate: 3, asOf: T0 + 5 * SEC })]);
    expect(view(mine({ departAt: s.departAt + 5 * MIN }))).toEqual([expect.objectContaining({ at: s.departAt + 5 * MIN, asOf: T0 + 5 * SEC })]);
    // 🏁 Said since that no run flies: off the board. Said before: no say.
    const idle: ShipSummary = { roomId: SHIP, name: 'Ferry One', planetId: SOV, status: 'docked', fromRoom: 'room-0', routeIdle: true, updatedAt: T0 + 5 * SEC };
    expect(view(idle)).toEqual([]);
    expect(view({ ...idle, updatedAt: T0 - SEC })).toHaveLength(1);
    // No route fields at all (an older client's relay drops them): no say either.
    const { routeIdle: _i, ...stripped } = idle;
    expect(view(stripped)).toEqual([expect.objectContaining({ status: 'BOARDING', at: s.departAt })]);
    // A finished route's entry left behind makes no row: a newer summary fills it.
    const finished = ferry(running({ stoppedAt: T0 + SEC }), [s]);
    expect(view(mine(), finished)).toEqual([expect.objectContaining({ status: 'BOARDING', asOf: T0 + 5 * SEC })]);
    expect(view(mine({ updatedAt: T0 - SEC }), finished)).toEqual([]);
    // A later run (a replacement route): the held run is over. Its row shows
    // when it calls here now, and none when it doesn't (not the old run's).
    expect(view(mine({ routeRun: T0 + MIN }))).toEqual([expect.objectContaining({ asOf: T0 + 5 * SEC })]);
    expect(view(mine({ routeRun: T0 + MIN, fromRoom: 'room-7' }))).toEqual([]);
    // The same run, calling elsewhere now: the held timetable still says
    // when it calls here.
    expect(view(mine({ routeRun: T0, fromRoom: 'room-7' }))).toEqual([expect.objectContaining({ status: 'BOARDING', at: s.departAt })]);
    // The ship knows of a checkpoint this room's copy lacks (a pause here
    // whose publish gave up): its word wins even where only the status
    // differs, and with no row of its own the held one reads time unknown.
    const paused = mine({ routeRun: T0, routeStatus: 'paused' });
    expect(view(paused)).toEqual([expect.objectContaining({ status: 'BOARDING', at: s.departAt })]);
    expect(view({ ...paused, routeNews: T0 })).toEqual([expect.objectContaining({ status: 'BOARDING', at: s.departAt })]);
    expect(view({ ...paused, routeNews: T0 + 3 * SEC })).toEqual([expect.objectContaining({ status: 'PAUSED', at: null, asOf: T0 + 5 * SEC })]);
    const holdingElsewhere = mine({
      routeRun: T0, routeNews: T0 + 3 * SEC, routeStatus: 'holding', status: 'in-flight', fromRoom: 'room-7', toRoom: 'room-9', nextStopRoom: 'room-9',
    });
    expect(view(holdingElsewhere)).toEqual([expect.objectContaining({ dir: 'to', status: 'DELAYED', at: null, note: 'time unknown', asOf: T0 + 5 * SEC })]);
    // Renamed since: the held row, read from the clock, under the new name.
    const renamed = view(mine({ name: 'Star Hopper' }));
    expect(renamed).toEqual([expect.objectContaining({ ferry: 'Star Hopper', status: 'BOARDING', at: s.departAt })]);
    expect(renamed[0].asOf).toBeUndefined();
    // …only by a newer summary that speaks for the route.
    expect(view(mine({ name: 'Star Hopper', updatedAt: T0 - SEC }))).toEqual([expect.objectContaining({ ferry: 'Ferry One' })]);
    const { routeStatus: _r, ...noRoute } = mine({ name: 'SHIP' });
    expect(view(noRoute)).toEqual([expect.objectContaining({ ferry: 'Ferry One' })]);
  });

  it('a ferry is named as its riders named the room, or FERRY while it has only its id', () => {
    expect(ferryName('Star Hopper', 'room-9')).toBe('Star Hopper');
    expect(ferryName('room-9', 'room-9')).toBe('FERRY');
    expect(ferryName('', 'room-9')).toBe('FERRY');
    expect(ferryName(undefined, 'room-9')).toBe('FERRY');
    expect(ferryName('x'.repeat(80), 'room-9')).toHaveLength(64);
  });

  it('a summary row: docked here, or flying here; nothing stale, off route or elsewhere', () => {
    const isHereRoom = (room: string) => room === 'welcome-0';
    const placeOf = (room: string | undefined) => room ?? '?';
    const base: ShipSummary = { roomId: 'ship-x', name: 'Liner', planetId: SOV, status: 'in-flight', fromRoom: 'welcome-9', toRoom: 'welcome-0', etaAt: T0 + MIN, routeStatus: 'on-time', gate: 1, updatedAt: T0 };
    expect(summaryRow(base, isHereRoom, placeOf, T0 + SEC)).toMatchObject({ dir: 'from', place: 'welcome-9', at: T0 + MIN, status: 'ON TIME', asOf: T0 });
    expect(summaryRow({ ...base, routeStatus: undefined }, isHereRoom, placeOf, T0)).toBeNull();
    expect(summaryRow(base, isHereRoom, placeOf, T0 + SUMMARY_ROW_MAX_AGE_MS + 1)).toBeNull();
    expect(summaryRow({ ...base, toRoom: 'welcome-5' }, isHereRoom, placeOf, T0)).toBeNull();
    expect(summaryRow({ ...base, status: 'docked', fromRoom: 'welcome-0', routeStatus: 'paused', departAt: T0 }, isHereRoom, placeOf, T0))
      .toMatchObject({ dir: 'to', status: 'PAUSED', at: null });
    // Paused in flight, off its route: that flight's ETA is somewhere else's.
    expect(summaryRow({ ...base, toRoom: 'welcome-5', nextStopRoom: 'welcome-0', routeStatus: 'paused' }, isHereRoom, placeOf, T0))
      .toMatchObject({ dir: 'from', status: 'PAUSED', at: null });
  });

  it('prints a row: ferry, where, gate, HH:MM:SS, status and note', () => {
    const t = rowText({ shipRoomId: SHIP, ferry: 'Ferry One', dir: 'to', place: 'Stop 1', gate: 2, at: s.departAt, status: 'BOARDING' });
    expect(t).toEqual({ ferry: 'FERRY ONE', place: '→ STOP 1', gate: '2', time: formatClock(s.departAt), status: 'BOARDING', note: '' });
    const u = rowText({ shipRoomId: SHIP, ferry: 'F', dir: 'from', place: 'A', at: null, status: 'DELAYED', note: 'time unknown', asOf: T0 });
    expect(u).toMatchObject({ place: '← A', gate: '—', time: '--:--:--', note: `time unknown · as of ${formatClock(T0).slice(0, 5)}` });
  });
});

describe('the route fields of the ferry’s own summary', () => {
  const route = running();
  const s = start(route);

  it('docked at a stop: its gate, next stop, departure and status', () => {
    const f = routeFlightAt(route, [s], () => T0 + SEC, T0 + 10 * SEC, 100)!;
    expect(routeSummaryFields(route, f, [s], { gate: 4 }, T0 + 10 * SEC)).toEqual({
      nextStopRoom: 'room-1', gate: 4, departAt: s.departAt, routeStatus: 'boarding', routeRun: T0, routeNews: T0,
    });
    expect(routeSummaryFields(route, f, [s], null, T0 + BOARD_ARRIVING_MS + SEC)).toMatchObject({ routeStatus: 'not-docked', gate: 1 });
  });

  it('the gate it gives: the station records’ gate for that door, else its own berth’s', () => {
    const st = route.stops[0];
    const none = () => undefined;
    expect(routePortGate(st, 'room-0', 'x+', none)).toBe(1);
    // An older writer's record naming no far door, into the berth room.
    expect(routePortGate(st, 'room-0', undefined, none)).toBe(1);
    expect(routePortGate(st, 'room-0', 'y-', none)).toBeUndefined();
    expect(routePortGate(st, 'room-0b', undefined, none)).toBeUndefined();
    expect(routePortGate(st, 'room-0b', 'y-', (r, d) => (r === 'room-0b' && d === 'y-' ? 4 : undefined))).toBe(4);
    expect(routePortGate(st, 'room-0', 'x+', () => 7)).toBe(7);
  });

  it('in flight: on time to the next stop’s gate; paused; nothing once over', () => {
    const f = routeFlightAt(route, [s], null, s.departAt + SEC, 100)!;
    expect(routeSummaryFields(route, f, [s], null, s.departAt + SEC)).toEqual({ nextStopRoom: 'room-1', gate: 2, routeStatus: 'on-time', routeRun: T0, routeNews: T0 });
    const pause = pauseCheckpoint(route, 0, { at: T0 + 20 * SEC });
    const p = routeFlightAt(route, [s, pause], null, T0 + 30 * SEC, 100)!;
    expect(routeSummaryFields(route, p, [s, pause], null, T0 + 30 * SEC)).toEqual({
      nextStopRoom: 'room-1', routeStatus: 'paused', routeRun: T0, routeNews: T0 + 20 * SEC,
    });
    // 🏁 No run flies: said outright.
    expect(routeSummaryFields(null, null, [], null, T0)).toEqual({ routeIdle: true });
    // A run that flies but can't be worked out yet (no anchor checkpoint
    // here): no word either way, so boards keep what they hold.
    expect(routeFlightAt(route, [], null, T0 + 10 * SEC, 100)).toBeNull();
    expect(routeSummaryFields(route, null, [], null, T0 + 10 * SEC)).toEqual({});
    const stopped = running({ stoppedAt: T0 + SEC });
    const e = routeFlightAt(stopped, [s], null, T0 + 10 * SEC, 100)!;
    expect(e.ended).toBe('stop');
    expect(routeSummaryFields(stopped, e, [s], null, T0 + 10 * SEC)).toEqual({ routeIdle: true });
  });
});
