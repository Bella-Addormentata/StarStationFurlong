/**
 * 🎲⏳ A computed craps roll waiting for its shooter (computedTable
 * buildCraps, crapsCloseDue, rideDuty): once betting ends, a roll whose
 * dice the holder holds in play waits up to CRAPS_SHOOTER_MS for their
 * throw. Their page closes at its own fling (or at the end of the wait);
 * every other page only after it, in turn. Then the re-arms that let a
 * roll take bets again (everyone on it left, or nobody closed it), a
 * re-show of the roll before, a shooter back at their stand, and the
 * house's switch-off while the roll waits.
 *
 * Each page is its own load of the casino modules (computedPageKit), synced
 * by hand, every clock explicit, its table session standing where a spec
 * puts it (standAt), the dice chosen through the seeds (rigRoll).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asClose, forfeitKey } from './computedFold';
import type { CloseRec, CrapsSlipRec } from './computedFold';
import {
  byRank, carryOf, clockOf, CRAPS_CTX as CTX, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, crapsPointOn, deleteIn, frame,
  keysIn, loadPage, openCrapsRoom, openRoom, PAGE_CTX, PAGE_TABLE, putIn, rigRoll, rigSplit, run, send, signAs, standAt, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { red } from './computedTestKit';
import type { CrapsBet } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

// As in computedCrapsDuties: roulette's slip reader throws at a craps table.
vi.doMock('./computedFold', async (importOriginal) => {
  const real = await importOriginal<typeof import('./computedFold')>();
  const no = (): never => {
    throw new Error("roulette's slip reader at a craps table");
  };
  return { ...real, asSlip: no, slipKey: no };
});

const T0 = 2_000_000_000;
const STEP = 200;
const W_MS = 16_000;
const WAIT_MS = 20_000;
const SHOW = 6_000;
const STAGGER = 1_500;
const GRACE = 10_000;
const ABANDON = 30_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const bet = (type: CrapsBet['type'], amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r, TABLE).map((k) => asClose(recOf(p, k))!);
const latestOf = (p: Page, pid: string): CrapsSlipRec | undefined => foldOf(p).felts.get(pid)?.rec as CrapsSlipRec | undefined;
const go = (pages: Page[], from: number, to: number, until?: () => boolean): number =>
  run(pages, from, to, { step: STEP, tables: [REF], until });
const decide = (pages: Page[], r: number, from: number, to = from + 60_000): number =>
  go(pages, from, to, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === r && v.decided !== null)));
const closed = (p: Page, r: number) => (): boolean => keysIn(p, 'c', r, TABLE).length > 0;
const seedOf = (p: Page, r = 2): string[] => keysIn(p, 'x', r, TABLE).filter((k) => k.startsWith(`x:${r}:${p.pid}:`));
/** A duty due at `due` ran on the first tick at or after it. */
function expectAt(at: number, due: number): void {
  expect(at).toBeGreaterThanOrEqual(due);
  expect(at).toBeLessThan(due + STEP);
}

/** A at stand 1 and B at stand 3 (C at 5) make the point on roll 1, B
 *  holding the dice in play; then frames to a second into roll 2's
 *  betting, the riders' ride slips down. W and D: the end of roll 2's
 *  betting and of its wait. */
async function waiting(names = ['A', 'B'], stands: (number | null)[] = [1, 3, 5]) {
  const { pages, decidedAt, showEnd } = await crapsPointOn(names, stands, T0);
  return { pages, ...openRoll2(pages, decidedAt, showEnd) };
}
function openRoll2(pages: Page[], decidedAt: number, showEnd: number) {
  const T = go(pages, decidedAt + STEP, showEnd + 5_000, () => pages.every((p) => crapsOf(p)?.phaseDeadline !== undefined)) + STEP;
  const W = crapsOf(pages[0], T)!.phaseDeadline!;
  expect(W).toBe(showEnd + W_MS);
  return { T, W, D: W + WAIT_MS, showEnd };
}

