/**
 * 🕹️ Arcade cabinet tests: the menu model and key map, the frame conversion
 * behind the CRT look, the cabinet builds (their screen handles are filed and
 * they free what they made), and the focus UI end to end with a stubbed DOM
 * and the real shared-game session — menu, a bundled game shared with the
 * room, back to the menu, your own cartridge, and leaving.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import * as Y from 'yjs';
import {
  MENU,
  cartridgeTitle,
  connectedPads,
  createArcadeCabinetUI,
  describeView,
  keyToButton,
  menuInput,
  type ArcadeView,
} from './arcadeCabinet';
import { ARCADE_GAMES } from './arcadeLibrary';
import { ArcadeMachine } from './arcadeMachine';
import { isArcadeTickFlags, unpackArcadeTick } from './arcadeNet';
import {
  arcadeFrame, registerArcadeVisual, resetArcadeSessions, setArcadeRomFetcher, setArcadeSender,
} from './arcadeSession';
import { BLACK_LIFT, CREDIT_PAGES, writeFrameRgba, type ArcadeScreenPainter } from './arcadeScreen';
import type { ArcadeLink, SharedView } from './arcadeSession';
import type { ArcadeCabinetVisualHandle } from './devices';
import { FURNITURE_DEFS, buildItemGroup } from './furniture';
import { registerFurnitureHandles, type FurnitureHandleSinks } from './furnitureHandles';
import { bindGamesDoc, readArcade } from './games/gamesDoc';

const menu = (cursor = 0): ArcadeView => ({ screen: 'menu', cursor, status: null });
const OWN = MENU.findIndex((e) => e.kind === 'own');
const CREDITS = MENU.findIndex((e) => e.kind === 'credits');

describe('menu model', () => {
  it('lists every bundled game, then your own cartridge, then credits', () => {
    expect(MENU.length).toBe(ARCADE_GAMES.length + 2);
    expect(OWN).toBe(ARCADE_GAMES.length);
    expect(CREDITS).toBe(ARCADE_GAMES.length + 1);
  });

  it('moves the cursor with wrap-around', () => {
    expect(menuInput(menu(0), 'UP').view).toEqual(menu(MENU.length - 1));
    expect(menuInput(menu(MENU.length - 1), 'DOWN').view).toEqual(menu(0));
    expect(menuInput(menu(1), 'SELECT').view).toEqual(menu(2));
    // A move clears a status line.
    expect(menuInput({ screen: 'menu', cursor: 0, status: 'NOT AN NES ROM' }, 'DOWN').view).toEqual(menu(1));
  });

  it('starts a game, asks for a file, or opens the credits', () => {
    expect(menuInput(menu(0), 'START').action).toEqual({ kind: 'start', game: ARCADE_GAMES[0] });
    expect(menuInput(menu(1), 'A').action).toEqual({ kind: 'start', game: ARCADE_GAMES[1] });
    expect(menuInput(menu(OWN), 'START').action).toEqual({ kind: 'pickFile' });
    expect(menuInput(menu(CREDITS), 'START').view).toEqual({ screen: 'credits', page: 0 });
    // B does nothing on the menu.
    expect(menuInput(menu(0), 'B')).toEqual({ view: menu(0), action: { kind: 'none' } });
  });

  it('pages through the credits and returns to the credits row', () => {
    expect(menuInput({ screen: 'credits', page: 0 }, 'LEFT').view).toEqual({ screen: 'credits', page: CREDIT_PAGES - 1 });
    expect(menuInput({ screen: 'credits', page: CREDIT_PAGES - 1 }, 'RIGHT').view).toEqual({ screen: 'credits', page: 0 });
    expect(menuInput({ screen: 'credits', page: 2 }, 'B').view).toEqual(menu(CREDITS));
  });
});

describe('keys', () => {
  it('maps arrows and WASD to the pad, X/Z to A/B, Enter/Shift to Start/Select', () => {
    expect(['ArrowUp', 'KeyW', 'ArrowDown', 'KeyS', 'ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD'].map(keyToButton))
      .toEqual(['UP', 'UP', 'DOWN', 'DOWN', 'LEFT', 'LEFT', 'RIGHT', 'RIGHT']);
    expect(['KeyX', 'KeyK', 'KeyZ', 'KeyJ', 'Enter', 'ShiftLeft'].map(keyToButton))
      .toEqual(['A', 'A', 'B', 'B', 'START', 'SELECT']);
  });

  it('leaves Esc, Tab and everything else alone', () => {
    expect(['Escape', 'Tab', 'KeyM', 'Space', 'Backspace'].map(keyToButton)).toEqual([null, null, null, null, null]);
  });

  it('turns a file name into a screen title', () => {
    expect(cartridgeTitle('my game (v1.2).nes')).toBe('MY GAME (V1.2)');
    expect(cartridgeTitle('.nes')).toBe('YOUR CARTRIDGE');
    expect(cartridgeTitle('ゲーム.nes')).toBe('YOUR CARTRIDGE');
    expect(cartridgeTitle(`${'x'.repeat(40)}.nes`)).toHaveLength(24);
  });
});

describe('connectedPads', () => {
  const pad = (id: string, connected = true) => ({ id, connected }) as unknown as Gamepad;

  it('skips the empty slots a disconnect leaves, so a lone pad is player 1', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [null, pad('b'), pad('c', false), pad('d'), pad('e')] });
    expect(connectedPads().map((p) => p.id)).toEqual(['b', 'd']);
  });

  it('reads a blocked Gamepad API as no pads', () => {
    vi.stubGlobal('navigator', {
      getGamepads: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(connectedPads()).toEqual([]);
    vi.stubGlobal('navigator', {});
    expect(connectedPads()).toEqual([]);
  });
});

describe('writeFrameRgba', () => {
  it('reads jsnes pixels as 0xBBGGRR and lifts black off zero', () => {
    const frame = new Uint32Array(256 * 240);
    frame[0] = 0x000000;
    frame[1] = 0xffffff;
    frame[2] = 0x0000ff; // red
    frame[3] = 0xff0000; // blue
    const out = new Uint8ClampedArray(256 * 240 * 4);
    writeFrameRgba(frame, out);
    expect([...out.subarray(0, 4)]).toEqual([BLACK_LIFT, BLACK_LIFT, BLACK_LIFT, 255]);
    expect([...out.subarray(4, 8)]).toEqual([255, 255, 255, 255]);
    expect([...out.subarray(8, 12)]).toEqual([255, BLACK_LIFT, BLACK_LIFT, 255]);
    expect([...out.subarray(12, 16)]).toEqual([BLACK_LIFT, BLACK_LIFT, 255, 255]);
  });
});

// ── Stubbed DOM ──────────────────────────────────────────────────────────────

/** A 2-D context that draws nothing. */
function fakeContext() {
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
}

