/**
 * 🔒🏁 The page that holds a FAIR ONLY game ends it (design §8.6, PR 6c-5b-1):
 * computedTable switchFairOnlyOff writes the end order, and with no round in
 * flight the ended checkpoint and the switch in the same write; mid-round the
 * end order alone, the end following once the round is decided (the house's,
 * or this page's FAIR_END_WAIT_MS on: fairEndDuty). Every refusal writes
 * nothing.
 *
 * Pages and the house as the opening's specs have them
 * (computedFairOnlyOpen.test.ts): the first page holds the room's deed and
 * opens the game the specs end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FAIR_ONLY_RV, faironlyInc, NO_CLOSE, readCk, sealCk, sealFin } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { asClose, nextSid3 } from './computedFold';
import type { CloseRec, FoldCtx } from './computedFold';
import { houseSign } from './computedHouse';
import {
  Beating, clockOf, CRAPS_REF, CRAPS_TABLE, keysIn, loadPage, openRoom, PAGE_ROOM, PAGE_TABLE as TABLE, putIn,
  run as runBare, sync, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testHouse, testIdentity } from './computedTestKit';
import type { Built } from './computedTestKit';
import type { HouseFold } from './nodeFingerprint';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
/** The house table the room opens with: a roulette name this build opens (`r`). */
const RINC = 'r' + '5a'.repeat(12);
const H = testHouse('owner-node');
/** What a node that runs FAIR ONLY games says of its fold. */
const FOLD: HouseFold = { letters: 'rdpq', rv: [FAIR_ONLY_RV] };
/** The 16 hex a spec gives the page for its game's name (its next fresh seed's first). */
const J = '0123456789abcdef';

let beat: Beating | null = null;
const run = (pages: Page[], from: number, to: number, opts: Parameters<typeof runBare>[3] = {}): number =>
  runBare(pages, from, to, { step: STEP, each: beat?.each, ...opts });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  beat = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const casinoOf = (p: Page) => p.doc.getMap<unknown>('casino');
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const recOf = <R>(p: Page, key: string): R => p.casino.computedSessionForWrite(TABLE)!.get(key) as R;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(recOf(p, k))!);
const frozenOf = (c: CloseRec): string[] => Object.values(c.f).sort();
const hashIn = (key: string): string => key.slice(key.lastIndexOf(':') + 1);
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]));
/** The keys of the room's computed map under a prefix, sorted. */
const keysUnder = (p: Page, prefix: string): string[] => [...top(p).keys()].filter((k) => k.startsWith(prefix)).sort();

/** The name page p's game takes when it opens one at T with the hex J. */
const nameOf = (p: Page, T: number, letter: 'p' | 'q' = 'p', t = TABLE, j = J): string =>
  faironlyInc(letter, PAGE_ROOM, t, { rv: FAIR_ONLY_RV, ok: p.pub, j, ts: T });

/** Page p presses FAIR ONLY at T, its game's name made with J. */
function press(p: Page, T: number, opts: { game?: 'roulette' | 'craps'; t?: string; again?: boolean; j?: string } = {}) {
  clockOf(p, T);
  p.seeds.length = 0;
  p.seeds.push((opts.j ?? J) + 'f'.repeat(48));
  const out = p.table.switchFairOnlyOn(opts.t ?? TABLE, opts.game ?? 'roulette', T, opts.again);
  p.seeds.length = 0;
  return out;
}

/** Pages for `names`, 1,000 chips each, synced at T0, no table switched on. */
async function ownerRunRoom(names: string[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  sync(T0, ...pages);
  return pages;
}

/** A room whose deed the first page holds, its house table switched on, its
 *  node's house key delegated and heard, and its node saying it runs FAIR ONLY
 *  games: all synced, every page awake, at the time returned. */
async function houseRoom(names: string[], opts: { inc?: string | null; t?: string } = {}): Promise<{ pages: Page[]; at: number }> {
  const inc = opts.inc === undefined ? RINC : opts.inc;
  // (No name: the table is owner-run, nothing switched on.)
  const pages = inc === null ? await ownerRunRoom(names) : await openRoom(names, T0, [], { t: opts.t ?? TABLE, inc });
  const [a] = pages;
  a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid));
  sync(T0, ...pages);
  a.table.setLocalHouse(H.pub);
  a.table.setLocalHouseFold(FOLD);
  const tables = opts.t === CRAPS_TABLE ? [CRAPS_REF] : undefined;
  // (The delegation goes out on the first frame; the house's beat after it is the one that counts.)
  run(pages, T0, T0, { each: undefined, tables });
  beat = new Beating(a, H);
  const at = T0 + 2 * STEP;
  run(pages, T0 + STEP, at, { tables });
  return { pages, at };
}

/** A round the house decides at the game the table plays now, its records
 *  made by `kit`: A bets red and B black, the house joins round `r` when it
 *  is a game's first, the round closes on its commitment, the seeds come in,
 *  the house reveals. The time its result's show has ended at, and the deltas. */
function houseRound(pages: Page[], kit: ComputedKit, r: number, T: number, first = true): { at: number; deltas: Map<string, bigint> } {
  const [a, b] = pages;
  if (first) house(a, kit.houseJoin(H, r));
  clockOf(a, T);
  expect(a.table.writeComputedSlip(TABLE, [red(10)], T)).toBe('ok');
  clockOf(b, T);
  expect(b.table.writeComputedSlip(TABLE, [black(20)], T)).toBe('ok');
  sync(T, ...pages);
  const closedAt = run(pages, T + STEP, T + 30_000, { until: () => keysIn(a, 'c', r).length > 0 });
  const [close] = closesOf(a, r);
  expect(close.h).toBe(kit.houseCommit(H, r));
  const seedsAt = run(pages, closedAt + STEP, closedAt + 12_000, { until: () => pages.every((p) => keysIn(p, 'x', r).length === 2) });
  house(b, kit.houseReveal(H, r, [hashIn(keysIn(a, 'c', r)[0])], frozenOf(close)));
  sync(seedsAt, ...pages);
  const v = foldOf(a).rounds.find((x) => x.r === r)!;
  expect(v).toMatchObject({ decided: 'house' });
  // (The result shows 9 s from the reveal; the table is quiet after.)
  const at = seedsAt + 10_000;
  run(pages, seedsAt + STEP, at);
  return { at, deltas: v.deltas };
}


const finOf = (p: Page, inc: string) => top(p).get(`fin:${TABLE}:${inc}`) as { v: 1; k: string; g: string } | undefined;
const cksOf = (p: Page, inc: string): CkRec[] => keysUnder(p, `ck:${TABLE}:${inc}:`).map((k) => (readCk(PAGE_ROOM, k, top(p).get(k)) as { ck: CkRec }).ck);
const endOf = (p: Page, inc: string): CkRec | undefined => cksOf(p, inc).find((c) => c.e === 1);
const off = (p: Page, T: number, opts: { game?: 'roulette' | 'craps'; t?: string; again?: boolean } = {}) => {
  clockOf(p, T);
  return p.table.switchFairOnlyOff(opts.t ?? TABLE, opts.game ?? 'roulette', T, opts.again);
};

/** A room whose first page opened a FAIR ONLY roulette game at T (returned
 *  with its name and a kit for its records), every page playing it. */
async function gameRoom(names: string[]): Promise<{ pages: Page[]; at: number; inc: string; kit: ComputedKit; ctx: FoldCtx }> {
  const { pages, at } = await houseRoom(names);
  const [a] = pages;
  expect(press(a, at)).toBe('ok');
  sync(at, ...pages);
  const inc = nameOf(a, at);
  const ctx: FoldCtx = { room: PAGE_ROOM, t: TABLE, inc };
  run(pages, at + STEP, at + 2 * STEP);
  return { pages, at: at + 3 * STEP, inc, kit: new ComputedKit(ctx), ctx };
}

