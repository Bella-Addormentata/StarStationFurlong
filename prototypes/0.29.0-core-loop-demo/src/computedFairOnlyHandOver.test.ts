/**
 * 🔒🤝 A FAIR ONLY game moves with the room's deed (design §8.7, deed handover;
 * PR 6c-5c-1): the buyer's page, redeeming a deed offer made out to its key,
 * writes the transfer (`xf:`) and, over a base that is not the opening root,
 * the adoption (the base's content under its own key) in the redemption's
 * update (computedTable adoptFairOnlyGames, through offers' deedRedeemed);
 * a page that settles the deed for a buyer who is away leaves the offer
 * (`do:`), and the buyer's page moves the game when it is next in the room
 * (adoptDuty). Every page then reads the buyer as the game's holder, and the
 * session goes on.
 *
 * Pages and the house as the end's specs have them
 * (computedFairOnlyEnd.test.ts): the first page holds the room's deed and
 * opens the game.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { definedOffer, FAIR_ONLY_RV, faironlyInc, OFFER_SKEW_MS, readCk, sealCk } from './computedFairOnly';
import type { CkRec, XferRec } from './computedFairOnly';
import { asClose, nextSid3 } from './computedFold';
import type { CloseRec, FoldCtx } from './computedFold';
import { houseSign } from './computedHouse';
import {
  Beating, clockOf, CRAPS_REF, CRAPS_TABLE, keysIn, loadPage, openRoom, PAGE_ROOM, PAGE_TABLE as TABLE, putIn,
  run as runBare, sync, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testHouse } from './computedTestKit';
import type { Built } from './computedTestKit';
import type { HouseFold } from './nodeFingerprint';
import type { TransferOffer } from './offerBytes';

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


const doOf = (p: Page, nonce: string) => top(p).get(`do:${nonce}`) as TransferOffer | undefined;
const xfsOf = (p: Page, inc: string): XferRec[] => keysUnder(p, `xf:${TABLE}:${inc}:`).map((k) => top(p).get(k) as XferRec);
const res = (p: Page, inc: string) => p.casino.computedResolutionOf(TABLE, inc)!;
const ASSET = { kind: 'deed' as const, roomId: PAGE_ROOM, roomName: 'The Room' };

/** Page `from` makes a deed offer out to page `to` at T. */
function offerAt(from: Page, to: Page | null, T: number): TransferOffer {
  clockOf(from, T);
  return from.offers.makeOffer(ASSET, from.name, to ? { toPub: to.pub } : {});
}

/** Page p redeems deed offer `o` at T, standing in the room. */
function redeem(p: Page, o: TransferOffer, T: number) {
  clockOf(p, T);
  return p.offers.redeemDeedOffer(o, { currentRoomId: PAGE_ROOM, myPlayerId: p.pid, myPub: p.pub, myName: p.name });
}

/** The house's trim of the game to its decided round 1, laid in by page p. */
function trimTo1(p: Page, ctx: FoldCtx, inc: string): { key: string; value: CkRec } {
  const v = foldOf(p).rounds.find((x) => x.r === 1)!;
  const root = cksOf(p, inc)[0];
  const { g: _g, ...body } = root;
  const trim = sealCk(ctx, {
    ...body, b: nextSid3(ctx, root), u: 1, l: v.close, d: `h:${v.house!.hash}`, o: v.pocket!,
    n: Object.fromEntries([...foldOf(p).nets].map(([pid, n]) => [pid, String(n)])), k: H.pub,
  }, (bytes) => houseSign(H.secret, bytes));
  p.doc.transact(() => {
    for (const k of [...top(p).keys()]) if (k.startsWith(`ses:${TABLE}:${inc}:`) || k.startsWith(`ck:${TABLE}:${inc}:`)) top(p).delete(k);
    top(p).set(trim.key, trim.value);
    top(p).set(`ses:${TABLE}:${inc}:${nextSid3(ctx, trim.value)}`, new Y.Map());
  });
  return trim;
}

