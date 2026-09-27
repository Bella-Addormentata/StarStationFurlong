/**
 * 🛬 Ship departure + arrival docking (#30 SH3).
 *
 * The flight record says WHERE the ship is; the doors doc says WHAT it is
 * docked to. These helpers join the two at the two moments they meet:
 *
 *   - DEPART: remember the berth at the station being left (so the ship can
 *     come back to it), then UNDOCK every docked port with the shipped
 *     UNDOCK (tombstone + far-room write).
 *   - ARRIVAL: pick the berth at the destination — the station's public berth
 *     from the directory, else the berth this ship remembers there — point a
 *     free port at it, and run the shipped DOCK (docking.ts redockPort). The
 *     dock therefore obeys every existing rule: the far berth is asked first
 *     (still free, still a port), module overlap is refused, and a refusal is
 *     reported on the port like any other DOCK.
 *
 * planArrivalDock is pure (pinned by shipArrival.test.ts); the two effectful
 * wrappers take the docking system through a small interface so neither this
 * file nor its tests touch Three or the DOM.
 */

import { stampAfter, type DockPortState } from './dockRules';
import { writeDoorTombstone, type DockBerthMemory } from './doorsDoc';
import { roomIdFromSeed } from './stationAtlas';
import { stationInTransit } from './stations';
import {
  findDestination,
  isBerthMemoryRecord,
  readBerthMemory,
  readFlightRecord,
  readStationBerth,
  writeFlightRecord,
  writeStationBerth,
  type BerthMemoryRecord,
  type FlightRecord,
} from './shipDoc';
import { isKnownStation, listStations, stationHere, type StationBerth, type StationDestination } from './stationDirectory';

/** Where a ship that missed a departed station waits when no other station
 *  orbits that planet: an unlisted id, so no hop leaves from it and it never
 *  follows the station. Dock from a door panel to go on. */
export const ADRIFT_PREFIX = 'adrift:';

/** The slice of a dock port the planner reads (docking.ts DockPortView). */
export interface ArrivalPort {
  doorId: string;
  state: DockPortState;
  /** A dock/undock is running on this port (docking.ts DockPortView). */
  busy?: boolean;
  /** May the local player dock/undock here. */
  canOperate?: boolean;
}

/** Why a cast-off cannot release every dock right now, or null when it can.
 *  DEPART checks this BEFORE it commits the flight: UNDOCK refuses a busy
 *  port or one the player may not operate, and a flight must never leave
 *  with a live dock behind it. */
export function castOffRefusal(ports: readonly ArrivalPort[]): 'dock-busy' | 'dock-locked' | null {
  for (const p of ports) {
    if (p.state.kind !== 'docked') continue;
    if (p.busy) return 'dock-busy';
    if (p.canOperate === false) return 'dock-locked';
  }
  return null;
}

/** The docking system as departure/arrival drive it (world.ts wires it). */
export interface ShipDockingApi {
  ports: () => ArrivalPort[];
  undock: (doorId: string) => void;
  /** The shipped DOCK. Its answer (docking.ts redockPort: false when the far
   *  berth refused, e.g. taken) settles what the helm says; no answer counts
   *  as docked. */
  dock: (doorId: string) => void | boolean | Promise<boolean | void>;
}

/** A remembered berth with a pass this client holds for its room — what
 *  planArrivalDock docks to. The ship doc stores only the room id. */
export type RememberedBerth = Omit<BerthMemoryRecord, 'roomId'> & { address: string };

let berthSeedFor: (roomId: string) => string | undefined = () => undefined;

/** main.ts points this at the passes THIS client holds (its local atlas and
 *  the build's own pass for the default station). */
export function setBerthSeedResolver(fn: ((roomId: string) => string | undefined) | null): void {
  berthSeedFor = fn ?? (() => undefined);
}

function roomOf(seed: string): string {
  try {
    return roomIdFromSeed(seed);
  } catch {
    return '';
  }
}

/** Pair a remembered berth room with a pass this client holds for it: its
 *  own store first, else a port that already names that room (its live or
 *  last dock, in the doors doc every passenger shares anyway). */
