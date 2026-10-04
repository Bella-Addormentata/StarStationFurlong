/**
 * 🛰️ Station directory — where a ship can fly (#30 SH3).
 *
 * The helm's DESTINATION picker and the flight record read stations through
 * this one small interface, so the source of truth can change without the
 * flight code noticing. main.ts points it at the station record (stations.ts:
 * every station with its planet and orbit slot) through
 * directoryFromStationRecords; the static table below is what it serves
 * before that — and what the tests fly between.
 *
 * A station MAY name a public BERTH: the room (by its pass seed) and dock port
 * an arriving ship docks at. When it names none, the ship falls back to the
 * berth it remembers from its own last visit (shipDoc berth memory). A ship
 * that has neither arrives undocked and docks by hand from a door panel.
 *
 * Pure: no DOM, no Three, no bound doc. Pinned by stationDirectory.test.ts.
 */

import type { DoorWall } from './doorLayoutDoc';
import { isAcceptableDoorKey } from './doorsDoc';
import type { FlightStatus } from './shipDoc';
import { planTransfer } from './orbits';
import { ADRIFT_PREFIX, adriftPlace, latestMoveOf, stationInTransit } from './stations';
import type { StationMove, StationRoomCause } from './stations';

/** Where an arriving ship docks at a station: one dock port of one room. */
export interface StationBerth {
  /** The berth room's pass seed (what a DOCK record's address holds). */
  address: string;
  /** The berth room's door that wears the port, when known. */
  farDoor?: string;
  farWall?: DoorWall;
  farLateral?: number;
}

/** One station a ship can fly to. */
export interface StationDestination {
  id: string;
  name: string;
  /** The body the station orbits — a ship flies between stations sharing one. */
  planetId: string;
  /** Flat fuel cost of a hop TO this station (continuous burn is later). */
  fuelCost: number;
  /** Writer-clock travel time of a hop to this station, ms. */
  travelMs: number;
  berth?: StationBerth;
  /** A move to another planet, scheduled or under way (stations.ts): while
   *  it is in transit the station is no ship's destination. */
  move?: StationMove;
  /** Its latest move even once finished: arrival checks it against the
   *  flight, so a ship never docks at a station that moved away meanwhile. */
  lastMove?: StationMove;
}

/** The seam: whatever knows the stations. */
export interface StationDirectory {
  /** Every known station. The FIRST is home — where an unknown id resolves. */
  stations(): readonly StationDestination[];
  /** The station the ship's room is docked at right now: the one its live
   *  docks lead into. Null with no live dock (floating free, the ship's own
   *  one-module station is `own`, never `here`) or when that is not known.
   *  Never a destination. */
  here?(): string | null;
  /** Every station the ship's live docks lead into (`here` is one of them):
   *  a ship docked into two stations at once is at both. Never a
   *  destination. */
  docked?(): readonly string[];
  /** The ship's OWN one-module station, when its room is listed as one (a
   *  module docked only by transient docks is its own atlas group) — never a
   *  destination. */
  own?(): string | null;
  /** When the hop from → to leaves and lands, and what it burns, asked at
   *  `nowMs`; null when there is no such hop. Absent ⇒ every hop leaves now
   *  and takes the destination's flat travelMs / fuelCost. */
  plan?(fromId: string, toId: string, nowMs: number): HopPlan | null;
  /** This install's id for a station id another install wrote (station ids
   *  are per install, and a flight record travels in the ship's room doc),
   *  or null when none matches. Absent ⇒ ids are taken as written. */
  resolve?(id: string): string | null;
  /** The id to write into a shared record for this install's station `id`,
   *  one every install resolves to the same station (its welcome room), or
   *  null to write `id` as it is. */
  portable?(id: string): string | null;
}

/** One planned hop. Times are real epoch ms; `departAt` may be in the future
 *  (a launch window still to come). */
export interface HopPlan {
  departAt: number;
  arriveAt: number;
  fuelCost: number;
  /** Real ms between launch windows for this pair, when windows repeat. */
  windowEveryMs?: number;
}

/** Travel time floor (plan §5.1 targets 60–120 s). */
export const TRAVEL_MS_MIN = 60_000;

