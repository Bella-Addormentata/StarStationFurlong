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
}

export const PLANETS: readonly PlanetRecord[] = [
  { id: 'planet-sovereign', name: 'SOVEREIGN II', color: 0x2a5a8f, emissive: 0x0c2038, atmosphere: 0x7fb8ff },
  { id: 'planet-aris', name: 'ARIS PRIME', color: 0x8a3a1c, emissive: 0x3a0e04, atmosphere: 0xff9a66 },
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
  /** 0-based slot around the planet — unique per planet in listStations. */
  orbitSlot: number;
  /** The room a docking ship berths at. '' when unknown (a build shipping no
   *  default station). */
  welcomeRoomId: string;
  /** Optional door id of the berth port in the welcome room. */
  berthDoor?: string;
  /** Set on stations derived from an atlas component with no record. */
  derived?: true;
}

/** Slots per planet — a sanity bound, not a gameplay rule. */
export const MAX_ORBIT_SLOTS = 32;

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

function isRecord(v: unknown): v is StationRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 128
    && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 64
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
 *  for an invalid record, one that would shadow the built-in default, or one
 *  whose planet has no free orbit slot left. */
export function registerStation(record: Omit<StationRecord, 'derived'>): boolean {
  if (!isRecord(record) || record.id === DEFAULT_STATION_ID) return false;
  const records = readStationRecords().filter((r) => r.id !== record.id);
  if (records.length >= MAX_RECORDS) return false;
  records.push(clean(record));
  // Refuse a record the list would drop because its planet has no free slot.
  if (!listStations({}, records).some((s) => s.id === record.id)) return false;
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
 * one derived station per unclaimed atlas component. Orbit slots are unique
 * per planet — a record whose slot is taken moves to the next free one, and
 * derived stations fill free slots in anchor order. This is the list ship
 * destinations read from.
 */
export function listStations(
  atlas: Record<string, AtlasEntry> = readAtlas(),
  records: StationRecord[] = readStationRecords(),
): StationRecord[] {
  const explicit: StationRecord[] = [DEFAULT_STATION_RECORD];
  for (const r of records) {
    if (!explicit.some((e) => e.id === r.id)) explicit.push({ ...r });
  }

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
  for (const r of explicit) {
    const slot = claim(r.planetId, r.orbitSlot);
    if (slot !== null) out.push({ ...r, orbitSlot: slot });
  }

  const claimedRooms = new Set(out.map((r) => r.welcomeRoomId).filter(Boolean));
  const derived: Array<{ anchor: string; name: string }> = [];
  for (const component of atlasComponents(atlas)) {
    if ([...component].some((rid) => claimedRooms.has(rid))) continue;
    const known = [...component].filter((rid) => atlas[rid]).sort();
    const anchor = known[0];
    if (!anchor) continue;
    derived.push({ anchor, name: atlas[anchor].name || 'STATION' });
  }
  derived.sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  for (const d of derived) {
    const slot = claim(DEFAULT_PLANET_ID, 0);
    if (slot === null) break;
    out.push({
      id: `station:${d.anchor}`,
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
