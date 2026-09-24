/**
 * 🛰️ Default station — where a brand-new install arrives (owner request,
 * 2026-09-14).
 *
 * A first run used to mint an empty home module and drop the player in it,
 * alone. Now a first run docks at the DEFAULT STATION's welcome room instead —
 * the owner's SSF-WELCOME — so a new player's first sight is a whole station
 * from space and their first room has people in it. Their own home module
 * (identity.getDefaultRoomId) is unchanged: it is where the boot falls back to
 * when the station cannot be reached, and PROVISION NEW MODULE still mints
 * rooms on their own node. Returning installs are untouched — an explicit
 * ?seed=, a resume target (ssf-last-room) and the ordinary home boot all take
 * precedence (main.ts bootstrapNetworking).
 *
 * ── Changing the default station ──────────────────────────────────────────
 * Edit WELCOME_ROOM_LINK below — ONE constant. It is an ordinary room pass:
 * stand in the new welcome room, SpacePhone → ACCESS → GENERATE PASS, and
 * paste the ssf://room?seed=… link here. The pass carries the room id, the
 * room KEY and the host node's iroh hints, so anyone holding this build can
 * enter the welcome room — that is the point; set the room's ROOM ACCESS to
 * PUBLIC so the shared atlas may carry its seed as well. The loopback wtUrl
 * inside the pass is harmless on other machines: the browser always dials its
 * OWN local node, and the node bridges to the pass's iroh member hints
 * (main.ts resolveBridgeBootstrap). An empty link ships without a default
 * station — first runs boot home, as before, and nothing is seeded whatever
 * the atlas file holds.
 *
 * defaultStation.atlas.json beside this file is the station's LAYOUT —
 * geometry, names and the connection graph, never seeds — exported from a
 * client whose atlas held the whole station. Every install merges it into its
 * local atlas at boot, at gossip tier (stationAtlas.seedAtlasDefaults), so the
 * station renders from space the moment the player is docked at the welcome
 * room, before its doc has synced; real gossip and visits outrank it, and it
 * is never republished as gossip. To refresh it after rebuilding the station:
 * stand in the new welcome room (the shared atlas fills the local one), open
 * the devtools console, run
 *     copy(window.__ssfMesh.exportDefaultStationAtlas())
 * — it exports the CONNECTED COMPONENT of the room you are standing in and
 * nothing else your atlas happens to hold (pass a room id to export another
 * station's) — and paste over the JSON file. defaultStation.test.ts checks
 * that the link and the file agree and that every pairing in the file is
 * reciprocal.
 */

import { normalizeWall } from './doorLayoutDoc';
import type { ConnectorSegment } from './adapter';
import { MAX_DOORS_PER_ENTRY, MAX_ENTRIES, isSaneDims, roomIdFromSeed } from './stationAtlas';
import type { AtlasEntry, BundledAtlasEntry } from './stationAtlas';
import bundledAtlasJson from './defaultStation.atlas.json';

/** The welcome room's pass — the ONE thing to change (see the header). */
const WELCOME_ROOM_LINK =
  'ssf://room?seed=eyJ2IjoyLCJyb29tSWQiOiJob21lLWZhYTIyMmExNDg5OCIsInJvb21LZXlCNjQiOiI5Y0ZvSmNsWUlocmFpZGhQNGpkVkg4Rzl1WTJrY1ZDcDhlZEZjUFVSUDU4Iiwid3RVcmwiOiJodHRwczovLzEyNy4wLjAuMTo0NDQzIiwiY2VydEhhc2hlc0I2NCI6WyIyUjAzaVhjS3U0UW9aNHRYcUE4U3Z4a1ZBN3ptTlpzdkR5bFpPK0hXQzJJPSJdLCJtZW1iZXJIaW50cyI6W3siaXJvaE5vZGVJZCI6Ijg3NmQ5ZjY0NDZhMGM2NGM1OTM3MzY4ODI2OGNjMmJjNjEwMmNkZjQ4MzVmNWI2MmMzMGQ4OTBmMTBlMDA2N2UiLCJpcm9oRGlyZWN0QWRkcnMiOlsiMjQuMjU0Ljc1LjE2MDozMzM1OSIsIjI0LjI1NC43NS4xNjA6NDQ0NDIiLCIxOTIuMTY4LjcuMTUxOjQ0NDQyIiwiWzI2MDA6ODgwNDo2NjAwOjk4OjM4N2Q6YTVmOTpmNDhlOjIxNzddOjQ0NDQyIiwiWzI2MDA6ODgwNDo2NjAwOjk4OjQ1NzY6ODUwMDo3N2I3OmU3YmFdOjQ0NDQyIl19XSwiaXJvaE5vZGVJZCI6Ijg3NmQ5ZjY0NDZhMGM2NGM1OTM3MzY4ODI2OGNjMmJjNjEwMmNkZjQ4MzVmNWI2MmMzMGQ4OTBmMTBlMDA2N2UiLCJpcm9oRGlyZWN0QWRkcnMiOlsiMjQuMjU0Ljc1LjE2MDozMzM1OSIsIjI0LjI1NC43NS4xNjA6NDQ0NDIiLCIxOTIuMTY4LjcuMTUxOjQ0NDQyIiwiWzI2MDA6ODgwNDo2NjAwOjk4OjM4N2Q6YTVmOTpmNDhlOjIxNzddOjQ0NDQyIiwiWzI2MDA6ODgwNDo2NjAwOjk4OjQ1NzY6ODUwMDo3N2I3OmU3YmFdOjQ0NDQyIl0sImlzc3VlZEF0IjoxNzg5NDgzNDM4MDE2fQ%3D%3D';

