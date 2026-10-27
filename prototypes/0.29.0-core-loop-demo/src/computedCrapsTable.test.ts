/**
 * 🎲🖥️ A computed craps table on screen (casinoTableSession over
 * computedTable): bets on the computed felt (odds behind riding bets, the
 * table-full count with riders, take-backs and the caps by amount), the
 * shooter's fling (from the shooter's own page only), one flight of the
 * dice a roll on every page and where they wait, the status lines and
 * notices only a computed craps table has (walking off and back among
 * them), the ⚙ card, and the house's switch row at craps.
 *
 * Each page is its own load of the casino modules (computedPageKit) with
 * the table's UI loaded with it, synced by hand, every clock explicit, its
 * dice chosen through the seeds (rigRoll). The table's 3D pieces are a fake
 * handle that logs the dice it was asked to fly and land; this file stubs
 * just enough of a DOM (as computedTablePresses.test.ts does) to mount the
 * focused table, press its keys, click its felt and press its card. A
 * page's frame runs as World runs it: the computed duties, every table's
 * pieces (casinoTablesFrame), then the focused table's UI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { forfeitKey } from './computedFold';
import {
  byRank, carryOf, clockOf, CRAPS_CTX as CTX, CRAPS_INC as INC, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, keysIn,
  loadPage, putIn, rigRoll, rigSame, rigSplit, send, signAs, standAt, switchOn, sync, trimByHand,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { testIdentity } from './computedTestKit';
import { CRAPS_DICE_SPOT, CRAPS_LAYOUT, hitRegion } from './games/casinoLayout';
import type { FeltPoint, FeltRegion, CrapsSpot } from './games/casinoLayout';
import type { CrapsBet } from './games/craps';

// ── A minimal DOM ────────────────────────────────────────────────────────────

class FakeEl {
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

/** Where the HUD's hint (showHint) goes. */
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
});

// ── The table's pieces ───────────────────────────────────────────────────────

type CasinoTableVisualHandle = import('./casinoTable3d').CasinoTableVisualHandle;

/** A craps table's pieces that log what the dice were asked to do (`throw
 *  <seed>`, `land <d1><d2>`, `cancel`), fly until given their faces and
 *  settle over the two updates after (a frame's own update and the next:
 *  the status line reads them settling); and that put a pointer press wherever `aim`
 *  says (on the felt at `p`, on my own stack there with `stack`, on the
 *  dice with `dice`, which a hold raises until they fly or go home). */
interface FakeDice {
  h: CasinoTableVisualHandle;
  log: string[];
  state: () => string;
  aim: { p: FeltPoint | null; stack: boolean; dice: boolean };
  /** The chips the hand shows. */
  hand: () => readonly number[];
  /** How many times the table's pieces were reset; where the dice last lay at rest. */
  resets: () => number;
  rest: () => FeltPoint | null;
}

function fakeDice(): FakeDice {
  let state = 'rest';
  let settle = 0;
  let hand: readonly number[] = [];
  let resets = 0;
  let rest: FeltPoint | null = null;
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
        case 'projectToFelt': return () => aim.p;
        case 'onMyStack': return () => (aim.stack ? aim.p : null);
        case 'toScreen': return () => null;
        default: return () => undefined;
      }
    },
  }) as unknown as CasinoTableVisualHandle;
  return { h, log, state: () => state, aim, hand: () => hand, resets: () => resets, rest: () => rest };
}

// ── Pages with a table UI ────────────────────────────────────────────────────

interface UIPage extends Page {
  session: typeof import('./casinoTableSession');
  dice: FakeDice;
  /** The focused table's UI on this page, while one is mounted. */
  at: AtCraps | null;
}

/** Page `name` with the table UI loaded over its own modules, the craps
 *  table in its room's furniture (`reloadOf`: that page's tab loaded again,
 *  its key kept, its seeds gone). */
async function loadUIPage(name: string, clientID: number, opts: { reloadOf?: Page; pid?: string } = {}): Promise<UIPage> {
  const p = await loadPage(name, clientID, opts);
  const session = await import('./casinoTableSession');
  const furniture = await import('./furniture');
  const focus = await import('./deviceFocus');
  vi.spyOn(focus.deviceFocus, 'getCamera').mockReturnValue(new THREE.PerspectiveCamera() as never);
  vi.spyOn(focus.deviceFocus, 'release').mockImplementation(() => {});
  if (!furniture.FURNITURE.some((i) => i.id === TABLE)) {
    furniture.FURNITURE.push({ id: TABLE, kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  }
  return { ...p, session, dice: fakeDice(), at: null };
}

/** Pages `names`, 1,000 chips each, synced at T0; the craps table switched
 *  on by the first unless `owner` (an owner-run table). */
async function room(names: string[], owner = false): Promise<UIPage[]> {
  const pages: UIPage[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadUIPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  if (!owner) switchOn(pages[0], TABLE, INC);
  sync(T0, ...pages);
  return pages;
}

interface AtCraps {
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
function boxAt(type: CrapsBet['type'], pick?: number): FeltPoint {
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

/** Mount the focused craps table on page p, a player at `stand` (null: the
 *  device front), the house with `house`. */
function atCraps(p: UIPage, opts: { stand?: number | null; house?: boolean } = {}): AtCraps {
  const ui = p.session.createCasinoTableUI({
    itemId: TABLE, game: 'craps', isHouse: () => opts.house ?? false, stand: opts.stand ?? null, visual: p.dice.h,
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

/** The HUD hints shown (walking off the table), in order. */
const hints = (): string[] => body.children.filter((c) => c.id === 'hud-hint').flatMap((c) => c.texts);

// ── Time ─────────────────────────────────────────────────────────────────────

const T0 = 2_000_000_000;
const STEP = 200;
const W_MS = 16_000;
const WAIT_MS = 20_000;
const SHOW = 6_000;
const GRACE = 10_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
  body.children = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One frame of page p at T, as World runs it: its computed duties, every
 *  table's pieces, then its focused table. */
function frameOf(p: UIPage, T: number): void {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  p.table.tickComputedTables([REF], now);
  p.session.casinoTablesFrame(1 / 60, new Map([[TABLE, p.dice.h]]));
  p.at?.update();
}

/** Frames of `pages` every STEP ms from `from` to `to`, synced before and
 *  after each; stops early, returning the time, once `until` holds. */
function go(pages: UIPage[], from: number, to: number, until?: () => boolean): number {
  for (let T = from; T <= to; T += STEP) {
    sync(T, ...pages);
    for (const p of pages) frameOf(p, T);
    sync(T, ...pages);
    if (until?.()) return T;
  }
  return to + STEP;
}

const bet = (type: CrapsBet['type'], amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const myFelt = (p: Page, r: number): CrapsBet[] => p.table.readMyComputedCrapsBets(TABLE, p.pid, r).felt;
/** How page p's player is named on screen (no games doc: the id's head). */
const nameOf = (p: Page): string => p.pid.slice(0, 8).toUpperCase();
/** The hash of roll r's close on page p (the first). */
const closeOf = (p: Page, r: number): string | undefined => {
  const k = keysIn(p, 'c', r, TABLE)[0];
  return k?.slice(k.lastIndexOf(':') + 1);
};
/** The stickman's toss for a close: its log line. */
const tossOf = (hash: string): string => `throw ${parseInt(hash.slice(0, 8), 16) % 2 ** 31}`;
const throws = (log: readonly string[]): string[] => log.filter((e) => e.startsWith('throw '));

function decide(pages: UIPage[], r: number, from: number, to = from + 60_000): number {
  const at = go(pages, from, to, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === r && v.decided !== null)));
  if (at > to) throw new Error(`roll ${r} never decided`);
  return at;
}

/** Frames until every page shows roll r taking bets on the timer: then,
 *  and when its betting ends (W) and its wait (D). */
function openRoll(pages: UIPage[], r: number, from: number): { T: number; W: number; D: number } {
  const T = go(pages, from, from + 60_000, () => pages.every((p) => crapsOf(p)?.round === r && crapsOf(p)?.phaseDeadline !== undefined)) + STEP;
  const W = crapsOf(pages[0], T)!.phaseDeadline!;
  return { T, W, D: W + WAIT_MS };
}

/** Pages `names` at stands `stands`, pass line bets (`amounts`) on roll 1,
 *  which rolls a 6: the point is on, every pass riding on it, the dice with
 *  the first stand clockwise (the one at 3 before the one at 1). */
async function pointOn(names: string[], stands: (number | null)[], amounts = [10, 5, 20]) {
  const pages = await room(names);
  pages.forEach((p, i) => standAt(p, stands[i] ?? null));
  rigRoll(pages, 1, 6);
  for (const [i, p] of pages.entries()) expect(crapsBet(p, [bet('pass', amounts[i])], T0)).toBe('ok');
  sync(T0, ...pages);
  const decidedAt = decide(pages, 1, T0 + STEP);
  for (const p of pages) expect(carryOf(p).p).toBe(6);
  return { pages, decidedAt };
}

// ── Betting on the computed felt ─────────────────────────────────────────────

describe('bets on the computed felt', () => {
  it('odds go up behind a riding pass line, and behind a come bet that travelled', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    rigRoll(pages, 2, 8);
    const t = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    // A's pass rides from roll 1 (the owner-run felt has nothing to back).
    expect(a.casino.readMyCrapsBets(TABLE, a.pid)).toEqual([]);
    t.pick('2');
    t.click('passodds');
    expect(myFelt(a, 2)).toEqual(expect.arrayContaining([bet('pass', 10), bet('passodds', 5)]));
    // The hand stays loaded: a 5 on the come too.
    t.click('come');
    expect(myFelt(a, 2)).toHaveLength(3);
    expect(myFelt(a, 2)).toContainEqual(bet('come', 5));
    go(pages, T, W + STEP);
    b.table.noteComputedFling(TABLE, 2, 9, W + 2 * STEP);
    const at = decide(pages, 2, W + 2 * STEP);
    expect(carryOf(a).p).toBe(6);
    expect(carryOf(a).w[a.pid]).toContainEqual(bet('come', 5, 8));
    const { T: T3 } = openRoll(pages, 3, at + STEP);
    t.click('comeodds', 8);
    expect(myFelt(a, 3)).toContainEqual(bet('comeodds', 5, 8));
    expect(t.heard().filter((s) => /ODDS|NO .* BET|RULES/.test(s))).toEqual([]);
    go(pages, T3, T3 + STEP);
    expect(foldOf(b).felts.get(a.pid)?.rec.b).toContainEqual(bet('comeodds', 5, 8));
  }, 30_000); // the file's first spec pays its warm-up

  it('THE TABLE IS FULL counts the riders, gone ones too; the card names the riders whose key the room never saw', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(b, 3);
    rigRoll([b], 1, 6);
    expect(crapsBet(b, [bet('pass', 10)], T0)).toBe('ok');
    const at = decide(pages, 1, T0 + STEP);
    // Thirty riders nobody in this room knows, B's pass the thirty-first.
    // (One of them named to break the card's markup: it shows as text.)
    const riders = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i === 0 ? '<i>rider' : `rider-${String(i).padStart(2, '0')}`, [bet('place', 6, 8)]]));
    // A's card is open before the trim: the page keeps what it said of roll 1.
    const t = atCraps(a, { stand: 1 });
    expect(t.card()).toContain('THE POINT IS 6');
    const show = crapsOf(a)!.resultAt + SHOW;
    const carry = carryOf(a);
    clockOf(a, at + STEP);
    trimByHand(a, testIdentity('trimmer'), undefined, TABLE, { ...carry, w: { ...carry.w, ...riders } });
    sync(at + STEP, a, b);
    go(pages, at + 2 * STEP, show + STEP);
    expect(crapsOf(a)!.riders).toBe(31);
    t.pick('2');
    t.click('place', 6);
    expect(t.said()).toBe('THE TABLE IS FULL — WAIT FOR A PLACE');
    expect(myFelt(a, 2)).toEqual([]);
    const card = t.card();
    expect(card).toContain('THE POINT IS 6 · 31 PLAYERS HAVE BETS RIDING');
    expect(card).toContain('🚩 30 RIDERS HAVE A KEY THIS ROOM HAS NEVER SEEN · &lt;I&gt;RIDER · RIDER-01 · RIDER-02 · RIDER-03 · AND 26 MORE');
    expect(card).not.toContain('<I>');
    // (The checkpoint hands on riders this page never folded: a flag, the nets as they were.)
    expect(card).toContain("🚩 THE CHECKPOINT'S POINT OR RIDING BETS DIFFER FROM THIS PAGE'S");
    expect(card).not.toContain('THE CHECKPOINT DIFFERS FROM THIS PAGE BY');
  });

  it('two newcomers bet in one window with one place left: the second in pid order reads THE TABLE WAS FULL — YOUR NEW BETS CAME BACK', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    standAt(a, 1);
    standAt(b, 3);
    standAt(c, 5);
    rigRoll([b], 1, 6);
    expect(crapsBet(b, [bet('pass', 10)], T0)).toBe('ok');
    const at = decide(pages, 1, T0 + STEP);
    // Twenty-nine riders nobody here knows, B's pass the thirtieth: one place left.
    const riders = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`rider-${String(i).padStart(2, '0')}`, [bet('place', 6, 8)]]));
    const show = crapsOf(a)!.resultAt + SHOW;
    const carry = carryOf(a);
    clockOf(a, at + STEP);
    trimByHand(a, testIdentity('trimmer'), undefined, TABLE, { ...carry, w: { ...carry.w, ...riders } });
    sync(at + STEP, ...pages);
    go(pages, at + 2 * STEP, show + STEP);
    expect(crapsOf(a)!.riders).toBe(30);
    // A and C each bet before hearing the other.
    const T = show + 2 * STEP;
    for (const p of [a, c]) expect(crapsBet(p, [bet('field', 5)], T)).toBe('ok');
    const [first, second] = [a, c].sort((x, y) => (x.pid < y.pid ? -1 : 1));
    const ts = atCraps(second, { stand: second === a ? 1 : 5 });
    const { T: T2, W } = openRoll(pages, 2, T + STEP);
    go(pages, T2, W - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, W);
    const d = decide(pages, 2, W);
    go(pages, d + STEP, d + 3 * STEP);
    const fates = foldOf(b).rounds.find((v) => v.r === 2)!.craps!.fates;
    expect(fates.get(first.pid)).toBe('ok');
    expect(fates.get(second.pid)).toBe('full');
    expect(ts.status()).toMatch(/ · THE TABLE WAS FULL — YOUR NEW BETS CAME BACK$/);
    expect(second.casino.readChips(second.pid)).toBe(1_000);
  });

  it('a spot taken back once betting has closed stays put: NO MORE BETS — THOSE CHIPS STAY', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, T);
    ta.pick('1', 6);
    ta.click('place', 8);
    go(pages, T + STEP, W + STEP);
    expect(crapsOf(a)?.phase).toBe('closing');
    ta.takeBack('place', 8);
    expect(ta.said()).toBe('NO MORE BETS — THOSE CHIPS STAY');
    expect(myFelt(a, 2)).toContainEqual(bet('place', 6, 8));
  });

  it('↶ takes down every bet that may come off, the line bet staying up', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, T);
    ta.pick('1', 6);
    ta.click('place', 8);
    ta.key('0');
    ta.pick('2');
    ta.click('field');
    expect(myFelt(a, 2)).toEqual(expect.arrayContaining([bet('pass', 10), bet('place', 6, 8), bet('field', 5)]));
    go(pages, T + STEP, T + 3 * STEP);
    ta.key('c');
    expect(ta.said()).toBe('TAKEN DOWN — 11 BACK TO YOUR RAIL · YOUR LINE BETS STAY UP');
    expect(myFelt(a, 2)).toEqual([bet('pass', 10)]);
    go(pages, T + 4 * STEP, T + 6 * STEP);
    expect(foldOf(pages[1]).felts.get(a.pid)?.rec.b).toEqual([bet('pass', 10)]);
  });

  it('taking back a spot of merged chips puts them back in the hand as the felt draws them', async () => {
    const [a] = await room(['A']);
    const t = atCraps(a, { stand: 1 });
    go([a], T0, T0 + STEP);
    t.pick('1', 6);
    t.click('place', 6);
    expect(myFelt(a, 1)).toEqual([bet('place', 6, 6)]);
    t.key('0');
    expect(a.dice.hand()).toEqual([]);
    t.takeBack('place', 6);
    expect(myFelt(a, 1)).toEqual([]);
    expect(a.dice.hand()).toEqual([5, 1]);
    t.click('place', 8);
    expect(myFelt(a, 1)).toEqual([bet('place', 6, 8)]);
  });

  it('the box and player caps count the chips the felt draws; walking off names four bets and the rest', async () => {
    const [a] = await room(['A']);
    a.casino.buyInChips(a.pid, 440_000);
    const t = atCraps(a, { stand: 1 });
    go([a], T0, T0 + STEP);
    // Eighty 1s on the field: one amount, drawn as 3 × 25 + 5.
    t.pick('1', 40);
    t.click('field');
    t.click('field');
    expect(myFelt(a, 1)).toEqual([bet('field', 80)]);
    t.key('0');
    // Forty 1,000s a box: a second forty in one is past 60 chips drawn.
    t.pick('6', 40);
    t.click('place', 4);
    t.click('place', 4);
    expect(t.said()).toBe('THAT BOX IS FULL — 60 CHIPS A BOX');
    expect(myFelt(a, 1)).toContainEqual(bet('place', 40_000, 4));
    // Nine boxes of forty and the field's four: a tenth is past 400 drawn.
    for (const [type, pick] of [['place', 5], ['place', 6], ['place', 8], ['place', 9], ['place', 10], ['big6'], ['big8'], ['hard', 4]] as const) {
      t.click(type, pick);
    }
    expect(myFelt(a, 1)).toHaveLength(10);
    t.click('hard', 6);
    expect(t.said()).toBe('YOU HAVE 400 CHIPS DOWN — THE TABLE LIMIT');
    expect(myFelt(a, 1)).toHaveLength(10);
    t.key('0');
    t.unmount();
    expect(hints()).toEqual([
      "YOUR BETS RIDE WHILE YOU'RE AWAY — BIG 6 40000 · BIG 8 40000 · FIELD 80 · HARD 4 40000 · AND 6 MORE",
    ]);
  });
});

