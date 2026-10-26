/**
 * 🧮🔀 The house's switch of a roulette table to computed and back
 * (computedTable switchComputedOn / switchComputedOff), and what goes on
 * around it: an earlier build's operator still driving the room's tables
 * (the lease's `build`, croupier's legacy sweep), a removal mid-session, a
 * forged delete of the switch, the keys a computed table never writes, and
 * a player's felt coming down as the page leaves.
 *
 * Each page is its own load of the casino modules with its own Y.Doc,
 * player id and identity key (computedPageKit), synced by hand, every clock
 * explicit. The house is page A; the owner-run table runs on this build's
 * croupier, a round of it put up by hand where a spec plays an earlier
 * build (as #297 writes them: its state and lists, under its own
 * incarnation name).
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asSlip } from './computedFold';
import type { Checkpoint, FoldCtx } from './computedFold';
import {
  clockOf, frame, keysIn, loadPage, PAGE_ROOM as ROOM, PAGE_TABLE as TABLE, putIn, run, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';

/** The pagehide listeners each page's computedTable registered, in order. */
const pagehide: (() => void)[] = [];
const windowStub = {
  location: { search: '' },
  addEventListener: (type: string, fn: () => void) => { if (type === 'pagehide') pagehide.push(fn); },
  removeEventListener: () => undefined,
};
vi.stubGlobal('window', windowStub);

const T0 = 2_000_000_000;
const STEP = 200;
const OTHER = 'roulette-2';
const LAPSE = 6_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Page p at the spec's time T, its tables running (World marks the frame). */
function at(p: Page, T: number): number {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  return now;
}

/** Pages for `names`, 1,000 chips each, the room's tables owner-run and
 *  plain (no house seed), all synced at T0. The first is the house's. */
async function room(names: string[], opts: { samePlayer?: boolean } = {}): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) {
    pages.push(await loadPage(name, i + 1, opts.samePlayer ? { pid: 'player-House' } : {}));
  }
  for (const p of pages) {
    at(p, T0);
    if (!opts.samePlayer || p === pages[0]) p.casino.buyInChips(p.pid, 1_000);
    // (The dev flag: the house's switch row shows.)
    p.table.setComputedTablesEnabledForTests(true);
  }
  pages[0].casino.writeCrapsFairnessPref(TABLE, 'rng');
  pages[0].casino.writeCrapsFairnessPref(OTHER, 'rng');
  sync(T0, ...pages);
  return pages;
}

const cfgOf = (p: Page, t = TABLE): unknown => p.doc.getMap('casino').get(`cfg:computed:${t}`);
const incOf = (p: Page, t = TABLE): string => p.casino.computedIncOf(t)!;
const foldOf = (p: Page, t = TABLE) => p.casino.computedFoldOf(t)!;
const phaseOf = (p: Page, now?: number) => p.table.readComputedRoulette(TABLE, now);
const chipsOf = (p: Page, ...pages: Page[]): number[] => pages.map((q) => p.casino.readChips(q.pid));
const sessionKeys = (p: Page, t = TABLE): string[] =>
  [...p.doc.getMap('casinoComputed').keys()].filter((k) => k.startsWith(`ses:${t}:`));

/** Every key of table t's owner-run game (and its Fair seeds and robot), in
 *  every map they live in. */
function ownerRunKeys(p: Page, t = TABLE): string[] {
  const out: string[] = [];
  for (const name of ['casino', 'casinoChips', 'casinoComputed']) {
    for (const k of p.doc.getMap(name).keys()) {
      if (k === `table:${t}` || k === `croupier:${t}` || ['bets', 'book', 'end', 'fseed'].some((x) => k.startsWith(`${x}:${t}:`))) {
        out.push(`${name}/${k}`);
      }
    }
  }
  return out.sort();
}

/** An owner-run round as an earlier build's lease holder puts one up on
 *  table t (writeTableState and tableOpening as its openBetting does, past
 *  this build's guards), its incarnation that build's kind of name. */
function earlierBuildOpens(p: Page, t = TABLE, round = 1): void {
  p.casino.transactCasino(() => p.casino.writeTableState(t, {
    kind: 'roulette', phase: 'betting', round, result: null, resultAt: 0, payouts: null, ...p.casino.tableOpening(t),
  }));
}

/** Round 1 of an owner-run table: `bets` down on each page's list, closed
 *  and spun (plain RNG) by page p, the show done. */
async function ownerRunRound(p: Page, pages: Page[], bets: Record<string, ReturnType<typeof red>[]>, T: number): Promise<void> {
  at(p, T);
  p.croupier.openBetting(TABLE, 1);
  sync(T, ...pages);
  for (const q of pages) {
    at(q, T);
    if (bets[q.name]) expect(q.casino.writeMyBets(TABLE, q.pid, 1, bets[q.name])).toBe(true);
  }
  sync(T, ...pages);
  at(p, T);
  p.croupier.closeBetting(TABLE, p.casino.readTableState(TABLE)!);
  p.croupier.rollAndSettle(TABLE, 1);
  await flush();
  sync(T, ...pages);
  expect(p.casino.readTableState(TABLE)?.phase).toBe('settled');
}

// ── 🔀 Switch-on ─────────────────────────────────────────────────────────────

