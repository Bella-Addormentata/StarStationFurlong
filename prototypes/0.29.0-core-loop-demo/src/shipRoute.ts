/**
 * 🚏 Ship route — the ferry's route and its checkpoints, kept in the ship's
 * own room doc (robot pilot routes, build notes A1 + A2; owner decisions
 * 2026-09-27: the schedule belongs to the SHIP, set at the helm, and the
 * robot's Ship pilot routine only makes that robot the ship's autopilot).
 *
 * Storage: two kinds of key in PR 172's `ship` map (shipDoc.ts), beside
 * `fuel`, `flight` and `berths`. Old clients only ever `get` those three, so
 * they never see these.
 *
 *   route                       ShipRoute: the stops, the shape, the ship's
 *                               dock port, the robot captain, the home
 *                               refill, and the RUN fields (startedAt,
 *                               startStop, stoppedAt). Written whole; while
 *                               a run is on, only the run fields change.
 *   ckpt:<run>:<legSeq>:<kind>  one checkpoint (pilotRoute.ts's header has
 *                               the kinds). `run` is route.startedAt.
 *
 * ONE KEY PER EVENT. Two games that see the same event (two riders' keepers
 * noticing the same taken berth) write the same key, and Yjs keeps one of
 * the two values: the room converges. An event at a later stay has another
 * key, so a late write about an old stay never overwrites a newer one. START
 * deletes every other run's keys in its own transaction, and a writer whose
 * run is no longer route.startedAt drops its write. 🏁 Run ids only go up:
 * START moves its id past every run key still in the map, and a finish
 * keeps its run's start key for that; of two STARTs at once, every reader
 * takes the later run (laterRuns), as the departures boards do.
 *
 * A route COPIES what it needs from each stop (planet, orbit slot, berth
 * room and door, gate): station lists and ids are kept per install, and two
 * riders' games must agree on where the ferry is. It never copies a pass:
 * a stop's berth names the room, and the docking game finds its own pass
 * for it (stationAtlas's credential rule, the berth memory's posture).
 *
 * Trust: honest-client reads, like every ship value. Each read is shape-
 * checked (ids bounded to 128 characters, times finite, the berth door a key
 * the doors doc keeps, no pass field) and a malformed value reads as absent.
 * The timetable's own reader checks (pilotRoute.validateCheckpoints) go
 * further. Readers keep no more than 64 checkpoints of a run, picked by stay
 * (capCheckpoints: the marks the walk starts from, then the newest), never by
 * the order this copy's top-level keys iterate in, which differs between
 * replicas; pruning keeps the count far below.
 *
 * FUEL. The ferry's fuel is derived like its position (A3 rule 5: the newest
 * level less every leg since, full again at each arrival at the first stop
 * with the home refill). The tank reads it through the route's own named
 * DRAW METER, 'route' (installRouteFuelMeter, registered through
 * shipDoc.setFuelDrawMeter the way stationKeeping.ts registers
 * 'stationKeeping'): the meter reads how far below the STORED level the
 * route has taken the tank, max(0, stored − derived). So a leg on time
 * writes no fuel, the home refill writes none either (the meter falls back
 * to 0 on arrival), and every existing fuel reader (the helm's gauge,
 * canDepart, tows) sees the route's level with no change of its own.
 *
 *   ⛽ PR 173's meter rules, and why this one is OWED. PR 173's meters are
 *   running totals that only climb; a level write records the reading it
 *   saw (the floor), and a total that goes back (an older record winning a
 *   merge) neither refunds fuel nor lets the next draw go free. The route's
 *   meter goes back by design at every home refill, so it is registered
 *   `owed` (shipDoc): it comes off the level, but never enters the floor a
 *   level write records, nor the deficit another consumer's draw adds. Two
 *   consequences, pinned by shipRoute.test.ts ("PR 173's meter rules"):
 *    - a station-keeping or station-move draw during a route still comes off
 *      once, and a trim total that went back still frees no burn;
 *    - no route writer has to order its `fuel` write around the meter. Every
 *      route fuel write goes through writeFuelLevel (START's ceiling, REFUEL,
 *      PAUSE, RESUME, the finish after STOP), each in one transaction with
 *      its checkpoint, and either order reads the same.
 *   While a route runs the tank reads min(stored, derived): a level write
 *   above the route's level shows only once the route's own checkpoint says
 *   so (REFUEL writes a `fuel` entry; START and RESUME write the CEILING,
 *   the capacity with the home refill, else the level aboard, so the
 *   derived level can climb back to it with no write; a tank fitted mid-run
 *   raises it, raiseRouteFuelCeiling). A PAUSED route's
 *   meter reads 0: the stored level rules while paused, so PAUSE writes the
 *   derived level with its pause entry.
 *   An old client ignores the meter: it reads the ceiling, a stale level, and
 *   its REFUEL or DEPART writes fold nothing of the route's (degrade, not
 *   corrupt). Routes should ship once clients have updated (A4).
 *
 * THE FLIGHT PR 172'S READERS FOLLOW (A4, the last section): while the
 * route runs unpaused, readResolvedFlight hands them the timetable's flight
 * instead of the stored one, PR 172's advance paths stand aside
 * (routeRulesFlightNow), and a helm-gated game copies the timetable back into
 * `flight` and `fuel` after STOP (settleRouteFlight).
 *
 * Pure helpers (guards, key codec) plus the doc binding. Pinned by
 * shipRoute.test.ts; the timetable by pilotRoute.test.ts.
 */

import type * as Y from 'yjs';
import type { DoorWall } from './doorLayoutDoc';
import { isGateNumber } from './doorPolicy';
import { isAcceptableDoorKey } from './doorsDoc';
import {
  MAX_LEG_SEQ,
  checkpointsToPrune,
  createRouteWalkCache,
  fuelCheckpoint,
  isRouteRunning,
  resolvedFlight,
  routeFlightAt,
  routeFlightPlaces,
  routeLegsPlannable,
  routeRefuelStay,
  routeRulesFlight,
  routeSettleAction,
  startCheckpoint,
  stopAt,
} from './pilotRoute';
import type { LiveDockAt, RouteFlight, RouteFlightPlace, RouteFlightPlaces, RouteSettleAction } from './pilotRoute';
import {
  clampFuelToCapacity,
  raiseStoredFuelLevel,
  readFlightRecord,
  readFuelLevel,
  readStoredFuelLevel,
  setFuelDrawMeter,
  shipDocHandle,
  subscribeShip,
  writeFlightRecord,
  writeFuelLevel,
} from './shipDoc';
import type { FlightRecord } from './shipDoc';
import { isUsableOrbit } from './orbits';
import { localStationId } from './stationDirectory';
import { MAX_ORBIT_SLOTS, planetById } from './stations';
import type { StationOrbit } from './stations';

// ── Stored shapes (A1, A9.6) ─────────────────────────────────────────────────

/** Where the ferry docks at a stop, copied on save; never a pass. */
export interface RouteBerth {
  /** The berth room's id. */
  roomId: string;
  /** Required: a stop with no known berth door can't be saved. */
  farDoor: string;
  farWall?: DoorWall;
  farLateral?: number;
  /** ⚓🚦 The stop's gate number, when its port has one. */
  gate?: number;
  /** ⚓🚦 Choice 9 (gate change): dock at any free gate the station allows,
   *  and hold only when every one refuses. False pins the stop to its gate.
   *  Absent on the wire reads as true. */
  anyGate: boolean;
}

/** One stop of a route. */
export interface RouteStop {
  /** For the editor's flags and the reader's stop check only. */
  stationId: string;
  name: string;
  /** Copied on save: the timetable plans from these, never from this game's
   *  station list. */
  planetId: string;
  orbitSlot: number;
  /** 🎚️ Copied on save too: the station's altitude orbit, when it flies one
   *  other than its slot's (stations.StationRecord.orbit). */
  orbit?: StationOrbit;
  berth: RouteBerth;
  /** 30 to 600: the MINIMUM time at the berth. */
  waitSecs: number;
}

export type RouteShape = 'loop' | 'backAndForth';

/** The ship's route (key 'route'). Only the run fields (last three) change
 *  while it runs. */
