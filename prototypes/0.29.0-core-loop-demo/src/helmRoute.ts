/**
 * 🚏🧑‍✈️ Helm route — the ROUTE panel at the helm and a person flying the
 * route (robot pilot routes, design §2b and §5; build notes A2, A4 and the
 * gate parts of A9; owner decisions 2026-09-27: the schedule belongs to the
 * SHIP and is set at the helm, a person can take the robot's place with
 * handover both ways, numbered gates with gate change, the station decides
 * who may dock at each gate).
 *
 * The route is stored in the ship's own room doc (shipRoute.ts) and the
 * timetable works out where the ferry is (pilotRoute.ts); a keeper docks and
 * casts it off (routeKeeper.ts). This file is what the HELM adds on top:
 *
 * ─── The ROUTE editor (§5) ───────────────────────────────────────────────────
 *
 *   Stops come from the stations around the ship's planet that have a known
 *   berth door (routeStopCandidates): each gate the station lists and admits
 *   this ship (dockRules.gateAdmits: never a closed gate, never one reserved
 *   for another ship; a granted-captains gate is offered as "needs a granted
 *   rider aboard", A9.5), then the berth the ship remembers there, then the
 *   dock it is in now (A1). Each stop pins its gate or allows any open gate
 *   (choice 9: gate change); has a minimum wait of 30 s to 10 min; and the
 *   editor shows each leg's flight time, window spacing and fuel, priced
 *   exactly as the timetable prices them (pilotRoute.stopPairWindow). A
 *   route is refused when two neighbours are the same station, orbit
 *   different planets, share an orbit, or a leg (or, with the home refill,
 *   a round trip) burns more than the tanks hold (checkRouteDraft).
 *
 *   The editor works on a local DRAFT (RouteDraft): a route needs two stops
 *   before it can be saved, and a peer's save must not be overwritten by a
 *   half-typed one. SAVE writes it (shipRoute.writeShipRoute); START saves
 *   and starts it in one transaction (startRouteFromHelm). A running route is
 *   locked: STOP it to edit.
 *
 * ─── START and STOP ──────────────────────────────────────────────────────────
 *
 *   START only while docked at one of the route's stops (routeStartRefusal):
 *   the stops' orbits and berths are copied fresh from this game's station
 *   list (refreshDraftStops), the route is saved with them, and the `start`
 *   checkpoint is written with the fuel ceiling first (shipRoute.ts).
 *   Choice 8 (a): with nobody aboard nothing docks or undocks, so START says
 *   "Stay aboard until the ferry casts off."
 *   STOP ends the route at the current stop, or the next one while in flight
 *   (A3 rule 6); main.ts's watch copies the timetable back once the ship is
 *   there. A paused route (or one no checkpoint anchors) has nothing to copy
 *   back: its STOP finishes it at once (stopRouteFromHelm).
 *
 * ─── A person at the helm (§2b) ──────────────────────────────────────────────
 *
 *   ROUTE DEPART  the leg's own DEPART for a person pilot: opens 30 s before
 *                 the launch window ("BOARDING · DEPART OPENS 14:05:17"
 *                 until then). Writes `go` (the first window after
 *                 max(now, stay start + minimum wait): pressed late, the
 *                 next window) and PR 172's own `in-flight` record, so older
 *                 clients follow, in one transaction. The fuel is the
 *                 route's meter's, so nothing is debited here.
 *   OFF ROUTE     DEPART for anywhere else PAUSES the route (a `pause`
 *                 checkpoint), copies the timetable's stop and fuel into the
 *                 stored records, then runs PR 172's DEPART — one
 *                 transaction. "ROUTE PAUSED · off route. Dock at a route stop
 *                 to RESUME."
 *   RESUME        docked at a route stop: a fresh fuel ceiling FIRST (the
 *                 route meter still reads 0 while paused), then a RESUME
 *                 `dock` (the first later visit to that stop, a fresh minimum
 *                 wait) and a `fuel` entry with the level aboard.
 *   TAKE THE HELM / HAND TO ROBOT / KEEP THE HELM
 *                 a `helm` checkpoint. It takes effect at the next departure:
 *                 docked outside the guard band it is keyed to this stay;
 *                 in flight, or within 10 s of the departure, to the next
 *                 one (helmEntryStay), so a leg in flight finishes as it was.
 *                 HAND TO ROBOT at a stay that is not holding re-times it (the
 *                 robot leaves at the first window after max(now, stay start
 *                 + minimum wait)). A person who lets the departure pass sees
 *                 "Robot takes the helm at 14:10:47" (the timetable's
 *                 5-minute default); KEEP THE HELM restarts the 5 minutes.
 *   SKIP STOP     at a stop, outside the guard band: a `skip` checkpoint —
 *                 the ferry leaves at the next window without waiting or
 *                 docking (holding for a berth: it stops holding).
 *   REFUEL        on a running route: shipRoute.refuelShipRoute (its `fuel`
 *                 checkpoint first, then writeFuelLevel).
 *
 *   Every write here is the helm gate's (choice 7: today's owner-equivalent
 *   gate, checked at the caller, devices.ts createHelmUI). Riders' games
 *   still dock and cast off on their own (the keeper).
 *
 * Pure helpers (words, candidates, the draft, checks, what the helm offers)
 * plus thin writers over the ship doc at the end. Pinned by
 * helmRoute.test.ts.
 */

import { gateAdmits } from './dockRules';
import type { DoorWall } from './doorLayoutDoc';
import {
  GUARD_BAND_MS,
  dockCheckpoint,
  fuelCheckpoint,
  goCheckpoint,
  helmCheckpoint,
  isRouteRunning,
  nextStayAtStop,
  pauseCheckpoint,
  routeLegPairs,
  routeRulesFlight,
  skipCheckpoint,
  stopAt,
  stopPairWindow,
} from './pilotRoute';
import type { LegWindow, RouteFlight } from './pilotRoute';
import {
  clampFuelToCapacity,
  flightArrived,
  flightProgress,
  flightWritePath,
  readFlightRecord,
  readFuelLevel,
  shipDocHandle,
  writeFlightRecord,
  writeFuelLevel,
} from './shipDoc';
import type { FlightRecord, FlightStatus } from './shipDoc';
import {
  MAX_ROUTE_STOPS,
  MAX_WAIT_SECS,
  MIN_ROUTE_STOPS,
  MIN_WAIT_SECS,
  checkpointFromWire,
  checkpointToWire,
  finishShipRoute,
  readRouteCheckpoints,
  readRouteFlight,
  readShipRoute,
  routeBerthFromWire,
  startShipRoute,
  stopShipRoute,
  writeRouteCheckpoint,
  writeShipRoute,
} from './shipRoute';
import type {
  GoCheckpoint,
  HelmCheckpoint,
  RouteBerth,
  RouteCheckpoint,
  RoutePilot,
  RouteShape,
  RouteStop,
  ShipRoute,
} from './shipRoute';
import { adriftAt, localStationId } from './stationDirectory';
import { listStations, planetById, stationInTransit } from './stations';
import type { StationBerthRecord, StationMove } from './stations';

