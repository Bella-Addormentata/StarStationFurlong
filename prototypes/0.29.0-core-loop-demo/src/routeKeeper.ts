/**
 * 🚏🛟 Route keeper — docks and casts off a ferry on its timetable (robot
 * pilot routes, build notes A5 and the gate parts of A9; owner decisions
 * 2026-09-27: WAIT for a taken berth, GATE CHANGE at a stop, the station
 * decides who may dock at each gate).
 *
 * The timetable (pilotRoute.ts) says where the ferry is; nothing in it docks
 * anything. The keeper is the small loop that makes the ship's DOCKS agree
 * with it. It runs once a second in EVERY game in the ship's room while a
 * route runs unpaused (main.ts's 1 Hz watch; choice 8 (a): with nobody
 * aboard nothing docks or undocks), and it is LEVEL-TRIGGERED: each tick it
 * compares where the timetable puts the ship with the ship's live docks and
 * acts on the difference, so a rider who boards late, a second rider's
 * keeper, or a tick that failed all converge on the same result.
 *
 * ─── What each tick does (keeperStep) ────────────────────────────────────────
 *
 *   timetable says          live docks say           the keeper
 *   ───────────────         ──────────────           ──────────
 *   in flight               docked anywhere          CAST OFF (a dock at the
 *                                                    next stop made by a peer
 *                                                    whose clock runs ahead
 *                                                    is left alone)
 *   at stop S               route port docked at     CAST OFF the route port
 *                           another stop             first, then dock (a dock
 *                                                    this game cannot place is
 *                                                    left until the departure)
 *   at S, holding           docked at S              write `dock`: the hold
 *                                                    ends, the stay starts at
 *                                                    the dock's own stamp
 *   at S, on time           docked at S              nothing
 *   at S, due to leave      docked at S              ≤ 10 s after departAt:
 *                                                    CAST OFF (the leg stands);
 *                                                    later: write `dock` that
 *                                                    RESTARTS the stay (now, a
 *                                                    fresh minimum wait), and
 *                                                    cast off at its departure
 *   at S                    not docked               DOCK PASS through the gate
 *                                                    list (not within 10 s of
 *                                                    departAt, not on a skipped
 *                                                    stay, one pass at a time,
 *                                                    backing off 10 s → 60 s)
 *   at S, holding           (this game saw the       renew the hold's seenAt
 *                            berth refuse)           each minute
 *
 * A person at the helm with no robot captain departs by hand (the helm's
 * route DEPART, a later slice): the keeper never casts off or restarts such
 * a stay. A route ended by STOP (or out of fuel) is pinned at its end stop:
 * the keeper docks there once and never casts off; STOP pressed during a
 * hold stops the retrying at once (A4's dockAnswered says so).
 *
 * ─── The dock pass and what the station answers ──────────────────────────────
 *
 * Gates in order (keeperBerths): the stop's own berth first (the route's
 * copy, with a pass this game holds for its room), then — unless the stop
 * pins its gate — the station's other gates in PR 177's arrival order
 * (shipArrival.arrivalBerths: own reserved, open, then taken and granted;
 * never a closed gate or another ship's reserved one). Each gate is docked
 * in KEEPER MODE (docking.ts redockPortAnswer): no local atlas check, only
 * the station's answer counts, never one side alone. Answers (A5 table):
 *
 *   docked (or joined)          done; after a hold the next tick writes `dock`
 *   occupied, overlap           TAKEN: next gate; if the pass ends here, HOLD
 *   not-allowed, closed or      SHUT to this ship: next gate
 *     reserved gate
 *   gone, closed (port gone)    GONE: next gate
 *   not-allowed from a          RIDER: this game's key only (a robot has none,
 *     granted-captains gate       A9.5) — next gate, never a shared verdict
 *   unreachable, no address,    RIDER: this game cannot see the berth
 *     no writer, no far door
 *   busy, no port, no rights,   PORT: the pass stops (another gate would not
 *     in flight, changed,         help); try again later
 *     superseded
 *
 * After a whole pass (passVerdict): any TAKEN gate → hold ("hold only when
 * every allowed gate refuses": a gate this rider could not use may still
 * dock the ferry for another rider, whose dock ends the hold); every gate
 * GONE or SHUT → skip; otherwise (RIDER, PORT, nothing to try) → write
 * nothing, and the ferry rides on unless another rider docks it. Only the
 * berth's own refusal ever holds or skips the ferry for everyone.
 *
 * ─── Rights (A5) ─────────────────────────────────────────────────────────────
 *
 * Riders' games may dock and undock the route's own port, toward the current
 * stop's station, at the timetable's moments, and nothing else
 * (keeperMayOperate, wired into docking.ts as onRouteDockRight and used only
 * by keeper-mode calls). Another port or guest berth still needs someone with
 * rights over it; until then the ferry stays at the stop (DELAYED). 🛟 The
 * timetable holds the stay while such a pairing, made before the departure,
 * is live (pilotRoute.LiveDockAt.held: every rider reads it alike), and a
 * keeper that cannot release it (RouteKeeperDeps.mayRelease) neither casts
 * off nor restarts the stay at the departure (`held`): it waits for someone
 * with rights to let it go, then restarts the stay as for any ferry found
 * docked late.
 *
 * 🛰️ A keeper reads nothing before the room's shared state has arrived
 * (RouteKeeperDeps.ready): an IndexedDB replica can hold a stale route or
 * stale door records, and a keeper acting on them would cast off or restart
 * a ferry the room has already moved on. 🔁 A stay the ferry RESUMEd at keeps
 * its RESUME mark through the keeper's own rewrites of that stay's `dock`
 * (end-hold, restart), or every entry after it would read as too early.
 * 🚚 A tug towing a station is left alone (its tow holds the ship).
 * ⏱️ Robot legs write nothing, so a robot stay docked on time once
 * ROUTE_ANCHOR_EVERY_STAYS stays past the newest timed entry writes a `dock`
 * anchor with its own arrival (anchorStep): the departure it names is the
 * one the timetable has already, and readers walk on from it, not from START.
 *
 * Pure decision functions (keeperStep, keeperAfterPass, passVerdict,
 * keeperBerths, keeperMayOperate …) plus a thin effectful loop
 * (createRouteKeeper, runKeeperPass). Pinned by routeKeeper.test.ts.
 */

import { isDockChain } from './adapter';
import { dockAnswerOf, gateAdmits, type DockAnswer, type DockOpOptions, type DockPortState, type DockRefusal } from './dockRules';
import { readAllDoors, writeDoorTombstone } from './doorsDoc';
import {
  CLOCK_AHEAD_MS,
  GUARD_BAND_MS,
  ROUTE_ANCHOR_EVERY_STAYS,
  dockCheckpoint,
  holdCheckpoint,
  isRouteRunning,
  isTimedCheckpoint,
  renewedHold,
  routeRulesFlight,
  skipCheckpoint,
  type RouteFlight,
} from './pilotRoute';
import {
  arrivalBerths,
  castOffForDeparture,
  planArrivalDock,
  resolveRememberedBerth,
  type ArrivalOutcome,
  type ArrivalPort,
  type ShipDockingApi,
} from './shipArrival';
import {
  readRouteCheckpoints,
  readRouteFlight,
  readShipRoute,
  writeRouteCheckpoint,
  type HoldCheckpoint,
  type RouteCheckpoint,
  type RouteStop,
  type ShipRoute,
} from './shipRoute';
import { wrapAngle } from './orbits';
import { atlasComponent, readAtlas, roomIdFromSeed } from './stationAtlas';
import {
  isKnownStation,
  listStations,
  localStationId,
  type StationBerth,
  type StationDestination,
} from './stationDirectory';
import { stationForRoom } from './stations';