/** The planet the default stations orbit (map.ts `planet-sovereign`). */
export const HOME_PLANET_ID = 'planet-sovereign';

/** The static table (plan §5.2): three stations around SOVEREIGN II. */
export const DEFAULT_STATIONS: readonly StationDestination[] = [
  { id: 'furlong-station', name: 'Furlong Station', planetId: HOME_PLANET_ID, fuelCost: 0, travelMs: TRAVEL_MS_MIN },
  { id: 'high-orbit', name: 'High Orbit', planetId: HOME_PLANET_ID, fuelCost: 25, travelMs: TRAVEL_MS_MIN },
  { id: 'l4-anchorage', name: 'L4 Anchorage', planetId: HOME_PLANET_ID, fuelCost: 50, travelMs: TRAVEL_MS_MIN + 30_000 },
];

const staticDirectory: StationDirectory = { stations: () => DEFAULT_STATIONS };
let directory: StationDirectory = staticDirectory;

/** Point the flight code at another station source; null restores the table. */
export function setStationDirectory(next: StationDirectory | null): void {
  directory = next ?? staticDirectory;
}

/** Every known station — never empty (an empty source falls back to the table). */
export function listStations(): readonly StationDestination[] {
  const list = directory.stations();
  return list.length > 0 ? list : DEFAULT_STATIONS;
}

/** This install's id for `id`: the directory's alias for it when that is
 *  listed (asked FIRST, so a portable id resolves by its welcome room even
 *  when a local record happens to share the id), else itself, which is
 *  unknown when unlisted. An open-orbit place is never a station (stations.ts
 *  reserves its prefix), so it is itself whatever alias a peer's summary
 *  claims for it: no summary moves a ship adrift. */
export function localStationId(id: string): string {
  if (id.startsWith(ADRIFT_PREFIX)) return id;
  const list = listStations();
  let alias: string | null = null;
  try { alias = directory.resolve?.(id) ?? null; } catch { alias = null; }
  return alias && list.some((s) => s.id === alias) ? alias : id;
}

/** The id a shared record carries for this install's station `id`. */
export function portableStationId(id: string): string {
  let out: string | null = null;
  try { out = directory.portable?.(id) ?? null; } catch { out = null; }
  return out ?? id;
}

/** Look a station up; unknown ids resolve to home (plan §2, item 4). */
export function findStation(id: string): StationDestination {
  const list = listStations();
  return list.find((s) => s.id === id) ?? list[0];
}

// Adrift places live in stations.ts (planetForRoom reads them too).
export { ADRIFT_PREFIX, adriftAt, adriftPlace } from './stations';

/** The planet a ship's location is at: its station's, or an adrift
 *  location's own; null when unlisted. */
export function locationPlanet(id: string): string | null {
  const adrift = adriftPlace(id);
  if (adrift) return adrift.planetId;
  return isKnownStation(id) ? findStation(id).planetId : null;
}

/** Is `id` a station the directory knows (no home fallback)? */
export function isKnownStation(id: string): boolean {
  return listStations().some((s) => s.id === id);
}

/** Plan the hop from → to at `nowMs`: the directory's own planner (orbits),
 *  else a flat hop that leaves now. Null for an unknown or unreachable pair,
 *  and for one a station move cuts into. */
export function planHop(fromId: string, toId: string, nowMs: number): HopPlan | null {
  // Both ends must be listed: findStation would quietly read an unknown
  // origin as home.
  if (fromId === toId || !(isKnownStation(fromId) || adriftPlace(fromId)) || !isKnownStation(toId)) return null;
  let hop: HopPlan | null;
  if (directory.plan) {
    const plan = directory.plan(fromId, toId, nowMs);
    if (!plan || !(plan.arriveAt > plan.departAt) || !Number.isFinite(plan.fuelCost)) return null;
    hop = wholeMs(plan);
  } else {
    const dest = findStation(toId);
    if (locationPlanet(fromId) !== dest.planetId) return null;
    hop = wholeMs({ departAt: nowMs, arriveAt: nowMs + Math.max(1, dest.travelMs), fuelCost: dest.fuelCost });
  }
  if (!hop) return null;
  // 🚚 Checked by the times the flight record keeps (rounded up): a flat hop
  // has no planner to check them, and rounding can carry a burn past the
  // moment a station leaves.
  const list = listStations();
  const moveOf = (id: string) => list.find((s) => s.id === id)?.move;
  return moveCutsHop(adriftPlace(fromId) ? undefined : moveOf(fromId), moveOf(toId), hop, nowMs) ? null : hop;
}

