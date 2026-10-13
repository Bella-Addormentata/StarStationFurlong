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
const { buildItemGroup, ARCADE_CABINET_KINDS, ARCADE_GEAR_Y, FURNITURE_DEFS } = await import('./furniture');

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
    propAnims: new Map(), airHockeyVisuals: new Map(), tvScreens: new Map(), arcadeScreens: new Map(), arcadeCabinetVisuals: new Map(),
    alligatorsVisuals: new Map(), casinoTableVisuals: new Map(), faucetDishes: new Map(),
  };
}

/** The screen: the canvas-textured plane that carries the screen handle
 *  (the ⚙️'s face is canvas-textured too). */
function screenPlane(group: THREE.Group): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData.arcadeScreen
      && (obj.material as THREE.MeshBasicMaterial).map instanceof THREE.CanvasTexture) found = obj;
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

  it('has a ⚙️ low on its front, by the floor, that names the cabinet it opens', () => {
    const group = build();
    const gears: THREE.Mesh[] = [];
    group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.userData.arcadeControl) gears.push(obj); });
    expect(gears.length).toBe(2); // the rim and the emoji's face
    const deck = new THREE.Box3().setFromObject(screenPlane(group)!);
    for (const gear of gears) {
      expect(gear.userData).toMatchObject({ arcadeControl: 'settings', arcadeCabinetId: ID });
      const box = new THREE.Box3().setFromObject(gear);
      expect(box.max.y).toBeLessThan(0.3); // below the coin door, far under the screen
      expect(box.max.y).toBeLessThan(deck.min.y);
      expect(box.getCenter(new THREE.Vector3()).y).toBeCloseTo(ARCADE_GEAR_Y, 5);
      expect(box.max.z).toBeGreaterThan(FURNITURE_DEFS['arcade-cabinet'].footprint!.d / 2 - 0.15); // on the front face
    }
    const face = gears.find((g) => (g.material as THREE.MeshBasicMaterial).map instanceof THREE.CanvasTexture);
    expect(face).toBeDefined();
    expect((face!.material as THREE.MeshBasicMaterial).userData.baseOpacity).toBe(1); // fades in with the rest
    // Not the screen: the handle is still the one on the screen plane.
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, ID, obj); });
    expect(s.arcadeScreens.size).toBe(1);
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

