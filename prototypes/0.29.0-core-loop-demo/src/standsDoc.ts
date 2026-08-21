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
 * shape every STAND_CLAIM_HEARTBEAT_MS to keep the TTL alive.
 *
 * RECOVERY OF A DROPPED PEER'S SLOT (audit-honest, finding #3). Two paths open
 * a stale slot back up:
 *   1. The WALK-UP PATH (primary): pickStandForWalkup's canPlayerClaim
 *      stale-clause treats any claim past STAND_CLAIM_TTL_MS as claimable,
 *      independent of the online-players provider. A new walker lands on the
 *      slot and their claimStand overwrites the stale entry via LWW. This is
 *      the mechanism that actually reclaims a departed peer's slot today.
 *   2. The REAP SWEEP (safety net): findExpiredClaims removes a stale claim
 *      only when its holder is ALSO not in the online-players set. In this
 *      build the players Y.Map is append-only (main.ts has no players.delete
 *      call site — leaveRoom destroys only the local doc, so every other
 *      replica still sees the departed peer in `players`). That makes the
 *      reap safe (it never deletes a currently-online peer's slot) but
 *      largely a no-op for a real disconnect — the reap effectively fires
 *      only for peers whose entry never made it to another replica, or for
 *      claims from a local offline session (getPlayerId is added locally as
 *      belt-and-braces so a solo player never reaps their own slot). A
 *      future graceful-leave path that calls players.delete would make the
 *      reap sweep meaningful; until then, path (1) is the load-bearing one.
 *
 * TRUST BOUNDARY. Reads go through isStandClaim, so a hostile peer's junk
 * write reads as "no claim" and the walk-up logic simply picks that slot.
 * Same shape-guard discipline as gamesDoc.ts / treasuryDoc.ts.
 *
 * REBIND PER JOIN (T0 seam): leaveRoom destroys the Y.Doc; main.ts's
 * joinRoomAtEpoch calls bindStandsDoc(sync.doc, { getOnlinePlayerIds }) beside
 * the other bindings. OFFLINE FALLBACK mirrors gamesDoc — a page-local doc
 * lazily binds so the feature works solo; a later real join rebinds and the
 * practice claims vanish with the local doc (documented v1 semantics).
 *
 * ONLINE-PLAYER PROVIDER. The reap sweep needs to know which claim holders
 * are currently online (a live-but-quiet peer keeps their slot). Rather than
 * reach through a window back-channel like `__ssfDoc`, main.ts REGISTERS a
 * provider at bind time that reads the current room doc's `players` map;
 * the reap code calls `getOnlinePlayerIds()` and gets the same answer.
 * Tests can bind a fresh doc without a provider and the fallback returns
 * an empty set (every claim is reapable — the pure engine's expected input).
 */

import * as Y from 'yjs';
import { isStandClaim } from './standClaims';
import type { StandClaim } from './standClaims';

let boundDoc: Y.Doc | null = null;
let standsMap: Y.Map<unknown> | null = null;

/**
 * Optional provider for the currently-online player id set — supplied by
 * main.ts at bind time so the reap sweep can consult the room doc's
 * `players` map without a window back-channel (former `__ssfDoc` coupling).
 * Null in tests / offline fallback → reap treats every expired claim as
 * reapable, which is what the pure engine tests want.
 */
let onlinePlayerIdsProvider: (() => Set<string>) | null = null;

/** Options bag for bindStandsDoc — additive so existing tests keep working. */
export interface StandsDocOptions {
  /**
   * Snapshot of currently-online player ids (the room doc's `players` map,
   * usually). Called each reap sweep — copy-free callers may reuse a
   * scratch Set as long as it's fresh per call. Omit in unit tests.
   */
  getOnlinePlayerIds?: () => Set<string>;
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
 *
 * Registering a fresh `getOnlinePlayerIds` provider REPLACES the previous
 * one; passing no options KEEPS the last provider (a rebind for the same
 * room can skip re-plumbing). To CLEAR the provider (dev / test teardown),
 * pass `{ getOnlinePlayerIds: undefined }` explicitly and it will fall
 * back to the empty-set behaviour.
 */
export function bindStandsDoc(doc: Y.Doc, opts?: StandsDocOptions): void {
  boundDoc = doc;
  standsMap = doc.getMap('stands');
  if (opts !== undefined && 'getOnlinePlayerIds' in opts) {
    onlinePlayerIdsProvider = opts.getOnlinePlayerIds ?? null;
  }
}

/** Bound map, lazily falling back to a page-local doc (offline practice). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !standsMap) bindStandsDoc(new Y.Doc());
  return standsMap!;
}

/**
 * Snapshot of currently-online player ids for the reap sweep. Returns an
 * empty set when no provider is registered — safe for tests (nobody
 * "online", so every stale claim reaps), and the world reap adds the
 * local player id itself as a belt-and-braces so a solo player never
 * reaps their own slot even during offline fallback.
 */
export function getOnlinePlayerIds(): Set<string> {
  if (!onlinePlayerIdsProvider) return new Set<string>();
  try {
    return onlinePlayerIdsProvider();
  } catch (err) {
    console.error('[stands] online-players provider threw:', err);
    return new Set<string>();
  }
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
