/**
 * ☀️ Solar orbits — the planets around the sun, and the Hohmann transfers a
 * station (or ship) flies from one planet to another.
 *
 * The first step toward moving a station to another planet (owner ask,
 * 2026-09-27: slowly under its own thrusters, or fast behind a tug). The owner
 * picked TRUE PHYSICS on the shared 60× clock, so nothing here is compressed:
 * Sovereign II sits at 1 AU and goes round once a year (about six real days),
 * and a trip to Aris Prime takes about four months of orbital time (about two
 * real days), leaving only at launch windows several real days apart.
 *
 * Same simplifications as orbits.ts, one level up:
 *  - every planet's orbit is a perfect CIRCLE, prograde, in one plane (the
 *    sun's equator, which every planet's equator lies in too — so the planet
 *    frame's XZ plane and angles carry straight over);
 *  - only the sun pulls between the planets, only the planet pulls near it
 *    (patched conics): leaving a planet costs the burn from the station's
 *    circular orbit onto the escape hyperbola, and arriving the same again;
 *  - derive, don't tick: a planet's position is a pure function of the clock.
 *
 * Units as orbits.ts: km, radians, ORBITAL seconds for physics, and every
 * `…Ms`/`…At` value in REAL milliseconds.
 *
 * Pure: no DOM, no Three, no docs. Pinned by solarOrbits.test.ts.
 */

import { orbitalSeconds, realMsFor, solveKepler, stationOrbit, wrapAngle } from './orbits';
import type { OrbitPoint, OrbitingStation } from './orbits';
import { planetById } from './stations';

const TAU = 2 * Math.PI;

/** One astronomical unit, km. */
export const AU_KM = 149_597_870.7;

/** The sun: a G2V star like ours, so its GM is the Sun's (km³/s²). */
export const SUN = { id: 'star-sol', name: 'SOL PRIME', mu: 1.32712440018e11 } as const;

/**
 * Each planet's distance from the sun and where it stood at the epoch. The
 * distances keep the holotable's proportions (Aris at 100, Sovereign at 180);
 * the epoch angles are the ones the holotable always drew them at. Unknown
 * planets fall back to the default planet's orbit, like planetById.
 */
const SUN_ORBITS: Record<string, { au: number; phase0: number }> = {
  'planet-sovereign': { au: 1, phase0: 1.2 },
  'planet-aris': { au: 100 / 180, phase0: 0.5 },
};

export interface SunOrbit {
  planetId: string;
  /** From the sun's centre, km. */
  radiusKm: number;
  /** Orbital seconds per revolution — the planet's year. */
  periodS: number;
  speedKmS: number;
  /** Radians per orbital second. */
  meanMotion: number;
  /** Angle at the epoch, radians. */
  phase0: number;
}

/** A planet's circular orbit around the sun. */
export function planetSunOrbit(planetId: string): SunOrbit {
  const planet = planetById(planetId);
  const entry = SUN_ORBITS[planet.id] ?? SUN_ORBITS['planet-sovereign'];
  const radiusKm = entry.au * AU_KM;
  const meanMotion = Math.sqrt(SUN.mu / radiusKm ** 3);
  return {
    planetId: planet.id,
    radiusKm,
    periodS: TAU / meanMotion,
    speedKmS: Math.sqrt(SUN.mu / radiusKm),
    meanMotion,
    phase0: wrapAngle(entry.phase0),
  };
}

/** Where on its orbit a planet is at a real time (radians, [0, 2π)). */
export function sunAngleAt(orbit: SunOrbit, realMs: number): number {
  return wrapAngle(orbit.phase0 + orbit.meanMotion * orbitalSeconds(realMs));
}

/** A planet's position at a real time, sun-centred, in the shared plane. */
export function planetSunPointAt(planetId: string, realMs: number): OrbitPoint {
  const orbit = planetSunOrbit(planetId);
  return { radiusKm: orbit.radiusKm, angle: sunAngleAt(orbit, realMs) };
}

// ── Transfers between planets ────────────────────────────────────────────────

export interface InterplanetaryPlan {
  fromId: string;
  toId: string;
  from: SunOrbit;
  to: SunOrbit;
  /** Real ms of the departure burn — the next launch window at or after the
   *  time asked about. */
  departAt: number;
  /** Real ms of the capture burn, back in orbit at the target planet. */
  arriveAt: number;
  waitMs: number;
  /** arriveAt − departAt: half the transfer ellipse around the sun. */
  transferMs: number;
  /** Real ms between launch windows for this pair of planets. */
  synodicMs: number;
  /** Speed left over after escaping the origin planet, and to shed on
   *  arrival (hyperbolic excess), km/s. */
  vInfDepartKmS: number;
  vInfArriveKmS: number;
  /** Escape burn from the origin station's orbit plus capture burn into the
   *  target orbit, km/s — what propellant or a tug's fuel is priced on. */
  deltaVKmS: number;
}

