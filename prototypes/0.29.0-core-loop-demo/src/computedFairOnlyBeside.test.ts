/**
 * 🔒🧮 A page-signed table beside the FAIR ONLY game its table plays (design
 * §8.4, PR 6c-4a-2): the duties of the page-signed incarnation that run while
 * a game is the one played (computedIncOf, S9). Until PR 6c-4b opens the duties
 * at a game, none runs there, and what the page wrote for the page-signed
 * incarnation (its frozen slips, and the seeds behind them) waits for the day
 * the game ends or the deed moves: the page-signed incarnation is live all that
 * time, and the table goes back to it.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the page's doc as its owner's page would write its
 * records, in the room the page kit binds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { seedTable, slipCommit, slipKeyFor } from './computedFold';
import { faironlyInc, sealFin } from './computedFairOnly';
import { delegation, hex, house, NAME, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { clockOf, deliver, keysIn, openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_ROOM, PAGE_TABLE as TABLE, run, send, signAs, sync, updatesOf } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, red } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The game the owner opens at the table, in the page kit's room, and its end. */
const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(G, 'p', { dl: delegation(owner, house.pub, PAGE_ROOM) });
const end = trimOf(G, 'p', {
  ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(G, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {},
});

const seedCtx = (p: Page, r: number) => ({ room: CTX.room, table: seedTable(CTX), round: r, party: p.pid, house: '' });
const casinoOf = (p: Page) => p.doc.getMap('casino');
const computedOf = (p: Page) => p.doc.getMap('casinoComputed');

function record(p: Page, rec: { key: string; value: unknown }): void {
  p.doc.transact(() => computedOf(p).set(rec.key, rec.value));
}

function switchTo(p: Page, inc: string): void {
  p.doc.transact(() => casinoOf(p).set(`cfg:computed:${TABLE}`, { v: 1, inc }));
}

/** Frames of `p` every `step` (STEP) over `ms` from `from`, the room's tables
 *  being `tables` (the page kit's one by default); the time after. */
function tick(p: Page, from: number, ms: number, step = STEP, tables?: string[]): number {
  run([p], from, from + ms, { step, tables });
  return from + ms + step;
}

/** A's page, the page-signed incarnation switched on and a slip of A's frozen on it. */
async function frozen(): Promise<{ a: Page; felt: string }> {
  const [a] = await openRoom(['A'], T0);
  expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
  const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
  expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  return { a, felt };
}

describe('the seeds behind the slips of a page-signed incarnation, while its table plays a FAIR ONLY game', () => {
  it('are kept: the table plays the game, the page-signed incarnation the switch names is waiting, and a page lets go of nothing it wrote for it', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  it('are kept whichever of them the switch names: a FAIR ONLY name is a hint, not another incarnation taking its place', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.computedLiveTables()).toEqual([]); // (the switch names no page-signed incarnation: the away duty has none to watch)
    tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc }); // (a live game\'s name is left)
  });

  it('are kept past the compaction wait while the switch names the game: the page-signed incarnation is not an ended one, its session, slip and seed stay', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    const ses = `ses:${TABLE}:${INC}:g`;
    const records = (): string[] => [...((computedOf(a).get(ses) as Y.Map<unknown> | undefined)?.keys() ?? [])].sort();
    const before = records();
    expect(before.length).toBeGreaterThan(0); // (the slip, among them)
    tick(a, T0 + STEP, 2 * a.table.COMPACT_FALLBACK_MS, 1_000); // (past COMPACT_MS, and the wait of a page that wrote no slip of its own)
    expect(a.casino.computedEndedIncs()).toEqual([]);
    expect(records()).toEqual(before);
    expect(computedOf(a).get(ses)).toBeInstanceOf(Y.Map);
    expect(casinoOf(a).has(`gone:${TABLE}:${INC}`)).toBe(false);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  it('are still there when the game ends and the table goes back to the page-signed incarnation: the switch put back, the slip frozen', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    const at = tick(a, T0 + STEP, a.table.REPUT_MS);
    record(a, end);
    expect(a.casino.computedIncEnded(TABLE, G.inc)).toBe(true);
    tick(a, at, 2 * a.table.REPUT_MS);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c).toBe(felt);
  });

  /** Another page-signed incarnation the doc holds a session of, that nothing has ended. */
  const other = 'c' + '5d'.repeat(12);
  function takeSwitch(p: Page): void {
    p.doc.transact(() => {
      casinoOf(p).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(p).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
  }

  /** The table in the room's list, or out of it: then no duty of a table runs
   *  (tableOf replaces no state, putSwitchBack puts nothing back) and the
   *  compaction duty alone looks, as it does at a table a removal took out. */
  const WHERE: [string, string[] | undefined][] = [['at a table in the room', undefined], ['at a table out of the room: the compaction duty alone looks', []]];

  it.each(WHERE)('go when another page-signed incarnation takes the switch and no game is played, as ever, %s', async (_, tables) => {
    const { a, felt } = await frozen();
    takeSwitch(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  // A game defers the duties of a page-signed incarnation, never its end or the
  // switch's moving to another: the stakes of the one the switch left are freed
  // (switchHoldsFelts), so nothing of it may settle afterwards.
  it('go when another page-signed incarnation takes the switch while a game is played, as they do when none is: the state is replaced by the other\'s, and when the game ends the switch is put back on that one', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is the one played, the switch a hint)
    let at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS); // (short of COMPACT_MS: the incarnation is not final)
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull(); // (nothing of it will be revealed now)
    // The owner's page names the game again, and the game ends over its name: the
    // switch is put back over the dead hint, on the incarnation this page runs now.
    switchTo(a, G.inc);
    record(a, end);
    at = tick(a, at, 2 * a.table.REPUT_MS);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    expect(a.casino.computedFoldOf(TABLE)!.felts.size).toBe(0); // (the slip it froze is nobody's to settle)
  });

  // A doc that holds part of an update may read a switch that a parked write has
  // since overwritten: nothing is let go of until it is whole (compactDuty waits too).
  it('are kept while the page holds part of an update, the switch it reads being one a parked write overwrites: the state is replaced only when the doc is whole and the switch still names the other', async () => {
    const [a, b, c] = await openRoom(['A', 'B', 'C'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b, c);
    // B and C write at once, neither having heard of the other: B moves the switch to the other
    // incarnation; C writes twice, the second naming the game again (and it wins, C being the
    // higher client). A is handed B's write and C's second only.
    const fromB = updatesOf(b, () => {
      b.doc.transact(() => {
        casinoOf(b).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
        computedOf(b).set(`ses:${TABLE}:${other}:g`, new Y.Map());
      });
    });
    const fromC = updatesOf(c, () => {
      c.doc.transact(() => casinoOf(c).set('unrelated', 1));
      c.doc.transact(() => casinoOf(c).set(`cfg:computed:${TABLE}`, { v: 1, inc: G.inc }));
    });
    expect(fromB).toHaveLength(1);
    expect(fromC).toHaveLength(2);
    deliver(T0 + 2, a, [fromB[0], fromC[1]]); // (C's first never came: its second is parked)
    expect(a.casino.casinoWhole()).toBe(false);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(other); // (what the doc reads of the switch)
    const at = tick(a, T0 + 3, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    deliver(at, a, [fromC[0]]);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc }); // (C's write won)
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull();
    tick(a, at + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  // A name that is no other incarnation takes nothing's place: one nothing opened
  // is put back over (the switch is junk, as a missing one is), and one that has
  // ended names no table.
  const JUNK = 'c' + '6e'.repeat(12);
  it.each([
    ['a page-signed name nothing opened', (p: Page) => switchTo(p, JUNK)],
    ['a page-signed incarnation that has ended', (p: Page) => { takeSwitch(p); p.doc.transact(() => casinoOf(p).set(`gone:${TABLE}:${other}`, 1)); }],
  ] as [string, (p: Page) => void][])('are kept while a game is played when the switch names %s: no incarnation took their place, and the switch is put back over the name', async (_, name) => {
    const { a, felt } = await frozen();
    record(a, root);
    name(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull();
    tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
  });

  it('are kept at a table out of the room too, until the switch leaves them for another page-signed incarnation: then the compaction duty lets go of them, a game played or not', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    takeSwitch(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    tick(a, at, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  it.each(WHERE)('go when another page-signed incarnation takes the switch while a game is played, and the game ends with the switch still on it, which the table then plays, %s', async (_, tables) => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull(); // (the switch left it: over, a game played or not)
    record(a, end);
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    tick(a, at, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
  });

  it('go with the end of the incarnation, a game played or not: the switch left it, and compaction ended it', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    tick(a, T0 + STEP, 2 * a.table.COMPACT_FALLBACK_MS, 1_000);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  // Nothing but the end of the incarnation itself is in the way here: the switch
  // names the game, no other incarnation took its place, and a removal marked it
  // ended. No table will go back to it, so nothing waits for it: compaction lets go
  // of the seeds as it would with no game played.
  it.each(WHERE)('go with the end of the incarnation when the switch names the game and a removal ended it: no table goes back to it, %s', async (_, tables) => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull(); // (it waits, as long as it is not an ended one)
    a.doc.transact(() => casinoOf(a).set(`gone:${TABLE}:${INC}`, 1));
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    tick(a, at, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  // A hint is a FAIR ONLY name in the switch that no live game stands behind: a
  // game that has ended, or a name nothing opened. The page puts the switch back
  // over it in its turn; until it has, the compaction duty must not take the
  // incarnation for an ended one and let go of the seeds behind its frozen slips.
  it('are kept at a table out of the room under a made-up FAIR ONLY name in the switch: the compaction duty alone looks, and a hint is no end', async () => {
    const { a, felt } = await frozen();
    switchTo(a, G.inc); // (no record of the game: a name nothing opened)
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    tick(a, T0 + STEP, 2_000, STEP, []);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  it('are kept by a page waking from a sleep under a made-up name, until it is awake and puts the switch back', async () => {
    const { a, felt } = await frozen();
    tick(a, T0 + STEP, 800);
    switchTo(a, G.inc); // (a name nothing opened, arrived while the page slept)
    const wake = T0 + 11_000;
    const at = tick(a, wake, 2_000); // (the lapse: the page is not awake, nothing is put back yet)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    tick(a, at, 7_000);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  it('are kept by a page waking from a sleep after the game ended, the switch carrying its dead name: put back once awake', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    tick(a, T0 + STEP, 800);
    record(a, end); // (the game ends while the page sleeps)
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the dead name: nothing live)
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    const wake = T0 + 11_000;
    const at = tick(a, wake, 2_000);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    tick(a, at, 7_000);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });
});

describe('what the room does about a page-signed incarnation waiting beside a FAIR ONLY game', () => {
  it('the card\'s readers of a table state find none at a game, and let go of nothing of the page-signed incarnation beside it', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.table.computedCheckpointView(TABLE, T0 + 500)).toBeNull();
    expect(a.table.computedRoundCheck(TABLE, T0 + 500)).toBeNull();
    expect(a.table.computedMine(TABLE, T0 + 500)).toBeNull();
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull(); // (the seed behind the frozen slip survives the card's reads)
  });

  it('the switch row of the card reads the table on at a game, and the page-signed incarnation beside it stays as it is', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    const state = a.table.computedSwitchState(TABLE, 'roulette', true, T0 + 500);
    expect(state.on).toBe(true);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  // Interim, until the house has controls over a game (PR 6c-4c, 6c-5): the
  // press has no game of its own to finalise, so it takes the hint away and
  // marks the house's choice, and the game goes on.
  it('the card\'s switch-off at a game the switch names is not refused: the hint goes, the house\'s choice is marked, and the game is not ended', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    const at = tick(a, T0 + STEP, 800);
    expect(a.table.switchComputedOff(TABLE, at)).toBe('ok');
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    expect(casinoOf(a).get(`cfg:ownerrun:${TABLE}`)).toBe(1);
    expect(a.casino.isComputedTable(TABLE)).toBe(true); // (the game goes on)
    expect(a.casino.computedIncEnded(TABLE, G.inc)).toBe(false);
    expect(casinoOf(a).has(`gone:${TABLE}:${G.inc}`)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  it('out of the room for AWAY_MS, the page-signed incarnation the switch names is ended as a removal ends it, and the game is left alone', async () => {
    const { a } = await frozen();
    record(a, root);
    expect(a.casino.computedLiveTables()).toEqual([{ t: TABLE, inc: INC }]); // (the page-signed one: the game is nobody's to watch for the room)
    tick(a, T0 + STEP, 2 * a.table.AWAY_MS + 5_000, 1_000, []);
    expect(casinoOf(a).has(`gone:${TABLE}:${INC}`)).toBe(true);
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    expect(casinoOf(a).has(`gone:${TABLE}:${G.inc}`)).toBe(false);
    expect(a.casino.isComputedTable(TABLE)).toBe(true); // (the game goes on)
  });
});

describe('the stakes and the waits of a page-signed incarnation, while its table plays a FAIR ONLY game', () => {
  /** Two pages, a slip each on the page-signed incarnation (red 9, black 9). */
  async function staked(): Promise<{ a: Page; b: Page }> {
    const [a, b] = await openRoom(['A', 'B'], T0);
    clockOf(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    clockOf(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [black(9)], T0)).toBe('ok');
    sync(T0, a, b);
    expect(a.casino.readChips(a.pid)).toBe(991);
    expect(b.casino.readChips(b.pid)).toBe(991);
    return { a, b };
  }

  it('stay held while the game is played, the switch naming it or not: the slips settle when the game ends, so the chips are not there to spend meanwhile', async () => {
    const { a, b } = await staked();
    record(a, root);
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    switchTo(a, G.inc);
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    clockOf(a, T0 + 3);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(991); // (what is not staked, no more)
  });

  it('stay held through the game\'s end: the switch still names the dead game until it is put back, and no recount frees them between', async () => {
    const { a, b } = await staked();
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    record(a, end);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncEnded(TABLE, G.inc)).toBe(true);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc }); // (not put back yet)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    // (A record in the incarnation's own session counts it again meanwhile: still held.)
    a.doc.transact(() => (computedOf(a).get(`ses:${TABLE}:${INC}:g`) as Y.Map<unknown>).set('x:junk', 1));
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    run([a, b], T0 + 3, T0 + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
  });

  it('are freed when another page-signed incarnation takes the switch and no game is played, as ever', async () => {
    const { a, b } = await staked();
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: 'c' + '5d'.repeat(12) });
      computedOf(a).set(`ses:${TABLE}:${'c' + '5d'.repeat(12)}:g`, new Y.Map());
    });
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  it('are freed when another page-signed incarnation takes the switch while a game is played, and nothing of them comes back to settle when the game ends: the switch goes back to the other', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is still the one played)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    // (the chips are free: they can be spent)
    clockOf(a, T0 + 3);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(1_000);
    const at = run([a, b], T0 + 4, T0 + 2 * a.table.REPUT_MS, { step: STEP });
    // The game ends over a hint naming it again; the pages put the switch back on the
    // incarnation they run now, and the slips of the first are not resumed to settle
    // against chips that went meanwhile.
    switchTo(a, G.inc);
    record(a, end);
    sync(at, a, b);
    run([a, b], at + STEP, at + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    expect(a.casino.readChips(a.pid)).toBe(0);
    expect(b.casino.readChips(b.pid)).toBe(1_000);
  });

  /** Both pages ticked until the close is in, then the game opens (its root and the
   *  switch naming it) and is played for `ms` with both pages ticking, then ends. */
  async function playedBeside(ms: number): Promise<{ a: Page; b: Page; at: number }> {
    const { a, b } = await staked();
    const closed = (): boolean => keysIn(a, 'c', 1).length > 0;
    const at = run([a, b], T0 + STEP, T0 + 60_000, { step: STEP, until: closed });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
    expect(keysIn(a, 'r', 1)).toEqual([]); // (no seed is out: the pages have not ticked since the close came)
    record(a, root);
    switchTo(a, G.inc);
    sync(at, a, b);
    const mid = run([a, b], at + STEP, at + ms, { step: STEP });
    record(a, end);
    sync(mid, a, b);
    return { a, b, at: mid };
  }

  it('start their waits afresh when the table goes back to them: a close seen before the game does not forfeit the player whose page had not yet revealed', async () => {
    const { a, b, at } = await playedBeside(40_000);
    run([a, b], at + STEP, at + 20_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    const round = a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!;
    expect(round.decided).toBe('reveals');
    expect(round.forfeit).toBeUndefined();
    expect([...round.counted].sort()).toEqual([a.pid, b.pid].sort());
    expect(b.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!.decided).toBe('reveals');
  });

  it('start a betting window afresh too: the view built before the game, of a window that had run out, is not served again, the session being as it was', async () => {
    const [a] = await openRoom(['A'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const window = a.table.BET_WINDOW_MS;
    // The page ticks to just short of the deadline and reads the table after it: the view of a
    // window run out is built and kept (the fold is the same until a close comes, and nothing
    // woke the page), the close not written yet.
    run([a], T0 + STEP, T0 + window - 1_000, { step: STEP });
    const expired = a.table.readComputedRoulette(TABLE, T0 + window + 1_000)!;
    expect(expired.phase).toBe('betting');
    expect(expired.phaseDeadline!).toBeLessThan(T0 + window + 1_000);
    expect(keysIn(a, 'c', 1)).toEqual([]);
    // A game opens at the table and is played for a while, and ends.
    record(a, root);
    switchTo(a, G.inc);
    const mid = run([a], T0 + window + 1_200, T0 + window + 41_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]); // (no duty of the page-signed incarnation ran meanwhile)
    record(a, end);
    const back = run([a], mid, mid + 20_000, { step: STEP, until: () => a.casino.computedIncOf(TABLE) === INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    // The table is the page-signed incarnation's again: its window starts from here, as after a wake.
    expect(keysIn(a, 'c', 1)).toEqual([]);
    expect(a.table.readComputedRoulette(TABLE, back + 500)!.phaseDeadline!).toBeGreaterThanOrEqual(back + window - 1_000);
    run([a], back + STEP, back + window - 2_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
    run([a], back + window - 1_800, back + window + 5_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
  });

  it('start afresh for the other incarnation that took the switch while the game was played, too: a slip that came to the page meanwhile does not run its betting window out', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const other = 'c' + '5b'.repeat(12);
    const ctxOther = { room: PAGE_ROOM, t: TABLE, inc: other };
    const window = a.table.BET_WINDOW_MS;
    let at = tick(a, T0 + STEP, 1_000); // (A runs the page-signed incarnation: its state is there)
    record(a, root);
    switchTo(a, G.inc);
    at = tick(a, at, 2_000); // (a game is played: A waits)
    // B's page, which has not heard of the game, opened the other incarnation and put a slip down on
    // it. The doc hands A both while the game is played, and the switch is moved to the other.
    b.doc.transact(() => {
      const ses = new Y.Map<unknown>();
      const slip = signAs(b, 'slip', { r: 1, p: b.pid, v: 1, b: [red(9)], c: slipCommit(ctxOther, 1, b.pid, hex('9', 32)) }, ctxOther);
      ses.set(slipKeyFor(ctxOther)(slip)!, slip);
      computedOf(b).set(`ses:${TABLE}:${other}:g`, ses);
    });
    send(at, b, a);
    a.doc.transact(() => casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other }));
    // A single look at the table (the card reads it) is what puts the other's state in place of the
    // one that waited; the page's frames go on, the table out of its list.
    clockOf(a, at);
    a.table.computedCheckpointView(TABLE);
    at = tick(a, at + STEP, 3 * window, STEP, []); // (the window would have run out, long over, had it run)
    switchTo(a, G.inc);
    record(a, end);
    const back = run([a], at, at + 20_000, { step: STEP, until: () => a.casino.computedIncOf(TABLE) === other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    // The table is the other incarnation's now, and its window starts from here, as after a wake.
    const view = a.table.readComputedRoulette(TABLE, back + 2 * STEP)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline!).toBeGreaterThanOrEqual(back + window - 1_000);
  });

  it('still run: a player whose page never reveals is forfeited a grace after the table goes back, not at once', async () => {
    const { a, b, at } = await playedBeside(40_000);
    // B's page is gone: only A's ticks, its seed goes out, and the grace runs from the table's return.
    sync(at, a, b);
    const soon = run([a], at + STEP, at + 1_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!.decided).toBeNull();
    run([a], soon, soon + 30_000, { step: STEP });
    const round = a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!;
    expect(round.decided).toBe('forfeit');
    expect(round.forfeit!.rec.n).toEqual([a.pid]);
  });
});
