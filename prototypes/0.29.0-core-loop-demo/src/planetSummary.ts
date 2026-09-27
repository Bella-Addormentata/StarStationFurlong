/**
 * 🪐 Per-planet summary: what players around one planet share about each
 * other's stations and ships, so every client flies the same orbits.
 *
 * Station records, their orbit slots and their station-keeping trims are
 * per install (stations.ts, stationKeeping.ts). Two players around one planet
 * could therefore see a station in different slots, or one of them see it
 * trimmed and the other not, and a ship's launch window would differ between
 * them. This module gossips a SMALL summary through every room doc, the way
 * stationAtlas gossips layout:
 *
 *   - per station: its record (name, planet, slot, berth door, and any fields
 *     a newer build adds, carried through untouched) and its latest trim;
 *   - per ship: its name, planet and flight (status, from, to, times).
 *
 * Three levels, not full-atlas gossip:
 *   - your own station: its full atlas, as before (stationAtlas);
 *   - your planet: the summaries here, registered as station records so
 *     their slots and trims are the same on every client;
 *   - the rest of the solar system: names only (systemStationNames).
 * Another station's full atlas still arrives when you approach or dock and
 * join one of its rooms.
 *
 * Station ids are per install, so a summary is keyed by the station's WELCOME
 * ROOM id, which is the same everywhere. A learned station is registered as
 * `shared:<welcome room>`; stations.ts keeps one station per place, so a
 * record this install already has for that place wins.
 *
 * Credential rule (stationAtlas.ts): no pass or seed travels here. A berth
 * door is a door name, not a key.
 *
 * Merge: newest `updatedAt` wins a station's record, newest `at` wins its
 * trim (a trim is one burn, written whole). The first client to publish a
 * station whose slot it only DERIVED sets that slot for everyone; a saved
 * record's owner can move it later with a newer stamp.
 */

import * as Y from 'yjs';
import { isAcceptableDoorKey } from './doorsDoc';
import type { FlightStatus } from './shipDoc';
import { isOrbitTrim, trimFor, trimmedOrbit } from './stationKeeping';
import type { OrbitTrim } from './stationKeeping';
import { setStationTrimResolver } from './orbits';
import { MAX_ORBIT_SLOTS, listStations, planetById, readStationRecords, registerStation, removeStation } from './stations';
import type { StationRecord } from './stations';

// ── Shapes ───────────────────────────────────────────────────────────────────

/** A trim as it travels: the burn's orbit numbers, and the fuel the room's
 *  burns have drawn in all (optional; older builds send none), which orders
 *  trims whose last burns share a moment (newerTrim). `from` is the room
 *  whose station-keeping log it was read from and `readAt` when a client
 *  standing there last read it: between two readings of one room the later
 *  reading wins, whatever its burn time, so a trim that room took back (a
 *  stale level write won and brought back an older settlement) spreads. */
export type SharedTrim = OrbitTrim & { from?: string; readAt?: number };

/** ⚖️ A room's trim is gone (taken back to none): what a client standing
 *  there read, and when. It drops that room's trims read before it. */
export interface TrimGone {
  from: string;
  readAt: number;
}

/** Rooms whose trim-gone readings a summary keeps (the newest, one each). */
export const MAX_TRIM_GONE = 16;

export interface StationSummary {
  welcomeRoomId: string;
  name: string;
  planetId: string;
  orbitSlot: number;
  berthDoor?: string;
  /** Record fields this build does not know (a newer build's additions),
   *  carried as they came so they reach stations.ts on every client. */
  ext?: Record<string, unknown>;
  trim?: SharedTrim;
  /** One reading per room (sorted by room, at most MAX_TRIM_GONE), so one
   *  helm room's take-back never forgets another's. */
  trimGone?: TrimGone[];
  /** The owning install's own id for its saved record, so a flight record
   *  written there (station ids are per install) still resolves here. */
  ownerId?: string;
  updatedAt: number;
}

export interface ShipSummary {
  /** The ship's room id. */
  roomId: string;
  name: string;
  planetId: string;
  status: FlightStatus;
  /** Welcome room of the station it is at, or left. */
  fromRoom?: string;
  /** Welcome room of the station it is flying to. */
  toRoom?: string;
  departedAt?: number;
  etaAt?: number;
  /** Set when the room stopped being a ship (bolted into a station, a
   *  fitting removed): a newer stamp that withdraws the entry everywhere. */
  retired?: true;
  updatedAt: number;
}

/** What this client says about the ship it stands in (main.ts builds it). */
export type ShipStatusInput = Omit<ShipSummary, 'updatedAt'>;

export const LEARNED_PREFIX = 'shared:';

/** ⚓ A record this module registered from a summary: its id is exactly the
 *  learned prefix plus its own welcome room. A saved record that merely
 *  starts with the prefix (made by hand before it was reserved) is the
 *  install's own, and is never pruned or replaced as learned. */
export function isLearnedRecord(r: { id: string; welcomeRoomId: string }): boolean {
  return r.id === `${LEARNED_PREFIX}${r.welcomeRoomId}`;
}
/** stations.ts's prefix for a station derived from an atlas component. */
const DERIVED_PREFIX = 'station:';

const STORE_KEY = 'ssf-planet-summary';
const MAX_STATIONS = 64;
const MAX_SHIPS = 32;
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 64;
const MAX_EXT_JSON = 1024;
/** How far into the future a peer's stamp may sit (as stationAtlas). */
const MAX_SKEW_MS = 6 * 3600 * 1000;
/** A ship not heard from in this long has left the picture. */
export const SHIP_STALE_MS = 24 * 3600 * 1000;
/** An unchanged ship's stamp is refreshed this often, so it never goes stale
 *  while its players are aboard. */
