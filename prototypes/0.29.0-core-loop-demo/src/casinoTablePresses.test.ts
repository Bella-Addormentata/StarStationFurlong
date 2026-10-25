/**
 * Presses at the table (casinoTableSession). The house's manual SPIN
 * (spinByHand):
 *  ⏱ its poll counts only the time the page could settle in: after the
 *    clock goes back, or the page was suspended just after the press, the
 *    round settles once the page is awake again, not when the clock comes
 *    round, and not only on a second press;
 *  📒 on a doc holding part of an update (casinoWhole), where a bet list
 *    rewritten in the part still to come reads as gone, it closes nothing
 *    until the rest comes, so the round takes that list; pressed before
 *    such a wait (the round's own state in the part still to come too), it
 *    settles once the rest comes.
 * And a bettor's ↶ take-down on such a doc: refused, and said so, not told
 * TAKEN DOWN with the bets still riding.
 *
 * The UI needs a DOM: this file stubs just enough of one (createElement,
 * listeners, querySelector) to mount the focused table, press its keys and
 * its card's SPIN button.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

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

const {
  bindCasinoDoc, buyInChips, casinoWhole, readChips, readMyBets, readMyCrapsBets, readTableState,
  writeCrapsFairnessPref, writeMyBets, writeMyCrapsBets,
} = await import('./casinoDoc');
const {
  noteTablesRunning, openBetting, RECONNECTING_NOTICE, setSoleCroupierPredicate, TABLE_LEASE_LAPSE_MS,
} = await import('./croupier');
const { openCrapsBetting } = await import('./crapsCroupier');
const { tickFairSeeds } = await import('./fairTableSeeds');
const { createCasinoTableUI } = await import('./casinoTableSession');
const { getPlayerId } = await import('./identity');

const T0 = 2_000_000_000;
const HOUR = 3_600_000;
const BOB = 'player-Bob';
const red = [{ type: 'red' as const, amount: 10 }];
let n = 0;
const freshTable = (): string => `roulette-clock-${++n}`;
let doc: Y.Doc;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
  doc = new Y.Doc();
  bindCasinoDoc(doc);
  setSoleCroupierPredicate(() => false); // a manual (venture) room: no robot
  buyInChips(BOB, 100);
});

afterEach(() => {
  setSoleCroupierPredicate(() => true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mount the focused roulette table as a house member and open its card;
 *  returns a SPIN press. */
function houseAtTable(t: string): { spin: () => void; unmount: () => void } {
  const ui = createCasinoTableUI({ itemId: t, game: 'roulette', isHouse: () => true, stand: null, visual: null });
  const host = new FakeEl();
  ui.mount(host as unknown as HTMLElement);
  const capture = host.children[0];
  capture.fire('keydown', { key: 's', preventDefault() {}, stopPropagation() {} }); // ⚙️ the card
  const card = host.children.find((c) => c !== capture && c.listeners.has('click'))!;
  expect(card).toBeTruthy();
  const button = { dataset: { act: 'spin' } };
  return {
    spin: () => card.fire('click', { target: { closest: () => button }, preventDefault() {}, stopPropagation() {} }),
    unmount: () => ui.unmount(),
  };
}

/** World's frames for `ms` (the tables marked running every 100 ms), and the
 *  timers (the SPIN poll) running alongside. */
async function run(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 100) {
    await vi.advanceTimersByTimeAsync(100);
    noteTablesRunning(Date.now());
  }
}

describe("the house's manual SPIN", () => {
  for (const [what, back] of [['a steady clock (control)', 0], ['a clock that goes back an hour just after the press', HOUR]] as const) {
    it(`(${what}) settles the round within a lapse or two`, async () => {
      const t = freshTable();
      writeCrapsFairnessPref(t, 'rng');
      openBetting(t, 1);
      writeMyBets(t, BOB, 1, red);
      noteTablesRunning(Date.now());
      const house = houseAtTable(t);
      house.spin();
      expect(readTableState(t)?.phase).toBe('closing');
      await run(200);
      vi.setSystemTime(Date.now() - back); // the clock goes back
      await run(3 * TABLE_LEASE_LAPSE_MS);
      const afterPoll = readTableState(t)?.phase;
      house.spin(); // pressing again
      await run(3 * TABLE_LEASE_LAPSE_MS);
      const afterPress = readTableState(t)?.phase;
      house.unmount();
      // Settled a lapse (the wake's hold) after the step at most.
      expect({ afterPoll, afterPress }).toEqual({ afterPoll: 'settled', afterPress: 'settled' });
    });
  }
});