describe('the wait for the throw', () => {
  it("the holder's page closes at the end of the wait without a fling; no page before it, and no felt goes down meanwhile", async () => {
    const { pages: [a, b], T, W, D } = await waiting();
    go([a, b], T, W + 1_000);
    for (const p of [a, b]) {
      expect(crapsOf(p, W + 1_000)).toMatchObject({
        phase: 'closing', round: 2, phaseDeadline: D, shooter: b.pid, shooterSlip: 'here', shooterNoBet: false,
      });
    }
    expect(crapsBet(a, [bet('pass', 10), bet('field', 5)], W + 1_000)).toBe('closed');
    const at = go([a, b], W + 1_000 + STEP, D + 10_000, closed(a, 2));
    expectAt(at, D);
    expect(closesOf(a, 2).map((c) => c.k)).toEqual([b.pub]);
  });

  it("a fling closes the roll on the holder's next tick, never before betting ends", async () => {
    const { pages: [a, b], T, W } = await waiting();
    go([a, b], T, W - 5_000);
    b.table.noteComputedFling(TABLE, 2, 9, W - 5_000 + 50);
    const at = go([a, b], W - 5_000 + STEP, W + 5_000, closed(a, 2));
    expectAt(at, W);
    expect(closesOf(a, 2).map((c) => c.k)).toEqual([b.pub]);
  });

  it("with the holder's page gone, the first page in turn among the others closes one turn after the end of the wait", async () => {
    const { pages, T, D } = await waiting(['A', 'B', 'C']);
    const [a, b, c] = pages;
    expect(carryOf(a)).toMatchObject({ h: b.pid, i: 1 });
    const [first] = byRank([a, c], 'close', 2, CTX);
    const at = go([a, c], T, D + 10_000, () => closed(a, 2)() || closed(c, 2)());
    expectAt(at, D + STAGGER);
    const [close] = closesOf(first, 2);
    expect(close.k).toBe(first.pub);
    expect(Object.keys(close.f).sort()).toEqual([a.pid, b.pid, c.pid].sort());
    go([a, c], at + STEP, at + 5_000);
    expect(closesOf(a, 2)).toHaveLength(1);
  });

  it("waits for a holder with no bet down too, offering their page no fling: every other page closes one turn after it", async () => {
    // Roll 1: A's pass at stand 1, B's field at stand 3. A 6: the point is
    // on, B's field lost, and the dice are B's.
    const pages = await openCrapsRoom(['A', 'B'], T0);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll(pages, 1, 6);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('field', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(a)).toMatchObject({ p: 6, h: b.pid, i: 1 });
    expect(Object.keys(carryOf(a).w)).toEqual([a.pid]);
    const showEnd = crapsOf(a, decidedAt)!.resultAt + SHOW;
    const { T, W, D } = openRoll2(pages, decidedAt, showEnd);
    go(pages, T, W + 1_000);
    expect(latestOf(a, b.pid)).toBeUndefined();
    expect(crapsOf(a, W + 1_000)).toMatchObject({ phase: 'closing', phaseDeadline: D, shooter: b.pid, shooterSlip: 'none', shooterNoBet: true });
    const mine = crapsOf(b, W + 1_000)!;
    expect(mine).toMatchObject({ phase: 'closing', phaseDeadline: D, holder: b.pid, shooterSlip: 'none' });
    expect(mine.shooter).toBeUndefined();
    const at = go(pages, W + 1_000 + STEP, D + 10_000, closed(a, 2));
    expectAt(at, D + STAGGER);
    expect(closesOf(a, 2).map((c) => c.k)).toEqual([a.pub]);
  });

  it('a close deleted during the wait, its author gone: the roll waits on, and closes again after it', async () => {
    const { pages: [a, b], T, W, D } = await waiting();
    go([a, b], T, W + 1_000);
    b.table.noteComputedFling(TABLE, 2, 9, W + 1_050);
    frame(W + 1_200, b, [REF]);
    expect(keysIn(b, 'c', 2, TABLE)).toHaveLength(1);
    // B's tab goes before its seed does; a peer deletes its close.
    send(W + 1_200, b, a);
    deleteIn(a, keysIn(a, 'c', 2, TABLE), TABLE);
    expect(crapsOf(a, W + 1_300)).toMatchObject({ phase: 'closing', phaseDeadline: D, shooterSlip: 'here' });
    const at = go([a], W + 1_400, D + 10_000, closed(a, 2));
    expectAt(at, D + STAGGER);
    expect(closesOf(a, 2).map((c) => c.k)).toEqual([a.pub]);
  });

  it("a close deleted after the wait, its seeds out: the roll stands down ABANDON_MS, then closes afresh on a fresh seed", async () => {
    const { pages: [a, b], T, D } = await waiting();
    const at = go([a, b], T, D + 5_000, closed(a, 2));
    expectAt(at, D);
    // A reveals; B's tab is gone before its seed goes.
    frame(at + STEP, a, [REF]);
    expect(keysIn(a, 'x', 2, TABLE)).toHaveLength(1);
    const was = latestOf(a, a.pid)!;
    deleteIn(a, keysIn(a, 'c', 2, TABLE), TABLE);
    const again = go([a], at + 2 * STEP, at + 90_000, closed(a, 2));
    expect(again).toBeGreaterThanOrEqual(at + 2 * STEP + ABANDON);
    const [close] = closesOf(a, 2);
    expect(close.k).toBe(a.pub);
    const frozen = recOf<CrapsSlipRec>(a, `s:2:${a.pid}:${close.f[a.pid]}`);
    expect(frozen.c).not.toBe(was.c);
    expect(frozen).toMatchObject({ v: was.v + 1, b: was.b, o: was.o, t: 1 });
  });
});

