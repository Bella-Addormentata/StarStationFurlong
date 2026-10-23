/**
 * 🕹️ The arcade cabinet's focus UI for a BUILT-IN game: step up to the
 * cabinet and its one game — the owner's pick (arcadeDoc) — comes up ON the
 * cabinet's own screen, no popup. Press Enter (or Start) and it plays.
 *
 *   MENU     the cabinet's game, then CREDITS & LICENSES · ↑/↓ choose ·
 *            Enter or X play
 *   PLAYING  the NES pad; Backspace (or Select+Start held on a gamepad)
 *            ends the game and returns to the menu
 *   ⚙️       the strip's SETTINGS button: what the owner set (World swaps
 *            in arcadeUI's SETTINGS view)
 *   Esc      leaves the cabinet, as at every device
 *
 * The game is SHARED (arcadeNesSession.ts): everyone in the room runs it
 * from this player's button presses and sees it on the cabinet. At a
 * two-player cabinet, whoever steps up to the other stand plays player 2.
 * Stepping up to a cabinet whose game is already running watches it, or
 * joins it from the free stand (hand player 2 back with Backspace, take it
 * again with Enter). Players never pick the game: when the owner changes
 * it, World rebuilds this UI for the new one (onGameChanged).
 *
 * Keys are taken in the capture phase while focused (freeFlightStick's
 * idiom), so WASD steers the game instead of walking away from the cabinet;
 * Esc and Tab pass through untouched.
 */

import { ARCADE_GAMES, LICENSE_LABEL, type CabinetGame } from './arcadeLibrary';
import type { NesButton, NesPlayer } from './arcadeMachine';
import { padByte } from './arcadeNet';
import { CREDIT_PAGES, type ArcadeMenuRow } from './arcadeScreen';
import { linkArcade, type ArcadeLink, type SharedView } from './arcadeNesSession';
import { ArcadeSpeaker } from './arcadeSpeaker';
import type { ArcadeCabinetVisualHandle, DeviceUI } from './devices';
import { isFormFieldTarget } from './typingFocus';

// ── Pure menu model (tested) ─────────────────────────────────────────────────

export type MenuEntry =
  | { kind: 'game'; game: CabinetGame }
  | { kind: 'credits' };

/** The cabinet's menu: its one game, then the credits — the bundled ROMs'
 *  licences, which a cabinet's own game (the app's code) has no page in. */
export function menuFor(game: CabinetGame | null): MenuEntry[] {
  if (!game) return [{ kind: 'credits' }];
  return ARCADE_GAMES.some((g) => g.id === game.id) ? [{ kind: 'game', game }, { kind: 'credits' }] : [{ kind: 'game', game }];
}

export function menuRows(menu: readonly MenuEntry[]): ArcadeMenuRow[] {
  return menu.map((entry) => {
    if (entry.kind === 'game') {
      return { label: entry.game.title, detail: [entry.game.blurb, entry.game.controls] };
    }
    return { label: 'CREDITS & LICENSES', detail: ['WHO MADE THIS GAME, AND', 'THE LICENSE THAT LETS US SHARE IT.'] };
  });
}

/** The credits page a menu opens on: its game's, else the closing page. */
function firstCreditPage(menu: readonly MenuEntry[]): number {
  const entry = menu.find((e) => e.kind === 'game');
  const page = entry?.kind === 'game' ? ARCADE_GAMES.findIndex((g) => g.id === entry.game.id) : -1;
  return page >= 0 ? page : CREDIT_PAGES - 1;
}

export type ArcadeView =
  | { screen: 'menu'; cursor: number; status: string | null }
  | { screen: 'credits'; page: number }
  /** The shared game: hosting it, playing player 2, or watching. */
  | ({ screen: 'shared' } & SharedView);

export type MenuAction =
  | { kind: 'none' }
  | { kind: 'start'; game: CabinetGame };

