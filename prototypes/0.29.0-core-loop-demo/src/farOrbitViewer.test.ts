/**
 * 🔭 Where the far view sees the planet from aboard a ship
 * (farOrbitView.readSource): the transfer its flight record names, waiting on
 * the orbit it left until the launch window; the orbit a redocking ship
 * arrived at when its destination has moved on since; and a course already
 * drawn kept as it was when a trim, a dropped station or another reading of
 * an end's id would place its ends differently now. 🚏 A ferry route's stay
 * on its stop's untrimmed copy, unless a live dock on one of the room's own
 * doors carries it with the station, and where the route's end leaves it
 * with no dock.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import { bindDoorLayoutDoc } from './doorLayoutDoc';
import { bindDoorsDoc, buildDoorPairing, writeDoorPairing } from './doorsDoc';
import type { FurnitureItem } from './furniture';
import { planTransfer, setStationTrimResolver, stationPointAt } from './orbits';
import type { OrbitPoint, StationTrimResolver } from './orbits';
import { shipPlaceId } from './shipArrival';
import { bindShipDoc, readFlightRecord, writeFlightRecord, writeFuelLevel, writeRestPlace } from './shipDoc';
import type { FlightRecord } from './shipDoc';
import { installRouteFlight, resolveShipFlight, startShipRoute, writeShipRoute } from './shipRoute';
import type { RouteStop } from './shipRoute';
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
let FURNITURE: FurnitureItem[];
beforeAll(async () => {
  ({ gatherForTest, forgetFlightsForTest } = await import('./farOrbitView'));
  ({ isShipReady } = await import('./devices'));
  ({ FURNITURE } = await import('./furniture'));
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

// ── 🚏 A ferry route (robot pilot routes, build notes A4) ────────────────────

/** Station keeping has trimmed alpha off its slot's orbit. */
const TRIM_ALPHA: StationTrimResolver = (s, slot) => (s.id === 'alpha' ? { radiusKm: slot.radiusKm * 1.02, phase0: slot.phase0 } : null);
/** Alpha's slot's own orbit, where no trim moves a body. */
const ALPHA_SLOT = { planetId: ALPHA.planetId, orbitSlot: ALPHA.orbitSlot };
const ALPHA_ROOM = 'ssf://room#room=room-alpha';
const JUNK_ROOM = 'ssf://room#room=junk';
/** A ship's dock into alpha's welcome room. */
const dockedToAlpha = () => buildDoorPairing(ALPHA_ROOM, { segments: dockChain(), transient: true, dockedAt: NOW - 60_000 });

const fitting = (kind: string): FurnitureItem =>
  ({ id: kind, kind: kind as FurnitureItem['kind'], pos: { x: 0, z: 0 }, rot: 0, movable: true });

describe('the far view aboard a ferry on its route', () => {
  const CAP = 100;
  let now = NOW;
  let saved: FurnitureItem[] = [];
  let uninstall: (() => void) | null = null;
  const stopAt = (st: typeof ALPHA, roomId: string): RouteStop => ({
    stationId: st.id, name: st.id.toUpperCase(), planetId: st.planetId, orbitSlot: st.orbitSlot,
    berth: { roomId, farDoor: 'x+', anyGate: true }, waitSecs: 60,
  });

  beforeEach(() => {
    now = NOW;
    // A fitted ship (engine, tank and helm), so its room follows its flight.
    saved = FURNITURE.splice(0, FURNITURE.length, fitting('engine-block'), fitting('fuel-tank'), fitting('helm-console'));
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindDoorLayoutDoc(doc); // unseeded: the four default doors
    uninstall = installRouteFlight({ capacity: () => CAP, clock: () => now });
    // As main.ts places the room: a running route's flight, else the stored
    // record through where it rests (shipPlaceId).
    setRoomStationResolver(() => {
      const { flight, route } = resolveShipFlight();
      if (!followsFlightRecord(flight.status, flightCapable(isShipReady()))) return null;
      return route ? flight.locationId : shipPlaceId(flight);
    });
    setStationTrimResolver(TRIM_ALPHA);
  });
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    FURNITURE.splice(0, FURNITURE.length, ...saved);
  });

  /** START the alpha ↔ beta ferry at alpha, docking through 'north'. */
  const startAtAlpha = () => {
    expect(writeShipRoute({
      stops: [stopAt(ALPHA, 'room-alpha'), stopAt(BETA, 'room-beta')],
      shape: 'backAndForth',
      shipPort: 'north',
      robotDockId: 'dock-1',
    })).toBe(true);
    writeFuelLevel(CAP, CAP);
    expect(startShipRoute({ now: NOW, startStop: 0, pilot: 'robot', fuel: CAP, capacity: CAP })).not.toBeNull();
    now = NOW + 5_000; // its first stay
    expect(resolveShipFlight(now).flight).toMatchObject({ status: 'docked', locationId: 'alpha' });
  };

  it("waits out a stay with no dock on the route's copy of its stop, untrimmed", () => {
    startAtAlpha();
    expect(viewerAt(now, now)).toEqual(stationPointAt(ALPHA_SLOT, now));
  });

  it('🚪 goes with the station a live dock carries it with, past a flood of door records', () => {
    // A peer's flood: a snapshot's worth of records (doorsDoc.MAX_PAIRINGS),
    // written ahead of the ship's dock on one of its own doors.
    for (let i = 0; i < 64; i++) writeDoorPairing(`d:flood-${i}`, JUNK_ROOM, buildDoorPairing(JUNK_ROOM, { transient: true }));
    writeDoorPairing('north', ALPHA_ROOM, dockedToAlpha());
    startAtAlpha();
    expect(viewerAt(now, now)).toEqual(stationPointAt(ALPHA, now));
  });

  it('🚪 takes no record on a door the room lacks for a dock', () => {
    writeDoorPairing('d:nowhere', ALPHA_ROOM, dockedToAlpha());
    startAtAlpha();
    expect(viewerAt(now, now)).toEqual(stationPointAt(ALPHA_SLOT, now));
  });

  it('🚏 stays on that copy once the route ends there with no dock, beside a trimmed station', () => {
    // Where the copy-back leaves it (shipArrival.restAtRouteEnd): docked at
    // alpha by its record, resting in open orbit on the stop's copy.
    expect(writeFlightRecord({ status: 'docked', locationId: 'alpha' })).toBe(true);
    expect(writeRestPlace({ at: adriftAt(P, ALPHA.orbitSlot), since: NOW, open: true })).toBe(true);
    expect(viewerAt(now, now)).toEqual(stationPointAt(ALPHA_SLOT, now));
    // With no trim, alpha is on that orbit: the ship is beside it there.
    setStationTrimResolver(null);
    expect(viewerAt(now, now)).toEqual(stationPointAt(ALPHA, now));
    // A rest beside the station (an arrival with no berth) is with it, trim
    // and all.
    setStationTrimResolver(TRIM_ALPHA);
    expect(writeRestPlace({ at: adriftAt(P, ALPHA.orbitSlot), since: NOW })).toBe(true);
    expect(viewerAt(now, now)).toEqual(stationPointAt(ALPHA, now));
  });
});
