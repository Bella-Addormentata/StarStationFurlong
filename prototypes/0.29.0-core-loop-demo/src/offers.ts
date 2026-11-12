/**
 * 📤 Transfer Offers — Chia-wallet-style offer files for deeds & shares
 * (brainstorming/transfer-offers-deeds-shares.md)
 *
 * A TRANSFER OFFER is a signed, inert, portable artifact: the current holder
 * of a deed (or shares) signs "I transfer X to Y for price P", copies the
 * string, and shares it ANYWHERE (chat, email, a note). The recipient pastes
 * it and REDEEMS it standing in the settlement room — the module for a deed,
 * the registered office for shares. The maker's signature travels; the
 * taker's feet settle. Verified before apply; one-time (nonce recorded in the
 * doc's `offers` map); dies automatically if the asset moved since issuance.
 *
 * v1: price MUST be 0 (gift) — there is no settlement rail for value yet.
 * The format is field-compatible with the V3 Chia offer swap (NFT1 deeds /
 * CAT2 shares), which replaces settlement without changing these screens.
 *
 * Doc access mirrors ventures.ts: ONE module-level binding (bindOffers at the
 * T0 seam), never a per-call doc parameter — so the nonce burn, the owner
 * rewrite, and the venture-map writes can never land in different docs.
 */
import * as Y from 'yjs';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';
import { offerSignBytes } from './offerBytes';
import type { OfferAsset, TransferOffer } from './offerBytes';
import { leaveDeedOffer } from './computedFairOnly';
import {
  ventureRecord, isOfficeHere, transferShares, writeVentureLink,
  removeVentureLink, ventureLedger, type VentureLedgerEntry,
} from './ventures';

// The offer's shape and the bytes its maker signs live in offerBytes.ts (pure),
// so a module that only recomputes them needn't pull in the doc binding below.
export type { OfferAsset, TransferOffer } from './offerBytes';

export const OFFER_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Module doc binding (the ventures.ts pattern) ─────────────────────────────

let boundDoc: Y.Doc | null = null;
let offersYMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Listener isolation (the ventures.ts pattern): a throwing repaint must not
  // propagate out of the Y.Map observer emit or starve later listeners.
  for (const l of listeners) {
    try { l(); } catch (e) { console.error('offers listener failed:', e); }
  }
}

/** Bind the current room doc (T0 seam, alongside bindVentures). The `offers`
 *  Y.Map is nonce-keyed bookkeeping: additive, ignored by old clients. */
export function bindOffers(doc: Y.Doc): void {
  boundDoc = doc;
  offersYMap = doc.getMap('offers');
  offersYMap.observe(() => notify());
  notify();
}

export function subscribeOffers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && offersYMap !== null;
}

function mintNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface OfferRecipient { toPub?: string; toVentureId?: string; toVentureName?: string }

/** Sign a transfer offer for an asset WE hold. Creation is possible from
 *  anywhere (the ledgers know what we hold); validity is proven at redemption
 *  against the live doc — like a Chia offer, cutting one moves nothing. */
export function makeOffer(
  asset: OfferAsset,
  makerName: string,
  recipient: OfferRecipient,
  opts?: { price?: number; ttlMs?: number },
): TransferOffer {
  const unsigned: Omit<TransferOffer, 'sig'> = {
    v: 1,
    kind: 'transfer-offer',
    asset,
    makerPub: getIdentityPub(),
    makerName,
    toPub: recipient.toPub,
    toVentureId: recipient.toVentureId,
    toVentureName: recipient.toVentureName,
    price: opts?.price ?? 0,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (opts?.ttlMs ?? OFFER_DEFAULT_TTL_MS),
    nonce: mintNonce(),
  };
  return { ...unsigned, sig: signIdentity(offerSignBytes(unsigned)) };
}

// ── Encode / decode / verify (the contact-card carrier recipe) ───────────────

export function encodeOffer(offer: TransferOffer): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(offer))));
  return `ssf://offer?o=${b64}`;
}

/** Suggested filename for the 💾 SAVE path (Chia-wallet download parity). */
export function offerFileName(offer: TransferOffer): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'asset';
  return offer.asset.kind === 'deed'
    ? `deed-${slug(offer.asset.roomName)}.ssfoffer`
    : `shares-${slug(offer.asset.ventureName)}-x${offer.asset.count}.ssfoffer`;
}

/** Parse + VERIFY a pasted offer (ssf:// URL, bare base64, raw JSON, or the
 *  text of a dropped .ssfoffer file). Null on unreadable / bad shape / bad sig. */
