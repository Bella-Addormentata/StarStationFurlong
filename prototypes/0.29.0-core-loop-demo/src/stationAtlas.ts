/**
 * 🗺️ Station atlas — every module THIS CLIENT has seen (#62 P5 findings)
 *
 * The exterior view can only render what it knows, and the client holds ONE
 * room doc at a time — so the atlas accumulates knowledge by VISITATION
 * (the ventures-gossip pattern applied to topology): every room you join
 * contributes its identity (roomId, name, your pass/ledger seed for it when
 * known) and its DOOR RECORDS (address + chain geometry per door) to a local
 * store. Walk the octagon once and your atlas holds all eight modules; the
 * exterior then renders the WHOLE known station, and clicking a module from
 * space fills an open keypad's address box (the owner's close-the-ring flow).
 *
 * LOCAL, per-install (localStorage) — a personal map of where you've been.
 *
 * 🛰️ SHARED station atlas (owner request 2026-07-19): the room doc ALSO
 * carries an `atlas` map, two-way merged with the local store — every client
 * writes what it knows UP and merges what the doc knows DOWN, so each room's
 * doc converges toward the whole station's layout (the ventures-gossip
 * pattern applied to topology). A visiting ship that joins ANY room of the
 * station downloads the full map with the doc sync and renders the entire
 * station from space BEFORE docking anywhere.
 *
 * CREDENTIAL RULE — layout is public, admission is not: gossip carries
 * GEOMETRY AND NAMES ONLY. Seeds (passes) never travel between docs, with
 * one exception: a doc's OWN-ROOM entry may carry its seed and door seeds —
 * the same doc already exposes them via doorsDoc, so nothing new leaks —
 * and the top-level seed rides only while the room's passage policy is
 * public. Locally-earned seeds are never erased by seedless shared entries.
 */

import * as Y from 'yjs';
import type { DoorId } from './doors';
import type { ConnectorSegment } from './adapter';
import { ROOM_TILE_MIN, ROOM_TILE_MAX } from './floorPlanDoc';
import type { DoorWall } from './doorLayoutDoc';
import { normalizeWall } from './doorLayoutDoc';
import { projectionPoseForDoor, projectionPoseFromWall } from './adapter';
import { halfAlongWall } from './doorMatch';

export interface AtlasDoor {
  /** The far room's SEED LINK (from the door record) — also the click-to-
   *  connect payload. */
  targetSeed: string;
  /** Far room id parsed from the seed link (graph key), '' if unparseable. */
  targetRoomId: string;
  segments?: ConnectorSegment[];
  /** May name a free `d:` door in the far room. */
  farDoor?: string;
  /** The far door's WALL (from the pairing record) — orients the far module. */
  farWall?: DoorWall;
  /** The far door's along-wall centre — shifts the far module sideways. */
  farLateral?: number;
  farYawDeg?: 0 | 45;
  /** 🧭 This door's OWN physical pose, harvested live by a client standing in
   *  the room that owns it. What lets everyone ELSE compose the station graph
   *  through this room: a hop used to pose a neighbour's door from the CURRENT
   *  room's snapshot, which was only ever right by coincidence. */
  wall?: DoorWall;
  lateral?: number;
}

export interface AtlasEntry {
  roomId: string;
  name: string;
  /** A seed link that reaches THIS room, when we hold one (ledger/passes). */
  seed?: string;
  /** 🛑📐 #80: the room's tile dimensions, learned while we were IN it — lets
   *  the exterior view render each module at its TRUE size. Absent for rooms we
   *  only know as neighbours (stub entries) → the renderer falls back. */
  dims?: { cols: number; rows: number };
  /** Keyed by DOOR ID — cardinal or free `d:`. */
  doors: Record<string, AtlasDoor>;
  /** GOSSIP freshness — derived from peers (`SharedAtlasEntry.updatedAt`).
   *  Use it to arbitrate MERGES and nothing else. It is peer-settable, so any
   *  ranking that decides what the player KEEPS or SEES must not read it:
   *  sorting a capped list by this hands a peer control of which of your own
   *  rooms survive the cap or reach the screen (#144). Use
   *  `compareAtlasRecency` for every such ordering. */
  lastSeen: number;
  /** LOCAL recency — when THIS install last had first-hand contact with the
   *  room (a visit, or first learning of it). No peer can set it, which is what
   *  makes it safe for eviction ordering. Optional: entries persisted before
   *  this field existed fall back to `lastSeen` in writeAtlas. */
  localSeenAt?: number;
  /** 🛰️ Set by seedAtlasDefaults: this entry's geometry came from the build's
   *  bundled default station, not from anything this install observed. It is
   *  what pushAtlasToDoc refuses to publish. Dropped the moment a harvest or a
   *  gossip pull rebuilds the entry — both construct it afresh. */
  bundled?: true;
}

const KEY = 'ssf-station-atlas';
export const MAX_ENTRIES = 64;
/** 🚪 Doors kept per gossiped entry — the same cap doorsDoc.readAllDoors puts
 *  on a room's own pairings (MAX_PAIRINGS). A shared entry's `doors` is a
 *  peer-written object that isSharedAtlasEntry does not size-check, and every
 *  consumer walks it (atlasLayout, the exterior, the CONNECT matcher's claim
 *  scan), so without this one entry could carry an arbitrarily large set. */
