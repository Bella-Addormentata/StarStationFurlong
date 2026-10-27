/**
 * 🎲🧮🧹 A computed craps table's page duties (computedTable at a `k`
 * incarnation): slips with their stamp and stand, ride slips, the wait for
 * the throw and the closes during and after it, the re-arms, the goodbye,
 * and every duty reading craps slips through the craps reader.
 *
 * Each page is its own load of the casino modules with its own Y.Doc,
 * player id and identity key (computedPageKit), synced by hand, every clock
 * explicit; each page's table session stands where a spec puts it
 * (standAt), and a spec chooses the seeds a roll's dice come from
 * (rigRoll). Who closes first is whoever dutyRank puts first for that
 * page's key, so specs that care work the order out from the keys.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basisOf, EMPTY_CARRY } from './computedCraps';
import { asClose, forfeitKey } from './computedFold';
import type { CloseRec, CrapsSlipRec } from './computedFold';
import {
  byRank, carryOf, clockOf, CRAPS_CTX as CTX, CRAPS_INC as INC, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, crapsPointOn,
  deleteIn, frame, keysIn, loadPage, openCrapsRoom, openRoom, PAGE_INC, PAGE_TABLE, putIn, rigRoll, rigSplit, run, signAs, standAt, switchOn,
  sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit, red, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import type { CrapsBet } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

// Every duty reads a craps table's slips with the craps reader (computedFold
// asSlipFor, slipKeyFor): roulette's, taken from anywhere but the fold
// itself, throws in every page these specs load.
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
const ABANDON = 30_000;
const AWAY = 60_000;
const kit = new ComputedKit(CTX);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const room = (names: string[]): Promise<Page[]> => openCrapsRoom(names, T0);
const bet = (type: CrapsBet['type'], amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r, TABLE).map((k) => asClose(recOf(p, k))!);
const slipsOf = (p: Page, r: number, pid: string): CrapsSlipRec[] =>
  keysIn(p, 's', r, TABLE).filter((k) => k.startsWith(`s:${r}:${pid}:`)).map((k) => recOf<CrapsSlipRec>(p, k))
    .sort((x, y) => x.v - y.v);
const latestOf = (p: Page, pid: string): CrapsSlipRec | undefined => foldOf(p).felts.get(pid)?.rec as CrapsSlipRec | undefined;
const seedOf = (p: Page, r: number): string[] => keysIn(p, 'x', r, TABLE).filter((k) => k.startsWith(`x:${r}:${p.pid}:`));
/** Frames of `pages` at the craps table from `from` to `to`, until `until`. */
const go = (pages: Page[], from: number, to: number, until?: () => boolean): number =>
  run(pages, from, to, { step: STEP, tables: [REF], until });
/** …until every page has roll r decided. */
const decide = (pages: Page[], r: number, from: number, to = from + 60_000): number =>
  go(pages, from, to, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === r && v.decided !== null)));

/** Test identities as players of the room: each pinned on page p. */
function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Pages `names` at `stands` make the point on roll 1 (computedPageKit
 *  crapsPointOn): A's pass 10, B's 5, C's 20. */
const pointSix = (stands: (number | null)[], names = ['A', 'B']) => crapsPointOn(names, stands, T0);

