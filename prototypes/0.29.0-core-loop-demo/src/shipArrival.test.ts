// shipArrival.ts tests: the pure arrival planner, the berth a departure
// remembers, and whole trips — undock, fly, arrive, re-dock — over real Yjs
// ship + doors docs with a stand-in docking system that makes the same
// near-side writes as docking.ts's UNDOCK / DOCK.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listStations, planetById, setStationMoveResolver, setStationRoomSource } from './stations';
import { bindStationMoveDoc, cancelTowLeftBehind, installStationMoveResolver, writeStationMove, type StationMove } from './stationMove';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import { berthMemoryFrom, classifyDockPort, redockRecord, stampAfter } from './dockRules';
import {
  bindDoorsDoc,
  buildDoorPairing,
  readDoor,
  writeDoorPairing,
  writeDoorTombstone,
} from './doorsDoc';
import {
  berthHeldByMove,
  berthToRemember,
  detachBerth,
  ARRIVAL_GRACE_MS,
  castOffForDeparture,
  resolveRememberedBerth,
  setBerthSeedResolver,
  castOffRefusal,
  rememberBerthHere,
  releaseEveryDock,
  completeArrival,
  planArrivalDock,
  type ArrivalOutcome,
  shipLocationId,
  shipPlaceId,
  castOffPlaces,
  correctReleasePlace,
  dockedToStation,
  keepRestPlace,
  restingPlace,
  type ArrivalPort,
  type ShipDockingApi,
} from './shipArrival';
import {
  bindShipDoc,
  isRestPlace,
  MAX_REST_DOCKS,
  readFlightRecord,
  readRestPlace,
  readStationBerth,
  writeFlightRecord,
  writeRestPlace,
  writeStationBerth,
  type FlightRecord,
} from './shipDoc';
import {
  adriftAt, adriftPlace, destinationsFrom, locationPlanet, planHop, setStationDirectory, DEFAULT_STATIONS, type StationDestination,
} from './stationDirectory';

// Synthetic pass seeds — roomIdFromSeed reads the #room= form.
const SEED_FURLONG = 'ssf://room#room=furlong-berth';
const SEED_FURLONG_OTHER_HINTS = 'ssf://room?x=1#room=furlong-berth';
const SEED_HIGH = 'ssf://room#room=high-orbit-berth';
const FURLONG_ROOM = 'furlong-berth';
const HIGH_ROOM = 'high-orbit-berth';

const dockedTo = (address: string, farDoor = 'south'): ArrivalPort['state'] =>
  classifyDockPort(buildDoorPairing(address, { segments: dockChain(), farDoor, farWall: 'y+', transient: true, dockedAt: 1000 }));
const undockedFrom = (address: string, farDoor = 'south', undockedAt = 2000): ArrivalPort['state'] =>
  classifyDockPort({ paired: false, retiredAddress: address, dock: { farDoor, undockedAt } });
const FREE: ArrivalPort['state'] = { kind: 'free' };

describe('planArrivalDock', () => {
  it('has nothing to dock to without a station berth or a memory', () => {
    expect(planArrivalDock({ station: {}, remembered: null, ports: [{ doorId: 'north', state: FREE }] }))
      .toEqual({ kind: 'none', reason: 'no-berth' });
  });

  it('re-docks the remembered port as-is when it still remembers that berth', () => {
    const plan = planArrivalDock({
      station: {},
      remembered: { doorId: 'north', address: SEED_FURLONG, farDoor: 'south' },
      ports: [{ doorId: 'east', state: FREE }, { doorId: 'north', state: undockedFrom(SEED_FURLONG) }],
    });
    expect(plan).toEqual({ kind: 'dock', doorId: 'north', address: SEED_FURLONG, retarget: null });
  });

  it('re-points a port that last docked somewhere else, stamped after its undock', () => {
    const plan = planArrivalDock({
      station: {},
      remembered: { doorId: 'north', address: SEED_FURLONG, farDoor: 'south', farWall: 'y+', farLateral: 0.5 },
      ports: [{ doorId: 'north', state: undockedFrom(SEED_HIGH, 'west', 5000) }],
      now: 10,
    });
    expect(plan).toEqual({
      kind: 'dock',
      doorId: 'north',
      address: SEED_FURLONG,
      retarget: { undockedAt: 5001, farDoor: 'south', farWall: 'y+', farLateral: 0.5 },
    });
  });

  it("prefers the station's own berth to the ship's memory of another room", () => {
    const plan = planArrivalDock({
      station: { berth: { address: SEED_HIGH, farDoor: 'd:a3313fdd' } },
      remembered: { doorId: 'north', address: SEED_FURLONG, farDoor: 'south' },
      ports: [{ doorId: 'north', state: FREE }],
      now: 10,
    });
    expect(plan).toMatchObject({ kind: 'dock', doorId: 'north', address: SEED_HIGH, retarget: { farDoor: 'd:a3313fdd' } });
  });

  it('uses the memory when the station names the same room but no door', () => {
    const plan = planArrivalDock({
      station: { berth: { address: SEED_FURLONG_OTHER_HINTS } },
      remembered: { doorId: 'north', address: SEED_FURLONG, farDoor: 'south' },
      ports: [{ doorId: 'north', state: undockedFrom(SEED_FURLONG) }],
    });
    expect(plan).toEqual({ kind: 'dock', doorId: 'north', address: SEED_FURLONG, retarget: null });
  });

  it('treats a malformed peer-written seed as another room instead of throwing', () => {
    const bad = 'ssf://room#room=%';
    expect(() => planArrivalDock({
      station: { berth: { address: bad } },
      remembered: { doorId: 'north', address: SEED_FURLONG },
      ports: [{ doorId: 'north', state: dockedTo(SEED_FURLONG) }, { doorId: 'east', state: FREE }],
    })).not.toThrow();
  });

  it('never plans a dock to a berth whose address names no room', () => {
    const bad = 'ssf://room#room=%';
    expect(planArrivalDock({
      station: { berth: { address: bad } },
      remembered: null,
      ports: [{ doorId: 'east', state: FREE }],
    })).toEqual({ kind: 'none', reason: 'no-berth' });
    expect(planArrivalDock({
      station: {},
      remembered: { doorId: 'north', address: bad },
      ports: [{ doorId: 'north', state: FREE }],
    })).toEqual({ kind: 'none', reason: 'no-berth' });
  });

  it('passes over a port that is mid-operation or not ours to operate', () => {
    const plan = planArrivalDock({
      station: { berth: { address: SEED_HIGH, farDoor: 'd:a3313fdd' } },
      remembered: { doorId: 'north', address: SEED_FURLONG },
      ports: [
        { doorId: 'north', state: FREE, busy: true },
        { doorId: 'east', state: FREE, canOperate: false },
        { doorId: 'west', state: FREE, busy: false, canOperate: true },
      ],
    });
    expect(plan.kind === 'dock' && plan.doorId).toBe('west');
    expect(planArrivalDock({
      station: { berth: { address: SEED_HIGH, farDoor: 'd:a3313fdd' } },
      remembered: null,
      ports: [{ doorId: 'north', state: FREE, busy: true }],
    })).toEqual({ kind: 'none', reason: 'no-port' });
  });

  it('skips a remembered port that is busy and takes the next open one', () => {
    const plan = planArrivalDock({
      station: {},
      remembered: { doorId: 'north', address: SEED_FURLONG, farDoor: 'south' },
      ports: [{ doorId: 'north', state: dockedTo(SEED_HIGH) }, { doorId: 'east', state: FREE }],
    });
    expect(plan).toMatchObject({ kind: 'dock', doorId: 'east' });
  });

  it('never plans a dock to a berth that names no far door, which the station would never answer', () => {
    expect(planArrivalDock({
      station: {},
      remembered: { doorId: 'north', address: SEED_FURLONG },
      ports: [{ doorId: 'north', state: FREE }],
    })).toEqual({ kind: 'none', reason: 'no-berth' });
    expect(planArrivalDock({
      station: { berth: { address: SEED_FURLONG } },
      remembered: null,
      ports: [{ doorId: 'north', state: FREE }],
    })).toEqual({ kind: 'none', reason: 'no-berth' });
    // Already docked in that room counts all the same.
    expect(planArrivalDock({
      station: {},
      remembered: { doorId: 'north', address: SEED_FURLONG },
      ports: [{ doorId: 'north', state: dockedTo(SEED_FURLONG) }],
    })).toEqual({ kind: 'none', reason: 'already-docked' });
  });

  it('refuses with no open port, and does nothing when already docked there', () => {
    expect(planArrivalDock({
      station: { berth: { address: SEED_FURLONG, farDoor: 'south' } },
      remembered: null,
      ports: [{ doorId: 'north', state: dockedTo(SEED_HIGH) }, { doorId: 'east', state: { kind: 'gangway' } }],
    })).toEqual({ kind: 'none', reason: 'no-port' });
    expect(planArrivalDock({
      station: { berth: { address: SEED_FURLONG } },
      remembered: null,
      ports: [{ doorId: 'north', state: dockedTo(SEED_FURLONG_OTHER_HINTS) }],
    })).toEqual({ kind: 'none', reason: 'already-docked' });
  });
});

