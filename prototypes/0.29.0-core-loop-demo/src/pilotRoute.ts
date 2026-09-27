/**
 * 🚏⏱️ Pilot route — the ferry's timetable, worked out from the clock (robot
 * pilot routes, build notes A2 + A3; owner pick 2026-09-27, choice 1 (a)).
 *
 * A ship with a ROUTE (shipRoute.ts: its stops, shape and run fields, kept in
 * the ship's own room doc) flies it without anyone steering it leg by leg:
 * every game in the room works out where the ferry is from the route, a few
 * stored CHECKPOINTS and the clock. A leg that runs on time writes nothing.
 * When the schedule changes (a hold at a taken berth, a late departure, a
 * handover, a skipped stop) the game that saw it writes a checkpoint, and
 * every game's timetable runs on from the newest one.
 *
 * This file is the pure half: no doc, no DOM, no clock of its own. Everything
 * it knows comes in as arguments, so two games given the same route, the same
 * checkpoints and the same `now` get the same answer to the millisecond.
 * Pinned by pilotRoute.test.ts.
 *
 * ─── The timetable ───────────────────────────────────────────────────────────
 *
 *   stay 0      leg 0       stay 1      leg 1       stay 2  …
 *   ┌───────┐  ═════════▶  ┌───────┐  ═════════▶  ┌───────┐
 *   │stop s0│   in flight  │stop s1│   in flight  │stop s2│
 *   └───────┘              └───────┘              └───────┘
 *   docked until departAt, in flight until arriveAt, docked at the next stop
 *
 *  - `legSeq` L counts legs since START. Stay L is at stop stopAt(L), counted
 *    along the shape from `startStop`, and leg L leaves from it. A loop runs
 *    0→1→…→n−1→0; a back-and-forth runs 0→1→…→n−1→n−2→…→0→1….
 *  - Each stay lasts at least its stop's minimum wait, then the ferry leaves
 *    at the FIRST LAUNCH WINDOW after it (orbits.planTransfer, priced by PR
 *    172's own stationDirectory.planRecordHop). No redocking beat: the ship
 *    is `in-flight` until arriveAt and `docked` at the next stop after it.
 *  - Legs plan on the ROUTE'S OWN COPY of each stop's planet and orbit slot,
 *    never on this game's station list (station ids and lists are kept per
 *    install). They plan as `route-stop:<index>`, an id no station-keeping
 *    trim resolver knows, so every game derives the same untrimmed windows
 *    whatever it has heard about trims.
 *
 * ─── Window rules (A3) ───────────────────────────────────────────────────────
 *
 *  - Writers store departAt and arriveAt; readers use the stored values.
 *    `departAt` jumps a whole synodic period when the asking time crosses a
 *    window, so two writers whose base times differ by a second can disagree
 *    by a window, and no rounding fixes that.
 *  - NEVER pass a stored window time to planTransfer as `nowMs`: about half
 *    the time it answers with the NEXT window. To find a known window again,
 *    ask at departAt − synodicMs / 2 (legWindowAt).
 *  - Later legs are laid end to end from the newest checkpoint that carries
 *    times: each leaves at the first window after arrival + minimum wait.
 *
 * ─── What the checkpoints change (A2's kinds) ────────────────────────────────
 *
 *   start  START: stay 0's departure, the pilot and the fuel.
 *   hold   the berth refused (taken): the ferry waits at that stop, undocked,
 *          departure unknown. A hold nobody renews for 3 minutes ended
 *          unwatched: the leg leaves at the first window after it.
 *   dock   the dock landed after a hold (stayStart = the dock's own stamp),
 *          a keeper restarted a stay it found still docked after its
 *          departure, or RESUME (stayStart = at). A fresh minimum wait.
 *   skip   the berth is gone or closed: leave at the first window after it.
 *   go     a person's route DEPART: in flight from `at`, burning at departAt.
 *   helm   TAKE THE HELM / HAND TO ROBOT / KEEP THE HELM: who flies next.
 *   pause  DEPART off the route: the route is paused (the stored flight rules).
 *   fuel   REFUEL: the tank level at that stay.
 *
 *  At one stay the entry with the latest `at` decides (ties: pause, skip, go,
 *  dock, helm, start, hold), and dock, go, skip and pause end a hold. A helm
 *  entry carries times only when it re-times the stay (HAND TO ROBOT at a stay
 *  that is not holding); one written in flight is keyed to the next stay.
 *
 *  🧭 Three additive fields, beyond A2's table, keep the timetable intact
 *  when older checkpoints are pruned: `go` and a timed `helm` carry the
 *  `stayStart` their window was picked from, a keeper's `dock` and `skip`
 *  carry the `pilot` it derived (a robot takeover is never written on its
 *  own), and a RESUME `dock` carries `resume: true` (the pause it follows may
 *  be pruned, and a resumed ferry did not fly the route's legs to get there).
 *
 * ─── Reader checks (A2) ──────────────────────────────────────────────────────
 *
 *  validateCheckpoints ignores an entry unless: its stop is the one at
 *  stopAt(legSeq); its observed times are at most 60 s ahead of the reader's
 *  clock; they are not before the EARLIEST possible arrival at that stay,
 *  walking from the previous valid timed entry with every leg leaving at the
 *  first window after arrival (a helm or fuel entry, written in flight, is
 *  bounded by the previous leg's departure less the 10 s guard band; a RESUME
 *  dock by the pause before it); its departAt is a real window, the first at
 *  or after its base. The earliest chain is a lower bound whatever was pruned
 *  (holds, restarts and takeovers only delay a ferry), so a pruned history
 *  never gets a valid entry rejected. It also rejects an entry for a stay the
 *  ferry cannot have reached yet.
 *
 * ─── Live docks, the person at the helm, STOP, fuel ─────────────────────────
 *
 *  - LIVE DOCK (A3.3): a departure from stay L does not happen while the ship
 *    is still docked at stop L's berth; it stays docked there, overdue. The
 *    caller says when that dock was made (its DoorPairing.dockedAt), so a
 *    route that calls at one stop twice (every back-and-forth does) pins the
 *    stay the dock belongs to, never an earlier visit to the same stop.
 *    A dock belongs to stay L when it was made before L's leg could land
 *    (no pairing is made in flight, so a stamp past the departure is a
 *    clock running ahead), a stamp later than now reading as now.
 *  - A PERSON at the helm: the walk stops at the departure until they press
 *    DEPART (a `go`), or until the robot captain takes over 5 minutes after it
 *    (or after the newest KEEP THE HELM) and leaves at the next window.
 *    Whether there is a robot captain is read from `route.robotDockId` alone.
 *  - STOP (A3.6): the end stay is the one current at `stoppedAt` if that is
 *    more than 10 s before it leaves, else the next. From it on the ship is
 *    pinned `docked` there.
 *  - FUEL (A3.5, choice 4 b): the newest `fuel` (or `start`) level, less
 *    every leg since, reset to full on each arrival at stops[0] when
 *    `homeRefuel` is set, clamped with clampFuelToCapacity. A leg burns when
 *    the ship goes in flight. The route ends, docked, at the last stop the
 *    fuel reaches. (shipRoute.ts turns this level into the tank's 'route'
 *    draw meter, so on-time legs write no fuel either.)
 *
 * ─── The flight PR 172's readers follow (A4) ─────────────────────────────────
 *
 *  resolvedFlight: the timetable's flight while the route runs unpaused, the
 *  stored `flight` otherwise (shipRoute.readResolvedFlight feeds it the doc).
 *  routeSettleAction: what a helm-gated game writes to copy the timetable
 *  back into the stored records (after STOP; or a person's `in-flight` the
 *  timetable has landed), along legal edges only (shipDoc.flightWritePath).
 */

import { clampFuelToCapacity, flightWritePath } from './shipDoc';
import type { FlightRecord } from './shipDoc';
import { planRecordHop } from './stationDirectory';
import type { StationRecordLike } from './stationDirectory';
import type {
  CheckpointKind,
  DockCheckpoint,
  FuelCheckpoint,
  GoCheckpoint,
  HelmCheckpoint,
  HoldCheckpoint,
  PauseCheckpoint,
  RouteCheckpoint,
  RoutePilot,
  RouteShape,
  RouteStop,
  ShipRoute,
  SkipCheckpoint,
  SkipWhy,
  StartCheckpoint,
} from './shipRoute';

// ── Constants (A2, A3, A5) ───────────────────────────────────────────────────

/** How far ahead of the reader's clock an observed time may be (clock skew). */
export const CLOCK_AHEAD_MS = 60_000;
/** A hold nobody renewed for this long ended unwatched (the design's stated
 *  default: a margin over the one-minute renewal and sync). */
