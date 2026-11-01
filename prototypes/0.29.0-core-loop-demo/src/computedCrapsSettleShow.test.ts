/**
 * 💰 The settle's chip moves at a COMPUTED craps table (nobody runs it: each
 * page shows the fold of the players' records), on two pages: both play the
 * same moves from the shared result, once a roll (losers into the house,
 * the winner paid out of it onto their rail), and the winner's rail shows
 * the payout only once its chips have landed there, even when the credit
 * reaches the page between its frames or before its player steps up to the
 * table; a payout a forfeit takes back while its chips are on their way
 * leaves the rail at the balance; a roll rewritten by a forfeit plays its
 * new decision, on the pages that saw it before a result. And at an owner-run table, across two pages:
 * a settle that reaches a page out of order still plays there.
 *
 * Built on the kits computedCrapsTable.test.ts uses (computedPageKit,
 * computedCrapsUiKit): each page its own load of the casino modules, synced
 * by hand, every clock explicit, its dice chosen through the seeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forfeitKey } from './computedFold';
import {
  byRank, clockOf, CRAPS_CTX as CTX, CRAPS_INC as INC, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, putIn, rigRoll,
  rigSplit, signAs, standAt, switchOn, sync, deliver, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { atCraps, loadUIPage, stubDom } from './computedCrapsUiKit';
import type { UIPage } from './computedCrapsUiKit';
import type { RailStack, SettleMoves } from './casinoTable3d';
import type { CrapsBet } from './games/craps';

stubDom();

const T0 = 2_000_000_000;
const STEP = 200;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function room(names: string[]): Promise<UIPage[]> {
  const pages: UIPage[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadUIPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  switchOn(pages[0], TABLE, INC);
  sync(T0, ...pages);
  return pages;
}

/** One frame of page p at T, as computedCrapsTable.test.ts runs one. */
function frameOf(p: UIPage, T: number): void {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  p.table.tickComputedTables([REF], now);
  p.session.casinoTablesFrame(1 / 60, new Map([[TABLE, p.dice.h]]));
  p.at?.update();
}

function go(pages: UIPage[], from: number, to: number, until?: () => boolean): number {
  for (let T = from; T <= to; T += STEP) {
    sync(T, ...pages);
    for (const p of pages) frameOf(p, T);
    sync(T, ...pages);
    if (until?.()) return T;
  }
  return to + STEP;
}

const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const bet = (type: CrapsBet['type'], amount: number): CrapsBet => ({ type, amount });
const railTotal = (rail: readonly RailStack[]): number => rail.reduce((a, s) => a + s.denom * s.count, 0);

/** A settle's moves with whose-screen-it-is taken out: what every page
 *  must agree on. */
const shared = (m: SettleMoves) => ({
  house: m.house,
  lost: m.lost.map(({ x, z, chips, pid, spot, lift }) => ({ x, z, chips, pid, spot, lift })),
  back: m.back.map(({ s, to, order }) => ({ x: s.x, z: s.z, chips: s.chips, pid: s.pid, spot: s.spot, to, order })),
  paid: m.paid.map(({ chips, to, order }) => ({ chips, to, order })),
});

