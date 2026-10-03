/**
 * 🕹️ Free flight (issue 203): a person at the helm flies the ship by hand,
 * with the keyboard or a joystick, and docks with AUTO-DOCK once close to a
 * station.
 *
 * Like every other flight here this is "a record, not a simulation"
 * (shipDoc.ts): the ship's pose is a plain record (FreePose) written when
 * the pilot changes what the ship is doing, and every viewer works out where
 * it is now from that record and the shared clock. Between writes the ship
 * COASTS, and coasting follows the project's circular-orbit rule rather than
 * full orbital mechanics (owner, 2026-09-27):
 *
 *   - In open space the ship holds a circular orbit at its own radius, plus
 *     whatever velocity the pilot has added on top of it: `vAlong` along the
 *     orbit (prograde +) and `vRadial` away from the planet (outward +). With
 *     both at zero it simply orbits, like a station.
 *   - Inside a station's APPROACH zone the ship is held in that station's
 *     frame instead (`near`): its velocity is relative to the station, so a
 *     ship that stops next to a station stays next to it.
 *
 * Everything lies in the planet's equatorial plane (PR 171), so a pose is
 * two-dimensional: a position, a velocity and a heading.
 *
 * Speed zones, not crash physics (the "Keep ships and stations from
 * colliding" answer, 2026-09-27; same rules for robots and people):
 *   - APPROACH zone (APPROACH_ZONE_KM): speed capped at APPROACH_MAX_KMS;
 *   - DOCKING zone (DOCK_ZONE_KM): a crawl (DOCK_MAX_KMS), and AUTO-DOCK;
 *   - HULL bubble (HULL_KM): the ship stops dead at its edge, no damage.
 * A ship that coasts into a zone is slowed to its cap at the boundary, the
 * same way on every client (coastTo samples the coast in short steps).
 *
 * Velocities are km per ORBITAL second (orbits.ts runs the clock 60× real
 * time), so a ship and the stations around it move on one clock.
 *
 * Pure: no doc, DOM or Three access (freeFlightPilot.ts holds the record,
 * the stick and the live pose).
 */

import { ORBIT_EPOCH_MS, orbitForSlot, orbitalSeconds, toPlanetFrame, wrapAngle } from './orbits';
import type { FramePoint, OrbitPoint } from './orbits';
import { MAX_ORBIT_SLOTS, planetById } from './stations';

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Zone radii around a station, km. */
export const APPROACH_ZONE_KM = 50;
export const DOCK_ZONE_KM = 2;
export const HULL_KM = 0.15;
/** Speed caps, km per orbital second (× 60 for km per real second). */
export const OPEN_MAX_KMS = 2;
export const APPROACH_MAX_KMS = 0.1;
export const DOCK_MAX_KMS = 0.01;
/** Full thrust reaches the zone's cap in about this many real seconds. */
export const SECONDS_TO_CAP = 1.6;
/** BRAKE stops the ship this much faster than thrust speeds it up. */
const BRAKE_FACTOR = 1.5;
/** Turn rate, radians per real second. */
export const YAW_RATE = Math.PI / 2;
/** Fuel per km/s of thrust. A Hohmann hop burns stationDirectory.FUEL_PER_KMS
 *  (40); flying by hand is cheaper per km/s, since a pilot burns twice (out
 *  and to stop) and the speed caps take speed off for free. */
export const FREE_FUEL_PER_KMS = 10;
/** Leaving the approach zone needs this much margin past its edge, so a ship
 *  on the line does not flip between frames. */
const LEAVE_MARGIN = 1.1;
/** Lowest altitude a free-flying ship may sink to, km. */
const MIN_ALTITUDE_KM = 150;
/** Highest orbit radius, as a multiple of the top slot's. */
const MAX_RADIUS_FACTOR = 1.1;
/** Where UNDOCK leaves the ship: this far behind the station it left, facing
 *  away from it. */
export const UNDOCK_OFFSET_KM = 0.3;
/** coastTo samples a coast this often (real ms) to catch a zone boundary. */
const COAST_STEP_MS = 100;
/** …at most this many times; a longer gap is jumped in one step. */
const COAST_MAX_STEPS = 600;

// ── Records ──────────────────────────────────────────────────────────────────

/** A free-flying ship at one moment. Plain JSON (it is written to the ship
 *  doc and shared in planet summaries). */