export const SHIP_HEARTBEAT_MS = 3600 * 1000;
const FLIGHT_STATUSES: readonly string[] = ['docked', 'undocking', 'in-flight', 'redocking'];
const KNOWN_FIELDS = new Set(['id', 'name', 'planetId', 'orbitSlot', 'welcomeRoomId', 'berthDoor', 'derived']);

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME_LEN;
const isStamp = (v: unknown, now: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= now + MAX_SKEW_MS;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;
}

/** Bounded JSON-only extras, or undefined. */
function cleanExt(v: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(v)) return undefined;
  // The cap is on the extras alone (as stations.ts keeps them), not on the
  // record they came with.
  // Peer-written: copied under a budget, so an oversized value is dropped
  // before it is walked or serialized in full.
  const budget = { left: MAX_EXT_JSON };
  const extras: Record<string, unknown> = {};
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k) || KNOWN_FIELDS.has(k)) continue;
    budget.left -= k.length + 4;
    const x = boundedJson(v[k], budget, 0);
    if (x === TOO_BIG || budget.left < 0) return undefined;
    if (x !== undefined) extras[k] = x;
  }
  let json: string;
  try { json = JSON.stringify(extras); } catch { return undefined; }
  if (json.length > MAX_EXT_JSON) return undefined;
  const out = stripCredentials(JSON.parse(json)) as Record<string, unknown>;
  return Object.keys(out).length > 0 ? out : undefined;
}

const TOO_BIG = Symbol('too big');
const MAX_EXT_DEPTH = 16;

/** A JSON-only copy of `v`, charging `budget` about what its JSON costs;
 *  TOO_BIG as soon as the budget or depth runs out, undefined for what JSON
 *  leaves out. */
function boundedJson(v: unknown, budget: { left: number }, depth: number): unknown {
  if (budget.left < 0 || depth > MAX_EXT_DEPTH) return TOO_BIG;
  if (v === null || typeof v === 'boolean') { budget.left -= 5; return v; }
  if (typeof v === 'number') { budget.left -= 8; return Number.isFinite(v) ? v : null; }
  if (typeof v === 'string') { budget.left -= v.length + 2; return budget.left < 0 ? TOO_BIG : v; }
  if (Array.isArray(v)) {
    if (v.length > budget.left) return TOO_BIG;
    const out: unknown[] = [];
    budget.left -= 2;
    for (const x of v) {
      const c = boundedJson(x, budget, depth + 1);
      if (c === TOO_BIG) return TOO_BIG;
      out.push(c === undefined ? null : c);
      budget.left -= 1;
    }
    return out;
  }
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  budget.left -= 2;
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k) || k === '__proto__') continue;
    budget.left -= k.length + 4;
    if (budget.left < 0) return TOO_BIG;
    const c = boundedJson(v[k], budget, depth + 1);
    if (c === TOO_BIG) return TOO_BIG;
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Field names that may carry a room's dial-in credentials (a seed, a pass,
 *  a link or invite): layout is public, admission is not. */
const CREDENTIAL_KEY = /seed|pass(?!age)|link|invite|token|secret|cred/i;

/** A JSON value with every credential-named field removed, at any depth. */
function stripCredentials(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCredentials);
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!CREDENTIAL_KEY.test(k)) out[k] = stripCredentials(x);
  }
  return out;
}

function cleanTrim(v: unknown, now = Date.now()): SharedTrim | undefined {
  // A burn's time is peer-written and decides which trim wins: no later
  // than the same skew any other stamp may run ahead.
  if (!isOrbitTrim(v) || v.at > now + MAX_SKEW_MS) return undefined;
  const src = v as OrbitTrim & { from?: unknown; readAt?: unknown };
  const read = isId(src.from) && isStamp(src.readAt, now);
  return {
    planetId: v.planetId, slot: v.slot, dRadiusKm: v.dRadiusKm, dPhase: v.dPhase, at: v.at, last: v.last,
    ...(v.fuelDrawn !== undefined ? { fuelDrawn: v.fuelDrawn } : {}),
    ...(read ? { from: src.from as string, readAt: src.readAt as number } : {}),
  };
}

function cleanOneGone(v: unknown, now: number): TrimGone | undefined {
  if (!isPlainObject(v) || !isId(v.from) || !isStamp(v.readAt, now)) return undefined;
  return { from: v.from, readAt: v.readAt };
}

/** Peer-sent take-backs, bounded before they are walked (one reading, as
 *  the first builds sent, or a list). */
function cleanTrimGone(v: unknown, now: number): TrimGone[] | undefined {
  if (!Array.isArray(v)) {
    const one = cleanOneGone(v, now);
    return one ? [one] : undefined;
  }
  if (v.length > MAX_TRIM_GONE * 4) return undefined;
  let out: TrimGone[] | undefined;
  for (const x of v) {
    const one = cleanOneGone(x, now);
    if (one) out = mergeGone(out, [one]);
  }
  return out;
}

/** Shape guard + copy: a summary crosses the peer trust boundary. */
export function cleanStationSummary(v: unknown, now = Date.now()): StationSummary | null {
  if (!isPlainObject(v)) return null;
  if (!isId(v.welcomeRoomId) || !isName(v.name) || !isId(v.planetId)) return null;
  if (!Number.isInteger(v.orbitSlot) || (v.orbitSlot as number) < 0 || (v.orbitSlot as number) >= MAX_ORBIT_SLOTS) return null;
  if (v.ownerId !== undefined && !isId(v.ownerId)) return null;
  if (!isStamp(v.updatedAt, now)) return null;
  const out: StationSummary = {
    welcomeRoomId: v.welcomeRoomId,
    name: v.name,
    planetId: v.planetId,
    orbitSlot: v.orbitSlot as number,
    updatedAt: v.updatedAt,
  };
  // An optional berth a station record could not hold (not a door key) is
  // left out, not the whole summary: the station still registers.
  if (isId(v.berthDoor) && isAcceptableDoorKey(v.berthDoor)) out.berthDoor = v.berthDoor;
  if (v.ownerId !== undefined) out.ownerId = v.ownerId as string;
  const ext = cleanExt(v.ext);
  if (ext) out.ext = ext;
  const trim = cleanTrim(v.trim, now);
  if (trim) out.trim = trim;
  const gone = cleanTrimGone(v.trimGone, now);
  if (gone) out.trimGone = gone;
  return out;
}