export const HOLD_UNWATCHED_MS = 3 * 60_000;
/** A robot captain takes the helm back this long after a person let the
 *  departure pass (or after their newest KEEP THE HELM). */
export const ROBOT_TAKEOVER_MS = 5 * 60_000;
/** STOP pressed within this long of a departure ends the route at the next
 *  stop instead. */
export const STOP_GUARD_MS = 10_000;
/** A helm, KEEP or REFUEL entry this close to a departure is keyed to the
 *  following stay, so readers bound it by the leg's departure less this. */
export const GUARD_BAND_MS = 10_000;
/** Slack when a stored window is found again, or compared with its base. */
export const WINDOW_TOLERANCE_MS = 1;
/** The highest legSeq a checkpoint key may carry (about 200 years of 55 s
 *  legs); parsers refuse more. */
export const MAX_LEG_SEQ = 99_999_999;
/** The most stays one walk lays end to end before giving up. A month with no
 *  checkpoint is about 40,000 short legs; a game walks it once, then caches. */
export const MAX_WALK_STAYS = 500_000;
/** ⏱️ Robot legs write nothing, so the keeper writes a `dock` anchor at an
 *  on-time robot stay this many stays past the newest timed entry
 *  (routeKeeper.ts): a reader that joins a ferry running for months walks
 *  from it, never from START. It says what the timetable already says. */
export const ROUTE_ANCHOR_EVERY_STAYS = 1_000;
/** ⏱️ How many stays past an entry the reader checks (validateCheckpoints)
 *  lays end to end; further on it bounds the chain by the shortest transfer
 *  instead, so an anchor far from START costs the same to check. */
const CHAIN_EXACT_STAYS = 2 * ROUTE_ANCHOR_EVERY_STAYS;

// ── Stops along the shape ────────────────────────────────────────────────────

/** Legs in one full cycle of the shape: a loop of n stops has n, a
 *  back-and-forth 2(n − 1). */
export function routeCycleLength(stopCount: number, shape: RouteShape): number {
  return shape === 'loop' ? stopCount : 2 * (stopCount - 1);
}

/** The stop index of stay `legSeq`, counted along the shape from the run's
 *  startStop (0 when unset). A back-and-forth started mid-route heads for
 *  the higher stops first. */
export function stopAt(route: Pick<ShipRoute, 'stops' | 'shape' | 'startStop'>, legSeq: number): number {
  const n = route.stops.length;
  const start = route.startStop ?? 0;
  if (n < 2) return 0;
  if (route.shape === 'loop') return (start + legSeq) % n;
  const cycle = 2 * (n - 1);
  const k = (start + legSeq) % cycle;
  return k < n ? k : cycle - k;
}

/** Every ordered stop pair a route of this shape flies, each once. */
export function routeLegPairs(stopCount: number, shape: RouteShape): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  if (stopCount < 2) return pairs;
  if (shape === 'loop') {
    for (let i = 0; i < stopCount; i++) pairs.push([i, (i + 1) % stopCount]);
  } else {
    for (let i = 0; i + 1 < stopCount; i++) pairs.push([i, i + 1], [i + 1, i]);
  }
  return pairs;
}

/** The smallest legSeq ≥ `from` whose stay is at `stopIndex` (within one
 *  cycle), or −1 when the shape never calls there. RESUME keys its `dock`
 *  here: the first visit to the stop the ship docked at. */
export function nextStayAtStop(
  route: Pick<ShipRoute, 'stops' | 'shape' | 'startStop'>,
  from: number,
  stopIndex: number,
): number {
  const cycle = routeCycleLength(route.stops.length, route.shape);
  for (let k = from; k < from + cycle; k++) if (stopAt(route, k) === stopIndex) return k;
  return -1;
}

// ── Legs ─────────────────────────────────────────────────────────────────────

/** One planned leg: the launch window it leaves at and what it burns. */
export interface LegWindow {
  from: number;
  to: number;
  departAt: number;
  arriveAt: number;
  transferMs: number;
  synodicMs: number;
  fuelCost: number;
}

/** What the planner needs to know about stop `index`: the route's own copy,
 *  under an id no trim resolver knows (see the header). */
function stopRecord(stops: readonly RouteStop[], index: number): StationRecordLike {
  const s = stops[index];
  return {
    id: `route-stop:${index}`,
    name: s.name,
    planetId: s.planetId,
    orbitSlot: s.orbitSlot,
    welcomeRoomId: s.berth.roomId,
  };
}

/** The first window at or after `base` from stop `from` to stop `to`. Its
 *  times are whole milliseconds, rounded up as stationDirectory.planHop
 *  rounds a DEPART's (orbital math gives fractions, and a flight record
 *  stores only safe integers: the timetable's times become its departedAt
 *  and etaAt). Rounded up, so a ferry never burns before its window. */
function pairWindowAfter(stops: readonly RouteStop[], from: number, to: number, base: number): LegWindow | null {
  if (!Number.isFinite(base) || !stops[from] || !stops[to]) return null;
  const hop = planRecordHop(stopRecord(stops, from), stopRecord(stops, to), base);
  if (!hop || !(hop.arriveAt > hop.departAt) || !(hop.windowEveryMs !== undefined && hop.windowEveryMs > 0)) return null;
  const departAt = Math.ceil(hop.departAt);
  const arriveAt = Math.max(departAt + 1, Math.ceil(hop.arriveAt));
  if (!Number.isSafeInteger(departAt) || !Number.isSafeInteger(arriveAt)) return null;
  return {
    from,
    to,
    departAt,
    arriveAt,
    transferMs: arriveAt - departAt,
    synodicMs: hop.windowEveryMs,
    fuelCost: hop.fuelCost,
  };
}

/** Every leg of the shape can be planned: same planet, different orbits. The
 *  editor refuses a route that fails this, and so does the reader. */
export function routeLegsPlannable(stops: readonly RouteStop[], shape: RouteShape): boolean {
  if (stops.length < 2) return false;
  return routeLegPairs(stops.length, shape).every(([a, b]) => pairWindowAfter(stops, a, b, 0) !== null);
}

/** Per-call leg planner: memoizes each stop pair's fixed figures (transfer
 *  time, window spacing, fuel), which depend only on the two orbits. */
class Legs {
  private readonly pairs = new Map<number, LegWindow | null>();

  constructor(readonly route: ShipRoute) {}

  stopAt(legSeq: number): number {
    return stopAt(this.route, legSeq);
  }

  /** The pair's fixed figures (its window times are an arbitrary example). */
  pair(from: number, to: number): LegWindow | null {
    const key = from * 64 + to;
    let p = this.pairs.get(key);
    if (p === undefined) {
      p = pairWindowAfter(this.route.stops, from, to, 0);
      this.pairs.set(key, p);
    }
    return p;
  }

  leg(legSeq: number): LegWindow | null {
    return this.pair(this.stopAt(legSeq), this.stopAt(legSeq + 1));
  }

  private shortest: number | undefined;

  /** ⏱️ The shortest transfer of any leg of the shape (0 when one can't be
   *  planned): every leg takes at least this long. */
  minTransferMs(): number {
    if (this.shortest === undefined) {
      let min = Number.POSITIVE_INFINITY;
      for (const [a, b] of routeLegPairs(this.route.stops.length, this.route.shape)) {
        min = Math.min(min, this.pair(a, b)?.transferMs ?? 0);
      }
      this.shortest = Number.isFinite(min) ? min : 0;
    }
    return this.shortest;
  }

  /** Leg `legSeq`'s first window at or after `base`. */
  windowAfter(legSeq: number, base: number): LegWindow | null {
    return pairWindowAfter(this.route.stops, this.stopAt(legSeq), this.stopAt(legSeq + 1), base);
  }

  /** Leg `legSeq`'s window at the stored `departAt`, found again by asking
   *  half a period early; null when `departAt` is no window of this leg. */
  windowAt(legSeq: number, departAt: number): LegWindow | null {
    const p = this.leg(legSeq);
    if (!p || !Number.isFinite(departAt)) return null;
    const w = this.windowAfter(legSeq, departAt - p.synodicMs / 2);
    return w && Math.abs(w.departAt - departAt) <= WINDOW_TOLERANCE_MS ? w : null;
  }

  waitMs(legSeq: number): number {
    return this.route.stops[this.stopAt(legSeq)].waitSecs * 1000;
  }

  stationId(legSeq: number): string {
    return this.route.stops[this.stopAt(legSeq)].stationId;
  }
}

