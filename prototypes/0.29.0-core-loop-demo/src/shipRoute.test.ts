/**
 * 🚏 Ship route — the route and its checkpoints in the ship's room doc (build
 * notes A1 + A2): the stored shapes and their guards against hostile values,
 * the checkpoint key codec, the editor's save and the running-route lock,
 * START in one transaction (the fuel ceiling first, other runs' keys gone),
 * on-time legs writing nothing, one key per event (two writers converge),
 * pruning inside the writer's transaction, the reader's key cap, STOP and
 * finish, and the route's fuel draw meter (the home refill with no write,
 * REFUEL's order, a paused route reading the stored level).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  dockCheckpoint,
  fuelCheckpoint,
  holdCheckpoint,
  legWindowAfter,
  pauseCheckpoint,
  routeLegFuel,
  skipCheckpoint,
  stopAt,
} from './pilotRoute';
import {
  bindShipDoc,
  fuelDrawDeficit,
  readFlightRecord,
  readFuelLevel,
  readStoredFuelLevel,
  setFuelDrawMeter,
  shipDocHandle,
  writeFuelLevel,
} from './shipDoc';
import {
  CHECKPOINT_KINDS,
  MAX_CHECKPOINT_KEYS_SCANNED,
  ROUTE_FUEL_METER,
  checkpointFromWire,
  checkpointKey,
  checkpointToWire,
  finishShipRoute,
  installRouteFuelMeter,
  parseCheckpointKey,
  pruneRouteCheckpoints,
  readRouteCheckpoints,
  readShipRoute,
  routeBerthFromWire,
  routeFlightNow,
  routeFuelDebt,
  routeToWire,
  routeWithoutRun,
  shipRouteFromWire,
  startShipRoute,
  stopShipRoute,
  writeRouteCheckpoint,
  writeShipRoute,
} from './shipRoute';
import type { RouteCheckpoint, RouteStop, ShipRoute, StartCheckpoint } from './shipRoute';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const CAP = 100;

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

/** A saved (not running) route: the owner's 0 ↔ 1 ferry by default. */
function saved(slots: number[] = [0, 1], over: Partial<ShipRoute> = {}): ShipRoute {
  return {
    stops: slots.map((s, i) => stop(i, s)),
    shape: 'backAndForth',
    shipPort: 'x-',
    robotDockId: 'dock-1',
    ...over,
  };
}

/** The route as a plain JSON value (what a peer could have written). */
function wire(r: ShipRoute): Record<string, unknown> {
  return JSON.parse(JSON.stringify(routeToWire(r))) as Record<string, unknown>;
}

/** Save `r`, fill the tank to `fuel`, and START at T0 from stop 0. */
function started(r: ShipRoute = saved(), fuel = 70): { run: number; route: ShipRoute; start: StartCheckpoint } {
  expect(writeShipRoute(r)).toBe(true);
  writeFuelLevel(fuel, CAP);
  const run = startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel, capacity: CAP });
  if (run === null) throw new Error('START refused');
  const route = readShipRoute()!;
  const start = readRouteCheckpoints().find((e): e is StartCheckpoint => e.kind === 'start')!;
  return { run, route, start };
}

interface ChainLeg { depart: number; arrive: number }

/** The on-time chain from the start entry (A3 rule 4). */
function onTime(r: ShipRoute, s: StartCheckpoint, legs: number): ChainLeg[] {
  const out: ChainLeg[] = [{ depart: s.departAt, arrive: s.arriveAt }];
  for (let k = 1; k < legs; k++) {
    const w = legWindowAfter(r, k, out[k - 1].arrive + r.stops[stopAt(r, k)].waitSecs * SEC)!;
    out.push({ depart: w.departAt, arrive: w.arriveAt });
  }
  return out;
}

function map(): Y.Map<unknown> {
  return shipDocHandle()!.map;
}

function ckptKeys(): string[] {
  return [...map().keys()].filter((k) => k.startsWith('ckpt:'));
}

/** Count the doc's update events (one per transaction that changed it). */
function countUpdates(doc: Y.Doc): { readonly n: number } {
  const c = { n: 0 };
  doc.on('update', () => { c.n++; });
  return c;
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

let doc: Y.Doc;
let clock = T0;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  doc = new Y.Doc();
  bindShipDoc(doc);
  clock = T0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setFuelDrawMeter(ROUTE_FUEL_METER, null);
  warn.mockRestore();
});

// ── Stored shapes (A1) ───────────────────────────────────────────────────────

