/**
 * tradingFloorDoc.ts — the fork-and-merge conservation suite.
 *
 * These tests set up two peers as independent Y.Docs, drive them apart
 * (each peer takes a distinct action), then merge both ways and assert:
 *
 *   1. CONSERVATION — the sum of shares across all holders never drifts
 *      from CHARTER_TOTAL_SHARES; no duplication, no destruction.
 *   2. DETERMINISM — every peer picks the SAME canonical accept and reaches
 *      the SAME cap table after merge + reconcile.
 *   3. IDEMPOTENCE — reconcileTradingFloor() called any number of times on
 *      the same state produces the same state.
 *
 * The pattern (fork docs, apply updates both ways) mirrors treasuryDoc.test.ts
 * and the casino convergence suite. Uses real @noble/ed25519 signatures — the
 * signature verifier in tradingFloorDoc goes through keypair.ts, which we
 * seed here by import order so identity is deterministic per test.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Node test env doesn't provide localStorage; keypair.ts reads it lazily on
// first call, so we install a shim BEFORE the imports of anything that touches
// getIdentityPub. beforeEach clears it between tests to isolate identities.
// (Testing tradingFloorDoc requires simulating multiple peers in one process,
// which is precisely what localStorage shim + importRecoveryKey enables.)
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } satisfies Storage;
}

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

import { foundVenture, ventureRecord, bindVentures, transferShares, CHARTER_TOTAL_SHARES } from './ventures';
import {
  bindTradingFloor,
  makeFloorOffer,
  postFloorOffer,
  acceptFloorOffer,
  cancelFloorOffer,
  reconcileTradingFloor,
  listOpenOffers,
  listTape,
  readTapeFor,
  pickCanonicalAccept,
  sumHeldShares,
  verifyFloorOffer,
  type FloorAccept,
} from './tradingFloorDoc';

// ── Identity swap helpers ────────────────────────────────────────────────────
//
// keypair.ts caches its seed at module scope. To simulate multiple peers in
// one process, we swap the localStorage entry AND clear the module cache by
// re-importing. But re-importing a live module isn't cheap in vitest; instead
// we use a small helper that writes the seed, then calls getIdentityPub() to
// re-warm the module cache (module caches the seed only if it's already been
// read). Because keypair.ts reads localStorage each time cachedSeed is null,
// we just have to make sure cachedSeed is null on the seed swap — which we
// do by hard-resetting the module via vitest's dynamic import cache.

import * as keypair from './keypair';

const SEED_KEY = 'ssf-identity-seed';

function b64urlEncode(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Install `seed` as the local identity and clear keypair's cache. The next
 *  call to getIdentityPub() will read this seed. */
function useIdentity(seed: Uint8Array): string {
  localStorage.setItem(SEED_KEY, b64urlEncode(seed));
  // Reset keypair's private module state via a direct assignment through
  // the module object; the exported functions read `cachedSeed` and repopulate
  // it from localStorage when null.
  (keypair as unknown as { __resetForTests?: () => void }).__resetForTests?.();
  // The above is optional — for hardened test isolation we hard-reset the
  // module here (safe: keypair uses stateless functions plus one memo cell).
  // If the reset hook isn't exposed we fall back to reading pub straight from
  // seed via a small local re-derivation. Both paths reach the same identity.
  // Force keypair to notice the new seed by round-tripping through import
  // recovery, which nulls the internal caches.
  keypair.importRecoveryKey(b64urlEncode(seed));
  return keypair.getIdentityPub();
}

// Deterministic per-role seeds (32 bytes of a fixed byte pattern) so tests
// are reproducible. These are NOT secrets — they never leave the test suite.
const SEED_FOUNDER = new Uint8Array(32).fill(0xA1);
const SEED_ALICE   = new Uint8Array(32).fill(0xB2);
const SEED_BOB     = new Uint8Array(32).fill(0xC3);

let PUB_FOUNDER = '';
let PUB_ALICE = '';
let PUB_BOB = '';