// ── The shooter and the dice ─────────────────────────────────────────────────

describe('the shooter and the dice', () => {
  it("a throw record from another page, even in the shooter's name, neither stands for the shooter's fling nor closes their page, and doesn't fly on their screen", async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [3, 1]);
    const [a, b] = pages;
    expect(carryOf(a)).toMatchObject({ h: a.pid, i: 1 });
    rigRoll(pages, 2, 6);
    const ta = atCraps(a, { stand: 3, house: true });
    const tb = atCraps(b, { stand: 1 });
    const { T, W, D } = openRoll(pages, 2, decidedAt + STEP);
    expect(tb.status()).toMatch(new RegExp(`^🎲 THE POINT IS 6 — PLACE YOUR BETS · ${nameOf(a)} HAS THE DICE · \\d+s$`));
    expect(ta.status()).toMatch(/^🎲 THE POINT IS 6 — PLACE YOUR BETS · YOU HAVE THE DICE · \d+s$/);
    go(pages, T, W + 1_000);
    expect(ta.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM ACROSS THE TABLE · \d+s$/);
    expect(tb.status()).toMatch(new RegExp(`^✋ NO MORE BETS — ${nameOf(a)} IS SHOOTING · \\d+s$`));
    // The house's switch-off waits while the shooter can still throw.
    expect(ta.card()).toContain('WAIT FOR THE ROLL TO FINISH');
    const markA = a.dice.log.length;
    const markB = b.dice.log.length;
    // B's page writes a throw for the roll, in A's name.
    clockOf(b, W + 1_100);
    b.casino.writeDiceThrow(TABLE, { round: 2, by: a.pid, sx: 0, sz: 0, dx: 0, dz: 1, power: 0.7, seed: 4242 });
    go(pages, W + 1_200, W + 6_000);
    expect(throws(a.dice.log.slice(markA))).toEqual([]);
    expect(keysIn(a, 'c', 2, TABLE)).toEqual([]);
    expect(ta.status()).toMatch(/^🎲 YOUR ROLL/);
    clockOf(a, W + 6_100);
    ta.key('r');
    const thr = a.casino.readDiceThrow(TABLE)!;
    expect(thr).toMatchObject({ round: 2, by: a.pid });
    expect(thr.seed).not.toBe(4242);
    expect(throws(a.dice.log.slice(markA))).toEqual([`throw ${thr.seed}`]);
    const at = decide(pages, 2, W + 6_200);
    expect(at).toBeLessThan(D);
    expect(closeOf(a, 2)).toBeDefined();
    expect(keysIn(a, 'c', 2, TABLE).map((k) => (a.casino.computedSessionForWrite(TABLE)!.get(k) as { k: string }).k)).toEqual([a.pub]);
    go(pages, at + STEP, at + 2 * STEP);
    // One flight on each page, landing on the roll's faces.
    const faces = `land ${foldOf(a).rounds.find((v) => v.r === 2)!.craps!.dice!.join('')}`;
    expect(throws(a.dice.log.slice(markA))).toEqual([`throw ${thr.seed}`]);
    expect(a.dice.log.at(-1)).toBe(faces);
    // (Elsewhere the first throw heard in the shooter's name flies: a throw
    // record is nobody's to sign, and only animates.)
    expect(throws(b.dice.log.slice(markB))).toEqual(['throw 4242']);
    expect(b.dice.log.at(-1)).toBe(faces);
    // A's pass and B's pass win on the point made; the shooter keeps the dice.
    expect(ta.status()).toMatch(/^● \d \+ \d = 6 — WINNER, POINT MADE · \+10$/);
    expect(tb.status()).toMatch(/^● \d \+ \d = 6 — WINNER, POINT MADE · \+5$/);
    expect(ta.lines()).toContain('🎲 THE DICE ARE ROLLING…');
  });

  it('the shooter picks the dice up and flicks them: a flick too slow drops them, saying so; a fast one throws from their page, which closes the roll', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [3, 1]);
    const [a] = pages;
    const ta = atCraps(a, { stand: 3 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    expect(ta.status()).toMatch(/^🎲 YOUR ROLL/);
    const markA = a.dice.log.length;
    clockOf(a, W + 1_050);
    ta.fling([{ x: 0, z: 0.2 }, { x: 0, z: 0.2 }], 20);
    expect(ta.said()).toBe('FLICK THE DICE HARDER TO THROW THEM');
    expect(a.casino.readDiceThrow(TABLE)).toBeNull();
    go(pages, W + 1_200, W + 2_000);
    expect(keysIn(a, 'c', 2, TABLE)).toEqual([]);
    expect(a.dice.state()).toBe('rest');
    expect(ta.status()).toMatch(/^🎲 YOUR ROLL/);
    clockOf(a, W + 2_050);
    ta.fling([{ x: 0, z: 0.3 }, { x: 0, z: 0.1 }, { x: 0, z: -0.1 }, { x: 0, z: -0.3 }], 20);
    const thr = a.casino.readDiceThrow(TABLE)!;
    expect(thr).toMatchObject({ round: 2, by: a.pid, power: 1 });
    expect(throws(a.dice.log.slice(markA))).toEqual([`throw ${thr.seed}`]);
    decide(pages, 2, W + 2_200);
    expect(keysIn(a, 'c', 2, TABLE).map((k) => (a.casino.computedSessionForWrite(TABLE)!.get(k) as { k: string }).k)).toEqual([a.pub]);
    expect(throws(a.dice.log.slice(markA))).toEqual([`throw ${thr.seed}`]);
  });

  it('a point made by a shooter off the table, nobody counted at a stand: THE STICKMAN HAS THE DICE', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    expect(carryOf(a)).toMatchObject({ h: b.pid, i: 1 });
    // Both step off; A, off the table, bets the field to start roll 2: a 6.
    // Neither slip has a stand on it.
    standAt(a, null);
    standAt(b, null);
    rigRoll(pages, 2, 6);
    const ta = atCraps(a, { stand: null });
    const show = crapsOf(a)!.resultAt + SHOW;
    go(pages, decidedAt + STEP, show + STEP);
    expect(crapsBet(a, [...myFelt(a, 2), bet('field', 5)], show + 2 * STEP)).toBe('ok');
    const { T, W } = openRoll(pages, 2, show + 3 * STEP);
    go(pages, T, W + 1_000);
    const at = decide(pages, 2, W + 1_200);
    go(pages, at + STEP, at + 3 * STEP);
    expect(crapsOf(a)).toMatchObject({ phase: 'settled', round: 2, holderBefore: b.pid });
    expect(crapsOf(a)!.shooterAfter).toBeUndefined();
    expect(ta.status()).toMatch(/^● \d \+ \d = 6 — WINNER, POINT MADE · \+5 · THE STICKMAN HAS THE DICE$/);
  });

  /** A and B with pass lines riding into roll 2 (B, at stand 3, has the
   *  dice), C at the device front with nothing on the table. */
  async function watched() {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll([a, b], 1, 6);
    for (const p of [a, b]) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(c)).toMatchObject({ p: 6, h: b.pid });
    const tb = atCraps(b, { stand: 3 });
    atCraps(c, { stand: null });
    return { pages, a, b, c, tb, decidedAt };
  }

  it("on a page that hears the close before the shooter's throw, the stickman's toss flies, not the throw", async () => {
    const { pages, a, b, c, tb, decidedAt } = await watched();
    const { T, W, D } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    // The shooter's time runs out on A's page, which closes; B's page and
    // C's hear nothing of it, and B's throws after the close.
    go([b, c], W + 1_200, D - 1_000);
    clockOf(b, D - 900);
    tb.key('r');
    const thr = b.casino.readDiceThrow(TABLE)!;
    expect(thr).toMatchObject({ round: 2, by: b.pid });
    const closedAt = go([a], W + 1_200, D + 10_000, () => closeOf(a, 2) !== undefined);
    expect(closedAt).toBeLessThan(D + 10_000);
    // The close reaches C's page first, the throw after it.
    const markC = c.dice.log.length;
    send(closedAt + 150, a, c);
    send(closedAt + 250, b, c);
    frameOf(c, closedAt + 300);
    expect(throws(c.dice.log.slice(markC))).toEqual([tossOf(closeOf(a, 2)!)]);
  });

  it("a throw in the name of a player who doesn't hold the dice never flies", async () => {
    const { pages, a, c, decidedAt } = await watched();
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    const markC = c.dice.log.length;
    clockOf(a, W + 1_100);
    a.casino.writeDiceThrow(TABLE, { round: 2, by: a.pid, sx: 0, sz: 0, dx: 0, dz: 1, power: 0.7, seed: 4242 });
    const at = go(pages, W + 1_200, W + 40_000, () => closeOf(c, 2) !== undefined);
    go(pages, at + STEP, at + STEP);
    expect(throws(c.dice.log.slice(markC))).toEqual([tossOf(closeOf(c, 2)!)]);
  });

  it("a page that first hears a roll settled flies the throw of the player who held the dice for it, though the dice have passed", async () => {
    const { pages, a, b, c, tb, decidedAt } = await watched();
    rigRoll([a, b], 2, 7);
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 500);
    clockOf(b, W + 600);
    tb.key('r');
    const thr = b.casino.readDiceThrow(TABLE)!;
    const markC = c.dice.log.length;
    const at = decide([a, b], 2, W + 800);
    expect(carryOf(a)).toMatchObject({ p: 0, h: a.pid });
    sync(at + STEP, ...pages);
    frameOf(c, at + STEP);
    expect(crapsOf(c)).toMatchObject({ phase: 'settled', round: 2, holderBefore: b.pid, shooterAfter: a.pid });
    expect(throws(c.dice.log.slice(markC))).toEqual([`throw ${thr.seed}`]);
  });

  it("a roll taken back to betting calls its flight off, and flies again at the close that comes after: the stickman's toss, never the throw from before", async () => {
    const { pages, b, c, tb, decidedAt } = await watched();
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    clockOf(b, W + 1_050);
    tb.key('r');
    const thr = b.casino.readDiceThrow(TABLE)!;
    // C hears the throw, and flies it; then A's and B's tabs go quiet, B's
    // before it closes. With no felt of its own C takes the roll back to
    // betting once every close turn has gone by.
    const markC = c.dice.log.length;
    send(W + 1_100, b, c);
    frameOf(c, W + 1_100);
    expect(throws(c.dice.log.slice(markC))).toEqual([`throw ${thr.seed}`]);
    const reopened = go([c], W + 1_200, W + 120_000, () => crapsOf(c)?.phase === 'betting');
    expect(reopened).toBeLessThan(W + 120_000);
    expect(crapsOf(c)).toMatchObject({ round: 2 });
    expect(c.dice.log.slice(markC)).toEqual([`throw ${thr.seed}`, 'cancel']);
    // B's tab wakes and closes the roll: C's dice fly for it at the close.
    const heard = go([b, c], reopened + STEP, reopened + 60_000, () => closeOf(c, 2) !== undefined);
    expect(heard).toBeLessThan(reopened + 60_000);
    const mark = c.dice.log.length;
    frameOf(c, heard + STEP);
    expect(crapsOf(c)).toMatchObject({ phase: 'closing', round: 2 });
    expect(c.dice.log.slice(mark)).toEqual([tossOf(closeOf(c, 2)!)]);
    expect(c.dice.state()).toBe('flying');
  });

  it("a throw heard with the goodbyes that take its roll back to betting never flies: at the close after, the stickman's toss does", async () => {
    const { pages, a, b, c, tb, decidedAt } = await watched();
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    // B flings and says goodbye before its page closes; A says goodbye too.
    clockOf(b, W + 1_050);
    tb.key('r');
    const thr = b.casino.readDiceThrow(TABLE)!;
    expect(thr).toMatchObject({ round: 2, by: b.pid });
    b.table.leaveComputedTables(W + 1_060);
    clockOf(a, W + 1_070);
    a.table.leaveComputedTables(W + 1_070);
    expect(closeOf(b, 2)).toBeUndefined();
    // C hears the throw and both goodbyes in one update: everyone with
    // chips on the roll has gone, and it goes back to betting at once.
    const markC = c.dice.log.length;
    sync(W + 1_100, ...pages);
    frameOf(c, W + 1_100);
    expect(crapsOf(c)).toMatchObject({ phase: 'betting', round: 2 });
    expect(c.dice.log.slice(markC)).toEqual([]);
    // C bets the field from off the table: the window opens, the stickman
    // throws (B gone), and C's page closes the roll.
    rigRoll([c], 2, 8);
    expect(crapsBet(c, [...myFelt(c, 2), bet('field', 5)], W + 1_200)).toBe('ok');
    const heard = go([c], W + 1_300, W + 120_000, () => closeOf(c, 2) !== undefined);
    expect(heard).toBeLessThan(W + 120_000);
    expect(throws(c.dice.log.slice(markC))).toEqual([tossOf(closeOf(c, 2)!)]);
    const shown = go([c], heard + STEP, heard + 30_000, () => crapsOf(c)?.phase === 'settled');
    go([c], shown + STEP, shown + 3 * STEP);
    expect(crapsOf(c)).toMatchObject({ phase: 'settled', round: 2 });
    expect(throws(c.dice.log.slice(markC))).toEqual([tossOf(closeOf(c, 2)!)]);
    expect(throws(c.dice.log)).not.toContain(`throw ${thr.seed}`);
  });

  it("a page that wakes to the close of a roll it took back to betting flies the stickman's toss, never the throw from before", async () => {
    const { pages, b, c, tb, decidedAt } = await watched();
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    clockOf(b, W + 1_050);
    tb.key('r');
    const thr = b.casino.readDiceThrow(TABLE)!;
    // C flies B's throw; B's tab goes quiet and C takes the roll back.
    const markC = c.dice.log.length;
    send(W + 1_100, b, c);
    frameOf(c, W + 1_100);
    const reopened = go([c], W + 1_200, W + 120_000, () => crapsOf(c)?.phase === 'betting');
    expect(reopened).toBeLessThan(W + 120_000);
    expect(c.dice.log.slice(markC)).toEqual([`throw ${thr.seed}`, 'cancel']);
    // B's page alone closes the roll; C's tab, hidden meanwhile, hears the
    // close on its first frame back, which counts a wake.
    const closedAt = go([b], reopened + STEP, reopened + 60_000, () => closeOf(b, 2) !== undefined);
    expect(closedAt).toBeLessThan(reopened + 60_000);
    const wakes = c.croupier.tablesWakeCount();
    const mark = c.dice.log.length;
    sync(closedAt + 7_000, b, c);
    frameOf(c, closedAt + 7_000);
    expect(c.croupier.tablesWakeCount()).toBe(wakes + 1);
    expect(crapsOf(c)).toMatchObject({ phase: 'closing', round: 2 });
    expect(crapsOf(c)!.rearmAt).toBeUndefined();
    expect(throws(c.dice.log.slice(mark))).toEqual([tossOf(closeOf(c, 2)!)]);
  });

  it("a page whose clock goes back after it took a roll back to betting still flies the throw the shooter makes after", async () => {
    const { pages, b, c, tb, decidedAt } = await watched();
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    const markC = c.dice.log.length;
    // A's and B's tabs go quiet; C, with no felt of its own, takes the roll
    // back to betting once every close turn has gone by. Then C's clock goes
    // back a minute.
    const reopened = go([c], W + 1_200, W + 120_000, () => crapsOf(c)?.phase === 'betting');
    expect(reopened).toBeLessThan(W + 120_000);
    const wakes = c.croupier.tablesWakeCount();
    c.skew -= 60_000;
    // A's and B's tabs come back: B is offered the fling and throws, and the
    // roll closes.
    const offered = go(pages, reopened + STEP, reopened + 120_000, () => /^🎲 YOUR ROLL/.test(tb.status()));
    expect(offered).toBeLessThan(reopened + 120_000);
    expect(c.croupier.tablesWakeCount()).toBe(wakes + 1);
    clockOf(b, offered + 50);
    tb.key('r');
    const thr = b.casino.readDiceThrow(TABLE)!;
    const heard = go(pages, offered + STEP, offered + 60_000, () => closeOf(c, 2) !== undefined);
    expect(heard).toBeLessThan(offered + 60_000);
    go(pages, heard + STEP, heard + 3 * STEP);
    expect(throws(c.dice.log.slice(markC))).toEqual([`throw ${thr.seed}`]);
  });

  it("while bets are open the dice lie with the stickman; once betting closes they wait at the shooter's stand", async () => {
    const { pages, c, decidedAt } = await watched();
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, T + STEP);
    expect(c.dice.rest()).toEqual(CRAPS_DICE_SPOT);
    go(pages, T + 2 * STEP, W + 2 * STEP);
    expect(crapsOf(c)).toMatchObject({ phase: 'closing', shooter: pages[1].pid });
    expect(c.dice.rest()).not.toBeNull();
    expect(c.dice.rest()).not.toEqual(CRAPS_DICE_SPOT);
  });

  it('a page loaded with the roll already closed flies nothing for it: the dice take its faces where they lie', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const tb = atCraps(b, { stand: 3 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    clockOf(b, W + 1_100);
    tb.key('r');
    const closedAt = go(pages, W + 1_200, W + 5_000, () => closeOf(a, 2) !== undefined);
    const a2 = await loadUIPage("A'", 9, { reloadOf: a });
    sync(closedAt, a2, b);
    atCraps(a2, { stand: 1 });
    const shown = go([a2, b], closedAt + STEP, closedAt + GRACE + 30_000, () => crapsOf(a2)?.phase === 'settled' && crapsOf(a2)?.round === 2);
    go([a2, b], shown + STEP, shown + 2 * STEP);
    expect(throws(a2.dice.log)).toEqual([]);
    expect(a2.dice.log.at(-1)).toMatch(/^land \d\d$/);
  });

  it("a throw and the close that arrive in one update fly the shooter's fling, not the stickman's toss", async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [3, 1]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 3 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    const markB = b.dice.log.length;
    clockOf(a, W + 1_100);
    ta.key('r');
    // A's page closes on its next frame, B's page hearing nothing meanwhile.
    go([a], W + 1_200, W + 1_200);
    const close = closeOf(a, 2)!;
    expect(close).toBeDefined();
    expect(closeOf(b, 2)).toBeUndefined();
    sync(W + 1_400, a, b);
    expect(closeOf(b, 2)).toBe(close);
    frameOf(b, W + 1_400);
    const thr = a.casino.readDiceThrow(TABLE)!;
    expect(throws(b.dice.log.slice(markB))).toEqual([`throw ${thr.seed}`]);
    expect(tossOf(close)).not.toBe(`throw ${thr.seed}`);
    decide(pages, 2, W + 1_600);
    expect(throws(b.dice.log.slice(markB))).toEqual([`throw ${thr.seed}`]);
  });

  it('a shooter in play with no bet down is told to put one down, offered no fling, and writes no throw; the others see they have no bet down; the stickman throws at the close', async () => {
    // Roll 1: A's pass at stand 1, B's field at stand 3. A 6: the point is
    // on, B's field lost, and the dice are B's.
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll(pages, 1, 6);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('field', 5)], T0)).toBe('ok');
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(a)).toMatchObject({ p: 6, h: b.pid, i: 1 });
    const ta = atCraps(a, { stand: 1 });
    const tb = atCraps(b, { stand: 3 });
    go(pages, decidedAt + STEP, decidedAt + 2 * STEP);
    expect(tb.status()).toMatch(/^● \d \+ \d = 6 — THE POINT IS 6 · −5 · THE DICE PASS TO YOU$/);
    expect(ta.status()).toMatch(new RegExp(`^● \\d \\+ \\d = 6 — THE POINT IS 6 · THE DICE PASS TO ${nameOf(b)}$`));
    const { T, W, D } = openRoll(pages, 2, decidedAt + 3 * STEP);
    expect(tb.status()).toMatch(/^🎲 THE POINT IS 6 — PLACE YOUR BETS · YOU HAVE THE DICE · PUT A BET DOWN TO THROW · \d+s$/);
    go(pages, T, W + 1_000);
    expect(tb.status()).toMatch(/^✋ NO MORE BETS — YOU HAVE NO BET DOWN · THE STICKMAN THROWS IN (19|20)s$/);
    expect(ta.status()).toMatch(new RegExp(`^✋ NO MORE BETS — ${nameOf(b)} HAS NO BET DOWN · THE STICKMAN THROWS IN (19|20)s$`));
    tb.key('r');
    expect(b.casino.readDiceThrow(TABLE)).toBeNull();
    expect(tb.said()).toBe('The dice are not yours to throw.');
    const marks = [a.dice.log.length, b.dice.log.length];
    const at = go(pages, W + 1_200, D + 10_000, () => closeOf(a, 2) !== undefined);
    expect(at).toBeGreaterThanOrEqual(D);
    decide(pages, 2, at + STEP);
    const toss = tossOf(closeOf(a, 2)!);
    expect(throws(a.dice.log.slice(marks[0]))).toEqual([toss]);
    expect(throws(b.dice.log.slice(marks[1]))).toEqual([toss]);
    expect(b.casino.readDiceThrow(TABLE)).toBeNull();
  });

  it('at a new table the stickman throws and hands the dice on: the call, a push, and THE DICE PASS TO YOU', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 3 });
    const tb = atCraps(b, { stand: 1 });
    go(pages, T0, T0 + STEP);
    expect(ta.status()).toBe('🎲 COME OUT — PLACE YOUR BETS');
    expect(ta.card()).toContain('COME OUT · NO BETS RIDING · THE STICKMAN HAS THE DICE');
    rigRoll(pages, 1, 12);
    ta.pick('2', 2);
    ta.click('pass');
    tb.pick('2', 2);
    tb.click('dontpass');
    const { T, W } = openRoll(pages, 1, T0 + 2 * STEP);
    expect(ta.status()).toMatch(/^🎲 COME OUT — PLACE YOUR BETS · \d+s$/);
    const marks = [a.dice.log.length, b.dice.log.length];
    const at = decide(pages, 1, T);
    expect(at).toBeGreaterThanOrEqual(W);
    go(pages, at + STEP, at + 2 * STEP);
    const toss = tossOf(closeOf(a, 1)!);
    expect(throws(a.dice.log.slice(marks[0]))).toEqual([toss]);
    expect(throws(b.dice.log.slice(marks[1]))).toEqual([toss]);
    // On B's page, in order (A's page closed the roll, so went straight to
    // its slip in the close): nobody shoots, B's seed awaited, the others',
    // the dice in the air.
    const seen = (t: AtCraps, ...want: string[]): number[] => want.map((w) => t.lines().indexOf(w));
    const byA = (a.casino.computedSessionForWrite(TABLE)!.get(keysIn(a, 'c', 1, TABLE)[0]) as { k: string }).k === a.pub;
    const [closer, other] = byA ? [ta, tb] : [tb, ta];
    const order = seen(other, '✋ NO MORE BETS — THE STICKMAN THROWS', '✋ NO MORE BETS — STAY UNTIL THE DICE LAND',
      '✋ NO MORE BETS — WAITING FOR SEEDS', '🎲 THE DICE ARE ROLLING…');
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), JSON.stringify(other.lines())).toBe(true);
    expect(seen(closer, '✋ NO MORE BETS — STAY UNTIL THE DICE LAND', '🎲 THE DICE ARE ROLLING…').every((i) => i >= 0)).toBe(true);
    expect(ta.status()).toBe('● 6 + 6 = 12 — CRAPS, LINE LOSES · −10 · THE DICE PASS TO YOU');
    expect(tb.status()).toBe(`● 6 + 6 = 12 — CRAPS, LINE LOSES · PUSH · THE DICE PASS TO ${nameOf(a)}`);
    const card = ta.card();
    expect(card).toContain('🔓 LAST ROLL · ROLL 1 · 6 + 6 = 12 — CRAPS, LINE LOSES · 2 OF 2 SEEDS COUNTED · DECIDED BY ALL REVEALS · ✓ YOUR SLIP WAS FROZEN');
    expect(card).toMatch(/COME OUT · (NO BETS RIDING|1 PLAYER HAS BETS RIDING) · YOU HAVE THE DICE/);
    // Roll 2, B's bet down: A holds the dice in play with no bet of theirs.
    const show = crapsOf(a)!.resultAt + SHOW;
    go(pages, at + 3 * STEP, show + STEP);
    tb.pick('2');
    tb.click('field');
    const { T: T2 } = openRoll(pages, 2, show + 2 * STEP);
    expect(ta.status()).toMatch(/^🎲 COME OUT — PLACE YOUR BETS · YOU HAVE THE DICE · PUT A BET DOWN TO THROW AND KEEP THE DICE · \d+s$/);
    expect(tb.status()).toMatch(new RegExp(`^🎲 COME OUT — PLACE YOUR BETS · ${nameOf(a)} HAS THE DICE · \\d+s$`));
    ta.pick('2');
    ta.click('pass');
    go(pages, T2, T2);
    expect(ta.status()).toMatch(/^🎲 COME OUT — PLACE YOUR BETS · YOU HAVE THE DICE · \d+s$/);
  });

  it('wins and losses that cancel read ±0', async () => {
    const [a] = await room(['A']);
    const ta = atCraps(a, { stand: 1 });
    go([a], T0, T0 + STEP);
    rigRoll([a], 1, 7);
    ta.pick('2', 2);
    ta.click('pass');
    ta.click('dontpass');
    const at = decide([a], 1, T0 + 2 * STEP);
    go([a], at + STEP, at + 2 * STEP);
    expect(ta.status()).toMatch(/^● \d \+ \d = 7 — A NATURAL, PASS WINS · ±0 · THE DICE PASS TO YOU$/);
  });

  it('a lone shooter who sevens out gets the dice back, and only they read so; walking off and back tells what the table did meanwhile', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [3, 1]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 3 });
    const tb = atCraps(b, { stand: 1 });
    go(pages, decidedAt + STEP, decidedAt + STEP);
    // B walks off with the pass riding: not counted at the stand on roll 2.
    tb.unmount();
    expect(hints()).toEqual(["YOUR BETS RIDE WHILE YOU'RE AWAY — PASS LINE 5"]);
    rigRoll(pages, 2, 7);
    const { T, W } = openRoll(pages, 2, decidedAt + 2 * STEP);
    go(pages, T, W + 500);
    clockOf(a, W + 600);
    ta.key('r');
    const at = decide(pages, 2, W + 800);
    go(pages, at + STEP, at + 2 * STEP);
    expect(carryOf(a)).toMatchObject({ p: 0, h: a.pid });
    expect(ta.status()).toMatch(/^● \d \+ \d = 7 — SEVEN OUT · −10 · THE DICE COME BACK TO YOU$/);
    const back = atCraps(b, { stand: 1 });
    expect(back.status()).toMatch(/^● \d \+ \d = 7 — SEVEN OUT · −5$/);
    expect(back.heard()).toContain('WHILE YOU WERE AWAY — 1 ROLL · −5');
    // Said once: stepping off and on again with nothing riding says nothing.
    back.unmount();
    const again = atCraps(b, { stand: 1 });
    expect(again.heard().filter((s) => s.startsWith('WHILE YOU WERE AWAY'))).toEqual([]);
    expect(hints()).toHaveLength(1);
  });
});

