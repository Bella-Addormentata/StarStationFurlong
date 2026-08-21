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
  type DoorPolicyRecord,
  type DoorRightsGrant,
  type DoorRightsRequest,
  bindDoorPolicy,
  doorGrantSignatureBytes,
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
