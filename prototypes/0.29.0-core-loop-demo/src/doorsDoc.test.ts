/**
 * doorsDoc.ts tests — #67 D3 signed pairing extension.
 *
 * Suites (labeled by the attack they close):
 *  1) OWNER-SIGNED pairings (structural pairings + owner permanent undock
 *     tombstones): round-trip, forgery-refusal, cross-room/cross-door replay,
 *     tampered payload, partial-signature refusal, legacy fallback.
 *  2) GUEST-SIGNED transient berths + detach tombstones: round-trip;
 *     transient-only enforcement (a guest signature over a non-transient
 *     shape refuses); guest-pub embedding (a hostile peer that swaps
 *     guestPub on a captured record cannot re-verify).
 *  3) SEQ + WATERMARK — the pairing analogue of PR #129's revoked-grant
 *     replay defence: detach-then-replay of the paired bytes refuses once
 *     the reader has observed the higher-seq tombstone; a hostile peer
 *     cannot revoke a signed pairing with an UNSIGNED tombstone in signed
 *     binding; a "legacy but with seq" record is refused up front (PR #129
 *     MAJOR pattern).
 *  4) FAIL-LOUD writes: writeDoorPairing / writeDoorTombstone /
 *     detachTransientBerth THROW in signed binding when the injected signer
 *     errors or returns null; the map slot is left untouched.
 *  5) MAP-KEY DISCIPLINE: signature bytes are rebuilt over the map key's
 *     doorId, so an owner-signed pairing copied UNMODIFIED to a foreign
 *     door refuses; unknown door-id shapes are refused.
 *
 * Wired identically to doorPolicy.test.ts: @noble/ed25519 sync mode, hex
 * pub/sig, per-test fresh Y.Doc.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  type DoorPairing,
  type DoorTombstone,
  bindDoorsDoc,
  deleteDoorPairing,
  detachTransientBerth,
  doorPairingGuestSignatureBytes,
  doorPairingSignatureBytes,
  doorTombstoneGuestSignatureBytes,
  doorTombstoneSignatureBytes,
  readAllDoors,
  writeDoorPairing,
  writeDoorTombstone,
} from './doorsDoc';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const seedOwner = new Uint8Array(32).fill(9);
const seedGuest = new Uint8Array(32).fill(3);
const seedOther = new Uint8Array(32).fill(5);
const pub = (seed: Uint8Array): string => bytesToHex(ed.getPublicKey(seed));
const sign = (seed: Uint8Array, bytes: Uint8Array): string => bytesToHex(ed.sign(bytes, seed));
const ownerPub = pub(seedOwner);
const guestPub = pub(seedGuest);
const otherPub = pub(seedOther);

const verifier = (pub: string, bytes: Uint8Array, sig: string): boolean => {
  try {
    return ed.verify(hexToBytes(sig), bytes, hexToBytes(pub));
  } catch {
    return false;
  }
};

const signerFor = (seed: Uint8Array) => (bytes: Uint8Array) => sign(seed, bytes);

const ROOM_A = 'room-alpha';
const ROOM_B = 'room-bravo';

// Cardinal ids the isAcceptableDoorKey guard accepts without needing a
// doorLayout doc bound. Free `d:` ids need only the acceptable-key filter
// (id-shape only, not hasDoorLayout) so we could use them too — cardinals
// keep the tests uncluttered.
const DOOR_NORTH = 'north';
const DOOR_SOUTH = 'south';
const ADDR_ONE = 'seed:one';
const ADDR_TWO = 'seed:two';

let doc: Y.Doc;

/** Bind as OWNER: local player IS the room owner. */
function bindAsOwner(theDoc: Y.Doc, roomId: string): void {
  bindDoorsDoc(theDoc, {
    roomId,
    verifySig: verifier,
    roomOwnerPub: () => ownerPub,
    localPub: () => ownerPub,
    signOwner: signerFor(seedOwner),
    signSelf: signerFor(seedOwner),
  });
}