// ── The wait for the shooter, as the other pages see it ──────────────────────

describe('walking off and back', () => {
  it('back before any roll: nothing to tell; back after one: what it came to since walking off, not before', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    // Roll 1, a 6: A's field bet loses 5, the point is on.
    rigRoll(pages, 1, 6);
    expect(crapsBet(a, [bet('pass', 10), bet('field', 5)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    let ta = atCraps(a, { stand: 1 });
    const tb = atCraps(b, { stand: 3 });
    go(pages, decidedAt + STEP, decidedAt + 2 * STEP);
    expect(ta.status()).toMatch(/^● \d \+ \d = 6 — THE POINT IS 6 · −5 · /);
    ta.unmount();
    ta = atCraps(a, { stand: 1 });
    expect(ta.heard().filter((x) => x.startsWith('WHILE YOU WERE AWAY'))).toEqual([]);
    ta.unmount();
    // Roll 2 while A is off the table: a 6, the point made, A's pass +10.
    standAt(a, null);
    rigRoll(pages, 2, 6);
    const { T, W } = openRoll(pages, 2, decidedAt + 3 * STEP);
    go(pages, T, W + 500);
    clockOf(b, W + 600);
    tb.key('r');
    const at = decide(pages, 2, W + 800);
    go(pages, at + STEP, at + 2 * STEP);
    standAt(a, 1);
    ta = atCraps(a, { stand: 1 });
    expect(ta.heard()).toContain('WHILE YOU WERE AWAY — 1 ROLL · +10');
  });

  it('back at a table that is another incarnation now: nothing to tell of the old one', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    const ta = atCraps(a, { stand: 1 });
    go(pages, T0, T0 + STEP);
    expect(crapsBet(a, [bet('pass', 10)], T0 + STEP)).toBe('ok');
    ta.unmount();
    expect(hints()).toEqual(["YOUR BETS RIDE WHILE YOU'RE AWAY — PASS LINE 10"]);
    // The house switches the table off and on again: a new incarnation,
    // whose first roll B plays.
    clockOf(b, T0 + 2 * STEP);
    sync(T0 + 2 * STEP, ...pages);
    expect(b.table.switchComputedOff(TABLE, T0 + 2 * STEP)).toBe('ok');
    go(pages, T0 + 3 * STEP, T0 + 10 * STEP);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    const INC2 = `k${'6b'.repeat(12)}`;
    clockOf(b, T0 + 11 * STEP);
    switchOn(b, TABLE, INC2);
    sync(T0 + 11 * STEP, ...pages);
    expect(a.casino.computedIncOf(TABLE)).toBe(INC2);
    expect(crapsBet(b, [bet('pass', 5)], T0 + 12 * STEP)).toBe('ok');
    sync(T0 + 12 * STEP, ...pages);
    const at = decide(pages, 1, T0 + 13 * STEP);
    go(pages, at + STEP, at + 2 * STEP);
    expect(a.table.computedTally(TABLE)).toMatchObject({ inc: INC2, roll: 1 });
    const back = atCraps(a, { stand: 1 });
    expect(back.heard().filter((x) => x.startsWith('WHILE YOU WERE AWAY'))).toEqual([]);
  });
});

describe('the wait for the shooter, on the other pages', () => {
  it("WAITING FOR a shooter off the table; who then keeps the dice out of play: THE STICKMAN THROWS THIS ONE", async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    expect(carryOf(a)).toMatchObject({ h: b.pid, i: 1 });
    standAt(b, null);
    rigRoll(pages, 2, 8);
    const ta = atCraps(a, { stand: 1 });
    const { T, W, D } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    expect(ta.status()).toMatch(new RegExp(`^✋ NO MORE BETS — WAITING FOR ${nameOf(b)} · THE STICKMAN THROWS IN (19|20)s$`));
    const at = decide(pages, 2, W + 1_200);
    expect(at).toBeGreaterThanOrEqual(D);
    expect(carryOf(a)).toMatchObject({ p: 6, h: b.pid });
    const { T: T3 } = openRoll(pages, 3, at + STEP);
    expect(ta.status()).toMatch(new RegExp(`^🎲 THE POINT IS 6 — PLACE YOUR BETS · ${nameOf(b)} HAS THE DICE · THE STICKMAN THROWS THIS ONE · \\d+s$`));
    go(pages, T3, T3);
    expect(ta.card()).toContain(`THE POINT IS 6 · 2 PLAYERS HAVE BETS RIDING · ${nameOf(b)} HAS THE DICE · THE STICKMAN THROWS NEXT`);
    // B, looking on from off the table, reads it too.
    const tb = atCraps(b, { stand: null });
    expect(tb.status()).toMatch(/^🎲 THE POINT IS 6 — PLACE YOUR BETS · YOU HAVE THE DICE · THE STICKMAN THROWS THIS ONE · \d+s$/);
  });

  it('HAS GONE: the shooter said goodbye', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, T + 1_000);
    clockOf(b, T + 1_100);
    b.table.leaveComputedTables(T + 1_100);
    sync(T + 1_100, a, b);
    expect(foldOf(a).felts.get(b.pid)?.rec).toMatchObject({ l: 1 });
    go([a], T + 1_200, W + 1_000);
    expect(ta.status()).toMatch(new RegExp(`^✋ NO MORE BETS — ${nameOf(b)} HAS GONE · THE STICKMAN THROWS IN (19|20)s$`));
  });

  it("ISN'T HERE: the shooter's page wrote nothing for the roll, their bets riding; the stickman throws, and the card says whose seed settled it", async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T, W, D } = openRoll([a], 2, decidedAt + STEP);
    go([a], T, W + 1_000);
    expect(ta.status()).toMatch(new RegExp(`^✋ NO MORE BETS — ${nameOf(b)} ISN'T HERE · THE STICKMAN THROWS IN (19|20)s$`));
    const mark = a.dice.log.length;
    const at = decide([a], 2, W + 1_200);
    expect(at).toBeGreaterThanOrEqual(D);
    go([a], at + STEP, at + 2 * STEP);
    expect(throws(a.dice.log.slice(mark))).toEqual([tossOf(closeOf(a, 2)!)]);
    const card = ta.card();
    expect(card).toMatch(/🔓 LAST ROLL · ROLL 2 · \d \+ \d = \d+ — [^·]+ · 1 OF 1 SEED COUNTED · DECIDED BY ALL REVEALS · 1 PLAYER'S BETS RODE WITHOUT A SEED · ✓ YOUR SLIP WAS FROZEN/);
    expect(card).toContain("🚩 ONE PLAYER'S SEED SETTLED ROLL 2 WHILE 1 OTHER HAD BETS RIDING");
  });

  it('THE BETTORS HAVE GONE QUIET: every close turn gone by with none, and no chips of mine on the roll', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(b, 1);
    expect(crapsBet(b, [bet('field', 5)], T0)).toBe('ok');
    sync(T0, a, b);
    const ta = atCraps(a, { stand: 3 });
    const quiet = /^✋ NO MORE BETS — THE BETTORS HAVE GONE QUIET · BETTING REOPENS IN \d+s$/;
    const at = go([a], T0 + STEP, T0 + 60_000, () => quiet.test(ta.status()));
    expect(at).toBeLessThan(T0 + 60_000);
    expect(at).toBeGreaterThan(T0 + W_MS);
    expect(keysIn(a, 'c', 1, TABLE)).toEqual([]);
  });
});

