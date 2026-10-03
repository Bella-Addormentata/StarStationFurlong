/**
 * 🕹️ Free flight's live side (issue 203): the pose record in the ship doc,
 * the stations a free-flying ship can meet, and the pilot's own pose while
 * the stick is taken. The flight model itself is freeFlight.ts (pure).
 *
 * The record (`freeFlight` in the ship map, beside `flight`) is written by
 * the game whose player holds the stick: when the stick starts or stops
 * doing something, at most every WRITE_EVERY_MS while it is held, and when
 * a zone rule acts. Every other game in the room — and the planet summary —
 * coasts that record forward (coastTo), so all of them see the same ship.
 * A commander's game with nobody at the stick writes the coast back when a
 * zone rule acts on it (settleFreeCoast, from main.ts's 1 Hz flight watch).
 */

import {
  NO_INPUT,
  coastTo,
  isFreePose,
  cleanPose,
  stepPilot,
  undockPose,
} from './freeFlight';
import type { FreePose, FreeStation, StickInput } from './freeFlight';
import { orbitForSlot, angleAt, stationPointAt } from './orbits';
import { readStore } from './planetSummary';
import { readFlightRecord, readFuelLevel, shipDocHandle, writeFuelLevel } from './shipDoc';
import { adriftPlace, currentRoomId, listStations, planetById, stationInTransit } from './stations';

/** The ship map key the pose lives under (old clients never read it). */
const POSE_KEY = 'freeFlight';
/** A held stick writes the pose at most this often. */
export const WRITE_EVERY_MS = 500;
/** The station list is re-read this often (it walks the atlas). */
const STATIONS_EVERY_MS = 1000;

// ── The record ───────────────────────────────────────────────────────────────

/** The stored pose, or null (none, or malformed). */
export function readFreePose(): FreePose | null {
  const h = shipDocHandle();
  if (!h) return null;
  const v = h.map.get(POSE_KEY);
  return isFreePose(v) ? cleanPose(v) : null;
}

export function writeFreePose(pose: FreePose): boolean {
  const h = shipDocHandle();
  if (!h) return false;
  const clean = cleanPose(pose);
  if (!isFreePose(clean)) {
    console.warn('[free flight] refused to write a malformed pose', pose);
    return false;
  }
  h.doc.transact(() => h.map.set(POSE_KEY, clean));
  return true;
}

// ── The stations around ──────────────────────────────────────────────────────

let stationCache: { planetId: string; room: string; at: number; list: FreeStation[] } | null = null;

/**
 * The stations around `planetId` a free-flying ship can meet: listed, not
 * between planets, and not a ship (a ship's room is listed as its own
 * one-module station: this one's, and every ship the planet summary knows).
 */
export function freeStationsAround(planetId: string, now = Date.now()): FreeStation[] {
  const room = currentRoomId();
  const planet = planetById(planetId).id;
  if (stationCache && stationCache.planetId === planet && stationCache.room === room && now - stationCache.at < STATIONS_EVERY_MS) {
    return stationCache.list;
  }
  let ships: Set<string>;
  try {
    ships = new Set(Object.values(readStore(now).ships).filter((s) => !s.retired).map((s) => s.roomId));
  } catch {
    ships = new Set();
  }
  const list: FreeStation[] = listStations()
    .filter((s) => planetById(s.planetId).id === planet && !stationInTransit(s, now))
    .filter((s) => !!s.welcomeRoomId && s.welcomeRoomId !== room && !ships.has(s.welcomeRoomId))
    .map((s) => ({ id: s.id, room: s.welcomeRoomId, name: s.name, pointAt: (ms: number) => stationPointAt(s, ms) }));
  stationCache = { planetId: planet, room, at: now, list };
  return list;
}

/** The pose UNDOCK & FLY starts from, leaving `locationId` (a station, or
 *  open orbit), or null when that place is not known here. */