export function decodeOffer(input: string): TransferOffer | null {
  let raw = input.trim();
  const m = raw.match(/[?&]o=([^&\s]+)/);
  if (m) raw = decodeURIComponent(m[1]);
  let offer: TransferOffer;
  try {
    const json = raw.startsWith('{') ? raw : decodeURIComponent(escape(atob(raw)));
    offer = JSON.parse(json);
  } catch { return null; }
  return verifyOffer(offer) ? offer : null;
}

export function verifyOffer(o: TransferOffer | null | undefined): boolean {
  // Shape gate covers EVERY field the phone renders or gates on — a hostile
  // maker can self-sign any JSON, so signed-but-wrong-typed values (a numeric
  // toVentureName, a NaN expiresAt that never expires) must die here, not in
  // the redeem screen's template.
  if (!o || o.kind !== 'transfer-offer' || o.v !== 1
    || typeof o.makerPub !== 'string' || !o.makerPub
    || typeof o.makerName !== 'string' || typeof o.sig !== 'string'
    || !Number.isFinite(o.price) || !Number.isFinite(o.issuedAt)
    || !Number.isFinite(o.expiresAt) || typeof o.nonce !== 'string' || !o.nonce
    || (o.toPub !== undefined && typeof o.toPub !== 'string')
    || (o.toVentureId !== undefined && typeof o.toVentureId !== 'string')
    || (o.toVentureName !== undefined && typeof o.toVentureName !== 'string')
    || !o.asset || (o.asset.kind !== 'deed' && o.asset.kind !== 'shares')) return false;
  if (o.asset.kind === 'deed' && (typeof o.asset.roomId !== 'string' || !o.asset.roomId
    || typeof o.asset.roomName !== 'string')) return false;
  if (o.asset.kind === 'shares' && (typeof o.asset.ventureId !== 'string' || !o.asset.ventureId
    || typeof o.asset.ventureName !== 'string' || typeof o.asset.officeRoomId !== 'string'
    || !Number.isInteger(o.asset.count) || o.asset.count <= 0)) return false;
  const { sig, ...unsigned } = o;
  return verifyIdentity(o.makerPub, offerSignBytes(unsigned), sig);
}

// ── The doc-side one-time record (`offers` Y.Map, nonce-keyed) ───────────────

export interface OfferMark {
  status: 'redeemed' | 'revoked';
  byPub: string;
  byName: string;
  at: number;
  /** The offer's expiresAt — lets long-dead marks be pruned on write. */
  exp: number;
  /** Asset kind, for the module's transfer-history row. */
  kind: 'deed' | 'shares';
}

/** Marks older than this past their offer's expiry are GC'd on write. */
const MARK_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function readMark(raw: unknown): OfferMark | null {
  const m = raw as Partial<OfferMark> | undefined;
  return m && (m.status === 'redeemed' || m.status === 'revoked')
    ? {
      status: m.status,
      byPub: typeof m.byPub === 'string' ? m.byPub : '',
      byName: typeof m.byName === 'string' ? m.byName : '',
      at: typeof m.at === 'number' ? m.at : 0,
      exp: typeof m.exp === 'number' ? m.exp : 0,
      kind: m.kind === 'shares' ? 'shares' : 'deed',
    }
    : null;
}

export function nonceMark(nonce: string): OfferMark | null {
  if (!docAlive()) return null;
  return readMark(offersYMap!.get(nonce));
}

/** All marks in the CURRENT room's doc — the module's free transfer history. */
export function listOfferMarks(): Array<{ nonce: string; mark: OfferMark }> {
  if (!docAlive()) return [];
  const out: Array<{ nonce: string; mark: OfferMark }> = [];
  offersYMap!.forEach((raw, nonce) => {
    const mark = readMark(raw);
    if (mark) out.push({ nonce, mark });
  });
  return out.sort((a, b) => b.mark.at - a.mark.at);
}

/** Write a mark and sweep long-dead ones — append-only bookkeeping, pruned. */
function writeMark(nonce: string, mark: OfferMark): void {
  const cutoff = Date.now() - MARK_GC_GRACE_MS;
  boundDoc!.transact(() => {
    offersYMap!.forEach((raw, key) => {
      const m = readMark(raw);
      if (m && m.exp > 0 && m.exp < cutoff) offersYMap!.delete(key);
    });
    offersYMap!.set(nonce, mark);
  });
}

/** Maker cancels an outstanding offer — standing in the settlement doc, like
 *  every write. (UI gates to the maker; dev-phase LWW as everywhere.) */
