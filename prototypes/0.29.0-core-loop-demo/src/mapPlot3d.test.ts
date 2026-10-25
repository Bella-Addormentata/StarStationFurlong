// mapPlot3d.ts tests: the orbit camera and the pick behind the holotable's
// plot in three dimensions (#251). The renderer itself is browser-only.

import { describe, expect, it } from 'vitest';
import { DEFAULT_REACH, DIST_MAX, DIST_MIN, FIT_YAWS, ORBIT_DEFAULT, PITCH_MAX, PITCH_MIN, createPlotView3D, fitDistance, fitPoints, fitPointsFor, fitSignature, orbitDrag, orbitPosition, orbitZoom, pickBody, projectNdc } from './mapPlot3d';
import type { HoloMarker } from './mapHologramLayout';

describe('the orbit camera', () => {
  it('sits dist away from the sun, pitch above the plane', () => {
    const p = orbitPosition({ yaw: 0, pitch: 0, dist: 3 });
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(9))).toEqual([0, 0, 3]);
    const q = orbitPosition(ORBIT_DEFAULT);
    expect(Math.hypot(q.x, q.y, q.z)).toBeCloseTo(ORBIT_DEFAULT.dist, 9);
    expect(q.y).toBeGreaterThan(0);
  });

  it('turns with a drag and never tips below the plane or over the top', () => {
    const o = orbitDrag(ORBIT_DEFAULT, 100, 0);
    expect(o.yaw).not.toBe(ORBIT_DEFAULT.yaw);
    expect(o.pitch).toBe(ORBIT_DEFAULT.pitch);
    expect(orbitDrag(ORBIT_DEFAULT, 0, -10_000).pitch).toBe(PITCH_MIN);
    expect(PITCH_MIN).toBeGreaterThan(0.48); // above the steepest orbit tilt
    expect(orbitDrag(ORBIT_DEFAULT, 0, 10_000).pitch).toBe(PITCH_MAX);
  });

  it('zooms by steps, within its limits', () => {
    expect(orbitZoom(ORBIT_DEFAULT, 1).dist).toBeGreaterThan(ORBIT_DEFAULT.dist);
    expect(orbitZoom(ORBIT_DEFAULT, -1).dist).toBeLessThan(ORBIT_DEFAULT.dist);
    expect(orbitZoom(ORBIT_DEFAULT, 100).dist).toBe(DIST_MAX);
    expect(orbitZoom(ORBIT_DEFAULT, -100).dist).toBe(DIST_MIN);
  });
});

