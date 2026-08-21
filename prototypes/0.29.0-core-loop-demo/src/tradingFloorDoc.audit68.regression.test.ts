// Regression tests for the audit-#68 remediation of tradingFloorDoc.ts.
//
// Every audit finding covered here first documents the bug it prevents, then
// asserts the post-fix behaviour. Keeping the tests in-tree (as opposed to
// deleting the reproductions) means any future regression that re-introduces
// a finding fails these tests loudly rather than only being re-caught by an
// ad-hoc audit rerun.
//
// ROUND-1 findings (V4 initial audit):
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
//
// ROUND-2 findings (V4 re-audit after round-1 fixes landed):
//
// Round-2 Finding 1 (BLOCKER) — share theft via unsigned hostile FloorTape
// planting:
//   `verifyFloorTape` performs a shape-only check — `FloorTape` has no `sig`
//   or `writerPub` field, so any peer with Yjs write access can plant a
//   byte-valid tape naming ANY pub as `takerPub`. The round-1 corrective
//   path (added to fix round-1 finding 2) reads
//   `existing.takerPub` and unconditionally treats them as the "wrong
//   recipient" — moving their shares to the canonical winner. Attack probe:
//   Alice=40/Bob=30/Charlie=20; Alice legit-SELLs 5; Bob accepts; attacker
//   plants tape with `takerPub=PUB_CHARLIE`; corrective transfer robs
//   Charlie of 5 shares he was uninvolved with. Fix: `reconcileTradingFloor`
//   applies `isExistingTapeAuthentic(tape, offer, validAccepts)` before the
//   corrective path — a fabricated tape (fields don't match offer, or
//   takerPub isn't a valid accept-holder, or settledAt doesn't match that
//   accept's acceptedAt) refuses the offer instead of trusting the plant.
//   Honest limit documented on PR: a persistent attacker can DoS a specific
//   offer's settlement (Bob's legit trade blocked) — but the attacker
//   CANNOT move shares off any account.
//
// Round-2 Finding 2 (BLOCKER) — retroactive share theft via backdated
// FloorAccept:
//   `verifyFloorAccept` symmetrically lacked the `acceptedAt >= offer
//   .createdAt` window check that round-1 added for FloorCancel. Attack
//   probe: Bob legit-accepts at t=1050, trade settles (tape=Bob); attacker
//   Eve then signs her own accept with `acceptedAt=0`; `pickCanonicalAccept`
//   picks Eve (earliest acceptedAt wins); corrective path moves shares from
//   Bob to Eve. Fix: `reconcileTradingFloor` and
//   `hasCanonicalAcceptBefore` both filter accepts through
//   `isAcceptInWindow(accept, offer)` — an accept outside
//   `[offer.createdAt, offer.expiresAt)` is treated as absent so it cannot
//   become the canonical winner.
//
// Round-2 Finding 3 (NOTE) — `cancelScheduledReconcile` export was live but
// untested:
//   The debouncer helpers `scheduleReconcileTradingFloor` and
//   `cancelScheduledReconcile` (module-scope `reconcileTimer`) were exported
//   for UI + test callers but had no direct test coverage. The
//   "scheduled reconcile" test below drives both entry points end-to-end
//   via vitest fake timers so a future regression that broke either helper
//   fails immediately.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  scheduleReconcileTradingFloor, cancelScheduledReconcile,
  subscribeTradingFloor,
  RECONCILE_QUIESCENCE_MS,
  type FloorTape, type FloorAccept,
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
// Round-2 probes need two extra identities — Charlie (the theft victim in
// finding 1) and Eve (the backdated-accept attacker in finding 2).
const SEED_CHARLIE = new Uint8Array(32).fill(0xD4);
const SEED_EVE = new Uint8Array(32).fill(0xE5);

const PUB_FOUNDER = b64urlEncode(ed.getPublicKey(SEED_FOUNDER));
const PUB_ALICE = b64urlEncode(ed.getPublicKey(SEED_ALICE));
const PUB_BOB = b64urlEncode(ed.getPublicKey(SEED_BOB));
const PUB_CHARLIE = b64urlEncode(ed.getPublicKey(SEED_CHARLIE));
const PUB_EVE = b64urlEncode(ed.getPublicKey(SEED_EVE));

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

