// shipArrival.ts tests: the pure arrival planner, the berth a departure
// remembers, and whole trips — undock, fly, arrive, re-dock — over real Yjs
// ship + doors docs with a stand-in docking system that makes the same
// near-side writes as docking.ts's UNDOCK / DOCK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listStations, planetById, setStationMoveResolver, setStationRoomSource } from './stations';
import {
  MOVE_SCAN_MAX, bindStationMoveDoc, cancelTowLeftBehind, installStationMoveResolver, readStationMove, rejectionOf, writeStationMove,
  type StationMove,
} from './stationMove';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import { berthMemoryFrom, classifyDockPort, redockRecord, stampAfter, type DockAnswer, type NearEnd } from './dockRules';
import { applyFarDockRequest } from './farDoorWrite';
import {
  bindDoorsDoc,
  buildDoorPairing,
  MAX_PAIRINGS,
  readDoor,
  writeDoorPairing,
  writeDoorTombstone,
} from './doorsDoc';
import {
  berthPassFor,
  berthHeldByMove,
  berthPairings,
  berthStillThere,
  berthsToCastOff,
  berthToRemember,
  detachBerth,
  detachLegacyBerthAt,
  ARRIVAL_GRACE_MS,
  castOffForDeparture,
  resolveRememberedBerth,
  setBerthSeedResolver,
  castOffRefusal,
  rememberBerthHere,
  releaseEveryDock,
  completeArrival,
  planArrivalDock,
  arrivalBerths,
  type ArrivalOutcome,
  shipLocationId,
  shipPlaceId,
  castOffPlaces,
  correctReleasePlace,
  releasePlaceOf,
  dockedToStation,
  keepRestPlace,
  restBeside,
  restingPlace,
  type ArrivalPort,
  type ShipDockingApi,
} from './shipArrival';
import {
  bindShipDoc,
  endUndockHold,
  holdUndock,
  isRestPlace,
  MAX_REST_DOCKS,
  UNDOCK_HOLD_MS,
  readFlightRecord,
  readRestPlace,
  readStationBerth,
  writeFlightRecord,
  writeRestPlace,
  writeStationBerth,
  type FlightRecord,
} from './shipDoc';
import {
  adriftAt, adriftPlace, destinationsFrom, destinationsFromRecords, locationPlanet, planHop, setStationDirectory, DEFAULT_STATIONS,
  type StationDestination,
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

  it('counts a dock at a station gate this client cannot address as already there', () => {
    // Another commander docked the ship at HIGH's room, a gate of this
    // station this client holds no pass for, so no candidate names it.
    expect(planArrivalDock({
      station: { berths: [{ address: SEED_FURLONG, farDoor: 'd:a3313fdd' }], berthRooms: [FURLONG_ROOM, HIGH_ROOM] },
      remembered: null,
      ports: [{ doorId: 'north', state: dockedTo(SEED_HIGH) }, { doorId: 'east', state: FREE }],
    })).toEqual({ kind: 'none', reason: 'already-docked' });
  });

  it('counts that dock as already there when this client can address no gate at all', () => {
    expect(planArrivalDock({
      station: { berths: [], berthRooms: [FURLONG_ROOM, HIGH_ROOM] },
      remembered: null,
      ports: [{ doorId: 'north', state: dockedTo(SEED_HIGH) }, { doorId: 'east', state: FREE }],
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

describe('berthPassFor (🎫 the passes the helm, a DOCK and the boards count)', () => {
  afterEach(() => setBerthSeedResolver(null));

  it("is this client's own pass for the room, else a docked or undocked port's address that names it", () => {
    expect(berthPassFor(FURLONG_ROOM, [])).toBeUndefined();
    expect(berthPassFor(FURLONG_ROOM, [{ doorId: 'east', state: FREE }])).toBeUndefined();
    expect(berthPassFor(FURLONG_ROOM, [{ doorId: 'north', state: undockedFrom(SEED_FURLONG) }])).toBe(SEED_FURLONG);
    expect(berthPassFor(FURLONG_ROOM, [
      { doorId: 'east', state: dockedTo(SEED_HIGH) },
      { doorId: 'north', state: dockedTo(SEED_FURLONG) },
    ])).toBe(SEED_FURLONG);
    // A port naming another room is no pass for this one.
    expect(berthPassFor(FURLONG_ROOM, [{ doorId: 'east', state: dockedTo(SEED_HIGH) }])).toBeUndefined();
    // Its own pass comes first…
    setBerthSeedResolver((room) => (room === FURLONG_ROOM ? SEED_FURLONG_OTHER_HINTS : undefined));
    expect(berthPassFor(FURLONG_ROOM, [{ doorId: 'north', state: undockedFrom(SEED_FURLONG) }])).toBe(SEED_FURLONG_OTHER_HINTS);
    // …unless it names another room: then the port's.
    setBerthSeedResolver(() => SEED_HIGH);
    expect(berthPassFor(FURLONG_ROOM, [{ doorId: 'north', state: undockedFrom(SEED_FURLONG) }])).toBe(SEED_FURLONG);
    expect(berthPassFor(HIGH_ROOM, [])).toBe(SEED_HIGH);
    // No room is no room, whatever a port's address fails to name.
    const junk = { ...undockedFrom(SEED_FURLONG), address: 'ssf://room#nothing' } as ArrivalPort['state'];
    expect(berthPassFor('', [{ doorId: 'north', state: junk }])).toBeUndefined();
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
    // A peer-written far lateral past the bound door records keep: berth
    // memory refuses it.
    const bad = [{ doorId: 'north', state: classifyDockPort(buildDoorPairing(SEED_FURLONG, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', farLateral: 99, transient: true, dockedAt: 1000,
    })) }];
    expect(rememberBerthHere('furlong-station', bad)).toBe(false);
    expect(readStationBerth('s0')).not.toBeNull();
  });

  it('remembers a berth in a room whose id is longer than a station id, so DEPART can go', () => {
    // A room id is any non-empty string, as decodeBootstrapSeed, the station
    // records and the atlas take one; only station ids stop at 128.
    const room = `furlong-${'r'.repeat(200)}`;
    const seed = `ssf://room#room=${room}`;
    writeDoorPairing('north', seed, buildDoorPairing(seed, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: 1000,
    }));
    expect(rememberBerthHere('furlong-station', fakeDocking(['north']).ports())).toBe(true);
    expect(readStationBerth('furlong-station')?.roomId).toBe(room);
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

  it('docks at a destination back where it orbited at cast-off, whatever moves it made meanwhile', () => {
    const now = Date.now();
    const docking = fakeDocking(['north']);
    castOffForDeparture('furlong-station', docking);
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const then = placeOfStation('furlong-station');
    // Furlong left for Aris while the ship was away, and bounced home off a
    // full planet: it orbits where it did at cast-off.
    const lastMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 500_000, arriveAt: now - 1000,
      mode: 'tug' as const, tugRoomId: 'tug', fuel: 1, fuelDrawn: 0,
    };
    setStationDirectory({ stations: () => [{ ...DEFAULT_STATIONS[0], lastMove }, ...DEFAULT_STATIONS.slice(1)] });
    const trip = { departedAt: now - 600_000, etaAt: now - 1, castOffAt: now - 600_000 };
    writeFlightRecord({ status: 'in-flight', locationId: 'high-orbit', destinationId: 'furlong-station', ...trip, destinationAt: then });
    writeFlightRecord({ status: 'redocking', locationId: 'furlong-station', ...trip, destinationAt: then });
    expect(completeArrival(docking, { now, force: true })).toEqual({ kind: 'docking', stationName: 'Furlong Station' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'furlong-station' });
    // A flight that kept no such place goes by the move it made meanwhile.
    castOffForDeparture('furlong-station', docking);
    writeFlightRecord({ status: 'in-flight', locationId: 'high-orbit', destinationId: 'furlong-station', ...trip });
    writeFlightRecord({ status: 'redocking', locationId: 'furlong-station', ...trip });
    expect(completeArrival(docking, { now, force: true })).toMatchObject({ kind: 'none', reason: 'in-transit' });
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
    // A flight that kept no place, with no move known since it cast off, and
    // a ship at rest, go by the record.
    expect(shipPlaceId({ ...flight, originAt: undefined }, now)).toBe('furlong-station');
    expect(shipPlaceId({ status: 'docked', locationId: 'furlong-station', originAt: left }, now)).toBe('furlong-station');
  });

  it('🚏 rests a ferry handed back at its end stop beside that stop, whatever rest an earlier stop left', () => {
    const now = Date.now();
    const elsewhere = adriftAt('planet-sovereign', 9);
    // The rest an earlier stop's release left, beside a station elsewhere.
    expect(writeRestPlace({ at: elsewhere, since: now - 60_000 })).toBe(true);
    const handedBack: FlightRecord = { status: 'docked', locationId: 'furlong-station' };
    expect(shipPlaceId(handedBack, now)).toBe(elsewhere);
    // The route's copy-back records where it left the ship (main.ts).
    restBeside('furlong-station', now, []);
    expect(readRestPlace()).toEqual({ at: placeOfStation('furlong-station'), since: Math.floor(now) });
    expect(shipPlaceId(handedBack, now)).toBe('furlong-station');
  });

  it('keeps a ship whose flight kept no place where its station was at cast-off, by the moves known here', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const left = placeOfStation('furlong-station');
    // Flights from before flights kept where their stations orbited: cast
    // off from Furlong (waiting for its window, or on the way), and arrived
    // at it.
    const leftAt = now - 120_000;
    const flying: FlightRecord = {
      status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt: leftAt, etaAt: now + 60_000, castOffAt: leftAt,
    };
    const arrived: FlightRecord = { status: 'redocking', locationId: 'furlong-station', departedAt: leftAt, etaAt: now - 1 };
    expect(shipPlaceId(flying, now)).toBe('furlong-station');
    expect(shipPlaceId(arrived, now)).toBe('furlong-station');
    // Furlong left for Aris after the ship cast off: neither went with it.
    const transfer: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 100_000, arriveAt: now - 60_000,
      mode: 'thrusters', bookedAt: now - 110_000, fuel: 1, fuelDrawn: 0,
    };
    expect(writeStationMove(transfer)).toBe(true);
    expect(listStations().find((st) => st.id === 'furlong-station')!.planetId).toBe('planet-aris');
    expect(shipPlaceId(flying, now)).toBe(left);
    expect(shipPlaceId(arrived, now)).toBe(left);
    // Cast off once Furlong was at Aris: there with it, by the record.
    expect(shipPlaceId({ ...flying, departedAt: now - 50_000, castOffAt: now - 50_000 }, now)).toBe('furlong-station');
    expect(shipPlaceId({ ...arrived, departedAt: now - 50_000 }, now)).toBe('furlong-station');
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

  it('keeps where a ship rests when a door its rest names has docked into another lone module since', () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const was = placeOfStation('furlong-station');
    const rec: FlightRecord = { status: 'docked', locationId: 'furlong-station' };
    writeRestPlace({ at: was, since: now - 60_000, docks: ['east'] });
    // East docked into a pod since: a module of its own, no station's.
    const pod = 'ssf://room#room=lone-pod';
    writeDoorPairing('east', pod, buildDoorPairing(pod, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 30_000,
    }));
    // And Furlong went to Aris meanwhile.
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 50_000, arriveAt: now - 10_000,
      mode: 'thrusters', bookedAt: now - 55_000, fuel: 1, fuelDrawn: 0,
    } : null));
    // A pod no list here holds: where that dock holds the ship is unknown,
    // so the record's station says.
    expect(restingPlace(readRestPlace()!, now)).toEqual({ heldBy: null });
    expect(shipPlaceId(rec, now)).toBe('furlong-station');
    // Known for a lone module, the dock holds the ship nowhere: it rests
    // where it came to rest, not where Furlong went.
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    const store = new Map([['ssf-station-atlas', JSON.stringify({ 'lone-pod': { roomId: 'lone-pod', name: 'POD', doors: {}, lastSeen: 0 } })]]);
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    try {
      expect(restingPlace(readRestPlace()!, now)).toEqual({ at: was });
      expect(shipPlaceId(rec, now)).toBe(was);
    } finally {
      if (before === undefined) delete g.localStorage;
      else g.localStorage = before;
    }
  });

  it('arrives where its station was at cast-off, kept by no flight of old, through a transfer and a tow cancelled after it', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const then = placeOfStation('furlong-station');
    // A flight that kept no place for its destination (from before flights did).
    const leftAt = now - 120_000;
    expect(writeFlightRecord({ status: 'in-flight', locationId: 'high-orbit', destinationId: 'furlong-station', departedAt: leftAt, etaAt: now - 1 })).toBe(true);
    expect(writeFlightRecord({ status: 'redocking', locationId: 'furlong-station', departedAt: leftAt, etaAt: now - 1 })).toBe(true);
    // Meanwhile Furlong went to Aris, and a tow on from there was cancelled:
    // that cancel, its latest, stands for no journey.
    const transfer: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 100_000, arriveAt: now - 60_000,
      mode: 'thrusters', bookedAt: now - 110_000, fuel: 1, fuelDrawn: 0,
    };
    const tow: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: 'planet-aris', fromSlot: 0,
      toPlanetId: home.planetId, toSlot: (home.orbitSlot + 3) % 16, departAt: now - 30_000, arriveAt: now + 3_600_000,
      mode: 'tug', tugRoomId: 'tug-room', bookedAt: now - 40_000, fuel: 1, fuelDrawn: 0,
    };
    expect(writeStationMove(transfer)).toBe(true);
    expect(writeStationMove(tow)).toBe(true);
    expect(writeStationMove(rejectionOf(tow)!)).toBe(true);
    // The directory lists the stations as the station list does, each with
    // its latest move.
    setStationDirectory({ stations: () => destinationsFromRecords(listStations(), () => undefined) });
    try {
      expect(listStations().find((st) => st.id === 'furlong-station')!.planetId).toBe('planet-aris');
      const dest = destinationsFromRecords(listStations(), () => undefined).find((d) => d.id === 'furlong-station')!;
      expect(dest.lastMove?.settles).toMatchObject({ mode: 'tug', departAt: tow.departAt });
      // Not docked on Aris: it waits where Furlong was as it cast off.
      expect(completeArrival(null, { now, force: true }))
        .toEqual({ kind: 'none', stationName: dest.name, reason: 'in-transit' });
      expect(readFlightRecord()).toEqual({ status: 'docked', locationId: then });
      expect(shipPlaceId(readFlightRecord(), now)).toBe(then);
    } finally {
      setStationDirectory(null);
    }
  });

  it('tells a DOCK whether the station it was asked of is still where it was', () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const at = releasePlaceOf(home.welcomeRoomId, now);
    expect(at).toBe(placeOfStation('furlong-station'));
    expect(berthStillThere(home.welcomeRoomId, at, now)).toBe(true);
    // Learned meanwhile (the far room's moves) to have gone to Aris, or to be
    // on its way there: out of the ship's reach.
    const move: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 50_000, arriveAt: now - 10_000,
      mode: 'thrusters', bookedAt: now - 55_000, fuel: 1, fuelDrawn: 0,
    };
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? move : null));
    expect(berthStillThere(home.welcomeRoomId, at, now)).toBe(false);
    setStationMoveResolver((st) => (st.id === 'furlong-station' ? { ...move, arriveAt: now + 3_600_000 } : null));
    expect(berthStillThere(home.welcomeRoomId, at, now)).toBe(false);
    // A room no listed station holds was nowhere known, and still is.
    expect(releasePlaceOf('lone-pod', now)).toBeUndefined();
    expect(berthStillThere('lone-pod', undefined, now)).toBe(true);
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

  it('casts off every transient berth at DEPART, unless a station move holds one or the moves cannot all be read', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const cast = (t: number) => {
      const r = berthsToCastOff('ship-room', t);
      return r.ok ? [...r.berths].sort() : r.why;
    };
    // A dock, a legacy gangway into Furlong (no dock chain), and a
    // permanent connector, which is no berth.
    writeDoorPairing('north', SEED_HIGH, buildDoorPairing(SEED_HIGH, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: 1000,
    }));
    writeDoorPairing('east', seed, buildDoorPairing(seed, {
      segments: [{ kind: 'flex', bendDeg: 0 }], farDoor: 'south', farWall: 'y+', transient: true,
    }));
    writeDoorPairing('west', 'ssf://room#room=ship-annex', buildDoorPairing('ssf://room#room=ship-annex', {
      segments: [{ kind: 'flex', bendDeg: 0 }], farDoor: 'east', farWall: 'x+',
    }));
    expect(cast(now)).toEqual(['east', 'north']);
    // Furlong leaves for Aris: the gangway holds the ship until it arrives.
    expect(writeStationMove({
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now + 1000, arriveAt: now + 10_000,
      mode: 'thrusters', bookedAt: now + 500, fuel: 1, fuelDrawn: 0,
    })).toBe(true);
    expect(cast(now + 5000)).toBe('moving');
    expect(cast(now + 11_000)).toEqual(['east', 'north']);
    // Nor while the room's moves cannot all be read (a flood): the one
    // holding a berth may lie past them, until they are cleared.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      doc.transact(() => {
        for (let i = 0; i <= MOVE_SCAN_MAX; i++) doc.getMap('stationMoves').set(`junk:${i}`, i);
      });
      expect(cast(now + 11_000)).toBe('unread');
      vi.runAllTimers();
      expect(cast(now + 11_000)).toEqual(['east', 'north']);
    } finally {
      vi.useRealTimers();
    }
    // More door records than a snapshot keeps (a peer's flood, on doors the
    // room lacks): the room's own doors are read past it, so it hides no
    // berth; and a dock on a door the room lacks is none.
    doc.transact(() => {
      for (let i = 0; i < MAX_PAIRINGS; i++) writeDoorTombstone(`d:${i}`, SEED_HIGH, { farDoor: 'south', undockedAt: 1000 + i });
    });
    writeDoorPairing('d:ghost', SEED_HIGH, buildDoorPairing(SEED_HIGH, {
      segments: dockChain(), farDoor: 'north', farWall: 'y+', transient: true, dockedAt: 1000,
    }));
    expect(cast(now + 11_000)).toEqual(['east', 'north']);
  });

  it('casts off at DEPART only the berths its far rooms were asked about, each the pairing it was', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const gangway = (dockedAt: number) => buildDoorPairing(seed, {
      segments: [{ kind: 'flex', bendDeg: 0 }], farDoor: 'south', farWall: 'y+', transient: true, dockedAt,
    });
    writeDoorPairing('east', seed, gangway(1000));
    const asked = berthPairings(['east']);
    expect(berthsToCastOff('ship-room', now, asked)).toEqual({ ok: true, berths: ['east'] });
    // Made again meanwhile: that pairing was never judged at this moment.
    writeDoorPairing('east', seed, gangway(2000));
    expect(berthsToCastOff('ship-room', now, asked)).toEqual({ ok: false, why: 'changed' });
    expect(berthsToCastOff('ship-room', now)).toEqual({ ok: true, berths: ['east'] });
    // Nor one that turned up meanwhile.
    writeDoorPairing('east', seed, gangway(1000));
    writeDoorPairing('west', seed, gangway(3000));
    expect(berthsToCastOff('ship-room', now, asked)).toEqual({ ok: false, why: 'changed' });
    // One let go meanwhile is just not there to cast off.
    writeDoorTombstone('west', seed, { farDoor: 'south', undockedAt: 4000 });
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: 4000 });
    expect(berthsToCastOff('ship-room', now, asked)).toEqual({ ok: true, berths: [] });
  });

  it('lets a legacy berth go at the stamp its far room judged, so a tow booked there meanwhile leaves after it', async () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.now();
      const home = listStations().find((st) => st.id === 'furlong-station')!;
      const homeAt = adriftAt(planetById(home.planetId).id, home.orbitSlot);
      const seed = `ssf://room#room=${home.welcomeRoomId}`;
      const gangway = (dockedAt: number) => buildDoorPairing(seed, {
        segments: [{ kind: 'flex', bendDeg: 0 }], farDoor: 'south', farWall: 'y+', transient: true, dockedAt,
      });
      const near: NearEnd = { roomId: 'ship-room', address: 'ssf://room#room=ship-room', doorId: 'east' };
      const releaseAsk = (undockedAt: number) => ({ kind: 'release' as const, nearRoomId: 'ship-room', farAddress: seed, nearDoorId: 'east', undockedAt });
      // Furlong's own room, where a tug books a tow, leaving at once, while
      // the far room's answer is on its way back: this install never hears.
      const farDoc = new Y.Doc();
      const tow: StationMove = {
        stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
        toPlanetId: 'planet-aris', toSlot: 0, departAt: now + 2000, arriveAt: now + 600_000,
        mode: 'tug', tugRoomId: 'tug-room', bookedAt: now + 2000, fuel: 1, fuelDrawn: 0,
      };
      writeDoorPairing('east', seed, gangway(now - 60_000));
      let judged = Number.NaN;
      const ask = async (at: number) => {
        judged = stampAfter(now - 60_000, at);
        const { result } = applyFarDockRequest(farDoc, releaseAsk(judged), near, home.welcomeRoomId);
        farDoc.getMap('stationMoves').set(`move:1:${tow.departAt}:${home.welcomeRoomId}`, tow);
        vi.setSystemTime(now + 5000);
        return result.ok || result.reason !== 'moving';
      };
      expect(await detachLegacyBerthAt('ship-room', 'east', ask, () => 'ship-room')).toBe('released');
      // The tombstone takes the stamp the far room judged, before the tow
      // left: the ship stays where Furlong was then.
      expect(judged).toBe(now);
      expect(readDoor('east')).toMatchObject({ paired: false, dock: { undockedAt: now, at: homeAt } });
      // Judged as the answer came back, the far room would have held it.
      expect(applyFarDockRequest(farDoc, releaseAsk(Date.now()), near, home.welcomeRoomId).result).toEqual({ ok: false, reason: 'moving' });
      // A pairing made again while the far room answered is left as it is…
      writeDoorPairing('east', seed, gangway(Date.now() - 1000));
      const remade = gangway(Date.now());
      expect(await detachLegacyBerthAt('ship-room', 'east', async () => {
        writeDoorPairing('east', seed, remade);
        return true;
      }, () => 'ship-room')).toBe('changed');
      expect(readDoor('east')).toMatchObject({ paired: true, dockedAt: remade.dockedAt });
      // …and so is one in a room the player has left.
      expect(await detachLegacyBerthAt('ship-room', 'east', async () => true, () => 'elsewhere')).toBe('changed');
      expect(readDoor('east')).toMatchObject({ paired: true, dockedAt: remade.dockedAt });
      // A move this install knows holds the berth at that moment: held,
      // whatever the far room said.
      const moving = Date.now();
      expect(writeStationMove({
        stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
        toPlanetId: 'planet-aris', toSlot: 0, departAt: moving - 1000, arriveAt: moving + 600_000,
        mode: 'thrusters', bookedAt: moving - 2000, fuel: 1, fuelDrawn: 0,
      })).toBe(true);
      expect(await detachLegacyBerthAt('ship-room', 'east', async () => true, () => 'ship-room')).toBe('held');
      expect(await detachLegacyBerthAt('ship-room', 'east', async () => false, () => 'ship-room')).toBe('held');
      expect(readDoor('east')).toMatchObject({ paired: true, dockedAt: remade.dockedAt });
    } finally {
      vi.useRealTimers();
    }
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
    // 🚏 In open orbit where a ferry route left it: only ever `true`.
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, open: true })).toBe(true);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, open: false })).toBe(false);
    expect(isRestPlace({ at: adriftAt('planet-aris', 2), since: 5, open: 'yes' })).toBe(false);
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

  it('holds while an UNDOCK still waits on its far room, so a refusal that puts the dock back leaves the tow standing', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindStationMoveDoc(doc);
    installStationMoveResolver();
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    const dock = buildDoorPairing(seed, { segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: now - 60_000 });
    // A tow under way, which this tab heard of only after an UNDOCK began.
    const tow: StationMove = {
      stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
      toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 10_000, arriveAt: now + 600_000,
      mode: 'tug', tugRoomId: 'tug-room', bookedAt: now - 20_000, fuel: 1, fuelDrawn: 0,
    };
    expect(writeStationMove(tow)).toBe(true);
    const docked = { status: 'docked' };
    writeDoorPairing('east', seed, dock);
    // The UNDOCK writes its tombstone under a hold, and asks the far room.
    const undockedAt = now - 5000;
    expect(holdUndock('east', undockedAt, now - 5000)).toBe(true);
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt });
    // A reconciliation tick before the answer: the dock still holds the tow.
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt)).toBe(true);
    expect(cancelTowLeftBehind('tug-room', docked, now, dockedToStation)).toBe(false);
    // The far room refuses (its station is between planets): the dock is put
    // back, then the hold ends, and the tow stands.
    writeDoorPairing('east', seed, dock);
    endUndockHold('east', undockedAt);
    expect(cancelTowLeftBehind('tug-room', docked, now + 1000, dockedToStation)).toBe(false);
    expect(readStationMove()).toEqual(tow);
    // A hold covers its own release only: another one's tombstone on that
    // door is a release already.
    expect(holdUndock('east', now + 2000, now + 2000)).toBe(true);
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now + 1500 });
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt, undefined, now + 2500)).toBe(now + 1500);
    // A release the far room let through stands once answered: the tug left
    // the station behind.
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now + 2000 });
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt, undefined, now + 2500)).toBe(true);
    expect(cancelTowLeftBehind('tug-room', docked, now + 2500, dockedToStation)).toBe(false);
    endUndockHold('east', now + 2000);
    expect(dockedToStation(home.welcomeRoomId, tow.bookedAt, undefined, now + 3000)).toBe(now + 2000);
    expect(cancelTowLeftBehind('tug-room', docked, now + 3000, dockedToStation)).toBe(true);
  });

  it('lets a release stand once the UNDOCK that held it has gone quiet past its hold', () => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    expect(holdUndock('east', now, now)).toBe(true);
    writeDoorTombstone('east', seed, { farDoor: 'south', undockedAt: now });
    expect(dockedToStation(home.welcomeRoomId, now - 1, undefined, now + UNDOCK_HOLD_MS - 1)).toBe(true);
    // Its helm went away mid-way: the release stands, as one whose far room
    // cannot be reached does.
    expect(dockedToStation(home.welcomeRoomId, now - 1, undefined, now + UNDOCK_HOLD_MS)).toBe(now);
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

// ── ⚓🚦 Gates ─────────────────────────────────────────────────────────────────

describe('arrival gates', () => {
  const SEED_GATE_ROOM = 'ssf://room#room=high-gates';
  const gate = (n: number, door: string, occupied = false) =>
    ({ address: SEED_GATE_ROOM, farDoor: door, gate: n, ...(occupied ? { occupied: true } : {}) });

  it('orders the asked gate first, then free gates, then taken ones, then the memory', () => {
    const remembered = { doorId: 'north', address: SEED_FURLONG, farDoor: 'south' };
    const order = arrivalBerths({
      station: { berths: [gate(1, 'east', true), gate(2, 'west'), gate(3, 'north')] },
      remembered,
      gate: 3,
    }).map((b) => b.gate ?? b.farDoor);
    expect(order).toEqual([3, 2, 1, 'south']);
  });

  it("ranks a taken gate the ship's memory reaches after a free one", () => {
    const remembered = { doorId: 'north', address: SEED_GATE_ROOM, farDoor: 'x' };
    const order = arrivalBerths({
      station: {
        berths: [],
        unaddressed: [
          { roomId: 'high-gates', farDoor: 'east', gate: 1, occupied: true },
          { roomId: 'high-gates', farDoor: 'west', gate: 2 },
        ],
      },
      remembered,
    }).map((b) => b.gate ?? b.farDoor);
    expect(order.slice(0, 2)).toEqual([2, 1]);
  });

  it("puts the gates the ship's memory reaches back in gate order among the station's own", () => {
    const remembered = { doorId: 'north', address: SEED_GATE_ROOM, farDoor: 'x' };
    const order = arrivalBerths({
      station: {
        berths: [{ address: 'ssf://room#room=high-annex', farDoor: 'south', gate: 5 }],
        unaddressed: [
          { roomId: 'high-gates', farDoor: 'east', gate: 1 },
          { roomId: 'high-gates', farDoor: 'west', gate: 2 },
        ],
      },
      remembered,
    }).map((b) => b.gate ?? b.farDoor);
    expect(order.slice(0, 3)).toEqual([1, 2, 5]);
  });

  it('keeps the old single-berth rules when a station lists no gates', () => {
    const remembered = { doorId: 'north', address: SEED_HIGH, farDoor: 'east' };
    expect(arrivalBerths({ station: { berth: { address: SEED_HIGH } }, remembered })).toEqual([remembered]);
    expect(arrivalBerths({ station: {}, remembered: null })).toEqual([]);
  });

  describe('docking', () => {
    beforeEach(() => {
      const doc = new Y.Doc();
      bindShipDoc(doc);
      bindDoorsDoc(doc);
    });
    afterEach(() => setStationDirectory(null));

    /** A docking system whose far berths refuse the doors in `taken`. */
    const gatedDocking = (taken: string[]) => {
      const base = fakeDocking(['north']);
      const tried: string[] = [];
      return {
        ...base,
        tried,
        dock: async (doorId: string) => {
          const st = classifyDockPort(readDoor(doorId));
          const far = st.kind === 'undocked' ? st.memory.farDoor ?? '' : '';
          tried.push(far);
          if (taken.includes(far)) return false;
          base.dock(doorId);
          return true;
        },
      };
    };

    function arriveAtGates(berths: StationDestination['berths']): void {
      setStationDirectory({ stations: () => [DEFAULT_STATIONS[0], { ...DEFAULT_STATIONS[1], berths }] });
      writeDoorTombstone('north', SEED_FURLONG, { farDoor: 'south', undockedAt: 2000 });
      fly('furlong-station', 'high-orbit');
    }

    const settled = () => {
      let resolve!: (o: ArrivalOutcome) => void;
      const promise = new Promise<ArrivalOutcome>((r) => { resolve = r; });
      return { promise, onSettled: resolve };
    };

    it('docks at the first gate and says which', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west')]);
      const docking = gatedDocking([]);
      const s = settled();
      expect(completeArrival(docking, { onSettled: s.onSettled })).toEqual({ kind: 'docking', stationName: 'High Orbit', gate: 1 });
      expect(await s.promise).toEqual({ kind: 'docked', stationName: 'High Orbit', gate: 1 });
      expect(docking.tried).toEqual(['east']);
    });

    it('moves on to the next gate when one is taken', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west'), gate(3, 'north')]);
      const docking = gatedDocking(['east', 'west']);
      const s = settled();
      completeArrival(docking, { onSettled: s.onSettled });
      expect(await s.promise).toEqual({ kind: 'docked', stationName: 'High Orbit', gate: 3 });
      expect(docking.tried).toEqual(['east', 'west', 'north']);
      const north = classifyDockPort(readDoor('north'));
      expect(north.kind === 'docked' && north.record.farDoor).toBe('north');
    });

    it('says which gate each retry docks at, before it docks there', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west'), gate(3, 'north')]);
      const docking = gatedDocking(['east', 'west']);
      const s = settled();
      const progress: ArrivalOutcome[] = [];
      const tried: string[][] = [];
      completeArrival(docking, {
        onSettled: s.onSettled,
        onProgress: (o) => { progress.push(o); tried.push([...docking.tried]); },
      });
      expect(await s.promise).toEqual({ kind: 'docked', stationName: 'High Orbit', gate: 3 });
      expect(progress).toEqual([
        { kind: 'docking', stationName: 'High Orbit', gate: 2 },
        { kind: 'docking', stationName: 'High Orbit', gate: 3 },
      ]);
      // Each note comes before that gate's DOCK.
      expect(tried).toEqual([['east'], ['east', 'west']]);
    });

    it('tries the gate it was asked for first', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west')]);
      const docking = gatedDocking([]);
      const s = settled();
      completeArrival(docking, { gate: 2, onSettled: s.onSettled });
      expect(await s.promise).toMatchObject({ kind: 'docked', gate: 2 });
    });

    it('reports the gate another commander docked the ship at meanwhile', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west')]);
      const base = fakeDocking(['north']);
      const docking = {
        ...base,
        // Gate 1 refuses, and while it does another commander docks at gate 2.
        dock: async (doorId: string) => {
          writeDoorTombstone(doorId, SEED_GATE_ROOM, { farDoor: 'west', undockedAt: 3000 });
          base.dock(doorId);
          return false;
        },
      };
      const s = settled();
      completeArrival(docking, { onSettled: s.onSettled });
      expect(await s.promise).toEqual({ kind: 'docked', stationName: 'High Orbit', gate: 2 });
    });

    it('stops trying gates once the player has left the ship\'s room', async () => {
      let room = 'ship-room';
      setStationRoomSource(() => room);
      arriveAtGates([gate(1, 'east'), gate(2, 'west')]);
      const base = gatedDocking(['east', 'west']);
      const docking = { ...base, dock: async (doorId: string) => { room = 'another-room'; return base.dock(doorId); } };
      let heard: ArrivalOutcome | null = null;
      completeArrival(docking, { onSettled: (o) => { heard = o; } });
      await new Promise((r) => setTimeout(r, 0));
      setStationRoomSource(() => '');
      expect(base.tried).toEqual(['east']);
      expect(heard).toBeNull();
    });

    it('stops trying gates once the ship has left again', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west')]);
      const base = gatedDocking(['east', 'west']);
      // DEPART again while gate 1 is still answering.
      const docking = {
        ...base,
        dock: async (doorId: string) => {
          writeFlightRecord({ status: 'in-flight', locationId: 'high-orbit', destinationId: 'furlong-station', departedAt: 1, etaAt: 2 });
          return base.dock(doorId);
        },
      };
      let heard: ArrivalOutcome | null = null;
      completeArrival(docking, { onSettled: (o) => { heard = o; } });
      await new Promise((r) => setTimeout(r, 0));
      expect(base.tried).toEqual(['east']);
      expect(heard).toBeNull();
      expect(readFlightRecord().status).toBe('in-flight');
    });

    it('reports a dock another commander made while the last gate refused', async () => {
      arriveAtGates([gate(1, 'east')]);
      const base = fakeDocking(['north']);
      const docking = {
        ...base,
        dock: async (doorId: string) => {
          writeDoorTombstone(doorId, SEED_GATE_ROOM, { farDoor: 'east', undockedAt: 3000 });
          base.dock(doorId);
          return false;
        },
      };
      const s = settled();
      completeArrival(docking, { onSettled: s.onSettled });
      expect(await s.promise).toEqual({ kind: 'docked', stationName: 'High Orbit', gate: 1 });
    });

    it('says nothing when the player left the ship\'s room during the last gate\'s answer', async () => {
      let room = 'ship-room';
      setStationRoomSource(() => room);
      arriveAtGates([gate(1, 'east')]);
      const base = gatedDocking(['east']);
      const docking = { ...base, dock: async (doorId: string) => { room = 'another-room'; return base.dock(doorId); } };
      let heard: ArrivalOutcome | null = null;
      completeArrival(docking, { onSettled: (o) => { heard = o; } });
      await new Promise((r) => setTimeout(r, 0));
      setStationRoomSource(() => '');
      expect(heard).toBeNull();
    });

    it('says so when every gate refuses, and leaves the ship arrived undocked', async () => {
      arriveAtGates([gate(1, 'east'), gate(2, 'west')]);
      const docking = gatedDocking(['east', 'west']);
      const s = settled();
      completeArrival(docking, { onSettled: s.onSettled });
      expect(await s.promise).toEqual({ kind: 'none', stationName: 'High Orbit', reason: 'berths-taken' });
      expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'high-orbit' });
      expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    });
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

  it('says nothing once the ship has left again before the berth answers', async () => {
    let answer: (ok: boolean) => void = () => {};
    const docking = { ...fakeDocking(['north']), dock: () => new Promise<boolean>((r) => { answer = r; }) };
    fly('high-orbit', 'furlong-station');
    const heard: ArrivalOutcome[] = [];
    expect(completeArrival(docking, { onSettled: (o) => heard.push(o) })?.kind).toBe('docking');
    // DEPART again while the berth is still answering: the late refusal is
    // the last station's, never the note for this flight.
    writeFlightRecord({ status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit', departedAt: 1, etaAt: 2 });
    answer(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(heard).toEqual([]);
  });

  it('refused, when the berth is taken — not a green "docking" note left standing', async () => {
    expect(await arrive(false)).toEqual({ kind: 'none', stationName: 'Furlong Station', reason: 'berths-taken' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'furlong-station' });
    // At rest beside Furlong, held by no dock (the port never docked): there
    // it stays.
    expect(readRestPlace()).toEqual({ at: placeOfStation('furlong-station'), since: expect.any(Number) });
    expect(shipPlaceId(readFlightRecord())).toBe('furlong-station');
  });

  // 🚏 A5: docking.ts redockPortAnswer says why, and the helm says so too.
  const answer = (a: DockAnswer) => {
    const docking = { ...fakeDocking(['north']), dock: async () => a };
    fly('high-orbit', 'furlong-station');
    return new Promise<ArrivalOutcome>((resolve) => { completeArrival(docking, { onSettled: resolve }); });
  };

  it('occupied, unreachable or gone, when the berth said which', async () => {
    expect(await answer({ ok: true, dockedAt: 5 })).toEqual({ kind: 'docked', stationName: 'Furlong Station' });
    expect(await answer({ ok: false, reason: 'occupied' })).toMatchObject({ kind: 'none', reason: 'occupied' });
    expect(await answer({ ok: false, reason: 'not-allowed', gateAccess: 'closed' })).toMatchObject({ reason: 'occupied' });
    expect(await answer({ ok: false, reason: 'unreachable' })).toMatchObject({ reason: 'unreachable' });
    expect(await answer({ ok: false, reason: 'gone' })).toMatchObject({ reason: 'berth-gone' });
  });

  it('refused, once the far room knew the station had gone: said as gone, the ship left where it arrived', async () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const then = placeOfStation('furlong-station');
    // Furlong's berth is its welcome room, and the port's tombstone names
    // another pass to it: the arrival re-points it, under a stamp after the
    // ship came to rest (which, still named by the rest, reads as Furlong
    // letting go of it where the ship arrived).
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    setStationDirectory({ stations: () => [{ ...DEFAULT_STATIONS[0], berth: { address: seed, farDoor: 'south' } }, DEFAULT_STATIONS[1]] });
    writeDoorTombstone('north', `ssf://room?x=1#room=${home.welcomeRoomId}`, { farDoor: 'south', undockedAt: 2000 });
    const docking = {
      ...fakeDocking(['north']),
      // The far lookup learns Furlong left for Aris since the list here
      // heard (redockPort's berthStillThere), and the DOCK is taken back.
      dock: async () => {
        setStationMoveResolver((st) => (st.id === 'furlong-station' ? {
          stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
          toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 50_000, arriveAt: now - 10_000,
          mode: 'thrusters', bookedAt: now - 55_000, fuel: 1, fuelDrawn: 0,
        } : null));
        return false;
      },
    };
    fly('high-orbit', 'furlong-station');
    try {
      const outcome = await new Promise<ArrivalOutcome>((resolve) => {
        expect(completeArrival(docking, { onSettled: resolve })?.kind).toBe('docking');
      });
      expect(readDoor('north')).toMatchObject({ paired: false, retiredAddress: seed });
      expect(outcome).toEqual({ kind: 'none', stationName: 'Furlong Station', reason: 'in-transit' });
      // Held by no dock: where it arrived, not carried to Aris.
      expect(readRestPlace()).toEqual({ at: then, since: expect.any(Number) });
      expect(shipPlaceId(readFlightRecord())).toBe(then);
    } finally {
      setStationMoveResolver(null);
    }
  });

  it('left where it arrived while the DOCK still waits, through the rest upkeep, once the far room told of a move', async () => {
    const now = Date.now();
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const then = placeOfStation('furlong-station');
    const seed = `ssf://room#room=${home.welcomeRoomId}`;
    setStationDirectory({ stations: () => [{ ...DEFAULT_STATIONS[0], berth: { address: seed, farDoor: 'south' } }, DEFAULT_STATIONS[1]] });
    writeDoorTombstone('north', `ssf://room?x=1#room=${home.welcomeRoomId}`, { farDoor: 'south', undockedAt: 2000 });
    let answer: (ok: boolean) => void = () => {};
    const docking = {
      ...fakeDocking(['north']),
      // The far lookup learns Furlong had already gone to Aris, and the
      // answer waits on the far write's ack and settle.
      dock: () => {
        setStationMoveResolver((st) => (st.id === 'furlong-station' ? {
          stationId: 'furlong-station', welcomeRoomId: home.welcomeRoomId, fromPlanetId: home.planetId, fromSlot: home.orbitSlot,
          toPlanetId: 'planet-aris', toSlot: 0, departAt: now - 50_000, arriveAt: now - 10_000,
          mode: 'thrusters', bookedAt: now - 55_000, fuel: 1, fuelDrawn: 0,
        } : null));
        return new Promise<boolean>((r) => { answer = r; });
      },
    };
    fly('high-orbit', 'furlong-station');
    try {
      const heard: ArrivalOutcome[] = [];
      expect(completeArrival(docking, { onSettled: (o) => heard.push(o) })?.kind).toBe('docking');
      // The re-pointed port, named by the rest, reads as a release where the
      // ship arrived: never as one of Furlong at Aris, while the DOCK waits
      // or once the flight watch's upkeep (main.ts, each second) has kept it.
      expect(shipPlaceId(readFlightRecord())).toBe(then);
      keepRestPlace('ship-room');
      expect(readRestPlace()?.at).toBe(then);
      expect(shipPlaceId(readFlightRecord())).toBe(then);
      answer(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(heard).toEqual([{ kind: 'none', stationName: 'Furlong Station', reason: 'in-transit' }]);
      expect(readRestPlace()?.at).toBe(then);
      expect(readRestPlace()?.docks).toBeUndefined();
      expect(shipPlaceId(readFlightRecord())).toBe(then);
    } finally {
      setStationMoveResolver(null);
    }
  });
});
