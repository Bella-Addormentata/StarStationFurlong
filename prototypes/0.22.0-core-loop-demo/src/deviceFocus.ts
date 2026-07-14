/**
 * Device-focus camera controller — D0.1/D0.3 of issue #33
 * (brainstorming/device-focus-and-storage-trunk-plan.md).
 *
 * Deliberately NOT zoom level 1: level 1 is a free-look follow camera
 * (mouselook, pointer lock, per-frame player-derived position) and input.ts
 * rebinds WASD camera-relative there — a device screen needs a FIXED pose and
 * a free cursor, and world.ts must keep seeing zoom level 2 so interior
 * visibility is untouched. This controller owns its own PerspectiveCamera
 * (FOV 50) and reuses exactly two idioms from zoom.ts:
 *
 *  - the camera-swap idiom (zoom.ts:366–451): assign
 *    `window.gameRenderer.camera = cam` and restore the ortho camera on exit;
 *  - the iso-offset continuity trick (zoom.ts:318–325): start the perspective
 *    flight at `playerPos + (22, 26, 22)` — the exact isometric camera offset
 *    (renderer.ts:67) — so the first perspective frame visually matches the
 *    orthographic framing before easing down to the device eye.
 *
 * State machine:  IDLE → WALKING → FOCUSING → FOCUSED → RELEASING → IDLE
 *
 *  - WALKING   : player.navigateToDevice() drives the DevicePhase machine;
 *                the ortho camera stays live, clicks route normally.
 *  - FOCUSING  : ~450 ms smoothstep ease from the iso offset to the device
 *                eye/anchor while the avatar fades out (zoom.ts:418–430
 *                fade pattern).
 *  - FOCUSED   : avatar mesh hidden (zoom.ts:387–391 pattern), DeviceUI
 *                mounted into the #device-ui-host overlay, ui.update(dt)
 *                driven every frame.
 *  - RELEASING : reverse ease back to `playerPos + iso offset`, avatar fades
 *                back in; on completion the ortho camera is restored and
 *                player.releaseDevice() resumes any deferred seat/door/dest.
 *
 * Every exit path (Esc, WASD, canvas click, re-route request, force-release)
 * funnels through release() / forceRelease(), so the ortho camera restore and
 * player.releaseDevice() happen in exactly two places. `deviceSeq` guards
 * stale onArrived callbacks across re-entrant focus requests (mirrors
 * player.ts doorSeq).
 *
 * Module singleton — exported as `deviceFocus`, with `isDeviceFocusActive()`
 * for the input guards in zoom.ts and main.ts.
 */

import * as THREE from 'three';
import type { DeviceTarget, DeviceUI } from './devices';
import type { Player } from './player';

/**
 * PREPARING (TR2 of #35) sits between arrival and the camera ease: devices
 * with a DeviceTarget.prepare hook (the trunk's lid swing) hold there — ortho
 * camera still live, avatar visible — until prepare's onReady fires, then the
 * ease begins. Input is treated as focused during PREPARING (isActive() true:
 * +/-/m suppressed, canvas clicks release) so the camera can't be yanked to
 * another zoom level mid-choreography.
 */
type FocusState = 'IDLE' | 'WALKING' | 'PREPARING' | 'FOCUSING' | 'FOCUSED' | 'RELEASING';

/** Ease duration each way (seconds) — plan §D0.1. */
const EASE_TIME = 0.45;
/** The isometric camera offset from the look target (renderer.ts:67). */
const ISO_OFFSET = new THREE.Vector3(22, 26, 22);

class DeviceFocusController {
  private state: FocusState = 'IDLE';
  /**
   * Re-entrancy token guarding stale onArrived callbacks: incremented on
   * every beginFocus, captured into the hooks closure, and compared when the
   * player reports arrival (mirror of player.ts doorSeq).
   */
  private deviceSeq = 0;

  private player: Player | null = null;
  /** Target set by the latest beginFocus; consumed (once) at onArrived. */
  private nextTarget: { seq: number; device: DeviceTarget; ui: DeviceUI } | null = null;
  /** The device/UI currently owning the camera (FOCUSING/FOCUSED/RELEASING). */
  private active: { device: DeviceTarget; ui: DeviceUI } | null = null;
  private uiMounted = false;
  /**
   * Release-then-continue hook (#33 M2): runs exactly once after a release
   * completes (ortho camera + avatar restored, player released) — the wall
   * computer's EDIT ROOM button uses it to enter edit mode from the plain
   * isometric view. Cleared without running on forceRelease (morph restart /
   * room swap must not resurrect a deferred continuation).
   */
  private pendingReleaseContinuation: (() => void) | null = null;