// ── A roll shown again ───────────────────────────────────────────────────────

describe('a roll shown again', () => {
  it("a throw from before a re-show of the roll before never flies after it: the shooter is offered the fling again, TIME'S UP when it goes by, and the stickman's toss flies at the close", async () => {
    const pages = await room(['A', 'B']);
    // w holds the dice before and after its forfeit rewrites roll 1 (both
    // seeds a 6, w's alone an 8): first in rank, at the ring's first stand.
    const [w, x] = byRank(pages, 'forfeit', 1, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigSplit(pages, 1, 6, w, 8);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid, i: 1 });
    const tw = atCraps(w, { stand: 3 });
    const tx = atCraps(x, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    clockOf(w, W + 1_050);
    tw.key('r');
    const old = w.casino.readDiceThrow(TABLE)!;
    // The rewrite lands before w's next frame; x hears both in one update.
    const F = W + 1_100;
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    const markX = x.dice.log.length;
    go(pages, W + 1_200, W + 1_200);
    expect(keysIn(w, 'c', 2, TABLE)).toEqual([]);
    for (const t of [tw, tx]) expect(t.heard()).toContain('ROLL 1 WAS REWRITTEN — NEW DICE');
    // (The roll on screen rewritten: no earlier roll changed under it.)
    for (const t of [tw, tx]) expect(t.heard().filter((x) => /^ROLL \d+ CHANGED/.test(x))).toEqual([]);
    expect(crapsOf(x)).toMatchObject({ phase: 'settled', round: 1, result: 8, point: 8 });
    // x's dice tossed again for the new faces (never the fling for roll 2).
    expect(throws(x.dice.log.slice(markX))).toEqual([tossOf(foldOf(x).rounds[0].close)]);
    const open = go(pages, W + 1_400, F + SHOW + 5_000, () => pages.every((p) => crapsOf(p)?.phase === 'betting'));
    const W2 = crapsOf(w, open)!.phaseDeadline!;
    expect(W2).toBe(F + SHOW + W_MS);
    go(pages, open + STEP, W2 + 1_000);
    expect(tw.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM/);
    const at = go(pages, W2 + 1_200, W2 + WAIT_MS + 5_000, () => closeOf(x, 2) !== undefined);
    expect(at).toBeGreaterThanOrEqual(W2 + WAIT_MS);
    go(pages, at + STEP, at + STEP);
    expect(tw.lines()).toContain("✋ TIME'S UP — THE STICKMAN THREW");
    const flown = throws(x.dice.log.slice(markX));
    expect(flown).not.toContain(`throw ${old.seed}`);
    expect(flown.at(-1)).toBe(tossOf(closeOf(x, 2)!));
  });

  /** w and x with pass lines on roll 1 (w first to forfeit it, at stand
   *  `wAt`; x at the other of 1 and 3), its seeds rigged by `rig`; roll 1
   *  decided, both tables mounted, roll 2 open and its betting over. With
   *  every seed counted the dice go to the one at 3 (first clockwise); with
   *  w's alone, to w. */
  async function shownAgain(rig: (pages: UIPage[], w: UIPage) => void, wAt = 1) {
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 1, CTX) as UIPage[];
    const xAt = wAt === 1 ? 3 : 1;
    standAt(w, wAt);
    standAt(x, xAt);
    rig(pages, w);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const decidedAt = decide(pages, 1, T0 + STEP);
    const tw = atCraps(w, { stand: wAt });
    const tx = atCraps(x, { stand: xAt });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    /** w's forfeit of roll 1, counting w's seed alone, at T. */
    const forfeit = (at: number): void => {
      clockOf(w, at);
      const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
      putIn(w, [[forfeitKey(f)!, f]], TABLE);
    };
    return { pages, w, x, tw, tx, W, forfeit };
  }

  it("roll 1 shown again on the same faces while roll 2's dice fly: the flight is called off, nothing is tossed, and roll 1's result shows where the dice stop", async () => {
    // Both seeds and w's alone throw the same 6: the forfeit changes only
    // who was counted, so x has the dice for roll 2 until it comes, w after.
    const { pages, w, x, tx, W, forfeit } = await shownAgain((ps, w) => rigSame(ps, 1, 6, w));
    expect(carryOf(x)).toMatchObject({ p: 6, h: x.pid, i: 1 });
    const faces = `land ${foldOf(x).rounds[0].craps!.dice!.join('')}`;
    // x flings; w's page hears it (and flies it) before x's page closes.
    clockOf(x, W + 1_050);
    tx.key('r');
    const thr = x.casino.readDiceThrow(TABLE)!;
    send(W + 1_100, x, w);
    frameOf(w, W + 1_100);
    expect(throws(w.dice.log)).toContain(`throw ${thr.seed}`);
    for (const p of pages) expect(p.dice.state()).toBe('flying');
    const marks = pages.map((p) => p.dice.log.length);
    forfeit(W + 1_150);
    go(pages, W + 1_200, W + 1_600);
    expect(keysIn(x, 'c', 2, TABLE)).toEqual([]);
    for (const [i, p] of pages.entries()) {
      expect(crapsOf(p)).toMatchObject({ phase: 'settled', round: 1, result: 6, point: 6 });
      const log = p.dice.log.slice(marks[i]);
      expect(throws(log)).toEqual([]);
      expect(log).toEqual(['cancel', faces]);
      expect(p.dice.state()).toBe('rest');
      expect(p.at!.status()).toMatch(/^● \d \+ \d = 6 — /);
      expect(p.at!.heard().filter((n) => n.includes('REWRITTEN'))).toEqual([]);
    }
    // The dice are w's now; once roll 2 opens again w throws it, once.
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid, i: 1 });
  });

  it("roll 1 rewritten while roll 2's close is in leaves roll 2's dice in the air alone: one flight, landing on roll 2's faces, and no TIME'S UP for the shooter who flung", async () => {
    // w at 3 has the dice either way. Both seeds a 6; w's alone an 8.
    const { pages, w, x, tw, W, forfeit } = await shownAgain((ps, w) => rigSplit(ps, 1, 6, w, 8), 3);
    expect(carryOf(x)).toMatchObject({ p: 6, h: w.pid, i: 1 });
    clockOf(w, W + 1_050);
    tw.key('r');
    const thr = w.casino.readDiceThrow(TABLE)!;
    const lines = tw.lines().length;
    // w's page closes roll 2 on its next frame, hearing nothing else; then
    // its forfeit rewrites roll 1. x hears the throw, the close and the
    // forfeit in one update.
    go([w], W + 1_200, W + 1_200);
    expect(closeOf(w, 2)).toBeDefined();
    const marks = pages.map((p) => p.dice.log.length);
    forfeit(W + 1_250);
    send(W + 1_300, w, x);
    for (const p of pages) frameOf(p, W + 1_300);
    for (const p of pages) {
      expect(crapsOf(p)).toMatchObject({ phase: 'closing', round: 2, point: 8 });
      expect(foldOf(p).rounds[0].craps!.dice!.reduce((n, d) => n + d, 0)).toBe(8);
    }
    for (const p of pages) frameOf(p, W + 1_500);
    for (const [i, p] of pages.entries()) {
      // (w's own fling flew on its page at the throw: nothing more there.)
      expect(throws(p.dice.log.slice(marks[i]))).toEqual(p === w ? [] : [`throw ${thr.seed}`]);
      expect(p.dice.log.slice(marks[i]).filter((e) => e.startsWith('land'))).toEqual([]);
      expect(p.dice.state()).toBe('flying');
    }
    const at = decide(pages, 2, W + 1_700);
    go(pages, at + STEP, at + 3 * STEP);
    const faces = `land ${foldOf(x).rounds.find((v) => v.r === 2)!.craps!.dice!.join('')}`;
    for (const [i, p] of pages.entries()) {
      expect(throws(p.dice.log.slice(marks[i]))).toEqual(p === w ? [] : [`throw ${thr.seed}`]);
      expect(p.dice.log.slice(marks[i]).filter((e) => e.startsWith('land'))).toEqual([faces]);
    }
    for (const t of [tw, x.at!]) expect(t.heard()).toContain('ROLL 1 WAS REWRITTEN — NEW DICE');
    expect(tw.lines().slice(lines)).not.toContain("✋ TIME'S UP — THE STICKMAN THREW");
  });

  it("roll 1 shown again handing the dice to another: the player offered roll 2 before reads no TIME'S UP during the new shooter's wait", async () => {
    // Both seeds a 6 (x first clockwise has the dice); w's alone an 8, which
    // counts w alone: the dice go to w.
    const { pages, w, x, tx, W, forfeit } = await shownAgain((ps, w) => rigSplit(ps, 1, 6, w, 8));
    expect(tx.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM/);
    const lines = tx.lines().length;
    forfeit(W + 1_100);
    go(pages, W + 1_200, W + 1_200);
    expect(crapsOf(x)).toMatchObject({ phase: 'settled', round: 1, result: 8 });
    expect(carryOf(x)).toMatchObject({ p: 8, h: w.pid, i: 1 });
    const open = go(pages, W + 1_400, W + 1_400 + SHOW + 5_000, () => pages.every((p) => crapsOf(p)?.phase === 'betting'));
    const W2 = crapsOf(x, open)!.phaseDeadline!;
    go(pages, open + STEP, W2 + 1_000);
    expect(tx.status()).toMatch(new RegExp(`^✋ NO MORE BETS — ${nameOf(w)} IS SHOOTING · \\d+s$`));
    w.at!.key('r');
    const at = decide(pages, 2, W2 + 1_200);
    go(pages, at + STEP, at + 3 * STEP);
    expect(tx.lines().slice(lines)).not.toContain("✋ TIME'S UP — THE STICKMAN THREW");
    expect(w.at!.lines()).not.toContain("✋ TIME'S UP — THE STICKMAN THREW");
  });

  it("a shooter whose wait ran out reads TIME'S UP while the stickman's close holds the roll, and no longer once roll 1 is rewritten handing roll 2's dice to another", async () => {
    // Both seeds a 6 (x at 3, first clockwise, has the dice); w's alone an 8.
    const { w, x, tx, W, forfeit } = await shownAgain((ps, w) => rigSplit(ps, 1, 6, w, 8));
    expect(tx.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM/);
    // x never throws; x's page closes at the end of the wait, hearing
    // nothing more from w's (w's seed for roll 2 not in: the close holds).
    const closedAt = go([x], W + 1_200, W + WAIT_MS + 10_000, () => closeOf(x, 2) !== undefined);
    expect(closedAt).toBeGreaterThanOrEqual(W + WAIT_MS);
    go([x], closedAt + STEP, closedAt + STEP);
    expect(crapsOf(x)).toMatchObject({ phase: 'closing', round: 2, holder: x.pid });
    expect(tx.status()).toBe("✋ TIME'S UP — THE STICKMAN THREW");
    // w's forfeit of roll 1 reaches x's page: w alone counted, the dice w's.
    forfeit(closedAt + 2 * STEP);
    send(closedAt + 2 * STEP, w, x);
    frameOf(x, closedAt + 3 * STEP);
    expect(crapsOf(x)).toMatchObject({ phase: 'closing', round: 2, holder: w.pid, point: 8 });
    expect(tx.status()).not.toBe("✋ TIME'S UP — THE STICKMAN THREW");
  });

  it("roll 2 shown again with its shooter out of play now: the stickman throws roll 3, and the player offered it before reads no TIME'S UP", async () => {
    // x at 3 has the dice after roll 1's 6 (both counted); roll 2 an 8 from
    // both seeds, a 9 from w's alone. w's forfeit of roll 2 leaves x
    // uncounted: x keeps the dice (no seven-out) but is out of play.
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 2, CTX) as UIPage[];
    standAt(w, 1);
    standAt(x, 3);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const d1 = decide(pages, 1, T0 + STEP);
    expect(carryOf(x)).toMatchObject({ p: 6, h: x.pid, i: 1 });
    rigSplit(pages, 2, 8, w, 9);
    const tx = atCraps(x, { stand: 3 });
    atCraps(w, { stand: 1 });
    const { T, W } = openRoll(pages, 2, d1 + STEP);
    go(pages, T, W - STEP);
    x.table.noteComputedFling(TABLE, 2, 9, W);
    const d2 = decide(pages, 2, W);
    expect(carryOf(x)).toMatchObject({ p: 6, h: x.pid, i: 1 });
    const { T: T3, W: W3 } = openRoll(pages, 3, d2 + STEP);
    go(pages, T3, W3 + 1_000);
    expect(tx.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM/);
    const lines = tx.lines().length;
    clockOf(w, W3 + 1_100);
    const f = signAs(w, 'forfeit', { r: 2, x: foldOf(w).rounds.find((v) => v.r === 2)!.close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(pages, W3 + 1_200, W3 + 1_200);
    expect(crapsOf(x)).toMatchObject({ phase: 'settled', round: 2, result: 9 });
    expect(carryOf(x)).toMatchObject({ p: 6, h: x.pid });
    expect(carryOf(x).i ?? 0).toBe(0);
    const at = decide(pages, 3, W3 + 1_400, W3 + 120_000);
    go(pages, at + STEP, at + 3 * STEP);
    expect(throws(x.dice.log).at(-1)).toBe(tossOf(closeOf(x, 3)!));
    expect(tx.lines().slice(lines)).not.toContain("✋ TIME'S UP — THE STICKMAN THREW");
  });

  it('a roll shown, then held again for a forfeit that beats its seeds on the same faces: its dice fly again when it shows', async () => {
    // w first to forfeit roll 2, at 3: the dice are w's after roll 1's 6.
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 2, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const d1 = decide(pages, 1, T0 + STEP);
    // Roll 2: an 8 from both seeds and from w's alone, the same dice.
    rigSame(pages, 2, 8, w);
    atCraps(w, { stand: 3 });
    atCraps(x, { stand: 1 });
    const { T, W } = openRoll(pages, 2, d1 + STEP);
    go(pages, T, W - STEP);
    w.table.noteComputedFling(TABLE, 2, 9, W);
    const d2 = decide(pages, 2, W);
    go(pages, d2 + STEP, d2 + 3 * STEP);
    const faces = `land ${foldOf(w).rounds.find((v) => v.r === 2)!.craps!.dice!.join('')}`;
    for (const p of pages) {
      expect(crapsOf(p)).toMatchObject({ phase: 'settled', round: 2 });
      expect(p.dice.log.at(-1)).toBe(faces);
    }
    const marks = pages.map((p) => p.dice.log.length);
    // w's forfeit of roll 2 comes before its result's grace is out: the
    // roll is held for the forfeit's show, then shows on the same dice.
    const F = d2 + 4 * STEP;
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 2, x: foldOf(w).rounds.find((v) => v.r === 2)!.close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(pages, F + STEP, F + STEP);
    for (const p of pages) expect(crapsOf(p)).toMatchObject({ phase: 'closing', round: 2 });
    const shown = go(pages, F + 2 * STEP, F + 30_000, () => pages.every((p) => crapsOf(p)?.phase === 'settled'));
    go(pages, shown + STEP, shown + 3 * STEP);
    for (const [i, p] of pages.entries()) {
      expect(foldOf(p).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit' });
      expect(p.dice.log.slice(marks[i])).toEqual([tossOf(closeOf(p, 2)!), faces]);
    }
  });
});

