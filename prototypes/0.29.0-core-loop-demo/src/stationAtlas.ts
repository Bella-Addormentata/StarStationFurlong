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
import { isDockChain, projectionPoseForDoor, projectionPoseFromWall } from './adapter';
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
  /** ⚓ A TRANSIENT berth (doorsDoc `transient`, #67 D2): a visiting ship's
   *  DOCK, not station structure. The exterior still draws the docked ship,
   *  but station grouping (atlasComponents) skips the edge — the station-side
   *  record can outlive the ship's departure (the dock never sees it leave),
   *  and a ship must not join, or bridge, the stations it calls at.
   *  Three states: true / false are KNOWN (a harvest, or gossip from a client
   *  that knows the flag); absent is UNKNOWN — gossip from an older client,
   *  which never sends it. Grouping asks isBerthDoor, which also counts any
   *  DOCK chain whatever this says (a dock is always transient); an unknown
   *  gangway groups like structure, as before. */
  transient?: boolean;
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
  /** ⚓🚦 The room's DOCK PORTS with their gate numbers, by door id — free
   *  or docked (a free port has no door record, so `doors` cannot say). Layout,
   *  not admission: public like the rest (credential rule above). Absent when
   *  unknown (an older client's gossip, or a room never harvested). */
  gates?: Record<string, number>;
  /** ⚓🚦 Who may dock at each gate, by door id — only gates not open to all
   *  (closed, pass holders, or reserved for one ship's room). */
  gateAccess?: Record<string, AtlasGateAccess>;
  /** 🗺️ Who owns the module (roomInfo.owner), the name they go by there and
   *  their identity key, read while standing in it (#192: the holotable's
   *  station atlas shows a module's owner). Public like the room's name; the
   *  name is the players map's display name, peer-written and unverified, so
   *  it is a label only, and the key is public too (a players entry's keyB64).
   *  null: known to have no verifiable owner (none set, or the legacy
   *  marker); absent: not known. */
  owner?: AtlasOwner | null;
  /** 🔧 When the module was taken apart (#192, disassembly.ts): it is off
   *  the station and out of every map. The entry stays, doorless, as a
   *  tombstone so older gossip about the module can't bring it back; the
   *  maps never see it (readAtlas leaves it out, with every door still
   *  naming it). A harvest from inside the room rebuilds the entry without
   *  it: someone standing in the module is first-hand proof it is there. */
  dismantledAt?: number;
  /** 🔧 This install took the module apart (dismantleInAtlas): its own
   *  first-hand tombstone, which writeAtlas keeps however many others the
   *  pool holds, so older gossip can never bring back a module this install
   *  took apart. Never published (the push names each field it sends) nor
   *  read from gossip (the pull rebuilds entries), and a copy that brings
   *  the module back drops it with the tombstone. */
  dismantledHere?: true;
  /** 🔧 The tombstone this live copy brought the module back from (its
   *  dismantledAt): someone stood inside the module after it was taken
   *  apart, first-hand proof it is there. That tombstone gives way to this
   *  copy wherever the two meet, whatever their stamps (one stamped up to
   *  six hours ahead, or tied with the revival at that ceiling, would
   *  otherwise take the module back); a later one, from taking it apart
   *  again, is ranked by stamp as usual. Published with the copy. */
  revives?: number;
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

/** 🗺️ A module's owner as the atlas carries it (AtlasEntry.owner). */
export interface AtlasOwner {
  /** The roomInfo.owner value: a player id (or a legacy marker). */
  id: string;
  /** Their display name in that room's players map, when it was known. */
  name?: string;
  /** Their identity key in that room's players map (keyB64), when it was
   *  known: an owner back on a fresh player id is still matched by it, as
   *  the deed check matches one (disassembly.ts ownerIsMe). */
  key?: string;
}

/** Longest owner id / name / identity key the atlas keeps from gossip (an
 *  identity key is 43 characters: base64url of 32 bytes). */
const MAX_OWNER_ID = 128;
const MAX_OWNER_NAME = 64;
const MAX_OWNER_KEY = 64;

/** A peer-written owner, checked: an id of sane length, and a name and an
 *  identity key each kept only when it is a short string. Anything else is
 *  unknown (undefined). */
export function cleanAtlasOwner(v: unknown): AtlasOwner | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { id?: unknown; name?: unknown; key?: unknown };
  if (typeof o.id !== 'string' || !o.id || o.id.length > MAX_OWNER_ID) return undefined;
  const name = typeof o.name === 'string' && o.name && o.name.length <= MAX_OWNER_NAME ? o.name : undefined;
  const key = typeof o.key === 'string' && o.key && o.key.length <= MAX_OWNER_KEY ? o.key : undefined;
  return { id: o.id, ...(name ? { name } : {}), ...(key ? { key } : {}) };
}

/** A peer-written owner field: null (known ownerless) passes as null, a
 *  sane owner as itself, anything else as undefined (unknown). */
function ownerOf(v: unknown): AtlasOwner | null | undefined {
  return v === null ? null : cleanAtlasOwner(v);
}

const KEY = 'ssf-station-atlas';
export const MAX_ENTRIES = 64;
/** 🔧 Tombstones of modules taken apart (AtlasEntry.dismantledAt) kept
 *  besides the MAX_ENTRIES rooms, in their own pool: visiting new rooms must
 *  never evict the record that keeps a module gone, or older gossip would
 *  bring it back. Small, doorless records. This caps the ones learned from
 *  gossip; the ones this install made (dismantledHere) are all kept. */
export const MAX_DISMANTLED = 64;

/** 🔧 Does `live` bring back the module `tomb` took off (AtlasEntry.revives
 *  names that very tombstone)? Then it outranks it whatever their stamps,
 *  in the pull, the push and withSharedAtlasOf alike. */
function revivesTomb(
  live: { dismantledAt?: number; revives?: number },
  tomb: { dismantledAt?: number },
): boolean {
  return live.dismantledAt === undefined && tomb.dismantledAt !== undefined && live.revives === tomb.dismantledAt;
}

/** 🔧 Of two tombstones of one room at the same stamp, is `a` the later
 *  dismantling (the larger dismantledAt)? Then it outranks `b`: where stamps
 *  can only tie (the six-hour ceiling), a module taken apart again after a
 *  copy brought it back must not lose to its first tombstone, which that old
 *  copy revives. The pull, the push, withSharedAtlasOf, the harvest and this
 *  session's unsaved tombstones all rank a tie this way. */
function laterTomb(a: { dismantledAt?: number }, b: { dismantledAt?: number }): boolean {
  return a.dismantledAt !== undefined && b.dismantledAt !== undefined && a.dismantledAt > b.dismantledAt;
}
/** 🚪 Doors kept per gossiped entry — the same cap doorsDoc.readAllDoors puts
 *  on a room's own pairings (MAX_PAIRINGS). A shared entry's `doors` is a
 *  peer-written object that isSharedAtlasEntry does not size-check, and every
 *  consumer walks it (atlasLayout, the exterior, the CONNECT matcher's claim
 *  scan), so without this one entry could carry an arbitrarily large set. */
export const MAX_DOORS_PER_ENTRY = 64;
/** ⚓🚦 Most shared-atlas entries withSharedAtlasOf reads from one room doc. */
const MAX_SHARED_SCAN = 256;
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

/**
 * The atlas as every map sees it: rooms taken apart (dismantledAt) left out,
 * and with them every door record that still names one — a neighbour's
 * stale record, or gossip from before the job ended.
 */
export function readAtlas(): Record<string, AtlasEntry> {
  return visibleAtlas(readStoredAtlas());
}

/** 🔧 True when this install holds `roomId` as taken apart (a tombstone the
 *  maps never see). */
export function isDismantled(roomId: string): boolean {
  return ownValue(readStoredAtlas(), roomId)?.dismantledAt !== undefined;
}

