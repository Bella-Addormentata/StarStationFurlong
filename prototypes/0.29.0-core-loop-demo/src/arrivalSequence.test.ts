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
  APPROACH_SETTLE_SECONDS,
  APPROACH_START_TIMES,
  ARRIVAL_SECONDS,
  ATLAS_CLOSE,
  ATLAS_START_ZOOM,
  ATLAS_ZOOM_SECONDS,
  ArrivalSequence,
  CUT_DIP_IN_SECONDS,
  CUT_DIP_OUT_SECONDS,
  FAR_EYE_KM,
  HINT_FROM_SECONDS,
  MAX_STEP_SECONDS,
  PAIRED_CLICK_MS,
  SHOTS,
  SPACE_DRIFT_EASE_SECONDS,
  SPACE_DRIFT_RATE,
  SPACE_HOLD_MAX_SECONDS,
  VAT_FADE_IN_SECONDS,
  VAT_LOOK_Y,
  VAT_START_ZOOM,
  approachEyeKm,
  atlasZoom,
  blackAt,
  ease,
  hintShownAt,
  holdDrift,
  shotAt,
  spaceLook,
  swallowPairedClick,
  vatFrame,
  waitingLine,
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

  it('the atlas starts on the whole station and closes in on the module at its centre, then holds', () => {
    // The welcome station: the view pulls back to frame it all (0.074), far
    // wider than one module (0.42).
    expect(atlasZoom(0, 0.074, 0.42)).toBeCloseTo(0.074, 12);
    expect(atlasZoom(ATLAS_ZOOM_SECONDS, 0.074, 0.42)).toBeCloseTo(0.42 * ATLAS_CLOSE, 12);
    expect(atlasZoom(SHOTS[2].seconds, 0.074, 0.42)).toBeCloseTo(0.42 * ATLAS_CLOSE, 12);
    // Geometric: halfway in time is halfway in ratio.
    expect(atlasZoom(ATLAS_ZOOM_SECONDS / 2, 0.074, 0.42)).toBeCloseTo(Math.sqrt(0.074 * 0.42 * ATLAS_CLOSE), 12);
    let last = 0;
    for (let i = 0; i <= 40; i++) {
      const z = atlasZoom((i / 40) * ATLAS_ZOOM_SECONDS, 0.074, 0.42);
      expect(z).toBeGreaterThanOrEqual(last);
      last = z;
    }
    // One module alone: still starts out from it and closes in.
    expect(atlasZoom(0, 0.42, 0.42)).toBeCloseTo(0.42 * ATLAS_START_ZOOM, 12);
    expect(atlasZoom(ATLAS_ZOOM_SECONDS, 0.42, 0.42)).toBeCloseTo(0.42 * ATLAS_CLOSE, 12);
    // No module framing known: the station view's own stands in for it.
    expect(atlasZoom(ATLAS_ZOOM_SECONDS, 0.3, null)).toBeCloseTo(0.3 * ATLAS_CLOSE, 12);
    expect(atlasZoom(1, 0.3, Number.NaN)).toBe(atlasZoom(1, 0.3, null));
    // A camera without a sane zoom is left as it is.
    expect(atlasZoom(1, 0, 0.42)).toBe(0);
  });

  it('the held sky drifts from rest, then steadily', () => {
    expect(holdDrift(0)).toBe(0);
    expect(holdDrift(-1)).toBe(0);
    expect(holdDrift(Number.NaN)).toBe(0);
    expect(holdDrift(0.05) / 0.05).toBeLessThan(SPACE_DRIFT_RATE / 100);
    const later = SPACE_DRIFT_EASE_SECONDS + 5;
    expect(holdDrift(later + 1) - holdDrift(later)).toBeCloseTo(SPACE_DRIFT_RATE, 12);
    expect(holdDrift(SPACE_HOLD_MAX_SECONDS)).toBeLessThan(0.5);
  });

  it('the waiting line names the room', () => {
    expect(waitingLine('SSF-WELCOME')).toBe('Finding SSF-WELCOME\u2026');
    expect(waitingLine('')).toBe('Finding the room\u2026');
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

function stage(opts: { failStepOut?: boolean; noVat?: boolean; roomHere?: boolean; moduleZoom?: number | null; stationZoom?: number | null } = {}) {
  const ortho = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 1000);
  ortho.zoom = 0.42; // the station view's own zoom, as exteriorView sets it
  ortho.position.copy(L3);
  ortho.lookAt(0, 0, 0);
  const view = { level: 3, planet: false, camera: ortho as THREE.Camera, skyOnly: false, eye: null as number | null };
  const black: number[] = [];
  const hints: boolean[] = [];
  const room = { here: opts.roomHere ?? true };
  const waiting = { on: false, times: 0 };
  const screen = {
    setBlack: vi.fn((o: number) => { black.push(o); }),
    setHint: vi.fn((v: boolean) => { hints.push(v); }),
    setWaiting: vi.fn((on: boolean) => { if (on && !waiting.on) waiting.times++; waiting.on = on; }),
    remove: vi.fn(),
  };
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
    roomHere: () => room.here,
    moduleZoom: () => (opts.moduleZoom === undefined ? 0.42 : opts.moduleZoom),
    // By default none: the ortho camera's own zoom stands in.
    stationZoom: () => (opts.stationZoom === undefined ? null : opts.stationZoom),
    screen,
    onDone,
  };
  const seq = new ArrivalSequence(deps);
  const runTo = (t: number) => {
    while (seq.isPlaying() && seq.elapsed() < t - 1e-9) seq.update(Math.min(1 / 60, t - seq.elapsed()));
  };
  /** Frames for `seconds` of wall time, whatever the timeline does. */
  const runFor = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) seq.update(1 / 60);
  };
  return { seq, view, ortho, screen, black, hints, onDone, runTo, runFor, room, waiting };
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
    expect(s.ortho.zoom).toBeLessThan(0.42 * ATLAS_CLOSE);
    // Looking at the module at the centre.
    expect(s.ortho.getWorldDirection(new THREE.Vector3()).angleTo(L3.clone().negate())).toBeLessThan(1e-6);
    s.runTo(startOf('fade') + 0.5);
    expect(s.ortho.zoom).toBeCloseTo(0.42 * ATLAS_CLOSE, 9);

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

  it('a whole station: the atlas starts on all of it and closes in on the module at the centre', () => {
    // The station view frames the whole known station, further out than one
    // module. The station grew while the arrival's own camera was up, so the
    // ortho camera still holds the old framing (0.42): the current one wins.
    const s = stage({ moduleZoom: 0.42, stationZoom: 0.074 });
    s.runTo(startOf('atlas') - 1);
    expect(s.ortho.zoom).toBe(0.42);
    s.runTo(startOf('atlas') + 0.05);
    expect(s.ortho.zoom).toBeLessThan(0.08);
    s.runTo(startOf('fade') + 0.5);
    expect(s.ortho.zoom).toBeCloseTo(0.42 * ATLAS_CLOSE, 9);
    // Under the black, the station view's own zoom goes back before the step in.
    s.runTo(startOf('black') + 0.1);
    expect(s.view.level).toBe(2);
    expect(s.ortho.zoom).toBeCloseTo(VAT_START_ZOOM, 9);
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

describe('waiting in space for the room', () => {
  it('holds the sky at the end of its shot until the room is here, saying so, then goes on', () => {
    const s = stage({ roomHere: false });
    s.runTo(SHOTS[0].seconds - 0.5);
    expect(s.waiting.on).toBe(false);
    s.runFor(5);
    expect(s.seq.elapsed()).toBe(SHOTS[0].seconds);
    expect(s.seq.heldSeconds()).toBeGreaterThan(4.4);
    expect(s.waiting.on).toBe(true);
    expect(s.view.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(s.view.skyOnly).toBe(true);
    expect(s.view.planet).toBe(false);
    expect(s.hints[s.hints.length - 1]).toBe(true);
    // Drifting: off the station's direction by the drift so far.
    const dir = () => (s.view.camera as THREE.PerspectiveCamera).getWorldDirection(new THREE.Vector3());
    const forward = L3.clone().negate().normalize();
    expect(dir().angleTo(forward)).toBeGreaterThan(0.01);

    s.room.here = true;
    const held = s.seq.heldSeconds();
    s.seq.update(1 / 60);
    expect(s.waiting.on).toBe(false);
    expect(s.waiting.times).toBe(1);
    expect(s.seq.heldSeconds()).toBe(held);
    s.runTo(startOf('approach') + 0.1);
    expect(s.view.planet).toBe(true);
    expect(s.view.skyOnly).toBe(false);
    // The approach turns back onto the station's direction, smoothly.
    expect(dir().angleTo(forward)).toBeGreaterThan(0.005);
    s.runTo(startOf('approach') + APPROACH_SETTLE_SECONDS + 0.1);
    expect(dir().angleTo(forward)).toBeLessThan(1e-6);
    s.runTo(ARRIVAL_SECONDS + 1);
    expect(s.seq.isPlaying()).toBe(false);
    expect(s.ortho.position.toArray()).toEqual(L2.toArray());
    expect(s.ortho.zoom).toBe(1);
  });

  it('never holds when the room is already here', () => {
    const s = stage();
    s.runTo(startOf('approach') + 0.1);
    expect(s.seq.heldSeconds()).toBe(0);
    expect(s.waiting.times).toBe(0);
    expect(s.view.planet).toBe(true);
  });

  it('goes on without the room once the hold runs out', () => {
    const s = stage({ roomHere: false });
    s.runTo(SHOTS[0].seconds - 0.5);
    s.runFor(SPACE_HOLD_MAX_SECONDS + 2);
    expect(s.seq.heldSeconds()).toBeGreaterThanOrEqual(SPACE_HOLD_MAX_SECONDS);
    expect(s.seq.heldSeconds()).toBeLessThan(SPACE_HOLD_MAX_SECONDS + 0.1);
    expect(s.waiting.on).toBe(false);
    expect(s.seq.elapsed()).toBeGreaterThan(SHOTS[0].seconds);
    expect(s.view.planet).toBe(true);
    s.runTo(ARRIVAL_SECONDS + 1);
    expect(s.onDone).toHaveBeenCalledTimes(1);
    expect(s.view.level).toBe(2);
  });

  it('a skip while it holds goes straight to the room view', () => {
    const s = stage({ roomHere: false });
    s.runTo(SHOTS[0].seconds - 0.5);
    s.runFor(3);
    s.seq.skip();
    expect(s.seq.isPlaying()).toBe(false);
    expect(s.view.level).toBe(2);
    expect(s.view.camera).toBe(s.ortho);
    expect(s.view.skyOnly).toBe(false);
    expect(s.ortho.position.toArray()).toEqual(L2.toArray());
    expect(s.ortho.zoom).toBe(1);
    expect(s.onDone).toHaveBeenCalledTimes(1);
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

describe('the click a skipping press makes', () => {
  // In the page the swallow sits on the window in the capture phase, ahead of
  // the world's handlers. Here the target is a plain EventTarget, where
  // listeners run in the order they were added, so the world's listener is
  // added after the swallow, as the skip arms it.
  const stage = () => {
    const target = new EventTarget();
    let timer: (() => void) | null = null;
    const cleared: unknown[] = [];
    const end = swallowPairedClick(
      target,
      PAIRED_CLICK_MS,
      (fn) => {
        timer = fn;
        return 'timer';
      },
      (h) => cleared.push(h),
    );
    const world = vi.fn();
    target.addEventListener('click', world);
    const click = () => {
      const e = new Event('click', { cancelable: true });
      target.dispatchEvent(e);
      return e;
    };
    return { target, end, world, click, fireTimer: () => timer?.(), cleared };
  };

  it('never reaches the world, and the next click does', () => {
    const { world, click, cleared } = stage();
    expect(click().defaultPrevented).toBe(true);
    expect(world).not.toHaveBeenCalled();
    expect(click().defaultPrevented).toBe(false);
    expect(world).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual(['timer']);
  });

  it('ends at a fresh press, so that press\'s click goes through', () => {
    const { target, world, click } = stage();
    target.dispatchEvent(new Event('pointerdown'));
    click();
    expect(world).toHaveBeenCalledTimes(1);
  });

  it('ends when no click comes in time', () => {
    const { world, click, fireTimer } = stage();
    fireTimer();
    click();
    expect(world).toHaveBeenCalledTimes(1);
  });

  it('ends once however it ends', () => {
    const { end, fireTimer, click, world, cleared } = stage();
    end();
    end();
    fireTimer();
    click();
    expect(world).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual(['timer']);
  });
});

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

  it('waits for the welcome room as the title does, and closes in on the station view\'s own module framing', () => {
    const fn = main.slice(main.indexOf('function arrivalRoomHere(): boolean {'), main.indexOf('function startArrival('));
    expect(fn).toContain('if (!welcomeSeeking()) return true;');
    expect(fn).toContain('return room !== null && room !== DEFAULT_STATION.welcomeRoomId;');
    expect(main).toContain('    roomHere: arrivalRoomHere,');
    expect(main).toContain('    moduleZoom: exteriorModuleZoom,');
    expect(main).toContain('    stationZoom: exteriorStationZoom,');
    expect(main).toContain('screen: domArrivalScreen(() => arrival?.skip(), DEFAULT_STATION.name),');
    const ext = src('./exteriorView.ts');
    expect(ext).toContain('return savedZoom !== null ? savedZoom * MODULE_ZOOM_FACTOR : null;');
    expect(ext).toContain('return savedZoom !== null ? savedZoom * exteriorZoomFactor() : null;');
    expect(ext).toContain('return Math.min(MODULE_ZOOM_FACTOR, MODULE_ZOOM_FACTOR * (16 / Math.max(16, needed)));');
  });

  it('a skipping press swallows its own click, and the skip line is spoken', () => {
    const own = src('./arrivalSequence.ts');
    const screen = own.slice(own.indexOf('export function domArrivalScreen('));
    expect(screen).toMatch(/swallowPairedClick\(window\);\s*onSkip\(\);/);
    expect(screen).toContain("hint.setAttribute('role', 'status');");
    expect(screen).toContain("black.setAttribute('aria-hidden', 'true');");
    expect(screen).not.toContain("root.setAttribute('aria-hidden'");
  });

  it('the far pass takes the arrival\'s eye distance in both places it places the far camera', () => {
    const far = src('./farOrbitView.ts');
    const update = far.slice(far.indexOf('function update(renderer'), far.indexOf('// ── Public'));
    expect(update).not.toContain('EYE_DISTANCE');
    expect(update.match(/eyeDistance\(\)/g)?.length).toBe(3);
  });
});
