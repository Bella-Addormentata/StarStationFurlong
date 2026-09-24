/**
 * `games` map binding — the Yjs seam for issue #45's game tables.
 *
 * The room doc carries a `games` Y.Map keyed by game-table furniture item id;
 * each value is a plain-JSON CheckersState (no nested Y types — the same
 * contract as the `players` map, see main.ts PlayerEntry). Every state
 * transition is a whole-value transacted set: Yjs last-writer-wins per key
 * resolves races (two simultaneous seat claims collapse to one winner; moves
 * are already serialized by the turn gate).
 *
 * REBIND PER JOIN (T0 seam): leaveRoom() destroys the Y.Doc, so main.ts's
 * joinRoomAtEpoch calls bindGamesDoc(sync.doc) beside the players/roomInfo/
 * chat bindings — the observer attaches to the FRESH doc and every subscriber
 * (mounted game UIs, the in-world board mirror in world.ts) re-renders from
 * it. This module keeps the subscriber set OUTSIDE the doc so the seam
 * survives the swap.
 *
 * OFFLINE FALLBACK: when no room doc is bound (node down, networking failed)
 * the first read/write lazily binds a page-local Y.Doc. Same code path, same
 * transactions — just nobody to sync with; a later real join rebinds and the
 * local practice game is discarded with its doc (documented v1 semantics).
 */

import * as Y from 'yjs';
import { initialState, legalMoves, applyMove, chooseBotMove, isCheckersState } from './checkers';
import type { CheckersState } from './checkers';
import { isChessState } from './chess';
import type { ChessState } from './chess';
import type { RoomOwnerKey } from '../treasuryView';

/** A table hosts ONE game at a time. Chess states carry `kind: 'chess'`;
 *  legacy checkers states are kind-less (isCheckersState identifies them) —
 *  the additive discriminator keeps every pre-chess doc entry working. */
export type TableGame =
  | { kind: 'checkers'; state: CheckersState }
  | { kind: 'chess'; state: ChessState };

let boundDoc: Y.Doc | null = null;
let gamesMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy: a listener may unsubscribe (or mount a new UI) mid-notify.
  // Isolate: this runs inside Yjs's observe callback — one throwing render
  // must not kill the remaining listeners or Yjs's transaction cleanup.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[games] listener threw during doc notify:', err);
    }
  }
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return boundDoc !== null
    && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

/**
 * Bind (or re-bind) the games map to a room doc. Called from main.ts
 * joinRoomAtEpoch in the no-awaits zone; also self-called with a local doc as
 * the offline fallback. Observers on the PREVIOUS doc died with it
 * (doc.destroy() in leaveRoom) — nothing to detach here.
 */
export function bindGamesDoc(doc: Y.Doc): void {
  boundDoc = doc;
  gamesMap = doc.getMap('games');
  gamesMap.observe(() => notify());
  notify(); // repaint subscribers from the fresh doc (mirror of rebuildChatLog)
}

/** The bound games map, lazily falling back to a page-local doc (see header). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !gamesMap) bindGamesDoc(new Y.Doc());
  return gamesMap!;
}

/**
 * Subscribe to games-map changes (any table, any rebind). Returns the
 * unsubscribe. Subscribers re-read via readGame — events carry no payload on
 * purpose, since a rebind swaps the whole map identity.
 */
export function subscribeGames(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current state for one table, or null (no game yet / malformed peer write). */
export function readGame(tableId: string): CheckersState | null {
  const value = ensureMap().get(tableId);
  return isCheckersState(value) ? value : null;
}

/** Kind-discriminated read: whichever game currently lives on the table.
 *  Chess carries `kind: 'chess'`; kind-less entries are legacy checkers. */
export function readTable(tableId: string): TableGame | null {
  const value = ensureMap().get(tableId);
  if (isChessState(value)) return { kind: 'chess', state: value };
  if (isCheckersState(value)) return { kind: 'checkers', state: value };
  return null;
}

/** Transacted whole-value write of one table's state (LWW per table key). */
export function writeGame(tableId: string, state: CheckersState | ChessState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(tableId, state);
  });
}

/** Clear the table entirely — back to the game PICKER on every client. */
export function clearTable(tableId: string): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.delete(tableId);
  });
}

