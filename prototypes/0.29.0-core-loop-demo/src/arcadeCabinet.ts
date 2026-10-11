/**
 * 🕹️ The arcade cabinet's focus UI: step up to the cabinet and the game menu
 * comes up ON the cabinet's own screen — no popup. The keyboard (or a
 * gamepad) drives the menu, then the game.
 *
 *   MENU     ↑/↓ choose · Enter or X play · the last two rows are
 *            INSERT YOUR OWN CARTRIDGE (a local .nes file, never shared)
 *            and CREDITS & LICENSES
 *   PLAYING  the NES pad; Backspace (or Select+Start held on a gamepad)
 *            returns to the menu
 *   Esc      leaves the cabinet, as at every device
 *
 * The game runs only on this player's machine: everyone else in the room
 * sees the cabinet's attract card (arcadeScreen.drawAttract). Keys are taken
 * in the capture phase while focused (freeFlightStick's idiom), so WASD
 * steers the game instead of walking away from the cabinet; Esc and Tab
 * pass through untouched.
 */

import { ARCADE_GAMES, LICENSE_LABEL, parseInesHeader, type ArcadeGame } from './arcadeLibrary';
import { ArcadeMachine, type NesButton, type NesPlayer } from './arcadeMachine';
import { CREDIT_PAGES, type ArcadeMenuRow } from './arcadeScreen';
import { ArcadeSpeaker } from './arcadeSpeaker';
import type { ArcadeCabinetVisualHandle, DeviceUI } from './devices';
import { isFormFieldTarget } from './typingFocus';

// ── Pure menu model (tested) ─────────────────────────────────────────────────

export type MenuEntry =
  | { kind: 'game'; game: ArcadeGame }
  | { kind: 'own' }
  | { kind: 'credits' };

export const MENU: readonly MenuEntry[] = [
  ...ARCADE_GAMES.map((game) => ({ kind: 'game' as const, game })),
  { kind: 'own' },
  { kind: 'credits' },
];

export function menuRows(): ArcadeMenuRow[] {
  return MENU.map((entry) => {
    if (entry.kind === 'game') {
      return { label: entry.game.title, detail: [entry.game.blurb, entry.game.controls] };
    }
    if (entry.kind === 'own') {
      return {
        label: 'INSERT YOUR OWN CARTRIDGE',
        detail: ['PICK A .NES FILE FROM THIS DEVICE.', 'IT STAYS HERE. NOTHING IS UPLOADED.'],
      };
    }
    return { label: 'CREDITS & LICENSES', detail: ['WHO MADE THESE GAMES, AND', 'THE LICENSES THAT LET US SHARE THEM.'] };
  });
}

export type ArcadeView =
  | { screen: 'menu'; cursor: number; status: string | null }
  | { screen: 'credits'; page: number }
  | { screen: 'loading'; title: string }
  | { screen: 'playing'; title: string };

export type MenuAction =
  | { kind: 'none' }
  | { kind: 'start'; game: ArcadeGame }
  | { kind: 'pickFile' };

/** A button pressed while the menu or credits are up. */
export function menuInput(view: ArcadeView, button: NesButton): { view: ArcadeView; action: MenuAction } {
  const none = { kind: 'none' } as const;
  if (view.screen === 'menu') {
    const n = MENU.length;
    if (button === 'UP') return { view: { ...view, cursor: (view.cursor + n - 1) % n, status: null }, action: none };
    if (button === 'DOWN' || button === 'SELECT') {
      return { view: { ...view, cursor: (view.cursor + 1) % n, status: null }, action: none };
    }
    if (button === 'START' || button === 'A') {
      const entry = MENU[view.cursor];
      if (entry.kind === 'game') return { view, action: { kind: 'start', game: entry.game } };
      if (entry.kind === 'own') return { view, action: { kind: 'pickFile' } };
      return { view: { screen: 'credits', page: 0 }, action: none };
    }
    return { view, action: none };
  }
  if (view.screen === 'credits') {
    if (button === 'LEFT' || button === 'UP') {
      return { view: { screen: 'credits', page: (view.page + CREDIT_PAGES - 1) % CREDIT_PAGES }, action: none };
    }
    if (button === 'RIGHT' || button === 'DOWN') {
      return { view: { screen: 'credits', page: (view.page + 1) % CREDIT_PAGES }, action: none };
    }
    if (button === 'START' || button === 'A' || button === 'B') {
      return { view: { screen: 'menu', cursor: MENU.findIndex((e) => e.kind === 'credits'), status: null }, action: none };
    }
  }
  return { view, action: none };
}

/**
 * The cabinet screen in words, for the strip's screen-reader status line:
 * the menu and credits are painted into a 3D texture, which assistive tech
 * cannot read.
 */