/** Bind as GUEST: local player IS NOT the room owner (self-signs as guest). */
function bindAsGuest(theDoc: Y.Doc, roomId: string): void {
  bindDoorsDoc(theDoc, {
    roomId,
    verifySig: verifier,
    roomOwnerPub: () => ownerPub,
    localPub: () => guestPub,
    signSelf: signerFor(seedGuest),
  });
}

/** Bind as a READ-ONLY PEER (no localPub / no signer). */
function bindAsPeer(theDoc: Y.Doc, roomId: string): void {
  bindDoorsDoc(theDoc, {
    roomId,
    verifySig: verifier,
    roomOwnerPub: () => ownerPub,
  });
}

/** Bind LEGACY (pre-D3 shape): no verifier, no signer. */
function bindLegacy(theDoc: Y.Doc): void {
  bindDoorsDoc(theDoc);
}

/** Convenience: read the raw map entry for a door (before shape/verify guard). */
function rawEntry(theDoc: Y.Doc, doorId: string): unknown {
  return theDoc.getMap('doors').get(doorId);
}

beforeEach(() => { doc = new Y.Doc(); });

// ============================================================================
// D3 · OWNER-SIGNED PAIRINGS
// ============================================================================

describe('D3 · owner-signed pairings', () => {
  it('round-trips an owner-signed pairing owner→peer', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);

    // Simulate a peer joining the SAME doc: read verifies against the owner's key.
    bindAsPeer(doc, ROOM_A);
    const all = readAllDoors();
    const p = all.get(DOOR_NORTH);
    expect(p?.paired).toBe(true);
    if (!p?.paired) throw new Error('unreachable — narrows p');
    expect(p.connectedRoomAddress).toBe(ADDR_ONE);
    expect(p.ownerPub).toBe(ownerPub);
    expect(typeof p.ownerSig).toBe('string');
    expect(typeof p.seq).toBe('number');
    expect(p.seq).toBeGreaterThanOrEqual(0);
  });

  it('refuses a forgery signed by NOT-the-owner (attack: hostile-peer-mints-pairing)', () => {
    // Hostile peer with a valid Ed25519 key but not the current room owner
    // writes a fresh pairing signed with their own key. Verify-on-read must
    // refuse because signer !== current owner pub.
    const forged: DoorPairing = {
      paired: true,
      connectedRoomAddress: ADDR_ONE,
      seq: 0,
      ownerPub: otherPub,
      ownerSig: sign(seedOther, doorPairingSignatureBytes(ROOM_A, DOOR_NORTH, {
        connectedRoomAddress: ADDR_ONE, seq: 0,
      })),
    };
    doc.getMap('doors').set(DOOR_NORTH, forged);

    bindAsPeer(doc, ROOM_A);
    // Signed forgery is dropped — the door reads as absent (unpaired).
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('refuses a tampered payload whose signature no longer covers it (attack: field-edit)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);

    // Hostile peer edits connectedRoomAddress but keeps the original signature.
    const raw = rawEntry(doc, DOOR_NORTH) as DoorPairing;
    doc.getMap('doors').set(DOOR_NORTH, { ...raw, connectedRoomAddress: ADDR_TWO });

    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('refuses a partial record (sig without pub, or pub without sig)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const raw = rawEntry(doc, DOOR_NORTH) as DoorPairing;

    doc.getMap('doors').set(DOOR_NORTH, { ...raw, ownerSig: undefined });
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);

    doc.getMap('doors').set(DOOR_NORTH, { ...raw, ownerPub: undefined });
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('refuses cross-ROOM replay (attack: signed record lifted between rooms)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const signedForA = rawEntry(doc, DOOR_NORTH);

    // Hostile lifts the record into a fresh room-B doc.
    const docB = new Y.Doc();
    docB.getMap('doors').set(DOOR_NORTH, signedForA);
    bindAsPeer(docB, ROOM_B);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('refuses cross-DOOR replay (attack: signed record lifted between doors)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const signedForNorth = rawEntry(doc, DOOR_NORTH);

    // Copy UNMODIFIED onto the south door — map-key discipline rebuilds the
    // verify bytes over the KEY's doorId (south), so the north signature refuses.
    doc.getMap('doors').set(DOOR_SOUTH, signedForNorth);
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_SOUTH)).toBe(false);
    expect(readAllDoors().get(DOOR_NORTH)?.paired).toBe(true);
  });

  it('accepts a LEGACY (unsigned) pairing — dev-phase fail-safe fallback', () => {
    // Pre-D3 shape written directly to the map.
    doc.getMap('doors').set(DOOR_NORTH, {
      paired: true,
      connectedRoomAddress: ADDR_ONE,
    });
    bindAsPeer(doc, ROOM_A);
    const p = readAllDoors().get(DOOR_NORTH);
    expect(p?.paired).toBe(true);
    if (!p?.paired) throw new Error('unreachable');
    expect(p.connectedRoomAddress).toBe(ADDR_ONE);
    expect(p.ownerSig).toBeUndefined();
  });

  it('a "legacy but with seq" record is refused (attack: watermark inflation via unsigned pairing)', () => {
    // Pre-fix PR #129 pattern for grants: an unsigned record carrying a huge
    // seq would inflate reader watermarks. Legacy pairings MUST have no seq
    // field; a "no sig but seq present" record is refused up front.
    doc.getMap('doors').set(DOOR_NORTH, {
      paired: true,
      connectedRoomAddress: ADDR_ONE,
      seq: Number.MAX_SAFE_INTEGER, // hostile huge seq, no sig
    });
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });
});

