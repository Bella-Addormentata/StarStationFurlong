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
 * Adapter transit (T1 of issue #30 — paired docking door)
 * ───────────────────────────────────────────────────────
 *  … THROUGH → ADAPTER_OUT → ADAPTER_HOLD  ⇢ (room swap) ⇢  ARRIVE_OPEN → ARRIVE
 *  At the THROUGH completion the optional hooks.beginTransit() is consulted:
 *  true branches into ADAPTER_OUT — a scripted walk onward from `through`
 *  into the docking vestibule — then ADAPTER_HOLD (idle at the hold point;
 *  hooks.onAdapterHold() fires once and the world runs the leaveRoom→joinRoom
 *  swap behind a full-screen fade). The arrival leg is started explicitly by
 *  the world via enterFromDoor(): spawn at the arrival door's `through`
 *  point, wait for the door to open (ARRIVE_OPEN), walk in to `front`
 *  (ARRIVE), close the door, navMode MANUAL. All WASD input and click
 *  navigation during ADAPTER_* and ARRIVE_* is swallowed — the stretch is
 *  fully scripted and (mid-swap) the room under the avatar is being replaced.
 *  ADAPTER_HOLD is timer-capped (8 s): if the swap never resolves, the
 *  avatar walks itself back inside (defensive — the transit driver has its
 *  own failure path that calls enterFromDoor on the departure door).
 *
 * Device focus (click a device — wall computer, trunk, …; #33 D0)
 * ────────────────────────────────────────────────────────────────
 *  APPROACH → FINE → TURN → ENGAGED
 *  The avatar A*-walks to the device's front point, fine-steps onto it, and
 *  turns to FACE the device (TOWARD it — the opposite of the seats'
 *  back-to-the-chair convention). ENGAGED fires hooks.onArrived() exactly
 *  once; the DeviceFocusController (deviceFocus.ts) then owns the camera and
 *  UI. While ENGAGED all movement is swallowed: WASD or a new click asks the
 *  controller to let go via hooks.requestRelease(), and the deferred action
 *  resumes when the controller's release ease completes and calls
 *  releaseDevice().
 *
 * WASD always takes priority: pressing any movement key immediately clears
 * the waypoint queue (and any sit/door/device approach) and reverts to MANUAL
 * mode. Two exceptions: the scripted THROUGH/PEEK/RETURN stretch outside the
 * room (WASD triggers/awaits the RETURN leg instead of moving, so MANUAL's
 * BOUND clamp can never grab the avatar outside the walls) and device
 * ENGAGED (WASD requests a camera release; movement resumes right after).
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD, showHint } from './hud';
import { VoxelCharacter } from './voxelCharacter';
import { WaypointReticle } from './waypoint';
import { findPath, worldToCol, worldToRow } from './pathfinding';
import { OBSTACLES } from './obstacles';
import type { Seat } from './seats';
import type { DoorId, DoorTarget, DoorSequenceHooks } from './doors';
import type { DeviceTarget, DeviceFocusHooks } from './devices';

// ── Static obstacle AABB list (XZ plane) ─────────────────────────────────────
/** Collision radius — exported for the E3 move-furniture player-overlap check. */
export const PLAYER_R = 0.38;

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
/** Door walk-through phases (NONE = regular navigation). ADAPTER_OUT /
 *  ADAPTER_HOLD are the departure half of an adapter transit; ARRIVE_OPEN /
 *  ARRIVE are the arrival half in the destination room (T1 of issue #30). */
type DoorPhase =
  | 'NONE' | 'APPROACH' | 'FINE' | 'WAIT_OPEN' | 'THROUGH' | 'PEEK' | 'RETURN'
  | 'ADAPTER_OUT' | 'ADAPTER_HOLD' | 'ARRIVE_OPEN' | 'ARRIVE';
/** Device-focus phases (NONE = regular navigation). Mirrors DoorPhase. */
type DevicePhase = 'NONE' | 'APPROACH' | 'FINE' | 'TURN' | 'ENGAGED';
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
  /** 🛏️ Mesh y at STAND_UP start — an interrupted bunk climb descends from
   *  wherever it actually got to, not from the full berth height. */
  private standStartY = 0;
  private turnTimer = 0;
  private readonly SIT_ANIM_TIME = 0.35;
  private readonly STAND_ANIM_TIME = 0.28;
  private readonly TURN_TIME = 0.15;
  /**
   * Deferred actions to resume after STAND_UP / door RETURN / device release
   * completes. At most one is ever non-null (every setter clears the rest).
   */
  private pendingDest: { x: number; z: number } | null = null;
  private pendingSeat: Seat | null = null;
  private pendingDoor: { door: DoorTarget; hooks: DoorSequenceHooks } | null = null;
  private pendingDevice: { device: DeviceTarget; hooks: DeviceFocusHooks } | null = null;

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

  // ── Adapter transit state (T1 of issue #30) ────────────────────────────────
  /**
   * Vestibule hold point for the current ADAPTER_OUT leg: `through` plus
   * ADAPTER_OUT_DIST further out along the door axis. The plan sketched
   * "~2.5 m further out", but that lands PAST the vestibule's outer portal
   * (the gangway spans the 6→9 band and `through` already sits at ±7.0), so
   * 1.2 m is used — the hold point centres in the outermost concertina bay,
   * visibly inside the tube.
   */
  private adapterOutTarget: { x: number; z: number } | null = null;
  private readonly ADAPTER_OUT_DIST = 1.2;
  /** Defensive cap on ADAPTER_HOLD — the swap driver should always resolve
   *  (success or failure) via enterFromDoor long before this fires. */
  private readonly ADAPTER_HOLD_TIMEOUT = 8.0;

  // ── Device-focus state (#33 D0) ─────────────────────────────────────────────
  private devicePhase: DevicePhase = 'NONE';
  /** Device being approached / engaged. */
  private deviceTarget: DeviceTarget | null = null;
  /** Hooks wired by the DeviceFocusController — arrival + release requests. */
  private deviceHooks: DeviceFocusHooks | null = null;
  /** Phase timer (TURN dwell — reuses TURN_TIME). */
  private deviceTimer = 0;

  // ── FINE stuck watchdog (E3 review F2) ─────────────────────────────────────
  /** Seconds without positional progress while in a FINE phase. */
  private fineStuckTimer = 0;
  /** Last frame's position — progress baseline for the watchdog. */
  private fineLastPos = { x: 0, z: 0 };
  /** No progress for this long in any FINE phase → give up (belt-and-braces). */
  private readonly FINE_STUCK_TIME = 1.5;
  /** Per-frame movement below this counts as "no progress". */
  private readonly FINE_STUCK_EPS = 0.005;

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
    // Mid adapter transit: fully scripted, room being swapped — swallow.
    if (this._inAdapterTransit()) return;
    // Engaged on a device: ask the focus controller to let go; the deferred
    // destination resumes when the release ease completes (releaseDevice).
    if (this.devicePhase === 'ENGAGED') {
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      this.deviceHooks?.requestRelease();
      return;
    }
    // Mid door walk-through: defer until the scripted RETURN leg finishes.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }
    // Door/device approaches not yet committed: abandon them and re-route.
    this._abortDoorApproach();
    this._cancelDeviceApproach();

    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      // Re-target while standing: just swap the deferred destination.
      this.pendingDest = { x: targetX, z: targetZ };
      this.pendingSeat = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      return;
    }
    this._cancelSit();

    const pos = this.mesh.position;
    const path = findPath(
      worldToRow(pos.z), worldToCol(pos.x),
      worldToRow(targetZ), worldToCol(targetX),
    );
    if (path.length === 0) {
      // Unreachable — but any door/sit approach cancelled above left its
      // waypoint path behind: stop rather than keep walking a route whose
      // purpose no longer exists.
      this._clearPath();
      return;
    }

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
    // Mid adapter transit: fully scripted, room being swapped — swallow.
    if (this._inAdapterTransit()) return;
    // Engaged on a device: release the focus first, then walk over and sit.
    if (this.devicePhase === 'ENGAGED') {
      this.pendingSeat = seat;
      this.pendingDest = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      this.deviceHooks?.requestRelease();
      return;
    }
    // Mid door walk-through: defer until the scripted RETURN leg finishes.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingSeat = seat;
      this.pendingDest = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }
    // Door/device approaches not yet committed: abandon them and re-route.
    this._abortDoorApproach();
    this._cancelDeviceApproach();

    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      if (this.sitTarget && this.sitTarget.id === seat.id) return; // already here
      this.pendingSeat = seat;
      this.pendingDest = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      this.pendingSeat = seat;
      this.pendingDest = null;
      this.pendingDoor = null;
      this.pendingDevice = null;
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
    // Mid adapter transit: fully scripted, room being swapped — swallow.
    if (this._inAdapterTransit()) return;
    // Engaged on a device: release the focus first, then walk to the door.
    if (this.devicePhase === 'ENGAGED') {
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDevice = null;
      this.deviceHooks?.requestRelease();
      return;
    }
    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDevice = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      // Re-target while standing: just swap the deferred action.
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDevice = null;
      return;
    }
    // Same door already in progress → no-op. (Except during RETURN: a
    // re-click on the same door defers below and queues a fresh walk-through
    // that the RETURN-completion resume path picks up.)
    if (
      this.doorPhase !== 'NONE' &&
      this.doorPhase !== 'RETURN' &&
      this.doorTarget &&
      this.doorTarget.id === door.id
    ) return;
    // Mid walk-through of a different door: return inside first, then go.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingDoor = { door, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDevice = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }

    this._abortDoorApproach();
    this._cancelDeviceApproach();
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
   * Request a device focus (#33 D0): A*-walk to the device's front point,
   * fine-step onto it, turn TOWARD the device, and fire hooks.onArrived()
   * exactly once (the DeviceFocusController takes the camera from there).
   * While seated the player stands up first; mid door walk-through the
   * request defers until the RETURN leg completes; while engaged on another
   * device the controller is asked to release first.
   */
  navigateToDevice(device: DeviceTarget, hooks: DeviceFocusHooks): void {
    // Mid adapter transit: fully scripted, room being swapped — swallow.
    if (this._inAdapterTransit()) return;
    // Already engaged on this exact device → nothing to do.
    if (this.devicePhase === 'ENGAGED' && this.deviceTarget && this.deviceTarget.id === device.id) return;
    // Engaged on a different device: release the focus first, then walk over.
    if (this.devicePhase === 'ENGAGED') {
      this.pendingDevice = { device, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDoor = null;
      this.deviceHooks?.requestRelease();
      return;
    }
    // Mid door walk-through: defer until the scripted RETURN leg finishes.
    if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK' || this.doorPhase === 'RETURN') {
      this.pendingDevice = { device, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDoor = null;
      if (this.doorPhase !== 'RETURN') this._beginDoorReturn();
      return;
    }
    if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
      this.pendingDevice = { device, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDoor = null;
      this._beginStandUp();
      return;
    }
    if (this.sitPhase === 'STAND_UP') {
      // Re-target while standing: just swap the deferred action.
      this.pendingDevice = { device, hooks };
      this.pendingSeat = null;
      this.pendingDest = null;
      this.pendingDoor = null;
      return;
    }
    // Same device already being approached: adopt the caller's fresh hooks
    // (a re-click bumps the controller's deviceSeq — keeping the old closure
    // would make onArrived fire with a stale token and strand the avatar
    // ENGAGED with no camera) and keep walking.
    if (this.devicePhase !== 'NONE' && this.deviceTarget && this.deviceTarget.id === device.id) {
      this.deviceHooks = hooks;
      return;
    }

    this._abortDoorApproach();
    this._cancelDeviceApproach();
    this._cancelSit();
    this._clearPath();

    this.deviceTarget = device;
    this.deviceHooks = hooks;
    this.devicePhase = 'APPROACH';
    this.navMode = 'WAYPOINT';

    const pos = this.mesh.position;
    // May legitimately return an empty path when we're already standing on
    // the front cell — the APPROACH handler falls straight through to FINE.
    this.waypointPath = findPath(
      worldToRow(pos.z), worldToCol(pos.x),
      worldToRow(device.front.z), worldToCol(device.front.x),
    );

    this.reticle = new WaypointReticle(this.scene, device.front.x, device.front.z);
  }

  /**
   * Called by the DeviceFocusController when its release ease completes (or
   * on a force-release, or when it must decline an arrival). Clears any
   * device engagement/approach and resumes whatever interrupted it.
   */
  releaseDevice(): void {
    if (this.devicePhase === 'NONE') return;
    if (this.devicePhase !== 'ENGAGED') {
      // Approach never engaged — just abandon it (no pendings to resume:
      // anything that queued a pending also left APPROACH/FINE/TURN).
      this._cancelDeviceApproach();
      return;
    }
    this.devicePhase = 'NONE';
    this.deviceTarget = null;
    this.deviceHooks = null;
    this.navMode = 'MANUAL';

    // Resume whatever interrupted the engagement.
    if (this.pendingDevice) {
      const next = this.pendingDevice;
      this.pendingDevice = null;
      this.navigateToDevice(next.device, next.hooks);
    } else if (this.pendingDoor) {
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

  /** Current device-focus phase (debug/verification handle). */
  getDevicePhase(): DevicePhase {
    return this.devicePhase;
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
      if (this.devicePhase === 'ENGAGED') {
        // Swallow movement; ask the focus controller to let go (repeat calls
        // while the release ease runs are no-ops). Movement resumes as soon
        // as the controller calls releaseDevice(). Deferred actions drop —
        // WASD means "give me back control", same as the door RETURN rule.
        this.pendingDoor = null;
        this.pendingDest = null;
        this.pendingSeat = null;
        this.pendingDevice = null;
        this.deviceHooks?.requestRelease();
      } else if (this.doorPhase === 'THROUGH' || this.doorPhase === 'PEEK') {
        // Head back inside; input resumes once RETURN completes.
        this.pendingDoor = null;
        this.pendingDest = null;
        this.pendingSeat = null;
        this.pendingDevice = null;
        this._beginDoorReturn();
      } else if (this.doorPhase === 'RETURN' || this._inAdapterTransit()) {
        // Scripted return / adapter transit in progress — swallow input,
        // drop deferred actions. (During ADAPTER_*/ARRIVE_* the room under
        // the avatar may be mid-swap; MANUAL must never run out there.)
        this.pendingDoor = null;
        this.pendingDest = null;
        this.pendingSeat = null;
        this.pendingDevice = null;
      } else {
        // Door APPROACH / FINE / WAIT_OPEN and device APPROACH / FINE / TURN
        // (all safely inside the room, nothing engaged yet) — abort.
        if (this.doorPhase !== 'NONE') this._abortDoorApproach();
        if (this.devicePhase !== 'NONE') this._cancelDeviceApproach();
        if (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') {
          // Stand up at the chair front first; movement resumes right after.
          this.pendingDest = null;
          this.pendingSeat = null;
          this.pendingDoor = null;
          this.pendingDevice = null;
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
    } else if (this.devicePhase !== 'NONE' && this.devicePhase !== 'APPROACH') {
      // FINE / TURN / ENGAGED are device-driven.
      // (Device APPROACH reuses the regular waypoint follower below.)
      this._updateDevicePhase(deltaTime);
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

    // FINE stuck watchdog (E3 review F2): runs AFTER the phase updates so it
    // compares post-move positions.
    this._updateFineWatchdog(deltaTime);

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
        : this.devicePhase !== 'NONE'
          ? `DEVICE:${this.devicePhase}`
          : (this.sitPhase !== 'NONE' ? this.sitPhase : this.navMode),
    );
  }

  /** Returns the player's current world-space position. */
  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }

  /**
   * Seat id currently occupied (SEATED, or mid SIT_DOWN slide), or null.
   * E3 of #25: the room editor uses it to detect "picking up the item I'm
   * sitting on" (seat ids are `${itemId}:${templateIndex}`).
   */
  public getSeatedSeatId(): string | null {
    return (this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN') && this.sitTarget
      ? this.sitTarget.id
      : null;
  }

  /**
   * #63: true once the avatar is on (or sliding onto) a seat, so the movement
   * tick can broadcast a seated flag and peers render the seated pose instead of
   * an idle stand at the chair.
   */
  public isSeated(): boolean {
    return this.sitPhase === 'SEATED' || this.sitPhase === 'SIT_DOWN';
  }

  /**
   * #63: the seated world facing (seat.faceAngle — avatar's BACK to the backrest)
   * to broadcast so peers orient the sit pose correctly. 0 when not seated.
   */
  public getSeatedFacing(): number {
    return this.isSeated() && this.sitTarget ? this.sitTarget.faceAngle : 0;
  }

  /**
   * 🛏️ true while the occupied seat is a lie-down berth (bunk bed) — the
   * movement tick broadcasts it (flags bit2) so peers render the 'sleep'
   * pose instead of 'sit_chair'.
   */
  public isLying(): boolean {
    return this.isSeated() && this.sitTarget !== null && this.sitTarget.lie;
  }

  /**
   * 🛏️ The occupied seat's root elevation (BUNK_TOP_Y for the top bunk,
   * BUNK_BOTTOM_Y for the bottom, 0 for every floor-level seat) — the tick
   * quantizes it to an "elevated" bit (flags bit3) for peers.
   */
  public getSeatedY(): number {
    return this.isSeated() && this.sitTarget ? this.sitTarget.sitY : 0;
  }

  /**
   * Public eviction wrapping the stand-up path (E3 of #25): the room editor
   * calls it before carrying the item the local player is sitting on. Any
   * deferred action is dropped — the sit is over, nothing should resume —
   * and control returns to MANUAL once the stand-up slide completes.
   */
  public evictFromSeat(): void {
    if (this.sitPhase !== 'SEATED' && this.sitPhase !== 'SIT_DOWN') return;
    this.pendingDest = null;
    this.pendingSeat = null;
    this.pendingDoor = null;
    this.pendingDevice = null;
    this._beginStandUp();
  }

  /**
   * FINE stuck watchdog (E3 review F2, belt-and-braces): every FINE phase
   * (seat / door / device) drives toward an EXACT front point with collision
   * ON and a 0.06 arrival tolerance. The placement gate's stand-point check
   * keeps PROTECTED fronts clear, but the moved item's OWN rebaked fronts
   * are never validated and computeFront's nearest-walkable fallback can
   * pick a cell that is grid-walkable yet physically pinched by inflated
   * AABBs — a wedge that would otherwise idle-walk forever. No positional
   * progress for FINE_STUCK_TIME while in any FINE phase → abandon the
   * approach, back to MANUAL, with a hint.
   */
  private _updateFineWatchdog(deltaTime: number): void {
    const inFine =
      this.sitPhase === 'FINE' || this.doorPhase === 'FINE' || this.devicePhase === 'FINE';
    const pos = this.mesh.position;
    if (!inFine) {
      this.fineStuckTimer = 0;
      this.fineLastPos.x = pos.x;
      this.fineLastPos.z = pos.z;
      return;
    }
    const moved = Math.hypot(pos.x - this.fineLastPos.x, pos.z - this.fineLastPos.z);
    this.fineLastPos.x = pos.x;
    this.fineLastPos.z = pos.z;
    if (moved > this.FINE_STUCK_EPS) {
      this.fineStuckTimer = 0;
      return;
    }
    this.fineStuckTimer += deltaTime;
    if (this.fineStuckTimer < this.FINE_STUCK_TIME) return;
    this.fineStuckTimer = 0;
    // Wedged — abandon whichever approach owns the fine step (exactly one
    // of these is non-NONE; the cancel helpers no-op for the others).
    this._abortDoorApproach();
    this._cancelDeviceApproach();
    this._cancelSit();
    this._clearPath();
    this.navMode = 'MANUAL';
    showHint("Can't reach that spot.");
  }

  /*
   * E4 remote-apply hazards (recorded for the sync slice — review F4).
   * When a REMOTE furniture move arrives via the Yjs observer and is applied
   * through this same rebuild pipeline, onObstaclesChanged as written is NOT
   * sufficient:
   *  (a) it must no-op/defer while the local player is on a scripted
   *      outside-the-room leg (door THROUGH/PEEK/RETURN, and any future
   *      ADAPTER_* vestibule phases) — those legs ignore the grid by design,
   *      and replanning mid-leg would yank the avatar through geometry;
   *      defer the reconcile until the RETURN leg completes.
   *  (b) a remote move of a device the local player is FOCUSED on (or
   *      PREPARING toward) needs a deviceFocus force-release or camera
   *      re-anchor — the eye/anchor this session's controller holds were
   *      baked in world space and went stale the moment the item moved.
   *  (c) a remote-seated player must be evicted at COMMIT time by the
   *      observer (evictFromSeat before applying the move, stand-up to the
   *      PRE-move front point) — the local pickup-time eviction in
   *      editMode.beginCarry only covers the editing client.
   *  (d) stale pendings: onObstaclesChanged never inspects pendingSeat/
   *      pendingDoor/pendingDevice. Locally unreachable (edit mode excludes
   *      every phase that queues one), but a REMOTE removal can land while a
   *      pending is parked across ENGAGED-release/STAND_UP — null any pending
   *      whose target id matches the removed item, or the player will walk
   *      over and sit on air where the chair used to be.
   */

  /**
   * The furniture layout just changed under our feet (E3 of #25 — a move was
   * committed: OBSTACLES rebuilt, walkable grid rebaked, SEATS/DEVICES
   * rederived). Reconcile navigation state with the new layout:
   *
   *  - a seat approach (APPROACH/FINE/TURN) whose seat belongs to the moved
   *    item is cancelled — its derived Seat entry was rebaked, the held
   *    reference points at the OLD world pose;
   *  - a device approach (APPROACH/FINE/TURN) to the moved item is cancelled
   *    for the same reason (the DeviceTarget's front/eye/anchor were rebaked
   *    in world space — the #33 review's exact coordination point);
   *  - a door approach is never target-cancelled here — doors cannot move in
   *    E3 and the connectivity gate guarantees enabled door fronts stay
   *    reachable — but its APPROACH leg is replanned like any other path;
   *  - a surviving WAYPOINT path is replanned from the current position to
   *    its destination (the reticle point, or the approach target's front),
   *    since the old node list may now thread through the moved footprint.
   *    If the destination became unreachable the whole route is cancelled.
   *
   * SEATED and ENGAGED poses are left alone (the editor evicts a player
   * seated ON the moved item explicitly via evictFromSeat() at pickup), as
   * is the scripted door THROUGH/PEEK/RETURN stretch outside the room.
   */
  public onObstaclesChanged(movedItemId?: string): void {
    // 1. Cancel in-flight approaches whose target item moved.
    if (
      movedItemId !== undefined &&
      (this.devicePhase === 'APPROACH' || this.devicePhase === 'FINE' || this.devicePhase === 'TURN') &&
      this.deviceTarget && this.deviceTarget.id === movedItemId
    ) {
      this._cancelDeviceApproach();
      this.navMode = 'MANUAL';
    }
    if (
      movedItemId !== undefined &&
      (this.sitPhase === 'APPROACH' || this.sitPhase === 'FINE' || this.sitPhase === 'TURN') &&
      this.sitTarget && this.sitTarget.id.startsWith(`${movedItemId}:`)
    ) {
      this._cancelSit();
      this._clearPath();
      this.navMode = 'MANUAL';
    }
    // (Door approaches: nothing to cancel — see doc comment — fall through
    //  to the replan below.)

    // 2. Replan a surviving WAYPOINT leg across the new grid.
    if (this.navMode !== 'WAYPOINT' || this.waypointPath.length === 0) return;

    const goal =
      this.sitPhase === 'APPROACH' && this.sitTarget ? this.sitTarget.front
      : this.doorPhase === 'APPROACH' && this.doorTarget ? this.doorTarget.front
      : this.devicePhase === 'APPROACH' && this.deviceTarget ? this.deviceTarget.front
      : this.waypointPath[this.waypointPath.length - 1];

    const pos = this.mesh.position;
    const path = findPath(
      worldToRow(pos.z), worldToCol(pos.x),
      worldToRow(goal.z), worldToCol(goal.x),
    );
    if (path.length === 0) {
      // Destination unreachable in the new layout (or we already stand on
      // its cell — cancelling then is harmless): stop rather than walk a
      // stale node list through the moved footprint.
      this._abortDoorApproach();
      this._cancelDeviceApproach();
      this._cancelSit();
      this._clearPath();
      this.navMode = 'MANUAL';
      return;
    }
    this.waypointPath = path;
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
      if (this.devicePhase === 'APPROACH') {
        // Arrived at (or started on) the device's front cell — fine-step next.
        this._removeReticle();
        this.devicePhase = 'FINE';
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
        if (this.devicePhase === 'APPROACH') {
          this._removeReticle();
          this.devicePhase = 'FINE';
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
    if (!seat) { this.sitPhase = 'NONE'; this.mesh.position.y = 0; return; }

    this.sitAnim = Math.min(1, this.sitAnim + deltaTime / this.SIT_ANIM_TIME);
    const t = this.sitAnim * this.sitAnim * (3 - 2 * this.sitAnim); // smoothstep
    const pos = this.mesh.position;
    pos.x = seat.front.x + (seat.sit.x - seat.front.x) * t;
    pos.z = seat.front.z + (seat.sit.z - seat.front.z) * t;
    pos.y = seat.sitY * t; // 🛏️ elevated berths (top bunk) — rises with the slide
    this.character.setState(seat.lie ? 'sleep' : 'sit_chair', seat.faceAngle);

    if (this.sitAnim >= 1) {
      this.sitPhase = 'SEATED';
    }
  }

  private _updateSeated(): void {
    const seat = this.sitTarget;
    // 🛏️ Defensive guards that reset the phase must also ground the mesh —
    // a lost sitTarget on an elevated berth would otherwise strand the
    // avatar floating at mattress height.
    if (!seat) { this.sitPhase = 'NONE'; this.mesh.position.y = 0; return; }
    this.character.setState(seat.lie ? 'sleep' : 'sit_chair', seat.faceAngle);
  }

  /** Begin standing: reverse slide from the seat to its front point. */
  private _beginStandUp(): void {
    if (this.sitPhase !== 'SEATED' && this.sitPhase !== 'SIT_DOWN') return;
    this.sitAnim = 0;
    this.standStartY = this.mesh.position.y; // 🛏️ descend from the actual height
    this.sitPhase = 'STAND_UP';
  }

  private _updateStandUp(deltaTime: number): void {
    const seat = this.sitTarget;
    if (!seat) { this.sitPhase = 'NONE'; this.mesh.position.y = 0; return; }

    this.sitAnim = Math.min(1, this.sitAnim + deltaTime / this.STAND_ANIM_TIME);
    const t = this.sitAnim * this.sitAnim * (3 - 2 * this.sitAnim); // smoothstep
    const pos = this.mesh.position;
    pos.x = seat.sit.x + (seat.front.x - seat.sit.x) * t;
    pos.z = seat.sit.z + (seat.front.z - seat.sit.z) * t;
    pos.y = this.standStartY * (1 - t); // 🛏️ climb back down to the floor
    this.character.setState('idle', seat.faceAngle);

    if (this.sitAnim >= 1) {
      pos.x = seat.front.x;
      pos.z = seat.front.z;
      pos.y = 0;
      this.logicalAngle = seat.faceAngle;
      this.sitTarget = null;
      this.sitPhase = 'NONE';
      this.navMode = 'MANUAL';

      // Resume whatever interrupted the sit.
      if (this.pendingDevice) {
        const next = this.pendingDevice;
        this.pendingDevice = null;
        this.navigateToDevice(next.device, next.hooks);
      } else if (this.pendingDoor) {
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
          this.doorTimer = 0;
          this.character.setState('idle', door.faceAngle);
          hooks.onThrough();
          // T1 branch point: a paired door begins the adapter transit —
          // walk onward into the vestibule instead of the peek look-around.
          if (hooks.beginTransit && hooks.beginTransit()) {
            const ox = Math.sin(door.faceAngle);
            const oz = Math.cos(door.faceAngle);
            this.adapterOutTarget = {
              x: door.through.x + ox * this.ADAPTER_OUT_DIST,
              z: door.through.z + oz * this.ADAPTER_OUT_DIST,
            };
            this.doorPhase = 'ADAPTER_OUT';
          } else {
            this.doorPhase = 'PEEK';
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
          if (this.pendingDevice) {
            const next = this.pendingDevice;
            this.pendingDevice = null;
            this.navigateToDevice(next.device, next.hooks);
          } else if (this.pendingDoor) {
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

      // ── T1: scripted walk onward into the vestibule (no collision) ─────────
      case 'ADAPTER_OUT': {
        const target = this.adapterOutTarget;
        if (!target) {
          // Defensive: target is always set with the phase.
          this.doorPhase = 'ADAPTER_HOLD';
          this.doorTimer = 0;
          hooks.onAdapterHold?.();
          return;
        }
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.06) {
          pos.x = target.x;
          pos.z = target.z;
          this.adapterOutTarget = null;
          this.doorPhase = 'ADAPTER_HOLD';
          this.doorTimer = 0;
          this.character.setState('idle', door.faceAngle);
          // Seal the departure door behind us; the swap runs during HOLD.
          hooks.requestClose();
          hooks.onAdapterHold?.();
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

      // ── T1: idle at the hold point while the room swap runs ────────────────
      case 'ADAPTER_HOLD': {
        this.character.setState('idle', door.faceAngle);
        this.doorTimer += deltaTime;
        if (this.doorTimer > this.ADAPTER_HOLD_TIMEOUT) {
          // Defensive cap — the swap never resolved. Re-open the door and
          // walk back inside (RETURN's completion closes it and restores
          // MANUAL). enterFromDoor still takes over cleanly if the transit
          // driver eventually resolves (it bumps doorSeq and re-targets).
          hooks.requestOpen(() => { /* fire-and-forget re-open */ });
          this.logicalAngle = snapTo8Ways(door.faceAngle + Math.PI);
          this.doorPhase = 'RETURN';
        }
        return;
      }

      // ── T1 arrival: idle at `through` (outside) while the door opens ───────
      case 'ARRIVE_OPEN': {
        this.character.setState('idle', this.logicalAngle);
        this.doorTimer += deltaTime;
        if (this.doorTimer > this.DOOR_WAIT_TIMEOUT) {
          // Door never signalled open — walk in anyway (scripted stretch;
          // being stuck outside the room would be strictly worse).
          this.doorPhase = 'ARRIVE';
        }
        return;
      }

      // ── T1 arrival: scripted walk in from `through` to `front` ─────────────
      case 'ARRIVE': {
        const dx = door.front.x - pos.x;
        const dz = door.front.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.06) {
          pos.x = door.front.x;
          pos.z = door.front.z;
          this.logicalAngle = snapTo8Ways(door.faceAngle + Math.PI); // face into the room
          this.doorPhase = 'NONE';
          this.doorTarget = null;
          this.doorHooks = null;
          this.navMode = 'MANUAL';
          this.character.setState('idle', this.logicalAngle);
          hooks.requestClose();
          // No pending resumes: everything queued before/during a transit is
          // deliberately dropped (enterFromDoor clears the pending slots).
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

  // ── Adapter transit (T1 of issue #30) ───────────────────────────────────────

  /** True while any adapter-transit door phase is active (departure hold or
   *  arrival walk-in) — all input and click navigation is swallowed then. */
  private _inAdapterTransit(): boolean {
    return (
      this.doorPhase === 'ADAPTER_OUT' ||
      this.doorPhase === 'ADAPTER_HOLD' ||
      this.doorPhase === 'ARRIVE_OPEN' ||
      this.doorPhase === 'ARRIVE'
    );
  }

  /** Current door phase (debug/verification handle — mirrors getDevicePhase). */
  getDoorPhase(): DoorPhase {
    return this.doorPhase;
  }

  /** Public mirror of _inAdapterTransit for UI gates (#52 review): true while
   *  the adapter-transit choreography owns the avatar. */
  isInAdapterTransit(): boolean {
    return this._inAdapterTransit();
  }

  /**
   * Door involved in the ACTIVE walk-through/transit sequence, or null (#51 —
   * the camera-facing door fade restores full opacity on a door while the
   * player approaches / crosses it).
   */
  public getActiveDoorId(): DoorId | null {
    return this.doorPhase !== 'NONE' && this.doorTarget ? this.doorTarget.id : null;
  }

  /**
   * Arrival leg of an adapter transit (T1): take over whatever sequence is
   * active (normally ADAPTER_HOLD mid-swap), place the avatar at the door's
   * `through` point just outside the room (skipped when `spawnAtThrough` is
   * false — the failure path walks back in from the vestibule hold point it
   * already stands on), ask the door to open, walk in to `front`, close the
   * door, and hand back MANUAL control. Deferred actions are dropped: a
   * transit is a hard scene change, nothing queued before it survives.
   */
  enterFromDoor(door: DoorTarget, hooks: DoorSequenceHooks, spawnAtThrough = true): void {
    this.doorSeq++; // invalidate any in-flight requestOpen completion
    this._cancelSit();
    this._cancelDeviceApproach();
    this.pendingDest = null;
    this.pendingSeat = null;
    this.pendingDoor = null;
    this.pendingDevice = null;
    this._clearPath();

    this.doorTarget = door;
    this.doorHooks = hooks;
    this.adapterOutTarget = null;
    if (spawnAtThrough) {
      this.mesh.position.x = door.through.x;
      this.mesh.position.z = door.through.z;
    }
    this.logicalAngle = snapTo8Ways(door.faceAngle + Math.PI); // face inward
    this.character.setState('idle', this.logicalAngle);
    this.doorTimer = 0;
    this.doorPhase = 'ARRIVE_OPEN';

    const seq = this.doorSeq;
    hooks.requestOpen(() => {
      // Ignore stale completions from a cancelled/replaced sequence.
      if (seq !== this.doorSeq || this.doorPhase !== 'ARRIVE_OPEN') return;
      this.doorPhase = 'ARRIVE';
    });
  }

  /**
   * ACCESS-pass beam-in (#52, dev phase): hard takeover that materializes
   * the avatar at (x, z), standing, in MANUAL control — no door walk, no
   * vestibule, no scripted leg; the transit curtain covers the jump. Mirrors
   * enterFromDoor's takeover discipline (invalidate in-flight door
   * callbacks, drop every pending/scripted sequence) plus two extras the
   * door path never needs: an ACTIVE sit is dropped outright (the phone
   * works while seated and a beamed clone must arrive standing — no
   * stand-up slide, the curtain hides the pose swap), and a mid-walk door
   * leg is closed behind us (the room geometry survives the swap, so an
   * abandoned open leaf would stay visibly open in the destination room).
   * A device ENGAGED state is NOT unwound here — the caller force-releases
   * the focus controller first (World.completeAccessBeamIn); the controller
   * owns the swapped camera and must restore it itself.
   */
  beamTo(x: number, z: number): void {
    this.doorSeq++; // invalidate any in-flight requestOpen completion
    this._cancelDeviceApproach();
    this.pendingDest = null;
    this.pendingSeat = null;
    this.pendingDoor = null;
    this.pendingDevice = null;
    this._clearPath();
    // Sit teardown: _cancelSit only covers the approach phases — drop
    // SIT_DOWN / SEATED / STAND_UP too (idle pose restored below).
    this.sitPhase = 'NONE';
    this.sitTarget = null;
    this.sitAnim = 0;
    // Door/adapter teardown: close whatever leaf a mid-walk leg left open
    // (closeDoor is idempotent), then drop the leg entirely.
    if (this.doorPhase !== 'NONE') this.doorHooks?.requestClose();
    this.doorPhase = 'NONE';
    this.doorTarget = null;
    this.doorHooks = null;
    this.adapterOutTarget = null;
    this.doorTimer = 0;

    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mesh.position.y = 0; // 🛏️ a beam mid-bunk lands back on the floor
    this.logicalAngle = 0; // default spawn facing (constructor pose)
    this.character.setState('idle', this.logicalAngle);
    this.navMode = 'MANUAL';
  }

  // ── Device-focus sequence (#33 D0) ──────────────────────────────────────────

  /**
   * Abandon a device approach that hasn't engaged yet (APPROACH/FINE/TURN
   * only — an ENGAGED device is released through the controller's ease via
   * releaseDevice()). Clearing the hooks here is what guards against stale
   * onArrived callbacks: TURN can only fire the hooks it still holds.
   */
  private _cancelDeviceApproach(): void {
    if (
      this.devicePhase === 'APPROACH' ||
      this.devicePhase === 'FINE' ||
      this.devicePhase === 'TURN'
    ) {
      this.devicePhase = 'NONE';
      this.deviceTarget = null;
      this.deviceHooks = null;
      this._removeReticle();
    }
  }

  /** Drive the FINE / TURN / ENGAGED device phases. */
  private _updateDevicePhase(deltaTime: number): void {
    const device = this.deviceTarget;
    const hooks = this.deviceHooks;
    if (!device || !hooks) {
      // Defensive: should be unreachable (state is only cleared with phase).
      this.devicePhase = 'NONE';
      this.deviceTarget = null;
      this.deviceHooks = null;
      return;
    }

    const pos = this.mesh.position;

    switch (this.devicePhase) {
      // ── Straight-step onto the exact front point (collision ON) ───────────
      case 'FINE': {
        const dx = device.front.x - pos.x;
        const dz = device.front.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.06) {
          pos.x = device.front.x;
          pos.z = device.front.z;
          // Turn TOWARD the device (opposite of seats' back-to-chair rule).
          this.logicalAngle = device.faceAngle;
          this.character.setState('idle', this.logicalAngle);
          this.deviceTimer = 0;
          this.devicePhase = 'TURN';
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

      // ── Brief pause while the facing snaps toward the device ──────────────
      case 'TURN': {
        this.character.setState('idle', device.faceAngle);
        this.deviceTimer += deltaTime;
        if (this.deviceTimer >= this.TURN_TIME) {
          // ENGAGED before onArrived: the one-way TURN→ENGAGED transition is
          // what makes the arrival callback fire exactly once.
          this.devicePhase = 'ENGAGED';
          hooks.onArrived();
        }
        return;
      }

      // ── Idle at the device until the controller releases us ───────────────
      case 'ENGAGED': {
        this.character.setState('idle', device.faceAngle);
        return;
      }
    }
  }
}
