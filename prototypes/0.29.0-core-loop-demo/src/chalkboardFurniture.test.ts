/**
 * 🖍 The chalkboard as built: it hangs on the wall like the room boards
 * (never an obstacle, in front of the mount plane), files its handle, and
 * the handle tells the session what a ray hits: the chalk or the eraser on
 * the tray, the tray, the slate (and where on it), the frame. The face
 * repaints only where the marks changed. Plus what a press does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import * as Y from 'yjs';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import type { ChalkboardHandle } from './chalkboardBuild';

let puts: Array<[number, number, number, number]> = [];
function fakeCanvas() {
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const ctx: Record<PropertyKey, unknown> = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (key === 'putImageData') return (_img: unknown, _x: number, _y: number, dx: number, dy: number, dw: number, dh: number) => { puts.push([dx, dy, dw, dh]); };
      return () => undefined;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return canvas;
}

vi.stubGlobal('document', { createElement: fakeCanvas, getElementById: () => null });
vi.stubGlobal('window', { location: { search: '' }, addEventListener: () => undefined, innerWidth: 1280, innerHeight: 800 });
const { buildItemGroup, FURNITURE_DEFS, wallMountHalfWidth } = await import('./furniture');
const { CHALKBOARD_W, CHALKBOARD_Y, CHALK_FACE_H } = await import('./chalkboardBuild');
const { CHALK_GRID_H, CHALK_GRID_W, CHALK_MAX_X, CHALK_MAX_Y } = await import('./chalkRender');
const chalkDoc = await import('./chalkDoc');
const { pressAction } = await import('./chalkSession');

const ID = 'chalkboard-1';

function build(): { group: THREE.Group; handle: ChalkboardHandle; face: { width: number; height: number } } {
  const group = buildItemGroup({ id: ID, kind: 'chalkboard', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  group.updateMatrixWorld(true);
  const sinks = { chalkboards: new Map() } as unknown as FurnitureHandleSinks;
  let face: { width: number; height: number } | null = null;
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    registerFurnitureHandles(sinks, ID, obj);
    if (obj.userData.chalkboard) face = (obj.material as THREE.MeshBasicMaterial).map!.image as { width: number; height: number };
  });
  const handle = sinks.chalkboards.get(ID)!;
  expect(handle).toBeTruthy();
  return { group, handle, face: face! };
}

/** A ray from the focus camera's eye at a point of the board's local frame. */
function rayAt(x: number, y: number, z: number): THREE.Raycaster {
  const def = FURNITURE_DEFS.chalkboard.device!;
  const eye = new THREE.Vector3(def.eye.x, def.eye.y, def.eye.z);
  const ray = new THREE.Raycaster();
  ray.set(eye, new THREE.Vector3(x, y, z).sub(eye).normalize());
  return ray;
}

beforeEach(() => {
  chalkDoc.resetChalkForTest();
  chalkDoc.bindChalkDoc(new Y.Doc());
  puts = [];
});
afterEach(() => chalkDoc.resetChalkForTest());

describe('the chalkboard on the wall', () => {
  it('hangs like the room boards: no footprint, a wall mount as wide as the board, a focus device', () => {
    const def = FURNITURE_DEFS.chalkboard;
    expect(def.footprint).toBeNull();
    expect(wallMountHalfWidth('chalkboard')).toBeCloseTo(CHALKBOARD_W / 2);
    expect(def.device?.kind).toBe('chalkboard');
    const { group } = build();
    const all = new THREE.Box3().setFromObject(group);
    expect(all.min.z).toBeGreaterThanOrEqual(-1e-6); // nothing behind the wall's face, held tools included
    const shown = new THREE.Box3();
    group.traverseVisible((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (o instanceof THREE.Mesh && mat?.visible !== false) shown.expandByObject(o);
    });
    expect(shown.max.z).toBeLessThan(0.11); // the tray is the deepest part
    expect(shown.max.x - shown.min.x).toBeLessThanOrEqual(CHALKBOARD_W + 1e-6);
  });

  it('keeps the tools out of view when World turns every furniture mesh back on', () => {
    const { group, handle } = build();
    const shown = (): { box: THREE.Box3; meshes: number } => {
      const box = new THREE.Box3();
      let meshes = 0;
      group.traverseVisible((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (!(o instanceof THREE.Mesh) || mat?.visible === false) return;
        box.expandByObject(o);
        meshes++;
      });
      return { box, meshes };
    };
    const restore = (): void => group.traverse((o) => { if (o instanceof THREE.Mesh) o.visible = true; });
    const atRest = shown();
    // World's zoom-level restore sets visible on every furniture mesh.
    handle.setHeld('chalk');
    handle.setHeld(null);
    restore();
    expect(shown().box.equals(atRest.box)).toBe(true);
    expect(shown().meshes).toBe(atRest.meshes);
    // A tool in hand is off the tray (felt and back), whatever the restore does.
    handle.setHeld('eraser');
    restore();
    expect(shown().meshes).toBe(atRest.meshes - 2);
    handle.setHeld(null);
  });

  it('paints a face the size of the grid', () => {
    const { face } = build();
    expect(face.width).toBe(CHALK_GRID_W);
    expect(face.height).toBe(CHALK_GRID_H);
  });
});

