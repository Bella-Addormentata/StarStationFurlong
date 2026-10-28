/**
 * 🧮🧹 Trimming a computed table, and compacting an ended one (computedTable
 * trimDuty and compactDuty; casinoDoc writeCheckpointAndTrim and
 * finalizeComputed): the session swapped for a checkpoint of the nets and a
 * fresh session with the open round's felts, in one transaction, by a page
 * whose turn it is, with nobody's chips moving.
 *
 * Each page is its own load of the casino modules with its own Y.Doc,
 * player id and identity key (computedPageKit), synced by hand, every clock
 * explicit. Who trims first is whoever dutyRank puts first for that page's
 * key (keys are fresh each run), so each spec works out the order from the
 * keys. Most specs make the trim due at once with junk the fold weighs and
 * never reads (a session past TRIM_BYTES); the idle trim, the room's budget
 * and the 20-round trim each have specs of their own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asCheckpoint, asClose, asSlip, nextSid, seedTable, slipCommit, slipKey } from './computedFold';
import type { Checkpoint, CloseRec, SlipRec } from './computedFold';
import {
  byRank, deleteIn, deliver, frame, keysIn, loadPage, openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_TABLE as TABLE,
  putIn, run, signAs, switchOn, sync, trimByHand, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, straight, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import { ROOM_STATE_WAIT_MS, TABLE_LEASE_LAPSE_MS } from './croupier';
import type { RouletteBet } from './games/roulette';

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

const room = (names: string[]): Promise<Page[]> => openRoom(names, T0);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const viewOf = (p: Page, now: number) => p.table.readComputedRoulette(TABLE, now);
const computedOf = (p: Page) => p.doc.getMap('casinoComputed');
const cpOf = (p: Page, t = TABLE, inc = INC): Checkpoint | null => asCheckpoint(computedOf(p).get(`sum:${t}:${inc}`));
const sessionsOf = (p: Page, t = TABLE, inc = INC): string[] =>
  [...computedOf(p).keys()].filter((k) => k.startsWith(`ses:${t}:${inc}:`)).sort();
const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)?.get(key) as T;
const chipsOn = (on: Page, pages: Page[]): number[] => pages.map((q) => on.casino.readChips(q.pid));
const signer = (pages: Page[], k: string): string | undefined => pages.find((p) => p.pub === k)?.name;
const decidedOn = (p: Page, r: number): boolean => foldOf(p).base.u >= r || foldOf(p).rounds.some((v) => v.r === r && v.decided !== null);
const trimmedTo = (p: Page, u: number): boolean => foldOf(p).base.u >= u;
const seedCtx = (p: Page, r: number) => ({ room: CTX.room, table: seedTable(CTX), round: r, party: p.pid, house: '' });

/** A duty due at `due` ran on the first tick at or after it. */
function expectAt(at: number, due: number): void {
  expect(at).toBeGreaterThanOrEqual(due);
  expect(at).toBeLessThan(due + STEP);
}

/** Frames of `ticking` every STEP from `from` to `to`, the pages of `synced`
 *  synced around each; the time `until` first held after one (to + STEP if
 *  it never did). */
function runOn(ticking: Page[], synced: Page[], from: number, to: number, until?: () => boolean): number {
  for (let T = from; T <= to; T += STEP) {
    sync(T, ...synced);
    for (const p of ticking) frame(T, p);
    sync(T, ...synced);
    if (until?.()) return T;
  }
  return to + STEP;
}

/** The open round on `pages`: each puts `bets[i]` down at T, every page
 *  ticks until every page reads it decided. Its round and that time. */
function decideRound(pages: Page[], T: number, bets: RouletteBet[][] = pages.map((_, i) => [red(10 + i)])): { r: number; at: number } {
  const r = foldOf(pages[0]).open;
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, bets[i], T)).toBe('ok');
  sync(T, ...pages);
  const at = run(pages, T + STEP, T + 60_000, { step: STEP, until: () => pages.every((p) => decidedOn(p, r)) });
  expect(at).toBeLessThanOrEqual(T + 60_000);
  return { r, at };
}

/** …and on until every page bets on the next round: that time too. */
function playRound(pages: Page[], T: number, bets?: RouletteBet[][]): { r: number; decidedAt: number; openAt: number } {
  const { r, at } = decideRound(pages, T, bets);
  const openAt = run(pages, at + STEP, at + 60_000, {
    step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting' && foldOf(p).open === r + 1),
  });
  return { r, decidedAt: at, openAt };
}

/** Junk the fold weighs (rawBytes) and never reads, `bytes` of it, in the
 *  live session on page p: a session past TRIM_BYTES is due a trim. */
function weigh(p: Page, bytes: number, key = 'junk', t = TABLE): void {
  putIn(p, [[key, 'x'.repeat(bytes)]], t);
}

