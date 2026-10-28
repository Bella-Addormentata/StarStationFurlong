/**
 * 🎲🧮🔀 The owner-run craps table stands down at a computed craps table
 * (crapsCroupier at a `k` incarnation): the robot stickman opens no window
 * and throws nothing there, nor does the house's ROLL or a turn it holds; it
 * only sweeps away an owner-run round an earlier build opened on one (its
 * bets back, riding ones too, and what its rolls paid standing) and drops a
 * switch nothing stands behind. A roulette name under a craps table stands
 * nothing down; Fair seeds go in at a craps table only while it is
 * owner-run; and World hands every table to the computed duties with its
 * game.
 *
 * Each page is its own load of the casino modules with its own Y.Doc,
 * player id and identity key (computedPageKit), and its own stickman
 * (crapsCroupier, loaded with it), synced by hand, every clock explicit. The
 * house is page A. An earlier build's lease holder is played by page B on
 * this build's own transitions below the guards (its open written by hand,
 * as that build's openCrapsBetting writes it; closeCrapsBetting and
 * tickCrapsClosing, which every guarded path goes through).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clockOf, CRAPS_REF, CRAPS_TABLE as C, crapsBet, loadPage, openCrapsRoom, PAGE_TABLE, run, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import type { CrapsBet, CrapsTableState } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
const LAPSE = 6_000;
const AWAY = 60_000;
/** The owner-run craps table beside the computed one. */
const OWNER_RUN = 'craps-2';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A page with its stickman: this load's crapsCroupier, bound to its doc. */
type StickmanPage = Page & { craps: typeof import('./crapsCroupier') };

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Page p at the spec's time T, its tables running (World marks the frame). */
function at(p: Page, T: number): number {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  return now;
}

/** Pages for `names`, each with its stickman, 1,000 chips each, the craps
 *  tables plain (no house seed), all synced at T0. The first is the
 *  house's. (Each page loads the craps modules afresh: their own timeout.) */
async function room(names: string[]): Promise<StickmanPage[]> {
  const pages: StickmanPage[] = [];
  for (const [i, name] of names.entries()) {
    const p = await loadPage(name, i + 1);
    // (Before the next page's load resets the modules: this page's own.)
    pages.push(Object.assign(p, { craps: await import('./crapsCroupier') }));
  }
  for (const p of pages) {
    at(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
    p.table.setComputedTablesEnabledForTests(true);
  }
  for (const t of [C, OWNER_RUN, 'craps-7']) pages[0].casino.writeCrapsFairnessPref(t, 'rng');
  sync(T0, ...pages);
  return pages;
}

/** Every throw rolls d1 and d2 (crypto.getRandomValues stubbed: the plain
 *  RNG's dice). */
function diceTo(d1: number, d2: number): { mockRestore(): void } {
  const faces = [d1, d2];
  let n = 0;
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = faces[n++ % 2] - 1;
    return arr;
  });
}

