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
import type { Built } from './computedTestKit';

const ROOM = 'room-twin';
const T = 'roulette-1';
const T2 = 'roulette-2';
const INC = 'r' + '3c'.repeat(12);
const INC2 = 'r' + '4d'.repeat(12);
const CTX: FoldCtx = { room: ROOM, t: T, inc: INC };
const kit = new ComputedKit(CTX);
const H = testHouse('twin-node');
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
  now = 1_000_000;

  constructor(two = false) {
    this.doc.transact(() => {
      this.doc.getMap('roomInfo').set('owner', OWNER.pid);
      this.doc.getMap('players').set(OWNER.pid, { keyB64: OWNER.pub });
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
    this.house.tick(ROOM, this.doc, this.now, 1_700_000_000_000 + this.now);
  }

  /** The live session's records under a key prefix (`h:1:`, `o:`). */
  recs(prefix: string, t = T, inc = INC): Record<string, unknown>[] {
    return [...this.ses(t, inc).entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as Record<string, unknown>);
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
});
