/**
 * 🛰️ Hull space — the ONE authority for everything OUTSIDE the walls
 * (owner request 2026-07-19: unify vestibules / doors / exterior mounts).
 *
 * Three systems used to claim exterior space independently: vestibule chains
 * (adapter/docking — attach at a DOOR, extend outward segment by segment),
 * exterior wall mounts (the engine work — one layer on the wall lattice), and
 * doors themselves (interior meshes + an exterior docking envelope expressed
 * only as a magic band constant). This module owns the shared GEOMETRY and
 * OCCUPANCY; the record systems stay where they are (furnitureDoc for items,
 * doorsDoc for chains) and consume it:
 *
 *  - WALL ANCHORS: the outer mounting lattice (moved here from furniture.ts —
 *    same parity snap, same wall-derived rot: local +z faces AWAY).
 *  - DOOR LANES: each door permanently reserves an outward corridor (the old
 *    EXT_DOOR_BAND, now stated as what it IS — the strip where a vestibule or
 *    docked ship lives).
 *  - STACK ANCHORS: an exterior item whose def `attach.provides` a face is an
 *    anchor for kinds whose `attach.accepts` lists it — tank on wall, tank on
 *    tank, engine on the outermost tank. Pose composition is the vestibule
 *    chain's outward idiom applied to items: layer N's perpendicular offset =
 *    WALL_LINE + Σ(depths below) + d_N/2, along-wall centred on its parent.
 *  - CHAIN OCCUPANCY: docking.ts registers a folded-chain box provider so
 *    mounts can never be placed through a built vestibule (and the assembly
 *    UI warns the other way — see docking.ts).
 *
 * Stacking rules (owner request, kept deliberately strict for v1):
 *  - a child is CENTRED on its parent (straight-outward stacks, no 2-D
 *    packing on faces) and no wider than it;
 *  - at most STACK_DEPTH_MAX layers;
 *  - REMOVAL CASCADES: pulling an item out also removes everything mounted
 *    outboard of it (to the room inventory — the #53 machinery); a parent
 *    with children cannot be carried ("unstack first");
 *  - records stay plain JSON and world-absolute (`pos` + `mountParent` id):
 *    LWW-safe, and a rare orphan (a peer's parent-removal racing a child
 *    write) just keeps its recorded pose — visually odd, never corrupt.
 */

import { FURNITURE, FURNITURE_DEFS, footprintAabb } from './furniture';
import type { FurnitureItem, FurnitureKind, Rot, Box } from './furniture';

/** Structural wall plane (|x| or |z|) — matches world.addSideWalls / doors. */
export const WALL_LINE = 6;

/** Half-width of every door's reserved exterior lane: the door axis + its
 *  vestibule/docking envelope (posts/click box at |along| ≤ 1.0; paired
 *  chains extend straight out). Value unchanged from the mount work. */
export const EXT_DOOR_BAND = 1.8;

/** Maximum stack layers on a wall (wall item = layer 1). */
export const STACK_DEPTH_MAX = 3;

export type WallSide = 'north' | 'south' | 'east' | 'west';

/** Wall-derived rot: local +z (the business end — engine bells) points AWAY
 *  from the room. south outward = +z ⇒ rot 0; east = +x ⇒ rot 1; etc. */
export const WALL_ROT: Record<WallSide, Rot> = { south: 0, east: 1, north: 2, west: 3 };

/** The wall a rot claims (inverse of WALL_ROT). */
export const ROT_WALL: Record<Rot, WallSide> = { 0: 'south', 1: 'east', 2: 'north', 3: 'west' };

/** Is this world position outside the interior square? */
export function isExteriorPos(pos: { x: number; z: number }): boolean {
  return Math.abs(pos.x) > WALL_LINE - 1e-6 || Math.abs(pos.z) > WALL_LINE - 1e-6;
}

/** Is this item hull-mounted right now? 'exterior-wall' kinds always are;
 *  dual-mode ('both') kinds are exterior exactly when they sit outside. */
