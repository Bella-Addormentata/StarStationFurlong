/**
 * 🪙 A table's incarnation across removals (casinoDoc tableIncFor,
 * tableIncOf, clearTableKeys): an earlier build's table, which has none,
 * taking one as this build drives it while another page removes it; a page
 * that hears of a removal late; removals that marked nothing (an earlier
 * build's teardown, or a page that saw no round); and what a kept record
 * left by a removal owes, heard by listeners. Each page is its own copy of
 * the modules over its own doc, synced by hand like two peers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

type Page = {
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  craps: typeof import('./crapsCroupier');
  backend: typeof import('./crapsBackend');
  doc: Y.Doc;
};

const OWNER = 'owner-Alice';

vi.stubGlobal('window', { location: { search: '' } });

vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

async function loadPage(clientID?: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const craps = await import('./crapsCroupier');
  const backend = await import('./crapsBackend');
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  casino.bindCasinoDoc(doc);
  return { casino, croupier, craps, backend, doc };
}

function sync(x: Y.Doc, y: Y.Doc): void {
  Y.applyUpdate(y, Y.encodeStateAsUpdate(x, Y.encodeStateVector(y)));
  Y.applyUpdate(x, Y.encodeStateAsUpdate(y, Y.encodeStateVector(x)));
}

/** One-way delivery. */
function deliver(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
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

function diceTo(d1: number, d2: number): void {
  const faces = [d1, d2];
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = faces[n++ % 2] - 1;
    return arr;
  });
}

let a: Page;
let b: Page;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an earlier build's table taking its incarnation as it is removed", () => {
  const TABLE = 'roulette-1';
  const CRAPS = 'craps-1';
  const bettor = 'player-Carol';

  beforeEach(async () => {
    a = await loadPage(1);
    b = await loadPage(2);
  });

  describe("an earlier build's craps table: roll 1 left its pass line up, then", () => {
    const pass = { type: 'pass' as const, amount: 10 };

    /** An earlier build set the table up (no incarnation) and put Carol's 10
     *  on the pass line (taken: bal 90). Page a rolls a 6 on the come-out: the
     *  pass line rides, still taken. Both pages see roll 1 settled. */
    async function rollOneRides(): Promise<void> {
      a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      a.craps.openCrapsBetting(CRAPS, 1, null);
      const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(CRAPS)!;
      a.casino.writeCrapsTableState(CRAPS, earlier);
      a.doc.getMap('casino').set(`bal:${bettor}`, 90);
      a.doc.getMap('casino').set(`bets:${CRAPS}:${bettor}`, { kind: 'craps', bets: [pass] });
      a.craps.closeCrapsBetting(CRAPS, a.casino.readCrapsTableState(CRAPS)!);
      diceTo(3, 3);
      a.craps.rollAndSettleCraps(CRAPS, 1, null);
      await flush();
      sync(a.doc, b.doc);
      for (const page of [a, b]) {
        expect(page.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', point: 6 });
        expect(page.casino.readCrapsTableState(CRAPS)!.inc).toBeUndefined();
        expect(page.casino.readMyCrapsBets(CRAPS, bettor)).toEqual([pass]);
        expect(page.casino.readChips(bettor)).toBe(90);
      }
    }

    /** Page a opens roll 2 (the table takes its incarnation) and rolls
     *  `d1`+`d2`, before it hears that page b removed the table. */
    async function rollTwoOnA(d1: number, d2: number): Promise<void> {
      a.craps.openCrapsBetting(CRAPS, 2, 6, a.casino.readCrapsTableState(CRAPS));
      expect(a.casino.readCrapsTableState(CRAPS)!.inc).toBeDefined();
      a.craps.closeCrapsBetting(CRAPS, a.casino.readCrapsTableState(CRAPS)!);
      diceTo(d1, d2);
      a.craps.rollAndSettleCraps(CRAPS, 2, 6);
      await flush();
    }

    it('a roll 2 that leaves the pass line up, settled as page b removes the table, hands the 10 back once', async () => {
      await rollOneRides();
      b.craps.closeCrapsTable(CRAPS); // b sees roll 1 settled: refunds the 10 taken
      expect(b.casino.readChips(bettor)).toBe(100);
      await rollTwoOnA(2, 2); // a 4: the pass line rides again, nothing paid
      expect(a.casino.readChips(bettor)).toBe(90);
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
      a.craps.closeCrapsTable(CRAPS); // a hears of the removal
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    });

    it('a roll 2 that wins the pass line, settled as page b removes the table, pays the win or the refund, not both', async () => {
      await rollOneRides();
      b.craps.closeCrapsTable(CRAPS); // refunds the 10 taken
      await rollTwoOnA(3, 3); // the 6 hits: the pass line wins, paid 20 in full
      expect(a.casino.readChips(bettor)).toBe(110);
      sync(a.doc, b.doc);
      a.craps.closeCrapsTable(CRAPS);
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect([100, 110]).toContain(page.casino.readChips(bettor));
    });
  });

  describe("an earlier build's roulette table taking an incarnation as it is removed", () => {
    it("refunds the earlier build's bet on the round the driver opened, when the driver hears the removal", () => {
      // An earlier build ran round 1 (no incarnation); both pages see it settled.
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.croupier.openBetting(TABLE, 1);
      const { inc: _inc, ...earlier } = a.casino.readTableState(TABLE)!;
      a.casino.writeTableState(TABLE, { ...earlier, phase: 'settled', result: 5, resultAt: 1, payouts: {} });
      a.doc.getMap('casino').set(`bal:${bettor}`, 100);
      sync(a.doc, b.doc);
      // Page b (driving) opens round 2: the table takes an incarnation.
      b.croupier.openBetting(TABLE, 2);
      expect(b.casino.readTableState(TABLE)!.inc).toBeDefined();
      // Carol, on an earlier build, puts 30 on red there (taking it).
      b.doc.getMap('casino').set(`bal:${bettor}`, 70);
      b.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 2, bets: [{ type: 'red', amount: 30 }] });
      expect(b.casino.feltStake(TABLE, bettor)).toEqual({ net: 0, taken: 30 });
      expect(b.casino.readChips(bettor)).toBe(70);
      // The owner's page a, still seeing round 1 settled, removes the table.
      a.croupier.closeTable(TABLE);
      sync(a.doc, b.doc);
      b.croupier.closeTable(TABLE); // page b hears of the removal
      sync(a.doc, b.doc);
      // Round 2 never settled: the 30 its list took comes back.
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    });
  });
});

