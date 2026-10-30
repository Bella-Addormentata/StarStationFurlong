/**
 * 🏠🧹 The house at a house table, as the pages see it (casinoDoc's house
 * records, computedTable's duties): the deed holder's page delegating its
 * node's key, the Fair setting, heartbeats, and a round the house decides,
 * or never does.
 *
 * Pages as computedDuties.test.ts has them (computedPageKit). The house
 * itself is a TestHouse whose records a spec writes by hand, the way
 * ssf-p2p-node's house job would (house.rs): its join record for a round,
 * its reveal once the seeds are in, its heartbeats.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asCheckpoint, asClose } from './computedFold';
import type { CloseRec, FoldCtx } from './computedFold';
import { beatKey, delegationKey, fairSettingKey, roomSignBytes } from './computedHouse';
import { houseSign } from './computedHouse';
import {
  keysIn, openRoom, PAGE_INC, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testHouse, testIdentity } from './computedTestKit';
import type { Built, TestHouse } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
/** A house table: a roulette name this build opens (`r`). */
const RINC = 'r' + '5a'.repeat(12);
const RCTX: FoldCtx = { room: PAGE_ROOM, t: TABLE, inc: RINC };
const kit = new ComputedKit(RCTX);
const H = testHouse('owner-node');
const H2 = testHouse('other-node');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const top = (p: Page) => p.doc.getMap('casinoComputed');
const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(recOf(p, k))!);

/** A room whose deed page `a` holds, the house table switched on, the
 *  owner's node's key delegated (and synced) unless `delegate` is false. */
async function houseRoom(names: string[], opts: { delegate?: boolean; inc?: string } = {}): Promise<Page[]> {
  const pages = await openRoom(names, T0, [], { t: TABLE, inc: opts.inc ?? RINC });
  pages[0].doc.transact(() => pages[0].doc.getMap('roomInfo').set('owner', pages[0].pid));
  sync(T0, ...pages);
  if (opts.delegate !== false) {
    pages[0].table.setLocalHouse(H.pub);
    run(pages, T0, T0, { step: STEP });
  }
  return pages;
}

/** The house's record put in table TABLE's live session on page p. */
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]));

/** A heartbeat of house h, n, written on page p (the node's clock). */
function beat(p: Page, h: TestHouse, n: number): void {
  const body = { v: 1 as const, n, k: h.pub };
  p.doc.transact(() => top(p).set(beatKey(h.pub), { ...body, g: houseSign(h.secret, roomSignBytes('hbeat', PAGE_ROOM, '', body)) }));
}

/** The frozen slips' hashes of close c (sorted). */
const frozenOf = (c: CloseRec): string[] => Object.values(c.f).sort();
/** recHash of a record, as its key carries it. */
const hashIn = (key: string): string => key.slice(key.lastIndexOf(':') + 1);

// ── The delegation ───────────────────────────────────────────────────────────

describe("the deed holder's page and its node's key", () => {
  it('delegates it on its next tick, and no other page delegates its own', async () => {
    const pages = await houseRoom(['A', 'B'], { delegate: false });
    const [a, b] = pages;
    b.table.setLocalHouse(H2.pub);
    a.table.setLocalHouse(H.pub);
    run(pages, T0, T0 + 2 * STEP, { step: STEP });
    for (const p of pages) {
      expect(top(p).get(delegationKey(H.pub))).toMatchObject({ v: 1, h: H.pub, k: a.pub });
      expect(top(p).has(delegationKey(H2.pub))).toBe(false);
      expect(p.casino.houseOkOf(H.pub)).toBe(true);
      expect(p.casino.houseOkOf(H2.pub)).toBe(false);
      expect(p.casino.houseSetUp()).toBe(true);
    }
    expect(b.table.computedHouseState(TABLE)).toMatchObject({ setUp: true, online: false, fairness: 'fair', canSet: false });
    expect(a.table.computedHouseState(TABLE)).toMatchObject({ canSet: true });
  });

  it('a delete goes back, and the key stays a house meanwhile', async () => {
    const pages = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    b.doc.transact(() => top(b).delete(delegationKey(H.pub)));
    expect(b.casino.houseOkOf(H.pub)).toBe(true);
    run([b], T0 + 2_000, T0 + 2_000, { step: STEP });
    expect(top(b).has(delegationKey(H.pub))).toBe(true); // b's own put-back
    sync(T0 + 2_000, a, b);
    expect(top(a).get(delegationKey(H.pub))).toMatchObject({ k: a.pub });
  });

  it("one signed by anyone but the deed holder counts nothing; one before the holder's key shows, nothing until it does", async () => {
    const pages = await houseRoom(['A', 'B'], { delegate: false });
    const [a, b] = pages;
    // b signs one for the rival node.
    const body = { v: 1 as const, h: H2.pub, k: b.pub };
    b.doc.transact(() => top(b).set(delegationKey(H2.pub), { ...body, g: b.keypair.signIdentity(roomSignBytes('hkey', PAGE_ROOM, '', body)) }));
    sync(T0, a, b);
    for (const p of pages) expect(p.casino.houseOkOf(H2.pub)).toBe(false);
    // The room's deed passes to someone whose key no page has yet.
    const Z = testIdentity('zed', 'player-Zed');
    const zb = { v: 1 as const, h: H.pub, k: Z.pub };
    a.doc.transact(() => {
      a.doc.getMap('roomInfo').set('owner', Z.pid);
      top(a).set(delegationKey(H.pub), { ...zb, g: Z.sign(roomSignBytes('hkey', PAGE_ROOM, '', zb)) });
    });
    expect(a.casino.houseOkOf(H.pub)).toBe(false);
    expect(a.casino.computedSettled()).toBe(true); // nothing waits on it
    a.doc.transact(() => a.doc.getMap('players').set(Z.pid, { keyB64: Z.pub, name: Z.pid }));
    expect(a.casino.houseOkOf(H.pub)).toBe(true);
  });
});

