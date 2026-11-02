/**
 * 🏠🧮 THE HOUSE in the fold (computedFold, PR 5): what a house table's
 * rounds need from the house, and what they do without it.
 *
 * These specs pin how a Fair round is decided (only by the house's reveal,
 * once every seed it counts is in; never by a forfeit or "every reveal in";
 * voided by an abandon only while no house reveal decides), which closes may
 * name which commitment (required after a house round, lifted by a
 * step-down, joinable otherwise), the chain score that keeps a house round
 * from being outgrown, the house's seed in the pocket and the dice, and, as
 * computedFold.test.ts does for the old tables, that the output is a
 * function of the record set.
 *
 * Records come from computedTestKit, the house's signed by a TestHouse the
 * way house.rs signs (computedHouse's mirror of it); one caching SigCheck on
 * the real strict verifier is shared by the whole file.
 */

import { describe, expect, it } from 'vitest';
import { basisOf, canonFelt, diceOf, EMPTY_CARRY } from './computedCraps';
import {
  asHouseCommit, asHouseReveal, asHouseSumFor, compareHouseSum, dutyRank, houseCommitOf, houseRevealKey, houseRules,
  houseSumDigest, nextSid, pocketOf, seedTable, signBytes, TableFold, U_MAX,
} from './computedFold';
import type { Checkpoint, FoldCtx, FoldResult, HouseCheck, HouseSum } from './computedFold';
import { houseSign } from './computedHouse';
import {
  black, cachingCheck, ComputedKit, houseSnapshot, housesAre, red, straight, TEST_CTX, TestSession, testHouse, testIdentity,
} from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import type { CrapsBet } from './games/craps';
import { payoutFor } from './games/roulette';
import type { RouletteBet } from './games/roulette';

const HCTX: FoldCtx = { room: 'room-test', t: 'roulette-1', inc: 'r0123456789abcdef01234567' };
const DCTX: FoldCtx = { room: 'room-test', t: 'craps-1', inc: 'd0123456789abcdef01234567' };
const kit = new ComputedKit(HCTX);
const sigs = cachingCheck();
const A = testIdentity('alice');
const B = testIdentity('bob');
const C = testIdentity('carol');
const H = testHouse('owner-node');
const H2 = testHouse('second-node');
const ROGUE = testHouse('rogue-node');
const SID = 'g';
const onlyH = housesAre(H);

const foldOf = (s: TestSession, houseOk: HouseCheck = onlyH, cp: Checkpoint | null = null, ctx: FoldCtx = HCTX): FoldResult =>
  s.fold(sigs.check, cp, ctx, houseOk).result();
const stakeOf = (b: RouletteBet[]): bigint => BigInt(b.reduce((n, x) => n + x.amount, 0));
const deltaOf = (b: RouletteBet[], pocket: number): bigint => BigInt(b.reduce((n, x) => n + payoutFor(x, pocket), 0)) - stakeOf(b);
const other = (n: number): string => n.toString(16).padStart(64, '0');

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Closers of a round, first in line first (dutyRank 'close'). */
function inLine(r: number, ...ids: TestIdentity[]): TestIdentity[] {
  const rank = (id: TestIdentity): string => dutyRank('close', HCTX, r, id.pub);
  return [...ids].sort((x, y) => (rank(x) < rank(y) ? -1 : 1));
}

/** Round 1 with Alice and Bob: the house joined, Alice's close naming its
 *  commitment, both seeds, and the house's reveal counting both. */
function fairRound1() {
  const a1 = kit.slip(A, 1, [red(10)]);
  const b1 = kit.slip(B, 1, [black(5), straight(7, 1)]);
  const join = kit.houseJoin(H, 1);
  const close = kit.close(A, 1, SID, [a1, b1], join.rec.c);
  const ra = kit.reveal(1, A.pid);
  const rb = kit.reveal(1, B.pid);
  const hr = kit.houseReveal(H, 1, [close.hash], [a1.hash, b1.hash]);
  return { a1, b1, join, close, ra, rb, hr };
}

/** Round 1 decided by the house, and round 2's slips and seeds. */
function afterHouseRound() {
  const one = fairRound1();
  const a2 = kit.slip(A, 2, [red(4)]);
  const b2 = kit.slip(B, 2, [black(6)]);
  const ra2 = kit.reveal(2, A.pid);
  const rb2 = kit.reveal(2, B.pid);
  const session = new TestSession().put(one.a1, one.b1, one.join, one.close, one.ra, one.rb, one.hr, a2, b2, ra2, rb2);
  return { ...one, a2, b2, ra2, rb2, session, c2: kit.houseCommit(H, 2) };
}

// ── The table's name ─────────────────────────────────────────────────────────

