/**
 * 🧮🕰 A computed table on this page's clock (computedTable seen, the
 * phases' boundaries): the tableClockStep patterns for a table nobody runs.
 *
 * Every timer runs from when this page first saw something, on its own
 * clock, so pages whose clocks disagree still take their turns in order; a
 * wake or a clock gone back starts every wait again from then, so no page
 * forfeits a seed it might have heard while it slept. Pages are separate
 * loads of the casino modules synced by hand (computedPageKit), every clock
 * explicit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asClose, asForfeit, seedTable } from './computedFold';
import type { CloseRec, ForfeitRec } from './computedFold';
import {
  byRank, clockOf, frame, keysIn, loadPage, openRoom, PAGE_CTX as CTX, PAGE_TABLE as TABLE, putIn, run, send, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit, red, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import { ROOM_STATE_WAIT_MS, TABLE_LEASE_LAPSE_MS } from './croupier';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
const kit = new ComputedKit(CTX);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(recOf(p, k))!);
const forfeitsOf = (p: Page, r: number): ForfeitRec[] => keysIn(p, 'f', r).map((k) => asForfeit(recOf(p, k))!);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const phaseOf = (p: Page, now: number) => p.table.readComputedRoulette(TABLE, now);
const signer = (pages: Page[], k: string): string | undefined => pages.find((p) => p.pub === k)?.name;
const stampOf = (p: Page, key: string): number => p.casino.computedSeenAt(TABLE, key)!;

/** Page p's felt down at the spec's time T, on its clock. */
function bet(p: Page, T: number, amount = 10): void {
  const now = clockOf(p, T);
  expect(p.table.writeComputedSlip(TABLE, [red(amount)], now)).toBe('ok');
}

function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

describe('first seen, on this clock', () => {
  it('a wake forgets every first-seen time: the window runs BET_WINDOW_MS again from the wake', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    bet(b, T0);
    sync(T0, a, b);
    for (let T = T0; T <= T0 + 5_000; T += STEP) frame(T, a);
    expect(phaseOf(a, T0 + 5_000)!.phaseDeadline).toBe(T0 + 18_000);
    // A's computer sleeps 7 s: on its first frame back it has woken.
    frame(T0 + 12_000, a);
    expect(a.croupier.tablesWakeCount()).toBe(1);
    expect(phaseOf(a, T0 + 12_000)!.phaseDeadline).toBe(T0 + 30_000);
    // B never slept: its window stands.
    frame(T0 + 12_000, b);
    expect(phaseOf(b, T0 + 12_000)!.phaseDeadline).toBe(T0 + 18_000);
    // Once restamped, a time stays put.
    for (let T = T0 + 12_200; T <= T0 + 20_000; T += STEP) frame(T, a);
    expect(phaseOf(a, T0 + 20_000)!.phaseDeadline).toBe(T0 + 30_000);
  });

  it('a clock gone back by a second or more restamps every timer; by less, nothing moves', async () => {
    const [a] = await openRoom(['A'], T0);
    bet(a, T0);
    expect(phaseOf(a, T0 + 5_000)!.phaseDeadline).toBe(T0 + 18_000);
    // Back 999 ms (a time sync's step): the window stands.
    expect(phaseOf(a, T0 + 4_001)!.phaseDeadline).toBe(T0 + 18_000);
    // Back 1 s from the last look: every time goes, the window runs from now.
    expect(phaseOf(a, T0 + 3_001)!.phaseDeadline).toBe(T0 + 21_001);
    expect(a.croupier.tablesWakeCount()).toBe(0);
  });

  it('a show this page slept through runs again from the wake', async () => {
    const [a] = await openRoom(['A'], T0);
    bet(a, T0);
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const decidedAt = run([a], closedAt + STEP, closedAt + 5_000, { step: STEP, until: () => !!foldOf(a).rounds[0]?.decided });
    expect(phaseOf(a, decidedAt)).toMatchObject({ phase: 'settled', round: 1, resultAt: decidedAt });
    const wake = decidedAt + 20_000;
    frame(wake, a);
    expect(phaseOf(a, wake)).toMatchObject({ phase: 'settled', round: 1, resultAt: wake });
    expect(phaseOf(a, wake + a.table.SHOW_MS)).toMatchObject({ phase: 'betting', round: 2 });
  });

  it('a window armed again after running out empty restamps with the rest when the clock goes back', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    bet(b, T0);
    sync(T0, a, b);
    clockOf(b, T0 + 1_000);
    expect(b.table.writeComputedSlip(TABLE, [], T0 + 1_000)).toBe('ok');
    sync(T0 + 1_000, a, b);
    expect(phaseOf(a, T0 + 18_000)!.phaseDeadline).toBeUndefined();
    bet(b, T0 + 20_000, 12);
    sync(T0 + 20_000, a, b);
    expect(phaseOf(a, T0 + 20_000)!.phaseDeadline).toBe(T0 + 38_000);
    // A's clock goes back 3 s: every time reads as then, the window from then.
    expect(phaseOf(a, T0 + 17_000)!.phaseDeadline).toBe(T0 + 35_000);
  });

  it('a stamp later than the time asked about reads as that time, and stays', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    bet(b, T0);
    // B's slip reaches A while A's system clock reads T0 + 3 s, but A's
    // frame took its time at T0 + 1 s.
    send(T0 + 3_000, b, a);
    const [key] = keysIn(a, 's', 1);
    expect(stampOf(a, key)).toBe(T0 + 3_000);
    expect(phaseOf(a, T0 + 1_000)!.phaseDeadline).toBe(T0 + 19_000);
    // B changes its felt, heard at T0 + 2 s; read again at T0 + 3 s, the
    // first chip is still first seen at T0 + 1 s.
    bet(b, T0 + 2_000, 12);
    send(T0 + 2_000, b, a);
    expect(phaseOf(a, T0 + 3_000)!.phaseDeadline).toBe(T0 + 19_000);
  });
});