function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Listeners on every page: the chips of each of `pids` (bal:) and all of it. */
function listen(pages: Page[], pids: string[]): { bal: number; all: number }[] {
  return pages.map((p) => {
    const heard = { bal: 0, all: 0 };
    for (const pid of pids) p.casino.subscribeCasinoKey(`bal:${pid}`, () => { heard.bal += 1; });
    p.casino.subscribeCasino(() => { heard.all += 1; });
    return heard;
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a trim', () => {
  it('moves no chip on any of three pages, tells each page once, and no bal: listener hears a thing', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const { openAt } = playRound(pages, T0);
    const r1 = foldOf(a).rounds[0];
    const commits = pages.map((p) => recOf<SlipRec>(p, `s:1:${p.pid}:${r1.frozen[p.pid]}`).c);
    for (const [i, p] of pages.entries()) expect(p.fair.seedFor(commits[i], seedCtx(p, 1))).not.toBeNull();
    // B puts chips on round 2 and goes quiet (its page stops ticking): no
    // other page closes a round it has nothing on, so the table idles with
    // B's felt on it.
    expect(b.table.writeComputedSlip(TABLE, [straight(17, 5)], openAt)).toBe('ok');
    sync(openAt, ...pages);
    const [felt] = keysIn(b, 's', 2);
    const bytes = JSON.stringify(recOf(b, felt));
    const nets = foldOf(a).nets;
    const chips = pages.map((p) => chipsOn(p, pages));
    const cages = pages.map((p) => p.casino.readCageLedger());
    expect(chips[0][1]).toBe(1_000 + Number(nets.get(b.pid) ?? 0n) - 5);
    for (const x of chips) expect(x).toEqual(chips[0]);
    for (const x of cages) expect(x).toEqual(cages[0]);
    const heard = listen(pages, pages.map((p) => p.pid));
    // Frame by frame until a page trims: the first in line, IDLE_MS after B's felt.
    let trimmer: Page | null = null;
    let at = 0;
    let out: Uint8Array[] = [];
    for (let T = openAt + STEP; T <= openAt + 120_000 && !trimmer; T += STEP) {
      sync(T, ...pages);
      for (const p of [a, c]) {
        for (const h of heard) Object.assign(h, { bal: 0, all: 0 });
        out = updatesOf(p, () => frame(T, p));
        if (trimmedTo(p, 1)) {
          trimmer = p;
          at = T;
          break;
        }
      }
    }
    expect(trimmer).not.toBeNull();
    expect(at).toBe(openAt + a.table.IDLE_MS);
    // One transaction, one notify on the page that trimmed, no bal: change.
    expect(out).toHaveLength(1);
    expect(heard[pages.indexOf(trimmer!)]).toEqual({ bal: 0, all: 1 });
    for (const p of pages.filter((q) => q !== trimmer)) {
      for (const h of heard) Object.assign(h, { bal: 0, all: 0 });
      deliver(at, p, out);
      expect(heard[pages.indexOf(p)]).toEqual({ bal: 0, all: 1 });
    }
    const cp = cpOf(a)!;
    expect(cp).toMatchObject({ v: 1, b: 'g', u: 1, l: r1.close, k: trimmer!.pub });
    expect(cp.n).toEqual(Object.fromEntries([...nets].map(([pid, n]) => [pid, n.toString()])));
    for (const p of pages) {
      expect(foldOf(p).base).toMatchObject({ u: 1, sid: nextSid(CTX, cp) });
      expect(foldOf(p).rounds).toEqual([]);
      expect(sessionsOf(p)).toEqual([`ses:${TABLE}:${INC}:${nextSid(CTX, cp)}`]);
      expect(chipsOn(p, pages)).toEqual(chips[0]);
      expect(p.casino.readCageLedger()).toEqual(cages[0]);
      expect(p.casino.casinoWhole(TABLE)).toBe(true);
      // B's felt went across byte for byte, and holds as it did.
      expect(JSON.stringify(recOf(p, felt))).toBe(bytes);
      expect(foldOf(p).held).toEqual(new Map([[b.pid, 5n]]));
      // Its seeds of the rounds the checkpoint covers go, once it reads the table.
      viewOf(p, at);
      expect(p.fair.seedFor(commits[pages.indexOf(p)], seedCtx(p, 1))).toBeNull();
    }
    // And the table goes on: B back, its felt closes and decides on every page.
    const decided = run(pages, at + STEP, at + 60_000, { step: STEP, until: () => pages.every((p) => decidedOn(p, 2)) });
    expect(decided).toBeLessThanOrEqual(at + 60_000);
    for (const p of pages) expect(chipsOn(p, pages)).toEqual(chipsOn(a, pages));
  });

  it('by two pages at once, neither hearing the other: they open one session, its felts intact', async () => {
    const pages = await room(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const { openAt } = playRound(pages, T0);
    expect(c.table.writeComputedSlip(TABLE, [black(7)], openAt)).toBe('ok');
    sync(openAt, ...pages);
    const [felt] = keysIn(c, 's', 2);
    const chips = chipsOn(a, pages);
    // A and B each trim on their own (C quiet), then meet.
    for (const p of [a, b]) {
      const at = run([p], openAt + STEP, openAt + 120_000, { step: STEP, until: () => trimmedTo(p, 1) });
      expect(at).toBe(openAt + p.table.IDLE_MS);
    }
    const sids = [a, b].map((p) => foldOf(p).base.sid);
    expect(sids[0]).toBe(sids[1]);
    expect(cpOf(a)!.k).toBe(a.pub);
    expect(cpOf(b)!.k).toBe(b.pub);
    sync(openAt + 61_000, ...pages);
    for (const p of pages) {
      expect(foldOf(p).base.sid).toBe(sids[0]);
      expect(sessionsOf(p)).toEqual([`ses:${TABLE}:${INC}:${sids[0]}`]);
      expect([a.pub, b.pub]).toContain(cpOf(p)!.k);
      expect(cpOf(p)).toEqual(cpOf(a));
      expect(keysIn(p, 's', 2)).toEqual([felt]);
      expect(chipsOn(p, pages)).toEqual(chips);
      expect(p.casino.casinoWhole(TABLE)).toBe(true);
    }
    // C wakes (it slept through both trims: it waits out the lapse, and
    // shows round 1 again), and the next round plays on the one session.
    const woke = runOn(pages, pages, openAt + 61_000, openAt + 90_000, () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting'));
    expect(woke).toBeGreaterThanOrEqual(openAt + 61_000 + TABLE_LEASE_LAPSE_MS);
    decideRound(pages, woke + STEP);
    for (const p of pages) {
      expect(foldOf(p).rounds[0]).toMatchObject({ r: 2, decided: 'reveals', present: [a.pid, b.pid, c.pid].sort() });
      expect(chipsOn(p, pages)).toEqual(chipsOn(a, pages));
    }
  });

  it("keeps the last round's result on the felt through the show, then opens the next round as usual", async () => {
    const pages = await room(['A', 'B', 'O']);
    const [a, b, o] = pages;
    weigh(a, a.table.TRIM_BYTES);
    const { at } = decideRound([a, b], T0);
    sync(at, ...pages);
    const D = foldOf(o).rounds[0];
    const shown = pages.map((p) => viewOf(p, at)!);
    for (const v of shown) {
      expect(v).toMatchObject({ phase: 'settled', round: 1, result: D.pocket, resultAt: at, spinKey: `1:${D.pocket}` });
    }
    const checks = pages.map((p) => p.table.computedRoundCheck(TABLE, at));
    // The first of A and B in line trims a second after it saw the round decided.
    const first = byRank([a, b], 'trim', 1)[0];
    const trimmed = run(pages, at + STEP, at + 8_000, { step: STEP, until: () => trimmedTo(first, 1) });
    expectAt(trimmed, at + 1_000);
    for (const p of pages) expect(foldOf(p).rounds).toEqual([]);
    // Every page ticking on: the same result, the same check, an empty felt, to the end of the show.
    for (let T = trimmed; T < at + a.table.SHOW_MS; T += STEP) {
      if (T > trimmed) runOn(pages, pages, T, T);
      for (const [i, p] of pages.entries()) {
        expect(viewOf(p, T)).toEqual(shown[i]);
        expect(p.table.readComputedBets(TABLE, 1, T)).toEqual({});
        expect(p.table.computedRoundCheck(TABLE, T)).toEqual(checks[i]);
      }
    }
    // The show over: round 2 takes bets, unarmed; the wheel keeps its key.
    runOn(pages, pages, at + a.table.SHOW_MS, at + a.table.SHOW_MS);
    for (const p of pages) {
      expect(viewOf(p, at + a.table.SHOW_MS)).toMatchObject({ phase: 'betting', round: 2, result: null, spinKey: `1:${D.pocket}` });
      expect(viewOf(p, at + a.table.SHOW_MS)!.phaseDeadline).toBeUndefined();
    }
    // A page that comes after the trim never saw round 1: it just takes bets.
    const late = await loadPage('L', 9);
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(a.doc));
    expect(viewOf(late, at + 5_000)).toMatchObject({ phase: 'betting', round: 2, result: null, spinKey: '' });
    // And the next round plays, its window armed by its first chip.
    const { at: next } = decideRound([a, b], at + a.table.SHOW_MS);
    expect(next).toBeGreaterThanOrEqual(at + a.table.SHOW_MS + a.table.BET_WINDOW_MS);
    expect(foldOf(a).rounds[0]).toMatchObject({ r: 2, decided: 'reveals' });
  });
});

describe('who trims, and when', () => {
  it('the first in line among the last round’s bettors, a second after it saw the round decided; each one away puts STAGGER_MS on it', async () => {
    for (const away of [0, 1, 2]) {
      const pages = await room(['A', 'B', 'C']);
      weigh(pages[0], pages[0].table.TRIM_BYTES);
      const { at } = decideRound(pages, T0);
      const order = byRank(pages, 'trim', 1);
      const live = order.slice(away);
      const trimmed = run(live, at + STEP, at + 20_000, { step: STEP, until: () => trimmedTo(live[0], 1) });
      expectAt(trimmed, at + 1_000 + away * 1_500);
      expect(signer(pages, cpOf(live[0])!.k)).toBe(live[0].name);
      // Nobody else wrote one meanwhile.
      run(live, trimmed + STEP, trimmed + 5_000, { step: STEP });
      expect(foldOf(live[0]).base.u).toBe(1);
      expect(signer(pages, cpOf(live[live.length - 1])!.k)).toBe(live[0].name);
    }
  });

  it("not before the last round's result shows: a forfeit seen early waits out the grace all the same", async () => {
    const X = testIdentity('trim-fx', 'player-X'); // reveals, and forfeits Y just after the close
    const Y = testIdentity('trim-fy', 'player-Y'); // never reveals
    const [a] = await room(['A']);
    pinOn(a, X, Y);
    weigh(a, a.table.TRIM_BYTES);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const xs = kit.slip(X, 1, [red(3)]);
    const ys = kit.slip(Y, 1, [red(4)]);
    putIn(a, [[xs.key, xs.rec], [ys.key, ys.rec]]);
    const closed = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    frame(closed + STEP, a); // A's seed
    vi.setSystemTime(closed + STEP);
    const xx = kit.reveal(1, X.pid);
    const f = kit.forfeit(X, 1, foldOf(a).tip!.close, [a.pid, X.pid]);
    putIn(a, [[xx.key, xx.rec], [f.key, f.rec]]);
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', missing: [] });
    // Decided at once, shown a second after the grace on A's clock (4 s: no
    // seed stretched it), and A trims in its turn among the three from then.
    const rank = (k: string) => a.fold.dutyRank('trim', CTX, 1, k);
    const idx = [X.pub, Y.pub].filter((k) => rank(k) < rank(a.pub)).length;
    const show = closed + a.table.REVEAL_GRACE_MS + 1_000;
    const trimmed = run([a], closed + 2 * STEP, closed + 30_000, { step: STEP, until: () => trimmedTo(a, 1) });
    expectAt(trimmed, show + idx * a.table.STAGGER_MS);
    expect(viewOf(a, trimmed)).toMatchObject({ phase: 'settled', round: 1, resultAt: show });
  });

  it('a page none of them is on: only once nothing new has come for TRIM_FALLBACK_MS', async () => {
    const pages = await room(['A', 'B', 'O']);
    const [a, b, o] = pages;
    weigh(a, a.table.TRIM_BYTES);
    const { at } = decideRound([a, b], T0);
    sync(at, ...pages);
    // A and B gone: O watches.
    const trimmed = run([o], at + STEP, at + 300_000, { step: STEP, until: () => trimmedTo(o, 1) });
    expectAt(trimmed, at + o.table.TRIM_FALLBACK_MS);
    expect(cpOf(o)!.k).toBe(o.pub);
  });

  it("needs pressure: none in a short, light, busy session; IDLE_MS idle, or TRIM_BYTES of it, or the room's budget", async () => {
    // Light, short and busy: no trim through the show and the next round.
    {
      const pages = await room(['A', 'B']);
      const { openAt } = playRound(pages, T0);
      const { at } = decideRound(pages, openAt);
      expect(foldOf(pages[0]).base.u).toBe(0);
      expect(at).toBeLessThan(openAt + 60_000);
    }
    // Just under TRIM_BYTES: none at the turn, the idle one later.
    {
      const pages = await room(['A', 'B']);
      weigh(pages[0], pages[0].table.TRIM_BYTES - 4_000);
      const { at } = decideRound(pages, T0);
      expect(foldOf(pages[0]).rawBytes).toBeLessThan(pages[0].table.TRIM_BYTES);
      const trimmed = run(pages, at + STEP, at + 120_000, { step: STEP, until: () => trimmedTo(pages[0], 1) });
      expectAt(trimmed, at + pages[0].table.IDLE_MS);
    }
    // The room's sessions past ROOM_BYTES (this one's and another table's
    // together): one past ROOM_MIN_BYTES trims at once, one under it waits
    // for its own pressure.
    for (const own of [24 * 1024, 20 * 1024]) {
      const pages = await room(['A', 'B']);
      const [a] = pages;
      const OTHER = 'roulette-2';
      switchOn(a, OTHER, 'c' + '6b'.repeat(12));
      weigh(a, a.table.ROOM_BYTES - 16 * 1024, 'junk', OTHER);
      weigh(a, own);
      sync(T0, ...pages);
      expect(a.casino.computedRoomBytes()).toBeGreaterThanOrEqual(a.table.ROOM_BYTES);
      const { at } = decideRound(pages, T0);
      expect(foldOf(a).rawBytes >= a.table.ROOM_MIN_BYTES).toBe(own === 24 * 1024);
      const trimmed = run(pages, at + STEP, at + 120_000, { step: STEP, until: () => trimmedTo(a, 1) });
      if (own === 24 * 1024) expect(trimmed).toBeLessThan(at + 5_000);
      else expectAt(trimmed, at + a.table.IDLE_MS);
    }
    // TRIM_BYTES to the byte: one short of it, nothing; at it, the trim.
    {
      const pages = await room(['A', 'B']);
      const [a] = pages;
      const { at } = decideRound(pages, T0);
      const base = foldOf(a).rawBytes;
      weigh(a, 1_000);
      const over = foldOf(a).rawBytes - base - 1_000;
      weigh(a, a.table.TRIM_BYTES - 1 - base - over);
      expect(foldOf(a).rawBytes).toBe(a.table.TRIM_BYTES - 1);
      run(pages, at + STEP, at + 5_000, { step: STEP });
      expect(trimmedTo(a, 1)).toBe(false);
      vi.setSystemTime(at + 5_000);
      weigh(a, a.table.TRIM_BYTES - base - over);
      expect(foldOf(a).rawBytes).toBe(a.table.TRIM_BYTES);
      expect(run(pages, at + 5_200, at + 10_000, { step: STEP, until: () => trimmedTo(a, 1) })).toBe(at + 5_200);
    }
    // The room's budget to the byte, this session past ROOM_MIN_BYTES (and
    // short of TRIM_BYTES): one short of ROOM_BYTES, nothing; at it, the trim.
    {
      const pages = await room(['A', 'B']);
      const [a] = pages;
      const OTHER = 'roulette-2';
      switchOn(a, OTHER, 'c' + '6b'.repeat(12));
      weigh(a, a.table.ROOM_MIN_BYTES);
      sync(T0, ...pages);
      const { at } = decideRound(pages, T0);
      const base = a.casino.computedRoomBytes();
      weigh(a, 1_000, 'junk', OTHER);
      const over = a.casino.computedRoomBytes() - base - 1_000;
      weigh(a, a.table.ROOM_BYTES - 1 - base - over, 'junk', OTHER);
      expect(a.casino.computedRoomBytes()).toBe(a.table.ROOM_BYTES - 1);
      expect(foldOf(a).rawBytes).toBeLessThan(a.table.TRIM_BYTES);
      run(pages, at + STEP, at + 5_000, { step: STEP });
      expect(trimmedTo(a, 1)).toBe(false);
      vi.setSystemTime(at + 5_000);
      weigh(a, a.table.ROOM_BYTES - base - over, 'junk', OTHER);
      expect(a.casino.computedRoomBytes()).toBe(a.table.ROOM_BYTES);
      expect(run(pages, at + 5_200, at + 10_000, { step: STEP, until: () => trimmedTo(a, 1) })).toBe(at + 5_200);
    }
    // Idle from the newest record of any kind: here the forfeit that decided the round.
    {
      const X = testIdentity('trim-i', 'player-X');
      const [a] = await room(['A']);
      pinOn(a, X);
      expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
      const xs = kit.slip(X, 1, [black(5)]);
      putIn(a, [[xs.key, xs.rec]]);
      const forfeited = run([a], T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'f', 1).length > 0 });
      expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit', missing: [] });
      const trimmed = run([a], forfeited + STEP, forfeited + 120_000, { step: STEP, until: () => trimmedTo(a, 1) });
      expectAt(trimmed, forfeited + a.table.IDLE_MS);
    }
  });

  it('waits MISSING_WAIT_MS for a frozen slip missing from a decided round, from when it saw it missing', async () => {
    const X = testIdentity('trim-x', 'player-X');
    const xs = kit.slip(X, 1, [black(5)]);
    /** A page alone with X's slip; it closes over both, then X's slip is
     *  lost, so its own seed decides the round, by forfeit. */
    async function missing(name: string): Promise<{ p: Page; decided: number }> {
      const [p] = await room([name]);
      pinOn(p, X);
      weigh(p, p.table.TRIM_BYTES);
      expect(p.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
      putIn(p, [[xs.key, xs.rec]]);
      const closed = run([p], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(p, 'c', 1).length > 0 });
      deleteIn(p, [xs.key]);
      const decided = run([p], closed + STEP, closed + 30_000, { step: STEP, until: () => decidedOn(p, 1) });
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'forfeit', missing: [X.pid] });
      return { p, decided };
    }
    {
      const { p, decided } = await missing('A');
      const trimmed = run([p], decided + STEP, decided + 60_000, { step: STEP, until: () => trimmedTo(p, 1) });
      expectAt(trimmed, decided + p.table.MISSING_WAIT_MS);
    }
    // The slip put back: no wait.
    {
      const { p, decided } = await missing('B');
      run([p], decided + STEP, decided + 5_000, { step: STEP });
      expect(trimmedTo(p, 1)).toBe(false);
      vi.setSystemTime(decided + 5_000);
      putIn(p, [[xs.key, xs.rec]]);
      expect(foldOf(p).rounds[0].missing).toEqual([]);
      expect(run([p], decided + 5_200, decided + 30_000, { step: STEP, until: () => trimmedTo(p, 1) })).toBe(decided + 5_200);
    }
    // A wake starts the wait again.
    {
      const { p, decided } = await missing('C');
      run([p], decided + STEP, decided + 10_000, { step: STEP });
      const woke = decided + 10_000 + TABLE_LEASE_LAPSE_MS + 1_000;
      const trimmed = run([p], woke, woke + 60_000, { step: STEP, until: () => trimmedTo(p, 1) });
      expectAt(trimmed, woke + p.table.MISSING_WAIT_MS);
    }
  });

  it('not while a round is closed and undecided; a close for the open round that reads invalid is dropped with the rest', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    const { openAt } = playRound(pages, T0);
    // Round 2 closed by A alone (B away); B never reveals.
    expect(a.table.writeComputedSlip(TABLE, [red(10)], openAt)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(11)], openAt)).toBe('ok');
    sync(openAt, a, b);
    const closed = run([a], openAt + STEP, openAt + 40_000, { step: STEP, until: () => !!foldOf(a).tip });
    // Pressure, and round 1 decided: but round 2 is closed. A forfeits B's
    // seed at the grace, round 2 decided, and only then the trim, to round 2.
    weigh(a, a.table.TRIM_BYTES);
    const trimmed = run([a], closed + STEP, closed + 60_000, { step: STEP, until: () => trimmedTo(a, 1) });
    expect(foldOf(a).base.u).toBe(2);
    expect(trimmed).toBeGreaterThan(closed + a.table.REVEAL_GRACE_MS);
    // Round 3, A alone, decided by its seed; no pressure, so no trim yet.
    const open3 = run([a], trimmed + STEP, trimmed + 20_000, { step: STEP, until: () => viewOf(a, Date.now())?.phase === 'betting' });
    const r3 = playRound([a], open3);
    expect(r3.r).toBe(3);
    expect(trimmedTo(a, 3)).toBe(false);
    // A close for round 4 nobody could have signed (a made-up signer): junk,
    // it holds nothing back, and the trim drops it with the rest.
    const G = testIdentity('trim-g', 'player-G');
    const junk = kit.close(G, 4, foldOf(a).parent, { [a.pid]: 'e'.repeat(32) });
    putIn(a, [[junk.key, junk.rec]]);
    expect(foldOf(a).openCloses.map((c) => c.state)).toEqual(['invalid']);
    expect(foldOf(a).tip).toBeNull();
    weigh(a, a.table.TRIM_BYTES, 'junk2');
    const again = run([a], r3.openAt + STEP, r3.openAt + 10_000, { step: STEP, until: () => trimmedTo(a, 3) });
    expect(again).toBe(r3.openAt + STEP);
    expect(sessionsOf(a)).toHaveLength(1);
    expect(keysIn(a, 'c')).toEqual([]);
  });

  it('skips a checkpoint whose nets would pass MAX_CHECKPOINT_PIDS', async () => {
    for (const over of [0, 1]) {
      const pages = await room(['A', 'B']);
      const [a, b] = pages;
      const { openAt } = playRound([a], T0);
      sync(openAt, a, b);
      // A checkpoint one short of the cap (or at it), A's net among them.
      const crowd: Record<string, bigint> = Object.fromEntries(foldOf(a).nets);
      for (let i = 0; Object.keys(crowd).length < a.fold.MAX_CHECKPOINT_PIDS - 1 + over; i++) crowd[`ghost-${i}`] = 1n;
      trimByHand(a, testIdentity('trim-cap'), crowd);
      sync(openAt, a, b);
      weigh(a, a.table.TRIM_BYTES);
      // B, new to the table, makes the cap (or one past it).
      const { at } = decideRound(pages, openAt + STEP, [[red(7)], [red(11)]]);
      expect(foldOf(a).nets.size).toBe(a.fold.MAX_CHECKPOINT_PIDS + over);
      // (Heavy: due a second after the round, in turn.)
      const trimmed = run(pages, at + STEP, at + 5_000, { step: STEP, until: () => trimmedTo(a, 2) });
      if (over) expect(foldOf(a).base.u).toBe(1);
      else expect(trimmed).toBeLessThan(at + 5_000);
    }
  }, 30_000);

  it("refuses on a doc holding part of an update, before the room's state is in, and with signatures to check", async () => {
    // Part of an update: nothing until the rest comes.
    {
      const pages = await room(['A', 'O']);
      const [a, o] = pages;
      weigh(a, a.table.TRIM_BYTES);
      const { at } = decideRound([a], T0);
      const [first, later] = updatesOf(o, () => {
        o.doc.getMap('casino').set(`seat:${TABLE}:${o.pid}`, { stand: 0, angle: 0, at: 1 });
        o.doc.getMap('casino').set(`seat:${TABLE}:${o.pid}`, { stand: 1, angle: 0, at: 2 });
      });
      deliver(at, a, [later]);
      run([a], at + STEP, at + 10_000, { step: STEP });
      expect(trimmedTo(a, 1)).toBe(false);
      deliver(at + 10_000, a, [first]);
      expect(run([a], at + 10_200, at + 20_000, { step: STEP, until: () => trimmedTo(a, 1) })).toBe(at + 10_200);
    }
    // Before the room's state is in: a page reloading on its cached doc waits.
    {
      const [a] = await room(['A']);
      weigh(a, a.table.TRIM_BYTES);
      const { at } = decideRound([a], T0);
      vi.setSystemTime(at);
      const again = await loadPage('A', 9, { reloadOf: a });
      again.croupier.setRoomStateArrivedCheck(() => false);
      expect(again.croupier.roomStateIn(at)).toBe(false);
      Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc));
      const trimmed = run([again], at + STEP, at + ROOM_STATE_WAIT_MS + 10_000, { step: STEP, until: () => trimmedTo(again, 1) });
      expect(trimmed).toBeGreaterThanOrEqual(at + ROOM_STATE_WAIT_MS);
      expect(trimmed).toBeLessThan(at + ROOM_STATE_WAIT_MS + 2 * STEP);
    }
    // A record still to be checked: nothing until it is.
    {
      const pages = await room(['A', 'O']);
      const [a, o] = pages;
      const { openAt: at } = playRound([a, o], T0);
      a.casino.setComputedVerifyForTests({ budgetMs: 0 });
      expect(o.table.writeComputedSlip(TABLE, [red(3)], at)).toBe('ok');
      sync(at, a, o);
      weigh(a, a.table.TRIM_BYTES);
      expect(a.casino.computedSettled(TABLE)).toBe(false);
      run([a], at + STEP, at + 10_000, { step: STEP });
      expect(trimmedTo(a, 1)).toBe(false);
      a.casino.setComputedVerifyForTests({ now: () => 0 });
      await flush();
      expect(a.casino.computedSettled(TABLE)).toBe(true);
      expect(run([a], at + 10_200, at + 20_000, { step: STEP, until: () => trimmedTo(a, 1) })).toBe(at + 10_200);
      // O's felt, checked by then, went across.
      expect(foldOf(a).held.get(o.pid)).toBe(3n);
    }
  });
});

