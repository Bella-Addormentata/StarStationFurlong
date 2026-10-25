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
/** Every setTransform call, by the canvas it was made on. */
const transforms = new Map<object, number[][]>();
function fakeCanvas() {
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const ctx: Record<PropertyKey, unknown> = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillRect') return () => { fills++; };
      if (key === 'setTransform') return (...m: number[]) => { transforms.set(canvas, [...(transforms.get(canvas) ?? []), m]); };
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      return () => undefined;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return canvas;
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
    propAnims: new Map(), airHockeyVisuals: new Map(), tvScreens: new Map(), arcadeScreens: new Map(), arcadeCabinetVisuals: new Map(), alligatorsVisuals: new Map(),
    casinoTableVisuals: new Map(), faucetDishes: new Map(),
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

  it('draws each screen on a whole-number multiple of the 384×216 layout, scaled back to layout units', () => {
    // 3 m wall set → 3×, 1.8 m stand set → 2×. Without the transform the
    // layout would land in the canvas's top-left corner only.
    for (const [kind, scale] of [['smart-tv', 3], ['tv-stand', 2]] as const) {
      const canvas = (screenPlane(build(kind))!.material as THREE.MeshBasicMaterial).map!.image as { width: number; height: number };
      expect([canvas.width, canvas.height]).toEqual([384 * scale, 216 * scale]);
      const calls = transforms.get(canvas) ?? [];
      expect(calls.length).toBeGreaterThan(0); // the first draw, as built
      for (const m of calls) expect(m).toEqual([scale, 0, 0, scale, 0, 0]);
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

  it('puts a handed-in video on the screen, fitted inside it, only while the set plays or pauses', () => {
    const group = build('tv-stand');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'tv-stand-1', obj); });
    const handle = s.tvScreens.get('tv-stand-1')!;
    const pictures = () => {
      const out: THREE.Mesh[] = [];
      group.traverse((obj) => { if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshBasicMaterial).map instanceof THREE.VideoTexture) out.push(obj); });
      return out;
    };
    expect(pictures()).toHaveLength(0);
    // A 4:3 video on a wide screen: pillarboxed, the full height.
    const video = { videoWidth: 640, videoHeight: 480, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as HTMLVideoElement;
    handle.draw(view('scheduled', 'METROPOLIS'));
    handle.showVideo(video);
    const [mesh] = pictures();
    expect(mesh).toBeDefined();
    // World sets every furniture mesh's own `visible` each frame: the gate
    // is on the frame around it, and must hold whatever the mesh says.
    mesh!.visible = true;
    const picture = { get visible() { let o: THREE.Object3D | null = mesh!; while (o) { if (!o.visible) return false; o = o.parent; } return true; }, scale: mesh!.scale };
    expect(picture.visible).toBe(false); // a countdown is the card
    handle.draw(view('playing', 'METROPOLIS'));
    expect(picture.visible).toBe(true);
    expect(picture.scale.y).toBeCloseTo(handle.planeH);
    expect(picture.scale.x).toBeCloseTo(handle.planeH * (4 / 3));
    expect(picture.scale.x).toBeLessThan(handle.planeW);
    handle.draw(view('paused', 'METROPOLIS'));
    expect(picture.visible).toBe(true);
    // The browser wants a tap: the stalled picture gives way to the card,
    // which says so, and is back once the tap is in.
    handle.draw({ ...view('playing', 'METROPOLIS'), ask: 'TAP TO PLAY · SEE YOUR SPACEPHONE (T)' });
    expect(picture.visible).toBe(false);
    handle.draw(view('playing', 'METROPOLIS'));
    expect(picture.visible).toBe(true);
    handle.draw(view('home'));
    expect(picture.visible).toBe(false);
    handle.draw(view('playing', 'METROPOLIS'));
    handle.showVideo(null);
    expect(picture.visible).toBe(false);
    expect(pictures()).toHaveLength(0); // the texture is let go
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
