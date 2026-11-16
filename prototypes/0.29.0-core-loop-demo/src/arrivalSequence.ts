/**
 * 🎬 The arrival: a new player's first look at the game (owner's storyboard,
 * 2026-11-15). It plays once, after ENTER NOW on a first start, drawn live by
 * the game's own views, so it shows this computer's station and the
 * player's own fox at any window size:
 *
 *  1. SPACE: about ten seconds looking out into space, the sky alone,
 *     turning slowly toward the planet. On a first start the arrival lands
 *     in the welcome room, which fills in only once a computer that holds
 *     it answers; until it has, the sky holds there, drifting, for up to
 *     SPACE_HOLD_MAX_SECONDS more, with a line saying so, so the shots
 *     after it show the welcome room's own module and inside (owner,
 *     2026-11-15) rather than the stand-in the page draws before;
 *  2. APPROACH: the planet view (issue 218) from far off, closing in on the
 *     planet until it is large, the station just past its limb;
 *  3. ATLAS: a quick dip through black to the station from outside (the
 *     level-3 atlas view): the whole known station first, then closing in
 *     on the room's own module at its centre;
 *  4. FADE and BLACK: a fade to black, and under it the step into the room;
 *  5. VAT: back from black on a close view of the clone vat, then slowly out
 *     to the normal isometric room view while the vat drains and opens and
 *     the clone steps out. The vat's own spawn runs as at any start (it
 *     begins on the first frame in the room); the camera only frames it.
 *
 * Any key, click or tap skips straight to the room. The player is a clone,
 * so nothing arrives by ship: the shots go from space to the vat.
 *
 * The camera: the sky and the approach use a perspective camera of this
 * module's own (the far pass takes its direction, farOrbitView.ts); the atlas
 * and the vat shots pose the game's own orthographic camera, with the rig
 * held off (main.ts adds `isPlaying` to its busy probe), and end exactly where
 * the rig puts it, so the hand-back is seamless.
 *
 * The timeline and the camera math are pure and pinned by
 * arrivalSequence.test.ts; the driver takes the game's handles injected.
 */

import * as THREE from 'three';

/** The shots, in order. */
export type ShotName = 'space' | 'approach' | 'atlas' | 'fade' | 'black' | 'vat';

/** Each shot's length, seconds. */
export const SHOTS: readonly { readonly name: ShotName; readonly seconds: number }[] = [
  { name: 'space', seconds: 10 },
  { name: 'approach', seconds: 7 },
  { name: 'atlas', seconds: 4.5 },
  { name: 'fade', seconds: 1 },
  { name: 'black', seconds: 0.4 },
  { name: 'vat', seconds: 5.5 },
];

/** The whole arrival, seconds. */
export const ARRIVAL_SECONDS = SHOTS.reduce((s, x) => s + x.seconds, 0);

/** The far pass's own eye distance (farOrbitView.ts `EYE_DISTANCE`),
 *  compressed km. */
export const FAR_EYE_KM = 14_000;
/** The approach starts this many times farther out, the planet a dot, and
 *  ends this many times out, the planet large, the station just past its
 *  limb (nearer, the far pass tips the camera up over the planet to keep
 *  the station in sight: farOrbits.forwardClearOf). */
export const APPROACH_START_TIMES = 30;
export const APPROACH_END_TIMES = 2;
/** The cut from the approach to the atlas goes through black this quickly:
 *  down over the approach's last moment, up over the atlas's first. */
export const CUT_DIP_OUT_SECONDS = 0.15;
export const CUT_DIP_IN_SECONDS = 0.25;
/** The atlas shot starts on the whole known station, as the station view
 *  frames it, and closes in on the room's module at the centre over its
 *  first ATLAS_ZOOM_SECONDS, ending ATLAS_CLOSE times as close as the view's
 *  framing of one module alone. With only the one module known, it starts
 *  ATLAS_START_ZOOM of that framing out, so the shot still closes in. */