export const MAX_DOORS_PER_ENTRY = 64;
/** Raw `doors` keys a shared entry may carry before the whole entry is refused
 *  at ingest. An honest publisher never exceeds MAX_DOORS_PER_ENTRY (it pushes
 *  what readAllDoors read); the slack tolerates junk keys among real ones
 *  without letting one entry make every pull walk an unbounded object
 *  (review, round 3 — the kept-count cap alone still scanned it all). */
const MAX_RAW_DOORS_PER_ENTRY = 4 * MAX_DOORS_PER_ENTRY;

/** 🕒 How far ahead of OUR clock a peer's gossip stamp may sit before the whole
 *  shared entry is refused (#144). The comparison is against the reader's own
 *  clock and a browser mesh has no NTP guarantee, so this must cover honest
 *  skew — but whatever slack it allows is the head start an attacker keeps.
 *  Matches the venture-record bound in ventures.ts (#143). */
const MAX_GOSSIP_SKEW_MS = 6 * 60 * 60 * 1000;

export function roomIdFromSeed(seed: string): string {
  // REAL pass format (decodeBootstrapSeed): base64(JSON{ roomId, wtUrl, … }),
  // either raw or wrapped in a URL's ?seed= param. The #room= form is kept
  // last for the synthetic fixtures. (v0.32.4 shipped with ONLY the #room=
  // parse — every real edge decoded empty and the atlas graph never grew
  // past the current room; the owner's octagon caught it.)
  const tryB64 = (s: string): string => {
    try {
      const parsed = JSON.parse(atob(s));
      return typeof parsed?.roomId === 'string' ? parsed.roomId : '';
    } catch { return ''; }
  };
  try {
    const url = new URL(seed);
    const q = url.searchParams.get('seed');
    if (q) {
      const id = tryB64(q);
      if (id) return id;
    }
  } catch { /* not a URL — fall through */ }
  const direct = tryB64(seed);
  if (direct) return direct;
  const m = /[#&]room=([^&]+)/.exec(seed);
  return m ? decodeURIComponent(m[1]) : '';
}

export function readAtlas(): Record<string, AtlasEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return {};
    const atlas = obj as Record<string, AtlasEntry>;
    // 🕒 Repair a store poisoned BEFORE the ingest bound shipped. `lastSeen`
    // persists in localStorage, so the isSharedAtlasEntry guard cannot reach it
    // — and it does not just sit there: pushAtlasToDoc republishes it as
    // `updatedAt` (`Math.max(entry.lastSeen, known.updatedAt + 1)`), so a
    // legacy far-future value would be broadcast into every room doc we join,
    // where the new validator then REFUSES the entry — leaving that room
    // unmergeable for everyone until the poison is cleared at its source.
    // Zeroing it is the self-heal: the entry survives, and the next honest
    // gossip outranks it (`prior.lastSeen >= value.updatedAt` no longer holds).
    // The repair must be PERSISTED, not just applied to the value we return.
    // The ceiling moves with the clock, so an in-memory-only fix is temporary:
    // a stamp seven hours ahead reads as 0 now and, an hour later, is back
    // under the ceiling and returns unrepaired — ready to be republished.
    const ceiling = Date.now() + MAX_GOSSIP_SKEW_MS;
    let repaired = false;
    for (const e of Object.values(atlas)) {
      if (typeof e?.lastSeen === 'number' && e.lastSeen > ceiling) { e.lastSeen = 0; repaired = true; }
      if (typeof e?.localSeenAt === 'number' && e.localSeenAt > ceiling) { e.localSeenAt = 0; repaired = true; }
      // 🚪 An oversized door set persisted by a build before the ingest cap
      // (MAX_DOORS_PER_ENTRY) would otherwise stay oversized forever: the
      // pull's `prior` guard can skip the entry, and writeAtlas caps rooms,
      // not doors (review, round 2). Truncate in entry order and PERSIST, the
      // same way as the stamp repair — every consumer walks this set.
      if (e && typeof e.doors === 'object' && e.doors !== null) {
        const ids = Object.keys(e.doors);
        if (ids.length > MAX_DOORS_PER_ENTRY) {
          for (const id of ids.slice(MAX_DOORS_PER_ENTRY)) delete e.doors[id];
          repaired = true;
        }
      }
    }
    if (repaired) writeAtlas(atlas);
    return atlas;
  } catch { return {}; }
}

/**
 * 🗄️ The ONE ordering for any capped or truncated view of the atlas — the
 * eviction sort, and every UI that slices a "most recent" list.
 *
 * Two tiers, and never the gossip stamp:
 *   1. FIRST-HAND — rooms we visited, or whose seed we were handed. They carry
 *      `localSeenAt`, which only this install ever writes.
 *   2. GOSSIP-ONLY — learned from a peer's shared atlas. No local stamp, so
 *      they rank below any first-hand room however fresh a peer claims to be.
 *
 * Sorting such a list by `lastSeen` instead hands a peer the decision (#144),
 * whether the cap is localStorage retention (64) or a picker's slice (24). A
 * single join absorbs a whole station's atlas, so that is not a rare edge.
 *
 * Legacy entries predate `localSeenAt` and land in tier 2, ordered among
 * themselves by `lastSeen` — an upgrade loses the distinction for old entries
 * rather than mis-ranking them.
 */
