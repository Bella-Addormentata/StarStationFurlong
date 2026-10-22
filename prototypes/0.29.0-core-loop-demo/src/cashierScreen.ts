/**
 * 🏧 The cashier ATM's own screen (#69 G1, fully 3D): the buy-in / cash-out
 * menu is painted onto the kiosk's 3D screen and pressed there, instead of
 * a popup. This module is the pure part: the screen's button layout, the
 * hit test from a screen UV, and the painters (the idle attract card and
 * the menu). furniture.ts builds the canvas and stows a CashierScreenHandle
 * on the screen mesh; cashierSession.ts drives it while a player is at the
 * machine.
 *
 * The cage's public ledger (issued / returned / on the floor / house net)
 * moved to the kiosk's ⚙ card — one gear per machine — so the screen keeps
 * to what a player does at an ATM: count their chips, buy in, cash out.
 */

import type * as THREE from 'three';
import { buyInChips, cashOutChips, readChips } from './casinoDoc';
import { chipsFor, drawChips } from './chipDisplay';

/** Canvas size: the screen plane is 0.58 × 0.42 m, so ~1.38 : 1. */
export const CASHIER_SCREEN_W = 512;
export const CASHIER_SCREEN_H = 372;

export type CashierAct = 'buy-25' | 'buy-100' | 'buy-500' | 'cashout';

export interface CashierButton {
  act: CashierAct;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
}

/** What the menu shows: the viewer's chips and the screen's live bits. */
export interface CashierScreenView {
  chips: number;
  /** The button under the pointer, if any. */
  hover: CashierAct | null;
  /** The keyboard's button (arrows move it, Enter presses it). */
  focus: CashierAct | null;
  /** A short line after a press ("+100 CHIPS FROM THE CAGE"), or null. */
  flash: string | null;
}

/** Handle onto a kiosk's screen (furniture.ts → screen mesh userData.cashierScreen). */
export interface CashierScreenHandle {
  /** Paint the menu for `view`, or the idle attract card for null. */
  paint(view: CashierScreenView | null): void;
  /** Where `ray` meets the screen, as canvas pixels, or null for a miss. */
  pick(ray: THREE.Raycaster): { x: number; y: number } | null;
}

/** Buy-in amounts, in the order the screen lays them out. */
export const CASHIER_BUY_INS = [25, 100, 500] as const;

/** The menu's buttons for a player holding `chips`. */
export function cashierButtons(chips: number): CashierButton[] {
  const pad = 24;
  const gap = 12;
  const w = (CASHIER_SCREEN_W - pad * 2 - gap * 2) / 3;
  const buys: CashierButton[] = CASHIER_BUY_INS.map((n, i) => ({
    act: `buy-${n}` as CashierAct,
    label: `+${n}`,
    x: pad + i * (w + gap),
    y: 222,
    w,
    h: 48,
    enabled: true,
  }));
  return [
    ...buys,
    {
      act: 'cashout',
      label: 'CASH OUT ALL CHIPS',
      x: pad,
      y: 284,
      w: CASHIER_SCREEN_W - pad * 2,
      h: 44,
      enabled: chips > 0,
    },
  ];
}

/** The button at canvas point (x, y), enabled or not, or null. */
export function cashierButtonAt(buttons: readonly CashierButton[], x: number, y: number): CashierButton | null {
  return buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;
}

/** Arrow-key move between the enabled buttons: ←/→ step along the row,
 *  ↑/↓ jump between the buy-in row and CASH OUT. */
export function cashierNav(
  buttons: readonly CashierButton[],
  from: CashierAct | null,
  key: 'left' | 'right' | 'up' | 'down',
): CashierAct | null {
  const live = buttons.filter((b) => b.enabled);
  if (live.length === 0) return null;
  const here = live.findIndex((b) => b.act === from);
  if (here < 0) return live[0].act;
  const isBuy = (a: CashierAct): boolean => a !== 'cashout';
  if (key === 'left') return live[Math.max(0, here - 1)].act;
  if (key === 'right') return live[Math.min(live.length - 1, here + 1)].act;
  if (key === 'down') return isBuy(live[here].act) ? (live.find((b) => !isBuy(b.act))?.act ?? live[here].act) : live[here].act;
  // up: back to the middle buy-in from CASH OUT.
  return isBuy(live[here].act) ? live[here].act : 'buy-100';
}

/** Words for the flash line after a press. */
export function cashierFlash(act: CashierAct, returned: number): string {
  if (act === 'cashout') return returned > 0 ? `${returned} CHIPS BACK TO THE CAGE` : 'NO CHIPS TO RETURN';
  return `+${act.slice(4)} CHIPS FROM THE CAGE`;
}

