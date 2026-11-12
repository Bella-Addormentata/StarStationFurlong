/**
 * 🧪🏠🔒 The simulations' house (computedSimHouse.ts) at a FAIR ONLY game
 * (design §8.5 N1 to N6; PRs 6c-5a-2, 6c-5a-3 and, for the end, 6c-5b-1): what it reads there (the game through
 * its resolution, the fold's rules for a game), when it reveals where a house
 * table's house would not (B2), the checkpoint it signs and the trim it
 * applies, its cross-check, and what it puts back. The house table's rules
 * it shares with a game are held by computedSimHouse.test.ts. And a game
 * that changes hands (N1, PR 6c-5c-2): which rounds are the seller's house's
 * and which the buyer's, and whose checkpoints carry what.
 *
 * The node's house job has no `p`/`q` half yet: this twin is written from the
 * design first, and the node's half is to be held to these rules.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { basisOf, canonFelt } from './computedCraps';
import { ckKey, faironlyInc, readCk, sealCk, sealFin } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { resolveGame } from './computedFairOnlyAuth';
import { authEnv, buyer, delegation, DL_HOUSE, hex, house as H, house2 as H2, NAME, OPENING_CARRY, owner, P, Q, recordsOf, ROOM, rootOf, T, third, trimOf, xferOf } from './computedFairOnlyKit';
import { foldGameOf, MAX_HELD_ROUNDS, nextSid3, recHash, TableFold } from './computedFold';
import type { CloseRec, FoldCtx, FoldResult, SlipRec } from './computedFold';
import { beatKey, delegationKey, HEARTBEAT_MS } from './computedHouse';
import { HOUSE_IDLE_MS, HOUSE_SWEEP_BYTES, HOUSE_SWEEP_KEYS, HOUSE_SWEEP_MIN_MS, HOUSE_TRIM_AFTER_MS, HOUSE_TRIM_ROUNDS, REVEAL_CUTOFF_MS, SETTLE_MS, SimHouse } from './computedSimHouse';
import { ComputedKit, red, testIdentity, trustAll } from './computedTestKit';
import type { Built } from './computedTestKit';

const kit = new ComputedKit(P);
const alice = testIdentity('game-alice', 'alice');
const bob = testIdentity('game-bob', 'bob');
const mallory = testIdentity('game-mallory', 'mallory');
const ROOT = rootOf(P, 'p');
const SID = nextSid3(P, ROOT.value);
const TICK = 200;

/** A room holding the game P (its root and the session the root opens), the
 *  players pinned, and the house named by the root's delegation. */
class GameRoom {
  readonly doc = new Y.Doc();
  house = new SimHouse(H.secret);
  now = 1_000_000;

  constructor(root = ROOT, readonly g: FoldCtx = P) {
    this.doc.transact(() => {
      for (const id of [owner, alice, bob, mallory]) this.doc.getMap('players').set(id.pid, { keyB64: id.pub });
      this.top().set(root.key, root.value);
      this.top().set(`ses:${T}:${this.g.inc}:${nextSid3(this.g, root.value)}`, new Y.Map());
    });
  }

  /** Past the settle after its first read: it has joined round 1. */
  start(): this {
    this.tick(0);
    this.tick(SETTLE_MS);
    return this;
  }

  top(): Y.Map<unknown> {
    return this.doc.getMap('casinoComputed');
  }

  /** The game's checkpoints in the doc, the best first (the highest round). */
  cks(): { key: string; ck: CkRec }[] {
    return [...this.top().entries()].filter(([k]) => k.startsWith(`ck:${T}:${this.g.inc}:`))
      .map(([key, v]) => ({ key, ck: v as CkRec })).sort((a, b) => b.ck.u - a.ck.u);
  }

  base(): CkRec {
    return this.cks()[0].ck;
  }

  sid(): string {
    return nextSid3(this.g, this.base());
  }

  sesKeys(): string[] {
    return [...this.top().keys()].filter((k) => k.startsWith(`ses:${T}:${this.g.inc}:`));
  }

  ses(): Y.Map<unknown> {
    return this.top().get(`ses:${T}:${this.g.inc}:${this.sid()}`) as Y.Map<unknown>;
  }

  put(...recs: Built<unknown>[]): void {
    this.doc.transact(() => {
      for (const r of recs) this.ses().set(r.key, r.rec);
    });
  }

  tick(after: number): void {
    this.now += after;
    this.house.tick(ROOM, this.doc, this.now, 1_700_000_000_000 + this.now);
  }

  /** `ms` on, a tick at a time. */
  run(ms: number, step = TICK): void {
    for (let t = 0; t < ms; t += step) this.tick(step);
  }

  recs(prefix: string): Record<string, unknown>[] {
    return [...this.ses().entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as Record<string, unknown>);
  }