describe('route guards', () => {
  it('a well-formed route round-trips; an absent anyGate reads as true, false pins the gate', () => {
    const r = saved([0, 1, 2], { shape: 'loop', homeRefuel: true });
    r.stops[1] = stop(1, 1, { berth: { roomId: 'room-1', farDoor: 'd:abc', farWall: 'y+', farLateral: -2, gate: 7, anyGate: false } });
    expect(shipRouteFromWire(wire(r))).toEqual(r);
    const w = wire(r);
    delete ((w.stops as Array<Record<string, Record<string, unknown>>>)[0].berth).anyGate;
    expect(shipRouteFromWire(w)!.stops[0].berth.anyGate).toBe(true);
    expect(shipRouteFromWire(w)!.stops[1].berth).toMatchObject({ gate: 7, anyGate: false });
  });

  it('a berth never carries a pass, and its door, wall, lateral and gate are checked', () => {
    const ok = { roomId: 'room-1', farDoor: 'north', anyGate: true };
    expect(routeBerthFromWire(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, address: { roomId: 'room-1', pass: 'secret' } },
      { ...ok, farDoor: 'porthole' },
      { ...ok, farDoor: 42 },
      { ...ok, farWall: 'north' },
      { ...ok, farLateral: 33 },
      { ...ok, farLateral: Number.NaN },
      { ...ok, gate: 0 },
      { ...ok, gate: 100 },
      { ...ok, gate: 2.5 },
      { ...ok, anyGate: 'yes' },
      { ...ok, roomId: '' },
      { ...ok, roomId: 'r'.repeat(129) },
      null, 'room-1', [ok],
    ]) {
      expect(routeBerthFromWire(bad)).toBeNull();
    }
  });

  it('hostile stops make the whole route read as absent', () => {
    const cases: Array<(s: Record<string, unknown>) => void> = [
      (s) => { s.stationId = 's'.repeat(129); },
      (s) => { s.planetId = ''; },
      (s) => { s.name = ''; },
      (s) => { s.name = 'n'.repeat(129); },
      (s) => { s.orbitSlot = 16; },
      (s) => { s.orbitSlot = -1; },
      (s) => { s.orbitSlot = 0.5; },
      (s) => { s.waitSecs = 29; },
      (s) => { s.waitSecs = 601; },
      (s) => { s.waitSecs = Number.POSITIVE_INFINITY; },
      (s) => { s.berth = { roomId: 'room-0', farDoor: 'x+', address: {} }; },
      (s) => { delete s.berth; },
    ];
    for (const spoil of cases) {
      const w = wire(saved());
      spoil((w.stops as Array<Record<string, unknown>>)[0]);
      expect(shipRouteFromWire(w)).toBeNull();
    }
  });

  it('shape, port, captain, stop count and plannable legs are checked', () => {
    const base = wire(saved());
    expect(shipRouteFromWire(base)).not.toBeNull();
    for (const [field, value] of [
      ['shape', 'zigzag'],
      ['shipPort', 'hatch'],
      ['robotDockId', ''],
      ['homeRefuel', 'yes'],
      ['stops', []],
      ['stops', 'st-0,st-1'],
    ] as const) {
      expect(shipRouteFromWire({ ...base, [field]: value })).toBeNull();
    }
    expect(shipRouteFromWire(wire(saved([0])))).toBeNull();
    expect(shipRouteFromWire(wire(saved([0, 1, 2, 3, 4, 5, 6, 7])))).not.toBeNull();
    expect(shipRouteFromWire(wire(saved([0, 1, 2, 3, 4, 5, 6, 7, 8])))).toBeNull();
    // Neighbours sharing an orbit, or stops on two planets, have no transfer.
    expect(shipRouteFromWire(wire(saved([0, 0])))).toBeNull();
    const twoPlanets = saved();
    twoPlanets.stops[1] = stop(1, 1, { planetId: 'planet-aris' });
    expect(shipRouteFromWire(wire(twoPlanets))).toBeNull();
    for (const bad of [null, 7, 'route', [base]]) expect(shipRouteFromWire(bad)).toBeNull();
  });

  it('the run fields must make sense together, and are dropped when not started', () => {
    const base = wire(saved());
    expect(shipRouteFromWire({ ...base, startedAt: T0 })).toMatchObject({ startedAt: T0, startStop: 0 });
    expect(shipRouteFromWire({ ...base, startedAt: T0, startStop: 1, stoppedAt: T0 + 1 })).toMatchObject({ startStop: 1, stoppedAt: T0 + 1 });
    for (const run of [
      { startedAt: 0 }, { startedAt: -5 }, { startedAt: 1.5 }, { startedAt: String(T0) },
      { startedAt: Number.MAX_SAFE_INTEGER + 2 },
      { startedAt: T0, startStop: 2 }, { startedAt: T0, startStop: -1 }, { startedAt: T0, startStop: 0.5 },
      { startedAt: T0, stoppedAt: T0 - 1 }, { startedAt: T0, stoppedAt: Number.NaN },
    ]) {
      expect(shipRouteFromWire({ ...base, ...run })).toBeNull();
    }
    const loose = shipRouteFromWire({ ...base, startStop: 1, stoppedAt: T0 });
    expect(loose).not.toBeNull();
    expect(loose).not.toHaveProperty('startStop');
    expect(loose).not.toHaveProperty('stoppedAt');
    expect(routeWithoutRun({ ...saved(), startedAt: T0, startStop: 1, stoppedAt: T0 })).toEqual(saved());
  });
});

