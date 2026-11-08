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
import { dutyRank, seedTable, slipCommit, slipKeyFor } from './computedFold';
import { faironlyInc, NO_CLOSE, sealCk, sealFin } from './computedFairOnly';
import { delegation, hex, house, NAME, OPENING_CARRY, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { clockOf, deliver, frame, keysIn, openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_ROOM, PAGE_TABLE as TABLE, run, send, signAs, switchOn, sync, updatesOf } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, red, testHouse } from './computedTestKit';

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
/** The house a room has when the deed holder's page delegates a key (the migration of a table PR 2-4 opened needs one). */
const HOUSE = testHouse('beside-room-house');
/** A second game the owner opens at the same table once the first has ended, and its end. */
const NAME2 = { ...NAME, j: 'fedcba9876543210' };
const G2 = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME2) };
const root2 = rootOf(G2, 'p', { j: NAME2.j, dl: delegation(owner, house.pub, PAGE_ROOM) });
const end2 = trimOf(G2, 'p', {
  ok: NAME2.ok, j: NAME2.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(G2, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {},
});
/** A craps game the kit's owner opens at the same (roulette) table: a forgery (an honest table plays its own letter), but a state the doc can hold. */
const NAMER = { ...NAME, j: '0123456789abcdef' };
const GR = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('q', PAGE_ROOM, TABLE, NAMER) };
const rootR = rootOf(GR, 'q', { j: NAMER.j, dl: delegation(owner, house.pub, PAGE_ROOM) });

/** A game at ANOTHER table of the room, and its end: a live game there is no game at this table. */
const OTHER_T = 'roulette-2';
const GO = { room: PAGE_ROOM, t: OTHER_T, inc: faironlyInc('p', PAGE_ROOM, OTHER_T, NAME) };
const rootO = rootOf(GO, 'p', { dl: delegation(owner, house.pub, PAGE_ROOM) });
const endO = trimOf(GO, 'p', {
  ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(GO, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {},
});

const seedCtx = (p: Page, r: number) => ({ room: CTX.room, table: seedTable(CTX), round: r, party: p.pid, house: '' });

/** A craps game at the roulette table held by page `p` (a forgery: an honest table plays its own letter): the game the deed holder plays when the room names `p` its owner, whatever its letter (S9). */
function crapsGameHeldBy(p: Page): { inc: string; root: { key: string; value: unknown } } {
  const name = { ...NAME, ok: p.pub, j: 'abcdef0123456789' };
  const ctx = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('q', PAGE_ROOM, TABLE, name) };
  const sign = (bytes: Uint8Array): string => p.keypair.signIdentity(bytes);
  const dl = delegation({ pub: p.pub, sign } as never, house.pub, PAGE_ROOM);
  const body = { v: 1, ok: p.pub, j: name.j, rv: name.rv, ts: name.ts, b: 'g', u: 0, l: NO_CLOSE, n: {}, s: OPENING_CARRY, dl, k: p.pub };
  return { inc: ctx.inc, root: sealCk(ctx, body as never, sign) };
}

/** Page p back in the room on a fresh doc holding `from`'s state, as a rejoin
 *  binds one: what it kept of its tables is of the last binding, its seeds are
 *  kept (the seed store), and the records it finds came to it now. */
function rejoin(p: Page, from: Page, clientID: number, T: number): void {
  const next = new Y.Doc();
  next.clientID = clientID;
  clockOf(p, T);
  Y.applyUpdate(next, Y.encodeStateAsUpdate(from.doc));
  p.casino.bindCasinoDoc(next, PAGE_ROOM);
  p.doc = next;
}
const casinoOf = (p: Page) => p.doc.getMap('casino');
const computedOf = (p: Page) => p.doc.getMap('casinoComputed');

function record(p: Page, rec: { key: string; value: unknown }): void {
  p.doc.transact(() => computedOf(p).set(rec.key, rec.value));
}

function switchTo(p: Page, inc: string): void {
  p.doc.transact(() => casinoOf(p).set(`cfg:computed:${TABLE}`, { v: 1, inc }));
}

/** The switch of table `t` names page-signed incarnation `inc`, whose first session the same write opens
 *  (nothing has ended it): another incarnation the doc holds, taking the switch. */
function takeSwitchTo(p: Page, inc: string, t = TABLE): void {
  p.doc.transact(() => {
    casinoOf(p).set(`cfg:computed:${t}`, { v: 1, inc });
    computedOf(p).set(`ses:${t}:${inc}:g`, new Y.Map());
  });
}

/** Frames of `p` every `step` (STEP) over `ms` from `from`, the room's tables
 *  being `tables` (the page kit's one by default); the time after. */
function tick(p: Page, from: number, ms: number, step = STEP, tables?: string[]): number {
  run([p], from, from + ms, { step, tables });
  return from + ms + step;
}

/** Frames of the pages every `step` over [from, to], each with its own list of the
 *  room's tables (undefined: the page kit's one); the time after. */