describe('races', () => {
  it('a slip written at the moment of the trim, into the session it took away, goes back into the new one', async () => {
    const pages = await room(['A', 'B']);
    const { openAt } = playRound(pages, T0);
    const [x, y] = byRank(pages, 'trim', 1);
    // The session turns heavy on x as round 2 takes bets: x trims on its
    // next tick, and y, not having heard, puts a felt down then.
    weigh(x, x.table.TRIM_BYTES);
    const T = openAt + STEP;
    frame(T, x);
    expect(trimmedTo(x, 1)).toBe(true);
    expect(y.table.writeComputedSlip(TABLE, [red(30)], T)).toBe('ok');
    frame(T, y);
    const [felt] = keysIn(y, 's', 2);
    const bytes = JSON.stringify(recOf(y, felt));
    expect(foldOf(y).base.u).toBe(0);
    expect(foldOf(y).held.get(y.pid)).toBe(30n);
    sync(T, x, y);
    // The write went with the session it was in: nothing held.
    for (const p of pages) {
      expect(foldOf(p).base.u).toBe(1);
      expect(keysIn(p, 's', 2)).toEqual([]);
      expect(p.casino.readChips(y.pid)).toBe(1_000 + Number(foldOf(p).nets.get(y.pid) ?? 0n));
    }
    // y puts it back on its next REPUT_MS beat, byte for byte.
    const back = runOn(pages, pages, T + STEP, T + 3_000, () => pages.every((p) => keysIn(p, 's', 2).includes(felt)));
    expect(back).toBeLessThanOrEqual(T + y.table.REPUT_MS + STEP);
    for (const p of pages) {
      expect(JSON.stringify(recOf(p, felt))).toBe(bytes);
      expect(foldOf(p).held.get(y.pid)).toBe(30n);
      expect(p.casino.readChips(y.pid)).toBe(1_000 + Number(foldOf(p).nets.get(y.pid) ?? 0n) - 30);
    }
    // And it plays: y's felt closes round 2.
    const decided = runOn(pages, pages, back + STEP, back + 60_000, () => pages.every((p) => decidedOn(p, 2)));
    expect(decided).toBeLessThanOrEqual(back + 60_000);
    expect(foldOf(x).rounds[0].frozen[y.pid]).toBe(felt.split(':').at(-1));
  });

  it("a stale page's update from before the trim brings nothing of the old session back", async () => {
    const pages = await room(['A', 'B', 'S']);
    const [a, b, s] = pages;
    const { decidedAt, openAt } = playRound(pages, T0);
    // S stops hearing the room: what it writes now goes into the session it has.
    const stale = updatesOf(s, () => {
      expect(s.table.writeComputedSlip(TABLE, [red(25)], openAt)).toBe('ok');
      // (and a cheat's put-back of round 1's close, and junk)
      const [close] = keysIn(s, 'c', 1);
      const ses = s.casino.computedSessionForWrite(TABLE)!;
      s.doc.transact(() => {
        const was = ses.get(close);
        ses.delete(close);
        ses.set(close, was);
        ses.set('junk', 'x'.repeat(1_000));
      });
    });
    expect(stale.length).toBeGreaterThan(0);
    // A and B idle from round 1's last seed on: the first in line trims.
    const trimmed = runOn([a, b], [a, b], openAt + STEP, openAt + 120_000, () => trimmedTo(a, 1) && trimmedTo(b, 1));
    expectAt(trimmed, decidedAt + a.table.IDLE_MS);
    const before = [a, b].map((p) => ({ chips: chipsOn(p, pages), keys: keysIn(p, 's').concat(keysIn(p, 'c')), sessions: sessionsOf(p) }));
    for (const p of [a, b]) {
      deliver(trimmed, p, stale);
      expect(foldOf(p).base.u).toBe(1);
      expect(sessionsOf(p)).toEqual(before[0].sessions);
      expect(keysIn(p, 's').concat(keysIn(p, 'c'))).toEqual(before[0].keys);
      expect(chipsOn(p, pages)).toEqual(before[0].chips);
      expect(p.casino.casinoWhole(TABLE)).toBe(true);
      expect(p.casino.computedSettled(TABLE)).toBe(true);
      expect(foldOf(p).rawBytes).toBe(foldOf(a).rawBytes);
    }
    // S hears the room: its felt goes back into the new session (its own
    // re-put, once it has waited out its wake), and the rest of what it wrote stays gone.
    const back = runOn(pages, pages, trimmed + STEP, trimmed + 20_000, () => pages.every((p) => keysIn(p, 's', 2).length === 1));
    expect(back).toBeLessThanOrEqual(trimmed + STEP + TABLE_LEASE_LAPSE_MS + s.table.REPUT_MS);
    for (const p of pages) {
      expect(sessionsOf(p)).toEqual(before[0].sessions);
      expect(keysIn(p, 'c')).toEqual([]);
      expect(foldOf(p).held.get(s.pid)).toBe(25n);
      expect(chipsOn(p, pages)).toEqual(chipsOn(a, pages));
    }
  });

  it('a split: the checkpoint the doc keeps wins, the other side’s rounds are void, every page agrees and the cage balances', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // Apart from here: A plays round 1, B rounds 1 and 2, each trims on its own.
    const ra = decideRound([a], T0, [[straight(3, 10)]]);
    const ta = run([a], ra.at + STEP, T0 + 200_000, { step: STEP, until: () => trimmedTo(a, 1) });
    const r1 = decideRound([b], T0, [[black(20)]]);
    const open2 = run([b], r1.at + STEP, r1.at + 20_000, { step: STEP, until: () => viewOf(b, Date.now())?.phase === 'betting' });
    const r2 = decideRound([b], open2, [[red(15)]]);
    const tb = run([b], r2.at + STEP, r2.at + 200_000, { step: STEP, until: () => trimmedTo(b, 2) });
    const cps = { a: cpOf(a)!, b: cpOf(b)! };
    expect(cps.a.u).toBe(1);
    expect(cps.b.u).toBe(2);
    // B bets on its round 3 too, and A on its round 2: open felts on each side.
    expect(a.table.writeComputedSlip(TABLE, [red(4)], ta)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(6)], tb)).toBe('ok');
    const seeds = { a: foldOf(a).felts.get(a.pid)!.rec.c, b: foldOf(b).felts.get(b.pid)!.rec.c };
    // They meet.
    const T = Math.max(ta, tb) + 20_000;
    sync(T, a, b);
    const won = asCheckpoint(computedOf(a).get(`sum:${TABLE}:${INC}`))!;
    const winner = won.k === a.pub ? a : b;
    const loser = winner === a ? b : a;
    expect(won).toEqual(winner === a ? cps.a : cps.b);
    const nets = Object.fromEntries(Object.entries(won.n).map(([pid, n]) => [pid, BigInt(n)]));
    for (const p of pages) {
      expect(foldOf(p).base.sid).toBe(nextSid(CTX, won));
      expect(p.casino.casinoWhole(TABLE)).toBe(true);
      // Only the winner's rounds count; the loser's played nothing.
      for (const q of pages) {
        const held = q === winner ? (q === a ? 4 : 6) : 0;
        expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(nets[q.pid] ?? 0n) - held);
      }
      // (The house holds what is on the felt.)
      const cage = p.casino.readCageLedger();
      expect(cage.houseNet).toBe((winner === a ? 4 : 6) - Object.values(nets).reduce((x, y) => x + Number(y), 0));
      expect(cage.issued - cage.cashed - cage.outstanding).toBe(cage.houseNet);
      expect(cage).toEqual(a.casino.readCageLedger());
    }
    expect(loser.casino.readChips(loser.pid)).toBe(1_000);
    // The loser's records stay out: none put back (both pages wake, wait
    // out the lapse, and re-put), its seeds let go.
    run(pages, T + STEP, T + 10_000, { step: STEP });
    const kept = winner === a ? 2 : 3;
    for (const p of pages) {
      expect(keysIn(p, 's').filter((k) => k.includes(`:${loser.pid}:`))).toEqual([]);
      expect(keysIn(p, 'x')).toEqual([]);
      expect(keysIn(p, 's', kept)).toEqual(keysIn(winner, 's', kept));
    }
    const lostSeed = loser === a ? seeds.a : seeds.b;
    expect(loser.fair.seedFor(lostSeed, seedCtx(loser, loser === a ? 2 : 3))).toBeNull();
    // The other side's session map is left over, counting nothing, until the next trim takes it.
    expect(sessionsOf(a)).toHaveLength(2);
    weigh(winner, winner.table.TRIM_BYTES);
    const { at } = decideRound(pages, T + 10_000 + STEP);
    const t2 = run(pages, at + STEP, at + 10_000, { step: STEP, until: () => pages.every((p) => trimmedTo(p, kept)) });
    expect(t2).toBeLessThan(at + 10_000);
    for (const p of pages) {
      expect(sessionsOf(p)).toHaveLength(1);
      expect(chipsOn(p, pages)).toEqual(chipsOn(a, pages));
    }
  });

  it('a split where one side trimmed: what the other side played in the session the trim took away is void, and none of it comes back', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // Apart: A plays round 1 and trims; B plays rounds 1 and 2, untrimmed, and bets on round 3.
    const ra = decideRound([a], T0, [[straight(3, 10)]]);
    const ta = run([a], ra.at + STEP, T0 + 200_000, { step: STEP, until: () => trimmedTo(a, 1) });
    const r1 = playRound([b], T0, [[black(20)]]);
    const r2 = playRound([b], r1.openAt, [[red(15)]]);
    expect(b.table.writeComputedSlip(TABLE, [red(6)], r2.openAt)).toBe('ok');
    expect(trimmedTo(b, 1)).toBe(false);
    const commits = [1, 2, 3].flatMap((r) => slipsOf(b, r, b.pid).map((x) => ({ r, c: x.c })));
    expect(commits).toHaveLength(3);
    // They meet: A's checkpoint is the only one, and the session B played in is gone with B's writes.
    const T = Math.max(ta, r2.openAt) + 20_000;
    sync(T, a, b);
    const cp = cpOf(a)!;
    for (const p of pages) {
      expect(cpOf(p)).toEqual(cp);
      expect(sessionsOf(p)).toEqual([`ses:${TABLE}:${INC}:${nextSid(CTX, cp)}`]);
      expect(p.casino.readChips(b.pid)).toBe(1_000);
      expect(p.casino.readChips(a.pid)).toBe(1_000 + Number(cp.n[a.pid] ?? 0));
    }
    // B's felt shows none of its void rounds: the wheel isn't left on round 2's pocket.
    expect(viewOf(b, T)).toMatchObject({ phase: 'betting', round: 2, result: null, spinKey: '' });
    // Both run on: nothing B wrote comes back, its seeds go.
    run(pages, T + STEP, T + 10_000, { step: STEP });
    for (const p of pages) {
      expect([...keysIn(p, 's'), ...keysIn(p, 'c'), ...keysIn(p, 'x')]).toEqual([]);
      expect(p.casino.readChips(b.pid)).toBe(1_000);
    }
    for (const { r, c } of commits) expect(b.fair.seedFor(c, seedCtx(b, r))).toBeNull();
  });

  it("a split where one side trimmed at the round the other side played as its own: that side's felt shows none of its round there, and its card no verdict on it", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // Apart: A plays round 1 and trims at it; B plays only a round 1 of its own.
    const ra = decideRound([a], T0, [[straight(3, 10)]]);
    const ta = run([a], ra.at + STEP, T0 + 200_000, { step: STEP, until: () => trimmedTo(a, 1) });
    const r1 = playRound([b], T0 + 30_000, [[black(20)]]);
    expect(trimmedTo(b, 1)).toBe(false);
    const own = foldOf(b).rounds[0].close;
    const T = Math.max(ta, r1.openAt) + 1_000;
    const shown = viewOf(a, T)!.spinKey;
    expect(shown).toMatch(/^1:\d+$/);
    expect(viewOf(b, T)!.spinKey).toMatch(/^1:\d+$/);
    expect(b.table.computedRoundCheck(TABLE, T)).toMatchObject({ round: 1 });
    // They meet: A's checkpoint at round 1 is the only one, and B's round 1
    // is gone with the session B played it in.
    sync(T, a, b);
    for (const p of pages) expect([foldOf(p).base.u, foldOf(p).base.l, foldOf(p).rounds.length]).toEqual([1, foldOf(a).base.l, 0]);
    expect(foldOf(b).base.l).not.toBe(own);
    // A's felt shows its round 1 through the trim, its card its verdict; B
    // never saw that round 1, and shows none of it, as of a dropped round
    // past the checkpoint (above).
    expect(viewOf(a, T)!.spinKey).toBe(shown);
    expect(a.table.computedRoundCheck(TABLE, T)).toMatchObject({ round: 1 });
    expect(viewOf(b, T)).toMatchObject({ phase: 'betting', round: 2, result: null, spinKey: '' });
    expect(b.table.computedRoundCheck(TABLE, T)).toBeNull();
  });

  it("a split where one side trimmed at a round both sides saw decided, the other playing a round past it as its own: that side's felt shows the round the checkpoint kept again, and its card its verdict", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // Together: round 1, its result and verdict read on both pages.
    const { openAt } = playRound(pages, T0);
    const r1 = foldOf(a).rounds[0];
    const shown = viewOf(a, openAt)!.spinKey;
    expect(shown).toBe(`1:${r1.pocket}`);
    expect(a.table.computedRoundCheck(TABLE, openAt)).toMatchObject({ round: 1, decided: 'reveals' });
    // Apart: B trims at round 1; A plays a round 2 of its own.
    weigh(b, b.table.TRIM_BYTES);
    const tb = run([b], openAt + STEP, openAt + 60_000, { step: STEP, until: () => trimmedTo(b, 1) });
    expect(tb).toBeLessThan(openAt + 60_000);
    const r2 = playRound([a], openAt, [[red(7)]]);
    expect(trimmedTo(a, 1)).toBe(false);
    expect(viewOf(a, r2.openAt)!.spinKey).toMatch(/^2:\d+$/);
    // They meet: B's checkpoint at round 1, under the close A saw decide
    // it, is the only one, and A's round 2 is gone with its session.
    const T = Math.max(tb, r2.openAt) + 1_000;
    sync(T, a, b);
    expect(foldOf(a).base).toMatchObject({ u: 1, l: r1.close });
    expect(foldOf(a).rounds).toEqual([]);
    expect(a.table.computedDecidedTo(TABLE)).toBe(1);
    // A shows round 1 again through the trim, as B does, and its verdict.
    expect(viewOf(a, T)).toMatchObject({ round: 2, spinKey: shown });
    expect(a.table.computedRoundCheck(TABLE, T)).toMatchObject({ round: 1, decided: 'reveals' });
  });

  it('a split where one side trimmed before the round the other side played past it: that side gives the round on the chain a full window of its own', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // Apart: A plays round 1 and trims at it; B plays rounds 1 and 2 of its
    // own, its window for round 2 long run out, and runs on with nothing on round 3.
    const ra = decideRound([a], T0, [[straight(3, 10)]]);
    const ta = run([a], ra.at + STEP, T0 + 200_000, { step: STEP, until: () => trimmedTo(a, 1) });
    const r1 = playRound([b], T0, [[black(20)]]);
    const r2 = playRound([b], r1.openAt, [[red(15)]]);
    const T = Math.max(ta, r2.openAt) + 20_000;
    run([b], r2.openAt + STEP, T - STEP, { step: STEP });
    // A bets on its round 2 just before they meet.
    run([a], ta + STEP, T - 1_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(6)], T - 1_000)).toBe('ok');
    sync(T, a, b);
    for (const p of pages) expect([foldOf(p).base.u, foldOf(p).rounds.length]).toEqual([1, 0]);
    // B first saw a chip on the chain's round 2 now: its window starts now,
    // not when B's own round 2 took its first chip.
    expect(viewOf(b, T)).toMatchObject({ phase: 'betting', round: 2, phaseDeadline: T + b.table.BET_WINDOW_MS });
  });

  it('a commitment out is never frozen again across a trim: the trim leaves it behind, and its player puts the felt back under a fresh seed', async () => {
    const pages = await room(['A', 'B', 'W']);
    const { openAt } = playRound(pages, T0);
    const [closer, other] = byRank(pages.slice(0, 2), 'close', 2);
    const w = pages[2];
    for (const [i, p] of [closer, other].entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], openAt)).toBe('ok');
    // (The closer's felt in two versions under one seed.)
    expect(closer.table.writeComputedSlip(TABLE, [red(10), red(1)], openAt + 2 * STEP)).toBe('ok');
    expect(new Set(slipsOf(closer, 2, closer.pid).map((x) => x.c)).size).toBe(1);
    sync(openAt + 2 * STEP, ...pages);
    const burned = foldOf(other).felts.get(other.pid)!.rec.c;
    const otherFelt = foldOf(other).felts.get(other.pid)!.rec.b;
    // The closer closes and goes away; the other reveals; a griefer deletes
    // the close (the closer isn't there to put it back): round 2 reads open,
    // the other's seed out.
    const closed = runOn(pages, pages, openAt + 3 * STEP, openAt + 30_000, () => keysIn(closer, 'c', 2).length > 0);
    runOn([other, w], pages, closed + STEP, closed + STEP);
    expect(keysIn(w, 'x', 2)).toHaveLength(1);
    viewOf(w, closed + STEP);
    expect(foldOf(w).revealedCommits.has(burned)).toBe(true);
    // (The reveal goes too: W alone remembers the seed is out.)
    deleteIn(w, [...keysIn(w, 'c', 2), ...keysIn(w, 'x', 2)]);
    sync(closed + STEP, ...pages);
    // The other page reads the round open again, then sleeps (before its
    // re-commit, which would put the felt down again under a fresh seed).
    expect(viewOf(other, closed + STEP)).toMatchObject({ phase: 'betting', round: 2 });
    expect(foldOf(w).revealedCommits.has(burned)).toBe(false);
    // Nobody is there to close round 2; idle from the newest record left (the
    // closer's second version), W trims, leaving the burned felt behind.
    const trimmed = run([w], closed + 2 * STEP, closed + 120_000, { step: STEP, until: () => trimmedTo(w, 1) });
    expectAt(trimmed, openAt + 2 * STEP + w.table.IDLE_MS);
    expect(keysIn(w, 's', 2).map((k) => k.split(':')[2])).toEqual([closer.pid]);
    expect(keysIn(w, 'x')).toEqual([]);
    expect(foldOf(w).held.get(other.pid)).toBeUndefined();
    // A page that never saw the seed joins and bets; the other wakes, and
    // once it has waited out the wake and the show it restarted, its felt
    // goes back under a fresh seed, in time for the close.
    const z = await loadPage('Z', 4);
    z.casino.buyInChips(z.pid, 1_000);
    sync(trimmed, w, z);
    expect(z.table.writeComputedSlip(TABLE, [black(5)], trimmed)).toBe('ok');
    const putBack = runOn([other, w, z], [...pages, z], trimmed + STEP, trimmed + 15_000, () => slipsOf(z, 2, other.pid).length > 0);
    expect(putBack).toBeLessThanOrEqual(trimmed + 15_000);
    // (Not before its page takes bets again: the show its wake restarted, from its first frame back.)
    expect(putBack).toBeGreaterThanOrEqual(trimmed + STEP + other.table.SHOW_MS);
    const fresh = slipsOf(z, 2, other.pid)[0];
    expect(fresh).toMatchObject({ b: otherFelt });
    expect(fresh.c).not.toBe(burned);
    expect(fresh.v).toBeGreaterThan(1);
    expect(slipCommit(CTX, 2, other.pid, other.fair.seedFor(fresh.c, seedCtx(other, 2))!)).toBe(fresh.c);
    // The closer back too (its latest version went across, and the seed it
    // shares with the one left behind is kept): round 2 closes over the
    // three felts, the burned one nowhere, every seed in.
    const all = [closer, other, z];
    const decided = runOn([...all, w], [...all, w], putBack + STEP, putBack + 60_000, () => all.every((p) => decidedOn(p, 2)));
    expect(decided).toBeLessThanOrEqual(putBack + 60_000);
    for (const p of all) {
      for (const c of closesOf(p)) {
        for (const [pid, hash] of Object.entries(c.f)) {
          expect(asSlip(recOf(p, `s:${c.r}:${pid}:${hash}`))?.c).not.toBe(burned);
        }
      }
      expect(slipsOf(p, 2, other.pid).map((x) => x.c)).not.toContain(burned);
      // (The closer's old close, of a round it saw closed that the trim left out, stays gone: it closed again.)
      expect(keysIn(p, 'c', 2)).toHaveLength(1);
      expect(foldOf(p).rounds[0]).toMatchObject({ r: 2, decided: 'reveals', present: [closer.pid, other.pid, z.pid].sort() });
    }
  });
});

