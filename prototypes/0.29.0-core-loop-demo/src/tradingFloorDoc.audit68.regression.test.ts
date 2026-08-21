// Regression tests for the audit-#68 remediation of tradingFloorDoc.ts.
//
// Two audit findings are covered here — each test first documents the bug it
// prevents, then asserts the post-fix behaviour. Keeping the tests in-tree (as
// opposed to deleting the reproductions) means any future regression that
// re-introduces either bug fails these tests loudly rather than only being
// re-caught by an ad-hoc audit rerun.
//
// Finding 1 (MAJOR) — backdated-cancel bypass:
//   `verifyFloorCancel` shape-checked `Number.isFinite(cancelledAt)` but did
//   not tie `cancelledAt` to `offer.createdAt`. A malicious maker could sign a
//   cancel with an arbitrarily small `cancelledAt`; because reconcile's
//   `cancel.cancelledAt <= winner.acceptedAt` comparison then always succeeded,
//   every legitimate accept was nullified. Fix: reconcile + listOpenOffers now
//   both apply `isCancelInWindow(cancel, offer)` which requires
//   `cancel.cancelledAt >= offer.createdAt`.
//
// Finding 2 (MAJOR) — premature reconcile / LWW race decides settlement:
//   The UI button-handler called `reconcileTradingFloor()` SYNCHRONOUSLY after
//   `acceptFloorOffer`, BEFORE any Yjs merge. Each peer locally settled from
//   only its own accept and wrote a tape; the earlier `readTapeFor` guard then
//   prevented any post-merge canonical re-pick, so the LWW race — not
//   `pickCanonicalAccept` — decided the settled winner. Fix: reconcile now
//   drops the tape-shortcircuit, splits into a first-time path and a
//   corrective path (routes shares from the wrong recipient to the canonical
//   one and rewrites the tape); the UI wires accepts to
//   `scheduleReconcileTradingFloor()` (a merge-quiescence debouncer) and the
//   app binds `subscribeTradingFloor(() => scheduleReconcileTradingFloor())`
//   at the T0 seam so every merge triggers a post-merge reconcile on every
//   peer.

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Node polyfill: keypair.ts persists the identity seed to localStorage, so
// vitest under node needs a shim. Same shape the existing tradingFloorDoc.test
// uses (see that file for provenance).
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
// @noble/ed25519 v2 needs a sync sha512 for signIdentity — see keypair.ts.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

import { foundVenture, ventureRecord, bindVentures, transferShares, CHARTER_TOTAL_SHARES } from './ventures';
import {
  bindTradingFloor, makeFloorOffer, postFloorOffer, acceptFloorOffer,
  cancelFloorOffer, reconcileTradingFloor, readTapeFor, listTape,
} from './tradingFloorDoc';
import * as keypair from './keypair';

function b64urlEncode(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function useIdentity(seed: Uint8Array): string {
  localStorage.setItem('ssf-identity-seed', b64urlEncode(seed));
  keypair.importRecoveryKey(b64urlEncode(seed));
  return keypair.getIdentityPub();
}

const SEED_FOUNDER = new Uint8Array(32).fill(0xA1);
const SEED_ALICE = new Uint8Array(32).fill(0xB2);
const SEED_BOB = new Uint8Array(32).fill(0xC3);

const PUB_FOUNDER = b64urlEncode(ed.getPublicKey(SEED_FOUNDER));
const PUB_ALICE = b64urlEncode(ed.getPublicKey(SEED_ALICE));
const PUB_BOB = b64urlEncode(ed.getPublicKey(SEED_BOB));

beforeEach(() => { localStorage.clear(); });

describe('audit #68 finding 1 regression — backdated cancel cannot nullify a canonical accept', () => {
  it('a cancel with cancelledAt < offer.createdAt is ignored; the accept settles', () => {
    // SCENARIO: Alice posts a SELL offer at t=1000; Bob accepts at t=1050;
    // Alice then signs a cancel with cancelledAt=500 (BEFORE the offer even
    // existed). Pre-fix, reconcile compared `500 <= 1050` → true and refused
    // to settle the trade, leaving the maker able to nullify any accept ever
    // posted against the offer with a single signed cancel-slip.
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-1');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    useIdentity(SEED_ALICE);
    const realNow = Date.now.bind(Date);
    Date.now = () => 1000;
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);

    useIdentity(SEED_BOB);
    Date.now = () => 1050;
    acceptFloorOffer(offer.offerId, 'Bob');

    // The backdated cancel: signature is valid (Alice IS the maker) and the
    // shape guards all pass — only the semantic `cancelledAt >= createdAt`
    // window (isCancelInWindow) blocks it.
    useIdentity(SEED_ALICE);
    Date.now = () => 500;
    const cancelResult = cancelFloorOffer(offer.offerId);
    Date.now = realNow;
    expect(cancelResult).toBe(true);

    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();

    const v = ventureRecord()!;
    // WITH THE FIX: canonical accept survives; trade settles. Alice=35, Bob=35.
    // WITHOUT THE FIX: backdated cancel wins the compare; Alice=40, Bob=30, no tape.
    expect(v.shares[PUB_ALICE]).toBe(35);
    expect(v.shares[PUB_BOB]).toBe(35);
    expect(r.settledOfferIds).toContain(offer.offerId);
    expect(listTape()).toHaveLength(1);
  });
});