  keys(prefix: string): string[] {
    return [...this.ses().keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Round r closed by alice under parent q on the house's commitment, alice
   *  and bob frozen. */
  closed(r: number, q: string, amount = 5): { c: Built<CloseRec>; a: Built<SlipRec>; b: Built<SlipRec> } {
    const [a, b] = [kit.slip(alice, r, [red(amount)]), kit.slip(bob, r, [red(amount)])];
    const c = kit.close(alice, r, q, [a, b], kit.houseCommit(H, r));
    this.put(a, b, c);
    return { c, a, b };
  }

  /** Round r played whole: closed, both seeds in, and the house's reveal of it (one tick on). */
  played(r: number, q: string): { c: Built<CloseRec>; a: Built<SlipRec>; b: Built<SlipRec>; h: Record<string, unknown> } {
    const out = this.closed(r, q);
    this.put(kit.reveal(r, 'alice'), kit.reveal(r, 'bob'));
    this.tick(TICK);
    const [h] = this.recs(`h:${r}:`);
    expect(h, `the house's reveal of round ${r}`).toBeDefined();
    return { ...out, h };
  }

  /** The live session folded by the pages' fold, as a page that trusts the house would. */
  fold(): FoldResult {
    const tf = new TableFold(this.g, trustAll, undefined, foldGameOf(this.g), (pub) => pub === H.pub || pub === H2.pub);
    tf.setFairOnlyBase(this.base());
    tf.reset([...this.ses().entries()]);
    return tf.result();
  }

  /** Raw junk in the live session, `bytes` of it. */
  junk(bytes: number): void {
    this.doc.transact(() => {
      for (let i = 0; i * 1_000 < bytes; i++) this.ses().set(`junk-${i}`, 'x'.repeat(1_000));
    });
  }
}

/** The game's records in the doc, resolved as a page resolves them. */
const resolved = (room: GameRoom) => resolveGame(authEnv().env, T, P.inc, recordsOf([...room.top().entries()].map(([key, value]) => ({ key, value }))));

describe("the simulations' house at a FAIR ONLY game: whose game, and its rounds", () => {
  it('serves the game whose root delegates it, with no deed holder in the room: once it has settled, and not before, it beats and joins round 1', () => {
    const room = new GameRoom();
    room.tick(0);
    room.tick(SETTLE_MS - TICK);
    expect(room.recs('o:1:')).toHaveLength(0);
    // (Not heard while it settles: a page that hears it closes at once, and a close first read now is never revealed.)
    expect(room.top().has(beatKey(H.pub))).toBe(false);
    room.tick(TICK);
    expect(room.recs('o:1:').map((v) => v.c)).toEqual([kit.houseCommit(H, 1)]);
    expect(room.top().has(beatKey(H.pub))).toBe(true);
    expect(room.house.wrote).toMatchObject({ joins: 1, reveals: 0, beats: 1 });
  });

  it('cut off and settling again, it is not heard until it has settled', () => {
    const room = new GameRoom().start();
    room.run(4_000);
    const beats = room.house.wrote.beats;
    expect(beats).toBeGreaterThanOrEqual(1);
    room.tick(15_000);
    room.run(SETTLE_MS - 2 * TICK);
    expect(room.house.wrote.beats).toBe(beats);
    room.run(2 * TICK);
    expect(room.house.wrote.beats).toBe(beats + 1);
  });

  it("while it settles at another game it serves it is not heard at all (the beat is the room's): a page there would close at once", () => {
    const room = new GameRoom().start();
    // (Its first beat was at the end of the settle: the next is due HEARTBEAT_MS on.)
    room.run(2_000);
    const second = rootOf(Q, 'q');
    const ses = `ses:${T}:${Q.inc}:${nextSid3(Q, second.value)}`;
    room.doc.transact(() => {
      room.top().set(second.key, second.value);
      room.top().set(ses, new Y.Map());
    });
    const beats = room.house.wrote.beats;
    // It first reads the second game a tick on, and has settled there SETTLE_MS after that: past the beat that was due.
    expect(2_000 + TICK + SETTLE_MS).toBeGreaterThan(HEARTBEAT_MS + 2 * TICK);
    room.run(SETTLE_MS);
    expect(room.house.wrote.beats).toBe(beats);
    expect((room.top().get(ses) as Y.Map<unknown>).size).toBe(0);
    room.run(2 * TICK);
    expect(room.house.wrote.beats).toBe(beats + 1);
    expect([...(room.top().get(ses) as Y.Map<unknown>).keys()].filter((k) => k.startsWith('o:1:'))).toHaveLength(1);
  });

  it('a delegation it checked in one room is not checked for another: a root of another room that carries it gets nothing', () => {
    const room = new GameRoom().start();
    expect(room.recs('o:1:')).toHaveLength(1);
    // The same name opened in another room, its root signed for that room, the delegation the first room's.
    const other = 'room-other';
    const ctx: FoldCtx = { room: other, t: T, inc: faironlyInc('p', other, T, NAME) };
    const root = rootOf(ctx, 'p');
    const doc = new Y.Doc();
    const ses = new Y.Map<unknown>();
    doc.transact(() => {
      doc.getMap('casinoComputed').set(root.key, root.value);
      doc.getMap('casinoComputed').set(`ses:${T}:${ctx.inc}:${nextSid3(ctx, root.value)}`, ses);
    });
    for (let t = 0; t <= SETTLE_MS + 2 * TICK; t += TICK) room.house.tick(other, doc, room.now + t, 1_700_000_000_000 + room.now + t);
    expect(ses.size).toBe(0);
    expect(doc.getMap('casinoComputed').has(beatKey(H.pub))).toBe(false);
  });

  it('craps: a frozen slip with no chips on (a take-down) is counted like any other: with its seed gone from the session the roll is not decided, and the next roll waits', () => {
    const kq = new ComputedKit(Q);
    const room = new GameRoom(rootOf(Q, 'q'), Q).start();
    const stamp = (pid: string): string => basisOf(OPENING_CARRY, pid);
    const field = canonFelt([{ type: 'field', amount: 5 }]);
    const a = kq.crapsSlip(alice, 1, [], stamp(alice.pid));
    const b = kq.crapsSlip(bob, 1, field, stamp(bob.pid));
    const c1 = kq.close(bob, 1, room.sid(), [a, b], kq.houseCommit(H, 1));
    const seedA = kq.reveal(1, 'alice');
    room.put(a, b, c1, seedA, kq.reveal(1, 'bob'));
    room.tick(TICK);
    // Its reveal counts both slips.
    expect(room.recs('h:1:').map((v) => v.n)).toEqual([[a.hash, b.hash].sort()]);
    expect(room.fold().rounds.find((v) => v.r === 1)?.decided).toBe('house');
    // Alice's seed is deleted: the pages' fold waits for it, and so does the house.
    room.doc.transact(() => room.ses().delete(seedA.key));
    expect(room.fold().rounds.find((v) => v.r === 1)?.decided ?? null).toBeNull();
    const b2 = kq.crapsSlip(bob, 2, field, stamp(bob.pid));
    room.put(b2, kq.close(bob, 2, c1.hash, [b2], kq.houseCommit(H, 2)), kq.reveal(2, 'bob'));
    room.run(2_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    room.put(seedA);
    room.tick(TICK);
    expect(room.recs('h:2:')).toHaveLength(1);
  });

  it('serves no game whose root names another house, and none of rules it does not know', () => {
    const other = new GameRoom(rootOf(P, 'p', { dl: delegation(owner, H2.pub) }));
    other.start();
    other.run(2_000);
    expect(other.recs('o:')).toHaveLength(0);
    expect(other.top().has(beatKey(H.pub))).toBe(false);
  });

  it('reveals the close that names its join once every seed is in, carrying the next commitment; and the next round on it', () => {
    const room = new GameRoom().start();
    const r1 = room.played(1, SID);
    expect(r1.h).toMatchObject({ x: [r1.c.hash], n: [r1.a.hash, r1.b.hash].sort(), c: kit.houseCommit(H, 2), k: H.pub });
    const r2 = room.played(2, r1.c.hash);
    expect(r2.h).toMatchObject({ x: [r2.c.hash], c: kit.houseCommit(H, 3) });
    // (No join after the first: the reveals carry the commitments.)
    expect(room.house.wrote.joins).toBe(1);
  });

  it("B2: a bettor's abandon of the close, in before the house first sees it, does not hold the house off: it reveals (a house table's house would not)", () => {
    const room = new GameRoom().start();
    const { c } = room.closed(1, SID);
    room.put(kit.abandon(alice, 1, c.hash), kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:1:').map((v) => v.x)).toEqual([[c.hash]]);
    expect(room.house.blockedSeen).toBe(0);
  });

  it('B2: a close of a later round, in beside the close, does not hold the house off either (anyone can write one)', () => {
    const room = new GameRoom().start();
    const { c } = room.closed(1, SID);
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(bob, 2, c.hash, [a2, b2], kit.houseCommit(H, 2)), kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:1:').map((v) => v.x)).toEqual([[c.hash]]);
    expect(room.house.blockedSeen).toBe(0);
  });

  it('…but a close first seen while it settles is never revealed', () => {
    const room = new GameRoom();
    room.tick(0);
    // (A join of its own from a run before, so a close can name its commitment.)
    room.put(kit.houseJoin(H, 1));
    const { c } = room.closed(1, SID);
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    room.run(SETTLE_MS + REVEAL_CUTOFF_MS);
    expect(room.recs('h:1:')).toHaveLength(0);
    expect(room.house.blockedSeen).toBe(1);
    expect(c.rec.h).toBe(kit.houseCommit(H, 1));
  });

  it('cut off for 15 s, it settles again: a close it first reads in the 5 s after is not revealed, one it reads later is', () => {
    const room = new GameRoom().start();
    const r1 = room.played(1, SID);
    room.tick(15_000);
    const blocked = room.closed(2, r1.c.hash);
    room.put(kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.run(SETTLE_MS + 2_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    expect(room.house.blockedSeen).toBe(1);
    // (A rival close of the round, in once it has settled.)
    const later = kit.close(bob, 2, r1.c.hash, [blocked.a, blocked.b], kit.houseCommit(H, 2));
    room.put(later);
    room.tick(TICK);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[later.hash]]);
    // A gap short of that settles nothing again.
    const short = new GameRoom().start();
    const s1 = short.played(1, SID);
    short.tick(14_800);
    short.played(2, s1.c.hash);
  });

  it('a close that names no commitment is junk there: it neither opens the round to the bettors nor stops the house revealing the close that names it', () => {
    const room = new GameRoom().start();
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const friendly = kit.close(bob, 1, SID, [a, b]);
    const fair = kit.close(alice, 1, SID, [a, b], kit.houseCommit(H, 1));
    room.put(a, b, friendly, fair, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:1:').map((v) => v.x)).toEqual([[fair.hash]]);
    expect(room.house.refusals).toBe(0);
  });

  it("a stranger's abandon decides nothing: a close of the next round under the abandoned one is not revealed (the seed would be out for a round no page plays); under a frozen bettor's abandon it is", () => {
    const room = new GameRoom();
    room.tick(0);
    room.put(kit.houseJoin(H, 1));
    // (A close it first read while settling: it will not reveal it, and joins the round after.)
    const { c } = room.closed(1, SID);
    room.tick(TICK);
    room.put(kit.abandon(mallory, 1, c.hash));
    room.run(SETTLE_MS + 2_000);
    expect(room.recs('h:1:')).toHaveLength(0);
    expect(room.recs('o:2:').map((v) => v.c)).toEqual([kit.houseCommit(H, 2)]);
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    const c2 = kit.close(alice, 2, c.hash, [a2, b2], kit.houseCommit(H, 2));
    room.put(a2, b2, c2, kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.run(3_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    room.put(kit.abandon(alice, 1, c.hash));
    room.tick(TICK);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[c2.hash]]);
  });

  it('under an end order it reveals with no next commitment, joins nothing, and neither trims nor sweeps', () => {
    const room = new GameRoom().start();
    const fin = sealFin(P, owner.pub, owner.sign);
    room.doc.transact(() => room.top().set(fin.key, fin.value));
    const { c } = room.closed(1, SID);
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    const [h] = room.recs('h:1:');
    expect(h.x).toEqual([c.hash]);
    expect(h.c).toBeUndefined();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS - 2 * TICK);
    expect(room.recs('o:2:')).toHaveLength(0);
    room.run(HOUSE_IDLE_MS + 2_000, 1_000);
    // (What it signs is the game's end: the specs of the end, below.)
    expect(room.house.trims + room.house.sweeps).toBe(0);
    expect(room.cks().map((x) => x.ck.e)).toEqual([1]);
    // (And before any round: the commitment it joined with is stepped down.)
    const fresh = new GameRoom().start();
    expect(fresh.recs('o:1:')).toHaveLength(1);
    fresh.doc.transact(() => fresh.top().set(fin.key, fin.value));
    fresh.tick(TICK);
    expect(fresh.recs('h:1:').map((v) => v.x)).toEqual([[]]);
    expect(fresh.house.wrote.stepDowns).toBe(1);
  });

  it('a close more than MAX_HELD_ROUNDS past the base is junk: the house reveals round 40 and not round 41', () => {
    const room = new GameRoom().start();
    // (No trim on the way: its cross-check is made to refuse each.)
    room.house.faultTrim = (body) => ({ ...body, u: (body.u as number) + 1 });
    let q = SID;
    for (let r = 1; r <= MAX_HELD_ROUNDS; r++) q = room.played(r, q).c.hash;
    expect(room.house.trims).toBe(0);
    room.closed(MAX_HELD_ROUNDS + 1, q);
    room.put(kit.reveal(MAX_HELD_ROUNDS + 1, 'alice'), kit.reveal(MAX_HELD_ROUNDS + 1, 'bob'));
    room.run(REVEAL_CUTOFF_MS + 2_000, 1_000);
    expect(room.recs(`h:${MAX_HELD_ROUNDS + 1}:`)).toHaveLength(0);
    expect(room.house.crossCheckMismatches).toBeGreaterThan(0);
  });
});

describe("the simulations' house at a FAIR ONLY game: the trim", () => {
  /** Round 1 played, and an open felt of alice's on round 2 (an old version beside it). */
  function oneRound(room = new GameRoom().start()) {
    const r1 = room.played(1, SID);
    const old = kit.slip(alice, 2, [red(1)], { v: 1 });
    const felt = kit.slip(alice, 2, [red(7)], { v: 2 });
    room.put(old, felt);
    return { room, r1, old, felt };
  }

  it('signs the checkpoint the fold gives, and applies it whole: the old session and the root out, the next session in with its copies', () => {
    const { room, r1, old, felt } = oneRound();
    const before = room.fold();
    const D = before.rounds[0];
    expect(D).toMatchObject({ r: 1, decided: 'house', close: r1.c.hash });
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    const cks = room.cks();
    expect(cks).toHaveLength(1);
    const { key, ck } = cks[0];
    expect(readCk(ROOM, key, ck)).toMatchObject({ kind: 'ok' });
    expect(ck).toMatchObject({
      v: 1, ok: ROOT.value.ok, j: ROOT.value.j, rv: ROOT.value.rv, ts: ROOT.value.ts, b: SID, u: 1, l: r1.c.hash,
      d: `h:${recHash(r1.h)}`, o: D.pocket, h: kit.houseCommit(H, 2), dl: DL_HOUSE, k: H.pub,
    });
    expect(Object.keys(ck).sort()).toEqual(['b', 'd', 'dl', 'g', 'h', 'j', 'k', 'l', 'n', 'o', 'ok', 'rv', 'ts', 'u', 'v']);
    expect(ck.n).toEqual(Object.fromEntries([...before.nets].map(([pid, n]) => [pid, n.toString()])));
    expect(Object.keys(ck.n).sort()).toEqual(['alice', 'bob']);
    // As a page resolves the game now: the checkpoint is its base, the house still its house.
    const res = resolved(room);
    expect(res).toMatchObject({ live: true, base: { key }, pending: false });
    expect(res.houseAt(H.pub, 2)).toBe(true);
    // One session: the one the checkpoint opens, holding the open felt as it stood (not its old version),
    // round 1's house reveal and the seeds it counted.
    expect(room.sesKeys()).toEqual([`ses:${T}:${P.inc}:${nextSid3(P, ck)}`]);
    expect([...room.ses().keys()].sort()).toEqual([felt.key, `h:1:${recHash(r1.h)}`, kit.reveal(1, 'alice').key, kit.reveal(1, 'bob').key].sort());
    expect(room.ses().get(felt.key)).toEqual(felt.rec);
    expect(room.ses().has(old.key)).toBe(false);
    // …and the fold of it reads what the fold before it read, from the base on.
    const after = room.fold();
    expect([...after.nets]).toEqual([...before.nets]);
    expect(after).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
    expect([...after.held]).toEqual([['alice', 7n]]);
    // The row it keeps is the record it wrote.
    expect(room.house.rows.get(`${ROOM}|${T}|${P.inc}`)).toEqual({ key, value: ck });
    // Round 2 plays on from it.
    const b2 = kit.slip(bob, 2, [red(5)]);
    const c2 = kit.close(alice, 2, room.sid(), [felt, b2], kit.houseCommit(H, 2));
    room.put(b2, c2, kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[c2.hash]]);
  });

  it('a felt whose seed is out is not copied', () => {
    const { room, felt } = oneRound();
    room.put(kit.reveal(2, 'alice'));
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    expect(room.ses().has(felt.key)).toBe(false);
  });

  it("the trim's numbers are the ones the node's half is told (the specs below scale with them)", () => {
    expect({ HOUSE_TRIM_AFTER_MS, HOUSE_SWEEP_BYTES, HOUSE_TRIM_ROUNDS, HOUSE_IDLE_MS }).toEqual({
      HOUSE_TRIM_AFTER_MS: 2_500, HOUSE_SWEEP_BYTES: 48 * 1024, HOUSE_TRIM_ROUNDS: 20, HOUSE_IDLE_MS: 60_000,
    });
  });

  it('not before HOUSE_TRIM_AFTER_MS from its reveal, and not while a close of the next round is in', () => {
    const { room, r1 } = oneRound();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS - 2 * TICK);
    expect(room.house.trims).toBe(0);
    const { c } = room.closed(2, r1.c.hash);
    room.run(3_000);
    expect(room.house.trims).toBe(0);
    room.put(kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[c.hash]]);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    expect(room.base()).toMatchObject({ u: 2, l: c.hash, h: kit.houseCommit(H, 3) });
  });

  it('with no pressure it leaves the session be; junk just short of SWEEP_BYTES is none, the idle minute is one', () => {
    const { room } = oneRound();
    const raw = (): number => room.fold().rawBytes - room.fold().keptBytes;
    room.junk(HOUSE_SWEEP_BYTES - raw() - 3_000);
    expect(raw()).toBeLessThan(HOUSE_SWEEP_BYTES);
    const at = room.now;
    room.run(HOUSE_IDLE_MS - 2_000, 1_000);
    expect(room.house.trims).toBe(0);
    room.run(4_000, 1_000);
    expect(room.house.trims).toBe(1);
    expect(room.now - at).toBeGreaterThanOrEqual(HOUSE_IDLE_MS);
  });

  it('a long session is pressure: at HOUSE_TRIM_ROUNDS rounds past the base, not one before', () => {
    const room = new GameRoom().start();
    let q = SID;
    for (let r = 1; r < HOUSE_TRIM_ROUNDS; r++) {
      q = room.played(r, q).c.hash;
      room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    }
    expect(room.house.trims).toBe(0);
    const last = room.played(HOUSE_TRIM_ROUNDS, q);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    expect(room.base()).toMatchObject({ u: HOUSE_TRIM_ROUNDS, l: last.c.hash });
  });

  it('waits MISSING_WAIT_MS for a frozen slip that is missing from a decided round', () => {
    const room = new GameRoom().start();
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const c = kit.close(alice, 1, SID, [a, b], kit.houseCommit(H, 1));
    // (Bob's slip never comes: the house reveals at the grace's end, counting alice.)
    room.put(a, c, kit.reveal(1, 'alice'));
    room.run(6_000);
    expect(room.recs('h:1:').map((v) => v.n)).toEqual([[a.hash]]);
    const at = room.now;
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(28_000 - (room.now - at), 1_000);
    expect(room.house.trims).toBe(0);
    room.run(34_000 - (room.now - at), 1_000);
    expect(room.house.trims).toBe(1);
  });

  it("a round a bettor's abandon voided: the checkpoint says so, with no outcome, the nets unmoved", () => {
    const room = new GameRoom();
    room.tick(0);
    room.put(kit.houseJoin(H, 1));
    // (A close it first read while settling: it never reveals it, and alice abandons.)
    const { c } = room.closed(1, SID);
    room.tick(TICK);
    const z = kit.abandon(alice, 1, c.hash);
    room.put(z);
    room.run(SETTLE_MS);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    const ck = room.base();
    expect(ck).toMatchObject({ u: 1, l: c.hash, d: `z:${z.hash}`, n: {} });
    expect(ck.o).toBeUndefined();
    expect(resolved(room)).toMatchObject({ live: true, base: { ck: { u: 1 } } });
  });

  it('the cross-check: a body that disagrees with what the house itself knows of the round is not signed', () => {
    const faults: ((body: Record<string, unknown>) => Record<string, unknown>)[] = [
      (body) => ({ ...body, b: 'f'.repeat(24) }),
      (body) => ({ ...body, u: 2 }),
      (body) => ({ ...body, l: 'e'.repeat(32) }),
      (body) => ({ ...body, d: `h:${'e'.repeat(32)}` }),
      (body) => ({ ...body, h: 'e'.repeat(64) }),
      (body) => ({ ...body, h: undefined }),
      // (Not as a page reads one: an outcome no wheel has.)
      (body) => ({ ...body, o: 37 }),
      // (No base of the game: a round below the one it stands at.)
      (body) => ({ ...body, u: 0, l: '0'.repeat(32), d: undefined, o: undefined, h: undefined, w: 1 }),
    ];
    for (const [i, fault] of faults.entries()) {
      const { room } = oneRound();
      room.house.faultTrim = fault;
      room.junk(HOUSE_SWEEP_BYTES);
      room.run(HOUSE_TRIM_AFTER_MS + 2_400);
      expect(room.house.trims, `fault ${i}`).toBe(0);
      expect(room.house.crossCheckMismatches, `fault ${i}`).toBeGreaterThanOrEqual(1);
      expect(room.cks().map((x) => x.key), `fault ${i}`).toEqual([ROOT.key]);
      expect(room.house.rows.size, `fault ${i}`).toBe(0);
      // …and with the fault gone, it trims.
      room.house.faultTrim = null;
      room.run(1_200);
      expect(room.house.trims, `fault ${i}`).toBe(1);
    }
  });

  it("another house's reveal decided the round: this one signs nothing for it", () => {
    const room = new GameRoom().start();
    room.doc.transact(() => room.top().set(delegationKey(H2.pub), delegation(owner, H2.pub)));
    // Round 1 on the second house's join, revealed by it.
    const j2 = kit.houseJoin(H2, 1);
    room.doc.transact(() => {
      for (const k of room.keys('o:1:')) room.ses().delete(k);
    });
    room.house.steppingDown = true;
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const c = kit.close(alice, 1, SID, [a, b], kit.houseCommit(H2, 1));
    room.put(j2, a, b, c, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'), kit.houseReveal(H2, 1, [c.hash], [a.hash, b.hash]));
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + HOUSE_IDLE_MS, 1_000);
    expect(room.fold().rounds[0]).toMatchObject({ decided: 'house' });
    expect(room.house.trims).toBe(0);
  });
});

describe("the simulations' house at a FAIR ONLY game: the sweep (N3s)", () => {
  /** A game with nothing decided: the house's join of round 1 in, and alice's open felt (an old version beside it). */
  function fresh() {
    const room = new GameRoom().start();
    const old = kit.slip(alice, 1, [red(1)], { v: 1 });
    const felt = kit.slip(alice, 1, [red(7)], { v: 2 });
    room.put(old, felt);
    const [join] = room.keys('o:1:');
    expect(join).toBeDefined();
    return { room, old, felt, join };
  }
  /** Round 1 played and trimmed to, nothing decided since. */
  function trimmed() {
    const room = new GameRoom().start();
    const r1 = room.played(1, SID);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    const { key, ck } = room.cks()[0];
    return { room, r1, key, ck };
  }

  it("the sweep's numbers are the ones the node's half is told", () => {
    expect({ HOUSE_SWEEP_BYTES, HOUSE_SWEEP_KEYS, HOUSE_SWEEP_MIN_MS }).toEqual({ HOUSE_SWEEP_BYTES: 48 * 1024, HOUSE_SWEEP_KEYS: 2_048, HOUSE_SWEEP_MIN_MS: 10_000 });
  });

  it("junk in a session with nothing decided: it signs the root's content again, one sweep on, and the session it opens holds the open felt and its join and no junk", () => {
    const { room, old, felt, join } = fresh();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(1_200);
    expect(room.house).toMatchObject({ sweeps: 1, trims: 0, crossCheckMismatches: 0 });
    const cks = room.cks();
    expect(cks).toHaveLength(1);
    const { key, ck } = cks[0];
    expect(readCk(ROOM, key, ck)).toMatchObject({ kind: 'ok' });
    const { g: _g, b: _b, k: _k, dl: _dl, ...rootContent } = ROOT.value;
    expect(ck).toMatchObject({ ...rootContent, b: SID, w: 1, u: 0, n: {}, dl: DL_HOUSE, k: H.pub });
    expect(Object.keys(ck).sort()).toEqual(['b', 'dl', 'g', 'j', 'k', 'l', 'n', 'ok', 'rv', 'ts', 'u', 'v', 'w']);
    const res = resolved(room);
    expect(res).toMatchObject({ live: true, base: { key }, pending: false });
    expect(res.houseAt(H.pub, 1)).toBe(true);
    expect(room.sesKeys()).toEqual([`ses:${T}:${P.inc}:${nextSid3(P, ck)}`]);
    expect(nextSid3(P, ck)).not.toBe(SID);
    expect([...room.ses().keys()].sort()).toEqual([felt.key, join].sort());
    expect(room.ses().has(old.key)).toBe(false);
    expect(room.house.rows.get(`${ROOM}|${T}|${P.inc}`)).toEqual({ key, value: ck });
    // Round 1 plays on from it, on the join it carried: no second join.
    room.run(2_000);
    expect(room.keys('o:1:')).toEqual([join]);
    const b1 = kit.slip(bob, 1, [red(5)]);
    const c1 = kit.close(alice, 1, room.sid(), [felt, b1], kit.houseCommit(H, 1));
    room.put(b1, c1, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:1:').map((v) => v.x)).toEqual([[c1.hash]]);
  });

  it('after a trim: the checkpoint again, one sweep on, with its nets, its outcome and the commitment it carried; round u\'s decider and seeds go with it, and the next round plays', () => {
    const { room, r1, key, ck } = trimmed();
    const carried = [...room.ses().keys()].sort();
    expect(carried).toEqual([`h:1:${recHash(r1.h)}`, kit.reveal(1, 'alice').key, kit.reveal(1, 'bob').key].sort());
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(1_200);
    expect(room.house).toMatchObject({ sweeps: 1, trims: 1, crossCheckMismatches: 0 });
    const [swept] = room.cks();
    expect(room.cks()).toHaveLength(1);
    expect(swept.key).not.toBe(key);
    const { g: _g, ...content } = ck;
    expect(swept.ck).toMatchObject({ ...content, b: nextSid3(P, ck), w: 1 });
    expect(Object.keys(swept.ck).sort()).toEqual([...Object.keys(ck), 'w'].sort());
    expect(resolved(room)).toMatchObject({ live: true, base: { key: swept.key } });
    expect([...room.ses().keys()].sort()).toEqual(carried);
    expect(room.fold()).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
    // …and a second sweep carries them on again.
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_SWEEP_MIN_MS + 1_200, 1_000);
    expect(room.house.sweeps).toBe(2);
    expect(room.base()).toMatchObject({ u: 1, w: 2, h: kit.houseCommit(H, 2) });
    expect([...room.ses().keys()].sort()).toEqual(carried);
    const { c } = room.closed(2, room.sid());
    room.put(kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[c.hash]]);
  });

  it("junk a peer wrote over a carried seed is not carried: the sweep leaves it behind, and no sweep follows for it", () => {
    const { room, r1 } = trimmed();
    const seed = kit.reveal(1, 'bob').key;
    room.doc.transact(() => room.ses().set(seed, 'x'.repeat(HOUSE_SWEEP_BYTES)));
    room.run(1_200);
    expect(room.house.sweeps).toBe(1);
    expect([...room.ses().keys()].sort()).toEqual([`h:1:${recHash(r1.h)}`, kit.reveal(1, 'alice').key].sort());
    room.run(HOUSE_SWEEP_MIN_MS + 2_400, 1_000);
    expect(room.house.sweeps).toBe(1);
  });

  it("what is carried is no junk by its weight: junk short of SWEEP_BYTES without round u's records is left, a little more is swept", () => {
    const { room } = trimmed();
    const raw = (): number => room.fold().rawBytes - room.fold().keptBytes;
    const carried = raw();
    expect(carried).toBeGreaterThan(500);
    // (A junk key of 1,000 characters weighs 1,000 and its key and quotes.)
    room.doc.transact(() => {
      for (let i = 0; raw() + 1_100 < HOUSE_SWEEP_BYTES + carried - 100; i++) room.ses().set(`junk-${i}`, 'x'.repeat(1_000));
    });
    room.doc.transact(() => room.ses().set('fill', 'x'.repeat(HOUSE_SWEEP_BYTES + carried - 100 - raw() - 6)));
    expect(raw()).toBeGreaterThanOrEqual(HOUSE_SWEEP_BYTES);
    expect(raw() - carried).toBeLessThan(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_SWEEP_MIN_MS + 2_400, 1_000);
    expect(room.house.sweeps).toBe(0);
    room.doc.transact(() => room.ses().set('more', 'x'.repeat(200)));
    expect(raw() - carried).toBeGreaterThanOrEqual(HOUSE_SWEEP_BYTES);
    room.run(1_200);
    expect(room.house.sweeps).toBe(1);
  });

  it('a carried seed written over is one junk key more: with it HOUSE_SWEEP_KEYS are swept, one fewer are not', () => {
    const { room, r1 } = trimmed();
    const seed = kit.reveal(1, 'bob').key;
    room.doc.transact(() => {
      room.ses().set(seed, 0);
      for (let i = 0; i < HOUSE_SWEEP_KEYS - 2; i++) room.ses().set(`a${i}`, 0);
    });
    expect(room.fold().rawBytes - room.fold().keptBytes).toBeLessThan(HOUSE_SWEEP_BYTES);
    room.run(2_400);
    expect(room.house.sweeps).toBe(0);
    room.doc.transact(() => room.ses().set('b', 0));
    room.run(1_200);
    expect(room.house.sweeps).toBe(1);
    expect([...room.ses().keys()].filter((k) => !k.startsWith('o:')).sort()).toEqual([`h:1:${recHash(r1.h)}`, kit.reveal(1, 'alice').key].sort());
  });

  it('a house that restarted since the trim carries the decider on, and not what else lies under round u', () => {
    const { room, r1 } = trimmed();
    room.house.restart();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(SETTLE_MS + 1_200);
    expect(room.house.sweeps).toBe(1);
    expect([...room.ses().keys()].filter((k) => !k.startsWith('o:'))).toEqual([`h:1:${recHash(r1.h)}`]);
  });

  it('at most one per HOUSE_SWEEP_MIN_MS: junk again at once waits, and the second is two sweeps on', () => {
    const { room } = fresh();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(1_200);
    expect(room.house.sweeps).toBe(1);
    const at = room.now;
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_SWEEP_MIN_MS - 2_400);
    expect(room.house.sweeps).toBe(1);
    room.run(2_400);
    expect(room.house.sweeps).toBe(2);
    expect(room.now - at).toBeGreaterThanOrEqual(HOUSE_SWEEP_MIN_MS - 1_200);
    expect(room.base()).toMatchObject({ u: 0, w: 2 });
    expect(room.cks()).toHaveLength(1);
    expect(resolved(room)).toMatchObject({ live: true, base: { key: room.cks()[0].key } });
  });

