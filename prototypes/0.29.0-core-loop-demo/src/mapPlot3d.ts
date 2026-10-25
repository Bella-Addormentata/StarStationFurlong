/**
 * 🔮🗺️ The holotable's plot in three dimensions (#251): what the map
 * table's panel shows in place of its flat canvas where Spark runs. The
 * same splat solar system the table projects (mapHologramSplats.ts), in
 * its own small renderer inside the panel, under a perspective camera you
 * orbit by dragging and zoom with the wheel; a click on a body selects it,
 * and the panel's own sidebar (map.ts) shows the card, the atlas button
 * and TRAVEL as before. Labels are DOM, projected each frame, so they stay
 * crisp and the text stays textContent.
 *
 * Pure parts (the orbit camera, the pick) are exported for tests; the
 * renderer is made only by createPlotView3D, in the browser.
 */

import * as THREE from 'three';
import type { MapBody } from './map';
import { MAX_ORBIT_SLOTS, PLANETS } from './stations';
import { HOLO_RADIUS, HOLO_REACH, holoPoint, inclinationOf, inclinedPoint, plotCourses, plotMarkers, ringInclination, type HoloMarker } from './mapHologramLayout';
import { SPLAT_SCALE, bodyColor, buildSplatPlot, sparkHost, type SplatPlotHandle } from './mapHologramSplats';

export interface PlotFrameState {
  /** The station the player is in (map.ts playerLocationId). */
  hereId: string;
  selectedId: string | null;
  /** A transit under way: a line from here to there. */
  travel?: { fromId: string; toId: string };
}

export interface PlotView3D {
  mount(host: HTMLElement): void;
  unmount(): void;
  resize(): void;
  /** One frame: lay the bodies out at `nowMs`, draw, place the labels. */
  frame(bodies: readonly MapBody[], nowMs: number, state: PlotFrameState): void;
  onSelect(cb: (bodyId: string) => void): void;
}

/** The orbit camera: yaw round the sun, pitch above the plane, distance. */
export interface OrbitState { yaw: number; pitch: number; dist: number }
/** The view starts, and stays, above the steepest orbit's tilt (0.48 rad):
 *  a tilted ring seen from exactly its own plane collapses to a line
 *  through the sun, which read as a stray streak. */
export const ORBIT_DEFAULT: OrbitState = { yaw: 0.6, pitch: 0.56, dist: 3.4 };
/** The view drifts round the sun on its own while nobody drags (rad/s). */
export const IDLE_DRIFT = 0.06;
export const PITCH_MIN = 0.52;
export const PITCH_MAX = 1.45;
export const DIST_MIN = 1.6;
export const DIST_MAX = 7;

/** Where the camera sits for an orbit state (looking at the origin). */
export function orbitPosition(o: OrbitState): { x: number; y: number; z: number } {
  const r = Math.cos(o.pitch) * o.dist;
  return { x: Math.sin(o.yaw) * r, y: Math.sin(o.pitch) * o.dist, z: Math.cos(o.yaw) * r };
}

/** A drag of (dx, dy) pixels turns the orbit; the wheel's `steps` zoom it. */
export function orbitDrag(o: OrbitState, dx: number, dy: number): OrbitState {
  return {
    yaw: o.yaw - dx * 0.008,
    pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitch + dy * 0.008)),
    dist: o.dist,
  };
}
export function orbitZoom(o: OrbitState, steps: number): OrbitState {
  return { ...o, dist: Math.max(DIST_MIN, Math.min(DIST_MAX, o.dist * Math.pow(1.12, steps))) };
}

/** The body nearest a click, within `radius` pixels of its projected
 *  centre; the nearest wins when two overlap. */
export function pickBody(
  projected: ReadonlyArray<{ id: string; x: number; y: number; behind: boolean }>,
  x: number,
  y: number,
  radius = 28,
): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const p of projected) {
    if (p.behind) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) { bestD = d; best = p.id; }
  }
  return best;
}