export const ATLAS_START_ZOOM = 0.5;
export const ATLAS_CLOSE = 1.5;
export const ATLAS_ZOOM_SECONDS = 4;
/** The vat shot starts this much closer than the room view, framed on the
 *  vat a little above the floor, and comes back from black over the first
 *  second. */
export const VAT_START_ZOOM = 3;
export const VAT_LOOK_Y = 1;
export const VAT_FADE_IN_SECONDS = 1;
/** The sky shot turns this far (radians) onto the planet's direction. */
export const SPACE_TURN_YAW = 0.7;
export const SPACE_TURN_PITCH = 0.35;
/** When the sky shot ends before the room the arrival lands in is here, the
 *  sky holds, for at most this long; then the arrival goes on, and the room
 *  fills in by itself when a computer that holds it answers. */
export const SPACE_HOLD_MAX_SECONDS = 30;
/** While it holds, the sky drifts about the vertical this fast (radians a
 *  second), getting going over SPACE_DRIFT_EASE_SECONDS; the approach turns
 *  it back onto the station's direction over its first
 *  APPROACH_SETTLE_SECONDS. */
export const SPACE_DRIFT_RATE = 0.01;
export const SPACE_DRIFT_EASE_SECONDS = 2;
export const APPROACH_SETTLE_SECONDS = 1.5;
/** The perspective camera's field of view: the far pass's own, so the sky
 *  and the far scene agree. */
export const ARRIVAL_FOV_DEG = 40;
/** A frame longer than this counts as this long: a hidden tab pauses the
 *  arrival rather than jumping it ahead. */
export const MAX_STEP_SECONDS = 0.1;

/** Where the arrival stands at `t` seconds: the shot, its own seconds and
 *  how far through it (0 to 1). Null once it is over. */
export function shotAt(t: number): { name: ShotName; index: number; at: number; p: number } | null {
  if (!(t >= 0)) t = 0;
  let start = 0;
  for (let i = 0; i < SHOTS.length; i++) {
    const s = SHOTS[i];
    if (t < start + s.seconds) {
      const at = t - start;
      return { name: s.name, index: i, at, p: at / s.seconds };
    }
    start += s.seconds;
  }
  return null;
}