/** Does a station move cut into a hop planned at `nowMs`: one under way (or
 *  coming) while either end must hold still — the source until the ship
 *  leaves, the destination until it arrives? A move that starts at the
 *  source after the burn is no concern of the hop; one that lands before it
 *  would leave the plan on the old orbit. A move that goes nowhere (a pin)
 *  holds its station where it is. */
function moveCutsHop(
  fromMove: StationMove | undefined,
  toMove: StationMove | undefined,
  hop: Pick<HopPlan, 'departAt' | 'arriveAt'>,
  nowMs: number,
): boolean {
  const within = (m: StationMove | undefined, until: number) => !!m && m.departAt <= until && m.arriveAt > nowMs
    && (m.fromPlanetId !== m.toPlanetId || m.fromSlot !== m.toSlot);
  return within(fromMove, hop.departAt) || within(toMove, hop.arriveAt);
}

/** A hop's times as whole milliseconds, which is all a flight record stores
 *  (shipDoc isFlightRecord): orbital math gives fractions. Rounded up, so a
 *  ship never burns before its window; null when a time is no safe integer,
 *  or when the hop would burn a negative amount (DEPART would add fuel). */
function wholeMs(plan: HopPlan): HopPlan | null {
  if (!(Number.isFinite(plan.fuelCost) && plan.fuelCost >= 0)) return null;
  const departAt = Math.ceil(plan.departAt);
  const arriveAt = Math.max(departAt + 1, Math.ceil(plan.arriveAt));
  if (!Number.isSafeInteger(departAt) || !Number.isSafeInteger(arriveAt)) return null;
  return { ...plan, departAt, arriveAt };
}

// ── Flight capability ────────────────────────────────────────────────────────

let stationRoomCheck: (() => StationRoomCause | null) | null = null;

/** Say why the current room is a station's own, or null when it is not
 *  (stations.stationRoomCause): wired from main.ts; null clears it. */
export function setStationRoomCheck(check: (() => StationRoomCause | null) | null): void {
  stationRoomCheck = check;
}

/** Why the current room is a station's own, so engine, tank and helm do not
 *  fly it (flightCapable), or null: what the helm names in place of missing
 *  systems. A check that throws reads as no station room. */
export function groundedBy(): StationRoomCause | null {
  try { return stationRoomCheck?.() ?? null; } catch { return null; }
}

/** Engine, tank and helm fly a ship (`shipReady`), but a station's own room
 *  wearing them, for station keeping, never DEPARTs on a hop: no flight, and
 *  no location taken from the ship's flight record. */
export function flightCapable(shipReady: boolean): boolean {
  return shipReady && groundedBy() === null;
}

/** May engine, tank and helm (`shipReady`) fly the current room freely, by
 *  hand and on to PARK in a new orbit? A ship may, and so may a one-module
 *  station's own room ('lone-station'), though it never DEPARTs
 *  (flightCapable): no gangway holds it, so it leaves nothing of the station
 *  behind. A module bolted in, or the welcome room of a station of several
 *  modules, may not. */
export function freeFlightCapable(shipReady: boolean): boolean {
  if (!shipReady) return false;
  const why = groundedBy();
  return why === null || why === 'lone-station';
}

/** Does the current room take its place from the ship's flight record
 *  (`status`)? A flight under way (casting off, in transit, arriving) keeps
 *  it whatever the room wears now, since a fitting may come off mid-trip; a
 *  docked record only while the room may fly (`capable`, flightCapable's
 *  answer: a module that never flew reads the record's default place). A
 *  station's own room never does. */
export function followsFlightRecord(status: FlightStatus, capable: boolean): boolean {
  return status === 'docked' ? capable : groundedBy() === null;
}