export function compareAtlasRecency(a: AtlasEntry, b: AtlasEntry): number {
  const rank = (e: AtlasEntry): [number, number] =>
    e.localSeenAt === undefined ? [0, e.lastSeen] : [1, e.localSeenAt];
  const [at, ar] = rank(a);
  const [bt, br] = rank(b);
  return bt !== at ? bt - at : br - ar;
}

function writeAtlas(atlas: Record<string, AtlasEntry>): void {
  try {
    // 🗄️ Evict in two tiers, and never on the gossip stamp. `lastSeen` is
    // derived from a peer's `updatedAt`, so ordering retention by it let a peer
    // float its own entries to the top of a 64-deep list and push out rooms the
    // player actually walked through (#144).
    //
    // Tier 1 — FIRST-HAND: rooms we visited, or whose seed we were handed.
    // They carry `localSeenAt`, which only this install ever writes.
    // Tier 2 — GOSSIP-ONLY: learned from a peer's shared atlas. No local stamp,
    // so they are evicted before any visited room regardless of how fresh a
    // peer claims they are. A single join absorbs a whole station's atlas, so
    // without this tiering one hop into a busy station could evict the player's
    // own history.
    //
    // Legacy entries written before the field existed have no stamp and so land
    // in tier 2, ordered among themselves by `lastSeen` — an upgrade loses the
    // visited/gossip distinction for old entries rather than mis-ranking them.
    const entries = Object.values(atlas).sort(compareAtlasRecency).slice(0, MAX_ENTRIES);
    const out: Record<string, AtlasEntry> = {};
    for (const e of entries) out[e.roomId] = e;
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch { /* privacy mode — the atlas degrades to the current room */ }
}

/** Merge the CURRENT room's knowledge in (called on join + door changes). */
export function harvestIntoAtlas(entry: {
  roomId: string;
  name: string;
  seed?: string;
  dims?: { cols: number; rows: number };
  doors: Array<{
    doorId: string; targetSeed: string; segments?: ConnectorSegment[];
    farDoor?: string; farWall?: DoorWall; farLateral?: number; farYawDeg?: 0 | 45;
    wall?: DoorWall; lateral?: number;
  }>;
}): void {
  if (!entry.roomId) return;
  const atlas = readAtlas();
  const prior = atlas[entry.roomId];
  const doors: Record<string, AtlasDoor> = {};
  for (const d of entry.doors) {
    doors[d.doorId] = {
      targetSeed: d.targetSeed,
      targetRoomId: roomIdFromSeed(d.targetSeed),
      segments: d.segments,
      farDoor: d.farDoor,
      farWall: d.farWall,
      farLateral: d.farLateral,
      farYawDeg: d.farYawDeg,
      wall: d.wall,
      lateral: d.lateral,
    };
  }
  atlas[entry.roomId] = {
    roomId: entry.roomId,
    name: entry.name || prior?.name || 'Module',
    seed: entry.seed ?? prior?.seed,
    dims: entry.dims ?? prior?.dims,
    doors,
    lastSeen: Date.now(),
    // We are standing in it — the strongest possible local recency signal.
    localSeenAt: Date.now(),
  };
  // Stub entries for neighbors we now know exist (their seed reaches them —
  // clicking them from space can connect even before we ever visit).
  for (const d of Object.values(doors)) {
    if (!d || !d.targetRoomId || atlas[d.targetRoomId]) continue;
    atlas[d.targetRoomId] = {
      roomId: d.targetRoomId,
      name: 'Module',
      seed: d.targetSeed,
      doors: {},
      lastSeen: Date.now(),
      // NO local stamp. These targets come from `readAllDoors()`, whose room-doc
      // map is explicitly untrusted ("any value READ is untrusted — a peer could
      // write junk", doorsDoc.ts:16-17) and accepts up to MAX_PAIRINGS = 64
      // pairings — exactly MAX_ENTRIES. Stamping them first-hand would let one
      // peer write 64 fake pairings, have us mint 64 tier-1 stubs on join, and
      // evict every room we had actually visited: the precise attack this
      // tiering exists to stop. A door we can see is still only a peer's claim
      // that it leads somewhere, so the stub stays gossip-tier until we go.
    };
  }
  writeAtlas(atlas);
}

/**
 * Record a reach-this-room seed learned elsewhere (ledger mints, passes).
 *
 * ⚠️ NO PRODUCTION CALLERS as of this commit — it predates #144 and the seed
 * paths (`addPass`, ledger mints) never wired up to it. So although a handed
 * seed *would* count as first-hand below, in practice `harvestIntoAtlas` is
 * the only thing that mints `localSeenAt` today: standing in a room is what
 * earns tier 1. Left as-is rather than wired here, which would be a behaviour
 * change beyond the retention fix.
 */
export function noteRoomSeed(roomId: string, name: string, seed: string): void {
  if (!roomId || !seed) return;
  const atlas = readAtlas();
  const prior = atlas[roomId];
  atlas[roomId] = {
    roomId,
    name: name || prior?.name || 'Module',
    seed,
    doors: prior?.doors ?? {},
    lastSeen: prior?.lastSeen ?? Date.now(),
    // A seed we were handed is first-hand knowledge, but it says nothing new
    // about a room we already knew — so keep the prior recency when there is
    // one and only stamp on first learn.
    localSeenAt: prior?.localSeenAt ?? Date.now(),
  };
  writeAtlas(atlas);
}

/**
 * 🛰️ A build-time atlas entry — the shape defaultStation.atlas.json ships
 * (see defaultStation.ts). Geometry, names and the connection graph only: the
 * ONE seed a bundle may carry is the welcome room's own link, attached by
 * defaultStation.ts from its single link constant, never read from the file.
 */
export interface BundledAtlasEntry {
  roomId: string;
  name: string;
  dims?: { cols: number; rows: number };
  /** A reach-this-room link — the welcome room only (defaultStation.ts). */
  seed?: string;
  doors: Record<string, {
    targetRoomId: string;
    segments?: ConnectorSegment[];
    farDoor?: string;
    farWall?: DoorWall;
    farLateral?: number;
    farYawDeg?: 0 | 45;
    wall?: DoorWall;
    lateral?: number;
  }>;
}

/**
 * 🛰️ Merge a build's bundled station into the local atlas — at GOSSIP tier,
 * below everything this install learned itself. Called once per boot, so a
 * brand-new install renders the default station from space before the welcome
 * room's doc has synced (defaultStation.ts). Who outranks whom:
 *   · an entry with ANY first-hand recency (`localSeenAt`) or any door
 *     geometry is left exactly as it is — the bundle only fills rooms we know
 *     nothing about and neighbour stubs (a name, no doors, no size);
 *   · a filled entry keeps whatever gossip stamp it had, else `lastSeen: 0`,
 *     and never gains a local stamp — so the first honest gossip about it wins
 *     the pull's `prior.lastSeen >= updatedAt` check and it evicts before any
 *     visited room — and it is flagged `bundled`, which is what keeps
 *     pushAtlasToDoc from ever publishing it as something we observed.
 * Returns the number of entries written.
 */
export function seedAtlasDefaults(bundle: BundledAtlasEntry[]): number {
  const atlas = readAtlas();
  let written = 0;
  for (const b of bundle) {
    if (!b.roomId) continue;
    const prior = atlas[b.roomId];
    if (prior && (prior.localSeenAt !== undefined || Object.keys(prior.doors).length > 0)) continue;
    const doors: Record<string, AtlasDoor> = {};
    let kept = 0;
    for (const [d, door] of Object.entries(b.doors)) {
      if (kept >= MAX_DOORS_PER_ENTRY) break;
      if (!door || !door.targetRoomId) continue;
      doors[d] = {
        targetSeed: '',
        targetRoomId: door.targetRoomId,
        segments: door.segments,
        farDoor: door.farDoor,
        farWall: door.farWall,
        farLateral: door.farLateral,
        farYawDeg: door.farYawDeg,
        wall: door.wall,
        lateral: door.lateral,
      };
      kept++;
    }
    atlas[b.roomId] = {
      roomId: b.roomId,
      // A stub's placeholder name yields to the bundle's; a real one stays.
      name: prior?.name && prior.name !== 'Module' ? prior.name : (b.name || 'Module'),
      seed: prior?.seed || b.seed,
      dims: prior?.dims ?? b.dims,
      doors,
      lastSeen: prior?.lastSeen ?? 0,
      // Deliberately no localSeenAt: bundled knowledge is second-hand.
      bundled: true,
    };
    written++;
  }
  if (written) writeAtlas(atlas);
  return written;
}

export interface AtlasPose {
  roomId: string;
  name: string;
  seed?: string;
  /** The module's true tile dims when known (learned by visiting it); absent
   *  for neighbours we've only heard about — the renderer falls back. */
  dims?: { cols: number; rows: number };
  x: number;
  z: number;
  rotY: number;
  /** Graph distance from the current room (1 = direct neighbor). */
  hops: number;
}

/**
 * BFS the atlas from the current room, composing each hop's pose (the far
 * module's centre + orientation in the CURRENT room's frame) via the same
 * geometry the projections use. Returns every OTHER known module placed in
 * the world — the exterior renders these; the current room's real hull
 * stands at the origin.
 */
export function atlasLayout(currentRoomId: string, maxHops = 10): AtlasPose[] {
  const atlas = readAtlas();
  if (!atlas[currentRoomId]) return [];
  const placed = new Map<string, AtlasPose>();
  placed.set(currentRoomId, { roomId: currentRoomId, name: atlas[currentRoomId].name, x: 0, z: 0, rotY: 0, hops: 0 });
  const queue: string[] = [currentRoomId];
  while (queue.length > 0) {
    const fromId = queue.shift()!;
    const from = placed.get(fromId)!;
    if (from.hops >= maxHops) continue;
    const entry = atlas[fromId];
    if (!entry) continue;
    for (const [doorId, door] of Object.entries(entry.doors) as Array<[DoorId, AtlasDoor]>) {
      if (!door || !door.targetRoomId || placed.has(door.targetRoomId)) continue;
      // 🔗 farDoor inference (owner's octagon-render fix, 2026-07-19): a
      // record written by a manual INITIATE (far-door dropdown left empty)
      // carries NO farDoor — the pose then falls back to rotY = heading,
      // which inverts that arm's curvature in a ring walk (observed live:
      // seven 18.6 m hops and one 78 m chasm, the scattered-boxes render).
      // But the FAR room's own record pointing back at us NAMES the door —
      // infer it from the graph before composing the hop.
      const farDoorId = door.farDoor
        ?? (Object.entries(atlas[door.targetRoomId]?.doors ?? {})
          .find(([, r]) => (r as AtlasDoor | undefined)?.targetRoomId === fromId)?.[0]);
      // 🧭 The far door's WALL, never guessed from its id: the pairing record's
      // farWall, else the far room's own gossiped door geometry, else unknown
      // (⇒ the hop faces the arrival heading — no invented rotation).
      const farWall = door.farWall
        ?? (farDoorId ? atlas[door.targetRoomId]?.doors[farDoorId]?.wall : undefined)
        ?? null;
      const farLateral = door.farLateral
        ?? (farDoorId ? atlas[door.targetRoomId]?.doors[farDoorId]?.lateral : undefined)
        ?? 0;
      // The hop's pose in the FROM room's local frame → compose into world.
      // The CURRENT room's own doors use the LIVE pose (slide included); a
      // NEIGHBOUR room's door poses from its harvested wall+lateral — this
      // client's snapshot knows nothing about it. Old gossip without geometry
      // falls back to the live-pose path, which is the pre-redo behaviour.
      // 🛑📐 The far module's half-extent along its door's wall normal when its
      // size is known: the chain meets its TRUE face, so its centre sits that
      // far beyond the chain's end (review, round 8). Unknown ⇒ the adapter's
      // uniform default, as before.
      const farHalf = farWall ? halfAlongWall(atlas[door.targetRoomId]?.dims, farWall) : undefined;
      const local = fromId !== currentRoomId && door.wall !== undefined
        ? projectionPoseFromWall(door.wall, door.lateral ?? 0, door.segments, farWall, farLateral, farHalf)
        : projectionPoseForDoor(doorId, door.segments, farWall, farLateral, farHalf);
      const cos = Math.cos(from.rotY), sin = Math.sin(from.rotY);
      const wx = from.x + local.x * cos + local.z * sin;
      const wz = from.z - local.x * sin + local.z * cos;
      const target = atlas[door.targetRoomId];
      placed.set(door.targetRoomId, {
        roomId: door.targetRoomId,
        name: target?.name ?? 'Module',
        seed: target?.seed ?? door.targetSeed,
        dims: target?.dims,
        x: wx,
        z: wz,
        rotY: from.rotY + local.rotY,
        hops: from.hops + 1,
      });
      queue.push(door.targetRoomId);
    }
  }
  placed.delete(currentRoomId);
  return [...placed.values()];
}

// ── 🛰️ Module-overlap guard (#28 doors decouple, slice 2) ────────────────────
//
// The "automatic vestibule connector" (detectChainContact) is a match-to-
// CONNECT probe, NOT an anti-overlap guard — nothing today stops a new module
// being provisioned on top of an existing one. This tests a candidate module's
// footprint against the composed atlas poses. It keys off PORTS / atlas
// geometry (the same poses the exterior renders) — free doors never enter it.

/** A module's rendered footprint half-extent. Matches the exterior view's
 *  uniform 11.8 box (exteriorView.ts) and adapter ROOM_HALF (5.9), so the
 *  overlap test agrees with what-you-see-is-what's-docked. Rectangular/resized
 *  modules render — and here test — at this uniform size; per-module true dims
 *  would need the atlas to gossip room size (a refinement for the S6 BLOCK). */
const MODULE_HALF = 5.9;

/** How close a candidate centre must be to an existing module centre to count
 *  as CONNECTING to that berth rather than colliding with a different module —
 *  mirrors detectChainContact's 4.5 m match radius (docking.ts). */
const MODULE_CONNECT_DIST = 4.5;

interface OrientedSquare { x: number; z: number; rotY: number }

/** Separating-Axis overlap of two equal-size rotated squares. Strict
 *  separation (touching faces do NOT count) so flush berths / shared edges read
 *  as clear. Exact at any rotation — no inflated-AABB false positives for the
 *  45° ring modules. */
function squaresOverlap(a: OrientedSquare, b: OrientedSquare, half: number): boolean {
  const cornersOf = (c: OrientedSquare): Array<{ x: number; z: number }> => {
    const co = Math.cos(c.rotY), si = Math.sin(c.rotY);
    const out: Array<{ x: number; z: number }> = [];
    for (const [sx, sz] of [[-half, -half], [half, -half], [half, half], [-half, half]] as const) {
      out.push({ x: c.x + sx * co - sz * si, z: c.z + sx * si + sz * co });
    }
    return out;
  };
  const A = cornersOf(a), B = cornersOf(b);
  const axes = [a.rotY, a.rotY + Math.PI / 2, b.rotY, b.rotY + Math.PI / 2];
  const EPS = 1e-3; // flush contact separates cleanly despite fp noise
  for (const ang of axes) {
    const ax = Math.cos(ang), az = Math.sin(ang);
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of A) { const d = p.x * ax + p.z * az; if (d < aMin) aMin = d; if (d > aMax) aMax = d; }
    for (const p of B) { const d = p.x * ax + p.z * az; if (d < bMin) bMin = d; if (d > bMax) bMax = d; }
    if (aMax <= bMin + EPS || bMax <= aMin + EPS) return false; // found a separating axis
  }
  return true;
}