describe('the buyer\'s page redeems a deed offer made out to it: the seller\'s FAIR ONLY game moves with the deed', () => {
  it('over the opening root, in the redemption\'s one update: the offer left, the transfer at the last decided round, no adoption; every page reads the buyer as holder and the session goes on', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const played = houseRound(pages, kit, 1, at);
    const T = played.at;
    const o = offerAt(a, b, T);
    const sid = a.casino.computedSessionForWrite(TABLE);
    let out: unknown;
    const sent = updatesOf(b, () => { out = redeem(b, o, T); });
    expect(out).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(b.doc.getMap('roomInfo').get('owner')).toBe(b.pid);
    expect(doOf(b, o.nonce)).toMatchObject({ nonce: o.nonce, makerPub: a.pub, toPub: b.pub, sig: o.sig });
    // (As a record holds it: none of the recipients the offer names none of.)
    expect(Object.keys(doOf(b, o.nonce)!).sort()).toEqual(['asset', 'expiresAt', 'issuedAt', 'kind', 'makerName', 'makerPub', 'nonce', 'price', 'sig', 'toPub', 'v']);
    const [xf] = xfsOf(b, inc);
    expect(xfsOf(b, inc)).toHaveLength(1);
    expect(xf).toEqual({ v: 1, o: doOf(b, o.nonce), u: 1, k: b.pub, g: xf.g });
    // (The root is its opener's alone to sign: it stays the base, under the seller's range, which ends at round 1.)
    expect(cksOf(b, inc)).toHaveLength(1);
    sync(T, ...pages);
    run(pages, T + STEP, T + 2 * STEP);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, pending: false, holder: b.pub, invalid: [] });
      expect(res(p, inc).chain.map((h) => [h.k, h.from])).toEqual([[a.pub, 0], [b.pub, 1]]);
      expect(p.casino.computedGamesHeldBy(TABLE, b.pub)).toEqual([inc]);
      expect(p.casino.computedGamesHeldBy(TABLE, a.pub)).toEqual([]);
      expect(p.casino.isComputedTable(TABLE)).toBe(true);
      // The round played before the hand-over counts on.
      for (const q of [a, b]) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
    expect(a.casino.computedSessionForWrite(TABLE)).toBe(sid);
    // Nothing more is written for it: one transfer, by one look.
    run(pages, T + 3 * STEP, T + 3_000);
    expect(xfsOf(b, inc)).toHaveLength(1);
    expect(cksOf(b, inc)).toHaveLength(1);
    expect(c.casino.computedFairOnlyGames()).toEqual([{ t: TABLE, inc, holder: b.pub }]);
  });

  it('over a trim: the transfer at the trim\'s round and the adoption, the trim\'s content under the buyer\'s key with the transfer in its chain; the live session is the one it was', async () => {
    const { pages, at, inc, kit, ctx } = await gameRoom(['A', 'B', 'C']);
    const [a, b] = pages;
    const played = houseRound(pages, kit, 1, at);
    const T = played.at;
    const trim = trimTo1(a, ctx, inc);
    sync(T, ...pages);
    run(pages, T + STEP, T + 2 * STEP);
    for (const p of pages) expect(res(p, inc)).toMatchObject({ live: true, pending: false, base: { key: trim.key } });
    const o = offerAt(a, b, T + 3 * STEP);
    const sent = updatesOf(b, () => { expect(redeem(b, o, T + 3 * STEP)).toEqual({ ok: true }); });
    expect(sent).toHaveLength(1);
    const [xf] = xfsOf(b, inc);
    expect(xf).toMatchObject({ u: 1, k: b.pub });
    const adoption = cksOf(b, inc).find((ck) => ck.k === b.pub)!;
    const { g: _g, dl: _dl, k: _k, ...content } = trim.value;
    expect(adoption).toEqual({ ...content, x: [xf], k: b.pub, g: adoption.g });
    expect(nextSid3(ctx, adoption)).toBe(nextSid3(ctx, trim.value));
    expect(cksOf(b, inc)).toHaveLength(2);
    sync(T + 3 * STEP, ...pages);
    run(pages, T + 4 * STEP, T + 5 * STEP);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, pending: false, holder: b.pub, invalid: [] });
      expect(res(p, inc).chain.map((h) => [h.k, h.from])).toEqual([[a.pub, 0], [b.pub, 1]]);
      for (const q of [a, b]) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
    // With the transfer's own key deleted the adoption still carries it (S2).
    b.doc.transact(() => { for (const k of keysUnder(b, `xf:${TABLE}:${inc}:`)) top(b).delete(k); });
    expect(res(b, inc)).toMatchObject({ holder: b.pub });
  });

  it('the buyer can end the game it took, its end carrying the transfer; the seller no longer can', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const played = houseRound(pages, kit, 1, at);
    const T = played.at;
    expect(redeem(b, offerAt(a, b, T), T)).toEqual({ ok: true });
    sync(T, ...pages);
    run(pages, T + STEP, T + 2 * STEP);
    const sellers = updatesOf(a, () => { expect(off(a, T + 3 * STEP)).toBe('theirs'); });
    expect(sellers).toEqual([]);
    expect(off(b, T + 3 * STEP)).toBe('ok');
    const end = endOf(b, inc)!;
    expect(end).toMatchObject({ e: 1, u: 1, k: b.pub, f: { k: b.pub }, x: xfsOf(b, inc) });
    sync(T + 3 * STEP, ...pages);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: false, pending: false, holder: b.pub, base: { ck: { e: 1, u: 1 } } });
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
  });

  it('rounds decided since the trim: the transfer at the last of them and no adoption, so the seller\'s house\'s results count on', async () => {
    const { pages, at, inc, kit, ctx } = await gameRoom(['A', 'B', 'C']);
    const [a, b] = pages;
    const first = houseRound(pages, kit, 1, at);
    const trim = trimTo1(a, ctx, inc);
    sync(first.at, ...pages);
    run(pages, first.at + STEP, first.at + 2 * STEP);
    const second = houseRound(pages, kit, 2, first.at + 3 * STEP);
    const T = second.at;
    const chips = new Map(pages.map((q) => [q.pid, a.casino.readChips(q.pid)]));
    expect(chips.get(a.pid)).toBe(1_000 + Number(first.deltas.get(a.pid)) + Number(second.deltas.get(a.pid)));
    expect(redeem(b, offerAt(a, b, T), T)).toEqual({ ok: true });
    expect(xfsOf(b, inc)).toHaveLength(1);
    expect(xfsOf(b, inc)[0]).toMatchObject({ u: 2, k: b.pub });
    expect(cksOf(b, inc)).toHaveLength(1);
    sync(T, ...pages);
    run(pages, T + STEP, T + 2 * STEP);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, pending: false, holder: b.pub, base: { key: trim.key }, invalid: [] });
      expect(foldOf(p).rounds.find((x) => x.r === 2)).toMatchObject({ decided: 'house' });
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(chips.get(q.pid));
    }
  });

  it('a round in flight: the transfer at that round, and the seller\'s house\'s reveal still decides it', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    house(a, kit.houseJoin(H, 1));
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    clockOf(c, at);
    expect(c.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
    sync(closedAt, ...pages);
    expect(redeem(b, offerAt(a, b, closedAt), closedAt)).toEqual({ ok: true });
    expect(xfsOf(b, inc)[0]).toMatchObject({ u: 1, k: b.pub });
    sync(closedAt, ...pages);
    const [close] = closesOf(a, 1);
    const seedsAt = run(pages, closedAt + STEP, closedAt + 12_000, { until: () => pages.every((p) => keysIn(p, 'x', 1).length === 2) });
    house(c, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close)));
    sync(seedsAt, ...pages);
    run(pages, seedsAt + STEP, seedsAt + 10_000);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, holder: b.pub });
      const v = foldOf(p).rounds.find((x) => x.r === 1)!;
      expect(v).toMatchObject({ decided: 'house' });
      for (const q of [a, c]) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(v.deltas.get(q.pid)));
    }
  });
});

