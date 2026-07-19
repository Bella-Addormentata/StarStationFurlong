# 📤 Transfer Offers — Chia-wallet-style offer files for Deeds & Shares

*Design proposal, 2026-07-19. Status: for review — no code landed yet.*
*Companions: [chia-authority-architecture.md](chia-authority-architecture.md) §3 (on-chain NFT1 deed offers),
[chia-ventures-shared-ownership.md](chia-ventures-shared-ownership.md) §4 (CAT2 share offers), keyed-identity-contacts-plan.md (the signed-card pattern this reuses).*

---

## 1. What we're mimicking: the Chia wallet offer

The Chia wallet's offer file is the model. Its properties, and which ones we can
reproduce off-chain today:

| Chia offer property | What it means | Off-chain v1 (this doc) | On-chain V3 (existing chia docs) |
|---|---|---|---|
| **Inert text artifact** | An `offer1…` string you can copy, paste, email, post anywhere. Holding it moves nothing. | ✅ `ssf://offer?o=<base64>` string — copy to clipboard or save as a file | ✅ real `offer1…` bech32m |
| **No secrets inside** | Safe to publish; contains signatures, never keys | ✅ Ed25519 signature only; the seed never leaves `keypair.ts` | ✅ |
| **Tamper-evident** | Any edit invalidates it | ✅ signature over canonical domain-tagged bytes (contact-card pattern) | ✅ |
| **Taker completes it** | Maker signs half a bargain and goes offline; any taker finishes it later | ⚠️ **Partially** — the taker redeems without the maker present, but must stand in the right module (see §4) | ✅ anywhere, via full node |
| **Atomic settlement** | Both legs happen or neither | ❌ price-0 gifts only in v1, so there is only one leg (see §6) | ✅ CAT-for-XCH natively |
| **Cancel by spending** | Maker moves the offered coin; all outstanding offers die | ✅ analog: a deed offer is bound to the *current owner* — any hand-over invalidates it. Plus explicit revoke + expiry | ✅ |
| **One-time use** | The coin can be spent once | ✅ redeemed-nonce record in the room doc | ✅ |

The pitch: **the game gets the offer-file UX now** (copy a transfer, send it over
Discord/email/anything, the counterparty pastes and accepts — ownership moves
without both parties ever being online together), with a format designed so the
V3 Registry anchor can swap the settlement layer to real Chia offers without
changing what players see.