describe("an earlier build's table whose next roll is opened as it is removed", () => {
  const CRAPS = 'craps-1';
  const bettor = 'player-Carol';
  const pass = { type: 'pass' as const, amount: 10 };

  /** An earlier build set the craps table up (no incarnation) and took
   *  Carol's 10 for the pass line (bal 90); page a rolled a 6 on the come-out,
   *  so the pass line rides. Both pages see roll 1 settled. */
  async function earlierTableRollOne(a: Page, b: Page): Promise<void> {
    a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
    a.craps.openCrapsBetting(CRAPS, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(CRAPS)!;
    a.casino.writeCrapsTableState(CRAPS, earlier);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${CRAPS}:${bettor}`, { kind: 'craps', bets: [pass] });
    a.craps.closeCrapsBetting(CRAPS, a.casino.readCrapsTableState(CRAPS)!);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round: 1, point: 6 });
      expect(page.casino.readCrapsTableState(CRAPS)!.inc).toBeUndefined();
      expect(page.casino.feltStake(CRAPS, bettor)).toEqual({ net: 0, taken: 10 });
      expect(page.casino.readChips(bettor)).toBe(90);
    }
  }

  describe("an earlier build's craps table whose next roll the driver opens as the owner removes it", () => {
    for (const [label, clientA, clientB] of [['driver wins ties', 2, 1], ['remover wins ties', 1, 2]] as const) {
      it(`hands the 10 its pass line took back once, on both pages (${label})`, async () => {
        const a = await loadPage(clientA);
        const b = await loadPage(clientB);
        await earlierTableRollOne(a, b);
        // Page a (driving) opens roll 2: the table takes its incarnation.
        a.craps.openCrapsBetting(CRAPS, 2, 6, a.casino.readCrapsTableState(CRAPS));
        expect(a.casino.readCrapsTableState(CRAPS)!.inc).toBeDefined();
        // The owner removes the table on page b, which hasn't heard roll 2
        // open; page a hears the furniture go before b's teardown reaches it.
        b.craps.closeCrapsTable(CRAPS);
        a.craps.closeCrapsTable(CRAPS);
        sync(a.doc, b.doc);
        for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
      });
    }

    it("refunds an earlier build's pass line put down on roll 2, which the remover never saw", () => {
      return (async () => {
        const a = await loadPage(1);
        const b = await loadPage(2);
        a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
        a.craps.openCrapsBetting(CRAPS, 1, null);
        const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(CRAPS)!;
        a.casino.writeCrapsTableState(CRAPS, { ...earlier, phase: 'settled', point: null, dice: [1, 1], result: 2, payouts: {} });
        a.doc.getMap('casino').set(`bal:${bettor}`, 100);
        sync(a.doc, b.doc);
        // Page a opens roll 2 (the table takes its incarnation); Carol, on an
        // earlier build, puts 10 on the pass line there (taking it).
        a.craps.openCrapsBetting(CRAPS, 2, null, a.casino.readCrapsTableState(CRAPS));
        a.doc.getMap('casino').set(`bal:${bettor}`, 90);
        a.doc.getMap('casino').set(`bets:${CRAPS}:${bettor}`, { kind: 'craps', bets: [pass] });
        expect(a.casino.feltStake(CRAPS, bettor)).toEqual({ net: 0, taken: 10 });
        // Page b, still seeing roll 1 settled, removes the table; page a hears
        // of it once b's teardown has reached it.
        b.craps.closeCrapsTable(CRAPS);
        sync(a.doc, b.doc);
        a.craps.closeCrapsTable(CRAPS);
        sync(a.doc, b.doc);
        for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
      })();
    });
  });
});

describe("an earlier build's table rolled on its new incarnation as it is removed", () => {
  beforeEach(async () => {
    a = await loadPage();
    b = await loadPage();
  });

  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };

  describe("an earlier build's table given an incarnation at its next roll, rolled there as the removal comes", () => {
    /** An earlier build set the table up (no incarnation) and settled roll 1 on
     *  a 6; Carol's earlier-build pass line (10 taken, bal 90) rides the point. */
    function earlierTableOnThePoint(): void {
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.craps.openCrapsBetting(craps, 1, null);
      const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
      a.casino.writeCrapsTableState(craps, { ...earlier, phase: 'settled', point: 6, dice: [3, 3], result: 6 });
      a.doc.getMap('casino').set(`bal:${bettor}`, 90);
      a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
      sync(a.doc, b.doc);
      for (const page of [a, b]) {
        expect(page.casino.readCrapsTableState(craps)?.inc).toBeUndefined();
        expect(page.casino.feltStake(craps, bettor)).toEqual({ net: 0, taken: 10 });
        expect(page.casino.readChips(bettor)).toBe(90); // the 10 out on the felt
      }
    }

    for (const [winner, clientA, clientB] of [['the roll', 2, 1], ['the removal', 1, 2]] as const) {
      it(`hands the 10 back once (${winner} winning ties)`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        earlierTableOnThePoint();
        // Page a (driving) opens roll 2: the table takes its incarnation now.
        a.craps.openCrapsBetting(craps, 2, 6, a.casino.readCrapsTableState(craps));
        const inc = a.casino.readCrapsTableState(craps)!.inc!;
        expect(inc).toBeDefined();
        a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
        diceTo(4, 4); // an 8: the pass line rides on
        a.craps.rollAndSettleCraps(craps, 2, 6);
        await flush();
        expect(a.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', round: 2 });
        expect(a.doc.getMap('casino').get(`kept:${craps}:${bettor}`)).toMatchObject({ inc, taken: 10 });
        expect(a.casino.readChips(bettor)).toBe(90);
        // Page b, still on the earlier build's state, removes the table: it
        // refunds the 10 on the record of the incarnation that state is,
        // the one roll 2 opened on (`inc`), and marks it.
        b.craps.closeCrapsTable(craps, 'local');
        expect(b.casino.readChips(bettor)).toBe(100);
        sync(a.doc, b.doc);
        for (const page of [a, b]) expect(page.casino.readCrapsTableState(craps)).toBeNull();
        const merged = [a, b].map((page) => page.casino.readChips(bettor));
        a.craps.closeCrapsTable(craps); // page a hears of the removal
        sync(a.doc, b.doc);
        const heard = [a, b].map((page) => page.casino.readChips(bettor));
        // Serially (removal first, or the roll first) Carol has her 100.
        expect({ merged, heard }).toEqual({ merged: [100, 100], heard: [100, 100] });
      });
    }
  });
});

describe("a page hearing late of an earlier build's table removed as it rolled", () => {
  beforeEach(async () => {
    a = await loadPage();
    b = await loadPage();
  });

  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };

  /** An earlier build set the table up (no incarnation) and Carol's
   *  earlier-build pass line took 10 of her 100. Page a rolls a 6 on the
   *  come-out (the pass line rides) while page b, still seeing the roll
   *  closing, removes the table. */
  async function earlierRolledAsRemoved(): Promise<void> {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, earlier);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    expect(a.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  }

  describe("an earlier build's table removed as it rolled, heard late on the rolling page", () => {
    it('a page that hears of the removal late changes nothing a table put back is named by', async () => {
      a = await loadPage(2);
      b = await loadPage(1);
      await earlierRolledAsRemoved();
      const before = b.doc.getMap('casino').get(`gone:${craps}:`);
      a.craps.closeCrapsTable(craps); // page a hears of it, as page b puts the table back
      const after = a.doc.getMap('casino').get(`gone:${craps}:`);
      for (const page of [a, b]) {
        page.casino.writeCrapsFairnessPref(craps, 'rng');
        page.craps.openCrapsBetting(craps, 1, null);
      }
      expect({ before, after, same: a.casino.readCrapsTableState(craps)!.inc === b.casino.readCrapsTableState(craps)!.inc })
        .toEqual({ before: 1, after: 1, same: true });
    });

    it('so a round both pages settle on the table put back pays once', async () => {
      a = await loadPage(2);
      b = await loadPage(1);
      await earlierRolledAsRemoved();
      const dave = 'player-Dave'; // on this build, no part in the old table
      a.casino.buyInChips(dave, 100);
      sync(a.doc, b.doc);
      a.craps.closeCrapsTable(craps); // page a hears of the removal late
      // Both pages put the table back and run its first roll before either
      // hears of the other (round 12's own case); Dave bets 10 on the pass line.
      for (const page of [a, b]) {
        page.casino.writeCrapsFairnessPref(craps, 'rng');
        page.craps.openCrapsBetting(craps, 1, null);
        page.casino.writeMyCrapsBets(craps, dave, [pass]);
        page.craps.closeCrapsBetting(craps, page.casino.readCrapsTableState(craps)!);
        diceTo(3, 4); // a seven on the come-out: the pass line wins 10
        page.craps.rollAndSettleCraps(craps, 1, null);
      }
      await flush();
      sync(a.doc, b.doc);
      expect([a, b].map((page) => page.casino.readChips(dave))).toEqual([110, 110]);
    });
  });
});

describe("an earlier build's list pruned as its table is removed, then the table put back", () => {
  beforeEach(async () => {
    a = await loadPage();
    b = await loadPage();
  });

  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };

  /** An earlier build set the table up (no incarnation) and Carol's
   *  earlier-build pass line took 10 of her 100. Page a rolls a 6 on the
   *  come-out (the pass line rides) while page b, still seeing the roll
   *  closing, removes the table. */
  async function earlierRolledAsRemoved(): Promise<void> {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, earlier);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    expect(a.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  }

  describe("an earlier build's table removed as it rolled, then put back", () => {
    for (const [winner, clientA, clientB] of [['the roll', 2, 1], ['the removal', 1, 2]] as const) {
      it(`the table put back carries none of the old pass line (${winner} winning ties)`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        await earlierRolledAsRemoved(); // Carol has her 100 back
        // Page a is gone before it hears; page b puts the table back.
        b.casino.writeCrapsFairnessPref(craps, 'rng');
        b.craps.openCrapsBetting(craps, 1, null);
        const felt = {
          bets: b.casino.readMyCrapsBets(craps, bettor),
          stake: b.casino.feltStake(craps, bettor),
          chips: b.casino.readChips(bettor),
        };
        b.craps.closeCrapsTable(craps); // and removes it again
        expect({ felt, after: b.casino.readChips(bettor) }).toEqual({
          felt: { bets: [], stake: { net: 0, taken: 0 }, chips: 100 },
          after: 100,
        });
      });
    }

    it('nor does it win on the table put back as a bet nobody placed', async () => {
      a = await loadPage(2);
      b = await loadPage(1);
      await earlierRolledAsRemoved();
      b.casino.writeCrapsFairnessPref(craps, 'rng');
      b.craps.openCrapsBetting(craps, 1, null);
      b.casino.writeMyCrapsBets(craps, 'player-Dave', [pass]); // someone bets, so the roll has a felt
      b.craps.closeCrapsBetting(craps, b.casino.readCrapsTableState(craps)!);
      diceTo(3, 4); // a seven on the come-out: every pass line wins
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      expect(b.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', result: 7 });
      expect(b.casino.readChips(bettor)).toBe(100); // Carol placed nothing on this table
    });
  });
});

describe('removals that marked nothing', () => {
  const TABLE = 'roulette-1';
  const CRAPS = 'craps-1';
  const bettor = 'player-Carol';

  /** What an earlier build's (main's) teardown does to a table's keys: wipes
   *  them, leaves no gone: mark, and knows nothing of kept:. */
  function earlierBuildTeardown(page: Page, tableId: string): void {
    const map = page.doc.getMap('casino');
    page.doc.transact(() => {
      for (const k of [`table:${tableId}`, `croupier:${tableId}`, `cfg:backend:${tableId}`, `cfg:fairness:${tableId}`, `throw:${tableId}`]) map.delete(k);
      for (const key of [...map.keys()]) {
        if (key.startsWith(`bets:${tableId}:`) || key.startsWith(`seat:${tableId}:`) || key.startsWith(`fseed:${tableId}:`)) map.delete(key);
      }
    });
  }

  beforeEach(async () => {
    a = await loadPage(1);
    b = await loadPage(2);
  });

  describe('a table first opened at the moment another page removes it (that page saw no state)', () => {
    it('roulette: does not stay up with no furniture, holding the stake', () => {
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      sync(a.doc, b.doc);
      b.croupier.closeTable(TABLE, 'local'); // page b removes the table it never saw a round on
      a.croupier.openBetting(TABLE, 1); // page a opens round 1, yet to hear
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
      expect(a.casino.readChips(bettor)).toBe(70);
      sync(a.doc, b.doc); // page a is gone before it hears
      expect(b.casino.readChips(bettor)).toBe(100);
      expect(b.casino.readTableState(TABLE)).toBeNull();
    });

    it('craps: likewise', () => {
      a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      a.casino.buyInChips(bettor, 100);
      sync(a.doc, b.doc);
      b.craps.closeCrapsTable(CRAPS, 'local');
      a.craps.openCrapsBetting(CRAPS, 1, null);
      a.casino.writeMyCrapsBets(CRAPS, bettor, [{ type: 'pass', amount: 10 }]);
      sync(a.doc, b.doc);
      expect(b.casino.readChips(bettor)).toBe(100);
      expect(b.casino.readCrapsTableState(CRAPS)).toBeNull();
    });

    it('a table put back and removed again at once: the round the driver opened on it is ended', () => {
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      a.croupier.closeTable(TABLE); // removed once, both pages hear
      sync(a.doc, b.doc);
      // Put back; page a (driving) opens its round 1 and Carol bets, while
      // page b removes it again before it hears that round.
      a.croupier.openBetting(TABLE, 1);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
      b.croupier.closeTable(TABLE, 'local');
      sync(a.doc, b.doc);
      expect(b.casino.readChips(bettor)).toBe(100);
      expect(b.casino.readTableState(TABLE)).toBeNull();
    });
  });

  describe("a table an earlier build's page removed (no marks), put back under the same id", () => {
    it('removed again by a page yet to hear the round the driver opened on it: that round is ended too', async () => {
      spinTo(1); // red
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      expect(a.casino.readChips(bettor)).toBe(110);
      // The owner's stale tab on the earlier build removed the table while no
      // page of this build was in the room: its outcome records are all that's left.
      earlierBuildTeardown(a, TABLE);
      sync(a.doc, b.doc);
      // Put back: the driver opens round 1 past the name those records hold,
      // and Carol bets 30, as page b, yet to hear that round, removes it.
      a.croupier.openBetting(TABLE, 1);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
      expect(a.casino.readChips(bettor)).toBe(80);
      b.croupier.closeTable(TABLE, 'local');
      sync(a.doc, b.doc); // page a is gone before it hears
      expect({ state: b.casino.readTableState(TABLE), chips: b.casino.readChips(bettor) })
        .toEqual({ state: null, chips: 110 });
    });

    it('takes a new incarnation, so its round 1 pays', async () => {
      spinTo(1); // red
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      const first = a.casino.readTableState(TABLE)!.inc;
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      expect(a.casino.readChips(bettor)).toBe(110);
      sync(a.doc, b.doc);
      // The owner's stale tab on the earlier build removes the table; this
      // build's pages hear the furniture go with the teardown (a reconnect).
      earlierBuildTeardown(b, TABLE);
      sync(a.doc, b.doc);
      a.croupier.closeTable(TABLE);
      b.croupier.closeTable(TABLE);
      sync(a.doc, b.doc);
      // The table is put back (a room template applied again: same id).
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.croupier.openBetting(TABLE, 1);
      expect(a.casino.readTableState(TABLE)!.inc).not.toBe(first);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      expect(a.casino.readChips(bettor)).toBe(120);
    });

    it('round 1 of the put-back table pays (incarnation name aside)', async () => {
      spinTo(1); // red
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      sync(a.doc, b.doc);
      earlierBuildTeardown(b, TABLE);
      sync(a.doc, b.doc);
      a.croupier.closeTable(TABLE);
      b.croupier.closeTable(TABLE);
      sync(a.doc, b.doc);
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.croupier.openBetting(TABLE, 1);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      expect(a.casino.readChips(bettor)).toBe(100);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', result: 1 });
      expect(a.casino.readChips(bettor)).toBe(120);
    });

    it("craps: the bets the earlier build's teardown left behind (kept:) do not come back on the put-back table", async () => {
      const pass = { type: 'pass' as const, amount: 10 };
      a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.craps.openCrapsBetting(CRAPS, 1, null);
      a.casino.writeMyCrapsBets(CRAPS, bettor, [pass]);
      a.craps.closeCrapsBetting(CRAPS, a.casino.readCrapsTableState(CRAPS)!);
      diceTo(3, 3); // the point is 6: the pass line rides (kept)
      a.craps.rollAndSettleCraps(CRAPS, 1, null);
      await flush();
      expect(a.casino.readChips(bettor)).toBe(90);
      sync(a.doc, b.doc);
      // The earlier build's page removes the table while no page of this
      // build is in the room (nobody here runs closeCrapsTable).
      earlierBuildTeardown(b, CRAPS);
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
      // Put back under the same id; this build drives it.
      a.craps.openCrapsBetting(CRAPS, 1, null);
      expect(a.casino.readMyCrapsBets(CRAPS, bettor)).toEqual([]);
      expect(a.casino.readChips(bettor)).toBe(100);
    });
  });

  describe('what a page of this build marks for one', () => {
    it("ends the round this build's driver opened as an earlier build's page removed the table", () => {
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      sync(a.doc, b.doc);
      // Carol bets on page a, which closes the round, while the owner's
      // stale tab on the earlier build removes the table and page b hears
      // the furniture go with that teardown.
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      earlierBuildTeardown(b, TABLE);
      b.croupier.closeTable(TABLE); // heard
      sync(a.doc, b.doc); // page a is gone before it hears
      expect(b.casino.readTableState(TABLE)).toBeNull();
      expect(b.casino.readChips(bettor)).toBe(100);
    });

    it('names a table put back anew when only its outcome records are left (no page of this build heard it go)', async () => {
      spinTo(1); // red
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      const first = a.casino.readTableState(TABLE)!.inc;
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      earlierBuildTeardown(a, TABLE); // its lists go with it
      expect([...a.doc.getMap('casino').keys()].filter((k) => k.startsWith('bets:'))).toEqual([]);
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.croupier.openBetting(TABLE, 1);
      expect(a.casino.readTableState(TABLE)!.inc).not.toBe(first);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      expect(a.casino.readChips(bettor)).toBe(120);
    });

    it('and sends that mark out with the round it opens, in one update', async () => {
      spinTo(1);
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.croupier.openBetting(TABLE, 1);
      a.casino.buyInChips(bettor, 100);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      a.croupier.rollAndSettle(TABLE, 1);
      await flush();
      earlierBuildTeardown(a, TABLE);
      let updates = 0;
      const count = (): void => { updates += 1; };
      a.doc.on('update', count);
      a.croupier.openBetting(TABLE, 1);
      a.doc.off('update', count);
      expect(updates).toBe(1);
    });

    it('at craps too', async () => {
      a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      a.craps.openCrapsBetting(CRAPS, 1, null);
      a.casino.buyInChips(bettor, 100);
      a.casino.writeMyCrapsBets(CRAPS, bettor, [{ type: 'pass', amount: 10 }]);
      a.craps.closeCrapsBetting(CRAPS, a.casino.readCrapsTableState(CRAPS)!);
      diceTo(3, 4); // a seven on the come-out: the pass line wins
      a.craps.rollAndSettleCraps(CRAPS, 1, null);
      await flush();
      const first = a.casino.readCrapsTableState(CRAPS)!.inc;
      earlierBuildTeardown(a, CRAPS);
      let updates = 0;
      const count = (): void => { updates += 1; };
      a.doc.on('update', count);
      a.craps.openCrapsBetting(CRAPS, 1, null);
      a.doc.off('update', count);
      expect(updates).toBe(1);
      expect(a.casino.readCrapsTableState(CRAPS)!.inc).not.toBe(first);
    });

    it("refunds nothing here of an earlier build's table put back after a removal, which that build refunds itself", () => {
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.croupier.openBetting(TABLE, 1);
      a.croupier.closeTable(TABLE, 'local'); // removed by this build: marked
      // The earlier build puts it back (no incarnation), and Carol's tab on
      // it puts 30 on red (taken).
      a.doc.getMap('casino').set(`table:${TABLE}`, {
        kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null,
      });
      a.doc.getMap('casino').set(`bal:${bettor}`, 70);
      a.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 1, bets: [{ type: 'red', amount: 30 }] });
      sync(a.doc, b.doc);
      expect(b.casino.readTableState(TABLE)).toBeNull(); // not a table this build drives
      // That build's page removes it, refunding Carol itself; page b hears
      // the furniture go before the teardown reaches it.
      b.croupier.closeTable(TABLE);
      a.doc.getMap('casino').set(`bal:${bettor}`, 100);
      earlierBuildTeardown(a, TABLE);
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    });

    it("counts a list under `held` that names no incarnation for nothing (no page of this build writes one)", () => {
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      a.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 1, held: [{ type: 'red', amount: 30 }] });
      expect(a.casino.readMyBets(TABLE, bettor, 1)).toEqual([]);
      expect(a.casino.readChips(bettor)).toBe(100);
    });
  });
});

describe('what a removal leaves owed', () => {
  beforeEach(async () => {
    a = await loadPage();
    b = await loadPage();
  });

  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };

  function syncAll(...pages: Page[]): void {
    for (let i = 0; i < pages.length; i++) for (let j = 0; j < pages.length; j++) if (i !== j) sync(pages[i].doc, pages[j].doc);
  }

  /** Carol's earlier build put a pass line down (10 taken, bal 90) on a table
   *  this build set up (`earlierTable`: one an earlier build set up). */
  function earlierCraps(p: Page, round: number, point: number | null, bets: object[], earlierTable = false): void {
    p.casino.writeCrapsFairnessPref(craps, 'rng');
    p.craps.openCrapsBetting(craps, round, point);
    if (earlierTable) {
      const { inc: _inc, ...earlier } = p.casino.readCrapsTableState(craps)!;
      p.casino.writeCrapsTableState(craps, earlier);
    }
    const taken = (bets as { amount: number }[]).reduce((n, x) => n + x.amount, 0);
    p.doc.getMap('casino').set(`bal:${bettor}`, 100 - taken);
    p.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets });
  }

  async function rollOn(p: Page, d1: number, d2: number): Promise<void> {
    const s = p.casino.readCrapsTableState(craps)!;
    if (s.phase === 'betting') p.craps.closeCrapsBetting(craps, p.casino.readCrapsTableState(craps)!);
    diceTo(d1, d2);
    const c = p.casino.readCrapsTableState(craps)!;
    p.craps.rollAndSettleCraps(craps, c.round, c.point);
    await flush();
  }

  describe('two pages settle one roll with their own dice as a third removes the table', () => {
    for (const ids of [[3, 2, 1], [2, 3, 1], [1, 2, 3], [2, 1, 3], [3, 1, 2], [1, 3, 2]] as const) {
      it(`hands back or charges as one serial order would (clientIDs a=${ids[0]} c=${ids[1]} b=${ids[2]})`, async () => {
        a = await loadPage(ids[0]);
        const c = await loadPage(ids[1]);
        b = await loadPage(ids[2]);
        earlierCraps(a, 2, 6, [pass]);
        a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
        syncAll(a, b, c);
        diceTo(4, 4); // an 8: the pass line rides
        a.craps.rollAndSettleCraps(craps, 2, 6);
        diceTo(3, 4); // a seven-out: the pass line loses its 10
        c.craps.rollAndSettleCraps(craps, 2, 6);
        await flush();
        b.craps.closeCrapsTable(craps);
        syncAll(a, b, c);
        const tbl = [...a.doc.getMap('casinoChips').values()].find((r) => (r as { ev?: string }).ev !== undefined) as { ev: string };
        const kept = a.doc.getMap('casino').get(`table:${craps}`) as { result?: number } | undefined;
        // The removal's refund, or the 8 (then the refund owed): 100; the seven: 90.
        const want = tbl.ev === 'end' ? 100 : kept?.result === 7 ? 90 : 100;
        const now = [a, b, c].map((p) => p.casino.readChips(bettor));
        for (const p of [a, c]) p.craps.closeCrapsTable(craps); // the rollers hear of it
        syncAll(a, b, c);
        const heard = [a, b, c].map((p) => p.casino.readChips(bettor));
        expect({ now, heard }).toEqual({ now: [want, want, want], heard: [want, want, want] });
      });
    }
  });

  describe('a Fair roll voided as the table is removed', () => {
    for (const [winner, clientA, clientB] of [['the removal', 2, 1], ['the void', 1, 2]] as const) {
      it(`hands the earlier build's stake back once (${winner} winning ties)`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        a.craps.openCrapsBetting(craps, 2, 6); // Fair: page a holds the house seed
        expect(a.casino.readCrapsTableState(craps)?.houseCommit).toBeTruthy();
        a.doc.getMap('casino').set(`bal:${bettor}`, 90);
        a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
        a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
        sync(a.doc, b.doc);
        b.craps.rollAndSettleCraps(craps, 2, 6); // b has no house seed: void
        await flush();
        expect(b.casino.readCrapsTableState(craps)?.voided).toBe(true);
        expect(b.doc.getMap('casino').get(`kept:${craps}:${bettor}`)).toMatchObject({ taken: 10 });
        a.craps.closeCrapsTable(craps);
        sync(a.doc, b.doc);
        const now = [a, b].map((p) => p.casino.readChips(bettor));
        b.craps.closeCrapsTable(craps);
        sync(a.doc, b.doc);
        const heard = [a, b].map((p) => p.casino.readChips(bettor));
        expect({ now, heard }).toEqual({ now: [100, 100], heard: [100, 100] });
      });
    }
  });

  describe('an outcome record already full (the chain goes on at ~1)', () => {
    for (const [winner, clientA, clientB] of [['the roll', 2, 1], ['the removal', 1, 2]] as const) {
      it(`a roll settled as the table goes still hands back once (${winner} winning ties)`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        earlierCraps(a, 1, null, [pass]);
        const inc = a.casino.readCrapsTableState(craps)!.inc!;
        const big = 2 ** 52;
        a.casino.creditTableOutcome(craps, inc, 98, bettor, big - 1); // past rounds' wins fill link 0
        a.casino.creditTableOutcome(craps, inc, 99, bettor, 1);
        a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
        sync(a.doc, b.doc);
        await rollOn(a, 3, 3); // a 6: the pass line rides the point
        b.craps.closeCrapsTable(craps);
        sync(a.doc, b.doc);
        expect(a.doc.getMap('casinoChips').has(`tbl:${craps}:${inc}:${bettor}~1`)).toBe(true);
        const now = [a, b].map((p) => p.casino.readChips(bettor));
        a.craps.closeCrapsTable(craps);
        sync(a.doc, b.doc);
        const heard = [a, b].map((p) => p.casino.readChips(bettor));
        expect({ now, heard }).toEqual({ now: [big + 100, big + 100], heard: [big + 100, big + 100] });
      });
    }
  });

  describe('what a removal left owed, through the table put back', () => {
    /** Page a rolls a 6 on the come-out under Carol's earlier-build pass line
     *  while page b removes the table; the roll wins the tie, so the kept
     *  record owes her 10. */
    async function owed(): Promise<void> {
      a = await loadPage(2);
      b = await loadPage(1);
      earlierCraps(a, 1, null, [pass]);
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      sync(a.doc, b.doc);
      await rollOn(a, 3, 3);
      b.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      for (const p of [a, b]) expect(p.casino.readChips(bettor)).toBe(100);
    }

    it('an earlier build betting again on the table put back, rolled as it is removed', async () => {
      await owed();
      b.casino.writeCrapsFairnessPref(craps, 'rng');
      b.craps.openCrapsBetting(craps, 1, null);
      // Carol's earlier build reads 90 and puts 10 on the pass line (bal 80).
      b.doc.getMap('casino').set(`bal:${bettor}`, 80);
      b.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
      sync(a.doc, b.doc);
      for (const p of [a, b]) expect(p.casino.readChips(bettor)).toBe(90);
      for (const [ra, rb] of [[a, b]]) {
        await rollOn(ra, 3, 3); // the pass line rides again
        rb.craps.closeCrapsTable(craps);
      }
      sync(a.doc, b.doc);
      const now = [a, b].map((p) => p.casino.readChips(bettor));
      a.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      const heard = [a, b].map((p) => p.casino.readChips(bettor));
      expect({ now, heard }).toEqual({ now: [100, 100], heard: [100, 100] });
    });

    it('a late removal on the rolling page as the table put back rolls', async () => {
      await owed();
      b.casino.writeCrapsFairnessPref(craps, 'rng');
      b.craps.openCrapsBetting(craps, 1, null);
      b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 20 }]);
      await rollOn(b, 4, 4); // the point is 8: the 20 rides; b pays what was owed
      a.craps.closeCrapsTable(craps); // page a hears of the first removal only now
      sync(a.doc, b.doc);
      const now = [a, b].map((p) => p.casino.readChips(bettor));
      b.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      const heard = [a, b].map((p) => p.casino.readChips(bettor));
      expect({ now, heard }).toEqual({ now: [80, 80], heard: [100, 100] });
    });

    it('a roll on the table put back that Carol has no part in, then its removal', async () => {
      await owed();
      b.casino.writeCrapsFairnessPref(craps, 'rng');
      b.casino.buyInChips('player-Dave', 50);
      b.craps.openCrapsBetting(craps, 1, null);
      b.casino.writeMyCrapsBets(craps, 'player-Dave', [pass]);
      await rollOn(b, 3, 3);
      sync(a.doc, b.doc);
      expect(b.casino.readChips(bettor)).toBe(100);
      a.craps.closeCrapsTable(craps);
      b.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      expect([a, b].map((p) => p.casino.readChips(bettor))).toEqual([100, 100]);
      expect([a, b].map((p) => p.casino.readChips('player-Dave'))).toEqual([50, 50]);
    });
  });

  describe('Carol on this build rewrites her list after the roll, as the table goes', () => {
    for (const ids of [[3, 2, 1], [1, 2, 3], [2, 3, 1], [2, 1, 3]] as const) {
      it(`gives back once (clientIDs a=${ids[0]} c=${ids[1]} b=${ids[2]})`, async () => {
        a = await loadPage(ids[0]);
        const c = await loadPage(ids[1]); // Carol's own page
        b = await loadPage(ids[2]);
        earlierCraps(a, 1, null, [pass]);
        a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
        syncAll(a, b, c);
        await rollOn(a, 3, 3); // the pass line rides
        sync(a.doc, c.doc); // Carol hears the roll; b does not
        c.casino.writeMyCrapsBets(craps, bettor, [pass, { type: 'place', pick: 8, amount: 10 }]);
        expect(c.casino.readChips(bettor)).toBe(80);
        b.craps.closeCrapsTable(craps);
        syncAll(a, b, c);
        const now = [a, b, c].map((p) => p.casino.readChips(bettor));
        a.craps.closeCrapsTable(craps);
        c.craps.closeCrapsTable(craps);
        syncAll(a, b, c);
        const heard = [a, b, c].map((p) => p.casino.readChips(bettor));
        expect({ now, heard }).toEqual({ now: [100, 100, 100], heard: [100, 100, 100] });
      });
    }
  });
});

