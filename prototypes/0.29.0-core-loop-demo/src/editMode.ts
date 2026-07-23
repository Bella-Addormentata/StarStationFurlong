/**
 * Room-edit mode — E2 of issue #25 (brainstorming/edit-room-mode-plan.md §E2),
 * as AMENDED by issue #33 M2 (brainstorming/device-focus-and-storage-trunk-plan.md
 * §2 M2): there is NO HUD pencil button — the entry point is the EDIT ROOM
 * button inside the wall computer's focused UI (devices.ts
 * createRoomTerminalUI). Pressing it RELEASES the device focus first
 * (deviceFocus.releaseThen), then enters edit mode; exiting edit mode returns
 * to the plain isometric room view.
 *
 * E2 scope — selection/highlight SHELL (E3 adds movement):
 *  - world.setEditMode(true) shows the 1 m platform grid
 *  - raycast hover over MOVABLE furniture groups applies an emissive
 *    highlight tint (originals stored per-material and restored exactly)
 *  - click SELECTS an item (stronger tint + a floating label with the item
 *    id); click elsewhere deselects — and navigation is fully suppressed
 *    (main.ts routes edit-mode clicks here BEFORE the keypad → door → device
 *    passes); WASD stays live (the plan allows walking while editing)
 *  - Esc exits (same e.target guards as the other Esc handlers, deferring to
 *    the phone-open and device-focus owners)
 *  - force-exit on: zoom leaving level 2, the solar map overlay opening, and
 *    morph restart (world.startMorph calls forceExit, mirroring
 *    deviceFocus.forceRelease)
 *
 * E3 scope — click-carry-place (plan §E3 + §4 edge cases):
 *  - clicking the SELECTED movable item picks it up: the group follows the
 *    click-plane raycast point, snapped per the §2.6 parity rule
 *    (snapItemPos); the original obstacle STAYS in OBSTACLES until commit —
 *    no transient walk-through hole
 *  - green/red emissive tint reflects validatePlacement() (bounds → overlap
 *    → player clearance → scratch-grid connectivity), re-checked every frame
 *    (players keep moving under a held item)
 *  - click commits: item.pos/rot update → rebuildObstacles →
 *    rebakeWalkableGrid → rebuildSeats → rebuildDevices (THAT order —
 *    devices bake world-space eye/anchor poses off the walkable grid), then
 *    player.onObstaclesChanged(itemId) replans/cancels in-flight navigation
 *  - Esc / right-click cancels back to the exact origin (position, rotation
 *    and OBSTACLES untouched); R rotates a quarter-turn while carrying
 *  - picking up the item the local player sits on evicts them first via
 *    player.evictFromSeat() (plan §4.2)
 *  - forceExit() cancels a live carry before tearing down (plan §4.5)
 *
 * #53 scope — remove to room inventory:
 *  - with an item SELECTED (and no carry live), a floating ✕ REMOVE button
 *    under the selection label — or the X / Delete key — removes the item:
 *    despawn + deregister (world.removeFurnitureVisuals + FURNITURE splice),
 *    stow its kind in the per-room furniture inventory (roomInventory.ts),
 *    then the exact commit rebake pipeline. The DEV menu's INVENTORY section
 *    re-places stored pieces.
 *  - removal needs NO validity gate: deleting an obstacle only OPENS space —
 *    the walkable set strictly grows, so nothing reachable can become
 *    unreachable (the whole reason commitCarry needs validatePlacement is
 *    that a move also ADDS a box; removal never does).
 *
 * Module singleton — exported as `roomEdit`, with `isEditModeActive()` for
 * the click-routing guard in main.ts (mirrors deviceFocus.ts).
 */

import * as THREE from 'three';
import { FURNITURE, FURNITURE_DEFS, footprintAabb, itemAabb, snapItemPos } from './furniture';
// 🛰️ Hull space (exterior mounts + stacking) — moved out of furniture.ts.
import {
  snapExteriorPos, validateExteriorPlacement, isExteriorPos,
  mountChildrenOf, mountDescendantsOf,
} from './hull';
import type { FurnitureItem, Rot, Box } from './furniture';
import { OBSTACLES, rebuildObstacles } from './obstacles';
import { computeReachable, rebakeWalkableGrid, walkable, GRID_SIZE, worldToCol, worldToRow } from './pathfinding';
import { roomHalfExtents, doorLateralLimitForWall, readDoorDeltas } from './floorPlanDoc';
import { SEATS, rebuildSeats } from './seats';
import { DEVICES, rebuildDevices } from './devices';
import { DOORS } from './doors';
import type { DoorId } from './doors';
import { snapDoorLateral, wallAndLateralFromPoint, poseFromWall } from './doorLayout';
import {
  writeDoorLayout, deleteDoorLayout, readAllDoorLayout, seedDoorLayoutDefaults,
} from './doorLayoutDoc';
import type { DoorWall } from './doorLayoutDoc';
// 🪟 #80 S4: the window editor — placement math (windowLayout) + the synced set.
import {
  snapWindowAlong, clampWindowAlong, clampWindowAcross, windowFitsSurface,
  surfaceCenterWorld, surfaceBasis, autoWindowSize, windowSizeLimits,
  WINDOW_BOX_THICKNESS,
} from './windowLayout';
import {
  writeWindowLayout, deleteWindowLayout, readAllWindowLayout, WINDOW_DEFAULT,
} from './windowLayoutDoc';
import { writeWallpaper, readAllWallpaper } from './wallpaperLayoutDoc';
import {
  WALLPAPER_PRESETS, WALLPAPER_LABELS, type WallpaperPresetId,
} from './wallpaper';
import { SURFACES } from './hullSection';
import type { HullSurface } from './hullSection';
import { PLAYER_R } from './player';
import type { Player } from './player';
import { OUTLINE_MAT } from './voxelCharacter';
import { showHint } from './hud';
import { isDeviceFocusActive } from './deviceFocus';
import { writeFurnitureItem, deleteFurnitureItem } from './furnitureDoc';
import { addToRoomInventory, activeRoomId } from './roomInventory';
import type { World } from './world';

// ── Owner gate (plan §1) ──────────────────────────────────────────────────────

export type RoomEditPermission = { ok: true } | { ok: false; reason: string };

/**
 * The isolated owner predicate. main.ts registers the real check at init —
 * today the plan-§1 permissive roomInfo.owner === 'Local-Clone' fallback;
 * swapping to S2's identity gate (isLocalPlayerRoomOwner) at integration is
 * a one-line change of that registration. Default: permissive (offline =
 * your room).
 */
let ownerPredicate: () => RoomEditPermission = () => ({ ok: true });

export function setRoomEditPermission(predicate: () => RoomEditPermission): void {
  ownerPredicate = predicate;
}

/** May the local player edit this room? (Consumed by the wall-computer UI.) */
export function canEditRoom(): RoomEditPermission {
  return ownerPredicate();
}

/**
 * 🖱️ Context-menu world access: the right-click menu works OUTSIDE edit mode
 * (right-click an item in the plain room view → MOVE / DELETE), so it can't
 * rely on the `world` reference enter() captures. main.ts registers the live
 * world here at init, same idiom as setRoomEditPermission above.
 */
let worldProvider: (() => World | null) | null = null;

export function setEditWorldProvider(provider: () => World | null): void {
  worldProvider = provider;
}

// ── Placement validity (E3 of #25 — pure, reused by E4 remote-apply) ──────────

export interface PlacementContext {
  /** Every player position that must not be squashed (local + remotes). */
  playerPositions: ReadonlyArray<{ x: number; z: number }>;
  /** Connectivity flood-fill origin — the local player's position. */
  floodFrom: { x: number; z: number };
  /**
   * Front points that are CURRENTLY reachable and must stay so (seat fronts,
   * ALL door fronts, device fronts — pre-filtered by the caller against the
   * pre-move grid, excluding the moved item's own fronts, which are rebaked
   * after commit anyway).
   */
  requiredReachable: ReadonlyArray<{ x: number; z: number }>;
}

export type PlacementVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May `item` be placed at (pos, rot)? Checks, in order (plan §E3):
 *  1. footprint within the [−5,5]² walkable bounds
 *  2. no AABB overlap with any OTHER item's current footprint (touching
 *     edges are fine — the trunk sits flush against the hearth by design)
 *  3. no player inside the footprint inflated by PLAYER_R (0.38)
 *  4. stand-point clearance (review F1): no requiredReachable point inside
 *     the footprint inflated by PLAYER_R + the FINE arrival tolerance —
 *     grid reachability alone is NOT standability (the FINE phases drive to
 *     the EXACT point with collision on, so a box edge within PLAYER_R of a
 *     front point wedges every approach even though the point's grid cell
 *     stays clear)
 *  5. connectivity: flood-fill a scratch grid with the moved footprint
 *     applied — every requiredReachable point must stay reachable from the
 *     local player's cell
 *
 * The candidate box derives from the def footprint (footprintAabb), NOT a
 * per-item footprintOverride — a moved item sheds its legacy world-space
 * override on commit. Decorative items (footprint null — rugs, trees, pots)
 * only get the bounds check: they never obstruct, so overlap/connectivity
 * are moot (E5 refines their layering/raycast niceties).
 *
 * Pure: reads FURNITURE for the other items' current boxes, mutates nothing.
 */
export function validatePlacement(
  item: FurnitureItem,
  pos: { x: number; z: number },
  rot: Rot,
  ctx: PlacementContext,
): PlacementVerdict {
  // 🚀 Exterior-wall fittings route to the hull rules: they live OUTSIDE the
  // walkable square, so interior bounds / obstacle overlap / player clearance
  // / connectivity are all moot — nothing walks on the hull. Dual-mode
  // ('both') kinds route by WHERE the candidate pose is.
  const mount = FURNITURE_DEFS[item.kind].mount;
  if (mount === 'exterior-wall' || (mount === 'both' && isExteriorPos(pos))) {
    return validateExteriorPlacement(item, pos, rot);
  }

  const box = footprintAabb(item.kind, pos, rot);

  // Placement box: 1 m inside each wall (walls at ±half). 🧱 #66 R1 — default
  // 2×2 room ⇒ {6,6} ⇒ ±5, the legacy literal.
  const { halfX, halfZ } = roomHalfExtents();
  const bX = halfX - 1, bZ = halfZ - 1;

  // Decorative: bounds-only (position point inside the walkable square).
  if (!box) {
    if (pos.x < -bX || pos.x > bX || pos.z < -bZ || pos.z > bZ) {
      return { ok: false, reason: 'out of bounds' };
    }
    return { ok: true };
  }

  // 1. Bounds.
  if (box.x0 < -bX || box.x1 > bX || box.z0 < -bZ || box.z1 > bZ) {
    return { ok: false, reason: 'out of bounds' };
  }

  // 2. Overlap with every other item's CURRENT footprint.
  for (const other of FURNITURE) {
    if (other.id === item.id) continue;
    const ob = itemAabb(other);
    if (!ob) continue;
    if (box.x0 < ob.x1 && box.x1 > ob.x0 && box.z0 < ob.z1 && box.z1 > ob.z0) {
      return { ok: false, reason: `overlaps ${other.id}` };
    }
  }

  // 3. Player clearance (footprint inflated by the collision radius).
  for (const p of ctx.playerPositions) {
    if (
      p.x > box.x0 - PLAYER_R && p.x < box.x1 + PLAYER_R &&
      p.z > box.z0 - PLAYER_R && p.z < box.z1 + PLAYER_R
    ) {
      return { ok: false, reason: 'a player is in the way' };
    }
  }

  // 4. Stand-point clearance (review F1): the FINE approach phases need to
  //    land within 0.06 of the EXACT front point while resolveObstacles
  //    keeps the player PLAYER_R away from every box — a candidate whose
  //    inflated extent swallows a protected front point is physically
  //    un-standable even when the point's grid cell stays walkable
  //    (concrete pre-fix wedge: armchair at (2.5,4.5) put its edge 0.03 m
  //    from the wall computer's front (1.8,4.97) — edit mode itself became
  //    unreachable, with no way to undo).
  const STAND_R = PLAYER_R + 0.06;
  for (const pt of ctx.requiredReachable) {
    if (
      pt.x > box.x0 - STAND_R && pt.x < box.x1 + STAND_R &&
      pt.z > box.z0 - STAND_R && pt.z < box.z1 + STAND_R
    ) {
      return { ok: false, reason: 'would block a stand-point' };
    }
  }

  // 5. Connectivity on a scratch grid: candidate box + every OTHER item's
  //    current box (the original spot is vacated, the candidate is applied).
  const scratch: Box[] = [box];
  for (const other of FURNITURE) {
    if (other.id === item.id) continue;
    const ob = itemAabb(other);
    if (ob) scratch.push(ob);
  }
  const reachable = computeReachable(scratch, ctx.floodFrom.x, ctx.floodFrom.z);
  for (const pt of ctx.requiredReachable) {
    const row = worldToRow(pt.z);
    const col = worldToCol(pt.x);
    if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE || !reachable[row][col]) {
      return { ok: false, reason: 'would seal off part of the room' };
    }
  }

  return { ok: true };
}

// ── Door placement validity (#28 S6b — the door editor's add/tint gate) ───────

/** Mint a fresh free-door id suffix — crypto.randomUUID with the identity.ts
 *  fallback (unavailable outside secure contexts / on old engines; uniqueness,
 *  not security, is all we need). Callers prefix `d:` to mark a FREE door. */
