/**
 * 🔭 Far orbits — where the distant view outside the station puts things
 * (owner ask, 2026-09-27: keep the isometric station, and show the other
 * stations, ships and modules in orbit "in a non isometric fashion that
 * displays their orbit accurately in the distance").
 *
 * The exterior view draws the station itself isometrically, as always.
 * Behind it farOrbitView.ts renders a PERSPECTIVE backdrop: the planet, every
 * known station's orbit ring, the other stations and the ships flying between
 * them. This module is that backdrop's geometry — pure, no Three, no docs.
 *
 * What is accurate and what is not (defaults taken 2026-09-27, both open to
 * the owner): ANGLES are exact — every body sits at its true orbital angle on
 * the shared clock (orbits.ts), every ring is a true circle about the planet's
 * centre, every transfer follows its true ellipse, and the planet is drawn at
 * its true size. ALTITUDES are compressed: at true scale the next ring out is
 * ~1,700 km away and a station there is far below a pixel, so each altitude
 * is mapped through a log (`compressAltitudeKm`) that keeps every ring in
 * order and clear of the planet while fitting all sixteen slots into view.
 * Distant stations are drawn as one box per module at a fixed screen size.
 *
 * The frame is orbits.ts's planet frame (+Y north, the equator in XZ, angles
 * from +X counter-clockwise seen from the north), with every radius
 * compressed. The viewer is planet-locked like a station: the far view is
 * seen from the viewer's own frame, planet off −X, travel toward −Z — the
 * same axes as the rooms, so the backdrop turns with the isometric camera.
 *
 * A station moving between planets (stationMove.ts) is in the SUN's frame
 * instead: `transitLayout` puts the sun off −X, both planets on their true
 * angles and the station's course between them.
 */

import { toPlanetFrame } from './orbits';
import type { FramePoint, OrbitPoint, TransferPlan } from './orbits';
import { transferPointAt } from './orbits';
import { AU_KM, planetSunPointAt } from './solarOrbits';
import { PLANETS, planetById } from './stations';
import type { PlanetRecord, StationMove } from './stations';
import { moveTransitPointAt } from './stationMove';

// ── Compression ──────────────────────────────────────────────────────────────

/** Altitude where the log compression bends, km. Below it altitudes stay
 *  nearly true; slot 0 (400 km) lands at ~277, slot 15 (~184,000 km) at
 *  ~2,450, so every slot fits in a view framed on a 6,371 km planet. */
export const ALTITUDE_KNEE_KM = 400;

/** An altitude above the surface, compressed (monotonic, 0 → 0). */
export function compressAltitudeKm(altitudeKm: number): number {
  return ALTITUDE_KNEE_KM * Math.log1p(Math.max(0, altitudeKm) / ALTITUDE_KNEE_KM);
}

/** An orbit radius from the planet's centre, with its altitude compressed. */
export function compressRadiusKm(radiusKm: number, planet: Pick<PlanetRecord, 'radiusKm'>): number {
  return planet.radiusKm + compressAltitudeKm(radiusKm - planet.radiusKm);
}

/** An orbit point around a planet with its altitude compressed. */
export function compressPlanetPoint(p: OrbitPoint, planet: Pick<PlanetRecord, 'radiusKm'>): OrbitPoint {
  return { radiusKm: compressRadiusKm(p.radiusKm, planet), angle: p.angle };
}

/** Sun-centred distances: the same idea at solar scale. 1 AU lands at ~7,170
 *  units, so a planet sits about as far from the sun as the planet view's
 *  camera sits from its planet. */
export const SUN_SCALE_UNITS = 4000;
export const SUN_KNEE_KM = 0.2 * AU_KM;

export function compressSunPoint(p: OrbitPoint): OrbitPoint {
  return { radiusKm: SUN_SCALE_UNITS * Math.log1p(Math.max(0, p.radiusKm) / SUN_KNEE_KM), angle: p.angle };
}

// ── The viewer's frame ───────────────────────────────────────────────────────

