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

let boundDoc: Y.Doc | null = null;
let gamesMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy: a listener may unsubscribe (or mount a new UI) mid-notify.
  for (const listener of [...listeners]) listener();
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

/** Transacted whole-value write of one table's state (LWW per table key). */
export function writeGame(tableId: string, state: CheckersState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(tableId, state);
  });
}

/** Room owner player id from the bound doc, or null (offline / unclaimed). */
export function readRoomOwner(): string | null {
  if (!docAlive() || !boundDoc) return null;
  const owner = boundDoc.getMap('roomInfo').get('owner');
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
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
// precedent). See PR #45 evidence.
(window as unknown as { __ssfGames: unknown }).__ssfGames = {
  readGame, writeGame, subscribeGames,
  checkers: { initialState, legalMoves, applyMove, chooseBotMove },
};
