/**
 * 📤 A transfer offer's shape and signed bytes (offers.ts), on their own.
 *
 * PURE: no Yjs, no doc binding, no keys. offers.ts keeps making, redeeming and
 * verifying offers; the bytes a maker signs live here so a module that only
 * needs to *recompute* them (a FAIR ONLY table's transfer record,
 * computedFairOnly.ts, and the owner's node, which ports them) doesn't pull
 * the doc-bound offer code in with them.
 */

export type OfferAsset =
  | { kind: 'deed'; roomId: string; roomName: string }
  | { kind: 'shares'; ventureId: string; ventureName: string; officeRoomId: string; count: number };

export interface TransferOffer {
  v: 1;
  kind: 'transfer-offer';
  asset: OfferAsset;
  makerPub: string;      // Ed25519 identity of the current holder (base64url)
  makerName: string;     // display; signed so a doctored preview can't rename the maker
  /** DIRECTED offer: only this identity may redeem. Absent ⇒ BEARER offer
   *  (first redeemer takes it — exactly a Chia offer file's semantics). */
  toPub?: string;
  /** COMPANY recipient (deed offers only): redeeming assigns the module to
   *  this venture as property. Redeemer must hold its shares. */
  toVentureId?: string;
  toVentureName?: string;
  /** Asking price. v1: MUST be 0 (gift). Non-zero parses but is refused at
   *  redemption — priced offers arrive with the Registry. */
  price: number;
  issuedAt: number;
  expiresAt: number;     // required — lost clipboard scraps must not haunt a module
  nonce: string;         // random one-time id — the replay-protection key
  sig: string;           // maker's signature over the canonical bytes
}

// ── Canonical sign-bytes (domain-tagged, explicit key order — the
//    contact-card recipe: `?? null` normalization on BOTH sign and verify) ────

function assetCanonical(a: OfferAsset): unknown {
  return a.kind === 'deed'
    ? { kind: 'deed', roomId: a.roomId, roomName: a.roomName }
    : { kind: 'shares', ventureId: a.ventureId, ventureName: a.ventureName,
        officeRoomId: a.officeRoomId, count: a.count };
}

/** The bytes the maker signs (the signature is over these, not their hash):
 *  JSON.stringify of the fields in this fixed order, an absent recipient as
 *  null. */
export function offerSignBytes(o: Omit<TransferOffer, 'sig'>): Uint8Array {
  const canonical = JSON.stringify({
    k: 'ssf-transfer-offer:v1',
    asset: assetCanonical(o.asset),
    makerPub: o.makerPub,
    makerName: o.makerName,
    toPub: o.toPub ?? null,
    toVentureId: o.toVentureId ?? null,
    toVentureName: o.toVentureName ?? null,
    price: o.price,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
    nonce: o.nonce,
  });
  return new TextEncoder().encode(canonical);
}