// ── Constants (A5) ───────────────────────────────────────────────────────────

/** The keeper's cadence (main.ts's 1 Hz watch). */
export const KEEPER_TICK_MS = 1_000;
/** A refused dock pass is tried again this long after its answer… */
export const KEEPER_RETRY_MS = 10_000;
/** …doubling each time up to this (each attempt opens a far session of up to
 *  60 s and marks the port busy, which blocks a DEPART). */
export const KEEPER_RETRY_MAX_MS = 60_000;
/** A keeper that still sees the berth refuse renews the hold this often
 *  (pilotRoute.HOLD_UNWATCHED_MS ends a hold nobody renewed for 3 minutes). */
export const HOLD_RENEW_MS = 60_000;
/** Still docked this long after departAt: cast off and the leg stands. Any
 *  later, and the stay restarts instead (nobody was aboard to cast off). */
export const CAST_OFF_LATE_MS = 10_000;
/** The same checkpoint write is not repeated within this long (a write the
 *  readers reject must not become a write every tick). */
export const KEEPER_WRITE_GAP_MS = 5_000;

// ── What the keeper sees ─────────────────────────────────────────────────────

/** The route's own dock port, as the keeper reads it. */
export interface KeeperPort {
  state: DockPortState['kind'] | 'missing';
  /** A dock or undock is running on it. */
  busy: boolean;
  /** Docked: into the current stop's station (its berth room, or another
   *  room of that station: a gate change). */
  atStop: boolean;
  /** Docked: into ANOTHER stop's station of the route — known to be the
   *  wrong stop. (A dock this game cannot place is left alone until the
   *  departure, when every dock is cast off: two riders whose atlases differ
   *  must never undock each other's gate change.) */
  atOtherStop: boolean;
}

/** The ship's live berth docks (every port and guest berth, the timetable's
 *  live-dock rule's input), relative to the flight's stops. */
export interface KeeperDocks {
  /** The newest dock into the current stop's station: its dockedAt (0 when
   *  unstamped), or null when none. In flight: the stop it left. */
  atStop: number | null;
  /** In flight: a dock into the destination's station (made early by a peer
   *  whose clock runs ahead), or null. */
  atNext: number | null;
  /** Docks anywhere else. */
  elsewhere: number;
  /** 🛟 Live pairings on doors other than the route's port that this game
   *  may not release (a guest berth, another port: A5 Rights). Absent: 0. */
  stuck?: number;
}

/** What a keeper remembers between ticks, about one stay of one run. Local
 *  to each game, never synced. */
export interface KeeperMemory {
  run: number;
  legSeq: number;
  /** A dock pass is running. */
  passing: boolean;
  /** No dock pass starts before this. */
  nextPassAt: number;
  /** The back-off after the next refusal. */
  backoffMs: number;
  /** The last finished pass's verdict at this stay, or null. */
  verdict: PassVerdict['kind'] | null;
  /** When the last pass answered. */
  answeredAt: number | null;
  /** The last write of each kind (KEEPER_WRITE_GAP_MS). */
  wroteAt: Partial<Record<KeeperWrite, number>>;
  /** This stay's first cast-off has run (it remembers the berth; later
   *  retries only undock). */
  castOff: boolean;
}

export type KeeperWrite = 'end-hold' | 'restart' | 'renew-hold' | 'hold' | 'skip' | 'anchor';

export function freshKeeperMemory(run: number, legSeq: number): KeeperMemory {
  return {
    run,
    legSeq,
    passing: false,
    nextPassAt: Number.NEGATIVE_INFINITY,
    backoffMs: KEEPER_RETRY_MS,
    verdict: null,
    answeredAt: null,
    wroteAt: {},
    castOff: false,
  };
}

/** The memory for stay `legSeq` of run `run`: the same object while the stay
 *  is the same, a fresh one when the ferry has moved on (or a new run). */
export function keeperMemoryAt(mem: KeeperMemory | null, run: number, legSeq: number): KeeperMemory {
  return mem && mem.run === run && mem.legSeq === legSeq ? mem : freshKeeperMemory(run, legSeq);
}

/** Everything one tick decides from. */
export interface KeeperView {
  now: number;
  route: ShipRoute & { startedAt: number };
  /** The timetable now, with this game's live docks (routeFlightAt). */
  flight: RouteFlight;
  port: KeeperPort;
  docks: KeeperDocks;
  /** The stay's hold that still stands (standingHold), or null. */
  hold: HoldCheckpoint | null;
  /** The stay already carries a `dock` entry (a keeper skips only without). */
  stayDock: boolean;
  /** 🔁 That `dock` is a RESUME (stayResumed): the keeper's own rewrite of
   *  it keeps the mark. Absent: false. */
  stayResume?: boolean;
  /** 🚚 This ship is towing a station (stationMove.isTowing): the keeper
   *  leaves it docked. Absent: false. */
  towing?: boolean;
  /** ⏱️ The stay of the newest timed entry at or before this one
   *  (newestTimedStay); absent when none is known. */
  anchorSeq?: number;
  memory: KeeperMemory;
}

// ── Reading the stay's entries ───────────────────────────────────────────────

/** The hold at stay `legSeq` that still stands: no dock, go, skip or pause
 *  entry at that stay as new as it (A2 "Reading": they end a hold, and win a
 *  tie). Checked on the shape-checked entries: STOP ends the stay's timetable
 *  (holding reads false there), so the keeper reads the hold itself. */
export function standingHold(checkpoints: readonly RouteCheckpoint[], legSeq: number): HoldCheckpoint | null {
  let hold: HoldCheckpoint | null = null;
  for (const e of checkpoints) {
    if (e.legSeq === legSeq && e.kind === 'hold' && (!hold || e.at > hold.at)) hold = e;
  }
  if (!hold) return null;
  for (const e of checkpoints) {
    if (e.legSeq !== legSeq) continue;
    if ((e.kind === 'dock' || e.kind === 'go' || e.kind === 'skip' || e.kind === 'pause') && e.at >= hold.at) return null;
  }
  return hold;
}

/** ⏱️ The stay of the newest timed entry (START, dock, skip, go) at or
 *  before stay `legSeq`, or undefined. */
export function newestTimedStay(checkpoints: readonly RouteCheckpoint[], legSeq: number): number | undefined {
  let best: number | undefined;
  for (const e of checkpoints) {
    if (isTimedCheckpoint(e) && e.legSeq <= legSeq && (best === undefined || e.legSeq > best)) best = e.legSeq;
  }
  return best;
}