/**
 * Would a module placed at `candidate` (a pose in the CURRENT room's frame —
 * e.g. projectionPoseForDoor's far-end pose) OVERLAP an existing station
 * module? Returns the clashed module ({roomId, name}) or null.
 *
 * A module within the connect radius of the candidate is the berth being
 * JOINED (skipped — that's a connection, not a collision, and matches
 * detectChainContact's match); a clash is a footprint overlap with a DIFFERENT,
 * farther module, or with the current room's own hull at the origin.
 */
export function moduleOverlapAt(
  currentRoomId: string,
  candidate: { x: number; z: number; rotY: number },
  opts?: { connectDist?: number; maxHops?: number; moduleHalf?: number },
): { roomId: string; name: string } | null {
  if (!currentRoomId) return null;
  const connectDist = opts?.connectDist ?? MODULE_CONNECT_DIST;
  const half = opts?.moduleHalf ?? MODULE_HALF;
  const atlas = readAtlas();
  const modules: Array<{ roomId: string; name: string; x: number; z: number; rotY: number }> = [
    { roomId: currentRoomId, name: atlas[currentRoomId]?.name ?? 'this module', x: 0, z: 0, rotY: 0 },
    ...atlasLayout(currentRoomId, opts?.maxHops ?? 8),
  ];
  for (const mod of modules) {
    const isCurrent = mod.roomId === currentRoomId;
    if (!isCurrent && Math.hypot(mod.x - candidate.x, mod.z - candidate.z) <= connectDist) continue;
    if (squaresOverlap(candidate, mod, half)) return { roomId: mod.roomId, name: mod.name };
  }
  return null;
}

