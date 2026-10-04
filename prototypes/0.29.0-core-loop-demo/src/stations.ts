/**
 * 🪐 Stations — which planet each station orbits, and in which slot.
 *
 * A station is still not stored as a thing of its own: it is the set of rooms
 * joined by door pairings (stationAtlas.atlasComponents). This module puts a
 * small RECORD on top of each such set — id, name, planet, orbit slot and the
 * welcome (berth) room a ship docks at — so the holotable, the exterior view
 * and, later, ship destinations can all ask the same question: "what stations
 * orbit this planet, and which one am I in?"
 *
 * Where a record comes from, first match wins:
 *   1. The BUILT-IN default station (defaultStation.ts): 'furlong-station',
 *      orbiting Planet Sovereign in slot 0. Its id is the one the solar map
 *      has always used, so nothing that already names it changes.
 *   2. RECORDS saved on this install (localStorage 'ssf-stations', written by
 *      registerStation — the devtools hook in main.ts). A record claims the
 *      atlas component that holds its welcome room.
 *   3. DERIVED — every other atlas component becomes a station orbiting the
 *      default planet, named after its anchor room. The anchor is the
 *      component's smallest room id, so every client holding the same atlas
 *      derives the same id and slot. A derived id changes if two components
 *      are later joined by a pairing; save a record to pin one.
 *
 * Saved records are per-install for now, like the local atlas they sit on.
 * Carrying them in the room doc (so every visitor agrees on a station's
 * planet) is the natural next step once ship travel needs it.
 */

import { atlasComponent, atlasComponents, isBerthDoor, readAtlas, roomIdFromSeed } from './stationAtlas';
import type { AtlasEntry } from './stationAtlas';
import { DEFAULT_STATION } from './defaultStation';
import { isAcceptableDoorKey } from './doorsDoc';
import type { DoorRecord } from './doorsDoc';

export interface PlanetRecord {
  /** Matches the solar map's planet body id (map.ts). */
  id: string;
  name: string;
  /** Exterior-view backdrop colours (exteriorView.ts). */
  color: number;
  emissive: number;
  atmosphere: number;
  /** Surface radius, km — orbits.ts measures altitude from it. */
  radiusKm: number;
  /** Gravitational parameter GM, km³/s² — sets every orbit's period. */
  mu: number;
}

export const PLANETS: readonly PlanetRecord[] = [
  // Earth-sized terra world: a 400 km orbit takes ~92 orbital minutes.
  { id: 'planet-sovereign', name: 'SOVEREIGN II', color: 0x2a5a8f, emissive: 0x0c2038, atmosphere: 0x7fb8ff, radiusKm: 6371, mu: 398600.4418 },
  // Smaller, dense lava world.
  { id: 'planet-aris', name: 'ARIS PRIME', color: 0x8a3a1c, emissive: 0x3a0e04, atmosphere: 0xff9a66, radiusKm: 4800, mu: 250000 },
];

export const DEFAULT_PLANET_ID = 'planet-sovereign';

export function planetById(id: string | undefined): PlanetRecord {
  return PLANETS.find((p) => p.id === id) ?? PLANETS.find((p) => p.id === DEFAULT_PLANET_ID)!;
}

export interface StationRecord {
  id: string;
  name: string;
  /** A PLANETS id; unknown ids read as the default planet. */
  planetId: string;
  /** 0-based slot around the planet — unique per planet in listStations. It
   *  fixes the station's circular orbit (orbits.ts): slot 0 is 400 km up and
   *  each slot is a quarter farther from the planet's centre. */
  orbitSlot: number;
  /** The room a docking ship berths at. '' when unknown (a build shipping no
   *  default station). */
  welcomeRoomId: string;
  /** Optional door id of the berth port in the welcome room — a door key
   *  doorsDoc accepts (a record naming any other could never be docked at). */
  berthDoor?: string;
  /** Set on stations derived from an atlas component with no record. */
  derived?: true;
}

/** Slots per planet. orbits.ts spaces slots geometrically, so this also
 *  bounds how far out a station can orbit (slot 15 ≈ 190,000 km for
 *  Sovereign II — about half the distance to a moon). */
export const MAX_ORBIT_SLOTS = 16;

