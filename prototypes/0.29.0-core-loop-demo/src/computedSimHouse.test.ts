/**
 * 🧪🏠 The simulations' house (computedSimHouse.ts) against records a bettor
 * with a modified game could write: the twin of house.rs's tests of the
 * same (ssf-p2p-node src/house/tests.rs), so the two keep one rule.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { nextSid, recHash } from './computedFold';
import type { CloseRec, FoldCtx, SlipRec } from './computedFold';
import { beatKey, delegationKey, fairSettingKey, roomSignBytes } from './computedHouse';
import type { RoomKind } from './computedHouse';
import { SETTLE_MS, SimHouse } from './computedSimHouse';
import { ComputedKit, red, testHouse, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import type { RouletteBet } from './games/roulette';

const ROOM = 'room-twin';
const T = 'roulette-1';
const T2 = 'roulette-2';
const INC = 'r' + '3c'.repeat(12);
const INC2 = 'r' + '4d'.repeat(12);
const CTX: FoldCtx = { room: ROOM, t: T, inc: INC };
const kit = new ComputedKit(CTX);
const H = testHouse('twin-node');
const H2 = testHouse('twin-node-2');
const OWNER = testIdentity('twin-owner', 'owner');
const MALLORY = testIdentity('twin-mallory', 'mallory');
const alice = testIdentity('twin-alice', 'alice');
const bob = testIdentity('twin-bob', 'bob');
const BAD_SIG = 'A'.repeat(86);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const roomSigned = (kind: RoomKind, t: string, body: Record<string, unknown>, by = OWNER): Record<string, unknown> => {
  const withKey = { ...body, k: by.pub };
  return { ...withKey, g: by.sign(roomSignBytes(kind, ROOM, t, withKey)) };
};

/** The owner's room with table T (and T2 with `two`) switched on and the
 *  house delegated; start() ticks it past the settle after its first read. */
class TwinRoom {
  readonly doc = new Y.Doc();
  readonly house = new SimHouse(H.secret);
  readonly others: SimHouse[] = [];
  now = 1_000_000;

  constructor(two = false) {
    this.doc.transact(() => {
      this.doc.getMap('roomInfo').set('owner', OWNER.pid);
      for (const id of [OWNER, MALLORY, alice, bob]) this.doc.getMap('players').set(id.pid, { keyB64: id.pub });
      for (const [t, inc] of two ? [[T, INC], [T2, INC2]] : [[T, INC]]) {
        this.doc.getMap('casino').set(`cfg:computed:${t}`, { v: 1, inc });
        this.top().set(`ses:${t}:${inc}:${nextSid({ room: ROOM, t, inc }, null)}`, new Y.Map());
      }
      this.top().set(delegationKey(H.pub), roomSigned('hkey', '', { v: 1, h: H.pub }));
    });
  }

  start(): this {
    this.tick(0);
    this.tick(SETTLE_MS);
    return this;
  }

  top(): Y.Map<unknown> {
    return this.doc.getMap('casinoComputed');
  }

  ses(t = T, inc = INC): Y.Map<unknown> {
    return this.top().get(`ses:${t}:${inc}:${nextSid({ room: ROOM, t, inc }, null)}`) as Y.Map<unknown>;
  }

  put(...recs: Built<unknown>[]): void {
    this.doc.transact(() => {
      for (const r of recs) this.ses().set(r.key, r.rec);
    });
  }

  tick(after: number): void {
    this.now += after;
    for (const h of [this.house, ...this.others]) h.tick(ROOM, this.doc, this.now, 1_700_000_000_000 + this.now);
  }

  /** The live session's records under a key prefix (`h:1:`, `o:`). */
  recs(prefix: string, t = T, inc = INC): Record<string, unknown>[] {
    return this.entries(prefix, t, inc).map(([, v]) => v);
  }

  entries(prefix: string, t = T, inc = INC): [string, Record<string, unknown>][] {
    return [...this.ses(t, inc).entries()].filter(([k]) => k.startsWith(prefix)) as [string, Record<string, unknown>][];
  }

  /** A second node of the owner's, delegated as the first, ticking with it. */
  secondHouse(): SimHouse {
    const other = new SimHouse(H2.secret);
    this.doc.transact(() => this.top().set(delegationKey(H2.pub), roomSigned('hkey', '', { v: 1, h: H2.pub })));
    this.others.push(other);
    return other;
  }

