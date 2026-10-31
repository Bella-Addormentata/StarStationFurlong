/**
 * 🤝 Co-host nodes (durability plan C3; the third room-board PR of #315):
 * which node each co-host runs, so a pass names it beside the host's and a
 * first-time visitor can load the room while the owner's machine is off.
 *
 * Why: every node whose browser was in a room serves it and keeps it on disk
 * (`Room.served`, `rooms/<id>.bin` in ssf-p2p-node). A co-host's node is one
 * of them, but a pass named only the host, so a visitor whose node couldn't
 * reach the host had nothing to load. Now:
 *  - a co-host's own game files its node in the room doc (`coHostNodes`,
 *    keyed by the co-host's identity key): node id, relay URLs, a few direct
 *    addresses and a stamp, signed with that key and bound to the room, so
 *    only the co-host can say which node is theirs;
 *  - every pass minted in the room carries the hints of the co-hosts the room
 *    lists (`coHosts`, roomRoles.ts), after the minter's node and the host's;
 *  - the room's own sync hands the local node the same hints, so a returning
 *    visitor's node dials the co-hosts as well as the host.
 *
 * A hint is a route, never trust: iroh connects by key, so only the node a
 * hint names can answer, and what it serves is room state every member's
 * node already merges. The co-host grant itself is unsigned (roomRoles.ts,
 * dev-phase like door policy), so a modified game can list itself as a
 * co-host; the most that buys is one more route in passes, which any
 * member's pass already forwards (`collectMemberHints`). Signed grants are
 * durability step C1's.
 */

import * as Y from 'yjs';
import { getIdentityPub, signIdentity, verifyIdentityStrict } from './keypair';
import type { RoomMemberHint } from './network/protocol';

export const CO_HOST_NODES_MAP = 'coHostNodes';
/** Co-host hints one pass carries, at most (the longest-standing first). */
export const MAX_CO_HOST_HINTS = 8;
const MAX_RELAYS = 4;
const MAX_ADDRS = 6;
const MAX_ROUTE = 256;
const MAX_PUB = 64;
/** A record is refreshed at least this often, so a reader can tell a node
 *  that is still someone's from one long gone. */
export const REFRESH_MS = 7 * 24 * 3600_000;
/** New direct addresses alone rewrite the record at most this often: they
 *  move with every network the co-host's machine joins, and the DHT finds a
 *  node by id anyway. */
export const ADDRS_REFRESH_MS = 3600_000;
/** A record older than this is no longer a route (its node may be gone). */
export const MAX_AGE_MS = 30 * 24 * 3600_000;
/** A stamp may run this far ahead of the reader's clock. */
const MAX_FUTURE_SKEW_MS = 10 * 60_000;
const NODE_RE = /^[0-9a-f]{64}$/;

export interface CoHostNode {
  v: 1;
  node: string;
  relays?: string[];
  addrs?: string[];
  at: number;
  sig: string;
}

export interface CoHostSigner {
  pub: string;
  sign: (bytes: Uint8Array) => string;
}

export const localCoHostSigner = (): CoHostSigner => ({ pub: getIdentityPub(), sign: (b) => signIdentity(b) });

/** The bytes a co-host signs: its key, the room, its node and routes, the
 *  stamp. Binding the room stops a record being copied into another room. */
export function coHostNodeSignBytes(roomId: string, pub: string, r: Omit<CoHostNode, 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    k: 'ssf-cohost-node:v1',
    roomId,
    pub,
    node: r.node,
    relays: r.relays ?? [],
    addrs: r.addrs ?? [],
    at: r.at,
  }));
}

const routes = (value: unknown, max: number): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  for (const s of value) if (typeof s !== 'string' || s.length === 0 || s.length > MAX_ROUTE) return null;
  return value as string[];
};

/** A stored value's record fields, shape-checked (signature NOT checked), or
 *  null. Fails closed. */
export function coHostNodeFromWire(raw: unknown): CoHostNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.node !== 'string' || !NODE_RE.test(r.node)) return null;
  const relays = routes(r.relays, MAX_RELAYS);
  const addrs = routes(r.addrs, MAX_ADDRS);
  if (!relays || !addrs) return null;
  if (!Number.isSafeInteger(r.at) || (r.at as number) <= 0) return null;
  if (typeof r.sig !== 'string' || r.sig.length === 0 || r.sig.length > 128) return null;
  return {
    v: 1,
    node: r.node,
    ...(relays.length ? { relays } : {}),
    ...(addrs.length ? { addrs } : {}),
    at: r.at as number,
    sig: r.sig,
  };
}

