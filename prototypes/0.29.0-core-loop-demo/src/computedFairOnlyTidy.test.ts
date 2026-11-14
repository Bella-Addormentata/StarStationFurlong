/**
 * 🔒🧹 The pages delete the forged records of a FAIR ONLY game (design §8.4 P7,
 * PR 6c-4b-3a): a checkpoint or a transfer whose signature fails under the key
 * it claims, and a checkpoint that carries such a transfer. Anyone can write
 * one; each costs every page that resolves the game a check, and enough forged
 * transfers in the holder's way hold the game's answer off
 * (computedFairOnlyAuth MAX_FORGED_XFS). Nothing else is deleted: not junk, not
 * a record of a key with no authority, not a stranger's transfer.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the first page's doc as its owner's page would write it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, xfId, xfKey } from './computedFairOnly';
import type { XferRec } from './computedFairOnly';
import { dutyRank, nextSid3 } from './computedFold';
import { buyer, changed, delegation, hex, house as H, NAME, offerOf, owner, rootOf, stranger, trimOf, xferOf } from './computedFairOnlyKit';
import { clockOf, loadPage, PAGE_ROOM, PAGE_TABLE as TABLE, run, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, red } from './computedTestKit';
import { houseSign } from './computedHouse';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
/** computedFairOnlyAuth's and casinoDoc's, as the specs count with them. */
const MAX_FORGED_XFS = 64;

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

/** A house checkpoint of the game at round `u` whose signature is no good. */
const forgedCk = (u: number) =>
  changed(G, trimOf(G, 'p', { b: SID, u, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, dl: delegation(owner, H.pub, PAGE_ROOM) }), { g: BAD_SIG });
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

