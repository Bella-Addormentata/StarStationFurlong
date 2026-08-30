/**
 * 🛰️ The shared default station (#79 P3 + P6).
 *
 * Instead of every fresh install minting its own random `home-*` room
 * (identity.ts getDefaultRoomId), a FIRST-RUN install boots into ONE common
 * station: a small welcome room (a clone-vat + one door) that everyone shares.
 * Returning installs keep their own home / last location (#79 P4) — this only
 * changes where a brand-new install lands.
 *
 * P6 (#79) also bakes a FIRST-BOOT ATLAS SNAPSHOT here: on a very first boot
 * the local station-atlas cache is empty and the exterior view can only render
 * the ONE module we happen to have joined ("empty/single-module view" the
 * owner ask calls out). The snapshot below carries the shared station's known
 * cardinal-door layout, so the exterior renders the WHOLE station immediately;
 * once real peers gossip or the current room's own harvest fires, the live
 * data replaces our baked stubs (bootFlow.mergeFirstBootAtlas is
 * non-destructive, and stationAtlas.pushAtlasToDoc skips entries carrying the
 * `lastSeen === 0` first-boot sentinel so we never publish placeholder data).
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

// ── 🗺️ FIRST-BOOT ATLAS SEED (#79 P6) ───────────────────────────────────────
//
// See the file header: on the very first boot the station-atlas store is
// empty, and the exterior view has nothing to render but the ONE module we
// happen to have joined. That produces the "empty / single-module view" the
// owner ask calls out. To fix it we bake a KNOWN shell of the station in as
// a first-boot seed the atlas can merge on top of an empty local store; once
// real gossip arrives, the live entries overwrite our sentinel stubs (see
// stationAtlas.mergeFirstBootAtlas + the pushAtlasToDoc `lastSeen === 0`
// guard that keeps the sentinel data OUT of the shared doc).
//
// GEOMETRY + NAMES ONLY — no `targetSeed` credentials ride in the baked seed.
// Doors record which cardinal wall they sit on so the exterior renderer can
// pose neighbour modules, but the pass to DIAL a neighbour has to come from
// real gossip (or from actually walking there through the shared station).

/** A door on a first-boot seed entry — geometry + names only, no seeds. Wall
 *  is a cardinal so the exterior can pose the far module without probing an
 *  atlas we don't yet have. */
export interface StationAtlasSeedDoor {
  /** Door id in the near room (e.g. 'north' | 'south' | 'east' | 'west'). */
  doorId: string;
  /** Far room's stable id — matches another seed entry's roomId. */
  targetRoomId: string;
  /** The near door's wall in door-layout axis vocabulary (y-/y+/x+/x-). */
  wall: 'x+' | 'x-' | 'y+' | 'y-';
  /** Signed distance along the wall from centre (0 = centre of the wall). */
  lateral: number;
  /** Optional matching door on the far room. Baked when we know the ring
   *  faces its opposite door (e.g. north↔south) so the pose composes. */
  farDoor?: string;
  farWall?: 'x+' | 'x-' | 'y+' | 'y-';
  farLateral?: number;
}

/** A first-boot seed atlas entry — the same shape the atlas store uses,
 *  minus the timestamp (bakeed entries stamp `lastSeen: 0` as their sentinel;
 *  see stationAtlas.mergeFirstBootAtlas). */
export interface StationAtlasSeedEntry {
  roomId: string;
  name: string;
  dims?: { cols: number; rows: number };
  doors: StationAtlasSeedDoor[];
}

/**
 * The baked first-boot atlas for the shared station.
 *
 * Layout: a hub-and-four-arms shell — the shared station room in the middle,
 * four cardinal-doored neighbour modules stubbed around it. Names are
 * placeholders that any real gossip will overwrite; door wall+lateral drives
 * the exterior renderer's neighbour placement (see stationAtlas.atlasLayout,
 * which BFS'es from the current room and composes each hop's pose).
 *
 * Why FOUR arms: exteriorView renders whatever atlasLayout returns, and
 * atlasLayout returns every module reachable from the current room. A four-
 * neighbour shell gives the "full station" visual the owner asks for on the
 * very first boot without pretending we know the whole octagon (which the
 * shared doc's own gossip fills in once a real peer joins).
 *
 * ⚠️ No `targetSeed` fields — a baked seed is GEOMETRY, not a credential. To
 * ACTUALLY walk through one of these stubbed doors, real gossip has to
 * supply the pass first.
 */
export const STATION_ATLAS_SEED: StationAtlasSeedEntry[] = [
  {
    roomId: STATION_ROOM_ID,
    name: 'Furlong Station',
    doors: [
      // Cardinal doors at the wall centres — the exterior renders each
      // neighbour flush against the named wall.
      { doorId: 'north', targetRoomId: 'furlong-atrium',      wall: 'y-', lateral: 0, farDoor: 'south', farWall: 'y+', farLateral: 0 },
      { doorId: 'south', targetRoomId: 'furlong-market',      wall: 'y+', lateral: 0, farDoor: 'north', farWall: 'y-', farLateral: 0 },
      { doorId: 'east',  targetRoomId: 'furlong-observatory', wall: 'x+', lateral: 0, farDoor: 'west',  farWall: 'x-', farLateral: 0 },
      { doorId: 'west',  targetRoomId: 'furlong-lounge',      wall: 'x-', lateral: 0, farDoor: 'east',  farWall: 'x+', farLateral: 0 },
    ],
  },
  // Neighbour stubs — a single door back to the station so a client that
  // somehow visits one first still sees the hub. No cross-arm doors: the
  // baked shell is deliberately a spoke topology, and real gossip supplies
  // whatever cross-connections the live station actually holds.
  {
    roomId: 'furlong-atrium',
    name: 'Atrium',
    doors: [
      { doorId: 'south', targetRoomId: STATION_ROOM_ID, wall: 'y+', lateral: 0, farDoor: 'north', farWall: 'y-', farLateral: 0 },
    ],
  },
  {
    roomId: 'furlong-market',
    name: 'Market',
    doors: [
      { doorId: 'north', targetRoomId: STATION_ROOM_ID, wall: 'y-', lateral: 0, farDoor: 'south', farWall: 'y+', farLateral: 0 },
    ],
  },
  {
    roomId: 'furlong-observatory',
    name: 'Observatory',
    doors: [
      { doorId: 'west',  targetRoomId: STATION_ROOM_ID, wall: 'x-', lateral: 0, farDoor: 'east',  farWall: 'x+', farLateral: 0 },
    ],
  },
  {
    roomId: 'furlong-lounge',
    name: 'Lounge',
    doors: [
      { doorId: 'east',  targetRoomId: STATION_ROOM_ID, wall: 'x+', lateral: 0, farDoor: 'west',  farWall: 'x-', farLateral: 0 },
    ],
  },
];

/**
 * Defensive-copy accessor for the first-boot seed. Same discipline as
 * `sharedStationBootstrap`: the caller MUST NOT be able to mutate the baked
 * constant. Every entry, every door, every array is a fresh instance.
 */
export function firstBootAtlasSeed(): StationAtlasSeedEntry[] {
  return STATION_ATLAS_SEED.map((e) => ({
    roomId: e.roomId,
    name: e.name,
    dims: e.dims ? { cols: e.dims.cols, rows: e.dims.rows } : undefined,
    doors: e.doors.map((d) => ({
      doorId: d.doorId,
      targetRoomId: d.targetRoomId,
      wall: d.wall,
      lateral: d.lateral,
      farDoor: d.farDoor,
      farWall: d.farWall,
      farLateral: d.farLateral,
    })),
  }));
}
