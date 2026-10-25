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
import { HOLO_RADIUS, inclinationOf, inclinedPoint, plotCourses, plotMarkers, type HoloMarker } from './mapHologramLayout';
import { SPLAT_SCALE, buildSplatPlot, sparkHost, type SplatPlotHandle } from './mapHologramSplats';

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
export const ORBIT_DEFAULT: OrbitState = { yaw: 0.6, pitch: 0.42, dist: 3.4 };
/** The view drifts round the sun on its own while nobody drags (rad/s). */
export const IDLE_DRIFT = 0.06;
export const PITCH_MIN = 0.12;
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

/** How the plot is grown inside the panel: the layout's 0.5 m disc becomes
 *  a unit-ish radius, which the camera distances above are set for. */
const PANEL_SCALE = 1.2;
/** The plot's outer radius in the panel: the belt, grown as the splat plot
 *  and the panel grow it (HOLO_RADIUS × SPLAT_SCALE × PANEL_SCALE). */
export const PLOT_RADIUS = HOLO_RADIUS * SPLAT_SCALE * PANEL_SCALE;
const FOV_DEG = 42;

/**
 * The camera distance at which the plot fills the view: its full width
 * across `fill` of the panel's width, and its depth (the ring seen from
 * `pitch` above, foreshortened) across `fill` of the height — whichever
 * is the tighter. Recomputed on every resize until the player zooms.
 */
export function fitDistance(aspect: number, pitch: number, fill = 0.88, fovDeg = FOV_DEG): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  const halfW = PLOT_RADIUS, halfH = PLOT_RADIUS * Math.max(0.35, Math.sin(pitch));
  const byWidth = halfW / (fill * tanHalf * Math.max(aspect, 0.2));
  const byHeight = halfH / (fill * tanHalf);
  return Math.max(DIST_MIN, Math.min(DIST_MAX, Math.max(byWidth, byHeight)));
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
  renderer.setClearColor(0x020412, 1);
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; cursor:grab;';

  const scene = new THREE.Scene();
  scene.add(new spark.SparkRenderer({ renderer }));
  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 100);
  let orbit: OrbitState = { ...ORBIT_DEFAULT };
  /** Until the player zooms, the distance follows the panel's size. */
  let fitted = true;

  // A still sky of stars, far out.
  {
    const n = 1600;
    const pos = new Float32Array(n * 3);
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) {
      const u = rand(), v = rand();
      const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1), r = 40;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xd4a84b, size: 0.06, transparent: true, opacity: 0.55, sizeAttenuation: true }));
    scene.add(stars);
  }
  // A faint grid plane under the system, like the canvas had.
  {
    const grid = new THREE.GridHelper(6, 24, 0x7a5f2a, 0x3a2e14);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.18;
    grid.position.y = -0.02;
    scene.add(grid);
  }

  const plot = new THREE.Group();
  plot.scale.setScalar(PANEL_SCALE);
  scene.add(plot);
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
  scene.add(travelLine);
  const courseMat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5 });
  const courses: THREE.Line[] = [];
  for (let i = 0; i < 4; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COURSE_POINTS * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, courseMat);
    line.visible = false;
    scene.add(line);
    courses.push(line);
  }

  // DOM: labels over the canvas, and the hint.
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:absolute; inset:0; pointer-events:none; overflow:hidden;';
  const labels = new Map<string, HTMLSpanElement>();
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
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    down.moved = true;
    orbit = orbitDrag(orbit, e.movementX, e.movementY);
    if (fitted) orbit = { ...orbit, dist: fitDistance(camera.aspect, orbit.pitch) };
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
    if (fitted) orbit = { ...orbit, dist: fitDistance(camera.aspect, orbit.pitch) };
  };
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;

  const labelFor = (id: string): HTMLSpanElement => {
    let el = labels.get(id);
    if (!el) {
      el = document.createElement('span');
      el.style.cssText = 'position:absolute; transform:translate(-50%, 0); font-size:10px; font-family:"SF Mono", Monaco, Consolas, monospace; white-space:nowrap; text-shadow:0 0 6px rgba(0,0,0,0.9);';
      labelLayer.appendChild(el);
      labels.set(id, el);
    }
    return el;
  };

  const v = new THREE.Vector3();
  /** A marker's place in the panel's world: on its tilted orbit plane, as
   *  the splats put it, grown as they are. */
  const place3 = (mk: HoloMarker, y: number): THREE.Vector3 => {
    const p = inclinedPoint(mk.x, mk.z, inclinationOf(mk.frame));
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
      splats?.place(markers, nowMs, 1, true);
      const byId = new Map(markers.map((m) => [m.id, m]));
      // The halo on the selection, the line of a transit, the courses.
      const sel = state.selectedId ? byId.get(state.selectedId) : undefined;
      if (sel) {
        halo.visible = true;
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
      courses.forEach((line, i) => {
        const c = drawn[i];
        if (!c) { line.visible = false; return; }
        const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        const n = Math.min(c.points.length, COURSE_POINTS);
        for (let j = 0; j < n; j++) pos.setXYZ(j, c.points[j]!.x * k, 0.01 * k, c.points[j]!.z * k);
        pos.needsUpdate = true;
        line.geometry.setDrawRange(0, n);
        line.visible = n > 1;
      });
      renderer.render(scene, camera);
      // Labels: projected after the render, with the same camera.
      projected = [];
      const seen = new Set<string>();
      for (const mk of markers) {
        if (mk.type === 'asteroid-field') continue;
        const w = place3(mk, 0.02);
        w.project(camera);
        const behind = w.z > 1;
        const x = (w.x + 1) / 2 * width, y = (1 - w.y) / 2 * height;
        projected.push({ id: mk.id, x, y, behind });
        const el = labelFor(mk.id);
        seen.add(mk.id);
        const here = mk.id === state.hereId;
        el.textContent = here ? `🛸 [${mk.name}]` : mk.name;
        el.style.color = here ? '#00e676' : mk.id === state.selectedId ? '#F0C060' : 'rgba(212,168,75,0.75)';
        el.style.left = `${x}px`;
        el.style.top = `${y + (mk.type === 'star' ? 26 : mk.type === 'planet' ? 16 : 10)}px`;
        el.style.display = behind || mk.type === 'lagrange' && orbit.dist > 4 ? 'none' : '';
      }
      for (const [id, el] of labels) if (!seen.has(id)) { el.remove(); labels.delete(id); }
    },
  };
  return view;
}
