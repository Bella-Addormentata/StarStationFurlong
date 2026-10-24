/**
 * 🔍 First-person zoom: the mouse wheel (and a two-finger pinch on a touch
 * screen) narrows or widens the field of view of a perspective camera, so a
 * player can zoom in on the TV from the sofa, or size a game table or an
 * arcade screen to their own screen while the game holds the camera still.
 *
 * Only the field of view changes; the eye stays where it is, so nothing can
 * see through a wall. The view is held between FOV_MIN and FOV_MAX degrees
 * (vertical), which keeps it short of a fisheye or a pinhole.
 *
 * Two cameras use it: the free-look first-person camera (zoom.ts, level 1)
 * and the device-focus camera (deviceFocus.ts: craps and the other tables,
 * the arcade cabinets, the TV and so on). Each owns one FovZoom; main.ts
 * routes the wheel and the pinch to whichever is live.
 */

/** Narrowest view, degrees of vertical field of view (about 4x in at 65°). */
export const FOV_MIN = 16;
/** Widest view; beyond this the room bends like a fisheye. */
export const FOV_MAX = 85;

/** A notched wheel sends about 100 px per notch; one notch is about 12%. */
const WHEEL_NOTCH_PX = 100;
const WHEEL_STEP_PER_NOTCH = 0.12;
/** Seconds for the view to settle on a new zoom. */
const EASE_SECONDS = 0.08;

export function clampFov(fov: number): number {
  if (!Number.isFinite(fov)) return FOV_MAX;
  return Math.min(FOV_MAX, Math.max(FOV_MIN, fov));
}

/** A wheel event's vertical travel in pixels, whatever unit it came in. */
export function wheelPixels(e: { deltaY: number; deltaMode: number }): number {
  if (e.deltaMode === 1) return e.deltaY * (WHEEL_NOTCH_PX / 3); // lines
  if (e.deltaMode === 2) return e.deltaY * WHEEL_NOTCH_PX * 3; // pages
  return e.deltaY;
}

/** The field of view after the wheel turns `px`: down (positive) widens,
 *  up narrows, by the same factor per notch either way. */
export function fovAfterWheel(fov: number, px: number): number {
  if (!Number.isFinite(px)) return clampFov(fov);
  return clampFov(fov * Math.exp((px / WHEEL_NOTCH_PX) * WHEEL_STEP_PER_NOTCH));
}

/** The field of view while a pinch that began `startDist` apart at
 *  `startFov` is now `dist` apart: fingers apart zooms in. */
export function fovAfterPinch(startFov: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0)) return clampFov(startFov);
  // Field of view goes with the tangent of the half angle, so the thing
  // under the fingers grows by exactly the spread of the fingers.
  const half = (startFov * Math.PI) / 360;
  return clampFov((Math.atan(Math.tan(half) * (startDist / dist)) * 360) / Math.PI);
}

/** One camera's zoom: where the player has asked it to be and where the
 *  view is now, eased toward each other a frame at a time. */
export class FovZoom {
  private target: number;
  private current: number;
  private pinchFov = 0;
  private pinchDist = 0;

  constructor(readonly baseFov: number) {
    this.target = clampFov(baseFov);
    this.current = this.target;
  }

  wheel(px: number): void {
    this.target = fovAfterWheel(this.target, px);
  }

  pinchStart(dist: number): void {
    this.pinchFov = this.target;
    this.pinchDist = dist;
  }

  pinchMove(dist: number): void {
    if (this.pinchDist > 0) this.target = fovAfterPinch(this.pinchFov, this.pinchDist, dist);
  }

  pinchEnd(): void {
    this.pinchDist = 0;
  }

  /** Back to the camera's own field of view at once. */
  reset(): void {
    this.target = clampFov(this.baseFov);
    this.current = this.target;
    this.pinchDist = 0;
  }

  /** Finish any ease at once: the view is where the player asked. */
  snap(): void {
    this.current = this.target;
  }

  /** The field of view the player has asked for. */
  targetFov(): number {
    return this.target;
  }

  /** Ease toward the asked-for view over `dt` seconds; returns the view. */
  step(dt: number): number {
    const k = dt > 0 ? 1 - Math.exp(-dt / EASE_SECONDS) : 0;
    this.current += (this.target - this.current) * k;
    if (Math.abs(this.target - this.current) < 0.01) this.current = this.target;
    return this.current;
  }
}

/**
 * Whether a wheel or a touch on `target` is meant for the camera: on the
 * game canvas itself, or on a device's full-screen play layer (the craps
 * felt, an arcade cabinet), but never in a text box or over a list or panel
 * that scrolls, which keeps the wheel for itself.
 */
export function wheelTargetZooms(target: Element | null, canvas: Element | null, host: Element | null): boolean {
  if (!target) return false;
  if (target === canvas) return true;
  if (!host || !host.contains(target)) return false;
  for (let el: Element | null = target; el && el !== host; el = el.parentElement) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable) return false;
    if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return false;
    }
  }
  return true;
}