describe('switch-on: refused', () => {
  it('with a round under way: lists on the felt, a robot close, a SPIN pressed on another page; not on a quiet table', async () => {
    const [a, b] = await room(['A', 'B']);
    at(a, T0);
    a.croupier.openBetting(TABLE, 1);
    // Betting with no list on it is quiet…
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0)).toMatchObject({ on: false, can: true });
    sync(T0, a, b);
    at(b, T0);
    b.casino.writeMyBets(TABLE, b.pid, 1, [red(10)]);
    sync(T0, a, b);
    at(a, T0);
    // …a list on it isn't.
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('busy');
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0)).toMatchObject({
      can: false, reason: 'FINISH THIS ROUND FIRST',
    });
    // A robot's close (its beat before the spin).
    const s = a.casino.readTableState(TABLE)!;
    a.croupier.closeBetting(TABLE, s, a.croupier.CLOSING_MS);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('busy');
    // A SPIN another of the house's pages pressed: its lease pending.
    a.croupier.closeBetting(TABLE, { ...s, phase: 'betting' }, undefined, 'another-page');
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'closing', operator: 'another-page' });
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('busy');
    // Even with the lists gone: a closing round is never quiet.
    b.casino.writeMyBets(TABLE, b.pid, 1, []);
    sync(T0, a, b);
    at(a, T0);
    expect(a.casino.readAllBets(TABLE, 1)).toEqual({});
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('busy');
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    // Settled is quiet.
    a.casino.writeTableState(TABLE, { ...a.casino.readTableState(TABLE)!, phase: 'settled', result: 3, resultAt: T0, payouts: {} });
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
  });

  it("while an earlier build's page holds the table lease (no build on it), until it has sat for a lapse", async () => {
    const [a] = await room(['A']);
    at(a, T0);
    a.casino.writeTableOperatorLease({ page: 'old-page', player: a.pid, beat: 1 });
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('old-build');
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0).reason)
      .toBe("AN OLDER VERSION OF THE GAME RUNS THIS ROOM'S TABLES — UPDATE IT FIRST");
    // Renewed, it is still driving: the watch starts again.
    at(a, T0 + 5_000);
    a.casino.writeTableOperatorLease({ page: 'old-page', player: a.pid, beat: 2 });
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0 + 5_000)).toBe('old-build');
    at(a, T0 + 5_000 + LAPSE - 1);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0 + 5_000 + LAPSE - 1)).toBe('old-build');
    // Sat still for a lapse: that page has gone.
    at(a, T0 + 5_000 + LAPSE);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0 + 5_000 + LAPSE)).toBe('ok');
  });

  it("not under this build's lease (build: 2), whoever holds it", async () => {
    const [a] = await room(['A']);
    at(a, T0);
    a.casino.writeTableOperatorLease({ page: 'other-page', player: a.pid, beat: 1, build: 2 });
    expect(a.croupier.leaseIsOldBuild(T0)).toBe(false);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
  });

  it('on a doc holding part of an update, and while a signature is still to check', async () => {
    const [a, b] = await room(['A', 'B']);
    at(a, T0);
    const rest = partOfAnUpdate(a);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('reconnecting');
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0).reason).toBe('RECONNECTING — TRY AGAIN IN A MOMENT');
    Y.applyUpdate(a.doc, rest);
    // Another computed table, a felt on it this page hasn't had time to check.
    at(b, T0);
    expect(b.table.switchComputedOn(OTHER, 'roulette', T0)).toBe('ok');
    sync(T0, a, b);
    a.casino.setComputedVerifyForTests({ budgetMs: 0 });
    at(b, T0);
    expect(b.table.writeComputedSlip(OTHER, [red(10)], T0)).toBe('ok');
    sync(T0, a, b);
    at(a, T0);
    expect(a.casino.computedSettled()).toBe(false);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('reconnecting');
    // Time to check again: the next slice checks it.
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(a.casino.computedSettled()).toBe(true);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
  });

  it("asleep: before the room's state is in, and waking from a sleep", async () => {
    const [a] = await room(['A']);
    a.croupier.setRoomStateArrivedCheck(() => false);
    // (A fresh binding: the wait for the room's state starts now.)
    a.casino.bindCasinoDoc(a.doc, ROOM);
    at(a, T0);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('asleep');
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0).reason).toBe('RECONNECTING — TRY AGAIN IN A MOMENT');
    a.croupier.setRoomStateArrivedCheck(() => true);
    // Frames stopped for a lapse: a wake, and its wait.
    at(a, T0 + 1_000);
    at(a, T0 + 1_000 + LAPSE + 500);
    expect(a.croupier.tablesAwake(T0 + 1_000 + LAPSE + 500)).toBe(false);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0 + 1_000 + LAPSE + 500)).toBe('asleep');
    // Its frames run on through the wait.
    let T = T0 + 1_000 + LAPSE + 500;
    for (; T < T0 + 1_000 + 2 * LAPSE + 500; T += STEP) {
      at(a, T);
      expect(a.table.switchComputedOn(TABLE, 'roulette', T)).toBe('asleep');
    }
    at(a, T);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T)).toBe('ok');
  });

  it('at craps: never (by the game, and by a craps state up under the id)', async () => {
    const [a] = await room(['A']);
    at(a, T0);
    expect(a.table.switchComputedOn('craps-1', 'craps', T0)).toBe('craps');
    expect(a.table.computedSwitchState('craps-1', 'craps', true, T0)).toEqual({ show: false, on: false, can: false });
    a.casino.writeCrapsTableState('craps-2', {
      kind: 'craps', phase: 'settled', round: 1, point: null, dice: null, result: null, resultAt: 0, payouts: null,
    });
    expect(a.table.switchComputedOn('craps-2', 'roulette', T0)).toBe('craps');
    expect(a.casino.isComputedTable('craps-1') || a.casino.isComputedTable('craps-2')).toBe(false);
  });
});

describe('switch-on', () => {
  it('ends the owner-run incarnation (its book counts on, the chips conserved) and names a computed one', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    await ownerRunRound(a, pages, { A: [red(10)], B: [black(20)] }, T0);
    const s = a.casino.readTableState(TABLE)!;
    const ownerInc = s.inc!;
    const chips = chipsOf(a, a, b);
    expect(chips).not.toEqual([1_000, 1_000]); // the round paid out of its book
    const ledger = a.casino.readCageLedger();
    at(a, T0);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    sync(T0, ...pages);
    for (const p of pages) {
      expect(p.casino.isComputedTable(TABLE)).toBe(true);
      expect(incOf(p)).toMatch(/^c[0-9a-f]{24}$/);
      expect(cfgOf(p)).toEqual({ v: 1, inc: incOf(a) });
      expect(sessionKeys(p)).toEqual([`ses:${TABLE}:${incOf(a)}:g`]);
      // The owner-run incarnation is over, its book kept.
      expect(p.casino.readTableState(TABLE)).toBeNull();
      expect(p.casino.tableIncRemoved(TABLE, ownerInc)).toBe(true);
      expect(p.doc.getMap('casinoChips').has(`book:${TABLE}:${ownerInc}`)).toBe(true);
      expect(chipsOf(p, a, b)).toEqual(chips);
      expect(p.casino.readCageLedger()).toEqual(ledger);
    }
    // 'ok' for a table computed already, nothing written.
    const before = Y.encodeStateVector(a.doc);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    expect(Y.encodeStateVector(a.doc)).toEqual(before);
    // And the table plays: a felt goes down on it.
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [red(5)], T0)).toBe('ok');
    expect(b.casino.readChips(b.pid)).toBe(chips[1] - 5);
  });

  it('from two of the house\'s pages at once: one incarnation, one table', async () => {
    const pages = await room(['A', 'A2'], { samePlayer: true });
    const [a, a2] = pages;
    // Both saw the same owner-run round end, then pressed before hearing each other.
    at(a, T0);
    a.croupier.openBetting(TABLE, 1);
    sync(T0, ...pages);
    for (const p of pages) {
      at(p, T0);
      expect(p.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    }
    const incs = pages.map((p) => incOf(p));
    expect(incs[0]).toBe(incs[1]);
    sync(T0, ...pages);
    for (const p of pages) {
      expect(incOf(p)).toBe(incs[0]);
      expect(sessionKeys(p)).toEqual([`ses:${TABLE}:${incs[0]}:g`]);
    }
    // A felt from either lands on the one session.
    at(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(5)], T0)).toBe('ok');
    sync(T0, ...pages);
    expect(keysIn(a2, 's', 1)).toHaveLength(1);
  });

  it("names a fresh incarnation past any whose records are left in the doc", async () => {
    const [a] = await room(['A']);
    at(a, T0);
    const first = a.casino.computedIncFor(TABLE);
    // Records of that name already there (a session nobody switched on).
    a.doc.transact(() => a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${first}:g`, new Y.Map()));
    const second = a.casino.computedIncFor(TABLE);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^c[0-9a-f]{24}$/);
    expect(a.casino.tableIncRemoved(TABLE, first)).toBe(true);
    // A checkpoint does as much.
    a.doc.transact(() => a.doc.getMap('casinoComputed').set(`sum:${TABLE}:${second}`, { v: 1 }));
    const third = a.casino.computedIncFor(TABLE);
    expect([first, second]).not.toContain(third);
    // And the same doc gives the same name.
    expect(a.casino.computedIncFor(TABLE)).toBe(third);
  });
});

describe('writeComputedOn', () => {
  it("opens the incarnation's first session, unless the doc holds one of it already", async () => {
    const [a] = await room(['A']);
    const inc = 'c' + 'ab'.repeat(12);
    const sid = 'f'.repeat(24); // (a trimmed session's id)
    a.doc.transact(() => a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${inc}:${sid}`, new Y.Map()));
    a.casino.transactCasino(() => a.casino.writeComputedOn(TABLE, inc));
    expect(cfgOf(a)).toEqual({ v: 1, inc });
    expect(sessionKeys(a)).toEqual([`ses:${TABLE}:${inc}:${sid}`]);
    a.casino.transactCasino(() => a.casino.writeComputedOn(OTHER, inc));
    expect(sessionKeys(a, OTHER)).toEqual([`ses:${OTHER}:${inc}:g`]);
  });
});

