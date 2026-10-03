/**
 * 🕹️ freeFlight — a ship flown by hand (issue 203): coasting on the
 * circular-orbit rule, the speed zones and the hull bubble, the stick.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROACH_MAX_KMS,
  APPROACH_ZONE_KM,
  DOCK_MAX_KMS,
  DOCK_ZONE_KM,
  FREE_FUEL_PER_KMS,
  HULL_KM,
  MAX_POSE_AHEAD_MS,
  NO_INPUT,
  OPEN_MAX_KMS,
  UNDOCK_OFFSET_KM,
  YAW_RATE,
  applyZones,
  bodyOffset,
  cleanPose,
  coastGrid,
  coastTo,
  isFreePose,
  nearestStation,
  offsetFrom,
  parkCost,
  parkPose,
  pointOff,
  propagate,
  readout,
  speedOf,
  stepPilot,
  undockPose,
} from './freeFlight';
import type { FreePose, FreeStation } from './freeFlight';
import { ORBIT_EPOCH_MS, angleAt, circularOrbit, orbitForSlot, realMsFor } from './orbits';
import { DEFAULT_PLANET_ID, planetById } from './stations';

const SOV = DEFAULT_PLANET_ID;
const T0 = ORBIT_EPOCH_MS + 3_600_000;

function stationAt(slot: number, name = `Station ${slot}`): FreeStation {
  const orbit = orbitForSlot(SOV, slot);
  return { id: `st-${slot}`, room: `room-${slot}`, name, pointAt: (ms) => ({ radiusKm: orbit.radiusKm, angle: angleAt(orbit, ms) }) };
}

/** A pose `along`/`radial` km off `st` at `ms`, open orbit (no frame). */
function poseOff(st: FreeStation, ms: number, along: number, radial: number, v: Partial<FreePose> = {}): FreePose {
  const p = pointOff(st.pointAt(ms), along, radial);
  return { planetId: SOV, at: ms, radiusKm: p.radiusKm, angle: p.angle, vAlong: 0, vRadial: 0, heading: 0, ...v };
}

describe('coasting', () => {
  it('holds a circular orbit at its own radius with no velocity of its own', () => {
    const radiusKm = orbitForSlot(SOV, 2).radiusKm + 37;
    const pose: FreePose = { planetId: SOV, at: T0, radiusKm, angle: 1, vAlong: 0, vRadial: 0, heading: 0 };
    const orbit = circularOrbit(planetById(SOV), radiusKm, 0);
    const later = propagate(pose, T0 + 20_000, []);
    const turned = orbit.meanMotion * (20 * 60);
    expect(later.radiusKm).toBeCloseTo(radiusKm, 9);
    expect(later.angle).toBeCloseTo((1 + turned) % (2 * Math.PI), 9);
  });

  it('climbs at vRadial, and stops climbing at the top of the planet\'s pull', () => {
    const r0 = orbitForSlot(SOV, 3).radiusKm;
    const pose: FreePose = { planetId: SOV, at: T0, radiusKm: r0, angle: 0, vAlong: 0, vRadial: 1, heading: 0 };
    expect(propagate(pose, T0 + 1000, []).radiusKm).toBeCloseTo(r0 + 60, 6);
    const far = propagate(pose, T0 + 2 * 24 * 3600_000, []);
    expect(far.radiusKm).toBeCloseTo(orbitForSlot(SOV, 15).radiusKm * 1.1, 3);
    expect(far.vRadial).toBe(0);
  });

  it('never sinks below the floor', () => {
    const planet = planetById(SOV);
    const pose: FreePose = { planetId: SOV, at: T0, radiusKm: planet.radiusKm + 400, angle: 0, vAlong: 0, vRadial: -2, heading: 0 };
    const p = propagate(pose, T0 + 600_000, []);
    expect(p.radiusKm).toBeCloseTo(planet.radiusKm + 150, 6);
    expect(p.vRadial).toBe(0);
  });

  it('keeps its offset from a station while held in its frame', () => {
    const st = stationAt(0);
    const pose: FreePose = { ...poseOff(st, T0, 5, -2), near: { room: st.room, along: 5, radial: -2 } };
    const later = propagate(pose, T0 + 90_000, [st]);
    const off = offsetFrom(st.pointAt(T0 + 90_000), later);
    expect(off.along).toBeCloseTo(5, 6);
    expect(off.radial).toBeCloseTo(-2, 6);
  });

  it('falls back to its own orbit when the station it was held by is unknown', () => {
    const st = stationAt(0);
    const pose: FreePose = { ...poseOff(st, T0, 5, 0), near: { room: 'gone', along: 5, radial: 0 } };
    const later = propagate(pose, T0 + 1000, [st]);
    expect(later.near).toBeUndefined();
  });
});

