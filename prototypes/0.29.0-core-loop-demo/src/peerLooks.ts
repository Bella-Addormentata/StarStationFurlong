/**
 * 🦊 Whose fox is that? (the lane-id → player match, "S3" in the comments
 * of main.ts and outfits.ts)
 *
 * A remote fox reaches this page as movement ticks, and each tick carries
 * the 8-byte lane id its sender's node put before it (protocol.ts
 * `unpackAddressedTick`): the rig is keyed `peer-<lane hex>`. A players
 * entry is keyed by the player's per-install id. Nothing tied the two, so a
 * remote fox could only be told apart by a hue tint (world.ts
 * `applyPeerTint`), and the outfit a player picked was seen by that player
 * alone.
 *
 * Now each page's node tells it, once per session, the lane its own ticks
 * carry (a `lane` envelope on the sync stream, node-local, see the node's
 * `write_lane_envelope`), and the page writes it into its players entry
 * (`lane`). Every other page reads the entries, finds the one whose lane a
 * fox carries, and dresses that fox in the entry's outfit.
 *
 * A players entry is anyone's to write, so what is read here is checked:
 * a lane is exactly 16 lowercase hex digits, an outfit is a string, and a
 * lane that two entries claim matches neither (that fox keeps its tint). The
 * worst a false entry does is dress one fox in one of the game's outfits.
 */

import { cleanLook, type FoxLook } from './foxLook';

/** A lane id as the page reads it off an addressed tick: 8 bytes, 16 hex. */
const LANE_HEX = /^[0-9a-f]{16}$/;

/** The prefix world.ts keys a remote rig by (main.ts's tick handler). */
const PEER_PREFIX = 'peer-';

export function isLaneId(value: unknown): value is string {
  return typeof value === 'string' && LANE_HEX.test(value);
}

/**
 * The lane a `lane` envelope tells, or null for any other envelope or a
 * malformed one. The payload is base64 of `{"lane":"<16 hex>"}`.
 */
export function laneFromEnvelope(env: { kind?: unknown; payload?: unknown }): string | null {
  if (env.kind !== 'lane' || typeof env.payload !== 'string') return null;
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(env.payload), (c) => c.charCodeAt(0)));
    const body: unknown = JSON.parse(text);
    const lane = body && typeof body === 'object' ? (body as { lane?: unknown }).lane : undefined;
    return isLaneId(lane) ? lane : null;
  } catch {
    return null;
  }
}

/** The lane a remote rig's id names, or null for any other id. */
export function laneOfPeerId(peerId: string): string | null {
  if (!peerId.startsWith(PEER_PREFIX)) return null;
  const lane = peerId.slice(PEER_PREFIX.length);
  return isLaneId(lane) ? lane : null;
}

/**
 * Each lane the players entries claim, with the outfit id of the entry that
 * claims it. An entry counts when it is an object with a well-formed `lane`
 * and a string `outfitId`; a lane claimed by two or more entries is left
 * out, since nothing says which is true.
 */
export function outfitsByLane(entries: Iterable<[string, unknown]>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [lane, dress] of looksByLane(entries)) found.set(lane, dress.outfitId);
  return found;
}

/** What the entry that claims a lane says of its fox: its outfit, and its
 *  own look (foxLook.ts), cleaned, or null from a game with no looks. */
export interface PeerDress {
  outfitId: string;
  look: FoxLook | null;
}

/** `outfitsByLane` with each entry's look beside its outfit: the same
 *  entries count, and a lane two entries claim is left out the same way. */
export function looksByLane(entries: Iterable<[string, unknown]>): Map<string, PeerDress> {
  const found = new Map<string, PeerDress>();
  const claimedTwice = new Set<string>();
  for (const [, raw] of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const { lane, outfitId, look } = raw as { lane?: unknown; outfitId?: unknown; look?: unknown };
    if (!isLaneId(lane) || typeof outfitId !== 'string') continue;
    if (found.has(lane)) claimedTwice.add(lane);
    else found.set(lane, { outfitId, look: look === undefined || look === null ? null : cleanLook(look) });
  }
  for (const lane of claimedTwice) found.delete(lane);
  return found;
}