export function isExteriorItem(item: FurnitureItem): boolean {
  const mount = FURNITURE_DEFS[item.kind].mount;
  if (mount === 'exterior-wall') return true;
  if (mount === 'both') return isExteriorPos(item.pos);
  return false;
}

/** Every currently hull-mounted item. */
export function exteriorItems(): FurnitureItem[] {
  return FURNITURE.filter(isExteriorItem);
}

// ── Wall-frame helpers ───────────────────────────────────────────────────────

function fpOf(kind: FurnitureKind): { w: number; d: number } {
  return FURNITURE_DEFS[kind].footprint ?? { w: 1, d: 1 };
}

/** Signed outward (perpendicular) coordinate of a pose on `side`'s axis. */
function perpOf(side: WallSide, pos: { x: number; z: number }): number {
  return side === 'south' ? pos.z : side === 'north' ? -pos.z : side === 'east' ? pos.x : -pos.x;
}

/** Along-wall coordinate of a pose on `side`. */
function alongOf(side: WallSide, pos: { x: number; z: number }): number {
  return side === 'south' || side === 'north' ? pos.x : pos.z;
}

/** World position from (side, along, perp). */
function poseFrom(side: WallSide, along: number, perp: number): { x: number; z: number } {
  switch (side) {
    case 'south': return { x: along, z: perp };
    case 'north': return { x: along, z: -perp };
    case 'east':  return { x: perp, z: along };
    case 'west':  return { x: -perp, z: along };
  }
}

/** Stack depth of a hull item: 1 = directly on the wall. */
export function mountDepthOf(item: FurnitureItem): number {
  let depth = 1;
  let cur = item;
  while (cur.mountParent) {
    const parent = FURNITURE.find((i) => i.id === cur.mountParent);
    if (!parent) break;
    depth++;
    cur = parent;
    if (depth > 8) break; // cycle guard — malformed peer data can't hang us
  }
  return depth;
}

/** Direct children mounted on `id`'s outer face. */
export function mountChildrenOf(id: string): FurnitureItem[] {
  return FURNITURE.filter((i) => i.mountParent === id);
}

/** Everything mounted outboard of `id` (children, grandchildren…), ordered
 *  DEEPEST FIRST — the removal-cascade order. */
export function mountDescendantsOf(id: string): FurnitureItem[] {
  const out: FurnitureItem[] = [];
  const walk = (pid: string) => {
    for (const child of mountChildrenOf(pid)) {
      walk(child.id);
      out.push(child);
    }
  };
  walk(id);
  return out;
}

// ── Chain occupancy (docking.ts registers the provider) ──────────────────────

let chainBoxProvider: (() => Box[]) | null = null;

/** docking.ts calls this once: returns the XZ AABBs swept by every BUILT
 *  vestibule chain (folded through its segment poses). */
export function setChainBoxProvider(fn: () => Box[]): void {
  chainBoxProvider = fn;
}

export function chainBoxes(): Box[] {
  try {
    return chainBoxProvider?.() ?? [];
  } catch {
    return []; // a throwing provider must never block placement outright
  }
}

/** Footprint boxes of every hull-mounted item (docking's warning check). */
export function exteriorItemBoxes(): Array<{ id: string; box: Box }> {
  const out: Array<{ id: string; box: Box }> = [];
  for (const item of exteriorItems()) {
    const box = footprintAabb(item.kind, item.pos, item.rot);
    if (box) out.push({ id: item.id, box });
  }
  return out;
}

/** Outermost occupied perpendicular extent of one wall (WALL_LINE when bare).
 *  Chain solving / atlas spacing can consult this so deep stacks are not
 *  clipped by a neighbouring module's jetbridge. */
export function effectiveWallExtent(side: WallSide): number {
  let extent = WALL_LINE;
  for (const item of exteriorItems()) {
    if (ROT_WALL[item.rot] !== side) continue;
    extent = Math.max(extent, perpOf(side, item.pos) + fpOf(item.kind).d / 2);
  }
  return extent;
}

// ── Anchoring (snap) ─────────────────────────────────────────────────────────