// ── What became of my felt ───────────────────────────────────────────────────

describe('what became of my felt', () => {
  /** A at stand 1 with the pass riding, B at 3 with the dice; on roll 2
   *  (A adding a field bet with `added`) B's page closes at its fling while
   *  A's page sleeps, and forfeits A's seed; then A's page wakes and
   *  reveals. */
  async function lateSeed(added: boolean) {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    if (added) {
      ta.pick('2');
      ta.click('field');
    }
    go(pages, T, W - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, W);
    const closedAt = go([b], W, W + 5_000, () => closeOf(b, 2) !== undefined);
    const decidedOnB = go([b], closedAt + STEP, closedAt + GRACE + 10_000, () => foldOf(b).rounds.some((v) => v.r === 2 && v.decided !== null));
    expect(foldOf(b).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit', counted: [b.pid] });
    // (Its page woken, A's page holds the result until it has heard the room.)
    const shown = go(pages, decidedOnB + STEP, decidedOnB + 30_000, () => crapsOf(a)?.phase === 'settled' && crapsOf(a)?.round === 2);
    go(pages, shown + STEP, shown + STEP);
    expect(foldOf(a).rounds.find((v) => v.r === 2)!.revealed).toContain(a.pid);
    return { a, b, ta };
  }

  it('a late seed with nothing added that roll: YOUR BETS PLAYED WITHOUT IT, on the status line and the card', async () => {
    const { ta } = await lateSeed(false);
    expect(ta.status()).toMatch(/^● \d \+ \d = \d+ — .* · YOUR SEED CAME IN LATE — YOUR BETS PLAYED WITHOUT IT$/);
    expect(ta.status()).not.toContain('FORFEITED');
    expect(ta.card()).toContain('✗ YOUR SEED CAME IN LATE — YOUR BETS PLAYED WITHOUT IT');
  });

  it('a late seed with chips added that roll: NEW BETS FORFEITED · THE REST PLAYED', async () => {
    const { ta } = await lateSeed(true);
    expect(ta.status()).toMatch(/^● \d \+ \d = \d+ — .* · YOUR SEED CAME IN LATE — NEW BETS FORFEITED · THE REST PLAYED$/);
    expect(ta.card()).toContain('✗ YOUR SEED CAME IN LATE — NEW BETS FORFEITED');
  });

  /** A at stand 1 with the pass riding (and a field bet added with
   *  `added`), B at 3 with the dice: neither page hears the other on roll 2,
   *  so B's page closes it at B's fling without A's felt. Then they hear. */
  async function leftOut(added: boolean) {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T } = openRoll([a], 2, decidedAt + STEP);
    if (added) {
      ta.pick('2');
      ta.click('field');
    }
    const { T: Tb, W: Wb } = openRoll([b], 2, decidedAt + STEP);
    go([b], Tb, Wb - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, Wb - STEP);
    const closedAt = go([b], Wb, Wb + 5_000, () => closeOf(b, 2) !== undefined);
    expect(closedAt).toBeLessThan(Wb + 5_000);
    go([a], T, closedAt);
    sync(closedAt + STEP, a, b);
    frameOf(a, closedAt + STEP);
    const closing = ta.status();
    const at = decide(pages, 2, closedAt + 2 * STEP);
    go(pages, at + STEP, at + 2 * STEP);
    return { a, ta, closing };
  }

  it('new chips the close left out come back, the rest play: on the status line while it closes, once settled, and on the card', async () => {
    const { a, ta, closing } = await leftOut(true);
    expect(closing).toBe('✋ YOUR NEW BETS MISSED THE CLOSE — CHIPS BACK · THE REST PLAY');
    expect(ta.status()).toMatch(/ · YOUR NEW BETS MISSED THE CLOSE — CHIPS BACK · THE REST PLAYED$/);
    expect(ta.card()).toContain('YOUR SLIP WAS LEFT OUT — NEW BETS BACK');
    // The field never played: nothing of it held, won or lost.
    expect(a.table.computedMine(TABLE)).toMatchObject({ round: 2, lost: 0 });
    expect(carryOf(a).w[a.pid] ?? []).not.toContainEqual(bet('field', 5));
  });

  it('a felt left out that added nothing missed nothing: no MISSED line, its bets played as they rode in', async () => {
    const { ta, closing } = await leftOut(false);
    expect(closing).not.toContain('MISSED');
    expect(ta.status()).not.toContain('MISSED');
    expect(ta.lines().join('\n')).not.toContain('MISSED');
    expect(ta.card()).toContain('YOUR SLIP WAS LEFT OUT — YOUR BETS PLAYED WITHOUT IT');
  });

  /** A at stand 1 with a pass, a place 8 and a place 5 riding into roll 2,
   *  B at 3 with the dice. Late in roll 2's window A takes the place 8
   *  down (a slip that adds nothing) and at once changes the felt again
   *  (`adds`: a field bet; else the place 5 down too), the change held back
   *  to coalesce; A's page runs no frame until it hears the close B's page
   *  made at its fling, which had heard nothing of A's. */
  async function heldBack(adds: boolean, heard = false) {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll(pages, 1, 6);
    expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8), bet('place', 5, 5)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    sync(T0, a, b);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(a)).toMatchObject({ p: 6, h: b.pid });
    // B's seed alone decides roll 2: a 4, which settles none of A's bets.
    rigSplit(pages, 2, 4, b, 4);
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll([a], 2, decidedAt + STEP);
    go([a], T, W - 2_000);
    const H = W - 2_000 + STEP;
    clockOf(a, H);
    const mine = (): string[] => keysIn(a, 's', 2, TABLE).filter((k) => k.startsWith(`s:2:${a.pid}:`));
    const was = mine().length;
    ta.takeBack('place', 8);
    expect(mine()).toHaveLength(was + 1);
    if (adds) {
      ta.pick('2');
      ta.click('field');
    } else {
      ta.takeBack('place', 5);
    }
    expect(mine()).toHaveLength(was + 1);
    // (With `heard`, B's page has the slip before the change.)
    if (heard) sync(H, a, b);
    const { T: Tb, W: Wb } = openRoll([b], 2, decidedAt + STEP);
    go([b], Tb, Wb - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, Wb - STEP);
    const closedAt = go([b], Wb, Wb + 5_000, () => closeOf(b, 2) !== undefined);
    expect(closedAt).toBeLessThan(Wb + 5_000);
    expect(closedAt - H).toBeLessThan(6_000);
    sync(closedAt + STEP, a, b);
    frameOf(a, closedAt + STEP);
    const closing = ta.status();
    const at = decide(pages, 2, closedAt + 2 * STEP);
    go(pages, at + STEP, at + 2 * STEP);
    return { a, ta, closing };
  }

  it('a change held back past the close that froze the slip before it: TOO LATE — THE CLOSE HAD YOUR EARLIER BETS', async () => {
    const { a, ta, closing } = await heldBack(true, true);
    expect(closing).toBe('✋ TOO LATE — THE CLOSE HAD YOUR EARLIER BETS');
    expect(ta.status()).toMatch(/^● \d \+ \d = 4 — .* · TOO LATE — THE CLOSE HAD YOUR EARLIER BETS$/);
    expect(ta.card()).toContain('✓ YOUR SLIP WAS FROZEN');
    expect(carryOf(a).w[a.pid]).toEqual(expect.arrayContaining([bet('pass', 10), bet('place', 5, 5)]));
    expect(carryOf(a).w[a.pid]).not.toContainEqual(bet('place', 6, 8));
  });

  it('while a forfeit holds the roll for its show, the table counts the bets that rode into it', async () => {
    // w first to forfeit roll 2, at stand 3: it holds the dice after roll 1.
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 2, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid });
    // Both seeds an 8; w's alone a 7: the forfeit sevens out both pass lines.
    rigSplit(pages, 2, 8, w, 7);
    const tw = atCraps(w, { stand: 3 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W - STEP);
    w.table.noteComputedFling(TABLE, 2, 9, W);
    const closedAt = go([w], W, W + 5_000, () => closeOf(w, 2) !== undefined);
    // The stickman's toss flies at the close; past ROLLING_MS the dice lie
    // faceless and the line says what the roll waits for.
    go([w], closedAt + STEP, closedAt + 1_000);
    expect(tw.status()).toBe('🎲 THE DICE ARE ROLLING…');
    go([w], closedAt + 1_000 + STEP, closedAt + 4_000);
    expect(w.dice.state()).toBe('flying');
    expect(tw.status()).toBe('✋ NO MORE BETS — WAITING FOR SEEDS');
    const decidedOnW = go([w], closedAt + 4_000 + STEP, closedAt + GRACE + 10_000, () => foldOf(w).rounds.some((v) => v.r === 2 && v.decided !== null));
    expect(foldOf(w).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit' });
    expect(carryOf(w)).toMatchObject({ p: 0, w: {} });
    expect(crapsOf(w, decidedOnW)).toMatchObject({ phase: 'closing', round: 2, point: 6, riders: 2 });
    expect(tw.card()).toContain('THE POINT IS 6 · 2 PLAYERS HAVE BETS RIDING');
    const shown = go([w], decidedOnW + STEP, decidedOnW + 30_000, () => crapsOf(w)?.phase === 'settled');
    expect(crapsOf(w, shown)).toMatchObject({ point: null, riders: 0 });
    expect(tw.card()).toContain('COME OUT · NO BETS RIDING');
  });

  it("a shooter who flung reads no TIME'S UP: not while a forfeit holds their roll, nor as its dice land; the card says whose forfeit decided it", async () => {
    // w first to forfeit roll 2, at stand 3: it holds the dice after roll 1.
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 2, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid, i: 1 });
    // Both seeds an 8; w's alone a 4.
    rigSplit(pages, 2, 8, w, 4);
    const tw = atCraps(w, { stand: 3 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    expect(tw.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM/);
    clockOf(w, W + 1_050);
    tw.key('r');
    const lines = tw.lines().length;
    // x's page hears no more: its seed never comes, and w's forfeit decides.
    const closedAt = go([w], W + 1_200, W + 5_000, () => closeOf(w, 2) !== undefined);
    const decidedOnW = go([w], closedAt + STEP, closedAt + GRACE + 10_000, () => foldOf(w).rounds.some((v) => v.r === 2 && v.decided !== null));
    expect(foldOf(w).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit' });
    expect(crapsOf(w, decidedOnW)).toMatchObject({ phase: 'closing', round: 2 });
    const shown = go([w], decidedOnW + STEP, decidedOnW + 30_000, () => crapsOf(w)?.phase === 'settled');
    expect(tw.lines().at(-1)).toBe('🎲 THE DICE ARE ROLLING…');
    go([w], shown + STEP, shown + 3 * STEP);
    expect(tw.lines().slice(lines)).not.toContain("✋ TIME'S UP — THE STICKMAN THREW");
    expect(tw.status()).toMatch(/^● \d \+ \d = 4 — /);
    expect(tw.card()).toContain(`DECIDED BY A FORFEIT BY ${nameOf(w)}`);
  });

  it("a shooter who flung and then hid their tab reads no TIME'S UP: the wake forgets the fling, not that it was made", async () => {
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 2, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid, i: 1 });
    rigSplit(pages, 2, 8, w, 4);
    const tw = atCraps(w, { stand: 3 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W + 1_000);
    expect(tw.status()).toMatch(/^🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM/);
    clockOf(w, W + 1_050);
    tw.key('r');
    const seed = w.casino.readDiceThrow(TABLE)!.seed;
    const lines = tw.lines().length;
    const mark = w.dice.log.length;
    // x's page hears no more; w's closes, then its tab hides for 7 s: the
    // first frame back counts a wake, which forgets w's fling.
    const closedAt = go([w], W + 1_200, W + 5_000, () => closeOf(w, 2) !== undefined);
    const wakes = w.croupier.tablesWakeCount();
    frameOf(w, closedAt + 7_000);
    expect(w.croupier.tablesWakeCount()).toBe(wakes + 1);
    expect(w.table.computedFlungFor(TABLE)).toBeNull();
    expect(crapsOf(w)).toMatchObject({ phase: 'closing', round: 2 });
    const decidedOnW = go([w], closedAt + 7_000 + STEP, closedAt + 60_000, () => foldOf(w).rounds.some((v) => v.r === 2 && v.decided !== null));
    expect(foldOf(w).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit' });
    const shown = go([w], decidedOnW + STEP, decidedOnW + 30_000, () => crapsOf(w)?.phase === 'settled');
    go([w], shown + STEP, shown + 3 * STEP);
    expect(tw.lines().slice(lines)).not.toContain("✋ TIME'S UP — THE STICKMAN THREW");
    expect(tw.status()).toMatch(/^● \d \+ \d = 4 — /);
    expect(throws(w.dice.log.slice(mark))).toEqual([]);
    expect(throws(w.dice.log)).toContain(`throw ${seed}`);
  });

  it('a change held back that added chips, its slip before it left out too: the new chips missed the close', async () => {
    const { a, ta, closing } = await heldBack(true);
    expect(closing).toBe('✋ YOUR NEW BETS MISSED THE CLOSE — CHIPS BACK · THE REST PLAY');
    expect(ta.status()).toMatch(/ · YOUR NEW BETS MISSED THE CLOSE — CHIPS BACK · THE REST PLAYED$/);
    expect(ta.card()).toContain('YOUR SLIP WAS LEFT OUT — NEW BETS BACK');
    expect(carryOf(a).w[a.pid]).toEqual(expect.arrayContaining([bet('pass', 10), bet('place', 6, 8)]));
    expect(carryOf(a).w[a.pid]).not.toContainEqual(bet('field', 5));
  });

  it('a change held back that only took bets down, its slip before it left out too: nothing missed, the bets played as they rode in', async () => {
    const { a, ta, closing } = await heldBack(false);
    expect(closing).not.toContain('MISSED');
    expect(ta.lines().join('\n')).not.toContain('MISSED');
    expect(ta.card()).toContain('YOUR SLIP WAS LEFT OUT — YOUR BETS PLAYED WITHOUT IT');
    expect(carryOf(a).w[a.pid]).toEqual(expect.arrayContaining([bet('place', 6, 8), bet('place', 5, 5)]));
  });

  /** A at stand 1 with the pass riding (a field bet added on roll 2 with
   *  `added`), B at 3 with the dice: B's page closes roll 2 at its fling;
   *  A's tab loads again before it hears the close, its seeds gone. */
  async function neverCame(added: boolean) {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    if (added) expect(crapsBet(a, [...myFelt(a, 2), bet('field', 5)], T)).toBe('ok');
    go(pages, T, W - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, W);
    const closedAt = go([b], W, W + 5_000, () => closeOf(b, 2) !== undefined);
    expect(Object.keys((b.casino.computedSessionForWrite(TABLE)!.get(keysIn(b, 'c', 2, TABLE)[0]) as { f: object }).f)).toContain(a.pid);
    // A's tab loads again before it hears the close: its seeds are gone.
    const a2 = await loadUIPage("A'", 9, { reloadOf: a });
    sync(closedAt, a2, b);
    const ta = atCraps(a2, { stand: 1 });
    const shown = go([a2, b], closedAt + STEP, closedAt + GRACE + 30_000, () => crapsOf(a2)?.phase === 'settled' && crapsOf(a2)?.round === 2);
    go([a2, b], shown + STEP, shown + 2 * STEP);
    expect(foldOf(a2).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit', counted: [b.pid] });
    return { a2, ta };
  }

  it("a seed that never came (the tab reloaded after its slip went in the close), nothing added: YOUR BETS PLAYED WITHOUT IT", async () => {
    const { ta } = await neverCame(false);
    expect(ta.status()).toMatch(/ · YOUR SEED NEVER CAME — YOUR BETS PLAYED WITHOUT IT$/);
    expect(ta.card()).toContain('✗ YOUR SEED NEVER CAME — YOUR BETS PLAYED WITHOUT IT');
  });

  it('a seed that never came with chips added that roll: NEW BETS FORFEITED · THE REST PLAYED, the field bet gone', async () => {
    const { a2, ta } = await neverCame(true);
    expect(ta.status()).toMatch(/ · YOUR SEED NEVER CAME — NEW BETS FORFEITED · THE REST PLAYED$/);
    expect(ta.card()).toContain('✗ YOUR SEED NEVER CAME — NEW BETS FORFEITED');
    expect(a2.table.computedMine(TABLE)).toMatchObject({ round: 2, lost: 5 });
    expect(carryOf(a2).w[a2.pid] ?? []).not.toContainEqual(bet('field', 5));
  });

  it("a change held back when the roll before is rewritten under it never goes in: THE LAST ROLL CHANGED — YOUR CHANGES WERE UNDONE · PLACE THEM AGAIN", async () => {
    const pages = await room(['A', 'B']);
    standAt(pages[0], 1);
    standAt(pages[1], 3);
    // w writes the forfeit that rewrites roll 1: first in rank, so nobody
    // answers it. Both seeds a natural 7; w's alone a 6.
    const [w, x] = byRank(pages, 'forfeit', 1, CTX) as UIPage[];
    rigSplit(pages, 1, 7, w, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(w).p).toBe(0);
    const tw = atCraps(w, { stand: w === pages[0] ? 1 : 3 });
    const tx = atCraps(x, { stand: x === pages[0] ? 1 : 3 });
    const showEnd = crapsOf(w, decidedAt)!.resultAt + SHOW;
    go(pages, decidedAt + STEP, showEnd + 1_000);
    // Roll 2: w's pass line goes down; a field bet with it is held back.
    const T = showEnd + 1_000 + STEP;
    clockOf(w, T);
    tw.pick('2', 2);
    tw.click('pass');
    tw.click('field');
    expect(myFelt(w, 2)).toEqual([bet('field', 10), bet('pass', 10)]);
    // The rewrite: w's forfeit of roll 1 counts w's seed alone, a 6.
    clockOf(w, T + 100);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(pages, T + STEP, T + STEP);
    expect(tw.heard()).toContain('THE LAST ROLL CHANGED — YOUR CHANGES WERE UNDONE · PLACE THEM AGAIN');
    expect(tx.heard()).not.toContain('THE LAST ROLL CHANGED — YOUR CHANGES WERE UNDONE · PLACE THEM AGAIN');
    for (const t of [tw, tx]) expect(t.heard()).toContain('ROLL 1 WAS REWRITTEN — NEW DICE');
    // (The roll on screen rewritten: no earlier roll changed under it.)
    for (const t of [tw, tx]) expect(t.heard().filter((x) => /^ROLL \d+ CHANGED/.test(x))).toEqual([]);
    expect(myFelt(w, 2)).not.toContainEqual(bet('field', 10));
  });

  it('an earlier roll changed under a later one: whose later bets came back, and that the rolls after it paid again on the same dice', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [w, x, y] = byRank(pages.slice(0, 2), 'forfeit', 1, CTX).concat([pages[2]]) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    // Roll 1: both seeds a natural 7, w's alone a 6.
    rigSplit([w, x], 1, 7, w, 6);
    for (const p of [w, x]) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const d1 = decide(pages, 1, T0 + STEP);
    expect(carryOf(w).p).toBe(0);
    // Roll 2: a pass line each again; a 4 makes the point.
    rigRoll([w, x], 2, 4);
    const showEnd = crapsOf(w, d1)!.resultAt + SHOW;
    go(pages, d1 + STEP, showEnd + 1_000);
    for (const p of [w, x]) {
      const felt = myFelt(p, 2);
      expect(crapsBet(p, felt.some((b) => b.type === 'pass') ? felt : [...felt, bet('pass', 10)], showEnd + 1_000 + STEP)).toBe('ok');
    }
    const tw = atCraps(w, { stand: 3 });
    const tx = atCraps(x, { stand: 1 });
    const ty = atCraps(y, { stand: 5 });
    const d2 = decide(pages, 2, showEnd + 1_000 + 2 * STEP);
    expect(carryOf(w).p).toBe(4);
    go(pages, d2 + STEP, d2 + 2 * STEP);
    const dice2 = foldOf(w).rounds.find((v) => v.r === 2)!.craps!.dice;
    // During roll 2's show, w's forfeit of roll 1 (its seed alone: a 6).
    const F = d2 + 3 * STEP;
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(pages, F + STEP, F + 2 * STEP);
    for (const p of pages) {
      expect(foldOf(p).rounds.find((v) => v.r === 2)!.craps!.dice).toEqual(dice2);
      expect(carryOf(p).p).toBe(6);
    }
    expect(tw.heard()).toContain('ROLL 1 CHANGED — YOUR BETS ON ROLL 2 CAME BACK');
    expect(tx.heard()).toContain('ROLL 1 CHANGED — YOUR BETS ON ROLL 2 CAME BACK');
    expect(ty.heard()).toContain('ROLL 1 CHANGED — THE ROLLS AFTER IT PAID AGAIN ON THE SAME DICE');
    for (const t of [tw, tx, ty]) expect(t.heard().filter((s) => s.includes('REWRITTEN'))).toEqual([]);
    expect(tw.status()).toMatch(/^● \d \+ \d = 4 — ROLL AGAIN, POINT IS 6 · THE LAST ROLL CHANGED — YOUR CHANGES WERE UNDONE · BETS AS THEY STOOD$/);
  });

  it('an earlier roll changed under a later one its riders only rode into: nothing came back, nothing was undone, the rolls after paid again', async () => {
    const pages = await room(['A', 'B']);
    const [w, x] = byRank(pages, 'forfeit', 1, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    // Roll 1: both seeds a 6, w's alone an 8; roll 2 a 4, which decides no
    // pass line either way. Nobody changes a bet on roll 2: their pages
    // write the felt as it rode in.
    rigSplit(pages, 1, 6, w, 8);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    const d1 = decide(pages, 1, T0 + STEP);
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid });
    rigRoll(pages, 2, 4);
    const tw = atCraps(w, { stand: 3 });
    const tx = atCraps(x, { stand: 1 });
    const { T, W } = openRoll(pages, 2, d1 + STEP);
    go(pages, T, W - STEP);
    w.table.noteComputedFling(TABLE, 2, 9, W);
    const d2 = decide(pages, 2, W);
    go(pages, d2 + STEP, d2 + 2 * STEP);
    const roll2 = foldOf(w).rounds.find((v) => v.r === 2)!;
    expect(roll2.present).toEqual(expect.arrayContaining([w.pid, x.pid]));
    // During roll 2's show, w's forfeit of roll 1: an 8, the point moves.
    const F = d2 + 3 * STEP;
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(pages, F + STEP, F + 2 * STEP);
    for (const p of pages) {
      const v = foldOf(p).rounds.find((r) => r.r === 2)!;
      expect(v.craps!.dice).toEqual(roll2.craps!.dice);
      expect(v.craps!.fates.get(w.pid)).toBe('basis');
      expect(v.craps!.fates.get(x.pid)).toBe('basis');
      expect(carryOf(p)).toMatchObject({ p: 8 });
      // (x's seed didn't count on roll 1: its pass, put down on it, went.)
      expect(carryOf(p).w[w.pid]).toEqual([bet('pass', 10)]);
      expect(carryOf(p).w[x.pid]).toBeUndefined();
    }
    for (const t of [tw, tx]) {
      expect(t.heard()).toContain('ROLL 1 CHANGED — THE ROLLS AFTER IT PAID AGAIN ON THE SAME DICE');
      expect(t.heard().filter((n) => n.includes('CAME BACK'))).toEqual([]);
      expect(t.status()).toMatch(/^● \d \+ \d = 4 — /);
      expect(t.status()).not.toContain('UNDONE');
    }
  });
});

