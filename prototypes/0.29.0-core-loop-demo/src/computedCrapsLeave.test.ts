/**
 * 🎲🚪 Leaving a computed craps table (computedTable leaveComputedTables,
 * rideDuty's goodbye clause, backAtComputedTables): a rider's bets play on
 * whether or not their page is there, so a page leaving writes a goodbye
 * (`l: 1`) — the felt as it was before this roll's new chips, which go
 * back — instead of an empty felt, and writes nothing more there. A page
 * back at the table (a reload, the back-forward cache) writes the goodbye
 * again as its own felt, at its stand. A goodbye never opens a roll's
 * window, a roll everyone on it said goodbye to takes bets afresh at once,
 * and a close leaves out a goodbye that only rides, or one built on a table
 * that has since changed.
 *
 * Each page is its own load of the casino modules (computedPageKit); a
 * reload is a fresh load with the same player and key (loadPage reloadOf),
 * its doc filled from the room's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basisOf, own } from './computedCraps';
import { asClose, forfeitKey } from './computedFold';
import type { CloseRec, CrapsSlipRec } from './computedFold';
import {
  byRank, carryOf, clockOf, CRAPS_CTX as CTX, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, crapsPointOn, frame, keysIn, loadPage,
  openCrapsRoom, putIn, rigRoll, rigSplit, run, signAs, standAt, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
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
const slipsOf = (p: Page, r: number, pid: string): CrapsSlipRec[] =>
  keysIn(p, 's', r, TABLE).filter((k) => k.startsWith(`s:${r}:${pid}:`)).map((k) => recOf<CrapsSlipRec>(p, k))
    .sort((x, y) => x.v - y.v);
const latestOf = (p: Page, pid: string): CrapsSlipRec | undefined => foldOf(p).felts.get(pid)?.rec as CrapsSlipRec | undefined;
const go = (pages: Page[], from: number, to: number, until?: () => boolean): number =>
  run(pages, from, to, { step: STEP, tables: [REF], until });
const decide = (pages: Page[], r: number, from: number, to = from + 60_000): number =>
  go(pages, from, to, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === r && v.decided !== null)));
const closed = (p: Page, r: number) => (): boolean => keysIn(p, 'c', r, TABLE).length > 0;

/** Frames to a second into roll 2's betting, the riders' ride slips down:
 *  then, W and D, the end of its betting and of its wait. */
function openRoll2(pages: Page[], decidedAt: number) {
  const T = go(pages, decidedAt + STEP, decidedAt + 30_000, () => pages.every((p) => crapsOf(p)?.phaseDeadline !== undefined)) + 1_000;
  const W = crapsOf(pages[0], T)!.phaseDeadline!;
  return { T, W, D: W + WAIT_MS };
}

/** Page p's tab loaded again (same player, same key), its doc filled from
 *  `room`'s, its table session at `stand`. */
async function reload(p: Page, room: Page[], T: number, stand: number | null, clientID = 9): Promise<Page> {
  const q = await loadPage(`${p.name}'`, clientID, { reloadOf: p });
  standAt(q, stand);
  sync(T, q, ...room);
  return q;
}

/** A at stand 1 bets the pass line and a place 8 on roll 1, B at stand 3
 *  the pass line: a 6. The point is on; A's place 8 (off on the come-out)
 *  rides on with A's pass, B's pass with it; the dice are B's. */
async function placeEight() {
  const pages = await openCrapsRoom(['A', 'B'], T0);
  const [a, b] = pages;
  standAt(a, 1);
  standAt(b, 3);
  rigRoll(pages, 1, 6);
  expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8)], T0)).toBe('ok');
  expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
  sync(T0, ...pages);
  const decidedAt = decide(pages, 1, T0 + STEP);
  expect(carryOf(a)).toMatchObject({ p: 6, h: b.pid, i: 1 });
  expect(carryOf(a).w[a.pid]).toEqual([bet('pass', 10), bet('place', 6, 8)]);
  return { pages, decidedAt };
}

