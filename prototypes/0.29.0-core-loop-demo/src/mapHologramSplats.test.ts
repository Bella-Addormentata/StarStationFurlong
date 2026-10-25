// mapHologramSplats.ts tests: the splat plot over the map table (#251 v2)
// is built from whatever Spark the provider hands over, lays the markers
// out as rigs and sparks, and takes the plot's fade as its own.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HOLO_RADIUS, holoPoint, inclinationOf, inclinedPoint, type HoloMarker } from './mapHologramLayout';
import { SPLAT_LIFT, SPLAT_SCALE, buildSplatPlot, setSparkProvider } from './mapHologramSplats';

/** A stand-in SplatMesh: counts the splats pushed, keeps opacity, disposes. */
class FakeSplatMesh extends THREE.Object3D {
  packedSplats = { numSplats: 0 };
  opacity = 1;
  disposed = false;
  constructor(opts: { constructSplats?: (s: { pushSplat: (...args: unknown[]) => void }) => void } = {}) {
    super();
    opts.constructSplats?.({ pushSplat: () => { this.packedSplats.numSplats++; } });
  }
  dispose(): void { this.disposed = true; }
}

const marker = (id: string, type: HoloMarker['type'], x: number, z: number, extra: Partial<HoloMarker> = {}): HoloMarker =>
  ({ id, name: id, type, x, z, here: false, frame: type === 'planet' || type === 'asteroid-field' ? id : type === 'star' ? '' : 'planet-sovereign', ...extra });

const sovereign = marker('planet-sovereign', 'planet', 0.3, 0, { orbit: { cx: 0, cz: 0, r: 0.3 } });
const aris = marker('planet-aris', 'planet', 0, 0.17, { orbit: { cx: 0, cz: 0, r: 0.17 } });
const station = marker('st-a', 'station', 0.36, 0, { orbit: { cx: 0.3, cz: 0, r: 0.06 } });
const belt = marker('belt-ring', 'asteroid-field', 0.46, 0);
const sun = marker('star-sol', 'star', 0, 0);
const l4 = marker('lagrange-l4', 'lagrange', 0.15, 0.26);

beforeEach(() => {
  setSparkProvider(async () => ({ spark: { SplatMesh: FakeSplatMesh } as never, renderer: {} as never }));
});
afterEach(() => setSparkProvider(null));

const splats = (o: THREE.Object3D): FakeSplatMesh[] => {
  const out: FakeSplatMesh[] = [];
  o.traverse((c) => { if (c instanceof FakeSplatMesh) out.push(c); });
  return out;
};

describe('buildSplatPlot', () => {
  it('is nothing without a provider, and the mesh plot stays', async () => {
    setSparkProvider(null);
    const parent = new THREE.Group();
    expect(await buildSplatPlot(parent)).toBeNull();
    expect(parent.children).toHaveLength(0);
  });

  it('swallows a provider that fails', async () => {
    setSparkProvider(async () => { throw new Error('no WebGL2'); });
    expect(await buildSplatPlot(new THREE.Group())).toBeNull();
  });

  it('grows and lifts the plot, and builds the sun, haze and scan up front', async () => {
    const parent = new THREE.Group();
    const h = (await buildSplatPlot(parent))!;
    expect(h.group.parent).toBe(parent);
    expect(h.group.scale.x).toBe(SPLAT_SCALE);
    expect(h.group.position.y).toBe(SPLAT_LIFT);
    const names = splats(h.group).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['sun', 'haze', 'sweep', 'here']));
    for (const m of splats(h.group)) expect(m.packedSplats.numSplats).toBeGreaterThan(0);
  });

  it('lays out a rig per planet, a spark per station and pocket, the belt, and here', async () => {
    const parent = new THREE.Group();
    const h = (await buildSplatPlot(parent))!;
    h.place([sun, aris, sovereign, { ...station, here: true }, l4, belt], 1_000, 1, true);
    const rigs = h.group.children.filter((c) => c.name.startsWith('planet-'));
    expect(rigs.map((r) => r.name).sort()).toEqual(['planet-planet-aris', 'planet-planet-sovereign']);
    const sov = rigs.find((r) => r.name === 'planet-planet-sovereign')!;
    const tilted = inclinedPoint(0.3, 0, inclinationOf('planet-sovereign'));
    expect(sov.position.x).toBeCloseTo(tilted.x, 9);
    expect(sov.position.y).toBeCloseTo(0.017 + tilted.y, 9);
    // Its orbit dust, at the orbit's radius; its station's ring round it.
    const orbit = h.group.children.find((c) => c.name === 'orbit-planet-sovereign');
    expect(orbit).toBeDefined();
    // The spin (body + atmosphere, turned to face the sun), the foot, the station rings.
    expect(sov.children.length).toBe(3);
    expect(splats(sov).length).toBe(4);
    expect(h.group.children.some((c) => c.name === 'station-st-a')).toBe(true);
    expect(h.group.children.some((c) => c.name === 'lagrange-lagrange-l4')).toBe(true);
    expect(h.group.children.some((c) => c.name === 'belt')).toBe(true);
    const here = h.group.children.find((c) => c.name === 'here')!;
    expect(here.visible).toBe(true);
    expect(here.position.x).toBeCloseTo(holoPoint({ ...station, here: true }).x, 9);
    // Nothing reaches past the disc before the group's own growth.
    expect(Math.hypot(here.position.x, here.position.z)).toBeLessThanOrEqual(HOLO_RADIUS);
  });

  it('takes the plot fade as its opacity, hides with the sun, and drops a station that left', async () => {
    const h = (await buildSplatPlot(new THREE.Group()))!;
    h.place([sun, sovereign, station], 0, 0.4, true);
    for (const m of splats(h.group)) if (m.name !== 'sweep') expect(m.opacity).toBeCloseTo(0.4, 9);
    expect(h.group.visible).toBe(true);
    h.place([sun, sovereign, station], 0, 0.4, false);
    expect(h.group.visible).toBe(false);
    h.place([sun, sovereign], 0, 1, true);
    expect(h.group.children.some((c) => c.name === 'station-st-a')).toBe(false);
    expect(h.group.children.find((c) => c.name === 'here')!.visible).toBe(false);
  });

  it('disposes every splat mesh and leaves the parent', async () => {
    const parent = new THREE.Group();
    const h = (await buildSplatPlot(parent))!;
    h.place([sun, sovereign, station, belt], 0, 1, true);
    const all = splats(h.group);
    expect(all.length).toBeGreaterThan(5);
    h.dispose();
    expect(parent.children).toHaveLength(0);
    for (const m of all) expect(m.disposed).toBe(true);
  });
});
