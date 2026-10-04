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
 * zone rule acts on it, and at least every CHECKPOINT_MS (settleFreeCoast,
 * from main.ts's 1 Hz flight watch).
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
import { readFlightRecord, readFuelLevel, readStoredFuelLevel, shipDocHandle, writeFlightRecord, writeFuelLevel } from './shipDoc';
import { localStationId, portableStationId } from './stationDirectory';
import { isAbortedAltitudeChange } from './stationMove';
import { adriftPlace, currentRoomId, latestMoveOf, listStations, planetById, stationInTransit } from './stations';
import type { StationRecord } from './stations';

/** The ship map key the pose lives under (old clients never read it). */
const POSE_KEY = 'freeFlight';
/** A held stick writes the pose at most this often. */
export const WRITE_EVERY_MS = 500;
/** A commander's game writes a quiet coast back at least this often. */
export const CHECKPOINT_MS = 60_000;
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

// ── AUTO-DOCK's way back ─────────────────────────────────────────────────────

/** The ship map key AUTO-DOCK's way back lives under. */
const DOCK_MARK_KEY = 'freeDock';
/** A mark found on a freshly joined doc waits this long for the room's dock
 *  pairings to arrive before it reads a ship with no docked port as refused. */
export const FREE_DOCK_SETTLE_MS = 5000;

/** Where AUTO-DOCK flew in from: the record is `docked` at `stationId` before
 *  the far berth answers, so a refusal flies the ship on from here. */
export interface FreeDockMark {
  stationId: string;
  /** The free flight's locationId. */
  from: string;
  pose: FreePose;
  at: number;
}

function isDockMark(v: unknown): v is FreeDockMark {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.stationId === 'string' && m.stationId.length <= 256
    && typeof m.from === 'string' && m.from.length <= 256
    && typeof m.at === 'number' && Number.isFinite(m.at) && isFreePose(m.pose);
}

/** The berth answer this game is still waiting on (its doc, and the mark). */
let dockPending: { doc: unknown; at: number } | null = null;
/** When this game first saw the mark on the doc bound now. */
let markSeen: { doc: unknown; at: number; seenAt: number } | null = null;

/** Keep AUTO-DOCK's way back before it docks (this game now awaits the answer). */
export function markFreeDock(stationId: string, from: string, pose: FreePose, now = Date.now()): boolean {
  const h = shipDocHandle();
  if (!h) return false;
  // Station ids as the shared flight record carries them: every install
  // reads them back as its own (localStationId).
  const mark: FreeDockMark = { stationId: portableStationId(stationId), from: portableStationId(from), pose: cleanPose(pose), at: now };
  if (!isDockMark(mark)) return false;
  h.doc.transact(() => h.map.set(DOCK_MARK_KEY, mark));
  dockPending = { doc: h.doc, at: now };
  return true;
}

/** AUTO-DOCK docked: its way back is no longer needed. */
export function settleFreeDock(): void {
  dockPending = null;
  const h = shipDocHandle();
  if (h && h.map.get(DOCK_MARK_KEY) !== undefined) h.doc.transact(() => h.map.delete(DOCK_MARK_KEY));
}

/**
 * Fly on from AUTO-DOCK's mark when the dock did not happen: the ship reads
 * `docked` at the marked station (or in open orbit, where an arrival whose
 * station moved settles it) with no port docked, and no answer is still
 * due here (`answered`: this game's has just come; else the game that asked
 * left the room, and the pairings have had FREE_DOCK_SETTLE_MS to arrive).
 * A docked port, or a record that moved on, clears the mark. Returns whether
 * the ship flies free again.
 */
export function recoverFreeDock(
  ports: readonly { state: { kind: string } }[],
  now = Date.now(),
  answered = false,
): boolean {
  const h = shipDocHandle();
  if (!h) return false;
  const raw = h.map.get(DOCK_MARK_KEY);
  if (raw === undefined) return false;
  const clear = () => h.doc.transact(() => h.map.delete(DOCK_MARK_KEY));
  if (!isDockMark(raw)) { clear(); return false; }
  const rec = readFlightRecord();
  if (rec.status === 'redocking') return false;
  if (rec.status !== 'docked' || ports.some((p) => p.state.kind === 'docked')) { clear(); return false; }
  // Settled in open orbit (adriftPlace) instead: the station left, moved or
  // took off while the ship came in (shipArrival.completeArrival), so the
  // dock never happened and the ship flies on from its mark. Any other
  // place is another install's name for the station: not ours to judge
  // (this game's own answer settled somewhere else is).
  const settledAdrift = adriftPlace(rec.locationId) !== null;
  if (!settledAdrift && rec.locationId !== localStationId(raw.stationId)) { if (answered) { dockPending = null; clear(); } return false; }
  if (answered) {
    dockPending = null;
  } else {
    if (dockPending && dockPending.doc === h.doc && dockPending.at === raw.at) return false;
    if (!markSeen || markSeen.doc !== h.doc || markSeen.at !== raw.at) {
      markSeen = { doc: h.doc, at: raw.at, seenAt: now };
      return false;
    }
    if (now - markSeen.seenAt < FREE_DOCK_SETTLE_MS) return false;
  }
  if (!writeFreePose(raw.pose)) return false;
  if (!writeFlightRecord({ status: 'free-flight', locationId: localStationId(raw.from) })) return false;
  clear();
  return true;
}

// ── The stations around ──────────────────────────────────────────────────────

let stationCache: { planetId: string; room: string; at: number; list: FreeStation[] } | null = null;

/**
 * The stations around `planetId` a free-flying ship can meet: listed, not
 * between planets, and not a ship (a ship's room is listed as its own
 * derived one-module station: this one's, and every ship the planet summary
 * knows).
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
  // 🅿️ A one-module station flying by itself is a ship until it parks: it
  // holds no frame (a move of its own booked since ends that: PARK).
  const list: FreeStation[] = listStations()
    // Only a derived one-module stand-in is a ship; a saved or built-in
    // station keeps its zones whoever stands in it or claims its room,
    // unless it is flying free itself.
    .filter((s) => !!s.welcomeRoomId && !stationFlyingFree(s, now)
      && (!s.derived || (s.welcomeRoomId !== room && !ships.has(s.welcomeRoomId))))
    .flatMap((s) => {
      const st = timedStation(s, planet);
      return st ? [st] : [];
    });
  stationCache = { planetId: planet, room, at: now, list };
  return list;
}

/**
 * 🚚 A station as a free-flying ship meets it around `planet`, over time:
 * a coast replayed from an old pose meets it where it was then. With a
 * move (its latest), it is around on the planet it left until departure,
 * on the planet it reached from arrival, and nowhere in between (nor while
 * changing altitude); before departure it flies the orbit it left. Null
 * when it is never around this planet.
 */
function timedStation(s: StationRecord, planet: string): FreeStation | null {
  const base = { id: s.id, room: s.welcomeRoomId, name: s.name };
  // A pin stands for the move it settles; a cancel's pin, for none.
  const raw = latestMoveOf(s) ?? s.move ?? null;
  // 🎚️ An altitude change that lost its orbit to an earlier claim never
  // flies (the station list aborts it): the station stays where it is.
  const m = !raw || isAbortedAltitudeChange(raw) ? null : !raw.settles ? raw : raw.departAt < raw.settles.arriveAt ? null : raw.settles;
  const here = planetById(s.planetId).id === planet;
  if (!m) return here ? { ...base, pointAt: (ms: number) => stationPointAt(s, ms) } : null;
  const fromHere = planetById(m.fromPlanetId).id === planet;
  const toHere = planetById(m.toPlanetId).id === planet;
  if (!fromHere && !toHere) return null;
  // The orbit it left: an altitude change's own, else the custom orbit a
  // move recorded leaving (fromOrbit), else the slot it left.
  const fromOrbit = m.mode === 'orbit' && m.orbit
    ? { radiusKm: m.orbit.fromRadiusKm, phase0: m.orbit.fromPhase0 }
    : m.fromOrbit ? { radiusKm: m.fromOrbit.radiusKm, phase0: m.fromOrbit.phase0 } : undefined;
  const before: StationRecord = { ...s, planetId: m.fromPlanetId, orbitSlot: m.fromSlot, orbit: fromOrbit };
  return {
    ...base,
    // On the orbit it left up to and at its departure (the edge a coast
    // steps onto, carrying a held ship there before letting go).
    pointAt: (ms: number) => stationPointAt(ms <= m.departAt ? before : s, ms),
    presentAt: (ms: number) => (ms < m.departAt ? fromHere : ms >= m.arriveAt ? toHere : false),
    edges: [m.departAt, m.arriveAt],
  };
}

let flyingCache: { room: string; at: number; status: string; since: Map<string, number> } | null = null;

/** This game's memory of the rooms it has heard flying free (room → the
 *  newest such summary's time: its pose's own time when that is earlier), kept past the planet summaries' expiry and
 *  cap: a station's docks stay closed here until it is heard otherwise. */
const FLYING_KEY = 'ssf.freeFlight.flyingRooms.v1';
const MAX_FLYING_ROOMS = 64;
/** How long a room heard flying free is remembered once nothing more is
 *  heard of it. The summaries are peer-written (the dev-phase trust of the
 *  planet summaries): a false claim closes a station's docks here for at
 *  most this long, and any newer summary of its room, or a move of its own
 *  booked since, ends it sooner. */
export const FLYING_MEMORY_MS = 3 * 24 * 3600 * 1000;

function readFlyingMemory(now: number): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FLYING_KEY) ?? 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (out.size >= MAX_FLYING_ROOMS) break;
        if (k.length > 0 && k.length <= 256 && typeof v === 'number' && Number.isFinite(v) && now - v <= FLYING_MEMORY_MS) out.set(k, v);
      }
    }
  } catch {
    /* no storage here: the summaries alone */
  }
  return out;
}

