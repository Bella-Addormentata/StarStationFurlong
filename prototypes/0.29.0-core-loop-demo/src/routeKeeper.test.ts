/**
 * 🚏🛟 Route keeper — docking and casting off a ferry on its timetable
 * (build notes A5, the gate parts of A9): what one tick does for each
 * difference between the timetable and the live docks (cast off on time,
 * restart a stay found docked late, end a hold on the dock's own stamp, the
 * guard band, back-off, renewals, STOP during a hold, a person who departs by
 * hand), the rider carve-out, the gate list (the stop's own berth first, PR
 * 177's order after it, a pinned stop), what each station answer counts as
 * (a granted-captains gate is this rider's verdict alone), the verdict of a
 * whole pass, what a pass writes, the helm's lines — and whole ferry trips
 * over real ship + doors docs with a stand-in docking system.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { berthMemoryFrom, classifyDockPort, dockAnswerOf, redockRecord, stampAfter } from './dockRules';
import type { DockAnswer } from './dockRules';
import { dockChain } from './adapter';
import {
  bindDoorsDoc,
  buildDoorPairing,
  readAllDoors,
  readDoor,
  writeDoorPairing,
  writeDoorTombstone,
} from './doorsDoc';
import {
  GUARD_BAND_MS,
  HOLD_UNWATCHED_MS,
  dockCheckpoint,
  holdCheckpoint,
  legWindowAfter,
  liveDockFrom,
  pauseCheckpoint,
  routeFlightAt,
  skipCheckpoint,
  startCheckpoint,
} from './pilotRoute';
import type { LiveDockAt, RouteFlight } from './pilotRoute';
import {
  CAST_OFF_LATE_MS,
  HOLD_RENEW_MS,
  KEEPER_RETRY_MAX_MS,
  KEEPER_RETRY_MS,
  KEEPER_WRITE_GAP_MS,
  classifyKeeperRefusal,
  createRouteKeeper,
  freshKeeperMemory,
  keeperAfterPass,
  keeperBerths,
  keeperMayOperate,
  keeperMemoryAt,
  keeperNote,
  keeperStep,
  ownStopBerth,
  passVerdict,
  personDeparts,
  runKeeperPass,
  standingHold,
  stayHasDock,
  stayResumed,
} from './routeKeeper';
import type { KeeperGateResult, KeeperMemory, KeeperView } from './routeKeeper';
import { arrivalRefusal, setBerthSeedResolver, type ShipDockingApi } from './shipArrival';
import { bindShipDoc, readStationBerth, writeFuelLevel } from './shipDoc';
import {
  installRouteFlight,
  readRouteCheckpoints,
  readRouteFlight,
  readShipRoute,
  startShipRoute,
  stopShipRoute,
  writeRouteCheckpoint,
  writeShipRoute,
} from './shipRoute';
import type { HoldCheckpoint, RouteCheckpoint, RouteStop, ShipRoute, StartCheckpoint } from './shipRoute';
import type { StationBerth } from './stationDirectory';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const BIG = 1e6;
const CAP = 100;

const seed = (room: string) => `ssf://room#room=${room}`;

function stop(i: number, slot: number, over: Partial<RouteStop> = {}): RouteStop {
  return {
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    berth: { roomId: `room-${i}`, farDoor: 'x+', anyGate: true },
    waitSecs: 60,
    ...over,
  };
}

/** The owner's 0 ↔ 1 ferry, running from T0 at stop 0. */
function running(over: Partial<ShipRoute> = {}): ShipRoute & { startedAt: number } {
  return {
    stops: [stop(0, 0), stop(1, 1)],
    shape: 'backAndForth',
    shipPort: 'x-',
    robotDockId: 'dock-1',
    startedAt: T0,
    startStop: 0,
    ...over,
  } as ShipRoute & { startedAt: number };
}

function startOf(r: ShipRoute): StartCheckpoint {
  const s = startCheckpoint(r, { at: r.startedAt!, pilot: 'robot', fuel: BIG });
  if (!s) throw new Error('start leg not plannable');
  return s;
}

function flightAt(r: ShipRoute, ckpts: readonly RouteCheckpoint[], now: number, liveDock: LiveDockAt | null = null): RouteFlight {
  const f = routeFlightAt(r, ckpts, liveDock, now, BIG);
  if (!f) throw new Error('no timetable');
  return f;
}

/** A live dock at stop `i` made at `dockedAt`. */
const dockedAtStop = (i: number, dockedAt: number): LiveDockAt => (_s, idx) => (idx === i ? dockedAt : null);

const UNDOCKED_PORT = { state: 'undocked' as const, busy: false, atStop: false, atOtherStop: false };
const DOCKED_HERE = { state: 'docked' as const, busy: false, atStop: true, atOtherStop: false };

function view(
  r: ShipRoute & { startedAt: number },
  f: RouteFlight,
  now: number,
  over: Partial<KeeperView> = {},
): KeeperView {
  return {
    now,
    route: r,
    flight: f,
    port: UNDOCKED_PORT,
    docks: { atStop: null, atNext: null, elsewhere: 0 },
    hold: null,
    stayDock: false,
    memory: freshKeeperMemory(r.startedAt, f.legSeq),
    ...over,
  };
}

// Timetable landmarks of the fixture ferry.
const R = running();
const S = startOf(R);
const LEG1 = legWindowAfter(R, 1, S.arriveAt + 60 * SEC)!;

describe('reading the stay', () => {
  const hold = holdCheckpoint(R, 1, { at: S.arriveAt + 5 * SEC });

  it('finds the hold that still stands, and none once a dock, go, skip or pause is as new', () => {
    expect(standingHold([S, hold], 1)).toEqual(hold);
    expect(standingHold([S, hold], 0)).toBeNull();
    const dock = dockCheckpoint(R, 1, { at: hold.at, pilot: 'robot' })!;
    expect(standingHold([S, hold, dock], 1)).toBeNull(); // a tie goes to the dock
    const older = dockCheckpoint(R, 1, { at: hold.at - 1, pilot: 'robot' })!;
    expect(standingHold([S, hold, older], 1)).toEqual(hold);
    expect(standingHold([S, hold, skipCheckpoint(R, 1, { at: hold.at + 1, pilot: 'robot' })!], 1)).toBeNull();
  });

  it('knows whether a stay carries a dock entry', () => {
    expect(stayHasDock([S, hold], 1)).toBe(false);
    expect(stayHasDock([S, dockCheckpoint(R, 1, { at: hold.at, pilot: 'robot' })!], 1)).toBe(true);
  });

  it('keeps its memory for one stay and starts fresh for the next', () => {
    const m = freshKeeperMemory(T0, 1);
    m.verdict = 'hold';
    expect(keeperMemoryAt(m, T0, 1)).toBe(m);
    expect(keeperMemoryAt(m, T0, 2).verdict).toBeNull();
    expect(keeperMemoryAt(m, T0 + 1, 1).verdict).toBeNull();
    expect(keeperMemoryAt(null, T0, 1)).toEqual(freshKeeperMemory(T0, 1));
  });
});

