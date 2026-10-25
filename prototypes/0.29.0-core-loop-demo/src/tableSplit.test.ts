/**
 * 📒 A table's book (casinoDoc THE TABLE'S BOOK) when the room splits.
 *
 * A page cut off from the room keeps settling the table it drove while
 * another of the owner's pages takes it over, and when the two meet the doc
 * keeps one write of each key. These specs run pages (each its own load of
 * the casino modules and its own Y.Doc, synced by hand; the client ids fix
 * which page's write wins a tie) through splits of every shape the book is
 * for: whatever each side settled, chips follow one run of the table's
 * rounds, the one whose book the doc kept, and a bet put down on the other
 * run never plays here. Then a page holding part of another page's update
 * (Yjs parks what it can't apply yet): it settles, opens, removes and
 * counts nothing until the rest comes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

type Page = {
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  craps: typeof import('./crapsCroupier');
  fair: typeof import('./fairTableSeeds');
  doc: Y.Doc;
};

const OWNER = 'owner-Alice';
const TABLE = 'roulette-1';
const CRAPS = 'craps-1';

vi.stubGlobal('window', { location: { search: '' } });

vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

async function loadPage(clientID: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const craps = await import('./crapsCroupier');
  const fair = await import('./fairTableSeeds');
  const doc = new Y.Doc();
  doc.clientID = clientID;
  casino.bindCasinoDoc(doc);
  return { casino, croupier, craps, fair, doc };
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

function diceTo(d1: number, d2: number): void {
  const faces = [d1, d2];
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = faces[n++ % 2] - 1;
    return arr;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const amy = 'player-Amy'; // at the table before the split: both sides know her bets
const xena = 'player-Xena'; // plays at the cut-off page's copy of the room only
const yuri = 'player-Yuri'; // plays at the other side only
const eve = 'player-Eve'; // on an earlier build: her chips go when her list goes down
const red = [{ type: 'red' as const, amount: 10 }];
type Bets = Parameters<Page['casino']['writeMyBets']>[3];
type Felt = Parameters<Page['casino']['writeMyCrapsBets']>[2];

/** One roulette round on one page: open (unless it is open), bets, close, spin. */
async function spin(page: Page, round: number, bets: Record<string, Bets>, pocket: number, open = true): Promise<void> {
  if (open) page.croupier.openBetting(TABLE, round);
  for (const [pid, list] of Object.entries(bets)) page.casino.writeMyBets(TABLE, pid, round, list);
  page.croupier.closeBetting(TABLE, page.casino.readTableState(TABLE)!);
  spinTo(pocket);
  page.croupier.rollAndSettle(TABLE, round);
  await flush();
  expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round, result: pocket });
}

/** One craps roll on one page: the next window, bets, close, the dice. */
async function roll(page: Page, d1: number, d2: number, bets: Record<string, Felt> = {}): Promise<void> {
  const was = page.casino.readCrapsTableState(CRAPS);
  const round = (was?.round ?? 0) + 1;
  page.craps.openCrapsBetting(CRAPS, round, was?.point ?? null, was);
  for (const [pid, list] of Object.entries(bets)) page.casino.writeMyCrapsBets(CRAPS, pid, list);
  page.craps.closeCrapsBetting(CRAPS, page.casino.readCrapsTableState(CRAPS)!);
  diceTo(d1, d2);
  page.craps.rollAndSettleCraps(CRAPS, round, was?.point ?? null);
  await flush();
  expect(page.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round, dice: [d1, d2] });
}

/** The doc's book of a table's incarnation `inc`. */
function bookOf(page: Page, table: string, inc: string): import('./casinoDoc').TableBook {
  return page.casino.readTableBook(table, inc)!;
}