interface FakeElement {
  tag: string;
  style: { cssText: string };
  textContent: string;
  id: string;
  children: FakeElement[];
  files?: Array<{ name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
  onchange: (() => void) | null;
  click: ReturnType<typeof vi.fn>;
  width: number;
  height: number;
  getContext: () => unknown;
  append: (...els: FakeElement[]) => void;
  remove: () => void;
  addEventListener: () => void;
  setAttribute: () => void;
}

const created: FakeElement[] = [];
function fakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    style: { cssText: '' },
    textContent: '',
    id: '',
    children: [],
    onchange: null,
    click: vi.fn(),
    width: 0,
    height: 0,
    getContext: () => fakeContext(),
    append: (...els) => el.children.push(...els),
    remove: () => undefined,
    addEventListener: () => undefined,
    setAttribute: () => undefined,
  };
  created.push(el);
  return el;
}

function key(
  type: 'keydown' | 'keyup',
  code: string,
  extra: { key?: string; repeat?: boolean; target?: { tagName: string }; mod?: 'ctrlKey' | 'metaKey' | 'altKey' } = {},
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'code', { value: code });
  Object.defineProperty(event, 'key', { value: extra.key ?? code });
  Object.defineProperty(event, 'repeat', { value: extra.repeat ?? false });
  for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
    Object.defineProperty(event, mod, { value: extra.mod === mod });
  }
  if (extra.target) Object.defineProperty(event, 'target', { value: extra.target });
  return event;
}