describe('which tables follow the house\'s rules', () => {
  it('r and d tables do; c and k tables (PR 2–4\'s) don\'t', () => {
    expect([HCTX.inc, DCTX.inc, TEST_CTX.inc, 'k0123456789abcdef01234567'].map(houseRules)).toEqual([true, true, false, false]);
  });

  it('at a c table house records are junk, and so is a close naming a commitment', () => {
    const ckit = new ComputedKit(TEST_CTX);
    const a1 = ckit.slip(A, 1, [red(10)]);
    const join = ckit.houseJoin(H, 1);
    const fair = ckit.close(A, 1, SID, [a1], join.rec.c);
    const plain = ckit.close(A, 1, SID, [a1]);
    const hr = ckit.houseReveal(H, 1, [fair.hash], [a1.hash]);
    const res = new TestSession().put(a1, join, fair, plain, hr, ckit.reveal(1, A.pid)).fold(sigs.check, null, TEST_CTX, onlyH).result();
    expect(res.records).toBe(3); // the slip, the plain close, the reveal
    expect(res).toMatchObject({ houseTable: false, required: null, joins: [] });
    expect(res.rounds.map((v) => [v.close, v.decided])).toEqual([[plain.hash, 'reveals']]);
    expect(res.rounds[0].house).toBeUndefined();
  });

  it('a checkpoint naming a commitment counts as none at a c table', () => {
    const ckit = new ComputedKit(TEST_CTX);
    const cp = ckit.checkpoint(A, 'g', 1, 'ab'.repeat(16), { alice: 5n }, undefined, undefined, other(1));
    const f = new TableFold(TEST_CTX, sigs.check, undefined, undefined, onlyH);
    f.setBase(cp);
    expect(f.result().base).toMatchObject({ sid: 'g', u: 0, h: null });
  });

  it('the house records\' shapes: a step-down lists nothing, counts nothing and carries no commitment', () => {
    const { hr, join } = fairRound1();
    expect(asHouseReveal(hr.rec)).not.toBeNull();
    expect(asHouseCommit(join.rec)).not.toBeNull();
    expect(asHouseReveal(kit.stepDown(H, 1).rec)).not.toBeNull();
    for (const bad of [
      { ...hr.rec, x: [] },                                   // a step-down that counts seeds
      { ...hr.rec, x: [], n: [] },                            // one that carries a commitment
      { ...hr.rec, x: [hr.rec.x[0], hr.rec.x[0]] },           // a close twice
      { ...hr.rec, n: [...hr.rec.n].reverse() },              // unsorted
      { ...hr.rec, n: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(32, '0')) }, // past MAX_HOUSE_COUNTED
      { ...hr.rec, s: hr.rec.s.toUpperCase() },
      { ...hr.rec, extra: 1 },
    ]) expect(asHouseReveal(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    expect(asHouseCommit({ ...join.rec, c: 'xyz' })).toBeNull();
    expect(asHouseCommit({ ...join.rec, s: join.rec.c })).toBeNull();
  });

  it('a house commitment is never a slip\'s: its party is empty', () => {
    const seed = kit.houseSeed(H, 1);
    expect(houseCommitOf(HCTX, 1, seed)).toBe(kit.commit(1, '', seed));
    expect(houseCommitOf(HCTX, 1, seed)).not.toBe(kit.commit(1, A.pid, seed));
  });
});

// ── Deciding a Fair round ────────────────────────────────────────────────────

describe('a Fair round (its close names a house commitment)', () => {
  it('is decided by the house\'s reveal: the pocket mixes the house\'s seed in, last', () => {
    const { a1, b1, join, close, ra, rb, hr } = fairRound1();
    const s = new TestSession().put(a1, b1, join, close, ra, rb);
    const before = foldOf(s);
    expect(before.tip).toMatchObject({ close: close.hash, decided: null, revealed: ['alice', 'bob'] });
    expect(before.openCloses).toEqual([{ hash: close.hash, rec: close.rec, state: 'valid' }]);
    expect(before.joins.map((j) => j.hash)).toEqual([join.hash]);
    expect(before.held).toEqual(new Map([['alice', 10n], ['bob', 6n]]));

    const res = foldOf(s.put(hr));
    const v = res.rounds[0];
    const pocket = pocketOf(HCTX, 1, [kit.seed(A.pid, 1), kit.seed(B.pid, 1)], kit.houseSeed(H, 1));
    expect(v).toMatchObject({ decided: 'house', counted: ['alice', 'bob'], house: { hash: hr.hash }, pocket });
    expect(v.deltas).toEqual(new Map([['alice', deltaOf(a1.rec.b, pocket)], ['bob', deltaOf(b1.rec.b, pocket)]]));
    expect(res).toMatchObject({ tip: null, open: 2, parent: close.hash, required: kit.houseCommit(H, 2), joins: [] });
    expect(res.pending).toBe(false);
  });

  it('the house\'s seed changes the pocket: the same bettors\' seeds alone give another draw somewhere', () => {
    // Over a handful of rounds the house's tail must move at least one pocket.
    let moved = 0;
    for (let r = 1; r <= 8; r++) {
      const seeds = [kit.seed(A.pid, r), kit.seed(B.pid, r)];
      if (pocketOf(HCTX, r, seeds, kit.houseSeed(H, r)) !== pocketOf(HCTX, r, seeds)) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('every seed in decides nothing, and neither does a forfeit', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const forfeit = kit.forfeit(A, 1, close.hash, [A.pid]);
    const res = foldOf(new TestSession().put(a1, b1, join, close, ra, rb, forfeit));
    expect(res.tip).toMatchObject({ close: close.hash, decided: null });
    expect(res.rounds).toHaveLength(1);
  });

  it('counts only the seeds the house saw: a seed it didn\'t list loses its stake', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const hr = kit.houseReveal(H, 1, [close.hash], [a1.hash]);
    const v = foldOf(new TestSession().put(a1, b1, join, close, ra, rb, hr)).rounds[0];
    const pocket = pocketOf(HCTX, 1, [kit.seed(A.pid, 1)], kit.houseSeed(H, 1));
    expect(v).toMatchObject({ decided: 'house', counted: ['alice'], pocket });
    expect(v.deltas).toEqual(new Map([['alice', deltaOf(a1.rec.b, pocket)], ['bob', -6n]]));
  });

  it('a counted slip hash must be the frozen one: another version of the same player counts nothing', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const b1v2 = kit.slip(B, 1, [black(50)], { v: 2 });
    const hr = kit.houseReveal(H, 1, [close.hash], [a1.hash, b1v2.hash]);
    const v = foldOf(new TestSession().put(a1, b1, b1v2, join, close, ra, rb, hr)).rounds[0];
    expect(v).toMatchObject({ decided: 'house', counted: ['alice'] });
  });

  it('waits for every seed the house counted, then decides', () => {
    const { a1, b1, join, close, ra, rb, hr } = fairRound1();
    const s = new TestSession().put(a1, b1, join, close, ra, hr);
    expect(foldOf(s).tip).toMatchObject({ decided: null, revealed: ['alice'] });
    expect(foldOf(s.put(rb)).rounds[0]).toMatchObject({ decided: 'house', counted: ['alice', 'bob'] });
  });

  it('a reveal counting nobody voids the round, and still hands on its commitment', () => {
    const { a1, b1, join, close } = fairRound1();
    const hr = kit.houseReveal(H, 1, [close.hash], []);
    const res = foldOf(new TestSession().put(a1, b1, join, close, hr));
    expect(res.rounds[0]).toMatchObject({ decided: 'void', counted: [], pocket: null, house: { hash: hr.hash } });
    expect(res.rounds[0].deltas).toEqual(new Map([['alice', 0n], ['bob', 0n]]));
    expect(res.nets).toEqual(new Map());
    expect(res.required).toBe(kit.houseCommit(H, 2));
  });

  it('only a reveal listing the close, whose seed opens its commitment, by a house, signed by it, decides', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const s = new TestSession().put(a1, b1, join, close, ra, rb);
    const n = [a1.hash, b1.hash];
    const notListed = kit.houseReveal(H, 1, ['0'.repeat(32)], n);
    const wrongSeed = kit.houseReveal(H, 1, [close.hash], n, { s: kit.houseSeed(H, 2) });
    const byRogue = kit.houseReveal(ROGUE, 1, [close.hash], n, { s: kit.houseSeed(H, 1) });
    const good = kit.houseReveal(H, 1, [close.hash], n);
    const forged = { ...good.rec, g: houseSign(ROGUE.secret, signBytes('hreveal', HCTX, good.rec)) };
    s.put(notListed, wrongSeed, byRogue).raw(houseRevealKey(forged)!, forged);
    const res = foldOf(s);
    expect(res.tip).toMatchObject({ close: close.hash, decided: null });
    expect(res.pending).toBe(false);
    expect(foldOf(s.put(good)).rounds[0]).toMatchObject({ decided: 'house', house: { hash: good.hash } });
  });

  it('of two good reveals listing it, the lowest hash decides', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const both = kit.houseReveal(H, 1, [close.hash], [a1.hash, b1.hash]);
    const one = kit.houseReveal(H, 1, [close.hash], [a1.hash]);
    const low = [both, one].sort((x, y) => (x.hash < y.hash ? -1 : 1))[0];
    const v = foldOf(new TestSession().put(a1, b1, join, close, ra, rb, both, one)).rounds[0];
    expect(v.house?.hash).toBe(low.hash);
    expect(v.counted).toEqual(low === both ? ['alice', 'bob'] : ['alice']);
  });

  it('an abandon voids a round the house never reveals; the next round is joinable', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const z = kit.abandon(B, 1, close.hash);
    const res = foldOf(new TestSession().put(a1, b1, join, close, ra, rb, z));
    expect(res.rounds[0]).toMatchObject({ decided: 'void', abandon: { hash: z.hash } });
    expect(res.rounds[0].house).toBeUndefined();
    expect(res).toMatchObject({ open: 2, required: null, joins: [] });
    // A Friendly round 2 plays as an old table's would.
    const a2 = kit.slip(A, 2, [red(3)]);
    const c2 = kit.close(A, 2, close.hash, [a2]);
    const next = foldOf(new TestSession().put(a1, b1, join, close, ra, rb, z, a2, c2, kit.reveal(2, A.pid)));
    expect(next.rounds.map((v) => v.decided)).toEqual(['void', 'reveals']);
    expect(next.rounds[1].house).toBeUndefined();
  });

  it('a house reveal beats an abandon, whichever came first', () => {
    const { a1, b1, join, close, ra, rb, hr } = fairRound1();
    const z = kit.abandon(B, 1, close.hash);
    expect(foldOf(new TestSession().put(a1, b1, join, close, ra, rb, z, hr)).rounds[0]).toMatchObject({ decided: 'house' });
    // While the house's reveal waits on a seed it counted, the abandon voids; the seed un-voids it.
    const s = new TestSession().put(a1, b1, join, close, ra, z, hr);
    expect(foldOf(s).rounds[0]).toMatchObject({ decided: 'void' });
    expect(foldOf(s.put(rb)).rounds[0]).toMatchObject({ decided: 'house' });
  });
});

