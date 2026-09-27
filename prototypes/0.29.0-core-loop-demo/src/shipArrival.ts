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
import { currentRoomId, listStations, planetById, stationInTransit } from './stations';
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
import { adriftAt, adriftPlace, isKnownStation, stationHere, type StationBerth, type StationDestination } from './stationDirectory';

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
   *  berth refused, e.g. taken) lets an arrival try the station's next gate;
   *  no answer counts as docked. */
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
      /** ⚓🚦 The gate being docked at, when the berth has one. */
      gate?: number;
    }
  | { kind: 'none'; reason: 'no-berth' | 'no-port' | 'already-docked' };

/**
 * ⚓🚦 Every berth an arriving ship may try, in order:
 *   1. the gate asked for (a route stop's), when the station has it;
 *   2. the station's other gates in gate order, those its atlas shows taken
 *      last (the atlas may be a harvest behind, so they are still tried);
 *   3. a station that lists no gates: its one public berth;
 *   4. the ship's memory of its last berth there — first when the station
 *      names none, or names the same room without saying which door (the
 *      memory knows the door and its geometry), else last.
 * Peer-written addresses: one that names no room is no berth at all (it
 * would reach the door record as a tombstone DOCK cannot parse).
 */
export function arrivalBerths(input: {
  station: Pick<StationDestination, 'berth' | 'berths' | 'unaddressed'>;
  remembered: RememberedBerth | null;
  gate?: number;
  /** ⚓🚦 The arriving ship's room: a gate reserved for it comes first, and
   *  one reserved for another ship is left out. */
  shipRoomId?: string;
}): StationBerth[] {
  const recalledAt = input.remembered && isRoomSeed(input.remembered.address) ? input.remembered : null;
  // ⚓🚦 A gate this client holds no pass for, in the room the ship's memory
  // knows: the memory's address reaches it, so it is a gate like the others
  // (barred, ranked and matched the same way).
  const reached: StationBerth[] = recalledAt
    ? (input.station.unaddressed ?? [])
      .filter((u) => u.roomId === roomOf(recalledAt.address))
      .map((u) => ({
        address: recalledAt.address,
        farDoor: u.farDoor,
        ...(u.gate !== undefined ? { gate: u.gate } : {}),
        ...(u.access ? { access: u.access, ...(u.reservedFor ? { reservedFor: u.reservedFor } : {}) } : {}),
      }))
    : [];
  const station = Array.isArray(input.station.berths) && reached.length > 0
    ? { ...input.station, berths: [...input.station.berths, ...reached] }
    : input.station;
  // A station known to have no gates (an empty list, not a missing one) has
  // no berth to ask, remembered or not.
  if (Array.isArray(station.berths) && station.berths.length === 0) return [];
  // ⚓🚦 The station decides who may dock where: a closed gate, or one
  // reserved for another ship, is never asked (its far end would refuse).
  // Gates open to the owner's granted captains cannot be checked from here,
  // so they are tried after every open one, taken-looking ones included.
  const ours = (b: StationBerth) => b.access === 'reserved' && !!input.shipRoomId && b.reservedFor === input.shipRoomId;
  const barred = (b: StationBerth) => b.access === 'closed' || (b.access === 'reserved' && !ours(b));
  const gates = (station.berths ?? []).filter((b) => isRoomSeed(b.address) && !barred(b));
  const asked = (b: StationBerth) => input.gate !== undefined && b.gate === input.gate;
  const rank = (b: StationBerth): number =>
    asked(b) ? 0 : ours(b) ? 1 : (b.access === 'pass' ? 4 : 2) + (b.occupied ? 1 : 0);
  const same = (a: StationBerth, b: StationBerth) =>
    sameRoom(a.address, b.address) && (a.farDoor ?? '') === (b.farDoor ?? '');
  // The ship's memory of a gate the station now bars is not asked either. In
  // a room the station lists gates for, the memory stands only as one of the
  // gates it may ask (a legacy memory may not name its door, and could
  // otherwise slip past a barred one).
  const recalled = input.remembered && isRoomSeed(input.remembered.address) ? input.remembered : null;
  const roomListed = !!recalled && (station.berths ?? []).some((b) => sameRoom(b.address, recalled.address));
  const remembered = recalled && (roomListed
    ? gates.some((b) => sameRoom(b.address, recalled.address) && (!b.farDoor || b.farDoor === recalled.farDoor))
    : true) ? recalled : null;
  const listed: StationBerth[] = (station.berths ?? []).length > 0
    ? gates.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map((x) => x.b)
    : station.berth && isRoomSeed(station.berth.address) ? [station.berth] : [];
  const out: StationBerth[] = [];
  const add = (b: StationBerth) => { if (!out.some((o) => same(o, b))) out.push(b); };
  const memoryFirst = remembered && (listed.length === 0
    || (listed.length === 1 && !listed[0].farDoor && sameRoom(listed[0].address, remembered.address)));
  if (memoryFirst) add(remembered);
  for (const b of listed) {
    // A doorless berth in the room the memory knows is the memory's.
    if (memoryFirst && !b.farDoor && sameRoom(b.address, remembered.address)) continue;
    add(b);
  }
  if (remembered) add(remembered);
  return out;
}