describe('the dev flag', () => {
  it("reads ?computed=1 on the page's address, or localStorage's ssf-dev-computed, and is off otherwise", async () => {
    const [a] = await room(['A']);
    a.table.setComputedTablesEnabledForTests(null);
    const loc = (window as unknown as { location: { search: string } }).location;
    expect(a.table.computedTablesEnabled()).toBe(false);
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0).show).toBe(false);
    loc.search = '?room=x&computed=1';
    expect(a.table.computedTablesEnabled()).toBe(true);
    loc.search = '?computed=0';
    expect(a.table.computedTablesEnabled()).toBe(false);
    loc.search = '';
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null });
    expect(a.table.computedTablesEnabled()).toBe(false);
    store.set('ssf-dev-computed', '1');
    expect(a.table.computedTablesEnabled()).toBe(true);
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0)).toMatchObject({ show: true, on: false });
    // Storage that throws reads as no flag there.
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(a.table.computedTablesEnabled()).toBe(false);
    vi.unstubAllGlobals();
    vi.stubGlobal('window', windowStub);
  });
});

describe('Fair seeds at a computed table', () => {
  it("never count it Fair, nor commit a seed to an earlier build's Fair round on it", async () => {
    const T3 = 'roulette-3'; // (no fairness set: the room's default, Fair)
    const [a] = await room(['A']);
    at(a, T0);
    expect(a.fair.isFairTable(T3)).toBe(true);
    expect(a.table.switchComputedOn(T3, 'roulette', T0)).toBe('ok');
    expect(a.fair.isFairTable(T3)).toBe(false);
    expect(a.fair.roundIsFair(T3, 'roulette')).toBe(false);
    // An earlier build opens a Fair round on it, and this page's player has a list there.
    a.casino.transactCasino(() => a.casino.writeTableState(T3, {
      kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null,
      houseCommit: a.fair.newHouseCommit(T3, 1), ...a.casino.tableOpening(T3),
    }));
    expect(a.casino.writeMyBets(T3, a.pid, 1, [red(10)])).toBe(true);
    expect(a.fair.roundIsFair(T3, 'roulette')).toBe(false);
    a.fair.tickFairSeeds(T3, 'roulette', a.pid, T0, true);
    expect(ownerRunKeys(a, T3).filter((k) => k.includes('fseed:'))).toEqual([]);
    // (The control: on an owner-run table the same writes a seed.)
    const T4 = 'roulette-4';
    a.croupier.openBetting(T4, 1);
    expect(a.casino.writeMyBets(T4, a.pid, 1, [red(10)])).toBe(true);
    a.fair.tickFairSeeds(T4, 'roulette', a.pid, T0, true);
    expect(ownerRunKeys(a, T4).filter((k) => k.includes('fseed:'))).toHaveLength(1);
  });

  it("leave a craps table's Fair come-out alone under a switch a peer wrote there (craps has none): both bettors' seeds go in, nobody forfeited, the next come-out Fair", async () => {
    const C = 'craps-1'; // (no fairness set: the room's default, Fair)
    const [a] = await room(['A']);
    const craps = await import('./crapsCroupier');
    a.croupier.setSoleCroupierPredicate(() => true);
    // One page plays Amy and Bob (fairTableSeeds.test.ts's harness), its
    // frames marked every STEP as World marks them.
    const AMY = 'player-Amy';
    const BOB = 'player-Bob';
    a.doc.transact(() => {
      for (const pid of [AMY, BOB]) a.doc.getMap('players').set(pid, { keyB64: a.pub, name: pid });
    });
    for (const pid of [AMY, BOB]) a.casino.buyInChips(pid, 100);
    let now = T0;
    const later = (ms: number): void => {
      for (const end = now + ms; now < end;) at(a, now = Math.min(end, now + STEP));
    };
    const playersLook = (): void => {
      later(250);
      for (const pid of [AMY, BOB]) a.fair.tickFairSeeds(C, 'craps', pid);
    };
    craps.tickAutoStickman(C); // opens the come-out, Fair
    expect(a.casino.readCrapsTableState(C)?.houseCommit).toBeTruthy();
    a.casino.writeMyCrapsBets(C, AMY, [{ type: 'pass', amount: 10 }]);
    a.casino.writeMyCrapsBets(C, BOB, [{ type: 'field', amount: 5 }]);
    craps.tickAutoStickman(C); // arms
    playersLook(); // both commit
    later(craps.CRAPS_BET_WINDOW_MS);
    craps.tickAutoStickman(C); // closes: both frozen
    expect(Object.keys(a.casino.readCrapsTableState(C)?.commits ?? {}).sort()).toEqual([AMY, BOB]);
    // A peer's one key, right after the close.
    a.doc.getMap('casino').set(`cfg:computed:${C}`, { v: 1, inc: 'c' + '12'.repeat(12) });
    expect(a.fair.roundIsFair(C, 'craps')).toBe(true);
    expect(a.fair.isFairTable(C, 'craps')).toBe(true);
    playersLook(); // both reveal
    later(craps.CRAPS_CLOSING_MS);
    craps.tickAutoStickman(C);
    await flush();
    later(a.fair.REVEAL_GRACE_MS);
    craps.tickAutoStickman(C);
    await flush();
    const s = a.casino.readCrapsTableState(C)!;
    expect(s.phase).toBe('settled');
    expect(s.fairness?.parties).toEqual(['house', AMY, BOB]);
    // (A party that committed and never revealed has an empty seed.)
    expect(s.fairness?.seeds?.every((x) => x.length === 64)).toBe(true);
    later(craps.CRAPS_SHOW_MS + 1_000);
    craps.tickAutoStickman(C);
    expect(a.casino.readCrapsTableState(C)).toMatchObject({ round: 2, houseCommit: expect.any(String) });
  });
});

// ── 🕰 An earlier build on a computed table ─────────────────────────────────