const bet = (type: CrapsBet['type'], amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const stateOf = (p: Page, t = C): CrapsTableState | null => p.casino.readCrapsTableState(t);
const chipsOf = (p: Page, ...pages: Page[]): number[] => pages.map((q) => p.casino.readChips(q.pid));
const sessionKeys = (p: Page, t = C): string[] =>
  [...p.doc.getMap('casinoComputed').keys()].filter((k) => k.startsWith(`ses:${t}:`));

/** Every key of table t's owner-run game (and its Fair seeds and robot), in
 *  every map they live in. */
function ownerRunKeys(p: Page, t = C): string[] {
  const out: string[] = [];
  for (const name of ['casino', 'casinoChips', 'casinoComputed']) {
    for (const k of p.doc.getMap(name).keys()) {
      if (k === `table:${t}` || k === `croupier:${t}` || k === `throw:${t}`
        || ['bets', 'book', 'end', 'fseed'].some((x) => k.startsWith(`${x}:${t}:`))) {
        out.push(`${name}/${k}`);
      }
    }
  }
  return out.sort();
}

/** Page p's frames from T to `to` as World runs them on the lease holder:
 *  its turn taken, then its stickman's tick on each of `tables`. The time
 *  `until` first held, or `to` + STEP. */
function drive(p: StickmanPage, T: number, to: number, tables: string[], until?: () => boolean): number {
  for (; T <= to; T += STEP) {
    at(p, T);
    if (p.croupier.takeTableTurn(T)) for (const t of tables) p.craps.tickAutoStickman(t);
    if (until?.()) return T;
  }
  return to + STEP;
}

/**
 * One owner-run roll as an earlier build's lease holder plays it on page p
 * (it knows nothing of computed craps): betting opened as its
 * openCrapsBetting writes it (after the roll `after`), `bets` down on p's
 * list, closed, thrown (the dice d1 and d2) and settled by the transitions
 * this build's guarded paths go through. Its settled state.
 */
async function earlierBuildRolls(
  p: StickmanPage, T: number, bets: CrapsBet[], dice: [number, number], after: CrapsTableState | null = null,
): Promise<CrapsTableState> {
  at(p, T);
  const round = (after?.round ?? 0) + 1;
  p.casino.transactCasino(() => p.casino.writeCrapsTableState(C, {
    kind: 'craps', phase: 'betting', round, point: after?.point ?? null, dice: null, result: null, resultAt: 0, payouts: null,
    fairMode: 'rng', ...p.casino.tableOpening(C),
  }));
  expect(p.casino.writeMyCrapsBets(C, p.pid, bets)).toBe(true);
  p.craps.closeCrapsBetting(C, stateOf(p)!, T);
  const closing = stateOf(p)!;
  expect(closing).toMatchObject({ phase: 'closing', round });
  at(p, T + p.craps.CRAPS_CLOSING_MS);
  const rig = diceTo(...dice);
  p.craps.tickCrapsClosing(C, closing, p.craps.CRAPS_SHOW_MS, T + p.craps.CRAPS_CLOSING_MS);
  await flush();
  rig.mockRestore();
  const s = stateOf(p)!;
  expect(s).toMatchObject({ phase: 'settled', round, dice });
  return s;
}

// ── 🤖 The stickman ──────────────────────────────────────────────────────────

describe('the stickman at a computed craps table', () => {
  it("opens no come-out there, nor does the card's NEXT ROLL; the owner-run table beside it plays on", async () => {
    const [a] = await room(['A']);
    at(a, T0);
    expect(a.table.switchComputedOn(C, 'craps', T0)).toBe('ok');
    drive(a, T0, T0 + 3 * LAPSE, [C, OWNER_RUN]);
    expect(stateOf(a)).toBeNull();
    expect(ownerRunKeys(a)).toEqual([]);
    expect(stateOf(a, OWNER_RUN)).toMatchObject({ phase: 'betting', round: 1 });
    // (NEXT ROLL on the card comes straight here.)
    at(a, T0 + 3 * LAPSE);
    a.craps.openCrapsBetting(C, 1, null);
    expect(stateOf(a)).toBeNull();
    // (World posts no heartbeat for it: world.ts reads this.)
    expect(a.craps.crapsRunsItself(C)).toBe(true);
    expect(a.craps.crapsRunsItself(OWNER_RUN)).toBe(false);
  }, 30_000);

  it("sweeps an earlier build's round off it once it has sat a lapse: its bets back, riding ones too, what its rolls paid standing, the computed incarnation as it was", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    expect(a.table.switchComputedOn(C, 'craps', T0)).toBe('ok');
    const cinc = a.casino.computedIncOf(C)!;
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    sync(T0, ...pages);
    // An earlier build's page drives the room's tables meanwhile (B's doc
    // stands in for it): on the come-out B's pass and field, a 4 (the field
    // paid, the pass riding on the point), then a place bet on 8 with it.
    const roll1 = await earlierBuildRolls(b, T0 + 1_000, [bet('pass', 10), bet('field', 5)], [1, 3]);
    expect(roll1).toMatchObject({ point: 4, payouts: { [b.pid]: 10 } });
    expect(b.casino.readChips(b.pid)).toBe(995);
    at(b, T0 + 10_000);
    b.casino.transactCasino(() => b.casino.writeCrapsTableState(C, {
      kind: 'craps', phase: 'betting', round: 2, point: 4, dice: null, result: null, resultAt: 0, payouts: null,
      fairMode: 'rng', ...b.casino.tableOpening(C),
    }));
    expect(b.casino.readAllCrapsBets(C)[b.pid]).toEqual([bet('pass', 10)]);
    expect(b.casino.writeMyCrapsBets(C, b.pid, [bet('pass', 10), bet('place', 6, 8)])).toBe(true);
    // And E, a player of the earlier build's with no page here (B's doc
    // stands in for E's): its list as that build puts it down
    // (tableIncarnation's earlierCraps), its chips taken from its count (the
    // bets shape: all of it taken, nothing held).
    const E = 'player-Earlier';
    b.doc.getMap('casino').set(`bought:${E}`, 100);
    b.doc.getMap('casino').set(`bal:${E}`, 100 - 12);
    b.doc.getMap('casino').set(`bets:${C}:${E}`, { kind: 'craps', bets: [bet('place', 12, 6)] });
    const legacyInc = stateOf(b)!.inc!;
    expect(legacyInc).toMatch(/^[0-9a-f]{24}$/);
    sync(T0 + 10_000, ...pages);
    const legacy = stateOf(a);
    expect(legacy).toMatchObject({ phase: 'betting', round: 2, point: 4, inc: legacyInc });
    for (const p of pages) {
      expect(chipsOf(p, a, b)).toEqual([990, 989]);
      expect(p.casino.readChips(E)).toBe(88);
      expect(p.casino.readAllCrapsBets(C)[E]).toEqual([bet('place', 12, 6)]);
    }
    const ledger = a.casino.readCageLedger();
    // (A's page framing all the while: no wake.)
    const from = T0 + 10_000;
    for (let T = T0; T < from; T += STEP) at(a, T);
    // This build's page takes the lease and drives (World: tickAutoStickman
    // on each table): watched for a lapse, never driven (no window armed,
    // no close), then swept.
    const swept = drive(a, from, from + 2 * LAPSE, [C], () => {
      const s = stateOf(a);
      if (s !== null) expect(s).toEqual(legacy);
      return s === null;
    });
    // (Its turn after the lease's settle; the sweep a lapse after its first look.)
    expect(swept - from).toBeGreaterThanOrEqual(1_500 + LAPSE);
    expect(swept - from).toBeLessThanOrEqual(1_500 + LAPSE + 2 * STEP);
    sync(swept, ...pages);
    for (const p of pages) {
      expect(stateOf(p)).toBeNull();
      expect(p.casino.readAllCrapsBets(C)).toEqual({});
      expect(p.casino.tableIncRemoved(C, legacyInc)).toBe(true);
      // The computed incarnation as it was: its switch, its session, A's felt.
      expect(p.casino.computedIncOf(C)).toBe(cinc);
      expect(p.casino.computedIncEnded(C, cinc)).toBe(false);
      expect(p.casino.isComputedFor(C, 'craps')).toBe(true);
      expect(sessionKeys(p)).toEqual([`ses:${C}:${cinc}:g`]);
      expect(p.casino.computedFoldOf(C)!.felts.get(a.pid)?.rec.b).toEqual([bet('pass', 10)]);
      // B's pass (riding) and place back, the field's win kept; A's felt
      // held; E's 12, taken by its build, back exactly.
      expect(chipsOf(p, a, b)).toEqual([990, 1_005]);
      expect(p.casino.readChips(E)).toBe(100);
      expect(p.casino.readCageLedger()).toEqual({
        ...ledger, outstanding: ledger.outstanding + 16 + 12, houseNet: ledger.houseNet - 16 - 12,
        balances: { ...ledger.balances, [b.pid]: 1_005, [E]: 100 },
      });
    }
    expect(ownerRunKeys(a).filter((k) => !k.startsWith('casinoChips/'))).toEqual([]);
    // And it opens nothing after.
    drive(a, swept + STEP, swept + 2 * LAPSE, [C]);
    expect(stateOf(a)).toBeNull();
  }, 30_000);

  it('drops a switch nothing stands behind a lapse on (a peer\'s forgery), and the round under way goes on', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // A drives the owner-run table; B's pass is down and the window armed.
    drive(a, T0, T0 + 2_000, [C], () => stateOf(a) !== null);
    sync(T0 + 2_000, ...pages);
    at(b, T0 + 2_000);
    expect(b.casino.writeMyCrapsBets(C, b.pid, [bet('pass', 10)])).toBe(true);
    sync(T0 + 2_000, ...pages);
    drive(a, T0 + 2_000, T0 + 15_000, [C]);
    const armed = stateOf(a)!;
    expect(armed).toMatchObject({ phase: 'betting', round: 1, phaseDeadline: expect.any(Number) });
    // A peer's one key, near the window's end: a craps name the doc holds
    // nothing of.
    const forged = 'k' + '12'.repeat(12);
    at(b, T0 + 15_000);
    b.doc.getMap('casino').set(`cfg:computed:${C}`, { v: 1, inc: forged });
    sync(T0 + 15_000, ...pages);
    expect(a.casino.computedSwitchBare(C)).toBe(true);
    expect(a.casino.isComputedFor(C, 'craps')).toBe(true);
    // Stood down a lapse, the window's end passing, nothing closed…
    const T1 = T0 + 15_000 + STEP;
    const dropped = drive(a, T1, T1 + 2 * LAPSE, [C], () => a.casino.computedIncOf(C) === null);
    expect(dropped - T1).toBeGreaterThanOrEqual(LAPSE);
    expect(dropped - T1).toBeLessThanOrEqual(LAPSE + STEP);
    expect(dropped).toBeGreaterThan(armed.phaseDeadline!);
    expect(stateOf(a)).toEqual(armed);
    expect(a.casino.computedIncEnded(C, forged)).toBe(true);
    // …then the round goes on: closed at once (its window over), thrown.
    const rig = diceTo(3, 4);
    const closed = drive(a, dropped + STEP, dropped + 5_000, [C], () => stateOf(a)?.phase === 'closing');
    expect(closed).toBeLessThanOrEqual(dropped + 2 * STEP);
    const thrown = drive(a, closed + STEP, closed + 10_000, [C], () => a.casino.readDiceThrow(C)?.round === 1);
    await flush();
    rig.mockRestore();
    expect(thrown).toBeLessThan(closed + 10_000);
    expect(stateOf(a)).toMatchObject({ phase: 'settled', round: 1, dice: [3, 4] });
    sync(thrown, ...pages);
    expect(chipsOf(b, b)).toEqual([1_010]);
  }, 30_000);
});

