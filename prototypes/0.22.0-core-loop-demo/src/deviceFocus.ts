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

type FocusState = 'IDLE' | 'WALKING' | 'FOCUSING' | 'FOCUSED' | 'RELEASING';

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
      if (this.state === 'FOCUSING' || this.state === 'FOCUSED') {
        e.preventDefault();
        this.release();
      }
    });
  }

  /** True while the focus camera owns the view (FOCUSING/FOCUSED/RELEASING). */
  public isActive(): boolean {
    return this.state === 'FOCUSING' || this.state === 'FOCUSED' || this.state === 'RELEASING';
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
   * Begin the release ease (FOCUSED or mid-FOCUSING). No-op in every other
   * state, so repeated WASD/click/Esc release requests are harmless.
   */
  public release(): void {
    if (this.state !== 'FOCUSED' && this.state !== 'FOCUSING') return;
    const player = this.player;
    if (!player || !this.focusCam) { this.forceRelease(); return; }

    if (this.uiMounted && this.active) {
      this.active.ui.unmount();
      this.uiMounted = false;
    }

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
   * Instant, no-ease teardown (morph restart / room swap — plan §D0.3).
   * Restores the ortho camera + avatar and releases the player immediately.
   */
  public forceRelease(): void {
    if (this.state === 'IDLE') return;
    if (this.uiMounted && this.active) {
      this.active.ui.unmount();
      this.uiMounted = false;
    }
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
