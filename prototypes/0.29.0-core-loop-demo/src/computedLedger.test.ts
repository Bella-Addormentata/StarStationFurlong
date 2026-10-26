/**
 * 🧮🧾 Computed tables in the chip sum (casinoDoc COMPUTED TABLES).
 *
 * A computed table's records are folded on every page into two more terms
 * of PR 1's sum: each bettor's decided net, in the ledger, and what their
 * felt holds now, off their chips. These specs pin the sum through a round
 * (slip, close, reveals) on the page that writes it and on one that hears
 * it, that a listener never sees a stake held and paid at once, that the
 * cage still balances beside every PR 1 kind of record, the debt two tables
 * staking the same chips leave, which incarnations hold and which only pay,
 * a trim that moves nothing, and that a room with no computed records reads
 * as it did before. Then the reads later commits build on.
 *
 * Each page is its own load of the casino modules and its own Y.Doc, synced
 * by hand. Records come from computedTestKit, signed for this room ('') and
 * written straight into the doc's `casinoComputed` map, as an honest page's
 * duties will write them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { nextSid, pocketOf } from './computedFold';
import type { Checkpoint, FoldCtx } from './computedFold';
import { black, ComputedKit, red, straight, TEST_CTX, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import { payoutFor } from './games/roulette';
import type { RouletteBet } from './games/roulette';

type Page = {
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  doc: Y.Doc;
};

const OWNER = 'owner-Alice';

vi.stubGlobal('window', { location: { search: '' } });

vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

/** A page whose checks never run out of time (a fixed budget clock), so
 *  every transaction counts its records whole, however slow the machine. */
async function loadPage(clientID: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const doc = new Y.Doc();
  doc.clientID = clientID;
  casino.setComputedVerifyForTests({ now: () => 0 });
  casino.bindCasinoDoc(doc);
  return { casino, croupier, doc };
}