/** The departure (or capture) burn between a circular orbit of `rKm` around a
 *  body of `mu` and a hyperbola leaving with excess speed `vInf`. */
function hyperbolicBurn(mu: number, rKm: number, vInf: number): number {
  return Math.sqrt(vInf ** 2 + (2 * mu) / rKm) - Math.sqrt(mu / rKm);
}

/**
 * The next Hohmann transfer that carries something in orbit around one planet
 * to an orbit around another, at or after `nowMs` — or null when both orbits
 * are around the same planet (orbits.ts planTransfer covers that).
 *
 * `from` / `to` name the orbits at each end: a station's planet and slot (and
 * its trim, through stationOrbit). The window is found exactly as planTransfer
 * finds it, with the planets in place of the stations.
 */
export function planPlanetTransfer(
  from: OrbitingStation & { id: string },
  to: OrbitingStation & { id: string },
  nowMs: number,
): InterplanetaryPlan | null {
  const p1 = planetById(from.planetId);
  const p2 = planetById(to.planetId);
  if (p1.id === p2.id) return null;
  const o1 = planetSunOrbit(p1.id);
  const o2 = planetSunOrbit(p2.id);
  const r1 = o1.radiusKm;
  const r2 = o2.radiusKm;
  if (r1 === r2) return null;
  const a = (r1 + r2) / 2;
  const tH = Math.PI * Math.sqrt(a ** 3 / SUN.mu);
  const vInfDepart = Math.abs(Math.sqrt(SUN.mu / r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1));
  const vInfArrive = Math.abs(Math.sqrt(SUN.mu / r2) * (1 - Math.sqrt((2 * r1) / (r1 + r2))));
  const dv = hyperbolicBurn(p1.mu, stationOrbit(from).radiusKm, vInfDepart)
    + hyperbolicBurn(p2.mu, stationOrbit(to).radiusKm, vInfArrive);

  const neededLead = wrapAngle(Math.PI - o2.meanMotion * tH);
  const leadNow = wrapAngle(sunAngleAt(o2, nowMs) - sunAngleAt(o1, nowMs));
  const drift = o2.meanMotion - o1.meanMotion;
  const turn = drift > 0 ? wrapAngle(neededLead - leadNow) : wrapAngle(leadNow - neededLead);
  const synodicMs = realMsFor(TAU / Math.abs(drift));
  let waitMs = realMsFor(turn / Math.abs(drift));
  // Asked at a window's own instant, rounding can put the window a hair
  // behind `nowMs`, and the wrapped turn becomes a full synodic period:
  // snap that (and a hair ahead) to "leave now".
  if (waitMs <= 0.1 || synodicMs - waitMs <= 0.1) waitMs = 0;
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
    synodicMs,
    vInfDepartKmS: vInfDepart,
    vInfArriveKmS: vInfArrive,
    deltaVKmS: dv,
  };
}

export type InterplanetaryLeg = 'waiting' | 'transfer' | 'arrived';

/**
 * Where something on a planned transfer between planets is at a real time,
 * sun-centred: with its origin planet until the departure burn, on the
 * transfer ellipse between the burns, and with the target planet after. The
 * time spent climbing out of and down into each planet's pull is folded into
 * the burns (at this scale it is minutes against months).
 */
export function interplanetaryPointAt(
  plan: InterplanetaryPlan,
  realMs: number,
): OrbitPoint & { leg: InterplanetaryLeg; speedKmS: number } {
  if (realMs <= plan.departAt) {
    return { radiusKm: plan.from.radiusKm, angle: sunAngleAt(plan.from, realMs), leg: 'waiting', speedKmS: plan.from.speedKmS };
  }
  if (realMs >= plan.arriveAt) {
    return { radiusKm: plan.to.radiusKm, angle: sunAngleAt(plan.to, realMs), leg: 'arrived', speedKmS: plan.to.speedKmS };
  }
  const r1 = plan.from.radiusKm;
  const r2 = plan.to.radiusKm;
  const a = (r1 + r2) / 2;
  const e = Math.abs(r2 - r1) / (r1 + r2);
  const n = Math.sqrt(SUN.mu / a ** 3);
  const outbound = r2 > r1;
  const departAngle = sunAngleAt(plan.from, plan.departAt);
  const periapsisAngle = outbound ? departAngle : departAngle + Math.PI;
  const elapsedS = orbitalSeconds(realMs) - orbitalSeconds(plan.departAt);
  const M = (outbound ? 0 : Math.PI) + n * elapsedS;
  const E = solveKepler(M, e);
  const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const radiusKm = a * (1 - e * Math.cos(E));
  return {
    radiusKm,
    angle: wrapAngle(periapsisAngle + trueAnomaly),
    leg: 'transfer',
    speedKmS: Math.sqrt(SUN.mu * (2 / radiusKm - 1 / a)),
  };
}
