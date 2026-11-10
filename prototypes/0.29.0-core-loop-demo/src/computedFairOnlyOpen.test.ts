/**
 * 🔒🚪 The owner's page opens a FAIR ONLY game (design §8.7, PR 6c-5a-1):
 * computedTable switchFairOnlyOn moves a house table to a `p` roulette or `q`
 * craps game in one write, where FAIR ONLY is offered (§8.1) and the table is
 * quiet; and every refusal writes nothing.
 *
 * Pages as the other FAIR ONLY specs have them (computedPageKit): each its own
 * load of the casino modules with its own Y.Doc, player id and identity key,
 * synced by hand, every clock explicit. The first page holds the room's deed,
 * its node's house key is delegated, and the house is a TestHouse whose
 * heartbeats and round records a spec writes by hand, as the node would.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FAIR_ONLY_RV, faironlyInc, NO_CLOSE, readCk } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { asCheckpoint, asClose, asHouseSumFor, nextSid3 } from './computedFold';
import type { CloseRec, FoldCtx } from './computedFold';
import { delegationKey, HOUSE_HEARD_MS } from './computedHouse';
import { buyer, delegation, house as GUEST_HOUSE, NAME, owner as GUEST, ROOM as KIT_ROOM, rootOf, trimOf, xferOf } from './computedFairOnlyKit';
import {
  Beating, carryOf, clockOf, CRAPS_REF, CRAPS_TABLE, crapsBet, crapsOf, keysIn, loadPage, openRoom, PAGE_INC, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, rigRoll,
  run as runBare, signAs, standAt, sync, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testHouse } from './computedTestKit';
import type { Built } from './computedTestKit';
import type { HouseFold } from './nodeFingerprint';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
/** The house table the room opens with: a roulette name this build opens (`r`). */
const RINC = 'r' + '5a'.repeat(12);
const RCTX: FoldCtx = { room: PAGE_ROOM, t: TABLE, inc: RINC };
const H = testHouse('owner-node');
/** What a node that runs FAIR ONLY games says of its fold. */
const FOLD: HouseFold = { letters: 'rdpq', rv: [FAIR_ONLY_RV] };
/** …and the craps table's: a craps name this build opens (`d`). */
const DINC = 'd' + '5a'.repeat(12);
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