/** Room owner player id from the bound doc, or null (offline / unclaimed). */
export function readRoomOwner(): string | null {
  if (!docAlive() || !boundDoc) return null;
  const owner = boundDoc.getMap('roomInfo').get('owner');
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/**
 * The room owner's IDENTITY KEY as the room document names it right now —
 * the room-side half of the treasury plan's §10.1 binding check ("verify
 * against the room deed/authority head"), read LIVE on every call because
 * roomInfo and the owner's players entry sync in separately, and a rotated
 * owner key must take effect without a rebind. Same chain of reads as
 * main.ts's roomOwnerInfo and currentRoomDeedIsMine (the unmerged #67 door
 * policy PR wires the same chain as a live reader of its own).
 *
 * Today that chain is roomInfo.owner → players[owner].keyB64, both peer-
 * writable and neither pinned, so this is exactly as strong as room ownership
 * itself is today — and no stronger. Be precise about what that buys: the
 * rule rules out only the forgery that needs NO owner-map write (a fresh key
 * signing a binding). A peer who overwrites players[owner].keyB64 with their
 * own key — keeping the name, leaving roomInfo.owner alone — substitutes the
 * owner key silently, nothing on screen changes, and it stands until the
 * owner's own client re-registers its entry (join, name or outfit change);
 * there is no key-change detection or first-seen pinning for the room owner
 * today. Every other owner gate in the app concedes the same write. That is
 * why the badge says "as its records currently name them" and no more.
 *
 * ISSUE #138 — room modules as Chia NFT deeds — THIS IS THE FUNCTION THAT
 * CHANGES, and nothing downstream of it. brainstorming/chia-authority-
 * architecture.md mints one NFT1 per room as its deed and has the owner's
 * node publish a signed authority head {launcher_id, seq, owner_ed25519_pubkey,
 * cohost_ed25519_pubkeys[], transferable, issued_at} into the room doc,
 * verified against the chain-anchored root; its Phase 2 makes the head the
 * source of truth and the raw owner map a cache of it. Implementation sketch
 * for that day:
 *   1. read `authority_root` from roomInfo; if absent, fall through to the
 *      chain below (rooms without a deed keep today's trust level — the
 *      architecture's stated Phase 1 behaviour);
 *   2. read the highest-`seq` head record the doc holds, verify its BLS
 *      signature against the deed's current p2 puzzle hash as the local node
 *      reports it (the node-side lane, not the browser — the browser holds no
 *      chain code), and refuse a head that fails or a root that no longer
 *      resolves;
 *   3. return { status: 'known', pub: head.owner_ed25519_pubkey, source:
 *      'head-verified' } — in the same base64url form players.keyB64 uses,
 *      or normalised to it here — so treasuryView's comparison against
 *      RoomTreasuryBinding.boundByPub is unchanged; a head whose owner key
 *      differs from a prior binding's signer demotes that binding to
 *      NOT OWNER-SIGNED automatically, which is how a deed transfer or a key
 *      rotation revokes room funding without a schema change. A head this
 *      device can read but not verify (no chain access) is 'head-unverified'
 *      and worded on screen exactly like today's room-doc trust.
 * Two preconditions the authority architecture has not yet written down, and
 * which an adversarial pass on this rule found load-bearing: `authority_root`
 * must be anchored outside the peer-writable room doc (bootstrap link, room
 * seed, or a roomId derived from the launcher id) — otherwise a peer swaps in
 * their own NFT, p2 and head and the verifier hands back a fully consistent
 * forgery — and readers must keep a per-peer highest-seen `seq` watermark so a
 * rolled-back head cannot resurrect a rotated-away key's bindings.
 * Until then the function below is the whole of the owner check, and the
 * treasury UI labels its verdict as what it is: what this room's records say.
 */
export function readRoomOwnerKey(): RoomOwnerKey {
  if (!docAlive() || !boundDoc) return { status: 'unknown' };
  const owner = boundDoc.getMap('roomInfo').get('owner');
  if (typeof owner !== 'string' || owner.length === 0) return { status: 'unknown' };
  // The pre-keyed-identity self-owned marker (see main.ts isLocalPlayerRoomOwner):
  // no player entry, no key, and none can ever appear for it.
  if (owner === 'Local-Clone') return { status: 'legacy' };
  const entry = boundDoc.getMap('players').get(owner) as { keyB64?: unknown } | undefined;
  // `source: 'room-doc'` is what lets the treasury badge say only "as its
  // records name them". A #138 head reader returns 'head-verified' when the
  // local node checked the head against the deed, and 'head-unverified' when
  // it could only read it — never 'head-verified' for a head nobody checked.
  return entry && typeof entry.keyB64 === 'string' && entry.keyB64.length > 0
    ? { status: 'known', pub: entry.keyB64, source: 'room-doc' }
    : { status: 'unknown' };
}

/**
 * Display name for a seat-claimant player id via the doc's `players` map
 * (S2 identity), shortened-id fallback for ids with no entry yet.
 */
export function readPlayerDisplayName(playerId: string): string {
  if (docAlive() && boundDoc) {
    const entry = boundDoc.getMap('players').get(playerId) as { name?: unknown } | undefined;
    if (entry && typeof entry.name === 'string' && entry.name.length > 0) return entry.name;
  }
  return playerId.slice(0, 8);
}

// Permanent debug handle (kept deliberately — runtime verification of doc
// state + engine legality from the console; the __players / __deviceFocus
// precedent). See PR #45 evidence. Guarded so the module is importable where
// there is no window — the treasury tests read readRoomOwnerKey through it.
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfGames: unknown }).__ssfGames = {
    readGame, writeGame, subscribeGames,
    checkers: { initialState, legalMoves, applyMove, chooseBotMove },
  };
}
