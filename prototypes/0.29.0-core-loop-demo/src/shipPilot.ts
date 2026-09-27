/**
 * 🚀🤖 Ship pilot — the robot captain (robot pilot routes, design §2a, the
 * §4 table's lines and §5's announcements; owner decisions 2026-09-27: the
 * schedule belongs to the SHIP and is set at the helm, a person can take the
 * robot's place, numbered gates with gate change; owner requirement: the
 * ferry is an ordinary module and its robot captain an ordinary
 * charging-dock robot aboard).
 *
 * The pilot is the drink robot set to a new job. A charging dock's console
 * picks 🚀 Ship pilot (robotDoc.ts `pilot`), offered only in a module the
 * furniture makes flight-capable (fuel tank, engine, helm). The routine
 * holds NO route and flies nothing by itself: it makes the dock's robot
 * ELIGIBLE (shipPilotEligible, read by the helm's robot captain picker,
 * devices.ts robotCaptainEligible), and the helm names it the route's robot
 * captain (route.robotDockId). The timetable (pilotRoute.ts) moves the ship,
 * the keeper (routeKeeper.ts) docks and casts it off; whether a running
 * route HAS a robot captain is read from route.robotDockId alone, never from
 * the routine, so a console change can never rewrite legs already flown.
 *
 * ─── The captain's lock ──────────────────────────────────────────────────────
 *
 *   While a RUNNING route (START pressed, not finished; a paused one
 *   included) names a dock as captain, its console refuses routine changes
 *   and edit mode refuses to remove the dock:
 *     "Captain of this ship's route: stop the route first"
 *   (captainLockRefusal). ⏸ STOP · park at the console still works: it parks
 *   the robot on its dock and silences it, and the ferry keeps flying its
 *   timetable (the helm's STOP ROUTE is what stops the ferry).
 *
 * ─── Where the captain stands (pilotPost) ────────────────────────────────────
 *
 *   route paused / none / not captain       its charging dock
 *   a person flies this leg                  the berth door (steward)
 *   in flight                                the helm
 *   at a stop, holding or passing it         the helm
 *   at a stop, from 50 s before departure    the helm
 *   at a stop otherwise, or the route's end  the berth door (to announce)
 *
 * The movement is LOCAL to each game (PoolWaiter, never synced, no identity
 * key): every rider's copy of the robot walks the same way because every
 * game reads the same timetable.
 *
 * ─── What the captain says (pilotLine) ──────────────────────────────────────
 *
 *   arrival, docked       "Welcome to A, gate 2. Next stop B, departing in
 *                          3 minutes, at 14:05."   (gate left out when no
 *                          number is known; ", the last stop of the route"
 *                          after STOP)
 *   docked at another     "Gate change: arriving at gate 3."   (then the
 *     gate                 welcome, which names gate 3)
 *   the departure moved   "Next stop B: now departing in 6 minutes, at
 *     after the welcome     14:17."   (a restart, a handover, a takeover)
 *   one minute before     "Departing for B in one minute."
 *   the burn              "Departing for B."
 *   holding               "Berth at A is occupied. Holding until it is free."
 *   skipping (§4)         "The berth at A has been removed. Continuing to
 *                          B."   (every gate gone; closed-to-us, SKIP STOP and
 *                          a hold nobody renewed each have their own line)
 *   the route's end       "Welcome to A, gate 2. This is the last stop: the
 *                          route ends here."  /  "We are out of fuel at A.
 *                          The route ends here."
 *
 * Speech rounds the clock DOWN to the minute (speakClock) and always says
 * how long is left (speakLeft); boards and the helm show the exact second.
 * Each line is said once per stay (the memory is local, like the robot), a
 * line that went stale unsaid (the player was not in the room yet) is
 * dropped, and lines are spaced so one bubble does not replace another.
 * Lines go through world.ts robotSay, the one bubble-plus-voice seam. An
 * open helm shows the same lines as text (helmAnnouncerStep), so a route a
 * person flies with no robot captain still announces its stops aboard.
 *
 * Pure functions (eligibility, the lock, posts, lines, words) plus thin
 * readers over the ship doc at the end. Pinned by shipPilot.test.ts.
 */

