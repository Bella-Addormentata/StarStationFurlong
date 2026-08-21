/**
 * Trading Floor — venture-share offer book with deterministic settlement
 * (#68 V4 — the wall-screen trading terminal at a venture's registered office).
 *
 * WHAT IT IS (plain-language rule from #68 — HARD): players see OFFER,
 * SHARES, VENTURE, REGISTRY. No NFT / CAT / mint / token / on-chain — those
 * words never touch the surface. This module speaks the same language: a
 * SELL OFFER stakes shares for a price; a BUY OFFER stakes intent to acquire;
 * ACCEPTING settles the trade and updates the cap table.
 *
 * WHERE IT LIVES: the OFFICE room's Y.Doc, on a dedicated map
 * `doc.getMap('tradingFloor')`. Bound at the T0 seam alongside `bindVentures`
 * and `bindOffers`. Every write is signed and shape-checked on read; hostile
 * peer writes degrade to "not there", never to arithmetic authority.
 *
 * CONFLICT-SAFETY (the reason this module exists rather than
 * "acceptOffer() → transferShares()"):
 *
 *   Naive path — two peers accept the same SELL offer simultaneously,
 *   each writes `venture.v` in one transact. Yjs merges via LWW: exactly
 *   one of the two `venture.v` rewrites wins, and NOTHING guarantees it
 *   agrees with which taker's "accept" mark won under the SAME LWW race.
 *   Result: cap table and accept mark can disagree; a peer replaying its
 *   own leg last "wins" a trade another peer's cap table shows differently.
 *   Shares can transiently duplicate or vanish across peers.
 *
 *   This module — every taker's acceptance lives in its OWN per-taker key
 *   (`accept:<offerId>:<takerPub>`; single-writer-per-key), so CRDT merge
 *   preserves the FULL SET of accepts across every peer. `pickCanonical
 *   Accept()` is a pure reducer (smallest acceptedAt, tie-break lex-smallest
 *   takerPub) so every peer independently picks the SAME winner. The cap
 *   table write is not a race — it is a deterministic FUNCTION of the
 *   merged offer/accept/cancel/tape state, applied by
 *   `reconcileTradingFloor()`. Every peer computes the same target and
 *   writes it; the LWW race becomes a race between IDENTICAL writes.
 *
 * FORWARD-COMPAT WITH V3 (Registry anchor): every record is shaped so a
 * future Chia offer file can carry the same fields — offerId, ventureId,
 * kind (SELL/BUY), shares, priceMojo, makerPub, expiresAt, nonce. When V3
 * replaces settlement with an on-chain swap, this screen keeps rendering
 * the same offer/tape rows; only the settlement lane moves.
 *
 * V4 SCOPE — offers over SHARES only (deed offers keep the person-to-person
 * flow from offers.ts). Prices carry as `priceMojo` (integer for exact
 * arithmetic and Chia-mojo parity) but v1 SETTLEMENT still requires
 * priceMojo === 0 (gift) — the settlement rail arrives with the Registry.
 * Non-zero priced offers ROUND-TRIP and DISPLAY on the board so the price
 * chart has data to show; they refuse to settle until V3.
 *
 * See brainstorming/chia-ventures-shared-ownership.md for the full plan
 * and the offers-as-market-primitive rationale.
 */

import * as Y from 'yjs';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';
import {
  ventureRecord,
  isOfficeHere,
  transferShares,
  CHARTER_TOTAL_SHARES,
  type VentureRecord,
} from './ventures';

// ── Types (shape-first: what a peer sees on the wire) ────────────────────────

/** SELL: maker stakes shares they hold, offering them at priceMojo per share.
 *  BUY:  maker stakes intent to buy at priceMojo per share; a shareholder
 *        ACCEPTS by parting with the shares.
 *
 *  These strings never appear in UI copy — the surface reads "SELL" / "BUY".
 *  The wire tag is stable for storage/interop; the display copy is free. */