describe('one tick of the keeper', () => {
  it('does nothing while docked on time', () => {
    const now = S.departAt - 30 * SEC;
    const f = flightAt(R, [S], now, dockedAtStop(0, T0 - SEC));
    expect(keeperStep(view(R, f, now, { port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'idle', why: 'docked' });
  });

  it('casts off on time, up to 10 s after the departure, and the leg stands', () => {
    for (const late of [0, 3 * SEC, CAST_OFF_LATE_MS]) {
      const now = S.departAt + late;
      const f = flightAt(R, [S], now, dockedAtStop(0, T0 - SEC));
      expect(f.status).toBe('docked'); // the live dock holds it
      expect(keeperStep(view(R, f, now, { port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })))
        .toEqual({ kind: 'cast-off', why: 'departure' });
    }
  });

  it('restarts the stay when it finds the ferry still docked later than that', () => {
    const now = S.departAt + 45 * SEC;
    const f = flightAt(R, [S], now, dockedAtStop(0, T0 - SEC));
    const step = keeperStep(view(R, f, now, { port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } }));
    expect(step.kind).toBe('write');
    if (step.kind !== 'write') return;
    expect(step.why).toBe('restart');
    expect(step.entry).toMatchObject({ kind: 'dock', legSeq: 0, at: now, stayStart: now, stationId: 'st-0', pilot: 'robot' });
    const w = legWindowAfter(R, 0, now + 60 * SEC)!;
    expect(step.entry).toMatchObject({ departAt: w.departAt, arriveAt: w.arriveAt });
    // The restarted stay casts off at its own departure.
    const after = [S, step.entry];
    const f2 = flightAt(R, after, w.departAt + SEC, dockedAtStop(0, T0 - SEC));
    expect(keeperStep(view(R, f2, w.departAt + SEC, { port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'cast-off', why: 'departure' });
  });

  it('never writes the same restart twice within a few seconds', () => {
    const now = S.departAt + 45 * SEC;
    const f = flightAt(R, [S], now, dockedAtStop(0, T0 - SEC));
    const memory = freshKeeperMemory(T0, 0);
    memory.wroteAt.restart = now - SEC;
    expect(keeperStep(view(R, f, now, { memory, port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'idle', why: 'wrote-recently' });
    memory.wroteAt.restart = now - KEEPER_WRITE_GAP_MS;
    expect(keeperStep(view(R, f, now, { memory, port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })).kind)
      .toBe('write');
  });

  it('casts off anything still docked while the timetable has the ferry in flight', () => {
    const now = S.departAt + 20 * SEC;
    const f = flightAt(R, [S], now);
    expect(f.status).toBe('in-flight');
    expect(keeperStep(view(R, f, now, { docks: { atStop: S.departAt + SEC, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'cast-off', why: 'in-flight' });
    expect(keeperStep(view(R, f, now, { docks: { atStop: null, atNext: null, elsewhere: 1 } })))
      .toEqual({ kind: 'cast-off', why: 'in-flight' });
    expect(keeperStep(view(R, f, now))).toEqual({ kind: 'idle', why: 'in-flight' });
  });

  it('leaves a dock at the destination alone when a peer whose clock runs ahead made it on arrival', () => {
    const now = S.arriveAt - 20 * SEC;
    const f = flightAt(R, [S], now);
    expect(keeperStep(view(R, f, now, { docks: { atStop: null, atNext: S.arriveAt, elsewhere: 0 } })))
      .toEqual({ kind: 'idle', why: 'arriving' });
    // A dock at the destination long before the ferry can be there is cast
    // off (a leg longer than the clock skew allowance).
    const early = S.departAt + SEC;
    const long = { ...flightAt(R, [S], early), arrivesAt: early + 5 * MIN };
    expect(keeperStep(view(R, long, early, { docks: { atStop: null, atNext: early, elsewhere: 0 } })))
      .toEqual({ kind: 'cast-off', why: 'in-flight' });
  });

  it('docks on arrival, one pass at a time, never in the guard band or during a back-off', () => {
    const now = S.arriveAt + SEC;
    const f = flightAt(R, [S], now);
    expect(f).toMatchObject({ status: 'docked', legSeq: 1, stopIndex: 1 });
    expect(keeperStep(view(R, f, now))).toEqual({ kind: 'dock' });
    const passing = { ...freshKeeperMemory(T0, 1), passing: true };
    expect(keeperStep(view(R, f, now, { memory: passing }))).toEqual({ kind: 'idle', why: 'passing' });
    const waiting = { ...freshKeeperMemory(T0, 1), nextPassAt: now + SEC };
    expect(keeperStep(view(R, f, now, { memory: waiting }))).toEqual({ kind: 'idle', why: 'backoff' });
    expect(keeperStep(view(R, f, now, { port: { ...UNDOCKED_PORT, busy: true } }))).toEqual({ kind: 'idle', why: 'port-busy' });
    const band = f.departsAt! - GUARD_BAND_MS;
    const fb = flightAt(R, [S], band);
    expect(keeperStep(view(R, fb, band))).toEqual({ kind: 'idle', why: 'guard-band' });
    expect(keeperStep(view(R, flightAt(R, [S], band - 1), band - 1))).toEqual({ kind: 'dock' });
  });

  it('undocks the route port first when it is docked at another stop', () => {
    const now = S.arriveAt + SEC;
    const f = flightAt(R, [S], now);
    const port = { state: 'docked' as const, busy: false, atStop: false, atOtherStop: true };
    expect(keeperStep(view(R, f, now, { port, docks: { atStop: null, atNext: null, elsewhere: 1 } })))
      .toEqual({ kind: 'cast-off', why: 'wrong-stop' });
    // A dock this game cannot place is not undocked at a stop.
    expect(keeperStep(view(R, f, now, { port: { ...port, atOtherStop: false }, docks: { atStop: null, atNext: null, elsewhere: 1 } })).kind)
      .toBe('dock');
  });

  describe('holding at a taken berth', () => {
    const since = S.arriveAt + 5 * SEC;
    const hold = holdCheckpoint(R, 1, { at: since });

    it('ends the hold on the dock, the stay starting at the dock\'s own stamp', () => {
      const now = since + 40 * SEC;
      const dockedAt = since + 30 * SEC;
      const f = flightAt(R, [S, hold], now, dockedAtStop(1, dockedAt));
      expect(f.holding).toBe(true);
      const step = keeperStep(view(R, f, now, { hold, port: DOCKED_HERE, docks: { atStop: dockedAt, atNext: null, elsewhere: 0 } }));
      expect(step.kind === 'write' && step.why).toBe('end-hold');
      if (step.kind !== 'write') return;
      expect(step.entry).toMatchObject({ kind: 'dock', legSeq: 1, at: now, stayStart: dockedAt });
      const g = flightAt(R, [S, hold, step.entry], now, dockedAtStop(1, dockedAt));
      expect(g.holding).toBe(false);
      expect(g.departsAt).toBe(legWindowAfter(R, 1, dockedAt + 60 * SEC)!.departAt);
    });

    it('keeps an unstamped dock\'s stay inside the stay (never before the arrival, never after now)', () => {
      const now = since + 40 * SEC;
      const f = flightAt(R, [S, hold], now, dockedAtStop(1, 0));
      const step = keeperStep(view(R, f, now, { hold, port: DOCKED_HERE, docks: { atStop: 0, atNext: null, elsewhere: 0 } }));
      expect(step.kind === 'write' && step.entry).toMatchObject({ stayStart: S.arriveAt });
      const ahead = keeperStep(view(R, f, now, { hold, port: DOCKED_HERE, docks: { atStop: now + 30 * SEC, atNext: null, elsewhere: 0 } }));
      expect(ahead.kind === 'write' && ahead.entry).toMatchObject({ stayStart: now });
    });

    it('renews the hold each minute while this game still sees the berth refuse', () => {
      const now = since + HOLD_RENEW_MS;
      const f = flightAt(R, [S, hold], now);
      const memory = { ...freshKeeperMemory(T0, 1), verdict: 'hold' as const, nextPassAt: now + 30 * SEC };
      const step = keeperStep(view(R, f, now, { hold, memory }));
      expect(step).toEqual({ kind: 'write', why: 'renew-hold', entry: { ...hold, seenAt: now } });
      // Not yet a minute, or this game never saw the refusal: no renewal.
      expect(keeperStep(view(R, f, now - SEC, { hold, memory })).kind).toBe('idle');
      expect(keeperStep(view(R, f, now, { hold, memory: { ...memory, verdict: 'none' } })).kind).toBe('idle');
    });

    it('lets a hold nobody renews end: the stay is passed undocked', () => {
      const now = since + HOLD_UNWATCHED_MS + SEC;
      const f = flightAt(R, [S, hold], now);
      expect(f.skipped).toBe(true);
      expect(keeperStep(view(R, f, now, { hold }))).toEqual({ kind: 'idle', why: 'skipped' });
    });

    it('stops retrying at once when STOP comes during the hold', () => {
      const now = since + 20 * SEC;
      const stopped = { ...R, stoppedAt: now };
      const f = flightAt(stopped, [S, hold], now + SEC);
      expect(f).toMatchObject({ ended: 'stop', holding: false, legSeq: 1 });
      expect(keeperStep(view(stopped, f, now + SEC, { hold }))).toEqual({ kind: 'idle', why: 'stopped-in-hold' });
    });
  });

  it('docks once at the end stop after STOP, and never casts off there', () => {
    const now = S.arriveAt + SEC;
    const stopped = { ...R, stoppedAt: S.departAt + 5 * SEC };
    const f = flightAt(stopped, [S], now);
    expect(f).toMatchObject({ ended: 'stop', stopIndex: 1 });
    expect(keeperStep(view(stopped, f, now))).toEqual({ kind: 'dock' });
    const answered = { ...freshKeeperMemory(T0, 1), verdict: 'none' as const };
    expect(keeperStep(view(stopped, f, now, { memory: answered }))).toEqual({ kind: 'idle', why: 'answered' });
    const later = now + 30 * MIN;
    const g = flightAt(stopped, [S], later, dockedAtStop(1, now));
    expect(keeperStep(view(stopped, g, later, { port: DOCKED_HERE, docks: { atStop: now, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'idle', why: 'ended' });
  });

  it('leaves the departure to a person at the helm when no robot captain will take over', () => {
    const people: ShipRoute & { startedAt: number } = { ...running(), robotDockId: undefined };
    delete people.robotDockId;
    const s = startCheckpoint(people, { at: T0, pilot: 'person', fuel: BIG })!;
    const now = s.departAt + 5 * MIN;
    const f = flightAt(people, [s], now, dockedAtStop(0, T0 - SEC));
    expect(personDeparts(f)).toBe(true);
    expect(f.overdue).toBe(true);
    expect(keeperStep(view(people, f, now, { port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'idle', why: 'person-departs' });
  });

  it('casts off for the robot captain once it takes over from a person who let the departure pass', () => {
    const s = startCheckpoint(R, { at: T0, pilot: 'person', fuel: BIG })!;
    const before = s.departAt + MIN;
    const f = flightAt(R, [s], before, dockedAtStop(0, T0 - SEC));
    expect(personDeparts(f)).toBe(false);
    const docked = { port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } };
    expect(keeperStep(view(R, f, before, docked))).toEqual({ kind: 'idle', why: 'docked' });
    const g = flightAt(R, [s], f.departsAt! + SEC, dockedAtStop(0, T0 - SEC));
    expect(keeperStep(view(R, g, f.departsAt! + SEC, docked))).toEqual({ kind: 'cast-off', why: 'departure' });
  });

  it('does nothing while the route is paused', () => {
    const now = S.departAt - 30 * SEC;
    const f = { ...flightAt(R, [S], now), paused: true };
    expect(keeperStep(view(R, f, now))).toEqual({ kind: 'idle', why: 'paused' });
  });

  it('🛟 neither casts off nor restarts while a pairing it may not release holds the ferry', () => {
    const docks = { atStop: T0 - SEC, atNext: null, elsewhere: 1, stuck: 1 };
    for (const late of [2 * SEC, 45 * SEC, 10 * MIN]) {
      const now = S.departAt + late;
      const f = flightAt(R, [S], now, dockedAtStop(0, T0 - SEC));
      expect(keeperStep(view(R, f, now, { port: DOCKED_HERE, docks }))).toEqual({ kind: 'idle', why: 'held' });
    }
    // Before the departure it is docked as usual.
    const early = S.departAt - 30 * SEC;
    expect(keeperStep(view(R, flightAt(R, [S], early, dockedAtStop(0, T0 - SEC)), early, { port: DOCKED_HERE, docks })))
      .toEqual({ kind: 'idle', why: 'docked' });
  });

  it('🚚 leaves a tug towing a station alone', () => {
    const now = S.departAt + 2 * SEC;
    const f = flightAt(R, [S], now, dockedAtStop(0, T0 - SEC));
    expect(keeperStep(view(R, f, now, { towing: true, port: DOCKED_HERE, docks: { atStop: T0 - SEC, atNext: null, elsewhere: 0 } })))
      .toEqual({ kind: 'idle', why: 'towing' });
  });

  describe('🔁 a RESUMEd stay', () => {
    const pause = pauseCheckpoint(R, 1, { at: S.arriveAt + 10 * SEC });
    const resume = dockCheckpoint(R, 2, { at: pause.at + 90 * SEC, pilot: 'robot', resume: true })!;
    const all = [S, pause, resume];

    it('is known by its dock entry', () => {
      expect(stayResumed(all, 2)).toBe(true);
      expect(stayResumed([S, dockCheckpoint(R, 2, { at: resume.at, pilot: 'robot' })!], 2)).toBe(false);
    });

    it('keeps its mark when the keeper restarts it, so the route still reads resumed', () => {
      const late = resume.departAt + 45 * SEC;
      const live = dockedAtStop(0, resume.at);
      const f = flightAt(R, all, late, live);
      expect(f).toMatchObject({ legSeq: 2, status: 'docked', overdue: true, paused: false });
      const step = keeperStep(view(R, f, late, {
        port: DOCKED_HERE, docks: { atStop: resume.at, atNext: null, elsewhere: 0 }, stayDock: true, stayResume: true,
      }));
      expect(step).toMatchObject({ kind: 'write', why: 'restart', entry: { kind: 'dock', legSeq: 2, resume: true, at: late, stayStart: late } });
      if (step.kind !== 'write') return;
      // The rewrite takes the RESUME's key: still resumed, the stay restarted.
      expect(flightAt(R, [S, pause, step.entry], late + SEC, live)).toMatchObject({ paused: false, legSeq: 2, stayStart: late });
      // A plain dock there (the bug) would read paused again.
      const plain = dockCheckpoint(R, 2, { at: late, stayStart: late, pilot: 'robot' })!;
      expect(flightAt(R, [S, pause, plain], late + SEC, live).paused).toBe(true);
    });

    it('keeps its mark when a dock ends a hold there, stamped no earlier than the hold', () => {
      const hold = holdCheckpoint(R, 2, { at: resume.at + 20 * SEC });
      const dockedAt = hold.at + 30 * SEC;
      const now = dockedAt + 5 * SEC;
      const f = flightAt(R, [...all, hold], now, dockedAtStop(0, dockedAt));
      expect(f.holding).toBe(true);
      const step = keeperStep(view(R, f, now, {
        hold, port: DOCKED_HERE, docks: { atStop: dockedAt, atNext: null, elsewhere: 0 }, stayDock: true, stayResume: true,
      }));
      expect(step).toMatchObject({ kind: 'write', why: 'end-hold', entry: { kind: 'dock', legSeq: 2, resume: true, at: dockedAt, stayStart: dockedAt } });
      if (step.kind !== 'write') return;
      const g = flightAt(R, [S, pause, step.entry, hold], now, dockedAtStop(0, dockedAt));
      expect(g).toMatchObject({ paused: false, holding: false, legSeq: 2, stayStart: dockedAt });
    });
  });
});

describe('the rider carve-out', () => {
  const may = (now: number, op: 'dock' | 'undock', farAtStop: boolean, o: { ckpts?: RouteCheckpoint[]; live?: LiveDockAt | null; doorId?: string; route?: ShipRoute } = {}) => {
    const route = o.route ?? R;
    return keeperMayOperate({
      route,
      flight: routeFlightAt(route, o.ckpts ?? [S], o.live ?? null, now, BIG),
      now,
      doorId: o.doorId ?? 'x-',
      op,
      farAtStop,
    });
  };

  it('lets a rider dock only the route\'s port, only toward the current stop, before the guard band', () => {
    const now = S.arriveAt + SEC;
    expect(may(now, 'dock', true)).toBe(true);
    expect(may(now, 'dock', false)).toBe(false);
    expect(may(now, 'dock', true, { doorId: 'y+' })).toBe(false);
    expect(may(LEG1.departAt - GUARD_BAND_MS, 'dock', true)).toBe(false);
    expect(may(S.departAt + 20 * SEC, 'dock', true)).toBe(false); // in flight
  });

  it('lets a rider undock it in flight, at the wrong stop, or once the departure has come', () => {
    expect(may(S.departAt + 20 * SEC, 'undock', true)).toBe(true);
    expect(may(S.departAt - 20 * SEC, 'undock', false, { live: dockedAtStop(0, T0) })).toBe(true);
    expect(may(S.departAt - 20 * SEC, 'undock', true, { live: dockedAtStop(0, T0) })).toBe(false);
    expect(may(S.departAt + 2 * SEC, 'undock', true, { live: dockedAtStop(0, T0) })).toBe(true);
  });

  it('grants nothing when no route runs', () => {
    const idleRoute: ShipRoute = { ...R };
    delete idleRoute.startedAt;
    expect(keeperMayOperate({ route: idleRoute, flight: null, now: T0, doorId: 'x-', op: 'dock', farAtStop: true })).toBe(false);
  });
});

// ── Gates ────────────────────────────────────────────────────────────────────

const gateAt = (room: string, farDoor: string, gate: number, over: Partial<StationBerth> = {}): StationBerth =>
  ({ address: seed(room), farDoor, gate, ...over });

describe('the gate list', () => {
  const pinnedStop = stop(1, 1, { berth: { roomId: 'room-1', farDoor: 'x+', gate: 1, anyGate: false } });
  const anyStop = stop(1, 1, { berth: { roomId: 'room-1', farDoor: 'x+', gate: 1, anyGate: true } });
  const station = {
    berths: [
      gateAt('room-1', 'x+', 1),
      gateAt('room-2', 'south', 2, { occupied: true }),
      gateAt('room-2', 'east', 3, { access: 'pass' }),
      gateAt('room-3', 'west', 4, { access: 'closed' }),
      gateAt('room-3', 'north', 5),
    ],
  };
  const own = ownStopBerth(anyStop, seed('room-1'));

  it('tries the stop\'s own berth first, then the station\'s gates in arrival order', () => {
    const list = keeperBerths({ stop: anyStop, own, station, shipRoomId: 'ship-1' });
    expect(list.map((b) => b.gate)).toEqual([1, 5, 2, 3]);
  });

  it('tries only the stop\'s own gate when the stop pins it', () => {
    expect(keeperBerths({ stop: pinnedStop, own: ownStopBerth(pinnedStop, seed('room-1')), station, shipRoomId: 'ship-1' })
      .map((b) => b.gate)).toEqual([1]);
  });

  it('asks the station\'s gates alone when this game holds no pass for the stop\'s room', () => {
    expect(keeperBerths({ stop: anyStop, own: null, station, shipRoomId: 'ship-1' }).map((b) => b.gate)).toEqual([1, 5, 2, 3]);
    expect(keeperBerths({ stop: pinnedStop, own: null, station, shipRoomId: 'ship-1' })).toEqual([]);
  });

  it('uses the route\'s copy for its own berth, knowing what the station says about that door', () => {
    const list = keeperBerths({
      stop: anyStop,
      own,
      station: { berths: [gateAt('room-1', 'x+', 1, { access: 'pass' })] },
      shipRoomId: 'ship-1',
    });
    expect(list).toEqual([{ address: seed('room-1'), farDoor: 'x+', gate: 1, access: 'pass' }]);
    // A station that lists nothing: the copy alone.
    expect(keeperBerths({ stop: anyStop, own, station: null, shipRoomId: 'ship-1' })).toEqual([own]);
  });

  it('asks its own gate last when the station list says it is shut to this ship', () => {
    const list = keeperBerths({
      stop: anyStop,
      own,
      station: { berths: [gateAt('room-1', 'x+', 1, { access: 'closed' }), gateAt('room-3', 'north', 5)] },
      shipRoomId: 'ship-1',
    });
    expect(list.map((b) => b.gate)).toEqual([5, 1]);
    // Pinned, it is the only gate there is.
    expect(keeperBerths({
      stop: pinnedStop,
      own: ownStopBerth(pinnedStop, seed('room-1')),
      station: { berths: [gateAt('room-1', 'x+', 1, { access: 'reserved', reservedFor: 'ship-9' })] },
      shipRoomId: 'ship-1',
    }).map((b) => b.gate)).toEqual([1]);
  });

  it('puts the ship\'s own reserved gate before open ones, and leaves out another ship\'s', () => {
    const list = keeperBerths({
      stop: anyStop,
      own: null,
      station: {
        berths: [
          gateAt('room-2', 'a', 2),
          gateAt('room-2', 'b', 3, { access: 'reserved', reservedFor: 'ship-9' }),
          gateAt('room-2', 'c', 4, { access: 'reserved', reservedFor: 'ship-1' }),
        ],
      },
      shipRoomId: 'ship-1',
    });
    expect(list.map((b) => b.gate)).toEqual([4, 2]);
  });
});

describe('what a station answer counts as', () => {
  it('reads taken, shut, gone, this rider\'s own verdict, and the port\'s', () => {
    expect(classifyKeeperRefusal({ reason: 'occupied' })).toBe('taken');
    expect(classifyKeeperRefusal({ reason: 'overlap' })).toBe('taken');
    expect(classifyKeeperRefusal({ reason: 'gone' })).toBe('gone');
    expect(classifyKeeperRefusal({ reason: 'closed' })).toBe('gone');
    // PR 177: no port on the far door, and no gate number left to fit one.
    expect(classifyKeeperRefusal({ reason: 'no-gate' })).toBe('gone');
    expect(classifyKeeperRefusal({ reason: 'not-allowed', gateAccess: 'closed' })).toBe('shut');
    expect(classifyKeeperRefusal({ reason: 'not-allowed', gateAccess: 'reserved' })).toBe('shut');
    // A granted-captains gate checks this game's key: never the ship's verdict.
    expect(classifyKeeperRefusal({ reason: 'not-allowed', gateAccess: 'pass' })).toBe('rider');
    expect(classifyKeeperRefusal({ reason: 'not-allowed' }, 'pass')).toBe('rider');
    expect(classifyKeeperRefusal({ reason: 'not-allowed' }, 'closed')).toBe('shut');
    expect(classifyKeeperRefusal({ reason: 'not-allowed' })).toBe('rider');
    for (const reason of ['unreachable', 'no-address', 'no-far-door', 'no-writer', 'refused'] as const) {
      expect(classifyKeeperRefusal({ reason })).toBe('rider');
    }
    for (const reason of ['busy', 'no-port', 'in-flight', 'no-rights', 'changed', 'superseded'] as const) {
      expect(classifyKeeperRefusal({ reason })).toBe('port');
    }
  });

  it('reads older docking APIs\' answers too', () => {
    expect(dockAnswerOf(undefined)).toEqual({ ok: true });
    expect(dockAnswerOf(true)).toEqual({ ok: true });
    expect(dockAnswerOf(false)).toEqual({ ok: false, reason: 'refused' });
    expect(dockAnswerOf({ ok: true, dockedAt: 5 })).toEqual({ ok: true, dockedAt: 5 });
    expect(dockAnswerOf({ ok: false, reason: 'occupied' })).toEqual({ ok: false, reason: 'occupied' });
    expect(dockAnswerOf({ ok: false })).toEqual({ ok: false, reason: 'refused' });
    expect(dockAnswerOf(null)).toEqual({ ok: false, reason: 'refused' });
  });

  it('says why a whole arrival refused (the helm\'s arrival note)', () => {
    expect(arrivalRefusal([])).toBe('berths-taken');
    expect(arrivalRefusal(['occupied', 'refused'])).toBe('berths-taken');
    expect(arrivalRefusal(['gone', 'closed'])).toBe('berth-gone');
    expect(arrivalRefusal(['gone', 'occupied', 'unreachable'])).toBe('occupied');
    expect(arrivalRefusal(['not-allowed'])).toBe('occupied');
    expect(arrivalRefusal(['unreachable', 'no-address', 'gone'])).toBe('unreachable');
    expect(arrivalRefusal(['no-rights'])).toBe('berths-taken');
  });
});

describe('the verdict of a pass', () => {
  const own = gateAt('room-1', 'x+', 1);
  const g2 = gateAt('room-2', 'south', 2);
  const g3 = gateAt('room-2', 'east', 3, { access: 'pass' });
  type Refusal = Extract<KeeperGateResult, { kind: 'refused' }>['reason'];
  const refused = (berth: StationBerth, reason: Refusal, gateAccess?: 'pass' | 'reserved' | 'closed'): KeeperGateResult =>
    ({ kind: 'refused', berth, reason, cls: reason === 'no-port' ? 'port' : classifyKeeperRefusal({ reason, gateAccess }, berth.access) });

  it('docked: at its own gate, or a gate change', () => {
    expect(passVerdict([{ kind: 'docked', berth: own, dockedAt: 9 }], own)).toEqual({ kind: 'docked', gate: 1, gateChange: false, dockedAt: 9 });
    expect(passVerdict([refused(own, 'occupied'), { kind: 'docked', berth: g2 }], own)).toEqual({ kind: 'docked', gate: 2, gateChange: true });
  });

  it('holds only when every gate was tried and one is taken', () => {
    expect(passVerdict([refused(own, 'occupied'), refused(g2, 'occupied')], own)).toEqual({ kind: 'hold' });
    // A gate only a granted rider may use does not stop the hold: that rider's
    // own keeper docks there, and its dock ends the hold.
    expect(passVerdict([refused(own, 'occupied'), refused(g3, 'not-allowed', 'pass')], own)).toEqual({ kind: 'hold' });
    // A pass the port cut short is no verdict on the gates.
    expect(passVerdict([refused(own, 'occupied'), refused(g2, 'busy')], own)).toEqual({ kind: 'none', reason: 'no-port' });
  });

  it('skips when every gate is gone or shut to the ship', () => {
    expect(passVerdict([refused(own, 'gone')], own)).toEqual({ kind: 'skip' });
    expect(passVerdict([refused(own, 'closed'), refused(g2, 'not-allowed', 'closed')], own)).toEqual({ kind: 'skip' });
    expect(passVerdict([refused(own, 'gone'), refused(g2, 'unreachable')], own)).toEqual({ kind: 'none', reason: 'unreachable' });
  });

  it('writes nothing shared for this rider\'s own verdicts', () => {
    expect(passVerdict([refused(g3, 'not-allowed', 'pass')], null)).toEqual({ kind: 'none', reason: 'not-allowed' });
    expect(passVerdict([refused(own, 'unreachable')], own)).toEqual({ kind: 'none', reason: 'unreachable' });
    expect(passVerdict([], null)).toEqual({ kind: 'none', reason: 'no-berth' });
  });
});

describe('what a pass writes', () => {
  const now = S.arriveAt + 20 * SEC;
  const f = flightAt(R, [S], now);
  const passing: KeeperMemory = { ...freshKeeperMemory(T0, 1), passing: true };

  it('writes a hold when the berth refuses, and backs off 10 s doubling to a minute', () => {
    const a = keeperAfterPass(view(R, f, now, { memory: passing }), { legSeq: 1, verdict: { kind: 'hold' } });
    expect(a.write).toEqual({ why: 'hold', entry: holdCheckpoint(R, 1, { at: now }) });
    expect(a.memory).toMatchObject({ passing: false, verdict: 'hold', nextPassAt: now + KEEPER_RETRY_MS, backoffMs: 2 * KEEPER_RETRY_MS });
    let m = a.memory;
    for (let i = 0; i < 6; i++) m = keeperAfterPass(view(R, f, now, { memory: m }), { legSeq: 1, verdict: { kind: 'none', reason: 'unreachable' } }).memory;
    expect(m.backoffMs).toBe(KEEPER_RETRY_MAX_MS);
    expect(keeperAfterPass(view(R, f, now, { memory: m }), { legSeq: 1, verdict: { kind: 'docked', gateChange: false } }).memory)
      .toMatchObject({ backoffMs: KEEPER_RETRY_MS, nextPassAt: now, verdict: 'docked' });
  });

  it('renews a hold older than a minute instead, and leaves a fresh one alone', () => {
    const old = holdCheckpoint(R, 1, { at: now - 2 * MIN });
    const renewed = keeperAfterPass(view(R, f, now, { memory: passing, hold: old }), { legSeq: 1, verdict: { kind: 'hold' } });
    expect(renewed.write).toEqual({ why: 'renew-hold', entry: { ...old, seenAt: now } });
    const fresh = holdCheckpoint(R, 1, { at: now - 10 * SEC });
    expect(keeperAfterPass(view(R, f, now, { memory: passing, hold: fresh }), { legSeq: 1, verdict: { kind: 'hold' } }).write).toBeNull();
  });

  it('skips a stop whose berths are gone, unless the stay already has a dock', () => {
    const a = keeperAfterPass(view(R, f, now, { memory: passing }), { legSeq: 1, verdict: { kind: 'skip' } });
    expect(a.write).toEqual({ why: 'skip', entry: skipCheckpoint(R, 1, { at: now, pilot: 'robot' }) });
    expect(keeperAfterPass(view(R, f, now, { memory: passing, stayDock: true }), { legSeq: 1, verdict: { kind: 'skip' } }).write).toBeNull();
  });

  it('writes nothing for a stay the ferry has left, inside the guard band, or once something docked', () => {
    const later = S.arriveAt + 10 * MIN;
    const g = flightAt(R, [S], later);
    expect(g.legSeq).not.toBe(1);
    const gone = keeperAfterPass(view(R, g, later), { legSeq: 1, verdict: { kind: 'hold' } });
    expect(gone.write).toBeNull();
    const band = LEG1.departAt - GUARD_BAND_MS + SEC;
    expect(keeperAfterPass(view(R, flightAt(R, [S], band), band, { memory: passing }), { legSeq: 1, verdict: { kind: 'hold' } }).write).toBeNull();
    expect(keeperAfterPass(view(R, f, now, { memory: passing, docks: { atStop: now, atNext: null, elsewhere: 0 } }), { legSeq: 1, verdict: { kind: 'hold' } }).write).toBeNull();
  });

  it('never holds or skips at a stay STOP has ended, but remembers the answer', () => {
    const stopped = { ...R, stoppedAt: S.departAt + 5 * SEC };
    const g = flightAt(stopped, [S], now);
    const a = keeperAfterPass(view(stopped, g, now, { memory: passing }), { legSeq: 1, verdict: { kind: 'hold' } });
    expect(a.write).toBeNull();
    expect(a.memory.verdict).toBe('hold');
  });
});

describe('what the helm hears', () => {
  const f = flightAt(R, [S], S.arriveAt + SEC);

  const stay = { run: T0, legSeq: 1 };

  it('announces the dock, and a gate change, tied to the stay', () => {
    expect(keeperNote(R, f, { kind: 'docked', gate: 1, gateChange: false })).toEqual({ kind: 'docked', stationName: 'Stop 1', gate: 1, routeStay: stay });
    expect(keeperNote(R, f, { kind: 'docked', gate: 3, gateChange: true })).toEqual({ kind: 'docked', stationName: 'Stop 1', gate: 3, gateChange: true, routeStay: stay });
  });

  it('says what the ferry does about a refusal', () => {
    expect(keeperNote(R, f, { kind: 'hold' })).toEqual({
      kind: 'none', stationName: 'Stop 1', reason: 'occupied', route: { action: 'hold', nextStopName: 'Stop 0' }, routeStay: stay,
    });
    expect(keeperNote(R, f, { kind: 'skip' })).toMatchObject({ reason: 'berth-gone', route: { action: 'skip' } });
    // 🧾 A skip says why: removed, or closed to this ferry.
    expect(keeperNote(R, f, { kind: 'skip' }, 'gone')).toMatchObject({ reason: 'berth-gone', route: { action: 'skip', why: 'gone' } });
    expect(keeperNote(R, f, { kind: 'skip' }, 'shut')).toMatchObject({ reason: 'occupied', route: { action: 'skip', why: 'shut' } });
    expect(keeperNote(R, f, { kind: 'none', reason: 'no-berth' })).toMatchObject({ reason: 'no-berth', route: { action: 'ride-on' } });
    expect(keeperNote(R, f, { kind: 'none', reason: 'stale' })).toBeNull();
  });
});

// ── Over real docs ───────────────────────────────────────────────────────────

/** A stand-in docking system over the bound doors doc: the near-side writes
 *  of docking.ts's UNDOCK and DOCK, the station's answer from `answer`. */
function fakeDocking(clock: () => number, answer: (roomId: string, farDoor: string) => DockAnswer | 'dock' = () => 'dock') {
  const asked: Array<{ roomId: string; farDoor: string; keeper: boolean }> = [];
  const undocks: string[] = [];
  const api: ShipDockingApi = {
    ports: () => ['x-'].map((doorId) => ({ doorId, state: classifyDockPort(readDoor(doorId)), busy: false, canOperate: true })),
    undock: (doorId, opts) => {
      undocks.push(`${doorId}${opts?.keeper ? ' (keeper)' : ''}`);
      const st = classifyDockPort(readDoor(doorId));
      if (st.kind !== 'docked') return false;
      writeDoorTombstone(doorId, st.address, berthMemoryFrom(st.record, stampAfter(st.record.dockedAt, clock())));
      return true;
    },
    dock: async (doorId, opts) => {
      const st = classifyDockPort(readDoor(doorId));
      if (st.kind !== 'undocked') return { ok: false, reason: 'no-port' };
      const farDoor = st.memory.farDoor ?? '';
      asked.push({ roomId: st.roomId, farDoor, keeper: opts?.keeper === true });
      const a = answer(st.roomId, farDoor);
      if (a !== 'dock') return a;
      const dockedAt = stampAfter(st.memory.undockedAt, clock());
      const rec = redockRecord(st, dockedAt);
      writeDoorPairing(doorId, rec.connectedRoomAddress, rec);
      return { ok: true, dockedAt };
    },
  };
  return { api, asked, undocks };
}

/** The ship's live docks as main.ts reads them (same berth room only; 🛟
 *  a dock on any door but the route's port holds the stay). */
function testLiveDock(): LiveDockAt {
  const docks: Array<{ roomId: string; dockedAt: number; doorId: string }> = [];
  for (const [doorId, rec] of readAllDoors()) {
    if (rec.paired !== true) continue;
    const st = classifyDockPort(rec);
    if (st.kind !== 'docked') continue;
    docks.push({ roomId: st.roomId, dockedAt: rec.dockedAt ?? 0, doorId });
  }
  const routePort = readShipRoute()?.shipPort;
  return liveDockFrom(docks, undefined, routePort !== undefined ? { routePort } : {});
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A whole-millisecond moment at or after `t` (Date.now() is an integer, and
 *  door stamps must be: planTransfer's windows are not). */
const ms = (t: number) => Math.ceil(t);

describe('a dock pass over the gate list', () => {
  let now = ms(S.arriveAt + SEC);
  const clock = () => now;
  const route = running({ stops: [stop(0, 0), stop(1, 1, { berth: { roomId: 'room-1', farDoor: 'x+', gate: 1, anyGate: true } })] });
  const station = { berths: [gateAt('room-1', 'x+', 1), gateAt('room-1', 'y-', 2), gateAt('room-2', 'south', 3, { access: 'pass' })] };

  beforeEach(() => {
    now = ms(S.arriveAt + SEC);
    bindDoorsDoc(new Y.Doc());
    setBerthSeedResolver((room) => seed(room));
    writeDoorTombstone('x-', seed('room-0'), { farDoor: 'x+', undockedAt: T0 });
  });
  afterEach(() => setBerthSeedResolver(null));

  const pass = (docking: ShipDockingApi, over: { mayDock?: () => boolean; stillWanted?: () => boolean } = {}) => runKeeperPass({
    docking,
    route,
    stop: route.stops[1],
    station,
    shipRoomId: 'ship-1',
    mayDock: over.mayDock ?? (() => true),
    stillWanted: over.stillWanted ?? (() => true),
    now: clock,
  });

  it('re-points the port at the stop\'s own berth and docks there in keeper mode', async () => {
    const d = fakeDocking(clock);
    const out = await pass(d.api);
    expect(out.verdict).toMatchObject({ kind: 'docked', gate: 1, gateChange: false });
    expect(d.asked).toEqual([{ roomId: 'room-1', farDoor: 'x+', keeper: true }]);
    const port = classifyDockPort(readDoor('x-'));
    expect(port.kind === 'docked' && port.roomId).toBe('room-1');
  });

  it('changes gate when the own berth is taken, and says so', async () => {
    const d = fakeDocking(clock, (_room, farDoor) => (farDoor === 'x+' ? { ok: false, reason: 'occupied' } : 'dock'));
    const out = await pass(d.api);
    expect(out.verdict).toMatchObject({ kind: 'docked', gate: 2, gateChange: true });
    expect(d.asked.map((a) => a.farDoor)).toEqual(['x+', 'y-']);
  });

  it('moves on past a granted-captains gate this rider holds no grant for, and holds when the rest are taken', async () => {
    const d = fakeDocking(clock, (_room, farDoor) => (farDoor === 'south' ? { ok: false, reason: 'not-allowed', gateAccess: 'pass' } : { ok: false, reason: 'occupied' }));
    const out = await pass(d.api);
    expect(out.verdict).toEqual({ kind: 'hold' });
    expect(d.asked.map((a) => a.farDoor)).toEqual(['x+', 'y-', 'south']);
  });

  it('stops at the port\'s own trouble, and when the pass is no longer wanted', async () => {
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'busy' }));
    expect((await pass(d.api)).verdict).toEqual({ kind: 'none', reason: 'no-port' });
    expect(d.asked).toHaveLength(1);
    const e = fakeDocking(clock, () => ({ ok: false, reason: 'occupied' }));
    let calls = 0;
    expect((await pass(e.api, { stillWanted: () => ++calls < 2 })).verdict).toEqual({ kind: 'none', reason: 'stale' });
    expect(e.asked).toHaveLength(1);
  });

  it('never re-points a port this rider may not dock', async () => {
    const d = fakeDocking(clock);
    const locked: ShipDockingApi = { ...d.api, ports: () => d.api.ports().map((p) => ({ ...p, canOperate: false })) };
    expect((await pass(locked, { mayDock: () => false })).verdict).toEqual({ kind: 'none', reason: 'no-port' });
    expect(d.asked).toHaveLength(0);
    const port = classifyDockPort(readDoor('x-'));
    expect(port.kind === 'undocked' && port.roomId).toBe('room-0');
    // With the carve-out it may.
    expect((await pass(locked, { mayDock: () => true })).verdict.kind).toBe('docked');
  });
});

describe('the keeper over a running ferry', () => {
  let now = T0;
  const clock = () => now;
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    now = T0;
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    setBerthSeedResolver((room) => seed(room));
    uninstall = installRouteFlight({ capacity: () => CAP, liveDock: testLiveDock, clock });
    // Docked at stop 0's berth, then START.
    writeDoorPairing('x-', seed('room-0'), buildDoorPairing(seed('room-0'), {
      segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: T0 - MIN,
    }));
    const saved = running({ homeRefuel: true });
    delete (saved as ShipRoute).startedAt;
    delete (saved as ShipRoute).startStop;
    expect(writeShipRoute(saved)).toBe(true);
    writeFuelLevel(CAP, CAP);
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: CAP, capacity: CAP })).toBe(T0);
  });
  afterEach(() => {
    uninstall?.();
    setBerthSeedResolver(null);
  });

  const keeperWith = (
    d: ReturnType<typeof fakeDocking>,
    notes: unknown[] = [],
    more: Partial<Parameters<typeof createRouteKeeper>[0]> = {},
  ) => createRouteKeeper({
    docking: () => d.api,
    shipRoomId: () => 'ship-1',
    sameStation: (s, roomId) => roomId === s.berth.roomId,
    station: () => null,
    note: (o) => notes.push(o),
    clock,
    ...more,
  });
  const start = () => readRouteCheckpoints().find((e): e is StartCheckpoint => e.kind === 'start')!;
  const portRoom = () => {
    const p = classifyDockPort(readDoor('x-'));
    return p.kind === 'docked' ? p.roomId : null;
  };

  it('casts off on time, flies, and docks at the next stop, writing no checkpoint', async () => {
    const d = fakeDocking(clock);
    const notes: unknown[] = [];
    const keeper = keeperWith(d, notes);
    const s = start();
    now = ms(s.departAt - 5 * SEC);
    keeper.tick();
    expect(portRoom()).toBe('room-0');
    now = ms(s.departAt + 2 * SEC);
    keeper.tick();
    expect(portRoom()).toBeNull();
    expect(d.undocks).toEqual(['x- (keeper)']);
    expect(readStationBerth('st-0')).toMatchObject({ doorId: 'x-', roomId: 'room-0' });
    expect(readRouteFlight(now)?.status).toBe('in-flight');
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    expect(portRoom()).toBe('room-1');
    expect(d.asked).toEqual([{ roomId: 'room-1', farDoor: 'x+', keeper: true }]);
    expect(notes).toEqual([{ kind: 'docked', stationName: 'Stop 1', routeStay: { run: T0, legSeq: 1 } }]);
    expect(readRouteCheckpoints().map((e) => e.kind)).toEqual(['start']);
    expect(keeper.dockAnswered(readRouteFlight(now)!)).toBe(true);
    // Docked on time: nothing more to do.
    now += 10 * SEC;
    keeper.tick();
    await flush();
    expect(d.asked).toHaveLength(1);
  });

  it('holds at a taken berth, retries after the back-off, and ends the hold on the dock\'s stamp', async () => {
    let taken = true;
    const d = fakeDocking(clock, () => (taken ? { ok: false, reason: 'occupied' } : 'dock'));
    const notes: Array<{ kind: string }> = [];
    const keeper = keeperWith(d, notes);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick(); // cast off
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    const hold = readRouteCheckpoints().find((e): e is HoldCheckpoint => e.kind === 'hold');
    expect(hold).toMatchObject({ legSeq: 1, since: now, seenAt: now });
    expect(readRouteFlight(now)).toMatchObject({ holding: true, status: 'docked', legSeq: 1 });
    expect(notes.at(-1)).toMatchObject({ reason: 'occupied', route: { action: 'hold' } });
    // Inside the back-off: no second attempt.
    now += 5 * SEC;
    keeper.tick();
    await flush();
    expect(d.asked).toHaveLength(1);
    // After it, the berth has freed.
    taken = false;
    now += 6 * SEC;
    keeper.tick();
    await flush();
    expect(portRoom()).toBe('room-1');
    const dockedAt = (readDoor('x-') as { dockedAt?: number }).dockedAt!;
    expect(readRouteFlight(now)?.holding).toBe(true); // until the dock entry
    now += SEC;
    keeper.tick();
    const dock = readRouteCheckpoints().find((e) => e.kind === 'dock');
    expect(dock).toMatchObject({ legSeq: 1, stayStart: dockedAt });
    const f = readRouteFlight(now)!;
    expect(f.holding).toBe(false);
    expect(f.departsAt).toBe(legWindowAfter(readShipRoute()!, 1, dockedAt + 60 * SEC)!.departAt);
  });

  it('renews a hold each minute while it still sees the berth refuse', async () => {
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'occupied' }));
    const keeper = keeperWith(d);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick();
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    const since = now;
    for (let t = 0; t < 4 * 60; t++) {
      now += SEC;
      keeper.tick();
      await flush();
    }
    const hold = readRouteCheckpoints().find((e): e is HoldCheckpoint => e.kind === 'hold')!;
    expect(hold.since).toBe(since);
    expect(now - hold.seenAt).toBeLessThan(HOLD_RENEW_MS + KEEPER_RETRY_MAX_MS);
    expect(readRouteFlight(now)?.holding).toBe(true); // still watched after 4 minutes
  });

  it('writes nothing when only this rider cannot dock, and the ferry rides on', async () => {
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'unreachable' }));
    const notes: Array<{ kind: string }> = [];
    const keeper = keeperWith(d, notes);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick();
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    expect(readRouteCheckpoints().map((e) => e.kind)).toEqual(['start']);
    expect(notes.at(-1)).toMatchObject({ reason: 'unreachable', route: { action: 'ride-on', nextStopName: 'Stop 0' } });
    const f = readRouteFlight(now)!;
    expect(f.holding).toBe(false);
    expect(keeper.dockAnswered(f)).toBe(true);
  });

  it('skips a stop whose berth was removed', async () => {
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'gone' }));
    const keeper = keeperWith(d);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick();
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    expect(readRouteCheckpoints().find((e) => e.kind === 'skip')).toMatchObject({ legSeq: 1, at: now });
    expect(readRouteFlight(now)?.skipped).toBe(true);
  });

  it('restarts a stay it finds still docked after its departure, then casts off at the new one', () => {
    const d = fakeDocking(clock);
    const keeper = keeperWith(d);
    const s = start();
    now = ms(s.departAt + 40 * SEC); // nobody was aboard at the departure
    keeper.tick();
    expect(portRoom()).toBe('room-0');
    const restart = readRouteCheckpoints().find((e) => e.kind === 'dock')!;
    expect(restart).toMatchObject({ legSeq: 0, stayStart: now, at: now });
    const f = readRouteFlight(now)!;
    expect(f).toMatchObject({ status: 'docked', legSeq: 0, overdue: false });
    now = ms(f.departsAt! + SEC);
    keeper.tick();
    expect(portRoom()).toBeNull();
    expect(readRouteFlight(now)?.status).toBe('in-flight');
  });

  it('answers the copy-back at once when STOP comes during a hold', async () => {
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'occupied' }));
    const keeper = keeperWith(d);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick();
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    now += 20 * SEC;
    expect(stopShipRoute(now)).toBe(true);
    const f = readRouteFlight(now + SEC)!;
    expect(f).toMatchObject({ ended: 'stop', holding: false });
    const fresh = keeperWith(d); // a helm game that never saw the refusal
    expect(fresh.dockAnswered(f)).toBe(true);
    now += 20 * SEC;
    keeper.tick();
    await flush();
    expect(d.asked).toHaveLength(1); // retrying stopped
  });

  it('grants the carve-out only for the route\'s port toward the current stop, at its moments', () => {
    const keeper = keeperWith(fakeDocking(clock));
    const s = start();
    now = ms(s.departAt - 30 * SEC);
    expect(keeper.mayOperate('x-', 'undock', 'room-0')).toBe(false);
    expect(keeper.mayOperate('x-', 'dock', 'room-0')).toBe(true);
    expect(keeper.mayOperate('y+', 'dock', 'room-0')).toBe(false);
    now = ms(s.departAt + SEC);
    expect(keeper.mayOperate('x-', 'undock', 'room-0')).toBe(true);
    // Cast off (by anyone): the ferry flies, and docks at stop 1.
    writeDoorTombstone('x-', seed('room-0'), { farDoor: 'x+', undockedAt: now });
    now = ms(s.arriveAt + SEC);
    expect(keeper.mayOperate('x-', 'dock', 'room-1')).toBe(true);
    expect(keeper.mayOperate('x-', 'dock', 'room-0')).toBe(false);
  });

  it('forgets a pass that was running when the room changed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'occupied' }));
    const slow: ShipDockingApi = { ...d.api, dock: async (id, o) => { await gate; return d.api.dock(id, o); } };
    const keeper = createRouteKeeper({ docking: () => slow, shipRoomId: () => 'ship-1', sameStation: (st, r) => r === st.berth.roomId, station: () => null, clock });
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick();
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    keeper.reset();
    release();
    await flush();
    await flush();
    expect(readRouteCheckpoints().some((e) => e.kind === 'hold')).toBe(false);
  });

  it('🛰️ reads and does nothing before the room\'s shared state has arrived', () => {
    let ready = false;
    const d = fakeDocking(clock);
    const keeper = keeperWith(d, [], { ready: () => ready });
    const s = start();
    now = ms(s.departAt + 2 * SEC);
    keeper.tick();
    expect(portRoom()).toBe('room-0');
    expect(d.undocks).toEqual([]);
    expect(keeper.mayOperate('x-', 'undock', 'room-0')).toBe(false);
    ready = true;
    keeper.tick();
    expect(portRoom()).toBeNull();
  });

  it('🚚 leaves a tug towing a station docked', () => {
    const d = fakeDocking(clock);
    const keeper = keeperWith(d, [], { towing: () => true });
    now = ms(start().departAt + 2 * SEC);
    keeper.tick();
    expect(portRoom()).toBe('room-0');
  });

  it('🛟 a port nobody aboard may release holds the ferry, DELAYED, until someone lets it go', () => {
    // Another port of the ferry, docked before the departure.
    writeDoorPairing('y+', seed('room-9'), buildDoorPairing(seed('room-9'), {
      segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: T0 - MIN,
    }));
    const d = fakeDocking(clock);
    const keeper = keeperWith(d, [], { mayRelease: (id) => id !== 'y+' });
    const s = start();
    for (const late of [2 * SEC, 45 * SEC, 20 * MIN]) {
      now = ms(s.departAt + late);
      keeper.tick();
      expect(portRoom()).toBe('room-0');
      expect(readRouteFlight(now)).toMatchObject({ status: 'docked', legSeq: 0, overdue: true });
    }
    expect(readRouteCheckpoints().map((e) => e.kind)).toEqual(['start']);
    // Its owner lets it go: the stay restarts, and the ferry leaves at the
    // restarted stay's departure.
    writeDoorTombstone('y+', seed('room-9'), { farDoor: 'x+', undockedAt: now });
    now += SEC;
    keeper.tick();
    const restart = readRouteCheckpoints().find((e) => e.kind === 'dock')!;
    expect(restart).toMatchObject({ legSeq: 0, stayStart: now });
    now = ms(readRouteFlight(now)!.departsAt! + SEC);
    keeper.tick();
    expect(portRoom()).toBeNull();
  });

  it('casting off in flight remembers no berth (the stop it left is not where the dock is)', () => {
    const d = fakeDocking(clock);
    const keeper = keeperWith(d);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick(); // cast off at the departure: remembers stop 0's berth
    expect(readStationBerth('st-0')).toMatchObject({ roomId: 'room-0' });
    // Mid-leg the port is found docked somewhere else (by hand, say), and a
    // rider whose game never saw the stay boards.
    now = ms(s.departAt + 20 * SEC);
    writeDoorPairing('x-', seed('room-5'), buildDoorPairing(seed('room-5'), {
      segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: now,
    }));
    const rider = keeperWith(d);
    now += SEC;
    rider.tick();
    expect(portRoom()).toBeNull();
    expect(readStationBerth('st-0')).toMatchObject({ roomId: 'room-0' });
  });

  it('🧾 says docked once another rider\'s dock ended the hold it announced', async () => {
    const d = fakeDocking(clock, () => ({ ok: false, reason: 'occupied' }));
    const notes: Array<{ kind: string }> = [];
    const keeper = keeperWith(d, notes);
    const s = start();
    now = ms(s.departAt + SEC);
    keeper.tick();
    now = ms(s.arriveAt + SEC);
    keeper.tick();
    await flush();
    expect(notes.at(-1)).toMatchObject({ route: { action: 'hold' }, routeStay: { run: T0, legSeq: 1 } });
    // Another rider docks the ferry and ends the hold before this game does.
    now += 3 * SEC;
    const route = readShipRoute()!;
    writeDoorPairing('x-', seed('room-1'), buildDoorPairing(seed('room-1'), {
      segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: now,
    }));
    const dock = dockCheckpoint(route, 1, { at: now, stayStart: now, pilot: 'robot' })!;
    expect(writeRouteCheckpoint(T0, dock, now)).toBe(true);
    now += SEC;
    keeper.tick();
    expect(notes.at(-1)).toMatchObject({ kind: 'docked', stationName: 'Stop 1', routeStay: { run: T0, legSeq: 1 } });
    const n = notes.length;
    now += SEC;
    keeper.tick();
    expect(notes).toHaveLength(n); // said once
  });

  it('writes nothing about a stay a checkpoint write refuses', () => {
    // A checkpoint for a run that is not the route's is dropped by the writer.
    const s = start();
    expect(writeRouteCheckpoint(s.at + 1, holdCheckpoint(readShipRoute()!, 1, { at: s.arriveAt + SEC }), s.arriveAt + SEC)).toBe(false);
  });
});