/** Does stay `legSeq` carry a `dock` entry? */
export function stayHasDock(checkpoints: readonly RouteCheckpoint[], legSeq: number): boolean {
  return checkpoints.some((e) => e.legSeq === legSeq && e.kind === 'dock');
}

/** 🔁 Is stay `legSeq`'s `dock` entry a RESUME (the key holds one dock per
 *  stay, so a keeper's rewrite of it must keep the mark)? */
export function stayResumed(checkpoints: readonly RouteCheckpoint[], legSeq: number): boolean {
  return checkpoints.some((e) => e.legSeq === legSeq && e.kind === 'dock' && e.resume === true);
}

/** A person at the helm flies this stay's leg, and no robot captain will take
 *  over: only their route DEPART leaves (the keeper never casts off). */
export function personDeparts(f: RouteFlight): boolean {
  return f.status === 'docked' && f.pilot === 'person' && f.takeoverAt === null;
}

/** Has the stay's departure come (the keeper casts off from here)? */
function dueToLeave(f: RouteFlight, now: number): boolean {
  return f.status === 'docked' && f.ended === null && !f.holding && f.departsAt !== null
    && !personDeparts(f) && now >= f.departsAt;
}

/** Inside the guard band before the departure: no dock attempt starts. */
function inGuardBand(f: RouteFlight, now: number): boolean {
  return f.ended === null && !f.holding && f.departsAt !== null && !personDeparts(f)
    && now >= f.departsAt - GUARD_BAND_MS;
}

// ── Rights (A5): the rider carve-out ─────────────────────────────────────────

/**
 * May a rider's keeper dock (or undock) `doorId` now, although the rider has
 * no construction rights there? Only the route's own port; only toward the
 * current stop's station (`farAtStop`: the far room is that stop's berth
 * room or another room of its station); only at the timetable's moments:
 *   dock    the ferry is at that stop (holding, or not yet in the guard band
 *           before its departure), and the stay is not skipped;
 *   undock  the ferry is in flight, docked at another stop, or due to leave.
 * Pure.
 */
export function keeperMayOperate(o: {
  route: ShipRoute | null;
  flight: RouteFlight | null;
  now: number;
  doorId: string;
  op: 'dock' | 'undock';
  farAtStop: boolean;
}): boolean {
  const { route, flight: f, now } = o;
  if (!isRouteRunning(route) || !routeRulesFlight(f) || o.doorId !== route.shipPort) return false;
  if (o.op === 'dock') {
    return f.status === 'docked' && o.farAtStop && !f.skipped && !inGuardBand(f, now);
  }
  return f.status !== 'docked' || !o.farAtStop || dueToLeave(f, now);
}

// ── One tick (A5) ────────────────────────────────────────────────────────────

export type KeeperIdle =
  | 'paused'
  | 'in-flight'
  | 'arriving'
  | 'docked'
  | 'ended'
  | 'person-departs'
  | 'stopped-in-hold'
  | 'skipped'
  | 'passing'
  | 'answered'
  | 'guard-band'
  | 'backoff'
  | 'port-busy'
  | 'unplannable'
  | 'wrote-recently'
  /** 🛟 A pairing this game may not release holds the ferry here. */
  | 'held'
  /** 🚚 The ship is towing a station. */
  | 'towing';

export type KeeperStep =
  | { kind: 'idle'; why: KeeperIdle }
  /** Cast off: every dock the ferry has (`departure`, `in-flight`), or only
   *  the route's port, docked at the wrong stop (`wrong-stop`). */
  | { kind: 'cast-off'; why: 'departure' | 'in-flight' | 'wrong-stop' }
  | { kind: 'write'; why: 'end-hold' | 'restart' | 'renew-hold' | 'anchor'; entry: RouteCheckpoint }
  /** Start a dock pass through the gate list. */
  | { kind: 'dock' };

const idle = (why: KeeperIdle): KeeperStep => ({ kind: 'idle', why });

/** A write of `why` is allowed now (not repeated within KEEPER_WRITE_GAP_MS). */
function mayWrite(mem: KeeperMemory, why: KeeperWrite, now: number): boolean {
  const last = mem.wroteAt[why];
  return last === undefined || now - last >= KEEPER_WRITE_GAP_MS || now < last;
}

/**
 * ⏱️ The anchor a robot stay docked on time writes once it is
 * ROUTE_ANCHOR_EVERY_STAYS stays past the newest timed entry: a `dock` entry
 * with the stay's own arrival, so its departure is the one the timetable
 * already has. Readers then walk from it, never from START. Null when not due.
 */
function anchorStep(v: KeeperView): KeeperStep | null {
  const { flight: f, now, route, memory: mem } = v;
  if (v.anchorSeq === undefined || f.legSeq - v.anchorSeq < ROUTE_ANCHOR_EVERY_STAYS) return null;
  if (v.stayDock || f.pilot !== 'robot' || f.takeoverAt !== null || f.stopping || f.skipped) return null;
  if (f.stayStart === null || f.departsAt === null || inGuardBand(f, now)) return null;
  if (!mayWrite(mem, 'anchor', now)) return null;
  const entry = dockCheckpoint(route, f.legSeq, { at: now, stayStart: f.stayStart, pilot: 'robot' });
  // Only one that changes nothing.
  if (!entry || entry.departAt !== f.departsAt) return null;
  return { kind: 'write', why: 'anchor', entry };
}

/**
 * What the keeper does this tick (see the header's table). Pure: the view is
 * read by the caller, and the step is carried out by it.
 */