describe('the page that holds a FAIR ONLY game ends it, no round in flight', () => {
  it('in one update: the end order, the ended checkpoint at the last decided round with the nets, and the switch', async () => {
    const { pages, at, inc, kit, ctx } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const played = houseRound(pages, kit, 1, at);
    const T = played.at;
    const root = cksOf(a, inc)[0];
    const nets = Object.fromEntries([...foldOf(a).nets].map(([pid, n]) => [pid, String(n)]));
    const v = foldOf(a).rounds.find((x) => x.r === 1)!;
    expect(a.casino.ownerRunChosen(TABLE)).toBe(false);
    let out: string | undefined;
    const sent = updatesOf(a, () => { out = off(a, T); });
    expect(out).toBe('ok');
    expect(sent).toHaveLength(1);
    const fin = finOf(a, inc)!;
    expect(fin).toEqual({ v: 1, k: a.pub, g: fin.g });
    const end = endOf(a, inc)!;
    expect(end).toEqual({
      v: 1, ok: a.pub, j: J, rv: FAIR_ONLY_RV, ts: root.ts, b: nextSid3(ctx, root), u: 1, l: v.close, d: `h:${v.house!.hash}`, o: v.pocket,
      n: nets, e: 1, f: fin, k: a.pub, g: end.g,
    });
    expect(cksOf(a, inc)).toHaveLength(2);
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    expect(casinoOf(a).has(`gone:${TABLE}:${inc}`)).toBe(false);
    // (The house chose owner-run play: its driving page does not switch the table on again by itself.)
    expect(a.casino.ownerRunChosen(TABLE)).toBe(true);
    // The session stays for the compaction; the game is over on every page, and its nets count on.
    expect(keysUnder(a, `ses:${TABLE}:${inc}:`)).toHaveLength(1);
    sync(T, ...pages);
    for (const p of pages) {
      expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false, pending: false, base: { ck: { e: 1, u: 1 } } });
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
      expect(p.casino.computedGamesHeldBy(TABLE, a.pub)).toEqual([]);
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
    // A second press finds no game: nothing written.
    const again = updatesOf(a, () => { out = off(a, T + STEP); });
    expect(out).toBe('ok');
    expect(again).toEqual([]);
    expect(b.casino.computedFoldOf(TABLE, inc)?.nets.size).toBe(2);
  });

  it('before any round: the end is at the root\'s round 0, closes the root\'s session, and holds no nets', async () => {
    const { pages, at, inc, ctx } = await gameRoom(['A', 'B']);
    const [a] = pages;
    const root = cksOf(a, inc)[0];
    expect(off(a, at)).toBe('ok');
    const fin = finOf(a, inc)!;
    const end = endOf(a, inc)!;
    expect(end).toEqual({ v: 1, ok: a.pub, j: J, rv: FAIR_ONLY_RV, ts: root.ts, b: nextSid3(ctx, root), u: 0, l: NO_CLOSE, n: {}, e: 1, f: fin, k: a.pub, g: end.g });
    sync(at, ...pages);
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false, base: { ck: { e: 1 } } });
  });

  it('felts on the open round stop holding: the chips are their players\' again', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    clockOf(b, at);
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    for (const p of pages) expect(p.casino.readChips(b.pid)).toBe(980);
    expect(off(a, at + STEP)).toBe('ok');
    sync(at + STEP, ...pages);
    for (const p of pages) {
      expect(p.casino.computedResolutionOf(TABLE, inc)?.live).toBe(false);
      expect(p.casino.readChips(b.pid)).toBe(1_000);
    }
  });
});

describe('a round in flight', () => {
  it("the press writes the end order alone ('ending'); no page closes again; the round decided, the holder's page writes the end FAIR_END_WAIT_MS on", async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    clockOf(b, at);
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    let out: string | undefined;
    const sent = updatesOf(a, () => { out = off(a, closedAt); });
    expect(out).toBe('ending');
    expect(sent).toHaveLength(1);
    expect(finOf(a, inc)).toMatchObject({ v: 1, k: a.pub });
    expect(endOf(a, inc)).toBeUndefined();
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc });
    // A second press while it waits: nothing more.
    const again = updatesOf(a, () => { out = off(a, closedAt + STEP); });
    expect(out).toBe('ending');
    expect(again).toEqual([]);
    sync(closedAt + STEP, ...pages);
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: true, fin: { k: a.pub } });
    // The round is decided by the house, as any; the end waits for it, and then FAIR_END_WAIT_MS.
    const seedsAt = run(pages, closedAt + 2 * STEP, closedAt + 12_000, { until: () => pages.every((p) => keysIn(p, 'x', 1).length === 2) });
    expect(endOf(a, inc)).toBeUndefined();
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close)));
    sync(seedsAt, ...pages);
    const deltas = foldOf(a).rounds.find((x) => x.r === 1)!.deltas;
    run(pages, seedsAt + STEP, seedsAt + a.table.FAIR_END_WAIT_MS - STEP);
    expect(endOf(a, inc)).toBeUndefined();
    run(pages, seedsAt + a.table.FAIR_END_WAIT_MS, seedsAt + a.table.FAIR_END_WAIT_MS + 3 * STEP);
    const end = endOf(a, inc)!;
    expect(end).toMatchObject({ e: 1, u: 1, k: a.pub, f: finOf(a, inc) });
    expect(cksOf(a, inc).filter((c) => c.e === 1)).toHaveLength(1);
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    for (const p of pages) {
      expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false });
      expect(keysIn(p, 'c', 2)).toEqual([]);
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(deltas.get(q.pid)));
    }
  });
});

/** Round 1 of a game closed on the house's commitment with A (red 10) and B
 *  (black 20) frozen (with `watching`, B and C: the holder only watches),
 *  the holder's press in ('ending') and heard, every seed in: what the
 *  house's reveal would list, and the time. */