// ── Checkpoint keys and values (A2) ──────────────────────────────────────────

describe('checkpoint keys', () => {
  it('round-trip for every kind', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const legSeq of [0, 1, 17, 99_999_999]) {
        const key = checkpointKey(T0, legSeq, kind);
        expect(key).toBe(`ckpt:${T0}:${legSeq}:${kind}`);
        expect(parseCheckpointKey(key)).toEqual({ run: T0, legSeq, kind });
      }
    }
  });

  it('only the canonical spelling parses, so each event has exactly one key', () => {
    for (const key of [
      `ckpt:0${T0}:1:hold`, `ckpt:${T0}:01:hold`, `ckpt:${T0}:-1:hold`, `ckpt:+${T0}:1:hold`,
      `ckpt:${T0}:1.0:hold`, `ckpt:${T0}:1:Hold`, `ckpt:${T0}:1:warp`, `ckpt:${T0}:1`,
      `ckpt:${T0}:1:hold:x`, 'ckpt:0:0:start', `ckpt:${T0}:100000000:hold`, `ckp:${T0}:1:hold`,
      `ckpt:${'9'.repeat(17)}:1:hold`, `ckpt:${T0}:1:hold${' '.repeat(60)}`, 'route', 'fuel',
    ]) {
      expect(parseCheckpointKey(key)).toBeNull();
    }
  });
});

describe('checkpoint guards', () => {
  const route = { ...saved(), startedAt: T0, startStop: 0 };
  const dock = dockCheckpoint(route, 1, { at: T0 + HOUR, pilot: 'robot' })!;

  it('every kind round-trips through its wire value; unknown extra fields are dropped', () => {
    const all: RouteCheckpoint[] = [
      dock,
      dockCheckpoint(route, 3, { at: T0 + HOUR, pilot: 'person', resume: true })!,
      skipCheckpoint(route, 2, { at: T0 + HOUR, pilot: 'robot' })!,
      holdCheckpoint(route, 1, { at: T0 + HOUR }),
      pauseCheckpoint(route, 1, { at: T0 + HOUR }),
      fuelCheckpoint(route, 1, { at: T0 + HOUR, fuel: 42 }),
      { kind: 'helm', legSeq: 1, at: T0, stationId: 'st-1', pilot: 'person' },
      { kind: 'go', legSeq: 1, at: T0, stationId: 'st-1', stayStart: T0, departAt: T0 + MIN, arriveAt: T0 + 2 * MIN },
    ];
    for (const e of all) {
      expect(checkpointFromWire(e.kind, e.legSeq, JSON.parse(JSON.stringify(checkpointToWire(e))))).toEqual(e);
    }
    expect(checkpointFromWire('dock', 1, { ...checkpointToWire(dock), address: 'pass', extra: 1 })).toEqual(dock);
  });

  it('hostile values are rejected, not clamped', () => {
    const d = checkpointToWire(dock);
    const bad: Array<[RouteCheckpoint['kind'], number, unknown]> = [
      ['dock', 1, { ...d, at: Number.NaN }],
      ['dock', 1, { ...d, at: Number.POSITIVE_INFINITY }],
      ['dock', 1, { ...d, at: -1 }],
      ['dock', 1, { ...d, at: 9e15 }],
      ['dock', 1, { ...d, at: String(T0) }],
      ['dock', 1, { ...d, stationId: 's'.repeat(129) }],
      ['dock', 1, { ...d, arriveAt: d.departAt }],
      ['dock', 1, { ...d, pilot: 'alien' }],
      ['dock', 1, { ...d, resume: 'yes' }],
      ['dock', 1, { ...d, stayStart: undefined }],
      ['dock', 1.5, d],
      ['dock', -1, d],
      ['dock', 100_000_000, d],
      ['start', 1, { at: T0, stationId: 'st-1', stayStart: T0, departAt: T0 + 1, arriveAt: T0 + 2, pilot: 'robot', fuel: 1 }],
      ['start', 0, { at: T0, stationId: 'st-0', stayStart: T0, departAt: T0 + 1, arriveAt: T0 + 2, pilot: 'robot', fuel: -1 }],
      ['start', 0, { at: T0, stationId: 'st-0', stayStart: T0, departAt: T0 + 1, arriveAt: T0 + 2, pilot: 'robot', fuel: 2e9 }],
      ['hold', 1, { at: T0, stationId: 'st-1', since: T0 }],
      ['helm', 1, { at: T0, stationId: 'st-1', pilot: 'robot', stayStart: T0 }],
      ['helm', 1, { at: T0, stationId: 'st-1', pilot: 'captain' }],
      ['fuel', 1, { at: T0, stationId: 'st-1', fuel: Number.NaN }],
      ['pause', 1, [T0, 'st-1']],
      ['pause', 1, null],
    ];
    for (const [kind, legSeq, v] of bad) expect(checkpointFromWire(kind, legSeq, v)).toBeNull();
  });
});