/**
 * Decide how an arriving ship docks: at `berth` when given (the next gate
 * after a refusal), else the first of arrivalBerths. The port used is the
 * remembered one when it is free, else the first port that is not docked.
 */
export function planArrivalDock(input: {
  station: Pick<StationDestination, 'berth' | 'berths' | 'berthRooms' | 'unaddressed'>;
  remembered: RememberedBerth | null;
  ports: readonly ArrivalPort[];
  now?: number;
  /** ⚓🚦 The gate to try first (a route stop's). */
  gate?: number;
  /** The arriving ship's room (arrivalBerths). */
  shipRoomId?: string;
  /** Dock here instead of the first candidate. */
  berth?: StationBerth;
}): ArrivalPlan {
  const { ports } = input;
  const remembered = input.remembered && isRoomSeed(input.remembered.address) ? input.remembered : null;
  const candidates = arrivalBerths(input);
  const berth: StationBerth | null =
    input.berth && isRoomSeed(input.berth.address) ? input.berth : candidates[0] ?? null;
  if (!berth) return { kind: 'none', reason: 'no-berth' };
  // Docked at any of this station's berths: already there. Its rooms count
  // too, so a dock another commander made at a gate this client cannot
  // address is never doubled.
  const stationRooms = new Set(input.station.berthRooms ?? []);
  const inStation = (address: string): boolean => {
    try { return stationRooms.has(roomIdFromSeed(address)); } catch { return false; }
  };
  if (ports.some((p) => p.state.kind === 'docked'
    && (inStation((p.state as { address: string }).address)
      || [berth, ...candidates].some((b) => sameRoom((p.state as { address: string }).address, b.address))))) {
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
    return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: null, ...gateOf(berth) };
  }
  const memory: DockBerthMemory = {
    undockedAt: stampAfter(st.kind === 'undocked' ? st.memory.undockedAt : undefined, input.now),
  };
  if (berth.farDoor !== undefined) memory.farDoor = berth.farDoor;
  if (berth.farWall !== undefined) memory.farWall = berth.farWall;
  if (berth.farLateral !== undefined) memory.farLateral = berth.farLateral;
  return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: memory, ...gateOf(berth) };
}

