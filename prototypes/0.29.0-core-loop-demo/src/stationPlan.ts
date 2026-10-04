/**
 * 🗺️ Station plan — a known station's atlas laid flat for the holotable (#192)
 *
 * The holotable's solar plot shows WHERE each station is; this is WHAT it is:
 * every module the station atlas knows (stationAtlas.ts), placed with the
 * same pose composition the exterior view uses, drawn from above. A docked
 * ship is a module reached through a berth door — placed beside its gate but
 * never walked through, and listed apart from the station's own modules.
 *
 * Pure: the atlas and the planet's ship summaries come in, a plan comes out.
 * stationPlanView.ts draws it and wires the clicks. ✏️ editAccess says how
 * the table lets you work on a module's doors: from the table in the room
 * you stand in, else by the ACCESS beam with a pass you hold (beamPassFor).
 */

import type { AtlasEntry, AtlasOwner } from './stationAtlas';
import { atlasComponent, atlasPoses, berthDoorIds, farOnlyRecords, ownValue, roomIdFromSeed } from './stationAtlas';
import { TILE_SIZE } from './floorPlanDoc';
import type { ShipSummary } from './planetSummary';

/** A module's footprint when the atlas never learned its size: the default
 *  2×2 room, the exterior view's fallback too. */
const FALLBACK_DIMS = { cols: 2, rows: 2 };

export interface PlanGate {
  doorId: string;
  gate: number;
  /** A ship is docked there (the atlas shows a berth on that door). */
  occupied: boolean;
}

export interface PlanLink {
  doorId: string;
  toRoomId: string;
  /** A visiting ship's berth, not station structure. */
  berth: boolean;
}

export interface PlanModule {
  roomId: string;
  name: string;
  /** Centre and heading in the plan's frame (the root room at the origin). */
  x: number;
  z: number;
  rotY: number;
  /** Half extents along the module's own x and z. */
  halfX: number;
  halfZ: number;
  /** The true tile size, when the atlas learned it (a module someone stood in). */
  dims?: { cols: number; rows: number };
  hops: number;
  /** null: known to have no verifiable owner; absent: not known. */
  owner?: AtlasOwner | null;
  /** 'ship' for a visiting ship docked at one of the station's berths. */
  kind: 'module' | 'ship';
  /** The room this client stands in. */
  here: boolean;
  gates: PlanGate[];
  links: PlanLink[];
  /** For a ship: the station module and door it is docked at. */
  dockedAt?: { roomId: string; doorId: string; gate?: number };
}

export interface StationPlan {
  rootRoomId: string;
  /** The station's own modules, the root first. */
  modules: PlanModule[];
  /** Ships docked at the station, as the atlas shows them. */
  ships: PlanModule[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** A plan with nothing in it (the atlas does not know the root room). */
export function emptyPlan(rootRoomId: string): StationPlan {
  return { rootRoomId, modules: [], ships: [], bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } };
}

/** Corners of a module's footprint, in the plan's frame — the same rotation
 *  atlasLayout composes hops with (x' = x·cos + z·sin, z' = −x·sin + z·cos). */
export function moduleCorners(m: Pick<PlanModule, 'x' | 'z' | 'rotY' | 'halfX' | 'halfZ'>): Array<{ x: number; z: number }> {
  const cos = Math.cos(m.rotY), sin = Math.sin(m.rotY);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]) => {
    const lx = sx * m.halfX, lz = sz * m.halfZ;
    return { x: m.x + lx * cos + lz * sin, z: m.z - lx * sin + lz * cos };
  });
}

/** Is the plan point (x, z) inside the module's footprint? */
export function moduleContains(m: Pick<PlanModule, 'x' | 'z' | 'rotY' | 'halfX' | 'halfZ'>, x: number, z: number): boolean {
  // Into the module's own frame: the inverse of moduleCorners' rotation.
  const dx = x - m.x, dz = z - m.z;
  const cos = Math.cos(m.rotY), sin = Math.sin(m.rotY);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  return Math.abs(lx) <= m.halfX && Math.abs(lz) <= m.halfZ;
}

/** The topmost module or ship under a plan point: ships draw over modules,
 *  so they are hit first. */
export function planModuleAt(plan: StationPlan, x: number, z: number): PlanModule | null {
  for (const list of [plan.ships, plan.modules]) {
    for (let i = list.length - 1; i >= 0; i--) if (moduleContains(list[i], x, z)) return list[i];
  }
  return null;
}

/**
 * Lay out the station holding `rootRoomId` from the atlas. `liveRoomId` is
 * the room this client stands in (its doors pose from the live snapshot, as
 * in atlasLayout). Rooms past a berth door are docked ships: placed, not
 * walked through, so a ship never drags another station into the plan.
 */
