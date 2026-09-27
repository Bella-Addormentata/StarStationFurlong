/**
 * 🚀🤖 Ship pilot — the robot captain (design §2a, the §4 table's lines, §5's
 * announcements): who may be named captain (Ship pilot, aboard a module that
 * can fly), the captain's lock on its console and dock while a route runs,
 * where the captain stands at each moment of the timetable, how it reads
 * its dock's gate and a skip's reason, the words (the clock rounded down,
 * how long is left), every line it says and when, the helm's own echo of
 * those lines (a person flying with no robot captain), and the readers over a
 * real ship + doors doc (a docked stay's welcome, SKIP STOP's reason, the
 * lock lifting when the route finishes).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import { bindDoorsDoc, buildDoorPairing, writeDoorPairing, readAllDoors } from './doorsDoc';
import { classifyDockPort } from './dockRules';
import { skipRouteStop } from './helmRoute';
import { liveDockFrom, skipCheckpoint, type LiveDockAt, type RouteFlight } from './pilotRoute';
import { ROBOT_ROUTINES, ROUTINE_LABELS } from './robotDoc';
import { keeperAfterPass, skipWhyOf, freshKeeperMemory, type KeeperGateResult, type KeeperView } from './routeKeeper';
import { setBerthSeedResolver } from './shipArrival';
import { bindShipDoc, writeFuelLevel } from './shipDoc';
import {
  checkpointFromWire,
  checkpointToWire,
  finishShipRoute,
  installRouteFlight,
  readRouteCheckpoints,
  startShipRoute,
  stopShipRoute,
  writeShipRoute,
} from './shipRoute';
import type { RouteCheckpoint, RouteStop, ShipRoute } from './shipRoute';
import type { StationBerth } from './stationDirectory';
import {
  CAPTAIN_LOCK_REFUSAL,
  HELM_LINE_SHOW_MS,
  PILOT_DEPART_LINE_MS,
  PILOT_HELM_BEFORE_MS,
  PILOT_LINE_GAP_MS,
  captainLockRefusal,
  consoleRoutineRefusal,
  freshHelmAnnouncer,
  helmAnnouncerStep,
  pilotDockAt,
  pilotLine,
  pilotPost,
  pilotRoutineOffered,
  pilotSpeechAfter,
  pilotSpeechAt,
  readCaptainLock,
  readPilotView,
  readRouteCaptainDockId,
  routeCaptainDockId,
  shipPilotEligible,
  skipLine,
  speakClock,
  speakLeft,
  staySkipWhy,
} from './shipPilot';
import type { PilotDock, PilotLine, PilotLineView, PilotSpeech } from './shipPilot';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOV = 'planet-sovereign';
const SEC = 1000;
const MIN = 60 * SEC;
const CAP = 100;
/** A departure at 14:05:47 LOCAL time (speech speaks the listener's clock). */
const D = new Date(2026, 8, 27, 14, 5, 47).getTime();

const seed = (room: string) => `ssf://room#room=${room}`;

function stop(i: number, slot: number, over: Partial<RouteStop> = {}): RouteStop {
  return {
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    berth: { roomId: `room-${i}`, farDoor: 'x+', gate: i + 2, anyGate: true },
    waitSecs: 60,
    ...over,
  };
}

function running(over: Partial<ShipRoute> = {}): ShipRoute & { startedAt: number } {
  return {
    stops: [stop(0, 0), stop(1, 1)],
    shape: 'backAndForth',
    shipPort: 'x-',
    robotDockId: 'dock-1',
    startedAt: D - 10 * MIN,
    startStop: 0,
    ...over,
  } as ShipRoute & { startedAt: number };
}

/** A docked stay at stop 0, leaving for stop 1 at D (figures made up). */
function docked(over: Partial<RouteFlight> = {}): RouteFlight {
  return {
    status: 'docked',
    locationId: 'st-0',
    legSeq: 4,
    stopIndex: 0,
    nextStopIndex: 1,
    stayStart: D - 5 * MIN,
    departsAt: D,
    scheduledAt: D,
    arrivesAt: D + 55 * SEC,
    holding: false,
    holdSince: null,
    overdue: false,
    skipped: false,
    gone: false,
    goneStops: [],
    takeoverAt: null,
    pilot: 'robot',
    fuel: 50,
    paused: false,
    stopping: false,
    ended: null,
    ...over,
  };
}

/** Leg 4 in flight from stop 0 to stop 1, its burn at D. */
function flying(over: Partial<RouteFlight> = {}): RouteFlight {
  return docked({
    status: 'in-flight',
    destinationId: 'st-1',
    departedAt: D,
    etaAt: D + 55 * SEC,
    ...over,
  });
}

