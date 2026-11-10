/**
 * 🔒🧷 What a FAIR ONLY game stands on is held by the pages that counted it, and
 * put back (design §8.4 P2, PR 6c-4b-2): the checkpoint a page counts the game
 * from, the transfers of its chain, the end order standing and the delegations
 * of the houses whose records its fold counted. A peer that deletes one, or
 * writes junk over it, moves nothing on a page that counted it; the pages put
 * it back in turn, as the doc held it, and stand down when their put-backs do
 * not last. The live session's map, gone, is opened again.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the first page's doc as its owner's page would write it;
 * the houses are TestHouses whose records a spec writes by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, finKey, sealFin, xfId, xfKey } from './computedFairOnly';
import { asClose, dutyRank, nextSid3 } from './computedFold';
import type { CloseRec } from './computedFold';
import { buyer, delegation, fourth, hex, house as H, house2 as H2, NAME, owner, rootOf, stranger, third, trimOf, xferOf } from './computedFairOnlyKit';
import { Beating, beatOf, clockOf, deliver, frame, keysIn, loadPage, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run as runBare, send, sync, updatesOf } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red } from './computedTestKit';
import type { Built, TestHouse } from './computedTestKit';
import { delegationKey } from './computedHouse';
import { verifyIdentityStrict } from './keypair';

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

/** The roulette game the owner opens at the table, in the page kit's room: its root names house H. */
const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(G, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const kit = new ComputedKit(G);
/** The session the root opens, and its key. */
const SID = nextSid3(G, root.value);
const SES = `ses:${TABLE}:${G.inc}:${SID}`;
/** Another table of the room, and its game. */
const T2 = 'roulette-2';
const G2 = { room: PAGE_ROOM, t: T2, inc: faironlyInc('p', PAGE_ROOM, T2, NAME) };

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const hashIn = (key: string): string => key.slice(key.lastIndexOf(':') + 1);
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(p.casino.computedSessionForWrite(TABLE)!.get(k))!);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const res = (p: Page) => p.casino.computedResolutionOf(TABLE, G.inc)!;
/** What page p's put-back duty finds to do. */
const lacks = (p: Page) => p.casino.computedFairOnlyRecoveries();
/** Page p puts back what it holds of the game, by hand: how many records. */
const putBack = (p: Page): number => p.casino.putBackFairOnlyRecords(TABLE, G.inc);
/** The house's records put in the game's live session on page p. */
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]));
const set = (p: Page, key: string, value: unknown): void => p.doc.transact(() => { top(p).set(key, value); });
const del = (p: Page, ...keys: string[]): void => p.doc.transact(() => keys.forEach((k) => top(p).delete(k)));

/** The houses that beat while a spec runs its game, as their nodes do. */
let beating: Beating[] = [];
/** The spec's time at the step that runs (run, frames). */
let NOW = T0;
const run = (pages: Page[], from: number, to: number, opts: Parameters<typeof runBare>[3] = {}): number => {
  const each = opts.each ?? ((T: number) => beating.forEach((b) => b.each(T)));
  return runBare(pages, from, to, { step: STEP, ...opts, each: (T) => { NOW = T; each(T); } });
};

/** Frames of page p alone every STEP from `from` to `to` (inclusive); `peer(T)` acts first in each, at the page's
 *  clock: what it does to the page's doc, the frame finds done. Returns `to` + STEP. */
function frames(p: Page, from: number, to: number, peer?: (T: number) => void): number {
  let T = from;
  for (; T <= to; T += STEP) {
    NOW = T;
    clockOf(p, T);
    peer?.(T);
    frame(T, p);
  }
  return T;
}

/** A peer's writes, each made in page x's doc and handed to page y before the next is made, at T: page y's doc
 *  applies them one by one, as they come over a network. */
function handed(T: number, x: Page, y: Page, ...acts: (() => void)[]): void {
  for (const act of acts) {
    clockOf(x, T);
    act();
    send(T, x, y);
  }
}

/** `pages`, 1,000 chips each, and the game open in the first one's doc (its root, and the live session it opens), all
 *  synced at T0. */
function openGame(pages: Page[]): Page[] {
  beating = [];
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  const [a] = pages;
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(SES, new Y.Map());
  });
  sync(T0, ...pages);
  runBare(pages, T0, T0, { step: STEP }); // (awake)
  return pages;
}

/** Pages `names` (`hears`: listening to the room as main.ts has them listen, deaf until told), the game open. */
async function gameRoom(names: string[], opts: { hears?: boolean } = {}): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1, opts));
  return openGame(pages);
}

/** Whether page x comes before page y in the turns of `duty` at round `u`. */
const before = (duty: 'restore' | 'open', u: number, x: Page, y: Page): boolean => dutyRank(duty, G, u, x.pub) < dutyRank(duty, G, u, y.pub);

/** Pages A and B for which `fits` holds (a page's key is new with every load, and the turns go by the keys: one of
 *  the two is loaded again, by turns, until it does: a first page whose rank is among the last would leave few second
 *  ones that come after it), the game open. */
async function pagesWhere(fits: (a: Page, b: Page) => boolean, more: string[] = []): Promise<Page[]> {
  let a = await loadPage('A', 1);
  let b = await loadPage('B', 2);
  for (let i = 0; i < 64 && !fits(a, b); i++) {
    if (i % 2 === 0) b = await loadPage('B', 2);
    else a = await loadPage('A', 1);
  }
  expect(fits(a, b)).toBe(true);
  const pages = [a, b];
  for (const [i, name] of more.entries()) pages.push(await loadPage(name, i + 3));
  return openGame(pages);
}

/** A wait of `ms` as the frames of a spec see it over: at the first frame at or past it. */
const framed = (ms: number): number => Math.ceil(ms / STEP) * STEP;

/** The put-backs of `key` that `pages` make from here on, as they are made: by which page, and at which step of the
 *  spec (run, frames). A put-back is a transaction of the page's own that leaves the key in its doc: what a spec
 *  writes into a page's doc by hand counts too, so a peer's writes are made in another doc and handed over. */
function putBacksOf(pages: Page[], key: string): { by: string; at: number }[] {
  const out: { by: string; at: number }[] = [];
  for (const p of pages) {
    p.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.local && tr.changed.get(top(p) as never)?.has(key) && top(p).has(key)) out.push({ by: p.pid, at: NOW });
    });
  }
  return out;
}

/** A page that binds the doc as page p holds it now, at T, and keeps one verdict of a FAIR ONLY signature at a time:
 *  each check pushes the one before out of its cache. */
async function oneVerdictFrom(p: Page, T: number): Promise<Page> {
  const late = await loadPage('Late', 9);
  late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0 });
  clockOf(late, T);
  Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(p.doc));
  return late;
}

/** A page that binds the doc as page p holds it now, at T: it counted nothing before. */
async function lateFrom(p: Page, T: number, clientID = 9): Promise<Page> {
  const late = await loadPage('Late', clientID);
  clockOf(late, T);
  Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(p.doc));
  return late;
}

/** The room's doc bound again on page p, holding what it held. */
function rebind(p: Page): void {
  const doc2 = new Y.Doc();
  doc2.clientID = 77;
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(p.doc));
  p.casino.setComputedVerifyForTests({ now: () => 0 });
  p.casino.bindCasinoDoc(doc2, PAGE_ROOM);
  p.doc = doc2;
}

/** The deed offer of a hand-over is of the page kit's room. */
const DEED = { asset: { kind: 'deed' as const, roomId: PAGE_ROOM, roomName: 'Furlong' } };
/** The game handed from the owner to the buyer after round `u`. */
const handOver = (u = 1) => xferOf(G, owner, buyer, u, DEED);