export type FloorOfferKind = 'SELL' | 'BUY';

/** A trading-floor offer — signed by the maker over canonical bytes.
 *
 *  V3-COMPAT NOTE: `offerId` is a hex-32 random id (no correlation with any
 *  chain artifact). When V3 lands, this same shape carries a Chia offer-file
 *  hash in the same slot with zero UX change. */
export interface FloorOffer {
  v: 1;
  kind: FloorOfferKind;
  offerId: string;         // 32 hex chars (16 random bytes)
  ventureId: string;       // stable venture id (matches ventureRecord().id)
  ventureName: string;     // display copy (signed so a doctored preview can't rename)
  makerPub: string;        // Ed25519 identity of the maker (base64url)
  makerName: string;       // display copy (signed)
  shares: number;          // integer > 0; ≤ CHARTER_TOTAL_SHARES
  priceMojo: number;       // integer ≥ 0; v1 settlement requires 0 (gift)
  createdAt: number;       // maker wall-clock (used for chart x-axis fallback)
  expiresAt: number;       // required — dead offers stop the board
  sig: string;             // maker signature (base64url)
}

/** A taker's acceptance of an offer — signed by the taker over canonical
 *  bytes that include the offerId (so an accept can't be replayed against
 *  a different offer). ONE per (offerId, takerPub): the CRDT slot is per-
 *  taker, so hostile fan-out into other taker slots is impossible. */
export interface FloorAccept {
  v: 1;
  offerId: string;
  ventureId: string;       // redundant but signed — cross-doc safety
  takerPub: string;
  takerName: string;
  acceptedAt: number;      // taker wall-clock — canonical-pick ordering
  sig: string;
}

/** Maker cancellation. Precedes-canonical-accept comparison decides who wins:
 *  a cancel timestamped BEFORE the canonical accept invalidates the offer;
 *  a cancel timestamped AFTER is too late (the trade settles). Timestamps are
 *  advisory (peer clocks drift), but the comparison is pure — every peer
 *  agrees on the outcome from the merged record set alone. */
export interface FloorCancel {
  v: 1;
  offerId: string;
  makerPub: string;        // must equal the offer's makerPub
  cancelledAt: number;
  sig: string;
}

/** A completed trade — written as a byproduct of reconciliation. This is the
 *  price-history feed the wall screen charts from. WRITE-ONCE per offerId:
 *  every peer computes the identical tape entry and races IDENTICAL writes. */
export interface FloorTape {
  v: 1;
  offerId: string;
  ventureId: string;
  kind: FloorOfferKind;
  shares: number;
  priceMojo: number;
  makerPub: string;
  takerPub: string;
  settledAt: number;       // taker's acceptedAt (deterministic across peers)
}

// ── Constants ────────────────────────────────────────────────────────────────

export const FLOOR_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
/** Marks older than expiry + grace are swept on write to keep the map small. */
const FLOOR_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000;             // 30 days
/** Cap on offer/tape entries returned to the UI — the board and chart both
 *  virtualise-visually by trimming here, not by paginating downstream. */
const FLOOR_LIST_CAP = 500;

// ── Module doc binding (matches ventures.ts / offers.ts pattern) ─────────────

let boundDoc: Y.Doc | null = null;
let floorMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy first — a listener that unsubscribes mid-emit must not skip its peers.
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[tradingFloor] listener threw:', e); }
  }
}

/** Bind the CURRENT room doc. Trading floor lives only at the office (the
 *  authoritative cap table) — the UI gates its BUY/SELL/CANCEL buttons to
 *  isOfficeHere(); the board still renders on a link so shareholders can
 *  see what's on the market anywhere they visit. */
export function bindTradingFloor(doc: Y.Doc): void {
  boundDoc = doc;
  floorMap = doc.getMap('tradingFloor');
  floorMap.observe(() => notify());
  notify();
}

export function subscribeTradingFloor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null
    && !(boundDoc as { isDestroyed?: boolean }).isDestroyed
    && floorMap !== null;
}

