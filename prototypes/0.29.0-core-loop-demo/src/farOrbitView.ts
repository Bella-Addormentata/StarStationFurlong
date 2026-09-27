/**
 * 🔭 The far pass — a perspective backdrop behind the isometric station
 * (owner ask, 2026-09-27; geometry in farOrbits.ts).
 *
 * While the exterior view is up, each frame is drawn in three passes:
 *   1. the main scene's SKY only (nebula + stars, on SKY_LAYER), through the
 *      game's orthographic camera — the backdrop it always had;
 *   2. the FAR scene through a perspective camera that copies the ortho
 *      camera's orientation (so the rig's 45° detents and the slow drift turn
 *      it too) and sits EYE_DISTANCE behind the viewer: the planet at its
 *      true size off the station's −X, every known orbit ring, the other
 *      stations (a box per module) and ships in flight on their transfers;
 *   3. the main scene WITHOUT the sky, depth cleared, so the isometric station
 *      always sits on top — unchanged from before.
 * Outside the exterior view `renderWithFarPass` is one plain render.
 *
 * Distant bodies are impostors at a fixed SCREEN size (a real station 2,000 km
 * off is far below a pixel): each frame their scale follows their distance.
 * Their places are exact angles on the shared clock with compressed
 * altitudes (farOrbits.ts); what is known about them comes from the station
 * list and the per-planet summary (planetSummary.ts) — never another
 * station's full atlas.
 *
 * A station moving between planets shows the sun's frame instead
 * (farOrbits.transitLayout): the old planet is gone from outside the windows
 * until the station arrives.
 */

import * as THREE from 'three';
import {
  angleAt,
  orbitForSlot,
  planTransfer,
  stationOrbit,
  stationPointAt,
  transferPointAt,
} from './orbits';
import type { OrbitPoint, TransferPlan } from './orbits';
import { planetLayout, transitLayout } from './farOrbits';
import type { FarBody, FarLayout, FarShipInput, FarStationInput } from './farOrbits';
import { shipsAroundPlanet } from './planetSummary';
import { shipDocBound } from './shipDoc';
// 🚏 A ferry route's leg is flown by its timetable, never written to the
// stored flight (robot pilot routes, build notes A4): the resolved flight.
import { readResolvedFlight } from './shipRoute';
import { atlasComponents, readAtlas } from './stationAtlas';
import { currentRoomId, currentStation, listStations, planetById, planetForRoom, stationInTransit } from './stations';
import type { StationMove, StationRecord } from './stations';

/** The main scene's sky objects also live on this layer, so pass 1 can draw
 *  them alone (tagged on first use). */
export const SKY_LAYER = 1;
/** Names renderer.ts gives the sky objects. */
const SKY_NAMES = new Set(['nebula-sky', 'nebula-stars']);

/** How far behind the viewer the far camera sits, in compressed km. Frames
 *  the nearest rings and the planet's limb around the station. */
const EYE_DISTANCE = 14_000;
const FOV_DEG = 40;
/** On-screen sizes, CSS px. */
const MODULE_PX = 7;
const SHIP_PX = 9;
const PLANET_PX = 16;
const SUN_PX = 30;
/** Most boxes drawn for one station. */
const MAX_MODULE_BOXES = 8;
/** How often the list of what is out there is re-read, real ms. */
const REFRESH_MS = 1000;

const RING_COLOR = 0x9fd4ff;
const PATH_COLOR = 0xffa040;
const STATION_COLOR = 0xd8e2ee;
const SHIP_COLOR = 0xffa040;

// ── What is out there (re-read every REFRESH_MS) ────────────────────────────

type Source =
  | {
      mode: 'planet';
      planetId: string;
      viewer: (ms: number) => OrbitPoint;
      viewerRingRadiusKm?: number;
      stations: Array<{ record: StationRecord; modules: number }>;
      ships: FarShipInput[];
      key: string;
    }
  | { mode: 'sun'; move: StationMove; key: string };

/** A flight's transfer rebuilt from its record: the Hohmann ellipse between
 *  the two stations' orbits, pinned to the record's own times. */
function flightPlan(
  from: StationRecord | undefined,
  to: StationRecord | undefined,
  departedAt: number,
  etaAt: number,
): TransferPlan | null {
  if (!from || !to || !(etaAt > departedAt)) return null;
  const plan = planTransfer(from, to, departedAt - 1);
  return plan ? { ...plan, departAt: departedAt, arriveAt: etaAt } : null;
}