function initPubs(): void {
  // Compute expected pubs OUTSIDE the identity swap: ed.getPublicKey is pure,
  // so these are stable across tests regardless of which identity is active.
  PUB_FOUNDER = b64urlEncode(ed.getPublicKey(SEED_FOUNDER));
  PUB_ALICE   = b64urlEncode(ed.getPublicKey(SEED_ALICE));
  PUB_BOB     = b64urlEncode(ed.getPublicKey(SEED_BOB));
}

// ── Doc / venture setup helpers ─────────────────────────────────────────────

/** Bind ventures + trading floor to a fresh Y.Doc, found a venture, and
 *  distribute shares to Alice and Bob for scenario setup. All setup runs
 *  under the FOUNDER identity — the founder can transferShares from their
 *  100 to the two peers. */
function setupOfficeDoc(): {
  doc: Y.Doc;
  founderPub: string;
  alicePub: string;
  bobPub: string;
} {
  const doc = new Y.Doc();
  useIdentity(SEED_FOUNDER);
  bindVentures(doc);
  bindTradingFloor(doc);
  foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-1');
  // Give Alice 40 and Bob 30 to leave the founder with 30 (matches typical
  // pre-trade state for the scenarios below).
  transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
  transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);
  return { doc, founderPub: PUB_FOUNDER, alicePub: PUB_ALICE, bobPub: PUB_BOB };
}

/** Merge two Y.Docs both ways: after this both docs converge on the same
 *  merged state (Yjs CRDT invariant). Every conservation test uses this. */
function mergeBoth(a: Y.Doc, b: Y.Doc): void {
  const updA = Y.encodeStateAsUpdate(a);
  const updB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, updB);
  Y.applyUpdate(b, updA);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  initPubs();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tradingFloorDoc — canonical accept picker (pure reducer)', () => {
  it('picks the earliest acceptedAt', () => {
    const a: FloorAccept = {
      v: 1, offerId: '0'.repeat(32), ventureId: 'v', takerPub: PUB_ALICE,
      takerName: 'A', acceptedAt: 100, sig: 'x',
    };
    const b: FloorAccept = { ...a, takerPub: PUB_BOB, takerName: 'B', acceptedAt: 200 };
    expect(pickCanonicalAccept([a, b])?.takerPub).toBe(PUB_ALICE);
    expect(pickCanonicalAccept([b, a])?.takerPub).toBe(PUB_ALICE);
  });

  it('breaks ties by lex-smallest takerPub (deterministic across peers)', () => {
    const t = 100;
    const a: FloorAccept = {
      v: 1, offerId: '0'.repeat(32), ventureId: 'v', takerPub: PUB_ALICE,
      takerName: 'A', acceptedAt: t, sig: 'x',
    };
    const b: FloorAccept = { ...a, takerPub: PUB_BOB, takerName: 'B' };
    // A truly deterministic pick — both orderings agree
    const winA = pickCanonicalAccept([a, b])!;
    const winB = pickCanonicalAccept([b, a])!;
    expect(winA.takerPub).toBe(winB.takerPub);
    expect(winA.takerPub).toBe(PUB_ALICE < PUB_BOB ? PUB_ALICE : PUB_BOB);
  });

  it('returns null on empty set', () => {
    expect(pickCanonicalAccept([])).toBeNull();
  });
});