describe('the stand during the wait', () => {
  it('a shooter back at their stand while the roll waits is counted there: their version goes again with it at once, then their fling closes', async () => {
    const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a, b] = pages;
    standAt(b, null);
    rigRoll(pages, 2, 6);
    const { T, W, D } = openRoll2(pages, decidedAt, showEnd);
    go(pages, T, W + 2_000);
    expect(latestOf(a, b.pid)!.t).toBeUndefined();
    expect(crapsOf(a, W + 2_000)).toMatchObject({ phase: 'closing', shooter: b.pid, shooterSlip: 'away' });
    standAt(b, 3);
    go(pages, W + 2_000 + STEP, W + 2_000 + STEP);
    expect(latestOf(a, b.pid)).toMatchObject({ v: 2, b: [bet('pass', 5)], t: 3 });
    expect(crapsOf(a, W + 2_000 + STEP)).toMatchObject({ phase: 'closing', phaseDeadline: D, shooterSlip: 'here' });
    b.table.noteComputedFling(TABLE, 2, 9, W + 3_000);
    const at = go(pages, W + 2_000 + 2 * STEP, D + 10_000, closed(a, 2));
    // (No sooner than STAGGER_MS after its own felt changed.)
    expectAt(at, W + 2_000 + STEP + STAGGER);
    expect(closesOf(a, 2)[0].f[b.pid]).toBe(foldOf(a).tip!.frozen[b.pid]);
    decide(pages, 2, at + STEP);
    // Point made: the shooter, counted at their stand, keeps the dice.
    for (const p of pages) expect(carryOf(p)).toMatchObject({ p: 0, h: b.pid, i: 1 });
  });

  /** B, away from the table, holds the dice in play on roll 2: a field bet
   *  of B's goes down 3 s before W (at once), and B is back at stand 3
   *  within the coalescing of it, `then` run there (B's next tick, or
   *  another change). B's frames then stop until a second into the wait (a
   *  tab in the background); A's run on. B's first frame back, and the end
   *  of the wait. */
  async function backAcrossW(then: (b: Page, at: number) => void) {
    const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a, b] = pages;
    standAt(b, null);
    rigRoll(pages, 2, 6);
    const { T, W, D } = openRoll2(pages, decidedAt, showEnd);
    let L = T;
    while (L + STEP <= W - 3_000) L += STEP;
    go(pages, T, L);
    expect(latestOf(a, b.pid)!.t).toBeUndefined();
    expect(crapsBet(b, [bet('pass', 5), bet('field', 5)], L + 50)).toBe('ok');
    sync(L + 50, a, b);
    standAt(b, 3);
    then(b, L + STEP);
    expect(latestOf(b, b.pid)).toMatchObject({ b: [bet('field', 5), bet('pass', 5)] });
    expect(latestOf(b, b.pid)!.t).toBeUndefined();
    for (let t = L + STEP; t < W + 1_000; t += STEP) {
      sync(t, a, b);
      frame(t, a, [REF]);
    }
    return { pages, back: W + 1_000, D };
  }

  it("a stand held back with the coalescing when betting ended goes on the shooter's first tick of the wait: their frames stopped across W, they fling and keep the dice", async () => {
    const { pages: [a, b], back, D } = await backAcrossW((p, at) => frame(at, p, [REF]));
    expect(latestOf(a, b.pid)!.t).toBeUndefined();
    go([a, b], back, back);
    expect(latestOf(a, b.pid)).toMatchObject({ b: [bet('field', 5), bet('pass', 5)], t: 3 });
    expect(crapsOf(a, back)).toMatchObject({ phase: 'closing', shooter: b.pid, shooterSlip: 'here' });
    b.table.noteComputedFling(TABLE, 2, 9, back + 1_000);
    const at = go([a, b], back + STEP, D + 10_000, closed(a, 2));
    expect(at).toBeLessThan(D);
    go([a, b], at + STEP, at + STEP);
    expect(b.table.computedMine(TABLE, at + STEP)).toMatchObject({ frozen: true, tooLate: false });
    decide([a, b], 2, at + 2 * STEP);
    for (const p of [a, b]) expect(carryOf(p)).toMatchObject({ p: 0, h: b.pid, i: 1 });
  });

  it('so does one held back with a change of the felt, which then never goes: the close froze the felt before it, too late for it', async () => {
    const { pages: [a, b], back, D } = await backAcrossW((p, at) => expect(crapsBet(p, [bet('pass', 5), bet('field', 10)], at)).toBe('ok'));
    go([a, b], back, back);
    expect(latestOf(a, b.pid)).toMatchObject({ b: [bet('field', 5), bet('pass', 5)], t: 3 });
    b.table.noteComputedFling(TABLE, 2, 9, back + 1_000);
    const at = go([a, b], back + STEP, D + 10_000, closed(a, 2));
    expect(at).toBeLessThan(D);
    go([a, b], at + STEP, at + STEP);
    expect(b.table.computedMine(TABLE, at + STEP)).toMatchObject({ frozen: true, tooLate: true });
    decide([a, b], 2, at + 2 * STEP);
    // The point made, the dice B's: the pass's 5 won, the field's 5 lost
    // (the 10 never went down).
    for (const p of [a, b]) {
      expect(carryOf(p)).toMatchObject({ p: 0, h: b.pid, i: 1 });
      expect(p.casino.readChips(b.pid)).toBe(1_000);
    }
  });

  it("a change the holder makes within a turn of the wait's end gives their turn away: the next page closes, once, from what it heard", async () => {
    const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a, b] = pages;
    standAt(b, null);
    const { T, D } = openRoll2(pages, decidedAt, showEnd);
    go(pages, T, D - 1_000);
    standAt(b, 3);
    const at = go(pages, D - 1_000 + STEP, D + 10_000, closed(a, 2));
    expectAt(at, D + STAGGER);
    go(pages, at + STEP, at + 5_000);
    for (const p of pages) {
      expect(closesOf(p, 2).map((c) => c.k)).toEqual([a.pub]);
      expect(latestOf(p, b.pid) ?? recOf<CrapsSlipRec>(p, `s:2:${b.pid}:${closesOf(p, 2)[0].f[b.pid]}`)).toMatchObject({ t: 3 });
    }
  });
});