// ── Constants (§2b, §5) ──────────────────────────────────────────────────────

/** A person's route DEPART opens this long before the launch window:
 *  pressing earlier would only end boarding for nothing (§2b). */
export const ROUTE_DEPART_OPENS_MS = 30_000;
/** A new stop's minimum wait. */
export const DEFAULT_WAIT_SECS = 60;
/** The minimum waits the editor offers (30 s to 10 minutes). */
export const ROUTE_WAIT_CHOICES: readonly number[] = [30, 45, 60, 90, 120, 180, 240, 300, 420, 600];

/** 🤖 The robot routine that makes a charging dock's robot eligible to be
 *  the ship's robot captain ("🚀 Ship pilot", robotDoc.ts `pilot`; who may be
 *  named, and what the captain does, is shipPilot.ts). */
export const SHIP_PILOT_ROUTINE = 'pilot';

/** Is `routine` the Ship pilot routine? (devices.ts robotCaptainEligible
 *  reads each dock's routine through this.) */
export function isShipPilotRoutine(routine: string | null | undefined): boolean {
  return routine === SHIP_PILOT_ROUTINE;
}

// ── Words and clocks ─────────────────────────────────────────────────────────

/** HH:MM:SS in the player's own local time, rounded DOWN to the second
 *  (boards and the helm show the exact second of the stored window, §5). */
export function formatClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--:--';
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** A leg's flight time or window spacing: "55 s", "5.4 min", "15 min",
 *  "9.8 h", "3 d". */