async function endingRoom(watching = false): Promise<{ pages: Page[]; inc: string; kit: ComputedKit; ctx: FoldCtx; at: number; close: CloseRec; closeHash: string }> {
  const { pages, at, inc, kit, ctx } = await gameRoom(watching ? ['A', 'B', 'C'] : ['A', 'B']);
  const [a] = pages;
  const [x, y] = watching ? pages.slice(1) : pages;
  house(a, kit.houseJoin(H, 1));
  clockOf(x, at);
  expect(x.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
  clockOf(y, at);
  expect(y.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
  sync(at, ...pages);
  const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
  const [close] = closesOf(a, 1);
  expect(off(a, closedAt)).toBe('ending');
  const seedsAt = run(pages, closedAt + STEP, closedAt + 12_000, { until: () => pages.every((p) => keysIn(p, 'x', 1).length === 2) });
  expect(endOf(a, inc)).toBeUndefined();
  return { pages, inc, kit, ctx, at: seedsAt, close, closeHash: hashIn(keysIn(a, 'c', 1)[0]) };
}

describe("the end order standing, the round decided: the holder's wait", () => {
  it("the house's end comes first: the holder's page writes none, the switch stays naming the game, and the table plays none", async () => {
    const { pages, inc, kit, ctx, at, close, closeHash } = await endingRoom();
    const [a, b] = pages;
    // (The house heard the end order: its reveal carries no next commitment.)
    house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
    sync(at, ...pages);
    const v = foldOf(a).rounds.find((x) => x.r === 1)!;
    const root = cksOf(a, inc)[0];
    const { g: _g, ...body } = root;
    const theirs = sealCk(ctx, {
      ...body, b: nextSid3(ctx, root), u: 1, l: v.close, d: `h:${v.house!.hash}`, o: v.pocket!,
      n: Object.fromEntries([...foldOf(a).nets].map(([pid, n]) => [pid, String(n)])), e: 1, f: finOf(a, inc)!, k: H.pub,
    }, (bytes) => houseSign(H.secret, bytes));
    run(pages, at + STEP, at + 2_400);
    expect(endOf(a, inc)).toBeUndefined();
    // Its trim with no next session: the end in, the root and the session out.
    b.doc.transact(() => {
      for (const k of [...top(b).keys()]) if (k.startsWith(`ses:${TABLE}:${inc}:`) || k.startsWith(`ck:${TABLE}:${inc}:`)) top(b).delete(k);
      top(b).set(theirs.key, theirs.value);
    });
    run(pages, at + 2_600, at + 2_600 + a.table.FAIR_END_WAIT_MS + 30_000, { step: 1_000 });
    for (const p of pages) {
      expect(keysUnder(p, `ck:${TABLE}:${inc}:`)).toEqual([theirs.key]);
      expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false, pending: false, base: { key: theirs.key } });
      // (The switch is a hint: it names a game that is over, and the table reads as no computed table.)
      expect(casinoOf(p).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc });
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(v.deltas.get(q.pid)));
    }
  });

  it('a frame on a doc that holds part of an update starts the wait again', async () => {
    const { pages, inc, kit, at, close, closeHash } = await endingRoom();
    const [a, b] = pages;
    house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
    sync(at, ...pages);
    const WAIT = a.table.FAIR_END_WAIT_MS;
    run(pages, at + STEP, at + 3_000);
    // (The second of two updates alone: A's doc waits for the first.)
    const [first, second] = updatesOf(b, () => {
      b.doc.transact(() => b.doc.getMap('scratch').set('a', 1));
      b.doc.transact(() => b.doc.getMap('scratch').set('b', 2));
    });
    Y.applyUpdate(a.doc, second);
    run([a], at + 3_000 + STEP, at + 3_000 + 2 * STEP);
    Y.applyUpdate(a.doc, first);
    const whole = at + 3_000 + 3 * STEP;
    run([a], whole, whole + WAIT - STEP);
    expect(endOf(a, inc)).toBeUndefined();
    run([a], whole + WAIT, whole + WAIT + 2 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, k: a.pub });
  });

  it('the clock set back a little, to before the wait began, starts it again there: it ends FAIR_END_WAIT_MS on from that time, not from the first', async () => {
    const { pages, inc, kit, at, close, closeHash } = await endingRoom();
    const [a, b] = pages;
    house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
    sync(at, ...pages);
    const WAIT = a.table.FAIR_END_WAIT_MS;
    // The wait begins at the first frame that reads the round decided.
    run(pages, at + STEP, at + 2 * STEP);
    // 800 ms back from the last frame (under what a page reads as a lapse): before the wait's start by 600.
    const back = at - 2 * STEP;
    expect(at + 2 * STEP - back).toBeLessThan(a.croupier.TABLE_CLOCK_SLACK_MS);
    run([a], back, back + WAIT - STEP);
    expect(endOf(a, inc)).toBeUndefined();
    run([a], back + WAIT, back + WAIT + STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, k: a.pub });
    // (From the first start it would have come no sooner than this.)
    expect(back + WAIT + STEP).toBeLessThan(at + STEP + WAIT);
  });

  for (const who of ['the closer', 'another bettor'] as const) {
    it(`${who} deletes their frozen slip on seeing the result: no press and no wait ends the game without the round; back, the end counts their bet`, async () => {
      const { pages, inc, kit, at, close, closeHash } = await endingRoom();
      const [a, b] = pages;
      house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
      sync(at, ...pages);
      const deltas = foldOf(a).rounds.find((x) => x.r === 1)!.deltas;
      const closer = pages.find((p) => p.pub === close.k)!;
      const cheat = who === 'the closer' ? closer : pages.find((p) => p !== closer)!;
      expect(deltas.get(cheat.pid)).not.toBe(0n);
      const slip = keysIn(a, 's', 1).find((k) => k.startsWith(`s:1:${cheat.pid}:`) && frozenOf(close).includes(hashIn(k)))!;
      expect(slip).toBeDefined();
      const WAIT = a.table.FAIR_END_WAIT_MS;
      // (The pages show the result: each has seen the round decided.)
      run(pages, at + STEP, at + 2 * STEP);
      // The slip gone from the holder's doc: the closer's takes the round off the chain, another's takes them out of its count.
      a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(slip));
      const R = foldOf(a).rounds.find((x) => x.r === 1);
      if (who === 'the closer') expect(R).toBeUndefined();
      else expect(R).toMatchObject({ decided: 'house', missing: [cheat.pid] });
      expect(foldOf(a).tip).toBeNull();
      let out: string | undefined;
      const sent = updatesOf(a, () => { out = off(a, at + 2 * STEP); });
      expect(out).toBe('ending');
      expect(sent).toEqual([]);
      // Deleted again on every page each frame, whoever puts it back, for three waits: no end.
      let deleted = 0;
      const gone = (T: number): void => {
        beat?.each(T);
        for (const p of pages) {
          const ses = p.casino.computedSessionForWrite(TABLE);
          if (ses?.has(slip)) {
            p.doc.transact(() => ses.delete(slip));
            deleted += 1;
          }
        }
      };
      run(pages, at + 3 * STEP, at + 3 * WAIT, { each: gone });
      expect(deleted).toBeGreaterThan(2);
      expect(endOf(a, inc)).toBeUndefined();
      // Left alone it is put back, and the end follows a wait after: their loss or win in it.
      const backAt = run(pages, at + 3 * WAIT + STEP, at + 3 * WAIT + 20_000, { until: () => foldOf(a).rounds.some((x) => x.r === 1 && x.decided && x.missing.length === 0) });
      expect(backAt).toBeLessThan(at + 3 * WAIT + 20_000);
      run(pages, backAt + STEP, backAt + WAIT - 2 * STEP);
      expect(endOf(a, inc)).toBeUndefined();
      run(pages, backAt + WAIT - STEP, backAt + WAIT + 3 * STEP);
      const end = endOf(a, inc)!;
      expect(end).toMatchObject({ u: 1, l: closeHash });
      expect(end.n[cheat.pid]).toBe(String(deltas.get(cheat.pid)));
      for (const p of pages) for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(deltas.get(q.pid)));
    });
  }

  for (const who of ['the closer', 'another bettor'] as const) {
    it(`a holder who only watched the round, ${who}'s slip never back: the end waits MISSING_WAIT_MS for it, as a trim does, and no longer (nobody is left who can put it back)`, async () => {
      const { pages, inc, kit, at, close, closeHash } = await endingRoom(true);
      const [a, b] = pages;
      house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
      sync(at, ...pages);
      const closer = pages.find((p) => p.pub === close.k)!;
      const cheat = who === 'the closer' ? closer : pages.slice(1).find((p) => p !== closer)!;
      const slip = keysIn(a, 's', 1).find((k) => k.startsWith(`s:1:${cheat.pid}:`) && frozenOf(close).includes(hashIn(k)))!;
      expect(slip).toBeDefined();
      run(pages, at + STEP, at + 2 * STEP);
      expect(foldOf(a).rounds.find((x) => x.r === 1)).toMatchObject({ decided: 'house' });
      const other = pages.slice(1).find((p) => p !== cheat)!;
      const gone = (T: number): void => {
        beat?.each(T);
        for (const p of pages) {
          const ses = p.casino.computedSessionForWrite(TABLE);
          if (ses?.has(slip)) p.doc.transact(() => ses.delete(slip));
        }
      };
      const MISSING = a.table.MISSING_WAIT_MS;
      const from = at + 3 * STEP;
      run(pages, from, from + MISSING - STEP, { each: gone });
      expect(endOf(a, inc)).toBeUndefined();
      // (As the holder's page reads the game without the slip: with another's gone the round stands without
      // them, its pocket drawn from the seeds left, so the bettor left may win what they had lost.)
      a.doc.transact(() => {
        const ses = a.casino.computedSessionForWrite(TABLE)!;
        if (ses.has(slip)) ses.delete(slip);
      });
      const short = foldOf(a);
      const nets = Object.fromEntries([...short.nets].map(([pid, n]) => [pid, String(n)]));
      run(pages, from + MISSING, from + MISSING + a.table.FAIR_END_WAIT_MS + 4 * STEP, { each: gone });
      // The closer's gone, the round is void; another's, the round stands without them.
      if (who === 'the closer') {
        expect(endOf(a, inc)).toMatchObject({ e: 1, u: 0, n: {} });
      } else {
        expect(short.rounds.find((x) => x.r === 1)).toMatchObject({ decided: 'house', missing: [cheat.pid] });
        expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1 });
        expect(endOf(a, inc)!.n).toEqual(nets);
        expect(Object.keys(nets)).toEqual([other.pid]);
      }
    });
  }

  it("the holder's page loaded again, the game not served since: a press notes the missing slip from its first look and ends MISSING_WAIT_MS on, not never", async () => {
    const { pages, inc, kit, at, close, closeHash } = await endingRoom(true);
    const [a, b] = pages;
    house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
    sync(at, ...pages);
    const closer = pages.find((p) => p.pub === close.k)!;
    const cheat = pages.slice(1).find((p) => p !== closer)!;
    const slip = keysIn(a, 's', 1).find((k) => k.startsWith(`s:1:${cheat.pid}:`) && frozenOf(close).includes(hashIn(k)))!;
    expect(slip).toBeDefined();
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(slip));
    // The holder's device loads the page again: its key, the room's doc, and no state of the game.
    const again = await loadPage('A', 9, { reloadOf: a });
    sync(at, a, again);
    expect(again.casino.computedFoldOf(TABLE, inc)!.rounds.find((x) => x.r === 1)).toMatchObject({ decided: 'house', missing: [cheat.pid] });
    const MISSING = again.table.MISSING_WAIT_MS;
    // (Presses only, no frame of the table: nothing else has looked at the game on this load.)
    const said: string[] = [];
    for (let T = at + STEP; T < at + MISSING; T += STEP) said.push(off(again, T));
    expect(new Set(said)).toEqual(new Set(['ending']));
    expect(endOf(again, inc)).toBeUndefined();
    expect(off(again, at + STEP + MISSING)).toBe('ok');
    expect(endOf(again, inc)).toMatchObject({ e: 1, u: 1 });
  });

  it("the holder's page loaded again: the missing slip back while the round is in flight again, then gone again half a minute on, a press waits MISSING_WAIT_MS afresh", async () => {
    const { pages, inc, kit, at, close, closeHash } = await endingRoom(true);
    const [a, b] = pages;
    house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }));
    sync(at, ...pages);
    const closer = pages.find((p) => p.pub === close.k)!;
    const cheat = pages.slice(1).find((p) => p !== closer)!;
    const slip = keysIn(a, 's', 1).find((k) => k.startsWith(`s:1:${cheat.pid}:`) && frozenOf(close).includes(hashIn(k)))!;
    const [reveal] = keysIn(a, 'h', 1);
    const [slipRec, revealRec] = [recOf<unknown>(a, slip), recOf<unknown>(a, reveal)];
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(slip));
    const again = await loadPage('A', 9, { reloadOf: a });
    sync(at, a, again);
    const ses = () => again.casino.computedSessionForWrite(TABLE)!;
    const round = () => again.casino.computedFoldOf(TABLE, inc)!.rounds.find((x) => x.r === 1);
    expect(off(again, at + STEP)).toBe('ending');
    // The slip back, and the house's reveal gone: the round is in flight again.
    again.doc.transact(() => {
      ses().set(slip, slipRec);
      ses().delete(reveal);
    });
    expect(again.casino.computedFoldOf(TABLE, inc)!.tip).toMatchObject({ r: 1 });
    expect(off(again, at + 2_000)).toBe('ending');
    // The reveal back and the slip gone again, the first wait run out.
    again.doc.transact(() => {
      ses().set(reveal, revealRec);
      ses().delete(slip);
    });
    expect(round()).toMatchObject({ decided: 'house', missing: [cheat.pid] });
    const MISSING = again.table.MISSING_WAIT_MS;
    const from = at + STEP + MISSING + STEP;
    const said: string[] = [];
    for (let T = from; T < from + MISSING; T += STEP) said.push(off(again, T));
    expect(new Set(said)).toEqual(new Set(['ending']));
    expect(endOf(again, inc)).toBeUndefined();
    expect(off(again, from + MISSING)).toBe('ok');
    expect(endOf(again, inc)).toMatchObject({ e: 1, u: 1 });
  });

  it("the closer takes their frozen slip away and lays another close of the round in, voided by their own abandon: the round reads decided, but not as the house decided it, and no press and no wait ends the game on it for MISSING_WAIT_MS; the slip back, the end is at the house's round", async () => {
    const { pages, at, inc, kit, ctx } = await gameRoom(['A']);
    const [a] = pages;
    const [X, Y] = [testIdentity('xena'), testIdentity('yuri')];
    a.doc.transact(() => {
      for (const id of [X, Y]) a.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
    });
    for (const id of [X, Y]) a.casino.buyInChips(id.pid, 100);
    const sid = nextSid3(ctx, cksOf(a, inc)[0]);
    const [x1, y1] = [kit.slip(X, 1, [red(10)]), kit.slip(Y, 1, [black(20)])];
    const join = kit.houseJoin(H, 1);
    const c1 = kit.close(X, 1, sid, [x1, y1], join.rec.c);
    house(a, join, x1, y1, c1, kit.reveal(1, X.pid), kit.reveal(1, Y.pid), kit.houseReveal(H, 1, [c1.hash], [x1.hash, y1.hash]));
    run(pages, at, at + 4 * STEP);
    expect(foldOf(a).rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', close: c1.hash });
    // The swap.
    const x2 = kit.slip(X, 1, [red(1)]);
    const c2 = kit.close(X, 1, sid, [x2], join.rec.c);
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(x1.key));
    house(a, x2, c2, kit.abandon(X, 1, c2.hash));
    expect(foldOf(a).rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'void', close: c2.hash });
    const T = at + 5 * STEP;
    expect(off(a, T)).toBe('ending');
    const MISSING = a.table.MISSING_WAIT_MS;
    run(pages, T + STEP, T + MISSING - 2 * STEP);
    expect(off(a, T + MISSING - STEP)).toBe('ending');
    expect(endOf(a, inc)).toBeUndefined();
    // The slip back (a witness's put-back): the house's round stands, and the end counts it.
    house(a, x1);
    const back = T + MISSING;
    run(pages, back, back + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: c1.hash });
    expect(Object.keys(endOf(a, inc)!.n).sort()).toEqual([X.pid, Y.pid].sort());
  });

  /** The holder's page alone, watching: xena and yuri (no pages) to bet, the house's join of round 1 in. */
  async function watched() {
    const { pages, at, inc, kit, ctx } = await gameRoom(['A']);
    const [a] = pages;
    const [X, Y] = [testIdentity('xena'), testIdentity('yuri')];
    a.doc.transact(() => {
      for (const id of [X, Y]) a.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
    });
    for (const id of [X, Y]) a.casino.buyInChips(id.pid, 100);
    const sid = nextSid3(ctx, cksOf(a, inc)[0]);
    const join = kit.houseJoin(H, 1);
    house(a, join);
    const round = () => foldOf(a).rounds.find((v) => v.r === 1);
    return { pages, a, at, inc, kit, X, Y, sid, join, round };
  }

  it('…and the slip never back: the end waits MISSING_WAIT_MS and no longer, and is at the round as it reads then', async () => {
    const { pages, a, at, inc, kit, X, Y, sid, join } = await watched();
    const [x1, y1] = [kit.slip(X, 1, [red(10)]), kit.slip(Y, 1, [black(20)])];
    const c1 = kit.close(X, 1, sid, [x1, y1], join.rec.c);
    house(a, x1, y1, c1, kit.reveal(1, X.pid), kit.reveal(1, Y.pid), kit.houseReveal(H, 1, [c1.hash], [x1.hash, y1.hash]));
    run(pages, at, at + 4 * STEP);
    const x2 = kit.slip(X, 1, [red(1)]);
    const c2 = kit.close(X, 1, sid, [x2], join.rec.c);
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(x1.key));
    house(a, x2, c2, kit.abandon(X, 1, c2.hash));
    const T = at + 5 * STEP;
    expect(off(a, T)).toBe('ending');
    const MISSING = a.table.MISSING_WAIT_MS;
    run(pages, T + STEP, T + MISSING - STEP);
    expect(endOf(a, inc)).toBeUndefined();
    run(pages, T + MISSING, T + MISSING + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: c2.hash });
  });

  it('the swap, then the round in flight again, then the swap again half a minute on: the end waits MISSING_WAIT_MS afresh for it', async () => {
    const { pages, a, at, inc, kit, X, Y, sid, join, round } = await watched();
    const [x1, y1] = [kit.slip(X, 1, [red(10)]), kit.slip(Y, 1, [black(20)])];
    const c1 = kit.close(X, 1, sid, [x1, y1], join.rec.c);
    house(a, x1, y1, c1, kit.reveal(1, X.pid), kit.reveal(1, Y.pid), kit.houseReveal(H, 1, [c1.hash], [x1.hash, y1.hash]));
    run(pages, at, at + 4 * STEP);
    const x2 = kit.slip(X, 1, [red(1)]);
    const c2 = kit.close(X, 1, sid, [x2], join.rec.c);
    const z = kit.abandon(X, 1, c2.hash);
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(x1.key));
    house(a, x2, c2, z);
    const T = at + 5 * STEP;
    expect(off(a, T)).toBe('ending');
    // The abandon gone: the round is in flight under the other close.
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(z.key));
    expect(round()?.decided ?? null).toBeNull();
    expect(off(a, T + 2_000)).toBe('ending');
    const MISSING = a.table.MISSING_WAIT_MS;
    run(pages, T + 2_000 + STEP, T + MISSING);
    // Back, the first wait run out.
    house(a, z);
    expect(round()).toMatchObject({ decided: 'void', close: c2.hash });
    run(pages, T + MISSING + STEP, T + MISSING + 28_000);
    expect(endOf(a, inc)).toBeUndefined();
    run(pages, T + MISSING + 28_000 + STEP, T + 2 * MISSING + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: c2.hash });
  });

  it("one bettor's slip back as another's goes, the first wait all but run out: the end waits MISSING_WAIT_MS of its own for the second", async () => {
    const { pages, a, at, inc, kit, X, Y, sid, join, round } = await watched();
    const Z = testIdentity('zoe');
    a.doc.transact(() => a.doc.getMap('players').set(Z.pid, { keyB64: Z.pub, name: Z.pid }));
    a.casino.buyInChips(Z.pid, 100);
    const [x1, y1, z1] = [kit.slip(X, 1, [red(10)]), kit.slip(Y, 1, [black(20)]), kit.slip(Z, 1, [red(5)])];
    const c1 = kit.close(X, 1, sid, [x1, y1, z1], join.rec.c);
    house(a, x1, y1, z1, c1, kit.reveal(1, X.pid), kit.reveal(1, Y.pid), kit.reveal(1, Z.pid), kit.houseReveal(H, 1, [c1.hash], [x1.hash, y1.hash, z1.hash], { c: null }));
    run(pages, at, at + 4 * STEP);
    expect(round()).toMatchObject({ decided: 'house', missing: [] });
    const ses = () => a.casino.computedSessionForWrite(TABLE)!;
    a.doc.transact(() => ses().delete(y1.key));
    const T = at + 5 * STEP;
    expect(off(a, T)).toBe('ending');
    run(pages, T + STEP, T + 29_000);
    a.doc.transact(() => {
      ses().set(y1.key, y1.rec);
      ses().delete(z1.key);
    });
    expect(round()).toMatchObject({ decided: 'house', missing: [Z.pid] });
    run(pages, T + 29_000 + STEP, T + 29_000 + 28_000);
    expect(endOf(a, inc)).toBeUndefined();
    run(pages, T + 57_000 + STEP, T + 57_000 + 3_000 + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: c1.hash });
    expect(Object.keys(endOf(a, inc)!.n).sort()).toEqual([X.pid, Y.pid].sort());
  });

  it("a slip back in the update that takes away a record of another round this page showed, then gone again as that record returns, the first wait run out: the end waits MISSING_WAIT_MS afresh", async () => {
    const { pages, at: t0, inc, kit } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    // Round 1 the pages play (the holder keeps copies of what it rests on); round 2 two others play, the holder watching.
    const { at } = houseRound(pages, kit, 1, t0);
    const c1 = hashIn(keysIn(a, 'c', 1)[0]);
    const [X, Y] = [testIdentity('xena'), testIdentity('yuri')];
    a.doc.transact(() => {
      for (const id of [X, Y]) a.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
    });
    for (const id of [X, Y]) a.casino.buyInChips(id.pid, 100);
    const [x2, y2] = [kit.slip(X, 2, [red(10)]), kit.slip(Y, 2, [black(20)])];
    const c2 = kit.close(X, 2, c1, [x2, y2], kit.houseCommit(H, 2));
    house(a, x2, y2, c2, kit.reveal(2, X.pid), kit.reveal(2, Y.pid), kit.houseReveal(H, 2, [c2.hash], [x2.hash, y2.hash], { c: null }));
    run(pages, at + STEP, at + 4 * STEP);
    const round = (r: number) => foldOf(a).rounds.find((v) => v.r === r);
    expect(round(2)).toMatchObject({ decided: 'house', missing: [] });
    // (The other page's, which this one puts back in a witness's turn, STAGGER_MS on at the soonest: the round
    // stands without that bettor, or is off the chain with round 2 where they closed it.)
    const held = keysIn(a, 's', 1).find((k) => k.startsWith(`s:1:${b.pid}:`))!;
    const heldRec = recOf<unknown>(a, held);
    const ses = () => a.casino.computedSessionForWrite(TABLE)!;
    a.doc.transact(() => ses().delete(y2.key));
    const T = at + 5 * STEP;
    expect(off(a, T)).toBe('ending');
    run([a], T + STEP, T + 29_000);
    expect(endOf(a, inc)).toBeUndefined();
    // Round 2's slip back in the same update that takes a slip of round 1 away, which this page holds a copy of
    // (it puts that back in its turn)…
    a.doc.transact(() => {
      ses().set(y2.key, y2.rec);
      ses().delete(held);
    });
    run([a], T + 29_000 + STEP, T + 29_000 + 3 * STEP);
    expect(ses().has(held)).toBe(false);
    // …and before it does, round 1's back and round 2's gone again: this page never read the session whole.
    a.doc.transact(() => {
      ses().set(held, heldRec);
      ses().delete(y2.key);
    });
    expect(round(1)).toMatchObject({ decided: 'house', missing: [] });
    expect(round(2)).toMatchObject({ decided: 'house', missing: [Y.pid] });
    const MISSING = a.table.MISSING_WAIT_MS;
    const from = T + 29_000 + 4 * STEP;
    run([a], from, from + MISSING - 2 * STEP);
    expect(endOf(a, inc)).toBeUndefined();
    run([a], from + MISSING - STEP, from + MISSING + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 2, l: c2.hash });
    expect(Object.keys(endOf(a, inc)!.n)).not.toContain(Y.pid);
  });

  it('a slip back and gone again while the doc holds part of an update, the first wait all but run out: the end waits MISSING_WAIT_MS afresh', async () => {
    const { pages, a, at, inc, kit, X, Y: yuri, sid, join, round } = await watched();
    const [x1, y1] = [kit.slip(X, 1, [red(10)]), kit.slip(yuri, 1, [black(20)])];
    const c1 = kit.close(X, 1, sid, [x1, y1], join.rec.c);
    house(a, x1, y1, c1, kit.reveal(1, X.pid), kit.reveal(1, yuri.pid), kit.houseReveal(H, 1, [c1.hash], [x1.hash, y1.hash], { c: null }));
    run(pages, at, at + 4 * STEP);
    const ses = () => a.casino.computedSessionForWrite(TABLE)!;
    a.doc.transact(() => ses().delete(y1.key));
    const T = at + 5 * STEP;
    expect(off(a, T)).toBe('ending');
    run(pages, T + STEP, T + 29_000);
    expect(endOf(a, inc)).toBeUndefined();
    // (The second of two updates alone: the doc waits for the first.)
    const other = new Y.Doc();
    const ups: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => ups.push(u));
    other.transact(() => other.getMap('scratch').set('a', 1));
    other.transact(() => other.getMap('scratch').set('b', 2));
    Y.applyUpdate(a.doc, ups[1]);
    a.doc.transact(() => ses().set(y1.key, y1.rec));
    run(pages, T + 29_000 + STEP, T + 29_000 + 3 * STEP);
    a.doc.transact(() => ses().delete(y1.key));
    Y.applyUpdate(a.doc, ups[0]);
    expect(round()).toMatchObject({ decided: 'house', missing: [yuri.pid] });
    const MISSING = a.table.MISSING_WAIT_MS;
    const from = T + 29_000 + 4 * STEP;
    run(pages, from, from + MISSING - 2 * STEP);
    expect(endOf(a, inc)).toBeUndefined();
    run(pages, from + MISSING - STEP, from + MISSING + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: c1.hash });
    expect(Object.keys(endOf(a, inc)!.n)).toEqual([X.pid]);
  });

  it("the house's reveal lists two closes of the round: the closer of the one that decided it takes their slip away, and the other decides it, by the house too; the end waits all the same", async () => {
    const { pages, a, at, inc, kit, X, Y, sid, join, round } = await watched();
    const [x1, y1] = [kit.slip(X, 1, [red(10)]), kit.slip(Y, 1, [black(20)])];
    const cx = kit.close(X, 1, sid, [x1], join.rec.c);
    const cy = kit.close(Y, 1, sid, [y1], join.rec.c);
    house(a, x1, y1, cx, cy, kit.reveal(1, X.pid), kit.reveal(1, Y.pid), kit.houseReveal(H, 1, [cx.hash, cy.hash], [x1.hash, y1.hash]));
    run(pages, at, at + 4 * STEP);
    const first = round()!;
    expect(first).toMatchObject({ decided: 'house' });
    const [mine, other] = first.close === cx.hash ? [x1, cy] : [y1, cx];
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(mine.key));
    expect(round()).toMatchObject({ decided: 'house', close: other.hash });
    // (Frames in between: the page has seen the other close decide the round.)
    run(pages, at + 5 * STEP, at + 8 * STEP);
    const T = at + 9 * STEP;
    expect(off(a, T)).toBe('ending');
    run(pages, T + STEP, T + 20_000);
    expect(endOf(a, inc)).toBeUndefined();
    house(a, mine);
    run(pages, T + 20_000 + STEP, T + 20_000 + a.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: first.close });
  });

  it("a round first read void by its closer's abandon, then decided by the house's reveal of another close: nothing of the house's was swapped, and the press ends at once", async () => {
    const { pages, a, at, inc, kit, X, Y, sid, join, round } = await watched();
    const [x1, y1] = [kit.slip(X, 1, [red(10)]), kit.slip(Y, 1, [black(20)])];
    const cx = kit.close(X, 1, sid, [x1], join.rec.c);
    house(a, x1, y1, cx, kit.abandon(X, 1, cx.hash));
    run(pages, at, at + 4 * STEP);
    expect(round()).toMatchObject({ decided: 'void', close: cx.hash });
    const cy = kit.close(Y, 1, sid, [y1], join.rec.c);
    house(a, cy, kit.reveal(1, Y.pid), kit.houseReveal(H, 1, [cy.hash], [y1.hash], { c: null }));
    run(pages, at + 5 * STEP, at + 8 * STEP);
    expect(round()).toMatchObject({ decided: 'house', close: cy.hash });
    expect(off(a, at + 9 * STEP)).toBe('ok');
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, l: cy.hash });
  });

  it("a close of the next round that names the house's standing commitment, in from a page that had not heard the end order, starts the wait again; voided, the end follows", async () => {
    const { pages, inc, kit, at, close, closeHash } = await endingRoom();
    const [a, b] = pages;
    // (A house that had not heard the order either: its reveal carries round 2's commitment.)
    house(b, kit.houseReveal(H, 1, [closeHash], frozenOf(close)));
    sync(at, ...pages);
    const WAIT = a.table.FAIR_END_WAIT_MS;
    run([a], at + STEP, at + WAIT - 3 * STEP);
    expect(endOf(a, inc)).toBeUndefined();
    // Round 2's close, as the page of a bettor who plays on would make it.
    const idB = { pid: b.pid, pub: b.pub, sign: b.keypair.signIdentity };
    const s2 = kit.slip(idB, 2, [black(5)]);
    const c2 = kit.close(idB, 2, closeHash, [s2], kit.houseCommit(H, 2));
    putIn(a, [[s2.key, s2.rec], [c2.key, c2.rec]]);
    run([a], at + WAIT - 2 * STEP, at + WAIT + 4 * STEP);
    expect(foldOf(a).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(endOf(a, inc)).toBeUndefined();
    // The house steps down (it has heard the order now), the bettor abandons: round 2 is void, and the wait runs from there.
    const z = kit.abandon(idB, 2, c2.hash);
    const T2 = at + WAIT + 5 * STEP;
    putIn(a, [[z.key, z.rec]]);
    run([a], T2, T2 + WAIT - 2 * STEP);
    expect(foldOf(a).rounds.find((x) => x.r === 2)).toMatchObject({ decided: 'void' });
    expect(endOf(a, inc)).toBeUndefined();
    run([a], T2 + WAIT - STEP, T2 + WAIT + 3 * STEP);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 2, l: c2.hash, d: `z:${z.hash}` });
    expect(endOf(a, inc)!.o).toBeUndefined();
  });
});