  it('junk just short of SWEEP_BYTES is left, however long; and a session idle with nothing decided is not swept', () => {
    const { room } = fresh();
    const raw = (): number => room.fold().rawBytes - room.fold().keptBytes;
    room.junk(HOUSE_SWEEP_BYTES - raw() - 3_000);
    expect(raw()).toBeLessThan(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_IDLE_MS + 5_000, 1_000);
    expect(room.house).toMatchObject({ sweeps: 0, trims: 0 });
    room.doc.transact(() => {
      for (let i = 0; i < 4; i++) room.ses().set(`more-${i}`, 'x'.repeat(1_000));
    });
    expect(raw()).toBeGreaterThanOrEqual(HOUSE_SWEEP_BYTES);
    room.run(1_200);
    expect(room.house.sweeps).toBe(1);
  });

  it('keys of nothing: HOUSE_SWEEP_KEYS of them are swept though they weigh little, one fewer are not', () => {
    const { room } = fresh();
    const keys = (n: number, tag: string): void => room.doc.transact(() => {
      for (let i = 0; i < n; i++) room.ses().set(`${tag}${i}`, 0);
    });
    // (The old felt is junk too: one key.)
    keys(HOUSE_SWEEP_KEYS - 2, 'a');
    expect(room.fold().rawBytes - room.fold().keptBytes).toBeLessThan(HOUSE_SWEEP_BYTES);
    room.run(2_400);
    expect(room.house.sweeps).toBe(0);
    keys(1, 'b');
    room.run(1_200);
    expect(room.house.sweeps).toBe(1);
  });