function map(): Y.Map<unknown> | null {
  return docAlive() ? floorMap : null;
}

// ── Canonical sign-bytes (domain-tagged, versioned, explicit key order) ──────

// The domain tags MUST be distinct across offer/accept/cancel — a taker's
// signature must not be reusable as a maker's, and vice versa. `?? null` on
// BOTH sign and verify mirrors the offers.ts recipe (missing ≡ null).

function offerSignBytes(o: Omit<FloorOffer, 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    k: 'ssf-floor-offer:v1',
    kind: o.kind,
    offerId: o.offerId,
    ventureId: o.ventureId,
    ventureName: o.ventureName,
    makerPub: o.makerPub,
    makerName: o.makerName,
    shares: o.shares,
    priceMojo: o.priceMojo,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
  }));
}

function acceptSignBytes(a: Omit<FloorAccept, 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    k: 'ssf-floor-accept:v1',
    offerId: a.offerId,
    ventureId: a.ventureId,
    takerPub: a.takerPub,
    takerName: a.takerName,
    acceptedAt: a.acceptedAt,
  }));
}

function cancelSignBytes(c: Omit<FloorCancel, 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    k: 'ssf-floor-cancel:v1',
    offerId: c.offerId,
    makerPub: c.makerPub,
    cancelledAt: c.cancelledAt,
  }));
}

function mintOfferId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ── Verify-on-read (shape gate + signature check for every record) ───────────

/** Regex for the hex-32 offerId. Rejects short/long/uppercase/non-hex —
 *  domain-tagged so no other identifier accidentally satisfies the shape. */
const OFFER_ID_RE = /^[0-9a-f]{32}$/;

function isOfferKind(v: unknown): v is FloorOfferKind {
  return v === 'SELL' || v === 'BUY';
}

/** Full shape gate on an offer — every field the UI renders or gates on.
 *  A hostile maker can self-sign any JSON, so typed-but-wrong values die
 *  here (a NaN expiresAt that never expires, a negative shares count that
 *  reads as a mint). */
export function verifyFloorOffer(o: FloorOffer | null | undefined): boolean {
  if (!o || o.v !== 1) return false;
  if (!isOfferKind(o.kind)) return false;
  if (typeof o.offerId !== 'string' || !OFFER_ID_RE.test(o.offerId)) return false;
  if (typeof o.ventureId !== 'string' || !o.ventureId) return false;
  if (typeof o.ventureName !== 'string') return false;
  if (typeof o.makerPub !== 'string' || !o.makerPub) return false;
  if (typeof o.makerName !== 'string') return false;
  if (!Number.isInteger(o.shares) || o.shares <= 0 || o.shares > CHARTER_TOTAL_SHARES) return false;
  if (!Number.isInteger(o.priceMojo) || o.priceMojo < 0) return false;
  if (!Number.isFinite(o.createdAt) || !Number.isFinite(o.expiresAt)) return false;
  if (o.expiresAt <= o.createdAt) return false;
  if (typeof o.sig !== 'string' || !o.sig) return false;
  const { sig, ...unsigned } = o;
  try {
    return verifyIdentity(o.makerPub, offerSignBytes(unsigned), sig);
  } catch { return false; }
}

export function verifyFloorAccept(a: FloorAccept | null | undefined): boolean {
  if (!a || a.v !== 1) return false;
  if (typeof a.offerId !== 'string' || !OFFER_ID_RE.test(a.offerId)) return false;
  if (typeof a.ventureId !== 'string' || !a.ventureId) return false;
  if (typeof a.takerPub !== 'string' || !a.takerPub) return false;
  if (typeof a.takerName !== 'string') return false;
  if (!Number.isFinite(a.acceptedAt)) return false;
  if (typeof a.sig !== 'string' || !a.sig) return false;
  const { sig, ...unsigned } = a;
  try {
    return verifyIdentity(a.takerPub, acceptSignBytes(unsigned), sig);
  } catch { return false; }
}

