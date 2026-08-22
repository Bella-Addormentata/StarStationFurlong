/**
 * doorPolicy.ts tests — #67 D3.
 *
 * Two suites:
 *  1) SIGNED coverage: sign→put→verify round-trip; owner-forgery resistance;
 *     tampered/mis-scoped signatures; cross-room / cross-door replay; the
 *     legacy fallback (no sig fields ⇒ accepted); and the owner-rotation
 *     rule (a stale key's signature stops verifying once the owner rotates).
 *  2) PURE-LOGIC coverage of the D1/D1b gating (independent of the D3 sig
 *     layer): shape guards on hostile map writes, request/grant lifecycle,
 *     unknown door ids, doorId scoping in requests/grants.
 *
 * Uses @noble/ed25519 directly (hex pub/sig) — the same synchronous
 * configuration the browser wires in keypair.ts. doorPolicy.ts is
 * encoding-agnostic (the verifier is injected), so hex works even though the
 * browser uses base64url.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  DEFAULT_DOOR_POLICY,
  type DoorGrantTombstone,
  type DoorPolicyRecord,
  type DoorRightsGrant,
  type DoorRightsRequest,
  bindDoorPolicy,
  doorGrantSignatureBytes,
  doorGrantTombstoneSignatureBytes,
  doorPolicySignatureBytes,
  doorRequestSignatureBytes,
  hasDoorGrant,
  hasDoorRequest,
  isDoorPolicySigned,
  passageLabel,
  readDoorGrants,
  readDoorPolicy,
  readDoorRequests,
  removeDoorGrant,
  removeDoorRequest,
  writeDoorGrant,
  writeDoorPolicy,
  writeDoorRequest,
} from './doorPolicy';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// --- ed25519 helpers (hex form — matches the treasuryDoc.test.ts conventions)
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

// A signer bound to a specific seed — the "owner" seed for owner signing, the
// "guest" seed for self-signed requests, etc. All test wiring is explicit —
// each bind call spells out who the local player is and who the owner is.
const signerFor = (seed: Uint8Array) => (bytes: Uint8Array) => sign(seed, bytes);

const ROOM_A = 'room-alpha';
const ROOM_B = 'room-bravo';

// Every test doorId used below must appear in the DOOR_IDS whitelist inside
// doorPolicy.ts (the four cardinal berths) — free-door ids need hasDoorLayout,
// which pulls in doorLayoutDoc state we do not stage here.
const DOOR_NORTH = 'north';
const DOOR_SOUTH = 'south';

let doc: Y.Doc;
let ownerPubReader: () => string | null;

/**
 * Bind as OWNER: local player IS the room owner, so writes sign with the
 * owner seed. The room owner pub reader returns the owner's pub.
 */
function bindAsOwner(theDoc: Y.Doc, roomId: string): void {
  ownerPubReader = () => ownerPub;
  bindDoorPolicy(theDoc, {
    roomId,
    verifySig: verifier,
    roomOwnerPub: () => ownerPubReader(),
    localPub: () => ownerPub,
    signOwner: signerFor(seedOwner),
    signSelf: signerFor(seedOwner),
  });
}

/**
 * Bind LEGACY: no verifier and no signer wired. Every write lands unsigned
 * and every read accepts unsigned records — the module falls back to today's
 * shape-only behavior, so pre-D3 rooms and unit callers keep working.
 */
function bindLegacy(theDoc: Y.Doc): void {
  bindDoorPolicy(theDoc);
}

beforeEach(() => { doc = new Y.Doc(); });

// ============================================================================
// D3: SIGNED ENFORCEMENT
// ============================================================================

