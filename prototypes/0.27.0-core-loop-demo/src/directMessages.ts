/**
 * 💬 Direct messages (keyed identity §8 — the friends DM boundary)
 *
 * A DM between two identities is just a PRIVATE two-person room, derived
 * deterministically from the pair of public keys so both sides compute the
 * exact same room without exchanging anything:
 *   - room id  = ssf-dm domain hash of the SORTED (pubA, pubB)   → same for both
 *   - room key = a second domain hash of the same sorted pair    → same for both
 * Opening a DM dials the friend using the reachability hints from their contact
 * card, then rides the SAME transport as a room prefetch (a dedicated
 * NetworkProvider + passive YjsSync on the derived room's doc — see
 * roomPasses.ts warm()). Messages live in a Yjs array on that doc; each is
 * SIGNED by its author and VERIFIED on display, and only the two pair members
 * are accepted as authors — so a relay (or anyone who guessed the room id)
 * cannot forge a message into the conversation.
 *
 * v1 is authenticated but NOT confidential: the derived key is possession-based
 * room access, not payload encryption (the node relays plaintext, same as every
 * room today). Confidentiality (ECDH-sealed payloads) is a later phase.
 */

import * as Y from 'yjs';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import type { RoomBootstrap, RoomMemberHint } from './network/protocol';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex } from '@noble/hashes/utils';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';

export interface DirectMessage {
  author: string;      // base64url Ed25519 pubkey of the sender
  authorName: string;  // denormalized for display
  text: string;
  ts: number;
  sig: string;         // base64url signature over the canonical message bytes
  /** Filled by verify() on read — never trusted from the wire. */
  verified?: boolean;
}

export interface DmDeps {
  /** Rewrite a peer-addressed bootstrap onto the LOCAL node (resolveBridgeBootstrap). */
  resolve: (boot: RoomBootstrap) => Promise<RoomBootstrap>;
  /** Our current display name. */
  myName: () => string;
}

export interface DmSession {
  peerPub: string;
  roomId: string;
  provider: NetworkProvider;
  sync: YjsSync;
  messages: Y.Array<DirectMessage>;
}

let deps: DmDeps | null = null;
const sessions = new Map<string, DmSession>();      // peerPub → live session
const opening = new Map<string, Promise<DmSession>>(); // single-flight per peer

export function initDirectMessages(d: DmDeps): void {
  deps = d;
}

// ── Deterministic pair derivation ────────────────────────────────────────────

function sortedPair(peerPub: string): [string, string] {
  const me = getIdentityPub();
  return me <= peerPub ? [me, peerPub] : [peerPub, me];
}

/** The DM room id for a peer — identical whichever side computes it. */
export function dmRoomIdFor(peerPub: string): string {
  const [a, b] = sortedPair(peerPub);
  const h = sha512(new TextEncoder().encode(`ssf-dm-room:v1:${a}|${b}`));
  return `dm-${bytesToHex(h).slice(0, 32)}`;
}

/** The DM room key — identical on both sides. NB: derived purely from the two
 *  PUBLIC keys, so it grants NO read confidentiality (anyone who has seen both
 *  pubkeys can recompute it and read the relayed plaintext). It is an addressing
 *  tag, not a secret. Messages are AUTHENTICATED (signed), not encrypted;
 *  confidentiality needs an X25519-ECDH shared secret (a later phase). */
export function dmRoomKeyFor(peerPub: string): string {
  const [a, b] = sortedPair(peerPub);
  const h = sha512(new TextEncoder().encode(`ssf-dm-key:v1:${a}|${b}`));
  let s = '';
  for (let i = 0; i < 32; i++) s += String.fromCharCode(h[i]);
  return btoa(s);
}

// ── Message signing / verification ───────────────────────────────────────────

function msgSignBytes(roomId: string, author: string, authorName: string, ts: number, text: string): Uint8Array {
  // authorName is bound so a validly-signed message can't carry a spoofed name.
  return new TextEncoder().encode(JSON.stringify({ k: 'ssf-dm-msg:v1', roomId, author, authorName, ts, text }));
}

/** True iff the message is signed by an author who is one of THIS DM's two
 *  members and the signature is valid — the anti-forgery check. */
