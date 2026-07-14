/**
 * 🕸️ Mesh peer store (keyed identity §7 M1 — the self-strengthening substrate)
 *
 * "Use every contact we come across to help build and maintain the serverless
 * network." Today's mesh gossip is real but EPHEMERAL — the node's per-room
 * remote_peers dies on leave. This is the durable, browser-side substrate: a
 * bounded, trust-weighted pool of every identity + reachability we encounter,
 * so the network densifies from WHO YOU KNOW with no central index.
 *
 * What feeds it (harvest):
 *   - friends + contacts (their cards carry pubkey + reachability hints),
 *   - players met in rooms (their self-cert gives pubkey + name),
 *   - later (M2) signed friend-of-friend introductions.
 * What draws from it (consume): DM / room dialing asks hintsFor(pub) when it
 * lacks direct reachability — a mutual's node becomes a path to an otherwise
 * un-dialable peer (the sovereign alternative to relay servers; M3/M4 rank and
 * relay).
 *
 * TRUST TIERS rank dial candidates and decide who survives the cap (M3's sybil
 * mitigation: free key-minting can't crowd real contacts out of a bounded
 * store). Reachability is shared; the SOCIAL GRAPH is never gossiped wholesale
 * — only a peer's own `discoverable` flag opts them into introductions (M2).
 */

import type { RoomMemberHint } from './network/protocol';

export type TrustTier = 'friend' | 'contact' | 'introduced' | 'room' | 'unvetted';

/** Higher = dialed first, evicted last. The web-of-trust the keyed identity
 *  provides — a direct contact outranks a friend-of-friend outranks someone we
 *  merely shared a room with outranks an unvetted address. */
export const TRUST_RANK: Record<TrustTier, number> = {
  friend: 4, contact: 3, introduced: 2, room: 1, unvetted: 0,
};

export interface MeshPeer {
  pub: string;                    // Ed25519 identity pubkey (base64url)
  name?: string;
  hints: RoomMemberHint | null;   // last-known reachability (null = identity only)
  trust: TrustTier;
  introducer?: string;            // pubkey that vouched (for 'introduced')
  firstSeen: number;
  lastSeen: number;
}

const STORAGE_KEY = 'ssf-mesh-peers';
const PEER_CAP = 500;             // hard bound — LRU/least-trusted eviction over this

let peers = new Map<string, MeshPeer>();
const listeners = new Set<() => void>();
let loaded = false;
/** Our own pubkey — never stored as a peer of ourselves. */
let selfPub: (() => string) | null = null;

// ── Persistence ──────────────────────────────────────────────────────────────

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (p && typeof p.pub === 'string' && typeof p.trust === 'string') peers.set(p.pub, p);
        }
      }
    }
  } catch { /* privacy mode / corrupt — start empty */ }
  loaded = true;
}

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...peers.values()])); } catch { /* session-only */ }
}

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[mesh] listener threw:', e); }
  }
}

// ── Eviction (bounded store) ─────────────────────────────────────────────────

/** Enforce the cap: drop the least valuable peers — lowest trust first, then
 *  least-recently-seen. Never a peer we've been given fresh (caller upserts
 *  before calling). */
function enforceCap(): void {
  if (peers.size <= PEER_CAP) return;
  const sorted = [...peers.values()].sort((a, b) => {
    const t = TRUST_RANK[a.trust] - TRUST_RANK[b.trust];
    return t !== 0 ? t : a.lastSeen - b.lastSeen; // lowest trust + oldest first
  });
  const toDrop = peers.size - PEER_CAP;
  for (let i = 0; i < toDrop; i++) peers.delete(sorted[i].pub);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initPeerStore(deps: { selfPub: () => string }): void {
  selfPub = deps.selfPub;
  if (!loaded) load();
  notify();
}

export interface RecordPeerInput {
  pub: string;
  name?: string;
  hints?: RoomMemberHint | null;
  trust: TrustTier;
  introducer?: string;
}

/**
 * Upsert a peer. Merges conservatively: trust only ever UPGRADES (a room
 * encounter never demotes a friend), hints refresh when non-null, name fills
 * when known. Ignores ourselves. Returns the stored peer (or null if self).
 */
export function recordPeer(input: RecordPeerInput): MeshPeer | null {
  if (!loaded) load();
  if (selfPub && input.pub === selfPub()) return null;   // not a peer of ourselves
  const now = Date.now();
  const existing = peers.get(input.pub);
  if (existing) {
    if (TRUST_RANK[input.trust] > TRUST_RANK[existing.trust]) {
      existing.trust = input.trust;
      existing.introducer = input.introducer ?? existing.introducer;
    }
    if (input.hints) existing.hints = input.hints;
    if (input.name) existing.name = input.name;
    existing.lastSeen = now;
    persist(); notify();
    return existing;
  }
  const peer: MeshPeer = {
    pub: input.pub,
    name: input.name,
    hints: input.hints ?? null,
    trust: input.trust,
    introducer: input.introducer,
    firstSeen: now,
    lastSeen: now,
  };
  peers.set(input.pub, peer);
  enforceCap();
  persist(); notify();
  return peers.get(input.pub) ?? null;
}

export function getPeer(pub: string): MeshPeer | undefined {
  if (!loaded) load();
  return peers.get(pub);
}

export function listPeers(): MeshPeer[] {
  if (!loaded) load();
  return [...peers.values()];
}

export function peerCount(): number {
  if (!loaded) load();
  return peers.size;
}

export function subscribePeers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Best-known reachability for a pubkey, for dialing. Returns the peer's own
 * hints if we have them; null if we know the identity but no route (a later
 * introduction / DHT re-resolution by pubkey can fill it). M3/M4 extend this to
 * return a trust-ranked list of *introducer* paths when there's no direct route.
 */
export function hintsFor(pub: string): RoomMemberHint | null {
  return peers.get(pub)?.hints ?? null;
}

/** Trust-ranked dial candidates (highest trust, then most-recently-seen first)
 *  that actually have a route — the ordering M3's dial policy consumes. Never
 *  surfaces unvetted peers above vetted ones. */
export function dialCandidates(): MeshPeer[] {
  return listPeers()
    .filter((p) => p.hints != null)
    .sort((a, b) => {
      const t = TRUST_RANK[b.trust] - TRUST_RANK[a.trust];
      return t !== 0 ? t : b.lastSeen - a.lastSeen;
    });
}

/** Test/reset hook — clears the in-memory + persisted store. */
export function _clearPeerStore(): void {
  peers = new Map();
  persist();
  notify();
}
