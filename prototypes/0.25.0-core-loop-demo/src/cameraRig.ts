/**
 * Camera Rig — 45° isometric view rotation.
 * Inputs: bottom-left HUD arrows, ←/→, and Shift+< / Shift+> hotkeys.
 *
 * The room camera has always been LOCKED to a single three-quarter angle
 * (renderer.ts parks it on the +X/+Z diagonal looking at the origin). That
 * lock hid whole sides of the location. This module keeps the lock's spirit
 * — fixed elevation, fixed radius, always looking at the room centre — but
 * lets the player swing the rig around the vertical axis in 45° detents so
 * every side of the room can be seen.
 *
 * Ownership rules (who moves which camera):
 *  - The rig repositions ONLY the orthographic room camera, and only while
 *    it is the live camera at zoom levels 2–4. Level 1 (first person),
 *    level 5+ (flat top-down maps) and device focus (#33) all swap in their
 *    own cameras / positions — the rig backs off automatically.
 *  - zoom.ts still owns frustum size and level-change snaps; it asks us for
 *    the rotated offset (rotateIsoOffset) so its snaps land on our azimuth.
 *  - input.ts keeps WASD screen-relative by rotating its world-space vector
 *    by getCameraYaw() — the same detent angle the camera uses.
 *  - Click-to-move / edit-mode raycasts need no help: they already go
 *    through the live camera every frame.
 *
 * Dependency shape: this module imports only three.js + hud so that zoom.ts,
 * input.ts and deviceFocus.ts can all import it without cycles. main.ts
 * injects the zoom-level / camera-busy probes at init (initCameraRig).
 */

import * as THREE from 'three';
import { showHint } from './hud';

// ── Constants ─────────────────────────────────────────────────────────────────

const UP = new THREE.Vector3(0, 1, 0);

/** One detent of view rotation (45°). */
const STEP_RAD = Math.PI / 4;

/**
 * Exponential ease rate (s⁻¹) for the swing between detents — reaches ~95%
 * of a 45° step in ≈0.3 s, matching the snappy feel of the zoom transitions.
 */
const EASE_RATE = 10;

/** Snap-to-detent threshold — below this remaining arc we hard-lock (rad). */
const SNAP_EPS = 0.0005;

/**
 * Base (unrotated) camera offsets per orthographic zoom level. These mirror
 * the level snaps in zoom.ts updateViewContext — zoom.ts owns the radii and
 * frustum sizes; the rig only swings the offset around the Y axis. Levels
 * absent from this table (1, 5+) are never touched by the rig.
 */
const LEVEL_OFFSETS: Record<number, THREE.Vector3> = {
  2: new THREE.Vector3(22, 26, 22),
  3: new THREE.Vector3(34, 38, 34),
  4: new THREE.Vector3(48, 54, 48),
};

/**
 * Above the zoom overlay (3500) and the DEV button (4500) so the arrows stay
 * clickable on the dev-only L3/L4 views; below the SpacePhone (5000) and the
 * hint toast (6500).
 */
const ROT_Z = 4600;

// ── State ─────────────────────────────────────────────────────────────────────

interface RigGuards {
  /** Current MultiScaleZoomView level (2 = room view). */
  getZoomLevel: () => number;
  /** True while another controller owns the camera (device focus, #33). */
  isCameraBusy: () => boolean;
}

let guards: RigGuards | null = null;

/** Detent count — unbounded integer so repeated turns never wrap mid-tween. */
let stepIndex = 0;
/** Eased yaw actually applied to the camera this frame (radians). */
let currentYaw = 0;
/** Yaw the tween is chasing: stepIndex * STEP_RAD (radians). */
let targetYaw = 0;

let leftBtn: HTMLButtonElement | null = null;
let rightBtn: HTMLButtonElement | null = null;
let angleChip: HTMLDivElement | null = null;
/** Last availability pushed to the DOM — avoids per-frame style writes. */
let lastEnabledState: boolean | null = null;

// ── Public math API (consumed by zoom.ts / deviceFocus.ts / input.ts) ────────

/**
 * Snapped view yaw in radians (always a multiple of 45°). Input mapping uses
 * this rather than the eased value so WASD direction is deterministic the
 * moment a detent is chosen, not 0.3 s later.
 */
export function getCameraYaw(): number {
  return targetYaw;
}

/**
 * Rotate a base isometric offset by the rig's CURRENT (eased) yaw.
 * Non-mutating: `base` is copied into `out` (fresh vector by default).
 * Camera-flight code (zoom.ts first-person dive, deviceFocus eases) uses
 * this so transitions depart from / return to the on-screen azimuth even if
 * a detent tween is still settling.
 */
export function rotateIsoOffset(
  base: THREE.Vector3,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  return out.copy(base).applyAxisAngle(UP, currentYaw);
}

// ── Rotation control ──────────────────────────────────────────────────────────

/** The rig only steers at ortho room scales (2–4) and never during focus. */
function canRotate(): boolean {
  if (!guards) return false;
  if (guards.isCameraBusy()) return false;
  const level = guards.getZoomLevel();
  return level >= 2 && level <= 4;
}

/**
 * Advance one 45° detent. dir = +1 swings the viewpoint clockwise around the
 * room (as seen from above), dir = -1 counter-clockwise.
 */
