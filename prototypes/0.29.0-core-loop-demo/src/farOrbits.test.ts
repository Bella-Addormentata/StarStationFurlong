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
  clearanceRadiusKm,
  forwardClearOf,
  frozenCourse,
  planetLayout,
  VIEWER_BODY_ID,
  sampleCourse,
  sunDirectionAround,
  transitLayout,
  viewerFrameTransform,
  type FrozenCourses,
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

describe('the viewer drawn among the stations (issue 218)', () => {
  const me = station(0);
  const shape = {
    modules: [{ x: 0, z: 0, rotY: 0, halfX: 6, halfZ: 6, ship: false }, { x: 30, z: 0, rotY: Math.PI / 2, halfX: 6, halfZ: 9, ship: false }],
    links: [{ ax: 0, az: 0, bx: 30, bz: 0 }],
  };

  it("sits at the viewer's place, lined up with its orbit, carrying its shape", () => {
    const layout = planetLayout({
      planetId: SOV, nowMs: T, viewer: stationPointAt(me, T), stations: [], ships: [],
      viewerBody: { name: 'HOME', shape },
    });
    const own = layout.bodies.find((b) => b.id === VIEWER_BODY_ID)!;
    expect(own).toMatchObject({ kind: 'station', name: 'HOME', own: true, modules: 2, shape });
    expect(own.angle).toBeCloseTo(stationPointAt(me, T).angle, 12);
    // In the viewer's frame it is at the origin, where the camera looks.
    const seen = applyFrameTransform(layout.transform, own.position);
    expect(Math.hypot(seen.x, seen.y, seen.z)).toBeLessThan(1e-6);
  });

  it('is left out unless asked for, and other stations keep their shapes', () => {
    const other = { id: 's3', name: 'S3', point: stationPointAt(station(3), T), ringRadiusKm: stationOrbit(station(3)).radiusKm, modules: 2, shape };
    const layout = planetLayout({ planetId: SOV, nowMs: T, viewer: stationPointAt(me, T), stations: [other], ships: [] });
    expect(layout.bodies.map((b) => b.id)).toEqual(['s3']);
    expect(layout.bodies[0].shape).toBe(shape);
  });

});