// ============================================================================
// D3 · GUEST-SIGNED TRANSIENT BERTHS
// ============================================================================

describe('D3 · guest-signed transient berths', () => {
  it('round-trips a guest-signed transient berth guest→peer', () => {
    bindAsGuest(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true });

    bindAsPeer(doc, ROOM_A);
    const p = readAllDoors().get(DOOR_NORTH);
    expect(p?.paired).toBe(true);
    if (!p?.paired) throw new Error('unreachable');
    expect(p.transient).toBe(true);
    expect(p.guestPub).toBe(guestPub);
    expect(typeof p.guestSig).toBe('string');
    // Guest-signed pairing carries no owner authorship — mutually exclusive.
    expect(p.ownerPub).toBeUndefined();
    expect(p.ownerSig).toBeUndefined();
  });

  it('refuses a guest signature over a NON-transient shape (attack: guest-forges-permanent)', () => {
    // A guest cannot promote their berth into a structural pairing. If a
    // hostile guest signs a non-transient pairing with their own key,
    // verification refuses — guest-signed records MUST carry transient:true.
    const forged: DoorPairing = {
      paired: true,
      connectedRoomAddress: ADDR_ONE,
      seq: 0,
      // NO transient flag — hostile attempt to promote to structural.
      guestPub,
      guestSig: sign(seedGuest, doorPairingGuestSignatureBytes(ROOM_A, DOOR_NORTH, {
        connectedRoomAddress: ADDR_ONE, guestPub, seq: 0,
      })),
    };
    doc.getMap('doors').set(DOOR_NORTH, forged);
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('refuses guestPub swap on a captured record (attack: identity-swap replay)', () => {
    // Hostile peer captures a valid guest-signed berth and tries to substitute
    // their OWN guestPub. guestPub rides INSIDE the signature bytes, so the
    // resulting record no longer verifies against either key.
    bindAsGuest(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true });
    const raw = rawEntry(doc, DOOR_NORTH) as DoorPairing;

    // Swap the guestPub to the "other" identity — sig no longer matches.
    doc.getMap('doors').set(DOOR_NORTH, { ...raw, guestPub: otherPub });
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('refuses a record carrying BOTH owner and guest signatures (attack: dual-authorship)', () => {
    // A record with two authorities on one slot is malformed — the read rule
    // refuses it up front rather than picking one arbitrarily.
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const raw = rawEntry(doc, DOOR_NORTH) as DoorPairing;

    // Hostile adds guest sig fields to an owner-signed record.
    doc.getMap('doors').set(DOOR_NORTH, {
      ...raw,
      transient: true,
      guestPub,
      guestSig: sign(seedGuest, doorPairingGuestSignatureBytes(ROOM_A, DOOR_NORTH, {
        connectedRoomAddress: raw.connectedRoomAddress, guestPub, seq: raw.seq ?? 0, transient: true,
      })),
    });
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });
});

// ============================================================================
// D3 · SEQ + WATERMARK (revoked-berth replay defence)
// ============================================================================

describe('D3 · seq + watermark', () => {
  it('detach-then-replay refuses after the tombstone is observed (attack: paired-bytes replay)', () => {
    // 1. Guest berths (seq 0, transient, guest-signed).
    bindAsGuest(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true });
    const pairingBytes = rawEntry(doc, DOOR_NORTH);

    // 2. Guest detaches — signed tombstone at seq 1.
    detachTransientBerth(DOOR_NORTH);
    const tomb = rawEntry(doc, DOOR_NORTH) as DoorTombstone;
    expect(tomb.paired).toBe(false);
    expect(tomb.guestPub).toBe(guestPub);
    expect(typeof tomb.guestSig).toBe('string');
    expect(tomb.seq).toBe(1);

    // 3. A peer observes the tombstone (watermark advances to (1, tomb)).
    bindAsPeer(doc, ROOM_A);
    let all = readAllDoors();
    let cur = all.get(DOOR_NORTH);
    expect(cur?.paired).toBe(false);

    // 4. Hostile peer replays the ORIGINAL paired bytes (seq 0). Signature
    //    still verifies, but the watermark defeats it — the pairing does not
    //    surface, and the reader still sees the tombstone (or a subsequent
    //    valid record, whichever the map holds).
    doc.getMap('doors').set(DOOR_NORTH, pairingBytes);
    all = readAllDoors();
    cur = all.get(DOOR_NORTH);
    // Either the map slot is the tombstone (last verified rank was tombstone)
    // or nothing surfaces (record refused, no fallback). Never: the replayed
    // pairing surfaces.
    expect(cur?.paired).not.toBe(true);
  });

  it('an UNSIGNED tombstone in signed binding cannot revoke a signed pairing (attack: unsigned-revocation)', () => {
    // Pre-#67-D3 the legacy fallback let any peer plant an unsigned tombstone
    // and blank a signed pairing — same class as PR #129 BLOCKER-1 on grants.
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);

    // Hostile writes an unsigned tombstone with no seq.
    doc.getMap('doors').set(DOOR_NORTH, {
      paired: false,
      retiredAddress: ADDR_ONE,
    });
    bindAsPeer(doc, ROOM_A);
    // Unsigned tombstone is refused in signed binding — nothing surfaces at
    // the slot (the pairing has been CRDT-overwritten by the hostile write,
    // so it is gone from the raw map; the read layer refuses the garbage).
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('write-side seq monotonicity: successive writes strictly increment', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const s0 = (rawEntry(doc, DOOR_NORTH) as DoorPairing).seq;
    writeDoorPairing(DOOR_NORTH, ADDR_TWO);
    const s1 = (rawEntry(doc, DOOR_NORTH) as DoorPairing).seq;
    expect(typeof s0).toBe('number');
    expect(typeof s1).toBe('number');
    expect(s1 as number).toBeGreaterThan(s0 as number);
  });

  it('unsigned tombstone in LEGACY binding is still accepted (pre-D3 posture)', () => {
    // Legacy binding has no signature layer to protect. Unsigned tombstones
    // remain accepted so pre-D3 rooms keep working — mirrors the pre-#67 shape.
    doc.getMap('doors').set(DOOR_NORTH, {
      paired: false,
      retiredAddress: ADDR_ONE,
    });
    bindLegacy(doc);
    const t = readAllDoors().get(DOOR_NORTH);
    expect(t?.paired).toBe(false);
  });
});

// ============================================================================
// D3 · SIGNED TOMBSTONES (owner permanent undock; guest transient detach)
// ============================================================================

describe('D3 · signed tombstones', () => {
  it('owner permanent undock writes a signed tombstone', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    writeDoorTombstone(DOOR_NORTH, ADDR_ONE);

    bindAsPeer(doc, ROOM_A);
    const t = readAllDoors().get(DOOR_NORTH);
    expect(t?.paired).toBe(false);
    if (!t || t.paired) throw new Error('unreachable');
    expect(t.retiredAddress).toBe(ADDR_ONE);
    expect(t.ownerPub).toBe(ownerPub);
    expect(typeof t.ownerSig).toBe('string');
  });

  it('non-owner cannot write an owner tombstone (writeDoorTombstone no-ops)', () => {
    // Owner writes the pairing first.
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const before = rawEntry(doc, DOOR_NORTH) as DoorPairing;

    // Now bind as GUEST and try to writeDoorTombstone — the owner-only guard
    // refuses (returns without writing) rather than planting an unsigned
    // tombstone a peer would refuse but that would still CRDT-clobber.
    bindAsGuest(doc, ROOM_A);
    writeDoorTombstone(DOOR_NORTH, ADDR_ONE);
    const after = rawEntry(doc, DOOR_NORTH) as DoorPairing;
    expect(after).toEqual(before); // unchanged
  });

  it('detachTransientBerth writes a guest-signed tombstone when local is guest', () => {
    bindAsGuest(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true });
    detachTransientBerth(DOOR_NORTH);

    bindAsPeer(doc, ROOM_A);
    const t = readAllDoors().get(DOOR_NORTH);
    expect(t?.paired).toBe(false);
    if (!t || t.paired) throw new Error('unreachable');
    expect(t.guestPub).toBe(guestPub);
    expect(typeof t.guestSig).toBe('string');
    expect(t.retiredAddress).toBe(ADDR_ONE);
  });

  it('detachTransientBerth writes an owner-signed tombstone when local is owner', () => {
    // Owner set up a transient berth at their own door (either they berthed
    // their own ship, or a berth was in-place when they became owner).
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true });

    // Owner casts off — signs the tombstone as OWNER.
    detachTransientBerth(DOOR_NORTH);
    const t = rawEntry(doc, DOOR_NORTH) as DoorTombstone;
    expect(t.paired).toBe(false);
    expect(t.ownerPub).toBe(ownerPub);
    expect(typeof t.ownerSig).toBe('string');
  });

  it('detachTransientBerth is a no-op when the slot has no valid pairing', () => {
    bindAsGuest(doc, ROOM_A);
    // No pairing at the slot.
    detachTransientBerth(DOOR_NORTH);
    expect(rawEntry(doc, DOOR_NORTH)).toBeUndefined();
  });

  it('detachTransientBerth in LEGACY binding does a bare delete', () => {
    // Pre-D3 rooms have no signature layer — the bare-delete posture stays.
    doc.getMap('doors').set(DOOR_NORTH, {
      paired: true,
      connectedRoomAddress: ADDR_ONE,
      transient: true,
    });
    bindLegacy(doc);
    detachTransientBerth(DOOR_NORTH);
    expect(rawEntry(doc, DOOR_NORTH)).toBeUndefined();
  });

  it('cross-room tombstone replay refuses', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    writeDoorTombstone(DOOR_NORTH, ADDR_ONE);
    const signedTomb = rawEntry(doc, DOOR_NORTH);

    const docB = new Y.Doc();
    docB.getMap('doors').set(DOOR_NORTH, signedTomb);
    bindAsPeer(docB, ROOM_B);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });
});