describe('castOffRefusal', () => {
  const docked = { kind: 'docked' } as unknown as ArrivalPort['state'];
  const free = { kind: 'free' } as ArrivalPort['state'];
  it('refuses while a docked port is busy or locked, and ignores idle free ports', () => {
    expect(castOffRefusal([{ doorId: 'n', state: docked, busy: false, canOperate: true }])).toBeNull();
    expect(castOffRefusal([{ doorId: 'n', state: docked, busy: true }])).toBe('dock-busy');
    expect(castOffRefusal([{ doorId: 'n', state: docked, canOperate: false }])).toBe('dock-locked');
    expect(castOffRefusal([{ doorId: 'n', state: free, busy: true, canOperate: false }])).toBeNull();
  });
});

describe('releaseEveryDock', () => {
  const docked = { kind: 'docked' } as unknown as ArrivalPort['state'];
  const free = { kind: 'free' } as ArrivalPort['state'];
  /** Ports n (docked), e (free) and s (docked); each UNDOCK answers `answer`. */
  const stand = (answer: (doorId: string) => ReturnType<ShipDockingApi['undock']>) => {
    const asked: string[] = [];
    const api: ShipDockingApi = {
      ports: () => [{ doorId: 'n', state: docked }, { doorId: 'e', state: free }, { doorId: 's', state: docked }],
      undock: (doorId) => { asked.push(doorId); return answer(doorId); },
      dock: () => true,
    };
    return { api, asked };
  };

  it('asks every docked port, and is true once each let go (no answer counts as let go)', async () => {
    const all = stand((id) => (id === 'n' ? Promise.resolve(true) : undefined));
    await expect(releaseEveryDock(all.api)).resolves.toBe(true);
    expect(all.asked).toEqual(['n', 's']);
    const none: ShipDockingApi = {
      ports: () => [{ doorId: 'e', state: free }],
      undock: () => { throw new Error('a free port is never undocked'); },
      dock: () => true,
    };
    await expect(releaseEveryDock(none)).resolves.toBe(true);
  });

  it('is false when a dock holds (it answers false, throws or rejects), having asked them all', async () => {
    const held = stand((id) => (id === 's' ? Promise.resolve(false) : true));
    await expect(releaseEveryDock(held.api)).resolves.toBe(false);
    expect(held.asked).toEqual(['n', 's']);
    const threw = stand((id) => { if (id === 'n') throw new Error('port gone'); return true; });
    await expect(releaseEveryDock(threw.api)).resolves.toBe(false);
    expect(threw.asked).toEqual(['n', 's']);
    const lost = stand(() => Promise.reject(new Error('far room lost')));
    await expect(releaseEveryDock(lost.api)).resolves.toBe(false);
  });
});

describe('berthToRemember', () => {
  it('remembers the first docked port with its far-door geometry', () => {
    expect(berthToRemember([
      { doorId: 'east', state: FREE },
      { doorId: 'north', state: dockedTo(SEED_FURLONG) },
    ])).toEqual({ doorId: 'north', roomId: FURLONG_ROOM, farDoor: 'south', farWall: 'y+' });
    expect(berthToRemember([{ doorId: 'east', state: FREE }])).toBeNull();
    // A dock whose address names no room is skipped, not the end of the scan.
    const junk = { ...dockedTo(SEED_FURLONG), address: 'ssf://room#nothing' } as ArrivalPort['state'];
    expect(berthToRemember([
      { doorId: 'east', state: junk },
      { doorId: 'north', state: dockedTo(SEED_HIGH) },
    ])?.roomId).toBe(HIGH_ROOM);
  });
});

describe('resolveRememberedBerth', () => {
  afterEach(() => setBerthSeedResolver(null));

  it("uses this client's own pass for the room, else a port that names it", () => {
    const rec = { doorId: 'north', roomId: FURLONG_ROOM, farDoor: 'south' };
    expect(resolveRememberedBerth(rec, [])).toBeNull();
    expect(resolveRememberedBerth(rec, [{ doorId: 'north', state: undockedFrom(SEED_FURLONG) }]))
      .toEqual({ doorId: 'north', address: SEED_FURLONG, farDoor: 'south' });
    setBerthSeedResolver((room) => (room === FURLONG_ROOM ? SEED_FURLONG_OTHER_HINTS : undefined));
    expect(resolveRememberedBerth(rec, [])?.address).toBe(SEED_FURLONG_OTHER_HINTS);
    // A resolver answering with another room's pass is not trusted.
    setBerthSeedResolver(() => SEED_HIGH);
    expect(resolveRememberedBerth(rec, [])).toBeNull();
  });
});

// ── Whole trips over real docs ───────────────────────────────────────────────