describe('a wake in the grace', () => {
  it('no forfeit from a grace that spanned a wake: it runs again from the wake, and a seed heard while asleep counts', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    for (const p of pages) pinOn(p, X);
    bet(a, T0);
    bet(b, T0, 11);
    const xs = kit.slip(X, 1, [red(3)]);
    putIn(a, [[xs.key, xs.rec]]);
    sync(T0, a, b);
    // Only A runs: it closes in its turn and reveals; B has the close but is away.
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    sync(closedAt, a, b);
    frame(closedAt + STEP, a);
    expect(foldOf(a).tip!.revealed).toEqual([a.pid]);
    const closeSeen = stampOf(a, keysIn(a, 'c', 1)[0]);
    // A sleeps. 8 s after the close B's seed goes out (B on a doc holding
    // part of an update: its reveal runs, nothing else), and A's doc hears it
    // (the doc syncs on; only A's frames stopped).
    const hash = foldOf(b).tip!.frozen[b.pid];
    const c = recOf<{ c: string }>(b, `s:1:${b.pid}:${hash}`).c;
    const seed = b.fair.seedFor(c, { room: CTX.room, table: seedTable(CTX), round: 1, party: b.pid, house: '' })!;
    vi.setSystemTime(closeSeen + 8_000);
    const x = kit.reveal(1, b.pid, seed);
    putIn(b, [[x.key, x.rec]]);
    send(closeSeen + 8_000, b, a);
    expect(foldOf(a).tip!.revealed).toEqual([a.pid, b.pid].sort());
    // A wakes 20 s after the close: it waits out a lapse, then forfeits X
    // with B's seed counted (seen, on this clock, at the wake: in the grace).
    const wake = closeSeen + 20_000;
    let wrote = -1;
    for (let T = wake; T <= wake + 30_000 && wrote < 0; T += STEP) {
      frame(T, a);
      if (keysIn(a, 'f', 1).length) wrote = T;
    }
    expect(a.croupier.tablesWakeCount()).toBe(1);
    expect(wrote).toBeGreaterThanOrEqual(wake + TABLE_LEASE_LAPSE_MS);
    const [f] = forfeitsOf(a, 1);
    expect(f.n).toEqual([a.pid, b.pid].sort());
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [a.pid, b.pid].sort() });
  });
});

