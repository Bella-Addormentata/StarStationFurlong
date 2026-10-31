/**
 * 🎲🖥️ The computed craps table's UI on a test page (test-only kit): just
 * enough of a DOM to mount the focused table (casinoTableSession over
 * computedTable), a fake handle for the table's 3D pieces that logs the
 * dice it was asked to fly and land, and a mounted table that presses keys,
 * clicks the felt, flings the dice and reads the status line, the notices
 * and the ⚙ card.
 *
 * Moved out of computedCrapsTable.test.ts so the simulation (computedSim,
 * computedCrapsSim) can mount the real table UI on the pages it chooses and
 * read the words they show, as that spec file does.
 *
 * Module generations: each page is its own load of the casino modules
 * (computedPageKit loadPage, vi.resetModules), so the table UI's modules are
 * imported right after it (withUI), never at the top of a file.
 */

import { vi } from 'vitest';
import * as THREE from 'three';
import { CRAPS_TABLE as TABLE, loadPage } from './computedPageKit';
import type { Page } from './computedPageKit';
import { CRAPS_LAYOUT, hitRegion } from './games/casinoLayout';
import type { FeltPoint, FeltRegion, CrapsSpot } from './games/casinoLayout';
import type { CrapsBet } from './games/craps';

// ── A minimal DOM ────────────────────────────────────────────────────────────