export function revokeOffer(offer: TransferOffer, myName: string): boolean {
  if (!docAlive()) return false;
  writeMark(offer.nonce, {
    status: 'revoked', byPub: getIdentityPub(), byName: myName,
    at: Date.now(), exp: offer.expiresAt, kind: offer.asset.kind,
  });
  return true;
}

// ── Redemption ───────────────────────────────────────────────────────────────

export type RedeemResult = { ok: true } | { ok: false; error: string };

export interface DeedRedeemCtx {
  currentRoomId: string;
  myPlayerId: string;
  myPub: string;
  myName: string;
  /** ACCEPT FOR A COMPANY (owner request): the redeemer's choice to take the
   *  module as venture property — same shareholder + seen-cap-table gate as a
   *  maker-directed venture offer. Ignored when the offer itself names a
   *  venture (the maker's designation wins). */
  acceptForVentureId?: string;
}

/** Shared preamble: signature already checked by decodeOffer; re-checked here
 *  so redeem is safe to call with any TransferOffer object. */
function checkCommon(o: TransferOffer, myPub: string): string | null {
  if (!verifyOffer(o)) return 'Offer failed verification.';
  if (Date.now() >= o.expiresAt) return 'This offer has expired.';
  if (o.price !== 0) return 'Priced offers arrive with the Registry — only gifts settle today.';
  if (o.toPub && o.toPub !== myPub) return 'This offer is made out to someone else.';
  if (o.makerPub === myPub) return 'This is your own offer — revoke it instead.';
  const mark = nonceMark(o.nonce);
  if (mark) return mark.status === 'redeemed' ? 'Already redeemed.' : 'The maker revoked this offer.';
  return null;
}

/** 🔒 What the casino does as a deed is redeemed on this page, inside the
 *  redemption's transaction (computedTable registers adoptFairOnlyGames: the
 *  maker's FAIR ONLY games move to the redeemer's key with the deed, design
 *  §8.7). A hook, so that this module needs nothing of the tables. */
let deedRedeemed: ((o: TransferOffer) => void) | null = null;
export function setDeedRedeemed(fn: ((o: TransferOffer) => void) | null): void {
  deedRedeemed = fn;
}

/** Redeem a DEED offer — standing in the offered module. Verifies the maker
 *  still holds the deed (owner-match through the players-map key bridge), then
 *  rewrites `roomInfo.owner` to US, adjusts the venture link per the offer's
 *  recipient, and burns the nonce — ownership move + burn in one transact. */
export function redeemDeedOffer(o: TransferOffer, ctx: DeedRedeemCtx): RedeemResult {
  if (o.asset.kind !== 'deed') return { ok: false, error: 'Not a deed offer.' };
  if (!docAlive()) return { ok: false, error: 'Room records are not loaded yet.' };
  if (o.asset.roomId !== ctx.currentRoomId)
    return { ok: false, error: `The deed is kept at the module — travel to ${o.asset.roomName || 'it'} to redeem.` };
  const common = checkCommon(o, ctx.myPub);
  if (common) return { ok: false, error: common };
  if (isOfficeHere()) return { ok: false, error: 'A registered office cannot change hands — the Charter holds its deed.' };

  // Owner-match: the current owner's players entry must carry the maker's key
  // (the "coin not yet spent" check — a hand-over since issuance kills the
  // offer; legacy unkeyed rooms fail here by design: no provable maker).
  const ownerId = boundDoc!.getMap('roomInfo').get('owner') as string | undefined;
  if (typeof ownerId !== 'string' || !ownerId) return { ok: false, error: 'No owner recorded here yet.' };
  const ownerEntry = boundDoc!.getMap('players').get(ownerId) as { keyB64?: string } | undefined;
  if (ownerEntry?.keyB64 !== o.makerPub)
    return { ok: false, error: 'The deed has changed hands since this offer was made.' };

  // Company recipient: the maker's designation (o.toVentureId) or, when the
  // offer leaves it open, the REDEEMER's accept-for-a-company choice. Either
  // way we redeem on the venture's behalf — must hold shares and have SEEN
  // its cap table (same precondition as ADD THIS MODULE).
  const targetVentureId = o.toVentureId ?? ctx.acceptForVentureId;
  let ventureEntry: VentureLedgerEntry | undefined;
  if (targetVentureId) {
    ventureEntry = ventureLedger().find((e) => e.id === targetVentureId && e.myShares > 0 && !!e.capSeenAt);
    if (!ventureEntry)
      return { ok: false, error: `Only a shareholder of ${o.toVentureName ?? 'that venture'} who has visited its office can accept for it.` };
  }

  const cutoff = Date.now() - MARK_GC_GRACE_MS;
  boundDoc!.transact(() => {
    boundDoc!.getMap('roomInfo').set('owner', ctx.myPlayerId);
    offersYMap!.forEach((raw, key) => {
      const m = readMark(raw);
      if (m && m.exp > 0 && m.exp < cutoff) offersYMap!.delete(key);
    });
    offersYMap!.set(o.nonce, {
      status: 'redeemed', byPub: ctx.myPub, byName: ctx.myName,
      at: Date.now(), exp: o.expiresAt, kind: 'deed',
    } satisfies OfferMark);
    // 🔒 The maker's FAIR ONLY games go with the deed, where the offer names
    // its buyer: the offer is left for this key's pages (`do:`), and the
    // games this page can check now are moved here and now.
    leaveDeedOffer(boundDoc!.getMap('casinoComputed'), o, ctx.currentRoomId);
    deedRedeemed?.(o);
  });
  // Venture link adjustments reuse the existing gated helpers (they transact
  // separately; acceptable — the ownership move above is the authoritative leg).
  const existing = ventureRecord();
  if (targetVentureId && ventureEntry) {
    if (existing && existing.snapshotAt !== undefined && existing.id !== targetVentureId) removeVentureLink();
    if (!ventureRecord()) writeVentureLink(ventureEntry);
  } else if (!targetVentureId && existing && existing.snapshotAt !== undefined) {
    removeVentureLink(); // company → sole: the module leaves the venture as it changes hands
  }
  return { ok: true };
}

