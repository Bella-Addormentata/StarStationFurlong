/**
 * 🪙 Coin-pusher cabinet tests (issue #135): removing a cabinet frees every
 * geometry, material and texture it made, each once, and its chips hide with
 * it at the distant zoom levels. The cabinet is built
 * for real (buildItemGroup, with a stand-in canvas for its marquee), its
 * handle filed the way World files it, and it is taken apart the way
 * World.removeFurnitureVisuals does: the handle's dispose(), then a deduped
 * traversal of what is left.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import * as Y from 'yjs';
import { bindCasinoDoc, writeCoinPusherState } from './casinoDoc';
import type { CoinPusherVisualHandle } from './devices';
import { buildItemGroup } from './furniture';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import { chipsInMachine, initialCoinPusherState, processInsert, type CoinPusherState, type PusherHole } from './games/coinPusher';

const MACHINE = 'coin-pusher-1';

/** A canvas whose 2-D context draws nothing: the marquee paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

function machineWith(drops: number): CoinPusherState {
  let s = initialCoinPusherState('owner', 0);
  for (let i = 0; i < drops; i++) {
    s = processInsert(s, 'player', (i % 3) as PusherHole, (i * 0.37) % 1, i * 7919).state;
  }
  return s;
}

/** The ids the next geometry, material and texture will get: whatever the
 *  cabinet makes between two calls is its own. */
function nextIds() {
  return {
    geometry: new THREE.BufferGeometry().id,
    material: new THREE.MeshBasicMaterial().id,
    texture: new THREE.Texture().id,
  };
}

function between(from: number, to: number): number[] {
  return Array.from({ length: to - from - 1 }, (_, i) => from + 1 + i);
}

/** The cabinet, built and filed as World.registerFurnitureGroup does it. */
function buildCabinet(): { group: THREE.Group; handle: CoinPusherVisualHandle } {
  const group = buildItemGroup({ id: MACHINE, kind: 'coin-pusher', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  const sinks: FurnitureHandleSinks = {
    wallScreens: new Map(),
    holoSpinners: [],
    trunkLids: new Map(),
    gameTableTops: new Map(),
    cloneVats: new Map(),
    slotMachineVisuals: new Map(),
    coinPusherVisuals: new Map(),
    propAnims: new Map(),
  };
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) registerFurnitureHandles(sinks, MACHINE, obj);
  });
  const handle = sinks.coinPusherVisuals.get(MACHINE);
  if (!handle) throw new Error('the cabinet filed no handle');
  return { group, handle };
}

/** World.removeFurnitureVisuals' disposal (world.ts), from the handle on. */
function removeLikeWorld(group: THREE.Group, handle: CoinPusherVisualHandle): void {
  handle.dispose();
  const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
  group.traverse((obj) => {
    if (obj instanceof THREE.PointLight) {
      obj.dispose();
      return;
    }
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !disposed.has(mesh.geometry)) {
      disposed.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!mat || disposed.has(mat)) continue;
      disposed.add(mat);
      const map = (mat as THREE.MeshBasicMaterial).map;
      if (map && !map.userData.sharedCache) map.dispose();
      mat.dispose();
    }
  });
}

beforeEach(() => {
  bindCasinoDoc(new Y.Doc());
  vi.stubGlobal('document', { createElement: fakeCanvas });
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('coin pusher cabinet removal', () => {
  // No chip drawn yet; chips of one colour only (the other material on no
  // mesh); both colours.
  it.each([0, 1, 7])('frees everything the cabinet made, each once (%i drops)', (drops) => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose');
    const before = nextIds();
    const { group, handle } = buildCabinet();
    const state = machineWith(drops);
    writeCoinPusherState(MACHINE, state);
    handle.update(0.016);
    const chipsDrawn: THREE.Mesh[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.visible && obj.geometry instanceof THREE.CylinderGeometry) {
        chipsDrawn.push(obj);
      }
    });
    expect(chipsDrawn).toHaveLength(chipsInMachine(state));
    expect(new Set(chipsDrawn.map((chip) => chip.material)).size).toBe(Math.min(chipsDrawn.length, 2));
    const after = nextIds();

    removeLikeWorld(group, handle);

    const ids = (spy: { mock: { contexts: unknown[] } }) =>
      spy.mock.contexts.map((made) => (made as { id: number }).id).sort((a, b) => a - b);
    expect(ids(geometryDispose)).toEqual(between(before.geometry, after.geometry));
    expect(ids(materialDispose)).toEqual(between(before.material, after.material));
    expect(ids(textureDispose)).toEqual(between(before.texture, after.texture));
  });

  it('hides its chips at the distant zoom levels along with the meshes World registered', () => {
    const { group, handle } = buildCabinet();
    // What World registers, and hides at zoom 3+: the meshes there when the
    // cabinet is filed. The chips come later, from the pool.
    const registered: THREE.Mesh[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) registered.push(obj);
    });
    const state = machineWith(7);
    writeCoinPusherState(MACHINE, state);
    /** Chips that render: the chip itself and every parent visible. */
    const chipsShown = (): number => {
      let n = 0;
      group.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || !(obj.geometry instanceof THREE.CylinderGeometry)) return;
        let shown = true;
        for (let o: THREE.Object3D | null = obj; o; o = o.parent) shown &&= o.visible;
        if (shown) n += 1;
      });
      return n;
    };
    handle.update(0.016);
    expect(chipsShown()).toBe(chipsInMachine(state));

    for (const mesh of registered) mesh.visible = false; // zoom 3+, as World does it
    handle.update(0.016);
    expect(chipsShown()).toBe(0);

    for (const mesh of registered) mesh.visible = true; // back inside
    handle.update(0.016);
    expect(chipsShown()).toBe(chipsInMachine(state));
  });

  it("World's removal has the handle free them before its own traversal", () => {
    const world = readFileSync(new URL('./world.ts', import.meta.url), 'utf8');
    const start = world.indexOf('public removeFurnitureVisuals(');
    const body = world.slice(start, world.indexOf('\n  }\n', start));
    const handleDispose = body.indexOf('this.coinPusherVisuals.get(itemId)?.dispose();');
    expect(handleDispose).toBeGreaterThan(-1);
    expect(handleDispose).toBeLessThan(body.indexOf('group.traverse('));
  });
});