// ── The editor's save ────────────────────────────────────────────────────────

describe('writeShipRoute', () => {
  it('saves a cleaned route (run fields dropped) and deletes with null', () => {
    const r = saved();
    expect(writeShipRoute({ ...r, startedAt: T0, startStop: 1 })).toBe(true);
    expect(readShipRoute()).toEqual(r);
    expect(writeShipRoute(null)).toBe(true);
    expect(readShipRoute()).toBeNull();
  });

  it('refuses a malformed route and leaves the saved one', () => {
    writeShipRoute(saved());
    expect(writeShipRoute(saved([0, 0]))).toBe(false);
    expect(writeShipRoute({ ...saved(), shipPort: 'hatch' })).toBe(false);
    expect(readShipRoute()).toEqual(saved());
  });

  it('a running route is locked: STOP and finish it to edit', () => {
    started();
    expect(writeShipRoute(saved([0, 1, 2], { shape: 'loop' }))).toBe(false);
    expect(writeShipRoute(null)).toBe(false);
    expect(readShipRoute()!.startedAt).toBe(T0);
    expect(stopShipRoute(T0 + MIN)).toBe(true);
    expect(writeShipRoute(null)).toBe(false);
    expect(finishShipRoute()).toBe(true);
    expect(writeShipRoute(saved([0, 1, 2], { shape: 'loop' }))).toBe(true);
  });

  it('a hostile route in the doc reads as none, and nothing derives from it', () => {
    map().set('route', { ...wire(saved()), startedAt: T0, stops: [{ stationId: 'st-0' }] });
    expect(readShipRoute()).toBeNull();
    expect(routeFlightNow(null, CAP, T0 + MIN)).toBeNull();
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'person', fuel: 1, capacity: CAP })).toBeNull();
  });
});

// ── START ────────────────────────────────────────────────────────────────────