describe('a page cut off from the room that keeps settling, and the page that took the table over', () => {
  for (const [winner, cx, cy] of [['the page that took over', 1, 2], ['the cut-off page', 2, 1]] as const) {
    const keptY = cy > cx;

    it(`roulette: chips follow the rounds the doc keeps (${winner} winning ties); a bet put down on the other side never plays`, async () => {
      const x = await loadPage(cx); // drives, then is cut off and keeps settling
      const y = await loadPage(cy); // takes the table over once X's lease lapses
      x.casino.writeCrapsFairnessPref(TABLE, 'rng');
      for (const pid of [amy, xena, yuri]) x.casino.buyInChips(pid, 100);
      await spin(x, 1, { [amy]: red }, 1); // amy +10
      x.croupier.openBetting(TABLE, 2);
      x.casino.writeMyBets(TABLE, amy, 2, red);
      sync(x, y);
      // The split. X goes on with Xena, who plays at its copy of the room.
      await spin(x, 2, { [xena]: red }, 1, false); // amy +10, xena +10
      await spin(x, 3, { [xena]: red }, 2); // xena -10
      await spin(x, 4, { [xena]: red }, 1); // xena +10
      x.croupier.openBetting(TABLE, 5);
      x.casino.writeMyBets(TABLE, xena, 5, red); // and puts 10 down on round 5
      expect(x.casino.readChips(xena)).toBe(100);
      // Y takes the table over, with Yuri.
      await spin(y, 2, { [yuri]: red }, 2, false); // amy -10, yuri -10
      await spin(y, 3, { [yuri]: red }, 2); // yuri -10
      sync(x, y);
      const inc = x.casino.readTableState(TABLE)!.inc!;
      for (const page of [x, y]) {
        // (Each side wrote the book and the state in one transaction: the
        // doc keeps one side's of both.)
        expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: keptY ? 'settled' : 'betting', round: keptY ? 3 : 5 });
        expect(Object.keys(bookOf(page, TABLE, inc).recs).sort()).toEqual(keptY ? [amy, yuri] : [amy, xena]);
        expect(page.casino.readChips(amy)).toBe(keptY ? 100 : 120);
        expect(page.casino.readChips(xena)).toBe(100); // (her 10 down on X's round 5, either way)
        expect(page.casino.readChips(yuri)).toBe(keptY ? 80 : 100);
      }
      if (keptY) {
        // Xena's list for X's round 5 is of X's run of rounds: Y's rounds 4
        // and 5 hold none of it, and pay none.
        await spin(y, 4, {}, 1);
        await spin(y, 5, {}, 1, true);
        sync(x, y);
        for (const page of [x, y]) {
          expect(page.casino.readMyBets(TABLE, xena, 5)).toEqual([]);
          expect(page.casino.readChips(xena)).toBe(100);
        }
      } else {
        // On X's run it plays.
        await spin(x, 5, {}, 1, false);
        sync(x, y);
        for (const page of [x, y]) expect(page.casino.readChips(xena)).toBe(120);
      }
      // A third page takes the table over, and the doc's run goes on.
      const z = await loadPage(3);
      sync(x, y, z);
      const next = z.casino.readTableState(TABLE)!.round + 1;
      await spin(z, next, { [amy]: red }, 2); // amy -10
      sync(x, y, z);
      for (const page of [x, y, z]) {
        expect(page.casino.readChips(amy)).toBe(keptY ? 90 : 110);
        expect(page.casino.readChips(xena)).toBe(keptY ? 100 : 120);
        expect(page.casino.readChips(yuri)).toBe(keptY ? 80 : 100);
      }
    });

    it(`craps: standing bets play on as the doc's rolls left them, and a list edited at the other side brings none back (${winner} winning ties)`, async () => {
      const x = await loadPage(cx);
      const y = await loadPage(cy);
      x.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      for (const pid of [amy, xena]) x.casino.buyInChips(pid, 100);
      const big6 = { type: 'big6' as const, amount: 10 };
      const field = { type: 'field' as const, amount: 5 };
      await roll(x, 4, 2, { [amy]: [big6] }); // a six: amy +10, the big 6 stays up
      sync(x, y);
      // The split. X rolls on: a six (amy +10), an eleven (nothing for her).
      // Xena, at X's side, puts a field bet down for the six: lost.
      await roll(x, 3, 3, { [xena]: [field] });
      await roll(x, 5, 6);
      // Amy, at X's side too, adds a field bet to her big 6.
      x.casino.writeMyCrapsBets(CRAPS, amy, [big6, field]);
      expect(x.casino.readChips(amy)).toBe(105);
      // Y rolls a seven: Amy's big 6 is lost.
      await roll(y, 3, 4);
      expect(y.casino.readChips(amy)).toBe(100);
      sync(x, y);
      for (const page of [x, y]) {
        expect(page.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round: keptY ? 2 : 3 });
        expect(page.casino.readMyCrapsBets(CRAPS, amy)).toEqual(keptY ? [] : [big6, field]);
        expect(page.casino.readChips(amy)).toBe(keptY ? 100 : 105);
        // Xena's roll undone, her bet is on the felt as she put it down.
        expect(page.casino.readMyCrapsBets(CRAPS, xena)).toEqual(keptY ? [field] : []);
        expect(page.casino.readChips(xena)).toBe(95);
      }
      // The doc's side rolls on: an eleven pays every field bet on the felt, once.
      await roll(keptY ? y : x, 5, 6);
      sync(x, y);
      for (const page of [x, y]) {
        expect(page.casino.readChips(amy)).toBe(keptY ? 100 : 115);
        expect(page.casino.readChips(xena)).toBe(keptY ? 105 : 95);
      }
    });
  }

  it('three pages in turn, each cut off as the next takes over: chips follow the last one, the doc keeping it', async () => {
    const x = await loadPage(1);
    const y = await loadPage(2);
    const z = await loadPage(3);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    for (const pid of [amy, xena, yuri]) x.casino.buyInChips(pid, 100);
    await spin(x, 1, { [amy]: red }, 1); // amy +10
    sync(x, y, z);
    // X is cut off, settling round 2 with Xena.
    await spin(x, 2, { [xena]: red }, 1); // xena +10
    // Y takes over, with Yuri, and Z hears it.
    await spin(y, 2, { [yuri]: red, [amy]: red }, 2); // yuri -10, amy -10
    sync(y, z);
    // Y is cut off in turn, settling round 3 with Yuri; Z takes over.
    await spin(y, 3, { [yuri]: red }, 1); // yuri +10
    await spin(z, 3, { [amy]: red }, 1); // amy +10
    sync(x, y, z);
    for (const page of [x, y, z]) {
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 3, result: 1 });
      expect(page.casino.readChips(amy)).toBe(110);
      expect(page.casino.readChips(xena)).toBe(100);
      expect(page.casino.readChips(yuri)).toBe(90);
    }
  });

  it('two pages settling on one side (a house member closes, another settles) against one on the other: one book, whole', async () => {
    // The first page on each side to write a key decides the side the doc
    // keeps of it: here b2 writes the state first on its side and b1 the
    // book, so the doc keeps b's state and a's book. It reads as the book
    // has it, and goes on from it.
    const pa = await loadPage(2);
    const b1 = await loadPage(1);
    const b2 = await loadPage(3);
    pa.casino.writeCrapsFairnessPref(TABLE, 'rng');
    pa.casino.buyInChips(amy, 100);
    pa.croupier.openBetting(TABLE, 1);
    pa.casino.writeMyBets(TABLE, amy, 1, red);
    sync(pa, b1, b2);
    // Page a is cut off: it closes and spins red.
    pa.croupier.closeBetting(TABLE, pa.casino.readTableState(TABLE)!);
    spinTo(1);
    pa.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(pa.casino.readChips(amy)).toBe(110);
    // On the other side b2 closes the round and b1 spins black.
    b2.croupier.closeBetting(TABLE, b2.casino.readTableState(TABLE)!);
    sync(b1, b2);
    spinTo(2);
    b1.croupier.rollAndSettle(TABLE, 1);
    await flush();
    sync(b1, b2);
    expect(b2.casino.readChips(amy)).toBe(90);
    sync(pa, b1, b2);
    const inc = pa.casino.readTableState(TABLE)!.inc!;
    for (const page of [pa, b1, b2]) {
      expect((page.doc.getMap('casino').get(`table:${TABLE}`) as { result: number }).result).toBe(2); // b's state
      expect(bookOf(page, TABLE, inc).st.result).toBe(1); // a's book
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1, result: 1 });
      expect(page.casino.readChips(amy)).toBe(110);
    }
    // The next round goes on from the book (put back first, in a fresh write
    // of it), and pays once.
    await spin(b2, 2, { [amy]: red }, 1);
    sync(pa, b1, b2);
    for (const page of [pa, b1, b2]) {
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 2, result: 1 });
      expect(page.casino.readChips(amy)).toBe(120);
    }
  });

  it("roulette: a bet put down on the round after the book's, on the side the doc kept the book of, never comes back when the round opens again", async () => {
    const x = await loadPage(1); // cut off: settles round 2 and opens round 3
    const y = await loadPage(2); // only closes round 2: its state wins ties
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    for (const pid of [amy, xena]) x.casino.buyInChips(pid, 100);
    await spin(x, 1, {}, 1);
    x.croupier.openBetting(TABLE, 2);
    x.casino.writeMyBets(TABLE, amy, 2, red);
    sync(x, y);
    await spin(x, 2, {}, 1, false); // amy +10
    x.croupier.openBetting(TABLE, 3);
    x.casino.writeMyBets(TABLE, xena, 3, red);
    expect(x.casino.readChips(xena)).toBe(90);
    y.croupier.closeBetting(TABLE, y.casino.readTableState(TABLE)!);
    sync(x, y);
    for (const page of [x, y]) {
      expect(page.doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ phase: 'closing', round: 2 });
      // As the book has it: round 2 spun, Xena's round 3 not open.
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 2, result: 1 });
      expect(page.casino.readChips(amy)).toBe(110);
      expect(page.casino.readChips(xena)).toBe(100);
    }
    // Round 3 opens again: Xena's list was of the opening the doc dropped.
    await spin(y, 3, {}, 1);
    sync(x, y);
    for (const page of [x, y]) {
      expect(page.casino.readMyBets(TABLE, xena, 3)).toEqual([]);
      expect(page.casino.readChips(xena)).toBe(100);
    }
  });

  it('craps: a list written over kept bets the doc has no record of at all plays nothing', async () => {
    const x = await loadPage(2); // cut off, its book kept
    const y = await loadPage(1);
    x.casino.writeCrapsFairnessPref(CRAPS, 'rng');
    for (const pid of [amy, xena]) x.casino.buyInChips(pid, 100);
    const place8 = { type: 'place' as const, pick: 8, amount: 10 };
    await roll(x, 2, 2); // a four: the point
    sync(x, y);
    // Xena, at Y's side, puts a place 8 down, rides a roll, and adds to it.
    await roll(y, 3, 3, { [xena]: [place8] });
    y.casino.writeMyCrapsBets(CRAPS, xena, [place8, { ...place8, pick: 6 }]);
    expect(y.casino.readChips(xena)).toBe(80);
    // X rolls on with Amy alone.
    await roll(x, 5, 6, { [amy]: [] });
    sync(x, y);
    for (const page of [x, y]) {
      // The doc keeps X's book, which never saw Xena: her list, written over
      // Y's record of her bets, puts nothing down.
      expect(page.casino.readMyCrapsBets(CRAPS, xena)).toEqual([]);
      expect(page.casino.readChips(xena)).toBe(100);
    }
  });
});