describe('a long table', () => {
  it('300 rounds on two pages, a trim every TRIM_ROUNDS: the doc stays under 250 KB, and every chip adds up', async () => {
    const pages = await room(['A', 'B']);
    const step = 1_000;
    const trims: number[] = [];
    let T = T0;
    const played = (p: Page): number => foldOf(p).base.u + foldOf(p).rounds.filter((v) => v.decided).length;
    let biggest = 0;
    while (foldOf(pages[0]).base.u < 300) {
      for (const [i, p] of pages.entries()) {
        const v = viewOf(p, T)!;
        if (v.phase === 'betting' && !foldOf(p).felts.has(p.pid)) expect(p.table.writeComputedSlip(TABLE, [i ? black(2) : red(3)], T)).toBe('ok');
      }
      sync(T, ...pages);
      for (const p of pages) frame(T, p);
      sync(T, ...pages);
      const u = foldOf(pages[0]).base.u;
      if (u !== (trims.at(-1) ?? 0)) trims.push(u);
      if (played(pages[0]) % 50 === 0) biggest = Math.max(biggest, Y.encodeStateAsUpdate(pages[0].doc).length);
      T += step;
      expect(T - T0).toBeLessThan(300 * 40_000);
    }
    expect(played(pages[0])).toBe(300);
    expect(trims).toEqual(Array.from({ length: 15 }, (_, i) => (i + 1) * 20));
    for (const p of pages) {
      const size = Y.encodeStateAsUpdate(p.doc).length;
      expect(size).toBeLessThan(250 * 1024);
      expect(sessionsOf(p)).toHaveLength(1);
      expect(chipsOn(p, pages)).toEqual(chipsOn(pages[0], pages));
      for (const q of pages) {
        expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(foldOf(p).nets.get(q.pid) ?? 0n) - Number(foldOf(p).held.get(q.pid) ?? 0n));
      }
      expect(p.casino.readCageLedger().houseNet).toBe(0 - [...foldOf(p).nets.values()].reduce((x, y) => x + Number(y), 0));
    }
    expect(biggest).toBeLessThan(250 * 1024);
  }, 60_000);
});

