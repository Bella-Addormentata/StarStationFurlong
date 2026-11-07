/**
 * 🔒🧮 FAIR ONLY in the fold (computedFold at `p…` and `q…`, design §8.3 S6,
 * PR 6c-3): what a table that runs without its owner counts, and what it
 * refuses to.
 *
 * A FAIR ONLY table is a house table whose rounds are all Fair: every close
 * names a house commitment (a), a session holds a bounded number of rounds
 * past its base (b), only a bettor of a round can void it (d), a game holds a
 * bounded number of players and bytes of their ids so that its checkpoint
 * always fits (e), and a house record counts only from a house that decides
 * its round (f). The fold's base is the FAIR ONLY checkpoint the authority
 * resolver chose (setFairOnlyBase), and with none it counts nothing.
 *
 * The specs build a good session whole, change one thing, and show that this
 * rule alone decides the difference; the same records at an ordinary house
 * table (`r…`) are the control wherever the rule is FAIR ONLY's own.
 */

import { describe, expect, it } from 'vitest';
import {
  canon, houseCommitKey, MAX_HELD_ROUNDS, MAX_SESSION_ROUNDS, MAX_TABLE_PID_BYTES, MAX_TABLE_PIDS, nextSid3, TableFold, utf8Length,
} from './computedFold';
import type { FoldCtx, FoldResult, HouseCheck, SigCheck } from './computedFold';
import { ctxOf, hex, house, rootOf, trimOf } from './computedFairOnlyKit';
import { basisOf, canonFelt } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
import { black, cachingCheck, ComputedKit, housesAre, red, TestSession, testHouse, testIdentity } from './computedTestKit';
import type { Built, TestHouse, TestIdentity } from './computedTestKit';

// ── The tables ───────────────────────────────────────────────────────────────

const P = ctxOf('p');
const Q = ctxOf('q');
/** An ordinary house table, the control. */
const R: FoldCtx = { room: P.room, t: P.t, inc: `r${'0123456789abcdef01234567'}` };
const ROGUE = testHouse('rogue-node');
const A = testIdentity('alice');
const B = testIdentity('bob');
const C = testIdentity('carol');
const H = house;
const onlyH = housesAre(H);
const sigs = cachingCheck();

const root = rootOf(P, 'p');
const SID = nextSid3(P, root.value);
const kit = new ComputedKit(P);
const rkit = new ComputedKit(R);

type Base = Parameters<TableFold['setFairOnlyBase']>[0];

/** A FAIR ONLY fold of `session` from `base` (the root unless said). */
function foldAt(
  session: TestSession, base: Base = root.value, opts: { ctx?: FoldCtx; houseOk?: HouseCheck; check?: SigCheck } = {},
): FoldResult {
  const fold = new TableFold(opts.ctx ?? P, opts.check ?? sigs.check, undefined, undefined, opts.houseOk ?? onlyH);
  fold.setFairOnlyBase(base);
  fold.reset(session.records.entries());
  return fold.result();
}

/** What a record weighs in the fold's books (`bytes`, `keptBytes`). */
const sizeOf = (b: Built<unknown>): number => b.key.length + (canon(b.rec) as string).length;

/** Round 1 with Alice and Bob: the house's join, Alice's close naming it, both
 *  seeds, and the house's reveal counting both (it carries round 2's commitment). */
function fairRound1(k: ComputedKit = kit, sid: string = SID, house1: TestHouse = H) {
  const a1 = k.slip(A, 1, [red(10)]);
  const b1 = k.slip(B, 1, [black(5)]);
  const join = k.houseJoin(house1, 1);
  const close = k.close(A, 1, sid, [a1, b1], join.rec.c);
  const ra = k.reveal(1, A.pid);
  const rb = k.reveal(1, B.pid);
  const hr = k.houseReveal(house1, 1, [close.hash], [a1.hash, b1.hash]);
  return { a1, b1, join, close, ra, rb, hr };
}
const putRound1 = (r: ReturnType<typeof fairRound1>): TestSession => new TestSession().put(r.a1, r.b1, r.join, r.close, r.ra, r.rb, r.hr);

// ── The base ─────────────────────────────────────────────────────────────────