describe('back after the round was decided', () => {
  /** A, B and C, C first in line for round 1's forfeit; all three bet, the
   *  round closes, and C leaves before its next frame (its seed never goes
   *  out); A and B decide it by forfeit, C's stake gone, then play rounds 2
   *  and 3 (no idle trim takes round 1 out of the session meanwhile). */
  async function cLeftAndForfeited() {
    let pages: Page[];
    do pages = await openRoom(['A', 'B', 'C'], T0);
    while (byRank(pages, 'forfeit', 1)[0] !== pages[2]);
    const [a, b, c] = pages;
    for (const [i, p] of pages.entries()) bet(p, T0, 10 + i);
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(c, 'c', 1)).toHaveLength(1);
    expect(keysIn(c, 'x', 1).filter((k) => k.includes(c.pid))).toEqual([]);
    const decidedAt = run([a, b], closedAt + STEP, closedAt + 20_000, { step: STEP, until: () => foldOf(a).rounds[0]?.decided === 'forfeit' });
    expect(foldOf(a).rounds[0].counted).toEqual([a.pid, b.pid].sort());
    const pocket = foldOf(a).rounds[0].pocket;
    let T = decidedAt + STEP;
    for (const r of [2, 3]) {
      const open = run([a, b], T, T + 60_000, { step: STEP, until: () => foldOf(a).open === r && phaseOf(a, Date.now())?.phase === 'betting' });
      for (const p of [a, b]) bet(p, open, 1);
      T = run([a, b], open + STEP, open + 60_000, { step: STEP, until: () => foldOf(a).rounds.some((v) => v.r === r && v.decided) }) + STEP;
    }
    expect(foldOf(a).base.u).toBe(0);
    return { pages, pocket, backAt: T };
  }

  /** Round 1 on page p as the honest forfeit decided it: A's and B's seeds, C's stake gone. */
  function stands(p: Page, pages: Page[], pocket: number | null): void {
    const [a, b, c] = pages;
    expect(foldOf(p).rounds[0].counted).toEqual([a.pid, b.pid].sort());
    expect(forfeitsOf(p, 1).map((f) => f.n)).toEqual([[a.pid, b.pid].sort()]);
    expect(foldOf(p).rounds[0].pocket).toBe(pocket);
    expect(p.casino.readChips(c.pid)).toBe(1_000 - 12);
  }

  it('a bettor who left mid-round and wakes minutes later reveals, but answers nothing: its seed came long after the grace', async () => {
    const { pages, pocket, backAt } = await cLeftAndForfeited();
    const [a, , c] = pages;
    run(pages, backAt, backAt + 30_000, { step: STEP });
    expect(c.croupier.tablesWakeCount()).toBe(1);
    expect(keysIn(a, 'x', 1).filter((k) => k.includes(c.pid))).toHaveLength(1);
    stands(a, pages, pocket);
    // Nor does its ⚙ card say a forfeit dropped a seed: it stamped them all at the wake.
    expect(c.table.computedRoundCheck(TABLE, backAt + 30_000)!.dropped).toEqual([]);
  });

  it('nor after a reload that kept its key and its seeds: it saw the close and the forfeit at once', async () => {
    const { pages, pocket, backAt } = await cLeftAndForfeited();
    const [a, b, c] = pages;
    const hash = foldOf(a).rounds[0].frozen[c.pid];
    const commit = recOf<{ c: string }>(a, `s:1:${c.pid}:${hash}`).c;
    const ctx = { room: CTX.room, table: seedTable(CTX), round: 1, party: c.pid, house: '' };
    const seed = c.fair.seedFor(commit, ctx)!;
    expect(seed).not.toBeNull();
    const again = await loadPage('C', 3, { reloadOf: c });
    again.fair.keepSeed(commit, seed);
    const room = [a, b, again];
    run(room, backAt, backAt + 30_000, { step: STEP });
    expect(keysIn(a, 'x', 1).filter((k) => k.includes(c.pid))).toHaveLength(1);
    stands(a, pages, pocket);
    expect(again.table.computedRoundCheck(TABLE, backAt + 30_000)!.dropped).toEqual([]);
  });

  it('a void stays void when a bettor who left wakes two minutes on: its seed stays back, and no forfeit counts one', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    for (const p of [a, b]) bet(p, T0);
    // C only watches, seated: it may abandon.
    c.casino.writeMySeat(TABLE, c.pid, { stand: 2, angle: 1, at: 1 });
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    // A and B leave before their next frame; C voids the round at 30 s, and keeps the table a minute more.
    const voidAt = run([c], closedAt + STEP, closedAt + 60_000, { step: STEP, until: () => foldOf(c).rounds[0]?.decided === 'void' });
    expect(voidAt).toBeGreaterThanOrEqual(closedAt + 30_000);
    run([c], voidAt + STEP, voidAt + 60_000, { step: STEP });
    expect(foldOf(c).base.u).toBe(0);
    const back = voidAt + 60_000 + STEP;
    run([a, c], back, back + 30_000, { step: STEP });
    expect(a.croupier.tablesWakeCount()).toBe(1);
    // A watched the close, but slept since: back, it can't tell whether its
    // seed is the one that would make the set whole and undo the void (B's
    // may be on its way), so the void holds it back (computedTable
    // voidHolds), and nothing is left for a forfeit to count.
    expect(keysIn(c, 'x', 1).filter((k) => k.includes(a.pid))).toEqual([]);
    expect(foldOf(c).rounds[0].decided).toBe('void');
    expect(keysIn(c, 'f', 1)).toEqual([]);
    expect(c.casino.readChips(b.pid)).toBe(1_000);
  });

  /** A and B and test player X (frozen; its seed comes 15 s after the close),
   *  both pages' seeds out at once; the page ranked first for the forfeit
   *  stops after seeing the close (its doc syncs on), the other forfeits X at
   *  its turn, and X's seed lands 15 s after the close. */
  async function decidedWhileAway() {
    const X = testIdentity('x', 'player-X');
    const pages = await openRoom(['A', 'B'], T0);
    for (const p of pages) pinOn(p, X);
    for (const [i, p] of pages.entries()) bet(p, T0, 10 + i);
    const xs = kit.slip(X, 1, [red(7)]);
    putIn(pages[0], [[xs.key, xs.rec]]);
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => pages.every((p) => keysIn(p, 'c', 1).length > 0) });
    const [better, worse] = byRank(pages, 'forfeit', 1);
    run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
    expect(foldOf(better).tip!.revealed).toEqual([better.pid, worse.pid].sort());
    const closeSeen = stampOf(better, keysIn(better, 'c', 1)[0]);
    for (let T = closedAt + 2 * STEP; T <= closeSeen + 12_000; T += STEP) {
      sync(T, better, worse);
      frame(T, worse);
      sync(T, better, worse);
    }
    const [f] = forfeitsOf(worse, 1);
    expect(f).toMatchObject({ k: worse.pub, n: [better.pid, worse.pid].sort() });
    const pocket = foldOf(worse).rounds[0].pocket;
    vi.setSystemTime(closeSeen + 15_000);
    const x = kit.reveal(1, X.pid);
    putIn(worse, [[x.key, x.rec]]);
    return { better, worse, closeSeen, pocket };
  }

  it('a page that saw the close and slept through the grace and the forfeit answers nothing with a seed that came 15 s late', async () => {
    const { better, worse, closeSeen, pocket } = await decidedWhileAway();
    sync(closeSeen + 15_000, better, worse);
    for (let T = closeSeen + 30_000; T <= closeSeen + 60_000; T += STEP) {
      sync(T, better, worse);
      frame(T, better);
      frame(T, worse);
      sync(T, better, worse);
    }
    expect(better.croupier.tablesWakeCount()).toBe(1);
    expect({ counted: foldOf(worse).rounds[0].counted, pocket: foldOf(worse).rounds[0].pocket })
      .toEqual({ counted: [better.pid, worse.pid].sort(), pocket });
    expect(forfeitsOf(better, 1).filter((r) => r.k === better.pub)).toEqual([]);
  });

  it('nor one reloaded after the round was decided', async () => {
    const { better, worse, closeSeen, pocket } = await decidedWhileAway();
    vi.setSystemTime(closeSeen + 30_000);
    const again = await loadPage(better.name, 9, { reloadOf: better });
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(worse.doc));
    for (let T = closeSeen + 30_000; T <= closeSeen + 60_000; T += STEP) {
      sync(T, again, worse);
      frame(T, again);
      frame(T, worse);
      sync(T, again, worse);
    }
    expect({ counted: foldOf(worse).rounds[0].counted, pocket: foldOf(worse).rounds[0].pocket })
      .toEqual({ counted: [better.pid, worse.pid].sort(), pocket });
    expect(forfeitsOf(again, 1).filter((r) => r.k === again.pub)).toEqual([]);
    expect(again.table.computedRoundCheck(TABLE, closeSeen + 60_000)!.dropped).toEqual([]);
  });
});