  /** Round 1 on the house's join, alice's close and bob's rival, every seed
   *  in, revealed: the close it picked and the other. */
  revealedWithARival(): { picked: Built<CloseRec>; other: Built<CloseRec> } {
    const { c, b } = this.closedOnTheJoin();
    const c1b = kit.close(bob, 1, kit.sidAfter(null), [b], kit.houseCommit(H, 1));
    this.put(c1b, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    this.tick(200);
    const picked = (this.recs('h:1:')[0].x as string[])[0] === c.hash ? c : c1b;
    return { picked, other: picked === c ? c1b : c };
  }

  /** Round 1 closed by alice on the house's join, alice and bob frozen. */
  closedOnTheJoin(): { c: Built<CloseRec>; a: Built<SlipRec>; b: Built<SlipRec> } {
    expect(this.recs('o:1:')).toHaveLength(1);
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const c = kit.close(alice, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H, 1));
    this.put(a, b, c);
    return { c, a, b };
  }
}

/** A record of the house's kind under its key, mallory's "signature". */
function forgedOwn<R extends { r: number }>(b: Built<R>, kind: 'h' | 'o'): Built<R> {
  const rec = { ...b.rec, g: BAD_SIG };
  return { key: `${kind}:${rec.r}:${recHash(rec)}`, hash: recHash(rec)!, rec };
}