export interface ShipRoute {
  /** 2 to 8 (MAX_ROUTE_STOPS). */
  stops: RouteStop[];
  shape: RouteShape;
  /** The ship's dock-port door used at every stop. */
  shipPort: string;
  /** The robot captain (its charging dock's item id); absent = people only. */
  robotDockId?: string;
  /** Choice 4 (b): full tanks on each arrival at stops[0]. */
  homeRefuel?: boolean;
  /** Set on START; absent = not running. Also the run id. */
  startedAt?: number;
  /** The stop START was pressed at: stopAt(0). */
  startStop?: number;
  /** Set by STOP (A3 rule 6). */
  stoppedAt?: number;
}

export const MIN_ROUTE_STOPS = 2;
export const MAX_ROUTE_STOPS = 8;
export const MIN_WAIT_SECS = 30;
export const MAX_WAIT_SECS = 600;

// ── Checkpoints (A2) ─────────────────────────────────────────────────────────

/** Who flies: the robot captain, or a person at the helm. */
export type RoutePilot = 'robot' | 'person';
export const ROUTE_PILOTS: readonly RoutePilot[] = ['robot', 'person'];

export type CheckpointKind = 'start' | 'hold' | 'dock' | 'skip' | 'go' | 'helm' | 'pause' | 'fuel';
export const CHECKPOINT_KINDS: readonly CheckpointKind[] = ['start', 'hold', 'dock', 'skip', 'go', 'helm', 'pause', 'fuel'];

/** Every entry: its stay (from the key), when its writer saw the event (its
 *  own clock), and the stop's station id (the reader's stop check). */
interface CheckpointCommon {
  legSeq: number;
  at: number;
  stationId: string;
}

/** START (stay 0). */
export interface StartCheckpoint extends CheckpointCommon {
  kind: 'start';
  stayStart: number;
  departAt: number;
  arriveAt: number;
  pilot: RoutePilot;
  fuel: number;
}
/** The berth refused: the ferry holds (renewed each minute; a renewal keeps
 *  `at` and moves `seenAt`). `since` is `at`. */
export interface HoldCheckpoint extends CheckpointCommon {
  kind: 'hold';
  since: number;
  seenAt: number;
}
/** A dock after a hold, a restarted stay, or RESUME. */
export interface DockCheckpoint extends CheckpointCommon {
  kind: 'dock';
  stayStart: number;
  departAt: number;
  arriveAt: number;
  /** 🧭 The pilot the writer derived for the leg leaving this stay. */
  pilot?: RoutePilot;
  /** 🧭 RESUME: the ship came back to the route here. */
  resume?: true;
}
/** 🚀 Why a stay is skipped, for the robot captain's line (design §4):
 *  every gate `gone` (the berth door or its port was removed), every gate
 *  gone or `shut` to this ship (closed, or reserved for another), or SKIP
 *  STOP at the `helm`. Additive: an older writer leaves it out, and a value
 *  this reader does not know is dropped (the entry itself still counts). */
export type SkipWhy = 'gone' | 'shut' | 'helm';
export const SKIP_WHYS: readonly SkipWhy[] = ['gone', 'shut', 'helm'];

/** The berth is gone or closed, or SKIP STOP. */
export interface SkipCheckpoint extends CheckpointCommon {
  kind: 'skip';
  departAt: number;
  arriveAt: number;
  /** 🧭 The pilot the writer derived for the leg leaving this stay. */
  pilot?: RoutePilot;
  /** 🚀 Why (absent: an older writer, or a reason this reader lacks). */
  why?: SkipWhy;
}
/** A person's route DEPART. */
export interface GoCheckpoint extends CheckpointCommon {
  kind: 'go';
  /** 🧭 The stay start its window was picked from. */
  stayStart: number;
  departAt: number;
  arriveAt: number;
}
/** TAKE THE HELM / HAND TO ROBOT / KEEP THE HELM. The three times are all
 *  there (HAND TO ROBOT at a stay that is not holding) or all absent. */
export interface HelmCheckpoint extends CheckpointCommon {
  kind: 'helm';
  pilot: RoutePilot;
  stayStart?: number;
  departAt?: number;
  arriveAt?: number;
}
/** DEPART off the route. */
export interface PauseCheckpoint extends CheckpointCommon {
  kind: 'pause';
}
/** REFUEL: the level at stay `legSeq`, before its leg. */
export interface FuelCheckpoint extends CheckpointCommon {
  kind: 'fuel';
  fuel: number;
}
export type RouteCheckpoint =
  | StartCheckpoint
  | HoldCheckpoint
  | DockCheckpoint
  | SkipCheckpoint
  | GoCheckpoint
  | HelmCheckpoint
  | PauseCheckpoint
  | FuelCheckpoint;

// ── Shape guards (values cross a trust boundary) ─────────────────────────────

/** Station, room, planet and dock ids: stations.ts's bound. */
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 128;
const DOOR_WALLS: readonly string[] = ['x+', 'x-', 'y+', 'y-'];
/** Same bound the door and atlas records put on a lateral offset. */
const MAX_FAR_LATERAL = 32;
/** The latest time a Date can hold. */
const MAX_TIME_MS = 8.64e15;
/** A fuel level beyond any tank count, rejected rather than clamped. */
const MAX_FUEL = 1e9;

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIME_MS;
}

function isRunId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isPilot(v: unknown): v is RoutePilot {
  return typeof v === 'string' && (ROUTE_PILOTS as readonly string[]).includes(v);
}

/** A stop's copied berth, cleaned, or null. A pass never rides here. */
export function routeBerthFromWire(v: unknown): RouteBerth | null {
  if (!isPlainObject(v)) return null;
  if (v.address !== undefined) return null;
  if (!isId(v.roomId)) return null;
  // The door-key rule the doors doc reads with (the berth memory's check).
  if (!(typeof v.farDoor === 'string' && isAcceptableDoorKey(v.farDoor))) return null;
  if (v.farWall !== undefined && !DOOR_WALLS.includes(v.farWall as string)) return null;
  if (v.farLateral !== undefined && !(typeof v.farLateral === 'number' && Number.isFinite(v.farLateral)
    && Math.abs(v.farLateral) <= MAX_FAR_LATERAL)) return null;
  if (v.gate !== undefined && !isGateNumber(v.gate)) return null;
  if (v.anyGate !== undefined && typeof v.anyGate !== 'boolean') return null;
  const out: RouteBerth = { roomId: v.roomId, farDoor: v.farDoor, anyGate: v.anyGate !== false };
  if (v.farWall !== undefined) out.farWall = v.farWall as DoorWall;
  if (v.farLateral !== undefined) out.farLateral = v.farLateral as number;
  if (v.gate !== undefined) out.gate = v.gate as number;
  return out;
}

/** One stop, cleaned, or null. */
export function routeStopFromWire(v: unknown): RouteStop | null {
  if (!isPlainObject(v)) return null;
  if (!isId(v.stationId) || !isId(v.planetId)) return null;
  if (!(typeof v.name === 'string' && v.name.length > 0 && v.name.length <= MAX_NAME_LEN)) return null;
  const slot = v.orbitSlot;
  if (!(typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < MAX_ORBIT_SLOTS)) return null;
  const wait = v.waitSecs;
  if (!(typeof wait === 'number' && Number.isFinite(wait) && wait >= MIN_WAIT_SECS && wait <= MAX_WAIT_SECS)) return null;
  const berth = routeBerthFromWire(v.berth);
  if (!berth) return null;
  let orbit: StationOrbit | undefined;
  if (v.orbit !== undefined) {
    const o = v.orbit;
    if (!(isPlainObject(o) && typeof o.radiusKm === 'number' && Number.isFinite(o.radiusKm) && o.radiusKm > 0
      && typeof o.phase0 === 'number' && Number.isFinite(o.phase0) && Math.abs(o.phase0) <= 2 * Math.PI)) return null;
    orbit = { radiusKm: o.radiusKm, phase0: o.phase0 };
    // One the station could fly around that planet (orbits.baseOrbit): else
    // the timetable would plan the slot's orbit and the keeper skip the stop.
    if (!isUsableOrbit(planetById(v.planetId), orbit)) return null;
  }
  return {
    stationId: v.stationId, name: v.name, planetId: v.planetId, orbitSlot: slot, ...(orbit ? { orbit } : {}), berth, waitSecs: wait,
  };
}