/** The record a co-host files for its node: routes trimmed to the caps. */
export function signCoHostNode(roomId: string, hint: RoomMemberHint, at: number, signer: CoHostSigner): CoHostNode | null {
  if (!NODE_RE.test(hint.irohNodeId)) return null;
  const pick = (list: string[] | undefined, max: number) =>
    [...new Set((list ?? []).filter((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_ROUTE))].sort().slice(0, max);
  const relays = pick(hint.irohRelayUrls, MAX_RELAYS);
  const addrs = pick(hint.irohDirectAddrs, MAX_ADDRS);
  const unsigned = {
    v: 1 as const,
    node: hint.irohNodeId,
    ...(relays.length ? { relays } : {}),
    ...(addrs.length ? { addrs } : {}),
    at: Math.floor(at),
  };
  return { ...unsigned, sig: signer.sign(coHostNodeSignBytes(roomId, signer.pub, unsigned)) };
}

export interface CoHostGrantLike {
  pub: string;
  grantedAt: number;
}

export interface CoHostReadCtx {
  roomId: string;
  now: number;
  verify?: (pub: string, bytes: Uint8Array, sig: string) => boolean;
}

/** The route hints of the room's co-hosts: for each grant, longest-standing
 *  first, the record its own key signed for this room, if fresh. One hint per
 *  node, at most MAX_CO_HOST_HINTS. Pure. */
export function readCoHostHints(
  grants: readonly CoHostGrantLike[],
  recordOf: (pub: string) => unknown,
  ctx: CoHostReadCtx,
): RoomMemberHint[] {
  const verify = ctx.verify ?? verifyIdentityStrict;
  const out: RoomMemberHint[] = [];
  const nodes = new Set<string>();
  const sorted = [...grants].sort((a, b) => a.grantedAt - b.grantedAt || (a.pub < b.pub ? -1 : a.pub > b.pub ? 1 : 0));
  for (const g of sorted) {
    if (out.length >= MAX_CO_HOST_HINTS) break;
    if (typeof g.pub !== 'string' || g.pub.length === 0 || g.pub.length > MAX_PUB) continue;
    const r = coHostNodeFromWire(recordOf(g.pub));
    if (!r || nodes.has(r.node)) continue;
    if (r.at > ctx.now + MAX_FUTURE_SKEW_MS || ctx.now - r.at > MAX_AGE_MS) continue;
    if (!verify(g.pub, coHostNodeSignBytes(ctx.roomId, g.pub, r), r.sig)) continue;
    nodes.add(r.node);
    out.push({ irohNodeId: r.node, irohRelayUrls: r.relays, irohDirectAddrs: r.addrs });
  }
  return out;
}

// ── Keepers: the owner and the co-hosts ─────────────────────────────────────

/** Map names the keeper reader looks in (roomRoles.ts, main.ts roomInfo). */
const CO_HOSTS_MAP = 'coHosts';

/** The room owner's identity key as a doc names it (main.ts roomOwnerInfo):
 *  `roomInfo.owner` names a player whose `players` entry holds the key.
 *  Never for the legacy marker, which names no player. */
export function ownerPubIn(doc: Y.Doc): string | undefined {
  const owner = doc.getMap('roomInfo').get('owner');
  if (typeof owner !== 'string' || owner.length === 0 || owner === 'Local-Clone') return undefined;
  const entry = doc.getMap('players').get(owner) as { keyB64?: unknown } | undefined;
  return typeof entry?.keyB64 === 'string' && entry.keyB64.length > 0 ? entry.keyB64 : undefined;
}

/** Who keeps a room: its owner first, then its co-hosts as the doc lists
 *  them (`coHosts`). */
export function keepersIn(doc: Y.Doc, ownerPub = ownerPubIn(doc)): CoHostGrantLike[] {
  const out: CoHostGrantLike[] = ownerPub ? [{ pub: ownerPub, grantedAt: 0 }] : [];
  for (const v of doc.getMap(CO_HOSTS_MAP).values()) {
    const g = v as { pub?: unknown; grantedAt?: unknown } | null;
    if (g && typeof g.pub === 'string' && g.pub !== ownerPub && Number.isFinite(g.grantedAt)) {
      out.push({ pub: g.pub, grantedAt: Math.max(1, g.grantedAt as number) });
    }
  }
  return out;
}

/** 🤝 The nodes that keep a room, from its own doc: each keeper's record,
 *  signed by that keeper's key for this room, and fresh. What a node such
 *  as these proves it built (nodeProof.ts) a tab takes as the room's own
 *  state (YjsSync `keeperNode`). Reads the doc it is given, not the bound
 *  store: a warm neighbour's or a far door's session asks too. */
export function keeperNodesIn(doc: Y.Doc, roomId: string, now = Date.now()): Set<string> {
  const records = doc.getMap(CO_HOST_NODES_MAP);
  const hints = readCoHostHints(keepersIn(doc), (pub) => records.get(pub), { roomId, now, verify: cachedVerify });
  return new Set(hints.map((h) => h.irohNodeId));
}

/** YjsSync's `keeperNode` for any room session. */
export const keeperNodeTrust = {
  keeperNode: (node: string, doc: Y.Doc, roomId: string): boolean => keeperNodesIn(doc, roomId).has(node),
};

/** Whether a co-host's stored record should be rewritten with `next`. */
export function needsRefile(stored: CoHostNode | null, next: CoHostNode, now: number): boolean {
  if (!stored) return true;
  if (stored.node !== next.node) return true;
  if ((stored.relays ?? []).join('\n') !== (next.relays ?? []).join('\n')) return true;
  if (now - stored.at >= REFRESH_MS || stored.at > now + MAX_FUTURE_SKEW_MS) return true;
  if ((stored.addrs ?? []).join('\n') !== (next.addrs ?? []).join('\n')) return now - stored.at >= ADDRS_REFRESH_MS;
  return false;
}

// ── The bound store ──────────────────────────────────────────────────────────

let boundDoc: Y.Doc | null = null;
let nodesMap: Y.Map<unknown> | null = null;
/** Verdicts by key, signature and signed bytes (never key and signature
 *  alone: an altered record re-filed with an old signature must not borrow a
 *  genuine record's verdict). */
const verdicts = new Map<string, boolean>();
const MAX_VERDICTS = 64;

function cachedVerify(pub: string, bytes: Uint8Array, sig: string): boolean {
  const key = `${pub}|${sig}|${new TextDecoder().decode(bytes)}`;
  const hit = verdicts.get(key);
  if (hit !== undefined) return hit;
  const ok = verifyIdentityStrict(pub, bytes, sig);
  if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value as string);
  verdicts.set(key, ok);
  return ok;
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && nodesMap !== null;
}

