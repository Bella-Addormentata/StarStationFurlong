// stationDirectory.ts tests: which room takes its place from the ship's flight
// record (main.ts's room-station resolver asks followsFlightRecord, with
// flightCapable's answer for engine, tank and helm).

import { afterEach, describe, expect, it } from 'vitest';
import type { FlightStatus } from './shipDoc';
import { flightCapable, followsFlightRecord, setStationRoomCheck } from './stationDirectory';

afterEach(() => setStationRoomCheck(null));

const UNDER_WAY: readonly FlightStatus[] = ['undocking', 'in-flight', 'redocking'];

/** As main.ts asks it, for a room with (`shipReady`) or without engine, tank and helm. */
const placed = (status: FlightStatus, shipReady: boolean) => followsFlightRecord(status, flightCapable(shipReady));

describe("a room's place from the flight record", () => {
  it('stays with a flight under way when a fitting comes off mid-trip', () => {
    for (const status of UNDER_WAY) {
      expect(placed(status, true)).toBe(true);
      expect(placed(status, false)).toBe(true);
    }
  });

  it('comes from a docked record only in a room that could fly', () => {
    expect(placed('docked', true)).toBe(true);
    // A module that never flew reads the record's default: not its place.
    expect(placed('docked', false)).toBe(false);
  });

  it("never comes from the record in a station's own room", () => {
    for (const why of ['welcome-room', 'lone-station', 'bolted'] as const) {
      setStationRoomCheck(() => why);
      for (const status of ['docked', ...UNDER_WAY] as const) {
        expect(placed(status, true)).toBe(false);
        expect(placed(status, false)).toBe(false);
      }
    }
    // A check that throws reads as no station room (groundedBy).
    setStationRoomCheck(() => { throw new Error('no doors yet'); });
    expect(placed('in-flight', false)).toBe(true);
  });
});
