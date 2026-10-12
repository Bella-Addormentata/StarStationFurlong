/**
 * 🥣 Faucet dish fixture tests (#231 onboarding): the furniture builds for
 * real (buildItemGroup, with a stand-in canvas for its plaque), files ONE
 * FaucetDishHandle the way World files it, and the handle moves the prop the
 * way the design says: the jar's gold column follows the fill level, the mojo
 * in the dish shows only while a coin is claimable, and the pips swap while a
 * take or give is in flight. Everything is shown/hidden by scale, never by
 * .visible, so the morph machinery (which walks materials) has nothing to
 * fight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FURNITURE_DEFS, buildItemGroup } from './furniture';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';

const DISH = 'faucet-dish-1';

/** A canvas whose 2-D context draws nothing: the plaque paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

function freshSinks(): FurnitureHandleSinks {
  return {
    wallScreens: new Map(),
    holoSpinners: [],
    trunkLids: new Map(),
    gameTableTops: new Map(),
    cloneVats: new Map(),
    slotMachineVisuals: new Map(),
    coinPusherVisuals: new Map(),
    propAnims: new Map(),
    airHockeyVisuals: new Map(),
    tvScreens: new Map(),
    arcadeScreens: new Map(),
    arcadeCabinetVisuals: new Map(),
    alligatorsVisuals: new Map(),
    casinoTableVisuals: new Map(),
    faucetDishes: new Map(),
  };
}

/** The dish, built and filed as World.registerFurnitureGroup does it. */
function buildDish() {
  const group = buildItemGroup({ id: DISH, kind: 'faucet-dish', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  const sinks = freshSinks();
  const meshes: THREE.Mesh[] = [];
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      meshes.push(obj);
      registerFurnitureHandles(sinks, DISH, obj);
    }
  });
  const handle = sinks.faucetDishes.get(DISH);
  if (!handle) throw new Error('faucet dish filed no handle');
  // The handle rides the jar's gold column (the one mesh whose height follows the level).
  const liquid = meshes.find((mesh) => mesh.userData.faucetDish === handle);
  if (!liquid) throw new Error('faucet dish handle is not stowed on a mesh');
  // Hidden-by-scale meshes at boot: the mojo disc and the busy pip.
  const hidden = () => meshes.filter((mesh) => mesh.scale.x < 0.01);
  return { group, sinks, handle, liquid, hidden };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: fakeCanvas });
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('faucet dish fixture', () => {
  it('is a 1×1 device fixture facing -z with the faucetDish function, like the cashier', () => {
    const def = FURNITURE_DEFS['faucet-dish'];
    expect(def.footprint).toEqual({ w: 1, d: 1 });
    expect(def.functions).toContain('faucetDish');
    expect(def.device?.kind).toBe('faucetDish');
    expect(def.device?.front).toEqual({ x: 0, z: -1.0 });
  });

  it('files exactly one FaucetDishHandle and nothing into the other sinks', () => {
    const { sinks } = buildDish();
    expect(sinks.faucetDishes.size).toBe(1);
    for (const [key, sink] of Object.entries(sinks)) {
      if (key === 'faucetDishes') continue;
      expect(Array.isArray(sink) ? sink.length : sink.size, `sink ${key} should be empty`).toBe(0);
    }
  });

  it('boots empty: a near-flat column, the mojo and busy pip hidden by scale', () => {
    const { liquid, hidden } = buildDish();
    expect(liquid.scale.y).toBeCloseTo(0.02, 5);
    expect(hidden()).toHaveLength(2);
  });

  it('follows the fill level, clamped to [0, 1]', () => {
    const { handle, liquid } = buildDish();
    const bottom = liquid.position.y - (liquid.scale.y * 0.46) / 2;
    handle.setState(0.5, 0, false);
    expect(liquid.scale.y).toBeCloseTo(0.5, 5);
    // The column grows from the jar floor, so its centre rises with it.
    expect(liquid.position.y - (0.5 * 0.46) / 2).toBeCloseTo(bottom, 5);
    handle.setState(7, 0, false);
    expect(liquid.scale.y).toBeCloseTo(1, 5);
    handle.setState(-3, 0, false);
    expect(liquid.scale.y).toBeCloseTo(0.02, 5);
  });

  it('shows the mojo only while a coin is claimable and swaps pips while pending', () => {
    const { handle, hidden } = buildDish();
    handle.setState(0.25, 1, false);
    expect(hidden()).toHaveLength(1); // mojo out, busy pip still hidden
    handle.setState(0.25, 1, true);
    expect(hidden()).toHaveLength(1); // idle pip hidden instead of the busy one
    handle.setState(0.25, 0, true);
    expect(hidden()).toHaveLength(2); // mojo back in hiding
    handle.setState(0.25, 0, false);
    expect(hidden()).toHaveLength(2);
  });
});