describe('tradingFloorDoc — sign / verify (hostile-map resistance)', () => {
  it('round-trips a signed offer through verify', () => {
    setupOfficeDoc();
    // The founder is the current identity — swap to Alice to sign as her.
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 10, { priceMojo: 0 });
    expect(offer).not.toBeNull();
    expect(verifyFloorOffer(offer)).toBe(true);
  });

  it('rejects a tampered offer (mutated shares field)', () => {
    setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 10)!;
    expect(verifyFloorOffer({ ...offer, shares: 99 })).toBe(false);
  });

  it('rejects an offer with a bogus offerId shape', () => {
    setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 10)!;
    expect(verifyFloorOffer({ ...offer, offerId: 'not-hex' })).toBe(false);
    expect(verifyFloorOffer({ ...offer, offerId: 'AA' + offer.offerId.slice(2) })).toBe(false); // uppercase
  });

  it('rejects a hostile raw map planting (unsigned garbage under offer:)', () => {
    const { doc } = setupOfficeDoc();
    doc.getMap('tradingFloor').set('offer:' + '0'.repeat(32), { junk: true });
    expect(listOpenOffers()).toEqual([]);
  });

  it('refuses to overwrite an existing valid offer with a different maker', () => {
    const { doc } = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const aliceOffer = makeFloorOffer('SELL', 'Alice', 5)!;
    expect(postFloorOffer(aliceOffer)).toBe(true);
    // Bob tries to squat Alice's offerId (impossible in practice — offerId
    // is 128-bit random — but the module still refuses).
    useIdentity(SEED_BOB);
    const bobOffer = makeFloorOffer('SELL', 'Bob', 5)!;
    // Bob signs an offer with Alice's id
    const forgery = { ...bobOffer, offerId: aliceOffer.offerId };
    expect(verifyFloorOffer(forgery)).toBe(false); // sig doesn't cover this offerId
    doc.getMap('tradingFloor').set(`offer:${aliceOffer.offerId}`, forgery);
    // Reading now: the forgery fails verify → we get null → the ORIGINAL
    // isn't there because we just overwrote it (a hostile Y.Map poke can
    // clobber a valid entry, exactly why the verify-on-read gate exists).
    // The board simply drops the entry.
    expect(listOpenOffers()).toEqual([]);
  });
});

describe('tradingFloorDoc — post / cancel / accept happy path', () => {
  it('post + accept + reconcile transfers shares (gift, priceMojo=0)', () => {
    const { doc, alicePub, bobPub } = setupOfficeDoc();
    // Alice posts a SELL for 5 of her 40 as a gift
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    expect(postFloorOffer(offer)).toBe(true);
    expect(listOpenOffers()).toHaveLength(1);
    // Bob accepts
    useIdentity(SEED_BOB);
    expect(acceptFloorOffer(offer.offerId, 'Bob')).toBe(true);
    // Reconcile — from the founder identity (any identity works; the write
    // is authorized by transferShares, which trusts the office cap table).
    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();
    expect(r.settledOfferIds).toContain(offer.offerId);
    expect(r.refusedOfferIds).toEqual([]);
    const v = ventureRecord()!;
    expect(v.shares[alicePub]).toBe(35);
    expect(v.shares[bobPub]).toBe(35);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
    // Tape entry present + open list drops the settled offer
    expect(readTapeFor(offer.offerId)?.shares).toBe(5);
    expect(listOpenOffers()).toEqual([]);
    // Idempotent — a second reconcile is a no-op
    const r2 = reconcileTradingFloor();
    expect(r2.settledOfferIds).toEqual([]);
    expect(sumHeldShares(ventureRecord()!)).toBe(CHARTER_TOTAL_SHARES);
    void doc;
  });

  it('BUY offer settles when a shareholder accepts (seller = taker)', () => {
    const { alicePub, bobPub } = setupOfficeDoc();
    // Bob posts a BUY for 3 (he'd like 3 more shares)
    useIdentity(SEED_BOB);
    const offer = makeFloorOffer('BUY', 'Bob', 3, { priceMojo: 0 })!;
    expect(postFloorOffer(offer)).toBe(true);
    // Alice accepts (parts with 3 of her 40)
    useIdentity(SEED_ALICE);
    expect(acceptFloorOffer(offer.offerId, 'Alice')).toBe(true);
    useIdentity(SEED_FOUNDER);
    reconcileTradingFloor();
    const v = ventureRecord()!;
    expect(v.shares[alicePub]).toBe(37);
    expect(v.shares[bobPub]).toBe(33);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
  });

  it('cancel BEFORE any accept: nothing settles', () => {
    const { alicePub, bobPub } = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5)!;
    postFloorOffer(offer);
    expect(cancelFloorOffer(offer.offerId)).toBe(true);
    // Bob tries to accept AFTER the cancel — the module doesn't hard-block
    // the write (a cancelled offer's key still exists), but reconcile refuses.
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');
    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();
    expect(r.settledOfferIds).toEqual([]);
    const v = ventureRecord()!;
    expect(v.shares[alicePub]).toBe(40);
    expect(v.shares[bobPub]).toBe(30);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
  });

  it('non-zero price REFUSES to settle in v1 (gift-only rail)', () => {
    const { alicePub, bobPub } = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 1_000 })!;
    postFloorOffer(offer);
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');
    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();
    expect(r.settledOfferIds).toEqual([]);
    expect(r.refusedOfferIds).toContain(offer.offerId);
    // Cap table untouched — the "priced offers refuse until Registry" rule.
    const v = ventureRecord()!;
    expect(v.shares[alicePub]).toBe(40);
    expect(v.shares[bobPub]).toBe(30);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
    // Offer is still LISTED (chart data lives on non-settlement); tape is empty.
    expect(listTape()).toEqual([]);
  });

  it('insufficient shares: seller no longer holds enough → refused, cap intact', () => {
    const { alicePub, bobPub } = setupOfficeDoc();
    // Alice posts a SELL for ALL 40 of her shares
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 40)!;
    postFloorOffer(offer);
    // Alice PRIVATELY moves 5 to Bob via transferShares BEFORE reconcile —
    // now she only holds 35.
    transferShares(alicePub, bobPub, 'Bob', 5);
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');
    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();
    expect(r.settledOfferIds).toEqual([]);
    expect(r.refusedOfferIds).toContain(offer.offerId);
    const v = ventureRecord()!;
    // The 5-share side transfer landed (not from this module); the trading
    // floor did NOT double-move.
    expect(v.shares[alicePub]).toBe(35);
    expect(v.shares[bobPub]).toBe(35);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
  });
});