/** Redeem a SHARES offer — standing at the venture's registered office. The
 *  maker's live holding is the fungible owner-match; settlement reuses the
 *  transferShares arithmetic under the maker's signed authority. */
export function redeemShareOffer(o: TransferOffer, myPub: string, myName: string): RedeemResult {
  if (o.asset.kind !== 'shares') return { ok: false, error: 'Not a share offer.' };
  const asset = o.asset; // narrowed local — the transact closure below keeps it
  if (o.toVentureId)
    return { ok: false, error: 'Share offers are made out to a person — companies hold shares through their members.' };
  if (!docAlive()) return { ok: false, error: 'Room records are not loaded yet.' };
  const v = ventureRecord();
  if (!v || v.id !== o.asset.ventureId || !isOfficeHere())
    return { ok: false, error: `Shares settle at the register — travel to ${o.asset.ventureName || 'the venture'}'s office to redeem.` };
  const common = checkCommon(o, myPub);
  if (common) return { ok: false, error: common };
  if ((v.shares[o.makerPub] ?? 0) < o.asset.count)
    return { ok: false, error: 'The maker no longer holds enough shares.' };

  // Settle + burn in ONE transaction (Yjs nests transacts on the same doc —
  // transferShares's inner transact joins this one), matching the deed leg's
  // move+burn atomicity.
  let settled = false;
  boundDoc!.transact(() => {
    settled = transferShares(o.makerPub, myPub, myName, asset.count);
    if (settled) {
      const cutoff = Date.now() - MARK_GC_GRACE_MS;
      offersYMap!.forEach((raw, key) => {
        const m = readMark(raw);
        if (m && m.exp > 0 && m.exp < cutoff) offersYMap!.delete(key);
      });
      offersYMap!.set(o.nonce, {
        status: 'redeemed', byPub: myPub, byName: myName,
        at: Date.now(), exp: o.expiresAt, kind: 'shares',
      } satisfies OfferMark);
    }
  });
  if (!settled) return { ok: false, error: 'Transfer refused — check the register.' };
  return { ok: true };
}

// ── Co-present settlement: settle a deed into an ARBITRARY module doc ─────────

/** The new owner's portable identity — a keyed players entry copied from the
 *  room where maker + receiver met into the subject module (the name↔key cert
 *  is room-agnostic, so it verifies wherever it lands). */
export interface DocSettleOwner {
  playerId: string;
  name: string;
  keyB64: string;
  keySig?: string;
  outfitId?: string;
  joinedAt?: number;
}

/**
 * Settle a DEED offer into a doc that is NOT the module binding — the co-present
 * path: the maker's client, standing in another room with the receiver, opens
 * the subject module in the background and hands the deed over on their behalf.
 * Everything is verified against the PASSED doc (owner-match, office guard,
 * nonce). PERSONAL transfer only in v1 (company acceptance stays a settle-at-
 * the-module flow); a maker-directed venture offer is refused here. The
 * receiver's keyed entry is copied in so ownership resolves at the module.
 */
