// mapHologramLayout.ts tests: the hologram over the map table (#251) lays
// out the same bodies the table's panel plots, on the disc, in metres.

import { describe, expect, it } from 'vitest';
import { solarPlotBodies, stationBodies, plotOffset, screenOffset } from './map';
import type { MapBody } from './map';
import type { PlanModule, StationPlan } from './stationPlan';
import { DEFAULT_STATION_RECORD } from './stations';
import { ORBIT_EPOCH_MS } from './orbits';
import {
  FADE_SECONDS,
  HOLO_RADIUS,
  PLOT_SCALE,
  PLOT_SECONDS,
  STATION_SECONDS,
  beltRadius,
  holoModeAt,
  inclinationOf,
  inclinedPoint,
  orbitStretch,
  orbitTurn,
  plotCourses,
  plotMarkers,
  stationLayout,
} from './mapHologramLayout';

const T = ORBIT_EPOCH_MS + 5 * 3600 * 1000;

describe('the plot on the disc', () => {
  it('puts every body where the panel plots it, scaled to the disc, the planets spread apart', () => {
    const bodies = solarPlotBodies([DEFAULT_STATION_RECORD]);
    const markers = plotMarkers(bodies, T, DEFAULT_STATION_RECORD.id);
    expect(markers.map((m) => m.id)).toEqual(bodies.map((b) => b.id));
    const at = (id: string) => { const b = bodies.find((x) => x.id === id)!; const o = plotOffset(bodies, b, T); return { x: o.dx * PLOT_SCALE, z: o.dy * PLOT_SCALE }; };
    const turn = (x: number, z: number, a: number) => ({ x: x * Math.cos(a) - z * Math.sin(a), z: x * Math.sin(a) + z * Math.cos(a) });
    for (const m of markers) {
      expect(Math.hypot(m.x, m.z)).toBeLessThanOrEqual(HOLO_RADIUS);
      const flat = at(m.id);
      if (m.type === 'planet' || m.type === 'lagrange') {
        // Its orbit, orbitStretch wider, turned by orbitTurn about the sun.
        const k = orbitStretch(m.frame), e = turn(flat.x * k, flat.z * k, orbitTurn(m.frame));
        expect(m.x).toBeCloseTo(e.x, 9);
        expect(m.z).toBeCloseTo(e.z, 9);
      } else if (m.type === 'station') {
        // Carried with its planet: the same offset from it as on the panel, turned with the orbit.
        const planet = markers.find((p) => p.id === m.frame)!, pf = at(m.frame);
        const e = turn(flat.x - pf.x, flat.z - pf.z, orbitTurn(m.frame));
        expect(m.x - planet.x).toBeCloseTo(e.x, 9);
        expect(m.z - planet.z).toBeCloseTo(e.z, 9);
      } else {
        expect(m.x).toBeCloseTo(flat.x, 9);
        expect(m.z).toBeCloseTo(flat.z, 9);
      }
    }
    expect(orbitStretch('planet-aris')).toBeGreaterThan(1);
    expect(orbitStretch('belt-ring')).toBe(1);
    expect(orbitTurn('planet-aris')).not.toBe(orbitTurn('planet-sovereign'));
    expect(orbitTurn('belt-ring')).toBe(0);
  });

  it('marks only the station you are in as here', () => {
    const bodies = solarPlotBodies([DEFAULT_STATION_RECORD]);
    const here = plotMarkers(bodies, T, DEFAULT_STATION_RECORD.id).filter((m) => m.here);
    expect(here.map((m) => m.id)).toEqual([DEFAULT_STATION_RECORD.id]);
    expect(plotMarkers(bodies, T, '').some((m) => m.here)).toBe(false);
    // A planet with the station's id is not "here": here is a station.
    expect(plotMarkers(bodies, T, 'planet-sovereign').some((m) => m.here)).toBe(false);
  });

  it("rings a planet round the sun and a station round its planet, at the panel's radii", () => {
    const bodies = solarPlotBodies([DEFAULT_STATION_RECORD]);
    const markers = plotMarkers(bodies, T);
    const sovereign = markers.find((m) => m.id === 'planet-sovereign')!;
    expect(sovereign.orbit).toEqual({ cx: 0, cz: 0, r: 180 * PLOT_SCALE * orbitStretch('planet-sovereign') });
    const [body] = stationBodies([DEFAULT_STATION_RECORD]);
    const station = markers.find((m) => m.id === body!.id)!;
    expect(station.orbit!.r).toBeCloseTo(body!.orbitRadius * PLOT_SCALE, 9);
    expect(station.orbit!.cx).toBeCloseTo(sovereign.x, 9);
    expect(station.orbit!.cz).toBeCloseTo(sovereign.z, 9);
    // The station sits on its ring.
    expect(Math.hypot(station.x - station.orbit!.cx, station.z - station.orbit!.cz)).toBeCloseTo(station.orbit!.r, 9);
    // The sun, the Lagrange pockets and the belt ride no ring of their own.
    for (const m of markers) {
      if (m.type === 'star' || m.type === 'lagrange' || m.type === 'asteroid-field') expect(m.orbit).toBeUndefined();
    }
  });

  it('gives a station in transit no ring, and its course on the disc', () => {
    const planet: MapBody = {
      id: 'planet-x', name: 'X', type: 'planet', orbitRadius: 100, orbitSpeed: 0, angle: 0, description: '',
    };
    const until = T + 60_000;
    const mover: MapBody = {
      id: 'mover', name: 'MOVER', type: 'station', orbitRadius: 35, orbitSpeed: 0, angle: 0, description: '',
      placeAt: () => ({ angle: 1, radius: 150 }),
      course: { until, points: [{ angle: 0, radius: 100 }, { angle: 1, radius: 150 }] },
    };
    const bodies = [planet, mover];
    const m = plotMarkers(bodies, T).find((x) => x.id === 'mover')!;
    expect(m.orbit).toBeUndefined();
    const { dx, dy } = screenOffset(1, 150);
    expect(m.x).toBeCloseTo(dx * PLOT_SCALE, 9);
    expect(m.z).toBeCloseTo(dy * PLOT_SCALE, 9);
    const courses = plotCourses(bodies, T);
    expect(courses).toHaveLength(1);
    expect(courses[0]!.id).toBe('mover');
    expect(courses[0]!.points).toHaveLength(2);
    expect(courses[0]!.points[1]!.x).toBeCloseTo(m.x, 9);
    expect(courses[0]!.points[1]!.z).toBeCloseTo(m.z, 9);
    // Arrived: no course to draw.
    expect(plotCourses(bodies, until)).toEqual([]);
  });

  it('names the orbit plane each body rides', () => {
    const bodies = solarPlotBodies([DEFAULT_STATION_RECORD]);
    const frames = Object.fromEntries(plotMarkers(bodies, T).map((m) => [m.id, m.frame]));
    expect(frames['star-sol']).toBe('');
    expect(frames['planet-sovereign']).toBe('planet-sovereign');
    expect(frames['belt-ring']).toBe('belt-ring');
    expect(frames['lagrange-l4']).toBe('planet-sovereign');
    expect(frames[DEFAULT_STATION_RECORD.id]).toBe('planet-sovereign');
  });

  it('tilts a point about the line of nodes, keeping its distance from the sun', () => {
    expect(inclinedPoint(0.3, 0.1, { tilt: 0, node: 1 })).toEqual({ x: 0.3, y: 0, z: 0.1 });
    const inc = inclinationOf('planet-aris');
    expect(inc.tilt).not.toBe(0);
    // On the nodes themselves nothing lifts; a quarter turn on lifts most.
    const onNode = inclinedPoint(Math.cos(inc.node) * 0.2, Math.sin(inc.node) * 0.2, inc);
    expect(onNode.y).toBeCloseTo(0, 9);
    const across = inclinedPoint(-Math.sin(inc.node) * 0.2, Math.cos(inc.node) * 0.2, inc);
    expect(Math.abs(across.y)).toBeCloseTo(0.2 * Math.abs(Math.sin(inc.tilt)), 9);
    expect(Math.hypot(across.x, across.y, across.z)).toBeCloseTo(0.2, 9);
    expect(inclinationOf('nothing')).toEqual({ tilt: 0, node: 0 });
  });

  it('has a belt just inside the rim', () => {
    const r = beltRadius(solarPlotBodies([]));
    expect(r).not.toBeNull();
    expect(r!).toBeLessThan(HOLO_RADIUS);
    expect(r!).toBeGreaterThan(HOLO_RADIUS * 0.8);
    expect(beltRadius([])).toBeNull();
  });
});