function sync(...pages: Page[]): void {
  for (const x of pages) {
    for (const y of pages) if (x !== y) Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc)));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function spinTo(pocket: number): void {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = pocket;
    return arr;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const TABLE = 'roulette-1';
const OTHER = 'roulette-2';
const LEGACY = 'roulette-9';
const INC = TEST_CTX.inc;
const INC2 = 'c' + 'ab'.repeat(12);
const ctxOf = (t: string, inc: string): FoldCtx => ({ room: '', t, inc });
const kit = new ComputedKit(ctxOf(TABLE, INC));
const kit2 = new ComputedKit(ctxOf(OTHER, INC2));

const AMY = testIdentity('amy', 'player-Amy');
const BOB = testIdentity('bob', 'player-Bob');
const CAL = testIdentity('cal', 'player-Cal');

const stakeOf = (b: RouletteBet[]): number => b.reduce((n, x) => n + x.amount, 0);
const deltaOf = (b: RouletteBet[], pocket: number): number => b.reduce((n, x) => n + payoutFor(x, pocket), 0) - stakeOf(b);
/** The pocket a round decided on every reveal of `ids` comes to. */
const pocketFor = (k: ComputedKit, r: number, ids: TestIdentity[]): number => pocketOf(k.ctx, r, ids.map((id) => k.seed(id.pid, r)));
/** A straight bet that misses (or hits) round r's pocket. */
const straightThat = (hit: boolean, pocket: number, amount: number): RouletteBet => straight(hit ? pocket : (pocket + 1) % 37, amount);

/** The room's players map shows each identity's key: this page pins it. */
function pin(page: Page, ...ids: TestIdentity[]): void {
  page.doc.transact(() => {
    for (const id of ids) page.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** The house's switch-on, as commit 4 writes it: the switch and the first session. */
function switchOn(page: Page, t = TABLE, inc = INC): void {
  page.doc.transact(() => {
    page.doc.getMap('casino').set(`cfg:computed:${t}`, { v: 1, inc });
    page.doc.getMap('casinoComputed').set(`ses:${t}:${inc}:g`, new Y.Map());
  });
}

/** Records into a table's live session, in one transaction. */
function put(page: Page, ...recs: Built<unknown>[]): void {
  putAt(page, TABLE, ...recs);
}
function putAt(page: Page, t: string, ...recs: Built<unknown>[]): void {
  const ses = page.casino.computedSessionForWrite(t)!;
  expect(ses, `${t} has a live session`).not.toBeNull();
  page.doc.transact(() => {
    for (const r of recs) ses.set(r.key, r.rec);
  });
}

/** A trim, as commit 3 writes one: the checkpoint, the session it closes
 *  (and any other of the incarnation) gone, the next one with `copies`. */
function trim(page: Page, cp: Checkpoint, copies: Built<unknown>[] = [], t = TABLE, inc = INC): void {
  const map = page.doc.getMap('casinoComputed');
  const next = nextSid(ctxOf(t, inc), cp);
  page.doc.transact(() => {
    map.set(`sum:${t}:${inc}`, cp);
    for (const key of [...map.keys()]) if (key.startsWith(`ses:${t}:${inc}:`)) map.delete(key);
    const ses = new Y.Map<unknown>();
    map.set(`ses:${t}:${inc}:${next}`, ses);
    for (const r of copies) ses.set(r.key, r.rec);
  });
}

/** One legacy (PR 1) roulette round, settled into its book. */
async function legacyRound(page: Page, table: string, bets: Record<string, RouletteBet[]>, pocket: number): Promise<void> {
  page.casino.writeCrapsFairnessPref(table, 'rng');
  page.croupier.openBetting(table, 1);
  for (const [pid, b] of Object.entries(bets)) page.casino.writeMyBets(table, pid, 1, b);
  page.croupier.closeBetting(table, page.casino.readTableState(table)!);
  spinTo(pocket);
  page.croupier.rollAndSettle(table, 1);
  await flush();
  vi.restoreAllMocks();
  expect(page.casino.readTableState(table)).toMatchObject({ phase: 'settled', round: 1, result: pocket });
}

function listen(page: Page, pid: string): { calls: number; reads: number[] } {
  const seen = { calls: 0, reads: [] as number[] };
  page.casino.subscribeCasinoKey(`bal:${pid}`, () => {
    seen.calls += 1;
    seen.reads.push(page.casino.readChips(pid));
  });
  return seen;
}

describe('readChips: legacy balance + chip records + books + computed nets − held', () => {
  it('through a slip, its close and the reveals, on the writing page and on one that hears it', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.doc.getMap('casino').set(`bal:${AMY.pid}`, 50); // an earlier build's balance
    a.casino.buyInChips(AMY.pid, 100);
    a.casino.buyInChips(BOB.pid, 100);
    await legacyRound(a, LEGACY, { [AMY.pid]: [red(10)] }, 1); // red: amy +10 in that book
    pin(a, AMY, BOB);
    switchOn(a);
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.readChips(AMY.pid)).toBe(160);
      expect(page.casino.isComputedTable(TABLE)).toBe(true);
    }
    const amyBets = [red(10), straight(7, 2)];
    const bobBets = [black(5)];
    const sa = kit.slip(AMY, 1, amyBets);
    const sb = kit.slip(BOB, 1, bobBets);
    put(a, sa, sb);
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.readChips(AMY.pid)).toBe(160 - 12);
      expect(page.casino.readChips(BOB.pid)).toBe(100 - 5);
    }
    put(a, kit.close(AMY, 1, 'g', [sa, sb]));
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.computedFoldOf(TABLE)!.tip).not.toBeNull();
      expect(page.casino.readChips(AMY.pid)).toBe(160 - 12); // frozen: still held
      expect(page.casino.readChips(BOB.pid)).toBe(100 - 5);
    }
    put(a, kit.reveal(1, AMY.pid));
    sync(a, b);
    for (const page of [a, b]) expect(page.casino.readChips(AMY.pid)).toBe(160 - 12); // one seed of two
    put(a, kit.reveal(1, BOB.pid));
    sync(a, b);
    const pocket = pocketFor(kit, 1, [AMY, BOB]);
    for (const page of [a, b]) {
      expect(page.casino.computedFoldOf(TABLE)!.rounds[0]).toMatchObject({ decided: 'reveals', pocket });
      expect(page.casino.readChips(AMY.pid)).toBe(160 + deltaOf(amyBets, pocket));
      expect(page.casino.readChips(BOB.pid)).toBe(100 + deltaOf(bobBets, pocket));
    }
  });

  it('a page joining after the round counts it as the others do', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    const bets = [red(20)];
    const s = kit.slip(AMY, 1, bets);
    put(a, s, kit.close(AMY, 1, 'g', [s]), kit.reveal(1, AMY.pid));
    put(a, kit.slip(AMY, 2, [black(3)])); // and round 2's felt
    const late = await loadPage(2);
    sync(a, late);
    const want = 100 + deltaOf(bets, pocketFor(kit, 1, [AMY])) - 3;
    expect(a.casino.readChips(AMY.pid)).toBe(want);
    expect(late.casino.readChips(AMY.pid)).toBe(want);
    // Bound on a copy of the doc, as the room cache gives one.
    const cached = await loadPage(3);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.doc));
    cached.casino.bindCasinoDoc(copy);
    expect(cached.casino.readChips(AMY.pid)).toBe(want);
  });
});

describe('a bal: listener across a decide', () => {
  it('never sees a stake both held and paid, on either page', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.buyInChips(AMY.pid, 100);
    a.casino.buyInChips(BOB.pid, 100);
    pin(a, AMY, BOB);
    switchOn(a);
    const pocket = pocketFor(kit, 1, [AMY, BOB]);
    const amyBets = [straightThat(true, pocket, 10), red(5)]; // a straight win: 35 to 1
    const bobBets = [straightThat(false, pocket, 30)];
    const sa = kit.slip(AMY, 1, amyBets);
    const sb = kit.slip(BOB, 1, bobBets);
    put(a, sa, sb, kit.close(BOB, 1, 'g', [sa, sb]), kit.reveal(1, AMY.pid));
    sync(a, b);
    const seen = [a, b].flatMap((page) => [listen(page, AMY.pid), listen(page, BOB.pid)]);
    put(a, kit.reveal(1, BOB.pid));
    sync(a, b);
    const amyAfter = 100 + deltaOf(amyBets, pocket);
    expect(amyAfter).toBeGreaterThan(100 + 300);
    const want = [{ calls: 1, reads: [amyAfter] }, { calls: 1, reads: [70] }];
    expect(seen).toEqual([...want, ...want]);
  });
});

