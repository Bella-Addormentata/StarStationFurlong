/**
 * 🚏🤖⚓ Gate keeper — a station docks a scheduled ferry with nobody aboard
 * (robot pilot routes, open choice 8, step 1; Dorkmo, 2026-09-27: "can we
 * build in auto accept logic into the docks to allow empty docking?").
 *
 * A route ferry is docked and cast off by its own keeper (routeKeeper.ts),
 * which runs in the games of the people aboard. With nobody aboard, nothing
 * docks it: the timetable flies it past every stop (the boards say NOT
 * DOCKED), and a ferry left docked stays there (DELAYED) until a rider
 * boards. A gate whose owner turned on AUTO-DOCK (doorPolicy `autoFerry`, the
 * gate line of the door panel) lets the STATION do it instead.
 *
 * Every game standing in a room with an auto-dock gate runs this keeper once
 * a second (main.ts's 1 Hz watch). It reads the ferries that call at the room
 * from the room's own departures map (departuresDoc.ts, what the boards
 * read), works out each one's timetable as the board does, and near an
 * arrival or a departure here opens a background session to the FERRY's room
 * (roomSession.ts). In that session it reads the ferry's own route,
 * checkpoints and doors, the ones its riders' keepers read, and runs their
 * decision on them (routeKeeper.keeperStep). It acts only on this room's
 * auto-dock gates:
 *
 *   keeperStep says       the gate keeper
 *   ───────────────       ───────────────
 *   dock                  DOCKS the ferry's route port at a free auto-dock
 *                         gate that admits it (open, or reserved for it): the
 *                         stop's own gate first, another only when the stop
 *                         allows a gate change. GATE_DOCK_DEFER_MS after the
 *                         arrival, so a rider's keeper goes first.
 *   cast off              UNDOCKS the ferry from this room's gate,
 *                         GATE_CAST_OFF_DEFER_MS after the departure (inside
 *                         the keeper's CAST_OFF_LATE_MS, so the leg stands).
 *                         A dock anywhere else is not this keeper's.
 *   write end-hold,       for a dock one of this room's auto-dock gates
 *     restart, anchor     holds: writes that checkpoint into the ferry's
 *                         ship map and, once the ferry's room acknowledges
 *                         it, publishes the ferry to every stop's board it
 *                         can reach (a restart is a ferry found docked after
 *                         its departure: its stay starts again)
 *   anything else         nothing: holds and skips are its riders' to write
 *
 * ─── Docking from the station side ───────────────────────────────────────────
 *
 * A dock has two records, one in each room. This keeper writes the GATE's
 * first (a claim on the berth, in the room it stands in), waits for
 * concurrent claims to settle, then the FERRY's in the session, through the
 * same far-room decision a ship's DOCK uses (farDoorWrite.applyFarDockRequest:
 * compare-and-swap on the port's record), acknowledged by the node and
 * checked again after a settle window (berthAfterSettle). Writing the gate
 * first means a rider's DOCK crossing it meets the claim at the gate and
 * JOINS it (docking.ts redockPortAnswer's `superseded` rule), so both ends
 * hold one stamp. A refused or lost ferry side takes the claim back, as does
 * a gate whose AUTO-DOCK is switched off (or that stops admitting the ferry)
 * while its claim settles. A cast-off writes both ends in the same tick: the
 * ferry's port remembers the gate, and the gate remembers the ferry. Nothing
 * is written to the gate once the keeper has reset (the player left, even if
 * they came straight back).
 *
 * The gate's record needs the ferry's address and its port's pose (the far
 * wall and lateral): both come from a record in this room that names the
 * ferry through its route port (ferryBerthingIn): a dock made here before,
 * live or remembered. So a ferry docks automatically at a station once it has
 * docked in that room with someone aboard (a gate change to any free
 * auto-dock gate of the room included). The keeper docks and casts off
 * only while the ferry's own route names the port that the departures entry
 * here names: a newer route on another port waits until this board has heard
 * of it (the session tells it).
 *
 * ─── Keeping the two ends agreeing ───────────────────────────────────────────
 *
 * The ferry's doors are what its timetable reads, so the gate follows the
 * ferry (gateFixes), checked before every step: a dock the ferry's port holds
 * to an auto-dock gate is taken by the gate too (a far write that never
 * landed here, the walk-through mirror's job); a dock the gate holds that the
 * ferry has provably let go (its port undocked after it, or docked elsewhere
 * since) or has not held for GATE_STALE_MS is let go at the gate; an undock
 * made at the gate after the ferry's dock reaches the ferry; and a gate that
 * has taken another pairing keeps it while the ferry's port lets go. A claim
 * at a gate that the keeper has not yet seen the ferry's port hold, or a gate
 * that let go of the ferry before its port was seen to, keeps a session open
 * until the two ends agree, whatever the route does (paused, ended or
 * finished). So does what the keeper left under way at a gate whose AUTO-DOCK
 * is switched off since: it is settled there, but nothing new is docked or
 * cast off at that gate. A write to the ferry's room that is never
 * acknowledged hangs its session up, so nothing is read from a doc the room
 * may never hold: a fresh session reads what the room does hold (at once,
 * then backing off while acknowledgments keep failing), and what is missing
 * is written again.
 *
 * ─── Limits (v1) ─────────────────────────────────────────────────────────────
 *
 * Someone must stand in the gate's room (a node-side keeper is the next
 * step). Only stops whose berth room is this room. Only gates open to all or
 * reserved for the ferry: a gate for granted captains admits people, and a
 * ferry with nobody aboard has no key. A station move under way, or this
 * room in flight, docks nothing.
 *
 * Pure decisions (ferryBerthingIn, dockableGates, stationLook,
 * gateSessionWanted, ferryLook, gateMove, gateFixes) over the departures
 * entry, this room's records and the ferry's doc; the two-ended writes
 * (stationDock, stationCastOff) over a session; and a thin loop
 * (createGateKeeper). Pinned by gateKeeper.test.ts.
 */

import * as Y from 'yjs';
import { dockChain, isDockChain } from './adapter';
import type { FarDockRequest } from './docking';
import {
  berthMemoryFrom,
  classifyDockPort,
  gateAdmits,
  holdsDockTo,
  stampAfter,
  type DockPortState,
  type NearEnd,
} from './dockRules';
import { ferryDocksHere, type BoardDock } from './departuresBoard';
import { publishRoomOrder, type DepartureFerry, type DeparturesPublish } from './departuresDoc';
import type { DoorWall } from './doorLayoutDoc';
import { dockPortFlagIn, type GateAccess } from './doorPolicy';
import {
  buildDoorPairing,
  buildDoorTombstone,
  readAllDoorsFrom,
  readDoorFrom,
  type DoorPairing,
  type DoorRecord,
  type DoorTombstone,
} from './doorsDoc';
import { applyFarDockRequest, berthAfterSettle } from './farDoorWrite';
import {
  GUARD_BAND_MS,
  createRouteWalkCache,
  isRouteRunning,
  liveDockFrom,
  routeFlightAt,
  routeRulesFlight,
  type LiveDockAt,
  type RouteFlight,
  type RouteWalkCache,
} from './pilotRoute';
import {
  KEEPER_RETRY_MAX_MS,
  KEEPER_RETRY_MS,
  keeperMemoryAt,
  keeperStep,
  newestTimedStay,
  standingHold,
  stayHasDock,
  stayResumed,
  type KeeperDocks,
  type KeeperMemory,
  type KeeperPort,
  type KeeperStep,
  type KeeperView,
} from './routeKeeper';
import {
  checkpointToWire,
  routeIn,
  routeToWire,
  writeRouteCheckpointIn,
  type RouteCheckpoint,
  type RouteStop,
  type ShipRoute,
} from './shipRoute';
import { ROOM_SESSION_OPEN_MS } from './roomSession';
import { roomIdFromSeed } from './stationAtlas';

// ── Constants ────────────────────────────────────────────────────────────────

/** A dock starts no sooner than this after the arrival: a rider's keeper
 *  docks at once, and its far write may take a few seconds to land here. */
export const GATE_DOCK_DEFER_MS = 8_000;
/** A cast-off at the departure waits this long for a rider's keeper (its own
 *  is at the departure), well inside routeKeeper.CAST_OFF_LATE_MS. */