// ============================================================================
// D3 · FAIL-LOUD WRITES (signer failure surfaces)
// ============================================================================

describe('D3 · fail-loud writes', () => {
  it('writeDoorPairing THROWS when the owner signer returns null (signed binding)', () => {
    // Owner-signed path with a broken signer — must throw, not degrade to
    // an unsigned record our own reader would refuse.
    bindDoorsDoc(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => ownerPub,
      signOwner: () => null, // broken
      signSelf: () => null,
    });
    expect(() => writeDoorPairing(DOOR_NORTH, ADDR_ONE)).toThrow(/owner signer failed/);
    // No record was persisted.
    expect(rawEntry(doc, DOOR_NORTH)).toBeUndefined();
  });

  it('writeDoorPairing THROWS when the guest signer returns null (transient path)', () => {
    bindDoorsDoc(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
      signSelf: () => null, // broken
    });
    expect(() => writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true })).toThrow(/guest signer failed/);
    expect(rawEntry(doc, DOOR_NORTH)).toBeUndefined();
  });

  it('writeDoorPairing THROWS when the owner signer THROWS', () => {
    bindDoorsDoc(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => ownerPub,
      signOwner: () => { throw new Error('hsm offline'); },
      signSelf: () => null,
    });
    expect(() => writeDoorPairing(DOOR_NORTH, ADDR_ONE)).toThrow(/owner signer failed/);
    expect(rawEntry(doc, DOOR_NORTH)).toBeUndefined();
  });

  it('writeDoorTombstone THROWS when the owner signer returns null', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    const before = rawEntry(doc, DOOR_NORTH);

    // Re-bind with a broken owner signer.
    bindDoorsDoc(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => ownerPub,
      signOwner: () => null,
      signSelf: () => null,
    });
    expect(() => writeDoorTombstone(DOOR_NORTH, ADDR_ONE)).toThrow(/owner signer failed/);
    // Original signed pairing untouched.
    expect(rawEntry(doc, DOOR_NORTH)).toEqual(before);
  });

  it('detachTransientBerth THROWS when the guest signer returns null', () => {
    bindAsGuest(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { transient: true });
    const before = rawEntry(doc, DOOR_NORTH);

    // Re-bind with a broken guest signer (same local identity).
    bindDoorsDoc(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
      signSelf: () => null,
    });
    expect(() => detachTransientBerth(DOOR_NORTH)).toThrow(/guest signer failed/);
    expect(rawEntry(doc, DOOR_NORTH)).toEqual(before);
  });
});