describe('the cage ledger beside every kind of record', () => {
  it('balances: the house is up what the tables won, plus what is on their felts', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    const casino = a.doc.getMap('casino');
    // An earlier build bought Eve 100 chips, and her list on the legacy
    // table took 10 of them: a removal refunds those through end:.
    casino.set(`bought:player-Eve`, 100);
    casino.set(`bal:player-Eve`, 90);
    for (const id of [AMY, BOB, CAL]) a.casino.buyInChips(id.pid, 200);
    expect(a.casino.cashOutChips(CAL.pid, 50)).toBe(50);
    await legacyRound(a, LEGACY, { [AMY.pid]: [red(20)], [BOB.pid]: [black(10)] }, 1); // amy +20, bob −10
    // A live PR 1 list on another legacy table, and Eve's earlier build's
    // list on a third, removed.
    a.casino.writeCrapsFairnessPref('roulette-8', 'rng');
    a.croupier.openBetting('roulette-8', 1);
    a.casino.writeMyBets('roulette-8', CAL.pid, 1, [red(7)]);
    a.casino.writeCrapsFairnessPref('roulette-7', 'rng');
    a.croupier.openBetting('roulette-7', 1);
    casino.set(`bets:roulette-7:player-Eve`, { round: 1, bets: [red(10)] });
    a.croupier.closeTable('roulette-7', 'local');
    await flush();
    expect(a.casino.readChips('player-Eve')).toBe(100);
    // A computed table: a decided round and an open one.
    pin(a, AMY, BOB, CAL);
    switchOn(a);
    const pocket = pocketFor(kit, 1, [AMY, BOB]);
    const amyBets = [straightThat(true, pocket, 4)];
    const bobBets = [straightThat(false, pocket, 25)];
    const sa = kit.slip(AMY, 1, amyBets);
    const sb = kit.slip(BOB, 1, bobBets);
    put(a, sa, sb, kit.close(AMY, 1, 'g', [sa, sb]), kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    put(a, kit.slip(CAL, 2, [red(9)]), kit.slip(AMY, 2, [black(11)]));
    sync(a, b);
    const tablesWon = 20 - 10 + deltaOf(amyBets, pocket) + deltaOf(bobBets, pocket);
    const onFelts = 7 + 9 + 11;
    for (const page of [a, b]) {
      const cage = page.casino.readCageLedger();
      const balances = Object.values(cage.balances).reduce((n, x) => n + x, 0);
      expect(cage.issued).toBe(600 + 100);
      expect(cage.cashed).toBe(50);
      expect(cage.outstanding).toBe(balances);
      expect(cage.houseNet).toBe(cage.issued - cage.cashed - cage.outstanding);
      expect(cage.houseNet).toBe(onFelts - tablesWon);
      expect(cage.balances).toEqual({
        [AMY.pid]: 200 + 20 + deltaOf(amyBets, pocket) - 11,
        [BOB.pid]: 200 - 10 + deltaOf(bobBets, pocket),
        [CAL.pid]: 150 - 7 - 9,
        'player-Eve': 100,
      });
    }
  });
});

describe('two computed tables staking the same chips at once', () => {
  it('both hold, the balance reads 0, and the debt they leave is paid off by the next credit first', async () => {
    const tabA = await loadPage(1); // Amy's tab at one table
    const tabB = await loadPage(2); // her other tab at the other
    tabA.casino.buyInChips(AMY.pid, 10);
    pin(tabA, AMY);
    switchOn(tabA, TABLE, INC);
    switchOn(tabA, OTHER, INC2);
    sync(tabA, tabB);
    // Neither tab has heard the other's slip: each has her 10 to stake.
    const p1 = pocketFor(kit, 1, [AMY]);
    const p2 = pocketFor(kit2, 1, [AMY]);
    const s1 = kit.slip(AMY, 1, [straightThat(false, p1, 10)]);
    const s2 = kit2.slip(AMY, 1, [straightThat(false, p2, 10)]);
    expect(tabA.casino.readChips(AMY.pid)).toBe(10);
    putAt(tabA, TABLE, s1);
    expect(tabB.casino.readChips(AMY.pid)).toBe(10);
    putAt(tabB, OTHER, s2);
    sync(tabA, tabB);
    for (const page of [tabA, tabB]) expect(page.casino.readChips(AMY.pid)).toBe(0);
    putAt(tabA, TABLE, kit.close(AMY, 1, 'g', [s1]), kit.reveal(1, AMY.pid));
    putAt(tabB, OTHER, kit2.close(AMY, 1, 'g', [s2]), kit2.reveal(1, AMY.pid));
    sync(tabA, tabB);
    for (const page of [tabA, tabB]) {
      expect(page.casino.computedFoldOf(TABLE)!.nets.get(AMY.pid)).toBe(-10n);
      expect(page.casino.computedFoldOf(OTHER)!.nets.get(AMY.pid)).toBe(-10n);
      expect(page.casino.readChips(AMY.pid)).toBe(0); // −10, read as none
    }
    tabA.casino.creditChips(AMY.pid, 15);
    expect(tabA.casino.readChips(AMY.pid)).toBe(5);
    expect(tabA.casino.spendChips(AMY.pid, 6)).toBe(false);
    sync(tabA, tabB);
    expect(tabB.casino.readChips(AMY.pid)).toBe(5);
  });
});