export const DEFAULT_STATION_ID = 'furlong-station';

export const DEFAULT_STATION_RECORD: StationRecord = {
  id: DEFAULT_STATION_ID,
  name: 'FURLONG LOBBY STATION',
  planetId: DEFAULT_PLANET_ID,
  orbitSlot: 0,
  welcomeRoomId: DEFAULT_STATION.welcomeRoomId,
};

// ── Saved records ────────────────────────────────────────────────────────────

const KEY = 'ssf-stations';
const MAX_RECORDS = 32;

/** Prefix of derived station ids — never accepted on a saved record. */
const DERIVED_PREFIX = 'station:';

/** Length limits on every station id and name, saved or derived. */
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 64;

/** Solar-map body ids a station may not take (map.ts initializeBodies): a
 *  station sharing an id with a planet would confuse selection and travel. */
const RESERVED_BODY_IDS = new Set([
  'star-sol', 'lagrange-l4', 'lagrange-l5', 'belt-ring', ...PLANETS.map((p) => p.id),
]);

function isRecord(v: unknown): v is StationRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length <= MAX_ID_LENGTH
    && !r.id.startsWith(DERIVED_PREFIX) && !RESERVED_BODY_IDS.has(r.id)
    && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= MAX_NAME_LENGTH
    && typeof r.planetId === 'string'
    && Number.isInteger(r.orbitSlot) && (r.orbitSlot as number) >= 0 && (r.orbitSlot as number) < MAX_ORBIT_SLOTS
    && typeof r.welcomeRoomId === 'string' && r.welcomeRoomId.length > 0
    && (r.berthDoor === undefined || (typeof r.berthDoor === 'string' && isAcceptableDoorKey(r.berthDoor)));
}

export function readStationRecords(): StationRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isRecord).slice(0, MAX_RECORDS).map(clean);
  } catch { return []; }
}

/** Most JSON a record's extra fields may take (a newer build's, or a peer's
 *  carried by the shared planet summary); past it they are dropped. */
const MAX_EXTRA_JSON = 1024;
const CORE_FIELDS = new Set(['id', 'name', 'planetId', 'orbitSlot', 'welcomeRoomId', 'berthDoor', 'derived']);

/** The record's fields this build does not know, kept as they are while
 *  they are plain JSON within MAX_EXTRA_JSON, so a newer build's (or a
 *  learned station's) survive a save here. */
function extraFields(r: StationRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!CORE_FIELDS.has(k) && k !== '__proto__') out[k] = v;
  if (Object.keys(out).length === 0) return out;
  try {
    const json = JSON.stringify(out);
    return json.length <= MAX_EXTRA_JSON ? JSON.parse(json) as Record<string, unknown> : {};
  } catch { return {}; }
}

function clean(r: StationRecord): StationRecord {
  return {
    ...extraFields(r),
    id: r.id,
    name: r.name,
    planetId: planetById(r.planetId).id,
    orbitSlot: r.orbitSlot,
    welcomeRoomId: r.welcomeRoomId,
    ...(r.berthDoor ? { berthDoor: r.berthDoor } : {}),
  };
}

/** Save (or replace, by id) a station record on this install. Returns false
 *  for an invalid record, one that would shadow the built-in default, a solar
 *  map body or a derived station id, one whose planet has no free orbit slot
 *  left (or would have none for a station already saved), or one whose
 *  welcome room is part of a station already listed. */
export function registerStation(record: Omit<StationRecord, 'derived'>): boolean {
  if (!isRecord(record) || record.id === DEFAULT_STATION_ID) return false;
  const saved = readStationRecords();
  const records = [...saved];
  // Replace IN PLACE: when two records name one place the earlier keeps it,
  // and the list keeps record order.
  const at = records.findIndex((r) => r.id === record.id);
  if (at >= 0) records[at] = clean(record);
  else if (records.length >= MAX_RECORDS) return false;
  else records.push(clean(record));
  // Refuse a record the list would drop (its planet has no free slot, or its
  // welcome room already belongs to a listed station), and one that would
  // drop a saved station instead: winning that station's slot on a full
  // planet, or taking its place.
  const atlas = readAtlas();
  const listed = new Set(listStations(atlas, records).map((s) => s.id));
  if (!listed.has(record.id)) return false;
  if (listStations(atlas, saved).some((s) => !s.derived && s.id !== record.id && !listed.has(s.id))) return false;
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { return false; }
  return true;
}

