/**
 * 🕹️ The helm's sticks. The console's two (furniture.ts buildHelmSticks)
 * are built for real (buildItemGroup, with a stand-in canvas for its docking
 * screen), their frame handle filed the way World files it and driven a
 * frame at a time the way World drives it. The station helm's dashboard
 * (stationHelm.ts) is opened on a stand-in for just the DOM it touches; how
 * its on-screen stick takes the focus, and how World opens it, are pinned on
 * their source.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import * as Y from 'yjs';
import type { DeviceUI, PropAnimHandle } from './devices';
import { bindDoorLayoutDoc, seedDoorLayoutSingle } from './doorLayoutDoc';
import { bindDoorsDoc, buildDoorPairing, readAllDoors, writeDoorPairing, writeDoorRecordTo } from './doorsDoc';
import { FURNITURE, buildItemGroup, type FurnitureItem } from './furniture';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import { bindShipDoc, writeFlightRecord, writeFuelLevel } from './shipDoc';
import { createStationHelmUI, setStationHelmCommanderCheck } from './stationHelm';
import { TRIM_FUEL, TRIM_STEP_KM, applyBurn, bindStationKeepingDoc, readOrbitTrim, setSharedTrimSource, writeTrimBurn } from './stationKeeping';
import type { OrbitTrim, TrimBurn } from './stationKeeping';
import { DEFAULT_PLANET_ID, DEFAULT_STATION_RECORD, listStations, planetById, registerStation, setStationRoomSource } from './stations';

const HELM = 'helm-1';
/** The fighter grip's red pickle button and the trim stick's amber knob. */
const FIGHTER = 0xff1744;
const TRIM_STICK = 0xffb300;

/** A trim's orbit, count and place, as applyBurn gives them: without the
 *  writers a room's log replay names, or their floor (OrbitTrim.seen,
 *  seenFloor). */
const orbitOf = (t: OrbitTrim | null | undefined) => (t ? { ...t, seen: undefined, seenFloor: undefined } : t);