describe('the goodbye', () => {
  it("is the felt as it was before this roll's new chips, at the current stamp, with no stand: take-downs kept, new chips back", async () => {
    const { pages, decidedAt } = await placeEight();
    const [a, b] = pages;
    const { T } = openRoll2(pages, decidedAt);
    expect(latestOf(a, a.pid)).toMatchObject({ v: 1, b: [bet('pass', 10), bet('place', 6, 8)], t: 1 });
    // The place 8 comes down, a field bet goes up.
    expect(crapsBet(a, [bet('pass', 10), bet('field', 5)], T)).toBe('ok');
    sync(T, ...pages);
    expect(a.casino.readChips(a.pid)).toBe(985);
    a.table.leaveComputedTables(T + 500);
    const basis = basisOf(carryOf(a), a.pid);
    const bye = latestOf(a, a.pid)!;
    expect(bye).toMatchObject({ r: 2, v: 3, b: [bet('pass', 10)], o: basis, l: 1 });
    expect(bye.t).toBeUndefined();
    expect(a.casino.readChips(a.pid)).toBe(990);
    expect(a.table.readComputedCrapsBets(TABLE, 2, T + 500)[a.pid]).toEqual([bet('pass', 10)]);
    // For the leave's last frames, nothing more at the table from this page.
    expect(crapsBet(a, [bet('pass', 10), bet('field', 5)], T + 600)).toBe('closed');
    go(pages, T + 600, T + 2_000);
    expect(slipsOf(b, 2, a.pid)).toHaveLength(3);
    expect(latestOf(b, a.pid)).toMatchObject({ v: 3, l: 1 });
  });

  it("goes only over a version this page wrote (another tab of its player's holds the felt), and not with a close in", async () => {
    const { pages, decidedAt } = await placeEight();
    const [a, b] = pages;
    const { T, W, D } = openRoll2(pages, decidedAt);
    // A's other tab, never at the table: its leave writes nothing.
    const other = await loadPage("A'", 9, { reloadOf: a });
    sync(T, other, ...pages);
    frame(T, other, [REF]);
    other.table.leaveComputedTables(T + 100);
    expect(slipsOf(other, 2, a.pid)).toHaveLength(1);
    // B flings; with the close in, B's leave writes nothing.
    go(pages, T + STEP, W + 1_000);
    b.table.noteComputedFling(TABLE, 2, 9, W + 1_050);
    const at = go(pages, W + 1_200, D, () => closed(a, 2)() && closed(b, 2)());
    b.table.leaveComputedTables(at);
    expect(slipsOf(b, 2, b.pid)).toHaveLength(1);
  });

  it('never opens a window; once every felt with chips is a goodbye, the roll takes bets afresh at once', async () => {
    const { pages: [a], decidedAt } = await crapsPointOn(['A'], [1], T0);
    const c = await loadPage('C', 2);
    clockOf(c, decidedAt);
    c.casino.buyInChips(c.pid, 1_000);
    sync(decidedAt, a, c);
    const T = go([a, c], decidedAt + STEP, decidedAt + 30_000, () => crapsOf(c)?.phaseDeadline !== undefined);
    a.table.leaveComputedTables(T);
    sync(T, a, c);
    expect(latestOf(c, a.pid)).toMatchObject({ l: 1, b: [bet('pass', 10)] });
    // (Read as it comes in: the re-arm and the goodbye at one moment.)
    expect(crapsOf(c, T)).toMatchObject({ phase: 'betting', round: 2 });
    expect(crapsOf(c, T)!.phaseDeadline).toBeUndefined();
    go([c], T + STEP, T + 40_000);
    const v = crapsOf(c, T + 40_000)!;
    expect(v).toMatchObject({ phase: 'betting', round: 2, point: 6 });
    expect(v.phaseDeadline).toBeUndefined();
    expect(c.table.readComputedCrapsBets(TABLE, 2, T + 40_000)).toEqual({ [a.pid]: [bet('pass', 10)] });
    // A chip of C's opens it.
    expect(crapsBet(c, [bet('field', 5)], T + 40_000 + STEP)).toBe('ok');
    expect(crapsOf(c, T + 40_000 + STEP)!.phaseDeadline).toBe(T + 40_000 + STEP + W_MS);
  });

  it('is left out of a close when it only rides; one that takes chips down is frozen, and its take-down stands though its seed never comes', async () => {
    const { pages, decidedAt } = await placeEight();
    const [a, b] = pages;
    const { T } = openRoll2(pages, decidedAt);
    // A takes its place 8 down and leaves; B, holding the dice, leaves as it rode.
    expect(crapsBet(a, [bet('pass', 10)], T)).toBe('ok');
    a.table.leaveComputedTables(T + 400);
    b.table.leaveComputedTables(T + 400);
    const c = await loadPage('C', 3);
    clockOf(c, T + 400);
    c.casino.buyInChips(c.pid, 1_000);
    sync(T + 400, a, b, c);
    expect(latestOf(c, a.pid)).toMatchObject({ l: 1, b: [bet('pass', 10)] });
    expect(latestOf(c, b.pid)).toMatchObject({ l: 1, b: [bet('pass', 5)] });
    rigRoll([c], 2, 9);
    // C's own bet keeps the roll going (its window is C's own); C closes.
    const open = go([c], T + 400 + STEP, T + 30_000, () => crapsOf(c)?.phase === 'betting');
    expect(crapsBet(c, [bet('field', 5)], open)).toBe('ok');
    const at = go([c], open + STEP, open + 90_000, closed(c, 2));
    expect(at).toBeGreaterThan(open + W_MS);
    const [close] = closesOf(c, 2);
    expect(Object.keys(close.f).sort()).toEqual([a.pid, c.pid].sort());
    decide([c], 2, at + STEP);
    const R = foldOf(c).rounds.find((v) => v.r === 2)!;
    expect(R.decided).toBe('forfeit');
    // A's take-down stood: the place 8 is back with A; B's pass rides on.
    expect(carryOf(c).w[a.pid]).toEqual([bet('pass', 10)]);
    expect(carryOf(c).w[b.pid]).toEqual([bet('pass', 5)]);
    expect(c.casino.readChips(a.pid)).toBe(990);
  });

  it('is left out of a close when the roll before was rewritten under it: it plays as the riding bets, its take-down undone', async () => {
    // Roll 1: A's pass and place 8 at stand 1, B's pass at stand 3. Both
    // seeds make a 6; A's alone an 8. A ranks first for roll 1's forfeit,
    // so no forfeit of B's page beats A's.
    let pages: Page[];
    do pages = await openCrapsRoom(['A', 'B'], T0);
    while (byRank(pages, 'forfeit', 1, CTX)[0] !== pages[0]);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigSplit(pages, 1, 6, a, 8);
    expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(a).p).toBe(6);
    rigRoll([b], 2, 9);
    const { T } = openRoll2(pages, decidedAt);
    // A takes its place 8 down and leaves: a goodbye that takes chips down.
    expect(crapsBet(a, [bet('pass', 10)], T)).toBe('ok');
    a.table.leaveComputedTables(T + 400);
    sync(T + 400, a, b);
    const bye = latestOf(b, a.pid)!;
    expect(bye).toMatchObject({ l: 1, b: [bet('pass', 10)], o: basisOf(carryOf(b), a.pid) });
    // Then A's forfeit of roll 1 counts A's seed alone: the point is an 8,
    // B's pass lost, and A's goodbye is built on a table that is no more.
    clockOf(b, T + 600);
    const f = signAs(a, 'forfeit', { r: 1, x: foldOf(b).rounds[0].close, n: [a.pid] }, CTX);
    putIn(b, [[forfeitKey(f)!, f]], TABLE);
    expect(foldOf(b).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [a.pid] });
    expect(carryOf(b).p).toBe(8);
    expect(own(carryOf(b).w, b.pid)).toEqual([]);
    expect(bye.o).not.toBe(basisOf(carryOf(b), a.pid));
    // B bets once it has shown roll 1 again, and closes the roll without A's goodbye.
    const open = go([b], T + 600 + STEP, T + 30_000, () => crapsOf(b)?.phase === 'betting' && crapsOf(b)?.round === 2);
    expect(crapsBet(b, [bet('field', 5)], open)).toBe('ok');
    const at = go([b], open + STEP, open + 90_000, closed(b, 2));
    const [close] = closesOf(b, 2);
    expect(Object.keys(close.f)).toEqual([b.pid]);
    decide([b], 2, at + STEP);
    const R = foldOf(b).rounds.find((v) => v.r === 2)!;
    expect(R).toMatchObject({ decided: 'reveals', counted: [b.pid] });
    expect(R.craps!.dice!.reduce((x, d) => x + d, 0)).toBe(9);
    // A's bets played as they rode: the place 8 is still A's.
    expect(own(carryOf(b).w, a.pid)).toEqual([bet('pass', 10), bet('place', 6, 8)]);
    expect(b.casino.readChips(a.pid)).toBe(984);
    expect(b.casino.readChips(b.pid)).toBe(1_000);
  });
});

