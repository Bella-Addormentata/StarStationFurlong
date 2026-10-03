/**
 * 🕹️ The helm's sticks. The console's two (furniture.ts buildHelmSticks)
 * are built for real (buildItemGroup, with a stand-in canvas for its docking
 * screen), their frame handle filed the way World files it and driven a
 * frame at a time the way World drives it. The station helm's on-screen
 * stick (stationHelm.ts) needs a DOM these tests run without, so it is
 * pinned on its source.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { PropAnimHandle } from './devices';
import { buildItemGroup } from './furniture';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import { DEFAULT_STATION_RECORD, listStations, setStationRoomSource } from './stations';

const HELM = 'helm-1';
/** The fighter grip's red pickle button and the trim stick's amber knob. */
const FIGHTER = 0xff1744;
const TRIM_STICK = 0xffb300;

/** A canvas whose 2-D context draws nothing: the docking screen paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

/** The console, built and filed as World.registerFurnitureGroup does it. */
function buildHelm(): { group: THREE.Group; anim: PropAnimHandle; dispose: () => void } {
  const group = buildItemGroup({ id: HELM, kind: 'helm-console', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  const sinks: FurnitureHandleSinks = {
    wallScreens: new Map(),
    holoSpinners: [],
    trunkLids: new Map(),
    gameTableTops: new Map(),
    cloneVats: new Map(),
    slotMachineVisuals: new Map(),
    coinPusherVisuals: new Map(),
    propAnims: new Map(),
  };
  const disposers: Array<() => void> = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    registerFurnitureHandles(sinks, HELM, obj);
    for (const [key, value] of Object.entries(obj.userData)) {
      if (key.startsWith('dispose') && typeof value === 'function') disposers.push(value as () => void);
    }
  });
  const anim = sinks.propAnims.get(HELM);
  if (!anim) throw new Error('the console filed no frame handle');
  return { group, anim, dispose: () => disposers.forEach((d) => d()) };
}

/** Is the part whose material is `color` drawn: it and everything it hangs on visible? */
function shown(group: THREE.Group, color: number): boolean {
  const parts: THREE.Object3D[] = [];
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshStandardMaterial).color?.getHex() === color) parts.push(obj);
  });
  if (parts.length !== 1) throw new Error(`${parts.length} parts in ${color.toString(16)}`);
  for (let o: THREE.Object3D | null = parts[0]; o; o = o.parent) if (!o.visible) return false;
  return true;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: fakeCanvas });
  vi.stubGlobal('window', {});
});

afterEach(() => {
  setStationRoomSource(() => '');
  vi.unstubAllGlobals();
});

describe('the helm console\'s sticks', () => {
  it('a station\'s own welcome room built before main.ts names the room shows the trim stick once it does', () => {
    // Copilot's review of #173: the console was built while the room was
    // still unnamed, picked the fighter grip, and heard nothing when main.ts
    // named the room.
    const welcome = DEFAULT_STATION_RECORD.welcomeRoomId;
    expect(listStations().some((st) => !st.derived && st.welcomeRoomId === welcome)).toBe(true);
    let room = '';
    setStationRoomSource(() => room);
    const { group, anim, dispose } = buildHelm();
    try {
      expect(shown(group, FIGHTER)).toBe(true);
      expect(shown(group, TRIM_STICK)).toBe(false);
      room = welcome;
      anim.update(0.016);
      expect(shown(group, FIGHTER)).toBe(false);
      expect(shown(group, TRIM_STICK)).toBe(true);
      anim.update(0.016);
      expect(shown(group, TRIM_STICK)).toBe(true);
      // A lone room that is no station's flies.
      room = 'room-lone';
      anim.update(0.016);
      expect(shown(group, FIGHTER)).toBe(true);
      expect(shown(group, TRIM_STICK)).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe('the station helm\'s on-screen stick', () => {
  it('takes the arrow keys once pressed', () => {
    // Copilot's review of #173: the press's preventDefault also kept the
    // stick from taking the focus, so the arrow keys went elsewhere.
    const src = readFileSync(new URL('./stationHelm.ts', import.meta.url), 'utf8');
    const open = "well.addEventListener('pointerdown'";
    expect(src.split(open)).toHaveLength(2);
    const from = src.slice(src.indexOf(open));
    const handler = from.slice(0, from.indexOf('\n    });'));
    expect(handler).toContain('e.preventDefault();');
    expect(handler).toContain('well.focus(');
  });
});