export function cleanShipSummary(v: unknown, now = Date.now()): ShipSummary | null {
  if (!isPlainObject(v)) return null;
  if (!isId(v.roomId) || !isName(v.name) || !isId(v.planetId)) return null;
  if (typeof v.status !== 'string' || !FLIGHT_STATUSES.includes(v.status)) return null;
  if (!isStamp(v.updatedAt, now)) return null;
  if (v.fromRoom !== undefined && !isId(v.fromRoom)) return null;
  if (v.toRoom !== undefined && !isId(v.toRoom)) return null;
  if (v.departedAt !== undefined && !isTime(v.departedAt)) return null;
  if (v.etaAt !== undefined && !isTime(v.etaAt)) return null;
  if (v.retired !== undefined && v.retired !== true) return null;
  const out: ShipSummary = {
    roomId: v.roomId,
    name: v.name,
    planetId: v.planetId,
    status: v.status as FlightStatus,
    updatedAt: v.updatedAt,
  };
  if (v.fromRoom !== undefined) out.fromRoom = v.fromRoom as string;
  if (v.toRoom !== undefined) out.toRoom = v.toRoom as string;
  if (v.departedAt !== undefined) out.departedAt = v.departedAt as number;
  if (v.etaAt !== undefined) out.etaAt = v.etaAt as number;
  if (v.retired === true) out.retired = true;
  return out;
}

// ── The local store (what this install has learned) ──────────────────────────

interface Store {
  stations: Record<string, StationSummary>;
  ships: Record<string, ShipSummary>;
}

function emptyStore(): Store {
  return { stations: Object.create(null), ships: Object.create(null) };
}

/** Every stored summary, junk dropped, capped. */
export function readStore(now = Date.now()): Store {
  const out = emptyStore();
  let raw: unknown;
  try {
    const text = localStorage.getItem(STORE_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch { return out; }
  if (!isPlainObject(raw)) return out;
  if (isPlainObject(raw.stations)) {
    let n = 0;
    for (const [k, v] of Object.entries(raw.stations)) {
      if (n >= MAX_STATIONS) break;
      const s = cleanStationSummary(v, now);
      if (s && s.welcomeRoomId === k) { out.stations[k] = s; n++; }
    }
  }
  if (isPlainObject(raw.ships)) {
    let n = 0;
    for (const [k, v] of Object.entries(raw.ships)) {
      if (n >= MAX_SHIPS) break;
      const s = cleanShipSummary(v, now);
      if (s && s.roomId === k && now - s.updatedAt <= SHIP_STALE_MS) { out.ships[k] = s; n++; }
    }
  }
  return out;
}

function writeStore(store: Store): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* quota */ }
}

/** The newer of two trims: the later last burn; between trims whose last
 *  burns share a moment (two sticks pushed in one millisecond), the one
 *  that drew more fuel has replayed more burns, so it holds the other's
 *  burns too; then tieBreak. */
function newerTrim(a: SharedTrim | undefined, b: SharedTrim | undefined): SharedTrim | undefined {
  if (!a) return b;
  if (!b) return a;
  // Two readings of one room's log: the later reading is that room's trim now.
  if (a.from !== undefined && a.from === b.from && a.readAt !== b.readAt) {
    return (b.readAt ?? 0) > (a.readAt ?? 0) ? b : a;
  }
  if (b.at !== a.at) return b.at > a.at ? b : a;
  if (a.fuelDrawn !== undefined && b.fuelDrawn !== undefined && a.fuelDrawn !== b.fuelDrawn) {
    return b.fuelDrawn > a.fuelDrawn ? b : a;
  }
  return tieBreak(a, b);
}

/** Two values stamped the same moment: every client keeps the same one (the
 *  greater canonical JSON), so concurrent first publishes still converge. */
function tieBreak<T>(a: T, b: T): T {
  return JSON.stringify(b) > JSON.stringify(a) ? b : a;
}

/** Merge an incoming station summary into a known one, and the newer trim.
 *  Which record stands: one its owner published (it carries `ownerId`) beats
 *  one nobody owns; between one owner's records the newer wins, and between
 *  two installs' owned records the smaller owner id stands; between records
 *  nobody owns (derived stations) the FIRST published stands, so a late
 *  install cannot move a station everyone already placed. Same-moment ties
 *  settle on the canonical JSON. Returns null when nothing changes. */
