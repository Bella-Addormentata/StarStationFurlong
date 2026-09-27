/**
 * 🪐 Orbits — circular orbital mechanics for stations, and Hohmann transfers
 * for the ships flying between them (owner pick, 2026-09-27: "full orbital
 * mechanics, but as simplified as we can make it — stations in perfect
 * circular orbits").
 *
 * The simplifications, all at once:
 *  - every station orbit is a perfect CIRCLE, prograde, in the planet's
 *    equatorial plane — the whole system is 2D;
 *  - only the planet pulls (no moons, drag or perturbations);
 *  - a station's altitude comes from its orbit slot (stations.ts), and each
 *    slot sits SLOT_RADIUS_RATIO farther out than the one below — so no two
 *    stations around a planet share an orbit;
 *  - ships change orbit by HOHMANN TRANSFER: one burn onto half an ellipse,
 *    one burn to circularise. It is the cheapest two-burn transfer and it only
 *    meets the target station when it leaves at a LAUNCH WINDOW, so a ship
 *    waits for the next window (planTransfer says when) — the ferry timetable.
 *
 * Derive, don't tick: nothing here is stored or synced. A station's position
 * is a pure function of the clock (ORBIT_EPOCH_MS + ORBIT_TIME_SCALE), so every
 * client puts every station — and every ship on a known transfer — in the same
 * place at the same moment, within clock skew (the plan's accepted posture).
 *
 * STATION KEEPING: a station may fly a little off its slot's orbit — a TRIM
 * (a few km of radius, a nudge of phase) left by its station-keeping burns.
 * Whoever knows the trims installs a resolver (setStationTrimResolver), and
 * stationOrbit — with everything built on it: positions, headings, the frame,
 * transfers, the holotable — flies the trimmed orbit. orbitForSlot stays the
 * untrimmed slot orbit, the reference a trim is measured from.
 *
 * THE PLANET FRAME (owner question, 2026-09-27: keep each station's "down"
 * parallel to the planet's axis so ships stay on one flat plane around the
 * equator). One frame per planet, shared by every view:
 *  - origin at the planet's centre; +Y is the planet's NORTH, its rotation
 *    axis. Every room's own up (+Y in the scene) is parallel to it, so a
 *    station's down (−Y) points south along the axis, never at the planet;
 *  - the XZ plane is the EQUATOR, and every orbit and every transfer lies in
 *    it. Room floors are parallel to the plane everything flies in, so flying
 *    and docking only ever need yaw (rotation.y) — all the atlas, adapter and
 *    docking geometry uses already;
 *  - angles run from +X, positive = rotation about +Y (Three's rotation.y) =
 *    counter-clockwise seen from the north = prograde, the way the planet
 *    spins;
 *  - stations are PLANET-LOCKED, the usual attitude of a real station: each
 *    turns once per orbit so the planet stays put outside — straight off its
 *    local −X, level with the floor. Local +X points away from the planet,
 *    −Z along the direction of travel, +Z behind.
 *
 * Units: kilometres, radians, and ORBITAL seconds (the physics clock); every
 * `…Ms`/`…At` value is REAL milliseconds (what flight records and timers use).
 *
 * Pure: no DOM, no Three, no docs. Pinned by orbits.test.ts.
 */

import { planetById } from './stations';
import type { PlanetRecord, StationRecord } from './stations';

/** The orbital clock runs this many times faster than real time: one real
 *  second is one orbital minute. A low orbit (92 orbital minutes) goes round
 *  in about a minute and a half, and a hop between neighbouring stations
 *  takes about a minute — the plan's 60–120 s trip. */
export const ORBIT_TIME_SCALE = 60;

/** t = 0 of the orbital clock, shared by every client. */
export const ORBIT_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Altitude of orbit slot 0 — a low orbit, where Furlong sits. */
export const SLOT0_ALTITUDE_KM = 400;

/** Each slot's orbit radius is this many times the slot below's. Wide enough
 *  that neighbours drift apart quickly (a launch window every few minutes
 *  low down), narrow enough that the top slot (15) stays well inside the
 *  planet's pull (~190,000 km out for Sovereign II). */
export const SLOT_RADIUS_RATIO = 1.25;

/** Where slot 0 stood at the epoch — the angle the solar map always drew
 *  Furlong at — and the step between slots (the golden angle, so stations
 *  spread around the planet instead of lining up). */
