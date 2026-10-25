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
import { HOLO_RADIUS, holoFoot, holoPoint, inclinationOf, ringInclination, type Inclination } from './mapHologramLayout';

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

/** Spark and the scene's SparkRenderer, once; null where there is none. */
export function sparkHost(): Promise<SparkHost | null> {
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
const SUN_CORE = srgb(0xfff6d5);
const SUN_CORONA = srgb(0xffc24a);
const SUN_RIM = srgb(0xff8a2a);
/** Each planet: its two surface colours, its atmosphere's, and the colour
 *  of its orbit and of the station rings round it (bodyColor). */
interface PlanetLook { a: THREE.Color; b: THREE.Color; air: THREE.Color; ring: THREE.Color; hex: number }
const PLANET_LOOKS: Record<string, PlanetLook> = {
  'planet-aris': { a: srgb(0xffb048), b: srgb(0x8a2208), air: srgb(0xffc080), ring: srgb(0xffa040), hex: 0xffb050 }, // lava
  'planet-sovereign': { a: srgb(0x4ff0a0), b: srgb(0x1a6ac8), air: srgb(0xb0ffe0), ring: srgb(0x50e8a8), hex: 0x6ff0b0 }, // land + sea
};
const PLANET_DEFAULT: PlanetLook = { a: srgb(0xd8a8ff), b: srgb(0x5a3aa0), air: srgb(0xe8d0ff), ring: srgb(0xc0a0ff), hex: 0xd0a8ff };
const lookOf = (id: string): PlanetLook => PLANET_LOOKS[id] ?? PLANET_DEFAULT;
const ATMOSPHERE = srgb(0x9fe9ff);
const DUST = srgb(0x66e6ff);
const BELT = srgb(0xc9d6e2);
const HERE = srgb(0x3dff9a);
const LAGRANGE = srgb(0xe08cff);
/** Every station in its own bright colour, one of these by its id, and
 *  its ring round its planet and its label dot in the same. */
export const RAINBOW = [0xff5252, 0xff9a2e, 0xffe14a, 0x6cff6c, 0x3ef0ff, 0x6a86ff, 0xc77dff, 0xff6fd8] as const;
export function stationHue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return RAINBOW[h % RAINBOW.length]!;
}
const stationColors = new Map<number, { core: THREE.Color; glow: THREE.Color }>();
function stationLook(hex: number): { core: THREE.Color; glow: THREE.Color } {
  let l = stationColors.get(hex);
  if (!l) {
    const glow = srgb(hex);
    l = { core: glow.clone().lerp(new THREE.Color(1, 1, 1), 0.45), glow };
    stationColors.set(hex, l);
  }
  return l;
}

/** The colour a body is drawn in, for labels and cards to match: hex sRGB. */
export function bodyColor(mk: Pick<HoloMarker, 'id' | 'type' | 'frame' | 'here'>): number {
  if (mk.here) return 0x3dff9a;
  switch (mk.type) {
    case 'star': return 0xffd27a;
    case 'planet': return lookOf(mk.id).hex;
    case 'station': return stationHue(mk.id);
    case 'lagrange': return 0xe08cff;
    default: return 0xc9d6e2;
  }
}

const _nodeAxis = new THREE.Vector3();
const _qTilt = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
/** Turn a flat ring onto its tilted orbit plane (inclinedPoint's), spun
 *  by `spin` about the plane's own normal first. */
function tiltTo(o: THREE.Object3D, inc: Inclination, spin = 0): void {
  _nodeAxis.set(Math.cos(inc.node), 0, Math.sin(inc.node));
  _qTilt.setFromAxisAngle(_nodeAxis, -inc.tilt);
  _qSpin.setFromAxisAngle(_nodeAxis.set(0, 1, 0), spin);
  o.quaternion.copy(_qTilt).multiply(_qSpin);
}

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

/** `n` elongated splats radiating from the origin in every direction —
 *  the sun's rays: each a thin ellipsoid `len` long along its own ray. */
function rays(splats: PackedSplats, n: number, len: number, thick: number, opacity: number, color: THREE.Color, rand: () => number): void {
  const dir = new THREE.Vector3(), xAxis = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < n; i++) {
    const u = rand(), v = rand();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    dir.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.6, Math.sin(phi) * Math.sin(theta)).normalize();
    const l = len * (0.6 + 0.5 * rand());
    V.copy(dir).multiplyScalar(l * 0.55);
    S.set(l * 0.45, thick, thick);
    Q.setFromUnitVectors(xAxis, dir);
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