export function formatRouteSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const min = s / 60;
  if (min < 10) return `${min.toFixed(1)} min`;
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} d`;
}

/** 🚏 The helm's in-flight figures at `now`: which panel shows (holding for
 *  the window, flying, arrived) and the numbers that move with the clock.
 *  The helm tick writes the numbers into the open panel in place and redraws
 *  only when `phase` flips, so the panel's buttons (TAKE THE HELM, HAND TO
 *  ROBOT, STOP ROUTE) are not swapped out from under a click four times a
 *  second. */
export function helmFlightFigures(
  f: FlightRecord,
  now: number,
): { phase: 'hold' | 'fly' | 'arrived'; wait: number; remaining: number; pct: number } {
  const remaining = Math.ceil((f.etaAt !== undefined ? Math.max(0, f.etaAt - now) : 0) / 1000);
  if (f.departedAt !== undefined && now < f.departedAt) {
    return { phase: 'hold', wait: Math.ceil((f.departedAt - now) / 1000), remaining, pct: 0 };
  }
  if (flightArrived(f, now)) return { phase: 'arrived', wait: 0, remaining, pct: 100 };
  return { phase: 'fly', wait: 0, remaining, pct: Math.round(flightProgress(f, now) * 100) };
}

/** A minimum wait: "30 s", "1 min", "1.5 min", "10 min". */
export function formatWait(secs: number): string {
  if (secs < 60) return `${Math.round(secs)} s`;
  return `${Number((secs / 60).toFixed(1))} min`;
}

/** One full cycle of the shape from the first stop and back: "A→B→A" for a
 *  two-stop ferry either way, "A→B→C→A" a loop, "A→B→C→B→A" back and forth. */
export function routePathLabel(stops: ReadonlyArray<{ name: string }>, shape: RouteShape): string {
  const n = stops.length;
  if (n === 0) return '—';
  if (n === 1) return stops[0].name;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (shape === 'loop') order.push(0);
  else for (let i = n - 2; i >= 0; i--) order.push(i);
  return order.map((i) => stops[i].name).join('→');
}

// ── The stops the editor offers (A1, A9.5, A9.6) ────────────────────────────

/** A station as the editor reads it (stations.ts StationRecord). */
export interface RouteStationLike {
  id: string;
  name: string;
  planetId: string;
  orbitSlot: number;
  welcomeRoomId: string;
  berthDoor?: string;
  berths?: readonly StationBerthRecord[];
  /** 🚚 PR 174's move, if any: between its burns the station orbits
   *  nowhere (still listed where it left, a slot another may hold now). */
  move?: StationMove;
}

/** Where a berth choice came from: a gate the station lists (with or
 *  without a number), the berth the ship remembers there, or the dock the
 *  ship is in right now. */
export type RouteGateSource = 'gate' | 'berth' | 'memory' | 'dock';

/** One berth the captain may pick for a stop. */
export interface RouteGateChoice {
  /** The route's copy of it (never a pass). */
  berth: Omit<RouteBerth, 'anyGate'>;
  source: RouteGateSource;
  /** 'reserved': reserved for THIS ship; 'pass': the station's granted
   *  captains only, so a rider whose captain was granted there must be
   *  aboard to dock (A9.5). Absent: open. */
  access?: 'reserved' | 'pass';
  /** The station's atlas shows a ship docked there now. */
  occupied?: boolean;
  /** This game holds a pass for the berth's room (it can dock there itself;
   *  choice 6: the editor warns otherwise). */
  held: boolean;
}

/** A station a stop can be added for, with the berths this ship may use. */
export interface RouteStopCandidate {
  stationId: string;
  name: string;
  planetId: string;
  orbitSlot: number;
  /** Empty when no berth door is known there (fly there once and dock by
   *  hand: the ship then remembers the berth). */
  choices: RouteGateChoice[];
}

/** A remembered or live berth: the room and door (shipDoc berth memory,
 *  a docked port's far end). */
export interface KnownBerth {
  roomId: string;
  farDoor?: string;
  farWall?: DoorWall;
  farLateral?: number;
}

export interface RouteCandidateInput {
  /** The stations around the ship's planet (stations.stationsAroundPlanet),
   *  without the ship's own one-module station. */
  stations: readonly RouteStationLike[];
  planetId: string;
  /** The ship's room: a gate reserved for it is offered, one reserved for
   *  another ship is not. */
  shipRoomId: string;
  /** The berth the ship remembers at a station (shipDoc.readStationBerth). */
  remembered?: (stationId: string) => KnownBerth | null;
  /** The dock the ship is in right now, and the station it leads into. */
  liveDock?: (KnownBerth & { stationId: string }) | null;
  /** Does this game hold a pass for the room? */
  holdsPass?: (roomId: string) => boolean;
}

function berthKey(roomId: string, farDoor: string): string {
  return `${roomId}\u0000${farDoor}`;
}

/** A savable berth copy, or null (the route's own guard decides). */
function cleanChoiceBerth(b: KnownBerth & { gate?: number }): Omit<RouteBerth, 'anyGate'> | null {
  if (!b.farDoor) return null;
  const clean = routeBerthFromWire({
    roomId: b.roomId,
    farDoor: b.farDoor,
    ...(b.farWall !== undefined ? { farWall: b.farWall } : {}),
    ...(b.farLateral !== undefined ? { farLateral: b.farLateral } : {}),
    ...(b.gate !== undefined ? { gate: b.gate } : {}),
  });
  if (!clean) return null;
  const { anyGate: _any, ...rest } = clean;
  return rest;
}

/**
 * The stations a stop can be added for, in orbit order, each with the
 * berths this ship may use there, in PR 177's arrival order (its own reserved
 * gate, open gates, granted-captains gates), then the berth it remembers,
 * then the dock it is in now (A1: berthDoor, else memory, else the live
 * dock). A gate the station closed or reserved for another ship is never
 * offered, and neither is a memory or dock that points at one. 🧭 At the
 * station the ship is docked at, the berth it is docked in comes FIRST (the
 * editor's default: START there is no gate change), and it is not "taken
 * now" (the ship taking it is this one). Pure.
 */
export function routeStopCandidates(input: RouteCandidateInput): RouteStopCandidate[] {
  const holds = input.holdsPass ?? (() => true);
  const out: RouteStopCandidate[] = [];
  const stations = input.stations
    .filter((s) => s.planetId === input.planetId)
    .slice()
    .sort((a, b) => a.orbitSlot - b.orbitSlot);
  for (const st of stations) {
    const listed: Array<{ choice: RouteGateChoice; rank: number; i: number }> = [];
    const refused = new Set<string>();
    const seen = new Set<string>();
    (st.berths ?? []).forEach((b, i) => {
      const key = berthKey(b.roomId, b.doorId);
      const access = b.access ? { access: b.access, ...(b.reservedFor ? { reservedFor: b.reservedFor } : {}) } : undefined;
      // A granted-captains gate is decided by the docking game's key, not the
      // ship: offered, and flagged (the keeper moves on when it refuses).
      if (b.access !== 'pass' && !gateAdmits(access, input.shipRoomId)) { refused.add(key); return; }
      const berth = cleanChoiceBerth({ roomId: b.roomId, farDoor: b.doorId, ...(b.gate !== undefined ? { gate: b.gate } : {}) });
      if (!berth || seen.has(key)) return;
      seen.add(key);
      const own = b.access === 'reserved';
      listed.push({
        choice: {
          berth,
          source: b.gate !== undefined ? 'gate' : 'berth',
          ...(own ? { access: 'reserved' as const } : b.access === 'pass' ? { access: 'pass' as const } : {}),
          ...(b.occupied ? { occupied: true } : {}),
          held: holds(b.roomId),
        },
        rank: own ? 0 : b.access === 'pass' ? 2 : 1,
        i,
      });
    });
    const choices = listed.sort((x, y) => x.rank - y.rank || x.i - y.i).map((x) => x.choice);
    const extra = (k: KnownBerth | null | undefined, source: RouteGateSource) => {
      if (!k?.farDoor) return;
      const key = berthKey(k.roomId, k.farDoor);
      if (refused.has(key) || seen.has(key)) return;
      const berth = cleanChoiceBerth(k);
      if (!berth) return;
      seen.add(key);
      choices.push({ berth, source, held: holds(k.roomId) });
    };
    extra(input.remembered?.(st.id), 'memory');
    const live = input.liveDock && input.liveDock.stationId === st.id ? input.liveDock : null;
    if (live) {
      extra(live, 'dock');
      const i = live.farDoor ? choiceIndexFor(choices, { roomId: live.roomId, farDoor: live.farDoor }) : -1;
      if (i >= 0) {
        const { occupied: _taken, ...mine } = choices[i];
        choices.splice(i, 1);
        choices.unshift(mine);
      }
    }
    out.push({ stationId: st.id, name: st.name, planetId: st.planetId, orbitSlot: st.orbitSlot, choices });
  }
  return out;
}

/** The choice that is this berth (same room and door), or -1. */
export function choiceIndexFor(choices: readonly RouteGateChoice[], berth: Pick<RouteBerth, 'roomId' | 'farDoor'>): number {
  return choices.findIndex((c) => c.berth.roomId === berth.roomId && c.berth.farDoor === berth.farDoor);
}

/** A choice's words in the gate picker. */
export function describeGateChoice(c: RouteGateChoice): string {
  const name = c.berth.gate !== undefined
    ? `Gate ${c.berth.gate}`
    : c.source === 'memory' ? 'Remembered berth'
      : c.source === 'dock' ? 'The berth docked at now'
        : 'Berth door';
  const notes: string[] = [];
  if (c.access === 'reserved') notes.push('reserved for this ship');
  if (c.access === 'pass') notes.push('needs a granted rider aboard');
  if (c.occupied) notes.push('taken now');
  if (!c.held) notes.push('no pass');
  return notes.length ? `${name} · ${notes.join(' · ')}` : name;
}

// ── The draft ────────────────────────────────────────────────────────────────

/** The route the editor is building (a local draft, never synced). */
export interface RouteDraft {
  stops: RouteStop[];
  shape: RouteShape;
  /** The ship's dock port the ferry docks with at every stop. */
  shipPort: string | null;
  /** The robot captain's charging dock; null = people only. */
  robotDockId: string | null;
  /** Choice 4 (b): full tanks on each arrival at the first stop. */
  homeRefuel: boolean;
}

function cloneStop(s: RouteStop): RouteStop {
  return { ...s, berth: { ...s.berth } };
}

/** A draft of the saved route (or an empty one): the editor's start. A new
 *  route is a back-and-forth with the home refill (the owner's ferry). */
export function draftFromRoute(route: ShipRoute | null, shipPort: string | null): RouteDraft {
  if (!route) return { stops: [], shape: 'backAndForth', shipPort, robotDockId: null, homeRefuel: true };
  return {
    stops: route.stops.map(cloneStop),
    shape: route.shape,
    shipPort: route.shipPort,
    robotDockId: route.robotDockId ?? null,
    homeRefuel: route.homeRefuel ?? true,
  };
}

/** The draft as a route to save (no run fields), or null with no port. */
export function routeFromDraft(d: RouteDraft): ShipRoute | null {
  if (!d.shipPort) return null;
  return {
    stops: d.stops.map(cloneStop),
    shape: d.shape,
    shipPort: d.shipPort,
    ...(d.robotDockId ? { robotDockId: d.robotDockId } : {}),
    homeRefuel: d.homeRefuel,
  };
}

/** Add a stop for `cand` at its `choice`-th berth (default the first): any
 *  open gate allowed, the default minimum wait. Unchanged when the route is
 *  full or the station has no known berth. */
export function addDraftStop(d: RouteDraft, cand: RouteStopCandidate, choice = 0): RouteDraft {
  const c = cand.choices[choice];
  if (!c || d.stops.length >= MAX_ROUTE_STOPS) return d;
  const stop: RouteStop = {
    stationId: cand.stationId,
    name: cand.name,
    planetId: cand.planetId,
    orbitSlot: cand.orbitSlot,
    berth: { ...c.berth, anyGate: true },
    waitSecs: DEFAULT_WAIT_SECS,
  };
  return { ...d, stops: [...d.stops.map(cloneStop), stop] };
}

export function removeDraftStop(d: RouteDraft, index: number): RouteDraft {
  if (!d.stops[index]) return d;
  return { ...d, stops: d.stops.filter((_, i) => i !== index).map(cloneStop) };
}

/** Move stop `index` one place up (−1) or down (+1). */
export function moveDraftStop(d: RouteDraft, index: number, dir: -1 | 1): RouteDraft {
  const j = index + dir;
  if (!d.stops[index] || !d.stops[j]) return d;
  const stops = d.stops.map(cloneStop);
  [stops[index], stops[j]] = [stops[j], stops[index]];
  return { ...d, stops };
}

/** A stop's minimum wait, clamped to 30 s … 10 min, whole seconds. */
export function setDraftWait(d: RouteDraft, index: number, secs: number): RouteDraft {
  if (!d.stops[index] || !Number.isFinite(secs)) return d;
  const waitSecs = Math.min(MAX_WAIT_SECS, Math.max(MIN_WAIT_SECS, Math.round(secs)));
  return { ...d, stops: d.stops.map((s, i) => (i === index ? { ...cloneStop(s), waitSecs } : cloneStop(s))) };
}

/** A stop's berth (the gate picker), keeping its pin. */
export function setDraftBerth(d: RouteDraft, index: number, c: RouteGateChoice): RouteDraft {
  const s = d.stops[index];
  if (!s) return d;
  const berth: RouteBerth = { ...c.berth, anyGate: s.berth.anyGate };
  return { ...d, stops: d.stops.map((x, i) => (i === index ? { ...cloneStop(x), berth } : cloneStop(x))) };
}

/** Pin a stop to its gate (false), or allow any open gate (true). */
export function setDraftAnyGate(d: RouteDraft, index: number, anyGate: boolean): RouteDraft {
  const s = d.stops[index];
  if (!s) return d;
  return { ...d, stops: d.stops.map((x, i) => (i === index ? { ...cloneStop(x), berth: { ...x.berth, anyGate } } : cloneStop(x))) };
}

/**
 * Copy each stop's orbit and name afresh from this game's station list (the
 * station read as this install's id), and its gate number when the station
 * lists the same berth door with one — what START saves (A1: copied on save).
 * A stop the list no longer shows keeps the copy it has, and so does the
 * orbit of a station between planets (checkRouteDraft's `moving` refuses it).
 */
export function refreshDraftStops(
  d: RouteDraft,
  stations: readonly RouteStationLike[],
  alias: (id: string) => string = (id) => id,
  now = Date.now(),
): RouteDraft {
  const stops = d.stops.map((s) => {
    const st = stations.find((x) => x.id === alias(s.stationId)) ?? stations.find((x) => x.id === s.stationId);
    const out = cloneStop(s);
    if (!st) return out;
    out.name = st.name;
    if (stationInTransit(st, now)) return out;
    out.planetId = st.planetId;
    out.orbitSlot = st.orbitSlot;
    const listed = (st.berths ?? []).find((b) => b.roomId === s.berth.roomId && b.doorId === s.berth.farDoor);
    if (listed?.gate !== undefined) out.berth.gate = listed.gate;
    return out;
  });
  return { ...d, stops };
}

// ── Checks (§2: what the editor refuses) ─────────────────────────────────────

export type RouteProblem =
  | { kind: 'too-few-stops' }
  | { kind: 'too-many-stops' }
  | { kind: 'no-port' }
  | { kind: 'no-tank' }
  /** 🚚 The stop's station is between planets (PR 174): no ship can reach it. */
  | { kind: 'stop-moving'; stop: number }
  | { kind: 'same-station'; from: number; to: number }
  | { kind: 'other-planet'; from: number; to: number }
  | { kind: 'shared-orbit'; from: number; to: number }
  | { kind: 'leg-too-costly'; from: number; to: number; fuel: number; capacity: number }
  | { kind: 'cycle-too-costly'; fuel: number; capacity: number };

export interface RouteCheck {
  ok: boolean;
  problems: RouteProblem[];
  /** Fuel for one full cycle of the shape (every leg once), or null when a
   *  leg can't be flown. */
  cycleFuel: number | null;
}

/** Why a leg between two stops can't be flown, or null (its window). */
function legProblem(stops: readonly RouteStop[], a: number, b: number): { window: LegWindow | null; kind: 'same-station' | 'other-planet' | 'shared-orbit' | null } {
  if (stops[a].stationId === stops[b].stationId) return { window: null, kind: 'same-station' };
  if (stops[a].planetId !== stops[b].planetId) return { window: null, kind: 'other-planet' };
  const w = stopPairWindow(stops, a, b);
  return w ? { window: w, kind: null } : { window: null, kind: 'shared-orbit' };
}

/**
 * Is the draft a route that can be saved and flown: 2 to 8 stops, a dock
 * port, and every leg of its shape plannable (not the same station twice in
 * a row, one planet, no shared orbit), no leg burning more than the tanks
 * hold, and — with the home refill — no round trip either (§2 Fuel). Each
 * unordered pair is reported once. Pure.
 */
export function checkRouteDraft(
  d: RouteDraft,
  o: { capacity: number; moving?: (stationId: string) => boolean },
): RouteCheck {
  const problems: RouteProblem[] = [];
  const n = d.stops.length;
  d.stops.forEach((s, i) => {
    if (o.moving?.(s.stationId)) problems.push({ kind: 'stop-moving', stop: i });
  });
  if (n < MIN_ROUTE_STOPS) problems.push({ kind: 'too-few-stops' });
  if (n > MAX_ROUTE_STOPS) problems.push({ kind: 'too-many-stops' });
  if (!d.shipPort) problems.push({ kind: 'no-port' });
  const capacity = Number.isFinite(o.capacity) ? o.capacity : 0;
  if (capacity <= 0) problems.push({ kind: 'no-tank' });
  let cycleFuel: number | null = n >= MIN_ROUTE_STOPS ? 0 : null;
  const reported = new Set<string>();
  for (const [a, b] of routeLegPairs(n, d.shape)) {
    const pair = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const leg = legProblem(d.stops, a, b);
    if (leg.kind) {
      cycleFuel = null;
      if (!reported.has(pair)) { reported.add(pair); problems.push({ kind: leg.kind, from: a, to: b }); }
      continue;
    }
    const w = leg.window!;
    if (cycleFuel !== null) cycleFuel += w.fuelCost;
    if (capacity > 0 && w.fuelCost > capacity && !reported.has(pair)) {
      reported.add(pair);
      problems.push({ kind: 'leg-too-costly', from: a, to: b, fuel: w.fuelCost, capacity });
    }
  }
  if (d.homeRefuel && cycleFuel !== null && capacity > 0 && cycleFuel > capacity
    && !problems.some((p) => p.kind === 'leg-too-costly')) {
    problems.push({ kind: 'cycle-too-costly', fuel: cycleFuel, capacity });
  }
  return { ok: problems.length === 0, problems, cycleFuel };
}

/** The leg that leaves stop `index` along the shape as the editor lists it
 *  (a loop's last stop returns to the first; a back-and-forth's last stop
 *  turns back), with its figures or why it can't be flown; null when no leg
 *  is listed there. */
export function draftLegAfter(d: RouteDraft, index: number): { to: number; window: LegWindow | null; problem: 'same-station' | 'other-planet' | 'shared-orbit' | null } | null {
  const n = d.stops.length;
  if (n < 2 || !d.stops[index]) return null;
  const to = d.shape === 'loop' ? (index + 1) % n : index + 1;
  if (to >= n) return null;
  const leg = legProblem(d.stops, index, to);
  return { to, window: leg.window, problem: leg.kind };
}

/** A problem in the helm's words. */
export function describeRouteProblem(p: RouteProblem, stops: ReadonlyArray<{ name: string }>): string {
  const name = (i: number) => stops[i]?.name ?? `stop ${i + 1}`;
  switch (p.kind) {
    case 'too-few-stops': return 'Add at least two stops.';
    case 'too-many-stops': return `A route has at most ${MAX_ROUTE_STOPS} stops.`;
    case 'no-port': return 'Fit a dock port to this module first (door panel › +DOCK): the ferry docks with it at every stop.';
    case 'no-tank': return 'Install a fuel tank: every leg burns fuel.';
    case 'stop-moving': return `${name(p.stop)} is moving to another planet: take it off the route.`;
    case 'same-station': return `${name(p.from)} → ${name(p.to)}: the same station twice in a row.`;
    case 'other-planet': return `${name(p.from)} → ${name(p.to)}: they orbit different planets.`;
    case 'shared-orbit': return `${name(p.from)} → ${name(p.to)}: they share an orbit, so no transfer exists.`;
    case 'leg-too-costly': return `${name(p.from)} → ${name(p.to)} burns ${p.fuel} fuel; the tanks hold ${p.capacity}. Fit more fuel tanks.`;
    case 'cycle-too-costly':
      return `A round trip burns ${p.fuel} fuel; the tanks hold ${p.capacity}, and the free refill is only at ${name(0)}. Fit more fuel tanks, or drop a stop.`;
  }
}

// ── START (§5) ───────────────────────────────────────────────────────────────

/** The stop the ship is at (its station, read as this install's id), or −1.
 *  A station called at twice counts as its first stop. */
export function routeStopIndexAt(
  stops: ReadonlyArray<Pick<RouteStop, 'stationId'>>,
  stationId: string,
  alias: (id: string) => string = (id) => id,
): number {
  return stops.findIndex((s) => s.stationId === stationId || alias(s.stationId) === stationId);
}

/** RESUME's stop: of the route's stops at the ship's station, the one the
 *  route calls at soonest from stay `fromStay` on; −1 when none. */
export function resumeStopIndex(
  route: Pick<ShipRoute, 'stops' | 'shape' | 'startStop'>,
  fromStay: number,
  stationId: string,
  alias: (id: string) => string = (id) => id,
): number {
  let best = -1;
  let bestStay = Number.POSITIVE_INFINITY;
  route.stops.forEach((s, i) => {
    if (s.stationId !== stationId && alias(s.stationId) !== stationId) return;
    const k = nextStayAtStop(route, fromStay, i);
    if (k >= 0 && k < bestStay) { best = i; bestStay = k; }
  });
  return best;
}

export type RouteStartRefusal =
  | 'no-owner'
  | 'running'
  | 'not-flight-capable'
  | 'invalid'
  | 'port-missing'
  | 'robot-not-ready'
  | 'not-docked'
  | 'not-at-stop'
  | 'chained'
  | 'towing'
  | 'no-fuel';

export interface RouteStartInput {
  /** The helm gate (choice 7). */
  commander: boolean;
  running: boolean;
  flightCapable: boolean;
  flightStatus: FlightStatus;
  /** routeStopIndexAt for the ship's station, −1 when it is no stop. */
  startStop: number;
  check: RouteCheck;
  /** The draft's port is one of this module's dock ports. */
  portFitted: boolean;
  /** No robot captain named, or it may be one (its dock runs Ship pilot). */
  robotReady: boolean;
  chainedDoors: number;
  towing: boolean;
  fuel: number;
  /** The first leg's fuel from the start stop, null when unknown. */
  firstLegFuel: number | null;
}

/** Why START is refused, or null. Pure. */
export function routeStartRefusal(i: RouteStartInput): RouteStartRefusal | null {
  if (!i.commander) return 'no-owner';
  if (i.running) return 'running';
  if (!i.flightCapable) return 'not-flight-capable';
  if (!i.check.ok) return 'invalid';
  if (!i.portFitted) return 'port-missing';
  if (!i.robotReady) return 'robot-not-ready';
  if (i.flightStatus !== 'docked') return 'not-docked';
  if (i.startStop < 0) return 'not-at-stop';
  if (i.chainedDoors > 0) return 'chained';
  if (i.towing) return 'towing';
  // The home refill fills the tanks on each ARRIVAL at the first stop, not at
  // START: the start entry carries the level aboard (shipRoute.ts), so the
  // first leg flies on what is in the tanks now.
  if (i.firstLegFuel !== null && i.fuel < i.firstLegFuel) return 'no-fuel';
  return null;
}

export function describeRouteStartRefusal(r: RouteStartRefusal, o: { stops: ReadonlyArray<{ name: string }>; firstLegFuel?: number | null; fuel?: number }): string {
  switch (r) {
    case 'no-owner': return 'Only whoever may fly this ship (its owner or a shareholder) can start its route.';
    case 'running': return 'The route is running. Stop it to edit or start it again.';
    case 'not-flight-capable': return 'NOT SPACEWORTHY — mount at least one FUEL TANK, ENGINE BLOCK, and HELM CONSOLE.';
    case 'invalid': return 'Fix the route first (see above).';
    case 'port-missing': return 'The route\'s dock port is no longer fitted on this module: pick another.';
    case 'robot-not-ready': return 'The robot captain\'s dock is not running 🚀 Ship pilot: pick it at the dock\'s console, or fly with people only.';
    case 'not-docked': return 'START is offered while docked at one of the route\'s stops.';
    case 'not-at-stop': return `Dock at one of the route's stops (${o.stops.map((s) => s.name).join(', ')}) to START there.`;
    case 'chained': return 'Chained to a permanent connector — take the gangway down first (chained modules cannot fly).';
    case 'towing': return 'Towing a station — the tug stays docked until it arrives.';
    case 'no-fuel': return `Not enough fuel for the first leg (${o.firstLegFuel ?? '?'} needed, ${o.fuel ?? '?'} aboard). REFUEL first.`;
  }
}