// ── 6c-5b-2: the table taken out of the room ─────────────────────────────────

const layoutOf = (p: Page) => p.doc.getMap<unknown>('furniture');
/** The table as the room's layout holds it (furnitureDoc FurnitureRecord). */
const PLACED = { kind: 'roulette-table', x: 2, z: -3, rot: 1, movable: true };
/** Page p takes the table out of the room at T as the editor does: the teardown first (World
 *  removeFurnitureVisuals: croupier closeTable, 'local'), the layout's record after. The updates it sent. */
function removeAt(p: Page, T: number): Uint8Array[] {
  clockOf(p, T);
  vi.setSystemTime(T + p.skew);
  return updatesOf(p, () => {
    p.croupier.closeTable(TABLE, 'local');
    p.doc.transact(() => { layoutOf(p).delete(TABLE); });
  });
}
/** A game room with the table in the layout, seen there by every page. */
async function placedRoom(names: string[]) {
  const room = await gameRoom(names);
  const [a] = room.pages;
  a.doc.transact(() => { layoutOf(a).set(TABLE, PLACED); });
  sync(room.at, ...room.pages);
  run(room.pages, room.at + STEP, room.at + 3 * STEP);
  return { ...room, at: room.at + 4 * STEP };
}

describe('the page that holds a FAIR ONLY game takes its table out of the room', () => {
  it('quiet: the end order and the ended checkpoint go in the teardown\'s own update, the game is over on every page with its nets, and nobody puts the table back', async () => {
    const { pages, at, inc, kit } = await placedRoom(['A', 'B']);
    const [a, b] = pages;
    const played = houseRound(pages, kit, 1, at);
    const sent = removeAt(a, played.at);
    expect(sent).toHaveLength(2);
    const before = new Y.Doc();
    Y.applyUpdate(before, Y.encodeStateAsUpdate(b.doc));
    Y.applyUpdate(before, sent[0]);
    // (The first update alone: the order, the end, and the table's keys gone, the layout's record still in.)
    expect(before.getMap('casinoComputed').has(`fin:${TABLE}:${inc}`)).toBe(true);
    expect(before.getMap('furniture').has(TABLE)).toBe(true);
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, k: a.pub });
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    // (The end comes first in the teardown: what a press leaves for a table that stays, the choice of owner-run
    // play, goes with the table's other settings.)
    expect(casinoOf(a).has(`cfg:ownerrun:${TABLE}`)).toBe(false);
    sync(played.at, ...pages);
    // (Longer than the pages wait to put a table back: the spec below.)
    run(pages, played.at + STEP, played.at + 150_000);
    for (const p of pages) {
      expect(layoutOf(p).has(TABLE)).toBe(false);
      expect(casinoOf(p).has(`cfg:computed:${TABLE}`)).toBe(false);
      expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false, base: { ck: { e: 1, u: 1 } } });
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
  });

  it('with a round in flight: the end order alone goes with the table, the round is decided with the table out, and the end follows; nobody puts the table back', async () => {
    const { pages, at, inc, kit } = await placedRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    clockOf(b, at);
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    removeAt(a, closedAt);
    expect(finOf(a, inc)).toMatchObject({ k: a.pub });
    expect(endOf(a, inc)).toBeUndefined();
    sync(closedAt, ...pages);
    const seedsAt = run(pages, closedAt + STEP, closedAt + 12_000, { until: () => pages.every((p) => keysIn(p, 'x', 1).length === 2) });
    expect(seedsAt).toBeLessThan(closedAt + 12_000);
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close), { c: null }));
    sync(seedsAt, ...pages);
    const deltas = foldOf(a).rounds.find((x) => x.r === 1)!.deltas;
    run(pages, seedsAt + STEP, seedsAt + 150_000);
    for (const p of pages) {
      expect(layoutOf(p).has(TABLE)).toBe(false);
      expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false, base: { ck: { e: 1, u: 1 } } });
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(deltas.get(q.pid)));
    }
  });

  it('a page that does not hold the game takes the table out: no end order, and the pages put the table back with the game on', async () => {
    const { pages, at, inc } = await placedRoom(['A', 'B']);
    const [a, b] = pages;
    removeAt(b, at);
    expect(finOf(b, inc)).toBeUndefined();
    sync(at, ...pages);
    const backAt = run(pages, at + STEP, at + 120_000, { until: () => pages.every((p) => layoutOf(p).has(TABLE)) });
    expect(backAt).toBeLessThan(at + 120_000);
    for (const p of pages) {
      expect(finOf(p, inc)).toBeUndefined();
      expect(layoutOf(p).get(TABLE)).toEqual(PLACED);
      expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: true });
      expect(p.casino.isComputedTable(TABLE)).toBe(true);
    }
    expect(a.casino.computedGamesHeldBy(TABLE, a.pub)).toEqual([inc]);
  });

  it('its page just woken (the press would say asleep): the removal writes no end order, and the table goes back with the game on', async () => {
    const { pages, at, inc } = await placedRoom(['A', 'B']);
    const [a] = pages;
    // (No frame for a minute: the page's clock jumped.)
    const T = at + 60_000;
    removeAt(a, T);
    expect(finOf(a, inc)).toBeUndefined();
    const backAt = run([a], T + STEP, T + 180_000, { until: () => layoutOf(a).has(TABLE) });
    expect(backAt).toBeLessThan(T + 180_000);
    expect(finOf(a, inc)).toBeUndefined();
    expect(a.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: true });
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
  });

  it('on a doc that holds part of an update the teardown waits, and the end order goes with it once the rest is in', async () => {
    const { pages, at, inc } = await placedRoom(['A', 'B']);
    const [a, b] = pages;
    const [first, second] = updatesOf(b, () => {
      b.doc.transact(() => b.doc.getMap('scratch').set('a', 1));
      b.doc.transact(() => b.doc.getMap('scratch').set('b', 2));
    });
    Y.applyUpdate(a.doc, second);
    const sent = removeAt(a, at);
    // (Only the layout's record: the teardown, and the end with it, wait for the doc to be whole.)
    expect(sent).toHaveLength(1);
    expect(finOf(a, inc)).toBeUndefined();
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(true);
    Y.applyUpdate(a.doc, first);
    // (What waited for the whole doc runs in a microtask after the update's transaction: casinoDoc whenCasinoWhole.)
    await Promise.resolve();
    expect(finOf(a, inc)).toMatchObject({ k: a.pub });
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 0 });
    expect(casinoOf(a).has(`cfg:computed:${TABLE}`)).toBe(false);
    expect(layoutOf(a).has(TABLE)).toBe(false);
  });

  it('a removal the holder\'s page hears, not its own, ends nothing', async () => {
    const { pages, at, inc } = await placedRoom(['A', 'B']);
    const [a] = pages;
    clockOf(a, at);
    const sent = updatesOf(a, () => a.croupier.closeTable(TABLE, 'heard'));
    expect(finOf(a, inc)).toBeUndefined();
    expect(sent.length).toBeLessThanOrEqual(1);
  });
});