describe("the owner's page opens a FAIR ONLY game at a house table", () => {
  it('in one update: the house table ends with its nets, and the root, its session and the switch open the game', async () => {
    const { pages, at: t1 } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    const played = houseRound(pages, new ComputedKit(RCTX), 1, t1);
    const T = played.at;
    const nets = Object.fromEntries([...foldOf(a).nets].map(([pid, n]) => [pid, String(n)]));
    expect(Object.keys(nets).sort()).toEqual([a.pid, b.pid].sort());
    const inc = nameOf(a, T);
    let out: string | undefined;
    const sent = updatesOf(a, () => { out = press(a, T); });
    expect(out).toBe('ok');
    expect(sent).toHaveLength(1);
    // The house table's incarnation ended as a switch-off ends it.
    expect(asCheckpoint(top(a).get(`sum:${TABLE}:${RINC}`))).toMatchObject({ e: 1, u: 1, n: nets, k: a.pub });
    expect(casinoOf(a).get(`gone:${TABLE}:${RINC}`)).toBe(1);
    expect(keysUnder(a, `ses:${TABLE}:${RINC}:`)).toEqual([]);
    expect(asHouseSumFor({ inc: RINC })(top(a).get(`hs:${TABLE}:${RINC}`))).toMatchObject({ e: 1, u: 1, k: a.pub });
    // The game: one root, signed by this page's key, naming its node's house by the room's delegation of it.
    const [rootKey] = keysUnder(a, `ck:${TABLE}:${inc}:`);
    expect(keysUnder(a, 'ck:')).toEqual([rootKey]);
    const read = readCk(PAGE_ROOM, rootKey, top(a).get(rootKey));
    expect(read.kind).toBe('ok');
    const root = (read as { ck: CkRec }).ck;
    expect(root).toEqual({
      v: 1, ok: a.pub, j: J, rv: FAIR_ONLY_RV, ts: T, b: 'g', u: 0, l: NO_CLOSE, n: {}, dl: top(a).get(delegationKey(H.pub)), k: a.pub, g: root.g,
    });
    expect(root.dl).toMatchObject({ h: H.pub, k: a.pub });
    // The session the root opens, empty, and the switch.
    const ses = top(a).get(`ses:${TABLE}:${inc}:${nextSid3({ room: PAGE_ROOM, t: TABLE, inc }, root)}`);
    expect(ses).toBeInstanceOf(Y.Map);
    expect((ses as Y.Map<unknown>).size).toBe(0);
    expect(keysUnder(a, 'ses:')).toHaveLength(1);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc });
    // Every page plays it from that update on, and the old incarnation's nets count on.
    sync(T, ...pages);
    for (const p of pages) {
      expect(p.casino.computedIncOf(TABLE)).toBe(inc);
      expect(p.casino.isComputedTable(TABLE)).toBe(true);
      expect(p.casino.computedGamesHeldBy(TABLE, a.pub)).toEqual([inc]);
      expect(p.casino.computedGamesHeldBy(TABLE, b.pub)).toEqual([]);
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
  });

  it('and a round goes at it on every page: the join, the close that names it, the reveal; both games\' nets count', async () => {
    const { pages, at: t1 } = await houseRoom(['A', 'B']);
    const [a] = pages;
    const before = houseRound(pages, new ComputedKit(RCTX), 1, t1);
    expect(press(a, before.at)).toBe('ok');
    sync(before.at, ...pages);
    const inc = nameOf(a, before.at);
    const kit = new ComputedKit({ room: PAGE_ROOM, t: TABLE, inc });
    run(pages, before.at + STEP, before.at + 2 * STEP);
    for (const p of pages) expect(p.table.readComputedRoulette(TABLE)).toMatchObject({ phase: 'betting', round: 1 });
    const after = houseRound(pages, kit, 1, before.at + 3 * STEP);
    for (const p of pages) {
      expect(p.casino.computedIncOf(TABLE)).toBe(inc);
      expect(foldOf(p).required).toBe(kit.houseCommit(H, 2));
      for (const q of pages) {
        expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(before.deltas.get(q.pid)) + Number(after.deltas.get(q.pid)));
      }
    }
  });
});

/** Page p's press at T refused for `why`, and nothing written. */
function refused(p: Page, T: number, why: string, opts: Parameters<typeof press>[2] = {}): void {
  let out: string | undefined;
  const sent = updatesOf(p, () => { out = press(p, T, opts); });
  expect(out).toBe(why);
  expect(sent).toEqual([]);
}