describe('speed zones', () => {
  it('takes up a station\'s frame inside its approach zone and caps the speed', () => {
    const st = stationAt(0);
    const pose = poseOff(st, T0, -30, 0, { vAlong: 1.5 });
    const z = applyZones(pose, [st]);
    expect(z.changed).toBe(true);
    expect(z.pose.near?.room).toBe(st.room);
    expect(z.pose.near?.along).toBeCloseTo(-30, 4);
    expect(speedOf(z.pose)).toBeCloseTo(APPROACH_MAX_KMS, 9);
  });

  it('crawls in the docking zone', () => {
    const st = stationAt(0);
    const pose: FreePose = { ...poseOff(st, T0, -1, 0, { vAlong: APPROACH_MAX_KMS }), near: { room: st.room, along: -1, radial: 0 } };
    expect(speedOf(applyZones(pose, [st]).pose)).toBeCloseTo(DOCK_MAX_KMS, 9);
  });

  it('leaves the frame only past the zone\'s edge and a margin', () => {
    const st = stationAt(0);
    const at = (along: number): FreePose => ({ ...poseOff(st, T0, along, 0), near: { room: st.room, along, radial: 0 } });
    expect(applyZones(at(-APPROACH_ZONE_KM * 1.05), [st]).pose.near).toBeDefined();
    expect(applyZones(at(-APPROACH_ZONE_KM * 1.2), [st]).pose.near).toBeUndefined();
  });

  it('a ship coasting at full speed at a station slows at each zone and never comes inside the hull', () => {
    const st = stationAt(0);
    // 400 km behind the station on its own orbit, flying at it.
    const r = st.pointAt(T0).radiusKm;
    let pose: FreePose = { planetId: SOV, at: T0, radiusKm: r, angle: st.pointAt(T0).angle - 400 / r, vAlong: OPEN_MAX_KMS, vRadial: 0, heading: 0 };
    let closest = Infinity;
    let sawApproach = false;
    for (let ms = T0 + 200; ms <= T0 + 120_000; ms += 200) {
      pose = coastTo(pose, ms, [st]).pose;
      const d = nearestStation(pose, [st])!.distanceKm;
      closest = Math.min(closest, d);
      const speed = speedOf(pose);
      if (d <= APPROACH_ZONE_KM && d > DOCK_ZONE_KM) {
        sawApproach = true;
        expect(speed).toBeLessThanOrEqual(APPROACH_MAX_KMS + 1e-9);
      }
      if (d <= DOCK_ZONE_KM) expect(speed).toBeLessThanOrEqual(DOCK_MAX_KMS + 1e-9);
    }
    expect(sawApproach).toBe(true);
    expect(closest).toBeGreaterThanOrEqual(HULL_KM - 1e-6);
    expect(closest).toBeLessThan(DOCK_ZONE_KM);
  });

  it('stops dead at the hull bubble, and backs off it under thrust', () => {
    const st = stationAt(0);
    let pose: FreePose = { ...poseOff(st, T0, -1, 0.02, { vAlong: DOCK_MAX_KMS }), near: { room: st.room, along: -1, radial: 0.02 } };
    pose = coastTo(pose, T0 + 60_000, [st]).pose;
    expect(Math.hypot(pose.near!.along, pose.near!.radial)).toBeCloseTo(HULL_KM, 9);
    expect(speedOf(pose)).toBe(0);
    // Nose away from the station (retrograde) and thrust: it leaves.
    let backing = { ...pose, heading: Math.PI };
    for (let i = 1; i <= 20; i++) backing = stepPilot(backing, { ...NO_INPUT, thrust: 1 }, T0 + 60_000 + i * 50, 0.05, [st], 100).pose;
    expect(Math.hypot(backing.near!.along, backing.near!.radial)).toBeGreaterThan(HULL_KM);
  });

  it('a long coast still meets the approach zone on the way, not jumping past it', () => {
    const st = stationAt(2);
    // On its circle 3000 km behind, closing at 0.2 km/s: it meets the zone
    // minutes in, long after a fixed-step sampler would give up.
    const at = st.pointAt(T0);
    const pose: FreePose = { planetId: SOV, at: T0, radiusKm: at.radiusKm, angle: at.angle - 3000 / at.radiusKm, vAlong: 0.2, vRadial: 0, heading: 0 };
    const r = coastTo(pose, T0 + 20 * 60_000, [st]);
    expect(r.changed).toBe(true);
    expect(r.pose.near?.room).toBe(st.room);
    const d = Math.hypot(r.pose.near!.along, r.pose.near!.radial);
    expect(d).toBeGreaterThanOrEqual(HULL_KM - 1e-6);
    expect(d).toBeLessThanOrEqual(APPROACH_ZONE_KM * 1.1);
  });

  it('coasts the same however often it is sampled', () => {
    const st = stationAt(0);
    const start = poseOff(st, T0, -200, 3, { vAlong: 1 });
    const once = coastTo(start, T0 + 10_000, [st]).pose;
    let stepped = start;
    // Frame by frame at an odd rate, coasting on from each grid step as the
    // readers cache it.
    let shown = start;
    for (let ms = T0 + 17; ms <= T0 + 10_000; ms += 17) {
      const r = coastTo(stepped, ms, [st]);
      stepped = r.grid;
      shown = r.pose;
    }
    shown = coastTo(stepped, T0 + 10_000, [st]).pose;
    expect(once.near).toBeDefined();
    expect(shown.near?.along).toBeCloseTo(once.near!.along, 6);
    expect(shown.near?.radial).toBeCloseTo(once.near!.radial, 6);
  });

  it('a coast stopped by the safety cap is held there, not carried on unchecked', () => {
    const st = stationAt(2);
    // Crawling just outside the hull bubble: every step stays short.
    const at = st.pointAt(T0);
    const p0 = pointOff(at, HULL_KM + 0.001, 0);
    const pose: FreePose = { planetId: SOV, at: T0, radiusKm: p0.radiusKm, angle: p0.angle, vAlong: 0.001, vRadial: 0, heading: 0, near: { room: st.room, along: HULL_KM + 0.001, radial: 0 } };
    const r = coastTo(pose, T0 + 48 * 3_600_000, [st]);
    expect(r.pose.at).toBe(r.grid.at);
    expect(r.pose.at).toBeLessThan(T0 + 48 * 3_600_000);
  });

  it('a long quiet coast far from every station takes few steps', () => {
    const st = stationAt(0);
    const far = poseOff(stationAt(5), T0, 0, 0);
    const t = performance.now();
    const r = coastGrid(far, T0 + 6 * 3_600_000, [st]);
    expect(performance.now() - t).toBeLessThan(200);
    expect(r.changed).toBe(false);
    expect(T0 + 6 * 3_600_000 - r.pose.at).toBeLessThan(60_000);
  });
});

