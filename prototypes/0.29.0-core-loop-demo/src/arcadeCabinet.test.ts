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
import type { ArcadeCabinetVisualHandle } from './devices';

let fills = 0;
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillRect') return () => { fills++; };
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(16) });
      return () => undefined;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const {
  buildItemGroup, arcadeWidePanels, ARCADE_BUTTON_TRAVEL, ARCADE_CABINET_KINDS, ARCADE_GEAR_Y, ARCADE_STICK_THROW,
  FURNITURE_DEFS,
} = await import('./furniture');
const { SEAT_COLOURS } = await import('./lanternRoadPaint');

const ID = 'arcade-cabinet-1';

function build(): THREE.Group {
  const group = buildItemGroup({ id: ID, kind: 'arcade-cabinet', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  group.updateMatrixWorld(true);
  return group;
}

function sinks(): FurnitureHandleSinks {
  return {
    wallScreens: new Map(), holoSpinners: [], mapHolograms: new Map(), trunkLids: new Map(), gameTableTops: new Map(),
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
  ({ mode, title, line: mode === 'inplay' ? 'P1 · Alice' : 'INSERT COIN', lane: mode === 'empty' ? '' : 'SOVEREIGN', blink, plays: 3, game: '' });

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

  it('shows one picture across both tubes, acting as one screen, and files each handle once', () => {
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
    // Two tubes on the one picture, each with its own half of it.
    const screens: THREE.Mesh[] = [];
    const panes: THREE.Mesh[] = [];
    const map = (left!.material as THREE.MeshBasicMaterial).map;
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshBasicMaterial;
      if (mat.map === map) screens.push(obj);
      else if (mat.transparent && (mat.userData.baseOpacity as number) < 1) panes.push(obj);
    });
    expect(screens).toHaveLength(2);
    expect(screens[0]!.material).not.toBe(screens[1]!.material);
    const boxes = screens.map((p) => new THREE.Box3().setFromObject(p)).sort((a, b) => a.min.x - b.min.x);
    expect(boxes[0]!.max.x).toBeLessThan(0);
    expect(boxes[1]!.min.x).toBeGreaterThan(0);
    // Butted together: only a hairline seam, behind one pane, no bezel between.
    expect(boxes[1]!.min.x - boxes[0]!.max.x).toBeLessThan(0.02);
    // The left tube holds the picture's left half, the right tube its right.
    const span = (tube: THREE.Mesh) => {
      const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '', fragmentShader: '' };
      (tube.material as THREE.Material).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      return shader.uniforms.uCrtSpan!.value as THREE.Vector2;
    };
    const [l, r] = [...screens].sort((a, b) => a.position.x - b.position.x);
    expect(span(l!)).toEqual(new THREE.Vector2(0, 0.5));
    expect(span(r!)).toEqual(new THREE.Vector2(0.5, 0.5));
    expect(panes).toHaveLength(1);
    const pane = new THREE.Box3().setFromObject(panes[0]!);
    expect(pane.min.x).toBeLessThan(boxes[0]!.min.x);
    expect(pane.max.x).toBeGreaterThan(boxes[1]!.max.x);
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

  it("has four stations, each at its own panel, in that player's ninja colour", () => {
    const parts = new Map<number, THREE.Mesh[]>();
    buildWide().traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.arcadeStation === undefined) return;
      const n = obj.userData.arcadeStation as number;
      parts.set(n, [...(parts.get(n) ?? []), obj]);
    });
    expect([...parts.keys()].sort()).toEqual([0, 1, 2, 3]);
    // #345: the panels a click on the screens is measured from.
    const panels = arcadeWidePanels({ pos: { x: 0, z: 0 }, rot: 0 });
    for (const [n, meshes] of parts) {
      // A stick (shaft and ball), two buttons, a coin door and its light.
      expect(meshes.length).toBe(6);
      for (const mesh of meshes) {
        const x = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()).x;
        const nearest = panels.reduce((best, p, i) =>
          Math.abs(p.x - x) < Math.abs(panels[best]!.x - x) ? i : best, 0);
        expect(nearest).toBe(n);
      }
      // The ball, the buttons and the coin light glow in the ninja's colour.
      const lit = meshes.map((mesh) => mesh.material as THREE.MeshStandardMaterial)
        .filter((mat) => mat.emissiveIntensity > 0 && mat.emissive.getHex() !== 0);
      expect(lit.length).toBe(4);
      for (const mat of lit) {
        expect('#' + mat.color.getHexString()).toBe(SEAT_COLOURS[n]!.main);
        expect('#' + mat.emissive.getHexString()).toBe(SEAT_COLOURS[n]!.main);
      }
    }
  });

  it('lights its flanks with bars that stand proud of the walls, not flush with them (#333)', () => {
    const meshes: THREE.Mesh[] = [];
    buildWide().traverse((obj) => { if (obj instanceof THREE.Mesh) meshes.push(obj); });
    const size = (mesh: THREE.Mesh) => new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    const bars = meshes.filter((mesh) => {
      const v = size(mesh);
      return Math.abs(v.x - 0.012) < 1e-6 && Math.abs(v.y - 0.9) < 1e-6;
    });
    expect(bars).toHaveLength(2);
    const rest = meshes.filter((mesh) => !bars.includes(mesh)).map((mesh) => new THREE.Box3().setFromObject(mesh));
    const wallR = Math.max(...rest.map((b) => b.max.x));
    const wallL = Math.min(...rest.map((b) => b.min.x));
    const [left, right] = bars.map((b) => new THREE.Box3().setFromObject(b)).sort((a, b) => a.min.x - b.min.x);
    expect(right!.max.x - wallR).toBeGreaterThan(0.005);
    expect(wallL - left!.min.x).toBeGreaterThan(0.005);
    // …still fixed to the wall, not floating off it.
    expect(right!.min.x).toBeLessThan(wallR);
    expect(left!.max.x).toBeGreaterThan(wallL);
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
      // In front of the tube's nearest point (its tilted-forward, bulged
      // bottom edge) by a few inches, along the way the cabinet faces.
      const tubeBox = new THREE.Box3().setFromObject(tubeMesh);
      const nearest = face === 1 ? tubeBox.max.z : tubeBox.min.z;
      for (const g of glass) {
        const glassZ = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()).z;
        expect((glassZ - nearest) * face).toBeGreaterThan(0.05);
        expect((glassZ - nearest) * face).toBeLessThan(0.12);
      }
    });
  }
});

