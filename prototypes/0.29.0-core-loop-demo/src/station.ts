/**
 * 🛰️ The shared default station (#79 P3).
 *
 * Instead of every fresh install minting its own random `home-*` room
 * (identity.ts getDefaultRoomId), a FIRST-RUN install boots into ONE common
 * station: a small welcome room (a clone-vat + one door) that everyone shares.
 * Returning installs keep their own home / last location (#79 P4) — this only
 * changes where a brand-new install lands.
 *
 * DURABLE vs SEED — the split that lets us change ownership without re-baking:
 *   • ROOM_ID + ROOM_KEY_B64 are the station's PERMANENT identity + encryption
 *     key. Bake once, never change. Ownership (roomInfo.owner / a company
 *     venture record) is a LIVE property of the room doc, so we can go
 *     personal-owned → company-owned later with zero re-bake.
 *   • SEED_HINTS is the bootstrap seed: the always-on host's iroh node id +
 *     relay url(s) + direct addrs, so a hint-less fresh install can dial the
 *     host and sync the real (populated) station. The node id + relay are
 *     durable-ish; direct addrs drift. P3b (Chia mesh) makes discovery
 *     self-healing (resolve live addrs by ROOM_KEY alone) and retires the seed.
 *
 * ⚠️ SELF-DIAL TRAP (identity.ts:73 history): because every install shares this
 * ROOM_ID, a joiner's own node is `served` for it too. The join only works if
 * the node DIALS the seed host (SEED_HINTS present) and the browser RE-SYNCS
 * after the link (the existing quiescent backfill) — otherwise each install
 * sits on its own empty replica. This MUST be verified with a live host + a
 * separate joiner before shipping (see [[ssf-node-sync-topology]]).
 *
 * HINTS-OPTIONAL STAGE (dev): the station id + key are BAKED, but the always-on
 * host's memberHints stay empty until a host is stood up. In this stage:
 *   • every install still boots into the SAME station id — passes flow, atlas
 *     converges as soon as any two clients meet (over LAN mDNS today, or via
 *     the DHT / relay lanes once configured), and the shared-station wiring is
 *     end-to-end verifiable.
 *   • without a seed host, each install sits on its own empty replica until it
 *     first meets a peer. That is a KNOWN LIMIT of the dev stage — noted in
 *     the boot code path and surfaced by the missing peer count on the phone.
 *   • adding hints later is a one-line change here; the runtime picks them up
 *     on the next boot with no other code changes.
 */

/** A peer's iroh reachability, as a pass's memberHints carry it. */
export interface StationHint {
  nodeId: string;
  relayUrls?: string[];
  directAddrs?: string[];
}

// ── SHARED STATION IDENTITY (baked into the install) ─────────────────────────
//
// Both ROOM_ID and ROOM_KEY_B64 must be **stable** for the lifetime of the
// station — they are baked into every install and, once shipped, every player
// who joins expects them here. Changing either splits the community across
// two rooms with the same intent (the "chose a new home id" trap #79 §P3
// spells out). Bump only for a real re-bake ceremony, never as a "fresh key".

/** The station's permanent room id. Stable — every install joins THIS name. */
export const STATION_ROOM_ID: string = 'station-furlong-alpha';

/**
 * The station's permanent room key (base64url of 32 bytes). Stable — the room
 * key is the ROOM-doc encryption key everyone in the station uses.
 *
 * Baked from `crypto.randomBytes(32)` at station introduction — see the header
 * for the durable-vs-seed split; rotating this key would fork the station.
 */
export const STATION_ROOM_KEY_B64: string =
  'rLP2KWvZd-cUXMW1yM8RaVMTzkakW3Jl9nkgyhwVktQ';

/**
 * The always-on host's node hint(s) — the discovery seed.
 *
 * EMPTY in this dev stage (no always-on host stood up yet). Once a host is
 * running the shared station, its `iroh_node_id` + relay URLs go here so a
 * hint-less fresh install can dial it directly. See the header for the
 * self-dial trap this closes and the plan to retire seeds via the DHT / Chia
 * mesh once discovery-by-room-key alone is reliable.
 */
export const STATION_SEED_HINTS: StationHint[] = [];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is a shared default station configured?
 *
 * The gate deliberately requires only roomId + roomKey — hints are OPTIONAL,
 * because a fresh install still benefits from a shared station id even when
 * the always-on host isn't up yet (peers converge via LAN/DHT/relay when they
 * meet). `hasSharedStationSeed()` narrows to the fully-seeded case for callers
 * that want to know whether direct dialing to a seed host is available.
 */
export function hasSharedStation(): boolean {
  return STATION_ROOM_ID.length > 0 && STATION_ROOM_KEY_B64.length > 0;
}

/** Stricter gate: shared station AND at least one seed hint bakes-in. */
export function hasSharedStationSeed(): boolean {
  return hasSharedStation() && STATION_SEED_HINTS.length > 0;
}

/** True iff `roomId` names the shared station (case-sensitive, exact match). */
export function isSharedStationRoom(roomId: string | null | undefined): boolean {
  return (
    hasSharedStation() &&
    typeof roomId === 'string' &&
    roomId === STATION_ROOM_ID
  );
}

/** The station's join descriptor (room id + key + the host seed hints) for the
 *  boot flow to hand the node, or null when unconfigured. The boot wiring uses
 *  this in place of a minted home-* room for a FIRST-RUN install. */
export function sharedStationBootstrap(): {
  roomId: string;
  roomKeyB64: string;
  memberHints: StationHint[];
} | null {
  if (!hasSharedStation()) return null;
  return {
    roomId: STATION_ROOM_ID,
    roomKeyB64: STATION_ROOM_KEY_B64,
    // Return a defensive COPY so a caller can't mutate the baked-in constant.
    memberHints: STATION_SEED_HINTS.map((h) => ({
      nodeId: h.nodeId,
      relayUrls: h.relayUrls ? [...h.relayUrls] : undefined,
      directAddrs: h.directAddrs ? [...h.directAddrs] : undefined,
    })),
  };
}
