// mapHologram.ts tests: the hologram over the map table (#251) is built
// with the table, driven by one handle, and shows the plot, then the
// station you are in, from what the holotable itself reads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { StationRecord } from './stations';
import type { PlanModule, StationPlan } from './stationPlan';

const here: StationRecord = { id: 'st-a', name: 'ALPHA', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-a' };
let station: StationRecord | null = here;
let stationList: StationRecord[] | null = null;
let plan: StationPlan | null = null;

// devices.ts hangs on window as it loads: the hologram needs one export of it.
vi.mock('./devices', () => ({ holotableStation: () => station }));
vi.mock('./stations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stations')>()),
  listStations: () => stationList ?? (station ? [station] : []),
  currentRoomId: () => 'room-a',
}));
vi.mock('./stationAtlas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stationAtlas')>()),
  readAtlas: () => ({}),
}));
vi.mock('./stationPlan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stationPlan')>()),
  stationPlan: () => plan ?? { rootRoomId: 'room-a', modules: [], ships: [], bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } },
}));

const { buildMapHologram, REFRESH_MS } = await import('./mapHologram');
const { setSparkProvider } = await import('./mapHologramSplats');
const { FADE_SECONDS, PLOT_SECONDS, STATION_SECONDS } = await import('./mapHologramLayout');

function module(roomId: string, x: number, z: number, opts: Partial<PlanModule> = {}): PlanModule {
  return {
    roomId, name: roomId, x, z, rotY: 0, halfX: 1, halfZ: 1, hops: 0, kind: 'module', here: false,
    gates: [], links: [], pairedFromInside: true, ...opts,
  };
}

/** Meshes the camera renders: on the default layer (parked ones sit on a
 *  layer the camera never renders, so they cost no draw call). */
const onCamera = (o: THREE.Object3D) => (o.layers.mask & 1) !== 0;

function build() {
  const group = new THREE.Group();
  const handle = buildMapHologram({ attach: (o) => group.add(o) }, 1.2, 0.9);
  const root = group.getObjectByName('map-hologram')!;
  const [plot, stationLayer] = root.children.filter((c) => c.type === 'Group') as THREE.Group[];
  const shown = (g: THREE.Object3D) => {
    let n = 0;
    g.traverse((o) => { if (o instanceof THREE.Mesh && onCamera(o)) n++; });
    return n;
  };
  const sun = (() => { let s: THREE.Mesh | null = null; root.traverse((o) => { if (o instanceof THREE.Mesh && o.userData.mapHologram) s = o; }); return s!; })();
  return { group, handle, root, plot: plot!, stationLayer: stationLayer!, shown, sun };
}

/** Drive `seconds` of frames at 20 fps. */
function run(handle: { update(dt: number): void }, seconds: number) {
  for (let t = 0; t < seconds; t += 0.05) handle.update(0.05);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 2));
  station = here;
  stationList = null;
  plan = null;
});
afterEach(() => { vi.useRealTimers(); });

