/**
 * 🤝 Co-present settlement requests (brainstorming/transfer-offers-deeds-shares.md
 * §4.1 amendment — "the taker's feet settle" relaxed when the MAKER is here).
 *
 * A deed's authoritative record lives in the subject module's own doc, so a
 * receiver normally redeems standing in that module. But if the receiver can't
 * travel there and instead meets the MAKER in some other room, the maker — who
 * owns the module — can hand it over on their behalf. This module is the tiny
 * doc-carried protocol that lets the receiver ASK and the maker ANSWER:
 *
 *   - the receiver posts a REQUEST into the CURRENT room's doc (the room they
 *     share with the maker): the signed offer + who they are;
 *   - the maker's client (in that same room, observing) picks it up, opens the
 *     subject module in the background, settles the deed (offers.settleDeedInDoc),
 *     and marks the request settled/refused;
 *   - the receiver watches the same record flip to 'settled'.
 *
 * The request rides the shared room doc, so co-presence is enforced structurally
 * (only a client in that room sees it). No seed ever travels — the maker reaches
 * the module with their OWN saved pass (instant-only: if they can't, the request
 * is refused "unreachable"). Dev-phase LWW posture, like every transfer here.
 */
import * as Y from 'yjs';
import { getIdentityPub, signIdentity, verifyIdentity, verifyNameCert, signNameCert } from './keypair';
import type { DocSettleOwner } from './offers';

export type SettleStatus = 'pending' | 'settled' | 'refused';

export interface SettleRequest {
  /** The encoded offer (self-contained + signed — the maker re-verifies it). */
  offer: string;
  /** The requester's players-map id — the module owner it will become. BOUND
   *  by requesterSig below so a third party can't dictate it. */
  requesterPlayerId: string;
  requesterName: string;
  /** The requester's identity pubkey (base64url). The deed lands on THIS key. */
  requesterPub: string;
  /** Self-cert of name↔key (room-agnostic) so the module's owner surfaces
   *  verify the new owner's display name. */
  requesterKeySig: string;
  /** PROOF the requester holds requesterPub's private key AND commits to this
   *  exact (nonce, playerId, pub) — a third party who merely writes the shared
   *  settleReq map can't forge it, closing the confused-deputy hole. */
  requesterSig: string;
  requestedAt: number;
  status: SettleStatus;
  handledAt?: number;
  /** Plain-language reason when refused. */
  error?: string;
}

/** Canonical bytes the requester signs — domain-tagged + versioned, binding the
 *  ROOM the ask happens in, the offer nonce, the target owner playerId, and the
 *  receiving key together (so the proof can't be replayed into another room or
 *  re-pointed at a different owner id). */
function reqSignBytes(roomId: string, nonce: string, playerId: string, pub: string): Uint8Array {
  return new TextEncoder().encode(`ssf-copresent-settle:v1:${roomId}:${nonce}:${playerId}:${pub}`);
}

/** Receiver: build a SIGNED settle request for the room they're standing in. */
export function buildSettleRequest(
  roomId: string, nonce: string, offer: string, playerId: string, name: string,
): Omit<SettleRequest, 'status' | 'handledAt' | 'error'> {
  const pub = getIdentityPub();
  return {
    offer, requesterPlayerId: playerId, requesterName: name,
    requesterPub: pub,
    requesterKeySig: signNameCert(name),
    requesterSig: signIdentity(reqSignBytes(roomId, nonce, playerId, pub)),
    requestedAt: Date.now(),
  };
}

/**
 * Maker: verify a request proves the receiver holds the key it names AND was
 * signed for THIS room + nonce, and return the owner record to hand the deed
 * to — or null if the proof fails. This is the trust boundary: the owner is
 * taken from the SIGNED request, not from any attacker-writable players lookup.
 */
export function verifiedRequestOwner(roomId: string, nonce: string, req: SettleRequest): DocSettleOwner | null {
  if (typeof req.requesterPub !== 'string' || !req.requesterPub
    || typeof req.requesterSig !== 'string' || !req.requesterSig
    || typeof req.requesterKeySig !== 'string' || !req.requesterKeySig) return null;
  // Key possession + (roomId, nonce, playerId, pub) binding.
  if (!verifyIdentity(req.requesterPub, reqSignBytes(roomId, nonce, req.requesterPlayerId, req.requesterPub), req.requesterSig)) return null;
  // Name↔key self-cert (so the module's owner display verifies wherever it lands).
  if (!verifyNameCert(req.requesterName, req.requesterPub, req.requesterKeySig)) return null;
  return {
    playerId: req.requesterPlayerId,
    name: req.requesterName,
    keyB64: req.requesterPub,
    keySig: req.requesterKeySig,
  };
}