describe("an earlier build's operator on a computed table", () => {
  it('opens an owner-run round there: each list held once, the card warned, and this build\'s lease holder sweeps it after a lapse', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    const cinc = incOf(a);
    sync(T0, ...pages);
    // An earlier build's page drives the room's tables meanwhile (B's doc
    // stands in for it), opens a round on the table and its player bets.
    at(b, T0);
    earlierBuildOpens(b);
    const legacyInc = b.casino.readTableState(TABLE)!.inc!;
    expect(legacyInc).toMatch(/^[0-9a-f]{24}$/);
    expect(b.casino.writeMyBets(TABLE, b.pid, 1, [red(10)])).toBe(true);
    // And on this build, the same player's felt on the computed table.
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const ledger = a.casino.readCageLedger();
    for (const p of pages) {
      // Each held once: 10 on the list, 20 on the felt.
      expect(p.casino.readChips(b.pid)).toBe(970);
      expect(p.table.computedOldBuildDriving(TABLE)).toBe(true);
      expect(p.casino.isComputedTable(TABLE)).toBe(true);
      // The computed table's view is its own.
      expect(phaseOf(p, T0)).toMatchObject({ phase: 'betting', round: 1, inc: cinc });
    }
    // This build's page takes the lease and drives (World: tickAutoCroupier
    // on each table): no round of its own opened, the old one swept after a
    // lapse of watching it.
    let T = T0 + 1_000;
    at(a, T);
    a.croupier.takeTableTurn(T);
    const legacy = a.casino.readTableState(TABLE);
    for (; T <= T0 + 1_000 + LAPSE + 2 * STEP; T += STEP) {
      at(a, T);
      expect(a.croupier.takeTableTurn(T) || T < T0 + 1_000 + 1_500).toBe(true);
      a.croupier.tickAutoCroupier(TABLE);
      const s = a.casino.readTableState(TABLE);
      if (s === null) break;
      // Watched, never driven: no timer armed on its list, no close.
      expect(s).toEqual(legacy);
    }
    const sweptAt = T;
    expect(sweptAt).toBeGreaterThanOrEqual(T0 + 1_000 + LAPSE);
    expect(sweptAt).toBeLessThan(T0 + 1_000 + LAPSE + 2 * STEP);
    sync(sweptAt, ...pages);
    for (const p of pages) {
      expect(p.casino.readTableState(TABLE)).toBeNull();
      expect(p.casino.readAllBets(TABLE, 1)).toEqual({});
      expect(p.casino.tableIncRemoved(TABLE, legacyInc)).toBe(true);
      expect(p.table.computedOldBuildDriving(TABLE)).toBe(false);
      // The computed incarnation as it was: its switch, its session, the felt.
      expect(incOf(p)).toBe(cinc);
      expect(p.casino.computedIncEnded(TABLE, cinc)).toBe(false);
      expect(sessionKeys(p)).toEqual([`ses:${TABLE}:${cinc}:g`]);
      expect(foldOf(p).felts.get(b.pid)?.rec.b).toEqual([black(20)]);
      // The list's 10 back, the felt's 20 held: conserved.
      expect(p.casino.readChips(b.pid)).toBe(980);
      expect(p.casino.readCageLedger()).toEqual({
        ...ledger, outstanding: ledger.outstanding + 10, houseNet: ledger.houseNet - 10,
        balances: { ...ledger.balances, [b.pid]: 980 },
      });
    }
    expect(ownerRunKeys(a).filter((k) => !k.startsWith('casinoChips/'))).toEqual([]);
  });

  it('a page that is not whole sweeps nothing, and a wake starts the watch again', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    sync(T0, ...pages);
    at(b, T0);
    earlierBuildOpens(b);
    sync(T0, ...pages);
    // Partial: the watch waits.
    at(a, T0);
    const rest = partOfAnUpdate(a);
    for (let T = T0; T <= T0 + 2 * LAPSE; T += STEP) {
      at(a, T);
      a.croupier.tickAutoCroupier(TABLE);
    }
    expect(a.casino.readTableState(TABLE)).not.toBeNull();
    Y.applyUpdate(a.doc, rest);
    // Whole again: watched from now (its first whole look).
    let T = T0 + 2 * LAPSE + STEP;
    at(a, T);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).not.toBeNull();
    // Asleep for a lapse in the middle of the watch: from the wake, a lapse more.
    T += 3_000;
    at(a, T);
    a.croupier.tickAutoCroupier(TABLE);
    T += LAPSE + 1_000; // no frames meanwhile
    at(a, T);
    expect(a.croupier.tablesWakeCount()).toBeGreaterThan(0);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).not.toBeNull();
    const woke = T;
    for (T = woke + STEP; T < woke + LAPSE; T += STEP) {
      at(a, T);
      a.croupier.tickAutoCroupier(TABLE);
    }
    expect(a.casino.readTableState(TABLE)).not.toBeNull();
    at(a, woke + LAPSE);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).toBeNull();
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
  });

  it("starts its watch again when the earlier build's round moves on (its page drives again)", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    sync(T0, ...pages);
    at(b, T0);
    earlierBuildOpens(b);
    sync(T0, ...pages);
    let T = T0;
    for (; T < T0 + LAPSE - 1_000; T += STEP) {
      at(a, T);
      a.croupier.tickAutoCroupier(TABLE);
    }
    // The earlier build's page settles round 1 and opens round 2.
    at(b, T);
    earlierBuildOpens(b, TABLE, 2);
    sync(T, ...pages);
    expect(a.casino.readTableState(TABLE)?.round).toBe(2);
    const moved = T;
    for (; T < moved + LAPSE; T += STEP) {
      at(a, T);
      a.croupier.tickAutoCroupier(TABLE);
      expect(a.casino.readTableState(TABLE)).not.toBeNull();
    }
    at(a, T);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).toBeNull();
  });

  it("starts its watch again on the earlier build's next incarnation (a removal and a reopen it heard at once)", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    sync(T0, ...pages);
    at(b, T0);
    earlierBuildOpens(b);
    sync(T0, ...pages);
    const first = a.casino.readTableState(TABLE)!.inc;
    let T = T0;
    for (; T < T0 + LAPSE - 1_000; T += STEP) {
      at(a, T);
      a.croupier.tickAutoCroupier(TABLE);
    }
    at(b, T);
    b.casino.transactCasino(() => {
      b.croupier.refundAndClear(TABLE, 'local', { keepComputed: true });
      earlierBuildOpens(b);
    });
    sync(T, ...pages);
    expect(a.casino.readTableState(TABLE)).toMatchObject({ round: 1 });
    expect(a.casino.readTableState(TABLE)!.inc).not.toBe(first);
    const moved = T;
    for (; T < moved + LAPSE; T += STEP) {
      at(a, T);
      a.croupier.tickAutoCroupier(TABLE);
      expect(a.casino.readTableState(TABLE)).not.toBeNull();
    }
    at(a, T);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).toBeNull();
  });

  it('is no older build driving on an owner-run table', async () => {
    const [a] = await room(['A']);
    at(a, T0);
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.readTableState(TABLE)).not.toBeNull();
    expect(a.table.computedOldBuildDriving(TABLE)).toBe(false);
  });

  it('a round this build would open there, it never opens (openBetting, tickAutoCroupier)', async () => {
    const [a] = await room(['A']);
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.readTableState(TABLE)).toBeNull();
    a.croupier.takeTableTurn(T0);
    for (let T = T0; T <= T0 + 3 * LAPSE; T += STEP) {
      at(a, T);
      a.croupier.takeTableTurn(T);
      a.croupier.tickAutoCroupier(TABLE);
    }
    expect(a.casino.readTableState(TABLE)).toBeNull();
    expect(ownerRunKeys(a)).toEqual([]);
  });
});

// ── 🔀 Switch-off ────────────────────────────────────────────────────────────

