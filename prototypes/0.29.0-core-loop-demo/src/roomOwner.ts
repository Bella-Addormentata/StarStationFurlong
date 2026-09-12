/**
 * 🔒 The room owner gate (#141) — extracted so it can be TESTED.
 *
 * Every owner-gated surface in the game funnels through `isRoomOwner`:
 * docking, edit mode, policies, co-hosts, the room-name editor. It lived
 * inside main.ts, which runs the whole client on import and so cannot be
 * loaded by a unit test — meaning the single most authority-bearing
 * predicate in the codebase had no coverage at all. It does now.
 *
 * Dependencies arrive as an argument rather than by import, so a test can
 * state "this player, holding these shares" directly. main.ts keeps a
 * same-named wrapper that supplies its live getters.
 *
 * ⚠️ WHAT THIS IS NOT. This decides what the LOCAL UI offers. It is not
 * write authorization: nothing authorizes a write to a room doc today, so a
 * modified client ignores every function in this file and writes the Yjs
 * record anyway. The gate becomes real at the keyed-room-id step, when write
 * authority becomes node-enforced grant-set membership. Until then, read
 * every check here as "should this client offer the action", never as
 * "can this peer do it".
 */

/** What the predicate needs to know about the local player. */
export interface OwnerContext {
  /** The local player id, as written into `roomInfo.owner` since S2. */
  playerId: string;
  /** True when we hold ANY share of the venture registered in this room —
   *  #68's V1 owner rule makes joint owners owner-equivalent everywhere. */
  isVentureShareholder: boolean;
}

/**
 * True when the local player holds owner authority over a room whose
 * `roomInfo.owner` is `owner`.
 *
 * 🔒 #141: there is deliberately NO `owner === 'Local-Clone'` clause.
 *
 * That clause granted owner authority over a room to EVERY peer at once. It
 * was a deliberate S2 convention for pre-identity rooms, not an oversight,
 * which is why removing it is a BREAKING change rather than a pure fix: a
 * room whose owner is the literal `'Local-Clone'` (or unset) now has nobody
 * who passes this check, including whoever built it. Those rooms are
 * read-only.
 *
 * There is no migration, because there is nothing to migrate FROM. The
 * marker records the ABSENCE of an owner — no owner can be recovered from
 * the doc, and picking one by first-claim would just hand the room to
 * whoever raced there. A keyed room id gives these rooms a verifiable owner
 * again; until then the refusal is explained in the UI rather than left to
 * read as a bug (see `ownerGateRefusal`).
 *
 * ⚠️ THE LEGACY CHECK COMES FIRST, AHEAD OF BOTH GRANT BRANCHES.
 *
 * Ordering this after the shareholder branch looks equivalent and is not:
 * the venture branch does not consult `owner` at all, so a legacy room that
 * merely CONTAINS a venture record stayed writable, and the "read-only for
 * everyone" guarantee above was false.
 *
 * Worse than a doc mismatch — it handed every legacy room to the #142
 * attack. A venture office record is an unauthenticated peer write, so
 * planting one in a legacy room makes the planter a shareholder, and the
 * shareholder branch then returns owner authority over the very rooms this
 * change was meant to close. Retiring the wildcard would have moved the
 * takeover from "walk in" to "plant one record", not removed it.
 *
 * The cost of ordering it this way: a venture legitimately registered in a
 * legacy room BEFORE this change loses shareholder access along with
 * everyone else. Accepted — going forward that state is unreachable anyway,
 * since founding a venture requires a room you own and nobody owns a legacy
 * room now.
 */
export function isRoomOwner(owner: string, ctx: OwnerContext): boolean {
  if (legacyOwnerMarker(owner)) return false;
  return owner === ctx.playerId || ctx.isVentureShareholder;
}

/**
 * True when `owner` names no verifiable owner: the legacy pre-S2 marker, or
 * a doc that never carried one.
 *
 * Used to REFUSE (the first check in `isRoomOwner`) and to explain a refusal.
 * It must never appear in a condition that GRANTS something — that is
 * precisely the shape of the bug #141 reported.
 */
export function legacyOwnerMarker(owner: string): boolean {
  return !owner || owner === "Local-Clone";
}

/**
 * The refusal text for an owner-gated action, so every gate says the same
 * thing and a legacy room reads as legacy rather than as the baffling
 * "Only the owner (Local-Clone) can edit this room."
 *
 * `action` is a verb phrase ("edit", "rename").
 */
export function ownerGateRefusal(
  owner: string,
  action: string,
  resolveOwnerLabel: (owner: string) => string,
): string {
  return legacyOwnerMarker(owner)
    ? `This module predates room ownership, so no one can ${action} it. Its doc records no owner to check against (#141).`
    : `Only the owner (${resolveOwnerLabel(owner)}) can ${action} this room.`;
}
