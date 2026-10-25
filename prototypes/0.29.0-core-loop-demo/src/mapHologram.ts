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
import { currentRoomId, listStations } from './stations';
import { readAtlas } from './stationAtlas';
import { stationPlan } from './stationPlan';
import { holotableStation } from './devices';
import { buildSplatPlot, type SplatPlotHandle } from './mapHologramSplats';
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
const POOL = { planets: 4, lagrange: 4, stations: 16, courses: 4, modules: 24, links: 32 };
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

/** A pool of parked meshes sharing one geometry; `take` hands out the next. */
class Pool {
  readonly meshes: THREE.Mesh[] = [];
  private used = 0;
  constructor(parent: THREE.Object3D, n: number, geo: THREE.BufferGeometry, mat: THREE.Material) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(0);
      parent.add(mesh);
      this.meshes.push(mesh);
    }
  }
  reset(): void {
    this.used = 0;
  }
  take(): THREE.Mesh | null {
    return this.used < this.meshes.length ? this.meshes[this.used++]! : null;
  }
  /** Park every mesh not taken since reset(). */
  park(): void {
    for (let i = this.used; i < this.meshes.length; i++) this.meshes[i]!.scale.setScalar(0);
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
  const stations = new Pool(plotGroup, POOL.stations, stationGeo, stationMat);
  // Orbit rings: unit tori scaled to each orbit (the tube scales with them,
  // so a station's small ring gets the fatter tube).
  const ringMat = holoMat(CYAN, 0.22);
  const planetRingGeo = new THREE.TorusGeometry(1, 0.012, 6, 64);
  planetRingGeo.rotateX(Math.PI / 2);
  const planetRings = new Pool(plotGroup, POOL.planets, planetRingGeo, ringMat);
  const stationRingGeo = new THREE.TorusGeometry(1, 0.05, 6, 48);
  stationRingGeo.rotateX(Math.PI / 2);
  const stationRings = new Pool(plotGroup, POOL.stations, stationRingGeo, ringMat);
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
  hereRing.scale.setScalar(0);
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
  for (let i = 0; i < POOL.courses; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COURSE_POINTS * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, courseMat);
    line.visible = false;
    courseGroup.add(line);
    courses.push(line);
  }
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

  // ── The station ─────────────────────────────────────────────────────────
  const stationGroup = new THREE.Group();
  stationGroup.visible = false;
  root.add(stationGroup);
  const blockGeo = new THREE.BoxGeometry(1, 1, 1);
  blockGeo.translate(0, 0.5, 0); // base on the plane
  const moduleMat = holoMat(CYAN, 0.35);
  const hereModuleMat = holoMat(PALE, 0.6);
  const shipMat = holoMat(AMBER, 0.4);
  const modules = new Pool(stationGroup, POOL.modules, blockGeo, moduleMat);
  const linkMat = holoMat(CYAN, 0.5);
  const links = new Pool(stationGroup, POOL.links, new THREE.BoxGeometry(1, 1, 1), linkMat);
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
      splatPlot.place(markers, now, (sunMat.opacity / sunBase) * fade, sun.visible);
      courseGroup.position.copy(splatPlot.group.position);
      courseGroup.scale.copy(splatPlot.group.scale);
      planets.reset(); lagrange.reset(); stations.reset(); planetRings.reset(); stationRings.reset();
      planets.park(); lagrange.park(); stations.park(); planetRings.park(); stationRings.park();
      hereRing.scale.setScalar(0);
      sun.scale.setScalar(0);
      beltMesh?.scale.setScalar(0);
    } else {
      sun.scale.setScalar(1);
      beltMesh?.scale.setScalar(1);
      courseGroup.position.set(0, 0, 0);
      courseGroup.scale.setScalar(1);
      layoutMeshPlot(markers, now);
    }
    layoutCourses(now, fade, sunBase);
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
      if (mesh) {
        mesh.position.set(mk.x, 0.012, mk.z);
        mesh.scale.setScalar(1);
      }
      if (ring && mk.orbit) {
        ring.position.set(mk.orbit.cx, 0.002, mk.orbit.cz);
        ring.scale.setScalar(mk.orbit.r);
      } else if (ring) {
        ring.scale.setScalar(0);
      }
      if (mk.here) here = mk;
    }
    planets.park(); lagrange.park(); stations.park(); planetRings.park(); stationRings.park();
    if (here) {
      hereRing.position.set(here.x, 0.012, here.z);
      hereRing.scale.setScalar(HERE_RING * (1 + 0.25 * Math.sin(now / 250)));
    } else {
      hereRing.scale.setScalar(0);
    }
  };

  /** Courses: the lines follow the sun's opacity (World fades the sun; the
   *  lines are not meshes, so it never touches them). */
  const layoutCourses = (now: number, fade: number, sunBase: number): void => {
    courseMat.opacity = (sunMat.opacity / sunBase) * COURSE_OPACITY;
    const drawn = plotCourses(bodies, now);
    courses.forEach((line, i) => {
      const c = drawn[i];
      if (!c || fade <= 0) {
        line.visible = false;
        return;
      }
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const n = Math.min(c.points.length, COURSE_POINTS);
      for (let k = 0; k < n; k++) pos.setXYZ(k, c.points[k]!.x, 0.006, c.points[k]!.z);
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
      if (plotFade > 0) layoutPlot(now, plotFade);
      else for (const line of courses) line.visible = false;
      if (stationFade > 0) layoutStation();
    },
  };
  sun.userData.mapHologram = handle;
  return handle;
}