describe('which incarnations hold, and which only pay', () => {
  /** Round 1 decided (amy's net), round 2's felt down (held). */
  async function midSession(): Promise<{ a: Page; b: Page; net: number; c1: Built<unknown>; s2: Built<unknown> }> {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    const bets = [red(10)];
    const s1 = kit.slip(AMY, 1, bets);
    const c1 = kit.close(AMY, 1, 'g', [s1]);
    put(a, s1, c1, kit.reveal(1, AMY.pid));
    const s2 = kit.slip(AMY, 2, [black(30)]);
    put(a, s2);
    sync(a, b);
    const net = deltaOf(bets, pocketFor(kit, 1, [AMY]));
    for (const page of [a, b]) expect(page.casino.readChips(AMY.pid)).toBe(100 + net - 30);
    return { a, b, net, c1, s2 };
  }

  it('deleting the switch hands the open stake back and keeps the decided net; putting it back holds again', async () => {
    const { a, b, net } = await midSession();
    a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.isComputedTable(TABLE)).toBe(false);
      expect(page.casino.readChips(AMY.pid)).toBe(100 + net);
    }
    a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
    sync(a, b);
    for (const page of [a, b]) expect(page.casino.readChips(AMY.pid)).toBe(100 + net - 30);
  });

  it('a switch naming another incarnation, or junk, holds nothing here', async () => {
    const { a, net } = await midSession();
    const cfgs: [unknown, string | null][] = [
      [{ v: 1, inc: INC2 }, INC2],
      [{ v: 1, inc: INC, at: 5 }, null], // not exactly {v, inc}
      [{ v: 2, inc: INC }, null],
      [{ v: 1, inc: 'c' + '0'.repeat(23) }, null],
      [{ v: 1, inc: INC.toUpperCase() }, null],
      ['on', null],
    ];
    for (const [cfg, inc] of cfgs) {
      a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, cfg);
      expect(a.casino.computedIncOf(TABLE), JSON.stringify(cfg)).toBe(inc);
      expect(a.casino.readChips(AMY.pid), JSON.stringify(cfg)).toBe(100 + net);
    }
  });

  it("a gone: mark for the incarnation hands the open stake back and keeps the decided net", async () => {
    const { a, b, net } = await midSession();
    a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.isComputedTable(TABLE)).toBe(false);
      expect(page.casino.computedSessionForWrite(TABLE)).toBeNull(); // its session is still in the doc
      expect(page.casino.readChips(AMY.pid)).toBe(100 + net);
    }
  });

  it('a checkpoint saying the incarnation ended hands the open stake back and keeps the decided net', async () => {
    const { a, b, net, c1 } = await midSession();
    const cp = kit.checkpoint(AMY, 'g', 1, c1.hash, { [AMY.pid]: BigInt(net) }, 1);
    a.doc.getMap('casinoComputed').set(`sum:${TABLE}:${INC}`, cp);
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.isComputedTable(TABLE)).toBe(false);
      expect(page.casino.computedSessionForWrite(TABLE)).toBeNull();
      expect(page.casino.readChips(AMY.pid)).toBe(100 + net);
    }
    // Compaction deletes the session the final checkpoint closed: nothing moves.
    a.doc.getMap('casinoComputed').delete(`ses:${TABLE}:${INC}:g`);
    sync(a, b);
    for (const page of [a, b]) {
      expect(page.casino.casinoWhole(TABLE)).toBe(true);
      expect(page.casino.readChips(AMY.pid)).toBe(100 + net);
    }
  });
});

