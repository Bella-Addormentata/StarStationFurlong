// doorsDoc.readAllDoorsWithPhysical: the capped snapshot, plus each physical
// door's own record read past the cap, so a peer's flood never hides one from
// the checks that must see every real door (DEPART's gate, where a ship is).

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindDoorLayoutDoc, seedDoorLayoutEmpty, seedDoorLayoutSingle } from './doorLayoutDoc';
import {
  bindDoorsDoc, buildDoorPairing, readAllDoors, readAllDoorsWithPhysical, writeDoorPairing, writeDoorRecordTo,
} from './doorsDoc';

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