describe('listeners hear what a kept record owes', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  /** What a bal: listener last read, and how often it ran. */
  type Watch = { seen: number | null; calls: number; values: number[] };

  function watch(page: Page): Watch {
    const w: Watch = { seen: null, calls: 0, values: [] };
    page.casino.subscribeCasinoKey(`bal:${bettor}`, () => {
      w.calls += 1;
      w.seen = page.casino.readChips(bettor);
      w.values.push(w.seen);
    });
    w.seen = page.casino.readChips(bettor);
    return w;
  }

  /** The listener has heard the chips the page reads now. */
  function heard(page: Page, w: Watch, step: string): void {
    expect({ step, seen: w.seen }).toEqual({ step, seen: page.casino.readChips(bettor) });
  }

  function earlierCraps(round: number, point: number | null, bets: object[]): void {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, round, point);
    const taken = (bets as { amount: number }[]).reduce((n, x) => n + x.amount, 0);
    a.doc.getMap('casino').set(`bal:${bettor}`, 100 - taken);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets });
    sync(a.doc, b.doc);
  }

  /** Page a rolls a 6 on the come-out (Carol's earlier build's pass line
   *  rides) while page b, still seeing the roll closing, removes the table.
   *  Nothing is synced after the removal. */
  async function rolledAsRemoved(earlierTable = false): Promise<void> {
    const pass = { type: 'pass', amount: 10 };
    earlierCraps(1, null, [pass]);
    if (earlierTable) {
      const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
      a.casino.writeCrapsTableState(craps, earlier);
    }
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    expect(a.casino.readChips(bettor)).toBe(90);
    b.craps.closeCrapsTable(craps);
  }

  describe('recount: listeners hear what a kept record owes', () => {
    for (const [winner, clientA, clientB, earlierTable] of [
      ['the roll', 2, 1, false], ['the removal', 1, 2, false],
      ['the roll, earlier table', 2, 1, true], ['the removal, earlier table', 1, 2, true],
    ] as const) {
      it(`each step of a roll settled as the table goes is heard (${winner} winning ties)`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        const wa = watch(a);
        const wb = watch(b);
        await rolledAsRemoved(earlierTable);
        heard(a, wa, 'a settled');
        heard(b, wb, 'b removed');
        deliver(a.doc, b.doc);
        heard(b, wb, 'b hears the roll');
        deliver(b.doc, a.doc);
        heard(a, wa, 'a hears the removal');
        for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
        a.craps.closeCrapsTable(craps);
        heard(a, wa, 'a removes');
        deliver(a.doc, b.doc);
        heard(b, wb, 'b hears a remove');
        for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
        // Never a moment off 90..100 on either page's listener.
        for (const v of [...wa.values, ...wb.values]) {
          expect(v).toBeGreaterThanOrEqual(90);
          expect(v).toBeLessThanOrEqual(100);
        }
      });
    }

    it('the refund heard on its own (a transaction of the chips map alone) is heard', async () => {
      a = await loadPage(2);
      b = await loadPage(1);
      const wa = watch(a);
      const wb = watch(b);
      await rolledAsRemoved();
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
      const inc = (a.doc.getMap('casino').get(`kept:${craps}:${bettor}`) as { inc: string }).inc;
      const callsBefore = wa.calls;
      b.casino.creditTableOutcome(craps, inc, 'end', bettor, 10);
      heard(b, wb, 'b pays the refund');
      deliver(b.doc, a.doc);
      heard(a, wa, 'a hears the refund');
      expect(a.casino.readChips(bettor)).toBe(100);
      expect(wa.calls).toBeGreaterThanOrEqual(callsBefore);
    });

    it('a page rebound to a doc that holds a kept record owing reads it and repaints', async () => {
      a = await loadPage(2);
      b = await loadPage(1);
      await rolledAsRemoved();
      sync(a.doc, b.doc);
      expect(a.casino.readChips(bettor)).toBe(100);
      // A third page joins: first a fresh practice doc, then the room's doc.
      const c = await loadPage(3);
      const wc = watch(c);
      expect(c.casino.readChips(bettor)).toBe(0);
      const room = new Y.Doc();
      room.clientID = 4;
      Y.applyUpdate(room, Y.encodeStateAsUpdate(a.doc));
      c.casino.bindCasinoDoc(room);
      heard(c, wc, 'c rebound');
      expect(c.casino.readChips(bettor)).toBe(100);
      // And it hears the removal its own page makes there.
      c.craps.closeCrapsTable(craps);
      heard(c, wc, 'c removes');
      expect(c.casino.readChips(bettor)).toBe(100);
      // Bound back to a fresh doc: nothing owed there.
      c.casino.bindCasinoDoc(new Y.Doc());
      heard(c, wc, 'c rebound again');
      expect(c.casino.readChips(bettor)).toBe(0);
      // The room doc it left changes; nothing of it leaks into this binding.
      Y.applyUpdate(room, Y.encodeStateAsUpdate(b.doc));
      expect(c.casino.readChips(bettor)).toBe(0);
    });

    it('readChips inside the removal transaction already counts what was paid', async () => {
      a = await loadPage(2);
      b = await loadPage(1);
      await rolledAsRemoved();
      sync(a.doc, b.doc);
      expect(a.casino.readChips(bettor)).toBe(100);
      let inside = -1;
      a.casino.transactCasino(() => {
        a.craps.closeCrapsTable(craps);
        inside = a.casino.readChips(bettor);
      });
      expect(inside).toBe(100);
      expect(a.casino.readChips(bettor)).toBe(100);
    });
  });
});


