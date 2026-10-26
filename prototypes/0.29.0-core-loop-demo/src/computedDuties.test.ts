/**
 * 🧮🧹 A computed table's duties (computedTable tickComputedTables,
 * writeComputedSlip): pages with nobody in charge moving a round along.
 *
 * Each page is its own load of the casino modules with its own Y.Doc,
 * player id and identity key (computedPageKit), synced by hand, every clock
 * explicit. Who acts first is whoever dutyRank puts first for that page's
 * key — keys are fresh each run — so each spec works out the order from the
 * keys and asserts against it. Players the specs need more of than pages
 * (a full table, a seed that comes at a chosen moment) are test identities
 * (computedTestKit) whose records a spec writes by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asClose, asForfeit, asSlip, seedTable, slipCommit } from './computedFold';
import type { CloseRec, ForfeitRec, SlipRec } from './computedFold';
import {
  byRank, clockOf, deleteIn, deliver, frame, keysIn, loadPage, openRoom, PAGE_CTX as CTX, PAGE_TABLE as TABLE, putIn, run, signAs,
  sync, trimByHand, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, straight, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
/** One frame per tick: every frame runs every page's duties. */
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

/** Pages for `names`, 1,000 chips each, the table switched on, all synced. */
const room = (names: string[]): Promise<Page[]> => openRoom(names, T0);

const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(recOf(p, k))!);
const forfeitsOf = (p: Page, r: number): ForfeitRec[] => keysIn(p, 'f', r).map((k) => asForfeit(recOf(p, k))!);
const slipsOf = (p: Page, r: number, pid: string): SlipRec[] =>
  keysIn(p, 's', r).filter((k) => k.startsWith(`s:${r}:${pid}:`)).map((k) => asSlip(recOf(p, k))!);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const phaseOf = (p: Page, now?: number) => p.table.readComputedRoulette(TABLE, now);
const signer = (pages: Page[], k: string): string | undefined => pages.find((p) => p.pub === k)?.name;
/** A made-up record hash: whatever a spec puts under it is junk (no record hashes to it). */
const fakeHash = (n: number): string => n.toString(16).padStart(32, '0');
/** A signature in shape that nobody signed. */
const SIG = 'A'.repeat(86);

/** A duty due at `due` ran on the first tick at or after it. */
function expectAt(at: number, due: number): void {
  expect(at).toBeGreaterThanOrEqual(due);
  expect(at).toBeLessThan(due + STEP);
}

/** Test identities as players of the room: each pinned on page p. */
function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

describe('a round, start to finish', () => {
  it('on three pages: slips, the close by the rank-first page at 18 s, every seed, the result, the next round after the show', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    expect(c.table.writeComputedSlip(TABLE, [straight(7, 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    for (const p of pages) {
      expect(phaseOf(p, T0)).toMatchObject({ phase: 'betting', round: 1, phaseDeadline: T0 + a.table.BET_WINDOW_MS });
      expect(p.casino.readChips(p.pid)).toBe(1_000 - [10, 20, 5][pages.indexOf(p)]);
    }
    // The seed behind a slip opens under the context slipCommit binds.
    const mine = foldOf(a).felts.get(a.pid)!.rec;
    const seed = a.fair.seedFor(mine.c, { room: CTX.room, table: seedTable(CTX), round: 1, party: a.pid, house: '' });
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(slipCommit(CTX, 1, a.pid, seed!)).toBe(mine.c);

    const closer = byRank(pages, 'close', 1)[0];
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closedAt).toBe(T0 + a.table.BET_WINDOW_MS);
    const [close] = closesOf(a, 1);
    expect(signer(pages, close.k)).toBe(closer.name);
    expect(Object.keys(close.f).sort()).toEqual([a.pid, b.pid, c.pid].sort());
    for (const p of pages) expect(phaseOf(p)).toMatchObject({ phase: 'closing', round: 1 });

    const decidedAt = run(pages, closedAt + STEP, closedAt + 10_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).rounds[0]?.decided === 'reveals'),
    });
    expect(decidedAt).toBe(closedAt + STEP); // every page revealed on its next tick
    const D = foldOf(a).rounds[0];
    for (const p of pages) {
      expect(keysIn(p, 'x', 1)).toHaveLength(3);
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(D.deltas.get(q.pid)));
      const view = phaseOf(p, decidedAt)!;
      expect(view).toMatchObject({ phase: 'settled', round: 1, result: D.pocket, resultAt: decidedAt, spinKey: `1:${D.pocket}` });
      expect(view.phaseDeadline).toBeUndefined();
    }

    const openedAt = run(pages, decidedAt + STEP, decidedAt + 20_000, {
      step: STEP, until: () => pages.every((p) => phaseOf(p)?.phase === 'betting'),
    });
    expect(openedAt).toBe(decidedAt + a.table.SHOW_MS);
    for (const p of pages) expect(phaseOf(p)).toMatchObject({ phase: 'betting', round: 2 });
    // Nobody wrote a rival close, a forfeit or an abandon.
    expect(keysIn(a, 'c')).toHaveLength(1);
    expect(keysIn(a, 'f')).toHaveLength(0);
    expect(keysIn(a, 'z')).toHaveLength(0);
  });

  it('a page never checks a record it signed itself (marked first): with no time to check, its own felt still counts', async () => {
    const [a, b] = await room(['A', 'B']);
    const seen: string[] = [];
    // A check that remembers whose records it was asked about.
    a.casino.setComputedVerifyForTests({ verify: (pub) => { seen.push(pub); return true; }, now: () => 0 });
    b.table.writeComputedSlip(TABLE, [black(20)], T0);
    sync(T0, a, b);
    expect(seen).toEqual([b.pub]);
    // And with no time left for checks at all, its own slip is not pending.
    a.casino.setComputedVerifyForTests({ verify: (pub) => { seen.push(pub); return true; }, budgetMs: 0 });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(a.casino.computedSettled(TABLE)).toBe(true);
    expect(a.casino.readChips(a.pid)).toBe(990);
    expect(seen).toEqual([b.pub]);
    run([a, b], T0 + STEP, T0 + 19_000, { step: STEP });
    expect(seen.filter((k) => k === a.pub)).toEqual([]);
  });
});