describe('startShipRoute', () => {
  it('writes the run, its start entry and the fuel in one transaction', () => {
    writeShipRoute(saved());
    writeFuelLevel(70, CAP);
    const updates = countUpdates(doc);
    const run = startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 70, capacity: CAP });
    expect(run).toBe(T0);
    expect(updates.n).toBe(1);
    expect(readShipRoute()).toMatchObject({ startedAt: T0, startStop: 0 });
    expect(ckptKeys()).toEqual([`ckpt:${T0}:0:start`]);
    expect(readRouteCheckpoints()).toEqual([expect.objectContaining({ kind: 'start', stayStart: T0, pilot: 'robot', fuel: 70 })]);
  });

  it("deletes every other run's keys, leaves keys it cannot parse, and moves its id past theirs", () => {
    writeShipRoute(saved());
    map().set(`ckpt:${T0 + 5}:0:start`, { junk: true });
    map().set('ckpt:12345:3:hold', { at: 1, stationId: 'st-1', since: 1, seenAt: 1 });
    map().set('ckpt:from-a-newer-client', 1);
    const run = startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 50, capacity: CAP });
    expect(run).toBe(T0 + 6);
    expect(ckptKeys().sort()).toEqual([`ckpt:${T0 + 6}:0:start`, 'ckpt:from-a-newer-client']);
  });

  it('refuses a robot pilot without a robot captain, a stop off the route, and a second START', () => {
    writeShipRoute({ ...saved(), robotDockId: undefined });
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 50, capacity: CAP })).toBeNull();
    expect(startShipRoute({ now: T0, startStop: 2, pilot: 'person', fuel: 50, capacity: CAP })).toBeNull();
    expect(startShipRoute({ now: T0, startStop: 0.5, pilot: 'person', fuel: 50, capacity: CAP })).toBeNull();
    expect(startShipRoute({ now: Number.NaN, startStop: 0, pilot: 'person', fuel: 50, capacity: CAP })).toBeNull();
    expect(readShipRoute()!.startedAt).toBeUndefined();
    expect(startShipRoute({ now: T0, startStop: 1, pilot: 'person', fuel: 50, capacity: CAP })).toBe(T0);
    expect(startShipRoute({ now: T0 + MIN, startStop: 0, pilot: 'person', fuel: 50, capacity: CAP })).toBeNull();
    expect(readShipRoute()).toMatchObject({ startedAt: T0, startStop: 1 });
  });

  it('with no route saved, START does nothing', () => {
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'person', fuel: 50, capacity: CAP })).toBeNull();
    expect([...map().keys()]).toEqual([]);
  });

  it('stores the current level clamped to the tanks, or the full-tank ceiling with the home refill', () => {
    writeShipRoute(saved());
    startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 150, capacity: CAP });
    expect(readStoredFuelLevel()).toBe(CAP);
    expect(readRouteCheckpoints()[0]).toMatchObject({ kind: 'start', fuel: CAP });

    bindShipDoc(new Y.Doc());
    writeShipRoute(saved());
    startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 60, capacity: CAP });
    expect(readStoredFuelLevel()).toBe(60);

    bindShipDoc(new Y.Doc());
    writeShipRoute(saved([0, 1], { homeRefuel: true }));
    startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 60, capacity: CAP });
    expect(readStoredFuelLevel()).toBe(CAP);
    expect(readRouteCheckpoints()[0]).toMatchObject({ fuel: 60 });
  });
});

// ── On time, nothing is written ──────────────────────────────────────────────

describe('on-time legs write nothing', () => {
  it('hours of reads (the timetable and the fuel gauge through the meter) make no doc update', () => {
    const { route, start } = started(saved([0, 1], { homeRefuel: true }));
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const updates = countUpdates(doc);
    const legs = new Set<number>();
    for (let t = T0; t <= T0 + 6 * HOUR; t += 47 * SEC) {
      clock = t;
      const f = routeFlightNow(null, CAP, t)!;
      legs.add(f.legSeq);
      expect(f.ended).toBeNull();
      expect(readFuelLevel(CAP)).toBe(f.fuel);
    }
    expect(legs.size).toBeGreaterThan(50);
    expect(updates.n).toBe(0);
    expect(ckptKeys()).toEqual([`ckpt:${route.startedAt}:0:start`]);
    expect(start.departAt).toBeGreaterThan(T0);
  });

  it('an old client (flight and fuel only) sees no flight change and reads the stored level', () => {
    started(saved([0, 1], { homeRefuel: true }));
    // No route meter installed: what a client without this slice reads.
    expect(readFlightRecord()).toMatchObject({ status: 'docked' });
    expect(readFuelLevel(CAP)).toBe(CAP);
  });
});

// ── Writing checkpoints ──────────────────────────────────────────────────────