describe('what moves no game', () => {
  it('a bearer offer: the deed goes, the game stays the seller\'s, and nothing is left for it', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const o = offerAt(a, null, at);
    expect(redeem(b, o, at)).toEqual({ ok: true });
    expect(b.doc.getMap('roomInfo').get('owner')).toBe(b.pid);
    expect(keysUnder(b, 'do:')).toEqual([]);
    expect(xfsOf(b, inc)).toEqual([]);
    sync(at, ...pages);
    run(pages, at + STEP, at + 3_000);
    for (const p of pages) expect(res(p, inc)).toMatchObject({ live: true, holder: a.pub });
    expect(xfsOf(a, inc)).toEqual([]);
  });

  it('an offer made before the game opened (beyond the skew): the deed goes, the game stays', async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    const o = offerAt(a, b, at);
    const T = at + OFFER_SKEW_MS + 60_000;
    run(pages, at + STEP, T, { step: 5_000 });
    expect(press(a, T)).toBe('ok');
    sync(T, ...pages);
    const inc = nameOf(a, T);
    run(pages, T + STEP, T + 2 * STEP);
    expect(redeem(b, o, T + 3 * STEP)).toEqual({ ok: true });
    expect(xfsOf(b, inc)).toEqual([]);
    sync(T + 3 * STEP, ...pages);
    run(pages, T + 4 * STEP, T + 3_000);
    for (const p of pages) expect(res(p, inc)).toMatchObject({ live: true, holder: a.pub });
    expect(xfsOf(b, inc)).toEqual([]);
  });

  it('a plain rewrite of the room\'s owner: no transfer is written, by the tick either', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    b.doc.transact(() => b.doc.getMap('roomInfo').set('owner', b.pid));
    sync(at, ...pages);
    run(pages, at + STEP, at + 3_000);
    expect(xfsOf(b, inc)).toEqual([]);
    for (const p of pages) expect(res(p, inc)).toMatchObject({ live: true, holder: a.pub });
  });

  it('an offer left in the doc that its maker never signed, that another key than the holder\'s made, or made out to another key: the buyer\'s page writes nothing', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const good = offerAt(a, c, at);
    const forged = { ...offerAt(a, b, at), sig: good.sig };
    // (And one a key that does not hold the game made out to it, signed well.)
    const others = offerAt(c, b, at);
    b.doc.transact(() => {
      b.doc.getMap('roomInfo').set('owner', b.pid);
      for (const o of [good, forged, others]) top(b).set(`do:${o.nonce}`, definedOffer(o));
    });
    sync(at, ...pages);
    expect(b.casino.deedOffersTo(b.pub).map((o) => o.nonce)).toEqual([forged.nonce, others.nonce].sort());
    expect(b.casino.deedOffersTo(c.pub).map((o) => o.nonce)).toEqual([good.nonce]);
    const sent = updatesOf(b, () => { run(pages, at + STEP, at + 3_000, { each: undefined }); });
    expect(xfsOf(b, inc)).toEqual([]);
    expect(sent).toEqual([]);
    expect(res(b, inc)).toMatchObject({ holder: a.pub });
  });

  it('an offer left for a key that does not hold the deed: nothing, until it does', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const o = offerAt(a, b, at);
    a.doc.transact(() => top(a).set(`do:${o.nonce}`, definedOffer(o)));
    sync(at, ...pages);
    run(pages, at + STEP, at + 3_000);
    expect(xfsOf(b, inc)).toEqual([]);
    b.doc.transact(() => b.doc.getMap('roomInfo').set('owner', b.pid));
    sync(at + 3_000, ...pages);
    run(pages, at + 3_000 + STEP, at + 6_000);
    expect(xfsOf(b, inc)).toHaveLength(1);
    for (const p of pages) expect(res(p, inc)).toMatchObject({ live: true, holder: b.pub });
  });
});

