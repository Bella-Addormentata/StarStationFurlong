/**
 * 🎬 The arrival (arrivalSequence.ts): the owner's storyboard as a timeline
 * (space, the approach to the planet, the atlas view, black, the clone vat),
 * the camera math of each shot, and the driver run against stand-ins for the
 * game's views: it enters each shot in order, hands the room view back
 * exactly where the rig keeps it, and skips cleanly from anywhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  APPROACH_END_TIMES,
  APPROACH_START_TIMES,
  ARRIVAL_SECONDS,
  ATLAS_START_ZOOM,
  ATLAS_ZOOM_SECONDS,
  ArrivalSequence,
  CUT_DIP_IN_SECONDS,
  CUT_DIP_OUT_SECONDS,
  FAR_EYE_KM,
  HINT_FROM_SECONDS,
  MAX_STEP_SECONDS,
  SHOTS,
  VAT_FADE_IN_SECONDS,
  VAT_LOOK_Y,
  VAT_START_ZOOM,
  approachEyeKm,
  atlasZoom,
  blackAt,
  ease,
  hintShownAt,
  shotAt,
  spaceLook,
  vatFrame,
  type ArrivalDeps,
} from './arrivalSequence';

/** Where each shot starts, seconds. */
const startOf = (name: string): number => {
  let t = 0;
  for (const s of SHOTS) {
    if (s.name === name) return t;
    t += s.seconds;
  }
  throw new Error(name);
};

describe('the timeline', () => {
  it('is the storyboard, in order: ten seconds of space, the approach, the atlas, black, the vat', () => {
    expect(SHOTS.map((s) => s.name)).toEqual(['space', 'approach', 'atlas', 'fade', 'black', 'vat']);
    expect(SHOTS[0].seconds).toBe(10);
    expect(ARRIVAL_SECONDS).toBeCloseTo(SHOTS.reduce((a, s) => a + s.seconds, 0), 9);
    expect(ARRIVAL_SECONDS).toBeLessThan(30);
  });

  it('names the shot and how far through it, and nothing once over', () => {
    expect(shotAt(0)).toEqual({ name: 'space', index: 0, at: 0, p: 0 });
    expect(shotAt(5)?.p).toBeCloseTo(0.5, 9);
    expect(shotAt(startOf('approach'))?.name).toBe('approach');
    expect(shotAt(startOf('approach') - 1e-6)?.name).toBe('space');
    expect(shotAt(startOf('vat') + 0.1)?.name).toBe('vat');
    expect(shotAt(ARRIVAL_SECONDS)).toBeNull();
    // A broken clock reads as the start.
    expect(shotAt(Number.NaN)?.name).toBe('space');
    expect(shotAt(-3)?.name).toBe('space');
  });

  it('eases from rest to rest, exactly 0 and 1 at the ends', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 9);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = ease(i / 100);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    // At rest at both ends: the first and last steps are tiny.
    expect(ease(0.01)).toBeLessThan(1e-4);
    expect(1 - ease(0.99)).toBeLessThan(1e-4);
  });
});

