/**
 * 🔒🎲 Pages play a FAIR ONLY craps game (design §8.4, PR 6c-4b-1a): the same
 * duties as computedFairOnlyPlay.test.ts at a `q` game, with what is craps's own
 * on top: the stands, the roll's dice (the players' seeds and the house's), and
 * the carried state (the point, the riding bets) that no checkpoint of a
 * page's own brings along, a game having none. Its own file so that the table
 * is the craps one throughout.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc } from './computedFairOnly';
import { diceOf } from './computedCraps';
import { asClose, MAX_TABLE_PIDS, nextSid3, seedTable } from './computedFold';
import type { CloseRec, CrapsSlipRec, HouseRevealRec } from './computedFold';
import { delegation, hex, house as H, NAME, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { carryOf, clockOf, CRAPS_REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, keysIn, loadPage, PAGE_ROOM, putIn, run, standAt, sync, tagSeed } from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit } from './computedTestKit';
import type { Built } from './computedTestKit';

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

/** The craps game the owner opens at the table, in the page kit's room. */
const Q = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('q', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(Q, 'q', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID = nextSid3(Q, root.value);
const kit = new ComputedKit(Q);

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const recOf = <R>(p: Page, key: string): R => p.casino.computedSessionForWrite(TABLE)!.get(key) as R;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r, TABLE).map((k) => asClose(recOf(p, k))!);
const hashIn = (key: string): string => key.slice(key.lastIndexOf(':') + 1);
/** The house's records put in the game's live session on page p. */
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]), TABLE);

/** Pages `names` at stands 1, 2, ..., 1,000 chips each, and the game open in the first page's doc
 *  (its root, and the live session the root opens), all synced at T0. */
async function gameRoom(names: string[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1));
  for (const [i, p] of pages.entries()) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
    standAt(p, i + 1);
  }
  const [a] = pages;
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(`ses:${TABLE}:${Q.inc}:${SID}`, new Y.Map());
  });
  sync(T0, ...pages);
  run(pages, T0, T0, { step: STEP, tables: [CRAPS_REF] }); // (awake)
  return pages;
}

/** Queue on each of `pages` the next fresh seed so that roll r's dice, from their
 *  seeds and the house's (the one its reveal of the round carries), sum to `sum`:
 *  the page kit's rigRoll without the house's seed in the mix. */
function rigRoll(pages: Page[], r: number, sum: number): void {
  const hs = kit.houseSeed(H, r);
  const rest = pages.slice(1).map((p) => tagSeed(`${p.name}:${r}:${sum}`));
  for (let n = 0; n < 10_000; n++) {
    const first = tagSeed(`${pages[0].name}:${r}:${sum}:${n}`);
    const [d1, d2] = diceOf(seedTable(Q), r, [first, ...rest], hs);
    if (d1 + d2 !== sum) continue;
    pages[0].seeds.push(first);
    pages.slice(1).forEach((p, i) => p.seeds.push(rest[i]));
    return;
  }
  throw new Error(`rigRoll: no seeds for ${sum}`);
}

