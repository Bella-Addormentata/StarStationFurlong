/**
 * 🔒🧹 The pages compact an ended FAIR ONLY game (design §8.4 P6, PR 6c-4b-3b):
 * once the game's base is a checkpoint that ends it and stands by itself, what
 * the doc holds of the game beside it goes: its sessions' maps, its other
 * checkpoints, its transfers, its end order. The end checkpoint stays, and a
 * page that comes later reads the game from it alone.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the first page's doc as its owner's page would write it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, sealFin, xfId, xfKey } from './computedFairOnly';
import type { XferRec } from './computedFairOnly';
import { dutyRank, nextSid3 } from './computedFold';
import { buyer, delegation, hex, house as H, NAME, offerOf, owner, rootOf, trimOf, xferOf } from './computedFairOnlyKit';
import { clockOf, loadPage, PAGE_ROOM, PAGE_TABLE as TABLE, run, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, red } from './computedTestKit';
import { houseSign } from './computedHouse';

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

const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(G, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID = nextSid3(G, root.value);
/** A signature that is well formed and good for nothing. */
const BAD_SIG = houseSign(H.secret, new Uint8Array([1, 2, 3]));
const DEED = { kind: 'deed' as const, roomId: PAGE_ROOM, roomName: 'Furlong' };

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const has = (p: Page, key: string): boolean => top(p).has(key);
const resolved = (p: Page) => p.casino.computedResolutionOf(TABLE, G.inc)!;

/** A transfer by the game's holder at round `u` that nobody signed (offer `i`). */
function forgedXf(u: number, i: number): { key: string; value: unknown } {
  const o = { ...offerOf(owner, buyer, { asset: DEED, nonce: i.toString(16).padStart(24, '0') }), sig: BAD_SIG };
  const value = { v: 1, o, u, k: buyer.pub, g: BAD_SIG };
  return { key: xfKey(G.t, G.inc, xfId(value as XferRec) as string), value };
}

/** Pages `names` (or the pages themselves, loaded already), 1,000 chips each, and the game open in the first page's
 *  doc, all synced at T0. */
async function gameRoom(names: (string | Page)[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(typeof name === 'string' ? await loadPage(name, i + 1) : name);
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  const [a] = pages;
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(`ses:${TABLE}:${G.inc}:${SID}`, new Y.Map());
  });
  sync(T0, ...pages);
  run(pages, T0, T0, { step: STEP }); // (awake)
  return pages;
}

/** A and B have a staked felt each at the game: theirs are the first turns. */
function bet(a: Page, b: Page, T: number): void {
  expect(a.table.writeComputedSlip(TABLE, [red(10)], T)).toBe('ok');
  expect(b.table.writeComputedSlip(TABLE, [black(20)], T)).toBe('ok');
  sync(T, a, b);
}

/** The deletes of keys of the top map that `pages` make from here on: by which page, how many keys. */
function deletesOf(pages: Page[]): { by: string; n: number }[] {
  const out: { by: string; n: number }[] = [];
  for (const p of pages) {
    p.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!tr.local || tr.origin === 'peer') return;
      const keys = [...(tr.changed.get(top(p) as never) ?? [])].filter((k) => k !== null && !top(p).has(k as string));
      if (keys.length > 0) out.push({ by: p.pid, n: keys.length });
    });
  }
  return out;
}

const sesKey = `ses:${TABLE}:${G.inc}:${SID}`;
/** The game's keys page `p`'s doc holds, sorted. */
const keysOf = (p: Page): string[] => [...top(p).keys()].filter((k) => k.includes(`:${G.inc}`)).sort();
/** An older checkpoint of the game by its house, at round 3. */
const older = trimOf(G, 'p', { b: SID, u: 3, l: hex('b', 32), n: { alice: '5', bob: '-5' }, dl: delegation(owner, H.pub, PAGE_ROOM) });
const fin = sealFin(G, owner.pub, owner.sign);
/** The game's end by its holder at round 5, carrying its end order. */
const end = trimOf(G, 'p', { u: 5, l: hex('e', 32), n: { alice: '7', bob: '-7' }, e: 1, f: fin.value, s: undefined, h: undefined, k: owner.pub, dl: undefined });
const COMPACT_MS = 10_000;

/** The game ended in the room of `pages` at T: an older checkpoint, the end order under its key and the end. */
function endGame(T: number, pages: Page[], recs: { key: string; value: unknown }[] = [older, fin, end]): void {
  const [a] = pages;
  clockOf(a, T);
  a.doc.transact(() => {
    for (const r of recs) top(a).set(r.key, r.value);
  }, 'peer');
  sync(T, ...pages);
}