describe('an incarnation ended by its checkpoint', () => {
  it('holds nothing of a session opened after it (no build writes one)', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    const cp = kit.checkpoint(AMY, 'g', 1, 'e'.repeat(32), {}, 1);
    const after = new Y.Map<unknown>();
    a.doc.transact(() => {
      a.doc.getMap('casinoComputed').set(`sum:${TABLE}:${INC}`, cp);
      a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:${kit.sidAfter(cp)}`, after);
    });
    const late = kit.slip(AMY, 2, [black(40)]);
    after.set(late.key, late.rec);
    expect(a.casino.computedFoldOf(TABLE)!.held.size).toBe(0); // the fold reads none of it either
    expect(a.casino.computedFoldOf(TABLE)!.felts.size).toBe(0);
    expect(a.casino.readChips(AMY.pid)).toBe(100); // the felt holds none of it
  });
});

describe('a trim: a checkpoint replacing a session with the same nets', () => {
  it('moves no balance and tells no bal: listener, and its copied slip holds as before', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.buyInChips(AMY.pid, 100);
    a.casino.buyInChips(BOB.pid, 100);
    pin(a, AMY, BOB);
    switchOn(a);
    const sa = kit.slip(AMY, 1, [red(10)]);
    const sb = kit.slip(BOB, 1, [black(10)]);
    const c1 = kit.close(BOB, 1, 'g', [sa, sb]);
    put(a, sa, sb, c1, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    const open = kit.slip(AMY, 2, [straight(3, 5)]);
    put(a, open);
    sync(a, b);
    const before = [a, b].map((page) => [page.casino.readChips(AMY.pid), page.casino.readChips(BOB.pid)]);
    const nets = a.casino.computedFoldOf(TABLE)!.nets;
    const seen = [a, b].flatMap((page) => [listen(page, AMY.pid), listen(page, BOB.pid)]);
    let told = 0;
    b.casino.subscribeCasino(() => { told += 1; });
    const cp = kit.checkpoint(AMY, 'g', 1, c1.hash, Object.fromEntries(nets));
    trim(a, cp, [open]);
    sync(a, b);
    expect([a, b].map((page) => [page.casino.readChips(AMY.pid), page.casino.readChips(BOB.pid)])).toEqual(before);
    expect(seen.map((s) => s.calls)).toEqual([0, 0, 0, 0]);
    expect(told).toBe(1); // the view moved: one notify all the same
    for (const page of [a, b]) {
      const res = page.casino.computedFoldOf(TABLE)!;
      expect(res.base).toMatchObject({ u: 1, sid: kit.sidAfter(cp) });
      expect(res.rounds).toEqual([]);
      expect(res.held).toEqual(new Map([[AMY.pid, 5n]]));
      expect(page.casino.casinoWhole(TABLE)).toBe(true);
    }
  });

  it('several trims heard at once, the sessions between them never seen, still count whole', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    sync(a, b);
    let cp: Checkpoint | null = null;
    let net = 0;
    for (let r = 1; r <= 3; r++) {
      const sid = nextSid(kit.ctx, cp);
      const bets = [red(r)];
      const s = kit.slip(AMY, r, bets);
      const c = kit.close(AMY, r, sid, [s]);
      put(a, s, c, kit.reveal(r, AMY.pid));
      net += deltaOf(bets, pocketFor(kit, r, [AMY]));
      cp = kit.checkpoint(AMY, sid, r, c.hash, { [AMY.pid]: BigInt(net) });
      trim(a, cp);
    }
    sync(a, b); // b counted the first session only, and hears three trims in one update
    for (const page of [a, b]) {
      expect(page.casino.casinoWhole(TABLE)).toBe(true);
      expect(page.casino.computedSettled()).toBe(true);
      expect(page.casino.readChips(AMY.pid)).toBe(100 + net);
    }
  });
});

describe('a room with no computed records', () => {
  /** A PR 1 scenario: buy-ins, a cash-out, an earlier build's balance, a book and a live list. */
  async function pr1(page: Page): Promise<void> {
    page.doc.getMap('casino').set(`bal:player-Eve`, 40);
    page.casino.buyInChips(AMY.pid, 100);
    page.casino.buyInChips(BOB.pid, 80);
    page.casino.cashOutChips(BOB.pid, 30);
    await legacyRound(page, LEGACY, { [AMY.pid]: [red(10)], [BOB.pid]: [black(10)] }, 1);
    page.croupier.openBetting(LEGACY, 2);
    page.casino.writeMyBets(LEGACY, AMY.pid, 2, [red(25)]);
  }

  it('reads every balance and the cage as before, and junk under casinoComputed changes none of it', async () => {
    const plain = await loadPage(1);
    await pr1(plain);
    const junked = await loadPage(2);
    junked.doc.getMap('casinoComputed').set('hello', 1);
    junked.doc.getMap('casinoComputed').set(`ses:${TABLE}:not-an-inc:g`, new Y.Map());
    junked.doc.getMap('casinoComputed').set(`sum:${TABLE}:${INC}x`, { v: 1 });
    junked.doc.getMap('casinoComputed').set(`ses:${OTHER}:${INC2}:not-a-sid`, new Y.Map());
    junked.doc.transact(() => { // a session set and deleted at once: never there
      junked.doc.getMap('casinoComputed').set(`ses:${OTHER}:${INC2}:g`, new Y.Map());
      junked.doc.getMap('casinoComputed').delete(`ses:${OTHER}:${INC2}:g`);
    });
    junked.doc.getMap('casino').set(`cfg:computed:${OTHER}`, { v: 1, inc: INC2 }); // a switch with no records
    await pr1(junked);
    const want = { [AMY.pid]: 100 + 10 - 25, [BOB.pid]: 80 - 30 - 10, 'player-Eve': 40 };
    for (const page of [plain, junked]) {
      for (const [pid, chips] of Object.entries(want)) expect(page.casino.readChips(pid)).toBe(chips);
      expect(page.casino.readCageLedger()).toEqual({
        issued: 180, cashed: 30, outstanding: 85 + 40 + 40, houseNet: 180 - 30 - 165, balances: want,
      });
      expect(page.casino.computedSettled()).toBe(true);
      expect(page.casino.isComputedTable(TABLE)).toBe(false);
      expect(page.casino.computedFoldOf(OTHER)).toBeNull();
    }
  });
});

describe('whose felt counts: the key the page pinned', () => {
  it("a player's slips hold once their key is pinned, in the very transaction that pins it", async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.buyInChips(BOB.pid, 100);
    switchOn(a);
    const s = kit.slip(BOB, 1, [red(40)]);
    put(a, s);
    sync(a, b);
    for (const page of [a, b]) expect(page.casino.readChips(BOB.pid)).toBe(100); // no key yet: no felt
    const seen = listen(b, BOB.pid);
    pin(a, BOB);
    sync(a, b);
    for (const page of [a, b]) expect(page.casino.readChips(BOB.pid)).toBe(60);
    expect(seen).toEqual({ calls: 1, reads: [60] });
  });

  it("a version of someone's felt signed by another key holds nothing of theirs", async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY, BOB);
    switchOn(a);
    put(a, kit.slip(AMY, 1, [red(5)]));
    put(a, kit.slip(BOB, 1, [red(90)], { p: AMY.pid, v: 9 })); // bob's key, amy's pid, a higher version
    expect(a.casino.readChips(AMY.pid)).toBe(95);
  });

  it("this page's own player's felt counts under its own key, whatever the players map shows", async () => {
    const a = await loadPage(1);
    const keypair = await import('./keypair'); // this page's own identity
    const me: TestIdentity = { pid: OWNER, pub: keypair.getIdentityPub(), sign: keypair.signIdentity };
    a.casino.buyInChips(OWNER, 100);
    pin(a, { ...BOB, pid: OWNER }); // bob's key shown under this page's pid
    switchOn(a);
    put(a, kit.slip(me, 1, [red(25)]));
    put(a, kit.slip(BOB, 1, [red(70)], { p: OWNER, v: 9 }));
    expect(a.casino.readChips(OWNER)).toBe(75);
  });

  it('a check that throws, or answers anything but true, fails the record', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    a.casino.buyInChips(BOB.pid, 100);
    pin(a, AMY, BOB);
    const sa = kit.slip(AMY, 1, [red(10)]);
    const sb = kit.slip(BOB, 1, [red(20)]);
    a.casino.setComputedVerifyForTests({
      now: () => 0,
      verify: (_pub, _bytes, sig) => {
        if (sig === sa.rec.g) throw new Error('a check that breaks');
        return 1 as unknown as boolean;
      },
    });
    switchOn(a);
    put(a, sa, sb);
    expect(a.casino.computedFoldOf(TABLE)!.held.size).toBe(0);
    expect(a.casino.readChips(AMY.pid)).toBe(100);
    expect(a.casino.readChips(BOB.pid)).toBe(100);
  });

  it("a slot bankroll's account is never a bettor", async () => {
    const a = await loadPage(1);
    const bankroll = 'slot-bankroll:machine:slot-1';
    a.doc.getMap('casino').set(bankroll, 500);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    const pocket = pocketOf(kit.ctx, 1, [kit.seed(AMY.pid, 1), kit.seed(bankroll, 1)]);
    const forged = kit.slip(AMY, 1, [straightThat(true, pocket, 10)], { p: bankroll });
    const mine = kit.slip(AMY, 1, [red(1)]);
    const told = listen(a, bankroll);
    put(a, forged, mine, kit.close(AMY, 1, 'g', [forged, mine]));
    expect(a.casino.computedFoldOf(TABLE)!.held.get(bankroll)).toBe(10n);
    expect(a.casino.readChips(bankroll)).toBe(500); // nothing of it held
    expect(told.calls).toBe(0);
    put(a, kit.reveal(1, bankroll, kit.seed(bankroll, 1)), kit.reveal(1, AMY.pid));
    expect(a.casino.computedFoldOf(TABLE)!.nets.get(bankroll)).toBe(350n);
    expect(a.casino.readCageLedger().balances[bankroll]).toBeUndefined();
    expect(a.casino.readSlotFundingBalance('slot-1', { mode: 'machine', ownerId: AMY.pid })).toBe(500);
  });
});

describe('what counts nothing', () => {
  it('another session map of the incarnation, whatever is written into it', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    const stray = new Y.Map<unknown>();
    a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:${'0'.repeat(24)}`, stray);
    const s = kit.slip(AMY, 1, [red(30)]);
    a.doc.transact(() => {
      stray.set(s.key, s.rec); // the nested map's own change, in a later transaction
      stray.set(kit.close(AMY, 1, 'g', [s]).key, kit.close(AMY, 1, 'g', [s]).rec);
    });
    stray.set(kit.reveal(1, AMY.pid).key, kit.reveal(1, AMY.pid).rec);
    expect(a.casino.readChips(AMY.pid)).toBe(100);
    expect(a.casino.computedFoldOf(TABLE)!.records).toBe(0);
    put(a, s); // the live one does
    expect(a.casino.readChips(AMY.pid)).toBe(70);
  });

  it('a session map of the incarnation with no live one beside it', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
    const stray = new Y.Map<unknown>();
    a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:${'0'.repeat(24)}`, stray);
    const s = kit.slip(AMY, 1, [red(30)]);
    stray.set(s.key, s.rec);
    expect(a.casino.readChips(AMY.pid)).toBe(100);
    expect(a.casino.computedFoldOf(TABLE)!.records).toBe(0);
  });

  it('a write through a session map a trim replaced', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    const old = a.casino.computedSessionForWrite(TABLE)!;
    trim(a, kit.checkpoint(AMY, 'g', 1, 'e'.repeat(32), {}));
    const s = kit.slip(AMY, 2, [red(30)]);
    old.set(s.key, s.rec);
    expect(a.casino.readChips(AMY.pid)).toBe(100);
  });

  it("records under an incarnation name that isn't a computed one's (no `c`): never tracked, never paid", async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    const bare = INC.slice(1) + '8'; // 24 hex: a PR 1 table's kind of name
    const bareKit = new ComputedKit(ctxOf(TABLE, bare));
    const ses = new Y.Map<unknown>();
    a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${bare}:g`, ses);
    const pocket = pocketFor(bareKit, 1, [AMY]);
    const s = bareKit.slip(AMY, 1, [straightThat(true, pocket, 10)]);
    a.doc.transact(() => {
      for (const r of [s, bareKit.close(AMY, 1, 'g', [s]), bareKit.reveal(1, AMY.pid)]) ses.set(r.key, r.rec);
    });
    a.doc.getMap('casinoComputed').set(`sum:${TABLE}:${bare}`, bareKit.checkpoint(AMY, 'g', 1, 'e'.repeat(32), { [AMY.pid]: 1000n }));
    expect(a.casino.readChips(AMY.pid)).toBe(100);
    expect(a.casino.computedSettled()).toBe(true);
  });
});