const OWN: PilotDock = { gate: 2, gateChange: false };

function lineView(f: RouteFlight, now: number, over: Partial<PilotLineView> = {}): PilotLineView {
  return { route: running(), f, now, dock: f.status === 'docked' ? OWN : null, skipWhy: null, ...over };
}

/** Say whatever is due and remember it (as world.ts does once delivered). */
function say(v: PilotLineView, mem: PilotSpeech | null): [PilotLine | null, PilotSpeech | null] {
  const line = pilotLine(v, mem);
  return [line, line ? pilotSpeechAfter(v, mem, line) : mem];
}

// ── The routine, eligibility and the lock ────────────────────────────────────

describe('the Ship pilot routine and who may be captain', () => {
  it('is a robot routine labelled 🚀 Ship pilot', () => {
    expect(ROBOT_ROUTINES).toContain('pilot');
    expect(ROUTINE_LABELS.pilot).toBe('🚀 Ship pilot');
  });

  it('is offered at the console only in a flight-capable module (a dock already on it keeps it)', () => {
    expect(pilotRoutineOffered({ flightCapable: true, current: 'serve' })).toBe(true);
    expect(pilotRoutineOffered({ flightCapable: false, current: 'serve' })).toBe(false);
    expect(pilotRoutineOffered({ flightCapable: false, current: 'pilot' })).toBe(true);
  });

  it('makes a dock aboard eligible to be named captain while the module can fly', () => {
    expect(shipPilotEligible({ dockAboard: true, routine: 'pilot', flightCapable: true })).toBe(true);
    expect(shipPilotEligible({ dockAboard: true, routine: 'serve', flightCapable: true })).toBe(false);
    expect(shipPilotEligible({ dockAboard: true, routine: undefined, flightCapable: true })).toBe(false);
    expect(shipPilotEligible({ dockAboard: true, routine: 'pilot', flightCapable: false })).toBe(false);
    expect(shipPilotEligible({ dockAboard: false, routine: 'pilot', flightCapable: true })).toBe(false);
  });

  it('locks the captain of a RUNNING route (paused included), and only that dock', () => {
    const r = running();
    expect(routeCaptainDockId(r)).toBe('dock-1');
    expect(routeCaptainDockId({ ...r, stoppedAt: D })).toBe('dock-1');
    const saved = { ...r } as ShipRoute;
    delete saved.startedAt;
    expect(routeCaptainDockId(saved)).toBeNull();
    expect(routeCaptainDockId({ ...r, robotDockId: undefined })).toBeNull();
    expect(routeCaptainDockId(null)).toBeNull();
    expect(captainLockRefusal(r, 'dock-1')).toBe(CAPTAIN_LOCK_REFUSAL);
    expect(CAPTAIN_LOCK_REFUSAL).toBe("Captain of this ship's route: stop the route first");
    expect(captainLockRefusal(r, 'dock-2')).toBeNull();
    expect(captainLockRefusal(saved, 'dock-1')).toBeNull();
    expect(captainLockRefusal(r, '')).toBeNull();
  });

  it('refuses a routine change on the captain, but never re-choosing the routine it runs', () => {
    const r = running();
    expect(consoleRoutineRefusal({ route: r, dockId: 'dock-1', from: 'pilot', to: 'serve' })).toBe(CAPTAIN_LOCK_REFUSAL);
    expect(consoleRoutineRefusal({ route: r, dockId: 'dock-1', from: 'pilot', to: 'pilot' })).toBeNull();
    expect(consoleRoutineRefusal({ route: r, dockId: 'dock-2', from: 'serve', to: 'dance' })).toBeNull();
    expect(consoleRoutineRefusal({ route: null, dockId: 'dock-1', from: 'pilot', to: 'idle' })).toBeNull();
  });
});

// ── Where the captain stands ─────────────────────────────────────────────────

describe('where the captain stands (pilotPost)', () => {
  it('waits on its dock with no running route, or while the route is paused', () => {
    expect(pilotPost(null, D)).toBe('dock');
    expect(pilotPost(docked({ paused: true }), D - 5 * MIN)).toBe('dock');
  });

  it('flies from the helm, and goes there before a departure', () => {
    expect(pilotPost(flying(), D + 10 * SEC)).toBe('helm');
    expect(pilotPost(docked(), D - 3 * MIN)).toBe('door');
    expect(pilotPost(docked(), D - PILOT_HELM_BEFORE_MS - 1)).toBe('door');
    expect(pilotPost(docked(), D - PILOT_HELM_BEFORE_MS)).toBe('helm');
    expect(pilotPost(docked({ overdue: true }), D + 5 * SEC)).toBe('helm');
  });

  it('holds and passes stops from the helm; announces the route\'s end at the door', () => {
    expect(pilotPost(docked({ holding: true, departsAt: null, holdSince: D - MIN }), D - 3 * MIN)).toBe('helm');
    expect(pilotPost(docked({ skipped: true }), D - 3 * MIN)).toBe('helm');
    expect(pilotPost(docked({ ended: 'stop', departsAt: null }), D)).toBe('door');
    expect(pilotPost(docked({ ended: 'fuel', departsAt: null }), D)).toBe('door');
  });

  it('is steward at the berth door while a person flies', () => {
    expect(pilotPost(docked({ pilot: 'person' }), D - 10 * SEC)).toBe('door');
    expect(pilotPost(flying({ pilot: 'person' }), D + 10 * SEC)).toBe('door');
  });
});

