/**
 * 🧮🎡 Presses at a computed roulette table (casinoTableSession over
 * computedTable): a felt goes down, comes back and comes down as signed
 * slips; nothing to SPIN or open; the house's switch row (with the dev
 * flag, never at craps) and its confirm step; the status lines and notices
 * only a computed table has; the plaque; and the wheel, spun once per
 * result.
 *
 * The UI needs a DOM: this file stubs just enough of one (as
 * casinoTablePresses.test.ts does) to mount the focused table, press its
 * keys and its card's buttons. Each page is its own load of the casino
 * modules (computedPageKit), the table's UI loaded with it; the other
 * players are test identities (computedTestKit) whose records a spec
 * writes by hand, so nothing moves a round but what the spec writes and
 * the page's own duties when a spec runs them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { seedTable } from './computedFold';
import type { SlipRec } from './computedFold';
import {
  clockOf, deleteIn, keysIn, loadPage, PAGE_CTX as CTX, PAGE_TABLE as TABLE, putIn, switchOn, trimByHand,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';

// ── A minimal DOM ────────────────────────────────────────────────────────────

class FakeEl {
  id = '';
  tabIndex = -1;
  textContent = '';
  innerHTML = '';
  parentElement: FakeEl | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners = new Map<string, ((e: unknown) => void)[]>();
  private sub = new Map<string, FakeEl>();
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

vi.stubGlobal('document', {
  createElement: () => new FakeEl(),
  activeElement: null,
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

// ── Pages with a table UI ────────────────────────────────────────────────────

type CasinoTableVisualHandle = import('./casinoTable3d').CasinoTableVisualHandle;

interface UIPage extends Page {
  session: typeof import('./casinoTableSession');
  furniture: typeof import('./furniture');
  focus: typeof import('./deviceFocus');
}

/** Page `name` with the table UI loaded over its own modules. */
async function loadUIPage(name: string, clientID: number): Promise<UIPage> {
  const p = await loadPage(name, clientID);
  const session = await import('./casinoTableSession');
  const furniture = await import('./furniture');
  const focus = await import('./deviceFocus');
  // Keyboard play aims with the focused view's camera: any will do here (the
  // fake table puts no box on screen, so the first box is the one chosen).
  vi.spyOn(focus.deviceFocus, 'getCamera').mockReturnValue({} as never);
  return { ...p, session, furniture, focus };
}

/** A table handle that remembers its felt chips and the spins it was asked
 *  for, and is never mid-spin. */
function fakeTable(): { h: CasinoTableVisualHandle; chips: () => readonly unknown[]; spins: [number, number][] } {
  let last: readonly unknown[] = [];
  const spins: [number, number][] = [];
  const h = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_t, key) => {
      if (key === 'game') return 'roulette';
      if (key === 'halfX') return 0.94;
      if (key === 'halfZ') return 0.44;
      if (key === 'diceState') return () => 'rest';
      if (key === 'wheelSpinning') return () => false;
      if (key === 'wheelSpin') return (pocket: number, seed: number) => { spins.push([pocket, seed]); };
      if (key === 'setFeltChips') return (s: readonly unknown[]) => { last = s; };
      if (key === 'toScreen') return () => null;
      return () => undefined;
    },
  }) as unknown as CasinoTableVisualHandle;
  return { h, chips: () => last, spins };
}

interface AtTable {
  host: FakeEl;
  /** A key at the table. */
  key: (k: string) => void;
  /** The last notice (the screen reader's live line, zero-width space off). */
  said: () => string;
  /** The on-screen notice showing (the last said, for 2.6 s). */
  flash: () => string;
  /** The status line. */
  status: () => string;
  /** The plaque line. */
  plaque: () => string;
  /** The ⚙ card's markup (opened if it isn't). */
  card: () => string;
  /** A press on the open card. */
  press: (act: string) => void;
  /** Pick up one chip (keys 1–6: 1, 5, 25, …) and bet the hand on the
   *  focused box (the first). The hand stays loaded: Enter bets it again. */
  bet: (keyNo?: string) => void;
  /** The frame World runs. */
  update: () => void;
  unmount: () => void;
}