describe("the house's manual SPIN on a page suspended just after the press (frames and timers stopped, the clock steady)", () => {
  for (const [what, away] of [['for 6.5 s', 6_500], ['for 30 s', 30_000]] as const) {
    it(`(${what}) settles the round once awake, without a second press`, async () => {
      const t = freshTable();
      writeCrapsFairnessPref(t, 'rng');
      openBetting(t, 1);
      writeMyBets(t, BOB, 1, red);
      noteTablesRunning(Date.now());
      const house = houseAtTable(t);
      house.spin();
      await run(300); // before the settle's wait for a rival's lease ends
      expect(readTableState(t)?.phase).toBe('closing');
      vi.setSystemTime(Date.now() + away); // nothing ran meanwhile
      await run(3 * TABLE_LEASE_LAPSE_MS);
      const phase = readTableState(t)?.phase;
      house.unmount();
      expect(phase).toBe('settled');
    });
  }
});

describe("the house's manual SPIN on a Fair table whose bettor never reveals", () => {
  /** Frames every 50 ms, real hashing (about a millisecond) landing inside
   *  the frame it starts in, as in a browser. */
  async function runReal(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 50) {
      await vi.advanceTimersByTimeAsync(50);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      noteTablesRunning(Date.now());
    }
  }

  for (const [what, back] of [['a steady clock (control)', 0], ['a clock that goes back an hour 4.2 s after the press', HOUR]] as const) {
    it(`(${what}) settles the round without a second press`, async () => {
      const t = freshTable();
      writeCrapsFairnessPref(t, 'multiparty');
      openBetting(t, 1);
      const me = getPlayerId();
      buyInChips(me, 100);
      writeMyBets(t, me, 1, red);
      tickFairSeeds(t, 'roulette', me, Date.now(), true); // commits; never reveals
      noteTablesRunning(Date.now());
      const house = houseAtTable(t);
      house.spin();
      expect(Object.keys(readTableState(t)?.commits ?? {})).toEqual([me]);
      await runReal(4_200);
      expect(readTableState(t)?.phase).toBe('closing');
      vi.setSystemTime(Date.now() - back);
      for (let i = 0; i < 240 && readTableState(t)?.phase !== 'settled'; i++) await runReal(100);
      const phase = readTableState(t)?.phase;
      house.unmount();
      expect(phase).toBe('settled');
    });
  }
});

describe("the house's manual SPIN on a Fair table whose bettor never reveals, the clock stepping back about a second", () => {
  /** Frames every 20 ms, the hash resolved at once (a browser's takes about
   *  a millisecond), so the step lands where it is meant to. A step of just
   *  over a second is a wake to the frames but under a second to the poll,
   *  which samples the clock less often. */
  async function frames(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 20) {
      await vi.advanceTimersByTimeAsync(20);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      noteTablesRunning(Date.now());
    }
  }
  for (const back of [0, 300, 990, 1_060, 1_120, 1_300]) {
    it(`(a step back of ${back} ms, 4.3 s after the press) settles the round without a second press`, async () => {
      const { sha256 } = await import('@noble/hashes/sha256');
      vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
        async (_alg: unknown, data: unknown) => sha256(new Uint8Array(data as ArrayBuffer)).buffer as ArrayBuffer);
      const t = freshTable();
      writeCrapsFairnessPref(t, 'multiparty');
      openBetting(t, 1);
      const me = getPlayerId();
      buyInChips(me, 100);
      writeMyBets(t, me, 1, red);
      tickFairSeeds(t, 'roulette', me, Date.now(), true); // commits; never reveals
      noteTablesRunning(Date.now());
      const house = houseAtTable(t);
      house.spin();
      await frames(4_300);
      expect(readTableState(t)?.phase).toBe('closing');
      vi.setSystemTime(Date.now() - back);
      await frames(20_000);
      const phase = readTableState(t)?.phase;
      house.unmount();
      expect(phase).toBe('settled');
    });
  }
});

