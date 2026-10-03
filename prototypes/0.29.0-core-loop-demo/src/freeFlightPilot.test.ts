/**
 * 🕹️ freeFlightPilot — the pose record, the pilot's writes and fuel, and
 * the coast watch (issue 203).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NO_INPUT, speedOf } from './freeFlight';
import type { FreePose } from './freeFlight';
import {
  FREE_DOCK_SETTLE_MS,
  WRITE_EVERY_MS,
  isPilotingHere,
  keepStationPark,
  markFreeDock,
  markStationPark,
  recoverFreeDock,
  settleFreeDock,
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
import { DEFAULT_PLANET_ID, DEFAULT_STATION_RECORD, setAltitudeHistory, setStationMoveResolver, setStationRoomSource } from './stations';
import { planStationPark } from './freeStation';
import { freeStationsAround, ownStationOf, stationFlyingFree, stationUndockPose } from './freeFlightPilot';
import { ORBIT_EPOCH_MS, orbitForSlot } from './orbits';

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
  it('drops a stick left from another ship when the ship doc is rebound', () => {
    const t = Date.now();
    fly(farPose(t));
    pilotFrame({ thrust: 1, strafe: 0, yaw: 0, brake: false }, 0.1, CAP, t);
    expect(isPilotingHere()).toBe(true);
    const other = new Y.Doc();
    bindShipDoc(other);
    expect(isPilotingHere()).toBe(false);
    // Nothing of the old ship's pose lands on this one.
    expect(pilotFrame(NO_INPUT, 0.1, CAP, t + 50)).toBeNull();
    expect(other.getMap('ship').get('freeFlight')).toBeUndefined();
    bindShipDoc(doc);
    other.destroy();
  });


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

  it('checkpoints a quiet coast once it is a minute old', () => {
    const t = Date.now();
    fly(farPose(t - 61_000));
    expect(settleFreeCoast(t)).toBe(true);
    expect(t - readFreePose()!.at).toBeLessThan(1000);
  });

  it('stands aside while this game holds the stick', () => {
    const t = Date.now();
    fly(farPose(t - 5000));
    pilotFrame(NO_INPUT, 0.05, CAP, t);
    expect(settleFreeCoast(t + 1000)).toBe(false);
  });
});

const ROOM = DEFAULT_STATION_RECORD.welcomeRoomId;

describe('🅿️ a station flying by itself', () => {
  afterEach(() => setStationRoomSource(() => ''));

  it('is its own station, starts still where it is, and holds no frame while it flies', () => {
    const now = ORBIT_EPOCH_MS + 7_200_000;
    setStationRoomSource(() => ROOM);
    const station = ownStationOf();
    expect(station?.id).toBe(DEFAULT_STATION_RECORD.id);
    const pose = stationUndockPose(station!, now);
    expect(pose.near).toBeUndefined();
    expect(speedOf(pose)).toBe(0);
    resetFreeFlightPilot();
    expect(freeStationsAround(DEFAULT_PLANET_ID, now).some((s) => s.room === ROOM)).toBe(true);
    expect(stationFlyingFree(DEFAULT_STATION_RECORD, now)).toBe(false);
    fly(pose);
    resetFreeFlightPilot();
    expect(freeStationsAround(DEFAULT_PLANET_ID, now).some((s) => s.room === ROOM)).toBe(false);
    // Docking is closed while it flies: DEPART, routes and arrivals skip it.
    expect(stationFlyingFree(DEFAULT_STATION_RECORD, now)).toBe(true);
    expect(stationFlyingFree({ welcomeRoomId: 'elsewhere' }, now)).toBe(false);
  });

  it('stays closed in this game after leaving it, with no summary left to say so', () => {
    const saved = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => { saved.set(k, v); },
      removeItem: (k: string) => { saved.delete(k); },
    };
    try {
      const now = ORBIT_EPOCH_MS + 7_200_000;
      setStationRoomSource(() => ROOM);
      fly(stationUndockPose(ownStationOf()!, now));
      resetFreeFlightPilot();
      expect(stationFlyingFree(DEFAULT_STATION_RECORD, now)).toBe(true);
      // Elsewhere, a day on: no summary of it is left, its docks stay closed.
      setStationRoomSource(() => 'another-room');
      resetFreeFlightPilot();
      expect(stationFlyingFree(DEFAULT_STATION_RECORD, now + 25 * 3600_000)).toBe(true);
      // Back aboard, parked (docked): open again.
      setStationRoomSource(() => ROOM);
      writeFlightRecord({ status: 'redocking', locationId: HOME.id });
      writeFlightRecord({ status: 'docked', locationId: HOME.id });
      resetFreeFlightPilot();
      expect(stationFlyingFree(DEFAULT_STATION_RECORD, now + 26 * 3600_000)).toBe(false);
    } finally {
      g.localStorage = before;
    }
  });
});

describe('🅿️ a parked station whose orbit claim loses', () => {
  afterEach(() => {
    setStationRoomSource(() => '');
    setStationMoveResolver(null);
    setAltitudeHistory(null);
  });

  it('flies again where it parked, its docks closed, rather than settle on the unflown leg', () => {
    const now = ORBIT_EPOCH_MS + 7_200_000;
    setStationRoomSource(() => ROOM);
    const station = ownStationOf()!;
    const r0 = orbitForSlot(DEFAULT_PLANET_ID, 0).radiusKm;
    const r1 = orbitForSlot(DEFAULT_PLANET_ID, 1).radiusKm;
    const mid = (r0 + r1) / 2;
    const parked: FreePose = { planetId: DEFAULT_PLANET_ID, at: now, radiusKm: mid, angle: 1.2, vAlong: 0, vRadial: 0, heading: 0, parked: true };
    fly(stationUndockPose(station, now - 60_000));
    const plan = planStationPark(station, parked, [station], 0, 0);
    if (!plan.ok) throw new Error(plan.reason);
    setStationMoveResolver((st) => (st.welcomeRoomId === ROOM ? plan.move : null));
    expect(markStationPark(parked, plan.move)).toBe(true);
    writeFlightRecord({ status: 'redocking', locationId: station.id });
    writeFlightRecord({ status: 'docked', locationId: station.id });
    // Its claim holds: parked.
    expect(keepStationPark(now + 1000)).toBe(false);
    expect(readFlightRecord().status).toBe('docked');
    // An earlier claim 10 km off is heard: this one lost.
    const { derived: _d, ...base } = station;
    const rival = { ...base, id: 'rival', welcomeRoomId: 'rival-room', name: 'Rival' };
    const early = planStationPark(rival, { ...parked, at: now - 3_600_000, radiusKm: mid + 10 }, [rival], 0, 0);
    if (!early.ok) throw new Error(early.reason);
    setAltitudeHistory(() => [early.move]);
    expect(keepStationPark(now + 2000)).toBe(true);
    expect(readFlightRecord().status).toBe('free-flight');
    expect(readFreePose()).toEqual(parked);
    expect(doc.getMap('ship').get('freePark')).toBeUndefined();
  });
});

describe("🕹️ AUTO-DOCK's way back", () => {
  const NONE: { state: { kind: string } }[] = [];
  const DOCKED = [{ state: { kind: 'docked' } }];

  /** Fly free, then start AUTO-DOCK at HOME: the record reads docked there
   *  before the berth answers (as completeArrival writes it). */
  function autoDockStarted(t: number): FreePose {
    const pose = farPose(t);
    fly(pose);
    expect(markFreeDock(HOME.id, HOME.id, pose, t)).toBe(true);
    expect(writeFlightRecord({ status: 'redocking', locationId: HOME.id })).toBe(true);
    expect(writeFlightRecord({ status: 'docked', locationId: HOME.id })).toBe(true);
    return pose;
  }

  it('flies on when the berth refuses, and waits while the answer is due', () => {
    const t = Date.now();
    const pose = autoDockStarted(t);
    // The watch leaves it alone while this game awaits the answer.
    expect(recoverFreeDock(NONE, t + 60_000)).toBe(false);
    expect(readFlightRecord().status).toBe('docked');
    expect(recoverFreeDock(NONE, t + 1000, true)).toBe(true);
    expect(readFlightRecord().status).toBe('free-flight');
    expect(readFreePose()).toEqual(pose);
    expect(doc.getMap('ship').get('freeDock')).toBeUndefined();
  });

  it('flies on once a game that left the room comes back, after the pairings settle', () => {
    const t = Date.now();
    autoDockStarted(t);
    // The game that asked left (its doc went), and comes back to a fresh one.
    const back = new Y.Doc();
    Y.applyUpdate(back, Y.encodeStateAsUpdate(doc));
    bindShipDoc(back);
    expect(recoverFreeDock(NONE, t + 10_000)).toBe(false);
    expect(recoverFreeDock(NONE, t + 10_000 + FREE_DOCK_SETTLE_MS - 1)).toBe(false);
    expect(recoverFreeDock(NONE, t + 10_000 + FREE_DOCK_SETTLE_MS)).toBe(true);
    expect(readFlightRecord().status).toBe('free-flight');
    bindShipDoc(doc);
    back.destroy();
  });

  it('is cleared by a docked port or a dock that took', () => {
    const t = Date.now();
    autoDockStarted(t);
    const back = new Y.Doc();
    Y.applyUpdate(back, Y.encodeStateAsUpdate(doc));
    bindShipDoc(back);
    expect(recoverFreeDock(DOCKED, t + 60_000)).toBe(false);
    expect(back.getMap('ship').get('freeDock')).toBeUndefined();
    expect(readFlightRecord().status).toBe('docked');
    bindShipDoc(doc);
    back.destroy();
    settleFreeDock();
    expect(doc.getMap('ship').get('freeDock')).toBeUndefined();
  });
});