/** A stand-in docking system: the near-side writes of UNDOCK and DOCK. */
function fakeDocking(portIds: string[]): ShipDockingApi & { docks: string[] } {
  const docks: string[] = [];
  return {
    docks,
    ports: () => portIds.map((doorId) => ({ doorId, state: classifyDockPort(readDoor(doorId)) })),
    undock: (doorId) => {
      const st = classifyDockPort(readDoor(doorId));
      if (st.kind !== 'docked') return;
      writeDoorTombstone(doorId, st.address, berthMemoryFrom(st.record, stampAfter(st.record.dockedAt)));
    },
    dock: (doorId) => {
      const st = classifyDockPort(readDoor(doorId));
      if (st.kind !== 'undocked') return;
      docks.push(doorId);
      const rec = redockRecord(st, stampAfter(st.memory.undockedAt));
      writeDoorPairing(doorId, rec.connectedRoomAddress, rec);
    },
  };
}

function fly(from: string, to: string): void {
  const now = Date.now();
  writeFlightRecord({ status: 'in-flight', locationId: from, destinationId: to, departedAt: now - 2, etaAt: now - 1 });
  writeFlightRecord({ status: 'redocking', locationId: to });
}

/** Where a listed station orbits now, as an open-orbit place. */
function placeOfStation(id: string): string {
  const st = listStations().find((s) => s.id === id)!;
  return adriftAt(planetById(st.planetId).id, st.orbitSlot);
}

