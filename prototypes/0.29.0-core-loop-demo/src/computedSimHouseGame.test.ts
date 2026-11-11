/**
 * 🧪🏠🔒 The simulations' house (computedSimHouse.ts) at a FAIR ONLY game
 * (design §8.5 N1 to N5, PR 6c-5a-2): what it reads there (the game through
 * its resolution, the fold's rules for a game), when it reveals where a house
 * table's house would not (B2), the checkpoint it signs and the trim it
 * applies, its cross-check, and what it puts back. The house table's rules
 * it shares with a game are held by computedSimHouse.test.ts.
 *
 * The node's house job has no `p`/`q` half yet: this twin is written from the
 * design first, and the node's half is to be held to these rules.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { basisOf, canonFelt } from './computedCraps';
import { ckKey, faironlyInc, readCk, sealFin } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { resolveGame } from './computedFairOnlyAuth';
import { authEnv, delegation, DL_HOUSE, house as H, house2 as H2, NAME, OPENING_CARRY, owner, P, Q, recordsOf, ROOM, rootOf, T, trimOf } from './computedFairOnlyKit';
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

  it('under an end order it reveals with no next commitment, joins nothing, and signs no checkpoint', () => {
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
    room.run(HOUSE_TRIM_AFTER_MS + HOUSE_IDLE_MS + 2_000, 1_000);
    expect(room.recs('o:2:')).toHaveLength(0);
    expect(room.house.trims).toBe(0);
    expect(room.cks().map((x) => x.key)).toEqual([ROOT.key]);
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
