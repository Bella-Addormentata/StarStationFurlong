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

/** Rooms whose trim-gone readings a summary keeps (the newest, one each),
 *  besides the floor: as many as the atlas holds rooms (MAX_ENTRIES). */
export const MAX_TRIM_GONE = 64;
/** The `from` of the floor entry: a room reading dropped past the cap
 *  raises it, and it holds for every room without an entry of its own, so
 *  no trim read before a forgotten take-back can come back. Never a room id
 *  (those are seed-derived). */
export const TRIM_GONE_FLOOR = '*';

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
   *  written there (station ids are per install) can still resolve here. */
  ownerId?: string;
  /** The other ids this place's owned records went by (records that lost to
   *  this one: other installs', or its install's under an earlier id),
   *  sorted, at most MAX_OWNER_ALIASES: a flight record written under one of
   *  them can still resolve here (resolveStationAlias). */
  ownerAliases?: string[];
  /** The install that published an owned record (identity.ts
   *  getStationOwnerId), only beside `ownerId`: station ids are each
   *  install's own, so two installs can save one place under one id, and
   *  this is what settles whose record stands (mergeStation). */
  ownerInstall?: string;
  updatedAt: number;
}

export const MAX_OWNER_ALIASES = 8;

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
 *  a link or invite, a room key): layout is public, admission is not. */
const CREDENTIAL_KEY = /seed|pass(?!age)|link|invite|token|secret|cred|key/i;
/** A parameter named the same way, in a link or a line (ssf://room?seed=…). */
const CREDENTIAL_PARAM = new RegExp(`(?:^|[?#&;\\s])[^=?#&;\\s]*(?:${CREDENTIAL_KEY.source})[^=?#&;\\s]*=`, 'i');

/** A string that is, or carries, a room's dial-in credentials, whatever
 *  field it sits under: a credential-named parameter (a link's), JSON text
 *  holding a credential, or base64 JSON, which is how a pass is written
 *  (main.ts's encodeBootstrapSeed). */
function isCredentialValue(s: string): boolean {
  let text = s;
  try { text = decodeURIComponent(s); } catch { /* not URI-encoded */ }
  if (CREDENTIAL_PARAM.test(text)) return true;
  try {
    // Every string inside is shorter than this one, so this ends.
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null
      && JSON.stringify(stripCredentials(parsed)) !== JSON.stringify(parsed)) return true;
  } catch { /* not JSON text */ }
  for (const [token] of text.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
    try {
      const decoded: unknown = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof decoded === 'object' && decoded !== null) return true;
    } catch { /* not base64 JSON */ }
  }
  return false;
}

const isCredential = (v: unknown): boolean => typeof v === 'string' && isCredentialValue(v);

/** A JSON value with every credential-named field and every credential
 *  string (a value, a list item or a field name) removed, at any depth. */
function stripCredentials(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isCredential(x)).map(stripCredentials);
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!CREDENTIAL_KEY.test(k) && !isCredential(k) && !isCredential(x)) out[k] = stripCredentials(x);
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
  if (out.ownerId !== undefined && isId(v.ownerInstall)) out.ownerInstall = v.ownerInstall;
  // Peer-sent: bounded before it is walked.
  if (Array.isArray(v.ownerAliases) && v.ownerAliases.length <= MAX_OWNER_ALIASES * 4) {
    const aliases = mergeAliases(v.ownerAliases.filter(isId), [], out.ownerId);
    if (aliases) out.ownerAliases = aliases;
  }
  const ext = cleanExt(v.ext);
  if (ext) out.ext = ext;
  const trim = cleanTrim(v.trim, now);
  if (trim) out.trim = trim;
  const gone = cleanTrimGone(v.trimGone, now);
  if (gone) out.trimGone = gone;
  return canonOrder(out);
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
      if (s && s.roomId === k && shipKept(s, now)) { out.ships[k] = s; n++; }
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
 *  burns too (a trim without the count ranks lowest); then tieBreak. */