describe('D3 · signed door policy', () => {
  it('round-trips a signed policy owner→peer', () => {
    // Owner writes; a fresh doc bound as a peer reads.
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, {
      passage: 'owner',
      construction: 'request',
      adapter: true,
    });

    // Simulate a peer joining the SAME room doc: same raw map, verifier wired,
    // owner known — the peer's read verifies against the owner's key.
    const peerDoc = doc;
    bindDoorPolicy(peerDoc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,        // peer is a guest
    });

    const read = readDoorPolicy(DOOR_NORTH);
    expect(read.passage).toBe('owner');
    expect(read.construction).toBe('request');
    expect(read.adapter).toBe(true);
    expect(read.ownerPub).toBe(ownerPub);
    expect(typeof read.ownerSig).toBe('string');
    expect(isDoorPolicySigned(DOOR_NORTH)).toBe(true);
  });

  it('rejects a hostile forgery signed by NOT-the-owner', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'public', construction: 'owner' });

    // A hostile peer writes a fresh record signed with their own key, using
    // the correct roomId + doorId — verify-on-read must refuse because the
    // signer is not the current owner.
    const forged: DoorPolicyRecord = {
      passage: 'owner',
      construction: 'owner',
      ownerPub: otherPub,
      ownerSig: sign(seedOther, doorPolicySignatureBytes(ROOM_A, DOOR_NORTH, {
        passage: 'owner', construction: 'owner',
      })),
    };
    doc.getMap('doorPolicy').set(DOOR_NORTH, forged);

    // Peer read (verifier still bound to the owner) — the forgery is dropped
    // and the DEFAULT is surfaced (fail-safe: never falsely-owner-restricted).
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
    });
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
    expect(isDoorPolicySigned(DOOR_NORTH)).toBe(false);
  });

  it('rejects a tampered payload whose signature no longer covers it', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });

    // Hostile peer edits one field but keeps the original signature.
    const raw = doc.getMap('doorPolicy').get(DOOR_NORTH) as DoorPolicyRecord;
    doc.getMap('doorPolicy').set(DOOR_NORTH, { ...raw, passage: 'public' });

    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
    });
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('refuses a partial record (sig without pub, or pub without sig)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    const raw = doc.getMap('doorPolicy').get(DOOR_NORTH) as DoorPolicyRecord;

    doc.getMap('doorPolicy').set(DOOR_NORTH, { ...raw, ownerSig: undefined });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);

    doc.getMap('doorPolicy').set(DOOR_NORTH, { ...raw, ownerPub: undefined });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('refuses cross-ROOM replay (same signed record moved to a different room)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    const signedForA = doc.getMap('doorPolicy').get(DOOR_NORTH) as DoorPolicyRecord;

    // Fresh doc in room B — a hostile lifts the record from A into B.
    const docB = new Y.Doc();
    docB.getMap('doorPolicy').set(DOOR_NORTH, signedForA);
    bindDoorPolicy(docB, {
      roomId: ROOM_B,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub, // same owner, different room
    });
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('refuses cross-DOOR replay (same signed record moved to another door)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    const signedForNorth = doc.getMap('doorPolicy').get(DOOR_NORTH) as DoorPolicyRecord;

    doc.getMap('doorPolicy').set(DOOR_SOUTH, signedForNorth);
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(readDoorPolicy(DOOR_SOUTH)).toEqual(DEFAULT_DOOR_POLICY);
    // The original slot still reads correctly.
    expect(readDoorPolicy(DOOR_NORTH).passage).toBe('owner');
  });

  it('accepts a LEGACY (unsigned) record — dev-phase fail-safe fallback', () => {
    // Simulate a pre-D3 owner writing a plain record.
    doc.getMap('doorPolicy').set(DOOR_NORTH, {
      passage: 'owner',
      construction: 'request',
    });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    const read = readDoorPolicy(DOOR_NORTH);
    expect(read.passage).toBe('owner');
    expect(read.construction).toBe('request');
    expect(read.ownerPub).toBeUndefined();
    expect(read.ownerSig).toBeUndefined();
    expect(isDoorPolicySigned(DOOR_NORTH)).toBe(false);
  });

  it('a signed record signed by the OLD owner stops verifying after rotation', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    expect(readDoorPolicy(DOOR_NORTH).passage).toBe('owner');

    // Owner rotates to a new key (co-host handoff, seed re-imported, etc.).
    ownerPubReader = () => otherPub;
    // Old signature no longer matches the current-owner claim → refused.
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('a signed record verifies with only carried pub when the room owner is unknown', () => {
    // Un-synced view: the players map has not delivered the owner's keyB64
    // yet, so ownerPubReader returns null. Reads still refuse UNVERIFIABLE
    // signatures (bad math), but accept a valid signature on faith of the
    // carried pub — the alternative (blanking signed reads) would flicker
    // every joiner's UI to defaults during T0.
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });

    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => null, // not yet synced
    });
    expect(readDoorPolicy(DOOR_NORTH).passage).toBe('owner');
  });

  it('overwrites are the CRDT-LWW rule — verify-on-read drops sig-bearing garbage', () => {
    // Design honesty test: a hostile peer that can write the doc CAN blank a
    // valid signed policy. If the garbage CLAIMS a signature but does not
    // verify, verify-on-read drops it, so the door FALLS BACK TO DEFAULTS
    // (not to the owner's last policy). D3 does not sign CRDT operations —
    // durable ordering is C6.
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    doc.getMap('doorPolicy').set(DOOR_NORTH, {
      passage: 'owner',
      construction: 'owner',
      ownerPub: ownerPub,
      ownerSig: '00'.repeat(64), // 64 zero bytes — will not verify
    });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('LEGACY-shape garbage overwrite is sanitized to coerced defaults (adapter:false)', () => {
    // Companion to the sig-bearing case: a hostile peer that overwrites with
    // a legacy-shape junk object passes the D3 fallback (no sig fields ⇒
    // legacy honored) but every field is coerced by the enum guards, so the
    // door still surfaces safe defaults. Documents the ONE path where a
    // hostile write is not verify-dropped but is enum-scrubbed instead.
    bindAsOwner(doc, ROOM_A);
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    doc.getMap('doorPolicy').set(DOOR_NORTH, { junk: true, passage: 'ANARCHY' });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    const read = readDoorPolicy(DOOR_NORTH);
    expect(read.passage).toBe('public');         // sanitized off 'ANARCHY'
    expect(read.construction).toBe('owner');
    expect(read.oneWay).toBeUndefined();
    expect(read.adapter).toBe(false);            // shape-path coerces to false
    expect(read.ownerSig).toBeUndefined();
  });

  it('an owner-guest that writes unsigned (no signer wired) is treated as legacy', () => {
    // Owner is bound WITHOUT signOwner (e.g. session that can't sign): the
    // write lands unsigned and is accepted downstream as a legacy record.
    ownerPubReader = () => ownerPub;
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => ownerPub,
      // signOwner deliberately omitted
    });
    writeDoorPolicy(DOOR_NORTH, { passage: 'owner', construction: 'owner' });
    const raw = doc.getMap('doorPolicy').get(DOOR_NORTH) as DoorPolicyRecord;
    expect(raw.ownerSig).toBeUndefined();
    expect(readDoorPolicy(DOOR_NORTH).passage).toBe('owner');
  });
});

