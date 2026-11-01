/**
 * 🧮🎡 A computed table as the felt reads it (computedTable
 * readComputedRoulette, readComputedBets, readMyComputedBets,
 * computedRoundCheck): phases off the fold and this page's clock, in the
 * shape an owner-run table's state has.
 *
 * One page watches (computedPageKit) while test players (computedTestKit,
 * keys fixed by name) write every record by hand at chosen times: seeds,
 * pockets and turns are the same every run. The page never ticks unless a
 * spec says so: reading needs no duty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dutyRank, pocketOf, seedTable } from './computedFold';
import type { RoundView } from './computedFold';
import { loadPage, openRoom, PAGE_CTX as CTX, PAGE_TABLE as TABLE, putIn, sync, trimByHand } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, straight, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import { isRouletteTableState } from './games/roulette';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const kit = new ComputedKit(CTX);
const X = testIdentity('view-x', 'player-X');
const Y = testIdentity('view-y', 'player-Y');
const Z = testIdentity('view-z', 'player-Z');
/** Signs anything; nobody's pinned key. */
const G = testIdentity('view-g', 'player-G');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Page O, 1,000 chips, watching test players X, Y, Z (pinned). */
async function watch(): Promise<Page> {
  const [o] = await openRoom(['O'], T0);
  o.doc.transact(() => {
    for (const id of [X, Y, Z]) o.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
  return o;
}

/** Records into page p's live session, first seen at T. */
function putAt(p: Page, T: number, ...recs: Built<unknown>[]): void {
  vi.setSystemTime(T);
  putIn(p, recs.map((r): [string, unknown] => [r.key, r.rec]));
}

const view = (p: Page, now: number) => p.table.readComputedRoulette(TABLE, now)!;
const bets = (p: Page, round: number, now: number) => p.table.readComputedBets(TABLE, round, now);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const seedOf = (id: TestIdentity, r: number) => kit.seed(id.pid, r);
/** The pocket a round counting `ids`' default seeds lands on. */
const pocketFor = (r: number, ...ids: TestIdentity[]) =>
  pocketOf(CTX, r, [...ids].sort((a, b) => (a.pid < b.pid ? -1 : 1)).map((id) => seedOf(id, r)));
const payoutsOf = (D: RoundView) =>
  Object.fromEntries([...D.payouts].filter(([, n]) => n > 0n).map(([pid, n]) => [pid, Number(n)]));
/** A bet that loses on `pocket`. */
const loser = (pocket: number, amount: number) => (pocket === 0 || pocket % 2 === 1 ? straight((pocket + 1) % 37, amount) : straight(pocket - 1, amount));

describe('the phases', () => {
  it('betting unarmed, armed by the first chip seen, closing, settled for SHOW_MS from when it was seen decided, then betting unarmed', async () => {
    const o = await watch();
    const unarmed = { kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null, inc: CTX.inc, spinKey: '' };
    expect(view(o, T0)).toEqual(unarmed);
    expect(isRouletteTableState(view(o, T0))).toBe(true);
    // An empty felt arms nothing, nor a felt signed by a key not its player's.
    putAt(o, T0 + 1_000, kit.slip(X, 1, []));
    putAt(o, T0 + 1_500, kit.slip(G, 1, [red(9)], { p: Y.pid }));
    expect(view(o, T0 + 1_500)).toEqual(unarmed);
    expect(bets(o, 1, T0 + 1_500)).toEqual({});
    // The first chip seen arms the window; a later one doesn't move it.
    const pocket = pocketFor(1, X, Y);
    const y1 = kit.slip(Y, 1, [loser(pocket, 10)]);
    putAt(o, T0 + 2_000, y1);
    expect(view(o, T0 + 2_000)).toEqual({ ...unarmed, phaseDeadline: T0 + 20_000 });
    const x2 = kit.slip(X, 1, [straight(pocket, 5), loser(pocket, 1)], { v: 2 });
    putAt(o, T0 + 5_000, x2);
    expect(view(o, T0 + 5_000).phaseDeadline).toBe(T0 + 20_000);
    expect(bets(o, 1, T0 + 5_000)).toEqual({ [X.pid]: x2.rec.b, [Y.pid]: y1.rec.b });
    expect(bets(o, 2, T0 + 5_000)).toEqual({});
    // Closing: no deadline, the felts the close froze (not a version after it).
    putAt(o, T0 + 20_000, kit.close(X, 1, foldOf(o).parent, [x2, y1]));
    putAt(o, T0 + 20_100, kit.slip(Y, 1, [red(50)], { v: 2 }));
    expect(view(o, T0 + 20_100)).toEqual({ ...unarmed, phase: 'closing' });
    expect(bets(o, 1, T0 + 20_100)).toEqual({ [X.pid]: x2.rec.b, [Y.pid]: y1.rec.b });
    // Every seed in: settled from the last of them seen, the felt cleared.
    putAt(o, T0 + 20_500, kit.reveal(1, X.pid));
    expect(view(o, T0 + 20_500).phase).toBe('closing');
    putAt(o, T0 + 21_000, kit.reveal(1, Y.pid));
    const D = foldOf(o).rounds[0];
    expect(D).toMatchObject({ decided: 'reveals', pocket });
    const settled = view(o, T0 + 22_000);
    expect(settled).toEqual({
      ...unarmed, phase: 'settled', result: pocket, resultAt: T0 + 21_000, payouts: payoutsOf(D), spinKey: `1:${pocket}`,
    });
    expect(Object.keys(settled.payouts!)).toEqual([X.pid]);
    expect(settled.payouts![X.pid]).toBeGreaterThan(5);
    expect(isRouletteTableState(settled)).toBe(true);
    expect(bets(o, 1, T0 + 22_000)).toEqual({});
    expect(view(o, T0 + 21_000 + o.table.SHOW_MS - 1).phase).toBe('settled');
    // Then the next round, unarmed; the wheel's key stays (nothing to spin).
    expect(view(o, T0 + 21_000 + o.table.SHOW_MS)).toEqual({ ...unarmed, round: 2, spinKey: `1:${pocket}` });
  });

  it('a round a forfeit decided reads closing, its frozen felts on, until a second past the grace on this clock', async () => {
    const o = await watch();
    const slips = [X, Y, Z].map((id, i) => kit.slip(id, 1, [red(5 + i)]));
    putAt(o, T0, ...slips);
    const close = kit.close(X, 1, foldOf(o).parent, slips);
    const closeSeen = T0 + 18_000;
    putAt(o, closeSeen, close);
    putAt(o, closeSeen + 500, kit.reveal(1, X.pid));
    // Y's seed 3 s in stretches the grace to 4.5 s.
    putAt(o, closeSeen + 3_000, kit.reveal(1, Y.pid));
    putAt(o, closeSeen + 3_500, kit.forfeit(Y, 1, close.hash, [X.pid, Y.pid]));
    expect(foldOf(o).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [X.pid, Y.pid] });
    const held = view(o, closeSeen + 3_500);
    expect(held).toMatchObject({ phase: 'closing', round: 1, result: null, payouts: null, spinKey: '' });
    expect(held.phaseDeadline).toBeUndefined();
    expect(bets(o, 1, closeSeen + 3_500)).toEqual(Object.fromEntries(slips.map((s) => [s.rec.p, s.rec.b])));
    expect(view(o, closeSeen + 5_499).phase).toBe('closing');
    const shown = view(o, closeSeen + 5_500);
    const pocket = pocketFor(1, X, Y);
    expect(shown).toMatchObject({ phase: 'settled', round: 1, result: pocket, resultAt: closeSeen + 5_500, spinKey: `1:${pocket}` });
    expect(bets(o, 1, closeSeen + 5_500)).toEqual({});
    expect(view(o, closeSeen + 5_500 + o.table.SHOW_MS)).toMatchObject({ phase: 'betting', round: 2 });
  });

  it('shows a forfeit’s result from when the forfeit was seen, when that is after the grace', async () => {
    const o = await watch();
    const slips = [X, Y, Z].map((id) => kit.slip(id, 1, [red(5)]));
    putAt(o, T0, ...slips);
    const close = kit.close(X, 1, foldOf(o).parent, slips);
    putAt(o, T0 + 18_000, close);
    putAt(o, T0 + 18_500, kit.reveal(1, X.pid), kit.reveal(1, Y.pid));
    expect(view(o, T0 + 25_000).phase).toBe('closing');
    putAt(o, T0 + 26_000, kit.forfeit(X, 1, close.hash, [X.pid, Y.pid]));
    expect(view(o, T0 + 26_000)).toMatchObject({ phase: 'settled', resultAt: T0 + 26_000 });
  });

  it('times a seed by the reveal that opens it: a junk one seen earlier neither stretches the grace nor counts as in time', async () => {
    const o = await watch();
    const slips = [X, Y, Z].map((id) => kit.slip(id, 1, [red(5)]));
    putAt(o, T0, ...slips);
    const close = kit.close(Y, 1, foldOf(o).parent, slips);
    const closeSeen = T0 + 18_000;
    putAt(o, closeSeen, close);
    putAt(o, closeSeen + 500, kit.reveal(1, Y.pid));
    putAt(o, closeSeen + 3_500, kit.reveal(1, X.pid, 'ab'.repeat(32)));
    // And X's real seed under a key that isn't its own (the fold counts nothing there).
    putAt(o, closeSeen + 3_600, { key: `x:1:${X.pid}:${'cd'.repeat(16)}`, hash: '', rec: kit.reveal(1, X.pid).rec });
    putAt(o, closeSeen + 4_000, kit.forfeit(Y, 1, close.hash, [Y.pid]));
    putAt(o, closeSeen + 8_000, kit.reveal(1, X.pid));
    expect(foldOf(o).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [Y.pid], revealed: [X.pid, Y.pid] });
    expect(view(o, closeSeen + 8_000)).toMatchObject({ phase: 'settled', resultAt: closeSeen + 5_000 });
    expect(o.table.computedRoundCheck(TABLE, closeSeen + 8_000)).toMatchObject({ dropped: [], mine: null });
  });

  it('reads the phase as of a time a little before its last read (a clock stepped back under a second)', async () => {
    const o = await watch();
    const xs = kit.slip(X, 1, [red(5)]);
    putAt(o, T0, xs);
    putAt(o, T0 + 18_000, kit.close(X, 1, foldOf(o).parent, [xs]), kit.reveal(1, X.pid));
    const end = T0 + 18_000 + o.table.SHOW_MS;
    expect(view(o, end)).toMatchObject({ phase: 'betting', round: 2 });
    expect(view(o, end - 500)).toMatchObject({ phase: 'settled', round: 1 });
  });

  it('a void: settled with no pocket, every stake back, voided', async () => {
    const o = await watch();
    o.casino.buyInChips(X.pid, 100);
    const xs = kit.slip(X, 1, [red(30)]);
    putAt(o, T0, xs);
    expect(o.casino.readChips(X.pid)).toBe(70);
    const close = kit.close(X, 1, foldOf(o).parent, [xs]);
    putAt(o, T0 + 18_000, close);
    putAt(o, T0 + 19_000, kit.abandon(G, 1, close.hash));
    const v = view(o, T0 + 19_000);
    expect(v).toEqual({
      kind: 'roulette', phase: 'settled', round: 1, result: null, resultAt: T0 + 19_000, payouts: {}, voided: true,
      inc: CTX.inc, spinKey: '',
    });
    expect(isRouletteTableState(v)).toBe(true);
    expect(o.casino.readChips(X.pid)).toBe(100);
    expect(view(o, T0 + 19_000 + o.table.SHOW_MS)).toMatchObject({ phase: 'betting', round: 2 });
    expect(view(o, T0 + 19_000 + o.table.SHOW_MS).voided).toBeUndefined();
  });

  it("a chip seen during the show arms the next window from the show's end", async () => {
    const o = await watch();
    const xs = kit.slip(X, 1, [red(5)]);
    putAt(o, T0, xs);
    putAt(o, T0 + 18_000, kit.close(X, 1, foldOf(o).parent, [xs]));
    putAt(o, T0 + 18_200, kit.reveal(1, X.pid));
    const end = T0 + 18_200 + o.table.SHOW_MS;
    putAt(o, T0 + 20_000, kit.slip(Y, 2, [black(5)]));
    expect(view(o, T0 + 20_000)).toMatchObject({ phase: 'settled', round: 1 });
    expect(bets(o, 1, T0 + 20_000)).toEqual({});
    expect(bets(o, 2, T0 + 20_000)).toEqual({});
    expect(view(o, end)).toMatchObject({ phase: 'betting', round: 2, phaseDeadline: end + o.table.BET_WINDOW_MS });
  });

  it('a window that ran out with every chip taken down arms again on the next chip', async () => {
    const o = await watch();
    putAt(o, T0, kit.slip(X, 1, [red(5)]));
    putAt(o, T0 + 1_000, kit.slip(X, 1, [], { v: 2 }));
    expect(view(o, T0 + 17_999).phaseDeadline).toBe(T0 + 18_000);
    expect(view(o, T0 + 18_000).phaseDeadline).toBeUndefined();
    putAt(o, T0 + 25_000, kit.slip(Y, 1, [red(5)]));
    expect(view(o, T0 + 25_000).phaseDeadline).toBe(T0 + 43_000);
  });
});

