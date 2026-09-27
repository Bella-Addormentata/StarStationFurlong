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
 *     a newer build adds, carried through untouched), its latest trim and its
 *     latest move to another planet;
 *   - per ship: its name, planet and flight (status, from, to, times), and
 *     for a ferry on a route its gate, next stop, departure and status word
 *     (departures boards in rooms its riders never publish to read these).
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
import type { FlightStatus } from './shipDoc';
import { isOrbitTrim, trimFor, trimmedOrbit } from './stationKeeping';
import type { OrbitTrim } from './stationKeeping';
import { cleanMove, isStationMove, rememberMove, rememberedMoveFor } from './stationMove';
import { setStationTrimResolver } from './orbits';
import { MAX_ORBIT_SLOTS, cleanBerths, currentRoomId, listStations, planetById, readStationRecords, registerStation, removeStation } from './stations';
import type { StationBerthRecord, StationMove, StationRecord } from './stations';

// ── Shapes ───────────────────────────────────────────────────────────────────

/** A trim as it travels: the burn's orbit numbers, never its fuel meter. */
export type SharedTrim = Omit<OrbitTrim, 'fuelDrawn'>;

export interface StationSummary {
  welcomeRoomId: string;
  name: string;
  planetId: string;
  orbitSlot: number;
  berthDoor?: string;
  /** ⚓🚦 The station's gates (StationRecord.berths, without the local
   *  `occupied` flag; empty when it is known to have none), and when a
   *  client standing in the station last read them from its atlas. Newest `berthsAt` wins, apart from the record: any
   *  visitor's live atlas knows the gates, not only the record's owner. */
  berths?: StationBerthRecord[];
  berthsAt?: number;
  /** Record fields this build does not know (a newer build's additions),
   *  carried as they came so they reach stations.ts on every client. */
  ext?: Record<string, unknown>;
  trim?: SharedTrim;
  /** The station's latest move to another planet (stationMove.ts), kept even
   *  after it arrives so a late install still learns where it went. Matched
   *  to the station by its welcome room, so the writer's id never matters. */
  move?: StationMove;
  /** The owning install's own id for its saved record, so a flight record
   *  written there (station ids are per install) still resolves here. */
  ownerId?: string;
  updatedAt: number;
}

/** 🚏📋 A route ferry's status, as departures boards show it
 *  (departuresBoard.ts: BOARDING, ON TIME, HOLDING FOR BERTH, DELAYED,
 *  NOT DOCKED, PAUSED, ROUTE BLOCKED). */
export type ShipRouteStatus = 'boarding' | 'on-time' | 'holding' | 'delayed' | 'not-docked' | 'paused' | 'blocked';
export const SHIP_ROUTE_STATUSES: readonly ShipRouteStatus[] = [
  'boarding', 'on-time', 'holding', 'delayed', 'not-docked', 'paused', 'blocked',
];

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
  /** 🚏📋 A ferry on a route (build notes A9 item 7), so an all-gates board
   *  in a room its riders never publish to can still show it, "as of"
   *  updatedAt: the gate it is docked at (or bound for), its next stop's
   *  berth room, its departure from here, and its status word. Additive: an
   *  older client's clean drops them, and its relay passes the rest. */
  gate?: number;
  nextStopRoom?: string;
  departAt?: number;
  routeStatus?: ShipRouteStatus;
  /** 🚏 The run it flies (the route's startedAt), so a board can tell a
   *  replacement route from a later stop of the one it holds. */
  routeRun?: number;
  /** 🚏 The newest checkpoint of that run (its event time: a hold, a skip,
   *  a pause, a person's departure…), so a board can tell that its own copy
   *  of the timetable missed one. */
  routeNews?: number;
  /** 🏁 No route run flies (none set, not started, or ended). Said outright
   *  because an older client's relay drops every route field: a summary
   *  with none of them says nothing about a route. */
  routeIdle?: true;
  updatedAt: number;
}

/** What this client says about the ship it stands in (main.ts builds it). */
export type ShipStatusInput = Omit<ShipSummary, 'updatedAt'>;

