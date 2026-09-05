/**
 * standsDoc.ts tests — the Yjs binding and the SIGNED-claim layer (#76,
 * PR #126 review). Real Ed25519 keys via @noble (hex-encoded — the module is
 * encoding-agnostic, so any verifier/signer pair the injector agrees on
 * works; the browser wires keypair.ts's base64url pair).
 *
 * What this file pins:
 *   • signed round-trip: claimStand writes a record every replica verifies
 *   • forgery / lift resistance: wrong signer, other slot, other room,
 *     tampered `at`, tampered sig, unsigned or legacy shape, planted Y.Map —
 *     all read as "no claim"; a Sybil key naming ITSELF is (honestly) accepted
 *   • fail-closed wiring: no verifier ⇒ nothing reads (warns once); an
 *     unsignable client writes nothing and returns null (warns once)
 *   • verification memo: the verifier runs once per distinct record across
 *     repeated reads, again after the record changes, again after a rebind
 *   • CRDT convergence with signatures on both replicas
 *   • the world.ts contracts: release-ownership guard, stand-switch
 *     release-before-claim, aborted APPROACH, heartbeat ownership guard
 *   • online-pub provider + partial-rebind option semantics + localStandPub
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  STAND_CLAIM_HEARTBEAT_MS,
  STAND_CLAIM_TTL_MS,
  canPlayerClaim,
  findExpiredClaims,
  pickStandForWalkup,
  shouldReleaseSlot,
  standClaimSignatureBytes,
} from './standClaims';
import type { StandClaim } from './standClaims';
import {
  bindStandsDoc,
  claimStand,
  getOnlinePubs,
  localStandPub,
  readAllStandClaims,
  readStandClaim,
  reapExpiredClaims,
  releaseStand,
} from './standsDoc';
import type { StandSigVerifier, StandSigner } from './standsDoc';
import type { StandSlot } from './furniture';

// @noble/ed25519 v2 sync API needs sha512 wired once (same as keypair.ts).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const seedAlice = new Uint8Array(32).fill(1);
const seedBob = new Uint8Array(32).fill(2);
const seedMallory = new Uint8Array(32).fill(6);

const pubOf = (seed: Uint8Array): string => bytesToHex(ed.getPublicKey(seed));
const ALICE = pubOf(seedAlice);
const BOB = pubOf(seedBob);
const MALLORY = pubOf(seedMallory);

/** Hex verifier — try/catch so a malformed hex sig/pub reads as invalid. */
const verifier: StandSigVerifier = (pub, bytes, sig) => {
  try {
    return ed.verify(hexToBytes(sig), bytes, hexToBytes(pub));
  } catch {
    return false;
  }
};
/** Hex signature by `seed` over `bytes` — always a string (test keys never fail). */
const hexSign = (seed: Uint8Array, bytes: Uint8Array): string => bytesToHex(ed.sign(bytes, seed));
const signerFor = (seed: Uint8Array): StandSigner => (bytes) => hexSign(seed, bytes);

const ROOM = 'room-alpha';
const OTHER_ROOM = 'room-bravo';
const T0 = 1_700_000_000_000;

/** Bind `doc` as `seed`'s client in `roomId` — the full main.ts wiring. */
function bindAs(seed: Uint8Array, doc: Y.Doc, roomId = ROOM): void {
  bindStandsDoc(doc, {
    roomId,
    verifySig: verifier,
    localPub: () => pubOf(seed),
    sign: signerFor(seed),
  });
}

/** Hand-sign a claim as `seed` for (roomId, slotId) — what a peer's client writes. */
function signedClaim(seed: Uint8Array, roomId: string, slotId: string, at: number): StandClaim {
  const pub = pubOf(seed);
  const sig = hexSign(seed, standClaimSignatureBytes(roomId, slotId, { pub, at }));
  return { pub, at, sig };
}

/** Clear every module-level option so tests never inherit a prior binding. */
function resetBinding(): void {
  bindStandsDoc(new Y.Doc(), {
    roomId: undefined,
    verifySig: undefined,
    localPub: undefined,
    sign: undefined,
    getOnlinePubs: undefined,
  });
}

const slot = (id: string, role?: StandSlot['role']): StandSlot => ({
  id,
  front: { x: 0, z: 0 },
  faceAngle: 0,
  role,
});

