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
import * as Y from 'yjs';
import type { PropAnimHandle } from './devices';
import { buildItemGroup } from './furniture';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import { bindShipDoc, writeFuelLevel } from './shipDoc';
import { TRIM_FUEL, bindStationKeepingDoc } from './stationKeeping';
import { DEFAULT_PLANET_ID, DEFAULT_STATION_RECORD, listStations, registerStation, setStationRoomSource } from './stations';

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

/** The one part whose material is `color`. */
function partIn(group: THREE.Group, color: number): THREE.Object3D {
  const parts: THREE.Object3D[] = [];
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshStandardMaterial).color?.getHex() === color) parts.push(obj);
  });
  if (parts.length !== 1) throw new Error(`${parts.length} parts in ${color.toString(16)}`);
  return parts[0];
}

/** Is the part whose material is `color` drawn: it and everything it hangs on visible? */
function shown(group: THREE.Group, color: number): boolean {
  for (let o: THREE.Object3D | null = partIn(group, color); o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Station records saved on this install live in localStorage. */
function stubSavedRecords(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
}

/** Save lone room `roomId` as a station of this install's, in slot 1. */
function saveAsStation(roomId: string): void {
  expect(registerStation({ id: 'yard', name: 'YARD', planetId: DEFAULT_PLANET_ID, orbitSlot: 1, welcomeRoomId: roomId })).toBe(true);
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

  it('a lone room saved as a station shows the trim stick within a second, with no other news', () => {
    // Copilot's review of #173: saving a station record says nothing, so the
    // console kept the fighter grip while the dashboard opened the station helm.
    stubSavedRecords();
    setStationRoomSource(() => 'room-yard');
    const { group, anim, dispose } = buildHelm();
    try {
      expect(shown(group, FIGHTER)).toBe(true);
      saveAsStation('room-yard');
      for (let i = 0; i < 4; i++) anim.update(0.25);
      expect(shown(group, FIGHTER)).toBe(false);
      expect(shown(group, TRIM_STICK)).toBe(true);
    } finally {
      dispose();
    }
  });

  it('a burn in a lone room saved as a station shows the trim stick and leans it at once', () => {
    // Copilot's review of #173: a burn read only the station again, so the
    // stick stayed hidden and still.
    stubSavedRecords();
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    writeFuelLevel(50, 100);
    setStationRoomSource(() => 'room-yard');
    const { group, anim, dispose } = buildHelm();
    try {
      saveAsStation('room-yard');
      const at = Date.now();
      doc.getMap('stationKeeping').set(`burn:${doc.clientID}:${at}`, { planetId: DEFAULT_PLANET_ID, slot: 1, dir: 'raise', at, fuel: TRIM_FUEL, cap: 100 });
      expect(shown(group, TRIM_STICK)).toBe(true);
      anim.update(0.1);
      // RAISE pulls the knob back toward the pilot.
      expect(partIn(group, TRIM_STICK).parent!.rotation.x).toBeLessThan(-0.1);
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