// ── ✋ The house's ROLL ───────────────────────────────────────────────────────

describe("the house's ROLL at a computed craps table", () => {
  it('says nobody rolls it by hand, and opens nothing', async () => {
    const [a] = await room(['A']);
    at(a, T0);
    expect(a.table.switchComputedOn(C, 'craps', T0)).toBe('ok');
    for (let i = 0; i < 3; i++) {
      expect(a.craps.pressManualRoll(C, at(a, T0 + i * 1_000))).toBe(a.craps.NO_HAND_ROLL);
    }
    expect(a.craps.NO_HAND_ROLL).toBe("NOBODY ROLLS THIS TABLE BY HAND — THE ROLL IS DECIDED ONCE THE BETTORS' SEEDS ARE IN");
    expect(stateOf(a)).toBeNull();
    // (On the owner-run table, the first press opens the window.)
    expect(a.craps.pressManualRoll(OWNER_RUN, at(a, T0 + 3_000))).toMatch(/PRESS AGAIN/);
  }, 30_000);

  it('throws nothing on a turn its page held when a forged switch came, until the lease holder drops it', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    // A manual table: A's ROLL opens it, B bets, A's ROLL closes it.
    expect(a.craps.pressManualRoll(C, at(a, T0))).toMatch(/PRESS AGAIN/);
    sync(T0, ...pages);
    at(b, T0);
    expect(b.casino.writeMyCrapsBets(C, b.pid, [bet('pass', 10)])).toBe(true);
    sync(T0, ...pages);
    expect(a.craps.pressManualRoll(C, at(a, T0 + 1_000))).toBeNull();
    const closing = stateOf(a)!;
    expect(closing).toMatchObject({ phase: 'closing', round: 1, operator: expect.any(String) });
    // A peer's switch comes in as the turn begins.
    at(b, T0 + 1_000);
    sync(T0 + 1_000, ...pages);
    b.doc.getMap('casino').set(`cfg:computed:${C}`, { v: 1, inc: 'k' + '12'.repeat(12) });
    sync(T0 + 1_000, ...pages);
    // Its page's turn ticks (World: tickManualCraps every frame) long past
    // the throw's deadline: nothing thrown, nothing settled.
    for (let T = T0 + 1_000; T <= T0 + 1_000 + 3 * LAPSE; T += STEP) a.craps.tickManualCraps(C, at(a, T));
    await flush();
    expect(stateOf(a)).toEqual(closing);
    expect(a.casino.readDiceThrow(C)).toBeNull();
    expect(a.craps.pressManualRoll(C, at(a, T0 + 1_000 + 3 * LAPSE))).toBe(a.craps.NO_HAND_ROLL);
    // The house's lease holder (A's page here) drops the switch a lapse on,
    // and the turn throws, as before the forgery.
    const T1 = T0 + 2_000 + 3 * LAPSE;
    const dropped = drive(a, T1, T1 + 3 * LAPSE, [C], () => a.casino.computedIncOf(C) === null);
    // (Its turn after the lease's settle; dropped a lapse after its first look.)
    expect(dropped - T1).toBeGreaterThanOrEqual(1_500 + LAPSE);
    expect(dropped - T1).toBeLessThanOrEqual(1_500 + LAPSE + STEP);
    expect(stateOf(a)).toEqual(closing);
    const rig = diceTo(3, 4);
    const thrown = drive(a, dropped + STEP, dropped + 5_000, [C], () => a.casino.readDiceThrow(C)?.round === 1);
    await flush();
    rig.mockRestore();
    expect(thrown).toBeLessThanOrEqual(dropped + 2 * STEP);
    expect(stateOf(a)).toMatchObject({ phase: 'settled', round: 1, dice: [3, 4] });
    sync(thrown, ...pages);
    expect(chipsOf(b, b)).toEqual([1_010]);
  }, 30_000);
});