// ── Which commitment a close names ───────────────────────────────────────────

describe('after a house round, the next close must name the house\'s commitment', () => {
  it('one naming nothing, or another commitment, is invalid; the one naming it decides with the house', () => {
    const { session, close, a2, b2, c2 } = afterHouseRound();
    const none = kit.close(A, 2, close.hash, [a2, b2]);
    const another = kit.close(A, 2, close.hash, [a2, b2], other(7));
    const right = kit.close(B, 2, close.hash, [a2, b2], c2);
    const res = foldOf(session.put(none, another, right));
    const state = new Map(res.openCloses.map((c) => [c.hash, c.state]));
    expect([state.get(none.hash), state.get(another.hash), state.get(right.hash)]).toEqual(['invalid', 'invalid', 'valid']);
    expect(res.tip?.close).toBe(right.hash);
    const hr2 = kit.houseReveal(H, 2, [right.hash], [a2.hash, b2.hash]);
    expect(foldOf(session.put(hr2)).rounds.map((v) => v.decided)).toEqual(['house', 'house']);
  });

  it('closes that skip it take no place in the cap', () => {
    const { session, close, a2, b2, c2 } = afterHouseRound();
    const [first, second] = inLine(2, A, B);
    const s1 = first === A ? a2 : b2;
    const junk: Built<unknown>[] = [];
    for (let i = 0; i < 32; i++) junk.push(kit.close(first, 2, close.hash, [s1], other(100 + i)));
    const honest = kit.close(second, 2, close.hash, [a2, b2], c2);
    const res = foldOf(session.put(...junk, honest));
    expect(res.tip?.close).toBe(honest.hash);
    expect(res.openCloses.filter((c) => c.state === 'invalid')).toHaveLength(32);
  });

  it('a step-down lifts it: a Friendly close plays, and none may name the seed it revealed', () => {
    const { session, close, a2, b2, c2 } = afterHouseRound();
    const down = kit.stepDown(H, 2);
    const friendly = kit.close(A, 2, close.hash, [a2, b2]);
    const named = kit.close(B, 2, close.hash, [a2, b2], c2);
    const before = foldOf(afterHouseRound().session.put(down));
    expect(before).toMatchObject({ open: 2, required: null, joins: [] });
    const res = foldOf(session.put(down, friendly, named));
    expect(res.rounds.map((v) => v.decided)).toEqual(['house', 'reveals']);
    expect(res.rounds[1].close).toBe(friendly.hash);
    const alone = foldOf(afterHouseRound().session.put(down, named));
    expect(alone.openCloses).toEqual([{ hash: named.hash, rec: named.rec, state: 'invalid' }]);
  });

  it('a step-down lifts nothing unless a house wrote it and its seed opens the requirement', () => {
    const { session, c2 } = afterHouseRound();
    const wrongSeed = kit.stepDown(H, 2, kit.houseSeed(H, 3));
    const byRogue = kit.stepDown(ROGUE, 2, kit.houseSeed(H, 2));
    const otherRound = kit.stepDown(H, 3, kit.houseSeed(H, 2));
    expect(foldOf(session.put(wrongSeed, byRogue, otherRound)).required).toBe(c2);
  });

  it('a house reveal carrying no commitment leaves the next round joinable', () => {
    const { a1, b1, join, close, ra, rb } = fairRound1();
    const last = kit.houseReveal(H, 1, [close.hash], [a1.hash, b1.hash], { c: null });
    const res = foldOf(new TestSession().put(a1, b1, join, close, ra, rb, last));
    expect(res.rounds[0].decided).toBe('house');
    expect(res).toMatchObject({ open: 2, required: null, joins: [] });
  });
});