describe('an offer moves a game once', () => {
  it('handed on and back again: the first offer, still in the doc, does not move the game a second time', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const first = offerAt(a, b, at);
    expect(redeem(b, first, at)).toEqual({ ok: true });
    sync(at, ...pages);
    run(pages, at + STEP, at + 2 * STEP);
    const T = at + 3 * STEP;
    expect(redeem(a, offerAt(b, a, T), T)).toEqual({ ok: true });
    sync(T, ...pages);
    run(pages, T + STEP, T + 2 * STEP);
    for (const p of pages) expect(res(p, inc).chain.map((h) => h.k)).toEqual([a.pub, b.pub, a.pub]);
    expect(xfsOf(a, inc)).toHaveLength(2);
    // A round under A's house again (so a transfer written now would be at another round than the first, a record of its own).
    const T2 = houseRound(pages, kit, 1, T + 3 * STEP).at;
    // The deed is B's again by a plain rewrite; the offer A once made out to B is in the doc still,
    // and B's page is a fresh load (it remembers nothing of what it wrote).
    expect(doOf(b, first.nonce)).toBeDefined();
    const b2 = await loadPage('B', 9, { reloadOf: b });
    clockOf(b2, T2);
    sync(T2, a, b2);
    b2.doc.transact(() => b2.doc.getMap('roomInfo').set('owner', b2.pid));
    sync(T2, a, b2);
    run([a, b2], T2 + STEP, T2 + 4_000);
    expect(b2.casino.deedHeldBy(b2.pub)).toBe(true);
    expect(xfsOf(b2, inc)).toHaveLength(2);
    for (const p of [a, b2]) expect(res(p, inc)).toMatchObject({ live: true, holder: a.pub, invalid: [] });
  });
});