describe('an ended game is compacted (P6)', () => {
  /** Pages A and B loaded so that A's turn at the game's compaction is before B's. */
  async function inTurn(): Promise<[Page, Page]> {
    const bucket = (p: Page): number => parseInt(dutyRank('restore', G, 5, p.pub).slice(0, 2), 16) % p.table.TIDY_OUTSIDER_TURNS;
    let a = await loadPage('A', 1);
    for (let i = 0; i < 64 && bucket(a) !== 0; i++) a = await loadPage('A', 1);
    let b = await loadPage('B', 2);
    for (let i = 0; i < 64 && bucket(b) !== 2; i++) b = await loadPage('B', 2);
    expect([bucket(a), bucket(b)]).toEqual([0, 2]);
    await gameRoom([a, b]);
    return [a, b];
  }

  it('COMPACT_MS after the page whose turn is first saw it ended, all but the end checkpoint goes in one write, and the other page writes nothing', async () => {
    const [a, b] = await inTurn();
    bet(a, b, T0);
    const deletes = deletesOf([a, b]);
    endGame(T0 + STEP, [a, b]);
    run([a, b], T0 + 2 * STEP, T0 + 2 * STEP, { step: STEP });
    for (const p of [a, b]) {
      expect(resolved(p)).toMatchObject({ live: false, pending: false });
      expect(resolved(p).base?.key).toBe(end.key);
      expect(p.casino.computedFairOnlyEnded()).toMatchObject([{ t: TABLE, inc: G.inc, u: 5, left: 4 }]);
    }
    // (nothing before the wait is over)
    run([a, b], T0 + 3 * STEP, T0 + 2 * STEP + COMPACT_MS - STEP, { step: STEP });
    expect(deletes).toEqual([]);
    expect(keysOf(a)).toEqual([root.key, older.key, end.key, fin.key, sesKey].sort());
    run([a, b], T0 + 2 * STEP + COMPACT_MS, T0 + 60_000, { step: STEP });
    expect(deletes).toEqual([{ by: a.pid, n: 4 }]);
    for (const p of [a, b]) {
      expect(keysOf(p)).toEqual([end.key]);
      expect(resolved(p)).toMatchObject({ live: false, pending: false, holder: owner.pub });
      expect(resolved(p).base?.key).toBe(end.key);
      expect(resolved(p).base?.ck.n).toEqual({ alice: '7', bob: '-7' });
      expect(p.casino.computedFairOnlyEnded()).toEqual([]);
      expect(p.casino.computedSettled()).toBe(true);
      expect(p.casino.casinoWhole()).toBe(true);
    }
  });

  it('a page whose turn is later compacts it that many STAGGER_MS on if the first does not', async () => {
    const [a, b] = await inTurn();
    endGame(T0 + STEP, [a, b]);
    const seen = T0 + 2 * STEP;
    const goneAt = run([b], seen, T0 + 60_000, { step: STEP, until: () => keysOf(b).length === 1 });
    expect(goneAt).toBeGreaterThanOrEqual(seen + COMPACT_MS + 2 * b.table.STAGGER_MS);
    expect(goneAt).toBeLessThanOrEqual(seen + COMPACT_MS + 2 * b.table.STAGGER_MS + 2 * STEP);
    expect(keysOf(b)).toEqual([end.key]);
  });

  it('a page that comes after reads the game from the end checkpoint alone, as the pages that compacted it do', async () => {
    const [a] = await gameRoom(['A']);
    endGame(T0 + STEP, [a]);
    run([a], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => keysOf(a).length === 1 });
    expect(keysOf(a)).toEqual([end.key]);
    const c = await loadPage('C', 3);
    clockOf(c, T0 + 61_000);
    sync(T0 + 61_000, a, c);
    run([a, c], T0 + 61_000, T0 + 90_000, { step: STEP });
    const [ra, rc] = [resolved(a), c.casino.computedResolutionOf(TABLE, G.inc)!];
    expect(rc).toMatchObject({ live: false, pending: false, holder: owner.pub });
    expect(rc.base?.key).toBe(end.key);
    expect(rc.base?.ck.n).toEqual(ra.base?.ck.n);
    expect(keysOf(c)).toEqual([end.key]);
    expect(c.casino.computedSettled()).toBe(true);
  });

  it('nothing of a live game goes, whatever it holds', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    endGame(T0 + STEP, [a, b], [older, fin]);
    const deletes = deletesOf([a, b]);
    run([a, b], T0 + 2 * STEP, T0 + 60_000, { step: STEP });
    expect(deletes).toEqual([]);
    expect(resolved(a).live).toBe(true);
    expect(a.casino.computedFairOnlyEnded()).toEqual([]);
    expect(a.casino.compactFairOnly(TABLE, G.inc)).toBe(0);
    for (const key of [root.key, older.key, fin.key, sesKey]) expect(has(a, key)).toBe(true);
  });

  it('a game that ended after a hand-over is compacted too, its transfer with the rest: the buyer\'s end carries it, and a page that comes after reads the buyer as its holder', async () => {
    const xf = xferOf(G, owner, buyer, 3, { asset: DEED });
    const bfin = sealFin(G, buyer.pub, buyer.sign);
    const bend = trimOf(G, 'p', { u: 5, l: hex('e', 32), n: {}, e: 1, f: bfin.value, s: undefined, h: undefined, k: buyer.pub, dl: undefined, x: [xf.value] });
    const [a] = await gameRoom(['A']);
    endGame(T0 + STEP, [a], [older, xf, bfin, bend]);
    run([a], T0 + 2 * STEP, T0 + 2 * STEP, { step: STEP });
    expect(resolved(a)).toMatchObject({ live: false, pending: false, holder: buyer.pub });
    expect(keysOf(a)).toEqual([root.key, older.key, bend.key, xf.key, bfin.key, sesKey].sort());
    run([a], T0 + 3 * STEP, T0 + 60_000, { step: STEP });
    expect(keysOf(a)).toEqual([bend.key]);
    const c = await loadPage('C', 3);
    clockOf(c, T0 + 61_000);
    sync(T0 + 61_000, a, c);
    run([a, c], T0 + 61_000, T0 + 70_000, { step: STEP });
    expect(c.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: false, pending: false, holder: buyer.pub });
    expect(keysOf(c)).toEqual([bend.key]);
  });

  it('what comes after the compaction goes too, after the wait again: a checkpoint a lagging page puts back, a session\'s map a peer writes, junk under a transfer\'s key', async () => {
    const [a] = await gameRoom(['A']);
    endGame(T0 + STEP, [a]);
    let T = run([a], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => keysOf(a).length === 1 });
    for (const rec of [older, { key: sesKey, value: null }, { key: forgedXf(2, 1).key, value: 'junk' }]) {
      // (a second on: the page has seen the game with nothing left meanwhile)
      T = run([a], T + STEP, T + 1_000, { step: STEP });
      clockOf(a, T);
      a.doc.transact(() => top(a).set(rec.key, rec.value ?? new Y.Map()), 'peer');
      const wrote = T;
      T = run([a], wrote, wrote + 60_000, { step: STEP, until: () => keysOf(a).length === 1 });
      expect(keysOf(a), rec.key).toEqual([end.key]);
      expect(T, rec.key).toBeGreaterThanOrEqual(wrote + COMPACT_MS);
      expect(T, rec.key).toBeLessThan(wrote + COMPACT_MS + 8_000);
    }
    expect(resolved(a).base?.key).toBe(end.key);
  });

  it('the end checkpoint a peer deleted is put back, and nothing is compacted while the doc lacks it', async () => {
    const [a] = await gameRoom(['A']);
    endGame(T0 + STEP, [a]);
    run([a], T0 + 2 * STEP, T0 + 2 * STEP, { step: STEP });
    expect(resolved(a).base?.key).toBe(end.key);
    clockOf(a, T0 + 3 * STEP);
    a.doc.transact(() => top(a).delete(end.key), 'peer');
    expect(a.casino.computedFairOnlyEnded()).toEqual([]);
    expect(a.casino.compactFairOnly(TABLE, G.inc)).toBe(0);
    run([a], T0 + 4 * STEP, T0 + 90_000, { step: STEP, until: () => keysOf(a).length === 1 });
    expect(keysOf(a)).toEqual([end.key]);
  });

  it('a page that is not awake compacts nothing, and in a room with no table left the work owed keeps its frames marked until it is done', async () => {
    const [a] = await gameRoom(['A']);
    endGame(T0 + STEP, [a]);
    run([a], T0 + 2 * STEP, T0 + 2 * STEP, { step: STEP });
    const wake = T0 + 62_000;
    run([a], wake, wake, { step: STEP, tables: [] });
    expect(a.croupier.tablesAwake(wake)).toBe(false);
    expect(keysOf(a).length).toBe(5);
    expect(a.table.tableFrame(0)).toBe(true);
    const ready = run([a], wake + STEP, wake + 60_000, { step: STEP, tables: [], until: () => a.croupier.tablesAwake(Date.now()) });
    const goneAt = run([a], ready + STEP, ready + 60_000, { step: STEP, tables: [], until: () => keysOf(a).length === 1 });
    expect(keysOf(a)).toEqual([end.key]);
    expect(goneAt).toBeGreaterThanOrEqual(ready - STEP + COMPACT_MS);
    run([a], goneAt + STEP, goneAt + 2_000, { step: STEP, tables: [] });
    expect(a.casino.computedFairOnlyEnded()).toEqual([]);
    expect(a.table.tableFrame(0)).toBe(false);
  });

  it('a checkpoint of the game\'s house at a higher round than the end makes the game live again, as before: the compaction took nothing it stands on, and the page puts the end order it held back under its key', async () => {
    const [a] = await gameRoom(['A']);
    endGame(T0 + STEP, [a]);
    let T = run([a], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => keysOf(a).length === 1 });
    expect(keysOf(a)).toEqual([end.key]);
    // (a house that was split from the room when the game ended: its trim at round 7, and the session it opens)
    const later = trimOf(G, 'p', { b: SID, u: 7, l: hex('f', 32), n: { alice: '9', bob: '-9' }, dl: delegation(owner, H.pub, PAGE_ROOM) });
    const laterSes = `ses:${TABLE}:${G.inc}:${nextSid3(G, later.value)}`;
    clockOf(a, T + STEP);
    a.doc.transact(() => {
      top(a).set(later.key, later.value);
      top(a).set(laterSes, new Y.Map());
    }, 'peer');
    T = run([a], T + STEP, T + 60_000, { step: STEP });
    expect(resolved(a)).toMatchObject({ live: true, pending: false, holder: owner.pub });
    expect(resolved(a).base?.key).toBe(later.key);
    expect(resolved(a).fin).toEqual(fin.value);
    expect(a.casino.computedFairOnlyEnded()).toEqual([]);
    expect(keysOf(a)).toEqual([later.key, end.key, fin.key, laterSes].sort());
    expect(top(a).get(fin.key)).toEqual(fin.value);
  });

  it('nothing is compacted while a check of the game waits: a flood of forged transfers is deleted first (P7), then the rest goes', async () => {
    const [a] = await gameRoom(['A']);
    const flood = Array.from({ length: 70 }, (_, i) => forgedXf(5, i));
    endGame(T0 + STEP, [a], [older, fin, end, ...flood]);
    expect(resolved(a)).toMatchObject({ live: false, pending: true });
    expect(resolved(a).base?.key).toBe(end.key);
    expect(a.casino.computedFairOnlyEnded()).toEqual([]);
    expect(a.casino.compactFairOnly(TABLE, G.inc)).toBe(0);
    expect(keysOf(a).length).toBe(75);
    run([a], T0 + 2 * STEP, T0 + 60_000, { step: STEP });
    expect(keysOf(a)).toEqual([end.key]);
    expect(resolved(a)).toMatchObject({ live: false, pending: false });
  });

  it('compactFairOnly deletes COMPACT_DELETE_MAX keys a write, never the end checkpoint, and nothing of a game it does not track or of another', async () => {
    const [a] = await gameRoom(['A']);
    const other = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, { ...NAME, j: hex('9', 24) }) };
    const theirs = rootOf(other, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
    const many = Array.from({ length: 300 }, (_, i) => ({ key: forgedXf(1, i).key, value: 'junk' }));
    endGame(T0 + STEP, [a], [older, fin, end, theirs, ...many]);
    expect(a.casino.compactFairOnly('roulette-9', G.inc)).toBe(0);
    expect(a.casino.computedFairOnlyEnded()).toMatchObject([{ left: 304 }]);
    expect(a.casino.COMPACT_DELETE_MAX).toBe(256);
    expect(a.casino.compactFairOnly(TABLE, G.inc)).toBe(256);
    expect(a.casino.compactFairOnly(TABLE, G.inc)).toBe(48);
    expect(a.casino.compactFairOnly(TABLE, G.inc)).toBe(0);
    expect(keysOf(a)).toEqual([end.key]);
    expect(has(a, theirs.key)).toBe(true);
  });
});