describe('a take-down on each side of a split, the room meeting between the close and the roll', () => {
  const big6 = { type: 'big6' as const, amount: 10 };
  for (const mode of ['rng', 'fair-void'] as const) {
    it(`craps (${mode}): the big 6 the doc keeps up stays up, and a removal hands it back`, async () => {
      const y2 = await loadPage(1); // Amy's tab on the side that took over
      const x = await loadPage(2); // cut off; Amy's tab there too
      const y1 = await loadPage(3); // takes the table over
      x.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      x.casino.buyInChips(amy, 100);
      await roll(x, 3, 5, { [amy]: [big6] }); // an 8: the point, the big 6 stays up
      sync(x, y1, y2);
      // The split. Each side rolls a 5 (the big 6 stays), and Amy takes it
      // down there: both lists are for roll 3.
      await roll(x, 2, 3);
      x.casino.writeMyCrapsBets(CRAPS, amy, []);
      await roll(y1, 1, 4);
      sync(y1, y2);
      y2.casino.writeMyCrapsBets(CRAPS, amy, []);
      sync(y1, y2);
      // Y opens and closes roll 3. (Fair: y2 opens it, so y1, which closes
      // and settles it, has no house seed: it voids it.)
      const opener = mode === 'rng' ? y1 : y2;
      if (mode === 'fair-void') {
        y2.casino.writeCrapsFairnessPref(CRAPS, 'multiparty');
        sync(y1, y2);
      }
      const was = opener.casino.readCrapsTableState(CRAPS)!;
      opener.craps.openCrapsBetting(CRAPS, 3, was.point, was);
      sync(y1, y2);
      y1.craps.closeCrapsBetting(CRAPS, y1.casino.readCrapsTableState(CRAPS)!);
      sync(y1, y2);
      // The room meets: the doc keeps y1's book and state, and x's take-down,
      // written over x's roll, which the doc drops: the big 6 is up again.
      sync(x, y1, y2);
      for (const p of [x, y1, y2]) {
        expect(p.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'closing', round: 3 });
        expect(p.casino.readMyCrapsBets(CRAPS, amy)).toEqual([big6]);
        expect(p.casino.readChips(amy)).toBe(90);
      }
      // A 5 neither wins nor loses a big 6 (Fair: the void leaves every bet up).
      diceTo(1, 4);
      y1.craps.rollAndSettleCraps(CRAPS, 3, y1.casino.readCrapsTableState(CRAPS)!.point);
      await flush();
      sync(x, y1, y2);
      for (const p of [x, y1, y2]) {
        expect(p.casino.readCrapsTableState(CRAPS)).toMatchObject(
          { phase: 'settled', round: 3, ...(mode === 'rng' ? { dice: [1, 4] } : { voided: true }) },
        );
        expect(p.casino.readMyCrapsBets(CRAPS, amy)).toEqual([big6]);
        expect(p.casino.readChips(amy)).toBe(90);
      }
      y1.craps.closeCrapsTable(CRAPS, 'local');
      sync(x, y1, y2);
      for (const p of [x, y1, y2]) expect(p.casino.readChips(amy)).toBe(100);
    });
  }
});

describe('two pages that open a table at once, before either hears the other', () => {
  for (const [cx, cy] of [[1, 2], [2, 1]] as const) {
    it(`roulette: the bets put down on either opening play in the round the doc keeps (clients ${cx}, ${cy})`, async () => {
      const x = await loadPage(cx);
      const y = await loadPage(cy);
      x.casino.writeCrapsFairnessPref(TABLE, 'rng');
      for (const pid of [xena, yuri]) x.casino.buyInChips(pid, 100);
      sync(x, y);
      x.croupier.openBetting(TABLE, 1);
      x.casino.writeMyBets(TABLE, xena, 1, red);
      y.croupier.openBetting(TABLE, 1);
      y.casino.writeMyBets(TABLE, yuri, 1, red);
      sync(x, y);
      for (const page of [x, y]) {
        expect(page.casino.readChips(xena)).toBe(90);
        expect(page.casino.readChips(yuri)).toBe(90);
      }
      await spin(y, 1, {}, 1, false); // red
      sync(x, y);
      for (const page of [x, y]) {
        expect(page.casino.readChips(xena)).toBe(110);
        expect(page.casino.readChips(yuri)).toBe(110);
      }
    });
  }
});

describe("an earlier build's table state", () => {
  it("roulette: an earlier build's round past the book's goes on: the next round opens from it, not back at the book's", async () => {
    const x = await loadPage(1);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    await spin(x, 1, { [amy]: red }, 1); // amy 110
    // An earlier build's page spins round 2: its state names no book.
    const { bk: _bk, ...earlier } = x.casino.readTableState(TABLE)!;
    x.doc.getMap('casino').set(`table:${TABLE}`, { ...earlier, round: 2, result: 3 });
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 2, result: 3 });
    x.croupier.openBetting(TABLE, 3);
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 3 });
    x.casino.writeMyBets(TABLE, amy, 3, red);
    expect(x.casino.readChips(amy)).toBe(100);
    await spin(x, 3, {}, 1, false);
    expect(x.casino.readChips(amy)).toBe(120);
  });
});

describe('an earlier build\'s roulette list, and the state the doc keeps over a settle', () => {
  it('a removal before the next settle hands back nothing the book has paid', async () => {
    const x = await loadPage(1); // settles round 1
    const y = await loadPage(2); // a takeover's stamp at the same moment, winning ties
    const earlier = 'player-Eve';
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    x.croupier.openBetting(TABLE, 1);
    x.doc.getMap('casino').set(`bal:${earlier}`, 90); // an earlier build took her 10
    x.doc.getMap('casino').set(`bets:${TABLE}:${earlier}`, { round: 1, bets: red });
    x.casino.writeMyBets(TABLE, amy, 1, red);
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!);
    sync(x, y);
    y.casino.writeTableState(TABLE, { ...y.casino.readTableState(TABLE)!, operator: y.croupier.ROULETTE_PAGE_ID });
    spinTo(1); // red: Eve's 10 pays 20, Amy's too
    x.croupier.rollAndSettle(TABLE, 1);
    await flush();
    sync(x, y);
    for (const page of [x, y]) {
      expect(page.doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ phase: 'closing' });
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', result: 1 });
      expect(page.casino.readChips(earlier)).toBe(110);
      expect(page.casino.readChips(amy)).toBe(110); // nothing held again
    }
    y.croupier.closeTable(TABLE, 'local');
    sync(x, y);
    x.croupier.closeTable(TABLE);
    sync(x, y);
    for (const page of [x, y]) {
      expect(page.casino.readChips(earlier)).toBe(110);
      expect(page.casino.readChips(amy)).toBe(110);
    }
  });
});