describe('the stick', () => {
  const st = stationAt(4);
  const open = (): FreePose => poseOff(st, T0, -5000, 0);

  it('thrust pushes along the nose and burns fuel per km/s', () => {
    const h = Math.PI / 2; // nose radial-out
    const r = stepPilot({ ...open(), heading: h }, { ...NO_INPUT, thrust: 1 }, T0, 0.1, [st], 100);
    expect(r.pose.vRadial).toBeGreaterThan(0);
    expect(Math.abs(r.pose.vAlong)).toBeLessThan(1e-12);
    expect(r.fuelUsed).toBeCloseTo(speedOf(r.pose) * FREE_FUEL_PER_KMS, 9);
  });

  it('slides across the nose with strafe', () => {
    const r = stepPilot(open(), { ...NO_INPUT, strafe: 1 }, T0, 0.1, [st], 100);
    // Nose prograde: right of it is radial-out.
    expect(r.pose.vRadial).toBeGreaterThan(0);
    expect(Math.abs(r.pose.vAlong)).toBeLessThan(1e-12);
  });

  it('turns at YAW_RATE without fuel', () => {
    const r = stepPilot(open(), { ...NO_INPUT, yaw: 1 }, T0, 0.2, [st], 0);
    expect(r.pose.heading).toBeCloseTo(YAW_RATE * 0.2, 9);
    expect(r.fuelUsed).toBe(0);
  });

  it('cannot thrust on an empty tank, and the last fuel buys part of a burn', () => {
    expect(speedOf(stepPilot(open(), { ...NO_INPUT, thrust: 1 }, T0, 0.1, [st], 0).pose)).toBe(0);
    const part = stepPilot(open(), { ...NO_INPUT, thrust: 1 }, T0, 0.1, [st], 0.01);
    expect(part.fuelUsed).toBeCloseTo(0.01, 9);
  });

  it('brakes to a stop and never past it', () => {
    let pose: FreePose = { ...open(), vAlong: 0.3, vRadial: -0.4 };
    for (let i = 0; i < 40; i++) pose = stepPilot(pose, { ...NO_INPUT, brake: true }, T0, 0.1, [st], 1000).pose;
    expect(speedOf(pose)).toBeLessThan(1e-12);
  });

  it('never goes past the zone\'s speed limit', () => {
    let pose = open();
    for (let i = 0; i < 100; i++) pose = stepPilot(pose, { ...NO_INPUT, thrust: 1 }, T0, 0.1, [st], 1e6).pose;
    expect(speedOf(pose)).toBeCloseTo(OPEN_MAX_KMS, 9);
  });
});