function runLists(pages: [Page, string[] | undefined][], from: number, to: number, step = STEP): number {
  for (let T = from; T <= to; T += step) {
    sync(T, ...pages.map(([p]) => p));
    for (const [p, tables] of pages) frame(T, p, tables);
    sync(T, ...pages.map(([p]) => p));
  }
  return to + step;
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
  const takeSwitch = (p: Page): void => takeSwitchTo(p, other);

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

  // A game has two page-signed letters (roulette: `c` and `r`), and a name of either is
  // another incarnation of the table's game: it is the game of the name that counts,
  // not the letter.
  it.each(WHERE)('go when a page-signed incarnation of the game\'s other letter (r…) takes the switch while a game is played, as a c… one does, %s', async (_, tables) => {
    const { a, felt } = await frozen();
    const otherR = 'r' + '5d'.repeat(12);
    record(a, root);
    takeSwitchTo(a, otherR);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    let at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(otherR);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    switchTo(a, G.inc);
    record(a, end);
    at = tick(a, at, 2 * a.table.REPUT_MS, STEP, tables);
    tick(a, at, 3 * a.table.REPUT_MS); // (the table in the room's list, the game over)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: otherR });
  });

  // Any look at the table does it, not only a frame: the card reads the table
  // between two of them, and a state of the incarnation the switch has left must
  // not be there for it to find.
  it('go with their state at the first look at the table after the switch has left them, a frame or the card\'s: the seeds are let go of before the next frame', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is the one played, the switch a hint)
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull(); // (no frame yet, nothing has looked at the table)
    clockOf(a, T0 + STEP);
    a.table.computedCheckpointView(TABLE);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
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
    // (C's first never came: its second is parked. B's write reaches a page that holds part of an update,
    // so what it reads of the switch is one a parked write overwrites: it acts on nothing. Had B's come
    // first, the page would have read the other on a whole doc, as a frame there would have.)
    deliver(T0 + 2, a, [fromC[1]]);
    deliver(T0 + 2, a, [fromB[0]]);
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

  // The page counted the switch leave the incarnation on a whole doc, and then
  // holds part of an update: a parked write may be the switch naming the
  // incarnation again (its writer having heard of nothing else), and seeds let go
  // of meanwhile cannot be had back. The state is replaced when the doc is whole,
  // and only if the switch does not name the incarnation by then.
  it('are kept while the page holds part of an update after it counted the switch leave them: a parked write may bring the switch back to them', async () => {
    const [a, b, c] = await openRoom(['A', 'B', 'C'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b, c);
    const fromB = updatesOf(b, () => {
      b.doc.transact(() => {
        casinoOf(b).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
        computedOf(b).set(`ses:${TABLE}:${other}:g`, new Y.Map());
      });
    });
    const fromC = updatesOf(c, () => { // (C has heard of nothing since: its second write names the incarnation, and wins, C being the higher client)
      c.doc.transact(() => casinoOf(c).set('unrelated', 1));
      c.doc.transact(() => casinoOf(c).set(`cfg:computed:${TABLE}`, { v: 1, inc: INC }));
    });
    deliver(T0 + 2, a, [fromB[0]]);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true); // (counted on a whole doc)
    deliver(T0 + 2, a, [fromC[1]]); // (C's first never came: its second is parked)
    expect(a.casino.casinoWhole()).toBe(false);
    const at = tick(a, T0 + 3, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    deliver(at, a, [fromC[0]]);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC }); // (C's write won)
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false); // (the switch names the incarnation again)
    tick(a, at + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  // The end of the incarnation read on a doc that holds part of an update is no
  // more final than a switch read on it: the seeds go when the doc is whole.
  it('are kept while the page holds part of an update, the end of their incarnation being read on it: the seeds go when the doc is whole', async () => {
    const [a, b, c] = await openRoom(['A', 'B', 'C'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b, c);
    const fromB = updatesOf(b, () => b.doc.transact(() => casinoOf(b).set(`gone:${TABLE}:${INC}`, 1)));
    const fromC = updatesOf(c, () => {
      c.doc.transact(() => casinoOf(c).set('unrelated', 1));
      c.doc.transact(() => casinoOf(c).set('unrelated', 2));
    });
    deliver(T0 + 2, a, [fromC[1]]); // (C's first never came: its second is parked)
    deliver(T0 + 2, a, [fromB[0]]);
    expect(a.casino.casinoWhole()).toBe(false);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true); // (what the doc reads)
    const at = tick(a, T0 + 3, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    deliver(at, a, [fromC[0]]);
    expect(a.casino.casinoWhole()).toBe(true);
    tick(a, at + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  // A doc that holds every update can still have lost a session the page counted of
  // one table (casinoWhole of the table): the switch it reads there is no more final
  // than one read on part of an update, and the seeds stay while the table is lost.
  it('are kept while the table is lost, a session this page counted of it gone from the doc: the seeds go once it is whole again', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    takeSwitch(a);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true); // (counted on a whole doc)
    a.doc.transact(() => computedOf(a).delete(`ses:${TABLE}:${other}:g`));
    expect(a.casino.casinoWhole()).toBe(true); // (the doc holds no part of an update)
    expect(a.casino.casinoWhole(TABLE)).toBe(false); // (the table lost a session this page counted)
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map())); // (the other's session is back)
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    tick(a, at, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  // The compaction duty looks at every table the page keeps a state of, one after
  // another: one that is lost is passed over, and the rest are looked at.
  it('go at a table out of the room when another table of the page, the one it came across first, is lost: that is passed over, not the end of the compaction duty', async () => {
    const TABLE2 = 'roulette-2';
    const INC2 = 'c' + '6b'.repeat(12);
    const other2 = 'c' + '8a'.repeat(12);
    const [a] = await openRoom(['A'], T0);
    switchOn(a, TABLE2, INC2);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE2, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    const felt2 = a.casino.computedFoldOf(TABLE2)!.felts.get(a.pid)!.rec.c;
    const seedCtx2 = { ...seedCtx(a, 1), table: seedTable({ room: PAGE_ROOM, t: TABLE2, inc: INC2 }) };
    expect(a.fair.seedFor(felt2, seedCtx2)).not.toBeNull();
    const at = tick(a, T0 + STEP, 1_000, STEP, [TABLE, TABLE2]); // (the page keeps a state of both, this table\'s first)
    a.doc.transact(() => computedOf(a).delete(`ses:${TABLE}:${INC}:g`)); // (this table lost a session the page counted)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    takeSwitchTo(a, other2, TABLE2); // (…and the other table\'s switch leaves it for another incarnation)
    expect(a.casino.casinoWhole(TABLE2)).toBe(true);
    tick(a, at, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.fair.seedFor(felt2, seedCtx2)).toBeNull();
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  // A name that is no other incarnation takes nothing's place: one nothing opened
  // is put back over (the switch is junk, as a missing one is), and one that had
  // ended when the page counted it names no table. (One that ends after the switch
  // named it is another matter: the page's count had the switch leave the first
  // for it, and the first is over for good, below.)
  const JUNK = 'c' + '6e'.repeat(12);
  it.each([
    ['a page-signed name nothing opened', (p: Page) => switchTo(p, JUNK)],
    ['a page-signed incarnation that ended with the write that named it', (p: Page) => p.doc.transact(() => {
      casinoOf(p).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(p).set(`ses:${TABLE}:${other}:g`, new Y.Map());
      casinoOf(p).set(`gone:${TABLE}:${other}`, 1);
    })],
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

  it.each([['a game is played', true], ['no game is played: the switch carries a name nothing opened', false]] as [string, boolean][])('are kept at a table out of the room too, until the switch leaves them for another page-signed incarnation: then the compaction duty lets go of them, %s', async (_, game) => {
    const { a, felt } = await frozen();
    if (game) record(a, root);
    switchTo(a, G.inc);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    takeSwitch(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(game ? G.inc : other);
    tick(a, at, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
  });

  // The state the page keeps for the incarnation the switch left is the other's
  // from then on, in the room's list or out of it, a slip of this page's on it or
  // none: one left in its place would put the switch back on the incarnation that
  // is over, once the game ends and the table is back.
  it.each([[true], [false]])('go with their state at a table out of the room: the switch leaves them for another page-signed incarnation and names the game again, and when the game ends and the table is back the switch goes to the other one (a slip of this page\'s on them: %s)', async (slip) => {
    const [a] = await openRoom(['A'], T0);
    let felt = '';
    if (slip) {
      expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
      felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    }
    let at = tick(a, T0 + STEP, 800); // (the page runs the incarnation: its state is there)
    record(a, root);
    switchTo(a, G.inc);
    at = tick(a, at, 2 * a.table.REPUT_MS, STEP, []);
    takeSwitch(a);
    at = tick(a, at, 2 * a.table.REPUT_MS, STEP, []);
    if (slip) expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    switchTo(a, G.inc); // (the hint is back, short of the compaction that would make the end final)
    at = tick(a, at, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    record(a, end);
    tick(a, at, 3 * a.table.REPUT_MS); // (the table is back in the room's list)
    expect(a.casino.computedIncEnded(TABLE, G.inc)).toBe(true);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
  });

  // The incarnation the switch left may have ended too: a removal's mark came
  // with the write that moved the switch (the house's off and on), or after it.
  // Its state is replaced by the other's all the same, in the room's list or out
  // of it, the game being played or over: one left in its place would put no
  // state beside the game's end, and the switch would stay on the dead hint.
  it.each(WHERE)('go with their state, and the other incarnation\'s state takes its place, when they ended too, the game ending at a table the page does not list: the switch is put back on the other when the table is back, %s', async (_, tables) => {
    const { a, felt } = await frozen();
    record(a, root);
    switchTo(a, G.inc);
    let at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, tables);
    a.doc.transact(() => {
      casinoOf(a).set(`gone:${TABLE}:${INC}`, 1);
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    switchTo(a, G.inc); // (the hint is back over it: the game is live)
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
    at = tick(a, at, 2 * a.table.REPUT_MS, STEP, tables);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    record(a, end);
    at = tick(a, at, 2 * a.table.REPUT_MS, STEP, tables);
    if (tables) expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc }); // (the dead hint: nobody puts the switch back, the table being out of the list)
    tick(a, at, 3 * a.table.REPUT_MS); // (back in the room's list)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
  });

  // A name that is no other incarnation takes nobody's place, not in the
  // compaction duty either: where the page that ran the incarnation cannot put
  // the switch back yet (its table out of the room's list, or the page not awake
  // since a lapse), the seeds behind its frozen slips stay until it can.
  it.each([['no game is played', false], ['a game is played', true]] as [string, boolean][])('are kept at a table out of the room under a page-signed name nothing opened, %s: the compaction duty alone looks, and a name nothing opened is no incarnation taking their place', async (_, game) => {
    const { a, felt } = await frozen();
    if (game) record(a, root);
    switchTo(a, JUNK);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull();
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, []);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: JUNK }); // (nobody put it back: the table is out of the list)
    tick(a, at, 2 * a.table.REPUT_MS); // (back in the room's list: put back over the name)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  it('are kept by a page waking from a sleep under a page-signed name nothing opened, until it is awake and puts the switch back', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    tick(a, T0 + STEP, 800);
    switchTo(a, JUNK); // (arrived while the page slept)
    const wake = T0 + 11_000;
    const at = tick(a, wake, 2_000); // (the lapse: the page is not awake, nothing is put back yet)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: JUNK });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    tick(a, at, 7_000);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
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

  it.each([['a game is played', true], ['no game is played', false]] as [string, boolean][])('go with the end of the incarnation, %s: the switch left it, and compaction ended it', async (_, game) => {
    const { a, felt } = await frozen();
    if (game) record(a, root);
    takeSwitch(a);
    tick(a, T0 + STEP, 2 * a.table.COMPACT_FALLBACK_MS, 1_000);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(a.casino.computedIncOf(TABLE)).toBe(game ? G.inc : other);
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

  // The incarnation the switch left is over, and a hint that names the game again
  // is no way back to it: its pages have let go of its slips, so holding its stakes
  // would lock chips nobody can settle, for as long as the game lasts.
  it('stay free when the switch names the live game again after another page-signed incarnation took it: the hint is no way back to the one it left, and compaction goes on under it', async () => {
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
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    let at = run([a, b], T0 + 3, T0 + 2 * a.table.REPUT_MS, { step: STEP }); // (the pages see the switch name the other: the first is over)
    switchTo(a, G.inc);
    sync(at, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.isComputedTable(TABLE)).toBe(true); // (the game is live all along)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toEqual([INC]);
    clockOf(a, at);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(1_000);
    // Compaction ends it under the live game, as it ends any the switch left.
    at = run([a, b], at + STEP, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(casinoOf(a).has(`gone:${TABLE}:${INC}`)).toBe(true);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(a.casino.readChips(a.pid)).toBe(0);
    expect(b.casino.readChips(b.pid)).toBe(1_000);
  });

  it('are held again when the switch is put back on them, and a hint after that holds them, the other incarnation being the one the switch left: only the switch naming an incarnation brings it back', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    switchTo(a, INC); // (a peer puts the switch back on the first, before compaction made the end final)
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    switchTo(a, G.inc); // (…and then names the game: the first waits again, the other is the one over)
    sync(T0 + 3, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toEqual([other]);
  });

  // A page that never counted the switch name an incarnation (it was bound with the switch
  // already on another) finds the switch gone from it at its first count of it: nothing
  // will return to it, and a FAIR ONLY name that comes after holds nothing of it.
  it('are over for a page bound with the switch already on another page-signed incarnation: its first count of them finds the switch gone, and a hint that comes after holds nothing of them', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    takeSwitchTo(b, other);
    sync(T0 + 1, a, b);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    rejoin(a, b, 11, T0 + 2); // (A is bound afresh on a doc where the switch is on the other already)
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    clockOf(a, T0 + 3);
    record(a, root);
    switchTo(a, G.inc);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // The switch can go back and forth: naming an incarnation again undoes what leaving it
  // did, and leaving it for the same one a second time does it again.
  it('are left again when the switch goes back to the incarnation it left them for after naming them once more: a hint after that holds nothing of them', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    takeSwitchTo(a, other);
    sync(T0 + 1, a, b);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
    switchTo(a, INC); // (a peer puts the switch back on the first, before compaction made the end final)
    sync(T0 + 2, a, b);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false);
    expect(a.casino.switchLeftFor(TABLE, other)).toBe(INC); // (the other is the one the switch left now)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    switchTo(a, other);
    sync(T0 + 3, a, b);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other); // (left a second time)
    expect(a.casino.switchLeft(TABLE, other)).toBe(false);
    switchTo(a, G.inc);
    sync(T0 + 4, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toEqual([INC]);
  });

  // A FAIR ONLY name in the switch is a hint whichever it is: one nothing opened, while
  // another game is live, holds the stakes of the incarnation the switch named before
  // as any hint does, until the pages put the switch back over it. (No flicker of free
  // chips between.)
  it('stay held when the switch carries a made-up FAIR ONLY name while a game is played: a hint is a hint, the live game it points at or not', async () => {
    const { a, b } = await staked();
    const madeUp = 'p' + '3e'.repeat(12);
    record(a, root);
    switchTo(a, madeUp);
    sync(T0 + 1, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    run([a, b], T0 + 2, T0 + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC }); // (put back over the name)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
  });

  it('stay held when the switch carries a FAIR ONLY name of the other game\'s letter (q…): a hint is a hint, the game it is of or not', async () => {
    const { a, b } = await staked();
    const craps = 'q' + '3e'.repeat(12);
    switchTo(a, craps);
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    run([a, b], T0 + 2, T0 + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
  });

  // The order the writes reach a page in: the switch names the other incarnation
  // before the page holds a record of it, the record comes, and then the switch
  // names the live game. The page counted the first incarnation when the switch
  // came, and that count knew no record of the name: it counts again when the
  // name becomes one it holds, and is told then that the switch has left the first
  // for it. That is the page's reading, and the frames that follow go by it: the
  // first one lets go of the seeds and puts the other's state in their place,
  // even when the switch names the game by then and no frame saw the other named.
  it.each([
    ['a frame between the record and the hint', true],
    ['no frame between the record and the hint: the first frame finds the game\'s name in the switch', false],
  ] as [string, boolean][])('are over for a page when the other incarnation\'s first record reaches it after the switch that names it, and the switch then names the live game: %s', async (_, frameBetween) => {
    const other = 'c' + '5d'.repeat(12);
    const [a, b, c] = await openRoom(['A', 'B', 'C'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b, c);
    expect(a.casino.readChips(a.pid)).toBe(991);
    // C writes the other incarnation's first session; B, that doesn't hold it, names it in the switch, then names the game again.
    const session = updatesOf(c, () => c.doc.transact(() => computedOf(c).set(`ses:${TABLE}:${other}:g`, new Y.Map())));
    const named = updatesOf(b, () => switchTo(b, other));
    const hint = updatesOf(b, () => switchTo(b, G.inc));
    expect([session.length, named.length, hint.length]).toEqual([1, 1, 1]);
    deliver(T0 + 2, a, named);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull(); // (a name of which nothing came: it is nobody's place yet)
    expect(a.casino.switchLeftFor(TABLE, INC)).toBeNull();
    expect(a.casino.readChips(a.pid)).toBe(1_000); // (the switch names another: the doc frees the stakes, as ever)
    deliver(T0 + 3, a, session); // (no frame before: the page would put the switch back over a name nothing opened)
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(other);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
    let at = T0 + 4;
    if (frameBetween) {
      at = tick(a, at, 2 * a.table.REPUT_MS);
      expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull(); // (the page saw the switch name it: the first is over)
    }
    deliver(at, a, hint);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.readChips(a.pid)).toBe(1_000); // (the hint is no way back to the first)
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toEqual([INC]);
    at = tick(a, at + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull(); // (over, whether or not a frame saw the other named)
    // The game ends: the switch is put back on the other incarnation, never on the first.
    record(a, end);
    at = tick(a, at, 2 * a.table.REPUT_MS);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    // …and compaction ends the first.
    run([a], at, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
  });

  // The same order through three incarnations: the switch names the second before the
  // page holds a record of it, the record comes, the switch names a third likewise, and
  // then the game. The first is left for the last the switch named, never the second
  // (which the switch left too): its state is replaced by that one's, and the switch is
  // put back on it when the game ends.
  it('are left for the last of three incarnations the switch named, each before the page held a record of it', async () => {
    const other = 'c' + '5d'.repeat(12);
    const third = 'c' + '7c'.repeat(12);
    const [a, b, c] = await openRoom(['A', 'B', 'C'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b, c);
    const sessions = [other, third].map((inc) => updatesOf(c, () => c.doc.transact(() => computedOf(c).set(`ses:${TABLE}:${inc}:g`, new Y.Map()))));
    const named = [other, third, G.inc].map((inc) => updatesOf(b, () => switchTo(b, inc)));
    deliver(T0 + 2, a, named[0]); // (a name of which nothing came)
    deliver(T0 + 3, a, sessions[0]);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
    deliver(T0 + 4, a, named[1]);
    deliver(T0 + 5, a, sessions[1]);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(third);
    expect(a.casino.switchLeftFor(TABLE, other)).toBe(third);
    deliver(T0 + 6, a, named[2]);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    let at = tick(a, T0 + 7, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    record(a, end);
    at = tick(a, at, 2 * a.table.REPUT_MS);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: third });
    expect(a.casino.computedIncOf(TABLE)).toBe(third);
  });

  // The same order through the other way an incarnation becomes one the page holds:
  // the first record of the other that reaches the page is a checkpoint of the
  // owner's house (`hs:`), which the page registers the incarnation by, before any
  // session of it. That is the page's first count of the name, as a session's is.
  it('are over for a page when the other incarnation\'s first record is an owner\'s checkpoint of it (hs:), coming after the switch that names it: the session that follows and the hint find the first left', async () => {
    const other = 'c' + '5d'.repeat(12);
    const [a, b] = await openRoom(['A', 'B'], T0);
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid));
    sync(T0, a, b);
    clockOf(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    clockOf(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [black(9)], T0)).toBe('ok');
    sync(T0, a, b);
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    expect(a.casino.readChips(a.pid)).toBe(991);
    switchTo(a, other); // (a name nothing of which the page holds)
    expect(a.casino.switchLeftFor(TABLE, INC)).toBeNull();
    const hsum = signAs(a, 'hsum', { v: 1, b: 'g', u: 1, l: 'a'.repeat(32), n: { p: '10' }, a: 0 }, { ...CTX, inc: other });
    record(a, { key: `hs:${TABLE}:${other}`, value: hsum });
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(other); // (registered by it: the page holds the name)
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other); // (the page counts the first again, and is told the switch has left it)
    record(a, { key: `ses:${TABLE}:${other}:g`, value: new Y.Map() });
    switchTo(a, G.inc); // (the hint)
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    expect(a.casino.readChips(a.pid)).toBe(1_000); // (the hint is no way back to the first)
    const at = tick(a, T0 + 4, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
    // …and compaction, which a hint exempts an incarnation the switch has not left from, ends the first once the wait is over.
    run([a], at, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
  });

  // The same, the owner's checkpoint being counted later than it arrives: its check waits for
  // the verify budget, and the slice that checks it is the page's first count of the name.
  it('are over for a page when the other incarnation\'s first record is an owner\'s checkpoint (hs:) whose check waits for the verify budget, after the switch that names it: the slice that counts it tells the first the switch has left it', async () => {
    const other = 'c' + '5d'.repeat(12);
    const [a, b] = await openRoom(['A', 'B'], T0);
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid));
    sync(T0, a, b);
    clockOf(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    clockOf(b, T0);
    expect(b.table.writeComputedSlip(TABLE, [black(9)], T0)).toBe('ok');
    sync(T0, a, b);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    expect(a.casino.readChips(a.pid)).toBe(991);
    switchTo(a, other);
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 }); // (no time to check anything)
    const hsum = signAs(a, 'hsum', { v: 1, b: 'g', u: 1, l: 'a'.repeat(32), n: { p: '10' }, a: 0 }, { ...CTX, inc: other });
    record(a, { key: `hs:${TABLE}:${other}`, value: hsum });
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull(); // (the check waits: nothing counts the name yet)
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await new Promise((resolve) => setTimeout(resolve, 5)); // (the slice)
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(other);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other); // (the page counts the first again, and is told the switch has left it)
    switchTo(a, G.inc); // (the hint)
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    expect(a.casino.readChips(a.pid)).toBe(1_000);
  });

  // A page counts the table's others again when it counts an incarnation for the first
  // time only if the switch names that one: a peer's flood of made-up names, each a
  // first sighting, costs a count a name. Counted by the fold's results (one a count).
  it('count a made-up name once when the page tracks it, not every incarnation of the table again: a flood of first-seen names costs a count or two a name', async () => {
    const [a] = await openRoom(['A'], T0);
    clockOf(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const spy = vi.spyOn(a.fold.TableFold.prototype, 'result');
    const names = 60;
    for (let i = 0; i < names; i++) {
      a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:c${(i + 1).toString(16).padStart(24, '0')}:g`, new Y.Map()));
    }
    // (One count a name; with a recount of the table's incarnations for each name, N(N+1)/2 = 1,830 here.)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4 * names);
  });

  // The incarnation the switch left is over for good: when the one it left it for
  // ends, nothing takes its place, and nothing may bring it back either (the pages
  // that ran it have let go of the seeds behind its slips, and its stakes would be
  // locked, then forfeit, were the switch put back on it). The hint holds neither,
  // no page keeps a state to put the switch back with, and compaction ends it.
  it('stay over when the incarnation the switch left them for ends: the seeds go, the hint that follows is no way back, and compaction ends them', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
    record(a, root);
    switchTo(a, G.inc);
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    sync(T0 + 1, a, b);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    // The other ends (a removal marks it) before a frame of the pages saw it named, and the switch names the game.
    a.doc.transact(() => casinoOf(a).set(`gone:${TABLE}:${other}`, 1));
    switchTo(a, G.inc);
    sync(T0 + 2, a, b);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBeNull(); // (it took nobody's place: it ended)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    let at = run([a, b], T0 + 3, T0 + 3 + 2 * a.table.REPUT_MS, { step: STEP });
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull(); // (over: nothing of it will settle)
    // The game ends before compaction does: no page has a state of the first to put the switch back with.
    record(a, end);
    sync(at, a, b);
    at = run([a, b], at + STEP, at + 2 * a.table.REPUT_MS, { step: STEP });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).not.toEqual({ v: 1, inc: INC });
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000); // (held again, they would be locked)
    at = run([a, b], at, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  // The page that ran an incarnation puts the switch back on it when a peer has
  // taken it away, and the page's own count says when the switch has left it for
  // another: that reading goes for the put-back too. What reaches the page between
  // the count and its next frame (a hint at a name nothing opened, a delete of the
  // switch, the end of the incarnation the switch left this one for) must not bring
  // the incarnation back: its stakes are free by then, and held again they would be
  // locked for chips already spent.
  it.each([
    ['a hint at a name nothing opened (no record of the game)', (p: Page) => switchTo(p, G.inc)],
    ['a delete of the switch (a peer\'s doing, or junk handling)', (p: Page) => p.doc.transact(() => casinoOf(p).delete(`cfg:computed:${TABLE}`))],
  ] as [string, (p: Page) => void][])('are not put back by their page when its count has the switch leave them for another: %s, written before the next frame, brings the other incarnation back as the switch\'s, and the stakes stay free', async (_, write) => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    let at = run([a, b], T0 + STEP, T0 + 2_000, { step: STEP }); // (the pages run the first)
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    sync(at, a, b);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    write(a);
    sync(at + 1, a, b);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other); // (what the switch says now is no way back)
    // The first frame after: nothing is put back on the first.
    at = run([a, b], at + 2, at + 2, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).not.toEqual({ v: 1, inc: INC });
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    // …and the pages go on with the other: its state replaces the first's, and the switch goes to it.
    run([a, b], at, at + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    clockOf(a, at + 2 * a.table.REPUT_MS);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(1_000);
  });

  // The page that wrote no slip on the first holds a state of it all the same (it plays
  // the table), and its count has the switch leave it as any page's does: it puts the
  // switch back on no incarnation that is over.
  it('are not put back by a page that wrote no slip on them either: it holds a state of them all the same, and its count has the switch leave them for another', async () => {
    const [a, c] = await openRoom(['A', 'C'], T0);
    const other = 'c' + '5d'.repeat(12);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    sync(T0, a, c);
    const at = run([c], T0 + STEP, T0 + 2_000, { step: STEP }); // (C runs the first, a slip of its own none)
    takeSwitchTo(a, other);
    sync(at, a, c);
    expect(c.casino.switchLeftFor(TABLE, INC)).toBe(other);
    switchTo(a, G.inc); // (a hint at a name nothing opened, before C's next frame)
    sync(at + 1, a, c);
    run([c], at + 2, at + 2, { step: STEP });
    expect(casinoOf(c).get(`cfg:computed:${TABLE}`)).not.toEqual({ v: 1, inc: INC });
    run([c], at + 3, at + 2 * c.table.REPUT_MS, { step: STEP });
    expect(casinoOf(c).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
  });

  // The switch can leave the first for one incarnation and that one for a third,
  // before the game ends: what the page puts in the first's place, and the switch
  // back on once the game is over, is the last it named, never the first.
  it('are replaced by the last incarnation the switch named when it named two before the game ended: the switch is put back on that one', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    const third = 'c' + '7c'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    for (const next of [other, third]) {
      a.doc.transact(() => {
        casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: next });
        computedOf(a).set(`ses:${TABLE}:${next}:g`, new Y.Map());
      });
      sync(T0 + 2, a, b); // (each reaches the pages on its own)
    }
    switchTo(a, G.inc); // (…and the hint at the game after them)
    sync(T0 + 2, a, b);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(third);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    const at = run([a, b], T0 + 3, T0 + 2 * a.table.REPUT_MS, { step: STEP });
    record(a, end);
    sync(at, a, b);
    run([a, b], at + STEP, at + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: third });
    expect(a.casino.computedIncOf(TABLE)).toBe(third);
  });

  it('are not put back by their page when the incarnation the switch left them for ends before its next frame: the switch stays on the ended name, the stakes stay free, and compaction ends them', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    let at = run([a, b], T0 + STEP, T0 + 2_000, { step: STEP });
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
    });
    sync(at, a, b);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
    a.doc.transact(() => casinoOf(a).set(`gone:${TABLE}:${other}`, 1)); // (a removal ends it)
    sync(at + 1, a, b);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    expect(a.casino.switchLeftFor(TABLE, INC)).toBeNull(); // (it took nobody's place: it ended)
    at = run([a, b], at + 2, at + 2 * a.table.REPUT_MS, { step: STEP });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other }); // (never put back on the first)
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    run([a, b], at, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  // A tracked name of the table's other game is no incarnation this table can play and no
  // successor of the one its page ran: a peer's doing, or a forgery. That incarnation waits
  // under it as it waits under a hint, its players being mid-round: the stakes of its felts
  // stay held (the chips a round still rests on are not there to cash out), its seeds and
  // its state are kept, and compaction leaves it be however long the name stands, which is
  // as long as the room takes to clear it (awayDuty). Cleared, the pages that ran the
  // incarnation put the switch back on it; at a table out of the room's list no page does,
  // and compaction ends the abandoned incarnation then, void.
  it.each([
    ['at a table in the room', undefined],
    ['at a table out of the room: the compaction duty alone looks', []],
  ] as [string, string[] | undefined][])('wait under a tracked incarnation of the table\'s other game while a game is played, stakes held and seeds kept and not compacted past the compaction wait, until the room clears the name, %s', async (_, tables) => {
    const { a, b } = await staked();
    const felts = [a, b].map((p) => p.casino.computedFoldOf(TABLE)!.felts.get(p.pid)!.rec.c);
    const craps = 'k' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, craps);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is still the one played)
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(craps);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false); // (the other game's name is nobody's successor)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    clockOf(a, T0 + 3);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(991); // (what is not staked, no more)
    // Past the compaction wait (and the stagger of a page after the first), the name still in the switch.
    const mid = run([a, b], T0 + 4, T0 + 4 + 3 * a.table.COMPACT_MS, { step: 1_000, tables });
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(craps);
    [a, b].forEach((p, i) => expect(p.fair.seedFor(felts[i], seedCtx(p, 1))).not.toBeNull());
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect([a, b].map((p) => p.casino.readChips(p.pid))).toEqual([0, 991]);
    // The room clears the name a minute on.
    run([a, b], mid + 1_000, mid + 2 * a.table.AWAY_MS, { step: 1_000, tables });
    expect(a.casino.computedIncEnded(TABLE, craps)).toBe(true);
    if (tables === undefined) {
      expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC }); // (put back on their own)
      expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
      expect([a, b].map((p) => p.casino.readChips(p.pid))).toEqual([0, 991]);
      [a, b].forEach((p, i) => expect(p.fair.seedFor(felts[i], seedCtx(p, 1))).not.toBeNull());
    } else {
      expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true); // (abandoned: nobody puts the switch back)
      expect([a, b].map((p) => p.casino.readChips(p.pid))).toEqual([9, 1_000]); // (void: nobody charged; A has cashed out what was free)
    }
  });

  // The write that ends the name is the one that puts the switch back, in the room's list: a
  // look at the doc between the two would find the switch bare and the stakes free, and a
  // cash-out in that frame would take chips a round that resumes rests on. Out of the list no
  // page names it back, though each holds a state of the incarnation (it ran the table before
  // the game opened): a removed table is ended, and this page runs it no more.
  it.each([
    ['at a table in the room', undefined],
    ['at a table out of the room: no page names it back, though each holds a state of the incarnation', []],
  ] as [string, string[] | undefined][])('stay held through the room clearing the name of the table\'s other game: the write that ends it names them again, so no look between the two finds the switch bare and their stakes free, %s', async (_, tables) => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    run([a, b], T0, T0, { step: STEP }); // (a frame at the table in the room's list before the game opens: each page holds a state of the incarnation)
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, craps);
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    let cleared = -1;
    for (let T = T0 + 3; T < T0 + 3 + 3 * a.table.AWAY_MS && cleared < 0; T += 500) {
      run([a, b], T, T, { step: STEP, tables });
      if (casinoOf(a).has(`gone:${TABLE}:${craps}`)) cleared = T;
    }
    expect(cleared).toBeGreaterThan(0);
    // (The clear is on both pages, and neither has had a frame since.)
    if (tables === undefined) {
      expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
      for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
      clockOf(a, cleared);
      expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(991);
      expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    } else {
      expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    }
  });

  // An incarnation of the table's other game waits for nothing: the table cannot play it, so
  // the name of the table's own game that a peer wrote after it holds none of its stakes, and
  // compaction ends it after its wait, as with no game. Whether the switch ever named it or
  // not: any guest can write the key of a session of it.
  it.each([
    ['that the switch has left for theirs', true],
    ['that the switch never named, a stray session', false],
  ] as [string, boolean][])('hold nothing of an incarnation of the table\'s other game %s beside a live game: it is listed and compacted after its wait, and theirs stay held', async (_, named) => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    if (named) {
      takeSwitchTo(a, craps); // (a peer opens the craps incarnation and takes the switch to it...)
      sync(T0 + 2, a, b);
    } else {
      a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:${craps}:g`, new Y.Map())); // (...or only writes a session of it)
    }
    switchTo(a, INC); // (...and writes the switch back to the table's own)
    sync(T0 + 3, a, b);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(craps);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    run([a, b], T0 + 4, T0 + 4 + 3 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, craps)).toBe(true);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
  });

  // What a name of the other game holds follows the games live at the table by their letter,
  // not the game played: a roulette game opening or ending beside a craps game that is played
  // (S9 plays the deed holder's, whatever its letter) moves what the incarnation's stakes wait
  // under, and the page that lived the history must count what a page bound afresh on the doc
  // counts.
  it('follow a game of their own letter opening and ending beside a craps game the deed holder plays: the stakes held under a name of the other game are counted again, as a page bound afresh counts them', async () => {
    const { a, b } = await staked();
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid)); // (A holds the deed)
    sync(T0, a, b);
    const Q = crapsGameHeldBy(a);
    const craps = 'k' + '3f'.repeat(12);
    record(a, Q.root);
    takeSwitchTo(a, craps);
    sync(T0 + 1, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(Q.inc); // (the deed holder's game is played)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000); // (no roulette game is live: the craps name holds nothing)
    const moves = a.casino.computedGameMovesOf(TABLE);
    record(a, root); // (the roulette game opens beside it)
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(Q.inc); // (still the craps game played)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    rejoin(b, a, 777, T0 + 3); // (a page bound afresh on the doc counts the same)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    record(a, end); // (...and ends)
    sync(T0 + 4, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(Q.inc);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    rejoin(b, a, 778, T0 + 5);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedGameMovesOf(TABLE)).toBe(moves); // (the game played did not move)
  });

  // The live letters are what moved, not their number: the roulette game ends in the write in
  // which a second craps game opens (two live games before, two after), the deed holder's
  // craps game played all along, and the stakes held under the name of the other game are free.
  it('follow the live letters and not their number: the roulette game ending in the write in which a second craps game opens frees the stakes held under a name of the other game', async () => {
    const { a, b } = await staked();
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid)); // (A holds the deed)
    sync(T0, a, b);
    const Q = crapsGameHeldBy(a);
    const craps = 'k' + '3f'.repeat(12);
    record(a, Q.root);
    takeSwitchTo(a, craps);
    record(a, root); // (the roulette game opens beside the deed holder's craps game)
    sync(T0 + 1, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(Q.inc);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    a.doc.transact(() => { // (one write: the roulette game ends, a second craps game opens)
      computedOf(a).set(end.key, end.value);
      computedOf(a).set(rootR.key, rootR.value);
    });
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(Q.inc); // (the deed holder's craps game is played all along)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    rejoin(b, a, 779, T0 + 3); // (a page bound afresh counts the same)
    expect(b.casino.readChips(b.pid)).toBe(1_000);
  });

  // The game can end while the name stands. No game is live then, so the name is the lost
  // switch that main reads it as: the stakes are free, and compaction ends the incarnation
  // after its wait (the room's clearing of the name, which the pages' put-back answers, comes
  // a minute on, and the incarnation is ended by then).
  it('are freed when the game ends under a tracked incarnation of the table\'s other game: no game is played then, the name is a lost switch, and compaction ends them', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, craps);
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991); // (the game is live: held)
    record(a, end);
    sync(T0 + 3, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(craps); // (no game is played now: the switch's name is)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000); // (free)
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    run([a, b], T0 + 4, T0 + 4 + 3 * a.table.COMPACT_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  // With no game at the table at all, a tracked name of the other game is main's lost
  // switch and nothing else (the same name beside a live game is the 'wait under' test
  // above): the stakes are free, and compaction ends the incarnation after its wait.
  it('are freed under a tracked incarnation of the table\'s other game when no game is played, as on main: compaction ends them after its wait', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    takeSwitchTo(a, craps);
    sync(T0 + 1, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(craps);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    run([a, b], T0 + 2, T0 + 2 + 3 * a.table.COMPACT_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  // ...and a name that goes before the wait is out (a peer's switch written over and then
  // deleted: computedRobotPages) leaves the incarnation to be played again: the page puts the
  // switch back on it, and its stakes are held again.
  it('are held again under no game when the tracked incarnation of the table\'s other game goes within seconds: the page puts the switch back on them', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    takeSwitchTo(a, craps);
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    const mid = run([a, b], T0 + 2, T0 + 4_000, { step: 500 });
    a.doc.transact(() => casinoOf(a).delete(`cfg:computed:${TABLE}`));
    run([a, b], mid, mid + 4_000, { step: 500 });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
  });

  // What the name does to the stakes follows the game: free while none is live (above),
  // held when one opens, free again when it ends. Each is a count of the table's others
  // that no record of theirs brought.
  it('follow the game under a tracked incarnation of the table\'s other game: free with none live, held when one opens, free when it ends', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    takeSwitchTo(a, craps);
    sync(T0 + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    record(a, root);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    record(a, end);
    sync(T0 + 3, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // The stakes follow the name too: held under a tracked incarnation of the other game
  // beside a live game, free under one that has ended (a lost switch, put back at once),
  // held again when the mark is deleted, free again when it is written, and held again when
  // it is deleted again (each flip is recorded as it is: the count after the third is not a
  // repeat of the first). Each is a count of the table's others that no record of theirs brought.
  it('follow the other game\'s name as it qualifies beside a live game: held when its removal\'s mark is deleted, free when it is written, held when it is deleted again', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => { // (a name the doc holds, ended already)
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: craps });
      computedOf(a).set(`ses:${TABLE}:${craps}:g`, new Y.Map());
      casinoOf(a).set(`gone:${TABLE}:${craps}`, 1);
    });
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000); // (a lost switch: free until the pages put it back)
    a.doc.transact(() => casinoOf(a).delete(`gone:${TABLE}:${craps}`));
    sync(T0 + 3, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    a.doc.transact(() => casinoOf(a).set(`gone:${TABLE}:${craps}`, 1));
    sync(T0 + 4, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    a.doc.transact(() => casinoOf(a).delete(`gone:${TABLE}:${craps}`));
    sync(T0 + 5, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
  });

  // The same by an end checkpoint (a sum: record that carries e:1) and not a mark: the name
  // is ended by one, revived by one that does not end it, ended by one again, and the stakes
  // are free, held and free; a page bound afresh on a doc that holds the name ended by a
  // checkpoint reads the revival against that, and one bound on the doc that holds it alive
  // reads the end.
  it('follow the other game\'s name as an end checkpoint ends it and revives it beside a live game: free, held, free', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    const sum = (e: boolean) => signAs(a, 'sum', { v: 1, b: 'g', u: 1, l: hex('e', 32), n: {}, ...(e ? { e: 1 as const } : { s: { p: 0, w: {} } }) }, { room: PAGE_ROOM, t: TABLE, inc: craps });
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: craps });
      computedOf(a).set(`ses:${TABLE}:${craps}:g`, new Y.Map());
      computedOf(a).set(`sum:${TABLE}:${craps}`, sum(true));
    });
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncEnded(TABLE, craps)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    record(a, { key: `sum:${TABLE}:${craps}`, value: sum(false) });
    sync(T0 + 3, a, b);
    expect(a.casino.computedIncEnded(TABLE, craps)).toBe(false);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    record(a, { key: `sum:${TABLE}:${craps}`, value: sum(true) });
    sync(T0 + 4, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  it('follow the other game\'s name for a page bound with it ended by an end checkpoint in the doc already: the revival holds the stakes, and the end of a name bound alive frees them', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    const sum = (e: boolean) => signAs(a, 'sum', { v: 1, b: 'g', u: 1, l: hex('e', 32), n: {}, ...(e ? { e: 1 as const } : { s: { p: 0, w: {} } }) }, { room: PAGE_ROOM, t: TABLE, inc: craps });
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: craps });
      computedOf(a).set(`ses:${TABLE}:${craps}:g`, new Y.Map());
      computedOf(a).set(`sum:${TABLE}:${craps}`, sum(true));
    });
    sync(T0 + 2, a, b);
    rejoin(b, a, 12, T0 + 3); // (B is bound afresh on a doc that holds the name ended by a checkpoint)
    expect(b.casino.readChips(b.pid)).toBe(1_000);
    record(a, { key: `sum:${TABLE}:${craps}`, value: sum(false) });
    sync(T0 + 4, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    rejoin(b, a, 13, T0 + 5); // (and again, on a doc that holds it alive)
    expect(b.casino.readChips(b.pid)).toBe(991);
    record(a, { key: `sum:${TABLE}:${craps}`, value: sum(true) });
    sync(T0 + 6, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  // The recount when a game opens or ends reaches EVERY page-signed incarnation of the
  // table, not only the first the page tracked: the switch moved to a second incarnation of
  // the table's game before a name of the other game came, and the stakes sit on the second.
  it('follow the game opening and ending for the second page-signed incarnation of the table, too: the stakes sit on the one the switch moved to', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const second = 'c' + '5d'.repeat(12);
    const craps = 'k' + '3f'.repeat(12);
    takeSwitchTo(a, second); // (the switch moves to the second incarnation of the table's game; the first is over)
    sync(T0 + 1, a, b);
    const at = run([a, b], T0 + 2, T0 + 2_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(second);
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    clockOf(b, at);
    expect(b.table.writeComputedSlip(TABLE, [black(9)], at)).toBe('ok');
    sync(at, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991); // (stakes on the second)
    takeSwitchTo(a, craps); // (a name of the other game, tracked; no game live yet: a lost switch)
    sync(at + 1, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    record(a, root); // (a game opens)
    sync(at + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991); // (held: the second waits under the name)
    record(a, end); // (the game ends)
    sync(at + 3, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
  });

  // A live game at ANOTHER table of the room is no game at this one: a name of the other game
  // in this table's switch is main's lost switch here (the stakes free, the incarnation listed),
  // whatever is played elsewhere, and the game's opening and ending there move nothing here.
  it('stay free under a tracked incarnation of the table\'s other game when the game that is live is at another table of the room: it is no game here', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    record(a, rootO); // (a live game at roulette-2)
    takeSwitchTo(a, craps);
    sync(T0 + 1, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(craps); // (no game here: the switch's name is played)
    expect(a.casino.computedIncOf(OTHER_T)).toBe(GO.inc);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    record(a, endO); // (and its end moves nothing here)
    sync(T0 + 2, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // A page bound afresh finds the name in the doc already, ended or not, and reads the turns
  // that follow against that: the mark deleted holds the stakes if the name was ended when the
  // page was bound, and the mark written frees them if it was not.
  it('follow the other game\'s name for a page bound with it in the doc already, ended or not: the stakes are held when its removal\'s mark is deleted, and free when it is written again', async () => {
    const { a, b } = await staked();
    const craps = 'k' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => { // (a name the doc holds, ended already)
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: craps });
      computedOf(a).set(`ses:${TABLE}:${craps}:g`, new Y.Map());
      casinoOf(a).set(`gone:${TABLE}:${craps}`, 1);
    });
    sync(T0 + 2, a, b);
    rejoin(b, a, 12, T0 + 3); // (B is bound afresh on a doc that holds the ended name)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    a.doc.transact(() => casinoOf(a).delete(`gone:${TABLE}:${craps}`));
    sync(T0 + 4, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(991);
    rejoin(b, a, 13, T0 + 5); // (and again, on a doc that holds the name alive)
    expect(b.casino.readChips(b.pid)).toBe(991);
    a.doc.transact(() => casinoOf(a).set(`gone:${TABLE}:${craps}`, 1));
    sync(T0 + 6, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(b.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // The incarnation the switch left is over for good, and a tracked name of the other game
  // that comes after is no way back to it either (as a hint is none): its pages have let go of
  // the seeds behind its slips, and holding its stakes would lock chips nobody can settle.
  it('stay free when the switch names a tracked incarnation of the table\'s other game after another page-signed incarnation of their game took it, beside a live game: it is no way back to the one it left, and compaction ends it', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    const craps = 'k' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, other);
    sync(T0 + 2, a, b);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    const at = run([a, b], T0 + 3, T0 + 2 * a.table.REPUT_MS, { step: STEP });
    takeSwitchTo(a, craps);
    sync(at, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(craps);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    run([a, b], at + STEP, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000 });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
  });

  // The table's others are counted again when the incarnation the switch names turns (comes
  // to take a place, or ceases to: the specs around this one make it turn), not at each of
  // its records: a busy named incarnation among a flood of made-up names costs a count or two
  // a record, not a count of every name.
  it.each([['unended', false], ['ended', true]] as [string, boolean][])('do not count the table\'s others again at each record of the %s incarnation the switch names: a flood of names and a busy named incarnation cost a count or two a record', async (_, ended) => {
    const [a] = await openRoom(['A'], T0);
    clockOf(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const names = 40;
    const name = (i: number): string => `c${(i + 1).toString(16).padStart(24, '0')}`;
    for (let i = 0; i < names; i++) {
      a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:${name(i)}:g`, new Y.Map()));
    }
    a.doc.transact(() => {
      if (ended) casinoOf(a).set(`gone:${TABLE}:${name(0)}`, 1); // (an ended incarnation takes no place: its records turn nothing)
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: name(0) });
    });
    const spy = vi.spyOn(a.fold.TableFold.prototype, 'result');
    const records = 20;
    for (let k = 0; k < records; k++) {
      a.doc.transact(() => (computedOf(a).get(`ses:${TABLE}:${name(0)}:g`) as Y.Map<unknown>).set(`junk${k}`, k));
    }
    // (A record of the named incarnation counts it; with a count of the other forty for each, 800.)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4 * records);
  });

  // The count of the game's moves (computedGameMovesOf) is of a table's game opening, ending
  // or moving to another, not of the switch moving between page-signed incarnations while a
  // dead game is tracked at the table.
  it('count no move of the table\'s game when the switch moves from one page-signed incarnation to another, a game that ended being tracked at the table', async () => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    record(a, root);
    sync(T0 + 1, a, b);
    expect(a.casino.computedGameMovesOf(TABLE)).toBe(0); // (the first look at the table moves nothing)
    record(a, end);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    const moves = a.casino.computedGameMovesOf(TABLE);
    expect(moves).toBe(1); // (the game ended: one move)
    takeSwitchTo(a, other);
    sync(T0 + 3, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    expect(a.casino.computedGameMovesOf(TABLE)).toBe(moves); // (a page-signed incarnation taking the switch moves no game)
    expect(b.casino.computedGameMovesOf(TABLE)).toBe(moves);
  });

  // The recount when a game opens or ends (and when a game of the other letter does) is due
  // at that move, not at each record of a game that stays live: a flood of names tracked at
  // the table costs a count or two a record of the game, not a count of every name.
  it('do not count the table\'s others again at each record of a game that stays live: a flood of names costs a count or two a record', async () => {
    const [a] = await openRoom(['A'], T0);
    clockOf(a, T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const names = 40;
    const name = (i: number): string => `c${(i + 2).toString(16).padStart(24, '0')}`;
    for (let i = 0; i < names; i++) {
      a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:${name(i)}:g`, new Y.Map()));
    }
    record(a, root); // (the game opens: the table's others are counted again, once)
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    const spy = vi.spyOn(a.fold.TableFold.prototype, 'result');
    const records = 20;
    for (let k = 0; k < records; k++) record(a, trimOf(G, 'p', { u: 4 + k }));
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    // (A record of the game counts it; with a count of the other forty for each, 800.)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4 * records);
  });

  // The names a page tracked are looked at once, at the transaction that follows: a plain
  // write of the casino map, 20 of them, costs nothing for the sixty names tracked before.
  it('look at a name tracked once and not again: later transactions cost nothing for the names a page tracked before', async () => {
    const calls = async (names: number): Promise<number> => {
      const [a] = await openRoom(['A'], T0);
      const name = (i: number): string => `c${(i + 1).toString(16).padStart(24, '0')}`;
      for (let i = 0; i < names; i++) {
        a.doc.transact(() => computedOf(a).set(`ses:${TABLE}:${name(i)}:g`, new Y.Map()));
      }
      const spy = vi.spyOn(Y.Map.prototype, 'has');
      for (let k = 0; k < 20; k++) a.doc.transact(() => casinoOf(a).set(`junk:${k}`, k));
      const n = spy.mock.calls.length;
      spy.mockRestore();
      return n;
    };
    const few = await calls(1);
    const many = await calls(60);
    expect(many).toBeLessThanOrEqual(few + 2 * 20);
  });

  // A name nothing of which the doc holds takes nobody's place, whichever game it is
  // of: the seeds and the state are kept, and the page puts the switch back on its own
  // incarnation. It is a lost switch, so the stakes are free until it is (a name the
  // doc holds, beside a live game, is the 'wait under' test above).
  it.each([
    ['k', 'k' + '3f'.repeat(12)],
    ['c', 'c' + '3f'.repeat(12)],
  ] as [string, string][])('keep their state and their seeds when the switch names an incarnation (%s…) nothing of which the doc holds: the stakes are free and the incarnation listed until the switch is put back on their own', async (_, name) => {
    const { a, felt } = await frozen();
    record(a, root);
    expect(a.casino.readChips(a.pid)).toBe(991);
    switchTo(a, name);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull();
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.readChips(a.pid)).toBe(991);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    tick(a, at, 2 * a.table.COMPACT_FALLBACK_MS);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });

  // The incarnation the switch names can come to take places after the switch named it
  // and the page counted the first, and not by being counted for the first time (the
  // order tests above): by no longer being ended. Its removal's mark deleted, or its end
  // checkpoint written over by one that does not end it, and the page counts the table's
  // others again then: the first is left for it, as if it had been alive all along, or the
  // hint that follows holds the stakes of an incarnation whose seeds other pages let go of.
  it.each([
    ['its removal\'s mark (gone:) is deleted', 'mark'],
    ['its end checkpoint (sum: with e: 1) is written over by one that does not end it', 'checkpoint'],
  ] as [string, 'mark' | 'checkpoint'][])('are over when the incarnation the switch names, ended when it was named, is revived: %s; the hint that follows holds nothing of them', async (_, how) => {
    const { a, b } = await staked();
    const other = 'c' + '5d'.repeat(12);
    const sum = (e: boolean) => signAs(a, 'sum', { v: 1, b: 'g', u: 1, l: hex('e', 32), n: {}, ...(e ? { e: 1 as const } : {}) }, { room: PAGE_ROOM, t: TABLE, inc: other });
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => { // (the switch names another incarnation the doc holds, ended already)
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
      if (how === 'mark') casinoOf(a).set(`gone:${TABLE}:${other}`, 1);
      else computedOf(a).set(`sum:${TABLE}:${other}`, sum(true));
    });
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncEnded(TABLE, other)).toBe(true);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false); // (an ended name takes nobody's place)
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000); // (the switch names another: the doc frees them as ever)
    a.doc.transact(() => { // (revived)
      if (how === 'mark') casinoOf(a).delete(`gone:${TABLE}:${other}`);
      else computedOf(a).set(`sum:${TABLE}:${other}`, sum(false));
    });
    sync(T0 + 3, a, b);
    expect(a.casino.computedIncEnded(TABLE, other)).toBe(false);
    for (const p of [a, b]) expect(p.casino.switchLeftFor(TABLE, INC)).toBe(other);
    switchTo(a, G.inc);
    sync(T0 + 4, a, b);
    for (const p of [a, b]) expect(p.casino.readChips(p.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  /** Both pages ticked until the close is in, then the game opens (its root and the
   *  switch naming it) and is played for `ms` with both pages ticking, then ends. */
  async function playedBeside(ms: number, withHouse = false): Promise<{ a: Page; b: Page; at: number }> {
    const { a, b } = await staked();
    if (withHouse) { // (the room has a house: A holds the deed and delegates the house's key on its next frame)
      a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid));
      sync(T0, a, b);
      a.table.setLocalHouse(HOUSE.pub);
    }
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
    if (withHouse) expect(a.casino.houseSetUp()).toBe(true);
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

  // The time a state is served again from is the page's clock, which a read or a frame
  // sets. A read that serves the table before any frame (the display asks which round is
  // decided to; the migration of a table PR 2-4 opened, with a house in the room) refreshes
  // it first, as every other read does: else the state would wait from the time of the
  // last frame, seconds old, and the next frame, short of a wake, would find the grace of
  // a close long past and forfeit the player whose page had not yet revealed. (The page
  // whose turn is first among the bettors is the one that reads, and frames first: a page
  // behind it in turn stands by a few seconds, and the other's reveal comes in meanwhile.)
  it.each([
    ['the round decided to, without a game', false, (p: Page) => expect(typeof p.table.computedDecidedTo(TABLE)).toBe('number')],
    ['the round decided to, at a roulette table', false, (p: Page) => expect(typeof p.table.computedDecidedTo(TABLE, 'roulette')).toBe('number')],
    ['the migration to a house table, the room having a house', true, (p: Page) => expect(p.table.autoSwitchComputed(TABLE, 'roulette')).toBe(false)],
  ] as [string, boolean, (p: Page) => void][])('start afresh from now for a read that serves the table before any frame, too: the page\'s last frame is seconds old, the grace is from the read and not from it (%s)', async (_, withHouse, read) => {
    const { a, b, at } = await playedBeside(40_000, withHouse);
    const [first, second] = [a, b].sort((x, y) => (dutyRank('forfeit', CTX, 1, x.pub) < dutyRank('forfeit', CTX, 1, y.pub) ? -1 : 1));
    const last = at - STEP; // (the pages' last frames, in the game)
    // Another page puts the switch back (written as it writes it); the page's has not looked since its last frame.
    switchTo(first, INC);
    sync(last + 1_500, first, second);
    expect(first.casino.computedIncOf(TABLE)).toBe(INC);
    expect(first.casino.computedGameMovesOf(TABLE)).toBeGreaterThan(0); // (the doc counted the game, this page looking at nothing)
    // Its display asks five seconds after that frame, and its next frame comes at once: short of a wake,
    // past the grace of a close seen at the last frame (REVEAL_GRACE_MS). The other page looks then too.
    clockOf(first, last + 5_000);
    read(first);
    run([first, second], last + 5_000, last + 5_000 + 2_000, { step: STEP });
    expect(first.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!.forfeit).toBeUndefined();
    run([first, second], last + 7_200, last + 30_000, { step: STEP });
    const round = first.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!;
    expect(round.decided).toBe('reveals');
    expect(round.forfeit).toBeUndefined();
    expect([...round.counted].sort()).toEqual([a.pid, b.pid].sort());
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

  it.each([
    ['the card reads the table: a look puts the other\'s state in place of the one that waited', true],
    ['nothing looks at the table in the room\'s list: the compaction duty alone puts it in place', false],
  ] as [string, boolean][])('start afresh for the other incarnation that took the switch while the game was played, too: a slip that came to the page meanwhile does not run its betting window out, %s', async (_, card) => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const other = 'c' + '5b'.repeat(12);
    const ctxOther = { room: PAGE_ROOM, t: TABLE, inc: other };
    const window = a.table.BET_WINDOW_MS;
    let at = tick(a, T0 + STEP, 1_000); // (A runs the page-signed incarnation: its state is there)
    record(a, root);
    switchTo(a, G.inc);
    at = tick(a, at, 2_000, STEP, card ? undefined : []); // (a game is played: A waits, the table in the room's list or not)
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
    // A single look at the table (the card reads it) puts the other's state in place of the one that
    // waited, or else the first frame's compaction duty does; the page's frames go on, the table out of its list.
    if (card) {
      clockOf(a, at);
      a.table.computedCheckpointView(TABLE);
    }
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

  // The game may be over by the time the switch leaves the state: nothing looked
  // at the table while it was played, and the compaction duty puts the other's
  // state in place after the game ended. It is served afresh all the same, the
  // count of the games played being the doc's, not a frame's.
  it('start afresh for the other incarnation that took the switch after the game ended, too: the table out of the page\'s list through the game, and the compaction duty puts the other\'s state in place after it', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const other = 'c' + '5b'.repeat(12);
    const ctxOther = { room: PAGE_ROOM, t: TABLE, inc: other };
    const window = a.table.BET_WINDOW_MS;
    let at = tick(a, T0 + STEP, 1_000); // (A runs the page-signed incarnation: its state is there)
    record(a, root);
    switchTo(a, G.inc);
    at = tick(a, at, 2_000, STEP, []); // (a game is played, and ends: no look at the table)
    record(a, end);
    b.doc.transact(() => {
      const ses = new Y.Map<unknown>();
      const slip = signAs(b, 'slip', { r: 1, p: b.pid, v: 1, b: [red(9)], c: slipCommit(ctxOther, 1, b.pid, hex('9', 32)) }, ctxOther);
      ses.set(slipKeyFor(ctxOther)(slip)!, slip);
      computedOf(b).set(`ses:${TABLE}:${other}:g`, ses);
    });
    send(at, b, a);
    a.doc.transact(() => casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other }));
    expect(a.casino.computedGameMovesOf(TABLE)).toBe(1); // (the doc counted the game's end, the page looking at nothing)
    at = tick(a, at + STEP, 3 * window, STEP, []); // (the window would have run out, long over, had it run)
    const back = run([a], at, at + 20_000, { step: STEP, until: () => a.casino.computedIncOf(TABLE) === other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    const view = a.table.readComputedRoulette(TABLE, back + 2 * STEP)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline!).toBeGreaterThanOrEqual(back + window - 1_000);
  });

  // With no game played there is nothing to wait out afresh: the state the
  // compaction duty puts in place of the one the switch left, at a table out of
  // the room's list, is the other's as its first look would have made it.
  it('do not start afresh when no game was played: a window that ran out while the table was out of the room\'s list is served as it is', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const other = 'c' + '5b'.repeat(12);
    const ctxOther = { room: PAGE_ROOM, t: TABLE, inc: other };
    const window = a.table.BET_WINDOW_MS;
    let at = tick(a, T0 + STEP, 1_000); // (A runs the page-signed incarnation: its state is there)
    b.doc.transact(() => {
      const ses = new Y.Map<unknown>();
      const slip = signAs(b, 'slip', { r: 1, p: b.pid, v: 1, b: [red(9)], c: slipCommit(ctxOther, 1, b.pid, hex('9', 32)) }, ctxOther);
      ses.set(slipKeyFor(ctxOther)(slip)!, slip);
      computedOf(b).set(`ses:${TABLE}:${other}:g`, ses);
    });
    send(at, b, a);
    a.doc.transact(() => casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other }));
    at = tick(a, at + STEP, 3 * window, STEP, []); // (the compaction duty puts the other's state in place; its window would have run out, long over, had it run)
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    const view = a.table.readComputedRoulette(TABLE, at + STEP)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline!).toBeLessThan(at); // (the window started when the slip came, and nothing has started it afresh)
  });

  // A FAIR ONLY name nothing opened is no game played: the switch carrying one while the
  // table is out of the room's list, and the state the compaction duty puts in place
  // there, move nothing to start afresh.
  it('do not start afresh when the switch carried a name nothing opened, a hint and no game: a window that ran out while the table was out of the room\'s list is served as it is', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    const other = 'c' + '5b'.repeat(12);
    const ctxOther = { room: PAGE_ROOM, t: TABLE, inc: other };
    const window = a.table.BET_WINDOW_MS;
    let at = tick(a, T0 + STEP, 1_000); // (A runs the page-signed incarnation: its state is there)
    b.doc.transact(() => {
      const ses = new Y.Map<unknown>();
      const slip = signAs(b, 'slip', { r: 1, p: b.pid, v: 1, b: [red(9)], c: slipCommit(ctxOther, 1, b.pid, hex('9', 32)) }, ctxOther);
      ses.set(slipKeyFor(ctxOther)(slip)!, slip);
      computedOf(b).set(`ses:${TABLE}:${other}:g`, ses);
    });
    send(at, b, a);
    switchTo(a, other);
    switchTo(a, G.inc); // (a hint at a name nothing opened: no game is played)
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    expect(a.casino.computedGameMovesOf(TABLE)).toBe(0);
    at = tick(a, at + STEP, 3 * window, STEP, []); // (the compaction duty puts the other\'s state in place)
    at = tick(a, at, 2_000); // (the table is back in the room\'s list: the switch is put back over the name)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    const view = a.table.readComputedRoulette(TABLE, at + STEP)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline!).toBeLessThan(at); // (the window started when the slip came, and nothing has started it afresh)
  });

  // The count of the games played at a table is the doc's: it does not wait for a
  // frame to look at the table. A page whose list of the room's tables held this
  // one in no frame of the game serves its state afresh all the same.
  it('start afresh for a page that looked at the table in no frame of the game, too: the table out of its list while the game is played leaves the waits of its state where they were no more', async () => {
    const { a, b } = await staked();
    const closed = (): boolean => keysIn(a, 'c', 1).length > 0;
    const at = run([a, b], T0 + STEP, T0 + 60_000, { step: STEP, until: closed });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
    expect(keysIn(a, 'r', 1)).toEqual([]);
    record(a, root);
    switchTo(a, G.inc);
    sync(at, a, b);
    const mid = runLists([[a, []], [b, undefined]], at + STEP, at + 40_000); // (the table is in B's list, not in A's)
    expect(keysIn(a, 'r', 1)).toEqual([]);
    record(a, end);
    sync(mid, a, b);
    // The game is over and both pages look at the table: A's state is served again, its waits from here.
    const soon = runLists([[a, undefined], [b, undefined]], mid + STEP, mid + 3_000);
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!.forfeit).toBeUndefined();
    runLists([[a, undefined], [b, undefined]], soon, soon + 20_000);
    const round = a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!;
    expect(round.decided).toBe('reveals');
    expect(round.forfeit).toBeUndefined();
    expect([...round.counted].sort()).toEqual([a.pid, b.pid].sort());
  });

  // A page bound while the game is played has no state of the page-signed
  // incarnation to resume, and the records it found came to it when it was bound:
  // the state it makes when the table goes back has the table's return as its floor.
  it.each([
    ['its frames run while the game is played', true],
    ['its first frame comes only after the game ended', false],
  ] as [string, boolean][])('start afresh for a page that was bound while the game was played, too: the state it makes when the table goes back does not take the grace from the day the records came to it, %s', async (_, framesDuring) => {
    const [a, b, c] = await openRoom(['A', 'B', 'C'], T0);
    for (const [p, bets] of [[a, [red(9)]], [b, [black(9)]], [c, [red(5)]]] as [Page, ReturnType<typeof red>[]][]) {
      clockOf(p, T0);
      expect(p.table.writeComputedSlip(TABLE, bets, T0)).toBe('ok');
    }
    sync(T0, a, b, c);
    const closed = (): boolean => keysIn(a, 'c', 1).length > 0;
    const at = run([a, b, c], T0 + STEP, T0 + 60_000, { step: STEP, until: closed });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
    expect(keysIn(a, 'r', 1)).toEqual([]);
    record(a, root);
    switchTo(a, G.inc);
    sync(at, a, b, c);
    rejoin(a, b, 11, at + STEP); // (A comes back to the room: nothing of its tables is kept, its seeds are)
    const mid = run(framesDuring ? [a, b, c] : [b, c], at + 2 * STEP, at + 40_000, { step: STEP });
    expect(keysIn(a, 'r', 1)).toEqual([]); // (nobody reveals meanwhile)
    record(a, end);
    sync(mid, a, b, c);
    // B's page puts the switch back and A's makes its state of the incarnation; C's page is slow,
    // and the grace a page-signed table gives it is a fresh one, from the table's return.
    const soon = run([a, b], mid + STEP, mid + 3_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!.decided).toBeNull();
    expect(a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!.forfeit).toBeUndefined();
    run([a, b, c], soon, soon + 20_000, { step: STEP });
    const round = a.casino.computedFoldOf(TABLE)!.rounds.find((r) => r.r === 1)!;
    expect(round.decided).toBe('reveals');
    expect(round.forfeit).toBeUndefined();
    expect([...round.counted].sort()).toEqual([a.pid, b.pid, c.pid].sort());
  });

  // The count a table was served at is of the binding it was made in. A page that
  // binds another doc, in which the game is over and the table back, has no game
  // to wait out afresh, whatever it saw of one in the last binding (the game, and
  // the state served afresh after it): the records it finds came to it when it was
  // bound, and that is when its waits start.
  it('start no wait afresh for a page bound after the game ended, whatever it saw of the game in its last binding: the count served is of the binding it was made in', async () => {
    const [a, b] = await openRoom(['A', 'B'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    sync(T0, a, b);
    const window = a.table.BET_WINDOW_MS;
    let at = run([a, b], T0 + STEP, T0 + 1_000, { step: STEP });
    record(a, root);
    switchTo(a, G.inc);
    sync(at, a, b);
    at = run([a, b], at, at + 2_000, { step: STEP }); // (a game is played: both pages look at the table)
    record(a, end);
    sync(at, a, b);
    at = run([a, b], at, at + 2_000, { step: STEP, until: () => b.casino.computedIncOf(TABLE) === INC }); // (B's page puts the switch back)
    expect(b.casino.computedIncOf(TABLE)).toBe(INC);
    at = run([a, b], at + STEP, at + 2 * STEP, { step: STEP }); // (and A's serves the state again, afresh, at the count the game left)
    rejoin(a, b, 11, at); // (A comes back on a doc where the game is over, and looks at the table a while later)
    const first = at + 5_000;
    tick(a, first, 0);
    const view = a.table.readComputedRoulette(TABLE, first + STEP)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline! - at).toBeLessThan(window + STEP); // (the window runs from when the slip came to the page, at its binding)
  });

  // A table hosts games one after another: the waits of the state the first
  // return started afresh are as stale after the second game as the first's were
  // after the first.
  it('start afresh at every return, not only the first: a second game played at the table resumes the state again', async () => {
    const [a] = await openRoom(['A'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const window = a.table.BET_WINDOW_MS;
    /** The game opens at `from`, is played for longer than a window, ends; the time the table is back. */
    const play = (from: number, opens: { key: string; value: unknown }, ends: { key: string; value: unknown }, inc: string): number => {
      record(a, opens);
      switchTo(a, inc);
      const mid = run([a], from, from + window + 5_000, { step: STEP });
      record(a, ends);
      return run([a], mid, mid + 20_000, { step: STEP, until: () => a.casino.computedIncOf(TABLE) === INC });
    };
    const first = play(tick(a, T0 + STEP, 1_000), root, end, G.inc);
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(keysIn(a, 'c', 1)).toEqual([]);
    expect(a.table.readComputedRoulette(TABLE, first + 2 * STEP)!.phaseDeadline!).toBeGreaterThanOrEqual(first + window - 1_000);
    // Half a window on, a second game opens, and is played past the end of that window too.
    const half = run([a], first + STEP, first + window / 2, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
    const second = play(half, root2, end2, G2.inc);
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(keysIn(a, 'c', 1)).toEqual([]);
    expect(a.table.readComputedRoulette(TABLE, second + 2 * STEP)!.phaseDeadline!).toBeGreaterThanOrEqual(second + window - 1_000);
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