export const GATE_CAST_OFF_DEFER_MS = 3_000;
/** A session to the ferry opens this long before its departure from here, so
 *  it is ready to cast off on time: a whole open (roomSession's deadline) and
 *  a quarter minute to spare, well before the keeper's CAST_OFF_LATE_MS after
 *  the departure would restart the stay instead. */
export const GATE_PRE_DIAL_MS = ROOM_SESSION_OPEN_MS + 15_000;
/** A session still wanted is replaced by a fresh one after this long (one
 *  whose transport died says nothing), except around a departure. */
export const GATE_SESSION_MAX_MS = 3 * 60_000;
/** The first wait after a dial that failed (or a session that closed),
 *  doubling to GATE_REDIAL_MAX_MS. */
export const GATE_REDIAL_MS = 30_000;
export const GATE_REDIAL_MAX_MS = 5 * 60_000;
/** A gate's dock the ferry has not held for this long is let go (a far
 *  session's whole deadline: any DOCK still under way has ended by then). */
export const GATE_STALE_MS = 60_000;
/** How long a dock waits for concurrent claims to arrive (farDoorWrite's). */
export const GATE_SETTLE_MS = 1_500;
/** How long the node may take to acknowledge a write. */
export const GATE_ACK_MS = 5_000;

/** The ship map's name in a room doc (shipDoc.ts). */
const SHIP_MAP = 'ship';

// ── What this room knows ─────────────────────────────────────────────────────

function roomOf(address: string | undefined): string {
  if (!address) return '';
  try {
    return roomIdFromSeed(address);
  } catch {
    return '';
  }
}

/** One of this room's auto-dock gates, as the keeper reads it. */
export interface GateView {
  doorId: string;
  /** Its gate number, when it has one. */
  gate?: number;
  /** Who it admits (doorPolicy gateAccess; absent = open). */
  access?: GateAccess;
  reservedFor?: string;
  /** Its record in this room's doors map. */
  record: DoorRecord | undefined;
  /** Its AUTO-DOCK is off since this keeper last had business there: only
   *  what it left under way is settled (gateFixes takes no new dock here). */
  retired?: true;
}

/** Is `farDoor` (a record's far door, or its dock memory's) the ferry's
 *  route port? An older writer's record names none, and then reads as it, as
 *  the boards and dockRules read it. */
const namesPort = (farDoor: string | undefined, shipPort: string): boolean => !farDoor || farDoor === shipPort;

/** Does this record hold a DOCK to the ferry's route port? */
export function holdsFerry(rec: DoorRecord | undefined, shipRoomId: string, shipPort: string): rec is DoorPairing {
  return !!rec && rec.paired === true && isDockChain(rec.segments)
    && roomOf(rec.connectedRoomAddress) === shipRoomId && namesPort(rec.farDoor, shipPort);
}

/** What a gate's record needs to name the ferry: an address that reaches its
 *  room, and its route port's pose. */
export interface FerryBerthing {
  address: string;
  farWall?: DoorWall;
  farLateral?: number;
}

/**
 * The newest record of this room that names the ferry through its route
 * port (an unnamed far door included, as holdsFerry reads it): a dock to it,
 * or a dock tombstone that remembers it. Null when there is none (the ferry
 * never docked in this room with someone aboard): then nothing here can
 * address it or pose its port. Pure.
 */
export function ferryBerthingIn(
  doors: ReadonlyMap<string, DoorRecord>,
  shipRoomId: string,
  shipPort: string,
): FerryBerthing | null {
  let best: { at: number; b: FerryBerthing } | null = null;
  const take = (at: number, address: string, farWall?: DoorWall, farLateral?: number): void => {
    if (best && best.at >= at) return;
    best = {
      at,
      b: { address, ...(farWall ? { farWall } : {}), ...(farLateral !== undefined ? { farLateral } : {}) },
    };
  };
  for (const rec of doors.values()) {
    if (rec.paired) {
      if (!holdsFerry(rec, shipRoomId, shipPort)) continue;
      take(rec.dockedAt ?? 0, rec.connectedRoomAddress, rec.farWall, rec.farLateral);
    } else if (rec.dock && namesPort(rec.dock.farDoor, shipPort) && roomOf(rec.retiredAddress) === shipRoomId) {
      take(rec.dock.undockedAt, rec.retiredAddress, rec.dock.farWall, rec.dock.farLateral);
    }
  }
  return best === null ? null : (best as { b: FerryBerthing }).b;
}

/** Does the gate admit the ferry (open, or reserved for it)? A gate for
 *  granted captains admits people, and nobody is aboard. */
function admitsFerry(g: GateView, shipRoomId: string): boolean {
  return gateAdmits(
    { access: g.access ?? 'open', ...(g.reservedFor ? { reservedFor: g.reservedFor } : {}) },
    shipRoomId,
    false,
  );
}

/**
 * The auto-dock gates the ferry may dock at for this stop, in order: free
 * (no live pairing) and admitting it; the stop's own gate first, then — only
 * when the stop allows a gate change — the others by gate number. Pure.
 */
export function dockableGates(gates: readonly GateView[], stop: RouteStop, shipRoomId: string): GateView[] {
  const free = gates.filter((g) => g.record?.paired !== true && admitsFerry(g, shipRoomId));
  const own = free.filter((g) => g.doorId === stop.berth.farDoor);
  if (!stop.berth.anyGate) return own;
  const rest = free
    .filter((g) => g.doorId !== stop.berth.farDoor)
    .sort((a, b) => (a.gate ?? Infinity) - (b.gate ?? Infinity) || (a.doorId < b.doorId ? -1 : a.doorId > b.doorId ? 1 : 0));
  return [...own, ...rest];
}

/** This room's pairings to the ferry, as the board reads them. */
export function boardDocksOf(
  doors: ReadonlyMap<string, DoorRecord>,
  shipRoomId: string,
  gates: Readonly<Record<string, number>> = {},
): BoardDock[] {
  const out: BoardDock[] = [];
  for (const [doorId, rec] of doors) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    if (rec.transient !== true && !isDockChain(rec.segments)) continue;
    if (roomOf(rec.connectedRoomAddress) !== shipRoomId) continue;
    const d: BoardDock = { dockedAt: typeof rec.dockedAt === 'number' && Number.isFinite(rec.dockedAt) ? rec.dockedAt : 0 };
    if (gates[doorId] !== undefined) d.gate = gates[doorId];
    if (rec.farDoor) d.farDoor = rec.farDoor;
    out.push(d);
  }
  return out;
}

// ── The station's view: when to look closer ─────────────────────────────────

/** A ferry as this room's departures map has it, worked out like a board. */
export interface StationLook {
  /** Its timetable, with this room's docks as the live dock (null: none). */
  f: RouteFlight | null;
  /** This room's newest pairing to it, or null. */
  dockedAt: number | null;
  /** Its stay is at a stop whose berth room is this room. */
  atHere: boolean;
}

/** The ferry's timetable as this room sees it (departuresBoard.ferryRow's
 *  reading, with this room alone as "here"). Pure. */
export function stationLook(
  ferry: DepartureFerry,
  roomId: string,
  docks: readonly BoardDock[],
  now: number,
  cache?: RouteWalkCache,
): StationLook {
  const route = ferry.route;
  const isHere = (s: RouteStop | undefined): boolean => !!s && s.berth.roomId === roomId;
  const { at, held } = ferryDocksHere(docks, route.shipPort);
  const liveDock: LiveDockAt = Object.assign(
    (s: RouteStop) => (at !== null && isHere(s) ? at : null),
    { held },
  );
  const f = isRouteRunning(route) ? routeFlightAt(route, ferry.checkpoints, liveDock, now, ferry.capacity, cache) : null;
  return { f, dockedAt: at, atHere: !!f && f.status === 'docked' && isHere(route.stops[f.stopIndex]) };
}

/**
 * Is a session to the ferry wanted now? Docked here: when its stay has moved
 * on (a cast-off to make, or a dock left over), a hold is to end, or its
 * departure is GATE_PRE_DIAL_MS away. Not docked here: from its arrival at a
 * stop of this room until the guard band before its departure (not a stay it
 * skips, nor a route that has ended or is paused). Pure.
 */