/** Run one of the screen's buttons for `playerId`; returns the flash line. */
export function pressCashier(act: CashierAct, playerId: string): string | null {
  const button = cashierButtons(readChips(playerId)).find((b) => b.act === act);
  if (!button?.enabled) return null;
  if (act === 'cashout') return cashierFlash(act, cashOutChips(playerId, readChips(playerId)));
  buyInChips(playerId, Number(act.slice(4)));
  return cashierFlash(act, 0);
}

const BG = '#06121C';
const PANEL = '#0E2A38';
const CYAN = '#00E5FF';
const GOLD = '#D4A84B';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
const PINK = '#FF2D95';

/** Idle attract card: what everyone sees when nobody is using this kiosk on
 *  their screen (the menu is painted only on the user's own client). */
export function paintCashierAttract(c2d: CanvasRenderingContext2D): void {
  const W = CASHIER_SCREEN_W;
  const H = CASHIER_SCREEN_H;
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.fillStyle = BG;
  c2d.fillRect(0, 0, W, H);
  c2d.fillStyle = PANEL;
  c2d.fillRect(16, 16, W - 32, H - 32);
  c2d.fillStyle = CYAN;
  c2d.font = 'bold 48px monospace';
  c2d.textAlign = 'center';
  c2d.textBaseline = 'middle';
  c2d.fillText('BUY-IN', W / 2, 110);
  c2d.fillText('CASH OUT', W / 2, 180);
  c2d.fillStyle = GOLD_BRIGHT;
  c2d.font = '30px monospace';
  c2d.fillText('WALK UP TO BEGIN', W / 2, 285);
}

function paintButton(c2d: CanvasRenderingContext2D, b: CashierButton, hot: boolean, focused: boolean): void {
  c2d.fillStyle = !b.enabled ? 'rgba(212,168,75,0.05)' : hot ? 'rgba(0,229,255,0.28)' : 'rgba(212,168,75,0.14)';
  c2d.fillRect(b.x, b.y, b.w, b.h);
  c2d.lineWidth = focused ? 4 : 2;
  c2d.strokeStyle = !b.enabled ? 'rgba(212,168,75,0.2)' : focused || hot ? CYAN : 'rgba(212,168,75,0.7)';
  c2d.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
  c2d.fillStyle = b.enabled ? GOLD_BRIGHT : DIM;
  c2d.font = `bold ${b.act === 'cashout' ? 22 : 28}px monospace`;
  c2d.textAlign = 'center';
  c2d.textBaseline = 'middle';
  c2d.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
}

/** The menu: YOUR CHIPS with the tray, the buy-in row, CASH OUT, and a
 *  footer line (the flash, or how to leave / where the ledger is). */
export function paintCashierMenu(c2d: CanvasRenderingContext2D, view: CashierScreenView): void {
  const W = CASHIER_SCREEN_W;
  const H = CASHIER_SCREEN_H;
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.fillStyle = BG;
  c2d.fillRect(0, 0, W, H);
  // Header.
  c2d.fillStyle = PANEL;
  c2d.fillRect(0, 0, W, 40);
  c2d.fillStyle = GOLD_BRIGHT;
  c2d.font = 'bold 24px monospace';
  c2d.textAlign = 'left';
  c2d.textBaseline = 'middle';
  c2d.fillText('CASHIER', 20, 21);
  c2d.fillStyle = PINK;
  c2d.font = 'bold 16px monospace';
  c2d.textAlign = 'right';
  c2d.fillText('THE CAGE', W - 20, 21);
  // Your chips: the one place the number and the chips show together.
  c2d.textAlign = 'left';
  c2d.fillStyle = DIM;
  c2d.font = 'bold 15px monospace';
  c2d.fillText('YOUR CHIPS', 24, 64);
  c2d.fillStyle = GOLD_BRIGHT;
  c2d.font = 'bold 40px monospace';
  c2d.fillText(String(view.chips), 140, 66);
  // The tray, drawn at 2× so the chips read from the kiosk's distance.
  c2d.setTransform(2, 0, 0, 2, 0, 0);
  drawChips(c2d, chipsFor(view.chips), 12, 46, 232, 50, { emptyText: 'THE TRAY IS EMPTY' });
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  // Buy-in row.
  c2d.fillStyle = GOLD;
  c2d.font = 'bold 14px monospace';
  c2d.textAlign = 'left';
  c2d.textBaseline = 'middle';
  c2d.fillText('BUY-IN', 24, 210);
  for (const b of cashierButtons(view.chips)) {
    paintButton(c2d, b, b.enabled && view.hover === b.act, b.enabled && view.focus === b.act);
  }
  // Footer.
  c2d.textAlign = 'center';
  if (view.flash) {
    c2d.fillStyle = '#00E676';
    c2d.font = 'bold 18px monospace';
    c2d.fillText(view.flash, W / 2, 350);
  } else {
    c2d.fillStyle = 'rgba(212,168,75,0.55)';
    c2d.font = '13px monospace';
    c2d.fillText('GEAR BELOW: THE CAGE LEDGER  ·  ESC TO STEP BACK', W / 2, 350);
  }
}