describe('the fit', () => {
  /** The farthest any fit point lands from the view's centre, as a fraction
   *  of the half-extents, over a turn of the view. */
  const reach = (aspect: number, pitch: number, dist: number): number => {
    let m = 0;
    for (let k = 0; k < FIT_YAWS; k++) {
      for (const p of fitPoints()) {
        const q = projectNdc(p, { yaw: (k / FIT_YAWS) * Math.PI * 2, pitch, dist }, aspect);
        m = Math.max(m, q.behind ? Infinity : Math.abs(q.x), q.behind ? Infinity : Math.abs(q.y));
      }
    }
    return m;
  };

  it('keeps the whole plot in view through the camera, belt, tilts and near side included, and no further than it must', () => {
    for (const [aspect, pitch] of [[2.0, ORBIT_DEFAULT.pitch], [1.33, ORBIT_DEFAULT.pitch], [1.0, 0.6], [0.6, 0.9], [2.0, PITCH_MIN]] as const) {
      const d = fitDistance(aspect, pitch);
      expect(reach(aspect, pitch, d)).toBeLessThanOrEqual(0.88 + 1e-6);
      // Tight: a step nearer would spill, unless the zoom limit binds.
      if (d > DIST_MIN + 1e-6 && d < DIST_MAX - 1e-6) expect(reach(aspect, pitch, d * 0.97)).toBeGreaterThan(0.88);
    }
  });

  it("backs off for a station on a high slot, whose ring reaches past the belt, and keeps the ring in frame", () => {
    // Sovereign on its drawn orbit, with a slot-15 station's ring round it, in disc metres.
    const sov = { x: 0.3 * 1.22, z: 0 };
    const r = (35 + 9 * 15) * 1.4 * (0.5 / 300);
    const markers: HoloMarker[] = [
      { id: 'planet-sovereign', name: 'S', type: 'planet', frame: 'planet-sovereign', x: sov.x, z: sov.z, here: false },
      { id: 'st-high', name: 'HIGH', type: 'station', frame: 'planet-sovereign', x: sov.x + r, z: 0, here: false, orbit: { cx: sov.x, cz: sov.z, r } },
    ];
    expect(sov.x + r).toBeGreaterThan(DEFAULT_REACH);
    expect(fitSignature(markers)).toContain('planet-sovereign:');
    const pts = fitPointsFor(markers);
    expect(pts.length).toBeGreaterThan(fitPoints().length);
    // In a square panel the ring's width binds; the belt-only fit would clip it.
    const aspect = 1.0;
    const near = fitDistance(aspect, ORBIT_DEFAULT.pitch), far = fitDistance(aspect, ORBIT_DEFAULT.pitch, pts);
    const reach = (dist: number) => {
      let m = 0;
      for (let k = 0; k < FIT_YAWS; k++) for (const p of pts) { const q = projectNdc(p, { yaw: (k / FIT_YAWS) * Math.PI * 2, pitch: ORBIT_DEFAULT.pitch, dist }, aspect); m = Math.max(m, q.behind ? Infinity : Math.abs(q.x), q.behind ? Infinity : Math.abs(q.y)); }
      return m;
    };
    expect(reach(near)).toBeGreaterThan(0.88);
    expect(far).toBeGreaterThan(near);
    expect(reach(far)).toBeLessThanOrEqual(0.88 + 1e-6);
    // A low-slot station changes nothing: its ring is well inside the belt.
    const low: HoloMarker[] = [markers[0]!, { ...markers[1]!, id: 'st-low', x: sov.x + 0.06, orbit: { cx: sov.x, cz: 0, r: 0.06 } }];
    expect(fitDistance(aspect, ORBIT_DEFAULT.pitch, fitPointsFor(low))).toBeCloseTo(near, 6);
  });

  it('is farther for a narrow panel than a wide one, within the zoom limits', () => {
    const wide = fitDistance(2.0, 0.6), square = fitDistance(1.0, 0.6), tall = fitDistance(0.5, 0.6);
    expect(tall).toBeGreaterThan(square);
    expect(square).toBeGreaterThanOrEqual(wide);
    expect(fitDistance(0.01, 0.6)).toBe(DIST_MAX);
    expect(fitDistance(50, PITCH_MIN)).toBeGreaterThanOrEqual(DIST_MIN);
  });

  it('projects a point ahead of the camera to the centre, and one behind as behind', () => {
    const o = { yaw: 0.3, pitch: 0.5, dist: 3 };
    const centre = projectNdc({ x: 0, y: 0, z: 0 }, o, 1.5);
    expect(centre.behind).toBe(false);
    expect(centre.x).toBeCloseTo(0, 9);
    expect(centre.y).toBeCloseTo(0, 9);
    const c = orbitPosition(o);
    expect(projectNdc({ x: c.x * 2, y: c.y * 2, z: c.z * 2 }, o, 1.5).behind).toBe(true);
    // Up is up: a point above the origin lands above the centre.
    expect(projectNdc({ x: 0, y: 0.5, z: 0 }, o, 1.5).y).toBeGreaterThan(0);
  });
});

describe('the pick', () => {
  const bodies = [
    { id: 'sun', x: 100, y: 100, behind: false },
    { id: 'near', x: 110, y: 100, behind: false },
    { id: 'hidden', x: 112, y: 100, behind: true },
  ];
  it('takes the nearest body within reach, never one behind the camera', () => {
    expect(pickBody(bodies, 108, 101)).toBe('near');
    expect(pickBody(bodies, 101, 99)).toBe('sun');
    expect(pickBody(bodies, 113, 100)).toBe('near');
    expect(pickBody(bodies, 300, 300)).toBeNull();
    expect(pickBody(bodies, 120, 100, 5)).toBeNull();
  });
});

describe('createPlotView3D', () => {
  it('is nothing outside a browser', async () => {
    expect(await createPlotView3D()).toBeNull();
  });
});
