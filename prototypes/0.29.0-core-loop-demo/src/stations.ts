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

import { atlasComponents, readAtlas } from './stationAtlas';
import type { AtlasEntry } from './stationAtlas';
import { DEFAULT_STATION } from './defaultStation';

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
  /** Optional door id of the berth port in the welcome room. */
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
    && (r.berthDoor === undefined || typeof r.berthDoor === 'string');
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

function clean(r: StationRecord): StationRecord {
  return {
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
 *  left, or one whose welcome room is part of a station already listed. */
export function registerStation(record: Omit<StationRecord, 'derived'>): boolean {
  if (!isRecord(record) || record.id === DEFAULT_STATION_ID) return false;
  const records = readStationRecords();
  // Replace IN PLACE: slot clashes go to the earlier record, so moving a
  // renamed record to the back would swap it out of its slot.
  const at = records.findIndex((r) => r.id === record.id);
  if (at >= 0) records[at] = clean(record);
  else if (records.length >= MAX_RECORDS) return false;
  else records.push(clean(record));
  // Refuse a record the list would drop: its planet has no free slot, or its
  // welcome room already belongs to a listed station.
  if (!listStations(readAtlas(), records).some((s) => s.id === record.id)) return false;
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
 * dropped. Orbit slots are unique per planet — a record whose slot is taken
 * moves to the next free one, and derived stations fill free slots in anchor
 * order. This is the list ship destinations read from.
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
  const claim = (planetId: string, wanted: number): number | null => {
    const used = taken.get(planetId) ?? new Set<number>();
    taken.set(planetId, used);
    for (let i = 0; i < MAX_ORBIT_SLOTS; i++) {
      const slot = (wanted + i) % MAX_ORBIT_SLOTS;
      if (!used.has(slot)) { used.add(slot); return slot; }
    }
    return null;
  };

  const out: StationRecord[] = [];
  const places = new Set<string>();
  for (const r of [DEFAULT_STATION_RECORD, ...records]) {
    if (out.some((e) => e.id === r.id)) continue;
    const place = placeOf(r.welcomeRoomId);
    if (place && places.has(place)) continue;
    const slot = claim(r.planetId, r.orbitSlot);
    if (slot === null) continue;
    if (place) places.add(place);
    out.push({ ...r, orbitSlot: slot });
  }

  // Atlas ids and names can arrive from peers unbounded, so derived records
  // get the same limits a saved record must meet: an over-long room id cannot
  // anchor a station, and names are cut to length.
  const derived: Array<{ anchor: string; name: string }> = [];
  components.forEach((component, i) => {
    if (places.has(`component:${i}`)) return;
    const known = [...component]
      .filter((rid) => atlas[rid] && DERIVED_PREFIX.length + rid.length <= MAX_ID_LENGTH)
      .sort();
    const anchor = known[0];
    if (!anchor) return;
    derived.push({ anchor, name: (atlas[anchor].name || 'STATION').slice(0, MAX_NAME_LENGTH) });
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

/** The station a room belongs to: the one whose welcome room shares the
 *  room's atlas component, or null when the atlas does not know the room. */
export function stationForRoom(
  roomId: string,
  atlas: Record<string, AtlasEntry> = readAtlas(),
  stations: StationRecord[] = listStations(atlas),
): StationRecord | null {
  if (!roomId) return null;
  const direct = stations.find((s) => s.welcomeRoomId === roomId);
  if (direct) return direct;
  const component = atlasComponents(atlas).find((c) => c.has(roomId));
  if (!component) return null;
  return stations.find((s) => s.welcomeRoomId !== '' && component.has(s.welcomeRoomId)) ?? null;
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

/** The station the player is in now, or null before the atlas knows the room. */
export function currentStation(): StationRecord | null {
  return stationForRoom(currentRoomGetter());
}
