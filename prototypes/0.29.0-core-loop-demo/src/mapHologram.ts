/**
 * 🔮 The map table's hologram (#251, follow-up to #33): the solar plot and
 * the station you are in, floating over the table as cyan light, for
 * everyone in the room. Built with the table (buildMapTable), driven every
 * frame by World through the `mapHologram` handle (furnitureHandles.ts),
 * and laid out by mapHologramLayout.ts from the same data the table's
 * panel plots — nothing renders outside the isometric room view (#33).
 *
 * Every mesh is built up front and parked (scale 0) when it has nothing to
 * show, so the whole hologram rides the room's fade-in, the zoom-out hide
 * and the removal dispose like any other part of the table. Only the
 * course lines are THREE.Line, which World does not file; their opacity
 * follows the sun's, so they fade with the rest.
 */

import * as THREE from 'three';
import type { MapBody } from './map';
import { solarPlotBodies } from './map';
import { MAX_ORBIT_SLOTS, PLANETS, currentRoomId, listStations } from './stations';
import { MAX_ENTRIES, readAtlas } from './stationAtlas';
import { stationPlan } from './stationPlan';
import { holotableStation } from './devices';
import { buildSplatPlot, noteRoomSplatsDrawn, type SplatPlotHandle } from './mapHologramSplats';
import {
  FADE_SECONDS,
  HOLO_RADIUS,
  beltRadius,
  holoModeAt,
  plotCourses,
  plotMarkers,
  stationLayout,
  type StationHologram,
} from './mapHologramLayout';

/** Is `obj` drawn: it and every parent visible, all the way up to a scene
 *  (a table taken out of the room hangs from nothing)? */
function drawnInScene(obj: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    if (!o.visible) return false;
    if ((o as THREE.Scene).isScene) return true;
  }
  return false;
}

/** What World drives: one call per frame. */
export interface MapHologramHandle {
  update(dt: number): void;
}

/** The slice of the furniture BuildCtx the hologram needs. */
export interface MapHologramCtx {
  attach: (obj: THREE.Object3D) => void;
}

const CYAN = 0x00e5ff;
const PALE = 0x9ff6ff;
const AMBER = 0xffc46b;
/** How often the stations, the atlas and "here" are re-read (ms). */
export const REFRESH_MS = 2000;
/** The hologram's slow turn (rad/s). */
const SPIN = 0.12;
const COURSE_POINTS = 65;
/** Pool sizes — starting sizes: every pool but the planets' grows past
 *  them (Pool, `grow`). Stations: listStations seats MAX_ORBIT_SLOTS per
 *  planet, but a station in transit holds no slot and a bounced arrival
 *  can share a full one, so the list can run past that; the courses (one
 *  per moving station) likewise. Modules and ships: the atlas holds
 *  MAX_ENTRIES rooms, but stationPlan also places rooms known only as a
 *  door's far side. */
const MAX_STATIONS = MAX_ORBIT_SLOTS * PLANETS.length;
const POOL = { planets: PLANETS.length + 2, lagrange: 4, stations: MAX_STATIONS, courses: MAX_STATIONS, modules: MAX_ENTRIES, links: MAX_ENTRIES * 2 };
/** The layer parked pool meshes sit on: one the camera never renders, so a
 *  parked slot costs no draw call. World's zoom hide works on `visible`,
 *  which this leaves alone. Taken, a mesh is back on the default layer. */
const PARKED_LAYER = 31;
function park(mesh: THREE.Object3D): void { mesh.layers.set(PARKED_LAYER); }
function show(mesh: THREE.Object3D): void { mesh.layers.set(0); }
/** Module block heights on the disc (metres). */
const MODULE_H = 0.03;
const SHIP_H = 0.02;
const HERE_RING = 0.028;

function holoMat(color: number, baseOpacity: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  m.userData.baseOpacity = baseOpacity;
  return m;
}

/** A pool of parked meshes sharing one geometry; `take` hands out the next
 *  (on the camera's layer); `park` puts the rest back off it. A pool that
 *  may `grow` makes more when it runs out: those are not in World's mesh
 *  list (built after the table was registered), so the owner mirrors the
 *  sun mesh's `visible` onto them each frame (World's zoom hide), and they
 *  share the pool's material, so the room's fade reaches them too. */
