/**
 * 🎰 `stands` map binding — CRDT-backed occupancy for table standing slots
 * (#76), SIGNED per record (PR #126 review).
 *
 * The room doc carries a `stands` Y.Map keyed by StandSlot.id
 * (`${itemId}:s${n}`, minted in furniture.ts buildStandList). Each value is a
 * plain-JSON StandClaim { pub, at, sig } (see standClaims.ts) — no nested Y
 * types, matching the players/games/casino contract.
 *
 * WHY A MAP AT ALL. STANDS was already conflict-safe within one client, but
 * two peers walking up at the same instant saw the same "free" slot in their
 * local proximity check and both landed on it. A doc-backed claim gives Yjs
 * the last word: per-key LWW picks exactly ONE winner on every replica, and
 * the loser's next pickStandForWalkup sees the claim and picks the next
 * open slot.
 *
 * SINGLE-WRITER-PER-KEY DISCIPLINE. Each claim key is written by exactly one
 * client — the identity claiming it (heartbeat renewal is the same identity,
 * a fresh signature each time), or the REAPER on any client (deletion only,
 * never a fresh write). The heartbeat pattern makes the write cadence
 * explicit: the holder rewrites the same shape every STAND_CLAIM_HEARTBEAT_MS
 * to keep the TTL alive.
 *
 * SIGNING SEAM (pattern: doorPolicy.ts #129, treasuryDoc.ts). This module
 * owns no key material and never decodes a pub or a sig. main.ts injects, at
 * bind time:
 *   roomId    — the joined room; part of every signed byte string.
 *   verifySig — (pub, bytes, sig) => boolean  (keypair.verifyIdentity).
 *   localPub  — () => the local identity pub  (keypair.getIdentityPub).
 *   sign      — (bytes) => sig | null         (keypair.signIdentity, wrapped).
 * Tests inject @noble hex equivalents and the module cannot tell the
 * difference — the encoding is the injector's business.
 *
 * VERIFY ON READ, FAIL CLOSED. readStandClaim / readAllStandClaims run every
 * value through one ladder: isStandClaim (shape; `at` must be a safe integer
 * so canonicalEncode can never throw on a read) → verifySig over
 * standClaimSignatureBytes(boundRoomId, MAP KEY, record) → then the caller's
 * own isClaimActive / canPlayerClaim. The bytes are rebuilt over the map KEY
 * the record sits under and the room this binding is for — never over
 * anything the record says about itself — so a record lifted to another slot
 * key or another room fails here, as does a record naming a pub whose key the
 * writer does not hold. Anything that fails is "no claim". With NO verifier
 * wired every record is refused (one console.warn per bind, on the first
 * refusal): a claim is never trusted unverified. Unsigned records are refused
 * outright — this map is new in the same PR, so there is no legacy to honour
 * (contrast doorPolicy's pre-D3 fallback).
 *
 * VERIFICATION IS MEMOISED. An Ed25519 verify costs ~3 ms in pure JS
 * (measured with @noble/ed25519 on Node 24), the reap sweep re-reads the
 * whole map every STAND_CLAIM_REAP_MS, and pickFreeStand consults claims per
 * slot — unmemoised, a room with a few dozen claims would stall the frame
 * loop every sweep. Results are cached per exact (slotId, pub, at, sig): a
 * JSON-array key, so a hostile slot id can never forge a delimiter collision.
 * A record is verified once per distinct write, positive OR negative (a
 * planted bad signature is not re-verified every sweep); a heartbeat (new
 * `at`, new sig) is a new record. The cache is pruned to the live entries on
 * every full read, so it never outgrows the map — plus a hard cap as
 * belt-and-braces against a peer churning records under one key between
 * sweeps — and it resets on every bind, because results are scoped to
 * (doc, roomId, verifier).
 *
 * WRITES ARE SELF-CHECKED. claimStand signs with the injected signer and then
 * verifies its own record with the injected verifier BEFORE writing. A record
 * our own reader would refuse (signer/verifier encoding mismatch, no identity
 * yet, signer threw) is never written — the call returns null and warns once
 * per bind — because a claim only its writer could see would still read as
 * "free" to every peer, which is exactly the double-booking this map exists
 * to prevent. The caller (world.ts) walks up unclaimed in that case, the
 * legacy-peer posture the proximity filter already covers.
 *
 * RECOVERY OF A DROPPED PEER'S SLOT (audit-honest, finding #3). Two paths open
 * a stale slot back up:
 *   1. The WALK-UP PATH (primary): pickStandForWalkup's canPlayerClaim
 *      stale-clause treats any claim past STAND_CLAIM_TTL_MS as claimable,
 *      independent of the online-pub provider. A new walker lands on the
 *      slot and their claimStand overwrites the stale entry via LWW. This is
 *      the mechanism that actually reclaims a departed peer's slot today.
 *   2. The REAP SWEEP (safety net): findExpiredClaims removes a stale claim
 *      only when its holder's pub is ALSO not in the online set. In this
 *      build the players Y.Map is append-only (main.ts has no players.delete
 *      call site — leaveRoom destroys only the local doc, so every other
 *      replica still sees the departed peer in `players`). That makes the
 *      reap safe (it never deletes a currently-online peer's slot) but
 *      largely a no-op for a real disconnect — it effectively fires only for
 *      peers whose entry never made it to another replica, or for claims
 *      from a local offline session (the local pub is added by world.ts as
 *      belt-and-braces so a solo player never reaps their own slot). A
 *      future graceful-leave path that calls players.delete would make the
 *      reap sweep meaningful; until then, path (1) is the load-bearing one.
 *
 * REBIND PER JOIN (T0 seam) + OPTION SEMANTICS. leaveRoom destroys the Y.Doc;
 * main.ts's joinRoomAtEpoch calls bindStandsDoc(sync.doc, { … }) beside the
 * other bindings. EVERY option follows the partial-rebind rule: a key
 * PRESENT in the options bag replaces the previous value, a key ABSENT keeps
 * it, an explicit `undefined` clears it. So the OFFLINE FALLBACK rebind
 * (ensureMap → bindStandsDoc(new Y.Doc()) with no options) keeps the signer
 * and verifier main.ts wired at the last join, and practice claims in a
 * page-local doc stay signed and readable; a later real join rebinds with a
 * fresh roomId and the practice claims vanish with the local doc.
 *
 * ONLINE-PUB PROVIDER. The reap sweep needs the identity pubs of everyone
 * present (a live-but-quiet peer keeps their slot). main.ts registers a
 * provider that maps the room doc's `players` entries to their `keyB64` —
 * pubs, because that is what a claim carries; a set of player ids would
 * never match and every quiet peer would read as reapable. The provider is
 * NOT verified (a peer can plant a `players` entry with any keyB64): the set
 * only ever PROTECTS a stale claim from the reap, and a protected stale claim
 * is still reclaimable through path (1) above, so a forged entry buys
 * nothing. Tests can bind without a provider and the fallback returns an
 * empty set (every stale claim is reapable — the pure engine's expected
 * input).
 */