function modulesOf(station: StationRecord, components: Set<string>[]): number {
  if (!station.welcomeRoomId) return 1;
  return components.find((c) => c.has(station.welcomeRoomId))?.size ?? 1;
}

function gather(now: number): Source {
  const roomId = currentRoomId();
  const atlas = readAtlas();
  const all = listStations(atlas);
  const components = atlasComponents(atlas);

  // Aboard a ship in flight: see the planet from the transfer.
  let aboard: TransferPlan | null = null;
  if (shipDocBound()) {
    // 🚏 A running ferry route's timetable while it rules the flight (its
    // legs write no stored `flight`), else the stored record.
    const rec = readResolvedFlight(now);
    if (rec.status === 'in-flight' && rec.destinationId && rec.departedAt && rec.etaAt) {
      aboard = flightPlan(
        all.find((s) => s.id === rec.locationId),
        all.find((s) => s.id === rec.destinationId),
        rec.departedAt,
        rec.etaAt,
      );
      if (aboard && transferPointAt(aboard, now).leg !== 'transfer') aboard = null;
    }
  }

  // Not in a known station (offline, or before the first join): stand in
  // for the planet's slot-0 station, so it is not drawn as a neighbour on
  // top of the viewer.
  const me = aboard
    ? null
    : currentStation() ??
      all.find((s) => planetById(s.planetId).id === planetForRoom(roomId, atlas).id && s.orbitSlot === 0) ??
      null;
  if (me?.move && stationInTransit(me, now)) {
    const m = me.move;
    return { mode: 'sun', move: m, key: `sun|${m.welcomeRoomId}|${m.departAt}|${m.arriveAt}` };
  }

  const planetId = aboard
    ? aboard.from.planet.id
    : me
      ? planetById(me.planetId).id
      : planetForRoom(roomId, atlas).id;
  let viewer: (ms: number) => OrbitPoint;
  let viewerRingRadiusKm: number | undefined;
  if (aboard) {
    const plan = aboard;
    viewer = (ms) => transferPointAt(plan, ms);
  } else if (me) {
    const station = me;
    viewer = (ms) => stationPointAt(station, ms);
    viewerRingRadiusKm = stationOrbit(me).radiusKm;
  } else {
    const orbit = orbitForSlot(planetId, 0);
    viewer = (ms) => ({ radiusKm: orbit.radiusKm, angle: angleAt(orbit, ms) });
    viewerRingRadiusKm = orbit.radiusKm;
  }

  const stations = all
    .filter((s) => s.id !== me?.id && planetById(s.planetId).id === planetId && !stationInTransit(s, now))
    .map((record) => ({ record, modules: modulesOf(record, components) }));

  const byRoom = (room: string | undefined) => (room ? all.find((s) => s.welcomeRoomId === room) : undefined);
  const ships: FarShipInput[] = [];
  for (const ship of shipsAroundPlanet(planetId, now)) {
    if (ship.roomId === roomId || ship.status !== 'in-flight') continue;
    if (ship.departedAt === undefined || ship.etaAt === undefined) continue;
    const plan = flightPlan(byRoom(ship.fromRoom), byRoom(ship.toRoom), ship.departedAt, ship.etaAt);
    if (plan) ships.push({ id: `ship:${ship.roomId}`, name: ship.name, plan });
  }

  const key = [
    'planet',
    planetId,
    viewerRingRadiusKm ?? 'x',
    ...stations.map((s) => `${s.record.id}:${s.record.orbitSlot}:${s.modules}:${s.record.name}`),
    ...ships.map((s) => `${s.id}:${s.plan.departAt}:${s.plan.arriveAt}`),
  ].join('|');
  return { mode: 'planet', planetId, viewer, viewerRingRadiusKm, stations, ships, key };
}

function layoutFor(source: Source, now: number): FarLayout | null {
  if (source.mode === 'sun') return transitLayout(source.move, now);
  const stations: FarStationInput[] = source.stations.map(({ record, modules }) => ({
    id: record.id,
    name: record.name,
    point: stationPointAt(record, now),
    ringRadiusKm: stationOrbit(record).radiusKm,
    modules,
  }));
  return planetLayout({
    planetId: source.planetId,
    nowMs: now,
    viewer: source.viewer(now),
    viewerRingRadiusKm: source.viewerRingRadiusKm,
    stations,
    ships: source.ships,
  });
}

// ── The far scene ────────────────────────────────────────────────────────────

let active = false;
let farScene: THREE.Scene | null = null;
let farCamera: THREE.PerspectiveCamera | null = null;
/** The planet (or sun) frame, re-posed each frame so the viewer sits at the
 *  origin, planet-locked. */
