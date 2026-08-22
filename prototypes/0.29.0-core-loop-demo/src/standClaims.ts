/**
 * 🎰 Stand-claim engine (#76) — pure logic for the CRDT-backed occupancy map
 * that gates multi-player standing at tables.
 *
 * BACKGROUND. STANDS (stands.ts) derives world-space slots from each table's
 * StandTemplate list; two peers walking up simultaneously used to trip over
 * each other because pickFreeStand only had local proximity to work with. To
 * make walk-ups conflict-safe we let peers post a CLAIM keyed by StandSlot.id
 * to a Y.Map — Yjs's per-key last-writer-wins collapses two simultaneous
 * claims to exactly one occupant on every replica.
 *
 * SHAPE. StandClaim = { playerId, at } — no room hop, no signatures (v1
 * plaintext, mirroring the players map). `at` is the monotonic write clock
 * used for expiry, refreshed by the holder's HEARTBEAT so a live peer keeps
 * their slot even if the doc briefly quiesces around it.
 *
 * TRUST BOUNDARY. Every value read out of the doc goes through isStandClaim —
 * a hostile peer can plant a Y.Map or a raw string under any key, and we must
 * treat those as "no claim" rather than let one bad value crash walk-up
 * routing (the same discipline as playersMap.get + shape-guard in main.ts and
 * checkers/chess state guards in gamesDoc.ts).
 *
 * OWNERSHIP RULE. `canPlayerClaim(claim, playerId, now)` says a claim is
 * "yours" if the recorded playerId matches OR the claim has aged past the TTL
 * (a crashed peer's stand self-heals after ~15 s of silence). It never allows
 * one live player to displace another — that would be the second-order bug
 * this whole slice is here to prevent.
 *
 * RESERVED SLOTS. Wheel-head / stickman spots are marked with a `role` in the
 * furniture registry; pickStandForWalkup skips them by default so they stay
 * available for the operator robot / owner. When the caller is
 * owner-equivalent (canOperateReserved), reserved slots are considered as a
 * LAST-RESORT tier so an owner isn't stranded when every civilian slot is
 * taken. World.ts is the only place that decides who "owner-equivalent" is;
 * this module just consumes a boolean so the pure tests stay hermetic.
 */

import type { StandSlot } from './furniture';

/**
 * A live claim on one stand slot. Written whole-value per key (LWW) —
 * refreshing the timestamp is just another write of the same shape.
 */
export interface StandClaim {
  /** Per-install player id (identity.getPlayerId) — never a lane id (#22). */
  readonly playerId: string;
  /** Monotonic ms clock (Date.now) captured at write time; drives expiry. */
  readonly at: number;
}

/**
 * A claim older than this is treated as ABANDONED — the holder crashed, or
 * their tab was suspended long enough for the CRDT to lose their presence.
 * Any other player may claim the slot after this window (canPlayerClaim).
 * 15 s = 3× heartbeat: two consecutive heartbeat misses without expiring a
 * healthy tab.
 */
export const STAND_CLAIM_TTL_MS = 15_000;

/**
 * How often a live claim-holder rewrites the claim to bump `at`. Chosen so
 * a laggy transport still gets two chances to renew before the TTL kicks in
 * (5 s × 3 = 15 s).
 */
export const STAND_CLAIM_HEARTBEAT_MS = 5_000;

/**
 * Cadence for reap sweeps — walk every claim and delete the ones that are
 * both expired AND belong to nobody currently online. Cheap; called from the
 * world update loop.
 */
export const STAND_CLAIM_REAP_MS = 3_000;

/**
 * Shape guard for a raw map value. Rejects anything that isn't a plain
 * object with a non-empty playerId string and a finite `at` number — the two
 * fields every downstream function reads.
 *
 * A hostile peer can plant a Y.Map under a claim key; typeof (new Y.Map())
 * is 'object' but its entries are not own properties in the JSON sense, so
 * the shape check on playerId/at rejects them. Same defence used by
 * isCheckersState / isChessState / bindTreasuryDoc.
 */
export function isStandClaim(value: unknown): value is StandClaim {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<StandClaim>;
  return (
    typeof v.playerId === 'string' &&
    v.playerId.length > 0 &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at)
  );
}

/**
 * How far ahead of us a claim's clock may be and still count as live.
 *
 * A peer's clock genuinely can run a few seconds fast, and refusing every
 * future timestamp would let one skewed peer strand a slot it legitimately
 * holds. But the tolerance has to be BOUNDED, because `at` is peer-written
 * and unsigned: an unbounded future acceptance means `at = Date.now() + 1e12`
 * is always active, and a permanently-active claim closes BOTH reclaim paths
 * at once — canPlayerClaim refuses every other player, and findExpiredClaims
 * skips it — so the slot is dead for the life of the doc.
 *
 * One TTL of slack covers real skew (the heartbeat is a third of that) while
 * making a far-future claim read as what it is: not live.
 */
export const STAND_CLAIM_MAX_SKEW_MS = STAND_CLAIM_TTL_MS;

/**
 * True while `claim` is inside its TTL window relative to `now`. A modestly
 * future timestamp still counts as active (a peer's clock could be a few
 * seconds ahead; refusing a future claim would let one skewed peer strand a
 * slot) — but only up to STAND_CLAIM_MAX_SKEW_MS, so a claim dated far in the
 * future cannot hold a slot forever.
 */