export function describeView(view: ArcadeView): string {
  if (view.screen === 'menu') {
    const row = menuRows()[view.cursor];
    const parts = [`${row.label}, ${view.cursor + 1} of ${MENU.length}.`, ...(row.detail ?? [])];
    if (view.status) parts.unshift(`${view.status}.`);
    return parts.join(' ');
  }
  if (view.screen === 'credits') {
    const game = ARCADE_GAMES[view.page];
    return game
      ? `Credits ${view.page + 1} of ${CREDIT_PAGES}: ${game.title} by ${game.author}, ${game.year}. License ${LICENSE_LABEL[game.license]}. Source ${game.sourceUrl}.`
      : `Credits ${view.page + 1} of ${CREDIT_PAGES}: emulator jsnes, Apache-2.0. Your own cartridge stays on your device.`;
  }
  if (view.screen === 'loading') return `Loading ${view.title}.`;
  return `Playing ${view.title}. Backspace returns to the menu, Escape leaves the cabinet.`;
}

/** Keyboard → NES pad (player 1). Arrows or WASD; X/K = A, Z/J = B. */
export function keyToButton(code: string): NesButton | null {
  switch (code) {
    case 'ArrowUp': case 'KeyW': return 'UP';
    case 'ArrowDown': case 'KeyS': return 'DOWN';
    case 'ArrowLeft': case 'KeyA': return 'LEFT';
    case 'ArrowRight': case 'KeyD': return 'RIGHT';
    case 'KeyX': case 'KeyK': return 'A';
    case 'KeyZ': case 'KeyJ': return 'B';
    case 'Enter': case 'NumpadEnter': return 'START';
    case 'ShiftLeft': case 'ShiftRight': return 'SELECT';
    default: return null;
  }
}

/** Standard-mapping gamepad buttons → NES pad. The NES's A is on the right,
 *  B on the left: bottom face button is B, right face button is A. */
const PAD_BUTTONS: ReadonlyArray<[number, NesButton]> = [
  [0, 'B'], [2, 'B'], [1, 'A'], [3, 'A'],
  [8, 'SELECT'], [9, 'START'],
  [12, 'UP'], [13, 'DOWN'], [14, 'LEFT'], [15, 'RIGHT'],
];
/** Hold Select+Start this long on a gamepad to get back to the menu. */
const PAD_MENU_HOLD_S = 1;
/** Capture-phase listener options, as an object: Node's EventTarget (the
 *  tests) fails to match a bare `true` when the listener is removed. */
const CAPTURE: AddEventListenerOptions = { capture: true };

/**
 * The first two connected gamepads, in order: player 1, then player 2. The
 * browser's list keeps empty slots after a disconnect, so a lone pad can sit
 * at index 1 or higher. A Permissions Policy that blocks gamepads makes
 * getGamepads() throw; that reads as no pads (freeFlightStick's rule).
 */
export function connectedPads(): Gamepad[] {
  try {
    const all = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pads: Gamepad[] = [];
    for (const pad of all ?? []) if (pad?.connected && pads.push(pad) === 2) break;
    return pads;
  } catch {
    return [];
  }
}

/** Upper-cased, printable, short: a file name fit for the cabinet screen. */
export function cartridgeTitle(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').replace(/[^\x20-\x7e]/g, '').trim().toUpperCase();
  return (stem || 'YOUR CARTRIDGE').slice(0, 24);
}

// ── The focus UI ─────────────────────────────────────────────────────────────

export interface ArcadeCabinetUIDeps {
  visual: ArcadeCabinetVisualHandle | undefined;
  /** Leave the cabinet (the strip's LEAVE button). */
  requestRelease: () => void;
  /** Fetch a bundled ROM (stubbed in tests). */
  fetchRom?: (url: string) => Promise<Uint8Array>;
}

const STRIP_MENU = '↑↓ CHOOSE · ENTER PLAY · ESC LEAVE';
const STRIP_PLAY = 'ARROWS/WASD PAD · X = A · Z = B · ENTER START · SHIFT SELECT · ⌫ MENU · ESC LEAVE';