import { isShipPilotRoutine } from './helmRoute';
import { GUARD_BAND_MS, isRouteRunning, type RouteFlight } from './pilotRoute';
import type { RobotRoutine } from './robotDoc';
import { directoryStationFor, sameStationReader } from './routeKeeper';
import {
  readRouteCheckpoints,
  readRouteFlight,
  readShipRoute,
  type RouteCheckpoint,
  type RouteStop,
  type ShipRoute,
  type SkipWhy,
} from './shipRoute';
import { readDoor } from './doorsDoc';
import { readAtlas, roomIdFromSeed } from './stationAtlas';

// ── Constants ────────────────────────────────────────────────────────────────

/** What the console and edit mode say while a running route names the dock. */
export const CAPTAIN_LOCK_REFUSAL = "Captain of this ship's route: stop the route first";
/** The captain leaves the berth door for the helm this long before a
 *  departure (after the one-minute line, said at the door). */
export const PILOT_HELM_BEFORE_MS = 50_000;
/** At least this long between two lines (one bubble per robot). */
export const PILOT_LINE_GAP_MS = 3_500;
/** "Departing for B" is said within this long of the burn, or not at all. */
export const PILOT_DEPART_LINE_MS = 20_000;
/** "…in one minute" is due from this long before the departure… */
export const PILOT_MINUTE_LINE_MS = 60_000;
/** …and stale from this long before it. */
export const PILOT_MINUTE_STALE_MS = 40_000;
/** No welcome inside the departure's guard band (the doors are closing). */
export const PILOT_WELCOME_UNTIL_MS = GUARD_BAND_MS;
/** A departure that moved at least this much after the welcome is said
 *  again. */
export const PILOT_RETIME_MS = 30_000;

// ── The routine and the lock ─────────────────────────────────────────────────

/** Does the console offer 🚀 Ship pilot? Only in a flight-capable module —
 *  but a dock already on it keeps its button, so it stays visible. Pure. */
export function pilotRoutineOffered(o: { flightCapable: boolean; current: RobotRoutine }): boolean {
  return o.flightCapable || o.current === 'pilot';
}

/** May this dock's robot be named the ship's robot captain? It is a
 *  charging dock aboard, runs 🚀 Ship pilot, and the module can fly. (Parked
 *  does not matter: a parked captain only stands on its dock, quiet.) Pure;
 *  the helm's robotCaptainEligible (devices.ts) reads it. */
export function shipPilotEligible(o: {
  dockAboard: boolean;
  routine: string | null | undefined;
  flightCapable: boolean;
}): boolean {
  return o.dockAboard && o.flightCapable && isShipPilotRoutine(o.routine);
}

/** The dock a RUNNING route (paused included) names as its robot captain,
 *  or null. Pure. */
export function routeCaptainDockId(route: ShipRoute | null | undefined): string | null {
  if (!isRouteRunning(route)) return null;
  return typeof route.robotDockId === 'string' && route.robotDockId.length > 0 ? route.robotDockId : null;
}

/** Why dock `dockId` may not change routine or be removed now, or null.
 *  Pure. */
export function captainLockRefusal(route: ShipRoute | null | undefined, dockId: string): string | null {
  return dockId && routeCaptainDockId(route) === dockId ? CAPTAIN_LOCK_REFUSAL : null;
}

/** The console's routine switch from `from` to `to`: refused (with why)
 *  while the dock is captain of a running route; choosing the routine it
 *  already runs is never refused. Pure. */
export function consoleRoutineRefusal(o: {
  route: ShipRoute | null | undefined;
  dockId: string;
  from: RobotRoutine;
  to: RobotRoutine;
}): string | null {
  if (o.from === o.to) return null;
  return captainLockRefusal(o.route, o.dockId);
}

// ── Where the captain stands ─────────────────────────────────────────────────

