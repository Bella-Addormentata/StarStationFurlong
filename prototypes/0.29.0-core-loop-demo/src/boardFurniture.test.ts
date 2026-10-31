/**
 * 📌 The room boards as built (#315): both hang on the wall like the smart
 * TV (in front of the mount plane, inside the registry's clearance width,
 * never an obstacle), file a board screen handle of their own kind, and
 * repaint only when the notes they show change. Plus the face painter's
 * pure parts (word wrap, tilt) and the panel's age stamps.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import type { BoardScreen } from './boardDoc';
import type { WallScreenHandle } from './devices';

let fills = 0;
function fakeCanvas() {
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const ctx: Record<PropertyKey, unknown> = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillRect') return () => { fills++; };
      if (key === 'measureText') return (s: string) => ({ width: s.length * 5 });
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
const { wrapNoteText, noteTilt, BOARD_FACE_W, BOARD_FACE_H, BOARD_FACE_SCALE } = await import('./boardFace');
const { noteAge } = await import('./boardUI');

type BoardFurniture = 'corkboard' | 'notice-case';

function build(kind: BoardFurniture): THREE.Group {
  const group = buildItemGroup({ id: `${kind}-1`, kind, pos: { x: 0, z: 0 }, rot: 0, movable: true });
  group.updateMatrixWorld(true);
  return group;
}

function sinks(): FurnitureHandleSinks {
  return {
    wallScreens: new Map(), holoSpinners: [], mapHolograms: new Map(), trunkLids: new Map(), gameTableTops: new Map(),
    cloneVats: new Map(), slotMachineVisuals: new Map(), coinPusherVisuals: new Map(),
    propAnims: new Map(), airHockeyVisuals: new Map(), tvScreens: new Map(), arcadeScreens: new Map(), arcadeCabinetVisuals: new Map(), alligatorsVisuals: new Map(),
    casinoTableVisuals: new Map(), faucetDishes: new Map(),
  } as unknown as FurnitureHandleSinks;
}

function handleOf(kind: BoardFurniture): { handle: WallScreenHandle; canvas: { width: number; height: number } } {
  const group = build(kind);
  const s = sinks();
  let canvas: { width: number; height: number } | null = null;
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    registerFurnitureHandles(s, `${kind}-1`, obj);
    if (obj.userData.wallScreen) canvas = (obj.material as THREE.MeshBasicMaterial).map!.image as { width: number; height: number };
  });
  const handle = s.wallScreens.get(`${kind}-1`);
  expect(handle).toBeDefined();
  return { handle: handle!, canvas: canvas! };
}

const status = (board?: BoardScreen) => ({ roomName: 'R', peers: 0, nodeOnline: true, ...(board ? { board } : {}) });

describe('the room boards as built', () => {
  it('hang in front of the mount plane, inside the clearance width, and never block', () => {
    for (const kind of ['corkboard', 'notice-case'] as const) {
      const def = FURNITURE_DEFS[kind];
      expect(def.footprint).toBeNull();
      const halfW = def.wallMount!.halfW;
      const box = new THREE.Box3().setFromObject(build(kind));
      expect(box.min.z).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.z).toBeLessThan(0.15); // inside the wall-mount slab (wallMountBox)
      expect(box.max.x).toBeLessThanOrEqual(halfW + 1e-6);
      expect(box.min.x).toBeGreaterThanOrEqual(-halfW - 1e-6);
      expect(def.device?.kind).toBe('corkboard');
    }
  });

  it('file a board handle of their own kind: the corkboard is open, the case is the owner’s', () => {
    expect(handleOf('corkboard').handle.board).toBe('open');
    expect(handleOf('notice-case').handle.board).toBe('owner');
  });

  it('paint on a whole-number multiple of the face layout', () => {
    const { canvas } = handleOf('corkboard');
    expect([canvas.width, canvas.height]).toEqual([BOARD_FACE_W * BOARD_FACE_SCALE, BOARD_FACE_H * BOARD_FACE_SCALE]);
    // The plane matches the layout's aspect, so notes aren't stretched.
    const def = FURNITURE_DEFS.corkboard;
    expect(def.wallMount!.halfW * 2).toBeCloseTo(1.2);
  });

  it('repaint only when the notes they show change', () => {
    const { handle } = handleOf('corkboard');
    const screen: BoardScreen = {
      kind: 'open',
      hiddenCount: 0,
      notes: [{ id: 'ab'.repeat(16), text: 'Movie night 8pm', authorName: 'Ada', colour: 'yellow', x: 0.2, y: 0.3, unseen: true, photo: false }],
    };
    fills = 0;
    handle.updateStatus(status(screen));
    const first = fills;
    expect(first).toBeGreaterThan(0);
    handle.updateStatus(status({ ...screen, notes: [...screen.notes] }));
    expect(fills).toBe(first); // same notes: no repaint
    handle.updateStatus(status({ ...screen, notes: [{ ...screen.notes[0], unseen: false }] }));
    expect(fills).toBeGreaterThan(first); // the glow went out: repaint
  });

  it('paints a photo note and an empty board without throwing', () => {
    const { handle } = handleOf('notice-case');
    expect(() => handle.updateStatus(status({ kind: 'owner', hiddenCount: 0, notes: [], empty: 'NO NOTICES' }))).not.toThrow();
    expect(() => handle.updateStatus(status({
      kind: 'owner',
      hiddenCount: 2,
      notes: [{ id: '0f'.repeat(16), text: 'Launch party', authorName: 'Owner', colour: 'white', x: 0.5, y: 0.5, unseen: false, photo: true }],
    }))).not.toThrow();
  });
});

describe('the face painter', () => {
  const measure = (s: string) => s.length * 5; // 5 units a character

  it('wraps words to the width and stops at the line cap with an ellipsis', () => {
    expect(wrapNoteText(measure, 'one two three four', 40, 5)).toEqual(['one two', 'three', 'four']);
    const lines = wrapNoteText(measure, 'aa bb cc dd ee ff gg hh', 25, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('keeps line breaks and cuts a word wider than the note', () => {
    expect(wrapNoteText(measure, 'hi\nthere', 100, 5)).toEqual(['hi', 'there']);
    expect(wrapNoteText(measure, 'abcdefghijkl', 30, 3)).toEqual(['abcdef']);
  });

  it('adds no ellipsis when the text just fits the cap', () => {
    expect(wrapNoteText(measure, 'aa\nbb', 100, 2)).toEqual(['aa', 'bb']);
  });

  it('tilts a note by its id, the same way every time, within a few degrees', () => {
    const id = 'c3'.repeat(16);
    expect(noteTilt(id)).toBe(noteTilt(id));
    for (const i of ['00', '7f', 'ff', 'zz']) expect(Math.abs(noteTilt(i + 'a'.repeat(30)))).toBeLessThanOrEqual(0.08 + 1e-9);
  });
});

describe('the panel’s age stamps', () => {
  const now = 1_800_000_000_000;
  it('reads like a person would say it', () => {
    expect(noteAge(now - 10_000, now)).toBe('just now');
    expect(noteAge(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(noteAge(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(noteAge(now - 2 * 86400_000, now)).toBe('2 d ago');
    expect(noteAge(now + 60_000, now)).toBe('just now'); // a clock a little ahead
  });
});
