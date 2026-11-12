/**
 * 🤝 Room holders: a room is served by every computer that holds it (owner
 * direction, 2026-11-12: "remove the 'co-host' selection functionality and
 * simply let room passes get module data from anyone with the data").
 *
 * Why: every node whose browser was in a room keeps it on disk and answers
 * for it (`Room.served`, `rooms/<id>.bin` in ssf-p2p-node), and signs what it
 * builds (nodeProof.ts). Until now only the nodes the owner had picked as
 * co-hosts (a request, an accept, a revoke: roomRoles.ts) were named in passes
 * and counted, so a room with no co-host picked had one node to load from,
 * and went dark for new visitors whenever the owner's machine was off. Now
 * nobody is picked:
 *  - every game in a room files its computer's node in the room doc
 *    (`coHostNodes`, keyed by the player's identity key) once the room's own
 *    state has reached it, so a filed node is one that held the room. The
 *    record is signed with that key and bound to the room, so only the player
 *    can say which node is theirs;
 *  - every pass minted in the room names the owner's node and the most recent
 *    holders, and the room's own sync hands the local node the same hints, so
 *    a visitor's node dials them all;
 *  - a tab counts a copy as the room's own state when a filed holder's node
 *    proves it built it (YjsSync `holderNode`), unless that copy is empty.
 *
 * What a record carries: the node's id and relay URLs, and a stamp. Direct
 * addresses ride only in the owner's own record (the owner's pass names them
 * already); another holder is found by its id, as its own node chose to be
 * findable. One switch, on by default, lets a player keep their computer off
 * the list (`listsThisComputer`).
 *
 * Who can read it: everyone who holds the room's key. For a public room (the
 * welcome room's key ships in every build) that is anyone, so such a room
 * names the nodes of its most recent visitors, and a node publishes its
 * addresses under its id by default (the Mainline DHT). That is the price of
 * the direction above, and what the switch is for.
 *
 * What stays on this computer: a note of the rooms whose state has reached
 * this install, each with the node that held the copy then (`noteRoomHeld`).
 * It is not the list and is never sent. It lets a player's own game count
 * their own computer's copy of a room once their record is gone from the
 * room (the switch turned off, or cleared from a full list), so such a
 * player can still open, alone, a room their computer holds.
 *
 * What a record is not: authority, or proof that a copy is complete or honest.
 * A hint is a route (iroh connects by key, so only the node a hint names can
 * answer), and what a holder serves merges into state every member's node
 * already merges. A copy may be old; copies merge. A modified game can file a
 * record without holding anything: the most that buys is one more route in
 * passes and, for a visitor who reaches only that node, a room that counts as
 * loaded with what that node sent. Owner-signed keepers were the planned guard
 * (durability plan Tier C); the direction above trades it for a room that
 * anyone who holds it can serve.
 *
 * Wire: the map's name and the signed bytes' tag are unchanged from the
 * co-host records, so an owner's or co-host's record filed by an older build
 * still counts here, and an older build still reads the owner's. The grant
 * maps (`coHostRequests`, `coHosts`) are no longer read or written.
 */

import * as Y from 'yjs';
import { getIdentityPub, signIdentity, verifyIdentityStrict } from './keypair';
import type { RoomMemberHint } from './network/protocol';

/** The room-doc map of holder records (its wire name predates this file). */
export const HOLDER_NODES_MAP = 'coHostNodes';
/** Holder hints one pass carries, at most: the owner's, then the freshest. */
export const MAX_HOLDER_HINTS = 8;
/** Holders a room lists, at most: the freshest by stamp. A reader checks no
 *  more signatures than this, and a filer clears what lies beyond it. */
export const MAX_HOLDERS = 64;
/** Records one filing clears, at most (stale, malformed, past the list). */
export const MAX_PRUNE = 16;
const MAX_RELAYS = 4;
const MAX_ADDRS = 6;
const MAX_ROUTE = 256;
const MAX_PUB = 64;
/** A record is refreshed at least this often, so a reader can tell a node
 *  that is still someone's from one long gone. */
export const REFRESH_MS = 7 * 24 * 3600_000;
/** New direct addresses alone rewrite the record at most this often: they
 *  move with every network the machine joins, and the DHT finds a node by id
 *  anyway. */