// ============================================================================
// D3 · MAP-KEY DISCIPLINE (unknown ids, key-shape refusal)
// ============================================================================

describe('D3 · map-key discipline', () => {
  it('bare deleteDoorPairing removes the entry (used by REJECTED-path / orphan reap)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(true);
    deleteDoorPairing(DOOR_NORTH);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('shape guard drops records missing the required fields', () => {
    bindLegacy(doc);
    doc.getMap('doors').set(DOOR_NORTH, { paired: true }); // no address
    doc.getMap('doors').set(DOOR_SOUTH, { paired: 'yes' }); // wrong type
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
    expect(readAllDoors().has(DOOR_SOUTH)).toBe(false);
  });

  it('unknown key-shape id is dropped (bounds the keyspace)', () => {
    bindLegacy(doc);
    // No `d:` prefix, no cardinal, no axis label — refused up front.
    doc.getMap('doors').set('haxxor', { paired: true, connectedRoomAddress: ADDR_ONE });
    expect(readAllDoors().has('haxxor')).toBe(false);
  });

  it('accepts free `d:` door ids', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing('d:custom-42', ADDR_ONE);
    const p = readAllDoors().get('d:custom-42');
    expect(p?.paired).toBe(true);
  });

  it('signature helpers reject unsafe integers via canonicalEncode', () => {
    // Sanity check the encoder-side refusal: a seq at MAX_SAFE_INTEGER+1
    // (double, not a safe integer) throws before the signer is called.
    expect(() => doorPairingSignatureBytes(ROOM_A, DOOR_NORTH, {
      connectedRoomAddress: ADDR_ONE,
      seq: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
    expect(() => doorTombstoneSignatureBytes(ROOM_A, DOOR_NORTH, {
      retiredAddress: ADDR_ONE,
      seq: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
    expect(() => doorPairingGuestSignatureBytes(ROOM_A, DOOR_NORTH, {
      connectedRoomAddress: ADDR_ONE, guestPub, seq: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
    expect(() => doorTombstoneGuestSignatureBytes(ROOM_A, DOOR_NORTH, {
      retiredAddress: ADDR_ONE, guestPub, seq: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
  });
});

// ============================================================================
// D3 · SIGNED SEGMENT GEOMETRY (round-4 audit BLOCKER regression)
// ============================================================================
//
// Attack: prior segmentForSig forwarded raw fractional bendDeg / stretch to
// canonicalEncode, which refuses non-safe-integer numbers. The RING preset
// (`{kind:'flex',bendDeg:22.5,stretch:0}`, x2 with a solid ext bay bank) is
// one of two shipped octagon presets used by every ring-connector chain, so
// every signed RING pairing threw on the sig-bytes build. The write-side
// error was swallowed by the two production call sites (world.ts ACCEPTED
// handshake and main.ts cross-room mirror), leaving the door slot empty and
// no UI feedback — the ship silently never docked as far as any peer could
// tell.
//
// Fix: segmentForSig now runs the sanitize clamps and quantizes to a
// fixed-point integer (deciDeg for flex bend, mm for stretch) so both the
// signer and the verifier round through the same helper for byte-identical
// output; hostile non-finite floats fold to the safe clamp default.

describe('D3 · signed segment geometry (round-4 BLOCKER regression)', () => {
  const RING_SEGMENTS = [
    { kind: 'flex' as const, bendDeg: 22.5, stretch: 0 },
    { kind: 'ext' as const, bays: 4, skin: 'solid' as const },
    { kind: 'flex' as const, bendDeg: 22.5, stretch: 0 },
  ];

  it('writeDoorPairing round-trips the shipped RING preset (attack: fractional-bend-fails-encode)', () => {
    bindAsOwner(doc, ROOM_A);
    // Before the fix: canonicalEncode threw on `bendDeg: 22.5` and the
    // outer catch converted the throw into `writeDoorPairing … refusing to
    // persist an unsigned record`; every RING pairing silently disappeared.
    expect(() =>
      writeDoorPairing(DOOR_NORTH, ADDR_ONE, { segments: RING_SEGMENTS }),
    ).not.toThrow();

    // Peer reads the pairing and sees the RING geometry intact.
    bindAsPeer(doc, ROOM_A);
    const p = readAllDoors().get(DOOR_NORTH);
    expect(p?.paired).toBe(true);
    if (!p?.paired) throw new Error('unreachable');
    expect(p.segments?.length).toBe(3);
    expect(p.segments?.[0]).toMatchObject({ kind: 'flex', bendDeg: 22.5, stretch: 0 });
    expect(p.segments?.[1]).toMatchObject({ kind: 'ext', bays: 4, skin: 'solid' });
    expect(p.segments?.[2]).toMatchObject({ kind: 'flex', bendDeg: 22.5, stretch: 0 });
  });

  it('signed segments verify against the SPOKE preset (integer bend, boundary case)', () => {
    // Second shipped preset — bendDeg 0 (integer), long ext bank. Confirms
    // the fix does not regress the integer-only path.
    bindAsOwner(doc, ROOM_A);
    const spoke = [
      { kind: 'flex' as const, bendDeg: 0, stretch: 0 },
      { kind: 'ext' as const, bays: 11, skin: 'solid' as const },
      { kind: 'flex' as const, bendDeg: 0, stretch: 0 },
    ];
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { segments: spoke });
    bindAsPeer(doc, ROOM_A);
    const p = readAllDoors().get(DOOR_NORTH);
    expect(p?.paired).toBe(true);
  });

  it('signed segments cover meaningful tamper: swapping bendDeg 22.5→30 refuses (attack: chain-tamper)', () => {
    // Segments live inside the sig envelope, so a hostile peer that flips
    // one flex bend to a visibly different angle can no longer keep the
    // owner's signature attached. 30° is 5 detent snaps away from 22.5°,
    // WELL above the 0.1° quantization floor.
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { segments: RING_SEGMENTS });
    const raw = rawEntry(doc, DOOR_NORTH) as DoorPairing;

    const tampered: DoorPairing = {
      ...raw,
      segments: [
        { kind: 'flex', bendDeg: 30, stretch: 0 },
        { kind: 'ext', bays: 4, skin: 'solid' },
        { kind: 'flex', bendDeg: 22.5, stretch: 0 },
      ],
    };
    doc.getMap('doors').set(DOOR_NORTH, tampered);
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('signed segments cover ext bays tamper: 4→8 refuses (attack: chain-length-tamper)', () => {
    // Same as above for the extension arm — swapping bays 4→8 doubles the
    // chain length. Sig envelope covers bays, so the swap fails verify.
    bindAsOwner(doc, ROOM_A);
    writeDoorPairing(DOOR_NORTH, ADDR_ONE, { segments: RING_SEGMENTS });
    const raw = rawEntry(doc, DOOR_NORTH) as DoorPairing;

    const tampered: DoorPairing = {
      ...raw,
      segments: [
        { kind: 'flex', bendDeg: 22.5, stretch: 0 },
        { kind: 'ext', bays: 8, skin: 'solid' },
        { kind: 'flex', bendDeg: 22.5, stretch: 0 },
      ],
    };
    doc.getMap('doors').set(DOOR_NORTH, tampered);
    bindAsPeer(doc, ROOM_A);
    expect(readAllDoors().has(DOOR_NORTH)).toBe(false);
  });

  it('signed segments tolerate hostile NaN / Infinity floats (attack: encoder-crash-DoS)', () => {
    // The canonicalize step folds non-finite numbers to the sanitize
    // default (0), so a hostile writer cannot crash the encoder by seeding
    // its own record with `bendDeg: Infinity`. The written record's segments
    // still ride on the wire (the raw shape is untouched); verify rebuilds
    // bytes over the SAME canonicalized value the sanitizer would render.
    bindAsOwner(doc, ROOM_A);
    // Owner signs a pairing with a NaN segment — must not throw.
    const wild = [
      { kind: 'flex' as const, bendDeg: NaN, stretch: Infinity },
    ];
    expect(() => writeDoorPairing(DOOR_NORTH, ADDR_ONE, { segments: wild })).not.toThrow();
    bindAsPeer(doc, ROOM_A);
    const p = readAllDoors().get(DOOR_NORTH);
    // Reader sanitizes wild floats to safe clamp defaults and the record
    // still verifies (both sides encode the SAME clamped value).
    expect(p?.paired).toBe(true);
    if (!p?.paired) throw new Error('unreachable');
    // Sanitizer output for wild bendDeg / stretch is 0 (see sanitizeDoorGeometry).
    expect(p.segments?.[0]).toMatchObject({ kind: 'flex', bendDeg: 0, stretch: 0 });
  });

  it('signed guest transient with RING segments round-trips (adapter jetbridge path)', () => {
    // docking-adapter berthing (transient path, guest-signed) also carries
    // segments — the jetbridge solver's continuous-bend chain. Same
    // signed-envelope regression as the owner-signed pairing.
    bindAsGuest(doc, ROOM_A);
    const jet = [
      { kind: 'flex' as const, bendDeg: 40.1, stretch: 0.001 },
      { kind: 'ext' as const, bays: 3, skin: 'ribbed' as const, stretch: -0.05 },
      { kind: 'flex' as const, bendDeg: -12.7, stretch: 0.0 },
    ];
    expect(() =>
      writeDoorPairing(DOOR_NORTH, ADDR_ONE, { segments: jet, transient: true }),
    ).not.toThrow();
    bindAsPeer(doc, ROOM_A);
    const p = readAllDoors().get(DOOR_NORTH);
    expect(p?.paired).toBe(true);
    if (!p?.paired) throw new Error('unreachable');
    expect(p.transient).toBe(true);
    expect(p.segments?.length).toBe(3);
  });
});
