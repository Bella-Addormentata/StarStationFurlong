/**
 * 🕹️ freeFlightPilot — the pose record, the pilot's writes and fuel, and
 * the coast watch (issue 203).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NO_INPUT } from './freeFlight';
import type { FreePose } from './freeFlight';
import {
  WRITE_EVERY_MS,
  isPilotingHere,
  pilotFrame,
  readFreePose,
  releaseStick,
  resetFreeFlightPilot,
  resolvedFreePose,
  settleFreeCoast,
  undockPoseFrom,
  writeFreePose,
} from './freeFlightPilot';
import { bindShipDoc, readFlightRecord, readFuelLevel, writeFlightRecord, writeFuelLevel } from './shipDoc';
import { DEFAULT_STATIONS } from './stationDirectory';
import { DEFAULT_PLANET_ID } from './stations';
import { ORBIT_EPOCH_MS } from './orbits';

const HOME = DEFAULT_STATIONS[0];
const CAP = 100;
let doc: Y.Doc;

/** A pose far out in open space, well away from every station. */
function farPose(at: number): FreePose {
  return { planetId: DEFAULT_PLANET_ID, at, radiusKm: 150_000, angle: 0.3, vAlong: 0, vRadial: 0, heading: 0 };
}

beforeEach(() => {
  doc = new Y.Doc();
  bindShipDoc(doc);
  resetFreeFlightPilot();
  writeFuelLevel(CAP, CAP);
});

afterEach(() => {
  resetFreeFlightPilot();
  doc.destroy();
});

function fly(pose: FreePose): void {
  writeFlightRecord({ status: 'docked', locationId: HOME.id });
  expect(writeFreePose(pose)).toBe(true);
  expect(writeFlightRecord({ status: 'free-flight', locationId: HOME.id })).toBe(true);
}

describe('the pose record', () => {
  it('round-trips, and a malformed one reads as none', () => {
    const now = Date.now();
    expect(writeFreePose(farPose(now))).toBe(true);
    expect(readFreePose()).toEqual(farPose(now));
    doc.getMap('ship').set('freeFlight', { planetId: DEFAULT_PLANET_ID, at: now, radiusKm: 'far' });
    expect(readFreePose()).toBeNull();
    expect(writeFreePose({ ...farPose(now), vAlong: 99 })).toBe(false);
  });

  it('is only resolved while the ship flies free', () => {
    const now = Date.now();
    writeFreePose(farPose(now));
    expect(resolvedFreePose(now)).toBeNull();
    writeFlightRecord({ status: 'free-flight', locationId: HOME.id });
    expect(resolvedFreePose(now + 1000)?.at).toBe(now + 1000);
  });

  it('undocks from a listed station into its frame, and from nowhere unknown', () => {
    const pose = undockPoseFrom(HOME.id, ORBIT_EPOCH_MS + 1000);
    expect(pose?.near).toBeDefined();
    expect(undockPoseFrom('no-such-station')).toBeNull();
  });
});

describe('the pilot', () => {
  it('writes when the stick starts, every WRITE_EVERY_MS while held, and when it stops; fuel comes off in whole units', () => {
    const t = Date.now();
    fly(farPose(t));
    const thrust = { ...NO_INPUT, thrust: 1 };
    pilotFrame(thrust, 0.05, CAP, t + 50);
    expect(isPilotingHere()).toBe(true);
    const first = readFreePose()!;
    expect(first.at).toBe(t + 50);
    // Held: no write until WRITE_EVERY_MS has passed.
    pilotFrame(thrust, 0.05, CAP, t + 100);
    expect(readFreePose()!.at).toBe(t + 50);
    let ms = t + 100;
    for (; ms < t + 50 + WRITE_EVERY_MS; ms += 50) pilotFrame(thrust, 0.05, CAP, ms + 50);
    expect(readFreePose()!.at).toBeGreaterThan(t + 50);
    // Let go of the keys: written at once.
    pilotFrame(NO_INPUT, 0.05, CAP, ms + 100);
    expect(readFreePose()!.at).toBe(ms + 100);
    expect(readFreePose()!.vAlong).toBeGreaterThan(0);
    // Burned fuel left the tank (whole units at writes, the rest at release).
    releaseStick(CAP, ms + 150);
    expect(isPilotingHere()).toBe(false);
    expect(readFuelLevel(CAP)).toBeLessThan(CAP);
    expect(Number.isInteger(readFuelLevel(CAP))).toBe(true);
  });

  it('stops flying once the ship is no longer free', () => {
    const t = Date.now();
    fly(farPose(t));
    pilotFrame({ ...NO_INPUT, yaw: 1 }, 0.05, CAP, t + 50);
    writeFlightRecord({ status: 'redocking', locationId: HOME.id });
    expect(pilotFrame({ ...NO_INPUT, yaw: 1 }, 0.05, CAP, t + 100)).toBeNull();
    expect(isPilotingHere()).toBe(false);
    expect(readFlightRecord().status).toBe('redocking');
  });
});

describe('the coast watch', () => {
  it('writes nothing while the coast meets no zone', () => {
    const t = Date.now();
    fly(farPose(t - 5000));
    expect(settleFreeCoast(t)).toBe(false);
    expect(readFreePose()!.at).toBe(t - 5000);
  });

  it('stands aside while this game holds the stick', () => {
    const t = Date.now();
    fly(farPose(t - 5000));
    pilotFrame(NO_INPUT, 0.05, CAP, t);
    expect(settleFreeCoast(t + 1000)).toBe(false);
  });
});