export interface FreePose {
  planetId: string;
  /** Real epoch ms the pose holds at (whole ms). */
  at: number;
  /** Where the ship is at `at`, from the planet's centre. Always kept, so a
   *  reader that does not know `near`'s station still places the ship. */
  radiusKm: number;
  angle: number;
  /** Velocity on top of the frame's own motion, km per orbital second. */
  vAlong: number;
  vRadial: number;
  /** Which way the nose points: radians from prograde, toward radial-out. */
  heading: number;
  /** Held in a station's frame (inside its approach zone): the station's
   *  welcome room and the ship's offset from it along its orbit and away
   *  from the planet, km. */
  near?: { room: string; along: number; radial: number };
  /** 🅿️ PARKED: still, in a steady orbit (its own circular one, or held
   *  beside a station), and kept there: no zone takes it up or slows it
   *  until the pilot thrusts again. */
  parked?: true;
}

/** A station a free-flying ship can meet: where it is at any time. */
export interface FreeStation {
  /** This install's station id (AUTO-DOCK flies the arrival to it). */
  id: string;
  /** Its welcome room, the portable name a pose's `near` holds. */
  room: string;
  name: string;
  pointAt: (ms: number) => OrbitPoint;
}

/** What the pilot asks for this frame, each in [−1, 1] (brake on or off). */
export interface StickInput {
  /** Forward (+) or back along the nose. */
  thrust: number;
  /** Right (+) or left, across the nose. */
  strafe: number;
  /** Turn right (+) or left. */
  yaw: number;
  brake: boolean;
}

export const NO_INPUT: StickInput = { thrust: 0, strafe: 0, yaw: 0, brake: false };

export type FreeZone = 'open' | 'approach' | 'dock';

const MAX_ID_LEN = 128;
/** How far ahead of this client's clock a pose's time may be: a pilot
 *  writes its own now, so only clock skew puts it ahead. A pose further on
 *  would hold the ship still until then. */
export const MAX_POSE_AHEAD_MS = 2 * 60_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Shape guard: a pose is peer-written (ship doc, planet summaries). Its
 *  time may be at most MAX_POSE_AHEAD_MS past `now`. */
export function isFreePose(v: unknown, now = Date.now()): v is FreePose {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<FreePose>;
  if (typeof p.planetId !== 'string' || p.planetId.length === 0 || p.planetId.length > MAX_ID_LEN) return false;
  if (!finite(p.at) || !Number.isSafeInteger(p.at) || p.at < 0 || p.at > now + MAX_POSE_AHEAD_MS) return false;
  if (!finite(p.radiusKm) || p.radiusKm <= 0 || p.radiusKm > 1e7) return false;
  if (!finite(p.angle) || !finite(p.heading)) return false;
  if (!finite(p.vAlong) || !finite(p.vRadial)) return false;
  // A peer could write any speed: one past the open-space cap is junk.
  if (Math.hypot(p.vAlong, p.vRadial) > OPEN_MAX_KMS * 1.001) return false;
  if (p.near !== undefined) {
    const n = p.near as Partial<NonNullable<FreePose['near']>>;
    if (typeof n !== 'object' || n === null) return false;
    if (typeof n.room !== 'string' || n.room.length === 0 || n.room.length > MAX_ID_LEN) return false;
    if (!finite(n.along) || !finite(n.radial)) return false;
    if (Math.hypot(n.along, n.radial) > APPROACH_ZONE_KM * LEAVE_MARGIN * 2) return false;
  }
  if (p.parked !== undefined && p.parked !== true) return false;
  return true;
}

/** A pose as it is written: plain fields only, angles folded, whole ms. */
export function cleanPose(p: FreePose): FreePose {
  const out: FreePose = {
    planetId: p.planetId,
    at: Math.round(p.at),
    radiusKm: p.radiusKm,
    angle: wrapAngle(p.angle),
    vAlong: p.vAlong,
    vRadial: p.vRadial,
    heading: wrapAngle(p.heading),
  };
  if (p.near) out.near = { room: p.near.room, along: p.near.along, radial: p.near.radial };
  if (p.parked === true) out.parked = true;
  return out;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Unit vectors of the local frame at orbit angle `angle`, in the planet
 *  frame (x, z): prograde (the way the orbit runs) and radial-out. */
function localAxes(angle: number): { pro: { x: number; z: number }; out: { x: number; z: number } } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // toPlanetFrame puts angle θ at (cos θ, −sin θ); d/dθ is (−sin θ, −cos θ).
  return { pro: { x: -s, z: -c }, out: { x: c, z: -s } };
}