/**
 * A route off the wire, cleaned, or null when anything is malformed: 2 to 8
 * well-formed stops, a known shape, a dock-port door, every leg plannable
 * (one planet, no two neighbours sharing an orbit), and run fields that make
 * sense together. Without startedAt the other run fields are dropped.
 */
export function shipRouteFromWire(v: unknown): ShipRoute | null {
  if (!isPlainObject(v)) return null;
  if (!Array.isArray(v.stops) || v.stops.length < MIN_ROUTE_STOPS || v.stops.length > MAX_ROUTE_STOPS) return null;
  const stops: RouteStop[] = [];
  for (const raw of v.stops) {
    const stop = routeStopFromWire(raw);
    if (!stop) return null;
    stops.push(stop);
  }
  if (v.shape !== 'loop' && v.shape !== 'backAndForth') return null;
  if (!(typeof v.shipPort === 'string' && isAcceptableDoorKey(v.shipPort))) return null;
  if (v.robotDockId !== undefined && !isId(v.robotDockId)) return null;
  if (v.homeRefuel !== undefined && typeof v.homeRefuel !== 'boolean') return null;
  if (!routeLegsPlannable(stops, v.shape)) return null;
  const out: ShipRoute = { stops, shape: v.shape, shipPort: v.shipPort };
  if (v.robotDockId !== undefined) out.robotDockId = v.robotDockId;
  if (v.homeRefuel !== undefined) out.homeRefuel = v.homeRefuel;
  if (v.startedAt !== undefined) {
    if (!isRunId(v.startedAt)) return null;
    out.startedAt = v.startedAt;
    const startStop = v.startStop ?? 0;
    if (!(typeof startStop === 'number' && Number.isInteger(startStop) && startStop >= 0 && startStop < stops.length)) return null;
    out.startStop = startStop;
    if (v.stoppedAt !== undefined) {
      if (!(isTime(v.stoppedAt) && v.stoppedAt >= v.startedAt)) return null;
      out.stoppedAt = v.stoppedAt;
    }
  }
  return out;
}

/** The route as stored: plain JSON, fields in a fixed order. */
export function routeToWire(route: ShipRoute): Record<string, unknown> {
  const out: Record<string, unknown> = {
    stops: route.stops.map((s) => ({
      stationId: s.stationId,
      name: s.name,
      planetId: s.planetId,
      orbitSlot: s.orbitSlot,
      ...(s.orbit ? { orbit: { radiusKm: s.orbit.radiusKm, phase0: s.orbit.phase0 } } : {}),
      berth: {
        roomId: s.berth.roomId,
        farDoor: s.berth.farDoor,
        ...(s.berth.farWall !== undefined ? { farWall: s.berth.farWall } : {}),
        ...(s.berth.farLateral !== undefined ? { farLateral: s.berth.farLateral } : {}),
        ...(s.berth.gate !== undefined ? { gate: s.berth.gate } : {}),
        anyGate: s.berth.anyGate,
      },
      waitSecs: s.waitSecs,
    })),
    shape: route.shape,
    shipPort: route.shipPort,
  };
  if (route.robotDockId !== undefined) out.robotDockId = route.robotDockId;
  if (route.homeRefuel !== undefined) out.homeRefuel = route.homeRefuel;
  if (route.startedAt !== undefined) {
    out.startedAt = route.startedAt;
    out.startStop = route.startStop ?? 0;
    if (route.stoppedAt !== undefined) out.stoppedAt = route.stoppedAt;
  }
  return out;
}

/** The route with its run fields dropped: what the editor saves, and what a
 *  finished run leaves. */
export function routeWithoutRun(route: ShipRoute): ShipRoute {
  const { startedAt: _s, startStop: _t, stoppedAt: _p, ...rest } = route;
  return rest;
}

// ── Checkpoint keys ──────────────────────────────────────────────────────────

export const CHECKPOINT_PREFIX = 'ckpt:';

/** 🏁 `runRoute:<run>`: the route a START started (routeToWire, with its
 *  run), beside its start entry. The stored `route` is ONE value the merge
 *  keeps by client id, so of two STARTs at once it may hold the other
 *  rider's route (see laterRuns). START, pruning and the finish delete other
 *  runs' copies with their keys. */
export const RUN_ROUTE_PREFIX = 'runRoute:';

export function runRouteKey(run: number): string {
  return `${RUN_ROUTE_PREFIX}${run}`;
}

/** `ckpt:<run>:<legSeq>:<kind>`. */
export function checkpointKey(run: number, legSeq: number, kind: CheckpointKind): string {
  return `${CHECKPOINT_PREFIX}${run}:${legSeq}:${kind}`;
}

/** A checkpoint key's parts, or null. Only the canonical spelling parses
 *  (no leading zeros, no sign), so each event has exactly one key. */
export function parseCheckpointKey(key: string): { run: number; legSeq: number; kind: CheckpointKind } | null {
  if (typeof key !== 'string' || !key.startsWith(CHECKPOINT_PREFIX) || key.length > 64) return null;
  const parts = key.slice(CHECKPOINT_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [runText, seqText, kindText] = parts;
  if (!/^[1-9]\d{0,15}$/.test(runText) || !/^(0|[1-9]\d{0,7})$/.test(seqText)) return null;
  const run = Number(runText);
  const legSeq = Number(seqText);
  if (!isRunId(run) || legSeq > MAX_LEG_SEQ) return null;
  if (!(CHECKPOINT_KINDS as readonly string[]).includes(kindText)) return null;
  return { run, legSeq, kind: kindText as CheckpointKind };
}

/** A checkpoint as stored: its fields, without the key's own (kind, stay). */
export function checkpointToWire(e: RouteCheckpoint): Record<string, unknown> {
  const { kind: _k, legSeq: _l, ...fields } = e;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) out[name] = value;
  return out;
}

/** One checkpoint off the wire (kind and stay from its key), cleaned, or
 *  null. Unknown extra fields are dropped. */
export function checkpointFromWire(kind: CheckpointKind, legSeq: number, v: unknown): RouteCheckpoint | null {
  if (!isPlainObject(v)) return null;
  if (!(Number.isInteger(legSeq) && legSeq >= 0 && legSeq <= MAX_LEG_SEQ)) return null;
  if (!isTime(v.at) || !isId(v.stationId)) return null;
  const common = { legSeq, at: v.at, stationId: v.stationId };
  const times = () => isTime(v.departAt) && isTime(v.arriveAt) && v.arriveAt > v.departAt;
  switch (kind) {
    case 'start': {
      if (!isTime(v.stayStart) || !times() || !isPilot(v.pilot)) return null;
      if (!(typeof v.fuel === 'number' && Number.isFinite(v.fuel) && v.fuel >= 0 && v.fuel <= MAX_FUEL)) return null;
      if (legSeq !== 0) return null;
      return { kind, ...common, stayStart: v.stayStart, departAt: v.departAt as number, arriveAt: v.arriveAt as number, pilot: v.pilot, fuel: v.fuel };
    }
    case 'hold': {
      if (!isTime(v.since) || !isTime(v.seenAt)) return null;
      return { kind, ...common, since: v.since, seenAt: v.seenAt };
    }
    case 'dock': {
      if (!isTime(v.stayStart) || !times()) return null;
      if (v.pilot !== undefined && !isPilot(v.pilot)) return null;
      if (v.resume !== undefined && v.resume !== true) return null;
      return {
        kind, ...common, stayStart: v.stayStart, departAt: v.departAt as number, arriveAt: v.arriveAt as number,
        ...(v.pilot !== undefined ? { pilot: v.pilot as RoutePilot } : {}),
        ...(v.resume === true ? { resume: true as const } : {}),
      };
    }
    case 'skip': {
      if (!times()) return null;
      if (v.pilot !== undefined && !isPilot(v.pilot)) return null;
      // 🚀 An unknown reason (a newer writer's) is dropped, not the skip.
      const why = (SKIP_WHYS as readonly unknown[]).includes(v.why) ? (v.why as SkipWhy) : undefined;
      return {
        kind, ...common, departAt: v.departAt as number, arriveAt: v.arriveAt as number,
        ...(v.pilot !== undefined ? { pilot: v.pilot as RoutePilot } : {}),
        ...(why !== undefined ? { why } : {}),
      };
    }
    case 'go': {
      if (!isTime(v.stayStart) || !times()) return null;
      return { kind, ...common, stayStart: v.stayStart, departAt: v.departAt as number, arriveAt: v.arriveAt as number };
    }
    case 'helm': {
      if (!isPilot(v.pilot)) return null;
      const some = v.stayStart !== undefined || v.departAt !== undefined || v.arriveAt !== undefined;
      if (!some) return { kind, ...common, pilot: v.pilot };
      if (!isTime(v.stayStart) || !times()) return null;
      return { kind, ...common, pilot: v.pilot, stayStart: v.stayStart, departAt: v.departAt as number, arriveAt: v.arriveAt as number };
    }
    case 'pause':
      return { kind, ...common };
    case 'fuel': {
      if (!(typeof v.fuel === 'number' && Number.isFinite(v.fuel) && v.fuel >= 0 && v.fuel <= MAX_FUEL)) return null;
      return { kind, ...common, fuel: v.fuel };
    }
  }
}