describe('compaction', () => {
  /** A, B and C at the table; A and B played rounds 1 and 2, A has chips on
   *  round 3; then the table ends: removed (what clearTableKeys will write),
   *  marked gone alone, or switched off with no mark. */
  async function removed(how: 'removed' | 'marked' | 'switched off'): Promise<{
    pages: Page[]; chips: number[]; nets: Map<string, bigint>; close: string; felt: string; at: number;
  }> {
    const pages = await room(['A', 'B', 'C']);
    const [a, b] = pages;
    const r1 = playRound([a, b], T0);
    const { openAt } = playRound([a, b], r1.openAt);
    sync(openAt, ...pages);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], openAt)).toBe('ok');
    sync(openAt, ...pages);
    const nets = new Map(foldOf(a).nets);
    const close = foldOf(a).rounds[1].close;
    const felt = foldOf(a).felts.get(a.pid)!.rec.c;
    a.doc.transact(() => {
      if (how !== 'switched off') a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      if (how === 'removed') a.doc.getMap('casino').set(`gone:${TABLE}:`, 1);
      if (how !== 'marked') a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    sync(openAt, ...pages);
    const chips = chipsOn(a, pages);
    for (const p of pages) {
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
      expect(p.casino.computedEndedIncs().map((e) => `${e.t}:${e.inc}`)).toEqual([`${TABLE}:${INC}`]);
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(nets.get(q.pid) ?? 0n));
    }
    return { pages, chips, nets, close, felt, at: openAt };
  }

  it('finalises a removed incarnation, in turn among its bettors, COMPACT_MS after the end: its nets count on, its sessions go', async () => {
    for (const [away, how] of [[0, 'removed'], [1, 'marked']] as const) {
      const { pages, chips, nets, close, felt, at } = await removed(how);
      const [a, b] = pages;
      const cages = pages.map((p) => p.casino.readCageLedger());
      const order = byRank([a, b], 'trim', 3);
      const live = [...order.slice(away), pages[2]];
      // The table is gone from the room: no page passes it.
      const done = runOn(live, live, at + STEP, at + 30_000, () => sessionsOf(live[0]).length === 0);
      expectAt(done, at + STEP + a.table.COMPACT_MS + away * 1_500);
      sync(done, ...pages);
      const cp = cpOf(a)!;
      expect(cp).toMatchObject({ v: 1, e: 1, b: 'g', k: live[0].pub, u: 2, l: close });
      expect(cp.n).toEqual(Object.fromEntries([...nets].map(([pid, n]) => [pid, n.toString()])));
      for (const p of pages) {
        expect(sessionsOf(p)).toEqual([]);
        expect(p.doc.getMap('casino').get(`gone:${TABLE}:${INC}`)).toBe(1);
        expect(chipsOn(p, pages)).toEqual(chips);
        expect(p.casino.readCageLedger()).toEqual(cages[0]);
        expect(p.casino.casinoWhole(TABLE)).toBe(true);
        expect(p.casino.computedEndedIncs()).toEqual([]);
      }
      // Nobody writes it twice; every page lets go of what it wrote for it, seeds and all.
      runOn(pages, pages, done + STEP, done + 70_000);
      expect(cpOf(a)).toEqual(cp);
      expect(a.fair.seedFor(felt, seedCtx(a, 3))).toBeNull();
    }
  });

  it('a table switched to a new incarnation: the page lets go of the old one’s felt and seed on its next frame', async () => {
    const [a] = await room(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = foldOf(a).felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    const INC2 = 'c' + '5d'.repeat(12);
    switchOn(a, TABLE, INC2);
    expect(a.casino.computedEndedIncs().map((e) => `${e.t}:${e.inc}`)).toEqual([`${TABLE}:${INC}`]);
    runOn([a], [], T0 + STEP, T0 + 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    // (Nothing of it went into the new incarnation's session.)
    expect(keysIn(a, 's')).toEqual([]);
    expect(foldOf(a).held.size).toBe(0);
  });

  it('a page with no slip in it compacts after COMPACT_FALLBACK_MS; a switch deleted with no mark gets one', async () => {
    const { pages, chips, at } = await removed('switched off');
    const c = pages[2];
    const done = runOn([c], pages, at + STEP, at + 90_000, () => sessionsOf(c).length === 0);
    expectAt(done, at + STEP + c.table.COMPACT_FALLBACK_MS);
    expect(cpOf(c)).toMatchObject({ e: 1, k: c.pub });
    for (const p of pages) {
      expect(p.doc.getMap('casino').get(`gone:${TABLE}:${INC}`)).toBe(1);
      expect(chipsOn(p, pages)).toEqual(chips);
    }
  });

  it('the wait starts again on a wake', async () => {
    const { pages, at } = await removed('removed');
    const [a] = byRank(pages.slice(0, 2), 'trim', 3);
    runOn([a], pages, at + STEP, at + 8_000);
    // Asleep for a lapse: it wakes, waits out the lapse, and times COMPACT_MS from the wake.
    const woke = at + 8_000 + TABLE_LEASE_LAPSE_MS + 1_000;
    const done = runOn([a], pages, woke, woke + 30_000, () => sessionsOf(a).length === 0);
    expectAt(done, woke + a.table.COMPACT_MS);
  });

  it('a session someone writes after the end counts nothing on any page, and goes too, the checkpoint kept', async () => {
    const { pages, chips, at } = await removed('removed');
    const done = runOn(pages, pages, at + STEP, at + 30_000, () => sessionsOf(pages[0]).length === 0);
    // Every page sees it compacted.
    const after = runOn(pages, pages, done + STEP, done + STEP);
    const end = cpOf(pages[0])!;
    const cages = pages.map((p) => p.casino.readCageLedger());
    // A whole decided round, by a player of the room, under the sid the end names.
    const X = testIdentity('trim-late', pages[0].pid);
    const [a] = pages;
    const forged = new ComputedKit(CTX);
    const ses = new Y.Map<unknown>();
    const xs = forged.slip(X, 2, [straight(1, 50)], { p: a.pid });
    const xc = forged.close(X, 2, nextSid(CTX, end), [xs]);
    a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:${INC}:${nextSid(CTX, end)}`, ses));
    a.doc.transact(() => {
      ses.set(xs.key, xs.rec);
      ses.set(xc.key, xc.rec);
      ses.set(forged.reveal(2, a.pid).key, forged.reveal(2, a.pid).rec);
    });
    sync(after, ...pages);
    for (const p of pages) {
      expect(chipsOn(p, pages)).toEqual(chips);
      expect(p.casino.readCageLedger()).toEqual(cages[0]);
      expect(p.casino.computedEndedIncs().map((e) => e.res.rounds.length)).toEqual([0]);
    }
    // Nobody signed anything in it: the fallback from when each page saw it, and only the map goes.
    const gone = runOn(pages, pages, after, after + 90_000, () => sessionsOf(a).length === 0);
    expectAt(gone, after + a.table.COMPACT_FALLBACK_MS);
    for (const p of pages) {
      expect(cpOf(p)).toEqual(end);
      expect(chipsOn(p, pages)).toEqual(chips);
    }
  });

  it("waits on a doc holding part of an update, for the room's state, and for signatures to check", async () => {
    // Part of an update.
    {
      const { pages, at } = await removed('removed');
      const [x] = byRank(pages.slice(0, 2), 'trim', 3);
      const [first, later] = updatesOf(pages[2], () => {
        pages[2].doc.getMap('casino').set(`seat:${TABLE}:${pages[2].pid}`, { stand: 0, angle: 0, at: 1 });
        pages[2].doc.getMap('casino').set(`seat:${TABLE}:${pages[2].pid}`, { stand: 1, angle: 0, at: 2 });
      });
      deliver(at, x, [later]);
      runOn([x], [], at + STEP, at + 20_000);
      expect(sessionsOf(x)).toHaveLength(1);
      deliver(at + 20_000, x, [first]);
      expect(runOn([x], [], at + 20_200, at + 30_000, () => sessionsOf(x).length === 0)).toBe(at + 20_200);
    }
    // The room's state: a page reloading on its cached doc waits for it.
    {
      const { pages, at } = await removed('removed');
      const [x] = byRank(pages.slice(0, 2), 'trim', 3);
      vi.setSystemTime(at);
      const again = await loadPage(x.name, 9, { reloadOf: x });
      again.croupier.setRoomStateArrivedCheck(() => false);
      expect(again.croupier.roomStateIn(at)).toBe(false);
      Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(x.doc));
      const done = runOn([again], [], at + STEP, at + ROOM_STATE_WAIT_MS + 20_000, () => sessionsOf(again).length === 0);
      expectAt(done, at + ROOM_STATE_WAIT_MS);
    }
    // A record still to be checked: the other bettor's felt (its newest
    // version), written into the session as the table went.
    {
      const { pages, at } = await removed('removed');
      const [x, y] = byRank(pages.slice(0, 2), 'trim', 3);
      x.casino.setComputedVerifyForTests({ budgetMs: 0 });
      const late = signAs(y, 'slip', { r: 3, p: y.pid, v: 9, b: [red(2)], c: 'ab'.repeat(32) });
      y.doc.transact(() => (computedOf(y).get(`ses:${TABLE}:${INC}:g`) as Y.Map<unknown>).set(slipKey(late)!, late));
      sync(at, x, y);
      expect(x.casino.computedSettled(TABLE)).toBe(false);
      runOn([x], [], at + STEP, at + 20_000);
      expect(sessionsOf(x)).toHaveLength(1);
      x.casino.setComputedVerifyForTests({ now: () => 0 });
      await flush();
      expect(x.casino.computedSettled(TABLE)).toBe(true);
      expect(runOn([x], [], at + 20_200, at + 30_000, () => sessionsOf(x).length === 0)).toBe(at + 20_200);
    }
  });

  it('an end written with no mark is compacted all the same: the maps go, the mark comes, the end stands', async () => {
    const pages = await room(['A', 'B']);
    const [a] = pages;
    const { openAt } = playRound(pages, T0);
    const D = foldOf(a).rounds[0];
    const end = kit.checkpoint(testIdentity('trim-end'), 'g', 1, D.close, Object.fromEntries(foldOf(a).nets), 1);
    a.doc.transact(() => computedOf(a).set(`sum:${TABLE}:${INC}`, end));
    sync(openAt, ...pages);
    for (const p of pages) expect(p.casino.isComputedTable(TABLE)).toBe(false);
    // Its session counts nothing now: nobody's turn, the fallback.
    const done = runOn(pages, pages, openAt + STEP, openAt + 90_000, () => pages.every((p) => !computedOf(p).has(`ses:${TABLE}:${INC}:g`)));
    expectAt(done, openAt + STEP + a.table.COMPACT_FALLBACK_MS);
    for (const p of pages) {
      expect(cpOf(p)).toEqual(end);
      expect(p.doc.getMap('casino').get(`gone:${TABLE}:${INC}`)).toBe(1);
      expect(p.casino.computedEndedIncs()).toEqual([]);
    }
  });

  it('an incarnation with no round decided ends on a checkpoint all the same: no page reads the table as lost', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    sync(T0, a, b);
    a.doc.transact(() => {
      a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    // A, its felt on the open round, in line; B, none, after the fallback.
    const done = runOn(pages, pages, T0 + STEP, T0 + 30_000, () => sessionsOf(a).length === 0);
    expectAt(done, T0 + STEP + a.table.COMPACT_MS);
    for (const p of pages) {
      expect(cpOf(p)).toMatchObject({ e: 1, u: 1, l: '0'.repeat(32), n: {} });
      expect(p.casino.casinoWhole(TABLE)).toBe(true);
      expect(p.casino.readChips(a.pid)).toBe(1_000);
    }
  });
});

describe('the casinoDoc writes', () => {
  it('writeCheckpointAndTrim refuses a checkpoint of a session no longer live, an end, an incarnation not live, a partial doc', async () => {
    const pages = await room(['A', 'O']);
    const [a, o] = pages;
    const { openAt } = playRound([a], T0);
    sync(openAt, a, o);
    const res = foldOf(a);
    const D = res.rounds[0];
    const n = Object.fromEntries([...res.nets].map(([pid, x]) => [pid, x.toString()]));
    const cp = (body: Partial<Checkpoint> = {}): Checkpoint => {
      const rec = { v: 1 as const, b: res.base.sid, u: D.r, l: D.close, n, k: a.pub, ...body };
      return { ...rec, g: a.keypair.signIdentity(a.fold.signBytes('sum', CTX, rec)) } as Checkpoint;
    };
    expect(a.casino.writeCheckpointAndTrim(TABLE, INC, cp({ e: 1 }), [])).toBe(false);
    expect(a.casino.writeCheckpointAndTrim(TABLE, 'c' + '00'.repeat(12), cp(), [])).toBe(false);
    expect(a.casino.writeCheckpointAndTrim(TABLE, INC, cp({ b: 'f'.repeat(24) }), [])).toBe(false);
    expect(a.casino.writeCheckpointAndTrim(TABLE, INC, { ...cp(), u: 0 } as Checkpoint, [])).toBe(false);
    expect(sessionsOf(a)).toEqual([`ses:${TABLE}:${INC}:g`]);
    // On part of an update.
    const [first, later] = updatesOf(o, () => {
      o.doc.getMap('casino').set(`seat:${TABLE}:${o.pid}`, { stand: 0, angle: 0, at: 1 });
      o.doc.getMap('casino').set(`seat:${TABLE}:${o.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(openAt, a, [later]);
    expect(a.casino.writeCheckpointAndTrim(TABLE, INC, cp(), [])).toBe(false);
    deliver(openAt, a, [first]);
    // A table whose id runs on past this one's keeps its session; the copies go across.
    const LONG = `${TABLE}:${INC}`;
    const INC2 = 'c' + '7c'.repeat(12);
    switchOn(a, LONG, INC2);
    expect(a.casino.writeCheckpointAndTrim(TABLE, INC, cp(), [['junk', 'kept']])).toBe(true);
    expect(computedOf(a).has(`ses:${LONG}:${INC2}:g`)).toBe(true);
    expect(computedOf(a).has(`ses:${TABLE}:${INC}:g`)).toBe(false);
    expect(computedOf(a).has(`ses:${TABLE}:${INC}:${nextSid(CTX, cp())}`)).toBe(true);
    expect(a.casino.computedSessionForWrite(TABLE)!.get('junk')).toBe('kept');
    // The same again: the session it closes is gone.
    expect(a.casino.writeCheckpointAndTrim(TABLE, INC, cp(), [])).toBe(false);
    expect(foldOf(a).base.u).toBe(1);
  });

  it('finalizeComputed refuses a checkpoint that is no end, or ends another session, or a partial doc; with none, only over an end', async () => {
    const pages = await room(['A', 'O']);
    const [a, o] = pages;
    const { openAt } = playRound([a], T0);
    sync(openAt, a, o);
    const res = foldOf(a);
    const D = res.rounds[0];
    const n = Object.fromEntries([...res.nets].map(([pid, x]) => [pid, x.toString()]));
    const cp = (body: Partial<Checkpoint> = {}): Checkpoint => {
      const rec = { v: 1 as const, b: res.base.sid, u: D.r, l: D.close, n, e: 1 as const, k: a.pub, ...body };
      return { ...rec, g: a.keypair.signIdentity(a.fold.signBytes('sum', CTX, rec)) } as Checkpoint;
    };
    expect(a.casino.finalizeComputed(TABLE, INC, cp({ e: undefined }))).toBe(false);
    expect(a.casino.finalizeComputed(TABLE, INC, cp({ b: 'f'.repeat(24) }))).toBe(false);
    expect(a.casino.finalizeComputed(TABLE, INC, null)).toBe(false);
    expect(a.casino.finalizeComputed(TABLE, 'c' + '00'.repeat(12), cp())).toBe(false);
    expect(sessionsOf(a)).toHaveLength(1);
    const [first, later] = updatesOf(o, () => {
      o.doc.getMap('casino').set(`seat:${TABLE}:${o.pid}`, { stand: 0, angle: 0, at: 1 });
      o.doc.getMap('casino').set(`seat:${TABLE}:${o.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(openAt, a, [later]);
    expect(a.casino.finalizeComputed(TABLE, INC, cp())).toBe(false);
    deliver(openAt, a, [first]);
    const chips = a.casino.readChips(a.pid);
    // A switch-off writes it on a live incarnation: it marks the end itself.
    expect(a.casino.finalizeComputed(TABLE, INC, cp())).toBe(true);
    expect(sessionsOf(a)).toEqual([]);
    expect(a.doc.getMap('casino').get(`gone:${TABLE}:${INC}`)).toBe(1);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    expect(a.casino.readChips(a.pid)).toBe(chips);
    expect(a.casino.finalizeComputed(TABLE, INC, null)).toBe(true);
  });
});

// ── helpers the specs above read records with ───────────────────────────────

function closesOf(p: Page): CloseRec[] {
  return keysIn(p, 'c').map((k) => asClose(recOf(p, k))!);
}

function slipsOf(p: Page, r: number, pid: string): SlipRec[] {
  return keysIn(p, 's', r).filter((k) => k.startsWith(`s:${r}:${pid}:`)).map((k) => asSlip(recOf(p, k))!);
}