describe('buildMapHologram', () => {
  it('attaches one root to the table, with its handle on the sun for World to file', () => {
    const { group, root, handle, sun } = build();
    expect(root.parent).toBe(group);
    expect(root.position.y).toBe(1.2);
    expect(sun.userData.mapHologram).toBe(handle);
    // Every material starts unseen (opacity 0) with its design opacity on
    // userData.baseOpacity, the way the room's fade-in expects.
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.Material;
        expect(m.opacity).toBe(0);
        expect(m.transparent).toBe(true);
        expect(typeof m.userData.baseOpacity).toBe('number');
        expect(m.blending).toBe(THREE.AdditiveBlending);
      }
    });
  });

  it('turns, and lays the plot out on the first frame: the sun, planets, rings, the belt and here', () => {
    const { handle, root, plot, shown } = build();
    const before = root.rotation.y;
    handle.update(0.5);
    expect(root.rotation.y).toBeGreaterThan(before);
    expect(plot.visible).toBe(true);
    // sun + belt + 2 planets + 2 planet rings + 2 Lagrange + the station + its ring + the here ring.
    expect(shown(plot)).toBe(11);
  });

  it('marks no station here when the holotable has none, and keeps the plot', () => {
    station = null;
    const { handle, plot, stationLayer, shown } = build();
    handle.update(0.1);
    // No station listed: no station marker, no station ring, no here ring.
    expect(shown(plot)).toBe(8);
    run(handle, PLOT_SECONDS + STATION_SECONDS / 2);
    expect(plot.visible).toBe(true);
    expect(stationLayer.visible).toBe(false);
  });

  it('fades to the station you are in, blocks at their poses and gangways between, then back', () => {
    plan = {
      rootRoomId: 'room-a',
      modules: [
        module('room-a', 0, 0, { here: true, links: [{ doorId: 'd1', toRoomId: 'room-b', berth: false }] }),
        module('room-b', 6, 0, { rotY: Math.PI / 2 }),
      ],
      ships: [module('ship', 0, 6, { kind: 'ship', links: [{ doorId: 'd2', toRoomId: 'room-a', berth: true }] })],
      bounds: { minX: -1, maxX: 7, minZ: -1, maxZ: 7 },
    };
    const { handle, plot, stationLayer, shown } = build();
    handle.update(0.1);
    expect(stationLayer.visible).toBe(false);
    // Into the station phase, past its fade-in.
    run(handle, PLOT_SECONDS + FADE_SECONDS + 1);
    expect(plot.visible).toBe(false);
    expect(stationLayer.visible).toBe(true);
    // 3 blocks + 2 gangways (the ship's berth is one).
    expect(shown(stationLayer)).toBe(5);
    const blocks = stationLayer.children.filter((o) => o instanceof THREE.Mesh && onCamera(o) && o.scale.y > 0.015) as THREE.Mesh[];
    expect(blocks).toHaveLength(3);
    const mats = new Set(blocks.map((b) => b.material));
    expect(mats.size).toBe(3); // here, module and ship each in their own light
    const turned = blocks.find((b) => Math.abs(b.rotation.y - Math.PI / 2) < 1e-9);
    expect(turned).toBeDefined();
    for (const m of stationLayer.children) {
      if (m instanceof THREE.Mesh && onCamera(m)) expect((m.material as THREE.Material).opacity).toBeCloseTo((m.material as THREE.Material).userData.baseOpacity as number, 9);
    }
    // And back to the plot.
    run(handle, STATION_SECONDS);
    expect(plot.visible).toBe(true);
    expect(stationLayer.visible).toBe(false);
  });

  it('parks every unused pool mesh off the camera, so a small plot costs no draw calls for its pools', () => {
    const { handle, root, plot, stationLayer, shown } = build();
    handle.update(0.1);
    let total = 0;
    root.traverse((o) => { if (o instanceof THREE.Mesh) total++; });
    // The pools are sized for the atlas's bounds; only the bodies in view are on the camera's layer.
    expect(total).toBeGreaterThan(100);
    expect(shown(plot)).toBe(11);
    expect(shown(stationLayer)).toBe(0);
    // A parked mesh keeps `visible` (World's zoom hide owns that) and sits on the parked layer.
    const parked = plot.children.find((o) => o instanceof THREE.Mesh && (o.layers.mask & 1) === 0)!;
    expect(parked.visible).toBe(true);
  });

  it('grows its block and gangway pools past the atlas bound, the extra meshes taking the sun\'s zoom hide', () => {
    const many: PlanModule[] = [];
    for (let i = 0; i < 90; i++) many.push(module(`room-${i}`, (i % 10) * 4, Math.floor(i / 10) * 4, { here: i === 0, links: i > 0 ? [{ doorId: 'd', toRoomId: `room-${i - 1}`, berth: false }] : [] }));
    plan = { rootRoomId: 'room-0', modules: many, ships: [], bounds: { minX: -1, maxX: 37, minZ: -1, maxZ: 33 } };
    const { handle, stationLayer, shown, sun } = build();
    handle.update(0.1);
    run(handle, PLOT_SECONDS + FADE_SECONDS + 1);
    // 90 blocks and 89 gangways: every module and every link, none dropped.
    expect(shown(stationLayer)).toBe(90 + 89);
    sun.visible = false;
    handle.update(0.05);
    const grown = stationLayer.children.filter((o) => o instanceof THREE.Mesh && !o.visible);
    expect(grown.length).toBeGreaterThan(0);
    sun.visible = true;
    handle.update(0.05);
    expect(stationLayer.children.every((o) => !(o instanceof THREE.Mesh) || o.visible)).toBe(true);
  });

  it('grows the station pools past the slot count, which stations in transit and bounced arrivals exceed', () => {
    const many: StationRecord[] = [];
    for (let i = 0; i < 40; i++) many.push({ id: `st-${i}`, name: `S${i}`, planetId: 'planet-sovereign', orbitSlot: i % 16, welcomeRoomId: `room-${i}` });
    stationList = many;
    const { handle, plot, shown } = build();
    handle.update(0.1);
    // sun + belt + 2 planets + 2 planet rings + 2 pockets, and a marker and a ring for each of the 40.
    expect(shown(plot)).toBe(8 + 40 * 2);
  });

  it('hands the splats the sun\'s opacity once, not with the plot fade squared', async () => {
    class FakeSplatMesh extends THREE.Object3D { packedSplats = { numSplats: 0 }; opacity = 1; constructor(o: { constructSplats?: (s: { pushSplat: () => void }) => void } = {}) { super(); o.constructSplats?.({ pushSplat: () => { this.packedSplats.numSplats++; } }); } dispose() {} }
    setSparkProvider(async () => ({ spark: { SplatMesh: FakeSplatMesh } as never, renderer: {} as never }));
    // A station to cycle to, so the plot fades at all.
    plan = { rootRoomId: 'room-a', modules: [module('room-a', 0, 0, { here: true })], ships: [], bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 } };
    try {
      const { handle, root, sun } = build();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const splatGroup = root.getObjectByName('map-hologram-splats');
      expect(splatGroup).toBeDefined();
      // Mid-transition: the plot fade is 0.5; the sun carries it; the splats get the same, once.
      const mat = sun.material as THREE.MeshBasicMaterial;
      // The cycle starts FADE_SECONDS in; stop half a fade before the plot goes.
      run(handle, PLOT_SECONDS - 1.5 * FADE_SECONDS);
      const base = mat.userData.baseOpacity as number;
      expect(mat.opacity / base).toBeCloseTo(0.5, 1);
      let splatOpacity = -1;
      splatGroup!.traverse((o) => { if (o instanceof FakeSplatMesh && o.name === 'sun') splatOpacity = o.opacity; });
      expect(splatOpacity).toBeCloseTo(mat.opacity / base, 6);
    } finally {
      setSparkProvider(null);
    }
  });

  it('never frustum-culls a course line, whose points change under it', () => {
    const { root } = build();
    root.traverse((o) => { if (o instanceof THREE.Line) expect(o.frustumCulled).toBe(false); });
  });

  it('frees its course lines with the table, which World cannot reach (they are not meshes)', () => {
    const { root } = build();
    const lines: THREE.Line[] = [];
    root.traverse((o) => { if (o instanceof THREE.Line) lines.push(o); });
    expect(lines.length).toBeGreaterThan(0);
    const geoSpies = lines.map((l) => vi.spyOn(l.geometry, 'dispose'));
    const matSpy = vi.spyOn(lines[0]!.material as THREE.Material, 'dispose');
    expect(typeof root.userData.disposeCourses).toBe('function');
    (root.userData.disposeCourses as () => void)();
    for (const sp of geoSpies) expect(sp).toHaveBeenCalled();
    expect(matSpy).toHaveBeenCalled();
  });

  it('re-reads the station every REFRESH_MS, so a table kept across a room swap follows', () => {
    const { handle, plot, stationLayer, shown } = build();
    handle.update(0.1);
    expect(shown(plot)).toBe(11);
    station = null;
    handle.update(0.1);
    expect(shown(plot)).toBe(11); // not yet
    vi.setSystemTime(Date.now() + REFRESH_MS + 1);
    handle.update(0.1);
    expect(shown(plot)).toBe(8);
    expect(stationLayer.visible).toBe(false);
  });
});
