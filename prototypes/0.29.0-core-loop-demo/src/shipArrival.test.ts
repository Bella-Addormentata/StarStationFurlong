// shipArrival.ts tests: the pure arrival planner, the berth a departure
// remembers, and whole trips — undock, fly, arrive, re-dock — over real Yjs
// ship + doors docs with a stand-in docking system that makes the same
// near-side writes as docking.ts's UNDOCK / DOCK.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  berthToRemember,
  ARRIVAL_GRACE_MS,
  castOffForDeparture,
  resolveRememberedBerth,
  setBerthSeedResolver,
  castOffRefusal,
  rememberBerthHere,
  completeArrival,
  planArrivalDock,
  type ArrivalOutcome,
  shipLocationId,
  type ArrivalPort,
  type ShipDockingApi,
} from './shipArrival';
import {
  bindShipDoc,
  readFlightRecord,
  readStationBerth,
  writeFlightRecord,
  writeStationBerth,
} from './shipDoc';
import { setStationDirectory, DEFAULT_STATIONS, type StationDestination } from './stationDirectory';

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
      remembered: { doorId: 'north', address: SEED_FURLONG },
      ports: [{ doorId: 'north', state: dockedTo(SEED_HIGH) }, { doorId: 'east', state: FREE }],
    });
    expect(plan).toMatchObject({ kind: 'dock', doorId: 'east' });
  });

  it('refuses with no open port, and does nothing when already docked there', () => {
    expect(planArrivalDock({
      station: { berth: { address: SEED_FURLONG } },
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

    fly('high-orbit', 'furlong-station');
    expect(completeArrival(docking)).toEqual({ kind: 'docking', stationName: 'Furlong Station' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'furlong-station' });
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
    // Not re-docked at Furlong's remembered berth.
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    expect(docking.docks).toEqual([]);
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

  it('refused, when the berth is taken — not a green "docking" note left standing', async () => {
    expect(await arrive(false)).toEqual({ kind: 'none', stationName: 'Furlong Station', reason: 'berths-taken' });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'furlong-station' });
  });
});