function module(roomId: string, x: number, z: number, opts: Partial<PlanModule> = {}): PlanModule {
  return {
    roomId, name: roomId, x, z, rotY: 0, halfX: 1, halfZ: 1, hops: 0, kind: 'module', here: false,
    gates: [], links: [], pairedFromInside: true, ...opts,
  };
}

function plan(modules: PlanModule[], ships: PlanModule[] = []): StationPlan {
  const all = [...modules, ...ships];
  const xs = all.flatMap((m) => [m.x - m.halfX, m.x + m.halfX]);
  const zs = all.flatMap((m) => [m.z - m.halfZ, m.z + m.halfZ]);
  return {
    rootRoomId: modules[0]?.roomId ?? '',
    modules, ships,
    bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) },
  };
}

describe('the station on the disc', () => {
  it('centres the station and fits it inside the disc', () => {
    const p = plan([
      module('a', 0, 0, { here: true }),
      module('b', 10, 0),
      module('c', 10, 6, { rotY: Math.PI / 2 }),
    ]);
    const holo = stationLayout(p);
    expect(holo.modules.map((m) => m.roomId)).toEqual(['a', 'b', 'c']);
    // Centred on the bounds: the middle module sits off-centre, the extremes balance.
    const xs = holo.modules.map((m) => m.x);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 9);
    for (const m of holo.modules) {
      const reach = Math.hypot(Math.abs(m.x) + m.halfX, Math.abs(m.z) + m.halfZ);
      expect(reach).toBeLessThanOrEqual(HOLO_RADIUS);
      expect(m.rotY).toBe(p.modules.find((pm) => pm.roomId === m.roomId)!.rotY);
    }
    expect(holo.modules[0]!.here).toBe(true);
    expect(holo.modules[1]!.here).toBe(false);
  });

  it('keeps a lone module a block, not a slab across the disc', () => {
    const holo = stationLayout(plan([module('solo', 0, 0)]));
    expect(holo.modules).toHaveLength(1);
    expect(holo.modules[0]!.halfX * 2).toBeLessThanOrEqual(HOLO_RADIUS * 0.5);
    expect(holo.modules[0]!.x).toBe(0);
    expect(holo.modules[0]!.z).toBe(0);
  });

  it('draws each gangway once, between the modules it joins, and a berth as a berth', () => {
    const a = module('a', 0, 0, { links: [{ doorId: 'd1', toRoomId: 'b', berth: false }, { doorId: 'd2', toRoomId: 'ship', berth: true }] });
    const b = module('b', 6, 0, { links: [{ doorId: 'd3', toRoomId: 'a', berth: false }, { doorId: 'd4', toRoomId: 'ghost', berth: false }] });
    const ship = module('ship', 0, 6, { kind: 'ship', links: [{ doorId: 'd5', toRoomId: 'a', berth: true }] });
    const holo = stationLayout(plan([a, b], [ship]));
    expect(holo.links).toHaveLength(2);
    const ab = holo.links.find((l) => !l.berth)!;
    const ma = holo.modules.find((m) => m.roomId === 'a')!, mb = holo.modules.find((m) => m.roomId === 'b')!;
    expect([ab.ax, ab.az, ab.bx, ab.bz]).toEqual([ma.x, ma.z, mb.x, mb.z]);
    const berth = holo.links.find((l) => l.berth)!;
    const ms = holo.modules.find((m) => m.roomId === 'ship')!;
    expect(ms.ship).toBe(true);
    expect([berth.bx, berth.bz]).toEqual([ms.x, ms.z]);
  });

  it('is empty for an empty plan', () => {
    expect(stationLayout(plan([]))).toEqual({ scale: 0, modules: [], links: [] });
  });
});