describe("before the room's state is in", () => {
  it('runs no duty, its reveal included, until the room state is in or the wait for it is over', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    bet(a, T0);
    bet(b, T0, 11);
    sync(T0, a, b);
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    sync(closedAt, a, b);
    // B reloads on its cached doc (its key and seed store kept, as its
    // localStorage keeps them), and the room's state hasn't come in.
    const hash = foldOf(b).tip!.frozen[b.pid];
    const c = recOf<{ c: string }>(b, `s:1:${b.pid}:${hash}`).c;
    const seed = b.fair.seedFor(c, { room: CTX.room, table: seedTable(CTX), round: 1, party: b.pid, house: '' })!;
    vi.setSystemTime(closedAt);
    const again = await loadPage('B', 9, { reloadOf: b });
    again.croupier.setRoomStateArrivedCheck(() => false);
    expect(again.croupier.roomStateIn(closedAt)).toBe(false);
    again.fair.keepSeed(c, seed);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(b.doc));
    for (let T = closedAt; T < closedAt + ROOM_STATE_WAIT_MS; T += STEP) frame(T, again);
    expect(keysIn(again, 'x', 1)).toEqual([]);
    expect(keysIn(again, 'f', 1)).toEqual([]);
    expect(keysIn(again, 'z', 1)).toEqual([]);
    frame(closedAt + ROOM_STATE_WAIT_MS, again);
    expect(keysIn(again, 'x', 1)).toHaveLength(1);
    expect(foldOf(again).rounds[0].revealed).toEqual([again.pid]);
  });

  it('nor closes a window that ran out', async () => {
    const [a] = await openRoom(['A'], T0);
    bet(a, T0);
    expect(a.croupier.roomStateIn(T0)).toBe(true);
    a.croupier.setRoomStateArrivedCheck(() => false);
    const at = run([a], T0 + STEP, T0 + 40_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    // Its first look was at T0: the wait for the room's state ran out 30 s on.
    expect(at).toBe(T0 + ROOM_STATE_WAIT_MS);
  });
});