let frame: THREE.Group | null = null;
let sunLight: THREE.DirectionalLight | null = null;
let source: Source | null = null;
let builtKey = '';
let lastRefresh = 0;
/** Screen-sized objects: body id → [object, px per local unit]. */
const bodies = new Map<string, { obj: THREE.Object3D; px: number }>();

function ensureScene(): void {
  if (farScene) return;
  farScene = new THREE.Scene();
  farCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 10, 2_000_000);
  farScene.add(new THREE.AmbientLight(0xffffff, 0.35));
  sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  farScene.add(sunLight);
  farScene.add(sunLight.target);
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const d = c as THREE.Mesh;
    d.geometry?.dispose?.();
    const mats = d.material ? (Array.isArray(d.material) ? d.material : [d.material]) : [];
    for (const m of mats) {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  });
}

function clearFrame(): void {
  if (frame && farScene) {
    farScene.remove(frame);
    disposeTree(frame);
  }
  frame = null;
  bodies.clear();
  builtKey = '';
}

function labelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = 'bold 28px system-ui, sans-serif';
  let w = 256;
  if (ctx) {
    ctx.font = font;
    w = Math.ceil(ctx.measureText(text).width) + 16;
  }
  canvas.width = w;
  canvas.height = 40;
  if (ctx) {
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, 8, 20);
    ctx.fillStyle = color;
    ctx.fillText(text, 8, 20);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  // Height 2 local units; the body's per-frame scale sets the pixels.
  sprite.scale.set((2 * canvas.width) / canvas.height, 2, 1);
  sprite.center.set(0, 0);
  return sprite;
}

function circle(radius: number, color: number, opacity: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  const n = 256;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(radius * Math.cos(a), 0, -radius * Math.sin(a)));
  }
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
}

function stationImpostor(body: FarBody): THREE.Object3D {
  const g = new THREE.Group();
  const n = Math.min(MAX_MODULE_BOXES, body.modules);
  const geo = new THREE.BoxGeometry(1, 0.8, 1);
  const mat = new THREE.MeshStandardMaterial({ color: STATION_COLOR, roughness: 0.6, metalness: 0.3, emissive: 0x223344 });
  // A row of modules along the direction of travel (local −Z), centred.
  for (let i = 0; i < n; i++) {
    const box = new THREE.Mesh(geo, mat);
    box.position.z = -(i - (n - 1) / 2) * 1.25;
    g.add(box);
  }
  return g;
}

function shipImpostor(): THREE.Object3D {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.4, 8),
    new THREE.MeshBasicMaterial({ color: SHIP_COLOR }),
  );
  cone.rotation.x = -Math.PI / 2; // nose toward −Z, prograde
  const g = new THREE.Group();
  g.add(cone);
  return g;
}

function sphereImpostor(color: number, emissive = false): THREE.Object3D {
  const mat = emissive
    ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), mat));
  return g;
}

function buildFrame(layout: FarLayout): void {
  clearFrame();
  if (!farScene) return;
  frame = new THREE.Group();
  frame.name = 'far-orbit-frame';

  if (layout.planet) {
    const p = layout.planet;
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(p.radiusKm, 96, 64),
      new THREE.MeshStandardMaterial({
        color: p.color,
        roughness: 0.9,
        metalness: 0.05,
        emissive: p.emissive,
        emissiveIntensity: 0.35,
      }),
    );
    planet.name = 'far-planet';
    frame.add(planet);
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(p.radiusKm * 1.025, 96, 64),
      new THREE.MeshBasicMaterial({ color: p.atmosphere, transparent: true, opacity: 0.12, side: THREE.BackSide }),
    );
    frame.add(atmo);
  }

  for (const r of layout.rings) frame.add(circle(r.radius, RING_COLOR, r.own ? 0.7 : 0.3));
  for (const path of layout.paths) {
    const pts = path.points.map((q) => new THREE.Vector3(q.x, q.y, q.z));
    frame.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: PATH_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
      ),
    );
  }

  for (const b of layout.bodies) {
    let obj: THREE.Object3D;
    let px: number;
    if (b.kind === 'station') {
      obj = stationImpostor(b);
      px = MODULE_PX;
    } else if (b.kind === 'ship') {
      obj = shipImpostor();
      px = SHIP_PX;
    } else if (b.kind === 'sun') {
      obj = sphereImpostor(0xfff2c0, true);
      px = SUN_PX;
    } else {
      obj = sphereImpostor(planetById(b.id).color);
      px = PLANET_PX;
    }
    const label = labelSprite(b.name, b.kind === 'ship' ? '#ffc080' : '#e8f2ff');
    label.position.set(0.8, 0.8, 0);
    obj.add(label);
    obj.name = `far-body-${b.id}`;
    frame.add(obj);
    bodies.set(b.id, { obj, px });
  }

  farScene.add(frame);
}