import * as Y from 'yjs';
import { isStandClaim, standClaimSignatureBytes } from './standClaims';
import type { StandClaim } from './standClaims';

/** Signature verifier — (pub, bytes, sig) => valid. Encoding-agnostic. */
export type StandSigVerifier = (pub: string, bytes: Uint8Array, sig: string) => boolean;

/** Signer for the LOCAL identity — bytes => sig, or null when it cannot sign. */
export type StandSigner = (bytes: Uint8Array) => string | null;

let boundDoc: Y.Doc | null = null;
let standsMap: Y.Map<unknown> | null = null;

/** Room every signature is scoped to; '' until main.ts binds a real join. */
let boundRoomId = '';
let verifier: StandSigVerifier | null = null;
let localPubReader: (() => string | null) | null = null;
let signer: StandSigner | null = null;

/**
 * Optional provider for the currently-online identity-pub set — supplied by
 * main.ts at bind time so the reap sweep can consult the room doc's
 * `players` map without a window back-channel (former `__ssfDoc` coupling).
 * Null in tests / offline fallback → reap treats every expired claim as
 * reapable, which is what the pure engine tests want.
 */
let onlinePubsProvider: (() => Set<string>) | null = null;

/** Verify-result memo: JSON [slotId, pub, at, sig] → verified? (see header). */
let verifyCache = new Map<string, boolean>();

/**
 * Hard cap on memo entries. The generational prune in readAllStandClaims is
 * the real bound (the memo never outgrows the live map across a sweep); this
 * only guards the window between sweeps against a peer churning thousands of
 * distinct records under one key. Clearing costs one re-verify per live
 * record — acceptable, and only reachable under attack.
 */
const VERIFY_CACHE_MAX = 4096;

let warnedNoVerifier = false;
let warnedCannotSign = false;

/**
 * Options bag for bindStandsDoc. Every key is optional and every key follows
 * the same partial-rebind rule (present ⇒ replace, absent ⇒ keep, explicit
 * undefined ⇒ clear) — see the module header.
 */