/** A soft round glow, drawn once: the stars' and nebulae's sprite. */
function softSpriteTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** How the plot is grown inside the panel: the layout's 0.5 m disc becomes
 *  a unit-ish radius, which the camera distances above are set for. */
const PANEL_SCALE = 1.2;
/** The plot's outer radius in the panel: the belt, grown as the splat plot
 *  and the panel grow it (HOLO_RADIUS × SPLAT_SCALE × PANEL_SCALE). */
export const PLOT_RADIUS = HOLO_RADIUS * HOLO_REACH * SPLAT_SCALE * PANEL_SCALE;
const FOV_DEG = 42;

/** The points the fit must keep in view: the belt (tilted, with its
 *  thickness) and the haze dome's top, in the panel's world units. */
/** The picture's default reach: the belt. */
export const DEFAULT_REACH = HOLO_RADIUS * HOLO_REACH;
type Pt = { x: number; y: number; z: number };
const K = SPLAT_SCALE * PANEL_SCALE;
/** A circle's rim, tilted as given, in the panel's world units. */
function circle(cx: number, cy: number, cz: number, r: number, inc: { tilt: number; node: number }, n: number, out: Pt[], thick = 0): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const p = inclinedPoint(Math.cos(a) * r, Math.sin(a) * r, inc);
    out.push({ x: (cx + p.x) * K, y: (cy + p.y + thick) * K, z: (cz + p.z) * K });
    if (thick) out.push({ x: (cx + p.x) * K, y: (cy + p.y - thick) * K, z: (cz + p.z) * K });
  }
}
/** The points the fit must keep in view with nothing but the belt and the
 *  dome: the belt (tilted, with its thickness) and the dome's top. */
export function fitPoints(reach = DEFAULT_REACH): Pt[] {
  const pts: Pt[] = [];
  circle(0, 0, 0, reach, inclinationOf('belt-ring'), 48, pts, 0.04);
  pts.push({ x: 0, y: HOLO_RADIUS * 1.02 * 0.85 * K, z: 0 });
  return pts;
}
/** The points the fit must keep in view for THIS picture: the belt and the
 *  dome, every planet, and every station's whole ring round its planet
 *  (a high slot's ring reaches past the belt), on the ring's own tilt. */
export function fitPointsFor(markers: readonly HoloMarker[]): Pt[] {
  const pts = fitPoints();
  for (const mk of markers) {
    const p = holoPoint(mk);
    pts.push({ x: p.x * K, y: p.y * K, z: p.z * K });
    if (mk.type === 'station' && mk.orbit) {
      const c = inclinedPoint(mk.orbit.cx, mk.orbit.cz, inclinationOf(mk.frame));
      circle(c.x, c.y, c.z, mk.orbit.r, ringInclination(mk.frame, mk.orbit.r), 16, pts);
    }
  }
  return pts;
}
/** What a picture's fit depends on besides the view: the rings in it, and
 *  where their planets are — coarsely (a fiftieth of the disc), so the fit
 *  follows a planet round its orbit in steps, not every frame. */
export function fitSignature(markers: readonly HoloMarker[]): string {
  return markers
    .filter((m) => m.type === 'station' && m.orbit)
    .map((m) => `${m.frame}:${m.orbit!.r.toFixed(4)}@${(m.orbit!.cx * 50).toFixed(0)},${(m.orbit!.cz * 50).toFixed(0)}`)
    .sort()
    .join(',');
}

/** Where a world point lands in the view, as a fraction of the half-width
 *  and half-height, for the orbit camera (looking at the origin). */