describe('the close', () => {
  /** Pages A, B, C each with chips on round 1, the window armed at T0. */
  async function bets(): Promise<Page[]> {
    const pages = await room(['A', 'B', 'C']);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    return pages;
  }

  it('takes turns by dutyRank: with the first page gone the second closes 1.5 s late, with both gone the third 3 s late', async () => {
    for (const away of [1, 2]) {
      const pages = await bets();
      const order = byRank(pages, 'close', 1);
      const live = order.slice(away);
      const at = run(live, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(live[0], 'c', 1).length > 0 });
      expectAt(at, T0 + 18_000 + away * 1_500);
      expect(closesOf(live[0], 1).map((c) => signer(pages, c.k))).toEqual([live[0].name]);
    }
  });

  it('ticks a table at most every TICK_MS', async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    frame(T0 + 17_900, a);
    frame(T0 + 18_000, a); // 100 ms on: not ticked
    expect(keysIn(a, 'c', 1)).toEqual([]);
    frame(T0 + 18_100, a);
    expect(keysIn(a, 'c', 1)).toHaveLength(1);
  });

  it('closes nothing on a doc holding part of an update', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    run([a], T0 + STEP, T0 + 17_000, { step: STEP });
    const [first, later] = updatesOf(b, () => {
      b.doc.getMap('casino').set(`seat:${TABLE}:${b.pid}`, { stand: 0, angle: 0, at: 1 });
      b.doc.getMap('casino').set(`seat:${TABLE}:${b.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(T0 + 17_000, a, [later]);
    run([a], T0 + 17_200, T0 + 25_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
    deliver(T0 + 25_000, a, [first]);
    const at = run([a], T0 + 25_200, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(at).toBe(T0 + 25_200);
  });

  it('closes nothing from a page with nothing on the felt', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [], T0 + 1_000)).toBe('ok');
    sync(T0 + 1_000, a, b);
    run([a], T0 + 1_200, T0 + 40_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
  });

  it("takes its turn among the felts with chips on: an empty felt ranked ahead doesn't hold it back", async () => {
    const E = testIdentity('empty', 'player-E');
    // A key for A that ranks after E's (fresh keys until one does).
    let a: Page;
    do [a] = await room(['A']);
    while (a.fold.dutyRank('close', CTX, 1, a.pub) < a.fold.dutyRank('close', CTX, 1, E.pub));
    pinOn(a, E);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    putIn(a, [[kit.slip(E, 1, [red(1)]).key, kit.slip(E, 1, [red(1)]).rec]]);
    const down = kit.slip(E, 1, [], { v: 2 });
    putIn(a, [[down.key, down.rec]]);
    expect(foldOf(a).felts.get(E.pid)!.rec.b).toEqual([]);
    const at = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(at).toBe(T0 + 18_000);
  });

  it('gives its turn away with a felt put back at the deadline: the page that never heard it closes, alone, and nothing it showed is rewritten', async () => {
    // (computedSim's sweeps found it: a page first in turn takes its felt
    // down, then puts one back at the deadline, after its turn, and closes at
    // once; the next, which hasn't heard the felt come back, closes as first
    // among the felts it sees. Two closes of the round, each decided as its
    // seeds come: the lone one first, shown, then rewritten by the other.)
    const pages = await room(['A', 'B']);
    const [first, next] = byRank(pages, 'close', 1);
    expect(first.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(next.table.writeComputedSlip(TABLE, [red(20)], T0)).toBe('ok');
    run(pages, T0 + STEP, T0 + 16_000, { step: STEP });
    vi.setSystemTime(T0 + 16_200);
    expect(first.table.writeComputedSlip(TABLE, [], T0 + 16_200)).toBe('ok');
    run(pages, T0 + 16_400, T0 + 17_800, { step: STEP });
    const deadline = phaseOf(first, T0 + 17_800)!.phaseDeadline!;
    expect(deadline).toBe(T0 + first.table.BET_WINDOW_MS);
    // At the deadline the first puts a felt down again and runs its frame;
    // the next, which hasn't heard it, runs its own.
    vi.setSystemTime(deadline);
    expect(first.table.writeComputedSlip(TABLE, [red(10)], deadline)).toBe('ok');
    frame(deadline, first);
    frame(deadline, next);
    expect(keysIn(first, 'c', 1)).toEqual([]);
    expect(closesOf(next, 1).map((c) => signer(pages, c.k))).toEqual([next.name]);
    frame(deadline + STEP, next);
    const shown = phaseOf(next, deadline + STEP)!.spinKey;
    expect(shown).toBe(`1:${foldOf(next).rounds[0].pocket}`);
    run(pages, deadline + 2 * STEP, deadline + 12_000, { step: STEP });
    for (const p of pages) {
      expect(closesOf(p, 1).map((c) => signer(pages, c.k))).toEqual([next.name]);
      expect(phaseOf(p, deadline + 12_000)!.spinKey).toBe(shown);
      // The felt put back missed the close: it holds nothing.
      expect(foldOf(p).rounds[0].present).toEqual([next.pid]);
      expect(p.casino.readChips(first.pid)).toBe(1_000);
    }
  });

  it('closes a felt put back after its turn itself when no other close comes: after every other turn', async () => {
    const pages = await room(['A', 'B']);
    const [first, next] = byRank(pages, 'close', 1);
    expect(first.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(next.table.writeComputedSlip(TABLE, [red(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    vi.setSystemTime(T0 + 16_200);
    expect(first.table.writeComputedSlip(TABLE, [], T0 + 16_200)).toBe('ok');
    const deadline = T0 + first.table.BET_WINDOW_MS;
    run([first], T0 + 16_400, deadline - STEP, { step: STEP });
    vi.setSystemTime(deadline);
    expect(first.table.writeComputedSlip(TABLE, [red(10)], deadline)).toBe('ok');
    // The other page is gone: two felts with chips, so two turns go by.
    const at = run([first], deadline, deadline + 10_000, { step: STEP, until: () => keysIn(first, 'c', 1).length > 0 });
    expectAt(at, deadline + 2 * first.table.STAGGER_MS);
    expect(Object.keys(closesOf(first, 1)[0].f).sort()).toEqual([first.pid, next.pid].sort());
  });

  it("leaves a felt its player's other tab wrote to that tab: one close, of the felt as that tab has it", async () => {
    // (computedSim's overspend scenario found it: two tabs of one player,
    // one key, so one turn; the tab that never wrote the felt closed it at
    // the deadline from a stale view, the other with the felt as it is, and
    // the tie went to the hash, half the time to a felt the player had
    // taken down.)
    const [p] = await room(['P']);
    const q = await loadPage('Q', 9, { reloadOf: p });
    sync(T0, p, q);
    expect(q.pid).toBe(p.pid);
    expect(q.pub).toBe(p.pub);
    expect(p.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    run([p, q], T0, T0 + 14_800, { step: STEP });
    // The writing tab changes the felt; the other, its link slow, hears it
    // only 3 s on.
    vi.setSystemTime(T0 + 15_000);
    expect(p.table.writeComputedSlip(TABLE, [red(10), black(30)], T0 + 15_000)).toBe('ok');
    const latest = foldOf(p).felts.get(p.pid)!.hash;
    const deadline = T0 + p.table.BET_WINDOW_MS;
    for (let T = T0 + 15_000; T <= deadline + 3_000; T += STEP) {
      frame(T, p);
      frame(T, q);
    }
    expect(closesOf(p, 1).map((c) => c.f[p.pid])).toEqual([latest]);
    expect(keysIn(q, 'c', 1)).toEqual([]);
    sync(deadline + 3_000, p, q);
    run([p, q], deadline + 3_200, deadline + 20_000, { step: STEP });
    for (const t of [p, q]) {
      expect(keysIn(t, 'c', 1)).toHaveLength(1);
      const D = foldOf(t).rounds[0];
      expect(D.decided).toBe('reveals');
      expect(D.stakes.get(p.pid)).toBe(40n);
    }
  });

  it("closes a felt its player's other tab wrote itself when that tab's close never comes: after every turn and GRACE_MAX_MS more", async () => {
    const [p] = await room(['P']);
    const q = await loadPage('Q', 9, { reloadOf: p });
    expect(p.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, p, q);
    // The writing tab is gone.
    const at = run([q], T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(q, 'c', 1).length > 0 });
    expectAt(at, T0 + q.table.BET_WINDOW_MS + q.table.STAGGER_MS + q.table.GRACE_MAX_MS);
  });

  it('stands down for a close that came in first: one close only', async () => {
    const pages = await bets();
    run(pages, T0 + STEP, T0 + 25_000, { step: STEP });
    expect(closesOf(pages[0], 1)).toHaveLength(1);
  });

  it('stands down once a seed of the round is out (a close it has not seen froze it); a reveal that opens nothing changes nothing', async () => {
    const pages = await bets();
    const [first, second, third] = byRank(pages, 'close', 1);
    // The first closes; the second hears it and reveals; the third hears the
    // second's reveal (its own update) but never the first's close.
    run([first, second], T0 + STEP, T0 + 18_000, { step: STEP });
    expect(keysIn(second, 'c', 1)).toHaveLength(1);
    const reveal = updatesOf(second, () => frame(T0 + 18_200, second));
    expect(keysIn(second, 'x', 1)).toHaveLength(1);
    deliver(T0 + 18_200, third, reveal);
    expect(keysIn(third, 'c', 1)).toEqual([]);
    expect(keysIn(third, 'x', 1)).toHaveLength(1);
    expect(phaseOf(third, T0 + 18_200)).toMatchObject({ phase: 'betting', round: 1 });
    for (let T = T0 + 18_400; T <= T0 + 25_000; T += STEP) frame(T, third);
    expect(keysIn(third, 'c', 1)).toEqual([]);

    // A junk reveal (it opens no slip) stops nobody.
    const fresh = await bets();
    const [f1, f2] = byRank(fresh, 'close', 1);
    const junk = kit.reveal(1, f1.pid, 'ab'.repeat(32));
    putIn(f1, [[junk.key, junk.rec]]);
    sync(T0, ...fresh);
    const at = run([f2], T0 + STEP, T0 + 25_000, { step: STEP, until: () => keysIn(f2, 'c', 1).length > 0 });
    expectAt(at, T0 + 19_500);
  });

  it("stands down for no slip of the round carrying an earlier round's commitment: none of this round's seeds is out", async () => {
    const pages = await room(['A', 'B']);
    const [a] = pages;
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const open2 = run(pages, T0 + STEP, T0 + 60_000, {
      step: STEP, until: () => pages.every((p) => phaseOf(p)?.phase === 'betting' && foldOf(p).open === 2),
    });
    expect(open2).toBeLessThan(T0 + 60_000);
    const r1 = foldOf(a).rounds[0];
    expect(r1.decided).toBe('reveals');
    // A peer copies A's round-1 commitment (revealed: anyone has it) into
    // junk under round 2's slips; no reveal of round 2 is in.
    const c1 = recOf<SlipRec>(a, `s:1:${a.pid}:${r1.frozen[a.pid]}`).c;
    vi.setSystemTime(open2);
    putIn(a, [[`s:2:player-Z:${fakeHash(7)}`, { r: 2, p: 'player-Z', v: 1, b: [red(1)], c: c1, k: a.pub, g: SIG }]]);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(20 + i)], open2)).toBe('ok');
    sync(open2, ...pages);
    expect(keysIn(a, 'x', 2)).toEqual([]);
    const deadline = phaseOf(a, open2)!.phaseDeadline!;
    expect(deadline).toBe(open2 + 18_000);
    // Two bettors: the second in line closes 1.5 s after the deadline at the latest.
    const at = run(pages, open2 + STEP, open2 + 90_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(at).toBeLessThanOrEqual(deadline + 1_500 + STEP);
  });

  it("stands down for no junk under its key: a {k, q} that is no close, nor a close in shape that another key signed", async () => {
    const pages = await bets();
    const [a] = pages;
    // Junk naming the parent under each bettor's pub: the fold never indexes it.
    const parent = foldOf(a).parent;
    putIn(a, pages.map((p, i): [string, unknown] => [`c:1:${fakeHash(i + 1)}`, { k: p.pub, q: parent }]));
    sync(T0, ...pages);
    expect(foldOf(a).openCloses).toEqual([]);
    let at = run(pages, T0 + STEP, T0 + 40_000, { step: STEP, until: () => foldOf(a).tip !== null });
    expectAt(at, T0 + 18_000);
    // A close in proper shape under a sole bettor's pub, signed by another
    // key: it reads invalid, and the bettor still closes.
    const G = testIdentity('g', 'player-G');
    const [solo] = await room(['A']);
    expect(solo.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const body = { r: 1, q: foldOf(solo).parent, f: { [solo.pid]: foldOf(solo).felts.get(solo.pid)!.hash }, k: solo.pub };
    const forged = { ...body, g: G.sign(solo.fold.signBytes('close', CTX, body)) };
    putIn(solo, [[solo.fold.closeKey(forged)!, forged]]);
    frame(T0 + STEP, solo);
    expect(foldOf(solo).openCloses.map((c) => c.state)).toEqual(['invalid']);
    at = run([solo], T0 + 2 * STEP, T0 + 40_000, { step: STEP, until: () => foldOf(solo).tip !== null || foldOf(solo).rounds.length > 0 });
    expectAt(at, T0 + 18_000);
  });

  it('never signs a second close on one parent, after a reload too (read from the doc)', async () => {
    const pages = await bets();
    const [first, second] = byRank(pages, 'close', 1);
    run([first], T0 + STEP, T0 + 18_000, { step: STEP });
    const [own] = closesOf(first, 1);
    expect(own.k).toBe(first.pub);
    // A peer deletes the closer's frozen slip: its close is invalid (its
    // signer's slip is gone), and the round reads open again.
    const slipKey = `s:1:${first.pid}:${own.f[first.pid]}`;
    deleteIn(second, [slipKey]);
    sync(T0 + 18_000, first, second);
    // The closer reloads before it put its slip back: same key, nothing kept.
    const again = await loadPage(first.name, 9, { reloadOf: first });
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(first.doc));
    expect(again.pub).toBe(first.pub);
    expect(phaseOf(again, T0 + 18_200)).toMatchObject({ phase: 'betting', round: 1 });
    // It bets again; its window (from when it saw the first chip, on load)
    // runs out, and its turn comes, but its own close on this parent is in
    // the doc.
    expect(again.table.writeComputedSlip(TABLE, [red(30)], T0 + 18_200)).toBe('ok');
    expect(phaseOf(again, T0 + 18_200)!.phaseDeadline).toBe(T0 + 36_000);
    for (let T = T0 + 18_400; T <= T0 + 45_000; T += STEP) frame(T, again);
    expect(closesOf(again, 1).filter((c) => c.k === again.pub)).toHaveLength(1);
    // The next in line closes instead, at once (its window ran out long ago).
    const at = run([again, second], T0 + 45_000, T0 + 50_000, {
      step: STEP, until: () => closesOf(second, 1).some((c) => c.k === second.pub),
    });
    expect(at).toBe(T0 + 45_000);
  });

  it('takes a fresh seed for a felt whose seed this page does not hold', async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const was = foldOf(a).felts.get(a.pid)!.rec.c;
    // The same key, the seed store gone (evicted, cleared).
    const again = await loadPage('A', 9, { reloadOf: a });
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc));
    expect(again.table.writeComputedSlip(TABLE, [red(20)], T0 + 1_000)).toBe('ok');
    const now = foldOf(again).felts.get(again.pid)!.rec;
    expect(now).toMatchObject({ v: 2, b: [red(20)] });
    expect(now.c).not.toBe(was);
    expect(again.fair.seedFor(now.c, { room: CTX.room, table: seedTable(CTX), round: 1, party: a.pid, house: '' })).not.toBeNull();
  });

  it("numbers a version past every one under its key in the session (another tab's too), never past a forger's", async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const c = foldOf(a).felts.get(a.pid)!.rec.c;
    const tab = signAs(a, 'slip', { r: 1, p: a.pid, v: 5, b: [red(12)], c });
    const G = testIdentity('g', 'player-G');
    const forged = kit.slip(G, 1, [red(1)], { p: a.pid, v: Number.MAX_SAFE_INTEGER });
    putIn(a, [[a.fold.slipKey(tab)!, tab], [forged.key, forged.rec]]);
    expect(foldOf(a).felts.get(a.pid)!.rec.v).toBe(5);
    expect(a.table.writeComputedSlip(TABLE, [red(15)], T0 + 1_000)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ v: 6, b: [red(15)], c });
  });

  it('freezes no burned commitment and no empty felt, and always its own felt, seen last or not', async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(5)], T0)).toBe('ok');
    const ids = Array.from({ length: 31 }, (_, i) => testIdentity(`fill-${i}`, `player-F${String(i).padStart(2, '0')}`));
    // One player took everything down (and sorts first by pid).
    const gone = testIdentity('gone', 'player-E');
    pinOn(a, gone, ...ids);
    vi.setSystemTime(T0 + 500);
    const felts = ids.map((id) => kit.slip(id, 1, [red(1)]));
    const empty = kit.slip(gone, 1, []);
    putIn(a, [...felts, empty].map((s): [string, unknown] => [s.key, s.rec]));
    // One of them had its seed revealed, and the reveal was deleted: a seed
    // this page saw is out for good.
    const burned = ids[3];
    const x = kit.reveal(1, burned.pid);
    putIn(a, [[x.key, x.rec]]);
    expect(phaseOf(a, T0 + 500)).toMatchObject({ phase: 'betting', round: 1 });
    deleteIn(a, [x.key]);
    // A changes its felt last of all.
    vi.setSystemTime(T0 + 2_000);
    expect(a.table.writeComputedSlip(TABLE, [red(6)], T0 + 2_000)).toBe('ok');
    const own = foldOf(a).felts.get(a.pid)!;
    expect(foldOf(a).felts.size).toBe(33);
    for (let T = T0 + 2_200; T <= T0 + 70_000 && !keysIn(a, 'c', 1).length; T += STEP) frame(T, a);
    const [close] = closesOf(a, 1);
    // 31 felts with chips, one burned: 30 others and its own, every one in.
    expect(Object.keys(close.f)).toHaveLength(31);
    expect(close.f[a.pid]).toBe(own.hash);
    expect(close.f[burned.pid]).toBeUndefined();
    expect(close.f[gone.pid]).toBeUndefined();
    for (const s of felts) if (s.rec.p !== burned.pid) expect(close.f[s.rec.p]).toBe(s.hash);
  });

  it('caps the close at 31 with its own felt, the rest earliest seen first', async () => {
    const [p] = await room(['P']);
    expect(p.table.writeComputedSlip(TABLE, [red(5)], T0)).toBe('ok');
    const ids = Array.from({ length: 31 }, (_, i) => testIdentity(`more-${i}`, `player-M${String(i).padStart(2, '0')}`));
    pinOn(p, ...ids);
    // M30 seen first, M00…M29 half a second later: 31 others for 30 places.
    vi.setSystemTime(T0 + 500);
    const m30 = kit.slip(ids[30], 1, [red(1)]);
    putIn(p, [[m30.key, m30.rec]]);
    vi.setSystemTime(T0 + 1_000);
    putIn(p, ids.slice(0, 30).map((id): [string, unknown] => { const s = kit.slip(id, 1, [red(1)]); return [s.key, s.rec]; }));
    // Its own felt changes last of all.
    vi.setSystemTime(T0 + 2_000);
    expect(p.table.writeComputedSlip(TABLE, [red(6)], T0 + 2_000)).toBe('ok');
    for (let T = T0 + 2_200; T <= T0 + 70_000 && !keysIn(p, 'c', 1).length; T += STEP) frame(T, p);
    const [close] = closesOf(p, 1);
    expect(Object.keys(close.f)).toHaveLength(31);
    expect(close.f[p.pid]).toBe(foldOf(p).tip!.frozen[p.pid]);
    expect(close.f[ids[30].pid]).toBe(m30.hash);
    // Of the 30 seen together, the last by pid is the one left out.
    expect(close.f[ids[29].pid]).toBeUndefined();
    expect(close.f[ids[28].pid]).toBeDefined();
  });
});

/** Pages `names` with chips on round 1, plus test players `fakes` (pinned
 *  on every page, a felt each), run until the close is in on every page:
 *  the pages, the fakes' slips, and when the close was written. */
async function closed(names: string[], fakes: TestIdentity[] = [], opts: { live?: (pages: Page[]) => Page[] } = {}) {
  const pages = await room(names);
  for (const p of pages) pinOn(p, ...fakes);
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
  const slips = fakes.map((id) => kit.slip(id, 1, [black(7)]));
  if (slips.length) putIn(pages[0], slips.map((s): [string, unknown] => [s.key, s.rec]));
  sync(T0, ...pages);
  const live = opts.live?.(pages) ?? pages;
  const at = run(live, T0 + STEP, T0 + 70_000, { step: STEP, until: () => live.every((p) => keysIn(p, 'c', 1).length > 0) });
  sync(at, ...pages);
  return { pages, slips, closedAt: at };
}

/** A test player's reveal of its round-1 seed, into page p at time T. */
function revealFake(p: Page, id: TestIdentity, T: number): void {
  vi.setSystemTime(T + p.skew);
  const x = kit.reveal(1, id.pid);
  putIn(p, [[x.key, x.rec]]);
}

/** When page p first saw key `key` (casinoDoc's stamp). */
const stampOf = (p: Page, key: string): number => p.casino.computedSeenAt(TABLE, key)!;
const closeKeyOn = (p: Page, r = 1): string => keysIn(p, 'c', r)[0];

describe('the reveal', () => {
  it('goes out on a page waiting out a wake (not awake) and on a doc holding part of an update', async () => {
    const { pages } = await closed(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const T = T0 + 30_000;
    // B slept: it runs its tables again after a lapse, so it waits one out.
    b.croupier.noteTablesRunning(T);
    expect(b.croupier.tablesAwake(T)).toBe(false);
    frame(T, b);
    expect(keysIn(b, 'x', 1).filter((k) => k.includes(b.pid))).toHaveLength(1);
    expect(keysIn(b, 'f', 1)).toEqual([]); // its forfeit (the grace long over) waits
    // C holds part of A's update: A's later write came before its earlier one.
    const [first, later] = updatesOf(a, () => {
      a.doc.getMap('casino').set(`seat:${TABLE}:${a.pid}`, { stand: 0, angle: 0, at: 1 });
      a.doc.getMap('casino').set(`seat:${TABLE}:${a.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(T, c, [later]);
    expect(c.casino.casinoWhole(TABLE)).toBe(false);
    frame(T, c);
    expect(keysIn(c, 'x', 1).filter((k) => k.includes(c.pid))).toHaveLength(1);
    expect(keysIn(c, 'f', 1)).toEqual([]);
    // Once is enough: the next tick on the same partial doc writes nothing more.
    const before = c.doc.store.clients.get(c.doc.clientID)!.length;
    frame(T + STEP, c);
    expect(c.doc.store.clients.get(c.doc.clientID)!.length).toBe(before);
    deliver(T + STEP, c, [first]);
    expect(c.casino.casinoWhole(TABLE)).toBe(true);
    expect(foldOf(c).rounds[0].revealed).toContain(c.pid);
    // A, awake all along (it ran its tables, its duties waiting), has a
    // record to check and no time to: its seed goes, nothing else.
    for (let t = T0 + 19_000; t < T; t += 1_000) a.croupier.noteTablesRunning(t);
    a.casino.setComputedVerifyForTests({ budgetMs: 0 });
    const W = testIdentity('w', 'player-W');
    pinOn(a, W);
    const w = kit.slip(W, 1, [red(1)]); // a late felt for the open round
    putIn(a, [[w.key, w.rec]]);
    expect(a.casino.computedSettled(TABLE)).toBe(false);
    frame(T, a);
    expect(a.croupier.tablesAwake(T)).toBe(true);
    expect(keysIn(a, 'x', 1).filter((k) => k.includes(a.pid))).toHaveLength(1);
    expect(keysIn(a, 'f', 1)).toEqual([]);
  });

  it('burns a commitment it revealed on a doc holding part of an update, though the reveal was never counted', async () => {
    const pages = await room(['A', 'B']);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const [first, second] = byRank(pages, 'close', 1);
    const at = run([first], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(first, 'c', 1).length > 0 });
    sync(at, first, second);
    const was = foldOf(second).felts.get(second.pid)!.rec.c;
    const [early, late] = updatesOf(first, () => {
      first.doc.getMap('casino').set(`seat:${TABLE}:${first.pid}`, { stand: 0, angle: 0, at: 1 });
      first.doc.getMap('casino').set(`seat:${TABLE}:${first.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(at, second, [late]);
    frame(at + STEP, second);
    const [x] = keysIn(second, 'x', 1);
    expect(x).toContain(second.pid);
    expect(foldOf(second).revealedCommits.has(was)).toBe(false); // parked: not counted
    // The close and the reveal go (a peer's deletes) before the doc is whole.
    deleteIn(second, [...keysIn(second, 'c', 1), x]);
    deliver(at + STEP, second, [early]);
    expect(foldOf(second).tip).toBeNull();
    expect(foldOf(second).revealedCommits.has(was)).toBe(false);
    frame(at + 2 * STEP, second);
    expect(foldOf(second).felts.get(second.pid)!.rec.c).not.toBe(was);
  });

  it('goes out for a round already decided without it (a forfeit counted the others), and answers nothing', async () => {
    const { pages, closedAt } = await closed(['A', 'B', 'C']);
    // The best-ranked forfeiter is away from the close on: the others decide
    // it by forfeit. Back, it reveals, but its own seed came late: no answer
    // (it would choose, the result known, whether its seed counts).
    const [c, a, b] = byRank(pages, 'forfeit', 1);
    const decidedAt = run([a, b], closedAt + STEP, closedAt + 20_000, {
      step: STEP, until: () => foldOf(a).rounds[0]?.decided === 'forfeit',
    });
    expect(foldOf(a).rounds[0].counted).toEqual([a.pid, b.pid].sort());
    sync(decidedAt, a, b, c);
    expect(foldOf(c).rounds[0].decided).toBe('forfeit');
    frame(decidedAt + STEP, c);
    expect(keysIn(c, 'x', 1).filter((k) => k.includes(c.pid))).toHaveLength(1);
    run(pages, decidedAt + 2 * STEP, decidedAt + 10_000, { step: STEP });
    expect(forfeitsOf(c, 1).map((f) => signer(pages, f.k))).not.toContain(c.name);
    expect(foldOf(c).rounds[0].counted).toEqual([a.pid, b.pid].sort());
  });

  it('goes out again when a peer overwrites it with junk inside the grace: its seed counts', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const [a, b] = pages;
    run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
    expect(foldOf(a).tip!.revealed).toEqual([a.pid, b.pid].sort());
    const key = keysIn(a, 'x', 1).find((k) => k.startsWith(`x:1:${a.pid}:`))!;
    // A second on, a peer writes junk under A's reveal key.
    const T = closedAt + 1_000;
    vi.setSystemTime(T);
    putIn(b, [[key, 'junk']]);
    sync(T, ...pages);
    expect(foldOf(a).tip!.revealed).toEqual([b.pid]);
    run(pages, T + STEP, closedAt + 30_000, { step: STEP });
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [a.pid, b.pid].sort() });
  });
});

describe('the forfeit', () => {
  it('at the end of the grace, by the best-ranked frozen page, counting the seeds seen in time', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const Y = testIdentity('y', 'player-Y'); // reveals 3 s after the close
    const { pages, slips, closedAt } = await closed(['A', 'B'], [X, Y]);
    const [a, b] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    expect(stampOf(b, closeKeyOn(b))).toBe(closeSeen);
    let wrote = -1;
    for (let T = closedAt + STEP; T <= closedAt + 30_000 && wrote < 0; T += STEP) {
      if (T === closeSeen + 3_000) for (const p of pages) revealFake(p, Y, T);
      sync(T, a, b);
      for (const p of pages) frame(T, p);
      sync(T, a, b);
      if (keysIn(a, 'f', 1).length) wrote = T;
    }
    // Y's seed 3 s in stretched the grace to 4.5 s.
    const P = foldOf(a).rounds[0];
    const order = byRank([a, b], 'forfeit', 1);
    const pubs = [a.pub, b.pub, ...slips.map((s) => s.rec.k)];
    const idx = pubs.map((k) => a.fold.dutyRank('forfeit', CTX, 1, k)).sort().indexOf(a.fold.dutyRank('forfeit', CTX, 1, order[0].pub));
    expectAt(wrote, closeSeen + 4_500 + idx * 1_500);
    const [f] = forfeitsOf(a, 1);
    expect(signer(pages, f.k)).toBe(order[0].name);
    expect(f.n).toEqual([a.pid, b.pid, Y.pid].sort());
    expect(P.decided).toBe('forfeit');
    expect(P.counted).toEqual([a.pid, b.pid, Y.pid].sort());
    // X's late seed changes nothing, and nobody forfeits twice.
    for (const p of pages) revealFake(p, X, wrote + 1_000);
    run(pages, wrote + 1_000, wrote + 10_000, { step: STEP });
    expect(foldOf(b).rounds[0].counted).toEqual([a.pid, b.pid, Y.pid].sort());
    expect(forfeitsOf(b, 1)).toHaveLength(1);
  });

  it('writes one per close, even once a seed it counted is gone', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const wrote = run(pages, closedAt + STEP, closedAt + 20_000, { step: STEP, until: () => keysIn(pages[0], 'f', 1).length > 0 });
    const [f] = forfeitsOf(pages[0], 1);
    const writer = pages.find((p) => p.pub === f.k)!;
    const other = pages.find((p) => p !== writer)!;
    expect(f.n).toEqual([writer.pid, other.pid].sort());
    // The other's seed is deleted, and the other is gone: the forfeit no
    // longer stands, and its writer writes no second one.
    deleteIn(writer, keysIn(writer, 'x', 1).filter((k) => k.includes(other.pid)));
    expect(foldOf(writer).tip).not.toBeNull();
    for (let t = wrote + STEP; t <= wrote + 10_000; t += STEP) frame(t, writer);
    expect(writer.croupier.tablesWakeCount()).toBe(0);
    expect(forfeitsOf(writer, 1)).toEqual([f]);
  });

  it('writes none from a page the close did not freeze', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const pages = await room(['A', 'B', 'W']);
    const [a, b, w] = pages;
    for (const p of pages) pinOn(p, X);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(11)], T0)).toBe('ok');
    const xs = kit.slip(X, 1, [red(3)]);
    putIn(a, [[xs.key, xs.rec]]);
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(w, 'c', 1).length > 0 });
    run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
    for (let T = closedAt + 2 * STEP; T <= closedAt + 25_000; T += STEP) frame(T, w);
    expect(keysIn(w, 'f', 1)).toEqual([]);
  });

  it('writes none without its own seed in', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const { pages } = await closed(['A', 'B'], [X]);
    const [a] = pages;
    // A's seed store is gone before it revealed.
    const again = await loadPage('A', 9, { reloadOf: a });
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc));
    const T = T0 + 30_000;
    for (let t = T; t <= T + 30_000; t += STEP) frame(t, again);
    expect(keysIn(again, 'x', 1)).toEqual([]);
    expect(keysIn(again, 'f', 1)).toEqual([]);
  });

  it('waits out a grace stretched by each seed inside it, 10 s at most, and counts no seed after it', async () => {
    // One page, five test players revealing at chosen times, one never.
    const F = Array.from({ length: 6 }, (_, i) => testIdentity(`late-${i}`, `player-L${i}`));
    const { pages, slips, closedAt } = await closed(['A'], F);
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    // Each lands at the very end of the grace it stretched: 4 → 5.5 → 7 →
    // 8.5 → 10 (not 10.5), the last at the capped end itself, counted.
    const at = new Map([[4_000, F[0]], [5_500, F[1]], [7_000, F[2]], [8_500, F[3]], [10_000, F[4]]]);
    let wrote = -1;
    for (let T = closedAt + STEP; T <= closedAt + 40_000 && wrote < 0; T += 100) {
      const id = at.get(T - closeSeen);
      if (id) revealFake(a, id, T);
      if ((T - closedAt) % STEP === 0) frame(T, a);
      if (keysIn(a, 'f', 1).length) wrote = T;
    }
    const pubs = [a.pub, ...slips.map((s) => s.rec.k)];
    const idx = pubs.map((k) => a.fold.dutyRank('forfeit', CTX, 1, k)).sort().indexOf(a.fold.dutyRank('forfeit', CTX, 1, a.pub));
    expectAt(wrote, closeSeen + 10_000 + idx * 1_500);
    const [f] = forfeitsOf(a, 1);
    expect(f.n).toEqual([a.pid, ...F.slice(0, 5).map((id) => id.pid)].sort());
  });

  it('a seed that lands after the grace ran out stretches nothing', async () => {
    const F = [testIdentity('late-a', 'player-La'), testIdentity('late-b', 'player-Lb')];
    // A page whose turn comes after the grace's end (a fresh key until one
    // ranks after a test player's), so a seed can land in between.
    let setup: Awaited<ReturnType<typeof closed>>;
    let idx: number;
    do {
      setup = await closed(['A'], F);
      const pubs = [setup.pages[0].pub, ...setup.slips.map((s) => s.rec.k)];
      const rank = (k: string) => setup.pages[0].fold.dutyRank('forfeit', CTX, 1, k);
      idx = pubs.map(rank).sort().indexOf(rank(setup.pages[0].pub));
    } while (idx === 0);
    const { pages, closedAt } = setup;
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    // La's seed 5 s in, after the 4 s grace, before this page's turn.
    let wrote = -1;
    for (let T = closedAt + STEP; T <= closedAt + 40_000 && wrote < 0; T += 100) {
      if (T - closeSeen === 5_000) revealFake(a, F[0], T);
      if ((T - closedAt) % STEP === 0) frame(T, a);
      if (keysIn(a, 'f', 1).length) wrote = T;
    }
    expectAt(wrote, closeSeen + 4_000 + idx * 1_500);
    expect(forfeitsOf(a, 1)[0].n).toEqual([a.pid]);
  });

  it('is answered by a better-ranked page whose seed a worse-ranked forfeit dropped', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const Z = testIdentity('z', 'player-Z'); // reveals after the dropper's forfeit, inside the grace
    const { pages, closedAt } = await closed(['A', 'B'], [X, Z]);
    const [better, worse] = byRank(pages, 'forfeit', 1);
    // Both reveal on their next tick.
    run(pages, closedAt + STEP, closedAt + 2 * STEP, { step: STEP });
    const closeSeen = stampOf(better, closeKeyOn(better));
    // The worse-ranked page writes a forfeit counting itself alone, early.
    const close = foldOf(worse).tip!;
    const drop = signAs(worse, 'forfeit', { r: 1, x: close.close, n: [worse.pid] });
    vi.setSystemTime(closeSeen + 3_900);
    putIn(worse, [[worse.fold.forfeitKey(drop)!, drop]]);
    sync(closeSeen + 3_900, ...pages);
    expect(foldOf(better).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [worse.pid] });
    expect(better.table.computedRoundCheck(TABLE, closeSeen + 3_900)!.dropped).toEqual([better.pid]);
    for (const p of pages) revealFake(p, Z, closeSeen + 3_950);
    // The better page answers once its grace (stretched by Z: 5.45 s) is over.
    let answered = -1;
    for (let T = closeSeen + 4_000; T <= closeSeen + 20_000 && answered < 0; T += STEP) {
      sync(T, ...pages);
      for (const p of pages) frame(T, p);
      sync(T, ...pages);
      if (forfeitsOf(better, 1).some((f) => f.k === better.pub)) answered = T;
    }
    expectAt(answered, closeSeen + 5_450);
    const mine = forfeitsOf(better, 1).find((f) => f.k === better.pub)!;
    expect(mine.n).toEqual([better.pid, worse.pid, Z.pid].sort());
    for (const p of pages) expect(foldOf(p).rounds[0].counted).toEqual([better.pid, worse.pid, Z.pid].sort());
    expect(better.table.computedRoundCheck(TABLE, answered)!.dropped).toEqual([]);
    // Once per close: with Z's seed deleted its answer no longer stands, and
    // it writes no other.
    const zKey = keysIn(better, 'x', 1).find((k) => k.includes(Z.pid))!;
    deleteIn(better, [zKey]);
    run(pages, answered + STEP, answered + 10_000, { step: STEP });
    expect(foldOf(better).rounds[0].counted).toEqual([worse.pid]);
    expect(forfeitsOf(better, 1).filter((f) => f.k === better.pub)).toHaveLength(1);
    expect(forfeitsOf(better, 1).filter((f) => f.k === worse.pub)).toHaveLength(1);
  });

  it('counts every seed seen by the end of the grace, though a peer deletes one just as it falls due', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const [first, second] = byRank(pages, 'forfeit', 1);
    run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
    expect(foldOf(first).tip!.revealed).toEqual([first.pid, second.pid].sort());
    const key = keysIn(second, 'x', 1).find((k) => k.startsWith(`x:1:${second.pid}:`))!;
    // From 3 s on a peer deletes second's seed whenever it hears it; second
    // puts it back on every tick.
    let T = closedAt + 2 * STEP;
    for (; T <= closedAt + 30_000 && keysIn(first, 'f', 1).length === 0; T += STEP) {
      sync(T, ...pages);
      if (T >= closedAt + 3_000 && keysIn(first, 'x', 1).includes(key)) {
        vi.setSystemTime(T);
        deleteIn(first, [key]);
        sync(T, ...pages);
      }
      for (const p of pages) frame(T, p);
      sync(T, ...pages);
    }
    // The peer stops; second's seed is back.
    run(pages, T, T + 20_000, { step: STEP });
    expect(forfeitsOf(first, 1).find((f) => f.k === first.pub)!.n).toEqual([first.pid, second.pid].sort());
    expect(foldOf(first).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [first.pid, second.pid].sort() });
  });

  it("is written though junk under its key says it was: a {k, x} under f: or z: is no forfeit or abandon of this page's", async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const tip = foldOf(pages[0]).tip!;
    vi.setSystemTime(closedAt);
    putIn(pages[0], pages.flatMap((p, i): [string, unknown][] => [
      [`f:1:${fakeHash(2 * i + 1)}`, { k: p.pub, x: tip.close }],
      [`z:1:${fakeHash(2 * i + 2)}`, { k: p.pub, x: tip.close }],
    ]));
    sync(closedAt, ...pages);
    run(pages, closedAt + STEP, closedAt + 40_000, { step: STEP });
    expect(foldOf(pages[0]).rounds[0]).toMatchObject({ decided: 'forfeit', counted: pages.map((p) => p.pid).sort() });
  });
});

describe('answering a forfeit', () => {
  /** Better and worse (by forfeit rank) with seeds in, X's never: a
   *  forfeit by `by` counting `n`, written by hand 3.9 s after the close. */
  async function forfeitBy(by: 'better' | 'worse', n: (better: Page, worse: Page) => string[]) {
    const X = testIdentity('x', 'player-X');
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const [better, worse] = byRank(pages, 'forfeit', 1);
    run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
    expect(foldOf(better).tip!.revealed).toEqual([better.pid, worse.pid].sort());
    const closeSeen = stampOf(better, closeKeyOn(better));
    const writer = by === 'better' ? better : worse;
    const f = signAs(writer, 'forfeit', { r: 1, x: foldOf(writer).tip!.close, n: n(better, worse).sort() });
    vi.setSystemTime(closeSeen + 3_900);
    putIn(writer, [[writer.fold.forfeitKey(f)!, f]]);
    sync(closeSeen + 3_900, ...pages);
    expect(foldOf(better).rounds[0].decided).toBe('forfeit');
    run(pages, closeSeen + 4_000, closeSeen + 20_000, { step: STEP });
    return { pages, better, worse };
  }

  it('not from a page ranked after the forfeit, whatever it dropped', async () => {
    const { better, worse } = await forfeitBy('better', (b) => [b.pid]);
    expect(forfeitsOf(worse, 1).map((f) => f.k)).toEqual([better.pub]);
    expect(foldOf(worse).rounds[0].counted).toEqual([better.pid]);
  });

  it('not with its own seed late, though it saw another dropped in time', async () => {
    const { pages, closedAt } = await closed(['A', 'B', 'C']);
    const [late, other, worse] = byRank(pages, 'forfeit', 1);
    // The others' seeds go at once, and the late page hears them in time;
    // its own waits (it runs its tables, its duties don't come round).
    run([other, worse], closedAt + STEP, closedAt + STEP, { step: STEP });
    sync(closedAt + STEP, ...pages);
    const closeSeen = stampOf(late, closeKeyOn(late));
    const f = signAs(worse, 'forfeit', { r: 1, x: foldOf(worse).tip!.close, n: [worse.pid] });
    vi.setSystemTime(closeSeen + 3_900);
    putIn(worse, [[worse.fold.forfeitKey(f)!, f]]);
    sync(closeSeen + 3_900, ...pages);
    for (let t = closedAt; t < closeSeen + 10_000; t += 1_000) late.croupier.noteTablesRunning(t);
    // Its seed 10 s on, after the grace.
    const hash = foldOf(late).rounds[0].frozen[late.pid];
    const c = recOf<{ c: string }>(late, `s:1:${late.pid}:${hash}`).c;
    const seed = late.fair.seedFor(c, { room: CTX.room, table: seedTable(CTX), round: 1, party: late.pid, house: '' })!;
    vi.setSystemTime(closeSeen + 10_000);
    const x = kit.reveal(1, late.pid, seed);
    putIn(late, [[x.key, x.rec]]);
    for (let t = closeSeen + 10_000; t <= closeSeen + 20_000; t += STEP) frame(t, late);
    expect(late.croupier.tablesWakeCount()).toBe(0);
    expect(late.table.computedRoundCheck(TABLE, closeSeen + 20_000)!.dropped).toEqual([other.pid]);
    expect(forfeitsOf(late, 1).map((r) => r.k)).toEqual([worse.pub]);
  });

  it('not to a forfeit that dropped nothing this page saw in time', async () => {
    const { better, worse } = await forfeitBy('worse', (b, w) => [b.pid, w.pid]);
    expect(forfeitsOf(better, 1).map((f) => f.k)).toEqual([worse.pub]);
  });

  it('not from a page whose doc slept through the close: what the catch-up after its wake brings came all at once', async () => {
    // (computedSim's clock-steps scenario found it: a round every page showed
    // decided by forfeit, rewritten by the answer of a page back from a sleep
    // offline, counting its own seed that came 7 s after the close.)
    const pages = await room(['A', 'B', 'C']);
    const [away, second, third] = byRank(pages, 'forfeit', 1);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    frame(T0, away);
    // The best-ranked forfeiter's page sleeps from here, its doc offline too.
    // The others close and reveal; then, its grace over, the next forfeits
    // its seed.
    const live = [second, third];
    let backlog: Uint8Array | null = null;
    const decidedAt = run(live, T0 + STEP, T0 + 70_000, {
      step: STEP,
      until: () => {
        const tip = foldOf(second).tip;
        if (!backlog && tip && tip.revealed.length === 2) backlog = Y.encodeStateAsUpdate(second.doc);
        return foldOf(second).rounds[0]?.decided === 'forfeit';
      },
    });
    expect(foldOf(second).rounds[0].counted).toEqual([second.pid, third.pid].sort());
    // It wakes; the catch-up brings the close and the seeds, then the
    // forfeit: it reveals, its seed late.
    const W = decidedAt + STEP;
    frame(W, away);
    expect(away.croupier.tablesWakeCount()).toBe(1);
    vi.setSystemTime(W + STEP + away.skew);
    Y.applyUpdate(away.doc, backlog!);
    frame(W + STEP, away);
    expect(keysIn(away, 'x', 1).filter((k) => k.includes(away.pid))).toHaveLength(1);
    sync(W + 2 * STEP, ...pages);
    expect(stampOf(away, closeKeyOn(away))).toBeLessThan(stampOf(away, keysIn(away, 'f', 1)[0]));
    run(pages, W + 3 * STEP, W + 20_000, { step: STEP });
    // No answer: the round stands as every page showed it.
    expect(forfeitsOf(away, 1).map((f) => signer(pages, f.k))).toEqual([second.name]);
    for (const p of pages) expect(foldOf(p).rounds[0].counted).toEqual([second.pid, third.pid].sort());
  });

  it('not from a page whose clock went back by more than a lapse as the close came, its view read before its frame ran its tables', async () => {
    // (computedSim's clock-steps, its clock events aimed at closes, found it:
    // one step back seen twice in a frame — by the view's read, then as the
    // wake it counts once the frame runs its tables — took stamps from before
    // the step for ones the page watched come in. It answered a forfeit with
    // a seed that came 8 s after the close, and rewrote a round every page
    // had shown.)
    const X = testIdentity('x', 'player-X'); // its seed comes late
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const [better, worse] = byRank(pages, 'forfeit', 1);
    // The better page's clock goes back 7.5 s; the felt's read comes first.
    better.skew -= 7_500;
    const T = closedAt + STEP;
    better.table.readComputedRoulette(TABLE, clockOf(better, T));
    frame(T, better);
    expect(better.croupier.tablesWakeCount()).toBe(1);
    frame(T, worse);
    sync(T, ...pages);
    expect(foldOf(better).tip!.revealed).toEqual([better.pid, worse.pid].sort());
    // It waits out the lapse, then the forfeit duty asks when it saw the close.
    for (let t = T + STEP; t < closedAt + 7_000; t += STEP) {
      sync(t, ...pages);
      frame(t, better);
    }
    // The worse page's forfeit (X's seed hadn't come), then X's seed, 8 s
    // after the close: late for every page that watched the close come in.
    const f = signAs(worse, 'forfeit', { r: 1, x: foldOf(worse).tip!.close, n: [better.pid, worse.pid].sort() });
    vi.setSystemTime(closedAt + 7_000 + worse.skew);
    putIn(worse, [[worse.fold.forfeitKey(f)!, f]]);
    sync(closedAt + 7_000, ...pages);
    for (const p of pages) revealFake(p, X, closedAt + 8_000);
    run(pages, closedAt + 8_200, closedAt + 30_000, { step: STEP });
    // No answer: the round stands as every page showed it.
    expect(forfeitsOf(better, 1).map((r) => signer(pages, r.k))).toEqual([worse.name]);
    for (const p of pages) expect(foldOf(p).rounds[0].counted).toEqual([better.pid, worse.pid].sort());
  });
});

describe('the abandon', () => {
  it("a griefer's abandon at once loses to the honest forfeit at the grace", async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const G = testIdentity('griefer', 'player-G');
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const [a] = pages;
    const tip = foldOf(a).tip!;
    const z = kit.abandon(G, 1, tip.close);
    vi.setSystemTime(closedAt);
    putIn(a, [[z.key, z.rec]]);
    sync(closedAt, ...pages);
    for (const p of pages) expect(foldOf(p).rounds[0].decided).toBe('void');
    const at = run(pages, closedAt + STEP, closedAt + 20_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).rounds[0].decided === 'forfeit'),
    });
    expect(at).toBeLessThan(closedAt + 4_000 + 3 * 1_500 + 2 * STEP);
    expect(foldOf(a).rounds[0].counted).toEqual(pages.map((p) => p.pid).sort());
    expect(forfeitsOf(a, 1)).toHaveLength(1);
  });

  it('voids a round whose bettors all left, 30 s after the close, from a seated page or one with a record, each in its turn', async () => {
    const rank = (p: Page, k: string) => p.fold.dutyRank('abandon', CTX, 1, k);
    for (const who of [2, 4]) {
      // C (seated, no slip) ranked ahead of E (a slip, no felt): fresh keys until so.
      let pages: Page[];
      do pages = await room(['A', 'B', 'C', 'D', 'E']);
      while (rank(pages[2], pages[2].pub) > rank(pages[2], pages[4].pub));
      const [a, b, c, d, e] = pages;
      expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
      expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
      // E put chips down and took them back up: a record, no felt.
      expect(e.table.writeComputedSlip(TABLE, [red(5)], T0)).toBe('ok');
      expect(e.table.writeComputedSlip(TABLE, [], T0 + 1_000)).toBe('ok');
      // C sits at the table with no bet; D only watches.
      c.casino.writeMySeat(TABLE, c.pid, { stand: 2, angle: 1, at: 1 });
      sync(T0 + 1_000, ...pages);
      // The bettors close and leave before their next tick.
      const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
      sync(closedAt, ...pages);
      if (who === 2) {
        // A page with neither a seat nor a record never abandons.
        for (let T = closedAt + STEP; T <= closedAt + 60_000; T += STEP) frame(T, d);
        expect(keysIn(d, 'z', 1)).toEqual([]);
      }
      // C (or E) alone, in its turn among the slips' and the seats' keys.
      const p = pages[who];
      const closeSeen = stampOf(p, closeKeyOn(p));
      const at = run([p], closedAt + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(p, 'z', 1).length > 0 });
      const ranks = [a, b, c, e].map((q) => rank(p, q.pub)).sort();
      expectAt(at, closeSeen + 30_000 + ranks.indexOf(rank(p, p.pub)) * 1_500);
      expect(keysIn(p, 'z', 1).map((k) => signer(pages, recOf<{ k: string }>(p, k).k))).toEqual([p.name]);
      sync(at, ...pages);
      for (const q of pages) {
        expect(foldOf(q).rounds[0].decided).toBe('void');
        expect(q.casino.readChips(a.pid)).toBe(1_000);
        expect(q.casino.readChips(b.pid)).toBe(1_000);
        expect(phaseOf(q, at)).toMatchObject({ phase: 'settled', round: 1, voided: true, result: null, payouts: {} });
      }
    }
  });

  it('stands as all its bettors come back from a sleep through it at once: the seed that would make the set whole stays in', async () => {
    // (computedSim's abandoned scenario found it: every bettor a close froze
    // gone before its reveal, the round voided 30 s on, and each, back, put
    // its seed out for it: every seed in, the reveals beat the void every
    // page had shown, and the round paid out a minute late.)
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    c.casino.writeMySeat(TABLE, c.pid, { stand: 2, angle: 1, at: 1 });
    sync(T0, ...pages);
    // The bettors close and sleep before their next tick, their docs too.
    const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    sync(closedAt, ...pages);
    const at = run([c], closedAt + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(c, 'z', 1).length > 0 });
    sync(at, ...pages);
    for (const p of pages) expect(foldOf(p).rounds[0].decided).toBe('void');
    // Back together (a wake: a lapse since their last frame), each holding
    // its seed: the first in turn puts its seed out; the other, seeing it,
    // holds its own.
    for (const p of [a, b]) expect(p.fair.seedFor(slipsOf(p, 1, p.pid)[0].c, { room: CTX.room, table: seedTable(CTX), round: 1, party: p.pid, house: '' })).not.toBeNull();
    const [first] = byRank([a, b], 'forfeit', 1);
    run(pages, at + STEP, at + 20_000, { step: STEP });
    for (const p of pages) {
      expect(keysIn(p, 'x', 1).map((k) => k.split(':')[2])).toEqual([first.pid]);
      expect(foldOf(p).rounds[0].decided).toBe('void');
      expect(p.casino.readChips(a.pid)).toBe(1_000);
      expect(p.casino.readChips(b.pid)).toBe(1_000);
    }
  });

  it("takes its turn among the session's earlier bettors too: a record from round 1 abandons round 2", async () => {
    const rank = (p: Page, k: string) => p.fold.dutyRank('abandon', CTX, 2, k);
    // E bets in round 1 only, and ranks ahead of A for round 2's abandon.
    let a: Page;
    let e: Page;
    do [a, e] = await room(['A', 'E']);
    while (rank(a, e.pub) > rank(a, a.pub));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(e.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, a, e);
    const open2 = run([a, e], T0 + STEP, T0 + 60_000, { step: STEP, until: () => phaseOf(a)?.round === 2 && phaseOf(a)?.phase === 'betting' });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], open2)).toBe('ok');
    const closedAt = run([a, e], open2 + STEP, open2 + 30_000, { step: STEP, until: () => keysIn(e, 'c', 2).length > 0 });
    // A leaves; E, with no felt on round 2, abandons it first in line.
    const closeSeen = stampOf(e, keysIn(e, 'c', 2)[0]);
    const at = run([e], closedAt + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(e, 'z', 2).length > 0 });
    expectAt(at, closeSeen + 30_000);
  });

  it('takes its turn among every checked slip in the session: one a close left out counts too', async () => {
    const rank = (p: Page, k: string) => p.fold.dutyRank('abandon', CTX, 2, k);
    // E ranks first for round 2's abandon among A, B and E.
    let pages: Page[];
    do pages = await room(['A', 'B', 'E']);
    while (!(rank(pages[0], pages[2].pub) < rank(pages[0], pages[0].pub) && rank(pages[0], pages[2].pub) < rank(pages[0], pages[1].pub)));
    const [a, b, e] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, ...pages);
    // A and B close round 1 without E hearing it; E puts chips down just
    // after (its page still reads betting): a slip the close left out.
    const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(e.table.writeComputedSlip(TABLE, [red(5)], closedAt)).toBe('ok');
    sync(closedAt, ...pages);
    expect(Object.keys(foldOf(a).rounds[0].frozen)).not.toContain(e.pid);
    expect(keysIn(a, 's', 1).filter((k) => k.includes(e.pid))).toHaveLength(1);
    // Round 1 plays out; A and B bet round 2, it closes, and they leave.
    const open2 = run(pages, closedAt + STEP, closedAt + 60_000, {
      step: STEP, until: () => foldOf(a).open === 2 && phaseOf(a)?.phase === 'betting' && phaseOf(b)?.phase === 'betting',
    });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], open2)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(10)], open2)).toBe('ok');
    sync(open2, ...pages);
    // (E runs on meanwhile, with nothing on round 2: no wake restarts its wait.)
    const closed2 = run(pages, open2 + STEP, open2 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    sync(closed2, ...pages);
    const closeSeen = stampOf(e, keysIn(e, 'c', 2)[0]);
    // E alone, its round-1 slip its only record: first in line.
    const at = run([e], closed2 + STEP, closed2 + 60_000, { step: STEP, until: () => keysIn(e, 'z', 2).length > 0 });
    expect(e.croupier.tablesWakeCount()).toBe(0);
    expectAt(at, closeSeen + 30_000);
  });

  it("is written though junk under its key says it was: a {k, x} under z: is no abandon of this page's", async () => {
    const X = testIdentity('x', 'player-X');
    const Q = testIdentity('q', 'player-Q');
    const [c] = await room(['C']);
    pinOn(c, X, Q);
    c.casino.writeMySeat(TABLE, c.pid, { stand: 2, angle: 1, at: 1 });
    const sx = kit.slip(X, 1, [black(7)]);
    const sq = kit.slip(Q, 1, [red(9)]);
    const close = kit.close(X, 1, foldOf(c).parent, [sx, sq]);
    putIn(c, [[sx.key, sx.rec], [sq.key, sq.rec], [close.key, close.rec]]);
    frame(T0 + STEP, c);
    expect(foldOf(c).tip?.r).toBe(1);
    putIn(c, [[`z:1:${fakeHash(1)}`, { k: c.pub, x: close.hash }]]);
    const closeSeen = stampOf(c, close.key);
    const at = run([c], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => keysIn(c, 'z', 1).length > 1 });
    const ranks = [X.pub, Q.pub, c.pub].map((k) => c.fold.dutyRank('abandon', CTX, 1, k)).sort();
    expectAt(at, closeSeen + 30_000 + ranks.indexOf(c.fold.dutyRank('abandon', CTX, 1, c.pub)) * 1_500);
    expect(foldOf(c).rounds[0].decided).toBe('void');
  });

  it("a griefer's abandon at once, and junk under each forfeiter's key, still lose to the honest forfeit at the grace", async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const G = testIdentity('griefer', 'player-G');
    const { pages, closedAt } = await closed(['A', 'B'], [X]);
    const [a] = pages;
    const tip = foldOf(a).tip!;
    const z = kit.abandon(G, 1, tip.close);
    vi.setSystemTime(closedAt);
    putIn(a, [[z.key, z.rec], ...pages.map((p, i): [string, unknown] => [`f:1:${fakeHash(i + 1)}`, { k: p.pub, x: tip.close }])]);
    sync(closedAt, ...pages);
    for (const p of pages) expect(foldOf(p).rounds[0].decided).toBe('void');
    run(pages, closedAt + STEP, closedAt + 30_000, { step: STEP });
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', counted: pages.map((p) => p.pid).sort() });
  });
});

describe('the re-put', () => {
  it('puts back a record of its own a peer deleted, byte for byte, on its REPUT_MS beat', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10), straight(17, 3)], T0)).toBe('ok');
    sync(T0, a, b);
    const [key] = keysIn(a, 's', 1);
    const was = JSON.stringify(recOf(a, key));
    // A looks for missing records from its first tick on: T0 + 200, + 1,200, + 2,200 …
    run([a, b], T0 + STEP, T0 + 1_200, { step: STEP });
    deleteIn(b, [key]);
    sync(T0 + 1_400, a, b);
    expect(keysIn(a, 's', 1)).toEqual([]);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    const back = run([a, b], T0 + 1_400, T0 + 5_000, { step: STEP, until: () => keysIn(b, 's', 1).includes(key) });
    expect(back).toBe(T0 + 2_200);
    expect(JSON.stringify(recOf(b, key))).toBe(was);
    expect(b.casino.readChips(a.pid)).toBe(987);
    // Its close, its seed and its forfeit go back as well.
    const X = testIdentity('x', 'player-X');
    for (const p of [a, b]) pinOn(p, X);
    const xs = kit.slip(X, 1, [black(5)]);
    putIn(a, [[xs.key, xs.rec]]);
    let T = back + STEP;
    for (; T <= T0 + 60_000 && !keysIn(a, 'f', 1).length; T += STEP) run([a], T, T);
    const mine = [...keysIn(a, 'c', 1), ...keysIn(a, 'x', 1), ...keysIn(a, 'f', 1)];
    expect(mine).toHaveLength(3);
    const bytes = mine.map((k) => JSON.stringify(recOf(a, k)));
    sync(T, a, b);
    deleteIn(b, mine);
    sync(T, a, b);
    run([a, b], T + STEP, T + 2_000, { step: STEP });
    expect(mine.map((k) => JSON.stringify(recOf(b, k)))).toEqual(bytes);
  });

  it('of its slips puts back only its latest version of the round, and any version a close froze', async () => {
    const [a] = await room(['A']);
    const F = testIdentity('f', 'player-F');
    pinOn(a, F);
    const versions: string[] = [];
    for (const [i, amount] of [10, 20, 30].entries()) {
      expect(a.table.writeComputedSlip(TABLE, [red(amount)], T0 + i * 500)).toBe('ok');
      versions.push(foldOf(a).felts.get(a.pid)!.key);
    }
    const [v1, v2, v3] = versions;
    // F's close froze A's second version (it hadn't heard the third).
    vi.setSystemTime(T0 + 1_500);
    const fs = kit.slip(F, 1, [black(5)]);
    const close = kit.close(F, 1, foldOf(a).parent, { [F.pid]: fs.hash, [a.pid]: v2.split(':')[3] });
    putIn(a, [[fs.key, fs.rec], [close.key, close.rec]]);
    expect(foldOf(a).tip?.frozen[a.pid]).toBe(v2.split(':')[3]);
    deleteIn(a, versions);
    expect(foldOf(a).tip?.missing).toEqual([a.pid]);
    frame(T0 + 2_000, a);
    expect(keysIn(a, 's', 1).filter((k) => k.includes(a.pid))).toEqual([v2, v3].sort());
    expect(keysIn(a, 's', 1)).not.toContain(v1);
    // And with the frozen one back, its seed goes out.
    frame(T0 + 2_200, a);
    expect(foldOf(a).tip?.revealed).toEqual([a.pid]);
  });

  it('puts back a version frozen by a close that reads invalid (its signer’s slip gone): the close may stand again', async () => {
    const [a] = await room(['A']);
    const F = testIdentity('f', 'player-F');
    pinOn(a, F);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const v1 = foldOf(a).felts.get(a.pid)!;
    expect(a.table.writeComputedSlip(TABLE, [red(20)], T0 + 500)).toBe('ok');
    const v2 = foldOf(a).felts.get(a.pid)!;
    vi.setSystemTime(T0 + 1_000);
    const fs = kit.slip(F, 1, [black(5)]);
    const close = kit.close(F, 1, foldOf(a).parent, { [F.pid]: fs.hash, [a.pid]: v1.hash });
    putIn(a, [[fs.key, fs.rec], [close.key, close.rec]]);
    deleteIn(a, [fs.key, v1.key, v2.key]);
    expect(foldOf(a).tip).toBeNull();
    expect(foldOf(a).openCloses.map((c) => c.state)).toEqual(['invalid']);
    frame(T0 + 1_200, a);
    expect(keysIn(a, 's', 1)).toEqual([v1.key, v2.key].sort());
    // F puts its own back: the close stands, A's frozen felt in it.
    putIn(a, [[fs.key, fs.rec]]);
    expect(foldOf(a).tip).toMatchObject({ close: close.hash, present: [F.pid, a.pid].sort() });
  });

  it('lets go of what a checkpoint covers, and of the seeds behind it; puts back what it wrote since', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const c1 = foldOf(a).felts.get(a.pid)!.rec.c;
    const ctx1 = { room: CTX.room, table: seedTable(CTX), round: 1, party: a.pid, house: '' };
    const decided = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => !!foldOf(a).rounds[0]?.decided });
    const opened = run([a, b], decided + STEP, decided + 20_000, { step: STEP, until: () => phaseOf(a)?.phase === 'betting' });
    expect(a.fair.seedFor(c1, ctx1)).not.toBeNull();
    const chips = a.casino.readChips(a.pid);
    trimByHand(a, testIdentity('trimmer'));
    sync(opened, a, b);
    expect(foldOf(a).base.u).toBe(1);
    expect(a.casino.readChips(a.pid)).toBe(chips);
    // Round 1's slip, close and seed aren't in the new session, and stay out.
    let T = opened + STEP;
    for (; T <= opened + 3_000; T += STEP) run([a, b], T, T);
    expect(keysIn(a, 's', 1)).toEqual([]);
    expect(keysIn(a, 'c', 1)).toEqual([]);
    expect(keysIn(a, 'x', 1)).toEqual([]);
    expect(a.fair.seedFor(c1, ctx1)).toBeNull();
    // A round-2 slip deleted from the new session goes back.
    expect(a.table.writeComputedSlip(TABLE, [red(15)], T)).toBe('ok');
    const [key] = keysIn(a, 's', 2);
    sync(T, a, b);
    deleteIn(b, [key]);
    run([a, b], T + STEP, T + 2_000, { step: STEP });
    expect(keysIn(b, 's', 2)).toEqual([key]);
  });

  it('puts back its latest version when a peer overwrites it with junk: the close freezes that one, not the one before', async () => {
    const [a, b] = await room(['A', 'B']);
    // A puts 300 down, then changes its mind to 30 (a later version).
    expect(a.table.writeComputedSlip(TABLE, [red(300)], T0)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(30)], T0 + 1_000)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(10)], T0)).toBe('ok');
    sync(T0 + 1_000, a, b);
    const latest = foldOf(a).felts.get(a.pid)!;
    expect(latest.rec.b).toEqual([red(30)]);
    // A peer writes junk under it: the fold falls back to the 300.
    vi.setSystemTime(T0 + 2_000);
    putIn(b, [[latest.key, 'junk']]);
    sync(T0 + 2_000, a, b);
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toEqual([red(300)]);
    run([a, b], T0 + 2_200, T0 + 40_000, { step: STEP });
    expect(foldOf(a).rounds[0].stakes.get(a.pid)).toBe(30n);
  });
});

describe('writing a slip', () => {
  it('writes a round’s first felt at once, then one version per COALESCE_MS, the held felt shown on this page meanwhile', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(slipsOf(a, 1, a.pid).map((s) => s.v)).toEqual([1]);
    expect(a.table.writeComputedSlip(TABLE, [red(20)], T0 + 50)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(30)], T0 + 100)).toBe('ok');
    expect(slipsOf(a, 1, a.pid)).toHaveLength(1);
    expect(a.table.readMyComputedBets(TABLE, a.pid, 1, T0 + 100)).toEqual([red(30)]);
    expect(a.table.readComputedBets(TABLE, 1, T0 + 100)).toEqual({ [a.pid]: [red(10)] });
    expect(a.casino.readChips(a.pid)).toBe(990);
    sync(T0 + 100, a, b);
    expect(b.table.readMyComputedBets(TABLE, a.pid, 1, T0 + 100)).toEqual([red(10)]);
    frame(T0 + 100, a); // 100 ms since the last: held
    expect(slipsOf(a, 1, a.pid)).toHaveLength(1);
    frame(T0 + 300, a); // 300 ms: one version for both changes
    expect(slipsOf(a, 1, a.pid).map((s) => [s.v, s.b]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([[1, [red(10)]], [2, [red(30)]]]);
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ v: 2, b: [red(30)] });
    // Every version under one commitment while its seed is held and unburned.
    expect(new Set(slipsOf(a, 1, a.pid).map((s) => s.c)).size).toBe(1);
    // A clock stepped back a little: the next change goes at once.
    expect(a.table.writeComputedSlip(TABLE, [red(31)], T0 + 250)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ v: 3, b: [red(31)] });
    // The same felt again writes nothing.
    expect(a.table.writeComputedSlip(TABLE, [red(31)], T0 + 5_000)).toBe('ok');
    expect(slipsOf(a, 1, a.pid)).toHaveLength(3);
  });

  it('flushes a held felt on the tick at the deadline less FLUSH_BEFORE_MS, and writes at once from then on', async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const deadline = phaseOf(a, T0)!.phaseDeadline!;
    expect(deadline).toBe(T0 + 18_000);
    frame(deadline - 1_400, a);
    expect(a.table.writeComputedSlip(TABLE, [red(20)], deadline - 1_200)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(30)], deadline - 1_100)).toBe('ok');
    expect(slipsOf(a, 1, a.pid)).toHaveLength(2);
    frame(deadline - 1_000, a); // 200 ms since the last, but inside the last second
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ v: 3, b: [red(30)] });
    expect(a.table.writeComputedSlip(TABLE, [red(40)], deadline - 950)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ v: 4, b: [red(40)] });
  });

  it('drops a held felt once its round has closed, or once the chips for it are gone', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, a, b);
    // Chips gone before the flush: the held felt goes nowhere.
    expect(a.table.writeComputedSlip(TABLE, [red(900)], T0 + 100)).toBe('ok');
    expect(a.casino.spendChips(a.pid, 500)).toBe(true);
    frame(T0 + 400, a);
    expect(slipsOf(a, 1, a.pid)).toHaveLength(1);
    expect(a.table.readMyComputedBets(TABLE, a.pid, 1, T0 + 400)).toEqual([red(10)]);
    run([a, b], T0 + 600, T0 + 9_800, { step: STEP });
    // A held felt, and a close comes before A's next tick.
    expect(a.table.writeComputedSlip(TABLE, [red(20)], T0 + 10_000)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(30)], T0 + 10_100)).toBe('ok');
    sync(T0 + 10_100, a, b);
    const at = run([b], T0 + 10_200, T0 + 30_000, { step: STEP, until: () => keysIn(b, 'c', 1).length > 0 });
    sync(at, a, b);
    expect(a.table.readMyComputedBets(TABLE, a.pid, 1, at)).toEqual([red(20)]);
    const opened = run([a, b], at + STEP, at + 30_000, { step: STEP, until: () => phaseOf(a)?.phase === 'betting' });
    run([a, b], opened, opened + 2_000, { step: STEP });
    expect(slipsOf(a, 1, a.pid)).toHaveLength(2);
    expect(keysIn(a, 's', 2)).toEqual([]);
    expect(a.table.readMyComputedBets(TABLE, a.pid, 2, opened + 2_000)).toEqual([]);
  });

  it("says 'reconnecting' off a computed table, asleep, on a doc holding part of an update, and with signatures to check", async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip('roulette-2', [red(1)], T0)).toBe('reconnecting');
    // Asleep: it ran its tables, then nothing for a lapse.
    frame(T0, a);
    a.croupier.noteTablesRunning(T0 + 10_000);
    expect(a.table.writeComputedSlip(TABLE, [red(1)], T0 + 10_000)).toBe('reconnecting');
    a.croupier.noteTablesRunning(T0 + 15_900);
    expect(a.table.writeComputedSlip(TABLE, [red(1)], T0 + 15_900)).toBe('reconnecting');
    a.croupier.noteTablesRunning(T0 + 16_000);
    expect(a.table.writeComputedSlip(TABLE, [red(1)], T0 + 16_000)).toBe('ok');
    // A doc holding part of B's updates.
    const [first, later] = updatesOf(b, () => {
      b.doc.getMap('casino').set(`seat:${TABLE}:${b.pid}`, { stand: 0, angle: 0, at: 1 });
      b.doc.getMap('casino').set(`seat:${TABLE}:${b.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(T0 + 16_000, a, [later]);
    expect(a.table.writeComputedSlip(TABLE, [red(2)], T0 + 16_500)).toBe('reconnecting');
    deliver(T0 + 16_500, a, [first]);
    expect(a.table.writeComputedSlip(TABLE, [red(2)], T0 + 16_500)).toBe('ok');
    // A record whose signature this page has no time to check yet.
    a.casino.setComputedVerifyForTests({ budgetMs: 0 });
    expect(b.table.writeComputedSlip(TABLE, [black(5)], T0 + 16_500)).toBe('ok');
    sync(T0 + 16_500, a, b);
    expect(a.casino.computedSettled(TABLE)).toBe(false);
    expect(a.table.writeComputedSlip(TABLE, [red(3)], T0 + 17_000)).toBe('reconnecting');
  });

  it("says 'closed' while closing and while settled", async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(phaseOf(a, closedAt)!.phase).toBe('closing');
    expect(a.table.writeComputedSlip(TABLE, [red(20)], closedAt)).toBe('closed');
    const decided = run([a], closedAt + STEP, closedAt + 10_000, { step: STEP, until: () => phaseOf(a)?.phase === 'settled' });
    expect(a.table.writeComputedSlip(TABLE, [red(20)], decided)).toBe('closed');
    run([a], decided + STEP, decided + a.table.SHOW_MS - STEP, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(20)], decided + a.table.SHOW_MS - 1)).toBe('closed');
    expect(a.table.writeComputedSlip(TABLE, [red(20)], decided + a.table.SHOW_MS)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ r: 2, b: [red(20)] });
  });

  it("says 'full' with 31 other felts and none of its own: not with one of its own, nor to take chips down; a held felt it would refuse goes nowhere", async () => {
    const [a] = await room(['A']);
    const ids = Array.from({ length: 31 }, (_, i) => testIdentity(`full-${i}`, `player-G${String(i).padStart(2, '0')}`));
    pinOn(a, ...ids);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [], T0 + 400)).toBe('ok');
    // A held felt, then the table fills before the flush.
    expect(a.table.writeComputedSlip(TABLE, [red(5)], T0 + 500)).toBe('ok');
    vi.setSystemTime(T0 + 600);
    putIn(a, ids.map((id): [string, unknown] => { const s = kit.slip(id, 1, [red(1)]); return [s.key, s.rec]; }));
    frame(T0 + 800, a);
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toEqual([]);
    expect(a.table.writeComputedSlip(TABLE, [red(5)], T0 + 1_000)).toBe('full');
    expect(a.table.writeComputedSlip(TABLE, [], T0 + 1_000)).toBe('ok');
    // One of the 31 takes everything down: room again.
    vi.setSystemTime(T0 + 1_100);
    const down = kit.slip(ids[0], 1, [], { v: 2 });
    putIn(a, [[down.key, down.rec]]);
    expect(a.table.writeComputedSlip(TABLE, [red(5)], T0 + 1_200)).toBe('ok');
    // Back to 31 others: a page with a felt on may change it, and take it down.
    vi.setSystemTime(T0 + 1_300);
    const up = kit.slip(ids[0], 1, [red(2)], { v: 3 });
    putIn(a, [[up.key, up.rec]]);
    expect(a.table.writeComputedSlip(TABLE, [red(7)], T0 + 2_000)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toEqual([red(7)]);
    expect(a.table.writeComputedSlip(TABLE, [], T0 + 3_000)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toEqual([]);
  });

  it("says 'chips' for more than its chips past what its felt holds; throws on a felt a slip can't carry", async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(1_001)], T0)).toBe('chips');
    expect(a.table.writeComputedSlip(TABLE, [red(600), black(400)], T0)).toBe('ok');
    expect(a.casino.readChips(a.pid)).toBe(0);
    // Its felt's 1,000 count for the next one.
    expect(a.table.writeComputedSlip(TABLE, [red(1_000)], T0 + 500)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(1_000), black(1)], T0 + 1_000)).toBe('chips');
    expect(() => a.table.writeComputedSlip(TABLE, [{ type: 'red', amount: -5 } as never], T0 + 1_000)).toThrow(TypeError);
    expect(() => a.table.writeComputedSlip(TABLE, [{ type: 'straight', pick: 37, amount: 1 } as never], T0 + 1_000)).toThrow(TypeError);
    expect(() => a.table.writeComputedSlip(TABLE, 'red' as never, T0 + 1_000)).toThrow(TypeError);
    // Extra fields are left off: the slip carries the exact shape.
    expect(a.table.writeComputedSlip(TABLE, [{ ...straight(7, 5), note: 'x' } as never], T0 + 2_000)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toEqual([{ type: 'straight', pick: 7, amount: 5 }]);
  });

  it('numbers past no junk under its pid and key: taking every chip down still goes, and a held felt flushes without a throw', async () => {
    const [a, b] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(100)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(10)], T0)).toBe('ok');
    sync(T0, a, b);
    // Junk under A's slips: A's pub, a signature nobody made, a made-up
    // hash, v at the top of the safe range. The fold never indexes it.
    const junk = { r: 1, p: a.pid, v: Number.MAX_SAFE_INTEGER, b: [red(1)], c: '0'.repeat(64), k: a.pub, g: SIG };
    putIn(b, [[`s:1:${a.pid}:${fakeHash(9)}`, junk]]);
    sync(T0 + 1_000, a, b);
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toEqual([red(100)]);
    expect(a.table.writeComputedSlip(TABLE, [], T0 + 2_000)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec).toMatchObject({ v: 2, b: [] });
    sync(T0 + 2_000, a, b);
    run([a, b], T0 + 2_200, T0 + 40_000, { step: STEP });
    expect(foldOf(a).rounds[0]?.frozen[a.pid]).toBeUndefined();
    // The same junk before a held felt's flush: the tick writes it, and throws nothing.
    const [c] = await room(['C']);
    expect(c.table.writeComputedSlip(TABLE, [red(100)], T0)).toBe('ok');
    expect(c.table.writeComputedSlip(TABLE, [red(120)], T0 + 100)).toBe('ok'); // held: within COALESCE_MS
    putIn(c, [[`s:1:${c.pid}:${fakeHash(9)}`, { ...junk, p: c.pid, k: c.pub }]]);
    expect(() => frame(T0 + 400, c)).not.toThrow();
    expect(foldOf(c).felts.get(c.pid)!.rec).toMatchObject({ v: 2, b: [red(120)] });
  });

  it("says 'reconnecting' with no live session to write into: a felt that would land nowhere isn't 'ok'", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(20)], T0)).toBe('ok');
    run(pages, T0, T0 + 40_000, { step: STEP, until: () => foldOf(a).rounds[0]?.decided != null });
    const sid = trimByHand(a, testIdentity('trimmer'));
    // A peer deletes the session the checkpoint opens, nothing in its place,
    // and C joins afterwards.
    a.doc.transact(() => a.doc.getMap('casinoComputed').delete(`ses:${TABLE}:${CTX.inc}:${sid}`));
    const c = await loadPage('C', 9);
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc));
    c.casino.buyInChips(c.pid, 1_000);
    const T = T0 + 60_000;
    frame(T, c);
    expect(c.casino.computedSessionForWrite(TABLE)).toBeNull();
    expect(phaseOf(c, T)).toMatchObject({ phase: 'betting', round: 2 });
    expect(c.table.writeComputedSlip(TABLE, [red(5)], T)).toBe('reconnecting');
    expect(c.table.readMyComputedBets(TABLE, c.pid, 2, T)).toEqual([]);
  });
});

