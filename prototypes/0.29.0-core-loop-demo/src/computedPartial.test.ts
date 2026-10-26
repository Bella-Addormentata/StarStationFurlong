/**
 * 🧮📒 A computed table on a page holding part of another page's update
 * (casinoDoc casinoWhole), as tableSplit.test.ts builds one: a page's later
 * update applied before its earlier one, so Yjs parks the later one's writes
 * and applies its deletes at once. The page keeps what it last counted of
 * the table, spends nothing and asks the room again, and counts the rest
 * exactly once when it comes; a session or checkpoint it counted that the
 * doc has lost keeps the table not whole. And a page whose signature checks
 * ran out of time: nothing spent until a slice has checked the rest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { nextSid, pocketOf } from './computedFold';
import type { Checkpoint } from './computedFold';
import { black, ComputedKit, red, TEST_CTX, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import { payoutFor } from './games/roulette';
import type { RouletteBet } from './games/roulette';

type Page = {
  casino: typeof import('./casinoDoc');
  doc: Y.Doc;
  asked: () => number;
};

const OWNER = 'owner-Alice';

vi.stubGlobal('window', { location: { search: '' } });

vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

/** A page that counts how often it asks the room for what it is missing,
 *  and whose checks never run out of time unless a spec says so. */
async function loadPage(clientID: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const doc = new Y.Doc();
  doc.clientID = clientID;
  let asks = 0;
  casino.setComputedVerifyForTests({ now: () => 0 });
  casino.bindCasinoDoc(doc, '', () => { asks += 1; });
  return { casino, doc, asked: () => asks };
}

function sync(...pages: Page[]): void {
  for (const x of pages) {
    for (const y of pages) if (x !== y) Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc)));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Page p's writes, one update each, as it sent them. */