describe('a roll, start to finish', () => {
  it('two players at their stands: the close at the end of betting, the dice to the first stand clockwise, their wait and their fling', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll([a, b], 1, 6);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5), bet('field', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    for (const p of pages) {
      expect(crapsOf(p, T0)).toMatchObject({ kind: 'craps', phase: 'betting', round: 1, point: null, phaseDeadline: T0 + W_MS, shooterInPlay: false });
      expect(crapsOf(p, T0)!.holder).toBeUndefined();
    }
    // The slip: its felt, the stamp of the table it was built on, the stand.
    expect(latestOf(a, b.pid)).toMatchObject({ b: [bet('field', 5), bet('pass', 5)], o: basisOf(EMPTY_CARRY, b.pid), t: 3 });
    expect(a.casino.readChips(a.pid)).toBe(990);

    // Nobody holds the dice: no wait, the close in turn at W.
    const closedAt = go(pages, T0 + STEP, T0 + 30_000, () => keysIn(a, 'c', 1, TABLE).length > 0);
    expect(closedAt).toBeGreaterThanOrEqual(T0 + W_MS);
    expect(closedAt).toBeLessThan(T0 + W_MS + STAGGER + STEP);
    const decidedAt = go(pages, closedAt + STEP, closedAt + 10_000, () => pages.every((p) => foldOf(p).rounds[0]?.decided === 'reveals'));
    for (const p of pages) {
      const v = crapsOf(p, decidedAt)!;
      expect(v).toMatchObject({ phase: 'settled', round: 1, point: 6, result: 6 });
      expect(v.rollKey).toBe(`1:${v.dice![0]}${v.dice![1]}`);
      // The dice to the first stand of the ring (3, 4, 5, 7, 2, 1, 6): B's.
      expect(carryOf(p)).toMatchObject({ p: 6, h: b.pid, i: 1 });
      expect(v.shooterAfter).toBe(b.pid);
    }

    // Roll 2: the riders' bets go down as ride slips once the show is over.
    const showEnd = crapsOf(a, decidedAt)!.resultAt + SHOW;
    rigRoll([a, b], 2, 6);
    const openedAt = go(pages, decidedAt + STEP, decidedAt + 20_000, () => pages.every((p) => crapsOf(p)?.phaseDeadline !== undefined));
    expect(openedAt).toBeGreaterThanOrEqual(showEnd);
    const W = crapsOf(a)!.phaseDeadline!;
    expect(W).toBe(showEnd + W_MS);
    expect(latestOf(a, a.pid)).toMatchObject({ b: [bet('pass', 10)], t: 1 });
    expect(latestOf(a, b.pid)).toMatchObject({ b: [bet('pass', 5)], t: 3 });
    for (const p of pages) expect(crapsOf(p)).toMatchObject({ phase: 'betting', round: 2, point: 6, shooter: b.pid, holder: b.pid, shooterInPlay: true });

    // The wait: B's page offers the fling, A's waits for it; nobody closes.
    go(pages, openedAt + STEP, W + 3_000);
    expect(keysIn(a, 'c', 2, TABLE)).toEqual([]);
    expect(crapsOf(b, W + 3_000)).toMatchObject({ phase: 'closing', round: 2, phaseDeadline: W + WAIT_MS, shooter: b.pid, shooterSlip: 'here' });
    expect(crapsOf(a, W + 3_000)).toMatchObject({ phase: 'closing', shooter: b.pid, shooterSlip: 'here' });
    // B flings: B's page closes on its next tick.
    b.table.noteComputedFling(TABLE, 2, 1234, W + 3_000 + 50);
    expect(b.table.computedFlungFor(TABLE)).toEqual({ r: 2, seed: 1234 });
    frame(W + 3_000 + STEP, b, [REF]);
    expect(closesOf(b, 2)).toHaveLength(1);
    expect(closesOf(b, 2)[0].k).toBe(b.pub);
    sync(W + 3_000 + STEP, ...pages);
    const done = go(pages, W + 3_000 + 2 * STEP, W + 15_000, () => pages.every((p) => foldOf(p).rounds[1]?.decided === 'reveals'));
    for (const p of pages) {
      expect(crapsOf(p, done)).toMatchObject({ phase: 'settled', round: 2, result: 6, point: null });
      // Point made: the shooter keeps the dice; both pass bets won.
      expect(carryOf(p)).toMatchObject({ p: 0, h: b.pid, i: 1 });
      expect(p.casino.readChips(a.pid)).toBe(1_010);
    }
    expect(closesOf(a, 2)).toHaveLength(1);
  });
});

describe('the craps reader', () => {
  it("is the only one a craps table's slips are read with: no module but the fold imports roulette's", () => {
    const dir = new URL('./', import.meta.url);
    const kits = new Set(['computedFold.ts', 'computedTestKit.ts', 'computedPageKit.ts']);
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !kits.has(f));
    expect(files).toContain('computedTable.ts');
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      for (const [, names] of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'\.{1,2}\/(?:[\w/]*\/)?computedFold'/g)) {
        expect(names, f).not.toMatch(/\basSlip\b|\bslipKey\b/);
      }
    }
  });
});