// ── 🛰️ Shared station atlas — the `atlas` room-doc map (see module header) ───

/** Doc-side entry (plain JSON, keyed by roomId, whole-value LWW). */
interface SharedAtlasEntry {
  roomId: string;
  name: string;
  doors: Record<string, {
    targetRoomId: string;
    /** Present ONLY on a doc's own-room entry (doorsDoc exposes it anyway). */
    targetSeed?: string;
    segments?: ConnectorSegment[];
    farDoor?: string;
    farWall?: DoorWall;
    farLateral?: number;
    farYawDeg?: 0 | 45;
    /** 🧭 This door's own physical pose — see AtlasDoor. */
    wall?: DoorWall;
    lateral?: number;
  }>;
  /** 🛑📐 The module's true tile size. PUBLIC by owner ruling — anyone may see
   *  a module's outside: its size, its position and its connections. Only the
   *  SEED (the credential that dials you in) is access-controlled. */
  dims?: { cols: number; rows: number };
  /** The dial-in credential. Rides only while a door that ACTUALLY EXISTS is
   *  set to public passage — this is the access restriction, and it is
   *  deliberately NOT the same question as "may you see this module". */
  seed?: string;
  updatedAt: number;
}

let sharedDoc: Y.Doc | null = null;
let sharedMap: Y.Map<unknown> | null = null;
let sharedCtx: { roomId: string; isPassagePublic: () => boolean } | null = null;
const sharedListeners = new Set<() => void>();