describe('the re-arms', () => {
  it('a roll nobody closes, its bettors gone: a page with no felt on it sees the turns pass, then betting again GRACE_MAX_MS after the last', async () => {
    const { pages, T } = await waiting();
    const c = await loadPage('C', 3);
    clockOf(c, T);
    c.casino.buyInChips(c.pid, 1_000);
    sync(T, ...pages, c);
    // A's and B's tabs crash: C runs alone, on its own clock of the roll
    // (it saw roll 1's result as it came in, and shows it its while).
    const opened = go([c], T + STEP, T + 30_000, () => crapsOf(c)?.phaseDeadline !== undefined);
    const W = crapsOf(c, opened)!.phaseDeadline!;
    expect(W).toBe(T + SHOW + W_MS);
    const D = W + WAIT_MS;
    const n = 2;
    const stall = D + (n + 1) * STAGGER;
    go([c], opened + STEP, D - STEP);
    expect(crapsOf(c, D - STEP)).toMatchObject({ phase: 'closing', phaseDeadline: D, shooter: pages[1].pid });
    go([c], D, stall - STEP);
    expect(crapsOf(c, stall - STEP)!.stallUntil).toBeUndefined();
    go([c], stall, stall);
    expect(crapsOf(c, stall)).toMatchObject({ phase: 'closing', round: 2, stallUntil: stall + GRACE });
    go([c], stall + STEP, stall + GRACE);
    const v = crapsOf(c, stall + GRACE)!;
    expect(v).toMatchObject({ phase: 'betting', round: 2, point: 6 });
    expect(v.phaseDeadline).toBeUndefined();
    // The riders' bets still ride; C's first chip opens a window.
    expect(c.table.readComputedCrapsBets(TABLE, 2, stall + GRACE)).toEqual({
      [pages[0].pid]: [bet('pass', 10)], [pages[1].pid]: [bet('pass', 5)],
    });
    expect(crapsBet(c, [bet('field', 5)], stall + GRACE + 1_000)).toBe('ok');
    expect(crapsOf(c, stall + GRACE + 1_000)).toMatchObject({ phase: 'betting', phaseDeadline: stall + GRACE + 1_000 + W_MS });
  });

  it('a page with a felt of its own on the roll never re-arms it: it closes in its turn', async () => {
    const { pages, T, D } = await waiting();
    const [a] = pages;
    const at = go([a], T, D + 30_000, closed(a, 2));
    expectAt(at, D + STAGGER);
    expect(crapsOf(a, at - STEP)!.stallUntil).toBeUndefined();
  });
});