// ── The Fair setting and the heartbeat ───────────────────────────────────────

describe('the Fair setting', () => {
  it('is the deed holder\'s alone: the newest one counts, and an older one written over it goes back', async () => {
    const pages = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    for (const p of pages) expect(p.casino.readFairSetting(TABLE)).toBe('fair');
    expect(b.table.setComputedFairness(TABLE, 'friendly', T0)).toBe('owner');
    expect(a.table.setComputedFairness(TABLE, 'friendly', T0)).toBe('ok');
    const older = top(a).get(fairSettingKey(TABLE));
    sync(T0, a, b);
    expect(b.casino.readFairSetting(TABLE)).toBe('friendly');
    // Set again at the same instant: ordered past the first all the same.
    expect(a.table.setComputedFairness(TABLE, 'fair', T0)).toBe('ok');
    expect(top(a).get(fairSettingKey(TABLE))).toMatchObject({ m: 0, s: T0 + 1 });
    sync(T0, a, b);
    expect(b.casino.readFairSetting(TABLE)).toBe('fair');
    // A peer writes the older one back over it: the newest seen stands, and goes back.
    b.doc.transact(() => top(b).set(fairSettingKey(TABLE), older));
    expect(b.casino.readFairSetting(TABLE)).toBe('fair');
    run([b], T0 + 2_000, T0 + 2_000, { step: STEP });
    expect(top(b).get(fairSettingKey(TABLE))).toMatchObject({ m: 0, s: T0 + 1 });
    // One the deed holder never signed counts nothing.
    const forged = { v: 1, m: 1, s: T0 + 5, k: a.pub, g: 'A'.repeat(86) };
    b.doc.transact(() => top(b).set(fairSettingKey(TABLE), forged));
    expect(b.casino.readFairSetting(TABLE)).toBe('fair');
  });
});

describe('the heartbeat', () => {
  it("a house's beat puts it online for HOUSE_HEARD_MS on this page's clock; an old or a stranger's beat doesn't", async () => {
    const [a, b] = await houseRoom(['A', 'B']);
    sync(T0, a, b);
    expect(b.casino.houseOnline(T0)).toBe(false);
    beat(a, H, 100);
    sync(T0, a, b);
    expect(b.casino.houseOnline(T0)).toBe(true);
    expect(b.casino.houseOnline(T0 + 15_000)).toBe(true);
    expect(b.casino.houseOnline(T0 + 15_001)).toBe(false);
    beat(a, H, 99); // older: no news of it
    sync(T0 + 10_000, a, b);
    expect(b.casino.houseOnline(T0 + 15_001)).toBe(false);
    beat(a, H2, 500); // no house of this room
    sync(T0 + 10_000, a, b);
    expect(b.casino.houseOnline(T0 + 15_001)).toBe(false);
    beat(a, H, 101);
    sync(T0 + 10_000, a, b);
    expect(b.casino.houseOnline(T0 + 25_000)).toBe(true);
  });
});

// ── Rounds ───────────────────────────────────────────────────────────────────