// ── Reading the doc ──────────────────────────────────────────────────────────

/** Checkpoints of one run a reader keeps, at most (A2; capCheckpoints). */
export const MAX_CHECKPOINT_KEYS_SCANNED = 64;
/** Ship-map keys a reader visits to find them, at most: junk keys a peer
 *  wrote must not make every read walk an unbounded map. */
const MAX_SHIP_KEYS_VISITED = 256;
/** A writer's cleanup looks further, to find other runs' keys to delete. */
const MAX_PRUNE_KEYS_VISITED = 4096;

interface CheckpointScan {
  entries: RouteCheckpoint[];
  /** Each entry's own key. */
  keys: Map<RouteCheckpoint, string>;
  /** Keys of other runs (START and pruning delete them). */
  otherRuns: string[];
  /** 🏁 Other runs' route copies (runRouteKey), deleted with them. */
  otherRunRoutes: string[];
  /** 🏁 Well-formed start entries of runs later than the one scanned for. */
  laterStarts: Array<{ run: number; entry: StartCheckpoint }>;
}

/** Stay order, then kind order: how every reader sorts a run's entries. */
function byStayAndKind(a: RouteCheckpoint, b: RouteCheckpoint): number {
  return a.legSeq - b.legSeq || CHECKPOINT_KINDS.indexOf(a.kind) - CHECKPOINT_KINDS.indexOf(b.kind);
}

/**
 * The entries a reader keeps of one run (A2's cap), sorted by stay and kind.
 * Pruning keeps a run far below `max`; this is the backstop, and it answers
 * the same in every game whatever order its copy of the map iterates in
 * (the key set decides, never the order): `start`, every RESUME `dock` and
 * every gone `skip` (the marks the timetable is checked and walked from),
 * then the NEWEST others by stay, so a reader never loses the latest news
 * to old entries. Pure.
 */
export function capCheckpoints(entries: readonly RouteCheckpoint[], max: number): RouteCheckpoint[] {
  const sorted = [...entries].sort(byStayAndKind);
  if (sorted.length <= max) return sorted;
  const marks = (e: RouteCheckpoint) => e.kind === 'start'
    || (e.kind === 'dock' && e.resume === true)
    || (e.kind === 'skip' && e.why === 'gone');
  const kept = sorted.filter(marks).slice(-max);
  const rest = sorted.filter((e) => !marks(e));
  const room = Math.max(0, max - kept.length);
  return [...kept, ...(room > 0 ? rest.slice(-room) : [])].sort(byStayAndKind);
}

function scanCheckpoints(map: Y.Map<unknown>, run: number | null, maxKeys: number, maxVisits: number): CheckpointScan {
  const out: CheckpointScan = { entries: [], keys: new Map(), otherRuns: [], otherRunRoutes: [], laterStarts: [] };
  let visited = 0;
  const found: RouteCheckpoint[] = [];
  for (const key of map.keys()) {
    if (++visited > maxVisits) break;
    if (key.startsWith(RUN_ROUTE_PREFIX)) {
      if (key !== (run !== null ? runRouteKey(run) : null)) out.otherRunRoutes.push(key);
      continue;
    }
    if (!key.startsWith(CHECKPOINT_PREFIX)) continue;
    const parsed = parseCheckpointKey(key);
    // An unparseable key may be a newer client's: left alone.
    if (!parsed) continue;
    if (parsed.run !== run) {
      out.otherRuns.push(key);
      if (run !== null && parsed.run > run && parsed.kind === 'start') {
        const entry = checkpointFromWire('start', parsed.legSeq, map.get(key));
        if (entry?.kind === 'start') out.laterStarts.push({ run: parsed.run, entry });
      }
      continue;
    }
    const entry = checkpointFromWire(parsed.kind, parsed.legSeq, map.get(key));
    if (!entry) continue;
    found.push(entry);
    out.keys.set(entry, key);
  }
  // Replicas iterate in their own order: the cap picks by stay, never by the
  // order this copy happened to visit them, so every game reads alike.
  out.entries = Number.isFinite(maxKeys) ? capCheckpoints(found, maxKeys) : found.sort(byStayAndKind);
  return out;
}

// Parsed reads are kept until the ship map changes (a version bumped by the
// ship doc's own change notice, and by each write here, which a meter read
// inside the same transaction must already see). The same objects come back
// between changes, so the timetable's walk cache recognises them.
let docVersion = 0;
subscribeShip(() => {
  docVersion++;
  noteRun();
});

interface Snapshot {
  version: number;
  doc: Y.Doc | null;
  map: Y.Map<unknown> | null;
  /** The route as the ship map stores it. */
  stored: ShipRoute | null;
  /** 🏁 The runs a START began after the stored one's, newest first, each
   *  as the route reads while it flies (see laterRuns). */
  later: ShipRoute[];
  /** Each run's checkpoints, scanned when first read. */
  checkpoints: Map<number, readonly RouteCheckpoint[]>;
  /** The same route without its run: what it reads as while its run's
   *  stamps sit past RUN_AHEAD_MS (kept, so the object stays the same). */
  unran: ShipRoute | null;
}
let snap: Snapshot | null = null;

/**
 * How far past this game's clock a run's START (or STOP) may sit: the same
 * skew the departures and summary readers allow, so every reader agrees on
 * which run flies. The ship doc is peer-written, and a run stamped further
 * ahead (a badly skewed clock, or a hostile write) could make no timetable
 * until then (its start entry is ahead of the clock) yet would lock route
 * edits, towing, the captain and the ship's parts. So it reads as no run,
 * and a new START or a saved edit replaces it.
 */
export const RUN_AHEAD_MS = 6 * 3600 * 1000;

function runTooFarAhead(route: ShipRoute | null, now: number): boolean {
  if (!route || route.startedAt === undefined) return false;
  return route.startedAt > now + RUN_AHEAD_MS || (route.stoppedAt !== undefined && route.stoppedAt > now + RUN_AHEAD_MS);
}

/**
 * 🏁 Two STARTs at once (two riders' games, before either saw the other's)
 * each write the whole route, and the merge keeps ONE of the two writes by
 * the games' client ids, not by which run is later. Each START's own start
 * entry and route copy (runRouteKey) are keys of their own, so both survive.
 * Every reader here, like every departures board
 * (departuresDoc.departureRouteNewer: the larger run id), takes the LATER
 * run: the route its START wrote, whatever route the other rider had saved
 * (the one that START sent the boards), not stopped. With no such copy (a
 * build before it) the stored route with that run's id, starting at the
 * stop its start entry names (the stored start stop when it names the same
 * station). A STOP or checkpoint then writes it as that run, and the earlier
 * run's keys go at the next prune. A start entry naming no stop of its route
 * is ignored.
 */
