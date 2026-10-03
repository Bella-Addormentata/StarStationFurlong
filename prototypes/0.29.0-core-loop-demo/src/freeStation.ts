/**
 * 🅿️ A one-module station flown by hand (Dorkmo 2026-10-03 17:35, "Fly and
 * park"): its welcome room undocks and flies like any ship (freeFlight.ts),
 * docking at it is closed while it flies, and PARK settles it into the
 * circular orbit through where it stopped. That orbit is kept the way an
 * ALTITUDE change keeps one (PR 202): as a StationMove of mode 'orbit',
 * whose arrival orbit listStations fills into StationRecord.orbit and the
 * trim stick then holds.
 *
 * An orbit move must be the Hohmann transfer its two orbits make
 * (stationMove.orbitChangeFits), so PARK writes the one that ARRIVES where
 * the station stopped, at the moment it stopped: it leaves from an orbit
 * PARK_FROM_OFFSET_KM higher, half a transfer earlier, phased so its
 * arrival point is the park point. That leg is in the past and is never
 * flown or drawn; what counts is the orbit it arrives in.
 */

import type { FreePose } from './freeFlight';
import { MIN_ALTITUDE_KM, circularOrbit, maxAltitudeKm, orbitalSeconds, planOrbitChange, realMsFor, wrapAngle } from './orbits';
import { altitudeConflict, formatAltitude, isStationMove, orbitsToKeepClear } from './stationMove';
import { FUEL_METER_MAX } from './shipDoc';
import { MIN_ORBIT_SEPARATION_KM, planetById } from './stations';
import type { StationMove, StationRecord } from './stations';

/** How much higher the (unflown) leg PARK records leaves from, km. */
export const PARK_FROM_OFFSET_KM = 1;

export type StationParkResult =
  | { ok: true; move: StationMove }
  | { ok: false; reason: string };

/**
 * The orbit move that parks `station` where `pose` stopped (a still pose at
 * `pose.at`), or why it cannot park there: outside the altitude band, or
 * within MIN_ORBIT_SEPARATION_KM of another station's or slot's orbit.
 * `drawn` and `deficit` are the move fuel meter's, as for an altitude change
 * (the flight's fuel was taken at the stick, so the move itself costs none).
 */
export function planStationPark(
  station: StationRecord,
  pose: FreePose,
  stations: StationRecord[],
  drawn: number,
  deficit: number,
): StationParkResult {
  const planet = planetById(station.planetId);
  if (planetById(pose.planetId).id !== planet.id) return { ok: false, reason: 'The station flies at another planet than its own.' };
  const r = pose.radiusKm;
  const altitude = r - planet.radiusKm;
  if (altitude < MIN_ALTITUDE_KM) return { ok: false, reason: `Too low to park: ${formatAltitude(MIN_ALTITUDE_KM)} is the lowest orbit clear of the atmosphere.` };
  if (altitude > maxAltitudeKm(planet.id)) return { ok: false, reason: `Too high to park: ${formatAltitude(maxAltitudeKm(planet.id))} is the highest orbit around ${planet.name}.` };
  const near = altitudeConflict(r, orbitsToKeepClear(station, stations, pose.at));
  if (near) {
    const whose = near.name ? `${near.name}'s orbit` : 'another slot\'s orbit';
    return { ok: false, reason: `Too close to ${whose} at ${formatAltitude(near.radiusKm - planet.radiusKm)} to park: keep ${MIN_ORBIT_SEPARATION_KM} km clear.` };
  }
  // The unflown leg: from just above, half a transfer before the stop.
  const r1 = r + PARK_FROM_OFFSET_KM;
  const transferS = Math.PI * Math.sqrt(((r1 + r) / 2) ** 3 / planet.mu);
  const departAt = pose.at - Math.round(realMsFor(transferS));
  const n1 = Math.sqrt(planet.mu / r1 ** 3);
  // planOrbitChange arrives opposite where it left: phase the leg so that is
  // the park point.
  const from = circularOrbit(planet, r1, wrapAngle(pose.angle - Math.PI - n1 * orbitalSeconds(departAt)));
  const plan = planOrbitChange(from, r, departAt);
  if (!plan) return { ok: false, reason: 'The station cannot park here.' };
  const move: StationMove = {
    stationId: station.id,
    welcomeRoomId: station.welcomeRoomId,
    fromPlanetId: planet.id,
    fromSlot: station.orbitSlot,
    toPlanetId: planet.id,
    toSlot: station.orbitSlot,
    departAt: plan.departAt,
    arriveAt: plan.arriveAt,
    mode: 'orbit',
    orbit: {
      fromRadiusKm: plan.from.radiusKm,
      fromPhase0: plan.from.phase0,
      toRadiusKm: plan.to.radiusKm,
      toPhase0: plan.to.phase0,
    },
    bookedAt: pose.at,
    fuel: 0,
    fuelDrawn: Math.min(FUEL_METER_MAX, Math.max(0, drawn + deficit)),
  };
  return isStationMove(move) ? { ok: true, move } : { ok: false, reason: 'The station cannot park here.' };
}
