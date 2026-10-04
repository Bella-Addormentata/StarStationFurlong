/**
 * 🅿️ freeFlightPilot's memory of stations heard flying by themselves, read
 * from the planet summaries (issue 203): a PARK opens the station's docks
 * even when the summary that said it flew was stamped by a clock running
 * ahead of the flying room's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShipSummary } from './planetSummary';

const ships: Record<string, ShipSummary> = {};
vi.mock('./planetSummary', async (orig) => ({
  ...(await orig<typeof import('./planetSummary')>()),
  readStore: () => ({ stations: {}, ships }),
}));

const { resetFreeFlightPilot, stationFlyingFree } = await import('./freeFlightPilot');
const { DEFAULT_PLANET_ID, DEFAULT_STATION_RECORD, setStationMoveResolver, setStationRoomSource } = await import('./stations');
const { ORBIT_EPOCH_MS } = await import('./orbits');

const ROOM = DEFAULT_STATION_RECORD.welcomeRoomId;

afterEach(() => {
  for (const k of Object.keys(ships)) delete ships[k];
  setStationMoveResolver(null);
  setStationRoomSource(() => '');
  resetFreeFlightPilot();
});

describe('🅿️ a station heard flying by itself', () => {
  it('opens once its PARK is booked, though the summary was stamped hours ahead of the pose', () => {
    const now = ORBIT_EPOCH_MS + 30 * 3_600_000;
    setStationRoomSource(() => 'another-room');
    const flewAt = now - 3_600_000;
    ships[ROOM] = {
      roomId: ROOM, name: DEFAULT_STATION_RECORD.name, planetId: DEFAULT_PLANET_ID, status: 'free-flight',
      free: { planetId: DEFAULT_PLANET_ID, at: flewAt, radiusKm: 7000, angle: 1, vAlong: 0, vRadial: 0, heading: 0 },
      // A publisher's clock five hours fast.
      updatedAt: flewAt + 5 * 3_600_000,
    } as ShipSummary;
    resetFreeFlightPilot();
    expect(stationFlyingFree(DEFAULT_STATION_RECORD, now)).toBe(true);
    // The PARK summary is missed (the flying one still stands); the PARK
    // move, booked by the flying room's clock after the pose, is heard.
    const parkAt = flewAt + 600_000;
    setStationMoveResolver((st) => (st.welcomeRoomId === ROOM ? {
      stationId: DEFAULT_STATION_RECORD.id, welcomeRoomId: ROOM, fromPlanetId: DEFAULT_PLANET_ID, fromSlot: 0,
      toPlanetId: DEFAULT_PLANET_ID, toSlot: 0, departAt: parkAt, arriveAt: parkAt,
      mode: 'thrusters' as const, bookedAt: parkAt, fuel: 0, fuelDrawn: 0,
    } : null));
    resetFreeFlightPilot();
    expect(stationFlyingFree(DEFAULT_STATION_RECORD, now)).toBe(false);
  });
});