describe("the house's manual SPIN on a doc holding part of an update", () => {
  it('closes nothing until the rest comes, then plays the list rewritten in it', async () => {
    const t = freshTable();
    writeCrapsFairnessPref(t, 'rng');
    openBetting(t, 1);
    writeMyBets(t, BOB, 1, red);
    noteTablesRunning(Date.now());
    // Bob's other page rewrites his list just after a write this page has
    // yet to get. The rewrite comes first: its list waits for that write,
    // but the old list's delete applies at once, so his bet reads as gone.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const updates: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => updates.push(u));
    const key = `bets:${t}:${BOB}`;
    const list = other.getMap('casino').get(key) as object;
    other.getMap('elsewhere').set('note', 1);
    other.getMap('casino').set(key, { ...list });
    Y.applyUpdate(doc, updates[1]);
    expect(casinoWhole(t)).toBe(false);
    expect(readMyBets(t, BOB, 1)).toEqual([]);
    const house = houseAtTable(t);
    house.spin();
    await run(3 * TABLE_LEASE_LAPSE_MS);
    expect(readTableState(t)?.phase).toBe('betting');
    Y.applyUpdate(doc, updates[0]);
    expect(readMyBets(t, BOB, 1)).toEqual(red);
    house.spin();
    expect(readTableState(t)).toMatchObject({ phase: 'closing', bettors: [BOB] });
    await run(3 * TABLE_LEASE_LAPSE_MS);
    house.unmount();
    expect(readTableState(t)?.phase).toBe('settled');
    expect(readChips(BOB)).not.toBe(100); // played, not handed back
  });

  it('pressed on a whole doc that then waits longer than the poll for the rest, settles once it comes, without a second press', async () => {
    const t = freshTable();
    writeCrapsFairnessPref(t, 'rng');
    openBetting(t, 1);
    writeMyBets(t, BOB, 1, red);
    noteTablesRunning(Date.now());
    const house = houseAtTable(t);
    house.spin();
    await run(300);
    const rest = partOfAnUpdate();
    await run(15_000);
    expect(readTableState(t)?.phase).toBe('closing');
    Y.applyUpdate(doc, rest);
    await run(2_000);
    const phase = readTableState(t)?.phase;
    house.unmount();
    expect(phase).toBe('settled');
  });

  it("whose closing state is rewritten in the part still to come, polls on and settles once it comes, without a second press", async () => {
    const t = freshTable();
    writeCrapsFairnessPref(t, 'rng');
    openBetting(t, 1);
    writeMyBets(t, BOB, 1, red);
    noteTablesRunning(Date.now());
    const house = houseAtTable(t);
    house.spin();
    await run(300);
    expect(readTableState(t)?.phase).toBe('closing');
    const rest = tableStateParked(t);
    expect(readTableState(t)?.phase).not.toBe('closing');
    await run(2_000);
    Y.applyUpdate(doc, rest);
    expect(readTableState(t)?.phase).toBe('closing');
    await run(2_000);
    const phase = readTableState(t)?.phase;
    house.unmount();
    expect(phase).toBe('settled');
  });
});

/** Another page's two writes elsewhere, the second given to `doc` first:
 *  the doc holds part of an update. Returns the rest. */
function partOfAnUpdate(): Uint8Array {
  const other = new Y.Doc();
  const updates: Uint8Array[] = [];
  other.on('update', (u: Uint8Array) => updates.push(u));
  other.getMap('elsewhere').set('a', 1);
  other.getMap('elsewhere').set('b', 2);
  Y.applyUpdate(doc, updates[1]);
  return updates[0];
}