export function verifyFloorCancel(c: FloorCancel | null | undefined): boolean {
  if (!c || c.v !== 1) return false;
  if (typeof c.offerId !== 'string' || !OFFER_ID_RE.test(c.offerId)) return false;
  if (typeof c.makerPub !== 'string' || !c.makerPub) return false;
  if (!Number.isFinite(c.cancelledAt)) return false;
  if (typeof c.sig !== 'string' || !c.sig) return false;
  const { sig, ...unsigned } = c;
  try {
    return verifyIdentity(c.makerPub, cancelSignBytes(unsigned), sig);
  } catch { return false; }
}

/** Shape gate for a tape entry (write-once byproduct of reconciliation).
 *  A tape without a matching offer+canonical-accept is discarded on read —
 *  this rejects fabricated tape planted by a hostile peer. */
export function verifyFloorTape(t: FloorTape | null | undefined): boolean {
  if (!t || t.v !== 1) return false;
  if (!isOfferKind(t.kind)) return false;
  if (typeof t.offerId !== 'string' || !OFFER_ID_RE.test(t.offerId)) return false;
  if (typeof t.ventureId !== 'string' || !t.ventureId) return false;
  if (typeof t.makerPub !== 'string' || !t.makerPub) return false;
  if (typeof t.takerPub !== 'string' || !t.takerPub) return false;
  if (t.makerPub === t.takerPub) return false;
  if (!Number.isInteger(t.shares) || t.shares <= 0 || t.shares > CHARTER_TOTAL_SHARES) return false;
  if (!Number.isInteger(t.priceMojo) || t.priceMojo < 0) return false;
  if (!Number.isFinite(t.settledAt)) return false;
  return true;
}

// ── Key layout (per-key single writer → CRDT merge is safe) ─────────────────

const K_OFFER  = 'offer:';    // offer:<offerId>            → FloorOffer
const K_ACCEPT = 'accept:';   // accept:<offerId>:<takerPub> → FloorAccept
const K_CANCEL = 'cancel:';   // cancel:<offerId>            → FloorCancel
const K_TAPE   = 'tape:';     // tape:<offerId>              → FloorTape

// ── Create / sign helpers (called by the UI) ─────────────────────────────────

/** Draft + sign an offer for the CURRENT venture. The UI gates on office +
 *  (for SELL) sufficient held shares before calling. */
export function makeFloorOffer(
  kind: FloorOfferKind,
  makerName: string,
  shares: number,
  opts?: { priceMojo?: number; ttlMs?: number },
): FloorOffer | null {
  const v = ventureRecord();
  if (!v) return null;
  const n = Math.floor(shares);
  if (!Number.isInteger(n) || n <= 0 || n > v.totalShares) return null;
  const priceMojo = Math.max(0, Math.floor(opts?.priceMojo ?? 0));
  const now = Date.now();
  const unsigned: Omit<FloorOffer, 'sig'> = {
    v: 1,
    kind,
    offerId: mintOfferId(),
    ventureId: v.id,
    ventureName: v.name,
    makerPub: getIdentityPub(),
    makerName,
    shares: n,
    priceMojo,
    createdAt: now,
    expiresAt: now + Math.max(60_000, opts?.ttlMs ?? FLOOR_DEFAULT_TTL_MS),
  };
  const sig = signIdentity(offerSignBytes(unsigned));
  return { ...unsigned, sig };
}

/** Sign + write a fresh SELL/BUY offer to the floor. Returns the written
 *  record on success (so the UI can echo it in a "your posted offer" panel)
 *  or null on refusal. Refuses when not at the office, when the offer's
 *  ventureId doesn't match the current venture, or when shape/verify fails. */