beforeEach(() => {
  resetBinding();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signed round-trip', () => {
  it('claimStand writes a { pub, at, sig } record the local reader verifies', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    const written = claimStand('tbl-1:s0', T0);
    expect(written).not.toBeNull();
    expect(written!.pub).toBe(ALICE);
    expect(written!.at).toBe(T0);
    expect(written!.sig.length).toBeGreaterThan(0);
    expect(readStandClaim('tbl-1:s0')).toEqual(written);
    // The raw doc value is exactly the returned record (plain JSON, no Y types).
    expect(doc.getMap('stands').get('tbl-1:s0')).toEqual(written);
  });

  it('a peer bound to the same doc and room verifies the record too', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    bindAs(seedBob, doc);
    const seen = readStandClaim('tbl-1:s0');
    expect(seen?.pub).toBe(ALICE);
    expect(readAllStandClaims().get('tbl-1:s0')?.pub).toBe(ALICE);
  });

  it('a heartbeat renewal is a fresh signature over the new `at`', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    const first = claimStand('tbl-1:s0', T0)!;
    const renewed = claimStand('tbl-1:s0', T0 + STAND_CLAIM_HEARTBEAT_MS)!;
    expect(renewed.at).toBe(T0 + STAND_CLAIM_HEARTBEAT_MS);
    expect(renewed.sig).not.toBe(first.sig);
    expect(readStandClaim('tbl-1:s0')).toEqual(renewed);
  });

  it('releaseStand deletes the key; releasing an empty slot is a no-op', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    releaseStand('tbl-1:s0');
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(doc.getMap('stands').has('tbl-1:s0')).toBe(false);
    expect(() => releaseStand('tbl-1:s0')).not.toThrow();
  });

  it('readAllStandClaims returns every verified claim and skips the rest', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    doc.getMap('stands').set('tbl-1:s1', signedClaim(seedBob, ROOM, 'tbl-1:s1', T0));
    doc.getMap('stands').set('tbl-1:s2', 'garbage');
    const all = readAllStandClaims();
    expect([...all.keys()].sort()).toEqual(['tbl-1:s0', 'tbl-1:s1']);
    expect(all.get('tbl-1:s1')?.pub).toBe(BOB);
  });
});

describe('forgery and lift resistance (every case reads as "no claim")', () => {
  it('a record naming ALICE but signed by Mallory', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    const forged = { ...signedClaim(seedMallory, ROOM, 'tbl-1:s0', T0), pub: ALICE };
    doc.getMap('stands').set('tbl-1:s0', forged);
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readAllStandClaims().size).toBe(0);
  });

  it("Alice's valid claim lifted to a different slot key", () => {
    const doc = new Y.Doc();
    bindAs(seedBob, doc);
    doc.getMap('stands').set('tbl-1:s2', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(readStandClaim('tbl-1:s2')).toBeNull();
    // The same bytes under the slot they were signed for DO verify.
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(readStandClaim('tbl-1:s0')?.pub).toBe(ALICE);
  });

  it("Alice's valid claim from another room", () => {
    const doc = new Y.Doc();
    bindAs(seedBob, doc, OTHER_ROOM);
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(readStandClaim('tbl-1:s0')).toBeNull();
  });

  it('a valid record with `at` bumped (the eviction-by-fresher-clock attack)', () => {
    const doc = new Y.Doc();
    bindAs(seedBob, doc);
    const real = signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0);
    doc.getMap('stands').set('tbl-1:s0', { ...real, at: T0 + 1 });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
  });

  it('a valid record with a corrupted signature', () => {
    const doc = new Y.Doc();
    bindAs(seedBob, doc);
    const real = signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0);
    const flipped = (real.sig[0] === '0' ? '1' : '0') + real.sig.slice(1);
    doc.getMap('stands').set('tbl-1:s0', { ...real, sig: flipped });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    doc.getMap('stands').set('tbl-1:s0', { ...real, sig: 'not-hex-at-all' });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
  });

  it('an unsigned { pub, at } record and a legacy { playerId, at } record', () => {
    const doc = new Y.Doc();
    bindAs(seedBob, doc);
    doc.getMap('stands').set('tbl-1:s0', { pub: ALICE, at: T0 });
    doc.getMap('stands').set('tbl-1:s1', { playerId: 'alice-uuid', at: T0 });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readStandClaim('tbl-1:s1')).toBeNull();
    expect(readAllStandClaims().size).toBe(0);
  });

  it('a planted nested Y.Map, a string, a number and a fractional `at`', () => {
    const doc = new Y.Doc();
    bindAs(seedBob, doc);
    const map = doc.getMap('stands');
    const nested = new Y.Map<unknown>();
    map.set('tbl-1:s0', nested);
    nested.set('pub', ALICE);
    nested.set('at', T0);
    nested.set('sig', 'x');
    map.set('tbl-1:s1', 'alice');
    map.set('tbl-1:s2', 42);
    map.set('tbl-1:s3', { ...signedClaim(seedAlice, ROOM, 'tbl-1:s3', T0), at: T0 + 0.5 });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readStandClaim('tbl-1:s1')).toBeNull();
    expect(readStandClaim('tbl-1:s2')).toBeNull();
    // Would throw inside canonicalEncode without the safe-integer shape rule.
    expect(() => readStandClaim('tbl-1:s3')).not.toThrow();
    expect(readStandClaim('tbl-1:s3')).toBeNull();
    expect(() => readAllStandClaims()).not.toThrow();
    expect(readAllStandClaims().size).toBe(0);
  });

  it('a verifier that throws is treated as "invalid", never propagated', () => {
    const doc = new Y.Doc();
    bindStandsDoc(doc, {
      roomId: ROOM,
      verifySig: () => { throw new Error('boom'); },
      localPub: () => ALICE,
      sign: signerFor(seedAlice),
    });
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(() => readStandClaim('tbl-1:s0')).not.toThrow();
    expect(readStandClaim('tbl-1:s0')).toBeNull();
  });

  it('SYBIL residual (documented, not prevented): any key may claim under its OWN name', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedMallory, ROOM, 'tbl-1:s0', T0));
    expect(readStandClaim('tbl-1:s0')?.pub).toBe(MALLORY);
  });
});