export type PilotPost = 'helm' | 'door' | 'dock';

/**
 * Where the robot captain goes at `now`, from the timetable's flight (null:
 * no running route names it). Pure; see the header's table.
 */
export function pilotPost(f: RouteFlight | null, now: number): PilotPost {
  if (!f || f.paused) return 'dock';
  if (f.pilot === 'person') return 'door';
  if (f.status !== 'docked') return 'helm';
  if (f.ended !== null) return 'door';
  if (f.holding || f.skipped) return 'helm';
  if (f.departsAt !== null && now >= f.departsAt - PILOT_HELM_BEFORE_MS) return 'helm';
  return 'door';
}

// ── The dock and the skip, as the captain reads them ─────────────────────────

/** The route port's live dock at the flight's stop: its gate number, when
 *  known, and whether it is not the stop's own berth (a gate change). */
export interface PilotDock {
  gate?: number;
  gateChange: boolean;
}

/**
 * The route port's dock (`dock`: its far room and door, or null when not
 * docked) as the captain announces it. `atStop`: the dock is into the
 * current stop's station. The stop's own berth is its copied room and door;
 * `gateOf` finds any other gate's number (the atlas, the directory). Pure.
 */
export function pilotDockAt(
  stop: RouteStop,
  dock: { roomId: string; farDoor?: string } | null,
  atStop: boolean,
  gateOf: (roomId: string, farDoor: string) => number | undefined,
): PilotDock | null {
  if (!dock || !atStop) return null;
  // A dock record with no far door (an older writer's) into the berth room
  // reads as the own berth: nothing says otherwise.
  const own = dock.roomId === stop.berth.roomId
    && (dock.farDoor === undefined || dock.farDoor === stop.berth.farDoor);
  let gate: number | undefined = own ? stop.berth.gate : undefined;
  if (gate === undefined && dock.farDoor !== undefined) {
    try {
      gate = gateOf(dock.roomId, dock.farDoor);
    } catch {
      gate = undefined;
    }
  }
  const ok = typeof gate === 'number' && Number.isInteger(gate) && gate >= 1 && gate <= 99;
  return { ...(ok ? { gate } : {}), gateChange: !own };
}

/** Why the flight's stay is passed without docking, for the §4 line. */
export type PilotSkipWhy = SkipWhy | 'unwatched' | 'unknown';

/** The newest `skip` entry at the stay says why; a skipped stay with none
 *  is a hold nobody renewed (pilotRoute: it ends unwatched), or ⛔ a stop
 *  found gone at an earlier visit (`f.gone`: passed at every later one).
 *  Null when the stay is not skipped. Pure. */
export function staySkipWhy(f: RouteFlight, checkpoints: readonly RouteCheckpoint[]): PilotSkipWhy | null {
  if (!f.skipped) return null;
  if (f.gone) return 'gone';
  let skip: Extract<RouteCheckpoint, { kind: 'skip' }> | null = null;
  for (const e of checkpoints) {
    if (e.kind === 'skip' && e.legSeq === f.legSeq && (!skip || e.at > skip.at)) skip = e;
  }
  if (!skip) return 'unwatched';
  return skip.why ?? 'unknown';
}

// ── Words ────────────────────────────────────────────────────────────────────

/** HH:MM in the listener's local time, rounded DOWN (speech says the
 *  minute; boards and the helm show the second). */