async function defaultFetchRom(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function createArcadeCabinetUI(deps: ArcadeCabinetUIDeps): DeviceUI {
  const painter = deps.visual?.painter;
  const fetchRom = deps.fetchRom ?? defaultFetchRom;

  let view: ArcadeView = { screen: 'menu', cursor: 0, status: null };
  /** The menu row last selected, so leaving a game lands back on it. */
  let menuCursor = 0;
  let speaker: ArcadeSpeaker | null = null;
  let machine: ArcadeMachine | null = null;
  /** Bumped on every load and on unmount: a late ROM fetch checks it. */
  let loadSeq = 0;
  let mounted = false;
  let blinkT = 0;
  let blinkOn = true;
  let dirty = true;
  let padHold = 0;
  /** Per gamepad index, the NES buttons held last poll (edge detection). */
  const padHeld: Array<Set<NesButton>> = [new Set(), new Set()];
  let fileInput: HTMLInputElement | null = null;

  let capture: HTMLDivElement | null = null;
  let strip: HTMLDivElement | null = null;
  let stripText: HTMLSpanElement | null = null;
  /** Visually hidden live region: the screen's content, read aloud. */
  let spoken: HTMLSpanElement | null = null;

  const present = () => deps.visual?.present();

  const setView = (next: ArcadeView) => {
    view = next;
    if (next.screen === 'menu') menuCursor = next.cursor;
    dirty = true;
    if (stripText) stripText.textContent = next.screen === 'playing' ? STRIP_PLAY : STRIP_MENU;
    if (spoken) {
      const words = describeView(next);
      if (spoken.textContent !== words) spoken.textContent = words;
    }
  };

  const paint = () => {
    if (!painter) return;
    if (view.screen === 'menu') painter.drawMenu(menuRows(), view.cursor, view.status, blinkOn);
    else if (view.screen === 'credits') painter.drawCredits(view.page);
    else if (view.screen === 'loading') painter.drawCard(view.title, 'LOADING…');
    else return; // playing: the frames paint themselves
    present();
    dirty = false;
  };

  const backToMenu = (status: string | null = null) => {
    loadSeq++;
    machine?.stop();
    speaker?.clear();
    padHold = 0;
    setView({ screen: 'menu', cursor: menuCursor, status });
  };

  const play = (bytes: Uint8Array, title: string) => {
    const header = parseInesHeader(bytes);
    if (!header.ok) return backToMenu(header.reason);
    if (!machine) {
      machine = new ArcadeMachine({ sampleRate: speaker?.sampleRate, onAudioSample: speaker?.push });
    }
    const loaded = machine.load(bytes);
    if (!loaded.ok) return backToMenu(loaded.reason);
    setView({ screen: 'playing', title });
  };

  const startGame = (game: ArcadeGame) => {
    const seq = ++loadSeq;
    setView({ screen: 'loading', title: game.title });
    fetchRom(game.romUrl).then(
      (bytes) => {
        if (seq !== loadSeq || !mounted) return;
        play(bytes, game.title);
      },
      () => {
        if (seq !== loadSeq || !mounted) return;
        backToMenu('COULD NOT LOAD THAT GAME');
      },
    );
  };

  /** Runs inside the key handler: a file picker needs the user's gesture. */
  const pickFile = () => {
    fileInput ??= document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.nes';
    fileInput.value = '';
    fileInput.onchange = () => {
      const file = fileInput?.files?.[0];
      if (!file || !mounted) return;
      if (file.size > 4 * 1024 * 1024) return backToMenu('FILE TOO LARGE');
      const seq = ++loadSeq;
      const title = cartridgeTitle(file.name);
      setView({ screen: 'loading', title });
      file.arrayBuffer().then(
        (buf) => {
          if (seq !== loadSeq || !mounted) return;
          play(new Uint8Array(buf), title);
        },
        () => {
          if (seq !== loadSeq || !mounted) return;
          backToMenu('COULD NOT READ THAT FILE');
        },
      );
    };
    fileInput.click();
  };

  /** A press while the menu/credits are up; `gesture` = from a key event. */
  const menuPress = (button: NesButton, gesture: boolean) => {
    const { view: next, action } = menuInput(view, button);
    if (next !== view) setView(next);
    if (action.kind === 'start') startGame(action.game);
    else if (action.kind === 'pickFile') {
      if (gesture) pickFile();
      else setView({ ...(view as Extract<ArcadeView, { screen: 'menu' }>), status: 'PRESS ENTER ON THE KEYBOARD TO PICK A FILE' });
    }
  };

  const buttonDown = (player: NesPlayer, button: NesButton, gesture: boolean) => {
    if (view.screen === 'playing') machine?.press(player, button);
    else if (player === 1 && view.screen !== 'loading') menuPress(button, gesture);
  };
  const buttonUp = (player: NesPlayer, button: NesButton) => {
    if (view.screen === 'playing') machine?.release(player, button);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') return; // the focus controller's / the phone's
    if (isFormFieldTarget(e.target as HTMLElement | null)) return;
    if (e.code === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (view.screen !== 'menu') backToMenu();
      return;
    }
    const button = keyToButton(e.code);
    if (!button) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    speaker?.resume();
    // Held keys auto-repeat: let that scroll the menu, never re-press the pad.
    if (e.repeat && view.screen === 'playing') return;
    buttonDown(1, button, true);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const button = keyToButton(e.code);
    if (button) buttonUp(1, button);
  };
  const onBlur = () => machine?.releaseAll();

  const pollPads = (dt: number) => {
    const pads = connectedPads();
    for (let i = 0; i < 2; i++) {
      const pad = pads[i];
      const now = new Set<NesButton>();
      if (pad?.connected) {
        for (const [index, button] of PAD_BUTTONS) if (pad.buttons[index]?.pressed) now.add(button);
        const [ax, ay] = [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
        if (ax < -0.5) now.add('LEFT');
        if (ax > 0.5) now.add('RIGHT');
        if (ay < -0.5) now.add('UP');
        if (ay > 0.5) now.add('DOWN');
      }
      const player = (i + 1) as NesPlayer;
      const before = padHeld[i];
      for (const button of now) {
        if (before.has(button)) continue;
        speaker?.resume(); // browsers that count a pad press as a gesture
        buttonDown(player, button, false);
      }
      for (const button of before) if (!now.has(button)) buttonUp(player, button);
      padHeld[i] = now;
    }
    const combo = padHeld[0].has('SELECT') && padHeld[0].has('START');
    padHold = combo && view.screen === 'playing' ? padHold + dt : 0;
    if (padHold >= PAD_MENU_HOLD_S) backToMenu();
  };

  return {
    mount(host: HTMLElement): void {
      mounted = true;
      speaker = new ArcadeSpeaker();
      machine = null;
      padHeld[0] = new Set();
      padHeld[1] = new Set();
      setView({ screen: 'menu', cursor: menuCursor, status: deps.visual ? null : 'CABINET SCREEN NOT FOUND' });

      // Clicks on the view stay with the cabinet (a stray click would
      // otherwise release the focus mid-game); LEAVE and Esc leave.
      capture = document.createElement('div');
      capture.id = 'arcade-capture';
      capture.style.cssText = 'position:absolute; inset:0; pointer-events:auto; background:transparent;';
      // main.ts releases the focus on any window click: keep these here. A
      // click is also a gesture, so it lets a gamepad player switch sound on.
      const keepClick = (e: MouseEvent) => {
        e.stopPropagation();
        speaker?.resume();
      };
      capture.addEventListener('click', keepClick);
      strip = document.createElement('div');
      strip.id = 'arcade-strip';
      strip.style.cssText = `
        position:absolute; left:50%; bottom:16px; transform:translateX(-50%);
        display:flex; gap:14px; align-items:center; max-width:calc(100vw - 32px);
        background:rgba(4, 8, 22, 0.88); border:1px solid rgba(124, 255, 176, 0.28);
        border-radius:10px; box-shadow:0 8px 40px rgba(0,0,0,0.7); padding:8px 14px;
        color:#7CFFB0; font:12px 'SF Mono','Monaco','Consolas',monospace;
        box-sizing:border-box; pointer-events:auto;`;
      stripText = document.createElement('span');
      stripText.textContent = STRIP_MENU;
      const leave = document.createElement('button');
      leave.textContent = 'LEAVE';
      leave.style.cssText = `
        background:transparent; color:#FFC860; border:1px solid rgba(255,200,96,0.5);
        border-radius:6px; padding:4px 10px; font:inherit; cursor:pointer;`;
      strip.addEventListener('click', keepClick);
      leave.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.requestRelease();
      });
      spoken = document.createElement('span');
      spoken.setAttribute('role', 'status');
      spoken.setAttribute('aria-live', 'polite');
      spoken.style.cssText = `
        position:absolute; width:1px; height:1px; overflow:hidden;
        clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap;`;
      spoken.textContent = describeView(view);
      strip.append(stripText, leave, spoken);
      host.append(capture, strip);

      window.addEventListener('keydown', onKeyDown, CAPTURE);
      window.addEventListener('keyup', onKeyUp, CAPTURE);
      window.addEventListener('blur', onBlur);
      paint();
    },

    unmount(): void {
      mounted = false;
      loadSeq++;
      window.removeEventListener('keydown', onKeyDown, CAPTURE);
      window.removeEventListener('keyup', onKeyUp, CAPTURE);
      window.removeEventListener('blur', onBlur);
      machine?.stop();
      machine = null;
      speaker?.close();
      speaker = null;
      capture?.remove();
      strip?.remove();
      capture = strip = stripText = spoken = null;
      if (fileInput) fileInput.onchange = null;
      deps.visual?.showAttract();
    },

    update(dt: number): void {
      if (!mounted) return;
      pollPads(dt);
      if (view.screen === 'playing' && machine) {
        let frames = 0;
        try {
          frames = machine.step(dt);
        } catch {
          backToMenu('THE GAME CRASHED');
        }
        const frame = machine.frameBuffer();
        if (frames > 0 && frame && painter) {
          painter.drawFrame(frame);
          present();
        }
        speaker?.flush();
        return;
      }
      blinkT += dt;
      if (blinkT >= 0.4) {
        blinkT = 0;
        blinkOn = !blinkOn;
        if (view.screen === 'menu') dirty = true;
      }
      if (dirty) paint();
    },
  };
}