export const LEARNED_PREFIX = 'shared:';
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
/** 🚏 A ferry on its route re-stamps an unchanged summary once it is this
 *  old, so a long hold or pause never ages off the boards (they drop a
 *  route row an hour old: departuresBoard SUMMARY_ROW_MAX_AGE_MS). */
export const ROUTE_SUMMARY_REFRESH_MS = 15 * 60_000;
const FLIGHT_STATUSES: readonly string[] = ['docked', 'undocking', 'in-flight', 'redocking'];
const KNOWN_FIELDS = new Set(['id', 'name', 'planetId', 'orbitSlot', 'welcomeRoomId', 'berthDoor', 'berths', 'derived', 'move']);

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
  let json: string;
  try { json = JSON.stringify(v); } catch { return undefined; }
  if (json.length > MAX_EXT_JSON) return undefined;
  const out = JSON.parse(json) as Record<string, unknown>;
  for (const k of Object.keys(out)) if (KNOWN_FIELDS.has(k)) delete out[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanTrim(v: unknown, now = Date.now()): SharedTrim | undefined {
  // A burn's time is peer-written and decides which trim wins: no later
  // than the same skew any other stamp may run ahead.
  if (!isOrbitTrim(v) || v.at > now + MAX_SKEW_MS) return undefined;
  return { planetId: v.planetId, slot: v.slot, dRadiusKm: v.dRadiusKm, dPhase: v.dPhase, at: v.at, last: v.last };
}

/** Shape guard + copy: a summary crosses the peer trust boundary. */
export function cleanStationSummary(v: unknown, now = Date.now()): StationSummary | null {
  if (!isPlainObject(v)) return null;
  if (!isId(v.welcomeRoomId) || !isName(v.name) || !isId(v.planetId)) return null;
  if (!Number.isInteger(v.orbitSlot) || (v.orbitSlot as number) < 0 || (v.orbitSlot as number) >= MAX_ORBIT_SLOTS) return null;
  if (v.berthDoor !== undefined && !isId(v.berthDoor)) return null;
  if (v.ownerId !== undefined && !isId(v.ownerId)) return null;
  if (!isStamp(v.updatedAt, now)) return null;
  const out: StationSummary = {
    welcomeRoomId: v.welcomeRoomId,
    name: v.name,
    planetId: v.planetId,
    orbitSlot: v.orbitSlot as number,
    updatedAt: v.updatedAt,
  };
  if (v.berthDoor !== undefined) out.berthDoor = v.berthDoor as string;
  if (v.ownerId !== undefined) out.ownerId = v.ownerId as string;
  // An empty list is news too (the station's last gate was removed); a list
  // whose every entry was malformed is not.
  const berths = cleanBerths(v.berths);
  if (Array.isArray(v.berths) && (berths.length > 0 || v.berths.length === 0) && isStamp(v.berthsAt, now)) {
    out.berths = berths;
    out.berthsAt = v.berthsAt;
  }
  const ext = cleanExt(v.ext);
  if (ext) out.ext = ext;
  const trim = cleanTrim(v.trim, now);
  if (trim) out.trim = trim;
  if (isStationMove(v.move) && v.move.welcomeRoomId === out.welcomeRoomId) out.move = cleanMove(v.move);
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
  // 🚏📋 The route fields each stand or drop alone: a bad one never costs
  // the ship its summary.
  if (Number.isInteger(v.gate) && (v.gate as number) >= 1 && (v.gate as number) <= 99) out.gate = v.gate as number;
  if (isId(v.nextStopRoom)) out.nextStopRoom = v.nextStopRoom;
  if (isTime(v.departAt)) out.departAt = v.departAt;
  if (typeof v.routeStatus === 'string' && (SHIP_ROUTE_STATUSES as readonly string[]).includes(v.routeStatus)) {
    out.routeStatus = v.routeStatus as ShipRouteStatus;
  }
  if (Number.isSafeInteger(v.routeRun) && (v.routeRun as number) > 0) out.routeRun = v.routeRun as number;
  if (Number.isSafeInteger(v.routeNews) && (v.routeNews as number) > 0) out.routeNews = v.routeNews as number;
  if (v.routeIdle === true && out.routeStatus === undefined) out.routeIdle = true;
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

/** The newer of two trims (a trim is one burn, written whole). */
function newerTrim(a: SharedTrim | undefined, b: SharedTrim | undefined): SharedTrim | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/** The later of two moves (the later departure supersedes). */
function newerMove(a: StationMove | undefined, b: StationMove | undefined): StationMove | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.departAt > a.departAt ? b : a;
}

/** The newer of two gate lists, by when each was read. */
function newerBerths(a: StationSummary, b: StationSummary): Pick<StationSummary, 'berths' | 'berthsAt'> {
  const pick = !a.berths ? b : !b.berths ? a : (b.berthsAt ?? 0) > (a.berthsAt ?? 0) ? b : a;
  return pick.berths ? { berths: pick.berths, berthsAt: pick.berthsAt } : {};
}

/** Merge an incoming station summary into a known one: the newer record,
 *  the newer trim, the later move, the newer gate list. Returns null when
 *  nothing changes. */
export function mergeStation(prior: StationSummary | undefined, incoming: StationSummary): StationSummary | null {
  if (!prior) return incoming;
  const base = incoming.updatedAt > prior.updatedAt ? incoming : prior;
  const trim = newerTrim(prior.trim, incoming.trim);
  const move = newerMove(prior.move, incoming.move);
  const gates = newerBerths(prior, incoming);
  const next: StationSummary = { ...base };
  if (trim) next.trim = trim; else delete next.trim;
  if (move) next.move = move; else delete next.move;
  delete next.berths;
  delete next.berthsAt;
  Object.assign(next, gates);
  return JSON.stringify(next) === JSON.stringify(prior) ? null : next;
}

function mergeShip(prior: ShipSummary | undefined, incoming: ShipSummary): ShipSummary | null {
  if (prior && prior.updatedAt >= incoming.updatedAt) return null;
  return incoming;
}

/** Put a map's entries into a capped object, keeping the newest when full. */
function capped<T extends { updatedAt: number }>(rec: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(rec);
  if (entries.length <= max) return rec;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const out: Record<string, T> = Object.create(null);
  for (const [k, v] of entries.slice(0, max)) out[k] = v;
  return out;
}

// ── From this client: its station and its ship ──────────────────────────────

/** A station whose record this install saved itself (not derived from the
 *  atlas, not learned from a peer). */
function isOwned(station: StationRecord): boolean {
  return !station.derived && !station.id.startsWith(LEARNED_PREFIX);
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
  // An empty list goes out too: it means the station is known to have none.
  if (Array.isArray(station.berths)) {
    out.berths = cleanBerths(station.berths);
    out.berthsAt = updatedAt;
  }
  if (isOwned(station) && isId(station.id)) out.ownerId = station.id;
  const ext = cleanExt(station);
  if (ext) out.ext = ext;
  const applies = cleanTrim(trimFor(station, trim));
  if (applies) out.trim = applies;
  // The latest move this install knows, arrived or not (StationRecord.move
  // is gone once it arrives, and late installs still need it).
  const move = rememberedMoveFor(station) ?? station.move;
  if (move && isStationMove(move) && move.welcomeRoomId === out.welcomeRoomId) out.move = cleanMove(move);
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
): StationSummary | null {
  const mine = summaryForStation(station, trim, now);
  const owned = isOwned(station);
  if (!known) return mine;
  const recordOnly = (a: StationSummary) =>
    JSON.stringify({ ...a, trim: undefined, move: undefined, berths: undefined, berthsAt: undefined, updatedAt: 0 });
  const sameRecord = (a: StationSummary, b: StationSummary): boolean => recordOnly(a) === recordOnly(b);
  const base = owned && !sameRecord(known, mine)
    ? { ...mine, updatedAt: Math.min(Math.max(now, known.updatedAt + 1), now + MAX_SKEW_MS) }
    : known;
  // A trim is keyed by the orbit it trims: it goes out when it names the
  // planet and slot of the record that is kept, whichever client's that is.
  const applies = cleanTrim(trimFor(base, trim));
  // A move rides by its own departure time, whoever's record is kept.
  const move = newerMove(base.move, mine.move);
  // Gates: only the room this client stands in is first-hand; its other rooms
  // may be old atlas data or gossip. So once a list is known, only that room's
  // part of it is replaced (and a new list goes out stamped past the known
  // one); a station with no known list takes this client's whole one.
  const listed = mine.berths && base.berths && firstHandRoom !== undefined
    ? firstHandBerths(base.berths, mine.berths, firstHandRoom)
    : mine.berths;
  const gates = listed && JSON.stringify(listed) !== JSON.stringify(base.berths)
    ? { berths: listed, berthsAt: Math.min(Math.max(now, (base.berthsAt ?? 0) + 1), now + MAX_SKEW_MS) }
    : base.berths ? { berths: base.berths, berthsAt: base.berthsAt } : {};
  const { trim: _unused, move: _unusedMove, berths: _b, berthsAt: _ba, ...rest } = base;
  return mergeStation(known, {
    ...rest, ...(applies ? { trim: applies } : {}), ...(move ? { move } : {}), ...gates,
  });
}

/** ⚓🚦 `known` with `room`'s gates swapped for the ones `mine` lists there,
 *  in gate order (unnumbered berths last); every other room's stay as known. */
function firstHandBerths(
  known: StationBerthRecord[],
  mine: StationBerthRecord[],
  room: string,
): StationBerthRecord[] {
  const out = [...known.filter((b) => b.roomId !== room), ...mine.filter((b) => b.roomId === room)];
  const order = (b: StationBerthRecord) => b.gate ?? Number.MAX_SAFE_INTEGER;
  out.sort((a, b) => order(a) - order(b)
    || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)
    || (a.doorId < b.doorId ? -1 : a.doorId > b.doorId ? 1 : 0));
  return cleanBerths(out);
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
    ...(s.berths ? { berths: s.berths } : {}),
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
      if (r.id.startsWith(LEARNED_PREFIX) && planetById(r.planetId).id !== planet) {
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
    if (owner && !owner.derived && owner.id !== rec.id) continue;
    // Unchanged since it was saved: compare with the SAVED record, not the
    // listed one (the list may have moved it to a free slot), extra fields
    // included (a newer build's, such as a station's move).
    const had = saved.get(rec.id) as (StationRecord & Record<string, unknown>) | undefined;
    const sameExt = Object.entries(s.ext ?? {}).every(([k, v]) => JSON.stringify(had?.[k]) === JSON.stringify(v));
    if (had && sameExt && had.name === rec.name && had.orbitSlot === rec.orbitSlot
      && planetById(had.planetId).id === planetById(rec.planetId).id
      && had.welcomeRoomId === rec.welcomeRoomId && had.berthDoor === rec.berthDoor
      // No list (unknown) and an empty one (known to have none) differ.
      && JSON.stringify(had.berths) === JSON.stringify(rec.berths)) continue;
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
  for (const [k, v] of stationMap!.entries()) {
    if (++scanned > MAX_STATIONS * 4) break;
    const s = cleanStationSummary(v, now);
    if (!s || s.welcomeRoomId !== k) continue;
    const next = mergeStation(store.stations[k], s);
    if (next) { store.stations[k] = next; changed = true; }
  }
  scanned = 0;
  for (const [k, v] of shipMap!.entries()) {
    if (++scanned > MAX_SHIPS * 4) break;
    const s = cleanShipSummary(v, now);
    if (!s || s.roomId !== k || now - s.updatedAt > SHIP_STALE_MS) continue;
    const next = mergeShip(store.ships[k], s);
    if (next) { store.ships[k] = next; changed = true; }
  }
  if (!changed) return;
  store.stations = capped(store.stations, MAX_STATIONS);
  store.ships = capped(store.ships, MAX_SHIPS);
  writeStore(store);
  applyLearned(store);
  notify();
}

/** Delete a shared map's invalid entries and all but its `max` newest valid
 *  ones (ties by key, so every client prunes the same way). */
function pruneMap(map: Y.Map<unknown>, stampOf: (k: string, v: unknown) => number | null, max: number): void {
  const keep: Array<[string, number]> = [];
  const drop: string[] = [];
  for (const [k, v] of map.entries()) {
    const at = stampOf(k, v);
    if (at === null) drop.push(k); else keep.push([k, at]);
  }
  keep.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k] of keep.slice(max)) drop.push(k);
  for (const k of drop) map.delete(k);
}