describe('a cut-off page writing a removed incarnation over the table put back', () => {
  it('reads as the book of the table put back, and its next round goes on there', async () => {
    const x = await loadPage(3); // cut off: its writes of the old table win ties
    const y = await loadPage(2); // removes the table and puts it back
    const earlier = 'player-Eve';
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    await spin(x, 1, {}, 1);
    const old = x.casino.readTableState(TABLE)!.inc!;
    sync(x, y);
    // X goes on with the old table.
    await spin(x, 2, { [amy]: red }, 2); // amy -10, on a table the room removed
    // Y removes it, puts it back, and Eve's earlier build bets on its round 1.
    y.croupier.closeTable(TABLE, 'local');
    y.casino.writeCrapsFairnessPref(TABLE, 'rng');
    y.croupier.openBetting(TABLE, 1);
    const inc = y.casino.readTableState(TABLE)!.inc!;
    expect(inc).not.toBe(old);
    y.doc.getMap('casino').set(`bal:${earlier}`, 90);
    y.doc.getMap('casino').set(`bets:${TABLE}:${earlier}`, { round: 1, bets: red });
    await spin(y, 1, {}, 1, false); // Eve's 10 pays 20
    y.croupier.openBetting(TABLE, 2);
    sync(x, y);
    for (const page of [x, y]) {
      expect(page.doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ inc: old }); // X's state
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1, inc });
      expect(page.casino.readChips(earlier)).toBe(110);
      expect(page.casino.readChips(amy)).toBe(90); // the old table's book stands: X spun that round
    }
    // The next round opens on the table put back, not a fresh one, and
    // Eve's round-1 list is no list of it.
    await spin(y, 2, {}, 1);
    sync(x, y);
    for (const page of [x, y]) {
      expect(page.casino.readTableState(TABLE)).toMatchObject({ round: 2, inc });
      expect(page.casino.tableIncRemoved(TABLE, inc)).toBe(false);
      expect(page.casino.readChips(earlier)).toBe(110);
    }
  });
});