describe('back at the table', () => {
  it('a reload writes the goodbye again as its own felt at its stand, at once, its own show on screen: take-downs kept, no chip moved, the new chips not back on', async () => {
    const { pages, decidedAt } = await placeEight();
    const [a, b] = pages;
    const { T } = openRoll2(pages, decidedAt);
    expect(crapsBet(a, [bet('pass', 10)], T)).toBe('ok');
    expect(crapsBet(a, [bet('pass', 10), bet('field', 5)], T + 400)).toBe('ok');
    a.table.leaveComputedTables(T + 800);
    sync(T + 800, a, b);
    expect(latestOf(b, a.pid)).toMatchObject({ v: 4, l: 1, b: [bet('pass', 10)] });
    const a2 = await reload(a, [b], T + 1_000, 1);
    frame(T + 1_000, a2, [REF]);
    expect(crapsOf(a2, T + 1_000)).toMatchObject({ phase: 'settled', round: 1 });
    const back = latestOf(a2, a.pid)!;
    expect(back).toMatchObject({ r: 2, v: 5, b: [bet('pass', 10)], o: basisOf(carryOf(a2), a.pid), t: 1 });
    expect(back.l).toBeUndefined();
    sync(T + 1_000, a2, b);
    for (const p of [a2, b]) expect(p.casino.readChips(a.pid)).toBe(990);
    expect(b.table.readComputedCrapsBets(TABLE, 2, T + 1_000)[a.pid]).toEqual([bet('pass', 10)]);
  });

  it('back from the back-forward cache, the same: its frames write the goodbye again; its writes go again', async () => {
    const { pages, decidedAt } = await placeEight();
    const [a, b] = pages;
    const { T } = openRoll2(pages, decidedAt);
    a.table.leaveComputedTables(T);
    expect(latestOf(a, a.pid)).toMatchObject({ v: 2, l: 1 });
    go(pages, T + STEP, T + 1_000);
    expect(latestOf(a, a.pid)).toMatchObject({ v: 2, l: 1 });
    a.table.backAtComputedTables();
    go(pages, T + 1_000 + STEP, T + 1_000 + STEP);
    expect(latestOf(b, a.pid)).toMatchObject({ v: 3, b: [bet('pass', 10), bet('place', 6, 8)], t: 1 });
    expect(latestOf(b, a.pid)!.l).toBeUndefined();
    expect(crapsBet(a, [bet('pass', 10)], T + 2_000)).toBe('ok');
  });

  it('a holder reloaded during the wait is back at their stand at once; the roll closes in the others’ turn, their seed and stand counted', async () => {
    const { pages, decidedAt } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a, b] = pages;
    rigRoll(pages, 2, 8);
    const aSeed = a.seeds[0];
    const { T, W, D } = openRoll2(pages, decidedAt);
    go(pages, T, W + 2_000);
    b.table.leaveComputedTables(W + 2_000);
    sync(W + 2_000, a, b);
    expect(crapsOf(a, W + 2_000)).toMatchObject({ phase: 'closing', shooterSlip: 'gone' });
    const b2 = await reload(b, [a], W + 2_100, 3);
    // (Its seed store is new: the rewrite goes under a fresh seed.)
    rigRoll([b2], 2, 8, [aSeed]);
    go([a, b2], W + 2_200, W + 2_200);
    expect(latestOf(a, b.pid)).toMatchObject({ b: [bet('pass', 5)], t: 3 });
    expect(crapsOf(a, W + 2_200)).toMatchObject({ phase: 'closing', phaseDeadline: D, shooterSlip: 'here' });
    const at = go([a, b2], W + 2_400, D + 10_000, () => closed(a, 2)() || closed(b2, 2)());
    expect(at).toBeGreaterThanOrEqual(D);
    expect(at).toBeLessThan(D + STAGGER + STEP);
    expect(closesOf(a, 2).map((c) => c.k)).toEqual([a.pub]);
    decide([a, b2], 2, at + STEP);
    const R = foldOf(a).rounds.find((v) => v.r === 2)!;
    expect(R.decided).toBe('reveals');
    expect(R.counted).toEqual([a.pid, b.pid].sort());
    // B was counted at their stand: no seven-out, they keep the dice.
    expect(carryOf(a)).toMatchObject({ p: 6, h: b.pid, i: 1 });
  });

  it('on a come-out, a holder whose only bet was new loses the dice to a reload: the goodbye handed it back', async () => {
    // Roll 1: a natural, both passes paid; the dice are B's (stand 3).
    const pages = await openCrapsRoom(['A', 'B'], T0);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll(pages, 1, 7);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(carryOf(a)).toMatchObject({ p: 0, h: b.pid, i: 1 });
    expect(Object.keys(carryOf(a).w)).toEqual([]);
    const showEnd = crapsOf(a, decidedAt)!.resultAt + SHOW;
    go(pages, decidedAt + STEP, showEnd + 1_000);
    expect(crapsBet(a, [bet('pass', 10)], showEnd + 1_000)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], showEnd + 1_000)).toBe('ok');
    sync(showEnd + 1_000, ...pages);
    b.table.leaveComputedTables(showEnd + 2_000);
    sync(showEnd + 2_000, ...pages);
    expect(latestOf(a, b.pid)).toMatchObject({ l: 1, b: [] });
    const b2 = await reload(b, [a], showEnd + 2_200, 3);
    go([a, b2], showEnd + 2_200, showEnd + 2_200);
    expect(latestOf(a, b.pid)).toMatchObject({ b: [], t: 3 });
    expect(latestOf(a, b.pid)!.l).toBeUndefined();
    const at = go([a, b2], showEnd + 2_400, showEnd + 90_000, closed(a, 2));
    expect(closesOf(a, 2)[0].f[b.pid]).toBeUndefined();
    decide([a, b2], 2, at + STEP);
    // B had no bet down on the come-out: the dice go on round the ring, to A.
    expect(carryOf(a).h).toBe(a.pid);
  });

  it("a lone shooter's reload: the roll takes bets afresh, and the shooter, back, throws it", async () => {
    const { pages: [a], decidedAt } = await crapsPointOn(['A'], [1], T0);
    const c = await loadPage('C', 2);
    clockOf(c, decidedAt);
    c.casino.buyInChips(c.pid, 1_000);
    sync(decidedAt, a, c);
    const { T } = openRoll2([a, c], decidedAt);
    a.table.leaveComputedTables(T);
    sync(T, a, c);
    expect(crapsOf(c, T)).toMatchObject({ phase: 'betting', round: 2 });
    expect(crapsOf(c, T)!.phaseDeadline).toBeUndefined();
    frame(T + STEP, c, [REF]);
    const a2 = await reload(a, [c], T + 1_000, 1);
    const R2 = T + 1_000;
    go([a2, c], R2, R2);
    expect(latestOf(c, a.pid)).toMatchObject({ b: [bet('pass', 10)], t: 1 });
    // On C's page the window opens at the rewrite: not at the goodbye before it.
    expect(crapsOf(c, R2)).toMatchObject({ phase: 'betting', round: 2, phaseDeadline: R2 + W_MS });
    // A new window from the rewrite, on each page's clock; A's wait, A's fling.
    const W = go([a2, c], R2 + STEP, R2 + 60_000, () => crapsOf(a2)?.phase === 'closing' && crapsOf(a2)?.phaseDeadline !== undefined);
    expect(crapsOf(a2, W)).toMatchObject({ round: 2, shooter: a.pid, shooterSlip: 'here' });
    a2.table.noteComputedFling(TABLE, 2, 3, W + 50);
    const at = go([a2, c], W + STEP, W + 5_000, closed(c, 2));
    expect(closesOf(c, 2)[0].k).toBe(a.pub);
    decide([a2, c], 2, at + STEP);
    expect(foldOf(c).rounds.find((v) => v.r === 2)).toMatchObject({ decided: 'reveals', counted: [a.pid] });
  });
});
