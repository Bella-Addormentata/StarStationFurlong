/**
 * 🔒🎲 Pages play a FAIR ONLY game (design §8.4, PR 6c-4b-1a): the duties of a
 * page at a table that plays a `p` roulette or `q` craps game, in the order a
 * round takes them: the bets, the house's join, the close that names it, the
 * seeds, the house's reveal; and what a page does not do there (a close that
 * names no house, a trim, an attestation), and when it waits (the pauses).
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the first page's doc as its owner's page would write it;
 * the house is a TestHouse whose records a spec writes by hand, as the node's
 * house job would (computedHouseDuties.test.ts does the same at a house table).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, sealFin } from './computedFairOnly';
import { asAbandon, asClose, dutyRank, MAX_FROZEN, MAX_HELD_ROUNDS, MAX_TABLE_PID_BYTES, MAX_TABLE_PIDS, nextSid3, seedTable, utf8Length } from './computedFold';
import type { CloseRec, FoldCtx } from './computedFold';
import { delegation, hex, house as H, NAME, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { clockOf, deleteIn, deliver, frame, keysIn, loadPage, openRoom, PAGE_CTX, PAGE_INC, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run, sync, trimByHand, updatesOf } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, straight, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';

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

/** The roulette game the owner opens at the table, in the page kit's room. */
const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(G, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID = nextSid3(G, root.value);
const kit = new ComputedKit(G);

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const casinoOf = (p: Page) => p.doc.getMap<unknown>('casino');
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const recOf = <R>(p: Page, key: string): R => p.casino.computedSessionForWrite(TABLE)!.get(key) as R;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(recOf(p, k))!);
/** The frozen slips' hashes of close c (sorted). */
const frozenOf = (c: CloseRec): string[] => Object.values(c.f).sort();
const hashIn = (key: string): string => key.slice(key.lastIndexOf(':') + 1);
/** The house's records put in the game's live session on page p. */
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]));

/** The end of a game: the checkpoint its house writes, with the owner's end order. */
const endOf = (ctx: FoldCtx) => trimOf(ctx, 'p', {
  ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(ctx, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {},
});

/** Test identities as players of the room: each pinned on page p. */
function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Pages `names`, 1,000 chips each, and the game open in the first page's doc
 *  (its root, and the live session the root opens), all synced at T0. */
async function gameRoom(names: string[], pids: string[] = [], opts: { resync?: () => void } = {}): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1, { pid: pids[i], ...(opts.resync ? { resync: opts.resync } : {}) }));
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

describe('a round of a FAIR ONLY roulette game, on the pages', () => {
  /** A and B bet, the house joins round 1, and a bettor closes it. */
  async function closedRound() {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const join = kit.houseJoin(H, 1);
    house(a, join);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    for (const p of pages) expect(foldOf(p).joins.map((j) => j.hash)).toEqual([join.hash]);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    return { pages, a, b, join, close, closedAt, closeHash: hashIn(keysIn(a, 'c', 1)[0]) };
  }

  it('closes name the join, every seed in decides nothing, the house\'s reveal does, and the next close names its commitment', async () => {
    const { pages, a, b, join, close, closedAt, closeHash } = await closedRound();
    expect(close.h).toBe(join.rec.c);
    run(pages, closedAt + STEP, closedAt + 12_000, { step: STEP });
    for (const p of pages) {
      expect(keysIn(p, 'x', 1)).toHaveLength(2);
      expect(foldOf(p).tip).toMatchObject({ close: closeHash, decided: null });
      expect(p.table.readComputedRoulette(TABLE)).toMatchObject({ phase: 'closing', round: 1 });
    }
    expect(keysIn(a, 'f', 1)).toEqual([]);
    const hr = kit.houseReveal(H, 1, [closeHash], frozenOf(close));
    house(b, hr);
    sync(closedAt + 12_000, ...pages);
    for (const p of pages) {
      const v = foldOf(p).rounds[0];
      expect(v).toMatchObject({ decided: 'house', counted: [a.pid, b.pid].sort(), house: { hash: hr.hash } });
      expect(foldOf(p).required).toBe(kit.houseCommit(H, 2));
      for (const q of pages) expect(p.casino.readChips(q.pid)).toBe(1_000 + Number(v.deltas.get(q.pid)));
    }
    // Round 2 (once the result has shown its 9 s from the reveal): the close
    // names the commitment the reveal carried.
    const at = closedAt + 22_000;
    run(pages, closedAt + 12_000 + STEP, at, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], at)).toBe('ok');
    sync(at, ...pages);
    run(pages, at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2).map((c) => c.h)).toEqual([kit.houseCommit(H, 2)]);
  });
});

describe('a round with no house commitment to name', () => {
  it('no page closes: the bets stay on the felt, and the join that comes is the commitment the close names', async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const late = run(pages, T0 + STEP, T0 + 60_000, { step: STEP }); // (the betting window is long over)
    for (const p of pages) {
      expect(keysIn(p, 'c')).toEqual([]);
      expect(foldOf(p)).toMatchObject({ required: null, joins: [], tip: null });
      expect([...foldOf(p).felts.values()].map((x) => x.rec.b.length)).toEqual([1, 1]);
    }
    const join = kit.houseJoin(H, 1);
    house(b, join);
    sync(late, ...pages);
    run(pages, late + STEP, late + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    // (Every turn was past due when the join came, so the bettors' pages close together, each naming it.)
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
    expect([...new Set(closesOf(a, 1).map((c) => c.h))]).toEqual([join.rec.c]);
  });

  it('after a house that stepped down, none until it joins the next round: the commitment its last reveal carried is gone', async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const join = kit.houseJoin(H, 1);
    house(a, join);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    run(pages, closedAt + STEP, closedAt + 4_000, { step: STEP });
    // (it decides round 1 and carries no commitment to the next)
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close), { c: null }));
    sync(closedAt + 4_000, ...pages);
    for (const p of pages) expect(foldOf(p)).toMatchObject({ open: 2, required: null, joins: [] });
    const at = closedAt + 20_000;
    run(pages, closedAt + 4_000 + STEP, at, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], at)).toBe('ok');
    sync(at, ...pages);
    const late = run(pages, at + STEP, at + 40_000, { step: STEP });
    expect(keysIn(a, 'c', 2)).toEqual([]);
    const join2 = kit.houseJoin(H, 2);
    house(a, join2);
    sync(late, ...pages);
    run(pages, late + STEP, late + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect([...new Set(closesOf(a, 2).map((c) => c.h))]).toEqual([join2.rec.c]);
  });

  it('a close of its own that the house stepped down is written again, naming the join that follows, and once: the round is not held for good', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).map((c) => c.h)).toEqual([kit.houseCommit(H, 1)]);
    run([a], closedAt + STEP, closedAt + 3_000, { step: STEP });
    expect(foldOf(a).tip).toMatchObject({ r: 1, decided: null });
    // The house steps the commitment down (its seed is public from now on) and joins the round again with another.
    const altSeed = kit.seed('house-alt', 1);
    const alt = kit.houseCommit(H, 1, altSeed);
    house(a, kit.stepDown(H, 1), kit.houseJoin(H, 1, alt));
    const stepped = closedAt + 3_000;
    expect(foldOf(a)).toMatchObject({ tip: null, open: 1, required: null });
    expect(foldOf(a).openCloses.map((c) => c.state)).toEqual(['invalid']);
    const again = run([a], stepped + STEP, stepped + 120_000, { step: STEP, until: () => closesOf(a, 1).some((c) => c.h === alt) });
    const key = keysIn(a, 'c', 1).find((k) => recOf<CloseRec>(a, k).h === alt)!;
    const next = recOf<CloseRec>(a, key);
    expect(next.f[a.pid]).toBe(foldOf(a).felts.get(a.pid)!.hash);
    expect(foldOf(a).tip).toMatchObject({ r: 1, close: hashIn(key), decided: null });
    // Once: the close that stands asks for no other, nor does the refused one come back.
    run([a], again + STEP, again + 20_000, { step: STEP });
    expect(closesOf(a, 1)).toHaveLength(2);
    // The round plays: the house reveals the seed of the commitment the new close names.
    house(a, kit.houseReveal(H, 1, [hashIn(key)], frozenOf(next), { s: altSeed }));
    run([a], again + 20_000 + STEP, again + 24_000, { step: STEP });
    expect(foldOf(a).rounds[0]).toMatchObject({ decided: 'house', counted: [a.pid] });
    expect(a.casino.readChips(a.pid)).toBe(1_000 + Number(foldOf(a).rounds[0].deltas.get(a.pid)));
  });

  it("a close of its own on a parent the walk has left stands for nothing: the page closes again on the parent that stands", async () => {
    const [a] = await gameRoom(['A']);
    // A rival that ranks before this page for round 1 (of two closes the house decided, the walk takes the lowest rank).
    let rival = testIdentity('rival');
    for (let n = 1; dutyRank('close', G, 1, rival.pub) >= dutyRank('close', G, 1, a.pub); n++) rival = testIdentity(`rival-${n}`);
    pinOn(a, rival);
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const closedAt = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [first] = closesOf(a, 1);
    const firstHash = hashIn(keysIn(a, 'c', 1)[0]);
    // The house decides round 1 on this page's close, and round 2 asks for the commitment its reveal carried.
    house(a, kit.houseReveal(H, 1, [firstHash], frozenOf(first)));
    const shown = closedAt + 12_000;
    run([a], closedAt + STEP, shown, { step: STEP });
    expect(foldOf(a)).toMatchObject({ open: 2, parent: firstHash, required: kit.houseCommit(H, 2) });
    const at = shown + 10_000;
    run([a], shown + STEP, at, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], at)).toBe('ok');
    const closed2 = run([a], at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2).map((c) => [c.q, c.h])).toEqual([[firstHash, kit.houseCommit(H, 2)]]);
    // A close of round 1 that arrives late, with the house's reveal for it, ranks before this page's: the walk takes it.
    const slip = kit.slip(rival, 1, [red(1)]);
    const rival1 = kit.close(rival, 1, SID, [slip], kit.houseCommit(H, 1));
    house(a, slip, rival1, kit.reveal(1, rival.pid), kit.houseReveal(H, 1, [rival1.hash], [slip.hash]));
    run([a], closed2 + STEP, closed2 + 1_000, { step: STEP });
    expect(foldOf(a)).toMatchObject({ open: 2, parent: rival1.hash, required: kit.houseCommit(H, 2) });
    expect(foldOf(a).openCloses).toEqual([]);
    // The close of round 2 this page wrote sits on the parent the walk left, so it asks for nothing: one on the parent that stands.
    const again = run([a], closed2 + 1_000 + STEP, closed2 + 60_000, { step: STEP, until: () => closesOf(a, 2).some((c) => c.q === rival1.hash) });
    expect(closesOf(a, 2).map((c) => [c.q, c.h]).sort()).toEqual([[firstHash, kit.houseCommit(H, 2)], [rival1.hash, kit.houseCommit(H, 2)]].sort());
    expect(foldOf(a).openCloses.map((c) => c.state)).not.toContain('invalid');
    // Once.
    run([a], again + STEP, again + 20_000, { step: STEP });
    expect(closesOf(a, 2)).toHaveLength(2);
  });
});