describe('a page holding part of another page\'s update', () => {
  /** Page p's writes, one update each, as it sent them. */
  function updatesOf(p: Page, act: () => void): Uint8Array[] {
    const out: Uint8Array[] = [];
    const take = (u: Uint8Array): void => { out.push(u); };
    p.doc.on('update', take);
    act();
    p.doc.off('update', take);
    return out;
  }

  /** Page x drives a roulette table Amy has 30 down on, and Eve 10 from an
   *  earlier build (whose chips it took); page p (a house member) writes a
   *  seat, then closes the round with a SPIN. Page x is given the close
   *  first. */
  async function closeArrivesFirst(): Promise<{ x: Page; p: Page; rest: Uint8Array[]; asked: () => number }> {
    const x = await loadPage(1);
    const p = await loadPage(2);
    let asks = 0;
    x.casino.bindCasinoDoc(x.doc, '', () => { asks += 1; });
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    x.croupier.openBetting(TABLE, 1);
    x.casino.writeMyBets(TABLE, amy, 1, [{ type: 'red', amount: 30 }]);
    x.doc.getMap('casino').set(`bal:${eve}`, 90);
    x.doc.getMap('casino').set(`bets:${TABLE}:${eve}`, { round: 1, bets: red });
    sync(x, p);
    const [seat, close] = updatesOf(p, () => {
      p.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 1 });
      p.croupier.closeBetting(TABLE, p.casino.readTableState(TABLE)!, undefined, p.croupier.ROULETTE_PAGE_ID);
    });
    Y.applyUpdate(x.doc, close);
    return { x, p, rest: [seat], asked: () => asks };
  }

  it('counts a chip record rewritten in the part of an update to come as it read before, until the rest comes', async () => {
    const x = await loadPage(1);
    const p = await loadPage(2);
    p.casino.buyInChips(amy, 100);
    sync(x, p);
    const [first, second] = updatesOf(p, () => {
      p.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 1 });
      p.casino.spendChips(amy, 20);
    });
    Y.applyUpdate(x.doc, second); // its delete of p's record applies at once
    expect(x.casino.readChips(amy)).toBe(100);
    Y.applyUpdate(x.doc, first);
    expect(x.casino.readChips(amy)).toBe(80);
  });

  it("tells a player's listeners of a hold that waited for the rest, when the rest comes in another map", async () => {
    const x = await loadPage(1);
    const p = await loadPage(2);
    const q = await loadPage(3);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    x.croupier.openBetting(TABLE, 1);
    sync(x, p, q);
    const [q1, q2] = updatesOf(q, () => {
      q.doc.getMap('elsewhere').set('a', 1);
      q.doc.getMap('elsewhere').set('b', 2);
    });
    Y.applyUpdate(x.doc, q2);
    for (const u of updatesOf(p, () => p.casino.writeMyBets(TABLE, amy, 1, red))) Y.applyUpdate(x.doc, u);
    const told: number[] = [];
    x.casino.subscribeCasinoKey(`bal:${amy}`, () => told.push(x.casino.readChips(amy)));
    Y.applyUpdate(x.doc, q1);
    expect({ now: x.casino.readChips(amy), told }).toEqual({ now: 90, told: [90] });
  });

  it('spends nothing, though a bet heard whole meanwhile holds chips it has yet to count', async () => {
    for (const partial of [true, false]) {
      const driver = await loadPage(1);
      const tabA = await loadPage(2); // Amy's tab that bets
      const tabB = await loadPage(3); // her other tab, at the cage
      const other = await loadPage(4);
      driver.casino.writeCrapsFairnessPref(TABLE, 'rng');
      driver.casino.buyInChips(amy, 100);
      driver.croupier.openBetting(TABLE, 1);
      sync(driver, tabA, tabB, other);
      // Another page writes a seat twice elsewhere; tab B gets the second first.
      const [first, second] = updatesOf(other, () => {
        other.casino.writeMySeat(CRAPS, 'player-Zed', { stand: 0, angle: 0, at: 1 });
        other.casino.writeMySeat(CRAPS, 'player-Zed', { stand: 0, angle: 0, at: 2 });
      });
      if (partial) Y.applyUpdate(tabB.doc, second);
      for (const u of updatesOf(tabA, () => tabA.casino.writeMyBets(TABLE, amy, 1, [{ type: 'red', amount: 100 }]))) {
        Y.applyUpdate(tabB.doc, u);
      }
      expect(tabB.casino.readMyBets(TABLE, amy, 1)).toEqual([{ type: 'red', amount: 100 }]);
      expect(tabB.casino.spendChips(amy, 100)).toBe(false);
      expect(tabB.casino.cashOutChips(amy, 100)).toBe(0);
      if (partial) Y.applyUpdate(tabB.doc, first);
      expect(tabB.casino.readChips(amy)).toBe(0);
    }
  });

  it('takes no bankroll deposit from chips a bet heard whole meanwhile holds', async () => {
    for (const partial of [true, false]) {
      const driver = await loadPage(1);
      const tabA = await loadPage(2); // Amy's tab that bets
      const tabB = await loadPage(3); // her other tab, at her slot machine
      const other = await loadPage(4);
      const machine = 'slot-9';
      const funding = { mode: 'machine' as const, ownerId: amy };
      driver.casino.writeCrapsFairnessPref(TABLE, 'rng');
      driver.casino.buyInChips(amy, 50);
      driver.casino.writeSlotFundingConfig(machine, funding);
      driver.croupier.openBetting(TABLE, 1);
      sync(driver, tabA, tabB, other);
      const [first, second] = updatesOf(other, () => {
        other.casino.writeMySeat(CRAPS, 'player-Zed', { stand: 0, angle: 0, at: 1 });
        other.casino.writeMySeat(CRAPS, 'player-Zed', { stand: 0, angle: 0, at: 2 });
      });
      if (partial) Y.applyUpdate(tabB.doc, second);
      for (const u of updatesOf(tabA, () => tabA.casino.writeMyBets(TABLE, amy, 1, [{ type: 'odd', amount: 50 }]))) {
        Y.applyUpdate(tabB.doc, u);
      }
      expect(tabB.casino.depositSlotFunding(machine, amy, 50)).toBe(false);
      if (partial) Y.applyUpdate(tabB.doc, first);
      sync(driver, tabA, tabB, other);
      expect({ chips: tabB.casino.readChips(amy), bankroll: tabB.casino.readSlotFundingBalance(machine, funding) })
        .toEqual({ chips: 0, bankroll: 0 });
    }
  });

  it('bound on a snapshot of part of an update (the room cache), spends nothing until the rest comes', async () => {
    const { x, rest } = await closeArrivesFirst();
    expect(x.casino.readChips(amy)).toBe(70); // the 30 still held
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(x.doc)); // the cache's copy
    x.casino.bindCasinoDoc(fresh); // the table reads as gone: its 30 as free
    expect(x.casino.casinoWhole()).toBe(false);
    expect(x.casino.cashOutChips(amy, 100)).toBe(0);
    expect(x.casino.spendChips(amy, 100)).toBe(false);
    for (const u of rest) Y.applyUpdate(fresh, u);
    expect(x.casino.casinoWhole()).toBe(true);
    expect(x.casino.readChips(amy)).toBe(70);
    expect(x.casino.cashOutChips(amy, 100)).toBe(70);
  });

  it('bound on a snapshot holding a chip record rewritten in the part to come, spends nothing until it comes', async () => {
    const x = await loadPage(1);
    const w = await loadPage(2); // Amy's other tab, spending at a slot
    x.casino.buyInChips(amy, 100);
    sync(x, w);
    expect(w.casino.spendChips(amy, 50)).toBe(true);
    sync(x, w);
    const [seat, spend] = updatesOf(w, () => {
      w.casino.writeMySeat(CRAPS, amy, { stand: 0, angle: 0, at: 1 });
      w.casino.spendChips(amy, 10);
    });
    Y.applyUpdate(x.doc, spend);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(x.doc));
    x.casino.bindCasinoDoc(fresh);
    expect(x.casino.cashOutChips(amy, 100)).toBe(0);
    Y.applyUpdate(fresh, seat);
    expect(x.casino.readChips(amy)).toBe(40);
  });

  it('reads the table as gone, and counts, opens, bets and settles nothing, until the rest comes', async () => {
    const { x, rest, asked } = await closeArrivesFirst();
    expect(x.doc.getMap('casino').has(`table:${TABLE}`)).toBe(false); // parked
    expect(x.casino.casinoWhole()).toBe(false);
    expect(asked()).toBe(1); // the room asked for what it is missing
    expect(x.casino.readChips(amy)).toBe(70); // the 30 still held
    x.croupier.tickAutoCroupier(TABLE); // would open a table read as gone
    x.casino.writeMyBets(TABLE, amy, 1, [{ type: 'red', amount: 50 }]);
    expect([...x.doc.getMap('casino').keys()].filter((k) => k.startsWith('gone:'))).toEqual([]);
    expect(x.doc.getMap('casino').get(`bets:${TABLE}:${amy}`)).toMatchObject({ held: [{ type: 'red', amount: 30 }] });
    for (const u of rest) Y.applyUpdate(x.doc, u);
    expect(x.casino.casinoWhole()).toBe(true);
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'closing', round: 1 });
    expect(x.casino.readChips(amy)).toBe(70);
  });

  it('a removal heard meanwhile waits for the rest, then hands back once', async () => {
    const { x, p, rest } = await closeArrivesFirst();
    x.croupier.closeTable(TABLE, 'heard');
    expect(x.doc.getMap('casino').has(`bets:${TABLE}:${amy}`)).toBe(true); // nothing yet
    expect(x.casino.readChips(eve)).toBe(90);
    for (const u of rest) Y.applyUpdate(x.doc, u);
    await flush();
    expect(x.doc.getMap('casino').has(`bets:${TABLE}:${amy}`)).toBe(false);
    expect(x.casino.readTableState(TABLE)).toBeNull();
    expect(x.casino.readChips(amy)).toBe(100);
    expect(x.casino.readChips(eve)).toBe(100); // her earlier build's 10 back
    // Another page hears the removal too: nothing comes back twice.
    sync(x, p);
    p.croupier.closeTable(TABLE, 'heard');
    await flush();
    sync(x, p);
    for (const page of [x, p]) expect(page.casino.readChips(eve)).toBe(100);
  });

  it('a removal heard meanwhile is dropped when the table is back in the room by then', async () => {
    const { x, rest } = await closeArrivesFirst();
    x.croupier.setTableInRoomPredicate((id) => id === TABLE);
    x.croupier.closeTable(TABLE, 'heard');
    for (const u of rest) Y.applyUpdate(x.doc, u);
    await flush();
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'closing', round: 1 });
    expect(x.casino.readChips(amy)).toBe(70);
  });

  it("claims no lease while it holds part of an update: the driver's renewal parked there reads as none", async () => {
    const y = await loadPage(1); // driving
    const x = await loadPage(2); // another of the owner's pages
    const { TABLE_LEASE_RENEW_MS, TABLE_LEASE_SETTLE_MS } = y.croupier;
    let t = 0;
    for (; t <= TABLE_LEASE_SETTLE_MS + 500; t += 100) y.croupier.takeTableTurn(t);
    sync(x, y);
    for (let u = 0; u <= t; u += 100) expect(x.croupier.takeTableTurn(u)).toBe(false);
    const [seat, renewal] = updatesOf(y, () => {
      y.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 1 });
      y.croupier.takeTableTurn(t + TABLE_LEASE_RENEW_MS);
    });
    expect(renewal).toBeDefined();
    Y.applyUpdate(x.doc, renewal);
    expect(x.casino.readTableOperatorLease()).toBeNull();
    for (let u = t; u <= t + 2_000; u += 100) expect(x.croupier.takeTableTurn(u)).toBe(false);
    expect(x.casino.readTableOperatorLease()).toBeNull(); // no claim written
    Y.applyUpdate(x.doc, seat);
    sync(x, y);
    expect(y.casino.readTableOperatorLease()?.page).toBe(y.croupier.ROULETTE_PAGE_ID);
    expect(y.croupier.takeTableTurn(t + TABLE_LEASE_RENEW_MS + 100)).toBe(true);
  });

  it('the page driving the tables lets them go after a lease\'s lapse', async () => {
    const x = await loadPage(1);
    const p = await loadPage(2);
    const { TABLE_LEASE_LAPSE_MS, TABLE_LEASE_SETTLE_MS } = x.croupier;
    expect(x.croupier.takeTableTurn(0)).toBe(false); // claims
    const beat = (): number => x.casino.readTableOperatorLease()!.beat;
    // Driving, then given the second of p's two writes first.
    let driving = false;
    for (let t = 100; t <= TABLE_LEASE_SETTLE_MS + 500; t += 100) driving = x.croupier.takeTableTurn(t) || driving;
    expect(driving).toBe(true);
    const rest = updatesOf(p, () => {
      p.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 1 });
      p.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 2 });
    });
    Y.applyUpdate(x.doc, rest.pop()!);
    expect(x.casino.casinoWhole()).toBe(false);
    const before = beat();
    const from = TABLE_LEASE_SETTLE_MS + 600;
    for (let t = from; t <= 3 * TABLE_LEASE_LAPSE_MS; t += 100) {
      expect(x.croupier.takeTableTurn(t) && t >= from + TABLE_LEASE_LAPSE_MS).toBe(false);
    }
    const renewed = beat() - before;
    expect(renewed).toBeLessThanOrEqual(Math.ceil(TABLE_LEASE_LAPSE_MS / x.croupier.TABLE_LEASE_RENEW_MS));
    for (let t = 3 * TABLE_LEASE_LAPSE_MS; t <= 4 * TABLE_LEASE_LAPSE_MS; t += 100) x.croupier.takeTableTurn(t);
    expect(beat() - before).toBe(renewed); // none since
    for (const u of rest) Y.applyUpdate(x.doc, u);
    for (let t = 4 * TABLE_LEASE_LAPSE_MS; t <= 4 * TABLE_LEASE_LAPSE_MS + 3_000; t += 100) x.croupier.takeTableTurn(t);
    expect(beat()).toBeGreaterThan(before + renewed); // whole again: renewing
  });

  /** Page x drives a roulette and a craps table, both open; page p writes
   *  Amy's seat twice, and x is given the second write first. Nothing x
   *  reads of the tables is missing, but the doc isn't whole. */
  async function seatArrivesSecondFirst(): Promise<{ x: Page; rest: Uint8Array[] }> {
    const x = await loadPage(1);
    const p = await loadPage(2);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.writeCrapsFairnessPref(CRAPS, 'rng');
    x.casino.buyInChips(amy, 100);
    x.croupier.openBetting(TABLE, 1);
    x.craps.openCrapsBetting(CRAPS, 1, null);
    sync(x, p);
    const [first, second] = updatesOf(p, () => {
      p.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 1 });
      p.casino.writeMySeat(TABLE, amy, { stand: 0, angle: 0, at: 2 });
    });
    Y.applyUpdate(x.doc, second);
    return { x, rest: [first] };
  }

  it('takes no bet while it holds part of an update, though the tables read up', async () => {
    const { x, rest } = await seatArrivesSecondFirst();
    expect(x.casino.casinoWhole()).toBe(false);
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 1 });
    x.casino.writeMyBets(TABLE, amy, 1, red);
    x.casino.writeMyCrapsBets(CRAPS, amy, [{ type: 'pass', amount: 10 }]);
    expect(x.casino.readMyBets(TABLE, amy, 1)).toEqual([]);
    expect(x.casino.readMyCrapsBets(CRAPS, amy)).toEqual([]);
    for (const u of rest) Y.applyUpdate(x.doc, u);
    x.casino.writeMyBets(TABLE, amy, 1, red);
    expect(x.casino.readChips(amy)).toBe(90);
  });

  it('craps: rolls nothing, and voids nothing, until the rest comes', async () => {
    const { x, rest } = await seatArrivesSecondFirst();
    for (const u of rest) Y.applyUpdate(x.doc, u);
    x.casino.writeMyCrapsBets(CRAPS, amy, [{ type: 'pass', amount: 10 }]);
    x.craps.closeCrapsBetting(CRAPS, x.casino.readCrapsTableState(CRAPS)!);
    const p = await loadPage(3);
    sync(x, p);
    const [first, second] = updatesOf(p, () => {
      p.casino.writeMySeat(CRAPS, amy, { stand: 0, angle: 0, at: 1 });
      p.casino.writeMySeat(CRAPS, amy, { stand: 0, angle: 0, at: 2 });
    });
    Y.applyUpdate(x.doc, second);
    diceTo(3, 4);
    x.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    expect(x.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'closing', round: 1 });
    Y.applyUpdate(x.doc, first);
    x.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    expect(x.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round: 1, dice: [3, 4] });
    expect(x.casino.readChips(amy)).toBe(110);
  });

  it('craps: a Fair roll this page has no house seed for is voided only once the rest comes', async () => {
    const x = await loadPage(1);
    const p = await loadPage(2); // opened and closed the Fair roll, then went away
    p.casino.buyInChips(amy, 100);
    p.craps.openCrapsBetting(CRAPS, 1, null);
    p.casino.writeMyCrapsBets(CRAPS, amy, [{ type: 'pass', amount: 10 }]);
    p.craps.closeCrapsBetting(CRAPS, p.casino.readCrapsTableState(CRAPS)!);
    sync(x, p);
    const [first, second] = updatesOf(p, () => {
      p.casino.writeMySeat(CRAPS, amy, { stand: 0, angle: 0, at: 1 });
      p.casino.writeMySeat(CRAPS, amy, { stand: 0, angle: 0, at: 2 });
    });
    Y.applyUpdate(x.doc, second);
    x.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    expect(x.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'closing', round: 1 });
    Y.applyUpdate(x.doc, first);
    x.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    expect(x.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round: 1, dice: null });
    expect(x.casino.readMyCrapsBets(CRAPS, amy)).toEqual([{ type: 'pass', amount: 10 }]); // every bet stands
  });

  it("a table's book read before and gone now holds its settles, whatever the doc's own record says", async () => {
    const x = await loadPage(1);
    const peer = await loadPage(2);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    await spin(x, 1, { [amy]: red }, 1);
    const inc = x.casino.readTableState(TABLE)!.inc!;
    x.croupier.openBetting(TABLE, 2);
    x.casino.writeMyBets(TABLE, amy, 2, red);
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!);
    sync(x, peer);
    peer.doc.getMap('casinoChips').delete(`book:${TABLE}:${inc}`); // no build does
    sync(x, peer);
    expect(x.casino.casinoWhole()).toBe(true);
    expect(x.casino.casinoWhole(TABLE)).toBe(false);
    spinTo(1);
    x.croupier.rollAndSettle(TABLE, 2);
    await flush();
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'closing', round: 2 });
    expect(x.casino.readTableBook(TABLE, inc)).toBeNull();
  });
});