export class FakeEl {
  id = '';
  tabIndex = -1;
  innerHTML = '';
  parentElement: FakeEl | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners = new Map<string, ((e: unknown) => void)[]>();
  /** Every text this element was given, in order. */
  readonly texts: string[] = [];
  private text = '';
  private sub = new Map<string, FakeEl>();
  get textContent(): string { return this.text; }
  set textContent(v: string) {
    this.text = v;
    this.texts.push(v);
  }
  setAttribute(): void {}
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  appendChild(child: FakeEl): FakeEl {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  focus(): void {}
  contains(): boolean { return false; }
  closest(): FakeEl | null { return null; }
  setPointerCapture(): void {}
  hasPointerCapture(): boolean { return false; }
  releasePointerCapture(): void {}
  querySelector(sel: string): FakeEl {
    let el = this.sub.get(sel);
    if (!el) {
      el = new FakeEl();
      this.sub.set(sel, el);
    }
    return el;
  }
  querySelectorAll(): FakeEl[] { return []; }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
  fire(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

/** Stub `document` and `window` (globals) with just enough for the table UI
 *  and the HUD's hint (showHint); the window's timers go through to the
 *  (faked) timers at call time, and `win` adds to (or overrides) the
 *  window. Returns the body, where the HUD's hints go. */
export function stubDom(win: Record<string, unknown> = {}): FakeEl {
  const body = new FakeEl();
  vi.stubGlobal('document', {
    createElement: () => new FakeEl(),
    activeElement: null,
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('window', {
    location: { search: '' },
    innerWidth: 1000,
    addEventListener: () => {},
    removeEventListener: () => {},
    innerHeight: 800,
    // Through to the (faked) timers at call time.
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id: number) => globalThis.clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    ...win,
  });
  return body;
}

/** The HUD hints shown (walking off the table) under `body`, in order. */
export const hintsIn = (body: FakeEl): string[] => body.children.filter((c) => c.id === 'hud-hint').flatMap((c) => c.texts);

// ── The table's pieces ───────────────────────────────────────────────────────

type CasinoTableVisualHandle = import('./casinoTable3d').CasinoTableVisualHandle;

/** A craps table's pieces that log what the dice were asked to do (`throw
 *  <seed>`, `land <d1><d2>`, `cancel`), fly until given their faces and
 *  settle over the two updates after (a frame's own update and the next:
 *  the status line reads them settling); and that put a pointer press wherever `aim`
 *  says (on the felt at `p`, on my own stack there with `stack`, on the
 *  dice with `dice`, which a hold raises until they fly or go home). */
export interface FakeDice {
  h: CasinoTableVisualHandle;
  log: string[];
  state: () => string;
  aim: { p: FeltPoint | null; stack: boolean; dice: boolean };
  /** The chips the hand shows. */
  hand: () => readonly number[];
  /** How many times the table's pieces were reset; where the dice were last
   *  slid to rest (null once thrown, until they are slid again). */
  resets: () => number;
  rest: () => FeltPoint | null;
  /** What the table's plaque was last set to: Fair or not (null: never). */
  fair: () => boolean | null;
}

export function fakeDice(): FakeDice {
  let state = 'rest';
  let settle = 0;
  let hand: readonly number[] = [];
  let resets = 0;
  let rest: FeltPoint | null = null;
  let fair: boolean | null = null;
  const log: string[] = [];
  const aim: FakeDice['aim'] = { p: null, stack: false, dice: false };
  const h = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_t, key) => {
      switch (key) {
        case 'game': return 'craps';
        case 'halfX': return 1.2;
        case 'halfZ': return 0.6;
        case 'diceState': return () => state;
        case 'diceThrow': return (_from: FeltPoint, _dir: FeltPoint, _power: number, seed: number) => {
          log.push(`throw ${seed}`);
          state = 'flying';
          rest = null;
        };
        case 'diceLand': return (f: readonly [number, number]) => {
          log.push(`land ${f[0]}${f[1]}`);
          if (state === 'flying') {
            state = 'settling';
            settle = 2;
          }
        };
        case 'diceCancel': return () => {
          log.push('cancel');
          state = 'rest';
        };
        case 'update': return () => {
          if (state === 'settling' && --settle <= 0) state = 'rest';
        };
        case 'reset': return () => {
          resets += 1;
          state = 'rest';
        };
        case 'diceRestAt': return (at: FeltPoint) => {
          rest = at;
          if (state === 'held') state = 'rest';
        };
        case 'diceHold': return () => {
          if (state !== 'flying' && state !== 'settling') state = 'held';
        };
        case 'setHand': return (_at: unknown, chips: readonly number[]) => {
          hand = [...chips];
        };
        case 'pick': return () => (aim.dice ? { kind: 'dice' } : aim.p ? { kind: 'felt', p: aim.p } : null);
        case 'setFairBadge': return (f: boolean) => {
          fair = f;
        };
        case 'projectToFelt': return () => aim.p;
        case 'onMyStack': return () => (aim.stack ? aim.p : null);
        case 'toScreen': return () => null;
        default: return () => undefined;
      }
    },
  }) as unknown as CasinoTableVisualHandle;
  return { h, log, state: () => state, aim, hand: () => hand, resets: () => resets, rest: () => rest, fair: () => fair };
}

// ── Pages with a table UI ────────────────────────────────────────────────────

export interface UIPage extends Page {
  session: typeof import('./casinoTableSession');
  dice: FakeDice;
  /** The focused table's UI on this page, while one is mounted. */
  at: AtCraps | null;
}

/** Page p (just loaded: its own module generation) with the table UI
 *  loaded over its modules and the craps table `table` in its room's
 *  furniture. Call it right after loadPage, before any other load. */
export async function withUI(p: Page, table = TABLE): Promise<UIPage> {
  const session = await import('./casinoTableSession');
  const furniture = await import('./furniture');
  const focus = await import('./deviceFocus');
  vi.spyOn(focus.deviceFocus, 'getCamera').mockReturnValue(new THREE.PerspectiveCamera() as never);
  vi.spyOn(focus.deviceFocus, 'release').mockImplementation(() => {});
  if (!furniture.FURNITURE.some((i) => i.id === table)) {
    furniture.FURNITURE.push({ id: table, kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  }
  return Object.assign(p, { session, dice: fakeDice(), at: null });
}

/** Page `name` with the table UI loaded over its own modules, the craps
 *  table in its room's furniture (`reloadOf`: that page's tab loaded again,
 *  its key kept, its seeds gone). */
export async function loadUIPage(name: string, clientID: number, opts: { reloadOf?: Page; pid?: string } = {}): Promise<UIPage> {
  return withUI({ ...(await loadPage(name, clientID, opts)) });
}

export interface AtCraps {
  key: (k: string) => void;
  /** The last notice (the screen reader's live line, zero-width space off). */
  said: () => string;
  /** Every notice, in order. */
  heard: () => string[];
  /** The status line. */
  status: () => string;
  /** Every status line shown, in order. */
  lines: () => string[];
  plaque: () => string;
  /** The ⚙ card's markup (opened if it isn't). */
  card: () => string;
  press: (act: string) => void;
  /** Pick up chips off the rail with key `keyNo` (1–6: 1, 5, 25, …), `times` times. */
  pick: (keyNo: string, times?: number) => void;
  /** A click on the felt box for `type` (and `pick`): the hand bets there. */
  click: (type: CrapsBet['type'], pick?: number) => void;
  /** A click on my own chips in that box: they come back. */
  takeBack: (type: CrapsBet['type'], pick?: number) => void;
  /** The dice picked up at `path[0]` and dragged along it, `stepMs` apart
   *  (the page's performance clock), then let go. */
  fling: (path: FeltPoint[], stepMs: number) => void;
  update: () => void;
  unmount: () => void;
}

/** A point inside the felt box for `type` (and `pick`) that hits that box. */
export function boxAt(type: CrapsBet['type'], pick?: number): FeltPoint {
  const rg = CRAPS_LAYOUT.regions.find((r) => r.bet.type === type && r.bet.pick === pick) as FeltRegion<CrapsSpot> | undefined;
  if (!rg) throw new Error(`no ${type} ${pick ?? ''} box`);
  for (const r of rg.rects) {
    for (let i = 1; i < 10; i++) {
      for (let j = 1; j < 10; j++) {
        const p = { x: r.x0 + ((r.x1 - r.x0) * i) / 10, z: r.z0 + ((r.z1 - r.z0) * j) / 10 };
        if (hitRegion(CRAPS_LAYOUT, p) === rg) return p;
      }
    }
  }
  throw new Error(`no point hits the ${type} ${pick ?? ''} box`);
}

/** Mount the focused craps table `table` on page p, a player at `stand`
 *  (null: the device front), the house with `house`. */
export function atCraps(p: UIPage, opts: { stand?: number | null; house?: boolean; table?: string } = {}): AtCraps {
  const ui = p.session.createCasinoTableUI({
    itemId: opts.table ?? TABLE, game: 'craps', isHouse: () => opts.house ?? false, stand: opts.stand ?? null, visual: p.dice.h,
  });
  const host = new FakeEl();
  ui.mount(host as unknown as HTMLElement);
  const capture = host.children[0];
  const bar = host.children[1];
  const key = (k: string): void => capture.fire('keydown', { key: k, preventDefault() {}, stopPropagation() {} });
  const cardEl = (): FakeEl | undefined => host.children.find((c) => c !== capture && c !== bar);
  const open = (): FakeEl => {
    if (!cardEl()) key('s');
    return cardEl()!;
  };
  const strip = (s: string): string => s.replace(/​/g, '');
  const press = (point: FeltPoint, stack: boolean): void => {
    p.dice.aim.p = point;
    p.dice.aim.stack = stack;
    capture.fire('pointerdown', {
      button: 0, pointerType: 'mouse', pointerId: 1, clientX: 500, clientY: 400, stopPropagation() {}, preventDefault() {},
    });
    p.dice.aim.p = null;
    p.dice.aim.stack = false;
  };
  const t: AtCraps = {
    key,
    said: () => strip(bar.querySelector('[data-live]').textContent),
    heard: () => bar.querySelector('[data-live]').texts.map(strip),
    status: () => bar.querySelector('[data-status]').textContent,
    lines: () => [...bar.querySelector('[data-status]').texts],
    plaque: () => bar.querySelector('[data-fair]').textContent,
    card: () => open().innerHTML,
    press: (act: string) => open().fire('click', {
      target: { closest: () => ({ dataset: { act } }) }, preventDefault() {}, stopPropagation() {},
    }),
    pick: (keyNo, times = 1) => {
      for (let i = 0; i < times; i++) key(keyNo);
    },
    click: (type, pick) => press(boxAt(type, pick), false),
    takeBack: (type, pick) => press(boxAt(type, pick), true),
    fling: (path, stepMs) => {
      let t = 1_000;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => t);
      const ev = (): Record<string, unknown> => ({
        button: 0, pointerType: 'mouse', pointerId: 1, clientX: 500, clientY: 400, stopPropagation() {}, preventDefault() {},
      });
      p.dice.aim.dice = true;
      p.dice.aim.p = path[0];
      capture.fire('pointerdown', ev());
      p.dice.aim.dice = false;
      for (const at of path.slice(1)) {
        t += stepMs;
        p.dice.aim.p = at;
        capture.fire('pointermove', ev());
      }
      capture.fire('pointerup', ev());
      p.dice.aim.p = null;
      clock.mockRestore();
    },
    update: () => ui.update(1 / 60),
    unmount: () => {
      ui.unmount();
      p.at = null;
    },
  };
  p.at = t;
  return t;
}