// ── The dock and the skip ────────────────────────────────────────────────────

describe('how the captain reads its dock and a skip', () => {
  const s = stop(0, 0);
  const none = () => undefined;

  it('reads the stop\'s own berth as its gate, with no gate change', () => {
    expect(pilotDockAt(s, { roomId: 'room-0', farDoor: 'x+' }, true, none)).toEqual({ gate: 2, gateChange: false });
    // An older dock record with no far door, into the berth room: the own berth.
    expect(pilotDockAt(s, { roomId: 'room-0' }, true, none)).toEqual({ gate: 2, gateChange: false });
    // A stop with no copied gate number asks the atlas/directory.
    const bare = stop(0, 0, { berth: { roomId: 'room-0', farDoor: 'x+', anyGate: true } });
    expect(pilotDockAt(bare, { roomId: 'room-0', farDoor: 'x+' }, true, () => 5)).toEqual({ gate: 5, gateChange: false });
    expect(pilotDockAt(bare, { roomId: 'room-0', farDoor: 'x+' }, true, none)).toEqual({ gateChange: false });
  });

  it('reads any other gate of the station as a gate change', () => {
    const gateOf = (roomId: string, farDoor: string) => (roomId === 'room-0b' && farDoor === 'y-' ? 3 : undefined);
    expect(pilotDockAt(s, { roomId: 'room-0b', farDoor: 'y-' }, true, gateOf)).toEqual({ gate: 3, gateChange: true });
    expect(pilotDockAt(s, { roomId: 'room-0', farDoor: 'y+' }, true, none)).toEqual({ gateChange: true });
    // A number outside 1..99, or a lookup that throws, is left out.
    expect(pilotDockAt(s, { roomId: 'room-0b', farDoor: 'y-' }, true, () => 0)).toEqual({ gateChange: true });
    expect(pilotDockAt(s, { roomId: 'room-0b', farDoor: 'y-' }, true, () => { throw new Error('x'); })).toEqual({ gateChange: true });
  });

  it('is no dock at all when not docked, or docked away from the stop', () => {
    expect(pilotDockAt(s, null, true, none)).toBeNull();
    expect(pilotDockAt(s, { roomId: 'room-9', farDoor: 'x+' }, false, none)).toBeNull();
  });

  it('reads why a stay is skipped from its newest skip entry; none means a hold nobody renewed', () => {
    const r = running();
    const f = docked({ skipped: true });
    const sk = (at: number, why?: 'gone' | 'shut' | 'helm', legSeq = 4): RouteCheckpoint => ({
      kind: 'skip', legSeq, at, stationId: 'st-0', departAt: D, arriveAt: D + 55 * SEC, ...(why ? { why } : {}),
    });
    expect(staySkipWhy(docked(), [sk(D - MIN, 'gone')])).toBeNull();
    expect(staySkipWhy(f, [sk(D - MIN, 'gone')])).toBe('gone');
    expect(staySkipWhy(f, [sk(D - MIN, 'gone'), sk(D - 30 * SEC, 'helm')])).toBe('helm');
    expect(staySkipWhy(f, [sk(D - MIN)])).toBe('unknown');
    expect(staySkipWhy(f, [sk(D - MIN, 'gone', 3)])).toBe('unwatched');
    expect(staySkipWhy(f, [])).toBe('unwatched');
    // ⛔ Found gone at an earlier visit: passed with no entry of its own.
    expect(staySkipWhy(docked({ skipped: true, gone: true, goneStops: [0] }), [])).toBe('gone');
    expect(r.stops).toHaveLength(2);
  });
});

// ── Words ────────────────────────────────────────────────────────────────────

