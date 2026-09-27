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
}

/** The seam: whatever knows the stations. */
export interface StationDirectory {
  /** Every known station. The FIRST is home — where an unknown id resolves. */
  stations(): readonly StationDestination[];
  /** The station the ship's room belongs to right now — the one its docks
   *  lead into, or (floating free) the ship's own one-module "station" — or
   *  null when that is not known. Never a destination. */
  here?(): string | null;
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

/** Look a station up; unknown ids resolve to home (plan §2, item 4). */
export function findStation(id: string): StationDestination {
  const list = listStations();
  return list.find((s) => s.id === id) ?? list[0];
}

/** Is `id` a station the directory knows (no home fallback)? */
export function isKnownStation(id: string): boolean {
  return listStations().some((s) => s.id === id);
}

/** The station the ship's room belongs to right now, when the source knows. */
export function stationHere(): string | null {
  const id = directory.here?.() ?? null;
  return id && isKnownStation(id) ? id : null;
}

/** The stations a ship at `fromId` may fly to: every OTHER station orbiting
 *  the same planet (and never the one its room belongs to right now). */
export function destinationsFrom(fromId: string): StationDestination[] {
  const from = findStation(fromId);
  const here = stationHere();
  return listStations().filter((s) => s.planetId === from.planetId && s.id !== from.id && s.id !== here);
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
}

/** Fuel and time per orbit slot out from the planet — placeholder pricing
 *  until orbits carry real altitudes (the plan's "flat cost per hop"). */
export const FUEL_BASE = 20;
export const FUEL_PER_SLOT = 10;
export const TRAVEL_MS_PER_SLOT = 10_000;
export const TRAVEL_MS_MAX = 120_000;

/**
 * Turn station records into destinations. A station's berth is its welcome
 * room — dockable only when this client holds a seed for it (`seedFor`: the
 * atlas seed, or the build's own pass for the default station) — at its
 * berth door when one is named.
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
    };
    const address = r.welcomeRoomId ? seedFor(r.welcomeRoomId) : undefined;
    if (address) {
      out.berth = { address };
      if (r.berthDoor) out.berth.farDoor = r.berthDoor;
    }
    return out;
  });
}

/** A directory over the station record: `list` is stations.listStations,
 *  `hereId` the ship room's station (null when floating free). */
export function directoryFromStationRecords(
  list: () => readonly StationRecordLike[],
  seedFor: (roomId: string) => string | undefined,
  hereId: () => string | null,
): StationDirectory {
  return {
    stations: () => destinationsFromRecords(list(), seedFor),
    here: hereId,
  };
}