export interface StandsDocOptions {
  /** Room id the doc belongs to; scoped into every signature. */
  roomId?: string;
  /** Verifier for peers' records (browser: keypair.verifyIdentity). */
  verifySig?: StandSigVerifier;
  /** The local identity pub — the `pub` every local claim is written under. */
  localPub?: () => string | null;
  /** Signer for the local identity (browser: keypair.signIdentity, wrapped). */
  sign?: StandSigner;
  /**
   * Snapshot of currently-online identity pubs (the room doc's `players`
   * entries' keyB64, usually). Called each reap sweep — copy-free callers
   * may reuse a scratch Set as long as it's fresh per call. Omit in unit
   * tests.
   */
  getOnlinePubs?: () => Set<string>;
}

function docAlive(): boolean {
  return boundDoc !== null
    && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

/**
 * Bind (or re-bind) the stands map to a room doc. Called from main.ts
 * joinRoomAtEpoch in the no-awaits zone; also self-called with a local doc
 * as the offline fallback. Observers on the PREVIOUS doc died with it
 * (doc.destroy() in leaveRoom) — nothing to detach here.
 *
 * Option semantics (all keys alike): a key present in `opts` REPLACES the
 * previous value; a key absent KEEPS it (a rebind for the same room, or the
 * offline fallback, can skip re-plumbing); an explicit `undefined` CLEARS it
 * (dev / test teardown). The verify memo always resets — its results are
 * scoped to the (doc, roomId, verifier) triple that just changed.
 */
export function bindStandsDoc(doc: Y.Doc, opts?: StandsDocOptions): void {
  boundDoc = doc;
  standsMap = doc.getMap('stands');
  if (opts !== undefined) {
    if ('roomId' in opts) boundRoomId = opts.roomId ?? '';
    if ('verifySig' in opts) verifier = opts.verifySig ?? null;
    if ('localPub' in opts) localPubReader = opts.localPub ?? null;
    if ('sign' in opts) signer = opts.sign ?? null;
    if ('getOnlinePubs' in opts) onlinePubsProvider = opts.getOnlinePubs ?? null;
  }
  verifyCache = new Map<string, boolean>();
  warnedNoVerifier = false;
  warnedCannotSign = false;
}

/** Bound map, lazily falling back to a page-local doc (offline practice). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !standsMap) bindStandsDoc(new Y.Doc());
  return standsMap!;
}

/**
 * The identity pub every local claim is written under — the ONE value
 * world.ts compares claims against (heartbeat, release guard, tier sort), so
 * "is this claim mine" and "who did I sign as" can never drift apart. Null
 * when no identity is bound (tests, or before the first join); a throwing
 * reader is logged and treated the same, so the world loop never breaks on
 * it.
 */
export function localStandPub(): string | null {
  if (!localPubReader) return null;
  try {
    return localPubReader() || null;
  } catch (err) {
    console.error('[stands] local-pub reader threw:', err);
    return null;
  }
}

/**
 * Snapshot of currently-online identity pubs for the reap sweep. Returns an
 * empty set when no provider is registered — safe for tests (nobody
 * "online", so every stale claim reaps), and the world reap adds the local
 * pub itself as a belt-and-braces so a solo player never reaps their own
 * slot even during offline fallback.
 */
export function getOnlinePubs(): Set<string> {
  if (!onlinePubsProvider) return new Set<string>();
  try {
    return onlinePubsProvider();
  } catch (err) {
    console.error('[stands] online-pubs provider threw:', err);
    return new Set<string>();
  }
}

/** Memo key — a JSON array, so no field can forge a delimiter collision. */
function cacheKey(slotId: string, claim: StandClaim): string {
  return JSON.stringify([slotId, claim.pub, claim.at, claim.sig]);
}

/** Record a verify result, honouring the hard cap (see VERIFY_CACHE_MAX). */
function remember(key: string, ok: boolean): void {
  if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.clear();
  verifyCache.set(key, ok);
}

/**
 * The read ladder for one raw map value found under `slotId`: shape guard →
 * memoised signature check over the MAP KEY + bound room → the claim, or
 * null for anything that fails. `seen` (readAllStandClaims) collects the memo
 * keys of every live record so the memo can be pruned to them afterwards.
 */
function verifiedClaim(
  slotId: string,
  value: unknown,
  seen?: Set<string>,
): StandClaim | null {
  if (!isStandClaim(value)) return null;
  if (verifier === null) {
    // Fail closed. Nothing verifies, so nothing is a claim — said once per
    // bind so an un-wired binding is loud in the console, not silent.
    if (!warnedNoVerifier) {
      warnedNoVerifier = true;
      console.warn(
        '[stands] no signature verifier bound — every stand claim reads as absent until bindStandsDoc wires verifySig',
      );
    }
    return null;
  }
  const key = cacheKey(slotId, value);
  seen?.add(key);
  const hit = verifyCache.get(key);
  if (hit !== undefined) return hit ? value : null;
  let ok = false;
  try {
    // Bytes over the KEY's slot id and OUR room — never the record's word.
    ok = verifier(value.pub, standClaimSignatureBytes(boundRoomId, slotId, value), value.sig) === true;
  } catch {
    ok = false;
  }
  remember(key, ok);
  return ok ? value : null;
}

/** One slot's VERIFIED claim, or null (empty / malformed / unverifiable). */
export function readStandClaim(slotId: string): StandClaim | null {
  return verifiedClaim(slotId, ensureMap().get(slotId));
}

/**
 * Every verified claim in the map, as slotId → claim. Used by
 * pickStandForWalkup (whole snapshot per walk-up so the tier ordering sees a
 * consistent view) and the reap sweep. Filters malformed and unverifiable
 * values silently — the doc can carry anything a peer decided to plant, and
 * none of it should crash the walk-up.
 *
 * Also the memo's generation boundary: after the pass, results for records
 * no longer in the map are dropped, so the memo tracks the live map's size.
 */
export function readAllStandClaims(): Map<string, StandClaim> {
  const out = new Map<string, StandClaim>();
  const map = ensureMap();
  const seen = new Set<string>();
  map.forEach((value, key) => {
    const claim = verifiedClaim(key, value, seen);
    if (claim) out.set(key, claim);
  });
  for (const key of verifyCache.keys()) {
    if (!seen.has(key)) verifyCache.delete(key);
  }
  return out;
}

/** Once-per-bind refusal notice for an unsignable write; always returns null. */
function cannotSign(why: string): null {
  if (!warnedCannotSign) {
    warnedCannotSign = true;
    console.warn(`[stands] cannot post a signed stand claim (${why}) — walking up without a claim`);
  }
  return null;
}

/**
 * Transacted whole-value write of one SIGNED claim for the local identity
 * (LWW per slot key). Signs standClaimSignatureBytes(boundRoomId, slotId,
 * { pub, at }) with the injected signer, verifies the result with the
 * injected verifier (a record our own reader would refuse is never written —
 * see WRITES ARE SELF-CHECKED in the header), then writes. Returns the claim
 * that was written so the caller can cache the write clock for its own
 * bookkeeping (heartbeat scheduler in world.ts), or null when this client
 * cannot produce a verifiable claim — the caller walks up unclaimed.
 *
 * The self-check result is seeded into the memo, so the heartbeat's next
 * read of its own slot costs nothing.
 *
 * The transact keeps the observer notification atomic — one write, one
 * fan-out — mirroring writeGame / writeChips.
 */
export function claimStand(slotId: string, at: number): StandClaim | null {
  const map = ensureMap();
  const pub = localStandPub();
  if (!pub) return cannotSign('no local identity bound');
  if (!signer) return cannotSign('no signer bound');
  if (!verifier) return cannotSign('no verifier bound');
  let claim: StandClaim;
  try {
    const bytes = standClaimSignatureBytes(boundRoomId, slotId, { pub, at });
    const sig = signer(bytes);
    if (!sig) return cannotSign('signer returned no signature');
    claim = { pub, at, sig };
    if (verifier(pub, bytes, sig) !== true) {
      return cannotSign('own record fails local verification — signer and verifier disagree');
    }
  } catch (err) {
    return cannotSign(`signing threw: ${String(err)}`);
  }
  remember(cacheKey(slotId, claim), true);
  boundDoc!.transact(() => {
    map.set(slotId, claim);
  });
  return claim;
}

/**
 * Release one slot — deletes the key so pickStandForWalkup treats the slot as
 * empty on every replica. No-op when the slot is already empty. Only the
 * holder should call this in normal flow (world.ts guards with
 * shouldReleaseSlot against the current VERIFIED claim); the reaper uses the
 * same delete for stale claims from crashed peers.
 */
export function releaseStand(slotId: string): void {
  const map = ensureMap();
  if (!map.has(slotId)) return;
  boundDoc!.transact(() => {
    map.delete(slotId);
  });
}

/**
 * Batch-delete a list of stale slot ids in one transaction — the reaper's
 * write shape. One transact keeps the observer fan-out down to a single
 * notify per sweep even when several claims expire together.
 */
export function reapExpiredClaims(slotIds: readonly string[]): void {
  if (slotIds.length === 0) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    for (const id of slotIds) {
      if (map.has(id)) map.delete(id);
    }
  });
}