export function keeperStep(v: KeeperView): KeeperStep {
  const { flight: f, now, route, port, docks, memory: mem } = v;
  if (f.paused) return idle('paused');
  if (v.towing === true) return idle('towing');

  // In flight: nothing may stay docked.
  if (f.status !== 'docked') {
    if (docks.atStop !== null || docks.elsewhere > 0) {
      return port.busy ? idle('port-busy') : { kind: 'cast-off', why: 'in-flight' };
    }
    if (docks.atNext !== null) {
      // A peer whose clock runs ahead docked at the destination already.
      if (f.arrivesAt !== null && now >= f.arrivesAt - CLOCK_AHEAD_MS) return idle('arriving');
      return port.busy ? idle('port-busy') : { kind: 'cast-off', why: 'in-flight' };
    }
    return idle('in-flight');
  }

  // At a stop, with the route's port docked at another stop: undock it first.
  if (port.state === 'docked' && !port.atStop && port.atOtherStop) {
    return port.busy ? idle('port-busy') : { kind: 'cast-off', why: 'wrong-stop' };
  }

  // Docked at this stop.
  if (docks.atStop !== null) {
    if (f.holding) {
      // The hold ends on the dock: the stay starts at the dock's own stamp
      // (every rider who sees it computes the same departure), kept between
      // the stay's arrival and now so the readers accept it.
      if (!mayWrite(mem, 'end-hold', now)) return idle('wrote-recently');
      const floor = f.stayStart ?? 0;
      let stayStart = Math.min(now, Math.max(docks.atStop, floor));
      if (!(stayStart > 0)) stayStart = now;
      // 🔁 At a RESUMEd stay the dock stays a RESUME (its stay starts at its
      // own `at`), stamped no earlier than the hold it ends.
      const entry = v.stayResume === true
        ? dockCheckpoint(route, f.legSeq, {
          at: Math.min(now, Math.max(stayStart, f.holdSince ?? 0, v.hold?.at ?? 0)), pilot: f.pilot, resume: true,
        })
        : dockCheckpoint(route, f.legSeq, { at: now, stayStart, pilot: f.pilot });
      return entry ? { kind: 'write', why: 'end-hold', entry } : idle('unplannable');
    }
    if (f.ended !== null) return idle('ended');
    if (personDeparts(f)) return idle('person-departs');
    if (!dueToLeave(f, now)) return anchorStep(v) ?? idle('docked');
    // 🛟 Another pairing this game may not release holds the ferry: no
    // cast-off (it would leave half-docked) and no restart (it would restart
    // every window) until someone with rights lets it go.
    if ((docks.stuck ?? 0) > 0) return idle('held');
    if (now - f.departsAt! <= CAST_OFF_LATE_MS) {
      return port.busy ? idle('port-busy') : { kind: 'cast-off', why: 'departure' };
    }
    // Found docked late (nobody aboard at the departure, or the port busy):
    // restart the stay from now, and cast off at its new departure.
    if (!mayWrite(mem, 'restart', now)) return idle('wrote-recently');
    const entry = dockCheckpoint(route, f.legSeq, {
      at: now, stayStart: now, pilot: f.pilot, ...(v.stayResume === true ? { resume: true } : {}),
    });
    return entry ? { kind: 'write', why: 'restart', entry } : idle('unplannable');
  }

  // At this stop, not docked.
  if (f.ended !== null && v.hold) return idle('stopped-in-hold');
  if (f.holding && v.hold && v.hold.since === f.holdSince && mem.verdict === 'hold'
    && now - v.hold.seenAt >= HOLD_RENEW_MS && mayWrite(mem, 'renew-hold', now)) {
    return { kind: 'write', why: 'renew-hold', entry: renewedHold(v.hold, now) };
  }
  if (f.skipped) return idle('skipped');
  if (mem.passing) return idle('passing');
  if (f.ended !== null && mem.verdict !== null) return idle('answered');
  if (inGuardBand(f, now)) return idle('guard-band');
  if (now < mem.nextPassAt) return idle('backoff');
  if (port.busy) return idle('port-busy');
  return { kind: 'dock' };
}

// ── The gate list (A9.4, A9.6) ───────────────────────────────────────────────

function roomOf(seed: string): string {
  try {
    return roomIdFromSeed(seed);
  } catch {
    return '';
  }
}

function sameBerth(a: StationBerth, b: StationBerth): boolean {
  const ra = roomOf(a.address);
  return ra !== '' && ra === roomOf(b.address) && (a.farDoor ?? '') === (b.farDoor ?? '');
}

/** The stop's copied berth as a StationBerth, with the pass `address` this
 *  game holds for its room. */
export function ownStopBerth(stop: RouteStop, address: string): StationBerth {
  const b = stop.berth;
  return {
    address,
    farDoor: b.farDoor,
    ...(b.farWall !== undefined ? { farWall: b.farWall } : {}),
    ...(b.farLateral !== undefined ? { farLateral: b.farLateral } : {}),
    ...(b.gate !== undefined ? { gate: b.gate } : {}),
  };
}

/**
 * The berths a keeper tries at a stop, in order: the stop's own berth first
 * (the route's copy; `own` is null when this game holds no pass for its
 * room), then — unless the stop pins its gate — the station's other gates in
 * PR 177's arrival order (shipArrival.arrivalBerths, as built: never a closed
 * gate or another ship's reserved one). The own berth takes what the station
 * list says about the same door (access, taken); when that list says the
 * gate does not admit this ship (dockRules.gateAdmits: closed, or reserved
 * for another), the own berth is still asked — the list is gossip, the
 * station's answer is the truth — but after every other gate. Pure.
 */
export function keeperBerths(o: {
  stop: RouteStop;
  own: StationBerth | null;
  station: Pick<StationDestination, 'berth' | 'berths'> | null;
  shipRoomId: string;
}): StationBerth[] {
  const listed = o.station
    ? arrivalBerths({ station: o.station, remembered: null, gate: o.stop.berth.gate, shipRoomId: o.shipRoomId })
    : [];
  let own: StationBerth | null = null;
  if (o.own && roomOf(o.own.address) === o.stop.berth.roomId) {
    const known = [...(o.station?.berths ?? []), ...listed].find((b) => sameBerth(b, o.own!));
    own = known ? { ...known, ...o.own, ...(known.gate !== undefined && o.own.gate === undefined ? { gate: known.gate } : {}) } : o.own;
  }
  if (!o.stop.berth.anyGate) return own ? [own] : [];
  // A granted-captains gate is this rider's to find out (its key): kept first.
  const shut = !!own?.access && own.access !== 'pass'
    && !gateAdmits({ access: own.access, ...(own.reservedFor ? { reservedFor: own.reservedFor } : {}) }, o.shipRoomId);
  const out: StationBerth[] = own && !shut ? [own] : [];
  for (const b of listed) if (!out.some((x) => sameBerth(x, b)) && !(own && sameBerth(own, b))) out.push(b);
  if (own && shut) out.push(own);
  return out;
}

// ── Reading the station's answers (A5, A9.5) ────────────────────────────────

/**
 * One gate's refusal, as the keeper counts it:
 *   taken  the berth is in use (or the module would overlap there)
 *   shut   the gate is closed, or reserved for another ship
 *   gone   the berth's door, or its port, was removed (and no port can be
 *          fitted there again while every gate number is taken), or its
 *          station is moving between planets (or has moved: runKeeperPass)
 *   rider  a verdict on this game alone: its key (a granted-captains gate),
 *          its pass, or its reach
 *   port   the ship's port itself cannot dock now: the pass stops
 */
export type KeeperRefusalClass = 'taken' | 'shut' | 'gone' | 'rider' | 'port';

export function classifyKeeperRefusal(
  answer: { reason: DockRefusal; gateAccess?: 'pass' | 'reserved' | 'closed' },
  berthAccess?: StationBerth['access'],
): KeeperRefusalClass {
  switch (answer.reason) {
    case 'occupied':
    case 'overlap':
      return 'taken';
    case 'gone':
    case 'closed':
    case 'no-gate':
    // The stop's station left for another planet: out of reach for hours.
    case 'moving':
      return 'gone';
    case 'not-allowed': {
      // A granted-captains gate checks the docking game's key (A9.5): a
      // verdict on this rider, not on the ship. Unknown counts the same.
      const access = answer.gateAccess ?? berthAccess;
      return access === 'closed' || access === 'reserved' ? 'shut' : 'rider';
    }
    case 'unreachable':
    case 'no-address':
    case 'no-far-door':
    case 'no-writer':
    case 'refused':
      return 'rider';
    default:
      return 'port';
  }
}