export function resolveRememberedBerth(
  rec: BerthMemoryRecord | null,
  ports: readonly ArrivalPort[],
): RememberedBerth | null {
  if (!rec) return null;
  let address = berthSeedFor(rec.roomId);
  if (!address || roomOf(address) !== rec.roomId) {
    address = undefined;
    for (const p of ports) {
      if (p.state.kind !== 'docked' && p.state.kind !== 'undocked') continue;
      if (roomOf(p.state.address) === rec.roomId) { address = p.state.address; break; }
    }
  }
  if (!address) return null;
  const { roomId: _room, ...rest } = rec;
  return { ...rest, address };
}

export type ArrivalPlan =
  | {
      kind: 'dock';
      doorId: string;
      /** The berth being docked to. */
      address: string;
      /** Re-point the port's tombstone here before DOCK; null when the port
       *  already remembers exactly this berth. */
      retarget: DockBerthMemory | null;
    }
  | { kind: 'none'; reason: 'no-berth' | 'no-port' | 'already-docked' };

/**
 * Decide how an arriving ship docks. The station's own berth wins (the station
 * says where visitors dock); otherwise the ship's memory of its last berth
 * there. The port used is the remembered one when it is free, else the first
 * port that is not docked.
 */
export function planArrivalDock(input: {
  station: Pick<StationDestination, 'berth'>;
  remembered: RememberedBerth | null;
  ports: readonly ArrivalPort[];
  now?: number;
}): ArrivalPlan {
  const { station, ports } = input;
  // The station's berth wins; the ship's own memory fills in when the station
  // names none, or names the same room without saying which door (the memory
  // knows the door and its geometry — a dock that can ask the far side).
  // Peer-written addresses: one that names no room is no berth at all (it
  // would reach the door record as a tombstone DOCK cannot parse).
  const stationBerth = station.berth && isRoomSeed(station.berth.address) ? station.berth : null;
  const remembered = input.remembered && isRoomSeed(input.remembered.address) ? input.remembered : null;
  const berth: StationBerth | null =
    remembered &&
    (!stationBerth ||
      (!stationBerth.farDoor && sameRoom(stationBerth.address, remembered.address)))
      ? remembered
      : stationBerth;
  if (!berth) return { kind: 'none', reason: 'no-berth' };
  if (ports.some((p) => p.state.kind === 'docked' && sameRoom(p.state.address, berth.address))) {
    return { kind: 'none', reason: 'already-docked' };
  }
  // Open = free to dock AND ours to use right now: a busy or locked port
  // would refuse DOCK after its door record was already re-pointed.
  const open = (p: ArrivalPort) =>
    (p.state.kind === 'undocked' || p.state.kind === 'free') && !p.busy && p.canOperate !== false;
  const preferred = remembered ? ports.find((p) => p.doorId === remembered.doorId && open(p)) : undefined;
  const port = preferred ?? ports.find(open);
  if (!port) return { kind: 'none', reason: 'no-port' };
  const st = port.state;
  if (
    st.kind === 'undocked' &&
    sameRoom(st.address, berth.address) &&
    (berth.farDoor === undefined || st.memory.farDoor === berth.farDoor)
  ) {
    return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: null };
  }
  const memory: DockBerthMemory = {
    undockedAt: stampAfter(st.kind === 'undocked' ? st.memory.undockedAt : undefined, input.now),
  };
  if (berth.farDoor !== undefined) memory.farDoor = berth.farDoor;
  if (berth.farWall !== undefined) memory.farWall = berth.farWall;
  if (berth.farLateral !== undefined) memory.farLateral = berth.farLateral;
  return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: memory };
}

/**
 * Where the ship is. While it sits docked into a station, its docks say so
 * (the directory's `here`) — a ship docked by hand at a new station is AT that
 * station, whatever the last flight wrote. Otherwise the flight record's
 * location stands.
 */
export function shipLocationId(rec: FlightRecord, hasLiveDock: boolean): string {
  if (rec.status === 'docked' && hasLiveDock) {
    const here = stationHere();
    if (here) return here;
  }
  return rec.locationId;
}