export function removeStation(id: string): void {
  const records = readStationRecords().filter((r) => r.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* quota */ }
}

// ── The station list ─────────────────────────────────────────────────────────

/**
 * Every station this install knows: the built-in default, saved records, and
 * one derived station per unclaimed atlas component. One place is one
 * station — a record whose welcome room lies in a station already listed is
 * dropped. Orbit slots are unique per planet — a record that loses a clash
 * for its slot moves to the next free one, settled the same way on every
 * install whatever order it saved its records in, and derived stations fill
 * free slots in anchor order. This is the list ship destinations read from.
 */
export function listStations(
  atlas: Record<string, AtlasEntry> = readAtlas(),
  records: StationRecord[] = readStationRecords(),
): StationRecord[] {
  // Which PLACE a welcome room is: its atlas component, or the bare room when
  // the atlas does not know it. One place is one station — a second record
  // pointing into a station already listed is dropped, not listed twice.
  const components = atlasComponents(atlas);
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => { for (const rid of c) componentOf.set(rid, i); });
  const placeOf = (roomId: string): string => {
    if (!roomId) return '';
    const c = componentOf.get(roomId);
    return c === undefined ? `room:${roomId}` : `component:${c}`;
  };

  const taken = new Map<string, Set<number>>();
  const used = (planetId: string): Set<number> => {
    let slots = taken.get(planetId);
    if (!slots) taken.set(planetId, slots = new Set());
    return slots;
  };
  const claim = (planetId: string, wanted: number): number | null => {
    const slots = used(planetId);
    for (let i = 0; i < MAX_ORBIT_SLOTS; i++) {
      const slot = (wanted + i) % MAX_ORBIT_SLOTS;
      if (!slots.has(slot)) { slots.add(slot); return slot; }
    }
    return null;
  };

  // One place is one station: the earlier record keeps it.
  const kept: StationRecord[] = [];
  const seen = new Set<string>();
  for (const r of [DEFAULT_STATION_RECORD, ...records]) {
    if (kept.some((e) => e.id === r.id)) continue;
    const place = placeOf(r.welcomeRoomId);
    if (place && seen.has(place)) continue;
    if (place) seen.add(place);
    // An unknown planet reads as the default one, so it claims that planet's slots.
    kept.push({ ...r, planetId: planetById(r.planetId).id });
  }

  // Slots are settled in one global order, never this install's record order,
  // so every install holding the same stations gives each the same slot. The
  // built-in default claims first, as it is the same everywhere. Each wanted
  // slot then goes to the record with the smallest welcome room id, and only
  // after that do the records that lost a clash take the next free slot on,
  // so a clash moves only the station that lost it.
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const [builtIn, ...rest] = kept;
  const slotOf = new Map<StationRecord, number>([[builtIn, claim(builtIn.planetId, builtIn.orbitSlot)!]]);
  const lost: StationRecord[] = [];
  const ordered = rest.sort((a, b) => byName(a.planetId, b.planetId) || a.orbitSlot - b.orbitSlot
    || byName(a.welcomeRoomId, b.welcomeRoomId) || byName(a.id, b.id));
  for (const r of ordered) {
    const slots = used(r.planetId);
    const free = Number.isInteger(r.orbitSlot) && r.orbitSlot >= 0 && r.orbitSlot < MAX_ORBIT_SLOTS
      && !slots.has(r.orbitSlot);
    if (free) { slots.add(r.orbitSlot); slotOf.set(r, r.orbitSlot); } else lost.push(r);
  }
  for (const r of lost) {
    const slot = claim(r.planetId, r.orbitSlot);
    if (slot !== null) slotOf.set(r, slot);
  }

  // Listed in record order. A record left without a slot (its planet is
  // full) is dropped, and its place is left to a derived station.
  const out: StationRecord[] = [];
  const places = new Set<string>();
  for (const r of kept) {
    const slot = slotOf.get(r);
    if (slot === undefined) continue;
    const place = placeOf(r.welcomeRoomId);
    if (place) places.add(place);
    out.push({ ...r, orbitSlot: slot });
  }

  // Atlas ids and names can arrive from peers unbounded, so derived records
  // get the same limits a saved record must meet: an over-long room id cannot
  // anchor a station, and names are cut to length.
  const derived: Array<{ anchor: string; name: string }> = [];
  components.forEach((component, i) => {
    if (places.has(`component:${i}`)) return;
    // Only a room the atlas holds an entry of its own for: a door may name a
    // room `constructor` or `__proto__`, and what that name inherits is no entry.
    const known = [...component]
      .filter((rid) => Object.prototype.hasOwnProperty.call(atlas, rid) && atlas[rid]
        && DERIVED_PREFIX.length + rid.length <= MAX_ID_LENGTH)
      .sort();
    const anchor = known[0];
    if (!anchor) return;
    // A room name is peer-written and not shape-checked on every path.
    const name: unknown = atlas[anchor].name;
    derived.push({ anchor, name: (typeof name === 'string' && name ? name : 'STATION').slice(0, MAX_NAME_LENGTH) });
  });
  derived.sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  for (const d of derived) {
    const slot = claim(DEFAULT_PLANET_ID, 0);
    if (slot === null) break;
    out.push({
      id: `${DERIVED_PREFIX}${d.anchor}`,
      name: d.name,
      planetId: DEFAULT_PLANET_ID,
      orbitSlot: slot,
      welcomeRoomId: d.anchor,
      derived: true,
    });
  }
  return out;
}

