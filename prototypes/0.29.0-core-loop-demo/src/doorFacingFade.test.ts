/**
 * 🚪 #51 near-wall door fade in the isometric room view (docking.ts
 * updateFacingFade): the doors on the walls toward the camera go very faint
 * so they never hide the room, and a door first drawn solid still fades
 * after the view turns (three.js needs a recompile for that).
 */
import { describe, expect, it, vi } from 'vitest';

// The docking system's module graph touches `window` and `document` as it
// loads: stub them before any import runs.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    __ssfRoomId: 'fade-room',
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
  };
  g.document = { getElementById: () => null };
});

import * as THREE from 'three';
import { DoorDockingPortSystem } from './docking';
import { LEGACY_ID_WALL } from './doorLayoutDoc';

type Internals = {
  buildDoorGroup(record: object): void;
  doorFadeMats: Map<string, THREE.Material[]>;
};

function buildDoors(): { docking: DoorDockingPortSystem; mats: Map<string, THREE.Material[]> } {
  const docking = new DoorDockingPortSystem(new THREE.Group());
  const inner = docking as unknown as Internals;
  for (const id of ['north', 'south', 'west', 'east'] as const) {
    inner.buildDoorGroup({ id, wall: LEGACY_ID_WALL[id], lateral: 0, size: 'large', enabled: false });
  }
  return { docking, mats: inner.doorFadeMats };
}

const opacityOf = (mats: THREE.Material[]) => mats[0].opacity;

describe('the near-wall door fade', () => {
  it('takes the camera-facing doors down to very faint and leaves the rest solid', () => {
    const { docking, mats } = buildDoors();
    for (let i = 0; i < 30; i++) docking.updateFacingFade(0.1, true, null);
    const faint = [...mats].filter(([, m]) => opacityOf(m) === DoorDockingPortSystem.FACING_FADE_OPACITY);
    const solid = [...mats].filter(([, m]) => opacityOf(m) === 1);
    // The camera sits off a corner: two walls face it, two face away.
    expect(faint).toHaveLength(2);
    expect(solid).toHaveLength(2);
    expect(DoorDockingPortSystem.FACING_FADE_OPACITY).toBeLessThanOrEqual(0.1);
    for (const [, m] of faint) for (const mat of m) expect(mat.transparent).toBe(true);
    for (const [, m] of solid) for (const mat of m) expect(mat.transparent).toBe(false);
  });

  it('recompiles a material when it turns see-through or solid again', () => {
    const { docking, mats } = buildDoors();
    const before = new Map([...mats.values()].flat().map((m) => [m, m.version]));
    for (let i = 0; i < 30; i++) docking.updateFacingFade(0.1, true, null);
    const faded = [...mats.values()].flat().filter((m) => m.transparent);
    expect(faded.length).toBeGreaterThan(0);
    for (const m of faded) expect(m.version).toBeGreaterThan(before.get(m)!);
    // Back to solid (first person, say): recompiled again so it draws opaque.
    const mid = new Map(faded.map((m) => [m, m.version]));
    for (let i = 0; i < 30; i++) docking.updateFacingFade(0.1, false, null);
    for (const m of faded) {
      expect(m.transparent).toBe(false);
      expect(m.opacity).toBe(1);
      expect(m.version).toBeGreaterThan(mid.get(m)!);
    }
  });

  it('keeps the door you walk through solid', () => {
    const { docking, mats } = buildDoors();
    for (let i = 0; i < 30; i++) docking.updateFacingFade(0.1, true, null);
    const [nearId] = [...mats].find(([, m]) => opacityOf(m) < 1)!;
    for (let i = 0; i < 30; i++) docking.updateFacingFade(0.1, true, nearId as never);
    expect(opacityOf(mats.get(nearId)!)).toBe(1);
  });
});