describe('audit #68 round-2 finding 1 regression — hostile fabricated FloorTape cannot rob an uninvolved third party', () => {
  it('a tape planted with takerPub=Charlie is refused; Charlie retains every share', () => {
    // SCENARIO — Alice=40, Bob=30, Charlie=20. Alice posts SELL 5 at t=1000
    // (priceMojo=0 so v1 gift settlement applies). Bob accepts at t=1050.
    // The attacker plants a byte-valid FloorTape naming PUB_CHARLIE as
    // takerPub — Charlie has no accept for this offer at all. Pre-fix, the
    // reconcile corrective path unconditionally trusted `existing.takerPub`
    // and moved 5 shares from Charlie to Bob (Charlie=15, Bob=35). Fix:
    // `isExistingTapeAuthentic` rejects the fabrication because Charlie
    // isn't in the offer's signed accept set; the offer refuses (documented
    // DoS-limit) and Charlie's balance is preserved.
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f1');
    // Fan out the initial cap table to Alice/Bob/Charlie.
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);
    transferShares(PUB_FOUNDER, PUB_CHARLIE, 'Charlie', 20);

    const realNow = Date.now.bind(Date);
    let clock = 1000;
    Date.now = () => clock;

    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);

    useIdentity(SEED_BOB);
    clock = 1050;
    acceptFloorOffer(offer.offerId, 'Bob');

    // ATTACKER PLANT — a raw Y.Map write from any peer with doc access.
    // FloorTape carries no signature or writerPub field, so verifyFloorTape
    // passes on shape alone. The authenticity gate is enforced downstream
    // in reconcileTradingFloor via isExistingTapeAuthentic.
    const fabricated: FloorTape = {
      v: 1,
      offerId: offer.offerId,
      ventureId: offer.ventureId,
      kind: 'SELL',
      shares: 5,
      priceMojo: 0,
      makerPub: PUB_ALICE,
      takerPub: PUB_CHARLIE,  // uninvolved third party — the theft target
      settledAt: 999,
    };
    doc.getMap('tradingFloor').set(`tape:${offer.offerId}`, fabricated);

    useIdentity(SEED_FOUNDER);
    clock = 1100;
    const r = reconcileTradingFloor();
    Date.now = realNow;

    const v = ventureRecord()!;
    // THEFT-BLOCKED — Charlie's shares are UNTOUCHED. This is the primary
    // security invariant: unsigned tape planting cannot move shares off any
    // account, regardless of who the attacker names as takerPub.
    expect(v.shares[PUB_CHARLIE]).toBe(20);
    expect(v.shares[PUB_ALICE]).toBe(40);
    expect(v.shares[PUB_BOB]).toBe(30);
    // The offer is refused (documented DoS-limit — Bob's legit trade does
    // NOT settle while the fabrication stands). This is the accepted
    // trade-off against "attacker rewrites tape and robs Charlie".
    expect(r.settledOfferIds).not.toContain(offer.offerId);
    expect(r.refusedOfferIds).toContain(offer.offerId);
    // Cap-table conservation — sum unchanged across the attack.
    let sum = 0;
    for (const n of Object.values(v.shares)) sum += n;
    expect(sum).toBe(CHARTER_TOTAL_SHARES);
  });

  it('a tape with a mismatched payload (wrong shares/priceMojo/etc.) is also refused', () => {
    // Defense-in-depth: even a tape naming the CORRECT canonical taker but
    // with tampered payload fields (e.g. shares=99 instead of 5) must be
    // rejected by isExistingTapeAuthentic. Otherwise an attacker who
    // rewrites the tape after a legit settlement could arithmetic-bomb a
    // downstream chart (shares=Number.MAX_SAFE_INTEGER etc.).
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f1b');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    const realNow = Date.now.bind(Date);
    let clock = 1000;
    Date.now = () => clock;

    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);
    useIdentity(SEED_BOB);
    clock = 1050;
    acceptFloorOffer(offer.offerId, 'Bob');

    // Attacker names the RIGHT taker (Bob) but tampers the shares field.
    const tampered: FloorTape = {
      v: 1,
      offerId: offer.offerId,
      ventureId: offer.ventureId,
      kind: 'SELL',
      shares: 99,                // MISMATCH (offer is 5)
      priceMojo: 0,
      makerPub: PUB_ALICE,
      takerPub: PUB_BOB,
      settledAt: 1050,
    };
    doc.getMap('tradingFloor').set(`tape:${offer.offerId}`, tampered);

    useIdentity(SEED_FOUNDER);
    clock = 1100;
    const r = reconcileTradingFloor();
    Date.now = realNow;

    // Even though `takerPub` matches, the shares payload doesn't — refuse.
    const v = ventureRecord()!;
    expect(v.shares[PUB_ALICE]).toBe(40);
    expect(v.shares[PUB_BOB]).toBe(30);
    expect(r.refusedOfferIds).toContain(offer.offerId);
    expect(r.settledOfferIds).not.toContain(offer.offerId);
  });
});