function recordingPainter() {
  return {
    drawFrame: vi.fn(),
    drawMenu: vi.fn(),
    drawCredits: vi.fn(),
    drawCard: vi.fn(),
    drawAttract: vi.fn(),
  } satisfies ArcadeScreenPainter;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let win: EventTarget;
/** Every datagram the session sent to the room. */
let sent: Uint8Array[];
beforeEach(() => {
  created.length = 0;
  win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { createElement: fakeElement });
  bindGamesDoc(new Y.Doc());
  resetArcadeSessions();
  sent = [];
  setArcadeSender((buf) => sent.push(buf));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setArcadeSender(null);
  setArcadeRomFetcher(null);
});

const ITEM = 'arcade-1';
const framesSent = () => sent.filter((b) => isArcadeTickFlags(b[0]) && unpackArcadeTick(b)?.type === 'frames').length;

/** One render frame: the focus UI, then the session (World.update's order). */
function tick(ui: { update(dt: number): void }, n = 1): void {
  for (let i = 0; i < n; i++) {
    ui.update(1 / 60);
    arcadeFrame(1 / 60, null);
  }
}

describe('the cabinet', () => {
  it('is a focusable 1×1 device whose screen handle is filed and whose parts are all freed', () => {
    const def = FURNITURE_DEFS['arcade-cabinet'];
    expect(def.footprint).toEqual({ w: 1, d: 1 });
    expect(def.device?.kind).toBe('arcadeCabinet');

    const group = buildItemGroup({ id: 'arcade-1', kind: 'arcade-cabinet', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    const sinks = { arcadeCabinetVisuals: new Map() } as unknown as FurnitureHandleSinks;
    let screen: THREE.Mesh | null = null;
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      registerFurnitureHandles(sinks, 'arcade-1', obj);
      if (obj.userData.arcadeCabinet) screen = obj;
    });
    const handle = sinks.arcadeCabinetVisuals.get('arcade-1');
    expect(handle).toBeDefined();

    // The screen faces the player (−z) and tilts up toward the focus eye.
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(screen!.rotation);
    expect(normal.z).toBeLessThan(-0.9);
    expect(normal.y).toBeGreaterThan(0);

    // Every texture the cabinet made is a material map the removal reaches.
    const maps = new Set<THREE.Texture>();
    group.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat?.map) maps.add(mat.map);
    });
    expect(maps.size).toBe(2); // screen + marquee
  });

  it('comes in a two-player size: 2×1, a wider screen, a stand for each player', () => {
    const one = FURNITURE_DEFS['arcade-cabinet'];
    const two = FURNITURE_DEFS['arcade-cabinet-2p'];
    expect(two.footprint).toEqual({ w: 2, d: 1 });
    expect(two.device?.kind).toBe('arcadeCabinet');
    expect(two.functions).toEqual(one.functions);

    const screens = (kind: 'arcade-cabinet' | 'arcade-cabinet-2p') => {
      const group = buildItemGroup({ id: kind, kind, pos: { x: 0, z: 0 }, rot: 0, movable: true });
      const sinks = { arcadeCabinetVisuals: new Map() } as unknown as FurnitureHandleSinks;
      let width = 0;
      group.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        registerFurnitureHandles(sinks, kind, obj);
        if (obj.userData.arcadeCabinet) {
          obj.geometry.computeBoundingBox();
          width = obj.geometry.boundingBox!.max.x - obj.geometry.boundingBox!.min.x;
        }
      });
      expect(sinks.arcadeCabinetVisuals.get(kind)).toBeDefined();
      return width;
    };
    expect(screens('arcade-cabinet-2p')).toBeGreaterThan(screens('arcade-cabinet') * 1.4);
  });
});