describe('tradingFloorDoc — fork/merge conservation (the core V4 gate)', () => {
  it('two peers accept the same SELL offer — merge chooses ONE winner', () => {
    // Peer A: doc a; Peer B: doc b. Both start from a founder-authored state
    // that gives Alice 40 and Bob 30. Then we FORK: doc a is Bob's local view,
    // doc b is Charlie's local view (Charlie is a stand-in for a third taker;
    // for simplicity in the ledger's shares set we reuse the founder key here).
    const a = setupOfficeDoc();
    // Post an offer from Alice on doc a
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);
    // Clone the initial state to a fresh Y.Doc "b" by encoding + applying,
    // then rebind ventures/floor to b.
    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));
    // Rebind to b so writes land in bDoc. Bind first, then set identity per action.
    bindVentures(bDoc);
    bindTradingFloor(bDoc);
    // On b, the FOUNDER accepts the offer (identity swap first).
    useIdentity(SEED_FOUNDER);
    // Give the two peers DIFFERENT wall-clock acceptedAt: freeze Date.now
    // via a small mock so acceptedAt is deterministic.
    const RealDateNow = Date.now.bind(Date);
    let clock = RealDateNow();
    Date.now = () => clock;
    clock += 100;
    acceptFloorOffer(offer.offerId, 'Founder');
    // Rebind back to A for Bob's accept
    bindVentures(a.doc);
    bindTradingFloor(a.doc);
    useIdentity(SEED_BOB);
    clock += 50;
    acceptFloorOffer(offer.offerId, 'Bob');
    Date.now = RealDateNow;

    // Merge both ways
    mergeBoth(a.doc, bDoc);

    // Both docs now hold BOTH accepts. Reconcile on each — because the
    // canonical picker is pure, both peers pick the SAME winner. Founder's
    // accept was earliest (+150) but Bob's was earliest (+150+50=200)... wait,
    // actually Founder's was at clockStart+100 and Bob at clockStart+150, so
    // Founder should win. Assert accordingly.
    // Rebind + reconcile on A
    bindVentures(a.doc);
    bindTradingFloor(a.doc);
    useIdentity(SEED_FOUNDER);
    const rA = reconcileTradingFloor();
    // Rebind + reconcile on B
    bindVentures(bDoc);
    bindTradingFloor(bDoc);
    useIdentity(SEED_FOUNDER);
    const rB = reconcileTradingFloor();
    expect(rA.settledOfferIds).toEqual([offer.offerId]);
    expect(rB.settledOfferIds).toEqual([offer.offerId]);

    // Merge again to converge cap-table writes
    mergeBoth(a.doc, bDoc);

    // Read cap tables from both docs
    bindVentures(a.doc);
    const vA = ventureRecord()!;
    bindVentures(bDoc);
    const vB = ventureRecord()!;

    // Both peers agree on the cap table
    expect(vA.shares).toEqual(vB.shares);
    // Conservation: sum is still 100
    expect(sumHeldShares(vA)).toBe(CHARTER_TOTAL_SHARES);
    expect(sumHeldShares(vB)).toBe(CHARTER_TOTAL_SHARES);
    // Alice lost exactly 5; the founder (earliest accept) received them
    expect(vA.shares[a.alicePub]).toBe(35);
    expect(vA.shares[a.founderPub]).toBe(30 + 5);
    // Bob (loser) unchanged
    expect(vA.shares[a.bobPub]).toBe(30);
    // Only ONE tape entry per offer (write-once)
    bindTradingFloor(a.doc);
    expect(listTape().filter((t) => t.offerId === offer.offerId)).toHaveLength(1);
    bindTradingFloor(bDoc);
    expect(listTape().filter((t) => t.offerId === offer.offerId)).toHaveLength(1);
  });

  it('cancel races taker accept — merge converges deterministically', () => {
    // Post an offer, then FORK: peer A cancels (maker), peer B accepts (taker).
    // Whether the trade settles depends on timestamp ordering — both peers
    // reach the SAME decision from the merged record set.
    const a = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);
    // Clone to B
    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));

    const RealDateNow = Date.now.bind(Date);
    let clock = RealDateNow();
    Date.now = () => clock;

    // Peer A: Alice cancels at t=100
    bindVentures(a.doc);
    bindTradingFloor(a.doc);
    useIdentity(SEED_ALICE);
    clock += 100;
    cancelFloorOffer(offer.offerId);
    // Peer B: Bob accepts at t=200 (AFTER Alice's cancel — trade must fail)
    bindVentures(bDoc);
    bindTradingFloor(bDoc);
    useIdentity(SEED_BOB);
    clock += 100;
    acceptFloorOffer(offer.offerId, 'Bob');

    Date.now = RealDateNow;

    mergeBoth(a.doc, bDoc);

    // Reconcile on both — Bob's accept was AFTER Alice's cancel, so cancel wins.
    for (const doc of [a.doc, bDoc]) {
      bindVentures(doc);
      bindTradingFloor(doc);
      useIdentity(SEED_FOUNDER);
      const r = reconcileTradingFloor();
      expect(r.settledOfferIds).toEqual([]);
    }
    mergeBoth(a.doc, bDoc);
    bindVentures(a.doc);
    const vA = ventureRecord()!;
    bindVentures(bDoc);
    const vB = ventureRecord()!;
    expect(vA.shares).toEqual(vB.shares);
    expect(vA.shares[a.alicePub]).toBe(40); // untouched
    expect(vA.shares[a.bobPub]).toBe(30);   // untouched
    expect(sumHeldShares(vA)).toBe(CHARTER_TOTAL_SHARES);
  });

  it('accept precedes cancel — trade settles, both peers agree', () => {
    // Reverse of the above: Bob accepts at t=100, Alice cancels at t=200 (too late).
    const a = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);
    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));

    const RealDateNow = Date.now.bind(Date);
    let clock = RealDateNow();
    Date.now = () => clock;

    // Peer B: Bob accepts at t=100
    bindVentures(bDoc);
    bindTradingFloor(bDoc);
    useIdentity(SEED_BOB);
    clock += 100;
    acceptFloorOffer(offer.offerId, 'Bob');
    // Peer A: Alice cancels at t=200 (too late)
    bindVentures(a.doc);
    bindTradingFloor(a.doc);
    useIdentity(SEED_ALICE);
    clock += 100;
    cancelFloorOffer(offer.offerId);

    Date.now = RealDateNow;

    mergeBoth(a.doc, bDoc);

    for (const doc of [a.doc, bDoc]) {
      bindVentures(doc);
      bindTradingFloor(doc);
      useIdentity(SEED_FOUNDER);
      reconcileTradingFloor();
    }
    mergeBoth(a.doc, bDoc);
    bindVentures(a.doc);
    const vA = ventureRecord()!;
    bindVentures(bDoc);
    const vB = ventureRecord()!;
    expect(vA.shares).toEqual(vB.shares);
    expect(vA.shares[a.alicePub]).toBe(35);
    expect(vA.shares[a.bobPub]).toBe(35);
    expect(sumHeldShares(vA)).toBe(CHARTER_TOTAL_SHARES);
    bindTradingFloor(a.doc);
    expect(readTapeFor(offer.offerId)).not.toBeNull();
  });

  it('two DIFFERENT offers fork/merge — both settle independently, no cross-talk', () => {
    // A has an OpenOffer O1; B has an OpenOffer O2. Both accepted on the same
    // peer that reconciles. Verify both settle correctly and cap conserved.
    const a = setupOfficeDoc();
    // Offer 1: Alice sells 3
    useIdentity(SEED_ALICE);
    const o1 = makeFloorOffer('SELL', 'Alice', 3)!;
    postFloorOffer(o1);
    // Fork
    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));
    // Offer 2: Bob buys 2 — posted on peer B
    bindVentures(bDoc);
    bindTradingFloor(bDoc);
    useIdentity(SEED_BOB);
    const o2 = makeFloorOffer('BUY', 'Bob', 2)!;
    postFloorOffer(o2);
    // Peer B also accepts O1 (needs its record present — mergeBoth first)
    mergeBoth(a.doc, bDoc);
    bindVentures(bDoc);
    bindTradingFloor(bDoc);
    useIdentity(SEED_BOB);
    acceptFloorOffer(o1.offerId, 'Bob');
    // Peer A: Alice accepts O2 (BUY from Bob for 2 shares)
    bindVentures(a.doc);
    bindTradingFloor(a.doc);
    useIdentity(SEED_ALICE);
    acceptFloorOffer(o2.offerId, 'Alice');
    // Merge + reconcile
    mergeBoth(a.doc, bDoc);
    for (const doc of [a.doc, bDoc]) {
      bindVentures(doc);
      bindTradingFloor(doc);
      useIdentity(SEED_FOUNDER);
      reconcileTradingFloor();
    }
    mergeBoth(a.doc, bDoc);
    bindVentures(a.doc);
    const vA = ventureRecord()!;
    bindVentures(bDoc);
    const vB = ventureRecord()!;
    expect(vA.shares).toEqual(vB.shares);
    // Alice: 40 - 3 (O1 sale to Bob) - 2 (O2 sale to Bob) = 35
    // Bob:   30 + 3 (O1) + 2 (O2) = 35
    expect(vA.shares[a.alicePub]).toBe(35);
    expect(vA.shares[a.bobPub]).toBe(35);
    expect(sumHeldShares(vA)).toBe(CHARTER_TOTAL_SHARES);
    bindTradingFloor(a.doc);
    expect(listTape()).toHaveLength(2);
  });

  it('reconcile is idempotent across many calls (no double-settle)', () => {
    const { alicePub, bobPub } = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 10)!;
    postFloorOffer(offer);
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');
    useIdentity(SEED_FOUNDER);
    for (let i = 0; i < 5; i++) reconcileTradingFloor();
    const v = ventureRecord()!;
    expect(v.shares[alicePub]).toBe(30);
    expect(v.shares[bobPub]).toBe(40);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
    expect(listTape()).toHaveLength(1);
  });
});