// ── The switch ───────────────────────────────────────────────────────────────

describe("the house's switch at craps", () => {
  const CONFIRM = 'THIS TABLE WILL RUN FRIENDLY: SEEDS FROM THE PLAYERS ONLY';
  const CRAPS_CONFIRM = 'BETS ON THE FELT GO BACK TO THEIR PLAYERS';
  const SWITCHED = 'TABLE SWITCHED — YOUR BETS ARE BACK';

  it('switching on asks first with the bets-go-back line, and tells TABLE SWITCHED to each player at the table whose bets came back, nobody else', async () => {
    const pages = await room(['A', 'B', 'C', 'D'], true);
    const [a, b, c, d] = pages;
    a.table.setComputedTablesEnabledForTests(true);
    // An owner-run come-out, settled: B and C have place bets on its felt.
    clockOf(a, T0);
    a.casino.writeCrapsTableState(TABLE, {
      kind: 'craps', phase: 'settled', round: 1, point: null, dice: null, result: null, resultAt: 0, payouts: null, ...a.casino.tableOpening(TABLE),
    });
    sync(T0, ...pages);
    for (const p of [b, c]) {
      clockOf(p, T0);
      expect(p.casino.writeMyCrapsBets(TABLE, p.pid, [bet('place', 6, 6)])).toBe(true);
    }
    sync(T0, ...pages);
    const ta = atCraps(a, { stand: 3, house: true });
    const tb = atCraps(b, { stand: 1 });
    const td = atCraps(d, { stand: 5 });
    go(pages, T0 + STEP, T0 + 2 * STEP);
    const off = ta.card();
    expect(off).toContain("PLAYERS' TABLE · OFF");
    expect(off).toContain('data-act="computed-on"');
    expect(tb.card()).not.toContain('computed-');
    ta.press('computed-on');
    const confirm = ta.card();
    expect(confirm).toContain(CONFIRM);
    expect(confirm).toContain(CRAPS_CONFIRM);
    expect(confirm.indexOf(CONFIRM)).toBeLessThan(confirm.indexOf(CRAPS_CONFIRM));
    ta.press('computed-confirm');
    expect(ta.said()).toBe('THE PLAYERS RUN THIS TABLE NOW — NO OPERATOR · FRIENDLY');
    go(pages, T0 + 3 * STEP, T0 + 5 * STEP);
    expect(a.casino.computedIncOf(TABLE)).toMatch(/^k/);
    for (const p of pages) expect(p.casino.readMyCrapsBets(TABLE, b.pid)).toEqual([]);
    expect(b.casino.readChips(b.pid)).toBe(1_000);
    expect(c.casino.readChips(c.pid)).toBe(1_000);
    expect(tb.heard()).toContain(SWITCHED);
    for (const t of [ta, td]) expect(t.heard()).not.toContain(SWITCHED);
    // C walks up afterwards: its bets came back off the table, unsaid.
    const tc = atCraps(c, { stand: 7 });
    go(pages, T0 + 6 * STEP, T0 + 7 * STEP);
    expect(tc.heard()).not.toContain(SWITCHED);
    expect(tc.plaque()).toBe("PLAYERS' TABLE · NO OPERATOR · SEEDS FROM THE PLAYERS");
  });

  it('a switch-on pressed while an owner-run roll is out says FINISH THIS ROLL FIRST, as the card does', async () => {
    const [o] = await room(['O'], true);
    o.table.setComputedTablesEnabledForTests(true);
    clockOf(o, T0);
    o.casino.writeCrapsTableState(TABLE, {
      kind: 'craps', phase: 'closing', round: 1, point: null, dice: null, result: null, resultAt: 0, payouts: null, ...o.casino.tableOpening(TABLE),
    });
    const to = atCraps(o, { stand: 3, house: true });
    go([o], T0 + STEP, T0 + 2 * STEP);
    expect(to.card()).toContain('FINISH THIS ROLL FIRST');
    to.press('computed-on');
    to.press('computed-confirm');
    expect(to.said()).toBe('FINISH THIS ROLL FIRST');
    expect(o.casino.isComputedTable(TABLE)).toBe(false);
  });

  it("isn't offered mid-point; switching off with line bets riding warns first, then hands them back on the second press", async () => {
    // Owner-run, a point on: the row says why not.
    const [o] = await room(['O'], true);
    o.table.setComputedTablesEnabledForTests(true);
    clockOf(o, T0);
    o.casino.writeCrapsTableState(TABLE, {
      kind: 'craps', phase: 'settled', round: 1, point: 6, dice: null, result: null, resultAt: 0, payouts: null, ...o.casino.tableOpening(TABLE),
    });
    const to = atCraps(o, { stand: 3, house: true });
    go([o], T0 + STEP, T0 + 2 * STEP);
    expect(to.card()).toContain('WAIT FOR A COME-OUT WITH NO COME BETS ON A NUMBER');

    // Computed, the point on, A's and B's pass lines riding into roll 2.
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1, house: true });
    const tb = atCraps(b, { stand: 3 });
    const { T } = openRoll(pages, 2, decidedAt + STEP);
    expect(ta.card()).toContain("PLAYERS' TABLE · ON");
    expect(ta.card()).toContain('PASS LINE AND COME BETS STILL RIDE — PRESS AGAIN TO HAND THEM BACK AND SWITCH');
    // (Its button is live: the warning is the first press's, not a refusal.)
    expect(ta.card()).toMatch(/data-act="computed-off"\s+style/);
    ta.press('computed-off');
    expect(ta.said()).toBe('PASS LINE AND COME BETS STILL RIDE — PRESS AGAIN TO HAND THEM BACK AND SWITCH');
    expect(a.casino.computedIncOf(TABLE)).toMatch(/^k/);
    // Another press between disarms it: the next switch-off warns again.
    ta.press('fairness');
    ta.press('computed-off');
    expect(ta.said()).toBe('PASS LINE AND COME BETS STILL RIDE — PRESS AGAIN TO HAND THEM BACK AND SWITCH');
    expect(a.casino.computedIncOf(TABLE)).toMatch(/^k/);
    const resets = a.dice.resets();
    const markA = a.dice.log.length;
    ta.press('computed-off');
    expect(ta.heard()).toContain('THE OWNER RUNS THIS TABLE AGAIN FROM ITS NEXT ROLL');
    go(pages, T, T + 2 * STEP);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    for (const p of pages) expect(p.casino.readChips(p.pid)).toBe(1_000);
    for (const t of [ta, tb]) expect(t.heard()).toContain(SWITCHED);
    // The owner-run table starts afresh on the page: the pieces reset once,
    // the computed rolls' last throw flying nowhere.
    expect(a.dice.resets()).toBe(resets + 1);
    expect(throws(a.dice.log.slice(markA))).toEqual([]);
  });
});