describe('a Fair round on the pages', () => {
  /** A and B bet, the house joins round 1, and the round closes. */
  async function closedFairRound() {
    const pages = await houseRoom(['A', 'B']);
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
    const { pages, a, b, join, close, closedAt, closeHash } = await closedFairRound();
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
    // Round 2: the close names the commitment the reveal carried.
    const at = closedAt + 20_000;
    run(pages, closedAt + 12_000 + STEP, at, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], at)).toBe('ok');
    sync(at, ...pages);
    run(pages, at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2).map((c) => c.h)).toEqual([kit.houseCommit(H, 2)]);
  });

  it('a seed that never comes is forfeited by no page: the house counts what it saw', async () => {
    const { pages, a, b, closedAt, closeHash, close } = await closedFairRound();
    // B's page goes quiet before revealing: only A's seed is in.
    run([a], closedAt + STEP, closedAt + 14_000, { step: STEP });
    expect(keysIn(a, 'x', 1)).toHaveLength(1);
    expect(keysIn(a, 'f', 1)).toEqual([]);
    const aSlip = close.f[a.pid];
    house(a, kit.houseReveal(H, 1, [closeHash], [aSlip]));
    const v = foldOf(a).rounds[0];
    expect(v).toMatchObject({ decided: 'house', counted: [a.pid] });
    expect(v.deltas.get(b.pid)).toBe(-20n);
    void pages;
  });

  it('the house never reveals: void 30 s after the close while it is heard, 15 s once it isn\'t, then the next round is Friendly', async () => {
    const heard = await closedFairRound();
    const until = (p: Page) => () => keysIn(p, 'z', 1).length > 0;
    // Heard: a beat every 5 s.
    let n = 1;
    let voidedAt = heard.closedAt;
    for (let T = heard.closedAt; T <= heard.closedAt + 40_000; T += 5_000) {
      beat(heard.a, H, n++);
      voidedAt = run(heard.pages, T, T + 5_000 - STEP, { step: STEP, until: until(heard.a) });
      if (voidedAt <= T + 5_000 - STEP) break;
    }
    const lastIdx = 1 * heard.a.table.STAGGER_MS;
    expect(voidedAt).toBeGreaterThanOrEqual(heard.closedAt + 30_000);
    expect(voidedAt).toBeLessThanOrEqual(heard.closedAt + 30_000 + lastIdx + STEP);
    // Unheard: 15 s.
    const quiet = await closedFairRound();
    const at = run(quiet.pages, quiet.closedAt + STEP, quiet.closedAt + 40_000, { step: STEP, until: until(quiet.a) });
    expect(at).toBeGreaterThanOrEqual(quiet.closedAt + 15_000);
    expect(at).toBeLessThanOrEqual(quiet.closedAt + 15_000 + lastIdx + STEP);
    for (const p of quiet.pages) {
      expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'void' });
      expect(foldOf(p)).toMatchObject({ open: 2, required: null, joins: [] });
    }
    // With no house, round 2 closes Friendly and its seeds decide it.
    const T = at + 10_000;
    run(quiet.pages, at + STEP, T, { step: STEP });
    expect(quiet.a.table.writeComputedSlip(TABLE, [red(5)], T)).toBe('ok');
    sync(T, ...quiet.pages);
    run(quiet.pages, T + STEP, T + 40_000, { step: STEP, until: () => foldOf(quiet.a).rounds[1]?.decided === 'reveals' });
    expect(closesOf(quiet.a, 2).map((c) => c.h)).toEqual([undefined]);
    expect(foldOf(quiet.a).rounds[1].decided).toBe('reveals');
  });

  it('unheard, but its reveal waits on a seed this page lacks: the void waits the 30 s', async () => {
    const { pages, a, b, closedAt, closeHash, close } = await closedFairRound();
    // The house saw both seeds; b's never reaches a.
    run([a], closedAt + STEP, closedAt + 2_000, { step: STEP });
    house(a, kit.houseReveal(H, 1, [closeHash], frozenOf(close)));
    const at = run([a], closedAt + 2_000, closedAt + 40_000, { step: STEP, until: () => keysIn(a, 'z', 1).length > 0 });
    expect(at).toBeGreaterThanOrEqual(closedAt + 30_000);
    void pages;
    void b;
  });

  it('a page that played it puts the house\'s reveal back when a peer deletes it', async () => {
    const { pages, a, b, close, closedAt, closeHash } = await closedFairRound();
    run(pages, closedAt + STEP, closedAt + 2_000, { step: STEP });
    const hr = kit.houseReveal(H, 1, [closeHash], frozenOf(close));
    house(a, hr);
    sync(closedAt + 2_000, ...pages);
    // The result shows, then b's doc loses the reveal.
    run(pages, closedAt + 2_000 + STEP, closedAt + 6_000, { step: STEP });
    b.doc.transact(() => b.casino.computedSessionForWrite(TABLE)!.delete(hr.key));
    expect(foldOf(b).tip).not.toBeNull();
    run(pages, closedAt + 6_000 + STEP, closedAt + 12_000, { step: STEP, until: () => recOf(b, hr.key) !== undefined });
    expect(recOf(b, hr.key)).toEqual(hr.rec);
    expect(foldOf(b).rounds[0].decided).toBe('house');
  });
});