/** One gate the pass asked, and what came of it. */
export type KeeperGateResult =
  | { kind: 'docked'; berth: StationBerth; dockedAt?: number }
  | { kind: 'refused'; berth: StationBerth; reason: DockRefusal | 'no-port'; cls: KeeperRefusalClass };

/** What a whole pass decided. */
export type PassVerdict =
  | { kind: 'docked'; gate?: number; gateChange: boolean; dockedAt?: number }
  /** A berth refusal every rider shares: the ferry holds. */
  | { kind: 'hold' }
  /** Every berth gone or shut to this ship: the ferry skips the stop. */
  | { kind: 'skip' }
  /** This game could not dock the ferry: write nothing. */
  | { kind: 'none'; reason: 'no-berth' | 'no-port' | 'unreachable' | 'not-allowed' | 'stale' };

/**
 * The verdict of one pass over the gate list (A5, A9.5). `own` is the stop's
 * own berth (a dock anywhere else is a gate change). Hold only when the pass
 * ran through every gate and one was taken; skip when every gate was gone or
 * shut; otherwise nothing shared. Pure.
 */
export function passVerdict(results: readonly KeeperGateResult[], own: StationBerth | null): PassVerdict {
  const docked = results.find((r) => r.kind === 'docked');
  if (docked) {
    const gateChange = !own || !sameBerth(docked.berth, own);
    return {
      kind: 'docked',
      ...(docked.berth.gate !== undefined ? { gate: docked.berth.gate } : {}),
      gateChange,
      ...(docked.kind === 'docked' && docked.dockedAt !== undefined ? { dockedAt: docked.dockedAt } : {}),
    };
  }
  const refused = results.filter((r): r is Extract<KeeperGateResult, { kind: 'refused' }> => r.kind === 'refused');
  if (refused.length === 0) return { kind: 'none', reason: 'no-berth' };
  if (refused.some((r) => r.cls === 'port')) return { kind: 'none', reason: 'no-port' };
  if (refused.some((r) => r.cls === 'taken')) return { kind: 'hold' };
  if (refused.every((r) => r.cls === 'gone' || r.cls === 'shut')) return { kind: 'skip' };
  const keyOnly = refused.some((r) => r.cls === 'rider' && r.reason === 'not-allowed');
  return { kind: 'none', reason: keyOnly ? 'not-allowed' : 'unreachable' };
}

/** 🚀 Why a pass that decided `skip` skips (the robot captain's line, design
 *  §4): `gone` when every gate asked was gone (its door or port removed),
 *  else `shut` (closed, or reserved for another ship). Pure. */
export function skipWhyOf(results: readonly KeeperGateResult[]): 'gone' | 'shut' {
  const refused = results.filter((r) => r.kind === 'refused');
  return refused.length > 0 && refused.every((r) => r.kind === 'refused' && r.cls === 'gone') ? 'gone' : 'shut';
}

/** What a finished pass changes: the keeper's memory, and a checkpoint to
 *  write (hold, renewal, skip), or null. */
export interface AfterPass {
  memory: KeeperMemory;
  write: { why: KeeperWrite; entry: RouteCheckpoint } | null;
}

/**
 * Take a pass's verdict at stay `legSeq` (A5 "What the answer means"),
 * against a FRESH view read when it answered. A verdict about a stay the
 * ferry has left, or one that came back inside the guard band, writes
 * nothing (the ferry rode on meanwhile). Docked: nothing to write (the next
 * tick ends a hold on the live dock). Hold: re-read the port — not docked,
 * so write `hold`, or renew one older than a minute. Skip: only when the
 * stay has no `dock` entry and nothing is docked. Refused: back off. Pure.
 */
export function keeperAfterPass(v: KeeperView, pass: { legSeq: number; verdict: PassVerdict; skipWhy?: 'gone' | 'shut' }): AfterPass {
  const { now, flight: f, route } = v;
  const same = v.memory.run === route.startedAt && v.memory.legSeq === pass.legSeq;
  const base = same ? v.memory : keeperMemoryAt(v.memory, route.startedAt, pass.legSeq);
  const memory: KeeperMemory = { ...base, wroteAt: { ...base.wroteAt }, passing: false, answeredAt: now, verdict: pass.verdict.kind };
  if (pass.verdict.kind === 'docked') {
    memory.nextPassAt = now;
    memory.backoffMs = KEEPER_RETRY_MS;
  } else {
    memory.nextPassAt = now + base.backoffMs;
    memory.backoffMs = Math.min(base.backoffMs * 2, KEEPER_RETRY_MAX_MS);
  }
  if (!same) return { memory: v.memory, write: null };
  const stillHere = f.status === 'docked' && !f.paused && f.legSeq === pass.legSeq && f.ended === null
    && !f.skipped && v.docks.atStop === null && !inGuardBand(f, now);
  if (!stillHere) return { memory, write: null };
  if (pass.verdict.kind === 'hold') {
    if (!v.hold) {
      memory.wroteAt.hold = now;
      return { memory, write: { why: 'hold', entry: holdCheckpoint(route, pass.legSeq, { at: now }) } };
    }
    if (now - v.hold.seenAt >= HOLD_RENEW_MS) {
      memory.wroteAt['renew-hold'] = now;
      return { memory, write: { why: 'renew-hold', entry: renewedHold(v.hold, now) } };
    }
    return { memory, write: null };
  }
  if (pass.verdict.kind === 'skip' && !v.stayDock) {
    const entry = skipCheckpoint(route, pass.legSeq, {
      at: now, pilot: f.pilot, ...(pass.skipWhy !== undefined ? { why: pass.skipWhy } : {}),
    });
    if (entry) {
      memory.wroteAt.skip = now;
      return { memory, write: { why: 'skip', entry } };
    }
  }
  return { memory, write: null };
}

/** The helm's line for a pass (noteShipArrival), or null for none. 🧾 It
 *  names the stay it is about (`routeStay`: the helm shows it only while it
 *  still holds, helmRoute.routeNoteStands), and a skip says why (`gone` or
 *  `shut`, skipWhyOf). */
export function keeperNote(
  route: ShipRoute & { startedAt: number },
  f: RouteFlight,
  verdict: PassVerdict,
  skipWhy?: 'gone' | 'shut',
): ArrivalOutcome | null {
  const stop = route.stops[f.stopIndex];
  const next = route.stops[f.nextStopIndex];
  if (!stop) return null;
  const nextStopName = next?.name ?? stop.name;
  const routeStay = { run: route.startedAt, legSeq: f.legSeq };
  switch (verdict.kind) {
    case 'docked':
      return {
        kind: 'docked',
        stationName: stop.name,
        ...(verdict.gate !== undefined ? { gate: verdict.gate } : {}),
        ...(verdict.gateChange && verdict.gate !== undefined ? { gateChange: true } : {}),
        routeStay,
      };
    case 'hold':
      return { kind: 'none', stationName: stop.name, reason: 'occupied', route: { action: 'hold', nextStopName }, routeStay };
    case 'skip':
      return {
        kind: 'none',
        stationName: stop.name,
        reason: skipWhy === 'shut' ? 'occupied' : 'berth-gone',
        route: { action: 'skip', nextStopName, ...(skipWhy !== undefined ? { why: skipWhy } : {}) },
        routeStay,
      };
    case 'none':
      if (verdict.reason === 'stale') return null;
      return {
        kind: 'none',
        stationName: stop.name,
        reason: verdict.reason === 'no-berth' ? 'no-berth'
          : verdict.reason === 'no-port' ? 'no-port'
            : verdict.reason === 'not-allowed' ? 'occupied'
              : 'unreachable',
        route: { action: 'ride-on', nextStopName },
        routeStay,
      };
  }
}