describe('audit #68 round-2 finding 2 regression — backdated FloorAccept cannot rob the legit canonical winner', () => {
  it("Eve's backdated accept (acceptedAt=0) is ignored; Bob's settled shares stay put", () => {
    // SCENARIO — Alice posts SELL 5 at t=1000. Bob legit-accepts at t=1050.
    // Founder reconciles → Alice→Bob 5, tape=Bob. Attacker Eve then signs
    // her OWN FloorAccept with acceptedAt=0 (BEFORE the offer existed) and
    // writes it under her per-taker slot. Pre-fix, pickCanonicalAccept
    // picked Eve (earliest acceptedAt wins) and the reconcile corrective
    // path moved shares from Bob → Eve (Bob=30, Eve=5). Fix: reconcile now
    // filters through isAcceptInWindow before pickCanonicalAccept — Eve's
    // backdated accept is treated as absent and Bob remains canonical.
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f2');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    const realNow = Date.now.bind(Date);
    let clock = 1000;
    Date.now = () => clock;

    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);
    useIdentity(SEED_BOB);
    clock = 1050;
    acceptFloorOffer(offer.offerId, 'Bob');

    useIdentity(SEED_FOUNDER);
    clock = 1100;
    const first = reconcileTradingFloor();
    expect(first.settledOfferIds).toContain(offer.offerId);
    const vAfterLegit = ventureRecord()!;
    expect(vAfterLegit.shares[PUB_ALICE]).toBe(35);
    expect(vAfterLegit.shares[PUB_BOB]).toBe(35);
    expect(readTapeFor(offer.offerId)?.takerPub).toBe(PUB_BOB);

    // ATTACKER — Eve signs her own accept with acceptedAt=0. Any peer can
    // sign for their own key; the shape gate (Number.isFinite(0)) and
    // signature verification both pass. The `Date.now() >= expiresAt` gate
    // in acceptFloorOffer is unaffected — the offer expires ~7d in the
    // future, and 0 is far below that.
    useIdentity(SEED_EVE);
    clock = 0;
    const evilOk = acceptFloorOffer(offer.offerId, 'Eve');
    expect(evilOk).toBe(true);

    // Verify Eve's accept actually landed (the attack setup is real, not a
    // no-op) — read it back off the map directly.
    const evilAccept = doc.getMap('tradingFloor').get(`accept:${offer.offerId}:${PUB_EVE}`) as FloorAccept | undefined;
    expect(evilAccept).toBeTruthy();
    expect(evilAccept!.acceptedAt).toBe(0);

    useIdentity(SEED_FOUNDER);
    clock = 1200;
    const r = reconcileTradingFloor();
    Date.now = realNow;

    const v = ventureRecord()!;
    // THEFT-BLOCKED — Bob remains the canonical winner. Eve's backdated
    // accept is filtered out by isAcceptInWindow, so pickCanonicalAccept
    // never sees it and the corrective path does not fire.
    expect(v.shares[PUB_ALICE]).toBe(35);
    expect(v.shares[PUB_BOB]).toBe(35);
    expect(v.shares[PUB_EVE] ?? 0).toBe(0);
    const tape = readTapeFor(offer.offerId);
    expect(tape).not.toBeNull();
    expect(tape!.takerPub).toBe(PUB_BOB);
    // No refusal — the offer already settled canonically to Bob; the
    // reconcile pass after Eve's attack is idempotent.
    expect(r.refusedOfferIds).not.toContain(offer.offerId);

    // Cap-table conservation.
    let sum = 0;
    for (const n of Object.values(v.shares)) sum += n;
    expect(sum).toBe(CHARTER_TOTAL_SHARES);
  });

  it("Eve's forward-dated accept (acceptedAt beyond expiresAt) is ignored too", () => {
    // Symmetric upper-bound check — isAcceptInWindow's `< offer.expiresAt`
    // clause mirrors the existing `o.expiresAt <= winner.acceptedAt` guard
    // in reconcile. An accept with acceptedAt >= expiresAt cannot bind the
    // maker's offer; it must not become the canonical winner either.
    // acceptFloorOffer's own `Date.now() >= expiresAt` gate blocks the WRITE
    // when the wall clock is that late, so we build the signed accept by
    // hand (mirroring the module's acceptSignBytes) and drop it into the
    // slot directly.
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f2b');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    const realNow = Date.now.bind(Date);
    let clock = 1000;
    Date.now = () => clock;

    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0, ttlMs: 60_000 })!;
    postFloorOffer(offer);
    useIdentity(SEED_BOB);
    clock = 1050;
    acceptFloorOffer(offer.offerId, 'Bob');

    // Forward-dated attack: acceptedAt = offer.expiresAt (the outer bound;
    // isAcceptInWindow's strict `<` rejects this).
    const evilAccept = buildSignedAccept(
      offer.offerId, offer.ventureId, PUB_EVE, 'Eve',
      offer.expiresAt, SEED_EVE,
    );
    doc.getMap('tradingFloor').set(`accept:${offer.offerId}:${PUB_EVE}`, evilAccept);

    clock = offer.createdAt + 100;
    useIdentity(SEED_FOUNDER);
    const r = reconcileTradingFloor();
    Date.now = realNow;

    const v = ventureRecord()!;
    // Bob wins canonically — Eve's out-of-window accept doesn't touch the
    // ledger. Bob's legit trade settles as normal.
    expect(v.shares[PUB_ALICE]).toBe(35);
    expect(v.shares[PUB_BOB]).toBe(35);
    expect(v.shares[PUB_EVE] ?? 0).toBe(0);
    expect(r.settledOfferIds).toContain(offer.offerId);
  });
});