/** Smootherstep: starts and ends at rest; 0 and 1 exactly at the ends. */
export function ease(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/** The approach's eye distance at `p`: geometric, so the closing speed feels
 *  even from a dot to the planet large in the view. */
export function approachEyeKm(p: number): number {
  const e = ease(p);
  return FAR_EYE_KM * Math.exp(lerp(Math.log(APPROACH_START_TIMES), Math.log(APPROACH_END_TIMES), e));
}

/** The sky shot's look direction at `p`: from a little to the side and
 *  above, turning onto `forward` (the station view's own direction), which
 *  it reaches exactly at the end. */
export function spaceLook(p: number, forward: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const f = forward.clone().normalize();
  const yaw = Math.atan2(f.x, f.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
  const e = ease(p);
  if (e >= 1) return out.copy(f);
  const y = yaw + SPACE_TURN_YAW * (1 - e);
  const pt = pitch + SPACE_TURN_PITCH * (1 - e);
  return out.set(Math.sin(y) * Math.cos(pt), Math.sin(pt), Math.cos(y) * Math.cos(pt));
}

/** How far the held sky has drifted (radians) after `heldSeconds`: from
 *  rest, then SPACE_DRIFT_RATE a second. */
export function holdDrift(heldSeconds: number): number {
  const h = Number.isFinite(heldSeconds) ? Math.max(0, heldSeconds) : 0;
  return SPACE_DRIFT_RATE * h * ease(h / SPACE_DRIFT_EASE_SECONDS);
}

/** The atlas shot's zoom at `at` seconds into it, from the station view's
 *  own zoom (`station`, which frames the whole known station) to close on
 *  the module at the centre (`module`, the view's framing of one module
 *  alone; the station's when unknown). Geometric, so the closing speed
 *  feels even however far out it starts. */
export function atlasZoom(at: number, station: number, module: number | null): number {
  const m = module !== null && Number.isFinite(module) && module > 0 ? module : station;
  const from = Math.min(station, m * ATLAS_START_ZOOM);
  const to = m * ATLAS_CLOSE;
  if (!(from > 0) || !(to > 0)) return station;
  return from * Math.pow(to / from, ease(at / ATLAS_ZOOM_SECONDS));
}

/** The black's opacity at `t` seconds into the arrival: a quick dip at the
 *  cut from the approach to the atlas, then up over the fade, full through
 *  the black, down over the vat shot's first second. */
export function blackAt(t: number): number {
  const s = shotAt(t);
  if (!s) return 0;
  if (s.name === 'approach') {
    const left = SHOTS[s.index].seconds - s.at;
    return left < CUT_DIP_OUT_SECONDS ? ease(1 - left / CUT_DIP_OUT_SECONDS) : 0;
  }
  if (s.name === 'atlas') return s.at < CUT_DIP_IN_SECONDS ? 1 - ease(s.at / CUT_DIP_IN_SECONDS) : 0;
  if (s.name === 'fade') return ease(s.p);
  if (s.name === 'black') return 1;
  if (s.name === 'vat') return 1 - ease(s.at / VAT_FADE_IN_SECONDS);
  return 0;
}

/** The skip line shows after the curtain has gone and until the vat shot. */
export const HINT_FROM_SECONDS = 1.5;
export function hintShownAt(t: number): boolean {
  const s = shotAt(t);
  return !!s && t >= HINT_FROM_SECONDS && s.name !== 'vat';
}

/** The vat shot's camera at `p`: where it looks and its zoom (a multiple of
 *  the room view's own), from the vat to the room's centre. At the end it is
 *  the room view exactly: the centre, zoom 1. */
export function vatFrame(p: number, vat: { x: number; z: number } | null): { look: THREE.Vector3; zoom: number } {
  const e = ease(p);
  const from = new THREE.Vector3(vat?.x ?? 0, VAT_LOOK_Y, vat?.z ?? 0);
  const look = from.multiplyScalar(1 - e);
  if (e >= 1) look.set(0, 0, 0);
  return { look, zoom: lerp(VAT_START_ZOOM, 1, e) };
}

// ── The driver ────────────────────────────────────────────────────────────

/** The overlay the arrival draws over the game: the black, the skip line,
 *  and what takes the clicks and keys while it plays. */
export interface ArrivalScreen {
  setBlack(opacity: number): void;
  setHint(visible: boolean): void;
  /** The line saying the sky waits for the room. */
  setWaiting(on: boolean): void;
  remove(): void;
}

/** The game's handles the arrival drives (main.ts). */
export interface ArrivalDeps {
  /** The live camera and the renderer's size. */
  camera(): THREE.Camera;
  setCamera(camera: THREE.Camera): void;
  viewSize(): { width: number; height: number };
  zoom: { getLevel(): number; stepIn(): void; stepOut(): void };
  isPlanetView(): boolean;
  farPass: { setSkyOnly(on: boolean): void; setEyeDistance(km: number | null): void };
  /** The rig's offset for an orthographic level, turned to its yaw. */
  isoOffset(level: 2 | 3, out: THREE.Vector3): THREE.Vector3;
  /** Where the clone vat stands, or null in a room without one. */
  vatCentre(): { x: number; z: number } | null;
  /** The room the arrival lands in is here: its state has reached this
   *  page, or there is nothing to wait for. */
  roomHere(): boolean;
  /** The station view's zoom framed on one module alone, and on the whole
   *  known station as it stands now, or null. Read as the atlas shot
   *  begins: the station may have grown while the arrival's own camera was
   *  up, which the station view's framing then never reached. */
  moduleZoom(): number | null;
  stationZoom(): number | null;
  screen: ArrivalScreen;
  /** Called once, when the arrival is over (played out or skipped). */
  onDone(): void;
}

export class ArrivalSequence {
  private t = 0;
  private shot = -1;
  private done = false;
  private ortho: THREE.Camera | null = null;
  private persp: THREE.PerspectiveCamera | null = null;
  /** The station view's zoom and the room view's, read as each begins. */
  private atlasBase: number | null = null;
  private atlasModule: number | null = null;
  private roomBase: number | null = null;
  /** Seconds the sky held for the room, and whether it has stopped holding
   *  (the room is here, or the hold ran out). */
  private held = 0;
  private released = false;
  private vat: { x: number; z: number } | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(private readonly deps: ArrivalDeps) {}

  isPlaying(): boolean {
    return !this.done;
  }

  /** Seconds into the arrival's timeline (the sky's hold not counted). */
  elapsed(): number {
    return this.t;
  }

  /** Seconds the sky has held for the room. */
  heldSeconds(): number {
    return this.held;
  }

  /** One frame: advance, enter a new shot when one begins, pose its camera.
   *  Run after the camera rig and before the render. */
  update(dt: number): void {
    if (this.done) return;
    try {
      const step = Math.min(MAX_STEP_SECONDS, Math.max(0, Number.isFinite(dt) ? dt : 0));
      const spaceEnd = SHOTS[0].seconds;
      if (!this.released && this.t + step >= spaceEnd && this.shot === 0) {
        if (this.deps.roomHere() || this.held >= SPACE_HOLD_MAX_SECONDS) {
          this.released = true;
          this.deps.screen.setWaiting(false);
        } else {
          // The sky shot's end, held until the room is here.
          this.held += this.t + step - spaceEnd;
          this.t = spaceEnd;
          this.posePersp(spaceLook(1, this.forward(), this.tmp2).applyAxisAngle(UP, holdDrift(this.held)));
          this.deps.screen.setBlack(0);
          this.deps.screen.setHint(true);
          this.deps.screen.setWaiting(true);
          return;
        }
      }
      this.t += step;
      const s = shotAt(this.t);
      if (!s) {
        this.finish();
        return;
      }
      while (this.shot < s.index) {
        this.shot++;
        this.enter(SHOTS[this.shot].name);
      }
      this.pose(s.name, s.at, s.p);
      this.deps.screen.setBlack(blackAt(this.t));
      this.deps.screen.setHint(hintShownAt(this.t));
    } catch (err) {
      console.warn('🎬 arrival: skipped after an error', err);
      this.skip();
    }
  }

  /** Straight to the room, from wherever the arrival stands. */
  skip(): void {
    if (this.done) return;
    try {
      this.deps.farPass.setSkyOnly(false);
      this.deps.farPass.setEyeDistance(null);
      if (this.ortho && this.deps.camera() !== this.ortho) this.deps.setCamera(this.ortho);
      if (this.deps.zoom.getLevel() === 3 && this.deps.isPlanetView()) this.deps.zoom.stepIn();
      if (this.deps.zoom.getLevel() === 3) this.deps.zoom.stepIn();
      if (this.roomBase !== null) this.poseRoom(1);
    } catch (err) {
      console.warn('🎬 arrival: could not skip cleanly', err);
    }
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    try {
      this.deps.farPass.setSkyOnly(false);
      this.deps.farPass.setEyeDistance(null);
      if (this.ortho && this.deps.camera() !== this.ortho) this.deps.setCamera(this.ortho);
      if (this.roomBase !== null) this.poseRoom(1);
    } finally {
      this.deps.screen.remove();
      this.deps.onDone();
    }
  }

  private enter(name: ShotName): void {
    const d = this.deps;
    switch (name) {
      case 'space': {
        this.ortho = d.camera();
        this.persp = new THREE.PerspectiveCamera(ARRIVAL_FOV_DEG, 1, 0.1, 1000);
        d.farPass.setSkyOnly(true);
        d.setCamera(this.persp);
        break;
      }
      case 'approach': {
        d.farPass.setSkyOnly(false);
        d.farPass.setEyeDistance(approachEyeKm(0));
        if (d.zoom.getLevel() === 3 && !d.isPlanetView()) d.zoom.stepOut();
        break;
      }
      case 'atlas': {
        d.farPass.setEyeDistance(null);
        if (d.isPlanetView()) d.zoom.stepIn();
        if (this.ortho) d.setCamera(this.ortho);
        const st = d.stationZoom();
        this.atlasBase = st !== null && Number.isFinite(st) && st > 0 ? st : zoomOf(this.ortho);
        const m = d.moduleZoom();
        this.atlasModule = m !== null && Number.isFinite(m) && m > 0 ? m : null;
        break;
      }
      case 'fade':
        break;
      case 'black': {
        // Under the black: the station view's zoom put back, then the step
        // into the room, which begins the vat's spawn on its first frame.
        if (this.ortho && this.atlasBase !== null) setZoom(this.ortho, this.atlasBase);
        if (d.zoom.getLevel() === 3) d.zoom.stepIn();
        this.roomBase = zoomOf(this.ortho);
        this.vat = d.vatCentre();
        break;
      }
      case 'vat':
        break;
    }
  }

  private pose(name: ShotName, at: number, p: number): void {
    switch (name) {
      case 'space':
        this.posePersp(spaceLook(p, this.forward(), this.tmp2));
        return;
      case 'approach': {
        this.deps.farPass.setEyeDistance(approachEyeKm(p));
        // A held sky drifted off the station's direction: turned back on.
        const back = holdDrift(this.held) * (1 - ease(at / APPROACH_SETTLE_SECONDS));
        this.posePersp(back !== 0 ? this.forward().applyAxisAngle(UP, back) : this.forward());
        return;
      }
      case 'atlas':
        this.poseAtlas(at);
        return;
      case 'fade':
        this.poseAtlas(ATLAS_ZOOM_SECONDS);
        return;
      case 'black':
        this.poseRoom(0);
        return;
      case 'vat':
        this.poseRoom(p);
    }
  }

  /** The station view's direction (the iso camera's), turned to the rig. */
  private forward(): THREE.Vector3 {
    return this.deps.isoOffset(3, this.tmp).clone().negate().normalize();
  }

  private posePersp(look: THREE.Vector3): void {
    const cam = this.persp;
    if (!cam) return;
    const { width, height } = this.deps.viewSize();
    cam.aspect = width / Math.max(1, height);
    // The exterior view writes a zoom on the live camera now and then
    // (exteriorView.ts applyExteriorZoom): this one keeps its own.
    cam.zoom = 1;
    cam.fov = ARRIVAL_FOV_DEG;
    cam.position.set(0, 0, 0);
    cam.up.set(0, 1, 0);
    cam.lookAt(look);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** The atlas shot `at` seconds in: the station view's camera, closing in
   *  on the module at the centre. */
  private poseAtlas(at: number): void {
    const cam = this.ortho;
    if (!cam) return;
    cam.position.copy(this.deps.isoOffset(3, this.tmp));
    cam.lookAt(0, 0, 0);
    if (this.atlasBase !== null) setZoom(cam, atlasZoom(at, this.atlasBase, this.atlasModule));
  }

  /** The vat shot at `p` (0 the close view, 1 the room view the rig keeps). */
  private poseRoom(p: number): void {
    const cam = this.ortho;
    if (!cam) return;
    const { look, zoom } = vatFrame(p, this.vat);
    cam.position.copy(this.deps.isoOffset(2, this.tmp)).add(look);
    cam.lookAt(look);
    if (this.roomBase !== null) setZoom(cam, this.roomBase * zoom);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function zoomOf(cam: THREE.Camera | null): number | null {
  const z = (cam as { zoom?: unknown } | null)?.zoom;
  return typeof z === 'number' && Number.isFinite(z) ? z : null;
}

function setZoom(cam: THREE.Camera, zoom: number): void {
  const c = cam as THREE.Camera & { zoom?: number; updateProjectionMatrix?: () => void };
  if (typeof c.zoom !== 'number') return;
  if (c.zoom !== zoom) {
    c.zoom = zoom;
    c.updateProjectionMatrix?.();
  }
}

/** How long after a press that skipped the arrival its click may still
 *  come, ms. A press held longer lets its click through. */
export const PAIRED_CLICK_MS = 1000;

/** A press that skips the arrival ends it before the press lifts, and the
 *  click it makes then lands on the world, whose window click handlers the
 *  skip has just armed (a device, or a walk). So the first click after it is
 *  the skip's own and is swallowed, on the window before anything else sees
 *  it. A fresh press, or `ms` with no click, ends the swallow, so the next
 *  real click goes through. Returns the way to end it early. */
export function swallowPairedClick(
  target: EventTarget,
  ms = PAIRED_CLICK_MS,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, t) => setTimeout(fn, t),
  clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): () => void {
  // An options object, not a bare `true`: Node's EventTarget reads only
  // `options.capture` when removing, so a bare `true` would never come off.
  const capture = { capture: true };
  let done = false;
  const onClick = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    end();
  };
  const end = () => {
    if (done) return;
    done = true;
    target.removeEventListener('click', onClick, capture);
    target.removeEventListener('pointerdown', end, capture);
    clearTimer(timer);
  };
  target.addEventListener('click', onClick, capture);
  target.addEventListener('pointerdown', end, capture);
  const timer = setTimer(end, ms);
  return end;
}

/** What a screen reader hears when the skip line shows: the line itself, after
 *  a word that an arrival is playing (the HUD is hidden and every key is the
 *  skip's, so nothing else says so). */
export const SKIP_LINE = 'Click or press any key to skip';
export const SKIP_SPOKEN_PREFIX = 'The arrival is playing. ';

/** The line over the skip line while the sky waits for the room. */
export function waitingLine(roomName: string): string {
  return roomName ? `Finding ${roomName}\u2026` : 'Finding the room\u2026';
}

/** The overlay in the page: a black layer the arrival fades, a quiet line
 *  saying how to skip (a polite status, so screen readers say it too), over
 *  it a line while the sky waits for `roomName`, and a surface that takes
 *  every click and tap (the keys are caught on the window by `onSkip`'s
 *  listener). */
export function domArrivalScreen(onSkip: () => void, roomName = ''): ArrivalScreen {
  const root = document.createElement('div');
  root.id = 'arrival-screen';
  root.style.cssText = 'position:fixed; inset:0; z-index:9000; pointer-events:auto; cursor:default; background:transparent;';
  const black = document.createElement('div');
  black.setAttribute('aria-hidden', 'true');
  black.style.cssText = 'position:absolute; inset:0; background:#000; opacity:0; pointer-events:none;';
  // The words go in when the line first shows, so the status is announced
  // then rather than missed while the line was still invisible.
  const hint = document.createElement('div');
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  const waiting = document.createElement('div');
  waiting.style.cssText = 'color:rgba(220,230,255,0.8); margin-bottom:4px;';
  hint.style.cssText =
    'position:absolute; left:0; right:0; bottom:28px; text-align:center; pointer-events:none; ' +
    'font:500 12px/1.4 system-ui, sans-serif; letter-spacing:0.5px; color:rgba(220,230,255,0.55); ' +
    'opacity:0; transition:opacity 0.6s ease;';
  root.append(black, hint);
  document.body.appendChild(root);
  const onPointer = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    swallowPairedClick(window);
    onSkip();
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    onSkip();
  };
  root.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey, true);
  let opacity = -1;
  let hinted: boolean | null = null;
  let worded = false;
  let waits: boolean | null = null;
  return {
    setBlack(o) {
      const v = Math.round(Math.min(1, Math.max(0, o)) * 1000) / 1000;
      if (v === opacity) return;
      opacity = v;
      black.style.opacity = String(v);
    },
    setHint(visible) {
      if (visible === hinted) return;
      hinted = visible;
      if (visible && !worded) {
        worded = true;
        const spoken = document.createElement('span');
        spoken.textContent = SKIP_SPOKEN_PREFIX;
        spoken.style.cssText =
          'position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap;';
        hint.append(waiting, spoken, SKIP_LINE);
      }
      hint.style.opacity = visible ? '1' : '0';
    },
    setWaiting(on) {
      if (on === waits) return;
      waits = on;
      waiting.textContent = on ? waitingLine(roomName) : '';
    },
    remove() {
      root.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
      root.remove();
    },
  };
}