describe('where FAIR ONLY is not offered, the press writes nothing', () => {
  it("'owner': a page that does not hold the room's deed, whatever its node says", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    b.table.setLocalHouse(H.pub);
    b.table.setLocalHouseFold(FOLD);
    expect(b.table.fairOnlyOfferRefusal()).toBe('owner');
    refused(b, at, 'owner');
    expect(a.table.fairOnlyOfferRefusal()).toBeNull();
  });

  it("'off': computed tables turned off on the page", async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    a.table.setComputedTablesEnabledForTests(false);
    expect(a.table.fairOnlyOfferRefusal()).toBe('off');
    refused(a, at, 'off');
    // (Said before anything is asked of the node.)
    a.table.setLocalHouse(null);
    expect(a.table.fairOnlyOfferRefusal()).toBe('off');
    a.table.setLocalHouse(H.pub);
    a.table.setComputedTablesEnabledForTests(null);
    expect(a.table.fairOnlyOfferRefusal()).toBeNull();
  });

  it("'no-house': no node, a node whose key the room does not hold delegated, or a delegation a peer took away", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a] = pages;
    a.table.setLocalHouse(null);
    expect(a.table.fairOnlyOfferRefusal()).toBe('no-house');
    refused(a, at, 'no-house');
    // Another node of the owner's, its key not delegated yet.
    a.table.setLocalHouse(testHouse('other-node').pub);
    expect(a.table.fairOnlyOfferRefusal()).toBe('no-house');
    refused(a, at, 'no-house');
    // The delegated one, its record gone from the doc (a peer's delete).
    a.table.setLocalHouse(H.pub);
    expect(a.table.fairOnlyOfferRefusal()).toBeNull();
    a.doc.transact(() => top(a).delete(delegationKey(H.pub)));
    expect(a.casino.delegationOf(H.pub)).toBeNull();
    refused(a, at, 'no-house');
  });

  it("'no-house' while this page has not checked the delegation's signature, and where the delegation is another deed holder's", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    // The owner's other page, loaded with no time to check a signature.
    const a2 = await loadPage('A2', 3, { reloadOf: a, verify: { now: () => 0, budgetMs: 0 } });
    a2.table.setLocalHouse(H.pub);
    a2.table.setLocalHouseFold(FOLD);
    sync(at, a, a2, b);
    expect(a2.casino.holdsDeed()).toBe(true);
    expect(a2.casino.delegationHeld(H.pub)).toBeUndefined();
    expect(a2.casino.delegationOf(H.pub)).toBeNull();
    refused(a2, at, 'no-house');
    a2.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(a2.casino.delegationOf(H.pub)).toEqual(top(a).get(delegationKey(H.pub)));
    expect(a2.table.fairOnlyOfferRefusal()).toBeNull();
    // The deed moves to b: the delegation a signed is not b's, whatever b's node is.
    b.doc.transact(() => b.doc.getMap('roomInfo').set('owner', b.pid));
    b.table.setLocalHouse(H.pub);
    b.table.setLocalHouseFold(FOLD);
    expect(b.casino.holdsDeed()).toBe(true);
    expect(b.casino.delegationHeld(H.pub)).toBe(false);
    expect(b.casino.delegationOf(H.pub)).toBeNull();
    refused(b, at, 'no-house');
  });

  it("'no-engine': the node's fold does not say it runs both letters at this build's rules, or is off", async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    const not: (HouseFold | null)[] = [
      null,
      { letters: 'rd', rv: [] },
      { letters: 'rdp', rv: [FAIR_ONLY_RV] },
      { letters: 'rdq', rv: [FAIR_ONLY_RV] },
      { letters: 'rdpq', rv: [] },
      { letters: 'rdpq', rv: ['f2'] },
      { letters: 'rdpq', rv: [FAIR_ONLY_RV], off: true },
    ];
    for (const fold of not) {
      a.table.setLocalHouseFold(fold);
      expect(a.table.fairOnlyOfferRefusal(), JSON.stringify(fold)).toBe('no-engine');
      refused(a, at, 'no-engine');
    }
    a.table.setLocalHouseFold({ letters: 'qp', rv: ['f0', FAIR_ONLY_RV] });
    expect(a.table.fairOnlyOfferRefusal()).toBeNull();
    expect(press(a, at)).toBe('ok');
  });
});

/** Whatever waits on a timer of the page's own (a slice of signature checks). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Hands page p the second of another page's two writes elsewhere in the doc,
 *  so that it holds part of an update; the function returned hands it the first. */
function partOfAnUpdate(p: Page): () => void {
  const other = new Y.Doc();
  const updates: Uint8Array[] = [];
  other.on('update', (u: Uint8Array) => updates.push(u));
  other.getMap('elsewhere').set('a', 1);
  other.getMap('elsewhere').set('b', 2);
  Y.applyUpdate(p.doc, updates[1]);
  return () => Y.applyUpdate(p.doc, updates[0]);
}