describe('a re-show of the roll before', () => {
  it('at craps: a full window after it, and a fling made before it forgotten', async () => {
    const pages = await openCrapsRoom(['A', 'B'], T0);
    // w holds the dice before and after its forfeit rewrites roll 1 (both
    // seeds a 6, w's alone an 8): first in rank, at the ring's first stand.
    const [w, x] = byRank(pages, 'forfeit', 1, CTX);
    standAt(w, 3);
    standAt(x, 1);
    rigSplit(pages, 1, 6, w, 8);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(w)).toMatchObject({ p: 6, h: w.pid, i: 1 });
    const showEnd = crapsOf(w, decidedAt)!.resultAt + SHOW;
    const { T, W } = openRoll2(pages, decidedAt, showEnd);
    go(pages, T, W + 1_000);
    w.table.noteComputedFling(TABLE, 2, 9, W + 1_050);
    expect(w.table.computedFlungFor(TABLE)).toEqual({ r: 2, seed: 9 });
    // The rewrite lands before w's next tick.
    const F = W + 1_100;
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 1, x: foldOf(w).rounds[0].close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    sync(F, ...pages);
    go(pages, W + 1_200, W + 1_200);
    expect(keysIn(w, 'c', 2, TABLE)).toEqual([]);
    expect(w.table.computedFlungFor(TABLE)).toBeNull();
    for (const p of pages) {
      expect(crapsOf(p, W + 1_200)).toMatchObject({ phase: 'settled', round: 1, result: 8, point: 8 });
      expect(carryOf(p)).toMatchObject({ p: 8, h: w.pid, i: 1 });
    }
    const open = go(pages, W + 1_400, F + SHOW + 5_000, () => pages.every((p) => crapsOf(p)?.phase === 'betting'));
    for (const p of pages) expect(crapsOf(p, open)).toMatchObject({ phase: 'betting', round: 2, point: 8, phaseDeadline: F + SHOW + W_MS });
    // No close till w flings again, after the new window.
    const W2 = F + SHOW + W_MS;
    go(pages, open + STEP, W2 + 3_000);
    expect(keysIn(w, 'c', 2, TABLE)).toEqual([]);
    w.table.noteComputedFling(TABLE, 2, 10, W2 + 3_050);
    const at = go(pages, W2 + 3_200, W2 + 10_000, closed(x, 2));
    expect(at).toBeLessThan(W2 + 3_000 + 2_000);
  });

  it('at roulette: a full window after it', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const roulette = (p: Page, now?: number) => p.table.readComputedRoulette(PAGE_TABLE, now)!;
    const fold = (p: Page) => p.casino.computedFoldOf(PAGE_TABLE)!;
    const [w] = byRank(pages, 'forfeit', 1, PAGE_CTX);
    for (const p of pages) expect(p.table.writeComputedSlip(PAGE_TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => pages.every((p) => fold(p).rounds[0]?.decided === 'reveals') });
    const showEnd = roulette(w, decidedAt).resultAt + w.table.SHOW_MS;
    run(pages, decidedAt + STEP, showEnd + 2_000, { step: STEP });
    clockOf(w, showEnd + 2_000);
    expect(w.table.writeComputedSlip(PAGE_TABLE, [red(5)], showEnd + 2_000)).toBe('ok');
    sync(showEnd + 2_000, ...pages);
    expect(roulette(w, showEnd + 2_000).phaseDeadline).toBe(showEnd + 2_000 + w.table.BET_WINDOW_MS);
    const F = showEnd + 10_000;
    run(pages, showEnd + 2_000 + STEP, F - STEP, { step: STEP });
    clockOf(w, F);
    const f = signAs(w, 'forfeit', { r: 1, x: fold(w).rounds[0].close, n: [w.pid] });
    putIn(w, [[forfeitKey(f)!, f]]);
    sync(F, ...pages);
    for (const p of pages) expect(roulette(p, F + STEP)).toMatchObject({ phase: 'settled', round: 1 });
    const open = run(pages, F + STEP, F + 30_000, { step: STEP, until: () => pages.every((p) => roulette(p).phase === 'betting') });
    for (const p of pages) expect(roulette(p, open)).toMatchObject({ round: 2, phaseDeadline: F + w.table.SHOW_MS + w.table.BET_WINDOW_MS });
  });

  it("at roulette: the window kept with the only felt with chips deleted by a peer; at its end with none, betting waits for the next chip", async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const roulette = (p: Page, now?: number) => p.table.readComputedRoulette(PAGE_TABLE, now)!;
    expect(a.table.writeComputedSlip(PAGE_TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, a, b);
    const W = T0 + b.table.BET_WINDOW_MS;
    run([b], T0 + STEP, T0 + 5_000, { step: STEP });
    expect(roulette(b, T0 + 5_000).phaseDeadline).toBe(W);
    // A's tab is gone; a peer deletes its felt.
    deleteIn(b, keysIn(b, 's', 1));
    run([b], T0 + 5_000 + STEP, W - STEP, { step: STEP });
    expect(roulette(b, W - STEP)).toMatchObject({ phase: 'betting', round: 1, phaseDeadline: W });
    run([b], W, W + STEP, { step: STEP });
    expect(roulette(b, W + STEP).phaseDeadline).toBeUndefined();
    clockOf(b, W + 1_000);
    expect(b.table.writeComputedSlip(PAGE_TABLE, [red(5)], W + 1_000)).toBe('ok');
    expect(roulette(b, W + 1_000).phaseDeadline).toBe(W + 1_000 + b.table.BET_WINDOW_MS);
  });
});