// ── 🔍 Whose switch counts ───────────────────────────────────────────────────

describe('whose switch stands a craps table down', () => {
  it("a craps one lost while its incarnation is live (a peer's delete) does; a roulette one, live or lost, doesn't", async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    expect(a.table.switchComputedOn(C, 'craps', T0)).toBe('ok');
    expect(a.table.switchComputedOn('craps-7', 'roulette', T0)).toBe('ok');
    expect(a.table.switchComputedOn(OWNER_RUN, 'roulette', T0)).toBe('ok');
    sync(T0, ...pages);
    expect(a.casino.isComputedFor(C, 'craps')).toBe(true);
    expect(a.casino.isComputedFor('craps-7', 'craps')).toBe(false);
    expect(a.casino.isComputedFor('craps-7', 'roulette')).toBe(true);
    // A peer deletes two of the switches (the room puts them back: not here).
    at(b, T0);
    for (const t of [C, 'craps-7']) b.doc.getMap('casino').delete(`cfg:computed:${t}`);
    sync(T0, ...pages);
    expect(a.casino.computedSwitchLost(C, 'craps')).toBe(true);
    expect(a.casino.computedSwitchLost('craps-7', 'craps')).toBe(false);
    expect(a.casino.computedSwitchLost('craps-7')).toBe(true);
    drive(a, T0, T0 + 2 * LAPSE, [C, 'craps-7', OWNER_RUN]);
    expect(stateOf(a, C)).toBeNull();
    expect(a.craps.pressManualRoll(C, at(a, T0 + 2 * LAPSE))).toBe(a.craps.NO_HAND_ROLL);
    // The roulette names: the stickman runs on, under the switch and without it.
    for (const t of ['craps-7', OWNER_RUN]) expect(stateOf(a, t)).toMatchObject({ phase: 'betting', round: 1 });
  }, 30_000);

  it('a roulette name written over a live craps one does too, until the room puts the craps one back', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    expect(a.table.switchComputedOn(C, 'craps', T0)).toBe('ok');
    const cinc = a.casino.computedIncOf(C)!;
    // (A's page runs the table, as World has it every frame.)
    a.table.tickComputedTables([CRAPS_REF], T0);
    sync(T0, ...pages);
    // A peer's write over the switch: a roulette name the doc holds nothing of.
    const forged = 'c' + '12'.repeat(12);
    at(b, T0);
    b.doc.getMap('casino').set(`cfg:computed:${C}`, { v: 1, inc: forged });
    sync(T0, ...pages);
    expect(a.casino.isComputedFor(C, 'craps')).toBe(false);
    expect(a.casino.computedSwitchLost(C)).toBe(false);
    expect(a.casino.computedSwitchLost(C, 'craps')).toBe(true);
    expect(a.craps.crapsRunsItself(C)).toBe(true);
    // The stickman's frames before the computed duties' (World's order): no
    // come-out, no ROLL, the bare name dropped a lapse on (still lost).
    drive(a, T0, T0 + 2 * LAPSE, [C]);
    expect(stateOf(a)).toBeNull();
    expect(a.craps.pressManualRoll(C, at(a, T0 + 2 * LAPSE))).toBe(a.craps.NO_HAND_ROLL);
    expect(a.casino.computedIncOf(C)).toBeNull();
    expect(a.casino.computedIncEnded(C, forged)).toBe(true);
    expect(a.craps.crapsRunsItself(C)).toBe(true);
    // A page running the table puts the craps switch back.
    a.table.tickComputedTables([CRAPS_REF], at(a, T0 + 2 * LAPSE + STEP));
    expect(a.casino.computedIncOf(C)).toBe(cinc);
    expect(a.casino.isComputedFor(C, 'craps')).toBe(true);
  }, 30_000);

  it('a bare roulette name under an owner-run craps table stands nothing down, and goes a lapse on', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    drive(a, T0, T0 + 2_000, [C], () => stateOf(a) !== null);
    sync(T0 + 2_000, ...pages);
    at(b, T0 + 2_000);
    expect(b.casino.writeMyCrapsBets(C, b.pid, [bet('pass', 10)])).toBe(true);
    sync(T0 + 2_000, ...pages);
    drive(a, T0 + 2_000, T0 + 3_000, [C], () => stateOf(a)?.phaseDeadline != null);
    const armed = stateOf(a)!;
    const forged = 'c' + '12'.repeat(12);
    at(b, T0 + 3_000);
    b.doc.getMap('casino').set(`cfg:computed:${C}`, { v: 1, inc: forged });
    sync(T0 + 3_000, ...pages);
    expect(a.casino.computedSwitchBare(C)).toBe(true);
    expect(a.craps.crapsRunsItself(C)).toBe(false);
    // Dropped a lapse on, the window running on meanwhile…
    const T1 = T0 + 3_000 + STEP;
    const dropped = drive(a, T1, T1 + 2 * LAPSE, [C], () => a.casino.computedIncOf(C) === null);
    expect(dropped - T1).toBeGreaterThanOrEqual(LAPSE);
    expect(dropped - T1).toBeLessThanOrEqual(LAPSE + STEP);
    expect(a.casino.computedIncEnded(C, forged)).toBe(true);
    expect(stateOf(a)).toEqual(armed);
    // …and it closes on time, and throws.
    const closed = drive(a, dropped + STEP, armed.phaseDeadline! + 1_000, [C], () => stateOf(a)?.phase === 'closing');
    expect(closed).toBeGreaterThanOrEqual(armed.phaseDeadline!);
    expect(closed).toBeLessThan(armed.phaseDeadline! + STEP);
    const rig = diceTo(3, 4);
    const thrown = drive(a, closed + STEP, closed + 10_000, [C], () => a.casino.readDiceThrow(C)?.round === 1);
    await flush();
    rig.mockRestore();
    expect(thrown).toBeLessThan(closed + 10_000);
    expect(stateOf(a)).toMatchObject({ phase: 'settled', round: 1, dice: [3, 4] });
  }, 30_000);
});