export function postFloorOffer(o: FloorOffer): boolean {
  const m = map();
  if (!m) return false;
  if (!verifyFloorOffer(o)) return false;
  const v = ventureRecord();
  if (!v || v.id !== o.ventureId || !isOfficeHere()) return false;
  // No fan-out re-post: same offerId is idempotent (bytes-identical writes
  // are a no-op racing win). A hostile peer planting a different offer under
  // this key is caught by the on-read verify (which recomputes offerSignBytes).
  const existing = m.get(`${K_OFFER}${o.offerId}`);
  if (verifyFloorOffer(existing as FloorOffer)) {
    return (existing as FloorOffer).offerId === o.offerId
      && (existing as FloorOffer).makerPub === o.makerPub;
  }
  boundDoc!.transact(() => { m.set(`${K_OFFER}${o.offerId}`, o); });
  return true;
}

/** Maker cancels their own offer. Timestamp is now(); the precedes-canonical-
 *  accept check inside reconcile decides whether the cancel arrives in time. */
export function cancelFloorOffer(offerId: string): boolean {
  const m = map();
  if (!m) return false;
  if (typeof offerId !== 'string' || !OFFER_ID_RE.test(offerId)) return false;
  const raw = m.get(`${K_OFFER}${offerId}`);
  if (!verifyFloorOffer(raw as FloorOffer)) return false;
  const offer = raw as FloorOffer;
  if (offer.makerPub !== getIdentityPub()) return false;
  const unsigned: Omit<FloorCancel, 'sig'> = {
    v: 1,
    offerId,
    makerPub: offer.makerPub,
    cancelledAt: Date.now(),
  };
  const cancel: FloorCancel = { ...unsigned, sig: signIdentity(cancelSignBytes(unsigned)) };
  boundDoc!.transact(() => { m.set(`${K_CANCEL}${offerId}`, cancel); });
  return true;
}

/** Taker accepts an offer. Writes an acceptance under the per-taker slot;
 *  cap table settlement happens in reconcile (called immediately after). */
export function acceptFloorOffer(offerId: string, takerName: string): boolean {
  const m = map();
  if (!m) return false;
  if (typeof offerId !== 'string' || !OFFER_ID_RE.test(offerId)) return false;
  const raw = m.get(`${K_OFFER}${offerId}`);
  if (!verifyFloorOffer(raw as FloorOffer)) return false;
  const offer = raw as FloorOffer;
  const takerPub = getIdentityPub();
  if (takerPub === offer.makerPub) return false;
  if (Date.now() >= offer.expiresAt) return false;
  // Already burned? Same-taker replay is idempotent (bytes-identical), but a
  // fresh accept from the SAME taker with a NEWER timestamp is a downgrade —
  // canonical-pick keeps the earliest, so racing your own accept only wastes.
  const key = `${K_ACCEPT}${offerId}:${takerPub}`;
  const existing = m.get(key);
  if (verifyFloorAccept(existing as FloorAccept)) return true;
  const unsigned: Omit<FloorAccept, 'sig'> = {
    v: 1,
    offerId,
    ventureId: offer.ventureId,
    takerPub,
    takerName,
    acceptedAt: Date.now(),
  };
  const accept: FloorAccept = { ...unsigned, sig: signIdentity(acceptSignBytes(unsigned)) };
  boundDoc!.transact(() => { m.set(key, accept); });
  return true;
}

// ── Reads (shape-checked; hostile entries drop silently) ────────────────────

/** Read a single offer by id (null when absent or hostile). */
export function readFloorOffer(offerId: string): FloorOffer | null {
  const m = map();
  if (!m) return null;
  const raw = m.get(`${K_OFFER}${offerId}`);
  return verifyFloorOffer(raw as FloorOffer) && (raw as FloorOffer).offerId === offerId
    ? (raw as FloorOffer) : null;
}

/** Every accept for one offer — deterministic order (earliest first, then
 *  lex-smallest takerPub). This is the input to `pickCanonicalAccept`. */