describe('the focus UI', () => {
  const thwaite = new Uint8Array(readFileSync(new URL('../public/arcade/roms/thwaite.nes', import.meta.url)));

  function setup() {
    const painter = recordingPainter();
    const visual: ArcadeCabinetVisualHandle = { painter, present: vi.fn(), showAttract: vi.fn() };
    const fetchRom = vi.fn(async () => thwaite);
    setArcadeRomFetcher(fetchRom);
    registerArcadeVisual(ITEM, visual, { x: 0, z: 0 });
    const requestRelease = vi.fn();
    const ui = createArcadeCabinetUI({ itemId: ITEM, visual, requestRelease });
    const host = fakeElement('div');
    return { ui, painter, visual, fetchRom, requestRelease, host };
  }

  it('shows the menu, shares a bundled game with the room, and Backspace ends it', async () => {
    const { ui, painter, visual, fetchRom, host } = setup();
    ui.mount(host as unknown as HTMLElement);
    expect(host.children.map((c) => c.id)).toEqual(['arcade-capture', 'arcade-strip']);
    expect(painter.drawMenu).toHaveBeenLastCalledWith(expect.any(Array), 0, null, true);

    const down = key('keydown', 'ArrowDown');
    win.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    tick(ui);
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(1);
    win.dispatchEvent(key('keydown', 'ArrowUp'));

    win.dispatchEvent(key('keydown', 'Enter'));
    expect(fetchRom).toHaveBeenCalledWith(ARCADE_GAMES[0].romUrl);
    tick(ui);
    expect(painter.drawCard).toHaveBeenCalledWith(ARCADE_GAMES[0].title, 'LOADING…');
    expect(readArcade(ITEM)).toBeNull(); // the room hears of it once it can run
    await flush();

    tick(ui, 30);
    expect(readArcade(ITEM)?.game).toBe(ARCADE_GAMES[0].id);
    expect(painter.drawFrame).toHaveBeenCalled();
    expect(visual.present).toHaveBeenCalled();
    expect(framesSent()).toBeGreaterThan(10); // the room runs it from these

    const menuDraws = painter.drawMenu.mock.calls.length;
    win.dispatchEvent(key('keydown', 'Backspace'));
    tick(ui);
    expect(painter.drawMenu.mock.calls.length).toBeGreaterThan(menuDraws);
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(0); // back on the game's row
    expect(readArcade(ITEM)).toBeNull(); // over for the room too

    ui.unmount();
    arcadeFrame(1 / 60, null);
    expect(visual.showAttract).toHaveBeenCalled();
    // Unmounted: keys go back to the room.
    const after = key('keydown', 'ArrowDown');
    win.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("at a two-player cabinet's free stand you play player 2; hand it back and Enter takes it again", () => {
    let shared: SharedView = { role: 'watcher', title: 'THWAITE', phase: 'playing', joinAs: 2, player: null };
    const link: ArcadeLink = {
      shared: () => shared,
      takeError: () => null,
      host: vi.fn(),
      stop: vi.fn(() => void (shared = { ...shared, role: 'watcher', joinAs: 2, player: null })),
      join: vi.fn(() => void (shared = { ...shared, role: 'guest', joinAs: null, player: 2 })),
      setButtons: vi.fn(),
      setLocalPad2: vi.fn(),
      setAudio: vi.fn(),
      setUiScreen: vi.fn(),
      release: vi.fn(),
    };
    const visual: ArcadeCabinetVisualHandle = { painter: recordingPainter(), present: vi.fn(), showAttract: vi.fn() };
    const ui = createArcadeCabinetUI({ itemId: ITEM, visual, seat: 1, seats: 2, requestRelease: vi.fn(), link });
    ui.mount(fakeElement('div') as unknown as HTMLElement);
    const strip = created.find((el) => el.tag === 'span')!;
    expect(link.join).toHaveBeenCalledTimes(1);
    ui.update(1 / 60);
    expect(strip.textContent).toMatch(/^PLAYER 2 · .* · ⌫ STOP PLAYING · ESC LEAVE$/);

    win.dispatchEvent(key('keydown', 'KeyX'));
    ui.update(1 / 60);
    expect(link.setButtons).toHaveBeenLastCalledWith(0b1); // A, as a pad byte

    win.dispatchEvent(key('keydown', 'Backspace'));
    expect(link.stop).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) ui.update(1 / 60);
    expect(link.join).toHaveBeenCalledTimes(1); // watching now: it doesn't grab the pad back
    expect(strip.textContent).toBe('WATCHING · ENTER PLAYS PLAYER 2 · ESC LEAVE');

    win.dispatchEvent(key('keyup', 'KeyX'));
    win.dispatchEvent(key('keydown', 'Enter'));
    expect(link.join).toHaveBeenCalledTimes(2);
    ui.update(1 / 60);
    expect(strip.textContent).toMatch(/^PLAYER 2 · /);
    // The Enter that took the stand is not Start in the game (it would
    // pause it for everyone) until it lets go; the next one is.
    expect(link.setButtons).toHaveBeenLastCalledWith(0);
    win.dispatchEvent(key('keydown', 'KeyX'));
    ui.update(1 / 60);
    expect(link.setButtons).toHaveBeenLastCalledWith(0b1);
    win.dispatchEvent(key('keyup', 'Enter'));
    win.dispatchEvent(key('keydown', 'Enter'));
    ui.update(1 / 60);
    expect(link.setButtons).toHaveBeenLastCalledWith(0b1001); // A and Start
    ui.unmount();
    expect(link.release).toHaveBeenCalled();
  });

  it('never takes Esc or Tab, so leaving and the phone still work', () => {
    const { ui, host } = setup();
    ui.mount(host as unknown as HTMLElement);
    for (const code of ['Escape', 'Tab']) {
      const event = key('keydown', code, { key: code });
      win.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    ui.unmount();
  });

  it('leaves Ctrl, Cmd and Alt shortcuts to the browser, and keeps Shift as Select', () => {
    const { ui, painter, host } = setup();
    ui.mount(host as unknown as HTMLElement);
    for (const [code, mod] of [
      ['KeyS', 'ctrlKey'],
      ['KeyW', 'metaKey'],
      ['ArrowLeft', 'altKey'],
    ] as const) {
      const event = key('keydown', code, { mod });
      win.dispatchEvent(event);
      expect(event.defaultPrevented, `${mod}+${code}`).toBe(false);
    }
    ui.update(1 / 60);
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(0); // the cursor never moved
    const select = key('keydown', 'ShiftLeft', { key: 'Shift' });
    win.dispatchEvent(select);
    expect(select.defaultPrevented).toBe(true);
    ui.unmount();
  });

  it('leaves Enter to a focused button, so LEAVE works from the keyboard', () => {
    const { ui, painter, fetchRom, host } = setup();
    ui.mount(host as unknown as HTMLElement);
    const onButton = key('keydown', 'Enter', { key: 'Enter', target: { tagName: 'BUTTON' } });
    win.dispatchEvent(onButton);
    expect(onButton.defaultPrevented).toBe(false);
    expect(fetchRom).not.toHaveBeenCalled();
    // Other keys on the button still drive the cabinet.
    const arrow = key('keydown', 'ArrowDown', { target: { tagName: 'BUTTON' } });
    win.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    ui.update(1 / 60);
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(1);
    ui.unmount();
  });

  it('loads your own cartridge from a local file, and refuses a file that is not a ROM', async () => {
    const { ui, painter, fetchRom, host } = setup();
    ui.mount(host as unknown as HTMLElement);
    for (let i = 0; i < OWN; i++) win.dispatchEvent(key('keydown', 'ArrowDown'));
    win.dispatchEvent(key('keydown', 'Enter'));
    const input = created.find((el) => el.tag === 'input');
    expect(input?.click).toHaveBeenCalled();
    expect(fetchRom).not.toHaveBeenCalled();

    input!.files = [{ name: 'notes.txt', size: 5, arrayBuffer: async () => new TextEncoder().encode('hello').buffer as ArrayBuffer }];
    input!.onchange!();
    await flush();
    ui.update(1 / 60);
    expect(painter.drawMenu.mock.lastCall?.[2]).toBe('FILE TOO SMALL');
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(OWN);

    win.dispatchEvent(key('keydown', 'Enter'));
    input!.files = [{ name: 'my homebrew.nes', size: thwaite.length, arrayBuffer: async () => thwaite.slice().buffer as ArrayBuffer }];
    input!.onchange!();
    ui.update(1 / 60);
    expect(painter.drawCard).toHaveBeenLastCalledWith('MY HOMEBREW', 'LOADING…');
    await flush();
    tick(ui, 10);
    expect(painter.drawFrame).toHaveBeenCalled();
    // Your own cartridge stays on this page: nothing reaches the room.
    expect(readArcade(ITEM)).toBeNull();
    expect(sent).toEqual([]);
    ui.unmount();
  });

  it('a ROM that arrives after the player left is dropped', async () => {
    const { ui, painter, host } = setup();
    ui.mount(host as unknown as HTMLElement);
    win.dispatchEvent(key('keydown', 'Enter'));
    ui.unmount();
    await flush();
    tick(ui);
    expect(painter.drawFrame).not.toHaveBeenCalled();
    expect(readArcade(ITEM)).toBeNull();
  });

  it('clicks on the view stay with the cabinet; LEAVE releases the focus', () => {
    const { ui, requestRelease, host } = setup();
    const clicks = new Map<string, (e: MouseEvent) => void>();
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el = fakeElement(tag);
        el.addEventListener = ((type: string, fn: (e: MouseEvent) => void) => {
          if (type === 'click') clicks.set(tag === 'button' ? 'leave' : `${tag}-${clicks.size}`, fn);
        }) as never;
        return el;
      },
    });
    ui.mount(host as unknown as HTMLElement);
    const click = () => ({ stopPropagation: vi.fn() }) as unknown as MouseEvent & { stopPropagation: ReturnType<typeof vi.fn> };
    // main.ts releases the focus on any click that reaches window: the
    // capture layer, the strip and LEAVE all stop it there.
    expect(clicks.size).toBe(3);
    for (const [name, handler] of clicks) {
      const event = click();
      handler(event);
      expect(event.stopPropagation, name).toHaveBeenCalled();
    }
    expect(requestRelease).toHaveBeenCalledTimes(1);
    ui.unmount();
  });
});