describe('fail-closed wiring', () => {
  it('with no verifier bound, a valid record reads as absent and warns ONCE per bind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    bindStandsDoc(doc, {
      roomId: ROOM,
      verifySig: undefined,
      localPub: () => ALICE,
      sign: signerFor(seedAlice),
    });
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readAllStandClaims().size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('no signature verifier');
    // A rebind re-arms the notice.
    bindStandsDoc(doc);
    readStandClaim('tbl-1:s0');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('garbage under a key never triggers the no-verifier notice (shape fails first)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: undefined });
    doc.getMap('stands').set('tbl-1:s0', 'garbage');
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('claimStand with no identity/signer/verifier writes nothing, returns null, warns ONCE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    // Verifier only — no localPub, no signer.
    bindStandsDoc(doc, { roomId: ROOM, verifySig: verifier, localPub: undefined, sign: undefined });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    expect(claimStand('tbl-1:s0', T0 + 1)).toBeNull();
    expect(doc.getMap('stands').size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('cannot post a signed stand claim');
    // Identity present, signer missing.
    bindStandsDoc(doc, { localPub: () => ALICE });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    expect(doc.getMap('stands').size).toBe(0);
    // Identity + signer present, verifier cleared.
    bindStandsDoc(doc, { sign: signerFor(seedAlice), verifySig: undefined });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    expect(doc.getMap('stands').size).toBe(0);
  });

  it('a signer that returns null or throws, or a localPub that returns "", writes nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: verifier, localPub: () => ALICE, sign: () => null });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    bindStandsDoc(doc, { sign: () => { throw new Error('no key'); } });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    bindStandsDoc(doc, { sign: signerFor(seedAlice), localPub: () => '' });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    expect(doc.getMap('stands').size).toBe(0);
  });

  it('signer/verifier disagreement: a record our own reader would refuse is never written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    bindStandsDoc(doc, {
      roomId: ROOM,
      verifySig: verifier,
      localPub: () => ALICE,
      // Signs for BOB's key while claiming to be ALICE — the self-check fails.
      sign: signerFor(seedBob),
    });
    expect(claimStand('tbl-1:s0', T0)).toBeNull();
    expect(doc.getMap('stands').size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('signer and verifier disagree');
  });
});