const PHASE_SLOT0 = 2.1;
const PHASE_STEP = Math.PI * (3 - Math.sqrt(5));

const TAU = 2 * Math.PI;

/** Real ms either side of the time asked about within which a launch window
 *  counts as that time: floating-point rounding alone can move an exact
 *  window a hair off it. Rounding stays under a thousandth of a ms for a
 *  decade past the epoch, and asking 1 ms after a window still finds the
 *  next one. */
const WINDOW_ROUNDING_MS = 0.1;

/** An angle folded into [0, 2π). */
export function wrapAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Orbital seconds since the epoch at a real time. */
export function orbitalSeconds(realMs: number): number {
  return ((realMs - ORBIT_EPOCH_MS) / 1000) * ORBIT_TIME_SCALE;
}

/** A span of orbital seconds as real milliseconds. */
export function realMsFor(orbitalSpan: number): number {
  return (orbitalSpan / ORBIT_TIME_SCALE) * 1000;
}

/** A span of real milliseconds as orbital seconds. */
function orbitalSpanFor(realSpanMs: number): number {
  return (realSpanMs / 1000) * ORBIT_TIME_SCALE;
}

export interface CircularOrbit {
  planet: PlanetRecord;
  /** From the planet's centre. */
  radiusKm: number;
  altitudeKm: number;
  /** Orbital seconds per revolution. */
  periodS: number;
  speedKmS: number;
  /** Radians per orbital second. */
  meanMotion: number;
  /** Angle at the epoch, radians. */
  phase0: number;
}

/** A circular orbit of `radiusKm` (positive, from the planet's centre) at
 *  `phase0` radians at the epoch: period, speed and mean motion follow from
 *  the radius by Kepler. Every orbit here is built with it. */
export function circularOrbit(planet: PlanetRecord, radiusKm: number, phase0: number): CircularOrbit {
  const meanMotion = Math.sqrt(planet.mu / radiusKm ** 3);
  return {
    planet,
    radiusKm,
    altitudeKm: radiusKm - planet.radiusKm,
    periodS: TAU / meanMotion,
    speedKmS: Math.sqrt(planet.mu / radiusKm),
    meanMotion,
    phase0: wrapAngle(phase0),
  };
}

/** The circular orbit of a slot around a planet (unknown planet ⇒ default) —
 *  untrimmed, whatever station keeping says. */
export function orbitForSlot(planetId: string, slot: number): CircularOrbit {
  const planet = planetById(planetId);
  const s = Number.isFinite(slot) ? Math.max(0, Math.floor(slot)) : 0;
  const radiusKm = (planet.radiusKm + SLOT0_ALTITUDE_KM) * Math.pow(SLOT_RADIUS_RATIO, s);
  return circularOrbit(planet, radiusKm, PHASE_SLOT0 + s * PHASE_STEP);
}

// ── Station keeping: the trim seam ───────────────────────────────────────────

/** What the orbit helpers need to know about a station. A trim resolver finds
 *  the station by `id`; without one, the station flies its slot's orbit. */
export type OrbitingStation = Pick<StationRecord, 'planetId' | 'orbitSlot'> & { id?: string };

/** The orbit a station flies when station keeping has trimmed it off its
 *  slot's, or null for none. Only the radius and phase are read: stationOrbit
 *  rebuilds the rest around the slot's planet. */
export type StationTrimResolver = (
  station: OrbitingStation & { id: string },
  slotOrbit: CircularOrbit,
) => Pick<CircularOrbit, 'radiusKm' | 'phase0'> | null;

let trimResolver: StationTrimResolver | null = null;

/** Install the trim resolver, or remove it with null. Whoever shares station
 *  records (and so their trims) installs one; until then every station flies
 *  its slot's orbit. */
export function setStationTrimResolver(resolver: StationTrimResolver | null): void {
  trimResolver = resolver;
}

/** How far a trim may move a station from its slot's radius, as a fraction of
 *  that radius: a sanity bound well inside half the gap to either neighbouring
 *  slot (a tenth of the radius below, an eighth above), so a trimmed station
 *  always stays nearest its own slot. Station keeping holds a far tighter
 *  limit of its own. */
const MAX_TRIM_FRACTION = 0.05;

/** The orbit a station flies: its slot's, or the trimmed one the resolver
 *  gives. A resolver answer that throws, is not finite, or strays out of
 *  bounds is ignored. */