describe('the double-wide cabinet as built', () => {
  const WIDE = 'arcade-cabinet-wide-1';
  const buildWide = (): THREE.Group => {
    const group = buildItemGroup({ id: WIDE, kind: 'arcade-cabinet-wide', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    group.updateMatrixWorld(true);
    return group;
  };

  it('keeps every mesh inside its 2×1 footprint', () => {
    const { w, d: depth } = FURNITURE_DEFS['arcade-cabinet-wide'].footprint!;
    expect([w, depth]).toEqual([2, 1]);
    let meshes = 0;
    buildWide().traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      meshes++;
      const box = new THREE.Box3().setFromObject(obj);
      expect(box.min.x).toBeGreaterThanOrEqual(-w / 2 - 1e-9);
      expect(box.max.x).toBeLessThanOrEqual(w / 2 + 1e-9);
      expect(box.min.z).toBeGreaterThanOrEqual(-depth / 2 - 1e-9);
      expect(box.max.z).toBeLessThanOrEqual(depth / 2 + 1e-9);
      expect(box.min.y).toBeGreaterThanOrEqual(-1e-9);
    });
    expect(meshes).toBeGreaterThan(30); // four stations of stick, ball, two buttons and a coin slot
  });

  it('shows one picture on both screens, and files each handle once', () => {
    const group = buildWide();
    const s = sinks();
    let left: THREE.Mesh | null = null;
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      registerFurnitureHandles(s, WIDE, obj);
      if (obj.userData.arcadeCabinet) left = obj;
    });
    expect(s.arcadeScreens.size).toBe(1);
    expect(s.arcadeScreens.has(WIDE)).toBe(true);
    expect(s.arcadeCabinetVisuals.has(WIDE)).toBe(true); // the built-in emulator paints it too
    expect(left).not.toBeNull();
    expect(left!.userData.arcadeScreen).toBe(s.arcadeScreens.get(WIDE));
    // Two screens, one material: whatever the left one shows, so does the right.
    const screens: THREE.Mesh[] = [];
    group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.material === left!.material) screens.push(obj); });
    expect(screens).toHaveLength(2);
    const xs = screens.map((p) => new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3()).x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(0);
    expect(xs[1]).toBeGreaterThan(0);
    expect((left!.material as THREE.MeshBasicMaterial).map).toBeInstanceOf(THREE.CanvasTexture);
    const def = FURNITURE_DEFS['arcade-cabinet-wide'];
    expect(def.device?.kind).toBe('arcade');
    expect(def.device?.front.z).toBeGreaterThan(d(def));
  });

  it("has the single cabinet's ⚙️ low on its front, and a lit marquee across the top", () => {
    const group = buildWide();
    const gears: THREE.Mesh[] = [];
    group.traverse((obj) => { if (obj instanceof THREE.Mesh && obj.userData.arcadeControl) gears.push(obj); });
    expect(gears.length).toBe(2); // the rim and the emoji's face
    for (const gear of gears) {
      expect(gear.userData).toMatchObject({ arcadeControl: 'settings', arcadeCabinetId: WIDE });
      const box = new THREE.Box3().setFromObject(gear);
      expect(box.getCenter(new THREE.Vector3()).y).toBeCloseTo(ARCADE_GEAR_Y, 5);
      expect(box.max.z).toBeGreaterThan(FURNITURE_DEFS['arcade-cabinet-wide'].footprint!.d / 2 - 0.15); // on the front face
    }
    // Three textures, each a material map the removal reaches: the screens'
    // one, the marquee's and the ⚙️'s.
    const maps = new Map<THREE.Texture, THREE.Mesh>();
    let screen: THREE.Mesh | null = null;
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const map = (obj.material as THREE.MeshBasicMaterial).map;
      if (map) maps.set(map, obj);
      if (obj.userData.arcadeCabinet) screen = obj;
    });
    expect(maps.size).toBe(3);
    const gearMap = (gears.find((g) => (g.material as THREE.MeshBasicMaterial).map)!.material as THREE.MeshBasicMaterial).map!;
    const screenMap = (screen!.material as THREE.MeshBasicMaterial).map!;
    const marquee = [...maps].find(([map]) => map !== gearMap && map !== screenMap)![1];
    const box = new THREE.Box3().setFromObject(marquee);
    expect(box.min.y).toBeGreaterThan(new THREE.Box3().setFromObject(screen!).max.y); // above the screens
    expect(box.max.x - box.min.x).toBeGreaterThan(1.4); // across both of them
  });

  it('counts every size as an arcade cabinet', () => {
    expect([...ARCADE_CABINET_KINDS].sort()).toEqual(['arcade-cabinet', 'arcade-cabinet-2p', 'arcade-cabinet-wide']);
  });
});

describe('the monitor bay (#194)', () => {
  /** Every cabinet: the tube, the smoked glass in front of it, the bezel. */
  const kinds = [['arcade-cabinet', 1], ['arcade-cabinet-2p', -1], ['arcade-cabinet-wide', 1]] as const;
  for (const [kind, face] of kinds) {
    it(`${kind}: a curved tube a few inches behind smoked glass, in a dark bay`, () => {
      const group = buildItemGroup({ id: kind, kind, pos: { x: 0, z: 0 }, rot: 0, movable: true });
      group.updateMatrixWorld(true);
      let tube: THREE.Mesh | null = null;
      const glass: THREE.Mesh[] = [];
      group.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.userData.arcadeCabinet) tube = obj;
        const mat = obj.material as THREE.Material;
        if (mat.transparent && (mat.userData.baseOpacity as number | undefined) !== undefined
          && (mat.userData.baseOpacity as number) < 1) glass.push(obj);
      });
      expect(tube).not.toBeNull();
      const tubeMesh = tube as unknown as THREE.Mesh;
      // A curved face, not a flat plane.
      tubeMesh.geometry.computeBoundingBox();
      expect(tubeMesh.geometry.boundingBox!.max.z).toBeGreaterThan(0.005);
      // The glass: see-through but tinted, and never hiding what is behind it.
      expect(glass.length).toBeGreaterThan(0);
      const pane = glass[0]!.material as THREE.MeshBasicMaterial;
      expect(pane.userData.baseOpacity).toBeGreaterThan(0.1);
      expect(pane.userData.baseOpacity).toBeLessThan(0.6);
      expect(pane.depthWrite).toBe(false);
      // In front of the tube by a few inches, along the way the cabinet faces.
      const tubeZ = new THREE.Box3().setFromObject(tubeMesh).getCenter(new THREE.Vector3()).z;
      for (const g of glass) {
        const glassZ = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()).z;
        expect((glassZ - tubeZ) * face).toBeGreaterThan(0.05);
        expect((glassZ - tubeZ) * face).toBeLessThan(0.12);
      }
    });
  }
});

/** The footprint's half depth: the stand point must be outside the cabinet. */
function d(def: { footprint: { d: number } | null }): number {
  return (def.footprint?.d ?? 0) / 2;
}