// ── A running route: what the helm shows and offers (§2b, §5) ────────────────

/** Where the route's own DEPART stands for this stay. */
export type RouteDepartState =
  /** A person may DEPART now (the window, or the next one when late). */
  | { kind: 'open'; windowAt: number }
  /** Boarding: DEPART opens 30 s before the window. */
  | { kind: 'boarding'; opensAt: number; windowAt: number }
  /** The robot captain flies this leg. */
  | { kind: 'robot'; departsAt: number | null }
  | { kind: 'holding' }
  | { kind: 'ended' }
  /** In flight. */
  | { kind: 'away' }
  | { kind: 'unknown' };

/** The window a person's DEPART is timed from: the stay's scheduled window
 *  (before a robot takeover moved it). */
function personWindow(f: RouteFlight): number | null {
  return f.scheduledAt ?? f.departsAt;
}

export function routeDepartState(f: RouteFlight, now: number): RouteDepartState {
  if (f.status !== 'docked') return { kind: 'away' };
  if (f.ended !== null) return { kind: 'ended' };
  if (f.holding) return { kind: 'holding' };
  if (f.pilot === 'robot') return { kind: 'robot', departsAt: f.departsAt };
  const windowAt = personWindow(f);
  if (windowAt === null) return { kind: 'unknown' };
  if (now < windowAt - ROUTE_DEPART_OPENS_MS) return { kind: 'boarding', opensAt: windowAt - ROUTE_DEPART_OPENS_MS, windowAt };
  return { kind: 'open', windowAt };
}