// ── The card ─────────────────────────────────────────────────────────────────

describe('the ⚙ card at a computed craps table', () => {
  it("names the dice's holder as text, whatever their name holds", async () => {
    const pages = [await loadUIPage('A', 1), await loadUIPage('B', 2, { pid: 'p<b>x' })];
    for (const p of pages) {
      clockOf(p, T0);
      p.casino.buyInChips(p.pid, 1_000);
    }
    switchOn(pages[0], TABLE, INC);
    sync(T0, ...pages);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(a).h).toBe(b.pid);
    const ta = atCraps(a, { stand: 1 });
    go(pages, decidedAt + STEP, decidedAt + 2 * STEP);
    const card = ta.card();
    expect(card).toContain('THE POINT IS 6 · 2 PLAYERS HAVE BETS RIDING · P&lt;B&gt;X HAS THE DICE');
    expect(card).not.toContain('<B>');
  });

  it('a slip that breaks the table rules changes nothing, and the card flags it', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    rigRoll(pages, 2, 4);
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, T + STEP);
    // B's page, modified, takes B's pass line down with the point on.
    const { k: _k, g: _g, ...was } = foldOf(b).felts.get(b.pid)!.rec as unknown as Record<string, unknown> & { v: number };
    const bad = signAs(b, 'slip', { ...was, v: was.v + 1, b: [] }, CTX);
    clockOf(b, T + 2 * STEP);
    putIn(b, [[b.fold.slipKeyFor(CTX)(bad)!, bad]], TABLE);
    go(pages, T + 2 * STEP, W - STEP);
    expect(foldOf(a).felts.get(b.pid)?.rec.b).toEqual([]);
    b.table.noteComputedFling(TABLE, 2, 9, W);
    const at = decide(pages, 2, W);
    go(pages, at + STEP, at + 2 * STEP);
    expect(foldOf(a).rounds.find((v) => v.r === 2)?.craps?.fates.get(b.pid)).toBe('illegal');
    expect(carryOf(a)).toMatchObject({ p: 6 });
    expect(carryOf(a).w[b.pid]).toContainEqual(bet('pass', 5));
    expect(ta.card()).toContain('🚩 A SLIP BROKE THE TABLE RULES — ITS CHANGES WERE IGNORED');
  });

  it("a close naming a slip the room never had: 1 FROZEN SLIP NEVER CAME (NEW BETS NOT STAKED)", async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W - STEP);
    // B's page, modified, closes roll 2 naming a slip of A's nobody wrote.
    const own = foldOf(b).felts.get(b.pid)!.key;
    clockOf(b, W);
    const close = signAs(b, 'close', { r: 2, q: foldOf(b).parent, f: { [b.pid]: own.slice(own.lastIndexOf(':') + 1), [a.pid]: 'ab'.repeat(16) } }, CTX);
    putIn(b, [[b.fold.closeKey(close)!, close]], TABLE);
    const decidedOnB = go([b], W + STEP, W + GRACE + 30_000, () => foldOf(b).rounds.some((v) => v.r === 2 && v.decided !== null));
    expect(foldOf(b).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'forfeit', missing: [a.pid] });
    go(pages, decidedOnB + STEP, decidedOnB + 3 * STEP);
    expect(ta.card()).toContain(`1 OF 2 SEEDS COUNTED · DECIDED BY A FORFEIT BY ${nameOf(b)} · 1 FROZEN SLIP NEVER CAME (NEW BETS NOT STAKED)`);
  });

  it('has the computed rules and the table as it stands, and nothing the owner sets or presses', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1, house: true });
    go(pages, decidedAt + STEP, decidedAt + 2 * STEP);
    const card = ta.card();
    expect(card).toContain("NOBODY RUNS THIS TABLE · THE PLAYERS' PAGES MOVE IT ALONG · ANYONE CAN LOOK");
    expect(card).toContain('The dice go clockwise to players counted at their stand on the last roll: they had a bet down at their stand, '
      + 'with their seed in on time. A shooter keeps them until a seven-out; on a come-out, and on the roll that makes the point, '
      + 'they must be counted at their stand to keep them.');
    expect(card).toContain("BETS CLOSE ON THE TIMER · THE ROLL IS DECIDED ONCE THE BETTORS' SEEDS ARE IN · STAY UNTIL THE DICE LAND");
    expect(card).toMatch(/🔓 LAST ROLL · ROLL 1 · \d \+ \d = 6 — THE POINT IS 6 · 2 OF 2 SEEDS COUNTED · DECIDED BY ALL REVEALS · ✓ YOUR SLIP WAS FROZEN/);
    expect(card).toContain(`THE POINT IS 6 · 2 PLAYERS HAVE BETS RIDING · ${nameOf(b)} HAS THE DICE`);
    expect(card).not.toContain('THE STICKMAN THROWS NEXT');
    for (const owner of ['YOU RUN THIS TABLE', 'DICE FAIRNESS', 'SETTLEMENT', 'THE ROBOT STICKMAN', 'THROW THE DICE', 'NEXT ROLL']) {
      expect(card).not.toContain(owner);
    }
    ta.press('fairness');
    expect(ta.said()).toBe("NOBODY ROLLS THIS TABLE BY HAND — THE ROLL IS DECIDED ONCE THE BETTORS' SEEDS ARE IN");
    const backend = a.casino.readCrapsBackendPref(TABLE);
    ta.press('backend');
    expect(ta.heard().at(-1)).toBe("NOBODY ROLLS THIS TABLE BY HAND — THE ROLL IS DECIDED ONCE THE BETTORS' SEEDS ARE IN");
    expect(a.casino.readCrapsBackendPref(TABLE)).toBe(backend);
    expect(ta.plaque()).toBe("PLAYERS' TABLE · NO OPERATOR · SEEDS FROM THE PLAYERS");
  });
});