export function mergeStation(prior: StationSummary | undefined, incoming: StationSummary): StationSummary | null {
  if (!prior) return incoming;
  const recordOf = (s: StationSummary): string => JSON.stringify({ ...s, trim: undefined, trimGone: undefined });
  const owned = (s: StationSummary) => s.ownerId !== undefined;
  // Two installs that each saved the place under their own id: one of them
  // stands for good (the smaller id), so their republishes cannot take turns.
  const rivals = owned(incoming) && owned(prior) && incoming.ownerId !== prior.ownerId;
  const base = owned(incoming) !== owned(prior)
    ? (owned(incoming) ? incoming : prior)
    : rivals
      ? (incoming.ownerId! < prior.ownerId! ? incoming : prior)
      : incoming.updatedAt !== prior.updatedAt
        ? ((incoming.updatedAt > prior.updatedAt) === owned(incoming) ? incoming : prior)
        : (recordOf(incoming) > recordOf(prior) ? incoming : prior);
  // Only a trim of the orbit the standing record flies: one published for
  // the slot that lost would be dropped by every reader anyway.
  const fits = (t: SharedTrim | undefined) => (t && trimFor(base, t) ? t : undefined);
  const gone = mergeGone(prior.trimGone, incoming.trimGone);
  // A room's trim read before that room read none is taken back.
  const alive = (t: SharedTrim | undefined) =>
    (t && (t.from === undefined || (t.readAt ?? 0) >= goneAt(gone, t.from)) ? t : undefined);
  const trim = newerTrim(alive(fits(prior.trim)), alive(fits(incoming.trim)));
  const next: StationSummary = { ...base };
  if (trim) next.trim = trim; else delete next.trim;
  if (gone) next.trimGone = gone; else delete next.trimGone;
  return JSON.stringify(next) === JSON.stringify(prior) ? null : next;
}

/** Two lists of "trim gone" readings, room by room: the later reading of
 *  each room; past the cap the newest rooms stay (ties by room), sorted by
 *  room so every client settles on the same list. */
function mergeGone(a: TrimGone[] | undefined, b: TrimGone[] | undefined): TrimGone[] | undefined {
  if (!a?.length) return b?.length ? b : undefined;
  if (!b?.length) return a;
  const byRoom = new Map<string, TrimGone>();
  for (const g of [...a, ...b]) {
    const had = byRoom.get(g.from);
    if (!had || g.readAt > had.readAt) byRoom.set(g.from, g);
  }
  const byName = (x: TrimGone, y: TrimGone) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0);
  return [...byRoom.values()]
    .sort((x, y) => y.readAt - x.readAt || byName(x, y))
    .slice(0, MAX_TRIM_GONE)
    .sort(byName);
}

/** When `room` last read no trim (0: never, as far as known). */
function goneAt(gone: TrimGone[] | undefined, room: string): number {
  return gone?.find((g) => g.from === room)?.readAt ?? 0;
}

function mergeShip(prior: ShipSummary | undefined, incoming: ShipSummary): ShipSummary | null {
  if (!prior || incoming.updatedAt > prior.updatedAt) return incoming;
  if (incoming.updatedAt < prior.updatedAt) return null;
  return tieBreak(prior, incoming) === prior ? null : incoming;
}

/** Put a map's entries into a capped object, keeping the newest when full.
 *  `pinned` keys (what this client sees first-hand) are kept first, whatever
 *  their stamps: peer stamps decide merges, never whether we forget our own
 *  station or ship. */