/** A person pilot the ferry waits for (no robot captain to take over). */
function waitsForPerson(f: RouteFlight): boolean {
  return f.status === 'docked' && f.pilot === 'person' && f.takeoverAt === null;
}

/**
 * The stay a TAKE / HAND / KEEP / SKIP entry is keyed to (A5's guard band):
 * this stay while docked, unless its departure is within 10 s (or past); the
 * next one in flight. A leg that has left, or is about to, is never changed
 * after the fact. A person pilot the ferry waits for keeps this stay.
 */
export function helmEntryStay(f: RouteFlight, now: number): number {
  if (f.status !== 'docked') return f.legSeq + 1;
  if (waitsForPerson(f)) return f.legSeq;
  if (f.departsAt !== null && now >= f.departsAt - GUARD_BAND_MS) return f.legSeq + 1;
  return f.legSeq;
}

/** Who flies the next departure the helm can still change: this stay's
 *  pilot, or — keyed to the next stay — the newest helm entry there, else
 *  the pilot carried in. */
export function nextLegPilot(f: RouteFlight, checkpoints: readonly RouteCheckpoint[], now: number): RoutePilot {
  const stay = helmEntryStay(f, now);
  if (stay === f.legSeq) return f.pilot;
  let helm: HelmCheckpoint | null = null;
  for (const e of checkpoints) {
    if (e.kind === 'helm' && e.legSeq === stay && (!helm || e.at > helm.at)) helm = e;
  }
  return helm ? helm.pilot : f.pilot;
}