export const ADDRS_REFRESH_MS = 3600_000;
/** A record older than this is no longer a route (its node may be gone). */
export const MAX_AGE_MS = 30 * 24 * 3600_000;
/** A record older than this may be cleared by any filer. Twice the route age:
 *  two clocks that disagree never clear what the other still reads. */
export const PRUNE_AGE_MS = 2 * MAX_AGE_MS;
/** A stamp may run this far ahead of the reader's clock. */
const MAX_FUTURE_SKEW_MS = 10 * 60_000;
const NODE_RE = /^[0-9a-f]{64}$/;

export interface HolderNode {
  v: 1;
  node: string;
  relays?: string[];
  addrs?: string[];
  at: number;
  sig: string;
}

export interface HolderSigner {
  pub: string;
  sign: (bytes: Uint8Array) => string;
}

export const localHolderSigner = (): HolderSigner => ({ pub: getIdentityPub(), sign: (b) => signIdentity(b) });

/** The bytes a holder signs: its key, the room, its node and routes, the
 *  stamp. Binding the room stops a record being copied into another room.
 *  (The tag is the co-host record's: the wire did not change.) */
export function holderNodeSignBytes(roomId: string, pub: string, r: Omit<HolderNode, 'sig'>): Uint8Array {
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
export function holderNodeFromWire(raw: unknown): HolderNode | null {
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

/** The record a holder files for its node: routes trimmed to the caps, and
 *  direct addresses only when `withAddrs` (the owner's own record). */
export function signHolderNode(roomId: string, hint: RoomMemberHint, at: number, signer: HolderSigner, withAddrs = true): HolderNode | null {
  if (!NODE_RE.test(hint.irohNodeId)) return null;
  const pick = (list: string[] | undefined, max: number) =>
    [...new Set((list ?? []).filter((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_ROUTE))].sort().slice(0, max);
  const relays = pick(hint.irohRelayUrls, MAX_RELAYS);
  const addrs = withAddrs ? pick(hint.irohDirectAddrs, MAX_ADDRS) : [];
  const unsigned = {
    v: 1 as const,
    node: hint.irohNodeId,
    ...(relays.length ? { relays } : {}),
    ...(addrs.length ? { addrs } : {}),
    at: Math.floor(at),
  };
  return { ...unsigned, sig: signer.sign(holderNodeSignBytes(roomId, signer.pub, unsigned)) };
}

// ── Reading the list ─────────────────────────────────────────────────────────

/** Whether a doc holds the room's own state: an owner and a name on record
 *  (what a join waits for, main.ts initialRoomStateReady). A copy without
 *  them is empty — a node that only registered the room, or a game still
 *  waiting for it — and is nobody's to serve or to count. */
export function roomStateIn(doc: Y.Doc): boolean {
  const info = doc.getMap('roomInfo');
  const owner = info.get('owner');
  return typeof owner === 'string' && owner.length > 0 && info.has('name');
}

/** The room owner's identity key as a doc names it (main.ts roomOwnerInfo):
 *  `roomInfo.owner` names a player whose `players` entry holds the key.
 *  Never for the legacy marker, which names no player. */
export function ownerPubIn(doc: Y.Doc): string | undefined {
  const owner = doc.getMap('roomInfo').get('owner');
  if (typeof owner !== 'string' || owner.length === 0 || owner === 'Local-Clone') return undefined;
  const entry = doc.getMap('players').get(owner) as { keyB64?: unknown } | undefined;
  return typeof entry?.keyB64 === 'string' && entry.keyB64.length > 0 ? entry.keyB64 : undefined;
}

/** One listed holder: the key that filed it and the record it signed. */
export interface Holder {
  pub: string;
  record: HolderNode;
}

export interface HolderReadCtx {
  roomId: string;
  now: number;
  /** The owner's key, when known: its record leads the list. */
  ownerPub?: string;
  verify?: (pub: string, bytes: Uint8Array, sig: string) => boolean;
  /** Holders at most (MAX_HOLDERS by default). */
  max?: number;
}

const fresh = (r: HolderNode, now: number): boolean => r.at <= now + MAX_FUTURE_SKEW_MS && now - r.at <= MAX_AGE_MS;

/** The well-shaped, fresh records of `entries`, the owner's first and then
 *  the most recently stamped (ties by key), cut to MAX_HOLDERS: the ones a
 *  reader goes on to check. Signatures NOT checked. */
function candidates(entries: Iterable<[string, unknown]>, now: number, ownerPub?: string): Holder[] {
  const out: Holder[] = [];
  for (const [pub, raw] of entries) {
    if (typeof pub !== 'string' || pub.length === 0 || pub.length > MAX_PUB) continue;
    const record = holderNodeFromWire(raw);
    if (record && fresh(record, now)) out.push({ pub, record });
  }
  const rank = (h: Holder): number => (h.pub === ownerPub ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || b.record.at - a.record.at || (a.pub < b.pub ? -1 : a.pub > b.pub ? 1 : 0));
  return out.slice(0, MAX_HOLDERS);
}

/** 🤝 The holders a room lists: each record signed by the key it is filed
 *  under, for this room, and fresh. The owner's first, then the most recently
 *  stamped; one per node; at most `ctx.max`. Pure. */
export function readHolders(entries: Iterable<[string, unknown]>, ctx: HolderReadCtx): Holder[] {
  const verify = ctx.verify ?? verifyIdentityStrict;
  const max = ctx.max ?? MAX_HOLDERS;
  const out: Holder[] = [];
  const nodes = new Set<string>();
  for (const h of candidates(entries, ctx.now, ctx.ownerPub)) {
    if (out.length >= max) break;
    if (nodes.has(h.record.node)) continue;
    if (!verify(h.pub, holderNodeSignBytes(ctx.roomId, h.pub, h.record), h.record.sig)) continue;
    nodes.add(h.record.node);
    out.push(h);
  }
  return out;
}

const hintOf = (h: Holder): RoomMemberHint => ({ irohNodeId: h.record.node, irohRelayUrls: h.record.relays, irohDirectAddrs: h.record.addrs });

/** The route hints of a room's holders, for a pass or a node's dial: the
 *  owner's, then the freshest, MAX_HOLDER_HINTS at most unless `ctx.max`. */
export function readHolderHints(entries: Iterable<[string, unknown]>, ctx: HolderReadCtx): RoomMemberHint[] {
  return readHolders(entries, { ...ctx, max: ctx.max ?? MAX_HOLDER_HINTS }).map(hintOf);
}

/** 🤝 The nodes that hold a room, from its own doc: every listed holder's
 *  (MAX_HOLDERS at most), not a pass's eight — a visitor may reach only the
 *  least recent. Reads the doc it is given, not the bound store: a warm
 *  neighbour's or a far door's session asks too. */
export function holderNodesIn(doc: Y.Doc, roomId: string, now = Date.now()): Set<string> {
  const holders = readHolders(doc.getMap(HOLDER_NODES_MAP).entries(), { roomId, now, ownerPub: ownerPubIn(doc), verify: cachedVerify });
  return new Set(holders.map((h) => h.record.node));
}

/** This machine's node (its fingerprint's iroh id), as main.ts last read it. */
let localNode: string | null = null;

/** main.ts, at every fingerprint probe: this machine's node id, or null. */
export function setLocalHolderNode(node: string | null): void {
  localNode = typeof node === 'string' && NODE_RE.test(node) ? node : null;
}

/**
 * 🤝 Whether a room's state proved built by `node` counts as the room's own
 * (YjsSync `holderNode`, asked once the frame has applied):
 *  - never while the doc is empty (roomStateIn): a node that only registered
 *    the room proves its frames too, and brings nothing;
 *  - a node a holder filed as theirs (holderNodesIn). A game files only once
 *    the room's state has reached it, so on a first visit the record that
 *    names the node arrives in the very frame it proves;
 *  - or this machine's own node, for the room's owner, for a player whose
 *    own signed record names it however old that record is, and for an
 *    install that has loaded the room on that node before (its own private
 *    note, roomHeldBy). That is the way in for a holder reopening a room
 *    nobody else has online, back after MAX_AGE_MS or with their record gone
 *    from the room (the switch turned off, cleared from a full list): their
 *    game files a record only once the room's state has arrived, so without
 *    it they could never file one again. A first-time visitor's own node
 *    gains nothing: there is no record of theirs and no note to show.
 */
export function holderNodeOk(
  node: string,
  doc: Y.Doc,
  roomId: string,
  now = Date.now(),
  me = getIdentityPub(),
  held: SwitchStore | null = ownStore(),
): boolean {
  if (!roomStateIn(doc)) return false;
  if (holderNodesIn(doc, roomId, now).has(node)) return true;
  if (localNode === null || node !== localNode) return false;
  if (roomHeldBy(held, roomId) === node) return true;
  if (me.length === 0) return false;
  if (ownerPubIn(doc) === me) return true;
  const mine = holderNodeFromWire(doc.getMap(HOLDER_NODES_MAP).get(me));
  return !!mine && mine.node === node && cachedVerify(me, holderNodeSignBytes(roomId, me, mine), mine.sig);
}

/** YjsSync's `holderNode` for any room session. */
export const holderNodeTrust = {
  holderNode: (node: string, doc: Y.Doc, roomId: string): boolean => holderNodeOk(node, doc, roomId),
};

/** Whether a holder's stored record should be rewritten with `next`. */
export function needsRefile(stored: HolderNode | null, next: HolderNode, now: number): boolean {
  if (!stored) return true;
  if (stored.node !== next.node) return true;
  if ((stored.relays ?? []).join('\n') !== (next.relays ?? []).join('\n')) return true;
  if (now - stored.at >= REFRESH_MS || stored.at > now + MAX_FUTURE_SKEW_MS) return true;
  // Addresses that should no longer ride (the room changed owner) go at once.
  if ((stored.addrs ?? []).length > 0 && (next.addrs ?? []).length === 0) return true;
  if ((stored.addrs ?? []).join('\n') !== (next.addrs ?? []).join('\n')) return now - stored.at >= ADDRS_REFRESH_MS;
  return false;
}

/**
 * The keys a filer clears from a room's records, MAX_PRUNE at most, so the
 * list stays the size readers look at however many players pass through:
 * malformed entries, records older than PRUNE_AGE_MS, records among the ones
 * a reader checks whose signature is not their key's, and whatever lies past
 * the freshest MAX_HOLDERS (a stamp ahead of this clock ranks last: it is a
 * route for nobody yet). Never a key in `keep` (the filer's own, the
 * owner's). Pure.
 */
export function staleHolderKeys(
  entries: Iterable<[string, unknown]>,
  ctx: { roomId: string; now: number; keep: ReadonlySet<string>; verify?: (pub: string, bytes: Uint8Array, sig: string) => boolean },
): string[] {
  const verify = ctx.verify ?? verifyIdentityStrict;
  const out: string[] = [];
  const shaped: Holder[] = [];
  for (const [pub, raw] of entries) {
    if (ctx.keep.has(pub)) continue;
    const record = typeof pub === 'string' && pub.length > 0 && pub.length <= MAX_PUB ? holderNodeFromWire(raw) : null;
    if (!record || ctx.now - record.at > PRUNE_AGE_MS) out.push(pub);
    else shaped.push({ pub, record });
  }
  const ahead = (h: Holder): boolean => h.record.at > ctx.now + MAX_FUTURE_SKEW_MS;
  shaped.sort((a, b) => Number(ahead(a)) - Number(ahead(b)) || b.record.at - a.record.at || (a.pub < b.pub ? -1 : a.pub > b.pub ? 1 : 0));
  // Past the list: the least recent first, so the cut is the same for every filer.
  const room = Math.max(0, MAX_HOLDERS - ctx.keep.size);
  for (let i = shaped.length - 1; i >= room; i--) out.push(shaped[i].pub);
  for (const h of shaped.slice(0, room)) {
    if (fresh(h.record, ctx.now) && !verify(h.pub, holderNodeSignBytes(ctx.roomId, h.pub, h.record), h.record.sig)) out.push(h.pub);
  }
  return out.slice(0, MAX_PRUNE);
}

// ── The switch ───────────────────────────────────────────────────────────────

/** localStorage key of the one switch: '0' keeps this computer off every
 *  room's list. Absent means on. */
export const LIST_COMPUTER_KEY = 'ssf-list-my-computer';

/** The slice of Storage the switch needs (a test passes its own). */
export interface SwitchStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Whether this computer is listed among the holders of the rooms it holds.
 *  On unless the player switched it off; storage that cannot be read is on. */
export function listsThisComputer(store: SwitchStore | null | undefined): boolean {
  try {
    return store?.getItem(LIST_COMPUTER_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Set the switch (best effort where storage is closed). */
export function setListsThisComputer(store: SwitchStore | null | undefined, on: boolean): void {
  try {
    if (on) store?.removeItem(LIST_COMPUTER_KEY);
    else store?.setItem(LIST_COMPUTER_KEY, '0');
  } catch {
    /* privacy mode: the switch lasts this page only where the caller keeps it */
  }
}

// ── What this install has loaded (private) ───────────────────────────────────

/** localStorage key of this install's own note of the rooms whose state has
 *  reached it, each with the node that held the copy then: pairs of room id
 *  and node id, the most recently noted last. Never sent anywhere. */
export const HELD_ROOMS_KEY = 'ssf-rooms-held';
/** Rooms the note keeps, at most; past it the least recently noted go. */
export const MAX_HELD_ROOMS = 256;
const MAX_ROOM_ID = 128;

/** This page's own storage, or none where it is closed (or in a test). */
function ownStore(): SwitchStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The note as this page made it, for where storage is closed. */
const heldThisPage = new Map<string, string>();

function readHeldRooms(store: SwitchStore | null | undefined): Array<[string, string]> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(store?.getItem(HELD_ROOMS_KEY) ?? 'null');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Array<[string, string]> = [];
  for (const pair of raw.slice(-MAX_HELD_ROOMS)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [roomId, node] = pair as unknown[];
    if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > MAX_ROOM_ID) continue;
    if (typeof node !== 'string' || !NODE_RE.test(node)) continue;
    out.push([roomId, node]);
  }
  return out;
}

/** The node that held `roomId` when its state last reached this install, by
 *  the install's own note; null when it never did. */
export function roomHeldBy(store: SwitchStore | null | undefined, roomId: string): string | null {
  const here = heldThisPage.get(roomId);
  if (here !== undefined) return here;
  for (const [room, node] of readHeldRooms(store)) if (room === roomId) return node;
  return null;
}

/** Note that `roomId`'s own state has reached this install while `node` was
 *  its computer's node (best effort where storage is closed: the page keeps
 *  it). Nothing is written when the note says so already. */
export function noteRoomHeld(store: SwitchStore | null | undefined, roomId: string, node: string): void {
  if (!roomId || roomId.length > MAX_ROOM_ID || !NODE_RE.test(node)) return;
  if (heldThisPage.get(roomId) === node) return;
  heldThisPage.delete(roomId);
  heldThisPage.set(roomId, node);
  if (heldThisPage.size > MAX_HELD_ROOMS) heldThisPage.delete(heldThisPage.keys().next().value as string);
  const rooms = readHeldRooms(store);
  if (rooms.some(([room, held]) => room === roomId && held === node)) return;
  const next = [...rooms.filter(([room]) => room !== roomId), [roomId, node] as [string, string]].slice(-MAX_HELD_ROOMS);
  try {
    store?.setItem(HELD_ROOMS_KEY, JSON.stringify(next));
  } catch {
    /* privacy mode: the note lasts this page only */
  }
}

// ── The bound store ──────────────────────────────────────────────────────────

let boundDoc: Y.Doc | null = null;
let nodesMap: Y.Map<unknown> | null = null;
/** The key whose record this binding filed, or found standing: a record
 *  since cleared from a full list is not filed again in the same visit (two
 *  full rooms' worth of players would otherwise clear each other for ever). */
let filedAs: string | null = null;
/** Verdicts by key, signature and signed bytes (never key and signature
 *  alone: an altered record re-filed with an old signature must not borrow a
 *  genuine record's verdict). */
const verdicts = new Map<string, boolean>();
const MAX_VERDICTS = 4 * MAX_HOLDERS;

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

const nodeListeners = new Set<() => void>();
const onNodesChanged = (): void => {
  for (const l of [...nodeListeners]) l();
};

export function bindHolderNodes(doc: Y.Doc): void {
  nodesMap?.unobserve(onNodesChanged);
  boundDoc = doc;
  nodesMap = doc.getMap(HOLDER_NODES_MAP);
  nodesMap.observe(onNodesChanged);
  filedAs = null;
}

/** Called when the bound room's holder records change (a pass's hints may). */
export function subscribeHolderNodes(listener: () => void): () => void {
  nodeListeners.add(listener);
  return () => nodeListeners.delete(listener);
}

/** The holders the bound room lists (the owner's first, then the freshest). */
export function holdersHere(roomId: string, ownerPub: string | undefined, now = Date.now(), max = MAX_HOLDERS): Holder[] {
  if (!docAlive() || !roomId) return [];
  return readHolders(nodesMap!.entries(), { roomId, now, ownerPub, verify: cachedVerify, max });
}

/** The holder hints of the bound room, for a pass or the node's dial. */
export function holderHintsHere(roomId: string, ownerPub: string | undefined, now = Date.now()): RoomMemberHint[] {
  return holdersHere(roomId, ownerPub, now, MAX_HOLDER_HINTS).map(hintOf);
}

/** What a game knows of itself when it files. */
export interface FilingFacts {
  /** The switch: this computer may be listed (listsThisComputer). */
  listed: boolean;
  /** The room's own state has reached this game and is not empty. */
  holds: boolean;
  /** This player owns the room: the record carries direct addresses too. */
  owner: boolean;
  /** The room owner's key, when known: its record is never cleared. */
  ownerPub?: string;
}

/**
 * A game files (or refreshes) its computer's node in the bound room once it
 * holds the room, and takes its record down when the player has switched
 * listing off. A filing also clears a few stale records (staleHolderKeys).
 * Returns what it did to this player's own record. Listed or not, a game
 * that holds the room notes so on its own computer (noteRoomHeld, `held`).
 */
export function fileMyHolderNode(
  roomId: string,
  me: FilingFacts,
  hint: RoomMemberHint | null,
  now = Date.now(),
  signer: HolderSigner = localHolderSigner(),
  held: SwitchStore | null = ownStore(),
): 'filed' | 'removed' | 'kept' {
  if (!docAlive() || !roomId || !signer.pub) return 'kept';
  if (me.holds && hint) noteRoomHeld(held, roomId, hint.irohNodeId);
  const storedRaw = nodesMap!.get(signer.pub);
  if (!me.listed) {
    filedAs = null; // switched on again, it files afresh
    if (storedRaw === undefined) return 'kept';
    boundDoc!.transact(() => { nodesMap!.delete(signer.pub); });
    return 'removed';
  }
  if (!me.holds || !hint) return 'kept';
  const next = signHolderNode(roomId, hint, now, signer, me.owner);
  if (!next) return 'kept';
  // Cleared from a full list during this visit: the list has moved on.
  if (storedRaw === undefined && filedAs === signer.pub) return 'kept';
  const stored = holderNodeFromWire(storedRaw);
  const genuine = stored && verifyIdentityStrict(signer.pub, holderNodeSignBytes(roomId, signer.pub, stored), stored.sig) ? stored : null;
  if (!needsRefile(genuine, next, now)) {
    // A record of this player's stands in this visit, filed in an earlier
    // one: cleared from a full list later, it is not filed again either.
    filedAs = signer.pub;
    return 'kept';
  }
  const keep = new Set([signer.pub, ...(me.ownerPub ? [me.ownerPub] : [])]);
  boundDoc!.transact(() => {
    nodesMap!.set(signer.pub, next);
    for (const key of staleHolderKeys(nodesMap!.entries(), { roomId, now, keep, verify: cachedVerify })) nodesMap!.delete(key);
  });
  filedAs = signer.pub;
  return 'filed';
}

/** Test seam: forget the verdict cache, the binding and the local node. */
export function resetRoomHoldersForTest(): void {
  verdicts.clear();
  boundDoc = null;
  nodesMap = null;
  filedAs = null;
  localNode = null;
  heldThisPage.clear();
}
