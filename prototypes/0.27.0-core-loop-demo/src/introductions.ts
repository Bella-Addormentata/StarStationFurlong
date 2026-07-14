/**
 * 🤝 Signed friend-of-friend introductions (keyed identity §7 M2)
 *
 * "Share other contacts in the background to make a stronger mesh." An
 * INTRODUCTION is a signed vouch: "I (introducer) know that <subject> is
 * reachable at <hints>." Gossiped over a channel we already share with a friend
 * (their DM), it teaches our node routes to people we never exchanged cards
 * with — the subject becomes dialable via the mutual friend's knowledge.
 *
 * Two hard rules from the design's privacy split:
 *   1. CONSENT — only a subject who set their own self-signed `discoverable`
 *      flag is ever introduced (enforced maker-side: makeIntroductions filters
 *      to discoverable contacts). Social edges (who-knows-whom) are never
 *      gossiped wholesale — we share a reachable pubkey, not our friend list.
 *   2. TRUST — an ingested introduction is only accepted if (a) its signature
 *      verifies against the introducerPub AND (b) that introducer is someone we
 *      already trust (a contact/friend in our peer store). An unsigned or
 *      unvetted-introducer intro is dropped — the sybil boundary (§7 M3).
 *
 * We trust the identity, not the route: an introducer could lie about an
 * address, but a bad address simply fails to connect (verify the route by
 * probing, per the threat model). The introduced peer lands at 'introduced'
 * trust — below direct contacts, so it can't crowd them out of the bounded store.
 */

import type { RoomMemberHint } from './network/protocol';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';

export interface Introduction {
  v: 1;
  kind: 'intro';
  subjectPub: string;            // who is being introduced
  subjectName?: string;
  hints: RoomMemberHint;         // the subject's reachability (the vouch)
  introducerPub: string;         // who vouches — signs this
  issuedAt: number;
  sig: string;                   // introducer's signature over the canonical bytes
}

/** A contact as makeIntroductions needs to see it (subset of contacts.Contact). */
export interface IntroducibleContact {
  pub: string;
  name: string;
  hints?: unknown;
  discoverable?: boolean;
}

function introSignBytes(subjectPub: string, subjectName: string, hints: unknown, introducerPub: string, issuedAt: number): Uint8Array {
  const canonical = JSON.stringify({
    k: 'ssf-intro:v1', subjectPub, subjectName, hints: hints ?? null, introducerPub, issuedAt,
  });
  return new TextEncoder().encode(canonical);
}

/**
 * Build signed introductions for OUR discoverable, routable contacts. We are
 * the introducer. Only contacts who (a) consented (`discoverable`) and (b) we
 * actually have a route for are ever emitted — no consent, no route, no gossip.
 */
export function makeIntroductions(contacts: IntroducibleContact[]): Introduction[] {
  const introducerPub = getIdentityPub();
  const out: Introduction[] = [];
  for (const c of contacts) {
    if (!c.discoverable) continue;                 // CONSENT gate
    const hints = c.hints as RoomMemberHint | undefined;
    if (!hints) continue;                          // nothing to vouch a route for
    if (c.pub === introducerPub) continue;         // don't introduce ourselves
    const issuedAt = Date.now();
    const sig = signIdentity(introSignBytes(c.pub, c.name, hints, introducerPub, issuedAt));
    out.push({ v: 1, kind: 'intro', subjectPub: c.pub, subjectName: c.name, hints, introducerPub, issuedAt, sig });
  }
  return out;
}

/** True iff the introduction is shaped right AND validly signed by its claimed
 *  introducer. Does NOT decide trust — that's the ingest caller's job. */
export function verifyIntroduction(intro: Introduction): boolean {
  if (!intro || intro.kind !== 'intro') return false;
  if (typeof intro.subjectPub !== 'string' || typeof intro.introducerPub !== 'string') return false;
  if (typeof intro.issuedAt !== 'number' || typeof intro.sig !== 'string' || !intro.hints) return false;
  return verifyIdentity(
    intro.introducerPub,
    introSignBytes(intro.subjectPub, intro.subjectName ?? '', intro.hints, intro.introducerPub, intro.issuedAt),
    intro.sig,
  );
}

export interface IngestDeps {
  /** Is this introducer already trusted by us (a contact/friend in the store)? */
  isTrustedIntroducer: (introducerPub: string) => boolean;
  /** Record the subject as an 'introduced' peer with a route + who vouched. */
  record: (peer: { pub: string; name?: string; hints: RoomMemberHint; introducer: string }) => void;
}

export type IngestResult = 'accepted' | 'bad-signature' | 'untrusted-introducer' | 'self' | 'malformed';

/**
 * Validate + accept one introduction. The gate order matters: shape → signature
 * (can't forge who vouched) → introducer-is-trusted (sybil boundary) → not-self.
 * Returns why it was rejected so callers can meter drops.
 */
export function ingestIntroduction(intro: Introduction, deps: IngestDeps): IngestResult {
  if (!intro || intro.kind !== 'intro') return 'malformed';
  if (intro.subjectPub === getIdentityPub()) return 'self';         // we know our own route
  if (!verifyIntroduction(intro)) return 'bad-signature';
  if (!deps.isTrustedIntroducer(intro.introducerPub)) return 'untrusted-introducer';
  deps.record({ pub: intro.subjectPub, name: intro.subjectName, hints: intro.hints, introducer: intro.introducerPub });
  return 'accepted';
}
