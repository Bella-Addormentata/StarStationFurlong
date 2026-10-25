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
import type { TvMenuCell, TvMenuView } from './tvMenu';

let fills = 0;
let drawnFrames = 0;
/** Every setTransform call, by the canvas it was made on. */
const transforms = new Map<object, number[][]>();
function fakeCanvas() {
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const ctx: Record<PropertyKey, unknown> = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillRect') return () => { fills++; };
      if (key === 'drawImage') return () => { drawnFrames++; };
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

/** The card: the canvas-textured plane that is not the paused menu's. */
function screenPlane(group: THREE.Group): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && !obj.userData.tvMenu && (obj.material as THREE.MeshBasicMaterial).map instanceof THREE.CanvasTexture) found = obj;
  });
  return found;
}

function menuPlane(group: THREE.Group): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.userData.tvMenu) found = obj; });
  return found;
}

/** Drawn: it and every ancestor visible (World sets each mesh's own). */
function shown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

const tile = (kind: string, col: number, row: number, live = true): TvMenuCell => ({ id: `tile:${kind}`, label: kind.toUpperCase(), col, row, live });

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
    // The picture shows the film itself (CLEAN) or drawn down through the
    // CRT pass (the default look): either way, a film is on it.
    const pictures = () => {
      const out: THREE.Mesh[] = [];
      group.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || !obj.userData.tvPicture) return;
        const m = obj.material as THREE.MeshBasicMaterial;
        if (m.map instanceof THREE.VideoTexture || (m.userData.crtLook && m.map)) out.push(obj);
      });
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

  it("shows the film through the CRT look, cut down to 360 rows, unless the set's LOOK is CLEAN", () => {
    const group = build('smart-tv');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'smart-tv-1', obj); });
    const handle = s.tvScreens.get('smart-tv-1')!;
    let mesh: THREE.Mesh | null = null;
    group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.userData.tvPicture) mesh = obj; });
    const material = () => mesh!.material as THREE.MeshBasicMaterial;
    expect(material().map).toBeNull(); // no film: nothing on the picture
    const film = (w: number, h: number) =>
      ({ videoWidth: w, videoHeight: h, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as HTMLVideoElement;
    handle.draw(view('playing', 'METROPOLIS'));
    handle.showVideo(film(1920, 1080));
    // The default: the CRT pass, on a canvas of the film's shape in 360 rows.
    expect(material().userData.crtLook).toBeDefined();
    const canvas = material().map!.image as { width: number; height: number };
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
    // CLEAN: the film itself, as before the look.
    handle.draw({ ...view('playing', 'METROPOLIS'), clean: true });
    expect(material().map).toBeInstanceOf(THREE.VideoTexture);
    expect(material().userData.crtLook).toBeUndefined();
    handle.draw(view('playing', 'METROPOLIS'));
    expect(material().userData.crtLook).toBeDefined();
    // A 4:3 film keeps square pixels; one of fewer rows than 360 keeps its own.
    handle.showVideo(film(640, 480));
    expect([(material().map!.image as { width: number }).width, (material().map!.image as { height: number }).height]).toEqual([480, 360]);
    handle.showVideo(film(320, 240));
    expect([(material().map!.image as { width: number }).width, (material().map!.image as { height: number }).height]).toEqual([320, 240]);
    // The film taken off: the plain picture, empty.
    handle.showVideo(null);
    expect(material().userData.crtLook).toBeUndefined();
    expect(material().map).toBeNull();
  });

  it('draws a film down once a new frame, as the browser says one came, and lets the look go with the set', () => {
    const group = build('smart-tv');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'smart-tv-1', obj); });
    const handle = s.tvScreens.get('smart-tv-1')!;
    let mesh: THREE.Mesh | null = null;
    group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.userData.tvPicture) mesh = obj; });
    const render = () => mesh!.onBeforeRender(null as never, null as never, null as never, null as never, null as never, null as never);
    let frame: (() => void) | null = null;
    const film = {
      videoWidth: 1920, videoHeight: 1080, readyState: 4, currentTime: 0,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      requestVideoFrameCallback: (cb: () => void) => { frame = cb; return 1; },
    } as unknown as HTMLVideoElement & { currentTime: number };
    handle.draw(view('playing', 'METROPOLIS'));
    handle.showVideo(film);
    drawnFrames = 0;
    render();
    expect(drawnFrames).toBe(1); // the first frame
    // Renders with no new frame draw nothing, though the clock moves on.
    film.currentTime = 0.01;
    render();
    film.currentTime = 0.02;
    render();
    expect(drawnFrames).toBe(1);
    frame!();
    render();
    render();
    expect(drawnFrames).toBe(2);
    // The set removed (World closes the theatre first, which takes the film
    // off, then runs every `dispose*` hook): the CRT material and canvas
    // go too, though they are off the mesh by then.
    const crt = mesh!.material as THREE.MeshBasicMaterial;
    const gone: string[] = [];
    crt.addEventListener('dispose', () => gone.push('material'));
    crt.map!.addEventListener('dispose', () => gone.push('canvas'));
    handle.showVideo(null);
    expect(mesh!.material).not.toBe(crt);
    group.traverse((obj) => {
      for (const [key, hook] of Object.entries(obj.userData)) if (key.startsWith('dispose') && typeof hook === 'function') hook();
    });
    expect(gone.sort()).toEqual(['canvas', 'material']);
  });

  it('draws the home menu it is handed: one box per tile, and none without a menu', () => {
    const group = build('smart-tv');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'smart-tv-1', obj); });
    const handle = s.tvScreens.get('smart-tv-1')!;
    const home = (cells: TvMenuCell[]): TvScreenView => ({ ...view('home'), menu: { kind: 'home', cells, at: cells[0]!.id } });
    handle.draw(view('off'));
    fills = 0;
    handle.draw(view('home'));
    const bare = fills;
    handle.draw(view('off'));
    fills = 0;
    handle.draw(home([tile('url', 0, 0), tile('file', 1, 0), tile('magnet', 2, 0)]));
    const three = fills;
    expect(three).toBe(bare + 3);
    handle.draw(view('off'));
    fills = 0;
    handle.draw(home([tile('youtube', 0, 0), tile('archive', 1, 0), tile('url', 2, 0), tile('file', 0, 1), tile('magnet', 1, 1)]));
    expect(fills).toBe(three + 2);
    // A move of the highlight is a new view: drawn again.
    fills = 0;
    handle.draw({ ...home([tile('url', 0, 0), tile('file', 1, 0)]), menu: { kind: 'home', cells: [tile('url', 0, 0), tile('file', 1, 0)], at: 'tile:file' } });
    expect(fills).toBeGreaterThan(0);
  });

  it('paused, the menu goes on a plane of its own in front of the picture, the still frame under it, and only then', () => {
    const group = build('tv-stand');
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, 'tv-stand-1', obj); });
    const handle = s.tvScreens.get('tv-stand-1')!;
    const plane = menuPlane(group)!;
    expect(plane).not.toBeNull();
    const canvas = (plane.material as THREE.MeshBasicMaterial).map!.image as { width: number; height: number };
    expect([canvas.width, canvas.height]).toEqual([1, 1]); // never paused: no canvas to speak of
    plane.visible = true; // World's interior pass: the gate is on the frame around it
    expect(shown(plane)).toBe(false);
    const video = { videoWidth: 640, videoHeight: 480, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as HTMLVideoElement;
    handle.showVideo(video);
    handle.draw(view('playing', 'METROPOLIS'));
    expect(shown(plane)).toBe(false);
    const paused: TvMenuView = { kind: 'paused', cells: [{ id: 'play', label: '▶ PLAY', col: 0, row: 0, live: true }], at: 'play' };
    const transformsBefore = (transforms.get(canvas) ?? []).length;
    handle.draw({ ...view('paused', 'METROPOLIS'), menu: paused });
    expect(shown(plane)).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([384 * 2, 216 * 2]); // the card's own size
    expect((transforms.get(canvas) ?? []).length).toBeGreaterThan(transformsBefore);
    // The picture stays up under it (through the CRT look, the default).
    let picture: THREE.Mesh | null = null;
    group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.userData.tvPicture) picture = obj; });
    expect((picture!.material as THREE.MeshBasicMaterial).userData.crtLook).toBeDefined();
    picture!.visible = true;
    expect(shown(picture)).toBe(true);
    // In front of it.
    expect(plane.parent!.position.z).toBeGreaterThan(picture!.parent!.position.z);
    // A pause with no menu handed in (a set drawn before the room's tick) has none on the plane.
    handle.draw(view('paused', 'METROPOLIS'));
    expect(shown(plane)).toBe(false);
    handle.draw({ ...view('paused', 'METROPOLIS'), menu: paused });
    handle.draw(view('playing', 'METROPOLIS'));
    expect(shown(plane)).toBe(false);
  });
});