function fromFrame(p: FramePoint): OrbitPoint {
  return { radiusKm: Math.hypot(p.x, p.z), angle: wrapAngle(Math.atan2(-p.z, p.x)) };
}

/** `target`'s offset from `from`, along `from`'s orbit and away from the
 *  planet, km. */
export function offsetFrom(from: OrbitPoint, target: OrbitPoint): { along: number; radial: number } {
  const a = toPlanetFrame(from);
  const b = toPlanetFrame(target);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const { pro, out } = localAxes(from.angle);
  return { along: dx * pro.x + dz * pro.z, radial: dx * out.x + dz * out.z };
}

/** The point `along`/`radial` km off `from` in `from`'s local frame. */
export function pointOff(from: OrbitPoint, along: number, radial: number): OrbitPoint {
  const a = toPlanetFrame(from);
  const { pro, out } = localAxes(from.angle);
  return fromFrame({ x: a.x + along * pro.x + radial * out.x, y: 0, z: a.z + along * pro.z + radial * out.z });
}

function radiusBounds(planetId: string): { min: number; max: number } {
  const planet = planetById(planetId);
  return {
    min: planet.radiusKm + MIN_ALTITUDE_KM,
    max: orbitForSlot(planet.id, MAX_ORBIT_SLOTS - 1).radiusKm * MAX_RADIUS_FACTOR,
  };
}

// ── Coasting (pure propagation, no zone rules) ──────────────────────────────

/**
 * Where a pose has coasted to by `ms`, with no zone rules applied: in a
 * station's frame when `near` names a station `stations` knows, else on its
 * own orbit. The result holds at `ms` (`at` rounded to whole ms).
 */
export function propagate(pose: FreePose, ms: number, stations: readonly FreeStation[]): FreePose {
  // Never backwards: a pose from a clock a little ahead holds until then.
  if (!(ms > pose.at)) return pose;
  const t = orbitalSeconds(ms) - orbitalSeconds(pose.at);
  if (pose.near) {
    const st = stations.find((s) => s.room === pose.near!.room);
    if (st) {
      const along = pose.near.along + pose.vAlong * t;
      const radial = pose.near.radial + pose.vRadial * t;
      const here = pointOff(st.pointAt(ms), along, radial);
      return { ...pose, at: Math.round(ms), radiusKm: here.radiusKm, angle: here.angle, near: { room: pose.near.room, along, radial } };
    }
  }
  const { near: _gone, ...open } = pose;
  return { ...open, ...openCoast(pose, t), at: Math.round(ms) };
}

/** Open-space coast over `t` orbital seconds: radius moves at vRadial (held
 *  inside the planet's bounds, where radial motion stops), and the angle
 *  turns at the circular rate for the radius plus vAlong. */
function openCoast(pose: FreePose, t: number): Pick<FreePose, 'radiusKm' | 'angle' | 'vRadial'> {
  if (t === 0) return { radiusKm: pose.radiusKm, angle: pose.angle, vRadial: pose.vRadial };
  const planet = planetById(pose.planetId);
  const { min, max } = radiusBounds(planet.id);
  const r0 = Math.min(max, Math.max(min, pose.radiusKm));
  const vr = pose.vRadial;
  // How long the radius may move before it meets a bound.
  const limit = vr > 0 ? (max - r0) / vr : vr < 0 ? (min - r0) / vr : Infinity;
  const tMove = Math.sign(t) * Math.min(Math.abs(t), Math.max(0, limit));
  const rate = (r: number) => Math.sqrt(planet.mu / r ** 3) + pose.vAlong / r;
  // Simpson's rule over the moving part (r is linear in time there).
  const n = 16;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
    sum += w * rate(r0 + vr * tMove * (i / n));
  }
  const r1 = r0 + vr * tMove;
  let angle = pose.angle + (tMove / (3 * n)) * sum;
  angle += rate(r1) * (t - tMove);
  const stopped = Math.abs(t) > Math.abs(tMove);
  return { radiusKm: r1, angle: wrapAngle(angle), vRadial: stopped ? 0 : vr };
}

