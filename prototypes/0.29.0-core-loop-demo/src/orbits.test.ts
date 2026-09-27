/**
 * 🪐 orbits — circular station orbits on the shared clock, and Hohmann
 * transfers between them.
 */
import { describe, expect, it } from 'vitest';
import {
  ORBIT_EPOCH_MS,
  ORBIT_TIME_SCALE,
  SLOT0_ALTITUDE_KM,
  angleAt,
  orbitForSlot,
  planTransfer,
  realMsFor,
  stationPointAt,
  transferPointAt,
  wrapAngle,
} from './orbits';
import { DEFAULT_PLANET_ID, planetById } from './stations';

const SOV = DEFAULT_PLANET_ID;
const MU = planetById(SOV).mu;
const station = (orbitSlot: number, planetId = SOV) => ({ id: `s${orbitSlot}-${planetId}`, planetId, orbitSlot });

/** Signed smallest difference between two angles. */
const angleGap = (a: number, b: number) => {
  const d = wrapAngle(a - b);
  return d > Math.PI ? d - 2 * Math.PI : d;
};

describe('circular station orbits', () => {
  it('puts slot 0 in a low orbit with the textbook period and speed', () => {
    const o = orbitForSlot(SOV, 0);
    expect(o.altitudeKm).toBeCloseTo(SLOT0_ALTITUDE_KM, 6);
    expect(o.periodS / 60).toBeCloseTo(92.4, 1); // minutes, like a 400 km orbit around Earth
    expect(o.speedKmS).toBeCloseTo(7.67, 2);
  });

  it('obeys Kepler\'s third law from slot to slot', () => {
    const inner = orbitForSlot(SOV, 1);
    const outer = orbitForSlot(SOV, 4);
    expect(outer.radiusKm).toBeGreaterThan(inner.radiusKm);
    expect((outer.periodS / inner.periodS) ** 2).toBeCloseTo((outer.radiusKm / inner.radiusKm) ** 3, 9);
  });

  it('derives position from the clock: the epoch phase, then one full turn per period', () => {
    const o = orbitForSlot(SOV, 0);
    expect(angleAt(o, ORBIT_EPOCH_MS)).toBeCloseTo(2.1, 12); // where the map always drew Furlong
    const later = ORBIT_EPOCH_MS + 123_456_789;
    const oneTurnLater = later + realMsFor(o.periodS);
    expect(angleGap(angleAt(o, oneTurnLater), angleAt(o, later))).toBeCloseTo(0, 6);
    // A quarter period of REAL time is a quarter turn: the clock runs ORBIT_TIME_SCALE× fast.
    const quarter = (o.periodS / 4 / ORBIT_TIME_SCALE) * 1000;
    expect(angleGap(angleAt(o, later + quarter), angleAt(o, later))).toBeCloseTo(Math.PI / 2, 6);
  });

  it('spreads stations around the planet instead of lining them up', () => {
    const phases = [0, 1, 2, 3].map((slot) => orbitForSlot(SOV, slot).phase0);
    for (let i = 1; i < phases.length; i++) {
      expect(Math.abs(angleGap(phases[i], phases[i - 1]))).toBeGreaterThan(1);
    }
  });
});