/** A peer's write of `recs` into the room, as it reaches both pages at T. */
function strew(T: number, a: Page, b: Page, recs: { key: string; value: unknown }[]): void {
  clockOf(a, T);
  a.doc.transact(() => {
    for (const r of recs) top(a).set(r.key, r.value);
  }, 'peer');
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

describe('the forged records of a game are deleted (P7)', () => {
  it('a forged checkpoint goes at the first look of the page whose turn is first, and the other page writes nothing', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const first = dutyRank('restore', G, 0, a.pub) < dutyRank('restore', G, 0, b.pub) ? a : b;
    const deletes = deletesOf([a, b]);
    const forged = forgedCk(4);
    strew(T0 + STEP, a, b, [forged]);
    for (const p of [a, b]) {
      expect(resolved(p).invalid).toEqual([forged.key]);
      expect(p.casino.computedFairOnlyForged()).toMatchObject([{ t: TABLE, inc: G.inc, forged: 1 }]);
    }
    run([first], T0 + 2 * STEP, T0 + 2 * STEP, { step: STEP });
    expect(has(first, forged.key)).toBe(false);
    sync(T0 + 2 * STEP, a, b);
    run([a, b], T0 + 3 * STEP, T0 + 20_000, { step: STEP });
    expect(deletes).toEqual([{ by: first.pid, n: 1 }]);
    for (const p of [a, b]) {
      expect(has(p, forged.key)).toBe(false);
      expect(has(p, root.key)).toBe(true);
      expect(resolved(p)).toMatchObject({ invalid: [], live: true, pending: false });
      expect(p.casino.computedFairOnlyForged()).toEqual([]);
    }
  });

  it('the second page deletes it STAGGER_MS on if the first does not, and a page with no felt at the game in one of the few turns after the bettors\', by its rank', async () => {
    // (an outsider whose rank puts it past the first of the outsiders' turns: a page's key is new with every load)
    const bucket = (p: Page): number => parseInt(dutyRank('restore', G, 0, p.pub).slice(0, 2), 16) % p.table.TIDY_OUTSIDER_TURNS;
    let late = await loadPage('C', 3);
    for (let i = 0; i < 64 && bucket(late) === 0; i++) late = await loadPage('C', 3);
    expect(bucket(late)).toBeGreaterThan(0);
    const [a, b, c] = await gameRoom(['A', 'B', late]);
    bet(a, b, T0);
    sync(T0, a, b, c);
    const [first, second] = dutyRank('restore', G, 0, a.pub) < dutyRank('restore', G, 0, b.pub) ? [a, b] : [b, a];
    const forged = forgedCk(4);
    strew(T0 + STEP, a, b, [forged]);
    sync(T0 + STEP, a, b, c);
    // (the first page's frames stop: the second looks alone, and hands nothing to the outsider)
    const secondAt = run([second], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => !has(second, forged.key) });
    expect(secondAt).toBeGreaterThanOrEqual(T0 + STEP + second.table.STAGGER_MS);
    expect(secondAt).toBeLessThanOrEqual(T0 + STEP + second.table.STAGGER_MS + 2 * STEP);
    expect(has(c, forged.key)).toBe(true);
    // the outsider alone: its turn runs from its own first look
    const outsiderAt = run([c], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => !has(c, forged.key) });
    const turn = 2 + bucket(c);
    expect(outsiderAt).toBeGreaterThanOrEqual(T0 + 2 * STEP + turn * c.table.STAGGER_MS);
    expect(outsiderAt).toBeLessThanOrEqual(T0 + 2 * STEP + turn * c.table.STAGGER_MS + 2 * STEP);
    expect(outsiderAt).toBeLessThan(T0 + c.table.OUTSIDER_WAIT_MS);
    expect(has(first, forged.key)).toBe(true); // (it never looked, and heard nothing since)
  });

  it('nothing else goes: junk under a checkpoint\'s key, a checkpoint and a transfer of a key with no authority, well signed', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const junk = { key: `ck:${TABLE}:${G.inc}:${hex('7', 32)}`, value: { junk: 1 } };
    const strangers = trimOf(G, 'p', { b: SID, u: 4, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, k: stranger.pub, dl: undefined });
    const notHolders = xferOf(G, stranger, buyer, 1, { asset: DEED });
    const forged = forgedCk(4);
    const deletes = deletesOf([a, b]);
    strew(T0 + STEP, a, b, [junk, strangers, notHolders, forged]);
    run([a, b], T0 + 2 * STEP, T0 + 30_000, { step: STEP });
    sync(T0 + 30_000, a, b);
    for (const p of [a, b]) {
      expect(has(p, forged.key)).toBe(false);
      for (const kept of [junk, strangers, notHolders, root]) expect(has(p, kept.key), kept.key).toBe(true);
    }
    expect(deletes.reduce((n, d) => n + d.n, 0)).toBeGreaterThanOrEqual(1);
    expect(deletes.every((d) => d.n === 1)).toBe(true);
  });

  it('a forged transfer goes, and the checkpoints that carry it with it', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const xf = forgedXf(0, 1);
    const carrier = trimOf(G, 'p', { b: SID, u: 4, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, k: buyer.pub, dl: undefined, x: [xf.value] });
    strew(T0 + STEP, a, b, [xf, carrier]);
    for (const p of [a, b]) expect(resolved(p).invalid).toEqual([carrier.key, xf.key].sort());
    run([a, b], T0 + 2 * STEP, T0 + 10_000, { step: STEP });
    sync(T0 + 10_000, a, b);
    for (const p of [a, b]) {
      expect(has(p, xf.key)).toBe(false);
      expect(has(p, carrier.key)).toBe(false);
      expect(resolved(p)).toMatchObject({ holder: owner.pub, invalid: [], pending: false });
    }
  });

  it('a flood of forged transfers in the holder\'s way holds the answer off only until the pages have deleted them, a look\'s worth at a time; the good transfer behind them then moves the game', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const N = 5 * (MAX_FORGED_XFS + 1) + 7;
    const flood = Array.from({ length: N }, (_, i) => forgedXf(0, i + 1));
    const good = xferOf(G, owner, buyer, 1, { asset: DEED });
    const deletes = deletesOf([a, b]);
    strew(T0 + STEP, a, b, [...flood, good]);
    for (const p of [a, b]) {
      expect(resolved(p)).toMatchObject({ holder: owner.pub, pending: true });
      expect(resolved(p).invalid).toHaveLength(MAX_FORGED_XFS + 1);
    }
    const doneAt = run([a, b], T0 + 2 * STEP, T0 + 120_000, {
      step: STEP,
      each: (T) => sync(T, a, b),
      until: () => [a, b].every((p) => !resolved(p).pending && p.casino.computedFairOnlyForged().length === 0),
    });
    // (six looks' worth for the page whose turn it is, and a little for the hand-over between the two)
    expect(doneAt).toBeLessThanOrEqual(T0 + 2 * STEP + 12 * STEP + a.table.STAGGER_MS);
    for (const p of [a, b]) {
      for (const f of flood) expect(has(p, f.key)).toBe(false);
      expect(has(p, good.key)).toBe(true);
      expect(resolved(p)).toMatchObject({ holder: buyer.pub, pending: false, invalid: [] });
    }
    expect(Math.max(...deletes.map((d) => d.n))).toBeLessThanOrEqual(MAX_FORGED_XFS + 1);
  });

  it('a page that is not awake deletes nothing, and its turn starts when it is', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const second = dutyRank('restore', G, 0, a.pub) < dutyRank('restore', G, 0, b.pub) ? b : a;
    const forged = forgedCk(4);
    strew(T0 + STEP, a, b, [forged]);
    run([second], T0 + 2 * STEP, T0 + 2 * STEP, { step: STEP }); // (it saw the record: its turn runs from here)
    // no frame for a minute: it slept. The first frame after is a wake, and deletes nothing.
    const wake = T0 + 60_000;
    run([second], wake, wake, { step: STEP });
    expect(has(second, forged.key)).toBe(true);
    // (awake again from `ready` on: the turn is counted from there, not from before the sleep)
    const ready = run([second], wake + STEP, wake + 60_000, { step: STEP, until: () => second.croupier.tablesAwake(Date.now()) });
    const goneAt = run([second], ready + STEP, ready + 60_000, { step: STEP, until: () => !has(second, forged.key) });
    expect(goneAt).toBeGreaterThanOrEqual(ready - STEP + second.table.STAGGER_MS);
    expect(goneAt).toBeLessThanOrEqual(ready + second.table.STAGGER_MS + 2 * STEP);
  });

  it('the page whose turn is first deletes nothing either at the frame it wakes at', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const first = dutyRank('restore', G, 0, a.pub) < dutyRank('restore', G, 0, b.pub) ? a : b;
    const forged = forgedCk(4);
    strew(T0 + STEP, a, b, [forged]);
    const wake = T0 + 60_000;
    run([first], wake, wake, { step: STEP });
    expect(first.croupier.tablesAwake(wake)).toBe(false);
    expect(has(first, forged.key)).toBe(true);
    run([first], wake + STEP, wake + 60_000, { step: STEP, until: () => !has(first, forged.key) });
    expect(has(first, forged.key)).toBe(false);
  });

  it('answers a peer that writes the forged record again, each time', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0);
    const forged = forgedCk(4);
    let T = T0 + STEP;
    for (let i = 0; i < 6; i++) {
      strew(T, a, b, [forged]);
      T = run([a, b], T + STEP, T + 10_000, { step: STEP, each: (t) => sync(t, a, b), until: () => !has(a, forged.key) && !has(b, forged.key) });
      expect(has(a, forged.key) || has(b, forged.key), `round ${i}`).toBe(false);
      T += STEP;
    }
    expect(has(a, root.key)).toBe(true);
  });

  it('deleteFairOnlyForged deletes only what the last resolution listed and the doc still holds as it read it, and nothing of a game it does not track', async () => {
    const [a] = await gameRoom(['A']);
    const forged = forgedCk(4);
    clockOf(a, T0 + STEP);
    a.doc.transact(() => top(a).set(forged.key, forged.value), 'peer');
    expect(a.casino.deleteFairOnlyForged('roulette-9', G.inc)).toBe(0);
    expect(a.casino.deleteFairOnlyForged(TABLE, G.inc)).toBe(1);
    expect(a.casino.deleteFairOnlyForged(TABLE, G.inc)).toBe(0);
    expect(has(a, forged.key)).toBe(false);
    expect(has(a, root.key)).toBe(true);
  });

  it('deletes FORGED_DELETE_MAX records a write: a forged transfer that hundreds of checkpoints carry goes in two', async () => {
    const [a] = await gameRoom(['A']);
    const xf = forgedXf(0, 1);
    const carriers = Array.from({ length: 300 }, (_, i) =>
      trimOf(G, 'p', { b: SID, u: 4 + i, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, k: buyer.pub, dl: undefined, x: [xf.value] }));
    clockOf(a, T0 + STEP);
    a.doc.transact(() => {
      for (const r of carriers) top(a).set(r.key, r.value);
    }, 'peer');
    expect(resolved(a).invalid).toHaveLength(300);
    expect(a.casino.computedFairOnlyForged()).toMatchObject([{ forged: 300 }]);
    expect(a.casino.deleteFairOnlyForged(TABLE, G.inc)).toBe(a.casino.FORGED_DELETE_MAX);
    expect(a.casino.FORGED_DELETE_MAX).toBe(256);
    expect(a.casino.deleteFairOnlyForged(TABLE, G.inc)).toBe(300 - 256);
    expect(a.casino.computedFairOnlyForged()).toEqual([]);
    expect(has(a, root.key)).toBe(true);
  });

  it('a game with no felt down is tidied all the same, inside the outsiders\' turns: every page is one', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    const forged = forgedXf(0, 1);
    strew(T0 + STEP, a, b, [forged]);
    const goneAt = run([a, b], T0 + 2 * STEP, T0 + 60_000, { step: STEP, until: () => !has(a, forged.key) && !has(b, forged.key) });
    expect(goneAt).toBeLessThanOrEqual(T0 + 2 * STEP + (a.table.TIDY_OUTSIDER_TURNS - 1) * a.table.STAGGER_MS + 2 * STEP);
  });

  it('asks for no slice while a game\'s answer waits for forged transfers to go: every check is made, and the page is idle until its turn', async () => {
    const [c] = await gameRoom(['C']);
    const flood = Array.from({ length: MAX_FORGED_XFS + 10 }, (_, i) => forgedXf(0, i + 1));
    clockOf(c, T0 + STEP);
    c.doc.transact(() => {
      for (const r of flood) top(c).set(r.key, r.value);
    }, 'peer');
    expect(resolved(c)).toMatchObject({ pending: true, holder: owner.pub });
    expect(resolved(c).invalid).toHaveLength(MAX_FORGED_XFS + 1);
    let transactions = 0;
    c.doc.on('afterTransaction', () => { transactions += 1; });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transactions).toBe(0);
  });
});