describe('writeRouteCheckpoint', () => {
  it('writes one key per event in one transaction', () => {
    const { run, route, start } = started();
    const on = onTime(route, start, 2);
    const hold = holdCheckpoint(route, 1, { at: on[0].arrive + 5 * SEC });
    const updates = countUpdates(doc);
    expect(writeRouteCheckpoint(run, hold, on[0].arrive + 6 * SEC)).toBe(true);
    expect(updates.n).toBe(1);
    expect(map().get(checkpointKey(run, 1, 'hold'))).toEqual(checkpointToWire(hold));
    expect(routeFlightNow(null, CAP, on[0].arrive + 30 * SEC)).toMatchObject({ holding: true, legSeq: 1, departsAt: null });
  });

  it("drops a stale run's write, a malformed entry, and one naming the wrong stop", () => {
    const { run, route, start } = started();
    const on = onTime(route, start, 2);
    const hold = holdCheckpoint(route, 1, { at: on[0].arrive + 5 * SEC });
    expect(writeRouteCheckpoint(run + 1, hold)).toBe(false);
    expect(writeRouteCheckpoint(run, { ...hold, stationId: 'st-0' })).toBe(false);
    expect(writeRouteCheckpoint(run, { ...hold, seenAt: Number.NaN })).toBe(false);
    expect(ckptKeys()).toHaveLength(1);
    // After STOP and finish, no run takes writes at all.
    stopShipRoute(T0 + MIN);
    finishShipRoute();
    expect(writeRouteCheckpoint(run, hold)).toBe(false);
  });

  it('prunes in the same transaction: the anchor, start and entries at or above it stay', () => {
    const { run, route, start } = started(saved([0, 1], { homeRefuel: true }));
    const on = onTime(route, start, 6);
    const hold = holdCheckpoint(route, 1, { at: on[0].arrive + 5 * SEC });
    const dock = dockCheckpoint(route, 1, { at: on[0].arrive + 8 * SEC, stayStart: on[0].arrive + 7 * SEC, pilot: 'robot' })!;
    writeRouteCheckpoint(run, hold, on[0].arrive + 6 * SEC);
    writeRouteCheckpoint(run, dock, on[0].arrive + 9 * SEC);
    map().set(`ckpt:${run - 1}:4:pause`, { at: T0, stationId: 'st-0' }); // a lost run's key
    const later = routeFlightNow(null, CAP, on[3].arrive + 5 * SEC)!;
    expect(later.legSeq).toBe(4);
    const skip = skipCheckpoint(route, 4, { at: on[3].arrive + 5 * SEC, pilot: 'robot' })!;
    const updates = countUpdates(doc);
    expect(writeRouteCheckpoint(run, skip, on[3].arrive + 6 * SEC)).toBe(true);
    expect(updates.n).toBe(1);
    expect(ckptKeys().sort()).toEqual([`ckpt:${run}:0:start`, `ckpt:${run}:4:skip`].sort());
    expect(routeFlightNow(null, CAP, on[3].arrive + 10 * SEC)).toMatchObject({ legSeq: 4, skipped: true, departsAt: skip.departAt });
    expect(pruneRouteCheckpoints(on[3].arrive + 20 * SEC)).toBe(0);
  });

  it('a stored entry that fails the shape guard is skipped, not fatal', () => {
    const { run, route, start } = started();
    const on = onTime(route, start, 3);
    map().set(checkpointKey(run, 1, 'dock'), { at: 'soon', stationId: 'st-1' });
    map().set(checkpointKey(run, 1, 'hold'), { at: -1, stationId: 'st-1', since: -1, seenAt: -1 });
    expect(readRouteCheckpoints().map((e) => e.kind)).toEqual(['start']);
    expect(routeFlightNow(null, CAP, on[1].depart + SEC)).toMatchObject({ status: 'in-flight', legSeq: 1 });
  });

  it('a reader looks at no more than 64 checkpoint keys', () => {
    const { run } = started();
    for (let k = 1; k <= 100; k++) map().set(checkpointKey(run, 10_000 + k, 'pause'), { at: T0 + k, stationId: `st-${k % 2}` });
    expect(readRouteCheckpoints().length).toBeLessThanOrEqual(MAX_CHECKPOINT_KEYS_SCANNED);
    expect(readRouteCheckpoints()[0]).toMatchObject({ kind: 'start' });
  });
});

// ── Two writers of one event ─────────────────────────────────────────────────