function capped<T extends { updatedAt: number; planetId: string }>(
  rec: Record<string, T>,
  max: number,
  pinned: ReadonlySet<string> = new Set(),
  planet: string | null = null,
): Record<string, T> {
  const entries = Object.entries(rec);
  if (entries.length <= max) return rec;
  const first = (k: string, v: T) => (pinned.has(k) ? 0 : onPlanet(v, planet) ? 1 : 2);
  // Ties by key, as pruneMap: every replica keeps the same subset.
  entries.sort((a, b) => first(a[0], a[1]) - first(b[0], b[1]) || b[1].updatedAt - a[1].updatedAt
    || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Record<string, T> = Object.create(null);
  for (const [k, v] of entries.slice(0, max)) out[k] = v;
  return out;
}

/** Is this summary about the planet this client is at? Retention keeps
 *  those next, after the first-hand keys: news from other planets cannot
 *  crowd out the stations and ships around this one. */
function onPlanet(v: { planetId: string }, planet: string | null): boolean {
  return planet !== null && planetById(v.planetId).id === planet;
}

/** The keys this client knows first-hand: the station it stands in and the
 *  ship it is aboard. Retention keeps them whatever peers stamp. And the
 *  planet it is at (null when it cannot place itself). */
function firstHandKeys(store?: Store): { stations: Set<string>; ships: Set<string>; planet: string | null } {
  const stations = new Set<string>();
  const ships = new Set<string>();
  const current = ctx?.currentStation() ?? null;
  const here = current?.welcomeRoomId;
  if (here) stations.add(here);
  const ship = ctx?.ship()?.roomId;
  if (ship) ships.add(ship);
  // A room that may be a ship keeps its own entry too: while its stations
  // are not placed, that entry is what says which planet it is at.
  const shipRoom = mayBeShipRoom();
  if (shipRoom) ships.add(shipRoom);
  const standIn = isShipStandIn(current, shipRoom);
  const shipEntry = shipRoom ? store?.ships[shipRoom] : undefined;
  const planet = current && !standIn ? planetById(current.planetId).id
    : shipEntry && !shipEntry.retired ? planetById(shipEntry.planetId).id
      : null;
  return { stations, ships, planet };
}

/** The room this client stands in, unless it is known to be no ship. */
function mayBeShipRoom(): string | null {
  const room = ctx?.currentRoom?.() || null;
  return room && ctx?.notShipRoom?.() !== room ? room : null;
}

/** A ship's own one-room stand-in (derived, its welcome room the ship's
 *  room): it sits on the default planet until stations are known, so it
 *  places nothing. A one-room station known to be no ship is a place. */
function isShipStandIn(found: StationRecord | null, shipRoom: string | null): boolean {
  return !!found && !!found.derived && shipRoom !== null && found.welcomeRoomId === shipRoom;
}

// ── From this client: its station and its ship ──────────────────────────────

/** A station whose record this install saved itself (not derived from the
 *  atlas, not learned from a peer). */
function isOwned(station: StationRecord): boolean {
  return !station.derived && !isLearnedRecord(station);
}

/** The summary this client publishes for a station it can see: its listed
 *  record, and a trim when one applies to it. */
export function summaryForStation(station: StationRecord, trim: OrbitTrim | null, updatedAt: number): StationSummary {
  const out: StationSummary = {
    welcomeRoomId: station.welcomeRoomId,
    name: station.name,
    planetId: planetById(station.planetId).id,
    orbitSlot: station.orbitSlot,
    updatedAt,
  };
  if (station.berthDoor) out.berthDoor = station.berthDoor;
  if (isOwned(station) && isId(station.id)) out.ownerId = station.id;
  const ext = cleanExt(station);
  if (ext) out.ext = ext;
  const applies = cleanTrim(trimFor(station, trim));
  if (applies) out.trim = applies;
  return out;
}

/**
 * Fold this client's own station into the known summaries. A station whose
 * record this install OWNS (a saved record, not derived and not learned) is
 * authoritative: a changed record goes out with a newer stamp. A derived or
 * learned station never overwrites what is already known about it — the
 * first published slot stands, so every client ends up agreeing. A trim that
 * applies is merged by its own time either way.
 */
export function foldOwnStation(
  known: StationSummary | undefined,
  station: StationRecord,
  trim: OrbitTrim | null,
  now: number,
  firstHandRoom?: string,
  readChanged = false,
): StationSummary | null {
  const past = (at: number) => Math.min(Math.max(now, at + 1), now + MAX_SKEW_MS);
  // The trim read first-hand from the room this client stands in: stamped
  // as that room's reading, past any earlier reading of it.
  const readTrim = (known?: StationSummary): SharedTrim | null => {
    if (!trim) return null;
    if (firstHandRoom === undefined) return trim;
    const kt = known?.trim;
    const core = (t: OrbitTrim) => JSON.stringify({ ...cleanTrim(t, Infinity), from: undefined, readAt: undefined });
    // Unchanged since this room was last read: no news.
    if (kt && kt.from === firstHandRoom && core(kt) === core(trim)) return kt;
    const before = Math.max(
      kt && kt.from === firstHandRoom ? kt.readAt ?? 0 : 0,
      goneAt(known?.trimGone, firstHandRoom),
    );
    return { ...trim, from: firstHandRoom, readAt: past(before) };
  };
  const mine = summaryForStation(station, readTrim(known), now);
  const owned = isOwned(station);
  if (!known) return mine;
  const sameRecord = (a: StationSummary, b: StationSummary): boolean =>
    // The owner id is per install: another install's identical record is the
    // same record, not news to republish over.
    JSON.stringify({ ...a, trim: undefined, trimGone: undefined, updatedAt: 0, ownerId: undefined })
      === JSON.stringify({ ...b, trim: undefined, trimGone: undefined, updatedAt: 0, ownerId: undefined });
  const base = owned && !sameRecord(known, mine)
    ? { ...mine, updatedAt: Math.min(Math.max(now, known.updatedAt + 1), now + MAX_SKEW_MS) }
    : known;
  // A trim is keyed by the orbit it trims: it goes out when it names the
  // planet and slot of the record that is kept, whichever client's that is.
  const applies = cleanTrim(trimFor(base, readTrim(known)));
  // This room now reads no trim where the known one was read here: that
  // trim was taken back, and the reading says so.
  // This room's reading changed while another room's trim stands over it:
  // its own earlier readings are superseded all the same (a reading it
  // takes now is stamped at or past this), so none can come back later.
  const gone: TrimGone[] | undefined = !trim && firstHandRoom !== undefined && known.trim?.from === firstHandRoom
    ? [{ from: firstHandRoom, readAt: past(known.trim.readAt ?? 0) }]
    : readChanged && firstHandRoom !== undefined && known.trim !== undefined && known.trim.from !== firstHandRoom
      ? [{ from: firstHandRoom, readAt: past(goneAt(known.trimGone, firstHandRoom)) }]
      : undefined;
  const { trim: _unused, trimGone: _unusedGone, ...rest } = base;
  return mergeStation(known, {
    ...rest, ...(applies ? { trim: applies } : {}), ...(gone ? { trimGone: gone } : {}),
  });
}

// ── Learned stations → station records ───────────────────────────────────────

/** The station record a learned summary registers as, or null when it
 *  cannot be one (an id too long). */
export function learnedRecord(s: StationSummary): Omit<StationRecord, 'derived'> | null {
  const id = `${LEARNED_PREFIX}${s.welcomeRoomId}`;
  if (id.length > MAX_ID_LEN) return null;
  return {
    ...(s.ext ?? {}),
    id,
    name: s.name,
    planetId: s.planetId,
    orbitSlot: s.orbitSlot,
    welcomeRoomId: s.welcomeRoomId,
    ...(s.berthDoor ? { berthDoor: s.berthDoor } : {}),
  };
}

/**
 * Register the learned stations around `planetId` as station records, so
 * their slots (and so their orbits) match every other client's. A place this
 * install already lists under its own record keeps it (stations.ts lists one
 * station per place, and registerStation refuses a record the list drops).
 * Returns how many records changed.
 */
export function registerLearnedStations(
  planetId: string,
  stations: Iterable<StationSummary>,
  opts: { prune?: boolean } = {},
): number {
  const planet = planetById(planetId).id;
  const listed = listStations();
  const saved = new Map(readStationRecords().map((r) => [r.id, r]));
  let changed = 0;
  // A learned station now at another planet (this client moved, or the
  // station did) is only a name here: its record goes. Only when the caller
  // knows which planet this client is at; the install's own records stay.
  if (opts.prune) {
    for (const r of saved.values()) {
      if (isLearnedRecord(r) && planetById(r.planetId).id !== planet) {
        removeStation(r.id);
        saved.delete(r.id);
        changed++;
      }
    }
  }
  for (const s of stations) {
    if (planetById(s.planetId).id !== planet) continue;
    const rec = learnedRecord(s);
    if (!rec) continue;
    const owner = listed.find((st) => st.welcomeRoomId === s.welcomeRoomId);
    // Someone else's record, or its own saved one: this install decides.
    if (owner && !owner.derived && owner.id !== rec.id) {
      // …except where it stands: when another install's record of the same
      // place stood (rival owners settle on one, mergeStation), this one
      // flies that planet and slot too, under its own id, so both installs
      // agree and the standing trim fits.
      const own = saved.get(owner.id);
      if (own && !isLearnedRecord(own) && s.ownerId !== undefined && s.ownerId !== owner.id
        && (own.orbitSlot !== s.orbitSlot || planetById(own.planetId).id !== planetById(s.planetId).id)) {
        if (registerStation({ ...own, planetId: s.planetId, orbitSlot: s.orbitSlot })) changed++;
      }
      continue;
    }
    // Unchanged since it was saved: compare with the SAVED record, not the
    // listed one (the list may have moved it to a free slot), extra fields
    // included (a newer build's, such as a station's move).
    const had = saved.get(rec.id) as (StationRecord & Record<string, unknown>) | undefined;
    // The install's own record under a learned-looking id is never replaced.
    if (had && !isLearnedRecord(had)) continue;
    // Both ways: a field the summary no longer carries must go too.
    const hadExt = Object.keys(had ?? {}).filter((k) => !KNOWN_FIELDS.has(k));
    const sameExt = hadExt.length === Object.keys(s.ext ?? {}).length
      && Object.entries(s.ext ?? {}).every(([k, v]) => JSON.stringify(had?.[k]) === JSON.stringify(v));
    if (had && sameExt && had.name === rec.name && had.orbitSlot === rec.orbitSlot
      && planetById(had.planetId).id === planetById(rec.planetId).id
      && had.welcomeRoomId === rec.welcomeRoomId && had.berthDoor === rec.berthDoor) continue;
    if (registerStation(rec)) changed++;
  }
  return changed;
}

// ── The shared maps ──────────────────────────────────────────────────────────

export interface PlanetSummaryContext {
  /** The station this client stands in, or null. */
  currentStation: () => StationRecord | null;
  /** The room's own trim record (stationKeeping), or null. */
  localTrim: () => OrbitTrim | null;
  /** The ship this client stands in, or null when the room is no ship. */
  ship: () => ShipStatusInput | null;
  /** The room this client stands in when it is known to be no ship (not a
   *  ready ship, or bolted into a station), else null: a ship entry for that
   *  room is withdrawn. A ship whose planet is not placed yet (`ship()` is
   *  null for it too) is not this, so its entry stands. Optional: without it
   *  nothing is withdrawn. */
  notShipRoom?: () => string | null;
  /** The room this client stands in: its trim (localTrim) is read
   *  first-hand there, so a trim that room takes back spreads. Optional:
   *  without it trims only merge by burn time. */
  currentRoom?: () => string | null;
}

let doc: Y.Doc | null = null;
let stationMap: Y.Map<unknown> | null = null;
let shipMap: Y.Map<unknown> | null = null;
let ctx: PlanetSummaryContext | null = null;
const listeners = new Set<() => void>();

function alive(): boolean {
  return doc !== null && (doc as { isDestroyed?: boolean }).isDestroyed !== true
    && stationMap !== null && shipMap !== null;
}

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch (err) { console.error('[planet summary] listener threw:', err); }
  }
}