describe('clocks that disagree', () => {
  it('still close in rank order with the pages 5 s apart, each timing from what it saw', async () => {
    for (const away of [0, 1, 2]) {
      const pages = await openRoom(['A', 'B', 'C'], T0, [-5_000, 0, 5_000]);
      for (const p of pages) bet(p, T0);
      sync(T0, ...pages);
      const order = byRank(pages, 'close', 1);
      const live = order.slice(away);
      const at = run(live, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(live[0], 'c', 1).length > 0 });
      // (Frames every 200 ms: the first at or after the turn.)
      expect(at).toBeGreaterThanOrEqual(T0 + 18_000 + away * 1_500);
      expect(at).toBeLessThan(T0 + 18_000 + away * 1_500 + STEP);
      run(live, at + STEP, at + 6_000, { step: STEP });
      expect(closesOf(live[live.length - 1], 1).map((c) => signer(pages, c.k))).toEqual([live[0].name]);
    }
  });
});

describe('telling the felt', () => {
  /** Every notify of `computed:<TABLE>` page p's listeners hear, as the
   *  phase and round they read then (on p's clock: the system time). */
  function listen(p: Page): string[] {
    const heard: string[] = [];
    p.casino.subscribeCasinoKey(`computed:${TABLE}`, () => {
      const v = phaseOf(p, Date.now())!;
      heard.push(`${v.phase}:${v.round}`);
    });
    return heard;
  }

  it('once per phase change: the fold’s changes as casinoDoc tells them, the clock’s from the tick', async () => {
    const [a] = await openRoom(['A'], T0);
    const heard = listen(a);
    bet(a, T0);
    expect(heard).toEqual(['betting:1']);
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(heard).toEqual(['betting:1', 'closing:1']);
    run([a], closedAt + STEP, closedAt + STEP, { step: STEP });
    expect(heard).toEqual(['betting:1', 'closing:1', 'settled:1']);
    const shown = a.table.readComputedRoulette(TABLE, closedAt + STEP)!.resultAt;
    run([a], closedAt + 2 * STEP, shown + a.table.SHOW_MS + 20_000, { step: STEP });
    expect(heard).toEqual(['betting:1', 'closing:1', 'settled:1', 'betting:2']);
  });

  it('a forfeit’s hold ends on the clock, and the show too, each told once; a fold change just before still leaves the boundary told', async () => {
    const X = testIdentity('x', 'player-X'); // reveals late
    const W = testIdentity('w', 'player-W'); // reveals, and forfeits X 3.9 s after the close
    const [a] = await openRoom(['A'], T0);
    pinOn(a, X, W);
    const heard = listen(a);
    bet(a, T0);
    const xs = kit.slip(X, 1, [red(3)]);
    const ws = kit.slip(W, 1, [red(4)]);
    putIn(a, [[xs.key, xs.rec], [ws.key, ws.rec]]);
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const closeSeen = stampOf(a, keysIn(a, 'c', 1)[0]);
    expect(closeSeen).toBe(closedAt);
    let T = closedAt + STEP;
    frame(T, a); // A's seed
    vi.setSystemTime(closeSeen + 1_000);
    const wx = kit.reveal(1, W.pid);
    putIn(a, [[wx.key, wx.rec]]);
    for (T += STEP; T < closeSeen + 3_900; T += STEP) frame(T, a);
    vi.setSystemTime(closeSeen + 3_900);
    const f = kit.forfeit(W, 1, foldOf(a).tip!.close, [a.pid, W.pid]);
    putIn(a, [[f.key, f.rec]]);
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit' });
    expect(heard).toEqual(['betting:1', 'betting:1', 'closing:1', 'closing:1', 'closing:1', 'closing:1']);
    // Held until a second after the grace on A's clock (4 s: no seed stretched it).
    const show = closeSeen + a.table.REVEAL_GRACE_MS + 1_000;
    for (; T < show; T += STEP) frame(T, a);
    expect(heard.at(-1)).toBe('closing:1');
    frame(T, a);
    expect(T).toBe(show);
    expect(heard.slice(6)).toEqual(['settled:1']);
    expect(a.table.readComputedRoulette(TABLE, T)!.resultAt).toBe(show);
    // X's seed lands 100 ms before the show ends: the fold moves (told), and
    // the boundary is told after it all the same.
    const end = show + a.table.SHOW_MS;
    for (T += STEP; T < end - 100; T += STEP) frame(T, a);
    vi.setSystemTime(end - 100);
    const before = heard.length;
    const x = kit.reveal(1, X.pid);
    putIn(a, [[x.key, x.rec]]);
    for (; T <= end + 2_000; T += STEP) frame(T, a);
    expect(heard.slice(before)).toEqual(['settled:1', 'betting:2']);
  });
});