/** A button pressed while the menu or credits are up. */
export function menuInput(view: ArcadeView, button: NesButton, menu: readonly MenuEntry[]): { view: ArcadeView; action: MenuAction } {
  const none = { kind: 'none' } as const;
  if (view.screen === 'menu') {
    const n = menu.length;
    if (button === 'UP') return { view: { ...view, cursor: (view.cursor + n - 1) % n, status: null }, action: none };
    if (button === 'DOWN' || button === 'SELECT') {
      return { view: { ...view, cursor: (view.cursor + 1) % n, status: null }, action: none };
    }
    if (button === 'START' || button === 'A') {
      const entry = menu[view.cursor];
      if (entry?.kind === 'game') return { view, action: { kind: 'start', game: entry.game } };
      return { view: { screen: 'credits', page: firstCreditPage(menu) }, action: none };
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
      return { view: { screen: 'menu', cursor: menu.findIndex((e) => e.kind === 'credits'), status: null }, action: none };
    }
  }
  return { view, action: none };
}

/**
 * The cabinet screen in words, for the strip's screen-reader status line:
 * the menu and credits are painted into a 3D texture, which assistive tech
 * cannot read.
 */
export function describeView(view: ArcadeView, menu: readonly MenuEntry[]): string {
  if (view.screen === 'menu') {
    const row = menuRows(menu)[view.cursor];
    const parts = row ? [`${row.label}, ${view.cursor + 1} of ${menu.length}.`, ...(row.detail ?? [])] : [];
    if (view.status) parts.unshift(`${view.status}.`);
    return parts.join(' ');
  }
  if (view.screen === 'credits') {
    const game = ARCADE_GAMES[view.page];
    return game
      ? `Credits ${view.page + 1} of ${CREDIT_PAGES}: ${game.title} by ${game.author}, ${game.year}. License ${LICENSE_LABEL[game.license]}. Source ${game.sourceUrl}.`
      : `Credits ${view.page + 1} of ${CREDIT_PAGES}: emulator jsnes, Apache-2.0. The owner picks the cabinet's game in its settings.`;
  }
  if (view.phase === 'ended') return `${view.title}: player 1 left. Escape leaves the cabinet.`;
  if (view.phase === 'loading') return `Loading ${view.title}.`;
  if (view.phase === 'joining') return `Joining ${view.title}.`;
  if (view.role === 'watcher') {
    return view.joinAs
      ? `Watching ${view.title}. Enter plays player ${view.joinAs}, Escape leaves the cabinet.`
      : `Watching ${view.title}. Escape leaves the cabinet.`;
  }
  const back = view.role === 'host' ? 'Backspace ends the game' : 'Backspace stops playing';
  return `Playing ${view.title} as player ${view.player}. ${back}, Escape leaves the cabinet.`;
}

/** Keyboard → NES pad (player 1). WASD with N = B and M = A under the
 *  right hand (J and K above them work too), or the arrows with Z = B and
 *  X = A under the left. A real pad's order: B on the left, A on the right. */
