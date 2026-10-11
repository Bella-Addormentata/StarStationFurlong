/**
 * 🎲 The 3D craps table's chips (#226): however many chips are on the felt,
 * every one renders — a full chip pool grows rather than dropping chips.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { railStacks, type CasinoTableVisualHandle } from './casinoTable3d';
import { railChipCounts } from './chipDisplay';
import { buildItemGroup } from './furniture';

/** A canvas whose 2-D context draws nothing: the felt paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

function chipsDrawn(group: THREE.Group): number {
  let n = 0;
  group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) n += (o as THREE.InstancedMesh).count;
  });
  return n;
}

describe('the craps table chips', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
    vi.stubGlobal('window', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders every chip, past the starting pool size', () => {
    const group = buildItemGroup({ id: 'craps-1', kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    let handle: CasinoTableVisualHandle | null = null;
    group.traverse((o) => {
      if (o.userData.casinoTable) handle = o.userData.casinoTable as CasinoTableVisualHandle;
    });
    expect(handle).not.toBeNull();
    const h = handle as unknown as CasinoTableVisualHandle;
    const meshesBefore: THREE.Object3D[] = [];
    group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshesBefore.push(o); });
    // 50 stacks of twenty $1 chips: 1000 chips of one denomination.
    const stacks = Array.from({ length: 50 }, (_, i) => ({
      x: -1.2 + (i % 10) * 0.25, z: -0.3 + Math.floor(i / 10) * 0.15,
      chips: new Array(20).fill(1), dim: false,
    }));
    h.setFeltChips(stacks);
    h.update(0);
    expect(chipsDrawn(group)).toBeGreaterThanOrEqual(1000);
    // The pools grew in place: the very meshes World registered at placement.
    const meshesAfter: THREE.Object3D[] = [];
    group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshesAfter.push(o); });
    expect(meshesAfter).toEqual(meshesBefore);
    // And it settles back once the felt clears.
    h.setFeltChips([]);
    h.update(0);
    expect(chipsDrawn(group)).toBeLessThan(1000);
  });

  it('keeps small chips on a crowded rail', () => {
    const rail = railStacks({ x: 0, z: -0.48, axis: 'x', len: 0.62 }, railChipCounts(123456));
    const denoms = new Set(rail.map((s) => s.denom));
    for (const d of [1, 5, 25, 100]) expect(denoms.has(d), `$${d}`).toBe(true);
    // Still largest first along the rail.
    expect(rail.map((s) => s.denom)).toEqual([...rail.map((s) => s.denom)].sort((a, b) => b - a));
  });
});

describe('the Fair / Friendly plaque', () => {
  it('lies on clear felt: no betting box, the dice spot or the wheel under it', async () => {
    const { fairPlaqueCentre, FAIR_PLAQUE_SIZE } = await import('./casinoTable3d');
    const { CRAPS_DICE_SPOT, CRAPS_LAYOUT, ROULETTE_LAYOUT, ROULETTE_WHEEL } = await import('./games/casinoLayout');
    const { w, h } = FAIR_PLAQUE_SIZE;
    const cases: Array<{ layout: { settings: typeof CRAPS_LAYOUT.settings; felt: typeof CRAPS_LAYOUT.felt; regions: Array<{ rects: typeof CRAPS_LAYOUT.felt[] }> }; at: 'right' | 'front' }> = [
      { layout: CRAPS_LAYOUT, at: 'right' },
      { layout: ROULETTE_LAYOUT, at: 'front' },
    ];
    for (const { layout, at } of cases) {
      const c = fairPlaqueCentre(layout.settings, at);
      const p = { x0: c.x - w / 2, x1: c.x + w / 2, z0: c.z - h / 2, z1: c.z + h / 2 };
      expect(p.x0 > layout.felt.x0 && p.x1 < layout.felt.x1 && p.z0 > layout.felt.z0 && p.z1 < layout.felt.z1).toBe(true);
      for (const rg of layout.regions) {
        for (const r of rg.rects) {
          expect(r.x0 < p.x1 && r.x1 > p.x0 && r.z0 < p.z1 && r.z1 > p.z0).toBe(false);
        }
      }
      // Clear of the ⚙️ itself.
      const g = layout.settings;
      expect(g.x + g.r < p.x0 || g.x - g.r > p.x1 || g.z + g.r < p.z0 || g.z - g.r > p.z1).toBe(true);
    }
    const crapsP = fairPlaqueCentre(CRAPS_LAYOUT.settings, 'right');
    expect(Math.abs(crapsP.x - CRAPS_DICE_SPOT.x)).toBeGreaterThan(w / 2 + 0.03);
    // The roulette plaque's nearest corner stays outside the wheel's surround.
    const rp = fairPlaqueCentre(ROULETTE_LAYOUT.settings, 'front');
    const dx = Math.max(0, Math.abs(rp.x - ROULETTE_WHEEL.x) - w / 2);
    const dz = Math.max(0, Math.abs(rp.z - ROULETTE_WHEEL.z) - h / 2);
    expect(Math.hypot(dx, dz)).toBeGreaterThan(ROULETTE_WHEEL.r + 0.03);
  });
});