/** The pages bet the pass line on roll 1, which comes up `sum`, with the house joined to it. */
async function betting(names: string[], sum = 7): Promise<Page[]> {
  const pages = await gameRoom(names);
  const [a] = pages;
  house(a, kit.houseJoin(H, 1));
  rigRoll(pages, 1, sum);
  for (const p of pages) expect(crapsBet(p, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
  sync(T0, ...pages);
  return pages;
}

/** Queue on each of `pages` the next fresh seed so that roll r's dice sum to `all` from every page's seed and the
 *  house's, and to `one` from the first page's alone (what the house's other reveal, counting that page's slip only, rolls). */
function rigSplit(pages: Page[], r: number, all: number, one: number): void {
  const hs = kit.houseSeed(H, r);
  const rest = pages.slice(1).map((p) => tagSeed(`${p.name}:${r}:${all}:${one}`));
  for (let n = 0; n < 10_000; n++) {
    const first = tagSeed(`${pages[0].name}:${r}:${all}:${one}:${n}`);
    const [d1, d2] = diceOf(seedTable(Q), r, [first, ...rest], hs);
    if (d1 + d2 !== all) continue;
    const [e1, e2] = diceOf(seedTable(Q), r, [first], hs);
    if (e1 + e2 !== one) continue;
    pages[0].seeds.push(first);
    pages.slice(1).forEach((p, i) => p.seeds.push(rest[i]));
    return;
  }
  throw new Error(`rigSplit: no seeds for ${all}/${one}`);
}

/** Round 1 of a game that two reveals of the house could decide: the one counting both pages' slips rolls a seven, the
 *  other, counting the first page's alone, a six. The one with the higher hash (the fold takes the lowest) decides the
 *  round first, and the other, held back, rewrites the roll when it comes. */
async function splitRoll(): Promise<{ pages: Page[]; a: Page; b: Page; first: Built<HouseRevealRec>; later: Built<HouseRevealRec>; at: number }> {
  const pages = await gameRoom(['A', 'B']);
  const [a, b] = pages;
  house(a, kit.houseJoin(H, 1));
  rigSplit(pages, 1, 7, 6);
  for (const p of pages) expect(crapsBet(p, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
  sync(T0, ...pages);
  const closedAt = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 1, TABLE).length > 0 });
  run(pages, closedAt + STEP, closedAt + 12_000, { step: STEP, tables: [CRAPS_REF] });
  const closeHash = hashIn(keysIn(a, 'c', 1, TABLE)[0]);
  const frozen = closesOf(a, 1)[0].f;
  // (Each reveal may list hashes of no slip, which count nobody: spelled a few ways, the one that rewrites the roll takes
  // the lowest hash of them, and the other is spelled until it ranks after it.)
  const spelled = (slips: string[], pad: number) => kit.houseReveal(H, 1, [closeHash], [...slips, ...Array.from({ length: pad }, (_, i) => (i + 1).toString(16).padStart(32, '0'))]);
  let later = spelled([frozen[a.pid]], 0);
  for (let pad = 1; pad < 8; pad++) {
    const x = spelled([frozen[a.pid]], pad);
    if (x.hash < later.hash) later = x;
  }
  let first = spelled(Object.values(frozen), 0);
  for (let pad = 1; first.hash <= later.hash && pad < 200; pad++) first = spelled(Object.values(frozen), pad);
  expect(first.hash > later.hash).toBe(true);
  house(b, first);
  sync(closedAt + 12_000, ...pages);
  for (const p of pages) expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'house', house: { hash: first.hash } });
  return { pages, a, b, first, later, at: closedAt + 12_000 };
}

