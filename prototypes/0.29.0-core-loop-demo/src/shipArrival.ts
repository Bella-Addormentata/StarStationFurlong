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

import { isDockChain } from './adapter';
import { stampAfter, type DockPortState } from './dockRules';
import { readAllDoorsIfComplete, readDoor, writeDoorTombstone, type DockBerthMemory, type DoorRecord } from './doorsDoc';
import { atlasComponent, readAtlas, roomIdFromSeed } from './stationAtlas';
import { stationLeftFrom } from './stationMove';
import {
  currentRoomId, dockedStationFor, listStations, planetById, stationForRoom, stationInTransit, type StationRecord,
} from './stations';
import {
  findDestination,
  isBerthMemoryRecord,
  MAX_REST_DOCKS,
  readBerthMemory,
  readFlightRecord,
  readRestPlace,
  readStationBerth,
  writeFlightRecord,
  writeRestPlace,
  writeStationBerth,
  type BerthMemoryRecord,
  type FlightRecord,
  type RestPlace,
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
 * 🚚 Where a ship with no live dock is, as a location id: its flight
 * record's location, unless that station has moved on without it. Only a
 * live dock carries a ship along, so then the ship is in open orbit where the
 * station was (stationDirectory.adriftAt), a place that follows no station:
 * - cast off, where the flight kept that its station orbited at cast-off
 *   (the origin's while it waits for its launch window or flies, the
 *   destination's once it has arrived), once the station has left that place;
 * - at rest (docked, by the record), where its rest record leaves it
 *   (shipDoc.RestPlace, restingPlace), once no station it rests beside is
 *   there. A docked ship with no rest record follows its station.
 * A ship in open orbit by its record is there, unless a dock has held it
 * since (docked by hand: its rest record), wherever that took it.
 */
export function shipPlaceId(
  rec: FlightRecord,
  now: number = Date.now(),
  rest: RestPlace | null = readRestPlace(),
): string {
  if (adriftPlace(rec.locationId) && (rec.status !== 'docked' || !rest)) return rec.locationId;
  const stations = listStations(undefined, undefined, now);
  const listed = stations.find((s) => s.id === rec.locationId);
  if (rec.status === 'docked') {
    if (!rest) return rec.locationId;
    const resting = restingPlace(rest, now, stations);
    // A dock it names still holds it (one a capped scan of the doors missed).
    if ('heldBy' in resting) return resting.heldBy ?? rec.locationId;
    // Beside its own station, or the one it last let go of, while that is there.
    const beside = [listed, resting.from].find((st) => isAt(st, resting.at, now));
    return beside ? beside.id : resting.at;
  }
  const kept = rec.status === 'redocking' ? rec.destinationAt
    : rec.status === 'in-flight' ? rec.originAt
      : undefined;
  if (kept === undefined || !adriftPlace(kept)) return rec.locationId;
  return isAt(listed, kept, now) ? rec.locationId : kept;
}

/** Is `station` at the open-orbit place `placeId` at `now` (not between
 *  planets)? */
function isAt(station: StationRecord | null | undefined, placeId: string, now: number): station is StationRecord {
  const place = adriftPlace(placeId);
  return !!station && !!place && !stationInTransit(station, now)
    && planetById(station.planetId).id === place.planetId && station.orbitSlot === place.orbitSlot;
}

/** Where a station orbits, as an open-orbit place. */
function placeOf(station: StationRecord): string {
  return adriftAt(planetById(station.planetId).id, station.orbitSlot);
}

/** The station a dock into `roomId` holds a ship at: none for another lone
 *  module (two lone modules docked together each stay where they are, as in
 *  stations.dockedStationFor). */
function dockHost(roomId: string, stations: StationRecord[] = listStations()): StationRecord | null {
  const atlas = readAtlas();
  const st = stationForRoom(roomId, atlas, stations);
  return st && !(st.derived && atlasComponent(atlas, st.welcomeRoomId).size <= 1) ? st : null;
}

/** 🚚 Where the station a dock into `roomId` holds a ship at is as that dock
 *  lets go, for the UNDOCK to record on the other end's tombstone
 *  (doorsDoc.DockBerthMemory.at): none for a lone module, or for a station
 *  between planets (no dock lets go then). */
export function releasePlaceOf(roomId: string, now: number = Date.now()): string | undefined {
  if (!roomId) return undefined;
  const stations = listStations(undefined, undefined, now);
  const host = dockHost(roomId, stations);
  return host && !stationInTransit(host, now) ? placeOf(host) : undefined;
}

/**
 * What a ship's rest record (shipDoc.RestPlace) says at `now`, from the doors
 * it names, each read directly: a scan of the doors is capped, and a peer
 * could push the very door out of it.
 * - `heldBy`: a dock through one of them still holds the ship (its station,
 *   when listed);
 * - else, once one of them let go since the ship came to rest (the latest,
 *   by its UNDOCK's own stamp: `releasedAt`), where that dock's station
 *   (`from`) was then: where its UNDOCK recorded it (DockBerthMemory.at,
 *   `recorded`), which no move heard of since can change. From a tombstone
 *   that records none (written before UNDOCKs did, or by one that could not
 *   place its station), the station's place: a station lets go of no dock
 *   between planets, so that is where it is now, unless it has moved since:
 *   then where it left from on its first move after (stationMove.
 *   stationLeftFrom, from the moves this install knows; keepRestPlace
 *   records the place before that can happen, whenever anyone is aboard);
 * - else where the ship came to rest, beside the station the rest record
 *   names as `from` (when listed).
 */
export function restingPlace(
  rest: RestPlace,
  now: number = Date.now(),
  stations: StationRecord[] = listStations(undefined, undefined, now),
): { heldBy: string | null } | { at: string; from?: StationRecord; releasedAt?: number; recorded?: true } {
  let release: { at: number; room: string; place?: string } | null = null;
  for (const doorId of rest.docks ?? []) {
    const door = readDoor(doorId);
    if (!door) continue;
    let room = '';
    try {
      room = roomIdFromSeed(door.paired === true ? door.connectedRoomAddress : door.retiredAddress);
    } catch {
      room = '';
    }
    if (!room) continue;
    if (door.paired === true) {
      // A gangway is structure, not a dock: that ship is no free ship.
      if (door.transient === true || isDockChain(door.segments)) return { heldBy: dockHost(room, stations)?.id ?? null };
      continue;
    }
    // A release before the ship came to rest here belongs to an earlier stay.
    if (!door.dock || door.dock.undockedAt < rest.since) continue;
    if (!release || door.dock.undockedAt > release.at) release = { at: door.dock.undockedAt, room, place: door.dock.at };
  }
  if (!release) {
    const from = rest.from === undefined ? undefined : stations.find((st) => st.id === rest.from);
    return from ? { at: rest.at, from } : { at: rest.at };
  }
  const from = dockHost(release.room, stations);
  const told = release.place === undefined ? null : adriftPlace(release.place);
  if (told) {
    const at = adriftAt(told.planetId, told.orbitSlot);
    return from ? { at, from, releasedAt: release.at, recorded: true } : { at, releasedAt: release.at, recorded: true };
  }
  if (!from) return { at: rest.at, releasedAt: release.at };
  const left = stationLeftFrom(from, release.at, now);
  const at = left ? adriftAt(left.planetId, left.orbitSlot) : stationInTransit(from, now) ? rest.at : placeOf(from);
  return { at, from, releasedAt: release.at };
}

/**
 * 🚚 Keep this ship's rest record (shipDoc.RestPlace) by what its own room
 * sees, so where it rests never hangs on which station moves an install has
 * heard of: while docks hold it, which doors they are and where their station
 * is (only when they change, and never while that station is between
 * planets); once the last of them lets go, where its station was then, when
 * that takes no move history (its UNDOCK recorded it, or the station has not
 * moved since). For a docked ship only, one in open orbit by its record
 * included: docked by hand there, it goes where its dock takes it. Returns
 * whether it wrote.
 */
export function keepRestPlace(roomId: string = currentRoomId(), now: number = Date.now()): boolean {
  const rec = readFlightRecord();
  if (!roomId || rec.status !== 'docked') return false;
  const rest = readRestPlace();
  // Only a snapshot that holds every door: a dock it left out could be the
  // one still holding the ship, or the last to let go.
  const doors = readAllDoorsIfComplete();
  if (!doors) return false;
  const stations = listStations(undefined, undefined, now);
  const hostId = dockedStationFor(roomId, doors.values(), readAtlas(), stations);
  const host = hostId ? stations.find((s) => s.id === hostId) : undefined;
  if (host) {
    if (stationInTransit(host, now)) return false;
    const docks: string[] = [];
    for (const [doorId, door] of doors) {
      if (door.paired !== true || (door.transient !== true && !isDockChain(door.segments))) continue;
      let room = '';
      try { room = roomIdFromSeed(door.connectedRoomAddress); } catch { room = ''; }
      if (room && dockHost(room, stations)?.id === host.id) docks.push(doorId);
    }
    // Every one of them: a complete snapshot holds no more than a rest
    // record names (MAX_REST_DOCKS).
    docks.sort();
    if (docks.length === 0) return false;
    if (rest?.docks?.length === docks.length && rest.docks.every((d, i) => d === docks[i])) return false;
    return writeRestPlace({ at: placeOf(host), since: Math.floor(now), docks });
  }
  if (!rest?.docks?.length) return false;
  const resting = restingPlace(rest, now, stations);
  if ('heldBy' in resting || resting.from === undefined || resting.releasedAt === undefined) return false;
  // A place its UNDOCK recorded takes no move history; one read off the
  // station only while it has not moved since.
  if (!resting.recorded && (stationInTransit(resting.from, now) || stationLeftFrom(resting.from, resting.releasedAt, now))) return false;
  return writeRestPlace({ at: resting.at, since: Math.floor(resting.releasedAt), from: resting.from.id });
}

/**
 * 🚚 Does a ship room with these `doors` hold a live dock into a room of the
 * station whose welcome room is `welcomeRoomId`? A tug's tow lasts only while
 * it does (stationMove.cancelTowLeftBehind). True when it does, or when
 * `doors` could leave one out (null: readAllDoorsIfComplete; no proof it let
 * go); else, when the room let go of that station by its dock tombstones
 * (each UNDOCK's own stamp, however late this tab learns of it), the moment
 * the LAST of those docks let go, at or after `since` (the tow's booking): a
 * station held through two ports stays in tow until both have let go; else
 * false (not docked, time unknown).
 */
export function dockedToStation(
  welcomeRoomId: string,
  since = -Infinity,
  doors: ReadonlyMap<string, DoorRecord> | null = readAllDoorsIfComplete(),
): boolean | number {
  if (!doors) return true;
  let released: number | null = null;
  for (const [, rec] of doors) {
    const address = rec.paired === true ? rec.connectedRoomAddress : rec.retiredAddress;
    if (!address) continue;
    if (rec.paired === true && rec.transient !== true && !isDockChain(rec.segments)) continue;
    if (rec.paired !== true && !rec.dock) continue;
    let partner = '';
    try {
      partner = roomIdFromSeed(address);
    } catch {
      continue;
    }
    if (!partner || stationForRoom(partner)?.welcomeRoomId !== welcomeRoomId) continue;
    if (rec.paired === true) return true;
    const at = rec.dock!.undockedAt;
    if (at >= since && (released === null || at > released)) released = at;
  }
  return released ?? false;
}

/** Record that the ship came to rest beside the station `locationId` names,
 *  docking through `docks` (none: without a dock). An open-orbit place is its
 *  own rest, and a station this install cannot list gives none: either clears
 *  the record, so no earlier stay's rest outlives this arrival. */
function restBeside(locationId: string, now: number, docks: string[]): void {
  const st = adriftPlace(locationId) ? undefined : listStations(undefined, undefined, now).find((s) => s.id === locationId);
  const rest = st && !stationInTransit(st, now)
    ? { at: placeOf(st), since: Math.floor(now), docks: [...docks].sort().slice(0, MAX_REST_DOCKS) }
    : null;
  if (!writeRestPlace(rest)) writeRestPlace(null);
}

/**
 * 🚚 What DEPART keeps of where its stations orbit as the ship casts off, as
 * open-orbit places: the origin's (one in open orbit already is its own
 * place) and the destination's. Nothing for a station this install cannot
 * list.
 */
export function castOffPlaces(fromId: string, destinationId: string): Pick<FlightRecord, 'originAt' | 'destinationAt'> {
  const records = listStations();
  const placeOf = (id: string): string | undefined => {
    if (adriftPlace(id)) return id;
    const st = records.find((r) => r.id === id);
    return st ? adriftAt(planetById(st.planetId).id, st.orbitSlot) : undefined;
  };
  const originAt = placeOf(fromId);
  const destinationAt = placeOf(destinationId);
  return { ...(originAt ? { originAt } : {}), ...(destinationAt ? { destinationAt } : {}) };
}

/**
 * Where the ship is. While it sits docked into a station, its docks say so
 * (the directory's `here`) — a ship docked by hand at a new station is AT that
 * station, whatever the last flight wrote. Otherwise the flight record's
 * location stands, unless that station has moved on without the ship
 * (shipPlaceId).
 */
export function shipLocationId(rec: FlightRecord, hasLiveDock: boolean): string {
  if (rec.status === 'docked' && hasLiveDock) {
    const here = stationHere();
    if (here) return here;
  }
  return shipPlaceId(rec);
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
    // At rest there without a dock.
    restBeside(locationId, now, []);
    return outcome;
  };
  // A destination that left the directory mid-flight is NOT home: arrive
  // there undocked rather than docking at findDestination's fallback.
  // It waits in open orbit where the station was at cast-off, when the
  // flight kept that (a station pruned from this install's list after it
  // moved): a place every planet reader resolves, unlike a lost station id.
  if (!isKnownStation(rec.locationId)) {
    const at = rec.destinationAt && adriftPlace(rec.destinationAt) ? rec.destinationAt : rec.locationId;
    return settle({ kind: 'none', stationName: rec.locationId, reason: 'unlisted-station' }, at);
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
  const plan = planArrivalDock({
    station,
    remembered: resolveRememberedBerth(readStationBerth(station.id), ports),
    ports,
  });
  if (plan.kind === 'none') {
    const outcome: ArrivalOutcome = { kind: 'none', stationName: station.name, reason: plan.reason };
    if (plan.reason === 'already-docked') {
      writeFlightRecord({ status: 'docked', locationId: rec.locationId });
      restBeside(rec.locationId, now, ports.filter((p) => p.state.kind === 'docked').map((p) => p.doorId));
      return outcome;
    }
    return settle(outcome);
  }
  writeFlightRecord({ status: 'docked', locationId: rec.locationId });
  // Arrived, docking through this port: should the berth refuse the DOCK, the
  // ship rests here without one.
  restBeside(rec.locationId, now, [plan.doorId]);
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
