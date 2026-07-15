/**
 * 🤝 Signed friend-of-friend introductions (keyed identity §7 M2)
 *
 * "Share other contacts in the background to make a stronger mesh." An
 * INTRODUCTION is a signed vouch that carries the subject's OWN signed contact
 * card — "I (introducer) have seen <subject> reachable; here is their card,
 * signed by them." Gossiped over a channel we already share with a friend
 * (their DM), it teaches our node routes to people we never exchanged cards
 * with — the subject becomes dialable via the mutual friend's knowledge.
 *
 * Two hard rules from the design's privacy split:
 *   1. CONSENT — proven by the SUBJECT, not the introducer. The subject's card
 *      carries a self-signed `discoverable` flag; ingest verifies the card
 *      against the subject's key and requires discoverable=true, so a
 *      trusted-but-malicious introducer cannot introduce a non-consenting
 *      subject (their card either isn't discoverable or can't be forged).
 *      Social edges (who-knows-whom) are never gossiped wholesale.
 *   2. TRUST — an ingested introduction is only accepted if (a) the subject's
 *      card verifies AND is discoverable, (b) the introducer's signature over
 *      the vouch verifies, AND (c) that introducer is someone we already trust.
 *      Unsigned / unvetted-introducer / non-discoverable intros are dropped —
 *      the sybil boundary (§7 M3).
 *
 * We trust the identity, not the route: an introducer could relay a stale card,
 * but a bad address simply fails to connect (verify the route by probing). The
 * introduced peer lands at 'introduced' trust — below direct contacts.
 */

import type { RoomMemberHint } from './network/protocol';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';
import { type ContactCard, verifyContactCard } from './contacts';

export interface Introduction {
  v: 1;
  kind: 'intro';
  card: ContactCard;             // the SUBJECT's own signed card (identity + consent + route)
  introducerPub: string;         // who vouches — signs this
  issuedAt: number;
  sig: string;                   // introducer's signature over the canonical bytes
}

/** Canonical bytes the INTRODUCER signs — binds the subject's key + card sig so
 *  a vouch can't be re-pointed at a different card. */
function introSignBytes(subjectPub: string, cardSig: string, introducerPub: string, issuedAt: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    k: 'ssf-intro:v1', subjectPub, cardSig, introducerPub, issuedAt,
  }));
}

/**
 * Build signed introductions from a set of subject CARDS (the caller supplies
 * the reconstructed signed cards of our discoverable, routable contacts). We are
 * the introducer. Only cards that are self-consented (discoverable) and carry a
 * route are ever emitted — no consent, no route, no gossip; never ourselves.
 */
export function makeIntroductions(cards: ContactCard[]): Introduction[] {
  const introducerPub = getIdentityPub();
  const out: Introduction[] = [];
  for (const card of cards) {
    if (!card || !card.discoverable) continue;      // CONSENT gate (subject-signed)
    if (!card.hints) continue;                      // nothing to vouch a route for
    if (card.pub === introducerPub) continue;       // don't introduce ourselves
    if (!verifyContactCard(card)) continue;         // only emit cards that actually verify
    const issuedAt = Date.now();
    const sig = signIdentity(introSignBytes(card.pub, card.sig, introducerPub, issuedAt));
    out.push({ v: 1, kind: 'intro', card, introducerPub, issuedAt, sig });
  }
  return out;
}

/** True iff the vouch is shaped right, the subject's CARD verifies + is
 *  discoverable (subject-proven consent), and the introducer's signature is
 *  valid. Does NOT decide introducer trust — that's the ingest caller's job. */
export function verifyIntroduction(intro: Introduction): boolean {
  if (!intro || intro.kind !== 'intro') return false;
  if (typeof intro.introducerPub !== 'string' || typeof intro.issuedAt !== 'number' || typeof intro.sig !== 'string') return false;
  if (!verifyContactCard(intro.card)) return false;          // subject self-signed
  if (!intro.card.discoverable) return false;                // subject consented
  return verifyIdentity(
    intro.introducerPub,
    introSignBytes(intro.card.pub, intro.card.sig, intro.introducerPub, intro.issuedAt),
    intro.sig,
  );
}

export interface IngestDeps {
  /** Is this introducer already trusted by us (a contact/friend in the store)? */
  isTrustedIntroducer: (introducerPub: string) => boolean;
  /** Record the subject as an 'introduced' peer with a route + who vouched. */
  record: (peer: { pub: string; name?: string; hints: RoomMemberHint; introducer: string }) => void;
}

export type IngestResult = 'accepted' | 'bad-signature' | 'not-discoverable' | 'untrusted-introducer' | 'self' | 'malformed' | 'no-route';

/**
 * Validate + accept one introduction. Gate order: shape → self → card verifies
 * & consented & introducer-signed → introducer-is-trusted → has a route. Returns
 * why it was rejected so callers can meter drops.
 */
export function ingestIntroduction(intro: Introduction, deps: IngestDeps): IngestResult {
  if (!intro || intro.kind !== 'intro' || !intro.card) return 'malformed';
  if (intro.card.pub === getIdentityPub()) return 'self';              // we know our own route
  if (!verifyContactCard(intro.card)) return 'bad-signature';
  if (!intro.card.discoverable) return 'not-discoverable';             // subject did NOT consent
  if (!verifyIntroduction(intro)) return 'bad-signature';              // introducer vouch invalid
  if (!deps.isTrustedIntroducer(intro.introducerPub)) return 'untrusted-introducer';
  const hints = intro.card.hints as RoomMemberHint | undefined;
  if (!hints) return 'no-route';
  deps.record({ pub: intro.card.pub, name: intro.card.name, hints, introducer: intro.introducerPub });
  return 'accepted';
}