export function bindCoHostNodes(doc: Y.Doc): void {
  boundDoc = doc;
  nodesMap = doc.getMap(CO_HOST_NODES_MAP);
}

/** The co-host hints of the bound room, for a pass or the node's dial. */
export function coHostHintsHere(roomId: string, grants: readonly CoHostGrantLike[], now = Date.now()): RoomMemberHint[] {
  if (!docAlive() || !roomId) return [];
  return readCoHostHints(grants, (pub) => nodesMap!.get(pub), { roomId, now, verify: cachedVerify });
}

/** A co-host's game files (or refreshes) its node's record; anyone else's
 *  game takes down a record it filed under its own key once it is no longer
 *  a co-host. Returns what it did. */
export function fileMyCoHostNode(
  roomId: string,
  amCoHost: boolean,
  hint: RoomMemberHint | null,
  now = Date.now(),
  signer: CoHostSigner = localCoHostSigner(),
): 'filed' | 'removed' | 'kept' {
  if (!docAlive() || !roomId) return 'kept';
  const storedRaw = nodesMap!.get(signer.pub);
  if (!amCoHost) {
    if (storedRaw === undefined) return 'kept';
    boundDoc!.transact(() => { nodesMap!.delete(signer.pub); });
    return 'removed';
  }
  if (!hint) return 'kept';
  const next = signCoHostNode(roomId, hint, now, signer);
  if (!next) return 'kept';
  const stored = coHostNodeFromWire(storedRaw);
  const genuine = stored && verifyIdentityStrict(signer.pub, coHostNodeSignBytes(roomId, signer.pub, stored), stored.sig) ? stored : null;
  if (!needsRefile(genuine, next, now)) return 'kept';
  boundDoc!.transact(() => { nodesMap!.set(signer.pub, next); });
  return 'filed';
}

/** The owner revoked a co-host: its record goes with the grant. */
export function forgetCoHostNode(pub: string): void {
  if (!docAlive() || !nodesMap!.has(pub)) return;
  boundDoc!.transact(() => { nodesMap!.delete(pub); });
}

/** Test seam: forget the verdict cache. */
export function resetCoHostNodesForTest(): void {
  verdicts.clear();
  boundDoc = null;
  nodesMap = null;
}
