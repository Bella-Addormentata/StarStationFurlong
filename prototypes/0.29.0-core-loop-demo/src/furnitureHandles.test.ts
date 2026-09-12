// furnitureHandles.ts tests: the one-list contract for furniture drive
// handles. Filing semantics run on real three.js meshes (the helper stores the
// Mesh itself for spinners, so a stand-in would prove less), plus two
// source-level pins that keep the list single: both registration paths must
// call the helper and read no handle key off userData themselves (#117's
// drift), and World's one-path removal must still delete from every sink
// (#45 F1).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';

/**
 * Fresh, empty sinks — the same shape World hands out (world.ts). A sink added
 * to the interface fails this literal first, which also keeps the source pins
 * below (keyed off it) from drifting behind the interface.
 */
function freshSinks(): FurnitureHandleSinks {
  return {
    wallScreens: new Map(),
    holoSpinners: [],
    trunkLids: new Map(),
    gameTableTops: new Map(),
    cloneVats: new Map(),
    slotMachineVisuals: new Map(),
  };
}

/** A carrier mesh the way furniture.ts builds one: a Mesh with handles stowed on userData. */
function carrier(userData: Record<string, unknown>): THREE.Mesh {
  const mesh = new THREE.Mesh();
  Object.assign(mesh.userData, userData);
  return mesh;
}

/**
 * Handle stand-in: the helper only files the reference and never calls it, so
 * a tagged object is enough to prove identity survives filing.
 */
const handle = (tag: string): { tag: string } => ({ tag });

const ITEM = 'item-1';

