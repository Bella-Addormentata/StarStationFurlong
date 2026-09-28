/**
 * 🚏📋 Departures board — the rows a station's board shows (robot pilot
 * routes, design §5 and §5a, build notes A6 and A9 item 7; owner decisions
 * 2026-09-27: the board is a display built from the wall computer's live
 * screen, numbered gates with gate change, announcements aboard AND on
 * boards).
 *
 * A board reads two sources:
 *   - its own room's `departures` map (departuresDoc.ts), where each ferry
 *     that calls here mirrors its route and checkpoints. The board runs the
 *     ferry's own timetable over them (pilotRoute.routeFlightAt) with ITS
 *     berth doors as the live dock: a door of this room paired to the
 *     ferry's ship room, and when it was docked. That is how it tells
 *     BOARDING, NOT DOCKED, DELAYED and HOLDING FOR BERTH apart with no news
 *     at all. A board can't see a dock at another stop, so a ferry stuck
 *     elsewhere shows as due until a checkpoint says otherwise (A6).
 *   - the ship summaries every planet already shares (planetSummary.ts,
 *     PR 176), for ferries with no departures entry here: an all-gates board
 *     in another room of the station, or a ferry whose rider could not reach
 *     this room. Those rows are "as of" the summary's time.
 *
 * ─── One row per ferry ───────────────────────────────────────────────────────
 *
 *   the ferry, here                status             time          note
 *   ─────────────────────────────────────────────────────────────────────────
 *   docked at this berth           BOARDING           departs       to B
 *   due here, berth not holding it NOT DOCKED         departs       (nobody
 *                                                                   aboard to
 *                                                                   dock it)
 *   just arrived (30 s)            ON TIME            departs       arriving
 *   holding for a berth here       HOLDING FOR BERTH  since         leaves at
 *                                                                   least 1 min
 *                                                                   after it docks
 *   past its departure, still here DELAYED            the new time  now HH:MM:SS
 *                                                                   / waiting for
 *                                                                   a rider /
 *                                                                   time unknown
 *   passing without docking        NOT DOCKED         passes        not stopping
 *                                                                   here
 *   berth gone, or shut to it      ROUTE BLOCKED      —             berth removed
 *                                                                   / gate closed
 *   out of fuel here               ROUTE BLOCKED      —             out of fuel
 *   flying here, or due later      ON TIME            arrives       from A
 *   held up elsewhere              DELAYED            —             time unknown
 *   paused (flown off route)       PAUSED             —             time unknown
 *
 * A route that has ended (STOP) leaves the board; one that ends HERE still
 * shows its arrival. Times are the stored launch windows to the second
 * (formatClock, the player's local time, rounded down), as the helm shows
 * them.
 *
 * ─── Gates ───────────────────────────────────────────────────────────────────
 *
 * A row's gate is the gate the ferry is docked at here (a gate change shows
 * the gate it really took), else the stop's own gate from the route's copy.
 * A board set to Gate N shows only the rows at gate N; All gates shows every
 * row, gate or none.
 *
 * ─── What the ship tells the planet ─────────────────────────────────────────
 *
 * routeSummaryFields turns the ferry's own view (its timetable and its own
 * live dock) into ShipSummary's route fields: the gate, the next stop's
 * berth room, the departure, and one routeStatus word. The same table above
 * decides the word, from the ship's side.
 *
 * Pure: no doc, no DOM, no clock of its own. Pinned by departuresBoard.test.ts.
 */

import { formatClock, formatWait, goneWords } from './helmRoute';
import { arriveWith, isRouteRunning, legWindowAfter, routeCycleLength, routeFlightAt, routeLegFuel, stopAt } from './pilotRoute';
import type { LiveDockAt, RouteFlight, RouteWalkCache } from './pilotRoute';
import { staySkipWhy } from './shipPilot';
import type { RouteCheckpoint, RouteStop, ShipRoute } from './shipRoute';
import type { DepartureFerry } from './departuresDoc';
import { SHIP_ROUTE_STATUSES } from './planetSummary';
import type { ShipRouteStatus, ShipSummary } from './planetSummary';