describe('a joinable round', () => {
  it('a close may name a house\'s join commitment, or nothing, but nothing else', () => {
    const a1 = kit.slip(A, 1, [red(10)]);
    const join = kit.houseJoin(H, 1);
    const rogueJoin = kit.houseJoin(ROGUE, 1);
    const named = kit.close(A, 1, SID, [a1], join.rec.c);
    const friendly = kit.close(A, 1, SID, [a1]);
    const unknown = kit.close(A, 1, SID, [a1], other(9));
    const rogue = kit.close(A, 1, SID, [a1], rogueJoin.rec.c);
    const res = foldOf(new TestSession().put(a1, join, rogueJoin, named, friendly, unknown, rogue));
    expect(res.joins.map((j) => j.hash)).toEqual([join.hash]);
    const state = new Map(res.openCloses.map((c) => [c.hash, c.state]));
    expect([named, friendly, unknown, rogue].map((c) => state.get(c.hash))).toEqual(['valid', 'valid', 'invalid', 'invalid']);
  });

  it('two houses\' joins are both listed, by record hash, and each decides the close naming it', () => {
    const both = housesAre(H, H2);
    const a1 = kit.slip(A, 1, [red(10)]);
    const b1 = kit.slip(B, 1, [black(10)]);
    const j1 = kit.houseJoin(H, 1);
    const j2 = kit.houseJoin(H2, 1);
    const x = kit.close(A, 1, SID, [a1, b1], j1.rec.c);
    const y = kit.close(B, 1, SID, [a1, b1], j2.rec.c);
    const s = new TestSession().put(a1, b1, j1, j2, x, y, kit.reveal(1, A.pid), kit.reveal(1, B.pid));
    expect(foldOf(s, both).joins.map((j) => j.hash)).toEqual([j1.hash, j2.hash].sort());
    // H2's seed can't open H's commitment: its reveal of x decides nothing.
    const crossed = kit.houseReveal(H2, 1, [x.hash, y.hash], [a1.hash, b1.hash]);
    const res = foldOf(s.put(crossed), both);
    expect(res.rounds[0]).toMatchObject({ close: y.hash, decided: 'house' });
    expect(res.required).toBe(kit.houseCommit(H2, 2));
  });

  it('a join whose seed a step-down revealed can\'t be named any more', () => {
    const a1 = kit.slip(A, 1, [red(10)]);
    const join = kit.houseJoin(H, 1);
    const named = kit.close(A, 1, SID, [a1], join.rec.c);
    const res = foldOf(new TestSession().put(a1, join, named, kit.stepDown(H, 1)));
    expect(res.joins).toEqual([]);
    expect(res.openCloses).toEqual([{ hash: named.hash, rec: named.rec, state: 'invalid' }]);
  });
});

