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
import {
  berthMemoryFrom, dockAnswerOf, stampAfter, type DockAnswer, type DockOpOptions, type DockPortState, type DockRefusal,
} from './dockRules';
import {
  readAllDoorsIfComplete, readDoor, readPhysicalDoors, writeDoorTombstone, type DockBerthMemory, type DoorRecord,
} from './doorsDoc';
import { atlasComponent, readAtlas, roomIdFromSeed } from './stationAtlas';
import { dockLockedByMove, roomMovesKnown, stationLeftFrom } from './stationMove';
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
  undockHeld,
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

/** The docking system as departure/arrival drive it (world.ts and main.ts
 *  wire it; a route's keeper too, in keeper mode). */
export interface ShipDockingApi {
  ports: () => ArrivalPort[];
  /** The shipped UNDOCK. Its answer (docking.ts undockPort: false when the
   *  dock holds — a station between planets keeps its ships, or the port
   *  could not be operated) says whether this side let go; no answer counts
   *  as let go. 🚏 `opts.keeper`: a route's keeper casting off the route's
   *  port (docking.ts's rider carve-out). */
  undock: (doorId: string, opts?: DockOpOptions) => void | boolean | Promise<boolean | void>;
  /** The shipped DOCK. Its answer — 🚏 docking.ts redockPortAnswer: docked
   *  with the dock's stamp, or why not (dockRules.DockAnswer); a bare false
   *  when the far berth refused, from an older wrapper — lets an arrival try
   *  the station's next gate and say why none took the ship. No answer
   *  counts as docked. `opts.keeper`: KEEPER MODE (dockRules.DockOpOptions). */
  dock: (doorId: string, opts?: DockOpOptions) => void | boolean | DockAnswer | Promise<boolean | void | DockAnswer>;
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

let berthStationOf: ((roomId: string) => string | null) | null = null;

/** main.ts points this at the station a dock's far room is part of, so
 *  DEPART files under the station it leaves only the dock that leads into
 *  it, never a dock into another station or ship. Null clears it. */
export function setBerthStationResolver(fn: ((roomId: string) => string | null) | null): void {
  berthStationOf = fn;
}

/** Does a dock into `roomId` lead into `stationId`? Yes when nothing can
 *  tell; no when the resolver throws: a berth filed under the wrong station
 *  would dock the trip back there. */
function leadsInto(roomId: string, stationId: string): boolean {
  if (!berthStationOf) return true;
  try {
    return berthStationOf(roomId) === stationId;
  } catch {
    return false;
  }
}

function roomOf(seed: string): string {
  try {
    return roomIdFromSeed(seed);
  } catch {
    return '';
  }
}

/** 🎫 A pass this client holds for `roomId`: its own store first, else a
 *  port that already names that room (its live or last dock, in the doors doc
 *  every passenger shares anyway). Undefined when it holds none. The helm's
 *  "no pass" check, a remembered berth's DOCK and the ferry's board publishes
 *  (main.ts) all count passes this way. */
export function berthPassFor(roomId: string, ports: readonly ArrivalPort[]): string | undefined {
  if (!roomId) return undefined;
  const own = berthSeedFor(roomId);
  if (own && roomOf(own) === roomId) return own;
  for (const p of ports) {
    if (p.state.kind !== 'docked' && p.state.kind !== 'undocked') continue;
    if (roomOf(p.state.address) === roomId) return p.state.address;
  }
  return undefined;
}

/** Pair a remembered berth room with a pass this client holds for it
 *  (berthPassFor). */
export function resolveRememberedBerth(
  rec: BerthMemoryRecord | null,
  ports: readonly ArrivalPort[],
): RememberedBerth | null {
  if (!rec) return null;
  const address = berthPassFor(rec.roomId, ports);
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
  /** ⚓🚦 `barred`, with no-berth: the station lists gates, but none this ship
   *  may dock at from here (closed to it, reserved for another ship, or in a
   *  room this client cannot address). */
  | { kind: 'none'; reason: 'no-berth' | 'no-port' | 'already-docked'; barred?: true };

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
 * would reach the door record as a tombstone DOCK cannot parse). Nor is a
 * berth that names no far door: DOCK only asks the station for a named door,
 * and without that answer it would pair this side alone, a dock the station
 * never accepted.
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
        ...(u.farWall !== undefined ? { farWall: u.farWall } : {}),
        ...(u.farLateral !== undefined ? { farLateral: u.farLateral } : {}),
        ...(u.gate !== undefined ? { gate: u.gate } : {}),
        ...(u.access ? { access: u.access, ...(u.reservedFor ? { reservedFor: u.reservedFor } : {}) } : {}),
        ...(u.occupied ? { occupied: true } : {}),
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
  // Within a rank, gate order: the gates the memory reaches join the list
  // after the station's own, and their numbers put them back in place (one
  // with no number after the numbered ones, in list order).
  const gateOrder = (b: StationBerth) => b.gate ?? Number.POSITIVE_INFINITY;
  const listed: StationBerth[] = (station.berths ?? []).length > 0
    ? gates.map((b, i) => ({ b, i }))
      .sort((x, y) => rank(x.b) - rank(y.b) || gateOrder(x.b) - gateOrder(y.b) || x.i - y.i)
      .map((x) => x.b)
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
  return out.filter((b) => b.farDoor !== undefined);
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
  // Docked at any of this station's berths: already there. Its rooms count
  // too, so a dock another commander made at a gate this client cannot
  // address is never doubled, even when it can address no gate at all; so
  // do its public berth and the ship's memory, far door named or not.
  const stationRooms = new Set(input.station.berthRooms ?? []);
  const inStation = (address: string): boolean => {
    try { return stationRooms.has(roomIdFromSeed(address)); } catch { return false; }
  };
  const publicBerth = input.station.berth && isRoomSeed(input.station.berth.address) ? input.station.berth : null;
  const known = [...(berth ? [berth] : []), ...candidates, ...(publicBerth ? [publicBerth] : []), ...(remembered ? [remembered] : [])];
  if (ports.some((p) => p.state.kind === 'docked'
    && (inStation((p.state as { address: string }).address)
      || known.some((b) => sameRoom((p.state as { address: string }).address, b.address))))) {
    return { kind: 'none', reason: 'already-docked' };
  }
  // No berth, or one that names no far door (arrivalBerths says why).
  if (!berth || berth.farDoor === undefined) {
    const listsGates = (input.station.berths?.length ?? 0) > 0 || (input.station.unaddressed?.length ?? 0) > 0;
    return { kind: 'none', reason: 'no-berth', ...(listsGates ? { barred: true as const } : {}) };
  }
  // Open = free to dock AND ours to use right now: a busy or locked port
  // would refuse DOCK after its door record was already re-pointed.
  const open = (p: ArrivalPort) =>
    (p.state.kind === 'undocked' || p.state.kind === 'free') && !p.busy && p.canOperate !== false;
  const preferred = remembered ? ports.find((p) => p.doorId === remembered.doorId && open(p)) : undefined;
  const port = preferred ?? ports.find(open);
  if (!port) return { kind: 'none', reason: 'no-port' };
  const st = port.state;
  // DOCK dials the pass the tombstone holds: one that names the same room
  // but is not the station's (a fresh pass, with new ways to reach the room)
  // is re-pointed too.
  if (
    st.kind === 'undocked' &&
    st.address === berth.address &&
    holdsPoseOf(st.memory, berth) &&
    (berth.farDoor === undefined || st.memory.farDoor === berth.farDoor)
  ) {
    return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: null, ...gateOf(berth) };
  }
  const memory: DockBerthMemory = {
    undockedAt: stampAfter(st.kind === 'undocked' ? st.memory.undockedAt : undefined, input.now),
  };
  // A fresh pass to the far door the tombstone already names keeps the pose
  // it holds of that door wherever the berth names none.
  if (st.kind === 'undocked' && sameRoom(st.address, berth.address)
    && st.memory.farDoor === berth.farDoor && holdsPoseOf(st.memory, berth)) {
    if (st.memory.farWall !== undefined) memory.farWall = st.memory.farWall;
    if (st.memory.farLateral !== undefined) memory.farLateral = st.memory.farLateral;
  }
  if (berth.farDoor !== undefined) memory.farDoor = berth.farDoor;
  if (berth.farWall !== undefined) memory.farWall = berth.farWall;
  if (berth.farLateral !== undefined) memory.farLateral = berth.farLateral;
  return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: memory, ...gateOf(berth) };
}