// ── Words ────────────────────────────────────────────────────────────────────

export type DepartureStatus =
  | 'BOARDING'
  | 'ON TIME'
  | 'HOLDING FOR BERTH'
  | 'DELAYED'
  | 'NOT DOCKED'
  | 'PAUSED'
  | 'ROUTE BLOCKED';

/** The same words as they travel in a ShipSummary (routeStatus). */
export type RouteStatus = ShipRouteStatus;
export const ROUTE_STATUSES: readonly RouteStatus[] = SHIP_ROUTE_STATUSES;

const WIRE_TO_STATUS: Record<RouteStatus, DepartureStatus> = {
  boarding: 'BOARDING',
  'on-time': 'ON TIME',
  holding: 'HOLDING FOR BERTH',
  delayed: 'DELAYED',
  'not-docked': 'NOT DOCKED',
  paused: 'PAUSED',
  blocked: 'ROUTE BLOCKED',
};

export function statusFromWire(s: RouteStatus): DepartureStatus {
  return WIRE_TO_STATUS[s];
}

export function statusToWire(s: DepartureStatus): RouteStatus {
  return (Object.keys(WIRE_TO_STATUS) as RouteStatus[]).find((k) => WIRE_TO_STATUS[k] === s)!;
}

export function isRouteStatus(v: unknown): v is RouteStatus {
  return typeof v === 'string' && (ROUTE_STATUSES as readonly string[]).includes(v);
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Just arrived and not docked yet: the keeper is docking (ON TIME, not
 *  NOT DOCKED, for this long after the stay began). */
export const BOARD_ARRIVING_MS = 30_000;
/** Rows a board shows (its screen holds about this many). */
export const MAX_BOARD_ROWS = 6;
/** A ship summary older than this makes no row. */
export const SUMMARY_ROW_MAX_AGE_MS = 60 * 60_000;

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface DepartureRow {
  shipRoomId: string;
  ferry: string;
  /** Where it goes (`to`) or comes from (`from`). */
  dir: 'to' | 'from';
  place: string;
  gate?: number;
  /** The departure, the arrival, or when a hold began; null when unknown. */
  at: number | null;
  status: DepartureStatus;
  note?: string;
  /** From a ship summary: when the ship last said so. */
  asOf?: number;
}

/** What a board knows about where it stands. */
export interface BoardHere {
  /** Is this route stop at the board's station (its berth room is the
   *  board's room, or another room of the same station)? */
  isHere: (stop: RouteStop) => boolean;
  /** The doors of the board's room paired to this ship room (none when it
   *  is not docked here). */
  docksOf: (shipRoomId: string) => readonly BoardDock[];
}

/** One door of the board's room paired to a ship: when it was docked, its
 *  gate, and which of the SHIP's doors holds the other end (`farDoor`,
 *  absent from an older writer). */
export interface BoardDock {
  dockedAt: number;
  gate?: number;
  farDoor?: string;
}

/**
 * A ferry's docks at the board's room, read as its riders read their own:
 * `port` is the route port's pairing (its gate and BOARDING come from that
 * one alone; an unnamed far door reads as it, as dockRules does), `at` the
 * newest pairing of any door (the timetable's "docked at this stop"), and
 * 🛟 `held` the oldest pairing on ANOTHER ship door (a guest or second dock
 * holds the stay, as pilotRoute.liveDockFrom's `held`). Pure.
 */
export function ferryDocksHere(
  docks: readonly BoardDock[],
  shipPort: string,
): { port: BoardDock | null; at: number | null; held: number | null } {
  let port: BoardDock | null = null;
  let at: number | null = null;
  let held: number | null = null;
  for (const d of docks) {
    if (!Number.isFinite(d.dockedAt)) continue;
    if (at === null || d.dockedAt > at) at = d.dockedAt;
    if (d.farDoor === undefined || d.farDoor === shipPort) {
      if (!port || d.dockedAt > port.dockedAt) port = d;
    } else if (held === null || d.dockedAt < held) {
      held = d.dockedAt;
    }
  }
  return { port, at, held };
}

/** How one stay at a stop reads, from whoever is looking (a board at the
 *  stop, or the ship itself): the status, its time and its note. */
export interface StayReading {
  status: DepartureStatus;
  at: number | null;
  note?: string;
}

/**
 * The status of the ferry's CURRENT stay, docked by the timetable at its
 * stop (not paused, not ended by STOP). `docked`: the viewer sees the
 * ferry's dock there (the board's berth, the ship's own port). Pure.
 */
export function stayReading(
  route: ShipRoute,
  f: RouteFlight,
  checkpoints: readonly RouteCheckpoint[],
  docked: boolean,
  now: number,
): StayReading {
  const stop = route.stops[f.stopIndex];
  if (f.ended === 'fuel') return { status: 'ROUTE BLOCKED', at: null, note: 'out of fuel' };
  // ⛔ Fewer than two stops left to dock at (design §4): "B is gone".
  if (f.ended === 'blocked') return { status: 'ROUTE BLOCKED', at: null, note: goneWords(route, f) };
  if (f.holding) {
    return {
      status: 'HOLDING FOR BERTH',
      at: f.holdSince,
      note: `since ${formatClock(f.holdSince)} · leaves at least ${formatWait(stop?.waitSecs ?? 0)} after it docks`,
    };
  }
  if (f.skipped) {
    const why = staySkipWhy(f, checkpoints);
    if (why === 'gone') return { status: 'ROUTE BLOCKED', at: null, note: 'berth removed' };
    if (why === 'shut') return { status: 'ROUTE BLOCKED', at: null, note: 'gate closed to this ferry' };
    return { status: 'NOT DOCKED', at: f.departsAt, note: 'not stopping here' };
  }
  const scheduled = f.scheduledAt ?? f.departsAt;
  if (f.departsAt !== null && now < f.departsAt) {
    // A robot captain taking over moved it later than the schedule.
    if (scheduled !== null && now >= scheduled && f.departsAt > scheduled) {
      return { status: 'DELAYED', at: f.departsAt, note: `now ${formatClock(f.departsAt)}` };
    }
    if (docked) return { status: 'BOARDING', at: f.departsAt };
    if (f.stayStart !== null && now - f.stayStart < BOARD_ARRIVING_MS) {
      return { status: 'ON TIME', at: f.departsAt, note: 'arriving' };
    }
    return { status: 'NOT DOCKED', at: f.departsAt };
  }
  // Past its departure and still here.
  if (f.departsAt === null) return { status: 'DELAYED', at: scheduled, note: 'time unknown' };
  if (f.pilot === 'person' && f.takeoverAt === null) return { status: 'DELAYED', at: scheduled, note: 'time unknown' };
  return { status: 'DELAYED', at: scheduled, note: 'waiting for a rider' };
}

/** The next arrival at one of `here`'s stops, from the flight's own leg on,
 *  every later leg at the first window after arrival plus the minimum wait
 *  (the schedule: a pilot who is late later is news the board can't have).
 *  ⛽ With the timetable's fuel rules (pilotRoute A3.5): each leg burns its
 *  cost, the home stop refills, and a leg the fuel can't pay for is never
 *  flown (the route ends there). Null when none comes within one cycle. */
function nextArrivalHere(
  route: ShipRoute,
  f: RouteFlight,
  hereIdx: readonly number[],
  capacity: number,
): { from: number; to: number; at: number } | null {
  let legSeq = f.legSeq;
  let arrive = f.arrivesAt;
  if (arrive === null) return null;
  // Fuel on arriving at the flight's next stop: in flight its leg is already
  // burned; docked, it burns on leaving.
  const firstCost = f.status === 'in-flight' ? 0 : routeLegFuel(route, f.stopIndex, f.nextStopIndex);
  if (firstCost === null) return null;
  let fuel = arriveWith(route, f.fuel, firstCost, f.nextStopIndex, capacity);
  const cycle = routeCycleLength(route.stops.length, route.shape);
  for (let step = 0; step <= cycle; step++) {
    const to = stopAt(route, legSeq + 1);
    if (hereIdx.includes(to)) return { from: stopAt(route, legSeq), to, at: arrive };
    const w = legWindowAfter(route, legSeq + 1, arrive + route.stops[to].waitSecs * 1000);
    if (!w || fuel < w.fuelCost) return null;
    fuel = arriveWith(route, fuel, w.fuelCost, w.to, capacity);
    legSeq++;
    arrive = w.arriveAt;
  }
  return null;
}

/**
 * One ferry's row on a board at `here`, or null when it shows none (not
 * running, not anchored, not calling here, or its route has ended). `cache`:
 * one walk cache per ferry per board keeps the timetable cheap. Pure.
 */
export function ferryRow(ferry: DepartureFerry, here: BoardHere, now: number, cache?: RouteWalkCache): DepartureRow | null {
  const { route, checkpoints } = ferry;
  if (!isRouteRunning(route)) return null;
  const hereIdx = route.stops.map((s, i) => (here.isHere(s) ? i : -1)).filter((i) => i >= 0);
  if (hereIdx.length === 0) return null;
  const { port: dock, at: dockedAt, held } = ferryDocksHere(here.docksOf(ferry.shipRoomId), route.shipPort);
  const liveDock: LiveDockAt = Object.assign(
    (stop: RouteStop) => (dockedAt !== null && here.isHere(stop) ? dockedAt : null),
    { held },
  );
  const f = routeFlightAt(route, checkpoints, liveDock, now, ferry.capacity, cache);
  if (!f) return null;
  const name = (i: number) => route.stops[i]?.name ?? '?';
  const stopGate = (i: number) => route.stops[i]?.berth.gate;
  const row = (dir: 'to' | 'from', place: string, gate: number | undefined, r: StayReading): DepartureRow => ({
    shipRoomId: ferry.shipRoomId,
    ferry: ferry.name,
    dir,
    place,
    ...(gate !== undefined ? { gate } : {}),
    at: r.at,
    status: r.status,
    ...(r.note ? { note: r.note } : {}),
  });
  const atHere = hereIdx.includes(f.stopIndex);
  // ⛔ This station's stops found gone this run: the ferry passes them.
  const liveHere = hereIdx.filter((i) => !f.goneStops.includes(i));

  if (f.paused) {
    const r: StayReading = { status: 'PAUSED', at: null, note: 'time unknown' };
    return atHere
      ? row('to', name(f.nextStopIndex), stopGate(f.stopIndex), r)
      : row('from', name(f.stopIndex), stopGate(hereIdx[0]), r);
  }
  if (!atHere && liveHere.length === 0 && f.ended === null && !f.stopping) {
    return row('from', name(f.stopIndex), stopGate(hereIdx[0]), { status: 'ROUTE BLOCKED', at: null, note: 'berth removed · passed' });
  }

  if (f.status === 'docked') {
    if (f.ended === 'stop') return null;
    if (atHere) {
      const docked = dock !== null;
      const gate = docked && dock.gate !== undefined ? dock.gate : stopGate(f.stopIndex);
      return row('to', name(f.nextStopIndex), gate, stayReading(route, f, checkpoints, docked, now));
    }
    if (f.ended === 'fuel') {
      return row('from', name(f.stopIndex), stopGate(hereIdx[0]), { status: 'ROUTE BLOCKED', at: null, note: `out of fuel at ${name(f.stopIndex)}` });
    }
    if (f.ended === 'blocked') {
      return row('from', name(f.stopIndex), stopGate(hereIdx[0]), { status: 'ROUTE BLOCKED', at: null, note: `${goneWords(route, f)} · stopped at ${name(f.stopIndex)}` });
    }
    if (f.stopping) return null;
    // Held up elsewhere: when it reaches here is not known.
    const late = f.holding || f.departsAt === null || (now >= f.departsAt && (f.overdue || f.pilot === 'person'));
    if (late) {
      return row('from', name(f.stopIndex), stopGate(hereIdx[0]), { status: 'DELAYED', at: null, note: 'time unknown' });
    }
  } else if (liveHere.includes(f.nextStopIndex)) {
    // On its way here.
    return row('from', name(f.stopIndex), stopGate(f.nextStopIndex), { status: 'ON TIME', at: f.arrivesAt });
  } else if (f.stopping) {
    return null;
  }
  const next = nextArrivalHere(route, f, liveHere, ferry.capacity);
  if (!next) return null;
  return row('from', name(next.from), stopGate(next.to), { status: 'ON TIME', at: next.at });
}

/** A ship summary's row, "as of" when the ship said so, or null (no route
 *  news, stale, or not calling here). `isHereRoom`: a station welcome room
 *  or berth room of the board's station. `placeOf`: a room's station name. */
export function summaryRow(
  s: ShipSummary,
  isHereRoom: (roomId: string) => boolean,
  placeOf: (roomId: string | undefined) => string,
  now: number,
): DepartureRow | null {
  if (!s.routeStatus || now - s.updatedAt > SUMMARY_ROW_MAX_AGE_MS) return null;
  const status = statusFromWire(s.routeStatus);
  const base = {
    shipRoomId: s.roomId,
    ferry: s.name,
    ...(s.gate !== undefined ? { gate: s.gate } : {}),
    status,
    asOf: s.updatedAt,
  };
  const paused = status === 'PAUSED';
  if ((s.status === 'docked' || s.status === 'undocking') && s.fromRoom && isHereRoom(s.fromRoom)) {
    return { ...base, dir: 'to', place: placeOf(s.nextStopRoom), at: paused ? null : s.departAt ?? null };
  }
  if ((s.status === 'in-flight' || s.status === 'redocking')
    && ((s.toRoom && isHereRoom(s.toRoom)) || (s.nextStopRoom && isHereRoom(s.nextStopRoom)))) {
    // A paused route's flight is its off-route one: that ETA is for
    // somewhere else, so the time is unknown, as when docked.
    return { ...base, dir: 'from', place: placeOf(s.fromRoom), at: paused ? null : s.etaAt ?? null };
  }
  // Paused and docked off its route once that flight has landed: the stop it
  // resumes at next still lists it, time unknown.
  if (paused && (s.status === 'docked' || s.status === 'undocking') && s.nextStopRoom && isHereRoom(s.nextStopRoom)) {
    return { ...base, dir: 'from', place: placeOf(s.fromRoom), at: null };
  }
  return null;
}

/** What a board shows. */
export interface BoardView {
  /** "DEPARTURES · ALL GATES" / "DEPARTURES · GATE 2". */
  title: string;
  gate: number | null;
  rows: DepartureRow[];
}

export interface BoardInput {
  ferries: readonly DepartureFerry[];
  here: BoardHere;
  /** The gate the board shows (boardGate), or null for all gates. */
  gate: number | null;
  /** Ships this install has heard of around the board's planet. */
  summaries?: readonly ShipSummary[];
  isHereRoom?: (roomId: string) => boolean;
  placeOf?: (roomId: string | undefined) => string;
  now: number;
  /** One walk cache per ferry (by ship room id), kept by the caller. */
  caches?: Map<string, RouteWalkCache>;
}

/** The name a board prints for a ferry, from its room's name: a new room is
 *  named after its id until someone renames it, and a board says FERRY then.
 *  The ferry's board entries and its ship summary on a route both use it. */
export function ferryName(roomName: unknown, roomId: string): string {
  const unnamed = typeof roomName !== 'string' || !roomName || roomName === roomId;
  return (unnamed ? 'FERRY' : roomName).slice(0, 64);
}

/** Sort key: known times first, soonest first; then the ferry's name. */
function rowOrder(a: DepartureRow, b: DepartureRow): number {
  const ta = a.at ?? Number.POSITIVE_INFINITY;
  const tb = b.at ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.ferry < b.ferry ? -1 : a.ferry > b.ferry ? 1 : 0;
}

/** Does a newer summary row show a schedule the departures map's row no
 *  longer matches (a gate, or the same status at another time)? Status alone
 *  is not enough: the map's row reads the clock now, the summary as of its
 *  time. */
function scheduleMoved(mirror: DepartureRow, newer: DepartureRow): boolean {
  if (newer.gate !== undefined && newer.gate !== mirror.gate) return true;
  return newer.status === mirror.status && newer.at !== null && mirror.at !== null
    && Math.abs(newer.at - mirror.at) > 1000;
}

/**
 * The board: a row per ferry from the departures map, then a row per ship
 * summary for ferries the map does not hold, filtered to the board's gate,
 * soonest first, capped at MAX_BOARD_ROWS. Pure.
 *
 * The map's entry for a ferry is its last publish that reached this room
 * (DepartureFerry.at). A summary wins where they disagree, since a publish
 * can give up or a finished route's entry stays behind: one that flies a
 * later run (`routeRun`) ends the held row, and one that knows of a
 * checkpoint of the held run the map lacks (a hold, a pause…: `routeNews`)
 * replaces it, or with no row of its own makes it DELAYED, time unknown,
 * whatever the stamps say (🕰️ run ids and checkpoint times order
 * themselves). One the ferry wrote AFTER the map's entry, by the stamps,
 * also has its say where nothing else orders the two: said since that no
 * run flies (🏁 `routeIdle`), the held row goes; a row where the map has
 * none, or with another gate or time, replaces the map's; a new name
 * renames it. A summary with no route fields at all (an older client's
 * relay drops them) changes nothing.
 */
export function boardView(i: BoardInput): BoardView {
  const rows: DepartureRow[] = [];
  const known = new Set<string>();
  const placeOf = i.placeOf ?? (() => '?');
  const summaryOf = new Map((i.summaries ?? []).map((s) => [s.roomId, s] as const));
  for (const ferry of i.ferries) {
    known.add(ferry.shipRoomId);
    let cache = i.caches?.get(ferry.shipRoomId);
    if (!cache && i.caches) {
      cache = {};
      i.caches.set(ferry.shipRoomId, cache);
    }
    let r = ferryRow(ferry, i.here, i.now, cache);
    const s = summaryOf.get(ferry.shipRoomId);
    if (s && i.isHereRoom) {
      // Written after this room's copy, by the stamps: the say on what has
      // no order of its own (a gate, a time, a name, "no run flies").
      const newer = s.updatedAt > ferry.at;
      if (newer && s.routeIdle) continue;
      if (s.routeStatus) {
        // Renamed since this room's copy: the row keeps its clock-live times
        // under the newer name (a route summary names it as boards do).
        if (newer && r && s.name !== r.ferry) r = { ...r, ferry: s.name };
        // 🕰️ Run ids and checkpoint times order themselves, whatever the
        // two riders' clocks stamped the copy and the summary with.
        // A later run than the one this room holds (a replacement route): the
        // held one is over, whether or not the new one calls here now.
        const laterRun = s.routeRun !== undefined && s.routeRun > (ferry.route.startedAt ?? ferry.endedRun ?? 0);
        // The same run, and the ship knows of a checkpoint this room's copy
        // lacks (its publish gave up): the held timetable is out of date.
        const missed = !laterRun && s.routeRun !== undefined && s.routeRun === ferry.route.startedAt
          && s.routeNews !== undefined && s.routeNews > newestRouteNews(ferry.checkpoints);
        const sr = summaryRow(s, i.isHereRoom, placeOf, i.now);
        if (sr && (laterRun || missed || (newer && (!r || scheduleMoved(r, sr))))) {
          rows.push(sr);
          continue;
        }
        if (laterRun) continue;
        if (missed && r) {
          rows.push({ ...r, status: 'DELAYED', at: null, note: 'time unknown', asOf: s.updatedAt });
          continue;
        }
      }
    }
    if (r) rows.push(r);
  }
  if (i.summaries && i.isHereRoom) {
    for (const s of i.summaries) {
      if (known.has(s.roomId)) continue;
      const r = summaryRow(s, i.isHereRoom, placeOf, i.now);
      if (r) rows.push(r);
    }
  }
  const shown = rows
    .filter((r) => i.gate === null || r.gate === i.gate)
    .sort(rowOrder)
    .slice(0, MAX_BOARD_ROWS);
  return {
    title: i.gate === null ? 'DEPARTURES · ALL GATES' : `DEPARTURES · GATE ${i.gate}`,
    gate: i.gate,
    rows: shown,
  };
}

/** One row as the screen prints it: "FERRY → B  G2  14:05:47  BOARDING". */
export function rowText(r: DepartureRow): { ferry: string; place: string; gate: string; time: string; status: string; note: string } {
  return {
    ferry: r.ferry.toUpperCase(),
    place: `${r.dir === 'to' ? '→' : '←'} ${r.place.toUpperCase()}`,
    gate: r.gate !== undefined ? String(r.gate) : '—',
    time: r.at !== null ? formatClock(r.at) : '--:--:--',
    status: r.status,
    note: [r.note ?? '', r.asOf !== undefined ? `as of ${formatClock(r.asOf).slice(0, 5)}` : ''].filter(Boolean).join(' · '),
  };
}

// ── What the ship tells the planet (ShipSummary's route fields) ─────────────

export interface RouteSummaryFields {
  gate?: number;
  nextStopRoom?: string;
  departAt?: number;
  routeStatus?: RouteStatus;
  routeRun?: number;
  routeNews?: number;
  routeIdle?: true;
}

/** The newest observation among the checkpoints (a hold's newest sighting,
 *  as departuresDoc keeps it; any other entry's time), or 0: what a
 *  summary's `routeNews` compares against. A renewal a room missed then
 *  reads as news its copy lacks, before its hold goes unwatched there. */
export function newestRouteNews(checkpoints: readonly RouteCheckpoint[]): number {
  let t = 0;
  for (const e of checkpoints) {
    const seen = e.kind === 'hold' ? Math.max(e.at, e.seenAt) : e.at;
    if (Number.isFinite(seen) && seen > t) t = seen;
  }
  return t;
}

/**
 * The gate the ship's summary gives for its route port's dock at `stop`
 * (`farRoom`/`farDoor`: the port's far end): the station records' gate for
 * that door, else the stop's own copied gate when the dock is its own berth.
 * An older writer's record names no far door; into the berth room it reads
 * as the own berth (shipPilot.pilotDockAt's rule). Pure.
 */
export function routePortGate(
  stop: RouteStop,
  farRoom: string,
  farDoor: string | undefined,
  gateOf: (roomId: string, doorId: string | undefined) => number | undefined,
): number | undefined {
  const own = farRoom === stop.berth.roomId && (farDoor === undefined || farDoor === stop.berth.farDoor);
  return gateOf(farRoom, farDoor) ?? (own ? stop.berth.gate : undefined);
}

/**
 * The route fields of the ship's own summary (A9 item 7), from its
 * timetable and its own live dock at the stop (`dock`: docked there, and at
 * which gate when known), with the run's newest checkpoint. 🏁 `routeIdle`
 * alone when no route runs or it has ended; nothing at all while a running
 * route's timetable can't be worked out yet (its anchor checkpoint has not
 * arrived), so a board keeps what it holds. Pure.
 */
export function routeSummaryFields(
  route: ShipRoute | null,
  f: RouteFlight | null,
  checkpoints: readonly RouteCheckpoint[],
  dock: { gate?: number } | null,
  now: number,
): RouteSummaryFields {
  if (!isRouteRunning(route) || f?.ended === 'stop') return { routeIdle: true };
  if (!f) return {};
  const next = route.stops[f.nextStopIndex];
  const out: RouteSummaryFields = {};
  if (route.startedAt !== undefined) out.routeRun = route.startedAt;
  const news = newestRouteNews(checkpoints);
  if (news > 0) out.routeNews = news;
  if (next) out.nextStopRoom = next.berth.roomId;
  if (f.paused) {
    out.routeStatus = 'paused';
    return out;
  }
  if (f.status !== 'docked') {
    out.routeStatus = 'on-time';
    if (next?.berth.gate !== undefined) out.gate = next.berth.gate;
    return out;
  }
  const r = stayReading(route, f, checkpoints, dock !== null, now);
  const gate = dock?.gate ?? route.stops[f.stopIndex]?.berth.gate;
  if (gate !== undefined) out.gate = gate;
  if (f.departsAt !== null) out.departAt = f.departsAt;
  out.routeStatus = statusToWire(r.status);
  return out;
}