function sharedAlive(): boolean {
  return sharedDoc !== null
    && (sharedDoc as { isDestroyed?: boolean }).isDestroyed !== true
    && sharedMap !== null;
}

/** Shape guard — doc reads cross the peer trust boundary. */
function isSharedAtlasEntry(value: unknown): value is SharedAtlasEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<SharedAtlasEntry>;
  return typeof e.roomId === 'string' && e.roomId.length > 0
    && typeof e.name === 'string'
    && typeof e.doors === 'object' && e.doors !== null
    // Counted with early exit, not Object.keys: that allocates an array of
    // every raw key before the comparison, so a huge peer object still cost
    // O(n) on every notification (review, round 5).
    && !ownKeysExceed(e.doors, MAX_RAW_DOORS_PER_ENTRY)
    // 🕒 `updatedAt` is peer-written and drives merge arbitration (pullSharedAtlas
    // skips on `prior.lastSeen >= value.updatedAt`). Unbounded, a planted
    // far-future stamp wins every future comparison and — before the retention
    // split below — pinned the top of the 64-deep eviction list too (#144).
    // This is a real ingest boundary (the doc is not the store; pullSharedAtlas
    // writes localStorage), so bounding here keeps the stored value stable
    // rather than time-varying. Whatever slack is allowed is the head start an
    // attacker keeps, hence hours rather than days.
    && typeof e.updatedAt === 'number'
    && Number.isFinite(e.updatedAt)
    && e.updatedAt <= Date.now() + MAX_GOSSIP_SKEW_MS
    && (e.seed === undefined || typeof e.seed === 'string')
    // 🛑📐 dims drives GEOMETRY straight into the exterior renderer, and this
    // value came off the wire from a peer. Bounded to the same envelope the
    // room editor enforces, so a hostile or buggy entry degrades to "we don't
    // know this module's size" (the renderer's existing fallback) instead of
    // asking Three.js for a 10-billion-tile hull.
    && (e.dims === undefined || isSaneDims(e.dims));
}

/** True once `obj` has more than `limit` own keys — stops counting there, so
 *  an oversized peer object is never enumerated past the bound. */
