// doorsDoc.readAllDoorsWithPhysical: the capped snapshot, plus each physical
// door's own record read past the cap, so a peer's flood never hides one from
// DEPART's cast-off. doorsDoc.readPhysicalDoors: only the room's own doors,
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
import { isBoltedIntoStation } from './stationKeeping';

const STATION_CORE = 'ssf://room#room=station-core';
const JUNK = 'ssf://room#room=junk';

let doc: Y.Doc;
/** A peer's flood: 64 valid records (the snapshot's cap), written first. */
function flood(): void {
  for (let i = 0; i < 64; i++) writeDoorRecordTo(doc, `d:flood-${i}`, buildDoorPairing(JUNK, { transient: true }));
}

beforeEach(() => {
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