// ── 🗑 A removal ─────────────────────────────────────────────────────────────

describe("an earlier build's removal of a computed craps table", () => {
  it('ends its incarnation where it is heard, so the table put back under the same id is owner-run: no switch put back, the stickman opens', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    at(a, T0);
    expect(a.table.switchComputedOn(C, 'craps', T0)).toBe('ok');
    const cinc = a.casino.computedIncOf(C)!;
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    // (A's page runs the table, as World has it every frame.)
    a.table.tickComputedTables([CRAPS_REF], T0);
    sync(T0, ...pages);
    // PR 2's removal, run on B's page (casinoDoc clearTableKeys there): it
    // reads the craps name as none, so marks nothing of it, and deletes the
    // switch with the table's keys.
    at(b, T0 + 1_000);
    b.doc.transact(() => {
      const m = b.doc.getMap('casino');
      m.set(`gone:${C}:${b.casino.tableIncFor(C)}`, 1);
      m.delete(`cfg:computed:${C}`);
      for (const key of [...m.keys()]) {
        if ([`table:${C}`, `croupier:${C}`, `cfg:backend:${C}`, `cfg:fairness:${C}`, `throw:${C}`].includes(key)
          || ['bets', 'seat', 'fseed'].some((x) => key.startsWith(`${x}:${C}:`))) m.delete(key);
      }
    });
    sync(T0 + 1_000, ...pages);
    expect(a.casino.computedIncEnded(C, cinc)).toBe(false);
    // A hears of it (World: the table out of the layout), the felt let go.
    at(a, T0 + 1_000);
    a.craps.closeCrapsTable(C, 'heard');
    sync(T0 + 1_000, ...pages);
    for (const p of pages) {
      expect(p.casino.computedIncEnded(C, cinc)).toBe(true);
      expect(p.casino.readChips(a.pid)).toBe(1_000);
    }
    // Put back under the same id at once: A's frames as World runs them
    // (the stickman, then the computed duties) put no switch back.
    const T1 = T0 + 1_000 + STEP;
    for (let T = T1; T <= T1 + 3_000; T += STEP) {
      at(a, T);
      if (a.croupier.takeTableTurn(T)) a.craps.tickAutoStickman(C);
      a.table.tickComputedTables([CRAPS_REF], T);
    }
    expect(a.casino.computedIncOf(C)).toBeNull();
    expect(a.craps.crapsRunsItself(C)).toBe(false);
    expect(stateOf(a)).toMatchObject({ phase: 'betting', round: 1 });
  }, 30_000);
});