export const DEFAULT_STATION = {
  /** Display name for boot messages, before the room's own doc has synced. */
  name: 'SSF-WELCOME',
  welcomeRoomLink: WELCOME_ROOM_LINK,
  /** Parsed from the link; '' when this build ships no default station. */
  welcomeRoomId: roomIdFromSeed(WELCOME_ROOM_LINK),
} as const;

/** Geometry bounds the validator applies — pullSharedAtlas's lateral bound,
 *  and a generous chain length. The bundle is build data, but it is still JSON
 *  someone pasted over a file. */
const MAX_LATERAL = 32;
const MAX_SEGMENTS = 16;

type BundledDoor = BundledAtlasEntry['doors'][string];

/**
 * Validate a raw bundle — the JSON import, or whatever gets pasted over it.
 * Malformed entries and doors are DROPPED, not repaired: this is build data,
 * and defaultStation.test.ts asserts nothing in the shipped file is dropped.
 */
export function parseBundledAtlas(raw: unknown): BundledAtlasEntry[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const out: BundledAtlasEntry[] = [];
  for (const [rid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= MAX_ENTRIES) break;
    const entry = parseEntry(rid, value);
    if (entry) out.push(entry);
  }
  return out;
}

function parseEntry(rid: string, value: unknown): BundledAtlasEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (!rid || e.roomId !== rid || typeof e.name !== 'string' || !e.name) return null;
  const dims = e.dims;
  if (dims !== undefined && !isSaneDims(dims)) return null;
  if (typeof e.doors !== 'object' || e.doors === null) return null;
  const doors: BundledAtlasEntry['doors'] = {};
  let kept = 0;
  for (const [id, d] of Object.entries(e.doors as Record<string, unknown>)) {
    if (kept >= MAX_DOORS_PER_ENTRY) break;
    if (!id) continue;
    const door = parseDoor(d);
    if (!door) continue;
    doors[id] = door;
    kept++;
  }
  return {
    roomId: rid,
    name: e.name,
    ...(dims !== undefined ? { dims } : {}),
    doors,
  };
}

function parseDoor(value: unknown): BundledDoor | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Record<string, unknown>;
  if (typeof d.targetRoomId !== 'string' || !d.targetRoomId) return null;
  // Either wall vocabulary in (compass names predate the axis rename), axis
  // labels out — a wall that is NAMED but unknown drops the door.
  const wall = normalizeWall(d.wall);
  const farWall = normalizeWall(d.farWall);
  if ((d.wall !== undefined && !wall) || (d.farWall !== undefined && !farWall)) return null;
  if (!optionalWithin(d.lateral, MAX_LATERAL) || !optionalWithin(d.farLateral, MAX_LATERAL)) return null;
  if (d.farDoor !== undefined && (typeof d.farDoor !== 'string' || !d.farDoor)) return null;
  if (d.farYawDeg !== undefined && d.farYawDeg !== 0 && d.farYawDeg !== 45) return null;
  const segments = d.segments === undefined ? undefined : parseSegments(d.segments);
  if (segments === null) return null;
  return {
    targetRoomId: d.targetRoomId,
    ...(wall ? { wall } : {}),
    ...(typeof d.lateral === 'number' ? { lateral: d.lateral } : {}),
    ...(typeof d.farDoor === 'string' ? { farDoor: d.farDoor } : {}),
    ...(farWall ? { farWall } : {}),
    ...(typeof d.farLateral === 'number' ? { farLateral: d.farLateral } : {}),
    ...(d.farYawDeg === 0 || d.farYawDeg === 45 ? { farYawDeg: d.farYawDeg } : {}),
    ...(segments ? { segments } : {}),
  };
}

function optionalWithin(v: unknown, max: number): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max);
}

/** Chain segments as the adapter renders them; the renderer clamps every
 *  number to its own envelope, so finite is the bar here. */