describe('audit #68 round-2 finding 3 regression — scheduleReconcileTradingFloor + cancelScheduledReconcile', () => {
  // Round-2 finding 3 flagged that the debouncer helpers were exported but
  // had no direct test. These probes exercise both entry points end-to-end
  // via vitest fake timers so any future regression to clearTimeout
  // handling, quiescence window, or observer wiring fails loudly here.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    cancelScheduledReconcile();
    vi.useRealTimers();
  });

  it('collapses a burst of schedule() calls into ONE post-quiescence reconcile', () => {
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f3');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    vi.setSystemTime(1000);
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);

    vi.setSystemTime(1050);
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');

    // Pre-debounce: reconcile hasn't fired, cap table unchanged.
    let v = ventureRecord()!;
    expect(v.shares[PUB_ALICE]).toBe(40);
    expect(v.shares[PUB_BOB]).toBe(30);

    // Burst: five schedule() calls — each resets the trailing-edge timer.
    // Every schedule() clears the pending timer and installs a new one, so
    // only the LAST timer survives; if reconcile fired on every call the
    // ledger would show Bob=35 right after the very first schedule.
    useIdentity(SEED_FOUNDER);
    scheduleReconcileTradingFloor();
    scheduleReconcileTradingFloor();
    scheduleReconcileTradingFloor();
    scheduleReconcileTradingFloor();
    scheduleReconcileTradingFloor();

    // Just short of the quiescence window — no reconcile has fired yet.
    vi.advanceTimersByTime(RECONCILE_QUIESCENCE_MS - 1);
    v = ventureRecord()!;
    expect(v.shares[PUB_ALICE]).toBe(40);
    expect(v.shares[PUB_BOB]).toBe(30);
    expect(readTapeFor(offer.offerId)).toBeNull();

    // Cross the delay — reconcile fires ONCE and settles Bob.
    vi.advanceTimersByTime(2);
    v = ventureRecord()!;
    expect(v.shares[PUB_ALICE]).toBe(35);
    expect(v.shares[PUB_BOB]).toBe(35);
    expect(readTapeFor(offer.offerId)?.takerPub).toBe(PUB_BOB);
  });

  it('cancelScheduledReconcile prevents a pending scheduled reconcile from firing', () => {
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f3b');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    vi.setSystemTime(1000);
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);

    vi.setSystemTime(1050);
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');

    useIdentity(SEED_FOUNDER);
    scheduleReconcileTradingFloor();
    cancelScheduledReconcile();
    // Advance FAR beyond the quiescence window — a broken cancel would let
    // reconcile fire and change the cap table.
    vi.advanceTimersByTime(RECONCILE_QUIESCENCE_MS * 10);

    let v = ventureRecord()!;
    expect(v.shares[PUB_ALICE]).toBe(40);
    expect(v.shares[PUB_BOB]).toBe(30);
    expect(readTapeFor(offer.offerId)).toBeNull();

    // Sanity: the synchronous reconcile still works after a cancel, so
    // cancelScheduledReconcile only kills the pending TIMER, not the
    // engine.
    const r = reconcileTradingFloor();
    expect(r.settledOfferIds).toContain(offer.offerId);
    v = ventureRecord()!;
    expect(v.shares[PUB_BOB]).toBe(35);
  });

  it('cancelScheduledReconcile is a safe no-op when nothing is scheduled', () => {
    // The clearTimeout branch inside cancelScheduledReconcile is gated on
    // `reconcileTimer !== null` — repeated / spurious cancels must not
    // throw or alter engine state.
    expect(() => cancelScheduledReconcile()).not.toThrow();
    expect(() => cancelScheduledReconcile()).not.toThrow();
  });

  it('observer wiring: subscribeTradingFloor -> schedule -> reconcile fires post-quiescence', () => {
    // The T0 seam wires `subscribeTradingFloor(() =>
    // scheduleReconcileTradingFloor())` in main.ts. This test mimics that
    // wiring end-to-end: a floor write fires the observer, which schedules
    // reconcile, which fires after quiescence. Any regression that unhooks
    // the observer or breaks the schedule() plumbing shows up here.
    const doc = new Y.Doc();
    useIdentity(SEED_FOUNDER);
    bindVentures(doc);
    bindTradingFloor(doc);
    foundVenture('Test Co', PUB_FOUNDER, 'Founder', 'room-r2f3d');
    transferShares(PUB_FOUNDER, PUB_ALICE, 'Alice', 40);
    transferShares(PUB_FOUNDER, PUB_BOB, 'Bob', 30);

    const unsub = subscribeTradingFloor(() => { scheduleReconcileTradingFloor(); });

    vi.setSystemTime(1000);
    useIdentity(SEED_ALICE);
    const offer = makeFloorOffer('SELL', 'Alice', 5, { priceMojo: 0 })!;
    postFloorOffer(offer);
    // The offer write fires the observer, which schedules a reconcile;
    // the debouncer collapses any subsequent writes to one trailing call.

    vi.setSystemTime(1050);
    useIdentity(SEED_BOB);
    acceptFloorOffer(offer.offerId, 'Bob');

    // Still inside the quiescence window — no settlement yet.
    vi.advanceTimersByTime(RECONCILE_QUIESCENCE_MS - 1);
    let v = ventureRecord()!;
    expect(v.shares[PUB_BOB]).toBe(30);

    // Cross the window — the trailing scheduled reconcile fires and settles.
    vi.advanceTimersByTime(2);
    v = ventureRecord()!;
    expect(v.shares[PUB_ALICE]).toBe(35);
    expect(v.shares[PUB_BOB]).toBe(35);
    expect(readTapeFor(offer.offerId)?.takerPub).toBe(PUB_BOB);

    unsub();
  });
});

// ── Helpers for the backdated-accept probe ─────────────────────────────────
//
// The main test file uses `useIdentity` to swap in a signing key, then calls
// `acceptFloorOffer` — but the round-2 upper-bound probe needs a HANDCRAFTED
// signed accept with an arbitrary `acceptedAt`, so we mirror the module's
// canonical sign-bytes here and produce a valid FloorAccept directly. Kept
// LOCAL so a future rename inside tradingFloorDoc.ts breaks THIS file too
// and the regression stays honest.
function buildSignedAccept(
  offerId: string,
  ventureId: string,
  takerPub: string,
  takerName: string,
  acceptedAt: number,
  takerSeed: Uint8Array,
): FloorAccept {
  const bytes = new TextEncoder().encode(JSON.stringify({
    k: 'ssf-floor-accept:v1',
    offerId,
    ventureId,
    takerPub,
    takerName,
    acceptedAt,
  }));
  const sigBytes = ed.sign(bytes, takerSeed);
  return {
    v: 1,
    offerId,
    ventureId,
    takerPub,
    takerName,
    acceptedAt,
    sig: b64urlEncode(sigBytes),
  };
}