export function gateSessionWanted(look: StationLook, now: number): boolean {
  const f = look.f;
  if (!f || f.paused) return false;
  if (look.dockedAt !== null) {
    if (!look.atHere || f.holding) return true;
    if (f.ended !== null || f.departsAt === null) return false;
    return now >= f.departsAt - GATE_PRE_DIAL_MS;
  }
  if (!look.atHere || f.skipped || f.ended !== null) return false;
  if (f.departsAt !== null && now >= f.departsAt - GUARD_BAND_MS) return false;
  return f.holding || (f.stayStart !== null && now >= f.stayStart);
}

/** Is the ferry's departure from here close (GATE_PRE_DIAL_MS either side)?
 *  A session is then never recycled: the cast-off must not wait on a dial.
 *  Pure. */
export function departureClose(look: StationLook, now: number): boolean {
  const at = look.f?.departsAt ?? null;
  return look.atHere && at !== null && now >= at - GATE_PRE_DIAL_MS && now <= at + GATE_PRE_DIAL_MS;
}

// ── The ferry's own view (in the session) ────────────────────────────────────

/** What the ferry's doc says, as its riders' keepers read it. */
export interface FerryLook {
  view: KeeperView;
  /** The route port's record in the ferry's doors map. */
  port: DoorRecord | undefined;
  checkpoints: readonly RouteCheckpoint[];
}

function classify(rec: DoorRecord | undefined): DockPortState {
  try {
    return classifyDockPort(rec);
  } catch {
    return { kind: 'free' };
  }
}

/**
 * Everything keeperStep needs, read from the FERRY's doc: its route and
 * checkpoints (shipRoute.routeIn), its live berth docks (each paired door
 * that is a dock or a guest berth: the timetable's live dock), its route
 * port. Every dock on a door other than the route's port is `stuck`: this
 * keeper may release none of them. Null when no route runs unpaused there.
 * Pure over the doc.
 */