describe('a round trip', () => {
  beforeEach(() => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    // Docked at Furlong on the north port.
    writeDoorPairing('north', SEED_FURLONG, buildDoorPairing(SEED_FURLONG, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: 1000,
    }));
  });
  afterEach(() => setStationDirectory(null));

  it('undocks, flies to a station with no berth on record, and comes home to its old berth', () => {
    const docking = fakeDocking(['north', 'east']);

    castOffForDeparture('furlong-station', docking);
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    expect(readStationBerth('furlong-station')).toMatchObject({ doorId: 'north', roomId: FURLONG_ROOM, farDoor: 'south' });

    fly('furlong-station', 'high-orbit');
    expect(completeArrival(docking)).toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'no-berth' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'high-orbit' });
    // High Orbit is only the static directory's here (no station record, so
    // no orbit to keep): it rests by the record.
    expect(readRestPlace()).toBeNull();

    fly('high-orbit', 'furlong-station');
    expect(completeArrival(docking)).toEqual({ kind: 'docking', stationName: 'Furlong Station' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'furlong-station' });
    // Docking through the port it rests by.
    expect(readRestPlace()).toEqual({ at: placeOfStation('furlong-station'), since: expect.any(Number), docks: ['north'] });
    const north = classifyDockPort(readDoor('north'));
    expect(north.kind).toBe('docked');
    expect(north.kind === 'docked' && north.address).toBe(SEED_FURLONG);
    expect(north.kind === 'docked' && north.record.farDoor).toBe('south');
  });

  it('remembers the berth before any cast-off, and has nothing to keep when undocked', () => {
    const docking = fakeDocking(['north']);
    expect(rememberBerthHere('furlong-station', docking.ports())).toBe(true);
    expect(classifyDockPort(readDoor('north')).kind).toBe('docked');
    expect(readStationBerth('furlong-station')?.roomId).toBe(FURLONG_ROOM);
    expect(rememberBerthHere('high-orbit', [])).toBe(true);
    expect(readStationBerth('high-orbit')).toBeNull();
  });

  it('never evicts a remembered station for a berth the memory would refuse', () => {
    for (let i = 0; i < 32; i++) writeStationBerth(`s${i}`, { doorId: 'north', roomId: HIGH_ROOM });
    // An overlong peer-written address: berth memory refuses it.
    const bad = [{ doorId: 'north', state: { ...dockedTo(SEED_FURLONG), address: `${SEED_FURLONG}${'x'.repeat(5000)}` } as ArrivalPort['state'] }];
    expect(rememberBerthHere('furlong-station', bad)).toBe(false);
    expect(readStationBerth('s0')).not.toBeNull();
  });

  it('forgets the oldest other station to remember this berth when memory is full', () => {
    for (let i = 0; i < 32; i++) writeStationBerth(`s${i}`, { doorId: 'north', roomId: HIGH_ROOM });
    expect(castOffForDeparture('furlong-station', fakeDocking(['north']))).toBe(true);
    expect(readStationBerth('furlong-station')?.roomId).toBe(FURLONG_ROOM);
    expect(readStationBerth('s0')).toBeNull();
    expect(readStationBerth('s31')).not.toBeNull();
  });

  it("docks at the destination station's own berth, and remembers where it left", () => {
    const stations: StationDestination[] = [
      ...DEFAULT_STATIONS.slice(0, 1),
      { ...DEFAULT_STATIONS[1], berth: { address: SEED_HIGH, farDoor: 'd:a3313fdd', farWall: 'x-' } },
    ];
    setStationDirectory({ stations: () => stations });
    const docking = fakeDocking(['north']);

    castOffForDeparture('furlong-station', docking);
    fly('furlong-station', 'high-orbit');
    expect(completeArrival(docking)).toEqual({ kind: 'docking', stationName: 'High Orbit' });
    const north = classifyDockPort(readDoor('north'));
    expect(north.kind === 'docked' && north.address).toBe(SEED_HIGH);
    expect(north.kind === 'docked' && north.record.farDoor).toBe('d:a3313fdd');
    expect(north.kind === 'docked' && north.record.farWall).toBe('x-');
    // The berth left behind is still remembered for the trip home.
    expect(readStationBerth('furlong-station')?.roomId).toBe(FURLONG_ROOM);
  });

  it('waits where the destination was at cast-off once it has moved on, however many moves', () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    // At cast-off Furlong orbited another slot (it has since moved, and
    // moved again: the directory keeps only its latest move, if any).
    const then = adriftAt(home.planetId, (home.orbitSlot + 3) % 16);
    writeFlightRecord({ status: 'in-flight', locationId: 'high-orbit', destinationId: 'furlong-station', departedAt: now - 2, etaAt: now - 1, castOffAt: now - 3, destinationAt: then });
    writeFlightRecord({ status: 'redocking', locationId: 'furlong-station', departedAt: now - 2, etaAt: now - 1, castOffAt: now - 3, destinationAt: then });
    expect(readFlightRecord().destinationAt).toBe(then);
    expect(completeArrival(fakeDocking(['north']), { now, force: true })).toMatchObject({ kind: 'none', reason: 'in-transit' });
    expect(readFlightRecord()).toMatchObject({ status: 'docked', locationId: then });
  });

  it('stays undocked at a station that left for another planet mid-flight', () => {
    const now = Date.now();
    const move = {
      stationId: 'high-orbit', welcomeRoomId: HIGH_ROOM, fromPlanetId: 'planet-sovereign', fromSlot: 1,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 1000, arriveAt: now + 3_600_000,
      mode: 'tug' as const, tugRoomId: 'tug', fuel: 1, fuelDrawn: 0,
    };
    const stations: StationDestination[] = [
      ...DEFAULT_STATIONS.slice(0, 1),
      { ...DEFAULT_STATIONS[1], berth: { address: SEED_HIGH, farDoor: 'd:a3313fdd', farWall: 'x-' }, move },
    ];
    setStationDirectory({ stations: () => stations });
    const docking = fakeDocking(['north']);
    castOffForDeparture('furlong-station', docking);
    fly('furlong-station', 'high-orbit');
    expect(completeArrival(docking, { now, force: true }))
      .toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'in-transit' });
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    // The ship waits in open orbit where the station was, a place that
    // follows no station, and flies on from there around Sovereign.
    const at = adriftAt('planet-sovereign', 1);
    expect(readFlightRecord()).toMatchObject({ status: 'docked', locationId: at });
    expect(adriftPlace(at)).toEqual({ planetId: 'planet-sovereign', orbitSlot: 1 });
    expect(adriftPlace(adriftAt('planet-sovereign', 15))).not.toBeNull();
    expect(adriftPlace(adriftAt('planet-sovereign', 16))).toBeNull();
    expect(locationPlanet(at)).toBe('planet-sovereign');
    expect(destinationsFrom(at).map((d) => d.id)).toEqual(['furlong-station']);
    expect(planHop(at, 'furlong-station', now)).not.toBeNull();
    // A pin of where the move arrived stands for the move: still no dock.
    const pin = { ...move, fromPlanetId: 'planet-aris', fromSlot: 0, departAt: move.arriveAt, arriveAt: move.arriveAt + 1, settles: move };
    const settled = [...DEFAULT_STATIONS.slice(0, 1), { ...stations[1], move: undefined, lastMove: { ...pin, departAt: now - 10, arriveAt: now - 9, settles: { ...move, arriveAt: now - 20 } } }];
    setStationDirectory({ stations: () => settled });
    fly('furlong-station', 'high-orbit');
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', departedAt: now - 5000, etaAt: now - 1, castOffAt: now - 5000 });
    expect(completeArrival(docking, { now, force: true })?.kind).toBe('none');
    expect(readFlightRecord().locationId).toBe(at);
  });

  it('stays undocked at a station that finished moving to another planet before the ship arrived', () => {
    const now = Date.now();
    const departedAt = now - 600_000;
    // Left after the ship did, and already arrived: the listing has dropped
    // `move`, and only `lastMove` remembers it.
    const lastMove = {
      stationId: 'high-orbit', welcomeRoomId: HIGH_ROOM, fromPlanetId: 'planet-sovereign', fromSlot: 1,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: departedAt + 1000, arriveAt: now - 1000,
      mode: 'tug' as const, tugRoomId: 'tug', fuel: 1, fuelDrawn: 0,
    };
    const berth = { address: SEED_HIGH, farDoor: 'd:a3313fdd', farWall: 'x-' as const };
    setStationDirectory({ stations: () => [...DEFAULT_STATIONS.slice(0, 1), { ...DEFAULT_STATIONS[1], berth, lastMove }] });
    const docking = fakeDocking(['north']);
    castOffForDeparture('furlong-station', docking);
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt, etaAt: now - 1 });
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', departedAt, etaAt: now - 1 });
    expect(completeArrival(docking, { now, force: true }))
      .toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'in-transit' });
    // A move that left after the booking but before the launch window the
    // ship waited for still happened while the ship was away.
    const window = departedAt + 120_000;
    setStationDirectory({ stations: () => [
      ...DEFAULT_STATIONS.slice(0, 1),
      { ...DEFAULT_STATIONS[1], berth, lastMove: { ...lastMove, departAt: departedAt + 1000, arriveAt: departedAt + 60_000 } },
    ] });
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt: window, etaAt: now - 1, castOffAt: departedAt });
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', departedAt: window, etaAt: now - 1, castOffAt: departedAt });
    expect(readFlightRecord().castOffAt).toBe(departedAt);
    expect(completeArrival(docking, { now, force: true }))
      .toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'in-transit' });
    // A station already on its way when the ship left, arriving before the
    // ship does, overlaps the time away too.
    setStationDirectory({ stations: () => [
      ...DEFAULT_STATIONS.slice(0, 1),
      { ...DEFAULT_STATIONS[1], berth, lastMove: { ...lastMove, departAt: departedAt - 5000, arriveAt: departedAt + 5000 } },
    ] });
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt, etaAt: now - 1 });
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', departedAt, etaAt: now - 1 });
    expect(completeArrival(docking, { now, force: true }))
      .toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'in-transit' });
    // A move finished before the ship left is just where the station is now.
    setStationDirectory({ stations: () => [
      ...DEFAULT_STATIONS.slice(0, 1),
      { ...DEFAULT_STATIONS[1], berth, lastMove: { ...lastMove, departAt: departedAt - 5000, arriveAt: departedAt - 1000 } },
    ] });
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt, etaAt: now - 1 });
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', departedAt, etaAt: now - 1 });
    expect(completeArrival(docking, { now, force: true })).toEqual({ kind: 'docking', stationName: 'High Orbit' });
  });

  it('does nothing unless the ship is redocking, and only once', () => {
    const docking = fakeDocking(['north']);
    expect(completeArrival(docking)).toBeNull();
    castOffForDeparture('furlong-station', docking);
    fly('furlong-station', 'high-orbit');
    completeArrival(docking); // one commander finishes it…
    expect(completeArrival(docking)).toBeNull();
  });

  it('never sends the ship home when its destination drops off the list mid-flight', () => {
    let stations: readonly StationDestination[] = [
      DEFAULT_STATIONS[0],
      { ...DEFAULT_STATIONS[1], id: 'gone-soon', name: 'Gone Soon' },
    ];
    setStationDirectory({ stations: () => stations });
    const docking = fakeDocking(['north']);
    castOffForDeparture('furlong-station', docking);
    fly('furlong-station', 'gone-soon');
    stations = [DEFAULT_STATIONS[0]]; // the record vanished while in flight
    expect(completeArrival(docking)).toEqual({ kind: 'none', stationName: 'gone-soon', reason: 'unlisted-station' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'gone-soon' });
    // Nowhere this install can place: no rest (an earlier stay's is gone too).
    expect(readRestPlace()).toBeNull();
    // Not re-docked at Furlong's remembered berth.
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    expect(docking.docks).toEqual([]);
  });

  it('waits in open orbit where an unlisted destination was at cast-off, when the flight kept it', () => {
    const now = Date.now();
    const then = 'adrift:planet-aris:4';
    writeFlightRecord({ status: 'redocking', locationId: 'gone-soon', departedAt: now - 2, etaAt: now - 1, castOffAt: now - 3, destinationAt: then });
    expect(completeArrival(fakeDocking(['north']), { force: true }))
      .toEqual({ kind: 'none', stationName: 'gone-soon', reason: 'unlisted-station' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: then });
  });

  it('waits out the grace for a commander who can dock, then settles berthless', () => {
    castOffForDeparture('furlong-station', fakeDocking(['north']));
    const eta = 50_000;
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt: 1, etaAt: eta });
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', etaAt: eta });
    const docking = fakeDocking(['north']);
    expect(completeArrival(docking, { now: eta + 1000 })).toBeNull();
    expect(readFlightRecord().status).toBe('redocking');
    expect(completeArrival(docking, { now: eta + ARRIVAL_GRACE_MS }))
      .toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'no-berth' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'high-orbit' });
  });

  it('settles at once when the commander forces it (DOCK NOW)', () => {
    castOffForDeparture('furlong-station', fakeDocking(['north']));
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt: 1, etaAt: 50_000 });
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', etaAt: 50_000 });
    expect(completeArrival(fakeDocking(['north']), { now: 50_001, force: true })?.kind).toBe('none');
    expect(readFlightRecord().status).toBe('docked');
  });

  it('arrives without a docking system and says there is no port', () => {
    castOffForDeparture('furlong-station', fakeDocking(['north']));
    fly('furlong-station', 'high-orbit');
    expect(completeArrival(null)).toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'no-port' });
    expect(readFlightRecord().status).toBe('docked');
  });
});