function gateOf(berth: StationBerth): { gate?: number } {
  return berth.gate !== undefined ? { gate: berth.gate } : {};
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
  const keptAt = rec.status === 'redocking' ? rec.destinationAt
    : rec.status === 'in-flight' ? rec.originAt
      : undefined;
  // A flight that kept none (written before flights did, or cast off for a
  // station not listed then): where the station left from on its first move
  // since the ship cast off, among the moves known here, which is where it
  // was then (as completeArrival reads it).
  const leftAt = rec.castOffAt ?? rec.departedAt;
  const left = keptAt === undefined && (rec.status === 'redocking' || rec.status === 'in-flight') && listed && leftAt !== undefined
    ? stationLeftFrom(listed, leftAt, now) : null;
  const kept = keptAt ?? (left ? adriftAt(left.planetId, left.orbitSlot) : undefined);
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
  const partner = dockPartner(roomId, stations);
  return partner === 'lone' ? null : partner;
}

/** dockHost, telling another lone module the atlas knows ('lone': a dock
 *  into it holds the ship nowhere) from a room no listed station holds
 *  (null: where that dock holds the ship is unknown here). */
function dockPartner(roomId: string, stations: StationRecord[]): StationRecord | 'lone' | null {
  const atlas = readAtlas();
  const st = stationForRoom(roomId, atlas, stations);
  if (!st) return null;
  return st.derived && atlasComponent(atlas, st.welcomeRoomId).size <= 1 ? 'lone' : st;
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

/** 🚚 Is the station a DOCK into `roomId` was asked of still where it was
 *  then (`at`: releasePlaceOf as the DOCK was asked)? The far write learns
 *  its room's moves (farDoorWrite): one found gone since (left for another
 *  planet while a ship flew to it, on a list that had not heard) is out of
 *  the ship's reach, and a dock to it would carry the ship across without a
 *  transfer (docking.ts redockPort takes its far write back). */
export function berthStillThere(roomId: string, at: string | undefined, now: number = Date.now()): boolean {
  return releasePlaceOf(roomId, now) === at;
}

/** The room a door's record leads to (paired) or last led to (a tombstone);
 *  '' for none, or for a peer-written address that names no room. */
function doorPartnerRoom(record: DoorRecord | undefined): string {
  if (!record) return '';
  try {
    return roomIdFromSeed(record.paired === true ? record.connectedRoomAddress : record.retiredAddress);
  } catch {
    return '';
  }
}

/** 🚚 Does a station move hold the connection through this door of `roomId`:
 *  a station between planets, or a tug's tow, at either end? Then neither
 *  end lets go until it arrives (docking.ts undockPort and DETACH). */
export function berthHeldByMove(roomId: string, doorId: string, now: number = Date.now()): boolean {
  const record = readDoor(doorId);
  return dockLockedByMove([roomId, record?.paired === true ? doorPartnerRoom(record) : ''], now);
}

/** 🚚 Every transient berth of `roomId` (#67 D2: a dock, or a legacy berth
 *  with no dock chain), when DEPART may cast them all off at `now`; else why
 *  not. Only the room's own doors, each read past the snapshot's cap
 *  (doorsDoc.readPhysicalDoors): records a peer floods the map with can
 *  neither hide a berth from it nor hold the ship (a dock on a door the room
 *  lacks leads nowhere). A station move holds one of them (berthHeldByMove):
 *  a station between planets keeps the ships it holds, and UNDOCK and
 *  DETACH both refuse, so DEPART does too. Or, with a berth to let go of,
 *  not every move of the room can be read (roomMovesKnown), where the one
 *  holding it may lie. With `asked` (berthPairings: what DEPART asked the
 *  far rooms about, at `now`), only those berths, each still the pairing it
 *  was: any other was never judged at that moment ('changed'). */
export function berthsToCastOff(
  roomId: string,
  now: number = Date.now(),
  asked?: ReadonlyMap<string, DoorRecord | undefined>,
): { ok: true; berths: string[] } | { ok: false; why: 'moving' | 'unread' | 'changed' } {
  const doors = readPhysicalDoors();
  const berths: string[] = [];
  for (const [doorId, door] of doors) {
    if (door.paired === true && (door.transient === true || isDockChain(door.segments))) berths.push(doorId);
  }
  if (berths.length > 0 && !roomMovesKnown()) return { ok: false, why: 'unread' };
  if (berths.some((doorId) => berthHeldByMove(roomId, doorId, now))) return { ok: false, why: 'moving' };
  if (asked && berths.some((doorId) => !samePairing(asked.get(doorId), doors.get(doorId)))) return { ok: false, why: 'changed' };
  return { ok: true, berths };
}

/** The pairings on these doors as they are now: what a release asks the
 *  far rooms about (berthsToCastOff's `asked`). */
export function berthPairings(doorIds: readonly string[]): Map<string, DoorRecord | undefined> {
  return new Map(doorIds.map((doorId) => [doorId, readDoor(doorId)]));
}

/** The same pairing, the one a release asked about: to the same room, made
 *  at the same moment. */
function samePairing(asked: DoorRecord | undefined, now: DoorRecord | undefined): boolean {
  return asked?.paired === true && now?.paired === true
    && asked.connectedRoomAddress === now.connectedRoomAddress && asked.dockedAt === now.dockedAt;
}

/**
 * ⏏ #67 D2: DETACH the legacy berth on `doorId` of `roomId` (a transient
 * pairing on a door that is no dock port: no UNDOCK asks its far room), as
 * one release made at `now`: its far room judges it at the stamp it takes
 * then (`ask`: FarDockRequest `release`, docking.ts farReleaseAllowed), this
 * end judges it again at that moment once the answer is in, by every move
 * it knows by then (the far room's among them: farDoorWrite), and the
 * tombstone takes that stamp (detachBerth). A move booked there after the
 * answer then leaves after the release, however long the answer took: the
 * ship stays where the station was. Only the pairing asked about, while
 * `roomNow()` is still the room it was asked from. 'held': a move holds
 * it; 'changed': the pairing, or the room, changed meanwhile.
 */
export async function detachLegacyBerthAt(
  roomId: string,
  doorId: string,
  ask: (now: number) => Promise<boolean>,
  roomNow: () => string = currentRoomId,
  now: number = Date.now(),
): Promise<'released' | 'held' | 'changed'> {
  const asked = berthPairings([doorId]);
  if (asked.get(doorId)?.paired !== true) return 'changed';
  let allowed = true;
  try {
    allowed = await ask(now);
  } catch {
    // Best effort, as an UNDOCK's far write: one that cannot ask does not hold it.
  }
  const same = roomNow() === roomId && samePairing(asked.get(doorId), readDoor(doorId));
  if (!allowed || (same && berthHeldByMove(roomId, doorId, now))) return 'held';
  return same && detachBerth(doorId, now) ? 'released' : 'changed';
}

/**
 * ⏏ #67 D2: DETACH a transient berth here — a tombstone, not a delete. 🚚 As
 * an UNDOCK's does, it records when this end let go and where the other
 * end's station was then (DockBerthMemory.at, releasePlaceOf), so a ship the
 * berth held rests there (restingPlace), wherever the berth had carried it;
 * and no walk-through mirrors the berth back (dockRules.mirrorMayWrite).
 * Returns whether it wrote. A berth a station move holds is the caller's to
 * refuse first (berthHeldByMove).
 */
export function detachBerth(doorId: string, now: number = Date.now()): boolean {
  const record = readDoor(doorId);
  if (record?.paired !== true) return false;
  const far = doorPartnerRoom(record);
  writeDoorTombstone(
    doorId,
    record.connectedRoomAddress,
    berthMemoryFrom(record, stampAfter(record.dockedAt, now), far ? releasePlaceOf(far, now) : undefined),
  );
  return true;
}

/**
 * 🚚 An UNDOCK records where the far end's station was as it let go (`was`,
 * DockBerthMemory.at) before it asks the far room, whose moves it learns
 * then (farDoorWrite): when those place the station elsewhere at that moment
 * (`at`), this end's tombstone takes `at`, while it is still that UNDOCK's
 * (`undockedAt`), and so does the rest a ship took from it meanwhile
 * (keepRestPlace). Returns whether it wrote.
 */
export function correctReleasePlace(
  doorId: string,
  undockedAt: number,
  was: string | undefined,
  at: string | undefined,
): boolean {
  if (at === undefined || at === was) return false;
  const record = readDoor(doorId);
  if (!record || record.paired === true || record.dock?.undockedAt !== undockedAt) return false;
  writeDoorTombstone(doorId, record.retiredAddress, { ...record.dock, at });
  const rest = readRestPlace();
  if (rest && !rest.docks?.length && rest.since === Math.floor(undockedAt) && rest.at === was) {
    writeRestPlace({ ...rest, at });
  }
  return true;
}

/**
 * What a ship's rest record (shipDoc.RestPlace) says at `now`, from the doors
 * it names, each read directly: a scan of the doors is capped, and a peer
 * could push the very door out of it.
 * - `heldBy`: a dock through one of them still holds the ship (its station,
 *   when listed; a dock into another lone module holds it nowhere);
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
      // A gangway is structure, not a dock: that ship is no free ship. A
      // dock into another lone module (a door the rest still names, docked
      // there since) holds it nowhere: where it rests stands. One into a room
      // no listed station holds leaves where unknown: the record's station.
      if (door.transient === true || isDockChain(door.segments)) {
        const partner = dockPartner(room, stations);
        if (partner !== 'lone') return { heldBy: partner?.id ?? null };
      }
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
    // The station's place too: docks that carried the ship to another planet
    // are the same doors, and a release that records no place (an older
    // build's DETACH) falls back on where the record says it rests.
    const at = placeOf(host);
    if (rest?.at === at && rest.docks?.length === docks.length && rest.docks.every((d, i) => d === docks[i])) return false;
    return writeRestPlace({ at, since: Math.floor(now), docks });
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
 * false (not docked, time unknown). A release whose UNDOCK still waits on
 * its far room at `now` (shipDoc.UndockHold) is no release yet: a far
 * refusal puts that dock back.
 */
export function dockedToStation(
  welcomeRoomId: string,
  since = -Infinity,
  doors: ReadonlyMap<string, DoorRecord> | null = readAllDoorsIfComplete(),
  now: number = Date.now(),
): boolean | number {
  if (!doors) return true;
  let released: number | null = null;
  for (const [doorId, rec] of doors) {
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
    if (undockHeld(doorId, at, now)) return true;
    if (at >= since && (released === null || at > released)) released = at;
  }
  return released ?? false;
}

/** Record that the ship came to rest beside the station `locationId` names,
 *  docking through `docks` (none: without a dock). An open-orbit place is its
 *  own rest, and a station this install cannot list gives none: either clears
 *  the record, so no earlier stay's rest outlives this arrival. (🚏 A ferry
 *  route's copy-back records its end stop the same way while docked there:
 *  restAtRouteEnd.) */
export function restBeside(locationId: string, now: number, docks: string[]): void {
  const st = adriftPlace(locationId) ? undefined : listStations(undefined, undefined, now).find((s) => s.id === locationId);
  const rest = st && !stationInTransit(st, now)
    ? { at: placeOf(st), since: Math.floor(now), docks: [...docks].sort().slice(0, MAX_REST_DOCKS) }
    : null;
  if (!writeRestPlace(rest)) writeRestPlace(null);
}

/** 🚏🚚 Record where a ferry route's copy-back (main.ts, after STOP) leaves
 *  the ship at its end stop `locationId`. Docked there through `docks`, it
 *  rests beside the station its dock carries it with (restBeside). With no
 *  dock, it is where the timetable left it: on the route's copy of the stop
 *  (`end`, shipRoute.settleRouteFlight's), which the stop's station may have
 *  left for another planet or slot (the keeper passes that berth). So it
 *  rests there, not at the station's new place, and is beside the station
 *  again only while that is back on that orbit (shipPlaceId). No copy: as
 *  restBeside. */
export function restAtRouteEnd(
  locationId: string,
  end: { planetId: string; orbitSlot: number } | null,
  now: number,
  docks: string[],
): void {
  if (docks.length > 0 || !end) {
    restBeside(locationId, now, docks);
    return;
  }
  if (!writeRestPlace({ at: adriftAt(planetById(end.planetId).id, end.orbitSlot), since: Math.floor(now) })) writeRestPlace(null);
}

/** 🚚 What an arrival re-points its port with before the DOCK (`memory`,
 *  planArrivalDock's retarget): where the ship arrived (`arrived`, the rest
 *  restBeside wrote) as the place the tombstone lets go at. The rest names
 *  that port until the DOCK answers, so its tombstone reads as a release
 *  (restingPlace), and the ship never went where the station turns out to be
 *  by moves heard meanwhile (the far room's, as the DOCK asks it). */
function retargetAt(memory: DockBerthMemory, arrived: RestPlace | null): DockBerthMemory {
  return arrived ? { ...memory, at: arrived.at } : memory;
}

/** 🚚 An arrival's DOCK refused: the rest it wrote (`arrived`, restBeside)
 *  names no dock any more, so the ship rests where it arrived, never where
 *  the station is now (the port's tombstone, re-pointed at the berth as the
 *  DOCK was asked, would read as a release of it). Whether that station has
 *  since gone from there (between planets, or orbiting elsewhere: what the
 *  far room knew, redockPort's berthStillThere). */
function restUndocked(arrived: RestPlace | null, stationId: string, now: number = Date.now()): boolean {
  if (!arrived) return false;
  const rest = readRestPlace();
  if (rest && rest.at === arrived.at && rest.since === arrived.since && rest.docks?.length) {
    writeRestPlace({ at: arrived.at, since: arrived.since });
  }
  const st = listStations(undefined, undefined, now).find((s) => s.id === stationId);
  return !!st && (stationInTransit(st, now) || placeOf(st) !== arrived.at);
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

/** A port's tombstone holds the berth door's pose, wherever the berth gives
 *  one: a door moved along its wall keeps its room and id, so the berth's
 *  pose (the directory's, as the door is now) is what DOCK must place by. */
function holdsPoseOf(memory: DockBerthMemory, berth: StationBerth): boolean {
  return (berth.farWall === undefined || memory.farWall === berth.farWall)
    && (berth.farLateral === undefined || memory.farLateral === berth.farLateral);
}

/** The berth to remember at the station being left: the first docked port,
 *  or, given that station's id, the first whose dock leads into it
 *  (setBerthStationResolver): a ship docked at two places files neither
 *  under the other. */
export function berthToRemember(ports: readonly ArrivalPort[], stationId?: string): BerthMemoryRecord | null {
  for (const p of ports) {
    if (p.state.kind !== 'docked') continue;
    const rec = p.state.record;
    const roomId = roomOf(p.state.address);
    if (!roomId) continue; // a malformed dock: keep looking for a good one
    if (stationId !== undefined && !leadsInto(roomId, stationId)) continue;
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
  const berth = berthToRemember(ports, stationId);
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

/** A cast-off that does not wait: remember the berth here, then UNDOCK every
 *  docked port. Returns whether the berth here is remembered. A flight
 *  committed before its docks answer can find one that holds: the helm's
 *  DEPART waits for them (releaseEveryDock). */
export function castOffForDeparture(stationId: string, docking: ShipDockingApi): boolean {
  const ports = docking.ports();
  const remembered = rememberBerthHere(stationId, ports);
  if (!remembered) console.warn(`[ship] could not remember the berth at ${stationId}`);
  for (const p of ports) {
    if (p.state.kind === 'docked') docking.undock(p.doorId);
  }
  return remembered;
}

/** 🚚 UNDOCK every docked port and wait for each answer: true once every one
 *  let go. A dock that holds keeps the ship — a station between planets
 *  carries the ships docked to it, and the far room may know of a move this
 *  client has not heard of (docking.ts undockPort then puts this side back)
 *  — so DEPART commits its flight and its fuel only after this. */
export async function releaseEveryDock(docking: ShipDockingApi): Promise<boolean> {
  const answers = await Promise.all(docking.ports()
    .filter((p) => p.state.kind === 'docked')
    .map(async (p) => {
      try {
        return (await docking.undock(p.doorId)) !== false;
      } catch {
        return false;
      }
    }));
  return answers.every(Boolean);
}

/** 🧾 The stay of a route a keeper's note is about (routeKeeper.keeperNote):
 *  the helm shows the note only while it still holds there. */
export interface RouteNoteStay {
  run: number;
  legSeq: number;
}

/** What the last arrival did — the helm shows it. */
export type ArrivalOutcome =
  | { kind: 'docking'; stationName: string; gate?: number }
  /** ⚓🚦 The DOCK went through (reported once the far berth answered).
   *  🚏 `gateChange`: a route's ferry docked at another gate than its stop's
   *  own (choice 9, announced as a gate change). */
  | { kind: 'docked'; stationName: string; gate?: number; gateChange?: boolean; routeStay?: RouteNoteStay }
  | {
      kind: 'none';
      /** ⚓🚦 With no-berth: the station's gates are all shut to this ship
       *  from here (ArrivalPlan's `barred`). */
      barred?: true;
      stationName: string;
      /**
       * `berths-taken`: every berth tried refused, and at least one without
       * saying why (an older docking API's bare false). Usually taken, closed
       * or unreachable, but redockPort also refuses for its own reasons (no
       * rights, no room to fit, a busy port); the port's panel says which.
       * `in-transit`: the destination is between planets.
       * 🚏 A5, when every berth said why:
       *   `occupied`     one or more was taken (or the module would overlap
       *                  there, or the gate is not open to this ship);
       *   `unreachable`  none could be reached or asked from this game;
       *   `berth-gone`   every one was removed (its door, or its port).
       */
      reason:
        | 'no-berth' | 'no-port' | 'already-docked' | 'unlisted-station' | 'berths-taken'
        | 'in-transit' | 'occupied' | 'unreachable' | 'berth-gone';
      /** 🚏 A route's keeper: what the ferry does about it — holds at the
       *  stop, skips it (🧾 `why`: every gate gone, or shut to this ferry),
       *  or rides on (this game could not dock it). */
      route?: { action: 'hold' | 'skip' | 'ride-on'; nextStopName: string; why?: 'gone' | 'shut' };
      routeStay?: RouteNoteStay;
    };

/** 🚏 Why a whole arrival refused, from each berth's DOCK answer (A5):
 *  `berth-gone` when every berth was removed, `occupied` when any was taken
 *  (or shut to this ship), `unreachable` when none could be asked or reached,
 *  and `berths-taken` when any answer came without a reason. */
export function arrivalRefusal(reasons: readonly DockRefusal[]): 'berths-taken' | 'occupied' | 'unreachable' | 'berth-gone' {
  if (reasons.length === 0 || reasons.includes('refused')) return 'berths-taken';
  if (reasons.every((r) => r === 'gone' || r === 'closed')) return 'berth-gone';
  const taken: readonly DockRefusal[] = ['occupied', 'overlap', 'not-allowed', 'superseded'];
  if (reasons.some((r) => taken.includes(r))) return 'occupied';
  const unreached: readonly DockRefusal[] = ['unreachable', 'no-address', 'no-far-door', 'no-writer'];
  if (reasons.every((r) => unreached.includes(r) || r === 'gone' || r === 'closed')) return 'unreachable';
  return 'berths-taken';
}

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
    /** ⚓🚦 Called before each retry's DOCK, once an earlier gate refused,
     *  with the gate now tried: the helm's "docking at gate N" follows the
     *  ship from gate to gate. Never called for the first gate (this
     *  returns that one) nor after the docking settles. */
    onProgress?: (outcome: Extract<ArrivalOutcome, { kind: 'docking' }>) => void;
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
  const listedNow = listStations().find((s) => s.id === rec.locationId);
  // A flight that kept none (written before flights did, or cast off for a
  // station not listed then): where the station left from on its first move
  // since the ship cast off, among the moves known here, which is where it
  // was then. Its latest alone cannot say: a tow cancelled after a transfer
  // that took it away stands for no journey.
  const wasAt = castOffPlace
    ?? (listedNow && leftAt !== undefined ? stationLeftFrom(listedNow, leftAt, now) : null);
  // With both places known, where it orbits now says whether it went: back
  // where it was at cast-off (bounced home off a full planet, or there and
  // back) its berth is in reach, whatever moves it made meanwhile. Without
  // them, any move that overlapped the time away.
  const movedAway = wasAt && listedNow
    ? planetById(listedNow.planetId).id !== planetById(wasAt.planetId).id || listedNow.orbitSlot !== wasAt.orbitSlot
    : movedMidFlight;
  if (stationInTransit(station, now) || movedAway) {
    // The ship waits in open orbit where the station was, a place of its own
    // (stationDirectory.adriftAt) that follows no station; it flies on from
    // there to any station around that planet.
    const from = moved ?? station.move;
    const at = wasAt ? adriftAt(wasAt.planetId, wasAt.orbitSlot)
      : from ? adriftAt(from.fromPlanetId, from.fromSlot) : adriftAt(station.planetId, 0);
    return settle({ kind: 'none', stationName: station.name, reason: 'in-transit' }, at);
  }
  if (!docking) return settle({ kind: 'none', stationName: station.name, reason: 'no-port' });
  const ports = docking.ports();
  const remembered = resolveRememberedBerth(readStationBerth(station.id), ports);
  const shipRoomId = currentRoomId();
  const plan = planArrivalDock({ station, remembered, ports, gate: opts.gate, shipRoomId });
  if (plan.kind === 'none') {
    const outcome: ArrivalOutcome = {
      kind: 'none', stationName: station.name, reason: plan.reason, ...(plan.barred ? { barred: true as const } : {}),
    };
    if (plan.reason === 'already-docked') {
      writeFlightRecord({ status: 'docked', locationId: rec.locationId });
      restBeside(rec.locationId, now, ports.filter((p) => p.state.kind === 'docked').map((p) => p.doorId));
      return outcome;
    }
    return settle(outcome);
  }
  writeFlightRecord({ status: 'docked', locationId: rec.locationId });
  const candidates = arrivalBerths({ station, remembered, gate: opts.gate, shipRoomId });
  // Arrived, docking through each port in turn: should every berth refuse
  // the DOCK, the ship rests here without one.
  let arrived: RestPlace | null = null;
  const rest = (doorId: string): RestPlace | null => {
    restBeside(rec.locationId, now, [doorId]);
    return (arrived = readRestPlace());
  };
  // 🚚 Refused, the ship rests where it arrived, held by no dock (a port's
  // re-pointed tombstone is no release of it); and its far room may have
  // known the station had left for another planet (redockPort:
  // berthStillThere), which the helm says as such.
  const refused = (): boolean => restUndocked(arrived, rec.locationId);
  void dockThroughBerths(docking, station, remembered, candidates, plan, opts.onSettled, shipRoomId, opts.onProgress, rest, refused);
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
  /** Told the gate each retry docks at, before its DOCK. */
  onProgress?: (outcome: Extract<ArrivalOutcome, { kind: 'docking' }>) => void,
  /** Records where the ship rests, docking through this port (restBeside),
   *  before each DOCK; returns that rest, the place a re-pointed port lets
   *  go at (retargetAt). */
  rest?: (doorId: string) => RestPlace | null,
  /** When the berths have refused: the ship rests undocked where it arrived,
   *  and true when its station has gone from there since (restUndocked). */
  refused?: () => boolean,
): Promise<void> {
  // `first` was planned for candidates[0] (planArrivalDock's own pick).
  const reasons: DockRefusal[] = [];
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
        onSettled?.({ kind: 'none', stationName: station.name, reason: refused?.() ? 'in-transit' : plan.reason });
      }
      return;
    }
    const arrived = rest?.(plan.doorId) ?? null;
    if (plan.retarget) writeDoorTombstone(plan.doorId, plan.address, retargetAt(plan.retarget, arrived));
    // A gate change: say which gate the ship docks at now, before asking it.
    if (i > 0) onProgress?.({ kind: 'docking', stationName: station.name, ...(plan.gate !== undefined ? { gate: plan.gate } : {}) });
    let answer: DockAnswer = { ok: false, reason: 'refused' };
    try {
      answer = dockAnswerOf(await docking.dock(plan.doorId));
    } catch (err) {
      console.warn('[ship] arrival DOCK threw:', err);
    }
    // A ship that left again while the berth answered (a DEPART) docks at no
    // further gate of the station it left, and the answer is not this
    // flight's: say nothing.
    const flight = readFlightRecord();
    if (flight.status !== 'docked' || flight.locationId !== station.id) return;
    // The await may have outlived the ship's room: the answer belongs to a
    // room no longer shown, so say nothing.
    if (shipRoomId !== undefined && currentRoomId() !== shipRoomId) return;
    if (answer.ok) {
      onSettled?.({ kind: 'docked', stationName: station.name, ...(plan.gate !== undefined ? { gate: plan.gate } : {}) });
      return;
    }
    reasons.push(answer.reason);
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
  // 🚏 A5: say why, when every berth said why (the helm's note no longer
  // shows a refused berth as green, nor one reason for all).
  onSettled?.({ kind: 'none', stationName: station.name, reason: refused?.() ? 'in-transit' : arrivalRefusal(reasons) });
}
