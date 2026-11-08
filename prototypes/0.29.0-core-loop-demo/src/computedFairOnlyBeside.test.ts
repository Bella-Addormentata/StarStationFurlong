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
import { seedTable } from './computedFold';
import { faironlyInc, sealFin } from './computedFairOnly';
import { delegation, hex, house, NAME, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_ROOM, PAGE_TABLE as TABLE, run } from './computedPageKit';
import type { Page } from './computedPageKit';
import { red } from './computedTestKit';

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

describe('the seeds behind the slips of a page-signed incarnation, while its table plays a FAIR ONLY game', () => {
  /** A's page, the page-signed incarnation switched on and a slip of A's frozen on it. */
  async function frozen(): Promise<{ a: Page; felt: string }> {
    const [a] = await openRoom(['A'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    return { a, felt };
  }

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

  it('are kept while a game is played though another page-signed incarnation takes the switch: the table takes no state from it, and the incarnation this page ran goes on when the game ends', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is the one played, the switch a hint)
    let at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS); // (short of COMPACT_MS: the incarnation is not final)
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    // The owner's page names the game again, and the game ends over its name: the
    // switch is put back over the dead hint, on the incarnation this page ran.
    switchTo(a, G.inc);
    record(a, end);
    at = tick(a, at, 2 * a.table.REPUT_MS);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull(); // (the slip it froze can be revealed)
    expect(a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c).toBe(felt);
  });

  it.each(WHERE)('go when the game ends with the switch on the other incarnation, which the table then plays, %s', async (_, tables) => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    record(a, end);
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    tick(a, at, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
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
});