/** The station the ship's room belongs to right now, when the source knows. */
export function stationHere(): string | null {
  const id = directory.here?.() ?? null;
  return id && isKnownStation(id) ? id : null;
}

/** The stations a ship at `fromId` may fly to: every OTHER station orbiting
 *  the same planet (and never one its room belongs to right now, nor any
 *  its live docks lead into). */
export function destinationsFrom(fromId: string): StationDestination[] {
  const adrift = adriftPlace(fromId);
  const from = adrift ? { id: fromId, planetId: adrift.planetId } : findStation(fromId);
  const here = stationHere();
  const own = directory.own?.() ?? null;
  const docked = new Set(directory.docked?.() ?? []);
  // A station between planets (stationMove.ts) is in no planet's orbits.
  const now = Date.now();
  return listStations().filter(
    (s) => s.planetId === from.planetId && s.id !== from.id && s.id !== here && s.id !== own && !docked.has(s.id)
      && !stationInTransit(s, now),
  );
}

// ── The station record as a directory (stations.ts) ──────────────────────────

/** The fields of a stations.ts StationRecord this directory reads. */
export interface StationRecordLike {
  id: string;
  name: string;
  planetId: string;
  orbitSlot: number;
  welcomeRoomId: string;
  berthDoor?: string;
  /** A move to another planet, scheduled or under way (stations.ts). */
  move?: StationMove;
}

/** Rough per-destination figures for a station record (what a hop from the
 *  planet's lowest orbit would cost) — shown only where no hop is planned.
 *  Real hops are priced by planTransfer below. */
export const FUEL_BASE = 20;
export const FUEL_PER_SLOT = 10;
export const TRAVEL_MS_PER_SLOT = 10_000;
export const TRAVEL_MS_MAX = 120_000;

/** Fuel units per km/s of Hohmann delta-v (both burns). A low hop is well
 *  under 1 km/s, so one 100-unit tank flies several. */
export const FUEL_PER_KMS = 40;

/** A hop between two station records: the next Hohmann launch window
 *  (orbits.planTransfer), priced on its delta-v. */
export function planRecordHop(
  from: StationRecordLike | undefined,
  to: StationRecordLike | undefined,
  nowMs: number,
): HopPlan | null {
  if (!from || !to) return null;
  // No hop to or from a station between planets (stationMove.ts).
  if (stationInTransit(from, nowMs) || stationInTransit(to, nowMs)) return null;
  const t = planTransfer(from, to, nowMs);
  if (!t) return null;
  // Nor one a move cuts into (moveCutsHop).
  if (moveCutsHop(from.move, to.move, t, nowMs)) return null;
  return {
    departAt: t.departAt,
    arriveAt: t.arriveAt,
    fuelCost: Math.max(1, Math.ceil(t.deltaVKmS * FUEL_PER_KMS)),
    windowEveryMs: t.synodicMs,
  };
}

/** A berth door's own pose in its room: its wall, and its centre along that
 *  wall (the currency of a dock record's farWall and farLateral). */
export interface BerthPose {
  wall: DoorWall;
  lateral?: number;
}

type BerthPoseLookup = (roomId: string, doorId: string) => BerthPose | null | undefined;

let berthPoseLookup: BerthPoseLookup | null = null;

/** main.ts points this at the atlas: a berth door's pose as a client standing
 *  in its room last saw it. Null clears it. */
export function setBerthPoseLookup(lookup: BerthPoseLookup | null): void {
  berthPoseLookup = lookup;
}

const WALLS: readonly DoorWall[] = ['x+', 'x-', 'y+', 'y-'];

/** The far end of a DOCK at a station's berth, where known: a first visit
 *  then poses the station's module (and checks overlap) at its real port.
 *  Unknown or junk is none, and the DOCK faces the arrival heading as for
 *  any port of unknown pose; a lateral the doors doc would not keep
 *  (|lateral| ≤ 32) leaves the wall alone. */
function berthPose(roomId: string, doorId: string): Pick<StationBerth, 'farWall' | 'farLateral'> {
  let pose: BerthPose | null | undefined;
  try { pose = berthPoseLookup?.(roomId, doorId); } catch { return {}; }
  if (!pose || !WALLS.includes(pose.wall)) return {};
  const lateral = pose.lateral;
  return typeof lateral === 'number' && Number.isFinite(lateral) && Math.abs(lateral) <= 32
    ? { farWall: pose.wall, farLateral: lateral }
    : { farWall: pose.wall };
}