export function projectNdc(p: { x: number; y: number; z: number }, o: OrbitState, aspect: number, fovDeg = FOV_DEG): { x: number; y: number; behind: boolean } {
  const c = orbitPosition(o);
  // Camera basis: forward to the origin, right, up.
  const fl = Math.hypot(c.x, c.y, c.z) || 1;
  const f = { x: -c.x / fl, y: -c.y / fl, z: -c.z / fl };
  const rl = Math.hypot(f.z, f.x) || 1;
  const r = { x: -f.z / rl, y: 0, z: f.x / rl }; // right = forward × up, in the XZ plane
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x }; // up = right × forward
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
  const depth = dx * f.x + dy * f.y + dz * f.z;
  if (depth <= 1e-6) return { x: Infinity, y: Infinity, behind: true };
  const sx = dx * r.x + dy * r.y + dz * r.z, sy = dx * u.x + dy * u.y + dz * u.z;
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  return { x: sx / (depth * tanHalf * aspect), y: sy / (depth * tanHalf), behind: false };
}

/**
 * The camera distance at which the plot fills the view: the nearest
 * distance at which every fit point, projected through the camera at
 * `pitch` from any yaw, lands within `fill` of the view's half-extents —
 * perspective, the tilts and the belt's near side included. Recomputed
 * on every resize until the player zooms.
 */
/** The yaws the fit is checked from (the view drifts round). */
export const FIT_YAWS = 24;
export function fitDistance(aspect: number, pitch: number, pts: readonly Pt[] = fitPoints(), fill = 0.88, fovDeg = FOV_DEG): number {
  // The camera bases for each yaw depend on yaw and pitch only: made once;
  // a distance then costs one multiply-add per point and axis.
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  const bases: Array<{ along: Float64Array; right: Float64Array; up: Float64Array }> = [];
  for (let k = 0; k < FIT_YAWS; k++) {
    const d = orbitPosition({ yaw: (k / FIT_YAWS) * Math.PI * 2, pitch, dist: 1 }); // the camera's direction from the sun
    const f = { x: -d.x, y: -d.y, z: -d.z };
    const rl = Math.hypot(f.z, f.x) || 1;
    const r = { x: -f.z / rl, y: 0, z: f.x / rl };
    const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    // Each point's parts along forward, right and up, from the sun.
    const along = new Float64Array(pts.length), right = new Float64Array(pts.length), up = new Float64Array(pts.length);
    pts.forEach((p, i) => {
      along[i] = p.x * f.x + p.y * f.y + p.z * f.z;
      right[i] = p.x * r.x + p.y * r.y + p.z * r.z;
      up[i] = p.x * u.x + p.y * u.y + p.z * u.z;
    });
    bases.push({ along, right, up });
  }
  // From `dist` away, a point's depth is dist + its part along forward.
  const worst = (dist: number): number => {
    let m = 0;
    for (const b of bases) {
      for (let i = 0; i < pts.length; i++) {
        const depth = dist + b.along[i]!;
        if (depth <= 1e-6) return Infinity;
        const sx = Math.abs(b.right[i]!) / (depth * tanHalf * aspect), sy = Math.abs(b.up[i]!) / (depth * tanHalf);
        if (sx > m) m = sx;
        if (sy > m) m = sy;
      }
    }
    return m;
  };
  let lo = DIST_MIN, hi = DIST_MAX;
  if (worst(hi) > fill) return hi;
  if (worst(lo) <= fill) return lo;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (worst(mid) <= fill) hi = mid; else lo = mid;
  }
  return hi;
}
/** Finer splats than the table's: the plot fills a panel here. */
const PANEL_DETAIL = 2.5;
const COURSE_POINTS = 65;

/**
 * Make the panel's 3D plot. Resolves to null where Spark is not to be had
 * (the panel keeps its canvas then), and only in a browser.
 */