describe('a trim at a house table', () => {
  it('names the commitment the open round must, and keeps the house\'s join records of it', async () => {
    const pages = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    a.table.writeComputedSlip(TABLE, [red(10)], T0);
    b.table.writeComputedSlip(TABLE, [black(20)], T0);
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    const closeHash = hashIn(keysIn(a, 'c', 1)[0]);
    run(pages, closedAt + STEP, closedAt + 2_000, { step: STEP });
    house(a, kit.houseReveal(H, 1, [closeHash], frozenOf(close)));
    sync(closedAt + 2_000, ...pages);
    // Idle: the trim comes a minute on.
    const first = foldOf(a).base.sid;
    run(pages, closedAt + 2_000 + STEP, closedAt + 80_000, { step: 1_000, until: () => foldOf(a).base.sid !== first });
    const cp = asCheckpoint(top(a).get(`sum:${TABLE}:${RINC}`));
    expect(cp).toMatchObject({ u: 1, h: kit.houseCommit(H, 2) });
    expect(foldOf(a)).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
  });

  it('after a round the house left joinable, the join record of the open round goes into the next session', async () => {
    const pages = await houseRoom(['A', 'B']);
    const [a, b] = pages;
    house(a, kit.houseJoin(H, 1));
    a.table.writeComputedSlip(TABLE, [red(10)], T0);
    b.table.writeComputedSlip(TABLE, [black(20)], T0);
    sync(T0, ...pages);
    const closedAt = run(pages, T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    const closeHash = hashIn(keysIn(a, 'c', 1)[0]);
    run(pages, closedAt + STEP, closedAt + 2_000, { step: STEP });
    const join2 = kit.houseJoin(H, 2);
    house(a, kit.houseReveal(H, 1, [closeHash], frozenOf(close), { c: null }), join2);
    sync(closedAt + 2_000, ...pages);
    expect(foldOf(a).joins.map((j) => j.hash)).toEqual([join2.hash]);
    const first = foldOf(a).base.sid;
    run(pages, closedAt + 2_000 + STEP, closedAt + 80_000, { step: 1_000, until: () => foldOf(a).base.sid !== first });
    const cp = asCheckpoint(top(a).get(`sum:${TABLE}:${RINC}`))!;
    expect(cp.h).toBeUndefined();
    expect(keysIn(a, 'o', 2)).toEqual([join2.key]);
    expect(foldOf(a).joins.map((j) => j.hash)).toEqual([join2.hash]);
  });
});

describe('a table PR 2–4 opened', () => {
  it('moves onto a house table once the room has a house, at a quiet moment, its nets counting on', async () => {
    const pages = await houseRoom(['A', 'B'], { delegate: false, inc: PAGE_INC });
    const [a, b] = pages;
    a.table.writeComputedSlip(TABLE, [red(10)], T0);
    b.table.writeComputedSlip(TABLE, [black(20)], T0);
    sync(T0, ...pages);
    const decidedAt = run(pages, T0 + STEP, T0 + 40_000, { step: STEP, until: () => foldOf(a)?.rounds[0]?.decided === 'reveals' });
    const chips = pages.map((p) => p.casino.readChips(p.pid));
    const after = decidedAt + 20_000;
    run(pages, decidedAt + STEP, after, { step: STEP });
    // No house: it stays.
    expect(a.table.autoSwitchComputed(TABLE, 'roulette', after)).toBe(false);
    expect(a.casino.computedIncOf(TABLE)).toBe(PAGE_INC);
    a.table.setLocalHouse(H.pub);
    run(pages, after + STEP, after + 1_200, { step: STEP }); // (its house duty's beat)
    expect(a.casino.houseSetUp()).toBe(true);
    // A felt with chips on it: not quiet.
    b.table.writeComputedSlip(TABLE, [black(5)], after + 1_200);
    sync(after + 1_200, ...pages);
    expect(a.table.autoSwitchComputed(TABLE, 'roulette', after + 2_000)).toBe(false);
    b.table.writeComputedSlip(TABLE, [], after + 2_000);
    sync(after + 2_000, ...pages);
    expect(a.table.autoSwitchComputed(TABLE, 'roulette', after + 4_000)).toBe(true);
    sync(after + 4_000, ...pages);
    for (const p of pages) {
      expect(p.casino.computedIncOf(TABLE)).toMatch(/^r[0-9a-f]{24}$/);
      expect(pages.map((q) => p.casino.readChips(q.pid))).toEqual(chips);
    }
  });
});