describe('the felt', () => {
  it("shows this page's held felt (the coalescing) over its own, while betting only", async () => {
    const o = await watch();
    expect(o.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(o.table.writeComputedSlip(TABLE, [red(20)], T0 + 100)).toBe('ok');
    expect(o.table.readMyComputedBets(TABLE, o.pid, 1, T0 + 100)).toEqual([red(20)]);
    expect(bets(o, 1, T0 + 100)).toEqual({ [o.pid]: [red(10)] });
    expect(o.table.readMyComputedBets(TABLE, X.pid, 1, T0 + 100)).toEqual([]);
    expect(o.table.readMyComputedBets(TABLE, o.pid, 2, T0 + 100)).toEqual([]);
    // A close froze the written felt: the held one shows no more.
    const xs = kit.slip(X, 1, [red(1)]);
    putAt(o, T0 + 200, xs);
    const mine = foldOf(o).felts.get(o.pid)!;
    putAt(o, T0 + 250, kit.close(X, 1, foldOf(o).parent, { [X.pid]: xs.hash, [o.pid]: mine.hash }));
    expect(o.table.readMyComputedBets(TABLE, o.pid, 1, T0 + 250)).toEqual([red(10)]);
  });
});

describe('the wheel', () => {
  it("keeps its key across an honest rival close with the same pocket, and changes it when a round's pocket is rewritten", async () => {
    const o = await watch();
    const xs = kit.slip(X, 1, [red(5)]);
    const ys = kit.slip(Y, 1, [red(6)]);
    putAt(o, T0, xs, ys);
    // Both close at once, freezing the same felts; O hears the worse-ranked first.
    const [better, worse] = [X, Y].sort((a, b) => (dutyRank('close', CTX, 1, a.pub) < dutyRank('close', CTX, 1, b.pub) ? -1 : 1));
    const cWorse = kit.close(worse, 1, foldOf(o).parent, [xs, ys]);
    const cBetter = kit.close(better, 1, foldOf(o).parent, [xs, ys]);
    putAt(o, T0 + 18_000, cWorse);
    putAt(o, T0 + 18_500, kit.reveal(1, X.pid), kit.reveal(1, Y.pid));
    const key = `1:${pocketFor(1, X, Y)}`;
    expect(view(o, T0 + 18_500)).toMatchObject({ phase: 'settled', spinKey: key });
    putAt(o, T0 + 19_000, cBetter);
    expect(foldOf(o).rounds[0]).toMatchObject({ close: cBetter.hash, decided: 'reveals' });
    expect(view(o, T0 + 19_000)).toMatchObject({ phase: 'settled', spinKey: key });
  });

  it('a better-ranked forfeit counting a seed the first one dropped: a new pocket, a new key, the flag down', async () => {
    const o = await watch();
    const slips = [X, Y, Z].map((id) => kit.slip(id, 1, [red(5)]));
    putAt(o, T0, ...slips);
    const close = kit.close(X, 1, foldOf(o).parent, slips);
    const closeSeen = T0 + 18_000;
    putAt(o, closeSeen, close);
    putAt(o, closeSeen + 500, kit.reveal(1, X.pid), kit.reveal(1, Y.pid));
    const [better, worse] = [X, Y].sort((a, b) => (dutyRank('forfeit', CTX, 1, a.pub) < dutyRank('forfeit', CTX, 1, b.pub) ? -1 : 1));
    const first = pocketFor(1, worse);
    const fuller = pocketFor(1, X, Y);
    expect(first).not.toBe(fuller);
    putAt(o, closeSeen + 4_000, kit.forfeit(worse, 1, close.hash, [worse.pid]));
    expect(view(o, closeSeen + 5_000)).toMatchObject({ phase: 'settled', result: first, spinKey: `1:${first}` });
    expect(o.table.computedRoundCheck(TABLE, closeSeen + 5_000)).toMatchObject({ dropped: [better.pid], counted: 1, of: 3 });
    putAt(o, closeSeen + 6_000, kit.forfeit(better, 1, close.hash, [X.pid, Y.pid]));
    const v = view(o, closeSeen + 6_000);
    expect(v).toMatchObject({ phase: 'settled', result: fuller, spinKey: `1:${fuller}`, resultAt: closeSeen + 5_000 });
    expect(o.table.computedRoundCheck(TABLE, closeSeen + 6_000)).toMatchObject({ dropped: [], counted: 2, of: 3 });
  });
});

describe('the round check', () => {
  /** Round r on page o: X's felt and `withMe`'s (o's own felt, put down by
   *  o), closed by X freezing `frozen`, X's seed in. */
  function round(o: Page, r: number, T: number, opts: { mine?: boolean; frozen?: 'both' | 'x' } = {}) {
    const xs = kit.slip(X, r, [red(5)]);
    putAt(o, T, xs);
    if (opts.mine) {
      expect(o.table.writeComputedSlip(TABLE, [black(5)], T)).toBe('ok');
    }
    const f: Record<string, string> = { [X.pid]: xs.hash };
    if (opts.mine && opts.frozen !== 'x') f[o.pid] = foldOf(o).felts.get(o.pid)!.hash;
    const close = kit.close(X, r, foldOf(o).parent, f);
    putAt(o, T + 18_000, close, kit.reveal(r, X.pid));
    return close;
  }

  /** Page o's own seed for round r, revealed by hand at T. */
  function revealMine(o: Page, r: number, T: number): void {
    const D = foldOf(o).rounds.find((v) => v.r === r)!;
    const c = (o.casino.computedSessionForWrite(TABLE)!.get(`s:${r}:${o.pid}:${D.frozen[o.pid]}`) as { c: string }).c;
    const s = o.fair.seedFor(c, { room: CTX.room, table: seedTable(CTX), round: r, party: o.pid, house: '' })!;
    putAt(o, T, kit.reveal(r, o.pid, s));
  }

  it("says how the round was decided, seeds n of m, who's missing, who forfeited, and what became of this page's slip", async () => {
    const o = await watch();
    expect(o.table.computedRoundCheck(TABLE, T0)).toBeNull();
    // Round 1: O frozen, its seed never in: X forfeits it.
    const c1 = round(o, 1, T0, { mine: true });
    putAt(o, T0 + 23_000, kit.forfeit(X, 1, c1.hash, [X.pid]));
    expect(o.table.computedRoundCheck(TABLE, T0 + 23_000)).toEqual({
      round: 1, decided: 'forfeit', counted: 1, of: 2, missing: [], forfeitBy: X.pid, mine: 'forfeited', dropped: [],
      fair: false, houseDropped: [], houseVoid: false, houseWaited: [], pinMismatch: [], checkpointDiff: 0,
    });
    // Its seed after all, too late.
    revealMine(o, 1, T0 + 24_000);
    expect(o.table.computedRoundCheck(TABLE, T0 + 24_000)).toMatchObject({ round: 1, mine: 'late', counted: 1 });
    // Round 2: every seed in.
    round(o, 2, T0 + 40_000, { mine: true });
    revealMine(o, 2, T0 + 58_500);
    expect(o.table.computedRoundCheck(TABLE, T0 + 58_500)).toMatchObject({
      round: 2, decided: 'reveals', counted: 2, of: 2, forfeitBy: null, mine: 'frozen',
    });
    // Round 3: the close left O's felt out.
    round(o, 3, T0 + 80_000, { mine: true, frozen: 'x' });
    expect(o.table.computedRoundCheck(TABLE, T0 + 98_000)).toMatchObject({ round: 3, decided: 'reveals', counted: 1, of: 1, mine: 'left-out' });
    // Round 4: O's felt frozen, then voided; and a frozen pid the room never had.
    const xs = kit.slip(X, 4, [red(5)]);
    putAt(o, T0 + 120_000, xs);
    expect(o.table.writeComputedSlip(TABLE, [black(5)], T0 + 120_000)).toBe('ok');
    const c4 = kit.close(X, 4, foldOf(o).parent, { [X.pid]: xs.hash, [o.pid]: foldOf(o).felts.get(o.pid)!.hash, [Z.pid]: 'ab'.repeat(16) });
    putAt(o, T0 + 138_000, c4);
    putAt(o, T0 + 170_000, kit.abandon(G, 4, c4.hash));
    expect(o.table.computedRoundCheck(TABLE, T0 + 170_000)).toMatchObject({
      round: 4, decided: 'void', counted: 0, of: 3, missing: [Z.pid], mine: 'frozen', forfeitBy: null,
    });
    // Round 5: nothing of O's.
    round(o, 5, T0 + 200_000);
    expect(o.table.computedRoundCheck(TABLE, T0 + 218_000)).toMatchObject({ round: 5, mine: null });
  });

  it("flags a frozen slip its player's pinned key didn't sign", async () => {
    const o = await watch();
    const xs = kit.slip(X, 1, [red(5)]);
    const forged = kit.slip(G, 1, [red(500)], { p: Y.pid });
    putAt(o, T0, xs, forged);
    putAt(o, T0 + 18_000, kit.close(X, 1, foldOf(o).parent, [xs, forged]), kit.reveal(1, X.pid), kit.reveal(1, Y.pid));
    expect(o.table.computedRoundCheck(TABLE, T0 + 18_000)).toMatchObject({ decided: 'reveals', counted: 2, pinMismatch: [Y.pid] });
  });

  it('flags a checkpoint whose nets differ from what this page had folded, keeping its verdict through the trim; a page that never saw the round decided can’t tell', async () => {
    const o = await watch();
    // P has the slips, not the round's end.
    const p = await loadPage('P', 2);
    const xs = kit.slip(X, 1, [red(5)]);
    const ys = kit.slip(Y, 1, [black(5)]);
    putAt(o, T0, xs, ys);
    sync(T0, o, p);
    expect(view(p, T0)).toMatchObject({ phase: 'betting', round: 1 });
    putAt(o, T0 + 18_000, kit.close(X, 1, foldOf(o).parent, [xs, ys]), kit.reveal(1, X.pid), kit.reveal(1, Y.pid));
    const check = o.table.computedRoundCheck(TABLE, T0 + 18_000)!;
    expect(check).toMatchObject({ round: 1, checkpointDiff: 0 });
    const before = view(o, T0 + 19_000);
    expect(before.phase).toBe('settled');
    // A checkpoint off by 7 chips for X and 2 for a pid nobody had.
    const nets = Object.fromEntries(foldOf(o).nets);
    vi.setSystemTime(T0 + 19_000);
    trimByHand(o, G, { ...nets, [X.pid]: (nets[X.pid] ?? 0n) + 7n, 'player-Q': -2n });
    expect(foldOf(o).rounds).toEqual([]);
    expect(foldOf(o).base.u).toBe(1);
    expect(o.table.computedRoundCheck(TABLE, T0 + 19_000)).toEqual({ ...check, checkpointDiff: 9 });
    // The result stays on the felt through the trim.
    expect(view(o, T0 + 19_000)).toEqual(before);
    // The next round, decided in the new session, carries the flag on O; P,
    // which hadn't folded round 1 decided, can't tell.
    sync(T0 + 19_000, o, p);
    expect(foldOf(p).base.u).toBe(1);
    expect(p.table.computedRoundCheck(TABLE, T0 + 19_000)).toBeNull();
    const x2 = kit.slip(X, 2, [red(5)]);
    putAt(o, T0 + 30_000, x2);
    putAt(o, T0 + 48_000, kit.close(X, 2, foldOf(o).parent, [x2]), kit.reveal(2, X.pid));
    sync(T0 + 48_000, o, p);
    expect(o.table.computedRoundCheck(TABLE, T0 + 48_000)).toMatchObject({ round: 2, decided: 'reveals', checkpointDiff: 9 });
    expect(p.table.computedRoundCheck(TABLE, T0 + 48_000)).toMatchObject({ round: 2, decided: 'reveals', checkpointDiff: 0 });
  });

  it('opened only after a trim, still reads the round on the felt, and flags a checkpoint 9 chips off', async () => {
    const o = await watch();
    const xs = kit.slip(X, 1, [red(5)]);
    const ys = kit.slip(Y, 1, [black(5)]);
    putAt(o, T0, xs, ys);
    putAt(o, T0 + 18_000, kit.close(X, 1, foldOf(o).parent, [xs, ys]), kit.reveal(1, X.pid), kit.reveal(1, Y.pid));
    // The felt reads the table every frame; nobody has opened the ⚙ card yet.
    const before = view(o, T0 + 19_000);
    expect(before).toMatchObject({ phase: 'settled', round: 1 });
    const nets = Object.fromEntries(foldOf(o).nets);
    vi.setSystemTime(T0 + 19_000);
    trimByHand(o, G, { ...nets, [X.pid]: (nets[X.pid] ?? 0n) + 7n, 'player-Q': -2n });
    expect(foldOf(o).rounds).toEqual([]);
    expect(view(o, T0 + 19_000)).toEqual(before);
    expect(o.table.computedRoundCheck(TABLE, T0 + 19_000)).toMatchObject({ round: 1, decided: 'reveals', counted: 2, of: 2, checkpointDiff: 9 });
  });
});

describe('the getters', () => {
  it('are O(1): the same objects until the fold moves or a phase boundary passes', async () => {
    const o = await watch();
    const xs = kit.slip(X, 1, [red(5)]);
    putAt(o, T0, xs);
    const v = view(o, T0 + 100);
    const b = bets(o, 1, T0 + 100);
    expect(view(o, T0 + 5_000)).toBe(v);
    expect(bets(o, 1, T0 + 5_000)).toBe(b);
    expect(o.table.readComputedRoulette(TABLE, T0 + 17_999)).toBe(v);
    // The deadline passed: a fresh view, the same state.
    const after = view(o, T0 + 18_000);
    expect(after).not.toBe(v);
    expect(after).toEqual(v);
    // The fold moved.
    putAt(o, T0 + 18_100, kit.close(X, 1, foldOf(o).parent, [xs]));
    const closing = view(o, T0 + 18_100);
    expect(closing.phase).toBe('closing');
    expect(view(o, T0 + 25_000)).toBe(closing);
    putAt(o, T0 + 25_000, kit.reveal(1, X.pid));
    const check = o.table.computedRoundCheck(TABLE, T0 + 25_000);
    expect(o.table.computedRoundCheck(TABLE, T0 + 26_000)).toBe(check);
    // Not a computed table, or nothing counted: null, and no felt.
    expect(o.table.readComputedRoulette('roulette-2', T0)).toBeNull();
    expect(o.table.readComputedBets('roulette-2', 1, T0)).toEqual({});
    expect(o.table.computedRoundCheck('roulette-2', T0)).toBeNull();
  });
});