describe('a round with two house joins at a game', () => {
  it('every close names the first join the fold lists (in hash order), the same one on every page', async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    // Two joins of round 1 by the one house, two commitments (a house that restarted and joined again).
    const j1 = kit.houseJoin(H, 1);
    const j2 = kit.houseJoin(H, 1, kit.houseCommit(H, 1, hex('c', 64)));
    expect(j2.rec.c).not.toBe(j1.rec.c);
    house(a, j1, j2);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    for (const q of pages) expect(foldOf(q).joins).toHaveLength(2);
    const firstByHash = [j1, j2].sort((x, y) => (x.hash < y.hash ? -1 : 1))[0];
    for (const q of pages) expect(foldOf(q).joins[0].rec.c).toBe(firstByHash.rec.c);
    const done = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    sync(done, ...pages);
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
    for (const c of closesOf(a, 1)) expect(c.h).toBe(firstByHash.rec.c);
    for (const q of pages) expect(foldOf(q).openCloses.map((c) => c.state)).not.toContain('invalid');
  });
});

describe('a close the fold refuses at a game', () => {
  it("a cheat's Friendly close (it names no house commitment) holds nobody off: the honest pages close the round all the same", async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    // A cheat with a felt of its own on round 1 and a close freezing it that names nothing (S6 a: invalid).
    const cheat = testIdentity('cheat');
    pinOn(a, cheat);
    const slip = kit.slip(cheat, 1, [red(1)]);
    const friendly = kit.close(cheat, 1, SID, [slip]);
    expect(friendly.rec.h).toBeUndefined();
    house(a, slip, friendly);
    sync(T0, ...pages);
    for (const q of pages) expect(foldOf(q).openCloses.map((c) => [c.hash, c.state])).toEqual([[friendly.hash, 'invalid']]);
    const done = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 1 });
    sync(done, ...pages);
    const mine = closesOf(a, 1).filter((c) => c.k !== cheat.pub);
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect(c.h).toBe(kit.houseCommit(H, 1));
    expect(foldOf(a).tip).not.toBeNull();
  });
});

/** A and B bet on round 1 of the game, and the house has joined it. */
async function betting(): Promise<Page[]> {
  const pages = await gameRoom(['A', 'B']);
  const [a, b] = pages;
  house(a, kit.houseJoin(H, 1));
  expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
  expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
  sync(T0, ...pages);
  return pages;
}

describe('when a game pauses its closes', () => {
  it('its rule on its four inputs: the session\'s kept bytes, the room\'s games\', how far the open round is past the base, a standing fin', async () => {
    const [a] = await gameRoom(['A']);
    const t = a.table;
    const PAUSE = t.PAUSE_BYTES;
    const ROOM = t.ROOM_BYTES;
    expect(t.fairClosePaused(0, 0, 1, false)).toBe(false);
    expect(t.fairClosePaused(PAUSE - 1, 0, 1, false)).toBe(false);
    expect(t.fairClosePaused(PAUSE, 0, 1, false)).toBe(true);
    expect(t.fairClosePaused(0, ROOM - 1, 1, false)).toBe(false);
    expect(t.fairClosePaused(0, ROOM, 1, false)).toBe(true);
    expect(t.fairClosePaused(0, 0, MAX_HELD_ROUNDS, false)).toBe(false);
    expect(t.fairClosePaused(0, 0, MAX_HELD_ROUNDS + 1, false)).toBe(true);
    expect(t.fairClosePaused(0, 0, 1, true)).toBe(true);
    expect(PAUSE).toBe(192 * 1024);
    expect(ROOM).toBe(384 * 1024);
  });

  it('a standing fin: the bets stay, no close comes, and one does when the order is gone', async () => {
    const pages = await betting();
    const [a, b] = pages;
    const fin = sealFin(G, owner.pub, owner.sign);
    a.doc.transact(() => top(a).set(fin.key, fin.value));
    sync(T0, ...pages);
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: true, fin: { k: owner.pub } });
    const late = run(pages, T0 + STEP, T0 + 60_000, { step: STEP });
    for (const p of pages) {
      expect(keysIn(p, 'c')).toEqual([]);
      expect(foldOf(p).joins).toHaveLength(1);
    }
    b.doc.transact(() => top(b).delete(fin.key));
    sync(late, ...pages);
    run(pages, late + STEP, late + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
  });
});

const alice = testIdentity('alice');
const bob = testIdentity('bob');

/** Rounds 1 to `n` of the game decided by the house, built by hand for the test players `ids` (pinned): the
 *  house's join, then each round's two slips, the close naming the commitment it asks for, both seeds and the
 *  house's reveal (which carries the next round's commitment). From a base `from` (a house checkpoint at round
 *  `u` and the session `sid` it opens) the rounds are u + 1 to u + n, and the commitment of round u + 1 is the
 *  checkpoint's: no join. */
function rounds(n: number, ids: TestIdentity[] = [alice, bob], from: { u: number; sid: string } = { u: 0, sid: SID }): Built<unknown>[] {
  const out: Built<unknown>[] = from.u === 0 ? [kit.houseJoin(H, 1)] : [];
  let parent = from.sid;
  for (let r = from.u + 1; r <= from.u + n; r++) {
    const slips = [kit.slip(ids[0], r, [red(1)]), kit.slip(ids[1], r, [black(1)])];
    const close = kit.close(ids[0], r, parent, slips, kit.houseCommit(H, r));
    out.push(...slips, close, kit.reveal(r, ids[0].pid), kit.reveal(r, ids[1].pid), kit.houseReveal(H, r, [close.hash], slips.map((x) => x.hash)));
    parent = close.hash;
  }
  return out;
}