// ── Zones ────────────────────────────────────────────────────────────────────

export interface Nearest {
  station: FreeStation;
  distanceKm: number;
  /** The station's offset from the ship, in the ship's local frame. */
  along: number;
  radial: number;
}

/** The station nearest the pose (by its place at the pose's time). */
export function nearestStation(pose: FreePose, stations: readonly FreeStation[]): Nearest | null {
  let best: Nearest | null = null;
  const here: OrbitPoint = { radiusKm: pose.radiusKm, angle: pose.angle };
  for (const station of stations) {
    const off = offsetFrom(here, station.pointAt(pose.at));
    const distanceKm = Math.hypot(off.along, off.radial);
    if (!best || distanceKm < best.distanceKm) best = { station, distanceKm, ...off };
  }
  return best;
}

export function zoneOf(distanceKm: number | null): FreeZone {
  if (distanceKm === null) return 'open';
  return distanceKm <= DOCK_ZONE_KM ? 'dock' : distanceKm <= APPROACH_ZONE_KM ? 'approach' : 'open';
}

export function speedCap(zone: FreeZone): number {
  return zone === 'dock' ? DOCK_MAX_KMS : zone === 'approach' ? APPROACH_MAX_KMS : OPEN_MAX_KMS;
}

export function speedOf(pose: Pick<FreePose, 'vAlong' | 'vRadial'>): number {
  return Math.hypot(pose.vAlong, pose.vRadial);
}

/** How fast a station turns about the planet at `ms`, radians per orbital
 *  second (from its own place a moment apart, so trims count). */
function turnRate(st: FreeStation, ms: number): number {
  const a = st.pointAt(ms).angle;
  const b = st.pointAt(ms + 1000).angle;
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d / orbitalSeconds(ORBIT_EPOCH_PLUS_1S);
}
/** One real second after the orbital epoch: orbitalSeconds of it is the
 *  orbital seconds in a real second. */
const ORBIT_EPOCH_PLUS_1S = ORBIT_EPOCH_MS + 1000;

/** The circular rate at a radius, radians per orbital second. */
function circularRate(planetId: string, radiusKm: number): number {
  return Math.sqrt(planetById(planetId).mu / radiusKm ** 3);
}

/**
 * Apply the zone rules to a pose at its own time: take up (or leave) the
 * nearest station's frame at the approach zone's edge, cap the speed for the
 * zone, and stop the ship dead at the hull bubble. `changed` says whether a
 * rule did anything (a pilot's game writes the pose then).
 */
export function applyZones(pose: FreePose, stations: readonly FreeStation[]): { pose: FreePose; changed: boolean } {
  // Parked: kept where it is (it is still, so no zone would slow it, and a
  // station passing by must not pick it up).
  if (pose.parked) return { pose, changed: false };
  let p = pose;
  let changed = false;
  const nearest = nearestStation(p, stations);
  if (p.near) {
    // Past the zone's edge (with a margin), or its station is gone: back on
    // the ship's own orbit.
    const held = stations.find((s) => s.room === p.near!.room);
    if (!held || Math.hypot(p.near.along, p.near.radial) > APPROACH_ZONE_KM * LEAVE_MARGIN) {
      const { near: _gone, ...open } = p;
      // Its speed along, from the station's frame to its own orbit's: the
      // same motion about the planet, told against another circular rate.
      const vAlong = held
        ? (turnRate(held, p.at) + p.vAlong / held.pointAt(p.at).radiusKm - circularRate(p.planetId, p.radiusKm)) * p.radiusKm
        : p.vAlong;
      p = { ...open, vAlong };
      changed = true;
    }
  }
  if (!p.near && nearest && nearest.distanceKm <= APPROACH_ZONE_KM) {
    // The ship's offset from the station, in the station's frame, and its
    // speed against the station's (a slow ship a station passes is passed,
    // not picked up).
    const st = nearest.station;
    const here = st.pointAt(p.at);
    const off = offsetFrom(here, { radiusKm: p.radiusKm, angle: p.angle });
    const ownRate = circularRate(p.planetId, p.radiusKm) + p.vAlong / p.radiusKm;
    p = { ...p, vAlong: (ownRate - turnRate(st, p.at)) * here.radiusKm, near: { room: st.room, along: off.along, radial: off.radial } };
    changed = true;
  }
  const distance = p.near ? Math.hypot(p.near.along, p.near.radial) : nearest?.distanceKm ?? null;
  const zone = p.near ? zoneOf(distance) : 'open';
  const cap = speedCap(zone);
  const speed = speedOf(p);
  if (speed > cap * 1.000001) {
    const k = cap / speed;
    p = { ...p, vAlong: p.vAlong * k, vRadial: p.vRadial * k };
    changed = true;
  }
  if (p.near && distance !== null && distance < HULL_KM) {
    // The hull bubble: the ship stops dead on its edge (no damage). Thrust
    // away from the station moves it off again (stepPilot thrusts after the
    // coast and before the zones, and only a ship still inside is stopped).
    const ux = distance > 1e-9 ? p.near.along / distance : -1;
    const uy = distance > 1e-9 ? p.near.radial / distance : 0;
    const along = ux * HULL_KM;
    const radial = uy * HULL_KM;
    const station = stations.find((s) => s.room === p.near!.room)!;
    const at = pointOff(station.pointAt(p.at), along, radial);
    const outward = p.vAlong * ux + p.vRadial * uy;
    p = {
      ...p,
      near: { room: p.near.room, along, radial },
      radiusKm: at.radiusKm,
      angle: at.angle,
      // Moving away already (a pilot backing off): keep that; else stop.
      vAlong: outward > 0 ? p.vAlong : 0,
      vRadial: outward > 0 ? p.vRadial : 0,
    };
    changed = true;
  }
  return { pose: p, changed };
}

