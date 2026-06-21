/**
 * Player Entity
 * Drives a rigged VoxelCharacter with hybrid WASD + point-and-click navigation.
 *
 * Navigation modes
 * ─────────────────
 *  MANUAL   — WASD moves the player in real-time (default, always interrupts)
 *  WAYPOINT — Player follows a pre-computed A* path node-by-node
 *
 * WASD always takes priority: pressing any movement key immediately clears
 * the waypoint queue and reverts to MANUAL mode.
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './main';
import { VoxelCharacter } from './voxelCharacter';
import { WaypointReticle } from './waypoint';
import { findPath, worldToCol, worldToRow } from './pathfinding';

// ── Static obstacle AABB list (XZ plane) ─────────────────────────────────────
const PLAYER_R = 0.38;
interface Box { x0: number; z0: number; x1: number; z1: number }
const OBSTACLES: Box[] = [
  { x0: -5.00, z0: -5.95, x1:  5.00, z1: -5.08 },
  { x0: -1.50, z0: -2.12, x1:  1.50, z1: -0.88 },
  { x0: -1.50, z0:  2.58, x1:  1.50, z1:  3.82 },
  { x0: -4.82, z0: -4.32, x1: -3.78, z1:  2.32 },
  { x0:  3.78, z0: -4.32, x1:  4.82, z1:  2.32 },
  { x0: -0.94, z0: -3.82, x1:  0.94, z1: -2.78 },
  { x0: -0.94, z0:  1.02, x1:  0.94, z1:  1.98 },
  { x0:  4.48, z0:  1.48, x1:  5.92, z1:  4.72 },
  { x0: -4.62, z0: -5.02, x1: -3.98, z1: -4.38 },
  { x0:  3.98, z0: -5.02, x1:  4.62, z1: -4.38 },
  { x0: -4.12, z0:  2.88, x1: -3.48, z1:  3.52 },
  { x0:  3.48, z0:  2.88, x1:  4.12, z1:  3.52 },
];

const SNAP_INCREMENT = Math.PI / 4;

function snapTo8Ways(angle: number): number {
  return Math.round(angle / SNAP_INCREMENT) * SNAP_INCREMENT;
}

function resolveObstacles(x: number, z: number): { x: number; z: number } {
  let rx = x, rz = z;
  for (const b of OBSTACLES) {
    const ex0 = b.x0 - PLAYER_R, ex1 = b.x1 + PLAYER_R;
    const ez0 = b.z0 - PLAYER_R, ez1 = b.z1 + PLAYER_R;
    if (rx > ex0 && rx < ex1 && rz > ez0 && rz < ez1) {
      const dL = rx - ex0, dR = ex1 - rx, dT = rz - ez0, dB = ez1 - rz;
      const m = Math.min(dL, dR, dT, dB);
      if      (m === dL) rx = ex0;
      else if (m === dR) rx = ex1;
      else if (m === dT) rz = ez0;
      else               rz = ez1;
    }
  }
  return { x: rx, z: rz };
}

// ── Navigation mode ───────────────────────────────────────────────────────────
type NavigationMode = 'MANUAL' | 'WAYPOINT';

export class Player {
  /** Root group — consumed by World to toggle visibility and read position. */
  public mesh: THREE.Group;

  private scene: THREE.Scene;
  private character: VoxelCharacter;
  private logicalAngle = 0;
  private readonly SPEED = 2.8;
  private readonly BOUND = 5.2;

  // ── Navigation state ───────────────────────────────────────────────────────
  private navMode: NavigationMode = 'MANUAL';
  /** Ordered list of world-space waypoints remaining in the current path. */
  private waypointPath: Array<{ x: number; z: number }> = [];
  /** Arrival threshold (metres) — close enough to snap to the next node. */
  private readonly ARRIVE_DIST = 0.18;

  /** Active reticle shown at the final destination, or null when idle. */
  private reticle: WaypointReticle | null = null;

  constructor(scene: THREE.Scene) {
    this.scene     = scene;
    this.character = new VoxelCharacter(scene);
    this.mesh      = this.character.masterGroup;
    this.mesh.position.set(0, 0, 1.5);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Request the player to navigate to a world-space destination (x, z).
   * Computes an A* path and switches to WAYPOINT mode.
   * No-ops when the destination is unreachable.
   */
  navigateTo(targetX: number, targetZ: number): void {
    const pos = this.mesh.position;
    const path = findPath(
      worldToRow(pos.z), worldToCol(pos.x),
      worldToRow(targetZ), worldToCol(targetX),
    );
    if (path.length === 0) return;

    this.waypointPath = path;
    this.navMode      = 'WAYPOINT';

    // Replace reticle at the final destination
    if (this.reticle) {
      this.reticle.remove();
      this.reticle = null;
    }
    const last = path[path.length - 1];
    this.reticle = new WaypointReticle(this.scene, last.x, last.z);
  }

  /**
   * Update player movement and character animation for the current frame.
   */
  update(deltaTime: number, inputManager: InputManager): void {
    const dir = inputManager.getMoveDirection();
    const manualInput = dir.x !== 0 || dir.z !== 0;

    // ── WASD always overrides waypoint navigation ──────────────────────────
    if (manualInput) {
      this.navMode = 'MANUAL';
      this._clearPath();
    }

    if (this.navMode === 'MANUAL') {
      this._updateManual(deltaTime, dir);
    } else {
      this._updateWaypoint(deltaTime);
    }

    // Animate the reticle if active
    if (this.reticle) {
      this.reticle.update(deltaTime);
    }

    // Advance the character's own animation clock
    this.character.update();

    // Push the HUD
    const pos = this.mesh.position;
    updateDebugHUD('position', `${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}`);
    updateDebugHUD('navmode', this.navMode);
  }

  /** Returns the player's current world-space position. */
  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _updateManual(deltaTime: number, dir: THREE.Vector3): void {
    const pos  = this.mesh.position;
    const moving = dir.x !== 0 || dir.z !== 0;

    if (moving) {
      const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
      const nx  = dir.x / len;
      const nz  = dir.z / len;

      this.logicalAngle = snapTo8Ways(Math.atan2(nx, nz));

      const candX = Math.max(-this.BOUND, Math.min(this.BOUND, pos.x + nx * this.SPEED * deltaTime));
      const r1    = resolveObstacles(candX, pos.z);
      const candZ = Math.max(-this.BOUND, Math.min(this.BOUND, pos.z + nz * this.SPEED * deltaTime));
      const r2    = resolveObstacles(r1.x, candZ);
      pos.x = r2.x;
      pos.z = r2.z;

      this.character.setState('walk', this.logicalAngle);
    } else {
      this.character.setState('idle', this.logicalAngle);
    }
  }

  private _updateWaypoint(deltaTime: number): void {
    if (this.waypointPath.length === 0) {
      this.character.setState('idle', this.logicalAngle);
      this._clearPath();
      return;
    }

    const pos    = this.mesh.position;
    const target = this.waypointPath[0];

    const dx   = target.x - pos.x;
    const dz   = target.z - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < this.ARRIVE_DIST) {
      // Snap to node and advance
      pos.x = target.x;
      pos.z = target.z;
      this.waypointPath.shift();

      if (this.waypointPath.length === 0) {
        this.character.setState('idle', this.logicalAngle);
        this._clearPath();
        return;
      }
    } else {
      // Move towards target
      const nx = dx / dist;
      const nz = dz / dist;

      this.logicalAngle = snapTo8Ways(Math.atan2(nx, nz));

      const step = Math.min(this.SPEED * deltaTime, dist);
      const candX = pos.x + nx * step;
      const candZ = pos.z + nz * step;
      const resolved = resolveObstacles(
        Math.max(-this.BOUND, Math.min(this.BOUND, candX)),
        Math.max(-this.BOUND, Math.min(this.BOUND, candZ)),
      );
      pos.x = resolved.x;
      pos.z = resolved.z;

      this.character.setState('walk', this.logicalAngle);
    }
  }

  /** Clear the waypoint queue and remove the reticle. */
  private _clearPath(): void {
    this.waypointPath = [];
    if (this.reticle) {
      this.reticle.remove();
      this.reticle = null;
    }
  }
}