/** This install → doc: its own station and ship first, then everything it
 *  knows (so news travels with players from station to station). */
export function publishPlanetSummary(now = Date.now()): void {
  if (!alive() || !ctx) return;
  const store = readStore(now);
  const here = ctx.currentStation();
  if (here && here.welcomeRoomId && here.welcomeRoomId.length <= MAX_ID_LEN) {
    const next = foldOwnStation(store.stations[here.welcomeRoomId], here, ctx.localTrim(), now, currentRoomId() || undefined);
    if (next) store.stations[here.welcomeRoomId] = next;
  }
  const ship = ctx.ship();
  if (ship) {
    const s = cleanShipSummary({ ...ship, updatedAt: now }, now);
    const prior = s ? store.ships[s.roomId] : undefined;
    // 🚏 A ferry on its route keeps a shorter heartbeat than other ships.
    const beat = s?.routeStatus !== undefined ? ROUTE_SUMMARY_REFRESH_MS : SHIP_HEARTBEAT_MS;
    const same = prior && s && now - prior.updatedAt < beat
      && JSON.stringify({ ...prior, updatedAt: 0 }) === JSON.stringify({ ...s, updatedAt: 0 });
    if (s && !same) store.ships[s.roomId] = s;
  }
  store.stations = capped(store.stations, MAX_STATIONS);
  store.ships = capped(store.ships, MAX_SHIPS);
  writeStore(store);
  applyLearned(store);
  doc!.transact(() => {
    for (const [k, s] of Object.entries(store.stations)) {
      const known = cleanStationSummary(stationMap!.get(k), now);
      if (known && !mergeStation(known, s)) continue;
      stationMap!.set(k, known ? mergeStation(known, s)! : s);
    }
    for (const [k, s] of Object.entries(store.ships)) {
      const known = cleanShipSummary(shipMap!.get(k), now);
      if (known && known.updatedAt >= s.updatedAt) continue;
      shipMap!.set(k, s);
    }
    // The maps are never otherwise pruned, and readers stop scanning after a
    // bound: keep only the newest valid entries, so what is visible is decided
    // by freshness, never by map order (and junk keys do not pile up).
    pruneMap(stationMap!, (k, v) => {
      const s = cleanStationSummary(v, now);
      return s && s.welcomeRoomId === k ? s.updatedAt : null;
    }, MAX_STATIONS);
    pruneMap(shipMap!, (k, v) => {
      const s = cleanShipSummary(v, now);
      return s && s.roomId === k && now - s.updatedAt <= SHIP_STALE_MS ? s.updatedAt : null;
    }, MAX_SHIPS);
  });
}