// ── The dock pass (effectful) ────────────────────────────────────────────────

/** What a dock pass needs from the game. */
export interface KeeperPassDeps {
  /** The docking system, IN KEEPER MODE (createRouteKeeper wraps it). */
  docking: ShipDockingApi;
  route: ShipRoute;
  stop: RouteStop;
  /** The stop's station in this game's directory (🚚 `planetId`: the planet
   *  it orbits now), or null when it is not listed. */
  station: Pick<StationDestination, 'berth' | 'berths' | 'orbit'> & { planetId?: string } | null;
  shipRoomId: string;
  /** May this game dock the route's port toward `farRoomId` now (its own
   *  rights, or the carve-out)? */
  mayDock: (farRoomId: string) => boolean;
  /** Is the pass still wanted (same stay, not in the guard band)? Asked
   *  before each gate: a pass can take a minute per gate. */
  stillWanted: () => boolean;
  now: () => number;
}

/** The route's port, as planArrivalDock reads it (the only port a keeper
 *  docks with), operable when this game may dock it toward `farRoomId`. */
function routePortFor(deps: KeeperPassDeps, farRoomId: string): ArrivalPort[] {
  const p = deps.docking.ports().find((x) => x.doorId === deps.route.shipPort);
  if (!p) return [];
  return [{ ...p, canOperate: p.canOperate !== false || deps.mayDock(farRoomId) }];
}

/**
 * One pass through the stop's gate list (keeperBerths), one gate at a time:
 * re-plan against the port as it is now (planArrivalDock: a `closed` or
 * `gone` refusal drops the port's berth memory), re-point the port, DOCK in
 * keeper mode, and read the answer. Stops at the first dock, or when the port
 * itself cannot dock. Never throws.
 */
export async function runKeeperPass(deps: KeeperPassDeps): Promise<{ verdict: PassVerdict; results: KeeperGateResult[]; own: StationBerth | null }> {
  const results: KeeperGateResult[] = [];
  const b0 = deps.stop.berth;
  const remembered = resolveRememberedBerth(
    {
      doorId: deps.route.shipPort,
      roomId: b0.roomId,
      farDoor: b0.farDoor,
      ...(b0.farWall !== undefined ? { farWall: b0.farWall } : {}),
      ...(b0.farLateral !== undefined ? { farLateral: b0.farLateral } : {}),
    },
    deps.docking.ports(),
  );
  const own = remembered ? ownStopBerth(deps.stop, remembered.address) : null;
  const berths = keeperBerths({ stop: deps.stop, own, station: deps.station, shipRoomId: deps.shipRoomId });
  // 🚚 The stop's station has moved to another planet since the route copied
  // where it orbits (PR 174; a move under way answers DOCK 'moving' itself):
  // the timetable brings the ferry to where it was, so no gate is in reach.
  // Every gate counts as that refusal, unasked, and the stop is skipped.
  const planetId = deps.station?.planetId;
  // 🎚️ Likewise a stop that has changed altitude since: the route flew to
  // the orbit it copied (RouteStop.orbit; none is the slot's own).
  // Radius and phase both: back at an altitude flown before, it is not
  // where it was then.
  const live = deps.station?.orbit;
  const copied = deps.stop.orbit;
  const climbed = planetId !== undefined && (!live !== !copied || (!!live && !!copied
    && (Math.abs(live.radiusKm - copied.radiusKm) > 1e-6 || Math.abs(wrapAngle(live.phase0 - copied.phase0)) > 1e-9)));
  if (planetId !== undefined && (planetId !== deps.stop.planetId || climbed)) {
    const gone = (berth: StationBerth): KeeperGateResult => ({ kind: 'refused', berth, reason: 'moving', cls: 'gone' });
    const results = (berths.length > 0 ? berths : [ownStopBerth(deps.stop, remembered?.address ?? '')]).map(gone);
    return { verdict: passVerdict(results, own), results, own };
  }
  for (const berth of berths) {
    if (!deps.stillWanted()) return { verdict: { kind: 'none', reason: 'stale' }, results, own };
    const plan = planArrivalDock({
      station: {},
      remembered: null,
      ports: routePortFor(deps, roomOf(berth.address)),
      berth,
      now: deps.now(),
    });
    if (plan.kind === 'none') {
      if (plan.reason === 'already-docked') {
        results.push({ kind: 'docked', berth });
        break;
      }
      if (plan.reason === 'no-berth') continue;
      results.push({ kind: 'refused', berth, reason: 'no-port', cls: 'port' });
      break;
    }
    let answer: DockAnswer = { ok: false, reason: 'refused' };
    try {
      if (plan.retarget) writeDoorTombstone(plan.doorId, plan.address, plan.retarget);
      answer = dockAnswerOf(await deps.docking.dock(plan.doorId, { keeper: true }));
    } catch (err) {
      console.warn('[route] keeper DOCK threw:', err);
    }
    if (answer.ok) {
      results.push({ kind: 'docked', berth, ...(answer.dockedAt !== undefined ? { dockedAt: answer.dockedAt } : {}) });
      break;
    }
    const cls = classifyKeeperRefusal(answer, berth.access);
    results.push({ kind: 'refused', berth, reason: answer.reason, cls });
    if (cls === 'port') break;
  }
  return { verdict: passVerdict(results, own), results, own };
}

// ── The loop (effectful, thin) ───────────────────────────────────────────────

/** What the keeper reads from the game (main.ts wires it). */
export interface RouteKeeperDeps {
  /** The room's docking system (docking.ts: ports, UNDOCK, DOCK passing
   *  their options through), or null before it is built. */
  docking: () => ShipDockingApi | null;
  /** The ship's room id (a gate reserved for it). */
  shipRoomId: () => string;
  /** Is `roomId` part of the stop's station? Default: the stop's berth room,
   *  or a room the atlas joins to it. */
  sameStation?: (stop: RouteStop, roomId: string) => boolean;
  /** The stop's station in this game's directory (its gates, and 🚚 the
   *  planet it orbits now), or null. Default: the directory entry for the
   *  stop's id, else for its berth room's station. */
  station?: (stop: RouteStop) => KeeperPassDeps['station'];
  /** Release the ship's other guest berths (not dock ports) this player may
   *  release — the transient-berth detach PR 172's DEPART does. */
  detachGuestBerths?: () => void;
  /** Tell the helm (devices.noteShipArrival). */
  note?: (outcome: ArrivalOutcome) => void;
  /** 🛰️ Has the room's shared state arrived (main.ts initialRoomStateReady)?
   *  Until it has, the keeper reads and does nothing. Default: yes. */
  ready?: () => boolean;
  /** 🛟 May this game release the live pairing on `doorId` (undock that
   *  port, or delete that guest berth)? Asked for every door but the
   *  route's port. Default: yes. */
  mayRelease?: (doorId: string) => boolean;
  /** 🚚 Is this ship towing a station (stationMove.isTowing)? Default: no. */
  towing?: () => boolean;
  clock?: () => number;
}

