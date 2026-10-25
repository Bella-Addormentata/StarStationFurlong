/**
 * 🔮✨ The map table's hologram as Gaussian splats (#251 v2): the solar
 * plot drawn in volumetric light — a sun with a corona, planets with
 * atmospheres, orbits and the belt as dust, every station a spark — with
 * World Labs' Spark (MIT, @sparkjsdev/spark). Everything here is made in
 * code (constructSplats): no asset files, no service, no key.
 *
 * Spark is loaded lazily by main.ts (setSparkProvider), which makes the one
 * SparkRenderer the scene needs; a client without it (a test, a build with
 * the package missing, a GPU Spark rejects) keeps the mesh plot in
 * mapHologram.ts. SplatMesh objects are not THREE.Mesh, so World's fade-in
 * and zoom hide never touch them: the handle takes the sun mesh's visible
 * flag and opacity as its own, so the splats fade and hide with the table.
 */

import * as THREE from 'three';
import type { SplatMesh as SplatMeshT, SparkRenderer, PackedSplats } from '@sparkjsdev/spark';
import type { HoloMarker } from './mapHologramLayout';
import { HOLO_RADIUS } from './mapHologramLayout';

type SparkModule = typeof import('@sparkjsdev/spark');

export interface SparkHost {
  spark: SparkModule;
  /** The scene's one SparkRenderer, already added to it. */
  renderer: SparkRenderer;
}

let provider: (() => Promise<SparkHost | null>) | null = null;
let hostPromise: Promise<SparkHost | null> | null = null;

/** main.ts: how to get Spark and the scene's SparkRenderer (lazily, once). */
export function setSparkProvider(p: (() => Promise<SparkHost | null>) | null): void {
  provider = p;
  hostPromise = null;
}

function sparkHost(): Promise<SparkHost | null> {
  if (!provider) return Promise.resolve(null);
  if (!hostPromise) {
    hostPromise = provider().catch((err) => {
      console.warn('[hologram] Spark unavailable — the mesh plot stays:', err);
      return null;
    });
  }
  return hostPromise;
}

/** What mapHologram.ts drives each frame the plot is shown. */
export interface SplatPlotHandle {
  /** The splat plot's own group (lifted and grown): what else should ride
   *  along with it — the course lines — copies its transform. */
  group: THREE.Group;
  /** Place every marker; `alpha` is the plot's current opacity factor
   *  (the room's fade-in × the plot/station cross-fade), `shown` the sun
   *  mesh's visibility (World's zoom hide). */
  place(markers: readonly HoloMarker[], nowMs: number, alpha: number, shown: boolean): void;
  dispose(): void;
}

/** The splat plot is laid out at the mesh plot's radius (mapHologramLayout)
 *  and then grown by this much — a projection a metre and a half across,
 *  past the disc's rim, as a hologram may be. */
export const SPLAT_SCALE = 1.7;
/** How far above the disc the projection floats (metres). */
export const SPLAT_LIFT = 0.22;
/** The scan ring's climb (metres, in the plot's own units) and period (s). */
const SWEEP_HEIGHT = 0.16;
const SWEEP_PERIOD_S = 4;

/**
 * A colour for Spark, by its sRGB hex. `new THREE.Color(hex)` converts to
 * the linear working space, and Spark's shader writes its splat colours
 * out as they are (no output transform), so a converted colour lands
 * darker and more saturated than meant — orange as red, cyan as teal.
 * Keeping the sRGB numbers as the stored values shows the hex as it reads.
 */
function srgb(hex: number): THREE.Color {
  return new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);
}

// Palette: the plot is light, so colours are bright and additive-looking.
const SUN_CORE = srgb(0xfff2c0);
const SUN_CORONA = srgb(0xffb13a);
const SUN_RIM = srgb(0xff6a22);
/** Each planet: its two surface colours, and its atmosphere's. */
const PLANET_COLORS: Record<string, [THREE.Color, THREE.Color, THREE.Color]> = {
  'planet-aris': [srgb(0xff7a2a), srgb(0x3a0c04), srgb(0xff9a50)], // lava
  'planet-sovereign': [srgb(0x2fb8ff), srgb(0x1d8a4a), srgb(0x5ac8ff)], // sea + land
};
const PLANET_DEFAULT: [THREE.Color, THREE.Color, THREE.Color] = [srgb(0x9ff6ff), srgb(0x2a6a8a), srgb(0x7fe9ff)];
const ATMOSPHERE = srgb(0x7fe9ff);
const DUST = srgb(0x66e6ff);
const BELT = srgb(0xa9cfe0);
const STATION = srgb(0xe6fbff);
const HERE = srgb(0xffc46b);
const LAGRANGE = srgb(0x8fd3ff);