// ── The house's key ──────────────────────────────────────────────────────────

describe('whether a key is a house (HouseCheck)', () => {
  it('not known yet: what it wrote waits and the pass is pending; known not, it counts nothing', () => {
    const { a1, b1, join, close, ra, rb, hr } = fairRound1();
    const s = new TestSession().put(a1, b1, join, close, ra, rb, hr);
    const waiting = foldOf(s, () => undefined);
    expect(waiting.openCloses[0].state).toBe('pending');
    expect(waiting).toMatchObject({ pending: true, rounds: [], joins: [] });
    const refused = foldOf(s, () => false);
    expect(refused.openCloses[0].state).toBe('invalid');
    expect(refused).toMatchObject({ pending: false, rounds: [] });
  });

  it('a pending answer is asked again on the next pass; a settled one only after houseChanged', () => {
    const { a1, b1, join, close, ra, rb, hr } = fairRound1();
    const verdicts = new Map<string, boolean | undefined>();
    const check: HouseCheck = (pub) => verdicts.get(pub);
    const f = new TableFold(HCTX, sigs.check, undefined, undefined, check);
    f.setBase(null);
    f.apply([a1, b1, join, close, ra, rb, hr].map((x) => [x.key, x.rec] as const));
    expect(f.result().pending).toBe(true);
    verdicts.set(H.pub, false); // not delegated (yet)
    const settled = f.result();
    expect(settled).toMatchObject({ pending: false, rounds: [] });
    verdicts.set(H.pub, true); // its delegation arrives
    expect(f.result()).toBe(settled); // nothing told it
    f.houseChanged();
    const warm = f.result();
    expect(warm.rounds[0]).toMatchObject({ decided: 'house' });
    expect(houseSnapshot(warm)).toBe(houseSnapshot(new TestSession().put(a1, b1, join, close, ra, rb, hr).fold(sigs.check, null, HCTX, check).result()));
  });
});

// ── Checkpoints ──────────────────────────────────────────────────────────────

describe('a house table\'s checkpoint', () => {
  it('its h is what the next session\'s first close must name, and is part of the sid', () => {
    const { close } = fairRound1();
    const c2 = kit.houseCommit(H, 2);
    const cp = kit.checkpoint(A, 'g', 1, close.hash, { alice: 5n }, undefined, undefined, c2);
    const plainCp = kit.checkpoint(A, 'g', 1, close.hash, { alice: 5n });
    const sid = nextSid(HCTX, cp);
    expect(sid).not.toBe(nextSid(HCTX, plainCp));
    const a2 = kit.slip(A, 2, [red(4)]);
    const none = kit.close(A, 2, sid, [a2]);
    const named = kit.close(A, 2, sid, [a2], c2);
    const s = new TestSession().put(a2, none, named);
    const res = foldOf(s, onlyH, cp);
    expect(res.base).toMatchObject({ sid, u: 1, h: c2 });
    expect(res.required).toBe(c2);
    expect(new Map(res.openCloses.map((c) => [c.hash, c.state]))).toEqual(new Map([[none.hash, 'invalid'], [named.hash, 'valid']]));
    const hr2 = kit.houseReveal(H, 2, [named.hash], [a2.hash]);
    const done = foldOf(s.put(kit.reveal(2, A.pid), hr2), onlyH, cp);
    expect(done.rounds[0]).toMatchObject({ r: 2, decided: 'house' });
    expect(done.nets.get('alice')).toBe(5n + done.rounds[0].deltas.get('alice')!);
  });
});

// ── The chain ────────────────────────────────────────────────────────────────

describe('choosing the chain at a house table', () => {
  /** Round r's Friendly close by `by` under `q`, with its slips and seeds. */
  function friendlyRound(by: TestIdentity, r: number, q: string) {
    const a = kit.slip(A, r, [red(2)]);
    const b = kit.slip(B, r, [black(2)]);
    const c = kit.close(by, r, q, [a, b]);
    return { c, recs: [a, b, c, kit.reveal(r, A.pid), kit.reveal(r, B.pid)] as Built<unknown>[] };
  }

  it('a round the house decided can\'t be outgrown by a longer Friendly chain written beside it', () => {
    const { a1, b1, join, close, ra, rb, hr } = fairRound1();
    const y1 = kit.close(B, 1, SID, [a1, b1]); // Friendly, decided by every seed in
    const y2 = friendlyRound(A, 2, y1.hash);
    const y3 = friendlyRound(A, 3, y2.c.hash);
    const s = new TestSession().put(a1, b1, join, close, ra, rb, y1, ...y2.recs, ...y3.recs);
    // Without the house's reveal the longest chain wins, as at any table.
    expect(foldOf(s).rounds.map((v) => v.close)).toEqual([y1.hash, y2.c.hash, y3.c.hash]);
    const res = foldOf(s.put(hr));
    expect(res.rounds.map((v) => v.close)).toEqual([close.hash]);
    expect(res.required).toBe(kit.houseCommit(H, 2));
  });

  it('the later house round wins over a longer chain whose last house round came earlier', () => {
    const a1 = kit.slip(A, 1, [red(10)]);
    const b1 = kit.slip(B, 1, [black(10)]);
    const join1 = kit.houseJoin(H, 1);
    const x1 = kit.close(A, 1, SID, [a1, b1], join1.rec.c);
    const z1 = kit.close(A, 1, SID, [a1], join1.rec.c);
    // The house decides both rivals and leaves after the round...
    const hr1 = kit.houseReveal(H, 1, [x1.hash, z1.hash], [a1.hash, b1.hash], { c: null });
    // ...comes back on x1's round 2, while z1's line goes on Friendly for two rounds.
    const a2 = kit.slip(A, 2, [red(3)]);
    const join2 = kit.houseJoin(H, 2);
    const x2 = kit.close(A, 2, x1.hash, [a2], join2.rec.c);
    const hr2 = kit.houseReveal(H, 2, [x2.hash], [a2.hash]);
    const z2 = friendlyRound(B, 2, z1.hash);
    const z3 = friendlyRound(B, 3, z2.c.hash);
    const s = new TestSession().put(a1, b1, join1, x1, z1, hr1, kit.reveal(1, A.pid), kit.reveal(1, B.pid), a2, join2, x2, ...z2.recs, ...z3.recs);
    const before = foldOf(s);
    // Both lines' latest house round is 1: the longer (z) wins.
    expect(before.rounds.map((v) => v.close)).toEqual([z1.hash, z2.c.hash, z3.c.hash]);
    const res = foldOf(s.put(hr2));
    expect(res.rounds.map((v) => [v.close, v.decided])).toEqual([[x1.hash, 'house'], [x2.hash, 'house']]);
  });
});