describe('the deed is settled for a buyer whose page is away', () => {
  it('the settling page leaves the offer; the game stays the seller\'s until the buyer\'s page is in the room, which then moves it by itself, once', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const played = houseRound([a, c], kit, 1, at);
    const T = played.at;
    sync(T, ...pages);
    const o = offerAt(a, b, T);
    clockOf(a, T);
    // (The seller's client settles into the module's doc for the buyer: offers settleDeedInDoc.)
    const sent = updatesOf(a, () => {
      expect(a.offers.settleDeedInDoc(a.doc, o, { playerId: b.pid, name: b.name, keyB64: b.pub })).toEqual({ ok: true });
    });
    expect(sent).toHaveLength(1);
    expect(doOf(a, o.nonce)).toMatchObject({ nonce: o.nonce, toPub: b.pub });
    expect(xfsOf(a, inc)).toEqual([]);
    // Heard by the pages that are there: the seller's key holds the game still.
    sync(T, a, c);
    run([a, c], T + STEP, T + 3_000);
    for (const p of [a, c]) expect(res(p, inc)).toMatchObject({ live: true, holder: a.pub });
    expect(xfsOf(a, inc)).toEqual([]);
    // The buyer's page comes: it moves the game on its tick.
    const T2 = T + 3_000;
    sync(T2, ...pages);
    // (Not at once: its tables slept while it was away, and what it reads of the room may be behind. A lapse on it is awake.)
    run(pages, T2 + STEP, T2 + 2_000);
    expect(xfsOf(b, inc)).toEqual([]);
    const movedAt = run(pages, T2 + 2_000 + STEP, T2 + 60_000, { until: () => xfsOf(b, inc).length > 0 });
    expect(movedAt - T2).toBeGreaterThanOrEqual(b.croupier.TABLE_LEASE_LAPSE_MS);
    expect(movedAt - T2).toBeLessThan(b.croupier.TABLE_LEASE_LAPSE_MS + 1_000);
    expect(xfsOf(b, inc)).toHaveLength(1);
    expect(xfsOf(b, inc)[0]).toMatchObject({ u: 1, k: b.pub, o: { nonce: o.nonce } });
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, pending: false, holder: b.pub });
      for (const q of [a, c]) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
    run(pages, movedAt + STEP, movedAt + 4_000);
    expect(xfsOf(b, inc)).toHaveLength(1);
    expect(cksOf(b, inc)).toHaveLength(1);
  });

  it('a room that never had a FAIR ONLY game is left as it was: no offer record', async () => {
    const { pages, at } = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    const o = offerAt(a, b, at);
    expect(redeem(b, o, at)).toEqual({ ok: true });
    expect(keysUnder(b, 'do:')).toEqual([]);
  });
});

