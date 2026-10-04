/**
 * 🔭 Where the far view sees the planet from aboard a ship
 * (farOrbitView.readSource): the transfer its flight record names, waiting on
 * the orbit it left until the launch window; the orbit a redocking ship
 * arrived at when its destination has moved on since; and a course already
 * drawn kept as it was when a trim, a dropped station or another reading of
 * an end's id would place its ends differently now.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { planTransfer, setStationTrimResolver, stationPointAt } from './orbits';
import type { OrbitPoint } from './orbits';
import { bindShipDoc, readFlightRecord, writeFlightRecord } from './shipDoc';
import type { FlightRecord } from './shipDoc';
import { flightCapable, followsFlightRecord, setStationDirectory } from './stationDirectory';
import type { StationDestination } from './stationDirectory';
import {
  DEFAULT_PLANET_ID, adriftAt, registerStation, removeStation, setRoomStationResolver, setStationRoomSource,
} from './stations';

// devices.ts (the far view reads isShipReady) hangs debug handles on window
// as it loads.
const fakeWindow = { location: { search: '' }, addEventListener: () => {}, removeEventListener: () => {} };
vi.stubGlobal('window', fakeWindow);
let gatherForTest: typeof import('./farOrbitView').gatherForTest;
let forgetFlightsForTest: typeof import('./farOrbitView').forgetFlightsForTest;
let isShipReady: typeof import('./devices').isShipReady;
beforeAll(async () => {
  ({ gatherForTest, forgetFlightsForTest } = await import('./farOrbitView'));
  ({ isShipReady } = await import('./devices'));
});

let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const P = DEFAULT_PLANET_ID;
const ALPHA = { id: 'alpha', planetId: P, orbitSlot: 1 };
const BETA = { id: 'beta', planetId: P, orbitSlot: 2 };
const NOW = Date.now();
// The launch window a minute after the ship cast off, and the transfer's own
// half ellipse after it.
const DEPARTED_AT = NOW + 60_000;
const ETA_AT = DEPARTED_AT + Math.ceil(planTransfer(ALPHA, BETA, NOW)!.transferMs);
const MIDWAY = (DEPARTED_AT + ETA_AT) / 2;

/** DEPART's record for alpha → beta, as devices.departureFlight writes it
 *  (minus the cast-off places unless given: a build from before them). */
const flight = (extra: Partial<FlightRecord> = {}): FlightRecord => ({
  status: 'in-flight', locationId: 'alpha', destinationId: 'beta',
  departedAt: DEPARTED_AT, etaAt: ETA_AT, castOffAt: NOW, ...extra,
});

/** Where the far view, reading at `now`, puts the viewer at `ms`. */
function viewerAt(now: number, ms: number): OrbitPoint {
  const source = gatherForTest(now);
  if (source.mode !== 'planet') throw new Error(`expected the planet view, got ${source.mode}`);
  return source.viewer(ms);
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('window', fakeWindow);
  forgetFlightsForTest();
  bindShipDoc(new Y.Doc());
  registerStation({ ...ALPHA, name: 'ALPHA', welcomeRoomId: 'room-alpha' });
  registerStation({ ...BETA, name: 'BETA', welcomeRoomId: 'room-beta' });
  setStationRoomSource(() => 'room-ship');
  // As main.ts places the room: by its flight record, while it follows it.
  setRoomStationResolver(() => {
    const rec = readFlightRecord();
    return followsFlightRecord(rec.status, flightCapable(isShipReady())) ? rec.locationId : null;
  });
});

afterEach(() => {
  setRoomStationResolver(null);
  setStationRoomSource(() => '');
  setStationTrimResolver(null);
  setStationDirectory(null);
  vi.unstubAllGlobals();
});