describe('registerFurnitureHandles — filing', () => {
  it('files each handle kind into its own sink under the item id', () => {
    const sinks = freshSinks();
    const screen = handle('screen');
    const lid = handle('lid');
    const top = handle('top');
    const vat = handle('vat');
    const slot = handle('slot');
    const ring = carrier({ holoSpin: 1.5 });

    registerFurnitureHandles(sinks, ITEM, carrier({ wallScreen: screen }));
    registerFurnitureHandles(sinks, ITEM, ring);
    registerFurnitureHandles(sinks, ITEM, carrier({ trunkLid: lid }));
    registerFurnitureHandles(sinks, ITEM, carrier({ gameTableTop: top }));
    registerFurnitureHandles(sinks, ITEM, carrier({ cloneVat: vat }));
    registerFurnitureHandles(sinks, ITEM, carrier({ slotMachineVisual: slot }));

    expect(sinks.wallScreens.get(ITEM)).toBe(screen);
    expect(sinks.holoSpinners).toHaveLength(1);
    expect(sinks.holoSpinners[0]!.mesh).toBe(ring);
    expect(sinks.holoSpinners[0]!.speed).toBe(1.5);
    expect(sinks.trunkLids.get(ITEM)).toBe(lid);
    expect(sinks.gameTableTops.get(ITEM)).toBe(top);
    expect(sinks.cloneVats.get(ITEM)).toBe(vat);
    expect(sinks.slotMachineVisuals.get(ITEM)).toBe(slot);
    // Exactly one entry per sink — nothing filed twice or into a neighbour.
    expect([
      sinks.wallScreens.size,
      sinks.holoSpinners.length,
      sinks.trunkLids.size,
      sinks.gameTableTops.size,
      sinks.cloneVats.size,
      sinks.slotMachineVisuals.size,
    ]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('files every kind one carrier mesh carries', () => {
    const sinks = freshSinks();
    const all = carrier({
      wallScreen: handle('s'),
      holoSpin: 2,
      trunkLid: handle('l'),
      gameTableTop: handle('t'),
      cloneVat: handle('v'),
      slotMachineVisual: handle('m'),
    });
    registerFurnitureHandles(sinks, ITEM, all);
    expect(sinks.wallScreens.get(ITEM)).toBe(all.userData.wallScreen);
    expect(sinks.holoSpinners[0]!.mesh).toBe(all);
    expect(sinks.holoSpinners[0]!.speed).toBe(2);
    expect(sinks.trunkLids.get(ITEM)).toBe(all.userData.trunkLid);
    expect(sinks.gameTableTops.get(ITEM)).toBe(all.userData.gameTableTop);
    expect(sinks.cloneVats.get(ITEM)).toBe(all.userData.cloneVat);
    expect(sinks.slotMachineVisuals.get(ITEM)).toBe(all.userData.slotMachineVisual);
  });

  it('files nothing for a mesh without handles (unrelated userData included)', () => {
    const sinks = freshSinks();
    registerFurnitureHandles(sinks, ITEM, carrier({}));
    // The keys the callers DO read (reveal opacity, light fade) are not handles.
    registerFurnitureHandles(sinks, ITEM, carrier({ baseOpacity: 0.5, targetIntensity: 1.4 }));
    expect(sinks).toEqual(freshSinks());
  });

  it('object handles file by truthiness; holoSpin files by type (a stopped ring is still a ring)', () => {
    const sinks = freshSinks();
    registerFurnitureHandles(
      sinks,
      ITEM,
      carrier({ wallScreen: null, trunkLid: undefined, gameTableTop: false, cloneVat: 0, slotMachineVisual: '' }),
    );
    // A string "speed" is not a spinner tag — same typeof check both paths used.
    registerFurnitureHandles(sinks, ITEM, carrier({ holoSpin: '2' }));
    expect(sinks).toEqual(freshSinks());

    const stopped = carrier({ holoSpin: 0 });
    registerFurnitureHandles(sinks, ITEM, stopped);
    expect(sinks.holoSpinners).toHaveLength(1);
    expect(sinks.holoSpinners[0]!.mesh).toBe(stopped);
    expect(sinks.holoSpinners[0]!.speed).toBe(0);
  });

  it('per-item maps are keyed by item and keep the last carrier; spinners accumulate per mesh', () => {
    const sinks = freshSinks();
    const first = handle('first');
    const second = handle('second');
    const ringA = carrier({ holoSpin: 1, trunkLid: first });
    const ringB = carrier({ holoSpin: -1, trunkLid: second });
    const other = handle('other');

    registerFurnitureHandles(sinks, ITEM, ringA);
    registerFurnitureHandles(sinks, ITEM, ringB);
    registerFurnitureHandles(sinks, 'item-2', carrier({ trunkLid: other }));

    expect(sinks.trunkLids.size).toBe(2);
    expect(sinks.trunkLids.get(ITEM)).toBe(second);
    expect(sinks.trunkLids.get('item-2')).toBe(other);
    expect(sinks.holoSpinners).toHaveLength(2);
    expect(sinks.holoSpinners[0]!.mesh).toBe(ringA);
    expect(sinks.holoSpinners[0]!.speed).toBe(1);
    expect(sinks.holoSpinners[1]!.mesh).toBe(ringB);
    expect(sinks.holoSpinners[1]!.speed).toBe(-1);
  });
});

describe('registerFurnitureHandles — one list', () => {
  const src = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');
  const world = src('./world.ts');
  const devMenu = src('./devMenu.ts');

  /**
   * `<expr>.userData.<kind>` — a handle read. A private copy of the list is
   * exactly such a read outside furnitureHandles.ts. (A comment that names a
   * key without a leading dot, e.g. "tagged userData.holoSpin", doesn't match.)
   */
  const HANDLE_READ =
    /\.userData\.(wallScreen|holoSpin|trunkLid|gameTableTop|cloneVat|slotMachineVisual)\b/;

  it('both registration paths call the helper and keep no private copy of the list (#117)', () => {
    for (const [name, text] of [['world.ts', world], ['devMenu.ts', devMenu]] as const) {
      expect(text, `${name} must register handles through the shared list`).toContain(
        'registerFurnitureHandles(',
      );
      expect(
        text,
        `${name} reads a handle key off userData — file it in furnitureHandles.ts instead`,
      ).not.toMatch(HANDLE_READ);
    }
  });

  it("World's one-path removal deletes from every sink the list files into (#45 F1)", () => {
    for (const key of Object.keys(freshSinks())) {
      // Per-item maps: `this.<sink>.delete(`; the spinner list is rebuilt by filter.
      const inverse = new RegExp(`this\\.${key}\\.delete\\(|this\\.${key} = this\\.${key}\\.filter\\(`);
      expect(world, `world.ts has no inverse delete for sink "${key}"`).toMatch(inverse);
    }
  });
});