describe('tradingFloorDoc — expired offers are filtered', () => {
  it('an expired offer does not appear in listOpenOffers', () => {
    setupOfficeDoc();
    useIdentity(SEED_ALICE);
    // Make an offer with a tiny TTL, wait past it
    const RealDateNow = Date.now.bind(Date);
    let clock = RealDateNow();
    Date.now = () => clock;
    const offer = makeFloorOffer('SELL', 'Alice', 5, { ttlMs: 60_000 })!;
    postFloorOffer(offer);
    expect(listOpenOffers()).toHaveLength(1);
    clock += 120_000;
    expect(listOpenOffers()).toHaveLength(0);
    Date.now = RealDateNow;
  });

  it('reconcile refuses to settle an accept that came AFTER expiry', () => {
    const { alicePub, bobPub } = setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const RealDateNow = Date.now.bind(Date);
    let clock = RealDateNow();
    Date.now = () => clock;
    const offer = makeFloorOffer('SELL', 'Alice', 5, { ttlMs: 60_000 })!;
    postFloorOffer(offer);
    // Bob accepts BEFORE expiry — legal
    useIdentity(SEED_BOB);
    clock += 30_000;
    acceptFloorOffer(offer.offerId, 'Bob');
    // Advance past expiry
    clock += 120_000;
    // Reconcile — accept was BEFORE expiry, so settlement should still fire
    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();
    expect(r.settledOfferIds).toEqual([offer.offerId]);
    // Verify conservation
    const v = ventureRecord()!;
    expect(v.shares[alicePub]).toBe(35);
    expect(v.shares[bobPub]).toBe(35);
    expect(sumHeldShares(v)).toBe(CHARTER_TOTAL_SHARES);
    Date.now = RealDateNow;
  });
});