describe("a page back in the room on the room cache's copy", () => {
  /** Page x drives round 1 and closes round 2, then leaves (the cache keeps
   *  its doc, its lease in it); page y takes the tables over and settles
   *  rounds 2 to 4. Then x comes back, the same page load, on the cache's
   *  copy, its doc winning ties, the room's state not in yet. */
  async function backOnTheCache(): Promise<{ x: Page; y: Page; back: Y.Doc; at: number; arrived: { now: boolean } }> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 2_000_000_000;
    vi.setSystemTime(t0);
    const x = await loadPage(2);
    const y = await loadPage(1);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    for (let t = t0; t <= t0 + 2_000; t += 100) x.croupier.takeTableTurn(t);
    vi.setSystemTime(t0 + 2_000);
    await spin(x, 1, { [amy]: red }, 1); // red: 110
    x.croupier.openBetting(TABLE, 2);
    x.casino.writeMyBets(TABLE, amy, 2, red);
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!);
    sync(x, y);
    const cached = Y.encodeStateAsUpdate(x.doc);
    let t = t0 + 3_000;
    for (; t <= t0 + 12_000; t += 100) y.croupier.takeTableTurn(t);
    vi.setSystemTime(t);
    expect(y.croupier.takeTableTurn(t)).toBe(true);
    spinTo(2);
    y.croupier.rollAndSettle(TABLE, 2);
    await flush();
    await spin(y, 3, { [amy]: red }, 2);
    await spin(y, 4, { [amy]: red }, 2);
    expect(y.casino.readChips(amy)).toBe(80);
    const arrived = { now: false };
    x.croupier.setRoomStateArrivedCheck(() => arrived.now);
    const back = new Y.Doc();
    back.clientID = 3;
    Y.applyUpdate(back, cached);
    x.casino.bindCasinoDoc(back);
    return { x, y, back, at: t + 60_000, arrived };
  }

  /** x's frames from `from` for `ms`; when it drives. */
  async function frames(x: Page, from: number, ms: number): Promise<number | null> {
    for (let u = from; u <= from + ms; u += 100) {
      vi.setSystemTime(u);
      x.croupier.noteTablesRunning(u);
      if (x.croupier.takeTableTurn(u)) {
        spinTo(1);
        x.croupier.tickAutoCroupier(TABLE);
        await flush();
        return u;
      }
    }
    return null;
  }

  it("drives nothing until the room's state is in, then goes on from it", async () => {
    try {
      const { x, y, back, at, arrived } = await backOnTheCache();
      expect(await frames(x, at, 10_000)).toBeNull();
      expect(x.croupier.tablesAwake(at + 10_000)).toBe(false);
      expect(x.casino.tableWritable(TABLE)).toBe(false);
      // The room's state comes in.
      Y.applyUpdate(back, Y.encodeStateAsUpdate(y.doc, Y.encodeStateVector(back)));
      arrived.now = true;
      expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 4 });
      Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(back, Y.encodeStateVector(y.doc)));
      for (const doc of [back, y.doc]) expect(doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ round: 4 });
      expect(y.casino.readChips(amy)).toBe(80);
      expect(x.casino.readChips(amy)).toBe(80);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs its tables on the copy it has once it has waited for the room's state long enough", async () => {
    try {
      const { x, at } = await backOnTheCache();
      const drove = await frames(x, at, x.croupier.ROOM_STATE_WAIT_MS + 3_000);
      expect(drove).not.toBeNull();
      expect(drove! - at).toBeGreaterThanOrEqual(x.croupier.ROOM_STATE_WAIT_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a page waiting out a wake', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes no table's book back up until it is awake: its doc may not have the room's", async () => {
    const x = await loadPage(1);
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(amy, 100);
    x.croupier.openBetting(TABLE, 1);
    x.casino.writeMyBets(TABLE, amy, 1, red);
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!);
    const closing = x.casino.readTableState(TABLE)!;
    await spin(x, 1, {}, 1, false);
    const inc = closing.inc!;
    const book = bookOf(x, TABLE, inc).id;
    // A takeover's stamp, written as the settle was, came back over it.
    x.doc.getMap('casino').set(`table:${TABLE}`, { ...closing, operator: 'someone-else:tab' });
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1 });
    // The computer slept: a lapse and more without a frame.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 2_000_000_000;
    x.croupier.noteTablesRunning(t0);
    x.croupier.noteTablesRunning(t0 + 60_000);
    vi.setSystemTime(t0 + 60_000);
    expect(x.croupier.tablesAwake()).toBe(false);
    x.croupier.openBetting(TABLE, 2);
    x.casino.writeTableState(TABLE, { ...closing, phaseDeadline: t0 + 60_000 });
    expect(x.doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ phase: 'closing', operator: 'someone-else:tab' });
    expect(bookOf(x, TABLE, inc).id).toBe(book);
    // Awake again: it goes on from the book.
    let t = t0 + 60_000;
    for (; !x.croupier.tablesAwake(t); t += 100) x.croupier.noteTablesRunning(t);
    vi.setSystemTime(t);
    x.croupier.openBetting(TABLE, 2);
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 2 });
    expect(bookOf(x, TABLE, inc).id).not.toBe(book);
    expect(x.casino.readChips(amy)).toBe(110);
  });
});