/** What the running-route panel offers. */
export interface RouteHelmView {
  helmStay: number;
  nextPilot: RoutePilot;
  /** TAKE THE HELM: a robot captain flies the next departure. */
  take: boolean;
  /** HAND TO ROBOT: a person flies it, and there is a robot captain. */
  hand: boolean;
  /** KEEP THE HELM: a robot takeover is pending at this stay… */
  keep: boolean;
  /** …and the departure has passed, so KEEP restarts the 5 minutes. */
  keepUseful: boolean;
  skip: boolean;
  /** STOP: not pressed yet. */
  stop: boolean;
  depart: RouteDepartState;
}

/** What the helm offers on a running route at `now`. Pure. */
export function routeHelmView(route: ShipRoute, f: RouteFlight, checkpoints: readonly RouteCheckpoint[], now: number): RouteHelmView {
  const live = !f.paused && f.ended === null && !f.stopping;
  const robot = !!route.robotDockId;
  const helmStay = helmEntryStay(f, now);
  const nextPilot = nextLegPilot(f, checkpoints, now);
  const keep = live && robot && f.status === 'docked' && f.pilot === 'person' && f.takeoverAt !== null
    && helmStay === f.legSeq;
  return {
    helmStay,
    nextPilot,
    take: live && robot && nextPilot === 'robot',
    hand: live && robot && nextPilot === 'person',
    keep,
    keepUseful: keep && f.scheduledAt !== null && now >= f.scheduledAt,
    skip: live && f.status === 'docked' && !f.skipped && helmStay === f.legSeq,
    stop: route.stoppedAt === undefined,
    depart: routeDepartState(f, now),
  };
}

type LineTone = 'ok' | 'warn' | 'dim';

/** The helm checklist's ROUTE line (§5): "A→B→A · robot · departs 14:05:47
 *  for B", "HOLDING FOR BERTH AT B", "PAUSED · off route" … Pure. */
export function routeStatusLine(route: ShipRoute | null, f: RouteFlight | null, now: number): { text: string; tone: LineTone } {
  if (!route) return { text: 'none set', tone: 'dim' };
  const path = routePathLabel(route.stops, route.shape);
  if (!isRouteRunning(route)) return { text: `${path} · saved · not running`, tone: 'dim' };
  if (!f) return { text: `${path} · starting…`, tone: 'dim' };
  if (f.paused) return { text: 'PAUSED · off route', tone: 'warn' };
  const stop = route.stops[f.stopIndex]?.name ?? '?';
  const next = route.stops[f.nextStopIndex]?.name ?? '?';
  if (f.ended === 'stop') return { text: `STOPPING AT ${stop}`, tone: 'dim' };
  if (f.ended === 'fuel') return { text: `OUT OF FUEL AT ${stop} · REFUEL or STOP`, tone: 'warn' };
  if (f.ended === 'blocked') return { text: `ROUTE BLOCKED · ${goneWords(route, f)} · STOP to end`, tone: 'warn' };
  const who = f.pilot === 'robot' ? 'robot' : 'person';
  if (f.status !== 'docked') {
    return {
      text: `${path} · ${who} · arrives ${formatClock(f.arrivesAt)} at ${next}${f.stopping ? ' · the route ends there' : ''}`,
      tone: 'ok',
    };
  }
  if (f.holding) return { text: `HOLDING FOR BERTH AT ${stop}`, tone: 'warn' };
  const scheduled = personWindow(f);
  if (f.pilot === 'person' && scheduled !== null && now >= scheduled) {
    return {
      text: `DELAYED · ${stop} waits for its pilot${f.takeoverAt !== null ? ` · robot takes the helm at ${formatClock(f.takeoverAt)}` : ''}`,
      tone: 'warn',
    };
  }
  if (f.overdue) return { text: `DELAYED AT ${stop} · was due ${formatClock(f.departsAt)}`, tone: 'warn' };
  const tail = [
    f.gone ? 'passing: its berth is gone' : f.skipped ? 'passing without docking' : '',
    f.stopping ? 'the route ends at the next stop' : '',
  ].filter(Boolean).join(' · ');
  return {
    text: `${path} · ${who} · departs ${formatClock(f.departsAt)} for ${next}${tail ? ` · ${tail}` : ''}`,
    tone: 'ok',
  };
}

