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
 * SHAPE. StandClaim = { pub, at, sig }. `pub` is the holder's Ed25519 identity
 * public key (keypair.ts getIdentityPub — base64url in the browser; this
 * engine treats it as an opaque string and never decodes it), `at` is the
 * wall-clock write time that drives expiry (refreshed by the holder's
 * HEARTBEAT so a live peer keeps their slot even if the doc briefly quiesces
 * around it), and `sig` is the holder's signature over
 * standClaimSignatureBytes(roomId, slotId, { pub, at }).
 *
 * WHY SIGNED (PR #126 review). The v1 shape was { playerId, at } in
 * plaintext: any peer could write any slot key naming any player id, so one
 * hostile client could park every table under someone else's name or evict a
 * player by rewriting their slot with a fresher `at`. keypair.ts (#124) gives
 * every install an Ed25519 identity and doorPolicy.ts (#129) is the in-repo
 * pattern for signing a map record over domain-tagged canonical bytes. Stand
 * claims follow it exactly: the signature binds the ROOM and the SLOT KEY —
 * both live in the signed bytes, neither in the record — so a valid claim
 * cannot be lifted to another slot or another room, and a record naming a
 * pub whose private key the writer does not hold never verifies.
 *
 * NO LEGACY ACCEPTANCE. doorPolicy honours unsigned records because door
 * policies shipped before D3. Stand claims have never shipped — the map is new
 * in the same PR — so an unsigned or unverifiable record is simply "no claim"
 * (standsDoc.ts verifies on read). There is nothing to migrate.
 *
 * WHAT SIGNING DOES NOT PREVENT (documented residuals — the same class as the
 * door-request residuals in doorPolicy.ts):
 *   • DENIAL, not forgery. The Y.Map is peer-writable, so any peer can still
 *     delete or garbage-overwrite a valid claim. Readers see "no claim", the
 *     holder's heartbeat rewrites it within STAND_CLAIM_HEARTBEAT_MS, and a
 *     walk-up racing that window can land on the slot. Closing this needs
 *     signed CRDT ops at the transport layer — out of scope here.
 *   • REPLAY of a holder's OWN past claim. The bytes stay valid, but only
 *     inside the TTL + skew window (isClaimActive): at most one
 *     STAND_CLAIM_TTL_MS after the holder's last heartbeat. No sequence number
 *     is added — the temporal bound already caps the damage, and there is no
 *     revoke flow that a watermark would protect.
 *   • SYBIL. Any keypair may claim any slot: a signature proves the writer
 *     holds the key, not that the key belongs to a player at the table. The
 *     proximity filter in world.ts's pickFreeStand is the backstop.
 *
 * TRUST BOUNDARY. Every value read out of the doc goes through isStandClaim
 * (shape) and then the standsDoc verifier (signature). A hostile peer can
 * plant a Y.Map, a raw string, a legacy { playerId } record or a forged
 * signature under any key, and every one of those reads as "no claim" rather
 * than crashing walk-up routing — the same discipline as playersMap.get +
 * shape-guard in main.ts and the checkers/chess state guards in gamesDoc.ts.
 *
 * OWNERSHIP RULE. `canPlayerClaim(claim, pub, now)` says a claim is "yours" if
 * the recorded pub matches OR the claim has aged past the TTL (a crashed
 * peer's stand self-heals after ~15 s of silence). It never allows one live
 * player to displace another — that would be the second-order bug this whole
 * slice is here to prevent.
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
import { canonicalEncode } from './treasuryTypes';

/**
 * A live claim on one stand slot. Written whole-value per key (LWW) —
 * refreshing the timestamp is a fresh signature over the same slot.
 */
export interface StandClaim {
  /**
   * The holder's Ed25519 identity pub (keypair.getIdentityPub) — never a
   * per-install player id (#22 lane ids, and a playerId is not signable).
   */
  readonly pub: string;
  /**
   * Wall-clock ms (Date.now) captured at write time; drives expiry. Must be
   * a SAFE INTEGER — canonicalEncode refuses floats, and the shape guard
   * enforces it up front so a read can never throw inside the encoder.
   */
  readonly at: number;
  /** Signature by `pub` over standClaimSignatureBytes(roomId, slotId, this). */
  readonly sig: string;
}

/**
 * Domain tag mixed into every signed byte string (ssf-<kind>:v1 convention,
 * beside ssf-id-cert:v1 / ssf-door-request:v1 / ssf-env:v1) so a stand-claim
 * signature can never double as any other record's signature.
 */
export const STAND_CLAIM_DOMAIN = 'ssf-stand-claim:v1';

/**
 * The exact bytes a stand claim is signed over. Deterministic CBOR via
 * canonicalEncode (treasuryTypes.ts), covering the DOMAIN, the ROOM, the SLOT
 * KEY and the claim body — so the same (pub, at) signed for one slot verifies
 * for that slot only, in that room only. `sig` is never part of the input.
 *
 * Readers rebuild these bytes over the map KEY the record was found under
 * and the room the doc is bound to, never over anything the record says
 * about itself (standsDoc.ts).
 *
 * Throws if `at` is not a safe integer (the encoder's rule); isStandClaim
 * screens that out before any read reaches here, and a write uses Date.now().
 */
export function standClaimSignatureBytes(
  roomId: string,
  slotId: string,
  claim: Pick<StandClaim, 'pub' | 'at'>,
): Uint8Array {
  return canonicalEncode({
    domain: STAND_CLAIM_DOMAIN,
    roomId,
    slotId,
    claim: { pub: claim.pub, at: claim.at },
  });
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
 * object with non-empty `pub` and `sig` strings and a safe-integer `at` —
 * the three fields every downstream function (and the signature check)
 * reads. A legacy { playerId, at } record fails here by construction.
 *
 * A hostile peer can plant a Y.Map under a claim key; typeof (new Y.Map())
 * is 'object' but its entries are not own properties in the JSON sense, so
 * the shape check rejects it. Same defence used by isCheckersState /
 * isChessState / bindTreasuryDoc.
 *
 * `at` is pinned to Number.isSafeInteger rather than Number.isFinite because
 * canonicalEncode throws on any other number — the guard is what keeps the
 * read path exception-free.
 */
export function isStandClaim(value: unknown): value is StandClaim {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<StandClaim>;
  return (
    typeof v.pub === 'string' &&
    v.pub.length > 0 &&
    typeof v.sig === 'string' &&
    v.sig.length > 0 &&
    typeof v.at === 'number' &&
    Number.isSafeInteger(v.at)
  );
}

/**
 * How far ahead of us a claim's clock may be and still count as live.
 *
 * A peer's clock genuinely can run a few seconds fast, and refusing every
 * future timestamp would let one skewed peer strand a slot it legitimately
 * holds. But the tolerance has to be BOUNDED: `at` is chosen by the writer
 * (a signature proves who wrote it, not that their clock is honest), and an
 * unbounded future acceptance means `at = Date.now() + 1e12` is always
 * active — a permanently-active claim closes BOTH reclaim paths at once
 * (canPlayerClaim refuses every other player, findExpiredClaims skips it)
 * so the slot is dead for the life of the doc.
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
 * True if the identity `pub` is allowed to WRITE a fresh claim over
 * `existing`:
 *   • no prior claim (empty slot); OR
 *   • the claim is theirs (heartbeat renewal); OR
 *   • the claim is stale (holder crashed, past TTL).
 * Deliberately does NOT let a live peer bump another live peer — that's the
 * conflict this whole slice defends against.
 */
export function canPlayerClaim(
  existing: StandClaim | null,
  pub: string,
  now: number,
): boolean {
  if (existing === null) return true;
  if (existing.pub === pub) return true;
  return !isClaimActive(existing, now);
}

/**
 * Ordered candidates for a walk-up, given a claim snapshot + an identity.
 *
 * TIER RULE:
 *   1. OPEN slots that this identity ALREADY CLAIMS (heartbeat resume — if I
 *      focused and briefly walked away my slot is still mine). Includes
 *      MY reserved-slot claim when I'm authorised (canOperateReserved), so
 *      an owner walking back to their wheel-head post lands on the SAME
 *      spot they left — issue #76: "someone that has spin privileges, to
 *      stand in a reserved spot".
 *   2. OPEN non-reserved slots claimable by this identity (empty or stale).
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
 * local identity claims — aligning pickStandForWalkup's tier assignment
 * removes a subtle disagreement between the two layers.
 */
export function pickStandForWalkup(args: {
  slots: readonly StandSlot[];
  claims: ReadonlyMap<string, StandClaim>;
  /** The local identity pub — what claimStand signs as (standsDoc.localStandPub). */
  pub: string;
  now: number;
  canOperateReserved: boolean;
}): StandSlot[] {
  const { slots, claims, pub, now, canOperateReserved } = args;
  const mineActive: StandSlot[] = [];
  const openCivilian: StandSlot[] = [];
  const openReserved: StandSlot[] = [];
  for (const s of slots) {
    const claim = claims.get(s.id) ?? null;
    // "Mine, still active" wins the first tier so re-focus resumes cleanly.
    if (claim && claim.pub === pub && isClaimActive(claim, now)) {
      // A held reserved slot (owner already at the wheel-head) belongs in
      // the same "mine" tier so a re-focus still lands on it — but only if
      // the player is still authorised (canOperateReserved). If not, we
      // quietly skip: the claim will expire, and the caller falls back to
      // the device's own front. A civilian slot (no `role`) is always mine
      // to resume.
      if (!s.role || canOperateReserved) mineActive.push(s);
      continue;
    }
    if (!canPlayerClaim(claim, pub, now)) continue;
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
 * caller's identity pub. Guard against a hypothetical race where our TTL
 * expired between claim-and-release and another peer legitimately took
 * the slot — we must not drop THEIR claim.
 *
 * Pure helper used by world.ts's releaseStandById; centralised here so the
 * ownership rule is testable without a live doc.
 */
export function shouldReleaseSlot(
  current: StandClaim | null,
  pub: string,
): boolean {
  return current === null || current.pub === pub;
}

/**
 * Which claims are expired AND not held by any currently online identity —
 * safe to delete from the doc. A live-but-quiet player still gets to keep
 * their slot (the heartbeat will refresh it once the tab wakes).
 *
 * `onlinePubs` is a set of identity PUBS (the `players` entries' keyB64),
 * because that is what a claim carries — a set of player ids would never
 * match and every quiet peer would read as reapable.
 *
 * Used by the world-update reaper; a delete is a whole-value key removal, so
 * a race with a fresh heartbeat resolves the same way as any Y.Map LWW: the
 * later write wins and the slot is either back or gone.
 */
export function findExpiredClaims(args: {
  claims: ReadonlyMap<string, StandClaim>;
  onlinePubs: ReadonlySet<string>;
  now: number;
}): string[] {
  const { claims, onlinePubs, now } = args;
  const stale: string[] = [];
  for (const [slotId, claim] of claims) {
    if (isClaimActive(claim, now)) continue;
    if (onlinePubs.has(claim.pub)) continue;
    stale.push(slotId);
  }
  return stale;
}