// ── ⚖️ Fair seeds ─────────────────────────────────────────────────────────────

describe('Fair seeds at a computed craps table', () => {
  it("never count it Fair, nor commit a seed to an earlier build's Fair come-out on it", async () => {
    const F = 'craps-3'; // (no fairness set: the room's default, Fair)
    const [a] = await room(['A']);
    at(a, T0);
    expect(a.fair.isFairTable(F, 'craps')).toBe(true);
    expect(a.table.switchComputedOn(F, 'craps', T0)).toBe('ok');
    expect(a.fair.isFairTable(F, 'craps')).toBe(false);
    expect(a.fair.roundIsFair(F, 'craps')).toBe(false);
    // An earlier build opens a Fair come-out on it, and this page's player
    // has a list there.
    a.casino.transactCasino(() => a.casino.writeCrapsTableState(F, {
      kind: 'craps', phase: 'betting', round: 1, point: null, dice: null, result: null, resultAt: 0, payouts: null,
      fairMode: 'multiparty', houseCommit: a.fair.newHouseCommit(F, 1), ...a.casino.tableOpening(F),
    }));
    expect(a.casino.writeMyCrapsBets(F, a.pid, [bet('pass', 10)])).toBe(true);
    expect(a.fair.roundIsFair(F, 'craps')).toBe(false);
    a.fair.tickFairSeeds(F, 'craps', a.pid, T0, true);
    expect(ownerRunKeys(a, F).filter((k) => k.includes('fseed:'))).toEqual([]);
    // (The control: on an owner-run craps table the same writes a seed.)
    const G = 'craps-4';
    a.craps.openCrapsBetting(G, 1, null);
    expect(a.fair.roundIsFair(G, 'craps')).toBe(true);
    expect(a.casino.writeMyCrapsBets(G, a.pid, [bet('pass', 10)])).toBe(true);
    a.fair.tickFairSeeds(G, 'craps', a.pid, T0, true);
    expect(ownerRunKeys(a, G).filter((k) => k.includes('fseed:'))).toHaveLength(1);
  }, 30_000);
});

// ── 🌐 World's wiring ────────────────────────────────────────────────────────

describe('the computed duties, handed the tables', () => {
  it("end a computed craps table AWAY_MS on when handed only roulette tables, as one that left the room; handed it with its game, they don't", async () => {
    // Handed the roulette table alone (as World did before craps was
    // computed): the craps table's felt let go a minute on.
    const [a] = await openCrapsRoom(['A'], T0);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(a.casino.readChips(a.pid)).toBe(990);
    const ended = run([a], T0, T0 + AWAY + 5_000, { step: STEP, tables: [PAGE_TABLE], until: () => !a.casino.isComputedTable(C) });
    expect(ended - T0).toBeGreaterThanOrEqual(AWAY);
    expect(ended - T0).toBeLessThanOrEqual(AWAY + STEP);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    // Handed both, each with its game (World now): it plays on.
    const [b] = await openCrapsRoom(['B'], T0);
    expect(crapsBet(b, [bet('pass', 10)], T0)).toBe('ok');
    run([b], T0, T0 + AWAY + 10_000, { step: STEP, tables: [PAGE_TABLE, CRAPS_REF] });
    expect(b.casino.isComputedFor(C, 'craps')).toBe(true);
    expect(b.table.computedDecidedTo(C)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
