/**
 * 🕹 The arcade cabinet as built (#193): every mesh inside its 1×1 footprint,
 * a screen handle filed through the shared list on a canvas-textured plane
 * facing +z (the player's side), a device of the arcade kind, and a screen
 * that redraws only when the view changes (the blink included).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import type { ArcadeScreenView } from './arcadeDoc';

let fills = 0;
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillRect') return () => { fills++; };
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      return () => undefined;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { buildItemGroup, FURNITURE_DEFS } = await import('./furniture');

const ID = 'arcade-cabinet-1';

function build(): THREE.Group {
  const group = buildItemGroup({ id: ID, kind: 'arcade-cabinet', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  group.updateMatrixWorld(true);
  return group;
}

function sinks(): FurnitureHandleSinks {
  return {
    wallScreens: new Map(), holoSpinners: [], trunkLids: new Map(), gameTableTops: new Map(),
    cloneVats: new Map(), slotMachineVisuals: new Map(), coinPusherVisuals: new Map(),
    propAnims: new Map(), airHockeyVisuals: new Map(), tvScreens: new Map(), arcadeScreens: new Map(),
  };
}

function screenPlane(group: THREE.Group): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshBasicMaterial).map instanceof THREE.CanvasTexture) found = obj;
  });
  return found;
}

const view = (mode: ArcadeScreenView['mode'], blink = false, title = 'PACMAN.ZIP'): ArcadeScreenView =>
  ({ mode, title, line: mode === 'inplay' ? 'P1 · Alice' : 'INSERT COIN', lane: mode === 'empty' ? '' : 'SOVEREIGN', blink, plays: 3 });

describe('the arcade cabinet as built', () => {
  it('keeps every mesh inside its 1×1 footprint', () => {
    const { w, d } = FURNITURE_DEFS['arcade-cabinet'].footprint!;
    const group = build();
    let meshes = 0;
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      meshes++;
      const box = new THREE.Box3().setFromObject(obj);
      expect(box.min.x).toBeGreaterThanOrEqual(-w / 2 - 1e-9);
      expect(box.max.x).toBeLessThanOrEqual(w / 2 + 1e-9);
      expect(box.min.z).toBeGreaterThanOrEqual(-d / 2 - 1e-9);
      expect(box.max.z).toBeLessThanOrEqual(d / 2 + 1e-9);
      expect(box.min.y).toBeGreaterThanOrEqual(-1e-9);
    });
    expect(meshes).toBeGreaterThan(8);
  });

  it('files a screen handle through the shared list, on a canvas-textured plane facing the player', () => {
    const group = build();
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, ID, obj); });
    expect(s.arcadeScreens.has(ID)).toBe(true);
    expect(s.tvScreens.size).toBe(0);
    const plane = screenPlane(group);
    expect(plane).not.toBeNull();
    const centre = new THREE.Box3().setFromObject(plane!).getCenter(new THREE.Vector3());
    expect(centre.z).toBeGreaterThan(0);
    expect(centre.y).toBeGreaterThan(1);
    const def = FURNITURE_DEFS['arcade-cabinet'];
    expect(def.device?.kind).toBe('arcade');
    expect(def.device?.front.z).toBeGreaterThan(d(def));
  });

  it('redraws only when the view changes — a blink is a change', () => {
    const group = build();
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, ID, obj); });
    const handle = s.arcadeScreens.get(ID)!;
    fills = 0;
    handle.draw(view('attract', true));
    const afterFirst = fills;
    expect(afterFirst).toBeGreaterThan(0);
    handle.draw(view('attract', true));
    expect(fills).toBe(afterFirst); // identical view: nothing redrawn
    handle.draw(view('attract', false));
    expect(fills).toBeGreaterThan(afterFirst); // the coin prompt blinked
    const afterBlink = fills;
    handle.draw(view('inplay'));
    expect(fills).toBeGreaterThan(afterBlink);
    const afterPlay = fills;
    handle.draw(view('empty', false, 'FURLONG ARCADE'));
    expect(fills).toBeGreaterThan(afterPlay);
  });
});

/** The footprint's half depth: the stand point must be outside the cabinet. */
function d(def: { footprint: { d: number } | null }): number {
  return (def.footprint?.d ?? 0) / 2;
}