/** Pages A and B at a computed table switched on by A at T0. */
async function computedRoom(): Promise<Page[]> {
  const pages = await room(['A', 'B']);
  at(pages[0], T0);
  expect(pages[0].table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
  sync(T0, ...pages);
  return pages;
}

/** Round 1 played to its result on every page: A on red, B on black. The
 *  time it was decided. */
function playRoundOne(pages: Page[]): number {
  const [a, b] = pages;
  expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
  at(b, T0);
  expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
  sync(T0, ...pages);
  const decidedAt = run(pages, T0 + STEP, T0 + 30_000, {
    step: STEP, until: () => pages.every((p) => foldOf(p).rounds[0]?.decided === 'reveals'),
  });
  expect(decidedAt).toBeLessThan(T0 + 30_000);
  return decidedAt;
}

describe('switch-off', () => {
  it('refused while a close is in, and while a forfeit\'s result waits; goes once the result shows', async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    // To the close, then B's page goes quiet: its seed never comes.
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => foldOf(a).tip !== null });
    expect(foldOf(a).tip).not.toBeNull();
    const busy = (T: number): void => {
      at(a, T);
      expect(a.table.switchComputedOff(TABLE, T)).toBe('busy');
      expect(a.table.computedSwitchState(TABLE, 'roulette', true, T)).toMatchObject({
        on: true, can: false, reason: 'WAIT FOR THE SPIN TO FINISH',
      });
    };
    busy(closedAt);
    let T = closedAt;
    for (; T < closedAt + 20_000 && !foldOf(a).rounds[0]?.decided; T += STEP) {
      frame(T, a);
      if (!foldOf(a).rounds[0]?.decided) busy(T);
    }
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit' });
    // (A forfeit's result that waits out the grace: the next spec.)
    for (; phaseOf(a, T)?.phase === 'closing'; T += STEP) busy(T);
    expect(phaseOf(a, T)?.phase).toBe('settled');
    at(a, T);
    expect(a.table.switchComputedOff(TABLE, T)).toBe('ok');
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
  });

  it("refused while a forfeit's result waits out every page's grace", async () => {
    const pages = await computedRoom();
    const [a] = pages;
    // Two other players' round, written as their pages would: Bob closes
    // it, reveals, and forfeits Cat at once (a forfeit the fold takes
    // whenever it comes; the result waits for the grace all the same).
    const ctx = { room: ROOM, t: TABLE, inc: incOf(a) };
    const kit = new ComputedKit(ctx);
    const BOB = testIdentity('bob', 'player-Bob');
    const CAT = testIdentity('cat', 'player-Cat');
    a.doc.transact(() => {
      for (const id of [BOB, CAT]) a.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
    });
    const sb = kit.slip(BOB, 1, [red(10)]);
    const sc = kit.slip(CAT, 1, [black(10)]);
    at(a, T0 + 1_000);
    putIn(a, [[sb.key, sb.rec], [sc.key, sc.rec]]);
    const close = kit.close(BOB, 1, kit.sidAfter(null), [sb, sc]);
    const T1 = T0 + 19_000;
    for (let t = T0 + 1_000; t <= T1; t += 1_000) at(a, t);
    putIn(a, [[close.key, close.rec]]);
    const xb = kit.reveal(1, BOB.pid);
    const f = kit.forfeit(BOB, 1, close.hash, [BOB.pid]);
    at(a, T1 + STEP);
    putIn(a, [[xb.key, xb.rec], [f.key, f.rec]]);
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit' });
    let T = T1 + STEP;
    expect(phaseOf(a, T)?.phase).toBe('closing');
    for (; phaseOf(a, T)?.phase === 'closing'; T += STEP) {
      at(a, T);
      expect(a.table.switchComputedOff(TABLE, T)).toBe('busy');
    }
    expect(T).toBeGreaterThan(T1 + 1_000);
    expect(phaseOf(a, T)?.phase).toBe('settled');
    at(a, T);
    expect(a.table.switchComputedOff(TABLE, T)).toBe('ok');
  });

  it('releases the open felts, keeps the decided nets (a final checkpoint), and the owner-run table opens on a fresh incarnation', async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    const decidedAt = playRoundOne(pages);
    const D = foldOf(a).rounds[0];
    const won = chipsOf(a, a, b);
    expect(won).toEqual([1_000 + Number(D.deltas.get(a.pid)), 1_000 + Number(D.deltas.get(b.pid))]);
    // Round 2 opens after the show; both put felts down.
    const openedAt = run(pages, decidedAt + STEP, decidedAt + 20_000, {
      step: STEP, until: () => pages.every((p) => phaseOf(p)?.phase === 'betting'),
    });
    at(a, openedAt);
    expect(a.table.writeComputedSlip(TABLE, [red(30)], openedAt)).toBe('ok');
    at(b, openedAt);
    expect(b.table.writeComputedSlip(TABLE, [red(40)], openedAt)).toBe('ok');
    sync(openedAt, ...pages);
    expect(chipsOf(a, a, b)).toEqual([won[0] - 30, won[1] - 40]);
    const cinc = incOf(a);
    const nets = Object.fromEntries([...foldOf(a).nets].map(([k, v]) => [k, v.toString()]));
    const ledger = a.casino.readCageLedger();
    const ownerIncDuring = a.casino.tableIncFor(TABLE);
    at(a, openedAt);
    expect(a.table.switchComputedOff(TABLE, openedAt)).toBe('ok');
    sync(openedAt, ...pages);
    for (const p of pages) {
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
      expect(cfgOf(p)).toBeUndefined();
      expect(sessionKeys(p)).toEqual([]);
      expect(p.casino.computedIncEnded(TABLE, cinc)).toBe(true);
      expect(p.casino.tableIncRemoved(TABLE, cinc)).toBe(true);
      const cp = p.doc.getMap('casinoComputed').get(`sum:${TABLE}:${cinc}`) as Checkpoint;
      expect(cp).toMatchObject({ v: 1, e: 1, u: 1, k: a.pub, n: nets });
      // The decided round counts on; the open felts hold nothing.
      expect(chipsOf(p, a, b)).toEqual(won);
      expect(p.casino.readCageLedger()).toEqual({
        ...ledger, outstanding: ledger.outstanding + 70, houseNet: ledger.houseNet - 70,
        balances: { ...ledger.balances, [a.pid]: won[0], [b.pid]: won[1] },
      });
    }
    // The owner-run table's next incarnation counts the computed one's mark.
    const ownerIncAfter = a.casino.tableIncFor(TABLE);
    expect(ownerIncAfter).not.toBe(ownerIncDuring);
    // The house's driving page opens it (the robot's first round).
    let T = openedAt + STEP;
    at(a, T);
    a.croupier.takeTableTurn(T);
    for (; T < openedAt + 5_000 && a.casino.readTableState(TABLE) === null; T += STEP) {
      at(a, T);
      if (a.croupier.takeTableTurn(T)) a.croupier.tickAutoCroupier(TABLE);
    }
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 1, inc: ownerIncAfter });
    expect(a.casino.tableIncRemoved(TABLE, ownerIncAfter)).toBe(false);
    sync(T, ...pages);
    at(b, T);
    expect(b.casino.writeMyBets(TABLE, b.pid, 1, [red(5)])).toBe(true);
    expect(b.casino.readChips(b.pid)).toBe(won[1] - 5);
  });

  it('goes at once on a switch whose incarnation the doc holds nothing of (one a peer wrote alone: no build does), marked ended', async () => {
    const [a] = await room(['A']);
    at(a, T0);
    const forged = 'c' + '12'.repeat(12);
    a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: forged });
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T0)).toEqual({ show: true, on: true, can: true });
    expect(a.table.switchComputedOff(TABLE, T0)).toBe('ok');
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    expect(cfgOf(a)).toBeUndefined();
    expect(a.casino.computedIncEnded(TABLE, forged)).toBe(true);
    // A session of it turning up now counts its nets and holds nothing:
    // it is an ended incarnation's, compacted in turn.
    expect(a.casino.computedEndedIncs()).toEqual([]);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    expect(incOf(a)).not.toBe(forged);
  });

  it("the same on an owner-run table the robot drives: a minute on, the page awake, whole and settled, the house switches it back, and the robot opens round 1 on a fresh incarnation", async () => {
    const [a] = await room(['A']);
    a.croupier.setSoleCroupierPredicate(() => true);
    // World's frame on the house's page: it drives the room's tables.
    const worldFrame = (T: number): void => {
      const now = at(a, T);
      if (a.croupier.takeTableTurn(now)) a.croupier.tickAutoCroupier(TABLE);
      a.table.tickComputedTables([TABLE], now);
    };
    let T = T0;
    for (; T <= T0 + 2_000; T += STEP) worldFrame(T);
    const ownerInc = a.casino.readTableState(TABLE)!.inc!;
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 1 });
    // A peer's one write: a well-formed switch, nothing behind it.
    a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: 'c' + '77'.repeat(12) });
    for (; T <= T0 + 62_000; T += STEP) worldFrame(T);
    expect(a.croupier.tablesAwake(T)).toBe(true);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(a.casino.computedSettled()).toBe(true);
    // The table dead meanwhile: no owner-run round, and no felt goes down.
    expect(a.casino.readTableState(TABLE)).toBeNull();
    expect(a.table.writeComputedSlip(TABLE, [red(1)], T)).toBe('reconnecting');
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, T)).toEqual({ show: true, on: true, can: true });
    expect(a.table.switchComputedOff(TABLE, T)).toBe('ok');
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    for (const end = T + 5_000; T <= end && a.casino.readTableState(TABLE) === null; T += STEP) worldFrame(T);
    const s = a.casino.readTableState(TABLE)!;
    expect(s).toMatchObject({ phase: 'betting', round: 1 });
    expect(s.inc).not.toBe(ownerInc);
    expect(a.casino.tableIncRemoved(TABLE, s.inc!)).toBe(false);
  });

  it("'ok' for a table that isn't computed, nothing written; refused on a page not whole", async () => {
    const pages = await computedRoom();
    const [a] = pages;
    expect(a.table.switchComputedOff(OTHER, T0)).toBe('ok');
    const rest = partOfAnUpdate(a);
    expect(a.table.switchComputedOff(TABLE, T0)).toBe('reconnecting');
    Y.applyUpdate(a.doc, rest);
    expect(a.table.switchComputedOff(TABLE, T0)).toBe('ok');
  });
});

