/**
 * 🏧 The cashier ATM, played on the machine (#69 G1, fully 3D).
 *
 * Retires the cashier popup. Step up to the kiosk and its own screen shows
 * the menu (cashierScreen.ts): YOUR CHIPS with the tray, BUY-IN +25 / +100 /
 * +500, CASH OUT ALL CHIPS. While focused, the player gets:
 *  - a transparent capture layer over the 3D view: clicks are raycast from
 *    the focus camera onto the screen and pressed there; a click off the
 *    screen steps back, as at every device;
 *  - arrow keys + Enter to press the screen's buttons without a mouse;
 *  - a one-line hint strip at the top of the view (no panel);
 *  - the kiosk's ⚙ gear (one per machine), which opens the cage's card: the
 *    public ledger and the floor balances, for anyone to read.
 *
 * The menu is painted on THIS client's copy of the screen only; everyone
 * else keeps seeing the attract card. The chips themselves are room records
 * (casinoDoc), so the ledger the card shows is the same for everyone.
 */

import * as THREE from 'three';
import { readCageLedger, readChips, subscribeCasino } from './casinoDoc';
import {
  cashierButtonAt,
  cashierButtons,
  cashierNav,
  pressCashier,
  type CashierAct,
  type CashierScreenHandle,
} from './cashierScreen';
import type { DeviceUI } from './devices';
import { deviceFocus } from './deviceFocus';
import { gearSection } from './gearCardParts';
import { readPlayerDisplayName } from './games/gamesDoc';
import { escapeHtml } from './htmlEscape';
import { getPlayerId } from './identity';
import { closeGearCard, isGearCardOpen, pickSettingsGearAt, toggleGearCard } from './settingsGear';
import type { GearCardSpec } from './settingsGear';
import { isFormFieldTarget } from './typingFocus';

export interface CashierUIDeps {
  itemId: string;
  /** Owner-equivalent predicate (the one-seam ownership gate, via world). */
  isHouse: () => boolean;
  /** The kiosk's screen (null if the build carried none: nothing to press). */
  screen: CashierScreenHandle | null;
}

/** How long a press's line stays on the screen (s). */
const FLASH_TIME = 2.2;

const GOLD = '#D4A84B';
const GOLD_BRIGHT = '#F0C060';
const DIM = 'rgba(212,168,75,0.55)';

/** ⚙ The kiosk's card: the cage's public ledger. Issuance is PUBLIC (every
 *  player sees issued / outstanding / house net and the floor balances) —
 *  that is the whole trust model of doc-recorded chips. */
export function cashierGearCard(itemId: string, isHouse: () => boolean): GearCardSpec {
  return {
    itemId,
    title: 'CASHIER',
    noun: 'CAGE',
    isHouse,
    body(house) {
      const me = getPlayerId();
      const cage = readCageLedger();
      const net = cage.houseNet;
      const row = (label: string, value: string, color = GOLD): string =>
        `<div style="display:flex;justify-content:space-between;"><span style="color:${DIM};">${label}</span><span style="color:${color};">${value}</span></div>`;
      const floor = Object.entries(cage.balances)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([pid, n]) => row(
          `${escapeHtml(readPlayerDisplayName(pid).toUpperCase())}${pid === me ? ' (YOU)' : ''}`,
          `🪙 ${n}`,
          GOLD_BRIGHT,
        ));
      const rows = [
        gearSection([
          'STEP UP TO THE SCREEN TO BUY IN OR CASH OUT',
          'TEST NETWORK — THE CAGE ADVANCES CHIPS AGAINST YOUR ACCOUNT',
          'REAL CHIA BUY-INS ARRIVE WITH THE REGISTRY CASHIER',
        ]),
        gearSection([
          `<span style="color:#FF2D95;letter-spacing:1.5px;">THE CAGE — PUBLIC LEDGER</span>`,
          row('CHIPS ISSUED', String(cage.issued)),
          row('RETURNED', String(cage.cashed)),
          row('ON THE FLOOR', String(cage.outstanding)),
          row('HOUSE NET', `${net >= 0 ? '+' : ''}${net}`, net >= 0 ? '#00E676' : '#FF8A80'),
        ]),
      ];
      if (floor.length) rows.push(gearSection(floor));
      if (house) {
        rows.push(gearSection([
          `<span style="color:#FF2D95;">★ YOU ARE THE HOUSE — table games pay from the cage; the ledger above is your book.</span>`,
        ]));
      }
      return rows.join('');
    },
    subscribe: subscribeCasino,
  };
}