/** 🔧 Tombstones this install made that its store could not take (full, or
 *  privacy mode: writeAtlas swallows the error). Read as if stored for the
 *  rest of the session (readStoredAtlas), so this install's maps, merges and
 *  gate reads drop the module too, and published with every push, so the
 *  station's other visitors get it whatever the store does; saved by the
 *  first push after the store takes writes again (saveUnsavedTombs). */
const unsavedTombs = new Map<string, AtlasEntry>();

/** The atlas this install holds, tombstones included: what merges and gossip
 *  work on. The saved store (readSavedAtlas) with this session's unsaved
 *  tombstones in it, each unless the store holds a newer record of the room
 *  (or a copy that brought it back), which lets that tombstone go. */
function readStoredAtlas(): Record<string, AtlasEntry> {
  const saved = readSavedAtlas();
  if (unsavedTombs.size === 0) return saved;
  // No prototype: a room named `__proto__` is an ordinary own key here.
  const atlas: Record<string, AtlasEntry> = Object.assign(Object.create(null), saved);
  for (const [rid, tomb] of unsavedTombs) {
    if (supersedesTomb(ownValue(saved, rid), tomb)) unsavedTombs.delete(rid);
    else atlas[rid] = tomb;
  }
  return atlas;
}

/** Does the saved record of a room outrank this session's tombstone of it:
 *  the same tombstone or a newer one (at an equal stamp, any but an earlier
 *  dismantling: laterTomb), a newer live copy, or one that brought the
 *  module back (revivesTomb)? */
function supersedesTomb(saved: AtlasEntry | undefined, tomb: AtlasEntry): boolean {
  if (!saved) return false;
  if (revivesTomb(saved, tomb)) return true;
  return saved.dismantledAt !== undefined
    ? saved.lastSeen > tomb.lastSeen || (saved.lastSeen === tomb.lastSeen && !laterTomb(tomb, saved))
    : saved.lastSeen > tomb.lastSeen;
}

/** Save this session's unsaved tombstones, once the store takes writes
 *  again (the next read lets go of each one the store then holds). */
function saveUnsavedTombs(): void {
  if (unsavedTombs.size > 0) writeAtlas(readStoredAtlas());
}

/** 🔧 `atlas` without the rooms taken apart or the doors naming them. The
 *  same object back when there are none. */
export function visibleAtlas(atlas: Record<string, AtlasEntry>): Record<string, AtlasEntry> {
  const gone = new Set<string>();
  for (const e of Object.values(atlas)) if (e?.dismantledAt !== undefined) gone.add(e.roomId);
  if (gone.size === 0) return atlas;
  // No prototype: a room or door id off the wire such as `constructor` or
  // `__proto__` is an ordinary own key here, never an inherited value read
  // as its entry, nor a write that swaps the prototype.
  const out: Record<string, AtlasEntry> = Object.create(null);
  for (const [rid, e] of Object.entries(atlas)) {
    if (gone.has(rid)) continue;
    const doors = Object.entries(e?.doors ?? {});
    if (!doors.some(([, d]) => d && gone.has(d.targetRoomId))) {
      out[rid] = e;
      continue;
    }
    const kept: Record<string, AtlasDoor> = Object.create(null);
    for (const [id, d] of doors) if (!d || !gone.has(d.targetRoomId)) kept[id] = d;
    out[rid] = { ...e, doors: kept };
  }
  return out;
}

/** The atlas as this install's store holds it, tombstones included. Read
 *  through readStoredAtlas, which adds the ones the store could not take. */
function readSavedAtlas(): Record<string, AtlasEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return Object.create(null);
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return Object.create(null);
    // No prototype: a room named `__proto__` stays an ordinary key when the
    // harvest, the pull or a dismantling writes it into what this returns
    // (the prototype setter would drop the entry), and one named
    // `constructor` or `toString` reads as absent, not as an inherited value.
    const atlas: Record<string, AtlasEntry> = Object.assign(Object.create(null), obj);
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
  } catch { return Object.create(null); }
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

/**
 * ⚓ Write down every berth the atlas only INFERS. berthDoorIds counts both
 * records of a connection as the berth when either end is one, but that
 * inference lives only while both records do: once the flagged end is
 * re-harvested without its dock (the ship cast off), the unflagged end left
 * behind would read as structure again and pull the ship back into the
 * station it left. So an unknown flag on an inferred berth is set to true
 * while the pair is still there to show it. A known flag, true or false, is
 * the room's own word and is left alone; a newer harvest of that room
 * replaces the guess.
 */
function markInferredBerths(atlas: Record<string, AtlasEntry>): void {
  for (const [roomId, doorIds] of berthDoorIds(atlas)) {
    const doors = atlas[roomId]?.doors;
    if (!doors) continue;
    for (const id of doorIds) {
      const door = doors[id];
      if (door && typeof door.transient !== 'boolean') door.transient = true;
    }
  }
}