export function verifyMessage(session: DmSession, m: DirectMessage): boolean {
  if (m.author !== getIdentityPub() && m.author !== session.peerPub) return false;
  if (typeof m.text !== 'string' || typeof m.ts !== 'number' || typeof m.sig !== 'string' || typeof m.authorName !== 'string') return false;
  return verifyIdentity(m.author, msgSignBytes(session.roomId, m.author, m.authorName, m.ts, m.text), m.sig);
}

// ── Session lifecycle ────────────────────────────────────────────────────────

/** Open (or reuse) a live DM session with a peer, dialing them via the hints
 *  from their contact card. Single-flight per peer so repeated taps share one
 *  connection. Rejects if we're offline / the peer isn't dialable. */
export function openDm(peerPub: string, peerHints: RoomMemberHint | null): Promise<DmSession> {
  const existing = sessions.get(peerPub);
  if (existing) return Promise.resolve(existing);
  const inflight = opening.get(peerPub);
  if (inflight) return inflight;
  const p = openDmInner(peerPub, peerHints).finally(() => opening.delete(peerPub));
  opening.set(peerPub, p);
  return p;
}

async function openDmInner(peerPub: string, peerHints: RoomMemberHint | null): Promise<DmSession> {
  if (!deps) throw new Error('DMs not initialised');
  const roomId = dmRoomIdFor(peerPub);
  const imported: RoomBootstrap = {
    v: 2,
    roomId,
    roomKeyB64: dmRoomKeyFor(peerPub),
    wtUrl: '',                 // resolve() fills wtUrl + cert from the local node
    certHashesB64: [],
    memberHints: peerHints ? [peerHints] : undefined,
    irohNodeId: peerHints?.irohNodeId,
    irohRelayUrls: peerHints?.irohRelayUrls,
    irohDirectAddrs: peerHints?.irohDirectAddrs,
  };
  const boot = await deps.resolve(imported);

  const provider = new NetworkProvider();
  await provider.connect(boot);
  const channel = await provider.openChannel('ysync');
  const sync = new YjsSync({ roomId, channel, bootRecord: () => provider.getBootRecord() });
  provider.onEnvelope((env: { kind?: string; room?: string; payload?: string }) => {
    if (env.kind === 'ysync') sync.ingestEnvelope(env);
  });
  await sync.start();

  const session: DmSession = {
    peerPub,
    roomId,
    provider,
    sync,
    messages: sync.doc.getArray<DirectMessage>('dm'),
  };
  sessions.set(peerPub, session);
  return session;
}

/** Max messages re-verified + rendered per read — bounds the O(n) verify cost
 *  if a relay (or anyone who guessed the room) floods the shared 'dm' array. */
const DM_RENDER_CAP = 300;

/** Append a signed message to the conversation. */
export function sendMessage(session: DmSession, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const author = getIdentityPub();
  const authorName = deps?.myName() ?? 'Clone';
  const ts = Date.now();
  const sig = signIdentity(msgSignBytes(session.roomId, author, authorName, ts, trimmed));
  session.messages.push([{ author, authorName, text: trimmed, ts, sig }]);
}

/** Verified, time-ordered snapshot of the conversation (unverifiable messages
 *  dropped — never rendered). Only the most recent DM_RENDER_CAP entries are
 *  verified so a flooded array can't turn each render into unbounded work. */
export function readMessages(session: DmSession): DirectMessage[] {
  const all = session.messages.toArray();
  const tail = all.length > DM_RENDER_CAP ? all.slice(all.length - DM_RENDER_CAP) : all;
  return tail
    .filter((m) => verifyMessage(session, m))
    .map((m) => ({ ...m, verified: true }))
    .sort((a, b) => a.ts - b.ts);
}

export function getOpenSession(peerPub: string): DmSession | undefined {
  return sessions.get(peerPub);
}

/** Tear down a DM's transport (keeps nothing live). */
export async function closeDm(peerPub: string): Promise<void> {
  const s = sessions.get(peerPub);
  if (!s) return;
  sessions.delete(peerPub);
  try { await s.sync.stop(); } catch { /* doc may be gone */ }
  try { await s.provider.disconnect(); } catch { /* transport may be gone */ }
}

/** Tear down ALL live DM sessions — e.g. on an identity switch, whose rooms are
 *  derived from the OLD pubkey pair and would otherwise sign/verify-mismatch. */
export async function closeAllDms(): Promise<void> {
  await Promise.all([...sessions.keys()].map((p) => closeDm(p)));
}