export function speakClock(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How long is left, rounded down: "in a few seconds", "in 45 seconds",
 *  "in one minute", "in 3 minutes", "in one hour and 5 minutes",
 *  "in 9 hours". */
export function speakLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return 'in a few seconds';
  if (s < 60) return `in ${Math.floor(s / 5) * 5} seconds`;
  const min = Math.floor(s / 60);
  if (min < 2) return 'in one minute';
  if (min < 60) return `in ${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hours = h === 1 ? 'one hour' : `${h} hours`;
  if (m === 0 || h >= 10) return `in ${hours}`;
  return `in ${hours} and ${m === 1 ? 'one minute' : `${m} minutes`}`;
}

function welcomeTo(stopName: string, dock: PilotDock): string {
  return dock.gate !== undefined ? `Welcome to ${stopName}, gate ${dock.gate}.` : `Welcome to ${stopName}.`;
}

/** The §4 skip line. */
export function skipLine(why: PilotSkipWhy | null, stopName: string, nextName: string): string {
  switch (why) {
    case 'gone': return `The berth at ${stopName} has been removed. Continuing to ${nextName}.`;
    case 'shut': return `The berth at ${stopName} is closed to this ferry. Continuing to ${nextName}.`;
    case 'helm': return `We are not stopping at ${stopName}. Continuing to ${nextName}.`;
    case 'unwatched': return `Still no free berth at ${stopName}. Continuing to ${nextName}.`;
    default: return `We will not dock at ${stopName}. Continuing to ${nextName}.`;
  }
}

// ── What the captain says ────────────────────────────────────────────────────

/** What one game's captain has said, about one stay (and the leg leaving
 *  it) of one run. Local, never synced. */
export interface PilotSpeech {
  run: number;
  legSeq: number;
  /** Line keys said at this stay. */
  said: readonly string[];
  /** The departure the welcome (or the last re-time) announced. */
  departsAt: number | null;
  /** When the last line was said (any stay): the gap between lines. */
  lastAt: number;
}

/** Everything a line depends on, read at `now`. */
export interface PilotLineView {
  route: ShipRoute & { startedAt: number };
  f: RouteFlight;
  now: number;
  /** The route port's dock at the stop (pilotDockAt), or null. */
  dock: PilotDock | null;
  /** Why the stay is passed without docking (staySkipWhy), or null. */
  skipWhy: PilotSkipWhy | null;
}

/** One line to say: `key` marks it said; `also` marks lines it makes
 *  redundant, `clear` lines it makes due again; `departsAt` is the
 *  departure it announced. */
export interface PilotLine {
  key: string;
  text: string;
  also?: readonly string[];
  clear?: readonly string[];
  departsAt?: number;
}

/** The memory for this stay: `mem` when it is about the same one, else a
 *  fresh one (keeping the gap clock). Pure. */
export function pilotSpeechAt(mem: PilotSpeech | null, run: number, legSeq: number): PilotSpeech {
  if (mem && mem.run === run && mem.legSeq === legSeq) return mem;
  return { run, legSeq, said: [], departsAt: null, lastAt: mem?.lastAt ?? -Infinity };
}

/**
 * The line the captain should say now, or null. At most one per call; the
 * caller marks it said (pilotSpeechAfter) only once it was delivered, so a
 * line the room's quiet window dropped is tried again while it still holds.
 * Pure; see the header's table.
 */
export function pilotLine(v: PilotLineView, mem: PilotSpeech | null): PilotLine | null {
  const { route, f, now } = v;
  if (f.paused) return null;
  const m = pilotSpeechAt(mem, route.startedAt, f.legSeq);
  if (now - m.lastAt < PILOT_LINE_GAP_MS) return null;
  const said = (k: string): boolean => m.said.includes(k);
  const stop = route.stops[f.stopIndex];
  if (!stop) return null;
  const nextName = route.stops[f.nextStopIndex]?.name ?? stop.name;
  const departAt = f.status === 'docked' ? f.departsAt : (f.departedAt ?? f.departsAt);

  const minuteLine = (): PilotLine | null => {
    if (departAt === null || said('minute')) return null;
    const left = departAt - now;
    if (left > PILOT_MINUTE_LINE_MS || left < PILOT_MINUTE_STALE_MS) return null;
    return { key: 'minute', text: `Departing for ${nextName} in one minute.` };
  };

  if (f.status !== 'docked') {
    // In flight on leg legSeq (a person's DEPART may be waiting for the
    // launch window: departedAt is still ahead).
    if (departAt === null) return null;
    if (now < departAt) return minuteLine();
    if (said('depart') || now - departAt > PILOT_DEPART_LINE_MS) return null;
    return { key: 'depart', text: `Departing for ${nextName}.`, also: ['minute'] };
  }

  if (f.ended === 'fuel') {
    return said('end') ? null : { key: 'end', text: `We are out of fuel at ${stop.name}. The route ends here.` };
  }
  if (f.ended === 'blocked') {
    // ⛔ Design §4: fewer than two stops left to dock at.
    const gone = f.goneStops.map((i) => route.stops[i]?.name).filter((n): n is string => !!n);
    const what = gone.length === 1 ? `The berth at ${gone[0]} has been removed` : `The berths at ${gone.join(' and ')} have been removed`;
    return said('end') ? null : { key: 'end', text: `${what}. The route cannot go on: we stay at ${stop.name}.` };
  }
  if (f.ended === 'stop') {
    if (!v.dock || said('end')) return null;
    return { key: 'end', text: `${welcomeTo(stop.name, v.dock)} This is the last stop: the route ends here.` };
  }
  if (f.holding) {
    const k = `hold:${f.holdSince ?? 0}`;
    return said(k) ? null : { key: k, text: `Berth at ${stop.name} is occupied. Holding until it is free.` };
  }
  if (f.skipped) {
    if (!said('skip') && departAt !== null && now < departAt - PILOT_WELCOME_UNTIL_MS) {
      return { key: 'skip', text: skipLine(v.skipWhy, stop.name, nextName) };
    }
    return minuteLine();
  }
  if (v.dock && departAt !== null) {
    const left = departAt - now;
    if (!said('welcome') && left > PILOT_WELCOME_UNTIL_MS) {
      // At START the ferry arrived nowhere: the gate it is docked at is no
      // gate change (the editor's berth may simply name another one).
      if (v.dock.gateChange && v.dock.gate !== undefined && !said('gate') && f.legSeq > 0) {
        return { key: 'gate', text: `Gate change: arriving at gate ${v.dock.gate}.` };
      }
      const last = f.stopping ? ', the last stop of the route' : '';
      return {
        key: 'welcome',
        text: `${welcomeTo(stop.name, v.dock)} Next stop ${nextName}${last}, departing ${speakLeft(left)}, at ${speakClock(departAt)}.`,
        also: left <= PILOT_MINUTE_LINE_MS ? ['gate', 'minute'] : ['gate'],
        departsAt: departAt,
      };
    }
    if (said('welcome') && m.departsAt !== null && Math.abs(departAt - m.departsAt) >= PILOT_RETIME_MS
      && left > PILOT_MINUTE_LINE_MS) {
      return {
        key: `retime:${departAt}`,
        text: `Next stop ${nextName}: now departing ${speakLeft(left)}, at ${speakClock(departAt)}.`,
        clear: ['minute', 'depart'],
        departsAt: departAt,
      };
    }
  }
  return minuteLine();
}

/** The memory after `line` was delivered. Pure. */
export function pilotSpeechAfter(v: PilotLineView, mem: PilotSpeech | null, line: PilotLine): PilotSpeech {
  const m = pilotSpeechAt(mem, v.route.startedAt, v.f.legSeq);
  const clear = new Set(line.clear ?? []);
  const said = m.said.filter((k) => !clear.has(k));
  for (const k of [line.key, ...(line.also ?? [])]) if (!said.includes(k)) said.push(k);
  return {
    ...m,
    said,
    departsAt: line.departsAt ?? m.departsAt,
    lastAt: v.now,
  };
}

// ── The same lines at the helm (design §5) ──────────────────────────────────
//
// "A route with no robot captain shows the same lines at the helm": a person
// flying the ferry is the one aboard who needs them. An open helm runs its
// own announcer over the same pilotLine, with a memory of its own (never a
// robot's: each speaks once per stay for itself), and shows the newest line
// under the route's status while it is fresh. Shown for a route with a
// robot captain too: the robot says it, the helm echoes it. Local, like the
// robot's speech; nothing is written.

/** How long the helm shows the newest line: its words go stale ("departing
 *  in 3 minutes"), and the status line above it carries the exact second. */
export const HELM_LINE_SHOW_MS = 45_000;

/** One open helm's announcer: what it has "said" and the line it shows. */
export interface HelmAnnouncer {
  speech: PilotSpeech | null;
  shown: { text: string; run: number; at: number } | null;
}

/** A helm that has said nothing yet. */
export function freshHelmAnnouncer(): HelmAnnouncer {
  return { speech: null, shown: null };
}

/**
 * One step of the helm's announcer over the captain's view now (null: no
 * route runs). The next line is shown as soon as it is due; the shown line
 * goes after HELM_LINE_SHOW_MS, at another run, while paused, or with no
 * route. Returns `a` itself when nothing changed, so the caller repaints only
 * on a new object's `shown`. Pure.
 */
export function helmAnnouncerStep(a: HelmAnnouncer, v: PilotLineView | null): HelmAnnouncer {
  if (!v) return a.speech === null && a.shown === null ? a : freshHelmAnnouncer();
  const line = pilotLine(v, a.speech);
  if (line) {
    return {
      speech: pilotSpeechAfter(v, a.speech, line),
      shown: { text: line.text, run: v.route.startedAt, at: v.now },
    };
  }
  if (a.shown && (a.shown.run !== v.route.startedAt || v.f.paused || v.now - a.shown.at >= HELM_LINE_SHOW_MS)) {
    return { ...a, shown: null };
  }
  return a;
}

// ── Readers (thin, effectful) ────────────────────────────────────────────────

/** The dock the running route in this room names as captain, or null. */
export function readRouteCaptainDockId(): string | null {
  try {
    return routeCaptainDockId(readShipRoute());
  } catch {
    return null;
  }
}

/** The lock for dock `dockId` in this room now (null: free). */
export function readCaptainLock(dockId: string): string | null {
  try {
    return captainLockRefusal(readShipRoute(), dockId);
  } catch {
    return null;
  }
}

function roomOf(seed: string): string {
  try {
    return roomIdFromSeed(seed);
  } catch {
    return '';
  }
}

/** A gate number by far room and door: this game's atlas, else the stop's
 *  station in its directory. Read fresh each time (a few times a second
 *  while docked): gate data can arrive after the dock, or be renumbered. */
function gateLookup(stop: RouteStop): (roomId: string, farDoor: string) => number | undefined {
  return (roomId, farDoor) => {
    const gate = readAtlas()[roomId]?.gates?.[farDoor];
    if (gate !== undefined) return gate;
    const st = directoryStationFor(stop);
    for (const b of [st?.berth, ...(st?.berths ?? [])]) {
      if (b && b.farDoor === farDoor && b.gate !== undefined && roomOf(b.address) === roomId) return b.gate;
    }
    return undefined;
  };
}

/**
 * What the captain reads at `now`: the running route, its timetable's
 * flight, the route port's dock at the stop and why a stay is skipped — or
 * null when no route runs unpaused-or-paused in this room (or no flight can
 * be derived).
 */
export function readPilotView(now = Date.now()): PilotLineView | null {
  const route = readShipRoute();
  if (!isRouteRunning(route)) return null;
  const f = readRouteFlight(now);
  if (!f) return null;
  const stop = route.stops[f.stopIndex];
  let dock: PilotDock | null = null;
  if (stop && f.status === 'docked') {
    const rec = readDoor(route.shipPort);
    if (rec && rec.paired === true && typeof rec.connectedRoomAddress === 'string') {
      const roomId = roomOf(rec.connectedRoomAddress);
      if (roomId) {
        const atStop = sameStationReader()(stop, roomId);
        const farDoor = typeof rec.farDoor === 'string' ? rec.farDoor : undefined;
        dock = pilotDockAt(stop, { roomId, ...(farDoor !== undefined ? { farDoor } : {}) }, atStop, gateLookup(stop));
      }
    }
  }
  return { route, f, now, dock, skipWhy: staySkipWhy(f, readRouteCheckpoints()) };
}