describe('verification memo', () => {
  it('verifies a record once across repeated reads, again when it changes, again after rebind', () => {
    const spy = vi.fn(verifier);
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: spy, localPub: () => ALICE, sign: signerFor(seedAlice) });

    // Own write: exactly one verify (the self-check), seeded into the memo.
    claimStand('tbl-1:s0', T0);
    expect(spy).toHaveBeenCalledTimes(1);
    readStandClaim('tbl-1:s0');
    readStandClaim('tbl-1:s0');
    readAllStandClaims();
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(1);

    // A peer's record: one verify on first sight, none after.
    doc.getMap('stands').set('tbl-1:s1', signedClaim(seedBob, ROOM, 'tbl-1:s1', T0));
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(2);
    readAllStandClaims();
    readStandClaim('tbl-1:s1');
    expect(spy).toHaveBeenCalledTimes(2);

    // The peer heartbeats (new `at`, new sig): a new record, one more verify.
    doc.getMap('stands').set('tbl-1:s1', signedClaim(seedBob, ROOM, 'tbl-1:s1', T0 + STAND_CLAIM_HEARTBEAT_MS));
    readAllStandClaims();
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(3);

    // Rebind (new join) drops the memo: the live records verify again.
    bindStandsDoc(doc, { roomId: ROOM });
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(5);
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('a BAD record is verified once too — a planted forgery is not re-checked every sweep', () => {
    const spy = vi.fn(verifier);
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: spy, localPub: () => ALICE, sign: signerFor(seedAlice) });
    doc.getMap('stands').set('tbl-1:s0', { ...signedClaim(seedMallory, ROOM, 'tbl-1:s0', T0), pub: ALICE });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readAllStandClaims().size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a full read prunes memo entries for records no longer in the map (re-planting re-verifies)', () => {
    const spy = vi.fn(verifier);
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: spy, localPub: () => ALICE, sign: signerFor(seedAlice) });
    const bobs = signedClaim(seedBob, ROOM, 'tbl-1:s1', T0);
    doc.getMap('stands').set('tbl-1:s1', bobs);
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(1);
    doc.getMap('stands').delete('tbl-1:s1');
    readAllStandClaims(); // generation boundary: the memo entry is dropped
    doc.getMap('stands').set('tbl-1:s1', bobs);
    readAllStandClaims();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('the memo is keyed by slot: the same bytes under another key are checked (and refused) separately', () => {
    const spy = vi.fn(verifier);
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: spy, localPub: () => ALICE, sign: signerFor(seedAlice) });
    const bobs = signedClaim(seedBob, ROOM, 'tbl-1:s1', T0);
    doc.getMap('stands').set('tbl-1:s1', bobs);
    doc.getMap('stands').set('tbl-1:s2', bobs);
    const all = readAllStandClaims();
    expect(all.get('tbl-1:s1')?.pub).toBe(BOB);
    expect(all.has('tbl-1:s2')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('CRDT convergence (two replicas, signed on both)', () => {
  it('two simultaneous claims on one slot collapse to ONE verified winner on both replicas', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    bindAs(seedAlice, docA);
    claimStand('tbl-1:s0', T0);
    bindAs(seedBob, docB);
    claimStand('tbl-1:s0', T0 + 1);

    // Exchange updates both ways (a full sync).
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    bindAs(seedAlice, docA);
    const onA = readStandClaim('tbl-1:s0');
    bindAs(seedBob, docB);
    const onB = readStandClaim('tbl-1:s0');
    expect(onA).not.toBeNull();
    expect(onA).toEqual(onB);
    expect([ALICE, BOB]).toContain(onA!.pub);
    // The loser's next walk-up sees the winner's claim as verified, so a
    // fresh claim over it is refused (never displace a live peer).
    expect(canPlayerClaim(onA, onA!.pub === ALICE ? BOB : ALICE, T0 + 2)).toBe(false);
  });

  it('the loser picks the next open slot', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    bindAs(seedAlice, docA);
    claimStand('tbl-1:s0', T0);
    bindAs(seedBob, docB);
    claimStand('tbl-1:s0', T0 + 1);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    bindAs(seedBob, docB);
    const winner = readStandClaim('tbl-1:s0')!.pub;
    const loser = winner === ALICE ? BOB : ALICE;
    const picked = pickStandForWalkup({
      slots: [slot('tbl-1:s0'), slot('tbl-1:s1')],
      claims: readAllStandClaims(),
      pub: loser,
      now: T0 + 2,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s1']);
  });

  it('a stale peer claim is reaped and the slot reopens (signed on the reaper side too)', () => {
    const docA = new Y.Doc();
    bindAs(seedAlice, docA);
    claimStand('tbl-1:s0', T0);

    // Bob's replica, a TTL later; Alice is not in Bob's online set.
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    bindAs(seedBob, docB);
    const stale = findExpiredClaims({
      claims: readAllStandClaims(),
      onlinePubs: new Set([BOB]),
      now: T0 + STAND_CLAIM_TTL_MS + 1,
    });
    expect(stale).toEqual(['tbl-1:s0']);
    reapExpiredClaims(stale);
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(claimStand('tbl-1:s0', T0 + STAND_CLAIM_TTL_MS + 2)?.pub).toBe(BOB);
  });
});

describe('release-ownership guard (world.ts releaseStandById contract)', () => {
  it('a client releases its own slot', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    const current = readStandClaim('tbl-1:s0');
    expect(shouldReleaseSlot(current, localStandPub() ?? '')).toBe(true);
    releaseStand('tbl-1:s0');
    expect(readStandClaim('tbl-1:s0')).toBeNull();
  });

  it("a client does NOT delete another identity's verified claim after losing tenure", () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    // Alice's tab slept past the TTL; Bob legitimately took the slot.
    bindAs(seedBob, doc);
    expect(canPlayerClaim(readStandClaim('tbl-1:s0'), BOB, T0 + STAND_CLAIM_TTL_MS + 1)).toBe(true);
    claimStand('tbl-1:s0', T0 + STAND_CLAIM_TTL_MS + 1);
    // Alice wakes and releases: the guard sees Bob's claim and refuses.
    bindAs(seedAlice, doc);
    const current = readStandClaim('tbl-1:s0');
    expect(shouldReleaseSlot(current, localStandPub() ?? '')).toBe(false);
    expect(readStandClaim('tbl-1:s0')?.pub).toBe(BOB);
  });

  it('with no identity bound only an EMPTY slot may be released ("" never names anyone)', () => {
    const doc = new Y.Doc();
    bindStandsDoc(doc, { roomId: ROOM, verifySig: verifier, localPub: undefined, sign: undefined });
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(localStandPub()).toBeNull();
    expect(shouldReleaseSlot(readStandClaim('tbl-1:s0'), localStandPub() ?? '')).toBe(false);
    expect(shouldReleaseSlot(readStandClaim('tbl-1:s9'), localStandPub() ?? '')).toBe(true);
  });
});