/** Arrow keys the screen takes while focused. */
const NAV_KEYS: Record<string, 'left' | 'right' | 'up' | 'down'> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** The cashier's focused UI: the menu on the kiosk's own screen. */
export function createCashierUI(deps: CashierUIDeps): DeviceUI {
  const myId = getPlayerId();
  let capture: HTMLDivElement | null = null;
  let strip: HTMLDivElement | null = null;
  let live: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let hover: CashierAct | null = null;
  let focus: CashierAct | null = null;
  let flash: string | null = null;
  let flashLeft = 0;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const paint = (): void => {
    const chips = readChips(myId);
    deps.screen?.paint({ chips, hover, focus, flash });
    // The screen is a texture: say the same thing to assistive technology.
    if (live) {
      const button = cashierButtons(chips).find((b) => b.act === focus);
      const text = [
        `Your chips: ${chips}.`,
        button ? `Selected: ${button.label}${button.enabled ? '' : ' (unavailable)'}.` : '',
        flash ? `${flash}.` : '',
      ].filter(Boolean).join(' ');
      if (live.textContent !== text) live.textContent = text;
    }
  };

  /** Aim the raycaster from the focus camera through a pointer. */
  const aim = (e: MouseEvent): boolean => {
    const cam = deviceFocus.getCamera() ?? window.gameRenderer?.camera;
    if (!cam) return false;
    const el = window.gameRenderer?.renderer?.domElement;
    const rect = el?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    if (rect.width <= 0 || rect.height <= 0) return false;
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return true;
  };

  /** The screen point under the pointer, or null off the screen. */
  const screenAt = (e: MouseEvent): { x: number; y: number } | null =>
    deps.screen && aim(e) ? deps.screen.pick(ray) : null;

  const press = (act: CashierAct): void => {
    const line = pressCashier(act, myId);
    if (line === null) return;
    flash = line;
    flashLeft = FLASH_TIME;
    // A cash-out disables its own button: put the keyboard back on the row.
    if (act === 'cashout') focus = focus ? 'buy-100' : null;
    paint(); // the casino observer repaints too; this shows the flash at once
  };

  const onMove = (e: PointerEvent): void => {
    if (!capture) return;
    const p = screenAt(e);
    const b = p ? cashierButtonAt(cashierButtons(readChips(myId)), p.x, p.y) : null;
    const next = b?.enabled ? b.act : null;
    capture.style.cursor = next || pickSettingsGearAt(e) === deps.itemId ? 'pointer' : 'default';
    if (next !== hover) {
      hover = next;
      paint();
    }
  };

  /** Open (or close) the ⚙ card; from the keyboard, focus moves into it. */
  const toggleLedger = (fromKeys: boolean): void => {
    toggleGearCard(cashierGearCard(deps.itemId, deps.isHouse));
    if (fromKeys && isGearCardOpen(deps.itemId)) {
      document.getElementById('settings-gear-card')?.querySelector<HTMLElement>('[data-act]')?.focus();
    }
  };

  const onClick = (e: MouseEvent): void => {
    e.stopPropagation(); // the screen owns its clicks: never a stray release
    if (pickSettingsGearAt(e) === deps.itemId) {
      toggleLedger(false);
      return;
    }
    const p = screenAt(e);
    if (!p) {
      deviceFocus.release(); // off the screen: step back, as at every device
      return;
    }
    const b = cashierButtonAt(cashierButtons(readChips(myId)), p.x, p.y);
    if (b?.enabled) press(b.act);
  };

  // Taken in the capture phase so the arrows drive the screen, not the
  // walk; Esc, WASD and Tab pass through (stepping back stays where it was).
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // the browser's shortcuts
    // The SpacePhone in front owns the keys (as it owns Esc, deviceFocus.ts).
    if (document.getElementById('spacephone-container')?.classList.contains('active')) return;
    const target = e.target as HTMLElement | null;
    // Only keys aimed at the kiosk (its focused screen, or nothing focused):
    // form fields, the ⚙ card's buttons and any other focused UI keep theirs.
    if (target !== capture && target !== document.body && target !== null) return;
    if (isFormFieldTarget(target)) return;
    const dir = NAV_KEYS[e.key];
    if (dir) {
      focus = cashierNav(cashierButtons(readChips(myId)), focus, dir);
    } else if ((e.key === 'Enter' || e.key === ' ') && focus) {
      if (!e.repeat) press(focus);
    } else if (e.key === 'l' || e.key === 'L') {
      // L: the ⚙ card (the cage ledger) without the mouse.
      if (!e.repeat) toggleLedger(true);
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    paint();
  };

  return {
    mount(host: HTMLElement): void {
      hover = focus = flash = null;
      flashLeft = 0;
      capture = document.createElement('div');
      capture.id = 'cashier-capture';
      capture.style.cssText = 'position:absolute; inset:0; pointer-events:auto; background:transparent; outline:none;';
      // Keyboard + screen-reader use: the screen itself takes focus, and a
      // live region reads out what the texture shows.
      capture.tabIndex = 0;
      capture.setAttribute('role', 'application');
      capture.setAttribute('aria-roledescription', 'cashier screen');
      capture.setAttribute('aria-label',
        'Cashier. Arrow keys choose buy in 25, 100 or 500, or cash out all chips; Enter presses. L, or the settings gear, opens the cage ledger. Escape steps back.');
      capture.addEventListener('click', onClick);
      capture.addEventListener('pointermove', onMove);
      capture.addEventListener('pointerleave', () => {
        hover = null;
        paint();
      });
      strip = document.createElement('div');
      strip.id = 'cashier-hint';
      strip.style.cssText = `
        position:absolute; top:16px; left:50%; transform:translateX(-50%);
        max-width:calc(100vw - 32px); padding:8px 16px; text-align:center;
        background:rgba(4, 8, 22, 0.88); border:1px solid rgba(212, 168, 75, 0.28);
        border-radius:10px; box-shadow:0 8px 40px rgba(0,0,0,0.7);
        color:${GOLD}; font-family:'SF Mono', 'Monaco', 'Consolas', monospace;
        font-size:10px; letter-spacing:1.5px; box-sizing:border-box; pointer-events:none;`;
      strip.textContent = deps.screen
        ? 'CASHIER · CLICK THE SCREEN · ← → ↑ ↓ + ENTER · ⚙ OR L FOR THE CAGE LEDGER · ESC TO STEP BACK'
        : 'THIS CASHIER HAS NO SCREEN · ESC TO STEP BACK';
      live = document.createElement('div');
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      live.style.cssText = 'position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap;';
      host.append(capture, strip, live);
      capture.focus({ preventScroll: true });
      window.addEventListener('keydown', onKey, true);
      unsubscribe = subscribeCasino(() => paint());
      paint();
    },

    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      window.removeEventListener('keydown', onKey, true);
      capture?.remove();
      strip?.remove();
      live?.remove();
      capture = strip = live = null;
      closeGearCard(deps.itemId);
      deps.screen?.paint(null); // back to the attract card
    },

    update(dt: number): void {
      if (flashLeft <= 0) return;
      flashLeft -= dt;
      if (flashLeft <= 0) {
        flash = null;
        paint();
      }
    },
  };
}
