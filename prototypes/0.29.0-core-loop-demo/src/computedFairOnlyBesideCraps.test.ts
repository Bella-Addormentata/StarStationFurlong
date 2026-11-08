/**
 * 🔒🧮 A page-signed craps table beside the FAIR ONLY craps game (`q…`) its table plays
 * (design §8.4, PR 6c-4a-2): the same waiting as the roulette table's
 * (computedFairOnlyBeside), at the second game. What is the craps table's own is
 * the letters (a page-signed incarnation is `k…` or `d…`; the other game's `c…` and
 * `r…` take nobody's place, and beside a live game one that the doc holds and nothing
 * has ended holds the incarnation's bets as a hint does), the stakes (a pass line bet), and the roll window the table serves
 * afresh when it goes back to the page-signed incarnation.
 *
 * Each page is its own load of the casino modules (computedPageKit), synced by hand,
 * every clock explicit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { seedTable } from './computedFold';
import { faironlyInc, sealFin } from './computedFairOnly';
import { delegation, hex, house, NAME, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { clockOf, CRAPS_CTX as CTX, CRAPS_INC as INC, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, keysIn, openCrapsRoom, PAGE_ROOM, run, standAt, sync } from './computedPageKit';
import type { Page } from './computedPageKit';

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

/** The game the owner opens at the craps table, and its end. */
const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('q', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(G, 'q', { dl: delegation(owner, house.pub, PAGE_ROOM) });
const end = trimOf(G, 'q', {
  ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(G, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {},
});

const seedCtx = (p: Page, r: number) => ({ room: CTX.room, table: seedTable(CTX), round: r, party: p.pid, house: '' });
const casinoOf = (p: Page) => p.doc.getMap('casino');
const computedOf = (p: Page) => p.doc.getMap('casinoComputed');

/** Page p back in the room on a fresh doc holding `from`'s state, as a rejoin binds one: what
 *  it kept of its tables is of the last binding, and the records it finds came to it now. */
function rejoin(p: Page, from: Page, clientID: number, T: number): void {
  const next = new Y.Doc();
  next.clientID = clientID;
  clockOf(p, T);
  Y.applyUpdate(next, Y.encodeStateAsUpdate(from.doc));
  p.casino.bindCasinoDoc(next, PAGE_ROOM);
  p.doc = next;
}

function record(p: Page, rec: { key: string; value: unknown }): void {
  p.doc.transact(() => computedOf(p).set(rec.key, rec.value));
}

function switchTo(p: Page, inc: string): void {
  p.doc.transact(() => casinoOf(p).set(`cfg:computed:${TABLE}`, { v: 1, inc }));
}

/** The switch names page-signed incarnation `inc`, whose first session the same write opens. */
function takeSwitchTo(p: Page, inc: string): void {
  p.doc.transact(() => {
    casinoOf(p).set(`cfg:computed:${TABLE}`, { v: 1, inc });
    computedOf(p).set(`ses:${TABLE}:${inc}:g`, new Y.Map());
  });
}

/** Frames of `p` every `step` over `ms` from `from`, the room's tables being the craps one
 *  (`tables` otherwise); the time after. */
function tick(p: Page, from: number, ms: number, step = STEP, tables = [REF]): number {
  run([p], from, from + ms, { step, tables });
  return from + ms + step;
}

/** A's page, the craps incarnation switched on and a pass line bet of A's frozen on it. */
async function frozen(): Promise<{ a: Page; felt: string }> {
  const [a] = await openCrapsRoom(['A'], T0);
  standAt(a, 1);
  expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
  const felt = a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c;
  expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  return { a, felt };
}

/** Two pages, a pass line bet each (10 and 5). */
async function staked(): Promise<{ a: Page; b: Page }> {
  const [a, b] = await openCrapsRoom(['A', 'B'], T0);
  standAt(a, 1);
  standAt(b, 3);
  expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
  expect(crapsBet(b, [{ type: 'pass', amount: 5 }], T0)).toBe('ok');
  sync(T0, a, b);
  expect([a.casino.readChips(a.pid), b.casino.readChips(b.pid)]).toEqual([990, 995]);
  return { a, b };
}

const chipsOf = (...pages: Page[]): number[] => pages.map((p) => p.casino.readChips(p.pid));

/** The page-signed letters of craps. */
const OTHERS: [string, string][] = [['k', 'k' + '5d'.repeat(12)], ['d', 'd' + '5d'.repeat(12)]];
const WHERE: [string, boolean][] = [['at a table in the room', true], ['at a table out of the room: the compaction duty alone looks', false]];

describe('the seeds behind the bets of a page-signed craps incarnation, while its table plays a FAIR ONLY craps game', () => {
  it('are kept while the game is played, the switch naming it or not, and are still there when it ends and the table goes back to the incarnation', async () => {
    const { a, felt } = await frozen();
    record(a, root);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    let at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    switchTo(a, G.inc);
    at = tick(a, at, 2 * a.table.REPUT_MS);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    record(a, end);
    tick(a, at, 2 * a.table.REPUT_MS);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(a.casino.computedFoldOf(TABLE)!.felts.get(a.pid)!.rec.c).toBe(felt);
  });

  describe.each(OTHERS)('another page-signed incarnation (%s…) takes the switch while a game is played', (_letter, other) => {
    it.each(WHERE)('the seeds go and the state is replaced by the other\'s, and when the game ends the switch is put back on that one, %s', async (_, inRoom) => {
      const { a, felt } = await frozen();
      record(a, root);
      takeSwitchTo(a, other);
      expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is the one played, the switch a hint)
      let at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, inRoom ? [REF] : []);
      expect(a.casino.switchLeftFor(TABLE, INC)).toBe(other);
      expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
      switchTo(a, G.inc); // (the hint is back over it, and the game ends over its name)
      record(a, end);
      at = tick(a, at, 2 * a.table.REPUT_MS, STEP, inRoom ? [REF] : []);
      tick(a, at, 3 * a.table.REPUT_MS); // (the table in the room's list)
      expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
      expect(a.casino.computedIncOf(TABLE)).toBe(other);
      expect(a.fair.seedFor(felt, seedCtx(a, 1))).toBeNull();
      expect(a.casino.computedFoldOf(TABLE)!.felts.size).toBe(0); // (the bet it froze is nobody's to settle)
    });
  });

  // A tracked name of the table's other game is no incarnation this table can play and no
  // successor of the one its page ran: a peer's doing, or a forgery. That incarnation waits
  // under it as it waits under a hint, its players being mid-round: the stakes of its bets
  // stay held, its seeds and its state are kept, and compaction leaves it be however long the
  // name stands, which is as long as the room takes to clear it (awayDuty). Cleared, the
  // pages that ran the incarnation put the switch back on it; at a table out of the room's
  // list no page does, and compaction ends the abandoned incarnation then, void.
  it.each(WHERE)('wait under a tracked incarnation of the table\'s other game (c…) while a game is played, stakes held and seeds kept and not compacted past the compaction wait, until the room clears the name, %s', async (_, inRoom) => {
    const { a, b } = await staked();
    const felts = [a, b].map((p) => p.casino.computedFoldOf(TABLE)!.felts.get(p.pid)!.rec.c);
    const roulette = 'c' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, roulette);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is still the one played)
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(roulette);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false); // (the other game's name is nobody's successor)
    expect(chipsOf(a, b)).toEqual([990, 995]);
    clockOf(a, T0 + 3);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(990); // (what is not staked, no more)
    const tables = inRoom ? [REF] : [];
    const mid = run([a, b], T0 + 4, T0 + 4 + 3 * a.table.COMPACT_MS, { step: 1_000, tables });
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(roulette);
    [a, b].forEach((p, i) => expect(p.fair.seedFor(felts[i], seedCtx(p, 1))).not.toBeNull());
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(chipsOf(a, b)).toEqual([0, 995]);
    run([a, b], mid + 1_000, mid + 2 * a.table.AWAY_MS, { step: 1_000, tables });
    expect(a.casino.computedIncEnded(TABLE, roulette)).toBe(true);
    if (inRoom) {
      expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC }); // (put back on their own)
      expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
      expect(chipsOf(a, b)).toEqual([0, 995]);
      [a, b].forEach((p, i) => expect(p.fair.seedFor(felts[i], seedCtx(p, 1))).not.toBeNull());
    } else {
      expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true); // (abandoned: nobody puts the switch back)
      expect(chipsOf(a, b)).toEqual([10, 1_000]); // (void: nobody charged; A has cashed out what was free)
    }
  });

  // A name nothing of which the doc holds takes nobody's place, whichever game it is of: the
  // seeds and the state are kept, and the page puts the switch back on its own incarnation. It
  // is a lost switch, so the stakes are free until it is (a name the doc holds, beside a live
  // game, is the 'wait under' test above).
  it.each([
    ['c', 'c' + '3f'.repeat(12)],
    ['d', 'd' + '3f'.repeat(12)],
  ] as [string, string][])('keep their state and their seeds when the switch names an incarnation (%s…) nothing of which the doc holds: the stakes are free and the incarnation listed until the switch is put back on their own', async (_, name) => {
    const { a, felt } = await frozen();
    record(a, root);
    expect(a.casino.readChips(a.pid)).toBe(990);
    switchTo(a, name);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBeNull();
    expect(a.casino.readChips(a.pid)).toBe(1_000);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.readChips(a.pid)).toBe(990);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    tick(a, at, 2 * a.table.COMPACT_FALLBACK_MS);
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
  });
});