/** The footprint's half depth: the stand point must be outside the cabinet. */
function d(def: { footprint: { d: number } | null }): number {
  return (def.footprint?.d ?? 0) / 2;
}

describe('the sticks and buttons, moving with the players (setControls)', () => {
  const UP = 0x10;
  const RIGHT = 0x80;
  const A = 0x01;
  const B = 0x02;
  const START = 0x08;
  const kinds = [['arcade-cabinet', 1], ['arcade-cabinet-2p', 2], ['arcade-cabinet-wide', 4]] as const;
  for (const [kind, players] of kinds) {
    it(`${kind}: each player's stick leans the way they press, and their buttons sink`, () => {
      const group = buildItemGroup({ id: kind, kind, pos: { x: 0, z: 0 }, rot: 0, movable: true });
      let visual: ArcadeCabinetVisualHandle | null = null;
      group.traverse((obj) => { if (obj.userData.arcadeCabinet) visual = obj.userData.arcadeCabinet as ArcadeCabinetVisualHandle; });
      const setControls = (visual as ArcadeCabinetVisualHandle | null)?.setControls;
      expect(setControls).toBeDefined();
      const def = FURNITURE_DEFS[kind];
      // The players' side: +z (1) or −z (−1). Away from them is −side along
      // z, their right is +side along x.
      const side = Math.sign(def.device!.front.z);
      const meshes: THREE.Mesh[] = [];
      group.traverse((obj) => { if (obj instanceof THREE.Mesh) meshes.push(obj); });
      const at = () => {
        group.updateMatrixWorld(true);
        return meshes.map((mesh) => mesh.getWorldPosition(new THREE.Vector3()));
      };
      const rest = at();
      const moved = (pads: number[]) => {
        setControls!(pads);
        const now = at();
        const out = meshes.flatMap((mesh, i) => (now[i]!.distanceTo(rest[i]!) > 1e-6 ? [{ mesh, from: rest[i]!, to: now[i]! }] : []));
        setControls!([]);
        return out;
      };
      // Whose controls a mesh at x is: the nearest panel's player (the
      // double-wide's stands are spread wider than its panels, #345), or
      // the nearest stand's.
      const controlsX = kind === 'arcade-cabinet-wide'
        ? arcadeWidePanels({ pos: { x: 0, z: 0 }, rot: 0 }).map((p) => p.x)
        : (def.stands ?? [{ stand: { x: 0, z: 0 } }]).map((st) => st.stand.x);
      const owner = (x: number) =>
        controlsX.reduce((best, sx, n) => (Math.abs(sx - x) < Math.abs(controlsX[best]! - x) ? n : best), 0);

      for (let p = 0; p < players; p++) {
        const pad = (bits: number) => Array.from({ length: players }, (_, n) => (n === p ? bits : 0));
        // UP: the stick (shaft and ball) leans away from the player.
        const up = moved(pad(UP));
        expect(up.length, `player ${p + 1} UP`).toBe(2);
        const ball = up.reduce((hi, m) => (m.from.y > hi.from.y ? m : hi));
        expect(owner(ball.from.x)).toBe(p);
        expect((ball.to.z - ball.from.z) * -side).toBeGreaterThan(0.02);
        expect(Math.abs(ball.to.x - ball.from.x)).toBeLessThan(1e-6);
        // RIGHT: to the player's right.
        const right = moved(pad(RIGHT)).reduce((hi, m) => (m.from.y > hi.from.y ? m : hi));
        expect((right.to.x - right.from.x) * side).toBeGreaterThan(0.02);
        expect(Math.abs(right.to.z - right.from.z)).toBeLessThan(1e-6);
        // Both at once: a diagonal, as far each way.
        const diag = moved(pad(UP | RIGHT)).reduce((hi, m) => (m.from.y > hi.from.y ? m : hi));
        expect((diag.to.z - diag.from.z) * -side).toBeGreaterThan(0.02);
        expect((diag.to.x - diag.from.x) * side).toBeGreaterThan(0.02);
        // B then A, left to right as the player sees them: each sinks alone.
        const sink = (bits: number) => {
          const m = moved(pad(bits));
          expect(m.length, `player ${p + 1} button ${bits}`).toBe(1);
          expect(m[0]!.to.y - m[0]!.from.y).toBeCloseTo(-ARCADE_BUTTON_TRAVEL, 6);
          expect(owner(m[0]!.from.x)).toBe(p);
          return m[0]!.from.x * side;
        };
        const b = sink(B);
        const a = sink(A);
        expect(b).toBeLessThan(a);
        // The stick is on their left, the buttons to its right, as on the
        // keyboard (WASD, then N and M).
        expect(ball.from.x * side).toBeLessThan(b);
        // The single cabinet's third button is START, right of A.
        if (kind === 'arcade-cabinet') expect(sink(START)).toBeGreaterThan(a);
      }
      // Every press at once, then rest: all back where they were.
      setControls!(Array.from({ length: players }, () => 0xff));
      setControls!([]);
      at().forEach((v, i) => expect(v.distanceTo(rest[i]!)).toBeLessThan(1e-9));
      expect(ARCADE_STICK_THROW).toBeGreaterThan(0.2);
    });
  }
});