describe('the simulations\' house, as house.rs', () => {
  it('takes no record under its key it did not sign for its own', () => {
    // A "reveal" of round 1000, and a "join" of round 1 with its commitment
    // (as a copy of its own would have), under the house's key.
    for (const forged of [forgedOwn(kit.stepDown(H, 1000), 'h'), forgedOwn(kit.houseJoin(H, 1), 'o')]) {
      const room = new TwinRoom();
      room.put(forged);
      room.start();
      expect(room.house.wrote.joins).toBe(1);
      const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
      const c = kit.close(alice, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H, 1));
      room.put(a, b, c, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
      room.tick(200);
      expect(room.recs('h:1:').filter((v) => v.g !== BAD_SIG).map((v) => v.x)).toEqual([[c.hash]]);
    }
  });

  it('a close skipping rounds is not on the chain', () => {
    const room = new TwinRoom().start();
    const { c } = room.closedOnTheJoin();
    const a50 = kit.slip(alice, 50, [red(5)]);
    room.put(a50, kit.close(alice, 50, c.hash, [a50]));
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(200);
    expect(room.recs('h:1:').map((v) => v.x)).toEqual([[c.hash]]);
    for (let i = 0; i < 5; i++) room.tick(1_000);
    expect(room.recs('o:51:')).toHaveLength(0);
    expect(room.house.blockedSeen).toBe(0);
  });

  it('reveals one close a round and carries on its line alone', () => {
    const room = new TwinRoom().start();
    const { c: c1, a, b } = room.closedOnTheJoin();
    const c1b = kit.close(bob, 1, kit.sidAfter(null), [b], kit.houseCommit(H, 1));
    room.put(c1b, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(200);
    const [h] = room.recs('h:1:');
    expect(h.x).toHaveLength(1);
    const picked = (h.x as string[])[0] === c1.hash ? c1 : c1b;
    const other = picked === c1 ? c1b : c1;
    expect(h.n).toEqual(picked === c1 ? [a.hash, b.hash].sort() : [b.hash]);
    // Round 2 on the close it passed over, naming the commitment it carried.
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, other.hash, [a2, b2], kit.houseCommit(H, 2)), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    for (let i = 0; i < 20; i++) room.tick(1_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    // On the close it decided.
    const d = kit.close(bob, 2, picked.hash, [a2, b2], kit.houseCommit(H, 2));
    room.put(d);
    room.tick(200);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[d.hash]]);
  });

  it('counts its heartbeat on from the doc only as it signed it', () => {
    const room = new TwinRoom().start();
    const key = beatKey(H.pub);
    const n1 = (room.top().get(key) as { n: number }).n;
    room.doc.transact(() => room.top().set(key, { v: 1, n: MAX_SAFE, k: H.pub, g: BAD_SIG }));
    expect(() => room.tick(5_000)).not.toThrow();
    const n2 = (room.top().get(key) as { n: number }).n;
    expect(n2).toBeGreaterThan(n1);
    expect(n2).toBeLessThan(9_000_000_000_000_000);
  });

  it('puts the newest setting back over a forged one numbered past it', () => {
    const room = new TwinRoom().start();
    const setting = roomSigned('hfair', T, { v: 1, m: 1, s: 3 });
    room.doc.transact(() => room.top().set(fairSettingKey(T), setting));
    room.tick(1_000);
    const forged = { ...roomSigned('hfair', T, { v: 1, m: 0, s: 9 }, MALLORY), k: OWNER.pub };
    room.doc.transact(() => room.top().set(fairSettingKey(T), forged));
    room.tick(1_000);
    expect(room.top().get(fairSettingKey(T))).toEqual(setting);
  });

  it('a setting signed for one table counts at no other', () => {
    const room = new TwinRoom(true).start();
    const joinsBefore = room.house.wrote.joins;
    expect(joinsBefore).toBe(2);
    // T set Friendly: it steps its join down; the copy at T2 counts nothing.
    const setting = roomSigned('hfair', T, { v: 1, m: 1, s: 1 });
    room.doc.transact(() => {
      room.top().set(fairSettingKey(T2), setting);
      room.top().set(fairSettingKey(T), setting);
    });
    for (let i = 0; i < 3; i++) room.tick(1_000);
    expect(room.house.wrote.stepDowns).toBe(1);
    expect(room.recs('h:1:', T)).toHaveLength(1);
    expect(room.recs('h:', T2, INC2)).toHaveLength(0);
  });

  it('reveals no close signed over a slip the pages refuse', () => {
    // (The kit builds no slip the fold would throw out.)
    const junkSlip = (id: TestIdentity, r: number, b: unknown[]): Built<SlipRec> => {
      const rec = kit.sign<SlipRec>('slip', id, { r, p: id.pid, v: 1, b: b as RouletteBet[], c: kit.commit(r, id.pid, kit.seed(id.pid, r)) });
      return { key: `s:${r}:${id.pid}:${recHash(rec)}`, hash: recHash(rec)!, rec };
    };
    const forged = (b: Built<SlipRec>): Built<SlipRec> => {
      const rec = { ...b.rec, g: BAD_SIG };
      return { key: `s:${rec.r}:${rec.p}:${recHash(rec)}`, hash: recHash(rec)!, rec };
    };
    // The signer's slip: no chips; bets no table takes; mallory's, its
    // signature forged. (One under another's key is the pages' to flag: the
    // fold takes a close as its signer signed it.)
    const cases: [string, () => [Built<SlipRec>, TestIdentity]][] = [
      ['empty', () => [kit.slip(MALLORY, 1, []), MALLORY]],
      ['junk bets', () => [junkSlip(MALLORY, 1, [{ type: 'purple', amount: 5 }]), MALLORY]],
      ['forged signature', () => [forged(kit.slip(MALLORY, 1, [red(5)])), MALLORY]],
    ];
    for (const [name, slip] of cases) {
      const room = new TwinRoom().start();
      expect(room.recs('o:1:'), name).toHaveLength(1);
      const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
      const [m, signer] = slip();
      room.put(a, b, m, kit.close(signer, 1, kit.sidAfter(null), [a, b, m], kit.houseCommit(H, 1)));
      room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'), kit.reveal(1, MALLORY.pid));
      for (let i = 0; i < 20; i++) room.tick(1_000);
      expect(room.recs('h:'), name).toHaveLength(0);
      // The round's real close is revealed when it comes.
      const c = kit.close(alice, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H, 1));
      room.put(c);
      room.tick(200);
      expect(room.recs('h:1:').map((v) => v.x), name).toEqual([[c.hash]]);
    }
  });

  it('a deleted reveal is put back after a restart, and its line holds', () => {
    const room = new TwinRoom().start();
    const { picked, other } = room.revealedWithARival();
    const [[key, h]] = room.entries('h:1:');
    expect(room.house.done.get(`${ROOM}|${T}|${INC}`)).toEqual({
      r: 1, d: [1, picked.hash], c: true, kept: [{ ses: `ses:${T}:${INC}:${kit.sidAfter(null)}`, key, rec: h }],
    });
    // A peer deletes the reveal; the node restarts, and puts it back from
    // its state file as it would have during the run.
    room.doc.transact(() => room.ses().delete(key));
    room.house.restart();
    room.start();
    expect(room.entries('h:1:')).toEqual([[key, h]]);
    // Round 2 asks for the commitment it carried: no join, and a close on
    // the close it passed over is never revealed.
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, other.hash, [a2, b2], kit.houseCommit(H, 2)), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    for (let i = 0; i < 20; i++) room.tick(1_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    expect(room.recs('o:2:')).toHaveLength(0);
    const d = kit.close(bob, 2, picked.hash, [a2, b2], kit.houseCommit(H, 2));
    room.put(d);
    room.tick(200);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[d.hash]]);
  });

  it('a step-down, a deleted reveal and a restart never carry on the rival line', () => {
    const room = new TwinRoom().start();
    const { picked, other } = room.revealedWithARival();
    const [[key]] = room.entries('h:1:');
    // The rival voided; the owner sets the table Friendly: a step-down at 2.
    room.put(kit.abandon(bob, 1, other.hash));
    room.doc.transact(() => room.top().set(fairSettingKey(T), roomSigned('hfair', T, { v: 1, m: 1, s: 1 })));
    room.tick(200);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[]]);
    // Round 2 played Friendly on the voided rival.
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, other.hash, [a2, b2]), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    // A peer keeps deleting the round-1 reveal; the node restarts; Fair again.
    room.house.restart();
    room.doc.transact(() => room.top().set(fairSettingKey(T), roomSigned('hfair', T, { v: 1, m: 0, s: 2 })));
    for (let i = 0; i < 20; i++) {
      room.doc.transact(() => room.ses().delete(key));
      room.tick(1_000);
    }
    expect(room.recs('o:3:')).toHaveLength(0);
    // Its reveal back, round 2 played on the close it decided: it joins 3.
    room.tick(1_000);
    expect(room.recs('h:1:')).toHaveLength(1);
    room.put(kit.close(bob, 2, picked.hash, [a2, b2]));
    room.tick(200);
    expect(room.recs('o:3:')).toHaveLength(1);
  });

  it('a close the fold throws out neither refuses a round nor is revealed', () => {
    const room = new TwinRoom().start();
    expect(room.recs('o:1:')).toHaveLength(1);
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    // Beside the round's close: one naming a commitment no house wrote, and
    // one on a parent that isn't the session.
    const c = kit.close(alice, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H, 1));
    room.put(a, b, kit.close(bob, 1, kit.sidAfter(null), [a, b], 'ab'.repeat(32)), kit.close(bob, 1, 'cd'.repeat(16), [a, b], kit.houseCommit(H, 1)), c);
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(200);
    expect(room.recs('h:1:').map((v) => v.x)).toEqual([[c.hash]]);
  });

  it('a close on a round nothing decided is never revealed', () => {
    const room = new TwinRoom().start();
    const { c } = room.closedOnTheJoin();
    room.put(kit.reveal(1, 'alice'));
    room.tick(200);
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, c.hash, [a2, b2], kit.houseCommit(H, 2)), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    room.tick(200);
    expect(room.recs('h:')).toHaveLength(0);
  });

  it('a round with a later round on top when first seen is never revealed', () => {
    const room = new TwinRoom().start();
    const { c } = room.closedOnTheJoin();
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, c.hash, [a2, b2]), kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    for (let i = 0; i < 20; i++) room.tick(1_000);
    expect(room.recs('h:1:')).toHaveLength(0);
  });

  it('a close on an undecided close is on no chain, beside a decided one', () => {
    const room = new TwinRoom();
    const setFair = (m: number, seq: number): void => {
      room.doc.transact(() => room.top().set(fairSettingKey(T), roomSigned('hfair', T, { v: 1, m, s: seq })));
    };
    setFair(1, 1);
    room.start();
    // Friendly round 1: alice's close decided, bob's waiting on his seed;
    // round 2 played on bob's.
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const c1b = kit.close(bob, 1, kit.sidAfter(null), [b]);
    room.put(a, b, kit.close(alice, 1, kit.sidAfter(null), [a]), c1b, kit.reveal(1, 'alice'));
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, c1b.hash, [a2, b2]), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    // Fair again: the table is at round 2.
    setFair(0, 2);
    room.tick(200);
    expect(room.recs('o:2:')).toHaveLength(1);
    expect(room.recs('o:3:')).toHaveLength(0);
  });

  it('a close naming nothing where its round asks for a commitment takes the table nowhere', () => {
    const room = new TwinRoom().start();
    const { picked } = room.revealedWithARival();
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, picked.hash, [a2, b2]), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    for (let i = 0; i < 10; i++) room.tick(1_000);
    expect(room.recs('o:3:')).toHaveLength(0);
  });

  it('a second house joins no round the first holds', () => {
    const room = new TwinRoom();
    const other = room.secondHouse();
    room.start();
    expect(room.entries('o:1:').map(([, v]) => v.k)).toEqual([H.pub]);
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    room.put(a, b, kit.close(alice, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H, 1)), kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    for (let i = 0; i < 5; i++) room.tick(1_000);
    expect(room.recs('h:1:')[0].c).toBeDefined();
    expect(room.entries('o:').every(([k]) => k.startsWith('o:1:'))).toBe(true);
    // The first stops, stepping its commitment down: round 2 is the second's.
    room.house.steppingDown = true;
    room.tick(200);
    expect(room.recs('h:2:').map((v) => v.x)).toEqual([[]]);
    room.tick(200);
    expect(room.entries('o:2:').map(([, v]) => v.k)).toEqual([other.pub]);
  });

  it('a second house carries on the line the first decided and nothing else', () => {
    const room = new TwinRoom();
    const other = room.secondHouse();
    room.start();
    const { c: c1, b } = room.closedOnTheJoin();
    const c1b = kit.close(bob, 1, kit.sidAfter(null), [b], kit.houseCommit(H, 1));
    // The first stops: it reveals round 1 carrying nothing on.
    room.put(c1b, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.house.steppingDown = true;
    room.tick(200);
    const [h] = room.recs('h:1:');
    expect(h.c).toBeUndefined();
    const picked = (h.x as string[])[0];
    const rival = picked === c1.hash ? c1b : c1;
    // The second joins round 2.
    room.put(kit.abandon(bob, 1, rival.hash));
    room.tick(200);
    expect(room.entries('o:2:').map(([, v]) => v.k)).toEqual([other.pub]);
    const bCommit = room.recs('o:2:')[0].c as string;
    // A close on the voided rival naming the second's commitment: never revealed.
    const [a2, b2] = [kit.slip(alice, 2, [red(5)]), kit.slip(bob, 2, [red(5)])];
    room.put(a2, b2, kit.close(alice, 2, rival.hash, [a2, b2], bCommit), kit.reveal(2, 'alice'), kit.reveal(2, 'bob'));
    for (let i = 0; i < 20; i++) room.tick(1_000);
    expect(room.recs('h:2:')).toHaveLength(0);
    // On the close the first decided: the second reveals it.
    const d = kit.close(bob, 2, picked, [a2, b2], bCommit);
    room.put(d);
    room.tick(200);
    expect(room.recs('h:2:').map((v) => [v.k, v.x])).toEqual([[other.pub, [d.hash]]]);
  });

  it('of two houses joining a round, only the one the pages name reveals', () => {
    const room = new TwinRoom();
    room.secondHouse();
    room.tick(0);
    room.tick(SETTLE_MS);
    // Both joined round 1, neither seeing the other's yet.
    room.put(kit.houseJoin(H2, 1));
    const joins = room.entries('o:1:').sort(([x], [y]) => (x < y ? -1 : 1));
    expect(joins).toHaveLength(2);
    const lowest = joins[0][1].k as string;
    const [a, b] = [kit.slip(alice, 1, [red(5)]), kit.slip(bob, 1, [red(5)])];
    const ca = kit.close(alice, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H, 1));
    const cb = kit.close(bob, 1, kit.sidAfter(null), [a, b], kit.houseCommit(H2, 1));
    room.put(a, b, ca, cb, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    for (let i = 0; i < 20; i++) room.tick(1_000);
    expect(room.recs('h:1:').map((v) => [v.k, v.x])).toEqual([[lowest, [lowest === H.pub ? ca.hash : cb.hash]]]);
  });

  it('puts its reveal back over junk under its key', () => {
    const room = new TwinRoom().start();
    room.closedOnTheJoin();
    room.put(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    room.tick(200);
    const [[key, rec]] = room.entries('h:1:');
    room.doc.transact(() => room.ses().set(key, { r: 1, s: 'junk' }));
    room.tick(1_000);
    expect(room.entries('h:1:')).toEqual([[key, rec]]);
  });
});