function gateOf(berth: StationBerth): { gate?: number } {
  return berth.gate !== undefined ? { gate: berth.gate } : {};
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
  | { kind: 'docking'; stationName: string; gate?: number }
  /** ⚓🚦 The DOCK went through (reported once the far berth answered). */
  | { kind: 'docked'; stationName: string; gate?: number }
  | {
      kind: 'none';
      stationName: string;
      /** `berths-taken`: every berth tried refused. Usually taken, closed or
       *  unreachable, but redockPort also refuses for its own reasons (no
       *  rights, no room to fit, a busy port); the port's panel says which.
       *  `in-transit`: the destination is between planets. */
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
    /** ⚓🚦 The gate to try first (a route stop's). */
    gate?: number;
    /** Called once the docking settles: docked (at which gate), or every
     *  berth refused. Not called when this returns anything but `docking`. */
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
  // between planets, or already at the new one) has no berth in reach.
  // A pin (stationMove.ts) is no journey: one of where a move arrived
  // stands for that move, and a cancel means the station never went.
  const latest = station.lastMove ?? station.move;
  const moved = !latest ? undefined
    : !latest.settles ? latest
    : latest.departAt < latest.settles.arriveAt ? undefined
    : latest.settles;
  // Since the ship cast off — the booking, not the launch window it waited
  // for (older records carry only the window).
  const leftAt = rec.castOffAt ?? rec.departedAt;
  // Any move that was still under way (or not yet begun) when the ship left
  // and has begun by now overlaps its time away.
  const movedMidFlight = !!moved && leftAt !== undefined && moved.arriveAt > leftAt && moved.departAt <= now;
  // Where the station orbited at cast-off, when the flight kept it: however
  // many moves it made since (and only the latest is kept), it is not there.
  const castOffPlace = rec.destinationAt !== undefined ? adriftPlace(rec.destinationAt) : null;
  const listedNow = castOffPlace ? listStations().find((s) => s.id === rec.locationId) : undefined;
  const movedAway = !!castOffPlace && !!listedNow
    && (planetById(listedNow.planetId).id !== planetById(castOffPlace.planetId).id || listedNow.orbitSlot !== castOffPlace.orbitSlot);
  if (stationInTransit(station, now) || movedMidFlight || movedAway) {
    // The ship waits in open orbit where the station was, a place of its own
    // (stationDirectory.adriftAt) that follows no station; it flies on from
    // there to any station around that planet.
    const from = moved ?? station.move;
    const at = castOffPlace ? adriftAt(castOffPlace.planetId, castOffPlace.orbitSlot)
      : from ? adriftAt(from.fromPlanetId, from.fromSlot) : adriftAt(station.planetId, 0);
    return settle({ kind: 'none', stationName: station.name, reason: 'in-transit' }, at);
  }
  if (!docking) return settle({ kind: 'none', stationName: station.name, reason: 'no-port' });
  const ports = docking.ports();
  const remembered = resolveRememberedBerth(readStationBerth(station.id), ports);
  const shipRoomId = currentRoomId();
  const plan = planArrivalDock({ station, remembered, ports, gate: opts.gate, shipRoomId });
  if (plan.kind === 'none') {
    const outcome: ArrivalOutcome = { kind: 'none', stationName: station.name, reason: plan.reason };
    if (plan.reason === 'already-docked') {
      writeFlightRecord({ status: 'docked', locationId: rec.locationId });
      return outcome;
    }
    return settle(outcome);
  }
  writeFlightRecord({ status: 'docked', locationId: rec.locationId });
  const candidates = arrivalBerths({ station, remembered, gate: opts.gate, shipRoomId });
  void dockThroughBerths(docking, station, remembered, candidates, plan, opts.onSettled, shipRoomId);
  return { kind: 'docking', stationName: station.name, ...(plan.gate !== undefined ? { gate: plan.gate } : {}) };
}

/** ⚓🚦 The gate of the station berth a port is docked at, matched by room
 *  and far door; undefined when none matches for certain. */
function dockedGate(ports: readonly ArrivalPort[], candidates: readonly StationBerth[]): number | undefined {
  for (const p of ports) {
    if (p.state.kind !== 'docked') continue;
    const { address, record } = p.state;
    const inRoom = candidates.filter((b) => b.gate !== undefined && sameRoom(address, b.address));
    const exact = record.farDoor ? inRoom.find((b) => b.farDoor === record.farDoor) : undefined;
    // Without the far door, a room's gate is only certain when it has one.
    const berth = exact ?? (!record.farDoor && inRoom.length === 1 ? inRoom[0] : undefined);
    if (berth) return berth.gate;
  }
  return undefined;
}

/**
 * ⚓🚦 DOCK at the planned berth; when the far berth refuses (taken, or its
 * room out of reach), try the next berth in arrivalBerths order, re-planned
 * against the ports as they are now. Settles docked at the first that takes
 * the ship, or `berths-taken` when every one refused.
 */
async function dockThroughBerths(
  docking: ShipDockingApi,
  station: StationDestination,
  remembered: RememberedBerth | null,
  candidates: readonly StationBerth[],
  first: Extract<ArrivalPlan, { kind: 'dock' }>,
  onSettled: ((outcome: ArrivalOutcome) => void) | undefined,
  /** The arriving ship's room, captured at arrival: every retry plans for
   *  the same ship (its reserved gates count, and a dock it gained counts). */
  shipRoomId?: string,
): Promise<void> {
  // `first` was planned for candidates[0] (planArrivalDock's own pick).
  for (let i = 0; i < candidates.length || i === 0; i++) {
    // The docking system outlives a room swap and reads whichever room is
    // bound now: once the player has left the ship's room, a retry would
    // pick and dock a port of some other room. Stop, and say nothing (the
    // answer belongs to a room no longer shown).
    if (i > 0 && shipRoomId !== undefined && currentRoomId() !== shipRoomId) return;
    const plan: ArrivalPlan = i === 0
      ? first
      : planArrivalDock({ station, remembered, ports: docking.ports(), berth: candidates[i], shipRoomId });
    if (plan.kind === 'none') {
      if (plan.reason === 'already-docked') {
        // Another commander docked the ship meanwhile: report the gate it got.
        const gate = dockedGate(docking.ports(), candidates);
        onSettled?.({ kind: 'docked', stationName: station.name, ...(gate !== undefined ? { gate } : {}) });
      } else {
        onSettled?.({ kind: 'none', stationName: station.name, reason: plan.reason });
      }
      return;
    }
    if (plan.retarget) writeDoorTombstone(plan.doorId, plan.address, plan.retarget);
    let ok: boolean | void = false;
    try {
      ok = await docking.dock(plan.doorId);
    } catch (err) {
      console.warn('[ship] arrival DOCK threw:', err);
    }
    // The await may have outlived the ship's room: the answer belongs to a
    // room no longer shown, so say nothing.
    if (shipRoomId !== undefined && currentRoomId() !== shipRoomId) return;
    if (ok !== false) {
      onSettled?.({ kind: 'docked', stationName: station.name, ...(plan.gate !== undefined ? { gate: plan.gate } : {}) });
      return;
    }
  }
  // Every berth refused: unless another commander docked the ship while
  // the last one was answering.
  const last = candidates[candidates.length - 1];
  const again = planArrivalDock({ station, remembered, ports: docking.ports(), ...(last ? { berth: last } : {}), shipRoomId });
  if (again.kind === 'none' && again.reason === 'already-docked') {
    const gate = dockedGate(docking.ports(), candidates);
    onSettled?.({ kind: 'docked', stationName: station.name, ...(gate !== undefined ? { gate } : {}) });
    return;
  }
  onSettled?.({ kind: 'none', stationName: station.name, reason: 'berths-taken' });
}