  private focusCam: THREE.PerspectiveCamera | null = null;
  private orthoCam: THREE.OrthographicCamera | null = null;
  private host: HTMLDivElement | null = null;

  // Ease state (positions + look targets are lerped with smoothstep)
  private easeT = 0;
  private easeFromPos = new THREE.Vector3();
  private easeToPos = new THREE.Vector3();
  private easeFromLook = new THREE.Vector3();
  private easeToLook = new THREE.Vector3();
  private currentLook = new THREE.Vector3();

  constructor() {
    // Esc precedence (plan §D0.3), stacked so it never fights existing owners:
    //  (1) a focused text input owns Esc — blur only if it is OUR input.
    //      Guard on e.target, not document.activeElement (#31's lesson: the
    //      room-name editor replaceWith()s the input before the event bubbles
    //      here, leaving activeElement on <body>).
    //  (2) phone open → #31's handler owns Esc.
    //  (3) otherwise Esc releases an active focus.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (this.host && this.host.contains(target)) target.blur(); // blur only
        return;
      }
      if (document.getElementById('spacephone-container')?.classList.contains('active')) {
        return; // #31 owns Esc while the phone is open
      }
      if (this.state === 'PREPARING' || this.state === 'FOCUSING' || this.state === 'FOCUSED') {
        e.preventDefault();
        this.release();
      }
    });
  }

  /**
   * True while the focus sequence owns the view/input (PREPARING/FOCUSING/
   * FOCUSED/RELEASING). During PREPARING the ortho camera is technically
   * still live, but input must already behave as focused — see FocusState.
   */
  public isActive(): boolean {
    return this.state === 'PREPARING' || this.state === 'FOCUSING'
      || this.state === 'FOCUSED' || this.state === 'RELEASING';
  }

  /** Current controller state (debug/verification handle). */
  public getState(): FocusState {
    return this.state;
  }

  /**
   * Walk the player to the device and focus on arrival. Safe to call from any
   * state: while another focus is active the player defers the request
   * (pendingDevice) and asks for a release first; while walking to a
   * different device the approach is re-routed.
   */
  public beginFocus(player: Player, device: DeviceTarget, ui: DeviceUI): void {
    // Re-focus of the device that is ALREADY mid-choreography (PREPARING/
    // FOCUSING/FOCUSED) must not bump deviceSeq — the player-side machine
    // no-ops for the same device without adopting new hooks, so a bumped seq
    // would orphan the in-flight onReady/onArrived and wedge the controller.
    // (Unreachable via canvas clicks today — they release first — but cheap
    // insurance for console calls and future callers.)
    if (this.state !== 'IDLE' && this.state !== 'WALKING' && this.active?.device.id === device.id) return;
    this.player = player;
    const seq = ++this.deviceSeq;
    this.nextTarget = { seq, device, ui };
    if (this.state === 'IDLE') this.state = 'WALKING';
    player.navigateToDevice(device, {
      onArrived: () => this.onArrived(seq),
      requestRelease: () => this.release(),
    });
  }

  /**
   * Begin the release ease (FOCUSED, mid-FOCUSING, or PREPARING). No-op in
   * every other state, so repeated WASD/click/Esc release requests are
   * harmless. Release-side device choreography (DeviceTarget.onRelease — the
   * trunk lid closing) is fired here and runs in PARALLEL with the camera
   * ease (plan §TR2: unmount → closeLid ∥ ease).
   */
  public release(): void {
    if (this.state === 'PREPARING') {
      // The camera was never swapped — just reverse the prepare choreography
      // and hand control straight back (no ease to run).
      this.active?.device.onRelease?.();
      this.state = 'IDLE';
      this.active = null;
      this.player?.releaseDevice();
      return;
    }
    if (this.state !== 'FOCUSED' && this.state !== 'FOCUSING') return;
    const player = this.player;
    if (!player || !this.focusCam) { this.forceRelease(); return; }

    if (this.uiMounted && this.active) {
      this.active.ui.unmount();
      this.uiMounted = false;
    }
    this.active?.device.onRelease?.(); // e.g. trunk lid close, parallel to the ease

    // Reverse ease from wherever the camera currently is back to the exact
    // iso offset over the player (who cannot move while ENGAGED).
    const playerPos = player.getPosition();
    this.easeFromPos.copy(this.focusCam.position);
    this.easeFromLook.copy(this.currentLook);
    this.easeToPos.copy(playerPos).add(ISO_OFFSET);
    this.easeToLook.set(playerPos.x, playerPos.y + 0.6, playerPos.z);
    this.easeT = 0;
    player.mesh.visible = true; // fades back in during the ease
    this.state = 'RELEASING';
  }

  /**
   * Release the focus, then run `continuation` once the release has fully
   * completed (ortho camera restored, player released) — additive #33 M2
   * hook for the EDIT ROOM entry, which must begin from the plain isometric
   * view, not nested inside a live focus. When no focus is active the
   * continuation runs immediately.
   */
  public releaseThen(continuation: () => void): void {
    if (this.state !== 'FOCUSED' && this.state !== 'FOCUSING') {
      continuation();
      return;
    }
    this.pendingReleaseContinuation = continuation;
    this.release();
  }

  /**
   * Instant, no-ease teardown (morph restart / room swap — plan §D0.3).
   * Restores the ortho camera + avatar and releases the player immediately.
   */
  public forceRelease(): void {
    this.pendingReleaseContinuation = null; // never resurrect across a force-release
    if (this.state === 'IDLE') return;
    if (this.uiMounted && this.active) {
      this.active.ui.unmount();
      this.uiMounted = false;
    }
    this.active?.device.onRelease?.(); // reverse any prepare choreography
    if (this.isActive() && this.orthoCam) {
      (window.gameRenderer as { camera: THREE.Camera }).camera = this.orthoCam;
    }
    if (this.player) {
      this.applyAvatarOpacity(1);
      this.player.mesh.visible = true;
    }
    this.state = 'IDLE';
    this.active = null;
    this.nextTarget = null;
    this.player?.releaseDevice();
  }

  /** Drive eases + the focused UI. Called every frame from World.update. */
  public update(dt: number): void {
    if (this.state === 'FOCUSING') {
      const s = this.stepEase(dt);
      this.applyAvatarOpacity(1 - s);
      if (this.easeT >= 1) {
        // Arrived at the device eye — hide the avatar (zoom.ts:387–391
        // pattern) and mount the UI.
        if (this.player) this.player.mesh.visible = false;
        this.state = 'FOCUSED';
        if (this.active) {
          this.active.ui.mount(this.ensureHost());
          this.uiMounted = true;
        }
      }
    } else if (this.state === 'FOCUSED') {
      this.active?.ui.update(dt);
    } else if (this.state === 'RELEASING') {
      const s = this.stepEase(dt);
      this.applyAvatarOpacity(s);
      if (this.easeT >= 1) this.finishRelease();
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Player has arrived at the device front, facing it (DevicePhase ENGAGED). */
  private onArrived(seq: number): void {
    // Stale arrival from a cancelled/replaced focus request → ignore.
    if (seq !== this.deviceSeq || !this.nextTarget || this.nextTarget.seq !== seq) return;

    // Only engage from the plain isometric room view: the ortho camera must
    // be live (not zoom level 1's perspective camera) and the zoom level must
    // be 2 (v1 routing guard — plan §D0.2). Otherwise let the player go
    // rather than corrupt the camera swap.
    const zoomView = (window as unknown as { multiScaleZoom?: { getLevel?: () => number } }).multiScaleZoom;
    const zoomLevel = zoomView?.getLevel?.() ?? 2;
    const cam = window.gameRenderer?.camera;
    if (this.isActive() || zoomLevel !== 2 || !(cam instanceof THREE.OrthographicCamera)) {
      this.nextTarget = null;
      if (this.state === 'WALKING') this.state = 'IDLE';
      this.player?.releaseDevice();
      return;
    }

    this.orthoCam = cam;
    this.active = { device: this.nextTarget.device, ui: this.nextTarget.ui };
    this.nextTarget = null;

    // Pre-focus choreography (TR2): devices with a prepare hook (trunk lid)
    // hold in PREPARING — ortho camera live, avatar standing at the device —
    // until onReady, then the ease begins. deviceSeq guards a stale onReady
    // (release/re-route during the choreography bumps the seq).
    const device = this.active.device;
    if (device.prepare) {
      this.state = 'PREPARING';
      device.prepare(() => {
        if (seq !== this.deviceSeq || this.state !== 'PREPARING') return;
        this.startFocusing();
      });
      return;
    }
    this.startFocusing();
  }

  /** Swap to the focus camera and start the ease (from onArrived/PREPARING). */
  private startFocusing(): void {
    // Re-validate the camera: PREPARING suppresses zoom input (isActive()),
    // but if anything swapped the camera during the choreography, abort
    // cleanly instead of corrupting the restore-on-exit chain.
    if (!this.active || !this.orthoCam || window.gameRenderer?.camera !== this.orthoCam) {
      this.active?.device.onRelease?.();
      this.state = 'IDLE';
      this.active = null;
      this.player?.releaseDevice();
      return;
    }

    if (!this.focusCam) {
      this.focusCam = new THREE.PerspectiveCamera(
        50, window.innerWidth / window.innerHeight, 0.05, 1000,
      );
      window.addEventListener('resize', () => {
        if (this.focusCam) {
          this.focusCam.aspect = window.innerWidth / window.innerHeight;
          this.focusCam.updateProjectionMatrix();
        }
      });
    }

    const player = this.player;
    if (!player) return; // unreachable — beginFocus always sets it
    const playerPos = player.getPosition();

    // Iso-offset continuity: the perspective flight starts at the exact
    // apparent isometric viewpoint, then eases down to the device eye.
    this.easeFromPos.copy(playerPos).add(ISO_OFFSET);
    this.easeToPos.copy(this.active.device.eye);
    this.easeFromLook.set(playerPos.x, playerPos.y + 0.6, playerPos.z);
    this.easeToLook.copy(this.active.device.anchor);
    this.easeT = 0;

    this.focusCam.position.copy(this.easeFromPos);
    this.currentLook.copy(this.easeFromLook);
    this.focusCam.lookAt(this.currentLook);
    (window.gameRenderer as { camera: THREE.Camera }).camera = this.focusCam;
    this.state = 'FOCUSING';
  }

  /** Advance the current ease; positions the camera; returns smoothstep(t). */
  private stepEase(dt: number): number {
    this.easeT = Math.min(1, this.easeT + dt / EASE_TIME);
    const t = this.easeT;
    const s = t * t * (3 - 2 * t); // smoothstep
    if (this.focusCam) {
      this.focusCam.position.lerpVectors(this.easeFromPos, this.easeToPos, s);
      this.currentLook.lerpVectors(this.easeFromLook, this.easeToLook, s);
      this.focusCam.lookAt(this.currentLook);
    }
    return s;
  }

  /** Restore the ortho camera + avatar and hand control back to the player. */
  private finishRelease(): void {
    if (this.orthoCam) {
      (window.gameRenderer as { camera: THREE.Camera }).camera = this.orthoCam;
    }
    if (this.player) {
      this.applyAvatarOpacity(1);
      this.player.mesh.visible = true;
    }
    this.state = 'IDLE';
    this.active = null;
    // releaseDevice resumes any deferred seat/door/dest/device request.
    this.player?.releaseDevice();
    // Release-then-continue (#33 M2): run AFTER the camera/player restore so
    // the continuation (e.g. roomEdit.enter) starts from the plain iso view.
    const continuation = this.pendingReleaseContinuation;
    this.pendingReleaseContinuation = null;
    continuation?.();
  }

  /** Avatar fade during the eases (zoom.ts:418–430 / 452–466 pattern). */
  private applyAvatarOpacity(opacity: number): void {
    const mesh = this.player?.mesh;
    if (!mesh) return;
    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mat = child.material as THREE.Material & { opacity: number };
        mat.transparent = true;
        // Respect design opacity (e.g. the outfit visor's 0.35) — same contract
        // as zoom.ts's avatar fade. A blanket 1.0 restore would leave
        // translucent accessories permanently opaque after one focus cycle.
        mat.opacity = ((mat.userData?.baseOpacity as number) ?? 1) * opacity;
        mat.needsUpdate = true;
      }
    });
  }

  /** Full-screen inert overlay the DeviceUI panels mount into. */
  private ensureHost(): HTMLElement {
    if (!this.host) {
      this.host = document.createElement('div');
      this.host.id = 'device-ui-host';
      // pointer-events: none — the host itself never swallows canvas clicks;
      // each DeviceUI panel re-enables pointer-events and stops propagation
      // (plan §D0.3). z-index 4500: above the zoom overlay (3500), below the
      // SpacePhone (5000 — Tab stays live) and the docking pane (6000).
      this.host.style.cssText = 'position: fixed; inset: 0; z-index: 4500; pointer-events: none;';
      document.body.appendChild(this.host);
    }
    return this.host;
  }
}

/** Module singleton (plan §D0.1). */
export const deviceFocus = new DeviceFocusController();

/** Input-guard helper for zoom.ts (+/-) and main.ts ('m'). */
export function isDeviceFocusActive(): boolean {
  return deviceFocus.isActive();
}

// Permanent debug handle (kept deliberately — used for runtime verification
// of the focus state machine from the console; see PR #33 D0 evidence).
(window as unknown as { __deviceFocus: DeviceFocusController }).__deviceFocus = deviceFocus;