describe("an earlier build's page on the table put back, after a roll met the removal", () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };

  /** Carol's earlier build put 10 on the pass line (bal 90). Page a rolls a
   *  6 (the pass line rides) as page b removes the table; page a is gone
   *  before it hears. Page b puts the table back under the same id. */
  async function rolledAsRemovedThenPutBack(): Promise<void> {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    b.craps.closeCrapsTable(craps, 'local');
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(100);
    b.casino.writeCrapsFairnessPref(craps, 'rng');
    b.craps.openCrapsBetting(craps, 1, null); // put back
  }

  /** What Carol's earlier-build page reads as her list: any
   *  `{kind:'craps', bets}` under her key, whatever else it carries. */
  function earlierReads(page: Page): unknown[] {
    const v = page.doc.getMap('casino').get(`bets:${craps}:${bettor}`) as { kind?: string; bets?: unknown[] } | undefined;
    return v?.kind === 'craps' && Array.isArray(v.bets) ? v.bets : [];
  }

  for (const [winner, clientA, clientB] of [['the roll', 2, 1], ['the removal', 1, 2]] as const) {
    it(`finds nothing of the old pass line there to take down, and Carol has her 10 back once (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      await rolledAsRemovedThenPutBack();
      expect(earlierReads(b)).toEqual([]);
      expect([...b.doc.getMap('casino').keys()].filter((k) => k.startsWith('kept:') || k.startsWith('bets:'))).toEqual([]);
      expect(b.casino.readMyCrapsBets(craps, bettor)).toEqual([]);
      expect(b.casino.readChips(bettor)).toBe(100);
      b.craps.closeCrapsTable(craps, 'local');
      expect(b.casino.readChips(bettor)).toBe(100);
    });
  }
});

describe('a held change heard through the chips map alone', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  it('is told once, and not again at the next casino write that has nothing to do with it', async () => {
    a = await loadPage(2); // the roll wins ties
    b = await loadPage(1);
    const pass = { type: 'pass', amount: 10 };
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    b.craps.closeCrapsTable(craps, 'local');
    sync(a.doc, b.doc);
    expect(a.casino.readChips(bettor)).toBe(100); // the kept record owes the 10
    const inc = (a.doc.getMap('casino').get(`kept:${craps}:${bettor}`) as { inc: string }).inc;
    let calls = 0;
    let read: number | null = null;
    a.casino.subscribeCasinoKey(`bal:${bettor}`, () => { calls += 1; read = a.casino.readChips(bettor); });
    b.casino.creditTableOutcome(craps, inc, 'end', bettor, 10); // the refund, paid alone
    sync(a.doc, b.doc);
    expect({ calls, read }).toEqual({ calls: 1, read: 100 });
    a.casino.writeCroupierBeat('roulette-9', 1);
    expect(calls).toBe(1);
  });
});

describe('tables whose ids begin with one another', () => {
  const bettor = 'player-Carol';

  it('count each list on its own table', async () => {
    a = await loadPage();
    for (const id of ['roulette-1', 'roulette-1:2']) {
      a.casino.writeCrapsFairnessPref(id, 'rng');
      a.croupier.openBetting(id, 1);
    }
    a.casino.buyInChips(bettor, 100);
    a.casino.writeMyBets('roulette-1', bettor, 1, [{ type: 'red', amount: 20 }]);
    a.casino.writeMyBets('roulette-1:2', bettor, 1, [{ type: 'red', amount: 10 }]);
    expect(a.casino.readChips(bettor)).toBe(70);
    a.croupier.closeTable('roulette-1:2', 'local');
    expect(a.casino.readChips(bettor)).toBe(80);
    expect(a.casino.readMyBets('roulette-1', bettor, 1)).toEqual([{ type: 'red', amount: 20 }]);
  });

  it("and a removed one's kept record on its own, when the shorter id was removed too", async () => {
    a = await loadPage(2); // the roll wins ties
    b = await loadPage(1);
    const craps = 'craps-1:2';
    a.casino.writeCrapsFairnessPref('craps-1', 'rng');
    a.craps.openCrapsBetting('craps-1', 1, null);
    a.craps.closeCrapsTable('craps-1', 'local'); // craps-1 has gone marks of its own
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'pass', amount: 10 }] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    b.craps.closeCrapsTable(craps, 'local');
    sync(a.doc, b.doc);
    expect(a.doc.getMap('casino').has(`kept:${craps}:${bettor}`)).toBe(true);
    expect(a.casino.readChips(bettor)).toBe(100); // the kept record owes the 10
    expect(b.casino.readChips(bettor)).toBe(100);
  });
});

describe("an earlier build's table both pages settle, then one opens the next window and removes it", () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };

  for (const [winner, clientA, clientB] of [['page a', 2, 1], ['page b', 1, 2]] as const) {
    it(`hands Carol's 10 back once (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.craps.openCrapsBetting(craps, 1, null);
      const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
      a.casino.writeCrapsTableState(craps, earlier); // an earlier build's table
      a.doc.getMap('casino').set(`bal:${bettor}`, 90);
      a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      sync(a.doc, b.doc);
      diceTo(3, 3); // a 6: the pass line rides, still taken
      a.craps.rollAndSettleCraps(craps, 1, null);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      expect(b.doc.getMap('casino').get(`kept:${craps}:${bettor}`)).toMatchObject({ taken: 10 });
      a.craps.openCrapsBetting(craps, 2, 6);
      a.craps.closeCrapsTable(craps, 'local');
      expect(a.casino.readChips(bettor)).toBe(100);
      sync(a.doc, b.doc);
      b.craps.closeCrapsTable(craps); // b hears of it
      sync(a.doc, b.doc);
      expect([a, b].map((p) => p.casino.readChips(bettor))).toEqual([100, 100]);
    });
  }
});