// ── 🚩 A forged delete, and a removal ─────────────────────────────────────────

describe('the switch deleted by hand (no checkpoint, no mark)', () => {
  it('moves no decided chip', async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    const decidedAt = playRoundOne(pages);
    const won = chipsOf(a, a, b);
    expect(won).not.toEqual([1_000, 1_000]);
    b.doc.transact(() => b.doc.getMap('casino').delete(`cfg:computed:${TABLE}`));
    sync(decidedAt, ...pages);
    for (const p of pages) {
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
      expect(chipsOf(p, a, b)).toEqual(won);
    }
    // Nor do the pages' frames after it.
    run(pages, decidedAt + STEP, decidedAt + 90_000, { step: 1_000 });
    for (const p of pages) expect(chipsOf(p, a, b)).toEqual(won);
  });

  /** A cheat who ranks after page p for round 1's forfeit at ctx: p's
   *  answer outranks the cheat's forfeit (levers 2 and 7 out of play). */
  function cheatAfter(p: Page, ctx: FoldCtx): TestIdentity {
    const mine = p.fold.dutyRank('forfeit', ctx, 1, p.pub);
    for (let i = 0; ; i++) {
      const h = testIdentity(`cheat-${i}`, `player-Cheat${i}`);
      if (p.fold.dutyRank('forfeit', ctx, 1, h.pub) > mine) return h;
    }
  }

  /** Page A alone at the computed table, red 10 on its felt; a cheat ranked
   *  after it for round 1's forfeit, 1,000 chips and red 10 on its own felt,
   *  and the cheat's close freezing both at T0 + 1 s (the switch deleted in
   *  the same transaction when `deleteSwitch`). */
  async function cheatsClose(deleteSwitch: boolean) {
    const [a] = await room(['A']);
    at(a, T0);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    const inc = incOf(a);
    const ctx = { room: ROOM, t: TABLE, inc };
    const kit = new ComputedKit(ctx);
    const ses = a.doc.getMap('casinoComputed').get(`ses:${TABLE}:${inc}:g`) as Y.Map<unknown>;
    const H = cheatAfter(a, ctx);
    a.doc.transact(() => a.doc.getMap('players').set(H.pid, { keyB64: H.pub, name: H.pid }));
    a.casino.buyInChips(H.pid, 1_000);
    frame(T0, a);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const aKey = [...ses.keys()].find((k) => k.startsWith(`s:1:${a.pid}:`))!;
    const aSlip = { key: aKey, hash: aKey.slice(aKey.lastIndexOf(':') + 1), rec: ses.get(aKey) as never };
    const hs = kit.slip(H, 1, [red(10)]);
    const close = kit.close(H, 1, kit.sidAfter(null), [aSlip, hs]);
    at(a, T0 + 1_000);
    a.doc.transact(() => {
      ses.set(hs.key, hs.rec);
      ses.set(close.key, close.rec);
      if (deleteSwitch) a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    const revealed = (): boolean => [...ses.keys()].some((k) => k.startsWith(`x:1:${a.pid}:`));
    return { a, inc, kit, ses, H, close, revealed };
  }

  it("is put back by the next frame of a page running the table: a cheat's delete under its own close stops no reveal, and the round is decided as it would be", async () => {
    const { a, inc, kit, ses, H, close, revealed } = await cheatsClose(true);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    expect(a.casino.computedSwitchLost(TABLE)).toBe(true);
    // The robot opens no owner-run round meanwhile: its players are mid-round.
    a.croupier.openBetting(TABLE, 1);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).toBeNull();
    frame(T0 + 1_000, a);
    expect(cfgOf(a)).toEqual({ v: 1, inc });
    expect(a.casino.computedSwitchLost(TABLE)).toBe(false);
    for (let T = T0 + 1_000 + STEP; T <= T0 + 6_000; T += STEP) frame(T, a);
    expect(revealed()).toBe(true);
    // The cheat's seed late, with a forfeit counting itself alone: the
    // honest page's answer outranks it.
    const xh = kit.reveal(1, H.pid);
    const f = kit.forfeit(H, 1, close.hash, [H.pid]);
    at(a, T0 + 6_000);
    a.doc.transact(() => {
      ses.set(xh.key, xh.rec);
      ses.set(f.key, f.rec);
    });
    for (let T = T0 + 6_000; T <= T0 + 30_000; T += STEP) frame(T, a);
    const D = foldOf(a).rounds[0];
    expect(D.decided).toBe('forfeit');
    expect(D.counted).toContain(a.pid);
    expect(a.casino.readTableState(TABLE)).toBeNull();
  });

  it('gives a withholder no free void: one who deletes it instead of revealing is forfeited all the same', async () => {
    const { a, H, revealed } = await cheatsClose(false);
    for (let T = T0 + 1_000; T <= T0 + 3_400; T += STEP) frame(T, a);
    // A's seed is in; H's never comes, and H takes the switch away instead.
    expect(revealed()).toBe(true);
    at(a, T0 + 3_500);
    a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    for (let T = T0 + 3_500; T <= T0 + 60_000; T += STEP) frame(T, a);
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'forfeit' });
    expect(a.casino.readChips(H.pid)).toBe(990);
  });

  it('is put back only by a page that ran the incarnation, over junk or a name the doc holds nothing of too; never once the house switched it off', async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    const cinc = incOf(a);
    run(pages, T0 + STEP, T0 + 1_000, { step: STEP });
    const c = await loadPage('C', 3);
    const all = [a, b, c];
    b.doc.transact(() => b.doc.getMap('casino').delete(`cfg:computed:${TABLE}`));
    sync(T0 + 1_000, ...all);
    // A page that never ran it puts nothing back.
    frame(T0 + 1_200, c);
    expect(cfgOf(c)).toBeUndefined();
    expect(c.casino.computedSwitchLost(TABLE)).toBe(true);
    frame(T0 + 1_200, a);
    sync(T0 + 1_200, ...all);
    for (const p of all) expect(cfgOf(p)).toEqual({ v: 1, inc: cinc });
    let T = T0 + 1_400;
    for (const junk of [{ v: 1, inc: 'nope' }, { v: 2, inc: cinc }, { v: 1, inc: 'c' + '77'.repeat(12) }]) {
      b.doc.getMap('casino').set(`cfg:computed:${TABLE}`, junk);
      run(all, T, T, { step: STEP });
      for (const p of all) expect(cfgOf(p)).toEqual({ v: 1, inc: cinc });
      T += STEP;
    }
    // The house's switch-off ends it (its mark in the same transaction):
    // nobody puts it back, and the robot runs the table again.
    at(a, T);
    expect(a.table.switchComputedOff(TABLE, T)).toBe('ok');
    run(all, T + STEP, T + 5_000, { step: STEP });
    for (const p of all) {
      expect(cfgOf(p)).toBeUndefined();
      expect(p.casino.computedSwitchLost(TABLE)).toBe(false);
    }
    at(a, T + 5_000);
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 1 });
  });

  it('is left as it is when it names another incarnation with a session of its own (two of the house\'s pages switching on at once)', async () => {
    const pages = await computedRoom();
    const [, b] = pages;
    run(pages, T0 + STEP, T0 + 1_000, { step: STEP });
    const other = 'c' + '34'.repeat(12);
    b.doc.transact(() => {
      b.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      b.doc.getMap('casinoComputed').set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    run(pages, T0 + 1_200, T0 + 3_000, { step: STEP });
    for (const p of pages) expect(cfgOf(p)).toEqual({ v: 1, inc: other });
  });
});