// ── 6c-5b-2: the way back (design §8.7 "Moving back") ────────────────────────

describe('after the end of a FAIR ONLY game the table is the owner\'s again', () => {
  /** The house's end of the game, at round 1 as page a folds it, as its N6 writes it: the end in, the root and the
   *  session out. */
  function houseEnds(a: Page, b: Page, inc: string, ctx: FoldCtx): void {
    const v = foldOf(a).rounds.find((x) => x.r === 1)!;
    const root = cksOf(a, inc)[0];
    const { g: _g, ...body } = root;
    const theirs = sealCk(ctx, {
      ...body, b: nextSid3(ctx, root), u: 1, l: v.close, d: `h:${v.house!.hash}`, o: v.pocket!,
      n: Object.fromEntries([...foldOf(a).nets].map(([pid, n]) => [pid, String(n)])), e: 1, f: finOf(a, inc)!, k: H.pub,
    }, (bytes) => houseSign(H.secret, bytes));
    b.doc.transact(() => {
      for (const k of [...top(b).keys()]) if (k.startsWith(`ses:${TABLE}:${inc}:`) || k.startsWith(`ck:${TABLE}:${inc}:`)) top(b).delete(k);
      top(b).set(theirs.key, theirs.value);
    });
  }

  for (const by of ['the holder\'s page', 'the house'] as const) {
    it(`ended by ${by}: owner-run, not switched on again by itself, and the owner's own switch makes it a players' table under a fresh name; FAIR ONLY again opens another game`, async () => {
      let pages: Page[]; let inc: string; let T: number;
      if (by === 'the house') {
        const room = await endingRoom();
        ({ pages, inc } = room);
        const [a, b] = pages;
        house(b, room.kit.houseReveal(H, 1, [room.closeHash], frozenOf(room.close), { c: null }));
        sync(room.at, ...pages);
        run(pages, room.at + STEP, room.at + 2_400);
        houseEnds(a, b, inc, room.ctx);
        sync(room.at + 2_400, ...pages);
        T = room.at + 2_400 + 12_000;
        run(pages, room.at + 2_600, T);
      } else {
        const room = await gameRoom(['A', 'B']);
        ({ pages, inc } = room);
        const played = houseRound(pages, room.kit, 1, room.at);
        expect(off(pages[0], played.at)).toBe('ok');
        sync(played.at, ...pages);
        T = played.at + 2_000;
        run(pages, played.at + STEP, T);
      }
      const [a] = pages;
      const chips = pages.map((p) => a.casino.readChips(p.pid));
      for (const p of pages) {
        expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false });
        expect(p.casino.isComputedTable(TABLE)).toBe(false);
        expect(p.casino.ownerRunChosen(TABLE)).toBe(true);
      }
      // The driving page leaves it owner-run.
      clockOf(a, T);
      expect(a.table.autoSwitchComputed(TABLE, 'roulette', T)).toBe(false);
      expect(a.casino.isComputedTable(TABLE)).toBe(false);
      // The owner's RUN WITHOUT THE OWNER: a players' table on a name that is no game's.
      expect(a.table.switchComputedOn(TABLE, 'roulette', T + STEP)).toBe('ok');
      sync(T + STEP, ...pages);
      run(pages, T + 2 * STEP, T + 5 * STEP);
      const named = (casinoOf(a).get(`cfg:computed:${TABLE}`) as { inc: string }).inc;
      expect(named).not.toBe(inc);
      expect(named[0]).toMatch(/[ckrd]/);
      for (const p of pages) {
        expect(p.casino.isComputedTable(TABLE)).toBe(true);
        expect(p.casino.computedIncOf(TABLE)).toBe(named);
        expect(pages.map((q) => p.casino.readChips(q.pid))).toEqual(chips);
      }
      // And FAIR ONLY again: another game, its own name.
      expect(press(a, T + 6 * STEP, { j: 'fedcba9876543210' })).toBe('ok');
      sync(T + 6 * STEP, ...pages);
      run(pages, T + 7 * STEP, T + 10 * STEP);
      const next = nameOf(a, T + 6 * STEP, 'p', TABLE, 'fedcba9876543210');
      expect(next).not.toBe(inc);
      for (const p of pages) {
        expect(p.casino.computedIncOf(TABLE)).toBe(next);
        expect(p.casino.computedResolutionOf(TABLE, next)).toMatchObject({ live: true });
        expect(p.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ live: false });
        expect(pages.map((q) => p.casino.readChips(q.pid))).toEqual(chips);
      }
    });
  }
});

