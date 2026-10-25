// mapPlot3d.ts tests: the orbit camera and the pick behind the holotable's
// plot in three dimensions (#251). The renderer itself is browser-only.

import { describe, expect, it } from 'vitest';
import { DIST_MAX, DIST_MIN, ORBIT_DEFAULT, PITCH_MAX, PITCH_MIN, PLOT_RADIUS, createPlotView3D, fitDistance, orbitDrag, orbitPosition, orbitZoom, pickBody } from './mapPlot3d';

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
  it('fills a wide panel by height and a narrow one by width, within the zoom limits', () => {
    const wide = fitDistance(2.0, 0.6), square = fitDistance(1.0, 0.6), tall = fitDistance(0.5, 0.6);
    expect(tall).toBeGreaterThan(square);
    expect(square).toBeGreaterThanOrEqual(wide);
    // At the fitted distance the plot's half-width is 88% of the view's.
    const tanHalf = Math.tan((42 * Math.PI) / 360);
    expect(PLOT_RADIUS / (tall * tanHalf * 0.5)).toBeCloseTo(0.88, 9);
    expect(fitDistance(0.01, 0.6)).toBe(DIST_MAX);
    expect(fitDistance(50, 0.12)).toBeGreaterThanOrEqual(DIST_MIN);
  });

  it('comes closer as the view tips flatter, since the ring foreshortens', () => {
    expect(fitDistance(1.0, 0.3)).toBeLessThanOrEqual(fitDistance(1.0, 1.2));
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