export function stationOrbit(station: OrbitingStation): CircularOrbit {
  const slot = orbitForSlot(station.planetId, station.orbitSlot);
  if (!trimResolver || typeof station.id !== 'string' || !station.id) return slot;
  let trim: Pick<CircularOrbit, 'radiusKm' | 'phase0'> | null;
  try {
    trim = trimResolver(station as OrbitingStation & { id: string }, slot);
  } catch {
    return slot;
  }
  if (!trim || !Number.isFinite(trim.radiusKm) || !Number.isFinite(trim.phase0)
    || Math.abs(trim.radiusKm - slot.radiusKm) > slot.radiusKm * MAX_TRIM_FRACTION) return slot;
  return circularOrbit(slot.planet, trim.radiusKm, trim.phase0);
}

/** Where on its orbit a body is at a real time (radians, [0, 2π)). */
export function angleAt(orbit: CircularOrbit, realMs: number): number {
  return wrapAngle(orbit.phase0 + orbit.meanMotion * orbitalSeconds(realMs));
}

/** A point in the planet's equatorial plane, planet-centred. */
export interface OrbitPoint {
  radiusKm: number;
  angle: number;
}

export function stationPointAt(station: OrbitingStation, realMs: number): OrbitPoint {
  const orbit = stationOrbit(station);
  return { radiusKm: orbit.radiusKm, angle: angleAt(orbit, realMs) };
}

// ── The planet frame (see the header) ────────────────────────────────────────

/** A position in 3D, km. */
export interface FramePoint {
  x: number;
  y: number;
  z: number;
}

/** An orbit point in the planet frame: on the equator, so y is always 0. */
export function toPlanetFrame(p: OrbitPoint): FramePoint {
  return { x: p.radiusKm * Math.cos(p.angle), y: 0, z: -p.radiusKm * Math.sin(p.angle) };
}

/** A planet-locked station's yaw in the planet frame — its rotation.y. It
 *  equals the station's orbit angle: at angle 0 its local axes line up with
 *  the planet frame's. */
export function stationHeadingAt(station: OrbitingStation, realMs: number): number {
  return stationPointAt(station, realMs).angle;
}

/**
 * Where something sits as seen from a station, in the station's own frame
 * (km; +Y up, same axes as its rooms). The planet's centre comes out at
 * (−r, 0, 0); a body just ahead in the same orbit at a small −z. This is what
 * a view from the station draws the planet and passing traffic with.
 */
export function inStationFrame(
  station: OrbitingStation,
  realMs: number,
  target: OrbitPoint | FramePoint,
): FramePoint {
  const here = stationPointAt(station, realMs);
  const origin = toPlanetFrame(here);
  const q = 'radiusKm' in target ? toPlanetFrame(target) : target;
  const dx = q.x - origin.x;
  const dz = q.z - origin.z;
  const c = Math.cos(here.angle);
  const s = Math.sin(here.angle);
  // Undo the station's yaw: rotate the offset by −heading about +Y.
  return { x: dx * c - dz * s, y: q.y - origin.y, z: dx * s + dz * c };
}

// ── Hohmann transfers ────────────────────────────────────────────────────────

export interface TransferPlan {
  fromId: string;
  toId: string;
  from: CircularOrbit;
  to: CircularOrbit;
  /** Real ms of the departure burn — the next launch window at or after the
   *  time asked about. */
  departAt: number;
  /** Real ms of the arrival burn, alongside the target station. */
  arriveAt: number;
  /** departAt − the time asked about. */
  waitMs: number;
  /** arriveAt − departAt: half the transfer ellipse. */
  transferMs: number;
  /** Both burns together, km/s — what fuel should be priced on. */
  deltaVKmS: number;
  /** Real ms between launch windows for this pair. */
  synodicMs: number;
}

/**
 * The next Hohmann transfer from one station to another at or after `nowMs`,
 * or null when there is none: the same station, stations around different
 * planets (interplanetary flight is not modelled), or a shared orbit.
 *
 * The window: the transfer takes tH, in which the target moves ω₂·tH, and the
 * ship arrives exactly opposite where it left — so the target must lead by
 * π − ω₂·tH at the burn. The lead changes at ω₂ − ω₁, which fixes the wait.
 */