describe('what a ray hits', () => {
  it('the chalk and the eraser on the tray, the tray between them, the slate and the frame', () => {
    const { handle } = build();
    const tray = CHALKBOARD_Y - CHALK_FACE_H / 2 - 0.05 - 0.004;
    expect(handle.pick(rayAt(0.45, tray + 0.011, 0.055))?.what).toBe('chalk');
    expect(handle.pick(rayAt(-0.45, tray + 0.015, 0.055))?.what).toBe('eraser');
    expect(handle.pick(rayAt(0, tray, 0.05))?.what).toBe('tray');
    expect(handle.pick(rayAt(0, CHALKBOARD_Y + CHALK_FACE_H / 2 + 0.025, 0.03))?.what).toBe('frame');
    const mid = handle.pick(rayAt(0, CHALKBOARD_Y, 0.022));
    expect(mid?.what).toBe('board');
    if (mid?.what === 'board') {
      expect(mid.point.x).toBeGreaterThan(CHALK_MAX_X / 2 - 3);
      expect(mid.point.x).toBeLessThan(CHALK_MAX_X / 2 + 3);
      expect(mid.point.y).toBeGreaterThan(CHALK_MAX_Y / 2 - 3);
      expect(mid.point.y).toBeLessThan(CHALK_MAX_Y / 2 + 3);
    }
    // Top left of the slate is (0, 0).
    const corner = handle.pick(rayAt(-0.84 + 0.002, CHALKBOARD_Y + CHALK_FACE_H / 2 - 0.002, 0.022));
    expect(corner?.what).toBe('board');
    if (corner?.what === 'board') {
      expect(corner.point.x).toBeLessThan(4);
      expect(corner.point.y).toBeLessThan(4);
    }
    expect(handle.pick(rayAt(3, 3, 0))).toBeNull();
  });

  it('a held tool is not on the tray: its place there is just tray', () => {
    const { handle } = build();
    const tray = CHALKBOARD_Y - CHALK_FACE_H / 2 - 0.05 - 0.004;
    handle.setHeld('chalk');
    expect(handle.pick(rayAt(0.45, tray + 0.011, 0.055))?.what).toBe('tray');
    expect(handle.pick(rayAt(-0.45, tray + 0.015, 0.055))?.what).toBe('eraser');
  });

  it('meets the slate’s plane off the slate too, and says so', () => {
    const { handle } = build();
    const off = handle.planePoint(rayAt(1.2, CHALKBOARD_Y, 0.022));
    expect(off?.inside).toBe(false);
    expect(handle.planePoint(rayAt(0.2, CHALKBOARD_Y - 0.2, 0.022))?.inside).toBe(true);
  });
});

describe('the face', () => {
  it('paints all of itself once, then only where marks land', () => {
    const { handle } = build();
    handle.update(0.016);
    expect(puts).toEqual([[0, 0, CHALK_GRID_W, CHALK_GRID_H]]);
    puts = [];
    handle.update(0.016);
    expect(puts).toEqual([]);
    const now = Date.now();
    chalkDoc.chalkPenDown(ID, 'chalk', { x: 400, y: 300 }, now);
    chalkDoc.chalkPenMove(ID, { x: 460, y: 310 }, now + 16);
    handle.update(0.016);
    expect(puts).toHaveLength(1);
    const [, , w, h] = puts[0];
    expect(w).toBeLessThan(60);
    expect(h).toBeLessThan(20);
  });
});

describe('a press', () => {
  it('takes a tool, swaps tools, puts one down, draws, hints, or steps back', () => {
    expect(pressAction(null, { what: 'chalk' })).toEqual({ act: 'take', tool: 'chalk' });
    expect(pressAction('eraser', { what: 'chalk' })).toEqual({ act: 'take', tool: 'chalk' });
    expect(pressAction('chalk', { what: 'tray' })).toEqual({ act: 'put-down' });
    expect(pressAction(null, { what: 'tray' })).toEqual({ act: 'wait' });
    expect(pressAction('chalk', { what: 'board', point: { x: 1, y: 1 } })).toEqual({ act: 'draw' });
    expect(pressAction('eraser', { what: 'frame' })).toEqual({ act: 'draw' });
    expect(pressAction(null, { what: 'board', point: { x: 1, y: 1 } })).toEqual({ act: 'hint' });
    expect(pressAction(null, null)).toEqual({ act: 'leave' });
    expect(pressAction('chalk', null)).toEqual({ act: 'leave' });
  });
});