function laterRuns(stored: ShipRoute & { startedAt: number }, starts: CheckpointScan['laterStarts'], map: Y.Map<unknown>): ShipRoute[] {
  const out: ShipRoute[] = [];
  for (const { run, entry } of [...starts].sort((a, b) => b.run - a.run)) {
    const own = shipRouteFromWire(map.get(runRouteKey(run)));
    if (own && own.startedAt === run && own.stoppedAt === undefined
      && own.stops[own.startStop ?? 0]?.stationId === entry.stationId) {
      out.push(own);
      continue;
    }
    const same = stored.startStop !== undefined && stored.stops[stored.startStop]?.stationId === entry.stationId;
    const startStop = same ? stored.startStop! : stored.stops.findIndex((st) => st.stationId === entry.stationId);
    if (startStop >= 0) out.push({ ...routeWithoutRun(stored), startedAt: run, startStop });
  }
  return out;
}

function snapshot(): Snapshot {
  const h = shipDocHandle();
  const doc = h?.doc ?? null;
  if (snap && snap.version === docVersion && snap.doc === doc) return snap;
  let stored: ShipRoute | null = null;
  let later: ShipRoute[] = [];
  const checkpoints = new Map<number, readonly RouteCheckpoint[]>();
  if (h) {
    stored = shipRouteFromWire(h.map.get('route'));
    if (isRouteRunning(stored)) {
      const scan = scanCheckpoints(h.map, stored.startedAt, MAX_CHECKPOINT_KEYS_SCANNED, MAX_SHIP_KEYS_VISITED);
      checkpoints.set(stored.startedAt, scan.entries);
      later = laterRuns(stored, scan.laterStarts, h.map);
    }
  }
  snap = {
    version: docVersion, doc, map: h?.map ?? null, stored, later, checkpoints,
    unran: isRouteRunning(stored) ? routeWithoutRun(stored) : stored,
  };
  return snap;
}

/** The snapshot as of `now`: the latest run not stamped past RUN_AHEAD_MS
 *  (🏁 laterRuns), or, when there is none, no run. */
function current(now: number): { route: ShipRoute | null; checkpoints: readonly RouteCheckpoint[] } {
  const s = snapshot();
  if (!isRouteRunning(s.stored)) return { route: s.stored, checkpoints: [] };
  const route = [...s.later, s.stored].find((r) => !runTooFarAhead(r, now));
  if (!route || !isRouteRunning(route)) return { route: s.unran, checkpoints: [] };
  let checkpoints = s.checkpoints.get(route.startedAt);
  if (!checkpoints) {
    checkpoints = s.map ? scanCheckpoints(s.map, route.startedAt, MAX_CHECKPOINT_KEYS_SCANNED, MAX_SHIP_KEYS_VISITED).entries : [];
    s.checkpoints.set(route.startedAt, checkpoints);
  }
  return { route, checkpoints };
}

/** The ship's route, or null (none, unbound, or malformed). */
export function readShipRoute(now = Date.now()): ShipRoute | null {
  return current(now).route;
}

/** The running route's checkpoints, shape-checked (the timetable applies
 *  the reader checks); empty when no route runs. */
export function readRouteCheckpoints(now = Date.now()): readonly RouteCheckpoint[] {
  return current(now).checkpoints;
}

const nowCache = createRouteWalkCache();

/** Where the running route puts the ship at `now` (pilotRoute.routeFlightAt
 *  over the doc), or null when no route runs or none can be derived. */
export function routeFlightNow(liveDock: LiveDockAt | null, capacity: number, now = Date.now()): RouteFlight | null {
  const s = current(now);
  return routeFlightAt(s.route, s.checkpoints, liveDock, now, capacity, nowCache);
}

// ── Writing the doc (gated at the caller: the helm gate, or a rider's keeper) ─

function touched(): void {
  docVersion++;
}

// 🚏📋 What THIS game just wrote, for the departures publisher (build notes
// A6: a rider's game publishes the route at START and each checkpoint it
// writes to every stop's board). Heard after the write, inside any outer
// transaction the caller opened (a listener that reads the doc should wait
// for the gesture to end: departuresWrite.ts defers to the next task).

/** A route write this game made: START, a checkpoint (its stay), STOP, or
 *  the finish after STOP. */
export interface RouteWriteNotice {
  kind: 'start' | 'checkpoint' | 'stop' | 'finish';
  /** The stay the write concerns (START: 0). */
  legSeq?: number;
  /** 🚏📋 The finish: the run it ended (route.startedAt), so a board ranks
   *  it above any late snapshot of that run (departuresDoc). */
  run?: number;
}

const writeListeners = new Set<(n: RouteWriteNotice) => void>();

/** Hear this game's own route writes. Returns the unsubscriber. */
export function onRouteWritten(listener: (n: RouteWriteNotice) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

function announce(n: RouteWriteNotice): void {
  for (const listener of [...writeListeners]) {
    try {
      listener(n);
    } catch (err) {
      console.error('[route] write listener threw:', err);
    }
  }
}

/** Delete this run's prunable entries and every other run's keys. Runs
 *  inside the caller's transaction. */
function pruneIn(map: Y.Map<unknown>, route: ShipRoute & { startedAt: number }, now: number): number {
  const scan = scanCheckpoints(map, route.startedAt, Number.POSITIVE_INFINITY, MAX_PRUNE_KEYS_VISITED);
  let deleted = 0;
  for (const key of [...scan.otherRuns, ...scan.otherRunRoutes]) { map.delete(key); deleted++; }
  for (const e of checkpointsToPrune(route, scan.entries, now)) {
    const key = scan.keys.get(e);
    if (key) { map.delete(key); deleted++; }
  }
  if (deleted > 0) touched();
  return deleted;
}

/**
 * Save the route the editor built (or delete it with null). Refused while a
 * run is on (a running route is locked: STOP it to edit) and when malformed.
 * Any run fields on `route` are dropped. Returns whether it wrote.
 */
export function writeShipRoute(route: ShipRoute | null): boolean {
  const h = shipDocHandle();
  if (!h) return false;
  if (isRouteRunning(readShipRoute())) {
    console.warn('[route] a running route is locked: stop it to edit');
    return false;
  }
  if (route === null) {
    h.doc.transact(() => { h.map.delete('route'); touched(); });
    return true;
  }
  const clean = shipRouteFromWire(routeToWire(routeWithoutRun(route)));
  if (!clean) {
    console.warn('[route] refused to write a malformed route', route);
    return false;
  }
  h.doc.transact(() => { h.map.set('route', routeToWire(clean)); touched(); });
  return true;
}

// 🚏🏷️ The roomInfo.minClient advisory (floorplan plan §3.5; floorPlanDoc
// stamps it for a resized room). An older client ignores `route` and the
// `ckpt:` keys and obeys the stored flight (A4): its helm shows the ferry
// where START left it, and a commander on one could DEPART mid-route. So
// START raises the ship room's advisory to the first release that flies
// routes, in its own transaction. Advisory only: no client refuses on it
// yet, it is never lowered, and a room with no route never gets it.

/** The first release that reads ferry routes (the one after v0.37.0). */
export const ROUTE_MIN_CLIENT = '0.38.0';

function versionParts(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string' || v.length > 32) return null;
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The minClient to write so a room asks for at least `need`, or null when
 * `current` already asks for as much or more. A value that is not a version
 * (absent, or a peer's junk) is replaced. Pure.
 */
export function raisedMinClient(current: unknown, need: string): string | null {
  const want = versionParts(need);
  if (!want) return null;
  const have = versionParts(current);
  if (!have) return need;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] < want[i] ? need : null;
  }
  return null;
}

/** What START needs from the helm. */
export interface RouteStartInput {
  now: number;
  /** The stop the ship is docked at. */
  startStop: number;
  pilot: RoutePilot;
  /** The tank's level now (readFuelLevel, clamped to capacity). */
  fuel: number;
  /** The tanks' derived capacity. */
  capacity: number;
}

/**
 * START (helm gate): in one transaction, the fuel ceiling (while the route
 * meter still reads 0; see the header), the run fields, the `start` entry,
 * every other run's checkpoints deleted, and the room's minClient advisory
 * raised to ROUTE_MIN_CLIENT (never lowered). The run id is `now`, moved
 * past any run id still in the map. Refused when no route is saved, one is
 * running, the stop is not on it, or a robot pilot is asked for a route
 * without a robot captain. Returns the run id, or null.
 */
export function startShipRoute(o: RouteStartInput): number | null {
  const h = shipDocHandle();
  const route = readShipRoute(o.now);
  if (!h || !route || isRouteRunning(route)) return null;
  if (!(Number.isInteger(o.startStop) && o.startStop >= 0 && o.startStop < route.stops.length)) return null;
  if (o.pilot === 'robot' && !route.robotDockId) return null;
  if (!Number.isFinite(o.now) || !(o.capacity >= 0)) return null;
  const scan = scanCheckpoints(h.map, null, Number.POSITIVE_INFINITY, MAX_PRUNE_KEYS_VISITED);
  const old = scan.otherRuns;
  let startedAt = Math.max(1, Math.floor(o.now));
  for (const key of old) {
    const run = parseCheckpointKey(key)?.run ?? 0;
    // A run stamped past RUN_AHEAD_MS is no run (its keys go below).
    if (run >= startedAt && run <= o.now + RUN_AHEAD_MS) startedAt = run + 1;
  }
  const running: ShipRoute = { ...routeWithoutRun(route), startedAt, startStop: o.startStop };
  const fuel = clampFuelToCapacity(o.fuel, o.capacity);
  const entry = startCheckpoint(running, { at: startedAt, pilot: o.pilot, fuel });
  if (!entry) return null;
  h.doc.transact(() => {
    // 1. The level first, while no route runs and its meter reads 0.
    writeFuelLevel(route.homeRefuel ? o.capacity : fuel, o.capacity);
    // 2. The run, its anchor, its own copy of the route (laterRuns), and no
    // other run's keys.
    h.map.set('route', routeToWire(running));
    h.map.set(checkpointKey(startedAt, 0, 'start'), checkpointToWire(entry));
    h.map.set(runRouteKey(startedAt), routeToWire(running));
    for (const key of [...old, ...scan.otherRunRoutes]) h.map.delete(key);
    touched();
    // 3. The advisory: an older client flies this ship by its stored flight.
    const info = h.doc.getMap('roomInfo');
    const minClient = raisedMinClient(info.get('minClient'), ROUTE_MIN_CLIENT);
    if (minClient !== null) info.set('minClient', minClient);
  });
  announce({ kind: 'start', legSeq: 0 });
  return startedAt;
}

/** STOP (helm gate): stamp the running route's stoppedAt. The timetable
 *  pins the ship at the end stay (A3 rule 6). Returns whether it wrote. */
export function stopShipRoute(now: number): boolean {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route) || route.stoppedAt !== undefined || !Number.isFinite(now)) return false;
  const stopped: ShipRoute = { ...route, stoppedAt: Math.max(route.startedAt, now) };
  h.doc.transact(() => { h.map.set('route', routeToWire(stopped)); touched(); });
  announce({ kind: 'stop' });
  return true;
}