describe('the buyer\'s page cannot check the game as it redeems', () => {
  it('its doc holding part of an update: the deed moves and the offer is left, the game moves once the doc is whole', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const o = offerAt(a, b, at);
    // A slip of A's whose first half B never hears: B's doc holds part of an update.
    const made = updatesOf(a, () => {
      clockOf(a, at);
      a.casino.buyInChips(a.pid, 1);
      a.casino.buyInChips(a.pid, 1);
    });
    expect(made.length).toBe(2);
    Y.applyUpdate(b.doc, made[1], 'remote');
    expect(b.casino.casinoWhole(TABLE)).toBe(false);
    expect(redeem(b, o, at)).toEqual({ ok: true });
    expect(doOf(b, o.nonce)).toBeDefined();
    expect(xfsOf(b, inc)).toEqual([]);
    run([b], at + STEP, at + 2_000);
    expect(xfsOf(b, inc)).toEqual([]);
    Y.applyUpdate(b.doc, made[0], 'remote');
    expect(b.casino.casinoWhole(TABLE)).toBe(true);
    sync(at + 2_000, ...pages);
    run(pages, at + 2_000 + STEP, at + 5_000);
    expect(xfsOf(b, inc)).toHaveLength(1);
    for (const p of pages) expect(res(p, inc)).toMatchObject({ live: true, holder: b.pub });
  });
});

describe('the round the game changes hands at is one every page will read', () => {
  it('a decided round short of its closer\'s slip: no transfer while it is gone (the round would lose its house for good), and the transfer at that round once the slip is back', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B', 'C']);
    const [a, , c] = pages;
    const played = houseRound(pages, kit, 1, at);
    const T = played.at;
    const [close] = closesOf(a, 1);
    const closer = pages.find((p) => p.pub === close.k)!;
    const slip = keysIn(a, 's', 1).find((k) => k.startsWith(`s:1:${closer.pid}:`) && frozenOf(close).includes(hashIn(k)))!;
    expect(slip).toBeDefined();
    const gone = (now: number): void => {
      beat?.each(now);
      for (const p of pages) {
        const ses = p.casino.computedSessionForWrite(TABLE);
        if (ses?.has(slip)) p.doc.transact(() => ses.delete(slip));
      }
    };
    gone(T);
    sync(T, ...pages);
    expect(foldOf(c).rounds.some((x) => x.r === 1 && x.decided)).toBe(false);
    expect(redeem(c, offerAt(a, c, T), T)).toEqual({ ok: true });
    expect(xfsOf(c, inc)).toEqual([]);
    run(pages, T + STEP, T + 2_000, { each: gone });
    expect(xfsOf(c, inc)).toEqual([]);
    // Left alone the slip is put back, and the game moves at the round it decided.
    const movedAt = run(pages, T + 2_000 + STEP, T + 40_000, { until: () => xfsOf(c, inc).length > 0 });
    expect(movedAt).toBeLessThan(T + 40_000);
    expect(xfsOf(c, inc)[0]).toMatchObject({ u: 1, k: c.pub });
    sync(movedAt, ...pages);
    run(pages, movedAt + STEP, movedAt + 2 * STEP);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, holder: c.pub });
      for (const q of pages.slice(0, 2)) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(played.deltas.get(q.pid)));
    }
  });

  it('never under the round the seller took the game at: a page that has the seller\'s transfer and none of the rounds under it writes one at that round', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    // A round in flight as B takes the game: B holds it from round 1.
    house(a, kit.houseJoin(H, 1));
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    sync(at, ...pages);
    const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
    sync(closedAt, ...pages);
    expect(redeem(b, offerAt(a, b, closedAt), closedAt)).toEqual({ ok: true });
    expect(xfsOf(b, inc)[0]).toMatchObject({ u: 1 });
    // The session's records go (a peer's delete), and a fresh load of C's page hears the room as it is then.
    a.doc.transact(() => {
      const ses = a.casino.computedSessionForWrite(TABLE)!;
      for (const k of [...ses.keys()]) ses.delete(k);
    });
    const o = offerAt(b, c, closedAt);
    const c2 = await loadPage('C', 9, { reloadOf: c });
    clockOf(c2, closedAt);
    sync(closedAt, a, b, c2);
    run([c2], closedAt, closedAt);
    expect(foldOf(c2).rounds).toEqual([]);
    expect(res(c2, inc).chain.map((h) => [h.k, h.from])).toEqual([[a.pub, 0], [b.pub, 1]]);
    expect(redeem(c2, o, closedAt + STEP)).toEqual({ ok: true });
    expect(xfsOf(c2, inc).find((x) => x.k === c2.pub)).toMatchObject({ u: 1 });
    expect(res(c2, inc)).toMatchObject({ holder: c2.pub, invalid: [] });
  });
});