describe('a take-down on a doc holding part of an update', () => {
  for (const game of ['roulette', 'craps'] as const) {
    it(`${game}: says the table is reconnecting, and the bets stay until a press once the rest has come`, () => {
      const t = `${game}-takedown-partial`;
      const me = getPlayerId();
      buyInChips(me, 100);
      writeCrapsFairnessPref(t, 'rng');
      if (game === 'roulette') {
        openBetting(t, 1);
        writeMyBets(t, me, 1, red);
      } else {
        openCrapsBetting(t, 1, null);
        writeMyCrapsBets(t, me, [{ type: 'field', amount: 10 }]);
      }
      const mine = (): unknown[] => (game === 'roulette' ? readMyBets(t, me, 1) : readMyCrapsBets(t, me));
      const rest = partOfAnUpdate();
      expect(casinoWhole(t)).toBe(false);
      const ui = createCasinoTableUI({ itemId: t, game, isHouse: () => false, stand: null, visual: null });
      const host = new FakeEl();
      ui.mount(host as unknown as HTMLElement);
      const takeDown = (): string => {
        host.children[0].fire('keydown', { key: 'c', preventDefault() {}, stopPropagation() {} });
        return host.children[1].querySelector('[data-live]').textContent;
      };
      expect(takeDown()).toContain(RECONNECTING_NOTICE);
      expect(mine()).toHaveLength(1);
      expect(readChips(me)).toBe(90);
      Y.applyUpdate(doc, rest);
      expect(takeDown()).toMatch(/^TAKEN DOWN/);
      ui.unmount();
      expect(mine()).toEqual([]);
      expect(readChips(me)).toBe(100);
    });
  }
});

/** Another page rewrites the table's state just after a write this page has
 *  yet to get, and this page gets the rewrite first: the state's old value
 *  is deleted at once and the new one parked, so the table reads as gone.
 *  Returns the rest. */
function tableStateParked(t: string): Uint8Array {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const updates: Uint8Array[] = [];
  other.on('update', (u: Uint8Array) => updates.push(u));
  other.getMap('elsewhere').set('note', 1);
  const s = other.getMap('casino').get(`table:${t}`) as object;
  other.getMap('casino').set(`table:${t}`, { ...s, phaseDeadline: Date.now() + 10_000 });
  Y.applyUpdate(doc, updates[1]);
  return updates[0];
}

describe("presses while the table's own state is in the part of an update still to come", () => {
  for (const game of ['roulette', 'craps'] as const) {
    it(`${game}: a take-down says RECONNECTING, not that you have no bets, and the bets stay`, () => {
      const t = `${game}-parked-state`;
      const me = getPlayerId();
      buyInChips(me, 100);
      writeCrapsFairnessPref(t, 'rng');
      if (game === 'roulette') {
        openBetting(t, 1);
        writeMyBets(t, me, 1, red);
      } else {
        openCrapsBetting(t, 1, null);
        writeMyCrapsBets(t, me, [{ type: 'field', amount: 10 }]);
      }
      const rest = tableStateParked(t);
      expect(casinoWhole(t)).toBe(false);
      const ui = createCasinoTableUI({ itemId: t, game, isHouse: () => false, stand: null, visual: null });
      const host = new FakeEl();
      ui.mount(host as unknown as HTMLElement);
      host.children[0].fire('keydown', { key: 'c', preventDefault() {}, stopPropagation() {} });
      const said = host.children[1].querySelector('[data-live]').textContent;
      ui.unmount();
      Y.applyUpdate(doc, rest);
      expect(said).toContain(RECONNECTING_NOTICE);
      expect(game === 'roulette' ? readMyBets(t, me, 1) : readMyCrapsBets(t, me)).toHaveLength(1);
    });
  }

  it("the house's NEXT on a settled table says RECONNECTING", async () => {
    const t = 'roulette-parked-next';
    writeCrapsFairnessPref(t, 'rng');
    openBetting(t, 1);
    writeMyBets(t, BOB, 1, red);
    noteTablesRunning(Date.now());
    const ui = createCasinoTableUI({ itemId: t, game: 'roulette', isHouse: () => true, stand: null, visual: null });
    const host = new FakeEl();
    ui.mount(host as unknown as HTMLElement);
    const capture = host.children[0];
    capture.fire('keydown', { key: 's', preventDefault() {}, stopPropagation() {} });
    const card = host.children.find((c) => c !== capture && c.listeners.has('click'))!;
    const press = (act: string): void => card.fire('click', {
      target: { closest: () => ({ dataset: { act } }) }, preventDefault() {}, stopPropagation() {},
    });
    press('spin');
    for (let i = 0; i < 30 && readTableState(t)?.phase !== 'settled'; i++) await run(100);
    expect(readTableState(t)?.phase).toBe('settled');
    const rest = tableStateParked(t);
    expect(casinoWhole(t)).toBe(false);
    press('next');
    const said = host.children[1].querySelector('[data-live]').textContent;
    ui.unmount();
    Y.applyUpdate(doc, rest);
    expect(said).toContain(RECONNECTING_NOTICE);
  });
});