// ── Reading what is known ────────────────────────────────────────────────────

let trimsByStationId = new Map<string, SharedTrim>();

/** Refresh records and trims from the store: register this planet's learned
 *  stations, then map every listed station to its newest known trim. */
function applyLearned(store: Store): void {
  // Moves first: they decide which planet each station is listed at.
  for (const s of Object.values(store.stations)) if (s.move) rememberMove(s.move);
  const here = ctx?.currentStation() ?? null;
  const planet = here ? planetById(here.planetId).id : planetById(undefined).id;
  registerLearnedStations(planet, Object.values(store.stations), { prune: here !== null });
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
  if (listed.some((s) => s.id === id)) return id;
  let room: string | undefined;
  for (const prefix of [DERIVED_PREFIX, LEARNED_PREFIX]) {
    if (id.startsWith(prefix)) room = id.slice(prefix.length);
  }
  if (room === undefined) {
    room = Object.values(readStore(now).stations).find((s) => s.ownerId === id)?.welcomeRoomId;
  }
  if (!room) return null;
  return listed.find((s) => s.welcomeRoomId === room)?.id ?? null;
}

/** The ships this install has heard of around one planet, freshest first. */
export function shipsAroundPlanet(planetId: string, now = Date.now()): ShipSummary[] {
  const planet = planetById(planetId).id;
  return Object.values(readStore(now).ships)
    .filter((s) => planetById(s.planetId).id === planet)
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
  doc = null;
  stationMap = null;
  shipMap = null;
  ctx = null;
  trimsByStationId = new Map();
}