function mintDoorId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through to the non-crypto shape */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The door OPENING footprint as a world-space AABB — a `w`-wide span along the
 * wall (w = large ? 2 : 1) at the wall coordinate (±half), with a ~1 m deep band
 * INTO the room. Used to test a candidate door against the live furniture
 * footprints (a door can't open into a sofa). #28 S6b.
 */
function doorOpeningAabb(wall: DoorWall, lateral: number, size: 'small' | 'large'): Box {
  const { halfX, halfZ } = roomHalfExtents();
  const w = size === 'large' ? 2 : 1;
  const DEPTH = 1.0; // shallow band into the room from the wall line
  switch (wall) {
    case 'north': // wall at z = -halfZ; band runs +z into the room
      return { x0: lateral - w / 2, x1: lateral + w / 2, z0: -halfZ, z1: -halfZ + DEPTH };
    case 'south': // wall at z = +halfZ; band runs -z into the room
      return { x0: lateral - w / 2, x1: lateral + w / 2, z0: halfZ - DEPTH, z1: halfZ };
    case 'west': // wall at x = -halfX; band runs +x into the room
      return { x0: -halfX, x1: -halfX + DEPTH, z0: lateral - w / 2, z1: lateral + w / 2 };
    case 'east': // wall at x = +halfX; band runs -x into the room
      return { x0: halfX - DEPTH, x1: halfX, z0: lateral - w / 2, z1: lateral + w / 2 };
  }
}

/**
 * Every door's CURRENT opening as {wall, lateral, size} — the set a new/edited
 * door must not overlap on its wall. Free doors own their lateral in the layout
 * record; a cardinal's LIVE centre lateral is its floor-plan slide (readDoorDeltas
 * — the record's `lateral` is only the seed snapshot). Also folds in the 4
 * cardinals that physically exist but aren't in the map yet (an UNSEEDED room,
 * before the editor's seed-first write). #28 S6b.
 */
function currentDoorOpenings(): Array<{ id: string; wall: DoorWall; lateral: number; size: 'small' | 'large' }> {
  const openings: Array<{ id: string; wall: DoorWall; lateral: number; size: 'small' | 'large' }> = [];
  const records = readAllDoorLayout();
  const deltas = readDoorDeltas();
  const seen = new Set<string>();
  for (const rec of records.values()) {
    const isCardinal = rec.id === 'north' || rec.id === 'south' || rec.id === 'east' || rec.id === 'west';
    const lateral = isCardinal ? (deltas[rec.id as DoorId] ?? 0) : rec.lateral;
    openings.push({ id: rec.id, wall: rec.wall, lateral, size: rec.size ?? 'small' });
    seen.add(rec.id);
  }
  for (const id of ['north', 'south', 'east', 'west'] as const) {
    if (seen.has(id)) continue;
    openings.push({
      id, wall: id, lateral: deltas[id] ?? 0,
      size: id === 'east' || id === 'west' ? 'large' : 'small',
    });
  }
  return openings;
}

export type DoorPlacementVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May a door of `size` sit on `wall` at along-wall `lateral`? Checks, in order:
 *  1. within the wall's lateral clamp (doorLateralLimitForWall — off the wall /
 *     too near a corner);
 *  2. its opening footprint clears every live furniture footprint (strict-
 *     inequality AABB overlap — a flush edge is fine, same rule as furniture);
 *  3. its opening clears every OTHER door on the SAME wall (1-D interval gap:
 *     centres must be ≥ (w+w')/2 apart), excluding `excludeId`.
 * Pure; drives both the ADD gate and (future) the red/green editor tint. #28 S6b.
 */
export function validateDoorPlacement(
  wall: DoorWall,
  lateral: number,
  size: 'small' | 'large',
  excludeId?: string,
): DoorPlacementVerdict {
  // 1. On the wall, clear of the corners.
  if (Math.abs(lateral) > doorLateralLimitForWall(wall) + 1e-6) {
    return { ok: false, reason: 'too close to a corner' };
  }

  // 2. No furniture in the opening.
  const box = doorOpeningAabb(wall, lateral, size);
  for (const item of FURNITURE) {
    const ob = itemAabb(item);
    if (!ob) continue;
    if (box.x0 < ob.x1 && box.x1 > ob.x0 && box.z0 < ob.z1 && box.z1 > ob.z0) {
      return { ok: false, reason: `blocked by ${item.id}` };
    }
  }

  // 3. No other door overlapping on the same wall (both openings share the wall
  //    axis, so overlap is a 1-D span test on the along-wall centres).
  const w = size === 'large' ? 2 : 1;
  for (const other of currentDoorOpenings()) {
    if (other.id === excludeId) continue;
    if (other.wall !== wall) continue;
    const ow = other.size === 'large' ? 2 : 1;
    if (Math.abs(other.lateral - lateral) < (w + ow) / 2) {
      return { ok: false, reason: 'overlaps another door' };
    }
  }

  return { ok: true };
}

// ── Window placement validity (#80 S4 — the window editor's add/tint gate) ─────

/** 🪟 #80: windows are holes in the octagon side walls, so the ＋ WINDOW
 *  affordance rides the same octagon flag world.ts reads. Octagon is now the
 *  DEFAULT hull — disable with `?octagon=0` (e.g. to compare the legacy box). */
const OCTAGON_HULL = new URLSearchParams(window.location.search).get('octagon') !== '0';

export type WindowPlacementVerdict = { ok: true } | { ok: false; reason: string };

/** 🪟 #80 S4/resize: metres per resize-key press, and the smallest a window may
 *  shrink to. The manual resize clamps to [MIN, surface limit]. */
const WINDOW_RESIZE_STEP = 0.25;
const WINDOW_MIN_SIZE = 0.5;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Friendly labels for the surface selector chip. */
const SURFACE_LABEL: Record<HullSurface, string> = {
  'wall-neg': 'Wall −',
  'wall-pos': 'Wall +',
  'roof-neg': 'Eave −',
  'roof-pos': 'Eave +',
  ridge: 'Ridge (skylight)',
  'basement-neg': 'Chamfer −',
  'basement-pos': 'Chamfer +',
  floor: 'Floor (pool bottom)',
};

/**
 * May a `w`×`h` window sit on `surface` at (along, across)? A window only needs
 * to clear the OTHER windows on the SAME surface — a 2-D interval-overlap test
 * on their centres (|Δalong| < (w+w')/2 AND |Δacross| < (h+h')/2), since windows
 * can now stack on tall strips. `excludeId` skips the window being edited. The
 * run/edge clamps are applied by the caller before this, and octagonHull clamps
 * again when it cuts the hole. Furniture is irrelevant. Pure; drives both the
 * ADD gate and the ghost's red/green.
 */
export function validateWindowPlacement(
  surface: HullSurface,
  along: number,
  across: number,
  w: number,
  h: number,
  excludeId?: string,
): WindowPlacementVerdict {
  // A window bigger than the strip can't be cut (the hull drops overflowing
  // holes to avoid broken triangulation), so reject it here — the ghost reads
  // red instead of committing a window that would silently fail to render.
  if (!windowFitsSurface(surface, w, h)) {
    return { ok: false, reason: 'too big for this surface' };
  }
  for (const rec of readAllWindowLayout().values()) {
    if (rec.id === excludeId) continue;
    if (rec.surface !== surface) continue;
    if (
      Math.abs(rec.along - along) < (w + rec.w) / 2 &&
      Math.abs(rec.across - across) < (h + rec.h) / 2
    ) {
      return { ok: false, reason: 'overlaps another window' };
    }
  }
  return { ok: true };
}

// ── Highlight tints ───────────────────────────────────────────────────────────

/** Hover: soft gold emissive wash (docking-terminal palette). */
const HOVER_EMISSIVE = 0xd4a84b;
const HOVER_INTENSITY = 0.28;
/** Selected: stronger, brighter gold. */
const SELECT_EMISSIVE = 0xf0c060;
const SELECT_INTENSITY = 0.65;
/** Carrying, current spot valid: green wash. */
const CARRY_VALID_EMISSIVE = 0x35d06a;
const CARRY_VALID_INTENSITY = 0.55;
/** Carrying, current spot invalid: red wash. */
const CARRY_INVALID_EMISSIVE = 0xe03636;
const CARRY_INVALID_INTENSITY = 0.6;

/** A material we can emissive-tint (MeshStandardMaterial and friends). */
type EmissiveMaterial = THREE.Material & { emissive: THREE.Color; emissiveIntensity: number };

function isEmissiveMaterial(mat: THREE.Material): mat is EmissiveMaterial {
  return (mat as Partial<EmissiveMaterial>).emissive instanceof THREE.Color;
}

class RoomEditController {
  private active = false;
  private world: World | null = null;

  /** Raycastable meshes of MOVABLE items AND door groups, rebuilt on enter(). */
  private raycastTargets: THREE.Mesh[] = [];
  /** mesh → owning furniture item id OR door id (see doorIds to disambiguate). */
  private meshToItem: Map<THREE.Object3D, string> = new Map();
  /** id → that item/door's meshes (tint application/removal). */
  private itemMeshes: Map<string, THREE.Mesh[]> = new Map();
  /** 🚪 #28 S6b: the ids in the index that are DOORS (not furniture) — so
   *  select/hover/remove branch to the door path (writeDoorLayout / deleteDoorLayout,
   *  no OBSTACLES/seat/inventory teardown). Rebuilt with the door raycast slice. */
  private doorIds: Set<string> = new Set();
  /** 🚪 #28 S6b: ADD-door sub-mode — the next floor click PLACES a door instead
   *  of selecting. Toggled by the ＋ DOOR button; reset on place / exit. */
  private addDoorMode = false;
  /** 🚪 #28 S6b/ghost: the translucent door PREVIEW that follows the pointer
   *  while add-door is armed — a single reusable box mesh (built on arm, hidden
   *  on disarm, disposed on exit), tinted GREEN(valid)/RED(invalid) exactly like
   *  the furniture carry so doors and furniture feel the same. It is NEVER added
   *  to the raycast index or written to the door doc — pure transient visual. */
  private doorGhost: THREE.Mesh | null = null;
  /** 🚪 #28 S6b/ghost: the ghost's current snapped placement + its last verdict.
   *  The click commit reads THIS (not a fresh recompute) so the door drops
   *  exactly where the preview showed. Null while the ghost is hidden / the
   *  pointer is off the floor plane. */
  private ghostDoor: { wall: DoorWall; lateral: number; verdict: DoorPlacementVerdict } | null = null;

  /** 🪟 #80 S4: the ids in the index that are WINDOWS (not furniture/doors) — so
   *  select/hover/remove branch to the window path (writeWindowLayout /
   *  deleteWindowLayout). Rebuilt with the window raycast slice. */
  private windowIds: Set<string> = new Set();
  /** 🪟 #80 S4: ADD-window sub-mode — the next click PLACES a window on the
   *  ACTIVE surface (windowSurface) instead of selecting. Toggled by ＋ WINDOW. */
  private addWindowMode = false;
  /** 🪟 #80 S4: the hull surface the next window lands on. The pointer positions
   *  the window ON this surface's plane; the SURFACE selector chip cycles it.
   *  Fixed-iso camera (yaw only, no pitch) can't reach the horizontal ridge /
   *  floor by picking geometry, so the surface is chosen explicitly. */
  private windowSurface: HullSurface = 'wall-neg';
  /** 🪟 #80 S4: the translucent green/red window PREVIEW following the pointer
   *  while add-window is armed — one reusable box (built on arm, re-oriented on
   *  surface switch, hidden on disarm, disposed on exit). */
  private windowGhost: THREE.Mesh | null = null;
  /** 🪟 #80 S4: the ghost box's current geometry size, so it only rebuilds when
   *  the size changes (per surface / manual resize). */
  private windowGhostSize = { w: 0, h: 0 };
  /** 🪟 #80 S4/resize: a MANUAL size override for the ghost (null ⇒ auto-fit per
   *  surface). Set by the resize keys while arming; cleared on cycle / disarm /
   *  F. The committed window stores this size. */
  private windowSizeOverride: { w: number; h: number } | null = null;
  /** 🪟 #80 S4: the window ghost's current snapped placement + last verdict; the
   *  click commit reads THIS so the window drops where the preview showed. */
  private ghostWindow:
    | { surface: HullSurface; along: number; across: number; verdict: WindowPlacementVerdict }
    | null = null;

  private hoveredId: string | null = null;
  private selectedId: string | null = null;

  /**
   * Live carry (E3), or null. While non-null the group at `group` follows
   * the pointer (snapped); the registry item and OBSTACLES stay untouched
   * until commit, so cancel is a pure visual restore.
   */
  private carrying: {
    itemId: string;
    item: FurnitureItem;
    group: THREE.Group;
    originPos: { x: number; z: number };
    originRot: Rot;
    /** 🛰️ Stack anchor at pickup — restored on cancel (the snap writes the
     *  CANDIDATE anchor straight onto the item so validate/commit read it). */
    originMountParent: string | undefined;
    candidatePos: { x: number; z: number };
    candidateRot: Rot;
    valid: boolean;
    /** Currently-reachable fronts that must survive the move (fixed for the
     *  whole carry — the pre-move grid can't change while we hold the item). */
    requiredReachable: Array<{ x: number; z: number }>;
    /** Flood origin captured at pickup — the per-frame fallback when the
     *  player's live cell is transiently blocked (mid stand-up slide). */
    floodOrigin: { x: number; z: number };
  } | null = null;

  /**
   * Original emissive state, saved ONCE per material on first tint and
   * restored EXACTLY on clear (dedupe map — several meshes of one item may
   * share a material instance). Furniture materials only ever land here, but
   * the shared rig OUTLINE_MAT is guarded against anyway (#27's lesson).
   */
  private savedEmissive: Map<EmissiveMaterial, { hex: number; intensity: number }> = new Map();

  /** Floating label showing the selected item's id. */
  private labelEl: HTMLDivElement | null = null;
  /** Floating ✕ REMOVE button under the label (#53) — shown while selected. */
  private removeBtnEl: HTMLButtonElement | null = null;
  /** Persistent DONE EDITING button — the always-visible exit affordance
   *  (edit mode previously advertised only a transient "ESC exits" hint, so a
   *  swallowed Esc left the player with no obvious way out). */
  private exitBtnEl: HTMLButtonElement | null = null;
  /** 🚪 #28 S6b: persistent ＋ DOOR button (under DONE EDITING) — toggles the
   *  add-door sub-mode; its border/colour flip to green while armed. */
  private addDoorBtnEl: HTMLButtonElement | null = null;
  /** 🪟 #80 S4: persistent ＋ WINDOW button (under ＋ DOOR) — toggles the
   *  add-window sub-mode; only shown under the octagon-hull preview. */
  private addWindowBtnEl: HTMLButtonElement | null = null;
  /** 🖼️ #80 S6: persistent 🖼 WALLPAPER button (under ＋ WINDOW) — toggles the
   *  wall-covering sub-mode; only shown under the octagon-hull preview. */
  private wallpaperBtnEl: HTMLButtonElement | null = null;
  /** 🖼️ #80 S6: the wall-covering editor is armed (pick a surface + preset —
   *  applies live to the hull). Exclusive with add-door / add-window. */
  private wallpaperMode = false;
  /** The surface being re-skinned (any of the 8 strips). */
  private wallpaperSurface: HullSurface = 'wall-neg';
  /** Whether the 🖼 WALLPAPER button belongs on screen for the current scope
   *  (interior + octagon) — so disarming add-window can restore it. */
  private wallpaperEligible = false;
  private labelAnchor = new THREE.Vector3();
  /** Top of the selected item's bounding box (label anchor height). */
  private selectedTopY = 0;

  /** 🖱️ Right-click context menu (MOVE / DELETE on a movable item). */
  private ctxMenuEl: HTMLDivElement | null = null;
  /** Dismiss listeners live only while the menu is open. */
  private ctxDismissPointer: ((e: PointerEvent) => void) | null = null;
  private ctxDismissKey: ((e: KeyboardEvent) => void) | null = null;
  /** Edit mode was auto-entered by a context-menu action — auto-exit when
   *  that action resolves (drop committed / cancelled / delete done). */
  private autoEntered = false;

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  /** 🪟 #80 S4: scratch for the surface math-plane raycast (reused per move). */
  private windowPlane = new THREE.Plane();
  private windowAnchor = new THREE.Vector3();
  private windowHit = new THREE.Vector3();
  /** Last pointer position (client px) — lets the surface selector re-pose the
   *  ghost immediately on a surface switch, without waiting for a mousemove. */
  private lastPointer = { x: 0, y: 0, has: false };

  constructor() {
    // Esc precedence — same e.target guards as the phone (#31) and
    // device-focus (#33 D0.3) handlers, deferring to both owners:
    //  (1) a focused INPUT/TEXTAREA owns Esc (room-name editor, chat) —
    //      guard on e.target, not document.activeElement (#31's lesson).
    //  (2) phone open → #31's handler owns Esc.
    //  (3) device focus live → deviceFocus's handler owns Esc (can't overlap
    //      with edit mode by construction, but guard anyway).
    //  (4) otherwise Esc exits an active edit mode.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.active) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (document.getElementById('spacephone-container')?.classList.contains('active')) {
        return; // #31 owns Esc while the phone is open
      }
      e.preventDefault();
      // E3: a live carry consumes the first Esc (cancel back to origin);
      // a second Esc then exits edit mode as before.
      if (this.carrying) {
        this.cancelCarry(true);
        return;
      }
      // 🚪 #28 S6b: an armed add-door sub-mode consumes the first Esc too.
      if (this.addDoorMode) {
        this.setAddDoorMode(false);
        return;
      }
      // 🪟 #80 S4: ditto an armed add-window sub-mode.
      if (this.addWindowMode) {
        this.setAddWindowMode(false);
        return;
      }
      // 🖼️ #80 S6: ditto an armed wallpaper sub-mode.
      if (this.wallpaperMode) {
        this.setWallpaperMode(false);
        return;
      }
      this.exit();
    });

    // E3: right-click cancels a live carry (same restore path as Esc).
    // 🖱️ Otherwise, right-click on a movable item — in edit mode OR the plain
    // room view — opens the MOVE / DELETE context menu (owner-gated).
    window.addEventListener('contextmenu', (e) => {
      if (this.active && this.carrying) {
        e.preventDefault();
        this.cancelCarry(true);
        return;
      }
      this.hideContextMenu();
      // Only right-clicks landing on the game canvas, in the plain isometric
      // view (zoom 2, ortho camera — the same preconditions as enter()).
      const canvas = window.gameRenderer?.renderer?.domElement;
      if (!canvas || e.target !== canvas) return;
      // The native context menu is never useful over the game canvas — suppress
      // it for every canvas right-click, including the early-return cases below.
      e.preventDefault();
      const zoomView = (window as unknown as { multiScaleZoom?: { getLevel?: () => number } }).multiScaleZoom;
      const camera = window.gameRenderer?.camera;
      if ((zoomView?.getLevel?.() ?? 2) !== 2 || !(camera instanceof THREE.OrthographicCamera)) return;
      const world = this.world ?? worldProvider?.();
      if (!world) return;
      const hit = this.active
        ? this.pickItemAt(e.clientX, e.clientY)
        : this.pickMovableItemAt(world, e.clientX, e.clientY);
      if (!hit || this.doorIds.has(hit) || this.windowIds.has(hit)) return; // furniture only — doors/windows have their own editors
      const perm = canEditRoom();
      if (!perm.ok) {
        showHint(perm.reason);
        return;
      }
      this.showContextMenu(hit, e.clientX, e.clientY);
    });

    // 🪟 #80 S4: [ / ] cycle the active window surface while add-window is armed.
    window.addEventListener('keydown', (e) => {
      if (!this.active || !this.addWindowMode) return;
      if (e.key !== '[' && e.key !== ']') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      this.cycleWindowSurface(e.key === ']' ? 1 : -1);
    });

    // 🪟 #80 S4/resize: , . resize width · ↑ ↓ resize height · F re-apply auto-fit.
    // Active while ADD-window is armed (resizes the ghost) OR a window is selected
    // (resizes it live). Bare , . only — Shift+, . is the camera-rotation chord.
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const armed = this.addWindowMode;
      const selWin = !!this.selectedId && this.windowIds.has(this.selectedId);
      if (!armed && !selWin) return;
      let dw = 0;
      let dh = 0;
      let auto = false;
      if (e.key === ',' && !e.shiftKey) dw = -WINDOW_RESIZE_STEP;
      else if (e.key === '.' && !e.shiftKey) dw = WINDOW_RESIZE_STEP;
      else if (e.key === 'ArrowUp') dh = WINDOW_RESIZE_STEP;
      else if (e.key === 'ArrowDown') dh = -WINDOW_RESIZE_STEP;
      else if (e.key === 'f' || e.key === 'F') auto = true;
      else return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      if (armed) {
        if (auto) this.resetGhostAuto();
        else this.resizeGhost(dw, dh);
      } else {
        this.resizeSelectedWindow(dw, dh, auto);
      }
    });

    // E3: R rotates the carried item a quarter-turn CCW (cheap on the
    // existing rotXZ machinery — itemAabb/snapItemPos/buildSeatList already
    // understand rot, so this is candidateRot + group.rotation.y + re-snap).
    window.addEventListener('keydown', (e) => {
      if (!this.active || !this.carrying) return;
      if (e.key !== 'r' && e.key !== 'R') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      this.rotateCarry();
    });

    // #53: X / Delete removes the SELECTED item to the room inventory.
    // Not while carrying — a held item must be placed or cancelled first
    // (Esc / right-click own that path), so the origin restore stays a pure
    // visual concern and removal always acts on a committed registry pose.
    window.addEventListener('keydown', (e) => {
      if (!this.active || this.carrying || !this.selectedId) return;
      if (e.key !== 'x' && e.key !== 'X' && e.key !== 'Delete') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      this.removeSelected();
    });
  }

  /** True while edit mode owns canvas clicks (guard in main.ts onCanvasClick). */
  public isEditModeActive(): boolean {
    return this.active;
  }

  /** Currently selected item id, or null (debug/verification handle). */
  public getSelectedId(): string | null {
    return this.selectedId;
  }

  /** Id of the item being carried, or null (debug/verification handle). */
  public getCarriedId(): string | null {
    return this.carrying?.itemId ?? null;
  }

  /** Whether the current carry position is a valid drop (debug/verification). */
  public isCarryValid(): boolean {
    return this.carrying?.valid ?? false;
  }

  /** Current snapped carry candidate pose, or null (debug/verification). */
  public getCarryCandidate(): { x: number; z: number; rot: Rot } | null {
    return this.carrying
      ? { ...this.carrying.candidatePos, rot: this.carrying.candidateRot }
      : null;
  }

  /** 🛰️ Hull scope active: camera pulled back + side walls dropped so the
   *  OUTSIDE of the module is visible and clickable. Same edit machinery. */
  private hullScope = false;
  private savedCameraZoom: number | null = null;

  /**
   * Enter edit mode from the plain isometric room view. Reached via the wall
   * computer's EDIT ROOM / EDIT HULL buttons AFTER the device focus has
   * released (deviceFocus.releaseThen continuation) — so the ortho camera is
   * live. `scope` 'hull' (owner request: "how do I edit the outside?") is the
   * SAME edit mode presented differently: the ortho camera zooms out to
   * frame the hull margin and the side walls hide, so exterior mounts and
   * stacks can be selected, carried and placed like any furniture.
   */
  public enter(world: World, scope: 'interior' | 'hull' = 'interior'): void {
    if (this.active) return;

    const perm = canEditRoom();
    if (!perm.ok) {
      showHint(perm.reason);
      return;
    }

    // Only from the plain isometric view: ortho camera live, zoom level 2
    // (same guard shape as deviceFocus.onArrived).
    const zoomView = (window as unknown as { multiScaleZoom?: { getLevel?: () => number } }).multiScaleZoom;
    const zoomLevel = zoomView?.getLevel?.() ?? 2;
    const camera = window.gameRenderer?.camera;
    if (zoomLevel !== 2 || !(camera instanceof THREE.OrthographicCamera)) {
      return;
    }

    this.world = world;
    this.active = true;
    if (scope === 'hull') {
      this.hullScope = true;
      this.savedCameraZoom = camera.zoom;
      camera.zoom *= 0.52; // frame the room + a hull margin on every side
      camera.updateProjectionMatrix();
      world.setHullEditView(true);
    }
    this.buildRaycastIndex(world);
    window.addEventListener('mousemove', this.onMouseMove);
    world.setEditMode(true);
    this.showExitButton();
    // 🚪 #28 S6b: the ＋ DOOR affordance is interior-scope only (doors live on the
    // room walls, not the hull margin).
    if (scope !== 'hull') this.showAddDoorButton();
    // 🪟 #80 S4: the ＋ WINDOW affordance rides the octagon-hull preview only
    // (windows are holes in the octagon side walls) and is interior-scope.
    if (scope !== 'hull' && OCTAGON_HULL) this.showAddWindowButton();
    // 🖼️ #80 S6: the 🖼 WALLPAPER affordance is octagon-only + interior-scope too.
    if (scope !== 'hull' && OCTAGON_HULL) {
      this.wallpaperEligible = true;
      this.showWallpaperButton();
    }
    showHint(scope === 'hull'
      ? 'HULL EDIT — drag tanks/engines onto the walls or each other · stacks cap at 3 · X removes · DONE EDITING (or ESC) exits'
      : `EDIT MODE — click furniture / a door${OCTAGON_HULL ? ' / a window' : ''} to select · ＋ DOOR${OCTAGON_HULL ? ' / ＋ WINDOW / 🖼 WALLPAPER' : ''} · X removes · DONE EDITING (or ESC) exits`, 4000);
  }

  /** Leave edit mode: restore every tint, hide grid + label, detach hover. */
  public exit(): void {
    if (!this.active) return;
    this.autoEntered = false; // 🖱️ any explicit exit ends a context-menu session
    this.hideContextMenu();
    this.cancelCarry(false); // E3: never exit with an item in hand
    this.setAddDoorMode(false); // 🚪 #28 S6b: drop any armed add-door sub-mode
    this.setAddWindowMode(false); // 🪟 #80 S4: drop any armed add-window sub-mode
    this.setWallpaperMode(false); // 🖼️ #80 S6: drop any armed wallpaper sub-mode
    this.wallpaperEligible = false;
    this.setHovered(null);
    this.setSelected(null);
    this.hideExitButton();
    this.hideAddDoorButton();
    this.hideAddWindowButton();
    this.hideWallpaperButton();
    this.disposeDoorGhost(); // 🚪 #28 S6b/ghost: no leaked preview after the session
    this.disposeWindowGhost(); // 🪟 #80 S4/ghost: ditto the window preview
    window.removeEventListener('mousemove', this.onMouseMove);
    this.setCanvasCursor('');
    // 🛰️ Undo the hull-scope presentation before the world reference drops.
    if (this.hullScope) {
      const camera = window.gameRenderer?.camera;
      if (camera instanceof THREE.OrthographicCamera && this.savedCameraZoom !== null) {
        camera.zoom = this.savedCameraZoom;
        camera.updateProjectionMatrix();
      }
      this.world?.setHullEditView(false);
      this.hullScope = false;
      this.savedCameraZoom = null;
    }
    this.world?.setEditMode(false);
    this.raycastTargets = [];
    this.meshToItem.clear();
    this.itemMeshes.clear();
    this.doorIds.clear();
    this.windowIds.clear();
    this.savedEmissive.clear();
    this.world = null;
    this.active = false;
  }

  /**
   * Instant teardown for external interruptions — morph restart
   * (world.startMorph), zoom leaving level 2, solar map opening. A live
   * carry cancels back to its origin first (plan §4.5 — the original
   * obstacle never left OBSTACLES, so this is a pure visual restore).
   */
  public forceExit(): void {
    this.cancelCarry(false);
    this.exit();
  }

  /**
   * Edit-mode click routing (from main.ts onCanvasClick, BEFORE the keypad →
   * door → device passes). Navigation is suppressed by the caller returning
   * early. Three-way:
   *  - carrying → the click is a COMMIT attempt at the (snapped) click point
   *  - clicking the already-SELECTED movable item → pick it up (E3)
   *  - otherwise → select / deselect (E2 behaviour)
   */
  public handleClick(event: MouseEvent): void {
    if (!this.active) return;

    if (this.carrying) {
      // Ignore clicks landing on HUD/overlay elements — only canvas clicks
      // count as a place attempt (mirrors the hover e.target guard).
      const canvas = window.gameRenderer?.renderer?.domElement;
      if (canvas && event.target !== canvas) return;
      // Track the click point first (a commit without a preceding mousemove —
      // e.g. synthetic clicks — must still place AT the click).
      this.updateCarryFromPointer(event.clientX, event.clientY);
      this.commitCarry();
      return;
    }

    // 🚪 #28 S6b: ADD-door sub-mode consumes the next canvas click to PLACE a
    // door at the (snapped) clicked wall point, instead of selecting.
    if (this.addDoorMode) {
      const canvas = window.gameRenderer?.renderer?.domElement;
      if (canvas && event.target !== canvas) return;
      this.tryPlaceDoorAt(event.clientX, event.clientY);
      return;
    }

    // 🪟 #80 S4: ADD-window sub-mode consumes the next canvas click to PLACE a
    // window at the (snapped) clicked side-wall point, instead of selecting.
    if (this.addWindowMode) {
      const canvas = window.gameRenderer?.renderer?.domElement;
      if (canvas && event.target !== canvas) return;
      this.tryPlaceWindowAt(event.clientX, event.clientY);
      return;
    }

    const hit = this.pickItemAt(event.clientX, event.clientY);
    if (hit && hit === this.selectedId) {
      this.beginCarry(hit);
      return;
    }
    this.setSelected(hit);
    // 🪟 #80 S4/resize: advertise the resize keys when a window is selected.
    if (hit && this.windowIds.has(hit)) {
      showHint('Window selected — , . / ↑ ↓ resize · F auto-fit · X removes', 3000);
    }
  }

  /**
   * Per-frame drive (called from World.update, next to deviceFocus.update):
   * force-exit when the view stops being the plain isometric room (zoom left
   * level 2 / solar map overlay opened) and reproject the selection label.
   */
  public update(): void {
    if (!this.active) return;

    const zoomView = (window as unknown as { multiScaleZoom?: { getLevel?: () => number } }).multiScaleZoom;
    if ((zoomView?.getLevel?.() ?? 2) !== 2) {
      this.forceExit();
      return;
    }
    const mapOverlay = document.getElementById('solarmap-overlay');
    if (mapOverlay && mapOverlay.style.display !== 'none' && mapOverlay.style.display !== '') {
      this.forceExit();
      return;
    }

    // E3: re-validate the carry every frame — the candidate spot is fixed
    // between mousemoves but PLAYERS keep walking (WASD stays live in edit
    // mode, and remotes move on their own), so validity can flip in place.
    if (this.carrying) this.revalidateCarry();

    this.updateLabelPosition();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Index the meshes of every MOVABLE furniture group AND every door group for
   *  raycasting (#28 S6b: doors are hoverable / selectable / removable too). */
  private buildRaycastIndex(world: World): void {
    this.raycastTargets = [];
    this.meshToItem.clear();
    this.itemMeshes.clear();
    this.doorIds.clear();
    this.windowIds.clear();
    for (const item of FURNITURE) {
      if (!item.movable) continue;
      const group = world.furnitureGroups.get(item.id);
      if (!group) continue;
      const meshes: THREE.Mesh[] = [];
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          meshes.push(obj);
          this.meshToItem.set(obj, item.id);
          this.raycastTargets.push(obj);
        }
      });
      this.itemMeshes.set(item.id, meshes);
    }
    this.indexDoorGroups(world);
    this.indexWindowGroups(world);
  }

  /**
   * 🚪 #28 S6b: add every door group's meshes to the raycast index (invisible
   * click box included — it still raycasts). Kept SEPARATE from the furniture
   * loop so onDoorLayoutChanged can rebuild just this slice after an add/remove
   * without disturbing furniture selection. Door ids land in `doorIds` so
   * select/hover/remove branch to the door path.
   */
  private indexDoorGroups(world: World): void {
    const groups = world.dockingSystem?.getDoorGroups();
    if (!groups) return;
    for (const [doorId, group] of groups) {
      const meshes: THREE.Mesh[] = [];
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          meshes.push(obj);
          this.meshToItem.set(obj, doorId);
          this.raycastTargets.push(obj);
        }
      });
      this.itemMeshes.set(doorId, meshes);
      this.doorIds.add(doorId);
    }
  }

  /**
   * 🚪 #28 S6b: rebuild ONLY the door slice of the raycast index from the current
   * door groups, preserving the current selection by id — called by
   * world.reconcileDoorLayout after a local/remote add/remove/rebuild (the door
   * doc observer fires it synchronously). Materials of a REMOVED door were
   * already disposed by syncDoorGroups, so this only drops stale map entries (no
   * tint restore on dead handles); a SURVIVING selected door keeps its
   * saved-emissive entry and gets its select tint re-asserted (its group may
   * have been rebuilt). Unlike the furniture reconcile's forceExit+enter, the
   * selection is NOT dropped on every edit.
   */
  public onDoorLayoutChanged(): void {
    const world = this.world;
    if (!this.active || !world) return;

    // Drop the previous door slice (map entries only — see method doc).
    const doorMeshSet = new Set<THREE.Object3D>();
    for (const id of this.doorIds) {
      const meshes = this.itemMeshes.get(id);
      if (meshes) for (const m of meshes) doorMeshSet.add(m);
      this.itemMeshes.delete(id);
    }
    for (const m of doorMeshSet) this.meshToItem.delete(m);
    this.raycastTargets = this.raycastTargets.filter((m) => !doorMeshSet.has(m));
    this.doorIds.clear();

    // Re-index the current door groups.
    this.indexDoorGroups(world);

    // A hovered/selected DOOR that vanished must let go of its (now disposed)
    // handles; a surviving selected door re-asserts its select tint.
    if (this.hoveredId && !this.isKnownId(this.hoveredId)) this.hoveredId = null;
    if (this.selectedId && !world.furnitureGroups.has(this.selectedId)) {
      if (this.doorIds.has(this.selectedId)) {
        this.applyTint(this.selectedId, SELECT_EMISSIVE, SELECT_INTENSITY);
      } else {
        this.setSelected(null);
      }
    }
  }

  /**
   * 🪟 #80 S4: add every window click-box to the raycast index (the box is
   * invisible until hovered/selected but always raycasts). Kept SEPARATE from
   * the furniture/door loops so onWindowLayoutChanged can rebuild just this
   * slice after an add/remove. Window ids land in `windowIds` so select / hover
   * / remove branch to the window path.
   */
  private indexWindowGroups(world: World): void {
    for (const [windowId, group] of world.getWindowGroups()) {
      const meshes: THREE.Mesh[] = [];
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          meshes.push(obj);
          this.meshToItem.set(obj, windowId);
          this.raycastTargets.push(obj);
        }
      });
      this.itemMeshes.set(windowId, meshes);
      this.windowIds.add(windowId);
    }
  }

  /**
   * 🪟 #80 S4: rebuild ONLY the window slice of the raycast index from the
   * current window boxes — called by world.reconcileWindowLayout after a
   * local/remote add/remove (the window doc observer fires it synchronously).
   * The boxes are rebuilt FRESH (old geometry/material disposed), so this drops
   * the stale slice then re-indexes; a surviving selected window re-asserts its
   * highlight (its box was replaced). Mirrors onDoorLayoutChanged — the
   * selection is NOT dropped on every edit.
   */
  public onWindowLayoutChanged(): void {
    const world = this.world;
    if (!this.active || !world) return;

    // Drop the previous window slice (map entries only — handles already gone).
    const windowMeshSet = new Set<THREE.Object3D>();
    for (const id of this.windowIds) {
      const meshes = this.itemMeshes.get(id);
      if (meshes) for (const m of meshes) windowMeshSet.add(m);
      this.itemMeshes.delete(id);
    }
    for (const m of windowMeshSet) this.meshToItem.delete(m);
    this.raycastTargets = this.raycastTargets.filter((m) => !windowMeshSet.has(m));
    this.windowIds.clear();

    // Re-index the current window boxes.
    this.indexWindowGroups(world);

    // A hovered window that vanished lets go of its (disposed) handle; a
    // surviving hovered window re-asserts its wash (its box was rebuilt fresh /
    // un-washed, and the next setHovered would early-return on the unchanged id).
    if (this.hoveredId && !this.isKnownId(this.hoveredId)) {
      this.hoveredId = null;
    } else if (
      this.hoveredId &&
      this.windowIds.has(this.hoveredId) &&
      this.hoveredId !== this.selectedId
    ) {
      this.applyTint(this.hoveredId, HOVER_EMISSIVE, HOVER_INTENSITY);
    }
    // A surviving selected window re-asserts its highlight, and a selected window
    // that was removed (gone from every index) drops its selection.
    if (this.selectedId && this.windowIds.has(this.selectedId)) {
      this.applyTint(this.selectedId, SELECT_EMISSIVE, SELECT_INTENSITY);
    } else if (
      this.selectedId &&
      !this.isKnownId(this.selectedId) &&
      !world.furnitureGroups.has(this.selectedId)
    ) {
      this.setSelected(null);
    }
  }

  /** True when `id` is an indexed furniture item, door or window. */
  private isKnownId(id: string): boolean {
    return this.itemMeshes.has(id);
  }

  /** The 3D group for a furniture / door / window id (label anchor / bounds). */
  private groupForId(id: string): THREE.Group | undefined {
    return this.world?.furnitureGroups.get(id)
      ?? this.world?.dockingSystem?.getDoorGroups().get(id)
      ?? this.world?.getWindowGroups().get(id);
  }

  /** Raycast the movable-furniture meshes at a screen point → item id | null. */
  private pickItemAt(clientX: number, clientY: number): string | null {
    const camera = window.gameRenderer?.camera;
    if (!camera) return null;
    this.pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
    this.pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    const hits = this.raycaster.intersectObjects(this.raycastTargets, false);
    if (hits.length === 0) return null;
    return this.meshToItem.get(hits[0].object) ?? null;
  }

  /** 🖱️ Ad-hoc raycast for the context menu OUTSIDE edit mode — the persistent
   *  index (buildRaycastIndex) only exists while active, so build a throwaway
   *  one over the movable furniture groups. Cheap: right-clicks are rare. */
  private pickMovableItemAt(world: World, clientX: number, clientY: number): string | null {
    const camera = window.gameRenderer?.camera;
    if (!camera) return null;
    this.pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
    this.pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    const targets: THREE.Mesh[] = [];
    const meshToId = new Map<THREE.Object3D, string>();
    for (const item of FURNITURE) {
      if (!item.movable) continue;
      const group = world.furnitureGroups.get(item.id);
      if (!group) continue;
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          targets.push(obj);
          meshToId.set(obj, item.id);
        }
      });
    }
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    return meshToId.get(hits[0].object) ?? null;
  }

  // ── 🖱️ Right-click context menu (MOVE / DELETE) ────────────────────────────

  private showContextMenu(itemId: string, clientX: number, clientY: number): void {
    this.hideContextMenu();
    const item = FURNITURE.find((i) => i.id === itemId);
    if (!item) return;

    const menu = document.createElement('div');
    menu.id = 'edit-context-menu';
    menu.style.cssText = `
      position:fixed; left:${clientX}px; top:${clientY}px; z-index:10000;
      min-width:150px; padding:6px; border-radius:8px;
      background:rgba(8,10,22,0.94); border:1px solid rgba(212,168,75,0.45);
      box-shadow:0 6px 24px rgba(0,0,0,0.55);
      font-family:monospace; font-size:11px; color:#f0c060;
      user-select:none;`;
    const btn = `display:block; width:100%; text-align:left; margin-top:4px;
      padding:6px 8px; border-radius:6px; cursor:pointer; font:inherit;
      background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); color:#f0c060;`;
    menu.innerHTML = `
      <div style="font-size:9px; letter-spacing:1px; color:rgba(212,168,75,0.55); padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📦 ${item.kind.toUpperCase()}</div>
      <button type="button" data-ctx-action="move" style="${btn}">✥ MOVE</button>
      <button type="button" data-ctx-action="delete" style="${btn} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">🗑 DELETE</button>`;

    // Keep menu clicks OUT of the window-level click routing (onCanvasClick
    // would raycast "through" the menu and deselect / navigate). contextmenu
    // also needs preventDefault or a right-click ON the menu pops the native
    // browser menu over ours.
    for (const type of ['click', 'pointerdown', 'contextmenu'] as const) {
      menu.addEventListener(type, (ev) => {
        ev.stopPropagation();
        if (type === 'contextmenu') ev.preventDefault();
      });
    }
    menu.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-ctx-action]');
      if (!el) return;
      const action = el.dataset.ctxAction;
      this.hideContextMenu();
      // MOVE picks the item up at the ORIGINAL right-click point (closure
      // clientX/clientY) — the button click's own coords are the menu's screen
      // position, and keyboard-activated clicks report (0,0).
      if (action === 'move') this.ctxMove(itemId, clientX, clientY);
      else if (action === 'delete') this.ctxDelete(itemId);
    });
    document.body.appendChild(menu);

    // Clamp inside the viewport once the size is known.
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
    this.ctxMenuEl = menu;

    // Dismiss on any outside pointerdown (capture — before the game reacts)
    // or Esc; both listeners live only while the menu is open.
    this.ctxDismissPointer = (ev: PointerEvent) => {
      if (this.ctxMenuEl && ev.target instanceof Node && this.ctxMenuEl.contains(ev.target)) return;
      this.hideContextMenu();
    };
    this.ctxDismissKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation(); // the menu's Esc must not also exit edit mode
      this.hideContextMenu();
    };
    window.addEventListener('pointerdown', this.ctxDismissPointer, true);
    window.addEventListener('keydown', this.ctxDismissKey, true);
  }

  private hideContextMenu(): void {
    if (this.ctxDismissPointer) {
      window.removeEventListener('pointerdown', this.ctxDismissPointer, true);
      this.ctxDismissPointer = null;
    }
    if (this.ctxDismissKey) {
      window.removeEventListener('keydown', this.ctxDismissKey, true);
      this.ctxDismissKey = null;
    }
    this.ctxMenuEl?.remove();
    this.ctxMenuEl = null;
  }

  /** MOVE from the context menu: enter edit mode if needed, pick the item up,
   *  and snap it to the pointer right away — from there the normal carry flow
   *  owns it (mousemove follows, click commits, Esc/right-click cancels). */
  private ctxMove(itemId: string, clientX: number, clientY: number): void {
    const world = this.world ?? worldProvider?.();
    if (!world) return;
    if (!this.active) {
      this.enter(world);
      if (!this.active) return; // enter()'s own guards refused (hint already shown)
      this.autoEntered = true;
    }
    this.setSelected(itemId);
    this.beginCarry(itemId);
    if (!this.carrying) {
      // beginCarry refused (e.g. cargo mounted on it) — undo an auto-enter.
      if (this.autoEntered) {
        this.autoEntered = false;
        this.exit();
      }
      return;
    }
    this.updateCarryFromPointer(clientX, clientY);
  }

  /** DELETE from the context menu — the exact #53 remove-to-inventory path. */
  private ctxDelete(itemId: string): void {
    const world = this.world ?? worldProvider?.();
    if (!world) return;
    const auto = !this.active;
    if (auto) {
      this.enter(world);
      if (!this.active) return;
    }
    this.setSelected(itemId);
    this.removeSelected();
    if (auto) this.exit();
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active) return;
    // Only hover-test pointer positions actually over the game canvas —
    // moving across HUD panels/overlays must not highlight furniture
    // underneath them.
    const canvas = window.gameRenderer?.renderer?.domElement;
    if (canvas && e.target !== canvas) {
      this.setHovered(null);
      // 🚪 #28 S6b/ghost: a door preview must not linger under a HUD panel —
      // hide it while the pointer is off the canvas.
      if (this.addDoorMode) this.hideDoorGhost();
      // 🪟 #80 S4/ghost: ditto the window preview.
      if (this.addWindowMode) this.hideWindowGhost();
      return;
    }
    // E3: while carrying, the pointer drives the held item, not hover.
    if (this.carrying) {
      this.updateCarryFromPointer(e.clientX, e.clientY);
      return;
    }
    // 🚪 #28 S6b: in ADD-door mode the pointer is arming a placement, not
    // hovering — keep the crosshair, don't tint anything under it, and drive
    // the translucent green/red door ghost (S6b/ghost) that follows the wall.
    if (this.addDoorMode) {
      this.setHovered(null);
      this.setCanvasCursor('crosshair');
      this.updateDoorGhostFromPointer(e.clientX, e.clientY);
      return;
    }
    // 🪟 #80 S4: in ADD-window mode the pointer arms a placement — drive the
    // translucent green/red window ghost that follows the side wall.
    if (this.addWindowMode) {
      this.setHovered(null);
      this.setCanvasCursor('crosshair');
      this.updateWindowGhostFromPointer(e.clientX, e.clientY);
      return;
    }
    this.setHovered(this.pickItemAt(e.clientX, e.clientY));
  };

  // ── Carry machinery (E3 of #25) ─────────────────────────────────────────────

  /** Pick up the (already selected) movable item — enter carry mode. */
  private beginCarry(itemId: string): void {
    const world = this.world;
    if (!world || this.carrying) return;
    const item = FURNITURE.find((i) => i.id === itemId);
    const group = world.furnitureGroups.get(itemId);
    if (!item || !group || !item.movable) return;

    // 🛰️ A stack base can't move with cargo on it — unstack outward-first.
    if (mountChildrenOf(itemId).length > 0) {
      showHint("CAN'T MOVE — something is mounted on it. Remove the outer layers first.", 2600);
      return;
    }

    const player = world.getPlayer();
    // Flood origin BEFORE any eviction: a player seated on the carried item
    // resolves to that seat's front point (where the stand-up slide lands).
    const floodOrigin = this.localFloodOrigin(player);
    // Plan §4.2: picking up the item the local player sits on evicts them
    // first (public stand-up path).
    const seatedId = player.getSeatedSeatId();
    if (seatedId && seatedId.startsWith(`${itemId}:`)) {
      player.evictFromSeat();
    }

    this.carrying = {
      itemId,
      item,
      group,
      originPos: { ...item.pos },
      originRot: item.rot,
      originMountParent: item.mountParent,
      candidatePos: { ...item.pos },
      candidateRot: item.rot,
      valid: true,
      requiredReachable: this.collectRequiredReachable(itemId, floodOrigin),
      floodOrigin,
    };
    this.setHovered(null);
    this.syncRemoveButton(); // #53: no removal mid-carry — hide the button
    this.revalidateCarry(true);
    this.setCanvasCursor('grabbing');
    showHint('CARRYING — click to place · R rotate · ESC cancel', 5000);
  }

  /** Track the click-plane raycast point, snapped to the placement lattice. */
  private updateCarryFromPointer(clientX: number, clientY: number): void {
    const c = this.carrying;
    const camera = window.gameRenderer?.camera;
    const plane = this.world?.getClickPlane();
    if (!c || !camera || !plane) return;
    this.pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
    this.pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    const hits = this.raycaster.intersectObject(plane, false);
    if (hits.length === 0) return;
    // 🚀 Exterior-wall fittings snap to the nearest hull anchor — a wall's
    // OUTER mount line or a stackable item's outer face (🛰️ hull.ts). The
    // rot comes with the anchor — bells always face away. Dual-mode ('both')
    // kinds go exterior only while the pointer is beyond the walls.
    const mount = FURNITURE_DEFS[c.item.kind].mount;
    const px = hits[0].point.x, pz = hits[0].point.z;
    if (mount === 'exterior-wall' || (mount === 'both' && isExteriorPos({ x: px, z: pz }))) {
      const s = snapExteriorPos(c.item.kind, px, pz);
      if (s.x === c.candidatePos.x && s.z === c.candidatePos.z && s.rot === c.candidateRot
        && s.mountParent === c.item.mountParent) return;
      c.candidatePos = { x: s.x, z: s.z };
      c.candidateRot = s.rot;
      // The candidate anchor lives on the item so validate/commit read it;
      // cancelCarry restores originMountParent.
      if (s.mountParent !== undefined) c.item.mountParent = s.mountParent;
      else delete c.item.mountParent;
      c.group.position.set(s.x, 0, s.z);
      c.group.rotation.y = s.rot * (Math.PI / 2);
      this.revalidateCarry();
      return;
    }
    if (mount === 'both' && c.item.mountParent !== undefined) {
      delete c.item.mountParent; // back inside — the anchor is gone
    }
    const snapped = snapItemPos(c.item.kind, c.candidateRot, hits[0].point.x, hits[0].point.z);
    if (snapped.x === c.candidatePos.x && snapped.z === c.candidatePos.z) return;
    c.candidatePos = snapped;
    c.group.position.set(snapped.x, 0, snapped.z);
    this.revalidateCarry(); // immediate tint (update() re-checks per frame too)
  }

  /** R: quarter-turn CCW; parity can swap for non-square footprints → re-snap. */
  private rotateCarry(): void {
    const c = this.carrying;
    if (!c) return;
    // 🚀 Exterior fittings can't rotate freely — the facing IS the anchor's.
    const rotMount = FURNITURE_DEFS[c.item.kind].mount;
    if (rotMount === 'exterior-wall' || (rotMount === 'both' && isExteriorPos(c.candidatePos))) {
      showHint('EXTERIOR MOUNT — faces away from its wall automatically; drag to another wall instead.', 2600);
      return;
    }
    c.candidateRot = ((c.candidateRot + 1) % 4) as Rot;
    c.candidatePos = snapItemPos(c.item.kind, c.candidateRot, c.candidatePos.x, c.candidatePos.z);
    c.group.position.set(c.candidatePos.x, 0, c.candidatePos.z);
    c.group.rotation.y = c.candidateRot * (Math.PI / 2);
    this.revalidateCarry(true);
  }

  /**
   * Commit the carry at the current candidate: registry write-through, then
   * the full rebake pipeline in the order the derivations depend on each
   * other — rebuildObstacles → rebakeWalkableGrid → rebuildSeats →
   * rebuildDevices (seats AND devices bake world-space fronts/poses off the
   * fresh grid — the #33 review's coordination point) — then
   * player.onObstaclesChanged(). Invalid spots reject with a hint and stay
   * in carry mode.
   */
  private commitCarry(): void {
    const c = this.carrying;
    const world = this.world;
    if (!c || !world) return;

    const verdict = this.currentCarryVerdict();
    if (!verdict.ok) {
      c.valid = false;
      this.applyTint(c.itemId, CARRY_INVALID_EMISSIVE, CARRY_INVALID_INTENSITY);
      showHint(`CAN'T PLACE — ${verdict.reason}`, 2200);
      return;
    }

    c.item.pos = { ...c.candidatePos };
    c.item.rot = c.candidateRot;
    // A committed item sheds its E1 world-space footprintOverride: the
    // override encoded the ORIGINAL hand-authored obstacle (e.g. the
    // front-right lamp table's one-tile drift); from here on the derived
    // footprint — which matches the visual, and is what validatePlacement
    // just approved — is the honest obstacle.
    if (c.item.footprintOverride !== undefined) delete c.item.footprintOverride;

    c.group.position.set(c.item.pos.x, 0, c.item.pos.z);
    c.group.rotation.y = c.item.rot * (Math.PI / 2);

    rebuildObstacles();
    rebakeWalkableGrid();
    rebuildSeats();
    rebuildDevices();
    world.getPlayer().onObstaclesChanged(c.itemId);
    world.refreshOutdoorFloor(); // 🏊 pool moved in/out → toggle the outdoor floor

    // E4 (issue #60): publish the new placement AFTER the local commit, so the
    // doc observer's reconcile finds local state already matching (self-echo
    // no-op) while remote peers apply the move.
    writeFurnitureItem(c.item);

    const itemId = c.itemId;
    this.carrying = null;
    // Back to the plain selected state (the item stays selected).
    if (this.selectedId === itemId) {
      this.applyTint(itemId, SELECT_EMISSIVE, SELECT_INTENSITY);
    } else {
      this.clearTint(itemId);
    }
    this.syncRemoveButton(); // #53: selection persists → button returns
    this.setCanvasCursor('');
    showHint('Placed.', 1400);

    // 🖱️ A context-menu MOVE auto-entered edit mode — leave it again now the
    // drop landed (a wall-computer entry keeps the session open as before).
    if (this.autoEntered) {
      this.autoEntered = false;
      this.exit();
    }
  }

  /**
   * Cancel back to the exact origin. The registry item and OBSTACLES were
   * never touched during the carry, so this is a pure visual restore.
   */
  private cancelCarry(announce: boolean): void {
    const c = this.carrying;
    if (!c) return;
    c.group.position.set(c.originPos.x, 0, c.originPos.z);
    c.group.rotation.y = c.originRot * (Math.PI / 2);
    // 🛰️ Restore the stack anchor the snap may have rewritten mid-carry.
    if (c.originMountParent !== undefined) c.item.mountParent = c.originMountParent;
    else delete c.item.mountParent;
    this.carrying = null;
    if (this.selectedId === c.itemId) {
      this.applyTint(c.itemId, SELECT_EMISSIVE, SELECT_INTENSITY);
    } else {
      this.clearTint(c.itemId);
    }
    this.syncRemoveButton(); // #53: selection persists → button returns
    this.setCanvasCursor('');
    if (announce) showHint('Move cancelled.', 1400);

    // 🖱️ USER-cancelled a context-menu MOVE (Esc / right-click) → also leave
    // the auto-entered edit session. announce distinguishes a user cancel
    // from the teardown paths (exit/forceExit call with false — they are
    // already exiting, and exit()'s own cancelCarry(false) must not recurse).
    if (announce && this.autoEntered) {
      this.autoEntered = false;
      this.exit();
    }
  }

  // ── Remove to room inventory (#53) ──────────────────────────────────────────

  /**
   * Remove the SELECTED item from the room and stow its kind in the per-room
   * furniture inventory (roomInventory.ts — the DEV menu's INVENTORY section
   * re-places it via the spawn machinery). Steps, in dependency order:
   *
   *  1. guards — movable only (structurally guaranteed: buildRaycastIndex
   *     only indexes movable items, so the wall computer can never be
   *     SELECTED — but fail closed anyway), no live carry (the X handler
   *     and button visibility already exclude it; re-checked here);
   *  2. a local player seated ON the item stands up first (the same
   *     evictFromSeat idiom as beginCarry, plan §4.2) — the stand-up slide
   *     targets the seat's front point, which stays valid: removal only
   *     OPENS space. (Remote seated players are the E4 observer's problem —
   *     see player.ts's E4 remote-apply hazards note.)
   *  3. selection/hover teardown BEFORE disposal — clearTint (via
   *     setSelected(null)) must restore saved emissive state while the
   *     materials still exist, and the raycast index must drop the meshes so
   *     no hover can touch freed handles;
   *  4. despawn + deregister — world.removeFurnitureVisuals (scene graph,
   *     geometry/material/texture disposal, furnitureMeshes/Lights,
   *     wallScreens/trunkLids/holoSpinners), then the FURNITURE splice;
   *  5. stow the KIND in the room inventory (pos/rot/id are not kept —
   *     re-placing searches for a fresh valid spot and mints a fresh id;
   *     local-only until E4, see roomInventory.ts's honesty note);
   *  6. the exact commit rebake pipeline + onObstaclesChanged(itemId) — the
   *     id argument cancels in-flight approaches to the removed item's seats
   *     and device front (their derived entries just vanished).
   *
   * NO validity check, deliberately: validatePlacement gates moves because a
   * move ADDS a footprint somewhere new; removal only deletes one, the
   * walkable set strictly grows, so every currently-reachable front stays
   * reachable and no player can end up inside an obstacle. A player standing
   * NEXT to the item just gains floor.
   *
   * Removing a device mid-focus is impossible locally: edit mode and device
   * focus are mutually exclusive by construction (EDIT ROOM releases the
   * focus before entering — deviceFocus.releaseThen — and canvas clicks
   * route here before the device pass while active). Dev-asserted below.
   */
  private removeSelected(): void {
    const world = this.world;
    const itemId = this.selectedId;
    if (!world || !itemId || this.carrying) return;

    // 🚪 #28 S6b: a DOOR removal is its own, much shorter path — drop the layout
    // record (the reconcile removes the 3D group + walk target); NO
    // OBSTACLES/seat/inventory teardown, and gated on the door being unpaired.
    if (this.doorIds.has(itemId)) {
      this.removeSelectedDoor(itemId);
      return;
    }

    // 🪟 #80 S4: a WINDOW removal is its own short path — drop the layout record
    // (the reconcile removes the hole + glass + click-box); no OBSTACLES / seat /
    // inventory teardown, and no pairing gate (windows are passive).
    if (this.windowIds.has(itemId)) {
      this.removeSelectedWindow(itemId);
      return;
    }

    const item = FURNITURE.find((i) => i.id === itemId);
    if (!item) return;
    if (!item.movable) {
      showHint("CAN'T REMOVE — fixed room structure.", 2200);
      return;
    }
    if (import.meta.env.DEV && isDeviceFocusActive()) {
      console.error('[editMode] removeSelected during device focus — the edit-mode/device-focus mutual exclusion is broken');
    }

    // 2. Stand up a player sitting on the removed item (seat ids are
    //    `${itemId}:${templateIndex}` — same match as beginCarry).
    const player = world.getPlayer();
    const seatedId = player.getSeatedSeatId();
    if (seatedId && seatedId.startsWith(`${itemId}:`)) {
      player.evictFromSeat();
    }

    // 🛰️ 2b. REMOVAL CASCADES down the hull stack (deepest first): pulling a
    // tank out also removes everything mounted outboard of it — each layer
    // goes to the room inventory like the item itself, no floating orphans.
    const cascade = mountDescendantsOf(itemId);
    for (const child of cascade) {
      if (this.hoveredId === child.id) this.setHovered(null);
      const childMeshes = this.itemMeshes.get(child.id) ?? [];
      for (const mesh of childMeshes) this.meshToItem.delete(mesh);
      this.itemMeshes.delete(child.id);
      const childSet = new Set<THREE.Object3D>(childMeshes);
      this.raycastTargets = this.raycastTargets.filter((m) => !childSet.has(m));
      world.removeFurnitureVisuals(child.id);
      const ci = FURNITURE.findIndex((i) => i.id === child.id);
      if (ci !== -1) FURNITURE.splice(ci, 1);
      addToRoomInventory(activeRoomId(), child.kind);
      deleteFurnitureItem(child.id);
    }

    // 3. Selection/hover teardown while the materials still exist.
    this.setSelected(null); // restores tint, hides label + button
    if (this.hoveredId === itemId) this.setHovered(null);
    const meshes = this.itemMeshes.get(itemId) ?? [];
    for (const mesh of meshes) this.meshToItem.delete(mesh);
    this.itemMeshes.delete(itemId);
    const meshSet = new Set<THREE.Object3D>(meshes);
    this.raycastTargets = this.raycastTargets.filter((m) => !meshSet.has(m));

    // 4. Despawn visuals + deregister world handles, then the registry.
    world.removeFurnitureVisuals(itemId);
    const idx = FURNITURE.findIndex((i) => i.id === itemId);
    if (idx !== -1) FURNITURE.splice(idx, 1);

    // 5. Stow in the per-room furniture inventory.
    addToRoomInventory(activeRoomId(), item.kind);

    // 6. The exact commit rebake pipeline (commitCarry's order — seats AND
    //    devices bake world-space fronts/poses off the fresh grid).
    rebuildObstacles();
    rebakeWalkableGrid();
    rebuildSeats();
    rebuildDevices();
    player.onObstaclesChanged(itemId);
    world.refreshOutdoorFloor(); // 🏊 pool removed → restore the outdoor floor (no void)
    // 🤖 A removed charging-dock must dispose its robot NOW — the local
    // removal self-echoes as an empty doc diff, so the observer's
    // reconcileRobots never runs on THIS client (the exact mirror of the
    // commitSpawn dock fix in devMenu.ts; remote peers reconcile normally).
    if (item.kind === 'charging-dock' || cascade.some((c) => c.kind === 'charging-dock')) {
      world.refreshRobots();
    }

    // E4 (issue #60): drop it from the shared layout AFTER the local removal,
    // so the doc observer's reconcile sees local state already matching (a
    // self-echo no-op) while remote peers apply the removal.
    deleteFurnitureItem(itemId);

    showHint(`Removed ${itemId}${cascade.length ? ` +${cascade.length} mounted layer${cascade.length === 1 ? '' : 's'}` : ''} → room inventory (DEV menu › INVENTORY re-places it).`, 3200);
  }

  // ── Door add / remove (#28 S6b — the door editor MVP) ───────────────────────

  /**
   * Remove the SELECTED door from the shared layout. Gated: a PAIRED door can't
   * be removed ("unpair first" — the same rule the slide code enforces, so #62
   * chain math never re-solves around a vanished door). Otherwise: restore its
   * tint + drop it from the index while its materials still exist, then
   * seedDoorLayoutDefaults() (idempotent — SEED-FIRST is critical: reconcile
   * removes any group not in the map, so a delete against an UNSEEDED room would
   * wipe all 4 cardinals) and deleteDoorLayout(). The doc observer's reconcile
   * then removes the 3D group + walk target and calls onDoorLayoutChanged.
   */
  private removeSelectedDoor(doorId: string): void {
    const world = this.world;
    if (!world) return;
    if (world.dockingSystem?.isDoorPaired(doorId)) {
      showHint('Unpair this door first (open its keypad), then remove it.', 2800);
      return;
    }

    // Selection/hover teardown BEFORE the delete disposes the door's materials
    // (setSelected(null) → clearTint restores saved emissive on live handles).
    this.setSelected(null);
    if (this.hoveredId === doorId) this.setHovered(null);
    const meshes = this.itemMeshes.get(doorId) ?? [];
    for (const mesh of meshes) this.meshToItem.delete(mesh);
    this.itemMeshes.delete(doorId);
    const meshSet = new Set<THREE.Object3D>(meshes);
    this.raycastTargets = this.raycastTargets.filter((m) => !meshSet.has(m));
    this.doorIds.delete(doorId);

    // Publish the removal (seed-first — see method doc). The reconcile fired by
    // deleteDoorLayout also re-runs onDoorLayoutChanged, a harmless no-op now.
    seedDoorLayoutDefaults();
    deleteDoorLayout(doorId);
    showHint(`Removed door ${doorId}.`, 2000);
  }

  /**
   * Commit the ADD-door sub-mode at the GHOST's current spot. The green/red
   * ghost (S6b/ghost) already did the raycast → wall → snap → clamp → validate
   * every mousemove and stashed it in `ghostDoor`; a click just re-derives that
   * from the pointer (so a synthetic click with no preceding mousemove still
   * commits AT the pointer — mirrors commitCarry's updateCarryFromPointer-first
   * pattern) and drops the door. On success: seedDoorLayoutDefaults() (SEED-FIRST
   * — see removeSelectedDoor) then writeDoorLayout with a fresh `d:`-prefixed free
   * id, and leave add-mode (which hides the ghost). On failure: hint the reason
   * and STAY armed, keeping the (red) ghost so the owner can nudge to a clearer
   * spot.
   */
  private tryPlaceDoorAt(clientX: number, clientY: number): void {
    // Re-derive the ghost pose at the click point (see method doc), then commit
    // from the stashed snapped wall/lateral so the door lands where it showed.
    this.updateDoorGhostFromPointer(clientX, clientY);
    const ghost = this.ghostDoor;
    if (!ghost) return; // pointer wasn't over the floor plane — nothing to place
    if (!ghost.verdict.ok) {
      showHint(`CAN'T ADD DOOR — ${ghost.verdict.reason}`, 2400);
      return; // stay armed so the owner can nudge to a clearer spot
    }

    seedDoorLayoutDefaults();
    writeDoorLayout({
      id: `d:${mintDoorId()}`,
      wall: ghost.wall,
      lateral: ghost.lateral,
      size: 'small',
      enabled: true,
    });
    this.setAddDoorMode(false); // hides the ghost (existing exit-add behaviour)
    showHint(`Door added on the ${ghost.wall} wall.`, 2000);
  }

  // ── Door ghost preview (#28 S6b/ghost — furniture-like green/red follow) ─────

  /**
   * Lazily build (once) the reusable translucent door ghost and parent it to
   * the SAME group the real door groups + click plane live in — platformGroup,
   * reached via the click plane's parent so no new world API is needed (door
   * groups, furniture groups and the click plane are all children of it, and
   * its origin is the world origin, so poseFromWall's x/z map straight through).
   *
   * The box is sized like the small-door OPENING (1.4 w × 3.0 h, docking.ts
   * buildDoorGroup) with a shallow depth, and its geometry is shifted DOWN 0.5 m
   * so the mesh ORIGIN coincides with the real door group's origin (that group
   * sits at world y=2 with its floor at local y=−2, i.e. opening centre at local
   * y=−0.5). Positioning the ghost at (pose.x, 2, pose.z) — exactly like the
   * door group — then drops it into the opening. MeshBasicMaterial (transparent,
   * unlit) coloured with the furniture carry's exact valid/invalid hexes, so the
   * preview reads the same as a carried piece. Returns null only if the world /
   * click plane isn't ready (never, while add-door is armed).
   */
  private ensureDoorGhost(): THREE.Mesh | null {
    if (this.doorGhost) return this.doorGhost;
    const parent = this.world?.getClickPlane()?.parent;
    if (!parent) return null;
    const geo = new THREE.BoxGeometry(1.4, 3.0, 0.5);
    geo.translate(0, -0.5, 0); // mesh origin → door-group origin (world y=2)
    const mat = new THREE.MeshBasicMaterial({
      color: CARRY_VALID_EMISSIVE, // furniture carry's green; flipped red on invalid
      transparent: true,
      opacity: 0.4,
      depthWrite: false, // a wash, not an occluder — don't z-fight the wall
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 3; // draw over the wall so the tint reads through
    parent.add(mesh);
    this.doorGhost = mesh;
    return mesh;
  }

  /**
   * Follow the pointer while add-door is armed: raycast the click plane → nearest
   * wall + along-wall lateral (wallAndLateralFromPoint) → snap to the parity grid
   * (snapDoorLateral) → clamp to the wall's corner-clear limit → pose the ghost
   * (poseFromWall) → validate (validateDoorPlacement) and tint green/red. Cheap
   * enough to run per mousemove — it reuses the one ghost mesh (no geometry
   * rebuild) and validateDoorPlacement is pure. Off the plane → hide the ghost.
   * Stashes {wall, lateral, verdict} in `ghostDoor` for the click commit.
   */
  private updateDoorGhostFromPointer(clientX: number, clientY: number): void {
    const world = this.world;
    const camera = window.gameRenderer?.camera;
    const plane = world?.getClickPlane();
    if (!world || !camera || !plane) return;
    const ghost = this.ensureDoorGhost();
    if (!ghost) return;
    this.pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
    this.pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    const hits = this.raycaster.intersectObject(plane, false);
    if (hits.length === 0) { this.hideDoorGhost(); return; }

    const { wall, lateral } = wallAndLateralFromPoint(hits[0].point.x, hits[0].point.z);
    const snapped = snapDoorLateral('small', lateral);
    const limit = doorLateralLimitForWall(wall);
    const clamped = Math.max(-limit, Math.min(limit, snapped));
    const pose = poseFromWall(wall, clamped);
    ghost.position.set(pose.x, 2, pose.z); // world y=2 — matches the door group
    ghost.rotation.y = pose.frameYaw;
    ghost.visible = true;

    const verdict = validateDoorPlacement(wall, clamped, 'small');
    this.setDoorGhostColor(verdict.ok);
    this.ghostDoor = { wall, lateral: clamped, verdict };
  }

  /** Flip the ghost between the furniture carry's exact green (valid) and red
   *  (invalid) hexes. */
  private setDoorGhostColor(valid: boolean): void {
    const mat = this.doorGhost?.material as THREE.MeshBasicMaterial | undefined;
    if (mat) mat.color.setHex(valid ? CARRY_VALID_EMISSIVE : CARRY_INVALID_EMISSIVE);
  }

  /** Hide the reusable ghost (disarm / off-plane) — instance kept for re-arm. */
  private hideDoorGhost(): void {
    if (this.doorGhost) this.doorGhost.visible = false;
    this.ghostDoor = null;
  }

  /** Fully tear down the ghost (leaving edit mode): unparent + dispose the
   *  one-off geometry/material so nothing leaks after the session. */
  private disposeDoorGhost(): void {
    if (this.doorGhost) {
      this.doorGhost.parent?.remove(this.doorGhost);
      this.doorGhost.geometry.dispose();
      (this.doorGhost.material as THREE.Material).dispose();
      this.doorGhost = null;
    }
    this.ghostDoor = null;
  }

  // ── Window add / remove (#80 S4 — the window editor MVP) ────────────────────

  /**
   * 🪟 #80 S4: remove the SELECTED window from the shared layout. No pairing gate
   * (windows are passive holes, unlike doors) and no seed-first hazard (windows
   * have no defaults — an empty map means no windows). Restore its highlight +
   * drop it from the index while its box still exists, then deleteWindowLayout();
   * the doc observer's reconcile rebuilds the hull (hole + glass gone) + the
   * click-boxes and re-runs onWindowLayoutChanged.
   */
  private removeSelectedWindow(windowId: string): void {
    const world = this.world;
    if (!world) return;

    // Teardown BEFORE the delete disposes the box's material (setSelected(null)
    // → clearTint hides the live box).
    this.setSelected(null);
    if (this.hoveredId === windowId) this.setHovered(null);
    const meshes = this.itemMeshes.get(windowId) ?? [];
    for (const mesh of meshes) this.meshToItem.delete(mesh);
    this.itemMeshes.delete(windowId);
    const meshSet = new Set<THREE.Object3D>(meshes);
    this.raycastTargets = this.raycastTargets.filter((m) => !meshSet.has(m));
    this.windowIds.delete(windowId);

    deleteWindowLayout(windowId);
    showHint(`Removed window ${windowId}.`, 2000);
  }

  /**
   * 🪟 #80 S4: commit the ADD-window sub-mode at the GHOST's current spot. Like
   * tryPlaceDoorAt, a click re-derives the ghost from the pointer (so a synthetic
   * click with no preceding mousemove still commits AT the pointer) then writes
   * the record. On success: writeWindowLayout with a fresh `w:`-prefixed id at the
   * default size, and leave add-mode (hides the ghost). On failure: hint + STAY
   * armed, keeping the red ghost so the owner can nudge to a clearer spot.
   */
  private tryPlaceWindowAt(clientX: number, clientY: number): void {
    this.updateWindowGhostFromPointer(clientX, clientY);
    const ghost = this.ghostWindow;
    if (!ghost) return; // pointer wasn't over the surface plane
    if (!ghost.verdict.ok) {
      showHint(`CAN'T ADD WINDOW — ${ghost.verdict.reason}`, 2400);
      return; // stay armed so the owner can nudge to a clearer spot
    }

    const size = this.ghostSize(); // manual override, else roof auto-fit
    writeWindowLayout({
      id: `w:${mintDoorId()}`, // a plain uuid; the `w:` marks a window record
      surface: ghost.surface,
      along: ghost.along,
      across: ghost.across,
      w: size.w,
      h: size.h,
      r: WINDOW_DEFAULT.r,
      enabled: true,
    });
    this.setAddWindowMode(false); // hides the ghost
    showHint(`Window added on ${SURFACE_LABEL[ghost.surface]} — look outside.`, 2200);
  }

  // ── Window ghost preview (#80 S4/ghost — furniture-like green/red follow) ────

  /**
   * Lazily build (once) the reusable translucent window ghost, parented to the
   * SAME group the hull + click plane live in (platformGroup, via the click
   * plane's parent — world-origin frame, so surfaceCenterWorld maps straight
   * through). A default-sized box, coloured with the furniture carry's
   * valid/invalid hexes; ORIENTED to the active surface each frame.
   */
  private ensureWindowGhost(): THREE.Mesh | null {
    if (this.windowGhost) return this.windowGhost;
    const parent = this.world?.getClickPlane()?.parent;
    if (!parent) return null;
    // local x=w along uDir, y=h along vDir, z=thickness along the surface normal
    const size = this.ghostSize();
    const geo = new THREE.BoxGeometry(size.w, size.h, WINDOW_BOX_THICKNESS);
    this.windowGhostSize = { ...size };
    const mat = new THREE.MeshBasicMaterial({
      color: CARRY_VALID_EMISSIVE, // green; flipped red on invalid
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 3; // draw over the wall/glass so the tint reads through
    parent.add(mesh);
    this.windowGhost = mesh;
    return mesh;
  }

  /** Orient the ghost box to the ACTIVE surface's world frame (surfaceBasis). */
  private orientWindowGhost(): void {
    const ghost = this.windowGhost;
    if (!ghost) return;
    const { uDir, vDir, normal } = surfaceBasis(this.windowSurface);
    ghost.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(uDir, vDir, normal));
  }

  /** The ghost/placement size: a manual override, else the surface's auto-fit. */
  private ghostSize(): { w: number; h: number } {
    return this.windowSizeOverride ?? autoWindowSize(this.windowSurface);
  }

  /** Rebuild the ghost box geometry when its size changes (surface auto-fit or a
   *  manual resize). Roof panels auto-fit, so the ghost grows/shrinks per surface. */
  private resizeWindowGhost(): void {
    const ghost = this.windowGhost;
    if (!ghost) return;
    const size = this.ghostSize();
    if (size.w === this.windowGhostSize.w && size.h === this.windowGhostSize.h) return;
    ghost.geometry.dispose();
    ghost.geometry = new THREE.BoxGeometry(size.w, size.h, WINDOW_BOX_THICKNESS);
    this.windowGhostSize = { ...size };
  }

  // ── Manual resize (#80 S4/resize — keys ,/. width · ↑/↓ height · F auto-fit) ──

  /** Adjust the ARMED ghost's manual size by (dw, dh), clamped to the surface's
   *  limits, then re-pose. Sets windowSizeOverride so the committed window keeps it. */
  private resizeGhost(dw: number, dh: number): void {
    const base = this.ghostSize();
    const lim = windowSizeLimits(this.windowSurface);
    const w = clampNum(base.w + dw, WINDOW_MIN_SIZE, lim.maxW);
    const h = clampNum(base.h + dh, WINDOW_MIN_SIZE, lim.maxH);
    this.windowSizeOverride = { w, h };
    this.resizeWindowGhost();
    if (this.lastPointer.has) this.updateWindowGhostFromPointer(this.lastPointer.x, this.lastPointer.y);
    else this.orientWindowGhost();
    showHint(`Window ${w.toFixed(2)} × ${h.toFixed(2)} m · , . width · ↑ ↓ height · F auto-fit`, 1800);
  }

  /** F while arming: drop the override → back to the surface's auto-fit size. */
  private resetGhostAuto(): void {
    this.windowSizeOverride = null;
    this.resizeWindowGhost();
    if (this.lastPointer.has) this.updateWindowGhostFromPointer(this.lastPointer.x, this.lastPointer.y);
    else this.orientWindowGhost();
    const s = this.ghostSize();
    showHint(`Auto-fit ${s.w.toFixed(2)} × ${s.h.toFixed(2)} m`, 1500);
  }

  /**
   * Resize the SELECTED window by (dw, dh) — or re-apply auto-fit when `auto`.
   * Updates the record's w/h (clamped to the surface) and re-clamps its
   * along/across so a grown opening stays inside the strip, then writeWindowLayout
   * → the reconcile re-renders the hull + click-box live (selection persists).
   */
  private resizeSelectedWindow(dw: number, dh: number, auto: boolean): void {
    const id = this.selectedId;
    if (!id || !this.windowIds.has(id)) return;
    const rec = readAllWindowLayout().get(id);
    if (!rec) return;
    let w: number;
    let h: number;
    if (auto) {
      ({ w, h } = autoWindowSize(rec.surface));
    } else {
      const lim = windowSizeLimits(rec.surface);
      w = clampNum(rec.w + dw, WINDOW_MIN_SIZE, lim.maxW);
      h = clampNum(rec.h + dh, WINDOW_MIN_SIZE, lim.maxH);
    }
    const along = clampWindowAlong(rec.along, w);
    const across = clampWindowAcross(rec.surface, rec.across, h);
    // Gate the resize the SAME way as placement: a grown window must still clear
    // the other windows AND the doors on its wall (else '.' could grow it over a
    // door / neighbour). On reject, keep the current size + hint the reason.
    const verdict = validateWindowPlacement(rec.surface, along, across, w, h, id);
    if (!verdict.ok) {
      showHint(`Can't resize — ${verdict.reason}.`, 1800);
      return;
    }
    if (this.world && !this.world.windowClearsDoors(rec.surface, along, w)) {
      showHint("Can't resize — would overlap a door.", 1800);
      return;
    }
    writeWindowLayout({ ...rec, w, h, along, across });
    showHint(`Window ${w.toFixed(2)} × ${h.toFixed(2)} m${auto ? ' (auto-fit)' : ''}`, 1600);
  }

  /**
   * Follow the pointer while add-window is armed: intersect the pointer ray with
   * the ACTIVE surface's MATH PLANE (a plane raycast reaches every surface —
   * incl. the horizontal ridge / floor — regardless of occlusion, which a
   * geometry raycast can't under the fixed-iso, yaw-only camera). Decompose the
   * hit into (along, across) via the surface basis, snap to the 1 m lattice,
   * clamp, pose + orient the ghost, validate, tint green/red. Off the plane →
   * hide. Stashes {surface, along, across, verdict} for the click commit.
   */
  private updateWindowGhostFromPointer(clientX: number, clientY: number): void {
    const world = this.world;
    const camera = window.gameRenderer?.camera;
    if (!world || !camera) return;
    const ghost = this.ensureWindowGhost();
    if (!ghost) return;
    this.lastPointer = { x: clientX, y: clientY, has: true };
    this.pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
    this.pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, camera);

    const surface = this.windowSurface;
    const size = this.ghostSize(); // manual override, else roof auto-fit
    this.resizeWindowGhost();
    const { uDir, vDir, normal } = surfaceBasis(surface);
    const a = surfaceCenterWorld(surface, 0, 0);
    const anchor = this.windowAnchor.set(a.x, a.y, a.z);
    const plane = this.windowPlane.setFromNormalAndCoplanarPoint(normal, anchor);
    const hit = this.raycaster.ray.intersectPlane(plane, this.windowHit);
    if (!hit) { this.hideWindowGhost(); return; } // ray parallel to the surface

    const rel = hit.sub(anchor); // hit is windowHit; mutate in place
    const along = clampWindowAlong(snapWindowAlong(rel.dot(uDir)), size.w);
    const across = clampWindowAcross(surface, snapWindowAlong(rel.dot(vDir)), size.h);
    const c = surfaceCenterWorld(surface, along, across);
    ghost.position.set(c.x, c.y, c.z);
    this.orientWindowGhost();
    ghost.visible = true;

    let verdict = validateWindowPlacement(surface, along, across, size.w, size.h);
    // 🚪 A window on a side wall must clear the doors on that wall (checked
    // against the ACTUAL door groups, so it's right even for odd door layouts).
    if (verdict.ok && this.world && !this.world.windowClearsDoors(surface, along, size.w)) {
      verdict = { ok: false, reason: 'overlaps a door' };
    }
    this.setWindowGhostColor(verdict.ok);
    this.ghostWindow = { surface, along, across, verdict };
  }

  /** Flip the ghost between the furniture carry's green (valid) / red (invalid). */
  private setWindowGhostColor(valid: boolean): void {
    const mat = this.windowGhost?.material as THREE.MeshBasicMaterial | undefined;
    if (mat) mat.color.setHex(valid ? CARRY_VALID_EMISSIVE : CARRY_INVALID_EMISSIVE);
  }

  /** Hide the reusable ghost (disarm / off-plane) — instance kept for re-arm. */
  private hideWindowGhost(): void {
    if (this.windowGhost) this.windowGhost.visible = false;
    this.ghostWindow = null;
  }

  /** Fully tear down the window ghost (leaving edit mode). */
  private disposeWindowGhost(): void {
    if (this.windowGhost) {
      this.windowGhost.parent?.remove(this.windowGhost);
      this.windowGhost.geometry.dispose();
      (this.windowGhost.material as THREE.Material).dispose();
      this.windowGhost = null;
    }
    this.ghostWindow = null;
  }

  /**
   * 🪟 #80 S4: a window's only per-id mesh is its (normally hidden) click-box, so
   * highlight it by flipping that box's own translucent material on/off with the
   * hover/select colour — the window analogue of a door's emissive tint.
   * `intensity` doubles as the wash opacity (HOVER 0.28 / SELECT 0.65 read well);
   * 0 clears it back to hidden. Routed here from applyTint/clearTint by windowId.
   */
  private setWindowBoxTint(id: string, hex: number, intensity: number): void {
    const group = this.world?.getWindowGroups().get(id);
    if (!group) return;
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshBasicMaterial;
      if (intensity <= 0) {
        m.visible = false;
        m.opacity = 0;
        return;
      }
      m.color.setHex(hex);
      m.opacity = Math.min(0.6, intensity);
      m.visible = true;
    });
  }

  /** Validate the current candidate against live player positions. */
  private currentCarryVerdict(): PlacementVerdict {
    const c = this.carrying;
    const world = this.world;
    if (!c || !world) return { ok: false, reason: 'no carry in progress' };
    const player = world.getPlayer();
    const local = player.getPosition();

    // Per-frame flood origin: the player's live cell, unless it is blocked
    // in the CURRENT grid (transient — mid stand-up slide), then the origin
    // captured at pickup.
    let floodFrom = this.localFloodOrigin(player);
    const row = worldToRow(floodFrom.z);
    const col = worldToCol(floodFrom.x);
    if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE || !walkable[row][col]) {
      floodFrom = c.floodOrigin;
    }

    return validatePlacement(c.item, c.candidatePos, c.candidateRot, {
      playerPositions: [
        { x: local.x, z: local.z },
        ...world.getRemotePlayerPositions(),
      ],
      floodFrom,
      requiredReachable: c.requiredReachable,
    });
  }

  /** Re-check validity; retint green/red only when the verdict flips. */
  private revalidateCarry(forceTint = false): void {
    const c = this.carrying;
    if (!c) return;
    const ok = this.currentCarryVerdict().ok;
    if (ok !== c.valid || forceTint) {
      c.valid = ok;
      this.applyTint(
        c.itemId,
        ok ? CARRY_VALID_EMISSIVE : CARRY_INVALID_EMISSIVE,
        ok ? CARRY_VALID_INTENSITY : CARRY_INVALID_INTENSITY,
      );
    }
  }

  /**
   * The local player's connectivity origin: their position — or, while
   * seated (the sit point is INSIDE a footprint, so its cell is blocked),
   * the occupied seat's front point.
   */
  private localFloodOrigin(player: Player): { x: number; z: number } {
    const seatedId = player.getSeatedSeatId();
    if (seatedId) {
      const seat = SEATS.find((s) => s.id === seatedId);
      if (seat) return { x: seat.front.x, z: seat.front.z };
    }
    const pos = player.getPosition();
    return { x: pos.x, z: pos.z };
  }

  /**
   * Snapshot the front points that are currently reachable from the flood
   * origin — the set a valid drop must preserve (plan §E3): every seat
   * front, every door front (ALL four — review F3: pairing is dynamic, so a
   * mid-carry pairing can enable a door whose front was just sealed; door
   * hardware is fixed, protecting the lot costs nothing), and every device
   * front (a deliberate small extension over the plan's seats+doors list:
   * sealing the wall computer would lock the owner out of edit mode
   * itself). The MOVED item's
   * own fronts are excluded — they are rebaked at its new position after
   * commit. Fixed for the whole carry: the pre-move grid cannot change while
   * the item is held (its original obstacle never leaves OBSTACLES).
   */
  private collectRequiredReachable(
    itemId: string,
    origin: { x: number; z: number },
  ): Array<{ x: number; z: number }> {
    const reachable = computeReachable(OBSTACLES, origin.x, origin.z);
    const isReachable = (p: { x: number; z: number }): boolean => {
      const row = worldToRow(p.z);
      const col = worldToCol(p.x);
      return row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE && reachable[row][col];
    };
    const pts: Array<{ x: number; z: number }> = [];
    for (const seat of SEATS) {
      if (seat.id.startsWith(`${itemId}:`)) continue;
      if (isReachable(seat.front)) pts.push({ x: seat.front.x, z: seat.front.z });
    }
    for (const door of DOORS) {
      if (isReachable(door.front)) pts.push({ x: door.front.x, z: door.front.z });
    }
    for (const device of DEVICES) {
      if (device.id === itemId) continue;
      if (isReachable(device.front)) pts.push({ x: device.front.x, z: device.front.z });
    }
    return pts;
  }

  private setHovered(itemId: string | null): void {
    if (itemId === this.hoveredId) return;
    // Clear the old hover tint (unless that item is selected — the selected
    // tint owns it).
    if (this.hoveredId && this.hoveredId !== this.selectedId) {
      this.clearTint(this.hoveredId);
    }
    this.hoveredId = itemId;
    if (this.hoveredId && this.hoveredId !== this.selectedId) {
      this.applyTint(this.hoveredId, HOVER_EMISSIVE, HOVER_INTENSITY);
    }
    this.setCanvasCursor(this.hoveredId ? 'pointer' : '');
  }

  private setSelected(itemId: string | null): void {
    if (itemId === this.selectedId) return;
    if (this.selectedId) {
      this.clearTint(this.selectedId);
      // The pointer may still be over the previously selected item — let the
      // next mousemove re-derive its hover tint rather than guessing here.
      if (this.hoveredId === this.selectedId) this.hoveredId = null;
    }
    this.selectedId = itemId;
    if (this.selectedId) {
      // Selected tint replaces any hover tint on the same item.
      this.clearTint(this.selectedId);
      if (this.hoveredId === this.selectedId) this.hoveredId = null;
      this.applyTint(this.selectedId, SELECT_EMISSIVE, SELECT_INTENSITY);
      this.showLabel(this.selectedId);
    } else {
      this.hideLabel();
    }
    this.syncRemoveButton();
  }

  /**
   * Apply an emissive tint to every tintable material of an item. Originals
   * are saved once per material (dedupe via the savedEmissive map keys);
   * non-emissive materials (MeshBasicMaterial rug/strip layers) are skipped,
   * as is the shared rig OUTLINE_MAT — furniture groups never contain it,
   * but guard anyway (#27's shared-material lesson).
   */
  private applyTint(itemId: string, emissive: number, intensity: number): void {
    // 🪟 #80 S4: windows have no emissive mesh — highlight their click-box wash.
    if (this.windowIds.has(itemId)) { this.setWindowBoxTint(itemId, emissive, intensity); return; }
    const meshes = this.itemMeshes.get(itemId);
    if (!meshes) return;
    const touched = new Set<THREE.Material>();
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.Material;
      if (!mat || mat === (OUTLINE_MAT as THREE.Material) || touched.has(mat)) continue;
      touched.add(mat);
      if (!isEmissiveMaterial(mat)) continue;
      if (!this.savedEmissive.has(mat)) {
        this.savedEmissive.set(mat, {
          hex: mat.emissive.getHex(),
          intensity: mat.emissiveIntensity,
        });
      }
      mat.emissive.setHex(emissive);
      mat.emissiveIntensity = intensity;
    }
  }

  /** Restore the exact saved emissive state of every material of an item. */
  private clearTint(itemId: string): void {
    // 🪟 #80 S4: a window's highlight lives on its click-box — hide it again.
    if (this.windowIds.has(itemId)) { this.setWindowBoxTint(itemId, 0, 0); return; }
    const meshes = this.itemMeshes.get(itemId);
    if (!meshes) return;
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.Material;
      if (!mat || !isEmissiveMaterial(mat)) continue;
      const saved = this.savedEmissive.get(mat);
      if (!saved) continue;
      mat.emissive.setHex(saved.hex);
      mat.emissiveIntensity = saved.intensity;
      this.savedEmissive.delete(mat);
    }
  }

  private showLabel(itemId: string): void {
    if (!this.labelEl) {
      this.labelEl = document.createElement('div');
      this.labelEl.id = 'room-edit-label';
      // Docking-terminal palette; fixed + reprojected every frame in update().
      this.labelEl.style.cssText = `
        position: fixed;
        transform: translate(-50%, -130%);
        padding: 3px 10px;
        background: rgba(4, 8, 22, 0.92);
        border: 1px solid rgba(240, 192, 96, 0.55);
        border-radius: 6px;
        color: #f0c060;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 11px;
        letter-spacing: 0.5px;
        white-space: nowrap;
        z-index: 4600;
        pointer-events: none;
      `;
      document.body.appendChild(this.labelEl);
    }
    this.labelEl.textContent = itemId;
    this.labelEl.style.display = 'block';

    const group = this.groupForId(itemId);
    this.selectedTopY = group
      ? new THREE.Box3().setFromObject(group).max.y
      : 1.0;
    this.updateLabelPosition();
  }

  private hideLabel(): void {
    if (this.labelEl) this.labelEl.style.display = 'none';
  }

  /**
   * Show the floating ✕ REMOVE button iff an item is SELECTED and no carry
   * is live (#53). The movable guard is structural — buildRaycastIndex only
   * indexes movable items, so a selected item is movable by construction
   * (the wall computer can never be selected, hence never shows the button)
   * — but re-checked so a future selectable-but-fixed item fails closed
   * (hidden), matching the "button hidden, not disabled" rule.
   */
  private syncRemoveButton(): void {
    // 🚪 #28 S6b / 🪟 #80 S4: a selected DOOR or WINDOW shows the REMOVE button
    // too (movable furniture OR any door OR any window — the selectable classes).
    const isDoor = this.selectedId ? this.doorIds.has(this.selectedId) : false;
    const isWindow = this.selectedId ? this.windowIds.has(this.selectedId) : false;
    const item = this.selectedId ? FURNITURE.find((i) => i.id === this.selectedId) : undefined;
    const show = this.active && !this.carrying && (isDoor || isWindow || (!!item && item.movable));
    if (!this.removeBtnEl) {
      if (!show) return;
      this.removeBtnEl = document.createElement('button');
      this.removeBtnEl.id = 'room-edit-remove-btn';
      this.removeBtnEl.type = 'button';
      this.removeBtnEl.textContent = '✕ REMOVE';
      this.removeBtnEl.title = 'Remove to room inventory (X / Delete)';
      // Label palette shifted to the carry-invalid red; sits UNDER the label
      // (label transform is -130%, this one +35% off the same anchor).
      this.removeBtnEl.style.cssText = `
        position: fixed;
        transform: translate(-50%, 35%);
        padding: 3px 10px;
        background: rgba(22, 4, 8, 0.92);
        border: 1px solid rgba(224, 84, 84, 0.65);
        border-radius: 6px;
        color: #e05454;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 1px;
        white-space: nowrap;
        z-index: 4600;
        cursor: pointer;
      `;
      // stopPropagation: a button click must never bubble to the window
      // click routing and double as a canvas click (same input-capture rule
      // as the device UIs and the DEV panel).
      this.removeBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLButtonElement).blur();
        this.removeSelected();
      });
      document.body.appendChild(this.removeBtnEl);
    }
    this.removeBtnEl.style.display = show ? 'block' : 'none';
    if (show) this.updateLabelPosition();
  }

  /**
   * The persistent, always-visible EXIT affordance (top-centre) for the whole
   * edit session. Clicking it calls exit() DIRECTLY — bypassing the keydown
   * Esc handler and its guards — and blurs itself first so any input that had
   * stolen focus (which would also have been swallowing the Esc key and the
   * +/- zoom keys) is released as we leave. stopPropagation keeps the click
   * off the window canvas-click routing (same rule as the REMOVE button).
   */
  private showExitButton(): void {
    if (!this.exitBtnEl) {
      this.exitBtnEl = document.createElement('button');
      this.exitBtnEl.id = 'room-edit-exit-btn';
      this.exitBtnEl.type = 'button';
      this.exitBtnEl.textContent = '✓ DONE EDITING';
      this.exitBtnEl.title = 'Leave edit mode (or press Esc)';
      this.exitBtnEl.style.cssText = `
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 20px;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(240, 192, 96, 0.75);
        border-radius: 8px;
        color: #f0c060;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 1px;
        white-space: nowrap;
        z-index: 4700;
        cursor: pointer;
      `;
      this.exitBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLButtonElement).blur();
        // Mirror the Esc two-stage semantics: a click WHILE carrying cancels the
        // move back to origin first; the next click then leaves edit mode.
        if (this.carrying) { this.cancelCarry(true); return; }
        this.exit();
      });
      document.body.appendChild(this.exitBtnEl);
    }
    this.exitBtnEl.style.display = 'block';
  }

  private hideExitButton(): void {
    if (this.exitBtnEl) this.exitBtnEl.style.display = 'none';
  }

  /**
   * 🚪 #28 S6b: the persistent ＋ DOOR button (under DONE EDITING). Toggles the
   * add-door sub-mode; while armed its border/colour flip to green and the label
   * reads ✕ CANCEL DOOR. stopPropagation keeps the click off the window
   * canvas-click routing (same rule as the REMOVE / DONE EDITING buttons).
   */
  private showAddDoorButton(): void {
    if (!this.addDoorBtnEl) {
      this.addDoorBtnEl = document.createElement('button');
      this.addDoorBtnEl.id = 'room-edit-add-door-btn';
      this.addDoorBtnEl.type = 'button';
      this.addDoorBtnEl.title = 'Add a door — then click a wall to place it';
      this.addDoorBtnEl.style.cssText = `
        position: fixed;
        top: 56px;
        left: 50%;
        transform: translateX(-50%);
        padding: 6px 18px;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(240, 192, 96, 0.7);
        border-radius: 8px;
        color: #f0c060;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 1px;
        white-space: nowrap;
        z-index: 4700;
        cursor: pointer;
      `;
      this.addDoorBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLButtonElement).blur();
        this.setAddDoorMode(!this.addDoorMode);
      });
      document.body.appendChild(this.addDoorBtnEl);
    }
    this.addDoorBtnEl.style.display = 'block';
    this.syncAddDoorButton();
  }

  private hideAddDoorButton(): void {
    if (this.addDoorBtnEl) this.addDoorBtnEl.style.display = 'none';
  }

  /** Reflect the armed/idle add-door state onto the ＋ DOOR button. */
  private syncAddDoorButton(): void {
    const btn = this.addDoorBtnEl;
    if (!btn) return;
    if (this.addDoorMode) {
      btn.textContent = '✕ CANCEL DOOR';
      btn.style.color = '#35d06a';
      btn.style.borderColor = 'rgba(53, 208, 106, 0.85)';
    } else {
      btn.textContent = '＋ DOOR';
      btn.style.color = '#f0c060';
      btn.style.borderColor = 'rgba(240, 192, 96, 0.7)';
    }
  }

  /**
   * 🚪 #28 S6b: arm / disarm the add-door sub-mode. Arming clears any selection
   * (the next click PLACES, it doesn't select) and shows the how-to hint;
   * disarming restores the pointer cursor.
   */
  private setAddDoorMode(on: boolean): void {
    if (this.addDoorMode === on) {
      this.syncAddDoorButton();
      return;
    }
    this.addDoorMode = on;
    if (on) {
      this.setAddWindowMode(false); // 🪟 the add/wallpaper sub-modes are exclusive
      this.setWallpaperMode(false); // 🖼️ #80 S6
      this.setSelected(null);
      this.setHovered(null);
      this.setCanvasCursor('crosshair');
      // 🚪 #28 S6b/ghost: build the reusable preview now (invisible until the
      // first pointer move positions it on a wall).
      this.ensureDoorGhost();
      showHint('ADD DOOR — move to a wall (green = ok, red = blocked) · click to place · ＋/✕ to cancel', 3500);
    } else {
      this.setCanvasCursor('');
      // 🚪 #28 S6b/ghost: drop the preview when disarming (kept for re-arm).
      this.hideDoorGhost();
    }
    this.syncAddDoorButton();
  }

  // ── ＋ WINDOW button + add-window sub-mode (#80 S4) ──────────────────────────

  /**
   * 🪟 #80 S4: the persistent ＋ WINDOW button (under ＋ DOOR). Toggles the
   * add-window sub-mode; while armed its border/colour flip to green and the
   * label reads ✕ CANCEL WINDOW. Only shown under the octagon-hull preview.
   */
  private showAddWindowButton(): void {
    if (!this.addWindowBtnEl) {
      this.addWindowBtnEl = document.createElement('button');
      this.addWindowBtnEl.id = 'room-edit-add-window-btn';
      this.addWindowBtnEl.type = 'button';
      this.addWindowBtnEl.title = 'Add a window — then click a side wall to place it';
      this.addWindowBtnEl.style.cssText = `
        position: fixed;
        top: 92px;
        left: 50%;
        transform: translateX(-50%);
        padding: 6px 18px;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(155, 212, 232, 0.7);
        border-radius: 8px;
        color: #9bd4e8;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 1px;
        white-space: nowrap;
        z-index: 4700;
        cursor: pointer;
      `;
      this.addWindowBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLButtonElement).blur();
        this.setAddWindowMode(!this.addWindowMode);
      });
      document.body.appendChild(this.addWindowBtnEl);
    }
    this.addWindowBtnEl.style.display = 'block';
    this.syncAddWindowButton();
  }

  private hideAddWindowButton(): void {
    if (this.addWindowBtnEl) this.addWindowBtnEl.style.display = 'none';
  }

  /** Reflect the armed/idle add-window state onto the ＋ WINDOW button. */
  private syncAddWindowButton(): void {
    const btn = this.addWindowBtnEl;
    if (!btn) return;
    if (this.addWindowMode) {
      btn.textContent = '✕ CANCEL WINDOW';
      btn.style.color = '#35d06a';
      btn.style.borderColor = 'rgba(53, 208, 106, 0.85)';
    } else {
      btn.textContent = '＋ WINDOW';
      btn.style.color = '#9bd4e8';
      btn.style.borderColor = 'rgba(155, 212, 232, 0.7)';
    }
  }

  /**
   * 🪟 #80 S4: arm / disarm the add-window sub-mode. Arming disarms add-door (the
   * two are exclusive), clears any selection (the next click PLACES) and shows
   * the how-to hint; disarming restores the pointer cursor + hides the ghost.
   */
  private setAddWindowMode(on: boolean): void {
    if (this.addWindowMode === on) {
      this.syncAddWindowButton();
      return;
    }
    this.addWindowMode = on;
    if (on) {
      this.setAddDoorMode(false); // 🚪 the add/wallpaper sub-modes are exclusive
      this.setWallpaperMode(false); // 🖼️ #80 S6
      // The window surface selector sits where the 🖼 WALLPAPER button lives —
      // hide the button while armed so they don't overlap (restored on disarm).
      this.hideWallpaperButton();
      this.setSelected(null);
      this.setHovered(null);
      this.setCanvasCursor('crosshair');
      this.ensureWindowGhost();
      this.resizeWindowGhost(); // match the active surface's auto-fit size
      this.orientWindowGhost();
      this.showWindowSurfaceSelector();
      showHint('ADD WINDOW — ◀ ▶ (or [ ]) surface · , . / ↑ ↓ resize · F auto-fit · move to aim · click to place · ＋/✕ cancel', 4600);
    } else {
      this.setCanvasCursor('');
      this.hideWindowGhost();
      this.hideWindowSurfaceSelector();
      if (this.wallpaperEligible) this.showWallpaperButton(); // restore the 🖼 row
      this.windowSizeOverride = null; // next arm starts at the surface auto-fit
      // Drop the stale pointer sample so a re-arm + surface-cycle before the
      // next mousemove doesn't re-pose the ghost to an old screen point.
      this.lastPointer.has = false;
    }
    this.syncAddWindowButton();
  }

  // ── Window SURFACE selector (#80 S4 — reach all 8 strips) ───────────────────

  /** The floating ◀ [surface] ▶ chip shown while add-window is armed. */
  private windowSurfaceEl: HTMLDivElement | null = null;

  private showWindowSurfaceSelector(): void {
    if (!this.windowSurfaceEl) {
      const bar = document.createElement('div');
      bar.id = 'room-edit-window-surface';
      bar.style.cssText = `
        position: fixed;
        top: 128px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(155, 212, 232, 0.6);
        border-radius: 8px;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.5px;
        color: #9bd4e8;
        z-index: 4700;
        white-space: nowrap;
      `;
      const mkArrow = (txt: string, delta: number): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = txt;
        b.style.cssText = `
          background: rgba(155, 212, 232, 0.14);
          border: 1px solid rgba(155, 212, 232, 0.5);
          border-radius: 5px;
          color: #9bd4e8;
          font: inherit;
          padding: 2px 8px;
          cursor: pointer;
        `;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          (e.currentTarget as HTMLButtonElement).blur();
          this.cycleWindowSurface(delta);
        });
        return b;
      };
      const label = document.createElement('span');
      label.id = 'room-edit-window-surface-label';
      label.style.cssText = 'min-width: 120px; text-align: center;';
      bar.appendChild(mkArrow('◀', -1));
      bar.appendChild(label);
      bar.appendChild(mkArrow('▶', 1));
      document.body.appendChild(bar);
      this.windowSurfaceEl = bar;
    }
    this.windowSurfaceEl.style.display = 'flex';
    this.syncWindowSurfaceSelector();
  }

  private hideWindowSurfaceSelector(): void {
    if (this.windowSurfaceEl) this.windowSurfaceEl.style.display = 'none';
  }

  private syncWindowSurfaceSelector(): void {
    const label = document.getElementById('room-edit-window-surface-label');
    if (label) label.textContent = SURFACE_LABEL[this.windowSurface];
  }

  /**
   * Cycle the active window surface by `delta` (wraps). Re-orients the ghost and
   * re-poses it at the last pointer position (so the preview jumps to the new
   * surface immediately, no mousemove needed).
   */
  private cycleWindowSurface(delta: number): void {
    const i = SURFACES.indexOf(this.windowSurface);
    this.windowSurface = SURFACES[(i + delta + SURFACES.length) % SURFACES.length];
    this.windowSizeOverride = null; // each surface starts at its auto-fit size
    this.syncWindowSurfaceSelector();
    this.resizeWindowGhost(); // roof panels auto-fit → the ghost grows/shrinks
    this.orientWindowGhost();
    if (this.lastPointer.has) {
      this.updateWindowGhostFromPointer(this.lastPointer.x, this.lastPointer.y);
    }
  }

  // ── 🖼 WALLPAPER button + wall-covering sub-mode (#80 S6) ────────────────────

  /**
   * 🖼️ #80 S6: the persistent 🖼 WALLPAPER button (under ＋ WINDOW). Toggles the
   * wall-covering sub-mode; while armed its border/colour flip to green and the
   * label reads ✕ CANCEL WALLPAPER. Octagon-only + interior-scope.
   */
  private showWallpaperButton(): void {
    if (!this.wallpaperBtnEl) {
      this.wallpaperBtnEl = document.createElement('button');
      this.wallpaperBtnEl.id = 'room-edit-wallpaper-btn';
      this.wallpaperBtnEl.type = 'button';
      this.wallpaperBtnEl.title = 'Re-skin a hull wall — pick a surface + covering';
      this.wallpaperBtnEl.style.cssText = `
        position: fixed;
        top: 128px;
        left: 50%;
        transform: translateX(-50%);
        padding: 6px 18px;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(201, 163, 255, 0.7);
        border-radius: 8px;
        color: #c9a3ff;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 1px;
        white-space: nowrap;
        z-index: 4700;
        cursor: pointer;
      `;
      this.wallpaperBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLButtonElement).blur();
        this.setWallpaperMode(!this.wallpaperMode);
      });
      document.body.appendChild(this.wallpaperBtnEl);
    }
    this.wallpaperBtnEl.style.display = 'block';
    this.syncWallpaperButton();
  }

  private hideWallpaperButton(): void {
    if (this.wallpaperBtnEl) this.wallpaperBtnEl.style.display = 'none';
  }

  /** Reflect the armed/idle wallpaper state onto the 🖼 WALLPAPER button. */
  private syncWallpaperButton(): void {
    const btn = this.wallpaperBtnEl;
    if (!btn) return;
    if (this.wallpaperMode) {
      btn.textContent = '✕ CANCEL WALLPAPER';
      btn.style.color = '#35d06a';
      btn.style.borderColor = 'rgba(53, 208, 106, 0.85)';
    } else {
      btn.textContent = '🖼 WALLPAPER';
      btn.style.color = '#c9a3ff';
      btn.style.borderColor = 'rgba(201, 163, 255, 0.7)';
    }
  }

  /**
   * 🖼️ #80 S6: arm / disarm the wallpaper sub-mode. Arming disarms add-door /
   * add-window (all exclusive), clears any selection and shows the surface +
   * covering panel; a covering applies LIVE (writeWallpaper → the hull rebuilds
   * via world.reconcileWallpaper). Disarming just hides the panel.
   */
  private setWallpaperMode(on: boolean): void {
    if (this.wallpaperMode === on) {
      this.syncWallpaperButton();
      return;
    }
    this.wallpaperMode = on;
    if (on) {
      this.setAddDoorMode(false);
      this.setAddWindowMode(false);
      this.setSelected(null);
      this.setHovered(null);
      this.showWallpaperPanel();
      showHint('WALLPAPER — ◀ ▶ pick a surface + covering · applies live · 🖼/✕ to cancel', 4200);
    } else {
      this.hideWallpaperPanel();
    }
    this.syncWallpaperButton();
  }

  /** The floating two-row panel (Surface / Covering) shown while armed. */
  private wallpaperPanelEl: HTMLDivElement | null = null;

  private showWallpaperPanel(): void {
    if (!this.wallpaperPanelEl) {
      const panel = document.createElement('div');
      panel.id = 'room-edit-wallpaper-panel';
      panel.style.cssText = `
        position: fixed;
        top: 164px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 6px 8px;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(201, 163, 255, 0.6);
        border-radius: 8px;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.5px;
        color: #c9a3ff;
        z-index: 4700;
        white-space: nowrap;
      `;
      const mkRow = (
        tag: string,
        labelId: string,
        onArrow: (delta: number) => void,
      ): HTMLDivElement => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 8px;';
        const mkArrow = (txt: string, delta: number): HTMLButtonElement => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = txt;
          b.style.cssText = `
            background: rgba(201, 163, 255, 0.14);
            border: 1px solid rgba(201, 163, 255, 0.5);
            border-radius: 5px;
            color: #c9a3ff;
            font: inherit;
            padding: 2px 8px;
            cursor: pointer;
          `;
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            (e.currentTarget as HTMLButtonElement).blur();
            onArrow(delta);
          });
          return b;
        };
        const tagEl = document.createElement('span');
        tagEl.textContent = tag;
        tagEl.style.cssText = 'min-width: 62px; opacity: 0.75;';
        const label = document.createElement('span');
        label.id = labelId;
        label.style.cssText = 'min-width: 120px; text-align: center;';
        row.appendChild(tagEl);
        row.appendChild(mkArrow('◀', -1));
        row.appendChild(label);
        row.appendChild(mkArrow('▶', 1));
        return row;
      };
      panel.appendChild(
        mkRow('Surface', 'room-edit-wp-surface', (d) => this.cycleWallpaperSurface(d)),
      );
      panel.appendChild(
        mkRow('Covering', 'room-edit-wp-preset', (d) => this.cycleWallpaperPreset(d)),
      );
      document.body.appendChild(panel);
      this.wallpaperPanelEl = panel;
    }
    this.wallpaperPanelEl.style.display = 'flex';
    this.syncWallpaperPanel();
  }

  private hideWallpaperPanel(): void {
    if (this.wallpaperPanelEl) this.wallpaperPanelEl.style.display = 'none';
  }

  /** The covering currently painted on the active surface (`plain` if none). */
  private currentWallpaperPreset(): WallpaperPresetId {
    return readAllWallpaper().get(this.wallpaperSurface) ?? 'plain';
  }

  private syncWallpaperPanel(): void {
    const surfLabel = document.getElementById('room-edit-wp-surface');
    if (surfLabel) surfLabel.textContent = SURFACE_LABEL[this.wallpaperSurface];
    const presetLabel = document.getElementById('room-edit-wp-preset');
    if (presetLabel) presetLabel.textContent = WALLPAPER_LABELS[this.currentWallpaperPreset()];
  }

  /** Cycle which surface we're re-skinning (wraps); reloads its covering label. */
  private cycleWallpaperSurface(delta: number): void {
    const i = SURFACES.indexOf(this.wallpaperSurface);
    this.wallpaperSurface = SURFACES[(i + delta + SURFACES.length) % SURFACES.length];
    this.syncWallpaperPanel();
  }

  /** Cycle the active surface's covering (wraps) and APPLY it live to the hull. */
  private cycleWallpaperPreset(delta: number): void {
    const cur = this.currentWallpaperPreset();
    const i = WALLPAPER_PRESETS.indexOf(cur);
    const next = WALLPAPER_PRESETS[(i + delta + WALLPAPER_PRESETS.length) % WALLPAPER_PRESETS.length];
    writeWallpaper(this.wallpaperSurface, next); // → world.reconcileWallpaper rebuilds
    this.syncWallpaperPanel();
  }

  /** Reproject the label (above) + REMOVE button (below) every frame. */
  private updateLabelPosition(): void {
    if (!this.labelEl || !this.selectedId || this.labelEl.style.display === 'none') return;
    const group = this.groupForId(this.selectedId);
    const camera = window.gameRenderer?.camera;
    if (!group || !camera) return;
    this.labelAnchor.set(group.position.x, this.selectedTopY + 0.12, group.position.z);
    this.labelAnchor.project(camera);
    const left = `${((this.labelAnchor.x + 1) / 2) * window.innerWidth}px`;
    const top = `${((1 - this.labelAnchor.y) / 2) * window.innerHeight}px`;
    this.labelEl.style.left = left;
    this.labelEl.style.top = top;
    if (this.removeBtnEl && this.removeBtnEl.style.display !== 'none') {
      this.removeBtnEl.style.left = left;
      this.removeBtnEl.style.top = top;
    }
  }

  private setCanvasCursor(cursor: string): void {
    const canvas = window.gameRenderer?.renderer?.domElement;
    if (canvas) canvas.style.cursor = cursor;
  }
}

/** Module singleton (mirrors deviceFocus). */
export const roomEdit = new RoomEditController();

/** Click-routing guard for main.ts onCanvasClick. */
export function isEditModeActive(): boolean {
  return roomEdit.isEditModeActive();
}

// Permanent debug handle (kept deliberately — used for runtime verification
// of the edit-mode shell from the console; mirrors __deviceFocus).
(window as unknown as { __roomEdit: RoomEditController }).__roomEdit = roomEdit;