describe('the words', () => {
  it('speaks the clock rounded DOWN to the minute, in local time', () => {
    expect(speakClock(D)).toBe('14:05');
    expect(speakClock(new Date(2026, 8, 27, 9, 0, 59, 999).getTime())).toBe('09:00');
    expect(speakClock(Number.NaN)).toBe('--:--');
  });

  it('always says how long is left, rounded down', () => {
    expect(speakLeft(3 * MIN + 37 * SEC)).toBe('in 3 minutes');
    expect(speakLeft(2 * MIN)).toBe('in 2 minutes');
    expect(speakLeft(119 * SEC)).toBe('in one minute');
    expect(speakLeft(60 * SEC)).toBe('in one minute');
    expect(speakLeft(59 * SEC)).toBe('in 55 seconds');
    expect(speakLeft(12 * SEC)).toBe('in 10 seconds');
    expect(speakLeft(9 * SEC)).toBe('in a few seconds');
    expect(speakLeft(-5 * SEC)).toBe('in a few seconds');
    expect(speakLeft(65 * MIN)).toBe('in one hour and 5 minutes');
    expect(speakLeft(61 * MIN)).toBe('in one hour and one minute');
    expect(speakLeft(120 * MIN + 59 * SEC)).toBe('in 2 hours');
    expect(speakLeft(9 * 60 * MIN + 48 * MIN)).toBe('in 9 hours and 48 minutes');
    expect(speakLeft(14 * 60 * MIN + 30 * MIN)).toBe('in 14 hours');
  });

  it('has a §4 line for each reason a stop is skipped', () => {
    expect(skipLine('gone', 'B', 'C')).toBe('The berth at B has been removed. Continuing to C.');
    expect(skipLine('shut', 'B', 'C')).toBe('The berth at B is closed to this ferry. Continuing to C.');
    expect(skipLine('helm', 'B', 'C')).toBe('We are not stopping at B. Continuing to C.');
    expect(skipLine('unwatched', 'B', 'C')).toBe('Still no free berth at B. Continuing to C.');
    expect(skipLine('unknown', 'B', 'C')).toBe('We will not dock at B. Continuing to C.');
    expect(skipLine(null, 'B', 'C')).toBe('We will not dock at B. Continuing to C.');
  });
});

// ── What the captain says ────────────────────────────────────────────────────

