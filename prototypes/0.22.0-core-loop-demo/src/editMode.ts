/**
 * Room-edit mode — E2 of issue #25 (brainstorming/edit-room-mode-plan.md §E2),
 * as AMENDED by issue #33 M2 (brainstorming/device-focus-and-storage-trunk-plan.md
 * §2 M2): there is NO HUD pencil button — the entry point is the EDIT ROOM
 * button inside the wall computer's focused UI (devices.ts
 * createRoomTerminalUI). Pressing it RELEASES the device focus first
 * (deviceFocus.releaseThen), then enters edit mode; exiting edit mode returns
 * to the plain isometric room view.
 *
 * E2 scope — selection/highlight SHELL only (movement is E3):
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
 * Module singleton — exported as `roomEdit`, with `isEditModeActive()` for
 * the click-routing guard in main.ts (mirrors deviceFocus.ts).
 */

import * as THREE from 'three';
import { FURNITURE } from './furniture';
import { OUTLINE_MAT } from './voxelCharacter';
import { showHint } from './hud';
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

// ── Highlight tints ───────────────────────────────────────────────────────────

/** Hover: soft gold emissive wash (docking-terminal palette). */
const HOVER_EMISSIVE = 0xd4a84b;
const HOVER_INTENSITY = 0.28;
/** Selected: stronger, brighter gold. */
const SELECT_EMISSIVE = 0xf0c060;
const SELECT_INTENSITY = 0.65;

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
   * Original emissive state, saved ONCE per material on first tint and
   * restored EXACTLY on clear (dedupe map — several meshes of one item may
   * share a material instance). Furniture materials only ever land here, but
   * the shared rig OUTLINE_MAT is guarded against anyway (#27's lesson).
   */
  private savedEmissive: Map<EmissiveMaterial, { hex: number; intensity: number }> = new Map();

  /** Floating label showing the selected item's id. */
  private labelEl: HTMLDivElement | null = null;
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
      this.exit();
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

  /**
   * Enter edit mode from the plain isometric room view. Reached via the wall
   * computer's EDIT ROOM button AFTER the device focus has released
   * (deviceFocus.releaseThen continuation) — so the ortho camera is live.
   */
  public enter(world: World): void {
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
    if (zoomLevel !== 2 || !(window.gameRenderer?.camera instanceof THREE.OrthographicCamera)) {
      return;
    }

    this.world = world;
    this.active = true;
    this.buildRaycastIndex(world);
    window.addEventListener('mousemove', this.onMouseMove);
    world.setEditMode(true);
    showHint('EDIT MODE — click furniture to select · ESC to exit', 4000);
  }

  /** Leave edit mode: restore every tint, hide grid + label, detach hover. */
  public exit(): void {
    if (!this.active) return;
    this.setHovered(null);
    this.setSelected(null);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.setCanvasCursor('');
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
   * (world.startMorph), zoom leaving level 2, solar map opening. E2 has no
   * carry state, so this is exit(); E3 will additionally cancel a carry here.
   */
  public forceExit(): void {
    this.exit();
  }

  /**
   * Edit-mode click routing (from main.ts onCanvasClick, BEFORE the keypad →
   * door → device passes): click a movable item → select it; click anywhere
   * else → deselect. Navigation is suppressed by the caller returning early.
   */
  public handleClick(event: MouseEvent): void {
    if (!this.active) return;
    this.setSelected(this.pickItemAt(event.clientX, event.clientY));
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
    this.setHovered(this.pickItemAt(e.clientX, e.clientY));
  };

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

  /** Reproject the label to float above the selected item's bounding box. */
  private updateLabelPosition(): void {
    if (!this.labelEl || !this.selectedId || this.labelEl.style.display === 'none') return;
    const group = this.world?.furnitureGroups.get(this.selectedId);
    const camera = window.gameRenderer?.camera;
    if (!group || !camera) return;
    this.labelAnchor.set(group.position.x, this.selectedTopY + 0.12, group.position.z);
    this.labelAnchor.project(camera);
    this.labelEl.style.left = `${((this.labelAnchor.x + 1) / 2) * window.innerWidth}px`;
    this.labelEl.style.top = `${((1 - this.labelAnchor.y) / 2) * window.innerHeight}px`;
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
