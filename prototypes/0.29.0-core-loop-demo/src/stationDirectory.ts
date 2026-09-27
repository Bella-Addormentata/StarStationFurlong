/**
 * 🛰️ Station directory — where a ship can fly (#30 SH3).
 *
 * The helm's DESTINATION picker and the flight record read stations through
 * this one small interface, so the source of truth can change without the
 * flight code noticing. Today it is a static table of stations around
 * SOVEREIGN II (spaceship-conversion-plan.md §5.2). The station record (each
 * station naming its planet and orbit) plugs in later through
 * setStationDirectory — nothing in shipDoc / devices reads the table directly.
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

/** The stations a ship at `fromId` may fly to: every OTHER station orbiting
 *  the same planet. */
export function destinationsFrom(fromId: string): StationDestination[] {
  const here = findStation(fromId);
  return listStations().filter((s) => s.planetId === here.planetId && s.id !== here.id);
}