function rotateStep(dir: 1 | -1): void {
  if (!canRotate()) {
    showHint('VIEW ROTATION IS AVAILABLE IN ROOM VIEW ONLY');
    return;
  }
  stepIndex += dir;
  targetYaw = stepIndex * STEP_RAD;
  refreshAngleChip();
}

/** Compass-style readout of the snapped azimuth: 0° · 45° · … · 315°. */
function refreshAngleChip(): void {
  if (!angleChip) return;
  const deg = ((stepIndex % 8) + 8) % 8 * 45;
  angleChip.textContent = `${deg}°`;
}

// ── Per-frame update (called from main.ts animate loop) ──────────────────────

/**
 * Ease the yaw toward the active detent and re-apply the orbit position to
 * the orthographic camera while the rig owns the view. Also keeps the HUD
 * arrows' enabled/disabled styling in sync with availability.
 */
export function updateCameraRig(deltaTime: number): void {
  // Tween — exponential approach with a hard snap at the end.
  const remaining = targetYaw - currentYaw;
  if (Math.abs(remaining) > SNAP_EPS) {
    currentYaw += remaining * Math.min(1, EASE_RATE * deltaTime);
  } else {
    currentYaw = targetYaw;
  }

  // Reflect availability in the HUD arrows (only touch DOM on flips).
  const enabled = canRotate();
  if (enabled !== lastEnabledState) {
    lastEnabledState = enabled;
    for (const btn of [leftBtn, rightBtn]) {
      if (!btn) continue;
      btn.style.opacity = enabled ? '1' : '0.35';
      btn.style.cursor = enabled ? 'pointer' : 'default';
    }
  }

  // Steer the camera only when the ortho room camera is live at levels 2–4.
  if (!guards || guards.isCameraBusy()) return;
  const level = guards.getZoomLevel();
  const base = LEVEL_OFFSETS[level];
  if (!base) return;

  const camera = window.gameRenderer?.camera;
  if (!(camera instanceof THREE.OrthographicCamera)) return;

  camera.position.copy(base).applyAxisAngle(UP, currentYaw);
  camera.lookAt(0, 0, 0);
}

// ── Init: HUD buttons + arrow-key bindings ────────────────────────────────────

/**
 * Build the bottom-left rotation cluster and bind ←/→ keys. Call once from
 * main.ts init, after the zoom view exists. Sits to the right of the DEV
 * button (left: 24px) in the same bottom row.
 */
export function initCameraRig(rigGuards: RigGuards): void {
  guards = rigGuards;

  const wrap = document.createElement('div');
  wrap.id = 'camera-rotate-hud';
  wrap.style.cssText = `
    position: fixed;
    left: 92px;
    bottom: 24px;
    z-index: ${ROT_Z};
    display: flex;
    align-items: stretch;
    gap: 6px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    user-select: none;
  `;

  const makeButton = (glyph: string, title: string, dir: 1 | -1): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = glyph;
    btn.title = title;
    btn.style.cssText = `
      width: 34px;
      padding: 6px 0;
      background: rgba(4, 8, 22, 0.95);
      border: 1px solid rgba(212, 168, 75, 0.28);
      border-radius: 8px;
      color: #d4a84b;
      font-family: inherit;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.borderColor = 'rgba(212, 168, 75, 0.65)';
      btn.style.color = '#f0c060';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.borderColor = 'rgba(212, 168, 75, 0.28)';
      btn.style.color = '#d4a84b';
    });
    btn.addEventListener('click', (e) => {
      // Never let the rotate click double as click-to-enter / canvas click.
      e.stopPropagation();
      btn.blur();
      rotateStep(dir);
    });
    return btn;
  };

  leftBtn = makeButton('◀', 'Rotate view 45° left (← or <)', -1);
  rightBtn = makeButton('▶', 'Rotate view 45° right (→ or >)', 1);

  angleChip = document.createElement('div');
  angleChip.title = 'View rotation';
  angleChip.style.cssText = `
    min-width: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(4, 8, 22, 0.95);
    border: 1px solid rgba(212, 168, 75, 0.28);
    border-radius: 8px;
    color: rgba(212, 168, 75, 0.75);
    font-size: 11px;
    letter-spacing: 1px;
  `;

  wrap.appendChild(leftBtn);
  wrap.appendChild(angleChip);
  wrap.appendChild(rightBtn);
  document.body.appendChild(wrap);
  refreshAngleChip();

  // Keyboard complement: ←/→, plus Shift+< / Shift+> (owner request — the
  // SHIFT gate keeps the bare ,/. typing keys inert; matched via e.code so
  // the chord is layout-independent). One detent per press (ignore
  // auto-repeat), and stay out of the way of typing and of the SpacePhone
  // (same guard pattern as the zoom hotkeys in zoom.ts).
  window.addEventListener('keydown', (e) => {
    let dir: 1 | -1 | 0 = 0;
    if (e.key === 'ArrowLeft') dir = -1;
    else if (e.key === 'ArrowRight') dir = 1;
    else if (e.shiftKey && e.code === 'Comma') dir = -1;  // Shift+, → '<'
    else if (e.shiftKey && e.code === 'Period') dir = 1;  // Shift+. → '>'
    if (dir === 0) return;
    if (e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (document.getElementById('spacephone-container')?.classList.contains('active')) return;
    if (!canRotate()) return; // silent — keys shouldn't toast like misclicks
    e.preventDefault();
    rotateStep(dir);
  });

  console.log('✅ Camera rig initialized (45° view rotation, bottom-left HUD)');
}