function newerTrim(a: SharedTrim | undefined, b: SharedTrim | undefined): SharedTrim | undefined {
  if (!a) return b;
  if (!b) return a;
  // Two readings of one room's log: the later reading is that room's trim now.
  if (a.from !== undefined && a.from === b.from && a.readAt !== b.readAt) {
    return (b.readAt ?? 0) > (a.readAt ?? 0) ? b : a;
  }
  if (b.at !== a.at) return b.at > a.at ? b : a;
  // A trim without the count (an older build's) has replayed no more burns
  // than one with it: it ranks below every counted trim.
  const drawn = (t: SharedTrim) => t.fuelDrawn ?? -1;
  if (drawn(a) !== drawn(b)) return drawn(b) > drawn(a) ? b : a;
  return tieBreak(a, b);
}

/** Two values stamped the same moment: every client keeps the same one (the
 *  greater canonical JSON), so concurrent first publishes still converge. */
function tieBreak<T>(a: T, b: T): T {
  return JSON.stringify(b) > JSON.stringify(a) ? b : a;
}

/** Merge an incoming station summary into a known one, and the newer trim.
 *  Which record stands: one its owner published (it carries `ownerId`) beats
 *  one nobody owns; between one install's records the newer wins, whatever
 *  station id it went by, and between two installs' owned records the
 *  smaller install id stands (ownerRank); between records
 *  nobody owns (derived stations) the FIRST published stands, so a late
 *  install cannot move a station everyone already placed. Same-moment ties
 *  settle on the canonical JSON. Returns null when nothing changes. */
export function mergeStation(prior: StationSummary | undefined, incoming: StationSummary): StationSummary | null {
  if (!prior) return incoming;
  const recordOf = (s: StationSummary): string =>
    JSON.stringify({ ...s, trim: undefined, trimGone: undefined, ownerAliases: undefined });
  const owned = (s: StationSummary) => s.ownerId !== undefined;
  // Two installs that each saved the place, under any station ids (the same
  // one too): one of them stands for good, so their republishes cannot take
  // turns.
  const rivals = owned(incoming) && owned(prior) && ownerRank(incoming) !== ownerRank(prior);
  const base = owned(incoming) !== owned(prior)
    ? (owned(incoming) ? incoming : prior)
    : rivals
      ? (ownerRank(incoming) < ownerRank(prior) ? incoming : prior)
      : incoming.updatedAt !== prior.updatedAt
        ? ((incoming.updatedAt > prior.updatedAt) === owned(incoming) ? incoming : prior)
        : (recordOf(canonOrder(incoming)) > recordOf(canonOrder(prior)) ? incoming : prior);
  // Only a trim of the orbit the standing record flies: one published for
  // the slot that lost would be dropped by every reader anyway. A slot clash
  // in listStations can move the standing record off the slot it asks for
  // (the same way on every install), so a trim of its planet also stands
  // when it comes with the standing record itself, unchanged: that is the
  // station's own republish, trimming the slot it flies.
  const standing = recordOf(canonOrder({ ...base, updatedAt: 0 }));
  const fits = (s: StationSummary): SharedTrim | undefined => {
    const t = s.trim;
    if (!t) return undefined;
    if (trimFor(base, t)) return t;
    return planetById(t.planetId).id === planetById(base.planetId).id
      && recordOf(canonOrder({ ...s, updatedAt: 0 })) === standing ? t : undefined;
  };
  const gone = mergeGone(prior.trimGone, incoming.trimGone);
  // A room's trim read before that room read none is taken back.
  const alive = (t: SharedTrim | undefined) =>
    (t && (t.from === undefined || (t.readAt ?? 0) >= goneAt(gone, t.from)) ? t : undefined);
  const trim = newerTrim(alive(fits(prior)), alive(fits(incoming)));
  // Every owner id seen for this place but the standing one's.
  const aliases = mergeAliases(
    [...(prior.ownerAliases ?? []), ...(incoming.ownerAliases ?? []), prior.ownerId, incoming.ownerId],
    [], base.ownerId);
  const next: StationSummary = { ...base };
  if (trim) next.trim = trim; else delete next.trim;
  if (gone) next.trimGone = gone; else delete next.trimGone;
  if (aliases) next.ownerAliases = aliases; else delete next.ownerAliases;
  const out = canonOrder(next);
  return JSON.stringify(out) === JSON.stringify(prior) ? null : out;
}

/** A summary's fields in one fixed order (then any others as they came), so
 *  equal summaries serialize alike wherever a field was added: records are
 *  compared, and settled between installs, by their JSON. */
