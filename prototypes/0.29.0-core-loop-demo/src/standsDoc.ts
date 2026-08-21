/**
 * 🎰 `stands` map binding — CRDT-backed occupancy for table standing slots
 * (#76).
 *
 * The room doc carries a `stands` Y.Map keyed by StandSlot.id
 * (`${itemId}:s${n}`, minted in furniture.ts buildStandList). Each value is a
 * plain-JSON StandClaim (see standClaims.ts) — no nested Y types, matching
 * the players/games/casino contract.
 *
 * WHY A MAP AT ALL. STANDS was already conflict-safe within one client, but
 * two peers walking up at the same instant saw the same "free" slot in their
 * local proximity check and both landed on it. A doc-backed claim gives Yjs
 * the last word: per-key LWW picks exactly ONE winner on every replica, and
 * the loser's next pickStandForWalkup sees the claim and picks the next
 * open slot.
 *
 * SINGLE-WRITER-PER-KEY DISCIPLINE. Each claim key is written by exactly one
 * client — the player claiming it (heartbeat renewal is the same player), or
 * the REAPER on any client (deletion only, never a fresh write). The heartbeat
 * pattern makes the write cadence explicit: the holder rewrites the same
 * shape every STAND_CLAIM_HEARTBEAT_MS to keep the TTL alive. A dropped tab
 * stops writing → any peer's reap sweep removes the stale claim after
 * STAND_CLAIM_TTL_MS → the slot re-opens.
 *
 * TRUST BOUNDARY. Reads go through isStandClaim, so a hostile peer's junk
 * write reads as "no claim" and the walk-up logic simply picks that slot.
 * Same shape-guard discipline as gamesDoc.ts / treasuryDoc.ts.
 *
 * REBIND PER JOIN (T0 seam): leaveRoom destroys the Y.Doc; main.ts's
 * joinRoomAtEpoch calls bindStandsDoc(sync.doc) beside the other bindings.
 * OFFLINE FALLBACK mirrors gamesDoc — a page-local doc lazily binds so the
 * feature works solo; a later real join rebinds and the practice claims
 * vanish with the local doc (documented v1 semantics).
 */

import * as Y from 'yjs';
import { isStandClaim } from './standClaims';
import type { StandClaim } from './standClaims';

let boundDoc: Y.Doc | null = null;
let standsMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

/**
 * Fan out map changes to every subscriber. Copy + isolate (the games/casino
 * guard): a listener may unsubscribe mid-notify, and one throwing render must
 * not kill the rest or Yjs's transaction cleanup.
 */
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[stands] listener threw during doc notify:', err);
    }
  }
}

function docAlive(): boolean {
  return boundDoc !== null
    && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

/**
 * Bind (or re-bind) the stands map to a room doc. Called from main.ts
 * joinRoomAtEpoch in the no-awaits zone; also self-called with a local doc
 * as the offline fallback. Observers on the PREVIOUS doc died with it
 * (doc.destroy() in leaveRoom) — nothing to detach here.
 */
export function bindStandsDoc(doc: Y.Doc): void {
  boundDoc = doc;
  standsMap = doc.getMap('stands');
  standsMap.observe(() => notify());
  notify(); // repaint subscribers from the fresh doc
}

/** Bound map, lazily falling back to a page-local doc (offline practice). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !standsMap) bindStandsDoc(new Y.Doc());
  return standsMap!;
}

/**
 * Subscribe to stands-map changes (any slot, any rebind). Returns the
 * unsubscribe. Subscribers re-read via readStandClaim / readAllStandClaims —
 * events carry no payload on purpose, since a rebind swaps the whole map
 * identity.
 */
export function subscribeStands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One slot's claim, or null (empty / malformed peer write). */
export function readStandClaim(slotId: string): StandClaim | null {
  const value = ensureMap().get(slotId);
  return isStandClaim(value) ? value : null;
}

/**
 * Every valid claim in the map, as slotId → claim. Used by pickStandForWalkup
 * (whole snapshot per walk-up so the tier ordering sees a consistent view)
 * and the reap sweep. Filters malformed values silently — the doc can carry
 * anything a peer decided to plant, and none of it should crash the walk-up.
 */
export function readAllStandClaims(): Map<string, StandClaim> {
  const out = new Map<string, StandClaim>();
  const map = ensureMap();
  map.forEach((value, key) => {
    if (isStandClaim(value)) out.set(key, value);
  });
  return out;
}

/**
 * Transacted whole-value write of one claim (LWW per slot key). Returns the
 * claim object that was written so the caller can cache the last-write clock
 * for its own bookkeeping (heartbeat scheduler in world.ts).
 *
 * The transact keeps the observer notification atomic — one write, one fan-out
 * — mirroring writeGame / writeChips.
 */
export function claimStand(slotId: string, playerId: string, at: number): StandClaim {
  const claim: StandClaim = { playerId, at };
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(slotId, claim);
  });
  return claim;
}

/**
 * Release one slot — deletes the key so pickStandForWalkup treats the slot as
 * empty on every replica. No-op when the slot is already empty. Only the
 * holder should call this in normal flow; the reaper uses the same delete
 * for stale claims from crashed peers.
 */
export function releaseStand(slotId: string): void {
  const map = ensureMap();
  if (!map.has(slotId)) return;
  boundDoc!.transact(() => {
    map.delete(slotId);
  });
}

/**
 * Batch-delete a list of stale slot ids in one transaction — the reaper's
 * write shape. One transact keeps the observer fan-out down to a single
 * notify per sweep even when several claims expire together.
 */
export function reapExpiredClaims(slotIds: readonly string[]): void {
  if (slotIds.length === 0) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    for (const id of slotIds) {
      if (map.has(id)) map.delete(id);
    }
  });
}