/**
 * Coast a pose to `ms` with the zone rules applied on the way: the coast is
 * sampled every COAST_STEP_MS (at most COAST_MAX_STEPS times, then the rest
 * is one step), so a ship crossing a zone's edge is slowed there, the same
 * on every client. `changed` when any rule acted.
 */
export function coastTo(pose: FreePose, ms: number, stations: readonly FreeStation[]): { pose: FreePose; changed: boolean } {
  let p = pose;
  let changed = false;
  let steps = 0;
  while (p.at < ms) {
    const next = steps < COAST_MAX_STEPS ? Math.min(ms, p.at + COAST_STEP_MS) : ms;
    steps++;
    const moved = propagate(p, next, stations);
    const zoned = applyZones(moved, stations);
    // A frame the propagation dropped (its station is gone) is a change too.
    if (zoned.changed || (p.near && !moved.near)) changed = true;
    p = zoned.pose;
  }
  return { pose: p, changed };
}

// ── The stick ────────────────────────────────────────────────────────────────

export interface StepResult {
  pose: FreePose;
  /** Fuel the thrust burned this step (fractional). */
  fuelUsed: number;
  /** The zone rules acted (the ship slowed at a boundary, hit the bubble,
   *  or changed frame). */
  zoned: boolean;
}

/**
 * One frame of piloting: coast to `ms`, then turn and thrust for `dtS` real
 * seconds by `input`, then apply the zones. Thrust is refused with no fuel
 * (`fuel` is what the tanks hold); turning is free.
 */