describe('the stakes of a page-signed craps incarnation, while its table plays a FAIR ONLY craps game', () => {
  const other = OTHERS[0][1];

  // The game can end while the name stands. No game is live then, so the name is the lost
  // switch that main reads it as: the stakes are free, and compaction ends the incarnation
  // after its wait.
  it('are freed when the game ends under a tracked incarnation of the table\'s other game: no game is played then, the name is a lost switch, and compaction ends them', async () => {
    const { a, b } = await staked();
    const roulette = 'c' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, roulette);
    sync(T0 + 2, a, b);
    expect(chipsOf(a, b)).toEqual([990, 995]); // (the game is live: held)
    record(a, end);
    sync(T0 + 3, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(roulette); // (no game is played now: the switch's name is)
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]); // (free)
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    run([a, b], T0 + 4, T0 + 4 + 3 * a.table.COMPACT_MS, { step: 1_000, tables: [REF] });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
  });

  // With no game at the table at all, a tracked name of the other game is main's lost switch
  // and nothing else: the stakes are free, and compaction ends the incarnation after its wait.
  it('are freed under a tracked incarnation of the table\'s other game when no game is played, as on main: compaction ends them after its wait', async () => {
    const { a, b } = await staked();
    const roulette = 'c' + '3f'.repeat(12);
    takeSwitchTo(a, roulette);
    sync(T0 + 1, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(roulette);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    run([a, b], T0 + 2, T0 + 2 + 3 * a.table.COMPACT_MS, { step: 1_000, tables: [REF] });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
  });

  // ...and a name that goes before the wait is out leaves the incarnation to be played again:
  // the page puts the switch back on it, and its stakes are held again.
  it('are held again under no game when the tracked incarnation of the table\'s other game goes within seconds: the page puts the switch back on them', async () => {
    const { a, b } = await staked();
    const roulette = 'c' + '3f'.repeat(12);
    takeSwitchTo(a, roulette);
    sync(T0 + 1, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    const mid = run([a, b], T0 + 2, T0 + 4_000, { step: 500, tables: [REF] });
    a.doc.transact(() => casinoOf(a).delete(`cfg:computed:${TABLE}`));
    run([a, b], mid, mid + 4_000, { step: 500, tables: [REF] });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(false);
    expect(chipsOf(a, b)).toEqual([990, 995]);
  });

  // What the name does to the stakes follows the game: free while none is live (above), held
  // when one opens, free again when it ends. Each is a count of the table's others that no
  // record of theirs brought.
  it('follow the game under a tracked incarnation of the table\'s other game: free with none live, held when one opens, free when it ends', async () => {
    const { a, b } = await staked();
    const roulette = 'c' + '3f'.repeat(12);
    takeSwitchTo(a, roulette);
    sync(T0 + 1, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    record(a, root);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(chipsOf(a, b)).toEqual([990, 995]);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).not.toContain(INC);
    record(a, end);
    sync(T0 + 3, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // A page bound afresh finds the name in the doc already, ended or not, and reads the turns
  // that follow against that: the mark deleted holds the stakes if the name was ended when the
  // page was bound, and the mark written frees them if it was not.
  it('follow the other game\'s name for a page bound with it in the doc already, ended or not: the stakes are held when its removal\'s mark is deleted, and free when it is written again', async () => {
    const { a, b } = await staked();
    const roulette = 'c' + '3f'.repeat(12);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => { // (a name the doc holds, ended already)
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: roulette });
      computedOf(a).set(`ses:${TABLE}:${roulette}:g`, new Y.Map());
      casinoOf(a).set(`gone:${TABLE}:${roulette}`, 1);
    });
    sync(T0 + 2, a, b);
    rejoin(b, a, 12, T0 + 3); // (B is bound afresh on a doc that holds the ended name)
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    a.doc.transact(() => casinoOf(a).delete(`gone:${TABLE}:${roulette}`));
    sync(T0 + 4, a, b);
    expect(chipsOf(a, b)).toEqual([990, 995]);
    rejoin(b, a, 13, T0 + 5); // (and again, on a doc that holds the name alive)
    expect(chipsOf(b)).toEqual([995]);
    a.doc.transact(() => casinoOf(a).set(`gone:${TABLE}:${roulette}`, 1));
    sync(T0 + 6, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    expect(b.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // The incarnation the switch left is over for good, and a tracked name of the other game that
  // comes after is no way back to it either (as a hint is none): its pages have let go of the
  // seeds behind its bets, and holding its stakes would lock chips nobody can settle.
  it('stay free when the switch names a tracked incarnation of the table\'s other game after another page-signed incarnation of their game took it, beside a live game: it is no way back to the one it left, and compaction ends it', async () => {
    const { a, b } = await staked();
    const roulette = 'c' + '3f'.repeat(12);
    const [, other] = OTHERS[0];
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    takeSwitchTo(a, other);
    sync(T0 + 2, a, b);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    const at = run([a, b], T0 + 3, T0 + 2 * a.table.REPUT_MS, { step: STEP, tables: [REF] });
    takeSwitchTo(a, roulette);
    sync(at, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(roulette);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(true);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
    run([a, b], at + STEP, at + 2 * a.table.COMPACT_FALLBACK_MS, { step: 1_000, tables: [REF] });
    expect(a.casino.computedIncEnded(TABLE, INC)).toBe(true);
  });

  it('stay held while the game is played, the switch naming it or not, and through its end: the bets settle when the table goes back', async () => {
    const { a, b } = await staked();
    record(a, root);
    sync(T0 + 1, a, b);
    expect(chipsOf(a, b)).toEqual([990, 995]);
    switchTo(a, G.inc);
    sync(T0 + 2, a, b);
    expect(chipsOf(a, b)).toEqual([990, 995]);
    clockOf(a, T0 + 3);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(990); // (what is not staked, no more)
    record(a, end);
    sync(T0 + 4, a, b);
    expect(chipsOf(b)).toEqual([995]); // (the switch still names the dead game: no recount frees them)
    run([b], T0 + 5, T0 + 2 * a.table.REPUT_MS, { step: STEP, tables: [REF] });
    expect(casinoOf(b).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(chipsOf(b)).toEqual([995]);
  });

  it('are freed when another page-signed incarnation takes the switch while a game is played, and a hint after that holds nothing of them: nothing of them comes back to settle when the game ends', async () => {
    const { a, b } = await staked();
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    expect(chipsOf(a, b)).toEqual([990, 995]);
    takeSwitchTo(a, other);
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc); // (the game is still the one played)
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    clockOf(a, T0 + 3);
    expect(a.casino.cashOutChips(a.pid, 1_000)).toBe(1_000); // (the chips are free: they can be spent)
    const mid = run([a, b], T0 + 4, T0 + 2 * a.table.REPUT_MS, { step: STEP, tables: [REF] });
    switchTo(a, G.inc); // (the hint names the game again: no way back to the first)
    sync(mid, a, b);
    expect(chipsOf(b)).toEqual([1_000]);
    record(a, end);
    sync(mid + 1, a, b);
    run([a, b], mid + STEP, mid + 2 * a.table.REPUT_MS, { step: STEP, tables: [REF] });
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: other });
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    expect(chipsOf(a, b)).toEqual([0, 1_000]);
  });

  it('are freed for a page that binds with the switch already on another page-signed incarnation, a hint after that holding nothing of them', async () => {
    const { a, b } = await staked();
    takeSwitchTo(b, other);
    sync(T0 + 1, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 2, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });

  // The incarnation the switch names can come to take places after the switch named it and
  // the page counted the first, by no longer being ended: its removal's mark deleted. The
  // page counts the table's others again then, or the hint that follows holds the stakes
  // of an incarnation whose seeds other pages let go of.
  it('are over when the incarnation the switch names, ended when it was named, is revived by its removal\'s mark being deleted: the hint that follows holds nothing of them', async () => {
    const { a, b } = await staked();
    record(a, root);
    switchTo(a, G.inc);
    sync(T0 + 1, a, b);
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: other });
      computedOf(a).set(`ses:${TABLE}:${other}:g`, new Y.Map());
      casinoOf(a).set(`gone:${TABLE}:${other}`, 1);
    });
    sync(T0 + 2, a, b);
    expect(a.casino.computedIncEnded(TABLE, other)).toBe(true);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false); // (an ended name takes nobody's place)
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    a.doc.transact(() => casinoOf(a).delete(`gone:${TABLE}:${other}`));
    sync(T0 + 3, a, b);
    for (const p of [a, b]) expect(p.casino.switchLeftFor(TABLE, INC)).toBe(other);
    switchTo(a, G.inc);
    sync(T0 + 4, a, b);
    expect(chipsOf(a, b)).toEqual([1_000, 1_000]);
    expect(a.casino.computedEndedIncs().map((e) => e.inc)).toContain(INC);
  });
});