/** How to place the whole (compressed) planet or sun frame so the viewer
 *  sits at the origin with its heading undone: the transform a Three group
 *  takes (`position`, then `rotation.y`). For a viewer at compressed radius
 *  r and angle θ it is position (−r, 0, 0), rotation.y −θ — the planet's
 *  centre off −X, exactly as orbits.inStationFrame puts it. */
export interface FrameTransform {
  position: FramePoint;
  rotationY: number;
}

export function viewerFrameTransform(viewer: OrbitPoint): FrameTransform {
  return { position: { x: -viewer.radiusKm, y: 0, z: 0 }, rotationY: -viewer.angle };
}

/** Apply a FrameTransform to a point, as Three would (rotate about +Y, then
 *  translate). Three's rotation.y by φ maps (x, z) → (x cosφ + z sinφ,
 *  −x sinφ + z cosφ). */
export function applyFrameTransform(t: FrameTransform, p: FramePoint): FramePoint {
  const c = Math.cos(t.rotationY);
  const s = Math.sin(t.rotationY);
  return {
    x: p.x * c + p.z * s + t.position.x,
    y: p.y + t.position.y,
    z: -p.x * s + p.z * c + t.position.z,
  };
}

// ── Planet view ──────────────────────────────────────────────────────────────

export interface FarStationInput {
  id: string;
  name: string;
  /** Where it is now, true km (orbits.stationPointAt). */
  point: OrbitPoint;
  /** Its orbit radius, true km (the ring). */
  ringRadiusKm: number;
  /** Modules to draw, ≥ 1. */
  modules: number;
}

export interface FarShipInput {
  id: string;
  name: string;
  plan: TransferPlan;
}

export interface FarBody {
  id: string;
  kind: 'station' | 'ship' | 'planet' | 'sun';
  name: string;
  /** Compressed, in the planet (or sun) frame. */
  position: FramePoint;
  /** Prograde heading (the orbit angle) — impostors line up along it. */
  angle: number;
  modules: number;
}

export interface FarRing {
  /** Compressed radius about the frame's centre. */
  radius: number;
  own: boolean;
}

export interface FarLayout {
  mode: 'planet' | 'sun';
  /** The planet at the centre (planet mode) — drawn at its true radius. */
  planet: PlanetRecord | null;
  transform: FrameTransform;
  rings: FarRing[];
  bodies: FarBody[];
  /** Transfer courses, compressed, in the frame. */
  paths: Array<{ id: string; points: FramePoint[] }>;
  /** Unit vector toward the sun in the VIEWER's frame (for lighting). */
  sunDirection: FramePoint;
}

/** Points along a course between two times (inclusive), `n` segments. */
export function sampleCourse(at: (ms: number) => FramePoint, fromMs: number, toMs: number, n = 64): FramePoint[] {
  const out: FramePoint[] = [];
  if (!(toMs > fromMs)) return out;
  for (let i = 0; i <= n; i++) out.push(at(fromMs + ((toMs - fromMs) * i) / n));
  return out;
}

function unit(p: FramePoint): FramePoint {
  const l = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}

/** The sun's direction seen from a viewer at `viewer` around `planetId`, in
 *  the viewer's frame: the planet is ~1 AU off, so the sun sits opposite the
 *  planet's own position around it. */
export function sunDirectionAround(planetId: string, viewer: OrbitPoint, nowMs: number): FramePoint {
  const sunFromPlanet = planetSunPointAt(planetId, nowMs).angle + Math.PI;
  const d = toPlanetFrame({ radiusKm: 1, angle: sunFromPlanet });
  const rot = applyFrameTransform({ position: { x: 0, y: 0, z: 0 }, rotationY: -viewer.angle }, d);
  return unit(rot);
}

/**
 * The far view around a planet, from a viewer at `viewer` (true km: a
 * station's stationPointAt, or a ship's transferPointAt). Other stations sit
 * on their compressed rings, ships in flight on their compressed transfers.
 */
