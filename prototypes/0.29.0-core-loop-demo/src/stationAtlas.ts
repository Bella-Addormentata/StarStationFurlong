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

export interface AtlasDoor {
  /** The far room's SEED LINK (from the door record) — also the click-to-
   *  connect payload. */
  targetSeed: string;
  /** Far room id parsed from the seed link (graph key), '' if unparseable. */
  targetRoomId: string;
  segments?: ConnectorSegment[];
  farDoor?: DoorId;
  farYawDeg?: 0 | 45;
}

export interface AtlasEntry {
  roomId: string;
  name: string;
  /** A seed link that reaches THIS room, when we hold one (ledger/passes). */
  seed?: string;
  doors: Partial<Record<DoorId, AtlasDoor>>;
  lastSeen: number;
}

const KEY = 'ssf-station-atlas';
const MAX_ENTRIES = 64;

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
    return typeof obj === 'object' && obj !== null ? obj as Record<string, AtlasEntry> : {};
  } catch { return {}; }
}

function writeAtlas(atlas: Record<string, AtlasEntry>): void {
  try {
    const entries = Object.values(atlas).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_ENTRIES);
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
  doors: Array<{ doorId: DoorId; targetSeed: string; segments?: ConnectorSegment[]; farDoor?: DoorId; farYawDeg?: 0 | 45 }>;
}): void {
  if (!entry.roomId) return;
  const atlas = readAtlas();
  const prior = atlas[entry.roomId];
  const doors: Partial<Record<DoorId, AtlasDoor>> = {};
  for (const d of entry.doors) {
    doors[d.doorId] = {
      targetSeed: d.targetSeed,
      targetRoomId: roomIdFromSeed(d.targetSeed),
      segments: d.segments,
      farDoor: d.farDoor,
      farYawDeg: d.farYawDeg,
    };
  }
  atlas[entry.roomId] = {
    roomId: entry.roomId,
    name: entry.name || prior?.name || 'Module',
    seed: entry.seed ?? prior?.seed,
    doors,
    lastSeen: Date.now(),
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
    };
  }
  writeAtlas(atlas);
}

/** Record a reach-this-room seed learned elsewhere (ledger mints, passes). */
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
  };
  writeAtlas(atlas);
}

export interface AtlasPose {
  roomId: string;
  name: string;
  seed?: string;
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
export function atlasLayout(
  currentRoomId: string,
  poseForDoor: (doorId: DoorId, segments?: ConnectorSegment[], farDoor?: DoorId) => { x: number; z: number; rotY: number },
  maxHops = 10,
): AtlasPose[] {
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
      const farDoor = door.farDoor
        ?? (Object.entries(atlas[door.targetRoomId]?.doors ?? {})
          .find(([, r]) => (r as AtlasDoor | undefined)?.targetRoomId === fromId)?.[0] as DoorId | undefined);
      // The hop's pose in the FROM room's local frame → compose into world.
      const local = poseForDoor(doorId, door.segments, farDoor);
      const cos = Math.cos(from.rotY), sin = Math.sin(from.rotY);
      const wx = from.x + local.x * cos + local.z * sin;
      const wz = from.z - local.x * sin + local.z * cos;
      const target = atlas[door.targetRoomId];
      placed.set(door.targetRoomId, {
        roomId: door.targetRoomId,
        name: target?.name ?? 'Module',
        seed: target?.seed ?? door.targetSeed,
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

// ── 🛰️ Shared station atlas — the `atlas` room-doc map (see module header) ───

/** Doc-side entry (plain JSON, keyed by roomId, whole-value LWW). */
interface SharedAtlasEntry {
  roomId: string;
  name: string;
  doors: Partial<Record<DoorId, {
    targetRoomId: string;
    /** Present ONLY on a doc's own-room entry (doorsDoc exposes it anyway). */
    targetSeed?: string;
    segments?: ConnectorSegment[];
    farDoor?: DoorId;
    farYawDeg?: 0 | 45;
  }>>;
  /** Present ONLY on a doc's own-room entry while passage policy is public. */
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
    && typeof e.updatedAt === 'number'
    && (e.seed === undefined || typeof e.seed === 'string');
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
    if (prior
      && prior.lastSeen >= value.updatedAt
      && Object.keys(prior.doors).length >= Object.keys(value.doors).length) continue;
    const doors: Partial<Record<DoorId, AtlasDoor>> = {};
    for (const [d, door] of Object.entries(value.doors) as Array<[DoorId, NonNullable<SharedAtlasEntry['doors'][DoorId]>]>) {
      if (!door || typeof door.targetRoomId !== 'string' || !door.targetRoomId) continue;
      doors[d] = {
        targetSeed: door.targetSeed ?? prior?.doors[d]?.targetSeed ?? '',
        targetRoomId: door.targetRoomId,
        segments: door.segments,
        farDoor: door.farDoor,
        farYawDeg: door.farYawDeg,
      };
    }
    atlas[rid] = {
      roomId: rid,
      name: value.name || prior?.name || 'Module',
      seed: value.seed ?? prior?.seed,
      doors,
      lastSeen: Math.max(value.updatedAt, prior?.lastSeen ?? 0),
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
          farYawDeg: door.farYawDeg,
          ...(isOwn && door.targetSeed ? { targetSeed: door.targetSeed } : {}),
        };
      }
      const rec: SharedAtlasEntry = {
        roomId: entry.roomId,
        name: entry.name,
        doors,
        updatedAt: entry.lastSeen,
      };
      if (isOwn && entry.seed && ctx.isPassagePublic()) rec.seed = entry.seed;
      if (known
        && JSON.stringify({ ...known, updatedAt: 0 }) === JSON.stringify({ ...rec, updatedAt: 0 })) continue;
      sharedMap!.set(entry.roomId, rec);
    }
  });
}
