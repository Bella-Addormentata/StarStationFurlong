/**
 * 🏧 Cashier on its own screen: the menu's layout and hit test, the arrow
 * keys, the presses against a real casino doc, and the kiosk build — its
 * screen carries the handle, a ray through a button picks that button, and
 * the kiosk has exactly one ⚙ gear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import * as Y from 'yjs';
import { bindCasinoDoc, readCageLedger, readChips } from './casinoDoc';
import {
  CASHIER_SCREEN_H,
  CASHIER_SCREEN_W,
  cashierButtonAt,
  cashierButtons,
  cashierFlash,
  cashierNav,
  pressCashier,
  type CashierScreenHandle,
} from './cashierScreen';
import { buildItemGroup } from './furniture';

describe('cashier screen layout', () => {
  it('lays out three buy-ins and CASH OUT inside the screen, none overlapping', () => {
    const buttons = cashierButtons(100);
    expect(buttons.map((b) => b.act)).toEqual(['buy-25', 'buy-100', 'buy-500', 'cashout']);
    for (const b of buttons) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(CASHIER_SCREEN_W);
      expect(b.y + b.h).toBeLessThanOrEqual(CASHIER_SCREEN_H);
      // The centre of each button picks that button and no other.
      expect(cashierButtonAt(buttons, b.x + b.w / 2, b.y + b.h / 2)?.act).toBe(b.act);
    }
    expect(cashierButtonAt(buttons, 5, 5)).toBeNull();
  });

  it('greys CASH OUT when the player holds no chips', () => {
    expect(cashierButtons(0).find((b) => b.act === 'cashout')?.enabled).toBe(false);
    expect(cashierButtons(1).find((b) => b.act === 'cashout')?.enabled).toBe(true);
  });

  it('moves the keyboard focus along the row and between the rows', () => {
    const b = cashierButtons(10);
    expect(cashierNav(b, null, 'right')).toBe('buy-25');
    expect(cashierNav(b, 'buy-25', 'right')).toBe('buy-100');
    expect(cashierNav(b, 'buy-25', 'left')).toBe('buy-25');
    expect(cashierNav(b, 'buy-100', 'down')).toBe('cashout');
    expect(cashierNav(b, 'cashout', 'up')).toBe('buy-100');
    // With CASH OUT greyed, down stays on the row.
    expect(cashierNav(cashierButtons(0), 'buy-500', 'down')).toBe('buy-500');
    expect(cashierNav(cashierButtons(0), 'buy-500', 'right')).toBe('buy-500');
  });

  it('words the flash line', () => {
    expect(cashierFlash('buy-500', 0)).toBe('+500 CHIPS FROM THE CAGE');
    expect(cashierFlash('cashout', 125)).toBe('125 CHIPS BACK TO THE CAGE');
    expect(cashierFlash('cashout', 0)).toBe('NO CHIPS TO RETURN');
  });
});

describe('cashier presses', () => {
  beforeEach(() => bindCasinoDoc(new Y.Doc()));

  it('buys in and cashes out through the cage, and refuses a greyed CASH OUT', () => {
    const me = 'player-Bob';
    expect(pressCashier('cashout', me)).toBeNull();
    expect(pressCashier('buy-100', me)).toBe('+100 CHIPS FROM THE CAGE');
    expect(pressCashier('buy-25', me)).toBe('+25 CHIPS FROM THE CAGE');
    expect(readChips(me)).toBe(125);
    expect(pressCashier('cashout', me)).toBe('125 CHIPS BACK TO THE CAGE');
    expect(readChips(me)).toBe(0);
    const cage = readCageLedger();
    expect(cage.issued).toBe(125);
    expect(cage.cashed).toBe(125);
  });
});

/** A canvas whose 2-D context draws nothing. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => ({ width: 0 })),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

describe('cashier kiosk build', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
    vi.stubGlobal('window', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const build = () => {
    const group = buildItemGroup({ id: 'atm-1', kind: 'cashier-atm', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    group.updateMatrixWorld(true);
    let screen: CashierScreenHandle | null = null;
    const gears: THREE.Object3D[] = [];
    group.traverse((o) => {
      if (o.userData.cashierScreen) screen = o.userData.cashierScreen as CashierScreenHandle;
      if (o.userData.settingsGear === 'atm-1') gears.push(o);
    });
    return { screen: screen as CashierScreenHandle | null, gears };
  };

  it('stows one screen handle and one gear (rim + face)', () => {
    const { screen, gears } = build();
    expect(screen).not.toBeNull();
    expect(gears).toHaveLength(2);
    // The gear sits on the keypad, in front of the kiosk (−z) and below the screen.
    const p = new THREE.Vector3();
    gears[0].getWorldPosition(p);
    expect(p.z).toBeLessThan(-0.25);
    expect(p.y).toBeLessThan(1.1);
  });

  it('picks the button a ray from the focus eye goes through', () => {
    const { screen } = build();
    const eye = new THREE.Vector3(0, 1.55, -1.0); // the cashier's device eye
    const ray = new THREE.Raycaster();
    // Straight at the screen's centre: the middle of the canvas.
    ray.set(eye, new THREE.Vector3(0, 1.325, -0.345).sub(eye).normalize());
    const hit = screen!.pick(ray);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(CASHIER_SCREEN_W / 2, 0);
    expect(Math.abs(hit!.y - CASHIER_SCREEN_H / 2)).toBeLessThan(6);
    // Off to the side of the kiosk: no hit.
    ray.set(eye, new THREE.Vector3(1, 0, 1).normalize());
    expect(screen!.pick(ray)).toBeNull();
  });

  it('reads left-to-right as the player sees it', () => {
    const { screen } = build();
    const eye = new THREE.Vector3(0, 1.55, -1.0);
    const ray = new THREE.Raycaster();
    // The player's right is world −x at rot 0 (they face +z).
    ray.set(eye, new THREE.Vector3(-0.2, 1.325, -0.345).sub(eye).normalize());
    expect(screen!.pick(ray)!.x).toBeGreaterThan(CASHIER_SCREEN_W / 2);
  });
});