describe('writeFairOnlyEnd', () => {
  it('writes nothing for a game the doc holds nothing of, with nothing to write, an end order or a checkpoint that reads as none, or a checkpoint that is no end of this game', async () => {
    const { pages, at, inc, ctx } = await gameRoom(['A', 'B']);
    const [a] = pages;
    const root = cksOf(a, inc)[0];
    const rootKey = keysUnder(a, `ck:${TABLE}:${inc}:`)[0];
    const fin = sealFin(ctx, a.pub, a.keypair.signIdentity).value;
    const { g: _g, dl: _dl, ...body } = root;
    const end = sealCk(ctx, { ...body, b: nextSid3(ctx, root), e: 1, f: fin }, a.keypair.signIdentity);
    const other: FoldCtx = { ...ctx, inc: nameOf(a, at + 1) };
    const elsewhere = sealCk(other, { ...body, ts: at + 1, b: nextSid3(other, root), e: 1, f: sealFin(other, a.pub, a.keypair.signIdentity).value }, a.keypair.signIdentity);
    clockOf(a, at);
    const tries: [string, () => boolean][] = [
      ['no game', () => a.casino.writeFairOnlyEnd(TABLE, other.inc, fin, null)],
      ['nothing', () => a.casino.writeFairOnlyEnd(TABLE, inc, null, null)],
      ['no end order', () => a.casino.writeFairOnlyEnd(TABLE, inc, { ...fin, v: 2 } as never, null)],
      ['a checkpoint that is no end', () => a.casino.writeFairOnlyEnd(TABLE, inc, fin, { key: rootKey, value: root })],
      ['an end under another key', () => a.casino.writeFairOnlyEnd(TABLE, inc, fin, { key: rootKey, value: end.value })],
      ["another game's end", () => a.casino.writeFairOnlyEnd(TABLE, inc, fin, elsewhere)],
    ];
    for (const [name, attempt] of tries) {
      let said: boolean | undefined;
      const sent = updatesOf(a, () => { said = attempt(); });
      expect(said, name).toBe(false);
      expect(sent, name).toEqual([]);
    }
    // …and both, good, in one update.
    let said: boolean | undefined;
    const sent = updatesOf(a, () => { said = a.casino.writeFairOnlyEnd(TABLE, inc, fin, end); });
    expect(said).toBe(true);
    expect(sent).toHaveLength(1);
    expect(endOf(a, inc)).toEqual(end.value);
  });
});