describe('Hohmann transfers', () => {
  const NOW = ORBIT_EPOCH_MS + 987_654_321;

  it('has no transfer to itself, across planets, or within one orbit', () => {
    expect(planTransfer(station(0), station(0), NOW)).toBeNull();
    expect(planTransfer(station(0), station(1, 'planet-aris'), NOW)).toBeNull();
    expect(planTransfer(station(2), { id: 'twin', planetId: SOV, orbitSlot: 2 }, NOW)).toBeNull();
  });

  it('takes half the transfer ellipse and prices both burns by vis-viva', () => {
    const plan = planTransfer(station(0), station(2), NOW)!;
    const r1 = orbitForSlot(SOV, 0).radiusKm;
    const r2 = orbitForSlot(SOV, 2).radiusKm;
    const a = (r1 + r2) / 2;
    expect(plan.transferMs).toBeCloseTo(realMsFor(Math.PI * Math.sqrt(a ** 3 / MU)), 6);
    const visViva = (r: number) => Math.sqrt(MU * (2 / r - 1 / a));
    const dv = (visViva(r1) - Math.sqrt(MU / r1)) + (Math.sqrt(MU / r2) - visViva(r2));
    expect(plan.deltaVKmS).toBeCloseTo(dv, 9);
    expect(plan.arriveAt - plan.departAt).toBeCloseTo(plan.transferMs, 2); // epoch-sized ms lose digits
  });

  it('waits for the next launch window, never longer than one synodic period', () => {
    const plan = planTransfer(station(0), station(1), NOW)!;
    expect(plan.waitMs).toBeGreaterThanOrEqual(0);
    expect(plan.waitMs).toBeLessThan(plan.synodicMs);
    expect(plan.departAt).toBeCloseTo(NOW + plan.waitMs, 6);
    // Asking just before the window finds that window; just after, the next one.
    expect(planTransfer(station(0), station(1), plan.departAt - 1)!.departAt).toBeCloseTo(plan.departAt, 0);
    expect(planTransfer(station(0), station(1), plan.departAt + 1)!.departAt)
      .toBeCloseTo(plan.departAt + plan.synodicMs, 0);
  });

  it.each([
    ['outbound', 0, 3],
    ['inbound', 3, 1],
  ])('meets the target station on arrival (%s)', (_label, fromSlot, toSlot) => {
    const plan = planTransfer(station(fromSlot), station(toSlot), NOW)!;
    const target = stationPointAt(station(toSlot), plan.arriveAt);
    // One real millisecond out is one orbital minute's sixtieth: a few km.
    const ship = transferPointAt(plan, plan.arriveAt - 1);
    expect(ship.leg).toBe('transfer');
    expect(Math.abs(ship.radiusKm - target.radiusKm)).toBeLessThan(1);
    expect(Math.abs(angleGap(ship.angle, target.angle))).toBeLessThan(1e-3);
    // …having left opposite that point, alongside the origin station.
    const origin = stationPointAt(station(fromSlot), plan.departAt);
    const leaving = transferPointAt(plan, plan.departAt + 1);
    expect(leaving.leg).toBe('transfer');
    expect(Math.abs(leaving.radiusKm - origin.radiusKm)).toBeLessThan(1);
    expect(Math.abs(angleGap(leaving.angle, origin.angle))).toBeLessThan(1e-3);
    expect(Math.abs(angleGap(target.angle, origin.angle))).toBeCloseTo(Math.PI, 5);
  });

  it('rides with the origin station before the burn and the target after arrival', () => {
    const plan = planTransfer(station(1), station(2), NOW)!;
    const before = transferPointAt(plan, plan.departAt - 5_000);
    expect(before.leg).toBe('waiting');
    expect(before).toMatchObject(stationPointAt(station(1), plan.departAt - 5_000));
    const after = transferPointAt(plan, plan.arriveAt + 5_000);
    expect(after.leg).toBe('arrived');
    expect(after).toMatchObject(stationPointAt(station(2), plan.arriveAt + 5_000));
  });

  it('climbs steadily outward along the ellipse', () => {
    const plan = planTransfer(station(0), station(4), NOW)!;
    let last = plan.from.radiusKm;
    for (let i = 1; i < 10; i++) {
      const p = transferPointAt(plan, plan.departAt + (plan.transferMs * i) / 10);
      expect(p.radiusKm).toBeGreaterThan(last);
      expect(p.radiusKm).toBeLessThan(plan.to.radiusKm);
      last = p.radiusKm;
    }
  });

  it('keeps low hops short: about a minute of flying, a window every few minutes', () => {
    const plan = planTransfer(station(0), station(1), NOW)!;
    expect(plan.transferMs).toBeGreaterThan(30_000);
    expect(plan.transferMs).toBeLessThan(120_000);
    expect(plan.synodicMs).toBeLessThan(10 * 60_000);
  });
});