/** A deterministic random stream, so the sun looks the same on every table. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const V = new THREE.Vector3();
const S = new THREE.Vector3();
const Q = new THREE.Quaternion();
const C = new THREE.Color();

/** `n` splats in a ball of radius `r` (density ∝ r² falling off), colour
 *  blended from `inner` at the centre to `outer` at the rim. */
function ball(splats: PackedSplats, n: number, r: number, size: number, opacity: number, inner: THREE.Color, outer: THREE.Color, rand: () => number, soft = 1): void {
  for (let i = 0; i < n; i++) {
    const u = rand(), v = rand(), w = rand();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    const rr = r * Math.cbrt(w);
    V.set(rr * Math.sin(phi) * Math.cos(theta), rr * Math.sin(phi) * Math.sin(theta), rr * Math.cos(phi));
    const t = rr / r;
    C.copy(inner).lerp(outer, t);
    S.setScalar(size * (0.6 + 0.8 * rand()) * (1 + soft * t));
    splats.pushSplat(V, S, Q, opacity * (1 - 0.6 * t), C);
  }
}

/** `n` elongated splats radiating from the origin in the XZ plane — the
 *  sun's rays: each a thin ellipsoid `len` long, turned to its own angle. */
function rays(splats: PackedSplats, n: number, len: number, thick: number, opacity: number, color: THREE.Color, rand: () => number): void {
  const axis = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const l = len * (0.5 + rand());
    V.set(Math.cos(a) * l * 0.55, (rand() - 0.5) * thick * 2, Math.sin(a) * l * 0.55);
    S.set(l * 0.5, thick, thick);
    Q.setFromAxisAngle(axis, -a);
    splats.pushSplat(V, S, Q, opacity * (0.5 + 0.5 * rand()), color);
  }
  Q.identity();
}

/** `n` splats in a column from y = 0 down to `-depth`, fading toward the foot. */
function pillar(splats: PackedSplats, n: number, depth: number, radius: number, size: number, opacity: number, color: THREE.Color, rand: () => number): void {
  for (let i = 0; i < n; i++) {
    const t = rand();
    const a = rand() * Math.PI * 2, rr = radius * Math.sqrt(rand());
    V.set(Math.cos(a) * rr, -t * depth, Math.sin(a) * rr);
    S.set(size, size * 2.5, size);
    splats.pushSplat(V, S, Q, opacity * (1 - 0.8 * t), color);
  }
}

/** `n` splats on a sphere's surface (Fibonacci), colour by latitude bands. */
function shell(splats: PackedSplats, n: number, r: number, size: number, opacity: number, a: THREE.Color, b: THREE.Color, rand: () => number): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const theta = golden * i;
    V.set(Math.cos(theta) * rad * r, y * r, Math.sin(theta) * rad * r);
    const band = 0.5 + 0.5 * Math.sin(y * 9 + Math.cos(theta * 3) * 1.5);
    C.copy(a).lerp(b, band * (0.7 + 0.3 * rand()));
    S.setScalar(size * (0.8 + 0.4 * rand()));
    splats.pushSplat(V, S, Q, opacity, C);
  }
}

/** `n` splats along a circle of radius `r` in the XZ plane, jittered by
 *  `spread` sideways and `lift` vertically. */
function ring(splats: PackedSplats, n: number, r: number, spread: number, lift: number, size: number, opacity: number, color: THREE.Color, rand: () => number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.02;
    const rr = r + (rand() - 0.5) * spread;
    V.set(Math.cos(a) * rr, (rand() - 0.5) * lift, Math.sin(a) * rr);
    S.setScalar(size * (0.5 + rand()));
    splats.pushSplat(V, S, Q, opacity * (0.6 + 0.4 * rand()), color);
  }
}

/**
 * Build the splat plot under `parent` (the hologram's plot group, so it
 * turns with the rest). Resolves to null where Spark is not to be had;
 * mapHologram.ts keeps the mesh plot then.
 */