/** ⛔ "B is gone", "B and C are gone": the stops found gone this run. */
export function goneWords(route: ShipRoute, f: Pick<RouteFlight, 'goneStops'>): string {
  const names = f.goneStops.map((i) => route.stops[i]?.name).filter((n): n is string => !!n);
  if (names.length === 0) return 'its stops are gone';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} gone`;
}

/** 🛑 The stop a STOPped route ends at: this stop once the timetable has
 *  ended it here, else the next one (STOP inside the guard band, or in
 *  flight). Pure. */
export function routeEndStopIndex(f: Pick<RouteFlight, 'status' | 'ended' | 'stopIndex' | 'nextStopIndex'>): number {
  return f.status === 'docked' && f.ended !== null ? f.stopIndex : f.nextStopIndex;
}

/** 🧾 A keeper's helm note, tied to the stay it is about (`hold`: it says
 *  the ferry holds). */
export interface RouteNoteTie {
  run: number;
  legSeq: number;
  hold?: boolean;
}

/** 🧾 Does a helm note still hold? One with no tie (not a keeper's) always
 *  does; a keeper's only at its run and stay, unpaused, and a hold note only
 *  while the ferry still holds (another rider's dock, STOP or SKIP ends it).
 *  Pure. */
export function routeNoteStands(tie: RouteNoteTie | undefined, route: ShipRoute | null, f: RouteFlight | null): boolean {
  if (!tie) return true;
  if (!route || route.startedAt !== tie.run || !f || f.paused || f.legSeq !== tie.legSeq) return false;
  return tie.hold === true ? f.holding : true;
}

/** The FLIGHT PLAN's route line (§2b): "ROUTE A→B→A · Depart for B at
 *  14:05:47 (launch window)". Pure. */
export function routeDepartLine(route: ShipRoute, f: RouteFlight, now: number): string {
  const path = `ROUTE ${routePathLabel(route.stops, route.shape)}`;
  const stop = route.stops[f.stopIndex]?.name ?? '?';
  const next = route.stops[f.nextStopIndex]?.name ?? '?';
  const st = routeDepartState(f, now);
  switch (st.kind) {
    case 'holding': return `${path} · Holding for a berth at ${stop}`;
    case 'ended': return f.ended === 'fuel' ? `${path} · Out of fuel at ${stop}`
      : f.ended === 'blocked' ? `${path} · Blocked at ${stop}: ${goneWords(route, f)}. STOP ends the route here`
        : `${path} · The route ends here at ${stop}`;
    case 'robot': return `${path} · The robot captain departs for ${next} at ${formatClock(st.departsAt)} (launch window)`;
    case 'away': return `${path} · In flight to ${next}`;
    case 'unknown': return `${path} · Next stop ${next}`;
    case 'boarding': return `${path} · Depart for ${next} at ${formatClock(st.windowAt)} (launch window)`;
    case 'open':
      return now >= st.windowAt + 1000
        ? `${path} · Depart for ${next}: the ${formatClock(st.windowAt)} window has passed, so DEPART takes the next one`
        : `${path} · Depart for ${next} at ${formatClock(st.windowAt)} (launch window)`;
  }
}

/** What the open helm repaints on while a route runs: every figure that
 *  flips with the clock alone (a docked panel is not repainted every tick,
 *  or its pickers would close). Pure. */
export function routeRenderKey(f: RouteFlight | null, now: number): string {
  if (!f) return '';
  const w = personWindow(f);
  return [
    f.legSeq, f.status, f.stopIndex, f.holding, f.pilot, f.departsAt, f.arrivesAt, f.overdue, f.paused,
    f.ended, f.stopping, f.skipped, f.takeoverAt, f.goneStops.join(','),
    w !== null && now >= w - ROUTE_DEPART_OPENS_MS,
    w !== null && now >= w,
    f.departsAt !== null && now >= f.departsAt - GUARD_BAND_MS,
    f.takeoverAt !== null && now >= f.takeoverAt,
  ].join('|');
}

// ── The helm's writers (effectful; the helm gate is the caller's) ────────────
//
// Each is one doc transaction, re-reads the route and its timetable at `now`,
// and refuses (returns null / false, writing nothing) when the moment is no
// longer right: the panel it was pressed on may be a render old.

/** Would writeRouteCheckpoint take this entry for this route? (Checked before
 *  a transaction whose other writes must not land alone.) */
function writable(route: ShipRoute, e: RouteCheckpoint): boolean {
  const clean = checkpointFromWire(e.kind, e.legSeq, checkpointToWire(e));
  return !!clean && clean.stationId === route.stops[stopAt(route, e.legSeq)]?.stationId;
}

/**
 * START (§5): save `route` (the editor's draft, stops copied fresh) and start
 * it at `startStop`, in ONE transaction: the fuel ceiling first, then the
 * run and its `start` entry (shipRoute.startShipRoute). The pilot is the
 * robot captain when the route names one, else a person. Returns the run id,
 * or null (running already, malformed, or START refused).
 */
export function startRouteFromHelm(o: { route: ShipRoute; now: number; startStop: number; fuel: number; capacity: number }): number | null {
  const h = shipDocHandle();
  if (!h || isRouteRunning(readShipRoute())) return null;
  let run: number | null = null;
  h.doc.transact(() => {
    if (!writeShipRoute(o.route)) return;
    const saved = readShipRoute();
    if (!saved) return;
    run = startShipRoute({
      now: o.now,
      startStop: o.startStop,
      pilot: saved.robotDockId ? 'robot' : 'person',
      fuel: o.fuel,
      capacity: o.capacity,
    });
  });
  return run;
}

/**
 * A person's route DEPART (§2b): the `go` entry and PR 172's own `in-flight`
 * record (older clients follow it), in one transaction. Only when the
 * timetable rules the flight, has the ship at a stop with a person flying
 * its leg, and DEPART is open (30 s before the window, or later). The
 * caller casts off after it, as PR 172's DEPART does. Returns the entry, or
 * null.
 */
export function departRouteFromHelm(o: { now: number }): GoCheckpoint | null {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route)) return null;
  const f = readRouteFlight(o.now);
  if (!routeRulesFlight(f) || routeDepartState(f, o.now).kind !== 'open') return null;
  const go = goCheckpoint(route, f.legSeq, { at: o.now, stayStart: Math.min(o.now, f.stayStart ?? o.now) });
  if (!go || !writable(route, go)) return null;
  const destinationId = localStationId(route.stops[f.nextStopIndex].stationId);
  // 🚚 Where that stop orbits now (PR 174's DEPART does the same), so a
  // client that lands this record can tell the station moved away since.
  const dest = listStations().find((st) => st.id === destinationId);
  const rec: FlightRecord = {
    status: 'in-flight',
    locationId: localStationId(route.stops[f.stopIndex].stationId),
    destinationId,
    departedAt: go.departAt,
    etaAt: go.arriveAt,
    ...(dest ? { destinationAt: adriftAt(planetById(dest.planetId).id, dest.orbitSlot) } : {}),
  };
  let wrote = false;
  h.doc.transact(() => {
    wrote = writeRouteCheckpoint(route.startedAt, go, o.now);
    if (!wrote) return;
    for (const r of flightWritePath(readFlightRecord(), rec)) writeFlightRecord(r);
  });
  return wrote ? go : null;
}

/**
 * DEPART off the route (§2b) pauses it, in ONE transaction: the `pause`
 * entry at the stay the ship is docked at (the route meter reads 0 from
 * here), the level the route had the tank at, the stored flight brought to
 * `docked` at that stop (robot legs never wrote it), then `apply(level)` —
 * the caller's PR 172 DEPART writes (in-flight record, fuel debit). Returns
 * whether it paused.
 */
export function pauseRouteFromHelm(o: { now: number; capacity: number; apply?: (level: number) => void }): boolean {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route)) return false;
  const f = readRouteFlight(o.now);
  if (!routeRulesFlight(f) || f.status !== 'docked') return false;
  const entry = pauseCheckpoint(route, f.legSeq, { at: o.now });
  if (!writable(route, entry)) return false;
  const level = clampFuelToCapacity(readFuelLevel(o.capacity), o.capacity);
  const here: FlightRecord = { status: 'docked', locationId: localStationId(route.stops[f.stopIndex].stationId) };
  let wrote = false;
  h.doc.transact(() => {
    wrote = writeRouteCheckpoint(route.startedAt, entry, o.now);
    if (!wrote) return;
    // Paused: the stored level rules now, and the route's share is folded in.
    writeFuelLevel(level, o.capacity);
    for (const r of flightWritePath(readFlightRecord(), here)) writeFlightRecord(r);
    o.apply?.(level);
  });
  return wrote;
}

/**
 * RESUME (§2b): the ship, paused off route, is docked at route stop
 * `stopIndex`. In ONE transaction: the fuel ceiling FIRST (the capacity with
 * the home refill, else the level aboard — the route meter reads 0 while
 * paused, shipRoute.ts's rule), then a RESUME `dock` at the first later
 * visit to that stop (a fresh minimum wait from now) and a `fuel` entry with
 * the level aboard. The robot captain flies on when the route has one.
 * Returns whether it resumed.
 */
export function resumeRouteFromHelm(o: { now: number; capacity: number; stopIndex: number }): boolean {
  const h = shipDocHandle();
  const route = readShipRoute();
  if (!h || !isRouteRunning(route) || route.stoppedAt !== undefined || !route.stops[o.stopIndex]) return false;
  const f = readRouteFlight(o.now);
  if (!f || !f.paused) return false;
  const k = nextStayAtStop(route, f.legSeq + 1, o.stopIndex);
  if (k < 0) return false;
  const level = clampFuelToCapacity(readFuelLevel(o.capacity), o.capacity);
  const dock = dockCheckpoint(route, k, { at: o.now, pilot: route.robotDockId ? 'robot' : 'person', resume: true });
  const fuel = fuelCheckpoint(route, k, { at: o.now, fuel: level });
  if (!dock || !writable(route, dock) || !writable(route, fuel)) return false;
  let wrote = false;
  h.doc.transact(() => {
    writeFuelLevel(route.homeRefuel ? o.capacity : level, o.capacity);
    wrote = writeRouteCheckpoint(route.startedAt, dock, o.now) && writeRouteCheckpoint(route.startedAt, fuel, o.now);
  });
  return wrote;
}

/**
 * TAKE THE HELM (`person`), HAND TO ROBOT (`robot`) or KEEP THE HELM
 * (`person` again, restarting the 5 minutes): one `helm` entry, keyed to
 * helmEntryStay. HAND TO ROBOT at this stay, docked and not holding, carries
 * the stay's times: the robot leaves at the first window after max(now, stay
 * start + minimum wait). Refused on a paused, stopping or ended route, and
 * for `robot` without a robot captain. Returns the entry, or null.
 */
export function handOverRoute(o: { now: number; pilot: RoutePilot }): HelmCheckpoint | null {
  const route = readShipRoute();
  if (!isRouteRunning(route) || route.stoppedAt !== undefined) return null;
  if (o.pilot === 'robot' && !route.robotDockId) return null;
  const f = readRouteFlight(o.now);
  if (!routeRulesFlight(f) || f.ended !== null) return null;
  const stay = helmEntryStay(f, o.now);
  // A skipped stay has no stay of its own to time from (it leaves at the
  // first window after arrival): the HAND there is a plain helm entry.
  const timed = o.pilot === 'robot' && stay === f.legSeq && f.status === 'docked' && !f.holding && !f.skipped
    && f.stayStart !== null;
  const entry = helmCheckpoint(route, stay, {
    at: o.now,
    pilot: o.pilot,
    ...(timed ? { stayStart: Math.min(o.now, f.stayStart!) } : {}),
  });
  if (!entry || !writable(route, entry)) return null;
  return writeRouteCheckpoint(route.startedAt, entry, o.now) ? entry : null;
}

/** SKIP STOP (helm): at a stop, outside the guard band, a `skip` entry — the
 *  ferry leaves at the first window after now, without waiting or docking.
 *  Returns whether it wrote. */
export function skipRouteStop(o: { now: number }): boolean {
  const route = readShipRoute();
  if (!isRouteRunning(route) || route.stoppedAt !== undefined) return false;
  const f = readRouteFlight(o.now);
  if (!routeRulesFlight(f) || f.status !== 'docked' || f.ended !== null || f.skipped) return false;
  if (helmEntryStay(f, o.now) !== f.legSeq) return false;
  // 🚀 why 'helm': the robot captain says the stop is skipped, not removed.
  const entry = skipCheckpoint(route, f.legSeq, { at: o.now, pilot: f.pilot, why: 'helm' });
  if (!entry || !writable(route, entry)) return false;
  return writeRouteCheckpoint(route.startedAt, entry, o.now);
}

/**
 * STOP (helm): stamp stoppedAt, so the timetable pins the ship at its end
 * stop and main.ts's watch copies it back there (A4). A paused route — or a
 * running one no checkpoint anchors — has no timetable to copy back (the
 * stored records already rule), so its STOP finishes it at once. Returns
 * what happened, or null.
 */
export function stopRouteFromHelm(o: { now: number }): 'stopping' | 'finished' | null {
  const route = readShipRoute();
  if (!isRouteRunning(route)) return null;
  const f = readRouteFlight(o.now);
  if (!routeRulesFlight(f)) return finishShipRoute() ? 'finished' : null;
  return stopShipRoute(o.now) ? 'stopping' : null;
}

/** This run's checkpoints (the running panel's nextLegPilot). */
export function readHelmCheckpoints(): readonly RouteCheckpoint[] {
  return readRouteCheckpoints();
}