/**
 * Turn station records into destinations. A station's berth is its welcome
 * room — dockable only when this client holds a seed for it (`seedFor`: the
 * atlas seed, or the build's own pass for the default station) — and only
 * when the record names its berth door.
 */
export function destinationsFromRecords(
  records: readonly StationRecordLike[],
  seedFor: (roomId: string) => string | undefined,
): StationDestination[] {
  return records.map((r) => {
    const slot = Math.max(0, Math.floor(r.orbitSlot));
    const out: StationDestination = {
      id: r.id,
      name: r.name,
      planetId: r.planetId,
      fuelCost: FUEL_BASE + FUEL_PER_SLOT * slot,
      travelMs: Math.min(TRAVEL_MS_MAX, TRAVEL_MS_MIN + TRAVEL_MS_PER_SLOT * slot),
      ...(r.move ? { move: r.move } : {}),
    };
    const last = r.welcomeRoomId ? latestMoveOf({ id: r.id, welcomeRoomId: r.welcomeRoomId }) ?? r.move : r.move;
    if (last) out.lastMove = last;
    // A public berth needs its door: DOCK only asks the far room (and so
    // only proves a port is there) when it knows the far door. Without one
    // the ship's own berth memory decides, or arrival reports no berth. A
    // door name the doors doc would strip counts as none.
    const door = r.berthDoor && isAcceptableDoorKey(r.berthDoor) ? r.berthDoor : undefined;
    const address = r.welcomeRoomId && door ? seedFor(r.welcomeRoomId) : undefined;
    // With its door's pose where known (setBerthPoseLookup).
    if (address && door) out.berth = { address, farDoor: door, ...berthPose(r.welcomeRoomId, door) };
    return out;
  });
}

/** While withStationSnapshot runs: each source's one read, by source. */
let snapshot: Map<() => unknown, unknown> | null = null;

/** `read()` once per withStationSnapshot, else on every call. */
function snapshotted<T>(read: () => T): T {
  if (!snapshot) return read();
  if (!snapshot.has(read)) snapshot.set(read, read());
  return snapshot.get(read) as T;
}

/** Run `fn` with every lookup in it sharing ONE read of the station record:
 *  the helm plans a hop to each destination on every render, and the live
 *  list rebuilds the whole station list (atlas and all) on each read.
 *  Nothing in `fn` may change the stations; a nested call shares the read. */
export function withStationSnapshot<T>(fn: () => T): T {
  if (snapshot) return fn();
  snapshot = new Map();
  try {
    return fn();
  } finally {
    snapshot = null;
  }
}

/** A directory over the station record: `list` is stations.listStations,
 *  `hereId` the ship room's station (null when floating free), `dockedIds`
 *  every station its live docks lead into; hops follow the circular-orbit
 *  model (orbits.ts). */
export function directoryFromStationRecords(
  list: () => readonly StationRecordLike[],
  seedFor: (roomId: string) => string | undefined,
  hereId: () => string | null,
  ownId: () => string | null = () => null,
  resolve?: (id: string) => string | null,
  portable?: (id: string) => string | null,
  dockedIds: () => readonly string[] = () => [],
): StationDirectory {
  // Read once per withStationSnapshot: the list, and the destinations
  // (each looks its seed up in the atlas).
  const destinations = () => destinationsFromRecords(snapshotted(list), seedFor);
  return {
    stations: () => snapshotted(destinations),
    here: hereId,
    docked: dockedIds,
    own: ownId,
    ...(resolve ? { resolve } : {}),
    ...(portable ? { portable } : {}),
    plan: (fromId, toId, nowMs) => {
      const records = snapshotted(list);
      const adrift = adriftPlace(fromId);
      return planRecordHop(
        adrift ? { id: fromId, name: '', welcomeRoomId: '', ...adrift } : records.find((r) => r.id === fromId),
        records.find((r) => r.id === toId),
        nowMs,
      );
    },
  };
}
