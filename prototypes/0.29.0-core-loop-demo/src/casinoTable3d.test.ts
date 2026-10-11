/**
 * 🎲 The 3D craps table's chips (#226): however many chips are on the felt,
 * every one renders — a full chip pool grows rather than dropping chips.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { railStacks, type CasinoTableVisualHandle } from './casinoTable3d';
import { railChips } from './chipDisplay';
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
    // 50 stacks of twenty $1 chips: 1000 chips of one denomination.
    const stacks = Array.from({ length: 50 }, (_, i) => ({
      x: -1.2 + (i % 10) * 0.25, z: -0.3 + Math.floor(i / 10) * 0.15,
      chips: new Array(20).fill(1), dim: false,
    }));
    h.setFeltChips(stacks);
    h.update(0);
    expect(chipsDrawn(group)).toBeGreaterThanOrEqual(1000);
    // And it settles back once the felt clears.
    h.setFeltChips([]);
    h.update(0);
    expect(chipsDrawn(group)).toBeLessThan(1000);
  });

  it('keeps small chips on a crowded rail', () => {
    const rail = railStacks({ x: 0, z: -0.48, axis: 'x', len: 0.62 }, railChips(123456));
    const denoms = new Set(rail.map((s) => s.denom));
    for (const d of [1, 5, 25, 100]) expect(denoms.has(d), `$${d}`).toBe(true);
    // Still largest first along the rail.
    expect(rail.map((s) => s.denom)).toEqual([...rail.map((s) => s.denom)].sort((a, b) => b - a));
  });
});