describe('💰 the settle on screen at a computed craps table', () => {
  it('both pages play the same moves once: B’s don’t pass to the house, A’s pass line back with its winnings; A’s rail grows as they land', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 3 });
    const tb = atCraps(b, { stand: 1 });
    go(pages, T0, T0 + STEP);
    rigRoll(pages, 1, 7);
    ta.pick('2', 2);
    ta.click('pass');
    tb.pick('2');
    tb.click('dontpass');
    // Up to the roll's result on both pages, A's rail as it shows then.
    let railBefore = -1;
    const at = go(pages, T0 + 2 * STEP, T0 + 120_000, () => {
      const decided = pages.every((p) => foldOf(p).rounds.some((v) => v.r === 1 && v.decided !== null));
      if (!decided && a.dice.settles.length === 0) railBefore = railTotal(a.dice.rail());
      return a.dice.settles.length > 0 && b.dice.settles.length > 0;
    });
    expect(at).toBeLessThan(T0 + 120_000);
    expect(a.dice.settles).toHaveLength(1);
    expect(b.dice.settles).toHaveLength(1);
    const [ma] = a.dice.settles;
    const [mb] = b.dice.settles;
    expect(shared(ma)).toEqual(shared(mb));
    expect(ma.lost.map((s) => [s.pid, s.spot, s.chips])).toEqual([[b.pid, 'dontpass:', [5]]]);
    expect(ma.back.map((x) => [x.s.pid, x.s.spot, x.s.chips])).toEqual([[a.pid, 'pass:', [5, 5]]]);
    expect(ma.paid.map((x) => x.chips)).toEqual([[5, 5]]);
    // Whose screen: A's chips are A's own on A's page, another's on B's.
    expect([ma.back[0].mine, ma.paid[0].mine, ma.paid[0].dim]).toEqual([true, true, false]);
    expect([mb.back[0].mine, mb.paid[0].mine, mb.paid[0].dim]).toEqual([false, false, true]);
    expect(ma.lost[0].dim).toBe(true);
    expect(mb.lost[0].dim).toBe(false);
    // A's rail holds what it had while the chips are on the way…
    expect(railBefore).toBeGreaterThan(0);
    expect(railTotal(a.dice.rail())).toBe(railBefore);
    // …and takes them once they've landed (the pieces' pay-out done).
    go(pages, at + STEP, at + 3 * STEP);
    expect(railTotal(a.dice.rail())).toBe(railBefore + 20);
    // Nothing plays twice, however long the show runs.
    go(pages, at + 4 * STEP, at + 10_000);
    expect(a.dice.settles).toHaveLength(1);
    expect(b.dice.settles).toHaveLength(1);
    ta.unmount();
    tb.unmount();
  });

  it('a credit that lands between my frames, before any frame here saw the roll close, still waits for its chips (even before my table’s first frame; chips I spend before or after the credit come off at once)', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 3);
    standAt(b, 1);
    rigRoll(pages, 1, 7);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('dontpass', 5)], T0)).toBe('ok');
    // Both felts written, betting still open on both pages.
    go(pages, T0 + STEP, T0 + 3 * STEP);
    expect(crapsOf(a)?.phase).toBe('betting');
    // A steps up to the table now: no frame of A's table yet.
    const ta = atCraps(a, { stand: 3 });
    expect(railTotal(a.dice.rail())).toBe(a.casino.readChips(a.pid));
    // …and spends 5 chips elsewhere (the slot machine): the rail shows them
    // gone at once, and holds that.
    expect(a.casino.spendChips(a.pid, 5)).toBe(true);
    const chipsBefore = a.casino.readChips(a.pid);
    const railBefore = railTotal(a.dice.rail());
    expect(railBefore).toBe(chipsBefore);
    // A's page keeps up its part of the table (its records) but draws no
    // frame until its balance has the payout: the close and the result
    // reach its rail through the doc's changes alone.
    let T = T0 + 4 * STEP;
    for (; T < T0 + 120_000 && a.casino.readChips(a.pid) === chipsBefore; T += STEP) {
      sync(T, ...pages);
      frameOf(b, T);
      const now = clockOf(a, T);
      a.croupier.noteTablesRunning(now);
      a.table.tickComputedTables([REF], now);
      sync(T, ...pages);
    }
    expect(a.casino.readChips(a.pid)).toBe(chipsBefore + 20);
    expect(crapsOf(a)?.phase).toBe('settled');
    expect(railTotal(a.dice.rail())).toBe(railBefore);
    // A spend now, the credit in: it comes off the rail at once.
    expect(a.casino.spendChips(a.pid, 5)).toBe(true);
    expect(railTotal(a.dice.rail())).toBe(railBefore - 5);
    // The show plays when A's frames come back, the rail held through it…
    const at = go(pages, T, T + 60_000, () => a.dice.settles.length > 0);
    expect(a.dice.settles).toHaveLength(1);
    expect(railTotal(a.dice.rail())).toBe(railBefore - 5);
    // …until A's chips have landed.
    go(pages, at + STEP, at + 3 * STEP);
    expect(railTotal(a.dice.rail())).toBe(railBefore + 15);
    ta.unmount();
  });

  it('stepping up to the table after the credit, while the chips are on their way: the rail holds what I had until they land', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 3);
    standAt(b, 1);
    rigRoll(pages, 1, 7);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('dontpass', 5)], T0)).toBe('ok');
    go(pages, T0 + STEP, T0 + 3 * STEP);
    const chipsBefore = a.casino.readChips(a.pid);
    // A's page runs (its table's pieces with it) but nobody is at its table
    // until the show is on, the payout already in A's balance.
    const at = go(pages, T0 + 4 * STEP, T0 + 120_000, () => a.dice.settles.length > 0);
    expect(at).toBeLessThan(T0 + 120_000);
    expect(a.casino.readChips(a.pid)).toBe(chipsBefore + 20);
    const ta = atCraps(a, { stand: 3 });
    expect(railTotal(a.dice.rail())).toBe(chipsBefore);
    go(pages, at + STEP, at + 3 * STEP);
    expect(railTotal(a.dice.rail())).toBe(chipsBefore + 20);
    ta.unmount();
  });

  it('a roll rewritten after the next one opened (a forfeit): both pages play its new decision from the felt as it played, once', async () => {
    const pages = await room(['A', 'B']);
    // w first to forfeit roll 1: both seeds throw a 6 (the point, nothing
    // moves), w's alone a 7 (a natural).
    const [w, x] = byRank(pages, 'forfeit', 1, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigSplit(pages, 1, 6, w, 7);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const tw = atCraps(w, { stand: 3 });
    const tx = atCraps(x, { stand: 1 });
    const decided = go(pages, T0 + STEP, T0 + 60_000, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === 1 && v.decided !== null)));
    expect(crapsOf(w)).toMatchObject({ phase: 'settled', round: 1, result: 6 });
    const open = go(pages, decided + STEP, decided + 60_000, () => pages.every((p) => crapsOf(p)?.round === 2 && crapsOf(p)?.phase === 'betting'));
    expect(open).toBeLessThan(decided + 60_000);
    // (The point: nothing moved.)
    for (const p of pages) expect(p.dice.settles).toEqual([]);
    clockOf(w, open + 100);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    const at = go(pages, open + STEP, open + 30_000, () => pages.every((p) => p.dice.settles.length > 0));
    expect(at).toBeLessThan(open + 30_000);
    // Roll 1 shown again on its new decision: w's pass line back with its
    // winnings; x, forfeited, paid nothing, so x's goes to the house.
    expect(crapsOf(x)).toMatchObject({ phase: 'settled', round: 1, result: 7, payouts: { [w.pid]: 20 } });
    for (const p of pages) {
      expect(p.dice.settles).toHaveLength(1);
      const [m] = p.dice.settles;
      expect(m.lost.map((s) => [s.pid, s.spot, s.chips])).toEqual([[x.pid, 'pass:', [5, 5]]]);
      expect(m.back.map((b) => [b.s.pid, b.s.spot, b.s.chips])).toEqual([[w.pid, 'pass:', [5, 5]]]);
      expect(m.paid.map((q) => q.chips)).toEqual([[5, 5]]);
    }
    expect(shared(w.dice.settles[0])).toEqual(shared(x.dice.settles[0]));
    // Nothing plays twice, however long it shows.
    go(pages, at + STEP, at + 10_000);
    for (const p of pages) expect(p.dice.settles).toHaveLength(1);
    tw.unmount();
    tx.unmount();
  });

  it('a payout taken back while its chips are on their way (a forfeit holds the roll again): my rail shows my balance, not the payout off it too', async () => {
    const pages = await room(['A', 'B']);
    // w first to forfeit roll 1: both seeds throw a 7 (a natural: x's pass
    // line paid), w's alone a 6 (the point).
    const [w, x] = byRank(pages, 'forfeit', 1, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigSplit(pages, 1, 7, w, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const tx = atCraps(x, { stand: 1 });
    const chipsBefore = x.casino.readChips(x.pid);
    const at = go(pages, T0 + STEP, T0 + 60_000, () => x.dice.settles.length > 0);
    expect(at).toBeLessThan(T0 + 60_000);
    expect(crapsOf(x)).toMatchObject({ phase: 'settled', round: 1, result: 7 });
    expect(x.casino.readChips(x.pid)).toBe(chipsBefore + 20);
    expect(railTotal(x.dice.rail())).toBe(chipsBefore);
    // w's forfeit, the chips still on their way: the roll held again, x's
    // payout taken back off x's balance.
    clockOf(w, at + 100);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(pages, at + STEP, at + STEP);
    expect(crapsOf(x)).toMatchObject({ phase: 'closing', round: 1 });
    expect(x.casino.readChips(x.pid)).toBe(chipsBefore);
    expect(railTotal(x.dice.rail())).toBe(chipsBefore);
    // …and through the hold, a spend of mine still comes off at once.
    expect(x.casino.spendChips(x.pid, 5)).toBe(true);
    go(pages, at + 2 * STEP, at + 3 * STEP);
    expect(crapsOf(x)?.phase).toBe('closing');
    expect(railTotal(x.dice.rail())).toBe(chipsBefore - 5);
    tx.unmount();
  });

  it('a roll shown, then held again for a forfeit and shown on a new decision: the pages that saw it played play it again from its felt; one that walked up after its result plays none of it', async () => {
    const pages = await room(['A', 'B']);
    // w first to forfeit roll 2. Roll 1 a 6 (the point); roll 2 an 8 from
    // both seeds (x's new field bet loses), a 7 from w's alone (seven out).
    const [w, x] = byRank(pages, 'forfeit', 2, CTX) as UIPage[];
    standAt(w, 3);
    standAt(x, 1);
    rigRoll(pages, 1, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const d1 = go(pages, T0 + STEP, T0 + 60_000, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === 1 && v.decided !== null)));
    rigSplit(pages, 2, 8, w, 7);
    const tw = atCraps(w, { stand: 3 });
    const tx = atCraps(x, { stand: 1 });
    const T = go(pages, d1 + STEP, d1 + 60_000, () => pages.every((p) => crapsOf(p)?.round === 2 && crapsOf(p)?.phase === 'betting')) + STEP;
    expect(crapsBet(x, [bet('pass', 10), bet('field', 5)], T)).toBe('ok');
    const d2 = go(pages, T + STEP, T + 120_000, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === 2 && v.decided !== null)));
    go(pages, d2 + STEP, d2 + 3 * STEP);
    for (const p of pages) {
      expect(crapsOf(p)).toMatchObject({ phase: 'settled', round: 2, result: 8 });
      expect(p.dice.settles.map((m) => m.lost.map((s) => [s.pid, s.spot]))).toEqual([[[x.pid, 'field:']]]);
    }
    // A third page looks in now, roll 2's result on screen.
    const c = await loadUIPage('C', 3);
    clockOf(c, d2 + 3 * STEP);
    const all = [...pages, c];
    go(all, d2 + 4 * STEP, d2 + 4 * STEP);
    expect(crapsOf(c)).toMatchObject({ phase: 'settled', round: 2, result: 8 });
    // w's forfeit of roll 2 before its result's grace is out: held for the
    // forfeit's show, then shown on the new dice.
    const F = d2 + 5 * STEP;
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 2, x: foldOf(w).rounds.find((v) => v.r === 2)!.close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    go(all, F + STEP, F + STEP);
    for (const p of all) expect(crapsOf(p)).toMatchObject({ phase: 'closing', round: 2 });
    const shown = go(all, F + 2 * STEP, F + 30_000, () => all.every((p) => crapsOf(p)?.phase === 'settled'));
    for (const p of all) expect(crapsOf(p)).toMatchObject({ phase: 'settled', round: 2, result: 7 });
    go(all, shown + STEP, shown + 10_000);
    // The seven out, from roll 2's felt as it played: everything to the house.
    for (const p of pages) {
      expect(p.dice.settles).toHaveLength(2);
      // (Bettors in player order: w and x drawn by rank, either way round.)
      const lost = p.dice.settles[1].lost.map((s) => [s.pid, s.spot, s.chips]);
      expect(lost).toEqual(lost.slice().sort((m, n) => (m[0]! < n[0]! ? -1 : m[0]! > n[0]! ? 1 : 0)));
      expect(lost).toEqual(expect.arrayContaining([[x.pid, 'field:', [5]], [x.pid, 'pass:', [5, 5]], [w.pid, 'pass:', [5, 5]]]));
      expect(lost).toHaveLength(3);
    }
    expect(shared(w.dice.settles[1])).toEqual(shared(x.dice.settles[1]));
    // C never saw roll 2 before a result of it: its hold lays no felt to
    // play from.
    expect(c.dice.settles).toEqual([]);
    tw.unmount();
    tx.unmount();
  });
});