describe('D3 · signed door grants', () => {
  it('round-trips owner-signed grants and refuses forgeries', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    expect(readDoorGrants(DOOR_NORTH)).toHaveLength(1);
    const g = readDoorGrants(DOOR_NORTH)[0];
    expect(g.ownerPub).toBe(ownerPub);
    expect(typeof g.ownerSig).toBe('string');

    // A hostile peer mints a grant for OTHER pub, signed by NOT the owner.
    const forged: DoorRightsGrant = {
      doorId: DOOR_NORTH,
      pub: otherPub,
      name: 'Rogue',
      grantedAt: Date.now(),
      ownerPub: otherPub,
      ownerSig: sign(seedOther, doorGrantSignatureBytes(ROOM_A, DOOR_NORTH, {
        pub: otherPub, name: 'Rogue', grantedAt: 0,
      })),
    };
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${otherPub}`, forged);

    // Peer verifies: only the real grant survives.
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
    });
    expect(hasDoorGrant(DOOR_NORTH, otherPub)).toBe(false);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    expect(readDoorGrants(DOOR_NORTH).map((x) => x.pub)).toEqual([guestPub]);
  });

  it('legacy unsigned grant is honored (fail-safe fallback)', () => {
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Legacy', grantedAt: 1,
    });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    expect(readDoorGrants(DOOR_NORTH)).toHaveLength(1);
  });

  it('cross-door replay of a signed grant refuses', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const signedForNorth = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;

    // Lift the record onto the south door under the same guest key.
    doc.getMap('doorGrants').set(`${DOOR_SOUTH}|${guestPub}`, {
      ...signedForNorth,
      doorId: DOOR_SOUTH, // shape claims south — signature still covers north
    });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(false);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
  });

  it('STRONG cross-door replay (v.doorId UNMODIFIED) also refuses via hasDoorGrant', () => {
    // Regression for audit MAJOR #67: a hostile peer lifts an owner-signed
    // grant UNMODIFIED to a foreign map key — v.doorId still reads the
    // ORIGINAL door. Before the fix, hasDoorGrant re-built verify bytes from
    // v.doorId (matching the original sig) and returned true, granting the
    // guest construction rights on a door whose owner never approved them —
    // and readDoorGrants['south'] returned an empty list because its filter
    // ran on v.doorId=='north' first, hiding the lifted record entirely.
    // After the fix, verify bytes are built from the map key's doorId
    // (authoritative) and the map-key discipline guard drops any record
    // whose carried doorId does not match its slot.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const signedForNorth = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;

    // Copy UNMODIFIED: v.doorId is left as 'north' at map key 'south|<pub>'.
    doc.getMap('doorGrants').set(`${DOOR_SOUTH}|${guestPub}`, signedForNorth);

    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    // The construction gate in docking.ts:canConstruct reads through this
    // function — a true here would grant rights on the wrong door.
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(false);
    // The original slot still verifies.
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    // readDoorGrants must not surface the lifted copy either — even though
    // v.doorId claims 'north', its map key is 'south' and the discipline
    // guard drops the mismatched slot. So the 'north' list still has one
    // legitimate entry (the original) and NOT a duplicate (audit NOTE #67).
    expect(readDoorGrants(DOOR_NORTH).map((x) => x.pub)).toEqual([guestPub]);
    expect(readDoorGrants(DOOR_NORTH)).toHaveLength(1);
    expect(readDoorGrants(DOOR_SOUTH)).toHaveLength(0);
  });

  it('STRONG cross-pub replay (lift a signed grant to a different pub slot) refuses', () => {
    // Companion to the cross-door case: the same lift attack in the pub
    // dimension. A hostile peer copies Sam's owner-signed grant UNMODIFIED
    // from `north|<samPub>` to `north|<bobPub>`. The v.pub still reads Sam.
    // Before the fix, hasDoorGrant('north', bobPub) fetched the record at
    // Bob's slot, ran only isGrantShape and isValidSignedGrant, and returned
    // true — granting Bob rights on Sam's approval. After the fix, the
    // map-key discipline guard (v.pub !== keyPub) drops the mismatched slot.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const signedForSam = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;

    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${otherPub}`, signedForSam);

    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorGrant(DOOR_NORTH, otherPub)).toBe(false);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    // The list must not include the lifted (mismatched-slot) copy either.
    expect(readDoorGrants(DOOR_NORTH).map((x) => x.pub)).toEqual([guestPub]);
  });

  it('legacy unsigned grant lifted to a foreign key is refused (map-key discipline)', () => {
    // The MAJOR fix also hardens the legacy fallback: a hostile peer that
    // planted a legacy record for Sam on door north cannot lift it to door
    // south's slot and expect the shape-only fallback to honor it.
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Legacy-Sam', grantedAt: 1,
    });
    // Copy UNMODIFIED to the south slot.
    const rec = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);
    doc.getMap('doorGrants').set(`${DOOR_SOUTH}|${guestPub}`, rec);
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(false);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
  });

  it('cross-room replay of a signed grant refuses', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const lifted = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);

    const docB = new Y.Doc();
    docB.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, lifted);
    bindDoorPolicy(docB, {
      roomId: ROOM_B,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it('writeDoorGrant clears the matching request atomically', () => {
    bindAsOwner(doc, ROOM_A);
    // Simulate a guest having filed a request (any writer path).
    doc.getMap('doorRequests').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, requesterPub: guestPub, requesterName: 'Sam', at: 1,
    });
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(true);

    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(false);
  });
});