/** The stations orbiting one planet, in slot order. */
export function stationsAroundPlanet(planetId: string, stations: StationRecord[] = listStations()): StationRecord[] {
  return stations.filter((s) => s.planetId === planetId).sort((a, b) => a.orbitSlot - b.orbitSlot);
}

// ── Rooms the atlas cannot place ─────────────────────────────────────────────

let roomStationResolver: ((roomId: string) => string | null) | null = null;
let resolvingRoom = false;

/** Install (or remove, with null) a resolver that names the station a room is
 *  at when the atlas cannot say: a DOCKED SHIP. Its berth is not structure,
 *  so the atlas keeps the ship apart from the station it is docked at; ship
 *  travel knows the station its live dock leads into. stationForRoom — and so
 *  planetForRoom and currentStation — asks it first. A null answer, a station
 *  that is not listed, or a throw falls back to the atlas, and so does any
 *  lookup the resolver makes itself. */
export function setRoomStationResolver(resolver: ((roomId: string) => string | null) | null): void {
  roomStationResolver = resolver;
}

/** The station a room belongs to: the one the room-station resolver names,
 *  else the one whose welcome room shares the room's atlas component, or null
 *  when neither knows the room. */
export function stationForRoom(
  roomId: string,
  atlas: Record<string, AtlasEntry> = readAtlas(),
  stations: StationRecord[] = listStations(atlas),
): StationRecord | null {
  if (!roomId) return null;
  if (roomStationResolver && !resolvingRoom) {
    let id: string | null = null;
    resolvingRoom = true;
    try {
      id = roomStationResolver(roomId);
    } catch {
      id = null;
    } finally {
      resolvingRoom = false;
    }
    const placed = id ? stations.find((s) => s.id === id) : undefined;
    if (placed) return placed;
  }
  return atlasStationForRoom(roomId, atlas, stations);
}

/** What the atlas alone says: the station whose welcome room shares the
 *  room's component. */
function atlasStationForRoom(
  roomId: string,
  atlas: Record<string, AtlasEntry>,
  stations: StationRecord[],
): StationRecord | null {
  if (!roomId) return null;
  const direct = stations.find((s) => s.welcomeRoomId === roomId);
  if (direct) return direct;
  const component = atlasComponents(atlas).find((c) => c.has(roomId));
  if (!component) return null;
  return stations.find((s) => s.welcomeRoomId !== '' && component.has(s.welcomeRoomId)) ?? null;
}

/**
 * ⚓ The station a DOCKED module is at, read from its live door records — what
 * main.ts installs as the room-station resolver for the room the player is in.
 * Only a lone module moves: no structural (non-berth) pairing, live or in the
 * atlas, and no station of its own beyond the one derived from it. It is at
 * the station on the far side of one of its docks, when that side is a real
 * station — a saved or built-in record, or structure of more than one room —
 * so two lone modules docked together stay where they are, and a station
 * never moves to the ship visiting it. null: the atlas places the room.
 */