export async function buildSplatPlot(parent: THREE.Object3D): Promise<SplatPlotHandle | null> {
  const host = await sparkHost();
  if (!host) return null;
  const { SplatMesh } = host.spark;
  const group = new THREE.Group();
  group.name = 'map-hologram-splats';
  group.scale.setScalar(SPLAT_SCALE);
  group.position.y = SPLAT_LIFT;
  parent.add(group);

  const make = (name: string, construct: (s: PackedSplats) => void): SplatMeshT => {
    const m = new SplatMesh({ constructSplats: construct });
    m.name = name;
    group.add(m);
    return m;
  };

  // The sun: a white-hot core in an orange corona, rays out of it, and a
  // faint haze over the whole disc and up into a dome that gives the
  // projection its volume.
  const sun = make('sun', (s) => {
    const rand = rng(7);
    ball(s, 1200, 0.03, 0.0055, 1, SUN_CORE, SUN_CORE, rand, 0.3);
    ball(s, 900, 0.07, 0.009, 0.18, SUN_CORONA, SUN_RIM, rand, 2.2);
    rays(s, 90, 0.2, 0.0025, 0.4, SUN_CORONA, rand);
  });
  sun.position.y = 0.02;
  const haze = make('haze', (s) => {
    const rand = rng(11);
    for (let i = 0; i < 500; i++) {
      const a = rand() * Math.PI * 2, rr = HOLO_RADIUS * Math.sqrt(rand());
      V.set(Math.cos(a) * rr, 0.01 + rand() * 0.05, Math.sin(a) * rr);
      S.setScalar(0.03 + rand() * 0.05);
      s.pushSplat(V, S, Q, 0.02, DUST);
    }
    // The dome: a hemisphere of soft light.
    for (let i = 0; i < 700; i++) {
      const u = rand(), v = rand();
      const theta = 2 * Math.PI * u, phi = Math.acos(1 - v); // upper half
      const r = HOLO_RADIUS * 1.02;
      V.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.5, r * Math.sin(phi) * Math.sin(theta));
      S.setScalar(0.02 + rand() * 0.03);
      s.pushSplat(V, S, Q, 0.012, DUST);
    }
  });
  // The belt: thousands of grains in an annulus, a little thickness to it.
  let belt: SplatMeshT | null = null;
  const beltFor = (r: number): SplatMeshT => make('belt', (s) => ring(s, 5000, r, 0.06, 0.02, 0.0026, 0.7, BELT, rng(5)));
  // The scan: a thin ring that climbs off the disc and fades, over and over.
  const sweep = make('sweep', (s) => ring(s, 400, HOLO_RADIUS * 0.98, 0.004, 0.002, 0.003, 0.5, ATMOSPHERE, rng(31)));

  // One rig per planet: the body, its atmosphere, and the dust rings of the
  // stations round it (rebuilt when the set of ring radii changes).
  interface PlanetRig { group: THREE.Group; rings: SplatMeshT | null; ringKey: string; orbit: SplatMeshT | null; orbitR: number }
  const planets = new Map<string, PlanetRig>();
  const planetRig = (id: string): PlanetRig => {
    let rig = planets.get(id);
    if (rig) return rig;
    const g = new THREE.Group();
    g.name = `planet-${id}`;
    group.add(g);
    const [a, b, air] = PLANET_COLORS[id] ?? PLANET_DEFAULT;
    const body = new SplatMesh({ constructSplats: (s) => shell(s, 700, 0.027, 0.0036, 1, a, b, rng(id.length * 31)) });
    // The atmosphere: a thin halo just off the surface, not a fill.
    const atmo = new SplatMesh({ constructSplats: (s) => shell(s, 260, 0.036, 0.009, 0.07, air, air, rng(id.length * 17)) });
    const foot = new SplatMesh({ constructSplats: (s) => pillar(s, 90, 0.017 + SPLAT_LIFT / SPLAT_SCALE, 0.006, 0.004, 0.14, DUST, rng(id.length * 5)) });
    g.add(body); g.add(atmo); g.add(foot);
    rig = { group: g, rings: null, ringKey: '', orbit: null, orbitR: 0 };
    planets.set(id, rig);
    return rig;
  };
  // A spark per station, a glow per Lagrange pocket.
  const sparks = new Map<string, SplatMeshT>();
  const sparkFor = (id: string, kind: 'station' | 'lagrange'): SplatMeshT => {
    let m = sparks.get(id);
    if (m) return m;
    m = kind === 'station'
      ? make(`station-${id}`, (s) => { const rand = rng(id.length * 13 + 3); ball(s, 120, 0.011, 0.0038, 1, STATION, STATION, rand, 0.5); ball(s, 60, 0.024, 0.006, 0.18, ATMOSPHERE, DUST, rand, 1.5); })
      : make(`lagrange-${id}`, (s) => ball(s, 90, 0.016, 0.006, 0.4, LAGRANGE, DUST, rng(id.length * 29), 1.2));
    sparks.set(id, m);
    return m;
  };
  // "You are here": an amber halo that breathes.
  const here = make('here', (s) => { const rand = rng(23); ring(s, 320, 0.04, 0.006, 0.006, 0.0045, 1, HERE, rand); ball(s, 160, 0.05, 0.009, 0.25, HERE, SUN_CORONA, rand, 1.5); });
  here.visible = false;

  const all = (): SplatMeshT[] => {
    const out: SplatMeshT[] = [sun, haze, here, sweep];
    if (belt) out.push(belt);
    for (const r of planets.values()) {
      r.group.traverse((o) => { if ((o as SplatMeshT).packedSplats !== undefined) out.push(o as SplatMeshT); });
      if (r.orbit) out.push(r.orbit);
    }
    for (const m of sparks.values()) out.push(m);
    return out;
  };
  const setAlpha = (alpha: number, nowMs: number): void => {
    for (const m of all()) m.opacity = alpha;
    const sweepT = ((nowMs / 1000) % SWEEP_PERIOD_S) / SWEEP_PERIOD_S;
    sweep.opacity = alpha * (1 - sweepT) * (1 - sweepT);
  };

  const handle: SplatPlotHandle = {
    group,
    place(markers, nowMs, alpha, shown) {
      group.visible = shown && alpha > 0;
      if (!group.visible) return;
      const seenPlanets = new Set<string>();
      const seenSparks = new Set<string>();
      let hereAt: HoloMarker | null = null;
      for (const mk of markers) {
        if (mk.type === 'planet') {
          const rig = planetRig(mk.id);
          seenPlanets.add(mk.id);
          rig.group.position.set(mk.x, 0.017, mk.z);
          rig.group.rotation.y = nowMs / 9000;
          // Its own orbit, as dust round the sun.
          if (mk.orbit && Math.abs(mk.orbit.r - rig.orbitR) > 1e-6) {
            rig.orbit?.removeFromParent(); rig.orbit?.dispose();
            const r = mk.orbit.r;
            rig.orbit = make(`orbit-${mk.id}`, (s) => ring(s, 1400, r, 0.005, 0.004, 0.0028, 0.5, DUST, rng(mk.id.length * 7)));
            rig.orbit.position.set(mk.orbit.cx, 0.004, mk.orbit.cz);
            rig.orbitR = r;
          }
        } else if (mk.type === 'station' || mk.type === 'lagrange') {
          const m = sparkFor(mk.id, mk.type);
          seenSparks.add(mk.id);
          m.position.set(mk.x, 0.012, mk.z);
          if (mk.here) hereAt = mk;
        }
      }
      // Station rings: dust round each planet at the stations' radii.
      const ringsByPlanet = new Map<string, number[]>();
      for (const mk of markers) {
        if (mk.type !== 'station' || !mk.orbit) continue;
        const key = [...planets.entries()].find(([, r]) => Math.hypot(r.group.position.x - mk.orbit!.cx, r.group.position.z - mk.orbit!.cz) < 1e-6)?.[0];
        if (!key) continue;
        (ringsByPlanet.get(key) ?? ringsByPlanet.set(key, []).get(key)!).push(mk.orbit.r);
      }
      for (const [id, rig] of planets) {
        if (!seenPlanets.has(id)) { rig.group.visible = false; continue; }
        rig.group.visible = true;
        const radii = (ringsByPlanet.get(id) ?? []).map((r) => r.toFixed(5)).sort();
        const ringKey = radii.join(',');
        if (ringKey !== rig.ringKey) {
          rig.rings?.removeFromParent(); rig.rings?.dispose(); rig.rings = null;
          if (radii.length) {
            const rs = radii.map(Number);
            rig.rings = new SplatMesh({ constructSplats: (s) => { const rand = rng(id.length * 3 + rs.length); for (const r of rs) ring(s, 420, r, 0.003, 0.003, 0.0022, 0.55, DUST, rand); } });
            rig.rings.position.y = -0.013;
            rig.group.add(rig.rings);
          }
          rig.ringKey = ringKey;
        }
        // The rings sit still while the body turns.
        if (rig.rings) rig.rings.rotation.y = -rig.group.rotation.y;
      }
      for (const [id, m] of sparks) {
        if (seenSparks.has(id)) continue;
        m.removeFromParent(); m.dispose(); sparks.delete(id);
      }
      if (!belt) {
        const b = markers.find((m) => m.type === 'asteroid-field');
        if (b) { belt = beltFor(Math.hypot(b.x, b.z) || HOLO_RADIUS * 0.93); belt.position.y = 0.006; }
      }
      if (belt) belt.rotation.y = nowMs / 60000;
      sun.rotation.y = -nowMs / 7000;
      // The scan ring climbs and fades, SWEEP_PERIOD_S a climb.
      const sweepT = ((nowMs / 1000) % SWEEP_PERIOD_S) / SWEEP_PERIOD_S;
      sweep.position.y = 0.004 + SWEEP_HEIGHT * sweepT;
      sweep.scale.setScalar(1 - 0.35 * sweepT);
      if (hereAt) {
        here.visible = true;
        here.position.set(hereAt.x, 0.012, hereAt.z);
        here.scale.setScalar(1 + 0.18 * Math.sin(nowMs / 250));
      } else {
        here.visible = false;
      }
      setAlpha(alpha, nowMs);
    },
    dispose() {
      for (const m of all()) m.dispose();
      for (const rig of planets.values()) { rig.rings?.dispose(); rig.orbit?.dispose(); }
      group.removeFromParent();
    },
  };
  return handle;
}