export function planTransfer(
  from: Pick<StationRecord, 'id' | 'planetId' | 'orbitSlot'>,
  to: Pick<StationRecord, 'id' | 'planetId' | 'orbitSlot'>,
  nowMs: number,
): TransferPlan | null {
  if (from.id === to.id || planetById(from.planetId).id !== planetById(to.planetId).id) return null;
  const o1 = stationOrbit(from);
  const o2 = stationOrbit(to);
  const r1 = o1.radiusKm;
  const r2 = o2.radiusKm;
  if (r1 === r2) return null;
  const mu = o1.planet.mu;
  const a = (r1 + r2) / 2;
  const tH = Math.PI * Math.sqrt(a ** 3 / mu);
  const dv1 = Math.abs(Math.sqrt(mu / r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1));
  const dv2 = Math.abs(Math.sqrt(mu / r2) * (1 - Math.sqrt((2 * r1) / (r1 + r2))));

  const neededLead = wrapAngle(Math.PI - o2.meanMotion * tH);
  const leadNow = wrapAngle(angleAt(o2, nowMs) - angleAt(o1, nowMs));
  const drift = o2.meanMotion - o1.meanMotion; // rad/s the lead changes by
  const turn = drift > 0 ? wrapAngle(neededLead - leadNow) : wrapAngle(leadNow - neededLead);
  const synodicMs = realMsFor(TAU / Math.abs(drift));
  let waitMs = realMsFor(turn / Math.abs(drift));
  // Asked at a window's exact time, rounding can leave that window a hair
  // ahead, or a hair behind, where wrapping would wait a whole synodic period
  // for the next one. Either way it is the window being asked about.
  if (waitMs <= WINDOW_ROUNDING_MS || synodicMs - waitMs <= WINDOW_ROUNDING_MS) waitMs = 0;
  const transferMs = realMsFor(tH);
  const departAt = nowMs + waitMs;
  return {
    fromId: from.id,
    toId: to.id,
    from: o1,
    to: o2,
    departAt,
    arriveAt: departAt + transferMs,
    waitMs,
    transferMs,
    deltaVKmS: dv1 + dv2,
    synodicMs,
  };
}

/** Eccentric anomaly for a mean anomaly (Kepler's equation, Newton's method). */
export function solveKepler(meanAnomaly: number, e: number): number {
  let E = e > 0.8 ? Math.PI : meanAnomaly;
  for (let i = 0; i < 30; i++) {
    const step = (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
    E -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return E;
}

export type TransferLeg = 'waiting' | 'transfer' | 'arrived';

/**
 * Where a ship on a planned transfer is at a real time: with its origin
 * station until the departure burn, on the transfer ellipse between the
 * burns, and with the target station after arrival. Outbound transfers leave
 * from the ellipse's periapsis, inbound ones from its apoapsis; either way the
 * ship arrives opposite its departure point, where the target now is.
 */
export function transferPointAt(
  plan: TransferPlan,
  realMs: number,
): OrbitPoint & { leg: TransferLeg; speedKmS: number } {
  if (realMs <= plan.departAt) {
    return { radiusKm: plan.from.radiusKm, angle: angleAt(plan.from, realMs), leg: 'waiting', speedKmS: plan.from.speedKmS };
  }
  if (realMs >= plan.arriveAt) {
    return { radiusKm: plan.to.radiusKm, angle: angleAt(plan.to, realMs), leg: 'arrived', speedKmS: plan.to.speedKmS };
  }
  const r1 = plan.from.radiusKm;
  const r2 = plan.to.radiusKm;
  const a = (r1 + r2) / 2;
  const e = Math.abs(r2 - r1) / (r1 + r2);
  const n = Math.sqrt(plan.from.planet.mu / a ** 3);
  const outbound = r2 > r1;
  const departAngle = angleAt(plan.from, plan.departAt);
  const periapsisAngle = outbound ? departAngle : departAngle + Math.PI;
  const M = (outbound ? 0 : Math.PI) + n * orbitalSpanFor(realMs - plan.departAt);
  const E = solveKepler(M, e);
  const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const radiusKm = a * (1 - e * Math.cos(E));
  return {
    radiusKm,
    angle: wrapAngle(periapsisAngle + trueAnomaly),
    leg: 'transfer',
    speedKmS: Math.sqrt(plan.from.planet.mu * (2 / radiusKm - 1 / a)), // vis-viva
  };
}