describe('D3 · signed door requests (self-signed)', () => {
  it('round-trips a self-signed request', () => {
    // Guest session — signSelf keys the guest seed, localPub is the guest.
    ownerPubReader = () => ownerPub;
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPubReader(),
      localPub: () => guestPub,
      signSelf: signerFor(seedGuest),
    });
    writeDoorRequest(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(true);
    const req = doc.getMap('doorRequests').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsRequest;
    expect(typeof req.requesterSig).toBe('string');
  });

  it('refuses a hostile IMPERSONATION request (someone else claims my pub)', () => {
    // The hostile record CLAIMS guestPub but is signed by other's key. Even
    // though the request shape checks out, the signature does not verify
    // against guestPub — the request must be dropped so the owner's UI never
    // sees a fake plea attributed to Sam.
    const forged: DoorRightsRequest = {
      doorId: DOOR_NORTH,
      requesterPub: guestPub,
      requesterName: 'Fake-Sam',
      at: Date.now(),
      requesterSig: sign(seedOther, doorRequestSignatureBytes(ROOM_A, DOOR_NORTH, {
        requesterPub: guestPub, requesterName: 'Fake-Sam', at: 0,
      })),
    };
    doc.getMap('doorRequests').set(`${DOOR_NORTH}|${guestPub}`, forged);
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(false);
    expect(readDoorRequests(DOOR_NORTH)).toEqual([]);
  });

  it('a legacy unsigned request is honored (fail-safe fallback)', () => {
    doc.getMap('doorRequests').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, requesterPub: guestPub, requesterName: 'Sam', at: 1,
    });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
    });
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(true);
  });

  it('STRONG cross-door replay of a signed request (v.doorId UNMODIFIED) refuses', () => {
    // Twin of the grant-side regression. A hostile peer lifts a valid
    // self-signed request UNMODIFIED to a foreign door slot. Before the fix
    // hasDoorRequest re-built verify bytes from v.doorId (matching the sig)
    // and returned true, causing the owner's UI to see a plea on a door the
    // requester never asked about. After the fix, verify bytes are built
    // from the map-key doorId and the mismatch guard drops the slot.
    ownerPubReader = () => ownerPub;
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPubReader(),
      localPub: () => guestPub,
      signSelf: signerFor(seedGuest),
    });
    writeDoorRequest(DOOR_NORTH, guestPub, 'Sam');
    const req = doc.getMap('doorRequests').get(`${DOOR_NORTH}|${guestPub}`);
    // Copy UNMODIFIED to south's slot.
    doc.getMap('doorRequests').set(`${DOOR_SOUTH}|${guestPub}`, req);
    expect(hasDoorRequest(DOOR_SOUTH, guestPub)).toBe(false);
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(true);
    // readDoorRequests must not surface the lifted copy on south either.
    expect(readDoorRequests(DOOR_SOUTH)).toEqual([]);
    expect(readDoorRequests(DOOR_NORTH).map((x) => x.doorId)).toEqual([DOOR_NORTH]);
  });

  it('STRONG cross-pub replay of a signed request refuses', () => {
    // A hostile peer copies Sam's signed request UNMODIFIED to Bob's slot
    // (`north|<bobPub>`). Before the fix hasDoorRequest returned true for
    // Bob's slot, letting the owner see a fake plea from Bob (with Sam's
    // signature). After the fix the map-key discipline guard drops it.
    ownerPubReader = () => ownerPub;
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPubReader(),
      localPub: () => guestPub,
      signSelf: signerFor(seedGuest),
    });
    writeDoorRequest(DOOR_NORTH, guestPub, 'Sam');
    const req = doc.getMap('doorRequests').get(`${DOOR_NORTH}|${guestPub}`);
    doc.getMap('doorRequests').set(`${DOOR_NORTH}|${otherPub}`, req);
    expect(hasDoorRequest(DOOR_NORTH, otherPub)).toBe(false);
    expect(hasDoorRequest(DOOR_NORTH, guestPub)).toBe(true);
    // The list surfaces only the legitimate original request.
    expect(readDoorRequests(DOOR_NORTH).map((x) => x.requesterPub)).toEqual([guestPub]);
  });

  it('a guest binding cannot sign a request naming ANOTHER user\'s pub', () => {
    // Even though the local seedGuest COULD produce a signature, doorPolicy
    // only self-signs when localPub === the request's pub — so writing a
    // request for otherPub lands UNSIGNED (still valid as a legacy shape),
    // avoiding a footgun where a joke-request in someone else's name would
    // look like their own signed plea.
    ownerPubReader = () => ownerPub;
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPubReader(),
      localPub: () => guestPub,        // local is Sam
      signSelf: signerFor(seedGuest),
    });
    writeDoorRequest(DOOR_NORTH, otherPub, 'Fake-Bob'); // writing FOR Bob
    const stored = doc.getMap('doorRequests').get(`${DOOR_NORTH}|${otherPub}`) as DoorRightsRequest;
    expect(stored.requesterSig).toBeUndefined();
  });
});

// ============================================================================
// D3.2: REVOKE-REPLAY DEFENCE (monotonic seq + owner-signed tombstones)
// ============================================================================
//
// dorkmo's PR #129 review (2026-08-21T22:37Z) proved that D3's bare
// `grantsMap.delete()` was fail-DANGEROUS: a hostile peer that captured the
// pre-revocation grant bytes could re-set the map key with the owner's still-
// valid signature and hasDoorGrant would return true, restoring privileges the
// owner actively withdrew.
//
// The fix (following sovereign-treasury-serverless-plan.md §5's greatest-
// sequence-wins pattern):
//   1. Grants and tombstones carry a monotonic `seq` inside the SIGNED
//      envelope.
//   2. Revocation writes an OWNER-SIGNED TOMBSTONE record to the SAME
//      `${doorId}|${pub}` slot as the grant it withdraws.
//   3. Read rule: greatest verified (seq, tombstone-tie-break) wins per slot.
//   4. Each reader keeps an IN-MEMORY watermark of the highest verified
//      observation, so a subsequently-replayed lower-seq grant is refused
//      even after a hostile peer overwrote the CRDT slot.
//
// The tests below cover the reviewer's exact repro (now PASSING), the four
// invariants the fix must uphold, and the DOCUMENTED RESIDUAL — a fresh peer
// that never observed the tombstone still accepts a replayed grant, because
// `seq` narrows the replay window but does not close it (that requires signed
// CRDT ops / durability C6, or the chain-anchored log — out of scope for D3).