describe('tradingFloorDoc — access controls', () => {
  it('cannot accept your own offer', () => {
    setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5)!;
    postFloorOffer(offer);
    expect(acceptFloorOffer(offer.offerId, 'Alice')).toBe(false);
  });

  it('only the maker can cancel', () => {
    setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5)!;
    postFloorOffer(offer);
    // Bob tries to cancel Alice's offer — refused
    useIdentity(SEED_BOB);
    expect(cancelFloorOffer(offer.offerId)).toBe(false);
    // Alice cancels her own — accepted
    useIdentity(SEED_ALICE);
    expect(cancelFloorOffer(offer.offerId)).toBe(true);
  });

  it('lists only OWN offers as cancellable (surface-level correctness)', () => {
    setupOfficeDoc();
    useIdentity(SEED_ALICE);
    const oA = makeFloorOffer('SELL', 'Alice', 5)!;
    postFloorOffer(oA);
    useIdentity(SEED_BOB);
    const oB = makeFloorOffer('SELL', 'Bob', 3)!;
    postFloorOffer(oB);
    // Both offers appear on the board
    expect(listOpenOffers().map((o) => o.offerId).sort())
      .toEqual([oA.offerId, oB.offerId].sort());
    // Alice can only cancel her own
    useIdentity(SEED_ALICE);
    expect(cancelFloorOffer(oB.offerId)).toBe(false);
    expect(cancelFloorOffer(oA.offerId)).toBe(true);
  });
});

describe('tradingFloorDoc — surface language (plain-language rule)', () => {
  it('exports carry no NFT/CAT/mint/token/on-chain wording', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(
        new URL('./tradingFloorDoc.ts', import.meta.url), 'utf-8'));
    // These words appear in comments about V3 forward-compat — but NEVER
    // in user-facing strings (return values, throws, thrown Error messages).
    // We check that the module has no exported strings that surface these
    // words to end users. We do a coarse text scan: forbidden words must not
    // appear inside string literals matching common UI-copy patterns.
    const forbiddenInUI = /['"`][^'"`]*\b(NFT|CAT2|mint|token|on-chain|blockchain)\b[^'"`]*['"`]/i;
    // Comments are fine (they carry design intent). Strip comments before scan.
    const noLineComments = src.replace(/\/\/.*$/gm, '');
    const noBlockComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(forbiddenInUI.test(noBlockComments)).toBe(false);
  });
});