describe('the rounds a session may hold', () => {
  /** Page A with `n` rounds decided in the game's session, and a bet on the round that opens. */
  async function played(n: number) {
    const [a] = await gameRoom(['A']);
    pinOn(a, alice, bob);
    house(a, ...rounds(n));
    expect(foldOf(a)).toMatchObject({ open: n + 1, required: kit.houseCommit(H, n + 1) });
    const at = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    return { a, at };
  }

  it('the open round is the last it holds (the base round and MAX_HELD_ROUNDS): its close is written', async () => {
    const { a, at } = await played(MAX_HELD_ROUNDS - 1);
    run([a], at + STEP, at + 40_000, { step: STEP, until: () => keysIn(a, 'c', MAX_HELD_ROUNDS).length > 0 });
    expect(closesOf(a, MAX_HELD_ROUNDS).map((c) => c.h)).toEqual([kit.houseCommit(H, MAX_HELD_ROUNDS)]);
  });

  it('past it, no close is written however long the bet waits: a close for it would be invalid, and the bet stays on the felt', async () => {
    const { a, at } = await played(MAX_HELD_ROUNDS);
    const late = run([a], at + STEP, at + 60_000, { step: STEP });
    expect(keysIn(a, 'c', MAX_HELD_ROUNDS + 1)).toEqual([]);
    expect(foldOf(a).felts.get(a.pid)).toMatchObject({ rec: { r: MAX_HELD_ROUNDS + 1 } });
    expect(late).toBeGreaterThan(at);
  });

  /** A house checkpoint at round `u`, carrying the commitment of round u + 1, and the session it opens (the game's first is gone). */
  function checkpointAt(a: Page, u: number): string {
    const cp = trimOf(G, 'p', { b: SID, u, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, h: kit.houseCommit(H, u + 1), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const sid = nextSid3(G, cp.value);
    a.doc.transact(() => {
      top(a).set(cp.key, cp.value);
      for (const key of [...top(a).keys()]) if (key.startsWith(`ses:${TABLE}:${G.inc}:`)) top(a).delete(key);
      top(a).set(`ses:${TABLE}:${G.inc}:${sid}`, new Y.Map());
    });
    return sid;
  }
  /** Page A on a base at round `u` with `n` rounds decided after it, and a bet on the round that opens. */
  async function playedFrom(u: number, n: number) {
    const [a] = await gameRoom(['A']);
    const sid = checkpointAt(a, u);
    pinOn(a, alice, bob);
    house(a, ...rounds(n, [alice, bob], { u, sid }));
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: true });
    expect(foldOf(a).base.u).toBe(u);
    expect(foldOf(a)).toMatchObject({ open: u + n + 1, required: kit.houseCommit(H, u + n + 1) });
    const at = run([a], T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    return { a, at };
  }

  it('count from the base: a house checkpoint at round 45 opens round 46, the first past the base, and its close is written', async () => {
    const { a, at } = await playedFrom(45, 0);
    run([a], at + STEP, at + 40_000, { step: STEP, until: () => keysIn(a, 'c', 46).length > 0 });
    expect(closesOf(a, 46).map((c) => c.h)).toEqual([kit.houseCommit(H, 46)]);
  });

  it('count from the base, at the edge: MAX_HELD_ROUNDS - 1 rounds after a checkpoint at round 5, the open round is the last the session holds, and its close is written', async () => {
    const { a, at } = await playedFrom(5, MAX_HELD_ROUNDS - 1);
    run([a], at + STEP, at + 40_000, { step: STEP, until: () => keysIn(a, 'c', 5 + MAX_HELD_ROUNDS).length > 0 });
    expect(closesOf(a, 5 + MAX_HELD_ROUNDS).map((c) => c.h)).toEqual([kit.houseCommit(H, 5 + MAX_HELD_ROUNDS)]);
  });

  it('count from the base, past the edge: MAX_HELD_ROUNDS rounds after a checkpoint at round 5, no close is written, and the bet stays on the felt', async () => {
    const { a, at } = await playedFrom(5, MAX_HELD_ROUNDS);
    run([a], at + STEP, at + 60_000, { step: STEP });
    expect(keysIn(a, 'c', 5 + MAX_HELD_ROUNDS + 1)).toEqual([]);
    expect(foldOf(a).felts.get(a.pid)).toMatchObject({ rec: { r: 5 + MAX_HELD_ROUNDS + 1 } });
  });
});

describe('the bytes a session and the room hold', () => {
  /** A long felt: 400 bets, a slip of some 17 KB. */
  const longFelt = Array.from({ length: 400 }, () => straight(17, 100));
  /** Round 1 of game `ctx` (its session `sid`) decided by the house with `k` long felts frozen, by hand: the test players heavy0…, the
   *  house's join, their slips, the close of the first's naming it, their seeds and the house's reveal. */
  function heavyRound1(ctx: FoldCtx, sid: string, k: number): { ids: TestIdentity[]; recs: Built<unknown>[] } {
    const kt = new ComputedKit(ctx);
    const ids = Array.from({ length: k }, (_, i) => testIdentity(`heavy${i}`));
    const slips = ids.map((id) => kt.slip(id, 1, longFelt));
    const close = kt.close(ids[0], 1, sid, slips, kt.houseCommit(H, 1));
    const hr = kt.houseReveal(H, 1, [close.hash], slips.map((x) => x.hash));
    return { ids, recs: [kt.houseJoin(H, 1), ...slips, close, ...ids.map((id) => kt.reveal(1, id.pid)), hr] };
  }
  /** A and B's pages with round 1 decided with `k` long felts frozen in it, and a bet each on round 2: the session holds the kept bytes of
   *  that round (`kept`, which the felts of round 2 are not part of). */
  async function played(k: number) {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const { ids, recs } = heavyRound1(G, SID, k);
    pinOn(a, ...ids);
    house(a, ...recs);
    sync(T0, ...pages);
    expect(foldOf(a)).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
    const at = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    sync(at, ...pages);
    return { pages, a, b, at, kept: foldOf(a).keptBytes - foldOf(a).feltBytes, PAUSE: a.table.PAUSE_BYTES };
  }
  /** How long after the bets a close can fall due with `n` staked pubs: the window, a stagger per pub ahead (the two pages' places among them
   *  are the keys', and random), and some slack. */
  const closeWithin = (a: Page, n: number): number => a.table.BET_WINDOW_MS + (n + 3) * a.table.STAGGER_MS + 10_000;
  /** The most long felts a decided round can freeze with the session still under PAUSE_BYTES: found by building them. */
  let most: number | undefined;
  async function mostUnderPause(): Promise<number> {
    if (most !== undefined) return most;
    for (let k = 6; k <= MAX_FROZEN; k++) {
      const { kept, PAUSE } = await played(k);
      if (kept >= PAUSE) return (most = k - 1);
    }
    throw new Error('no number of long felts reaches PAUSE_BYTES');
  }

  it('a session whose kept bytes are just under PAUSE_BYTES is closed, however much junk it holds beside them', async () => {
    const k = await mostUnderPause();
    const { pages, a, at, kept, PAUSE } = await played(k);
    expect(kept).toBeLessThan(PAUSE);
    // (junk of any weight: rawBytes passes the limit, keptBytes does not)
    putIn(a, Array.from({ length: 25 }, (_, i) => [`junk:${i}`, 'x'.repeat(10_000)]));
    sync(at, ...pages);
    expect(foldOf(a).rawBytes).toBeGreaterThan(PAUSE);
    run(pages, at + STEP, at + closeWithin(a, k + 2), { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2).length).toBeGreaterThan(0);
  });

  it('a session whose kept bytes reach PAUSE_BYTES gets no close until the house trims it: the bets stay on the felt', async () => {
    const k = await mostUnderPause();
    const { pages, a, b, at, kept, PAUSE } = await played(k + 1);
    expect(kept).toBeGreaterThanOrEqual(PAUSE);
    const late = run(pages, at + STEP, at + 60_000, { step: STEP });
    for (const p of pages) {
      expect(keysIn(p, 'c', 2)).toEqual([]);
      expect(foldOf(p).felts.get(a.pid)).toBeDefined();
      expect(foldOf(p).felts.get(b.pid)).toBeDefined();
    }
    // the house's trim of round 1 (the felts of round 2 copied over): the session it opens is light, and the close is written
    const res = foldOf(a);
    const closeHash = hashIn(keysIn(a, 'c', 1)[0]);
    const hr = keysIn(a, 'h', 1)[0];
    const nets = Object.fromEntries([...res.nets].filter(([, v]) => v !== 0n).map(([pid, v]) => [pid, v.toString()]));
    const cp = trimOf(G, 'p', { b: SID, u: 1, l: closeHash, d: `h:${hashIn(hr)}`, n: nets, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const copies = [...res.felts.values()].map((x) => [x.key, recOf<unknown>(a, x.key)] as const);
    a.doc.transact(() => {
      top(a).set(cp.key, cp.value);
      for (const key of [...top(a).keys()]) if (key.startsWith(`ses:${TABLE}:${G.inc}:`)) top(a).delete(key);
      const ses = new Y.Map<unknown>();
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, cp.value)}`, ses);
      for (const [key, v] of copies) ses.set(key, v);
    });
    sync(late, ...pages);
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    expect(foldOf(a).keptBytes - foldOf(a).feltBytes).toBeLessThan(PAUSE);
    run(pages, late + STEP, late + closeWithin(a, k + 3), { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2).length).toBeGreaterThan(0);
  });

  it('a round in flight goes on in a paused session: its seeds are revealed, and a bettor abandons it when the house is silent', async () => {
    const k = await mostUnderPause();
    const { pages, a, b, at, kept, PAUSE } = await played(k + 1);
    expect(kept).toBeGreaterThanOrEqual(PAUSE);
    run(pages, at + STEP, at + 20_000, { step: STEP });
    expect(keysIn(a, 'c', 2)).toEqual([]); // (paused: the natural close is not written)
    // A close of round 2 written before the pause began (by hand: A's key, freezing both felts, naming the commitment).
    const res = foldOf(a);
    const close = kit.close(identityOf(a), 2, res.parent, { [a.pid]: res.felts.get(a.pid)!.hash, [b.pid]: res.felts.get(b.pid)!.hash }, kit.houseCommit(H, 2));
    house(a, close);
    sync(at + 20_000, ...pages);
    for (const q of pages) expect(foldOf(q).tip).toMatchObject({ r: 2, close: close.hash });
    expect(foldOf(a).keptBytes - foldOf(a).feltBytes).toBeGreaterThanOrEqual(PAUSE);
    // The seeds go on (a pause is a pause of closes)…
    const revealed = run(pages, at + 20_000 + STEP, at + 20_000 + 12_000, { step: STEP });
    for (const q of pages) expect(keysIn(q, 'x', 2)).toHaveLength(2);
    // …and the house silent, a bettor voids the round after the wait for it.
    const [first] = [a, b].sort((x, y) => (dutyRank('abandon', G, 2, x.pub) < dutyRank('abandon', G, 2, y.pub) ? -1 : 1));
    run([first], revealed + STEP, at + 20_000 + 60_000, { step: STEP, until: () => keysIn(first, 'z', 2).length > 0 });
    expect(keysIn(first, 'z', 2)).toHaveLength(1);
  });

  it('a held change of a bet is written in a paused session: the felt can be changed while the closes wait', async () => {
    const k = await mostUnderPause();
    const { pages, a, at } = await played(k + 1);
    // A change within the coalescing window: held, shown at once, written by the next frame.
    expect(a.table.writeComputedSlip(TABLE, [red(10), black(5)], at + 50)).toBe('ok');
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toHaveLength(1);
    run(pages, at + STEP, at + 3 * STEP, { step: STEP });
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toHaveLength(2);
  });

  it('the long felts strangers put down on the open round do not pause it, however many: it is closed, and the close freezes what a close can', async () => {
    const pages = await betting();
    const [a] = pages;
    const PAUSE = a.table.PAUSE_BYTES;
    const ids = Array.from({ length: 40 }, (_, i) => testIdentity(`heavy${i}`));
    pinOn(a, ...ids);
    house(a, ...ids.map((id) => kit.slip(id, 1, longFelt)));
    sync(T0, ...pages);
    // (forty long felts: far more than PAUSE_BYTES of kept bytes, all of them felts no close froze)
    expect(foldOf(a).keptBytes).toBeGreaterThan(2 * PAUSE);
    expect(foldOf(a).keptBytes - foldOf(a).feltBytes).toBeLessThan(PAUSE);
    // (the turn of a page comes a stagger per bettor ahead of it after the window, and the 42 bettors' order is the keys': wait for the last)
    run(pages, T0 + STEP, T0 + closeWithin(a, ids.length + 2), { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
    // (a close freezes its own page's felt and the earliest seen of the rest, MAX_FROZEN in all: not one more, nor one fewer)
    for (const c of closesOf(a, 1)) expect(Object.keys(c.f)).toHaveLength(MAX_FROZEN);
  });

  /** A game of the owner's at another table: its root, its live session, and round 1 decided in it with `n` long felts frozen. */
  function otherGame(p: Page, t: string, n: number): FoldCtx {
    const ctx = { room: PAGE_ROOM, t, inc: faironlyInc('p', PAGE_ROOM, t, NAME) };
    const rt = rootOf(ctx, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
    const sid = nextSid3(ctx, rt.value);
    const { ids, recs } = heavyRound1(ctx, sid, n);
    pinOn(p, ...ids);
    p.doc.transact(() => {
      const ses = new Y.Map<unknown>();
      top(p).set(rt.key, rt.value);
      top(p).set(`ses:${t}:${ctx.inc}:${sid}`, ses);
      for (const x of recs) ses.set(x.key, x.rec);
    });
    return ctx;
  }
  it('the room\'s games together pause at ROOM_BYTES: live games of other tables count, an ended one\'s and one nothing opened do not', async () => {
    const pages = await betting();
    const [a] = pages;
    const PAUSE = a.table.PAUSE_BYTES;
    const ROOM = a.table.ROOM_BYTES;
    const keptOf = (t: string): number => a.casino.computedFoldOf(t)!.keptBytes - a.casino.computedFoldOf(t)!.feltBytes;
    expect(a.casino.computedFairOnlyBytes()).toBe(keptOf(TABLE));
    const others = ['roulette-2', 'roulette-3', 'roulette-4'].map((t) => otherGame(a, t, 8));
    // (a game nothing opened: junk of any weight under a session, no root, no base)
    const nameless = faironlyInc('p', PAGE_ROOM, 'roulette-9', NAME);
    a.doc.transact(() => {
      const ses = new Y.Map<unknown>();
      top(a).set(`ses:roulette-9:${nameless}:g`, ses);
      for (let i = 0; i < 30; i++) ses.set(`junk:${i}`, 'x'.repeat(10_000));
    });
    sync(T0, ...pages);
    for (const c of others) expect(keptOf(c.t)).toBeLessThan(PAUSE);
    expect(keptOf(TABLE)).toBeLessThan(PAUSE);
    const total = keptOf(TABLE) + others.reduce((n, c) => n + keptOf(c.t), 0);
    expect(a.casino.computedFairOnlyBytes()).toBe(total);
    expect(total).toBeGreaterThanOrEqual(ROOM);
    const late = run(pages, T0 + STEP, T0 + 40_000, { step: STEP });
    for (const p of pages) expect(keysIn(p, 'c')).toEqual([]);
    // one of the games ends: the room is under the limit again
    const gone = endOf(others[2]);
    a.doc.transact(() => top(a).set(gone.key, gone.value));
    sync(late, ...pages);
    expect(a.casino.computedResolutionOf(others[2].t, others[2].inc)).toMatchObject({ live: false });
    expect(a.casino.computedFairOnlyBytes()).toBeLessThan(ROOM);
    run(pages, late + STEP, late + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
  });

  // A doc that holds part of an update counts nothing new of a table until it is whole, so a game that
  // ends meanwhile keeps the weight it was last counted at: it is not live, and it is no longer the room's.
  it('a game that ends while the doc holds part of an update is no longer weighed, as last counted: the room is lighter by what it weighed', async () => {
    const pages = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    const here = a.casino.computedFairOnlyBytes();
    const ctx = otherGame(a, 'roulette-2', 8);
    sync(T0, ...pages);
    const weighed = a.casino.computedFairOnlyBytes() - here;
    expect(weighed).toBeGreaterThan(0);
    const gone = endOf(ctx);
    const fromB = updatesOf(b, () => b.doc.transact(() => top(b).set(gone.key, gone.value)));
    const fromC = updatesOf(c, () => {
      c.doc.transact(() => casinoOf(c).set('unrelated', 1));
      c.doc.transact(() => casinoOf(c).set('unrelated', 2));
    });
    deliver(T0 + 1, a, [fromC[1]]); // (C's first never came: its second is parked)
    deliver(T0 + 1, a, [fromB[0]]);
    expect(a.casino.casinoWhole()).toBe(false);
    expect(a.casino.computedResolutionOf(ctx.t, ctx.inc)).toMatchObject({ live: false });
    expect(a.casino.computedFairOnlyBytes()).toBe(here);
    deliver(T0 + 2, a, [fromC[0]]);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(a.casino.computedFairOnlyBytes()).toBe(here);
  });

  // …and a game that opens while the doc holds part of an update is resolved and live at once, and counted when
  // the doc is whole: until then nothing has weighed it, and the room's sum goes on without it.
  it('a live game that nothing has counted yet (the doc holds part of an update) weighs nothing in the room, until the doc is whole', async () => {
    const pages = await gameRoom(['A', 'B', 'C']);
    const [a, , c] = pages;
    const here = a.casino.computedFairOnlyBytes();
    const fromC = updatesOf(c, () => {
      c.doc.transact(() => casinoOf(c).set('unrelated', 1));
      c.doc.transact(() => casinoOf(c).set('unrelated', 2));
    });
    deliver(T0 + 1, a, [fromC[1]]); // (C's first never came: its second is parked)
    expect(a.casino.casinoWhole()).toBe(false);
    const ctx = otherGame(a, 'roulette-2', 8); // (written on A itself: applied at once, counted when the doc is whole)
    expect(a.casino.computedResolutionOf(ctx.t, ctx.inc)).toMatchObject({ live: true });
    expect(a.casino.computedFoldOf(ctx.t)).toBeNull();
    expect(a.casino.computedFairOnlyBytes()).toBe(here);
    deliver(T0 + 2, a, [fromC[0]]);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(a.casino.computedFairOnlyBytes()).toBeGreaterThan(here);
  });

  it('only the records a pass used weigh: old versions of a stranger\'s felt (indexed, never used) do not pause the session', async () => {
    const pages = await betting();
    const [a] = pages;
    const stranger = testIdentity('versions');
    pinOn(a, stranger);
    house(a, ...Array.from({ length: 14 }, (_, i) => kit.slip(stranger, 1, longFelt, { v: i + 1 })));
    sync(T0, ...pages);
    expect(foldOf(a).bytes).toBeGreaterThan(a.table.PAUSE_BYTES);
    expect(foldOf(a).keptBytes).toBeLessThan(a.table.PAUSE_BYTES);
    run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
  });

  it('nor do they weigh on the room\'s total: other tables\' games full of old versions leave this game its closes', async () => {
    const pages = await betting();
    const [a] = pages;
    const stranger = testIdentity('versions2');
    pinOn(a, stranger);
    const fill = (t: string): void => {
      const ctx = { room: PAGE_ROOM, t, inc: faironlyInc('p', PAGE_ROOM, t, NAME) };
      const rt = rootOf(ctx, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
      const k = new ComputedKit(ctx);
      a.doc.transact(() => {
        const ses = new Y.Map<unknown>();
        top(a).set(rt.key, rt.value);
        top(a).set(`ses:${t}:${ctx.inc}:${nextSid3(ctx, rt.value)}`, ses);
        for (let i = 0; i < 13; i++) {
          const s = k.slip(stranger, 1, longFelt, { v: i + 1 });
          ses.set(s.key, s.rec);
        }
      });
    };
    const tables = ['roulette-2', 'roulette-3', 'roulette-4'];
    for (const t of tables) fill(t);
    sync(T0, ...pages);
    const sum = (f: (r: NonNullable<ReturnType<typeof a.casino.computedFoldOf>>) => number): number => tables.reduce((n, t) => n + f(a.casino.computedFoldOf(t)!), 0);
    expect(sum((r) => r.bytes)).toBeGreaterThan(a.table.ROOM_BYTES);
    expect(sum((r) => r.keptBytes) + foldOf(a).keptBytes).toBeLessThan(a.table.ROOM_BYTES);
    run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
  });

  /** `n` stranger slips of 400 bets (some 17 KB each) on round 1 of the table's session, their players pinned. */
  const heavyFor = (k: ComputedKit, n: number) => {
    const ids = Array.from({ length: n }, (_, i) => testIdentity(`pheavy${i}`));
    return { ids, slips: ids.map((id) => k.slip(id, 1, longFelt)) };
  };

  it('a page-signed table is no part of a game\'s pauses: its session past PAUSE_BYTES is still closed', async () => {
    const [a] = await openRoom(['A'], T0);
    const { ids, slips } = heavyFor(new ComputedKit(PAGE_CTX), 12);
    pinOn(a, ...ids);
    putIn(a, slips.map((s) => [s.key, s.rec] as [string, unknown]));
    expect(foldOf(a).keptBytes).toBeGreaterThan(a.table.PAUSE_BYTES);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    run([a], T0 + STEP, T0 + 80_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
  });

  it('nor does it weigh on the room\'s total: the page-signed sessions of other tables leave a game its closes', async () => {
    const pages = await betting();
    const [a] = pages;
    for (const [t, inc] of [['roulette-2', 'c' + '6b'.repeat(12)], ['roulette-3', 'c' + '6c'.repeat(12)]] as const) {
      a.doc.transact(() => {
        casinoOf(a).set(`cfg:computed:${t}`, { v: 1, inc });
        a.doc.getMap('casinoComputed').set(`ses:${t}:${inc}:g`, new Y.Map());
      });
      const { ids, slips } = heavyFor(new ComputedKit({ room: PAGE_ROOM, t, inc }), 12);
      pinOn(a, ...ids);
      putIn(a, slips.map((s) => [s.key, s.rec] as [string, unknown]), t);
    }
    sync(T0, ...pages);
    expect(a.casino.computedFoldOf('roulette-2')!.keptBytes + a.casino.computedFoldOf('roulette-3')!.keptBytes).toBeGreaterThan(a.table.ROOM_BYTES);
    expect(a.casino.computedFairOnlyBytes()).toBe(foldOf(a).keptBytes - foldOf(a).feltBytes);
    run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
  });
});

describe('an abandon at a FAIR ONLY game', () => {
  /** A and B bet and the house joined; a bettor closed and both seeds are in; C sits at the table with no bet.
   *  The house never reveals. The pages all hold the close at `closedAt`. */
  async function unrevealed() {
    const pages = await gameRoom(['A', 'B', 'C']);
    const [a, b, c] = pages;
    c.doc.getMap('casino').set(`seat:${TABLE}:${c.pid}`, { stand: 0, angle: 0, at: 1 });
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    run(pages, closedAt + STEP, closedAt + 3_000, { step: STEP });
    for (const p of pages) expect(foldOf(p).tip).toMatchObject({ r: 1, decided: null });
    return { pages, a, b, c, closedAt, closeHash: hashIn(keysIn(a, 'c', 1)[0]) };
  }
  /** Bettors in the order their pages go: first, second. */
  const byTurn = (a: Page, b: Page): [Page, Page] => (dutyRank('abandon', G, 1, a.pub) < dutyRank('abandon', G, 1, b.pub) ? [a, b] : [b, a]);

  it('is written by a bettor after the wait for the house, and by no one else: a page that sits at the table with no bet in the close writes none', async () => {
    const { a, b, c, closedAt, closeHash } = await unrevealed();
    // (at a house table that does not play FAIR ONLY, a seated page abandons in its turn)
    run([c], closedAt + 3_000 + STEP, closedAt + 60_000, { step: STEP });
    expect(keysIn(c, 'z')).toEqual([]);
    expect(foldOf(c).tip).toMatchObject({ close: closeHash, decided: null });
    const [first] = byTurn(a, b);
    const at = run([first], closedAt + 3_000 + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(first, 'z', 1).length > 0 });
    expect(at).toBeGreaterThanOrEqual(closedAt + 15_000);
    expect(at).toBeLessThanOrEqual(closedAt + 15_000 + STEP * 2);
    const [z] = keysIn(first, 'z', 1);
    expect(asAbandon(recOf(first, z))).toMatchObject({ r: 1, x: closeHash, k: first.pub });
    expect(foldOf(first).rounds[0]).toMatchObject({ decided: 'void' });
    expect(keysIn(first, 'f')).toEqual([]); // (nor a forfeit: a close that names the house is decided by its reveal)
  });

  it('takes its turn among the bettors alone: the pages of strangers whose slips sit in the session push none out', async () => {
    const { pages, a, b, closedAt } = await unrevealed();
    // twelve players whose turn comes before both bettors' (the slips of a round the close left out)
    const [first, second] = byTurn(a, b);
    const ahead: TestIdentity[] = [];
    for (let i = 0; ahead.length < 12; i++) {
      const id = testIdentity(`stranger${i}`);
      if (dutyRank('abandon', G, 1, id.pub) < dutyRank('abandon', G, 1, first.pub)) ahead.push(id);
    }
    pinOn(second, ...ahead);
    house(second, ...ahead.map((id) => kit.slip(id, 1, [red(1)])));
    sync(closedAt + 3_000, ...pages);
    // the second bettor's turn is one stagger behind the first's, however many stand ahead of them in the session
    const at = run([second], closedAt + 3_000 + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(second, 'z', 1).length > 0 });
    expect(at).toBeGreaterThanOrEqual(closedAt + 15_000 + second.table.STAGGER_MS);
    expect(at).toBeLessThanOrEqual(closedAt + 15_000 + second.table.STAGGER_MS + STEP * 2);
    expect(first.pub).not.toBe(second.pub);
  });

  it('is not pushed out by a seated page whose turn would be the first: the first bettor still goes at the wait itself', async () => {
    const pages = await gameRoom(['P1', 'P2', 'P3']);
    // (which page sits is chosen after the keys are made: the seated one is the one whose turn comes first)
    const ranked = [...pages].sort((x, y) => (dutyRank('abandon', G, 1, x.pub) < dutyRank('abandon', G, 1, y.pub) ? -1 : 1));
    const [c, first, second] = ranked;
    c.doc.getMap('casino').set(`seat:${TABLE}:${c.pid}`, { stand: 0, angle: 0, at: 1 });
    house(first, kit.houseJoin(H, 1));
    expect(first.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(second.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(first, 'c', 1).length > 0 });
    run(pages, closedAt + STEP, closedAt + 3_000, { step: STEP });
    const at = run([first], closedAt + 3_000 + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(first, 'z', 1).length > 0 });
    expect(at).toBeGreaterThanOrEqual(closedAt + 15_000);
    expect(at).toBeLessThanOrEqual(closedAt + 15_000 + STEP * 2);
  });

  it('comes with no forfeit at a round the house decides: a bettor whose page never answers is waited out by an abandon alone', async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    // (A alone from here on: B's reveal is withheld, if B's page wrote it at once it is not among what A holds)
    expect(keysIn(a, 'x', 1).filter((k) => k.includes(b.pid))).toEqual([]);
    run([a], closedAt + STEP, closedAt + 13_000, { step: STEP });
    expect(foldOf(a).tip).toMatchObject({ r: 1 });
    expect(foldOf(a).tip!.revealed.length).toBeLessThan(foldOf(a).tip!.present.length);
    expect(foldOf(a).tip!.revealed).toContain(a.pid);
    expect(keysIn(a, 'f')).toEqual([]);
  });
});

/** Page p as a player the kit can sign records for. */
const identityOf = (p: Page): TestIdentity => ({ pid: p.pid, pub: p.pub, sign: (bytes) => p.keypair.signIdentity(bytes) });
/** The seed context of page p's slip for round r of the game ctx. */
const seedCtx = (p: Page, ctx: FoldCtx, r: number) => ({ room: ctx.room, table: seedTable(ctx), round: r, party: p.pid, house: '' });

describe('what a page does not do at a FAIR ONLY game', () => {
  it('trims nothing however many rounds the session holds: its checkpoints and sessions stay as the game wrote them', async () => {
    const [a] = await gameRoom(['A']);
    pinOn(a, bob);
    // (the page itself the player of every round: at a page-signed table it would be the one to trim)
    house(a, ...rounds(2 * a.table.TRIM_ROUNDS, [identityOf(a), bob]));
    expect(foldOf(a).rounds).toHaveLength(2 * a.table.TRIM_ROUNDS);
    // (nor does it sign one that the doc layer would refuse: no signature is spent on a trim)
    const sign = vi.spyOn(a.keypair, 'signIdentity');
    run([a], T0 + STEP, T0 + 300_000, { step: 1_000 });
    expect(sign).not.toHaveBeenCalled();
    expect([...top(a).keys()].filter((k) => k.startsWith('ck:'))).toEqual([root.key]);
    expect([...top(a).keys()].filter((k) => k.startsWith('ses:'))).toEqual([`ses:${TABLE}:${G.inc}:${SID}`]);
    expect([...top(a).keys()].filter((k) => k.startsWith('sum:') || k.startsWith('hs:'))).toEqual([]);
    expect(foldOf(a).rounds).toHaveLength(2 * a.table.TRIM_ROUNDS);
  });
});

describe('the house trims a game that is played', () => {
  /** Round 1 decided by the house with A's and B's pages, then A's bet on round 2. */
  async function round2Open() {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    // (A holds the deed: at a page-signed table its page would vouch for the trim)
    for (const p of pages) p.doc.transact(() => p.doc.getMap('roomInfo').set('owner', a.pid));
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    const closeHash = hashIn(keysIn(a, 'c', 1)[0]);
    run(pages, closedAt + STEP, closedAt + 4_000, { step: STEP });
    const hr = kit.houseReveal(H, 1, [closeHash], frozenOf(close));
    house(b, hr);
    sync(closedAt + 4_000, ...pages);
    const at = run(pages, closedAt + 4_000 + STEP, closedAt + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' && foldOf(a).open === 2 });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], at)).toBe('ok');
    sync(at, ...pages);
    return { pages, a, b, close, closeHash, hr, at };
  }

  it('the pages go on in the session it opens: the felt copied over closes naming the commitment it carries, nothing of round 1 is written back, and no page vouches for it', async () => {
    const { pages, a, b, closeHash, hr, at } = await round2Open();
    const res = foldOf(a);
    const nets = Object.fromEntries([...res.nets].filter(([, v]) => v !== 0n).map(([pid, v]) => [pid, v.toString()]));
    const cp = trimOf(G, 'p', { b: SID, u: 1, l: closeHash, d: `h:${hr.hash}`, n: nets, h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    const copies = [...res.felts.values()].map((x) => [x.key, recOf<unknown>(a, x.key)] as const);
    const next = nextSid3(G, cp.value);
    a.doc.transact(() => {
      top(a).set(cp.key, cp.value);
      for (const key of [...top(a).keys()]) if (key.startsWith(`ses:${TABLE}:${G.inc}:`)) top(a).delete(key);
      const ses = new Y.Map<unknown>();
      top(a).set(`ses:${TABLE}:${G.inc}:${next}`, ses);
      for (const [k, v] of copies) ses.set(k, v);
    });
    sync(at, ...pages);
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    expect(foldOf(a)).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
    run(pages, at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2).map((c) => c.h)).toEqual([kit.houseCommit(H, 2)]);
    // nothing of round 1, which the checkpoint covers, was put back; no `hs:` over the house's checkpoint
    run(pages, at + 30_000, at + 60_000, { step: 1_000 });
    for (const p of pages) {
      expect(keysIn(p, 's', 1)).toEqual([]);
      expect(keysIn(p, 'x', 1)).toEqual([]);
      expect(keysIn(p, 'c', 1)).toEqual([]);
    }
    expect([...top(a).keys()].filter((k) => k.startsWith('hs:') || k.startsWith('sum:'))).toEqual([]);
    void b;
  });
});

describe('a game and a page-signed incarnation at one table', () => {
  it('each page keeps the state of each: the seeds behind a slip frozen on the page-signed incarnation stay while the game is played, and the game\'s go when it ends', async () => {
    const [a] = await openRoom(['A'], T0);
    expect(a.table.writeComputedSlip(TABLE, [red(9)], T0)).toBe('ok');
    const feltX = foldOf(a).felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(feltX, seedCtx(a, PAGE_CTX, 1))).not.toBeNull();
    const xses = top(a).get(`ses:${TABLE}:${PAGE_INC}:g`) as Y.Map<unknown>;
    const xkeys = [...xses.keys()].sort();
    // the game opens at the table and is played, the page-signed incarnation waiting
    a.doc.transact(() => {
      top(a).set(root.key, root.value);
      top(a).set(`ses:${TABLE}:${G.inc}:${SID}`, new Y.Map());
    });
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    house(a, kit.houseJoin(H, 1));
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [black(20)], at)).toBe('ok');
    const closedAt = run([a], at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    run([a], closedAt + STEP, closedAt + 3_000, { step: STEP });
    const [close] = closesOf(a, 1);
    house(a, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close)));
    const settledAt = run([a], closedAt + 3_000 + STEP, closedAt + 30_000, { step: STEP, until: () => foldOf(a).open === 2 && a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], settledAt)).toBe('ok');
    const felt2 = foldOf(a).felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(felt2, seedCtx(a, G, 2))).not.toBeNull();
    // (the page-signed incarnation's session is as it was: no close, no seed of it went out)
    expect([...xses.keys()].sort()).toEqual(xkeys);
    expect(a.fair.seedFor(feltX, seedCtx(a, PAGE_CTX, 1))).not.toBeNull();
    // the game ends: its state goes with it, and the table is the page-signed incarnation's again
    const gone = endOf(G);
    a.doc.transact(() => top(a).set(gone.key, gone.value));
    expect(a.casino.computedIncOf(TABLE)).toBe(PAGE_INC);
    run([a], settledAt + STEP, settledAt + 30_000, { step: STEP });
    expect(a.fair.seedFor(felt2, seedCtx(a, G, 2))).toBeNull();
    expect(a.fair.seedFor(feltX, seedCtx(a, PAGE_CTX, 1))).not.toBeNull();
    // (and the page-signed round plays on from there: its slip is closed and revealed with the seed that was kept)
    expect(foldOf(a).rounds[0]).toMatchObject({ r: 1, decided: 'reveals', counted: [a.pid] });
  });
});

describe('what a page shows and does at the table of a game', () => {
  it('a change within the coalescing window is held and shown at once, and the tick writes it: the state read is the game\'s', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok'); // (written at once)
    expect(a.table.writeComputedSlip(TABLE, [red(10), black(5)], T0 + 50)).toBe('ok'); // (held)
    expect(a.table.readMyComputedBets(TABLE, a.pid, 1, T0 + 50).map((b) => b.type).sort()).toEqual(['black', 'red']);
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toHaveLength(1);
    run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toHaveLength(2);
  });

  it('a table ticked as the other game\'s plays nothing: a roulette game under a craps table\'s duties', async () => {
    const pages = await betting();
    const [a] = pages;
    const before = Y.encodeStateAsUpdate(a.doc);
    run(pages, T0 + STEP, T0 + 60_000, { step: STEP, tables: [{ id: TABLE, game: 'craps' }] });
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(before);
    expect(keysIn(a, 'c')).toEqual([]);
    run(pages, T0 + 60_000 + STEP, T0 + 90_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
  });

  it('the card has no checkpoint lines at a game: a game is not trimmed by a page', async () => {
    const [a] = await betting();
    expect(a.table.computedCheckpointView(TABLE, T0)).toBeNull();
  });

  it('the switch row can go while a round is under way at a game: the switch names no game', async () => {
    const pages = await betting();
    const [a] = pages;
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    run(pages, closedAt + STEP, closedAt + 2_000, { step: STEP });
    expect(foldOf(a).tip).not.toBeNull();
    expect(a.table.computedSwitchState(TABLE, 'roulette', true, closedAt + 2_000)).toMatchObject({ show: true, on: true, can: true });
  });

  it('switching off goes at a table that plays a game, and the game plays on', async () => {
    const [a] = await betting();
    expect(a.table.switchComputedOff(TABLE, T0 + 100)).toBe('ok');
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
  });

  it('a page that leaves takes its bet off the felt', async () => {
    const pages = await betting();
    const [a, b] = pages;
    expect(foldOf(a).felts.get(a.pid)!.rec.b).toHaveLength(1);
    a.table.leaveComputedTables(T0 + 2_000);
    sync(T0 + 2_000, ...pages);
    expect(foldOf(b).felts.get(a.pid)!.rec.b).toHaveLength(0);
  });

  it('a wake restarts the betting window', async () => {
    const [a] = await betting();
    for (let T = T0 + STEP; T <= T0 + 5_000; T += STEP) frame(T, a);
    const before = a.table.readComputedRoulette(TABLE, T0 + 5_000)!.phaseDeadline;
    frame(T0 + 12_000, a);
    expect(a.croupier.tablesWakeCount()).toBeGreaterThan(0);
    expect(a.table.readComputedRoulette(TABLE, T0 + 12_000)!.phaseDeadline).toBeGreaterThan(before!);
  });

  it('a new binding of the room\'s doc starts the games afresh: the slip the page wrote to the old one is not put back in a doc that never held it', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    const snap = Y.encodeStateAsUpdate(a.doc);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    run([a], T0 + STEP, T0 + 2_000, { step: STEP });
    expect(keysIn(a, 's', 1)).toHaveLength(1);
    // the room's doc bound again (leave and come back): the doc this time holds the game but no slip of A's
    const doc2 = new Y.Doc();
    doc2.clientID = 77;
    Y.applyUpdate(doc2, snap);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    a.casino.bindCasinoDoc(doc2, PAGE_ROOM);
    a.doc = doc2;
    run([a], T0 + 3_000, T0 + 60_000, { step: STEP });
    expect(keysIn(a, 's', 1)).toEqual([]);
  });
});

describe('two games at one table', () => {
  /** A second game of the owner's at the table (another name), its root and its empty session. */
  function openSecondGame(a: Page): FoldCtx {
    const NAME2 = { ...NAME, j: 'fedcba9876543210' };
    const G2 = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME2) };
    const root2 = rootOf(G2, 'p', { j: NAME2.j, dl: delegation(owner, H.pub, PAGE_ROOM) });
    const sid2 = nextSid3(G2, root2.value);
    a.doc.transact(() => {
      top(a).set(root2.key, root2.value);
      top(a).set(`ses:${TABLE}:${G2.inc}:${sid2}`, new Y.Map());
    });
    expect(a.casino.computedResolutionOf(TABLE, G2.inc)).toMatchObject({ live: true });
    return G2;
  }
  /** The switch names `inc` (the deed's choice, with no live game the deed holder's): the game the table plays. */
  const nameGame = (a: Page, inc: string): void => {
    a.doc.transact(() => {
      casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc });
    });
  };

  it('the one the table does not play keeps its state while the other is played: its seeds stay', async () => {
    const [a] = await gameRoom(['A']);
    nameGame(a, G.inc);
    const G2 = openSecondGame(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    house(a, kit.houseJoin(H, 1));
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    const felt = foldOf(a).felts.get(a.pid)!.rec.c;
    expect(a.fair.seedFor(felt, seedCtx(a, G, 1))).not.toBeNull();
    // the switch (the deed's choice) moves to the other game: the first waits
    nameGame(a, G2.inc);
    expect(a.casino.computedIncOf(TABLE)).toBe(G2.inc);
    run([a], at + STEP, at + 20_000, { step: STEP });
    expect(a.fair.seedFor(felt, seedCtx(a, G, 1))).not.toBeNull();
  });

  it('a game is served afresh when the table plays it again: its betting window starts from there, the view of the window that had run out is not served again', async () => {
    const [a] = await gameRoom(['A']);
    nameGame(a, G.inc);
    const G2 = openSecondGame(a);
    house(a, kit.houseJoin(H, 1));
    const window = a.table.BET_WINDOW_MS;
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    // The page ticks to just short of the deadline and reads the table after it: the view of a window run
    // out is built and kept (the fold is the same until a close comes), the close not written yet.
    run([a], at + STEP, at + window - 1_000, { step: STEP });
    const expired = a.table.readComputedRoulette(TABLE, at + window + 1_000)!;
    expect(expired.phase).toBe('betting');
    expect(expired.phaseDeadline!).toBeLessThan(at + window + 1_000);
    expect(keysIn(a, 'c', 1)).toEqual([]);
    // The table plays the other game for a while (which has no house commitment to name: it closes nothing).
    nameGame(a, G2.inc);
    const mid = run([a], at + window + 1_200, at + window + 41_000, { step: STEP });
    expect(keysIn(a, 'c')).toEqual([]);
    nameGame(a, G.inc);
    const back = run([a], mid + STEP, mid + 3_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    // The game's window starts from here, as after a wake: no close at the old deadline.
    expect(keysIn(a, 'c', 1)).toEqual([]);
    expect(a.table.readComputedRoulette(TABLE, back + 500)!.phaseDeadline!).toBeGreaterThanOrEqual(back + window - 4_000);
    run([a], back + STEP, back + window - 6_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
    run([a], back + window - 5_800, back + window + 10_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
  });

  /** The records of the second game `ctx`, put in its session (the table plays the first). */
  const putInSecond = (a: Page, ctx: FoldCtx, recs: Built<unknown>[]): void => {
    const key = [...top(a).keys()].find((k) => k.startsWith(`ses:${TABLE}:${ctx.inc}:`))!;
    const ses = top(a).get(key) as Y.Map<unknown>;
    a.doc.transact(() => {
      for (const r of recs) ses.set(r.key, r.rec);
    });
  };

  it('a game this page has not played is served afresh when the table moves to it, however old its records: its betting window starts from there', async () => {
    const [a] = await gameRoom(['A']);
    nameGame(a, G.inc);
    const G2 = openSecondGame(a);
    pinOn(a, alice);
    const kit2 = new ComputedKit(G2);
    putInSecond(a, G2, [kit2.houseJoin(H, 1), kit2.slip(alice, 1, [red(1)])]);
    house(a, kit.houseJoin(H, 1));
    const window = a.table.BET_WINDOW_MS;
    // The room's doc is bound again while the first game is played: this page has no state of either game, and the
    // slip in the second came to it when it was bound.
    const snap = Y.encodeStateAsUpdate(a.doc);
    vi.setSystemTime(T0 + 1_000);
    const doc2 = new Y.Doc();
    doc2.clientID = 77;
    Y.applyUpdate(doc2, snap);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    a.casino.bindCasinoDoc(doc2, PAGE_ROOM);
    a.doc = doc2;
    // (the first game is played for longer than a window, the page looking at the table all the while)
    const at = run([a], T0 + 1_000 + STEP, T0 + 1_000 + window + 8_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    nameGame(a, G2.inc);
    const back = run([a], at + STEP, at + 2_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(G2.inc);
    // The second game's window starts from here, as after a wake: it did not run while the first was played.
    const view = a.table.readComputedRoulette(TABLE, back + 2 * STEP)!;
    expect(view.phase).toBe('betting');
    expect(view.phaseDeadline!).toBeGreaterThanOrEqual(back + window - 4_000);
  });
});

describe('a table near the players its caps allow', () => {
  /** `n` ids of players who are not in the room: short ones. */
  const crowd = (n: number): string[] => Array.from({ length: n }, (_, i) => `x${String(i).padStart(4, '0')}`);
  /** Ids that total `bytes` UTF-8 bytes: 1,302 of the longest an id can be (256 three-byte characters, 768 bytes) and one of ASCII for the rest. */
  function heavyCrowd(bytes: number): string[] {
    const full = Array.from({ length: 1_302 }, (_, i) => String.fromCharCode(0x4e00 + i) + '漢'.repeat(255));
    const rest = bytes - 1_302 * 768;
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThanOrEqual(256);
    const ids = [...full, 'z'.repeat(rest)];
    expect(ids.reduce((n, pid) => n + utf8Length(pid), 0)).toBe(bytes);
    return ids;
  }

  /** The nets of `pids` (a net is never zero; these add up to it). */
  const netsOf = (pids: string[]): Record<string, string> => Object.fromEntries(pids.map((pid, i) => [pid, i === 0 ? String(1 - pids.length) : '1']));
  /** The house's trim of the game with `pids` as its players, and the session it opens, put in page `a`'s doc. */
  function trimWith(a: Page, pids: string[]) {
    const cp = trimOf(G, 'p', { b: SID, u: 1, l: hex('b', 32), n: netsOf(pids), h: kit.houseCommit(H, 2), dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(cp.key, cp.value);
      for (const key of [...top(a).keys()]) if (key.startsWith(`ses:${TABLE}:${G.inc}:`)) top(a).delete(key);
      top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, cp.value)}`, new Y.Map());
    });
    return cp;
  }

  /** Pages A and B at the game after a house trim whose nets hold `pids` (round 2 the one to play), and a bet each on it. */
  async function staked(pids: string[], players: string[] = [], names = ['A', 'B']) {
    const pages = await gameRoom(names, players);
    const [a, b] = pages;
    const cp = trimWith(a, pids);
    sync(T0, ...pages);
    run(pages, T0 + STEP, T0 + 2_000, { step: STEP });
    for (const p of pages) expect(p.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    expect(foldOf(a)).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
    const at = T0 + 2_000;
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], at)).toBe('ok');
    sync(at, ...pages);
    return { pages, a, b, at };
  }

  /** Run until a close of round 2 is in, and say who it froze. */
  function closed(pages: Page[], at: number) {
    const [a] = pages;
    const done = run(pages, at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    sync(done, ...pages);
    expect(keysIn(a, 'c', 2)).toHaveLength(1);
    const close = closesOf(a, 2)[0];
    return { close, done, frozen: Object.keys(close.f).sort() };
  }

  /** …and the round plays on: the seeds, then the house's reveal, count the frozen ones only. */
  function decided(pages: Page[], done: number, close: CloseRec) {
    const [a] = pages;
    const closeHash = hashIn(keysIn(a, 'c', 2)[0]);
    const after = run(pages, done + STEP, done + 12_000, { step: STEP });
    const hr = kit.houseReveal(H, 2, [closeHash], frozenOf(close));
    house(a, hr);
    sync(after, ...pages);
    return { closeHash, view: foldOf(a).rounds[0] };
  }

  it('players short of the cap by one: the two newcomers cannot both be frozen, so the close freezes one, and it stands (it was invalid, wedging the round, with both)', async () => {
    const { pages, a, b, at } = await staked(crowd(MAX_TABLE_PIDS - 1));
    const { close, done, frozen } = closed(pages, at);
    expect(frozen).toHaveLength(1);
    expect([a.pid, b.pid]).toContain(frozen[0]);
    for (const p of pages) {
      expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
      expect(foldOf(p).tip).toMatchObject({ close: hashIn(keysIn(p, 'c', 2)[0]) });
    }
    const { view } = decided(pages, done, close);
    expect(view).toMatchObject({ r: 2, decided: 'house', counted: frozen });
    // (the page left out has no place at the table, now that it is full: its chips are refused in the round that follows)
    const left = frozen[0] === a.pid ? b : a;
    const next = run(pages, done + 12_000 + STEP, done + 40_000, { step: STEP, until: () => pages.every((p) => p.table.readComputedRoulette(TABLE)?.phase === 'betting') && foldOf(a).open === 3 });
    expect(foldOf(a).open).toBe(3);
    expect(left.table.writeComputedSlip(TABLE, [red(5)], next)).toBe('crowded');
  });

  it('players short of the cap by two: both newcomers fit, and the close freezes both', async () => {
    const { pages, a, b, at } = await staked(crowd(MAX_TABLE_PIDS - 2));
    const { close, done, frozen } = closed(pages, at);
    expect(frozen).toEqual([a.pid, b.pid].sort());
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(decided(pages, done, close).view).toMatchObject({ r: 2, decided: 'house', counted: frozen });
  });

  it('the players the table holds already are no newcomers, however full it is: a table at the cap closes with both of them', async () => {
    let pages: Page[] = [];
    // (their ids are those of the pages, so the nets are written once the pages are loaded)
    const probe = await gameRoom(['A', 'B']);
    const ids = probe.map((p) => p.pid);
    pages = (await staked([...crowd(MAX_TABLE_PIDS - 2), ...ids])).pages;
    const [a] = pages;
    const { frozen } = closed(pages, T0 + 2_000);
    expect(frozen).toEqual(ids.sort());
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(a.casino.computedTablePids(TABLE).size).toBe(MAX_TABLE_PIDS);
  });

  it('a player the table holds takes none of the room a newcomer needs: one of three bettors holds a place, and both newcomers beside it fit the last two', async () => {
    const { pages, a } = await staked([...crowd(MAX_TABLE_PIDS - 3), 'player-A'], [], ['A', 'C', 'D']);
    expect(a.casino.computedTablePids(TABLE).size).toBe(MAX_TABLE_PIDS - 2);
    const { close, done, frozen } = closed(pages, T0 + 2_000);
    expect(frozen).toEqual(pages.map((p) => p.pid).sort());
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(decided(pages, done, close).view).toMatchObject({ r: 2, decided: 'house', counted: frozen });
  });

  it('ids short of the bytes cap by one newcomer\'s: only one of two can be frozen, and the close with it stands', async () => {
    const { pages, a, b, at } = await staked(heavyCrowd(MAX_TABLE_PID_BYTES - utf8Length(`player-A`)));
    const { close, done, frozen } = closed(pages, at);
    expect(frozen).toHaveLength(1);
    expect([a.pid, b.pid]).toContain(frozen[0]);
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(decided(pages, done, close).view).toMatchObject({ r: 2, decided: 'house', counted: frozen });
  });

  it('ids short of the bytes cap by both newcomers\': both are frozen', async () => {
    const { pages, a, b, at } = await staked(heavyCrowd(MAX_TABLE_PID_BYTES - utf8Length('player-A') - utf8Length('player-B')));
    const { frozen } = closed(pages, at);
    expect(frozen).toEqual([a.pid, b.pid].sort());
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
  });

  it('an id weighs its UTF-8 bytes and not its characters: players of three-byte characters in the last room', async () => {
    const A = '漢'.repeat(10) + 'A';
    const B = '漢'.repeat(10) + 'B';
    expect([utf8Length(A), A.length]).toEqual([31, 11]);
    const { pages, a, b, at } = await staked(heavyCrowd(MAX_TABLE_PID_BYTES - utf8Length(A)), [A, B]);
    const { close, done, frozen } = closed(pages, at);
    expect(frozen).toHaveLength(1);
    expect([a.pid, b.pid]).toContain(frozen[0]);
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(decided(pages, done, close).view).toMatchObject({ r: 2, decided: 'house', counted: frozen });
  });

  it('a newcomer taken weighs its bytes for the next: room for one and a half of two three-byte ids, and the close freezes one', async () => {
    const A = '漢'.repeat(10) + 'A';
    const B = '漢'.repeat(10) + 'B';
    // (51 bytes left: either id fits alone, the first taken leaves 20 bytes, and weighed in characters it would leave 40: both would be frozen, 11 bytes over the cap)
    const { pages, a, b, at } = await staked(heavyCrowd(MAX_TABLE_PID_BYTES - 51), [A, B]);
    for (const p of pages) expect(p.casino.computedTablePidBytes(TABLE)).toBe(MAX_TABLE_PID_BYTES - 51);
    const { close, done, frozen } = closed(pages, at);
    expect(frozen).toHaveLength(1);
    expect([a.pid, b.pid]).toContain(frozen[0]);
    for (const p of pages) expect(foldOf(p).openCloses.map((c) => c.state)).toEqual(['valid']);
    expect(decided(pages, done, close).view).toMatchObject({ r: 2, decided: 'house', counted: frozen });
  });

  it('a three-byte id that fits the characters left but not the bytes has no place, the page\'s own player too: its chips are refused as crowded', async () => {
    const A = '漢'.repeat(10) + 'A';
    expect([utf8Length(A), A.length]).toEqual([31, 11]);
    const pages = await gameRoom(['A'], [A]);
    const [a] = pages;
    const cp = trimWith(a, heavyCrowd(MAX_TABLE_PID_BYTES - utf8Length(A) + 1)); // (30 bytes left: 11 characters fit, 31 bytes do not)
    run([a], T0 + STEP, T0 + 2_000, { step: STEP });
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0 + 2_000)).toBe('crowded');
    expect(foldOf(a).felts.size).toBe(0);
  });

  it('a page whose own player has no place at a full table writes no close, whatever got its felt there (a game that keeps no cap wrote it)', async () => {
    const pages = await gameRoom(['A']);
    const [a] = pages;
    const cp = trimWith(a, crowd(MAX_TABLE_PIDS));
    run(pages, T0 + STEP, T0 + 2_000, { step: STEP });
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0 + 2_000)).toBe('crowded');
    a.casino.setComputedRecoveryForTests(false);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0 + 2_000)).toBe('ok');
    a.casino.setComputedRecoveryForTests(true);
    expect(foldOf(a).felts.has(a.pid)).toBe(true);
    run(pages, T0 + 2_000 + STEP, T0 + 60_000, { step: STEP });
    expect(keysIn(a, 'c', 2)).toEqual([]);
  });

  it('a newcomer whose id does not fit the bytes left is refused as crowded, as one the count has no place for is: its chips stay off the felt', async () => {
    const pages = await gameRoom(['A']);
    const [a] = pages;
    const bytes = MAX_TABLE_PID_BYTES - utf8Length(a.pid) + 1;
    const cp = trimWith(a, heavyCrowd(bytes));
    run([a], T0 + STEP, T0 + 2_000, { step: STEP });
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0 + 2_000)).toBe('crowded');
    expect(foldOf(a).felts.size).toBe(0);
  });

  it('a newcomer with no place does not stop the close freezing the one after it, who fits: the page and the small id, not the big one', async () => {
    const [a] = await gameRoom(['A'], ['closer']);
    // The house's trim after round 1: its nets name players whose ids take all but 14 bytes of MAX_TABLE_PID_BYTES.
    const cp = trimWith(a, heavyCrowd(MAX_TABLE_PID_BYTES - 14));
    run([a], T0 + STEP, T0 + 2_000, { step: STEP });
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
    // Two strangers' felts on round 2, put down in one write: a 31-byte id (it sorts first) and a 7-byte one.
    const big = testIdentity('big-id', 'a' + '漢'.repeat(10));
    const small = testIdentity('small-id', 'z-small');
    expect([utf8Length(big.pid), utf8Length(small.pid), utf8Length(a.pid)]).toEqual([31, 7, 6]);
    pinOn(a, big, small);
    house(a, kit.slip(big, 2, [red(5)]), kit.slip(small, 2, [red(5)]));
    const at = T0 + 2_000;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
    const { frozen } = closed([a], at);
    // 14 bytes of room: 'closer' (6) leaves 8; the big id (31) has no place; the small one (7) fits.
    expect(frozen).toEqual(['closer', 'z-small']);
    expect(foldOf(a).openCloses.map((c) => c.state)).toEqual(['valid']);
  });

  describe('with room for one newcomer of two', () => {
    /** Page A (the only one that closes) at a table with room for itself and one more; strangers `first` and `second`
     *  put their felts on round 2, `gap` ms apart (none: in one write). */
    async function twoStrangers(first: TestIdentity, second: TestIdentity, gap: number) {
      const [a] = await gameRoom(['A']);
      const cp = trimWith(a, crowd(MAX_TABLE_PIDS - 2));
      run([a], T0 + STEP, T0 + 2_000, { step: STEP });
      expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ base: { key: cp.key }, live: true });
      pinOn(a, first, second);
      let at = T0 + 2_000;
      if (gap === 0) house(a, kit.slip(first, 2, [red(5)]), kit.slip(second, 2, [red(5)]));
      else {
        house(a, kit.slip(first, 2, [red(5)]));
        at = run([a], at + STEP, at + gap, { step: STEP });
        house(a, kit.slip(second, 2, [red(5)]));
        at = run([a], at + STEP, at + 2 * STEP, { step: STEP });
      }
      expect(a.table.writeComputedSlip(TABLE, [red(10)], at)).toBe('ok');
      return { a, ...closed([a], at) };
    }

    it('the one seen first has the place, whatever its id sorts as', async () => {
      const early = testIdentity('early', 'player-Y');
      const late = testIdentity('late', 'player-B');
      const { a, frozen } = await twoStrangers(early, late, 1_000);
      expect(frozen).toEqual([a.pid, 'player-Y'].sort());
    });

    it('seen together, the smaller id has it', async () => {
      const x = testIdentity('x', 'player-Y');
      const y = testIdentity('y', 'player-B');
      const { a, frozen } = await twoStrangers(x, y, 0);
      expect(frozen).toEqual([a.pid, 'player-B'].sort());
    });
  });
});