export async function createPlotView3D(): Promise<PlotView3D | null> {
  if (typeof document === 'undefined') return null;
  const host0 = await sparkHost();
  if (!host0) return null;
  const { spark } = host0;

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x03040d, 1);
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; cursor:grab;';

  const scene = new THREE.Scene();
  // Last in the transparent pass, as in the room: the stars and nebulae
  // are transparent and sort by distance, and splats write no depth.
  const sparkRenderer = new spark.SparkRenderer({ renderer });
  sparkRenderer.renderOrder = 10_000;
  scene.add(sparkRenderer);
  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 100);
  let orbit: OrbitState = { ...ORBIT_DEFAULT };
  /** Until the player zooms, the distance follows the panel's size, the
   *  pitch and the picture's reach — recomputed only when one of them
   *  changes (the fit projects ~100 points from 24 yaws and bisects). */
  let fitted = true;
  let fitPts: Pt[] = fitPoints();
  let fitSig = '';
  const fitFor = { aspect: NaN, pitch: NaN, sig: '' };
  /** Fit now if the inputs changed. Called from the frame, never from a
   *  pointer event: a drag asks for it (refit) and the next frame does it
   *  once, however many moves came in between. */
  const fitNow = (): void => {
    if (!fitted) return;
    if (fitFor.aspect === camera.aspect && fitFor.pitch === orbit.pitch && fitFor.sig === fitSig) return;
    fitFor.aspect = camera.aspect; fitFor.pitch = orbit.pitch; fitFor.sig = fitSig;
    orbit = { ...orbit, dist: fitDistance(camera.aspect, orbit.pitch, fitPts) };
  };
  let fitAsked = false;
  const refit = (): void => { fitAsked = true; };

  // The galaxy: stars of every brightness and warmth, a band of them
  // across the sky like the Milky Way, and a few soft nebulae in it.
  {
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const soft = softSpriteTexture();
    const R = 40;
    // The band: a great circle tilted over, stars thick along it.
    const bandTilt = 1.05, bandTurn = 0.6;
    const onSky = (theta: number, phi: number) => {
      const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
      // Tilt the whole sky so the band leans across the view.
      const y2 = y * Math.cos(bandTilt) - z * Math.sin(bandTilt), z2 = y * Math.sin(bandTilt) + z * Math.cos(bandTilt);
      const x3 = x * Math.cos(bandTurn) - z2 * Math.sin(bandTurn), z3 = x * Math.sin(bandTurn) + z2 * Math.cos(bandTurn);
      return [x3 * R, y2 * R, z3 * R] as const;
    };
    const warmth = (t: number): [number, number, number] => (t < 0.33 ? [0.78, 0.86, 1] : t < 0.8 ? [1, 1, 1] : [1, 0.9, 0.72]);
    const layer = (n: number, size: number, opacity: number, band: boolean) => {
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const theta = 2 * Math.PI * rand();
        // Everywhere, or packed toward the band's plane (phi near π/2).
        const phi = band ? Math.PI / 2 + (rand() + rand() + rand() - 1.5) * 0.22 : Math.acos(2 * rand() - 1);
        const [x, y, z] = onSky(theta, phi);
        pos.set([x, y, z], i * 3);
        const w = warmth(rand()), b = 0.5 + 0.5 * rand();
        col.set([w[0] * b, w[1] * b, w[2] * b], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({ size, map: soft, transparent: true, opacity, vertexColors: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
      scene.add(new THREE.Points(geo, mat));
    };
    layer(3200, 0.42, 0.85, false); // the field
    layer(400, 0.95, 1, false); // the bright few
    layer(12000, 0.3, 0.6, true); // the band
    // Nebulae along the band: soft, tinted, far.
    const tints = [0x6a4cff, 0x2f7dff, 0x9b4cff, 0x2fb3c8, 0xff6aa8, 0x4c6aff];
    for (let i = 0; i < 22; i++) {
      const theta = 2 * Math.PI * rand(), phi = Math.PI / 2 + (rand() - 0.5) * 0.36;
      const [x, y, z] = onSky(theta, phi);
      const mat = new THREE.SpriteMaterial({ map: soft, color: tints[i % tints.length], transparent: true, opacity: 0.14 + rand() * 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      sp.position.set(x * 0.9, y * 0.9, z * 0.9);
      sp.scale.setScalar(22 + rand() * 20);
      scene.add(sp);
    }
  }
  // A faint grid plane under the system, like the canvas had.
  {
    const grid = new THREE.GridHelper(6, 24, 0x3a4a6a, 0x1c2438);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.14;
    grid.position.y = -0.02;
    scene.add(grid);
  }

  const plot = new THREE.Group();
  plot.scale.setScalar(PANEL_SCALE);
  scene.add(plot);
  if (import.meta.env.DEV) (window as unknown as { __plot3d?: unknown }).__plot3d = { scene, camera, plot }; // dev console poking
  let splats: SplatPlotHandle | null = null;
  void buildSplatPlot(plot, { detail: PANEL_DETAIL }).then((h) => {
    if (!h) return;
    if (disposed) { h.dispose(); return; }
    // Centred, not lifted: there is no table under it here.
    h.group.position.y = 0;
    splats = h;
  });

  // The selection halo and the transit line.
  const haloGeo = new THREE.TorusGeometry(1, 0.08, 6, 40);
  haloGeo.rotateX(Math.PI / 2);
  const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.visible = false;
  scene.add(halo);
  const lineMat = new THREE.LineDashedMaterial({ color: 0x00e676, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.9 });
  const travelGeo = new THREE.BufferGeometry();
  travelGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const travelLine = new THREE.Line(travelGeo, lineMat);
  travelLine.visible = false;
  travelLine.frustumCulled = false;
  scene.add(travelLine);
  const courseMat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5 });
  const courses: THREE.Line[] = [];
  const makeCourse = (): THREE.Line => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COURSE_POINTS * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, courseMat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    courses.push(line);
    return line;
  };
  for (let i = 0; i < MAX_ORBIT_SLOTS * PLANETS.length; i++) makeCourse();

  // DOM: labels over the canvas, and the hint.
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:absolute; inset:0; pointer-events:none; overflow:hidden;';
  const labels = new Map<string, { el: HTMLSpanElement; dot: HTMLElement; text: HTMLElement }>();
  const hint = document.createElement('div');
  hint.textContent = '🖱 DRAG to orbit · 🎡 SCROLL to zoom · CLICK body to select';
  hint.style.cssText = 'position:absolute; bottom:24px; left:24px; font-size:11px; color:rgba(212,168,75,0.55); background:rgba(4,8,22,0.85); padding:6px 12px; border-radius:6px; border:1px solid rgba(212,168,75,0.18); pointer-events:none;';

  let host: HTMLElement | null = null;
  let disposed = false;
  let selectCb: ((id: string) => void) | null = null;
  let projected: Array<{ id: string; x: number; y: number; behind: boolean }> = [];
  let width = 1, height = 1;

  // Pointer: a drag orbits, a still click picks.
  let down: { x: number; y: number; moved: boolean } | null = null;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, moved: false }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; };
  const onMove = (e: PointerEvent) => {
    if (!down) return;
    // A release the canvas missed (the panel closed mid-drag): the gesture is over.
    if (e.buttons === 0) { down = null; canvas.style.cursor = 'grab'; return; }
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    down.moved = true;
    orbit = orbitDrag(orbit, e.movementX, e.movementY);
    refit();
  };
  const onUp = (e: PointerEvent) => {
    canvas.style.cursor = 'grab';
    if (!down) return;
    const wasClick = !down.moved;
    down = null;
    if (!wasClick) return;
    const rect = canvas.getBoundingClientRect();
    const id = pickBody(projected, e.clientX - rect.left, e.clientY - rect.top);
    if (id) selectCb?.(id);
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); fitted = false; orbit = orbitZoom(orbit, Math.sign(e.deltaY)); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const resize = (): void => {
    if (!host) return;
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    refit();
  };
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;

  interface Label { el: HTMLSpanElement; dot: HTMLElement; text: HTMLElement }
  const labelFor = (id: string): Label => {
    let l = labels.get(id);
    if (!l) {
      const el = document.createElement('span');
      el.style.cssText = 'position:absolute; transform:translate(-50%, -100%); display:inline-flex; align-items:center; gap:5px; padding:2px 7px 2px 5px; border-radius:9px; background:rgba(3,6,18,0.62); border:1px solid rgba(120,150,200,0.16); font-size:10px; letter-spacing:0.6px; text-transform:uppercase; font-family:"SF Mono", Monaco, Consolas, monospace; white-space:nowrap; color:rgba(222,234,255,0.9);';
      const dot = document.createElement('i');
      dot.style.cssText = 'display:inline-block; width:6px; height:6px; border-radius:50%; box-shadow:0 0 6px currentColor; background:currentColor;';
      const text = document.createElement('b');
      text.style.cssText = 'font-weight:600; max-width:150px; overflow:hidden; text-overflow:ellipsis;';
      el.appendChild(dot); el.appendChild(text);
      labelLayer.appendChild(el);
      l = { el, dot, text };
      labels.set(id, l);
    }
    return l;
  };
  const css = (hex: number) => '#' + hex.toString(16).padStart(6, '0');

  const v = new THREE.Vector3();
  /** A marker's place in the panel's world: on its tilted orbit plane, as
   *  the splats put it, grown as they are. */
  const place3 = (mk: HoloMarker, y: number): THREE.Vector3 => {
    const p = holoPoint(mk);
    return v.set(p.x, y + p.y, p.z).multiplyScalar(PANEL_SCALE * (splats ? splats.group.scale.x : 1));
  };
  let lastFrameMs = 0;

  const view: PlotView3D = {
    mount(h) {
      host = h;
      h.appendChild(canvas);
      h.appendChild(labelLayer);
      h.appendChild(hint);
      observer?.observe(h);
      resize();
    },
    unmount() {
      disposed = true;
      observer?.disconnect();
      canvas.remove(); labelLayer.remove(); hint.remove();
      splats?.dispose();
      renderer.dispose();
      host = null;
    },
    resize,
    onSelect(cb) { selectCb = cb; },
    frame(bodies, nowMs, state) {
      if (!host || disposed) return;
      if (host.clientWidth !== width || host.clientHeight !== height) resize();
      // The idle drift: a slow turn round the sun while nobody drags.
      const dt = lastFrameMs ? Math.min(0.1, (nowMs - lastFrameMs) / 1000) : 0;
      lastFrameMs = nowMs;
      if (!down) orbit = { ...orbit, yaw: orbit.yaw + IDLE_DRIFT * dt };
      const p = orbitPosition(orbit);
      camera.position.set(p.x, p.y, p.z);
      camera.lookAt(0, 0, 0);
      const markers = plotMarkers(bodies, nowMs, state.hereId);
      // The rings in the picture can change (a station on a high slot
      // reaches past the belt): refit to the picture then.
      const sig = fitSignature(markers);
      if (sig !== fitSig) { fitSig = sig; fitPts = fitPointsFor(markers); refit(); }
      if (fitAsked) { fitAsked = false; fitNow(); }
      splats?.place(markers, nowMs, 1, true);
      const byId = new Map(markers.map((m) => [m.id, m]));
      // The halo on the selection, the line of a transit, the courses.
      const sel = state.selectedId ? byId.get(state.selectedId) : undefined;
      if (sel) {
        halo.visible = true;
        (halo.material as THREE.MeshBasicMaterial).color.setHex(bodyColor({ ...sel, here: false }));
        halo.position.copy(place3(sel, 0.012));
        halo.scale.setScalar((sel.type === 'star' ? 0.12 : 0.07) * (1 + 0.12 * Math.sin(nowMs / 160)));
      } else halo.visible = false;
      const from = state.travel ? byId.get(state.travel.fromId) : undefined;
      const to = state.travel ? byId.get(state.travel.toId) : undefined;
      if (from && to) {
        const pos = travelGeo.getAttribute('position') as THREE.BufferAttribute;
        const a = place3(from, 0.02).clone(), b = place3(to, 0.02);
        pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z);
        pos.needsUpdate = true;
        travelLine.computeLineDistances();
        travelLine.visible = true;
      } else travelLine.visible = false;
      const drawn = plotCourses(bodies, nowMs);
      const k = PANEL_SCALE * (splats ? splats.group.scale.x : 1);
      while (courses.length < drawn.length) makeCourse(); // one per moving station, however many
      courses.forEach((line, i) => {
        const c = drawn[i];
        if (!c) { line.visible = false; return; }
        const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        const n = Math.min(c.points.length, COURSE_POINTS);
        for (let j = 0; j < n; j++) pos.setXYZ(j, c.points[j]!.x * k, (0.01 + c.points[j]!.y) * k, c.points[j]!.z * k);
        pos.needsUpdate = true;
        line.geometry.setDrawRange(0, n);
        line.visible = n > 1;
      });
      renderer.render(scene, camera);
      // Labels: projected after the render, with the same camera; laid out
      // so none covers another (the sun, the planets, here and the
      // selection first; a label with no clear spot nearby is left out).
      projected = [];
      const seen = new Set<string>();
      const pending: Array<{ mk: HoloMarker; x: number; y: number; l: Label; rank: number }> = [];
      for (const mk of markers) {
        const w = place3(mk, 0.02);
        w.project(camera);
        const behind = w.z > 1;
        const x = (w.x + 1) / 2 * width, y = (1 - w.y) / 2 * height;
        projected.push({ id: mk.id, x, y, behind });
        const l = labelFor(mk.id);
        seen.add(mk.id);
        const here = mk.id === state.hereId;
        const selected = mk.id === state.selectedId;
        const colour = css(bodyColor({ ...mk, here }));
        l.text.textContent = here ? `🛸 ${mk.name}` : mk.name;
        l.dot.style.color = colour;
        l.el.style.color = here ? '#3dff9a' : selected ? '#ffffff' : 'rgba(222,234,255,0.88)';
        l.el.style.borderColor = selected ? colour : here ? 'rgba(61,255,154,0.5)' : 'rgba(120,150,200,0.16)';
        if (behind || (mk.type === 'lagrange' && orbit.dist > 4)) { l.el.style.display = 'none'; continue; }
        const rank = mk.type === 'star' ? 0 : mk.type === 'planet' ? 1 : here ? 2 : selected ? 3 : mk.type === 'lagrange' ? 4 : mk.type === 'asteroid-field' ? 6 : 5;
        // Floating over the body: the pill's foot clears its glow.
        pending.push({ mk, x, y: y - (mk.type === 'star' ? 34 : mk.type === 'planet' ? 26 : 14), l, rank });
      }
      pending.sort((a, b) => a.rank - b.rank);
      // Show every candidate, then measure them all in one layout, then
      // place them: no read after a write in the loop, so one reflow a frame.
      for (const p of pending) p.l.el.style.display = '';
      const sizes = pending.map((p) => ({ w: p.l.el.offsetWidth || 80, h: p.l.el.offsetHeight || 18 }));
      const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      pending.forEach((p, i) => {
        const { w, h } = sizes[i]!;
        const fits = (cx: number, cy: number) => {
          const r = { x0: cx - w / 2 - 2, y0: cy - h - 1, x1: cx + w / 2 + 2, y1: cy + 1 };
          return placed.every((q) => r.x1 <= q.x0 || r.x0 >= q.x1 || r.y1 <= q.y0 || r.y0 >= q.y1) ? r : null;
        };
        let spot: { x0: number; y0: number; x1: number; y1: number } | null = null, lx = p.x, ly = p.y;
        for (const [dx, dy] of [[0, 0], [0, -20], [0, -40], [w * 0.6, -14], [-w * 0.6, -14], [0, -60], [w * 0.6, -36], [-w * 0.6, -36], [0, 44]]) {
          spot = fits(p.x + dx, p.y + dy);
          if (spot) { lx = p.x + dx; ly = p.y + dy; break; }
        }
        if (!spot) { p.l.el.style.display = 'none'; return; }
        placed.push(spot);
        p.l.el.style.left = `${lx}px`;
        p.l.el.style.top = `${ly}px`;
      });
      for (const [id, l] of labels) if (!seen.has(id)) { l.el.remove(); labels.delete(id); }
    },
  };
  return view;
}