describe('a commitment out', () => {
  /** A and B bet; the first in line closes on its own; the second hears the
   *  close and reveals; then the close is deleted before anyone else hears
   *  it: round 1 reads open again on the second page, its seed out. */
  async function forked() {
    const pages = await room(['A', 'B']);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const [first, second] = byRank(pages, 'close', 1);
    const at = run([first], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(first, 'c', 1).length > 0 });
    const was = foldOf(second).felts.get(second.pid)!.rec.c;
    const close = keysIn(first, 'c', 1);
    const out = updatesOf(second, () => {
      sync(at, first, second);
      frame(at + STEP, second);
    });
    expect(keysIn(second, 'x', 1)).toHaveLength(1);
    deleteIn(second, close);
    expect(out.length).toBeGreaterThan(0);
    expect(foldOf(second).tip).toBeNull();
    expect(foldOf(second).revealedCommits.has(was)).toBe(true);
    return { first, second, was, at: at + STEP };
  }

  it('goes again under a fresh seed on the next tick (the seed store opens it), never frozen again', async () => {
    const { second, was, at } = await forked();
    frame(at + STEP, second);
    const now = foldOf(second).felts.get(second.pid)!.rec;
    expect(now.c).not.toBe(was);
    expect(now.b).toEqual(slipsOf(second, 1, second.pid).find((s) => s.c === was)!.b);
    expect(now.v).toBe(2);
    const seed = second.fair.seedFor(now.c, { room: CTX.room, table: seedTable(CTX), round: 1, party: second.pid, house: '' });
    expect(slipCommit(CTX, 1, second.pid, seed!)).toBe(now.c);
    // A seed of round 1 is out: no page closes it (its own close stands down).
    for (let T = at + 2 * STEP; T <= at + 10_000; T += STEP) frame(T, second);
    expect(keysIn(second, 'c', 1)).toEqual([]);
  });

  it('a felt written right after does not reuse the burned commitment', async () => {
    const { second, was, at } = await forked();
    expect(second.table.writeComputedSlip(TABLE, [red(25)], at + 50)).toBe('ok');
    const now = foldOf(second).felts.get(second.pid)!.rec;
    expect(now).toMatchObject({ v: 2, b: [red(25)] });
    expect(now.c).not.toBe(was);
    // The re-commit has nothing to do: the felt's commitment is fresh.
    frame(at + STEP, second);
    expect(slipsOf(second, 1, second.pid)).toHaveLength(2);
  });
});