export function settleDeedInDoc(doc: Y.Doc, o: TransferOffer, owner: DocSettleOwner): RedeemResult {
  if (o.asset.kind !== 'deed') return { ok: false, error: 'Not a deed offer.' };
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return { ok: false, error: 'The module records did not load.' };
  if (!verifyOffer(o)) return { ok: false, error: 'Offer failed verification.' };
  if (Date.now() >= o.expiresAt) return { ok: false, error: 'This offer has expired.' };
  if (o.price !== 0) return { ok: false, error: 'Priced offers arrive with the Registry — only gifts settle today.' };
  if (o.toVentureId) return { ok: false, error: 'Company offers are settled at the module for now.' };
  if (!owner.keyB64) return { ok: false, error: 'The new owner has no keyed record to carry.' };
  if (o.toPub && o.toPub !== owner.keyB64) return { ok: false, error: 'This offer is made out to someone else.' };
  if (o.makerPub === owner.keyB64) return { ok: false, error: 'The maker cannot accept their own offer.' };

  // Already settled/revoked in the module's own record?
  const offers = doc.getMap('offers');
  const prior = readMark(offers.get(o.nonce));
  if (prior) return { ok: false, error: prior.status === 'redeemed' ? 'Already redeemed.' : 'The maker revoked this offer.' };

  // Office guard (lightweight read of the module's venture record).
  const vrec = doc.getMap('venture').get('v') as { snapshotAt?: number } | undefined;
  if (vrec && vrec.snapshotAt === undefined) return { ok: false, error: 'A registered office cannot change hands — the Charter holds its deed.' };

  // Owner-match against THIS doc — the maker must still hold the deed here.
  const ownerId = doc.getMap('roomInfo').get('owner');
  if (typeof ownerId !== 'string' || !ownerId) return { ok: false, error: 'No owner recorded at the module yet.' };
  const cur = doc.getMap('players').get(ownerId) as { keyB64?: string } | undefined;
  if (cur?.keyB64 !== o.makerPub) return { ok: false, error: 'The deed has changed hands since this offer was made.' };

  const cutoff = Date.now() - MARK_GC_GRACE_MS;
  doc.transact(() => {
    // Carry the receiver's keyed entry so owner resolution works at the module.
    doc.getMap('players').set(owner.playerId, {
      name: owner.name || 'Clone',
      joinedAt: typeof owner.joinedAt === 'number' ? owner.joinedAt : Date.now(),
      outfitId: owner.outfitId ?? '',
      keyB64: owner.keyB64,
      ...(owner.keySig ? { keySig: owner.keySig } : {}),
    });
    doc.getMap('roomInfo').set('owner', owner.playerId);
    // Personal settle: a module that WAS venture property leaves the company.
    if (vrec && vrec.snapshotAt !== undefined) doc.getMap('venture').delete('v');
    offers.forEach((raw, key) => {
      const m = readMark(raw);
      if (m && m.exp > 0 && m.exp < cutoff) offers.delete(key);
    });
    offers.set(o.nonce, {
      status: 'redeemed', byPub: owner.keyB64, byName: owner.name || 'Clone',
      at: Date.now(), exp: o.expiresAt, kind: 'deed',
    } satisfies OfferMark);
    // 🔒 The offer is left for the buyer's page (`do:`), which moves the
    // maker's FAIR ONLY games to the buyer's key when it is next in the
    // module: only the buyer's key can sign that. Until then the games are
    // the maker's still, and the maker's house serves them.
    leaveDeedOffer(doc.getMap('casinoComputed'), o, o.asset.kind === 'deed' ? o.asset.roomId : '');
  });
  return { ok: true };
}

// ── Personal "offers I made" ledger (for the ✗ REVOKE list) ─────────────────

const MADE_KEY = 'ssf-offers-made';
const MAX_MADE = 32;

export interface MadeOfferEntry { offer: TransferOffer; encoded: string }

export function offersMade(): MadeOfferEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(MADE_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((e) => typeof e?.offer?.nonce === 'string') : [];
  } catch { return []; }
}

export function recordOfferMade(offer: TransferOffer): void {
  try {
    const rest = offersMade().filter((e) =>
      e.offer.nonce !== offer.nonce && e.offer.expiresAt > Date.now());
    localStorage.setItem(MADE_KEY, JSON.stringify(
      [{ offer, encoded: encodeOffer(offer) }, ...rest].slice(0, MAX_MADE)));
  } catch { /* session-only */ }
}

export function dropOfferMade(nonce: string): void {
  try {
    localStorage.setItem(MADE_KEY, JSON.stringify(offersMade().filter((e) => e.offer.nonce !== nonce)));
  } catch { /* ignore */ }
}
