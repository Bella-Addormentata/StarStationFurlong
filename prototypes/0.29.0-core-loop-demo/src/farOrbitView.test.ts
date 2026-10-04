/**
 * 🔭 The space view's three passes (farOrbitView.renderWithFarPass): the sky
 * alone, the far scene after a depth clear, then the station on top after
 * another, and every bit of borrowed state put back afterwards, even when a
 * pass throws. The renderer is a stand-in that records what each render saw;
 * the scenes are real.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// devices.ts (the far view reads isShipReady) hangs debug handles on window
// as it loads.
const fakeWindow = { location: { search: '' }, addEventListener: () => {}, removeEventListener: () => {} };
vi.stubGlobal('window', fakeWindow);
let SKY_LAYER: typeof import('./farOrbitView').SKY_LAYER;
let renderWithFarPass: typeof import('./farOrbitView').renderWithFarPass;
let setFarPassActive: typeof import('./farOrbitView').setFarPassActive;
beforeAll(async () => {
  ({ SKY_LAYER, renderWithFarPass, setFarPassActive } = await import('./farOrbitView'));
});

/** What one render call saw. */
interface Seen {
  scene: 'main' | 'far';
  mask: number;
  skyVisible: boolean[];
  planetVisible: boolean;
  background: THREE.Scene['background'];
  autoClear: boolean;
}

function setup() {
  const scene = new THREE.Scene();
  const background = new THREE.Color(0x102030);
  scene.background = background;
  // As World builds them: the nebula and stars hidden outside a deck, the old
  // planet backdrop shown.
  const sky = ['nebula-sky', 'nebula-stars'].map((name) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.visible = false;
    scene.add(o);
    return o;
  });
  const planet = new THREE.Object3D();
  planet.name = 'ambientPlanet';
  scene.add(planet);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  const cameraMask = camera.layers.mask;

  const log: Array<Seen | 'clearDepth'> = [];
  let failOn: ((n: number) => boolean) | null = null;
  let renders = 0;
  const renderer = {
    autoClear: true,
    render: vi.fn((s: THREE.Scene, _c: THREE.Camera) => {
      log.push({
        scene: s === scene ? 'main' : 'far',
        mask: camera.layers.mask,
        skyVisible: sky.map((o) => o.visible),
        planetVisible: planet.visible,
        background: scene.background,
        autoClear: renderer.autoClear,
      });
      if (failOn?.(++renders)) throw new Error('render failed');
    }),
    clearDepth: vi.fn(() => { log.push('clearDepth'); }),
    getSize: (v: THREE.Vector2) => v.set(800, 600),
  };
  return {
    scene, sky, planet, camera, cameraMask, background, renderer, log,
    failOnRender: (when: (n: number) => boolean) => { failOn = when; },
    render: () => renderWithFarPass(renderer as unknown as THREE.WebGLRenderer, scene, camera),
  };
}

beforeEach(() => {
  vi.stubGlobal('window', fakeWindow);
  // Labels draw on a canvas; Node has none, so they get one with no context.
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setFarPassActive(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('renderWithFarPass', () => {
  it('outside the space view: one plain render, nothing touched', () => {
    const t = setup();
    t.render();
    expect(t.log).toEqual([
      { scene: 'main', mask: t.cameraMask, skyVisible: [false, false], planetVisible: true, background: t.background, autoClear: true },
    ]);
    expect(t.renderer.clearDepth).not.toHaveBeenCalled();
  });

  it('draws the sky alone, then the far scene, then the station on top', () => {
    const t = setup();
    setFarPassActive(true);
    t.render();
    const skyOnly = new THREE.Layers();
    skyOnly.set(SKY_LAYER);
    expect(t.log).toEqual([
      // 1. The sky alone, shown for the pass, clearing with the background.
      { scene: 'main', mask: skyOnly.mask, skyVisible: [true, true], planetVisible: false, background: t.background, autoClear: true },
      // 2. The far scene, over the sky's colour but not its depth.
      'clearDepth',
      { scene: 'far', mask: t.cameraMask, skyVisible: [true, true], planetVisible: false, background: t.background, autoClear: false },
      // 3. The station, with no sky and no clearing background.
      'clearDepth',
      { scene: 'main', mask: t.cameraMask, skyVisible: [false, false], planetVisible: false, background: null, autoClear: false },
    ]);
  });

  it('puts everything back after the passes', () => {
    const t = setup();
    setFarPassActive(true);
    t.render();
    expect(t.sky.map((o) => o.visible)).toEqual([false, false]);
    expect(t.planet.visible).toBe(true);
    expect(t.scene.background).toBe(t.background);
    expect(t.camera.layers.mask).toBe(t.cameraMask);
    expect(t.renderer.autoClear).toBe(true);
    // The sky stays on its layer: that is how pass 1 finds it.
    for (const o of t.sky) expect(o.layers.isEnabled(SKY_LAYER)).toBe(true);
  });

  it('keeps a renderer that was not clearing on its own as it was', () => {
    const t = setup();
    t.renderer.autoClear = false;
    setFarPassActive(true);
    t.render();
    expect(t.renderer.autoClear).toBe(false);
  });

  for (const [pass, n] of [['sky', 1], ['far scene', 2], ['station', 3]] as const) {
    it(`puts everything back when the ${pass} pass throws`, () => {
      const t = setup();
      t.sky[0].visible = true; // a deck: its nebula shows
      setFarPassActive(true);
      t.failOnRender((i) => i === n);
      expect(() => t.render()).toThrow('render failed');
      expect(t.sky.map((o) => o.visible)).toEqual([true, false]);
      expect(t.planet.visible).toBe(true);
      expect(t.scene.background).toBe(t.background);
      expect(t.camera.layers.mask).toBe(t.cameraMask);
      expect(t.renderer.autoClear).toBe(true);
    });
  }

  it('renders plainly again once the space view closes', () => {
    const t = setup();
    setFarPassActive(true);
    t.render();
    setFarPassActive(false);
    t.log.length = 0;
    t.render();
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toMatchObject({ scene: 'main', mask: t.cameraMask, background: t.background });
  });
});