/** Leg `legSeq`'s first launch window at or after `base` (a writer's
 *  planner: base = arrival + minimum wait, a restart, a late DEPART…). */
export function legWindowAfter(route: ShipRoute, legSeq: number, base: number): LegWindow | null {
  return new Legs(route).windowAfter(legSeq, base);
}

/** Leg `legSeq`'s stored window found again (never asked AT the window time);
 *  null when `departAt` is not one of its windows. Draw a leg from this with
 *  the stored departAt/arriveAt pinned, never a rounded time. */
export function legWindowAt(route: ShipRoute, legSeq: number, departAt: number): LegWindow | null {
  return new Legs(route).windowAt(legSeq, departAt);
}

/** Fuel one leg from stop `from` to stop `to` burns (planRecordHop's price),
 *  or null when the pair can't be flown. */
export function routeLegFuel(route: ShipRoute, from: number, to: number): number | null {
  return pairWindowAfter(route.stops, from, to, 0)?.fuelCost ?? null;
}

/** 🧑‍✈️ A leg between two stops of a route still being edited (the helm's
 *  route panel, helmRoute.ts): its fixed figures (flight time, window
 *  spacing, fuel), planned exactly as the timetable plans it, from the stops'
 *  own copies; null when the pair can't be flown. */
export function stopPairWindow(stops: readonly RouteStop[], from: number, to: number): LegWindow | null {
  return pairWindowAfter(stops, from, to, 0);
}

// ── Checkpoint helpers ───────────────────────────────────────────────────────

/** Tie order at one stay: at equal `at`, the higher rank decides. */
const TIE_RANK: Record<CheckpointKind, number> = {
  pause: 7, skip: 6, go: 5, dock: 4, helm: 3, start: 2, hold: 1, fuel: 0,
};

/** Kind order inside one stay, for a deterministic sort. */
const KIND_ORDER: Record<CheckpointKind, number> = {
  start: 0, hold: 1, dock: 2, skip: 3, go: 4, helm: 5, pause: 6, fuel: 7,
};

function present<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

/** Is `a` newer than `b` at one stay (latest `at`, then the tie order)? */
function newer(a: RouteCheckpoint, b: RouteCheckpoint): boolean {
  return a.at > b.at || (a.at === b.at && TIE_RANK[a.kind] > TIE_RANK[b.kind]);
}

/** An entry that carries a departure (and arrival) for its stay. */
export type TimedCheckpoint =
  | StartCheckpoint
  | DockCheckpoint
  | SkipCheckpoint
  | GoCheckpoint
  | (HelmCheckpoint & { stayStart: number; departAt: number; arriveAt: number });

export function isTimedCheckpoint(e: RouteCheckpoint): e is TimedCheckpoint {
  switch (e.kind) {
    case 'start':
    case 'dock':
    case 'skip':
    case 'go':
      return true;
    case 'helm':
      return e.departAt !== undefined && e.arriveAt !== undefined && e.stayStart !== undefined;
    default:
      return false;
  }
}

/** The base a timed entry's window was picked from (A2): the first window at
 *  or after it is the entry's departAt. */
function windowBase(e: TimedCheckpoint, waitMs: number): number {
  switch (e.kind) {
    case 'start':
    case 'dock':
      return e.stayStart + waitMs;
    case 'skip':
      return e.at;
    case 'go':
    case 'helm':
      return Math.max(e.at, e.stayStart + waitMs);
  }
}

/** Is `a` newer than `b` across stays: a later stay, then the tie rules. */
function newerOverall(a: RouteCheckpoint, b: RouteCheckpoint): boolean {
  return a.legSeq > b.legSeq || (a.legSeq === b.legSeq && newer(a, b));
}

function newestOf<T extends RouteCheckpoint>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const e of list) if (!best || newerOverall(e, best)) best = e;
  return best;
}

/** One stay's entries, one per kind (one key per kind per stay). */
interface StayEntries {
  start?: StartCheckpoint;
  hold?: HoldCheckpoint;
  dock?: DockCheckpoint;
  skip?: SkipCheckpoint;
  go?: GoCheckpoint;
  helm?: HelmCheckpoint;
  pause?: PauseCheckpoint;
  fuel?: FuelCheckpoint;
}

function groupStay(list: readonly RouteCheckpoint[]): StayEntries {
  const out: StayEntries = {};
  const slots = out as Record<CheckpointKind, RouteCheckpoint | undefined>;
  for (const e of list) {
    const had = slots[e.kind];
    if (!had || newer(e, had)) slots[e.kind] = e;
  }
  return out;
}

type StayDecision =
  | { kind: 'none' }
  | { kind: 'paused'; pause: PauseCheckpoint }
  | { kind: 'hold'; hold: HoldCheckpoint }
  | { kind: 'timed'; entry: TimedCheckpoint };

function newestTimedAt(s: StayEntries): TimedCheckpoint | null {
  let best: TimedCheckpoint | null = null;
  for (const e of [s.start, s.dock, s.skip, s.go, s.helm]) {
    if (e && isTimedCheckpoint(e) && (!best || newer(e, best))) best = e;
  }
  return best;
}

/** What one stay's entries say (A2 "Reading"). */
function decideStay(s: StayEntries | undefined): StayDecision {
  if (!s) return { kind: 'none' };
  const timed = newestTimedAt(s);
  const { pause, hold } = s;
  if (pause && (!timed || newer(pause, timed)) && (!hold || newer(pause, hold))) return { kind: 'paused', pause };
  if (hold) {
    const enders: RouteCheckpoint[] = [s.dock, s.go, s.skip, s.pause].filter(present);
    if (enders.every((e) => newer(hold, e))) return { kind: 'hold', hold };
  }
  return timed ? { kind: 'timed', entry: timed } : { kind: 'none' };
}