describe('the shots', () => {
  it('space turns onto the station view\'s direction and ends on it exactly', () => {
    const forward = new THREE.Vector3(-34, -38, -34);
    const start = spaceLook(0, forward);
    const end = spaceLook(1, forward);
    expect(end.toArray()).toEqual(forward.clone().normalize().toArray());
    expect(start.length()).toBeCloseTo(1, 9);
    expect(start.angleTo(end)).toBeGreaterThan(0.3);
    // Closer at every step.
    let last = Infinity;
    for (let i = 0; i <= 20; i++) {
      const a = spaceLook(i / 20, forward).angleTo(end);
      expect(a).toBeLessThanOrEqual(last + 1e-12);
      last = a;
    }
  });

  it('the approach closes in from a dot to the planet filling the view', () => {
    expect(approachEyeKm(0)).toBeCloseTo(FAR_EYE_KM * APPROACH_START_TIMES, 6);
    expect(approachEyeKm(1)).toBeCloseTo(FAR_EYE_KM * APPROACH_END_TIMES, 6);
    expect(APPROACH_END_TIMES).toBeGreaterThan(1);
    let last = Infinity;
    for (let i = 0; i <= 50; i++) {
      const d = approachEyeKm(i / 50);
      expect(d).toBeLessThanOrEqual(last);
      last = d;
    }
  });

  it('the atlas zooms in from far out over its first seconds, then holds', () => {
    expect(atlasZoom(0)).toBe(ATLAS_START_ZOOM);
    expect(atlasZoom(ATLAS_ZOOM_SECONDS)).toBe(1);
    expect(atlasZoom(SHOTS[2].seconds)).toBe(1);
    expect(atlasZoom(ATLAS_ZOOM_SECONDS / 2)).toBeCloseTo((ATLAS_START_ZOOM + 1) / 2, 9);
  });

  it('the vat shot starts close on the vat and ends on the room view exactly', () => {
    const vat = { x: -5, z: -5 };
    const start = vatFrame(0, vat);
    expect(start.look.toArray()).toEqual([-5, VAT_LOOK_Y, -5]);
    expect(start.zoom).toBe(VAT_START_ZOOM);
    const end = vatFrame(1, vat);
    expect(end.look.toArray()).toEqual([0, 0, 0]);
    expect(end.zoom).toBe(1);
    // A room with no vat: the close view is on the room's centre.
    expect(vatFrame(0, null).look.toArray()).toEqual([0, VAT_LOOK_Y, 0]);
  });

  it('black: a quick dip at the cut to the atlas, the fade, the black, and back over the vat\'s first second', () => {
    const cut = startOf('atlas');
    expect(blackAt(1)).toBe(0);
    expect(blackAt(cut - CUT_DIP_OUT_SECONDS - 0.01)).toBe(0);
    expect(blackAt(cut - 1e-6)).toBeGreaterThan(0.99);
    expect(blackAt(cut)).toBe(1);
    expect(blackAt(cut + CUT_DIP_IN_SECONDS)).toBe(0);
    expect(blackAt(cut + 1)).toBe(0);
    const fade = startOf('fade');
    expect(blackAt(fade)).toBe(0);
    expect(blackAt(fade + SHOTS[3].seconds / 2)).toBeCloseTo(0.5, 9);
    expect(blackAt(startOf('black'))).toBe(1);
    const vat = startOf('vat');
    expect(blackAt(vat)).toBe(1);
    expect(blackAt(vat + VAT_FADE_IN_SECONDS)).toBe(0);
    expect(blackAt(ARRIVAL_SECONDS)).toBe(0);
  });

  it('the skip line shows once the title has gone, until the vat', () => {
    expect(hintShownAt(0)).toBe(false);
    expect(hintShownAt(HINT_FROM_SECONDS)).toBe(true);
    expect(hintShownAt(startOf('atlas') + 1)).toBe(true);
    expect(hintShownAt(startOf('vat'))).toBe(false);
    expect(hintShownAt(ARRIVAL_SECONDS + 1)).toBe(false);
  });
});

// ── The driver, against stand-ins ─────────────────────────────────────────

const L2 = new THREE.Vector3(22, 26, 22);
const L3 = new THREE.Vector3(34, 38, 34);

function stage(opts: { failStepOut?: boolean; noVat?: boolean } = {}) {
  const ortho = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 1000);
  ortho.zoom = 0.42; // the station view's own zoom, as exteriorView sets it
  ortho.position.copy(L3);
  ortho.lookAt(0, 0, 0);
  const view = { level: 3, planet: false, camera: ortho as THREE.Camera, skyOnly: false, eye: null as number | null };
  const black: number[] = [];
  const hints: boolean[] = [];
  const screen = { setBlack: vi.fn((o: number) => { black.push(o); }), setHint: vi.fn((v: boolean) => { hints.push(v); }), remove: vi.fn() };
  const onDone = vi.fn();
  const deps: ArrivalDeps = {
    camera: () => view.camera,
    setCamera: (c) => { view.camera = c; },
    viewSize: () => ({ width: 1280, height: 800 }),
    zoom: {
      getLevel: () => view.level,
      stepIn: () => {
        if (view.level === 3 && view.planet) { view.planet = false; return; }
        if (view.level === 3) {
          view.level = 2;
          // exteriorView puts the room view's zoom back on the way in.
          ortho.zoom = 1;
          ortho.position.copy(L2);
          ortho.lookAt(0, 0, 0);
          view.camera = ortho;
        }
      },
      stepOut: () => {
        if (opts.failStepOut) throw new Error('no planet view');
        if (view.level === 3 && !view.planet) view.planet = true;
      },
    },
    isPlanetView: () => view.planet,
    farPass: { setSkyOnly: (on) => { view.skyOnly = on; }, setEyeDistance: (km) => { view.eye = km; } },
    isoOffset: (level, out) => out.copy(level === 2 ? L2 : L3),
    vatCentre: () => (opts.noVat ? null : { x: -5, z: -5 }),
    screen,
    onDone,
  };
  const seq = new ArrivalSequence(deps);
  const runTo = (t: number) => {
    while (seq.isPlaying() && seq.elapsed() < t - 1e-9) seq.update(Math.min(1 / 60, t - seq.elapsed()));
  };
  return { seq, view, ortho, screen, black, hints, onDone, runTo };
}