const SUMMARY_ORDER = [
  'welcomeRoomId', 'name', 'planetId', 'orbitSlot', 'updatedAt', 'berthDoor', 'ownerId', 'ownerAliases', 'ext', 'trim', 'trimGone',
] as const;

function canonOrder(s: StationSummary): StationSummary {
  const out: Record<string, unknown> = {};
  const src = s as unknown as Record<string, unknown>;
  for (const k of SUMMARY_ORDER) if (src[k] !== undefined) out[k] = src[k];
  for (const [k, v] of Object.entries(src)) if (!(k in out) && v !== undefined) out[k] = v;
  return out as unknown as StationSummary;
}

/** Owner ids, deduplicated, without `standing`, sorted and capped (the
 *  smallest kept, so every client settles on the same list). */
function mergeAliases(a: readonly (string | undefined)[], b: readonly (string | undefined)[], standing?: string): string[] | undefined {
  const ids = [...new Set([...a, ...b])].filter((x): x is string => x !== undefined && x !== standing);
  ids.sort();
  return ids.length > 0 ? ids.slice(0, MAX_OWNER_ALIASES) : undefined;
}

/** Two lists of "trim gone" readings, room by room: the later reading of
 *  each room; past the cap the newest rooms stay (ties by room) and the
 *  rest raise the floor entry (TRIM_GONE_FLOOR), which also stands in for
 *  every reading at or below it. Sorted by room so every client settles on
 *  the same list. */
function mergeGone(a: TrimGone[] | undefined, b: TrimGone[] | undefined): TrimGone[] | undefined {
  if (!a?.length) return b?.length ? b : undefined;
  if (!b?.length) return a;
  const byRoom = new Map<string, TrimGone>();
  for (const g of [...a, ...b]) {
    const had = byRoom.get(g.from);
    if (!had || g.readAt > had.readAt) byRoom.set(g.from, g);
  }
  let floor = byRoom.get(TRIM_GONE_FLOOR)?.readAt ?? 0;
  byRoom.delete(TRIM_GONE_FLOOR);
  const byName = (x: TrimGone, y: TrimGone) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0);
  const rooms = [...byRoom.values()].sort((x, y) => y.readAt - x.readAt || byName(x, y));
  for (const g of rooms.slice(MAX_TRIM_GONE)) floor = Math.max(floor, g.readAt);
  const kept = rooms.slice(0, MAX_TRIM_GONE).filter((g) => g.readAt > floor);
  if (floor > 0) kept.push({ from: TRIM_GONE_FLOOR, readAt: floor });
  return kept.length > 0 ? kept.sort(byName) : undefined;
}

/** When `room` last read no trim, or the floor if later (0: never, as far
 *  as known). */
function goneAt(gone: TrimGone[] | undefined, room: string): number {
  let at = 0;
  for (const g of gone ?? []) if (g.from === room || g.from === TRIM_GONE_FLOOR) at = Math.max(at, g.readAt);
  return at;
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
 *  ship it is aboard. Retention keeps them whatever peers stamp, and the
 *  stations its planet lists too (listedAt). And the planet it is at (null
 *  when it cannot place itself). */
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
  return { stations: listedAt(planet, store, stations), ships, planet };
}

/** The room this client stands in, unless it is known to be no ship. */
function mayBeShipRoom(): string | null {
  const room = ctx?.currentRoom?.() || null;
  return room && ctx?.notShipRoom?.() !== room ? room : null;
}

/** A ship summary worth keeping: heard from within SHIP_STALE_MS, or the
 *  summary of the room this client stands in, however old. A ship left empty
 *  for a day is still where its summary says, and a fresh install aboard has
 *  nothing else to place it by until it republishes; shipsAroundPlanet still
 *  lists only fresh ships. */