/** Fires after every pull that changed what this install knows. */
export function subscribePlanetSummary(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Bind the room doc — main.ts T0 seam beside the shared atlas. Pulls, then
 *  publishes what this client knows, then keeps pulling on every change. */
export function bindPlanetSummaryDoc(d: Y.Doc, c: PlanetSummaryContext): void {
  doc = d;
  ctx = c;
  stationMap = d.getMap('stationSummaries');
  shipMap = d.getMap('shipSummaries');
  const onChange = (_e: unknown, tx: Y.Transaction) => {
    if (tx.local) return;
    pullPlanetSummary();
  };
  stationMap.observe(onChange);
  shipMap.observe(onChange);
  pullPlanetSummary();
  publishPlanetSummary();
}

/** Doc → this install. */
export function pullPlanetSummary(now = Date.now()): void {
  if (!alive()) return;
  const store = readStore(now);
  let changed = false;
  let scanned = 0;
  // Entries whose visible value lost to what this install holds: written
  // back below, so the map shows the same winner every install keeps.
  const staleStations = new Map<string, StationSummary>();
  const staleShips = new Map<string, ShipSummary>();
  for (const [k, v] of stationMap!.entries()) {
    if (++scanned > MAX_STATIONS * 4) break;
    const s = cleanStationSummary(v, now);
    if (!s || s.welcomeRoomId !== k) continue;
    const next = mergeStation(store.stations[k], s);
    if (next) { store.stations[k] = next; changed = true; }
    if (JSON.stringify(store.stations[k]) !== JSON.stringify(s)) staleStations.set(k, s);
  }
  scanned = 0;
  for (const [k, v] of shipMap!.entries()) {
    if (++scanned > MAX_SHIPS * 4) break;
    const s = cleanShipSummary(v, now);
    if (!s || s.roomId !== k || now - s.updatedAt > SHIP_STALE_MS) continue;
    const next = mergeShip(store.ships[k], s);
    if (next) { store.ships[k] = next; changed = true; }
    if (JSON.stringify(store.ships[k]) !== JSON.stringify(s)) staleShips.set(k, s);
  }
  const pins = firstHandKeys(store);
  if (changed) {
    store.stations = capped(store.stations, MAX_STATIONS, pins.stations, pins.planet);
    store.ships = capped(store.ships, MAX_SHIPS, pins.ships, pins.planet);
    writeStore(store);
  }
  if (staleStations.size > 0 || staleShips.size > 0) {
    // A local write: the observer skips it, so this never loops.
    doc!.transact(() => {
      for (const [k, s] of staleStations) {
        const won = store.stations[k];
        const next = won && mergeStation(s, won);
        if (next) stationMap!.set(k, next);
      }
      for (const [k, s] of staleShips) {
        const won = store.ships[k];
        const next = won && mergeShip(s, won);
        if (next) shipMap!.set(k, next);
      }
    });
  }
  if (!changed) return;
  applyLearned(store);
  notify();
}

/** Delete a shared map's invalid entries and all but its `max` newest valid
 *  ones (ties by key), after the `pinned` first-hand keys, which stay. Peer-writable, so
 *  one pass visits at most `max * 4` keys (the pull's bound) and evicts only
 *  among those: a map a peer flooded shrinks over later publishes, and every
 *  transaction stays bounded. Below the bound the result is exact. */
function pruneMap(
  map: Y.Map<unknown>,
  stampOf: (k: string, v: unknown) => { at: number; planetId: string } | null,
  max: number,
  pinned: ReadonlySet<string> = new Set(),
  planet: string | null = null,
): number {
  const keep: Array<[string, number, number]> = [];
  const drop: string[] = [];
  let visited = 0;
  for (const [k, v] of map.entries()) {
    if (++visited > max * 4) break;
    const s = stampOf(k, v);
    if (s === null) drop.push(k);
    else keep.push([k, s.at, pinned.has(k) ? 0 : onPlanet(s, planet) ? 1 : 2]);
  }
  // First-hand keys first, then this planet's (see capped), then newest,
  // ties by key.
  keep.sort((a, b) => a[2] - b[2] || b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k] of keep.slice(max)) drop.push(k);
  for (const k of drop) map.delete(k);
  return drop.length;
}