function writeAtlas(atlas: Record<string, AtlasEntry>): void {
  try {
    // Before eviction, which can drop the flagged end of a berth too.
    markInferredBerths(atlas);
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
    //
    // 🔧 Tombstones (modules taken apart) are kept in a pool of their own,
    // ranked the same way: they never count against the rooms, and rooms
    // never push them out. The ones this install made are all kept: each is
    // a module its own robots took hours of labor to take apart, so they
    // grow only as fast as play does, and evicting one would let older
    // gossip bring back a module this install took apart. Gossiped ones
    // fill MAX_DISMANTLED.
    const all = Object.values(atlas);
    const tombs = all.filter((e) => e.dismantledAt !== undefined);
    const entries = [
      ...all.filter((e) => e.dismantledAt === undefined).sort(compareAtlasRecency).slice(0, MAX_ENTRIES),
      ...tombs.filter((e) => e.dismantledHere === true),
      ...tombs.filter((e) => e.dismantledHere !== true).sort(compareAtlasRecency).slice(0, MAX_DISMANTLED),
    ];
    // No prototype: every room id, `__proto__` included, is an own key that
    // JSON.stringify writes out.
    const out: Record<string, AtlasEntry> = Object.create(null);
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
    wall?: DoorWall; lateral?: number; transient?: boolean;
  }>;
  /** ⚓🚦 The room's dock ports by door id → gate number (doorPolicy). */
  gates?: Record<string, number>;
  /** ⚓🚦 Non-open gate access by door id (doorPolicy readGateAccess). */
  gateAccess?: Record<string, AtlasGateAccess>;
  /** 🗺️ The room's owner (roomInfo.owner), their display name and identity
   *  key; null when the synced room has no verifiable owner; absent when
   *  unread. */
  owner?: AtlasOwner | null;
}): void {
  if (!entry.roomId) return;
  const atlas = readStoredAtlas();
  // Before this entry is replaced: an atlas saved before berths were written
  // down may hold a berth only this entry's old doors imply.
  markInferredBerths(atlas);
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
      // A DOCK is always a berth (dockRules), whatever its record's flag says.
      ...(isDockChain(d.segments)
        ? { transient: true }
        : typeof d.transient === 'boolean' ? { transient: d.transient } : {}),
    };
  }
  const entryGates = entry.gates ? cleanGates(entry.gates) : undefined;
  // 🔧 Standing inside a module taken apart brings it back. This copy names
  // the tombstone it beats (revives): ours, or the one in the module's own
  // doc (bound: we are in it) when that one would otherwise take the module
  // back from what we hold (of two tombstones, the newer; at an equal stamp,
  // the later dismantling: laterTomb). It is stamped past it too, for
  // readers that rank by stamp alone. A copy that already brought the module
  // back keeps naming the tombstone it beat.
  const now = Date.now();
  const docCopy = sharedAlive() && sharedCtx?.roomId === entry.roomId ? sharedMap!.get(entry.roomId) : undefined;
  const docTomb = isSharedAtlasEntry(docCopy) && docCopy.roomId === entry.roomId && docCopy.dismantledAt !== undefined
    ? { dismantledAt: docCopy.dismantledAt, lastSeen: docCopy.updatedAt }
    : null;
  let tomb: { dismantledAt?: number; lastSeen: number } | null = prior?.dismantledAt !== undefined ? prior : null;
  if (docTomb && (tomb
    ? docTomb.lastSeen > tomb.lastSeen || (docTomb.lastSeen === tomb.lastSeen && laterTomb(docTomb, tomb))
    : !prior || !(revivesTomb(prior, docTomb) || prior.lastSeen > docTomb.lastSeen))) {
    tomb = docTomb;
  }
  const revives = tomb ? tomb.dismantledAt : prior?.revives;
  atlas[entry.roomId] = {
    roomId: entry.roomId,
    name: entry.name || prior?.name || 'Module',
    seed: entry.seed ?? prior?.seed,
    dims: entry.dims ?? prior?.dims,
    doors,
    ...(entryGates ? { gates: entryGates } : prior?.gates ? { gates: prior.gates } : {}),
    ...(entryGates
      ? (entry.gateAccess ? { gateAccess: cleanGateAccess(entry.gateAccess, entryGates) } : {})
      : prior?.gateAccess ? { gateAccess: prior.gateAccess } : {}),
    // 🗺️ A harvest that could not read the owner (not synced yet) keeps the
    // one we knew, like dims.
    // An explicit null (the synced room has no verifiable owner) clears it.
    ...ownerSpread(ownerOf(entry.owner) !== undefined ? ownerOf(entry.owner) : prior?.owner),
    ...(revives !== undefined ? { revives } : {}),
    lastSeen: tomb ? Math.min(Math.max(now, tomb.lastSeen + 1), now + MAX_GOSSIP_SKEW_MS) : now,
    // We are standing in it — the strongest possible local recency signal.
    localSeenAt: now,
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
 * 🔧 A module was taken apart (#192, disassembly.ts): its entry becomes a
 * doorless tombstone stamped now (first-hand: this client ended the job),
 * every map stops showing it (readAtlas), and the tombstone is published to
 * the bound room doc's shared atlas so the station's other visitors drop it
 * too. Its name and size are kept for the record.
 */
export function dismantleInAtlas(roomId: string, at: number): void {
  if (!roomId) return;
  const atlas = readStoredAtlas();
  const prior = ownValue(atlas, roomId);
  const now = Date.now();
  // Newer than any copy the doc holds, so the push below publishes it (and
  // within the bound every reader enforces: over a copy stamped at that
  // ceiling it ties instead, and a tie goes to the tombstone).
  const existing = sharedAlive() ? sharedMap!.get(roomId) : undefined;
  const docStamp = isSharedAtlasEntry(existing) ? existing.updatedAt + 1 : 0;
  const tomb: AtlasEntry = {
    roomId,
    name: prior?.name || 'Module',
    ...(prior?.dims ? { dims: prior.dims } : {}),
    doors: {},
    dismantledAt: at,
    dismantledHere: true,
    lastSeen: Math.min(Math.max(now, (prior?.lastSeen ?? 0) + 1, docStamp), now + MAX_GOSSIP_SKEW_MS),
    localSeenAt: now,
  };
  Object.defineProperty(atlas, roomId, { value: tomb, enumerable: true, writable: true, configurable: true });
  writeAtlas(atlas);
  // The doors are sealed and the job ended already, so the record must not
  // be lost to a store that could not take it (writeAtlas swallows that):
  // this session keeps it, and the push publishes it from here.
  if (ownValue(readSavedAtlas(), roomId)?.dismantledAt === at) unsavedTombs.delete(roomId);
  else unsavedTombs.set(roomId, tomb);
  pushAtlasToDoc();
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
  const atlas = readStoredAtlas();
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
    // 🔧 …nor that a module taken apart is back.
    ...(prior?.dismantledAt !== undefined ? { dismantledAt: prior.dismantledAt } : {}),
    ...(prior?.dismantledAt !== undefined && prior.dismantledHere ? { dismantledHere: true as const } : {}),
    // …nor that one brought back is gone again.
    ...(prior?.dismantledAt === undefined && prior?.revives !== undefined ? { revives: prior.revives } : {}),
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
  const atlas = readStoredAtlas();
  let written = 0;
  for (const b of bundle) {
    if (!b.roomId) continue;
    const prior = atlas[b.roomId];
    // 🔧 …and a module known to be taken apart stays gone.
    if (prior && (prior.localSeenAt !== undefined || Object.keys(prior.doors).length > 0
      || prior.dismantledAt !== undefined)) continue;
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

// ── ⚓🚦 Gates ─────────────────────────────────────────────────────────────────

/** The same ceiling doorPolicy.MAX_GATE holds (not imported: doorPolicy
 *  reads the layout doc, and this module stays free of doc bindings). */
const MAX_GATE_NUMBER = 99;
/** Door ids are short keys (doorsDoc.isAcceptableDoorKey allows 64). */
const MAX_GATE_DOOR_ID = 64;

function isPlainGates(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && !ownKeysExceed(v, MAX_RAW_DOORS_PER_ENTRY);
}

/** Only door id → integer gate pairs, at most MAX_GATE_NUMBER of them. Every
 *  distinct number is taken first, so ports sharing a number (two stations
 *  joined, a peer's junk) can never push another gate out; a duplicate
 *  fills only room that is left. */
function cleanGates(v: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const numbers = new Set<number>();
  const repeats: Array<[string, number]> = [];
  let kept = 0;
  for (const [doorId, gate] of Object.entries(v)) {
    if (kept >= MAX_GATE_NUMBER) break;
    if (!doorId || doorId.length > MAX_GATE_DOOR_ID || doorId === '__proto__') continue;
    if (typeof gate !== 'number' || !Number.isInteger(gate) || gate < 1 || gate > MAX_GATE_NUMBER) continue;
    if (numbers.has(gate)) {
      if (repeats.length < MAX_GATE_NUMBER) repeats.push([doorId, gate]);
      continue;
    }
    numbers.add(gate);
    out[doorId] = gate;
    kept++;
  }
  for (const [doorId, gate] of repeats) {
    if (kept >= MAX_GATE_NUMBER) break;
    out[doorId] = gate;
    kept++;
  }
  return out;
}

/** ⚓🚦 A gate's access as the atlas carries it (doorPolicy GateAccess,
 *  minus 'open', which is the absence of a record). */
export interface AtlasGateAccess {
  access: 'pass' | 'reserved' | 'closed';
  /** With 'reserved': the one ship's room id. */
  reservedFor?: string;
}

/** Door id → access pairs a peer may send, cleaned and capped (one per gate
 *  number). Only doors of the cleaned `gates` count, so entries for other
 *  doors cannot crowd out a real gate's policy. */
function cleanGateAccess(v: Record<string, unknown>, gates: Record<string, number>): Record<string, AtlasGateAccess> {
  const out: Record<string, AtlasGateAccess> = {};
  let kept = 0;
  for (const [doorId, raw] of Object.entries(v)) {
    if (kept >= MAX_GATE_NUMBER) break;
    if (!Object.prototype.hasOwnProperty.call(gates, doorId)) continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { access?: unknown; reservedFor?: unknown };
    if (r.access === 'pass' || r.access === 'closed') out[doorId] = { access: r.access };
    else if (r.access === 'reserved' && typeof r.reservedFor === 'string'
      && r.reservedFor.length > 0 && r.reservedFor.length <= 128) {
      out[doorId] = { access: 'reserved', reservedFor: r.reservedFor };
    } else continue;
    kept++;
  }
  return out;
}

/** One gate of a station: a dock port, its room and its number. */
export interface StationGate {
  roomId: string;
  doorId: string;
  gate: number;
  /** The atlas shows a pairing on this port's door (a ship is docked). */
  occupied: boolean;
  /** Who may dock there, when not every ship may. */
  access?: AtlasGateAccess['access'];
  reservedFor?: string;
}

/**
 * Every gate of the station `roomId` belongs to (its atlas component), in
 * gate order (ties by room, then door — a duplicate number is flagged at the
 * door panel, not fixed here).
 */
export function stationGates(atlas: Record<string, AtlasEntry>, roomId: string): StationGate[] {
  const out: StationGate[] = [];
  if (!roomId) return out;
  for (const rid of atlasComponent(atlas, roomId)) {
    const entry = atlas[rid];
    if (!entry?.gates) continue;
    for (const [doorId, gate] of Object.entries(entry.gates)) {
      const a = entry.gateAccess?.[doorId];
      out.push({
        roomId: rid, doorId, gate, occupied: !!entry.doors[doorId]?.targetRoomId,
        ...(a ? { access: a.access, ...(a.reservedFor ? { reservedFor: a.reservedFor } : {}) } : {}),
      });
    }
  }
  return out.sort((a, b) => a.gate - b.gate
    || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)
    || (a.doorId < b.doorId ? -1 : a.doorId > b.doorId ? 1 : 0));
}

/**
 * The gate number a port newly fitted in `roomId` takes: the lowest one no
 * other gate of its station uses. The room's own live gates (`own`, from its
 * doorPolicy) stand in for its atlas entry, which may be a harvest behind.
 * Null when all MAX_GATE_NUMBER are taken.
 */
export function freeGateNumber(
  atlas: Record<string, AtlasEntry>,
  roomId: string,
  own: Record<string, number>,
): number | null {
  const taken = new Set<number>(Object.values(own));
  for (const g of stationGates(atlas, roomId)) if (g.roomId !== roomId) taken.add(g.gate);
  for (let g = 1; g <= MAX_GATE_NUMBER; g++) if (!taken.has(g)) return g;
  return null;
}

/**
 * ⚓🚦 freeGateNumber for a port fitted here and now: the local atlas with
 * the bound room doc's shared atlas folded in around `roomId`
 * (withSharedAtlasOf), since the local atlas keeps only MAX_ENTRIES rooms
 * and a room of this station it has let go may already hold a number.
 */
export function freeGateNumberHere(roomId: string, own: Record<string, number>): number | null {
  return freeGateNumber(atlasAround(roomId), roomId, own);
}

/** The local atlas, with the bound room doc's shared atlas folded in around
 *  `roomId` when one is bound (withSharedAtlasOf). */
function atlasAround(roomId: string): Record<string, AtlasEntry> {
  const doc = sharedDoc && (sharedDoc as { isDestroyed?: boolean }).isDestroyed !== true ? sharedDoc : null;
  return doc ? withSharedAtlasOf(doc, readAtlas(), roomId) : readAtlas();
}

/**
 * ⚓🚦 The number a gate renumbered by hand moves to: the next one from
 * `from` in the direction of `step` (+1 or -1) that no other port of the
 * station holds (the station read as freeGateNumberHere reads it) and no
 * other door of this room (`own`, keyed by door, `doorId` left out). Null
 * when nothing is free that way.
 */
export function steppedGateNumberHere(
  roomId: string,
  own: Record<string, number>,
  doorId: string,
  from: number,
  step: 1 | -1,
): number | null {
  const taken = new Set<number>();
  for (const g of stationGates(atlasAround(roomId), roomId)) if (g.roomId !== roomId) taken.add(g.gate);
  for (const [d, g] of Object.entries(own)) if (d !== doorId) taken.add(g);
  let gate = from + step;
  while (gate >= 1 && gate <= MAX_GATE_NUMBER && taken.has(gate)) gate += step;
  return gate >= 1 && gate <= MAX_GATE_NUMBER ? gate : null;
}

/**
 * ⚓🚦 `atlas` with a room doc's shared atlas folded in, for gate numbering in
 * a room this client may never have visited (a far DOCK's port). Only the
 * station around `roomId` is read: a walk from that room along its door
 * pairings (berths aside), looking each room up in the doc directly, so a
 * doc crowded with other stations' entries cannot push this one's out of
 * reach. A room the local atlas lacks comes from the doc; a known room gains
 * any door pairing it lacks (a newer doc copy's pairings replace ours door by
 * door), and the doc's gates when it has none or the doc's copy is newer (as
 * pullSharedAtlas arbitrates), so the station walk
 * and the numbers taken both see what the far station has published. Peer
 * entries are shape-checked and capped as pullSharedAtlas does. Pure:
 * nothing is written.
 */
export function withSharedAtlasOf(
  doc: Y.Doc,
  atlas: Record<string, AtlasEntry>,
  roomId: string,
): Record<string, AtlasEntry> {
  // No prototype: a room named `__proto__` is an ordinary key here too, so
  // its tombstone stands in `out` and a lookup of a room `out` lacks finds
  // nothing.
  const out: Record<string, AtlasEntry> = Object.assign(Object.create(null), atlas);
  const shared = doc.getMap('atlas');
  // 🔧 Rooms known to be taken apart — in the atlas given, or in our stored
  // one (readAtlas leaves them out) — stand as tombstones unless the copy
  // given is newer. Only a newer doc copy of such a room counts below; an
  // older one is gossip from before the job ended.
  // (A copy that brought the module back outranks the very tombstone it
  // names, whatever their stamps: revivesTomb. Of two tombstones at an equal
  // stamp, the later dismantling stands: laterTomb.)
  const gone = new Map<string, AtlasEntry>();
  for (const e of [...Object.values(readStoredAtlas()), ...Object.values(atlas)]) {
    if (e?.dismantledAt === undefined) continue;
    const seen = gone.get(e.roomId);
    if (seen && (seen.lastSeen > e.lastSeen || (seen.lastSeen === e.lastSeen && !laterTomb(e, seen)))) continue;
    gone.set(e.roomId, e);
    const held = out[e.roomId];
    if (!held || (!revivesTomb(held, e) && (held.lastSeen < e.lastSeen
      || (held.lastSeen === e.lastSeen && !laterTomb(held, e))))) {
      out[e.roomId] = { roomId: e.roomId, name: e.name, doors: {}, dismantledAt: e.dismantledAt, lastSeen: e.lastSeen };
    }
  }
  const queued = new Set<string>([roomId]);
  const queue: string[] = [roomId];
  for (let i = 0; i < queue.length && i < MAX_SHARED_SCAN; i++) {
    const rid = queue[i];
    const value = shared.get(rid);
    const tomb = gone.get(rid);
    const stale = isSharedAtlasEntry(value) && !!tomb && !revivesTomb(value, tomb) && tomb.lastSeen >= value.updatedAt;
    if (isSharedAtlasEntry(value) && value.roomId === rid && value.dismantledAt !== undefined) {
      // 🔧 Taken apart: a tombstone, newer than what we hold (or as new as a
      // live copy: a tie goes to the tombstone, as in the pull), joins nothing.
      const held = out[rid];
      if (!held || (!revivesTomb(held, value) && (value.updatedAt > held.lastSeen
        || (value.updatedAt === held.lastSeen && (held.dismantledAt === undefined || laterTomb(value, held)))))) {
        out[rid] = { roomId: rid, name: value.name || 'Module', doors: {}, dismantledAt: value.dismantledAt, lastSeen: value.updatedAt };
      }
    } else if (isSharedAtlasEntry(value) && value.roomId === rid && !stale) {
      const doors: Record<string, AtlasDoor> = {};
      let kept = 0;
      let whole = true;
      for (const [d, door] of Object.entries(value.doors)) {
        if (kept >= MAX_DOORS_PER_ENTRY) { whole = false; break; }
        if (!door || typeof door.targetRoomId !== 'string' || !door.targetRoomId) continue;
        doors[d] = {
          targetSeed: '',
          targetRoomId: door.targetRoomId,
          segments: door.segments,
          farDoor: door.farDoor,
          ...(typeof door.transient === 'boolean' ? { transient: door.transient } : {}),
        };
        kept++;
      }
      const gates = value.gates !== undefined ? cleanGates(value.gates) : undefined;
      // 🔧 A tombstone held here is older than this copy (else it is stale,
      // above): the module is back, so the copy stands on its own.
      const prior = out[rid]?.dismantledAt === undefined ? out[rid] : undefined;
      if (!prior) {
        out[rid] = {
          roomId: rid,
          name: value.name || 'Module',
          doors,
          ...(gates ? { gates } : {}),
          lastSeen: value.updatedAt,
        };
      } else {
        // A newer doc copy is the room's doors now, as pullSharedAtlas takes
        // it: a door it lacks was removed (keeping it would walk a module no
        // longer in the station). Our seed for a door still paired the same
        // way stays. An older copy only adds pairings we lack; so does a
        // newer one cut short at the door cap.
        const newer = value.updatedAt > prior.lastSeen;
        const withSeeds: Record<string, AtlasDoor> = {};
        for (const [d, door] of Object.entries(doors)) {
          const had = prior.doors[d];
          withSeeds[d] = had && had.targetRoomId === door.targetRoomId ? { ...door, targetSeed: had.targetSeed } : door;
        }
        const merged: AtlasEntry = {
          ...prior,
          doors: newer ? (whole ? withSeeds : { ...prior.doors, ...withSeeds }) : { ...doors, ...prior.doors },
        };
        if (gates && (prior.gates === undefined || newer)) merged.gates = gates;
        out[rid] = merged;
      }
    }
    for (const door of Object.values(out[rid]?.doors ?? {})) {
      if (!door || isBerthDoor(door) || queued.has(door.targetRoomId)) continue;
      queued.add(door.targetRoomId);
      queue.push(door.targetRoomId);
    }
  }
  // What the maps see: no room taken apart, and no door naming one.
  return visibleAtlas(out);
}

// ── 🪐 Connected components — what a STATION is ──────────────────────────────
//
// Which rooms make up a station is never stored: a station is the set of
// rooms joined by door pairings. These walks are the one definition of that
// set, shared by the default-station export (defaultStation.atlasForBundle)
// and the station registry (stations.ts), whose records — name, planet,
// orbit — sit on top of these components. Edges are walked both ways — a pairing recorded on
// either side joins the two rooms — and a door may name a room the atlas holds
// no entry for (a neighbour we only heard about); that room still belongs.
// TRANSIENT berths are not structure and join nothing: a visiting ship is not
// part of the station it docks at, and a stale berth left on the station side
// after the ship casts off can never bridge two stations through the ship.
// Both records of a berth count as the berth (berthDoorIds), however the
// other side happens to be flagged, and the atlas writes that down
// (markInferredBerths) so it outlives the flagged record.

/** ⚓ Is this door a visiting ship's berth rather than station structure?
 *  Flagged transient, or a DOCK — exactly two `dock` segments, which dockRules
 *  defines as always transient. The chain test is what catches docks recorded
 *  before the flag existed (persisted, or gossiped by an older client): their
 *  segments always travelled with them. */
export function isBerthDoor(door: Pick<AtlasDoor, 'transient' | 'segments'>): boolean {
  return door.transient === true || isDockChain(door.segments);
}

/**
 * ⚓ Every door record that is part of a berth, as room id → door ids. A
 * pairing is usually recorded on BOTH sides — the station room's door names
 * the ship, the ship's door names the room — and the two records are ONE
 * connection: when either side is a berth (isBerthDoor), so is the other,
 * so a stale or older-client record left unflagged on one side can never
 * join the ship to a station by itself.
 *
 * Records are matched per pair of rooms the way dockRules.findFarDoor finds
 * a connection's far end: a record's `farDoor` is the far room's own key for
 * its door, so a record naming one, or named by one, pairs with exactly that
 * record. Records naming no far door then pair across: a berth with a berth
 * opposite first (one connection flagged at both ends), and only a berth left
 * over with one unflagged record opposite. Whatever is left over is a
 * SEPARATE connection and keeps its own flag — a permanent gangway between
 * the same two rooms still joins them. (pairAtlasRecords does the matching;
 * the station plan's links read the same.)
 */
export function berthDoorIds(atlas: Record<string, AtlasEntry>): Map<string, Set<string>> {
  const berths = new Map<string, Set<string>>();
  const mark = (roomId: string, doorId: string) => {
    if (!berths.has(roomId)) berths.set(roomId, new Set());
    berths.get(roomId)!.add(doorId);
  };
  for (const { owners, sides, partners } of pairAtlasRecords(atlas)) {
    for (const [a, b] of partners) {
      if (isBerthDoor(a.door) || isBerthDoor(b.door)) {
        mark(owners[0], a.doorId);
        mark(owners[1], b.doorId);
      }
    }
    // Every record flagged itself, partnered or not.
    for (const i of [0, 1] as const) {
      for (const r of sides[i]) if (isBerthDoor(r.door)) mark(owners[i], r.doorId);
    }
  }
  return berths;
}

/** 🗺️ One room's record of a connection, as pairAtlasRecords files it. */
interface PairEnd {
  doorId: string;
  door: AtlasDoor;
}

/** 🗺️ The records two rooms hold of the connections between them. */
interface AtlasPair {
  /** The two rooms, sorted. */
  owners: [string, string];
  /** Each room's records naming the other, in `owners` order. */
  sides: [PairEnd[], PairEnd[]];
  /** The two ends of one connection, [owners[0]'s record, owners[1]'s]. */
  partners: Array<[PairEnd, PairEnd]>;
}

/**
 * 🗺️ Every pairing record in the atlas, filed under its (unordered) pair of
 * rooms, with the records that are the two ends of one connection partnered
 * (the matching berthDoorIds describes). Unnamed records the berth rules
 * leave over, unflagged on both sides, pair one for one: they mark no
 * berth, but a record left unpartnered is a connection only its own room
 * wrote down (farOnlyRecords).
 */
function pairAtlasRecords(atlas: Record<string, AtlasEntry>): AtlasPair[] {
  const pairs = new Map<string, AtlasPair>();
  for (const e of Object.values(atlas)) {
    if (!e?.roomId || !e.doors) continue;
    for (const [doorId, door] of Object.entries(e.doors)) {
      if (!door?.targetRoomId) continue;
      const owners: [string, string] = e.roomId < door.targetRoomId
        ? [e.roomId, door.targetRoomId]
        : [door.targetRoomId, e.roomId];
      const key = JSON.stringify(owners);
      let pair = pairs.get(key);
      if (!pair) pairs.set(key, pair = { owners, sides: [[], []], partners: [] });
      pair.sides[owners[0] === e.roomId ? 0 : 1].push({ doorId, door });
    }
  }

  for (const { sides, partners } of pairs.values()) {
    const partnered = new Set<PairEnd>();
    const partner = (i: 0 | 1, mine: PairEnd, theirs: PairEnd) => {
      partnered.add(mine);
      partnered.add(theirs);
      partners.push(i === 0 ? [mine, theirs] : [theirs, mine]);
    };
    // Named: `farDoor` picks out the other end exactly — the record's own
    // name first, else a record opposite naming it.
    for (const i of [0, 1] as const) {
      for (const r of sides[i]) {
        if (partnered.has(r)) continue;
        const open = sides[1 - i].filter((c) => !partnered.has(c));
        const t = open.find((c) => c.doorId === r.door.farDoor) ?? open.find((c) => c.door.farDoor === r.doorId);
        if (t) partner(i, r, t);
      }
    }
    // Unnamed: a berth flagged at both ends is one connection, so berths pair
    // with berths first; only a berth left over (flagged on one side alone)
    // takes one unflagged, unnamed record opposite.
    const loose = (i: number, berth: boolean) =>
      sides[i].filter((r) => r.door.farDoor === undefined && !partnered.has(r) && isBerthDoor(r.door) === berth);
    const [flagged0, flagged1] = [loose(0, true), loose(1, true)];
    for (let k = 0; k < Math.min(flagged0.length, flagged1.length); k++) partner(0, flagged0[k], flagged1[k]);
    for (const i of [0, 1] as const) {
      const unflagged = loose(1 - i, false);
      for (const r of loose(i, true)) {
        const t = unflagged.shift();
        if (!t) break;
        partner(i, r, t);
      }
    }
    // The unflagged rest, one for one.
    const [plain0, plain1] = [loose(0, false), loose(1, false)];
    for (let k = 0; k < Math.min(plain0.length, plain1.length); k++) partner(0, plain0[k], plain1[k]);
  }
  return [...pairs.values()];
}

/**
 * 🗺️ The connections only the far room wrote down: every record naming a
 * room that no record of that room's own partners, matched the way
 * berthDoorIds matches them (pairAtlasRecords), keyed by the room named.
 * One pass over the atlas.
 */
export function farOnlyRecords(
  atlas: Record<string, AtlasEntry>,
): Map<string, Array<{ fromRoomId: string; doorId: string; door: AtlasDoor }>> {
  const out = new Map<string, Array<{ fromRoomId: string; doorId: string; door: AtlasDoor }>>();
  for (const { owners, sides, partners } of pairAtlasRecords(atlas)) {
    if (owners[0] === owners[1]) continue;
    const partnered = new Set<PairEnd>(partners.flat());
    for (const i of [0, 1] as const) {
      for (const r of sides[i]) {
        if (partnered.has(r)) continue;
        const named = owners[1 - i];
        const list = out.get(named) ?? [];
        list.push({ fromRoomId: owners[i], doorId: r.doorId, door: r.door });
        out.set(named, list);
      }
    }
  }
  return out;
}

function atlasAdjacency(atlas: Record<string, AtlasEntry>): Map<string, Set<string>> {
  const adjacent = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    adjacent.get(a)!.add(b);
  };
  const berths = berthDoorIds(atlas);
  for (const e of Object.values(atlas)) {
    if (!e?.roomId || !e.doors) continue;
    const skip = berths.get(e.roomId);
    for (const [doorId, d] of Object.entries(e.doors)) {
      if (!d?.targetRoomId || skip?.has(doorId)) continue;
      link(e.roomId, d.targetRoomId);
      link(d.targetRoomId, e.roomId);
    }
  }
  return adjacent;
}

/** The cap counts rooms the atlas holds an entry for; unknown door targets
 *  are still walked (they are bounded by the per-entry door cap), so a room
 *  listing many unknown neighbours cannot crowd a real one out of its
 *  component and split one station into two. */
function walkComponent(
  atlas: Record<string, AtlasEntry>,
  adjacent: Map<string, Set<string>>,
  start: string,
): Set<string> {
  const component = new Set<string>([start]);
  let known = atlas[start] ? 1 : 0;
  const queue = [start];
  while (queue.length > 0) {
    const rid = queue.shift()!;
    for (const next of adjacent.get(rid) ?? []) {
      if (component.has(next)) continue;
      if (atlas[next]) {
        if (known >= MAX_ENTRIES) continue;
        known++;
      }
      component.add(next);
      queue.push(next);
    }
  }
  return component;
}

/** The connected component of `roomId`, capped at the atlas's own size in
 *  known rooms.
 *  Empty when the atlas holds no entry for the room. */
export function atlasComponent(atlas: Record<string, AtlasEntry>, roomId: string): Set<string> {
  if (!roomId || !atlas[roomId]) return new Set();
  return walkComponent(atlas, atlasAdjacency(atlas), roomId);
}

/** Every connected component of the atlas — one per station this install
 *  knows. Only rooms the atlas holds an ENTRY for start a component, so a
 *  door naming an unknown room never invents a station of its own. Order
 *  follows the atlas's entry order; callers that need a stable order sort. */
export function atlasComponents(atlas: Record<string, AtlasEntry>): Set<string>[] {
  const adjacent = atlasAdjacency(atlas);
  const seen = new Set<string>();
  const out: Set<string>[] = [];
  for (const e of Object.values(atlas)) {
    if (!e?.roomId || seen.has(e.roomId)) continue;
    const component = walkComponent(atlas, adjacent, e.roomId);
    for (const rid of component) seen.add(rid);
    out.push(component);
  }
  return out;
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
  return atlasPoses(readAtlas(), currentRoomId, { liveRoomId: currentRoomId, maxHops })
    .filter((p) => p.roomId !== currentRoomId);
}

/**
 * 🗺️ The same BFS from ANY root room (#192: the holotable draws a station
 * that may not be the one you stand in), the root included at the origin.
 * `liveRoomId` is the room this client stands in: its own doors pose from
 * the live snapshot, every other room's from its harvested wall + lateral.
 * `expand` stops the walk at a room (placed, but its doors not followed) —
 * the holotable places docked ships without walking on through them.
 * `reverse` also follows a pairing recorded only on the far room's side.
 */
/** 🗺️ `record[key]` when the record holds it as its own key, else undefined:
 *  a room or door id off the wire such as `constructor`, `__proto__` or
 *  `toString` names nothing an object merely inherits (an inherited value
 *  read as a room has no doors, and walking them throws). */
export function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** 🧭 One hop's pose: the module behind `ownerId`'s door `doorId`, centre and
 *  heading in `ownerId`'s own frame. `liveRoomId`'s doors pose from the live
 *  snapshot; every other room's from its harvested wall + lateral. */
function hopLocal(
  atlas: Record<string, AtlasEntry>,
  ownerId: string,
  doorId: DoorId,
  door: AtlasDoor,
  liveRoomId: string,
): { x: number; z: number; rotY: number } {
  // 🔗 farDoor inference (owner's octagon-render fix, 2026-07-19): a
  // record written by a manual INITIATE (far-door dropdown left empty)
  // carries NO farDoor — the pose then falls back to rotY = heading,
  // which inverts that arm's curvature in a ring walk (observed live:
  // seven 18.6 m hops and one 78 m chasm, the scattered-boxes render).
  // But the FAR room's own record pointing back at us NAMES the door —
  // infer it from the graph before composing the hop.
  const far = ownValue(atlas, door.targetRoomId);
  const farDoorId = door.farDoor
    ?? (Object.entries(far?.doors ?? {})
      .find(([, r]) => (r as AtlasDoor | undefined)?.targetRoomId === ownerId)?.[0]);
  // 🧭 The far door's WALL, never guessed from its id: the pairing record's
  // farWall, else the far room's own gossiped door geometry, else unknown
  // (⇒ the hop faces the arrival heading — no invented rotation).
  const farRecord = farDoorId ? ownValue(far?.doors, farDoorId) : undefined;
  const farWall = door.farWall ?? farRecord?.wall ?? null;
  const farLateral = door.farLateral ?? farRecord?.lateral ?? 0;
  // The hop's pose in the FROM room's local frame → compose into world.
  // The CURRENT room's own doors use the LIVE pose (slide included); a
  // NEIGHBOUR room's door poses from its harvested wall+lateral — this
  // client's snapshot knows nothing about it. Old gossip without geometry
  // falls back to the live-pose path, which is the pre-redo behaviour.
  // 🛑📐 The far module's half-extent along its door's wall normal when its
  // size is known: the chain meets its TRUE face, so its centre sits that
  // far beyond the chain's end (review, round 8). Unknown ⇒ the adapter's
  // uniform default, as before.
  const farHalf = farWall ? halfAlongWall(far?.dims, farWall) : undefined;
  return ownerId !== liveRoomId && door.wall !== undefined
    ? projectionPoseFromWall(door.wall, door.lateral ?? 0, door.segments, farWall, farLateral, farHalf)
    : projectionPoseForDoor(doorId, door.segments, farWall, farLateral, farHalf);
}

export function atlasPoses(
  atlas: Record<string, AtlasEntry>,
  rootRoomId: string,
  opts: { liveRoomId?: string; maxHops?: number; expand?: (roomId: string) => boolean; reverse?: boolean } = {},
): AtlasPose[] {
  const maxHops = opts.maxHops ?? 10;
  const currentRoomId = opts.liveRoomId ?? '';
  // Rooms are looked up by their own keys only (ownValue): a door may name
  // a room `constructor` or `__proto__`.
  const root = ownValue(atlas, rootRoomId);
  if (!root) return [];
  const placed = new Map<string, AtlasPose>();
  placed.set(rootRoomId, {
    roomId: rootRoomId,
    name: root.name,
    seed: root.seed,
    dims: root.dims,
    x: 0, z: 0, rotY: 0, hops: 0,
  });
  const queue: string[] = [rootRoomId];
  while (queue.length > 0) {
    const fromId = queue.shift()!;
    const from = placed.get(fromId)!;
    if (from.hops >= maxHops) continue;
    if (opts.expand && fromId !== rootRoomId && !opts.expand(fromId)) continue;
    const entry = ownValue(atlas, fromId);
    if (!entry) continue;
    for (const [doorId, door] of Object.entries(entry.doors ?? {}) as Array<[DoorId, AtlasDoor]>) {
      if (!door || !door.targetRoomId || placed.has(door.targetRoomId)) continue;
      const local = hopLocal(atlas, fromId, doorId, door, currentRoomId);
      const cos = Math.cos(from.rotY), sin = Math.sin(from.rotY);
      const wx = from.x + local.x * cos + local.z * sin;
      const wz = from.z - local.x * sin + local.z * cos;
      const target = ownValue(atlas, door.targetRoomId);
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
    // 🗺️ A pairing recorded only on the FAR side (the station grouping counts
    // it, atlasComponent) still joins the two: pose the far room through its
    // own record of the door and invert that hop.
    if (!opts.reverse) continue;
    for (const other of Object.values(atlas)) {
      if (!other?.roomId || placed.has(other.roomId)) continue;
      const back = (Object.entries(other.doors ?? {}) as Array<[DoorId, AtlasDoor]>)
        .find(([, d]) => d?.targetRoomId === fromId);
      if (!back) continue;
      // `from` in the other room's frame: from = other + R(other.rotY)·l.
      const l = hopLocal(atlas, other.roomId, back[0], back[1], currentRoomId);
      const rotY = from.rotY - l.rotY;
      const cos = Math.cos(rotY), sin = Math.sin(rotY);
      placed.set(other.roomId, {
        roomId: other.roomId,
        name: other.name,
        seed: other.seed,
        dims: other.dims,
        x: from.x - (l.x * cos + l.z * sin),
        z: from.z - (-l.x * sin + l.z * cos),
        rotY,
        hops: from.hops + 1,
      });
      queue.push(other.roomId);
    }
  }
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
    /** ⚓ A transient berth — see AtlasDoor. Sent whenever KNOWN, false
     *  included, so a reader can tell "not a berth" from an older client's
     *  silence. */
    transient?: boolean;
  }>;
  /** 🛑📐 The module's true tile size. PUBLIC by owner ruling — anyone may see
   *  a module's outside: its size, its position and its connections. Only the
   *  SEED (the credential that dials you in) is access-controlled. */
  dims?: { cols: number; rows: number };
  /** ⚓🚦 Dock ports → gate numbers (AtlasEntry.gates). Public layout. */
  gates?: Record<string, number>;
  /** ⚓🚦 Non-open gate access (AtlasEntry.gateAccess). Public: a captain
   *  must know which gates admit them. */
  gateAccess?: Record<string, AtlasGateAccess>;
  /** 🗺️ The module's owner (AtlasEntry.owner), null when known ownerless.
   *  Public: the room doc already shows it to anyone inside. */
  owner?: AtlasOwner | null;
  /** 🔧 The module was taken apart (AtlasEntry.dismantledAt); its doors are
   *  empty. */
  dismantledAt?: number;
  /** 🔧 The tombstone this live copy brought the module back from
   *  (AtlasEntry.revives). */
  revives?: number;
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
    && (e.dims === undefined || isSaneDims(e.dims))
    // ⚓🚦 Gates ride as plain door-keyed maps, bounded like `doors`, so an
    // oversized peer value never becomes `known` (and never gets stringified).
    && (e.gates === undefined || isPlainGates(e.gates))
    && (e.gateAccess === undefined || isPlainGates(e.gateAccess))
    // 🗺️ An owner is a small object or absent; a malformed one is refused here
    // rather than half-read (cleanAtlasOwner checks its fields).
    && (e.owner === undefined || ownerOf(e.owner) !== undefined)
    // 🔧 A tombstone's stamp is a plain time; the record's own updatedAt is
    // what arbitrates it, bounded above.
    && (e.dismantledAt === undefined
      || (typeof e.dismantledAt === 'number' && Number.isFinite(e.dismantledAt) && e.dismantledAt >= 0))
    && (e.revives === undefined
      || (typeof e.revives === 'number' && Number.isFinite(e.revives) && e.revives >= 0));
}

/** `{ owner }` when the owner is known (an owner or null), else nothing. */
function ownerSpread(owner: AtlasOwner | null | undefined): { owner?: AtlasOwner | null } {
  return owner !== undefined ? { owner } : {};
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
  const atlas = readStoredAtlas();
  markInferredBerths(atlas); // before any entry is replaced, as in harvestIntoAtlas
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
    // 🛰️ A BUNDLED prior (seedAtlasDefaults) never wins this comparison: it is
    // second-hand build data at `lastSeen: 0`, and 0 is a legitimate gossip
    // stamp — the #144 repair republishes a corrected legacy entry at
    // `updatedAt: 0`, which the `>=` below would otherwise let the bundle
    // outrank when the door counts tie, leaving the flag stuck forever
    // (review of #156, round 3). Any valid shared record replaces it.
    // 🔧 A tombstone of ours has no doors, yet it outranks any older copy:
    // the module was taken apart after that copy was written. And an
    // incoming tombstone is not outranked by a stub, however fresh: a door
    // naming the room is no news about the room itself. At an equal stamp
    // the tombstone wins either way (pushAtlasToDoc publishes it at a tie:
    // over a copy stamped at the six-hour ceiling it can do no better), and
    // of two tombstones, the later dismantling (laterTomb).
    const stub = Object.keys(prior?.doors ?? {}).length === 0 && prior?.localSeenAt === undefined;
    // 🔧 A copy that brought the module back outranks the tombstone it names,
    // whichever of the two we hold.
    if (prior && revivesTomb(prior, value)) continue;
    if (prior
      && !prior.bundled
      && !revivesTomb(value, prior)
      && prior.lastSeen >= value.updatedAt
      && (prior.dismantledAt !== undefined
        ? prior.lastSeen > value.updatedAt || !laterTomb(value, prior)
        : value.dismantledAt !== undefined
          ? !stub && prior.lastSeen > value.updatedAt
          : Object.keys(prior.doors).length >= incoming)) {
      // ⚓🚦 Our copy stands, but one harvested by an older build carries no
      // gates: take the doc's, and the access that rides with them, on their
      // own, so gate numbering sees them.
      if (prior.gates === undefined && value.gates !== undefined && isPlainGates(value.gates)) {
        prior.gates = cleanGates(value.gates);
        if (value.gateAccess !== undefined && isPlainGates(value.gateAccess)) {
          prior.gateAccess = cleanGateAccess(value.gateAccess, prior.gates);
        }
        changed = true;
      }
      // 🗺️ Likewise an owner our copy never learned (an older build's harvest).
      const owner = prior.owner === undefined ? ownerOf(value.owner) : undefined;
      if (owner !== undefined) {
        prior.owner = owner;
        changed = true;
      }
      continue;
    }
    const doors: Record<string, AtlasDoor> = {};
    let kept = 0;
    for (const [d, door] of Object.entries(value.dismantledAt !== undefined ? {} : value.doors)) {
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
        // A berth flag is exactly true or false. Anything else is an older
        // client's silence, and silence must not erase what we knew: keep the
        // prior value while the door still leads to the same room (review of
        // #171 — legacy gossip was clearing markers and re-merging stations).
        ...(typeof door.transient === 'boolean'
          ? { transient: door.transient }
          : prior?.doors[d]?.targetRoomId === door.targetRoomId
            && typeof prior?.doors[d]?.transient === 'boolean'
            ? { transient: prior.doors[d].transient }
            : {}),
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
      // ⚓🚦 Peer-written: cleaned and capped. Silence (an older client) keeps
      // what we knew, like dims.
      ...(value.gates !== undefined && isPlainGates(value.gates)
        ? { gates: cleanGates(value.gates) }
        : prior?.gates ? { gates: prior.gates } : {}),
      // Access rides with the gates it belongs to: a publisher that sent
      // gates sent every non-open access, so absent here means all open.
      ...(value.gates !== undefined && isPlainGates(value.gates)
        ? (value.gateAccess !== undefined && isPlainGates(value.gateAccess)
          ? { gateAccess: cleanGateAccess(value.gateAccess, cleanGates(value.gates)) }
          : {})
        : prior?.gateAccess ? { gateAccess: prior.gateAccess } : {}),
      // 🗺️ Peer-written and checked; silence keeps what we knew.
      // (null: the publisher saw the room ownerless — that clears ours.)
      ...ownerSpread(ownerOf(value.owner) !== undefined ? ownerOf(value.owner) : prior?.owner),
      // 🔧 A newer copy saying the module was taken apart: the tombstone, and
      // no doors (a tombstone joins nothing, whatever its writer sent). Still
      // gone after this install took it apart: still its own to keep.
      ...(value.dismantledAt !== undefined ? { dismantledAt: value.dismantledAt } : {}),
      ...(value.dismantledAt !== undefined && prior?.dismantledAt !== undefined && prior.dismantledHere
        ? { dismantledHere: true as const }
        : {}),
      // A live copy keeps naming the tombstone it, or the copy it replaces,
      // brought the module back from.
      ...(value.dismantledAt === undefined
        ? value.revives !== undefined
          ? { revives: value.revives }
          : prior?.dismantledAt === undefined && prior?.revives !== undefined ? { revives: prior.revives } : {}
        : {}),
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

/** ⚓ A doc entry with a berth flag added wherever it has none and our entry
 *  holds `transient: true` for the same door to the same room, or null when
 *  there is nothing to add. Nothing else in the doc's copy changes. */
function withBerthFlags(known: SharedAtlasEntry, entry: AtlasEntry): SharedAtlasEntry | null {
  let doors: SharedAtlasEntry['doors'] | null = null;
  for (const [id, door] of Object.entries(known.doors)) {
    const mine = entry.doors[id];
    if (!door || typeof door.transient === 'boolean' || mine?.transient !== true) continue;
    if (typeof door.targetRoomId !== 'string' || door.targetRoomId !== mine.targetRoomId) continue;
    doors ??= { ...known.doors };
    doors[id] = { ...door, transient: true };
  }
  return doors ? { ...known, doors } : null;
}

/**
 * localStorage → doc (called after every harvest). Gossip carries geometry +
 * names; SEEDS DO NOT TRAVEL — except the doc's own-room entry (see header).
 * Content-compared (stamp excluded) so re-joins don't churn the doc.
 */
export function pushAtlasToDoc(): void {
  saveUnsavedTombs();
  if (!sharedAlive() || !sharedCtx) return;
  const ctx = sharedCtx;
  const atlas = readStoredAtlas();
  sharedDoc!.transact(() => {
    for (const entry of Object.values(atlas)) {
      const isOwn = entry.roomId === ctx.roomId;
      const doorIds = Object.keys(entry.doors) as DoorId[];
      // Stubs add no geometry; ⚓🚦 one that knows a room's gates still has
      // something to carry.
      // 🔧 A tombstone (a module taken apart) has no doors and still travels.
      if (!isOwn && doorIds.length === 0 && entry.gates === undefined && entry.dismantledAt === undefined) continue;
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
      // 🔧 Between a tombstone and a live copy, the tombstone wins a tie, as
      // the pull and withSharedAtlasOf rank them: over a copy stamped at the
      // six-hour ceiling, dismantleInAtlas can only tie it, and the module
      // must still come off. Between two tombstones, the later dismantling
      // wins a tie (laterTomb).
      // A copy that brought the module back outranks the tombstone it names,
      // whatever their stamps (revivesTomb).
      const knownAsNew = !!known && !revivesTomb(entry, known) && (revivesTomb(known, entry)
        || (entry.dismantledAt !== undefined && (known.dismantledAt === undefined || laterTomb(entry, known))
          ? known.updatedAt > entry.lastSeen
          : known.updatedAt >= entry.lastSeen));
      // ⚓🚦 A doc copy with no gates (an older client's, or a stub) gains the
      // gates we know even when it is otherwise as new as ours: its own doors
      // are kept, and only the gates are added. (Live copies only: a module
      // taken apart has no gates to give or take.)
      const onlyGates = !!known && !isOwn && entry.gates !== undefined && known.gates === undefined
        && entry.dismantledAt === undefined && known.dismantledAt === undefined
        && knownAsNew
        && Object.keys(known.doors).length >= doorIds.length;
      // (A tombstone there as new as ours stands whatever doors ours has: the
      // module came off after ours was written.)
      if (known && !isOwn && !onlyGates
        && knownAsNew
        && (known.dismantledAt !== undefined || Object.keys(known.doors).length >= doorIds.length)) {
        // The doc's copy is at least as new as ours, so ours stays unsent,
        // except for a berth we know and that copy has no flag for (an
        // inferred berth is written down, markInferredBerths). That flag goes
        // onto the DOC's copy, its geometry untouched, so a client joining
        // after the ship casts off still reads the stale end as a berth.
        // 🗺️ An owner we know and that copy lacks (an older client's) goes
        // onto it the same way. (Not onto a tombstone: no map shows its
        // owner, and the write would only race a copy that brings it back.)
        const flagged = withBerthFlags(known, entry);
        const owned = known.dismantledAt === undefined && known.owner === undefined && entry.owner !== undefined;
        if (flagged || owned) {
          sharedMap!.set(entry.roomId, {
            ...(flagged ?? known),
            ...(owned ? { owner: entry.owner } : {}),
            updatedAt: Math.min(known.updatedAt + 1, Date.now() + MAX_GOSSIP_SKEW_MS),
          });
        }
        continue;
      }
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
          // Known either way ⇒ published either way; unknown stays unsent.
          ...(typeof door.transient === 'boolean' ? { transient: door.transient } : {}),
          ...(isOwn && door.targetSeed ? { targetSeed: door.targetSeed } : {}),
        };
      }
      const rec: SharedAtlasEntry = {
        roomId: entry.roomId,
        name: onlyGates ? known!.name : entry.name,
        // (With 171's inferred berth flags applied, as the skip path does.)
        doors: onlyGates ? (withBerthFlags(known!, entry)?.doors ?? known!.doors) : doors,
        ...(onlyGates && known!.dims ? { dims: known!.dims } : {}),
        // 🛑📐 Size travels with the connection graph. Without this a peer
        // renders every module it has not personally visited at the fallback
        // size, so the station's shape was only ever right for rooms you had
        // walked through yourself.
        ...(!onlyGates && entry.dims ? { dims: entry.dims } : {}),
        // ⚓🚦 Gates travel with the layout, so a board or an arriving ship in
        // any room of the station knows every gate.
        ...(entry.gates ? { gates: entry.gates } : {}),
        ...(entry.gates && entry.gateAccess && Object.keys(entry.gateAccess).length > 0
          ? { gateAccess: entry.gateAccess }
          : {}),
        // 🗺️ The owner travels with the layout (the holotable's atlas card).
        ...ownerSpread(onlyGates && known!.owner !== undefined ? known!.owner : entry.owner),
        // 🔧 The module was taken apart: the tombstone travels like the layout.
        ...(entry.dismantledAt !== undefined ? { dismantledAt: entry.dismantledAt } : {}),
        // …and so does the one a copy brought it back from.
        ...(entry.dismantledAt === undefined && entry.revives !== undefined ? { revives: entry.revives } : {}),
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