/** Mount the focused table on page p as a player at stand 0. */
function atTable(p: UIPage, opts: { game?: 'roulette' | 'craps'; house?: boolean; t?: string } = {}): AtTable {
  const game = opts.game ?? 'roulette';
  const { h } = fakeTable();
  const ui = p.session.createCasinoTableUI({
    itemId: opts.t ?? TABLE, game, isHouse: () => opts.house ?? false, stand: 0, visual: h,
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
  key('ArrowLeft'); // a box chosen
  return {
    host,
    key,
    said: () => bar.querySelector('[data-live]').textContent.replace(/\u200b/g, ''),
    flash: () => bar.querySelector('[data-flash]').textContent,
    status: () => bar.querySelector('[data-status]').textContent,
    plaque: () => bar.querySelector('[data-fair]').textContent,
    card: () => open().innerHTML,
    press: (act: string) => open().fire('click', {
      target: { closest: () => ({ dataset: { act } }) }, preventDefault() {}, stopPropagation() {},
    }),
    bet: (keyNo = '1') => {
      key(keyNo);
      key('Enter');
    },
    update: () => ui.update(1 / 60),
    unmount: () => ui.unmount(),
  };
}

const T0 = 2_000_000_000;
const kit = new ComputedKit(CTX);
const BOB = testIdentity('bob', 'player-Bob');
const CAT = testIdentity('cat', 'player-Cat');

/** Test identities as players of the room: each pinned on page p. */
function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Page p at the spec's time T, its tables running (no duties: nothing
 *  moves a round but what the spec writes). */
function at(p: Page, T: number): number {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  return now;
}

let a: UIPage;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
  a = await loadUIPage('A', 1);
  a.casino.buyInChips(a.pid, 1_000);
  pinOn(a, BOB, CAT);
  at(a, T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


const LAPSE = 6_000;
const STEP = 200;
const FRIENDLY_RED = '#F28B87';
const RECONNECTING = 'RECONNECTING — PRESS AGAIN IN A MOMENT';
const NO_HAND_SPIN = "NOBODY SPINS THIS TABLE BY HAND — IT SPINS ONCE THE BETTORS' SEEDS ARE IN";

const myFelt = (p: Page, round = 1) => p.table.readMyComputedBets(TABLE, p.pid, round);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const sesOf = (p: Page) => p.casino.computedSessionForWrite(TABLE)!;
/** My written slips of round r, newest last. */
const mySlips = (p: Page, r = 1): SlipRec[] => keysIn(p, 's', r).filter((k) => k.startsWith(`s:${r}:${p.pid}:`))
  .map((k) => sesOf(p).get(k) as SlipRec).sort((x, y) => x.v - y.v);
/** My newest written slip of round r, as Built (for a close to freeze). */
function myNewest(p: Page, r = 1): Built<SlipRec> {
  const key = keysIn(p, 's', r).filter((k) => k.startsWith(`s:${r}:${p.pid}:`))
    .sort((x, y) => (sesOf(p).get(y) as SlipRec).v - (sesOf(p).get(x) as SlipRec).v)[0];
  return { key, hash: key.slice(key.lastIndexOf(':') + 1), rec: sesOf(p).get(key) as SlipRec };
}
/** The seed behind my slip `s` (my page's seed store). */
const mySeed = (p: Page, s: SlipRec): string =>
  p.fair.seedFor(s.c, { room: CTX.room, table: seedTable(CTX), round: s.r, party: p.pid, house: '' })!;
/** Frames of page p (its tables marked running, no duties) every STEP ms
 *  from `from` to `to`, the focused table's frame each time. */
function wait(p: Page, from: number, to: number, t?: AtTable): void {
  for (let T = from; T <= to; T += STEP) {
    at(p, T);
    t?.update();
  }
}
/** Records written into the live session at T. */
function put(p: Page, T: number, ...recs: Built<unknown>[]): void {
  at(p, T);
  putIn(p, recs.map((r): [string, unknown] => [r.key, r.rec]));
}

/** Another page's two writes elsewhere, the second given to p's doc first:
 *  the doc holds part of an update. Returns the rest. */
function partOfAnUpdate(p: Page): Uint8Array {
  const other = new Y.Doc();
  const updates: Uint8Array[] = [];
  other.on('update', (u: Uint8Array) => updates.push(u));
  other.getMap('elsewhere').set('a', 1);
  other.getMap('elsewhere').set('b', 2);
  Y.applyUpdate(p.doc, updates[1]);
  return updates[0];
}

const SID = kit.sidAfter(null);
/** Bob's felt down at T0 + 500, then his close of round 1 at T0 + 19 s
 *  freezing his felt and `others` (the page's frames running to it). */
function bobCloses(p: Page, others: Built<SlipRec>[], t?: AtTable): { bob: Built<SlipRec>; close: Built<import('./computedFold').CloseRec>; at: number } {
  const bob = kit.slip(BOB, 1, [red(10)]);
  put(p, T0 + 500, bob);
  wait(p, T0 + 500, T0 + 19_000, t);
  const close = kit.close(BOB, 1, SID, [bob, ...others]);
  put(p, T0 + 19_000, close);
  t?.update();
  return { bob, close, at: T0 + 19_000 };
}

describe('a felt at a computed table', () => {
  it('goes down, comes back and comes down as slips, with no owner-run list', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    expect(myFelt(a)).toEqual([{ type: 'straight', pick: 0, amount: 1 }]);
    expect(mySlips(a)).toHaveLength(1);
    expect(a.casino.readChips(a.pid)).toBe(999);
    expect(t.flash()).toBe('🤝 FRIENDLY TABLE — SEEDS COME FROM THE PLAYERS ONLY · A MODIFIED GAME CAN STEER OR REWRITE A ROUND');
    expect(a.casino.readAllBets(TABLE, 1)).toEqual({});
    expect([...a.doc.getMap('casino').keys()].filter((k) => k.startsWith('bets:'))).toEqual([]);
    // The same again within the coalescing shows at once, and goes as one version.
    t.key('Enter');
    expect(myFelt(a)).toEqual([{ type: 'straight', pick: 0, amount: 1 }, { type: 'straight', pick: 0, amount: 1 }]);
    expect(mySlips(a)).toHaveLength(1);
    at(a, T0 + 400);
    a.table.tickComputedTables([TABLE], T0 + 400);
    expect(mySlips(a).map((s) => s.b.length)).toEqual([1, 2]);
    expect(a.casino.readChips(a.pid)).toBe(998);
    // ⌫ takes this window's chips back off the box.
    at(a, T0 + 800);
    t.key('Delete');
    expect(myFelt(a)).toEqual([]);
    expect(mySlips(a).at(-1)!.b).toEqual([]);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    // C takes everything down.
    at(a, T0 + 1_200);
    t.key('0'); // (the hand back on the rail)
    t.bet('3');
    expect(myFelt(a)).toEqual([{ type: 'straight', pick: 0, amount: 25 }]);
    at(a, T0 + 1_600);
    t.key('c');
    expect(t.flash()).toBe('TAKEN DOWN — 25 BACK TO YOUR RAIL');
    expect(myFelt(a)).toEqual([]);
    expect(mySlips(a).at(-1)!.b).toEqual([]);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    // And with nothing down, says so.
    t.key('c');
    expect(t.flash()).toBe('NO BETS OF YOURS ON THE TABLE');
    t.unmount();
  });

  it('says RECONNECTING on a doc holding part of an update, and on a page just woken, and nothing goes down', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const rest = partOfAnUpdate(a);
    t.bet('1');
    expect(t.flash()).toBe(RECONNECTING);
    expect(mySlips(a)).toEqual([]);
    Y.applyUpdate(a.doc, rest);
    // Frames stopped for a lapse: the page waits out its wake.
    at(a, T0 + LAPSE + 1_000);
    expect(a.croupier.tablesAwake(T0 + LAPSE + 1_000)).toBe(false);
    t.bet('1');
    expect(t.flash()).toBe(RECONNECTING);
    expect(mySlips(a)).toEqual([]);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    // Awake again, it goes.
    wait(a, T0 + LAPSE + 1_000, T0 + 2 * LAPSE + 1_200);
    t.bet('1');
    expect(mySlips(a)).toHaveLength(1);
    t.unmount();
  });

  it("refuses past the window ('NO MORE BETS'), and once the close is in", () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    wait(a, T0, T0 + 18_000, t);
    at(a, T0 + 18_200);
    t.bet('1');
    expect(t.flash()).toBe('NO MORE BETS');
    t.key('c');
    expect(t.flash()).toBe('NO MORE BETS — THOSE CHIPS STAY');
    expect(myFelt(a)).toHaveLength(1);
    t.unmount();
  });
});