describe('shipLocationId', () => {
  afterEach(() => setStationDirectory(null));

  it("trusts the docks over the record while docked, the record otherwise", () => {
    setStationDirectory({ stations: () => DEFAULT_STATIONS, here: () => 'l4-anchorage' });
    expect(shipLocationId({ status: 'docked', locationId: 'high-orbit' }, true)).toBe('l4-anchorage');
    expect(shipLocationId({ status: 'docked', locationId: 'high-orbit' }, false)).toBe('high-orbit');
    expect(shipLocationId({
      status: 'in-flight', locationId: 'high-orbit', destinationId: 'furlong-station', departedAt: 1, etaAt: 2,
    }, true)).toBe('high-orbit');
  });
});

describe('where a ship with no live dock is', () => {
  beforeEach(() => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
  });
  afterEach(() => {
    setStationMoveResolver(null);
    bindStationMoveDoc(new Y.Doc());
  });

  it('keeps a ship cast off where it left, wherever its origin moves meanwhile', () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const left = adriftAt(home.planetId, home.orbitSlot);
    // Cast off and waiting for its launch window.
    const flight: FlightRecord = {
      status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit',
      departedAt: now + 600_000, etaAt: now + 900_000, castOffAt: now - 1000, originAt: left,
    };
    expect(shipPlaceId(flight, now)).toBe('furlong-station');
    // Its origin leaves for another planet: the ship stays in open orbit
    // where it was, on the way and once the station is there.
    const move = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 500, arriveAt: now + 3_600_000,
      mode: 'tug' as const, tugRoomId: 'tug', fuel: 1, fuelDrawn: 0,
    };
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? move : null));
    expect(shipPlaceId(flight, now)).toBe(left);
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? { ...move, departAt: now - 2000, arriveAt: now - 1000 } : null));
    expect(listStations().find((st) => st.id === 'furlong-station')!.planetId).toBe('planet-aris');
    expect(shipPlaceId(flight, now)).toBe(left);
    expect(adriftPlace(shipPlaceId(flight, now))?.planetId).toBe(home.planetId);
    // Arrived, it is where its destination was at cast-off once that moved on.
    const then = adriftAt('planet-sovereign', 9);
    const arrived: FlightRecord = { status: 'redocking', locationId: 'furlong-station', departedAt: now - 2, etaAt: now - 1, destinationAt: then };
    expect(shipPlaceId(arrived, now)).toBe(then);
    expect(shipPlaceId({ ...arrived, destinationAt: adriftAt('planet-aris', 0) }, now)).toBe('furlong-station');
    // A flight that kept no place, and a ship at rest, go by the record.
    expect(shipPlaceId({ ...flight, originAt: undefined }, now)).toBe('furlong-station');
    expect(shipPlaceId({ status: 'docked', locationId: 'furlong-station', originAt: left }, now)).toBe('furlong-station');
  });

  it('keeps a ship at rest where it came to rest, however its station moves and whatever moves are known', () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const was = placeOfStation('furlong-station');
    const rest: FlightRecord = { status: 'docked', locationId: 'furlong-station' };
    // Came to rest beside Furlong without a dock.
    expect(writeRestPlace({ at: was, since: now - 60_000 })).toBe(true);
    expect(shipPlaceId(rest, now)).toBe('furlong-station');
    // Furlong went to Aris and came back to another slot of its planet, and
    // only the way back is known here: the ship is still where it was.
    const slot = (home.orbitSlot + 2) % 16;
    const back: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: 'planet-aris', fromSlot: 0,
      toPlanetId: home.planetId, toSlot: slot, departAt: now - 50_000, arriveAt: now - 10_000,
      mode: 'thrusters', bookedAt: now - 55_000, fuel: 1, fuelDrawn: 0,
    };
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? back : null));
    expect(listStations().find((st) => st.id === 'furlong-station')!.orbitSlot).toBe(slot);
    expect(shipPlaceId(rest, now)).toBe(was);
    expect(shipLocationId(rest, false)).toBe(was);
    // On its way, likewise; back in the very slot, the ship is beside it again.
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? { ...back, arriveAt: now + 3_600_000 } : null));
    expect(shipPlaceId(rest, now)).toBe(was);
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? { ...back, toSlot: home.orbitSlot } : null));
    expect(shipPlaceId(rest, now)).toBe('furlong-station');
    // A docked ship with no rest record follows its station, as before.
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? back : null));
    expect(shipPlaceId(rest, now, null)).toBe('furlong-station');
  });

  it('follows the docks its rest names while they hold, and stays where its station let go of it', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const was = placeOfStation('furlong-station');
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    // Docked by hand at Furlong (the record still names High Orbit).
    const rec: FlightRecord = { status: 'docked', locationId: 'high-orbit' };
    writeDoorPairing('east', seed, buildDoorPairing(seed, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 30_000,
    }));
    writeRestPlace({ at: was, since: now - 30_000, docks: ['east'] });
    expect(restingPlace(readRestPlace()!, now)).toEqual({ heldBy: 'furlong-station' });
    expect(shipPlaceId(rec, now)).toBe('furlong-station');
    // Let go of there (the station's UNDOCK, say): beside Furlong while it stays.
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now - 5000 });
    expect(shipPlaceId(rec, now)).toBe('furlong-station');
    // An older release on that door is an earlier stay's.
    expect(restingPlace({ at: adriftAt('planet-aris', 3), since: now - 4000, docks: ['east'] }, now))
      .toEqual({ at: adriftAt('planet-aris', 3) });
    // Then Furlong leaves for Aris: the ship stays where Furlong let go of it.
    const move: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 1000, arriveAt: now + 3_600_000,
      mode: 'thrusters', bookedAt: now - 2000, fuel: 1, fuelDrawn: 0,
    };
    expect(writeStationMove(move)).toBe(true);
    expect(shipPlaceId(rec, now)).toBe(was);
    expect(shipPlaceId(rec, move.arriveAt + 1)).toBe(was);
  });

  it('records the docks holding the ship and, once they let go, where it was left', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const was = placeOfStation('furlong-station');
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const dock = () => buildDoorPairing(seed, { segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 30_000 });
    writeFlightRecord({ status: 'docked', locationId: 'furlong-station' });
    expect(keepRestPlace('ship-room', now)).toBe(false); // no dock, no rest: nothing to keep
    writeDoorPairing('east', seed, dock());
    expect(keepRestPlace('ship-room', now)).toBe(true);
    expect(readRestPlace()).toEqual({ at: was, since: now, docks: ['east'] });
    expect(keepRestPlace('ship-room', now + 1000)).toBe(false); // unchanged: not written again
    writeDoorPairing('west', seed, dock());
    expect(keepRestPlace('ship-room', now + 2000)).toBe(true);
    expect(readRestPlace()?.docks).toEqual(['east', 'west']);
    // Both let go: the ship was left where Furlong is, and that needs no
    // move history from then on.
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now + 3000 });
    writeDoorTombstone('west', seed, { farDoor: 'south', undockedAt: now + 4000 });
    expect(keepRestPlace('ship-room', now + 5000)).toBe(true);
    expect(readRestPlace()).toEqual({ at: was, since: now + 4000, from: 'furlong-station' });
    expect(keepRestPlace('ship-room', now + 6000)).toBe(false);
    // A release a station move has passed since is left for the moves to
    // place (nobody saw it at the time), not recorded from them.
    writeDoorPairing('east', seed, dock());
    expect(keepRestPlace('ship-room', now + 7000)).toBe(true);
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now + 8000 });
    expect(writeStationMove({
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now + 9000, arriveAt: now + 3_600_000,
      mode: 'thrusters', bookedAt: now - 1000, fuel: 1, fuelDrawn: 0,
    })).toBe(true);
    expect(keepRestPlace('ship-room', now + 10_000)).toBe(false);
    expect(shipPlaceId(readFlightRecord(), now + 10_000)).toBe(was);
  });

  it('leaves a ship a legacy berth carried to another planet where its DETACH let go of it', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    writeFlightRecord({ status: 'docked', locationId: 'furlong-station' });
    // A transient gangway from before docks were round: no dock chain.
    writeDoorPairing('east', seed, buildDoorPairing(seed, {
      segments: [{ kind: 'flex', bendDeg: 0 }], farDoor: 'south', farWall: 'y+', transient: true,
    }));
    expect(keepRestPlace('ship-room', now)).toBe(true);
    expect(readRestPlace()).toEqual({ at: placeOfStation('furlong-station'), since: now, docks: ['east'] });
    // Furlong carries it to Aris: the berth holds all the way.
    expect(writeStationMove({
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now + 1000, arriveAt: now + 10_000,
      mode: 'thrusters', bookedAt: now + 500, fuel: 1, fuelDrawn: 0,
    })).toBe(true);
    expect(berthHeldByMove('ship-room', 'east', now + 5000)).toBe(true);
    expect(keepRestPlace('ship-room', now + 5000)).toBe(false);
    // There, the rest record follows the station to its new place.
    const atAris = listStations(undefined, undefined, now + 11_000).find((st) => st.id === 'furlong-station')!;
    const there = adriftAt('planet-aris', atAris.orbitSlot);
    expect(berthHeldByMove('ship-room', 'east', now + 11_000)).toBe(false);
    expect(keepRestPlace('ship-room', now + 11_000)).toBe(true);
    expect(readRestPlace()).toEqual({ at: there, since: now + 11_000, docks: ['east'] });
    // DETACHed: a tombstone recording when and where Furlong let go of it.
    expect(detachBerth('east', now + 12_000)).toBe(true);
    expect(readDoor('east')).toEqual({
      paired: false, retiredAddress: seed, dock: { undockedAt: now + 12_000, farDoor: 'south', farWall: 'y+', at: there },
    });
    expect(detachBerth('east', now + 13_000)).toBe(false);
    expect(restingPlace(readRestPlace()!, now + 14_000)).toMatchObject({ at: there, releasedAt: now + 12_000, recorded: true });
    expect(shipPlaceId(readFlightRecord(), now + 14_000)).toBe('furlong-station');
  });

  it('names every dock holding the ship, so one that lets go after a move still counts', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const ports = Array.from({ length: 9 }, (_, i) => `d:port${i}`);
    writeFlightRecord({ status: 'docked', locationId: 'furlong-station' });
    for (const p of ports) {
      writeDoorPairing(p, seed, buildDoorPairing(seed, {
        segments: dockChain(), farDoor: `d:bay${p}`, farWall: 'y+', transient: true, dockedAt: now - 30_000,
      }));
    }
    expect(keepRestPlace('ship-room', now)).toBe(true);
    expect(readRestPlace()?.docks).toEqual(ports);
    // Eight let go, with nobody aboard to record it; the ninth carries the
    // ship to Aris with Furlong, and lets go there.
    for (const p of ports.slice(0, 8)) writeDoorTombstone(p, seed, { farDoor: `d:bay${p}`, undockedAt: now + 1000 });
    expect(writeStationMove({
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now + 2000, arriveAt: now + 10_000,
      mode: 'thrusters', bookedAt: now + 1500, fuel: 1, fuelDrawn: 0,
    })).toBe(true);
    writeDoorTombstone(ports[8], seed, { farDoor: `d:bay${ports[8]}`, undockedAt: now + 20_000 });
    const atAris = listStations(undefined, undefined, now + 21_000).find((st) => st.id === 'furlong-station')!;
    expect(atAris.planetId).toBe('planet-aris');
    expect(restingPlace(readRestPlace()!, now + 21_000)).toMatchObject({
      at: adriftAt('planet-aris', atAris.orbitSlot), releasedAt: now + 20_000,
    });
    expect(shipPlaceId(readFlightRecord(), now + 21_000)).toBe('furlong-station');
    // Recorded only off a snapshot that holds every door: a flood of keys
    // could hide a dock.
    const junk = Array.from({ length: 300 }, (_, i) => `junk${i}`);
    doc.transact(() => { for (const k of junk) doc.getMap('doors').set(k, 1); });
    expect(keepRestPlace('ship-room', now + 21_000)).toBe(false);
    doc.transact(() => { for (const k of junk) doc.getMap('doors').delete(k); });
    expect(keepRestPlace('ship-room', now + 21_000)).toBe(true);
    expect(readRestPlace()).toEqual({ at: adriftAt('planet-aris', atAris.orbitSlot), since: now + 20_000, from: 'furlong-station' });
  });

  it('takes a ship docked by hand from open orbit wherever its dock carries it', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    // Waiting in open orbit where a station it missed used to be.
    const waited = adriftAt(home.planetId, (home.orbitSlot + 3) % 16);
    writeFlightRecord({ status: 'docked', locationId: waited });
    expect(keepRestPlace('ship-room', now)).toBe(false);
    expect(shipPlaceId(readFlightRecord(), now)).toBe(waited);
    // Docked by hand at Furlong: the record still says open orbit, and the
    // rest record follows the dock.
    writeDoorPairing('east', seed, buildDoorPairing(seed, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now,
    }));
    expect(keepRestPlace('ship-room', now)).toBe(true);
    expect(readRestPlace()).toEqual({ at: placeOfStation('furlong-station'), since: now, docks: ['east'] });
    expect(shipPlaceId(readFlightRecord(), now)).toBe('furlong-station');
    // Furlong takes it to Aris, docked all the way.
    const move: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now + 1000, arriveAt: now + 10_000,
      mode: 'thrusters', bookedAt: now - 1000, fuel: 1, fuelDrawn: 0,
    };
    expect(writeStationMove(move)).toBe(true);
    expect(keepRestPlace('ship-room', now + 5000)).toBe(false);
    expect(shipPlaceId(readFlightRecord(), now + 5000)).toBe('furlong-station');
    // Let go of at Aris: beside Furlong there, not back where it waited, both
    // before and after the release is recorded.
    const atAris = listStations(undefined, undefined, now + 20_000).find((st) => st.id === 'furlong-station')!;
    expect(atAris.planetId).toBe('planet-aris');
    const there = adriftAt('planet-aris', atAris.orbitSlot);
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now + 20_000 });
    expect(shipPlaceId(readFlightRecord(), now + 21_000)).toBe('furlong-station');
    expect(keepRestPlace('ship-room', now + 21_000)).toBe(true);
    expect(readRestPlace()).toEqual({ at: there, since: now + 20_000, from: 'furlong-station' });
    expect(keepRestPlace('ship-room', now + 22_000)).toBe(false);
    expect(shipPlaceId(readFlightRecord(), now + 22_000)).toBe('furlong-station');
    // Furlong goes home without it: the ship stays at Aris where it was let go.
    expect(writeStationMove({
      ...move, fromPlanetId: 'planet-aris', fromSlot: atAris.orbitSlot, toPlanetId: home.planetId, toSlot: home.orbitSlot,
      departAt: now + 30_000, arriveAt: now + 40_000, bookedAt: now - 500,
    })).toBe(true);
    expect(listStations(undefined, undefined, now + 50_000).find((st) => st.id === 'furlong-station')!.planetId).toBe(home.planetId);
    expect(shipPlaceId(readFlightRecord(), now + 50_000)).toBe(there);
  });

  it('rests where its UNDOCK recorded the station letting go, whatever moves this install hears of since', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const homeAt = adriftAt(home.planetId, home.orbitSlot);
    writeFlightRecord({ status: 'docked', locationId: 'furlong-station' });
    writeDoorPairing('east', seed, buildDoorPairing(seed, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 60_000,
    }));
    expect(keepRestPlace('ship-room', now - 50_000)).toBe(true);
    // Let go of from Furlong's side while nobody was aboard: its UNDOCK
    // recorded where Furlong was.
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now - 40_000, at: homeAt });
    // Furlong went to Aris and came back to another slot; this install has
    // heard only of the way back (a planet summary's latest move, say).
    expect(writeStationMove({
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: 'planet-aris', fromSlot: 0,
      toPlanetId: home.planetId, toSlot: (home.orbitSlot + 2) % 16, departAt: now - 20_000, arriveAt: now - 10_000,
      mode: 'thrusters', bookedAt: now - 25_000, fuel: 1, fuelDrawn: 0,
    })).toBe(true);
    const back = listStations(undefined, undefined, now).find((st) => st.id === 'furlong-station')!;
    expect(back.planetId).toBe(home.planetId);
    expect(back.orbitSlot).not.toBe(home.orbitSlot);
    // Where it was let go, not where this install first heard Furlong leave from.
    expect(restingPlace(readRestPlace()!, now)).toMatchObject({ at: homeAt, recorded: true });
    expect(shipPlaceId(readFlightRecord(), now)).toBe(homeAt);
    // Kept so, with no move history needed.
    expect(keepRestPlace('ship-room', now)).toBe(true);
    expect(readRestPlace()).toEqual({ at: homeAt, since: now - 40_000, from: 'furlong-station' });
    expect(shipPlaceId(readFlightRecord(), now)).toBe(homeAt);
  });

  it('takes where the far room had its station as it let go, once the UNDOCK has learned the far room\'s moves', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const was = adriftAt(home.planetId, home.orbitSlot);
    const there = adriftAt('planet-aris', 3);
    writeFlightRecord({ status: 'docked', locationId: 'furlong-station' });
    writeDoorPairing('east', seed, buildDoorPairing(seed, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 60_000,
    }));
    expect(keepRestPlace('ship-room', now - 50_000)).toBe(true);
    // UNDOCK from the ship: it records Furlong where this install last heard
    // of it, and the flight watch keeps the ship there before the far room
    // answers.
    const undockedAt = now - 40_000;
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt, at: was });
    expect(keepRestPlace('ship-room', now - 39_000)).toBe(true);
    expect(readRestPlace()).toEqual({ at: was, since: undockedAt, from: 'furlong-station' });
    // The far room had Furlong at Aris by then: both say so now.
    expect(correctReleasePlace('east', undockedAt, was, there)).toBe(true);
    expect(readDoor('east')).toMatchObject({ paired: false, dock: { farDoor: 'south', undockedAt, at: there } });
    expect(readRestPlace()).toEqual({ at: there, since: undockedAt, from: 'furlong-station' });
    expect(shipPlaceId(readFlightRecord(), now)).toBe(there);
    // No news, no place, or a tombstone another release has written since:
    // left as it is.
    expect(correctReleasePlace('east', undockedAt, there, there)).toBe(false);
    expect(correctReleasePlace('east', undockedAt, there, undefined)).toBe(false);
    expect(correctReleasePlace('east', undockedAt - 1, there, was)).toBe(false);
    expect(readDoor('east')).toMatchObject({ dock: { at: there } });
    // A rest taken from another release stays too, at the same place or not.
    expect(writeRestPlace({ at: there, since: undockedAt - 5, from: 'furlong-station' })).toBe(true);
    expect(correctReleasePlace('east', undockedAt, there, was)).toBe(true);
    expect(readRestPlace()).toEqual({ at: there, since: undockedAt - 5, from: 'furlong-station' });
  });

  it('reads a rest record off the wire only when it is well formed', () => {
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5 })).toBe(true);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, docks: ['north', 'd:bay'] })).toBe(true);
    expect(isRestPlace({ at: 'furlong-station', since: 5 })).toBe(false);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: -1 })).toBe(false);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, docks: ['no such door'] })).toBe(false);
    const ports = (n: number) => Array.from({ length: n }, (_, i) => `d:${i}`);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, docks: ports(MAX_REST_DOCKS) })).toBe(true);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, docks: ports(MAX_REST_DOCKS + 1) })).toBe(false);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, from: 'furlong-station' })).toBe(true);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, from: 7 })).toBe(false);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, from: 'x'.repeat(129) })).toBe(false);
  });

  it('keeps where DEPART casts off from and flies to, through the flight only', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const homeAt = adriftAt(home.planetId, home.orbitSlot);
    expect(castOffPlaces('furlong-station', 'nowhere')).toEqual({ originAt: homeAt });
    expect(castOffPlaces(adriftAt('planet-aris', 3), 'furlong-station'))
      .toEqual({ originAt: adriftAt('planet-aris', 3), destinationAt: homeAt });
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt: now - 2, etaAt: now - 1, ...castOffPlaces('furlong-station', 'high-orbit') });
    expect(readFlightRecord().originAt).toBe(homeAt);
    writeFlightRecord({ status: 'redocking', locationId: 'high-orbit', departedAt: now - 2, etaAt: now - 1, originAt: homeAt });
    expect(readFlightRecord().originAt).toBeUndefined();
  });
});