describe('forwardClearOf: the planet never hides the viewer (issue 218)', () => {
  const R = planet.radiusKm * 1.04;
  const d = 14_000;
  // The planet off the viewer's −X, as in the far frame: centre at the
  // viewer's compressed orbit radius.
  const centre = { x: -compressRadiusKm(stationOrbit(station(0)).radiusKm, planet), y: 0, z: 0 };
  const iso = (azimuth: number) => {
    // An isometric look: 35.26° down, heading `azimuth` about +Y.
    const e = Math.atan(1 / Math.SQRT2);
    return { x: Math.cos(e) * Math.sin(azimuth), y: -Math.sin(e), z: -Math.cos(e) * Math.cos(azimuth) };
  };
  const hits = (f: { x: number; y: number; z: number }) => {
    // Sample the line from the camera to the viewer.
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const p = { x: -f.x * d * (1 - t), y: -f.y * d * (1 - t), z: -f.z * d * (1 - t) };
      if (Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z) < R - 1e-6) return true;
    }
    return false;
  };

  it('keeps a view from the side away from the planet as it is', () => {
    // Looking toward −X from out past +X: the planet is behind the viewer.
    const e = Math.atan(1 / Math.SQRT2);
    const away = { x: -Math.cos(e), y: -Math.sin(e), z: 0 };
    expect(hits(away)).toBe(false);
    expect(forwardClearOf(away, centre, R, d)).toBe(away);
  });

  it('tips the camera up, heading kept, when it looks across the planet', () => {
    // Looking toward +X: the camera sits out past the planet's side.
    const f = { x: Math.cos(Math.atan(1 / Math.SQRT2)), y: -Math.sin(Math.atan(1 / Math.SQRT2)), z: 0 };
    expect(hits(f)).toBe(true);
    const clear = forwardClearOf(f, centre, R, d);
    expect(hits(clear)).toBe(false);
    expect(Math.hypot(clear.x, clear.y, clear.z)).toBeCloseTo(1, 9);
    expect(clear.y).toBeLessThan(f.y); // steeper
    expect(Math.sign(clear.x)).toBe(1); // same heading
    expect(Math.abs(clear.z)).toBeLessThan(1e-9);
    // No steeper than it needs: a quarter degree less still hits.
    const e = Math.asin(-clear.y) - Math.PI / 720;
    expect(hits({ x: Math.cos(e), y: -Math.sin(e), z: 0 })).toBe(true);
  });

  it('on the lowest orbit allowed, still tips only as far as it needs', () => {
    // 200 km up compresses to ~162 km, inside a flat 4% margin (~255 km).
    const low = { x: -(planet.radiusKm + compressAltitudeKm(200)), y: 0, z: 0 };
    const r = clearanceRadiusKm(planet.radiusKm, -low.x);
    expect(r).toBeLessThan(-low.x);
    expect(r).toBeGreaterThan(planet.radiusKm);
    const e = Math.atan(1 / Math.SQRT2);
    const f = { x: Math.cos(e), y: -Math.sin(e), z: 0 };
    const clear = forwardClearOf(f, low, r, d);
    expect(clear.y).toBeGreaterThan(-0.999); // not straight down
  });

  it('clears the planet at every heading of the camera rig', () => {
    for (let k = 0; k < 16; k++) expect(hits(forwardClearOf(iso((k * Math.PI) / 8), centre, R, d))).toBe(false);
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

  it('is null for a thruster move whose ends are one planet (no course to show)', () => {
    const bad: StationMove = { ...move, mode: 'thrusters', toPlanetId: 'planet-sovereign', tugRoomId: undefined };
    expect(transitLayout(bad, (move.departAt + move.arriveAt) / 2)).toBeNull();
  });

  it('is null for a tug move whose two planet ids name one planet', () => {
    const bad: StationMove = { ...move, toPlanetId: 'no-such-planet' };
    expect(planetById(bad.toPlanetId).id).toBe(planetById(bad.fromPlanetId).id);
    expect(transitLayout(bad, (move.departAt + move.arriveAt) / 2)).toBeNull();
  });

  it('draws the viewer at its own place, as the planet view does (issue 218)', () => {
    const layout = transitLayout(move, (move.departAt + move.arriveAt) / 2, false, { name: 'HOME' })!;
    const own = layout.bodies.find((b) => b.id === VIEWER_BODY_ID)!;
    expect(own).toMatchObject({ kind: 'station', own: true, name: 'HOME' });
    const seen = applyFrameTransform(layout.transform, own.position);
    expect(Math.hypot(seen.x, seen.y, seen.z)).toBeLessThan(1e-6);
  });

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

describe('courses already drawn', () => {
  const HOUR = 3600 * 1000;
  const flight = ['ship', 'ferry-1', 'room-a', 'room-b'];
  /** The station at `orbitSlot` once it has moved to ARIS PRIME. */
  const moved = (orbitSlot: number) => ({ ...station(orbitSlot), planetId: 'planet-aris' });
  const copies = [
    { id: 'route-stop:from', planetId: SOV, orbitSlot: 1 },
    { id: 'route-stop:to', planetId: SOV, orbitSlot: 3 },
  ] as const;

  it("keeps a flight's course once drawn, though its ends move since", () => {
    const courses: FrozenCourses = new Map();
    const first = frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), station(3)], T)!;
    expect(first.to).toEqual(orbitForSlot(SOV, 3));
    expect(frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), station(4)], T + 1)).toBe(first);
    expect(frozenCourse(courses, flight, T, T + HOUR, null, () => [undefined, undefined], T + 2)).toBe(first);
    expect([...courses.values()].map((c) => c.seenAt)).toEqual([T + 2]);
  });

  // Copilot (PR 180): a summary relayed without the route's copies of a
  // ferry leg's stops, then one carrying them, kept the course the station
  // list placed (by its moved or trimmed stations) for the whole leg. And
  // once one without them came again (an older client's relay is newer
  // news), the station list's course was back.
  it("draws a ferry leg on its stops' copies once they are known, after a course the station list placed, and keeps it", () => {
    const courses: FrozenCourses = new Map();
    // The station list has the leg's end station at another slot by now.
    const listed = frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), station(4)], T)!;
    expect(listed.to).toEqual(orbitForSlot(SOV, 4));
    const copied = frozenCourse(courses, flight, T, T + HOUR, copies, () => [station(1), station(4)], T + 1)!;
    expect(copied.to).toEqual(orbitForSlot(SOV, 3));
    expect(copied).toMatchObject({ departAt: T, arriveAt: T + HOUR });
    expect(frozenCourse(courses, flight, T, T + HOUR, copies, () => [undefined, undefined], T + 2)).toBe(copied);
    // A summary without them again, the end station gone to another planet.
    expect(frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), moved(3)], T + 3)).toBe(copied);
    expect(frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), station(4)], T + 4)).toBe(copied);
    expect([...courses.values()].map((c) => c.seenAt)).toEqual([T + 4]);
  });

  // Copilot (PR 180): a course drawn on the copies, then a summary without
  // them, placed the leg afresh by the station list, which draws nothing
  // once the leg's end station has moved to another planet.
  it("keeps a ferry leg's course on its stops' copies when a later summary comes without them, its end station moved since", () => {
    const courses: FrozenCourses = new Map();
    const copied = frozenCourse(courses, flight, T, T + HOUR, copies, () => [station(1), station(3)], T)!;
    expect(copied.to).toEqual(orbitForSlot(SOV, 3));
    expect(frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), moved(3)], T + 1)).toBe(copied);
  });

  it('draws nothing for a flight with no time aloft, or ends it cannot place', () => {
    const courses: FrozenCourses = new Map();
    expect(frozenCourse(courses, flight, T, T, copies, () => [station(1), station(3)], T)).toBeNull();
    expect(frozenCourse(courses, flight, T, T + HOUR, null, () => [station(1), undefined], T)).toBeNull();
    expect(courses.size).toBe(0);
  });
});