describe("a computed table's ⚙ card", () => {
  it('has no SPIN, NEW ROUND or fairness to set, and says why on a press', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a, { house: true });
    const card = t.card();
    expect(card).toContain("NOBODY RUNS THIS TABLE · THE PLAYERS' PAGES MOVE IT ALONG · ANYONE CAN LOOK");
    expect(card).toContain("BETS CLOSE ON THE TIMER · THE WHEEL SPINS ONCE THE BETTORS' SEEDS ARE IN · STAY UNTIL THE SPIN");
    expect(card).toContain("PLAYERS' TABLE · NO OPERATOR · SEEDS FROM THE PLAYERS");
    for (const act of ['spin', 'next', 'fairness']) expect(card).not.toContain(`data-act="${act}"`);
    expect(card).not.toContain('YOU RUN THIS TABLE');
    for (const act of ['spin', 'next', 'fairness']) {
      at(a, T0 + 1_000);
      t.press(act);
      expect(t.flash()).toBe(NO_HAND_SPIN);
    }
    expect(a.casino.readTableState(TABLE)).toBeNull();
    expect(a.doc.getMap('casino').has(`cfg:fairness:${TABLE}`)).toBe(false);
    t.unmount();
    // (An owner-run table's card has them: the control.)
    const legacy = atTable(a, { house: true, t: 'roulette-legacy' });
    expect(legacy.card()).toContain('data-act="spin"');
    expect(legacy.card()).toContain('YOU RUN THIS TABLE');
    legacy.unmount();
  });

  it("shows the house's switch row with the dev flag only, never at craps, nor to a player", () => {
    const legacy = 'roulette-legacy';
    const row = (opts: { house: boolean; t?: string; game?: 'roulette' | 'craps' }): string => {
      const t = atTable(a, opts);
      const card = t.card();
      t.unmount();
      return card;
    };
    // No flag: no row.
    a.table.setComputedTablesEnabledForTests(false);
    expect(row({ house: true, t: legacy })).not.toContain('computed-');
    a.table.setComputedTablesEnabledForTests(true);
    const off = row({ house: true, t: legacy });
    expect(off).toContain("PLAYERS' TABLE · OFF");
    expect(off).toContain('data-act="computed-on"');
    expect(off).toContain('RUN WITHOUT THE OWNER (FRIENDLY)');
    expect(row({ house: false, t: legacy })).not.toContain('computed-');
    expect(row({ house: true, t: 'craps-1', game: 'craps' })).not.toContain('computed-');
    switchOn(a);
    at(a, T0);
    const on = row({ house: true });
    expect(on).toContain("PLAYERS' TABLE · ON");
    expect(on).toContain('data-act="computed-off"');
    expect(on).toContain('BACK TO THE OWNER');
    expect(row({ house: false })).not.toContain('computed-');
    // A table switched on plays without the flag (it gates who may switch).
    a.table.setComputedTablesEnabledForTests(false);
    const t = atTable(a);
    t.bet('1');
    expect(mySlips(a)).toHaveLength(1);
    t.unmount();
    a.table.setComputedTablesEnabledForTests(null);
  });

  it('asks the house to confirm a switch-on, cancels, then switches; says why when it may not; switches back', () => {
    a.table.setComputedTablesEnabledForTests(true);
    const legacy = 'roulette-legacy';
    a.casino.writeCrapsFairnessPref(legacy, 'rng');
    const t = atTable(a, { house: true, t: legacy });
    t.press('computed-on');
    let card = t.card();
    expect(card).toContain('THIS TABLE WILL RUN FRIENDLY: SEEDS FROM THE PLAYERS ONLY');
    expect(card).toContain('data-act="computed-confirm"');
    expect(card).toContain('data-act="computed-cancel"');
    expect(a.casino.isComputedTable(legacy)).toBe(false);
    t.press('computed-cancel');
    card = t.card();
    expect(card).not.toContain('THIS TABLE WILL RUN FRIENDLY');
    expect(card).toContain('data-act="computed-on"');
    expect(a.casino.isComputedTable(legacy)).toBe(false);
    // Closing the card forgets a confirm left open.
    t.press('computed-on');
    t.key('s');
    expect(t.card()).not.toContain('THIS TABLE WILL RUN FRIENDLY');
    // A round under way: the row says why, and so does a press.
    a.croupier.openBetting(legacy, 1);
    a.casino.writeMyBets(legacy, 'player-Bob', 1, [red(10)]);
    expect(t.card()).toContain('FINISH THIS ROUND FIRST');
    t.press('computed-on');
    t.press('computed-confirm');
    expect(t.flash()).toBe('FINISH THIS ROUND FIRST');
    expect(a.casino.isComputedTable(legacy)).toBe(false);
    a.casino.writeMyBets(legacy, 'player-Bob', 1, []);
    t.press('computed-on');
    t.press('computed-confirm');
    expect(t.flash()).toBe('THE PLAYERS RUN THIS TABLE NOW — NO OPERATOR · FRIENDLY');
    expect(a.casino.isComputedTable(legacy)).toBe(true);
    expect(a.casino.readTableState(legacy)).toBeNull();
    card = t.card();
    expect(card).toContain("PLAYERS' TABLE · ON");
    // And back.
    at(a, T0 + 500);
    t.press('computed-off');
    expect(t.flash()).toBe('THE OWNER RUNS THIS TABLE AGAIN FROM ITS NEXT ROUND');
    expect(a.casino.isComputedTable(legacy)).toBe(false);
    expect(t.card()).toContain("PLAYERS' TABLE · OFF");
    t.unmount();
    a.table.setComputedTablesEnabledForTests(null);
  });

  it('refuses a switch-off while a close is in', () => {
    a.table.setComputedTablesEnabledForTests(true);
    switchOn(a);
    at(a, T0);
    const t = atTable(a, { house: true });
    bobCloses(a, [], t);
    expect(t.card()).toContain('WAIT FOR THE SPIN TO FINISH');
    t.press('computed-off');
    expect(t.flash()).toBe('WAIT FOR THE SPIN TO FINISH');
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    t.unmount();
    a.table.setComputedTablesEnabledForTests(null);
  });
});

describe('the plaque', () => {
  it("reads the players' table on a computed table, the owner's on an owner-run one, and turns with the switch", () => {
    const t = atTable(a);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    t.update();
    expect(t.plaque()).toBe("🤝 FRIENDLY TABLE · YOU'RE TRUSTING THE OWNER");
    switchOn(a);
    at(a, T0);
    t.update();
    expect(t.plaque()).toBe("PLAYERS' TABLE · NO OPERATOR · SEEDS FROM THE PLAYERS");
    expect(a.session.fairnessBadge(TABLE, 'roulette')).toEqual({
      text: "PLAYERS' TABLE · NO OPERATOR · SEEDS FROM THE PLAYERS", color: FRIENDLY_RED, fair: false,
    });
    // (Never at craps under the same id.)
    expect(a.session.fairnessBadge(TABLE, 'craps').text).not.toContain("PLAYERS' TABLE");
    t.unmount();
  });
});

