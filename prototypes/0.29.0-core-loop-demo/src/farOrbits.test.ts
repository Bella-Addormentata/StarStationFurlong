/**
 * 🔭 farOrbits — the distant view's geometry: true angles, compressed
 * altitudes, the viewer's planet-locked frame.
 */
import { describe, expect, it } from 'vitest';
import {
  ORBIT_EPOCH_MS,
  inStationFrame,
  orbitForSlot,
  planTransfer,
  stationOrbit,
  stationPointAt,
  toPlanetFrame,
} from './orbits';
import {
  applyFrameTransform,
  compressAltitudeKm,
  compressPlanetPoint,
  compressRadiusKm,
  planetLayout,
  sampleCourse,
  sunDirectionAround,
  transitLayout,
  viewerFrameTransform,
} from './farOrbits';
import { planTow } from './stationMove';
import { DEFAULT_PLANET_ID, MAX_ORBIT_SLOTS, planetById } from './stations';
import type { StationMove } from './stations';

const SOV = DEFAULT_PLANET_ID;
const planet = planetById(SOV);
const T = ORBIT_EPOCH_MS + 3 * 3600 * 1000;
const station = (orbitSlot: number) => ({ id: `s${orbitSlot}`, planetId: SOV, orbitSlot });

describe('altitude compression', () => {
  it('is monotonic, starts at zero and keeps every slot clear of the planet', () => {
    expect(compressAltitudeKm(0)).toBe(0);
    let prev = 0;
    for (let slot = 0; slot < MAX_ORBIT_SLOTS; slot++) {
      const r = compressRadiusKm(orbitForSlot(SOV, slot).radiusKm, planet);
      expect(r).toBeGreaterThan(planet.radiusKm);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
    // All sixteen slots fit within ~40% of the planet's radius above it.
    expect(prev - planet.radiusKm).toBeLessThan(0.4 * planet.radiusKm);
  });

  it('keeps low altitudes close to true', () => {
    expect(compressAltitudeKm(50)).toBeCloseTo(50, -1);
  });

  it('never changes an angle', () => {
    const p = stationPointAt(station(3), T);
    expect(compressPlanetPoint(p, planet).angle).toBe(p.angle);
  });
});

describe('sampleCourse', () => {
  it('refuses empty or overflowing spans and never yields a non-finite time', () => {
    const at = (ms: number) => ({ x: ms, y: 0, z: 0 });
    expect(sampleCourse(at, 5, 5)).toEqual([]);
    expect(sampleCourse(at, -Number.MAX_VALUE, Number.MAX_VALUE)).toEqual([]);
    const pts = sampleCourse(at, 0, Number.MAX_VALUE, 4);
    expect(pts).toHaveLength(5);
    for (const p of pts) expect(Number.isFinite(p.x)).toBe(true);
  });
});

describe("the viewer's frame", () => {
  it('matches orbits.inStationFrame exactly when nothing is compressed', () => {
    const me = station(1);
    const here = stationPointAt(me, T);
    const t = viewerFrameTransform(here);
    for (const other of [station(0), station(4), station(9)]) {
      const p = stationPointAt(other, T);
      const got = applyFrameTransform(t, toPlanetFrame(p));
      const want = inStationFrame(me, T, p);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
      expect(got.z).toBeCloseTo(want.z, 6);
    }
  });

  it('puts the viewer at the origin and the planet centre off −X', () => {
    const here = stationPointAt(station(2), T);
    const t = viewerFrameTransform(here);
    const me = applyFrameTransform(t, toPlanetFrame(here));
    expect(Math.hypot(me.x, me.y, me.z)).toBeLessThan(1e-6);
    const centre = applyFrameTransform(t, { x: 0, y: 0, z: 0 });
    expect(centre.x).toBeCloseTo(-here.radiusKm, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it('gives a unit sun direction in the equatorial plane', () => {
    const d = sunDirectionAround(SOV, stationPointAt(station(0), T), T);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
    expect(d.y).toBe(0);
  });
});

describe('planetLayout', () => {
  const me = station(0);
  const others = [station(2), station(5)].map((s) => ({
    id: s.id,
    name: s.id.toUpperCase(),
    point: stationPointAt(s, T),
    ringRadiusKm: stationOrbit(s).radiusKm,
    modules: 3,
  }));

  it('puts each station on its compressed ring at its true angle', () => {
    const layout = planetLayout({
      planetId: SOV,
      nowMs: T,
      viewer: stationPointAt(me, T),
      viewerRingRadiusKm: stationOrbit(me).radiusKm,
      stations: others,
      ships: [],
    });
    expect(layout.mode).toBe('planet');
    expect(layout.rings.filter((r) => r.own)).toHaveLength(1);
    expect(layout.rings).toHaveLength(3);
    for (const s of others) {
      const b = layout.bodies.find((x) => x.id === s.id)!;
      const radius = Math.hypot(b.position.x, b.position.z);
      expect(radius).toBeCloseTo(compressRadiusKm(s.ringRadiusKm, planet), 6);
      expect(Math.atan2(-b.position.z, b.position.x)).toBeCloseTo(
        Math.atan2(Math.sin(s.point.angle), Math.cos(s.point.angle)),
        9,
      );
      expect(layout.rings.some((r) => Math.abs(r.radius - radius) < 1e-6)).toBe(true);
    }
  });

  it('draws a ship only while it is on its transfer, with its course', () => {
    const plan = planTransfer(station(0), station(4), T)!;
    const mid = (plan.departAt + plan.arriveAt) / 2;
    const base = { planetId: SOV, viewer: stationPointAt(me, mid), stations: [] };
    const flying = planetLayout({ ...base, nowMs: mid, ships: [{ id: 'ship', name: 'SHIP', plan }] });
    expect(flying.bodies.map((b) => b.kind)).toEqual(['ship']);
    expect(flying.paths[0].points.length).toBeGreaterThan(10);
    const first = flying.paths[0].points[0];
    const last = flying.paths[0].points[flying.paths[0].points.length - 1];
    expect(Math.hypot(first.x, first.z)).toBeCloseTo(compressRadiusKm(plan.from.radiusKm, planet), 3);
    expect(Math.hypot(last.x, last.z)).toBeCloseTo(compressRadiusKm(plan.to.radiusKm, planet), 3);

    const posesOnly = planetLayout({ ...base, nowMs: mid, ships: [{ id: 'ship', name: 'SHIP', plan }], withPaths: false });
    expect(posesOnly.paths).toHaveLength(0);
    expect(posesOnly.bodies[0].position).toEqual(flying.bodies[0].position);

    const waiting = planetLayout({ ...base, nowMs: plan.departAt - 1000, ships: [{ id: 'ship', name: 'SHIP', plan }] });
    expect(waiting.bodies).toHaveLength(0);
  });
});

describe('transitLayout', () => {
  const tow = planTow('planet-sovereign', 'planet-aris', T)!;
  const move: StationMove = {
    stationId: 'furlong-station',
    welcomeRoomId: 'lobby',
    fromPlanetId: 'planet-sovereign',
    fromSlot: 0,
    toPlanetId: 'planet-aris',
    toSlot: 0,
    departAt: tow.departAt,
    arriveAt: tow.arriveAt,
    mode: 'tug',
    tugRoomId: 'tug',
    fuel: 1,
    fuelDrawn: 1,
  };

  it('is null outside the transit', () => {
    expect(transitLayout(move, move.departAt - 1)).toBeNull();
    expect(transitLayout(move, move.arriveAt + 1)).toBeNull();
  });

  it('shows the sun, every planet and the course while under way', () => {
    const layout = transitLayout(move, (move.departAt + move.arriveAt) / 2)!;
    expect(layout.mode).toBe('sun');
    expect(layout.planet).toBeNull();
    expect(layout.bodies.map((b) => b.kind).sort()).toEqual(['planet', 'planet', 'sun']);
    expect(layout.paths[0].points.length).toBeGreaterThan(10);
    expect(transitLayout(move, (move.departAt + move.arriveAt) / 2, false)!.paths).toHaveLength(0);
    // The sun sits off the viewer's −X.
    const sun = applyFrameTransform(layout.transform, { x: 0, y: 0, z: 0 });
    expect(sun.x).toBeLessThan(0);
    expect(sun.z).toBeCloseTo(0, 6);
  });
});