export function undockPoseFrom(locationId: string, now = Date.now()): FreePose | null {
  const station = listStations().find((s) => s.id === locationId);
  if (station) {
    const planetId = planetById(station.planetId).id;
    const known = freeStationsAround(planetId, now).find((s) => s.id === station.id);
    return undockPose(planetId, now, known ?? {
      id: station.id, room: station.welcomeRoomId, name: station.name, pointAt: (ms: number) => stationPointAt(station, ms),
    });
  }
  const adrift = adriftPlace(locationId);
  if (!adrift) return null;
  const planetId = planetById(adrift.planetId).id;
  const orbit = orbitForSlot(planetId, adrift.orbitSlot);
  return undockPose(planetId, now, { radiusKm: orbit.radiusKm, angle: angleAt(orbit, now) });
}

// ── The pilot (this game, stick taken) ───────────────────────────────────────

interface Live {
  pose: FreePose;
  /** When this game last wrote the pose. */
  writtenAt: number;
  /** The stick was doing something at the last frame. */
  active: boolean;
  /** Fuel burned but not yet taken off the tank (whole units go at a write). */
  owedFuel: number;
}

let live: Live | null = null;

/** Is this game flying the ship by its stick right now? */
export function isPilotingHere(): boolean {
  return live !== null;
}

/** The resolved record, cached so a reader each frame coasts on from where
 *  it was rather than from the record's own time. */
let coastCache: { key: string; pose: FreePose } | null = null;

/**
 * Where the free-flying ship is at `now`: the pilot's own pose in the game
 * holding the stick, else the record coasted forward. Null when the ship is
 * not in free flight or has no pose.
 */
export function resolvedFreePose(now = Date.now()): FreePose | null {
  if (live) {
    const stations = freeStationsAround(live.pose.planetId, now);
    return now > live.pose.at ? coastTo(live.pose, now, stations).pose : live.pose;
  }
  if (readFlightRecord().status !== 'free-flight') return null;
  const rec = readFreePose();
  if (!rec) return null;
  const key = JSON.stringify(rec);
  const from = coastCache && coastCache.key === key && coastCache.pose.at <= now ? coastCache.pose : rec;
  const pose = coastTo(from, now, freeStationsAround(rec.planetId, now)).pose;
  coastCache = { key, pose };
  return pose;
}

/**
 * One frame at the stick: step the pose by `input`, burn fuel for it, and
 * write the pose when the stick starts or stops, every WRITE_EVERY_MS while
 * it is held, and when a zone rule acts. `capacity` is the tanks' (for the
 * fuel write). Returns the pose now, or null when there is nothing to fly.
 */
export function pilotFrame(input: StickInput, dtS: number, capacity: number, now = Date.now()): FreePose | null {
  if (readFlightRecord().status !== 'free-flight') {
    live = null;
    return null;
  }
  if (!live) {
    const start = resolvedFreePose(now);
    if (!start) return null;
    live = { pose: start, writtenAt: 0, active: false, owedFuel: 0 };
  }
  const level = readFuelLevel(capacity);
  const stations = freeStationsAround(live.pose.planetId, now);
  const step = stepPilot(live.pose, input, now, dtS, stations, Math.max(0, level - live.owedFuel));
  const active = input.thrust !== 0 || input.strafe !== 0 || input.yaw !== 0 || input.brake;
  live.owedFuel += step.fuelUsed;
  live.pose = step.pose;
  const due = step.zoned || active !== live.active || (active && now - live.writtenAt >= WRITE_EVERY_MS);
  live.active = active;
  if (due) flushLive(capacity, now);
  return live.pose;
}

/** Write the pilot's pose (and the whole fuel it owes) now. */
function flushLive(capacity: number, now: number): void {
  if (!live) return;
  if (writeFreePose(live.pose)) live.writtenAt = now;
  const whole = Math.floor(live.owedFuel);
  if (whole >= 1 && capacity > 0) {
    writeFuelLevel(Math.max(0, readFuelLevel(capacity) - whole), capacity);
    live.owedFuel -= whole;
  }
}