const MAP = 'settleReq';
/** A request the maker never answers is stale after this — GC'd on write, and
 *  the receiver's UI stops waiting. */
export const SETTLE_REQ_TTL_MS = 10 * 60 * 1000;

function reqMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(MAP);
}

/** Cap on the stored offer string — a self-contained deed offer is ~600 B; this
 *  bounds a hostile present client from bloating the shared doc. */
const MAX_OFFER_LEN = 4096;

function readReq(raw: unknown): SettleRequest | null {
  const r = raw as Partial<SettleRequest> | undefined;
  if (!r || typeof r.offer !== 'string' || r.offer.length > MAX_OFFER_LEN
    || typeof r.requesterPlayerId !== 'string' || !r.requesterPlayerId
    || typeof r.requesterPub !== 'string' || !r.requesterPub
    || typeof r.requesterKeySig !== 'string' || !r.requesterKeySig
    || typeof r.requesterSig !== 'string' || !r.requesterSig
    || typeof r.requestedAt !== 'number'
    || (r.status !== 'pending' && r.status !== 'settled' && r.status !== 'refused')) return null;
  return {
    offer: r.offer,
    requesterPlayerId: r.requesterPlayerId,
    requesterName: typeof r.requesterName === 'string' ? r.requesterName : 'Clone',
    requesterPub: r.requesterPub,
    requesterKeySig: r.requesterKeySig,
    requesterSig: r.requesterSig,
    requestedAt: r.requestedAt,
    status: r.status,
    handledAt: typeof r.handledAt === 'number' ? r.handledAt : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
  };
}

/** Effective age anchor — a resolved receipt lives a full TTL past resolution
 *  (not from the original ask), so a slow settle doesn't hand back a
 *  near-expired receipt the receiver never sees. */
function ageStamp(r: SettleRequest): number {
  return Math.max(r.requestedAt, r.handledAt ?? 0);
}

/** Sweep requests older than the TTL, then run `mut` in one transact. */
function withGc(doc: Y.Doc, mut: (m: Y.Map<unknown>) => void): void {
  const m = reqMap(doc);
  const cutoff = Date.now() - SETTLE_REQ_TTL_MS;
  doc.transact(() => {
    m.forEach((raw, key) => {
      const r = readReq(raw);
      if (r && ageStamp(r) < cutoff) m.delete(key);
    });
    mut(m);
  });
}

/** Receiver: ask the co-present maker to hand the deed over. Keyed by nonce so
 *  a re-ask overwrites rather than duplicates. */
export function postSettleRequest(
  doc: Y.Doc, nonce: string, req: Omit<SettleRequest, 'status' | 'handledAt' | 'error'>,
): void {
  withGc(doc, (m) => m.set(nonce, { ...req, status: 'pending' } satisfies SettleRequest));
}

/** Maker: mark a request settled (or refused with a reason). */
export function resolveSettleRequest(doc: Y.Doc, nonce: string, status: 'settled' | 'refused', error?: string): void {
  const m = reqMap(doc);
  const existing = readReq(m.get(nonce));
  if (!existing) return;
  doc.transact(() => m.set(nonce, {
    ...existing, status, handledAt: Date.now(), ...(error ? { error } : {}),
  } satisfies SettleRequest));
}

/** Receiver: drop my request (on success ack / cancel). */
export function clearSettleRequest(doc: Y.Doc, nonce: string): void {
  doc.transact(() => reqMap(doc).delete(nonce));
}

export function readSettleRequest(doc: Y.Doc, nonce: string): SettleRequest | null {
  return readReq(reqMap(doc).get(nonce));
}

/** All live (non-stale) requests, newest first. */
export function listSettleRequests(doc: Y.Doc): Array<{ nonce: string; req: SettleRequest }> {
  const out: Array<{ nonce: string; req: SettleRequest }> = [];
  const cutoff = Date.now() - SETTLE_REQ_TTL_MS;
  reqMap(doc).forEach((raw, nonce) => {
    const req = readReq(raw);
    if (req && ageStamp(req) >= cutoff) out.push({ nonce, req });
  });
  return out.sort((a, b) => ageStamp(b.req) - ageStamp(a.req));
}

/** Observe the request map (repaint the maker's inbox / the receiver's status). */
export function subscribeSettleReq(doc: Y.Doc, cb: () => void): () => void {
  const m = reqMap(doc);
  const h = () => cb();
  m.observe(h);
  return () => m.unobserve(h);
}