describe('a table removed and put back while a settle of it is still under way', () => {
  const bettor = 'player-Carol';

  it('craps: the old roll settles nothing on the table put back, at the same roll', async () => {
    a = await loadPage();
    const craps = 'craps-1';
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    diceTo(3, 4); // a seven: the pass line would win
    a.craps.rollAndSettleCraps(craps, 1, null); // the dice still hashing...
    a.craps.closeCrapsTable(craps, 'local'); // ...as the table goes
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null); // and comes back, to its first roll
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 20 }]);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    await flush();
    expect(a.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'closing', round: 1 });
    expect(a.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'pass', amount: 20 }]);
    expect(a.casino.readChips(bettor)).toBe(80);
  });

  it('roulette: the old spin settles nothing on the table put back, at the same round', async () => {
    a = await loadPage();
    const table = 'roulette-1';
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(table, 1); // Fair: the settle hashes
    expect(a.casino.readTableState(table)?.houseCommit).toBeTruthy();
    a.casino.writeMyBets(table, bettor, 1, [{ type: 'red', amount: 10 }]);
    a.croupier.closeBetting(table, a.casino.readTableState(table)!);
    a.croupier.rollAndSettle(table, 1); // hashing...
    a.croupier.closeTable(table, 'local');
    a.croupier.openBetting(table, 1);
    a.casino.writeMyBets(table, bettor, 1, [{ type: 'red', amount: 20 }]);
    a.croupier.closeBetting(table, a.casino.readTableState(table)!);
    await flush();
    expect(a.casino.readTableState(table)).toMatchObject({ phase: 'closing', round: 1 });
    expect(a.casino.readMyBets(table, bettor, 1)).toEqual([{ type: 'red', amount: 20 }]);
    expect(a.casino.readChips(bettor)).toBe(80);
  });
});