  it('not while a close of the open round is in: then the round is decided, and the trim sweeps', () => {
    const { room } = fresh();
    const b1 = kit.slip(bob, 1, [red(5)]);
    const a1 = kit.slip(alice, 1, [red(7)], { v: 2 });
    const c1 = kit.close(alice, 1, SID, [a1, b1], kit.houseCommit(H, 1));
    room.put(b1, c1);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(3_000);
    expect(room.house).toMatchObject({ sweeps: 0, trims: 0 });
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.run(HOUSE_TRIM_AFTER_MS + 1_400);
    expect(room.house).toMatchObject({ sweeps: 0, trims: 1 });
    expect(room.base()).toMatchObject({ u: 1, l: c1.hash });
    expect(room.base().w).toBeUndefined();
  });

  it("the closer deletes the frozen slip the house's reveal counted and lays junk in: the session reads as one with nothing decided, and is not swept for MISSING_WAIT_MS (a sweep would void the round for good); the slip back, the round is trimmed to", () => {
    const room = new GameRoom().start();
    const r1 = room.played(1, SID);
    expect(room.fold().rounds.filter((v) => v.decided).map((v) => v.r)).toEqual([1]);
    room.doc.transact(() => room.ses().delete(r1.a.key));
    // (Off the chain: no decided round, no close in.)
    const short = room.fold();
    expect(short.rounds.filter((v) => v.decided)).toEqual([]);
    expect(short.tip).toBeNull();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(28_000, 1_000);
    expect(room.house.sweeps + room.house.trims).toBe(0);
    expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
    // A witness puts it back: the round is decided again, and the junk presses its trim.
    room.put(r1.a);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.sweeps).toBe(0);
    expect(room.house.trims).toBe(1);
    expect(room.base()).toMatchObject({ u: 1, l: r1.c.hash, d: `h:${recHash(r1.h)}` });
    expect(Object.keys(room.base().n).sort()).toEqual(['alice', 'bob']);
  });

  it('…and if nobody puts it back in MISSING_WAIT_MS nobody is left who can: the junked session is swept', () => {
    const room = new GameRoom().start();
    const r1 = room.played(1, SID);
    room.doc.transact(() => room.ses().delete(r1.a.key));
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(29_000, 1_000);
    expect(room.house.sweeps).toBe(0);
    room.run(3_000, 1_000);
    expect(room.house.sweeps).toBe(1);
    expect(room.base()).toMatchObject({ u: 0, w: 1 });
  });

  it('the cross-check: a sweep that does not hold what the base holds is not signed', () => {
    const faults: ((body: Record<string, unknown>) => Record<string, unknown>)[] = [
      (body) => ({ ...body, b: 'f'.repeat(24) }),
      (body) => ({ ...body, w: 2 }),
      (body) => ({ ...body, w: undefined }),
      (body) => ({ ...body, n: { alice: '1000' } }),
      (body) => ({ ...body, o: 5 }),
      (body) => ({ ...body, h: 'e'.repeat(64) }),
      (body) => ({ ...body, u: 2 }),
      (body) => ({ ...body, k: H2.pub }),
    ];
    for (const [i, fault] of faults.entries()) {
      const { room, key } = trimmed();
      room.house.faultTrim = fault;
      room.junk(HOUSE_SWEEP_BYTES);
      room.run(2_400);
      expect(room.house.sweeps, `fault ${i}`).toBe(0);
      expect(room.house.crossCheckMismatches, `fault ${i}`).toBeGreaterThanOrEqual(1);
      expect(room.cks().map((x) => x.key), `fault ${i}`).toEqual([key]);
      room.house.faultTrim = null;
      room.run(1_200);
      expect(room.house.sweeps, `fault ${i}`).toBe(1);
    }
  });
});