export function listAcceptsFor(offerId: string): FloorAccept[] {
  const m = map();
  if (!m) return [];
  const prefix = `${K_ACCEPT}${offerId}:`;
  const out: FloorAccept[] = [];
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (verifyFloorAccept(value as FloorAccept)
      && (value as FloorAccept).offerId === offerId
      && key === `${K_ACCEPT}${offerId}:${(value as FloorAccept).takerPub}`) {
      out.push(value as FloorAccept);
    }
  }
  return out.sort(compareAccept);
}

/** The maker's cancellation for one offer, if any (verified). */
export function readCancelFor(offerId: string): FloorCancel | null {
  const m = map();
  if (!m) return null;
  const raw = m.get(`${K_CANCEL}${offerId}`);
  return verifyFloorCancel(raw as FloorCancel) && (raw as FloorCancel).offerId === offerId
    ? (raw as FloorCancel) : null;
}

/** The tape entry for one offer, if the trade settled and is verifiable. */
export function readTapeFor(offerId: string): FloorTape | null {
  const m = map();
  if (!m) return null;
  const raw = m.get(`${K_TAPE}${offerId}`);
  return verifyFloorTape(raw as FloorTape) && (raw as FloorTape).offerId === offerId
    ? (raw as FloorTape) : null;
}

/** Every OPEN offer (unsettled, unexpired, uncancelled) — what the board
 *  shows. Deterministic order (newest first, then lex-smallest offerId). */
export function listOpenOffers(): FloorOffer[] {
  const m = map();
  if (!m) return [];
  const now = Date.now();
  const out: FloorOffer[] = [];
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(K_OFFER)) continue;
    if (!verifyFloorOffer(value as FloorOffer)) continue;
    const o = value as FloorOffer;
    if (key !== `${K_OFFER}${o.offerId}`) continue;
    if (o.expiresAt <= now) continue;
    // Settled ⇒ tape present; cancelled-before-any-accept ⇒ dead. Both
    // filter out here so the board only shows what a click can act on.
    if (readTapeFor(o.offerId)) continue;
    const cancel = readCancelFor(o.offerId);
    if (cancel && !hasCanonicalAcceptBefore(o.offerId, cancel.cancelledAt)) continue;
    out.push(o);
  }
  return out
    .sort((a, b) => b.createdAt - a.createdAt || (a.offerId < b.offerId ? -1 : 1))
    .slice(0, FLOOR_LIST_CAP);
}

/** Every completed trade — sorted by settlement time ascending (the price
 *  chart consumes this feed left-to-right). */
export function listTape(): FloorTape[] {
  const m = map();
  if (!m) return [];
  const out: FloorTape[] = [];
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(K_TAPE)) continue;
    if (!verifyFloorTape(value as FloorTape)) continue;
    const t = value as FloorTape;
    if (key !== `${K_TAPE}${t.offerId}`) continue;
    out.push(t);
  }
  return out
    .sort((a, b) => a.settledAt - b.settledAt || (a.offerId < b.offerId ? -1 : 1))
    .slice(-FLOOR_LIST_CAP);
}

/** Price history for one venture — {t, priceMojo, shares, kind} rows the
 *  wall-screen chart plots. Empty when no trades yet. */
export function priceHistory(ventureId: string): Array<{
  t: number; priceMojo: number; shares: number; kind: FloorOfferKind;
}> {
  return listTape()
    .filter((t) => t.ventureId === ventureId)
    .map((t) => ({ t: t.settledAt, priceMojo: t.priceMojo, shares: t.shares, kind: t.kind }));
}

// ── Deterministic reconciliation (the conflict-safe settlement lane) ────────

/** Pure reducer: given a set of accepts for one offer, pick THE ONE that
 *  settles. Earliest acceptedAt wins; ties break on lex-smallest takerPub
 *  (base64url is order-preserving as bytes). Every peer applies this to
 *  the SAME merged accept set, so they all reach the same choice.
 *
 *  Exported for tests + the UI (which greys out losing accepts). */