/** This install → doc: its own station and ship first, then everything it
 *  knows (so news travels with players from station to station). */
export function publishPlanetSummary(now = Date.now()): void {
  if (!alive() || !ctx) return;
  const store = readStore(now);
  const here = ctx.currentStation();
  if (here && here.welcomeRoomId && here.welcomeRoomId.length <= MAX_ID_LEN) {
    const room = ctx.currentRoom?.() || undefined;
    const local = ctx.localTrim();
    const next = foldOwnStation(store.stations[here.welcomeRoomId], here, local, now, room, room !== undefined && readingChanged(room, local));
    if (next) store.stations[here.welcomeRoomId] = next;
  }
  const ship = ctx.ship();
  // A first-hand change goes out past any stamp already known for this ship
  // (a peer's may run up to MAX_SKEW_MS ahead), as foldOwnStation does.
  const stampPast = (room: string): number => {
    const known = Math.max(
      store.ships[room]?.updatedAt ?? -Infinity,
      cleanShipSummary(shipMap!.get(room), now)?.updatedAt ?? -Infinity,
    );
    return Math.min(Math.max(now, known + 1), now + MAX_SKEW_MS);
  };
  if (ship) {
    const s = cleanShipSummary({ ...ship, updatedAt: now }, now);
    const prior = s ? store.ships[s.roomId] : undefined;
    const same = prior && s && now - prior.updatedAt < SHIP_HEARTBEAT_MS
      && JSON.stringify({ ...prior, updatedAt: 0 }) === JSON.stringify({ ...s, updatedAt: 0 });
    if (s && !same) store.ships[s.roomId] = { ...s, updatedAt: stampPast(s.roomId) };
  } else {
    // This room is no ship (any more): withdraw an entry still naming it.
    const room = ctx.notShipRoom?.() ?? null;
    const kept = room ? store.ships[room] : undefined;
    const inMap = room ? cleanShipSummary(shipMap!.get(room), now) : null;
    const prior = kept && inMap ? mergeShip(kept, inMap) ?? kept : kept ?? inMap;
    if (room && prior && !prior.retired) {
      store.ships[room] = { ...prior, retired: true, updatedAt: stampPast(room) };
    }
  }
  const pins = firstHandKeys(store);
  store.stations = capped(store.stations, MAX_STATIONS, pins.stations, pins.planet);
  store.ships = capped(store.ships, MAX_SHIPS, pins.ships, pins.planet);
  writeStore(store);
  applyLearned(store);
  let pruned = 0;
  doc!.transact(() => {
    for (const [k, s] of Object.entries(store.stations)) {
      const known = cleanStationSummary(stationMap!.get(k), now);
      if (known && !mergeStation(known, s)) continue;
      stationMap!.set(k, known ? mergeStation(known, s)! : s);
    }
    for (const [k, s] of Object.entries(store.ships)) {
      const known = cleanShipSummary(shipMap!.get(k), now);
      // The same rule as the store's (newest, then the canonical tie-break),
      // so a same-moment pair settles on one value in the doc too.
      const next = known ? mergeShip(known, s) : s;
      if (next) shipMap!.set(k, next);
    }
    // The maps are never otherwise pruned, and readers stop scanning after a
    // bound: keep only the newest valid entries, so what is visible is decided
    // by freshness, never by map order (and junk keys do not pile up).
    pruned = pruneMap(stationMap!, (k, v) => {
      const s = cleanStationSummary(v, now);
      return s && s.welcomeRoomId === k ? { at: s.updatedAt, planetId: s.planetId } : null;
    }, MAX_STATIONS, pins.stations, pins.planet) + pruneMap(shipMap!, (k, v) => {
      const s = cleanShipSummary(v, now);
      return s && s.roomId === k && now - s.updatedAt <= SHIP_STALE_MS ? { at: s.updatedAt, planetId: s.planetId } : null;
    }, MAX_SHIPS, pins.ships, pins.planet);
  });
  // Entries a bounded pull could not reach before the prune are reachable
  // now; the observer skips this local write, so read them here.
  if (pruned > 0) pullPlanetSummary(now);
  // What this client just applied (its own trim, records) is news to its
  // own views too: the observer skips local writes.
  notify();
}