describe('undock, readout and radar', () => {
  it('UNDOCK leaves the ship still, just behind the station, facing away', () => {
    const st = stationAt(1);
    const pose = undockPose(SOV, T0, st);
    expect(pose.near).toEqual({ room: st.room, along: -UNDOCK_OFFSET_KM, radial: 0 });
    expect(pose.heading).toBeCloseTo(Math.PI, 12);
    expect(speedOf(pose)).toBe(0);
    expect(nearestStation(pose, [st])!.distanceKm).toBeCloseTo(UNDOCK_OFFSET_KM, 6);
    expect(isFreePose(pose)).toBe(true);
    // Out of open orbit: there, still.
    const free = undockPose(SOV, T0, { radiusKm: 9000, angle: -1 });
    expect(free.near).toBeUndefined();
    expect(free.angle).toBeCloseTo(2 * Math.PI - 1, 12);
  });

  it('offers AUTO-DOCK only within the docking zone', () => {
    const st = stationAt(1);
    expect(readout(undockPose(SOV, T0, st), [st]).dockAt).toBe(st);
    expect(readout(poseOff(st, T0, -3, 0), [st]).dockAt).toBeNull();
    expect(readout(poseOff(st, T0, -3, 0), [st]).zone).toBe('approach');
    expect(readout(poseOff(st, T0, -300, 0), [st]).zone).toBe('open');
  });

  it('plots a station ahead of the nose up the radar', () => {
    const st = stationAt(1);
    const pose = poseOff(st, T0, -10, 0);
    const ahead = bodyOffset(pose, st.pointAt(T0));
    // (The orbit curves away below the straight line ahead.)
    expect(ahead.fwd).toBeCloseTo(10, 2);
    expect(Math.abs(ahead.right)).toBeLessThan(0.05);
    // Turned to face radial-out, the station (prograde) is on the left.
    const left = bodyOffset({ ...pose, heading: Math.PI / 2 }, st.pointAt(T0));
    expect(left.right).toBeCloseTo(-10, 2);
  });
});