describe('what the captain says (pilotLine)', () => {
  it('welcomes riders at the gate with the next stop, how long is left and the clock', () => {
    const [line] = say(lineView(docked(), D - 3 * MIN - 37 * SEC), null);
    expect(line?.key).toBe('welcome');
    expect(line?.text).toBe('Welcome to Stop 0, gate 2. Next stop Stop 1, departing in 3 minutes, at 14:05.');
  });

  it('leaves the gate out when no number is known, and names the last stop after STOP', () => {
    const v = lineView(docked({ stopping: true }), D - 3 * MIN, { dock: { gateChange: false } });
    expect(pilotLine(v, null)?.text).toBe('Welcome to Stop 0. Next stop Stop 1, the last stop of the route, departing in 3 minutes, at 14:05.');
  });

  it('announces a gate change first, then welcomes at the new gate', () => {
    const now = D - 4 * MIN;
    const moved: PilotDock = { gate: 3, gateChange: true };
    const [a, m1] = say(lineView(docked(), now, { dock: moved }), null);
    expect(a?.text).toBe('Gate change: arriving at gate 3.');
    // Lines are spaced: nothing inside the gap.
    expect(pilotLine(lineView(docked(), now + PILOT_LINE_GAP_MS - 1, { dock: moved }), m1)).toBeNull();
    const [b, m2] = say(lineView(docked(), now + PILOT_LINE_GAP_MS, { dock: moved }), m1);
    expect(b?.text).toBe('Welcome to Stop 0, gate 3. Next stop Stop 1, departing in 3 minutes, at 14:05.');
    expect(pilotLine(lineView(docked(), now + 10 * SEC, { dock: moved }), m2)).toBeNull();
  });

  it('never announces a gate change at START: the ferry arrived nowhere', () => {
    const v = lineView(docked({ legSeq: 0 }), D - 4 * MIN, { dock: { gate: 3, gateChange: true } });
    expect(pilotLine(v, null)).toMatchObject({ key: 'welcome', text: expect.stringContaining('Welcome to Stop 0, gate 3.') });
  });

  it('a gate change with no known number just welcomes', () => {
    const v = lineView(docked(), D - 4 * MIN, { dock: { gateChange: true } });
    expect(pilotLine(v, null)?.key).toBe('welcome');
  });

  it('says nothing at a stop it has not docked at yet, then the one-minute line', () => {
    expect(pilotLine(lineView(docked(), D - 3 * MIN, { dock: null }), null)).toBeNull();
    const [line] = say(lineView(docked(), D - 55 * SEC, { dock: null }), null);
    expect(line?.text).toBe('Departing for Stop 1 in one minute.');
  });

  it('runs a whole stay: welcome, one minute, departing — each once', () => {
    let mem: PilotSpeech | null = null;
    let line: PilotLine | null;
    [line, mem] = say(lineView(docked(), D - 4 * MIN), mem);
    expect(line?.key).toBe('welcome');
    expect(say(lineView(docked(), D - 2 * MIN), mem)[0]).toBeNull();
    [line, mem] = say(lineView(docked(), D - 60 * SEC), mem);
    expect(line?.text).toBe('Departing for Stop 1 in one minute.');
    expect(say(lineView(docked(), D - 50 * SEC), mem)[0]).toBeNull();
    // Still docked at the burn (the keeper's cast-off is landing): nothing yet.
    expect(say(lineView(docked({ overdue: true }), D + SEC), mem)[0]).toBeNull();
    [line, mem] = say(lineView(flying(), D + 2 * SEC), mem);
    expect(line?.text).toBe('Departing for Stop 1.');
    expect(say(lineView(flying(), D + 8 * SEC), mem)[0]).toBeNull();
    // The next stay starts a fresh memory: its welcome is due again.
    const next = docked({ legSeq: 5, stopIndex: 1, nextStopIndex: 0, departsAt: D + 8 * MIN, scheduledAt: D + 8 * MIN });
    const [welcome] = say(lineView(next, D + 70 * SEC, { dock: { gate: 3, gateChange: false } }), mem);
    expect(welcome?.text).toBe(`Welcome to Stop 1, gate 3. Next stop Stop 0, departing in 6 minutes, at ${speakClock(D + 8 * MIN)}.`);
  });

  it('a welcome inside the last minute stands for the one-minute line; none inside the guard band', () => {
    const [line, mem] = say(lineView(docked(), D - 45 * SEC), null);
    expect(line?.text).toBe('Welcome to Stop 0, gate 2. Next stop Stop 1, departing in 45 seconds, at 14:05.');
    expect(pilotLine(lineView(docked(), D - 41 * SEC), mem)).toBeNull();
    expect(pilotLine(lineView(docked(), D - 9 * SEC), null)).toBeNull();
  });

  it('drops a line that went stale unsaid', () => {
    // The one-minute line only in its minute; departing only near the burn.
    expect(pilotLine(lineView(docked(), D - 39 * SEC, { dock: null }), null)).toBeNull();
    expect(pilotLine(lineView(flying(), D + PILOT_DEPART_LINE_MS + 1), null)).toBeNull();
    expect(pilotLine(lineView(flying(), D + PILOT_DEPART_LINE_MS), null)?.key).toBe('depart');
  });

  it('counts down to a person\'s DEPART that waits for the launch window', () => {
    const f = flying({ pilot: 'person', departedAt: D, departsAt: D });
    expect(pilotLine(lineView(f, D - 50 * SEC), null)?.text).toBe('Departing for Stop 1 in one minute.');
    expect(pilotLine(lineView(f, D - 2 * MIN), null)).toBeNull();
  });

  it('announces a hold once per hold', () => {
    const f = docked({ holding: true, holdSince: D - 6 * MIN, departsAt: null, scheduledAt: null });
    const [line, mem] = say(lineView(f, D - 5 * MIN, { dock: null }), null);
    expect(line?.text).toBe('Berth at Stop 0 is occupied. Holding until it is free.');
    expect(pilotLine(lineView(f, D - 4 * MIN, { dock: null }), mem)).toBeNull();
    const again = docked({ holding: true, holdSince: D - 3 * MIN, departsAt: null, scheduledAt: null });
    expect(pilotLine(lineView(again, D - 2 * MIN, { dock: null }), mem)?.key).toBe(`hold:${D - 3 * MIN}`);
  });

  it('after a hold, the dock brings the welcome with the new departure', () => {
    const hold = docked({ holding: true, holdSince: D - 6 * MIN, departsAt: null, scheduledAt: null });
    const [, mem] = say(lineView(hold, D - 5 * MIN, { dock: null }), null);
    const after = docked({ departsAt: D + 6 * MIN, scheduledAt: D + 6 * MIN });
    const [line] = say(lineView(after, D - 5 * SEC), mem);
    expect(line?.text).toBe(`Welcome to Stop 0, gate 2. Next stop Stop 1, departing in 6 minutes, at ${speakClock(D + 6 * MIN)}.`);
  });

  it('says why it passes a stop (§4), then counts down as usual', () => {
    const f = docked({ skipped: true });
    const [gone, mem] = say(lineView(f, D - 3 * MIN, { dock: null, skipWhy: 'gone' }), null);
    expect(gone?.text).toBe('The berth at Stop 0 has been removed. Continuing to Stop 1.');
    expect(pilotLine(lineView(f, D - 2 * MIN, { dock: null, skipWhy: 'gone' }), mem)).toBeNull();
    expect(pilotLine(lineView(f, D - 55 * SEC, { dock: null, skipWhy: 'gone' }), mem)?.key).toBe('minute');
    expect(pilotLine(lineView(f, D - 3 * MIN, { dock: null, skipWhy: 'helm' }), null)?.text)
      .toBe('We are not stopping at Stop 0. Continuing to Stop 1.');
    // A skip is not announced inside the guard band.
    expect(pilotLine(lineView(f, D - 5 * SEC, { dock: null, skipWhy: 'gone' }), null)).toBeNull();
  });

  it('announces the route\'s end: at the end stop once docked, or out of fuel', () => {
    const end = docked({ ended: 'stop', departsAt: null, scheduledAt: null });
    expect(pilotLine(lineView(end, D, { dock: null }), null)).toBeNull();
    const [line, mem] = say(lineView(end, D), null);
    expect(line?.text).toBe('Welcome to Stop 0, gate 2. This is the last stop: the route ends here.');
    expect(pilotLine(lineView(end, D + MIN), mem)).toBeNull();
    const dry = docked({ ended: 'fuel', departsAt: null, scheduledAt: null });
    expect(pilotLine(lineView(dry, D, { dock: null }), null)?.text).toBe('We are out of fuel at Stop 0. The route ends here.');
    // ⛔ Blocked: fewer than two stops left to dock at.
    const blocked = docked({ ended: 'blocked', departsAt: null, scheduledAt: null, goneStops: [1] });
    expect(pilotLine(lineView(blocked, D, { dock: null }), null)?.text)
      .toBe('The berth at Stop 1 has been removed. The route cannot go on: we stay at Stop 0.');
  });

  it('announces a departure that moved after the welcome (a restart, a takeover), and counts down to it again', () => {
    let mem: PilotSpeech | null = null;
    let line: PilotLine | null;
    [line, mem] = say(lineView(docked(), D - 4 * MIN), mem);
    [line, mem] = say(lineView(docked(), D - 55 * SEC), mem);
    expect(line?.key).toBe('minute');
    const later = D + 5 * MIN;
    const moved = docked({ departsAt: later, scheduledAt: D, overdue: false });
    [line, mem] = say(lineView(moved, D + 20 * SEC), mem);
    expect(line?.text).toBe(`Next stop Stop 1: now departing in 4 minutes, at ${speakClock(later)}.`);
    expect(say(lineView(moved, D + 30 * SEC), mem)[0]).toBeNull();
    [line] = say(lineView(moved, later - 50 * SEC), mem);
    expect(line?.text).toBe('Departing for Stop 1 in one minute.');
    // A departure that moved less than 30 s is not worth a line.
    const [, m2] = say(lineView(docked(), D - 4 * MIN), null);
    expect(pilotLine(lineView(docked({ departsAt: D + 20 * SEC }), D - 3 * MIN), m2)).toBeNull();
  });

  it('says nothing while the route is paused', () => {
    expect(pilotLine(lineView(docked({ paused: true }), D - 3 * MIN), null)).toBeNull();
  });

  it('keeps one memory per stay of one run', () => {
    const m: PilotSpeech = { run: 1, legSeq: 4, said: ['welcome'], departsAt: D, lastAt: D - MIN };
    expect(pilotSpeechAt(m, 1, 4)).toBe(m);
    expect(pilotSpeechAt(m, 1, 5)).toEqual({ run: 1, legSeq: 5, said: [], departsAt: null, lastAt: D - MIN });
    expect(pilotSpeechAt(m, 2, 4).said).toEqual([]);
    expect(pilotSpeechAt(null, 1, 0).lastAt).toBe(-Infinity);
  });
});