function writeFlyingMemory(m: Map<string, number>): void {
  // Over the cap, the longest unheard go first.
  const kept = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_FLYING_ROOMS);
  try {
    localStorage.setItem(FLYING_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* quota or no storage */
  }
}

/**
 * 🅿️ The rooms flying free now, each with when it was last heard so: this
 * room when its flight record says so, and every one the planet summaries
 * say is, remembered (FLYING_KEY) until a newer summary of that room says
 * otherwise, so a summary that expires or is crowded out never reopens a
 * flying station's docks. A station whose welcome room is among them is
 * flying by itself (Fly and park) until it parks: no DEPART, route or
 * arrival takes it as a destination meanwhile.
 */
function flyingSince(now: number): Map<string, number> {
  const room = currentRoomId();
  const status = readFlightRecord().status;
  if (flyingCache && flyingCache.room === room && flyingCache.status === status && now - flyingCache.at < STATIONS_EVERY_MS) {
    return flyingCache.since;
  }
  const since = readFlyingMemory(now);
  let dirty = false;
  try {
    for (const s of Object.values(readStore(now).ships)) {
      const known = since.get(s.roomId);
      if (!s.retired && s.status === 'free-flight') {
        // Heard flying as of its pose's own time when it carries one: the
        // flying room's clock, the one its PARK move is booked by
        // (stationFlyingFree), where the summary's stamp may run hours ahead.
        const heard = s.free ? Math.min(s.updatedAt, s.free.at) : s.updatedAt;
        if (known === undefined || heard > known) { since.set(s.roomId, heard); dirty = true; }
      } else if (known !== undefined && s.updatedAt > known) {
        since.delete(s.roomId);
        dirty = true;
      }
    }
  } catch {
    /* the summary store is optional here */
  }
  // This room's own record is first-hand.
  if (room && status === 'free-flight') {
    // Kept fresh (hourly) while it flies, so it never lapses first-hand.
    const known = since.get(room);
    if (known === undefined || now - known > 3600_000) { since.set(room, now); dirty = true; }
  } else if (room && since.delete(room)) {
    dirty = true;
  }
  if (dirty) writeFlyingMemory(since);
  flyingCache = { room, at: now, status, since };
  return since;
}