describe('a computed table removed mid-session (closeTable)', () => {
  it('keeps the decided nets, lets the open felts go, and a page compacts the incarnation; put back, it is owner-run on a fresh incarnation', async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    const decidedAt = playRoundOne(pages);
    const won = chipsOf(a, a, b);
    const openedAt = run(pages, decidedAt + STEP, decidedAt + 20_000, {
      step: STEP, until: () => pages.every((p) => phaseOf(p)?.phase === 'betting'),
    });
    at(b, openedAt);
    expect(b.table.writeComputedSlip(TABLE, [red(40)], openedAt)).toBe('ok');
    sync(openedAt, ...pages);
    expect(chipsOf(a, b)).toEqual([won[1] - 40]);
    const cinc = incOf(a);
    at(a, openedAt);
    a.croupier.closeTable(TABLE, 'local');
    sync(openedAt, ...pages);
    for (const p of pages) {
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
      expect(cfgOf(p)).toBeUndefined();
      expect(p.casino.tableIncRemoved(TABLE, cinc)).toBe(true);
      expect(chipsOf(p, a, b)).toEqual(won);
      // The session stays for now (compaction's).
      expect(sessionKeys(p)).toHaveLength(1);
    }
    // The pages' frames (the table no longer in the room) compact it.
    const doneAt = run(pages, openedAt + STEP, openedAt + 120_000, {
      step: STEP, tables: [], until: () => pages.every((p) => sessionKeys(p).length === 0),
    });
    expect(doneAt).toBeLessThan(openedAt + 120_000);
    for (const p of pages) {
      const cp = p.doc.getMap('casinoComputed').get(`sum:${TABLE}:${cinc}`) as Checkpoint;
      expect(cp).toMatchObject({ v: 1, e: 1, u: 1 });
      expect(chipsOf(p, a, b)).toEqual(won);
    }
    // Put back: the owner's robot opens it, owner-run, on an incarnation of its own.
    at(a, doneAt);
    a.croupier.openBetting(TABLE, 1);
    const s = a.casino.readTableState(TABLE)!;
    expect(s).toMatchObject({ phase: 'betting', round: 1 });
    expect(s.inc).toMatch(/^[0-9a-f]{24}$/);
    expect(a.casino.tableIncRemoved(TABLE, s.inc!)).toBe(false);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
  });

  it("is compacted on World's frames with no table left in the room (marked running while it waits)", async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    const decidedAt = playRoundOne(pages);
    const won = chipsOf(a, a, b);
    at(a, decidedAt);
    a.croupier.closeTable(TABLE, 'local');
    sync(decidedAt, ...pages);
    for (const p of pages) {
      expect(sessionKeys(p)).toHaveLength(1);
      expect(p.table.computedCompactionPending()).toBe(true);
    }
    // World's frame (world.ts updateCroupier), the room holding no table:
    // `if (tables.length || computedCompactionPending()) noteTablesRunning();`
    // and the computed tick with no roulette table.
    const worldFrame = (T: number, p: Page): void => {
      const now = clockOf(p, T);
      if (p.table.computedCompactionPending()) p.croupier.noteTablesRunning(now);
      p.table.tickComputedTables([], now);
    };
    let T = decidedAt + STEP;
    for (; T <= decidedAt + 30_000 && !pages.every((p) => sessionKeys(p).length === 0); T += STEP) {
      sync(T, ...pages);
      for (const p of pages) worldFrame(T, p);
      sync(T, ...pages);
    }
    expect(T).toBeLessThanOrEqual(decidedAt + 30_000);
    for (const p of pages) {
      expect(sessionKeys(p)).toEqual([]);
      expect(chipsOf(p, a, b)).toEqual(won);
      expect(p.table.computedCompactionPending()).toBe(false);
    }
  });
});

// ── 🗝 What a computed table writes ──────────────────────────────────────────

describe('a computed table, played as World plays it', () => {
  it('writes no table:, bets:, book:, end:, fseed: or croupier: key', async () => {
    const pages = await computedRoom();
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    // World's frame: the lease holder drives (no heartbeat on a computed
    // table: world.ts), every page commits Fair seeds and ticks the
    // computed tables.
    for (let T = T0 + STEP; T <= T0 + 60_000; T += STEP) {
      sync(T, ...pages);
      for (const p of pages) {
        const now = at(p, T);
        if (p === a && p.croupier.takeTableTurn(now)) p.croupier.tickAutoCroupier(TABLE);
        p.fair.tickFairSeeds(TABLE, 'roulette', p.pid, now);
        p.table.tickComputedTables([TABLE], now);
      }
    }
    sync(T0 + 60_000, ...pages);
    expect(foldOf(a).rounds.filter((v) => v.decided).length).toBeGreaterThanOrEqual(1);
    expect(chipsOf(a, a, b)).not.toEqual([1_000, 1_000]);
    for (const p of pages) expect(ownerRunKeys(p)).toEqual([]);
    // Nor do the Fair-seed helpers count it Fair.
    expect(a.fair.isFairTable(TABLE)).toBe(false);
    expect(a.fair.roundIsFair(TABLE, 'roulette')).toBe(false);
  });
});

// ── 🪪 The lease's build ─────────────────────────────────────────────────────

describe('the table lease carries the build', () => {
  it('takeTableTurn writes build: 2 on the claim and on each renewal; an earlier build\'s renewal reads without one', async () => {
    const [a, b] = await room(['A', 'B']);
    at(a, T0);
    a.croupier.takeTableTurn(T0);
    expect(a.casino.readTableOperatorLease()).toEqual({ page: a.croupier.ROULETTE_PAGE_ID, player: a.pid, beat: 1, build: 2 });
    for (let T = T0 + STEP; T <= T0 + 2 * a.croupier.TABLE_LEASE_RENEW_MS; T += STEP) {
      at(a, T);
      a.croupier.takeTableTurn(T);
    }
    expect(a.casino.readTableOperatorLease()).toMatchObject({ beat: 3, build: 2 });
    expect(a.croupier.leaseIsOldBuild(T0 + 4_000)).toBe(false);
    // An earlier build's page renews what it read: {page, player, beat}.
    sync(T0 + 4_000, a, b);
    const l = b.casino.readTableOperatorLease()!;
    b.doc.getMap('casino').set('table-operator', { page: l.page, player: l.player, beat: l.beat + 1 });
    sync(T0 + 4_000, a, b);
    expect(a.casino.readTableOperatorLease()).toEqual({ page: l.page, player: l.player, beat: 4 });
    expect(a.croupier.leaseIsOldBuild(T0 + 4_000)).toBe(true);
    // This build's next renewal puts it back.
    at(a, T0 + 6_000);
    a.croupier.takeTableTurn(T0 + 6_000);
    expect(a.casino.readTableOperatorLease()).toMatchObject({ beat: 5, build: 2 });
  });

  it('reads a build that is no safe integer from 1 to 1000 as none', async () => {
    const [a] = await room(['A']);
    for (const build of [0, -1, 1001, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 2]) {
      a.doc.getMap('casino').set('table-operator', { page: 'p', player: 'q', beat: 1, build });
      expect(a.casino.readTableOperatorLease()).toEqual({ page: 'p', player: 'q', beat: 1 });
    }
    for (const build of [1, 2, 1000]) {
      a.doc.getMap('casino').set('table-operator', { page: 'p', player: 'q', beat: 1, build });
      expect(a.casino.readTableOperatorLease()).toEqual({ page: 'p', player: 'q', beat: 1, build });
    }
    expect(a.casino.TABLE_BUILD).toBe(2);
  });
});

// ── 🚪 Leaving ───────────────────────────────────────────────────────────────