describe('stand-switch: release-before-claim (world.ts standTarget contract)', () => {
  it('switching tables leaves the old slot empty and the new one claimed', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    // World.ts releases the tracked slot BEFORE claiming the next one.
    if (shouldReleaseSlot(readStandClaim('tbl-1:s0'), localStandPub() ?? '')) releaseStand('tbl-1:s0');
    claimStand('tbl-2:s0', T0 + 1);
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(readStandClaim('tbl-2:s0')?.pub).toBe(ALICE);
    expect(readAllStandClaims().size).toBe(1);
  });
});

describe('aborted APPROACH (walk cancelled before arrival)', () => {
  it('releasing the claimed-but-never-reached slot reopens it for the next walker', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    // Alice turns away mid-walk; world.ts fires the release hook.
    if (shouldReleaseSlot(readStandClaim('tbl-1:s0'), localStandPub() ?? '')) releaseStand('tbl-1:s0');
    bindAs(seedBob, doc);
    const picked = pickStandForWalkup({
      slots: [slot('tbl-1:s0')],
      claims: readAllStandClaims(),
      pub: localStandPub()!,
      now: T0 + 1,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s0']);
  });
});

describe('heartbeat ownership guard (world.ts tickStandHeartbeat contract)', () => {
  /**
   * Mirrors tickStandHeartbeat: read the VERIFIED current claim, bail if a
   * different live identity holds the slot, otherwise renew with a fresh
   * signature. Returns whether the slot is still tracked afterwards.
   */
  function guardedHeartbeat(slotId: string, now: number): boolean {
    const current = readStandClaim(slotId);
    const me = localStandPub() ?? '';
    if (!canPlayerClaim(current, me, now)) return false;
    return claimStand(slotId, now) !== null;
  }

  it('renews its own claim', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    expect(guardedHeartbeat('tbl-1:s0', T0 + STAND_CLAIM_HEARTBEAT_MS)).toBe(true);
    expect(readStandClaim('tbl-1:s0')?.at).toBe(T0 + STAND_CLAIM_HEARTBEAT_MS);
  });

  it('does NOT overwrite a live peer that took the slot while we slept', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    bindAs(seedBob, doc);
    claimStand('tbl-1:s0', T0 + STAND_CLAIM_TTL_MS + 1);
    bindAs(seedAlice, doc);
    expect(guardedHeartbeat('tbl-1:s0', T0 + STAND_CLAIM_TTL_MS + 2)).toBe(false);
    expect(readStandClaim('tbl-1:s0')?.pub).toBe(BOB);
  });

  it('re-claims its own slot after a peer garbage-overwrote it (denial residual, self-heals)', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    doc.getMap('stands').set('tbl-1:s0', { pub: ALICE, at: T0, sig: 'trashed' });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    expect(guardedHeartbeat('tbl-1:s0', T0 + STAND_CLAIM_HEARTBEAT_MS)).toBe(true);
    expect(readStandClaim('tbl-1:s0')?.pub).toBe(ALICE);
  });

  it('stops tracking when the client can no longer sign', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    bindStandsDoc(doc, { sign: undefined });
    expect(guardedHeartbeat('tbl-1:s0', T0 + STAND_CLAIM_HEARTBEAT_MS)).toBe(false);
    // The old record is untouched and ages out through the TTL.
    expect(readStandClaim('tbl-1:s0')?.at).toBe(T0);
  });
});