describe('a settle under way when the doc swaps its round for the other side\'s of that number', () => {
  it("craps: the roll isn't settled on the other side's state, with its own point and bets", async () => {
    const x = await loadPage(1); // its roll hashing as the doc swaps
    const y = await loadPage(2); // the other side, winning ties
    x.casino.buyInChips(amy, 100);
    x.craps.openCrapsBetting(CRAPS, 1, null); // Fair, the default: each page's house seed its own
    x.craps.closeCrapsBetting(CRAPS, x.casino.readCrapsTableState(CRAPS)!);
    sync(x, y);
    // The split. Y has no house seed for roll 1: it voids it, and goes on.
    y.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    expect(y.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round: 1, dice: null });
    y.craps.openCrapsBetting(CRAPS, 2, null, y.casino.readCrapsTableState(CRAPS));
    y.craps.closeCrapsBetting(CRAPS, y.casino.readCrapsTableState(CRAPS)!);
    const theirs = y.casino.readCrapsTableState(CRAPS)!;
    // X rolls roll 1, opens and closes roll 2, and rolls it: the doc swaps
    // to Y's as it hashes.
    x.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    const after1 = x.casino.readCrapsTableState(CRAPS)!;
    x.craps.openCrapsBetting(CRAPS, 2, after1.point, after1);
    x.craps.closeCrapsBetting(CRAPS, x.casino.readCrapsTableState(CRAPS)!);
    x.craps.rollAndSettleCraps(CRAPS, 2, after1.point);
    sync(x, y);
    await flush();
    expect(x.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'closing', round: 2, bk: theirs.bk });
  });

  it("roulette: the round isn't settled on the other side's state of it", async () => {
    const x = await loadPage(1);
    const y = await loadPage(2);
    x.casino.buyInChips(amy, 100);
    x.croupier.openBetting(TABLE, 1); // Fair, the default
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!);
    sync(x, y);
    y.croupier.rollAndSettle(TABLE, 1); // no house seed: void
    await flush();
    expect(y.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1, result: null });
    y.croupier.openBetting(TABLE, 2);
    y.croupier.closeBetting(TABLE, y.casino.readTableState(TABLE)!);
    const theirs = y.casino.readTableState(TABLE)!;
    x.croupier.rollAndSettle(TABLE, 1);
    await flush();
    x.croupier.openBetting(TABLE, 2);
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!);
    x.croupier.rollAndSettle(TABLE, 2);
    sync(x, y);
    await flush();
    expect(x.casino.readTableState(TABLE)).toMatchObject({ phase: 'closing', round: 2, bk: theirs.bk });
  });
});