describe('audit #68 finding 2 regression — post-merge reconcile picks the canonical winner even after a per-peer premature settlement', () => {
  it('20 alternating-clientId trials all converge on the canonical (earliest) accept', () => {
    // SCENARIO: Alice posts SELL 5. Founder accepts EARLIER (t=1050 →
    // canonical), Bob accepts LATER (t=1100 → loser). Each peer runs the
    // OLD synchronous reconcile locally BEFORE any Yjs merge — so each peer
    // sees only its own accept and (mistakenly) settles a "winner" that is
    // whichever accept it happened to have witnessed. Pre-fix, LWW then
    // decided which peer's premature tape survived, and the `readTapeFor`
    // shortcircuit blocked any post-merge canonical re-pick — so Bob won
    // roughly half the time. The fix drops the shortcircuit and adds the
    // corrective-transfer path, so post-merge reconcile always leaves the
    // canonical winner (Founder) holding the shares.
    //
    // We rotate the clientId ordering across trials so LWW ties break both
    // ways over the run; before the fix roughly half of the trials Bob-won,
    // after the fix every trial Founder-wins.
    let bobWon = 0;
    let founderWon = 0;
    let inconsistencies = 0;

    for (let trial = 0; trial < 20; trial++) {
      const docA = new Y.Doc();
      const higher = (trial % 2 === 0);
      // Y.js Doc.clientID is normally random; pin it per trial so we can
      // steer LWW deterministically for both A>B and B>A cases.
      (docA as { clientID: number }).clientID = higher ? 2000 + trial : 1000 + trial;
      useIdentity(SEED_FOUNDER);
      bindVentures(docA);
      bindTradingFloor(docA);
      foundVenture('Test Co ' + trial, PUB_FOUNDER, 'Founder', 'room-' + trial);
      transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
      transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

      useIdentity(SEED_ALICE);
      const realNow = Date.now.bind(Date);
      let clock = 1000;
      Date.now = () => clock;
      const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
      postFloorOffer(offer);

      // Fork state to docB, with the alternate clientID for this trial.
      const docB = new Y.Doc();
      (docB as { clientID: number }).clientID = higher ? 1000 + trial : 2000 + trial;
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

      // Peer B: Founder accepts at t=1050 → canonical winner.
      bindVentures(docB);
      bindTradingFloor(docB);
      useIdentity(SEED_FOUNDER);
      clock = 1050;
      acceptFloorOffer(offer.offerId, 'Founder');
      reconcileTradingFloor(); // simulate the OLD synchronous UI-path reconcile

      // Peer A: Bob accepts at t=1100 → loser under pickCanonicalAccept.
      bindVentures(docA);
      bindTradingFloor(docA);
      useIdentity(SEED_BOB);
      clock = 1100;
      acceptFloorOffer(offer.offerId, 'Bob');
      reconcileTradingFloor(); // simulate the OLD synchronous UI-path reconcile
      Date.now = realNow;

      // Merge — this is where LWW would previously have decided the winner.
      const updA = Y.encodeStateAsUpdate(docA);
      const updB = Y.encodeStateAsUpdate(docB);
      Y.applyUpdate(docA, updB);
      Y.applyUpdate(docB, updA);

      // Post-merge reconcile IS the fix: with the tape-shortcircuit dropped
      // and the corrective transfer wired in, each peer independently detects
      // that the canonical winner differs from the settled tape and moves the
      // shares from the wrong recipient to the canonical one. Both peers
      // compute bytes-identical corrections → LWW converges to consistent
      // state on both peers.
      for (const doc of [docA, docB]) {
        bindVentures(doc);
        bindTradingFloor(doc);
        useIdentity(SEED_FOUNDER);
        reconcileTradingFloor();
      }

      // One more merge round to propagate the correction to both peers so we
      // can compare final states.
      const updA2 = Y.encodeStateAsUpdate(docA);
      const updB2 = Y.encodeStateAsUpdate(docB);
      Y.applyUpdate(docA, updB2);
      Y.applyUpdate(docB, updA2);

      bindVentures(docA);
      const vA = ventureRecord()!;
      bindVentures(docB);
      const vB = ventureRecord()!;
      bindTradingFloor(docA);
      const tapeA = readTapeFor(offer.offerId);

      let sumA = 0; for (const n of Object.values(vA.shares)) sumA += n;
      expect(sumA).toBe(CHARTER_TOTAL_SHARES);   // shares always conserved
      expect(vA.shares).toEqual(vB.shares);      // peers converged

      if (vA.shares[PUB_FOUNDER] === 35 && vA.shares[PUB_BOB] === 30) founderWon++;
      else if (vA.shares[PUB_FOUNDER] === 30 && vA.shares[PUB_BOB] === 35) bobWon++;
      else inconsistencies++;

      // Cap table must agree with the tape entry on every trial.
      if (tapeA?.takerPub === PUB_FOUNDER && vA.shares[PUB_FOUNDER] !== 35) inconsistencies++;
      if (tapeA?.takerPub === PUB_BOB && vA.shares[PUB_BOB] !== 35) inconsistencies++;
    }

    // The canonical winner (Founder — earliest acceptedAt) must win EVERY
    // trial, regardless of which peer LWW favoured for the tape.
    expect(bobWon).toBe(0);
    expect(founderWon).toBe(20);
    expect(inconsistencies).toBe(0);
  });
});