describe('the newcomers of a close at a page-signed table', () => {
  const psKit = new ComputedKit(PAGE_CTX);
  const decidedOn = (p: Page, r: number): boolean => foldOf(p).base.u >= r || foldOf(p).rounds.some((v) => v.r === r && v.decided !== null);

  it("are counted together, as at a game: two other newcomers, room for one beside the page's own player, and every close freezes the page and one of them", async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    // Round 1 decided.
    for (const [i, q] of pages.entries()) expect(q.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decided = run(pages, T0 + STEP, T0 + 60_000, { step: STEP, until: () => pages.every((q) => decidedOn(q, 1)) });
    // A checkpoint of MAX_TABLE_PIDS - 2 players, neither A nor B among them.
    const crowdOf: Record<string, bigint> = {};
    for (let i = 0; i < MAX_TABLE_PIDS - 2; i++) crowdOf[`ghost-${i}`] = 1n;
    trimByHand(a, testIdentity('trim-cap'), crowdOf);
    sync(decided, ...pages);
    const open = run(pages, decided + STEP, decided + 60_000, { step: STEP, until: () => pages.every((q) => q.table.readComputedRoulette(TABLE, Date.now())?.phase === 'betting') });
    expect(a.casino.computedTablePids(TABLE).size).toBe(MAX_TABLE_PIDS - 2);
    // A stranger's felt on the open round, put down by hand (its player pinned).
    const r = foldOf(a).open;
    const stranger = testIdentity('stranger-x');
    pinOn(a, stranger);
    const slip = psKit.slip(stranger, r, [red(7)]);
    putIn(a, [[slip.key, slip.rec]]);
    // A and B bet: three newcomers, two places.
    expect(a.table.writeComputedSlip(TABLE, [red(5)], open)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(6)], open)).toBe('ok');
    sync(open, ...pages);
    const done = run(pages, open + STEP, open + 60_000, { step: STEP, until: () => keysIn(a, 'c', r).length > 0 });
    sync(done, ...pages);
    const closes = keysIn(a, 'c', r).map((k) => asClose(recOf(a, k))!);
    expect(closes.length).toBeGreaterThan(0);
    for (const c of closes) expect(Object.keys(c.f)).toHaveLength(2);
    for (const q of pages) expect(foldOf(q).openCloses.map((c) => c.state)).not.toContain('invalid');
  });
});