/** What each room last read first-hand (its trim's core, or none), so a
 *  change of reading is news even while another room's trim stands. */
const lastReadings = new Map<string, string>();

function readingChanged(room: string, trim: OrbitTrim | null): boolean {
  const core = trim ? JSON.stringify({ ...cleanTrim(trim, Infinity), from: undefined, readAt: undefined }) : '';
  const had = lastReadings.get(room);
  if (had === undefined && lastReadings.size >= 256) lastReadings.clear();
  lastReadings.set(room, core);
  // A first reading of none says nothing (most rooms have no helm).
  return had === undefined ? core !== '' : had !== core;
}

// ── Reading what is known ────────────────────────────────────────────────────

let trimsByStationId = new Map<string, SharedTrim>();

/** Refresh records and trims from the store: register this planet's learned
 *  stations, then map every listed station to its newest known trim. */
function applyLearned(store: Store): void {
  const room = mayBeShipRoom();
  const found = ctx?.currentStation() ?? null;
  const here = found && !isShipStandIn(found, room) ? found : null;
  // Where this client is: the shared summary of the station it stands in,
  // unless this install's own saved record is the one that stands there (a
  // derived record sits on the default planet until its learned one
  // registers, which needs the planet; a rival install's standing record
  // moves ours, which needs its planet too).
  const shared = here?.welcomeRoomId ? store.stations[here.welcomeRoomId] : undefined;
  const ours = here !== null && isOwned(here) && (shared?.ownerId === undefined || shared.ownerId === here.id);
  // No station placement: a ship room's own summary says which planet it is at.
  const ship = !here && room ? store.ships[room] : undefined;
  const shipPlanet = ship && !ship.retired ? ship.planetId : undefined;
  const planetOf = here ? (!ours && shared ? shared.planetId : here.planetId) : shipPlanet;
  const planet = planetById(planetOf).id;
  registerLearnedStations(planet, Object.values(store.stations), { prune: planetOf !== undefined });
  refreshTrims(store);
}

/** Rebuild the station-id → trim map the orbit resolver reads. Call when the
 *  station list or this room's trim changes. */
export function refreshTrims(store: Store = readStore()): void {
  const local = ctx?.localTrim() ?? null;
  const here = ctx?.currentStation() ?? null;
  const next = new Map<string, SharedTrim>();
  for (const st of listStations()) {
    let trim = store.stations[st.welcomeRoomId]?.trim;
    if (here && st.id === here.id) trim = newerTrim(trim, cleanTrim(local));
    const applies = trimFor(st, trim ? { ...trim } : null);
    if (applies) next.set(st.id, applies);
  }
  trimsByStationId = next;
}

/** Install the orbit trim resolver over what this install knows. */
export function installTrimResolver(): void {
  setStationTrimResolver((station, slot) => {
    const trim = trimsByStationId.get(station.id);
    if (!trim) return null;
    const applies = trimFor(station, trim);
    return applies ? trimmedOrbit(slot, applies) : null;
  });
}

/**
 * This install's id for a station id another install wrote (a flight record
 * travels in the ship's room doc; station ids are per install). A derived or
 * learned id names its welcome room; a saved record's id is found through the
 * summary that carries it as `ownerId`. Null when no listed station matches.
 */
export function resolveStationAlias(id: string, now = Date.now()): string | null {
  const listed = listStations();
  let room: string | undefined;
  for (const prefix of [DERIVED_PREFIX, LEARNED_PREFIX]) {
    if (id.startsWith(prefix)) room = id.slice(prefix.length);
  }
  // A prefixed id names a welcome room, which is global: resolve it by the
  // room first, so a local record that happens to share the id never wins.
  if (room !== undefined) return listed.find((s) => s.welcomeRoomId === room)?.id ?? null;
  if (listed.some((s) => s.id === id)) return id;
  room = Object.values(readStore(now).stations).find((s) => s.ownerId === id)?.welcomeRoomId;
  if (!room) return null;
  return listed.find((s) => s.welcomeRoomId === room)?.id ?? null;
}

/** The id another install can resolve without ambiguity for this install's
 *  station `id`: its welcome room under the learned prefix (welcome rooms are
 *  global; station ids are per install). Null when it has no such room. */
export function portableStationId(id: string): string | null {
  const st = listStations().find((s) => s.id === id);
  if (!st?.welcomeRoomId) return null;
  const out = `${LEARNED_PREFIX}${st.welcomeRoomId}`;
  return out.length <= MAX_ID_LEN ? out : null;
}

/** The ships this install has heard of around one planet, freshest first. */
export function shipsAroundPlanet(planetId: string, now = Date.now()): ShipSummary[] {
  const planet = planetById(planetId).id;
  return Object.values(readStore(now).ships)
    .filter((s) => !s.retired && planetById(s.planetId).id === planet)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The rest of the solar system, names only: stations heard of around other
 *  planets than `planetId`. */
export function systemStationNames(planetId: string, now = Date.now()): Array<{ name: string; planetId: string }> {
  const planet = planetById(planetId).id;
  return Object.values(readStore(now).stations)
    .filter((s) => planetById(s.planetId).id !== planet)
    .map((s) => ({ name: s.name, planetId: planetById(s.planetId).id }))
    .sort((a, b) => (a.planetId === b.planetId ? a.name.localeCompare(b.name) : a.planetId.localeCompare(b.planetId)));
}

/** Test seam: forget the binding. */
export function unbindPlanetSummaryForTest(): void {
  lastReadings.clear();
  doc = null;
  stationMap = null;
  shipMap = null;
  ctx = null;
  trimsByStationId = new Map();
}