export interface RouteKeeper {
  /** One tick (1 Hz). */
  tick(): void;
  /** A4's `dockAnswered` for shipRoute.settleRouteFlight: has the dock at
   *  the flight's stop answered (docked, refused, or STOP during a hold)? */
  dockAnswered(f: RouteFlight): boolean;
  /** The rider carve-out (docking.ts onRouteDockRight). */
  mayOperate(doorId: string, op: 'dock' | 'undock', farRoomId: string): boolean;
  /** Forget everything (a room change). A pass still running is ignored. */
  reset(): void;
}

/**
 * "Is this room part of the stop's station?", as the keeper and the
 * timetable's live-dock reader (main.ts) both ask it: the stop's berth room,
 * a room the atlas joins to it (station structure; berth doors excluded), or
 * a room one of the station's gates is in (the directory's berth list — a
 * gate change into a room this game's atlas has not joined up yet). Each
 * stop's set is worked out once per predicate: make one per read.
 */
export function sameStationReader(
  stationOf: (stop: RouteStop) => Pick<StationDestination, 'berth' | 'berths'> | null = directoryStationFor,
): (stop: RouteStop, roomId: string) => boolean {
  const rooms = new Map<string, Set<string>>();
  let atlas: ReturnType<typeof readAtlas> | null = null;
  return (stop, roomId) => {
    if (!roomId) return false;
    if (roomId === stop.berth.roomId) return true;
    const key = `${stop.stationId}|${stop.berth.roomId}`;
    let set = rooms.get(key);
    if (!set) {
      atlas ??= readAtlas();
      set = new Set(atlasComponent(atlas, stop.berth.roomId));
      let st: Pick<StationDestination, 'berth' | 'berths'> | null = null;
      try {
        st = stationOf(stop);
      } catch {
        st = null;
      }
      for (const b of [st?.berth, ...(st?.berths ?? [])]) {
        const r = b ? roomOf(b.address) : '';
        if (r) set.add(r);
      }
      rooms.set(key, set);
    }
    return set.has(roomId);
  };
}

/** The stop's station in this game's directory: by the stop's own id (read
 *  as this install's), else by the station its berth room belongs to. */
export function directoryStationFor(stop: RouteStop): StationDestination | null {
  const list = listStations();
  const id = localStationId(stop.stationId);
  if (isKnownStation(id)) return list.find((s) => s.id === id) ?? null;
  const rec = stationForRoom(stop.berth.roomId);
  return rec ? list.find((s) => s.id === rec.id) ?? null : null;
}

/** The ship's live berth docks: each paired door that is a dock or a guest
 *  berth (the timetable's live-dock input), by far room and stamp. */