describe('a round at a game that does not go the happy way', () => {
  it("recommit: a close that froze the pages' felts is taken back after their seeds went out: each page commits its felt again, and the round is closed afresh", async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    const cheat = testIdentity('cheat');
    pinOn(a, cheat);
    const cslip = kit.slip(cheat, 1, [red(1)]);
    house(a, kit.houseJoin(H, 1), cslip);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const before = new Map(pages.map((q) => [q.pid, foldOf(q).felts.get(q.pid)!]));
    // The cheat's close freezes both honest felts (and its own), naming the commitment…
    const f = { [cheat.pid]: cslip.hash, [a.pid]: before.get(a.pid)!.hash, [b.pid]: before.get(b.pid)!.hash };
    const close = kit.close(cheat, 1, SID, f, kit.houseCommit(H, 1));
    house(a, close);
    sync(T0, ...pages);
    for (const q of pages) expect(foldOf(q).openCloses.map((c) => c.state)).toEqual(['valid']);
    // …the pages reveal their seeds for it…
    const seeded = run(pages, T0 + STEP, T0 + 10_000, { step: STEP, until: () => keysIn(a, 'x', 1).length >= 2 && keysIn(b, 'x', 1).length >= 2 });
    sync(seeded, ...pages);
    expect(keysIn(a, 'x', 1)).toHaveLength(2);
    // …and the cheat takes its close back: the round is open again, the seeds are out.
    a.doc.transact(() => a.casino.computedSessionForWrite(TABLE)!.delete(close.key));
    sync(seeded, ...pages);
    for (const q of pages) expect(foldOf(q).tip).toBeNull();
    const again = run(pages, seeded + STEP, seeded + 120_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    sync(again, ...pages);
    // Each page's felt is a new version under a fresh commitment, and the close that comes freezes those.
    for (const q of pages) {
      const now = foldOf(q).felts.get(q.pid)!;
      expect(now.rec.c).not.toBe(before.get(q.pid)!.rec.c);
      expect(now.hash).not.toBe(before.get(q.pid)!.hash);
    }
    expect(closesOf(a, 1).length).toBeGreaterThan(0);
    for (const c of closesOf(a, 1)) {
      expect(c.f[a.pid]).toBe(foldOf(a).felts.get(a.pid)!.hash);
      expect(c.f[b.pid]).toBe(foldOf(b).felts.get(b.pid)!.hash);
    }
  });

  it('seed-out note: a seed of the open round is out with no close standing: the close waits ABANDON_MS from when the page first saw so, and then goes', async () => {
    const [a] = await gameRoom(['A']);
    const bob = testIdentity('bob');
    pinOn(a, bob);
    // Bob's felt and his reveal of it, with no close that froze it.
    house(a, kit.houseJoin(H, 1), kit.slip(bob, 1, [black(1)]), kit.reveal(1, bob.pid));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const early = run([a], T0 + STEP, T0 + 25_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]); // (the betting window is long over: the seed out holds the close off)
    const done = run([a], early + STEP, T0 + 90_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(a, 'c', 1).length).toBeGreaterThan(0);
    expect(done).toBeGreaterThanOrEqual(T0 + a.table.ABANDON_MS);
    expect(Object.keys(closesOf(a, 1)[0].f)).toEqual([a.pid]); // (bob's felt is burned: no close may freeze it)
  });

  it("ask: with a frozen bettor's seed still missing near the end of its grace, the page asks the room once", async () => {
    const asked: number[] = [];
    const [a] = await gameRoom(['A'], [], { resync: () => asked.push(Date.now()) });
    const stranger = testIdentity('x');
    pinOn(a, stranger);
    house(a, kit.houseJoin(H, 1), kit.slip(stranger, 1, [black(7)]));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const closedAt = run([a], T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(Object.keys(closesOf(a, 1)[0].f)).toHaveLength(2);
    const closeSeen = a.casino.computedSeenAt(TABLE, keysIn(a, 'c', 1)[0])!;
    const from = asked.length;
    run([a], closedAt + STEP, closeSeen + 12_000, { step: STEP });
    expect(foldOf(a).tip).not.toBeNull();
    expect(asked.slice(from)).toHaveLength(1);
  });
});