export function stationPlan(
  atlas: Record<string, AtlasEntry>,
  rootRoomId: string,
  liveRoomId = '',
): StationPlan {
  if (!rootRoomId || !ownValue(atlas, rootRoomId)) return emptyPlan(rootRoomId);
  const station = atlasComponent(atlas, rootRoomId);
  const berths = berthDoorIds(atlas);
  const poses = atlasPoses(atlas, rootRoomId, {
    liveRoomId,
    // No depth cap: the walk is cycle-safe and the atlas holds at most
    // MAX_ENTRIES rooms, so a long chain of modules is shown whole.
    maxHops: Infinity,
    expand: (roomId) => station.has(roomId),
    reverse: true,
    // Each module where the pairings that join it to the station put it
    // (the ones atlasComponent walks), and only a ship where its berth does.
    berths,
  });
  const farOnly = farOnlyRecords(atlas);
  const byId = new Map(poses.map((p) => [p.roomId, p]));

  const modules: PlanModule[] = [];
  const ships: PlanModule[] = [];
  for (const p of poses) {
    const entry = ownValue(atlas, p.roomId);
    const dims = entry?.dims ?? p.dims;
    const size = dims ?? FALLBACK_DIMS;
    const roomBerths = berths.get(p.roomId);
    const links: PlanLink[] = [];
    for (const [doorId, door] of Object.entries(entry?.doors ?? {})) {
      if (!door?.targetRoomId || !byId.has(door.targetRoomId)) continue;
      links.push({ doorId, toRoomId: door.targetRoomId, berth: roomBerths?.has(doorId) ?? false });
    }
    // 🗺️ A pairing only the far room recorded (atlasPoses' reverse hop) is a
    // link here too. Two rooms may share more than one connection, so a far
    // record is matched to OUR record of the same connection the way
    // berthDoorIds matches them (farOnlyRecords, read once for the whole
    // plan); only a far record left unmatched adds a link — through the door
    // it names, or a stand-in id no door or gate matches.
    for (const far of farOnly.get(p.roomId) ?? []) {
      if (far.fromRoomId === p.roomId || !byId.has(far.fromRoomId)) continue;
      const named = far.door.farDoor;
      const doorId = named && !ownValue(entry?.doors, named) ? named : `~${far.fromRoomId}:${far.doorId}`;
      links.push({ doorId, toRoomId: far.fromRoomId, berth: berths.get(far.fromRoomId)?.has(far.doorId) ?? false });
    }
    links.sort((a, b) => a.doorId.localeCompare(b.doorId));
    const gates: PlanGate[] = Object.entries(entry?.gates ?? {})
      .map(([doorId, gate]) => ({
        doorId,
        gate,
        occupied: links.some((l) => l.doorId === doorId && l.berth),
      }))
      .sort((a, b) => a.gate - b.gate);
    const mod: PlanModule = {
      roomId: p.roomId,
      name: entry?.name ?? p.name,
      x: p.x,
      z: p.z,
      rotY: p.rotY,
      halfX: (size.cols * TILE_SIZE) / 2,
      halfZ: (size.rows * TILE_SIZE) / 2,
      ...(dims ? { dims } : {}),
      hops: p.hops,
      ...(entry?.owner !== undefined ? { owner: entry.owner } : {}),
      kind: station.has(p.roomId) ? 'module' : 'ship',
      here: p.roomId === liveRoomId,
      gates,
      links,
    };
    if (mod.kind === 'module') modules.push(mod);
    else ships.push(mod);
  }

  // A ship's berth: the station door that leads to it (the first module's,
  // its first such door), from one pass over the links.
  const berthOf = new Map<string, { m: PlanModule; link: PlanLink }>();
  for (const m of modules) {
    for (const link of m.links) if (!berthOf.has(link.toRoomId)) berthOf.set(link.toRoomId, { m, link });
  }
  for (const ship of ships) {
    const at = berthOf.get(ship.roomId);
    if (!at) continue;
    const gate = at.m.gates.find((g) => g.doorId === at.link.doorId)?.gate;
    ship.dockedAt = { roomId: at.m.roomId, doorId: at.link.doorId, ...(gate !== undefined ? { gate } : {}) };
  }

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const m of [...modules, ...ships]) {
    for (const c of moduleCorners(m)) {
      bounds.minX = Math.min(bounds.minX, c.x);
      bounds.maxX = Math.max(bounds.maxX, c.x);
      bounds.minZ = Math.min(bounds.minZ, c.z);
      bounds.maxZ = Math.max(bounds.maxZ, c.z);
    }
  }
  return { rootRoomId, modules, ships, bounds };
}

/** 🚀 A ship at or near the station, as the holotable lists it. */
export interface VisitingShip {
  roomId: string;
  name: string;
  /** docked: at one of the station's gates. arriving: flying in, or arrived
   *  and still docking. leaving: undocking, or flying out from here. */
  state: 'docked' | 'arriving' | 'leaving';
  gate?: number;
  /** Arrival (arriving) or departure (leaving) time, when known. */
  at?: number;
  /** The planet summary's word on a ferry's route (departuresBoard.ts). */
  routeStatus?: ShipSummary['routeStatus'];
  /** The atlas shows it docked here (it is on the plan), and at the gate
   *  the ship names when it names one. */
  onPlan: boolean;
}