class Pool {
  readonly meshes: THREE.Mesh[] = [];
  /** The meshes made after registration (see above). */
  readonly grown: THREE.Mesh[] = [];
  private used = 0;
  constructor(
    private readonly parent: THREE.Object3D,
    n: number,
    private readonly geo: THREE.BufferGeometry,
    private readonly mat: THREE.Material,
    private readonly grow = false,
  ) {
    for (let i = 0; i < n; i++) this.meshes.push(this.make());
  }
  private make(): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo, this.mat);
    park(mesh);
    this.parent.add(mesh);
    return mesh;
  }
  reset(): void {
    this.used = 0;
  }
  take(): THREE.Mesh | null {
    if (this.used >= this.meshes.length) {
      if (!this.grow) return null;
      const mesh = this.make();
      this.meshes.push(mesh);
      this.grown.push(mesh);
    }
    const mesh = this.meshes[this.used++]!;
    show(mesh);
    return mesh;
  }
  /** Park every mesh not taken since reset(). */
  park(): void {
    for (let i = this.used; i < this.meshes.length; i++) park(this.meshes[i]!);
  }
}

interface Layer {
  group: THREE.Group;
  mats: THREE.Material[];
  lastFade: number;
}

/**
 * Build the hologram into the table's item group: the picture plane at
 * `planeY`, the light cone up to it from the emitter at `apexY` (both in
 * the table's frame). Returns the frame handle, which the sun mesh also
 * carries as `userData.mapHologram` for World to file.
 */