function ownKeysExceed(obj: object, limit: number): boolean {
  let n = 0;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    if (++n > limit) return true;
  }
  return false;
}

export function isSaneDims(d: unknown): d is { cols: number; rows: number } {
  if (typeof d !== 'object' || d === null) return false;
  const v = d as { cols?: unknown; rows?: unknown };
  const ok = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n)
    && n >= ROOM_TILE_MIN && n <= ROOM_TILE_MAX;
  return ok(v.cols) && ok(v.rows);
}

/**
 * Bind (or re-bind) the shared atlas to a room doc — main.ts T0 seam, beside
 * the games/furniture/casino bindings. Pulls immediately, pushes what this
 * client already knows, and re-pulls on every doc change.
 */
export function bindStationAtlasDoc(
  doc: Y.Doc,
  ctx: { roomId: string; isPassagePublic: () => boolean },
): void {
  sharedDoc = doc;
  sharedCtx = ctx;
  sharedMap = doc.getMap('atlas');
  sharedMap.observe(() => {
    pullSharedAtlas();
    // Copy + isolate (the furnitureDoc guard): renders must not kill the rest.
    for (const listener of [...sharedListeners]) {
      try {
        listener();
      } catch (err) {
        console.error('[atlas] shared listener threw during doc notify:', err);
      }
    }
  });
  pullSharedAtlas();
  pushAtlasToDoc();
}

/** Fires after every shared-atlas pull (main rebuilds an active exterior). */
export function subscribeSharedAtlas(listener: () => void): () => void {
  sharedListeners.add(listener);
  return () => sharedListeners.delete(listener);
}

/** Doc → localStorage. Never erases a locally-earned seed. */
function pullSharedAtlas(): void {
  if (!sharedAlive()) return;
  const atlas = readAtlas();
  let changed = false;
  for (const [rid, value] of sharedMap!.entries()) {
    if (!isSharedAtlasEntry(value) || value.roomId !== rid) continue;
    const prior = atlas[rid];
    // Compared against what the value NORMALIZES to — the count of VALID
    // records, capped — never its raw key count: a stored 64 against a raw
    // 100, or a stored 1 against 100 malformed keys plus one valid, would
    // re-process the same entry on every notification (review, rounds 3–4).
    // The raw object is bounded by isSharedAtlasEntry, so this pass is too.
    let incoming = 0;
    for (const door of Object.values(value.doors)) {
      if (door && typeof door.targetRoomId === 'string' && door.targetRoomId) incoming++;
      if (incoming >= MAX_DOORS_PER_ENTRY) break;
    }
    if (prior
      && prior.lastSeen >= value.updatedAt
      && Object.keys(prior.doors).length >= incoming) continue;
    const doors: Record<string, AtlasDoor> = {};
    let kept = 0;
    for (const [d, door] of Object.entries(value.doors)) {
      // Bounded (MAX_DOORS_PER_ENTRY): a room cannot honestly have more
      // pairings than doorsDoc reads back, so past the cap the rest is dropped,
      // deterministically, in entry order.
      if (kept >= MAX_DOORS_PER_ENTRY) break;
      if (!door || typeof door.targetRoomId !== 'string' || !door.targetRoomId) continue;
      // 🧭 Wall/lateral drive GEOMETRY straight into the exterior renderer and
      // arrive from a peer — exact wall names and a finite lateral or they are
      // dropped to "unknown" (the renderer's honest fallback). Same discipline
      // as dims. Preserved from prior on a miss so gossip from an OLD client
      // cannot erase geometry a NEW one already published.
      // Either vocabulary in, axis labels out — this was compass-only after
      // the axis rename, so gossiped door geometry was being dropped.
      const okWall = (w: unknown): DoorWall | undefined => normalizeWall(w);
      doors[d] = {
        targetSeed: door.targetSeed ?? prior?.doors[d]?.targetSeed ?? '',
        targetRoomId: door.targetRoomId,
        segments: door.segments,
        farDoor: door.farDoor,
        farWall: okWall(door.farWall) ?? prior?.doors[d]?.farWall,
        farLateral: Number.isFinite(door.farLateral) && Math.abs(door.farLateral as number) <= 32
          ? (door.farLateral as number)
          : prior?.doors[d]?.farLateral,
        farYawDeg: door.farYawDeg,
        wall: okWall(door.wall) ?? prior?.doors[d]?.wall,
        // Bounded like dims and farLateral (F7): |lateral| ≤ 32 covers the
        // largest room's wall run; outside it, keep what we knew.
        lateral: Number.isFinite(door.lateral) && Math.abs(door.lateral as number) <= 32
          ? (door.lateral as number)
          : prior?.doors[d]?.lateral,
      };
      kept++;
    }
    // ⚠️ This REBUILDS the entry rather than merging into it, so every field
    // must be named explicitly or it is destroyed. `dims` was not, which meant
    // a size learned by actually visiting a room was wiped the moment any peer
    // gossiped an entry for it. Prefer the incoming value, fall back to what we
    // already knew, and never regress to undefined.
    atlas[rid] = {
      roomId: rid,
      name: value.name || prior?.name || 'Module',
      seed: value.seed ?? prior?.seed,
      dims: value.dims ?? prior?.dims,
      doors,
      lastSeen: Math.max(value.updatedAt, prior?.lastSeen ?? 0),
      // Gossip is SECOND-hand and must never mint local recency: stamping it
      // here would let one peer's station sweep outrank every room the player
      // actually walked through (#144). Carry a prior stamp forward when we
      // have one — that room was visited — and otherwise leave it absent, which
      // is what marks this entry gossip-only for eviction.
      localSeenAt: prior?.localSeenAt,
    };
    changed = true;
  }
  if (changed) writeAtlas(atlas);
}