describe('the records a game keeps in its session', () => {
  it('a page puts back a record of its own that a peer deleted, byte for byte, on its REPUT_MS beat: its slip', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10), straight(17, 3)], T0)).toBe('ok');
    sync(T0, a, b);
    const [key] = keysIn(a, 's', 1);
    const was = JSON.stringify(recOf(a, key));
    run([a, b], T0 + STEP, T0 + 1_200, { step: STEP }); // (A has looked for missing records from its first tick on)
    deleteIn(b, [key]);
    sync(T0 + 1_400, a, b);
    expect(keysIn(a, 's', 1)).toEqual([]);
    const back = run([a, b], T0 + 1_400, T0 + 6_000, { step: STEP, until: () => keysIn(b, 's', 1).includes(key) });
    expect(back).toBeLessThan(T0 + 6_000);
    expect(JSON.stringify(recOf(b, key))).toBe(was);
  });

  it("a witness puts back the house's reveal of a round it played that a peer deleted: no page wrote it, and the round stands as it was", async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    run(pages, closedAt + STEP, closedAt + 4_000, { step: STEP });
    const hr = kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], frozenOf(close));
    house(b, hr);
    sync(closedAt + 4_000, ...pages);
    for (const p of pages) expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'house', house: { hash: hr.hash } });
    // (The result shows, and each page that played the round notes the records it rests on.)
    const shown = closedAt + 4_000 + 12_000;
    run(pages, closedAt + 4_000 + STEP, shown, { step: STEP });
    deleteIn(a, [hr.key]);
    sync(shown, ...pages);
    for (const p of pages) expect(foldOf(p).rounds[0]).toMatchObject({ decided: null });
    const back = run(pages, shown + STEP, shown + 20_000, { step: STEP, until: () => pages.every((p) => recOf(p, hr.key) !== undefined) });
    expect(back).toBeLessThan(shown + 20_000);
    for (const p of pages) {
      expect(JSON.stringify(recOf(p, hr.key))).toBe(JSON.stringify(hr.rec));
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'house', house: { hash: hr.hash } });
    }
  });

  it("a round a page saw decided is not played again when a peer deletes its close and the page's own felt: the felt and the close come back, and no fresh felt meanwhile", async () => {
    const pages = await gameRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    const closeKey = keysIn(a, 'c', 1)[0];
    run(pages, closedAt + STEP, closedAt + 4_000, { step: STEP });
    const hr = kit.houseReveal(H, 1, [hashIn(closeKey)], frozenOf(close));
    house(b, hr);
    sync(closedAt + 4_000, ...pages);
    const shown = closedAt + 4_000 + 12_000;
    run(pages, closedAt + 4_000 + STEP, shown, { step: STEP });
    // The pages saw round 1 decided. A peer deletes its close and the felt of the page that did not close it
    // (the seed of that felt is out): the round reads open, and a felt whose seed is out goes again under a fresh one
    // only for a round this page never saw decided.
    const witness = pages.find((p) => p.pub !== close.k)!;
    const own = `s:1:${witness.pid}:${close.f[witness.pid]}`;
    deleteIn(a, [closeKey, own]);
    sync(shown, ...pages);
    for (const p of pages) expect(foldOf(p).tip).toBeNull();
    const felts = new Set<string>();
    for (let t = shown + STEP; t <= shown + 15_000; t += STEP) {
      run(pages, t, t, { step: STEP });
      for (const k of keysIn(witness, 's', 1)) if (k.includes(witness.pid)) felts.add(k);
    }
    expect([...felts]).toEqual([own]);
    for (const p of pages) expect(foldOf(p).rounds[0]).toMatchObject({ close: hashIn(closeKey), decided: 'house', house: { hash: hr.hash }, counted: [a.pid, b.pid].sort() });
  });
});
