/**
 * ☀️ solarOrbits — planets around the sun on the shared clock, and Hohmann
 * transfers between planets.
 */
import { describe, expect, it } from 'vitest';
import { ORBIT_EPOCH_MS, orbitForSlot, realMsFor, wrapAngle } from './orbits';
import {
  AU_KM,
  interplanetaryPointAt,
  planPlanetTransfer,
  planetSunOrbit,
  planetSunPointAt,
  sunAngleAt,
} from './solarOrbits';

const SOV = 'planet-sovereign';
const ARIS = 'planet-aris';
const station = (planetId: string, orbitSlot = 0) => ({ id: `${planetId}-${orbitSlot}`, planetId, orbitSlot });
const DAY_S = 86_400;

const angleGap = (a: number, b: number) => {
  const d = wrapAngle(a - b);
  return d > Math.PI ? d - 2 * Math.PI : d;
};

describe('planets around the sun', () => {
  it('gives Sovereign II an Earth year at 1 AU: about six real days on the 60x clock', () => {
    const o = planetSunOrbit(SOV);
    expect(o.radiusKm).toBeCloseTo(AU_KM, 0);
    expect(o.periodS / DAY_S).toBeCloseTo(365.25, 0);
    expect(o.speedKmS).toBeCloseTo(29.78, 1);
    expect(realMsFor(o.periodS) / 3_600_000 / 24).toBeCloseTo(6.09, 1);
  });

  it('puts Aris Prime inside, on a shorter year (Kepler\'s third law)', () => {
    const sov = planetSunOrbit(SOV);
    const aris = planetSunOrbit(ARIS);
    expect(aris.radiusKm).toBeLessThan(sov.radiusKm);
    expect((sov.periodS / aris.periodS) ** 2).toBeCloseTo((sov.radiusKm / aris.radiusKm) ** 3, 9);
  });

  it('starts where the holotable drew the planets and derives position from the clock', () => {
    expect(sunAngleAt(planetSunOrbit(SOV), ORBIT_EPOCH_MS)).toBeCloseTo(1.2, 12);
    expect(sunAngleAt(planetSunOrbit(ARIS), ORBIT_EPOCH_MS)).toBeCloseTo(0.5, 12);
    const o = planetSunOrbit(ARIS);
    const t = ORBIT_EPOCH_MS + 987_654_321;
    expect(angleGap(planetSunPointAt(ARIS, t + realMsFor(o.periodS)).angle, planetSunPointAt(ARIS, t).angle)).toBeCloseTo(0, 6);
  });
});

describe('Hohmann transfers between planets', () => {
  const now = ORBIT_EPOCH_MS + 3_210_000_000;

  it('has no plan between stations around the same planet', () => {
    expect(planPlanetTransfer(station(SOV, 0), station(SOV, 3), now)).toBeNull();
  });

  it('takes the textbook time: about four orbital months, two real days', () => {
    const plan = planPlanetTransfer(station(SOV), station(ARIS), now)!;
    const a = (planetSunOrbit(SOV).radiusKm + planetSunOrbit(ARIS).radiusKm) / 2 / AU_KM;
    const halfYearsDays = 0.5 * a ** 1.5 * 365.25;
    expect((plan.transferMs / 1000) * 60 / DAY_S).toBeCloseTo(halfYearsDays, 0);
    expect(plan.transferMs / 3_600_000).toBeGreaterThan(40);
    expect(plan.transferMs / 3_600_000).toBeLessThan(60);
  });

  it('leaves at a launch window: arriving exactly where the target planet is', () => {
    for (const [from, to] of [[SOV, ARIS], [ARIS, SOV]]) {
      const plan = planPlanetTransfer(station(from), station(to), now)!;
      expect(plan.waitMs).toBeGreaterThanOrEqual(0);
      expect(plan.waitMs).toBeLessThan(plan.synodicMs);
      const start = interplanetaryPointAt(plan, plan.departAt + 1);
      expect(start.radiusKm / planetSunOrbit(from).radiusKm).toBeCloseTo(1, 4);
      expect(angleGap(start.angle, planetSunPointAt(from, plan.departAt).angle)).toBeCloseTo(0, 4);
      const end = interplanetaryPointAt(plan, plan.arriveAt - 1);
      const target = planetSunPointAt(to, plan.arriveAt);
      expect(end.radiusKm / target.radiusKm).toBeCloseTo(1, 4);
      expect(angleGap(end.angle, target.angle)).toBeCloseTo(0, 4);
      expect(end.leg).toBe('transfer');
    }
  });

  it('repeats windows every synodic period, and a plan asked at a window leaves at once', () => {
    const plan = planPlanetTransfer(station(SOV), station(ARIS), now)!;
    const next = planPlanetTransfer(station(SOV), station(ARIS), plan.departAt + 1)!;
    expect(next.departAt - plan.departAt).toBeCloseTo(plan.synodicMs, -2);
    const atWindow = planPlanetTransfer(station(SOV), station(ARIS), plan.departAt)!;
    expect(atWindow.waitMs).toBeLessThan(1000);
  });

  it('leaves at once when asked at any window\'s exact time, never a synodic period later', () => {
    for (let i = 0; i < 400; i++) {
      const [a, b] = i % 2 ? [ARIS, SOV] : [SOV, ARIS];
      const plan = planPlanetTransfer(station(a), station(b), now + i * 7_777_777)!;
      const again = planPlanetTransfer(station(a), station(b), plan.departAt)!;
      expect(again.waitMs).toBe(0);
      expect(again.departAt).toBe(plan.departAt);
    }
  });

  it('prices the burns from each station\'s own orbit (patched conics)', () => {
    const low = planPlanetTransfer(station(SOV, 0), station(ARIS, 0), now)!;
    const high = planPlanetTransfer(station(SOV, 8), station(ARIS, 0), now)!;
    // Escaping from higher up starts closer to escape speed, so costs less.
    expect(high.deltaVKmS).toBeLessThan(low.deltaVKmS);
    expect(low.vInfDepartKmS).toBeCloseTo(high.vInfDepartKmS, 12);
    // From low Sovereign orbit the escape burn alone is a few km/s, like LEO to Venus.
    const r = orbitForSlot(SOV, 0).radiusKm;
    const escape = Math.sqrt(low.vInfDepartKmS ** 2 + (2 * 398600.4418) / r) - Math.sqrt(398600.4418 / r);
    expect(escape).toBeGreaterThan(3);
    expect(escape).toBeLessThan(5);
    expect(low.deltaVKmS).toBeGreaterThan(escape);
  });

  it('sits with the origin planet before the burn and the target after', () => {
    const plan = planPlanetTransfer(station(ARIS), station(SOV), now)!;
    expect(interplanetaryPointAt(plan, now).leg).toBe('waiting');
    const after = interplanetaryPointAt(plan, plan.arriveAt + 5_000_000);
    expect(after.leg).toBe('arrived');
    expect(angleGap(after.angle, planetSunPointAt(SOV, plan.arriveAt + 5_000_000).angle)).toBeCloseTo(0, 9);
  });
});