export function dockedStationFor(
  roomId: string,
  doors: Iterable<DoorRecord>,
  atlas: Record<string, AtlasEntry> = readAtlas(),
  stations: StationRecord[] = listStations(atlas),
): string | null {
  const own = atlasStationForRoom(roomId, atlas, stations);
  // Structure stays put whether or not it is listed: a full planet lists no
  // station for it, but its rooms still are not a lone module.
  if ((own && !own.derived) || atlasComponent(atlas, roomId).size > 1) return null;
  const partners: string[] = [];
  for (const rec of doors) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    // Only an address that names another room is a pairing (as
    // stationRoomCause reads it): peer-written junk, or a pairing back to
    // this room, neither bolts the room in nor hides a real dock.
    let partner = '';
    try { partner = roomIdFromSeed(rec.connectedRoomAddress); } catch { partner = ''; }
    if (!partner || partner === roomId) continue;
    if (!isBerthDoor(rec)) return null; // bolted into a station: the atlas places it
    partners.push(partner);
  }
  for (const partner of partners) {
    const there = atlasStationForRoom(partner, atlas, stations);
    if (!there || there.id === own?.id) continue;
    if (!there.derived || atlasComponent(atlas, there.welcomeRoomId).size > 1) return there.id;
  }
  return null;
}

/** Why a room is a station's own (stationRoomCause). */
export type StationRoomCause = 'welcome-room' | 'lone-station' | 'bolted';

/** Why `roomId` is a station's own room, never a ship that DEPARTs: a saved
 *  or built-in station's welcome room ('lone-station' when no gangway joins
 *  it to another module: a one-module station, which may still fly by hand
 *  and PARK), or a module bolted into a station by structure (a paired door
 *  that is no berth: taking that gangway down frees it). Null for a ship.
 *  Such a room may wear engine, tank and helm for station keeping. */
export function stationRoomCause(
  roomId: string,
  doors: Iterable<DoorRecord>,
  stations: StationRecord[] = listStations(),
): StationRoomCause | null {
  if (!roomId) return null;
  let bolted = false;
  for (const rec of doors) {
    if (rec.paired === true && !isBerthDoor(rec) && joinsAnotherRoom(rec.connectedRoomAddress, roomId)) {
      bolted = true;
      break;
    }
  }
  if (stations.some((st) => !st.derived && st.welcomeRoomId === roomId)) {
    return bolted ? 'welcome-room' : 'lone-station';
  }
  return bolted ? 'bolted' : null;
}

/** Does a pairing's address name another room, as the atlas reads it? One
 *  naming no room (a peer's junk, or one the parser throws on) or naming
 *  `roomId` itself joins it to none. */
function joinsAnotherRoom(address: string | undefined, roomId: string): boolean {
  if (!address) return false;
  try {
    const target = roomIdFromSeed(address);
    return target !== '' && target !== roomId;
  } catch {
    return false;
  }
}

/** Is `roomId` a station's own room (stationRoomCause)? */
export function isStationRoom(
  roomId: string,
  doors: Iterable<DoorRecord>,
  stations: StationRecord[] = listStations(),
): boolean {
  return stationRoomCause(roomId, doors, stations) !== null;
}

/** The planet a room's station orbits — the default planet when unknown. */
export function planetForRoom(roomId: string, atlas: Record<string, AtlasEntry> = readAtlas()): PlanetRecord {
  return planetById(stationForRoom(roomId, atlas)?.planetId);
}

// ── The current station ──────────────────────────────────────────────────────

let currentRoomGetter: () => string = () => '';

/** main.ts injects the room the player is standing in (no import cycle). */
export function setStationRoomSource(cb: () => string): void {
  currentRoomGetter = cb;
}

/** The room the player is standing in ('' before main.ts wires it). */
export function currentRoomId(): string {
  return currentRoomGetter();
}

/** The station the player is in now, or null before the atlas knows the room. */
export function currentStation(): StationRecord | null {
  return stationForRoom(currentRoomGetter());
}