// ── The same lines at the helm (design §5) ──────────────────────────────────

describe("the helm's announcer (the same lines at the helm)", () => {
  it('shows each line as it falls due, once, from a memory of its own', () => {
    const t = D - 4 * MIN;
    const a0 = freshHelmAnnouncer();
    const a1 = helmAnnouncerStep(a0, lineView(docked(), t));
    expect(a1.shown).toEqual({
      text: 'Welcome to Stop 0, gate 2. Next stop Stop 1, departing in 4 minutes, at 14:05.',
      run: D - 10 * MIN,
      at: t,
    });
    // Nothing new a second later: the same object comes back (no repaint).
    expect(helmAnnouncerStep(a1, lineView(docked(), t + SEC))).toBe(a1);
    // The one-minute line replaces it when due.
    const a2 = helmAnnouncerStep(a1, lineView(docked(), D - 55 * SEC));
    expect(a2.shown?.text).toBe('Departing for Stop 1 in one minute.');
    // A robot's memory is not the helm's: a robot that said the welcome
    // leaves the helm's own welcome due.
    const [, robotMem] = say(lineView(docked(), t), null);
    expect(robotMem?.said).toContain('welcome');
    expect(helmAnnouncerStep(a0, lineView(docked(), t)).shown?.text).toMatch(/^Welcome to Stop 0/);
  });

  it('lets a line go once it is stale, at another run, while paused, and with no route', () => {
    const t = D - 4 * MIN;
    const a1 = helmAnnouncerStep(freshHelmAnnouncer(), lineView(docked(), t));
    expect(a1.shown).not.toBeNull();
    const kept = helmAnnouncerStep(a1, lineView(docked(), t + HELM_LINE_SHOW_MS - 1));
    expect(kept).toBe(a1);
    const stale = helmAnnouncerStep(a1, lineView(docked(), t + HELM_LINE_SHOW_MS));
    expect(stale.shown).toBeNull();
    expect(stale.speech).toBe(a1.speech); // the welcome stays said
    expect(helmAnnouncerStep(stale, lineView(docked(), t + HELM_LINE_SHOW_MS + SEC))).toBe(stale);

    // Another run: the old run's line goes at once, and the new run's own
    // welcome follows once the gap between lines has passed.
    const newRun = { route: running({ startedAt: D - 9 * MIN }) };
    const dropped = helmAnnouncerStep(a1, lineView(docked(), t + SEC, newRun));
    expect(dropped.shown).toBeNull();
    expect(helmAnnouncerStep(dropped, lineView(docked(), t + PILOT_LINE_GAP_MS, newRun)).shown?.run).toBe(D - 9 * MIN);
    expect(helmAnnouncerStep(a1, lineView(docked({ paused: true }), t + SEC)).shown).toBeNull();
    const none = helmAnnouncerStep(a1, null);
    expect(none).toEqual(freshHelmAnnouncer());
    expect(helmAnnouncerStep(none, null)).toBe(none);
  });

  it('shows the §4 lines a person flying with no robot captain needs', () => {
    const route = running({ robotDockId: undefined });
    const hold = helmAnnouncerStep(freshHelmAnnouncer(), lineView(
      docked({ holding: true, holdSince: D - 6 * MIN, departsAt: null, pilot: 'person' }), D - 5 * MIN, { route, dock: null },
    ));
    expect(hold.shown?.text).toBe('Berth at Stop 0 is occupied. Holding until it is free.');
    const skip = helmAnnouncerStep(freshHelmAnnouncer(), lineView(
      docked({ skipped: true, pilot: 'person' }), D - 2 * MIN, { route, dock: null, skipWhy: 'gone' },
    ));
    expect(skip.shown?.text).toBe('The berth at Stop 0 has been removed. Continuing to Stop 1.');
  });
});