describe('leaving the room', () => {
  it('takes this page\'s felt down from every computed table it has chips on, held back ones too', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    a.table.switchComputedOn(OTHER, 'roulette', T0);
    sync(T0, ...pages);
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(OTHER, [red(5)], T0)).toBe('ok');
    // A change within the coalescing: held back, not yet written.
    at(b, T0 + 100);
    expect(b.table.writeComputedSlip(OTHER, [red(5), black(5)], T0 + 100)).toBe('ok');
    expect(b.table.readMyComputedBets(OTHER, b.pid, 1, T0 + 100)).toEqual([red(5), black(5)]);
    expect(b.casino.readChips(b.pid)).toBe(985);
    b.table.leaveComputedTables(T0 + 100);
    sync(T0 + 100, ...pages);
    for (const p of pages) {
      expect(p.casino.readChips(b.pid)).toBe(1_000);
      for (const t of [TABLE, OTHER]) expect(foldOf(p, t).felts.get(b.pid)?.rec.b).toEqual([]);
    }
    // The empty version is the newest on each table.
    const newest = (t: string) => keysIn(a, 's', 1, t).map((k) => asSlip(a.casino.computedSessionForWrite(t)!.get(k))!)
      .filter((s) => s.p === b.pid).sort((x, y) => y.v - x.v)[0];
    expect(newest(TABLE)).toMatchObject({ v: 2, b: [] });
    expect(newest(OTHER)).toMatchObject({ v: 2, b: [] });
    // Nothing to take down: nothing written.
    const sv = Y.encodeStateVector(b.doc);
    b.table.leaveComputedTables(T0 + 200);
    expect(Y.encodeStateVector(b.doc)).toEqual(sv);
  });

  it('a page that may not write leaves its felt (the next close freezes it)', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    sync(T0, ...pages);
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    // Woken from a sleep: it may not write yet.
    at(b, T0 + LAPSE + 1_000);
    expect(b.croupier.tablesAwake(T0 + LAPSE + 1_000)).toBe(false);
    const sv = Y.encodeStateVector(b.doc);
    b.table.leaveComputedTables(T0 + LAPSE + 1_000);
    expect(Y.encodeStateVector(b.doc)).toEqual(sv);
    expect(b.casino.readChips(b.pid)).toBe(990);
    // And on a doc holding part of an update.
    at(b, T0 + 2 * LAPSE + 2_000);
    const rest = partOfAnUpdate(b);
    const sv2 = Y.encodeStateVector(b.doc);
    b.table.leaveComputedTables(T0 + 2 * LAPSE + 2_000);
    expect(Y.encodeStateVector(b.doc)).toEqual(sv2);
    Y.applyUpdate(b.doc, rest);
    expect(foldOf(b).felts.get(b.pid)?.rec.b).toEqual([red(10)]);
  });

  it("leaves the felt its player's other tab put down (the same key, another page): a page takes down only its own", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    const before = pagehide.length;
    // B's second tab: the same player id, the same device key.
    const b2 = await loadPage('B2', 3, { reloadOf: b });
    expect(pagehide.length).toBe(before + 1);
    const hideB2 = pagehide[before];
    const all = [a, b, b2];
    at(a, T0);
    expect(a.table.switchComputedOn(TABLE, 'roulette', T0)).toBe('ok');
    sync(T0, ...all);
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    sync(T0, ...all);
    run(all, T0 + STEP, T0 + 1_000, { step: STEP });
    expect(b2.table.readMyComputedBets(TABLE, b.pid, 1, T0 + 1_000)).toEqual([red(10)]);
    // The player closes the second tab: nothing written.
    at(b2, T0 + 1_100);
    const sv = Y.encodeStateVector(b2.doc);
    hideB2();
    b2.table.leaveComputedTables(T0 + 1_100);
    expect(Y.encodeStateVector(b2.doc)).toEqual(sv);
    sync(T0 + 1_100, ...all);
    for (const p of all) expect(foldOf(p).felts.get(b.pid)?.rec.b).toEqual([red(10)]);
    expect(b.table.readMyComputedBets(TABLE, b.pid, 1, T0 + 1_100)).toEqual([red(10)]);
    expect(a.casino.readChips(b.pid)).toBe(990);
    // The first tab's own leave takes it down.
    at(b, T0 + 1_200);
    b.table.leaveComputedTables(T0 + 1_200);
    sync(T0 + 1_200, ...all);
    for (const p of all) expect(foldOf(p).felts.get(b.pid)?.rec.b).toEqual([]);
    expect(a.casino.readChips(b.pid)).toBe(1_000);
  });

  it('on pagehide too', async () => {
    const before = pagehide.length;
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // One listener per page's load of computedTable.
    expect(pagehide.length).toBe(before + 2);
    const bHide = pagehide[before + 1];
    at(a, T0);
    a.table.switchComputedOn(TABLE, 'roulette', T0);
    sync(T0, ...pages);
    at(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    at(b, T0 + 500);
    bHide();
    expect(b.casino.readChips(b.pid)).toBe(1_000);
    expect(foldOf(b).felts.get(b.pid)?.rec.b).toEqual([]);
  });

  it('is wired where the page leaves the room, before the flush (main.ts leaveRoomNow)', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const start = main.indexOf('async function leaveRoomNow(');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\nfunction ', start + 1));
    const leave = body.indexOf('leaveComputedTables();');
    expect(leave).toBeGreaterThan(-1);
    expect(leave).toBeLessThan(body.indexOf('sync.flush()'));
    expect(main).toMatch(/import \{ leaveComputedTables \} from "\.\/computedTable";/);
  });
});

describe("World's frame (world.ts updateCroupier)", () => {
  const world = readFileSync(new URL('./world.ts', import.meta.url), 'utf8');
  const start = world.indexOf('private updateCroupier(): void {');
  const body = world.slice(start, world.indexOf('\n  private ', start + 1));

  it('ticks the computed tables every frame, every client, never throwing out of the frame', () => {
    expect(start).toBeGreaterThan(-1);
    const tick = body.indexOf('tickComputedTables(rouletteTables.map((t) => t.id), Date.now());');
    expect(tick).toBeGreaterThan(-1);
    // Inside a try whose catch warns once.
    const tryAt = body.lastIndexOf('try {', tick);
    expect(tryAt).toBeGreaterThan(-1);
    expect(body.slice(tryAt, tick)).not.toContain('}');
    const after = body.slice(tick);
    expect(after).toMatch(/^[^]*?\} catch \(err\) \{\s*if \(!this\.computedTickWarned\) \{\s*this\.computedTickWarned = true;\s*console\.warn\(/);
    // Not behind the lease or any table check: the tick runs on its own line of the frame.
    expect(body.slice(body.lastIndexOf('\n', tryAt) + 1, tryAt).trim()).toBe('');
  });

  it('marks the frame while a removed computed table waits to be compacted, with no table left in the room too', () => {
    expect(body).toContain('if (tables.length || computedCompactionPending()) noteTablesRunning();');
    expect(world).toMatch(/import \{ computedCompactionPending, tickComputedTables \} from "\.\/computedTable";/);
  });

  it("posts no heartbeat for a computed roulette table, and still runs the robot's tick (its sweep)", () => {
    expect(body).toContain('const computed = t.kind === "roulette-table" && isComputedTable(t.id);');
    expect(body).toContain('if (beatNow && !computed) beatCroupier(t.id);');
    expect(body).not.toMatch(/if \(beatNow\) beatCroupier\(t\.id\);/);
    expect(body).toContain('else tickAutoCroupier(t.id);');
  });
});

/** Another page's two writes elsewhere, the second given to p's doc first:
 *  the doc holds part of an update. Returns the rest. */
function partOfAnUpdate(p: Page): Uint8Array {
  const other = new Y.Doc();
  const updates: Uint8Array[] = [];
  other.on('update', (u: Uint8Array) => updates.push(u));
  other.getMap('elsewhere').set('a', 1);
  other.getMap('elsewhere').set('b', 2);
  Y.applyUpdate(p.doc, updates[1]);
  return updates[0];
}