describe('reads for the later commits', () => {
  it('isComputedTable and computedIncOf read the switch, its gone: mark and its checkpoint', async () => {
    const a = await loadPage(1);
    expect(a.casino.computedIncOf(TABLE)).toBeNull();
    switchOn(a);
    expect(a.casino.computedIncOf(TABLE)).toBe(INC);
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    expect(a.casino.isComputedTable(OTHER)).toBe(false);
    a.doc.getMap('casino').set(`gone:${TABLE}:${INC2}`, 1); // another incarnation's mark
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
    a.doc.getMap('casinoComputed').set(`sum:${TABLE}:${INC}`, { junk: true }); // junk: no checkpoint
    expect(a.casino.isComputedTable(TABLE)).toBe(true);
  });

  it('computedSessionForWrite is the live session map, looked up afresh after a trim', async () => {
    const a = await loadPage(1);
    expect(a.casino.computedSessionForWrite(TABLE)).toBeNull();
    switchOn(a);
    const first = a.casino.computedSessionForWrite(TABLE);
    expect(first).toBe(a.doc.getMap('casinoComputed').get(`ses:${TABLE}:${INC}:g`));
    const cp = kit.checkpoint(AMY, 'g', 1, 'e'.repeat(32), {});
    trim(a, cp);
    const next = a.casino.computedSessionForWrite(TABLE);
    expect(next).not.toBe(first);
    expect(next).toBe(a.doc.getMap('casinoComputed').get(`ses:${TABLE}:${INC}:${kit.sidAfter(cp)}`));
    // Afresh inside the very transaction that trims, before any recount.
    const cp2 = kit.checkpoint(AMY, kit.sidAfter(cp), 2, 'f'.repeat(32), {});
    a.doc.transact(() => {
      trim(a, cp2);
      expect(a.casino.computedSessionForWrite(TABLE)).toBe(a.doc.getMap('casinoComputed').get(`ses:${TABLE}:${INC}:${kit.sidAfter(cp2)}`));
    });
  });

  it('computedFoldOf is the switched-on incarnation\'s last counted fold', async () => {
    const a = await loadPage(1);
    pin(a, AMY);
    expect(a.casino.computedFoldOf(TABLE)).toBeNull();
    switchOn(a);
    const empty = a.casino.computedFoldOf(TABLE)!;
    expect(empty.records).toBe(0);
    expect(a.casino.computedFoldOf(TABLE)).toBe(empty); // O(1): the same object until something moves
    put(a, kit.slip(AMY, 1, [red(2)]));
    expect(a.casino.computedFoldOf(TABLE)!.held.get(AMY.pid)).toBe(2n);
  });

  it("computedFoldOf's rawBytes weighs a key the live session holds undefined under: Yjs keeps it, and the doc grows by it", async () => {
    const a = await loadPage(1);
    switchOn(a);
    const ses = a.casino.computedSessionForWrite(TABLE)!;
    const junk = Array.from({ length: 500 }, (_, i) => `junk-${'x'.repeat(80)}-${i}`);
    a.doc.transact(() => {
      for (const k of junk) ses.set(k, undefined);
    });
    expect(ses.size).toBe(500);
    expect(Y.encodeStateAsUpdate(a.doc).length).toBeGreaterThan(40_000);
    const keyBytes = junk.reduce((n, k) => n + k.length, 0);
    const raw = a.casino.computedFoldOf(TABLE)!.rawBytes;
    expect(raw).toBeGreaterThanOrEqual(keyBytes);
    // A page that reads the session whole weighs it the same.
    const b = await loadPage(2);
    sync(a, b);
    expect(b.casino.computedFoldOf(TABLE)!.rawBytes).toBe(raw);
    // Deleted, a key weighs nothing.
    ses.delete(junk[0]);
    expect(a.casino.computedFoldOf(TABLE)!.rawBytes).toBeLessThanOrEqual(raw - junk[0].length);
  });

  it("computedFoldOf's rawBytes follows junk growing inside a nested type of the live session, at any depth", async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    switchOn(a);
    sync(a, b);
    const ses = a.casino.computedSessionForWrite(TABLE)!;
    const arr = new Y.Array<string>();
    const nest = new Y.Map<unknown>();
    const deep = new Y.Array<string>();
    a.doc.transact(() => {
      ses.set('junk', arr);
      ses.set('nest', nest);
      nest.set('deep', deep);
    });
    sync(a, b);
    const small = a.casino.computedFoldOf(TABLE)!.rawBytes;
    let told = 0;
    a.casino.subscribeCasino(() => { told += 1; });
    for (let i = 0; i < 20; i++) {
      a.doc.transact(() => {
        arr.push(Array.from({ length: 50 }, () => 'y'.repeat(100)));
      });
    }
    expect(told).toBe(20); // once a transaction, as for any change of the session
    expect(JSON.stringify(arr.toJSON()).length).toBeGreaterThan(100_000);
    const grown = a.casino.computedFoldOf(TABLE)!.rawBytes;
    expect(grown).toBeGreaterThan(small + 100_000);
    a.doc.transact(() => {
      deep.push(Array.from({ length: 100 }, () => 'z'.repeat(100)));
    });
    expect(a.casino.computedFoldOf(TABLE)!.rawBytes).toBeGreaterThan(grown + 10_000);
    sync(a, b);
    expect(b.casino.computedFoldOf(TABLE)!.rawBytes).toBe(a.casino.computedFoldOf(TABLE)!.rawBytes);
    // Junk growing in another session map of the incarnation weighs nothing here.
    const stray = new Y.Map<unknown>();
    const strayArr = new Y.Array<string>();
    a.doc.transact(() => {
      a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:${'0'.repeat(24)}`, stray);
      stray.set('junk', strayArr);
    });
    const now = a.casino.computedFoldOf(TABLE)!.rawBytes;
    a.doc.transact(() => {
      strayArr.push(Array.from({ length: 100 }, () => 'w'.repeat(100)));
    });
    expect(a.casino.computedFoldOf(TABLE)!.rawBytes).toBe(now);
  });

  it('computedSeenAt: the first arrival, kept through re-puts and for records copied by a trim, dropped once gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const a = await loadPage(1);
      pin(a, AMY);
      switchOn(a);
      vi.setSystemTime(1_000);
      const s1 = kit.slip(AMY, 1, [red(1)]);
      const s2 = kit.slip(AMY, 2, [red(2)]);
      put(a, s1, s2);
      expect(a.casino.computedSeenAt(TABLE, s1.key)).toBe(1_000);
      vi.setSystemTime(2_000);
      put(a, s1); // the same record again
      (a.casino.computedSessionForWrite(TABLE)!).set('note', 'not a record key');
      expect(a.casino.computedSeenAt(TABLE, s1.key)).toBe(1_000);
      expect(a.casino.computedSeenAt(TABLE, 'note')).toBeUndefined();
      const c = kit.close(AMY, 1, 'g', [s1]);
      put(a, c);
      expect(a.casino.computedSeenAt(TABLE, c.key)).toBe(2_000);
      vi.setSystemTime(3_000);
      trim(a, kit.checkpoint(AMY, 'g', 1, c.hash, {}), [s2]); // s2 copied, s1 and the close gone
      expect(a.casino.computedSeenAt(TABLE, s2.key)).toBe(1_000);
      expect(a.casino.computedSeenAt(TABLE, s1.key)).toBeUndefined();
      expect(a.casino.computedSeenAt(TABLE, c.key)).toBeUndefined();
      expect(a.casino.computedSeenAt(OTHER, s2.key)).toBeUndefined();
      // Deleted (no build does), it is unseen at once; put back, it arrives anew.
      a.casino.computedSessionForWrite(TABLE)!.delete(s2.key);
      expect(a.casino.computedSeenAt(TABLE, s2.key)).toBeUndefined();
      vi.setSystemTime(4_000);
      put(a, s2);
      expect(a.casino.computedSeenAt(TABLE, s2.key)).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks each record once, a record copied into the next session never again, and none the writer marked', async () => {
    const a = await loadPage(1);
    const checked: string[] = [];
    const real = (await import('./keypair')).verifyIdentityStrict;
    a.casino.setComputedVerifyForTests({
      now: () => 0,
      verify: (pub, bytes, sig) => { checked.push(sig); return real(pub, bytes, sig); },
    });
    pin(a, AMY, BOB);
    switchOn(a);
    const s1 = kit.slip(AMY, 1, [red(1)]);
    const s2 = kit.slip(AMY, 2, [red(2)]);
    const mine = kit.slip(BOB, 2, [red(3)]);
    put(a, s1);
    put(a, kit.reveal(1, AMY.pid)); // another pass: s1's verdict is kept
    expect(checked).toEqual([s1.rec.g]);
    const c = kit.close(AMY, 1, 'g', [s1]);
    put(a, c, s2);
    expect(checked).toEqual([s1.rec.g, c.rec.g, s2.rec.g]);
    a.casino.markComputedVerdict(TABLE, mine.hash);
    put(a, mine);
    expect(a.casino.computedFoldOf(TABLE)!.held.get(BOB.pid)).toBe(3n);
    trim(a, kit.checkpoint(AMY, 'g', 1, c.hash, Object.fromEntries(a.casino.computedFoldOf(TABLE)!.nets)), [s2]);
    expect(a.casino.computedFoldOf(TABLE)!.held.get(AMY.pid)).toBe(2n);
    expect(checked).toEqual([s1.rec.g, c.rec.g, s2.rec.g]);
    // A record of the old session put back after the trim is checked afresh:
    // only what the new session holds kept its verdict.
    put(a, mine);
    expect(checked).toEqual([s1.rec.g, c.rec.g, s2.rec.g, mine.rec.g]);
  });

  it("a writer's mark stands through a whole read of the same session", async () => {
    const a = await loadPage(1);
    const checked: string[] = [];
    a.casino.setComputedVerifyForTests({ now: () => 0, verify: (_pub, _bytes, sig) => { checked.push(sig); return true; } });
    pin(a, AMY);
    switchOn(a);
    const mine = kit.slip(AMY, 1, [red(3)]);
    a.casino.markComputedVerdict(TABLE, mine.hash);
    a.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:${'0'.repeat(24)}`, new Y.Map()); // read whole again
    put(a, mine);
    expect(a.casino.computedFoldOf(TABLE)!.held.get(AMY.pid)).toBe(3n);
    expect(checked).toEqual([]);
  });
});
