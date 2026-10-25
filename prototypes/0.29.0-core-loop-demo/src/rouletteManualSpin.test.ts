/**
 * The house's manual SPIN (casinoTableSession spinByHand):
 *  ⏱ when the clock goes back mid-poll, the poll's times go back with it, so
 *    the round settles once the page is awake again, not when the clock
 *    comes round;
 *  📒 on a doc holding part of an update (casinoWhole), where a bet list
 *    rewritten in the part still to come reads as gone, it closes nothing
 *    until the rest comes, so the round takes that list.
 *
 * The UI needs a DOM: this file stubs just enough of one (createElement,
 * listeners, querySelector) to mount the focused table and press its card's
 * SPIN button.
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
  bindCasinoDoc, buyInChips, casinoWhole, readChips, readMyBets, readTableState, writeCrapsFairnessPref, writeMyBets,
} = await import('./casinoDoc');
const { noteTablesRunning, openBetting, setSoleCroupierPredicate, TABLE_LEASE_LAPSE_MS } = await import('./croupier');
const { createCasinoTableUI } = await import('./casinoTableSession');

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
});