function shipKept(s: ShipSummary, now: number): boolean {
  return now - s.updatedAt <= SHIP_STALE_MS || s.roomId === mayBeShipRoom();
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

/** This install's own id for the records it saves (the context's), when it
 *  has a usable one. */
function thisInstall(): string | undefined {
  const id = ctx?.installId?.();
  return isId(id) ? id : undefined;
}

/** Whose an owned summary is, for settling two installs' records of one
 *  place: the install that published it, or, from a build that sent none,
 *  its station id, ranked after every install. */
function ownerRank(s: StationSummary): string {
  return s.ownerInstall !== undefined ? `0${s.ownerInstall}` : `1${s.ownerId ?? ''}`;
}

/** Is `s` another install's record than this install's own `ownId` one? By
 *  install where both are known, else (a build that sent none) by station id. */
function otherOwner(s: StationSummary, ownId: string): boolean {
  if (s.ownerId === undefined) return false;
  const me = thisInstall();
  return s.ownerInstall !== undefined && me !== undefined ? s.ownerInstall !== me : s.ownerId !== ownId;
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
  const install = thisInstall();
  if (out.ownerId !== undefined && install !== undefined) out.ownerInstall = install;
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
    JSON.stringify({ ...a, trim: undefined, trimGone: undefined, updatedAt: 0, ownerId: undefined, ownerInstall: undefined, ownerAliases: undefined })
      === JSON.stringify({ ...b, trim: undefined, trimGone: undefined, updatedAt: 0, ownerId: undefined, ownerInstall: undefined, ownerAliases: undefined });
  const base = owned && !sameRecord(known, mine)
    ? { ...mine, updatedAt: Math.min(Math.max(now, known.updatedAt + 1), now + MAX_SKEW_MS) }
    // The same record as another install's, or under another station id, or
    // nobody's: this one's goes out too, under the known stamp, so
    // mergeStation settles the owner and keeps the other id as an alias (a
    // flight record written on either install can still resolve).
    : owned && (mine.ownerId !== known.ownerId || mine.ownerInstall !== known.ownerInstall)
      ? { ...mine, updatedAt: known.updatedAt }
      : known;
  // A trim is keyed by the orbit it trims: it goes out when it names the
  // planet and slot of the record that is kept, whichever client's that is.
  // A learned station flies the slot listStations settled for that record,
  // which a slot clash can move off the one the record asks for.
  const flies = !owned && isLearnedRecord(station) ? station : base;
  const applies = cleanTrim(trimFor(flies, readTrim(known)));
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

/** Does a saved record already say what a summary says? Its extra fields
 *  count both ways: one the summary no longer carries must go too. */
function holdsSummary(had: StationRecord & Record<string, unknown>, s: StationSummary): boolean {
  const ext = s.ext ?? {};
  return Object.keys(had).filter((k) => !KNOWN_FIELDS.has(k)).length === Object.keys(ext).length
    && Object.entries(ext).every(([k, v]) => JSON.stringify(had[k]) === JSON.stringify(v))
    && had.name === s.name && had.orbitSlot === s.orbitSlot
    && planetById(had.planetId).id === planetById(s.planetId).id
    && had.welcomeRoomId === s.welcomeRoomId && had.berthDoor === s.berthDoor;
}

/** Which of a planet's summaries for places this install has no station of
 *  its own it lists (`admitted`) and which it leaves out (`displaced`): ranked
 *  owned first, then by welcome room, as many as the planet's slots its own
 *  stations leave free. The same summaries rank alike everywhere, so a
 *  crowded planet lists the same learned stations on every install. */
function admittedAt(planet: string, stations: Iterable<StationSummary>, listed: StationRecord[]): {
  admitted: Set<string>;
  displaced: Set<string>;
} {
  const own = listed.filter((st) => !st.derived && !isLearnedRecord(st) && planetById(st.planetId).id === planet);
  const ownRooms = new Set(own.map((st) => st.welcomeRoomId));
  const ranked = [...stations]
    .filter((s) => planetById(s.planetId).id === planet && !ownRooms.has(s.welcomeRoomId))
    .sort((a, b) => Number(b.ownerId !== undefined) - Number(a.ownerId !== undefined)
      || (a.welcomeRoomId < b.welcomeRoomId ? -1 : a.welcomeRoomId > b.welcomeRoomId ? 1 : 0));
  const free = Math.max(0, MAX_ORBIT_SLOTS - own.length);
  return {
    admitted: new Set(ranked.slice(0, free).map((s) => s.welcomeRoomId)),
    displaced: new Set(ranked.slice(free).map((s) => s.welcomeRoomId)),
  };
}

/** `keep`, plus the rooms of the learned stations `planet` lists from what
 *  `store` knows (admittedAt): a store or map past its cap keeps them by
 *  rank, not by stamp, so every install that heard them lists the same. */
function listedAt(planet: string | null, store: Store | undefined, keep: Set<string>): Set<string> {
  if (!planet || !store) return keep;
  for (const room of admittedAt(planet, Object.values(store.stations), listStations()).admitted) keep.add(room);
  return keep;
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
  // A planet with more stations than slots lists the same learned ones on
  // every install, whatever order their summaries came in (admittedAt); a
  // learned record ranked out goes, since an earlier order may have let it in.
  // So, when these summaries are all the planet has (prune), does one whose
  // summary is gone: a full store let it go, and it would hold a slot.
  stations = [...stations]; // walked twice
  const { admitted, displaced } = admittedAt(planet, stations, listed);
  for (const r of [...saved.values()]) {
    if (isLearnedRecord(r) && planetById(r.planetId).id === planet
      && (opts.prune ? !admitted.has(r.welcomeRoomId) : displaced.has(r.welcomeRoomId))) {
      removeStation(r.id);
      saved.delete(r.id);
      changed++;
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
      // takes that record whole under its own id (its planet and slot, so
      // the standing trim fits, and its name, berth and a newer build's
      // fields), so every install registers the same station.
      const own = saved.get(owner.id) as (StationRecord & Record<string, unknown>) | undefined;
      if (own && !isLearnedRecord(own) && otherOwner(s, owner.id) && !holdsSummary(own, s)) {
        if (registerStation({ ...rec, id: own.id })) changed++;
      }
      continue;
    }
    // Past the slots this planet has left for learned stations.
    if (!admitted.has(s.welcomeRoomId)) continue;
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
   *  ready ship, a station's own room, or bolted into a station), else
   *  null: a ship entry for that room is withdrawn. A ship whose planet is
   *  not placed yet (`ship()` is null for it too) is not this, so its entry
   *  stands. Optional: without it nothing is withdrawn. */
  notShipRoom?: () => string | null;
  /** The room this client stands in: its trim (localTrim) is read
   *  first-hand there, so a trim that room takes back spreads. Optional:
   *  without it trims only merge by burn time. */
  currentRoom?: () => string | null;
  /** This install's own id (identity.ts getStationOwnerId): the stations it
   *  saved go out under it (`ownerInstall`), so two installs that saved one
   *  place under one station id still settle on one record. Optional:
   *  without it they settle by station id alone. */
  installId?: () => string;
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
    // What this client says of its ship reads the station list: a pull that
    // registers the station its flight names places the ship (or moves it),
    // and that goes out now, not at the heartbeat.
    const ship = JSON.stringify(ctx?.ship() ?? null);
    pullPlanetSummary();
    if (JSON.stringify(ctx?.ship() ?? null) !== ship) publishPlanetSummary();
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
    if (!s || s.roomId !== k || !shipKept(s, now)) continue;
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
  // A free ship's own one-room stand-in is no station: published, it would
  // stand for good and peers would learn the ship as one (applyLearned
  // skips it too).
  const found = ctx.currentStation();
  const here = found && !isShipStandIn(found, mayBeShipRoom()) ? found : null;
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
      return s && s.roomId === k && shipKept(s, now) ? { at: s.updatedAt, planetId: s.planetId } : null;
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
  const ours = here !== null && isOwned(here) && (shared === undefined || !otherOwner(shared, here.id));
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
 * learned id names its welcome room. Any other id is some install's saved
 * record's (written before ids were portable), and installs pick theirs
 * freely: it names a place only when every record this install knows under
 * it (its own, and the summaries' `ownerId`s and `ownerAliases`) is of that
 * one place. Null when several are (whose it was cannot be told), or when no
 * listed station matches.
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
  const own = listed.find((s) => s.id === id);
  const places = new Set<string>(own ? [own.welcomeRoomId] : []);
  for (const s of Object.values(readStore(now).stations)) {
    if (s.ownerId === id || s.ownerAliases?.includes(id)) places.add(s.welcomeRoomId);
  }
  if (places.size !== 1) return null;
  if (own) return own.id;
  const [only] = places;
  return listed.find((s) => s.welcomeRoomId === only)?.id ?? null;
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
    .filter((s) => !s.retired && now - s.updatedAt <= SHIP_STALE_MS && planetById(s.planetId).id === planet)
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