/** A canvas whose 2-D context draws nothing: the docking screen paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

/** A 2-D context that draws nothing and keeps each fill style it is given. */
function fillsInto(fills: string[]) {
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      if (key === 'fillStyle') fills.push(String(value));
      target[key] = value;
      return true;
    },
  });
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
    airHockeyVisuals: new Map(),
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

  it('leans for another helm room\'s burn while the station flies the shared trim it left', () => {
    // Copilot's review of #173: the stick read this room's burns alone, so it
    // stood upright while the dashboard said another room's burn was firing.
    stubSavedRecords();
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    setStationRoomSource(() => 'room-yard');
    let shared: OrbitTrim | null = null;
    setSharedTrimSource((st) => (st.id === 'yard' ? shared : null));
    const { group, anim, dispose } = buildHelm();
    try {
      saveAsStation('room-yard');
      for (let i = 0; i < 4; i++) anim.update(0.25);
      expect(shown(group, TRIM_STICK)).toBe(true);
      const gimbal = partIn(group, TRIM_STICK).parent!;
      expect(Math.abs(gimbal.rotation.z)).toBeLessThan(0.01);
      shared = { planetId: planetById(DEFAULT_PLANET_ID).id, slot: 1, dRadiusKm: 0, dPhase: 0, at: Date.now(), last: 'ahead', seq: 1 };
      anim.update(0.1);
      // AHEAD leans it to the pilot's right.
      expect(gimbal.rotation.z).toBeGreaterThan(0.1);
    } finally {
      dispose();
      setSharedTrimSource(null);
    }
  });

  it('leans for the shared trim\'s burn when this room\'s fired in the same millisecond', () => {
    // Copilot's review of #173: on a tie the stick leaned for this room's
    // burn, though the station flies the shared trim that beat it.
    stubSavedRecords();
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    setStationRoomSource(() => 'room-yard');
    const planetId = planetById(DEFAULT_PLANET_ID).id;
    const now = Date.now();
    setSharedTrimSource((st) => (st.id === 'yard'
      ? { planetId, slot: 1, dRadiusKm: 0, dPhase: 0, at: now, last: 'ahead', seq: 3 }
      : null));
    const { group, anim, dispose } = buildHelm();
    try {
      saveAsStation('room-yard');
      writeFuelLevel(40, 100);
      expect(writeTrimBurn({ planetId, slot: 1, dir: 'back', at: now, fuel: TRIM_FUEL })).toBe(true);
      for (let i = 0; i < 4; i++) anim.update(0.25);
      expect(shown(group, TRIM_STICK)).toBe(true);
      // AHEAD, the shared trim's, leans it to the pilot's right; BACK would lean it left.
      expect(partIn(group, TRIM_STICK).parent!.rotation.z).toBeGreaterThan(0.1);
    } finally {
      dispose();
      setSharedTrimSource(null);
    }
  });
  it('a gangway on one of the room\'s own doors shows the trim stick, past a flood of other records', () => {
    // Copilot's review of #173: the console read the doors' capped snapshot,
    // so 64 records written ahead of a real gangway hid it, and the console
    // showed the fighter grip in a module bolted into a station.
    const doors = new Y.Doc();
    bindDoorsDoc(doors);
    bindDoorLayoutDoc(doors);
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    for (let i = 0; i < 64; i++) {
      writeDoorRecordTo(doors, `d:flood-${i}`, buildDoorPairing('ssf://room#room=junk', { transient: true }));
    }
    writeDoorPairing('d:gangway', 'ssf://room#room=station-core');
    expect(readAllDoors().has('d:gangway')).toBe(false);
    setStationRoomSource(() => 'room-module');
    const { group, anim, dispose } = buildHelm();
    try {
      anim.update(0.016);
      expect(shown(group, FIGHTER)).toBe(false);
      expect(shown(group, TRIM_STICK)).toBe(true);
    } finally {
      dispose();
      bindDoorsDoc(new Y.Doc());
      bindDoorLayoutDoc(new Y.Doc());
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

/** The stand-in element holding the keyboard focus. */
let focused: FakeElement | null = null;

/** Just enough of an element for the station helm's dashboard: what it
 *  builds, reads, writes and wires up. Whatever a selector asks an element
 *  for is a stand-in of its own. */
class FakeElement {
  id = '';
  type = '';
  textContent = '';
  innerHTML = '';
  disabled = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  private found = new Map<string, FakeElement>();
  constructor(readonly tag: string) {}
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelector(sel: string): FakeElement {
    let el = this.found.get(sel);
    if (!el) this.found.set(sel, (el = new FakeElement(sel)));
    return el;
  }
  focus(): void {
    focused = this;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  getContext(): null {
    return null;
  }
}

/** Stand-in ship faces: where each is mounted (null once unmounted) and how many frames it was given. */
function shipFaces(): { built: Array<{ host: unknown; frames: number }>; shipFace: () => DeviceUI } {
  const built: Array<{ host: unknown; frames: number }> = [];
  const shipFace = (): DeviceUI => {
    const face = { host: null as unknown, frames: 0 };
    built.push(face);
    return {
      mount: (h) => { face.host = h; },
      unmount: () => { face.host = null; },
      update: () => { face.frames++; },
    };
  };
  return { built, shipFace };
}

/** The station keeping face on `host`, if it shows. */
const keepFace = (host: FakeElement): FakeElement | null => host.children.find((c) => c.id === 'device-station-helm-pane') ?? null;
/** The ship face's way to station keeping on `host`, each one it shows. */
const waysToKeeping = (host: FakeElement): FakeElement[] =>
  host.children.filter((c) => c.tag === 'button' && c.textContent.includes('STATION KEEPING'));
/** A click on the dashboard's tab `name`. */
const tabClick = (name: string) => ({
  stopPropagation: () => {},
  target: { closest: (sel: string) => (sel === '[data-sk-tab]' ? { dataset: { skTab: name } } : null) },
});
const click = { stopPropagation: () => {} };
/** An arrow key pressed, not held. */
const arrowUp = { key: 'ArrowUp', repeat: false, preventDefault: () => {} };

/** Is the SpacePhone open over the helm (main.ts marks its container active)? */
let phoneOpen = false;
/** A text field the player is typing in, holding the focus. */
let typingIn: { tagName: string } | null = null;
/** The keydown listeners on the stand-in window. */
const windowKeys: Array<(e: unknown) => void> = [];

/** A key pressed (not held) at whatever holds the focus, which the window
 *  hears after it. */
function press(key: string, more: Record<string, unknown> = {}): void {
  const e = { key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: typingIn ?? focused, preventDefault: () => {}, ...more };
  focused?.dispatch('keydown', e);
  for (const fn of [...windowKeys]) fn(e);
}

describe('the helm dashboard\'s faces', () => {
  beforeEach(() => {
    focused = null;
    phoneOpen = false;
    typingIn = null;
    windowKeys.length = 0;
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'keydown') windowKeys.push(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'keydown' && windowKeys.includes(fn)) windowKeys.splice(windowKeys.indexOf(fn), 1);
      },
    });
    const phone = { classList: { contains: (name: string) => name === 'active' && phoneOpen } };
    vi.stubGlobal('document', {
      createElement: (tag: string) => new FakeElement(tag),
      getElementById: (id: string) => (id === 'spacephone-container' ? phone : null),
      get activeElement() {
        return typingIn ?? focused;
      },
    });
  });

  it('a helm whose module steers a station opens on station keeping', () => {
    const { built, shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => true, station: () => null, shipFace });
    const host = new FakeElement('host');
    ui.mount(host as unknown as HTMLElement);
    expect(keepFace(host)).not.toBeNull();
    expect(built).toHaveLength(0);
    ui.unmount();
    expect(host.children).toHaveLength(0);
  });

  it('🅿️ a station flying by itself opens on the ship face, with no way to station keeping, until it parks', () => {
    // Copilot's merge-time review of #205: trim, MOVE and ALTITUDE while the
    // station flies free would book a move others read as its PARK.
    const doc = new Y.Doc();
    bindShipDoc(doc);
    try {
      writeFlightRecord({ status: 'docked', locationId: DEFAULT_STATION_RECORD.id });
      doc.getMap('ship').set('flight', { status: 'free-flight', locationId: DEFAULT_STATION_RECORD.id });
      const { built, shipFace } = shipFaces();
      const ui = createStationHelmUI({ bolted: () => true, station: () => null, shipFace });
      const host = new FakeElement('host');
      ui.mount(host as unknown as HTMLElement);
      expect(keepFace(host)).toBeNull();
      expect(built).toHaveLength(1);
      for (let i = 0; i < 4; i++) ui.update(0.25);
      expect(waysToKeeping(host)).toHaveLength(0);
      ui.unmount();
      // Parked (docked again): station keeping is back.
      doc.getMap('ship').set('flight', { status: 'docked', locationId: DEFAULT_STATION_RECORD.id });
      const again = createStationHelmUI({ bolted: () => true, station: () => null, shipFace });
      again.mount(host as unknown as HTMLElement);
      expect(keepFace(host)).not.toBeNull();
      again.unmount();
    } finally {
      doc.destroy();
    }
  });

  it('a helm opened on the ship face offers station keeping once its module steers a station, and stays where the pilot is', () => {
    // Copilot's review of #173: a helm opened as a ship's never offered
    // station keeping when its module came to steer a station (a gangway
    // paired, or the room saved as a station) while it was open.
    let steers = false;
    let reads = 0;
    const { built, shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => (reads++, steers), station: () => null, shipFace });
    const host = new FakeElement('host');
    ui.mount(host as unknown as HTMLElement);
    expect(built).toHaveLength(1);
    expect(built[0].host).toBe(host);
    expect(keepFace(host)).toBeNull();
    expect(waysToKeeping(host)).toHaveLength(0);
    // It asks twice a second, not every frame.
    reads = 0;
    for (let i = 0; i < 60; i++) ui.update(1 / 60);
    expect(built[0].frames).toBe(60);
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThanOrEqual(2);
    expect(waysToKeeping(host)).toHaveLength(0);

    // Steering a station now: the way to station keeping shows within half
    // a second, once, and the pilot stays on the ship face.
    steers = true;
    for (let i = 0; i < 2; i++) ui.update(0.25);
    expect(waysToKeeping(host)).toHaveLength(1);
    for (let i = 0; i < 4; i++) ui.update(0.25);
    expect(waysToKeeping(host)).toHaveLength(1);
    expect(built).toHaveLength(1);
    expect(built[0].host).toBe(host);
    expect(keepFace(host)).toBeNull();

    // Taking it opens station keeping.
    waysToKeeping(host)[0].dispatch('click', click);
    expect(built[0].host).toBeNull();
    expect(waysToKeeping(host)).toHaveLength(0);
    expect(keepFace(host)).not.toBeNull();

    // FUEL & DOCKING goes back to a ship face, the way back on it at once.
    keepFace(host)!.dispatch('click', tabClick('ship'));
    expect(keepFace(host)).toBeNull();
    expect(built).toHaveLength(2);
    expect(built[1].host).toBe(host);
    expect(waysToKeeping(host)).toHaveLength(1);

    // Steering no station again: the way back goes, the ship face stays.
    steers = false;
    for (let i = 0; i < 2; i++) ui.update(0.25);
    expect(waysToKeeping(host)).toHaveLength(0);
    expect(built[1].host).toBe(host);

    ui.unmount();
    expect(built[1].host).toBeNull();
    expect(host.children).toHaveLength(0);
  });

  it('the stick takes the keyboard focus as station keeping opens, and again on the way back from FUEL & DOCKING', () => {
    // Copilot's review of #173: Tab is the SpacePhone's (main.ts) and the
    // helm opened with nothing focused, so the arrow keys needed a pointer.
    const { shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => true, station: () => null, shipFace });
    const host = new FakeElement('host');
    ui.mount(host as unknown as HTMLElement);
    expect(focused).toBe(keepFace(host)!.querySelector('#sk-well'));
    keepFace(host)!.dispatch('click', tabClick('ship'));
    focused = null; // it went with the panel
    waysToKeeping(host)[0].dispatch('click', click);
    expect(focused).not.toBeNull();
    expect(focused).toBe(keepFace(host)!.querySelector('#sk-well'));
    ui.unmount();
  });

  it('the stick leaves the focus in a text field the player is typing in', () => {
    for (const tagName of ['INPUT', 'TEXTAREA']) {
      typingIn = { tagName };
      const { shipFace } = shipFaces();
      const ui = createStationHelmUI({ bolted: () => true, station: () => null, shipFace });
      const host = new FakeElement('host');
      ui.mount(host as unknown as HTMLElement);
      expect(keepFace(host)).not.toBeNull();
      expect(focused).toBeNull();
      ui.unmount();
    }
  });

  it('an arrow key fires a burn, but none while the SpacePhone is open over the helm', () => {
    // The stick holds the focus with the SpacePhone open over the helm.
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    setStationHelmCommanderCheck(() => true);
    const parts: FurnitureItem[] = [
      { id: 'sk-engine', kind: 'engine-block', pos: { x: 0, z: 0 }, rot: 0, movable: true },
      { id: 'sk-tank', kind: 'fuel-tank', pos: { x: 2, z: 0 }, rot: 0, movable: true },
    ];
    FURNITURE.push(...parts);
    const { shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => true, station: () => DEFAULT_STATION_RECORD, shipFace });
    const host = new FakeElement('host');
    try {
      writeFuelLevel(40, 100);
      const burns = () => [...doc.getMap('stationKeeping').keys()].filter((k) => k.startsWith('burn:')).length;
      ui.mount(host as unknown as HTMLElement);
      const well = keepFace(host)!.querySelector('#sk-well');
      phoneOpen = true;
      well.dispatch('keydown', arrowUp);
      expect(burns()).toBe(0);
      phoneOpen = false;
      well.dispatch('keydown', arrowUp);
      expect(burns()).toBe(1);
    } finally {
      ui.unmount();
      for (const part of parts) FURNITURE.splice(FURNITURE.indexOf(part), 1);
      setStationHelmCommanderCheck(null);
    }
  });

  it('shows the station\'s shared trim when another helm room left it newer, and a press goes on from it', () => {
    // Copilot's review of #176: a second helm room of one station started
    // from its own trim (none) and replaced the orbit the first one left.
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    setStationHelmCommanderCheck(() => true);
    const parts: FurnitureItem[] = [
      { id: 'sk-engine', kind: 'engine-block', pos: { x: 0, z: 0 }, rot: 0, movable: true },
      { id: 'sk-tank', kind: 'fuel-tank', pos: { x: 2, z: 0 }, rot: 0, movable: true },
    ];
    FURNITURE.push(...parts);
    const st = DEFAULT_STATION_RECORD;
    // Another helm room's burn, still firing.
    const shared: OrbitTrim = {
      planetId: planetById(st.planetId).id, slot: st.orbitSlot, dRadiusKm: TRIM_STEP_KM, dPhase: 0, at: Date.now() - 100, last: 'raise',
    };
    setSharedTrimSource((s) => (s.id === st.id ? shared : null));
    const { shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => true, station: () => st, shipFace });
    const host = new FakeElement('host');
    const burns = () => [...doc.getMap('stationKeeping').entries()].filter(([k]) => k.startsWith('burn:')).map(([, v]) => v as TrimBurn);
    try {
      writeFuelLevel(40, 100);
      ui.mount(host as unknown as HTMLElement);
      const face = keepFace(host)!;
      expect(face.querySelector('#sk-alt').innerHTML).toContain(`(+${TRIM_STEP_KM.toFixed(1)})`);
      expect(face.querySelector('#sk-msg').textContent).toMatch(/^BURNING/);
      // The knob leans for it, and the box draws its exhaust (Copilot's
      // review of #173: they read this room's burns alone).
      const fills: string[] = [];
      Object.assign(face.querySelector('#sk-box'), { getContext: () => fillsInto(fills) });
      ui.update(1 / 60);
      expect(face.querySelector('#sk-knob').style.transform).toMatch(/^translate\(0px, -[\d.]+px\)$/);
      expect(fills.some((f) => f.startsWith('rgba(255,138,64'))).toBe(true);
      face.querySelector('#sk-well').dispatch('keydown', arrowUp);
      expect(burns()).toEqual([]);
      // Once it has fired, a press goes on from it, and the burn carries it.
      shared.at = Date.now() - 10_000;
      face.querySelector('#sk-well').dispatch('keydown', arrowUp);
      expect(burns()).toHaveLength(1);
      const [burn] = burns();
      expect(burn.from).toEqual(shared);
      expect(orbitOf(readOrbitTrim(st))).toEqual(applyBurn(shared, burn));
      expect(readOrbitTrim(st)).toMatchObject({ dRadiusKm: 2 * TRIM_STEP_KM, last: 'raise' });
    } finally {
      ui.unmount();
      for (const part of parts) FURNITURE.splice(FURNITURE.indexOf(part), 1);
      setStationHelmCommanderCheck(null);
      setSharedTrimSource(null);
    }
  });

  it('shows the shared trim\'s burn when this room\'s fired in the same millisecond', () => {
    // Copilot's review of #173: on a tie the status line and the knob showed
    // this room's burn, though the helm flies the shared trim that beat it.
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindStationKeepingDoc(doc);
    setStationHelmCommanderCheck(() => true);
    const parts: FurnitureItem[] = [
      { id: 'sk-engine', kind: 'engine-block', pos: { x: 0, z: 0 }, rot: 0, movable: true },
      { id: 'sk-tank', kind: 'fuel-tank', pos: { x: 2, z: 0 }, rot: 0, movable: true },
    ];
    FURNITURE.push(...parts);
    const st = DEFAULT_STATION_RECORD;
    const planetId = planetById(st.planetId).id;
    const now = Date.now();
    setSharedTrimSource((s) => (s.id === st.id
      ? { planetId, slot: st.orbitSlot, dRadiusKm: TRIM_STEP_KM, dPhase: 0, at: now, last: 'raise', seq: 3 }
      : null));
    const { shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => true, station: () => st, shipFace });
    const host = new FakeElement('host');
    try {
      writeFuelLevel(40, 100);
      expect(writeTrimBurn({ planetId, slot: st.orbitSlot, dir: 'lower', at: now, fuel: TRIM_FUEL })).toBe(true);
      ui.mount(host as unknown as HTMLElement);
      const face = keepFace(host)!;
      expect(face.querySelector('#sk-msg').textContent).toBe(`BURNING: raising the orbit ${TRIM_STEP_KM} km.`);
      ui.update(1 / 60);
      // RAISE pushes the knob up; LOWER would push it down.
      expect(face.querySelector('#sk-knob').style.transform).toMatch(/^translate\(0px, -[\d.]+px\)$/);
    } finally {
      ui.unmount();
      for (const part of parts) FURNITURE.splice(FURNITURE.indexOf(part), 1);
      setStationHelmCommanderCheck(null);
      setSharedTrimSource(null);
    }
  });

  it('F opens FUEL & DOCKING and K comes back to station keeping, from the keyboard alone', () => {
    // Copilot's review of #173: with Tab the SpacePhone's and the arrows the
    // stick's, a keyboard player could not switch faces either way.
    let steers = true;
    const { built, shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => steers, station: () => null, shipFace });
    const host = new FakeElement('host');
    ui.mount(host as unknown as HTMLElement);
    expect(keepFace(host)!.innerHTML).toMatch(/data-sk-tab="ship"[^>]*aria-keyshortcuts="F"[^>]*>FUEL &amp; DOCKING \[F\]</);
    expect(keepFace(host)!.innerHTML).toMatch(/data-sk-tab="keep"[^>]*aria-keyshortcuts="K"[^>]*>STATION KEEPING \[K\]</);
    press('k');
    expect(built).toHaveLength(0);
    press('F');
    expect(keepFace(host)).toBeNull();
    expect(built).toHaveLength(1);
    expect(built[0].host).toBe(host);
    const way = waysToKeeping(host)[0];
    expect(way.textContent).toBe('◂ STATION KEEPING [K]');
    expect(way.getAttribute('aria-keyshortcuts')).toBe('K');
    press('f');
    expect(built).toHaveLength(1);
    press('k');
    expect(built[0].host).toBeNull();
    expect(keepFace(host)).not.toBeNull();
    expect(focused).toBe(keepFace(host)!.querySelector('#sk-well'));

    // K waits for the ship face to offer station keeping.
    press('f');
    steers = false;
    for (let i = 0; i < 2; i++) ui.update(0.25);
    expect(waysToKeeping(host)).toHaveLength(0);
    press('k');
    expect(keepFace(host)).toBeNull();
    expect(built[1].host).toBe(host);

    // Closed, the helm hears no more keys.
    ui.unmount();
    expect(windowKeys).toHaveLength(0);
  });

  it('F and K are no commands while typing, at the SpacePhone, with a modifier held or held down', () => {
    const { built, shipFace } = shipFaces();
    const ui = createStationHelmUI({ bolted: () => true, station: () => null, shipFace });
    const host = new FakeElement('host');
    ui.mount(host as unknown as HTMLElement);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      typingIn = { tagName };
      press('f');
    }
    typingIn = null;
    press('f', { target: { tagName: 'DIV', isContentEditable: true } });
    phoneOpen = true;
    press('f');
    phoneOpen = false;
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) press('f', { [mod]: true });
    press('f', { repeat: true });
    expect(built).toHaveLength(0);
    expect(keepFace(host)).not.toBeNull();
    press('f');
    expect(built).toHaveLength(1);
    phoneOpen = true;
    press('k');
    expect(built[0].host).toBe(host);
    ui.unmount();
  });

  it('World opens every helm through the station helm, a ship\'s too', () => {
    const src = readFileSync(new URL('./world.ts', import.meta.url), 'utf8');
    const open = 'if (device.kind === "helm") {';
    expect(src.split(open)).toHaveLength(2);
    const from = src.slice(src.indexOf(open));
    const block = from.slice(0, from.indexOf('\n      return;'));
    expect(block).toContain('const ui = createStationHelmUI(');
    expect(block).toContain('deviceFocus.beginFocus(this.player, device, ui);');
    // Its face follows the room's own doors, each read past the doors' read
    // cap, so a flood of records never hides a gangway (Copilot's review of #173).
    expect(block).toContain('const bolted = () => steersStation(currentRoomId(), readPhysicalDoors());');
  });
});
