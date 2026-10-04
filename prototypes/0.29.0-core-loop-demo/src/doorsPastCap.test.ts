// doorsDoc.readAllDoorsWithPhysical: each physical door's own record read
// past the cap, then the rest of the capped snapshot, so a peer's flood never
// hides one from DEPART's cast-off, nor pushes one past the atlas harvest's
// door bound. doorsDoc.readPhysicalDoors: only the room's own doors,
// each read past the cap, for the checks that must see every real door and
// nothing else (DEPART's gate, where a ship is, whether a module is bolted
// into a station).

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindDoorLayoutDoc, seedDoorLayoutEmpty, seedDoorLayoutSingle } from './doorLayoutDoc';
import {
  bindDoorsDoc, buildDoorPairing, readAllDoors, readAllDoorsWithPhysical, readPhysicalDoors, writeDoorPairing,
  writeDoorRecordTo,
} from './doorsDoc';
import type { DoorRecord } from './doorsDoc';
import { harvestIntoAtlas, readAtlas } from './stationAtlas';
import { isBoltedIntoStation, planTrim } from './stationKeeping';
import { currentStation, registerStation, setStationRoomSource, stationForRoom } from './stations';

/** vitest runs in node here, so the atlas's localStorage needs a shim. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const STATION_CORE = 'ssf://room#room=station-core';
const JUNK = 'ssf://room#room=junk';

let doc: Y.Doc;
/** A peer's flood: 64 valid records (the snapshot's cap), written first. */
function flood(): void {
  for (let i = 0; i < 64; i++) writeDoorRecordTo(doc, `d:flood-${i}`, buildDoorPairing(JUNK, { transient: true }));
}

beforeEach(() => {
  store.clear();
  doc = new Y.Doc();
  bindDoorsDoc(doc);
  bindDoorLayoutDoc(doc); // unseeded: the four default doors
});

describe("the room's door records past the read cap", () => {
  it("keeps a default door's record that a flood hides from the snapshot", () => {
    flood();
    writeDoorPairing('north', STATION_CORE);
    expect(readAllDoors().has('north')).toBe(false);
    expect(readAllDoorsWithPhysical().get('north')?.paired).toBe(true);
  });

  it("keeps a placed door's record too, beside every record the snapshot keeps", () => {
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    flood();
    writeDoorPairing('d:gangway', STATION_CORE);
    const doors = readAllDoorsWithPhysical();
    expect(doors.get('d:gangway')?.paired).toBe(true);
    expect(doors.has('d:flood-0')).toBe(true);
    expect(doors.size).toBe(65);
  });

  it("lists the room's own doors first, ahead of a flood written before them", () => {
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    flood();
    writeDoorPairing('d:gangway', STATION_CORE);
    const ids = [...readAllDoorsWithPhysical().keys()];
    expect(ids[0]).toBe('d:gangway');
    expect(ids.length).toBe(65);
  });

  it('adds no default door to a room whose owner removed every door', () => {
    // The authoritative-empty marker: a doorless room, not one from before
    // the layout store, so a record on a cardinal id is no real door's.
    seedDoorLayoutEmpty();
    flood();
    writeDoorPairing('north', STATION_CORE);
    expect(readAllDoorsWithPhysical().has('north')).toBe(false);
  });
});

describe("the room's own doors", () => {
  it('reads each one past the cap, and nothing a door the room lacks holds', () => {
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    flood();
    writeDoorPairing('d:gangway', STATION_CORE);
    writeDoorPairing('d:ghost', STATION_CORE);
    const doors = readPhysicalDoors();
    expect(doors.get('d:gangway')?.paired).toBe(true);
    expect([...doors.keys()]).toEqual(['d:gangway']);
  });

  it('are the four defaults in a room from before the layout store, and none in a doorless one', () => {
    writeDoorPairing('north', STATION_CORE);
    writeDoorPairing('d:ghost', STATION_CORE);
    expect([...readPhysicalDoors().keys()]).toEqual(['north']);
    seedDoorLayoutEmpty();
    expect(readPhysicalDoors().size).toBe(0);
  });
});

describe('a module bolted into a station, its doors map flooded', () => {
  it("is still bolted over the room's own doors, where the snapshot misses its gangway", () => {
    // What the planet summary asks before it publishes the room as a ship
    // (main.ts planetShipStatus and notShipRoom).
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    flood();
    writeDoorPairing('d:gangway', STATION_CORE);
    expect(isBoltedIntoStation(readAllDoors(), 'room-module', {})).toBe(false);
    expect(isBoltedIntoStation(readPhysicalDoors(), 'room-module', {})).toBe(true);
  });
});

describe('the atlas harvest, its doors map flooded', () => {
  /** What main.ts harvestStationAtlas files for the room it stands in: each
   *  paired record that names a room, in the order the doors read. */
  const harvest = (records: Map<string, DoorRecord>): void => harvestIntoAtlas({
    roomId: 'module',
    name: 'MODULE',
    doors: [...records].flatMap(([doorId, r]) => (r.paired && r.connectedRoomAddress
      ? [{ doorId, targetSeed: r.connectedRoomAddress, farDoor: r.farDoor, transient: r.transient === true }]
      : [])),
  });

  it("keeps a module's gangway into its station, so the module flies with that station", () => {
    // A saved station whose core this install knew from before the gangway:
    // the module's own harvest is the only record of the join.
    harvestIntoAtlas({ roomId: 'station-core', name: 'CORE', doors: [] });
    registerStation({ id: 'core', name: 'CORE', planetId: 'planet-aris', orbitSlot: 3, welcomeRoomId: 'station-core' });
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    flood();
    writeDoorPairing('d:gangway', STATION_CORE, { farDoor: 'south' });
    // The capped snapshot alone misses the gangway: the module reads as a
    // station of its own, and its helm would trim that one's orbit.
    harvest(readAllDoors());
    expect(stationForRoom('module')?.id).not.toBe('core');
    harvest(readAllDoorsWithPhysical());
    expect(Object.keys(readAtlas().module.doors)).toContain('d:gangway');
    // Standing in the module, the station is the core's, and the helm's burn
    // trims the core's orbit.
    setStationRoomSource(() => 'module');
    try {
      expect(currentStation()?.id).toBe('core');
      const plan = planTrim({
        bolted: true, station: currentStation(), trim: null, commander: true, engines: 1, fuel: 10, now: Date.now(),
      }, 'raise');
      expect(plan.ok && [plan.burn.planetId, plan.burn.slot]).toEqual(['planet-aris', 3]);
    } finally {
      setStationRoomSource(() => '');
    }
  });
});