export interface ExteriorPose {
  x: number;
  z: number;
  rot: Rot;
  /** Present when the pose stacks on another item's outer face. */
  mountParent?: string;
}

/** Can `kind` mount on `parent`'s outer face? (attach tags + geometry). */
function canStackOn(kind: FurnitureKind, parent: FurnitureItem): boolean {
  const def = FURNITURE_DEFS[kind];
  const parentDef = FURNITURE_DEFS[parent.kind];
  const provides = parentDef.attach?.provides;
  if (!provides || !def.attach?.accepts.includes(provides)) return false;
  if (!isExteriorItem(parent)) return false;
  if (fpOf(kind).w > fpOf(parent.kind).w + 1e-6) return false; // no overhang
  if (mountChildrenOf(parent.id).length > 0) return false;     // face taken
  if (mountDepthOf(parent) + 1 > STACK_DEPTH_MAX) return false;
  return true;
}

/** The pose stacking `kind` on `parent`: centred, straight outward. */
export function stackPoseOn(kind: FurnitureKind, parent: FurnitureItem): ExteriorPose {
  const side = ROT_WALL[parent.rot];
  const along = alongOf(side, parent.pos);
  const perp = perpOf(side, parent.pos) + fpOf(parent.kind).d / 2 + fpOf(kind).d / 2;
  const { x, z } = poseFrom(side, along, perp);
  return { x, z, rot: parent.rot, mountParent: parent.id };
}

/**
 * Snap a free point to the nearest exterior anchor: a wall's outer lattice
 * pose (the original mount behaviour) or — when `kind` accepts a face an
 * existing hull item provides — that item's stack pose. Exterior items never
 * rotate freely: the rot comes with the anchor.
 */