export function planetLayout(input: {
  planetId: string;
  nowMs: number;
  viewer: OrbitPoint;
  viewerRingRadiusKm?: number;
  stations: readonly FarStationInput[];
  ships: readonly FarShipInput[];
  /** Sample each ship's course (default true). The courses only change when
   *  a flight does, so a per-frame caller passes false and keeps its own. */
  withPaths?: boolean;
}): FarLayout {
  const planet = planetById(input.planetId);
  const squash = (p: OrbitPoint) => toPlanetFrame(compressPlanetPoint(p, planet));
  const viewer = compressPlanetPoint(input.viewer, planet);

  const rings: FarRing[] = [];
  const ringKeys = new Set<number>();
  const addRing = (radiusKm: number, own: boolean) => {
    const radius = compressRadiusKm(radiusKm, planet);
    const key = Math.round(radius);
    if (ringKeys.has(key)) {
      if (own) for (const r of rings) if (Math.round(r.radius) === key) r.own = true;
      return;
    }
    ringKeys.add(key);
    rings.push({ radius, own });
  };
  if (input.viewerRingRadiusKm !== undefined) addRing(input.viewerRingRadiusKm, true);

  const bodies: FarBody[] = [];
  for (const s of input.stations) {
    addRing(s.ringRadiusKm, false);
    bodies.push({
      id: s.id,
      kind: 'station',
      name: s.name,
      position: squash(s.point),
      angle: s.point.angle,
      modules: Math.max(1, Math.floor(s.modules)),
    });
  }

  const paths: FarLayout['paths'] = [];
  for (const ship of input.ships) {
    const p = transferPointAt(ship.plan, input.nowMs);
    if (p.leg !== 'transfer') continue;
    bodies.push({ id: ship.id, kind: 'ship', name: ship.name, position: squash(p), angle: p.angle, modules: 1 });
    if (input.withPaths === false) continue;
    paths.push({
      id: ship.id,
      points: sampleCourse((ms) => squash(transferPointAt(ship.plan, ms)), ship.plan.departAt, ship.plan.arriveAt),
    });
  }

  return {
    mode: 'planet',
    planet,
    transform: viewerFrameTransform(viewer),
    rings,
    bodies,
    paths,
    sunDirection: sunDirectionAround(planet.id, input.viewer, input.nowMs),
  };
}

// ── Sun view (a station between planets) ────────────────────────────────────

/**
 * The far view from a station on its way to another planet: the sun at the
 * centre (off the viewer's −X, the station sun-locked the way it was
 * planet-locked), every planet on its compressed orbit and true angle, and
 * the station's course from departure to capture. null outside the transit.
 */
export function transitLayout(move: StationMove, nowMs: number, withPaths = true): FarLayout | null {
  const here = moveTransitPointAt(move, nowMs);
  if (!here) return null;
  const squash = (p: OrbitPoint) => toPlanetFrame(compressSunPoint(p));
  const viewer = compressSunPoint(here);
  const rings: FarRing[] = [];
  const bodies: FarBody[] = [
    { id: 'sun', kind: 'sun', name: 'SUN', position: { x: 0, y: 0, z: 0 }, angle: 0, modules: 1 },
  ];
  for (const planet of PLANETS) {
    const p = planetSunPointAt(planet.id, nowMs);
    rings.push({ radius: compressSunPoint(p).radiusKm, own: false });
    bodies.push({ id: planet.id, kind: 'planet', name: planet.name, position: squash(p), angle: p.angle, modules: 1 });
  }
  const course = !withPaths ? [] : sampleCourse((ms) => {
    const p = moveTransitPointAt(move, Math.min(Math.max(ms, move.departAt + 1), move.arriveAt - 1));
    return squash(p ?? here);
  }, move.departAt, move.arriveAt);
  return {
    mode: 'sun',
    planet: null,
    transform: viewerFrameTransform(viewer),
    rings,
    bodies,
    paths: course.length > 0 ? [{ id: 'course', points: course }] : [],
    sunDirection: { x: -1, y: 0, z: 0 },
  };
}