describe('a roll of a FAIR ONLY craps game, on the pages', () => {
  it('the close names the house\'s join, every seed in decides nothing, the house\'s reveal does, and the chips move', async () => {
    const pages = await betting(['A', 'B']);
    const [a, b] = pages;
    for (const p of pages) expect(foldOf(p).joins).toHaveLength(1);
    const join = foldOf(a).joins[0];
    const closedAt = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 1, TABLE).length > 0 });
    const closes = closesOf(a, 1);
    expect(closes.length).toBeGreaterThan(0);
    expect([...new Set(closes.map((c) => c.h))]).toEqual([join.rec.c]);
    run(pages, closedAt + STEP, closedAt + 12_000, { step: STEP, tables: [CRAPS_REF] });
    for (const p of pages) {
      expect(keysIn(p, 'x', 1, TABLE)).toHaveLength(2);
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: null });
      expect(keysIn(p, 'f', 1, TABLE)).toEqual([]);
    }
    const closeHash = hashIn(keysIn(a, 'c', 1, TABLE)[0]);
    const frozen = Object.values(closes[0].f).sort();
    const hr = kit.houseReveal(H, 1, [closeHash], frozen);
    house(b, hr);
    sync(closedAt + 12_000, ...pages);
    for (const p of pages) {
      const v = foldOf(p).rounds[0];
      expect(v).toMatchObject({ decided: 'house', house: { hash: hr.hash } });
      expect(foldOf(p).required).toBe(kit.houseCommit(H, 2));
      for (const q of pages) {
        expect(v.deltas.get(q.pid)).toBe(10n); // (a seven on the come-out: the pass line wins)
        expect(p.casino.readChips(q.pid)).toBe(1_010);
      }
    }
  });

  it('no join, no close: the pass bets stay on the felt until the house joins', async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a] = pages;
    for (const p of pages) expect(crapsBet(p, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
    sync(T0, ...pages);
    const late = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, tables: [CRAPS_REF] });
    for (const p of pages) {
      expect(keysIn(p, 'c', undefined, TABLE)).toEqual([]);
      expect(foldOf(p)).toMatchObject({ required: null, joins: [], tip: null });
    }
    house(a, kit.houseJoin(H, 1));
    sync(late, ...pages);
    run(pages, late + STEP, late + 30_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 1, TABLE).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
  });

  it('a point made rides on: the carried state comes from the game\'s own fold, and the next roll\'s felts hold the riding passes', async () => {
    const pages = await betting(['A', 'B'], 6);
    const [a, b] = pages;
    const closedAt = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 1, TABLE).length > 0 });
    run(pages, closedAt + STEP, closedAt + 12_000, { step: STEP, tables: [CRAPS_REF] });
    const closes = closesOf(a, 1);
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1, TABLE)[0])], Object.values(closes[0].f).sort()));
    sync(closedAt + 12_000, ...pages);
    for (const p of pages) {
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'house' });
      expect(carryOf(p).p).toBe(6);
    }
    const shown = crapsOf(a, closedAt + 12_000)!.resultAt + a.croupier.CRAPS_SHOW_MS;
    run(pages, closedAt + 12_000 + STEP, shown + 5_000, { step: STEP, tables: [CRAPS_REF] });
    sync(shown + 5_000, ...pages);
    for (const p of pages) {
      expect(foldOf(p).open).toBe(2);
      expect(keysIn(p, 's', 2, TABLE)).toHaveLength(2); // (each page's riding pass, rebet as its felt)
    }
  });

  it('a page that leaves says goodbye over its riding bets and writes no more at the game; back from the back-forward cache, its frames write them again', async () => {
    const pages = await betting(['A', 'B'], 6);
    const [a, b] = pages;
    const closedAt = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 1, TABLE).length > 0 });
    run(pages, closedAt + STEP, closedAt + 12_000, { step: STEP, tables: [CRAPS_REF] });
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1, TABLE)[0])], Object.values(closesOf(a, 1)[0].f).sort()));
    sync(closedAt + 12_000, ...pages);
    const shown = crapsOf(a, closedAt + 12_000)!.resultAt + a.croupier.CRAPS_SHOW_MS;
    const at = run(pages, closedAt + 12_000 + STEP, shown + 5_000, { step: STEP, tables: [CRAPS_REF] });
    sync(at, ...pages);
    const latest = (p: Page): CrapsSlipRec => foldOf(p).felts.get(a.pid)!.rec as CrapsSlipRec;
    expect(keysIn(a, 's', 2, TABLE)).toHaveLength(2); // (each page's riding pass, rebet as its felt)
    expect(latest(a).l).toBeUndefined();
    // (A leaves: its goodbye is the riding bets, written over its felt, and its frames write nothing more at the game)
    a.table.leaveComputedTables(at);
    const goodbye = latest(a);
    expect(goodbye).toMatchObject({ r: 2, l: 1 });
    run([a, b], at + STEP, at + 3_000, { step: STEP, tables: [CRAPS_REF] });
    expect(latest(a)).toMatchObject({ v: goodbye.v, l: 1 });
    // (back from the cache: the goodbye no longer holds, and its frames write the felt it was)
    a.table.backAtComputedTables();
    run([a, b], at + 3_000 + STEP, at + 3_000 + 2 * STEP, { step: STEP, tables: [CRAPS_REF] });
    expect(latest(a).v).toBeGreaterThan(goodbye.v);
    expect(latest(a).l).toBeUndefined();
    expect(latest(a).b).toEqual(goodbye.b);
  });

  it('a change within the coalescing window is held and shown at once, and the tick writes it: the state read is the game\'s', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok'); // (written at once)
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }, { type: 'field', amount: 5 }], T0 + 50)).toBe('ok'); // (held)
    expect(a.table.readMyComputedCrapsBets(TABLE, a.pid, 1, T0 + 50).felt.map((b) => b.type).sort()).toEqual(['field', 'pass']);
    expect((foldOf(a).felts.get(a.pid)!.rec as CrapsSlipRec).b).toHaveLength(1);
    run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP, tables: [CRAPS_REF] });
    expect((foldOf(a).felts.get(a.pid)!.rec as CrapsSlipRec).b).toHaveLength(2);
  });

  it('this page\'s fling is noted on the state of the game played: the roll\'s fling is offered no more once it is made', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
    expect(a.table.computedFlungFor(TABLE, T0 + 100)).toBeNull();
    a.table.noteComputedFling(TABLE, 1, 1234, T0 + 100);
    expect(a.table.computedFlungFor(TABLE, T0 + 100)).toEqual({ r: 1, seed: 1234 });
  });

  it('a roll rewritten by the house\'s other reveal drops the change held back on the roll after it: the page says so once, and the count read is the game\'s', async () => {
    const { pages, a, b, later, at } = await splitRoll();
    const shown = crapsOf(a, at)!.resultAt + a.croupier.CRAPS_SHOW_MS;
    const open = run(pages, at + STEP, shown + 2_000, { step: STEP, tables: [CRAPS_REF] });
    sync(open, ...pages);
    for (const p of pages) expect(foldOf(p).open).toBe(2);
    const was = a.table.readMyComputedCrapsBets(TABLE, a.pid, 2, open).basis;
    // (the pass line down at once, then a field bet with it, held back with the coalescing)
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }], open)).toBe('ok');
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }, { type: 'field', amount: 5 }], open + 50)).toBe('ok');
    expect(a.table.computedUndoneCount(TABLE)).toBe(0);
    // (the house's other reveal, ranking before the first, rewrites the roll before: a six, the point on)
    house(a, later);
    sync(open + 100, ...pages);
    for (const p of pages) {
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'house', house: { hash: later.hash } });
      expect(carryOf(p).p).toBe(6);
    }
    expect(a.table.readMyComputedCrapsBets(TABLE, a.pid, 2, open + 100).basis).not.toBe(was);
    run([a, b], open + 150, open + 150 + 2 * STEP, { step: STEP, tables: [CRAPS_REF] });
    expect(a.table.computedUndoneCount(TABLE)).toBe(1);
    expect(b.table.computedUndoneCount(TABLE)).toBe(0);
    expect(a.table.computedRollChange(TABLE).seq).toBe(0); // (no roll after the one rewritten is decided: the roll before the last has not changed)
  });

  it('a roll rewritten by the house\'s other reveal once the roll after it is decided is a roll that changed: the page notes it, and the change read is the game\'s', async () => {
    const { pages, a, b, later, at } = await splitRoll();
    const shown = crapsOf(a, at)!.resultAt + a.croupier.CRAPS_SHOW_MS;
    const open = run(pages, at + STEP, shown + 2_000, { step: STEP, tables: [CRAPS_REF] });
    sync(open, ...pages);
    for (const p of pages) expect(crapsBet(p, [{ type: 'pass', amount: 10 }], open)).toBe('ok');
    sync(open, ...pages);
    const closedAt = run(pages, open + STEP, open + 60_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 2, TABLE).length > 0 });
    run(pages, closedAt + STEP, closedAt + 12_000, { step: STEP, tables: [CRAPS_REF] });
    house(b, kit.houseReveal(H, 2, [hashIn(keysIn(a, 'c', 2, TABLE)[0])], Object.values(closesOf(a, 2)[0].f).sort()));
    sync(closedAt + 12_000, ...pages);
    for (const p of pages) expect(foldOf(p).rounds[1]).toMatchObject({ decided: 'house' });
    expect(a.table.computedRollChange(TABLE)).toEqual({ seq: 0, round: 0, undid: null });
    // (the house's other reveal, ranking before the first, rewrites the roll before the last: a six, the point on)
    house(a, later);
    sync(closedAt + 12_100, ...pages);
    run([a, b], closedAt + 12_150, closedAt + 12_150 + 2 * STEP, { step: STEP, tables: [CRAPS_REF] });
    for (const p of pages) expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'house', house: { hash: later.hash } });
    expect(a.table.computedRollChange(TABLE)).toMatchObject({ seq: 1, round: 1 });
    expect(b.table.computedRollChange(TABLE)).toMatchObject({ seq: 1, round: 1 });
  });
});