/** 🅿️ The rooms flying free now (flyingSince). */
export function flyingFreeRooms(now = Date.now()): Set<string> {
  return new Set(flyingSince(now).keys());
}

/** 🅿️ Is this station flying by itself now (its docks closed)? Not once a
 *  move of its own was booked since it was last heard flying: PARK books
 *  one (freeStation.planStationPark). */
export function stationFlyingFree(station: { id?: string; welcomeRoomId?: string } | null | undefined, now = Date.now()): boolean {
  const room = station?.welcomeRoomId;
  if (!room) return false;
  const since = flyingSince(now).get(room);
  if (since === undefined) return false;
  if (room === currentRoomId()) return true;
  const move = latestMoveOf({ id: station.id ?? '', welcomeRoomId: room });
  return !(move && (move.bookedAt ?? move.departAt) >= since);
}

/** The pose UNDOCK & FLY starts from, leaving `locationId` (a station, or
 *  open orbit), or null when that place is not known here. */
export function undockPoseFrom(locationId: string, now = Date.now()): FreePose | null {
  const station = listStations().find((s) => s.id === locationId);
  // Between planets it is on no orbit here to fly off from (DEPART waits too).
  if (station && stationInTransit(station, now)) return null;
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
  /** The ship doc it flies (a room change rebinds the doc: the stick, its
   *  pose and the fuel it owes are that ship's alone). */
  doc: object;
  pose: FreePose;
  /** When this game last wrote the pose. */
  writtenAt: number;
  /** The stick was doing something at the last frame. */
  active: boolean;
  /** Fuel burned but not yet taken off the tank (whole units go at a write). */
  owedFuel: number;
}