describe('two games writing one event converge', () => {
  it('two riders stamping the same dock differently end on one timetable', () => {
    const a = doc;
    const { run, route, start } = started(saved([0, 1], { homeRefuel: true }));
    const on = onTime(route, start, 4);
    const b = new Y.Doc();
    sync(a, b);
    const S = legWindowAfter(route, 1, 0)!.synodicMs;
    const hold = holdCheckpoint(route, 1, { at: on[0].arrive + 5 * SEC });
    const dockedA = on[1].depart + 30 * SEC;
    const dockedB = dockedA + S;
    const dockA = dockCheckpoint(route, 1, { at: dockedA + 2 * SEC, stayStart: dockedA, pilot: 'robot' })!;
    const dockB = dockCheckpoint(route, 1, { at: dockedB + 2 * SEC, stayStart: dockedB, pilot: 'robot' })!;
    const t = dockedB + 5 * SEC;

    bindShipDoc(a);
    expect(writeRouteCheckpoint(run, hold, on[0].arrive + 6 * SEC)).toBe(true);
    expect(writeRouteCheckpoint(run, dockA, dockA.at)).toBe(true);
    const beforeA = routeFlightNow(null, CAP, t)!;
    bindShipDoc(b);
    expect(writeRouteCheckpoint(run, hold, on[0].arrive + 7 * SEC)).toBe(true);
    expect(writeRouteCheckpoint(run, dockB, dockB.at)).toBe(true);
    const beforeB = routeFlightNow(null, CAP, t)!;
    expect(beforeA.departsAt).not.toBe(beforeB.departsAt);

    sync(a, b);
    bindShipDoc(a);
    const afterA = routeFlightNow(null, CAP, t);
    const keysA = [...a.getMap('ship').keys()].sort();
    bindShipDoc(b);
    const afterB = routeFlightNow(null, CAP, t);
    expect(afterA).toEqual(afterB);
    expect([...b.getMap('ship').keys()].sort()).toEqual(keysA);
    expect([dockA.departAt, dockB.departAt]).toContain(afterA!.departsAt);
    // Every later leg moved with the winning dock, in both games alike.
    for (const later of [afterA!.departsAt! + HOUR, afterA!.departsAt! + 5 * HOUR]) {
      bindShipDoc(a);
      const fa = routeFlightNow(null, CAP, later);
      expect(fa!.ended).toBeNull();
      bindShipDoc(b);
      expect(routeFlightNow(null, CAP, later)).toEqual(fa);
    }
  });

  it('two STARTs merge to one run: the loser ends up with no keys the winner reads', () => {
    const a = doc;
    writeShipRoute(saved());
    const b = new Y.Doc();
    sync(a, b);
    bindShipDoc(a);
    startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 50, capacity: CAP });
    bindShipDoc(b);
    startShipRoute({ now: T0 + SEC, startStop: 1, pilot: 'person', fuel: 50, capacity: CAP });
    sync(a, b);
    bindShipDoc(a);
    const route = readShipRoute()!;
    const ckA = readRouteCheckpoints();
    bindShipDoc(b);
    expect(readShipRoute()).toEqual(route);
    expect(readRouteCheckpoints()).toEqual(ckA);
    expect(ckA.map((e) => e.kind)).toEqual(['start']);
    expect(ckA[0].stationId).toBe(route.stops[route.startStop!].stationId);
    // The next writer's prune clears the losing run's key.
    pruneRouteCheckpoints(T0 + 2 * SEC);
    expect([...b.getMap('ship').keys()].filter((k) => k.startsWith('ckpt:'))).toEqual([`ckpt:${route.startedAt}:0:start`]);
  });
});

// ── STOP and finish ──────────────────────────────────────────────────────────