function liveBerthDocks(): Array<{ doorId: string; roomId: string; dockedAt: number }> {
  const out: Array<{ doorId: string; roomId: string; dockedAt: number }> = [];
  for (const [doorId, rec] of readAllDoors()) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    if (rec.transient !== true && !isDockChain(rec.segments)) continue;
    const roomId = roomOf(rec.connectedRoomAddress);
    if (!roomId) continue;
    const at = rec.dockedAt;
    out.push({ doorId, roomId, dockedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
  }
  return out;
}

/** The docking system with every DOCK and UNDOCK in keeper mode. */
function keeperMode(d: ShipDockingApi): ShipDockingApi {
  const opts: DockOpOptions = { keeper: true };
  return {
    ports: () => d.ports(),
    undock: (doorId) => d.undock(doorId, opts),
    dock: (doorId) => d.dock(doorId, opts),
  };
}

export function createRouteKeeper(deps: RouteKeeperDeps): RouteKeeper {
  const clock = deps.clock ?? Date.now;
  const stationOf = deps.station ?? directoryStationFor;
  /** A fresh station-rooms cache per read (the atlas and directory change). */
  const samePredicate = (): ((stop: RouteStop, roomId: string) => boolean) =>
    deps.sameStation ?? sameStationReader(stationOf);
  let memory: KeeperMemory | null = null;
  /** Bumped by reset: a pass from before it is ignored when it answers. */
  let generation = 0;
  const ready = (): boolean => {
    try {
      return deps.ready ? deps.ready() : true;
    } catch {
      return false;
    }
  };
  const mayRelease = (doorId: string): boolean => {
    try {
      return deps.mayRelease ? deps.mayRelease(doorId) : true;
    } catch {
      return false;
    }
  };
  const towingNow = (): boolean => {
    try {
      return deps.towing?.() === true;
    } catch {
      return false;
    }
  };

  const flightNow = (now: number): { route: ShipRoute & { startedAt: number }; f: RouteFlight } | null => {
    const route = readShipRoute();
    if (!isRouteRunning(route)) return null;
    const f = readRouteFlight(now);
    return routeRulesFlight(f) ? { route, f } : null;
  };

  /** Read everything keeperStep needs, now. */
  const viewNow = (now: number, docking: ShipDockingApi): KeeperView | null => {
    const r = flightNow(now);
    if (!r) return null;
    const sameStation = samePredicate();
    const { route, f } = r;
    const stop = route.stops[f.stopIndex];
    const next = route.stops[f.nextStopIndex];
    const p = docking.ports().find((x) => x.doorId === route.shipPort);
    const portRoom = p && p.state.kind === 'docked' ? p.state.roomId : '';
    const atStop = !!portRoom && !!stop && sameStation(stop, portRoom);
    const port: KeeperPort = p
      ? {
          state: p.state.kind,
          busy: p.busy === true,
          atStop,
          atOtherStop: !!portRoom && !atStop
            && route.stops.some((s, i) => i !== f.stopIndex && sameStation(s, portRoom)),
        }
      : { state: 'missing', busy: false, atStop: false, atOtherStop: false };
    const docks: KeeperDocks = { atStop: null, atNext: null, elsewhere: 0, stuck: 0 };
    for (const d of liveBerthDocks()) {
      if (stop && sameStation(stop, d.roomId)) docks.atStop = Math.max(docks.atStop ?? 0, d.dockedAt);
      else if (f.status !== 'docked' && next && sameStation(next, d.roomId)) docks.atNext = Math.max(docks.atNext ?? 0, d.dockedAt);
      else docks.elsewhere++;
      if (d.doorId !== route.shipPort && !mayRelease(d.doorId)) docks.stuck = (docks.stuck ?? 0) + 1;
    }
    const ckpts = readRouteCheckpoints();
    memory = keeperMemoryAt(memory, route.startedAt, f.legSeq);
    return {
      now,
      route,
      flight: f,
      port,
      docks,
      hold: standingHold(ckpts, f.legSeq),
      stayDock: stayHasDock(ckpts, f.legSeq),
      stayResume: stayResumed(ckpts, f.legSeq),
      towing: towingNow(),
      anchorSeq: newestTimedStay(ckpts, f.legSeq),
      memory,
    };
  };

  const castOff = (v: KeeperView, docking: ShipDockingApi, why: 'departure' | 'in-flight' | 'wrong-stop'): void => {
    const k = keeperMode(docking);
    if (why === 'wrong-stop') {
      void k.undock(v.route.shipPort);
      return;
    }
    const mem = v.memory;
    if (why === 'departure' && !mem.castOff) {
      // The first cast-off of the stay remembers the berth, as DEPART does.
      mem.castOff = true;
      castOffForDeparture(localStationId(v.route.stops[v.flight.stopIndex].stationId), k);
    } else {
      // In flight (the stop left behind, or a dock the destination took
      // early) there is no berth here to remember: the flight's stopIndex is
      // the stop it LEFT, and remembering that station's berth from a dock
      // elsewhere would be wrong. Only undock, and only what this game may.
      for (const p of k.ports()) {
        if (p.state.kind === 'docked' && (p.doorId === v.route.shipPort || mayRelease(p.doorId))) void k.undock(p.doorId);
      }
    }
    deps.detachGuestBerths?.();
  };

  const write = (v: KeeperView, why: KeeperWrite, entry: RouteCheckpoint): boolean => {
    v.memory.wroteAt[why] = v.now;
    return writeRouteCheckpoint(v.route.startedAt, entry, v.now);
  };

  const startPass = (v: KeeperView, docking: ShipDockingApi): void => {
    const gen = generation;
    const mem = v.memory;
    mem.passing = true;
    const legSeq = v.flight.legSeq;
    const run = v.route.startedAt;
    const stop = v.route.stops[v.flight.stopIndex];
    const k = keeperMode(docking);
    const lastVerdict = mem.verdict;
    const sameStation = samePredicate();
    let station: KeeperPassDeps['station'] = null;
    try {
      station = stationOf(stop);
    } catch (err) {
      console.warn('[route] keeper station read failed:', err);
    }
    const stillWanted = (): boolean => {
      if (gen !== generation) return false;
      const r = flightNow(clock());
      return !!r && r.route.startedAt === run && r.f.status === 'docked' && r.f.legSeq === legSeq
        && !r.f.skipped && !inGuardBand(r.f, clock());
    };
    void runKeeperPass({
      docking: k,
      route: v.route,
      stop,
      station,
      shipRoomId: deps.shipRoomId(),
      mayDock: (farRoomId) => keeperMayOperate({
        route: readShipRoute(),
        flight: flightNow(clock())?.f ?? null,
        now: clock(),
        doorId: v.route.shipPort,
        op: 'dock',
        farAtStop: sameStation(stop, farRoomId),
      }),
      stillWanted,
      now: clock,
    }).then(({ verdict, results }) => {
      if (gen !== generation) return;
      const d = deps.docking();
      const fresh = d ? viewNow(clock(), d) : null;
      if (!fresh) {
        if (memory && memory.run === run && memory.legSeq === legSeq) memory.passing = false;
        return;
      }
      const after = keeperAfterPass(fresh, {
        legSeq, verdict, ...(verdict.kind === 'skip' ? { skipWhy: skipWhyOf(results) } : {}),
      });
      memory = after.memory;
      if (after.write) writeRouteCheckpoint(run, after.write.entry, fresh.now);
      // Say it once per change (not on every retry of the same answer).
      if (verdict.kind !== lastVerdict || verdict.kind === 'docked') {
        const n = keeperNote(fresh.route, fresh.flight, verdict, verdict.kind === 'skip' ? skipWhyOf(results) : undefined);
        if (n && fresh.flight.legSeq === legSeq) deps.note?.(n);
      }
    }).catch((err) => {
      console.warn('[route] keeper pass failed:', err);
      if (gen === generation && memory && memory.run === run && memory.legSeq === legSeq) {
        memory.passing = false;
        memory.nextPassAt = clock() + memory.backoffMs;
      }
    });
  };

  return {
    tick(): void {
      // 🛰️ Nothing before the room's shared state has arrived.
      if (!ready()) return;
      const now = clock();
      if (!isRouteRunning(readShipRoute())) { memory = null; return; }
      const docking = deps.docking();
      if (!docking) return;
      let v: KeeperView | null = null;
      try {
        v = viewNow(now, docking);
      } catch (err) {
        console.warn('[route] keeper read failed:', err);
        return;
      }
      if (!v) return;
      const step = keeperStep(v);
      // 🧾 A hold another rider's dock ended (their keeper wrote the dock):
      // this helm's hold note gives way to the dock, said once.
      if (v.memory.verdict === 'hold' && v.docks.atStop !== null && !v.flight.holding && v.flight.status === 'docked') {
        v.memory.verdict = 'docked';
        const n = keeperNote(v.route, v.flight, { kind: 'docked', gateChange: false });
        if (n) deps.note?.(n);
      }
      switch (step.kind) {
        case 'idle':
          return;
        case 'cast-off':
          castOff(v, docking, step.why);
          return;
        case 'write': {
          const said = v.memory.verdict;
          const wrote = write(v, step.why, step.entry);
          // A hold another rider's dock ended: say so here too.
          if (wrote && step.why === 'end-hold' && said !== 'docked') {
            v.memory.verdict = 'docked';
            const n = keeperNote(v.route, v.flight, { kind: 'docked', gateChange: false });
            if (n) deps.note?.(n);
          }
          return;
        }
        case 'dock':
          startPass(v, docking);
          return;
      }
    },

    dockAnswered(f: RouteFlight): boolean {
      const docking = deps.docking();
      if (!docking) return true;
      const route = readShipRoute();
      if (!isRouteRunning(route)) return true;
      const stop = route.stops[f.stopIndex];
      if (!stop) return true;
      const sameStation = samePredicate();
      if (liveBerthDocks().some((d) => sameStation(stop, d.roomId))) return true;
      if (standingHold(readRouteCheckpoints(), f.legSeq)) return true;
      return !!memory && memory.run === route.startedAt && memory.legSeq === f.legSeq
        && !memory.passing && memory.verdict !== null;
    },

    mayOperate(doorId: string, op: 'dock' | 'undock', farRoomId: string): boolean {
      if (!ready()) return false;
      const now = clock();
      const r = flightNow(now);
      if (!r) return false;
      const stop = r.route.stops[r.f.stopIndex];
      const sameStation = samePredicate();
      return keeperMayOperate({
        route: r.route,
        flight: r.f,
        now,
        doorId,
        op,
        farAtStop: !!stop && !!farRoomId && sameStation(stop, farRoomId),
      });
    },

    reset(): void {
      generation++;
      memory = null;
    },
  };
}