describe('💰 the settle on screen at an owner-run craps table, across pages', () => {
  it('a settle that reaches a page out of order (the table reads as gone meanwhile) still plays there, from the felt as it played', async () => {
    const o = await loadUIPage('O', 1);
    const oc = await import('./crapsCroupier');
    const b = await loadUIPage('B', 2);
    for (const p of [o, b]) {
      clockOf(p, T0);
      p.casino.buyInChips(p.pid, 1_000);
    }
    o.casino.writeCrapsFairnessPref(TABLE, 'rng');
    oc.openCrapsBetting(TABLE, 1, null);
    sync(T0, o, b);
    expect(b.casino.writeMyCrapsBets(TABLE, b.pid, [bet('pass', 10)])).toBe(true);
    expect(o.casino.writeMyCrapsBets(TABLE, o.pid, [bet('dontpass', 5)])).toBe(true);
    sync(T0, o, b);
    oc.closeCrapsBetting(TABLE, o.casino.readCrapsTableState(TABLE)!);
    sync(T0, o, b);
    const frameB = (): void => b.session.casinoTablesFrame(1 / 60, new Map([[TABLE, b.dice.h]]));
    frameB();
    frameB();
    expect(b.dice.felt()).toHaveLength(2);
    // O's next writes: a note elsewhere, then the settle. B hears the settle
    // first, which it can't apply yet.
    const first = updatesOf(o, () => o.doc.getMap('elsewhere').set('n', 1));
    const rest: Uint8Array[] = [];
    const take = (u: Uint8Array): void => { rest.push(u); };
    o.doc.on('update', take);
    let n = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      (arr as unknown as Uint32Array)[0] = [3, 4][n++ % 2] - 1;
      return arr;
    });
    const s1 = o.casino.readCrapsTableState(TABLE)!;
    oc.rollAndSettleCraps(TABLE, s1.round, s1.point);
    for (let i = 0; i < 40 && o.casino.readCrapsTableState(TABLE)?.phase !== 'settled'; i++) await vi.advanceTimersByTimeAsync(1);
    o.doc.off('update', take);
    expect(o.casino.readCrapsTableState(TABLE)?.phase).toBe('settled');
    deliver(T0, b, rest);
    expect(b.casino.casinoWhole(TABLE)).toBe(false);
    expect(b.casino.readCrapsTableState(TABLE)?.phase).not.toBe('settled');
    frameB();
    frameB();
    deliver(T0, b, first);
    expect(b.casino.readCrapsTableState(TABLE)?.phase).toBe('settled');
    for (let i = 0; i < 6; i++) frameB();
    expect(b.dice.settles).toHaveLength(1);
    const [m] = b.dice.settles;
    expect(m.lost.map((x) => [x.pid, x.spot])).toEqual([[o.pid, 'dontpass:']]);
    expect(m.back.map((x) => [x.s.pid, x.s.spot, x.mine])).toEqual([[b.pid, 'pass:', true]]);
    expect(m.paid.map((x) => x.chips)).toEqual([[5, 5]]);
  });
});