/** Two pass seeds reach the same room (a seed's hints may differ). */
/** Does this seed name a room? Malformed peer-written seeds throw; fail closed. */
function isRoomSeed(seed: string): boolean {
  try {
    return roomIdFromSeed(seed) !== '';
  } catch {
    return false;
  }
}

function sameRoom(a: string, b: string): boolean {
  if (a === b) return true;
  // Peer-written seeds: a malformed one (e.g. `#room=%`) makes the parser
  // throw — fail closed, as two different rooms.
  try {
    const ra = roomIdFromSeed(a);
    return ra !== '' && ra === roomIdFromSeed(b);
  } catch {
    return false;
  }
}

/** The berth to remember at the station being left: the first docked port. */
export function berthToRemember(ports: readonly ArrivalPort[]): BerthMemoryRecord | null {
  for (const p of ports) {
    if (p.state.kind !== 'docked') continue;
    const rec = p.state.record;
    const roomId = roomOf(p.state.address);
    if (!roomId) continue; // a malformed dock: keep looking for a good one
    const out: BerthMemoryRecord = { doorId: p.doorId, roomId };
    if (rec.farDoor) out.farDoor = rec.farDoor;
    if (rec.farWall) out.farWall = rec.farWall;
    if (rec.farLateral !== undefined) out.farLateral = rec.farLateral;
    return out;
  }
  return null;
}

/** Remember the berth the ship is docked at here, forgetting the oldest
 *  other station when memory is full. DEPART calls this BEFORE it commits the
 *  flight, so a berth that cannot be kept stops the departure rather than
 *  stranding the return trip. True when remembered, or when there is no
 *  berth to keep. */
export function rememberBerthHere(stationId: string, ports: readonly ArrivalPort[]): boolean {
  const berth = berthToRemember(ports);
  if (!berth) return true;
  // A berth the memory would refuse anyway (a malformed peer-written dock)
  // must never cost an unrelated station its remembered berth below.
  if (!isBerthMemoryRecord(berth)) return false;
  if (writeStationBerth(stationId, berth)) return true;
  // Memory full: evict the oldest other station — never the one we leave.
  const oldest = Object.keys(readBerthMemory()).find((id) => id !== stationId);
  if (oldest !== undefined && writeStationBerth(oldest, null)) {
    return writeStationBerth(stationId, berth);
  }
  return false;
}

/** DEPART's cast-off: remember the berth here, then UNDOCK every docked port.
 *  Returns whether the berth here is remembered. */
export function castOffForDeparture(stationId: string, docking: ShipDockingApi): boolean {
  const ports = docking.ports();
  const remembered = rememberBerthHere(stationId, ports);
  if (!remembered) console.warn(`[ship] could not remember the berth at ${stationId}`);
  for (const p of ports) {
    if (p.state.kind === 'docked') docking.undock(p.doorId);
  }
  return remembered;
}

/** What the last arrival did — the helm shows it. */
export type ArrivalOutcome =
  | { kind: 'docking'; stationName: string }
  /** The DOCK went through (reported once the far berth answered). */
  | { kind: 'docked'; stationName: string }
  | {
      kind: 'none';
      stationName: string;
      /** `berths-taken`: the DOCK answered false. Usually the berth refused
       *  (taken, or closed), but redockPort also refuses for its own reasons
       *  (no rights, no room to fit, a busy port); the port's own note names
       *  which, so the helm points there rather than guessing. */
      reason: 'no-berth' | 'no-port' | 'already-docked' | 'unlisted-station' | 'berths-taken' | 'in-transit';
    };

/** How long an arrival waits for a commander who can dock (station records
 *  and passes are per install) before any commander settles it berthless. */
export const ARRIVAL_GRACE_MS = 15_000;