// ── The skip's reason on the wire ────────────────────────────────────────────

describe('the reason a stop is skipped, on the wire (additive)', () => {
  it('round-trips a known reason and drops an unknown one, keeping the skip', () => {
    const wire = { at: D, stationId: 'st-0', departAt: D + MIN, arriveAt: D + 2 * MIN, pilot: 'robot', why: 'gone' };
    expect(checkpointFromWire('skip', 4, wire)).toMatchObject({ kind: 'skip', why: 'gone' });
    const odd = checkpointFromWire('skip', 4, { ...wire, why: 'meteor' });
    expect(odd).not.toBeNull();
    expect(odd && 'why' in odd).toBe(false);
    const back = checkpointFromWire('skip', 4, checkpointToWire(checkpointFromWire('skip', 4, wire)!));
    expect(back).toMatchObject({ why: 'gone' });
  });

  it('is written by the keeper from its pass (every gate gone, else shut) and absent when not given', () => {
    const own: StationBerth = { address: seed('room-0'), farDoor: 'x+', gate: 2 };
    const g2: StationBerth = { address: seed('room-0'), farDoor: 'y-', gate: 3 };
    const gone = (b: StationBerth): KeeperGateResult => ({ kind: 'refused', berth: b, reason: 'gone', cls: 'gone' });
    const shut = (b: StationBerth): KeeperGateResult => ({ kind: 'refused', berth: b, reason: 'not-allowed', cls: 'shut' });
    expect(skipWhyOf([gone(own), gone(g2)])).toBe('gone');
    expect(skipWhyOf([gone(own), shut(g2)])).toBe('shut');
    expect(skipWhyOf([])).toBe('shut');

    const r = running({ startedAt: D - 10 * MIN });
    const now = D - 3 * MIN;
    const f = docked();
    const v: KeeperView = {
      now, route: r, flight: f,
      port: { state: 'undocked', busy: false, atStop: false, atOtherStop: false },
      docks: { atStop: null, atNext: null, elsewhere: 0 },
      hold: null, stayDock: false,
      memory: { ...freshKeeperMemory(r.startedAt, f.legSeq), passing: true },
    };
    const written = keeperAfterPass(v, { legSeq: f.legSeq, verdict: { kind: 'skip' }, skipWhy: 'gone' }).write;
    expect(written?.entry).toMatchObject({ kind: 'skip', why: 'gone' });
    const plain = keeperAfterPass(v, { legSeq: f.legSeq, verdict: { kind: 'skip' } }).write;
    expect(plain?.entry && 'why' in plain.entry).toBe(false);
    expect(skipCheckpoint(r, 4, { at: now, pilot: 'robot', why: 'helm' })).toMatchObject({ why: 'helm' });
  });
});