/** Let go of the stick: the ship coasts on from the pose written now. */
export function releaseStick(capacity: number, now = Date.now()): void {
  if (!live) return;
  if (readFlightRecord().status === 'free-flight') {
    const stations = freeStationsAround(live.pose.planetId, now);
    live.pose = stepPilot(live.pose, NO_INPUT, now, 0, stations, 0).pose;
    // A part unit owed rounds up as the stick is let go: never free.
    live.owedFuel = Math.ceil(live.owedFuel - 1e-9);
    flushLive(capacity, now);
  }
  live = null;
}

/**
 * Nobody here holds the stick: coast the record to `now` and write it back
 * when a zone rule acted on the way (a ship drifting into an approach zone
 * is slowed at its edge for everyone). For a commander's game; a no-op
 * outside free flight.
 */
export function settleFreeCoast(now = Date.now()): boolean {
  if (live || readFlightRecord().status !== 'free-flight') return false;
  const rec = readFreePose();
  if (!rec || rec.at >= now) return false;
  const r = coastTo(rec, now, freeStationsAround(rec.planetId, now));
  return r.changed ? writeFreePose(r.pose) : false;
}

// ── Other ships flown by hand ────────────────────────────────────────────────

export interface RemoteFreeShip {
  roomId: string;
  name: string;
  /** Where it is at `ms`, coasted with the zone rules like this ship's own
   *  record (each from where it was last asked, so a frame costs little). */
  at: (ms: number) => FreePose;
}

/** How often the summary store is read again for other ships (it parses
 *  localStorage, too dear for every frame). */
const REMOTE_EVERY_MS = 1000;
let remoteCache: { planetId: string; room: string; at: number; ships: RemoteFreeShip[] } | null = null;
/** Each ship's last coast, by its room: kept while its summary's pose stays. */
const remoteCoasts = new Map<string, { key: string; pose: FreePose }>();

/** The other ships flown by hand around `planetId` that this client has
 *  heard of (planet summaries), never this room's own. */
export function remoteFreeShips(planetId: string, now = Date.now()): RemoteFreeShip[] {
  const room = currentRoomId();
  const planet = planetById(planetId).id;
  if (remoteCache && remoteCache.planetId === planet && remoteCache.room === room && now - remoteCache.at < REMOTE_EVERY_MS) {
    return remoteCache.ships;
  }
  const ships: RemoteFreeShip[] = [];
  const seen = new Set<string>();
  try {
    for (const ship of Object.values(readStore(now).ships)) {
      if (ship.retired || ship.roomId === room || ship.status !== 'free-flight' || !ship.free) continue;
      if (planetById(ship.free.planetId).id !== planet) continue;
      const rec = ship.free;
      const key = JSON.stringify(rec);
      seen.add(ship.roomId);
      ships.push({
        roomId: ship.roomId,
        name: ship.name,
        at: (ms) => {
          const known = remoteCoasts.get(ship.roomId);
          const from = known && known.key === key && known.pose.at <= ms ? known.pose : rec;
          const pose = coastTo(from, ms, freeStationsAround(rec.planetId, ms)).pose;
          remoteCoasts.set(ship.roomId, { key, pose });
          return pose;
        },
      });
    }
  } catch {
    /* the summary store is optional here */
  }
  for (const k of [...remoteCoasts.keys()]) if (!seen.has(k)) remoteCoasts.delete(k);
  remoteCache = { planetId: planet, room, at: now, ships };
  return ships;
}

/** For tests: forget the pilot and the caches. */
export function resetFreeFlightPilot(): void {
  live = null;
  coastCache = null;
  stationCache = null;
  remoteCache = null;
  remoteCoasts.clear();
}

/**
 * A saved or built-in station's own welcome room (not one derived from the
 * atlas, which is how a free ship's own room is listed): it is the station,
 * so it does not fly off as a ship. PR 172's stations.isStationRoom says the
 * same for DEPART once it reaches this branch.
 */
export function isStationOwnRoom(room = currentRoomId()): boolean {
  return !!room && listStations().some((s) => s.welcomeRoomId === room && !s.derived);
}