describe('a Fair round frozen on the side the doc dropped', () => {
  it("settles by the round's own frozen fields, not this page's snapshot of the other side's", async () => {
    const x = await loadPage(1);
    x.casino.buyInChips(amy, 100);
    x.craps.openCrapsBetting(CRAPS, 1, null); // Fair, the default
    x.casino.writeMyCrapsBets(CRAPS, amy, [{ type: 'field', amount: 10 }]);
    x.craps.closeCrapsBetting(CRAPS, x.casino.readCrapsTableState(CRAPS)!);
    const closing = x.casino.readCrapsTableState(CRAPS)!;
    expect(x.fair.frozenFields(CRAPS, closing).stakes).toEqual({ [amy]: 10 });
    // The same round as the doc's other side opened and froze it: its own
    // fields, another write of the book behind it.
    const other = { ...closing, bk: 'other.1', stakes: { [amy]: 50 }, commits: {}, wagers: {} };
    expect(x.fair.frozenFields(CRAPS, other).stakes).toEqual({ [amy]: 50 });
    expect(x.fair.heldAtClose(CRAPS, other, amy)).toBe(50);
    // (The check of a settled round goes by round, as ever.)
    expect(x.fair.frozenFields(CRAPS, { ...closing, phase: 'settled', bk: 'mine.2' }).stakes).toEqual({ [amy]: 10 });
  });
});

describe("a bettor whose list the doc lost in the split, frozen by the close on the side it keeps", () => {
  const big6 = { type: 'big6' as const, amount: 10 };
  const place9 = { type: 'place' as const, pick: 9, amount: 10 };
  for (const mode of ['rng', 'fair-roll', 'fair-void'] as const) {
    it(`craps (${mode}): the big 6 the doc keeps up plays as the doc has it, nothing is charged for the bets it lost, and a removal hands back the rest`, async () => {
      const y2 = await loadPage(1); // Amy's tab on the side that took over
      const x = await loadPage(2); // cut off; Amy's tab there too
      const y1 = await loadPage(3); // takes the table over
      x.casino.writeCrapsFairnessPref(CRAPS, 'rng');
      x.casino.buyInChips(amy, 100);
      await roll(x, 3, 5, { [amy]: [big6] }); // an 8: the point, the big 6 stays up
      sync(x, y1, y2);
      await roll(x, 2, 3);
      x.casino.writeMyCrapsBets(CRAPS, amy, []); // the cut-off side: Amy takes it down
      await roll(y1, 1, 4);
      sync(y1, y2);
      // The other side: Amy adds a place 9 to her big 6.
      expect(y2.casino.writeMyCrapsBets(CRAPS, amy, [big6, place9])).toBe(true);
      sync(y1, y2);
      expect(y1.casino.readChips(amy)).toBe(80);
      // (Fair, the void: y1 holds no house seed for the round y2 opened.)
      const opener = mode === 'fair-void' ? y2 : y1;
      if (mode !== 'rng') {
        y2.casino.writeCrapsFairnessPref(CRAPS, 'multiparty');
        sync(y1, y2);
      }
      const was = opener.casino.readCrapsTableState(CRAPS)!;
      opener.craps.openCrapsBetting(CRAPS, 3, was.point, was);
      sync(y1, y2);
      y1.craps.closeCrapsBetting(CRAPS, y1.casino.readCrapsTableState(CRAPS)!);
      sync(y1, y2);
      // The room meets: the doc keeps y1's book and state, and x's list for Amy
      // (x's client id beats y2's), written over x's roll: her big 6 is up again.
      sync(x, y1, y2);
      expect(y1.casino.readMyCrapsBets(CRAPS, amy)).toEqual([big6]);
      diceTo(1, 4); // a 5 leaves a big 6 up
      y1.craps.rollAndSettleCraps(CRAPS, 3, y1.casino.readCrapsTableState(CRAPS)!.point);
      await flush();
      sync(x, y1, y2);
      expect(y1.casino.readCrapsTableState(CRAPS)).toMatchObject({ phase: 'settled', round: 3 });
      expect([x, y1, y2].map((p) => p.casino.readMyCrapsBets(CRAPS, amy))).toEqual([[big6], [big6], [big6]]);
      expect([x, y1, y2].map((p) => p.casino.readChips(amy))).toEqual([90, 90, 90]);
      y1.craps.closeCrapsTable(CRAPS, 'local');
      sync(x, y1, y2);
      expect([x, y1, y2].map((p) => p.casino.readChips(amy))).toEqual([100, 100, 100]);
    });
  }

  for (const mode of ['rng', 'multiparty'] as const) {
    it(`roulette (${mode}): a list the doc lost is handed back, not charged as a rewrite`, async () => {
      const y2 = await loadPage(1); // Amy's tab on the side that took over
      const x = await loadPage(2); // cut off; Amy's tab there too
      const y1 = await loadPage(3); // takes the table over
      x.casino.writeCrapsFairnessPref(TABLE, 'rng');
      x.casino.buyInChips(amy, 100);
      await spin(x, 1, {}, 1);
      sync(x, y1, y2);
      // The split: each side spins round 2, then opens round 3, Amy betting 10 there.
      await spin(x, 2, {}, 1);
      x.casino.writeCrapsFairnessPref(TABLE, mode);
      x.croupier.openBetting(TABLE, 3);
      x.casino.writeMyBets(TABLE, amy, 3, red);
      await spin(y1, 2, {}, 2);
      y1.casino.writeCrapsFairnessPref(TABLE, mode);
      y1.croupier.openBetting(TABLE, 3);
      sync(y1, y2);
      y2.casino.writeMyBets(TABLE, amy, 3, red);
      sync(y1, y2);
      y1.croupier.closeBetting(TABLE, y1.casino.readTableState(TABLE)!);
      sync(y1, y2);
      sync(x, y1, y2); // the doc keeps y1's book and close, x's list for Amy
      expect(y1.casino.readMyBets(TABLE, amy, 3)).toEqual([]);
      spinTo(1);
      y1.croupier.rollAndSettle(TABLE, 3);
      await flush();
      sync(x, y1, y2);
      expect(y1.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 3 });
      expect([x, y1, y2].map((p) => p.casino.readChips(amy))).toEqual([100, 100, 100]);
    });
  }
});