function updatesOf(p: Page, act: () => void): Uint8Array[] {
  const out: Uint8Array[] = [];
  const take = (u: Uint8Array): void => { out.push(u); };
  p.doc.on('update', take);
  act();
  p.doc.off('update', take);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const TABLE = 'roulette-1';
const OTHER = 'roulette-2';
const INC = TEST_CTX.inc;
const kit = new ComputedKit({ room: '', t: TABLE, inc: INC });
const AMY = testIdentity('amy', 'player-Amy');
const BOB = testIdentity('bob', 'player-Bob');

const deltaOf = (b: RouletteBet[], pocket: number): number =>
  b.reduce((n, x) => n + payoutFor(x, pocket), 0) - b.reduce((n, x) => n + x.amount, 0);

function pin(page: Page, ...ids: TestIdentity[]): void {
  page.doc.transact(() => {
    for (const id of ids) page.doc.getMap('players').set(id.pid, { keyB64: id.pub });
  });
}

function put(page: Page, ...recs: Built<unknown>[]): void {
  const ses = page.casino.computedSessionForWrite(TABLE)!;
  page.doc.transact(() => {
    for (const r of recs) ses.set(r.key, r.rec);
  });
}

function trimTx(page: Page, cp: Checkpoint, copies: Built<unknown>[] = []): void {
  const map = page.doc.getMap('casinoComputed');
  page.doc.transact(() => {
    map.set(`sum:${TABLE}:${INC}`, cp);
    map.delete(`ses:${TABLE}:${INC}:${cp.b}`);
    const ses = new Y.Map<unknown>();
    map.set(`ses:${TABLE}:${INC}:${nextSid(kit.ctx, cp)}`, ses);
    for (const r of copies) ses.set(r.key, r.rec);
  });
}

/** Page x and page p, Amy (100 chips) with 10 on red in round 1 and Bob
 *  (100) with 20 on black, the close down: both pages hold their stakes. */
async function frozenRound(): Promise<{ x: Page; p: Page; sa: Built<unknown>; sb: Built<unknown>; close: Built<unknown> }> {
  const x = await loadPage(1);
  const p = await loadPage(2);
  x.casino.buyInChips(AMY.pid, 100);
  x.casino.buyInChips(BOB.pid, 100);
  pin(x, AMY, BOB);
  x.doc.transact(() => {
    x.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
    x.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
  });
  const sa = kit.slip(AMY, 1, [red(10)]);
  const sb = kit.slip(BOB, 1, [black(20)]);
  const close = kit.close(AMY, 1, 'g', [sa, sb]);
  put(x, sa, sb, close);
  sync(x, p);
  for (const page of [x, p]) {
    expect(page.casino.readChips(AMY.pid)).toBe(90);
    expect(page.casino.readChips(BOB.pid)).toBe(80);
  }
  return { x, p, sa, sb, close };
}

const pocket1 = pocketOf(kit.ctx, 1, [kit.seed(AMY.pid, 1), kit.seed(BOB.pid, 1)]);
const amyNet = deltaOf([red(10)], pocket1);
const bobNet = deltaOf([black(20)], pocket1);

describe('a page holding part of an update', () => {
  it('a part to come that touches no computed record: the counts stand, settled, but nothing is spent', async () => {
    const { x, p } = await frozenRound();
    const [seat, reveals] = updatesOf(p, () => {
      p.doc.getMap('casino').set(`seat:${TABLE}:${BOB.pid}`, { stand: 0, angle: 0, at: 1 });
      put(p, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    });
    Y.applyUpdate(x.doc, reveals); // parked whole: it builds on the seat
    expect(x.casino.casinoWhole()).toBe(false);
    expect(x.casino.casinoWhole(TABLE)).toBe(false);
    expect(x.asked()).toBeGreaterThan(0);
    // The documented rule: computedSettled is about the computed tables'
    // own waits (parked, or checks pending), not the doc's: this table
    // read nothing as gone, so it is settled, and casinoWhole() alone
    // stops every spend.
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(90);
    expect(x.casino.spendChips(AMY.pid, 1)).toBe(false);
    expect(x.casino.cashOutChips(AMY.pid, 90)).toBe(0);
    Y.applyUpdate(x.doc, seat);
    expect(x.casino.casinoWhole(TABLE)).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(100 + amyNet);
    expect(x.casino.readChips(BOB.pid)).toBe(100 + bobNet);
  });

  it('a record read as gone meanwhile: the table is parked, its counts frozen, not settled, nothing spent, a resync asked', async () => {
    const { x, p, sa, sb } = await frozenRound();
    const seen: number[] = [];
    x.casino.subscribeCasinoKey(`bal:${AMY.pid}`, () => seen.push(x.casino.readChips(AMY.pid)));
    // p puts Amy's and Bob's slips back (a re-put: the same bytes under the
    // same keys) and the reveals; x gets that before the seat it builds on,
    // so the re-put's deletes of the slips x holds apply at once.
    const [seat, rest] = updatesOf(p, () => {
      p.doc.getMap('casino').set(`seat:${TABLE}:${BOB.pid}`, { stand: 0, angle: 0, at: 1 });
      put(p, sa, sb, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    });
    Y.applyUpdate(x.doc, rest);
    const live = x.doc.getMap('casinoComputed').get(`ses:${TABLE}:${INC}:g`) as Y.Map<unknown>;
    expect(live.has(sa.key)).toBe(false); // read as gone
    expect(x.casino.casinoWhole(TABLE)).toBe(false);
    expect(x.asked()).toBeGreaterThan(0);
    expect(x.casino.computedSettled()).toBe(false);
    expect(x.casino.computedSettled(TABLE)).toBe(false);
    expect(x.casino.computedSettled(OTHER)).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(90); // still held
    expect(x.casino.readChips(BOB.pid)).toBe(80);
    expect(x.casino.computedFoldOf(TABLE)!.held).toEqual(new Map([[AMY.pid, 10n], [BOB.pid, 20n]]));
    expect(x.casino.spendChips(AMY.pid, 1)).toBe(false);
    // Another transaction meanwhile counts nothing of the table either.
    x.casino.buyInChips(AMY.pid, 1);
    expect(x.casino.readChips(AMY.pid)).toBe(91);
    Y.applyUpdate(x.doc, seat);
    expect(x.casino.casinoWhole(TABLE)).toBe(true);
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(101 + amyNet);
    expect(x.casino.readChips(BOB.pid)).toBe(100 + bobNet);
    expect(seen).toEqual([91, 101 + amyNet]);
  });

  it('a trim split so its deletes apply first: not whole, a resync asked, and the round counted once when the rest comes', async () => {
    const { x, p, close } = await frozenRound();
    const next = kit.slip(AMY, 2, [red(5)]);
    // The round decided and trimmed in one transaction: its nets go
    // straight into the checkpoint.
    const cp = kit.checkpoint(BOB, 'g', 1, close.hash, { [AMY.pid]: BigInt(amyNet), [BOB.pid]: BigInt(bobNet) });
    const [seat, decideAndTrim] = updatesOf(p, () => {
      p.doc.getMap('casino').set(`seat:${TABLE}:${BOB.pid}`, { stand: 0, angle: 0, at: 1 });
      p.doc.transact(() => {
        put(p, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
        trimTx(p, cp, [next]);
      });
    });
    expect(p.casino.readChips(AMY.pid)).toBe(100 + amyNet - 5);
    const seen: number[] = [];
    x.casino.subscribeCasinoKey(`bal:${AMY.pid}`, () => seen.push(x.casino.readChips(AMY.pid)));
    const asked = x.asked();
    Y.applyUpdate(x.doc, decideAndTrim);
    expect(x.doc.getMap('casinoComputed').has(`ses:${TABLE}:${INC}:g`)).toBe(false); // the delete applied
    expect(x.doc.getMap('casinoComputed').has(`sum:${TABLE}:${INC}`)).toBe(false); // the write parked
    expect(x.casino.casinoWhole(TABLE)).toBe(false);
    expect(x.asked()).toBe(asked + 1);
    expect(x.casino.computedSettled(TABLE)).toBe(false);
    expect(x.casino.readChips(AMY.pid)).toBe(90); // as last counted
    expect(x.casino.readChips(BOB.pid)).toBe(80);
    Y.applyUpdate(x.doc, seat);
    expect(x.casino.casinoWhole(TABLE)).toBe(true);
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.computedFoldOf(TABLE)!.base.sid).toBe(nextSid(kit.ctx, cp));
    expect(x.casino.readChips(AMY.pid)).toBe(100 + amyNet - 5);
    expect(x.casino.readChips(BOB.pid)).toBe(100 + bobNet);
    expect(seen).toEqual([100 + amyNet - 5]);
  });
});

describe('the rest of an update', () => {
  it('coming in another map: what waited is read whole and counted then', async () => {
    const { x, p } = await frozenRound();
    const amyReveal = kit.reveal(1, AMY.pid);
    put(p, amyReveal, kit.reveal(1, BOB.pid));
    sync(x, p);
    expect(x.casino.readChips(AMY.pid)).toBe(100 + amyNet);
    // p takes Amy's reveal back out (no build does) beside a seat; x gets
    // that before p's write elsewhere, which the seat builds on. The delete
    // applies at once; the rest comes in a transaction of other maps.
    const [elsewhere, rest] = updatesOf(p, () => {
      p.doc.getMap('elsewhere').set('a', 1);
      p.doc.transact(() => {
        p.casino.computedSessionForWrite(TABLE)!.delete(amyReveal.key);
        p.doc.getMap('casino').set(`seat:${TABLE}:${BOB.pid}`, { stand: 0, angle: 0, at: 1 });
      });
    });
    Y.applyUpdate(x.doc, rest);
    expect(x.casino.computedSettled()).toBe(false);
    expect(x.casino.readChips(AMY.pid)).toBe(100 + amyNet); // as last counted
    Y.applyUpdate(x.doc, elsewhere);
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.computedFoldOf(TABLE)!.tip).not.toBeNull(); // undecided again
    expect(x.casino.readChips(AMY.pid)).toBe(90);
    expect(x.casino.readChips(BOB.pid)).toBe(80);
  });

  it('a delete in the part that came first and records in the part to come: read whole, the delete counted too', async () => {
    const x = await loadPage(1);
    const p = await loadPage(2);
    x.casino.buyInChips(AMY.pid, 100);
    x.casino.buyInChips(BOB.pid, 100);
    pin(x, AMY, BOB);
    x.doc.transact(() => {
      x.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
      x.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
    });
    const sa = kit.slip(AMY, 1, [red(10)]);
    put(x, sa, kit.slip(BOB, 1, [black(20)]));
    sync(x, p);
    const [elsewhere, rest] = updatesOf(p, () => {
      p.doc.getMap('elsewhere').set('a', 1);
      p.doc.transact(() => {
        const ses = p.casino.computedSessionForWrite(TABLE)!;
        ses.delete(sa.key); // no build does
        const vb = kit.slip(BOB, 1, [black(25)], { v: 2 });
        ses.set(vb.key, vb.rec);
      });
    });
    Y.applyUpdate(x.doc, rest);
    expect(x.casino.readChips(AMY.pid)).toBe(90);
    Y.applyUpdate(x.doc, elsewhere); // Bob's new version comes: a change of the session's own
    expect(x.casino.readChips(AMY.pid)).toBe(100);
    expect(x.casino.readChips(BOB.pid)).toBe(75);
    sync(x, p);
    expect(p.casino.readChips(AMY.pid)).toBe(100);
  });
});

describe('a session or checkpoint this page counted, gone with nothing naming it', () => {
  it('a session map deleted with no checkpoint closing it keeps the table not whole, its counts standing', async () => {
    const { x, p } = await frozenRound();
    const asked = x.asked();
    p.doc.getMap('casinoComputed').delete(`ses:${TABLE}:${INC}:g`); // no build does
    sync(x, p);
    expect(x.casino.casinoWhole()).toBe(true);
    expect(x.casino.casinoWhole(TABLE)).toBe(false);
    expect(x.casino.casinoWhole(OTHER)).toBe(true);
    expect(x.asked()).toBe(asked + 1);
    expect(x.casino.computedSettled(TABLE)).toBe(false);
    // Frozen, as a table whose book is lost: the table waits for nothing
    // that will come, so the rest of the casino goes on beside it, her
    // stake on its felt still held.
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(90);
    expect(x.casino.spendChips(AMY.pid, 1)).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(89);
    // It stays so: later transactions, and the rest of the room's, change nothing.
    x.casino.buyInChips(BOB.pid, 1);
    p.doc.getMap('casinoComputed').set('note', 1);
    sync(x, p);
    expect(x.casino.casinoWhole(TABLE)).toBe(false);
    expect(x.casino.computedSettled(TABLE)).toBe(false);
    expect(x.casino.readChips(AMY.pid)).toBe(89);
    // A page that never counted the session reads the doc as it is.
    expect(p.casino.casinoWhole(TABLE)).toBe(false); // p counted it too
    const fresh = await loadPage(3);
    sync(x, fresh);
    expect(fresh.casino.casinoWhole(TABLE)).toBe(true);
    expect(fresh.casino.readChips(AMY.pid)).toBe(99); // nothing held, the chip she spent gone
  });

  it('a checkpoint deleted (or turned to junk) keeps the table not whole', async () => {
    const { x, p, close } = await frozenRound();
    put(x, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    const cp = kit.checkpoint(AMY, 'g', 1, close.hash, Object.fromEntries(x.casino.computedFoldOf(TABLE)!.nets));
    trimTx(x, cp);
    sync(x, p);
    for (const page of [x, p]) {
      expect(page.casino.casinoWhole(TABLE)).toBe(true);
      expect(page.casino.readChips(AMY.pid)).toBe(100 + amyNet);
    }
    p.doc.getMap('casinoComputed').set(`sum:${TABLE}:${INC}`, { ...cp, u: 1.5 });
    x.doc.getMap('casinoComputed').delete(`sum:${TABLE}:${INC}`);
    for (const page of [x, p]) {
      expect(page.casino.casinoWhole(TABLE)).toBe(false);
      expect(page.casino.readChips(AMY.pid)).toBe(100 + amyNet);
    }
  });

  it('a session or checkpoint of a table nobody switched on, made and deleted by a peer: that table frozen, the rest of the casino spends', async () => {
    const GHOST = 'ghost';
    const x = await loadPage(1);
    const p = await loadPage(2);
    x.casino.buyInChips(AMY.pid, 100);
    sync(x, p);
    const map = p.doc.getMap('casinoComputed');
    map.set(`ses:${GHOST}:${INC}:g`, new Y.Map()); // no switch, no records
    map.set(`sum:${OTHER}:${INC}`, kit.checkpoint(AMY, 'g', 1, 'e'.repeat(32), {}));
    sync(x, p);
    map.delete(`ses:${GHOST}:${INC}:g`); // no build does
    map.set(`sum:${OTHER}:${INC}`, { junk: true });
    sync(x, p);
    expect(x.casino.casinoWhole()).toBe(true);
    for (const t of [GHOST, OTHER]) {
      expect(x.casino.casinoWhole(t)).toBe(false);
      expect(x.casino.computedSettled(t)).toBe(false);
      expect(x.casino.isComputedTable(t)).toBe(false);
    }
    expect(x.casino.casinoWhole(TABLE)).toBe(true);
    // A lost book freezes its table and no other, and so does this: PR 1's
    // spends, nowhere near either table, go on.
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(100);
    expect(x.casino.spendChips(AMY.pid, 10)).toBe(true);
    expect(x.casino.cashOutChips(AMY.pid, 20)).toBe(20);
    expect(x.casino.readChips(AMY.pid)).toBe(70);
    // And so it stays, later transactions and all.
    x.casino.buyInChips(BOB.pid, 1);
    sync(x, p);
    expect(x.casino.casinoWhole(GHOST)).toBe(false);
    expect(x.casino.spendChips(AMY.pid, 1)).toBe(true);
  });

  it('a trim heard whole is no loss: the checkpoint closes the session it deleted', async () => {
    const { x, p, close } = await frozenRound();
    put(p, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    trimTx(p, kit.checkpoint(AMY, 'g', 1, close.hash, Object.fromEntries(p.casino.computedFoldOf(TABLE)!.nets)));
    const asked = x.asked();
    sync(x, p);
    expect(x.casino.casinoWhole(TABLE)).toBe(true);
    expect(x.asked()).toBe(asked);
    expect(x.casino.readChips(AMY.pid)).toBe(100 + amyNet);
  });
});

describe('signatures not checked yet', () => {
  it('with a budget of 0 ms: pending, nothing spent, and once a slice has run, counted, with one notify', async () => {
    const x = await loadPage(1);
    const p = await loadPage(2);
    x.casino.buyInChips(AMY.pid, 100);
    x.casino.buyInChips(BOB.pid, 100);
    pin(x, AMY, BOB);
    x.doc.transact(() => {
      x.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
      x.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
    });
    sync(x, p);
    x.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const sa = kit.slip(AMY, 1, [red(10)]);
    const sb = kit.slip(BOB, 1, [black(20)]);
    put(p, sa, sb, kit.close(AMY, 1, 'g', [sa, sb]), kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    sync(x, p);
    const res = x.casino.computedFoldOf(TABLE)!;
    expect(res.pending).toBe(true);
    expect(res.rounds).toEqual([]);
    expect(res.held.size).toBe(0); // nothing checked: no felt yet
    expect(x.casino.computedSettled()).toBe(false);
    expect(x.casino.computedSettled(TABLE)).toBe(false);
    expect(x.casino.casinoWhole()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(100);
    expect(x.casino.spendChips(AMY.pid, 1)).toBe(false);
    expect(x.casino.cashOutChips(AMY.pid, 100)).toBe(0);
    const slices: unknown[] = [];
    const spy = (tr: Y.Transaction): void => { slices.push(tr.origin); };
    x.doc.on('afterTransaction', spy);
    await flush();
    x.doc.off('afterTransaction', spy);
    expect(slices).toEqual([]); // a budget of none queues no slice
    expect(x.casino.computedFoldOf(TABLE)!.pending).toBe(true);
    let told = 0;
    const seen: number[] = [];
    x.casino.subscribeCasino(() => { told += 1; });
    x.casino.subscribeCasinoKey(`bal:${AMY.pid}`, () => seen.push(x.casino.readChips(AMY.pid)));
    x.casino.setComputedVerifyForTests({ now: () => 0 }); // the budget back: the slice it queues checks the rest
    expect(told).toBe(0);
    await flush();
    expect(x.casino.computedFoldOf(TABLE)!.pending).toBe(false);
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(100 + amyNet);
    expect(x.casino.readChips(BOB.pid)).toBe(100 + bobNet);
    expect(told).toBe(1);
    expect(seen).toEqual([100 + amyNet]);
    expect(x.casino.spendChips(AMY.pid, 1)).toBe(true);
  });

  it('a slice queued on a doc rebound since runs nothing there', async () => {
    const x = await loadPage(1);
    pin(x, AMY);
    x.doc.transact(() => {
      x.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
      x.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
    });
    let clock = 0;
    x.casino.setComputedVerifyForTests({ now: () => (clock += 50) });
    put(x, kit.slip(AMY, 1, [red(1)]), kit.slip(AMY, 1, [red(2)], { v: 2 }), kit.close(AMY, 1, 'g', [kit.slip(AMY, 1, [red(1)])]));
    expect(x.casino.computedFoldOf(TABLE)!.pending).toBe(true);
    const old = x.doc;
    const origins: unknown[] = [];
    old.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    x.casino.bindCasinoDoc(new Y.Doc());
    await flush();
    expect(origins).toEqual([]);
  });
});

describe('a page bound to another doc', () => {
  it('nothing of the old doc stands, and nothing written there moves the new one', async () => {
    const { x, p, sa, sb, close } = await frozenRound();
    // x parks the table (a record read as gone, as above), then moves on.
    const [, rest] = updatesOf(p, () => {
      p.doc.getMap('casino').set(`seat:${TABLE}:${BOB.pid}`, { stand: 0, angle: 0, at: 1 });
      put(p, sa, sb);
    });
    Y.applyUpdate(x.doc, rest);
    expect(x.casino.computedSettled()).toBe(false);
    const old = x.doc;
    const fresh = new Y.Doc();
    x.casino.bindCasinoDoc(fresh);
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.casinoWhole(TABLE)).toBe(true);
    fresh.getMap('casinoComputed').set(`ses:${OTHER}:${INC}:g`, new Y.Map());
    x.casino.buyInChips(AMY.pid, 50);
    expect(x.casino.readChips(AMY.pid)).toBe(50);
    expect(x.casino.computedSettled()).toBe(true);
    // The old doc goes on without this page.
    old.getMap('casinoComputed').set(`sum:${TABLE}:${INC}`, kit.checkpoint(AMY, 'g', 1, close.hash, { [AMY.pid]: 1000n }));
    expect(x.casino.readChips(AMY.pid)).toBe(50);
    expect(x.casino.computedSettled()).toBe(true);
  });

  it('in the same room: told once by the bind, then only of what moves in the new doc', async () => {
    const q = await loadPage(3);
    q.casino.buyInChips(AMY.pid, 100);
    pin(q, AMY);
    q.doc.transact(() => {
      q.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
      q.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
    });
    put(q, kit.slip(AMY, 1, [red(30)]));
    const x = await loadPage(1);
    const old = x.doc;
    const there = new Y.Doc();
    Y.applyUpdate(there, Y.encodeStateAsUpdate(q.doc));
    const told = { amy: 0, view: 0 };
    x.casino.subscribeCasinoKey(`bal:${AMY.pid}`, () => { told.amy += 1; });
    x.casino.subscribeCasinoKey(`computed:${TABLE}`, () => { told.view += 1; });
    x.casino.bindCasinoDoc(there);
    expect(x.casino.readChips(AMY.pid)).toBe(70);
    expect(told).toEqual({ amy: 1, view: 1 }); // the bind's repaint
    old.getMap('players').set(BOB.pid, { keyB64: BOB.pub }); // a key pinned in the doc it left
    x.casino.buyInChips(BOB.pid, 5);
    expect(told).toEqual({ amy: 1, view: 1 });
  });

  it('in another room: its own checks, run in its own slices, and no verdict of the old room', async () => {
    const q = await loadPage(3);
    q.casino.buyInChips(AMY.pid, 100);
    pin(q, AMY, BOB);
    q.doc.transact(() => {
      q.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
      q.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
    });
    put(q, kit.slip(AMY, 1, [red(30)]), kit.slip(AMY, 1, [red(40)], { v: 2 }));
    const x = await loadPage(1);
    sync(q, x); // x checks both versions, in room ''
    expect(x.casino.readChips(AMY.pid)).toBe(60);
    const there = new Y.Doc();
    Y.applyUpdate(there, Y.encodeStateAsUpdate(q.doc));
    // x's checks run past their budget: a slice waits on the doc it leaves.
    let clock = 0;
    x.casino.setComputedVerifyForTests({ now: () => (clock += 50) });
    put(x, kit.slip(AMY, 1, [red(50)], { v: 3 }), kit.slip(BOB, 1, [red(5)]));
    expect(x.casino.computedFoldOf(TABLE)!.pending).toBe(true);
    const slices: unknown[] = [];
    there.on('afterTransaction', (tr: Y.Transaction) => { if (typeof tr.origin === 'symbol') slices.push(tr.origin); });
    x.casino.bindCasinoDoc(there, 'room-2'); // the same records, signed for room ''
    expect(x.casino.computedSettled()).toBe(false);
    await flush();
    expect(slices.length).toBe(1); // its own: the one queued before runs nowhere
    const res = x.casino.computedFoldOf(TABLE)!;
    expect(res.pending).toBe(false);
    expect(res.held.size).toBe(0);
    expect(x.casino.computedSettled()).toBe(true);
    expect(x.casino.readChips(AMY.pid)).toBe(100);
  });
});