// ── Craps ────────────────────────────────────────────────────────────────────

describe('a d table (craps with a house)', () => {
  const dkit = new ComputedKit(DCTX);
  const felt = (...bets: CrapsBet[]): CrapsBet[] => canonFelt(bets);

  it('the house\'s seed joins the dice, last', () => {
    const s1 = dkit.crapsSlip(A, 1, felt({ type: 'pass', amount: 10 }), basisOf(EMPTY_CARRY, A.pid), { t: 1 });
    const join = dkit.houseJoin(H, 1);
    const close = dkit.close(A, 1, SID, [s1], join.rec.c);
    const hr = dkit.houseReveal(H, 1, [close.hash], [s1.hash]);
    const s = new TestSession().put(s1, join, close, dkit.reveal(1, A.pid));
    expect(foldOf(s, onlyH, null, DCTX).tip).toMatchObject({ decided: null });
    const v = foldOf(s.put(hr), onlyH, null, DCTX).rounds[0];
    const dice = diceOf(seedTable(DCTX), 1, [dkit.seed(A.pid, 1)], dkit.houseSeed(H, 1));
    expect(v).toMatchObject({ decided: 'house', counted: [A.pid], pocket: null });
    expect(v.craps?.dice).toEqual(dice);
  });

  it('a seed the house didn\'t count plays only what already rode, as under a forfeit', () => {
    const s1 = dkit.crapsSlip(A, 1, felt({ type: 'pass', amount: 10 }), basisOf(EMPTY_CARRY, A.pid), { t: 1 });
    const s2 = dkit.crapsSlip(B, 1, felt({ type: 'pass', amount: 7 }), basisOf(EMPTY_CARRY, B.pid), { t: 2 });
    const join = dkit.houseJoin(H, 1);
    const close = dkit.close(A, 1, SID, [s1, s2], join.rec.c);
    const hr = dkit.houseReveal(H, 1, [close.hash], [s1.hash]);
    const v = foldOf(new TestSession().put(s1, s2, join, close, dkit.reveal(1, A.pid), dkit.reveal(1, B.pid), hr), onlyH, null, DCTX).rounds[0];
    expect(v).toMatchObject({ decided: 'house', counted: [A.pid] });
    expect(v.craps?.lost.get(B.pid)).toBe(7n);
  });
});

// ── The record set ───────────────────────────────────────────────────────────

/** Three rounds of a house table with every house rule in play: joins by two
 *  houses (one not delegated), a house round and a void one, rival Fair and
 *  Friendly closes, a step-down, a late seed, an abandon, a forged reveal and
 *  junk under house keys. */