describe('D3.2 · revoked-grant replay defence', () => {
  it("dorkmo's reproduction — replay of a revoked grant is now REFUSED", () => {
    // Verbatim reproduction from the PR #129 finding (2026-08-21T22:37Z).
    // Before the fix this expect(...toBe(false)) was toBe(true) — the
    // captured pre-revocation bytes verified against the still-valid owner
    // signature and hasDoorGrant restored the withdrawn right.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    // A hostile peer captures the wire bytes of the signed grant.
    const captured = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);

    // Owner revokes.
    removeDoorGrant(DOOR_NORTH, guestPub);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);

    // Hostile peer replays the captured bytes into the same slot.
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, captured);

    // Post-fix: the reader's watermark from the tombstone observation defeats
    // the replayed lower-seq grant.
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it('a revocation writes an owner-signed TOMBSTONE (never a bare delete)', () => {
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    removeDoorGrant(DOOR_NORTH, guestPub);

    // The slot must still exist, holding a signed tombstone record — a bare
    // delete was the pre-fix vulnerable shape (dorkmo's repro).
    const rec = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorGrantTombstone;
    expect(rec).toBeDefined();
    expect(rec.tombstone).toBe(true);
    expect(rec.doorId).toBe(DOOR_NORTH);
    expect(rec.pub).toBe(guestPub);
    expect(typeof rec.seq).toBe('number');
    expect(rec.seq).toBeGreaterThanOrEqual(0);
    expect(rec.ownerPub).toBe(ownerPub);
    expect(typeof rec.ownerSig).toBe('string');
  });

  it("tombstone at seq S defeats a REPLAYED grant at seq S (reviewer's core repro)", () => {
    // A hostile peer with a pristine reader state (no watermark yet) still
    // refuses the replayed grant because the tombstone at the slot outranks
    // it on the tombstone-tie-break rule, and observeGrantSlot picks the
    // tombstone up before the grant is even considered.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const capturedGrant = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;
    removeDoorGrant(DOOR_NORTH, guestPub);
    const tomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorGrantTombstone;

    // Fresh peer session — different room binding wipes the watermark.
    const peerDoc = doc;
    bindDoorPolicy(peerDoc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => otherPub,
    });
    // First read sees the tombstone (currently at the slot).
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);

    // Hostile peer overwrites the tombstone with the captured grant.
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, capturedGrant);

    // The watermark set from the tombstone observation now defeats the
    // replayed grant, whose seq is <= the tombstone's seq (in fact equal-
    // minus-one — writeDoorGrant used seq 0, removeDoorGrant used seq 1).
    expect(tomb.seq).toBeGreaterThan(capturedGrant.seq ?? -1);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it('a HIGHER-SEQ regrant after a tombstone restores rights', () => {
    // The owner may re-grant the same peer's access after a revocation. The
    // regrant must carry a higher seq than the tombstone (writeDoorGrant's
    // nextGrantSeqFor computes it from watermark+observed-seq+1), so it
    // outranks the tombstone.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    removeDoorGrant(DOOR_NORTH, guestPub);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
    const tomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorGrantTombstone;

    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    const grant2 = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;
    expect(grant2.seq).toBeGreaterThan(tomb.seq);

    // And the readDoorGrants list now surfaces the regrant (tombstones never
    // appear in the grant list).
    const grants = readDoorGrants(DOOR_NORTH);
    expect(grants).toHaveLength(1);
    expect(grants[0].pub).toBe(guestPub);
  });

  it("a tombstone does NOT bleed across doors (cross-door non-interference)", () => {
    // Revoke on north — south must remain untouched. A previous bug shape
    // where tombstones keyed by pub alone would collide here.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    writeDoorGrant(DOOR_SOUTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(true);

    removeDoorGrant(DOOR_NORTH, guestPub);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(true);
    // Lifting the north tombstone to the south slot must not defeat the south
    // grant either — the tombstone signature is over north's bytes.
    const northTomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);
    doc.getMap('doorGrants').set(`${DOOR_SOUTH}|${guestPub}`, northTomb);
    // Rebind to purge any watermark from prior south reads.
    bindDoorPolicy(new Y.Doc(), { roomId: ROOM_A });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
    });
    // The lifted tombstone fails cross-door verify. The slot's authoritative
    // record is invalid, so hasDoorGrant returns false — no lingering south
    // grant survives the hostile overwrite (fail-safe, not fail-dangerous).
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(false);
  });

  it("a tombstone does NOT bleed across rooms (cross-room non-interference)", () => {
    // Sign a tombstone in room A, lift it into room B under the same slot.
    // The tombstone's signature bytes carry roomId, so verify refuses in
    // room B — no way for a hostile peer to blank another room's grants.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    removeDoorGrant(DOOR_NORTH, guestPub);
    const liftedTomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);

    // Room B: fresh doc, bind as owner (same owner key across rooms — that
    // is the harder case; a hostile peer that captured the room-A tombstone
    // knows the owner pub matches the room-B owner pub).
    const docB = new Y.Doc();
    bindAsOwner(docB, ROOM_B);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    const bGrant = docB.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;
    expect(typeof bGrant.seq).toBe('number');

    // Hostile peer overwrites room B's slot with room A's tombstone.
    docB.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, liftedTomb);
    // Room-B owner session re-observes. The lifted A tombstone's signature
    // covers ROOM_A bytes and fails verify against ROOM_B — the slot reads
    // as absent (verify-on-read dropped it and the B grant it overwrote was
    // clobbered by CRDT-LWW). Documents the residual: a hostile peer that
    // can WRITE the doc can always overwrite a slot with garbage; verify-
    // on-read then treats the slot as absent. The A tombstone did NOT
    // propagate its authority into room B.
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);

    // A fresh regrant in room B works normally — the lifted A tombstone did
    // not contaminate B's watermark (verify failed, so observeGrantSlot
    // returned null and bumpWatermark never fired for the A tombstone's
    // higher seq). The regrant's seq is one above whatever the reader last
    // verified for this slot, which is the ORIGINAL bGrant.seq (the only
    // record that ever verified in room B).
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const regrantB = docB.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;
    expect(typeof regrantB.seq).toBe('number');
    // Regrant seq must be strictly greater than the original B grant seq
    // (monotonic within room B), AND must not be inflated by the lifted A
    // tombstone's seq (i.e. the A tombstone did not bleed watermark values
    // into room B). The A tombstone in this test was written after only one
    // A grant, so its seq is 1; the regrant should be bGrant.seq + 1 (i.e.
    // 1 for a first-grant/first-regrant scenario), not e.g. 2 or higher.
    expect(regrantB.seq).toBe((bGrant.seq ?? 0) + 1);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
  });

  it("a legacy unsigned grant is OUTRANKED by a subsequent signed tombstone", () => {
    // MIGRATION path (see doorPolicy.ts module header): legacy records read
    // as seq = -1, so any signed tombstone (seq >= 0) defeats them. This
    // keeps pre-D3.2 grants revocable once an owner upgrades.
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Legacy-Sam', grantedAt: 1,
    });
    bindAsOwner(doc, ROOM_A);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);

    removeDoorGrant(DOOR_NORTH, guestPub);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
    const rec = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorGrantTombstone;
    expect(rec.tombstone).toBe(true);
    expect(rec.seq).toBeGreaterThanOrEqual(0);
  });

  it("a signed grant OUTRANKS a hostile downgrade-to-legacy attempt", () => {
    // The MIGRATION rule says legacy (seqless) records are seq = -1 and any
    // seq-carrying record outranks them. So a hostile peer that strips
    // ownerPub/ownerSig/seq to plant a legacy-shape grant AFTER an owner's
    // signed grant lands at the slot cannot succeed — the reader's watermark
    // is at the signed grant's seq (>= 0), and the legacy fallback is seq -1.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const signedGrant = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;
    // Force a read so the watermark bumps to seq 0.
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);

    // Hostile downgrade: overwrite with a legacy-shape record that claims
    // 'Rogue' access — the shape check passes, but the watermark refuses it.
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Rogue', grantedAt: 999,
    });
    // Read still refuses (legacy seq -1 does not outrank the watermarked
    // signed grant at seq 0).
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
    expect(readDoorGrants(DOOR_NORTH)).toEqual([]);
    // Sanity: the record we planted is not a valid seq-carrying record.
    expect(signedGrant.seq).toBeGreaterThanOrEqual(0);
  });

  it("a hostile FAKE-SEQ (higher number, own key) forgery is refused", () => {
    // Forgery resistance: a hostile peer cannot mint a fake regrant with an
    // inflated seq because they cannot sign as the owner. Verify-on-read
    // rejects the sig and the slot reads as absent.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    removeDoorGrant(DOOR_NORTH, guestPub);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
    const tomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorGrantTombstone;

    // Attempt to overrule the tombstone with a "higher seq" grant signed by
    // NOT-the-owner.
    const fakeSeq = tomb.seq + 10;
    const forged: DoorRightsGrant = {
      doorId: DOOR_NORTH,
      pub: guestPub,
      name: 'Rogue',
      grantedAt: Date.now(),
      seq: fakeSeq,
      ownerPub: otherPub,
      ownerSig: sign(seedOther, doorGrantSignatureBytes(ROOM_A, DOOR_NORTH, {
        pub: guestPub, name: 'Rogue', grantedAt: 0, seq: fakeSeq,
      })),
    };
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, forged);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it("hasDoorGrant refuses a grant whose carried seq is negative or non-integer", () => {
    // isValidSignedGrant explicitly refuses non-integer / negative seq BEFORE
    // running verify — the guard trips first, so the ownerSig on these
    // planted records is never inspected. The canonical encoder can't even
    // build bytes for a non-integer seq (safe-integer invariant), so a
    // hostile peer who tried to sign one would fail at the encoder anyway.
    bindAsOwner(doc, ROOM_A);
    // NEGATIVE seq: signed with a real owner sig; the seq guard rejects
    // before verify runs.
    const negative: DoorRightsGrant = {
      doorId: DOOR_NORTH,
      pub: guestPub,
      name: 'Sam',
      grantedAt: 1,
      seq: -5,
      ownerPub: ownerPub,
      ownerSig: sign(seedOwner, doorGrantSignatureBytes(ROOM_A, DOOR_NORTH, {
        pub: guestPub, name: 'Sam', grantedAt: 1, seq: -5,
      })),
    };
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, negative);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);

    // NON-INTEGER seq: signature would be un-encodable, so a hostile peer
    // could only ever plant garbage bytes here. The seq guard still rejects.
    const noninteger: DoorRightsGrant = {
      doorId: DOOR_NORTH,
      pub: guestPub,
      name: 'Sam',
      grantedAt: 1,
      seq: 1.5,
      ownerPub: ownerPub,
      ownerSig: '00'.repeat(64),   // never reached — seq guard trips first
    };
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, noninteger);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it("a tombstone with an INVALID signature is dropped (verify-on-read)", () => {
    // A hostile peer plants a tombstone with a garbage signature — verify
    // fails, so the slot reads as absent (no grant surfaces, but also no
    // watermark bump so a subsequent LEGITIMATE grant works normally).
    bindAsOwner(doc, ROOM_A);
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, {
      tombstone: true,
      doorId: DOOR_NORTH,
      pub: guestPub,
      revokedAt: 1,
      seq: 5,
      ownerPub: ownerPub,
      ownerSig: '00'.repeat(64),   // will not verify
    });
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);

    // A subsequent legitimate grant lands and works (no stale watermark).
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
  });

  it("cross-door tombstone lift refuses (tombstone sig covers doorId)", () => {
    // Sign a tombstone on north, lift UNMODIFIED to south. Its signature
    // covers north's bytes, so verify fails on south — a hostile peer cannot
    // borrow a north tombstone to blank a south grant.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    removeDoorGrant(DOOR_NORTH, guestPub);
    const northTomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);

    // Fresh south grant.
    writeDoorGrant(DOOR_SOUTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(true);
    const southGrant = doc.getMap('doorGrants').get(`${DOOR_SOUTH}|${guestPub}`);

    // Lift north's tombstone into south's slot.
    doc.getMap('doorGrants').set(`${DOOR_SOUTH}|${guestPub}`, northTomb);
    // Rebind to purge watermark for the south slot.
    bindDoorPolicy(new Y.Doc(), { roomId: ROOM_A });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
    });
    // The lifted tombstone fails verify (doorId scope). Slot reads as absent
    // (verify dropped it, and the grant that was here has been overwritten).
    // Sanity: this documents the CRDT-overwrite residual — the honest south
    // grant is gone, but the north tombstone did NOT authoritatively kill
    // the south right; a regrant works.
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(false);
    // Restore the honest south grant — regrant works, no phantom watermark.
    doc.getMap('doorGrants').set(`${DOOR_SOUTH}|${guestPub}`, southGrant);
    expect(hasDoorGrant(DOOR_SOUTH, guestPub)).toBe(true);
  });

  it("cross-pub tombstone lift refuses (tombstone sig covers pub)", () => {
    // Companion to cross-door: a tombstone for Sam does not blank Bob's slot.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    writeDoorGrant(DOOR_NORTH, otherPub, 'Bob');
    removeDoorGrant(DOOR_NORTH, guestPub);
    const samTomb = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);

    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${otherPub}`, samTomb);
    bindDoorPolicy(new Y.Doc(), { roomId: ROOM_A });
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,
    });
    // The lifted tombstone fails verify (map-key discipline: sam's pub does
    // not match the bob slot's key).
    expect(hasDoorGrant(DOOR_NORTH, otherPub)).toBe(false);
  });

  it("DOCUMENTED RESIDUAL — fresh peer that never saw the tombstone accepts replay", () => {
    // HONEST test: `seq` NARROWS the replay window, it does not close it.
    // A fresh peer whose watermark is empty (browser restart, first join
    // after a hostile tombstone-delete) has no prior observation to defeat
    // the replayed grant. This test documents the residual truthfully so
    // future readers can see the boundary of the fix.
    //
    // Setup: owner grants, hostile captures, owner revokes. Then a hostile
    // peer DELETES the tombstone (they have map-write access — the whole
    // reason C6 signed CRDT ops are still open) and REPLACES it with the
    // replayed grant. A brand-new peer session (fresh watermark) then reads.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    const capturedGrant = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`);
    removeDoorGrant(DOOR_NORTH, guestPub);

    // Hostile peer deletes the tombstone and plants the replayed grant.
    doc.getMap('doorGrants').delete(`${DOOR_NORTH}|${guestPub}`);
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, capturedGrant);

    // Brand-new peer session — different doc means watermark is wiped, but
    // even rebinding to the SAME doc with a fresh internal state models the
    // "browser restart" case. bindDoorPolicy clears watermarks on new doc.
    const freshDoc = new Y.Doc();
    bindDoorPolicy(freshDoc, { roomId: ROOM_A });   // wipes the map
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => otherPub,
    });
    // Fresh peer has no watermark; the replayed grant verifies against the
    // owner's key and hasDoorGrant returns TRUE.
    //
    // This is the tombstone-deletion attack surface that C6 (signed CRDT
    // ops) or an anchored tombstone log (chia-authority-architecture)
    // closes. Documented in the doorPolicy.ts module header under
    // DOCUMENTED RESIDUALS.
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
  });

  it("removeDoorGrant from a non-owner session in signed mode is a no-op", () => {
    // The signer/verifier are wired but the local session is not the owner.
    // A well-behaved caller (docking.ts gates on ownership already) never
    // reaches here; a hostile/buggy caller must not be able to plant an
    // unsigned tombstone that gets dropped by verify-on-read but STILL
    // clobbers the grant via CRDT-LWW. We refuse the write cleanly.
    bindAsOwner(doc, ROOM_A);
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);

    // Rebind as a non-owner guest with the full signer seam.
    bindDoorPolicy(doc, {
      roomId: ROOM_A,
      verifySig: verifier,
      roomOwnerPub: () => ownerPub,
      localPub: () => guestPub,            // NOT the owner
      signOwner: signerFor(seedGuest),
      signSelf: signerFor(seedGuest),
    });
    removeDoorGrant(DOOR_NORTH, guestPub);
    // The grant is still intact — the non-owner call was refused.
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    // The slot still holds the original grant, not a tombstone.
    const rec = doc.getMap('doorGrants').get(`${DOOR_NORTH}|${guestPub}`) as DoorRightsGrant;
    expect((rec as unknown as { tombstone?: boolean }).tombstone).not.toBe(true);
  });

  it("legacy-binding removeDoorGrant preserves pre-D3 bare-delete behavior", () => {
    // The MIGRATION posture: a room bound WITHOUT the signing seam still
    // uses the old bare-delete semantics — there is no signed layer to
    // defeat and the pre-D3 fleet already writes/reads unsigned records.
    bindLegacy(doc);
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|${guestPub}`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Sam', grantedAt: 1,
    });
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(true);
    removeDoorGrant(DOOR_NORTH, guestPub);
    // Slot deleted, not replaced with a tombstone (no owner-signer wired).
    expect(doc.getMap('doorGrants').has(`${DOOR_NORTH}|${guestPub}`)).toBe(false);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it("signed tombstone verify-bytes helper exposes a stable canonical shape", () => {
    // Sanity that the helper canonicalizes deterministically — two calls
    // with the same inputs produce byte-identical output.
    const a = doorGrantTombstoneSignatureBytes(ROOM_A, DOOR_NORTH, {
      pub: guestPub, revokedAt: 42, seq: 3,
    });
    const b = doorGrantTombstoneSignatureBytes(ROOM_A, DOOR_NORTH, {
      pub: guestPub, revokedAt: 42, seq: 3,
    });
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    // A different doorId produces different bytes.
    const c = doorGrantTombstoneSignatureBytes(ROOM_A, DOOR_SOUTH, {
      pub: guestPub, revokedAt: 42, seq: 3,
    });
    expect(bytesToHex(a)).not.toBe(bytesToHex(c));
    // A different seq produces different bytes.
    const d = doorGrantTombstoneSignatureBytes(ROOM_A, DOOR_NORTH, {
      pub: guestPub, revokedAt: 42, seq: 4,
    });
    expect(bytesToHex(a)).not.toBe(bytesToHex(d));
  });
});

// ============================================================================
// D1/D1b: pure policy/grant gating logic (independent of the D3 sig layer)
// ============================================================================
//
// The scope directive names this coverage as the fallback deliverable if D3
// were blocked — landing it alongside D3 hardens the gate whether the sig
// layer is present or not. Each test binds LEGACY to keep the surface tight.

describe('D1/D1b · pure logic (legacy binding, no signatures)', () => {
  beforeEach(() => { bindLegacy(doc); });

  it('read of an UNKNOWN door id returns DEFAULT_DOOR_POLICY', () => {
    // Free-door ids without a doorLayout entry fall back to defaults so a
    // stale id from a torn-down door cannot spawn a per-slot policy record.
    expect(readDoorPolicy('d:not-a-real-door')).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('write of an UNKNOWN door id is a no-op', () => {
    writeDoorPolicy('d:not-a-real-door', { passage: 'owner', construction: 'public' });
    expect(doc.getMap('doorPolicy').has('d:not-a-real-door')).toBe(false);
  });

  it('an empty raw record round-trips to sanitized defaults', () => {
    // {} passes the object shape guard, then every enum coerces to defaults.
    // The signed-record read path always emits an explicit adapter boolean.
    doc.getMap('doorPolicy').set(DOOR_NORTH, {});
    const read = readDoorPolicy(DOOR_NORTH);
    expect(read.passage).toBe(DEFAULT_DOOR_POLICY.passage);
    expect(read.construction).toBe(DEFAULT_DOOR_POLICY.construction);
    expect(read.oneWay).toBeUndefined();
    expect(read.adapter).toBe(false);
  });

  it('a garbage raw record round-trips to defaults', () => {
    doc.getMap('doorPolicy').set(DOOR_NORTH, 'not-an-object' as unknown);
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
    doc.getMap('doorPolicy').set(DOOR_NORTH, 42 as unknown);
    expect(readDoorPolicy(DOOR_NORTH)).toEqual(DEFAULT_DOOR_POLICY);
  });

  it('bogus enum values sanitize to defaults', () => {
    doc.getMap('doorPolicy').set(DOOR_NORTH, {
      passage: 'ANARCHY', construction: 'FREE-FOR-ALL', oneWay: 'sideways',
    });
    const p = readDoorPolicy(DOOR_NORTH);
    expect(p.passage).toBe('public');
    expect(p.construction).toBe('owner');
    expect(p.oneWay).toBeUndefined();
  });

  it('passageLabel prints every combination distinctly', () => {
    expect(passageLabel({ passage: 'public', construction: 'owner' })).toBe('PUBLIC');
    expect(passageLabel({ passage: 'public', construction: 'owner', oneWay: 'in' })).toBe('PUBLIC · IN ONLY');
    expect(passageLabel({ passage: 'public', construction: 'owner', oneWay: 'out' })).toBe('PUBLIC · OUT ONLY');
    expect(passageLabel({ passage: 'owner', construction: 'owner' })).toBe('OWNER');
  });

  it('request/grant list scoping by doorId works both ways', () => {
    writeDoorRequest(DOOR_NORTH, guestPub, 'Sam');
    writeDoorRequest(DOOR_SOUTH, guestPub, 'Sam');
    writeDoorRequest(DOOR_NORTH, otherPub, 'Bob');
    expect(readDoorRequests().length).toBe(3);
    expect(readDoorRequests(DOOR_NORTH).length).toBe(2);
    expect(readDoorRequests(DOOR_SOUTH).length).toBe(1);
    expect(readDoorRequests('east').length).toBe(0);
  });

  it('grants sort newest-first, requests sort newest-first', () => {
    writeDoorGrant(DOOR_NORTH, guestPub, 'Sam');
    writeDoorGrant(DOOR_NORTH, otherPub, 'Bob');
    // grantedAt is Date.now() — the second write's timestamp is >=.
    const grants = readDoorGrants(DOOR_NORTH);
    expect(grants.length).toBe(2);
    expect(grants[0].grantedAt).toBeGreaterThanOrEqual(grants[1].grantedAt);
  });

  it('remove functions are no-ops for missing keys', () => {
    expect(() => removeDoorRequest(DOOR_NORTH, 'ghost')).not.toThrow();
    expect(() => removeDoorGrant(DOOR_NORTH, 'ghost')).not.toThrow();
  });

  it('writeDoorRequest with an EMPTY pub is a no-op (would key everyone to "")', () => {
    writeDoorRequest(DOOR_NORTH, '', 'Sam');
    expect(readDoorRequests(DOOR_NORTH)).toEqual([]);
  });

  it('writeDoorGrant with an EMPTY pub is a no-op', () => {
    writeDoorGrant(DOOR_NORTH, '', 'Sam');
    expect(readDoorGrants(DOOR_NORTH)).toEqual([]);
  });

  it('shape guard drops a request record missing required fields', () => {
    doc.getMap('doorRequests').set('bogus', { doorId: DOOR_NORTH }); // no pub/name/at
    expect(readDoorRequests(DOOR_NORTH)).toEqual([]);
    expect(hasDoorRequest(DOOR_NORTH, 'no-such-pub')).toBe(false);
  });

  it('shape guard drops a grant record missing required fields', () => {
    doc.getMap('doorGrants').set('bogus', { doorId: DOOR_NORTH, pub: guestPub }); // no name/grantedAt
    expect(readDoorGrants(DOOR_NORTH)).toEqual([]);
    expect(hasDoorGrant(DOOR_NORTH, guestPub)).toBe(false);
  });

  it('map-key discipline: unparseable map keys are dropped by readDoor*', () => {
    // Bogus keys with no `|` separator (or empty parts) cannot map back to a
    // `(doorId, pub)` pair — the reader must skip them so a hostile write
    // to a garbage key never surfaces as a real grant/request.
    doc.getMap('doorGrants').set('no-separator-here', {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Sam', grantedAt: 1,
    });
    doc.getMap('doorGrants').set(`${DOOR_NORTH}|`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Sam', grantedAt: 1,
    });
    doc.getMap('doorGrants').set(`|${guestPub}`, {
      doorId: DOOR_NORTH, pub: guestPub, name: 'Sam', grantedAt: 1,
    });
    expect(readDoorGrants(DOOR_NORTH)).toEqual([]);

    doc.getMap('doorRequests').set('no-separator-here', {
      doorId: DOOR_NORTH, requesterPub: guestPub, requesterName: 'Sam', at: 1,
    });
    expect(readDoorRequests(DOOR_NORTH)).toEqual([]);
  });

  it('per-door construction default is OWNER (matches DEFAULT_DOOR_POLICY invariant)', () => {
    expect(DEFAULT_DOOR_POLICY.construction).toBe('owner');
    expect(DEFAULT_DOOR_POLICY.passage).toBe('public');
    expect(DEFAULT_DOOR_POLICY.adapter).toBeUndefined();
    expect(DEFAULT_DOOR_POLICY.oneWay).toBeUndefined();
  });
});