describe('the record', () => {
  const ok: FreePose = { planetId: SOV, at: T0, radiusKm: 7000, angle: 1, vAlong: 0.1, vRadial: 0, heading: 2 };

  it('accepts a sound pose and folds its angles when cleaned', () => {
    expect(isFreePose(ok)).toBe(true);
    const c = cleanPose({ ...ok, angle: -1, heading: 7, at: T0 + 0.4 });
    expect(c.angle).toBeCloseTo(2 * Math.PI - 1, 12);
    expect(c.heading).toBeCloseTo(7 - 2 * Math.PI, 12);
    expect(c.at).toBe(T0);
  });

  it('refuses junk a peer could write', () => {
    expect(isFreePose(null)).toBe(false);
    expect(isFreePose({ ...ok, vAlong: 50 })).toBe(false);
    expect(isFreePose({ ...ok, radiusKm: -1 })).toBe(false);
    expect(isFreePose({ ...ok, at: 1.5 })).toBe(false);
    expect(isFreePose({ ...ok, angle: Infinity })).toBe(false);
    expect(isFreePose({ ...ok, near: { room: '', along: 0, radial: 0 } })).toBe(false);
    expect(isFreePose({ ...ok, near: { room: 'r', along: 1e6, radial: 0 } })).toBe(false);
    expect(isFreePose({ ...ok, planetId: 'x'.repeat(200) })).toBe(false);
  });

  it('refuses a pose stamped far ahead of the clock, and never coasts backwards', () => {
    expect(isFreePose({ ...ok, at: T0 + MAX_POSE_AHEAD_MS }, T0)).toBe(true);
    expect(isFreePose({ ...ok, at: T0 + MAX_POSE_AHEAD_MS + 1 }, T0)).toBe(false);
    expect(isFreePose({ ...ok, at: Date.now() + 365 * 24 * 3600_000 })).toBe(false);
    const ahead = { ...ok, at: T0 + 5000 };
    expect(propagate(ahead, T0, [])).toEqual(ahead);
  });

  it('runs on the orbital clock', () => {
    // One real second is a minute of orbit: 0.1 km/s for 1 s real is 6 km.
    const st = stationAt(0);
    const pose: FreePose = { ...poseOff(st, T0, -20, 0, { vAlong: 0.1 }), near: { room: st.room, along: -20, radial: 0 } };
    expect(propagate(pose, T0 + realMsFor(60), [st]).near!.along).toBeCloseTo(-14, 9);
  });
});

describe('🅿️ PARK and passing stations', () => {
  it('a slow ship a station passes is passed, not picked up and dragged along', () => {
    const st = stationAt(0);
    const r = st.pointAt(T0).radiusKm - 30;
    const start: FreePose = { planetId: SOV, at: T0, radiusKm: r, angle: st.pointAt(T0).angle - 0.01, vAlong: 0, vRadial: 0, heading: 0 };
    const end = T0 + 60_000;
    let pose = start;
    let held = false;
    for (let ms = T0 + 500; ms <= end; ms += 500) {
      pose = coastTo(pose, ms, [st]).pose;
      if (pose.near) held = true;
    }
    expect(held).toBe(true); // it did pass through the approach zone
    expect(pose.near).toBeUndefined();
    const free = propagate(start, end, []);
    expect(pose.radiusKm).toBeCloseTo(free.radiusKm, 1);
    expect(Math.abs(pose.angle - free.angle)).toBeLessThan(3e-4);
    expect(speedOf(pose)).toBeLessThan(0.005);
  });

  it('parks dead still for the fuel a brake would take, and holds there', () => {
    const st = stationAt(0);
    const moving: FreePose = { ...poseOff(st, T0, -3, 0.5, { vAlong: 0.06, vRadial: -0.08 }), near: { room: st.room, along: -3, radial: 0.5 } };
    expect(parkCost(moving)).toBeCloseTo(0.1 * 10, 9);
    const parked = parkPose(moving);
    expect(parked.parked).toBe(true);
    expect(speedOf(parked)).toBe(0);
    expect(isFreePose(parked)).toBe(true);
    const later = coastTo(parked, T0 + 600_000, [st]);
    expect(later.changed).toBe(false);
    expect(later.pose.near).toEqual({ room: st.room, along: -3, radial: 0.5 });
  });

  it('parked in open space, a station passing close by leaves it where it is', () => {
    const st = stationAt(0);
    const r = st.pointAt(T0).radiusKm - 10;
    const parked = parkPose({ planetId: SOV, at: T0, radiusKm: r, angle: st.pointAt(T0).angle - 0.003, vAlong: 0, vRadial: 0, heading: 0 });
    const end = T0 + 60_000;
    const after = coastTo(parked, end, [st]).pose;
    expect(after.near).toBeUndefined();
    expect(after.angle).toBeCloseTo(propagate(parked, end, []).angle, 9);
  });

  it('turning keeps it parked; thrust or brake takes it out', () => {
    const st = stationAt(4);
    const parked = parkPose(poseOff(st, T0, -5000, 0));
    expect(stepPilot(parked, { ...NO_INPUT, yaw: 1 }, T0, 0.1, [st], 10).pose.parked).toBe(true);
    expect(stepPilot(parked, { ...NO_INPUT, thrust: 1 }, T0, 0.1, [st], 10).pose.parked).toBeUndefined();
    expect(stepPilot(parked, { ...NO_INPUT, brake: true }, T0, 0.1, [st], 10).pose.parked).toBeUndefined();
    expect(isFreePose({ ...parked, parked: false })).toBe(false);
  });
});