function universe() {
  const recs: Built<unknown>[] = [];
  const a1 = kit.slip(A, 1, [red(10)]);
  const b1 = kit.slip(B, 1, [black(5)]);
  const c1 = kit.slip(C, 1, [straight(3, 2)]);
  const j1 = kit.houseJoin(H, 1);
  const j1r = kit.houseJoin(ROGUE, 1);
  const x1 = kit.close(A, 1, SID, [a1, b1, c1], j1.rec.c);
  const y1 = kit.close(B, 1, SID, [a1, b1]);
  const hr1 = kit.houseReveal(H, 1, [x1.hash], [a1.hash, b1.hash]); // carol's seed came late
  recs.push(a1, b1, c1, j1, j1r, x1, y1, hr1, kit.reveal(1, A.pid), kit.reveal(1, B.pid), kit.reveal(1, C.pid));
  recs.push(kit.abandon(C, 1, x1.hash));
  // Round 2: the required commitment named, or a step-down and a Friendly close.
  const a2 = kit.slip(A, 2, [red(4)]);
  const b2 = kit.slip(B, 2, [black(4)], { v: 1 });
  const b2v2 = kit.slip(B, 2, [black(8)], { v: 2 });
  const x2 = kit.close(A, 2, x1.hash, [a2, b2], kit.houseCommit(H, 2));
  const w2 = kit.close(B, 2, x1.hash, [a2, b2v2]);
  const yy2 = kit.close(A, 2, y1.hash, [a2]);
  const hr2 = kit.houseReveal(H, 2, [x2.hash], [], {}); // counts nobody: void
  recs.push(a2, b2, b2v2, x2, w2, yy2, hr2, kit.reveal(2, A.pid), kit.reveal(2, B.pid));
  // Round 3, after x2's void (requires H's round-3 commitment) or w2 (joinable).
  const a3 = kit.slip(A, 3, [red(1)]);
  const x3 = kit.close(A, 3, x2.hash, [a3], kit.houseCommit(H, 3));
  const w3 = kit.close(A, 3, w2.hash, [a3]);
  const j3 = kit.houseJoin(H, 3, kit.houseCommit(H, 3, kit.seed('h', 3)));
  const v3 = kit.close(A, 3, w2.hash, [a3], j3.rec.c);
  recs.push(a3, x3, w3, j3, v3, kit.reveal(3, A.pid), kit.houseReveal(H, 3, [x3.hash], [a3.hash]));
  recs.push(kit.houseReveal(H, 3, [v3.hash], [a3.hash], { s: kit.seed('h', 3) }));
  const down = kit.stepDown(H, 2);
  recs.push(down);
  const records: [string, unknown][] = recs.map((r) => [r.key, r.rec]);
  // A forged reveal (H's key, the rogue's signature) and junk under house keys.
  const good = kit.houseReveal(H, 3, [w3.hash], [a3.hash], { s: kit.houseSeed(H, 3) });
  const forged = { ...good.rec, g: houseSign(ROGUE.secret, signBytes('hreveal', HCTX, good.rec)) };
  records.push([houseRevealKey(forged)!, forged]);
  records.push([`h:1:${'0'.repeat(32)}`, { r: 1 }], [`o:2:${j1.hash}`, j1.rec], [`h:x:${hr1.hash}`, hr1.rec]);
  return { records, x1, x2, x3, w2, v3, down };
}

describe('the output depends on the record set only (a house table)', () => {
  const { records, x1, x2, x3, w2, v3, down } = universe();
  const cold = (set: Iterable<readonly [string, unknown]>): string => {
    const f = new TableFold(HCTX, sigs.check, undefined, undefined, onlyH);
    f.setBase(null);
    f.reset(set);
    return houseSnapshot(f.result());
  };

  it('the universe exercises house rounds, voids by the house and by abandon, step-downs and joins', () => {
    const all = new TestSession();
    for (const [k, v] of records) all.raw(k, v);
    const res = foldOf(all);
    // The step-down lifts round 2's requirement: a Friendly round, then the house joins again.
    expect(res.rounds.map((v) => [v.close, v.decided])).toEqual([[x1.hash, 'house'], [w2.hash, 'reveals'], [v3.hash, 'house']]);
    expect(res.rounds[0].counted).toEqual(['alice', 'bob']);
    expect(res.records).toBe(records.length - 3); // the three junk entries (the forged reveal indexes)
    // Without it, the house voids round 2 and decides round 3 on the commitment that void handed on.
    const noStepDown = new TestSession();
    for (const [k, v] of records) if (k !== down.key) noStepDown.raw(k, v);
    const other = foldOf(noStepDown);
    expect(other.rounds.map((v) => [v.close, v.decided])).toEqual([[x1.hash, 'house'], [x2.hash, 'void'], [x3.hash, 'house']]);
    expect(other.rounds[1].house).toBeDefined();
  });

  it('200 shuffled insertion orders, in random batches, give the same output', () => {
    const want = cold(records);
    for (let n = 0; n < 200; n++) {
      const rand = rng(n + 1);
      const order = shuffled(records, rand);
      const f = new TableFold(HCTX, sigs.check, undefined, undefined, onlyH);
      f.setBase(null);
      for (let i = 0; i < order.length;) {
        const size = 1 + Math.floor(rand() * 5);
        f.apply(order.slice(i, i + size));
        i += size;
        if (rand() < 0.5) f.result();
      }
      expect(houseSnapshot(f.result()), `order ${n}`).toBe(want);
    }
  });

  it('an incremental fold equals a cold one after every random insert and delete', () => {
    const rand = rng(78);
    const live = new Map<string, unknown>();
    const f = new TableFold(HCTX, sigs.check, undefined, undefined, onlyH);
    f.setBase(null);
    const junkValues: unknown[] = [{ r: 1 }, 'x', 1.5, null];
    const seen = new Set<string>();
    for (let step = 0; step < 600; step++) {
      const roll = rand();
      const [key, value] = records[Math.floor(rand() * records.length)];
      if (roll < 0.55) {
        live.set(key, value);
        f.apply([[key, value]]);
      } else if (roll < 0.9) {
        live.delete(key);
        f.apply([[key, undefined]]);
      } else if (roll < 0.97) {
        const junk = junkValues[Math.floor(rand() * junkValues.length)];
        live.set(key, junk);
        f.apply([[key, junk]]);
      } else {
        f.reset(live.entries());
      }
      if (rand() < 0.8) {
        const got = houseSnapshot(f.result());
        expect(got, `step ${step}`).toBe(cold(live.entries()));
        for (const v of f.result().rounds) seen.add(`${v.r}:${v.decided}:${v.house ? 'h' : v.abandon ? 'z' : '-'}`);
      }
    }
    expect(houseSnapshot(f.result())).toBe(cold(live.entries()));
    // The walk met house rounds, the house's void, an abandon's void and Friendly rounds.
    expect([...seen].some((x) => x.endsWith(':house:h'))).toBe(true);
    expect([...seen].some((x) => x.endsWith(':void:h'))).toBe(true);
    expect([...seen].some((x) => x.endsWith(':void:z'))).toBe(true);
    expect([...seen].some((x) => x.endsWith(':reveals:-'))).toBe(true);
  });
});