describe("each game's sign (#333)", () => {
  it('dresses a bundled or own game in its own sign, and anything else in the plain one', async () => {
    const { ARCADE_SIGNS, DEFAULT_SIGN, signFor } = await import('./arcadeSigns');
    const { ARCADE_GAMES } = await import('./arcadeLibrary');
    const { NATIVE_GAMES } = await import('./arcadeNativeGames');
    for (const game of [...ARCADE_GAMES, ...NATIVE_GAMES]) {
      expect(ARCADE_SIGNS[game.id], game.id).toBeDefined();
      expect(signFor(game.id)).toBe(ARCADE_SIGNS[game.id]);
    }
    expect(signFor('')).toBe(DEFAULT_SIGN);
    expect(signFor('pacman.zip')).toBe(DEFAULT_SIGN);
  });

  it('paints every sign, with its logo or its name', async () => {
    const { ARCADE_SIGNS, DEFAULT_SIGN, paintSign } = await import('./arcadeSigns');
    const canvas = fakeCanvas();
    const g = canvas.getContext() as unknown as CanvasRenderingContext2D;
    for (const sign of [DEFAULT_SIGN, ...Object.values(ARCADE_SIGNS)]) {
      fills = 0;
      expect(() => paintSign(g, 512, 104, 'A GAME', sign, null)).not.toThrow();
      expect(() => paintSign(g, 1024, 86, 'A GAME', sign, {} as CanvasImageSource)).not.toThrow();
      expect(fills).toBeGreaterThan(0);
    }
  });

  it("repaints the marquee when the cabinet's game changes", () => {
    const group = build();
    const s = sinks();
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, ID, obj); });
    const handle = s.arcadeScreens.get(ID)!;
    const marquee = (() => {
      let found: THREE.CanvasTexture | null = null;
      group.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || obj.userData.arcadeScreen || obj.userData.arcadeControl) return;
        const map = (obj.material as THREE.MeshBasicMaterial).map;
        if (map instanceof THREE.CanvasTexture) found = map;
      });
      return found!;
    })();
    handle.draw({ ...view('attract', true, 'THWAITE'), game: 'thwaite' });
    const v = marquee.version;
    handle.draw({ ...view('attract', false, 'THWAITE'), game: 'thwaite' });
    expect(marquee.version).toBe(v); // a blink isn't a new sign
    handle.draw({ ...view('attract', false, 'NESERT GOLFING'), game: 'nesert-golfing' });
    expect(marquee.version).toBeGreaterThan(v);
  });

  it('a cabinet taken away stops waiting on its picture and logo', () => {
    // A page with pictures that arrive when the test says so.
    const pictures: { src: string; onload: (() => void) | null }[] = [];
    class SlowImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = '';
      private url = '';
      get src() { return this.url; }
      set src(url: string) { this.url = url; pictures.push(this); }
    }
    vi.stubGlobal('Image', SlowImage);
    try {
      const textures = (group: THREE.Group) => {
        const maps: THREE.Texture[] = [];
        group.traverse((obj) => {
          const map = obj instanceof THREE.Mesh ? (obj.material as THREE.MeshBasicMaterial).map : null;
          if (map instanceof THREE.CanvasTexture && !maps.includes(map)) maps.push(map);
        });
        return maps;
      };
      const cabinet = () => {
        const group = build();
        const s = sinks();
        group.traverse((obj) => { if (obj instanceof THREE.Mesh) registerFurnitureHandles(s, ID, obj); });
        s.arcadeScreens.get(ID)!.draw({ ...view('attract', true, 'THWAITE'), game: 'thwaite' });
        return textures(group);
      };
      const kept = cabinet();
      const gone = cabinet();
      for (const map of gone) map.dispose(); // as World.removeFurnitureVisuals does
      const before = (maps: THREE.Texture[]) => maps.map((m) => m.version);
      const [keptAt, goneAt] = [before(kept), before(gone)];

      const thwaite = pictures.find((p) => p.src.endsWith('/thwaite.png'))!;
      expect(thwaite).toBeDefined();
      thwaite.onload!();
      // The one still standing repaints its screen and its sign…
      expect(kept.filter((m, i) => m.version > keptAt[i]!).length).toBeGreaterThanOrEqual(2);
      // …the one taken away was no longer waiting.
      expect(before(gone)).toEqual(goneAt);
    } finally {
      vi.stubGlobal('Image', undefined);
    }
  });
});