const NIGHT = new THREE.Color(0x0a1020);
/** `n` splats on a sphere's surface (Fibonacci), colour by latitude bands,
 *  lit from local +x (`lit` > 0: the sun side bright, the far side dark —
 *  what makes a ball read as a ball). */
function shell(splats: PackedSplats, n: number, r: number, size: number, opacity: number, a: THREE.Color, b: THREE.Color, rand: () => number, lit = 0): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const nx = Math.cos(theta) * rad, nz = Math.sin(theta) * rad;
    V.set(nx * r, y * r, nz * r);
    const band = 0.5 + 0.5 * Math.sin(y * 9 + Math.cos(theta * 3) * 1.5);
    C.copy(a).lerp(b, band * (0.7 + 0.3 * rand()));
    if (lit > 0) {
      // Day to night across the terminator, with a little scattered light.
      const day = Math.max(0, nx);
      const shade = Math.min(1, 0.12 + 0.88 * Math.pow(day, 0.6));
      C.lerp(NIGHT, lit * (1 - shade));
    }
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
export interface SplatPlotOptions {
  /** Grain: 1 for the table (the plot a few hundred pixels across), more
   *  for a close view — splats `detail` times smaller and as many times
   *  more numerous, so the picture stays crisp when it fills a panel. */
  detail?: number;
}

