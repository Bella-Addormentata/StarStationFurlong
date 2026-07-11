/**
 * Player Entity
 * Drives a rigged VoxelCharacter with hybrid WASD + point-and-click navigation.
 *
 * Navigation modes
 * ─────────────────
 *  MANUAL   — WASD moves the player in real-time (default, always interrupts)
 *  WAYPOINT — Player follows a pre-computed A* path node-by-node
 *
 * Sitting (click a chair)
 * ───────────────────────
 *  APPROACH → FINE → TURN → SIT_DOWN → SEATED → STAND_UP
 *  The avatar A*-walks to the seat's front point, fine-steps onto it, turns
 *  its back to the chair, slides into the seat (scripted — no collision),
 *  and sits. Any WASD input or a new click stands it up at the front point
 *  first, then resumes the requested route.
 *
 * WASD always takes priority: pressing any movement key immediately clears
 * the waypoint queue (and any sit approach) and reverts to MANUAL mode.
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './hud';
import { VoxelCharacter } from './voxelCharacter';
import { WaypointReticle } from './waypoint';
import { findPath, worldToCol, worldToRow } from './pathfinding';
import { OBSTACLES } from './obstacles';
import type { Seat } from './seats';

// ── Static obstacle AABB list (XZ plane) ─────────────────────────────────────
const PLAYER_R = 0.38;

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
/** Sitting sequence phases (NONE = regular navigation). */
type SitPhase = 'NONE' | 'APPROACH' | 'FINE' | 'TURN' | 'SIT_DOWN' | 'SEATED' | 'STAND_UP';
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
  // ── Sitting state ──────────────────────────────────────────────────────────────────────
  private sitPhase: SitPhase = 'NONE';
  /** Seat being approached or occupied. */
  private sitTarget: Seat | null = null;
  /** 0→1 progress through SIT_DOWN / STAND_UP slides. */
  private sitAnim = 0;
  private turnTimer = 0;
  private readonly SIT_ANIM_TIME = 0.35;
  private readonly STAND_ANIM_TIME = 0.28;
  private readonly TURN_TIME = 0.15;
  /** Deferred actions to resume after STAND_UP completes. */
  private pendingDest: { x: number; z: number } | null = null;
  private pendingSeat: Seat | null = null;
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
   * While seated, the player stands up first and then continues the route.
   * No-ops when the destination is unreachable.
   */
  navigateTo(targetX: number, targetZ: number): void {
    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      // Re-target while standing: just swap the deferred destination.
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      return;
    }
    this._cancelSit();

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
   * Request the player to sit on a seat: A*-walk to the seat's front point,
   * turn back-to-the-chair, and slide down onto it. While already seated on
   * another seat, stands up first and then walks over.
   */
  navigateToSeat(seat: Seat): void {
    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      if (this.sitTarget && this.sitTarget.id === seat.id) return; // already here
      this.pendingSeat = seat;
      this.pendingDest = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      this.pendingSeat = seat;
      this.pendingDest = null;
      return;
    }

    this._clearPath();
    this.sitTarget = seat;
    this.sitPhase  = 'APPROACH';
    this.navMode   = 'WAYPOINT';

    const pos = this.mesh.position;
    // May legitimately return an empty path when we're already standing on
    // the front cell — the APPROACH handler falls straight through to FINE.
    this.waypointPath = findPath(
      worldToRow(pos.z), worldToCol(pos.x),
      worldToRow(seat.front.z), worldToCol(seat.front.x),
    );

    this.reticle = new WaypointReticle(this.scene, seat.front.x, seat.front.z);
  }

  /**
   * Update player movement and character animation for the current frame.
   */
  update(deltaTime: number, inputManager: InputManager): void {
    const dir = inputManager.getMoveDirection();
    const manualInput = dir.x !== 0 || dir.z !== 0;

    // ── WASD always overrides navigation & sitting ──────────────────────────
    if (manualInput) {
      if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
        // Stand up at the chair front first; movement resumes right after.
        this.pendingDest = null;
        this.pendingSeat = null;
        this._beginStandUp();
      } else if (this.sitPhase !== 'STAND_UP') {
        this.navMode = 'MANUAL';
        this._clearPath();
        this._cancelSit();
      }
    }

    switch (this.sitPhase) {
      case 'FINE':      this._updateFineApproach(deltaTime); break;
      case 'TURN':      this._updateTurn(deltaTime);         break;
      case 'SIT_DOWN':  this._updateSitDown(deltaTime);      break;
      case 'SEATED':    this._updateSeated();                break;
      case 'STAND_UP':  this._updateStandUp(deltaTime);      break;
      default:
        if (this.navMode === 'MANUAL') {
          this._updateManual(deltaTime, dir);
        } else {
          this._updateWaypoint(deltaTime);
        }
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
    updateDebugHUD('navmode', this.sitPhase !== 'NONE' ? this.sitPhase : this.navMode);
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
      const candZ = Math.max(-this.BOUND, Math.min(this.BOUND, pos.z + nz * this.SPEED * deltaTime));
      
      // Separate sliding resolution over Obstacles to prevent sticking on corners during walking (AABB Sliding)
      const r1 = resolveObstacles(candX, pos.z);
      const r2 = resolveObstacles(pos.x, candZ);
      
      // Apply movement independently if free on that vector
      if (r1.x === candX) {
        pos.x = candX;
      }
      if (r2.z === candZ) {
        pos.z = candZ;
      }

      this.character.setState('walk', this.logicalAngle);
    } else {
      this.character.setState('idle', this.logicalAngle);
    }
  }

  private _updateWaypoint(deltaTime: number): void {
    if (this.waypointPath.length === 0) {
      if (this.sitPhase === 'APPROACH') {
        // Arrived at (or started on) the seat's front cell — fine-step next.
        this._removeReticle();
        this.sitPhase = 'FINE';
        return;
      }
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
        if (this.sitPhase === 'APPROACH') {
          this._removeReticle();
          this.sitPhase = 'FINE';
          return;
        }
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
      const r1 = resolveObstacles(
        Math.max(-this.BOUND, Math.min(this.BOUND, candX)),
        pos.z,
      );
      const r2 = resolveObstacles(
        r1.x,
        Math.max(-this.BOUND, Math.min(this.BOUND, candZ)),
      );
      pos.x = r2.x;
      pos.z = r2.z;

      this.character.setState('walk', this.logicalAngle);
    }
  }

  /** Clear the waypoint queue and remove the reticle. */
  private _clearPath(): void {
    this.waypointPath = [];
    this._removeReticle();
  }

  private _removeReticle(): void {
    if (this.reticle) {
      this.reticle.remove();
      this.reticle = null;
    }
  }

  // ── Sitting sequence ────────────────────────────────────────────────────────────────

  /** Abandon any in-flight sit approach (does NOT stand up a seated player). */
  private _cancelSit(): void {
    if (this.sitPhase === 'APPROACH' || this.sitPhase === 'FINE' || this.sitPhase === 'TURN') {
      this.sitPhase = 'NONE';
      this.sitTarget = null;
    }
  }

  /** Walk straight from the last path cell onto the seat's exact front point. */
  private _updateFineApproach(deltaTime: number): void {
    const seat = this.sitTarget;
    if (!seat) { this.sitPhase = 'NONE'; return; }

    const pos  = this.mesh.position;
    const dx   = seat.front.x - pos.x;
    const dz   = seat.front.z - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.06) {
      pos.x = seat.front.x;
      pos.z = seat.front.z;
      // Turn so the avatar's BACK faces the chair (i.e. face away from it).
      this.logicalAngle = seat.faceAngle;
      this.turnTimer = 0;
      this.sitPhase = 'TURN';
      this.character.setState('idle', this.logicalAngle);
      return;
    }

    const nx = dx / dist;
    const nz = dz / dist;
    this.logicalAngle = snapTo8Ways(Math.atan2(nx, nz));
    const step = Math.min(this.SPEED * deltaTime, dist);
    const r = resolveObstacles(pos.x + nx * step, pos.z + nz * step);
    pos.x = r.x;
    pos.z = r.z;
    this.character.setState('walk', this.logicalAngle);
  }

  /** Brief pause while the facing snaps to back-to-the-chair. */
  private _updateTurn(deltaTime: number): void {
    const seat = this.sitTarget;
    if (!seat) { this.sitPhase = 'NONE'; return; }
    this.character.setState('idle', seat.faceAngle);
    this.turnTimer += deltaTime;
    if (this.turnTimer >= this.TURN_TIME) {
      this.sitAnim = 0;
      this.sitPhase = 'SIT_DOWN';
    }
  }

  /** Scripted slide from the front point back onto the seat (no collision). */
  private _updateSitDown(deltaTime: number): void {
    const seat = this.sitTarget;
    if (!seat) { this.sitPhase = 'NONE'; return; }

    this.sitAnim = Math.min(1, this.sitAnim + deltaTime / this.SIT_ANIM_TIME);
    const t = this.sitAnim * this.sitAnim * (3 - 2 * this.sitAnim); // smoothstep
    const pos = this.mesh.position;
    pos.x = seat.front.x + (seat.sit.x - seat.front.x) * t;
    pos.z = seat.front.z + (seat.sit.z - seat.front.z) * t;
    this.character.setState('sit_chair', seat.faceAngle);

    if (this.sitAnim >= 1) {
      this.sitPhase = 'SEATED';
    }
  }

  private _updateSeated(): void {
    const seat = this.sitTarget;
    if (!seat) { this.sitPhase = 'NONE'; return; }
    this.character.setState('sit_chair', seat.faceAngle);
  }

  /** Begin standing: reverse slide from the seat to its front point. */
  private _beginStandUp(): void {
    if (this.sitPhase !== 'SEATED' && this.sitPhase !== 'SIT_DOWN') return;
    this.sitAnim = 0;
    this.sitPhase = 'STAND_UP';
  }

  private _updateStandUp(deltaTime: number): void {
    const seat = this.sitTarget;
    if (!seat) { this.sitPhase = 'NONE'; return; }

    this.sitAnim = Math.min(1, this.sitAnim + deltaTime / this.STAND_ANIM_TIME);
    const t = this.sitAnim * this.sitAnim * (3 - 2 * this.sitAnim); // smoothstep
    const pos = this.mesh.position;
    pos.x = seat.sit.x + (seat.front.x - seat.sit.x) * t;
    pos.z = seat.sit.z + (seat.front.z - seat.sit.z) * t;
    this.character.setState('idle', seat.faceAngle);

    if (this.sitAnim >= 1) {
      pos.x = seat.front.x;
      pos.z = seat.front.z;
      this.logicalAngle = seat.faceAngle;
      this.sitTarget = null;
      this.sitPhase = 'NONE';
      this.navMode = 'MANUAL';

      // Resume whatever interrupted the sit.
      if (this.pendingSeat) {
        const next = this.pendingSeat;
        this.pendingSeat = null;
        this.navigateToSeat(next);
      } else if (this.pendingDest) {
        const dest = this.pendingDest;
        this.pendingDest = null;
        this.navigateTo(dest.x, dest.z);
      }
    }
  }
}