describe('online-pub provider + option semantics', () => {
  it('returns an empty set when no provider is registered', () => {
    expect(getOnlinePubs().size).toBe(0);
  });

  it('returns the provider snapshot when registered', () => {
    bindStandsDoc(new Y.Doc(), { getOnlinePubs: () => new Set([ALICE, BOB]) });
    expect([...getOnlinePubs()].sort()).toEqual([ALICE, BOB].sort());
  });

  it('a throwing provider is logged and treated as empty', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindStandsDoc(new Y.Doc(), { getOnlinePubs: () => { throw new Error('boom'); } });
    expect(getOnlinePubs().size).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('a rebind WITHOUT options keeps roomId, verifier, signer and provider (offline fallback)', () => {
    const doc = new Y.Doc();
    bindStandsDoc(doc, {
      roomId: ROOM,
      verifySig: verifier,
      localPub: () => ALICE,
      sign: signerFor(seedAlice),
      getOnlinePubs: () => new Set([ALICE]),
    });
    const local = new Y.Doc();
    bindStandsDoc(local);
    expect(localStandPub()).toBe(ALICE);
    expect(getOnlinePubs().has(ALICE)).toBe(true);
    // Practice claims in the page-local doc are still signed for ROOM and readable.
    expect(claimStand('tbl-1:s0', T0)?.pub).toBe(ALICE);
    local.getMap('stands').set('tbl-1:s1', signedClaim(seedBob, ROOM, 'tbl-1:s1', T0));
    expect(readStandClaim('tbl-1:s1')?.pub).toBe(BOB);
  });

  it('explicit undefined CLEARS a single option and leaves the others alone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    bindStandsDoc(doc, { getOnlinePubs: () => new Set([BOB]) });
    bindStandsDoc(doc, { getOnlinePubs: undefined });
    expect(getOnlinePubs().size).toBe(0);
    expect(localStandPub()).toBe(ALICE); // untouched
    bindStandsDoc(doc, { verifySig: undefined });
    doc.getMap('stands').set('tbl-1:s0', signedClaim(seedAlice, ROOM, 'tbl-1:s0', T0));
    expect(readStandClaim('tbl-1:s0')).toBeNull(); // fail closed
    expect(localStandPub()).toBe(ALICE); // still untouched
  });

  it('a new roomId invalidates claims signed for the previous room', () => {
    const doc = new Y.Doc();
    bindAs(seedAlice, doc);
    claimStand('tbl-1:s0', T0);
    bindStandsDoc(doc, { roomId: OTHER_ROOM });
    expect(readStandClaim('tbl-1:s0')).toBeNull();
    bindStandsDoc(doc, { roomId: ROOM });
    expect(readStandClaim('tbl-1:s0')?.pub).toBe(ALICE);
  });
});

describe('localStandPub', () => {
  it('is null when no reader is bound', () => {
    expect(localStandPub()).toBeNull();
  });

  it('returns the bound identity, and null for an empty string', () => {
    bindStandsDoc(new Y.Doc(), { localPub: () => ALICE });
    expect(localStandPub()).toBe(ALICE);
    bindStandsDoc(new Y.Doc(), { localPub: () => '' });
    expect(localStandPub()).toBeNull();
  });

  it('a throwing reader is logged and read as null', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindStandsDoc(new Y.Doc(), { localPub: () => { throw new Error('no identity yet'); } });
    expect(localStandPub()).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
  });
});