describe("roulette's slip reader", () => {
  it('throws in every page these specs load: a duty reading a craps slip with it fails its spec', async () => {
    const [a] = await room(['A']);
    expect(() => a.fold.asSlip({})).toThrow(/roulette's slip reader/);
    expect(() => a.fold.slipKey({} as never)).toThrow(/roulette's slip reader/);
  });
});

describe('a name of the other game', () => {
  it('runs nothing under a table of the other game, and ends AWAY_MS on: a craps name under a roulette table, a roulette one under a craps table', async () => {
    // A craps name under the roulette table, ticked as World passes roulette
    // tables (a bare id).
    const [a] = await openRoom(['A'], T0, [], { t: PAGE_TABLE, inc: INC });
    expect(a.casino.isComputedTable(PAGE_TABLE)).toBe(true);
    expect(a.table.readComputedRoulette(PAGE_TABLE, T0)).toBeNull();
    expect(a.table.writeComputedSlip(PAGE_TABLE, [red(10)], T0)).toBe('reconnecting');
    const ended = run([a], T0, T0 + AWAY + 5_000, { step: STEP, tables: [PAGE_TABLE], until: () => !a.casino.isComputedTable(PAGE_TABLE) });
    expect(ended - T0).toBeGreaterThanOrEqual(AWAY);
    expect(ended - T0).toBeLessThanOrEqual(AWAY + STEP);

    // A roulette name under the craps table, a felt held on it, nobody
    // closing it.
    const [b] = await openRoom(['B'], T0, [], { t: TABLE, inc: PAGE_INC });
    expect(b.table.readComputedCraps(TABLE, T0)).toBeNull();
    expect(b.table.writeComputedCrapsSlip(TABLE, [bet('pass', 10)], basisOf(EMPTY_CARRY, b.pid), T0)).toBe('reconnecting');
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.casino.readChips(b.pid)).toBe(990);
    go([b], T0, T0 + 40_000);
    expect(keysIn(b, 'c', 1, TABLE)).toEqual([]);
    const ended2 = go([b], T0 + 40_000 + STEP, T0 + AWAY + 5_000, () => !b.casino.isComputedTable(TABLE));
    expect(ended2 - T0).toBeGreaterThanOrEqual(AWAY);
    expect(ended2 - T0).toBeLessThanOrEqual(AWAY + STEP);
    expect(b.casino.readChips(b.pid)).toBe(1_000);
  });

  it("lives on under its own game's table", async () => {
    const [a] = await room(['A']);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    go([a], T0, T0 + AWAY + 10_000);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(a.table.computedDecidedTo(TABLE)).toBe(1);
  });
});

describe('ride slips', () => {
  it("put a rider's riding bets down once betting opens: from their stand with it; off the table only once another player plays the roll, with none", async () => {
    const { pages, decidedAt, showEnd } = await pointSix([1, 3]);
    const [a, b] = pages;
    standAt(a, null);
    // Nothing during the show.
    go(pages, decidedAt + STEP, showEnd - STEP);
    expect(keysIn(a, 's', 2, TABLE)).toEqual([]);
    const at = go(pages, showEnd, showEnd + 5_000, () => pages.every((p) => latestOf(p, a.pid)?.r === 2 && latestOf(p, b.pid)?.r === 2));
    expect(at).toBeLessThan(showEnd + 1_000);
    for (const p of pages) {
      expect(latestOf(p, b.pid)).toMatchObject({ r: 2, v: 1, b: [bet('pass', 5)], o: basisOf(carryOf(p), b.pid), t: 3 });
      expect(latestOf(p, a.pid)).toMatchObject({ r: 2, v: 1, b: [bet('pass', 10)], o: basisOf(carryOf(p), a.pid) });
      expect(latestOf(p, a.pid)!.t).toBeUndefined();
      expect(latestOf(p, a.pid)!.l).toBeUndefined();
      // (No chip moves: the riding bets were set aside already.)
      expect(p.casino.readChips(a.pid)).toBe(990);
    }
  });

  it('a lone rider off the table writes none: the roll takes bets on, the riding bets held; back at a stand, the ride slip goes with it', async () => {
    const { pages: [a], decidedAt, showEnd } = await pointSix([1], ['A']);
    expect(carryOf(a)).toMatchObject({ h: a.pid, i: 1 });
    standAt(a, null);
    const T = showEnd + 2 * W_MS + WAIT_MS;
    go([a], decidedAt + STEP, T);
    expect(keysIn(a, 's', 2, TABLE)).toEqual([]);
    expect(crapsOf(a, T)).toMatchObject({ phase: 'betting', round: 2, point: 6 });
    expect(a.table.readComputedCrapsBets(TABLE, 2, T)).toEqual({ [a.pid]: [bet('pass', 10)] });
    expect(a.casino.readChips(a.pid)).toBe(990);
    standAt(a, 1);
    go([a], T + STEP, T + STEP);
    expect(latestOf(a, a.pid)).toMatchObject({ r: 2, v: 1, b: [bet('pass', 10)], t: 1 });
  });
});

describe('the stand on a slip', () => {
  it("comes from this page's table session alone: a seat record in the doc gives none, and its sweep takes none away", async () => {
    const { pages, decidedAt, showEnd } = await pointSix([null, 3]);
    const [a, b] = pages;
    // (A wrote no stand on roll 1: the dice went to B.)
    expect(carryOf(a)).toMatchObject({ h: b.pid, i: 1 });
    go(pages, decidedAt + STEP, showEnd - 2 * STEP);
    // A seat record for A at stand 1, as a peer (or a closed tab) leaves one.
    clockOf(b, showEnd - STEP);
    b.casino.writeMySeat(TABLE, a.pid, { stand: 1, angle: 0, at: showEnd - STEP });
    const at = go(pages, showEnd - STEP, showEnd + 5_000, () => latestOf(a, a.pid)?.r === 2);
    expect(latestOf(a, a.pid)!.t).toBeUndefined();
    // At a stand now: the version goes again with it, felt and stamp as they were.
    standAt(a, 5);
    const moved = go(pages, at + STEP, at + 5_000, () => latestOf(b, a.pid)?.t === 5);
    expect(latestOf(b, a.pid)).toMatchObject({ r: 2, v: 2, b: [bet('pass', 10)], o: basisOf(carryOf(b), a.pid), t: 5 });
    // The seat record swept: the slip keeps its stand.
    clockOf(b, moved);
    b.casino.clearMySeat(TABLE, a.pid);
    go(pages, moved + STEP, moved + 3_000);
    expect(latestOf(b, a.pid)).toMatchObject({ v: 2, t: 5 });
    expect(slipsOf(b, 2, a.pid)).toHaveLength(2);
  });
});

describe('a roll rewritten under the next', () => {
  it('drops a change held back on the roll before as it was (once, for the notice), no chip of it held; a version built on it goes again as the riding bets once betting opens again', async () => {
    const pages = await room(['A', 'B']);
    const stand = new Map([[pages[0], 1], [pages[1], 3]]);
    for (const [p, s] of stand) standAt(p, s);
    // w writes the forfeit that rewrites roll 1: first in rank, so nobody
    // answers it. Both seeds a natural 7; w's alone a 6.
    const [w, x] = byRank(pages, 'forfeit', 1, CTX);
    rigSplit(pages, 1, 7, w, 6);
    for (const p of pages) expect(crapsBet(p, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    expect(foldOf(w).rounds[0]).toMatchObject({ decided: 'reveals' });
    expect(carryOf(w).p).toBe(0);
    const close = foldOf(w).rounds[0].close;
    const showEnd = crapsOf(w, decidedAt)!.resultAt + SHOW;
    const was = basisOf(carryOf(w), w.pid);
    for (const p of pages) expect(p.casino.readChips(w.pid)).toBe(1_010);

    // Roll 2: w puts the pass line down, then a field bet with it, held
    // back with the coalescing.
    go(pages, decidedAt + STEP, showEnd + 1_000);
    const T = showEnd + 1_000 + STEP;
    expect(crapsBet(w, [bet('pass', 10)], T)).toBe('ok');
    expect(crapsBet(w, [bet('pass', 10), bet('field', 5)], T + 50)).toBe('ok');
    expect(slipsOf(w, 2, w.pid)).toHaveLength(1);
    expect(w.table.readMyComputedCrapsBets(TABLE, w.pid, 2, T + 50)).toEqual({ felt: [bet('field', 5), bet('pass', 10)], basis: was });

    // The rewrite: w's forfeit of roll 1 counts w's seed alone, a 6. The
    // point is on, w's pass rides on it; x's seed didn't count, its pass lost.
    clockOf(w, T + 100);
    const f = signAs(w, 'forfeit', { r: 1, x: close, n: [w.pid] }, CTX);
    putIn(w, [[forfeitKey(f)!, f]], TABLE);
    sync(T + 100, ...pages);
    for (const p of pages) {
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'forfeit', counted: [w.pid] });
      expect(carryOf(p)).toMatchObject({ p: 6, h: w.pid, i: 1 });
    }
    const now = basisOf(carryOf(w), w.pid);
    expect(now).not.toBe(was);
    frame(T + STEP, w, [REF]);
    expect(w.table.computedUndoneCount(TABLE)).toBe(1);
    expect(x.table.computedUndoneCount(TABLE)).toBe(0);
    expect(w.table.readMyComputedCrapsBets(TABLE, w.pid, 2, T + STEP).felt).not.toContainEqual(bet('field', 5));
    // The roll before shows again, as the forfeit decided it.
    expect(crapsOf(w, T + STEP)).toMatchObject({ phase: 'settled', round: 1, result: 6, point: 6 });

    const again = go(pages, T + 2 * STEP, T + 30_000, () => pages.every((p) => latestOf(p, w.pid)?.v === 2));
    expect(again).toBeGreaterThanOrEqual(T + 100 + SHOW);
    for (const p of pages) {
      expect(latestOf(p, w.pid)).toMatchObject({ r: 2, v: 2, b: [bet('pass', 10)], o: now, t: stand.get(w) });
      expect(p.table.readComputedCrapsBets(TABLE, 2, again)).toEqual({ [w.pid]: [bet('pass', 10)] });
      // No phantom bet: the pass rides on its point, nothing else is held.
      expect(p.casino.readChips(w.pid)).toBe(990);
      expect(p.casino.readChips(x.pid)).toBe(990);
    }
    for (const s of slipsOf(w, 2, w.pid)) expect(s.b).not.toContainEqual(bet('field', 5));
    expect(w.table.computedUndoneCount(TABLE)).toBe(1);
  });
});

describe('a commitment out', () => {
  it('a felt whose seed went out for a close that is gone goes again under a fresh seed, its stamp and stand as they were', async () => {
    const pages = await room(['A', 'B']);
    const stand = new Map([[pages[0], 1], [pages[1], 3]]);
    for (const [p, s] of stand) standAt(p, s);
    for (const [i, p] of pages.entries()) expect(crapsBet(p, [bet('pass', 10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const [first, second] = byRank(pages, 'close', 1, CTX);
    const at = go([first], T0 + STEP, T0 + 30_000, () => keysIn(first, 'c', 1, TABLE).length > 0);
    const was = latestOf(second, second.pid)!;
    const close = keysIn(first, 'c', 1, TABLE);
    sync(at, first, second);
    frame(at + STEP, second, [REF]);
    expect(seedOf(second, 1)).toHaveLength(1);
    deleteIn(second, close, TABLE);
    expect(foldOf(second).tip).toBeNull();
    frame(at + 2 * STEP, second, [REF]);
    const now = latestOf(second, second.pid)!;
    expect(now.c).not.toBe(was.c);
    expect(now).toMatchObject({ r: 1, v: 2, b: was.b, o: was.o, t: stand.get(second) });
    expect(now.l).toBeUndefined();
  });

  it('freezes no felt whose seed this page saw revealed, the reveal gone too: the close afresh after the stand-down leaves it out', async () => {
    const pages = await room(['A', 'B', 'C']);
    pages.forEach((p, i) => standAt(p, [1, 3, 5][i]));
    for (const [i, p] of pages.entries()) expect(crapsBet(p, [bet('pass', 10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const [first, second, third] = byRank(pages, 'close', 1, CTX);
    const at = go([first], T0 + STEP, T0 + 30_000, () => keysIn(first, 'c', 1, TABLE).length > 0);
    sync(at, ...pages);
    // Second and third reveal; third sees second's seed.
    frame(at + STEP, second, [REF]);
    frame(at + STEP, third, [REF]);
    sync(at + STEP, second, third);
    frame(at + 2 * STEP, third, [REF]);
    const old = latestOf(third, second.pid)!;
    expect(foldOf(third).revealedCommits.has(old.c)).toBe(true);
    // On third's page the close goes, and second's reveal with it.
    deleteIn(third, [...keysIn(third, 'c', 1, TABLE), ...seedOf(second, 1)], TABLE);
    expect(foldOf(third).revealedCommits.has(old.c)).toBe(false);
    // Third alone from here: its own seed is out (it keeps its reveal), so
    // it stands down ABANDON_MS, then closes afresh on its fresh seed.
    const closedAt = go([third], at + 3 * STEP, at + 90_000, () => keysIn(third, 'c', 1, TABLE).length > 0);
    expect(closedAt).toBeGreaterThanOrEqual(at + ABANDON);
    const [c] = closesOf(third, 1);
    expect(c.f[second.pid]).toBeUndefined();
    expect(Object.keys(c.f).sort()).toEqual([first.pid, third.pid].sort());
    expect(recOf<CrapsSlipRec>(third, `s:1:${third.pid}:${c.f[third.pid]}`).v).toBe(2);
  });
});

describe('a witness', () => {
  it("puts back a departed bettor's frozen craps slip byte for byte: the roll, the dice's holder and every chip as they were", async () => {
    const { pages, decidedAt } = await pointSix([1, 3]);
    const D = foldOf(pages[0]).rounds[0];
    const witness = pages.find((p) => p.pub === D.closeRec.k)!;
    const gone = pages.find((p) => p !== witness)!;
    const key = `s:1:${gone.pid}:${D.frozen[gone.pid]}`;
    const bytes = JSON.stringify(recOf(witness, key));
    const out = JSON.stringify(D.craps!.sOut);
    const chips = pages.map((p) => witness.casino.readChips(p.pid));
    go([witness], decidedAt + STEP, decidedAt + 2_000);
    const T = decidedAt + 2_000 + STEP;
    clockOf(witness, T);
    deleteIn(witness, [key], TABLE);
    expect(recOf(witness, key)).toBeUndefined();
    expect(foldOf(witness).rounds[0]?.decided ?? null).not.toBe('reveals');
    const back = go([witness], T + STEP, T + 20_000, () => JSON.stringify(recOf(witness, key)) === bytes);
    expect(back).toBeLessThan(T + 20_000);
    expect(foldOf(witness).rounds[0]).toMatchObject({ r: 1, close: D.close, decided: 'reveals' });
    expect(JSON.stringify(foldOf(witness).rounds[0].craps!.sOut)).toBe(out);
    expect(pages.map((p) => witness.casino.readChips(p.pid))).toEqual(chips);
  });
});

describe('back from a sleep', () => {
  /** Pages listening to the room as main.ts has them listen. */
  async function hearingRoom(names: string[]): Promise<Page[]> {
    const pages: Page[] = [];
    for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1, { hears: true }));
    for (const p of pages) {
      clockOf(p, T0);
      p.casino.buyInChips(p.pid, 1_000);
    }
    switchOn(pages[0], TABLE, INC);
    sync(T0, ...pages);
    return pages;
  }
  const hear = (p: Page, T: number): void => p.table.noteRoomHeard(clockOf(p, T));
  /** go, every page hearing the room at every step. */
  function goHearing(pages: Page[], from: number, to: number, until?: () => boolean): number {
    for (let T = from; T <= to; T += STEP) {
      for (const p of pages) hear(p, T);
      go(pages, T, T);
      if (until?.()) return T;
    }
    return to + STEP;
  }
  /** A at stand 3 and B at stand 1 make the point on roll 1, A holding the
   *  dice; then A plays roll 2 alone (B's tab gone, its pass riding on) to
   *  its close at the end of the wait. When it closed. */
  async function aloneWithARider(names: string[]) {
    const pages = await hearingRoom(names);
    pages.forEach((p, i) => standAt(p, [3, 1][i]));
    rigRoll(pages, 1, 6);
    pages.forEach((p, i) => expect(crapsBet(p, [bet('pass', [10, 5][i])], T0)).toBe('ok'));
    sync(T0, ...pages);
    const decidedAt = goHearing(pages, T0 + STEP, T0 + 40_000, () => pages.every((p) => foldOf(p).rounds[0]?.decided === 'reveals'));
    const a = pages[0];
    expect(carryOf(a)).toMatchObject({ p: 6, h: a.pid, i: 1 });
    const closedAt = goHearing([a], decidedAt + STEP, decidedAt + 60_000, () => keysIn(a, 'c', 2, TABLE).length > 0);
    expect(foldOf(a).tip).toMatchObject({ r: 2, present: [a.pid] });
    expect(seedOf(a, 2)).toEqual([]);
    return { a, closedAt };
  }

  it("holds its seed back, hearing nobody, for a roll another player's riding bets are in, slip or none: no room of one", async () => {
    const { a, closedAt } = await aloneWithARider(['A', 'B']);
    expect(Object.keys(foldOf(a).tip!.craps!.sIn.w)).toHaveLength(2);
    // A's lid shuts as it closes, and opens 20 s on, its link not back yet.
    const woke = closedAt + 20_000;
    frame(woke, a, [REF]);
    frame(woke + STEP, a, [REF]);
    expect(seedOf(a, 2)).toEqual([]);
    // Its link back: the seed goes.
    hear(a, woke + 2 * STEP);
    frame(woke + 2 * STEP, a, [REF]);
    expect(seedOf(a, 2)).toHaveLength(1);
  });

  it("sends it at once, hearing nobody, for a roll only its own player's bets are in (a room of one)", async () => {
    const { a, closedAt } = await aloneWithARider(['A']);
    expect(Object.keys(foldOf(a).tip!.craps!.sIn.w)).toEqual([a.pid]);
    const woke = closedAt + 20_000;
    frame(woke, a, [REF]);
    expect(seedOf(a, 2)).toHaveLength(1);
    expect(foldOf(a).rounds[1]).toMatchObject({ r: 2, decided: 'reveals' });
  });
});

describe('writing a slip', () => {
  it("says 'rules' for a change the table rules don't allow now, and 'changed' for one built on the roll before as it was; sums a list of chips per spot", async () => {
    const { pages, decidedAt, showEnd } = await pointSix([1, 3]);
    const [a] = pages;
    go(pages, decidedAt + STEP, showEnd + STEP);
    const T = showEnd + 2 * STEP;
    const basis = basisOf(carryOf(a), a.pid);
    // The pass on its point can't come down, nor go up.
    expect(a.table.writeComputedCrapsSlip(TABLE, [], basis, T)).toBe('rules');
    expect(a.table.writeComputedCrapsSlip(TABLE, [bet('pass', 10), bet('pass', 5)], basis, T)).toBe('rules');
    expect(a.table.writeComputedCrapsSlip(TABLE, [bet('pass', 10), bet('field', 5)], basisOf(EMPTY_CARRY, a.pid), T)).toBe('changed');
    expect(slipsOf(a, 2, a.pid)).toHaveLength(1);
    expect(a.table.writeComputedCrapsSlip(TABLE, [bet('field', 2), bet('pass', 10), bet('field', 3)], basis, T)).toBe('ok');
    expect(latestOf(a, a.pid)).toMatchObject({ v: 2, b: [bet('field', 5), bet('pass', 10)], o: basis, t: 1 });
    // The same felt again: nothing to write.
    expect(a.table.writeComputedCrapsSlip(TABLE, [bet('pass', 10), bet('field', 5)], basis, T + 1_000)).toBe('ok');
    expect(slipsOf(a, 2, a.pid)).toHaveLength(2);
    expect(a.casino.readChips(a.pid)).toBe(985);
  });

  it("says 'full' to a newcomer with 31 players on the roll; not to one with chips on it, nor to take everything down", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    const ids = Array.from({ length: 30 }, (_, i) => testIdentity(`x${i}`, `player-x${i}`));
    for (const p of pages) pinOn(p, ...ids);
    for (const id of ids) a.casino.buyInChips(id.pid, 1_000);
    putIn(a, ids.map((id): [string, unknown] => {
      const s = kit.crapsSlip(id, 1, [bet('field', 1)], basisOf(EMPTY_CARRY, id.pid));
      return [s.key, s.rec];
    }), TABLE);
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    expect(crapsBet(a, [bet('pass', 10)], T0 + 100)).toBe('full');
    expect(crapsBet(b, [bet('pass', 5), bet('field', 5)], T0 + 500)).toBe('ok');
    // B takes everything down: a place again for a newcomer.
    expect(crapsBet(b, [], T0 + 900)).toBe('ok');
    sync(T0 + 900, ...pages);
    expect(crapsBet(a, [bet('pass', 10)], T0 + 1_300)).toBe('ok');
    sync(T0 + 1_300, ...pages);
    expect(crapsBet(b, [bet('pass', 5)], T0 + 1_700)).toBe('full');
  });

  it("says 'chips' for more than its chips past what its felt holds, 'closed' outside betting, 'reconnecting' off a computed table; throws on a felt a slip can't carry", async () => {
    const [a] = await room(['A']);
    expect(crapsBet(a, [bet('pass', 10), bet('field', 991)], T0)).toBe('chips');
    expect(crapsBet(a, [bet('pass', 10), bet('field', 990)], T0)).toBe('ok');
    expect(a.casino.readChips(a.pid)).toBe(0);
    expect(crapsBet(a, [bet('pass', 10), bet('field', 980), bet('field', 10)], T0 + 400)).toBe('ok');
    expect(() => crapsBet(a, [{ type: 'nope', amount: 5 } as unknown as CrapsBet], T0 + 800)).toThrow(TypeError);
    expect(() => crapsBet(a, Array.from({ length: 1_001 }, () => bet('field', 1)), T0 + 800)).toThrow(TypeError);
    expect(a.table.writeComputedCrapsSlip('craps-2', [bet('pass', 10)], basisOf(EMPTY_CARRY, a.pid), T0 + 800)).toBe('reconnecting');
    const closedAt = go([a], T0 + STEP, T0 + 30_000, () => keysIn(a, 'c', 1, TABLE).length > 0);
    expect(crapsBet(a, [bet('pass', 10)], closedAt)).toBe('closed');
    const decidedAt = decide([a], 1, closedAt + STEP);
    expect(crapsOf(a, decidedAt)!.phase).toBe('settled');
    expect(crapsBet(a, [bet('field', 1)], decidedAt)).toBe('closed');
  });
});

describe('the felt as a page shows it', () => {
  it('while betting and through the wait, each standing felt and every rider; frozen felts while closing; then what rides on', async () => {
    const { pages, decidedAt, showEnd } = await pointSix([1, 3]);
    const [a, b] = pages;
    const bets = (p: Page, r: number, T: number) => p.table.readComputedCrapsBets(TABLE, r, T);
    // Settled: what rides on, for the roll shown only.
    for (const p of pages) {
      expect(bets(p, 1, decidedAt)).toEqual({ [a.pid]: [bet('pass', 10)], [b.pid]: [bet('pass', 5)] });
      expect(bets(p, 2, decidedAt)).toEqual({});
    }
    rigRoll(pages, 2, 8);
    go(pages, decidedAt + STEP, showEnd + STEP);
    const T = showEnd + 1_000;
    expect(crapsBet(b, [bet('pass', 5), bet('field', 5)], T)).toBe('ok');
    expect(crapsBet(a, [bet('pass', 10), bet('field', 3)], T)).toBe('ok');
    // A's next change is held back: its own page shows it, with its stamp.
    expect(crapsBet(a, [bet('pass', 10), bet('field', 7)], T + 50)).toBe('ok');
    sync(T + 50, ...pages);
    const basis = basisOf(carryOf(a), a.pid);
    expect(a.table.readMyComputedCrapsBets(TABLE, a.pid, 2, T + 50)).toEqual({ felt: [bet('field', 7), bet('pass', 10)], basis });
    for (const p of pages) {
      expect(bets(p, 2, T + 50)).toEqual({ [a.pid]: [bet('field', 3), bet('pass', 10)], [b.pid]: [bet('field', 5), bet('pass', 5)] });
    }
    const want = { [a.pid]: [bet('field', 7), bet('pass', 10)], [b.pid]: [bet('field', 5), bet('pass', 5)] };
    const W = crapsOf(a, T + 50)!.phaseDeadline!;
    // The wait for B's throw: the felts as they stand.
    go(pages, T + STEP, W + 1_000);
    for (const p of pages) {
      expect(crapsOf(p, W + 1_000)).toMatchObject({ phase: 'closing', shooter: b.pid });
      expect(bets(p, 2, W + 1_000)).toEqual(want);
    }
    expect(a.table.readMyComputedCrapsBets(TABLE, a.pid, 2, W + 1_000)).toEqual({ felt: want[a.pid], basis });
    // B flings: closing, the felts as the roll plays them.
    b.table.noteComputedFling(TABLE, 2, 77, W + 1_050);
    const closedAt = go(pages, W + 1_000 + STEP, W + 5_000, () => pages.every((p) => foldOf(p).tip?.r === 2));
    for (const p of pages) expect(bets(p, 2, closedAt)).toEqual(want);
    // An 8: the field bets lose, the passes ride on.
    const doneAt = decide(pages, 2, closedAt + STEP);
    for (const p of pages) {
      expect(crapsOf(p, doneAt)).toMatchObject({ phase: 'settled', round: 2, result: 8, point: 6 });
      expect(bets(p, 2, doneAt)).toEqual({ [a.pid]: [bet('pass', 10)], [b.pid]: [bet('pass', 5)] });
      expect(p.casino.readChips(a.pid)).toBe(983);
    }
  });
});
