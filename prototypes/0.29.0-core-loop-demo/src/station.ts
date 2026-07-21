/**
 * 🛰️ The shared default station (#79 P3a).
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
 * FILL-IN: the three constants below are PLACEHOLDERS. Stand up the always-on
 * host (a machine that stays up, running this build, holding the authored
 * vat+door station), copy its pass, and paste roomId / roomKeyB64 / the host's
 * memberHint here. Until then hasSharedStation() is false and the boot flow
 * falls back to today's per-install home — so this file is inert + no-regression.
 */

/** A peer's iroh reachability, as a pass's memberHints carry it. */
export interface StationHint {
  nodeId: string;
  relayUrls?: string[];
  directAddrs?: string[];
}

// ── FILL THESE FROM THE HOST'S PASS ──────────────────────────────────────────

/** The station's permanent room id (e.g. "station-…"). Empty = not configured. */
export const STATION_ROOM_ID: string = '';

/** The station's permanent room key (base64url, from the pass). Empty = off. */
export const STATION_ROOM_KEY_B64: string = '';

/** The always-on host's node hint(s) — the discovery seed. Empty = no seed. */
export const STATION_SEED_HINTS: StationHint[] = [];

// ─────────────────────────────────────────────────────────────────────────────

/** Is a shared default station configured (all three fields filled)? Until the
 *  host's pass is baked this is false, so first-run installs keep minting their
 *  own home — the whole feature stays inert with no behaviour change. */
export function hasSharedStation(): boolean {
  return (
    STATION_ROOM_ID.length > 0 &&
    STATION_ROOM_KEY_B64.length > 0 &&
    STATION_SEED_HINTS.length > 0
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
    memberHints: STATION_SEED_HINTS,
  };
}