describe('STOP and finish', () => {
  it('STOP stamps stoppedAt once; the timetable pins the ferry at its end stop', () => {
    const { route, start } = started();
    const on = onTime(route, start, 4);
    expect(stopShipRoute(on[0].arrive + 10 * SEC)).toBe(true);
    expect(stopShipRoute(on[0].arrive + 20 * SEC)).toBe(false);
    expect(readShipRoute()!.stoppedAt).toBe(on[0].arrive + 10 * SEC);
    expect(routeFlightNow(null, CAP, on[3].arrive + HOUR)).toMatchObject({ status: 'docked', stopIndex: 1, ended: 'stop' });
  });

  it('STOP never stamps before the run began', () => {
    started();
    expect(stopShipRoute(T0 - HOUR)).toBe(true);
    expect(readShipRoute()!.stoppedAt).toBe(T0);
    expect(stopShipRoute(T0)).toBe(false);
  });

  it('finish clears the run and its keys first, then runs the caller writes, in one transaction', () => {
    const { route, start } = started(saved(), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const on = onTime(route, start, 4);
    stopShipRoute(on[0].arrive + 10 * SEC);
    clock = on[3].arrive;
    const f = routeFlightNow(null, CAP, clock)!;
    expect(f).toMatchObject({ ended: 'stop', stopIndex: 1 });
    const level = readFuelLevel(CAP);
    expect(level).toBe(70 - routeLegFuel(route, 0, 1)!);
    const updates = countUpdates(doc);
    let meterDuringApply = -1;
    expect(finishShipRoute(() => {
      meterDuringApply = readStoredFuelLevel() - readFuelLevel(CAP); // the route's share
      writeFuelLevel(level, CAP);
    })).toBe(true);
    expect(updates.n).toBe(1);
    expect(meterDuringApply).toBe(0);
    expect(readShipRoute()).toEqual(routeWithoutRun(route));
    expect(ckptKeys()).toEqual([]);
    expect(readFuelLevel(CAP)).toBe(level);
    expect(fuelDrawDeficit()).toBe(0);
    expect(finishShipRoute()).toBe(false);
  });
});

// ── The route's fuel meter ───────────────────────────────────────────────────

describe('the route fuel meter', () => {
  it('reads how far below the stored level the route has taken the tank', () => {
    expect(routeFuelDebt(100, 100, 37)).toBe(63);
    expect(routeFuelDebt(100, 100, 120)).toBe(0);
    expect(routeFuelDebt(150, 100, 37)).toBe(63);
    expect(routeFuelDebt(Number.NaN, 100, 37)).toBe(0);
    expect(routeFuelDebt(100, 0, 37)).toBe(0);
    expect(routeFuelDebt(100, 100, -5)).toBe(100);
  });

  it('each leg burns through the meter, and the home refill fills the tank with no write', () => {
    const { route, start } = started(saved([0, 1], { homeRefuel: true }), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 4);
    const updates = countUpdates(doc);
    expect(readStoredFuelLevel()).toBe(CAP);
    expect(readFuelLevel(CAP)).toBe(70);
    clock = on[0].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(70 - 2 * cost);
    clock = on[1].arrive + SEC; // home again: full
    expect(readFuelLevel(CAP)).toBe(CAP);
    clock = on[2].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - cost);
    expect(updates.n).toBe(0);
    expect(fuelDrawDeficit()).toBe(0);
  });

  it('REFUEL writes its checkpoint first, then the level, and later burns still come off', () => {
    const { run, route, start } = started(saved(), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 4);
    clock = on[0].arrive + 30 * SEC;
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    expect(writeRouteCheckpoint(run, fuelCheckpoint(route, 1, { at: clock, fuel: CAP }), clock)).toBe(true);
    writeFuelLevel(CAP, CAP);
    expect(readFuelLevel(CAP)).toBe(CAP);
    expect(fuelDrawDeficit()).toBe(0);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - cost);
    clock = on[2].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - 2 * cost);
  });

  it('(why the order matters) the level written first would swallow the next burn', () => {
    const { run, route, start } = started(saved(), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const on = onTime(route, start, 3);
    clock = on[0].arrive + 30 * SEC;
    writeFuelLevel(CAP, CAP);
    writeRouteCheckpoint(run, fuelCheckpoint(route, 1, { at: clock, fuel: CAP }), clock);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP);
  });

  it('a paused route reads the stored level: PAUSE writes the derived level after its checkpoint', () => {
    const { run, route, start } = started(saved([0, 1], { homeRefuel: true }), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 3);
    clock = on[0].arrive + 20 * SEC;
    const level = readFuelLevel(CAP);
    expect(level).toBe(70 - cost);
    expect(writeRouteCheckpoint(run, pauseCheckpoint(route, 1, { at: clock }), clock)).toBe(true);
    expect(routeFlightNow(null, CAP, clock)).toMatchObject({ paused: true });
    // The meter now reads 0: the stored ceiling shows until PAUSE writes.
    expect(readFuelLevel(CAP)).toBe(CAP);
    writeFuelLevel(level, CAP);
    expect(readFuelLevel(CAP)).toBe(level);
    expect(fuelDrawDeficit()).toBe(0);
    // Hours later the paused route still draws nothing.
    clock = on[2].arrive + 5 * HOUR;
    expect(readFuelLevel(CAP)).toBe(level);
  });

  it('reads 0 with no route, no tanks, or a hostile route', () => {
    let capacity = CAP;
    installRouteFuelMeter({ capacity: () => capacity, clock: () => clock });
    writeFuelLevel(80, CAP);
    expect(readFuelLevel(CAP)).toBe(80);
    const { route, start } = started(saved(), 80);
    const on = onTime(route, start, 2);
    clock = on[0].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(80 - routeLegFuel(route, 0, 1)!);
    capacity = 0;
    expect(readFuelLevel(CAP)).toBe(80);
    capacity = CAP;
    map().set('route', { ...wire(saved()), startedAt: T0, shape: 'spiral' });
    expect(readFuelLevel(CAP)).toBe(80);
  });

  it('uninstalling removes the meter', () => {
    const { route, start } = started(saved(), 70);
    const off = installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    clock = onTime(route, start, 1)[0].depart + SEC;
    expect(readFuelLevel(CAP)).toBeLessThan(70);
    off();
    expect(readFuelLevel(CAP)).toBe(70);
  });
});