describe('gamepads at the cabinet', () => {
  const thwaite = new Uint8Array(readFileSync(new URL('../public/arcade/roms/thwaite.nes', import.meta.url)));

  /** A standard-mapping pad whose buttons and stick the test sets. */
  function fakePad() {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
    const pad = { connected: true, buttons, axes: [0, 0] };
    return {
      pad: pad as unknown as Gamepad,
      press: (...indices: number[]) => indices.forEach((i) => (buttons[i].pressed = true)),
      release: (...indices: number[]) => indices.forEach((i) => (buttons[i].pressed = false)),
      releaseAll: () => {
        buttons.forEach((b) => (b.pressed = false));
        pad.axes = [0, 0];
      },
      stick: (x: number, y: number) => (pad.axes = [x, y]),
    };
  }

  function setupWithPads(count: number) {
    const pads = Array.from({ length: count }, fakePad);
    // A disconnect left slot 0 empty: the pads still map to players 1 and 2.
    vi.stubGlobal('navigator', { getGamepads: () => [null, ...pads.map((p) => p.pad)] });
    const painter = recordingPainter();
    const visual: ArcadeCabinetVisualHandle = { painter, present: vi.fn(), showAttract: vi.fn() };
    const fetchRom = vi.fn(async () => thwaite);
    setArcadeRomFetcher(fetchRom);
    registerArcadeVisual(ITEM, visual, { x: 0, z: 0 });
    const ui = createArcadeCabinetUI({ itemId: ITEM, visual, requestRelease: vi.fn() });
    ui.mount(fakeElement('div') as unknown as HTMLElement);
    return { ui, painter, fetchRom, pads };
  }

  it("player 1's pad drives the menu by D-pad or stick, edge by edge; player 2's does not", () => {
    const { ui, painter, pads } = setupWithPads(2);
    pads[0].press(13); // D-pad down
    ui.update(1 / 60);
    ui.update(1 / 60); // still held: no second move
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(1);
    pads[0].releaseAll();
    ui.update(1 / 60);
    pads[0].stick(0, 0.9); // stick down
    ui.update(1 / 60);
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(2);
    pads[0].releaseAll();
    pads[1].press(13);
    ui.update(1 / 60);
    expect(painter.drawMenu.mock.lastCall?.[1]).toBe(2);
    ui.unmount();
  });

  it('A starts the game; holding Select+Start for a second returns to the menu', async () => {
    const { ui, painter, fetchRom, pads } = setupWithPads(1);
    pads[0].press(1); // A (right face button)
    ui.update(1 / 60);
    expect(fetchRom).toHaveBeenCalledWith(ARCADE_GAMES[0].romUrl);
    pads[0].releaseAll();
    await flush();
    tick(ui, 10);
    expect(painter.drawFrame).toHaveBeenCalled();

    const menuDraws = painter.drawMenu.mock.calls.length;
    pads[0].press(8, 9);
    tick(ui, 30); // half a second: still playing
    expect(painter.drawMenu.mock.calls.length).toBe(menuDraws);
    expect(readArcade(ITEM)).not.toBeNull();
    tick(ui, 35);
    expect(painter.drawMenu.mock.calls.length).toBeGreaterThan(menuDraws);
    expect(readArcade(ITEM)).toBeNull();
    ui.unmount();
  });

  it('a button lets go only when the last key or pad holding it does', async () => {
    const { ui, pads } = setupWithPads(1);
    // Your own cartridge runs on this page, so its machine's releases show it.
    for (let i = 0; i < OWN; i++) win.dispatchEvent(key('keydown', 'ArrowDown'));
    win.dispatchEvent(key('keydown', 'Enter'));
    win.dispatchEvent(key('keyup', 'ArrowDown'));
    win.dispatchEvent(key('keyup', 'Enter'));
    const input = created.find((el) => el.tag === 'input')!;
    input.files = [{ name: 'mine.nes', size: thwaite.length, arrayBuffer: async () => thwaite.slice().buffer as ArrayBuffer }];
    input.onchange!();
    await flush();
    ui.update(1 / 60);
    const release = vi.spyOn(ArcadeMachine.prototype, 'release');
    const releasedA = () => release.mock.calls.filter(([player, button]) => player === 1 && button === 'A').length;

    // X and K are both A: letting go of one keeps A held.
    win.dispatchEvent(key('keydown', 'KeyX'));
    win.dispatchEvent(key('keydown', 'KeyK'));
    win.dispatchEvent(key('keyup', 'KeyX'));
    expect(releasedA()).toBe(0);
    // The pad's A holds it too.
    pads[0].press(1);
    ui.update(1 / 60);
    win.dispatchEvent(key('keyup', 'KeyK'));
    expect(releasedA()).toBe(0);
    // Ctrl+X was the browser's: its key-up lets go of nothing.
    win.dispatchEvent(key('keydown', 'KeyX', { mod: 'ctrlKey' }));
    win.dispatchEvent(key('keyup', 'KeyX'));
    expect(releasedA()).toBe(0);
    // The last one lets go.
    pads[0].release(1);
    ui.update(1 / 60);
    expect(releasedA()).toBe(1);
    ui.unmount();
  });

  it("a shared game's pad byte keeps a button while any key or pad holds it", () => {
    const pad = fakePad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad.pad] });
    const shared: SharedView = { role: 'host', title: 'THWAITE', phase: 'playing', joinAs: null, player: 1 };
    const link: ArcadeLink = {
      shared: () => shared,
      takeError: () => null,
      host: vi.fn(),
      stop: vi.fn(),
      join: vi.fn(),
      setButtons: vi.fn(),
      setLocalPad2: vi.fn(),
      setAudio: vi.fn(),
      setUiScreen: vi.fn(),
      release: vi.fn(),
    };
    const visual: ArcadeCabinetVisualHandle = { painter: recordingPainter(), present: vi.fn(), showAttract: vi.fn() };
    const ui = createArcadeCabinetUI({ itemId: ITEM, visual, requestRelease: vi.fn(), link });
    ui.mount(fakeElement('div') as unknown as HTMLElement);
    ui.update(1 / 60); // on the shared game, not the menu
    const byte = () => {
      ui.update(1 / 60);
      return (link.setButtons as ReturnType<typeof vi.fn>).mock.lastCall?.[0];
    };

    win.dispatchEvent(key('keydown', 'KeyX'));
    win.dispatchEvent(key('keydown', 'KeyK'));
    win.dispatchEvent(key('keyup', 'KeyX'));
    expect(byte()).toBe(0b1); // K still holds A
    pad.press(1);
    win.dispatchEvent(key('keyup', 'KeyK'));
    expect(byte()).toBe(0b1); // the pad still holds A
    win.dispatchEvent(key('keydown', 'KeyX', { mod: 'ctrlKey' }));
    win.dispatchEvent(key('keyup', 'KeyX'));
    expect(byte()).toBe(0b1);
    pad.release(1);
    expect(byte()).toBe(0);
    ui.unmount();
  });

  it("a gamepad's Start that takes the free stand waits to be let go, too", () => {
    const pad = fakePad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad.pad] });
    let shared: SharedView = { role: 'watcher', title: 'THWAITE', phase: 'playing', joinAs: 2, player: null };
    const link: ArcadeLink = {
      shared: () => shared,
      takeError: () => null,
      host: vi.fn(),
      stop: vi.fn(),
      join: vi.fn(() => void (shared = { ...shared, role: 'guest', joinAs: null, player: 2 })),
      setButtons: vi.fn(),
      setLocalPad2: vi.fn(),
      setAudio: vi.fn(),
      setUiScreen: vi.fn(),
      release: vi.fn(),
    };
    const visual: ArcadeCabinetVisualHandle = { painter: recordingPainter(), present: vi.fn(), showAttract: vi.fn() };
    const ui = createArcadeCabinetUI({ itemId: ITEM, visual, seat: 1, seats: 2, requestRelease: vi.fn(), link });
    ui.mount(fakeElement('div') as unknown as HTMLElement);
    ui.update(1 / 60); // stepping up took the stand; hand it back to watch
    shared = { ...shared, role: 'watcher', joinAs: 2, player: null };
    ui.update(1 / 60);
    pad.press(9); // Start
    ui.update(1 / 60);
    expect(link.join).toHaveBeenCalled();
    ui.update(1 / 60);
    expect(link.setButtons).toHaveBeenLastCalledWith(0);
    pad.release(9);
    ui.update(1 / 60);
    pad.press(9);
    ui.update(1 / 60);
    expect(link.setButtons).toHaveBeenLastCalledWith(0b1000); // Start, now in the game
    ui.unmount();
  });

  it('picking your own cartridge from a pad asks for the keyboard', () => {
    const { ui, painter, pads } = setupWithPads(1);
    for (let i = 0; i < OWN; i++) {
      pads[0].press(13);
      ui.update(1 / 60);
      pads[0].releaseAll();
      ui.update(1 / 60);
    }
    pads[0].press(9); // Start
    ui.update(1 / 60);
    expect(created.some((el) => el.tag === 'input')).toBe(false);
    expect(painter.drawMenu.mock.lastCall?.[2]).toBe('PRESS ENTER ON THE KEYBOARD TO PICK A FILE');
    ui.unmount();
  });
});