describe('the status line and notices', () => {
  it('a close in: STAY UNTIL THE SPIN for a frozen bettor, WAITING FOR SEEDS for anyone else', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    expect(t.status()).toMatch(/^🎡 ROUND 1 — PLACE YOUR BETS · 18s/);
    const mine = myNewest(a);
    bobCloses(a, [mine], t);
    expect(t.status()).toBe('✋ NO MORE BETS — STAY UNTIL THE SPIN');
    // Revealed: just waiting now.
    put(a, T0 + 19_200, kit.reveal(1, a.pid, mySeed(a, mine.rec)));
    t.update();
    expect(t.status()).toBe('✋ NO MORE BETS — WAITING FOR SEEDS');
    t.unmount();
  });

  it("TOO LATE when a later felt of mine crossed the close that froze the earlier one", () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    const first = myNewest(a);
    at(a, T0 + 1_000);
    t.key('Enter'); // a second chip, gone at once: version 2
    expect(mySlips(a).map((s) => s.v)).toEqual([1, 2]);
    bobCloses(a, [first], t);
    expect(t.status()).toBe('✋ TOO LATE — THE CLOSE HAD YOUR EARLIER BETS');
    // It holds the frozen felt's chips, not the later one's.
    expect(a.casino.readChips(a.pid)).toBe(999);
    // And the result line says so too.
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.reveal(1, a.pid, mySeed(a, first.rec)));
    t.update();
    expect(t.status()).toMatch(/^● \d+ (RED|BLACK|GREEN)( — YOU WIN)? · TOO LATE — THE CLOSE HAD YOUR EARLIER BETS$/);
    t.unmount();
  });

  it('TOO LATE when the close came while my felt waited to go (the flush found the round closed)', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    const first = myNewest(a);
    at(a, T0 + 100);
    t.key('Enter'); // held back by the coalescing, and never flushed in time
    expect(myFelt(a)).toHaveLength(2);
    expect(mySlips(a)).toHaveLength(1);
    const { at: closedAt } = bobCloses(a, [first], t);
    // (Only the frozen felt is written: nothing says it yet.)
    expect(t.status()).toBe('✋ NO MORE BETS — STAY UNTIL THE SPIN');
    a.table.tickComputedTables([TABLE], closedAt);
    t.update();
    expect(t.status()).toBe('✋ TOO LATE — THE CLOSE HAD YOUR EARLIER BETS');
    expect(mySlips(a)).toHaveLength(1);
    expect(myFelt(a)).toEqual([{ type: 'straight', pick: 0, amount: 1 }]); // the frozen felt
    t.unmount();
  });

  it('MISSED THE CLOSE when the close left my felt out, and the result line says so', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    bobCloses(a, [], t);
    expect(t.status()).toBe('✋ YOUR BET MISSED THE CLOSE — CHIPS BACK');
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'reveals' });
    t.update();
    expect(t.status()).toMatch(/^● \d+ (RED|BLACK|GREEN) · YOUR BET MISSED THE CLOSE — CHIPS BACK$/);
    t.unmount();
  });

  it('a forfeit: STAY UNTIL THE SPIN through its hold, then SEED NEVER CAME; a seed after it, CAME IN LATE; the card says who forfeited', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    const mine = myNewest(a);
    const { close } = bobCloses(a, [mine], t);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.forfeit(BOB, 1, close.hash, [BOB.pid]));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit' });
    t.update();
    expect(t.status()).toBe('✋ NO MORE BETS — STAY UNTIL THE SPIN');
    let T = T0 + 19_200;
    for (; a.table.readComputedRoulette(TABLE, T)?.phase === 'closing'; T += STEP) {
      at(a, T);
      t.update();
      expect(t.status()).toBe('✋ NO MORE BETS — STAY UNTIL THE SPIN');
    }
    at(a, T);
    t.update();
    expect(t.status()).toMatch(/^● \d+ (RED|BLACK|GREEN)( — YOU WIN)? · YOUR SEED NEVER CAME — BETS FORFEITED$/);
    let card = t.card();
    expect(card).toContain('🔓 LAST SPIN · ROUND 1 · 1 OF 2 SEEDS COUNTED · DECIDED BY A FORFEIT BY PLAYER-B');
    expect(card).toContain('✗ YOUR SEED NEVER CAME — BETS FORFEITED');
    // My seed, after the forfeit decided it.
    put(a, T + STEP, kit.reveal(1, a.pid, mySeed(a, mine.rec)));
    t.update();
    expect(t.status()).toMatch(/· YOUR SEED CAME IN LATE — BETS FORFEITED$/);
    card = t.card();
    expect(card).toContain('✗ YOUR SEED CAME IN LATE — BETS FORFEITED');
    t.unmount();
  });

  it('SPIN VOID when nobody could finish it, stakes back', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    const mine = myNewest(a);
    const { close } = bobCloses(a, [mine], t);
    put(a, T0 + 19_200, kit.abandon(BOB, 1, close.hash));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'void' });
    t.update();
    expect(t.status()).toBe('⚠ SPIN VOID — NOBODY COULD FINISH IT · STAKES RETURNED');
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    expect(t.card()).toContain('🔓 LAST SPIN · ROUND 1 · VOID — NOBODY COULD FINISH IT · STAKES RETURNED');
    t.unmount();
  });

  it('a round decided by every reveal: the result, and the card\'s verdict', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    const mine = myNewest(a);
    bobCloses(a, [mine], t);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.reveal(1, a.pid, mySeed(a, mine.rec)));
    const D = foldOf(a).rounds[0];
    expect(D).toMatchObject({ decided: 'reveals' });
    t.update();
    expect(t.status()).toMatch(new RegExp(`^● ${D.pocket} `));
    expect(t.status()).not.toContain('·');
    expect(t.card()).toContain('🔓 LAST SPIN · ROUND 1 · 2 OF 2 SEEDS COUNTED · DECIDED BY ALL REVEALS · ✓ YOUR SLIP WAS FROZEN');
    t.unmount();
  });

  it('ROUND n UNDONE when a round this page showed decided is no longer on the chain', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const cat = kit.slip(CAT, 1, [black(10)]);
    put(a, T0 + 100, cat);
    bobCloses(a, [cat], t);
    const xb = kit.reveal(1, BOB.pid);
    const xc = kit.reveal(1, CAT.pid);
    put(a, T0 + 19_200, xb, xc);
    t.update();
    expect(t.status()).toMatch(/^● \d+ /);
    // A delete takes a seed back out: round 1 is open again.
    at(a, T0 + 19_400);
    deleteIn(a, [xc.key]);
    expect(foldOf(a).rounds[0].decided).toBeNull();
    t.update();
    expect(t.status()).toBe('⚠ ROUND 1 UNDONE — BETS BACK');
    t.unmount();
  });

  it('ROUND n WAS REWRITTEN once, when a rival close outranks the one shown; the card flags it replaced after its seeds were out', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    // W outranks L for round 1's close: L's close shows first, W's comes after.
    const [W, L] = a.fold.dutyRank('close', CTX, 1, BOB.pub) < a.fold.dutyRank('close', CTX, 1, CAT.pub) ? [BOB, CAT] : [CAT, BOB];
    const sw = kit.slip(W, 1, [red(10)]);
    const sl = kit.slip(L, 1, [black(10)]);
    put(a, T0 + 500, sw, sl);
    wait(a, T0 + 500, T0 + 19_000, t);
    const cl = kit.close(L, 1, SID, [sl]);
    put(a, T0 + 19_000, cl, kit.reveal(1, L.pid));
    t.update();
    const shown = foldOf(a).rounds[0];
    expect(shown).toMatchObject({ close: cl.hash, decided: 'reveals' });
    expect(t.flash()).toBe('');
    // W's close, freezing both, and W's seed: a longer… an equal chain that outranks.
    const cw = kit.close(W, 1, SID, [sw, sl]);
    put(a, T0 + 19_400, cw, kit.reveal(1, W.pid));
    const now = foldOf(a).rounds[0];
    expect(now).toMatchObject({ close: cw.hash, decided: 'reveals' });
    expect(now.pocket).not.toBe(shown.pocket);
    t.update();
    expect(t.flash()).toBe('ROUND 1 WAS REWRITTEN');
    expect(t.card()).toContain('🚩 ROUND 1 REPLACED AFTER ITS SEEDS WERE OUT');
    // Told once: another notice since stays.
    at(a, T0 + 19_600);
    t.key('c');
    expect(t.flash()).toBe('NO BETS OF YOURS ON THE TABLE');
    t.update();
    expect(t.flash()).toBe('NO BETS OF YOURS ON THE TABLE');
    // The flag outlives a trim that takes the round out of the session.
    at(a, T0 + 19_800);
    trimByHand(a, W);
    t.update();
    expect(foldOf(a).rounds).toEqual([]);
    expect(t.card()).toContain('🚩 ROUND 1 REPLACED AFTER ITS SEEDS WERE OUT');
    t.unmount();
  });

  it('an honest rival close (in before any seed) that outranks the one shown: the notice, and no flag', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const [W, L] = a.fold.dutyRank('close', CTX, 1, BOB.pub) < a.fold.dutyRank('close', CTX, 1, CAT.pub) ? [BOB, CAT] : [CAT, BOB];
    const sw = kit.slip(W, 1, [red(10)]);
    const sl = kit.slip(L, 1, [black(10)]);
    put(a, T0 + 500, sw, sl);
    wait(a, T0 + 500, T0 + 19_000, t);
    const cl = kit.close(L, 1, SID, [sl]);
    const cw = kit.close(W, 1, SID, [sw, sl]);
    put(a, T0 + 19_000, cl, cw);
    put(a, T0 + 19_200, kit.reveal(1, L.pid));
    t.update();
    expect(foldOf(a).rounds[0]).toMatchObject({ close: cl.hash, decided: 'reveals' });
    put(a, T0 + 19_400, kit.reveal(1, W.pid));
    expect(foldOf(a).rounds[0]).toMatchObject({ close: cw.hash, decided: 'reveals' });
    t.update();
    expect(t.flash()).toBe('ROUND 1 WAS REWRITTEN');
    expect(t.card()).not.toContain('REPLACED');
    t.unmount();
  });

  it('TABLE SWITCHED — YOUR BETS ARE BACK when the house switches the table off under my felt', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    expect(a.casino.readChips(a.pid)).toBe(999);
    at(a, T0 + 500);
    expect(a.table.switchComputedOff(TABLE, T0 + 500)).toBe('ok');
    t.update();
    expect(t.flash()).toBe('TABLE SWITCHED — YOUR BETS ARE BACK');
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    t.unmount();
  });

  it('warns on the card while an earlier build drives the table too', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    expect(t.card()).not.toContain('AN OLDER GAME VERSION');
    a.casino.transactCasino(() => a.casino.writeTableState(TABLE, {
      kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null, ...a.casino.tableOpening(TABLE),
    }));
    expect(t.card()).toContain('⚠ AN OLDER GAME VERSION IS ALSO RUNNING THIS TABLE');
    t.unmount();
  });

  it('no MISSED THE CLOSE for a felt taken down before the close (a close freezes felts with chips on): not while closing, nor on the result line or the card', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a, { house: true });
    t.bet('1');
    expect(mySlips(a)).toHaveLength(1);
    // Taken down again, well before the close: an empty felt goes down.
    at(a, T0 + 1_000);
    t.key('c');
    expect(t.flash()).toBe('TAKEN DOWN — 1 BACK TO YOUR RAIL');
    expect(mySlips(a).at(-1)!.b).toEqual([]);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    // Bob closes with his own felt alone in (mine had nothing on it).
    bobCloses(a, [], t);
    expect(a.table.readComputedRoulette(TABLE)!.phase).toBe('closing');
    expect(a.table.computedMine(TABLE)).toMatchObject({ frozen: false, leftOut: false });
    expect(t.status()).toBe('✋ NO MORE BETS — WAITING FOR SEEDS');
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid));
    t.update();
    expect(a.table.readComputedRoulette(TABLE)!.phase).toBe('settled');
    expect(t.status()).not.toContain('MISSED THE CLOSE');
    expect(a.table.computedRoundCheck(TABLE)!.mine).toBeNull();
    expect(t.card()).not.toContain('LEFT OUT');
    t.unmount();
  });

  it("a switch a peer takes away under my felt: no TABLE SWITCHED (the table's pages put it back, my felt still down)", () => {
    switchOn(a);
    at(a, T0);
    if (!a.furniture.FURNITURE.some((i) => i.id === TABLE)) {
      a.furniture.FURNITURE.push({ id: TABLE, kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    const t = atTable(a);
    t.bet('1');
    a.table.tickComputedTables([TABLE], T0);
    expect(a.casino.readChips(a.pid)).toBe(999);
    const said = t.flash();
    expect(said).not.toContain('TABLE SWITCHED');
    // A peer deletes the switch alone: no end mark, so no build did it.
    a.doc.transact(() => a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`));
    t.update();
    expect(t.flash()).toBe(said);
    // The page's next frame puts it back, and the felt holds again.
    at(a, T0 + 500);
    a.table.tickComputedTables([TABLE], T0 + 500);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    t.update();
    expect(t.flash()).toBe(said);
    expect(a.casino.readChips(a.pid)).toBe(999);
    t.unmount();
  });
});

describe('the wheel at a computed table', () => {
  it('spins once per spin key: not for a result showing as the page walks up, again for a rewrite', () => {
    switchOn(a);
    at(a, T0);
    if (!a.furniture.FURNITURE.some((i) => i.id === TABLE)) {
      a.furniture.FURNITURE.push({ id: TABLE, kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    const wheel = fakeTable();
    const frameAt = (T: number): void => {
      at(a, T);
      a.session.casinoTablesFrame(1 / 60, new Map([[TABLE, wheel.h]]));
    };
    frameAt(T0);
    const [W, L] = a.fold.dutyRank('close', CTX, 1, BOB.pub) < a.fold.dutyRank('close', CTX, 1, CAT.pub) ? [BOB, CAT] : [CAT, BOB];
    const sw = kit.slip(W, 1, [red(10)]);
    const sl = kit.slip(L, 1, [black(10)]);
    put(a, T0 + 500, sw, sl);
    for (let T = T0 + 500; T <= T0 + 19_000; T += STEP) frameAt(T);
    expect(wheel.spins).toEqual([]);
    // The felt laid is the computed one: W's chip and L's.
    expect(wheel.chips()).toHaveLength(2);
    const cl = kit.close(L, 1, SID, [sl]);
    put(a, T0 + 19_000, cl, kit.reveal(1, L.pid));
    for (let T = T0 + 19_000; T <= T0 + 19_400; T += STEP) frameAt(T);
    const p1 = foldOf(a).rounds[0].pocket!;
    expect(wheel.spins).toEqual([[p1, 1 * 7919 + 13]]);
    // Walked up mid-show (a fresh runtime): nothing old spins.
    a.session.forgetCasinoTable(TABLE);
    frameAt(T0 + 19_600);
    expect(wheel.spins).toHaveLength(1);
    // A rewrite spins again, once.
    const cw = kit.close(W, 1, SID, [sw, sl]);
    put(a, T0 + 19_800, cw, kit.reveal(1, W.pid));
    for (let T = T0 + 19_800; T <= T0 + 20_400; T += STEP) frameAt(T);
    const p2 = foldOf(a).rounds[0].pocket!;
    expect(p2).not.toBe(p1);
    expect(wheel.spins).toEqual([[p1, 7919 + 13], [p2, 7919 + 13]]);
  });

  it("spins nothing showing as a page opens whose signature checks finish after its first frame (it primes on the table counted and checked)", async () => {
    switchOn(a);
    at(a, T0);
    // Round 1 on page A: Bob's and Cat's felts, Bob's close, both seeds in.
    const bob = kit.slip(BOB, 1, [red(10)]);
    const cat = kit.slip(CAT, 1, [black(10)]);
    put(a, T0 + 500, bob, cat);
    const close = kit.close(BOB, 1, SID, [bob, cat]);
    put(a, T0 + 19_000, close);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.reveal(1, CAT.pid));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'reveals' });
    // Page B opens on the room mid-show; its checks run in slices (as a
    // browser's 40 ms budget does on a full session): none done yet.
    const b = await loadUIPage('B', 2);
    if (!b.furniture.FURNITURE.some((i) => i.id === TABLE)) {
      b.furniture.FURNITURE.push({ id: TABLE, kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    b.casino.setComputedVerifyForTests({ budgetMs: 0 });
    const T = T0 + 20_000;
    clockOf(b, T);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const wheel = fakeTable();
    const frameAt = (now: number): void => {
      clockOf(b, now);
      b.session.casinoTablesFrame(1 / 60, new Map([[TABLE, wheel.h]]));
    };
    frameAt(T);
    expect(b.table.readComputedRoulette(TABLE, T)).toMatchObject({ phase: 'betting', round: 1, spinKey: '' });
    expect(b.casino.computedSettled(TABLE)).toBe(false);
    // The checks finish a moment later (the slice the page queued).
    b.casino.setComputedVerifyForTests({ now: () => 0 });
    vi.advanceTimersByTime(50);
    for (let now = T + 50; now <= T + 600; now += STEP) frameAt(now);
    const after = b.table.readComputedRoulette(TABLE, T + 600)!;
    expect(after.phase).toBe('settled');
    expect(after.spinKey).toBe(`1:${foldOf(a).rounds[0].pocket}`);
    expect(wheel.spins).toEqual([]);
    // What comes next spins, as it would have.
    const bob2 = kit.slip(BOB, 2, [red(10)]);
    const close2 = kit.close(BOB, 2, close.hash, [bob2]);
    clockOf(b, T + 800);
    putIn(b, [[bob2.key, bob2.rec], [close2.key, close2.rec], [kit.reveal(2, BOB.pid).key, kit.reveal(2, BOB.pid).rec]]);
    frameAt(T + 1_000);
    expect(wheel.spins).toEqual([[foldOf(b).rounds[1].pocket!, 2 * 7919 + 13]]);
  });

  it('spins again for a round rewritten back to the pocket it first showed, with its notice; not for a round showing again when a later one is undone', () => {
    switchOn(a);
    at(a, T0);
    if (!a.furniture.FURNITURE.some((i) => i.id === TABLE)) {
      a.furniture.FURNITURE.push({ id: TABLE, kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    const wheel = fakeTable();
    const t = atTable(a);
    const frameAt = (T: number): void => {
      at(a, T);
      a.session.casinoTablesFrame(1 / 60, new Map([[TABLE, wheel.h]]));
      t.update();
    };
    frameAt(T0);
    const [W, L] = a.fold.dutyRank('close', CTX, 1, BOB.pub) < a.fold.dutyRank('close', CTX, 1, CAT.pub) ? [BOB, CAT] : [CAT, BOB];
    const sw = kit.slip(W, 1, [red(10)]);
    const sl = kit.slip(L, 1, [black(10)]);
    put(a, T0 + 500, sw, sl);
    for (let T = T0 + 500; T <= T0 + 19_000; T += STEP) frameAt(T);
    // L's close and seed: round 1 shows pocket A.
    const cl = kit.close(L, 1, SID, [sl]);
    put(a, T0 + 19_000, cl, kit.reveal(1, L.pid));
    for (let T = T0 + 19_000; T <= T0 + 19_400; T += STEP) frameAt(T);
    const A = foldOf(a).rounds[0].pocket!;
    // W's close (it outranks) and seed: rewritten to pocket B, spun again.
    const cw = kit.close(W, 1, SID, [sw, sl]);
    put(a, T0 + 19_600, cw, kit.reveal(1, W.pid));
    for (let T = T0 + 19_600; T <= T0 + 20_000; T += STEP) frameAt(T);
    const B = foldOf(a).rounds[0].pocket!;
    expect(B).not.toBe(A);
    expect(t.flash()).toBe('ROUND 1 WAS REWRITTEN');
    expect(wheel.spins).toEqual([[A, 7919 + 13], [B, 7919 + 13]]);
    // W's close is deleted (a peer's delete): round 1 is L's again, pocket A.
    at(a, T0 + 20_200);
    t.key('c'); // (another notice, so the next one is told afresh)
    expect(t.flash()).toBe('NO BETS OF YOURS ON THE TABLE');
    deleteIn(a, [cw.key]);
    for (let T = T0 + 20_200; T <= T0 + 20_600; T += STEP) frameAt(T);
    expect(foldOf(a).rounds[0]).toMatchObject({ close: cl.hash, pocket: A });
    expect(t.flash()).toBe('ROUND 1 WAS REWRITTEN');
    expect(wheel.spins).toEqual([[A, 7919 + 13], [B, 7919 + 13], [A, 7919 + 13]]);
    // Round 2 decided on it, then undone (its close deleted): round 1's
    // result shows again, its pocket the one last spun, and nothing spins.
    const s2 = kit.slip(L, 2, [red(10)]);
    const c2 = kit.close(L, 2, cl.hash, [s2]);
    put(a, T0 + 40_000, s2, c2, kit.reveal(2, L.pid));
    for (let T = T0 + 40_000; T <= T0 + 40_400; T += STEP) frameAt(T);
    expect(foldOf(a).rounds[1]).toMatchObject({ decided: 'reveals' });
    expect(wheel.spins).toHaveLength(4);
    deleteIn(a, [c2.key]);
    for (let T = T0 + 40_600; T <= T0 + 41_000; T += STEP) frameAt(T);
    expect(a.table.readComputedRoulette(TABLE)!.spinKey).toBe(`1:${A}`);
    expect(wheel.spins).toHaveLength(4);
    t.unmount();
  });
});

describe('a felt at a computed table, refused', () => {
  it('NOT ENOUGH CHIPS when the felt held back to go is more than the chips left', () => {
    switchOn(a);
    at(a, T0);
    a.casino.cashOutChips(a.pid, 990); // 10 left
    const t = atTable(a);
    t.bet('2'); // a 5
    expect(mySlips(a).map((s) => s.b.length)).toEqual([1]);
    expect(a.casino.readChips(a.pid)).toBe(5);
    at(a, T0 + 100);
    t.key('Enter'); // another 5: held back to go
    expect(myFelt(a)).toHaveLength(2);
    at(a, T0 + 200);
    t.key('Enter'); // a third: 15 on a felt of 10 chips
    expect(t.flash()).toBe('NOT ENOUGH CHIPS — VISIT THE CASHIER');
    expect(myFelt(a)).toHaveLength(2);
    t.unmount();
  });

  it('THE TABLE IS FULL when 31 others came while my felt waited to go', () => {
    switchOn(a);
    at(a, T0);
    const others = Array.from({ length: 31 }, (_, i) => testIdentity(`p${i}`, `player-P${i}`));
    pinOn(a, ...others);
    const slips = others.map((id) => kit.slip(id, 1, [red(1)]));
    put(a, T0, ...slips.slice(0, 30));
    const t = atTable(a);
    t.bet('1');
    at(a, T0 + 400);
    t.key('c'); // down again: my written felt is empty
    at(a, T0 + 500);
    t.key('Enter'); // held back to go
    expect(myFelt(a)).toHaveLength(1);
    put(a, T0 + 550, slips[30]);
    at(a, T0 + 600);
    t.key('Enter');
    expect(t.flash()).toBe('THE TABLE IS FULL — WAIT FOR A PLACE');
    // And a newcomer with nothing down is told before anything is tried.
    at(a, T0 + 1_000);
    a.table.tickComputedTables([TABLE], T0 + 1_000);
    t.key('c');
    at(a, T0 + 1_400);
    a.table.tickComputedTables([TABLE], T0 + 1_400);
    expect(myFelt(a)).toEqual([]);
    t.key('Enter');
    expect(t.flash()).toBe('THE TABLE IS FULL — WAIT FOR A PLACE');
    expect(mySlips(a).at(-1)!.b).toEqual([]);
    t.unmount();
  });

  it('RECONNECTING on a table switched on whose session this page has yet to get', () => {
    a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: CTX.inc });
    at(a, T0);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(a.table.readComputedRoulette(TABLE)).toBeNull();
    const t = atTable(a);
    t.bet('1');
    expect(t.flash()).toBe(RECONNECTING);
    t.unmount();
  });

  it("warns once per table of the computed table's Friendly terms, even after the owner-run table's warning", () => {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.croupier.openBetting(TABLE, 1);
    const t = atTable(a);
    t.bet('1');
    expect(t.flash()).toBe("🤝 FRIENDLY TABLE — THE OWNER COULD STEER RESULTS · BET WITH PEOPLE YOU TRUST");
    a.casino.writeMyBets(TABLE, a.pid, 1, []);
    a.casino.transactCasino(() => a.casino.clearTableKeys(TABLE, 'local'));
    switchOn(a);
    at(a, T0 + 500);
    t.key('Enter');
    expect(t.flash()).toBe('🤝 FRIENDLY TABLE — SEEDS COME FROM THE PLAYERS ONLY · A MODIFIED GAME CAN STEER OR REWRITE A ROUND');
    at(a, T0 + 1_000);
    t.key('c');
    expect(t.flash()).toMatch(/^TAKEN DOWN/);
    t.key('Enter');
    expect(myFelt(a)).toHaveLength(1);
    expect(t.flash()).toMatch(/^TAKEN DOWN/); // not warned again
    t.unmount();
  });
});

describe("the house's switch row, pressed the wrong way round (a stale card)", () => {
  it('says nothing: a confirm on a computed table, a switch-off on an owner-run one', () => {
    a.table.setComputedTablesEnabledForTests(true);
    const t = atTable(a, { house: true, t: 'roulette-legacy' });
    t.key('0'); // (a notice to stay)
    const before = t.flash();
    t.press('computed-off');
    expect(t.flash()).toBe(before);
    expect(a.casino.isComputedTable('roulette-legacy')).toBe(false);
    switchOn(a);
    at(a, T0);
    const c = atTable(a, { house: true });
    c.key('c');
    expect(c.flash()).toBe('NO BETS OF YOURS ON THE TABLE');
    c.press('computed-confirm');
    expect(c.flash()).toBe('NO BETS OF YOURS ON THE TABLE');
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    t.unmount();
    c.unmount();
    a.table.setComputedTablesEnabledForTests(null);
  });
});

describe("the house's switch row, without the dev flag", () => {
  it('switches nothing on: no row, and a press does nothing; a computed table shows the way back, and it goes', () => {
    a.table.setComputedTablesEnabledForTests(false);
    const t = atTable(a, { house: true, t: 'roulette-legacy' });
    expect(t.card()).not.toContain('computed-');
    t.press('computed-on');
    t.press('computed-confirm');
    expect(a.casino.isComputedTable('roulette-legacy')).toBe(false);
    // A table computed already (a flagged page's switch, or a peer's
    // forgery): the house has the way back, flag or not.
    switchOn(a);
    at(a, T0);
    const c = atTable(a, { house: true });
    const card = c.card();
    expect(card).toContain("PLAYERS' TABLE · ON");
    expect(card).toContain('data-act="computed-off"');
    expect(card).not.toContain('data-act="computed-on"');
    c.press('computed-off');
    expect(c.flash()).toBe('THE OWNER RUNS THIS TABLE AGAIN FROM ITS NEXT ROUND');
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    expect(c.card()).not.toContain('computed-');
    t.unmount();
    c.unmount();
    a.table.setComputedTablesEnabledForTests(null);
  });
});

describe("the ⚙ card's flags", () => {
  it('a frozen slip that never came, counted as no stake', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const bob = kit.slip(BOB, 1, [red(10)]);
    put(a, T0 + 500, bob);
    wait(a, T0 + 500, T0 + 19_000, t);
    const close = kit.close(BOB, 1, SID, { [BOB.pid]: bob.hash, [CAT.pid]: 'ab'.repeat(16) });
    put(a, T0 + 19_000, close, kit.reveal(1, BOB.pid));
    put(a, T0 + 19_200, kit.forfeit(BOB, 1, close.hash, [BOB.pid]));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', missing: [CAT.pid] });
    expect(t.card()).toContain('1 OF 2 SEEDS COUNTED · DECIDED BY A FORFEIT BY PLAYER-B · 1 FROZEN SLIP NEVER CAME (NOT STAKED)');
    t.unmount();
  });

  it('a forfeit that dropped a seed this page saw in time', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const cat = kit.slip(CAT, 1, [black(10)]);
    put(a, T0 + 100, cat);
    const { close } = bobCloses(a, [cat], t);
    put(a, T0 + 19_200, kit.reveal(1, CAT.pid));
    put(a, T0 + 19_400, kit.reveal(1, BOB.pid), kit.forfeit(BOB, 1, close.hash, [BOB.pid]));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [BOB.pid] });
    expect(t.card()).toContain('🚩 A FORFEIT DROPPED A SEED THIS PAGE SAW IN TIME');
    t.unmount();
  });

  it("a frozen slip under a key that isn't its player's", () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const forged = kit.slip(BOB, 1, [black(10)], { p: CAT.pid });
    put(a, T0 + 100, forged);
    bobCloses(a, [forged], t);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.reveal(1, CAT.pid));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'reveals' });
    expect(t.card()).toContain("🚩 A FROZEN SLIP'S KEY ISN'T ITS PLAYER'S");
    t.unmount();
  });

  it('a checkpoint that differs from what this page folded', () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    const cat = kit.slip(CAT, 1, [black(10)]);
    put(a, T0 + 100, cat);
    bobCloses(a, [cat], t);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.reveal(1, CAT.pid));
    t.update();
    expect(t.card()).not.toContain('CHECKPOINT');
    const nets = Object.fromEntries(foldOf(a).nets);
    at(a, T0 + 19_400);
    trimByHand(a, BOB, { ...nets, [BOB.pid]: (nets[BOB.pid] ?? 0n) + 7n });
    t.update();
    expect(t.card()).toContain('🚩 THE CHECKPOINT DIFFERS FROM THIS PAGE BY 7 CHIPS');
    t.unmount();
  });

  it("names a forfeit's writer as text: a name with markup in it goes into the card escaped (any peer can rewrite players[pid])", async () => {
    // The room's players map is the games doc's (main.ts binds both to the room doc).
    const games = await import('./games/gamesDoc');
    games.bindGamesDoc(a.doc);
    const EVIL = '<img src=x onerror=&#97;&#108;&#101;&#114;&#116;(1)>';
    a.doc.transact(() => a.doc.getMap('players').set(BOB.pid, { keyB64: BOB.pub, name: EVIL }));
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    const mine = myNewest(a);
    const { close } = bobCloses(a, [mine], t);
    put(a, T0 + 19_200, kit.reveal(1, BOB.pid), kit.forfeit(BOB, 1, close.hash, [BOB.pid]));
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit' });
    let T = T0 + 19_200;
    for (; a.table.readComputedRoulette(TABLE, T)?.phase === 'closing'; T += STEP) at(a, T);
    at(a, T);
    t.update();
    const card = t.card();
    expect(card).toContain('DECIDED BY A FORFEIT BY &lt;IMG SRC=X ONERROR=&amp;#97;');
    expect(card).not.toMatch(/<IMG /i);
    t.unmount();
  });
});

describe("the ⚙ card's replaced flag", () => {
  /** Round 1 of W and L: L's close and seed in, the round decided, its
   *  check read; W's close of both comes later. */
  function lShown(): { W: TestIdentity; L: TestIdentity; sw: Built<SlipRec>; sl: Built<SlipRec> } {
    switchOn(a);
    at(a, T0);
    const [W, L] = a.fold.dutyRank('close', CTX, 1, BOB.pub) < a.fold.dutyRank('close', CTX, 1, CAT.pub) ? [BOB, CAT] : [CAT, BOB];
    const sw = kit.slip(W, 1, [red(10)]);
    const sl = kit.slip(L, 1, [black(10)]);
    put(a, T0 + 500, sw, sl);
    wait(a, T0 + 500, T0 + 19_000);
    put(a, T0 + 19_000, kit.close(L, 1, SID, [sl]), kit.reveal(1, L.pid));
    expect(a.table.computedRoundCheck(TABLE, T0 + 19_000)).toMatchObject({ round: 1, decided: 'reveals' });
    return { W, L, sw, sl };
  }

  it('is not raised for a close this page slept through (it cannot tell when the seeds came)', () => {
    const { W, sw, sl } = lShown();
    // No frames for over a lapse; W's close and seed come meanwhile.
    const T = T0 + 19_000 + LAPSE + 1_000;
    const cw = kit.close(W, 1, SID, [sw, sl]);
    put(a, T, cw, kit.reveal(1, W.pid));
    const check = a.table.computedRoundCheck(TABLE, T)!;
    expect(foldOf(a).rounds[0].close).toBe(cw.hash);
    expect(check.round).toBe(1);
    expect(check.replaced).toBeUndefined();
  });

  it('outlives a trim that came before the card was read again', () => {
    const { W, sw, sl } = lShown();
    put(a, T0 + 19_400, kit.close(W, 1, SID, [sw, sl]), kit.reveal(1, W.pid));
    // Read (noted), but no check asked for, before the trim lands.
    expect(a.table.computedDecidedTo(TABLE)).toBe(1);
    at(a, T0 + 19_600);
    trimByHand(a, W);
    expect(foldOf(a).rounds).toEqual([]);
    expect(a.table.computedRoundCheck(TABLE, T0 + 19_600)).toMatchObject({ round: 1, replaced: 1 });
  });
});

describe('a page holding part of an update', () => {
  it("says nothing of a switch it reads as gone there", () => {
    switchOn(a);
    at(a, T0);
    const t = atTable(a);
    t.bet('1');
    // Another page rewrites the switch just after a write this page has yet
    // to get: the old value deleted at once, the new one parked.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(a.doc));
    const updates: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => updates.push(u));
    other.getMap('elsewhere').set('note', 1);
    other.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: CTX.inc });
    at(a, T0 + 500);
    t.key('0');
    Y.applyUpdate(a.doc, updates[1]);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    t.update();
    expect(t.flash()).not.toContain('TABLE SWITCHED');
    Y.applyUpdate(a.doc, updates[0]);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    t.update();
    expect(t.flash()).not.toContain('TABLE SWITCHED');
    t.unmount();
  });
});

describe('the felt as the frame lays it', () => {
  it('shows a felt held back to go at once', () => {
    switchOn(a);
    at(a, T0);
    if (!a.furniture.FURNITURE.some((i) => i.id === TABLE)) {
      a.furniture.FURNITURE.push({ id: TABLE, kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    const wheel = fakeTable();
    const frame = (): void => a.session.casinoTablesFrame(1 / 60, new Map([[TABLE, wheel.h]]));
    const chipsDown = (): number => (wheel.chips() as { chips: number[] }[]).reduce((n, s) => n + s.chips.length, 0);
    frame();
    const t = atTable(a);
    t.bet('1');
    frame();
    expect(chipsDown()).toBe(1);
    at(a, T0 + 100);
    t.key('Enter'); // held back to go: no write, no doc event
    expect(mySlips(a)).toHaveLength(1);
    frame();
    expect(chipsDown()).toBe(2);
    t.unmount();
  });
});

describe('the wheel when the table is switched back', () => {
  it('spins for the owner-run round 1 that follows, though a round 1 spun before the switch', () => {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    if (!a.furniture.FURNITURE.some((i) => i.id === TABLE)) {
      a.furniture.FURNITURE.push({ id: TABLE, kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    const wheel = fakeTable();
    const frame = (): void => a.session.casinoTablesFrame(1 / 60, new Map([[TABLE, wheel.h]]));
    const settle = (result: number): void => {
      const s = a.casino.readTableState(TABLE)!;
      a.casino.writeTableState(TABLE, { ...s, phase: 'settled', result, resultAt: Date.now(), payouts: {} });
    };
    a.croupier.openBetting(TABLE, 1);
    frame();
    settle(7);
    frame();
    expect(wheel.spins).toEqual([[7, 7919 + 13]]);
    // To computed and back.
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    frame();
    at(a, T0 + 200);
    expect(a.table.switchComputedOff(TABLE, T0 + 200)).toBe('ok');
    a.croupier.openBetting(TABLE, 1);
    frame();
    settle(9);
    frame();
    expect(wheel.spins).toEqual([[7, 7919 + 13], [9, 7919 + 13]]);
    // Switched on and back while the page wasn't drawing the table: the
    // owner-run round showing as it looks again is not spun (as walking up).
    at(a, T0 + 400);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0 + 400)).toBe('ok');
    frame();
    at(a, T0 + 600);
    expect(a.table.switchComputedOff(TABLE, T0 + 600)).toBe('ok');
    a.croupier.openBetting(TABLE, 1);
    settle(11);
    frame();
    expect(wheel.spins).toHaveLength(2);
  });
});