describe('the roll window of a page-signed craps incarnation, after its table played a FAIR ONLY craps game', () => {
  // The table is served afresh when it goes back to the incarnation: the doc counts the game
  // (computedGameMovesOf), whether or not a frame looked at the table while it was played.
  it('is started afresh: the view built before the game, of a window that had run out, is not served again', async () => {
    const [a] = await openCrapsRoom(['A'], T0);
    standAt(a, 1);
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
    const window = a.croupier.CRAPS_BET_WINDOW_MS;
    run([a], T0 + STEP, T0 + window - 1_000, { step: STEP, tables: [REF] });
    // The view of a window run out is built and kept (nothing woke the page), the close not written yet.
    const expired = crapsOf(a, T0 + window + 60_000)!;
    expect(expired.phase).toBe('closing');
    expect(keysIn(a, 'c', 1, TABLE)).toEqual([]);
    record(a, root);
    switchTo(a, G.inc);
    const mid = run([a], T0 + window + 61_200, T0 + window + 101_000, { step: STEP, tables: [REF] });
    expect(keysIn(a, 'c', 1, TABLE)).toEqual([]); // (no duty of the page-signed incarnation ran meanwhile)
    record(a, end);
    const back = run([a], mid, mid + 20_000, { step: STEP, tables: [REF], until: () => a.casino.computedIncOf(TABLE) === INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(keysIn(a, 'c', 1, TABLE)).toEqual([]);
    const view = crapsOf(a, back + 500)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline!).toBeGreaterThanOrEqual(back + window - 1_000);
    run([a], back + STEP, back + window - 2_000, { step: STEP, tables: [REF] });
    expect(keysIn(a, 'c', 1, TABLE)).toEqual([]);
    run([a], back + window - 1_800, back + window + 5_000, { step: STEP, tables: [REF], until: () => keysIn(a, 'c', 1, TABLE).length > 0 });
    expect(keysIn(a, 'c', 1, TABLE).length).toBeGreaterThan(0);
  });
});