describe("a tug's hold on the station it tows", () => {
  afterEach(() => {
    setStationMoveResolver(null);
    bindStationMoveDoc(new Y.Doc());
  });

  it('lasts while any dock into the station holds, and ends when the last one lets go', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const dock = () => buildDoorPairing(seed, { segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 60_000 });
    const tow: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 50_000, arriveAt: now - 10_000,
      mode: 'tug', tugRoomId: 'tug-room', bookedAt: now - 55_000, fuel: 1, fuelDrawn: 0,
    };
    expect(writeStationMove(tow)).toBe(true);
    const docked = { status: 'docked' };
    // Towing through two ports.
    writeDoorPairing('east', seed, dock());
    writeDoorPairing('west', seed, dock());
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt)).toBe(true);
    // One let go mid-tow (an UNDOCK made offline, say): the other still holds.
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: tow.departAt + 5000 });
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt)).toBe(true);
    expect(cancelTowLeftBehind('tug-room', docked, now, dockedToStation)).toBe(false);
    // The other held on past the arrival: the tow stands, however late this
    // tab learns of either release.
    writeDoorTombstone('west', seed, { farDoor: 'south', undockedAt: tow.arriveAt + 2000 });
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt)).toBe(tow.arriveAt + 2000);
    expect(cancelTowLeftBehind('tug-room', docked, now, dockedToStation)).toBe(false);
    // Both let go mid-tow: the tug left the station behind when the last did.
    writeDoorTombstone('west', seed, { farDoor: 'south', undockedAt: tow.departAt + 9000 });
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt)).toBe(tow.departAt + 9000);
    expect(cancelTowLeftBehind('tug-room', docked, now, dockedToStation)).toBe(true);
    // Releases before `since` are an earlier stay's; another station's docks
    // are not this one's; a snapshot that could leave a dock out proves no
    // release.
    expect(dockedToStation(home.welcomeRoomId, tow.departAt + 10_000)).toBe(false);
    expect(dockedToStation('another-station-room', tow.bookedAt)).toBe(false);
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt, null)).toBe(true);
  });
});