export function keyToButton(code: string): NesButton | null {
  switch (code) {
    case 'ArrowUp': case 'KeyW': return 'UP';
    case 'ArrowDown': case 'KeyS': return 'DOWN';
    case 'ArrowLeft': case 'KeyA': return 'LEFT';
    case 'ArrowRight': case 'KeyD': return 'RIGHT';
    case 'KeyM': case 'KeyK': case 'KeyX': return 'A';
    case 'KeyN': case 'KeyJ': case 'KeyZ': return 'B';
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

// ── The focus UI ─────────────────────────────────────────────────────────────

export interface ArcadeCabinetUIDeps {
  /** The cabinet's furniture id (its shared game's doc key). */
  itemId: string;
  visual: ArcadeCabinetVisualHandle | undefined;
  /** The built-in game on the cabinet now (arcadeDoc, the owner's pick): a
   *  bundled ROM or the cabinet's own game, or null when it has none or the
   *  owner's own. Read every update; default: the library's first game. */
  game?: () => CabinetGame | null;
  /** The cabinet's game is no longer the one this UI was built for: World
   *  builds the UI for the new one in its place. */
  onGameChanged?: () => void;
  /** The strip's ⚙️ SETTINGS button (absent: no button). */
  openSettings?: () => void;
  /** A game started here: the cabinet's tally counts it. */
  onPlay?: () => void;
  /** The stand this player stepped up to (0 = player 1's) and how many the
   *  cabinet has (1, or 2 for the two-player cabinet). */
  seat?: 0 | 1;
  seats?: 1 | 2;
  /** Leave the cabinet (the strip's LEAVE button). */
  requestRelease: () => void;
  /** The shared-game session: the NES games' unless given (tests stub it). */
  link?: ArcadeLink;
  /** Or open one when the UI mounts (the cabinet's own games bring theirs):
   *  a link takes the cabinet's screen, so not before the UI is up. */
  openLink?: () => ArcadeLink;
  /** The strip's key line while playing (default: the NES pad's). */
  keys?: string;
  /** The menu's status line when it opens (why there's nothing to play). */
  notice?: string;
}

const STRIP_MENU = 'ENTER PLAY · ↑↓ CHOOSE · ESC LEAVE';
const STRIP_KEYS = 'WASD + N M  OR  ARROWS + Z X · ENTER START · SHIFT SELECT';

function stripFor(view: ArcadeView, keys = STRIP_KEYS): string {
  if (view.screen !== 'shared') return STRIP_MENU;
  if (view.phase === 'ended') return 'PLAYER 1 LEFT · ESC LEAVE';
  if (view.phase === 'loading') return 'LOADING… · ESC LEAVE';
  if (view.phase === 'joining') return 'JOINING THE GAME… · ESC LEAVE';
  if (view.role === 'watcher') return view.joinAs ? `WATCHING · ENTER PLAYS PLAYER ${view.joinAs} · ESC LEAVE` : 'WATCHING · ESC LEAVE';
  const back = view.role === 'host' ? '⌫ END GAME' : '⌫ STOP PLAYING';
  return `PLAYER ${view.player} · ${keys} · ${back} · ESC LEAVE`;
}

const sameShared = (a: SharedView, b: ArcadeView): boolean =>
  b.screen === 'shared' && a.role === b.role && a.title === b.title && a.phase === b.phase
  && a.player === b.player && a.joinAs === b.joinAs;

export function createArcadeCabinetUI(deps: ArcadeCabinetUIDeps): DeviceUI {
  const painter = deps.visual?.painter;
  const seat = deps.seat ?? 0;
  const seats = deps.seats ?? 1;
  const currentGame = deps.game ?? (() => ARCADE_GAMES[0] ?? null);
  /** The game this UI was built for; the menu is its game and the credits. */
  const game = currentGame();
  const menu = menuFor(game);

  let view: ArcadeView = { screen: 'menu', cursor: 0, status: null };
  /** The menu row last selected, so leaving a game lands back on it. */
  let menuCursor = 0;
  let link: ArcadeLink | null = null;
  let speaker: ArcadeSpeaker | null = null;
  let mounted = false;
  /** Step up to a two-player cabinet's free stand and you play player 2;
   *  after handing it back you watch until you press Start. */
  let autoJoin = true;
  let blinkT = 0;
  let blinkOn = true;
  let dirty = true;
  let padHold = 0;
  /** Keys held down that press player 1's pad, by key (X and K are both A). */
  const keysDown = new Map<string, NesButton>();
  /** Per gamepad index, the NES buttons held last poll (edge detection). */
  const padHeld: Array<Set<NesButton>> = [new Set(), new Set()];
  /** Player 1's buttons whose press worked the cabinet (the menu, or Start
   *  taking the free stand): the game doesn't get them until they let go,
   *  so taking player 2 doesn't also pause the game. */
  const usedByCabinet = new Set<NesButton>();

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
    if (stripText) stripText.textContent = stripFor(next, deps.keys);
    if (spoken) {
      const words = describeView(next, menu);
      if (spoken.textContent !== words) spoken.textContent = words;
    }
    // The UI's own screens are painted here; the shared game is painted by
    // the session, which this page also hears.
    link?.setUiScreen(next.screen !== 'shared');
    link?.setAudio(speaker?.push ?? null, speaker?.sampleRate ?? 48000);
  };

  const paint = () => {
    if (!painter) return;
    if (view.screen === 'menu') painter.drawMenu(menuRows(menu), view.cursor, view.status, blinkOn);
    else if (view.screen === 'credits') painter.drawCredits(view.page);
    else return; // the shared game: the session paints it
    present();
    dirty = false;
  };

  const backToMenu = (status: string | null = null) => {
    speaker?.clear();
    padHold = 0;
    setView({ screen: 'menu', cursor: menuCursor, status });
  };

  /** Backspace or Select+Start in a shared game: the host ends it, the
   *  guest hands player 2 back and watches. */
  const leaveShared = () => {
    if (view.screen !== 'shared' || view.role === 'watcher') return;
    const wasHost = view.role === 'host';
    if (!wasHost) autoJoin = false;
    link?.stop();
    speaker?.clear();
    padHold = 0;
    if (wasHost) backToMenu();
  };

  const startShared = (game: CabinetGame) => {
    if (!link) return;
    link.host(game);
    const shared = link.shared();
    if (shared) {
      setView({ screen: 'shared', ...shared });
      deps.onPlay?.();
    }
  };

  /** A press while the menu/credits are up. */
  const menuPress = (button: NesButton) => {
    const { view: next, action } = menuInput(view, button, menu);
    if (next !== view) setView(next);
    if (action.kind === 'start') startShared(action.game);
  };

  const buttonDown = (player: NesPlayer, button: NesButton) => {
    if (view.screen === 'menu' || view.screen === 'credits') {
      if (player === 1) {
        usedByCabinet.add(button);
        menuPress(button);
      }
    } else if (view.joinAs && player === 1 && button === 'START') {
      usedByCabinet.add(button);
      autoJoin = true;
      link?.join();
    }
    // the shared game, playing: the pads are read as bytes every update
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') return; // the focus controller's / the phone's
    if (e.ctrlKey || e.metaKey || e.altKey) return; // the browser's shortcuts (Shift is Select)
    const target = e.target as HTMLElement | null;
    if (isFormFieldTarget(target)) return;
    // A focused button (LEAVE, reached by keyboard or a screen reader) keeps Enter.
    if (target?.tagName === 'BUTTON' && keyToButton(e.code) === 'START') return;
    if (e.code === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (view.screen === 'shared') leaveShared();
      else if (view.screen === 'credits') backToMenu();
      return;
    }
    const button = keyToButton(e.code);
    if (!button) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    speaker?.resume();
    keysDown.set(e.code, button);
    // Held keys auto-repeat: let that scroll the menu, never re-press the pad.
    if (e.repeat && view.screen !== 'menu' && view.screen !== 'credits') return;
    buttonDown(1, button);
  };
  /** A key whose press the cabinet never took (Ctrl+X) lets go of nothing;
   *  the shared game reads the pad byte, which keeps a button any other key
   *  or pad still holds. */
  const onKeyUp = (e: KeyboardEvent) => {
    const button = keysDown.get(e.code);
    keysDown.delete(e.code);
    if (button && ![...keysDown.values()].includes(button) && !padHeld[0].has(button)) usedByCabinet.delete(button);
  };
  const onBlur = () => {
    keysDown.clear();
    usedByCabinet.clear();
  };

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
      padHeld[i] = now;
      for (const button of now) {
        if (before.has(button)) continue;
        speaker?.resume(); // browsers that count a pad press as a gesture
        buttonDown(player, button);
      }
    }
    const combo = padHeld[0].has('SELECT') && padHeld[0].has('START');
    const inGame = view.screen === 'shared' && view.role !== 'watcher';
    padHold = combo && inGame ? padHold + dt : 0;
    if (padHold >= PAD_MENU_HOLD_S) leaveShared();
  };

  /** Follow the shared game on the cabinet: one starting, changing hands,
   *  ending, or someone else's already running when this page stepped up. */
  const followShared = () => {
    if (!link) return;
    const shared = link.shared();
    if (shared?.joinAs && autoJoin) link.join(); // the free stand plays the other player
    if (view.screen === 'shared') {
      if (!shared) {
        const left = view.phase === 'ended' ? 'PLAYER 1 LEFT' : null;
        backToMenu(link.takeError() ?? left);
      } else if (!sameShared(shared, view)) {
        setView({ screen: 'shared', ...shared });
      }
    } else if (shared) {
      speaker?.clear();
      setView({ screen: 'shared', ...shared });
    } else if (!shared) {
      const error = link.takeError();
      if (error && view.screen === 'menu') setView({ ...view, status: error });
    }
  };

  return {
    mount(host: HTMLElement): void {
      mounted = true;
      speaker = new ArcadeSpeaker();
      keysDown.clear();
      usedByCabinet.clear();
      padHeld[0] = new Set();
      padHeld[1] = new Set();
      link = deps.link ?? deps.openLink?.() ?? linkArcade(deps.itemId, seat, seats);
      autoJoin = true;
      setView({ screen: 'menu', cursor: menuCursor, status: deps.visual ? deps.notice ?? null : 'CABINET SCREEN NOT FOUND' });

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
      stripText.textContent = stripFor(view, deps.keys);
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
      // ⚙️ What the owner set, for anyone to read (the cabinet front's gear
      // opens the same view).
      let settings: HTMLButtonElement | null = null;
      if (deps.openSettings) {
        settings = document.createElement('button');
        settings.textContent = '⚙️ SETTINGS';
        settings.style.cssText = leave.style.cssText;
        const openSettings = deps.openSettings;
        settings.addEventListener('click', (e) => {
          e.stopPropagation();
          openSettings();
        });
      }
      spoken = document.createElement('span');
      spoken.setAttribute('role', 'status');
      spoken.setAttribute('aria-live', 'polite');
      spoken.style.cssText = `
        position:absolute; width:1px; height:1px; overflow:hidden;
        clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap;`;
      spoken.textContent = describeView(view, menu);
      strip.append(...[stripText, settings, leave, spoken].filter((el): el is HTMLElement => el !== null));
      host.append(capture, strip);

      window.addEventListener('keydown', onKeyDown, CAPTURE);
      window.addEventListener('keyup', onKeyUp, CAPTURE);
      window.addEventListener('blur', onBlur);
      followShared();
      paint();
    },

    unmount(): void {
      mounted = false;
      window.removeEventListener('keydown', onKeyDown, CAPTURE);
      window.removeEventListener('keyup', onKeyUp, CAPTURE);
      window.removeEventListener('blur', onBlur);
      // Leaving ends a game this page hosts and frees player 2; the session
      // repaints the cabinet for the room (a game still running, or the
      // attract card).
      link?.release();
      link = null;
      speaker?.close();
      speaker = null;
      capture?.remove();
      strip?.remove();
      capture = strip = stripText = spoken = null;
    },

    update(dt: number): void {
      if (!mounted) return;
      // The owner changed the cabinet's game: World builds the UI for it in
      // this one's place (and unmounts this one, ending a game it hosts).
      if (deps.onGameChanged && (currentGame()?.id ?? null) !== (game?.id ?? null)) {
        deps.onGameChanged();
        return;
      }
      pollPads(dt);
      followShared();
      const held = [...keysDown.values(), ...padHeld[0]];
      for (const b of usedByCabinet) if (!held.includes(b)) usedByCabinet.delete(b); // let go
      link?.setButtons(padByte(held.filter((b) => !usedByCabinet.has(b))));
      link?.setLocalPad2(padByte(padHeld[1]));
      if (view.screen === 'shared') {
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
