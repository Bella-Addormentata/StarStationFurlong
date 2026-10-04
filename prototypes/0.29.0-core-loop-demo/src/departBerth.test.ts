// shipArrival.ts tests: which berth DEPART files under the station it leaves
// when the ship is docked at more than one place (setBerthStationResolver).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import { classifyDockPort } from './dockRules';
import { bindDoorsDoc, buildDoorPairing, readDoor, writeDoorPairing } from './doorsDoc';
import {
  berthToRemember,
  castOffForDeparture,
  rememberBerthHere,
  setBerthStationResolver,
  type ArrivalPort,
  type ShipDockingApi,
} from './shipArrival';
import { bindShipDoc, readStationBerth, writeStationBerth } from './shipDoc';

const SEED_FURLONG = 'ssf://room#room=furlong-berth';
const SEED_HIGH = 'ssf://room#room=high-orbit-berth';
const FURLONG_ROOM = 'furlong-berth';
const HIGH_ROOM = 'high-orbit-berth';

/** Each dock's far room is part of one station. */
const stationOfRoom = (room: string) =>
  room === FURLONG_ROOM ? 'furlong-station' : room === HIGH_ROOM ? 'high-orbit' : null;

const dockedTo = (address: string, farDoor: string): ArrivalPort['state'] =>
  classifyDockPort(buildDoorPairing(address, { segments: dockChain(), farDoor, farWall: 'y+', transient: true, dockedAt: 1000 }));

afterEach(() => setBerthStationResolver(null));

describe('the berth DEPART remembers', () => {
  // The port order the docking system lists need not be the order the
  // station here was found in: the first dock may lead somewhere else.
  const ports: ArrivalPort[] = [
    { doorId: 'east', state: dockedTo(SEED_HIGH, 'west') },
    { doorId: 'north', state: dockedTo(SEED_FURLONG, 'south') },
  ];

  it('is the dock into the station being left, never one into another station', () => {
    setBerthStationResolver(stationOfRoom);
    expect(berthToRemember(ports, 'furlong-station')).toEqual({ doorId: 'north', roomId: FURLONG_ROOM, farDoor: 'south', farWall: 'y+' });
    expect(berthToRemember(ports, 'high-orbit')?.doorId).toBe('east');
    // No dock leads into it: nothing there to remember.
    expect(berthToRemember(ports, 'l4-anchorage')).toBeNull();
  });

  it('is none when the station a dock leads into cannot be told', () => {
    // A berth filed under the wrong station would dock the trip back there.
    setBerthStationResolver(() => { throw new Error('no atlas yet'); });
    expect(berthToRemember(ports, 'furlong-station')).toBeNull();
  });

  it('is the first dock where no station is asked, or no resolver is set', () => {
    expect(berthToRemember(ports, 'furlong-station')?.doorId).toBe('east');
    setBerthStationResolver(stationOfRoom);
    expect(berthToRemember(ports)?.doorId).toBe('east');
  });
});

describe('departing while docked at two stations', () => {
  beforeEach(() => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    writeDoorPairing('east', SEED_HIGH, buildDoorPairing(SEED_HIGH, {
      segments: dockChain(), farDoor: 'west', farWall: 'x-', transient: true, dockedAt: 1000,
    }));
    writeDoorPairing('north', SEED_FURLONG, buildDoorPairing(SEED_FURLONG, {
      segments: dockChain(), farDoor: 'south', farWall: 'y+', transient: true, dockedAt: 1000,
    }));
  });

  const docking = (): ShipDockingApi => ({
    ports: () => ['east', 'north'].map((doorId) => ({ doorId, state: classifyDockPort(readDoor(doorId)) })),
    undock: () => {},
    dock: () => {},
  });

  it('files the berth under the station it leaves', () => {
    setBerthStationResolver(stationOfRoom);
    expect(castOffForDeparture('furlong-station', docking())).toBe(true);
    expect(readStationBerth('furlong-station')).toMatchObject({ doorId: 'north', roomId: FURLONG_ROOM, farDoor: 'south' });
  });

  it('keeps what it remembered of a station none of its docks leads into', () => {
    setBerthStationResolver(stationOfRoom);
    writeStationBerth('l4-anchorage', { doorId: 'north', roomId: 'l4-berth' });
    expect(rememberBerthHere('l4-anchorage', docking().ports())).toBe(true);
    expect(readStationBerth('l4-anchorage')).toEqual({ doorId: 'north', roomId: 'l4-berth' });
  });
});