describe('a new binding', () => {
  it("starts afresh: nothing of the last room's doc goes into the next", async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    frame(T0 + STEP, a);
    // The page moves to another doc whose table runs the same incarnation.
    const next = new Y.Doc();
    next.clientID = 50;
    next.transact(() => {
      next.getMap('players').set(a.pid, { keyB64: a.pub, name: a.pid });
      next.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: CTX.inc });
      next.getMap('casinoComputed').set(`ses:${TABLE}:${CTX.inc}:g`, new Y.Map());
    });
    a.casino.bindCasinoDoc(next, CTX.room);
    for (let T = T0 + 2 * STEP; T <= T0 + 5_000; T += STEP) frame(T, a);
    expect([...a.casino.computedSessionForWrite(TABLE)!.keys()]).toEqual([]);
    expect(a.table.readComputedRoulette(TABLE, T0 + 5_000)).toMatchObject({ phase: 'betting', round: 1 });
    expect(a.table.readComputedRoulette(TABLE, T0 + 5_000)!.phaseDeadline).toBeUndefined();
  });
});

describe('leaving and coming back', () => {
  const seedCtx1 = (p: Page) => ({ room: CTX.room, table: seedTable(CTX), round: 1, party: p.pid, house: '' });

  /** Page p back in the room on a fresh doc holding `from`'s state, as a
   *  rejoin binds one. */
  function rejoin(p: Page, from: Page, clientID: number): void {
    const next = new Y.Doc();
    next.clientID = clientID;
    Y.applyUpdate(next, Y.encodeStateAsUpdate(from.doc));
    p.casino.bindCasinoDoc(next, CTX.room);
    p.doc = next;
  }

  it("keeps this page's seeds through a frame on a destroyed doc (leaving the room): only a trim or an ended incarnation lets them go", async () => {
    const [a] = await room(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    frame(T0 + STEP, a);
    const c = foldOf(a).felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(c, seedCtx1(a))).not.toBeNull();
    // leaveRoom's sync.stop() destroys the doc; frames keep running.
    a.doc.destroy();
    frame(T0 + 2 * STEP, a);
    expect(a.fair.seedFor(c, seedCtx1(a))).not.toBeNull();
  });

  it('a player who stepped out and back during betting still reveals: every seed decides the round', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(20)], T0)).toBe('ok');
    run(pages, T0, T0 + 2_000, { step: STEP });
    // A leaves (its doc destroyed, a frame runs), and is back within the window.
    a.doc.destroy();
    frame(T0 + 2_200, a);
    rejoin(a, b, 77);
    const at = run(pages, T0 + 2_400, T0 + 60_000, { step: STEP, until: () => foldOf(b).rounds[0]?.decided != null });
    expect(at).toBeLessThan(T0 + 60_000);
    expect(foldOf(b).rounds[0]).toMatchObject({ present: [a.pid, b.pid].sort(), decided: 'reveals', counted: [a.pid, b.pid].sort() });
  });

  it('a switch gone for a moment (a peer deletes it, the house puts it back) keeps the open round’s seeds: it plays out on every seed', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(20)], T0)).toBe('ok');
    run(pages, T0, T0 + 2_000, { step: STEP });
    const c = foldOf(a).felts.get(a.pid)!.rec.c;
    b.doc.transact(() => b.doc.getMap('casino').delete(`cfg:computed:${TABLE}`));
    run(pages, T0 + 2_200, T0 + 3_000, { step: STEP });
    b.doc.transact(() => b.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: CTX.inc }));
    const at = run(pages, T0 + 3_200, T0 + 60_000, { step: STEP, until: () => foldOf(b).rounds[0]?.decided != null });
    expect(at).toBeLessThan(T0 + 60_000);
    expect(foldOf(b).rounds[0]).toMatchObject({ present: [a.pid, b.pid].sort(), decided: 'reveals' });
    expect(a.fair.seedFor(c, seedCtx1(a))).not.toBeNull();
  });
});