let live: Live | null = null;

/** The live stick, if it flies the ship doc bound now; one left from
 *  another ship is dropped (nothing of it is written to this one). */
function liveHere(): Live | null {
  if (live && live.doc !== shipDocHandle()?.doc) live = null;
  return live;
}

/** Is this game flying the ship by its stick right now? */
export function isPilotingHere(): boolean {
  return liveHere() !== null;
}

/** What a cached coast depends on: the record, and the stations it met
 *  (each where it was at the record's time, and when it comes or goes:
 *  edges), so a station learned, lost or moved restarts the coast from the
 *  record, as a fresh reader would. */
function coastKey(rec: FreePose, stations: readonly FreeStation[]): string {
  const where = stations.map((s) => {
    const p = s.pointAt(rec.at);
    return `${s.room}@${p.radiusKm.toFixed(6)},${p.angle.toFixed(9)}~${(s.edges ?? []).join(',')}`;
  });
  return `${JSON.stringify(rec)}|${where.join(';')}`;
}

/** The resolved record, cached so a reader each frame coasts on from where
 *  it was rather than from the record's own time (always from a grid step
 *  of coastGrid, so every reader meets a boundary at the same moment). */
let coastCache: { key: string; pose: FreePose } | null = null;

/**
 * Where the free-flying ship is at `now`: the pilot's own pose in the game
 * holding the stick, else the record coasted forward. Null when the ship is
 * not in free flight or has no pose.
 */
export function resolvedFreePose(now = Date.now()): FreePose | null {
  if (liveHere() && live) {
    const stations = freeStationsAround(live.pose.planetId, now);
    return now > live.pose.at ? coastTo(live.pose, now, stations).pose : live.pose;
  }
  if (readFlightRecord().status !== 'free-flight') return null;
  const rec = readFreePose();
  if (!rec) return null;
  const stations = freeStationsAround(rec.planetId, now);
  const key = coastKey(rec, stations);
  const from = coastCache && coastCache.key === key && coastCache.pose.at <= now ? coastCache.pose : rec;
  const r = coastTo(from, now, stations);
  coastCache = { key, pose: r.grid };
  return r.pose;
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
  if (!liveHere()) {
    const start = resolvedFreePose(now);
    const h = shipDocHandle();
    if (!start || !h) return null;
    live = { doc: h.doc, pose: start, writtenAt: 0, active: false, owedFuel: 0 };
  }
  if (!live) return null;
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
  payOwedFuel(capacity);
}

/** Take the whole units of fuel the live stick owes out of the tanks. */
function payOwedFuel(capacity: number): void {
  if (!live) return;
  const whole = Math.floor(live.owedFuel);
  if (whole >= 1) {
    // With no tank fitted any more (the last one taken out mid-flight), the
    // burn still comes out of the level kept for when one is fitted again.
    const cap = capacity > 0 ? capacity : readStoredFuelLevel();
    writeFuelLevel(Math.max(0, readFuelLevel(cap) - whole), cap);
    live.owedFuel -= whole;
  }
}