/**
 * Finish a flight: `redocking → docked` at the destination, then DOCK at its
 * berth. The flight write comes FIRST so the dock's flight gate (docking.ts
 * redockPort refuses while not docked) lets it through.
 *
 * Several commanders may run this. One that can dock here finishes at once;
 * one that cannot (no berth it knows, no free port it may use, a station its
 * list lacks) leaves the ship `redocking` for ARRIVAL_GRACE_MS after arrival,
 * so a better-informed commander gets to dock it, then settles it berthless.
 * `force` (the helm's DOCK NOW) settles at once. Returns null when nothing
 * was decided (not redocking, or still inside the grace).
 */
export function completeArrival(
  docking: ShipDockingApi | null,
  opts: {
    now?: number;
    force?: boolean;
    /** Called once the DOCK answers: docked, or the berth refused. Only
     *  when this returns `docking`. */
    onSettled?: (outcome: ArrivalOutcome) => void;
  } = {},
): ArrivalOutcome | null {
  const rec = readFlightRecord();
  if (rec.status !== 'redocking') return null;
  const now = opts.now ?? Date.now();
  const settle = (outcome: ArrivalOutcome, locationId: string = rec.locationId): ArrivalOutcome | null => {
    const graceOver = rec.etaAt === undefined || now >= rec.etaAt + ARRIVAL_GRACE_MS;
    if (!opts.force && !graceOver) return null;
    writeFlightRecord({ status: 'docked', locationId });
    return outcome;
  };
  // A destination that left the directory mid-flight is NOT home: arrive
  // there undocked rather than docking at findDestination's fallback.
  if (!isKnownStation(rec.locationId)) {
    return settle({ kind: 'none', stationName: rec.locationId, reason: 'unlisted-station' });
  }
  const station = findDestination(rec.locationId);
  // 🚚 A station that left its planet while the ship was on the way (still
  // between planets, or already at the new one) has no berth in reach: the
  // ship arrives where it was headed and stays undocked.
  const moved = station.lastMove ?? station.move;
  // Since the ship cast off — the booking, not the launch window it waited
  // for (older records carry only the window).
  const leftAt = rec.castOffAt ?? rec.departedAt;
  // Any move that was still under way (or not yet begun) when the ship left
  // and has begun by now overlaps its time away.
  const movedMidFlight = !!moved && leftAt !== undefined && moved.arriveAt > leftAt && moved.departAt <= now;
  if (stationInTransit(station, now) || movedMidFlight) {
    // The ship stays at the planet the station left, never following it: it
    // holds by another station there, or (none) adrift where no hop starts.
    const planetId = moved?.fromPlanetId ?? station.planetId;
    const holdBy = listStations().find((s) => s.id !== station.id && s.planetId === planetId
      && !stationInTransit(s, now));
    return settle({ kind: 'none', stationName: station.name, reason: 'in-transit' },
      holdBy?.id ?? `${ADRIFT_PREFIX}${planetId}`);
  }
  if (!docking) return settle({ kind: 'none', stationName: station.name, reason: 'no-port' });
  const ports = docking.ports();
  const plan = planArrivalDock({
    station,
    remembered: resolveRememberedBerth(readStationBerth(station.id), ports),
    ports,
  });
  if (plan.kind === 'none') {
    const outcome: ArrivalOutcome = { kind: 'none', stationName: station.name, reason: plan.reason };
    if (plan.reason === 'already-docked') {
      writeFlightRecord({ status: 'docked', locationId: rec.locationId });
      return outcome;
    }
    return settle(outcome);
  }
  writeFlightRecord({ status: 'docked', locationId: rec.locationId });
  if (plan.retarget) writeDoorTombstone(plan.doorId, plan.address, plan.retarget);
  const settled = (ok: boolean | void): void => opts.onSettled?.(ok !== false
    ? { kind: 'docked', stationName: station.name }
    : { kind: 'none', stationName: station.name, reason: 'berths-taken' });
  const failed = (err: unknown): void => {
    console.warn('[ship] arrival DOCK threw:', err);
    settled(false);
  };
  try {
    void Promise.resolve(docking.dock(plan.doorId)).then(settled, failed);
  } catch (err) {
    failed(err);
  }
  return { kind: 'docking', stationName: station.name };
}