describe('the far view aboard a ship', () => {
  it('waits on the orbit it left until the launch window, then flies the transfer', () => {
    expect(writeFlightRecord(flight())).toBe(true);
    expect(viewerAt(NOW, NOW)).toMatchObject({ ...stationPointAt(ALPHA, NOW), leg: 'waiting' });
    const midway = viewerAt(NOW, MIDWAY);
    expect(midway).toMatchObject({ leg: 'transfer' });
    expect(midway.radiusKm).toBeGreaterThan(stationPointAt(ALPHA, MIDWAY).radiusKm);
    expect(midway.radiusKm).toBeLessThan(stationPointAt(BETA, MIDWAY).radiusKm);
    expect(viewerAt(NOW, ETA_AT)).toMatchObject({ ...stationPointAt(BETA, ETA_AT), leg: 'arrived' });
  });

  it('stays on the orbit it arrived at while redocking, once its destination has moved on', () => {
    const arrivedAt = adriftAt(P, BETA.orbitSlot);
    expect(writeFlightRecord(flight({ originAt: adriftAt(P, ALPHA.orbitSlot), destinationAt: arrivedAt }))).toBe(true);
    expect(writeFlightRecord({
      status: 'redocking', locationId: 'beta', departedAt: DEPARTED_AT, etaAt: ETA_AT, castOffAt: NOW, destinationAt: arrivedAt,
    })).toBe(true);
    // Beta has since gone out to slot 3.
    expect(registerStation({ ...BETA, orbitSlot: 3, name: 'BETA', welcomeRoomId: 'room-beta' })).toBe(true);
    const at = ETA_AT + 5_000;
    expect(viewerAt(at, at)).toEqual(stationPointAt(BETA, at));
    expect(viewerAt(at, at).radiusKm).toBeLessThan(stationPointAt({ ...BETA, orbitSlot: 3 }, at).radiusKm);
  });

  it("keeps a course already drawn when a trim moves an end's orbit", () => {
    expect(writeFlightRecord(flight())).toBe(true);
    const drawn = [viewerAt(NOW, MIDWAY), viewerAt(NOW, ETA_AT)];
    // Station keeping trims beta's orbit after the ship left.
    setStationTrimResolver((s, slot) => (s.id === 'beta' ? { radiusKm: slot.radiusKm * 1.02, phase0: slot.phase0 } : null));
    const trimmedKm = stationPointAt(BETA, ETA_AT).radiusKm;
    expect(trimmedKm).toBeGreaterThan(drawn[1].radiusKm);
    expect([viewerAt(NOW + 1_000, MIDWAY), viewerAt(NOW + 1_000, ETA_AT)]).toEqual(drawn);
    // A flight first seen now is planned through the trim.
    forgetFlightsForTest();
    expect(viewerAt(NOW + 1_000, ETA_AT).radiusKm).toBeCloseTo(trimmedKm, 6);
  });

  it('keeps a course already drawn once an end can no longer be placed', () => {
    expect(writeFlightRecord(flight())).toBe(true);
    const drawn = viewerAt(NOW, MIDWAY);
    expect(drawn).toMatchObject({ leg: 'transfer' });
    removeStation('beta');
    expect(viewerAt(NOW + 1_000, MIDWAY)).toEqual(drawn);
    // Seen first now, it has no course to draw.
    forgetFlightsForTest();
    expect(viewerAt(NOW + 1_000, MIDWAY)).not.toHaveProperty('leg');
  });

  it("keeps a course already drawn when this install reads an end's id differently", () => {
    // Another install's id for alpha, which this one resolves only while it
    // lists the station that id names (a learned station, later dropped).
    let resolves = false;
    const listed = (s: typeof ALPHA, name: string): StationDestination =>
      ({ id: s.id, name, planetId: s.planetId, fuelCost: 0, travelMs: 60_000 });
    setStationDirectory({
      stations: () => [listed(ALPHA, 'ALPHA'), listed(BETA, 'BETA')],
      resolve: (id) => (resolves && id === 'their-alpha' ? 'alpha' : null),
    });
    expect(writeFlightRecord(flight({ locationId: 'their-alpha' }))).toBe(true);
    resolves = true;
    expect(readFlightRecord().locationId).toBe('alpha');
    const drawn = viewerAt(NOW, MIDWAY);
    expect(drawn).toMatchObject({ leg: 'transfer' });
    // The same record, read again: its origin is an id no station here has.
    resolves = false;
    expect(readFlightRecord().locationId).toBe('their-alpha');
    expect(viewerAt(NOW + 1_000, MIDWAY)).toEqual(drawn);
  });
});