describe('the cycle', () => {
  it('shows the plot, then the station, each faded in and out', () => {
    expect(holoModeAt(0)).toEqual({ mode: 'plot', fade: 0 });
    expect(holoModeAt(FADE_SECONDS / 2).fade).toBeCloseTo(0.5, 9);
    expect(holoModeAt(PLOT_SECONDS / 2)).toEqual({ mode: 'plot', fade: 1 });
    expect(holoModeAt(PLOT_SECONDS - FADE_SECONDS / 4).fade).toBeCloseTo(0.25, 9);
    expect(holoModeAt(PLOT_SECONDS)).toEqual({ mode: 'station', fade: 0 });
    expect(holoModeAt(PLOT_SECONDS + STATION_SECONDS / 2)).toEqual({ mode: 'station', fade: 1 });
    expect(holoModeAt(PLOT_SECONDS + STATION_SECONDS)).toEqual({ mode: 'plot', fade: 0 });
    // Round and round.
    expect(holoModeAt(3 * (PLOT_SECONDS + STATION_SECONDS) + 4)).toEqual({ mode: 'plot', fade: 1 });
  });

  it('keeps the plot, fully shown, when there is no station to show', () => {
    expect(holoModeAt(0, false)).toEqual({ mode: 'plot', fade: 1 });
    expect(holoModeAt(PLOT_SECONDS + 2, false)).toEqual({ mode: 'plot', fade: 1 });
  });
});