export async function buildSplatPlot(parent: THREE.Object3D, opts: SplatPlotOptions = {}): Promise<SplatPlotHandle | null> {
  const host = await sparkHost();
  if (!host) return null;
  const { SplatMesh } = host.spark;
  const detail = Math.max(1, Math.min(4, opts.detail ?? 1));
  /** Counts grow with the detail, sizes shrink with it. */
  const N = (n: number): number => Math.round(n * detail);
  const Z = (size: number): number => size / detail;
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
    ball(s, N(1200), 0.03, Z(0.0055), 1, SUN_CORE, SUN_CORONA, rand, 0.3);
    ball(s, N(800), 0.065, Z(0.009), 0.16, SUN_CORONA, SUN_RIM, rand, 2.2);
    rays(s, N(70), 0.14, Z(0.0025), 0.28, SUN_CORONA, rand);
  });
  sun.position.y = 0.02;
  const haze = make('haze', (s) => {
    const rand = rng(11);
    for (let i = 0; i < N(500); i++) {
      const a = rand() * Math.PI * 2, rr = HOLO_RADIUS * Math.sqrt(rand());
      V.set(Math.cos(a) * rr, 0.01 + rand() * 0.05, Math.sin(a) * rr);
      S.setScalar(Z(0.03 + rand() * 0.05));
      s.pushSplat(V, S, Q, 0.02 / detail, DUST);
    }
    // The dome: a hemisphere of soft light.
    for (let i = 0; i < N(700); i++) {
      const u = rand(), v = rand();
      const theta = 2 * Math.PI * u, phi = Math.acos(1 - v); // upper half
      const r = HOLO_RADIUS * 1.02;
      V.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.85, r * Math.sin(phi) * Math.sin(theta));
      S.setScalar(Z(0.02 + rand() * 0.03));
      s.pushSplat(V, S, Q, 0.012 / detail, DUST);
    }
  });
  // The belt: thousands of grains in an annulus, a little thickness to it.
  let belt: SplatMeshT | null = null;
  const beltFor = (r: number): SplatMeshT => make('belt', (s) => ring(s, N(5000), r, 0.07, 0.07, Z(0.0022), 0.5, BELT, rng(5)));
  // The scan: a thin ring that climbs off the disc and fades, over and over.
  const sweep = make('sweep', (s) => ring(s, N(400), HOLO_RADIUS * 0.98, 0.004, 0.002, Z(0.003), 0.5, ATMOSPHERE, rng(31)));

  // One rig per planet: the body, its atmosphere, and the dust rings of the
  // stations round it (rebuilt when the set of ring radii changes).
  interface PlanetRig { group: THREE.Group; spin: THREE.Group; rings: SplatMeshT[]; ringKey: string; orbit: SplatMeshT | null; orbitR: number }
  const planets = new Map<string, PlanetRig>();
  const planetRig = (id: string): PlanetRig => {
    let rig = planets.get(id);
    if (rig) return rig;
    const g = new THREE.Group();
    g.name = `planet-${id}`;
    group.add(g);
    const { a, b, air } = lookOf(id);
    // The body and its air face the sun (place() turns `spin` toward it),
    // lit from that side; the rings and the foot stay put.
    const spin = new THREE.Group();
    const body = new SplatMesh({ constructSplats: (s) => shell(s, N(2000), 0.038, Z(0.0028), 1, a, b, rng(id.length * 31), 0.7) });
    // The atmosphere: the faintest rim just off the surface, not a glow.
    const atmo = new SplatMesh({ constructSplats: (s) => shell(s, N(260), 0.045, Z(0.006), 0.03, air, air, rng(id.length * 17), 0.4) });
    const foot = new SplatMesh({ constructSplats: (s) => pillar(s, N(90), 0.017 + SPLAT_LIFT / SPLAT_SCALE, 0.005, Z(0.0035), 0.08, DUST, rng(id.length * 5)) });
    spin.add(body); spin.add(atmo); g.add(spin); g.add(foot);
    rig = { group: g, spin, rings: [], ringKey: '', orbit: null, orbitR: 0 };
    planets.set(id, rig);
    return rig;
  };
  // A spark per station, a glow per Lagrange pocket — and under each
  // station a thread down (or up) to its planet's plane, for its height.
  const sparks = new Map<string, SplatMeshT>();
  const feet = new Map<string, THREE.Line>();
  const footMats = new Map<number, THREE.LineBasicMaterial>();
  const footFor = (id: string): THREE.Line => {
    let line = feet.get(id);
    if (line) return line;
    const hex = stationHue(id);
    let mat = footMats.get(hex);
    if (!mat) {
      mat = new THREE.LineBasicMaterial({ color: srgb(hex), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      footMats.set(hex, mat);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    line = new THREE.Line(geo, mat);
    line.name = `foot-${id}`;
    line.frustumCulled = false; // its bounds are never recomputed as it moves
    group.add(line);
    feet.set(id, line);
    return line;
  };
  const sparkFor = (id: string, kind: 'station' | 'lagrange'): SplatMeshT => {
    let m = sparks.get(id);
    if (m) return m;
    m = kind === 'station'
      ? make(`station-${id}`, (s) => { const rand = rng(id.length * 13 + 3); const { core, glow } = stationLook(stationHue(id)); ball(s, N(140), 0.008, Z(0.0028), 1, core, glow, rand, 0.4); ball(s, N(50), 0.014, Z(0.004), 0.12, glow, glow, rand, 1.5); })
      : make(`lagrange-${id}`, (s) => ball(s, N(110), 0.011, Z(0.004), 0.35, LAGRANGE, LAGRANGE, rng(id.length * 29), 1.0));
    sparks.set(id, m);
    return m;
  };
  // "You are here": an amber halo that breathes.
  const here = make('here', (s) => { const rand = rng(23); ring(s, N(320), 0.04, 0.006, 0.006, Z(0.0045), 1, HERE, rand); ball(s, N(160), 0.05, Z(0.009), 0.22, HERE, HERE, rand, 1.5); });
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
    for (const mat of footMats.values()) mat.opacity = 0.35 * alpha;
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
      let hereAt: { x: number; y: number; z: number } | null = null;
      for (const mk of markers) {
        const inc = inclinationOf(mk.frame);
        const p = holoPoint(mk);
        if (mk.type === 'planet') {
          const rig = planetRig(mk.id);
          seenPlanets.add(mk.id);
          rig.group.position.set(p.x, 0.017 + p.y, p.z);
          // Day side toward the sun (local +x), and a slow turn on top.
          rig.spin.rotation.y = Math.atan2(p.z, p.x) + Math.PI;
          // Its own orbit, as dust round the sun, on its tilted plane.
          if (mk.orbit && Math.abs(mk.orbit.r - rig.orbitR) > 1e-6) {
            rig.orbit?.removeFromParent(); rig.orbit?.dispose();
            const r = mk.orbit.r;
            rig.orbit = make(`orbit-${mk.id}`, (s) => ring(s, N(1800), r, 0.003, 0.002, Z(0.0022), 0.6, lookOf(mk.id).ring, rng(mk.id.length * 7)));
            rig.orbit.position.set(mk.orbit.cx, 0.004, mk.orbit.cz);
            tiltTo(rig.orbit, inc);
            rig.orbitR = r;
          }
        } else if (mk.type === 'station' || mk.type === 'lagrange') {
          const m = sparkFor(mk.id, mk.type);
          seenSparks.add(mk.id);
          m.position.set(p.x, 0.012 + p.y, p.z);
          if (mk.here) hereAt = p;
          if (mk.type === 'station' && mk.orbit) {
            const f = holoFoot(mk);
            const line = footFor(mk.id);
            const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
            pos.setXYZ(0, p.x, 0.012 + p.y, p.z);
            pos.setXYZ(1, f.x, 0.012 + f.y, f.z);
            pos.needsUpdate = true;
          }
        }
      }
      // Station rings: dust round each planet at the stations' radii, each
      // in its station's colour.
      const ringsByPlanet = new Map<string, Array<{ r: number; hex: number }>>();
      for (const mk of markers) {
        if (mk.type !== 'station' || !mk.orbit || !planets.has(mk.frame)) continue;
        (ringsByPlanet.get(mk.frame) ?? ringsByPlanet.set(mk.frame, []).get(mk.frame)!).push({ r: mk.orbit.r, hex: stationHue(mk.id) });
      }
      for (const [id, rig] of planets) {
        if (!seenPlanets.has(id)) { rig.group.visible = false; continue; }
        rig.group.visible = true;
        const rings = (ringsByPlanet.get(id) ?? []).map((x) => ({ key: `${x.r.toFixed(5)}:${x.hex}`, ...x })).sort((a, b) => (a.key < b.key ? -1 : 1));
        const ringKey = rings.map((x) => x.key).join(',');
        if (ringKey !== rig.ringKey) {
          for (const m of rig.rings) { m.removeFromParent(); m.dispose(); }
          rig.rings = [];
          // One ring each, on its own tilt (ringInclination), as the stations stand.
          for (const { r, hex } of rings) {
            const m = new SplatMesh({ constructSplats: (s) => ring(s, N(480), r, 0.002, 0.002, Z(0.0018), 0.5, stationLook(hex).glow, rng(id.length * 3 + Math.round(r * 1e4))) });
            m.position.y = -0.013;
            tiltTo(m, ringInclination(id, r));
            rig.group.add(m);
            rig.rings.push(m);
          }
          rig.ringKey = ringKey;
        }
      }
      for (const [id, m] of sparks) {
        if (seenSparks.has(id)) continue;
        m.removeFromParent(); m.dispose(); sparks.delete(id);
        const f = feet.get(id);
        if (f) { f.removeFromParent(); f.geometry.dispose(); feet.delete(id); }
      }
      if (!belt) {
        const b = markers.find((m) => m.type === 'asteroid-field');
        if (b) { belt = beltFor(Math.hypot(b.x, b.z) || HOLO_RADIUS * 0.93); belt.position.y = 0.006; tiltTo(belt, inclinationOf(b.frame), nowMs / 60000); }
      }
      if (belt) { const b = markers.find((m) => m.type === 'asteroid-field'); if (b) tiltTo(belt, inclinationOf(b.frame), nowMs / 60000); }
      sun.rotation.y = -nowMs / 7000;
      // The scan ring climbs and fades, SWEEP_PERIOD_S a climb.
      const sweepT = ((nowMs / 1000) % SWEEP_PERIOD_S) / SWEEP_PERIOD_S;
      sweep.position.y = 0.004 + SWEEP_HEIGHT * sweepT;
      sweep.scale.setScalar(1 - 0.35 * sweepT);
      if (hereAt) {
        here.visible = true;
        here.position.set(hereAt.x, 0.012 + hereAt.y, hereAt.z);
        here.scale.setScalar(1 + 0.18 * Math.sin(nowMs / 250));
      } else {
        here.visible = false;
      }
      setAlpha(alpha, nowMs);
    },
    dispose() {
      for (const m of all()) m.dispose();
      for (const f of feet.values()) f.geometry.dispose();
      for (const mat of footMats.values()) mat.dispose();
      for (const rig of planets.values()) { for (const m of rig.rings) m.dispose(); rig.orbit?.dispose(); }
      group.removeFromParent();
    },
  };
  return handle;
}