export function stepPilot(
  pose: FreePose,
  input: StickInput,
  ms: number,
  dtS: number,
  stations: readonly FreeStation[],
  fuel: number,
): StepResult {
  const coasted = coastTo(pose, ms, stations);
  let p = coasted.pose;
  const dt = Math.max(0, Math.min(0.25, dtS));
  const clamp = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
  const yaw = clamp(input.yaw);
  if (yaw !== 0) p = { ...p, heading: wrapAngle(p.heading + yaw * YAW_RATE * dt) };
  const distance = p.near ? Math.hypot(p.near.along, p.near.radial) : null;
  const cap = speedCap(p.near ? zoneOf(distance) : 'open');
  const accel = (cap / SECONDS_TO_CAP) * dt;
  let fuelUsed = 0;
  let thrust = clamp(input.thrust);
  let strafe = clamp(input.strafe);
  const mag = Math.hypot(thrust, strafe);
  if (mag > 1) { thrust /= mag; strafe /= mag; }
  let dvA = 0;
  let dvR = 0;
  if (input.brake) {
    const speed = speedOf(p);
    const drop = Math.min(speed, accel * BRAKE_FACTOR);
    if (speed > 0) { dvA = (-p.vAlong / speed) * drop; dvR = (-p.vRadial / speed) * drop; }
  } else if (mag > 0) {
    const h = p.heading;
    // Nose (cos h, sin h); right of the nose (−sin h, cos h): along, radial.
    dvA = (thrust * Math.cos(h) - strafe * Math.sin(h)) * accel;
    dvR = (thrust * Math.sin(h) + strafe * Math.cos(h)) * accel;
  }
  const dv = Math.hypot(dvA, dvR);
  if (dv > 0) {
    const cost = dv * FREE_FUEL_PER_KMS;
    if (fuel > 0) {
      // The last of the tank buys only part of the burn.
      const k = cost > fuel ? fuel / cost : 1;
      p = { ...p, vAlong: p.vAlong + dvA * k, vRadial: p.vRadial + dvR * k };
      fuelUsed = cost * k;
    }
  }
  // Any thrust or brake takes the ship out of PARK (turning in place does not).
  if (p.parked && (mag > 0 || input.brake)) {
    const { parked: _off, ...flying } = p;
    p = flying;
  }
  const zoned = applyZones(p, stations);
  return { pose: zoned.pose, fuelUsed, zoned: coasted.changed || zoned.changed };
}

/** What PARK costs: the fuel to stop the ship dead, as a brake would. */
export function parkCost(pose: Pick<FreePose, 'vAlong' | 'vRadial'>): number {
  return speedOf(pose) * FREE_FUEL_PER_KMS;
}

/**
 * 🅿️ PARK: stop the ship dead where it is (paying parkCost) and keep it
 * there, in a steady orbit: its own circular orbit in open space, or held
 * beside the station whose approach zone it is in.
 */
export function parkPose(pose: FreePose): FreePose {
  return { ...pose, vAlong: 0, vRadial: 0, parked: true };
}

// ── Starting and reading ─────────────────────────────────────────────────────

/** The pose UNDOCK leaves a ship in: just behind the station it left (in
 *  its frame), still, facing away; or, leaving open orbit, there. */
export function undockPose(planetId: string, ms: number, from: FreeStation | OrbitPoint): FreePose {
  const at = Math.round(ms);
  if ('room' in from) {
    const here = pointOff(from.pointAt(at), -UNDOCK_OFFSET_KM, 0);
    return {
      planetId, at, radiusKm: here.radiusKm, angle: here.angle, vAlong: 0, vRadial: 0, heading: Math.PI,
      near: { room: from.room, along: -UNDOCK_OFFSET_KM, radial: 0 },
    };
  }
  return { planetId, at, radiusKm: from.radiusKm, angle: wrapAngle(from.angle), vAlong: 0, vRadial: 0, heading: 0 };
}

/** What the helm shows about a pose: the zone, the nearest station and
 *  whether AUTO-DOCK can take the ship in. */
export interface FreeReadout {
  zone: FreeZone;
  speedKms: number;
  altitudeKm: number;
  nearest: Nearest | null;
  /** The station AUTO-DOCK would dock at, or null. */
  dockAt: FreeStation | null;
  /** 🅿️ Parked, and where: beside a station (its name) or in open orbit. */
  parked: boolean;
  /** Fuel PARK takes now (to stop the ship dead). */
  parkFuel: number;
}

export function readout(pose: FreePose, stations: readonly FreeStation[]): FreeReadout {
  const nearest = nearestStation(pose, stations);
  const zone = zoneOf(nearest?.distanceKm ?? null);
  return {
    zone,
    speedKms: speedOf(pose),
    altitudeKm: pose.radiusKm - planetById(pose.planetId).radiusKm,
    nearest,
    dockAt: nearest && nearest.distanceKm <= DOCK_ZONE_KM ? nearest.station : null,
    parked: pose.parked === true,
    parkFuel: parkCost(pose),
  };
}

/** A pose's offset of `point` in the SHIP's body frame (nose up, right
 *  right), km: what the helm's radar plots. */
export function bodyOffset(pose: FreePose, point: OrbitPoint): { fwd: number; right: number } {
  const off = offsetFrom({ radiusKm: pose.radiusKm, angle: pose.angle }, point);
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  return { fwd: off.along * c + off.radial * s, right: -off.along * s + off.radial * c };
}