/** Let go of the stick: the ship coasts on from the pose written now. */
export function releaseStick(capacity: number, now = Date.now()): void {
  if (!liveHere() || !live) return;
  // A part unit owed rounds up as the stick is let go: never free, even
  // when another commander's game moved the flight on meanwhile.
  live.owedFuel = Math.ceil(live.owedFuel - 1e-9);
  if (readFlightRecord().status === 'free-flight') {
    const stations = freeStationsAround(live.pose.planetId, now);
    live.pose = stepPilot(live.pose, NO_INPUT, now, 0, stations, 0).pose;
    flushLive(capacity, now);
  } else {
    payOwedFuel(capacity);
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
  if (liveHere() || readFlightRecord().status !== 'free-flight') return false;
  const rec = readFreePose();
  if (!rec || rec.at >= now) return false;
  const r = coastTo(rec, now, freeStationsAround(rec.planetId, now));
  // A quiet coast is checkpointed too, so no reader coasts far from it.
  const stale = now - rec.at >= CHECKPOINT_MS;
  return r.changed || stale ? writeFreePose(r.pose) : false;
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
      seen.add(ship.roomId);
      ships.push({
        roomId: ship.roomId,
        name: ship.name,
        at: (ms) => {
          const stations = freeStationsAround(rec.planetId, ms);
          const k = coastKey(rec, stations);
          const known = remoteCoasts.get(ship.roomId);
          const from = known && known.key === k && known.pose.at <= ms ? known.pose : rec;
          const r = coastTo(from, ms, stations);
          remoteCoasts.set(ship.roomId, { key: k, pose: r.grid });
          return r.pose;
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
  flyingCache = null;
  dockPending = null;
  markSeen = null;
  remoteCache = null;
  remoteCoasts.clear();
}

/**
 * A saved or built-in station's own welcome room (not one derived from the
 * atlas, which is how a free ship's own room is listed): it is the station.
 * It flies by itself only standing alone (🅿️ Fly and park), never on DEPART
 * (PR 172's stations.isStationRoom).
 */
export function isStationOwnRoom(room = currentRoomId()): boolean {
  return ownStationOf(room) !== null;
}

/** 🅿️ The saved or built-in station whose welcome room `room` is, or null. */
export function ownStationOf(room = currentRoomId()): StationRecord | null {
  if (!room) return null;
  return listStations().find((s) => s.welcomeRoomId === room && !s.derived) ?? null;
}

/** The ship map key a parked station's claim lives under. */
const PARK_MARK_KEY = 'freePark';

/** 🅿️ A station's PARK, kept until its orbit claim is settled for good: the
 *  pose it stopped at, and the move that claims the orbit through it. */
interface StationParkMark {
  pose: FreePose;
  bookedAt: number;
  toRadiusKm: number;
}

function isParkMark(v: unknown): v is StationParkMark {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.bookedAt === 'number' && Number.isFinite(m.bookedAt)
    && typeof m.toRadiusKm === 'number' && Number.isFinite(m.toRadiusKm) && m.toRadiusKm > 0 && isFreePose(m.pose);
}

/** 🅿️ Keep a station's PARK (the parked pose and its orbit move) so a claim
 *  that loses can put it back in flight (keepStationPark). */
export function markStationPark(pose: FreePose, move: { bookedAt?: number; departAt: number; orbit?: { toRadiusKm: number } }): boolean {
  const h = shipDocHandle();
  if (!h || !move.orbit) return false;
  const mark: StationParkMark = { pose: cleanPose(pose), bookedAt: move.bookedAt ?? move.departAt, toRadiusKm: move.orbit.toRadiusKm };
  if (!isParkMark(mark)) return false;
  h.doc.transact(() => h.map.set(PARK_MARK_KEY, mark));
  return true;
}

/**
 * 🅿️ A parked station whose orbit claim lost to an earlier one (another
 * station's altitude change or PARK within MIN_ORBIT_SEPARATION_KM:
 * stations.lostAltitudeClaims) is not left on the unflown leg's orbit
 * listStations falls back to: it flies again, still, where it parked, its
 * docks closed until it parks somewhere clear; so too when the PARK move
 * never became the station's latest (an older move still ranks first).
 * Run from the flight watch (a claim can lose late, when the earlier one is
 * heard). A newer move of
 * the station, or its flying again, retires the mark. Returns whether the
 * station flies again.
 */
export function keepStationPark(now = Date.now()): boolean {
  const h = shipDocHandle();
  if (!h) return false;
  const raw = h.map.get(PARK_MARK_KEY);
  if (raw === undefined) return false;
  const clear = () => h.doc.transact(() => h.map.delete(PARK_MARK_KEY));
  if (!isParkMark(raw)) { clear(); return false; }
  if (readFlightRecord().status !== 'docked') { clear(); return false; }
  const station = ownStationOf();
  if (!station) return false;
  const move = latestMoveOf(station);
  const booked = move ? move.bookedAt ?? move.departAt : -Infinity;
  // A move booked since PARK: the station has moved on from it.
  if (booked > raw.bookedAt) { clear(); return false; }
  // Still holding the orbit it claimed. (An older move that still ranks
  // first, say a cancelled move's pin at its future departure, means the
  // PARK never stood: it flies on, as for a lost claim.)
  if (booked === raw.bookedAt && station.orbit && Math.abs(station.orbit.radiusKm - raw.toRadiusKm) < 1e-6) return false;
  void now;
  if (!writeFreePose(raw.pose)) return false;
  if (!writeFlightRecord({ status: 'free-flight', locationId: station.id })) return false;
  clear();
  return true;
}

/** 🅿️ Where a one-module station starts flying by itself: where it is,
 *  still, in its own open orbit (it is held by no frame: its own is the one
 *  it leaves), nose prograde. */
export function stationUndockPose(station: StationRecord, now = Date.now()): FreePose {
  const p = stationPointAt(station, now);
  return { planetId: planetById(station.planetId).id, at: Math.round(now), radiusKm: p.radiusKm, angle: p.angle, vAlong: 0, vRadial: 0, heading: 0 };
}