/**
 * Write one checkpoint for run `run` (the route.startedAt the writer computed
 * it from), and prune, in one transaction. Dropped when that run is no longer
 * the route's (a newer START won), when the entry is malformed, or when it
 * names the wrong stop for its stay. Returns whether it wrote.
 */
export function writeRouteCheckpoint(run: number, entry: RouteCheckpoint, now = Date.now()): boolean {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route) || route.startedAt !== run) return false;
  const wire = checkpointToWire(entry);
  const clean = checkpointFromWire(entry.kind, entry.legSeq, wire);
  if (!clean || clean.stationId !== route.stops[stopAt(route, clean.legSeq)].stationId) {
    console.warn('[route] refused to write a malformed checkpoint', entry);
    return false;
  }
  h.doc.transact(() => {
    h.map.set(checkpointKey(run, clean.legSeq, clean.kind), wire);
    touched();
    pruneIn(h.map, route, now);
  });
  announce({ kind: 'checkpoint', legSeq: clean.legSeq });
  return true;
}

// 🚏🤖 The same reading and writing for ANY ship map: a ferry room a
// station's gate keeper holds a background session to (gateKeeper.ts), which
// is never the bound ship.

/**
 * The route and the running run's checkpoints of any ship map, read exactly
 * as readShipRoute and readRouteCheckpoints read the bound ship's (the latest
 * run not stamped past RUN_AHEAD_MS, 🏁 laterRuns; shape-checked, capped by
 * stay), with no cache. Pure over the map.
 */
export function routeIn(map: Y.Map<unknown>, now = Date.now()): { route: ShipRoute | null; checkpoints: readonly RouteCheckpoint[] } {
  const stored = shipRouteFromWire(map.get('route'));
  if (!isRouteRunning(stored)) return { route: stored, checkpoints: [] };
  const scan = scanCheckpoints(map, stored.startedAt, MAX_CHECKPOINT_KEYS_SCANNED, MAX_SHIP_KEYS_VISITED);
  const route = [...laterRuns(stored, scan.laterStarts, map), stored].find((r) => !runTooFarAhead(r, now));
  if (!route || !isRouteRunning(route)) return { route: routeWithoutRun(stored), checkpoints: [] };
  const checkpoints = route.startedAt === stored.startedAt
    ? scan.entries
    : scanCheckpoints(map, route.startedAt, MAX_CHECKPOINT_KEYS_SCANNED, MAX_SHIP_KEYS_VISITED).entries;
  return { route, checkpoints };
}

/** 🏁 readEndedRun for any ship map: the run the last finish ended, while no
 *  run flies there (as routeIn reads it). Pure over the map. */
export function endedRunIn(map: Y.Map<unknown>, now = Date.now()): number | undefined {
  return isRouteRunning(routeIn(map, now).route) ? undefined : newestRunStartIn(map, now);
}

/**
 * writeRouteCheckpoint for any ship doc: the same checks (the run is still
 * the route's, the entry well formed and at its stay's stop), the same key
 * and the same pruning, in one transaction of that doc. No write notice: the
 * departures publisher publishes the bound ship only, and the gate keeper
 * publishes its own writes. Returns whether it wrote.
 */
export function writeRouteCheckpointIn(doc: Y.Doc, map: Y.Map<unknown>, run: number, entry: RouteCheckpoint, now = Date.now()): boolean {
  const route = routeIn(map, now).route;
  if (!isRouteRunning(route) || route.startedAt !== run) return false;
  const wire = checkpointToWire(entry);
  const clean = checkpointFromWire(entry.kind, entry.legSeq, wire);
  if (!clean || clean.stationId !== route.stops[stopAt(route, clean.legSeq)].stationId) {
    console.warn('[route] refused to write a malformed checkpoint', entry);
    return false;
  }
  doc.transact(() => {
    map.set(checkpointKey(run, clean.legSeq, clean.kind), wire);
    pruneIn(map, route, now);
  });
  return true;
}

/** Prune on its own (a writer tidying up): returns how many keys went. */
export function pruneRouteCheckpoints(now = Date.now()): number {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route)) return 0;
  let deleted = 0;
  h.doc.transact(() => { deleted = pruneIn(h.map, route, now); });
  return deleted;
}

/**
 * Finish a run (A4, after STOP once the ship is at its end stop): in one
 * transaction, clear the run fields and every checkpoint FIRST, so the route
 * meter reads 0, then run `apply` — the caller's writes of the derived flight
 * and fuel (writeFlightRecord, writeFuelLevel), which join this transaction.
 * Compute what `apply` writes before calling. Returns whether a run ended.
 *
 * 🏁 The ended run's START entry stays (nothing reads it while no run is on):
 * a run id is its START's clock, and the next START moves its id past every
 * run key still in the map, so a rider whose clock is behind the one that
 * started this run still starts a LATER run, which every board ranks above
 * this finish. That START deletes it.
 */