describe('the buyer ends the game it took with a round in flight', () => {
  it('its end order stands though the base is under its range: no page closes again, and its page writes the end once the round is decided', async () => {
    const { pages, at, inc, kit } = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    house(a, kit.houseJoin(H, 1));
    clockOf(a, at);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    clockOf(c, at);
    expect(c.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    const closedAt = run(pages, at + STEP, at + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
    sync(closedAt, ...pages);
    expect(redeem(b, offerAt(a, b, closedAt), closedAt)).toEqual({ ok: true });
    sync(closedAt, ...pages);
    run(pages, closedAt + STEP, closedAt + 2 * STEP);
    expect(off(b, closedAt + 3 * STEP)).toBe('ending');
    sync(closedAt + 3 * STEP, ...pages);
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: true, holder: b.pub, fin: { k: b.pub } });
      expect(p.casino.computedGamesEnding(b.pub)).toEqual([{ t: TABLE, inc }]);
    }
    const [close] = closesOf(a, 1);
    const seedsAt = run(pages, closedAt + 4 * STEP, closedAt + 12_000, { until: () => pages.every((p) => keysIn(p, 'x', 1).length === 2) });
    house(c, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close)));
    sync(seedsAt, ...pages);
    const v = foldOf(a).rounds.find((x) => x.r === 1)!;
    expect(v).toMatchObject({ decided: 'house' });
    run(pages, seedsAt + STEP, seedsAt + b.table.FAIR_END_WAIT_MS + 4 * STEP);
    expect(endOf(b, inc)).toMatchObject({ e: 1, u: 1, k: b.pub, f: { k: b.pub }, x: xfsOf(b, inc) });
    for (const p of pages) {
      expect(res(p, inc)).toMatchObject({ live: false, pending: false, base: { ck: { e: 1, u: 1 } } });
      for (const q of [a, c]) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(v.deltas.get(q.pid)));
    }
  });
});

describe('a flood of offers nobody signed', () => {
  it('costs the buyer\'s page a bounded number of checks a look, each forgery checked once: the good offer behind five forged ones moves the game on the third look', async () => {
    const { pages, at, inc } = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    expect(b.table.ADOPT_CHECKS_PER_LOOK).toBe(2);
    const made = Array.from({ length: 6 }, () => offerAt(a, b, at)).sort((x, y) => (x.nonce < y.nonce ? -1 : 1));
    const good = made[5];
    const forged = made.slice(0, 5).map((o) => ({ ...o, sig: good.sig }));
    b.doc.transact(() => {
      b.doc.getMap('roomInfo').set('owner', b.pid);
      for (const o of [...forged, good]) top(b).set(`do:${o.nonce}`, definedOffer(o));
    });
    sync(at, ...pages);
    // (Looks at at + STEP, + 2 STEP, + 3 STEP: two forgeries, two, then the fifth and the good one.)
    run(pages, at + STEP, at + 2 * STEP);
    expect(xfsOf(b, inc)).toEqual([]);
    run(pages, at + 3 * STEP, at + 3 * STEP);
    expect(xfsOf(b, inc)).toHaveLength(1);
    expect(xfsOf(b, inc)[0]).toMatchObject({ o: { nonce: good.nonce } });
  });
});