/** One entry per (legSeq, kind), sorted by stay then kind. */
function normalize(checkpoints: readonly RouteCheckpoint[]): RouteCheckpoint[] {
  const byKey = new Map<string, RouteCheckpoint>();
  for (const e of checkpoints) {
    const key = `${e.legSeq}:${e.kind}`;
    const had = byKey.get(key);
    if (!had || newer(e, had)) byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => a.legSeq - b.legSeq || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

// ── Reader checks (A2) ───────────────────────────────────────────────────────

export type CheckpointRejection =
  | 'not-running'
  | 'wrong-stop'
  | 'start-not-first'
  | 'ahead'
  | 'early'
  | 'paused'
  | 'bad-stay-start'
  | 'not-a-window'
  | 'not-first-window';

export interface ValidatedCheckpoints {
  /** The entries that passed, one per (legSeq, kind), in stay order. */
  entries: RouteCheckpoint[];
  /** The newest valid entry that carries times: where the walk starts. */
  anchor: TimedCheckpoint | null;
  rejected: Array<{ entry: RouteCheckpoint; reason: CheckpointRejection }>;
  /** The answer may change once the clock reaches this (an entry that was
   *  too far ahead comes into range); +Infinity when it cannot. */
  recheckAt: number;
}

/** Times an entry says its writer saw (bounded by the reader's clock). */
function observedTimes(e: RouteCheckpoint): number[] {
  switch (e.kind) {
    case 'start':
    case 'dock':
      return [e.at, e.stayStart];
    case 'hold':
      return [e.at, e.since, e.seenAt];
    default:
      return [e.at];
  }
}

/**
 * The reader checks (A2): which of `checkpoints` (this run's, shape-checked
 * by shipRoute.ts) the timetable may use at `now`, and its anchor. See the
 * header for the rules.
 */
export function validateCheckpoints(
  route: ShipRoute,
  checkpoints: readonly RouteCheckpoint[],
  now: number,
): ValidatedCheckpoints {
  const out: ValidatedCheckpoints = { entries: [], anchor: null, rejected: [], recheckAt: Number.POSITIVE_INFINITY };
  const list = normalize(checkpoints);
  const run = route.startedAt;
  if (run === undefined) {
    for (const entry of list) out.rejected.push({ entry, reason: 'not-running' });
    return out;
  }
  const legs = new Legs(route);
  const limit = now + CLOCK_AHEAD_MS;
  const byStay = new Map<number, RouteCheckpoint[]>();
  for (const e of list) {
    const at = byStay.get(e.legSeq);
    if (at) at.push(e);
    else byStay.set(e.legSeq, [e]);
  }

  // The earliest chain: stay `chainStay` is reached no sooner than
  // `chainArrival`, and the leg into it left no sooner than `chainDepart`.
  let chainStay = 0;
  let chainArrival = run;
  let chainDepart = run;
  let paused: PauseCheckpoint | null = null;
  let lastPause: PauseCheckpoint | null = null;
  const reject = (entry: RouteCheckpoint, reason: CheckpointRejection, recheck?: number) => {
    out.rejected.push({ entry, reason });
    if (recheck !== undefined) out.recheckAt = Math.min(out.recheckAt, recheck);
  };

  for (const legSeq of [...byStay.keys()].sort((a, b) => a - b)) {
    const stay = byStay.get(legSeq)!;
    // While paused, later stays are bounded by the pause, not by the route's
    // legs: the ship flies off the route and may reach any stop sooner.
    const pausedHere = paused !== null && legSeq > paused.legSeq;
    let reachable = true;
    let walked = 0;
    while (!pausedHere && chainStay < legSeq) {
      if (walked >= CHAIN_EXACT_STAYS) {
        // ⏱️ Far past the last entry: every leg takes at least the shortest
        // transfer, which still bounds the stay from below (never above).
        const skipped = legSeq - chainStay;
        const into = legs.leg(legSeq - 1)?.transferMs ?? 0;
        chainArrival += skipped * legs.minTransferMs();
        chainDepart = chainArrival - into;
        chainStay = legSeq;
        // Not reached yet: even the leg into the stay before it can't have
        // left by now (it arrives no sooner than one shortest transfer back).
        const before = chainArrival - legs.minTransferMs() - (legs.leg(legSeq - 2)?.transferMs ?? 0);
        if (skipped > 1 && before - GUARD_BAND_MS > limit) reachable = false;
        break;
      }
      const w = legs.windowAfter(chainStay, chainArrival);
      if (!w) { reachable = false; break; }
      walked++;
      chainDepart = w.departAt;
      chainArrival = w.arriveAt;
      chainStay++;
      // Not reached yet: even a guard-band entry would be ahead of the clock.
      if (chainStay < legSeq && chainDepart - GUARD_BAND_MS > limit) { reachable = false; break; }
    }
    const stationId = legs.stationId(legSeq);
    const waitMs = legs.waitMs(legSeq);
    const intoTransfer = legSeq > 0 ? (legs.leg(legSeq - 1)?.transferMs ?? 0) : 0;
    // A RESUME dock goes first: the stay starts over from it (its own pause
    // may be pruned already, and it never came along the route's legs).
    const ordered = [...stay].sort((a, b) => Number(isResume(b)) - Number(isResume(a)));
    let stayBound = chainArrival;
    let resumed = false;
    const valid: RouteCheckpoint[] = [];
    for (const e of ordered) {
      if (e.stationId !== stationId) { reject(e, 'wrong-stop'); continue; }
      if (e.kind === 'start' && legSeq !== 0) { reject(e, 'start-not-first'); continue; }
      const offRoute = pausedHere || resumed || isResume(e);
      if (!reachable && !offRoute) { reject(e, 'ahead', chainDepart - GUARD_BAND_MS - CLOCK_AHEAD_MS); continue; }
      const seen = observedTimes(e);
      const latest = Math.max(...seen);
      if (latest > limit) { reject(e, 'ahead', latest - CLOCK_AHEAD_MS); continue; }
      let bound: number;
      if (isResume(e)) {
        bound = pausedHere ? paused!.at : (lastPause?.at ?? run);
      } else if (pausedHere && !resumed) {
        if (!(e.kind === 'helm' || e.kind === 'fuel')) { reject(e, 'paused'); continue; }
        bound = paused!.at;
      } else if (resumed) {
        bound = stayBound;
      } else if (e.kind === 'helm' || e.kind === 'fuel') {
        bound = Math.min(stayBound, chainDepart - GUARD_BAND_MS);
      } else {
        bound = stayBound;
      }
      if (e.kind === 'start') bound = Math.max(bound, run);
      if (Math.min(...seen) < bound) { reject(e, 'early'); continue; }
      if (!stayStartFits(e, stayBound, intoTransfer)) { reject(e, 'bad-stay-start'); continue; }
      if (isTimedCheckpoint(e)) {
        const w = legs.windowAt(legSeq, e.departAt);
        if (!w || Math.abs((e.arriveAt - e.departAt) - w.transferMs) > WINDOW_TOLERANCE_MS) { reject(e, 'not-a-window'); continue; }
        const lead = e.departAt - windowBase(e, waitMs);
        if (lead < -WINDOW_TOLERANCE_MS || lead > w.synodicMs + WINDOW_TOLERANCE_MS) { reject(e, 'not-first-window'); continue; }
      }
      valid.push(e);
      if (isResume(e)) { stayBound = e.stayStart; resumed = true; }
    }
    const decision = decideStay(groupStay(valid));
    if (decision.kind === 'paused') {
      paused = decision.pause;
      lastPause = decision.pause;
    } else if (decision.kind === 'timed') {
      paused = null;
      chainStay = legSeq + 1;
      chainArrival = decision.entry.arriveAt;
      chainDepart = decision.entry.departAt;
    }
    out.entries.push(...valid);
  }
  out.entries = normalize(out.entries);
  out.anchor = newestOf(out.entries.filter(isTimedCheckpoint));
  return out;
}

function isResume(e: RouteCheckpoint): e is DockCheckpoint & { resume: true } {
  return e.kind === 'dock' && e.resume === true;
}

/** The kind-specific stayStart rules. */
function stayStartFits(e: RouteCheckpoint, stayBound: number, intoTransfer: number): boolean {
  switch (e.kind) {
    case 'start':
      return e.stayStart === e.at; // START's stay starts at START
    case 'dock':
      return e.resume ? e.stayStart === e.at : true; // RESUME uses `at`
    case 'hold':
      return e.since === e.at && e.seenAt >= e.at; // a renewal keeps `at`
    case 'go':
      // The stay began before the press (within clock skew).
      return e.stayStart >= stayBound && e.stayStart <= e.at + CLOCK_AHEAD_MS;
    case 'helm':
      if (e.stayStart === undefined) return true;
      // Written in flight it is the next arrival: at most one leg ahead.
      return e.stayStart >= stayBound
        && e.stayStart <= e.at + intoTransfer + GUARD_BAND_MS + CLOCK_AHEAD_MS;
    default:
      return true;
  }
}

// ── Checkpoint constructors (writers) ────────────────────────────────────────
//
// Each builds the entry exactly as the reader checks it: the right stop, and
// the first window at or after the kind's base. They return null when the
// leg cannot be planned. None of them writes anything (shipRoute.ts does).

function common(legs: Legs, legSeq: number, at: number) {
  return { legSeq, at, stationId: legs.stationId(legSeq) };
}

/** START (stay 0): leaves at the first window after the minimum wait. */
export function startCheckpoint(
  route: ShipRoute,
  o: { at: number; pilot: RoutePilot; fuel: number },
): StartCheckpoint | null {
  const legs = new Legs(route);
  const w = legs.windowAfter(0, o.at + legs.waitMs(0));
  if (!w) return null;
  return {
    kind: 'start', ...common(legs, 0, o.at), stayStart: o.at,
    departAt: w.departAt, arriveAt: w.arriveAt, pilot: o.pilot, fuel: o.fuel,
  };
}

/** A dock after a hold (stayStart = the pairing's dockedAt), a restarted
 *  stay (stayStart = at), or RESUME (`resume`, stayStart = at). `pilot` is
 *  the one the writer derived for the leg that leaves this stay. */
export function dockCheckpoint(
  route: ShipRoute,
  legSeq: number,
  o: { at: number; stayStart?: number; pilot: RoutePilot; resume?: boolean },
): DockCheckpoint | null {
  const legs = new Legs(route);
  const stayStart = o.resume ? o.at : (o.stayStart ?? o.at);
  const w = legs.windowAfter(legSeq, stayStart + legs.waitMs(legSeq));
  if (!w) return null;
  return {
    kind: 'dock', ...common(legs, legSeq, o.at), stayStart,
    departAt: w.departAt, arriveAt: w.arriveAt, pilot: o.pilot,
    ...(o.resume ? { resume: true as const } : {}),
  };
}

/** The berth is gone or closed (or SKIP STOP): leave at the first window. */
export function skipCheckpoint(
  route: ShipRoute,
  legSeq: number,
  o: { at: number; pilot: RoutePilot; why?: SkipWhy },
): SkipCheckpoint | null {
  const legs = new Legs(route);
  const w = legs.windowAfter(legSeq, o.at);
  if (!w) return null;
  return {
    kind: 'skip', ...common(legs, legSeq, o.at), departAt: w.departAt, arriveAt: w.arriveAt, pilot: o.pilot,
    // 🚀 Why, for the robot captain's line (additive; absent reads as unknown).
    ...(o.why !== undefined ? { why: o.why } : {}),
  };
}

/** A person's route DEPART: the first window after max(at, stayStart + wait),
 *  with stayStart the stay's derived arrival or its dock (RouteFlight's). */
export function goCheckpoint(
  route: ShipRoute,
  legSeq: number,
  o: { at: number; stayStart: number },
): GoCheckpoint | null {
  const legs = new Legs(route);
  const w = legs.windowAfter(legSeq, Math.max(o.at, o.stayStart + legs.waitMs(legSeq)));
  if (!w) return null;
  return { kind: 'go', ...common(legs, legSeq, o.at), stayStart: o.stayStart, departAt: w.departAt, arriveAt: w.arriveAt };
}

/** TAKE / HAND TO ROBOT / KEEP. With `stayStart` (HAND TO ROBOT at a stay
 *  that is not holding) it re-times the stay like a DEPART would. */
export function helmCheckpoint(
  route: ShipRoute,
  legSeq: number,
  o: { at: number; pilot: RoutePilot; stayStart?: number },
): HelmCheckpoint | null {
  const legs = new Legs(route);
  const base = { kind: 'helm' as const, ...common(legs, legSeq, o.at), pilot: o.pilot };
  if (o.stayStart === undefined) return base;
  const w = legs.windowAfter(legSeq, Math.max(o.at, o.stayStart + legs.waitMs(legSeq)));
  if (!w) return null;
  return { ...base, stayStart: o.stayStart, departAt: w.departAt, arriveAt: w.arriveAt };
}

/** The berth refused (occupied, overlap): the ferry holds. */
export function holdCheckpoint(route: ShipRoute, legSeq: number, o: { at: number }): HoldCheckpoint {
  const legs = new Legs(route);
  return { kind: 'hold', ...common(legs, legSeq, o.at), since: o.at, seenAt: o.at };
}

/** A keeper's renewal of a hold it still sees: keeps `at`, moves `seenAt`. */
export function renewedHold(hold: HoldCheckpoint, seenAt: number): HoldCheckpoint {
  return { ...hold, seenAt: Math.max(hold.seenAt, seenAt) };
}

/** DEPART off the route: the route pauses at this stay. */
export function pauseCheckpoint(route: ShipRoute, legSeq: number, o: { at: number }): PauseCheckpoint {
  return { kind: 'pause', ...common(new Legs(route), legSeq, o.at) };
}

/** REFUEL: the tank's level at this stay (before its leg). */
export function fuelCheckpoint(route: ShipRoute, legSeq: number, o: { at: number; fuel: number }): FuelCheckpoint {
  return { kind: 'fuel', ...common(new Legs(route), legSeq, o.at), fuel: o.fuel };
}

// ── Pruning (A2) ─────────────────────────────────────────────────────────────

/**
 * Which of this run's entries a writer deletes, so the timetable reads the
 * same after pruning and only a handful of keys remain (readers look at no
 * more than 64):
 *
 *  - The FLOOR is the newest valid timed entry of a kind no later write can
 *    strip of its times: start, dock, skip or go. 🧭 Never a timed `helm`
 *    (HAND TO ROBOT): a TAKE at the same stay rewrites that key without
 *    times, and the history under it must still be there when it does.
 *  - Below the floor everything goes except: `start`; the newest RESUME
 *    `dock` (the reader checks every later entry from it, not from the
 *    route's own legs: the ship came back off route, often sooner); the
 *    newest `helm` (the pilot the floor's stay is entered with) unless that
 *    RESUME, newer, stamps the pilot itself; and ⛔ the newest gone `skip` of
 *    each stop, with the RESUME its check walks from (a stop found gone is
 *    passed for the rest of the run, design §4).
 *  - ⛽ Only the newest `fuel` entry is kept, below or above the floor: a
 *    REFUEL sets the level outright, and a later REFUEL proves the ferry flew
 *    on to it (the timetable never ends a route for fuel before its newest
 *    REFUEL), so the older ones say nothing any more. A ferry refuelled at
 *    every stop, on time, writing nothing else, keeps one key for it.
 *  - Entries at or above the floor are kept; junk below it goes.
 */
export function checkpointsToPrune(
  route: ShipRoute,
  checkpoints: readonly RouteCheckpoint[],
  now: number,
): RouteCheckpoint[] {
  const v = validateCheckpoints(route, checkpoints, now);
  const legs = new Legs(route);
  const validSet = new Set(v.entries);
  const newestFuel = newestOf(v.entries.filter((e) => e.kind === 'fuel'));
  const stable = newestOf(v.entries.filter((e) => isTimedCheckpoint(e) && e.kind !== 'helm'));
  const floor = stable ? stable.legSeq : Number.NEGATIVE_INFINITY;
  const below = v.entries.filter((e) => e.legSeq < floor);
  const resumes = below.filter(isResume);
  const resumeAtOrBefore = (legSeq: number) => newestOf(resumes.filter((e) => e.legSeq <= legSeq));
  const keep = new Set<RouteCheckpoint>(below.filter((e) => e.kind === 'start'));
  const resume = newestOf(resumes);
  if (resume) keep.add(resume);
  const helm = newestOf(below.filter((e) => e.kind === 'helm'));
  if (helm && (!resume || resume.pilot === undefined || helm.legSeq >= resume.legSeq)) keep.add(helm);
  for (const g of goneMarks(legs, below).values()) {
    keep.add(g);
    const r = resumeAtOrBefore(g.legSeq);
    if (r) keep.add(r);
  }
  return normalize(checkpoints).filter((e) => {
    if (!validSet.has(e)) return e.legSeq < floor; // junk below the floor
    if (e.kind === 'fuel') return e !== newestFuel;
    if (e.legSeq >= floor) return false;
    return !keep.has(e);
  });
}

/** ⛔ Design §4: a `skip` a keeper wrote because every gate of its stop was
 *  GONE (the berth door, or its port, removed). */
function isGoneSkip(e: RouteCheckpoint): e is SkipCheckpoint & { why: 'gone' } {
  return e.kind === 'skip' && e.why === 'gone';
}

/** The newest gone skip of each stop among `entries`, by stop index. */
function goneMarks(legs: Legs, entries: readonly RouteCheckpoint[]): Map<number, SkipCheckpoint> {
  const out = new Map<number, SkipCheckpoint>();
  for (const e of entries) {
    if (!isGoneSkip(e)) continue;
    const stop = legs.stopAt(e.legSeq);
    const had = out.get(stop);
    if (!had || newerOverall(e, had)) out.set(stop, e);
  }
  return out;
}

// ── The timetable (A3) ───────────────────────────────────────────────────────

/** When the ship's port was docked at stop `stopIndex`'s station (the
 *  pairing's dockedAt), or null when it is not docked there. Ship readers
 *  answer from their docked ports, station readers from their berth door.
 *
 *  🛟 `held` (A5 "Rights"): when the oldest of the ship's OTHER live berth
 *  pairings was made (a guest berth on the ferry, or another of its dock
 *  ports: anything but the route's own port), or null/absent when none. Such
 *  a pairing holds whatever stay the ferry is at, wherever it leads, until
 *  someone with rights over it lets it go (the ferry stays, DELAYED). Every
 *  rider reads the same door records, so every rider's timetable agrees; a
 *  station's board sees only the pairings in its own room
 *  (departuresBoard.ferryDocksHere). */
export interface LiveDockAt {
  (stop: RouteStop, stopIndex: number): number | null;
  readonly held?: number | null;
}

/** A live dock list turned into a LiveDockAt: a dock counts for a stop when
 *  it is in that stop's berth room (a gate change within the room still
 *  counts), or when `sameStation` says the room belongs to that stop's
 *  station (a gate in another room). 🛟 With `routePort`, every dock on
 *  ANOTHER door also sets `held` (its oldest stamp). */
export function liveDockFrom(
  docks: ReadonlyArray<{ roomId: string; dockedAt: number; doorId?: string }>,
  sameStation?: (stop: RouteStop, roomId: string) => boolean,
  o: { routePort?: string } = {},
): LiveDockAt {
  const at = (stop: RouteStop): number | null => {
    let t: number | null = null;
    for (const d of docks) {
      if (d.roomId !== stop.berth.roomId && !(sameStation?.(stop, d.roomId) ?? false)) continue;
      if (Number.isFinite(d.dockedAt) && (t === null || d.dockedAt > t)) t = d.dockedAt;
    }
    return t;
  };
  let held: number | null = null;
  if (o.routePort !== undefined) {
    for (const d of docks) {
      if (d.doorId === o.routePort || !Number.isFinite(d.dockedAt)) continue;
      if (held === null || d.dockedAt < held) held = d.dockedAt;
    }
  }
  return Object.assign(at, { held });
}

/** PR 172's FlightRecord, as the timetable derives it, plus the route's own
 *  figures. `locationId` / `destinationId` are the route's copied station
 *  ids (the saving install's; alias them with localStationId to read them as
 *  this install's). */
export interface RouteFlight extends FlightRecord {
  /** Stay L (docked at stopIndex), or leg L in flight (left stopIndex). */
  legSeq: number;
  stopIndex: number;
  nextStopIndex: number;
  /** When stay legSeq began (arrival, or its dock after a hold / restart);
   *  null when not known (the anchor's stay superseded by a hold). */
  stayStart: number | null;
  /** When leg legSeq leaves (the burn): the stored window, a derived one,
   *  or the robot captain's after a takeover. Null while holding, paused or
   *  ended. */
  departsAt: number | null;
  /** The departure before a robot takeover moved it (= departsAt otherwise). */
  scheduledAt: number | null;
  arrivesAt: number | null;
  holding: boolean;
  holdSince: number | null;
  /** Docked past departsAt: a live dock nobody cast off, or a person at the
   *  helm who let the departure pass. */
  overdue: boolean;
  /** This stay is passed without docking (skip, or a hold that ended
   *  unwatched, or ⛔ a stop found gone earlier in the run). */
  skipped: boolean;
  /** ⛔ Design §4: passed because its berth was found GONE at an earlier
   *  visit this run (a keeper's gone skip there): only a hand edit brings a
   *  stop back, so the ferry passes it at every later visit. */
  gone: boolean;
  /** ⛔ The stops found gone before this stay (by index, ascending): the
   *  helm flags them, and the boards say which one blocks a route. */
  goneStops: readonly number[];
  /** When the robot captain takes the helm from the person (null: no takeover
   *  due at this stay). */
  takeoverAt: number | null;
  /** Who flies leg legSeq (at `now`: before a takeover, the person). */
  pilot: RoutePilot;
  /** Fuel aboard by the route's accounting (after the leg's burn in flight). */
  fuel: number;
  paused: boolean;
  /** STOP was pressed: the route ends at stopIndex, or the next stop. */
  stopping: boolean;
  /** The route has ended here, pinned docked: STOP, out of fuel, or ⛔
   *  `blocked` (fewer than two of its stops are left to dock at: it ends at
   *  the next one that is, design §4, until someone presses STOP). */
  ended: 'stop' | 'fuel' | 'blocked' | null;
}

/** What a walk remembers at the start of a stay. */
interface StayCursor {
  legSeq: number;
  /** When the ship reached this stay; null at the anchor's stay. */
  arrival: number | null;
  /** Fuel on arriving (after the refill), before this stay's own entries. */
  fuel: number;
  /** Pilot entering this stay, before this stay's own entries. */
  pilot: RoutePilot;
}

/** Everything a walk needs that depends only on the inputs (not `now`). */
interface Prepared {
  legs: Legs;
  byStay: Map<number, StayEntries>;
  anchor: TimedCheckpoint;
  /** The pause that pauses the route, if its newest stay decision is one. */
  pause: PauseCheckpoint | null;
  fuelSources: Array<StartCheckpoint | FuelCheckpoint>;
  /** ⛽ The stay of the newest REFUEL (−1: none). The route never ends for
   *  fuel before it: that REFUEL proves the ferry flew on to it (the older
   *  REFUELs that carried it there may be pruned). */
  lastFuelStay: number;
  /** ⛔ Each stop found gone this run, by the first stay that found it. */
  goneAt: Map<number, number>;
}

/**
 * A walk's memory between calls: pass the same object (with the same route,
 * checkpoints and capacity objects) and the timetable walks on from where it
 * stopped instead of from the anchor. Opaque; create with
 * createRouteWalkCache.
 */
export interface RouteWalkCache {
  route?: ShipRoute;
  checkpoints?: readonly RouteCheckpoint[];
  capacity?: number;
  validated?: ValidatedCheckpoints;
  validatedAt?: number;
  prepared?: Prepared | null;
  cursor?: StayCursor & { now: number };
}

export function createRouteWalkCache(): RouteWalkCache {
  return {};
}

/** Is a route running (START pressed, not yet finished)? */
export function isRouteRunning(route: ShipRoute | null | undefined): route is ShipRoute & { startedAt: number } {
  return !!route && route.startedAt !== undefined;
}

function prepare(route: ShipRoute, v: ValidatedCheckpoints): Prepared | null {
  if (!v.anchor) return null;
  const byStay = new Map<number, StayEntries>();
  const lists = new Map<number, RouteCheckpoint[]>();
  for (const e of v.entries) {
    const l = lists.get(e.legSeq);
    if (l) l.push(e);
    else lists.set(e.legSeq, [e]);
  }
  for (const [k, l] of lists) byStay.set(k, groupStay(l));
  // Paused when the newest stay that decides anything decides a pause.
  let pause: PauseCheckpoint | null = null;
  for (const k of [...byStay.keys()].sort((a, b) => b - a)) {
    const d = decideStay(byStay.get(k));
    if (d.kind === 'none') continue;
    if (d.kind === 'paused') pause = d.pause;
    break;
  }
  const legs = new Legs(route);
  const goneAt = new Map<number, number>();
  for (const e of v.entries) {
    if (!isGoneSkip(e)) continue;
    const stop = legs.stopAt(e.legSeq);
    goneAt.set(stop, Math.min(goneAt.get(stop) ?? Number.POSITIVE_INFINITY, e.legSeq));
  }
  return {
    legs,
    byStay,
    anchor: v.anchor,
    pause,
    fuelSources: v.entries.filter((e): e is StartCheckpoint | FuelCheckpoint => e.kind === 'start' || e.kind === 'fuel'),
    lastFuelStay: v.entries.reduce((m, e) => (e.kind === 'fuel' ? Math.max(m, e.legSeq) : m), -1),
    goneAt,
  };
}

/** ⛔ The stops found gone at a stay before `legSeq`, ascending. */
function goneBefore(p: Prepared, legSeq: number): number[] {
  const out: number[] = [];
  for (const [stop, at] of p.goneAt) if (at < legSeq) out.push(stop);
  return out.sort((a, b) => a - b);
}

/** The pilot an entry names (or stamps): a go is a person's DEPART. */
function pilotOf(e: RouteCheckpoint): RoutePilot | null {
  switch (e.kind) {
    case 'start':
    case 'helm':
      return e.pilot;
    case 'dock':
    case 'skip':
      return e.pilot ?? null;
    case 'go':
      return 'person';
    default:
      return null;
  }
}

/** Apply one stay's pilot entries in `at` order, the newest word deciding: a
 *  keeper's restart or skip stamps the pilot it derived, so one written after
 *  a TAKE or KEEP (once the robot captain took over, say) is the newer word
 *  and stands. At the same `at` a helm entry beats a stamp (then go, skip,
 *  dock, start: the array order, kept by the stable sort). */
function pilotAfterStay(pilot: RoutePilot, s: StayEntries | undefined): RoutePilot {
  if (!s) return pilot;
  const words: RouteCheckpoint[] = [s.start, s.dock, s.skip, s.go, s.helm]
    .filter(present)
    .filter((e) => pilotOf(e) !== null)
    .sort((a, b) => a.at - b.at);
  let p = pilot;
  for (const e of words) p = pilotOf(e)!;
  return p;
}

/** A robot pilot needs a robot captain on the route. */
function allowedPilot(route: ShipRoute, p: RoutePilot): RoutePilot {
  return p === 'robot' && !route.robotDockId ? 'person' : p;
}

/** Fuel after one leg's burn and arrival at `to` (the home refill). The
 *  boards project later calls with it (departuresBoard.nextArrivalHere). */
export function arriveWith(route: ShipRoute, fuel: number, cost: number, to: number, capacity: number): number {
  let v = clampFuelToCapacity(fuel - cost, capacity);
  if (to === 0 && route.homeRefuel) v = clampFuelToCapacity(capacity, capacity);
  return v;
}

/** The cursor at the anchor's stay: fuel and pilot carried in from earlier. */
function anchorCursor(route: ShipRoute, p: Prepared, capacity: number): StayCursor {
  const a = p.anchor.legSeq;
  // Pilot: the last source before the anchor's stay.
  let pilot: RoutePilot = route.robotDockId ? 'robot' : 'person';
  const before = [...p.byStay.keys()].filter((k) => k < a).sort((x, y) => x - y);
  for (const k of before) pilot = pilotAfterStay(pilot, p.byStay.get(k));
  // Fuel: the newest source before the anchor's stay, flown forward to it.
  const src = newestOf(p.fuelSources.filter((e) => e.legSeq < a));
  let fuel: number;
  if (!src) {
    // No source before the anchor's stay: START's own level applies at stay
    // 0; past it the record is damaged, and the ferry is taken as full.
    fuel = clampFuelToCapacity(capacity, capacity);
  } else {
    fuel = clampFuelToCapacity(src.fuel, capacity);
    let j = src.legSeq;
    // ⏱️ The last arrival home before the anchor fills the tanks whatever
    // they held: fly on from there (at most one cycle back).
    if (route.homeRefuel) {
      const floor = Math.max(src.legSeq, a - routeCycleLength(route.stops.length, route.shape));
      for (let h = a - 1; h >= floor; h--) {
        if (p.legs.stopAt(h + 1) === 0 && p.legs.leg(h)) {
          fuel = clampFuelToCapacity(capacity, capacity);
          j = h + 1;
          break;
        }
      }
    }
    for (; j < a; j++) {
      const leg = p.legs.leg(j);
      if (!leg) break;
      fuel = arriveWith(route, fuel, leg.fuelCost, leg.to, capacity);
      // Empty with no refill ahead: it stays empty.
      if (fuel <= 0 && !route.homeRefuel) break;
    }
  }
  return { legSeq: a, arrival: null, fuel, pilot: allowedPilot(route, pilot) };
}

type Step = { done: true; flight: RouteFlight } | { done: false; next: StayCursor };

/** One stay of the walk: the flight when `now` falls in it, else the cursor
 *  for the next stay. */
function stepStay(
  route: ShipRoute,
  p: Prepared,
  cur: StayCursor,
  now: number,
  dockTimes: ReadonlyArray<number | null>,
  held: number | null,
  capacity: number,
): Step {
  const k = cur.legSeq;
  const legs = p.legs;
  const s = p.byStay.get(k);
  const stop = legs.stopAt(k);
  const next = legs.stopAt(k + 1);
  const leg = legs.pair(stop, next);
  // ⛔ Stops found gone earlier in the run (design §4).
  const goneStops = goneBefore(p, k);
  const passGone = goneStops.includes(stop);
  const dockable = route.stops.length - goneStops.length;

  // This stay's REFUEL (or START) sets the level; its helm entries the pilot.
  let fuel = cur.fuel;
  const fuelSrc = [s?.start, s?.fuel].filter((e): e is StartCheckpoint | FuelCheckpoint => e !== undefined)
    .reduce<StartCheckpoint | FuelCheckpoint | null>((best, e) => (!best || newer(e, best) ? e : best), null);
  if (fuelSrc) fuel = fuelSrc.fuel;
  fuel = clampFuelToCapacity(fuel, capacity);
  const pilot = allowedPilot(route, pilotAfterStay(cur.pilot, s));

  const base = {
    legSeq: k,
    stopIndex: stop,
    nextStopIndex: next,
    stopping: route.stoppedAt !== undefined,
    goneStops,
  };
  const docked = (o: Partial<RouteFlight>): RouteFlight => ({
    status: 'docked',
    locationId: route.stops[stop].stationId,
    ...base,
    stayStart: cur.arrival,
    departsAt: null,
    scheduledAt: null,
    arrivesAt: null,
    holding: false,
    holdSince: null,
    overdue: false,
    skipped: false,
    gone: false,
    takeoverAt: null,
    pilot,
    fuel,
    paused: false,
    ended: null,
    ...o,
  });

  const decision = decideStay(s);
  if (decision.kind === 'paused') return { done: true, flight: docked({ paused: true }) };
  if (!leg) return { done: true, flight: docked({}) };

  let stayStart = cur.arrival;
  let depart: number | null = null;
  let arrive: number | null = null;
  let goAt: number | null = null;
  let skipped = false;
  let gone = false;
  let holding: HoldCheckpoint | null = null;
  if (decision.kind === 'hold') {
    const h = decision.hold;
    if (now <= h.seenAt + HOLD_UNWATCHED_MS) {
      holding = h;
    } else {
      // Ended unwatched: leaves undocked at the first window after it.
      const w = legs.windowAfter(k, h.seenAt + HOLD_UNWATCHED_MS);
      if (w) { depart = w.departAt; arrive = w.arriveAt; }
      skipped = true;
    }
  } else if (decision.kind === 'timed') {
    const e = decision.entry;
    depart = e.departAt;
    arrive = e.arriveAt;
    if (e.kind !== 'skip') stayStart = e.stayStart;
    if (e.kind === 'go') goAt = e.at;
    if (e.kind === 'skip') skipped = true;
  } else if (cur.arrival !== null && passGone && dockable > 0) {
    // ⛔ Found gone at an earlier visit: passed without docking, like a skip
    // written on arrival (it leaves at the first window after it).
    const w = legs.windowAfter(k, cur.arrival);
    if (w) { depart = w.departAt; arrive = w.arriveAt; }
    skipped = true;
    gone = true;
  } else if (cur.arrival !== null) {
    const w = legs.windowAfter(k, cur.arrival + legs.waitMs(k));
    if (w) { depart = w.departAt; arrive = w.arriveAt; }
  }

  // ⛔ Fewer than two stops left to dock at: the route ends at this one (the
  // first it reaches that is still there), pinned docked, until STOP (every
  // stop gone: wherever it is).
  if (passGone ? dockable === 0 : dockable < 2) {
    return { done: true, flight: docked({ stayStart, ended: route.stoppedAt !== undefined ? 'stop' : 'blocked' }) };
  }

  // A person at the helm who has not pressed DEPART: the robot captain
  // takes over 5 minutes after the departure (or the newest KEEP).
  const scheduled = depart;
  let takeoverAt: number | null = null;
  let legPilot = pilot;
  let personWaits = false;
  if (depart !== null && goAt === null && pilot === 'person') {
    if (route.robotDockId) {
      const keep = s?.helm && s.helm.pilot === 'person' ? s.helm.at : Number.NEGATIVE_INFINITY;
      takeoverAt = Math.max(depart, keep) + ROBOT_TAKEOVER_MS;
      const w = legs.windowAfter(k, takeoverAt);
      if (w) { depart = w.departAt; arrive = w.arriveAt; }
      legPilot = 'robot';
    } else {
      personWaits = true;
    }
  }
  // The moment the ship leaves this stay (in flight): unknown while holding
  // or waiting on a person with no robot captain.
  const leaves = holding || personWaits || depart === null ? null : (goAt ?? depart);

  // STOP and fuel: the route ends here, pinned docked.
  if (route.stoppedAt !== undefined && (leaves === null || route.stoppedAt < leaves - STOP_GUARD_MS)) {
    return { done: true, flight: docked({ stayStart, ended: 'stop' }) };
  }
  // ⛽ …unless a newer REFUEL further on proves the ferry flew on to it.
  if (fuel < leg.fuelCost && !(p.lastFuelStay > k)) return { done: true, flight: docked({ stayStart, ended: 'fuel' }) };

  if (holding) {
    return { done: true, flight: docked({ stayStart, holding: true, holdSince: holding.since }) };
  }
  const shownPilot = takeoverAt !== null && now >= takeoverAt ? 'robot' : pilot;
  const shownDepart = takeoverAt !== null && scheduled !== null && now < scheduled ? scheduled : depart;
  const stayed = (o: Partial<RouteFlight>) => docked({
    stayStart,
    departsAt: shownDepart,
    scheduledAt: scheduled,
    arrivesAt: arrive,
    skipped,
    gone,
    takeoverAt,
    pilot: shownPilot,
    overdue: shownDepart !== null && now >= shownDepart,
    ...o,
  });
  if (leaves === null) return { done: true, flight: stayed({}) };
  if (now < leaves) return { done: true, flight: stayed({ overdue: false }) };
  // LIVE DOCK: still docked at this stop's berth, by a dock made before this
  // leg could land anywhere else, so it has not left. 🛟 Nor has it while
  // another live pairing made by then (a guest berth, another port: A5
  // "Rights") still holds the ship, wherever it leads: it stays, DELAYED,
  // until someone with rights over that pairing lets it go.
  // 🕰️ Made by then, not before the departure: no pairing is made in flight,
  // so one stamped between the departure and the landing was made here by a
  // clock running ahead. A stamp later than now says only "by now".
  const lands = arrive ?? leaves;
  const madeHere = (t: number | null) => t !== null && Math.min(t, now) < lands;
  if (madeHere(dockTimes[stop])) return { done: true, flight: stayed({ overdue: true }) };
  if (madeHere(held)) return { done: true, flight: stayed({ overdue: true }) };

  const flying = clampFuelToCapacity(fuel - leg.fuelCost, capacity);
  if (arrive !== null && now < arrive) {
    return {
      done: true,
      flight: {
        status: 'in-flight',
        locationId: route.stops[stop].stationId,
        destinationId: route.stops[next].stationId,
        departedAt: depart!,
        etaAt: arrive,
        ...base,
        stayStart,
        departsAt: depart,
        scheduledAt: scheduled,
        arrivesAt: arrive,
        holding: false,
        holdSince: null,
        overdue: false,
        skipped,
        gone,
        takeoverAt,
        pilot: goAt !== null ? 'person' : legPilot,
        fuel: flying,
        paused: false,
        ended: null,
      },
    };
  }
  return {
    done: false,
    next: {
      legSeq: k + 1,
      arrival: arrive!,
      fuel: arriveWith(route, fuel, leg.fuelCost, next, capacity),
      pilot: goAt !== null ? 'person' : legPilot,
    },
  };
}

/**
 * Where the ferry is at `now` (A3): PR 172's FlightRecord shape plus the
 * route's figures, or null when the route is not running or no checkpoint
 * can anchor it (the caller then reads the stored flight).
 *
 * `liveDock` says whether (and since when) the ship is docked at a stop's
 * station; null when the caller can't see docks (fuel meters, forecasts).
 * `capacity` is the tanks' derived capacity. Pass one `cache` per reader to
 * walk on from the last call instead of from the anchor.
 */
export function routeFlightAt(
  route: ShipRoute | null,
  checkpoints: readonly RouteCheckpoint[],
  liveDock: LiveDockAt | null,
  now: number,
  capacity: number,
  cache?: RouteWalkCache,
): RouteFlight | null {
  if (!isRouteRunning(route) || !Number.isFinite(now)) return null;
  let v: ValidatedCheckpoints;
  let p: Prepared | null;
  const same = cache !== undefined && cache.route === route && cache.checkpoints === checkpoints
    && cache.capacity === capacity && cache.validated !== undefined && cache.validatedAt !== undefined
    && now >= cache.validatedAt && now < cache.validated.recheckAt;
  if (same) {
    v = cache!.validated!;
    p = cache!.prepared ?? null;
  } else {
    v = validateCheckpoints(route, checkpoints, now);
    p = prepare(route, v);
    if (cache) {
      cache.route = route;
      cache.checkpoints = checkpoints;
      cache.capacity = capacity;
      cache.validated = v;
      cache.validatedAt = now;
      cache.prepared = p;
      cache.cursor = undefined;
    }
  }
  if (!p) return null;

  if (p.pause) {
    const k = p.pause.legSeq;
    const stop = p.legs.stopAt(k);
    const cur = anchorCursor(route, p, capacity);
    return {
      status: 'docked',
      locationId: route.stops[stop].stationId,
      legSeq: k,
      stopIndex: stop,
      nextStopIndex: p.legs.stopAt(k + 1),
      stayStart: null,
      departsAt: null,
      scheduledAt: null,
      arrivesAt: null,
      holding: false,
      holdSince: null,
      overdue: false,
      skipped: false,
      gone: false,
      goneStops: goneBefore(p, k),
      takeoverAt: null,
      pilot: cur.pilot,
      fuel: cur.fuel,
      paused: true,
      stopping: route.stoppedAt !== undefined,
      ended: null,
    };
  }

  const dockTimes = route.stops.map((stop, i) => {
    const t = liveDock ? liveDock(stop, i) : null;
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  });
  const heldRaw = liveDock?.held;
  const held = typeof heldRaw === 'number' && Number.isFinite(heldRaw) ? heldRaw : null;
  let cur: StayCursor;
  const saved = cache?.cursor;
  if (same && saved && now >= saved.now
    && [...dockTimes, held].every((t) => t === null || saved.arrival === null || t >= saved.arrival)) {
    cur = saved;
  } else {
    cur = anchorCursor(route, p, capacity);
  }
  for (let steps = 0; steps <= MAX_WALK_STAYS; steps++) {
    const step = stepStay(route, p, cur, now, dockTimes, held, capacity);
    if (step.done) {
      if (cache) cache.cursor = { ...cur, now };
      return step.flight;
    }
    cur = step.next;
  }
  return null;
}

// ── The flight every existing reader follows (A4) ───────────────────────────
//
// PR 172's readers (the helm, the holotable, the dock gates, the room-station
// resolver) each read ONE flight record. While a route runs unpaused that is
// the timetable's flight, which moves with the clock and is never written;
// otherwise (no route, a paused one, or one no checkpoint anchors) it is the
// stored `flight`. shipRoute.readResolvedFlight hands them the right one.
// The stored record only catches up when a helm-gated game copies the
// timetable back (routeSettleAction): after STOP, and when a person's route
// DEPART wrote `in-flight` that the timetable has since landed.

/** A derived flight as PR 172's plain FlightRecord: the route's own figures
 *  dropped, and its copied station ids read through `alias` (the reader's
 *  localStationId: ids are kept per install). */
export function routeFlightRecord(f: RouteFlight, alias: (id: string) => string = (id) => id): FlightRecord {
  const out: FlightRecord = { status: f.status, locationId: alias(f.locationId) };
  if (f.status === 'in-flight') {
    if (f.destinationId !== undefined) out.destinationId = alias(f.destinationId);
    if (f.departedAt !== undefined) out.departedAt = f.departedAt;
    if (f.etaAt !== undefined) out.etaAt = f.etaAt;
  }
  return out;
}

/** Does the timetable rule the ship's flight: a route running, anchored and
 *  not paused? */
export function routeRulesFlight(f: RouteFlight | null): f is RouteFlight {
  return f !== null && !f.paused;
}

/** A4: the flight existing readers follow. The timetable's while the route
 *  runs unpaused (`route` is routeFlightAt's answer), else the stored one. */
export function resolvedFlight(
  stored: FlightRecord,
  route: RouteFlight | null,
  alias?: (id: string) => string,
): FlightRecord {
  return routeRulesFlight(route) ? routeFlightRecord(route, alias) : stored;
}

/** The stay a REFUEL on a running route sets the level at: this stay, while
 *  docked (before its leg). Null in flight: the tank's stored level is the
 *  ceiling the route's meter reads down from, and the meter must read 0 when
 *  the level is written (shipRoute.ts's header); in flight it reads the leg's
 *  burn, so REFUEL waits for the next stop. */
export function routeRefuelStay(f: RouteFlight): number | null {
  return f.status === 'docked' ? f.legSeq : null;
}

/** A copy-back of the timetable into the stored records (routeSettleAction). */
export type RouteSettleAction =
  | { kind: 'finish'; writes: FlightRecord[]; fuel: number }
  | { kind: 'follow'; writes: FlightRecord[] };

/**
 * What a helm-gated game writes to bring the STORED flight in line with the
 * timetable (A4), or null when nothing is due:
 *
 *  - `finish`: STOP was pressed and the ship is pinned docked at its end
 *    stop (or the fuel ran out first), and the dock there has answered (the
 *    keeper's call; `dockAnswered`). The route clears, and the derived flight
 *    and fuel are copied into `flight` and `fuel`, through `redocking` when
 *    the stored record is `in-flight`.
 *  - `follow`: the route runs on, the stored record is in transit (a
 *    person's route DEPART wrote `in-flight`, as PR 172's DEPART does, so
 *    older clients follow the ferry) and the timetable has since docked the
 *    ship: walk it to `docked` there, with no dock of its own.
 *
 * Robot legs never write the stored flight, so a stored `docked` record is
 * left alone mid-route whatever the timetable says. Pure.
 */
export function routeSettleAction(
  stored: FlightRecord,
  route: RouteFlight | null,
  o: { dockAnswered: boolean; alias?: (id: string) => string },
): RouteSettleAction | null {
  if (!routeRulesFlight(route)) return null;
  const target = routeFlightRecord(route, o.alias);
  if (route.stopping && route.ended !== null && route.status === 'docked' && o.dockAnswered) {
    const writes = flightWritePath(stored, target);
    // No legal path (never from a stored record the route can leave): keep
    // the run on rather than clear it and strand the stored flight.
    return writes.length > 0 ? { kind: 'finish', writes, fuel: route.fuel } : null;
  }
  // (Also while the end stop's dock is still to answer: older clients should
  // not see a stored flight still in transit.)
  if (route.status === 'docked' && stored.status !== 'docked') {
    const writes = flightWritePath(stored, target);
    return writes.length > 0 ? { kind: 'follow', writes } : null;
  }
  return null;
}