export function finishShipRoute(apply?: () => void): boolean {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route)) return false;
  const floor = checkpointKey(route.startedAt, 0, 'start');
  const scan = scanCheckpoints(h.map, null, Number.POSITIVE_INFINITY, MAX_PRUNE_KEYS_VISITED);
  // Every run's route copy goes too: with no run on, nothing reads one.
  const keys = [...scan.otherRuns.filter((key) => key !== floor), ...scan.otherRunRoutes];
  h.doc.transact(() => {
    h.map.set('route', routeToWire(routeWithoutRun(route)));
    for (const key of keys) h.map.delete(key);
    touched();
    apply?.();
  });
  announce({ kind: 'finish', run: route.startedAt });
  return true;
}

/** 🏁 The run the last finish ended, while no run flies: the start key a
 *  finish keeps (above). Undefined while a run flies or none is left; a key
 *  stamped past RUN_AHEAD_MS is no run. The ship's summary says "no run
 *  flies" with it, so a board can tell that end from an older run's
 *  (departuresBoard.routeSummaryFields). */
export function readEndedRun(now = Date.now()): number | undefined {
  const h = shipDocHandle();
  if (!h || isRouteRunning(readShipRoute(now))) return undefined;
  return newestRunStartIn(h.map, now);
}

/** The newest run whose start key a ship map holds, not stamped past
 *  RUN_AHEAD_MS: while no run flies there, the run the last finish ended. */
function newestRunStartIn(map: Y.Map<unknown>, now: number): number | undefined {
  let run: number | undefined;
  for (const key of scanCheckpoints(map, null, Number.POSITIVE_INFINITY, MAX_PRUNE_KEYS_VISITED).otherRuns) {
    const p = parseCheckpointKey(key);
    if (p?.kind !== 'start' || p.run > now + RUN_AHEAD_MS) continue;
    if (run === undefined || p.run > run) run = p.run;
  }
  return run;
}

// ── The route's fuel draw meter ──────────────────────────────────────────────

/** The route's draw meter name (shipDoc.setFuelDrawMeter). */
export const ROUTE_FUEL_METER = 'route';

/** How far below the stored level the route has taken the tank: the route
 *  meter's reading. Never negative, never past the capacity. */
export function routeFuelDebt(storedLevel: number, capacity: number, routeFuel: number): number {
  if (!(capacity > 0) || !Number.isFinite(storedLevel) || !Number.isFinite(routeFuel)) return 0;
  return Math.max(0, Math.min(Math.max(0, storedLevel), capacity) - Math.max(0, routeFuel));
}

/** What the route meter needs from the game: the tanks' capacity, the
 *  ship's live docks (so a ferry stuck at a berth burns nothing), and a
 *  clock (tests). */
export interface RouteFuelMeterDeps {
  capacity: () => number;
  liveDock?: () => LiveDockAt | null;
  clock?: () => number;
}

/**
 * Register the route's draw meter (at the T0 seam beside bindShipDoc, once
 * the capacity is known). While a route runs unpaused the tank reads the
 * route's derived level; otherwise the meter reads 0. It announces no changes
 * of its own: ship-map changes already notify, and between them the clock
 * moves it (readers poll, as the helm's tick does). Returns the uninstaller.
 */
export function installRouteFuelMeter(deps: RouteFuelMeterDeps): () => void {
  const cache = createRouteWalkCache();
  const clock = deps.clock ?? Date.now;
  setFuelDrawMeter(ROUTE_FUEL_METER, {
    // A debt against the stored level that the home refill takes back to 0,
    // not a running total: PR 173's floor and deficit leave it out.
    owed: true,
    read: () => {
      try {
        const now = clock();
        const s = current(now);
        if (!isRouteRunning(s.route)) return 0;
        const capacity = deps.capacity();
        if (!(capacity > 0)) return 0;
        const flight = routeFlightAt(s.route, s.checkpoints, deps.liveDock?.() ?? null, now, capacity, cache);
        if (!flight || flight.paused) return 0;
        return routeFuelDebt(readStoredFuelLevel(), capacity, flight.fuel);
      } catch (err) {
        console.error('[route] fuel meter read failed:', err);
        return 0;
      }
    },
    // Never subscribeShip here: the ship doc's own notify would call back
    // into itself.
    subscribe: () => () => {},
  });
  return () => setFuelDrawMeter(ROUTE_FUEL_METER, null);
}

// ── The flight PR 172's readers follow (A4) ─────────────────────────────────
//
// 🧭 readResolvedFlight lives here, not in shipDoc.ts as A4 sketched: this
// file imports shipDoc (and pilotRoute imports it too), so shipDoc importing
// the route back would be a cycle whose top-level subscribeShip call runs
// before shipDoc's listener set exists.
//
// Every reader of PR 172's flight record that decides what the ship may do
// now reads it through here: the helm (render, DEPART, its tick), the
// holotable, the dock gates in docking.ts (pairingAllowedByFlight, redock's
// re-check included) and main.ts's room-station resolver (which the map and
// the exterior follow). While the route runs unpaused they see the
// timetable's flight, which moves with the clock and is never written: the
// ferry leaves, flies and arrives for them with no write (the docks at each
// end are the keeper's, A5). Paused, not
// running, or with no checkpoint to anchor it, they see the stored `flight`.
//
// PR 172's two advance paths (main.ts's 1 Hz watch, the helm's autoAdvance)
// skip while the route rules the flight: routeRulesFlightNow. The copy-back
// that makes the stored records true again runs from the 1 Hz watch
// (settleRouteFlight, helm-gated there).

/** What the route's flight reads from the game: the tanks' capacity, the
 *  ship's live docks (pilotRoute.liveDockFrom over its berth pairings), and a
 *  clock (tests). */
export type RouteFlightDeps = RouteFuelMeterDeps;

let flightDeps: RouteFlightDeps | null = null;

/**
 * Install the route's flight for this game (main.ts, once, beside the other
 * ship hooks): the route's fuel draw meter and the deps readResolvedFlight
 * derives with. Before this runs every read below answers with the stored
 * records. Returns the uninstaller.
 */
export function installRouteFlight(deps: RouteFlightDeps): () => void {
  const offMeter = installRouteFuelMeter(deps);
  flightDeps = deps;
  return () => {
    if (flightDeps !== deps) return;
    offMeter();
    flightDeps = null;
  };
}

/** The timetable's flight now (a paused route's included), or null: no route
 *  running, none anchored, no deps installed, or a read that failed. */
export function readRouteFlight(now?: number): RouteFlight | null {
  const d = flightDeps;
  // Checked before the deps run: most rooms have no route, and the resolver
  // asks often.
  if (!d || !isRouteRunning(readShipRoute())) return null;
  try {
    const t = now ?? (d.clock ?? Date.now)();
    return routeFlightNow(d.liveDock?.() ?? null, d.capacity(), t);
  } catch (err) {
    console.error('[route] flight read failed:', err);
    return null;
  }
}

/** The flight PR 172's readers follow, and the timetable's own flight when it
 *  is the one they follow (null otherwise). */
export interface ResolvedShipFlight {
  flight: FlightRecord;
  route: RouteFlight | null;
  /** 🚚 Where that timetable flies the ship, on the route's own copy of its
   *  stops (pilotRoute.routeFlightPlaces), when it is the one followed: a
   *  reader placing the ship takes these over the station list. */
  places: RouteFlightPlaces | null;
}

/** readResolvedFlight with the timetable's own figures beside it (the helm
 *  reads both, and 🚚 the planet summary and far view where it flies). */
export function resolveShipFlight(now?: number): ResolvedShipFlight {
  // One time for both reads: which run is current depends on it.
  const t = now ?? (flightDeps?.clock ?? Date.now)();
  const route = readRouteFlight(t);
  const rules = routeRulesFlight(route);
  return {
    flight: resolvedFlight(readFlightRecord(), route, localStationId),
    route: rules ? route : null,
    places: rules ? routeFlightPlaces(readShipRoute(t), route, localStationId) : null,
  };
}

/** A4: the flight PR 172's readers follow. The timetable's (as PR 172's
 *  FlightRecord, station ids read as this install's) while the route runs
 *  unpaused, else readFlightRecord(). */
export function readResolvedFlight(now?: number): FlightRecord {
  return resolveShipFlight(now).flight;
}

/** Does the timetable rule the flight now (a route running, anchored, not
 *  paused)? PR 172's advance paths skip while it does. */