describe('describeView (the screen-reader status line)', () => {
  it('says what the cabinet screen shows', () => {
    expect(describeView(menu(0))).toContain(`${ARCADE_GAMES[0].title}, 1 of ${MENU.length}.`);
    expect(describeView({ screen: 'menu', cursor: OWN, status: 'NOT AN NES ROM' })).toMatch(/^NOT AN NES ROM\. INSERT YOUR OWN CARTRIDGE/);
    expect(describeView({ screen: 'credits', page: 0 })).toContain(ARCADE_GAMES[0].author);
    expect(describeView({ screen: 'loading', title: 'THWAITE' })).toBe('Loading THWAITE.');
    expect(describeView({ screen: 'playing', title: 'THWAITE' })).toMatch(/^Playing THWAITE\./);
  });

  it('says who plays a shared game, and how to stop', () => {
    const shared = (over: Partial<SharedView>): ArcadeView => ({
      screen: 'shared', role: 'host', title: 'THWAITE', phase: 'playing', joinAs: null, player: 1, ...over,
    });
    expect(describeView(shared({}))).toBe('Playing THWAITE as player 1. Backspace ends the game, Escape leaves the cabinet.');
    expect(describeView(shared({ role: 'guest', player: 2 }))).toMatch(/^Playing THWAITE as player 2\. Backspace stops playing/);
    expect(describeView(shared({ role: 'watcher', player: null }))).toBe('Watching THWAITE. Escape leaves the cabinet.');
    expect(describeView(shared({ role: 'watcher', player: null, joinAs: 1 })))
      .toBe('Watching THWAITE. Enter plays player 1, Escape leaves the cabinet.');
    expect(describeView(shared({ phase: 'loading' }))).toBe('Loading THWAITE.');
    expect(describeView(shared({ role: 'watcher', phase: 'joining', player: null }))).toBe('Joining THWAITE.');
    expect(describeView(shared({ role: 'watcher', phase: 'ended', player: null }))).toMatch(/player 1 left/);
  });
});