export function buildMapHologram(ctx: MapHologramCtx, planeY: number, apexY: number): MapHologramHandle {
  const root = new THREE.Group();
  root.name = 'map-hologram';
  root.position.y = planeY;
  ctx.attach(root);

  // The light cone, emitter to disc.
  const coneH = Math.max(0.01, planeY - apexY);
  const coneGeo = new THREE.ConeGeometry(HOLO_RADIUS + 0.08, coneH, 32, 1, true);
  coneGeo.rotateX(Math.PI); // apex down
  coneGeo.translate(0, -coneH / 2, 0); // base on the plane, apex on the emitter
  root.add(new THREE.Mesh(coneGeo, holoMat(CYAN, 0.05)));

  // ── The plot ────────────────────────────────────────────────────────────
  const plotGroup = new THREE.Group();
  root.add(plotGroup);
  const sunMat = holoMat(PALE, 0.9);
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), sunMat);
  sun.position.y = 0.02;
  plotGroup.add(sun);
  const planetMat = holoMat(CYAN, 0.85);
  const planets = new Pool(plotGroup, POOL.planets, new THREE.SphereGeometry(0.014, 12, 8), planetMat);
  const lagrangeMat = holoMat(CYAN, 0.5);
  const lagrange = new Pool(plotGroup, POOL.lagrange, new THREE.OctahedronGeometry(0.007), lagrangeMat);
  const stationMat = holoMat(PALE, 0.9);
  const stationGeo = new THREE.OctahedronGeometry(0.011);
  stationGeo.scale(1, 1.5, 1);
  const stations = new Pool(plotGroup, POOL.stations, stationGeo, stationMat, true);
  // Orbit rings: unit tori scaled to each orbit (the tube scales with them,
  // so a station's small ring gets the fatter tube).
  const ringMat = holoMat(CYAN, 0.22);
  const planetRingGeo = new THREE.TorusGeometry(1, 0.012, 6, 64);
  planetRingGeo.rotateX(Math.PI / 2);
  const planetRings = new Pool(plotGroup, POOL.planets, planetRingGeo, ringMat);
  const stationRingGeo = new THREE.TorusGeometry(1, 0.05, 6, 48);
  stationRingGeo.rotateX(Math.PI / 2);
  const stationRings = new Pool(plotGroup, POOL.stations, stationRingGeo, ringMat, true);
  // The belt: its radius is the plot's own, so it is built once here.
  const beltR = beltRadius(solarPlotBodies([]));
  const beltMat = holoMat(CYAN, 0.12);
  let beltMesh: THREE.Mesh | null = null;
  if (beltR) {
    const beltGeo = new THREE.TorusGeometry(beltR, 0.006, 6, 96);
    beltGeo.rotateX(Math.PI / 2);
    beltMesh = new THREE.Mesh(beltGeo, beltMat);
    plotGroup.add(beltMesh);
  }
  // "You are here": a pulsing amber ring round the station you are in.
  const hereMat = holoMat(AMBER, 0.9);
  const hereGeo = new THREE.TorusGeometry(1, 0.1, 6, 32);
  hereGeo.rotateX(Math.PI / 2);
  const hereRing = new THREE.Mesh(hereGeo, hereMat);
  park(hereRing);
  plotGroup.add(hereRing);
  // Courses of stations on their way to another planet.
  const courseMat = new THREE.LineBasicMaterial({
    color: AMBER,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const COURSE_OPACITY = 0.6;
  const courses: THREE.Line[] = [];
  // Their own group: it rides along with the splat plot (lifted and grown)
  // when that is what shows, and stays put over the mesh plot otherwise.
  const courseGroup = new THREE.Group();
  plotGroup.add(courseGroup);
  const makeCourse = (): THREE.Line => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COURSE_POINTS * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, courseMat);
    line.visible = false;
    line.frustumCulled = false; // its bounds are never recomputed as its points change
    courseGroup.add(line);
    courses.push(line);
    return line;
  };
  for (let i = 0; i < POOL.courses; i++) makeCourse();
  const plot: Layer = {
    group: plotGroup,
    mats: [sunMat, planetMat, lagrangeMat, stationMat, ringMat, beltMat, hereMat],
    lastFade: 1,
  };
  // ✨ v2: the plot as Gaussian splats (mapHologramSplats.ts) where Spark
  // loads; the mesh plot above is parked then and keeps the sun as the
  // carrier of World's fade and zoom hide. Lines (the courses) stay.
  let splatPlot: SplatPlotHandle | null = null;
  let splatsWanted = true;
  void buildSplatPlot(plotGroup).then((h) => {
    if (!splatsWanted) h?.dispose();
    else splatPlot = h;
  });
  root.userData.disposeSplatPlot = () => { splatsWanted = false; splatPlot?.dispose(); splatPlot = null; };
  // The course lines are not meshes, so World's removal (which disposes
  // every mesh's geometry and material) never reaches them: freed here.
  root.userData.disposeCourses = () => {
    for (const line of courses) line.geometry.dispose();
    courseMat.dispose();
  };

  // ── The station ─────────────────────────────────────────────────────────
  const stationGroup = new THREE.Group();
  stationGroup.visible = false;
  root.add(stationGroup);
  const blockGeo = new THREE.BoxGeometry(1, 1, 1);
  blockGeo.translate(0, 0.5, 0); // base on the plane
  const moduleMat = holoMat(CYAN, 0.35);
  const hereModuleMat = holoMat(PALE, 0.6);
  const shipMat = holoMat(AMBER, 0.4);
  const modules = new Pool(stationGroup, POOL.modules, blockGeo, moduleMat, true);
  const linkMat = holoMat(CYAN, 0.5);
  const links = new Pool(stationGroup, POOL.links, new THREE.BoxGeometry(1, 1, 1), linkMat, true);
  const station: Layer = {
    group: stationGroup,
    mats: [moduleMat, hereModuleMat, shipMat, linkMat],
    lastFade: 0,
  };

  // ── Data ────────────────────────────────────────────────────────────────
  let bodies: MapBody[] = solarPlotBodies([]);
  let hereId = '';
  let stationHolo: StationHologram | null = null;
  let lastRefresh = -Infinity;
  /** Re-read what the table would plot: the stations listed, "here", and
   *  the plan of the station you are in. Whatever throws (a doc not bound
   *  yet) leaves the last picture standing. */
  const refresh = (): void => {
    try {
      const listed = listStations();
      bodies = solarPlotBodies(listed);
      const here = holotableStation();
      hereId = here?.id ?? '';
      stationHolo = here?.welcomeRoomId
        ? stationLayout(stationPlan(readAtlas(), here.welcomeRoomId, currentRoomId()))
        : null;
    } catch {
      /* keep the last picture */
    }
  };

  const setLayer = (layer: Layer, fade: number): void => {
    layer.group.visible = fade > 0;
    if (fade === layer.lastFade) return;
    layer.lastFade = fade;
    for (const m of layer.mats) m.opacity = ((m.userData.baseOpacity as number) ?? 1) * fade;
  };

  const layoutPlot = (now: number, fade: number): void => {
    const markers = plotMarkers(bodies, now, hereId);
    const sunBase = (sunMat.userData.baseOpacity as number) || 1;
    if (splatPlot) {
      // The splats take the sun's fade (World's) and the plot's own.
      // The sun's opacity already carries the plot's own fade (setLayer ran
      // before this) on top of World's: pass it through once, not squared.
      splatPlot.place(markers, now, sunMat.opacity / sunBase, sun.visible);
      courseGroup.position.copy(splatPlot.group.position);
      courseGroup.scale.copy(splatPlot.group.scale);
      planets.reset(); lagrange.reset(); stations.reset(); planetRings.reset(); stationRings.reset();
      planets.park(); lagrange.park(); stations.park(); planetRings.park(); stationRings.park();
      park(hereRing);
      park(sun);
      if (beltMesh) park(beltMesh);
    } else {
      show(sun);
      if (beltMesh) show(beltMesh);
      courseGroup.position.set(0, 0, 0);
      courseGroup.scale.setScalar(1);
      layoutMeshPlot(markers, now);
    }
    // The splat plot stands its bodies at their tilted heights, so its
    // courses carry theirs; the mesh plot is flat, and so are its courses.
    layoutCourses(now, fade, sunBase, splatPlot !== null);
  };

  const layoutMeshPlot = (markers: readonly ReturnType<typeof plotMarkers>[number][], now: number): void => {
    planets.reset(); lagrange.reset(); stations.reset(); planetRings.reset(); stationRings.reset();
    let here: { x: number; z: number } | null = null;
    for (const mk of markers) {
      let mesh: THREE.Mesh | null = null;
      let ring: THREE.Mesh | null = null;
      if (mk.type === 'planet') { mesh = planets.take(); ring = planetRings.take(); }
      else if (mk.type === 'station') { mesh = stations.take(); ring = stationRings.take(); }
      else if (mk.type === 'lagrange') mesh = lagrange.take();
      if (mesh) mesh.position.set(mk.x, 0.012, mk.z);
      if (ring && mk.orbit) {
        ring.position.set(mk.orbit.cx, 0.002, mk.orbit.cz);
        ring.scale.setScalar(mk.orbit.r);
      } else if (ring) {
        park(ring);
      }
      if (mk.here) here = mk;
    }
    planets.park(); lagrange.park(); stations.park(); planetRings.park(); stationRings.park();
    if (here) {
      show(hereRing);
      hereRing.position.set(here.x, 0.012, here.z);
      hereRing.scale.setScalar(HERE_RING * (1 + 0.25 * Math.sin(now / 250)));
    } else {
      park(hereRing);
    }
  };

  /** Courses: the lines follow the sun's opacity (World fades the sun; the
   *  lines are not meshes, so it never touches them). */
  const layoutCourses = (now: number, fade: number, sunBase: number, lifted: boolean): void => {
    courseMat.opacity = (sunMat.opacity / sunBase) * COURSE_OPACITY;
    const drawn = plotCourses(bodies, now);
    while (courses.length < drawn.length) makeCourse(); // one per moving station, however many
    courses.forEach((line, i) => {
      const c = drawn[i];
      if (!c || fade <= 0) {
        line.visible = false;
        return;
      }
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const n = Math.min(c.points.length, COURSE_POINTS);
      for (let k = 0; k < n; k++) pos.setXYZ(k, c.points[k]!.x, 0.006 + (lifted ? c.points[k]!.y : 0), c.points[k]!.z);
      pos.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
      line.visible = sun.visible && n > 1;
    });
  };

  const layoutStation = (): void => {
    modules.reset(); links.reset();
    if (stationHolo) {
      for (const m of stationHolo.modules) {
        const mesh = modules.take();
        if (!mesh) break;
        mesh.material = m.here ? hereModuleMat : m.ship ? shipMat : moduleMat;
        mesh.position.set(m.x, 0, m.z);
        mesh.rotation.y = m.rotY;
        mesh.scale.set(Math.max(2 * m.halfX, 0.004), m.ship ? SHIP_H : MODULE_H, Math.max(2 * m.halfZ, 0.004));
      }
      for (const l of stationHolo.links) {
        const mesh = links.take();
        if (!mesh) break;
        const dx = l.bx - l.ax, dz = l.bz - l.az;
        const len = Math.hypot(dx, dz);
        mesh.position.set((l.ax + l.bx) / 2, 0.004, (l.az + l.bz) / 2);
        mesh.rotation.y = Math.atan2(-dz, dx);
        const t = l.berth ? 0.004 : 0.007;
        mesh.scale.set(len, t, t);
      }
    }
    modules.park(); links.park();
  };

  // The cycle starts with the plot fully shown, so the room's own fade-in
  // owns the first second (the first fade the hologram writes is its own).
  let t = FADE_SECONDS;
  const handle: MapHologramHandle = {
    update(dt: number): void {
      const now = Date.now();
      t += dt;
      if (now - lastRefresh >= REFRESH_MS) {
        lastRefresh = now;
        refresh();
      }
      root.rotation.y += SPIN * dt;
      const withStation = !!stationHolo && stationHolo.modules.length > 0;
      const { mode, fade } = holoModeAt(t, withStation);
      const plotFade = mode === 'plot' ? fade : 0;
      const stationFade = mode === 'station' ? fade : 0;
      setLayer(plot, plotFade);
      setLayer(station, stationFade);
      // Meshes made after the table was registered take the sun's zoom hide.
      for (const pool of [stations, stationRings, modules, links]) for (const m of pool.grown) m.visible = sun.visible;
      if (plotFade > 0) layoutPlot(now, plotFade);
      else for (const line of courses) line.visible = false;
      // #327: the room's splats are drawn only while a table shows its plot.
      if (splatPlot && plotFade > 0 && drawnInScene(splatPlot.group)) noteRoomSplatsDrawn();
      if (stationFade > 0) layoutStation();
    },
  };
  sun.userData.mapHologram = handle;
  return handle;
}
