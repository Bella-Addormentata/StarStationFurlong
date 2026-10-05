/**
 * 📺 The smart TV as built (#186): the wall set lives in front of its
 * mount plane and inside the registry's clearance width, the stand set stays
 * inside its 2×1 footprint, and both carry a screen handle on a canvas-
 * textured plane that redraws only when the view changes.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import type { TvScreenView } from './tvDoc';
import { setConvenienceLanesForTest } from './sovereignty';

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

function build(kind: 'smart-tv' | 'tv-stand'): THREE.Group {
  const group = buildItemGroup({ id: `${kind}-1`, kind, pos: { x: 0, z: 0 }, rot: 0, movable: true });
  group.updateMatrixWorld(true);
  return group;
}

function sinks(): FurnitureHandleSinks {
  return {
    wallScreens: new Map(), holoSpinners: [], trunkLids: new Map(), gameTableTops: new Map(),
    cloneVats: new Map(), slotMachineVisuals: new Map(), coinPusherVisuals: new Map(),
    propAnims: new Map(), airHockeyVisuals: new Map(), tvScreens: new Map(),
  };
}

function screenPlane(group: THREE.Group): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshBasicMaterial).map instanceof THREE.CanvasTexture) found = obj;
  });
  return found;
}

const view = (state: TvScreenView['state'], title = ''): TvScreenView =>
  ({ state, title, detail: 'REMOTE ON THE SET', lane: state === 'off' || state === 'home' ? '' : 'CONVENIENCE', clockText: '0:00' });

describe('the smart TV as built', () => {
  it('the wall set sits in front of its mount plane, within the registry\'s clearance width', () => {
    const group = build('smart-tv');
    const halfW = FURNITURE_DEFS['smart-tv'].wallMount!.halfW;
    const box = new THREE.Box3().setFromObject(group);
    expect(box.min.z).toBeGreaterThanOrEqual(-1e-6);
    expect(box.max.x).toBeLessThanOrEqual(halfW + 1e-6);
    expect(box.min.x).toBeGreaterThanOrEqual(-halfW - 1e-6);
    expect(FURNITURE_DEFS['smart-tv'].footprint).toBeNull(); // never an obstacle
  });

  it('the stand set keeps every mesh inside its 2×1 footprint', () => {
    const { w, d } = FURNITURE_DEFS['tv-stand'].footprint!;
    const group = build('tv-stand');
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(obj);
      expect(box.min.x).toBeGreaterThanOrEqual(-w / 2 - 1e-9);
      expect(box.max.x).toBeLessThanOrEqual(w / 2 + 1e-9);
      expect(box.min.z).toBeGreaterThanOrEqual(-d / 2 - 1e-9);
      expect(box.max.z).toBeLessThanOrEqual(d / 2 + 1e-9);
    });
  });

  it('both file a screen handle through the shared list, on a canvas-textured plane facing +z', () => {
    for (const kind of ['smart-tv', 'tv-stand'] as const) {
      const group = build(kind);
      const s = sinks();
      group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, `${kind}-1`, obj); });
      expect(s.tvScreens.has(`${kind}-1`)).toBe(true);
      const plane = screenPlane(group);
      expect(plane).not.toBeNull();
      const centre = new THREE.Box3().setFromObject(plane!).getCenter(new THREE.Vector3());
      expect(centre.z).toBeGreaterThan(0);
      expect(FURNITURE_DEFS[kind].device?.kind).toBe('smartTv');
    }
  });

  it('redraws only when the view changes', () => {
    const group = build('smart-tv');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'smart-tv-1', obj); });
    const handle = s.tvScreens.get('smart-tv-1')!;
    fills = 0;
    handle.draw(view('home'));
    const afterHome = fills;
    expect(afterHome).toBeGreaterThan(0);
    handle.draw(view('home'));
    expect(fills).toBe(afterHome); // identical view: nothing redrawn
    handle.draw(view('playing', 'METROPOLIS'));
    expect(fills).toBeGreaterThan(afterHome);
    handle.draw(view('off'));
    expect(fills).toBeGreaterThan(afterHome);
  });

  it('keeps the set\'s glow lit through the room morph: the level is re-applied on every tick, even an unchanged view', () => {
    const group = build('smart-tv');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'smart-tv-1', obj); });
    const handle = s.tvScreens.get('smart-tv-1')!;
    let glow: THREE.PointLight | null = null;
    group.traverse((obj) => { if (obj instanceof THREE.PointLight) glow = obj; });
    expect(glow).not.toBeNull();
    expect(glow!.intensity).toBe(0); // off, as built
    handle.draw(view('home'));
    expect(glow!.intensity).toBe(0.5);
    glow!.intensity = 0; // World's morph pass: eased × the registered target (0)
    fills = 0;
    handle.draw(view('home')); // the same view: no redraw…
    expect(fills).toBe(0);
    expect(glow!.intensity).toBe(0.5); // …but the glow is the view's again
    handle.draw(view('playing', 'METROPOLIS'));
    expect(glow!.intensity).toBe(1.1);
    handle.draw(view('off'));
    expect(glow!.intensity).toBe(0);
  });

  it('draws on the home screen only the tiles this build offers: YOUTUBE and ARCHIVE go with the convenience lanes', () => {
    const group = build('smart-tv');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'smart-tv-1', obj); });
    const handle = s.tvScreens.get('smart-tv-1')!;
    try {
      setConvenienceLanesForTest(false); // the build default: serverless only
      handle.draw(view('off'));
      fills = 0;
      handle.draw(view('home'));
      const serverless = fills;
      setConvenienceLanesForTest(true);
      handle.draw(view('off'));
      fills = 0;
      handle.draw(view('home'));
      expect(fills).toBe(serverless + 2); // one fillRect per tile: two more lanes drawn
    } finally {
      setConvenienceLanesForTest(null);
    }
  });
});