describe('berth memory in the ship doc', () => {
  beforeEach(() => bindShipDoc(new Y.Doc()));

  it('round-trips, forgets, and refuses junk', () => {
    writeStationBerth('high-orbit', { doorId: 'north', roomId: HIGH_ROOM, farWall: 'x+' });
    expect(readStationBerth('high-orbit')).toEqual({ doorId: 'north', roomId: HIGH_ROOM, farWall: 'x+' });
    writeStationBerth('high-orbit', { doorId: 'north', roomId: '', farWall: 'x+' });
    expect(readStationBerth('high-orbit')?.roomId).toBe(HIGH_ROOM);
    writeStationBerth('high-orbit', null);
    expect(readStationBerth('high-orbit')).toBeNull();
  });

  it('never reads an inherited value for a station id like "constructor"', () => {
    expect(readStationBerth('constructor')).toBeNull();
    expect(readStationBerth('toString')).toBeNull();
  });

  it('refuses a new station past the cap but still updates and forgets', () => {
    for (let i = 0; i < 32; i++) {
      expect(writeStationBerth(`s${i}`, { doorId: 'north', roomId: HIGH_ROOM })).toBe(true);
    }
    expect(writeStationBerth('one-too-many', { doorId: 'north', roomId: HIGH_ROOM })).toBe(false);
    expect(readStationBerth('one-too-many')).toBeNull();
    expect(writeStationBerth('s0', { doorId: 'east', roomId: FURLONG_ROOM })).toBe(true);
    expect(readStationBerth('s0')?.doorId).toBe('east');
    expect(writeStationBerth('s1', null)).toBe(true);
    expect(writeStationBerth('one-too-many', { doorId: 'north', roomId: HIGH_ROOM })).toBe(true);
    expect(readStationBerth('one-too-many')).not.toBeNull();
  });

  it('drops hostile entries on read', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    doc.getMap('ship').set('berths', {
      good: { doorId: 'north', roomId: FURLONG_ROOM },
      badWall: { doorId: 'north', roomId: FURLONG_ROOM, farWall: 'up' },
      badLat: { doorId: 'north', roomId: FURLONG_ROOM, farLateral: Infinity },
      wideLat: { doorId: 'north', roomId: FURLONG_ROOM, farLateral: 33 },
      badDoor: { doorId: 'north', roomId: FURLONG_ROOM, farDoor: 'not-a-door' },
      withPass: { doorId: 'north', roomId: FURLONG_ROOM, address: SEED_FURLONG },
      notObj: 7,
    });
    expect(readStationBerth('good')).toEqual({ doorId: 'north', roomId: FURLONG_ROOM });
    expect(readStationBerth('badWall')).toBeNull();
    expect(readStationBerth('badLat')).toBeNull();
    expect(readStationBerth('wideLat')).toBeNull();
    expect(readStationBerth('badDoor')).toBeNull();
    // A pass never rides in the shared ship doc.
    expect(readStationBerth('withPass')).toBeNull();
    expect(readStationBerth('notObj')).toBeNull();
  });

  it('stops inspecting a map flooded with junk keys', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    const berths: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) berths[`junk${i}`] = 7;
    berths.late = { doorId: 'north', roomId: FURLONG_ROOM };
    doc.getMap('ship').set('berths', berths);
    expect(readStationBerth('late')).toBeNull();
  });
});