describe('a FAIR ONLY table has a FAIR ONLY base', () => {
  it('setBase is not for it, and setFairOnlyBase is for no other table', () => {
    const fold = new TableFold(P, sigs.check, undefined, undefined, onlyH);
    expect(() => fold.setBase(null)).toThrow(TypeError);
    expect(() => fold.setBase(null)).toThrow(/FAIR ONLY/);
    for (const ctx of [R, { ...R, inc: `d${'0123456789abcdef01234567'}` }, { ...R, inc: `c${'0123456789abcdef01234567'}` }, { ...R, inc: `k${'0123456789abcdef01234567'}` }]) {
      const other = new TableFold(ctx, sigs.check, undefined, undefined, onlyH);
      expect(() => other.setFairOnlyBase(null), ctx.inc[0]).toThrow(TypeError);
      expect(() => other.setFairOnlyBase(root.value), ctx.inc[0]).toThrow(/only a FAIR ONLY table/);
      // (and what it has is still the ordinary kind)
      expect(() => other.setBase(null)).not.toThrow();
    }
  });

  it('opens at the checkpoint the resolver chose: its session, round, close, nets, commitment and carry', () => {
    const trim = trimOf(P, 'p');
    const res = foldAt(new TestSession(), trim.value);
    expect(res.base).toMatchObject({ sid: nextSid3(P, trim.value), u: 3, l: trim.value.l, h: trim.value.h, ended: false });
    expect(res.base.n).toEqual(new Map([['alice', 25n], ['bob', -25n]]));
    expect(res).toMatchObject({ open: 4, houseTable: true, required: trim.value.h });
    expect(res.nets).toEqual(res.base.n);
    // the root closed no round: there is no close, and no commitment to name first
    const first = foldAt(new TestSession());
    expect(first.base).toMatchObject({ sid: SID, u: 0, l: null, h: null, ended: false });
    expect(first.base.n.size).toBe(0);
    expect(first).toMatchObject({ open: 1, required: null });
    // craps: the carry the checkpoint holds is the state the first round starts from
    const qTrim = trimOf(Q, 'q');
    const qRes = foldAt(new TestSession(), qTrim.value, { ctx: Q });
    expect(qRes.carry).toMatchObject({ p: 6 });
    expect(foldAt(new TestSession(), rootOf(Q, 'q').value, { ctx: Q }).carry).toMatchObject({ p: 0 });
  });

  it('a net that is undefined is no player (canon leaves it out of the checkpoint\'s id)', () => {
    const trim = trimOf(P, 'p', { n: { alice: '25', bob: '-25', ghost: undefined } });
    const res = foldAt(new TestSession(), trim.value);
    expect([...res.base.n.keys()].sort()).toEqual(['alice', 'bob']);
  });

  it('with no base, nothing is counted, whatever the session holds', () => {
    const r = fairRound1();
    const session = putRound1(r);
    const res = foldAt(session, null);
    expect(res.rounds).toEqual([]);
    expect(res).toMatchObject({ tip: null, open: 1, keptBytes: 0, pending: false, houseTable: true, required: null });
    // (it names no session: the first session of an ordinary table, 'g', is not its)
    expect(res.parent).toBe('');
    expect(res.base.sid).toBe('');
    expect(res.nets.size).toBe(0);
    expect(res.held.size).toBe(0);
    expect(res.felts.size).toBe(0);
    expect(res.joins).toEqual([]);
    // (the session's records are weighed, as for any table: a sweep clears what they cost)
    expect(res.records).toBe(7);
    expect(res.rawBytes).toBeGreaterThan(0);
    // and a base chosen later counts them, once the fold is fed again
    const fold = new TableFold(P, sigs.check, undefined, undefined, onlyH);
    fold.setFairOnlyBase(null);
    fold.reset(session.records.entries());
    expect(fold.result().rounds).toEqual([]);
    fold.setFairOnlyBase(root.value);
    fold.reset(session.records.entries());
    expect(fold.result().rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house']]);
    // taking the base away again stops the count
    fold.setFairOnlyBase(null);
    expect(fold.result()).toMatchObject({ rounds: [], keptBytes: 0, records: 0 });
    // and with the session fed again, the table is still not open: nothing is counted, shown or held
    fold.reset(session.records.entries());
    const none = fold.result();
    expect(none).toMatchObject({ rounds: [], tip: null, open: 1, parent: '', keptBytes: 0, records: 7 });
    expect(none.base.sid).toBe('');
    expect(none.felts.size).toBe(0);
    expect(none.held.size).toBe(0);
    expect(none.joins).toEqual([]);
    // no base again is no change: the records the fold holds stay
    expect(() => fold.setFairOnlyBase(null)).not.toThrow();
    expect(fold.result().records).toBe(7);
    // and the session is counted again from the next base
    fold.setFairOnlyBase(root.value);
    fold.reset(session.records.entries());
    expect(fold.result().rounds.map((v) => v.decided)).toEqual(['house']);
  });

  it('the same base again changes nothing, and another base starts the session over', () => {
    const session = putRound1(fairRound1());
    const fold = new TableFold(P, sigs.check, undefined, undefined, onlyH);
    fold.setFairOnlyBase(root.value);
    fold.reset(session.records.entries());
    const before = fold.result();
    expect(before.records).toBe(7);
    fold.setFairOnlyBase(root.value);
    expect(fold.result().records, 'the same base: the records are kept').toBe(7);
    // an equal checkpoint under another object, too
    fold.setFairOnlyBase({ ...root.value });
    expect(fold.result().records).toBe(7);
    fold.setFairOnlyBase(trimOf(P, 'p').value);
    expect(fold.result().records, 'another session: the records of the old one are gone').toBe(0);
  });

  it('an ended game plays no more rounds, and keeps nothing', () => {
    const ended = trimOf(P, 'p', { e: 1, s: undefined, h: undefined, d: undefined, o: undefined, k: H.pub });
    const session = new TestSession().put(...Object.values(fairRound1()));
    const res = foldAt(session, ended.value);
    expect(res.rounds).toEqual([]);
    expect(res.base.ended).toBe(true);
    expect(res.nets).toEqual(res.base.n);
    expect(res.keptBytes).toBe(0);
    expect(res.held.size).toBe(0);
  });
});

// ── S6 (a): every close names a house commitment ─────────────────────────────

describe('(a) every close names a house commitment: no round is Friendly', () => {
  it('a close naming the house\'s join is decided by the house\'s reveal', () => {
    const r = fairRound1();
    const res = foldAt(putRound1(r));
    expect(res.rounds.map((v) => [v.r, v.close, v.decided])).toEqual([[1, r.close.hash, 'house']]);
    expect(res.rounds[0].house?.hash).toBe(r.hr.hash);
    expect(res.nets.get('alice')).not.toBe(undefined);
    expect(res).toMatchObject({ open: 2, parent: r.close.hash, required: kit.houseCommit(H, 2) });
  });

  it('a close naming nothing is no close, though every seed is in and a forfeit counts them', () => {
    const { a1, b1, join, ra, rb } = fairRound1();
    const plain = kit.close(A, 1, SID, [a1, b1]);
    const forfeit = kit.forfeit(A, 1, plain.hash, [A.pid, B.pid]);
    const session = new TestSession().put(a1, b1, join, plain, ra, rb, forfeit);
    const res = foldAt(session);
    expect(res.rounds).toEqual([]);
    expect(res).toMatchObject({ tip: null, open: 1, parent: SID });
    expect(res.openCloses.map((c) => [c.hash, c.state]), 'it is looked at, and found invalid').toEqual([[plain.hash, 'invalid']]);
    expect(res.nets.size).toBe(0);
    // The control: the same records at an ordinary house table are a Friendly round, decided by the reveals.
    const ra1 = rkit.slip(A, 1, [red(10)]);
    const rb1 = rkit.slip(B, 1, [black(5)]);
    const rplain = rkit.close(A, 1, 'g', [ra1, rb1]);
    const rr = new TestSession().put(ra1, rb1, rplain, rkit.reveal(1, A.pid), rkit.reveal(1, B.pid));
    const control = rr.fold(sigs.check, null, R, onlyH).result();
    expect(control.rounds.map((v) => v.decided)).toEqual(['reveals']);
  });

  it('nor does a stranger\'s abandon or a forfeit give a close that names nothing a round', () => {
    const { a1, b1, ra, rb } = fairRound1();
    const plain = kit.close(A, 1, SID, [a1, b1]);
    const abandon = kit.abandon(A, 1, plain.hash);
    const res = foldAt(new TestSession().put(a1, b1, plain, ra, rb, abandon));
    expect(res.rounds).toEqual([]);
    expect(res.tip).toBeNull();
  });

  it('a close naming a commitment no join of its round holds is no close either', () => {
    const { a1, b1, join, ra, rb } = fairRound1();
    const wrong = kit.close(A, 1, SID, [a1, b1], hex('9', 64));
    const hr = kit.houseReveal(H, 1, [wrong.hash], [a1.hash, b1.hash]);
    const res = foldAt(new TestSession().put(a1, b1, join, wrong, ra, rb, hr));
    expect(res.rounds).toEqual([]);
    // (the join is there, and a close naming it is the good one)
    const good = foldAt(new TestSession().put(a1, b1, join, kit.close(A, 1, SID, [a1, b1], join.rec.c), ra, rb));
    expect(good.tip).toMatchObject({ decided: null });
  });

  it('the first round after a trim names the trim\'s commitment, and nothing else', () => {
    const trim = trimOf(P, 'p', { h: kit.houseCommit(H, 4) });
    const sid = nextSid3(P, trim.value);
    const s4 = kit.slip(A, 4, [red(10)]);
    const r4 = kit.reveal(4, A.pid);
    const good = kit.close(A, 4, sid, [s4], trim.value.h);
    const hr = kit.houseReveal(H, 4, [good.hash], [s4.hash]);
    expect(foldAt(new TestSession().put(s4, r4, good, hr), trim.value).rounds.map((v) => [v.r, v.decided])).toEqual([[4, 'house']]);
    // nothing named
    const none = kit.close(A, 4, sid, [s4]);
    expect(foldAt(new TestSession().put(s4, r4, none, kit.houseReveal(H, 4, [none.hash], [s4.hash])), trim.value).rounds).toEqual([]);
    // another commitment, even a house's own join of that round
    const seed = hex('6', 64);
    const join = kit.houseJoin(H, 4, kit.houseCommit(H, 4, seed));
    const other = kit.close(A, 4, sid, [s4], join.rec.c);
    expect(foldAt(new TestSession().put(s4, r4, join, other, kit.houseReveal(H, 4, [other.hash], [s4.hash], { s: seed })), trim.value).rounds).toEqual([]);
  });

  it('after a house round the next close names the commitment its reveal carried', () => {
    const one = fairRound1();
    const a2 = kit.slip(A, 2, [red(4)]);
    const ra2 = kit.reveal(2, A.pid);
    const named = kit.close(A, 2, one.close.hash, [a2], kit.houseCommit(H, 2));
    const hr2 = kit.houseReveal(H, 2, [named.hash], [a2.hash]);
    const base = putRound1(one).put(a2, ra2, named, hr2);
    expect(foldAt(base).rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house'], [2, 'house']]);
    // a join of round 2 is not the required commitment while a reveal carries one
    const join2 = kit.houseJoin(H, 2, hex('8', 64));
    const off = kit.close(A, 2, one.close.hash, [a2], join2.rec.c);
    expect(foldAt(putRound1(one).put(a2, ra2, join2, off, kit.houseReveal(H, 2, [off.hash], [a2.hash]))).rounds.map((v) => v.r)).toEqual([1]);
    // naming nothing is not "lifted" either
    const bare = kit.close(A, 2, one.close.hash, [a2]);
    expect(foldAt(putRound1(one).put(a2, ra2, bare, kit.houseReveal(H, 2, [bare.hash], [a2.hash]))).rounds.map((v) => v.r)).toEqual([1]);
  });

  it('a step-down lifts the commitment a round must name, but a close still names one', () => {
    const one = fairRound1();
    const a2 = kit.slip(A, 2, [red(4)]);
    const ra2 = kit.reveal(2, A.pid);
    const step = kit.stepDown(H, 2);
    // a join of round 2 whose seed the step-down did not reveal
    const join2 = kit.houseJoin(H, 2, kit.houseCommit(H, 2, hex('7', 64)));
    const viaJoin = kit.close(A, 2, one.close.hash, [a2], join2.rec.c);
    const hr2 = kit.houseReveal(H, 2, [viaJoin.hash], [a2.hash], { s: hex('7', 64) });
    const lifted = foldAt(putRound1(one).put(a2, ra2, step, join2, viaJoin, hr2));
    expect(lifted.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house'], [2, 'house']]);
    // still no close naming nothing
    const bare = kit.close(A, 2, one.close.hash, [a2]);
    const bareRes = foldAt(putRound1(one).put(a2, ra2, step, bare, kit.houseReveal(H, 2, [bare.hash], [a2.hash])));
    expect(bareRes.rounds.map((v) => v.r)).toEqual([1]);
    // and not the commitment the step-down opened
    const old = kit.close(A, 2, one.close.hash, [a2], kit.houseCommit(H, 2));
    expect(foldAt(putRound1(one).put(a2, ra2, step, old)).rounds.map((v) => v.r)).toEqual([1]);
  });
});

// ── S6 (b): rounds held past the base ────────────────────────────────────────

/** `n` rounds in a row, `first` on: Alice's slip and seed, her close naming what
 *  the round requires (`named` for the first, the house's carried commitment after),
 *  and the house's reveal deciding it. Returns every record, and the closes. */
function chain(k: ComputedKit, h: TestHouse, sid: string, first: number, n: number, named: string) {
  const records: Built<unknown>[] = [];
  const closes: Built<{ r: number }>[] = [];
  let parent = sid;
  for (let r = first; r < first + n; r++) {
    const slip = k.slip(A, r, [red(1)]);
    const close = k.close(A, r, parent, [slip], r === first ? named : k.houseCommit(h, r));
    records.push(slip, close, k.reveal(r, A.pid), k.houseReveal(h, r, [close.hash], [slip.hash]));
    closes.push(close as Built<{ r: number }>);
    parent = close.hash;
  }
  return { records, closes };
}

describe('(b) a session holds MAX_HELD_ROUNDS rounds past its base, and waits for a checkpoint', () => {
  it('the constant is 40, well under what an ordinary table holds', () => {
    expect(MAX_HELD_ROUNDS).toBe(40);
    expect(MAX_HELD_ROUNDS).toBeLessThan(MAX_SESSION_ROUNDS);
  });

  it('decides forty rounds from the root and not the forty-first', () => {
    const join = kit.houseJoin(H, 1);
    const long = chain(kit, H, SID, 1, MAX_HELD_ROUNDS + 1, join.rec.c);
    const res = foldAt(new TestSession().put(join, ...long.records));
    expect(res.rounds).toHaveLength(MAX_HELD_ROUNDS);
    expect(res.rounds.every((v) => v.decided === 'house')).toBe(true);
    expect(res.rounds[MAX_HELD_ROUNDS - 1].r).toBe(MAX_HELD_ROUNDS);
    expect(res).toMatchObject({ open: MAX_HELD_ROUNDS + 1, parent: long.closes[MAX_HELD_ROUNDS - 1].hash });
    // the forty-first close is not looked at: it is listed, and it is invalid
    expect(res.openCloses.map((c) => [c.hash, c.state])).toEqual([[long.closes[MAX_HELD_ROUNDS].hash, 'invalid']]);
    expect(res.tip).toBeNull();
    // forty is as many as it takes, and one fewer leaves the next round waiting
    const forty = foldAt(new TestSession().put(join, ...chain(kit, H, SID, 1, MAX_HELD_ROUNDS, join.rec.c).records));
    expect(forty.rounds).toHaveLength(MAX_HELD_ROUNDS);
    const thirtyNine = foldAt(new TestSession().put(join, ...chain(kit, H, SID, 1, MAX_HELD_ROUNDS - 1, join.rec.c).records));
    expect(thirtyNine.rounds).toHaveLength(MAX_HELD_ROUNDS - 1);
  });

  it('counts the forty from the base, not from round one', () => {
    const trim = trimOf(P, 'p', { u: 10, h: kit.houseCommit(H, 11) });
    const sid = nextSid3(P, trim.value);
    const long = chain(kit, H, sid, 11, MAX_HELD_ROUNDS + 1, trim.value.h as string);
    const res = foldAt(new TestSession().put(...long.records), trim.value);
    expect(res.rounds).toHaveLength(MAX_HELD_ROUNDS);
    expect(res.rounds[0].r).toBe(11);
    expect(res.rounds[MAX_HELD_ROUNDS - 1].r).toBe(10 + MAX_HELD_ROUNDS);
    expect(res.open).toBe(11 + MAX_HELD_ROUNDS);
  });

  it('while an ordinary house table goes on', () => {
    const join = rkit.houseJoin(H, 1);
    const long = chain(rkit, H, 'g', 1, MAX_HELD_ROUNDS + 1, join.rec.c);
    const res = new TestSession().put(join, ...long.records).fold(sigs.check, null, R, onlyH).result();
    expect(res.rounds).toHaveLength(MAX_HELD_ROUNDS + 1);
  });
});

// ── S6 (d): only a bettor of the round can void it ───────────────────────────

describe('(d) an abandon counts only from the key of a frozen slip of its close', () => {
  /** Round 1 closed by Alice over her slip and Bob's, the house away (no reveal). */
  function awaitingHouse(k: ComputedKit = kit, sid: string = SID) {
    const a1 = k.slip(A, 1, [red(10)]);
    const b1 = k.slip(B, 1, [black(5)]);
    const join = k.houseJoin(H, 1);
    const close = k.close(A, 1, sid, [a1, b1], join.rec.c);
    return { a1, b1, join, close, records: [a1, b1, join, close, k.reveal(1, A.pid), k.reveal(1, B.pid)] as Built<unknown>[] };
  }
  const voided = (res: FoldResult) => res.rounds.filter((v) => v.decided !== null).map((v) => [v.r, v.decided, v.abandon?.hash ?? null]);

  it('a stranger\'s abandon voids nothing; a bettor\'s does', () => {
    const w = awaitingHouse();
    const stranger = kit.abandon(C, 1, w.close.hash);
    expect(voided(foldAt(new TestSession().put(...w.records, stranger)))).toEqual([]);
    expect(foldAt(new TestSession().put(...w.records, stranger)).tip).toMatchObject({ close: w.close.hash, decided: null });
    for (const who of [A, B]) {
      const mine = kit.abandon(who, 1, w.close.hash);
      expect(voided(foldAt(new TestSession().put(...w.records, mine))), who.pid).toEqual([[1, 'void', mine.hash]]);
    }
  });

  it('the same stranger\'s abandon voids the round at an ordinary house table', () => {
    const w = awaitingHouse(rkit, 'g');
    const stranger = rkit.abandon(C, 1, w.close.hash);
    const control = new TestSession().put(...w.records, stranger).fold(sigs.check, null, R, onlyH).result();
    expect(control.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'void']]);
  });

  it('strangers do not crowd a bettor\'s abandon out', () => {
    const w = awaitingHouse();
    const strangers = [C, testIdentity('dave'), testIdentity('erin'), testIdentity('frank')].map((id) => kit.abandon(id, 1, w.close.hash));
    const mine = kit.abandon(B, 1, w.close.hash);
    expect(voided(foldAt(new TestSession().put(...w.records, ...strangers, mine)))).toEqual([[1, 'void', mine.hash]]);
  });

  it('a frozen player whose slip is missing is no bettor yet', () => {
    const a1 = kit.slip(A, 1, [red(10)]);
    const dave = testIdentity('dave');
    const davesSlip = kit.slip(dave, 1, [red(1)]);
    const join = kit.houseJoin(H, 1);
    const close = kit.close(A, 1, SID, [a1, davesSlip], join.rec.c);
    const records = [a1, join, close, kit.reveal(1, A.pid)];
    const abandon = kit.abandon(dave, 1, close.hash);
    expect(voided(foldAt(new TestSession().put(...records, abandon))), 'his slip is not here: his key is not known').toEqual([]);
    expect(voided(foldAt(new TestSession().put(...records, davesSlip, abandon)))).toEqual([[1, 'void', abandon.hash]]);
  });

  it('a player who bet on the round, but whose slip the close did not freeze, is a stranger to that close', () => {
    const w = awaitingHouse();
    const stray = kit.slip(C, 1, [red(1)]);                       // Carol's slip of round 1, in no close
    const hers = kit.abandon(C, 1, w.close.hash);
    expect(voided(foldAt(new TestSession().put(...w.records, stray, hers)))).toEqual([]);
    // a close that froze her slip makes her a bettor of that close, and of that one only
    const withHer = kit.close(B, 1, SID, [w.a1, w.b1, stray], w.join.rec.c);
    const mine = kit.abandon(C, 1, withHer.hash);
    const res = foldAt(new TestSession().put(...w.records, stray, withHer, hers, mine));
    expect(voided(res)).toEqual([[1, 'void', mine.hash]]);
    expect(res.rounds[0].close).toBe(withHer.hash);
  });

  it('a stranger\'s abandon is passed over before any signature is looked at', () => {
    const w = awaitingHouse();
    const stranger = kit.abandon(C, 1, w.close.hash);
    const mine = kit.abandon(A, 1, w.close.hash);
    const asked: string[] = [];
    const spy: SigCheck = (hash, kind, pub, bytes, sig) => {
      asked.push(`${kind}:${hash}`);
      return sigs.check(hash, kind, pub, bytes, sig);
    };
    foldAt(new TestSession().put(...w.records, stranger), root.value, { check: spy });
    expect(asked.some((a) => a.startsWith('abandon:')), 'nothing asked about an abandon').toBe(false);
    foldAt(new TestSession().put(...w.records, stranger, mine), root.value, { check: spy });
    expect(asked).toContain(`abandon:${mine.hash}`);
    expect(asked).not.toContain(`abandon:${stranger.hash}`);
  });

  it('an abandon does not undo a round the house decided', () => {
    const r = fairRound1();
    const mine = kit.abandon(A, 1, r.close.hash);
    const res = foldAt(putRound1(r).put(mine));
    expect(res.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house']]);
  });
});

// ── S6 (e): the players a game holds ─────────────────────────────────────────

const utf8 = (v: string): number => new TextEncoder().encode(v).length;

describe('(e) a game holds MAX_TABLE_PIDS players, and MAX_TABLE_PID_BYTES bytes of their ids', () => {
  const nets = (ids: readonly string[]): Record<string, string> => Object.fromEntries(ids.map((id) => [id, '1']));
  const fillers = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `f${String(from + i).padStart(5, '0')}`);
  /** A trim after round 3 that already holds `ids`, its commitment the house's for round 4. */
  const trimHolding = (ids: readonly string[]) => trimOf(P, 'p', { n: nets(ids), h: kit.houseCommit(H, 4) });
  /** Round 4 on `trim`, closed by the first of `who` over a slip each. */
  function closeOf(trim: ReturnType<typeof trimOf>, who: readonly TestIdentity[]) {
    const slips = who.map((id) => kit.slip(id, 4, [red(1)]));
    const close = kit.close(who[0], 4, nextSid3(P, trim.value), slips, trim.value.h);
    return { slips, close, records: [...slips, close, ...who.map((id) => kit.reveal(4, id.pid))] as Built<unknown>[] };
  }
  const people = (n: number, from = 0): TestIdentity[] => Array.from({ length: n }, (_, i) => testIdentity(`bettor-${from + i}`));
  /** Whether the fold takes `close` as a close of round 4: it is on the board as a round, or it is not. */
  const taken = (res: FoldResult, close: Built<unknown>): boolean => res.rounds.some((v) => v.close === close.hash);
  const stateOf = (res: FoldResult, close: Built<unknown>): string | undefined => res.openCloses.find((c) => c.hash === close.hash)?.state;

  it('the constants: 4,000 players, and 1,000,000 bytes of ids', () => {
    expect(MAX_TABLE_PIDS).toBe(4_000);
    expect(MAX_TABLE_PID_BYTES).toBe(1_000_000);
  });

  it('utf8Length is the length a TextEncoder writes: an astral character four, a lone surrogate three', () => {
    const samples = [
      '', 'a', 'alice', '\u007f', '\u0080', 'é', '\u07ff', '\u0800', '語', '\uffff', '😀', 'a😀b', '\ud83d\ude00\ud83d\ude00',
      '\ud800', '\udc00', '\ud800\ud800', '\udc00\ud800', 'x\ud83d', '\ud83dx', '\ud800é', '\ud800語', '\udc00x', 'a\ud800\ud800\udc00',
      '\ud83d\ude00\ud83d',
    ];
    for (const sample of samples) expect(utf8Length(sample), JSON.stringify(sample)).toBe(utf8(sample));
  });

  it('takes a close that brings the game to 4,000 players and refuses one that takes it past', () => {
    const trim = trimHolding(fillers(MAX_TABLE_PIDS - 2));
    const fits = closeOf(trim, people(2));
    const res = foldAt(new TestSession().put(...fits.records), trim.value);
    expect(taken(res, fits.close), 'the 4,000th player').toBe(true);
    const over = closeOf(trim, people(3));
    const no = foldAt(new TestSession().put(...over.records), trim.value);
    expect(taken(no, over.close), 'the 4,001st').toBe(false);
    expect(stateOf(no, over.close)).toBe('invalid');
    expect(no.tip).toBeNull();
  });

  it('a net that is undefined is no player for the cap either', () => {
    const trim = trimOf(P, 'p', { n: { ...nets(fillers(MAX_TABLE_PIDS - 2)), ghost: undefined }, h: kit.houseCommit(H, 4) });
    // 3,998 players and a ghost: the two newcomers make 4,000
    const fits = closeOf(trim, people(2));
    expect(taken(foldAt(new TestSession().put(...fits.records), trim.value), fits.close)).toBe(true);
    const over = closeOf(trim, people(3));
    expect(taken(foldAt(new TestSession().put(...over.records), trim.value), over.close)).toBe(false);
  });

  it('a player the game already holds counts once', () => {
    const [x1, x2, x3] = people(3);
    const trim = trimHolding([...fillers(MAX_TABLE_PIDS - 3), x1.pid]);
    // x1 is in the nets already: x1, x2, x3 bring it to 3,997 + 1 + 2 = 4,000
    const fits = closeOf(trim, [x1, x2, x3]);
    expect(taken(foldAt(new TestSession().put(...fits.records), trim.value), fits.close)).toBe(true);
    const more = closeOf(trim, [x1, x2, x3, ...people(1, 3)]);
    expect(taken(foldAt(new TestSession().put(...more.records), trim.value), more.close)).toBe(false);
  });

  it('counts the players of every round on the chain, once each', () => {
    const trim = trimHolding(fillers(MAX_TABLE_PIDS - 3));
    const [x1, x2, x3, x4] = people(4);
    const one = closeOf(trim, [x1]);
    const hr1 = kit.houseReveal(H, 4, [one.close.hash], [one.slips[0].hash]);
    const at5 = (who: TestIdentity[]) => {
      const slips = who.map((id) => kit.slip(id, 5, [red(1)]));
      const close = kit.close(who[0], 5, one.close.hash, slips, kit.houseCommit(H, 5));
      return { close, records: [...slips, close, ...who.map((id) => kit.reveal(5, id.pid))] as Built<unknown>[] };
    };
    const session = (...more: Built<unknown>[]) => new TestSession().put(...one.records, hr1, ...more);
    // 3,997 + x1 = 3,998; x2 and x3 make 4,000; x1 again adds nothing
    const fits = at5([x1, x2, x3]);
    expect(taken(foldAt(session(...fits.records), trim.value), fits.close), 'x1 counts once').toBe(true);
    // one more is the 4,001st
    const over = at5([x1, x2, x3, x4]);
    const no = foldAt(session(...over.records), trim.value);
    expect(taken(no, over.close)).toBe(false);
    expect(no.rounds.map((v) => v.r), 'round 4 stands').toEqual([4]);
    // the same four, none of them on the first round's close, are not the first round's players
    const solo = at5([x2, x3, x4]);
    expect(taken(foldAt(session(...solo.records), trim.value), solo.close), '3,998 + 3 = 4,001').toBe(false);
    const pair = at5([x2, x3]);
    expect(taken(foldAt(session(...pair.records), trim.value), pair.close), '3,998 + 2 = 4,000').toBe(true);
  });

  it('a player first held two rounds back, or more, counts once', () => {
    const [x1, x2, x3, x4, x5] = people(5);
    const trim = trimHolding([...fillers(MAX_TABLE_PIDS - 4), x1.pid]);                 // 3,997, x1 among them
    /** Round `r` on `parent`, closed by the first of `who` over a slip each, and decided by the house. */
    const roundOf = (parent: string, r: number, who: readonly TestIdentity[], named: string) => {
      const slips = who.map((id) => kit.slip(id, r, [red(1)]));
      const close = kit.close(who[0], r, parent, slips, named);
      const hr = kit.houseReveal(H, r, [close.hash], slips.map((s) => s.hash));
      return { close, records: [...slips, close, ...who.map((id) => kit.reveal(r, id.pid)), hr] as Built<unknown>[] };
    };
    const r4 = roundOf(nextSid3(P, trim.value), 4, [x2], trim.value.h as string);          // x2: 3,998
    const r5 = roundOf(r4.close.hash, 5, [x3], kit.houseCommit(H, 5));                     // x3: 3,999
    const at6 = (who: TestIdentity[]) => roundOf(r5.close.hash, 6, who, kit.houseCommit(H, 6));
    const before = (more: { records: Built<unknown>[] }) => foldAt(new TestSession().put(...r4.records, ...r5.records, ...more.records), trim.value);
    // x1 is the base's, x2 is round 4's, x3 round 5's: only x4 is new, and that is the 4,000th
    const fits = at6([x1, x2, x3, x4]);
    expect(before(fits).rounds.map((v) => v.r)).toEqual([4, 5, 6]);
    expect(taken(before(fits), fits.close)).toBe(true);
    // and x5 is the 4,001st
    const over = at6([x1, x2, x3, x4, x5]);
    const no = before(over);
    expect(no.rounds.map((v) => v.r)).toEqual([4, 5]);
    expect(taken(no, over.close)).toBe(false);
    expect(stateOf(no, over.close)).toBe('invalid');
  });

  it('rival closes of one round are held to the cap on their own', () => {
    const trim = trimHolding(fillers(MAX_TABLE_PIDS - 3));
    const [x1, x2, x3, x4] = people(4);
    const fits = closeOf(trim, [x1, x2, x3]);
    const over = closeOf(trim, [x4, ...people(3, 5)]);
    // (the order they are written in does not matter)
    for (const records of [[...fits.records, ...over.records], [...over.records, ...fits.records]]) {
      const res = foldAt(new TestSession().put(...records), trim.value);
      expect(res.rounds.map((v) => v.close), 'the one that fits is the round').toEqual([fits.close.hash]);
      expect(res.openCloses.find((c) => c.hash === over.close.hash)?.state, 'the other is not').toBe('invalid');
    }
  });

  it('counts the bytes of their ids: 1,000,000 and no more', () => {
    // 256 UTF-16 units, 760 bytes: a four-digit number and 252 three-byte characters
    const long = (i: number): string => `${String(i).padStart(4, '0')}${'語'.repeat(252)}`;
    expect(long(0)).toHaveLength(256);
    const unit = utf8(long(0));
    expect(unit).toBe(760);
    const fit = Math.floor(MAX_TABLE_PID_BYTES / unit);            // the most such ids the rule allows
    const heldAlready = Array.from({ length: fit - 2 }, (_, i) => long(i));
    const trim = trimHolding(heldAlready);
    const talk = (ids: string[]) => ids.map((id) => testIdentity(`long-${id.slice(0, 4)}`, id));
    const two = closeOf(trim, talk([long(fit - 2), long(fit - 1)]));
    expect(taken(foldAt(new TestSession().put(...two.records), trim.value), two.close), `${fit} ids of ${unit} bytes`).toBe(true);
    const three = closeOf(trim, talk([long(fit - 2), long(fit - 1), long(fit)]));
    const no = foldAt(new TestSession().put(...three.records), trim.value);
    expect(taken(no, three.close), `${fit + 1} ids of ${unit} bytes`).toBe(false);
    expect(stateOf(no, three.close)).toBe('invalid');
    expect((fit + 1) * unit).toBeGreaterThan(MAX_TABLE_PID_BYTES);
    expect(fit * unit).toBeLessThanOrEqual(MAX_TABLE_PID_BYTES);
    // the count alone would have allowed it: the players are far under 4,000
    expect(fit + 1).toBeLessThan(MAX_TABLE_PIDS);
  });

  it('1,000,000 bytes exactly is allowed, and one more is not', () => {
    const long = (i: number): string => `${String(i).padStart(4, '0')}${'語'.repeat(252)}`;
    const unit = utf8(long(0));
    const fit = Math.floor(MAX_TABLE_PID_BYTES / unit);
    const trim = trimHolding(Array.from({ length: fit - 2 }, (_, i) => long(i)));
    // what is left after the ids already held is two long ones and a shorter one
    const left = MAX_TABLE_PID_BYTES - (fit - 2) * unit - 2 * unit;
    expect(left % 3).toBe(0);
    const shorter = '語'.repeat(left / 3);
    expect(utf8(shorter)).toBe(left);
    const ids = [long(fit - 2), long(fit - 1), shorter];
    expect((fit - 2) * unit + ids.reduce((n, id) => n + utf8(id), 0)).toBe(MAX_TABLE_PID_BYTES);
    const talk = (list: string[]) => list.map((id, i) => testIdentity(`exact-${i}`, id));
    const exact = closeOf(trim, talk(ids));
    expect(taken(foldAt(new TestSession().put(...exact.records), trim.value), exact.close), 'exactly 1,000,000').toBe(true);
    const over = closeOf(trim, talk([...ids, 'z']));
    const no = foldAt(new TestSession().put(...over.records), trim.value);
    expect(taken(no, over.close), '1,000,001').toBe(false);
    expect(stateOf(no, over.close)).toBe('invalid');
  });

  it('a rider of the carry is a player of the game, whether or not it writes a slip', () => {
    const qkit = new ComputedKit(Q);
    const pass = [{ type: 'pass' as const, amount: 1 }];
    const carry = (...riders: string[]): CrapsCarry => ({ p: 6, w: Object.fromEntries(riders.map((r) => [r, pass])) });
    const qTrim = (ids: readonly string[], s: CrapsCarry) => trimOf(Q, 'q', { n: nets(ids), s, h: qkit.houseCommit(H, 4) });
    const slipAt = (trim: ReturnType<typeof trimOf>, who: TestIdentity) => {
      const slip = qkit.crapsSlip(who, 4, canonFelt([{ type: 'pass', amount: 1 }]), basisOf(trim.value.s as CrapsCarry, who.pid), { t: 1 });
      const close = qkit.close(who, 4, nextSid3(Q, trim.value), [slip], trim.value.h);
      return { close, records: [slip, close, qkit.reveal(4, who.pid)] as Built<unknown>[] };
    };
    const [x] = people(1);
    // 3,999 in the nets and one rider: the game holds 4,000, so a newcomer is the 4,001st...
    const withRider = qTrim(fillers(MAX_TABLE_PIDS - 1), carry('rider-1'));
    const newcomer = slipAt(withRider, x);
    const no = foldAt(new TestSession().put(...newcomer.records), withRider.value, { ctx: Q });
    expect(no.rounds.some((v) => v.close === newcomer.close.hash)).toBe(false);
    // ...and the same newcomer fits where there is no rider...
    const noRider = qTrim(fillers(MAX_TABLE_PIDS - 1), carry());
    const ok = slipAt(noRider, x);
    expect(foldAt(new TestSession().put(...ok.records), noRider.value, { ctx: Q }).rounds.some((v) => v.close === ok.close.hash)).toBe(true);
    // ...and a rider writing a slip is one player, not two
    const rider = testIdentity('rider-1');
    const riding = slipAt(withRider, rider);
    expect(foldAt(new TestSession().put(...riding.records), withRider.value, { ctx: Q }).rounds.some((v) => v.close === riding.close.hash)).toBe(true);
  });

  it('an ordinary house table has no such cap', () => {
    // 46 rounds that each freeze thirty more ids of 758 bytes (a stranger's abandon ends each: that is an ordinary table's rule):
    // the ids pass 1,000,000 bytes at the 44th round
    const phantom = (r: number, j: number): string => `${String(r).padStart(3, '0')}${String(j).padStart(2, '0')}${'語'.repeat(251)}`;
    expect(utf8(phantom(46, 29))).toBe(758);
    const records: Built<unknown>[] = [];
    let parent = 'g';
    let bytes = utf8(A.pid);
    for (let r = 1; r <= 46; r++) {
      const mine = rkit.slip(A, r, [red(1)]);
      const frozen: Record<string, string> = { [A.pid]: mine.hash };
      for (let j = 0; j < 30; j++) { frozen[phantom(r, j)] = (j + 1).toString(16).padStart(2, '0').repeat(16); bytes += 758; }
      const close = rkit.close(A, r, parent, frozen);
      records.push(mine, close, rkit.abandon(C, r, close.hash));
      parent = close.hash;
    }
    expect(bytes).toBeGreaterThan(MAX_TABLE_PID_BYTES);
    const res = new TestSession().put(...records).fold(sigs.check, null, R, onlyH).result();
    expect(res.rounds).toHaveLength(46);
    expect(res.rounds.every((v) => v.decided === 'void')).toBe(true);
  });
});

// ── S6 (f): the houses of a round ────────────────────────────────────────────

describe('(f) a house record counts only from a house that decides its round', () => {
  function twoRounds() {
    const one = fairRound1();
    const a2 = kit.slip(A, 2, [red(4)]);
    const close2 = kit.close(A, 2, one.close.hash, [a2], kit.houseCommit(H, 2));
    return { one, a2, close2, ra2: kit.reveal(2, A.pid), hr2: kit.houseReveal(H, 2, [close2.hash], [a2.hash]) };
  }
  const sessionOf = (w: ReturnType<typeof twoRounds>) => putRound1(w.one).put(w.a2, w.close2, w.ra2, w.hr2);

  it('the check is asked about each house record with the round the record is for', () => {
    const w = twoRounds();
    const asked = new Set<string>();
    const houseOk: HouseCheck = (pub, round) => {
      asked.add(`${pub === H.pub ? 'H' : 'other'}:${round}`);
      return pub === H.pub;
    };
    const res = foldAt(sessionOf(w), root.value, { houseOk });
    expect(res.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house'], [2, 'house']]);
    expect(asked.has('H:1'), 'the first round\'s join and reveal').toBe(true);
    expect(asked.has('H:2'), 'the second round\'s reveal').toBe(true);
    expect([...asked].every((a) => a.startsWith('H:')), 'only the house\'s own records are asked about').toBe(true);
  });

  it('a house of the first round only decides the first', () => {
    const w = twoRounds();
    const houseOk: HouseCheck = (pub, round) => pub === H.pub && round <= 1;
    const res = foldAt(sessionOf(w), root.value, { houseOk });
    expect(res.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house'], [2, null]]);
    expect(res.tip).toMatchObject({ close: w.close2.hash, decided: null });
    // the second round's reveal is not a house's: it is passed over, not waited for
    expect(res.pending).toBe(false);
  });

  it('a join of a round its house does not decide names nothing', () => {
    const r = fairRound1();
    const houseOk: HouseCheck = (pub, round) => pub === H.pub && round !== 1;
    const res = foldAt(putRound1(r), root.value, { houseOk });
    expect(res.rounds).toEqual([]);
    expect(res.openCloses.map((c) => [c.hash, c.state])).toEqual([[r.close.hash, 'invalid']]);
    expect(res.joins).toEqual([]);
    // (the same records, the house deciding round 1, are a round)
    expect(foldAt(putRound1(r)).rounds.map((v) => v.decided)).toEqual(['house']);
  });

  it('a key that is not a house for the round decides nothing, though it holds the commitment', () => {
    const a1 = kit.slip(A, 1, [red(10)]);
    const join = kit.houseJoin(ROGUE, 1);
    const close = kit.close(A, 1, SID, [a1], join.rec.c);
    const hr = kit.houseReveal(ROGUE, 1, [close.hash], [a1.hash]);
    const res = foldAt(new TestSession().put(a1, join, close, hr, kit.reveal(1, A.pid)));
    expect(res.rounds).toEqual([]);
    expect(res.tip).toBeNull();
  });

  it('a round whose house is not known yet leaves the pass pending', () => {
    const w = twoRounds();
    const unknown: HouseCheck = (pub, round) => (round === 1 ? pub === H.pub : undefined);
    const res = foldAt(sessionOf(w), root.value, { houseOk: unknown });
    expect(res.pending).toBe(true);
    expect(res.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house'], [2, null]]);
    expect(foldAt(sessionOf(w)).pending).toBe(false);
  });
});

// ── keptBytes ────────────────────────────────────────────────────────────────

describe('keptBytes: what the pass used, which junk cannot raise', () => {
  const r1 = fairRound1();
  const used = [r1.a1, r1.b1, r1.join, r1.close, r1.ra, r1.rb, r1.hr];
  const total = used.reduce((n, b) => n + sizeOf(b), 0);
  const base = (...more: Built<unknown>[]) => foldAt(putRound1(r1).put(...more));

  it('is every record of a session that uses them all', () => {
    const res = base();
    expect(res.keptBytes).toBe(total);
    expect(res.bytes).toBe(total);
    expect(res.rawBytes).toBe(total);
  });

  it('is not raised by what anyone can write for nothing', () => {
    const stranger = kit.abandon(C, 1, r1.close.hash);
    const carolSlip = kit.slip(C, 1, [red(1)]);
    const a1v2 = kit.slip(A, 1, [red(20)], { v: 2 });
    const bare = kit.close(B, 1, SID, [r1.a1, r1.b1]);
    const strangerSeed = kit.reveal(1, C.pid);
    const forfeit = kit.forfeit(A, 1, r1.close.hash, [A.pid]);
    const futureSlip = kit.slip(A, 7, [red(3)]);
    const futureClose = kit.close(A, 7, hex('5', 32), [futureSlip], kit.houseCommit(H, 7));
    for (const [what, junk] of [
      ['a stranger\'s abandon', stranger], ['a slip no close froze', carolSlip], ['its seed', strangerSeed], ['a version nobody froze', a1v2],
      ['a close naming nothing', bare], ['a forfeit', forfeit], ['a close of a round that is not on the chain', futureClose],
    ] as const) {
      const res = base(junk);
      expect(res.bytes, `${what} is in the books`).toBe(total + sizeOf(junk));
      expect(res.keptBytes, `${what} is not kept`).toBe(total);
    }
    // junk that is not even a record is weighed (rawBytes), not counted
    const raw = foldAt(putRound1(r1).raw('s:1:alice:deadbeef', { not: 'a slip' }));
    expect(raw.keptBytes).toBe(total);
    expect(raw.bytes).toBe(total);
    expect(raw.rawBytes).toBeGreaterThan(total);
    // none of it together either
    const all = base(stranger, carolSlip, strangerSeed, a1v2, bare, forfeit, futureSlip, futureClose);
    expect(all.keptBytes).toBe(total);
    expect(all.bytes).toBeGreaterThan(total);
  });

  it('counts a rival close and the abandon that voids a round', () => {
    const rival = kit.close(B, 1, SID, [r1.a1, r1.b1], r1.join.rec.c);
    expect(base(rival).keptBytes, 'a valid rival close').toBe(total + sizeOf(rival));
    // a round the bettors voided: the abandon is what decided it, so it is kept; the house reveal is not there
    const a1 = r1.a1;
    const open = kit.close(A, 1, SID, [a1, r1.b1], r1.join.rec.c);
    const abandon = kit.abandon(B, 1, open.hash);
    const voidSession = new TestSession().put(a1, r1.b1, r1.join, open, r1.ra, r1.rb, abandon);
    const res = foldAt(voidSession);
    expect(res.rounds.map((v) => v.decided)).toEqual(['void']);
    expect(res.keptBytes).toBe([a1, r1.b1, r1.join, open, r1.ra, r1.rb, abandon].reduce((n, b) => n + sizeOf(b), 0));
  });

  it('counts the open round\'s felt, its newest version only, and its join and reveal from a house of that round', () => {
    const join = kit.houseJoin(H, 1);
    const v1 = kit.slip(A, 1, [red(2)]);
    const v2 = kit.slip(A, 1, [red(3)], { v: 2 });
    const rogue = kit.houseJoin(ROGUE, 1);
    const open = (...more: Built<unknown>[]) => foldAt(new TestSession().put(...more));
    expect(open(join).keptBytes, 'a house\'s join of the open round').toBe(sizeOf(join));
    expect(open(join, rogue).keptBytes, 'not a stranger\'s').toBe(sizeOf(join));
    expect(open(join, v1).keptBytes).toBe(sizeOf(join) + sizeOf(v1));
    expect(open(join, v1, v2).keptBytes, 'the newest version of the felt').toBe(sizeOf(join) + sizeOf(v2));
    expect(open(join, v1, v2).bytes).toBe(sizeOf(join) + sizeOf(v1) + sizeOf(v2));
  });

  it('counts the open round\'s house reveal while it waits on a seed, if its key is a house of the round', () => {
    // Bob\'s seed is not in, and the reveal lists his slip: it cannot decide the round yet
    const waiting = (...more: Built<unknown>[]) => new TestSession().put(r1.a1, r1.b1, r1.join, r1.close, r1.ra, r1.hr, ...more);
    const held = [r1.a1, r1.b1, r1.join, r1.close, r1.ra, r1.hr].reduce((n, b) => n + sizeOf(b), 0);
    const res = foldAt(waiting());
    expect(res.rounds.map((v) => [v.r, v.decided])).toEqual([[1, null]]);
    expect(res.keptBytes).toBe(held);
    // another key's reveal of the round is in the books and not in what was kept
    const rogue = kit.houseReveal(ROGUE, 1, [r1.close.hash], [r1.a1.hash, r1.b1.hash]);
    const withRogue = foldAt(waiting(rogue));
    expect(withRogue.bytes).toBe(held + sizeOf(rogue));
    expect(withRogue.keptBytes).toBe(held);
  });

  it('counts a house record of the open round only while its key is a house of that round, and its signature holds', () => {
    // (the fold takes any base it is given: this one names no commitment, so the open round 4 takes a join)
    const noCommit = { ...trimOf(P, 'p').value, h: undefined };
    const join = kit.houseJoin(H, 4);
    const forged = { ...join.rec, g: kit.houseJoin(H, 4, hex('4', 64)).rec.g };
    let isHouse = true;
    const houseOk: HouseCheck = (pub, round) => isHouse && pub === H.pub && round === 4;
    const fold = new TableFold(P, sigs.check, undefined, undefined, houseOk);
    fold.setFairOnlyBase(noCommit);
    fold.reset(new TestSession().put(join).records.entries());
    expect(fold.result().keptBytes, 'a house of round 4').toBe(sizeOf(join));
    isHouse = false;
    fold.houseChanged();
    expect(fold.result().keptBytes, 'no longer one').toBe(0);
    expect(fold.result().bytes).toBe(sizeOf(join));
    // a join whose signature fails is in the books, and not in what was kept
    isHouse = true;
    const bad = new TestSession().raw(houseCommitKey(forged) as string, forged);
    const res = foldAt(bad, noCommit, { houseOk });
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.keptBytes).toBe(0);
    expect(res.joins).toEqual([]);
  });

  it('is the weight of the rounds within the cap, none of what lies past it', () => {
    const join = kit.houseJoin(H, 1);
    const long = chain(kit, H, SID, 1, MAX_HELD_ROUNDS + 1, join.rec.c);
    const res = foldAt(new TestSession().put(join, ...long.records));
    const last = long.records.slice(-4);                      // the forty-first round: slip, close, seed, house reveal
    const within = [join, ...long.records.slice(0, -4)].reduce((n, b) => n + sizeOf(b), 0);
    // (the forty-first round is the open one: its slip is the felt on the table, which counts; its close, seed and reveal do not)
    expect(res.keptBytes).toBe(within + sizeOf(last[0]));
    expect(res.bytes).toBe(within + last.reduce((n, b) => n + sizeOf(b), 0));
  });

  it('stays what it was at an ordinary house table: every record, the abandon of a stranger and the slip of a round that is over too', () => {
    const a1 = rkit.slip(A, 1, [red(10)]);
    const join = rkit.houseJoin(H, 1);
    const close = rkit.close(A, 1, 'g', [a1], join.rec.c);
    const records = [a1, join, close, rkit.reveal(1, A.pid)];
    const abandon = rkit.abandon(C, 1, close.hash);
    const at = (...more: Built<unknown>[]) => new TestSession().put(...records, ...more).fold(sigs.check, null, R, onlyH).result();
    const res = at(abandon);
    expect(res.rounds.map((v) => v.decided), 'a stranger\'s abandon voids the round there').toEqual(['void']);
    expect(res.keptBytes).toBe(res.bytes);
    expect(res.keptBytes).toBeGreaterThan(0);
    // (a slip nobody froze, of the round that is over, is in it there, and is not at a FAIR ONLY table)
    const stray = rkit.slip(C, 1, [red(1)]);
    const withStray = at(abandon, stray);
    expect(withStray.keptBytes).toBe(withStray.bytes);
    expect(withStray.keptBytes).toBe(res.keptBytes + sizeOf(stray));
  });
});

// ── Names that Yjs would change ──────────────────────────────────────────────

describe('a record naming a player by an unpaired surrogate is no record of a FAIR ONLY table', () => {
  const bad = 'dave\ud800';
  const fine = 'dave😀';             // a pair is a character
  const dave = testIdentity('dave-bad', bad);

  it('not a slip, not a seed, not a close freezing one', () => {
    const a1 = kit.slip(A, 1, [red(1)]);
    const slip = kit.slip(dave, 1, [red(1)]);
    const seed = kit.reveal(1, bad);
    const close = kit.close(A, 1, SID, { [A.pid]: a1.hash, [bad]: slip.hash });
    const forfeit = kit.forfeit(A, 1, hex('6', 32), [A.pid, bad]);
    for (const [what, rec] of [['slip', slip], ['seed', seed], ['close', close], ['forfeit', forfeit]] as const) {
      const res = foldAt(new TestSession().put(a1, rec));
      expect(res.records, `${what}: only Alice's slip is a record`).toBe(1);
      expect(res.rawBytes, `${what} is weighed`).toBeGreaterThan(res.bytes);
    }
    // (an ordinary table takes the same records)
    const rbad = rkit.slip(dave, 1, [red(1)]);
    expect(new TestSession().put(rbad).fold(sigs.check, null, R, onlyH).result().records).toBe(1);
  });

  it('a pair is a character, and its slip is a slip', () => {
    const fineId = testIdentity('dave-fine', fine);
    const slip = kit.slip(fineId, 1, [red(1)]);
    const res = foldAt(new TestSession().put(slip));
    expect(res.records).toBe(1);
    expect(res.keptBytes).toBe(sizeOf(slip));
  });
});