function parseSegments(value: unknown): ConnectorSegment[] | null {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return null;
  const out: ConnectorSegment[] = [];
  for (const s of value) {
    if (typeof s !== 'object' || s === null) return null;
    const seg = s as Record<string, unknown>;
    // ⚓ #163: a docking-adapter half carries no parameters.
    if (seg.kind === 'dock') { out.push({ kind: 'dock' }); continue; }
    if (seg.kind !== 'flex' && seg.kind !== 'ext') return null;
    const finite = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isFinite(n));
    if (!finite(seg.bendDeg) || !finite(seg.stretch) || !finite(seg.bays)) return null;
    if (seg.skin !== undefined && seg.skin !== 'ribbed' && seg.skin !== 'solid') return null;
    out.push({
      kind: seg.kind,
      ...(typeof seg.bendDeg === 'number' ? { bendDeg: seg.bendDeg } : {}),
      ...(typeof seg.stretch === 'number' ? { stretch: seg.stretch } : {}),
      ...(typeof seg.bays === 'number' ? { bays: seg.bays } : {}),
      ...(seg.skin === 'ribbed' || seg.skin === 'solid' ? { skin: seg.skin } : {}),
    });
  }
  return out;
}

/** The bundled station for a given link and file — pure, so the empty
 *  configuration is testable: no link ⇒ no station, whatever the file holds.
 *  The welcome room carries the link as its seed — the one seed a bundle ever
 *  holds, attached here and never read from the file. */
export function defaultStationAtlasFor(welcomeRoomLink: string, raw: unknown): BundledAtlasEntry[] {
  const welcomeRoomId = roomIdFromSeed(welcomeRoomLink);
  if (!welcomeRoomId) return [];
  const entries = parseBundledAtlas(raw);
  for (const e of entries) {
    if (e.roomId === welcomeRoomId) e.seed = welcomeRoomLink;
  }
  return entries;
}

/** The shipped station: WELCOME_ROOM_LINK + defaultStation.atlas.json. */
export function defaultStationAtlas(): BundledAtlasEntry[] {
  return defaultStationAtlasFor(DEFAULT_STATION.welcomeRoomLink, bundledAtlasJson);
}

/**
 * What a client exports for the bundle (the devtools helper in the header):
 * the CONNECTED COMPONENT of `welcomeRoomId` in its local atlas — the station,
 * not every module this install ever visited (review of #156) — minus
 * everything personal: seeds, door seeds and both recency stamps. Edges are
 * walked both ways (a pairing recorded on either side joins the two rooms),
 * the component is capped at the atlas's own size, and doorless stubs add no
 * geometry so they are left out. Empty when the room is unknown.
 */
export function atlasForBundle(
  atlas: Record<string, AtlasEntry>,
  welcomeRoomId: string,
): Record<string, BundledAtlasEntry> {
  const out: Record<string, BundledAtlasEntry> = {};
  if (!welcomeRoomId || !atlas[welcomeRoomId]) return out;
  const adjacent = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    adjacent.get(a)!.add(b);
  };
  for (const e of Object.values(atlas)) {
    if (!e?.roomId || !e.doors) continue;
    for (const d of Object.values(e.doors)) {
      if (!d?.targetRoomId) continue;
      link(e.roomId, d.targetRoomId);
      link(d.targetRoomId, e.roomId);
    }
  }
  const component = new Set<string>([welcomeRoomId]);
  const queue = [welcomeRoomId];
  while (queue.length > 0) {
    const rid = queue.shift()!;
    for (const next of adjacent.get(rid) ?? []) {
      if (component.has(next) || component.size >= MAX_ENTRIES) continue;
      component.add(next);
      queue.push(next);
    }
  }
  for (const rid of component) {
    const e = atlas[rid];
    if (!e?.doors) continue;
    const doors: BundledAtlasEntry['doors'] = {};
    for (const [id, d] of Object.entries(e.doors)) {
      if (!d?.targetRoomId) continue;
      doors[id] = {
        targetRoomId: d.targetRoomId,
        ...(d.wall !== undefined ? { wall: d.wall } : {}),
        ...(d.lateral !== undefined ? { lateral: d.lateral } : {}),
        ...(d.farDoor !== undefined ? { farDoor: d.farDoor } : {}),
        ...(d.farWall !== undefined ? { farWall: d.farWall } : {}),
        ...(d.farLateral !== undefined ? { farLateral: d.farLateral } : {}),
        ...(d.farYawDeg !== undefined ? { farYawDeg: d.farYawDeg } : {}),
        ...(d.segments !== undefined ? { segments: d.segments } : {}),
      };
    }
    if (Object.keys(doors).length === 0) continue;
    out[rid] = {
      roomId: rid,
      name: e.name,
      ...(e.dims ? { dims: e.dims } : {}),
      doors,
    };
  }
  return out;
}