// ── The readers over a real ship doc ─────────────────────────────────────────

describe('the captain\'s readers over a running ferry', () => {
  const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
  let now = T0;
  const clock = () => now;
  let uninstall: (() => void) | null = null;

  const liveDock = (): LiveDockAt => {
    const docks: Array<{ roomId: string; dockedAt: number }> = [];
    for (const [, rec] of readAllDoors()) {
      if (rec.paired !== true) continue;
      const st = classifyDockPort(rec);
      if (st.kind === 'docked') docks.push({ roomId: st.roomId, dockedAt: rec.dockedAt ?? 0 });
    }
    return liveDockFrom(docks);
  };

  beforeEach(() => {
    now = T0;
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    setBerthSeedResolver((room) => seed(room));
    uninstall = installRouteFlight({ capacity: () => CAP, liveDock, clock });
    writeDoorPairing('x-', seed('room-0'), buildDoorPairing(seed('room-0'), {
      segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: T0 - MIN,
    }));
    const saved = running({ homeRefuel: true });
    delete (saved as ShipRoute).startedAt;
    delete (saved as ShipRoute).startStop;
    expect(writeShipRoute(saved)).toBe(true);
    writeFuelLevel(CAP, CAP);
  });
  afterEach(() => {
    uninstall?.();
    setBerthSeedResolver(null);
  });

  it('reads nothing and locks nothing before START', () => {
    expect(readPilotView(now)).toBeNull();
    expect(readRouteCaptainDockId()).toBeNull();
    expect(readCaptainLock('dock-1')).toBeNull();
  });

  it('welcomes riders at the berth it is docked at, and locks the captain until the route finishes', () => {
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: CAP, capacity: CAP })).toBe(T0);
    now = T0 + 5 * SEC;
    const v = readPilotView(now)!;
    expect(v).not.toBeNull();
    expect(v.dock).toEqual({ gate: 2, gateChange: false });
    expect(v.skipWhy).toBeNull();
    expect(pilotPost(v.f, now)).toBe('door');
    const line = pilotLine(v, null)!;
    expect(line.text).toBe(
      `Welcome to Stop 0, gate 2. Next stop Stop 1, departing ${speakLeft(v.f.departsAt! - now)}, at ${speakClock(v.f.departsAt!)}.`,
    );
    expect(readRouteCaptainDockId()).toBe('dock-1');
    expect(readCaptainLock('dock-1')).toBe(CAPTAIN_LOCK_REFUSAL);
    expect(readCaptainLock('dock-2')).toBeNull();
    // STOP pressed: still running (the ferry finishes its stay), still locked.
    expect(stopShipRoute(now)).toBe(true);
    expect(readCaptainLock('dock-1')).toBe(CAPTAIN_LOCK_REFUSAL);
    expect(finishShipRoute()).toBe(true);
    expect(readCaptainLock('dock-1')).toBeNull();
    expect(readPilotView(now)).toBeNull();
  });

  it('knows a SKIP STOP from the helm is not a removed berth', () => {
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: CAP, capacity: CAP })).toBe(T0);
    now = T0 + 5 * SEC;
    expect(skipRouteStop({ now })).toBe(true);
    expect(readRouteCheckpoints().find((e) => e.kind === 'skip')).toMatchObject({ why: 'helm' });
    const v = readPilotView(now)!;
    expect(v.f.skipped).toBe(true);
    expect(v.skipWhy).toBe('helm');
    expect(pilotPost(v.f, now)).toBe('helm');
  });

  it('reads no dock while the port is docked away from the stop', () => {
    writeDoorPairing('x-', seed('room-9'), buildDoorPairing(seed('room-9'), {
      segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: T0 - MIN,
    }));
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: CAP, capacity: CAP })).toBe(T0);
    now = T0 + 5 * SEC;
    const v = readPilotView(now);
    expect(v?.dock ?? null).toBeNull();
  });
});