export function snapExteriorPos(kind: FurnitureKind, x: number, z: number): ExteriorPose {
  const fp = fpOf(kind);
  const dN = Math.abs(z + WALL_LINE);
  const dS = Math.abs(z - WALL_LINE);
  const dW = Math.abs(x + WALL_LINE);
  const dE = Math.abs(x - WALL_LINE);
  const min = Math.min(dN, dS, dW, dE);
  const side: WallSide = min === dE ? 'east' : min === dW ? 'west' : min === dS ? 'south' : 'north';
  const rot = WALL_ROT[side];
  const halfW = fp.w / 2;
  const out = WALL_LINE + fp.d / 2;
  const snapAlong = (v: number) => {
    const s = Math.round(fp.w) % 2 === 1 ? Math.floor(v) + 0.5 : Math.round(v);
    return Math.max(-(WALL_LINE - halfW), Math.min(WALL_LINE - halfW, s));
  };
  const along = snapAlong(side === 'south' || side === 'north' ? x : z);
  const wallPose: ExteriorPose = { ...poseFrom(side, along, out), rot };

  // Stack anchors: nearest wins against the wall pose.
  let best = wallPose;
  let bestD = (wallPose.x - x) ** 2 + (wallPose.z - z) ** 2;
  for (const parent of exteriorItems()) {
    if (!canStackOn(kind, parent)) continue;
    const pose = stackPoseOn(kind, parent);
    const d = (pose.x - x) ** 2 + (pose.z - z) ** 2;
    if (d < bestD) {
      best = pose;
      bestD = d;
    }
  }
  return best;
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ExteriorVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Exterior placement verdict (the E3 drop gate's hull half). Wall poses must
 * sit exactly on the outer lattice, keep their span on the wall and out of
 * every DOOR LANE; stacked poses must sit exactly on their parent's outer
 * face with the attach rules satisfied. Everything checks hull occupancy:
 * other mounted items AND built vestibule chains.
 */
export function validateExteriorPlacement(
  item: FurnitureItem,
  pos: { x: number; z: number },
  rot: Rot,
  mountParent?: string,
): ExteriorVerdict {
  const parentId = mountParent ?? item.mountParent;
  const fp = fpOf(item.kind);
  const side = ROT_WALL[rot];
  const along = alongOf(side, pos);
  const perp = perpOf(side, pos);
  const halfW = fp.w / 2;

  if (parentId) {
    // ── Stacked: the pose is DERIVED — verify it matches the parent exactly.
    const parent = FURNITURE.find((i) => i.id === parentId);
    if (!parent) return { ok: false, reason: 'its mount base is gone' };
    if (parent.id === item.id) return { ok: false, reason: 'cannot mount on itself' };
    if (!canStackOn(item.kind, parent) && !mountChildrenOf(parent.id).some((c) => c.id === item.id)) {
      return { ok: false, reason: `cannot mount on ${parent.id}` };
    }
    const expect = stackPoseOn(item.kind, parent);
    if (Math.abs(expect.x - pos.x) > 1e-6 || Math.abs(expect.z - pos.z) > 1e-6 || expect.rot !== rot) {
      return { ok: false, reason: 'not seated on its mount base' };
    }
    if (mountDepthOf(parent) + 1 > STACK_DEPTH_MAX) {
      return { ok: false, reason: `stacks cap at ${STACK_DEPTH_MAX} layers` };
    }
  } else {
    // ── On the wall: exact lattice + span on the wall.
    if (Math.abs(perp - (WALL_LINE + fp.d / 2)) > 1e-6) {
      return { ok: false, reason: 'not on a wall mount line' };
    }
    if (Math.abs(along) > WALL_LINE - halfW + 1e-6) {
      return { ok: false, reason: 'off the end of the wall' };
    }
  }

  // ── Door lanes: the span must stay out of every door's reserved corridor.
  //    (Doors sit at each wall's centre — along = 0 in this frame.)
  if (Math.abs(along) - halfW < EXT_DOOR_BAND) {
    return { ok: false, reason: 'would block the door / docking envelope' };
  }

  // ── Hull occupancy: other mounted items…
  const box = footprintAabb(item.kind, pos, rot)!;
  const overlaps = (ob: Box) =>
    box.x0 < ob.x1 && box.x1 > ob.x0 && box.z0 < ob.z1 && box.z1 > ob.z0;
  for (const other of FURNITURE) {
    if (other.id === item.id) continue;
    if (!isExteriorItem(other)) continue;
    // A stack parent's box legitimately touches its child edge-on; the strict
    // inequality overlap test already permits flush contact.
    const ob = footprintAabb(other.kind, other.pos, other.rot);
    if (ob && overlaps(ob)) return { ok: false, reason: `overlaps ${other.id}` };
  }
  // …and built vestibule chains (the shared-space honesty this module exists for).
  for (const cb of chainBoxes()) {
    if (overlaps(cb)) return { ok: false, reason: 'a vestibule chain runs through this spot' };
  }
  return { ok: true };
}

// ── Spot search (the DEV spawn / inventory re-place helper) ──────────────────

/**
 * Nearest free exterior pose to `near`: probe points just outside the four
 * walls (plus every stackable face), snap, dedupe, sort by distance, return
 * the first validateExteriorPlacement approves.
 */
export function findFreeExteriorSpot(
  kind: FurnitureKind,
  item: FurnitureItem,
  near: { x: number; z: number },
): ExteriorPose | null {
  const seen = new Set<string>();
  const candidates: Array<ExteriorPose & { d: number }> = [];
  const push = (pose: ExteriorPose) => {
    const key = `${pose.x},${pose.z},${pose.rot},${pose.mountParent ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...pose, d: (pose.x - near.x) ** 2 + (pose.z - near.z) ** 2 });
  };
  for (let t = -5.5; t <= 5.5; t += 0.5) {
    for (const probe of [
      { x: t, z: -7 }, { x: t, z: 7 }, { x: -7, z: t }, { x: 7, z: t },
    ]) {
      push(snapExteriorPos(kind, probe.x, probe.z));
    }
  }
  for (const parent of exteriorItems()) {
    if (canStackOn(kind, parent)) push(stackPoseOn(kind, parent));
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const c of candidates) {
    if (validateExteriorPlacement(item, { x: c.x, z: c.z }, c.rot, c.mountParent).ok) {
      return c;
    }
  }
  return null;
}