describe('the arrival, played out', () => {
  it('goes through every shot with the right camera and view', () => {
    const s = stage();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.runTo(1);
    expect(s.view.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(s.view.skyOnly).toBe(true);
    expect(s.view.level).toBe(3);
    expect(s.view.planet).toBe(false);

    s.runTo(startOf('approach') + 3);
    expect(s.view.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(s.view.skyOnly).toBe(false);
    expect(s.view.planet).toBe(true);
    expect(s.view.eye).toBeGreaterThan(FAR_EYE_KM * APPROACH_END_TIMES);
    expect(s.view.eye).toBeLessThan(FAR_EYE_KM * APPROACH_START_TIMES);
    // The perspective camera sits at the station, looking the station
    // view's way, at its own zoom.
    const p = s.view.camera as THREE.PerspectiveCamera;
    expect(p.position.toArray()).toEqual([0, 0, 0]);
    expect(p.zoom).toBe(1);
    expect(p.aspect).toBeCloseTo(1280 / 800, 9);
    expect(p.getWorldDirection(new THREE.Vector3()).angleTo(L3.clone().negate())).toBeLessThan(1e-6);

    s.runTo(startOf('atlas') + 0.5);
    expect(s.view.camera).toBe(s.ortho);
    expect(s.view.planet).toBe(false);
    expect(s.view.level).toBe(3);
    expect(s.view.eye).toBeNull();
    expect(s.ortho.zoom).toBeGreaterThan(0.42 * ATLAS_START_ZOOM);
    expect(s.ortho.zoom).toBeLessThan(0.42);
    s.runTo(startOf('fade') + 0.5);
    expect(s.ortho.zoom).toBeCloseTo(0.42, 9);

    s.runTo(startOf('black') + 0.1);
    expect(s.view.level).toBe(2);
    // Close on the vat.
    expect(s.ortho.zoom).toBeCloseTo(VAT_START_ZOOM, 9);
    expect(s.ortho.getWorldDirection(new THREE.Vector3()).angleTo(L2.clone().negate())).toBeLessThan(1e-6);
    const lookAtVat = new THREE.Vector3(-5, VAT_LOOK_Y, -5).add(L2);
    expect(s.ortho.position.distanceTo(lookAtVat)).toBeLessThan(1e-9);

    s.runTo(startOf('vat') + 2);
    expect(s.ortho.zoom).toBeLessThan(VAT_START_ZOOM);
    expect(s.ortho.zoom).toBeGreaterThan(1);
    expect(s.onDone).not.toHaveBeenCalled();

    s.runTo(ARRIVAL_SECONDS + 1);
    expect(s.seq.isPlaying()).toBe(false);
    expect(s.onDone).toHaveBeenCalledTimes(1);
    expect(s.screen.remove).toHaveBeenCalledTimes(1);
  });

  it('ends on the room view exactly where the rig keeps it: no jump at the hand-back', () => {
    const s = stage();
    s.runTo(ARRIVAL_SECONDS + 1);
    expect(s.view.camera).toBe(s.ortho);
    expect(s.ortho.position.toArray()).toEqual(L2.toArray());
    expect(s.ortho.zoom).toBe(1);
    expect(s.ortho.getWorldDirection(new THREE.Vector3()).angleTo(L2.clone().negate())).toBeLessThan(1e-9);
    expect(s.view.skyOnly).toBe(false);
    expect(s.view.eye).toBeNull();
  });

  it('draws the black and the skip line as the timeline says', () => {
    const s = stage();
    s.runTo(ARRIVAL_SECONDS + 1);
    expect(Math.max(...s.black)).toBe(1);
    expect(s.black[0]).toBe(0);
    expect(s.hints[0]).toBe(false);
    expect(s.hints).toContain(true);
    expect(s.hints[s.hints.length - 1]).toBe(false);
  });

  it('frames the room\'s centre when the room has no vat', () => {
    const s = stage({ noVat: true });
    s.runTo(startOf('black') + 0.1);
    expect(s.ortho.position.distanceTo(new THREE.Vector3(0, VAT_LOOK_Y, 0).add(L2))).toBeLessThan(1e-9);
  });

  it('a long frame counts as a short one, and a broken one as none: a hidden tab pauses it', () => {
    const s = stage();
    s.seq.update(30);
    expect(s.seq.elapsed()).toBeCloseTo(MAX_STEP_SECONDS, 9);
    s.seq.update(Number.NaN);
    s.seq.update(-5);
    expect(s.seq.elapsed()).toBeCloseTo(MAX_STEP_SECONDS, 9);
  });
});

describe('skipping', () => {
  for (const [where, at] of [['in space', 3], ['on the approach', startOf('approach') + 2], ['at the atlas', startOf('atlas') + 1], ['in the black', startOf('black') + 0.1], ['at the vat', startOf('vat') + 1]] as const) {
    it(`${where}: straight to the room view, once`, () => {
      const s = stage();
      s.runTo(at);
      s.seq.skip();
      expect(s.seq.isPlaying()).toBe(false);
      expect(s.view.level).toBe(2);
      expect(s.view.planet).toBe(false);
      expect(s.view.camera).toBe(s.ortho);
      expect(s.view.skyOnly).toBe(false);
      expect(s.view.eye).toBeNull();
      expect(s.ortho.position.toArray()).toEqual(L2.toArray());
      expect(s.ortho.zoom).toBe(1);
      expect(s.onDone).toHaveBeenCalledTimes(1);
      expect(s.screen.remove).toHaveBeenCalledTimes(1);
      // Nothing more happens after it.
      s.seq.skip();
      s.seq.update(1);
      expect(s.onDone).toHaveBeenCalledTimes(1);
    });
  }

  it('an error in a shot skips to the room rather than leaving the player stuck', () => {
    const s = stage({ failStepOut: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.runTo(startOf('approach') + 1);
    expect(s.seq.isPlaying()).toBe(false);
    expect(s.view.level).toBe(2);
    expect(s.view.camera).toBe(s.ortho);
    expect(s.onDone).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── The wiring ─────────────────────────────────────────────────────────────

const src = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('the wiring', () => {
  const main = src('./main.ts');

  it('plays only for a player who came through the fox chooser, and not when the browser asks for less motion', () => {
    const proceed = main.slice(main.indexOf('const proceed = () => {'), main.indexOf('/** Light ENTER, or keep it quiet'));
    expect(proceed).toMatch(/if \(chooser\) \{\s*arrivalChosen = true;/);
    const fade = main.slice(main.indexOf('const maybeFade = () => {'), main.indexOf('// 🆕 #79 P1: on a first run, replace'));
    expect(fade).toContain('const playArrival = arrivalChosen && !prefersReducedMotion();');
    expect(fade).toMatch(/if \(playArrival\) \{\s*startArrival\(\(\) => \{\s*document\.body\.classList\.remove\("pre-entry"\);\s*armPointer\(\);/);
    // Without it, the station is revealed from space as before.
    expect(fade).toContain('if (!playArrival) document.body.classList.remove("pre-entry");');
  });

  it('runs after the rig, which it holds off, and before the render, which draws the camera it set', () => {
    expect(main).toContain('isCameraBusy: () => isDeviceFocusActive() || (arrival?.isPlaying() ?? false),');
    const rig = main.indexOf('  updateCameraRig(deltaTime);');
    const tick = main.indexOf('  arrival?.update(deltaTime);');
    const render = main.indexOf('else renderWithFarPass(renderer, scene, drawCamera);');
    expect(rig).toBeGreaterThan(0);
    expect(tick).toBeGreaterThan(rig);
    expect(render).toBeGreaterThan(tick);
    expect(main).toContain('const drawCamera = arrivalThisFrame ? window.gameRenderer.camera : camera;');
  });

  it('hides the HUD while it plays', () => {
    const css = src('./index-inline.css');
    for (const id of ['exterior-enter-bubble', 'camera-rotate-hud', 'dev-menu-btn', 'spacephone-container']) {
      expect(css).toContain(`body.arrival-playing #${id}`);
    }
  });

  it('the far pass takes the arrival\'s eye distance in both places it places the far camera', () => {
    const far = src('./farOrbitView.ts');
    const update = far.slice(far.indexOf('function update(renderer'), far.indexOf('// ── Public'));
    expect(update).not.toContain('EYE_DISTANCE');
    expect(update.match(/eyeDistance\(\)/g)?.length).toBe(3);
  });
});