// ── Rolls nobody finished, rolls undone, bets left riding ────────────────────

describe('rolls nobody finished or the room no longer has', () => {
  it('a roll whose bettors all went before their seeds is void: every bet stands', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    standAt(a, 1);
    standAt(b, 3);
    for (const p of [a, b]) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const tc = atCraps(c, { stand: 5 });
    const { T, W } = openRoll([c], 1, T0 + STEP);
    go([c], T, W);
    // A's page closes the roll, then A's and B's tabs are gone, seeds and all.
    clockOf(a, W + 100);
    sync(W + 100, a, c);
    const f = Object.fromEntries([a, b].map((p) => {
      const k = keysIn(a, 's', 1, TABLE).find((x) => x.startsWith(`s:1:${p.pid}:`))!;
      return [p.pid, k.slice(k.lastIndexOf(':') + 1)];
    }));
    const close = signAs(a, 'close', { r: 1, q: foldOf(a).parent, f }, CTX);
    putIn(a, [[a.fold.closeKey(close)!, close]], TABLE);
    sync(W + 100, a, c);
    const markV = c.dice.log.length;
    const at = go([c], W + STEP, W + 120_000, () => crapsOf(c)?.phase === 'settled' && crapsOf(c)?.voided === true);
    expect(at).toBeLessThan(W + 120_000);
    go([c], at + STEP, at + STEP);
    // The stickman's toss flew at the close, and is called off at the void.
    expect(c.dice.log.slice(markV)).toEqual([tossOf(closeOf(c, 1)!), 'cancel']);
    expect(c.dice.state()).toBe('rest');
    expect(tc.status()).toBe('⚠ ROLL VOID — NOBODY COULD FINISH IT · BETS STAND FOR THE NEXT ROLL');
    expect(tc.card()).toContain('🔓 LAST ROLL · ROLL 1 · VOID — NOBODY COULD FINISH IT · EVERY BET STANDS');
    // Their pages were only asleep: when they wake, the roll is played
    // after all, and on C's page its dice fly again before they land.
    const markC = c.dice.log.length;
    const played = (): boolean => crapsOf(c)?.round === 1 && crapsOf(c)?.phase === 'settled' && !crapsOf(c)?.voided;
    const back = go(pages, at + 2 * STEP, at + 60_000, played);
    expect(back).toBeLessThan(at + 60_000);
    go(pages, back + STEP, back + STEP);
    const flown = c.dice.log.slice(markC);
    expect(flown[0]).toMatch(/^throw \d+$/);
    expect(flown[1]).toMatch(/^land \d\d$/);
  });

  it("the dice go by the first close of the open roll this page saw: a second one that comes later moves nothing", async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W);
    const f = Object.fromEntries(keysIn(a, 's', 2, TABLE).map((k) => [k.split(':')[2], k.slice(k.lastIndexOf(':') + 1)]));
    const q = foldOf(a).parent;
    clockOf(a, W + 100);
    const first = signAs(a, 'close', { r: 2, q, f }, CTX);
    putIn(a, [[a.fold.closeKey(first)!, first]], TABLE);
    clockOf(b, W + 300);
    const second = signAs(b, 'close', { r: 2, q, f }, CTX);
    putIn(b, [[b.fold.closeKey(second)!, second]], TABLE);
    sync(W + 300, a, b);
    expect(keysIn(a, 'c', 2, TABLE)).toHaveLength(2);
    const hash = a.fold.closeKey(first)!.split(':')[2];
    expect(a.table.computedCrapsClose(TABLE, 2)).toEqual({ at: W + 100, hash });
  });

  it('a roll this page showed that the room no longer has reads UNDONE until something takes its place', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, W);
    const at = decide(pages, 2, W);
    go(pages, at + STEP, at + 2 * STEP);
    expect(ta.status()).toMatch(/^● /);
    // A peer takes roll 2's close and seeds away.
    clockOf(a, at + 3 * STEP);
    a.doc.transact(() => {
      const ses = a.casino.computedSessionForWrite(TABLE)!;
      for (const k of [...keysIn(a, 'c', 2, TABLE), ...keysIn(a, 'x', 2, TABLE)]) ses.delete(k);
    });
    expect(ta.status()).toBe('⚠ ROLL 2 UNDONE — BETS AS THE ROOM NOW HAS THEM');
  });

  it('two rolls this page showed that the room no longer has read ROLLS 2–3 UNDONE; ROLL 3 UNDONE once roll 2 is decided again, and the line goes once roll 3 is too', async () => {
    const { pages, decidedAt } = await pointOn(['A', 'B'], [1, 3]);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 1 });
    rigRoll(pages, 2, 8);
    const { T, W } = openRoll(pages, 2, decidedAt + STEP);
    go(pages, T, W - STEP);
    b.table.noteComputedFling(TABLE, 2, 9, W);
    const d2 = decide(pages, 2, W);
    rigRoll(pages, 3, 9);
    const { T: T3, W: W3 } = openRoll(pages, 3, d2 + STEP);
    go(pages, T3, W3 - STEP);
    b.table.noteComputedFling(TABLE, 3, 9, W3);
    const d3 = decide(pages, 3, W3);
    go(pages, d3 + STEP, d3 + 2 * STEP);
    expect(ta.status()).toMatch(/^● /);
    // A peer takes rolls 2 and 3's closes and seeds away, on both pages, and
    // roll 3's slips: the pages put roll 3's close and seeds back at once,
    // its slips only once roll 2 is decided again.
    for (const p of pages) {
      clockOf(p, d3 + 3 * STEP);
      p.doc.transact(() => {
        const ses = p.casino.computedSessionForWrite(TABLE)!;
        for (const k of [...keysIn(p, 'c', 2, TABLE), ...keysIn(p, 'x', 2, TABLE), ...keysIn(p, 'c', 3, TABLE), ...keysIn(p, 'x', 3, TABLE), ...keysIn(p, 's', 3, TABLE)]) ses.delete(k);
      });
    }
    expect(ta.status()).toBe('⚠ ROLLS 2–3 UNDONE — BETS AS THE ROOM NOW HAS THEM');
    const again = go(pages, d3 + 4 * STEP, d3 + 120_000, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === 2 && v.decided !== null)));
    expect(again).toBeLessThan(d3 + 120_000);
    go(pages, again + STEP, again + STEP);
    expect(foldOf(a).rounds.some((v) => v.r === 3 && v.decided !== null)).toBe(false);
    expect(ta.status()).toBe('⚠ ROLL 3 UNDONE — BETS AS THE ROOM NOW HAS THEM');
    const back = go(pages, again + 2 * STEP, again + 120_000, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === 3 && v.decided !== null)));
    expect(back).toBeLessThan(again + 120_000);
    go(pages, back + STEP, back + 2 * STEP);
    expect(ta.status()).toBe('● 6 + 3 = 9 — ROLL AGAIN, POINT IS 6');
  });

  it('bets left riding by players off the table wait: BETS RIDE until somebody bets', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll([a, b], 1, 6);
    for (const p of [a, b]) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    // A and B step off the table once their slips are in; the 6 still counts them.
    standAt(a, null);
    standAt(b, null);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(c)).toMatchObject({ p: 6, h: b.pid });
    const tc = atCraps(c, { stand: 5 });
    const show = crapsOf(c)!.resultAt + SHOW;
    go(pages, decidedAt + STEP, show + 5_000);
    expect(crapsOf(c)).toMatchObject({ phase: 'betting', round: 2 });
    expect(crapsOf(c)!.phaseDeadline).toBeUndefined();
    expect(tc.status()).toBe('🎲 THE POINT IS 6 — BETS RIDE · PLACE A BET TO START THE NEXT ROLL');
    tc.pick('2');
    tc.click('field');
    const { T } = openRoll(pages, 2, show + 5_000 + STEP);
    go(pages, T, T);
    expect(tc.status()).toMatch(new RegExp(`^🎲 THE POINT IS 6 — PLACE YOUR BETS · ${nameOf(b)} HAS THE DICE · \\d+s$`));
  });
});
