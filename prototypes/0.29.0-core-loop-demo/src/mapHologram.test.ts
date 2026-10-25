// mapHologram.ts tests: the hologram over the map table (#251) is built
// with the table, driven by one handle, and shows the plot, then the
// station you are in, from what the holotable itself reads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { StationRecord } from './stations';
import type { PlanModule, StationPlan } from './stationPlan';

const here: StationRecord = { id: 'st-a', name: 'ALPHA', planetId: 'planet-sovereign', orbitSlot: 1, welcomeRoomId: 'room-a' };
let station: StationRecord | null = here;
let plan: StationPlan | null = null;

// devices.ts hangs on window as it loads: the hologram needs one export of it.
vi.mock('./devices', () => ({ holotableStation: () => station }));
vi.mock('./stations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stations')>()),
  listStations: () => (station ? [station] : []),
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
const { FADE_SECONDS, PLOT_SECONDS, STATION_SECONDS } = await import('./mapHologramLayout');

function module(roomId: string, x: number, z: number, opts: Partial<PlanModule> = {}): PlanModule {
  return {
    roomId, name: roomId, x, z, rotY: 0, halfX: 1, halfZ: 1, hops: 0, kind: 'module', here: false,
    gates: [], links: [], pairedFromInside: true, ...opts,
  };
}

function build() {
  const group = new THREE.Group();
  const handle = buildMapHologram({ attach: (o) => group.add(o) }, 1.2, 0.9);
  const root = group.getObjectByName('map-hologram')!;
  const [plot, stationLayer] = root.children.filter((c) => c.type === 'Group') as THREE.Group[];
  const shown = (g: THREE.Object3D) => {
    let n = 0;
    g.traverse((o) => { if (o instanceof THREE.Mesh && o.scale.x > 0) n++; });
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
    const blocks = stationLayer.children.filter((o) => o instanceof THREE.Mesh && o.scale.x > 0 && o.scale.y > 0.015) as THREE.Mesh[];
    expect(blocks).toHaveLength(3);
    const mats = new Set(blocks.map((b) => b.material));
    expect(mats.size).toBe(3); // here, module and ship each in their own light
    const turned = blocks.find((b) => Math.abs(b.rotation.y - Math.PI / 2) < 1e-9);
    expect(turned).toBeDefined();
    for (const m of stationLayer.children) {
      if (m instanceof THREE.Mesh && m.scale.x > 0) expect((m.material as THREE.Material).opacity).toBeCloseTo((m.material as THREE.Material).userData.baseOpacity as number, 9);
    }
    // And back to the plot.
    run(handle, STATION_SECONDS);
    expect(plot.visible).toBe(true);
    expect(stationLayer.visible).toBe(false);
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