export function routeRulesFlightNow(now?: number): boolean {
  return routeRulesFlight(readRouteFlight(now));
}

// 🏁 The run a finish cleared. A finish (this game's, or one that reaches it
// from the helm commander's game) clears the run in one transaction, and a
// speaker that had not read the route's end by then (the captain reads twice
// a second, the helm once) would never say it (shipPilot.readPilotView). So
// each change to the bound ship map notes the run the doc then holds, and the
// change that clears it keeps that run, with its flight at that moment. A
// STOP that reaches this game in the same update as the finish was never
// seen here: the run keeps the flight it would have flown on (no end, unless
// its timetable had reached one by then). Local, never synced.

/** A run this game saw cleared from the bound ship doc. */
export interface ClearedRun {
  route: ShipRoute & { startedAt: number };
  checkpoints: readonly RouteCheckpoint[];
  /** Its flight when this game saw it cleared (null: none derivable). */
  flight: RouteFlight | null;
  /** When this game saw it cleared. */
  at: number;
}

let runSeen: { doc: Y.Doc; route: ShipRoute & { startedAt: number }; checkpoints: readonly RouteCheckpoint[] } | null = null;
let runCleared: (ClearedRun & { doc: Y.Doc }) | null = null;

/** After each change to the bound ship map (and each bind): the run it
 *  holds now, or, when the run seen before in this doc is gone, that run. */
function noteRun(): void {
  const h = shipDocHandle();
  if (runCleared && runCleared.doc !== h?.doc) runCleared = null;
  const d = flightDeps;
  const now = (d?.clock ?? Date.now)();
  const s = h ? current(now) : null;
  if (h && s && isRouteRunning(s.route)) {
    runSeen = { doc: h.doc, route: s.route, checkpoints: s.checkpoints };
    return;
  }
  const was = runSeen;
  runSeen = null;
  if (!h || !was || was.doc !== h.doc) return;
  let flight: RouteFlight | null = null;
  try {
    flight = d ? routeFlightAt(was.route, was.checkpoints, d.liveDock?.() ?? null, now, d.capacity(), nowCache) : null;
  } catch (err) {
    console.error('[route] cleared run flight failed:', err);
  }
  runCleared = { doc: h.doc, route: was.route, checkpoints: was.checkpoints, flight, at: now };
}

/** 🏁 The run this game last saw cleared from the ship doc bound now (null:
 *  none since it was bound). */
export function readClearedRun(): ClearedRun | null {
  const h = shipDocHandle();
  if (!runCleared || !h || runCleared.doc !== h.doc) return null;
  const { doc: _doc, ...run } = runCleared;
  return run;
}

/** How the copy-back decides the end stop's dock has answered. */
export interface RouteSettleOptions {
  now?: number;
  /** Has the dock at the end stop answered (A4: the keeper's dock there,
   *  docked or refused)? Absent reads as yes: until a keeper docks the
   *  ferry, nothing will, and the route finishes as soon as the ship is at
   *  its end stop, berthless if nobody docked it (dock by hand from there). */
  dockAnswered?: (f: RouteFlight) => boolean;
  /** 🚚 Called once a finish has cleared the run, with where the timetable
   *  left the ship: the route's copy of its end stop (pilotRoute's
   *  routeFlightPlaces, read with the finish's own flight), which that stop's
   *  station may have left since (null: none derivable). A ship no dock
   *  carries rests there (shipArrival.restAtRouteEnd). */
  finished?: (end: RouteFlightPlace | null) => void;
}

/**
 * The A4 copy-back, run by a helm-gated game (main.ts's 1 Hz watch):
 *  - after STOP, once the ship is pinned at its end stop and the dock there
 *    has answered: in ONE transaction, clear the run and its checkpoints
 *    (finishShipRoute: the route meter reads 0 from here), then write the
 *    derived flight (through `redocking` when the stored one is `in-flight`)
 *    and the derived fuel level; then hand `finished` the end stop's copy;
 *  - mid-route, when a person's `in-flight` has been landed by the
 *    timetable: walk the stored flight to `docked` there, one transaction.
 * Returns which it did, or null.
 */
export function settleRouteFlight(o: RouteSettleOptions = {}): RouteSettleAction['kind'] | null {
  const d = flightDeps;
  const h = shipDocHandle();
  if (!d || !h) return null;
  const now = o.now ?? (d.clock ?? Date.now)();
  const route = readRouteFlight(now);
  if (!routeRulesFlight(route)) return null;
  const action = routeSettleAction(readFlightRecord(), route, {
    dockAnswered: o.dockAnswered ? o.dockAnswered(route) : true,
    alias: localStationId,
  });
  if (!action) return null;
  if (action.kind === 'finish') {
    // 🚚 Read before the finish clears the run it is read from.
    const end = routeFlightPlaces(readShipRoute(now), route, localStationId)?.from ?? null;
    const capacity = d.capacity();
    // ⛽ What the tank reads now, with the route's meter still on: the
    // route's level less any other consumer's draw since the level was
    // written (a trim burn), which the route's own accounting never saw.
    const level = Math.min(action.fuel, readFuelLevel(capacity));
    const finished = finishShipRoute(() => {
      for (const rec of action.writes) writeFlightRecord(rec);
      writeFuelLevel(level, capacity);
    });
    if (!finished) return null;
    o.finished?.(end);
    return 'finish';
  }
  h.doc.transact(() => {
    for (const rec of action.writes) writeFlightRecord(rec);
  });
  return 'follow';
}

/**
 * ⛽ A tank fitted while a home-refill route runs. The timetable fills the
 * tanks to the capacity they have NOW at each home arrival, but the gauge
 * reads the lower of the route's level and the CEILING START (or RESUME)
 * stored, the capacity then: past it, a refill could never show, and the
 * copy-back after STOP would cut the level down to it. So the ceiling
 * follows the tanks up: the stored level is raised to the capacity, every
 * other meter's recorded reading kept (shipDoc.raiseStoredFuelLevel), and
 * the route's own debt takes the raise, so the gauge does not move until
 * the route's level does. Only while the route rules the flight: paused,
 * the stored level is the tank's own, and RESUME writes the ceiling anew.
 * Never lowers it (taking a tank off, the gauge clamps to the tanks). Edit
 * mode and the DEV menu refuse a tank change while the timetable flies the
 * ship (routeParts.tanksLockedByRoute: the timetable replays every home
 * refill at the capacity now), so this only meets one made by a game that had
 * not yet seen the route. The helm-gated game calls it (main.ts's watch).
 * Returns whether it wrote.
 */
export function raiseRouteFuelCeiling(capacity: number, now = Date.now()): boolean {
  const route = readShipRoute(now);
  if (!isRouteRunning(route) || !route.homeRefuel || !(capacity > 0)) return false;
  if (!routeRulesFlight(routeFlightNow(null, capacity, now))) return false;
  return raiseStoredFuelLevel(capacity, capacity);
}

/**
 * REFUEL on a running route (helm gate; A2's `fuel`): in one transaction,
 * the `fuel` checkpoint at the stay the ship is docked at FIRST (the derived
 * level jumps to full and the route meter reads 0), then the level (see the
 * header). False when the timetable does not rule the flight (the caller
 * refuels as PR 172 does) or has the ship in flight (REFUEL waits for the
 * next stop: routeRefuelStay).
 */
export function refuelShipRoute(capacity: number, now?: number): boolean {
  const h = shipDocHandle();
  const route = readShipRoute();
  const d = flightDeps;
  if (!h || !d || !isRouteRunning(route) || !(capacity > 0)) return false;
  const at = now ?? (d.clock ?? Date.now)();
  const f = readRouteFlight(at);
  if (!routeRulesFlight(f)) return false;
  const stay = routeRefuelStay(f);
  if (stay === null) return false;
  const full = clampFuelToCapacity(capacity, capacity);
  let wrote = false;
  h.doc.transact(() => {
    wrote = writeRouteCheckpoint(route.startedAt, fuelCheckpoint(route, stay, { at, fuel: full }), at);
    if (wrote) writeFuelLevel(full, capacity);
  });
  return wrote;
}