describe('the switch-off while the roll waits', () => {
  const off = (p: Page, now: number, again = false) => p.table.switchComputedOff(TABLE, now, again);

  it("is refused while the holder's page can still throw (away from their stand, or at it); once the wait is over it warns of the riding bets, then hands every chip back", async () => {
    const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a, b] = pages;
    standAt(b, null);
    const { T, W, D } = openRoll2(pages, decidedAt, showEnd);
    go([a, b], T, W + 1_000);
    expect(crapsOf(a, W + 1_000)!.shooterSlip).toBe('away');
    expect(off(a, W + 1_000)).toBe('busy');
    expect(off(b, W + 1_000, true)).toBe('busy');
    standAt(b, 3);
    go([a, b], W + 1_000 + STEP, W + 2_000);
    expect(crapsOf(a, W + 2_000)!.shooterSlip).toBe('here');
    expect(off(a, W + 2_000)).toBe('busy');
    // B's tab is gone; past the wait, before A's turn.
    go([a], W + 2_000 + STEP, D + 400);
    expect(keysIn(a, 'c', 2, TABLE)).toEqual([]);
    expect(off(a, D + 400)).toBe('contract');
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(off(a, D + 400, true)).toBe('ok');
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    for (const pid of [a.pid, b.pid]) expect(a.casino.readChips(pid)).toBe(1_000);
  });

  it('goes during the wait for a holder with no version on the roll, or one saying goodbye (contract bets warned of first)', async () => {
    // No version: B's tab is gone since roll 1.
    {
      const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
      const [a, b] = pages;
      const T = go([a], decidedAt + STEP, showEnd + 5_000, () => crapsOf(a)?.phaseDeadline !== undefined);
      const W = crapsOf(a, T)!.phaseDeadline!;
      go([a], T + STEP, W + 1_000);
      expect(crapsOf(a, W + 1_000)).toMatchObject({ phase: 'closing', shooter: b.pid, shooterSlip: 'absent' });
      expect(off(a, W + 1_000)).toBe('contract');
      expect(off(a, W + 1_000, true)).toBe('ok');
    }
    // A goodbye: B leaves during the wait.
    {
      const { pages: [a, b], T, W } = await waiting();
      go([a, b], T, W + 1_000);
      b.table.leaveComputedTables(W + 1_000);
      sync(W + 1_000, a, b);
      expect(latestOf(a, b.pid)).toMatchObject({ l: 1, b: [bet('pass', 5)] });
      expect(crapsOf(a, W + 1_100)).toMatchObject({ phase: 'closing', shooterSlip: 'gone' });
      expect(off(a, W + 1_100)).toBe('contract');
      expect(off(a, W + 1_100, true)).toBe('ok');
    }
  });

  it('is refused with a close in, and while a forfeit holds the result back', async () => {
    const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a, b] = pages;
    // The page that stays forfeits the other's seed, first in turn: its
    // seed alone an 8.
    const [stay, gone] = byRank(pages, 'forfeit', 2, CTX);
    rigRoll([stay], 2, 8);
    const { T, W } = openRoll2(pages, decidedAt, showEnd);
    go(pages, T, W + 1_000);
    b.table.noteComputedFling(TABLE, 2, 9, W + 1_050);
    const at = go(pages, W + 1_200, W + 5_000, () => closed(a, 2)() && closed(b, 2)());
    expect(off(a, at, true)).toBe('busy');
    expect(seedOf(gone)).toEqual([]);
    const F = go([stay], at + STEP, at + 30_000, () => keysIn(stay, 'f', 2, TABLE).length > 0);
    expect(foldOf(stay).rounds.find((v) => v.r === 2)!.decided).toBe('forfeit');
    expect(crapsOf(stay, F)!.phase).toBe('closing');
    expect(off(stay, F, true)).toBe('busy');
    const shown = go([stay], F + STEP, F + 10_000, () => crapsOf(stay)?.phase === 'settled');
    expect(crapsOf(stay, shown)).toMatchObject({ round: 2, result: 8, point: 6 });
    expect(off(stay, shown)).toBe('contract');
  });
});