export function ferryLook(o: {
  doc: Y.Doc;
  capacity: number;
  now: number;
  /** Is a room part of a stop's station (routeKeeper.sameStationReader)? */
  sameStation: (stop: RouteStop, roomId: string) => boolean;
  memory: KeeperMemory | null;
  towing?: boolean;
  cache?: RouteWalkCache;
}): FerryLook | null {
  const { route, checkpoints } = routeIn(o.doc.getMap(SHIP_MAP), o.now);
  if (!isRouteRunning(route)) return null;
  const docks: Array<{ doorId: string; roomId: string; dockedAt: number }> = [];
  for (const [doorId, rec] of readAllDoorsFrom(o.doc)) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    if (rec.transient !== true && !isDockChain(rec.segments)) continue;
    const roomId = roomOf(rec.connectedRoomAddress);
    if (!roomId) continue;
    const at = rec.dockedAt;
    docks.push({ doorId, roomId, dockedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
  }
  const f = routeFlightAt(route, checkpoints, liveDockFrom(docks, o.sameStation, { routePort: route.shipPort }), o.now, o.capacity, o.cache);
  if (!routeRulesFlight(f)) return null;
  const stop = route.stops[f.stopIndex];
  const next = route.stops[f.nextStopIndex];
  const portRec = readDoorFrom(o.doc, route.shipPort);
  const isPort = dockPortFlagIn(o.doc, route.shipPort) || (portRec?.paired === true && isDockChain(portRec.segments));
  const state = isPort ? classify(portRec) : null;
  const portRoom = state?.kind === 'docked' ? state.roomId : '';
  const atStop = !!portRoom && !!stop && o.sameStation(stop, portRoom);
  const port: KeeperPort = state
    ? {
        state: state.kind,
        // A DOCK or UNDOCK the ferry's riders run is theirs to know; the
        // compare-and-swap at each end settles a crossing.
        busy: false,
        atStop,
        atOtherStop: !!portRoom && !atStop && route.stops.some((s, i) => i !== f.stopIndex && o.sameStation(s, portRoom)),
      }
    : { state: 'missing', busy: false, atStop: false, atOtherStop: false };
  const kd: KeeperDocks = { atStop: null, atNext: null, elsewhere: 0, stuck: 0 };
  for (const d of docks) {
    if (stop && o.sameStation(stop, d.roomId)) kd.atStop = Math.max(kd.atStop ?? 0, d.dockedAt);
    else if (f.status !== 'docked' && next && o.sameStation(next, d.roomId)) kd.atNext = Math.max(kd.atNext ?? 0, d.dockedAt);
    else kd.elsewhere++;
    if (d.doorId !== route.shipPort) kd.stuck = (kd.stuck ?? 0) + 1;
  }
  return {
    view: {
      now: o.now,
      route,
      flight: f,
      port,
      docks: kd,
      hold: standingHold(checkpoints, f.legSeq),
      stayDock: stayHasDock(checkpoints, f.legSeq),
      stayResume: stayResumed(checkpoints, f.legSeq),
      towing: o.towing === true,
      anchorSeq: newestTimedStay(checkpoints, f.legSeq),
      memory: keeperMemoryAt(o.memory, route.startedAt, f.legSeq),
    },
    port: portRec,
    checkpoints,
  };
}

// ── What the gate keeper does with a step ────────────────────────────────────

export type GateMove =
  | { kind: 'none'; why: 'idle' | 'defer' | 'not-here' | 'claimed' | 'no-gate' | 'not-ours' | 'renew' }
  /** Dock the ferry at this gate. */
  | { kind: 'dock'; gate: GateView }
  /** Cast the ferry off this gate. */
  | { kind: 'cast-off'; gate: GateView }
  /** Write this checkpoint into the ferry's ship map. */
  | { kind: 'write'; why: 'end-hold' | 'restart' | 'anchor'; entry: RouteCheckpoint };

const none = (why: Extract<GateMove, { kind: 'none' }>['why']): GateMove => ({ kind: 'none', why });

/**
 * The gate keeper's part of a keeper step (the header's table). `near` gives
 * a gate's end of a dock (this room, its address, the gate and its pose).
 * Pure.
 */
export function gateMove(o: {
  step: KeeperStep;
  look: FerryLook;
  gates: readonly GateView[];
  /** Gates whose AUTO-DOCK is off since this keeper had business there
   *  (`retired`): nothing is docked, cast off or written for them, but a
   *  claim there still holds a dock back. */
  settling?: readonly GateView[];
  roomId: string;
  shipRoomId: string;
  near: (doorId: string) => NearEnd;
  now: number;
}): GateMove {
  const { step, look, now } = o;
  const f = look.view.flight;
  switch (step.kind) {
    case 'idle':
      return none('idle');
    case 'write':
      // A renewal answers a hold this keeper saw the berth refuse: it never
      // writes holds.
      if (step.why === 'renew-hold') return none('renew');
      // The stay's entries are written for a dock one of this room's
      // auto-dock gates holds; a dock anywhere else is its maker's.
      if (!o.gates.some((g) => holdsDockTo(look.port, o.near(g.doorId)))) return none('not-ours');
      return { kind: 'write', why: step.why, entry: step.entry };
    case 'cast-off': {
      const gate = o.gates.find((g) => holdsDockTo(look.port, o.near(g.doorId)));
      if (!gate) return none('not-ours');
      if (step.why === 'departure' && f.departsAt !== null && now < f.departsAt + GATE_CAST_OFF_DEFER_MS) return none('defer');
      return { kind: 'cast-off', gate };
    }
    case 'dock': {
      const stop = look.view.route.stops[f.stopIndex];
      if (!stop || stop.berth.roomId !== o.roomId) return none('not-here');
      // A gate's claim on the ferry its port does not hold is a DOCK under
      // way (a rider's, or this keeper's own unacknowledged one): it lands,
      // or the gate lets it go (gateFixes). Never a second dock beside it.
      if ([...o.gates, ...(o.settling ?? [])].some((g) => holdsFerry(g.record, o.shipRoomId, look.view.route.shipPort))) {
        return none('claimed');
      }
      if (f.stayStart !== null && now < f.stayStart + GATE_DOCK_DEFER_MS) return none('defer');
      const gate = dockableGates(o.gates, stop, o.shipRoomId)[0];
      return gate ? { kind: 'dock', gate } : none('no-gate');
    }
  }
}

// ── Keeping the gate and the ferry agreeing ──────────────────────────────────

export type GateFix =
  /** The ferry's port holds a dock to this gate: the gate takes it too. */
  | { kind: 'join'; gate: string; record: DoorPairing }
  /** The gate holds a dock the ferry has let go: the gate lets go too. */
  | { kind: 'release-gate'; gate: string; record: DoorTombstone }
  /** The gate let go after the ferry's dock: the ferry lets go too. */
  | { kind: 'release-ferry'; gate: string; undockedAt: number };

/**
 * Where an auto-dock gate and the ferry's route port disagree, what makes the
 * gate follow the ferry (the header's "Keeping the two ends agreeing").
 * `heldFor` says how long this keeper has watched the gate hold its current
 * pairing. A gate holding another pairing keeps it, and a ferry's port that
 * holds a dock to it lets go. A `retired` gate takes no new dock. Pure.
 */
export function gateFixes(o: {
  gates: readonly GateView[];
  port: DoorRecord | undefined;
  shipRoomId: string;
  shipPort: string;
  berthing: FerryBerthing | null;
  near: (doorId: string) => NearEnd;
  heldFor: (doorId: string, rec: DoorPairing) => number;
  now: number;
}): GateFix[] {
  const out: GateFix[] = [];
  const port = o.port;
  const join = (doorId: string, mine: FerryBerthing, x: number | undefined): GateFix => ({
    kind: 'join',
    gate: doorId,
    record: buildDoorPairing(mine.address, {
      segments: dockChain(),
      farDoor: o.shipPort,
      farWall: mine.farWall,
      farLateral: mine.farLateral,
      transient: true,
      ...(x !== undefined ? { dockedAt: x } : {}),
    }),
  });
  for (const g of o.gates) {
    const rec = g.record;
    if (port?.paired === true && holdsDockTo(port, o.near(g.doorId))) {
      const x = port.dockedAt;
      if (rec?.paired === true) {
        // The same dock under another stamp: the gate takes the ferry's.
        if (holdsFerry(rec, o.shipRoomId, o.shipPort)) {
          if (rec.dockedAt !== x) {
            out.push(join(g.doorId, { address: rec.connectedRoomAddress, farWall: rec.farWall, farLateral: rec.farLateral }, x));
          }
          continue;
        }
        // Another ship's dock, another door of the ferry's, or a gangway:
        // no dock may take the gate from it (dockRules.farDockPatch), so the
        // gate keeps it and the ferry's port lets go.
        out.push({ kind: 'release-ferry', gate: g.doorId, undockedAt: stampAfter(x, o.now) });
        continue;
      }
      // Nor is a plain tombstone: a port taken off since, or a gangway's
      // end, which no dock may re-make (dockRules.farDockPatch).
      if (rec && !rec.dock) continue;
      // The gate let go after the ferry's dock: the ferry lets go too.
      if (rec?.dock && x !== undefined && rec.dock.undockedAt >= x) {
        out.push({ kind: 'release-ferry', gate: g.doorId, undockedAt: rec.dock.undockedAt });
        continue;
      }
      // A far write that never landed here: the gate takes the dock, if it
      // admits the ferry, posed from its own memory of it, else the room's.
      if (g.retired || !admitsFerry(g, o.shipRoomId)) continue;
      const mine: FerryBerthing | null =
        rec?.dock && namesPort(rec.dock.farDoor, o.shipPort) && roomOf(rec.retiredAddress) === o.shipRoomId
          ? { address: rec.retiredAddress, farWall: rec.dock.farWall, farLateral: rec.dock.farLateral }
          : o.berthing;
      if (mine) out.push(join(g.doorId, mine, x));
      continue;
    }
    if (!holdsFerry(rec, o.shipRoomId, o.shipPort)) continue;
    // The gate holds the ferry; the ferry's port does not hold the gate.
    const stamp = rec.dockedAt;
    const portUndock = port && !port.paired && port.dock ? port.dock.undockedAt : undefined;
    const undockedSince = portUndock !== undefined && (stamp === undefined || portUndock >= stamp);
    const dockedSince = port?.paired === true && port.dockedAt !== undefined && (stamp === undefined || port.dockedAt > stamp);
    if (!undockedSince && !dockedSince && o.heldFor(g.doorId, rec) < GATE_STALE_MS) continue;
    const undockedAt = Math.max(stampAfter(stamp, o.now), portUndock ?? Number.NEGATIVE_INFINITY);
    out.push({
      kind: 'release-gate',
      gate: g.doorId,
      record: buildDoorTombstone(rec.connectedRoomAddress, berthMemoryFrom(rec, undockedAt)),
    });
  }
  return out;
}

// ── The two-ended writes ─────────────────────────────────────────────────────

/** A session's doc and its acknowledgment (roomSession.RoomSession). */
export interface FerryDocSession {
  readonly doc: Y.Doc;
  confirm(since: Uint8Array, timeoutMs: number): Promise<boolean>;
}

/** This room's side of a dock: its gate's record, read and written now. */
export interface GateEnd {
  /** The gate's end of the dock (this room, its address, the gate, its pose). */
  near: NearEnd;
  /** The gate's record now, whatever its gate setting. */
  read: () => DoorRecord | undefined;
  /** Write the gate's record; false when this room is no longer the one
   *  bound (the player walked on, even if they came straight back). */
  write: (rec: DoorRecord) => boolean;
  /** Is it still a gate this keeper docks at: written to as above, its
   *  AUTO-DOCK still on, admitting the ferry? */
  live: () => boolean;
}

export type StationDockResult =
  | { ok: true; dockedAt: number; joined?: boolean }
  | {
      ok: false;
      reason:
        /** The gate holds another ship now. */
        | 'taken'
        /** The gate holds a claim on the ferry its port does not: a DOCK
         *  under way, which lands or is let go (gateFixes). */
        | 'claimed'
        /** The ferry's port is docked elsewhere. */
        | 'occupied'
        /** The ferry's route door is gone, or wears no port. */
        | 'no-port'
        /** The ferry's port refused (closed, gone, not-allowed, no-gate). */
        | 'refused'
        /** Another claim on the gate won it meanwhile. */
        | 'lost'
        /** The ferry's side was written but never acknowledged: it may still
         *  land (the gate keeps the claim; gateFixes settles it). */
        | 'unconfirmed'
        /** The player left the room. */
        | 'left'
        /** The gate stopped being one this keeper docks at while its claim
         *  settled (AUTO-DOCK switched off, it no longer admits the ferry, or
         *  the keeper reset): the claim is taken back where it may be. */
        | 'disabled';
    };

/**
 * DOCK the ferry's route port at this gate, from the station side (the
 * header's "Docking from the station side"): the gate's claim first, then the
 * ferry's side through the far-room decision, each settled; a refusal or a
 * lost ferry side takes the claim back. A port already docked to this gate is
 * joined; a claim on the ferry the gate already holds is left to land. The
 * request carries no requester key: nobody aboard docks it, so a ferry port
 * open only to granted captains refuses it, whoever stands in the station.
 * Never throws.
 */
export async function stationDock(o: {
  session: FerryDocSession;
  gate: GateEnd;
  shipRoomId: string;
  shipPort: string;
  berthing: FerryBerthing;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}): Promise<StationDockResult> {
  const { session, gate, shipRoomId, shipPort, berthing } = o;
  const doc = session.doc;
  const held = (rec: DoorRecord | undefined): rec is DoorPairing => holdsFerry(rec, shipRoomId, shipPort);
  const pairingAt = (dockedAt: number): DoorPairing =>
    buildDoorPairing(berthing.address, {
      segments: dockChain(),
      farDoor: shipPort,
      farWall: berthing.farWall,
      farLateral: berthing.farLateral,
      transient: true,
      dockedAt,
    });
  /** Make the gate agree with a dock the ferry's port holds under `stamp`. */
  const join = (stamp: number): StationDockResult =>
    (gate.write(pairingAt(stamp)) ? { ok: true, dockedAt: stamp, joined: true } : { ok: false, reason: 'left' });

  const before = gate.read();
  const port = readDoorFrom(doc, shipPort);
  if (port?.paired === true) {
    if (!holdsDockTo(port, gate.near) || port.dockedAt === undefined) return { ok: false, reason: 'occupied' };
    // Docked to this very gate already: the gate takes the port's stamp
    // (never over another ship's dock).
    return before?.paired === true && !held(before) ? { ok: false, reason: 'taken' } : join(port.dockedAt);
  }
  if (before?.paired === true) return { ok: false, reason: held(before) ? 'claimed' : 'taken' };
  const portExists = (() => {
    try {
      return dockPortFlagIn(doc, shipPort);
    } catch {
      return false;
    }
  })();
  if (!portExists) return { ok: false, reason: 'no-port' };

  // Causally after both ends' last undock, whatever this clock says.
  const gateUndock = before && !before.paired ? before.dock?.undockedAt : undefined;
  const portUndock = port && !port.paired ? port.dock?.undockedAt : undefined;
  const after = Math.max(gateUndock ?? Number.NEGATIVE_INFINITY, portUndock ?? Number.NEGATIVE_INFINITY);
  const dockedAt = stampAfter(Number.isFinite(after) ? after : undefined, o.now());
  /** Take the gate's claim back (only while it is still ours). */
  const takeBack = (): void => {
    const rec = gate.read();
    if (!held(rec) || rec.dockedAt !== dockedAt) return;
    gate.write(buildDoorTombstone(berthing.address, berthMemoryFrom(rec, stampAfter(dockedAt, o.now()))));
  };

  // 1. The claim at the gate, and a moment for any other claim to arrive.
  if (!gate.write(pairingAt(dockedAt))) return { ok: false, reason: 'left' };
  await o.wait(GATE_SETTLE_MS);
  const claimed = gate.read();
  if (!held(claimed) || claimed.dockedAt !== dockedAt) {
    // Another claim won the gate: theirs to finish (gateFixes settles it).
    return { ok: false, reason: 'lost' };
  }
  // No keeper settles a claim at a gate that is no longer auto-dock: it is
  // taken back before the ferry's side is asked.
  if (!gate.live()) {
    takeBack();
    return { ok: false, reason: 'disabled' };
  }

  // 2. The ferry's side: the far-room decision a ship's DOCK uses.
  const req: Extract<FarDockRequest, { kind: 'dock' }> = {
    kind: 'dock',
    nearRoomId: gate.near.roomId,
    ...(gateUndock !== undefined ? { replacesUndockedAt: gateUndock } : {}),
    farAddress: berthing.address,
    farDoor: shipPort,
    nearDoorId: gate.near.doorId,
    ...(gate.near.wall !== undefined ? { nearWall: gate.near.wall } : {}),
    ...(gate.near.lateral !== undefined ? { nearLateral: gate.near.lateral } : {}),
    dockedAt,
  };
  const since = Y.encodeStateVector(doc);
  let applied: ReturnType<typeof applyFarDockRequest>;
  try {
    applied = applyFarDockRequest(doc, req, gate.near);
  } catch (err) {
    console.warn('[gate] ferry-side dock threw:', err);
    takeBack();
    return { ok: false, reason: 'refused' };
  }
  const { result, wrote } = applied;
  if (!result.ok) {
    // The ferry's port took a dock to this very gate meanwhile: join it.
    if (result.reason === 'superseded' && result.stamp !== undefined) {
      const now = readDoorFrom(doc, shipPort);
      if (holdsDockTo(now, gate.near)) return join(result.stamp);
    }
    takeBack();
    return { ok: false, reason: result.reason === 'occupied' ? 'occupied' : 'refused' };
  }
  if (wrote && !(await session.confirm(since, GATE_ACK_MS))) {
    return { ok: false, reason: 'unconfirmed' };
  }
  // 3. Concurrent claims on the ferry's port get a moment; then only the claim
  // its port still holds has docked.
  await o.wait(GATE_SETTLE_MS);
  const lost = berthAfterSettle(doc, req, gate.near);
  if (lost) {
    if (!lost.ok && lost.reason === 'superseded' && lost.stamp !== undefined) return join(lost.stamp);
    takeBack();
    return { ok: false, reason: !lost.ok && lost.reason === 'occupied' ? 'occupied' : 'refused' };
  }
  return { ok: true, dockedAt };
}

/**
 * Cast the ferry off this gate, from the station side: the ferry's port
 * remembers the gate (farDoorWrite's UNDOCK decision), and the gate remembers
 * the ferry, written in one tick. Returns whether the ferry's doc was written
 * and the state vector to confirm it from.
 */
export function stationCastOff(o: {
  doc: Y.Doc;
  /** The ferry room's address (the request names the room it writes). */
  address: string;
  gate: GateEnd;
  shipRoomId: string;
  shipPort: string;
  now: number;
}): { wrote: boolean; since: Uint8Array; undockedAt: number } {
  const port = readDoorFrom(o.doc, o.shipPort);
  const rec = o.gate.read();
  const portStamp = port?.paired === true ? port.dockedAt : undefined;
  const gateStamp = holdsFerry(rec, o.shipRoomId, o.shipPort) ? rec.dockedAt : undefined;
  const after = Math.max(portStamp ?? Number.NEGATIVE_INFINITY, gateStamp ?? Number.NEGATIVE_INFINITY);
  const undockedAt = stampAfter(Number.isFinite(after) ? after : undefined, o.now);
  const since = Y.encodeStateVector(o.doc);
  let wrote = false;
  if (holdsDockTo(port, o.gate.near)) {
    try {
      wrote = applyFarDockRequest(
        o.doc,
        {
          kind: 'undock',
          nearRoomId: o.gate.near.roomId,
          farAddress: o.address,
          farDoor: o.shipPort,
          nearDoorId: o.gate.near.doorId,
          ...(o.gate.near.wall !== undefined ? { nearWall: o.gate.near.wall } : {}),
          ...(o.gate.near.lateral !== undefined ? { nearLateral: o.gate.near.lateral } : {}),
          undockedAt,
        },
        o.gate.near,
      ).wrote;
    } catch (err) {
      console.warn('[gate] ferry-side undock threw:', err);
    }
  }
  if (holdsFerry(rec, o.shipRoomId, o.shipPort)) {
    o.gate.write(buildDoorTombstone(rec.connectedRoomAddress, berthMemoryFrom(rec, undockedAt)));
  }
  return { wrote, since, undockedAt };
}

// ── The loop (effectful, thin) ───────────────────────────────────────────────

/** An open session to a ferry's room (roomSession.RoomSession). */
export interface FerrySession extends FerryDocSession {
  close(): void;
  readonly closed: boolean;
}

/** What the gate keeper reads from the game (main.ts wires it). */
export interface GateKeeperDeps {
  /** The room this game stands in ('' when none). */
  roomId: () => string;
  /** Has the room's shared state arrived? Until it has, nothing. */
  ready: () => boolean;
  /** This room's auto-dock gates (doorPolicy.readAutoFerryGates), each
   *  with its record as it is now. */
  gates: () => GateView[];
  /** This room's door records (doorsDoc.readAllDoors). */
  doors: () => ReadonlyMap<string, DoorRecord>;
  /** One of this room's door records, whatever its gate setting
   *  (doorsDoc.readDoor). Default: from `doors`. */
  door?: (doorId: string) => DoorRecord | undefined;
  /** The ferries this room's departures map holds. */
  ferries: () => readonly DepartureFerry[];
  /** Open a session to the room `address` reaches (roomSession). */
  open: (address: string) => Promise<FerrySession | null>;
  /** An address other rooms reach this room by. */
  ownAddress: (roomId: string) => Promise<string | null>;
  /** A gate's wall and along-wall centre in this room (docking.ts). */
  doorPose: (doorId: string) => { wall: DoorWall; lateral: number } | null;
  /** Write one of this room's door records. */
  writeDoor: (doorId: string, rec: DoorRecord) => void;
  /** Is a dock between these rooms locked by a station move? */
  dockLocked?: (roomIds: string[], now: number) => boolean;
  /** May this room take a pairing now (its own flight)? Default: yes. */
  mayPair?: () => boolean;
  /** A fresh "is this room part of the stop's station?" per read
   *  (routeKeeper.sameStationReader). Default: the stop's berth room only. */
  sameStation?: () => (stop: RouteStop, roomId: string) => boolean;
  /** Is this ship towing a station? Default: no. */
  towing?: (shipRoomId: string, now: number) => boolean;
  /** Publish a ferry snapshot to this room's departures map. */
  publishHere?: (pub: DeparturesPublish) => void;
  /** …and to another stop's room (best effort; needs a pass). */
  publishTo?: (roomId: string, pub: DeparturesPublish) => void;
  /** Say what happened at a gate (the door panel's dock row). */
  note?: (doorId: string, text: string, tone: 'ok' | 'warn' | 'bad') => void;
  clock?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface GateKeeper {
  /** One tick (1 Hz). */
  tick(): void;
  /** Hang up every session and forget everything (a room change). */
  reset(): void;
  /** Ferries with a session open or opening (tests, the DEV menu). */
  sessions(): string[];
}

/** Per ferry, between ticks. */
interface Watch {
  ship: string;
  session: FerrySession | null;
  dialing: boolean;
  openedAt: number;
  nextDialAt: number;
  dialBackoffMs: number;
  /** How long the re-dial after the next unacknowledged write waits: nothing
   *  at first, then GATE_REDIAL_MS doubling to GATE_REDIAL_MAX_MS while
   *  acknowledgments keep failing. An acknowledged write starts it over. */
  ackBackoffMs: number;
  /** The address the ferry's room was last dialled by ('' before the
   *  first dial). */
  address: string;
  /** This room's address as the ferry reaches it (resolved per dial). */
  ownAddress: string;
  /** A dock or cast-off is being written. */
  busy: boolean;
  memory: KeeperMemory | null;
  stationCache: RouteWalkCache;
  ferryCache: RouteWalkCache;
  /** Each gate pairing to this ferry this keeper has watched, by
   *  pairKey: when it was first seen. */
  pairSeen: Map<string, number>;
  /** The gate pairings to this ferry (pairKey) this keeper has seen its port
   *  hold too. Any other is a claim the two ends may not agree on: a DOCK
   *  under way, or one never acknowledged (this keeper's own included), so a
   *  session stays open until they do, whatever the route does. */
  settled: Set<string>;
  /** The stay of a checkpoint this keeper wrote that was never acknowledged:
   *  it was published nowhere, and the next session tells every stop what
   *  the ferry's room really holds. */
  unpublished: number | null;
  /** A write of this keeper's to the ferry's side of a dock (a cast-off, a
   *  release) was never acknowledged: a session stays open, or opens again,
   *  until the ferry's port agrees with the gate (reconcile). */
  repair: boolean;
  /** The gates this keeper has business at for this ferry (doorIds): each
   *  auto-dock gate it has seen hold the ferry or has written to for it,
   *  until it knows the two ends agree. One whose AUTO-DOCK is switched off
   *  meanwhile stays here, settled but never used again (`retired`); one
   *  that lets go of the ferry, or takes another pairing, has a session
   *  read whether the ferry's port let go too. */
  managed: Set<string>;
  /** The departures entry was refreshed from this session already. */
  refreshed: boolean;
}

/** A gate pairing's key: its gate and its stamp. */
const stampKey = (doorId: string, dockedAt: number | undefined): string => `${doorId}|${dockedAt ?? ''}`;
const pairKey = (doorId: string, rec: DoorPairing): string => stampKey(doorId, rec.dockedAt);

/** Do two route snapshots say the same (the route and its checkpoints)? */
function sameNews(a: { route: ShipRoute; checkpoints: readonly RouteCheckpoint[] }, b: { route: ShipRoute; checkpoints: readonly RouteCheckpoint[] }): boolean {
  const wire = (x: typeof a): string =>
    JSON.stringify([routeToWire(x.route), x.checkpoints.map((e) => [e.kind, e.legSeq, checkpointToWire(e)])]);
  return wire(a) === wire(b);
}

export function createGateKeeper(deps: GateKeeperDeps): GateKeeper {
  const clock = deps.clock ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const watches = new Map<string, Watch>();
  let room = '';
  /** Bumped by reset: work from before it is dropped when it answers. */
  let generation = 0;

  const safe = <T>(fn: (() => T) | undefined, fallback: T): T => {
    if (!fn) return fallback;
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const hangUp = (w: Watch): void => {
    w.session?.close();
    w.session = null;
    w.refreshed = false;
  };

  const watchOf = (ship: string): Watch => {
    let w = watches.get(ship);
    if (!w) {
      w = {
        ship,
        session: null,
        dialing: false,
        openedAt: 0,
        nextDialAt: Number.NEGATIVE_INFINITY,
        dialBackoffMs: GATE_REDIAL_MS,
        ackBackoffMs: 0,
        address: '',
        ownAddress: '',
        busy: false,
        memory: null,
        stationCache: createRouteWalkCache(),
        ferryCache: createRouteWalkCache(),
        pairSeen: new Map(),
        settled: new Set(),
        unpublished: null,
        repair: false,
        managed: new Set(),
        refreshed: false,
      };
      watches.set(ship, w);
    }
    return w;
  };

  const nearOf = (w: Watch, doorId: string): NearEnd => {
    const pose = safe(() => deps.doorPose(doorId), null);
    return {
      roomId: room,
      address: w.ownAddress,
      doorId,
      ...(pose ? { wall: pose.wall, lateral: pose.lateral } : {}),
    };
  };

  /** This room's side of a dock at `doorId`, written only while this room is
   *  still the one bound and the keeper has not reset since (a dock's await
   *  may outlast both). Read whatever its gate setting, so a claim at a gate
   *  switched off meanwhile is still seen, and taken back. */
  const gateEnd = (w: Watch, doorId: string, roomId: string): GateEnd => {
    const gen = generation;
    const bound = (): boolean => gen === generation && safe(deps.roomId, '') === roomId;
    return {
      near: nearOf(w, doorId),
      read: () => safe(() => (deps.door ? deps.door(doorId) : deps.doors().get(doorId)), undefined),
      write: (rec) => {
        if (!bound()) return false;
        deps.writeDoor(doorId, rec);
        return true;
      },
      live: () => bound() && safe(() => deps.gates().some((g) => g.doorId === doorId && admitsFerry(g, w.ship)), false),
    };
  };

  const dial = (w: Watch, address: string): void => {
    w.dialing = true;
    w.address = address;
    const gen = generation;
    const roomId = room;
    void Promise.all([
      deps.open(address).catch(() => null),
      deps.ownAddress(roomId).catch(() => null),
    ]).then(([session, own]) => {
      w.dialing = false;
      if (gen !== generation || watches.get(w.ship) !== w) {
        session?.close();
        return;
      }
      if (!session || !own) {
        session?.close();
        w.nextDialAt = clock() + w.dialBackoffMs;
        w.dialBackoffMs = Math.min(w.dialBackoffMs * 2, GATE_REDIAL_MAX_MS);
        return;
      }
      w.session = session;
      w.ownAddress = own;
      w.openedAt = clock();
      w.dialBackoffMs = GATE_REDIAL_MS;
      w.refreshed = false;
    });
  };

  /** The ferry's route and checkpoints as its doc has them at `now`, read
   *  afresh each time: which run counts depends on the clock too (a later
   *  START counts once it is within shipRoute.RUN_AHEAD_MS). */
  const newsOf = (w: Watch, now: number): { route: ShipRoute; checkpoints: readonly RouteCheckpoint[] } | null => {
    if (!w.session) return null;
    const r = routeIn(w.session.doc.getMap(SHIP_MAP), now);
    return r.route ? { route: r.route, checkpoints: r.checkpoints } : null;
  };

  /** A write of this keeper's to the ferry's room was never acknowledged
   *  (`repair`: one to its side of a dock). The session hangs up, so nothing
   *  is read from a doc the room may never hold, and a fresh one reads what
   *  it does hold (reconcile and the keeper's step write again what is
   *  missing): at once the first time, then backing off. */
  const unacked = (w: Watch, repair: boolean): void => {
    if (repair) w.repair = true;
    hangUp(w);
    w.nextDialAt = clock() + w.ackBackoffMs;
    w.ackBackoffMs = Math.min(Math.max(w.ackBackoffMs * 2, GATE_REDIAL_MS), GATE_REDIAL_MAX_MS);
  };

  /** Publish the ferry as its doc has it now: here, and (after this keeper's
   *  own checkpoint write) to every other stop's room. */
  const publish = (w: Watch, ferry: DepartureFerry, everywhere: boolean, legSeq: number | null): void => {
    const news = newsOf(w, clock());
    if (!news || !isRouteRunning(news.route)) return;
    const pub: DeparturesPublish = {
      shipRoomId: ferry.shipRoomId,
      name: ferry.name,
      capacity: ferry.capacity,
      route: news.route,
      checkpoints: [...news.checkpoints],
      at: clock(),
    };
    safe(() => deps.publishHere?.(pub), undefined);
    if (!everywhere) return;
    for (const r of publishRoomOrder(news.route, legSeq)) {
      if (r !== room) safe(() => deps.publishTo?.(r, pub), undefined);
    }
  };

  const heldFor = (w: Watch, now: number) => (doorId: string, rec: DoorPairing): number => {
    const key = pairKey(doorId, rec);
    const first = w.pairSeen.get(key);
    if (first === undefined) {
      w.pairSeen.set(key, now);
      return 0;
    }
    return now - first;
  };

  /**
   * The gate follows the ferry (gateFixes), whatever its route does: paused,
   * ended or finished, a claim at a gate is still settled, and so is what
   * this keeper left under way at a gate switched off since (`retired`).
   * Returns whether it changed anything (then the step waits for the next
   * tick).
   */
  const reconcile = (
    w: Watch,
    session: FerrySession,
    gates: readonly GateView[],
    retired: readonly GateView[],
    shipPort: string,
    berthing: FerryBerthing | null,
    now: number,
  ): boolean => {
    const roomId = room;
    const near = (doorId: string) => nearOf(w, doorId);
    const port = readDoorFrom(session.doc, shipPort);
    const views = [...gates, ...retired];
    const fixes = gateFixes({
      gates: views, port, shipRoomId: w.ship, shipPort, berthing, near, heldFor: heldFor(w, now), now,
    });
    // What it watches: the gate pairings to the ferry there are now, and
    // which of them the ferry's port holds too.
    const live = new Set<string>();
    for (const g of views) {
      if (!holdsFerry(g.record, w.ship, shipPort)) continue;
      const key = pairKey(g.doorId, g.record);
      live.add(key);
      if (port?.paired === true && holdsDockTo(port, near(g.doorId)) && port.dockedAt === g.record.dockedAt) w.settled.add(key);
    }
    for (const k of [...w.pairSeen.keys()]) if (!live.has(k)) w.pairSeen.delete(k);
    for (const k of [...w.settled]) if (!live.has(k)) w.settled.delete(k);
    // Its business at each gate (Watch.managed), as this fresh look has it:
    // a fix under way, a claim the ferry's port does not hold (yet), or,
    // while AUTO-DOCK is on there, a dock both ends hold. Anything else
    // between that gate and the ferry is settled.
    for (const g of views) {
      const fixing = fixes.some((f) => f.gate === g.doorId);
      if (!fixing && !w.managed.has(g.doorId)) continue;
      const gateHolds = holdsFerry(g.record, w.ship, shipPort);
      const portHolds = port?.paired === true && holdsDockTo(port, near(g.doorId));
      if (fixing || (gateHolds && (!portHolds || !g.retired))) w.managed.add(g.doorId);
      else w.managed.delete(g.doorId);
    }
    // The ferry's port agrees with the gate (as this fresh look has it).
    if (!fixes.some((f) => f.kind === 'release-ferry')) w.repair = false;
    if (fixes.length === 0) return false;
    for (const fix of fixes) {
      const end = gateEnd(w, fix.gate, roomId);
      if (fix.kind === 'join' || fix.kind === 'release-gate') {
        const wrote = end.write(fix.record);
        // A join takes the port's own stamp: the two ends agree. A gate let
        // go of a dock the port does not hold: nothing is left between them.
        if (wrote && fix.kind === 'join') w.settled.add(pairKey(fix.gate, fix.record));
        if (wrote && fix.kind === 'release-gate') w.managed.delete(fix.gate);
        continue;
      }
      const since = Y.encodeStateVector(session.doc);
      let wrote = false;
      try {
        wrote = applyFarDockRequest(session.doc, {
          kind: 'undock',
          nearRoomId: roomId,
          farAddress: w.address,
          farDoor: shipPort,
          nearDoorId: fix.gate,
          ...(end.near.wall !== undefined ? { nearWall: end.near.wall } : {}),
          ...(end.near.lateral !== undefined ? { nearLateral: end.near.lateral } : {}),
          undockedAt: fix.undockedAt,
        }, end.near).wrote;
      } catch (err) {
        console.warn('[gate] ferry-side release threw:', err);
      }
      if (!wrote) continue;
      // Kept open until the ferry's room acknowledges it.
      w.busy = true;
      const gen = generation;
      void session.confirm(since, GATE_ACK_MS).then((ok) => {
        if (gen !== generation) return;
        w.busy = false;
        if (!ok) {
          unacked(w, true);
          return;
        }
        w.ackBackoffMs = 0;
        w.managed.delete(fix.gate);
      });
    }
    return true;
  };

  /** One in-session step for one ferry: `gates` are the auto-dock gates,
   *  `retired` the ones switched off since with something left to settle. */
  const act = (
    w: Watch,
    ferry: DepartureFerry,
    gates: GateView[],
    retired: GateView[],
    berthing: FerryBerthing | null,
    now: number,
  ): void => {
    const session = w.session!;
    const news = newsOf(w, now);

    // 1. The gate follows the ferry (by the port the departures entry names,
    // as tend watches it).
    if (reconcile(w, session, gates, retired, ferry.route.shipPort, berthing, now)) return;
    if (!news || !isRouteRunning(news.route)) return;
    // The board here learns what the ferry's doc says, once per session; and
    // after a write of this keeper's that was never acknowledged, every stop
    // does (it may have landed after all).
    if (!w.refreshed) {
      w.refreshed = true;
      if (!sameNews(news, ferry)) publish(w, ferry, w.unpublished !== null, w.unpublished);
      w.unpublished = null;
    }
    // A newer route on another port than the entry here names (the refresh
    // above tells this board): the berthing and the gates' claims are the
    // entry's port's, so nothing is done until the two agree.
    if (news.route.shipPort !== ferry.route.shipPort) return;
    const sameStation = safe(deps.sameStation, null)
      ?? ((stop: RouteStop, roomId: string) => roomId === stop.berth.roomId);
    const look = ferryLook({
      doc: session.doc,
      capacity: ferry.capacity,
      now,
      sameStation,
      memory: w.memory,
      towing: safe(() => deps.towing?.(w.ship, now) === true, false),
      cache: w.ferryCache,
    });
    if (!look) return;
    const mem = look.view.memory;
    w.memory = mem;
    const route = look.view.route;
    const near = (doorId: string) => nearOf(w, doorId);
    const roomId = room;

    // 2. The ferry's riders' decision, on the ferry's own doc.
    const step = keeperStep(look.view);
    const move = gateMove({ step, look, gates, settling: retired, roomId, shipRoomId: w.ship, near, now });
    const dockLocked = (): boolean => safe(() => deps.dockLocked?.([roomId, w.ship], now) === true, false);
    switch (move.kind) {
      case 'none':
        if (move.why === 'no-gate') {
          mem.nextPassAt = now + KEEPER_RETRY_MS;
          mem.verdict = 'none';
        }
        return;
      case 'write': {
        mem.wroteAt[move.why] = now;
        const since = Y.encodeStateVector(session.doc);
        const wrote = writeRouteCheckpointIn(session.doc, session.doc.getMap(SHIP_MAP), route.startedAt, move.entry, now);
        if (!wrote) return;
        // Boards hear of it only once the ferry's room holds it.
        w.busy = true;
        const gen = generation;
        const legSeq = move.entry.legSeq;
        void session.confirm(since, GATE_ACK_MS).then((ok) => {
          if (gen !== generation) return;
          w.busy = false;
          if (!ok) {
            // It may never land: a fresh session reads what the ferry's room
            // does hold (the keeper writes it again if it is missing).
            w.unpublished = legSeq;
            unacked(w, false);
            return;
          }
          w.ackBackoffMs = 0;
          publish(w, ferry, true, legSeq);
          if (move.why === 'restart') {
            const gate = gates.find((g) => holdsFerry(g.record, w.ship, route.shipPort));
            if (gate) safe(() => deps.note?.(gate.doorId, `${ferry.name} was still docked after its departure: its stay starts again.`, 'warn'), undefined);
          }
        });
        return;
      }
      case 'cast-off': {
        if (dockLocked()) return;
        mem.castOff = true;
        w.managed.add(move.gate.doorId);
        const end = gateEnd(w, move.gate.doorId, roomId);
        const { wrote, since } = stationCastOff({
          doc: session.doc, address: w.address, gate: end, shipRoomId: w.ship, shipPort: route.shipPort, now,
        });
        if (!wrote) return;
        w.busy = true;
        const gen = generation;
        void session.confirm(since, GATE_ACK_MS).then((ok) => {
          if (gen !== generation) return;
          w.busy = false;
          safe(() => deps.note?.(move.gate.doorId, ok
            ? `Cast off ${ferry.name} on its timetable.`
            : `Cast off ${ferry.name}, but its module did not confirm yet.`, ok ? 'ok' : 'warn'), undefined);
          if (!ok) {
            unacked(w, true);
            return;
          }
          // Both ends let go: nothing is left between that gate and the ferry.
          w.ackBackoffMs = 0;
          w.managed.delete(move.gate.doorId);
        });
        return;
      }
      case 'dock': {
        if (!berthing || dockLocked() || !safe(deps.mayPair, true)) {
          mem.nextPassAt = now + KEEPER_RETRY_MS;
          return;
        }
        w.busy = true;
        mem.passing = true;
        w.managed.add(move.gate.doorId);
        const gen = generation;
        const legSeq = look.view.flight.legSeq;
        const run = route.startedAt;
        void stationDock({
          session,
          gate: gateEnd(w, move.gate.doorId, roomId),
          shipRoomId: w.ship,
          shipPort: route.shipPort,
          berthing,
          now: clock,
          wait,
        }).then((r) => {
          if (gen !== generation) return;
          w.busy = false;
          if (r.ok) {
            // Both ends hold this stamp now.
            w.settled.add(stampKey(move.gate.doorId, r.dockedAt));
            w.ackBackoffMs = 0;
          } else if (r.reason === 'unconfirmed') {
            // The gate keeps its claim, unsettled, and a fresh session reads
            // whether the ferry's side landed.
            unacked(w, false);
          }
          const m = w.memory;
          if (!m || m.run !== run || m.legSeq !== legSeq) return;
          m.passing = false;
          m.answeredAt = clock();
          if (r.ok) {
            m.verdict = 'docked';
            m.nextPassAt = clock();
            m.backoffMs = KEEPER_RETRY_MS;
            if (!r.joined) safe(() => deps.note?.(move.gate.doorId, `Docked ${ferry.name} automatically.`, 'ok'), undefined);
          } else {
            m.verdict = 'none';
            m.nextPassAt = clock() + m.backoffMs;
            m.backoffMs = Math.min(m.backoffMs * 2, KEEPER_RETRY_MAX_MS);
          }
        }, (err) => {
          console.warn('[gate] dock failed:', err);
          if (gen !== generation) return;
          w.busy = false;
          const m = w.memory;
          if (m && m.run === run && m.legSeq === legSeq) {
            m.passing = false;
            m.nextPassAt = clock() + m.backoffMs;
          }
        });
        return;
      }
    }
  };

  /** Does the gate hold a pairing to `w`'s ferry that both ends were seen
   *  to hold? */
  const settledAt = (w: Watch, g: GateView, shipPort: string): boolean =>
    holdsFerry(g.record, w.ship, shipPort) && w.settled.has(pairKey(g.doorId, g.record));

  /** One ferry, one tick. */
  const tend = (ferry: DepartureFerry, gates: GateView[], doors: ReadonlyMap<string, DoorRecord>, now: number): void => {
    const w = watchOf(ferry.shipRoomId);
    if (w.busy || w.dialing) return;
    const shipPort = ferry.route.shipPort;
    const berthing = ferryBerthingIn(doors, ferry.shipRoomId, shipPort);
    const running = isRouteRunning(ferry.route);
    // Gates this ferry is any business of: holding it, or (its route
    // running) free to take it.
    const holding = gates.filter((g) => holdsFerry(g.record, ferry.shipRoomId, shipPort));
    for (const g of holding) w.managed.add(g.doorId);
    // A gate switched off since (read whatever its setting) is settled, never
    // used again; once both ends hold its dock it is no longer this keeper's.
    const retired: GateView[] = [];
    for (const doorId of [...w.managed]) {
      if (gates.some((g) => g.doorId === doorId)) continue;
      const g: GateView = { doorId, record: safe(() => (deps.door ? deps.door(doorId) : doors.get(doorId)), undefined), retired: true };
      if (settledAt(w, g, shipPort)) w.managed.delete(doorId);
      else retired.push(g);
    }
    const free = running && !!berthing && gates.some((g) => g.record?.paired !== true && admitsFerry(g, ferry.shipRoomId));
    // A gate it has business at where the two ends are not known to agree:
    // a claim the ferry's port has not been seen to hold, a gate that let go
    // of the ferry or took another pairing (the port may still hold it), or
    // a gate switched off with something still under way.
    const watched = [...gates.filter((g) => w.managed.has(g.doorId)), ...retired];
    const pending = watched.some((g) => !settledAt(w, g, shipPort));
    if (holding.length === 0 && !free && !w.repair && !pending) {
      hangUp(w);
      return;
    }
    // That, or a write of its own to the ferry's side never acknowledged,
    // keeps a session whatever the route does, until the two ends agree
    // (reconcile).
    const unsettled = w.repair || pending;
    const look = running ? stationLook(ferry, room, boardDocksOf(doors, ferry.shipRoomId), now, w.stationCache) : null;
    if (!unsettled && !(look && gateSessionWanted(look, now))) {
      hangUp(w);
      return;
    }
    if (!w.session) {
      const address = berthing?.address
        ?? watched.map((g) => (holdsFerry(g.record, ferry.shipRoomId, shipPort) ? g.record.connectedRoomAddress : '')).find(Boolean)
        // Nothing here names the ferry any more (its gate took another
        // pairing) and its port may still hold that gate: the address this
        // keeper last dialled it by.
        ?? (unsettled && w.address ? w.address : undefined);
      if (address && now >= w.nextDialAt) dial(w, address);
      return;
    }
    if (w.session.closed) {
      hangUp(w);
      w.nextDialAt = now + GATE_REDIAL_MS;
      return;
    }
    if (now - w.openedAt >= GATE_SESSION_MAX_MS && !(look && departureClose(look, now))) {
      hangUp(w);
      w.nextDialAt = now;
      return;
    }
    act(w, ferry, gates, retired, berthing, now);
  };

  const reset = (): void => {
    generation++;
    for (const w of watches.values()) hangUp(w);
    watches.clear();
    room = '';
  };

  return {
    tick(): void {
      if (!safe(deps.ready, false)) return;
      const roomId = safe(deps.roomId, '');
      if (roomId !== room) {
        reset();
        room = roomId;
      }
      if (!roomId) return;
      const now = clock();
      const gates = safe(deps.gates, [] as GateView[]);
      // No auto-dock gate here, and nothing left to settle at one switched
      // off since: nothing to watch.
      if (gates.length === 0 && ![...watches.values()].some((w) => w.managed.size > 0 || w.repair)) {
        for (const w of watches.values()) hangUp(w);
        watches.clear();
        return;
      }
      const doors = safe(deps.doors, new Map<string, DoorRecord>() as ReadonlyMap<string, DoorRecord>);
      const seen = new Set<string>();
      for (const ferry of safe(deps.ferries, [] as readonly DepartureFerry[])) {
        // A route that is not running (finished) is tended too: a gate's
        // claim on its ferry is still settled.
        if (!ferry.route.stops.some((s) => s.berth.roomId === roomId)) continue;
        seen.add(ferry.shipRoomId);
        try {
          tend(ferry, gates, doors, now);
        } catch (err) {
          console.warn('[gate] keeper tick failed:', err);
        }
      }
      for (const [ship, w] of watches) {
        if (seen.has(ship) || w.busy) continue;
        hangUp(w);
        watches.delete(ship);
      }
    },

    reset,

    sessions(): string[] {
      return [...watches.values()].filter((w) => w.session || w.dialing).map((w) => w.ship);
    },
  };
}