describe('🏛️🧮 hs: — the owner-signed checkpoint check (PR 6a-2 C1)', () => {
  const O = testIdentity('owner');
  const readR = asHouseSumFor(HCTX);                // r… → roulette, house table
  const PLAIN: FoldCtx = { room: 'room-test', t: 'roulette-plain', inc: 'c0123456789abcdef01234567' }; // non-house roulette
  const readPlain = asHouseSumFor(PLAIN);
  const dk = new ComputedKit(DCTX);                 // d… → craps, house table
  const readD = asHouseSumFor(DCTX);

  // A roulette checkpoint and an hs: that checks it (same b,u,l,n → same digest).
  const cp = kit.checkpoint(A, SID, 5, 'a'.repeat(32), { [A.pid]: 100n });
  const mk = (over: Record<string, unknown> = {}): HouseSum =>
    kit.sign<HouseSum>('hsum', O, { v: 1, b: cp.b, u: cp.u, l: cp.l, n: cp.n, a: 0, ...over });

  it('reads a valid hs:, and its digest is the sum:’s nextSid', () => {
    const hs = mk();
    expect(readR(hs)).not.toBeNull();
    expect(houseSumDigest(HCTX, hs)).toBe(nextSid(HCTX, cp));
  });

  it('is junk on a bad shape: v, a-range, u>U_MAX, missing/extra field, checkpoint junk', () => {
    expect(readR({ ...mk(), v: 2 })).toBeNull();
    expect(readR({ ...mk(), a: -1 })).toBeNull();
    expect(readR({ ...mk(), a: 6 })).toBeNull();            // a > u (5)
    expect(readR({ ...mk(), u: U_MAX + 1 })).toBeNull();
    const noA = { ...mk() } as Record<string, unknown>; delete noA.a;
    expect(readR(noA)).toBeNull();
    expect(readR({ ...mk(), zz: 1 })).toBeNull();           // unknown field
    expect(readR({ ...mk(), l: 'zz' })).toBeNull();         // checkpoint field junk
  });

  it('checks d and o: d shape, o only with d, o the game’s shape', () => {
    expect(readR(mk({ d: 'r', o: 17 }))).not.toBeNull();    // roulette pocket
    expect(readR(mk({ d: 'f:' + 'a'.repeat(32) }))).not.toBeNull();
    expect(readR(mk({ d: 'x' }))).toBeNull();               // bad d
    expect(readR(mk({ o: 17 }))).toBeNull();                // o without d
    expect(readR(mk({ d: 'r', o: 37 }))).toBeNull();        // pocket out of range
    expect(readR(mk({ d: 'r', o: [1, 2] }))).toBeNull();    // array at roulette
  });

  it('rejects a house commitment h at a non-house roulette table', () => {
    const withH = { ...mk(), h: 'b'.repeat(64) };
    expect(readR(withH)).not.toBeNull();                    // r… house table allows h
    expect(readPlain(withH)).toBeNull();                    // plain roulette: h is junk
  });

  it('craps: s is required live, o is a pair of dice', () => {
    const dcp = dk.checkpoint(A, SID, 3, 'c'.repeat(32), { [A.pid]: 50n }, undefined, EMPTY_CARRY);
    const mkD = (over: Record<string, unknown> = {}): HouseSum =>
      dk.sign<HouseSum>('hsum', O, { v: 1, b: dcp.b, u: dcp.u, l: dcp.l, n: dcp.n, s: dcp.s, a: 0, ...over });
    expect(readD(mkD())).not.toBeNull();
    expect(houseSumDigest(DCTX, mkD())).toBe(nextSid(DCTX, dcp));
    expect(readD(mkD({ d: 'r', o: [3, 4] }))).not.toBeNull(); // dice
    expect(readD(mkD({ d: 'r', o: 5 }))).toBeNull();          // number at craps
    const noS = { ...mkD() } as Record<string, unknown>; delete noS.s;
    expect(readD(noS)).toBeNull();                           // live craps needs s
  });

  it('orders hs: by u, then digest, then a, then recHash', () => {
    const lo = mk();                                 // u = 5
    const hiCp = kit.checkpoint(A, SID, 6, 'a'.repeat(32), { [A.pid]: 100n });
    const hi = kit.sign<HouseSum>('hsum', O, { v: 1, b: hiCp.b, u: hiCp.u, l: hiCp.l, n: hiCp.n, a: 0 });
    expect(compareHouseSum(HCTX, hi, lo)).toBeGreaterThan(0); // higher u wins
    expect(compareHouseSum(HCTX, lo, hi)).toBeLessThan(0);
    const a0 = mk();
    const a2 = mk({ a: 2 });
    expect(compareHouseSum(HCTX, a0, a2)).toBeGreaterThan(0); // same digest → lower a wins
    expect(compareHouseSum(HCTX, a0, a0)).toBe(0);
  });

  it('signBytes bind the room, table and incarnation', () => {
    const body = { v: 1, b: cp.b, u: cp.u, l: cp.l, n: cp.n, a: 0 };
    const base = signBytes('hsum', HCTX, body);
    expect(base).not.toEqual(signBytes('hsum', { ...HCTX, t: 'other' }, body));
    expect(base).not.toEqual(signBytes('hsum', { ...HCTX, inc: 'r9999999999999999999999999' }, body));
    expect(base).not.toEqual(signBytes('hsum', { ...HCTX, room: 'other-room' }, body));
  });
});