/** The owner ends the game (the end checkpoint, which carries the order). */
function endGame(a: Page) {
  const end = trimOf(G, 'p', { ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(G, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {} });
  set(a, end.key, end.value);
  return end;
}

/** A and B bet on round 1 (A red 10, B black 20), house h's join in its session, all synced at T0. */
function bet(a: Page, b: Page, h: TestHouse = H): void {
  house(a, kit.houseJoin(h, 1));
  expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
  expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
  sync(T0, a, b);
}

/** Round 1 played by A and B and decided by house h's reveal, which carries no commitment for the next (so that the
 *  round after waits for no house: h is behind the game, not ahead of it). A house other than the root's is delegated
 *  by the owner in the room (`hk:`). All synced; the pages and the time. */
async function decidedBy(h: TestHouse) {
  const [a, b] = await gameRoom(['A', 'B']);
  if (h !== H) set(a, delegationKey(h.pub), delegation(owner, h.pub, PAGE_ROOM));
  bet(a, b, h);
  beating = [new Beating(a, h)];
  const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { until: () => keysIn(a, 'c', 1).length > 0 });
  const [close] = closesOf(a, 1);
  run([a, b], closedAt + STEP, closedAt + 12_000);
  house(b, kit.houseReveal(h, 1, [hashIn(keysIn(a, 'c', 1)[0])], Object.values(close.f).sort(), { c: null }));
  const at = closedAt + 12_000 + STEP;
  sync(at, a, b);
  for (const p of [a, b]) {
    expect(foldOf(p).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(foldOf(p).required).toBeNull();
  }
  return { a, b, at };
}

describe('what a page holds of a game, and what the doc lacks of it', () => {
  it('a base deleted, or junk at its key, is counted from all the same, listed, and put back as the doc held it; the same record there is nothing to put back', async () => {
    const [a] = await gameRoom(['A']);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    del(a, root.key);
    expect(res(a)).toMatchObject({ live: true, base: { key: root.key } });
    expect(lacks(a)).toEqual([{ t: TABLE, inc: G.inc, ctx: G, u: 0, missing: 1, sessionMissing: false, sid: SID, sesMoves: 1, pubs: [], returns: 0 }]);
    // (the one move of a session's key: the map the game was opened with)
    expect(putBack(a)).toBe(1);
    expect(top(a).get(root.key)).toEqual(root.value);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    // junk over it
    set(a, root.key, { junk: 1 });
    expect(res(a)).toMatchObject({ live: true, base: { key: root.key } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(root.key)).toEqual(root.value);
    // the record written again by a peer is another value that reads the same: nothing lacks
    set(a, root.key, { ...root.value });
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('counts each time what the doc lacked of the game is all there again, whoever put it back and however soon it went: not a record written over itself, nor one of the two missing', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const returns = (p: Page): number => p.casino.computedFairOnlyReturns(TABLE, G.inc);
    const xf = handOver(0);
    set(a, xf.key, xf.value);
    sync(T0, a, b);
    expect([returns(a), returns(b)]).toEqual([0, 0]);
    // page A's own put-back, and page B handed it
    del(a, root.key);
    sync(T0, a, b);
    expect(putBack(a)).toBe(1);
    expect(returns(a)).toBe(1);
    sync(T0, a, b);
    expect(returns(b)).toBe(1);
    // the record written over itself is no put-back
    set(b, root.key, { ...root.value });
    sync(T0, a, b);
    expect([returns(a), returns(b)]).toEqual([1, 1]);
    // two missing, one back: not all of it yet
    del(a, root.key, xf.key);
    set(a, root.key, root.value);
    expect(returns(a)).toBe(1);
    set(a, xf.key, xf.value);
    expect(returns(a)).toBe(2);
    // deleted and put back and deleted again before the page looks: each is counted
    for (let i = 0; i < 3; i++) {
      del(a, root.key);
      set(a, root.key, root.value);
    }
    del(a, root.key);
    expect(returns(a)).toBe(5);
    // a game this page doesn't track
    expect(a.casino.computedFairOnlyReturns(T2, G2.inc)).toBe(0);
    expect(lacks(a)).toMatchObject([{ returns: 5 }]);
  });

  it('counts a put-back while the game\'s session is gone from the doc too: the table is not whole then and the game is not counted, but what came back did', async () => {
    const [a] = await gameRoom(['A']);
    const returns = (): number => a.casino.computedFairOnlyReturns(TABLE, G.inc);
    del(a, SES);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    del(a, root.key);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true, returns: 0 }]);
    expect(putBack(a)).toBe(1);
    expect(returns()).toBe(1);
    del(a, root.key);
    set(a, root.key, root.value);
    expect(returns()).toBe(2);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
  });

  it('judges nothing on a doc that holds part of an update: what reads as gone there, and is there when the doc is whole, never came back', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const returns = (): number => a.casino.computedFairOnlyReturns(TABLE, G.inc);
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come)
    del(a, root.key);
    set(a, root.key, root.value);
    deliver(T0, a, [first]);
    expect(returns()).toBe(0);
    expect(lacks(a)).toEqual([]);
    // what lacked before the doc held part, and is there when it is whole again, did come back: once, however often
    // it went and came meanwhile
    const [third, fourth] = updatesOf(b, () => {
      set(b, 'x:3', 3);
      set(b, 'x:4', 4);
    });
    del(a, root.key);
    deliver(T0, a, [fourth]);
    set(a, root.key, root.value);
    del(a, root.key);
    set(a, root.key, root.value);
    expect(returns()).toBe(0);
    deliver(T0, a, [third]);
    expect(returns()).toBe(1);
  });

  it('the turns are the staked felts\' signers, as the page last counted them', async () => {
    // (told in the order of the keys, whichever of the two pages has the lower: a page's key is new with every load)
    let pages: Page[] = [];
    for (const lower of [false, true]) {
      pages = await pagesWhere((x, y) => (x.pub < y.pub) === lower);
      bet(pages[0], pages[1]);
      del(pages[0], root.key);
      expect(lacks(pages[0])).toMatchObject([{ missing: 1, pubs: [pages[0].pub, pages[1].pub].sort() }]);
      expect(putBack(pages[0])).toBe(1);
    }
    const [a, b] = pages;
    // B takes its bets down: a felt with nothing on it has no turn
    expect(b.table.writeComputedSlip(TABLE, [], T0 + STEP)).toBe('ok');
    run([a, b], T0 + STEP, T0 + 3_000);
    expect(foldOf(a).felts.get(b.pid)?.rec.b).toEqual([]);
    del(a, root.key);
    expect(lacks(a)).toMatchObject([{ missing: 1, pubs: [a.pub] }]);
  });

  it('an ended game\'s end checkpoint is put back, and nothing else of it: not the base it left behind, nor the order its end carries', async () => {
    const [a] = await gameRoom(['A']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    // (the game handed over after the round it ended at: the end is the owner's, the chain goes on to the buyer)
    const xf = handOver(5);
    set(a, xf.key, xf.value);
    const end = endGame(a);
    expect(res(a)).toMatchObject({ live: false, base: { key: end.key }, holder: buyer.pub });
    del(a, root.key, fin.key, SES, xf.key);
    expect(res(a)).toMatchObject({ live: false, base: { key: end.key }, holder: buyer.pub });
    expect(lacks(a)).toEqual([]);
    del(a, end.key);
    expect(res(a)).toMatchObject({ live: false, base: { key: end.key }, fin: { k: owner.pub } });
    expect(lacks(a)).toMatchObject([{ u: 5, missing: 1, sessionMissing: false }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(end.key)).toEqual(end.value);
    expect([root.key, fin.key, SES, xf.key].map((k) => top(a).has(k))).toEqual([false, false, false, false]);
  });

  it('a base the page counts from no more is not put back', async () => {
    const [a] = await gameRoom(['A']);
    const trim = trimOf(G, 'p', { b: SID, u: 3, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, h: kit.houseCommit(H, 4), dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a).base?.key).toBe(trim.key);
    del(a, root.key);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('nor is one the game moved on from while the page did not count it: the trim that deletes it comes while its doc holds part of an update', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come)
    const trim = trimOf(G, 'p', { b: SID, u: 3, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, h: kit.houseCommit(H, 4), dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(root.key);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    expect(res(a).base?.key).toBe(trim.key);
    expect(lacks(a)).toEqual([]);
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    expect(top(a).has(root.key)).toBe(false);
  });

  it('a transfer of the chain deleted, or junk at its key, leaves the game its buyer\'s and is put back; one the chain does not use is not', async () => {
    const [a] = await gameRoom(['A']);
    const xf = handOver(1);
    const later = xferOf(G, owner, third, 2, DEED); // (the owner's again, from a later round: the chain takes the first)
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(later.key, later.value);
    });
    expect(res(a)).toMatchObject({ holder: buyer.pub, live: true });
    expect(lacks(a)).toEqual([]);
    del(a, xf.key, later.key);
    expect(res(a)).toMatchObject({ holder: buyer.pub, live: true });
    // a page that binds the doc now never counted the transfer: the game is the owner's there
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: owner.pub, live: true });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(xf.key)).toEqual(xf.value);
    expect(top(a).has(later.key)).toBe(false);
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: buyer.pub, live: true });
    set(a, xf.key, { junk: 1 });
    expect(res(a).holder).toBe(buyer.pub);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(xf.key)).toEqual(xf.value);
    // written again by a peer: the doc's own value is the record, and nothing lacks
    set(a, xf.key, { ...xf.value });
    expect(res(a).holder).toBe(buyer.pub);
    expect(lacks(a)).toEqual([]);
    // an earlier transfer of the owner's takes the chain another way: the one it has no more is let go
    const earlier = xferOf(G, owner, third, 0, DEED);
    set(a, earlier.key, earlier.value);
    expect(res(a)).toMatchObject({ holder: third.pub, pending: false });
    del(a, xf.key);
    expect(lacks(a)).toEqual([]);
    del(a, earlier.key);
    expect(res(a).holder).toBe(third.pub);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
  });

  it('keeps the transfer it held while a resolution waits for a check that came before it in the chain', async () => {
    const [a] = await gameRoom(['A']);
    const xf = handOver(1);
    set(a, xf.key, xf.value);
    expect(res(a).holder).toBe(buyer.pub);
    // a transfer of the owner's from an earlier round comes while no check can run: the chain waits at it
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const forged = { ...xferOf(G, owner, third, 0, DEED).value, g: xf.value.g };
    set(a, xfKey(TABLE, G.inc, xfId(forged)!), forged);
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub });
    // (the held transfer written again by a peer meanwhile is the same record under its key: nothing lacks)
    set(a, xf.key, { ...xf.value });
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub });
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    // checks run again, and the transfer the page held is deleted: the earlier one fails, and the held one stands
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    del(a, xf.key);
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub });
    expect(putBack(a)).toBe(1);
    expect(top(a).get(xf.key)).toEqual(xf.value);
  });

  it('a resolution that waits for a check takes from a page no base it holds: a forged transfer of an earlier round not checked yet, the root written again and the buyer\'s checkpoint deleted, in one write, and the game counts from the buyer\'s checkpoint again once the check has run', async () => {
    const [a] = await gameRoom(['A']);
    const xf = handOver(1);
    // the game handed over after round 1, and the buyer's house trims at round 3 (a trim deletes the checkpoint it
    // replaces)
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).delete(root.key);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    const stands = { pending: false, live: true, holder: buyer.pub, base: { key: trim.key } };
    expect(res(a)).toMatchObject(stands);
    // no check can run, and a peer writes a transfer of the owner's from round 0 with a signature that is not its
    // own, the root again, and deletes the buyer's checkpoint: the chain waits at the transfer, the game is the
    // owner's as far as it is checked, and the root is the best base of the owner's
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const forged = { ...xferOf(G, owner, third, 0, DEED).value, g: xf.value.g };
    a.doc.transact(() => {
      top(a).set(xfKey(TABLE, G.inc, xfId(forged)!), forged);
      top(a).set(root.key, root.value);
      top(a).delete(trim.key);
    });
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub, base: { key: root.key } });
    // (the root deleted again while the check waits: the page counts from it still, as from any base it counted
    // from, and holds the buyer's checkpoint through that count too)
    del(a, root.key);
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub, base: { key: root.key } });
    // checks run again, and the game is resolved again: the forged transfer fails, and the page counts from the
    // checkpoint it held, which it puts back
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    set(a, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(a)).toMatchObject(stands);
    expect(lacks(a)).toMatchObject([{ u: 3, missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(trim.key)).toEqual(trim.value);
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject(stands);
  });

  it('a transfer the chain found only inside a checkpoint that is not the base is held, and put under the key that is its own: the buyer\'s first checkpoint carries it, the seller\'s last of that round is the base, and with the buyer\'s deleted the game is the buyer\'s still', async () => {
    const [a] = await gameRoom(['A']);
    const xf = handOver(1);
    const ses = (base: { value: unknown }): string => `ses:${TABLE}:${G.inc}:${nextSid3(G, base.value as never)}`;
    // the buyer's house takes the game up at round 1 with the transfer in its checkpoint, and no key holds the
    // transfer: the page holds it from the count that went by it, and the doc lacks it under its key (it is left
    // lacking here: what the page holds is what the rest stands on)
    const taken = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(taken.key, taken.value);
      top(a).delete(SES);
      top(a).set(ses(taken), new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, holder: buyer.pub, base: { key: taken.key } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(top(a).has(xf.key)).toBe(false);
    // the seller's house swept at that round, and its checkpoint comes now: of the two of the round the sweep is the
    // base, and the buyer's checkpoint, which alone has the transfer, is one no page holds
    const sweep = trimOf(G, 'p', { b: SID, u: 1, w: 1, n: {}, h: undefined, dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(sweep.key, sweep.value);
      top(a).delete(ses(taken));
      top(a).set(ses(sweep), new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, holder: buyer.pub, base: { key: sweep.key } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    // the buyer's checkpoint is deleted (a peer does, and compaction will): the game is the buyer's still on the page
    // that counted it, and the seller's on one that comes then
    del(a, taken.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, holder: buyer.pub, base: { key: sweep.key } });
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: owner.pub, live: true });
    // put back: the transfer, under its own key (and not the buyer's checkpoint: the game does not count from it)
    expect(putBack(a)).toBe(1);
    expect(top(a).has(taken.key)).toBe(false);
    expect(top(a).get(xf.key)).toEqual(xf.value);
    expect(lacks(a)).toEqual([]);
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: buyer.pub, live: true });
    // and it is held from there as any other: deleted, the game is the buyer's still, and it is put back
    del(a, xf.key);
    expect(res(a).holder).toBe(buyer.pub);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(xf.key)).toEqual(xf.value);
  });

  it('a transfer found only inside the checkpoint a resolution names its base is held as well: the page holds a base once it has counted from it, and it counts nothing while its doc holds part of an update', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const xf = handOver(1);
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // the buyer's first checkpoint comes, the transfer in it and under no key: the game is resolved, and not counted
    const taken = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    set(a, taken.key, taken.value);
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub, base: { key: taken.key } });
    // deleted before the page has counted from it, it is a base the page does not hold: the transfer it holds
    del(a, taken.key);
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub, base: { key: root.key } });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub, base: { key: root.key } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(xf.key)).toEqual(xf.value);
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: buyer.pub, live: true });
  });

  it('a transfer the page holds is held on while the chain that leaves it out is one the page has not counted from: an earlier transfer takes the chain another way while its doc holds part of an update, the later ones are deleted, and when the chain comes back to their seller the game is the last buyer\'s still', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    // the game handed to the buyer after round 1, and by the buyer to a third after round 2
    const xf = handOver(1);
    const on = xferOf(G, buyer, third, 2, { ...DEED, nonce: hex('2', 24) }); // (each offer its own nonce: a chain takes one once)
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(on.key, on.value);
    });
    expect(res(a)).toMatchObject({ pending: false, holder: third.pub });
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come: the page counts nothing meanwhile)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // an earlier transfer of the owner's, to a fourth, takes the chain another way: an answer that waits for nothing,
    // and one the page does not count from
    const earlier = xferOf(G, owner, fourth, 0, { ...DEED, nonce: hex('3', 24) });
    set(a, earlier.key, earlier.value);
    expect(res(a)).toMatchObject({ pending: false, holder: fourth.pub });
    // the two it leaves out are deleted, and the fourth hands the game to the buyer after round 1: the buyer's own
    // hand-over is of the chain again, as the page held it
    del(a, xf.key, on.key);
    const back = xferOf(G, fourth, buyer, 1, { ...DEED, nonce: hex('4', 24) });
    set(a, back.key, back.value);
    expect(res(a)).toMatchObject({ pending: false, holder: third.pub });
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: buyer.pub });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, holder: third.pub });
    // counted, the page puts back the one of the chain the doc lacks; the owner's hand-over to the buyer, which the
    // chain has no more, is let go of there
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(on.key)).toEqual(on.value);
    expect(top(a).has(xf.key)).toBe(false);
  });

  it('nor does a count whose answer names no base let go of one: the root gone and the buyer\'s checkpoint held, an earlier transfer takes the chain off that checkpoint, the later transfers are deleted, and when the chain comes back to their seller the game is the last buyer\'s still', async () => {
    const [a] = await gameRoom(['A']);
    // the game handed to the buyer after round 1, trimmed by the buyer's house at round 3, and handed on after round 4
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    const on = xferOf(G, buyer, third, 4, { ...DEED, nonce: hex('2', 24) });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).set(on.key, on.value);
      top(a).delete(root.key);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: third.pub });
    // an earlier transfer of the owner's: the checkpoint the page holds is of another chain now, and there is no other
    const earlier = xferOf(G, owner, fourth, 0, { ...DEED, nonce: hex('3', 24) });
    set(a, earlier.key, earlier.value);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, base: null, holder: fourth.pub });
    expect(lacks(a)).toEqual([]);
    del(a, xf.key, on.key);
    const back = xferOf(G, fourth, buyer, 1, { ...DEED, nonce: hex('4', 24) });
    set(a, back.key, back.value);
    expect(res(a)).toMatchObject({ pending: false, holder: third.pub });
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: buyer.pub });
  });

  it('an end order deleted, or another written over it that does not stand, leaves the order standing and is put back', async () => {
    const [a] = await gameRoom(['A']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    expect(res(a)).toMatchObject({ live: true, fin: { k: owner.pub } });
    expect(lacks(a)).toEqual([]);
    del(a, fin.key);
    expect(res(a)).toMatchObject({ live: true, fin: { k: owner.pub } });
    expect((await lateFrom(a, T0)).casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: true, fin: null });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(fin.key)).toEqual(fin.value);
    // an order by a key that never held the game, one whose signature is another game's, junk: each is written over
    const others = [sealFin(G, stranger.pub, stranger.sign).value, { ...fin.value, g: sealFin(G2, owner.pub, owner.sign).value.g }, { junk: 1 }];
    for (const other of others) {
      set(a, fin.key, other);
      expect(res(a).fin).toEqual(fin.value);
      expect(putBack(a)).toBe(1);
      expect(top(a).get(fin.key)).toEqual(fin.value);
    }
    // the order written again by a peer is the doc's own from then on
    set(a, finKey(TABLE, G.inc), { ...fin.value });
    expect(res(a).fin).toEqual(fin.value);
    expect(lacks(a)).toEqual([]);
    // another order whose check is put off: nothing is written over it while it may be the one that stands
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const unchecked = { ...fin.value, g: sealFin(G, buyer.pub, buyer.sign).value.g };
    set(a, fin.key, unchecked);
    expect(res(a)).toMatchObject({ pending: true, fin: fin.value });
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    // (checks run again, and the game is resolved again: the order fails its check)
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    set(a, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(a)).toMatchObject({ pending: false, fin: fin.value });
    expect(putBack(a)).toBe(1);
    expect(top(a).get(fin.key)).toEqual(fin.value);
  });

  it('an end order the page holds gives way to no other while a check waits: a forged transfer of an earlier round not checked yet, the root written again and the seller\'s own order over the buyer\'s, and the buyer\'s stands again once the check has run', async () => {
    const [a] = await gameRoom(['A']);
    // the owner orders the end, then hands the game over after round 1 all the same; the buyer's house trims at round
    // 3, where the owner's order stands no more, and the buyer orders the end
    const sellers = sealFin(G, owner.pub, owner.sign);
    set(a, sellers.key, sellers.value);
    expect(res(a).fin).toEqual(sellers.value);
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).delete(root.key);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: buyer.pub, fin: null });
    const buyers = sealFin(G, buyer.pub, buyer.sign);
    set(a, buyers.key, buyers.value);
    const stands = { pending: false, live: true, base: { key: trim.key }, holder: buyer.pub, fin: { k: buyer.pub } };
    expect(res(a)).toMatchObject(stands);
    expect(lacks(a)).toEqual([]);
    // no check can run, and a peer writes a forged transfer of the owner's from round 0, the root again, and the
    // owner's order over the buyer's: as far as the chain is checked the game is the owner's, and its order stands
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const forged = { ...xferOf(G, owner, third, 0, DEED).value, g: xf.value.g };
    a.doc.transact(() => {
      top(a).set(xfKey(TABLE, G.inc, xfId(forged)!), forged);
      top(a).set(root.key, root.value);
      top(a).set(sellers.key, sellers.value);
    });
    expect(res(a)).toMatchObject({ pending: true, base: { key: root.key }, holder: owner.pub, fin: { k: owner.pub } });
    // checks run again: the forged transfer fails, the buyer's order stands as the page held it, and is put back
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    set(a, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(a)).toMatchObject(stands);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(buyers.key)).toEqual(buyers.value);
  });

  it('an order first found standing by a resolution that waits is held while it waits, a page holding none: deleted then, it stands for as long, and is let go once an answer that has every check finds none standing', async () => {
    const [a] = await gameRoom(['A']);
    const sellers = sealFin(G, owner.pub, owner.sign);
    set(a, sellers.key, sellers.value);
    expect(res(a).fin).toEqual(sellers.value);
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).delete(root.key);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    // (the owner's order is at its key still, and stands no more: the page holds none)
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: buyer.pub, fin: null });
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const forged = { ...xferOf(G, owner, third, 0, DEED).value, g: xf.value.g };
    a.doc.transact(() => {
      top(a).set(xfKey(TABLE, G.inc, xfId(forged)!), forged);
      top(a).set(root.key, root.value);
    });
    expect(res(a)).toMatchObject({ pending: true, base: { key: root.key }, holder: owner.pub, fin: { k: owner.pub } });
    del(a, sellers.key);
    expect(res(a)).toMatchObject({ pending: true, base: { key: root.key }, holder: owner.pub, fin: { k: owner.pub } });
    // (not put back while a check waits)
    expect(putBack(a)).toBe(0);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    set(a, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: buyer.pub, fin: null });
    expect(lacks(a)).toEqual([]);
    expect(top(a).has(sellers.key)).toBe(false);
  });

  it('an end order the page holds is held on when the end checkpoint that carries it comes while the page does not count the game: the checkpoint and the order deleted before it does, the order stands, and is put back', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    expect(res(a)).toMatchObject({ live: true, fin: { k: owner.pub } });
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come: the page counts nothing meanwhile)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    const end = endGame(a);
    expect(res(a)).toMatchObject({ pending: false, live: false, base: { key: end.key } });
    // the page has not counted from the end checkpoint, and holds it not: with it and the order deleted the game is
    // live from the root again, and the order the page held stands
    del(a, end.key, fin.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key }, fin: { k: owner.pub } });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key }, fin: { k: owner.pub } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(fin.key)).toEqual(fin.value);
  });

  it('an end order found only inside an end checkpoint is held as well, by a page that holds none: the checkpoint comes while the page does not count the game and is deleted before it does, and the order stands at the root, and is put under its key', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(res(a)).toMatchObject({ live: true, fin: null });
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come: the page counts nothing meanwhile)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // the game ends by a checkpoint that carries the owner's order, with nothing under the order's own key
    const end = endGame(a);
    const key = sealFin(G, owner.pub, owner.sign).key;
    expect(top(a).has(key)).toBe(false);
    expect(res(a)).toMatchObject({ pending: false, live: false, base: { key: end.key } });
    // the page holds the root, not the end checkpoint: with that one deleted the game is live from the root again,
    // and the order it carried stands there as the page held it
    del(a, end.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key }, fin: { k: owner.pub } });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key }, fin: { k: owner.pub } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(end.value.f);
  });

  it('an end order the page holds is held on while the base at which it stands no more is one the page has not counted from: the buyer\'s checkpoint comes while its doc holds part of an update, and with it and the order deleted before the page counts, the order stands at the base the page holds, and is put back', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    expect(res(a)).toMatchObject({ live: true, fin: { k: owner.pub } });
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come: the page counts nothing meanwhile)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // the game handed over after round 1 all the same, and the buyer's house trims at round 3, where the owner's
    // order stands no more: an answer that waits for nothing, and one the page does not count from
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
    });
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: buyer.pub, fin: null });
    // the page holds the root, not the buyer's checkpoint: with that one and the order deleted the game is at the
    // root again, where the owner's order stands as the page held it
    del(a, trim.key, fin.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key }, fin: { k: owner.pub } });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key }, fin: { k: owner.pub } });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(fin.key)).toEqual(fin.value);
  });

  it('and is let go of once the page counts from that base: whole again with the buyer\'s checkpoint there, the owner\'s order deleted is not put back', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]);
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: buyer.pub, fin: null });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    del(a, fin.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key }, holder: buyer.pub, fin: null });
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    // (nor does the root deleted bring it back: the page holds the buyer's checkpoint now)
    del(a, root.key, trim.key);
    expect(res(a)).toMatchObject({ pending: false, base: { key: trim.key }, holder: buyer.pub, fin: null });
  });

  it('an end order written again by a peer while the page does not count the game is nothing the doc lacks: the answer stands on the doc\'s, and the page puts nothing over it', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    expect(res(a).fin).toEqual(fin.value);
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come: the page counts nothing meanwhile)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    set(a, fin.key, { ...fin.value });
    expect(res(a)).toMatchObject({ pending: false, live: true, fin: { k: owner.pub } });
    expect(lacks(a)).toEqual([]);
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('an end order that stands no more is let go: the game moved on to a base its signer did not hold the game at', async () => {
    const [a] = await gameRoom(['A']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    expect(res(a).fin).toEqual(fin.value);
    // the game handed over after round 1, and the buyer's house trims at round 3
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key }, holder: buyer.pub, fin: null });
    del(a, fin.key);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('and the page holds the next one then: the buyer\'s own order, first found standing while the page does not count the game, is held, and deleted before the page counts it stands, and is put back', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const fin = sealFin(G, owner.pub, owner.sign);
    set(a, fin.key, fin.value);
    const xf = handOver(1);
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H2, 4), k: H2.pub, dl: delegation(buyer, H2.pub, PAGE_ROOM), x: [xf.value] });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    // counted from the buyer's checkpoint, the page has let go of the owner's order, which is at its key still
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key }, holder: buyer.pub, fin: null });
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T0, a, [second]); // (it builds on the first, which has not come: the page counts nothing meanwhile)
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    const buyers = sealFin(G, buyer.pub, buyer.sign);
    set(a, buyers.key, buyers.value);
    expect(res(a)).toMatchObject({ pending: false, live: true, fin: { k: buyer.pub } });
    del(a, buyers.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key }, fin: { k: buyer.pub } });
    deliver(T0, a, [first]);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(buyers.key)).toEqual(buyers.value);
  });

  it('the delegation of a house whose round is behind the game is held: deleted, or with junk, a stranger\'s delegation of the house or a forged one at its key, the round stays decided and it is put back', async () => {
    const { a, b } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    const chips = [a, b].map((p) => a.casino.readChips(p.pid));
    const stands = (): void => {
      expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
      expect([a, b].map((p) => a.casino.readChips(p.pid))).toEqual(chips);
    };
    // (the house is none the page hears for the next close: its reveal carried no commitment, and nobody has joined)
    expect([...a.casino.computedGameHouses(TABLE, G.inc)]).toEqual([]);
    expect(lacks(a)).toEqual([]);
    del(a, key);
    stands();
    // a page that binds the doc now never counted the delegation: the round is undecided there
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.rounds.map((v) => v.decided)).toEqual([]);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    // what a peer may write there in its place, each leaving a page that comes later with no house: junk; a
    // delegation of the house by a key that holds no game (a stranger's, and a buyer's nothing was handed to); one in
    // the owner's name whose signature is another record's
    const forged = { ...dl, g: delegation(owner, H.pub, PAGE_ROOM).g };
    for (const over of [{ junk: 1 }, delegation(stranger, H2.pub, PAGE_ROOM), delegation(buyer, H2.pub, PAGE_ROOM), forged]) {
      set(a, key, over);
      stands();
      expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.rounds.map((v) => v.decided)).toEqual([]);
      expect(lacks(a)).toMatchObject([{ missing: 1 }]);
      expect(putBack(a)).toBe(1);
      expect(top(a).get(key)).toEqual(dl);
      expect(lacks(a)).toEqual([]);
    }
    // the same delegation written again by a peer, as another value: nothing to put back
    set(a, key, { ...dl });
    stands();
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('another holder\'s good delegation of the house is left at its key, and the page counts on from the one it holds: after a hand-over the buyer delegates the node the seller did', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const decided = (): (string | null)[] => foldOf(a).rounds.map((v) => v.decided);
    const xf = handOver(1);
    set(a, xf.key, xf.value);
    expect(res(a)).toMatchObject({ holder: buyer.pub, live: true });
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    set(a, key, theirs);
    // round 1 was the seller's to delegate a house for, and its delegation is nowhere in the doc now
    expect(decided()).toEqual(['house']);
    expect([res(a).houseAt(H2.pub, 1), res(a).houseAt(H2.pub, 2)]).toEqual([true, true]);
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.rounds.map((v) => v.decided)).toEqual([]);
    // the key holds one value, and the buyer's is the one the house goes on under: it is left
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    expect(top(a).get(key)).toEqual(theirs);
    // deleted, it is the one put back: the page holds both, and the latest holder's is the one the pages that come
    // later need most
    del(a, key);
    expect(decided()).toEqual(['house']);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    // and so when the seller's own is written over it: an old record anyone may write again, as good as it ever was
    set(a, key, delegation(owner, H2.pub, PAGE_ROOM));
    expect(decided()).toEqual(['house']);
    expect([res(a).houseAt(H2.pub, 1), res(a).houseAt(H2.pub, 2)]).toEqual([true, true]);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    expect(lacks(a)).toEqual([]);
    // a page that binds the doc now counts the house from the buyer's alone, and holds nothing of round 1's
    const late = await lateFrom(a, T0);
    expect(late.casino.computedFoldOf(TABLE)!.rounds.map((v) => v.decided)).toEqual([]);
    del(late, key);
    expect(late.casino.computedFairOnlyRecoveries()).toEqual([]);
  });

  it('the buyer\'s delegation of the node the game\'s own checkpoint delegates for the seller is held, and put back over the seller\'s written in its place: the root carries that one for anyone to copy', async () => {
    const { a } = await decidedBy(H);
    const key = delegationKey(H.pub);
    const joined = (): string[] => foldOf(a).joins.map((j) => j.rec.k);
    const xf = handOver(1);
    const theirs = delegation(buyer, H.pub, PAGE_ROOM);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, theirs);
    });
    // the house joins round 2, which is the buyer's to delegate a house for
    house(a, kit.houseJoin(H, 2));
    expect(joined()).toEqual([H.pub]);
    expect(lacks(a)).toEqual([]);
    del(a, key);
    expect(joined()).toEqual([H.pub]);
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.joins).toEqual([]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    // the seller's delegation of the same node, a good record still, takes the key: the house is none for round 2 on
    // a page that comes now, and the buyer's is put back over it
    set(a, key, delegation(owner, H.pub, PAGE_ROOM));
    expect(joined()).toEqual([H.pub]);
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.joins).toEqual([]);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    expect(lacks(a)).toEqual([]);
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.joins.map((j) => j.rec.k)).toEqual([H.pub]);
  });

  it('a delegation of a key that is no house of any record the fold counts is not held: the seller\'s, of a node that joins a round of the buyer\'s', async () => {
    const { a } = await decidedBy(H);
    const key = delegationKey(H2.pub);
    const xf = handOver(1);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, delegation(owner, H2.pub, PAGE_ROOM));
    });
    house(a, kit.houseJoin(H2, 2));
    expect(res(a).houseAt(H2.pub, 2)).toBe(false);
    expect(foldOf(a).joins).toEqual([]);
    // (no house, and told the fold so: its count waits for nothing)
    expect(foldOf(a).pending).toBe(false);
    del(a, key);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('while a transfer\'s check waits, a delegation its buyer signed is left under the key: a holder not told yet is no stranger', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const slice = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
    const xf = handOver(1);
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, theirs);
    });
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub });
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    // checked: the game is the buyer's, and the page holds both delegations of the node
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await slice();
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub });
    expect(lacks(a)).toEqual([]);
    del(a, key);
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
  });

  it('a delegation whose signer holds the game no more is let go, and written over: an earlier transfer took the chain another way', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const xf = handOver(2);
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, theirs);
    });
    expect(res(a)).toMatchObject({ holder: buyer.pub, pending: false });
    expect(lacks(a)).toEqual([]);
    // the owner had handed the game to another a round before: the buyer never held it, and round 1 is the owner's still
    const earlier = xferOf(G, owner, third, 1, DEED);
    set(a, earlier.key, earlier.value);
    expect(res(a)).toMatchObject({ holder: third.pub, pending: false });
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(delegation(owner, H2.pub, PAGE_ROOM));
    expect(lacks(a)).toEqual([]);
  });

  it('a count that waits for a transfer\'s check lets go of no delegation whose signer it has not reached: a forged transfer of an earlier round, not checked yet, takes the buyer\'s from no page', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const xf = handOver(2);
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, theirs);
    });
    expect(res(a)).toMatchObject({ holder: buyer.pub, pending: false });
    // a transfer of the owner's from the round before comes while no check can run: the chain waits at it, short of
    // the buyer, and round 1's house is counted from the owner's delegation meanwhile
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const forged = { ...xferOf(G, owner, third, 1, DEED).value, g: xf.value.g };
    set(a, xfKey(TABLE, G.inc, xfId(forged)!), forged);
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub });
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    // checks run again, and the buyer's delegation is deleted: the earlier transfer fails, the buyer holds the game,
    // and its delegation is the one put back
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    del(a, key);
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
  });

  it('a delegation in a holder\'s name at a held key is left while its check waits, and written over once the check has failed: the slice that checks it counts the game again', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    const forged = { ...dl, g: delegation(owner, H.pub, PAGE_ROOM).g };
    const slice = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
    // no check can run
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    set(a, key, forged);
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    await slice();
    expect(lacks(a)).toEqual([]);
    // checks run again: nothing is written into the doc, and the slice finds it forged
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    expect(lacks(a)).toEqual([]);
    await slice();
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(a.casino.computedFairOnlyChecking()).toBe(1);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    // and a good one that waited is found good, by the same slice: the buyer's, after a hand-over
    const xf = handOver(1);
    set(a, xf.key, xf.value);
    expect(res(a)).toMatchObject({ holder: buyer.pub, pending: false });
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    let checked = 0;
    const verify = (pub: string, bytes: Uint8Array, sig: string): boolean => {
      if (sig === theirs.g) checked += 1;
      return verifyIdentityStrict(pub, bytes, sig);
    };
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0, verify });
    set(a, key, theirs);
    expect(lacks(a)).toEqual([]);
    a.casino.setComputedVerifyForTests({ now: () => 0, verify });
    expect(checked).toBe(0);
    await slice();
    expect(checked).toBe(1);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
    expect(top(a).get(key)).toEqual(theirs);
    // (nothing waits any more: no slice counts the game again)
    await slice();
    expect(checked).toBe(1);
  });

  it('a house the game\'s own checkpoint delegates has no key to put back, and what stands under its key is not held: a delegation not checked yet, one that failed its check, a stranger\'s', async () => {
    const { a } = await decidedBy(H);
    const key = delegationKey(H.pub);
    expect(lacks(a)).toEqual([]);
    del(a, root.key);
    expect(putBack(a)).toBe(1);
    expect(top(a).has(key)).toBe(false);
    const decided = (): void => expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    // a delegation of the house in the owner's name whose signature is another record's, while no check can run: the
    // house is a house by the checkpoint's delegation all the same, and the one under the key is nothing the page holds
    const forged = { ...delegation(owner, H.pub, PAGE_ROOM), g: delegation(owner, H2.pub, PAGE_ROOM).g };
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    set(a, key, forged);
    decided();
    del(a, key);
    expect(lacks(a)).toEqual([]);
    // checked, and failed
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    set(a, key, forged);
    decided();
    expect(res(a).pending).toBe(false);
    del(a, key);
    expect(lacks(a)).toEqual([]);
    // a stranger's delegation of the house's key
    set(a, key, delegation(stranger, H.pub, PAGE_ROOM));
    decided();
    del(a, key);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('the delegation of a house the game has left behind is let go: its rounds are in a checkpoint now', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    // the root's house trims at round 1: the session H2's records were in is closed
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    del(a, key);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('a session\'s map deleted with the delegation of a house whose round it holds, and opened again empty, lets go of nothing: the delegation is held while the game counts from the same base, the round is decided again once its records are back, and the delegation is put back', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    // (what the session holds, to hand back as its authors and witnesses would)
    const records = [...(top(a).get(SES) as Y.Map<unknown>).entries()];
    // a peer deletes the session's map and the delegation: the table is not whole, and the game is not counted
    del(a, SES, key);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    // the map is opened again, empty: the fold counts no record of any house now
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual([]);
    // the delegation is held all the same: the round it decided is in no checkpoint, and its records are on their way
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: false }]);
    // they come back, and the game is resolved again (its base written again by a peer): the round is decided as it was
    a.doc.transact(() => {
      const ses = top(a).get(SES) as Y.Map<unknown>;
      for (const [k, v] of records) ses.set(k, v);
    });
    set(a, root.key, { ...root.value });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key } });
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toEqual([]);
  });

  it('nor does a base the page has not counted from take the place of the one its delegations are kept under: with a book of the table\'s chips away a checkpoint of round 1 comes, and is deleted in the write that brings the book back and puts an empty map in the place of the session\'s, and the delegation of the house that decided the round is held still, the round decided again once its records are back', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    const records = [...(top(a).get(SES) as Y.Map<unknown>).entries()];
    // a book of the table's chips this page has read is gone: the table is not whole, and the game is not counted
    const chips = a.doc.getMap<unknown>('casinoChips');
    const book = `book:${TABLE}:x`;
    chips.set(book, 1);
    chips.delete(book);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // the root's house trims at round 1 meanwhile: an answer that waits for nothing names its checkpoint, and the page
    // does not count from it
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    set(a, trim.key, trim.value);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // a peer deletes that checkpoint and the delegation and puts an empty map in the place of the session's, in the
    // write that brings the book back: the game is at the root the page holds, counted with no record of any house
    a.doc.transact(() => {
      top(a).delete(trim.key);
      top(a).delete(key);
      top(a).set(SES, new Y.Map());
      chips.set(book, 1);
    });
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key } });
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual([]);
    // the delegation is held all the same: the round it decided is in no checkpoint the page holds
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: false }]);
    a.doc.transact(() => {
      const ses = top(a).get(SES) as Y.Map<unknown>;
      for (const [k, v] of records) ses.set(k, v);
    });
    set(a, root.key, { ...root.value });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: root.key } });
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toEqual([]);
  });

  it('a delegation held for a house whose records are away is let go like any other when its signer holds the game no more', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const xf = handOver(2);
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, theirs);
    });
    expect(res(a)).toMatchObject({ holder: buyer.pub, pending: false });
    expect(lacks(a)).toEqual([]);
    // the session's map is deleted and opened again, empty: both delegations are held, the buyer's the one under the key
    del(a, SES);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual([]);
    del(a, key);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    // the owner had handed the game to another a round before: the buyer never held it, and its delegation is a stranger's
    const earlier = xferOf(G, owner, third, 1, DEED);
    set(a, earlier.key, earlier.value);
    expect(res(a)).toMatchObject({ holder: third.pub, pending: false });
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(delegation(owner, H2.pub, PAGE_ROOM));
    expect(lacks(a)).toEqual([]);
  });

  it('the base a count goes by is the one its delegations are kept under from that count on: the game moves on to a checkpoint with a house\'s join in the session it opens, and that session\'s map put there again, empty, with the delegation deleted in the same write, lets go of nothing', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    // the root's house trims at round 1, and H2 has joined the round after in the session the trim opens: one write
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, dl: delegation(owner, H.pub, PAGE_ROOM) });
    const next = `ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`;
    const join = kit.houseJoin(H2, 2);
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      const ses = new Y.Map<unknown>();
      top(a).set(next, ses);
      ses.set(join.key, join.rec);
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(foldOf(a).pending).toBe(false);
    expect(lacks(a)).toEqual([]);
    // a peer puts an empty map in the place of that session's and deletes the delegation, in one write: the fold counts
    // no record of the house at the page's second count from the checkpoint, and the delegation is held all the same
    a.doc.transact(() => {
      top(a).set(next, new Y.Map());
      top(a).delete(key);
    });
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: false }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toEqual([]);
  });

  it('a count that waits as the game moves on to another base lets go of the house left behind once it is whole: the base the delegations were kept under is the one of the last whole count', async () => {
    const { a, b, at } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    // the root's house trims at round 1, and a player has bet in the session the trim opens before this page hears of
    // either: the two come in one update
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    b.doc.transact(() => {
      top(b).set(trim.key, trim.value);
      top(b).delete(SES);
      top(b).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    // the check of the trim uses up the time of the count, and the check of the bet is put off
    let spent = 0;
    a.casino.setComputedVerifyForTests({
      now: () => spent,
      verify: (pub, bytes, sig) => {
        if (sig === trim.value.g) spent = 1_000_000;
        return verifyIdentityStrict(pub, bytes, sig);
      },
    });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(foldOf(a).pending).toBe(true);
    // the next count has its time, and is whole: H2's rounds are in the checkpoint, and its delegation is let go
    del(a, key);
    expect(foldOf(a).pending).toBe(false);
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });

  it('a count that waits as the game moves on to another base keeps the delegation of a house whose answer it put off: a house not asked of yet is no house left behind', async () => {
    const { a, at } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    // (two pages that keep one verdict at a time: the first tells how many checks the count below makes before it asks
    // of H2's delegation, the second has its time run out at that one)
    const probe = await oneVerdictFrom(a, at);
    const late = await oneVerdictFrom(a, at);
    expect(foldOf(late).rounds.map((v) => v.decided)).toEqual(['house']);
    // the root's house trims at round 1, and H2 joins the round after in the session the trim opens: one update
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    house(a, kit.houseJoin(H2, 2));
    const seen: string[] = [];
    probe.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0, verify: (pub, bytes, sig) => { seen.push(sig); return verifyIdentityStrict(pub, bytes, sig); } });
    Y.applyUpdate(probe.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(probe.doc)));
    const before = seen.indexOf(dl.g);
    expect(before).toBeGreaterThan(0);
    let spent = 0;
    let calls = 0;
    late.casino.setComputedVerifyForTests({
      authMax: 1,
      now: () => spent,
      verify: (pub, bytes, sig) => {
        calls += 1;
        if (calls === before) spent = 1_000_000;
        return verifyIdentityStrict(pub, bytes, sig);
      },
    });
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(late.doc)));
    expect(res(late)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(foldOf(late).pending).toBe(true);
    // its key is deleted meanwhile, and the next count has its time: the page held the delegation, and puts it back
    calls = Number.NEGATIVE_INFINITY;
    del(late, key);
    expect(foldOf(late).pending).toBe(false);
    expect(lacks(late)).toMatchObject([{ missing: 1 }]);
    expect(putBack(late)).toBe(1);
    expect(top(late).get(key)).toEqual(dl);
    expect(lacks(late)).toEqual([]);
  });

  it('the delegation an older checkpoint of the game carries, of a house that plays on after a base that carries another, is held and put under the house\'s key: the older checkpoint deleted, the house\'s record counts on', async () => {
    const { a } = await decidedBy(H);
    const key = delegationKey(H.pub);
    const dl = delegation(owner, H.pub, PAGE_ROOM);
    const joined = (): string[] => foldOf(a).joins.map((j) => j.rec.k);
    // the second house, delegated in its own checkpoint, trims at round 1, and the root's house joins the round after
    // in the session that trim opens: nothing holds the root's house's delegation but the root, the base no more
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, k: H2.pub, dl: delegation(owner, H2.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(lacks(a)).toEqual([]);
    house(a, kit.houseJoin(H, 2));
    expect(joined()).toEqual([H.pub]);
    // the page holds the delegation its count went by, and the doc has it under no key
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    // the root is deleted (a peer does, and compaction will): the join counts on, on the page that counted it
    del(a, root.key);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(joined()).toEqual([H.pub]);
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.joins).toEqual([]);
    // put back: the delegation, under its house's key (and not the root: the game counts from it no more)
    expect(putBack(a)).toBe(1);
    expect(top(a).has(root.key)).toBe(false);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toEqual([]);
    expect((await lateFrom(a, T0)).casino.computedFoldOf(TABLE)!.joins.map((j) => j.rec.k)).toEqual([H.pub]);
    // and it is held from there as any other: deleted, the join counts on and it is put back
    del(a, key);
    expect(joined()).toEqual([H.pub]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
  });

  it('a house\'s record that comes after the checkpoint its session opens with counts by a delegation the page let go of as the game moved on, and the page holds it again: the game resolved again, the record counts on', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    const joined = (): string[] => foldOf(a).joins.map((j) => j.rec.k);
    // the delegation's key is deleted: the page holds it, and offers it to each resolution
    del(a, key);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    // the root's house trims at round 1, and the session the trim opens is empty: H2's rounds are in the checkpoint, and
    // its delegation is let go of
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`, new Y.Map());
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(lacks(a)).toEqual([]);
    // H2 joins the round after, in an update of its own: the resolution the trim was read by was given the delegation,
    // and the join counts by it
    house(a, kit.houseJoin(H2, 2));
    expect(joined()).toEqual([H2.pub]);
    // so the page holds it again: nothing its count goes by is held by no one
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    // the game is resolved again (its base written again by a peer, as another value): the join counts on
    set(a, trim.key, { ...trim.value });
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(joined()).toEqual([H2.pub]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toEqual([]);
  });

  it('of the delegations of one house the page holds, the one under the key and the one its count found in a checkpoint, the latest holder\'s is the one for the key', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const joined = (): string[] => foldOf(a).joins.map((j) => j.rec.k);
    // the game is handed over after round 1, and the buyer delegates the same house in a checkpoint that is no base of
    // the game (it names no transfer, so it speaks for no holder): the room's key holds the seller's still
    const xf = handOver(1);
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    const stray = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: undefined, k: H2.pub, dl: theirs });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(stray.key, stray.value);
    });
    expect(res(a)).toMatchObject({ pending: false, live: true, holder: buyer.pub, base: { key: root.key } });
    expect(lacks(a)).toEqual([]);
    // the house joins round 2, the buyer's to delegate a house for: the count goes by the buyer's delegation
    house(a, kit.houseJoin(H2, 2));
    expect(joined()).toEqual([H2.pub]);
    expect(res(a).houseBy(H2.pub, 2)?.value).toEqual(theirs);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    expect(lacks(a)).toEqual([]);
    // both are held: round 1 stays decided by the seller's, which the doc holds no more
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    del(a, stray.key, key);
    expect(joined()).toEqual([H2.pub]);
    expect(foldOf(a).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
  });

  it('while the game is not counted for want of its session\'s map, what a peer writes over a held delegation is found all the same, and the held one is put back: a stranger\'s at once, a forged one once it is checked; a holder not told yet is no stranger, and a signer that holds the game no more is let go of', async () => {
    const { a } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    const slice = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
    // a peer deletes the session's map and writes a stranger's delegation of the house under its key
    a.doc.transact(() => {
      top(a).delete(SES);
      top(a).set(key, delegation(stranger, H2.pub, PAGE_ROOM));
    });
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    // one forged in the owner's name, while no check can run: left, and found by the slice that checks it
    const forged = { ...dl, g: delegation(owner, H.pub, PAGE_ROOM).g };
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    set(a, key, forged);
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await slice();
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    // a hand-over whose check waits, and its buyer's delegation under the key: a holder not told yet is no stranger
    const xf = handOver(2);
    const theirs = delegation(buyer, H2.pub, PAGE_ROOM);
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(key, theirs);
    });
    expect(res(a)).toMatchObject({ pending: true, holder: owner.pub });
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await slice();
    expect(res(a)).toMatchObject({ pending: false, holder: buyer.pub });
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    // the page holds both now: deleted, the buyer's is the one put back
    del(a, key);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(theirs);
    // the owner had handed the game to another a round before: the buyer never held it, its delegation is a
    // stranger's, and the owner's goes back over it
    const earlier = xferOf(G, owner, third, 1, DEED);
    set(a, earlier.key, earlier.value);
    expect(res(a)).toMatchObject({ holder: third.pub, pending: false });
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
  });

  it('a session\'s map deleted after a count of it that waited, the game having moved on to its base in that count, lets go of no house: not while the game is not counted, nor once the map is opened again, empty', async () => {
    const { a, b, at } = await decidedBy(H2);
    const key = delegationKey(H2.pub);
    const dl = delegation(owner, H2.pub, PAGE_ROOM);
    del(a, key);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    // the root's house trims at round 1, and a player has bet in the session the trim opens before this page hears of
    // either; the check of the trim uses up the time of the count, and the check of the bet is put off
    const trim = trimOf(G, 'p', { b: SID, u: 1, n: {}, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const ses = `ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`;
    b.doc.transact(() => {
      top(b).set(trim.key, trim.value);
      top(b).delete(SES);
      top(b).set(ses, new Y.Map());
    });
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    let spent = 0;
    a.casino.setComputedVerifyForTests({
      now: () => spent,
      verify: (pub, bytes, sig) => {
        if (sig === trim.value.g) spent = 1_000_000;
        return verifyIdentityStrict(pub, bytes, sig);
      },
    });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    expect(foldOf(a).pending).toBe(true);
    // (the count waited: the delegation is held still, kept under the root)
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: false }]);
    // the map of the session the trim opens is deleted before a count of it is whole: the game is not counted, and the
    // fold has asked of no house at this base
    del(a, ses);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    // opened again, empty: the count is whole and no record is H2's, but the session the page counted from this base
    // is the one that went, and its records are on their way back
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(foldOf(a).pending).toBe(false);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: false }]);
    expect(putBack(a)).toBe(1);
    expect(top(a).get(key)).toEqual(dl);
  });

  it('the live session\'s map gone is listed and opened again, empty; not while it is there, nor of a game that has ended', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(false);
    del(a, SES);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    expect(putBack(a)).toBe(0);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
    expect((top(a).get(SES) as Y.Map<unknown>).size).toBe(0);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    expect(lacks(a)).toEqual([]);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(false);
    // junk at its key is no session
    set(a, SES, { junk: 1 });
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true }]);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
    // the base gone too: the session is opened all the same (the page holds the base)
    del(a, SES, root.key);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
    expect(putBack(a)).toBe(1);
    // ended: no session is opened
    endGame(a);
    del(a, SES);
    expect(lacks(a)).toEqual([]);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(false);
    expect(top(a).has(SES)).toBe(false);
  });

  it('a caller that says which session it waited to open, and through how many moves of the game\'s session keys, opens that one only: not another the game names now, nor one whose key moved since', async () => {
    const [a] = await gameRoom(['A']);
    del(a, SES);
    const [{ sid, sesMoves }] = lacks(a);
    expect(sid).toBe(SID);
    const reopen = (waited: { sid: string | null; sesMoves: number }): boolean => a.casino.reopenFairOnlySession(TABLE, G.inc, waited);
    expect(reopen({ sid: 'another', sesMoves })).toBe(false);
    expect(reopen({ sid: null, sesMoves })).toBe(false);
    expect(reopen({ sid, sesMoves: sesMoves - 1 })).toBe(false);
    expect(reopen({ sid, sesMoves: sesMoves + 1 })).toBe(false);
    expect(top(a).has(SES)).toBe(false);
    expect(reopen({ sid, sesMoves })).toBe(true);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('nothing is written on a doc that holds part of an update', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    del(a, root.key, SES);
    deliver(T0, a, [second]); // (it builds on the first, which has not come)
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    expect(putBack(a)).toBe(0);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(false);
    deliver(T0, a, [first]);
    expect(putBack(a)).toBe(1);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(true);
  });

  it('nothing is written into a doc that was destroyed', async () => {
    const [a] = await gameRoom(['A']);
    del(a, root.key, SES);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: true }]);
    a.doc.destroy();
    expect(putBack(a)).toBe(0);
    expect(a.casino.reopenFairOnlySession(TABLE, G.inc)).toBe(false);
    expect([root.key, SES].map((k) => top(a).has(k))).toEqual([false, false]);
  });

  it('only a game something happened to is looked at: not for a bet, a beat or junk, and no more once it is found whole', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.casino.computedFairOnlyChecking()).toBe(0);
    // another game opens: it was resolved, so it is looked at once
    const root2 = rootOf(G2, 'p', { dl: delegation(owner, H2.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(root2.key, root2.value);
      top(a).set(`ses:${T2}:${G2.inc}:${nextSid3(G2, root2.value)}`, new Y.Map());
    });
    expect(a.casino.computedFairOnlyChecking()).toBe(1);
    expect(lacks(a)).toEqual([]);
    expect(a.casino.computedFairOnlyChecking()).toBe(0);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const [beatKey, beat] = beatOf(PAGE_ROOM, H, 1);
    set(a, beatKey, beat);
    set(a, `ck:${TABLE}:${G.inc}:${hex('9', 32)}`, { junk: 1 });
    expect(a.casino.computedFairOnlyChecking()).toBe(0);
    // the base of one deleted: that game alone, for as long as it lacks
    del(a, root.key);
    expect(a.casino.computedFairOnlyChecking()).toBe(1);
    expect(lacks(a)).toHaveLength(1);
    expect(a.casino.computedFairOnlyChecking()).toBe(1);
    expect(putBack(a)).toBe(1);
    expect(lacks(a)).toEqual([]);
    expect(a.casino.computedFairOnlyChecking()).toBe(0);
    // its session's key moved
    del(a, SES);
    expect(a.casino.computedFairOnlyChecking()).toBe(1);
  });

  it('a delegation held stays held when the cache has let its verdict go: it was checked when the page first kept it', async () => {
    const { a, at } = await decidedBy(H2);
    const late = await oneVerdictFrom(a, at);
    expect(foldOf(late).rounds.map((v) => v.decided)).toEqual(['house']);
    // the root's house joins the next round: its delegation is checked, and H2's verdict is gone
    house(late, kit.houseJoin(H, 2));
    expect(res(late).pending).toBe(false);
    del(late, delegationKey(H2.pub));
    expect(foldOf(late).rounds.map((v) => v.decided)).toEqual(['house']);
    expect(lacks(late).map((r) => r.missing)).toEqual([1]);
    expect(putBack(late)).toBe(1);
    expect(top(late).get(delegationKey(H2.pub))).toEqual(delegation(owner, H2.pub, PAGE_ROOM));
  });

  it('while no check can run, the page keeps all it held: the transfer, the end order and a house\'s delegation stand again once checks run, though the doc lost them meanwhile', async () => {
    const { a, at } = await decidedBy(H2);
    const xf = handOver(1);
    const fin = sealFin(G, owner.pub, owner.sign);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(fin.key, fin.value);
    });
    const late = await oneVerdictFrom(a, at);
    const stands = (): void => {
      expect(res(late)).toMatchObject({ pending: false, holder: buyer.pub, live: true, fin: { k: owner.pub }, base: { key: root.key } });
      expect(foldOf(late).rounds.map((v) => v.decided)).toEqual(['house']);
    };
    stands();
    // no check can run, and the verdict of the base's signature is one the cache has let go: the game waits, with no base
    late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0, budgetMs: 0 });
    const keys = [root.key, xf.key, fin.key, delegationKey(H2.pub)];
    del(late, ...keys);
    expect(res(late)).toMatchObject({ pending: true, base: null });
    // (nothing is put back of a game whose resolution names no base)
    expect(lacks(late)).toEqual([]);
    expect(putBack(late)).toBe(0);
    // checks run again, and the game is resolved again
    late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0 });
    set(late, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    stands();
    expect(lacks(late)).toMatchObject([{ missing: 4 }]);
    expect(putBack(late)).toBe(4);
    expect(keys.map((k) => top(late).has(k))).toEqual([true, true, true, true]);
  });

  it('while a house\'s answer is put off, the delegation the page held of it stays held', async () => {
    const { a, at } = await decidedBy(H2);
    const late = await oneVerdictFrom(a, at);
    const decided = (): (string | null)[] => foldOf(late).rounds.map((v) => v.decided);
    expect(decided()).toEqual(['house']);
    // the checks of the game's own records (the root's signature, and its delegation's) use up the time of one count:
    // the delegation of H2, asked of the fold after them, is put off
    let spent = 0;
    const done = new Set<string>();
    late.casino.setComputedVerifyForTests({
      authMax: 1,
      now: () => spent,
      verify: (pub, bytes, sig) => {
        if (sig === root.value.g || sig === root.value.dl?.g) done.add(sig);
        if (done.size === 2) spent = 1_000_000;
        return verifyIdentityStrict(pub, bytes, sig);
      },
    });
    set(late, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(late)).toMatchObject({ pending: false, base: { key: root.key } });
    expect(foldOf(late).pending).toBe(true);
    expect(decided()).toEqual([]);
    // the delegation is deleted meanwhile, and the next count has its time: the page held it, and the round is decided
    del(late, delegationKey(H2.pub));
    expect(foldOf(late).pending).toBe(false);
    expect(decided()).toEqual(['house']);
    expect(lacks(late)).toMatchObject([{ missing: 1 }]);
    expect(putBack(late)).toBe(1);
    expect(top(late).get(delegationKey(H2.pub))).toEqual(delegation(owner, H2.pub, PAGE_ROOM));
  });

  it('a doc bound again holds nothing of before: what the doc lacks then, the page never counted', async () => {
    const [a] = await gameRoom(['A']);
    del(a, root.key);
    expect(res(a).base?.key).toBe(root.key);
    rebind(a);
    expect(res(a).base).toBeNull();
    expect(lacks(a)).toEqual([]);
    expect(putBack(a)).toBe(0);
  });
});

describe('the put-back duty', () => {
  it('the first page in turn puts a deleted base back at its next frame, the next STAGGER_MS on, a page with no felt OUTSIDER_WAIT_MS after the places; a page that came meanwhile counts the game from then', async () => {
    // (pages whose turns at the records are not their turns at opening a session: the two duties have each their own)
    const [a, b, c] = await pagesWhere((x, y) => before('restore', 0, x, y) !== before('open', 0, x, y), ['C']);
    bet(a, b);
    let T = run([a, b, c], T0 + STEP, T0 + 2 * STEP);
    del(c, root.key);
    sync(T, a, b, c);
    const late = await lateFrom(c, T);
    expect(late.casino.computedResolutionOf(TABLE, G.inc)?.base ?? null).toBeNull();
    const [first, second] = before('restore', 0, a, b) ? [a, b] : [b, a];
    const has = (p: Page): boolean => top(p).has(root.key);
    // (no page is handed another's write: each is on its own)
    const at0 = T;
    const wroteAt = new Map<Page, number>();
    const { STAGGER_MS, OUTSIDER_WAIT_MS } = a.table;
    for (; T <= at0 + 2 * STAGGER_MS + OUTSIDER_WAIT_MS; T += STEP) {
      for (const p of [first, second, c]) {
        frame(T, p);
        if (has(p) && !wroteAt.has(p)) wroteAt.set(p, T - at0);
      }
    }
    expect(wroteAt.get(first)).toBe(0);
    expect(wroteAt.get(second)).toBe(framed(STAGGER_MS));
    expect(wroteAt.get(c)).toBe(2 * STAGGER_MS + OUTSIDER_WAIT_MS);
    // every page wrote the record as the doc held it
    for (const p of [first, second, c]) expect(top(p).get(root.key)).toEqual(root.value);
    sync(T, first, late);
    expect(late.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: true, base: { key: root.key } });
  });

  it('each page on its own opens the session in its turn of opening, which is not its turn at the records', async () => {
    const [a, b] = await pagesWhere((x, y) => before('restore', 0, x, y) !== before('open', 0, x, y));
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    clockOf(a, T);
    del(a, SES);
    sync(T, a, b);
    const [first, second] = before('open', 0, a, b) ? [a, b] : [b, a];
    const { STAGGER_MS, OPEN_WAIT_MS } = a.table;
    const at0 = T;
    const openedAt = new Map<Page, number>();
    for (; T <= at0 + OPEN_WAIT_MS + 2 * STAGGER_MS; T += STEP) {
      for (const p of [a, b]) {
        frame(T, p);
        if (top(p).has(SES) && !openedAt.has(p)) openedAt.set(p, T - at0);
      }
    }
    expect(openedAt.get(first)).toBe(OPEN_WAIT_MS);
    expect(openedAt.get(second)).toBe(framed(OPEN_WAIT_MS + STAGGER_MS));
  });

  it('the turns are those of the round the game\'s base is at', async () => {
    // a round at which the turns, at the records and at the session, are not those of round 0
    let u = 0;
    const differs = (x: Page, y: Page): boolean => {
      for (u = 1; u <= 40; u++) {
        if (before('restore', u, x, y) !== before('restore', 0, x, y) && before('open', u, x, y) !== before('open', 0, x, y)) return true;
      }
      return false;
    };
    const [a, b] = await pagesWhere(differs);
    // the house's checkpoint at that round, and the session it opens
    const trim = trimOf(G, 'p', { b: SID, u, n: {}, h: kit.houseCommit(H, u + 1), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const ses = `ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`;
    a.doc.transact(() => {
      top(a).set(trim.key, trim.value);
      top(a).delete(SES);
      top(a).set(ses, new Y.Map());
    });
    sync(T0, a, b);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    clockOf(a, T);
    del(a, trim.key, ses);
    sync(T, a, b);
    for (const p of [a, b]) expect(lacks(p)).toMatchObject([{ u, missing: 1, sessionMissing: true, pubs: [a.pub, b.pub].sort() }]);
    const { STAGGER_MS, OPEN_WAIT_MS } = a.table;
    const at0 = T;
    const seen = new Map<string, number>();
    for (; T <= at0 + OPEN_WAIT_MS + 2 * STAGGER_MS; T += STEP) {
      for (const p of [a, b]) {
        frame(T, p);
        for (const key of [trim.key, ses]) if (top(p).has(key) && !seen.has(`${p.pid} ${key}`)) seen.set(`${p.pid} ${key}`, T - at0);
      }
    }
    const [first, second] = before('restore', u, a, b) ? [a, b] : [b, a];
    expect([first, second].map((p) => seen.get(`${p.pid} ${trim.key}`))).toEqual([0, framed(STAGGER_MS)]);
    const [opens, after] = before('open', u, a, b) ? [a, b] : [b, a];
    expect([opens, after].map((p) => seen.get(`${p.pid} ${ses}`))).toEqual([OPEN_WAIT_MS, framed(OPEN_WAIT_MS + STAGGER_MS)]);
  });

  it('looks once in TICK_MS however often the page draws a frame: the same stretch of time drawn four times as often asks casinoDoc as often', async () => {
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const asked = vi.spyOn(a.casino, 'computedFairOnlyRecoveries');
    // (three seconds at a frame every TICK_MS, then three at a frame every 50 ms)
    T = frames(a, T, T + 3_000);
    const slow = asked.mock.calls.length;
    for (const to = T + 3_000; T <= to; T += 50) {
      NOW = T;
      clockOf(a, T);
      frame(T, a);
    }
    const fast = asked.mock.calls.length - slow;
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeLessThanOrEqual(slow * 1.5);
  });

  it('a page that is handed the first one\'s put-back writes nothing', async () => {
    const [a, b, c] = await gameRoom(['A', 'B', 'C']);
    bet(a, b);
    let T = run([a, b, c], T0 + STEP, T0 + 2 * STEP);
    del(c, root.key);
    sync(T, a, b, c);
    const wrote = putBacksOf([a, b, c], root.key);
    const at0 = T;
    T = run([a, b, c], T, T + 25_000);
    for (const p of [a, b, c]) expect(top(p).get(root.key)).toEqual(root.value);
    // one page made the put-back, once, at its turn (the first's): the others were handed it before theirs
    expect(wrote.map((w) => w.at)).toEqual([at0]);
    expect(dutyRank('restore', G, 0, [a, b].find((p) => p.pid === wrote[0].by)!.pub)).toBe([a, b].map((p) => dutyRank('restore', G, 0, p.pub)).sort()[0]);
  });

  it('puts back JUNK_GAP_MS apart at the least, stands down for KEEP_BACKOFF_MS after CONTESTED_COUNT put-backs that did not last, says so, and counts on from what it holds', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS, CONTESTED_COUNT } = a.table;
    const wrote: number[] = [];
    /** The frames in which the table's card was told to look again. */
    const told: number[] = [];
    let framing = false;
    a.casino.subscribeCasinoKey(`computed:${TABLE}`, () => {
      if (framing && told[told.length - 1] !== T) told.push(T);
    });
    /** A peer deletes the base whenever it is there; the page's frames, to `to`. */
    const loop = (to: number): void => {
      for (; T <= to; T += STEP) {
        clockOf(a, T);
        if (top(a).has(root.key)) del(a, root.key);
        framing = true;
        frame(T, a);
        framing = false;
        if (top(a).has(root.key)) wrote.push(T);
      }
    };
    const t1 = T;
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
    loop(t1 + 10_000);
    expect(CONTESTED_COUNT).toBe(3);
    expect(wrote).toEqual([t1, t1 + JUNK_GAP_MS, t1 + 2 * JUNK_GAP_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
    expect(res(a)).toMatchObject({ live: true, base: { key: root.key } });
    expect(foldOf(a).felts.has(a.pid)).toBe(true);
    // (the stand-down began at the frame after the third put-back was deleted)
    const stoodAt = t1 + 2 * JUNK_GAP_MS + STEP;
    // the card is told at each put-back (the doc moved) and at the frame the page stood down (nothing moved but its mind)
    expect(told).toEqual([...wrote, stoodAt]);
    loop(stoodAt + KEEP_BACKOFF_MS - STEP);
    expect(wrote).toHaveLength(3);
    expect(a.table.computedContested(TABLE, clockOf(a, T - STEP))).toBe(true);
    // (and no more at the moment it ends, asked before the page's frame of that moment forgets it)
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
    loop(stoodAt + KEEP_BACKOFF_MS);
    expect(wrote).toEqual([t1, t1 + JUNK_GAP_MS, t1 + 2 * JUNK_GAP_MS, stoodAt + KEEP_BACKOFF_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, T - STEP))).toBe(false);
  });

  it('a stand-down lasts KEEP_BACKOFF_MS whatever comes back during it: the record a peer writes and deletes again then does not lengthen it', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote: number[] = [];
    /** The page's frames, to `to`: a peer deletes the base whenever it is there, and writes it itself before the
     *  frames of `puts`. */
    const loop = (to: number, puts: number[] = []): void => {
      for (; T <= to; T += STEP) {
        clockOf(a, T);
        if (top(a).has(root.key)) del(a, root.key);
        if (puts.includes(T)) set(a, root.key, root.value);
        const had = top(a).has(root.key);
        frame(T, a);
        if (!had && top(a).has(root.key)) wrote.push(T);
      }
    };
    const t1 = T;
    const stoodAt = t1 + 2 * JUNK_GAP_MS + STEP;
    loop(stoodAt);
    expect(wrote).toEqual([t1, t1 + JUNK_GAP_MS, t1 + 2 * JUNK_GAP_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, stoodAt))).toBe(true);
    // the peer writes the base and deletes it, three times in the first seconds of the stand-down
    loop(stoodAt + KEEP_BACKOFF_MS - STEP, [stoodAt + 1_000, stoodAt + 2_000, stoodAt + 3_000]);
    expect(wrote).toHaveLength(3);
    loop(stoodAt + KEEP_BACKOFF_MS);
    expect(wrote[3]).toBe(stoodAt + KEEP_BACKOFF_MS);
  });

  it('what comes back in the last minute of a stand-down begins none by itself: the page puts back at its end, and stands down again at once when that put-back does not last either', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote: number[] = [];
    /** The page's frames, to `to`: a peer deletes the base whenever it is there, and writes it itself before the
     *  frames of `puts`. */
    const loop = (to: number, puts: number[] = []): void => {
      for (; T <= to; T += STEP) {
        clockOf(a, T);
        if (top(a).has(root.key)) del(a, root.key);
        if (puts.includes(T)) set(a, root.key, root.value);
        const had = top(a).has(root.key);
        frame(T, a);
        if (!had && top(a).has(root.key)) wrote.push(T);
      }
    };
    const contested = (at: number): boolean => a.table.computedContested(TABLE, clockOf(a, at));
    const t1 = T;
    const stoodAt = t1 + 2 * JUNK_GAP_MS + STEP;
    loop(stoodAt);
    expect(wrote).toHaveLength(3);
    // the peer writes the base and deletes it, three times in the last seconds of the stand-down
    const end = stoodAt + KEEP_BACKOFF_MS;
    loop(end - STEP, [end - 3_000, end - 2_000, end - 1_000]);
    expect(wrote).toHaveLength(3);
    expect(contested(end - STEP)).toBe(true);
    // the page puts the base back at the end of its stand-down all the same
    loop(end);
    expect(wrote.slice(3)).toEqual([end]);
    expect(contested(end)).toBe(false);
    // that one deleted too, it stands down at its next look: the three of the last minute count with it, and it makes
    // no other
    loop(end + 10_000);
    expect(wrote.slice(3)).toEqual([end]);
    expect(contested(end + STEP)).toBe(true);
    // for KEEP_BACKOFF_MS from that look
    loop(end + STEP + KEEP_BACKOFF_MS - STEP);
    expect(wrote.slice(3)).toEqual([end]);
    loop(end + STEP + KEEP_BACKOFF_MS);
    expect(wrote.slice(3)).toEqual([end, end + STEP + KEEP_BACKOFF_MS]);
  });

  it('a put-back read at the look a stand-down ends is read outside it: with two of its last minute it begins the next, whoever made it', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote: number[] = [];
    const loop = (to: number, puts: number[] = []): void => {
      for (; T <= to; T += STEP) {
        clockOf(a, T);
        if (top(a).has(root.key)) del(a, root.key);
        if (puts.includes(T)) set(a, root.key, root.value);
        const had = top(a).has(root.key);
        frame(T, a);
        if (!had && top(a).has(root.key)) wrote.push(T);
      }
    };
    const contested = (at: number): boolean => a.table.computedContested(TABLE, clockOf(a, at));
    const t1 = T;
    const stoodAt = t1 + 2 * JUNK_GAP_MS + STEP;
    const end = stoodAt + KEEP_BACKOFF_MS;
    // the base comes back twice in the last seconds of the stand-down, and once more at the look it ends: the room's
    // put-back after it is that one, and it does not last
    loop(end, [end - 2_000, end - 1_000, end]);
    expect(wrote).toHaveLength(3);
    expect(contested(end)).toBe(false);
    loop(end + 10_000);
    expect(wrote).toHaveLength(3);
    expect(contested(end + STEP)).toBe(true);
  });

  it('stands down all the same when the peer deletes the session\'s map as well: the table is not whole then, and the put-backs are counted', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS } = a.table;
    const wrote: number[] = [];
    let opened = 0;
    const t1 = T;
    // (a peer deletes the base and the session's map whenever they are there, for a minute of the page's frames)
    for (; T <= t1 + 60_000; T += STEP) {
      clockOf(a, T);
      if (top(a).has(root.key)) del(a, root.key);
      if (top(a).has(SES)) del(a, SES);
      frame(T, a);
      if (top(a).has(root.key)) wrote.push(T);
      if (top(a).has(SES)) opened += 1;
    }
    expect(wrote).toEqual([t1, t1 + JUNK_GAP_MS, t1 + 2 * JUNK_GAP_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
    // (the session's map has no stand-down: it goes on being opened, in the turns of a page with no felt once the
    // first one opened had none in it)
    expect(opened).toBeGreaterThan(1);
  });

  it('put-backs that did not last count on every page that saw them, whoever made them: the room stands down together after CONTESTED_COUNT, and no page makes more', async () => {
    const pages = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    bet(a, b);
    let T = run(pages, T0 + STEP, T0 + 2 * STEP);
    const { KEEP_BACKOFF_MS, CONTESTED_COUNT } = a.table;
    const wrote = putBacksOf(pages, root.key);
    /** A peer deletes the base whenever the doc holds it. */
    const peer = (at: number): void => {
      if (!top(c).has(root.key)) return;
      clockOf(c, at);
      del(c, root.key);
    };
    const t1 = T;
    T = run(pages, T, t1 + 30_000, { each: peer });
    // the first in turn made them all: the others were handed each before their turns, and counted it
    expect(wrote).toHaveLength(CONTESTED_COUNT);
    expect(new Set(wrote.map((w) => w.by)).size).toBe(1);
    for (const p of pages) {
      expect(p.table.computedContested(TABLE, clockOf(p, T)), p.pid).toBe(true);
      expect(res(p)).toMatchObject({ live: true, base: { key: root.key } });
    }
    // no page puts it back while they stand down: not the pages that made none either
    T = run(pages, T, t1 + KEEP_BACKOFF_MS - 5_000, { each: peer, step: 1_000 });
    expect(wrote).toHaveLength(CONTESTED_COUNT);
    // and then the room tries again, in turn as before: the first makes CONTESTED_COUNT more, the others none
    run(pages, T, T + 15_000, { each: peer });
    expect(wrote).toHaveLength(2 * CONTESTED_COUNT);
    expect(new Set(wrote.map((w) => w.by)).size).toBe(1);
  });

  it('pages whose stand-downs end a little apart stand down together again: the put-back a page reads in the last moments of its own counts on it, and it makes none', async () => {
    const [a, b] = await pagesWhere((x, y) => before('restore', 0, x, y));
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote = putBacksOf([a, b], root.key);
    /** One step: a peer deletes the base whenever the doc holds it, and the pages' frames, each handed the other's
     *  writes before and after (run); B draws no frame at the steps of `idle`. Then the next, to `to`. */
    const steps = (to: number, idle: number[] = []): void => {
      for (; T <= to; T += STEP) {
        NOW = T;
        if (top(a).has(root.key)) {
          clockOf(a, T);
          del(a, root.key);
        }
        sync(T, a, b);
        frame(T, a);
        if (!idle.includes(T)) frame(T, b);
        sync(T, a, b);
      }
    };
    const contested = (p: Page, at: number): boolean => p.table.computedContested(TABLE, clockOf(p, at));
    // the first in turn makes three put-backs that do not last and stands down; B, which drew no frame for two looks
    // just then, stands down two looks later
    const t1 = T;
    const stoodA = t1 + 2 * JUNK_GAP_MS + STEP;
    steps(stoodA + 2 * STEP, [stoodA, stoodA + STEP]);
    expect(wrote.map((w) => [w.by, w.at - t1])).toEqual([[a.pid, 0], [a.pid, JUNK_GAP_MS], [a.pid, 2 * JUNK_GAP_MS]]);
    expect(contested(a, stoodA)).toBe(true);
    expect(contested(b, stoodA + STEP)).toBe(false);
    expect(contested(b, stoodA + 2 * STEP)).toBe(true);
    // A's stand-down ends first, and it puts the base back: B reads that one before its own is over
    const endA = stoodA + KEEP_BACKOFF_MS;
    steps(endA + STEP);
    expect(wrote.slice(3).map((w) => [w.by, w.at - endA])).toEqual([[a.pid, 0]]);
    expect(contested(b, endA + STEP)).toBe(true);
    // two more of A's that do not last, and both stand down at the same look: B made none
    steps(endA + 15_000);
    expect(wrote.slice(3).map((w) => [w.by, w.at - endA])).toEqual([[a.pid, 0], [a.pid, JUNK_GAP_MS], [a.pid, 2 * JUNK_GAP_MS]]);
    const again = endA + 2 * JUNK_GAP_MS + STEP;
    for (const p of [a, b]) {
      expect(contested(p, again - STEP), p.pid).toBe(false);
      expect(contested(p, again), p.pid).toBe(true);
    }
  });

  it('put-backs that last count for nothing: a record deleted once a minute is put back every time', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    for (let i = 0; i < 5; i++) {
      clockOf(a, T);
      del(a, root.key);
      T = run([a], T, T + a.table.CONTESTED_CALM_MS);
      expect(top(a).get(root.key), `time ${i + 1}`).toEqual(root.value);
      expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
    }
  });

  it('puts an ended game\'s end checkpoint back, OUTSIDER_WAIT_MS on when no felt names a turn', async () => {
    const [a] = await gameRoom(['A']);
    const end = endGame(a);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    clockOf(a, T);
    del(a, end.key);
    const at0 = T;
    T = run([a], T, at0 + a.table.OUTSIDER_WAIT_MS - STEP);
    expect(top(a).has(end.key)).toBe(false);
    run([a], T, at0 + a.table.OUTSIDER_WAIT_MS);
    expect(top(a).get(end.key)).toEqual(end.value);
  });

  it('puts a transfer, an end order and a house\'s delegation back with the base, in one write', async () => {
    const { a, b, at } = await decidedBy(H2);
    const xf = handOver(1);
    // (the end order is of the key that held the game at the base, the owner's)
    const fin = sealFin(G, owner.pub, owner.sign);
    a.doc.transact(() => {
      top(a).set(xf.key, xf.value);
      top(a).set(fin.key, fin.value);
    });
    let T = run([a, b], at + STEP, at + 2 * STEP);
    for (const p of [a, b]) expect(res(p)).toMatchObject({ holder: buyer.pub, live: true, fin: { k: owner.pub } });
    const keys = [root.key, xf.key, fin.key, delegationKey(H2.pub)];
    clockOf(b, T);
    del(b, ...keys);
    sync(T, a, b);
    // (round 1 is decided and no felt is staked: no page has a turn, each waits OUTSIDER_WAIT_MS)
    const wrote: string[][] = [];
    for (const p of [a, b]) {
      p.doc.on('afterTransaction', (tr: Y.Transaction) => {
        const changed = [...(tr.changed.get(top(p) as never) ?? [])].filter((k): k is string => k !== null && keys.includes(k));
        if (tr.local && changed.length > 0) wrote.push(changed.sort());
      });
    }
    const at0 = T;
    T = run([a, b], T, at0 + a.table.OUTSIDER_WAIT_MS - STEP);
    expect(wrote).toEqual([]);
    for (const p of [a, b]) {
      expect(keys.map((k) => top(p).has(k))).toEqual([false, false, false, false]);
      // (the pages count on from what they hold)
      expect(res(p)).toMatchObject({ holder: buyer.pub, live: true, fin: { k: owner.pub } });
      expect(foldOf(p).rounds.map((v) => v.decided)).toEqual(['house']);
    }
    run([a, b], T, at0 + a.table.OUTSIDER_WAIT_MS);
    // each page that wrote put the four back in one transaction
    expect(wrote.length).toBeGreaterThan(0);
    for (const w of wrote) expect(w).toEqual([...keys].sort());
    for (const p of [a, b]) {
      expect(keys.map((k) => top(p).get(k))).toEqual([root.value, xf.value, fin.value, delegation(owner, H2.pub, PAGE_ROOM)]);
      expect(res(p)).toMatchObject({ holder: buyer.pub, live: true, fin: { k: owner.pub } });
      expect(foldOf(p).rounds.map((v) => v.decided)).toEqual(['house']);
    }
    // a page that binds the doc now counts the game as they do
    const late = await lateFrom(a, at0 + a.table.OUTSIDER_WAIT_MS);
    expect(late.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ holder: buyer.pub, live: true, fin: { k: owner.pub } });
  });

  it('opens a live session\'s map again OPEN_WAIT_MS on, in turn, and the bets come back into it', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    clockOf(a, T);
    del(a, SES);
    sync(T, a, b);
    for (const p of [a, b]) expect(p.casino.casinoWhole(TABLE)).toBe(false);
    const at0 = T;
    T = run([a, b], T, at0 + a.table.OPEN_WAIT_MS - STEP);
    for (const p of [a, b]) expect(top(p).has(SES)).toBe(false);
    T = run([a, b], T, at0 + a.table.OPEN_WAIT_MS);
    for (const p of [a, b]) {
      expect(top(p).get(SES)).toBeInstanceOf(Y.Map);
      expect(p.casino.casinoWhole(TABLE)).toBe(true);
    }
    run([a, b], T, T + 15_000);
    for (const p of [a, b]) expect([...foldOf(p).felts.keys()].sort()).toEqual([a.pid, b.pid].sort());
  });

  it('opens the session of a base that came with no map for it: nothing of the game\'s records lacks, and no key of a session moved', async () => {
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OPEN_WAIT_MS, OUTSIDER_WAIT_MS } = a.table;
    // the house's checkpoint of a later round, which opens another session: the doc has no map for it
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H, 4), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const ses = `ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`;
    clockOf(a, T);
    set(a, trim.key, trim.value);
    expect(res(a)).toMatchObject({ live: true, base: { key: trim.key } });
    expect(lacks(a)).toMatchObject([{ u: 3, missing: 0, sessionMissing: true, pubs: [] }]);
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const t0 = T;
    T = frames(a, T, t0 + OPEN_WAIT_MS + OUTSIDER_WAIT_MS - STEP);
    expect(top(a).has(ses)).toBe(false);
    frames(a, T, t0 + OPEN_WAIT_MS + OUTSIDER_WAIT_MS);
    expect(top(a).get(ses)).toBeInstanceOf(Y.Map);
    expect(lacks(a)).toEqual([]);
  });

  it('a frame of a page whose doc holds part of an update writes nothing, and its wait starts again once the doc is whole', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a, b] = await gameRoom(['A', 'B']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OUTSIDER_WAIT_MS } = a.table;
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    clockOf(a, T);
    del(a, root.key);
    const at0 = T;
    T = frames(a, T, T);
    // the second half of an update with no first: nearly the whole of its wait goes by so
    deliver(T, a, [second]);
    T = frames(a, T, at0 + OUTSIDER_WAIT_MS - 1_000);
    deliver(T, a, [first]);
    const whole = T;
    T = frames(a, T, whole + OUTSIDER_WAIT_MS - STEP);
    expect(top(a).has(root.key)).toBe(false);
    frames(a, T, whole + OUTSIDER_WAIT_MS);
    expect(top(a).get(root.key)).toEqual(root.value);
  });

  it('a page that slept starts its waits again once it is awake: nothing on the frames of its lapse, then the records in its turn, and the session OPEN_WAIT_MS and its turn on', async () => {
    const [a, b] = await pagesWhere((x, y) => before('restore', 0, x, y));
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    const { STAGGER_MS, OPEN_WAIT_MS } = b.table;
    const { TABLE_LEASE_LAPSE_MS } = b.croupier;
    // the second in turn at the records, alone: its waits begin
    clockOf(b, T);
    del(b, root.key, SES);
    frame(T, b);
    // asleep for longer than a lapse: it wakes, and waits a lapse out
    const woke = T + 10_000;
    const awake = woke + TABLE_LEASE_LAPSE_MS;
    const seen = new Map<string, number>();
    for (T = woke; T <= awake + OPEN_WAIT_MS + 2 * STAGGER_MS; T += STEP) {
      frame(T, b);
      expect(b.croupier.tablesAwake(clockOf(b, T)), `${T - woke} ms after it woke`).toBe(T >= awake);
      for (const key of [root.key, SES]) if (top(b).has(key) && !seen.has(key)) seen.set(key, T - awake);
    }
    expect(seen.get(root.key)).toBe(framed(STAGGER_MS));
    expect(seen.get(SES)).toBe(framed(OPEN_WAIT_MS + (before('open', 0, b, a) ? 0 : STAGGER_MS)));
  });

  it('the turns start again when the records came back and went between two looks of a page', async () => {
    const [a, b] = await pagesWhere((x, y) => before('restore', 0, x, y));
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    const wrote = putBacksOf([b], root.key);
    const gone = (): void => del(a, root.key);
    const back = (): void => set(a, root.key, root.value);
    // the second in turn, alone: its turn is STAGGER_MS on
    const t0 = T;
    handed(T, a, b, gone);
    T = frames(b, T, t0 + 1_000 - STEP);
    expect(wrote).toEqual([]);
    const t1 = T;
    handed(T, a, b, back, gone);
    frames(b, T, t1 + 5_000);
    expect(wrote.map((w) => w.at - t1)).toEqual([framed(b.table.STAGGER_MS)]);
  });

  it('and when the page found the game whole in between: its turn is from when the records went again', async () => {
    const [a, b] = await pagesWhere((x, y) => before('restore', 0, x, y));
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    const wrote = putBacksOf([b], root.key);
    const gone = (): void => del(a, root.key);
    const back = (): void => set(a, root.key, root.value);
    const t0 = T;
    handed(T, a, b, gone);
    T = frames(b, T, t0 + 1_000 - STEP);
    // back for two looks of the page, and gone again a little before the turn it was waiting for
    handed(T, a, b, back);
    T = frames(b, T, T + STEP);
    expect(lacks(b)).toEqual([]);
    const t2 = T;
    expect(t2 - t0).toBeLessThan(b.table.STAGGER_MS);
    handed(T, a, b, gone);
    frames(b, T, t2 + 5_000);
    expect(wrote.map((w) => w.at - t2)).toEqual([framed(b.table.STAGGER_MS)]);
  });

  it('what came back before the page first found the game lacking is not counted against it', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wrote = putBacksOf([a], root.key);
    const gone = (): void => del(b, root.key);
    const back = (): void => set(b, root.key, root.value);
    // gone and back three times between two looks of the page, and gone
    handed(T, b, a, gone, back, gone, back, gone, back, gone);
    expect(a.casino.computedFairOnlyReturns(TABLE, G.inc)).toBe(3);
    const t0 = T;
    T = frames(a, T, t0 + 5 * STEP);
    expect(wrote.map((w) => w.at)).toEqual([t0]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('nor what came back once the page had the game in mind no more: found whole with no put-back of late, a game is forgotten', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { CONTESTED_CALM_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const gone = (): void => del(b, root.key);
    const back = (): void => set(b, root.key, root.value);
    // the base deleted once: the page puts it back, it lasts, and CONTESTED_CALM_MS after the page read it back it has
    // the game in mind no more
    const t0 = T;
    send(T, a, b);
    handed(T, b, a, gone);
    T = frames(a, T, t0 + STEP + CONTESTED_CALM_MS);
    expect(wrote.map((w) => w.at)).toEqual([t0]);
    // gone and back three times between two looks of the page, and gone: it puts the base back at once
    const t1 = T;
    send(t1, a, b);
    handed(t1, b, a, gone, back, gone, back, gone, back, gone);
    T = frames(a, T, t1 + 5 * STEP);
    expect(wrote.map((w) => w.at)).toEqual([t0, t1]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('put-backs that came and went between two looks are each counted: with CONTESTED_COUNT of them the page stands down at its next look', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wrote = putBacksOf([a], root.key);
    const gone = (): void => del(b, root.key);
    const back = (): void => set(b, root.key, root.value);
    const t0 = T;
    handed(T, b, a, gone);
    T = frames(a, T, t0);
    expect(wrote.map((w) => w.at)).toEqual([t0]);
    // its own put-back deleted two seconds on, and two more made by a peer and deleted, all between two of its looks
    T = frames(a, T, t0 + 2_000 - STEP);
    const t1 = T;
    send(t1, a, b);
    handed(t1, b, a, gone, back, gone, back, gone);
    expect(a.casino.computedFairOnlyReturns(TABLE, G.inc)).toBe(a.table.CONTESTED_COUNT);
    expect(a.table.computedContested(TABLE, clockOf(a, t1 - STEP))).toBe(false);
    T = frames(a, T, t1 + 5_000);
    // (the look that stands it down writes nothing, though its turn has come and its last put-back is JUNK_GAP_MS old)
    expect(wrote).toHaveLength(1);
    expect(a.table.computedContested(TABLE, clockOf(a, t1))).toBe(true);
    expect(top(a).has(root.key)).toBe(false);
  });

  it('a put-back counts from the look that read it, whatever the game lacked then: four that each lasted, the last seventy seconds after the first, are no contest', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wrote = putBacksOf([a], root.key);
    const t0 = T;
    const goneAt = [0, 25_000, 50_000, 70_000];
    T = frames(a, T, t0 + 75_000, (now) => {
      if (goneAt.includes(now - t0)) del(a, root.key);
    });
    expect(wrote.map((w) => w.at - t0)).toEqual(goneAt);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('a put-back counts for CONTESTED_CALM_MS from the look that read it, and no more at the look that long after it', async () => {
    /** The base deleted at 0, 20 and 40 s and `late` ms after CONTESTED_CALM_MS: when the page put it back. */
    const putBackAt = async (late: number): Promise<number[]> => {
      const [a] = await gameRoom(['A']);
      expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
      const T = run([a], T0 + STEP, T0 + 2 * STEP);
      const wrote = putBacksOf([a], root.key);
      const goneAt = [0, 20_000, 40_000, a.table.CONTESTED_CALM_MS + late];
      frames(a, T, T + a.table.CONTESTED_CALM_MS + 5_000, (now) => {
        if (goneAt.includes(now - T)) del(a, root.key);
      });
      return wrote.map((w) => w.at - T);
    };
    // (the first put-back was read at the page's next look, STEP after it was made)
    expect(await putBackAt(STEP)).toEqual([0, 20_000, 40_000, 60_000 + STEP]);
    expect(await putBackAt(0)).toEqual([0, 20_000, 40_000]);
  });

  it('put-backs older than CONTESTED_CALM_MS count no more, though the page found the game lacking at every look since', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, CONTESTED_CALM_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    /** A peer deletes the base whenever it is there. */
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    // two put-backs that did not last, both read
    const t0 = T;
    T = frames(a, T, t0 + JUNK_GAP_MS + STEP, peer);
    expect(wrote.map((w) => w.at - t0)).toEqual([0, JUNK_GAP_MS]);
    // the page's doc holds part of an update for longer than CONTESTED_CALM_MS: no look of it writes, and the game lacks all the while
    const [first, second] = updatesOf(b, () => {
      set(b, 'x:1', 1);
      set(b, 'x:2', 2);
    });
    deliver(T, a, [second]);
    T = frames(a, T, T + CONTESTED_CALM_MS + 2_000);
    expect(wrote).toHaveLength(2);
    expect(lacks(a)).toMatchObject([{ missing: 1 }]);
    // whole again: CONTESTED_COUNT more before it stands down, the two of before counting for nothing
    deliver(T, a, [first]);
    const whole = T;
    T = frames(a, T, whole + 10_000, peer);
    expect(wrote.slice(2).map((w) => w.at - whole)).toEqual([0, JUNK_GAP_MS, 2 * JUNK_GAP_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
  });

  it('a record deleted a little after each time it comes back is contested all the same, and the stand-down outlasts the record coming back: found whole, the game is kept in mind', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, CONTESTED_CALM_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const t0 = T;
    /** A peer deletes the base two looks after each put-back: the page finds the game whole in between. */
    const peer = (now: number): void => {
      const last = wrote.length > 0 ? wrote[wrote.length - 1].at : t0 - 2 * STEP;
      if (top(a).has(root.key) && now - last >= 2 * STEP) del(a, root.key);
    };
    T = frames(a, T, t0 + 4_000, peer);
    expect(wrote.map((w) => w.at - t0)).toEqual([0, JUNK_GAP_MS, 2 * JUNK_GAP_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
    // a peer puts it back, and it lasts: the page finds the game whole for longer than CONTESTED_CALM_MS
    send(T, a, b);
    handed(T, b, a, () => set(b, root.key, root.value));
    T = frames(a, T, T + CONTESTED_CALM_MS + 10_000);
    expect(lacks(a)).toEqual([]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
    // deleted again: the page stands down still
    clockOf(a, T);
    del(a, root.key);
    T = frames(a, T, T + 5_000);
    expect(wrote).toHaveLength(3);
    expect(top(a).has(root.key)).toBe(false);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
  });

  it('a clock gone back a little, to before the waits began, starts them from where it went back to', async () => {
    const [a, b] = await pagesWhere((x, y) => before('restore', 0, x, y));
    bet(a, b);
    let T = run([a, b], T0 + STEP, T0 + 2 * STEP);
    const { STAGGER_MS, OPEN_WAIT_MS } = b.table;
    const wrote = putBacksOf([b], root.key);
    // the second in turn at the records, alone: its waits begin, and three looks on its clock reads earlier than when they did
    clockOf(b, T);
    del(b, root.key, SES);
    const t0 = T;
    T = frames(b, T, t0 + 2 * STEP);
    b.skew = -800;
    const stepped = T;
    expect(clockOf(b, stepped)).toBeLessThan(t0);
    let opened: number | null = null;
    for (; T <= stepped + OPEN_WAIT_MS + 3 * STAGGER_MS; T += STEP) {
      NOW = T;
      frame(T, b);
      expect(b.croupier.tablesAwake(clockOf(b, T))).toBe(true);
      if (opened === null && top(b).has(SES)) opened = T - stepped;
    }
    expect(wrote.map((w) => w.at - stepped)).toEqual([framed(STAGGER_MS)]);
    expect(opened).toBe(framed(OPEN_WAIT_MS + (before('open', 0, b, a) ? 0 : STAGGER_MS)));
  });

  it('a clock gone back a little inside a wait leaves the wait running on the page\'s clock: its put-back comes that much later, and no wait starts again', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OUTSIDER_WAIT_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    clockOf(a, T);
    del(a, root.key);
    const t0 = T;
    T = frames(a, T, t0 + 10_000 - STEP);
    // ten seconds into its wait the page's clock reads 800 ms earlier: no wake (under TABLE_CLOCK_SLACK_MS)
    a.skew = -800;
    for (; T <= t0 + OUTSIDER_WAIT_MS + 5_000; T += STEP) {
      NOW = T;
      frame(T, a);
      expect(a.croupier.tablesAwake(clockOf(a, T))).toBe(true);
    }
    expect(wrote.map((w) => w.at - t0)).toEqual([OUTSIDER_WAIT_MS + 800]);
  });

  it('a clock gone back a minute: the put-backs the page counted and its own last one, stamped after now, count for nothing', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    // two put-backs that did not last, both read
    const t0 = T;
    T = frames(a, T, t0 + JUNK_GAP_MS + STEP, peer);
    expect(wrote.map((w) => w.at - t0)).toEqual([0, JUNK_GAP_MS]);
    a.skew = -60_000;
    // (it wakes, and waits a lapse out) at its first look awake it puts the base back, and CONTESTED_COUNT from there make a contest
    const awake = T + a.croupier.TABLE_LEASE_LAPSE_MS;
    T = frames(a, T, awake + 5_000, peer);
    expect(wrote.slice(2).map((w) => w.at - awake)).toEqual([0, JUNK_GAP_MS, 2 * JUNK_GAP_MS]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
  });

  it('a clock gone back during a stand-down leaves it KEEP_BACKOFF_MS from the page\'s first look awake at the most, and the put-backs counted before it count no more', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    const contested = (at: number): boolean => a.table.computedContested(TABLE, clockOf(a, at));
    const t0 = T;
    T = frames(a, T, t0 + 10_000 - STEP, peer);
    expect(wrote).toHaveLength(3);
    expect(contested(T - STEP)).toBe(true);
    // its clock goes back by nearly a whole stand-down: what it stood down until is further off than one is long, which is no word of it
    a.skew = -570_000;
    expect(contested(T)).toBe(false);
    const awake = T + a.croupier.TABLE_LEASE_LAPSE_MS;
    T = frames(a, T, awake - STEP, peer);
    expect(contested(T - STEP)).toBe(false);
    // awake, it stands down for one from there
    T = frames(a, T, awake, peer);
    expect(contested(awake)).toBe(true);
    T = frames(a, T, awake + KEEP_BACKOFF_MS - STEP, peer);
    expect(wrote).toHaveLength(3);
    expect(contested(T - STEP)).toBe(true);
    // and then puts the base back: its three put-backs of before, under a minute old on its clock, are not counted
    // again, with the one it makes then either (deleted, it makes another)
    frames(a, T, awake + KEEP_BACKOFF_MS + JUNK_GAP_MS, peer);
    expect(wrote.slice(3).map((w) => w.at - awake)).toEqual([KEEP_BACKOFF_MS, KEEP_BACKOFF_MS + JUNK_GAP_MS]);
  });

  it('a put-back read before the clock went back counts no more once the clock has caught up with it: what a peer wrote and deleted late in a stand-down, and a clock gone back five minutes after it, leave the page its three put-backs once the stand-down is over', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote: number[] = [];
    /** The page's frames, to `to`: a peer deletes the base whenever it is there, and writes it itself before the
     *  frames of `puts`. */
    const loop = (to: number, puts: number[] = []): void => {
      for (; T <= to; T += STEP) {
        clockOf(a, T);
        if (top(a).has(root.key)) del(a, root.key);
        if (puts.includes(T)) set(a, root.key, root.value);
        const had = top(a).has(root.key);
        frame(T, a);
        if (!had && top(a).has(root.key)) wrote.push(T);
      }
    };
    const contested = (at: number): boolean => a.table.computedContested(TABLE, clockOf(a, at));
    const t1 = T;
    const stoodAt = t1 + 2 * JUNK_GAP_MS + STEP;
    loop(stoodAt);
    expect(wrote).toHaveLength(3);
    // the peer writes the base and deletes it, twice, forty seconds before the stand-down's end; the page reads both
    const end = stoodAt + KEEP_BACKOFF_MS;
    loop(end - 38_000, [end - 40_000, end - 39_000]);
    // then its clock goes back five minutes, and the stand-down lasts that much longer: the page writes nothing, awake
    // or not, and at none of its looks would it have put anything back
    a.skew = -300_000;
    const over = end + 300_000;
    loop(over - STEP);
    expect(wrote).toHaveLength(3);
    expect(contested(over - STEP)).toBe(true);
    // at its end the two read before the clock went back are forty seconds old on the page's clock, and five minutes
    // older than that: they count for nothing, and the page makes its three put-backs before it stands down again
    loop(over + 2 * JUNK_GAP_MS);
    expect(wrote.slice(3).map((at) => at - over)).toEqual([0, JUNK_GAP_MS, 2 * JUNK_GAP_MS]);
    expect(contested(over + 2 * JUNK_GAP_MS)).toBe(false);
    loop(over + 2 * JUNK_GAP_MS + STEP);
    expect(contested(over + 2 * JUNK_GAP_MS + STEP)).toBe(true);
  });

  it('a stand-down that ended is forgotten once the game is found whole: a clock gone back to before its end does not bring it back', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { KEEP_BACKOFF_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    const t0 = T;
    T = frames(a, T, t0 + 4_000, peer);
    expect(wrote).toHaveLength(3);
    // a peer puts the base back, and it lasts until the stand-down is over
    send(T, a, b);
    handed(T, b, a, () => set(b, root.key, root.value));
    T = frames(a, T, t0 + KEEP_BACKOFF_MS + 10_000);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
    // the page's clock goes back five minutes, and the base is deleted: awake, the page puts it back at once
    a.skew = -300_000;
    del(a, root.key);
    const awake = T + a.croupier.TABLE_LEASE_LAPSE_MS;
    T = frames(a, T, awake + 2 * STEP);
    expect(wrote.slice(3).map((w) => w.at - awake)).toEqual([0]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('and when put-backs of late keep the game in mind past the stand-down\'s end: found whole, it is forgotten at the look of its end all the same', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    const t0 = T;
    const end = t0 + 2 * JUNK_GAP_MS + STEP + KEEP_BACKOFF_MS;
    T = frames(a, T, t0 + 4_000, peer);
    expect(wrote).toHaveLength(3);
    // a peer puts the base back, and it lasts; five seconds before the stand-down ends it is deleted and put back
    // again, between two looks of the page
    send(T, a, b);
    handed(T, b, a, () => set(b, root.key, root.value));
    T = frames(a, T, end - 5_000 - STEP);
    send(T, a, b);
    handed(T, b, a, () => del(b, root.key), () => set(b, root.key, root.value));
    // (the page's last look before its clock goes back is the one at the stand-down's end)
    T = frames(a, T, end);
    expect(lacks(a)).toEqual([]);
    expect(a.table.computedContested(TABLE, clockOf(a, end))).toBe(false);
    // the page's clock goes back five minutes, and the base is deleted: awake, the page puts it back at once
    a.skew = -300_000;
    del(a, root.key);
    const awake = T + a.croupier.TABLE_LEASE_LAPSE_MS;
    T = frames(a, T, awake + 2 * STEP);
    expect(wrote.slice(3).map((w) => w.at - awake)).toEqual([0]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('a stand-down that ended is forgotten at the page\'s first look past its end, the game lacking still: a clock gone back to before its end does not bring it back', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    const t0 = T;
    const end = t0 + 2 * JUNK_GAP_MS + STEP + KEEP_BACKOFF_MS;
    // the stand-down runs out with the base gone all the while; the page puts it back at its end, and that one is
    // deleted too
    T = frames(a, T, end + STEP, peer);
    expect(wrote.map((w) => w.at - t0)).toEqual([0, JUNK_GAP_MS, 2 * JUNK_GAP_MS, end - t0]);
    expect(a.table.computedContested(TABLE, clockOf(a, end + STEP))).toBe(false);
    // the page's clock goes back five minutes: awake, it puts the base back at once
    a.skew = -300_000;
    const awake = T + a.croupier.TABLE_LEASE_LAPSE_MS;
    T = frames(a, T, awake + 2 * STEP, peer);
    expect(wrote.slice(4).map((w) => w.at - awake)).toEqual([0]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('and at a look of a page that is not ready: one that slept through the end of its stand-down forgets it at its first look, and a clock gone back to before that end while it waits out its waking does not bring it back', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { JUNK_GAP_MS, KEEP_BACKOFF_MS } = a.table;
    const { TABLE_LEASE_LAPSE_MS } = a.croupier;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    const t0 = T;
    const end = t0 + 2 * JUNK_GAP_MS + STEP + KEEP_BACKOFF_MS;
    // it draws no frame from three seconds before the end of its stand-down to four after
    frames(a, T, end - 3_000, peer);
    expect(wrote).toHaveLength(3);
    expect(a.table.computedContested(TABLE, clockOf(a, end - 3_000))).toBe(true);
    // it wakes and looks, not awake yet; then its clock goes back five minutes, to before the stand-down's end
    const woke = end + 4_000;
    T = frames(a, woke, woke + 2 * STEP, peer);
    expect(wrote).toHaveLength(3);
    a.skew = -300_000;
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
    const awake = T + TABLE_LEASE_LAPSE_MS;
    T = frames(a, T, awake - STEP, peer);
    expect(wrote).toHaveLength(3);
    // awake, it puts the base back at once, and says nothing of a stand-down
    T = frames(a, T, awake + 2 * STEP, peer);
    expect(wrote.slice(3).map((w) => w.at - awake)).toEqual([0]);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('the turns after a stand-down are from its end, or from when the page\'s wait began if that is later: a page that slept through the end waits its turn from when it is awake', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OUTSIDER_WAIT_MS, KEEP_BACKOFF_MS } = a.table;
    const { TABLE_LEASE_LAPSE_MS } = a.croupier;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    // three put-backs that do not last, each a turn after the one before went: the page stands down
    const t0 = T;
    T = frames(a, T, t0 + 3 * OUTSIDER_WAIT_MS + 5 * STEP, peer);
    expect(wrote.map((w) => w.at - t0)).toEqual([OUTSIDER_WAIT_MS, 2 * OUTSIDER_WAIT_MS + STEP, 3 * OUTSIDER_WAIT_MS + 2 * STEP]);
    const stoodAt = wrote[2].at + STEP;
    expect(a.table.computedContested(TABLE, clockOf(a, stoodAt - STEP))).toBe(false);
    expect(a.table.computedContested(TABLE, clockOf(a, stoodAt))).toBe(true);
    const end = stoodAt + KEEP_BACKOFF_MS;
    // it draws no frame from three seconds before the end of its stand-down to four after: it wakes, and waits a
    // lapse out
    frames(a, T, end - 3_000, peer);
    const woke = end + 4_000;
    const awake = woke + TABLE_LEASE_LAPSE_MS;
    T = frames(a, woke, awake + OUTSIDER_WAIT_MS - STEP, peer);
    expect(wrote).toHaveLength(3);
    frames(a, T, awake + OUTSIDER_WAIT_MS, peer);
    expect(wrote.slice(3).map((w) => w.at - awake)).toEqual([OUTSIDER_WAIT_MS]);
  });

  it('and from the look that finds a put-back come and gone since its last, when that is later: a page that drew no frame for four seconds around the end of its stand-down, a peer putting the base back and deleting it meanwhile, waits its turn from that look', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OUTSIDER_WAIT_MS, KEEP_BACKOFF_MS } = a.table;
    const wrote = putBacksOf([a], root.key);
    const peer = (): void => {
      if (top(a).has(root.key)) del(a, root.key);
    };
    const t0 = T;
    T = frames(a, T, t0 + 3 * OUTSIDER_WAIT_MS + 5 * STEP, peer);
    expect(wrote).toHaveLength(3);
    const stoodAt = wrote[2].at + STEP;
    expect(a.table.computedContested(TABLE, clockOf(a, stoodAt))).toBe(true);
    const end = stoodAt + KEEP_BACKOFF_MS;
    // it draws no frame from two seconds before the end of its stand-down to two after (under a lapse: it does not
    // sleep), and a peer puts the base back and deletes it in between
    frames(a, T, end - 2_000, peer);
    set(a, root.key, root.value);
    del(a, root.key);
    const mine = wrote.length;
    const looked = end + 2_000;
    T = frames(a, looked, looked + OUTSIDER_WAIT_MS - STEP, peer);
    expect(a.table.computedContested(TABLE, clockOf(a, T - STEP))).toBe(false);
    expect(wrote).toHaveLength(mine);
    frames(a, T, looked + OUTSIDER_WAIT_MS, peer);
    expect(wrote.slice(mine).map((w) => w.at - looked)).toEqual([OUTSIDER_WAIT_MS]);
  });

  it('a doc bound again starts with no stand-down of the binding before', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    T = frames(a, T, T + 4_000, () => {
      if (top(a).has(root.key)) del(a, root.key);
    });
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
    // the base comes back and stays: the page stands down still
    set(a, root.key, root.value);
    T = frames(a, T, T + STEP);
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(true);
    rebind(a);
    T = frames(a, T, T);
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: true, base: { key: root.key } });
    expect(a.table.computedContested(TABLE, clockOf(a, T))).toBe(false);
  });

  it('a page that does not hear the room puts the records back all the same, and opens no session until it has heard the room for OPEN_WAIT_MS', async () => {
    const [a] = await gameRoom(['A'], { hears: true });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OPEN_WAIT_MS } = a.table;
    clockOf(a, T);
    del(a, root.key, SES);
    T = frames(a, T, T + 2 * OPEN_WAIT_MS);
    expect(top(a).get(root.key)).toEqual(root.value);
    expect(top(a).has(SES)).toBe(false);
    // it hears the room from here on
    const heardFrom = T;
    const hears = (now: number): void => a.table.noteRoomHeard(clockOf(a, now));
    T = frames(a, T, heardFrom + OPEN_WAIT_MS - STEP, hears);
    expect(top(a).has(SES)).toBe(false);
    frames(a, T, heardFrom + OPEN_WAIT_MS, hears);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('a session that came back and went again is waited for anew, from when it went again: while the game lacked a record all along', async () => {
    // (a page with no felt: its turns are OUTSIDER_WAIT_MS on, and the base it lacks is put back only then)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OPEN_WAIT_MS, OUTSIDER_WAIT_MS } = a.table;
    clockOf(a, T);
    del(a, root.key, SES);
    const t0 = T;
    T = frames(a, T, t0 + 3_000 - STEP);
    // a peer opens one, the page looks, and it is deleted again
    set(a, SES, new Y.Map());
    T = frames(a, T, T);
    expect(lacks(a)).toMatchObject([{ missing: 1, sessionMissing: false }]);
    del(a, SES);
    const t1 = T;
    T = frames(a, T, t1 + OPEN_WAIT_MS + OUTSIDER_WAIT_MS - STEP);
    expect(top(a).get(root.key)).toEqual(root.value);
    expect(top(a).has(SES)).toBe(false);
    frames(a, T, t1 + OPEN_WAIT_MS + OUTSIDER_WAIT_MS);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('a session another page opened, deleted again before this page\'s next look, is waited for anew: the map came and went, though no look of the page found it there', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wait = a.table.OPEN_WAIT_MS + a.table.OUTSIDER_WAIT_MS;
    clockOf(a, T);
    del(a, SES);
    const t0 = T;
    T = frames(a, T, t0 + 3_000 - STEP);
    // another page opens the session and a peer deletes it, both between two looks of this page
    set(a, SES, new Y.Map());
    del(a, SES);
    const t1 = T;
    T = frames(a, T, t1 + wait - STEP);
    expect(top(a).has(SES)).toBe(false);
    frames(a, T, t1 + wait);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('a base that opens another session, with no map for that one either, is a wait of its own: from when it came', async () => {
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wait = a.table.OPEN_WAIT_MS + a.table.OUTSIDER_WAIT_MS;
    clockOf(a, T);
    del(a, SES);
    const t0 = T;
    T = frames(a, T, t0 + 3_000 - STEP);
    // the house's checkpoint of a later round comes: it opens another session, and the doc has no map for it
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H, 4), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const ses = `ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`;
    set(a, trim.key, trim.value);
    expect(res(a)).toMatchObject({ live: true, base: { key: trim.key } });
    const t1 = T;
    T = frames(a, T, t1 + wait - STEP);
    expect(top(a).has(ses)).toBe(false);
    frames(a, T, t1 + wait);
    expect(top(a).get(ses)).toBeInstanceOf(Y.Map);
    expect(top(a).has(SES)).toBe(false);
  });

  it('a key of another session of the game that comes or goes starts the wait again, as the map of the session the base opens does: the moves are counted of the game\'s sessions, whichever its base opens when they are made', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wait = a.table.OPEN_WAIT_MS + a.table.OUTSIDER_WAIT_MS;
    clockOf(a, T);
    del(a, SES);
    const t0 = T;
    T = frames(a, T, t0 + 3_000 - STEP);
    // a peer writes a map under another session's key of the game, and deletes it two seconds on
    const other = `ses:${TABLE}:${G.inc}:${'f'.repeat(SID.length)}`;
    expect(other).not.toBe(SES);
    set(a, other, new Y.Map());
    T = frames(a, T, T + 2_000 - STEP);
    del(a, other);
    const t1 = T;
    // (four moves: the map the game was opened with, its going, the other one's coming and going)
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true, sid: SID, sesMoves: 4 }]);
    T = frames(a, T, t1 + wait - STEP);
    expect(top(a).has(SES)).toBe(false);
    frames(a, T, t1 + wait);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('a session the page opened itself, deleted again before its next look, is waited for anew: a peer that deletes it at once gets one opening a wait, not one a look', async () => {
    // (a page with no felt: its turn is OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const wait = a.table.OPEN_WAIT_MS + a.table.OUTSIDER_WAIT_MS;
    clockOf(a, T);
    del(a, SES);
    const t0 = T;
    T = frames(a, T, t0 + wait);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
    del(a, SES);
    const t1 = T;
    T = frames(a, T, t1 + wait - STEP);
    expect(top(a).has(SES)).toBe(false);
    frames(a, T, t1 + wait);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('and when the page found the game whole in between', async () => {
    const [a] = await gameRoom(['A']);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OPEN_WAIT_MS } = a.table;
    clockOf(a, T);
    del(a, root.key, SES);
    const t0 = T;
    // (the page puts the base back at once, its turn the first, and keeps that put-back in mind)
    T = frames(a, T, t0 + 3_000 - STEP);
    expect(top(a).get(root.key)).toEqual(root.value);
    set(a, SES, new Y.Map());
    T = frames(a, T, T);
    expect(lacks(a)).toEqual([]);
    del(a, SES);
    const t1 = T;
    // (its felt is the one the page last counted: its turn at the session is the first)
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true, pubs: [a.pub] }]);
    T = frames(a, T, t1 + OPEN_WAIT_MS - STEP);
    expect(top(a).has(SES)).toBe(false);
    frames(a, T, t1 + OPEN_WAIT_MS);
    expect(top(a).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('and when nothing of the game was listed in between for want of a check, the map gone all the while: a game the page keeps in mind has no wait left once it is not listed', async () => {
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    // (a page that keeps one verdict at a time, and has no felt: its turns are OUTSIDER_WAIT_MS on)
    const late = await oneVerdictFrom(a, T);
    T = run([late], T, T + STEP);
    const wait = late.table.OPEN_WAIT_MS + late.table.OUTSIDER_WAIT_MS;
    clockOf(late, T);
    del(late, root.key, SES);
    const t0 = T;
    T = frames(late, T, t0 + 2_000 - STEP);
    // a peer puts the base back: the page keeps that put-back in mind, and waits for the session's map
    set(late, root.key, root.value);
    T = frames(late, T, T);
    expect(lacks(late)).toMatchObject([{ missing: 0, sessionMissing: true, returns: 1 }]);
    // no check can run, and the room's delegations change: the game waits with no base, and nothing of it is listed
    late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0, budgetMs: 0 });
    set(late, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(late)).toMatchObject({ pending: true, base: null });
    T = frames(late, T, T);
    expect(lacks(late)).toEqual([]);
    // checks run again: the session is listed as missing again, and no key of a session moved meanwhile (two had: the
    // map the page bound the doc with, and its going)
    late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0 });
    clockOf(late, T);
    del(late, delegationKey(third.pub));
    const t1 = T;
    expect(res(late)).toMatchObject({ pending: false, base: { key: root.key } });
    expect(lacks(late)).toMatchObject([{ missing: 0, sessionMissing: true, sesMoves: 2 }]);
    T = frames(late, T, t1 + wait - STEP);
    expect(top(late).has(SES)).toBe(false);
    frames(late, T, t1 + wait);
    expect(top(late).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('and when the map came and went while the game named no base for want of a check, between two looks of the page: the moves of a session\'s key are counted whether the game\'s base is read or not', async () => {
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    // (a page that keeps one verdict at a time, and has no felt: its turn is OUTSIDER_WAIT_MS on)
    const late = await oneVerdictFrom(a, T);
    T = run([late], T, T + STEP);
    const wait = late.table.OPEN_WAIT_MS + late.table.OUTSIDER_WAIT_MS;
    clockOf(late, T);
    del(late, SES);
    const t0 = T;
    T = frames(late, T, t0 + 3_000 - STEP);
    expect(lacks(late)).toMatchObject([{ missing: 0, sessionMissing: true, sid: SID, sesMoves: 2 }]);
    // between two looks of the page: no check can run and the room's delegations change (the game waits, and names no
    // base), another page opens the session, a peer deletes it, and checks run again
    late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0, budgetMs: 0 });
    set(late, delegationKey(third.pub), delegation(owner, third.pub, PAGE_ROOM));
    expect(res(late)).toMatchObject({ pending: true, base: null });
    set(late, SES, new Y.Map());
    del(late, SES);
    late.casino.setComputedVerifyForTests({ authMax: 1, now: () => 0 });
    clockOf(late, T);
    del(late, delegationKey(third.pub));
    const t1 = T;
    expect(res(late)).toMatchObject({ pending: false, base: { key: root.key } });
    // (the same session to open, its map gone as before: only the count of the moves tells the page it came and went)
    expect(lacks(late)).toMatchObject([{ missing: 0, sessionMissing: true, sid: SID, sesMoves: 4 }]);
    T = frames(late, T, t1 + wait - STEP);
    expect(top(late).has(SES)).toBe(false);
    frames(late, T, t1 + wait);
    expect(top(late).get(SES)).toBeInstanceOf(Y.Map);
  });

  it('a put-back whose write has a waiting check made, and so moves the game to a base that opens another session, opens nothing at that look: the page waited for the old session, and the new one has a wait and a turn of its own', async () => {
    // (a page with no felt: its turns are OUTSIDER_WAIT_MS on)
    const [a] = await gameRoom(['A']);
    let T = run([a], T0 + STEP, T0 + 2 * STEP);
    const { OPEN_WAIT_MS, OUTSIDER_WAIT_MS } = a.table;
    const wait = OPEN_WAIT_MS + OUTSIDER_WAIT_MS;
    // the session's map goes; and, no check running from here, the house's checkpoint of a later round comes, which
    // opens another session (the doc has no map for that one either) and waits for its check
    clockOf(a, T);
    del(a, SES);
    const t0 = T;
    const trim = trimOf(G, 'p', { b: SID, u: 3, n: {}, h: kit.houseCommit(H, 4), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const ses = `ses:${TABLE}:${G.inc}:${nextSid3(G, trim.value)}`;
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    set(a, trim.key, trim.value);
    expect(res(a)).toMatchObject({ pending: true, live: true, base: { key: root.key } });
    expect(lacks(a)).toMatchObject([{ missing: 0, sessionMissing: true, sid: SID }]);
    // the base is deleted OUTSIDER_WAIT_MS before the session's wait is over: the put-back of the one and the opening
    // of the other are due at the same look
    T = frames(a, T, t0 + OPEN_WAIT_MS - STEP);
    clockOf(a, T);
    del(a, root.key);
    T = frames(a, T, t0 + wait - STEP);
    expect(top(a).has(root.key)).toBe(false);
    expect(res(a)).toMatchObject({ pending: true, base: { key: root.key } });
    // checks can run again, and none has before the page's look: its put-back is the first write to have the
    // checkpoint's check made
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    const due = T;
    T = frames(a, T, T);
    expect(top(a).get(root.key)).toEqual(root.value);
    expect(res(a)).toMatchObject({ pending: false, live: true, base: { key: trim.key } });
    // neither session is opened at that look: the old one is the game's no more, and nobody has waited for the new one
    expect(top(a).has(SES)).toBe(false);
    expect(top(a).has(ses)).toBe(false);
    // its wait is from the page's next look, which is the first to read it
    T = frames(a, T, due + STEP + wait - STEP);
    expect(top(a).has(ses)).toBe(false);
    frames(a, T, due + STEP + wait);
    expect(top(a).get(ses)).toBeInstanceOf(Y.Map);
    expect(top(a).has(SES)).toBe(false);
  });
});