/** Move everything to where it is now. */
function poseFrame(layout: FarLayout): void {
  if (!frame) return;
  frame.position.set(layout.transform.position.x, layout.transform.position.y, layout.transform.position.z);
  frame.rotation.set(0, layout.transform.rotationY, 0);
  for (const b of layout.bodies) {
    const entry = bodies.get(b.id);
    if (!entry) continue;
    entry.obj.position.set(b.position.x, b.position.y, b.position.z);
    // Line the impostor up with its orbit (rotation.y = its orbit angle puts
    // its local −Z along the direction of travel, as for a station).
    entry.obj.rotation.set(0, b.angle, 0);
  }
  if (sunLight) {
    const d = layout.sunDirection;
    sunLight.position.set(d.x * 1e5, d.y * 1e5, d.z * 1e5);
    sunLight.target.position.set(0, 0, 0);
  }
}

const tmp = new THREE.Vector3();

/** Keep every impostor at its on-screen size. */
function sizeBodies(heightPx: number): void {
  if (!farCamera) return;
  const perPxAt1 = (2 * Math.tan(THREE.MathUtils.degToRad(farCamera.fov) / 2)) / Math.max(1, heightPx);
  for (const { obj, px } of bodies.values()) {
    obj.getWorldPosition(tmp);
    const d = tmp.distanceTo(farCamera.position);
    obj.scale.setScalar(d * perPxAt1 * px);
  }
}

function update(renderer: THREE.WebGLRenderer, ortho: THREE.Camera): void {
  ensureScene();
  const now = Date.now();
  if (!source || now - lastRefresh >= REFRESH_MS) {
    try {
      source = gather(now);
    } catch (err) {
      console.warn('far orbit view: could not read the stations', err);
    }
    lastRefresh = now;
  }
  const layout = source ? layoutFor(source, now) : null;
  if (!layout) {
    clearFrame();
  } else {
    if (source && source.key !== builtKey) {
      buildFrame(layout);
      builtKey = source.key;
    }
    poseFrame(layout);
  }

  const cam = farCamera!;
  const size = renderer.getSize(new THREE.Vector2());
  cam.aspect = size.x / Math.max(1, size.y);
  cam.quaternion.copy(ortho.quaternion);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ortho.quaternion);
  cam.position.copy(forward.multiplyScalar(-EYE_DISTANCE));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  frame?.updateMatrixWorld(true);
  sizeBodies(size.y);
  frame?.updateMatrixWorld(true);
}

// ── Public ───────────────────────────────────────────────────────────────────

/** exteriorView turns the far pass on and off with the space view. */
export function setFarPassActive(on: boolean): void {
  active = on;
  source = null;
  if (!on) clearFrame();
}

/** Re-read what is out there on the next frame (room swapped, stations
 *  changed). */
export function refreshFarPass(): void {
  source = null;
}

/** The frame's render: one plain render, or sky → far pass → station while
 *  the exterior view is up. */
export function renderWithFarPass(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  if (!active) {
    renderer.render(scene, camera);
    return;
  }
  const sky = scene.children.filter((o) => SKY_NAMES.has(o.name));
  for (const o of sky) o.layers.enable(SKY_LAYER);
  const shown = sky.map((o) => o.visible);
  const background = scene.background;
  const cameraLayers = camera.layers.mask;
  try {
    update(renderer, camera);
    // 1. The sky alone (clears with the scene background as usual).
    camera.layers.set(SKY_LAYER);
    renderer.render(scene, camera);
    camera.layers.mask = cameraLayers;
    renderer.autoClear = false;
    // 2. The far scene.
    if (farScene && farCamera && frame) {
      renderer.clearDepth();
      renderer.render(farScene, farCamera);
    }
    // 3. The station, on top, without the sky or a clearing background.
    renderer.clearDepth();
    for (const o of sky) o.visible = false;
    scene.background = null;
    renderer.render(scene, camera);
  } finally {
    scene.background = background;
    sky.forEach((o, i) => { o.visible = shown[i]; });
    camera.layers.mask = cameraLayers;
    renderer.autoClear = true;
  }
}