describe('at a table that is not a quiet house table of the game, the press writes nothing', () => {
  it("'reconnecting' on a doc holding part of an update or with a signature still to check, 'asleep' once its frames stopped", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    const rest = partOfAnUpdate(a);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    refused(a, at, 'reconnecting');
    rest();
    // A felt this page has had no time to check.
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    clockOf(b, at);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    sync(at, a, b);
    expect(a.casino.computedSettled()).toBe(false);
    refused(a, at, 'reconnecting');
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(a.casino.computedSettled()).toBe(true);
    // No frame for a minute: the page reads as asleep.
    expect(a.croupier.tablesAwake(at + 60_000)).toBe(false);
    refused(a, at + 60_000, 'asleep');
  });

  it("the gate is asked before the table: 'reconnecting' and 'asleep' at an owner-run table too", async () => {
    const { pages, at } = await houseRoom(['A'], { inc: null });
    const [a] = pages;
    refused(a, at, 'not-house');
    const rest = partOfAnUpdate(a);
    refused(a, at, 'reconnecting');
    rest();
    refused(a, at, 'not-house');
    refused(a, at + 60_000, 'asleep');
  });

  it("'not-house' once the house table is switched off, also with the switch put back on its ended name", async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    clockOf(a, at);
    expect(a.table.switchComputedOff(TABLE, at)).toBe('ok');
    expect(a.casino.computedIncOf(TABLE)).toBeNull();
    refused(a, at, 'not-house');
    // (A peer's write: the name the switch holds has ended, and no table plays it.)
    a.doc.transact(() => casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: RINC }));
    expect(a.casino.computedIncOf(TABLE)).toBe(RINC);
    expect(a.casino.isComputedTable(TABLE)).toBe(false);
    refused(a, at, 'not-house');
  });

  it("'not-house' at an owner-run table, and at one PR 2–4 opened", async () => {
    for (const inc of [null, PAGE_INC]) {
      const { pages, at } = await houseRoom(['A'], { inc });
      expect(pages[0].casino.isComputedTable(TABLE), String(inc)).toBe(inc !== null);
      refused(pages[0], at, 'not-house');
    }
  });

  it("'craps' where the table's computed name is the other game's", async () => {
    const d = await houseRoom(['A'], { inc: 'd' + '5a'.repeat(12) });
    refused(d.pages[0], d.at, 'craps');
    const r = await houseRoom(['A']);
    refused(r.pages[0], r.at, 'craps', { game: 'craps' });
    // …and still once this page's key holds the table's game: a roulette game held is no craps game.
    expect(press(r.pages[0], r.at)).toBe('ok');
    refused(r.pages[0], r.at, 'craps', { game: 'craps' });
  });

  it("'theirs' at a table that plays a FAIR ONLY game another key holds", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
    const root = rootOf(G, 'p', { dl: delegation(GUEST, GUEST_HOUSE.pub, PAGE_ROOM) });
    b.doc.transact(() => {
      top(b).set(root.key, root.value);
      top(b).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, root.value)}`, new Y.Map());
    });
    sync(at, a, b);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.computedGamesHeldBy(TABLE, GUEST.pub)).toEqual([G.inc]);
    refused(a, at, 'theirs');
  });

  it("'old-build' while a build that knows no FAIR ONLY game drives the room's tables", async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    expect(a.casino.HOUSE_ONLY_MIN_BUILD).toBe(4);
    expect(a.casino.TABLE_BUILD).toBe(4);
    clockOf(a, at);
    a.casino.writeTableOperatorLease({ page: 'other-page', player: 'someone', beat: 1, build: 3 });
    refused(a, at, 'old-build');
    // A lease with no build is an earlier one's still.
    a.doc.transact(() => casinoOf(a).set('table-operator', { page: 'other-page', player: 'someone', beat: 2 }));
    refused(a, at, 'old-build');
    a.casino.writeTableOperatorLease({ page: 'other-page', player: 'someone', beat: 3, build: 4 });
    expect(press(a, at)).toBe('ok');
  });

  it("'house-away' once no house of the room has been heard for HOUSE_HEARD_MS", async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    beat!.muted = true;
    const heard = beat!.lastAt!;
    run(pages, at + STEP, heard + HOUSE_HEARD_MS);
    expect(a.casino.houseOnline(heard + HOUSE_HEARD_MS)).toBe(true);
    refused(a, heard + HOUSE_HEARD_MS + 1, 'house-away');
    // (By the clock the press is given: the machine's own, a millisecond behind here, would say heard.)
    vi.setSystemTime(heard + HOUSE_HEARD_MS);
    expect(a.table.switchFairOnlyOn(TABLE, 'roulette', heard + HOUSE_HEARD_MS + 1)).toBe('house-away');
    beat!.muted = false;
    run(pages, heard + HOUSE_HEARD_MS + STEP, heard + HOUSE_HEARD_MS + STEP);
    expect(press(a, heard + HOUSE_HEARD_MS + STEP)).toBe('ok');
  });

  it("'busy' from the close of a round to the end of its result's show", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    const kit = new ComputedKit(RCTX);
    house(a, kit.houseJoin(H, 1));
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    sync(at, ...pages);
    const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
    refused(a, closedAt, 'busy');
    const [close] = closesOf(a, 1);
    const seedsAt = run(pages, closedAt + STEP, closedAt + 12_000, { until: () => keysIn(a, 'x', 1).length === 1 });
    refused(a, seedsAt, 'busy');
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close)));
    sync(seedsAt, ...pages);
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'house' });
    // The result shows: busy until its show ends.
    const showEnd = a.table.readComputedRoulette(TABLE, seedsAt)!.resultAt + a.croupier.SHOW_MS;
    run(pages, seedsAt + STEP, showEnd - STEP);
    refused(a, showEnd - STEP, 'busy');
    run(pages, showEnd, showEnd + STEP);
    expect(press(a, showEnd + STEP)).toBe('ok');
  });
});

describe('a press that goes', () => {
  it('hands the bets of an open round back as the house table ends', async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    clockOf(b, at);
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    for (const p of pages) expect([p.casino.readChips(a.pid), p.casino.readChips(b.pid)]).toEqual([990, 980]);
    expect(press(a, at)).toBe('ok');
    sync(at, ...pages);
    for (const p of pages) {
      expect(p.casino.computedIncOf(TABLE)).toBe(nameOf(a, at));
      expect([p.casino.readChips(a.pid), p.casino.readChips(b.pid)]).toEqual([1_000, 1_000]);
    }
    // No round was decided: the end sits at the base, with no nets.
    expect(asCheckpoint(top(a).get(`sum:${TABLE}:${RINC}`))).toMatchObject({ e: 1, u: 1, n: {} });
  });

  it("is 'ok' again, with nothing written, at a table where the page's key holds a game already", async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a] = pages;
    expect(press(a, at)).toBe('ok');
    refused(a, at, 'ok');
    sync(at, ...pages);
    run(pages, at + STEP, at + 2 * STEP);
    refused(a, at + 2 * STEP, 'ok');
    for (const p of pages) expect(p.casino.computedGamesHeldBy(TABLE, a.pub)).toEqual([nameOf(a, at)]);
  });

  it('over a switch the doc holds nothing behind: the name is marked ended, and the game opens', async () => {
    const { pages, at } = await houseRoom(['A'], { inc: null });
    const [a] = pages;
    const bare = 'r' + '77'.repeat(12);
    a.doc.transact(() => casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc: bare }));
    expect(a.casino.computedSwitchBare(TABLE)).toBe(true);
    expect(press(a, at)).toBe('ok');
    expect(casinoOf(a).get(`gone:${TABLE}:${bare}`)).toBe(1);
    expect(top(a).has(`sum:${TABLE}:${bare}`)).toBe(false);
    expect(a.casino.computedIncOf(TABLE)).toBe(nameOf(a, at));
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
  });
});

describe('a press that goes, further', () => {
  it("takes the clock the press is given for the name, whole: a fraction of a millisecond is left out, and the machine's clock is not asked", async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    expect(press(a, at + 0.7)).toBe('ok');
    expect(a.casino.computedIncOf(TABLE)).toBe(nameOf(a, at));
    // (The machine's clock a second behind the press's.)
    const other = await houseRoom(['C']);
    const [c] = other.pages;
    c.seeds.push(J + 'f'.repeat(48));
    vi.setSystemTime(other.at - 1_000);
    expect(c.table.switchFairOnlyOn(TABLE, 'roulette', other.at)).toBe('ok');
    c.seeds.length = 0;
    expect(c.casino.computedIncOf(TABLE)).toBe(nameOf(c, other.at));
  });

  it("two of the owner's pages pressing at once open a game each; every page plays the one the switch names, and no third opens", async () => {
    const { pages, at: t1 } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    // The owner's other page: the same key and player, loaded afresh.
    const a2 = await loadPage('A2', 3, { reloadOf: a });
    a2.table.setLocalHouse(H.pub);
    a2.table.setLocalHouseFold(FOLD);
    const all = [a, a2, b];
    sync(t1, ...all);
    // (Until it has heard the house on its own clock.)
    const T = run(all, t1 + STEP, t1 + 30_000, { until: () => a2.casino.houseOnline() && a2.table.fairOnlyOfferRefusal() === null });
    expect(press(a, T)).toBe('ok');
    expect(press(a2, T, { j: 'fedcba9876543210' })).toBe('ok');
    sync(T, ...all);
    const games = [nameOf(a, T), nameOf(a, T, 'p', TABLE, 'fedcba9876543210')].sort();
    const named = (casinoOf(a).get(`cfg:computed:${TABLE}`) as { inc: string }).inc;
    expect(games).toContain(named);
    for (const p of all) {
      expect(p.casino.computedGamesHeldBy(TABLE, a.pub)).toEqual(games);
      expect(p.casino.computedIncOf(TABLE)).toBe(named);
      expect(casinoOf(p).get(`gone:${TABLE}:${RINC}`)).toBe(1);
    }
    refused(a, T, 'ok');
    refused(a2, T, 'ok');
  });
});

describe('a page still checking the root of the game its table moved to', () => {
  it('opens no owner-run round under it; one opens under a name the doc holds nothing of, as before', async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    b.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 }); // (no time to check anything)
    expect(press(a, at)).toBe('ok');
    sync(at, a, b);
    // Not live on b yet, and the house table under it has ended: no computed table at all.
    expect(b.casino.isComputedTable(TABLE)).toBe(false);
    expect(b.casino.computedSwitchLost(TABLE)).toBe(false);
    expect(b.casino.computedSwitchChecking(TABLE)).toBe(true);
    clockOf(b, at + STEP);
    b.croupier.tickAutoCroupier(TABLE);
    b.croupier.openBetting(TABLE, 1);
    expect(b.casino.readTableState(TABLE)).toBeNull();
    // The check made: the game is live, with nothing under it.
    b.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(b.casino.computedSwitchChecking(TABLE)).toBe(false);
    expect(b.casino.isComputedTable(TABLE)).toBe(true);
    expect(b.table.computedOldBuildDriving(TABLE)).toBe(false);
    // A FAIR ONLY name nothing stands behind holds no round back (S4: the table goes on as it was).
    const or = await houseRoom(['C'], { inc: null });
    const [c] = or.pages;
    c.doc.transact(() => casinoOf(c).set(`cfg:computed:${TABLE}`, { v: 1, inc: 'p' + '1'.repeat(24) }));
    expect(c.casino.computedSwitchChecking(TABLE)).toBe(false);
    clockOf(c, or.at);
    c.croupier.openBetting(TABLE, 1);
    expect(c.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 1 });
  });

  it('nor a roll at a craps table', async () => {
    const { pages, at } = await houseRoom(['A', 'B'], { inc: DINC, t: CRAPS_TABLE });
    const [a, b] = pages;
    // (The stickman of b's own load of the modules: b is the page loaded last.)
    const stickman = await import('./crapsCroupier');
    b.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    expect(press(a, at, { game: 'craps', t: CRAPS_TABLE })).toBe('ok');
    sync(at, a, b);
    expect(b.casino.isComputedTable(CRAPS_TABLE)).toBe(false);
    expect(b.casino.computedSwitchChecking(CRAPS_TABLE)).toBe(true);
    clockOf(b, at + STEP);
    stickman.openCrapsBetting(CRAPS_TABLE, 1, null);
    expect(b.casino.readCrapsTableState(CRAPS_TABLE)).toBeNull();
    b.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(b.casino.isComputedTable(CRAPS_TABLE)).toBe(true);
    // (Where no game is being checked the same call opens a roll.)
    const or = await houseRoom(['C'], { inc: null });
    clockOf(or.pages[0], or.at);
    (await import('./crapsCroupier')).openCrapsBetting(CRAPS_TABLE, 1, null);
    expect(or.pages[0].casino.readCrapsTableState(CRAPS_TABLE)).toMatchObject({ phase: 'betting', round: 1 });
  });
});

describe('at a craps table', () => {
  it('a `q` game opens on a come-out, its root carrying the state a craps table opens with', async () => {
    const { pages, at } = await houseRoom(['A', 'B'], { inc: DINC, t: CRAPS_TABLE });
    const [a] = pages;
    expect(press(a, at, { game: 'craps', t: CRAPS_TABLE })).toBe('ok');
    sync(at, ...pages);
    const inc = nameOf(a, at, 'q', CRAPS_TABLE);
    const [rootKey] = keysUnder(a, `ck:${CRAPS_TABLE}:${inc}:`);
    expect(readCk(PAGE_ROOM, rootKey, top(a).get(rootKey))).toMatchObject({ kind: 'ok', letter: 'q', ck: { b: 'g', u: 0, s: { p: 0, w: {} }, k: a.pub } });
    run(pages, at + STEP, at + 2 * STEP, { tables: [CRAPS_REF] });
    for (const p of pages) {
      expect(p.casino.computedIncOf(CRAPS_TABLE)).toBe(inc);
      expect(crapsOf(p, at + 2 * STEP)).toMatchObject({ phase: 'betting', round: 1, point: null });
    }
  });

  it("'contract' while a pass rides on a point; the second press hands every bet back and opens the game", async () => {
    const { pages, at } = await houseRoom(['A', 'B'], { inc: DINC, t: CRAPS_TABLE });
    const [a, b] = pages;
    // The players' seeds alone decide the rolls of a table set Friendly: a point comes on with no house record.
    clockOf(a, at);
    expect(a.table.setComputedFairness(CRAPS_TABLE, 'friendly', at)).toBe('ok');
    sync(at, ...pages);
    pages.forEach((p, i) => standAt(p, i + 1));
    rigRoll(pages, 1, 6, [], { room: PAGE_ROOM, t: CRAPS_TABLE, inc: DINC });
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }], at)).toBe('ok');
    expect(crapsBet(b, [{ type: 'pass', amount: 5 }], at)).toBe('ok');
    sync(at, ...pages);
    const decided = (p: Page): boolean => p.casino.computedFoldOf(CRAPS_TABLE)?.rounds[0]?.decided === 'reveals';
    const decidedAt = run(pages, at + STEP, at + 60_000, { tables: [CRAPS_REF], until: () => pages.every(decided) });
    expect(pages.map((p) => carryOf(p).p)).toEqual([6, 6]);
    const T = crapsOf(a, decidedAt)!.resultAt + a.croupier.CRAPS_SHOW_MS + STEP;
    run(pages, decidedAt + STEP, T, { tables: [CRAPS_REF] });
    for (const p of pages) expect([p.casino.readChips(a.pid), p.casino.readChips(b.pid)]).toEqual([990, 995]);
    refused(a, T, 'contract', { game: 'craps', t: CRAPS_TABLE });
    expect(press(a, T, { game: 'craps', t: CRAPS_TABLE, again: true })).toBe('ok');
    sync(T, ...pages);
    for (const p of pages) {
      expect(p.casino.computedIncOf(CRAPS_TABLE)).toBe(nameOf(a, T, 'q', CRAPS_TABLE));
      expect([p.casino.readChips(a.pid), p.casino.readChips(b.pid)]).toEqual([1_000, 1_000]);
    }
    expect(asCheckpoint(top(a).get(`sum:${CRAPS_TABLE}:${DINC}`))).toMatchObject({ e: 1, u: 1 });
  });
});

describe('casinoDoc writeFairOnlyOn', () => {
  it('writes all of it or nothing: no root of this table in this room, or an end that would not finalise, and the doc is as it was', async () => {
    const { pages, at } = await houseRoom(['A']);
    const [a] = pages;
    clockOf(a, at);
    const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
    const dl = delegation(GUEST, GUEST_HOUSE.pub, PAGE_ROOM);
    const good = rootOf(G, 'p', { dl });
    const elsewhere = { room: PAGE_ROOM, t: 'roulette-9', inc: faironlyInc('p', PAGE_ROOM, 'roulette-9', NAME) };
    const otherRoom = { room: KIT_ROOM, t: TABLE, inc: faironlyInc('p', KIT_ROOM, TABLE, NAME) };
    const wrongKey = good.key.slice(0, -1) + (good.key.endsWith('0') ? '1' : '0');
    const not: [string, { key: string; value: CkRec }][] = [
      ["another table's root", rootOf(elsewhere, 'p', { dl })],
      ["another room's root", rootOf(otherRoom, 'p', { dl: delegation(GUEST, GUEST_HOUSE.pub) })],
      ['a checkpoint that is no root', trimOf(G, 'p', { dl: delegation(GUEST, GUEST_HOUSE.pub, PAGE_ROOM) })],
      ['a key that is not the hash of its value', { key: wrongKey, value: good.value }],
      ['a value that is no checkpoint', { key: good.key, value: { ...good.value, v: 2 } as unknown as CkRec }],
      ['a root of rules this build does not know', rootOf({ ...G, inc: faironlyInc('p', PAGE_ROOM, TABLE, { ...NAME, rv: 'f9' }) }, 'p', { rv: 'f9', dl })],
    ];
    for (const [what, root] of not) {
      let out: boolean | undefined;
      const sent = updatesOf(a, () => { out = a.casino.writeFairOnlyOn(TABLE, root); });
      expect(out, what).toBe(false);
      expect(sent, what).toEqual([]);
    }
    // An end that would not finalise the house table: of a name this page tracks nothing of, or closing another session than its live one.
    const stale = signAs(a, 'sum', { v: 1 as const, b: 'f'.repeat(24), u: 1, l: NO_CLOSE, n: {}, e: 1 as const }, RCTX);
    for (const ending of [{ inc: 'r' + '00'.repeat(12), cp: stale }, { inc: RINC, cp: stale }]) {
      let out: boolean | undefined;
      const sent = updatesOf(a, () => { out = a.casino.writeFairOnlyOn(TABLE, good, ending); });
      expect(out, ending.inc).toBe(false);
      expect(sent, ending.inc).toEqual([]);
    }
    // On a doc holding part of an update, nothing either.
    const rest = partOfAnUpdate(a);
    expect(updatesOf(a, () => { expect(a.casino.writeFairOnlyOn(TABLE, good)).toBe(false); })).toEqual([]);
    rest();
    // The root alone, with no end: the name the switch held is marked ended, and the game is there.
    expect(a.casino.writeFairOnlyOn(TABLE, good)).toBe(true);
    expect(casinoOf(a).get(`gone:${TABLE}:${RINC}`)).toBe(1);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G.inc });
    expect(top(a).get(`ses:${TABLE}:${G.inc}:${nextSid3(G, good.value)}`)).toBeInstanceOf(Y.Map);
    expect(a.casino.computedGamesHeldBy(TABLE, GUEST.pub)).toEqual([G.inc]);
    // Over a FAIR ONLY name the switch held: the switch moves, and that name gets no mark (a game is ended by its authority alone).
    const j = 'f'.repeat(16);
    const G2 = { ...G, inc: faironlyInc('p', PAGE_ROOM, TABLE, { ...NAME, j }) };
    expect(a.casino.writeFairOnlyOn(TABLE, rootOf(G2, 'p', { j, dl }))).toBe(true);
    expect(casinoOf(a).has(`gone:${TABLE}:${G.inc}`)).toBe(false);
    expect(casinoOf(a).get(`cfg:computed:${TABLE}`)).toEqual({ v: 1, inc: G2.inc });
    expect(a.casino.computedGamesHeldBy(TABLE, GUEST.pub)).toEqual([G.inc, G2.inc].sort());
    // A game is its holder's: the buyer's once a transfer moved it.
    const xf = xferOf(G, GUEST, buyer, 1, { asset: { kind: 'deed', roomId: PAGE_ROOM, roomName: 'Furlong' } });
    a.doc.transact(() => top(a).set(xf.key, xf.value));
    expect(a.casino.computedGamesHeldBy(TABLE, GUEST.pub)).toEqual([G2.inc]);
    expect(a.casino.computedGamesHeldBy(TABLE, buyer.pub)).toEqual([G.inc]);
  });
});

describe('main.ts', () => {
  it("hands the node's fold report on at every fingerprint read, beside its house key", () => {
    const lines = readFileSync(new URL('./main.ts', import.meta.url), 'utf8').split('\n').filter((line) => line.includes('setLocalHouseFold('));
    expect(lines).toEqual(['  setLocalHouseFold(fingerprint.house_fold ?? null);']);
  });
});
