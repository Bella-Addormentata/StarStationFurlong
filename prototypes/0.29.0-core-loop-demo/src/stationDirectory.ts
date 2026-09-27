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
import { planTransfer } from './orbits';

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
  /** The ship's OWN one-module station, when its room is listed as one (a
   *  module docked only by transient docks is its own atlas group) — never a
   *  destination. */
  own?(): string | null;
  /** When the hop from → to leaves and lands, and what it burns, asked at
   *  `nowMs`; null when there is no such hop. Absent ⇒ every hop leaves now
   *  and takes the destination's flat travelMs / fuelCost. */
  plan?(fromId: string, toId: string, nowMs: number): HopPlan | null;
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

/** Look a station up; unknown ids resolve to home (plan §2, item 4). */
export function findStation(id: string): StationDestination {
  const list = listStations();
  return list.find((s) => s.id === id) ?? list[0];
}

/** Is `id` a station the directory knows (no home fallback)? */
export function isKnownStation(id: string): boolean {
  return listStations().some((s) => s.id === id);
}

/** Plan the hop from → to at `nowMs`: the directory's own planner (orbits),
 *  else a flat hop that leaves now. Null for an unknown or unreachable pair. */
export function planHop(fromId: string, toId: string, nowMs: number): HopPlan | null {
  if (fromId === toId || !isKnownStation(toId)) return null;
  if (directory.plan) {
    const plan = directory.plan(fromId, toId, nowMs);
    if (!plan || !(plan.arriveAt > plan.departAt) || !Number.isFinite(plan.fuelCost)) return null;
    return plan;
  }
  const dest = findStation(toId);
  return { departAt: nowMs, arriveAt: nowMs + Math.max(1, dest.travelMs), fuelCost: dest.fuelCost };
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
  const own = directory.own?.() ?? null;
  return listStations().filter(
    (s) => s.planetId === from.planetId && s.id !== from.id && s.id !== here && s.id !== own,
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
  const t = planTransfer(from, to, nowMs);
  if (!t) return null;
  return {
    departAt: t.departAt,
    arriveAt: t.arriveAt,
    fuelCost: Math.max(1, Math.ceil(t.deltaVKmS * FUEL_PER_KMS)),
    windowEveryMs: t.synodicMs,
  };
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
    };
    // A public berth needs its door: DOCK only asks the far room (and so
    // only proves a port is there) when it knows the far door. Without one
    // the ship's own berth memory decides, or arrival reports no berth.
    const address = r.welcomeRoomId && r.berthDoor ? seedFor(r.welcomeRoomId) : undefined;
    if (address && r.berthDoor) out.berth = { address, farDoor: r.berthDoor };
    return out;
  });
}

/** A directory over the station record: `list` is stations.listStations,
 *  `hereId` the ship room's station (null when floating free); hops follow
 *  the circular-orbit model (orbits.ts). */
export function directoryFromStationRecords(
  list: () => readonly StationRecordLike[],
  seedFor: (roomId: string) => string | undefined,
  hereId: () => string | null,
  ownId: () => string | null = () => null,
): StationDirectory {
  return {
    stations: () => destinationsFromRecords(list(), seedFor),
    here: hereId,
    own: ownId,
    plan: (fromId, toId, nowMs) => {
      const records = list();
      return planRecordHop(
        records.find((r) => r.id === fromId),
        records.find((r) => r.id === toId),
        nowMs,
      );
    },
  };
}