export function isClaimActive(claim: StandClaim, now: number): boolean {
  const age = now - claim.at;
  if (age < -STAND_CLAIM_MAX_SKEW_MS) return false;
  return age < STAND_CLAIM_TTL_MS;
}

/**
 * True if `playerId` is allowed to WRITE a fresh claim over `existing`:
 *   • no prior claim (empty slot); OR
 *   • the claim is theirs (heartbeat renewal); OR
 *   • the claim is stale (holder crashed, past TTL).
 * Deliberately does NOT let a live peer bump another live peer — that's the
 * conflict this whole slice defends against.
 */
export function canPlayerClaim(
  existing: StandClaim | null,
  playerId: string,
  now: number,
): boolean {
  if (existing === null) return true;
  if (existing.playerId === playerId) return true;
  return !isClaimActive(existing, now);
}

/**
 * Ordered candidates for a walk-up, given a claim snapshot + a player.
 *
 * TIER RULE:
 *   1. OPEN slots that this player ALREADY CLAIMS (heartbeat resume — if I
 *      focused and briefly walked away my slot is still mine). Includes
 *      MY reserved-slot claim when I'm authorised (canOperateReserved), so
 *      an owner walking back to their wheel-head post lands on the SAME
 *      spot they left — issue #76: "someone that has spin privileges, to
 *      stand in a reserved spot".
 *   2. OPEN non-reserved slots claimable by this player (empty or stale).
 *   3. If the player is owner-equivalent AND has no prior claim, OPEN
 *      reserved slots (last-resort fallback so the owner isn't stranded).
 *
 * Within each tier the caller supplies the sort key (nearest by walk distance
 * in world.ts); this module just returns the tier order so tests can pin the
 * policy without importing pathfinding.
 *
 * Rationale for putting mine-reserved in tier 1: the owner's OWN active
 * claim on the wheel-head is a "resume" signal, and world.ts's stable tier
 * sort (`tierOf` at pickFreeStand) already grants tier 0 to any slot the
 * local player claims — aligning pickStandForWalkup's tier assignment
 * removes a subtle disagreement between the two layers.
 */
export function pickStandForWalkup(args: {
  slots: readonly StandSlot[];
  claims: ReadonlyMap<string, StandClaim>;
  playerId: string;
  now: number;
  canOperateReserved: boolean;
}): StandSlot[] {
  const { slots, claims, playerId, now, canOperateReserved } = args;
  const mineActive: StandSlot[] = [];
  const openCivilian: StandSlot[] = [];
  const openReserved: StandSlot[] = [];
  for (const s of slots) {
    const claim = claims.get(s.id) ?? null;
    // "Mine, still active" wins the first tier so re-focus resumes cleanly.
    if (claim && claim.playerId === playerId && isClaimActive(claim, now)) {
      // A held reserved slot (owner already at the wheel-head) belongs in
      // the same "mine" tier so a re-focus still lands on it — but only if
      // the player is still authorised (canOperateReserved). If not, we
      // quietly skip: the claim will expire, and the caller falls back to
      // the device's own front. A civilian slot (no `role`) is always mine
      // to resume.
      if (!s.role || canOperateReserved) mineActive.push(s);
      continue;
    }
    if (!canPlayerClaim(claim, playerId, now)) continue;
    if (s.role) {
      if (canOperateReserved) openReserved.push(s);
    } else {
      openCivilian.push(s);
    }
  }
  // Reserved tier appended LAST for a FRESH walk-up so operators still
  // prefer an open civilian spot when the wheel-head robot is around (the
  // reserved slot's job is to keep the robot's post clear). A RESUME onto
  // a reserved slot the operator already holds bypasses this by landing
  // in mineActive (tier 1) above.
  return [...mineActive, ...openCivilian, ...openReserved];
}

/**
 * Should the caller be allowed to DELETE a claim key it thinks it owns?
 * True when the current claim in the doc is empty, or when it names the
 * caller as playerId. Guard against a hypothetical race where our TTL
 * expired between claim-and-release and another peer legitimately took
 * the slot — we must not drop THEIR claim.
 *
 * Pure helper used by world.ts's releaseStandById; centralised here so the
 * ownership rule is testable without a live doc.
 */
export function shouldReleaseSlot(
  current: StandClaim | null,
  playerId: string,
): boolean {
  return current === null || current.playerId === playerId;
}

/**
 * Which claims are expired AND not held by any currently online player id —
 * safe to delete from the doc. A live-but-quiet player still gets to keep
 * their slot (the heartbeat will refresh it once the tab wakes).
 *
 * Used by the world-update reaper; a delete is a whole-value key removal, so
 * a race with a fresh heartbeat resolves the same way as any Y.Map LWW: the
 * later write wins and the slot is either back or gone.
 */
export function findExpiredClaims(args: {
  claims: ReadonlyMap<string, StandClaim>;
  onlinePlayerIds: ReadonlySet<string>;
  now: number;
}): string[] {
  const { claims, onlinePlayerIds, now } = args;
  const stale: string[] = [];
  for (const [slotId, claim] of claims) {
    if (isClaimActive(claim, now)) continue;
    if (onlinePlayerIds.has(claim.playerId)) continue;
    stale.push(slotId);
  }
  return stale;
}
