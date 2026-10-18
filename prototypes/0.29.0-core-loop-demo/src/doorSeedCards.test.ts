/**
 * 🔑 #231 P6b, #272 review round 12: a door's address is a seed link, and a
 * pass to a private room carries its members' node cards. The doors doc is
 * read by everyone in the room, so an address enters it and leaves it with
 * the route alone — a record an older client wrote with the cards in included.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindDoorsDoc, buildDoorPairing, buildDoorTombstone, readAllDoors, readAllDoorsFrom, readDoorFrom, writeDoorPairing,
} from './doorsDoc';
import type { DoorRecord } from './doorsDoc';
import { roomIdFromSeed } from './stationAtlas';

const card = (nodeId: string) => ({ nodeId, ck: 'Y2s=', kxPk: 'ab', issuedAt: 100, sig: 'ff' });
const seedFor = (roomId: string, hints: unknown[]) => btoa(JSON.stringify({
  v: 2, roomId, roomKeyB64: 'a2V5', wtUrl: '', certHashesB64: ['c'], memberHints: hints, issuedAt: 5,
}));
const route = [{ irohNodeId: 'host', irohRelayUrls: ['https://relay'] }, { irohNodeId: 'bare' }];
const dock = seedFor('module-dock', [{ irohNodeId: 'host', irohRelayUrls: ['https://relay'], nodeCard: card('host') }, { irohNodeId: 'bare' }]);
const hintsOf = (address: string) => JSON.parse(atob(address)).memberHints;
const addressOf = (r: DoorRecord | undefined): string => (r ? (r.paired ? r.connectedRoomAddress : r.retiredAddress) : '');

describe('door addresses carry routes, never node cards', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = new Y.Doc();
    bindDoorsDoc(doc);
  });

  it('strips the cards from a pairing and a tombstone as they are built, keeping the route and the room', () => {
    const pairing = buildDoorPairing(dock, { transient: true });
    expect(hintsOf(pairing.connectedRoomAddress)).toEqual(route);
    expect(roomIdFromSeed(pairing.connectedRoomAddress)).toBe('module-dock');
    expect(JSON.parse(atob(pairing.connectedRoomAddress)).roomKeyB64).toBe('a2V5');
    expect(pairing.transient).toBe(true);
    const stone = buildDoorTombstone(dock, { undockedAt: 7 });
    expect(hintsOf(stone.retiredAddress)).toEqual(route);
    expect(stone.dock).toEqual({ undockedAt: 7 });
    // A cardless address is the record's, byte for byte.
    const plain = seedFor('module-plain', route);
    expect(buildDoorPairing(plain).connectedRoomAddress).toBe(plain);
    expect(buildDoorTombstone('ssf://room#room=module-old').retiredAddress).toBe('ssf://room#room=module-old');
  });

  it('writes a docked pass into the doors doc without its cards, and reads an older record with cards as if without', () => {
    writeDoorPairing('d:bay', dock, { transient: true });
    const raw = doc.getMap('doors').get('d:bay') as { connectedRoomAddress: string };
    expect(hintsOf(raw.connectedRoomAddress)).toEqual(route);
    // An older client wrote the pass as it was: every reader strips it.
    doc.getMap('doors').set('d:old', { paired: true, connectedRoomAddress: dock });
    doc.getMap('doors').set('d:gone', { paired: false, retiredAddress: dock });
    const all = readAllDoors();
    expect(hintsOf(addressOf(all.get('d:old')))).toEqual(route);
    expect(hintsOf(addressOf(all.get('d:gone')))).toEqual(route);
    expect(hintsOf(addressOf(readAllDoorsFrom(doc).get('d:old')))).toEqual(route);
    expect(hintsOf(addressOf(readDoorFrom(doc, 'd:old')))).toEqual(route);
    expect(roomIdFromSeed(addressOf(readDoorFrom(doc, 'd:old')))).toBe('module-dock');
  });
});
