/**
 * 🔒🧮 A page-signed craps table beside the FAIR ONLY craps game (`q…`) its table plays
 * (design §8.4, PR 6c-4a-2): the same waiting as the roulette table's
 * (computedFairOnlyBeside), at the second game. What is the craps table's own is
 * the letters (a page-signed incarnation is `k…` or `d…`, and the other game's `c…`
 * and `r…` take nobody's place), the stakes (a pass line bet), and the roll window
 * the table serves afresh when it goes back to the page-signed incarnation.
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

  // A name of the table's other game is nothing this table can play, and takes no state's
  // place (a peer's doing, or a forgery): the bets and the seeds stay, and the page puts the
  // switch back on its own incarnation, never on the other game's.
  it.each(WHERE)('are kept when the switch names an incarnation of the table\'s other game (c…) while a game is played: the switch is put back on their own, %s', async (_, inRoom) => {
    const { a, felt } = await frozen();
    const roulette = 'c' + '3f'.repeat(12);
    record(a, root);
    takeSwitchTo(a, roulette);
    expect(a.casino.switchedPageSignedInc(TABLE)).toBe(roulette);
    const at = tick(a, T0 + STEP, 2 * a.table.REPUT_MS, STEP, inRoom ? [REF] : []);
    expect(a.casino.switchLeft(TABLE, INC)).toBe(false); // (the other game's name is nobody's successor)
    expect(a.fair.seedFor(felt, seedCtx(a, 1))).not.toBeNull();
    switchTo(a, G.inc);
    record(a, end);
    tick(a, at, 2 * a.table.REPUT_MS); // (the table in the room's list, the game over)
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: INC });
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
  });
});

describe('the stakes of a page-signed craps incarnation, while its table plays a FAIR ONLY craps game', () => {
  const other = OTHERS[0][1];

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