describe('what the helm hears after an arrival DOCK', () => {
  beforeEach(() => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    writeDoorTombstone('north', SEED_FURLONG, { farDoor: 'south', undockedAt: 2000 });
    setStationDirectory({ stations: () => [{ ...DEFAULT_STATIONS[0], berth: { address: SEED_FURLONG, farDoor: 'south' } }, DEFAULT_STATIONS[1]] });
  });
  afterEach(() => setStationDirectory(null));

  const arrive = (answer: boolean) => {
    const docking = { ...fakeDocking(['north']), dock: async () => answer };
    fly('high-orbit', 'furlong-station');
    return new Promise<ArrivalOutcome>((resolve) => {
      expect(completeArrival(docking, { onSettled: resolve })).toEqual({ kind: 'docking', stationName: 'Furlong Station' });
    });
  };

  it('docked, once the berth takes the ship', async () => {
    expect(await arrive(true)).toEqual({ kind: 'docked', stationName: 'Furlong Station' });
  });

  it('says nothing once the player has joined another room before the berth answers', async () => {
    let room = 'ship-room';
    setStationRoomSource(() => room);
    try {
      let answer: (ok: boolean) => void = () => {};
      const docking = { ...fakeDocking(['north']), dock: () => new Promise<boolean>((r) => { answer = r; }) };
      fly('high-orbit', 'furlong-station');
      const heard: ArrivalOutcome[] = [];
      expect(completeArrival(docking, { onSettled: (o) => heard.push(o) })?.kind).toBe('docking');
      room = 'other-room';
      answer(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(heard).toEqual([]);
    } finally {
      setStationRoomSource(() => '');
    }
  });

  it('refused, when the berth is taken — not a green "docking" note left standing', async () => {
    expect(await arrive(false)).toEqual({ kind: 'none', stationName: 'Furlong Station', reason: 'berths-taken' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'furlong-station' });
    // At rest beside Furlong, by the port that never docked: there it stays.
    expect(readRestPlace()).toEqual({ at: placeOfStation('furlong-station'), since: expect.any(Number), docks: ['north'] });
    expect(shipPlaceId(readFlightRecord())).toBe('furlong-station');
  });
});