export function pickCanonicalAccept(accepts: FloorAccept[]): FloorAccept | null {
  if (accepts.length === 0) return null;
  let winner = accepts[0];
  for (let i = 1; i < accepts.length; i++) {
    const a = accepts[i];
    if (a.acceptedAt < winner.acceptedAt
      || (a.acceptedAt === winner.acceptedAt && a.takerPub < winner.takerPub)) {
      winner = a;
    }
  }
  return winner;
}

function compareAccept(a: FloorAccept, b: FloorAccept): number {
  if (a.acceptedAt !== b.acceptedAt) return a.acceptedAt - b.acceptedAt;
  return a.takerPub < b.takerPub ? -1 : a.takerPub > b.takerPub ? 1 : 0;
}

/** Fast path used by listOpenOffers to decide whether a cancel is too late:
 *  does the canonical accept exist AND fall before `t`? */
function hasCanonicalAcceptBefore(offerId: string, t: number): boolean {
  const winner = pickCanonicalAccept(listAcceptsFor(offerId));
  return winner !== null && winner.acceptedAt < t;
}

/** The result of a reconciliation pass — for the UI to surface. */
export interface ReconcileResult {
  settledOfferIds: string[];  // newly written tape entries
  refusedOfferIds: string[];  // offer had a taker but couldn't settle (stale maker)
}

/**
 * Deterministic + idempotent: reads every offer, computes each settlement
 * outcome from the merged accept/cancel state, and writes the tape entry
 * plus a `transferShares` for the winner. Every peer that runs this on the
 * SAME merged doc reaches the SAME target state — the LWW race collapses
 * to identical writes.
 *
 * Safe to call from any code path that touches the floor:
 *   - After `acceptFloorOffer` (settle immediately if we're the fastest).
 *   - After `bindTradingFloor` (catch up any merged accepts from peers).
 *   - After any observed change to the floor map (the subscribe hook does this).
 *
 * Runs OUTSIDE any transact so the cap-table write from `transferShares`
 * keeps its normal semantics; the identical-write property makes overlapping
 * peers safe.
 *
 * SETTLEMENT V1 CAVEAT: priceMojo === 0 (gift) settles; non-zero refuses
 * with `refusedOfferIds` (the Registry lane arrives with V3). Non-zero
 * offers still ROUND-TRIP and DISPLAY so the chart can plot the ask —
 * but the cap table only moves for gifts today.
 */