describe("the simulations' house at a FAIR ONLY game: the end (N6)", () => {
  const FIN = sealFin(P, owner.pub, owner.sign);
  const order = (room: GameRoom): void => room.doc.transact(() => { room.top().set(FIN.key, FIN.value); });
  /** Round 1 closed and revealed under the end order (no next commitment). */
  function lastRound(room = new GameRoom().start()) {
    order(room);
    const r1 = room.played(1, SID);
    expect(r1.h.c).toBeUndefined();
    return { room, r1 };
  }
  /** The holder's own end of the game at the root's round, as its page signs one. */
  const ownEnd = (b = SID) => sealCk(P, {
    v: 1, ok: ROOT.value.ok, j: ROOT.value.j, rv: ROOT.value.rv, ts: ROOT.value.ts, b, u: 0, l: ROOT.value.l, n: {}, e: 1, f: FIN.value, k: owner.pub,
  }, owner.sign);

  it('after its last reveal: an ended checkpoint at that round with the fold\'s nets and the order in it, applied whole: every session and the root out, no session in', () => {
    const { room, r1 } = lastRound();
    const felt = kit.slip(alice, 2, [red(7)]);
    room.put(felt);
    const before = room.fold();
    const D = before.rounds[0];
    expect(D).toMatchObject({ r: 1, decided: 'house', close: r1.c.hash });
    // Not before HOUSE_TRIM_AFTER_MS from the reveal (the pages' show of the round).
    room.run(HOUSE_TRIM_AFTER_MS - 2 * TICK);
    expect(room.house.ends).toBe(0);
    expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
    room.run(1_200 + 2 * TICK);
    expect(room.house.ends).toBe(1);
    expect(room.house.trims + room.house.sweeps).toBe(0);
    const cks = room.cks();
    expect(cks).toHaveLength(1);
    const { key, ck } = cks[0];
    expect(readCk(ROOM, key, ck)).toMatchObject({ kind: 'ok' });
    expect(ck).toMatchObject({
      v: 1, ok: ROOT.value.ok, j: ROOT.value.j, rv: ROOT.value.rv, ts: ROOT.value.ts, b: SID, u: 1, l: r1.c.hash,
      d: `h:${recHash(r1.h)}`, o: D.pocket, e: 1, f: FIN.value, dl: DL_HOUSE, k: H.pub,
    });
    // (No carry, no commitment, no sweep count: an end hands nothing on.)
    expect(Object.keys(ck).sort()).toEqual(['b', 'd', 'dl', 'e', 'f', 'g', 'j', 'k', 'l', 'n', 'o', 'ok', 'rv', 'ts', 'u', 'v']);
    expect(ck.n).toEqual(Object.fromEntries([...before.nets].map(([pid, n]) => [pid, n.toString()])));
    expect(Object.keys(ck.n).sort()).toEqual(['alice', 'bob']);
    // As a page resolves the game now: over, from that checkpoint.
    expect(resolved(room)).toMatchObject({ live: false, base: { key }, pending: false });
    expect(room.sesKeys()).toEqual([]);
    // (Nothing else either: the room's map holds the end, the order, the house's delegation and its beat.)
    expect([...room.top().keys()].map((k) => k.slice(0, k.indexOf(':'))).sort()).toEqual(['ck', 'fin', 'hb', 'hk']);
    expect(room.house.rows.get(`${ROOM}|${T}|${P.inc}`)).toEqual({ key, value: ck });
    // …and it writes nothing more at the game.
    const top = [...room.top().keys()].filter((k) => !k.startsWith('hb:')).sort();
    const { joins, reveals, stepDowns } = room.house.wrote;
    room.run(HOUSE_IDLE_MS + 5_000, 1_000);
    expect([...room.top().keys()].filter((k) => !k.startsWith('hb:')).sort()).toEqual(top);
    expect(room.house.wrote).toMatchObject({ joins, reveals, stepDowns });
    expect(room.house.ends).toBe(1);
  });

  it('with no round decided since the base: at the base\'s round with its close, at once after its step-down', () => {
    const room = new GameRoom().start();
    const felt = kit.slip(alice, 1, [red(7)]);
    room.put(felt);
    order(room);
    room.tick(TICK);
    expect(room.house.wrote.stepDowns).toBe(1);
    expect(room.house.ends).toBe(0);
    room.run(1_200);
    expect(room.house.ends).toBe(1);
    const [{ key, ck }] = room.cks();
    expect(room.cks()).toHaveLength(1);
    expect(ck).toMatchObject({ b: SID, u: 0, l: ROOT.value.l, n: {}, e: 1, f: FIN.value, dl: DL_HOUSE, k: H.pub });
    expect(Object.keys(ck).sort()).toEqual(['b', 'dl', 'e', 'f', 'g', 'j', 'k', 'l', 'n', 'ok', 'rv', 'ts', 'u', 'v']);
    expect(resolved(room)).toMatchObject({ live: false, base: { key }, pending: false });
    expect(room.sesKeys()).toEqual([]);
  });

  it('not while a close of the open round is in: it reveals it first, and the end counts the round', () => {
    const room = new GameRoom().start();
    const { c } = room.closed(1, SID);
    order(room);
    // (The seeds are slow: the close stands undecided past the house's wait and the idle minute.)
    room.run(4_000, 1_000);
    expect(room.house.ends).toBe(0);
    expect(room.recs('h:1:')).toHaveLength(0);
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:1:').map((v) => [v.x, v.c])).toEqual([[[c.hash], undefined]]);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.ends).toBe(1);
    expect(room.base()).toMatchObject({ u: 1, l: c.hash, e: 1 });
  });

  it('a close of the next round, which no commitment stands for, holds nothing: anyone can write one', () => {
    const { room, r1 } = lastRound();
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, r1.c.hash, [a2, b2], kit.houseCommit(H, 2)), kit.close(mallory, 2, r1.c.hash, [a2, b2]));
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.ends).toBe(1);
    expect(room.base()).toMatchObject({ u: 1, l: r1.c.hash, e: 1 });
    expect(room.house.wrote.reveals).toBe(1);
  });

  it("a round a bettor's abandon voided: the end says so, with no outcome, the nets unmoved", () => {
    const room = new GameRoom();
    room.tick(0);
    room.put(kit.houseJoin(H, 1));
    // (A close it first read while settling: it never reveals it, and alice abandons.)
    const { c } = room.closed(1, SID);
    room.tick(TICK);
    order(room);
    room.run(SETTLE_MS);
    expect(room.house.ends).toBe(0);
    const z = kit.abandon(alice, 1, c.hash);
    room.put(z);
    // (The wait runs from the fold that first read the round void, a second at most after the abandon.)
    room.run(HOUSE_TRIM_AFTER_MS);
    expect(room.house.ends).toBe(0);
    room.run(2_400);
    expect(room.house.ends).toBe(1);
    const ck = room.base();
    expect(ck).toMatchObject({ u: 1, l: c.hash, d: `z:${z.hash}`, n: {}, e: 1 });
    expect(ck.o).toBeUndefined();
    expect(resolved(room)).toMatchObject({ live: false, base: { ck: { u: 1 } } });
  });

  it('waits MISSING_WAIT_MS for a frozen slip that is missing from a decided round', () => {
    const room = new GameRoom().start();
    order(room);
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const c = kit.close(alice, 1, SID, [a, b], kit.houseCommit(H, 1));
    room.put(a, c, kit.reveal(1, 'alice'));
    room.run(6_000);
    expect(room.recs('h:1:').map((v) => v.n)).toEqual([[a.hash]]);
    const at = room.now;
    room.run(28_000 - (room.now - at), 1_000);
    expect(room.house.ends).toBe(0);
    room.run(34_000 - (room.now - at), 1_000);
    expect(room.house.ends).toBe(1);
  });

  it('the cross-check: an end that disagrees with what the house itself knows of the round, or hands something on, is not signed', () => {
    const faults: ((body: Record<string, unknown>) => Record<string, unknown>)[] = [
      (body) => ({ ...body, b: 'f'.repeat(24) }),
      (body) => ({ ...body, u: 2 }),
      (body) => ({ ...body, l: 'e'.repeat(32) }),
      (body) => ({ ...body, d: `h:${'e'.repeat(32)}` }),
      (body) => ({ ...body, h: kit.houseCommit(H, 2) }),
      (body) => ({ ...body, w: 1 }),
      (body) => ({ ...body, s: OPENING_CARRY }),
      // (Not as a page reads one: an end with no order in it, an outcome no wheel has.)
      (body) => ({ ...body, f: undefined }),
      (body) => ({ ...body, o: 37 }),
      // (No base of the game: an end below the round it stands at... which the root, at that round, does not outrank,
      // but its own knowledge of round 1 does not agree with.)
      (body) => ({ ...body, u: 0, l: ROOT.value.l, d: undefined, o: undefined }),
    ];
    for (const [i, fault] of faults.entries()) {
      const { room } = lastRound();
      room.house.faultTrim = fault;
      room.run(HOUSE_TRIM_AFTER_MS + 2_400);
      expect(room.house.ends, `fault ${i}`).toBe(0);
      expect(room.house.crossCheckMismatches, `fault ${i}`).toBeGreaterThanOrEqual(1);
      expect(room.cks().map((x) => x.key), `fault ${i}`).toEqual([ROOT.key]);
      expect(room.house.rows.size, `fault ${i}`).toBe(0);
      room.house.faultTrim = null;
      room.run(1_200);
      expect(room.house.ends, `fault ${i}`).toBe(1);
    }
  });

  for (const ending of [false, true]) {
    it(`a wait that began for one loss does not stand in for the next${ending ? ', at a game ending' : ''}: the slip back with a close of the next round in, then both gone again half a minute on, the session is not ${ending ? 'ended' : 'swept'} for MISSING_WAIT_MS more`, () => {
      const room = new GameRoom().start();
      const r1 = room.played(1, SID);
      room.doc.transact(() => room.ses().delete(r1.a.key));
      room.run(2_000, 1_000);
      // Back, and round 2 closed on the commitment the reveal carried: a close in, nothing swept or ended.
      room.put(r1.a);
      const r2 = room.closed(2, r1.c.hash);
      if (ending) order(room);
      expect(room.fold().tip).toMatchObject({ r: 2 });
      room.tick(1_000);
      // Both gone before its next look, 29 s on: the first wait would have run out.
      room.doc.transact(() => {
        for (const k of [r2.c.key, r2.a.key, r2.b.key, r1.a.key]) room.ses().delete(k);
      });
      if (!ending) room.junk(HOUSE_SWEEP_BYTES);
      expect(room.fold()).toMatchObject({ tip: null, openCloses: [{ state: 'invalid' }] });
      expect(room.fold().rounds.filter((v) => v.decided)).toEqual([]);
      room.tick(29_000);
      room.run(27_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
      room.run(5_000, 1_000);
      expect({ sweeps: room.house.sweeps, ends: room.house.ends }).toEqual(ending ? { sweeps: 0, ends: 1 } : { sweeps: 1, ends: 0 });
    });
  }

  for (const ending of [false, true]) {
    it(`another bettor's slip gone, back with a close of the next round in, and gone again half a minute on: the session is not ${ending ? 'ended' : 'trimmed'} without them for MISSING_WAIT_MS more`, () => {
      const room = new GameRoom().start();
      const r1 = room.played(1, SID);
      room.doc.transact(() => room.ses().delete(r1.b.key));
      expect(room.fold().rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', missing: ['bob'] });
      room.run(HOUSE_TRIM_AFTER_MS + 1_000, 1_000);
      room.put(r1.b);
      const r2 = room.closed(2, r1.c.hash);
      if (ending) order(room);
      room.tick(1_000);
      room.doc.transact(() => {
        for (const k of [r2.c.key, r2.a.key, r2.b.key, r1.b.key]) room.ses().delete(k);
      });
      if (!ending) room.junk(HOUSE_SWEEP_BYTES);
      expect(room.fold()).toMatchObject({ tip: null });
      expect(room.fold().rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', missing: ['bob'] });
      room.tick(29_000);
      room.run(27_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      room.run(5_000, 1_000);
      expect({ trims: room.house.trims, ends: room.house.ends }).toEqual(ending ? { trims: 0, ends: 1 } : { trims: 1, ends: 0 });
      expect(Object.keys(room.base().n)).toEqual(['alice']);
    });
  }

  for (const ending of [false, true]) {
    it(`one bettor's slip back as another's goes, the first wait all but run out: the session is not ${ending ? 'ended' : 'trimmed'} without the second for MISSING_WAIT_MS of its own`, () => {
      const room = new GameRoom().start();
      if (ending) order(room);
      const [a, b, m] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)]), kit.slip(mallory, 1, [red(5)])];
      const c = kit.close(alice, 1, SID, [a, b, m], kit.houseCommit(H, 1));
      room.put(a, b, m, c, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'), kit.reveal(1, 'mallory'));
      room.tick(TICK);
      expect(room.fold().rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', missing: [] });
      room.doc.transact(() => room.ses().delete(b.key));
      if (!ending) room.junk(HOUSE_SWEEP_BYTES);
      room.run(29_000, 1_000);
      room.doc.transact(() => {
        room.ses().set(b.key, b.rec);
        room.ses().delete(m.key);
      });
      expect(room.fold().rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', missing: ['mallory'] });
      room.run(28_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      room.run(5_000, 1_000);
      expect({ trims: room.house.trims, ends: room.house.ends }).toEqual(ending ? { trims: 0, ends: 1 } : { trims: 1, ends: 0 });
      expect(Object.keys(room.base().n).sort()).toEqual(['alice', 'bob']);
    });

    it(`a slip missing, the round off the chain and back with the slip still missing, the first wait all but run out: the session is not ${ending ? 'ended' : 'trimmed'} without it for MISSING_WAIT_MS more`, () => {
      const room = new GameRoom().start();
      if (ending) order(room);
      const r1 = room.played(1, SID);
      room.doc.transact(() => room.ses().delete(r1.b.key));
      if (!ending) room.junk(HOUSE_SWEEP_BYTES);
      room.run(2_000, 1_000);
      room.doc.transact(() => room.ses().delete(r1.a.key));
      expect(room.fold().rounds.filter((v) => v.decided)).toEqual([]);
      room.run(27_000, 1_000);
      room.put(r1.a);
      expect(room.fold().rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', missing: ['bob'] });
      room.run(28_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      room.run(5_000, 1_000);
      expect({ trims: room.house.trims, ends: room.house.ends }).toEqual(ending ? { trims: 0, ends: 1 } : { trims: 1, ends: 0 });
      expect(Object.keys(room.base().n)).toEqual(['alice']);
    });
  }

  for (const ending of [false, true]) {
    it(`a slip back and gone again while the doc holds part of an update, the first wait all but run out: the session is not ${ending ? 'ended' : 'trimmed'} without it for MISSING_WAIT_MS more`, () => {
      const room = new GameRoom().start();
      const r1 = room.played(1, SID);
      room.doc.transact(() => room.ses().delete(r1.b.key));
      if (ending) order(room);
      else room.junk(HOUSE_SWEEP_BYTES);
      room.run(28_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      // (The second of two updates alone: the doc parks it until the first comes.)
      const other = new Y.Doc();
      const ups: Uint8Array[] = [];
      other.on('update', (u: Uint8Array) => ups.push(u));
      other.transact(() => other.getMap('scratch').set('a', 1));
      other.transact(() => other.getMap('scratch').set('b', 2));
      Y.applyUpdate(room.doc, ups[1]);
      room.put(r1.b);
      room.run(2_000, 1_000);
      room.doc.transact(() => room.ses().delete(r1.b.key));
      Y.applyUpdate(room.doc, ups[0]);
      expect(room.fold().rounds.find((v) => v.r === 1)).toMatchObject({ decided: 'house', missing: ['bob'] });
      room.run(27_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      room.run(6_000, 1_000);
      expect({ trims: room.house.trims, ends: room.house.ends }).toEqual(ending ? { trims: 0, ends: 1 } : { trims: 1, ends: 0 });
      expect(Object.keys(room.base().n)).toEqual(['alice']);
    });
  }

  it('no checkpoint from a doc that holds part of an update: no trim, no sweep and no end until the rest is in', () => {
    // (The second of two updates alone: the doc parks it until the first comes.)
    const park = (room: GameRoom): (() => void) => {
      const other = new Y.Doc();
      const ups: Uint8Array[] = [];
      other.on('update', (u: Uint8Array) => ups.push(u));
      other.transact(() => other.getMap('scratch').set('a', 1));
      other.transact(() => other.getMap('scratch').set('b', 2));
      Y.applyUpdate(room.doc, ups[1]);
      return () => Y.applyUpdate(room.doc, ups[0]);
    };
    // An end.
    const { room } = lastRound();
    const rest = park(room);
    room.run(HOUSE_TRIM_AFTER_MS + 10_000, 1_000);
    expect(room.house.ends).toBe(0);
    rest();
    room.run(2_000, 1_000);
    expect(room.house.ends).toBe(1);
    // A trim (a session idle for HOUSE_IDLE_MS).
    const idle = new GameRoom().start();
    idle.played(1, SID);
    const restIdle = park(idle);
    idle.run(HOUSE_IDLE_MS + 10_000, 1_000);
    expect(idle.house.trims).toBe(0);
    restIdle();
    idle.run(2_000, 1_000);
    expect(idle.house.trims).toBe(1);
    // A sweep.
    const junked = new GameRoom().start();
    const restJunk = park(junked);
    junked.junk(HOUSE_SWEEP_BYTES);
    junked.run(HOUSE_SWEEP_MIN_MS + 5_000, 1_000);
    expect(junked.house.sweeps).toBe(0);
    restJunk();
    junked.run(2_000, 1_000);
    expect(junked.house.sweeps).toBe(1);
  });

  for (const ending of [false, true]) {
    it(`the closer deletes the frozen slip and lays another close of the round in, voided by their own abandon: the round reads decided, but not as this house decided it, and the session is not ${ending ? 'ended' : 'trimmed'} on it for MISSING_WAIT_MS; the slip back, its own round stands`, () => {
      const room = new GameRoom().start();
      if (ending) order(room);
      const r1 = room.played(1, SID);
      room.doc.transact(() => room.ses().delete(r1.a.key));
      const a2 = kit.slip(alice, 1, [red(9)]);
      const c2 = kit.close(alice, 1, SID, [a2], kit.houseCommit(H, 1));
      room.put(a2, c2, kit.abandon(alice, 1, c2.hash));
      const swapped = room.fold();
      expect(swapped.rounds.find((v) => v.r === 1)).toMatchObject({ close: c2.hash, decided: 'void' });
      if (!ending) room.junk(HOUSE_SWEEP_BYTES);
      room.run(28_000, 1_000);
      expect(room.house.sweeps + room.house.trims + room.house.ends).toBe(0);
      room.put(r1.a);
      room.run(HOUSE_TRIM_AFTER_MS + 2_000, 1_000);
      expect({ trims: room.house.trims, ends: room.house.ends }).toEqual(ending ? { trims: 0, ends: 1 } : { trims: 1, ends: 0 });
      expect(room.base()).toMatchObject({ u: 1, l: r1.c.hash, d: `h:${recHash(r1.h)}` });
      expect(Object.keys(room.base().n).sort()).toEqual(['alice', 'bob']);
    });
  }

  it("the closer deletes the frozen slip its last reveal counted (another bettor's is a slip missing, waited for as a trim waits): the game is not ended at the base's round, without the round, for MISSING_WAIT_MS; the slip back, the end counts the round", () => {
    const { room, r1 } = lastRound();
    room.doc.transact(() => room.ses().delete(r1.a.key));
    expect(room.fold().rounds.filter((v) => v.decided)).toEqual([]);
    room.run(28_000, 1_000);
    expect(room.house.ends).toBe(0);
    room.put(r1.a);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.ends).toBe(1);
    expect(room.base()).toMatchObject({ u: 1, l: r1.c.hash, e: 1 });
    expect(Object.keys(room.base().n).sort()).toEqual(['alice', 'bob']);
    // …and never back, the round is void for good: the end is at the base's round, MISSING_WAIT_MS on.
    const lost = lastRound();
    lost.room.doc.transact(() => lost.room.ses().delete(lost.r1.a.key));
    lost.room.run(29_000, 1_000);
    expect(lost.room.house.ends).toBe(0);
    lost.room.run(3_000, 1_000);
    expect(lost.room.house.ends).toBe(1);
    expect(lost.room.base()).toMatchObject({ u: 0, e: 1, n: {} });
  });

  it("another house's reveal decided the round: this one signs no end for it (the holder's page does)", () => {
    const room = new GameRoom().start();
    room.doc.transact(() => room.top().set(delegationKey(H2.pub), delegation(owner, H2.pub)));
    const j2 = kit.houseJoin(H2, 1);
    room.doc.transact(() => {
      for (const k of room.keys('o:1:')) room.ses().delete(k);
    });
    room.house.steppingDown = true;
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const c = kit.close(alice, 1, SID, [a, b], kit.houseCommit(H2, 1));
    room.put(j2, a, b, c, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'), kit.houseReveal(H2, 1, [c.hash], [a.hash, b.hash]));
    order(room);
    room.run(HOUSE_TRIM_AFTER_MS + HOUSE_IDLE_MS, 1_000);
    expect(room.fold().rounds[0]).toMatchObject({ decided: 'house' });
    expect(room.house.ends).toBe(0);
  });

  it('after a restart it still ends the game at the round it revealed before', () => {
    const { room, r1 } = lastRound();
    room.house.restart();
    // (It settles again first.)
    room.run(SETTLE_MS + HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.ends).toBe(1);
    expect(room.base()).toMatchObject({ u: 1, l: r1.c.hash, d: `h:${recHash(r1.h)}`, e: 1 });
  });

  it("the B4 race: the holder's end at the round before lies under the house's trim; the house ends the game at its own round, and the lower end goes", () => {
    const room = new GameRoom().start();
    const r1 = room.played(1, SID);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    const trim = room.cks()[0];
    expect(trim.ck).toMatchObject({ u: 1, h: kit.houseCommit(H, 2) });
    // The holder's page, which had not heard the trim: the order and its own end at the root's round.
    const own = ownEnd();
    room.doc.transact(() => {
      room.top().set(FIN.key, FIN.value);
      room.top().set(own.key, own.value);
    });
    // (The trim stands above it: the game is still live, under the order.)
    expect(resolved(room)).toMatchObject({ live: true, base: { key: trim.key }, fin: FIN.value });
    room.run(1_200 + 2 * TICK);
    // It steps down the commitment its trim handed on, then ends at round 1 with the trim's close and nets.
    expect(room.house.wrote.stepDowns).toBe(1);
    expect(room.house.ends).toBe(1);
    const cks = room.cks();
    expect(cks).toHaveLength(1);
    expect(cks[0].ck).toMatchObject({ b: nextSid3(P, trim.ck), u: 1, l: r1.c.hash, d: trim.ck.d, o: trim.ck.o, n: trim.ck.n, e: 1, f: FIN.value, k: H.pub });
    expect(cks[0].ck.h).toBeUndefined();
    expect(resolved(room)).toMatchObject({ live: false, base: { key: cks[0].key }, pending: false });
    expect(room.sesKeys()).toEqual([]);
  });

  it("the holder's own end stands at the base's round: the game is over, and the house writes no end of its own", () => {
    const room = new GameRoom().start();
    const own = ownEnd();
    room.doc.transact(() => {
      room.top().set(FIN.key, FIN.value);
      room.top().set(own.key, own.value);
    });
    expect(resolved(room)).toMatchObject({ live: false, base: { key: own.key } });
    const { joins, reveals, stepDowns } = room.house.wrote;
    room.run(HOUSE_IDLE_MS, 1_000);
    expect(room.house.ends).toBe(0);
    expect(room.house.wrote).toMatchObject({ joins, reveals, stepDowns });
    expect(room.cks().map((x) => x.key).sort()).toEqual([ROOT.key, own.key].sort());
  });

  it('its end, deleted from the doc, is put back within a second', () => {
    const { room } = lastRound();
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.ends).toBe(1);
    const [{ key, ck }] = room.cks();
    room.doc.transact(() => room.top().delete(key));
    room.run(1_200);
    expect(room.top().get(key)).toEqual(ck);
    expect(room.house.rowPutBacks).toBe(1);
    expect(room.house.ends).toBe(1);
  });
});

describe("the simulations' house at a FAIR ONLY game: what it puts back", () => {
  function trimmed() {
    const room = new GameRoom().start();
    room.played(1, SID);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house.trims).toBe(1);
    const { key, ck } = room.cks()[0];
    return { room, key, ck };
  }

  it('its last checkpoint, deleted from the doc, within a second: also after a restart, and with nothing of the game left in the doc', () => {
    const { room, key, ck } = trimmed();
    room.doc.transact(() => room.top().delete(key));
    room.run(1_200);
    expect(room.top().get(key)).toEqual(ck);
    expect(room.house.rowPutBacks).toBe(1);
    room.house.restart();
    room.doc.transact(() => {
      room.top().delete(key);
      room.top().set(ROOT.key, ROOT.value);
    });
    room.run(1_200);
    expect(room.top().get(key)).toEqual(ck);
    expect(room.house.rowPutBacks).toBe(2);
  });

  it('its last checkpoint again when something else lies under its key (a page reads no base there)', () => {
    for (const junk of ['junk', { v: 1 }, null]) {
      const { room, key, ck } = trimmed();
      room.doc.transact(() => room.top().set(key, junk));
      expect(resolved(room).base).toBeNull();
      room.run(1_200);
      expect(room.top().get(key), JSON.stringify(junk)).toEqual(ck);
      expect(room.house.rowPutBacks, JSON.stringify(junk)).toBe(1);
      expect(resolved(room).base?.key).toBe(key);
    }
  });

  it('not while a checkpoint of the game with a higher round stands in the doc', () => {
    const { room, key } = trimmed();
    const higher = trimOf(P, 'p', { b: 'a'.repeat(24), u: 5 });
    room.doc.transact(() => {
      room.top().delete(key);
      room.top().set(higher.key, higher.value);
    });
    room.run(3_000);
    expect(room.top().has(key)).toBe(false);
    expect(room.house.rowPutBacks).toBe(0);
  });

  it("the live session's map, when the doc has lost it; and it serves the game in it again", () => {
    const { room } = trimmed();
    const sesKey = room.sesKeys()[0];
    room.doc.transact(() => room.top().delete(sesKey));
    room.run(1_200);
    expect(room.sesKeys()).toEqual([sesKey]);
    expect(room.house.newSessions).toBe(1);
    const r2 = room.closed(2, room.sid());
    room.put(kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.tick(TICK);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[r2.c.hash]]);
  });

  it('its delegation under its key, when the room holds none there; and its own session records', () => {
    const room = new GameRoom().start();
    room.run(1_200);
    expect(room.top().get(delegationKey(H.pub))).toEqual(DL_HOUSE);
    // Also where something that is no delegation of it lies there; one of it that differs stays (the deed holder's newer one).
    for (const junk of ['junk', { v: 1 }, { ...DL_HOUSE, h: H2.pub }]) {
      room.doc.transact(() => room.top().set(delegationKey(H.pub), junk));
      room.run(1_200);
      expect(room.top().get(delegationKey(H.pub)), JSON.stringify(junk)).toEqual(DL_HOUSE);
    }
    const newer = delegation(owner, H.pub);
    const other = { ...newer, g: `${newer.g.slice(0, -2)}AA` };
    room.doc.transact(() => room.top().set(delegationKey(H.pub), other));
    room.run(1_200);
    expect(room.top().get(delegationKey(H.pub))).toEqual(other);
    const [join] = room.keys('o:1:');
    room.doc.transact(() => room.ses().delete(join));
    room.run(1_200);
    expect(room.keys('o:1:')).toEqual([join]);
  });

  it('a checkpoint key of the game under a made-up id is not one of its rows: it writes nothing there', () => {
    const { room } = trimmed();
    expect(room.top().has(ckKey(T, P.inc, '0'.repeat(32)))).toBe(false);
    expect([...room.house.rows.keys()]).toEqual([`${ROOM}|${T}|${P.inc}`]);
  });
});

describe("the simulations' houses at a FAIR ONLY game that changes hands (N1)", () => {
  const DL2 = delegation(buyer, H2.pub);
  const FIN2 = sealFin(P, buyer.pub, buyer.sign);
  /** The room with a second house in it, which the buyer delegates at the hand-over. */
  class HandRoom extends GameRoom {
    readonly house2 = new SimHouse(H2.secret);
    on2 = true;

    override tick(after: number): void {
      super.tick(after);
      if (this.on2) this.house2.tick(ROOM, this.doc, this.now, 1_700_000_000_000 + this.now);
    }

    /** The buyer's transfer at round u and its delegation of the second house, in the room. */
    handOver(u: number) {
      const xf = xferOf(P, owner, buyer, u);
      this.doc.transact(() => {
        this.top().set(xf.key, xf.value);
        this.top().set(delegationKey(H2.pub), DL2);
      });
      return xf;
    }

    /** Round r closed by alice under q on a commitment of `by`, alice and bob frozen, both seeds in. */
    seeded(r: number, q: string, by: typeof H): Built<CloseRec> {
      const [a, b] = [kit.slip(alice, r, [red(5)]), kit.slip(bob, r, [red(5)])];
      const c = kit.close(alice, r, q, [a, b], kit.houseCommit(by, r));
      this.put(a, b, c, kit.reveal(r, 'alice'), kit.reveal(r, 'bob'));
      return c;
    }
  }
  const written = (h: SimHouse) => ({ ...h.wrote, cks: h.trims + h.sweeps + h.ends });

  /** Rounds 1 and 2 on the seller's house, the game handed over at round 2 while it was in flight; the buyer's house settled and joined to round 3. */
  function midRound(room = new HandRoom().start()) {
    const r1 = room.played(1, SID);
    const { c } = room.closed(2, r1.c.hash);
    room.tick(TICK);
    expect(room.recs('h:2:')).toEqual([]);
    const xf = room.handOver(2);
    room.put(kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.tick(TICK);
    const [h2] = room.recs('h:2:');
    expect(h2).toMatchObject({ x: [c.hash], n: expect.objectContaining({ length: 2 }), k: H.pub });
    room.run(SETTLE_MS + TICK);
    return { room, xf, c, h2 };
  }

  it('the game handed over between rounds: the seller\'s house reveals nothing on the commitment it left for the next round, joins nothing and signs nothing; the round voided, the buyer\'s house plays the one after and its trim carries the transfer', () => {
    const room = new HandRoom().start();
    const r1 = room.played(1, SID);
    expect(r1.h.c).toBe(kit.houseCommit(H, 2));
    const xf = room.handOver(1);
    room.tick(TICK);
    expect(resolved(room)).toMatchObject({ holder: buyer.pub, live: true, pending: false });
    const before = written(room.house);
    // A close of round 2 on the seller's house's commitment: nobody's to reveal.
    const c2 = room.seeded(2, r1.c.hash, H);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(SETTLE_MS + HOUSE_TRIM_AFTER_MS + 3_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    expect(room.recs('o:2:')).toHaveLength(0);
    expect(written(room.house)).toEqual(before);
    // (The buyer's house, settled, has joined the round after the close it will not reveal; it signs nothing yet.)
    expect(room.recs('o:3:').map((v) => [v.c, v.k])).toEqual([[kit.houseCommit(H2, 3), H2.pub]]);
    expect(written(room.house2)).toMatchObject({ joins: 1, reveals: 0, stepDowns: 0, cks: 0 });
    expect(room.fold()).toMatchObject({ open: 2 });
    // A frozen bettor's abandon voids it: round 3 is the buyer's house's.
    room.put(kit.abandon(alice, 2, c2.hash));
    const c3 = room.seeded(3, c2.hash, H2);
    room.tick(TICK);
    const [h3] = room.recs('h:3:');
    expect(h3).toMatchObject({ x: [c3.hash], c: kit.houseCommit(H2, 4), k: H2.pub });
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house2).toMatchObject({ trims: 1, crossCheckMismatches: 0 });
    const cks = room.cks();
    expect(cks).toHaveLength(1);
    const { key, ck } = cks[0];
    expect(readCk(ROOM, key, ck)).toMatchObject({ kind: 'ok' });
    expect(ck).toMatchObject({ u: 3, l: c3.hash, d: `h:${recHash(h3)}`, h: kit.houseCommit(H2, 4), dl: DL2, k: H2.pub, x: [xf.value] });
    const res = resolved(room);
    expect(res).toMatchObject({ live: true, holder: buyer.pub, base: { key }, pending: false });
    expect(res.invalid).toEqual([]);
    expect(res.chain.map((h) => [h.k, h.from])).toEqual([[owner.pub, 0], [buyer.pub, 1]]);
    expect([res.houseAt(H2.pub, 4), res.houseAt(H.pub, 4)]).toEqual([true, false]);
    // …and the seller's house wrote nothing through all of it.
    expect(written(room.house)).toEqual(before);
    // Round 4 plays on the buyer's house.
    const c4 = room.seeded(4, room.sid(), H2);
    room.tick(TICK);
    expect(room.recs('h:4:').map((v) => [v.x, v.k])).toEqual([[[c4.hash], H2.pub]]);
  });

  it('handed over with a round in flight, at that round: the seller\'s house reveals it with no commitment for the next, which the buyer\'s house joins; no round is lost', () => {
    const { room, c, h2 } = midRound();
    expect(h2.c).toBeUndefined();
    expect(room.recs('o:3:').map((v) => [v.c, v.k])).toEqual([[kit.houseCommit(H2, 3), H2.pub]]);
    expect(room.house.wrote).toMatchObject({ joins: 1, stepDowns: 0 });
    const c3 = room.seeded(3, c.hash, H2);
    room.tick(TICK);
    expect(room.recs('h:3:').map((v) => [v.x, v.k])).toEqual([[[c3.hash], H2.pub]]);
    // As a page folds it, each round by a house of its holder (the buyer's delegation is the room's record).
    const res = resolveGame(authEnv().env, T, P.inc, recordsOf([...room.top().entries()].map(([key, value]) => ({ key, value })), [DL2]));
    const tf = new TableFold(P, trustAll, undefined, foldGameOf(P), (pub, r) => res.houseAt(pub, r) === true);
    tf.setFairOnlyBase(room.base());
    tf.reset([...room.ses().entries()]);
    expect(tf.result().rounds.map((d) => [d.r, d.decided])).toEqual([[1, 'house'], [2, 'house'], [3, 'house']]);
    expect([1, 2, 3].map((r) => [res.houseAt(H.pub, r), res.houseAt(H2.pub, r)])).toEqual([[true, false], [true, false], [false, true]]);
  });

  it('handed over twice with the base still the root: the middle holder\'s house reveals the round in flight as the game left its key, with no commitment for the next, and nothing after', () => {
    const room = new HandRoom().start();
    const r1 = room.played(1, SID);
    room.handOver(1);
    const c2 = room.seeded(2, r1.c.hash, H);
    room.put(kit.abandon(alice, 2, c2.hash));
    room.run(SETTLE_MS + TICK);
    expect(room.recs('o:3:').map((v) => v.k)).toEqual([H2.pub]);
    // Round 3 closed on the buyer's house's join; the game goes on to a third key (with no house) at that round.
    const [a, b] = [kit.slip(alice, 3, [red(5)]), kit.slip(bob, 3, [red(5)])];
    const c3 = kit.close(alice, 3, c2.hash, [a, b], kit.houseCommit(H2, 3));
    const on = xferOf(P, buyer, third, 3, { nonce: hex('9', 24) });
    room.doc.transact(() => room.top().set(on.key, on.value));
    room.put(a, b, c3, kit.reveal(3, 'alice'), kit.reveal(3, 'bob'));
    room.tick(TICK);
    expect(resolved(room).chain.map((h) => [h.k, h.from])).toEqual([[owner.pub, 0], [buyer.pub, 1], [third.pub, 3]]);
    const [h3] = room.recs('h:3:');
    expect(h3).toMatchObject({ x: [c3.hash], k: H2.pub });
    expect(h3.c).toBeUndefined();
    const wrote = written(room.house2);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 3_000);
    expect(written(room.house2)).toMatchObject({ joins: wrote.joins, reveals: wrote.reveals, stepDowns: 0, cks: 0 });
    expect(room.recs('o:4:')).toEqual([]);
    expect(written(room.house)).toMatchObject({ joins: 1, reveals: 1, stepDowns: 0, cks: 0 });
  });

  it('a house of a key the game has left joins nothing, not even an unjoined round of its own key\'s', () => {
    const room = new HandRoom();
    room.tick(0);
    // (Still settling: it has not joined round 1, which the transfer leaves with the seller. No page
    // writes such a transfer: its round is past the last decided only for a close in flight, which names a commitment.)
    room.handOver(1);
    room.run(2 * SETTLE_MS + 2_000);
    expect(resolved(room).chain.map((h) => [h.k, h.from])).toEqual([[owner.pub, 0], [buyer.pub, 1]]);
    // (Nor does the buyer's house join it: the round is not its own.)
    expect(room.recs('o:1:')).toEqual([]);
    expect(room.recs('o:2:')).toEqual([]);
    for (const h of [room.house, room.house2]) expect(written(h)).toMatchObject({ joins: 0, reveals: 0, stepDowns: 0, cks: 0 });
  });

  it('a game that has left its key does not hold the room\'s beat off the games the house still serves', () => {
    const room = new HandRoom().start();
    room.on2 = false;
    const second = rootOf(Q, 'q');
    const ses = `ses:${T}:${Q.inc}:${nextSid3(Q, second.value)}`;
    room.doc.transact(() => {
      room.top().set(second.key, second.value);
      room.top().set(ses, new Y.Map());
    });
    room.run(SETTLE_MS + HEARTBEAT_MS);
    room.played(1, SID);
    room.handOver(1);
    room.tick(TICK);
    expect(resolved(room).holder).toBe(buyer.pub);
    const beats = room.house.wrote.beats;
    room.run(3 * HEARTBEAT_MS);
    expect(room.house.wrote.beats).toBeGreaterThanOrEqual(beats + 2);
    // (The base is still under the transfer's round: the game is one it reveals for no more, and counts for nothing.)
    expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
  });

  it('neither house signs a checkpoint at the hand-over round the seller\'s house decided: the seller\'s speaks for the game no more (nor under the seller\'s end order), the buyer\'s did not reveal it', () => {
    const { room } = midRound();
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_IDLE_MS + 5_000, 1_000);
    for (const h of [room.house, room.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
    const fin = sealFin(P, owner.pub, owner.sign);
    room.doc.transact(() => room.top().set(fin.key, fin.value));
    room.run(5_000, 1_000);
    for (const h of [room.house, room.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    expect(resolved(room)).toMatchObject({ live: true, holder: buyer.pub, fin: null });
    expect(room.recs('o:3:')).toHaveLength(1);
  });

  it('the base under the round its holder has the game from: no sweep there, no trim to a voided round under it, and no end (a checkpoint there would be nobody\'s to sign)', () => {
    // Nothing decided since the base: junk is not swept.
    const fresh = new HandRoom().start();
    fresh.handOver(1);
    fresh.junk(HOUSE_SWEEP_BYTES);
    fresh.run(SETTLE_MS + HOUSE_SWEEP_MIN_MS + 5_000);
    for (const h of [fresh.house, fresh.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    // …nor is the game ended there, under the buyer's order.
    fresh.doc.transact(() => fresh.top().set(FIN2.key, FIN2.value));
    fresh.run(10_000);
    expect(resolved(fresh)).toMatchObject({ live: true, holder: buyer.pub });
    expect(resolved(fresh).fin).not.toBeNull();
    for (const h of [fresh.house, fresh.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    expect(fresh.cks().map((x) => x.key)).toEqual([ROOT.key]);
    // A round a bettor's abandon voided, under the transfer's: no trim to it, and no end at it.
    const room = new HandRoom().start();
    const r1 = room.played(1, SID);
    const { c } = room.closed(2, r1.c.hash);
    room.put(kit.abandon(alice, 2, c.hash));
    room.handOver(3);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_IDLE_MS + 5_000, 1_000);
    for (const h of [room.house, room.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    room.doc.transact(() => room.top().set(FIN2.key, FIN2.value));
    room.run(10_000);
    for (const h of [room.house, room.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
  });

  it('the buyer\'s end order with the seller\'s house\'s commitment for the next round outstanding: that house does not step down from a round that is not its own, and neither ends the game (the buyer\'s page does)', () => {
    const room = new HandRoom().start();
    room.played(1, SID);
    room.handOver(1);
    room.run(SETTLE_MS + TICK);
    room.doc.transact(() => room.top().set(FIN2.key, FIN2.value));
    room.run(HOUSE_TRIM_AFTER_MS + 3_000);
    expect(room.recs('h:2:')).toEqual([]);
    expect(room.house.wrote.stepDowns).toBe(0);
    for (const h of [room.house, room.house2]) expect(h).toMatchObject({ trims: 0, sweeps: 0, ends: 0, crossCheckMismatches: 0 });
    expect(room.recs('o:2:').concat(room.recs('o:3:'))).toEqual([]);
  });

  it('the buyer\'s end order: its house reveals the round in with no commitment and ends the game at it, the order and the transfer in the end', () => {
    const { room, xf, c } = midRound();
    const c3 = room.seeded(3, c.hash, H2);
    room.doc.transact(() => room.top().set(FIN2.key, FIN2.value));
    room.tick(TICK);
    const [h3] = room.recs('h:3:');
    expect(h3).toMatchObject({ x: [c3.hash], k: H2.pub });
    expect(h3.c).toBeUndefined();
    room.run(HOUSE_TRIM_AFTER_MS + 1_200);
    expect(room.house2).toMatchObject({ ends: 1, trims: 0, crossCheckMismatches: 0 });
    expect(room.house.ends).toBe(0);
    const [{ key, ck }] = room.cks();
    expect(room.cks()).toHaveLength(1);
    expect(readCk(ROOM, key, ck)).toMatchObject({ kind: 'ok' });
    expect(ck).toMatchObject({ u: 3, l: c3.hash, d: `h:${recHash(h3)}`, e: 1, f: FIN2.value, dl: DL2, k: H2.pub, x: [xf.value] });
    expect(Object.keys(ck.n).sort()).toEqual(['alice', 'bob']);
    expect(resolved(room)).toMatchObject({ live: false, holder: buyer.pub, base: { key }, pending: false, invalid: [] });
    expect(room.sesKeys()).toEqual([]);
  });

  it('a sweep after a hand-over carries the transfer too', () => {
    const { room, xf, c } = midRound();
    room.seeded(3, c.hash, H2);
    room.junk(HOUSE_SWEEP_BYTES);
    room.run(HOUSE_TRIM_AFTER_MS + 1_400);
    expect(room.house2).toMatchObject({ trims: 1, sweeps: 0 });
    // (The cross-check: a sweep that leaves the transfer out, or carries another, is not signed.)
    const other = xferOf(P, owner, buyer, 1).value;
    for (const fault of [(body: Record<string, unknown>) => ({ ...body, x: undefined }), (body: Record<string, unknown>) => ({ ...body, x: [other] })]) {
      const before = room.house2.crossCheckMismatches;
      room.house2.faultTrim = fault;
      room.junk(HOUSE_SWEEP_BYTES);
      room.run(HOUSE_SWEEP_MIN_MS + 1_200);
      expect(room.house2.sweeps).toBe(0);
      expect(room.house2.crossCheckMismatches).toBeGreaterThan(before);
    }
    room.house2.faultTrim = null;
    room.run(1_200);
    expect(room.house2).toMatchObject({ trims: 1, sweeps: 1 });
    const [{ key, ck }] = room.cks();
    expect(room.cks()).toHaveLength(1);
    expect(ck).toMatchObject({ u: 3, w: 1, dl: DL2, k: H2.pub, x: [xf.value] });
    expect(resolved(room)).toMatchObject({ live: true, holder: buyer.pub, base: { key }, pending: false, invalid: [] });
  });
});