describe('a FAIR ONLY craps game one place short of its player cap', () => {
  /** The pages after the house's trim of roll 1 (the opening carry), whose nets name `n` players who are not in the room. */
  async function trimmed(n: number): Promise<Page[]> {
    const pages = await gameRoom(['A', 'B']);
    const [a] = pages;
    const crowd = Array.from({ length: n }, (_, i) => `x${String(i).padStart(4, '0')}`);
    const nets = Object.fromEntries(crowd.map((pid, i) => [pid, i === 0 ? String(1 - crowd.length) : '1']));
    const cp = trimOf(Q, 'q', { b: SID, u: 1, l: hex('b', 32), n: nets, s: { p: 0, w: {} }, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(cp.key, cp.value);
      for (const key of [...top(a).keys()]) if (key.startsWith(`ses:${TABLE}:${Q.inc}:`)) top(a).delete(key);
      top(a).set(`ses:${TABLE}:${Q.inc}:${nextSid3(Q, cp.value)}`, new Y.Map());
    });
    sync(T0, ...pages);
    run(pages, T0 + STEP, T0 + 2_000, { step: STEP, tables: [CRAPS_REF] });
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, Q.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    return pages;
  }

  it('the two newcomers cannot both be frozen: the close freezes one, and it stands (it was invalid, wedging the roll, with both)', async () => {
    const pages = await trimmed(MAX_TABLE_PIDS - 1);
    const [a, b] = pages;
    const at = T0 + 2_000;
    for (const p of pages) expect(crapsBet(p, [{ type: 'pass', amount: 10 }], at)).toBe('ok');
    sync(at, ...pages);
    const done = run(pages, at + STEP, at + 60_000, { step: STEP, tables: [CRAPS_REF], until: () => keysIn(a, 'c', 2, TABLE).length > 0 });
    sync(done, ...pages);
    expect(keysIn(a, 'c', 2, TABLE)).toHaveLength(1);
    const [close] = closesOf(a, 2);
    expect(Object.keys(close.f)).toHaveLength(1);
    expect([a.pid, b.pid]).toContain(Object.keys(close.f)[0]);
    for (const p of pages) expect(foldOf(p).openCloses.map((x) => x.state)).toEqual(['valid']);
  });
});
