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
 * Door walk-through (click a docking door)
 * ────────────────────────────────────────
 *  APPROACH → FINE → WAIT_OPEN → THROUGH → PEEK → RETURN
 *  The avatar A*-walks to the door's front point, fine-steps onto it, faces
 *  the door and asks it to open (via DoorSequenceHooks — the Player stays
 *  decoupled from the docking system). Once the door signals fully-open, a
 *  scripted walk (no collision, no BOUND clamp — same precedent as the
 *  SIT_DOWN slide) carries the avatar past the threshold, pauses for a peek,
 *  then walks it back inside and closes the door.
 *
 * WASD always takes priority: pressing any movement key immediately clears
 * the waypoint queue (and any sit/door approach) and reverts to MANUAL mode.
 * The only exception is the scripted THROUGH/PEEK/RETURN stretch outside the
 * room: WASD there triggers (or waits on) the RETURN leg instead of moving,
 * so MANUAL's BOUND clamp can never grab the avatar outside the walls.
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './hud';
import { VoxelCharacter } from './voxelCharacter';
import { WaypointReticle } from './waypoint';
import { findPath, worldToCol, worldToRow } from './pathfinding';
import { OBSTACLES } from './obstacles';
import type { Seat } from './seats';
import type { DoorTarget, DoorSequenceHooks } from './doors';

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
/** Door walk-through phases (NONE = regular navigation). */
type DoorPhase = 'NONE' | 'APPROACH' | 'FINE' | 'WAIT_OPEN' | 'THROUGH' | 'PEEK' | 'RETURN';
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
  /** Deferred actions to resume after STAND_UP / door RETURN completes. */
  private pendingDest: { x: number; z: number } | null = null;
  private pendingSeat: Seat | null = null;
  private pendingDoor: { door: DoorTarget; hooks: DoorSequenceHooks } | null = null;

  // ── Door walk-through state ────────────────────────────────────────────────
  private doorPhase: DoorPhase = 'NONE';
  /** Door being approached / walked through. */
  private doorTarget: DoorTarget | null = null;
  /** Hooks wired by World — open/close the physical door, fire hints. */
  private doorHooks: DoorSequenceHooks | null = null;
  /** Phase timer (WAIT_OPEN timeout, PEEK dwell). */
  private doorTimer = 0;
  /**
   * Sequence counter guarding stale door-opened callbacks: incremented on
   * every navigateToDoor and _cancelDoor, captured when requestOpen is
   * issued, and compared when the completion callback fires.
   */
  private doorSeq = 0;
  private readonly DOOR_WAIT_TIMEOUT = 3.0;
  private readonly DOOR_PEEK_TIME = 0.7;
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
    // Mid door walk-through: defer until the scripted RETURN leg finishes.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      this.pendingDoor = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }
    // Door approach not yet through the threshold: abandon it and re-route.
    this._abortDoorApproach();

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
    // Mid door walk-through: defer until the scripted RETURN leg finishes.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingSeat = seat;
      this.pendingDest = null;
      this.pendingDoor = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }
    // Door approach not yet through the threshold: abandon it and re-route.
    this._abortDoorApproach();

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
   * Request a door walk-through: A*-walk to the door's front point, face it,
   * ask it to open (via hooks), step through, peek, and come back. While
   * seated the player stands up first; while already mid walk-through the
   * request is deferred until the current sequence returns inside.
   */
  navigateToDoor(door: DoorTarget, hooks: DoorSequenceHooks): void {
    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      // Re-target while standing: just swap the deferred action.
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      return;
    }
    // Same door already in progress → no-op.
    if (this.doorPhase !== 'NONE' && this.doorTarget && this.doorTarget.id === door.id) return;
    // Mid walk-through of a different door: return inside first, then go.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }

    this._abortDoorApproach();
    this._cancelSit();
    this._clearPath();

    this.doorSeq++;
    this.doorTarget = door;
    this.doorHooks = hooks;
    this.doorPhase = 'APPROACH';
    this.navMode = 'WAYPOINT';

    const pos = this.mesh.position;
    // May legitimately return an empty path when we're already standing on
    // the front cell — the APPROACH handler falls straight through to FINE.
    this.waypointPath = findPath(
      worldToRow(pos.z), worldToCol(pos.x),
      worldToRow(door.front.z), worldToCol(door.front.x),
    );

    this.reticle = new WaypointReticle(this.scene, door.front.x, door.front.z);
  }

  /**
   * Update player movement and character animation for the current frame.
   */
  update(deltaTime: number, inputManager: InputManager): void {
    const dir = inputManager.getMoveDirection();
    const manualInput = dir.x !== 0 || dir.z !== 0;

    // ── WASD always overrides navigation & sitting ──────────────────────────
    // (Outside the room — THROUGH/PEEK/RETURN — it triggers/awaits the
    //  scripted RETURN leg instead, so MANUAL never runs out there.)
    if (manualInput) {
      if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK') {
        // Head back inside; input resumes once RETURN completes.
        this.pendingDoor = null;
        this.pendingDest = null;
        this.pendingSeat = null;
        this._beginDoorReturn();
      } else if (this.doorPhase === 'RETURN') {
        // Scripted return in progress — swallow input, drop deferred actions.
        this.pendingDoor = null;
        this.pendingDest = null;
        this.pendingSeat = null;
      } else {
        // APPROACH / FINE / WAIT_OPEN (all safely inside the room) — abort.
        if (this.doorPhase !== 'NONE') this._abortDoorApproach();
        if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
          // Stand up at the chair front first; movement resumes right after.
          this.pendingDest = null;
          this.pendingSeat = null;
          this.pendingDoor = null;
          this._beginStandUp();
        } else if (this.sitPhase !== 'STAND_UP') {
          this.navMode = 'MANUAL';
          this._clearPath();
          this._cancelSit();
        }
      }
    }

    if (this.doorPhase !== 'NONE' && this.doorPhase !== 'APPROACH') {
      // FINE / WAIT_OPEN / THROUGH / PEEK / RETURN are door-driven.
      // (Door APPROACH reuses the regular waypoint follower below.)
      this._updateDoorPhase(deltaTime);
    } else {
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
    updateDebugHUD(
      'navmode',
      this.doorPhase !== 'NONE'
        ? `DOOR:${this.doorPhase}`
        : (this.sitPhase !== 'NONE' ? this.sitPhase : this.navMode),
    );
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
      if (this.doorPhase === 'APPROACH') {
        // Arrived at (or started on) the door's front cell — fine-step next.
        this._removeReticle();
        this.doorPhase = 'FINE';
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
        if (this.doorPhase === 'APPROACH') {
          this._removeReticle();
          this.doorPhase = 'FINE';
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
      if (this.pendingDoor) {
        const next = this.pendingDoor;
        this.pendingDoor = null;
        this.navigateToDoor(next.door, next.hooks);
      } else if (this.pendingSeat) {
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

  // ── Door walk-through sequence ──────────────────────────────────────────────

  /**
   * Abandon a door approach that hasn't crossed the threshold yet
   * (APPROACH / FINE / WAIT_OPEN only — never the scripted outside stretch).
   */
  private _cancelDoor(): void {
    if (
      this.doorPhase === 'APPROACH' ||
      this.doorPhase === 'FINE' ||
      this.doorPhase === 'WAIT_OPEN'
    ) {
      this.doorSeq++;
      this.doorPhase = 'NONE';
      this.doorTarget = null;
      this.doorHooks = null;
      this._removeReticle();
    }
  }

  /** _cancelDoor, but first re-closes a door we already asked to open. */
  private _abortDoorApproach(): void {
    if (this.doorPhase === 'WAIT_OPEN' && this.doorHooks) {
      this.doorHooks.requestClose();
    }
    this._cancelDoor();
  }

  /** Turn around (scripted) and start walking back to the door's front point. */
  private _beginDoorReturn(): void {
    if (this.doorPhase !== 'THROUGH' && this.doorPhase !== 'PEEK') return;
    if (!this.doorTarget) return;
    this.logicalAngle = snapTo8Ways(this.doorTarget.faceAngle + Math.PI);
    this.doorPhase = 'RETURN';
  }

  /** Drive the FINE / WAIT_OPEN / THROUGH / PEEK / RETURN door phases. */
  private _updateDoorPhase(deltaTime: number): void {
    const door = this.doorTarget;
    const hooks = this.doorHooks;
    if (!door || !hooks) {
      // Defensive: should be unreachable (state is only cleared with phase).
      this.doorPhase = 'NONE';
      this.doorTarget = null;
      this.doorHooks = null;
      return;
    }

    const pos = this.mesh.position;

    switch (this.doorPhase) {
      // ── Straight-step onto the exact front point (collision ON) ───────────
      case 'FINE': {
        const dx = door.front.x - pos.x;
        const dz = door.front.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.06) {
          pos.x = door.front.x;
          pos.z = door.front.z;
          this.logicalAngle = door.faceAngle;
          this.character.setState('idle', this.logicalAngle);
          this.doorPhase = 'WAIT_OPEN';
          this.doorTimer = 0;

          const seq = this.doorSeq;
          const accepted = hooks.requestOpen(() => {
            // Ignore stale completions from a cancelled/replaced sequence.
            if (seq !== this.doorSeq || this.doorPhase !== 'WAIT_OPEN') return;
            this.doorPhase = 'THROUGH';
          });
          if (!accepted) {
            // Denied (locked) — the hook already surfaced a hint.
            this._cancelDoor();
            this.navMode = 'MANUAL';
          }
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
        return;
      }

      // ── Idle facing the door until it signals fully-open (3s timeout) ─────
      case 'WAIT_OPEN': {
        this.character.setState('idle', this.logicalAngle);
        this.doorTimer += deltaTime;
        if (this.doorTimer > this.DOOR_WAIT_TIMEOUT) {
          hooks.requestClose();
          this._cancelDoor();
          this.navMode = 'MANUAL';
        }
        return;
      }

      // ── Scripted walk past the threshold (no collision, no BOUND clamp —
      //    same precedent as the SIT_DOWN slide) ───────────────────────────────
      case 'THROUGH': {
        const dx = door.through.x - pos.x;
        const dz = door.through.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.06) {
          pos.x = door.through.x;
          pos.z = door.through.z;
          this.doorPhase = 'PEEK';
          this.doorTimer = 0;
          this.character.setState('idle', door.faceAngle);
          hooks.onThrough();
          return;
        }

        const nx = dx / dist;
        const nz = dz / dist;
        this.logicalAngle = snapTo8Ways(Math.atan2(nx, nz));
        const step = Math.min(this.SPEED * deltaTime, dist);
        pos.x += nx * step;
        pos.z += nz * step;
        this.character.setState('walk', this.logicalAngle);
        return;
      }

      // ── Brief look outside, then turn back ─────────────────────────────────
      case 'PEEK': {
        this.character.setState('idle', door.faceAngle);
        this.doorTimer += deltaTime;
        if (this.doorTimer >= this.DOOR_PEEK_TIME) {
          this._beginDoorReturn();
        }
        return;
      }

      // ── Scripted walk back inside to the front point (no collision) ────────
      case 'RETURN': {
        const dx = door.front.x - pos.x;
        const dz = door.front.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.06) {
          pos.x = door.front.x;
          pos.z = door.front.z;
          this.doorPhase = 'NONE';
          this.doorTarget = null;
          this.doorHooks = null;
          this.navMode = 'MANUAL';
          this.character.setState('idle', this.logicalAngle);
          hooks.requestClose();

          // Resume whatever interrupted the walk-through.
          if (this.pendingDoor) {
            const next = this.pendingDoor;
            this.pendingDoor = null;
            this.navigateToDoor(next.door, next.hooks);
          } else if (this.pendingSeat) {
            const next = this.pendingSeat;
            this.pendingSeat = null;
            this.navigateToSeat(next);
          } else if (this.pendingDest) {
            const dest = this.pendingDest;
            this.pendingDest = null;
            this.navigateTo(dest.x, dest.z);
          }
          return;
        }

        const nx = dx / dist;
        const nz = dz / dist;
        this.logicalAngle = snapTo8Ways(Math.atan2(nx, nz));
        const step = Math.min(this.SPEED * deltaTime, dist);
        pos.x += nx * step;
        pos.z += nz * step;
        this.character.setState('walk', this.logicalAngle);
        return;
      }
    }
  }
}