/**
 * Every ship at or near the station: the docked ships on the plan, merged
 * with what the planet's shared summary says about ships docked here, flying
 * in or flying out. `welcomeRoomId` is the station's welcome room, the id
 * ship summaries name a station by. `dismantled` holds the rooms taken apart
 * (dismantledRoomIds): a module taken apart is no ship here, whatever an old
 * summary of it still says (one docked here before it was bolted in, whose
 * retirement no one aboard published).
 */
export function visitingShips(
  plan: StationPlan,
  ships: ShipSummary[],
  welcomeRoomId: string,
  dismantled: ReadonlySet<string> = new Set(),
): VisitingShip[] {
  const out = new Map<string, VisitingShip>();
  const stationRooms = new Set(plan.modules.map((m) => m.roomId));
  for (const s of plan.ships) {
    out.set(s.roomId, {
      roomId: s.roomId,
      name: s.name,
      state: 'docked',
      ...(s.dockedAt?.gate !== undefined ? { gate: s.dockedAt.gate } : {}),
      onPlan: true,
    });
  }
  for (const s of ships) {
    if (stationRooms.has(s.roomId) || dismantled.has(s.roomId)) continue;
    // A ship that stopped being one (bolted in, fitting removed) is no
    // visitor, whatever berth the atlas still draws.
    if (s.retired) {
      out.delete(s.roomId);
      continue;
    }
    const at = s.fromRoom === welcomeRoomId;
    const to = s.toRoom === welcomeRoomId;
    let state: VisitingShip['state'] | null = null;
    if (s.status === 'in-flight') state = to ? 'arriving' : at ? 'leaving' : null;
    // Redocking: arrived but still docking (perhaps waiting for a berth). Its
    // record keeps no destination, so the summary names the station it is
    // docking at in fromRoom; it is arriving until it says docked.
    else if (s.status === 'redocking') state = to || at ? 'arriving' : null;
    else if (s.status === 'undocking') state = at ? 'leaving' : null;
    else if (s.status === 'docked') state = at ? 'docked' : null;
    if (!state) {
      // The ship says it is somewhere else: a berth the atlas still shows here
      // is stale (the dock never sees a ship leave), so it is not listed.
      if (s.fromRoom || s.toRoom) out.delete(s.roomId);
      continue;
    }
    const prior = out.get(s.roomId);
    // The atlas's berth may outlive the ship (the dock never sees it leave):
    // the ship's own newer word on where it is wins over the stale berth,
    // and a berth at another gate than the one it names is not where it is.
    const movedGate = s.gate !== undefined && prior?.gate !== undefined && s.gate !== prior.gate;
    out.set(s.roomId, {
      roomId: s.roomId,
      name: s.name || prior?.name || 'Ship',
      state,
      ...((s.gate ?? prior?.gate) !== undefined ? { gate: (s.gate ?? prior?.gate)! } : {}),
      ...(state === 'arriving' && s.etaAt !== undefined ? { at: s.etaAt } : {}),
      ...(state === 'leaving' && (s.departAt ?? s.departedAt) !== undefined ? { at: (s.departAt ?? s.departedAt)! } : {}),
      ...(s.routeStatus ? { routeStatus: s.routeStatus } : {}),
      onPlan: (prior?.onPlan ?? false) && !movedGate,
    });
  }
  const rank = { docked: 0, arriving: 1, leaving: 2 } as const;
  return [...out.values()].sort((a, b) =>
    rank[a.state] - rank[b.state]
    || (a.gate ?? Infinity) - (b.gate ?? Infinity)
    || a.name.localeCompare(b.name));
}

/**
 * ✏️ How the holotable lets you work on a module's doors (#192):
 *  - 'here': you stand in it (a module, or the docked ship you are aboard),
 *    and its door panels open from the table;
 *  - 'beam': another module of the station you stand in, one this install
 *    holds a pass to (`hasPass`): the ACCESS beam takes you in, where its
 *    own door panels do the editing;
 *  - 'walk': one you hold no pass to, reached through the station's doors;
 *  - 'outside': you stand in none of the station's modules (aboard a docked
 *    ship, or at another station), or it is no module of this station. A
 *    docked ship is another vessel, never one of the modules you beam into.
 */
export function editAccess(
  plan: StationPlan,
  roomId: string,
  hasPass: (roomId: string) => boolean,
): 'here' | 'beam' | 'walk' | 'outside' {
  if ([...plan.modules, ...plan.ships].some((x) => x.roomId === roomId && x.here)) return 'here';
  const m = plan.modules.find((x) => x.roomId === roomId);
  if (!m || !plan.modules.some((x) => x.here)) return 'outside';
  return hasPass(roomId) ? 'beam' : 'walk';
}

/** 🎫 The first of `seeds` that reaches `roomId`, the pass the holotable
 *  beams in with: a seed naming another room would take you there instead. */
export function beamPassFor(roomId: string, seeds: ReadonlyArray<string | null | undefined>): string | undefined {
  if (!roomId) return undefined;
  return seeds.find((s): s is string => !!s && roomIdFromSeed(s) === roomId);
}
