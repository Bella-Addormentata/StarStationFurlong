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
 * LOCAL, per-install (localStorage) — deliberately not shared truth: it is a
 * personal map of where you've been, not an authority record. The station
 * doc (durability plan) eventually replaces walk-to-learn with shared truth.
 */

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
      // The hop's pose in the FROM room's local frame → compose into world.
      const local = poseForDoor(doorId, door.segments, door.farDoor);
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
