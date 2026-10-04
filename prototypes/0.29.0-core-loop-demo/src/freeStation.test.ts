/**
 * 🅿️ freeStation — a one-module station parks into the orbit through where
 * it stopped, kept as an altitude change's arrival orbit.
 */
import { describe, expect, it } from 'vitest';
import type { FreePose } from './freeFlight';
import { planStationPark } from './freeStation';
import { ORBIT_EPOCH_MS, baseOrbit, orbitForSlot, angleAt } from './orbits';
import { isStationMove } from './stationMove';
import { DEFAULT_PLANET_ID, DEFAULT_STATION_RECORD, MIN_ORBIT_SEPARATION_KM, orbitAfterMove } from './stations';

const T = ORBIT_EPOCH_MS + 5 * 3_600_000;
const station = DEFAULT_STATION_RECORD;

function stillAt(radiusKm: number, angle = 1.2): FreePose {
  return { planetId: DEFAULT_PLANET_ID, at: T, radiusKm, angle, vAlong: 0, vRadial: 0, heading: 0, parked: true };
}

describe('🅿️ parking a station', () => {
  const r0 = orbitForSlot(DEFAULT_PLANET_ID, 0).radiusKm;
  const r1 = orbitForSlot(DEFAULT_PLANET_ID, 1).radiusKm;
  const mid = (r0 + r1) / 2;

  it('writes an orbit move that arrives on a circle through the park point, at the stop', () => {
    const res = planStationPark(station, stillAt(mid), [station], 7, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isStationMove(res.move)).toBe(true);
    expect(res.move.mode).toBe('orbit');
    expect(Math.abs(res.move.arriveAt - T)).toBeLessThanOrEqual(1);
    expect(res.move.departAt).toBeLessThan(T);
    expect(res.move.fuel).toBe(0);
    expect(res.move.fuelDrawn).toBe(9);
    const orbit = orbitAfterMove(res.move, T + 1000);
    expect(orbit?.radiusKm).toBeCloseTo(mid, 6);
    const at = baseOrbit({ ...station, orbit });
    expect(angleAt(at, res.move.arriveAt)).toBeCloseTo(1.2, 6);
  });

  it('refuses within the separation of another slot\'s orbit, and out of the band', () => {
    const near = planStationPark(station, stillAt(r1 - MIN_ORBIT_SEPARATION_KM / 2), [station], 0, 0);
    expect(near.ok).toBe(false);
    const low = planStationPark(station, stillAt(6371 + 150), [station], 0, 0);
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.reason).toMatch(/Too low/);
  });
});