export function reconcileTradingFloor(): ReconcileResult {
  const m = map();
  if (!m) return { settledOfferIds: [], refusedOfferIds: [] };
  const settled: string[] = [];
  const refused: string[] = [];
  const now = Date.now();
  // Snapshot the offer keys first — mutating during iteration is undefined
  // in Yjs. GC of long-dead marks is opportunistic (below).
  const offers: FloorOffer[] = [];
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(K_OFFER)) continue;
    if (!verifyFloorOffer(value as FloorOffer)) continue;
    const o = value as FloorOffer;
    if (key !== `${K_OFFER}${o.offerId}`) continue;
    offers.push(o);
  }
  for (const o of offers) {
    // Already settled? Idempotent skip.
    if (readTapeFor(o.offerId)) continue;
    const accepts = listAcceptsFor(o.offerId);
    const winner = pickCanonicalAccept(accepts);
    if (!winner) continue;
    // Cancel-before-canonical-accept invalidates the trade.
    const cancel = readCancelFor(o.offerId);
    if (cancel && cancel.cancelledAt <= winner.acceptedAt) continue;
    // Expired-before-canonical-accept invalidates the trade.
    if (o.expiresAt <= winner.acceptedAt) continue;
    // v1 gift rule: only priceMojo === 0 settles today (the Registry lane
    // is V3). Non-zero priced offers remain visible so the chart can plot
    // the ask price, but the cap table does not move.
    if (o.priceMojo !== 0) { refused.push(o.offerId); continue; }
    // Ownership authority: SELL requires the maker to still hold ≥ shares;
    // BUY requires the WINNING taker to still hold ≥ shares. Fail → refuse.
    const v = ventureRecord();
    if (!v || v.id !== o.ventureId) { refused.push(o.offerId); continue; }
    if (!isOfficeHere()) continue; // property-link viewers see the tape via office writes; do not settle here
    const seller = o.kind === 'SELL' ? o.makerPub : winner.takerPub;
    const buyer  = o.kind === 'SELL' ? winner.takerPub : o.makerPub;
    const buyerName = o.kind === 'SELL' ? winner.takerName : o.makerName;
    const held = v.shares[seller] ?? 0;
    if (held < o.shares) { refused.push(o.offerId); continue; }
    // Deterministic tape entry FIRST — every peer writes bytes-identical.
    const tape: FloorTape = {
      v: 1,
      offerId: o.offerId,
      ventureId: o.ventureId,
      kind: o.kind,
      shares: o.shares,
      priceMojo: o.priceMojo,
      makerPub: o.makerPub,
      takerPub: winner.takerPub,
      settledAt: winner.acceptedAt,
    };
    // transferShares is atomic + idempotent-safe: identical-writes from
    // parallel peers land as one, and the second peer's identical tape
    // write is a no-op. If the cap table moved BETWEEN our read and the
    // transact, transferShares refuses and we come back next tick.
    boundDoc!.transact(() => {
      const moved = transferShares(seller, buyer, buyerName, o.shares);
      if (moved) {
        m.set(`${K_TAPE}${o.offerId}`, tape);
        // GC one long-dead offer per settlement to keep the map trim —
        // never delete the just-settled entries (they're the price history).
        gcOne(m, now);
      }
    });
    if (readTapeFor(o.offerId)) settled.push(o.offerId);
    else refused.push(o.offerId);
  }
  return { settledOfferIds: settled, refusedOfferIds: refused };
}

/** GC one long-dead offer (with no tape and past grace) per call. Cheap +
 *  bounded; the map self-heals over time without a scan-all sweep. */
function gcOne(m: Y.Map<unknown>, now: number): void {
  const cutoff = now - FLOOR_GC_GRACE_MS;
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(K_OFFER)) continue;
    const raw = value as FloorOffer;
    if (!verifyFloorOffer(raw)) continue;
    if (raw.expiresAt > cutoff) continue;
    if (readTapeFor(raw.offerId)) continue;
    m.delete(key);
    // Also clean up its accept fan-out + cancel slot (they are useless without
    // the offer — signature verification would still hold, but nothing reads).
    const acceptPrefix = `${K_ACCEPT}${raw.offerId}:`;
    for (const [k2] of m.entries()) {
      if (k2.startsWith(acceptPrefix)) m.delete(k2);
    }
    m.delete(`${K_CANCEL}${raw.offerId}`);
    return;
  }
}

// ── Debug helpers (tests reach in through these) ─────────────────────────────

/** All raw offer records in insertion order — including expired / cancelled /
 *  settled ones. Useful for tests that assert conservation across the full
 *  history, and for a diagnostic panel in the wall-screen UI. */
export function listAllOffersRaw(): FloorOffer[] {
  const m = map();
  if (!m) return [];
  const out: FloorOffer[] = [];
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(K_OFFER)) continue;
    if (!verifyFloorOffer(value as FloorOffer)) continue;
    const o = value as FloorOffer;
    if (key !== `${K_OFFER}${o.offerId}`) continue;
    out.push(o);
  }
  return out;
}

/** For property-link viewers: the read side works without a live office. The
 *  tape they see is what the office wrote — never authored locally. */
export function floorBound(): boolean {
  return map() !== null;
}

/** Read the total shares held across every holder in the CURRENT venture
 *  (conservation invariant: sum ≤ totalShares always, = totalShares if any
 *  founder-issued and no dust). Exposed so tests can assert conservation
 *  after fork/merge cycles. */
export function sumHeldShares(v: VentureRecord | null): number {
  if (!v) return 0;
  let s = 0;
  for (const n of Object.values(v.shares)) s += n;
  return s;
}