/**
 * localStorage → doc (called after every harvest). Gossip carries geometry +
 * names; SEEDS DO NOT TRAVEL — except the doc's own-room entry (see header).
 * Content-compared (stamp excluded) so re-joins don't churn the doc.
 */
export function pushAtlasToDoc(): void {
  if (!sharedAlive() || !sharedCtx) return;
  const ctx = sharedCtx;
  const atlas = readAtlas();
  sharedDoc!.transact(() => {
    for (const entry of Object.values(atlas)) {
      const isOwn = entry.roomId === ctx.roomId;
      const doorIds = Object.keys(entry.doors) as DoorId[];
      if (!isOwn && doorIds.length === 0) continue; // stubs add no geometry
      // 🛰️ Never publish what this install never observed: an entry the
      // build's bundled default station wrote (seedAtlasDefaults) would reach
      // every room we join as if we had seen it. The room we are standing in
      // included — until a harvest of its SYNCED replica rebuilds the entry,
      // it is still second-hand. (A repaired legacy stamp is a different
      // case: that entry WAS observed, and #144 republishes it at 0 so honest
      // gossip outranks it.)
      if (entry.bundled) continue;
      const existing = sharedMap!.get(entry.roomId);
      const known = isSharedAtlasEntry(existing) ? existing : null;
      if (known && !isOwn
        && known.updatedAt >= entry.lastSeen
        && Object.keys(known.doors).length >= doorIds.length) continue;
      const doors: SharedAtlasEntry['doors'] = {};
      for (const d of doorIds) {
        const door = entry.doors[d];
        if (!door || !door.targetRoomId) continue;
        doors[d] = {
          targetRoomId: door.targetRoomId,
          segments: door.segments,
          farDoor: door.farDoor,
          farWall: door.farWall,
          farLateral: door.farLateral,
          farYawDeg: door.farYawDeg,
          wall: door.wall,
          lateral: door.lateral,
          ...(isOwn && door.targetSeed ? { targetSeed: door.targetSeed } : {}),
        };
      }
      const rec: SharedAtlasEntry = {
        roomId: entry.roomId,
        name: entry.name,
        doors,
        // 🛑📐 Size travels with the connection graph. Without this a peer
        // renders every module it has not personally visited at the fallback
        // size, so the station's shape was only ever right for rooms you had
        // walked through yourself.
        ...(entry.dims ? { dims: entry.dims } : {}),
        // 🧭 F5 (redo review): MONOTONIC, not just lastSeen. A corrective
        // re-push with the same second's stamp would lose the LWW tie against
        // the poisoned entry it is correcting (pull skips on >=); bumping past
        // the known stamp guarantees a content change always propagates.
        // 🕒 Clamped to the SAME ceiling the ingest guard enforces. The `+1`
        // monotonic bump (F5) exists so a corrective re-push always outranks
        // the record it corrects, but unclamped it can land one millisecond
        // past the bound — and then our own isSharedAtlasEntry, and every peer
        // on a similar clock, refuses the record we just wrote. A writer must
        // never emit what its own reader rejects.
        //
        // ⚠️ Accepted degradation, stated precisely — an earlier version of
        // this comment claimed it "self-resolves", which is wrong.
        //
        // When `known.updatedAt` is AT the ceiling, the clamp returns that same
        // value, so the record we publish ties instead of out-ranking. A peer
        // already holding the boundary-stamped entry then skips it
        // (`prior.lastSeen >= value.updatedAt`, same door count) and our
        // correction does not reach them. It is not lost: once our clock passes
        // the stamp, `known.updatedAt + 1` fits under the ceiling again and the
        // correction propagates — but only at the NEXT push, and pushes are
        // event-driven (join, door change), never on a timer. Time passing
        // alone changes nothing.
        //
        // Reaching this needs an existing record stamped a full 6h into our
        // future, which an honest clock does not produce; it is the adversarial
        // and badly-skewed edge. Publishing a record no peer can ingest would
        // be worse, and the ceiling cannot be beaten from below — bounding the
        // stamp, out-ranking an adversary sitting at the bound, and having
        // peers accept the result are not simultaneously satisfiable. A
        // scheduled retry at the moment the ceiling clears would close it; that
        // is a timer this module does not currently own.
        updatedAt: Math.min(
          known ? Math.max(entry.lastSeen, known.updatedAt + 1) : entry.lastSeen,
          Date.now() + MAX_GOSSIP_SKEW_MS,
        ),
      };
      if (isOwn && entry.seed && ctx.isPassagePublic()) rec.seed = entry.seed;
      if (known
        && JSON.stringify({ ...known, updatedAt: 0 }) === JSON.stringify({ ...rec, updatedAt: 0 })) continue;
      sharedMap!.set(entry.roomId, rec);
    }
  });
}
