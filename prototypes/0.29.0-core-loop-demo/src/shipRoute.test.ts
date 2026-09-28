/**
 * 🚏 Ship route — the route and its checkpoints in the ship's room doc (build
 * notes A1 + A2): the stored shapes and their guards against hostile values,
 * the checkpoint key codec, the editor's save and the running-route lock,
 * START in one transaction (the fuel ceiling first, other runs' keys gone),
 * on-time legs writing nothing, one key per event (two writers converge),
 * pruning inside the writer's transaction, the reader's key cap, STOP and
 * finish, and the route's fuel draw meter (the home refill with no write,
 * REFUEL's order, a paused route reading the stored level). A4: the flight
 * PR 172's readers follow (readResolvedFlight), the copy-back after STOP in
 * one transaction (through redocking), and REFUEL through the route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import {
  dockCheckpoint,
  fuelCheckpoint,
  holdCheckpoint,
  legWindowAfter,
  pauseCheckpoint,
  routeLegFuel,
  skipCheckpoint,
  startCheckpoint,
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
  writeFlightRecord,
  writeFuelLevel,
} from './shipDoc';
import { DEFAULT_STATIONS, setStationDirectory } from './stationDirectory';
import {
  CHECKPOINT_KINDS,
  MAX_CHECKPOINT_KEYS_SCANNED,
  ROUTE_FUEL_METER,
  ROUTE_MIN_CLIENT,
  RUN_AHEAD_MS,
  capCheckpoints,
  checkpointFromWire,
  checkpointKey,
  checkpointToWire,
  finishShipRoute,
  installRouteFlight,
  installRouteFuelMeter,
  onRouteWritten,
  parseCheckpointKey,
  pruneRouteCheckpoints,
  raiseRouteFuelCeiling,
  raisedMinClient,
  readResolvedFlight,
  readRouteCheckpoints,
  readRouteFlight,
  readEndedRun,
  readShipRoute,
  refuelShipRoute,
  resolveShipFlight,
  routeBerthFromWire,
  routeFlightNow,
  routeFuelDebt,
  routeRulesFlightNow,
  routeToWire,
  routeWithoutRun,
  settleRouteFlight,
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
  it('a run stamped far past the clock is no run: it locks nothing, and START replaces it', () => {
    expect(writeShipRoute(saved())).toBe(true);
    const far = T0 + RUN_AHEAD_MS + 1;
    // A peer's write straight into the ship map: a run and its start entry.
    const ghost: ShipRoute = { ...saved(), startedAt: far, startStop: 0 };
    map().set('route', wire(ghost));
    map().set(checkpointKey(far, 0, 'start'), checkpointToWire(startCheckpoint(ghost, { at: far, pilot: 'robot', fuel: 70 })!));
    expect(readShipRoute(T0)).toEqual(saved());
    expect(readRouteCheckpoints(T0)).toEqual([]);
    expect(routeFlightNow(null, CAP, T0)).toBeNull();
    // A clock a little behind the writer's still reads it as a run.
    expect(readShipRoute(T0 + 1)).toMatchObject({ startedAt: far });
    // A STOP stamped that far ahead is no run either.
    map().set('route', wire({ ...saved(), startedAt: T0, startStop: 0, stoppedAt: far }));
    expect(readShipRoute(T0)).toEqual(saved());
    map().set('route', wire(ghost));
    // START runs from now (not past the far run's id), and its keys go.
    expect(startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 70, capacity: CAP })).toBe(T0);
    expect(readShipRoute(T0)).toMatchObject({ startedAt: T0, startStop: 0 });
    expect(ckptKeys()).toEqual([`ckpt:${T0}:0:start`]);
  });

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
    expect(doc.getMap('roomInfo').get('minClient')).toBeUndefined();
  });

  it("raises the room's minClient advisory in START's own transaction, and never lowers it", () => {
    const info = doc.getMap('roomInfo');
    writeShipRoute(saved());
    expect(info.get('minClient')).toBeUndefined(); // a saved route alone asks nothing
    const updates = countUpdates(doc);
    startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 50, capacity: CAP });
    expect(updates.n).toBe(1);
    expect(info.get('minClient')).toBe(ROUTE_MIN_CLIENT);

    bindShipDoc(new Y.Doc());
    const later = shipDocHandle()!.doc.getMap('roomInfo');
    later.set('minClient', '0.40.2');
    writeShipRoute(saved());
    startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 50, capacity: CAP });
    expect(later.get('minClient')).toBe('0.40.2');
  });
});

describe('raisedMinClient (the roomInfo advisory)', () => {
  it('asks for the newer of the two versions, numerically', () => {
    expect(raisedMinClient(undefined, '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient('0.32.36', '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient('0.37.9', '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient('0.38.0', '0.38.0')).toBeNull();
    expect(raisedMinClient('0.38.1', '0.38.0')).toBeNull();
    expect(raisedMinClient('0.100.0', '0.38.0')).toBeNull(); // not a string compare
    expect(raisedMinClient('1.0.0', '0.38.0')).toBeNull();
    expect(raisedMinClient('0.39.0-beta.1', '0.38.0')).toBeNull();
  });

  it("replaces a peer's junk, and asks nothing for a malformed need", () => {
    expect(raisedMinClient(42, '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient('latest', '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient({ v: 1 }, '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient('9'.repeat(40), '0.38.0')).toBe('0.38.0');
    expect(raisedMinClient('0.1.0', 'soon')).toBeNull();
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

  it('the cap picks by stay, never by the copy\'s key order: marks first, then the newest', () => {
    const { run, route } = started();
    const pauses = Array.from({ length: 100 }, (_, i) => ({ k: 10_000 + i + 1, at: T0 + i + 1 }));
    const resume = { k: 10_050, kind: 'dock' as const };
    // Two copies of one map, keys set in opposite orders.
    const fill = (m: Y.Map<unknown>, order: typeof pauses) => {
      for (const p of order) m.set(checkpointKey(run, p.k, 'pause'), { at: p.at, stationId: `st-${stopAt(route, p.k)}` });
    };
    fill(map(), pauses);
    map().set(checkpointKey(run, resume.k, 'dock'), {
      at: T0 + 50, stationId: `st-${stopAt(route, resume.k)}`, stayStart: T0 + 50, departAt: T0 + 60, arriveAt: T0 + 70, pilot: 'robot', resume: true,
    });
    const a = readRouteCheckpoints();
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(shipDocHandle()!.doc));
    const reversed = new Y.Doc();
    const rm = reversed.getMap('ship');
    const src = other.getMap('ship');
    for (const key of [...src.keys()].reverse()) rm.set(key, src.get(key));
    bindShipDoc(reversed);
    const b = readRouteCheckpoints();
    expect(b).toEqual(a);
    expect(a).toHaveLength(MAX_CHECKPOINT_KEYS_SCANNED);
    expect(a[0]).toMatchObject({ kind: 'start' });
    expect(a.some((e) => e.kind === 'dock' && e.resume === true)).toBe(true);
    // The newest others fill the rest: 62 pauses, stays 10039 to 10100.
    const kept = a.filter((e) => e.kind === 'pause').map((e) => e.legSeq);
    expect(kept).toEqual(pauses.slice(-62).map((p) => p.k));
    // Pure, and under the cap it only sorts.
    const few = capCheckpoints([a[3], a[1], a[0]], 64);
    expect(few).toEqual([a[0], a[1], a[3]]);
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

  it('two STARTs at once: every game reads the later run, as boards do, whichever route write the merge kept', () => {
    for (const aKept of [true, false]) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      // Of two concurrent writes to one key, the merge keeps the larger client id's.
      a.clientID = aKept ? 2 : 1;
      b.clientID = aKept ? 1 : 2;
      bindShipDoc(a);
      writeShipRoute(saved());
      sync(a, b);
      startShipRoute({ now: T0, startStop: 0, pilot: 'robot', fuel: 50, capacity: CAP });
      bindShipDoc(b);
      startShipRoute({ now: T0 + SEC, startStop: 1, pilot: 'person', fuel: 50, capacity: CAP });
      sync(a, b);
      expect((a.getMap('ship').get('route') as { startedAt: number }).startedAt).toBe(aKept ? T0 : T0 + SEC);
      for (const d of [a, b]) {
        bindShipDoc(d);
        expect(readShipRoute()).toEqual({ ...saved(), startedAt: T0 + SEC, startStop: 1 });
        expect(readRouteCheckpoints()).toEqual([expect.objectContaining({ kind: 'start', pilot: 'person', stationId: 'st-1' })]);
      }
      // The earlier run's writes are dropped, and the finish names the later run.
      bindShipDoc(a);
      expect(writeRouteCheckpoint(T0, pauseCheckpoint(saved(), 0, { at: T0 + 2 * SEC })!, T0 + 2 * SEC)).toBe(false);
      const heard: unknown[] = [];
      const off = onRouteWritten((n) => heard.push(n));
      expect(finishShipRoute()).toBe(true);
      off();
      expect(heard).toEqual([{ kind: 'finish', run: T0 + SEC }]);
    }
  });

  it('a later start entry that names no stop, or sits past RUN_AHEAD_MS, leaves the stored run', () => {
    const { run, route } = started();
    const far = T0 + RUN_AHEAD_MS + 1;
    const ghost: ShipRoute = { ...saved(), startedAt: far, startStop: 1 };
    map().set(checkpointKey(far, 0, 'start'), checkpointToWire(startCheckpoint(ghost, { at: far, pilot: 'person', fuel: 70 })!));
    const stray = { ...checkpointToWire(startCheckpoint({ ...ghost, startedAt: T0 + SEC }, { at: T0 + SEC, pilot: 'person', fuel: 70 })!), stationId: 'st-elsewhere' };
    map().set(checkpointKey(T0 + SEC, 0, 'start'), stray);
    expect(readShipRoute(T0)).toEqual(route);
    expect(readShipRoute(T0)!.startedAt).toBe(run);
    // A clock a little behind the far writer's reads the far run.
    expect(readShipRoute(T0 + 1)).toMatchObject({ startedAt: far, startStop: 1 });
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

  it("a finish keeps its run's start key: a START from a clock behind that run still gets a later run id", () => {
    // Rider A's clock runs a minute fast: its run's id is T0 + MIN.
    writeShipRoute(saved());
    writeFuelLevel(70, CAP);
    expect(readEndedRun(T0)).toBeUndefined();
    const first = startShipRoute({ now: T0 + MIN, startStop: 0, pilot: 'person', fuel: 70, capacity: CAP })!;
    expect(first).toBe(T0 + MIN);
    expect(writeRouteCheckpoint(first, pauseCheckpoint(readShipRoute()!, 0, { at: T0 + MIN + SEC })!, T0 + MIN + SEC)).toBe(true);
    expect(stopShipRoute(T0 + MIN + 2 * SEC)).toBe(true);
    expect(readEndedRun(T0 + MIN + 2 * SEC)).toBeUndefined(); // a run still flies
    expect(finishShipRoute()).toBe(true);
    expect(ckptKeys()).toEqual([`ckpt:${first}:0:start`]);
    // 🏁 The kept key says which run ended (boards order "no run flies" by it).
    expect(readEndedRun(T0 + 10 * SEC)).toBe(first);
    // Rider B, whose clock is right, STARTs again 20 s later.
    const next = startShipRoute({ now: T0 + 20 * SEC, startStop: 0, pilot: 'person', fuel: 70, capacity: CAP });
    expect(next).toBe(first + 1);
    expect(ckptKeys()).toEqual([`ckpt:${first + 1}:0:start`]);
    expect(readEndedRun(T0 + 20 * SEC)).toBeUndefined();
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
    // 🏁 Only the run's start key stays: the next run's id goes past it.
    expect(ckptKeys()).toEqual([`ckpt:${route.startedAt}:0:start`]);
    expect(readRouteCheckpoints()).toEqual([]);
    expect(readFuelLevel(CAP)).toBe(level);
    expect(fuelDrawDeficit(ROUTE_FUEL_METER)).toBe(0);
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
    expect(fuelDrawDeficit(ROUTE_FUEL_METER)).toBe(0);
  });

  it('⛽ a tank fitted mid-run: the home refill fills the new capacity, and the gauge shows it', () => {
    let cap = CAP;
    const { route, start } = started(saved([0, 1], { homeRefuel: true }), 70);
    installRouteFuelMeter({ capacity: () => cap, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 4);
    // Another consumer's draw before the tank goes in (station keeping, say).
    const OTHER = 'test-other';
    let drawn = 0;
    setFuelDrawMeter(OTHER, { read: () => drawn, subscribe: () => () => {} });
    try {
      drawn = 3;
      clock = on[0].depart + SEC;
      expect(readFuelLevel(cap)).toBe(70 - cost - 3);
      cap = 2 * CAP; // a second tank
      expect(raiseRouteFuelCeiling(cap, clock)).toBe(true);
      expect(readStoredFuelLevel()).toBe(2 * CAP);
      // Nothing moves now: the route's debt takes the raise.
      expect(readFuelLevel(cap)).toBe(70 - cost - 3);
      expect(raiseRouteFuelCeiling(cap, clock)).toBe(false); // never twice
      clock = on[1].arrive + SEC; // home again: the new tanks full, less that draw
      expect(readFuelLevel(cap)).toBe(2 * CAP - 3);
      clock = on[2].depart + SEC;
      expect(readFuelLevel(cap)).toBe(2 * CAP - 3 - cost);
      // A tank taken off again never lowers it (the gauge clamps to the tanks).
      expect(raiseRouteFuelCeiling(CAP, clock)).toBe(false);
      expect(readStoredFuelLevel()).toBe(2 * CAP);
    } finally {
      setFuelDrawMeter(OTHER, null);
    }
  });

  it('⛽ the ceiling stays put with no home refill, while paused, and with no run', () => {
    started(saved(), 70);
    installRouteFuelMeter({ capacity: () => 2 * CAP, clock: () => clock });
    expect(raiseRouteFuelCeiling(2 * CAP, clock)).toBe(false);
    expect(readStoredFuelLevel()).toBe(70);
    bindShipDoc(new Y.Doc());
    const { run, route } = started(saved([0, 1], { homeRefuel: true }), 70);
    expect(writeRouteCheckpoint(run, pauseCheckpoint(route, 0, { at: T0 + SEC }), T0 + SEC)).toBe(true);
    expect(raiseRouteFuelCeiling(2 * CAP, T0 + 2 * SEC)).toBe(false);
    expect(readStoredFuelLevel()).toBe(CAP);
    bindShipDoc(new Y.Doc());
    writeShipRoute(saved([0, 1], { homeRefuel: true }));
    writeFuelLevel(50, CAP);
    expect(raiseRouteFuelCeiling(2 * CAP, T0)).toBe(false);
    expect(readStoredFuelLevel()).toBe(50);
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
    expect(fuelDrawDeficit(ROUTE_FUEL_METER)).toBe(0);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - cost);
    clock = on[2].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - 2 * cost);
  });

  it('either order: the level written before its checkpoint still leaves the next burn to come off', () => {
    // ⛽ The route's meter is OWED (shipDoc): a level write never records its
    // debt in the floor, so no writer has to order around it. (Before it was,
    // this order swallowed the next leg's burn.)
    const { run, route, start } = started(saved(), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 3);
    clock = on[0].arrive + 30 * SEC;
    writeFuelLevel(CAP, CAP);
    // Above the route's level, the write shows only once the route says so.
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    writeRouteCheckpoint(run, fuelCheckpoint(route, 1, { at: clock, fuel: CAP }), clock);
    expect(readFuelLevel(CAP)).toBe(CAP);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - cost);
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
    expect(fuelDrawDeficit(ROUTE_FUEL_METER)).toBe(0);
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

// ── PR 173's meter rules, with the route's meter among them ─────────────────

describe("PR 173's meter rules (the route's meter is owed)", () => {
  // Another consumer drawing through its own running total, the way station
  // keeping's trim burns do (stationKeeping.test.ts pins those on their own).
  const OTHER = 'test-trim';
  let drawn = 0;
  const otherDraws = (amount: number) => { drawn = drawn + fuelDrawDeficit(OTHER) + amount; };
  const storedMeter = () => (map().get('fuel') as { meter?: number } | undefined)?.meter ?? 0;
  beforeEach(() => {
    drawn = 0;
    setFuelDrawMeter(OTHER, { read: () => drawn, subscribe: () => () => {} });
  });
  afterEach(() => setFuelDrawMeter(OTHER, null));

  it('the route registers its own named meter, owed, beside the others', () => {
    const { route, start } = started(saved(), 70);
    const off = installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    clock = onTime(route, start, 1)[0].depart + SEC;
    const cost = routeLegFuel(route, 0, 1)!;
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    // Replacing it under the same name replaces it (one route meter a game).
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    off();
    expect(readFuelLevel(CAP)).toBe(70);
  });

  it("another consumer's draw during a route comes off once, beside the legs", () => {
    const { route, start } = started(saved([0, 1], { homeRefuel: true }), CAP);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 3);
    clock = on[0].depart + SEC;
    expect(fuelDrawDeficit(OTHER)).toBe(0);
    otherDraws(5);
    expect(drawn).toBe(5);
    expect(readFuelLevel(CAP)).toBe(CAP - cost - 5);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - 2 * cost - 5);
    // The home refill fills the route's own legs back, with no write; the
    // other draw stays drawn until a level write folds it (REFUEL, finish).
    clock = on[1].arrive + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - 5);
    expect(fuelDrawDeficit(OTHER)).toBe(0);
  });

  it('a total that went back neither refunds fuel nor frees the next draw while the route owes fuel', () => {
    const { route, start } = started(saved(), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    clock = onTime(route, start, 1)[0].depart + SEC;
    // The level was written after 10 fuel of other draws; then an older
    // record (4 drawn) won a merge. The route owes `cost` on top.
    map().set('fuel', { level: 70, meters: { [OTHER]: 10 } });
    drawn = 4;
    expect(fuelDrawDeficit(OTHER)).toBe(6);
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    otherDraws(3);
    expect(drawn).toBe(13);
    expect(readFuelLevel(CAP)).toBe(70 - cost - 3);
  });

  it('a route writer’s level write records the running totals it saw, never the route’s debt', () => {
    const { run, route, start } = started(saved(), 70);
    installRouteFuelMeter({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 2);
    otherDraws(4);
    clock = on[0].arrive + 20 * SEC;
    const level = readFuelLevel(CAP);
    expect(level).toBe(70 - cost - 4);
    // A route writer's pair (RESUME, REFUEL): its `fuel` entry, and the level.
    expect(writeRouteCheckpoint(run, fuelCheckpoint(route, 1, { at: clock, fuel: level }), clock)).toBe(true);
    writeFuelLevel(level, CAP);
    expect(storedMeter()).toBe(4);
    expect(readFuelLevel(CAP)).toBe(level);
    expect(fuelDrawDeficit(OTHER)).toBe(0);
    // The next leg's burn still comes off in full.
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(level - cost);
  });

  it('START, REFUEL and the finish after STOP write the level through writeFuelLevel against the running totals', () => {
    let off: (() => void) | null = null;
    try {
      const { route, start } = started(saved([0, 1], { homeRefuel: true }), 70);
      expect(readStoredFuelLevel()).toBe(CAP); // START's ceiling
      otherDraws(2);
      off = installRouteFlight({ capacity: () => CAP, clock: () => clock });
      const cost = routeLegFuel(route, 0, 1)!;
      const on = onTime(route, start, 4);
      clock = on[0].arrive + 20 * SEC;
      expect(readFuelLevel(CAP)).toBe(70 - cost - 2);
      expect(refuelShipRoute(CAP, clock)).toBe(true);
      expect(storedMeter()).toBe(2);
      expect(readFuelLevel(CAP)).toBe(CAP);
      otherDraws(1);
      expect(stopShipRoute(clock)).toBe(true);
      clock = on[1].arrive + SEC; // pinned at stop 0 (home: full)
      expect(settleRouteFlight({ now: clock })).toBe('finish');
      expect(readShipRoute()!.startedAt).toBeUndefined();
      expect(storedMeter()).toBe(3);
      expect(readFuelLevel(CAP)).toBe(CAP - 1);
      expect(fuelDrawDeficit(OTHER)).toBe(0);
    } finally {
      off?.();
    }
  });

  it('only shipDoc.writeFuelLevel writes the fuel record', () => {
    // Every route fuel write (and every other) goes through writeFuelLevel,
    // which records the floor; a direct write of the key would skip it.
    const dir = dirname(fileURLToPath(import.meta.url));
    const direct = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'shipDoc.ts')
      .filter((f) => /\.set\(\s*['"`]fuel['"`]/.test(readFileSync(join(dir, f), 'utf8')));
    expect(direct).toEqual([]);
  });
});

// ── The flight PR 172's readers follow (A4) ──────────────────────────────────

describe('readResolvedFlight (A4)', () => {
  let off: (() => void) | null = null;
  let docks: Array<{ stop: number; dockedAt: number }> = [];
  const install = () => {
    off = installRouteFlight({
      capacity: () => CAP,
      clock: () => clock,
      liveDock: () => (_stop, i) => docks.find((d) => d.stop === i)?.dockedAt ?? null,
    });
  };
  const home = { status: 'docked' as const, locationId: 'st-0' };

  beforeEach(() => { docks = []; });
  afterEach(() => { off?.(); off = null; });

  it('reads the stored flight with no route, and before the route flight is installed', () => {
    writeFlightRecord(home);
    expect(readResolvedFlight()).toEqual(home);
    const { route, start } = started();
    clock = onTime(route, start, 1)[0].depart + SEC;
    expect(readResolvedFlight()).toEqual(home);
    expect(readRouteFlight()).toBeNull();
    expect(routeRulesFlightNow()).toBe(false);
    install();
    expect(readResolvedFlight()).toMatchObject({ status: 'in-flight', locationId: 'st-0', destinationId: 'st-1' });
  });

  it('while the route runs unpaused the clock alone moves it: docked, in flight, docked at the next stop, no write', () => {
    writeFlightRecord(home);
    const { route, start } = started();
    install();
    const on = onTime(route, start, 3);
    const updates = countUpdates(doc);
    clock = T0 + SEC;
    expect(readResolvedFlight()).toEqual({ status: 'docked', locationId: 'st-0' });
    expect(routeRulesFlightNow()).toBe(true);
    clock = on[0].depart + SEC;
    expect(readResolvedFlight()).toEqual({
      status: 'in-flight', locationId: 'st-0', destinationId: 'st-1', departedAt: on[0].depart, etaAt: on[0].arrive,
    });
    clock = on[0].arrive + SEC;
    expect(readResolvedFlight()).toEqual({ status: 'docked', locationId: 'st-1' });
    clock = on[1].depart + SEC;
    expect(readResolvedFlight()).toMatchObject({ status: 'in-flight', locationId: 'st-1', destinationId: 'st-0' });
    // The stored record, which older clients read, never moved.
    expect(readFlightRecord()).toEqual(home);
    expect(updates.n).toBe(0);
  });

  it('a live dock at the stop holds the ferry past its departure (the dock gates stay open)', () => {
    const { route, start } = started();
    install();
    const on = onTime(route, start, 2);
    docks = [{ stop: 0, dockedAt: T0 - MIN }];
    clock = on[0].depart + 5 * SEC;
    expect(readResolvedFlight().status).toBe('docked');
    expect(resolveShipFlight().route).toMatchObject({ overdue: true, legSeq: 0 });
    docks = [];
    expect(readResolvedFlight().status).toBe('in-flight');
  });

  it('paused, it reads the stored flight again, and PR 172\'s advance paths run', () => {
    writeFlightRecord(home);
    const { run, route, start } = started();
    install();
    const on = onTime(route, start, 2);
    clock = on[0].arrive + 20 * SEC;
    expect(writeRouteCheckpoint(run, pauseCheckpoint(route, 1, { at: clock }), clock)).toBe(true);
    expect(readRouteFlight()).toMatchObject({ paused: true });
    expect(routeRulesFlightNow()).toBe(false);
    expect(resolveShipFlight()).toEqual({ flight: home, route: null });
  });

  it("reads the route's station ids as this install's", () => {
    setStationDirectory({
      stations: () => DEFAULT_STATIONS,
      resolve: (id) => (id === 'st-0' ? DEFAULT_STATIONS[0].id : id === 'st-1' ? DEFAULT_STATIONS[1].id : null),
    });
    try {
      const { route, start } = started();
      install();
      clock = onTime(route, start, 1)[0].depart + SEC;
      expect(readResolvedFlight()).toMatchObject({ locationId: DEFAULT_STATIONS[0].id, destinationId: DEFAULT_STATIONS[1].id });
    } finally {
      setStationDirectory(null);
    }
  });

  it('a hostile route in the doc reads as none: the stored flight rules', () => {
    writeFlightRecord(home);
    install();
    map().set('route', { ...wire(saved()), startedAt: T0, shape: 'spiral' });
    clock = T0 + HOUR;
    expect(readResolvedFlight()).toEqual(home);
    expect(routeRulesFlightNow()).toBe(false);
  });
});

describe('the copy-back after STOP (A4)', () => {
  let off: (() => void) | null = null;
  const install = () => { off = installRouteFlight({ capacity: () => CAP, clock: () => clock }); };
  afterEach(() => { off?.(); off = null; });

  it('at the end stop, ONE transaction clears the run and writes the derived flight and fuel', () => {
    writeFlightRecord({ status: 'docked', locationId: 'st-0' });
    const { route, start } = started(saved(), 70);
    install();
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 4);
    stopShipRoute(on[0].arrive + 10 * SEC);
    clock = on[3].arrive;
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'st-0' }); // what old clients see
    const updates = countUpdates(doc);
    expect(settleRouteFlight()).toBe('finish');
    expect(updates.n).toBe(1);
    expect(readShipRoute()).toEqual(routeWithoutRun(route));
    expect(ckptKeys()).toEqual([`ckpt:${route.startedAt}:0:start`]); // 🏁 the next run's floor
    // The stored records are true again, for every reader old and new.
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'st-1' });
    expect(readResolvedFlight()).toEqual({ status: 'docked', locationId: 'st-1' });
    expect(readStoredFuelLevel()).toBe(70 - cost);
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    expect(fuelDrawDeficit(ROUTE_FUEL_METER)).toBe(0);
    // Hours later nothing more burns, and there is nothing left to settle.
    clock += 5 * HOUR;
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    expect(settleRouteFlight()).toBeNull();
  });

  it('a stored in-flight record walks through redocking to docked, with no dock of its own', () => {
    writeFlightRecord({ status: 'docked', locationId: 'st-0' });
    const { route, start } = started(saved(), 70);
    install();
    const on = onTime(route, start, 4);
    // As a person's route DEPART writes it (PR 172's own record, for old clients).
    expect(writeFlightRecord({
      status: 'in-flight', locationId: 'st-0', destinationId: 'st-1', departedAt: on[0].depart, etaAt: on[0].arrive,
    })).toBe(true);
    stopShipRoute(on[0].depart + 20 * SEC); // in flight: ends at the next stop
    clock = on[0].arrive + 2 * MIN;
    const seen: string[] = [];
    map().observe((ev) => { if (ev.keysChanged.has('flight')) seen.push((map().get('flight') as { status: string }).status); });
    expect(settleRouteFlight()).toBe('finish');
    expect(seen).toEqual(['docked']); // one transaction: observers see only where it ends
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'st-1' });
    expect(readShipRoute()!.startedAt).toBeUndefined();
  });

  it('waits for the dock at the end stop to answer', () => {
    const { route, start } = started(saved(), 70);
    install();
    const on = onTime(route, start, 2);
    stopShipRoute(on[0].arrive + 10 * SEC);
    clock = on[1].arrive;
    expect(settleRouteFlight({ dockAnswered: () => false })).toBeNull();
    expect(readShipRoute()!.stoppedAt).toBeDefined();
    let asked: number | null = null;
    expect(settleRouteFlight({ dockAnswered: (f) => { asked = f.stopIndex; return true; } })).toBe('finish');
    expect(asked).toBe(1);
  });

  it('mid-route, robot legs write nothing; a landed person\'s in-flight is walked to docked and the route runs on', () => {
    writeFlightRecord({ status: 'docked', locationId: 'st-0' });
    const { route, start } = started(saved([0, 1], { homeRefuel: true }), 70);
    install();
    const on = onTime(route, start, 4);
    const updates = countUpdates(doc);
    for (const t of [T0 + SEC, on[0].depart + SEC, on[0].arrive + SEC, on[2].arrive + SEC]) {
      clock = t;
      expect(settleRouteFlight()).toBeNull();
    }
    expect(updates.n).toBe(0);
    expect(writeFlightRecord({
      status: 'in-flight', locationId: 'st-1', destinationId: 'st-0', departedAt: 1, etaAt: 2,
    })).toBe(true);
    expect(settleRouteFlight()).toBe('follow');
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'st-1' });
    expect(readShipRoute()!.startedAt).toBe(T0);
  });

  it('does nothing before the route flight is installed, or with no route', () => {
    writeFlightRecord({ status: 'docked', locationId: 'st-0' });
    expect(settleRouteFlight()).toBeNull();
    const { route, start } = started();
    stopShipRoute(T0 + SEC);
    clock = onTime(route, start, 1)[0].arrive;
    expect(settleRouteFlight()).toBeNull();
    expect(readShipRoute()!.startedAt).toBe(T0);
  });
});

describe('REFUEL on a running route (A2 fuel, through the route)', () => {
  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; });

  it('docked: its checkpoint first, then the level, in one transaction; later burns still come off', () => {
    const { route, start } = started(saved(), 70);
    off = installRouteFlight({ capacity: () => CAP, clock: () => clock });
    const cost = routeLegFuel(route, 0, 1)!;
    const on = onTime(route, start, 3);
    clock = on[0].arrive + 30 * SEC;
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    const updates = countUpdates(doc);
    expect(refuelShipRoute(CAP)).toBe(true);
    expect(updates.n).toBe(1);
    expect(readRouteCheckpoints().some((e) => e.kind === 'fuel' && e.legSeq === 1 && e.fuel === CAP)).toBe(true);
    expect(readFuelLevel(CAP)).toBe(CAP);
    expect(fuelDrawDeficit(ROUTE_FUEL_METER)).toBe(0);
    clock = on[1].depart + SEC;
    expect(readFuelLevel(CAP)).toBe(CAP - cost);
  });

  it('in flight it waits for the next stop, and with no route it is PR 172\'s REFUEL', () => {
    const { route, start } = started(saved(), 70);
    off = installRouteFlight({ capacity: () => CAP, clock: () => clock });
    clock = onTime(route, start, 1)[0].depart + SEC;
    const updates = countUpdates(doc);
    expect(refuelShipRoute(CAP)).toBe(false);
    expect(updates.n).toBe(0);
    finishShipRoute();
    expect(refuelShipRoute(CAP)).toBe(false);
  });
});