describe('a press that ends nothing writes nothing', () => {
  it("'theirs' on a page that does not hold the game; 'ok' at a table that plays no game", async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    let out: string | undefined;
    const sent = updatesOf(b, () => { out = off(b, at); });
    expect(out).toBe('theirs');
    expect(sent).toEqual([]);
    expect(off(a, at)).toBe('ok');
    sync(at, ...pages);
    expect(a.casino.computedResolutionOf(TABLE, inc)?.live).toBe(false);
    const after = updatesOf(b, () => { out = off(b, at + STEP); });
    expect(out).toBe('ok');
    expect(after).toEqual([]);
  });

  it("'ok' for the other game's name: a roulette game held is no craps game to end", async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a] = pages;
    let out: string | undefined;
    const sent = updatesOf(a, () => { out = off(a, at, { game: 'craps' }); });
    expect(out).toBe('ok');
    expect(sent).toEqual([]);
    expect(a.casino.computedResolutionOf(TABLE, inc)?.live).toBe(true);
  });

  it("'reconnecting' while a checkpoint of the game waits to be checked: the end would be at a base that may not be the game's", async () => {
    const { pages, at, inc, kit, ctx } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const played = houseRound(pages, kit, 1, at);
    const T = played.at;
    const v = foldOf(a).rounds.find((x) => x.r === 1)!;
    const root = cksOf(a, inc)[0];
    const { g: _g, ...body } = root;
    // The house's trim to round 1, heard by a page with no time to check it.
    const trim = sealCk(ctx, {
      ...body, b: nextSid3(ctx, root), u: 1, l: v.close, d: `h:${v.house!.hash}`, o: v.pocket!,
      n: Object.fromEntries([...foldOf(a).nets].map(([pid, n]) => [pid, String(n)])), k: H.pub,
    }, (bytes) => houseSign(H.secret, bytes));
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    b.doc.transact(() => {
      for (const k of [...top(b).keys()]) if (k.startsWith(`ses:${TABLE}:${inc}:`) || k.startsWith(`ck:${TABLE}:${inc}:`)) top(b).delete(k);
      top(b).set(trim.key, trim.value);
      top(b).set(`ses:${TABLE}:${inc}:${nextSid3(ctx, trim.value)}`, new Y.Map());
    });
    sync(T, ...pages);
    expect(a.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ pending: true });
    let out: string | undefined;
    const sent = updatesOf(a, () => { out = off(a, T); });
    expect(out).toBe('reconnecting');
    expect(sent).toEqual([]);
    // Checked, it is the base, and the end is at its round.
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    // (The slice that checks what waited runs off the frame.)
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.casino.computedResolutionOf(TABLE, inc)).toMatchObject({ pending: false, base: { key: trim.key } });
    run(pages, T + STEP, T + 2 * STEP);
    expect(off(a, T + 3 * STEP)).toBe('ok');
    expect(endOf(a, inc)).toMatchObject({ e: 1, u: 1, b: nextSid3(ctx, trim.value), k: a.pub });
    a.casino.setComputedVerifyForTests();
  });

  it("'reconnecting' on a doc holding part of an update, 'asleep' once its frames stopped", async () => {
    const { pages, at } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const [, second] = updatesOf(b, () => {
      b.doc.transact(() => b.doc.getMap('scratch').set('a', 1));
      b.doc.transact(() => b.doc.getMap('scratch').set('b', 2));
    });
    Y.applyUpdate(a.doc, second);
    let out: string | undefined;
    const sent = updatesOf(a, () => { out = off(a, at); });
    expect(out).toBe('reconnecting');
    expect(sent).toEqual([]);
    const asleep = updatesOf(a, () => { out = off(a, at + 60_000); });
    expect(out).toBe('asleep');
    expect(asleep).toEqual([]);
  });
});