**Plain-language rule (#68) holds**: the UI says *transfer offer*, *deed*,
*shares* — never coin, spend bundle, or puzzle.

---

## 2. What exists today (the seams we build on)

All paths in `prototypes/0.29.0-core-loop-demo/src/`.

- **Deed hand-over** — `main.ts` `executeDeedHandover()`: rewrites
  `roomInfo.owner` to the recipient's player id. Gift only, and both the giver's
  action and the recipient's prior visit must happen *in the module*. The deeds
  list (`deeds.ts`) is a visitation-harvested personal cache; `roomInfo.owner`
  in the room doc is the authoritative record.
- **Share transfer** — `ventures.ts` `transferShares()`: whole-record rewrite of
  the office doc's `venture` map. Gift only, office-only, recipient key pasted
  by hand.
- **The signed bearer artifact pattern** — `contacts.ts`: a contact card is a
  self-signed JSON credential carried as `ssf://contact?card=<base64>`, copied
  via `navigator.clipboard.writeText`, verified client-side before import
  (`decodeContactCard` → `verifyContactCard`). **This is already a Chia-offer-
  shaped object** — the transfer offer below is the same pattern with an asset
  and a redemption step attached.
- **Identity** — `keypair.ts`: Ed25519 identity (`getIdentityPub`,
  `signIdentity`, `verifyIdentity`). Note the two-identity split: shares and
  contacts key on the Ed25519 pub; `roomInfo.owner` keys on the legacy player
  UUID, bridged through the `players` map's `keyB64` field. Offers sign with
  the Ed25519 key and cross the bridge at redemption (§4.2).

What does **not** exist: any cross-room settlement rail, any global currency
(casino chips are per-room physical objects), any on-wire enforcement that only
the owner may rewrite ownership (dev-phase posture: UI-gated, last-writer-wins).
The offer keeps that honest posture (§7) while adding *provable intent*.

---

## 3. The artifact: `TransferOffer`

One format covers both asset kinds:

```
ssf://offer?o=<base64(JSON)>
```

```ts
export type OfferAsset =
  | { kind: 'deed';   roomId: string; roomName: string }
  | { kind: 'shares'; ventureId: string; ventureName: string;
      officeRoomId: string; count: number };

export interface TransferOffer {
  v: 1;
  kind: 'transfer-offer';
  asset: OfferAsset;
  makerPub: string;      // Ed25519 identity of the current holder (base64url)
  makerName: string;     // display only — authority is the key
  /** DIRECTED offer: only this identity may redeem. Absent ⇒ BEARER offer
   *  (first redeemer takes it — exactly a Chia offer file's semantics). */
  toPub?: string;
  /** COMPANY recipient (deed offers only): redeeming assigns the module to
   *  this venture as property. Redeemer must hold its shares. */
  toVentureId?: string;
  toVentureName?: string;
  /** Asking price. v1: MUST be 0 (gift). Non-zero parses but is refused at
   *  redemption with "priced offers arrive with the Registry" (§6). */
  price: number;
  issuedAt: number;
  expiresAt: number;     // required — default issuedAt + 7 days (CHIP-0014 ASSERT_BEFORE analog)
  nonce: string;         // random one-time id — the replay-protection key
  sig: string;           // maker's signature over the canonical bytes
}
```

Signed canonical bytes follow the contact-card recipe exactly — stable JSON,
explicit key order, domain-tagged and versioned so an offer can never be
replayed as some other message kind:

```
{ k:'ssf-transfer-offer:v1', asset, makerPub, toPub, toVentureId, price, issuedAt, expiresAt, nonce }
```

**Copy and download.** Like the Chia wallet, both: 📋 COPY puts the `ssf://`
string on the clipboard (primary — matches room passes and contact cards);
💾 SAVE downloads the same string as `deed-<name>.ssfoffer` /
`shares-<venture>.ssfoffer` via a Blob link, for people who trade files.
The redeem box accepts the URL form, bare base64, raw JSON, or a dropped file's
text — same permissive decode as `decodeContactCard`.

**Directed vs bearer.** Default **directed** (`toPub` set, chosen from
CONTACTS): a leaked screenshot of the offer is useless to anyone else. Bearer
offers (no `toPub`) are one checkbox away and are what a future public *market
board* doc would gossip — that's precisely dexie/Splash! in
chia-ventures-shared-ownership.md §4, deferred with it.

---

## 4. Lifecycle: create anywhere → share out-of-band → redeem at the asset

### 4.1 Why redemption is location-bound

The client holds **one room doc at a time**, and the authoritative records live
in docs: a module's owner in *its* doc, a venture's cap table in *its office's*
doc. There is no cross-doc write path, so the offer cannot settle "in the
mail" — settlement happens when someone standing in the right doc applies it.

So the offer's motto is: **the maker's signature travels; the taker's feet
settle.** The maker creates and shares the offer from anywhere (even from the
deeds/ventures ledger, standing in a different room — validity is checked at
redemption, not creation). The taker pastes it anywhere, gets a verified
preview, and the REDEEM button lights up only when they're standing:

- **deed offer** → in the offered module,
- **share offer** → at the venture's registered office.

The phone tells them where to go (both asset kinds carry the room id; the
station atlas can name it). This is strictly better than today's hand-over —
the maker no longer needs to be present or online at all — and it reads well in
the fiction: *the deed is kept at the module; the share register at the office*.

### 4.2 Redemption checks (verify-before-apply, like every import in the repo)

Deed offer, redeemer standing in `asset.roomId`:

1. signature verifies against `makerPub`; `Date.now() < expiresAt`; `price === 0`;
2. directed → my identity pub equals `toPub`;
3. **owner-match (the "coin not yet spent" check)**: the doc's current
   `roomInfo.owner` player id resolves through the `players` map to a `keyB64`
   equal to `makerPub`. If the deed changed hands since the offer was cut, this
   fails and the offer is dead — the same way spending a coin kills a Chia
   offer. (Legacy `'Local-Clone'` rooms fail here by design: no provable maker.)
4. **nonce unused**: the doc's `offers` map has no record for `offer.nonce`;
5. venture-recipient offers additionally require the redeemer to hold shares of
   `toVentureId` and to carry a seen cap table in their ledger (same
   precondition as ADD THIS MODULE today).

Then one `doc.transact`: set `roomInfo.owner` to the *redeemer's* player id
(their `players` entry exists — they're standing here, which is why today's
"recipient must have visited" gate dissolves), write the venture link if
`toVentureId` (or remove an existing link if the offer moves company property
to a sole owner), and record `offers[nonce] = { status:'redeemed', byPub, at }`.
Then `syncDeedsLedgerFromCurrentRoom()` harvests the new deed instantly.

Share offer, redeemer at the office: same shape — sig/expiry/price/directed,
`ventureRecord().id === asset.ventureId` and `isOfficeHere()`, **maker still
holds ≥ count** (the fungible owner-match), nonce unused → apply via the
existing `transferShares(makerPub, myPub, myName, count)` arithmetic + record
the nonce.

### 4.3 Invalidation — three ways an offer dies

1. **Superseded** (automatic): the deed's owner changed / the maker's share
   balance dropped below `count`. The Chia cancel-by-spend analog; costs nothing.
2. **Revoked** (explicit): the maker, standing in the settlement doc, writes
   `offers[nonce] = { status:'revoked' }`. UI: an OFFERS OUT list on the deed /
   venture detail screen with a ✗ REVOKE pill. (A locally-kept
   `ssf-offers-made` ledger remembers what you've cut, since the artifact
   itself lives on clipboards.)
3. **Expired** (automatic): `expiresAt` passes. Required field, 7-day default,
   so lost clipboard scraps don't haunt a module forever.

The `offers` map is append-only bookkeeping, capped and prunable (entries whose
`expiresAt` is long past can be GC'd on write).

---

## 5. Companies: sole proprietor ⇄ venture, both directions

The user-facing goal: *quickly move a module between a person and a company,
and shares between anyone, with copy/paste.* Four moves, all the same artifact:

| Move | Offer | Redemption |
|---|---|---|
| **Person → person** (deed) | `asset:deed`, `toPub` = them | They redeem in the module; owner becomes them. Replaces the in-person HAND OVER as the remote path. |
| **Person → company** (deed) | `asset:deed`, `toVentureId` = the venture | Any shareholder redeems in the module: owner becomes that shareholder **and** the venture property link is written in the same transact. The module lands as venture property in one paste. |
| **Company → person** (deed) | Cut by the module's *personal owner* (venture property still has one — see below), `toPub` = buyer | Redemption sets the new owner **and removes the venture link** in the same transact — the module leaves the company as it changes hands. |
| **Person → person** (shares) | `asset:shares`, `count`, `toPub` | Redeemed at the office. Replaces paste-a-key-while-co-present. A founder can now email a co-founder their stake. |

**The representation caveat, stated honestly.** Today "the company owns it" is
really *personal owner + venture link* (`ventures.ts` V2): `roomInfo.owner`
still names a person. This proposal keeps that representation — the
person→company offer makes the redeeming shareholder the personal owner and
tags the venture — because it's the least-invasive slice and every existing
gate keeps working. The deeper fix (a first-class venture-held deed, e.g.
`roomInfo.owner = 'vnt:<ventureId>'`, with `isLocalPlayerRoomOwner` /
`currentRoomDeedIsMine` extended so *no individual* can walk off with company
property) is real and worth doing, but it touches every owner gate in main.ts
and is exactly the custody question the V3 Registry answers
(chia-authority-architecture.md: deeds custodied by the venture singleton). 
Recommendation: ship offers on the V2 representation now; open the venture-held
deed as its own slice. One guard worth adding meanwhile: cutting a deed offer
on venture property warns the maker it will detach the module unless the
recipient is the same venture (mirror of today's office-deed refusal).

Office deeds stay non-transferable (the Charter holds them) — a deed offer on
an office is refused at creation and at redemption, same message as today.

---

## 6. The price field — and the price-0 question

**Q: if the offer is set at a price of 0, can it still work to instantly
transfer items to companies and players in exchange for nothing?**

**Yes — and in v1 that's the only price that settles.** A zero-price offer is a
signed, portable, one-time gift certificate: redemption is instant (one
transact) the moment the taker stands in the right room and pastes it. This is
also true of real Chia offers — an offer requesting nothing is taken for free
by whoever holds the file — so the mimicry is faithful, with the same caveat:
**a bearer offer at price 0 is cash.** Anyone holding the string can take the
asset. That's why directed (`toPub`) is the default and bearer is an explicit
choice.

**Why not price > 0 yet:** there is no settlement rail. Casino chips are
per-room physical records (`casinoDoc.ts`) — a chip balance in the casino can't
pay for a deed in a workshop, and there's no global wallet. Faking it
("recipient promises to pay") would break the offer's whole point: atomicity.
So v1 keeps `price` in the format (and shows it in the preview) but redemption
refuses non-zero with honest copy: *"priced offers arrive with the Registry."*
Two future rails, in order of likely arrival:

1. **In-room chip escrow** — a priced offer redeemable only where a casino map
   exists: the transact debits the taker's chips and credits the maker's in the
   same transaction it moves the deed. Real but room-bound; a design smell
   (chips were meant to be casino toys, and the maker may hold no chip balance
   there).
2. **The Chia rail** (the endgame, already designed): deeds as NFT1 singletons,
   shares as CAT2, offers as real `offer1…` files natively expressing
   asset-for-XCH — chia-authority-architecture.md §3 and
   chia-ventures-shared-ownership.md §4. This v1 artifact is deliberately
   field-compatible: `asset`/`maker`/`to`/`price`/`expiresAt` map 1:1 onto the
   NFT/CAT offer, so the swap changes the settlement layer, not the UX or the
   phone screens. (Also the regulatory note in chia-ventures §7 — shares
   deliberately not purchasable for real value in v1 — is another reason
   price-0-only is the right first slice.)

---

## 7. Security posture (dev-phase honesty)

What the signature **does** give: proof the named maker authored this exact
offer (tamper-evident, non-repudiable), replay protection (nonce + one-time
record), automatic invalidation on state change, directed delivery, expiry. A
taker can no longer be tricked by a doctored screenshot, and a maker can no
longer deny having cut an offer.

What it does **not** give (unchanged from every existing transfer): on-wire
enforcement. A modified client can still rewrite `roomInfo.owner` or the
`venture` map without any offer — Yjs converges last-writer-wins, and
`YjsSync`'s envelope signatures prove *authorship of updates*, not
*authorization of ownership changes*. The offer narrows the honest-client
attack surface and produces an audit trail (`offers` map records who redeemed
what, when, under whose signature), but real enforcement is the signed
authority-head / Registry work, as everywhere else in the dev-phase posture.

One new consideration bearer offers introduce: **redeem races**. Two takers in
the same room pasting the same bearer offer race on the nonce record; LWW picks
a winner and the loser's deed harvest self-corrects on the next observer tick.
Acceptable at V1 scale — same class as concurrent share transfers today.

---

## 8. Proposed code

### 8.1 New file: `src/offers.ts`

Follows `contacts.ts` structurally (canonical bytes → sign → `ssf://` carrier →
permissive decode → verify-before-apply) and `ventures.ts` for doc binding.

```ts
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
 */
import * as Y from 'yjs';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';
import {
  ventureRecord, isOfficeHere, transferShares, writeVentureLink,
  removeVentureLink, ventureLedger, type VentureLedgerEntry,
} from './ventures';

export type OfferAsset =
  | { kind: 'deed'; roomId: string; roomName: string }
  | { kind: 'shares'; ventureId: string; ventureName: string; officeRoomId: string; count: number };

export interface TransferOffer {
  v: 1;
  kind: 'transfer-offer';
  asset: OfferAsset;
  makerPub: string;
  makerName: string;
  toPub?: string;          // directed; absent = bearer
  toVentureId?: string;    // deed offers only: settle as venture property
  toVentureName?: string;
  price: number;           // v1: 0 or redemption refuses
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  sig: string;
}

export const OFFER_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Canonical sign-bytes (domain-tagged, explicit key order) ─────────────────

function assetCanonical(a: OfferAsset): unknown {
  return a.kind === 'deed'
    ? { kind: 'deed', roomId: a.roomId, roomName: a.roomName }
    : { kind: 'shares', ventureId: a.ventureId, ventureName: a.ventureName,
        officeRoomId: a.officeRoomId, count: a.count };
}

function offerSignBytes(o: Omit<TransferOffer, 'sig'>): Uint8Array {
  const canonical = JSON.stringify({
    k: 'ssf-transfer-offer:v1',
    asset: assetCanonical(o.asset),
    makerPub: o.makerPub,
    toPub: o.toPub ?? null,
    toVentureId: o.toVentureId ?? null,
    price: o.price,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
    nonce: o.nonce,
  });
  return new TextEncoder().encode(canonical);
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
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'asset';
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
  if (!o || o.kind !== 'transfer-offer' || o.v !== 1
    || typeof o.makerPub !== 'string' || typeof o.sig !== 'string'
    || typeof o.price !== 'number' || typeof o.issuedAt !== 'number'
    || typeof o.expiresAt !== 'number' || typeof o.nonce !== 'string' || !o.nonce
    || !o.asset || (o.asset.kind !== 'deed' && o.asset.kind !== 'shares')) return false;
  if (o.asset.kind === 'deed' && (typeof o.asset.roomId !== 'string' || !o.asset.roomId)) return false;
  if (o.asset.kind === 'shares' && (typeof o.asset.ventureId !== 'string'
    || typeof o.asset.officeRoomId !== 'string'
    || !Number.isInteger(o.asset.count) || o.asset.count <= 0)) return false;
  const { sig, ...unsigned } = o;
  return verifyIdentity(o.makerPub, offerSignBytes(unsigned), sig);
}

// ── The doc-side one-time record (`offers` Y.Map, nonce-keyed) ───────────────

interface OfferMark { status: 'redeemed' | 'revoked'; byPub: string; at: number }

function offersMap(doc: Y.Doc): Y.Map<unknown> { return doc.getMap('offers'); }

function nonceMark(doc: Y.Doc, nonce: string): OfferMark | null {
  const raw = offersMap(doc).get(nonce) as Partial<OfferMark> | undefined;
  return raw && (raw.status === 'redeemed' || raw.status === 'revoked')
    ? raw as OfferMark : null;
}

/** Maker cancels an outstanding offer — standing in the settlement doc, like
 *  every write. (UI gates to the maker; dev-phase LWW as everywhere.) */
export function revokeOffer(doc: Y.Doc, nonce: string): void {
  doc.transact(() => offersMap(doc).set(nonce, {
    status: 'revoked', byPub: getIdentityPub(), at: Date.now(),
  } satisfies OfferMark));
}

// ── Redemption ───────────────────────────────────────────────────────────────

export type RedeemResult = { ok: true } | { ok: false; error: string };

export interface DeedRedeemCtx {
  doc: Y.Doc;
  currentRoomId: string;
  myPlayerId: string;
  myPub: string;
}

/** Shared preamble: signature already checked by decodeOffer; re-checked here
 *  so redeem() is safe to call with any TransferOffer object. */
function checkCommon(o: TransferOffer, doc: Y.Doc, myPub: string): string | null {
  if (!verifyOffer(o)) return 'Offer failed verification.';
  if (Date.now() >= o.expiresAt) return 'This offer has expired.';
  if (o.price !== 0) return 'Priced offers arrive with the Registry — only gifts (price 0) settle today.';
  if (o.toPub && o.toPub !== myPub) return 'This offer is made out to someone else.';
  if (o.makerPub === myPub) return 'This is your own offer.';
  const mark = nonceMark(doc, o.nonce);
  if (mark) return mark.status === 'redeemed' ? 'Already redeemed.' : 'The maker revoked this offer.';
  return null;
}

/** Redeem a DEED offer — standing in the offered module. Verifies the maker
 *  still holds the deed (owner-match through the players-map key bridge), then
 *  rewrites `roomInfo.owner` to US, adjusts the venture link per the offer's
 *  recipient, and burns the nonce — one transact. */
export function redeemDeedOffer(o: TransferOffer, ctx: DeedRedeemCtx): RedeemResult {
  if (o.asset.kind !== 'deed') return { ok: false, error: 'Not a deed offer.' };
  if (o.asset.roomId !== ctx.currentRoomId)
    return { ok: false, error: `The deed is kept at the module — travel to ${o.asset.roomName} to redeem.` };
  const common = checkCommon(o, ctx.doc, ctx.myPub);
  if (common) return { ok: false, error: common };
  if (isOfficeHere()) return { ok: false, error: 'A registered office cannot change hands — the Charter holds its deed.' };

  // Owner-match: the current owner's players entry must carry the maker's key
  // (the "coin not yet spent" check — a hand-over since issuance kills the offer).
  const ownerId = ctx.doc.getMap('roomInfo').get('owner') as string | undefined;
  if (typeof ownerId !== 'string' || !ownerId) return { ok: false, error: 'No owner recorded here yet.' };
  const ownerEntry = ctx.doc.getMap('players').get(ownerId) as { keyB64?: string } | undefined;
  if (ownerEntry?.keyB64 !== o.makerPub)
    return { ok: false, error: 'The deed has changed hands since this offer was made.' };

  // Company recipient: we redeem on the venture's behalf — must hold shares
  // and have SEEN its cap table (same precondition as ADD THIS MODULE).
  let ventureEntry: VentureLedgerEntry | undefined;
  if (o.toVentureId) {
    ventureEntry = ventureLedger().find((e) => e.id === o.toVentureId && e.myShares > 0 && !!e.capSeenAt);
    if (!ventureEntry)
      return { ok: false, error: `Only a shareholder of ${o.toVentureName ?? 'that venture'} who has visited its office can accept for it.` };
  }

  ctx.doc.transact(() => {
    ctx.doc.getMap('roomInfo').set('owner', ctx.myPlayerId);
    offersMap(ctx.doc).set(o.nonce, {
      status: 'redeemed', byPub: ctx.myPub, at: Date.now(),
    } satisfies OfferMark);
  });
  // Venture link adjustments reuse the existing gated helpers (they transact
  // separately; acceptable — the ownership move above is the authoritative leg).
  const existing = ventureRecord();
  if (o.toVentureId && ventureEntry) {
    if (existing && existing.snapshotAt !== undefined && existing.id !== o.toVentureId) removeVentureLink();
    if (!ventureRecord()) writeVentureLink(ventureEntry);
  } else if (!o.toVentureId && existing && existing.snapshotAt !== undefined) {
    removeVentureLink(); // company → sole: the module leaves the venture as it changes hands
  }
  return { ok: true };
}

/** Redeem a SHARES offer — standing at the venture's registered office. The
 *  maker's live holding is the fungible owner-match; settlement reuses the
 *  transferShares arithmetic under the maker's signed authority. */
export function redeemShareOffer(o: TransferOffer, doc: Y.Doc, myPub: string, myName: string): RedeemResult {
  if (o.asset.kind !== 'shares') return { ok: false, error: 'Not a share offer.' };
  const v = ventureRecord();
  if (!v || v.id !== o.asset.ventureId || !isOfficeHere())
    return { ok: false, error: `Shares settle at the register — travel to ${o.asset.ventureName}'s office to redeem.` };
  const common = checkCommon(o, doc, myPub);
  if (common) return { ok: false, error: common };
  if ((v.shares[o.makerPub] ?? 0) < o.asset.count)
    return { ok: false, error: 'The maker no longer holds enough shares.' };

  if (!transferShares(o.makerPub, myPub, myName, o.asset.count))
    return { ok: false, error: 'Transfer refused — check the register.' };
  doc.transact(() => offersMap(doc).set(o.nonce, {
    status: 'redeemed', byPub: myPub, at: Date.now(),
  } satisfies OfferMark));
  return { ok: true };
}

// ── Personal "offers I made" ledger (for the ✗ REVOKE list) ─────────────────

const MADE_KEY = 'ssf-offers-made';
const MAX_MADE = 32;

export interface MadeOfferEntry { offer: TransferOffer; encoded: string }

export function offersMade(): MadeOfferEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(MADE_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((e) => e?.offer?.nonce) : [];
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
```

### 8.2 `main.ts` wiring (sketch — the review surface)

**Deed detail screen** (`renderVenturesApp`, the `transferBlock` builder): next
to today's in-person HAND OVER, add the remote path. Unlike hand-over this
works both `here` and held-from-afar (creation needs no doc):

```ts
// 📤 TRANSFER OFFER — the remote path: sign it here, send it anywhere,
// the recipient redeems standing in the module. Offered for any non-office
// deed of mine (creation is doc-free; validity proves at redemption).
offerBlock = `
  <div style="font-size:10px; font-weight:800; letter-spacing:1px; color:rgba(212,168,75,0.95); margin-top:12px;">TRANSFER OFFER</div>
  <div style="display:flex; gap:4px; margin-top:4px;">
    <select id="deed-offer-to" style="…">${contactOptions /* CONTACTS + my ventures + '⚠ anyone (bearer)' */}</select>
    <button type="button" data-venture-action="deed-offer-copy" style="${pill}">📋 COPY</button>
    <button type="button" data-venture-action="deed-offer-save" style="${pill}">💾 SAVE</button>
  </div>
  <div style="font-size:9px; color:rgba(212,168,75,0.65); margin-top:3px;">
    Signs a 7-day transfer of this deed as a gift. Send the copied offer any way
    you like — the recipient redeems it standing in this module. Any hand-over
    meanwhile voids it.</div>`;
```

Handler (`deed-offer-copy` / `deed-offer-save`):

```ts
} else if (action === 'deed-offer-copy' || action === 'deed-offer-save') {
  const d = deedsLedger().find((e) => e.roomId === deedDetailRoomId);
  const sel = document.getElementById('deed-offer-to') as HTMLSelectElement | null;
  if (!d || d.isOffice || !sel) return;
  const rcpt = parseOfferRecipient(sel.value); // 'pub:<key>' | 'vnt:<id>' | 'bearer'
  const offer = makeOffer({ kind: 'deed', roomId: d.roomId, roomName: d.name }, getPlayerName(), rcpt);
  recordOfferMade(offer);
  if (action === 'deed-offer-copy') {
    navigator.clipboard.writeText(encodeOffer(offer));
    logToPhoneSystem('📤 Transfer offer copied — send it to the new owner.');
  } else {
    const blob = new Blob([encodeOffer(offer)], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: offerFileName(offer) });
    a.click(); URL.revokeObjectURL(a.href);
  }
}
```

**Venture detail screen** (office, `mine > 0`): beside TRANSFER SHARES, an
OFFER SHARES row — count + recipient + 📋 COPY / 💾 SAVE, calling `makeOffer`
with `{ kind:'shares', ventureId, ventureName, officeRoomId, count }`. Same
handler shape.

**Redeem box** (Ventures list screen, always visible — the app's front door for
incoming offers):

```ts
// 📥 REDEEM — paste any transfer offer; preview verified fields, then a
// two-tap arm→CONFIRM (the hand-over pattern). The button explains WHERE
// settlement happens when we're standing in the wrong room.
`<div style="font-size:10px; font-weight:800; letter-spacing:1px; …; margin-top:14px;">REDEEM AN OFFER</div>
 <textarea id="offer-redeem-input" rows="2" placeholder="paste a transfer offer (ssf://offer?…)" style="…"></textarea>
 <div id="offer-redeem-preview" style="font-size:9px; …"></div>
 <button type="button" data-venture-action="offer-redeem" style="${pill}">🔎 CHECK OFFER</button>`
```

Handler: `decodeOffer` → render the preview (asset, maker name + key
fingerprint, GIFT/price, expiry, where to redeem) → second tap dispatches
`redeemDeedOffer` / `redeemShareOffer` with `{ doc: yjsSync.doc, currentRoomId:
activeBootstrap.roomId, myPlayerId: getPlayerId(), myPub: getIdentityPub() }`;
on success `syncDeedsLedgerFromCurrentRoom()` / `syncVentureLedgerFromCurrentRoom()`
and a `logToPhoneSystem` receipt. Every failure path shows the redemption
function's plain-language `error` and keeps the textarea for correction.

**Offers-out list** (deed + venture detail screens): rows from `offersMade()`
scoped to this asset — recipient, expiry countdown, 📋 re-copy and, when
standing in the settlement doc, ✗ REVOKE (`revokeOffer(doc, nonce)` +
`dropOfferMade`).

### 8.3 Touches summary

| File | Change |
|---|---|
| `src/offers.ts` | **new** (~250 lines, §8.1) |
| `src/main.ts` | deed-detail offer block + handlers; venture-detail share-offer block; redeem box + preview/confirm; offers-out rows (~150 lines) |
| `src/ventures.ts` | none required (`transferShares` is reused as-is; its self-authorization was always caller-side) |
| `src/deeds.ts` | none |
| room doc schema | new `offers` Y.Map (nonce → mark). Additive; old clients ignore it. No tick-lane change — ysync-only, no version-lockstep note needed |

Tests worth writing with it (vitest, pure-function friendly): sign→encode→
decode round-trip, tamper detection (each signed field), expiry, wrong-
recipient, nonce burn, deed owner-match through the keyB64 bridge, share
maker-balance check, price≠0 refusal.

---

## 9. Open questions for review

1. **Bearer offers in v1?** Cheap to include (omit `toPub`) and it's the true
   Chia parity, but a leaked gift string is finders-keepers. Ship directed-only
   first, or both with the ⚠ warning copy?
2. **Venture-held deeds** (§5): accept the personal-owner+link representation
   for offers now, and slice `owner: 'vnt:<id>'` separately? (Recommended:
   yes / yes.)
3. **Who may cut a company→person deed offer** — v1 says the module's personal
   owner (matches every existing gate). Should any shareholder be able to,
   consistent with the V1 "any share = owner-equivalent" rule? (Recommended:
   no — deeds follow the personal owner until venture-held deeds exist.)
4. **Expiry default** — 7 days? And should the maker pick (1d / 7d / 30d)?
5. **`.ssfoffer` download** — worth the extra button, or is clipboard-only
   enough for v1? (The Chia wallet ships both; cost here is ~10 lines.)
6. Should redeemed-offer receipts surface anywhere visible (a module's
   transfer history from the `offers` map is free auditability)?
