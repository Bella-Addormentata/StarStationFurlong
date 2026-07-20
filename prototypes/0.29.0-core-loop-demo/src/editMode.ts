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
import { roomHalfExtents } from './floorPlanDoc';
import { SEATS, rebuildSeats } from './seats';
import { DEVICES, rebuildDevices } from './devices';
import { DOORS } from './doors';
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

  /** Raycastable meshes of MOVABLE items only, rebuilt on every enter(). */
  private raycastTargets: THREE.Mesh[] = [];
  /** mesh → owning furniture item id (movable items only). */
  private meshToItem: Map<THREE.Object3D, string> = new Map();
  /** item id → that item's meshes (tint application/removal). */
  private itemMeshes: Map<string, THREE.Mesh[]> = new Map();

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
  private labelAnchor = new THREE.Vector3();
  /** Top of the selected item's bounding box (label anchor height). */
  private selectedTopY = 0;

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();

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
      this.exit();
    });

    // E3: right-click cancels a live carry (same restore path as Esc).
    window.addEventListener('contextmenu', (e) => {
      if (!this.active || !this.carrying) return;
      e.preventDefault();
      this.cancelCarry(true);
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
    showHint(scope === 'hull'
      ? 'HULL EDIT — drag tanks/engines onto the walls or each other · stacks cap at 3 · X removes · DONE EDITING (or ESC) exits'
      : 'EDIT MODE — click furniture to select · X removes · DONE EDITING (or ESC) exits', 4000);
  }

  /** Leave edit mode: restore every tint, hide grid + label, detach hover. */
  public exit(): void {
    if (!this.active) return;
    this.cancelCarry(false); // E3: never exit with an item in hand
    this.setHovered(null);
    this.setSelected(null);
    this.hideExitButton();
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

    const hit = this.pickItemAt(event.clientX, event.clientY);
    if (hit && hit === this.selectedId) {
      this.beginCarry(hit);
      return;
    }
    this.setSelected(hit);
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

  /** Index the meshes of every MOVABLE furniture group for raycasting. */
  private buildRaycastIndex(world: World): void {
    this.raycastTargets = [];
    this.meshToItem.clear();
    this.itemMeshes.clear();
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

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active) return;
    // Only hover-test pointer positions actually over the game canvas —
    // moving across HUD panels/overlays must not highlight furniture
    // underneath them.
    const canvas = window.gameRenderer?.renderer?.domElement;
    if (canvas && e.target !== canvas) {
      this.setHovered(null);
      return;
    }
    // E3: while carrying, the pointer drives the held item, not hover.
    if (this.carrying) {
      this.updateCarryFromPointer(e.clientX, e.clientY);
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

    // E4 (issue #60): drop it from the shared layout AFTER the local removal,
    // so the doc observer's reconcile sees local state already matching (a
    // self-echo no-op) while remote peers apply the removal.
    deleteFurnitureItem(itemId);

    showHint(`Removed ${itemId}${cascade.length ? ` +${cascade.length} mounted layer${cascade.length === 1 ? '' : 's'}` : ''} → room inventory (DEV menu › INVENTORY re-places it).`, 3200);
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

    const group = this.world?.furnitureGroups.get(itemId);
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
    const item = this.selectedId ? FURNITURE.find((i) => i.id === this.selectedId) : undefined;
    const show = this.active && !this.carrying && !!item && item.movable;
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

  /** Reproject the label (above) + REMOVE button (below) every frame. */
  private updateLabelPosition(): void {
    if (!this.labelEl || !this.selectedId || this.labelEl.style.display === 'none') return;
    const group = this.world?.furnitureGroups.get(this.selectedId);
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
