/**
 * 🎰 The table operator lease (croupier.ts takeTableTurn).
 *
 * The deed holder can have the room open on two pages, and both may run the
 * croupier. Chip records add up, so two pages settling one round would pay it
 * twice: only the page holding `table-operator` drives the tables. These specs
 * run two pages of one owner (each its own load of croupier + casinoDoc, its
 * own Y.Doc, synced by hand) through claims, renewals, a page going away, and
 * a table torn down on both: whatever each page saw, a bettor is paid one
 * outcome for a round (creditTableOutcome).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

type Page = {
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  craps: typeof import('./crapsCroupier');
  backend: typeof import('./crapsBackend');
  fair: typeof import('./fairTableSeeds');
  doc: Y.Doc;
};

const OWNER = 'owner-Alice';
const EARLIER_OWNER = 'owner-Bob';
const TABLE = 'roulette-1';

// crapsBackend hangs a debug handle on window.
vi.stubGlobal('window', { location: { search: '' } });

// Both pages are the deed holder's.
vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

/** `clientID` fixes which page's write wins a tie in the doc. */
async function loadPage(clientID?: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const craps = await import('./crapsCroupier');
  const backend = await import('./crapsBackend');
  const fair = await import('./fairTableSeeds');
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  casino.bindCasinoDoc(doc);
  return { casino, croupier, craps, backend, fair, doc };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function turn(page: Page, now: number): boolean {
  return page.croupier.takeTableTurn(now);
}

/** Let an async settle (the dice's hashing) land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The incarnation and book of a table's one book in the page's doc. */
function onlyBook(page: Page, table: string): { inc: string; book: import('./casinoDoc').TableBook } {
  const keys = [...page.doc.getMap('casinoChips').keys()].filter((k) => k.startsWith(`book:${table}:`));
  expect(keys).toHaveLength(1);
  const inc = keys[0].slice(`book:${table}:`.length);
  return { inc, book: page.casino.readTableBook(table, inc)! };
}

/** Count the updates a page's doc sends while `act` runs. */
function updatesDuring(page: Page, act: () => void): number {
  let n = 0;
  const count = (): void => { n += 1; };
  page.doc.on('update', count);
  act();
  page.doc.off('update', count);
  return n;
}

let a: Page;
let b: Page;

beforeEach(async () => {
  a = await loadPage();
  b = await loadPage();
});

describe('two pages of the deed holder', () => {
  it('claiming at the same moment, exactly one drives, and keeps driving', () => {
    expect(turn(a, 0)).toBe(false);
    expect(turn(b, 0)).toBe(false);
    sync(a.doc, b.doc);
    const drivers = new Set<string>();
    for (let t = 100; t <= 30_000; t += 100) {
      const now = [turn(a, t) && 'a', turn(b, t) && 'b'].filter(Boolean);
      expect(now.length).toBeLessThanOrEqual(1);
      if (t >= 1_500) expect(now).toHaveLength(1);
      for (const d of now) drivers.add(d as string);
      if (t % 500 === 0) sync(a.doc, b.doc);
    }
    expect(drivers.size).toBe(1);
  });

  it('when the driving page goes away, the other takes over once the lease lapses', () => {
    turn(a, 0);
    sync(a.doc, b.doc);
    expect(turn(b, 0)).toBe(false); // a holds it
    expect(turn(a, 1_600)).toBe(true);
    sync(a.doc, b.doc);
    // Page a closes. b sees no renewal for TABLE_LEASE_LAPSE_MS, claims, settles.
    const { TABLE_LEASE_LAPSE_MS, TABLE_LEASE_SETTLE_MS } = b.croupier;
    let firstDrive = -1;
    for (let t = 1_600; t <= 20_000 && firstDrive < 0; t += 100) {
      if (turn(b, t)) firstDrive = t;
    }
    expect(firstDrive).toBeGreaterThanOrEqual(TABLE_LEASE_LAPSE_MS);
    expect(firstDrive).toBeLessThanOrEqual(1_600 + TABLE_LEASE_LAPSE_MS + TABLE_LEASE_SETTLE_MS + 200);
  });

  it('a page that keeps renewing is never taken over, however long', () => {
    turn(a, 0);
    sync(a.doc, b.doc);
    for (let t = 100; t <= 60_000; t += 100) {
      turn(a, t);
      expect(turn(b, t)).toBe(false);
      if (t % 1_000 === 0) sync(a.doc, b.doc);
    }
  });

  it('a page that slept wakes without driving, so a doc that missed the takeover catches up first', () => {
    turn(a, 0);
    expect(turn(a, 1_600)).toBe(true);
    sync(a.doc, b.doc);
    // Page a sleeps; page b sees its lease lapse and takes over.
    const woke = 30_000;
    let bDrives = false;
    for (let t = 1_600; t < woke; t += 100) bDrives = turn(b, t);
    expect(bDrives).toBe(true);
    // Page a wakes on its own doc, before the room's updates reach it, and
    // the doc catches up two seconds later.
    const { TABLE_LEASE_LAPSE_MS } = a.croupier;
    const aWrites = updatesDuring(a, () => {
      for (let now = woke; now < woke + 2_000; now += 100) {
        expect(turn(a, now)).toBe(false);
        turn(b, now);
      }
    });
    expect(aWrites).toBe(0);
    for (let now = woke + 2_000; now <= woke + 3 * TABLE_LEASE_LAPSE_MS; now += 100) {
      if (now % 1_000 === 0) sync(a.doc, b.doc);
      expect(turn(a, now)).toBe(false);
      expect(turn(b, now)).toBe(true);
    }
  });

  it('and a page alone, after a sleep, drives again once it has waited a lapse', () => {
    turn(a, 0);
    expect(turn(a, 1_600)).toBe(true);
    const { TABLE_LEASE_LAPSE_MS } = a.croupier;
    expect(turn(a, 30_000)).toBe(false);
    expect(turn(a, 30_000 + TABLE_LEASE_LAPSE_MS - 100)).toBe(false);
    expect(turn(a, 30_000 + TABLE_LEASE_LAPSE_MS)).toBe(true);
  });

  it('and a clock that jumps an hour ahead for a frame and back holds the tables a lapse at most', () => {
    turn(a, 0);
    expect(turn(a, 1_600)).toBe(true);
    const { TABLE_LEASE_LAPSE_MS } = a.croupier;
    expect(turn(a, 1_700 + 3_600_000)).toBe(false); // looks like a wake
    let driving = 0;
    for (let now = 1_800; now <= 1_800 + 2 * TABLE_LEASE_LAPSE_MS; now += 100) if (turn(a, now)) driving += 1;
    expect(driving).toBeGreaterThan(0);
    expect(turn(a, 1_900 + 2 * TABLE_LEASE_LAPSE_MS)).toBe(true);
  });

  it('a page not driving takes over a lapse after its clock went back an hour, not an hour later', () => {
    const HOUR = 3_600_000;
    turn(a, HOUR);
    expect(turn(a, HOUR + 1_600)).toBe(true);
    sync(a.doc, b.doc);
    expect(turn(b, HOUR + 1_700)).toBe(false); // b watches a's lease...
    // ...its clock goes back an hour, and page a closes.
    const { TABLE_LEASE_LAPSE_MS, TABLE_LEASE_SETTLE_MS } = b.croupier;
    let firstDrive = -1;
    for (let t = 1_800; t <= 30_000 && firstDrive < 0; t += 100) if (turn(b, t)) firstDrive = t;
    expect(firstDrive).toBeGreaterThan(0);
    expect(firstDrive).toBeLessThanOrEqual(1_800 + TABLE_LEASE_LAPSE_MS + TABLE_LEASE_SETTLE_MS + 200);
  });

  it('and the driving page drives and renews again a lapse after its clock went back', () => {
    const HOUR = 3_600_000;
    turn(a, HOUR);
    expect(turn(a, HOUR + 1_600)).toBe(true);
    const { TABLE_LEASE_LAPSE_MS, TABLE_LEASE_SETTLE_MS } = a.croupier;
    let firstDrive = -1;
    for (let t = 2_000; t <= 30_000 && firstDrive < 0; t += 100) if (turn(a, t)) firstDrive = t;
    expect(firstDrive).toBeGreaterThan(0);
    expect(firstDrive).toBeLessThanOrEqual(2_000 + TABLE_LEASE_LAPSE_MS + TABLE_LEASE_SETTLE_MS + 200);
    const beat = a.casino.readTableOperatorLease()!.beat;
    for (let t = firstDrive; t <= firstDrive + 5_000; t += 100) turn(a, t);
    expect(a.casino.readTableOperatorLease()!.beat).toBeGreaterThan(beat);
  });

  it('a lease an earlier deed holder\'s page left is taken at once', () => {
    a.casino.writeTableOperatorLease({ page: 'old-page', player: EARLIER_OWNER, beat: 9 });
    expect(turn(a, 0)).toBe(false);
    expect(a.casino.readTableOperatorLease()?.page).toBe(a.croupier.ROULETTE_PAGE_ID);
    expect(turn(a, 1_500)).toBe(true);
  });
});

/** Every spin lands on `pocket` (crypto.getRandomValues stubbed). */
function spinTo(pocket: number): void {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = pocket;
    return arr;
  });
}

const sum = (bets: readonly { amount: number }[]): number => bets.reduce((n, b) => n + b.amount, 0);

describe('a settle the computer slept through', () => {
  const bettor = 'player-Carol';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes nothing as it wakes, before its doc hears the room, and settles once it is awake', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = 2_000_000_000;
    const tick = (ms: number): void => {
      for (let left = ms; left > 0; left -= 1_000) {
        now += Math.min(left, 1_000);
        vi.setSystemTime(now);
        a.croupier.noteTablesRunning(now);
      }
    };
    vi.setSystemTime(now);
    a.casino.buyInChips(bettor, 100);
    turn(a, now);
    a.croupier.openBetting(TABLE, 1); // a Fair round: its settle hashes
    expect(a.casino.readTableState(TABLE)?.houseCommit).toBeTruthy();
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    tick(1_000);
    a.croupier.rollAndSettle(TABLE, 1);
    now += 20_000; // the computer sleeps mid-hash
    vi.setSystemTime(now);
    await flush();
    expect(a.casino.readTableState(TABLE)?.phase).toBe('closing');
    expect(a.casino.readChips(bettor)).toBe(70);
    tick(1_000); // awake: a lapse to wait out
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(a.casino.readTableState(TABLE)?.phase).toBe('closing');
    tick(a.croupier.TABLE_LEASE_LAPSE_MS);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1 });
  });
});

describe('a settle under way as the clock goes back an hour', () => {
  const bettor = 'player-Carol';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes nothing before its first frame back nor after, and settles once it has waited a lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = 2_000_000_000;
    const tick = (ms: number): void => {
      for (let left = ms; left > 0; left -= 1_000) {
        now += Math.min(left, 1_000);
        vi.setSystemTime(now);
        a.croupier.noteTablesRunning(now);
      }
    };
    vi.setSystemTime(now);
    a.casino.buyInChips(bettor, 100);
    turn(a, now);
    a.croupier.openBetting(TABLE, 1); // a Fair round: its settle hashes
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    tick(1_000);
    a.croupier.rollAndSettle(TABLE, 1);
    now -= 3_600_000; // the clock goes back an hour mid-hash
    vi.setSystemTime(now);
    await flush();
    expect(a.casino.readTableState(TABLE)?.phase).toBe('closing');
    tick(1_000); // its first frame back: a lapse to wait out
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(a.casino.readTableState(TABLE)?.phase).toBe('closing');
    expect(a.casino.readChips(bettor)).toBe(70);
    tick(a.croupier.TABLE_LEASE_LAPSE_MS);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1 });
  });
});

describe('stakes on the felt', () => {
  const bettor = 'player-Carol';

  /** Carol has 100 chips and 30 on red, page a drives, both pages synced. */
  function betAndShare(): void {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    turn(a, Date.now());
    sync(a.doc, b.doc);
    expect(turn(b, Date.now())).toBe(false); // a drives
  }

  it('a bet takes nothing: the list holds its chips, and they are back the moment it comes down', () => {
    betAndShare();
    expect(a.casino.readChips(bettor)).toBe(70);
    expect(a.casino.readChipRecords(bettor).map((r) => r.d)).toEqual([100]); // only the buy-in
    a.casino.writeMyBets(TABLE, bettor, 1, []);
    expect(a.casino.readChips(bettor)).toBe(100);
  });

  it('two tabs of one player betting at once keep one list, and hold only its chips', () => {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    sync(a.doc, b.doc);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'black', amount: 25 }]);
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      const list = page.casino.readMyBets(TABLE, bettor, 1);
      expect(list).toHaveLength(1);
      expect(page.casino.readChips(bettor)).toBe(100 - sum(list)); // (debits for both kept 65)
    }
  });

  it('a take-down at the moment the table is removed hands the chips back once', () => {
    betAndShare();
    b.casino.writeMyBets(TABLE, bettor, 1, []); // Carol's tab takes the 30 down
    a.croupier.closeTable(TABLE); // the owner removes the table, before hearing
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('two tabs taking the same bet down at once hand it back once', () => {
    betAndShare();
    a.casino.writeMyBets(TABLE, bettor, 1, []);
    b.casino.writeMyBets(TABLE, bettor, 1, []);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('a table removed on both pages before either hears of the other hands the stakes back once', () => {
    betAndShare();
    a.croupier.closeTable(TABLE);
    b.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('and once whatever bets each page had seen', () => {
    betAndShare();
    // Carol's second chip reached page b only.
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }, { type: 'black', amount: 10 }]);
    expect(b.casino.readChips(bettor)).toBe(60);
    a.croupier.closeTable(TABLE);
    b.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('sends the removal as one update, so no page sees part of it', () => {
    betAndShare();
    expect(updatesDuring(b, () => b.croupier.closeTable(TABLE))).toBe(1);
    const craps = 'craps-1';
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    expect(updatesDuring(a, () => a.craps.closeCrapsTable(craps))).toBe(1);
  });

  for (const [pocket, outcome, after] of [[1, 'win', 130], [2, 'loss', 70]] as const) {
    it(`a round settled on the driver while the other page removed the table keeps its ${outcome}, paid once`, () => {
      spinTo(pocket); // 1 is red, 2 black
      betAndShare();
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
      sync(a.doc, b.doc);
      // A plain RNG table settles at once, the round and its pay in one update.
      expect(updatesDuring(a, () => a.croupier.rollAndSettle(TABLE, 1))).toBe(1);
      expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', result: pocket });
      expect(a.casino.readChips(bettor)).toBe(after);
      b.croupier.closeTable(TABLE); // b still sees the round closing
      sync(a.doc, b.doc);
      a.croupier.closeTable(TABLE); // a hears of the removal
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(after);
    });
  }
});

describe('a list an earlier build put down (its chips taken then)', () => {
  const bettor = 'player-Carol';

  /** What a room saved by an earlier build holds: 70 chips left after 30 on red. */
  function earlierBet(): void {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.croupier.openBetting(TABLE, 1);
    a.doc.getMap('casino').set(`bal:${bettor}`, 70);
    a.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 1, bets: [{ type: 'red', amount: 30 }] });
    turn(a, Date.now());
    sync(a.doc, b.doc);
  }

  it('holds nothing more, and a win pays it in full', () => {
    spinTo(1);
    earlierBet();
    expect(a.casino.feltStake(TABLE, bettor)).toEqual({ net: 0, taken: 30 });
    expect(a.casino.readChips(bettor)).toBe(70);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    a.croupier.rollAndSettle(TABLE, 1);
    expect(a.casino.readChips(bettor)).toBe(130);
  });

  it('is refunded once when the table is removed on both pages', () => {
    earlierBet();
    a.croupier.closeTable(TABLE);
    b.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('goes on with the list when its player bets again: what it took stays counted, nothing is handed back', () => {
    earlierBet();
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }, { type: 'black', amount: 10 }]);
    expect(b.casino.feltStake(TABLE, bettor)).toEqual({ net: 10, taken: 30 });
    expect(b.casino.readChips(bettor)).toBe(60);
    b.casino.writeMyBets(TABLE, bettor, 1, []);
    expect(b.casino.readChips(bettor)).toBe(100);
    expect(b.casino.readChipRecords(bettor)).toEqual([]); // no credit written
  });

  it('two tabs taking it down at once give it back once', () => {
    earlierBet();
    a.casino.writeMyBets(TABLE, bettor, 1, []);
    b.casino.writeMyBets(TABLE, bettor, 1, []);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('a take-down at the moment the table is removed gives it back once', () => {
    earlierBet();
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'black', amount: 10 }]);
    a.croupier.closeTable(TABLE); // refunds the 30 it saw taken
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('a take-down crossing the spin: the round pays the list it settled, in full', () => {
    spinTo(1); // red
    earlierBet();
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    a.croupier.rollAndSettle(TABLE, 1);
    b.casino.writeMyBets(TABLE, bettor, 1, []); // b still saw the round open
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(130);
  });

  it('at craps too: two tabs taking it down, or one as the table goes, give it back once', () => {
    const craps = 'craps-1';
    const earlierCraps = (): void => {
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.craps.openCrapsBetting(craps, 1, null);
      a.doc.getMap('casino').set(`bal:${bettor}`, 90);
      a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'place', pick: 6, amount: 10 }] });
      sync(a.doc, b.doc);
    };
    earlierCraps();
    a.casino.writeMyCrapsBets(craps, bettor, []);
    b.casino.writeMyCrapsBets(craps, bettor, []);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });
});

describe('a craps list an earlier build put down, as the table goes', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  it('a take-down at the moment of the removal gives it back once', () => {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'place', pick: 6, amount: 10 }] });
    turn(a, Date.now());
    sync(a.doc, b.doc);
    b.casino.writeMyCrapsBets(craps, bettor, []);
    a.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  /** An earlier build put Carol's `bets` down (taking their chips) on roll
   *  `round` of a table on `point`; she has 100 chips in all. */
  function earlierCraps(round: number, point: number | null, bets: object[]): void {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, round, point);
    const taken = (bets as { amount: number }[]).reduce((n, x) => n + x.amount, 0);
    a.doc.getMap('casino').set(`bal:${bettor}`, 100 - taken);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets });
    sync(a.doc, b.doc);
  }

  /** The earlier build's page reads its own list (only `bets`) and puts down
   *  `bets`, taking the chips of what it adds. */
  function earlierRebet(bets: object[], chipsLeft: number): void {
    const map = b.doc.getMap('casino');
    expect(map.get(`bets:${craps}:${bettor}`)).toMatchObject({ kind: 'craps' });
    map.set(`bal:${bettor}`, chipsLeft);
    map.set(`bets:${craps}:${bettor}`, { kind: 'craps', bets });
    sync(a.doc, b.doc);
  }

  async function roll(d1: number, d2: number): Promise<void> {
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    diceTo(d1, d2);
    const s = a.casino.readCrapsTableState(craps)!;
    a.craps.rollAndSettleCraps(craps, s.round, s.point);
    await flush();
    sync(a.doc, b.doc);
  }

  it('a settle prunes it where it lies, and what stays up stays taken', async () => {
    const pass = { type: 'pass', amount: 10 };
    const field = { type: 'field', amount: 5 };
    earlierCraps(2, 6, [pass, field]);
    await roll(4, 4); // an 8: the field loses, the pass line rides its 6
    for (const page of [a, b]) {
      expect(page.doc.getMap('casino').get(`bets:${craps}:${bettor}`)).toMatchObject({ bets: [pass] });
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
      expect(page.casino.feltStake(craps, bettor)).toEqual({ net: 0, taken: 10 });
      expect(page.casino.readChips(bettor)).toBe(85); // the 10 on the pass line still out
    }
    // Its page adds a place bet to the list as the roll left it.
    const place6 = { type: 'place', pick: 6, amount: 10 };
    earlierRebet([pass, place6], 75);
    for (const page of [a, b]) {
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([pass, place6]);
      expect(page.casino.readChips(bettor)).toBe(75);
    }
    a.craps.closeCrapsTable(craps); // both bets come back
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(95);
  });

  it('the same bet put down again after the roll took it plays as a bet of its own', async () => {
    const pass = { type: 'pass', amount: 10 };
    earlierCraps(1, null, [pass]);
    await roll(1, 1); // craps on the come-out: the pass line loses
    for (const page of [a, b]) {
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([]);
      expect(page.casino.readChips(bettor)).toBe(90);
    }
    earlierRebet([pass], 80);
    for (const page of [a, b]) {
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
      expect(page.casino.readChips(bettor)).toBe(80);
    }
    a.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(90);
  });

  /** Page a rolls a 6 on the come-out (the pass line Carol's earlier build
   *  put down rides the point) while page b, still seeing the roll closing,
   *  removes the table; `earlierTable`: one an earlier build set up, which
   *  has no incarnation. */
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
    expect(a.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
    expect(a.casino.readChips(bettor)).toBe(90);
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
  }

  for (const [winner, clientA, clientB, earlierTable] of [
    ['the roll', 2, 1, false], ['the removal', 1, 2, false],
    ['the roll, on an earlier build\'s table', 2, 1, true], ['the removal, on an earlier build\'s table', 1, 2, true],
  ] as const) {
    it(`a roll that leaves it up, settled as the table is removed, gives it back once (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      await rolledAsRemoved(earlierTable);
      const { inc, book } = onlyBook(a, craps);
      expect(book.kept[bettor]).toMatchObject({ taken: 10 }); // what the earlier build took, kept up
      for (const page of [a, b]) {
        expect(page.casino.readCrapsTableState(craps)).toBeNull();
        expect(page.casino.readChips(bettor)).toBe(100);
      }
      a.craps.closeCrapsTable(craps); // page a hears of the removal
      sync(a.doc, b.doc);
      for (const page of [a, b]) {
        // refunded as the removal would have, against the book's record of the roll
        expect(page.doc.getMap('casinoChips').get(`end:${craps}:${inc}:${bettor}`))
          .toMatchObject({ d: 10, seen: book.recs[bettor].w });
        expect(page.casino.readChips(bettor)).toBe(100);
      }
      a.craps.closeCrapsTable(craps); // and again, as a page leaving the room does
      b.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    });
  }

  for (const [winner, clientA, clientB] of [['the roll', 2, 1], ['the removal', 1, 2]] as const) {
    it(`a roll that resolves some of it as the table is removed hands back the rest once (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      earlierCraps(2, 6, [{ type: 'pass', amount: 10 }, { type: 'field', amount: 5 }]);
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      sync(a.doc, b.doc);
      diceTo(4, 4); // an 8: the field loses, the pass line rides its 6
      a.craps.rollAndSettleCraps(craps, 2, 6);
      await flush();
      b.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      // The roll stands either way (the removal writes no book): the field's
      // 5 is lost, and the 10 the pass line kept up comes back.
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(95);
    });

    it(`a Fair roll voided as the table is removed hands it back once (${winner === 'the roll' ? 'the void' : winner} winning ties)`, async () => {
      a = await loadPage(clientB);
      b = await loadPage(clientA);
      a.craps.openCrapsBetting(craps, 1, null); // Fair: page a holds the house seed
      a.doc.getMap('casino').set(`bal:${bettor}`, 90);
      a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'pass', amount: 10 }] });
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      sync(a.doc, b.doc);
      b.craps.rollAndSettleCraps(craps, 1, null); // page b has no house seed: void
      await flush();
      expect(b.casino.readCrapsTableState(craps)?.voided).toBe(true);
      a.craps.closeCrapsTable(craps);
      sync(a.doc, b.doc);
      for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    });
  }

  it("what it owes follows the book's record, heard on its own too", async () => {
    a = await loadPage(2); // the roll wins ties
    b = await loadPage(1);
    await rolledAsRemoved();
    const { inc } = onlyBook(a, craps);
    b.casino.creditTableOutcome(craps, inc, 'end', bettor, 10); // the refund, paid
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('a page that hears of the removal late changes nothing a table put back is named by', async () => {
    a = await loadPage(2);
    b = await loadPage(1);
    await rolledAsRemoved();
    a.craps.closeCrapsTable(craps); // page a hears of it, as page b puts the table back
    for (const page of [a, b]) {
      page.casino.writeCrapsFairnessPref(craps, 'rng');
      page.craps.openCrapsBetting(craps, 1, null);
    }
    expect(a.casino.readCrapsTableState(craps)!.inc).toBe(b.casino.readCrapsTableState(craps)!.inc);
  });

  it('and through a table put back under the same id, its rolls and its removal', async () => {
    a = await loadPage(2); // the roll wins ties
    b = await loadPage(1);
    await rolledAsRemoved();
    // Page a is gone before it hears; page b puts the table back, and Carol,
    // on this build now, bets 20 on the pass line that rides a roll.
    b.casino.writeCrapsFairnessPref(craps, 'rng');
    b.craps.openCrapsBetting(craps, 1, null);
    b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 20 }]);
    expect(b.casino.readChips(bettor)).toBe(80);
    b.craps.closeCrapsBetting(craps, b.casino.readCrapsTableState(craps)!);
    diceTo(4, 4); // an 8: the point is set
    b.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    expect(b.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'pass', amount: 20 }]);
    expect(b.casino.readChips(bettor)).toBe(80);
    b.craps.closeCrapsTable(craps);
    expect(b.casino.readChips(bettor)).toBe(100);
  });
});

describe("the stickman's record of a roll against the player's own list", () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 10 };
  const place6 = { type: 'place' as const, pick: 6, amount: 10 };

  /** Carol has 100 chips, a pass line on the point of 6 and 10 on place 6,
   *  on roll 2; page a drives. */
  function onThePoint(): void {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.casino.buyInChips(bettor, 100);
    turn(a, Date.now());
    a.craps.openCrapsBetting(craps, 2, 6);
    a.casino.writeMyCrapsBets(craps, bettor, [pass, place6]);
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(80);
  }

  /** Page a settles roll 2 as a seven-out: both bets lose, nothing stays. */
  function sevenOut(): void {
    const s = a.casino.readCrapsTableState(craps)!;
    a.casino.transactCasino(() => {
      a.casino.writeSettledState(craps, { ...s, phase: 'settled', point: null });
      a.casino.creditTableOutcome(craps, s.inc!, 2, bettor, -20);
      a.casino.pruneCrapsBets(craps, bettor, 2, []);
    });
  }

  for (const [winner, clientA, clientB] of [['the stickman', 2, 1], ['the player', 1, 2]] as const) {
    it(`a take-down that crossed the dice never brings back the bets the roll resolved (${winner}'s page winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      onThePoint();
      sevenOut();
      b.casino.writeMyCrapsBets(craps, bettor, [pass]); // place 6 down, on a page yet to hear the roll
      sync(a.doc, b.doc);
      for (const page of [a, b]) {
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([]);
        expect(page.casino.readChips(bettor)).toBe(80); // the 20 lost, once; nothing held
      }
    });
  }

  it('a list written once the roll has settled plays on the next', () => {
    onThePoint();
    sevenOut();
    sync(a.doc, b.doc);
    b.casino.writeMyCrapsBets(craps, bettor, [pass]); // b has seen roll 2 settle
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
      expect(page.casino.readChips(bettor)).toBe(70);
    }
  });

  it('what a settle left up, its player takes down on the next roll', () => {
    onThePoint();
    const s = a.casino.readCrapsTableState(craps)!;
    // Roll 2 is a 4: nothing resolves, both bets stay up.
    a.casino.transactCasino(() => {
      a.casino.writeSettledState(craps, { ...s, phase: 'settled' });
      a.casino.pruneCrapsBets(craps, bettor, 2, [pass, place6]);
    });
    a.craps.openCrapsBetting(craps, 3, 6, a.casino.readCrapsTableState(craps));
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(80);
    b.casino.writeMyCrapsBets(craps, bettor, [pass]);
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
      expect(page.casino.readChips(bettor)).toBe(90);
    }
  });
});

describe('a table nobody has opened yet', () => {
  it('takes no bets, so nothing goes down that holds no chips', () => {
    const bettor = 'player-Carol';
    a.casino.buyInChips(bettor, 100);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 100 }]);
    a.casino.writeMyCrapsBets('craps-1', bettor, [{ type: 'pass', amount: 100 }]);
    expect(a.casino.readMyBets(TABLE, bettor, 1)).toEqual([]);
    expect(a.casino.readMyCrapsBets('craps-1', bettor)).toEqual([]);
    expect(a.doc.getMap('casino').has(`bets:${TABLE}:${bettor}`)).toBe(false);
    expect(a.casino.readChips(bettor)).toBe(100);
  });
});

describe('a table set up again under the same id', () => {
  const bettor = 'player-Carol';

  it('refunds roulette stakes on its round 1 though the table before it was removed at round 1 with the same bets', () => {
    a.casino.buyInChips(bettor, 100);
    for (let n = 0; n < 2; n++) {
      a.croupier.openBetting(TABLE, 1);
      a.doc.getMap('casino').set(`bal:${bettor}`, 70 - 30 * n); // an earlier build took the 30
      a.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 1, bets: [{ type: 'red', amount: 30 }] });
      a.croupier.closeTable(TABLE);
      // 100 bought, what is left of the opening, and every 30 taken comes back
      expect(a.casino.readChips(bettor)).toBe(200);
    }
  });

  it('refunds craps stakes likewise', () => {
    const table = 'craps-1';
    for (let n = 0; n < 2; n++) {
      a.craps.openCrapsBetting(table, 1, null);
      a.doc.getMap('casino').set(`bal:${bettor}`, 70 - 30 * n);
      a.doc.getMap('casino').set(`bets:${table}:${bettor}`, { kind: 'craps', bets: [{ type: 'pass', amount: 30 }] });
      a.craps.closeCrapsTable(table);
      expect(a.casino.readChips(bettor)).toBe(100);
    }
  });

  it('keeps one incarnation round to round, and takes a new one only once removed', () => {
    a.croupier.openBetting(TABLE, 1);
    const inc = a.casino.readTableState(TABLE)!.inc;
    expect(inc).toMatch(/^[a-z0-9]+$/);
    a.croupier.openBetting(TABLE, 2);
    expect(a.casino.readTableState(TABLE)!.inc).toBe(inc);
    a.croupier.closeTable(TABLE);
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.readTableState(TABLE)!.inc).not.toBe(inc);
  });
});

describe('a write at the moment the table is removed, from a page that leaves before it hears', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  /** Carol has 100 chips and 10 on the pass line; page a drives. */
  function crapsBet(): void {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(90);
  }

  it('a craps settle leaves no table behind, and holds none of its chips', () => {
    crapsBet();
    // Page a settles a roll that sets the point (the pass line stays up)
    // while page b removes the table; page a is gone before it hears.
    const s = a.casino.readCrapsTableState(craps)!;
    a.casino.transactCasino(() => {
      a.casino.writeSettledState(craps, { ...s, phase: 'settled', point: 6 });
      a.casino.pruneCrapsBets(craps, bettor, s.round, [{ type: 'pass', amount: 10 }]);
    });
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readCrapsTableState(craps)).toBeNull();
      expect(page.casino.readChips(bettor)).toBe(100);
    }
  });

  it('nor on a table an earlier build set up, which has no incarnation', () => {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, earlier);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(90);
    const s = a.casino.readCrapsTableState(craps)!;
    a.casino.transactCasino(() => {
      a.casino.writeSettledState(craps, { ...s, phase: 'settled', point: 6 });
      a.casino.pruneCrapsBets(craps, bettor, s.round, [{ type: 'pass', amount: 10 }]);
    });
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readCrapsTableState(craps)).toBeNull();
      expect(page.casino.readChips(bettor)).toBe(100);
    }
    turn(b, Date.now());
    b.craps.tickAutoStickman(craps); // put back: a table of its own
    expect(b.casino.readCrapsTableState(craps)?.inc).toMatch(/^[a-z0-9]+$/);
    expect(b.casino.readAllCrapsBets(craps)).toEqual({});
  });

  for (const [game, open] of [
    ['craps', (p: Page, round: number) => p.craps.openCrapsBetting(craps, round, null, p.casino.readCrapsTableState(craps))],
    ['roulette', (p: Page, round: number) => p.croupier.openBetting(TABLE, round)],
  ] as const) {
    it(`nor an earlier build's ${game} table given an incarnation of its own as it goes`, () => {
      const table = game === 'craps' ? craps : TABLE;
      const read = (p: Page) => (game === 'craps' ? p.casino.readCrapsTableState(craps) : p.casino.readTableState(TABLE));
      a.casino.writeCrapsFairnessPref(table, 'rng');
      a.casino.buyInChips(bettor, 100);
      open(a, 1);
      const { inc: _inc, ...earlier } = read(a)!;
      if (game === 'craps') a.casino.writeCrapsTableState(craps, earlier as never);
      else a.casino.writeTableState(TABLE, earlier as never);
      sync(a.doc, b.doc);
      // Page a opens the next round (the table takes an incarnation) and
      // Carol bets there, while page b, still on the earlier state, removes
      // the table; page a is gone before it hears.
      open(a, 2);
      expect(read(a)?.inc).toBeDefined();
      if (game === 'craps') a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
      else a.casino.writeMyBets(TABLE, bettor, 2, [{ type: 'red', amount: 10 }]);
      expect(a.casino.readChips(bettor)).toBe(90);
      if (game === 'craps') b.craps.closeCrapsTable(craps);
      else b.croupier.closeTable(TABLE);
      sync(a.doc, b.doc);
      for (const page of [a, b]) {
        expect(read(page)).toBeNull();
        expect(page.casino.readChips(bettor)).toBe(100);
      }
    });
  }

  it("nor a list put down on an earlier build's state as the table took an incarnation of its own", () => {
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, earlier);
    sync(a.doc, b.doc);
    // Page a opens the next roll (the table takes an incarnation) and then
    // removes the table, while page b, still on the earlier state, bets.
    a.craps.openCrapsBetting(craps, 2, null, a.casino.readCrapsTableState(craps));
    b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    expect(b.casino.readChips(bettor)).toBe(90);
    a.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    a.craps.openCrapsBetting(craps, 1, null); // put back under the same id
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readAllCrapsBets(craps)).toEqual({});
      expect(page.casino.readChips(bettor)).toBe(100);
    }
  });

  it('leaves nothing behind for a table of the room this page left', () => {
    // A page leaving a room reconciles the last room's tables away against
    // the new room's doc.
    expect(updatesDuring(a, () => a.croupier.closeTable('casino-roulette-elsewhere', 'elsewhere'))).toBe(0);
    expect(updatesDuring(a, () => a.craps.closeCrapsTable('casino-craps-elsewhere', 'elsewhere'))).toBe(0);
  });

  it('nor does a table put back under the same id play the bets it left', () => {
    crapsBet();
    const s = a.casino.readCrapsTableState(craps)!;
    a.casino.writeSettledState(craps, { ...s, phase: 'settled', point: 6 });
    a.casino.pruneCrapsBets(craps, bettor, s.round, [{ type: 'pass', amount: 10 }]);
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    turn(b, Date.now());
    b.craps.tickAutoStickman(craps); // the table is back, page b drives it
    const fresh = b.casino.readCrapsTableState(craps)!;
    expect(fresh).toMatchObject({ phase: 'betting', round: 1 });
    expect(fresh.inc).not.toBe(s.inc);
    expect(b.casino.readAllCrapsBets(craps)).toEqual({});
    expect(b.casino.readChips(bettor)).toBe(100);
    b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 25 }]);
    expect(b.casino.readChips(bettor)).toBe(75);
  });

  it('a roulette bet put down as the table goes holds nothing, and a table put back on round 1 starts clean', () => {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    const inc = a.casino.readTableState(TABLE)!.inc;
    sync(a.doc, b.doc);
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    a.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.readTableState(TABLE)!.inc).not.toBe(inc);
    expect(a.casino.readAllBets(TABLE, 1)).toEqual({});
    expect(a.casino.readMyBets(TABLE, bettor, 1)).toEqual([]);
    expect(a.casino.readChips(bettor)).toBe(100);
  });
});

/** The next RNG roll comes up `d1`, `d2` (crypto.getRandomValues stubbed). */
function diceTo(d1: number, d2: number): void {
  const faces = [d1, d2];
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = faces[n++ % 2] - 1;
    return arr;
  });
}

describe('a roll two pages settle at once, each from its own dice', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const place6 = { type: 'place' as const, pick: 6, amount: 10 };

  for (const [winner, clientA, clientB] of [['the roll that left it up', 2, 1], ['the seven', 1, 2]] as const) {
    it(`a place bet one leaves up and the other loses is charged once, as the winning roll says (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.craps.openCrapsBetting(craps, 2, 6);
      a.casino.writeMyCrapsBets(craps, bettor, [place6]);
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      sync(a.doc, b.doc);
      // Neither page holds the lease, so both drive (a handover in flight).
      diceTo(2, 2); // a 4: the place 6 stays up, nothing paid or taken
      a.craps.rollAndSettleCraps(craps, 2, 6);
      diceTo(3, 4); // a seven: the place 6 loses its 10
      b.craps.rollAndSettleCraps(craps, 2, 6);
      await flush();
      sync(a.doc, b.doc);
      const leftUp = clientA > clientB;
      for (const page of [a, b]) {
        expect(page.casino.readCrapsTableState(craps)?.result).toBe(leftUp ? 4 : 7);
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual(leftUp ? [place6] : []);
        expect(page.casino.readChips(bettor)).toBe(90); // held on, or lost: 10 either way, once
      }
    });
  }
});

describe('a Fair roll one page voids while another rolls it', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const field = { type: 'field' as const, amount: 5 };

  for (const [winner, clientA, clientB] of [['the void', 1, 2], ['the dice', 2, 1]] as const) {
    it(`charges or pays only as the roll the doc keeps says (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      a.casino.buyInChips(bettor, 100);
      a.craps.openCrapsBetting(craps, 1, null); // Fair: page a holds the house seed
      expect(a.casino.readCrapsTableState(craps)?.houseCommit).toBeTruthy();
      a.casino.writeMyCrapsBets(craps, bettor, [field]);
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      sync(a.doc, b.doc);
      // Neither page holds the lease (a handover in flight); page b never
      // had the house seed, so it voids the roll page a throws.
      a.craps.rollAndSettleCraps(craps, 1, null);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      expect(a.casino.readCrapsTableState(craps)?.voided).toBeUndefined();
      expect(b.casino.readCrapsTableState(craps)?.voided).toBe(true);
      sync(a.doc, b.doc);
      for (const page of [a, b]) {
        const s = page.casino.readCrapsTableState(craps)!;
        expect(s.voided === true).toBe(clientB > clientA);
        // A void leaves the field bet up; a roll resolves it either way.
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual(s.voided ? [field] : []);
        expect(page.casino.readChips(bettor)).toBe(95 + (s.payouts?.[bettor] ?? 0));
      }
    });
  }
});

/** One-way delivery. */
function deliver(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

describe('a bet taken down as betting closes, while two pages settle the round', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  function syncAll(...pages: Page[]): void {
    for (const x of pages) for (const y of pages) if (x !== y) sync(x.doc, y.doc);
  }

  for (const [winner, clientA, clientB] of [['the page that heard it', 2, 1], ['the page that paid it', 1, 2]] as const) {
    it(`roulette: pays it only as the round the doc keeps says (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      const c = await loadPage(3); // Carol's own page
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      syncAll(a, b, c);
      c.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      syncAll(a, b, c);
      c.casino.writeMyBets(TABLE, bettor, 1, []); // Carol takes it down...
      a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!); // ...as betting closes
      deliver(a.doc, b.doc); // page b hears the close, not the take-down
      deliver(c.doc, a.doc); // page a hears both
      // Neither page holds the lease (a handover in flight).
      spinTo(1); // red
      a.croupier.rollAndSettle(TABLE, 1);
      b.croupier.rollAndSettle(TABLE, 1);
      await flush();
      syncAll(a, b, c);
      for (const page of [a, b, c]) {
        const s = page.casino.readTableState(TABLE)!;
        expect(s.phase).toBe('settled');
        expect(page.casino.readChips(bettor)).toBe(s.payouts?.[bettor] ? 110 : 100);
      }
    });

    it(`craps: pays it only as the roll the doc keeps says (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      const c = await loadPage(3);
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.craps.openCrapsBetting(craps, 1, null);
      syncAll(a, b, c);
      c.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
      syncAll(a, b, c);
      c.casino.writeMyCrapsBets(craps, bettor, []);
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      deliver(a.doc, b.doc);
      deliver(c.doc, a.doc);
      diceTo(3, 4); // a seven on the come-out: the pass line wins
      a.craps.rollAndSettleCraps(craps, 1, null);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      syncAll(a, b, c);
      for (const page of [a, b, c]) {
        const s = page.casino.readCrapsTableState(craps)!;
        expect(s.phase).toBe('settled');
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([]);
        expect(page.casino.readChips(bettor)).toBe(s.payouts?.[bettor] ? 110 : 100);
      }
    });
  }
});

/** Each draw in turn from `values` (page a's, then page b's): a pocket
 *  as it is, a die face from 1. */
function drawsTo(dice: boolean, ...values: number[]): void {
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = values[n++ % values.length] - (dice ? 1 : 0);
    return arr;
  });
}

describe('a first bet put down as betting closes, that one settling page never hears', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  function syncAll(...pages: Page[]): void {
    for (const x of pages) for (const y of pages) if (x !== y) sync(x.doc, y.doc);
  }

  for (const [winner, clientA, clientB] of [['the page that never heard it', 1, 2], ['the page that heard it', 2, 1]] as const) {
    for (const [aPocket, bPocket] of [[2, 1], [1, 2]]) {
      it(`RNG roulette: sits the round out (${winner} winning ties, pockets ${aPocket} and ${bPocket})`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        const c = await loadPage(3); // Carol's own page
        a.casino.writeCrapsFairnessPref(TABLE, 'rng');
        a.casino.buyInChips(bettor, 100);
        a.croupier.openBetting(TABLE, 1);
        syncAll(a, b, c);
        c.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]); // Carol's first bet...
        a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!); // ...as betting closes
        deliver(a.doc, b.doc); // page b hears the close, not the bet
        deliver(c.doc, a.doc); // page a hears the bet just after its close
        // Neither page holds the lease (a handover in flight).
        drawsTo(false, aPocket, bPocket);
        a.croupier.rollAndSettle(TABLE, 1);
        b.croupier.rollAndSettle(TABLE, 1);
        await flush();
        syncAll(a, b, c);
        for (const page of [a, b, c]) {
          const s = page.casino.readTableState(TABLE)!;
          expect(s).toMatchObject({ phase: 'settled', result: clientA > clientB ? aPocket : bPocket });
          expect(s.payouts?.[bettor]).toBeUndefined();
          expect(page.casino.readChips(bettor)).toBe(100);
        }
      });
    }

    it(`RNG craps: rides on, out of the roll (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      const c = await loadPage(3);
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.craps.openCrapsBetting(craps, 1, null);
      syncAll(a, b, c);
      c.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      deliver(a.doc, b.doc); // b hears the close, not the bet
      deliver(c.doc, a.doc); // a hears the bet after its close
      drawsTo(true, 3, 4, 3, 3); // page a rolls a seven, page b a six
      a.craps.rollAndSettleCraps(craps, 1, null);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      syncAll(a, b, c);
      for (const page of [a, b, c]) {
        const s = page.casino.readCrapsTableState(craps)!;
        expect(s).toMatchObject({ phase: 'settled', dice: clientA > clientB ? [3, 4] : [3, 3] });
        expect(s.payouts?.[bettor]).toBeUndefined();
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'pass', amount: 10 }]);
        expect(page.casino.readChips(bettor)).toBe(90);
      }
    });
  }

  for (const [winner, clientA, clientB] of [['the page that never heard it', 1, 2], ['the page that heard it', 2, 1]] as const) {
    /** Page a's own updates while `act` runs, for b to hear without what a heard from others. */
    function ownUpdates(page: Page, act: () => void): Uint8Array[] {
      const out: Uint8Array[] = [];
      const keep = (u: Uint8Array): void => { out.push(u); };
      page.doc.on('update', keep);
      act();
      page.doc.off('update', keep);
      return out;
    }

    it(`RNG roulette, a bettor the close names that one settling page has no list for (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      const c = await loadPage(3);
      a.casino.writeCrapsFairnessPref(TABLE, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.croupier.openBetting(TABLE, 1);
      syncAll(a, b, c);
      c.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      deliver(c.doc, a.doc);
      const close = ownUpdates(a, () => a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!));
      expect(a.casino.readTableState(TABLE)?.bettors).toEqual([bettor]);
      for (const u of close) Y.applyUpdate(b.doc, u); // b hears the close naming Carol, not her list
      drawsTo(false, 1, 2); // page a spins red, page b black
      a.croupier.rollAndSettle(TABLE, 1);
      b.croupier.rollAndSettle(TABLE, 1);
      await flush();
      syncAll(a, b, c);
      for (const page of [a, b, c]) {
        const s = page.casino.readTableState(TABLE)!;
        // a's red paid her 20; b's round never had her bet, and hands it back.
        expect({ result: s.result, chips: page.casino.readChips(bettor) })
          .toEqual(clientA > clientB ? { result: 1, chips: 110 } : { result: 2, chips: 100 });
      }
    });

    it(`RNG craps, a bettor the close names that one settling page has no list for (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      const c = await loadPage(3);
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.casino.buyInChips(bettor, 100);
      a.craps.openCrapsBetting(craps, 1, null);
      syncAll(a, b, c);
      c.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
      deliver(c.doc, a.doc);
      const close = ownUpdates(a, () => a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!));
      for (const u of close) Y.applyUpdate(b.doc, u);
      drawsTo(true, 3, 4, 3, 3); // page a rolls a seven, page b a six
      a.craps.rollAndSettleCraps(craps, 1, null);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      syncAll(a, b, c);
      for (const page of [a, b, c]) {
        const s = page.casino.readCrapsTableState(craps)!;
        const worth = page.casino.readChips(bettor) + sum(page.casino.readMyCrapsBets(craps, bettor));
        // a's seven paid her pass line; b's roll never had it, and hands it back.
        expect({ dice: s.dice, worth }).toEqual(clientA > clientB ? { dice: [3, 4], worth: 110 } : { dice: [3, 3], worth: 100 });
      }
    });
  }
});

describe('a bet taken down as betting closes, while two pages close and settle the roll', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  for (const [winner, clientA, clientB] of [['the dice', 2, 1], ['the void', 1, 2]] as const) {
    it(`Fair craps, one page voiding as it closes: pays it only as the roll the doc keeps says (${winner} winning ties)`, async () => {
      a = await loadPage(clientA);
      b = await loadPage(clientB);
      const c = await loadPage(3); // Carol's own page
      a.casino.buyInChips(bettor, 100);
      diceTo(3, 4); // the house seed (the Fair dice come of it): a roll that resolves the pass line
      a.craps.openCrapsBetting(craps, 1, null); // Fair: page a holds the house seed
      for (const x of [b, c]) sync(a.doc, x.doc);
      c.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
      for (const x of [a, b]) sync(c.doc, x.doc);
      c.casino.writeMyCrapsBets(craps, bettor, []); // Carol takes it down
      deliver(c.doc, b.doc); // page b hears it, page a doesn't
      // Both close at once: a freezes Carol's pass; b, without the house
      // seed, voids the roll at the stickman's beat, still apart from a.
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      b.craps.closeCrapsBetting(craps, b.casino.readCrapsTableState(craps)!);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      expect(b.casino.readCrapsTableState(craps)?.voided).toBe(true);
      a.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      expect(a.casino.readMyCrapsBets(craps, bettor)).toEqual([]); // resolved there, won or lost
      for (const x of [a, b, c]) for (const y of [a, b, c]) if (x !== y) sync(x.doc, y.doc);
      for (const page of [a, b, c]) {
        const s = page.casino.readCrapsTableState(craps)!;
        expect(s.voided === true).toBe(clientB > clientA);
        // The void hands the 10 back; the dice paid or took it.
        expect(page.casino.readChips(bettor)).toBe(s.voided ? 100 : 90 + (s.payouts?.[bettor] ?? 0));
      }
    });
  }

  it("an earlier build's take-down: is paid only as the roll the doc keeps says (the page that heard it winning ties)", async () => {
    a = await loadPage(2);
    b = await loadPage(1);
    const c = await loadPage(3); // Carol's earlier-build page
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    for (const x of [b, c]) sync(a.doc, x.doc);
    c.doc.getMap('casino').set(`bal:${bettor}`, 90); // its pass line takes 10
    c.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'pass', amount: 10 }] });
    for (const x of [a, b]) sync(c.doc, x.doc);
    c.doc.getMap('casino').set(`bal:${bettor}`, 100); // and its take-down hands it back
    c.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    deliver(a.doc, b.doc);
    deliver(c.doc, a.doc);
    diceTo(3, 4);
    a.craps.rollAndSettleCraps(craps, 1, null);
    b.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    for (const x of [a, b, c]) for (const y of [a, b, c]) if (x !== y) sync(x.doc, y.doc);
    for (const page of [a, b, c]) {
      expect(page.casino.readCrapsTableState(craps)?.payouts?.[bettor]).toBeUndefined();
      expect(page.casino.readChips(bettor)).toBe(100);
    }
  });
});

describe('two house members pressing ROLL at once', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const T = 2_000_000_000;

  function syncAll(...pages: Page[]): void {
    for (const x of pages) for (const y of pages) if (x !== y) sync(x.doc, y.doc);
  }

  for (const fair of [true, false]) {
    for (const [winner, clientA, clientB] of [['a', 2, 1], ['b', 1, 2]] as const) {
      it(`${fair ? 'Fair' : 'RNG'}: one page settles, the one whose close the doc keeps (${winner} winning ties), a first bet only one of them heard too`, async () => {
        a = await loadPage(clientA);
        b = await loadPage(clientB);
        const c = await loadPage(3); // Carol's own page
        a.casino.buyInChips(bettor, 100);
        if (!fair) a.casino.writeCrapsFairnessPref(craps, 'rng');
        diceTo(6, 6);
        expect(a.craps.pressManualRoll(craps, T)).toMatch(/BETS OPEN/); // a holds the house seed
        for (const x of [b, c]) sync(a.doc, x.doc);
        c.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
        deliver(c.doc, a.doc); // a hears it, b not yet
        // Both press ROLL at once, and again for the stickman to throw.
        for (const now of [T + 100, T + 200]) {
          expect(a.craps.pressManualRoll(craps, now)).toBeNull();
          expect(b.craps.pressManualRoll(craps, now)).toBeNull();
        }
        for (const page of [a, b]) page.craps.tickManualCraps(craps, T + 1_000);
        await flush();
        // Nothing settles, and no dice fly, before the two closes have met.
        for (const page of [a, b]) {
          expect(page.casino.readCrapsTableState(craps)?.phase).toBe('closing');
          expect(page.casino.readDiceThrow(craps)).toBeNull();
        }
        syncAll(a, b, c);
        for (const page of [a, b]) page.craps.tickManualCraps(craps, T + 1_600);
        await flush();
        syncAll(a, b, c);
        const keptA = clientA > clientB;
        for (const page of [a, b, c]) {
          const s = page.casino.readCrapsTableState(craps)!;
          expect(s.phase).toBe('settled');
          // b, without the house seed, voids a Fair roll.
          expect(s.voided === true).toBe(fair && !keptA);
          const felt = sum(page.casino.readMyCrapsBets(craps, bettor));
          // a's close froze Carol's pass, and its roll paid, took or kept
          // it; b's never saw it, so it rides on.
          expect(page.casino.readChips(bettor) + felt).toBe(keptA ? 90 + (s.payouts?.[bettor] ?? 0) + felt : 100);
          expect(felt).toBe(keptA ? felt : 10);
        }
      });
    }
  }
});

describe('a list taken all down, at the rounds after', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  /** The round of Carol's last outcome on the table (its book's record of her). */
  function lastOutcomeRound(page: Page, table: string): string | undefined {
    const r = onlyBook(page, table).book.recs[bettor]?.r;
    return r === undefined ? undefined : String(r);
  }

  it('roulette: is written up for its own round, and not for the next', async () => {
    a = await loadPage();
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    a.casino.writeMyBets(TABLE, bettor, 1, []);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(lastOutcomeRound(a, TABLE)).toBe('1');
    a.croupier.openBetting(TABLE, 2);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    a.croupier.rollAndSettle(TABLE, 2);
    await flush();
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 2 });
    expect(lastOutcomeRound(a, TABLE)).toBe('1');
  });

  it('craps: is written up for its own roll, and not for the next', async () => {
    a = await loadPage();
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    a.casino.writeMyCrapsBets(craps, bettor, []);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    expect(lastOutcomeRound(a, craps)).toBe('1');
    a.craps.openCrapsBetting(craps, 2, 6);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    diceTo(2, 2);
    a.craps.rollAndSettleCraps(craps, 2, 6);
    await flush();
    expect(a.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', round: 2 });
    expect(lastOutcomeRound(a, craps)).toBe('1');
    expect(a.casino.readChips(bettor)).toBe(100);
  });

  it("craps: an earlier build's list the stickman pruned to nothing is not written up again", async () => {
    a = await loadPage();
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'pass', amount: 10 }] });
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    diceTo(3, 4); // a seven: the pass line wins, and its list is pruned to nothing
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    expect(a.doc.getMap('casino').get(`bets:${craps}:${bettor}`)).toMatchObject({ bets: [], pruned: 1 });
    expect(lastOutcomeRound(a, craps)).toBe('1');
    a.craps.openCrapsBetting(craps, 2, null);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    diceTo(3, 3);
    a.craps.rollAndSettleCraps(craps, 2, null);
    await flush();
    expect(a.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', round: 2 });
    expect(lastOutcomeRound(a, craps)).toBe('1');
    expect(a.casino.readChips(bettor)).toBe(110);
  });
});

describe('a table two pages open at once, before either hears of the other', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  /** Carol has 100 chips; neither page has seen the table opened. */
  function fresh(table: string): void {
    a.casino.writeCrapsFairnessPref(table, 'rng');
    a.casino.buyInChips(bettor, 100);
    sync(a.doc, b.doc);
  }

  it('names it alike on both, so a round both settle pays once', () => {
    spinTo(1); // red
    fresh(TABLE);
    for (const page of [a, b]) {
      page.croupier.openBetting(TABLE, 1);
      page.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
      page.croupier.closeBetting(TABLE, page.casino.readTableState(TABLE)!);
      page.croupier.rollAndSettle(TABLE, 1);
    }
    expect(a.casino.readTableState(TABLE)!.inc).toBe(b.casino.readTableState(TABLE)!.inc);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(130);
  });

  it('at craps too', async () => {
    const pass = { type: 'pass' as const, amount: 10 };
    fresh(craps);
    for (const page of [a, b]) {
      page.craps.openCrapsBetting(craps, 1, null);
      page.casino.writeMyCrapsBets(craps, bettor, [pass]);
      page.craps.closeCrapsBetting(craps, page.casino.readCrapsTableState(craps)!);
      diceTo(3, 4); // a seven on the come-out: the pass line wins
      page.craps.rollAndSettleCraps(craps, 1, null);
    }
    await flush();
    expect(a.casino.readCrapsTableState(craps)!.inc).toBe(b.casino.readCrapsTableState(craps)!.inc);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(110);
  });

  it("and an earlier build's table both give an incarnation at once takes the same one", () => {
    fresh(craps);
    a.craps.openCrapsBetting(craps, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, earlier);
    sync(a.doc, b.doc);
    for (const page of [a, b]) page.craps.openCrapsBetting(craps, 2, null, page.casino.readCrapsTableState(craps));
    expect(a.casino.readCrapsTableState(craps)!.inc).toBeDefined();
    expect(a.casino.readCrapsTableState(craps)!.inc).toBe(b.casino.readCrapsTableState(craps)!.inc);
  });

  it('and a table put back after a removal is named anew each time', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 3; n++) {
      a.croupier.openBetting(TABLE, 1);
      seen.add(a.casino.readTableState(TABLE)!.inc!);
      a.croupier.closeTable(TABLE);
    }
    expect(seen.size).toBe(3);
  });

  it("even when an earlier build had rewritten its state without one before it went", () => {
    a.croupier.openBetting(TABLE, 1);
    a.croupier.closeTable(TABLE);
    a.croupier.openBetting(TABLE, 1);
    const second = a.casino.readTableState(TABLE)!;
    const { inc: _inc, ...earlier } = second;
    a.casino.writeTableState(TABLE, earlier); // an earlier build's next round
    a.croupier.closeTable(TABLE, 'local'); // page a removes it
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.readTableState(TABLE)!.inc).not.toBe(second.inc);
  });
});

describe("an earlier build's list its player took all the way down", () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  /** An earlier build took 30 of Carol's 100 for red; her tab on this build
   *  takes the bet down, so her 100 are back. */
  function takenDown(): void {
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.croupier.openBetting(TABLE, 1);
    a.doc.getMap('casino').set(`bal:${bettor}`, 70);
    a.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 1, bets: [{ type: 'red', amount: 30 }] });
    sync(a.doc, b.doc);
    b.casino.writeMyBets(TABLE, bettor, 1, []);
    sync(a.doc, b.doc);
    expect(a.casino.feltStake(TABLE, bettor)).toEqual({ net: -30, taken: 30 });
    expect(a.casino.readChips(bettor)).toBe(100);
  }

  it('keeps its chips through the round it was taken down from', () => {
    spinTo(1);
    takenDown();
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    a.croupier.rollAndSettle(TABLE, 1);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });

  it('keeps them as the table is removed in a room with no robot croupier', () => {
    takenDown();
    // Another player's earlier-build bet still stands: it comes back too.
    a.doc.getMap('casino').set('bal:player-Dave', 50);
    a.doc.getMap('casino').set(`bets:${TABLE}:player-Dave`, { round: 1, bets: [{ type: 'black', amount: 20 }] });
    a.croupier.setSoleCroupierPredicate(() => false);
    a.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readChips(bettor)).toBe(100);
      expect(page.casino.readChips('player-Dave')).toBe(70);
    }
  });

  it('at craps too: through a roll, and the removal in a room with no robot', async () => {
    spinTo(0); // the dice come up 1 and 1
    a.casino.writeCrapsFairnessPref(craps, 'rng');
    a.craps.openCrapsBetting(craps, 1, null);
    a.doc.getMap('casino').set(`bal:${bettor}`, 90);
    a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [{ type: 'place', pick: 6, amount: 10 }] });
    sync(a.doc, b.doc);
    b.casino.writeMyCrapsBets(craps, bettor, []);
    sync(a.doc, b.doc);
    expect(a.casino.readChips(bettor)).toBe(100);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    sync(a.doc, b.doc);
    expect(a.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', result: 2 });
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
    b.croupier.setSoleCroupierPredicate(() => false);
    b.craps.closeCrapsTable(craps);
    sync(a.doc, b.doc);
    for (const page of [a, b]) expect(page.casino.readChips(bettor)).toBe(100);
  });
});

describe('bets the chip ledger could not pay', () => {
  it('a bet past the largest stake, or a list past the most records, reads as no bets', () => {
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, 'player-huge', 1, [{ type: 'red', amount: 2 ** 52 }]);
    a.casino.writeMyBets(TABLE, 'player-long', 1, Array.from({ length: 1001 }, () => ({ type: 'red' as const, amount: 1 })));
    a.casino.writeMyBets(TABLE, 'player-full', 1, Array.from({ length: 1000 }, () => ({ type: 'red' as const, amount: 1000 })));
    expect(Object.keys(a.casino.readAllBets(TABLE, 1))).toEqual(['player-full']);
    const craps = 'craps-1';
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, 'player-huge', [{ type: 'pass', amount: 2 ** 52 }]);
    a.casino.writeMyCrapsBets(craps, 'player-long', Array.from({ length: 1001 }, () => ({ type: 'pass' as const, amount: 1 })));
    a.casino.writeMyCrapsBets(craps, 'player-full', [{ type: 'pass', amount: 1000 }]);
    expect(Object.keys(a.casino.readAllCrapsBets(craps))).toEqual(['player-full']);
  });
});

describe('a manual craps roll held by the owner\'s page that is not driving', () => {
  const table = 'craps-1';
  let now = 2_000_000_000;
  /** Time passes, both pages running their tables every second of it. */
  const later = (ms: number): void => {
    for (let left = ms; left > 0; left -= 1_000) {
      now += Math.min(left, 1_000);
      vi.setSystemTime(now);
      for (const page of [a, b]) page.croupier.noteTablesRunning(now);
    }
    vi.setSystemTime(now);
  };

  /** Page a drives; page b pressed THROW THE DICE before the robot's first
   *  beat, so b holds this roll. */
  function heldByB(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    later(0);
    a.casino.writeCrapsFairnessPref(table, 'rng');
    turn(a, now);
    sync(a.doc, b.doc);
    b.craps.openCrapsBetting(table, 1, null);
    const s = b.casino.readCrapsTableState(table)!;
    b.casino.writeCrapsTableState(table, { ...s, phase: 'closing', operator: b.backend.CRAPS_PAGE_ID, phaseDeadline: now });
    sync(a.doc, b.doc);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is rolled there with the robot\'s show beat, and the robot opens the next roll', async () => {
    heldByB();
    later(100);
    a.craps.tickAutoStickman(table); // the robot leaves b's roll alone
    expect(a.casino.readDiceThrow(table)).toBeNull();
    b.craps.tickManualCraps(table, now, b.craps.CRAPS_SHOW_MS);
    await flush();
    sync(a.doc, b.doc);
    const settled = a.casino.readCrapsTableState(table)!;
    expect(settled).toMatchObject({ phase: 'settled', round: 1 });
    expect(settled.phaseDeadline).toBe(now + a.craps.CRAPS_SHOW_MS);
    later(a.craps.CRAPS_SHOW_MS);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)).toMatchObject({ phase: 'betting', round: 2 });
  });

  it('is not rolled on that page while it wakes from a sleep, and is once it is awake', async () => {
    heldByB();
    later(1_000);
    now += 20_000; // page b sleeps through it
    vi.setSystemTime(now);
    b.croupier.noteTablesRunning(now); // its first frame awake
    b.craps.tickManualCraps(table, now);
    await flush();
    expect(b.casino.readCrapsTableState(table)?.phase).toBe('closing');
    expect(b.casino.readDiceThrow(table)).toBeNull(); // no dice thrown on that doc
    later(b.croupier.TABLE_LEASE_LAPSE_MS);
    b.craps.tickManualCraps(table, now);
    await flush();
    expect(b.casino.readCrapsTableState(table)).toMatchObject({ phase: 'settled', round: 1 });
  });

  it('is not taken over by a ROLL pressed as a page wakes, and the time asleep is not time spent watching it', () => {
    heldByB();
    a.craps.tickManualCraps(table, now); // page a starts watching b's roll
    later(1_000);
    now += a.craps.MANUAL_TAKEOVER_MS + 10_000; // page a sleeps longer than a takeover takes
    vi.setSystemTime(now);
    b.croupier.noteTablesRunning(now);
    a.croupier.noteTablesRunning(now); // its first frame awake, on a doc that may be behind
    const writes = updatesDuring(a, () => {
      expect(a.craps.pressManualRoll(table, now)).toBe(a.croupier.RECONNECTING_NOTICE);
    });
    expect(writes).toBe(0);
    later(a.croupier.TABLE_LEASE_LAPSE_MS);
    a.craps.tickManualCraps(table, now);
    expect(a.craps.pressManualRoll(table, now)).toMatch(/ANOTHER HOUSE MEMBER/);
    later(a.craps.MANUAL_TAKEOVER_MS - 1_000);
    expect(a.craps.pressManualRoll(table, now)).toMatch(/ANOTHER HOUSE MEMBER/);
    later(1_000);
    expect(a.craps.pressManualRoll(table, now)).toBeNull();
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(a.backend.CRAPS_PAGE_ID);
  });

  it('nor by the robot of a page that slept: its watch starts again', () => {
    heldByB();
    a.craps.tickAutoStickman(table); // the robot starts watching b's roll
    later(1_000);
    now += a.craps.MANUAL_TAKEOVER_MS + 10_000;
    vi.setSystemTime(now);
    later(a.croupier.TABLE_LEASE_LAPSE_MS + 1_000); // awake again
    expect(turn(a, now)).toBe(true);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(b.backend.CRAPS_PAGE_ID);
    later(a.craps.MANUAL_TAKEOVER_MS);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(a.backend.CRAPS_PAGE_ID);
  });

  it('on a table put back under the same id, waits out its own full time', () => {
    heldByB();
    a.craps.tickAutoStickman(table); // the robot starts watching b's roll
    later(a.craps.MANUAL_TAKEOVER_MS - 5_000);
    b.craps.closeCrapsTable(table); // removed, set up again, and rolled by b
    b.craps.openCrapsBetting(table, 1, null);
    const s = b.casino.readCrapsTableState(table)!;
    b.casino.writeCrapsTableState(table, { ...s, phase: 'closing', operator: b.backend.CRAPS_PAGE_ID, phaseDeadline: now });
    sync(a.doc, b.doc);
    later(5_100);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(b.backend.CRAPS_PAGE_ID);
    later(a.craps.MANUAL_TAKEOVER_MS);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(a.backend.CRAPS_PAGE_ID);
  });

  it('is taken over by the robot once the page holding it has gone quiet', async () => {
    heldByB();
    a.craps.tickAutoStickman(table);
    later(a.craps.MANUAL_TAKEOVER_MS - 100);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(b.backend.CRAPS_PAGE_ID);
    later(200);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)?.operator).toBe(a.backend.CRAPS_PAGE_ID);
    a.craps.tickAutoStickman(table);
    await flush();
    expect(a.casino.readCrapsTableState(table)).toMatchObject({ phase: 'settled', round: 1 });
  });
});

describe('a SPIN pressed on the owner\'s page that is not driving', () => {
  let now = 2_000_000_000;
  /** Time passes, both pages running their tables every second of it. */
  const later = (ms: number): void => {
    for (let left = ms; left > 0; left -= 1_000) {
      now += Math.min(left, 1_000);
      vi.setSystemTime(now);
      for (const page of [a, b]) page.croupier.noteTablesRunning(now);
    }
    vi.setSystemTime(now);
  };

  /** Page a drives; page b pressed SPIN before the robot's first beat, so b
   *  holds this round. */
  function spunByB(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    later(0);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    turn(a, now);
    sync(a.doc, b.doc);
    b.croupier.openBetting(TABLE, 1);
    b.croupier.closeBetting(TABLE, b.casino.readTableState(TABLE)!, undefined, b.croupier.ROULETTE_PAGE_ID);
    sync(a.doc, b.doc);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is settled there, and the robot gives it the show beat and opens the next round', async () => {
    spunByB();
    later(100);
    a.croupier.tickAutoCroupier(TABLE); // the robot leaves b's round alone
    await flush();
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'closing', operator: b.croupier.ROULETTE_PAGE_ID });
    b.croupier.rollAndSettle(TABLE, 1); // the SPIN's settle: no show beat of its own
    await flush();
    sync(a.doc, b.doc);
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1 });
    expect(a.casino.readTableState(TABLE)!.phaseDeadline).toBeUndefined();
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)!.phaseDeadline).toBe(now + a.croupier.SHOW_MS);
    later(a.croupier.SHOW_MS);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 2 });
  });

  it('on a table put back under the same id, waits out its own full time', () => {
    spunByB();
    a.croupier.tickAutoCroupier(TABLE); // the robot starts watching b's SPIN
    later(a.croupier.SPIN_TAKEOVER_MS - 5_000);
    b.croupier.closeTable(TABLE); // removed, set up again, and spun by b
    b.croupier.openBetting(TABLE, 1);
    b.croupier.closeBetting(TABLE, b.casino.readTableState(TABLE)!, undefined, b.croupier.ROULETTE_PAGE_ID);
    sync(a.doc, b.doc);
    later(5_100);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(b.croupier.ROULETTE_PAGE_ID);
    later(a.croupier.SPIN_TAKEOVER_MS);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(a.croupier.ROULETTE_PAGE_ID);
  });

  it('is not taken over by the robot of a page that slept until it has watched it its full time awake', () => {
    spunByB();
    a.croupier.tickAutoCroupier(TABLE); // the robot starts watching b's SPIN
    later(1_000);
    now += a.croupier.SPIN_TAKEOVER_MS + 10_000;
    vi.setSystemTime(now);
    later(a.croupier.TABLE_LEASE_LAPSE_MS + 1_000); // awake again
    expect(turn(a, now)).toBe(true);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(b.croupier.ROULETTE_PAGE_ID);
    later(a.croupier.SPIN_TAKEOVER_MS);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(a.croupier.ROULETTE_PAGE_ID);
  });

  it("is taken over by the robot a full watch after this page's clock went back, not an hour", () => {
    spunByB();
    a.croupier.tickAutoCroupier(TABLE); // the robot starts watching b's SPIN
    now -= 3_600_000; // the clock goes back an hour, before the page's next frame
    vi.setSystemTime(now);
    a.croupier.tickAutoCroupier(TABLE);
    now += a.croupier.SPIN_TAKEOVER_MS - 100;
    vi.setSystemTime(now);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(b.croupier.ROULETTE_PAGE_ID);
    now += 200;
    vi.setSystemTime(now);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(a.croupier.ROULETTE_PAGE_ID);
  });

  it('is taken over by the robot once the page that spun it has gone quiet', async () => {
    spunByB();
    a.croupier.tickAutoCroupier(TABLE);
    later(a.croupier.SPIN_TAKEOVER_MS - 100);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(b.croupier.ROULETTE_PAGE_ID);
    later(200);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)?.operator).toBe(a.croupier.ROULETTE_PAGE_ID);
    a.croupier.tickAutoCroupier(TABLE);
    await flush();
    expect(a.casino.readTableState(TABLE)).toMatchObject({
      phase: 'settled', round: 1, phaseDeadline: now + a.croupier.SHOW_MS,
    });
  });
});

describe('a driver whose clock runs an hour behind the page before it', () => {
  const aNow = 2_000_000_000;
  const bNow = aNow - 3_600_000;
  const bettor = 'player-Carol';

  /** Page a has gone; page b takes the tables over. b's clock when it drives. */
  function bTakesOver(): number {
    sync(a.doc, b.doc);
    let t = bNow;
    while (!turn(b, t)) t += 100;
    vi.setSystemTime(t);
    return t;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(aNow);
    turn(a, aNow);
    a.casino.buyInChips(bettor, 100);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a roulette window it inherits for the window\'s length on its own clock, not an hour', () => {
    const { BET_WINDOW_MS, CLOSING_MS } = a.croupier;
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    a.croupier.tickAutoCroupier(TABLE);
    expect(a.casino.readTableState(TABLE)!.phaseDeadline).toBe(aNow + BET_WINDOW_MS);
    const t = bTakesOver();
    b.croupier.tickAutoCroupier(TABLE);
    expect(b.casino.readTableState(TABLE)!.phaseDeadline).toBe(t + BET_WINDOW_MS);
    vi.setSystemTime(t + BET_WINDOW_MS);
    b.croupier.tickAutoCroupier(TABLE);
    expect(b.casino.readTableState(TABLE)).toMatchObject({
      phase: 'closing', phaseDeadline: t + BET_WINDOW_MS + CLOSING_MS,
    });
  });

  it('and a result it inherits for the show beat, then opens the next round', () => {
    const { SHOW_MS } = a.croupier;
    a.casino.writeTableState(TABLE, {
      kind: 'roulette', phase: 'settled', round: 4, result: 7, resultAt: aNow, payouts: {},
      phaseDeadline: aNow + SHOW_MS, inc: 'inc1',
    });
    const t = bTakesOver();
    b.croupier.tickAutoCroupier(TABLE);
    expect(b.casino.readTableState(TABLE)!.phaseDeadline).toBe(t + SHOW_MS);
    // (World's frames run meanwhile: a page that ran none for a lapse would
    // wait out a wake before it opens a round.)
    for (let ms = 100; ms <= SHOW_MS; ms += 100) b.croupier.noteTablesRunning(t + ms);
    vi.setSystemTime(t + SHOW_MS);
    b.croupier.tickAutoCroupier(TABLE);
    expect(b.casino.readTableState(TABLE)).toMatchObject({ phase: 'betting', round: 5 });
  });

  it('and a craps window likewise', () => {
    const table = 'craps-1';
    const { CRAPS_BET_WINDOW_MS } = a.craps;
    a.casino.writeCrapsFairnessPref(table, 'rng');
    a.craps.openCrapsBetting(table, 1, null);
    a.casino.writeMyCrapsBets(table, bettor, [{ type: 'pass', amount: 10 }]);
    a.craps.tickAutoStickman(table);
    expect(a.casino.readCrapsTableState(table)!.phaseDeadline).toBe(aNow + CRAPS_BET_WINDOW_MS);
    const t = bTakesOver();
    b.craps.tickAutoStickman(table);
    expect(b.casino.readCrapsTableState(table)!.phaseDeadline).toBe(t + CRAPS_BET_WINDOW_MS);
    vi.setSystemTime(t + CRAPS_BET_WINDOW_MS);
    b.craps.tickAutoStickman(table);
    expect(b.casino.readCrapsTableState(table)?.phase).toBe('closing');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an earlier build's craps list its player's tab rewrites as two pages settle the roll", () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const pass = { type: 'pass' as const, amount: 30 };
  // Each page's Yjs client id: the order decides which page's write wins each key.
  const orders = [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]] as const;

  for (const [tab, unheard, heard] of orders) {
    it(`plays as the settle the doc keeps says (client ids: tab ${tab}, pages ${unheard} and ${heard})`, async () => {
      const p = await loadPage(tab);
      b = await loadPage(unheard);
      a = await loadPage(heard);
      const all = [a, b, p];
      const syncAll = (): void => {
        for (let i = 0; i < 2; i++) for (const x of all) for (const y of all) if (x !== y) sync(x.doc, y.doc);
      };
      // An earlier build took Carol's 30 for the pass line (100 in all).
      a.casino.writeCrapsFairnessPref(craps, 'rng');
      a.craps.openCrapsBetting(craps, 1, null);
      a.doc.getMap('casino').set(`bal:${bettor}`, 70);
      a.doc.getMap('casino').set(`bets:${craps}:${bettor}`, { kind: 'craps', bets: [pass] });
      a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
      syncAll();
      // Her tab on this build rewrites the list, what it took going on with
      // it; page a hears, page b doesn't, and both settle the roll (a lease
      // handover in flight).
      p.casino.writeMyCrapsBets(craps, bettor, [pass]);
      sync(p.doc, a.doc);
      diceTo(3, 3); // a 6 on the come-out: the pass line rides the point
      a.craps.rollAndSettleCraps(craps, 1, null);
      b.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      syncAll();
      for (const page of all) {
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([pass]);
        expect(page.casino.readChips(bettor)).toBe(70);
      }
      a.craps.closeCrapsTable(craps);
      syncAll();
      for (const page of all) expect(page.casino.readChips(bettor)).toBe(100);
    });
  }
});

describe('a Fair table removed and put back under the same id, heard all at once', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';

  it("craps: the new table's round 1 goes by its own close, not the old table's", async () => {
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null); // Fair: page a holds the house seed
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 30 }]);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!); // a freezes the 30
    sync(a.doc, b.doc);
    // Page b removes the table and puts it back; Carol bets 10 there, and
    // page b closes its first roll.
    b.craps.closeCrapsTable(craps);
    b.craps.openCrapsBetting(craps, 1, null);
    b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    b.craps.closeCrapsBetting(craps, b.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc); // page a hears it all between two frames
    // Page a holds no house seed for the new roll: it voids it.
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readCrapsTableState(craps)).toMatchObject({ round: 1, voided: true });
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'pass', amount: 10 }]);
      expect(page.casino.readChips(bettor)).toBe(90);
    }
  });

  it("craps, on an earlier build's table: likewise", async () => {
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    const { inc: _inc, ...earlier } = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, earlier); // no incarnation
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 30 }]);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    b.craps.closeCrapsTable(craps);
    b.craps.openCrapsBetting(craps, 1, null);
    b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    b.craps.closeCrapsBetting(craps, b.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    a.craps.rollAndSettleCraps(craps, 1, null);
    await flush();
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readCrapsTableState(craps)).toMatchObject({ round: 1, voided: true });
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'pass', amount: 10 }]);
      expect(page.casino.readChips(bettor)).toBe(90);
    }
  });

  it('and what the page first sees of the new close is what it keeps', () => {
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 30 }]);
    a.craps.closeCrapsBetting(craps, a.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    b.craps.closeCrapsTable(craps);
    b.craps.openCrapsBetting(craps, 1, null);
    b.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    b.craps.closeCrapsBetting(craps, b.casino.readCrapsTableState(craps)!);
    sync(a.doc, b.doc);
    a.fair.tickFairSeeds(craps, 'craps', bettor, Date.now(), true); // page a's next frame
    // A peer rewrites the close after that.
    const s = b.casino.readCrapsTableState(craps)!;
    b.casino.writeCrapsTableState(craps, { ...s, stakes: { [bettor]: 99 } });
    sync(a.doc, b.doc);
    expect(a.fair.frozenFields(craps, a.casino.readCrapsTableState(craps)!).stakes).toEqual({ [bettor]: 10 });
  });

  it('roulette too', async () => {
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    sync(a.doc, b.doc);
    b.croupier.closeTable(TABLE);
    b.croupier.openBetting(TABLE, 1);
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    b.croupier.closeBetting(TABLE, b.casino.readTableState(TABLE)!);
    sync(a.doc, b.doc);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readTableState(TABLE)).toMatchObject({ round: 1, voided: true });
      expect(page.casino.readChips(bettor)).toBe(100);
    }
  });
});

describe('a takeover written at the very moment the round settles', () => {
  const bettor = 'player-Carol';
  const craps = 'craps-1';
  const T = 2_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** World's per-frame work on a page of a manual (venture) room. */
  function frame(p: Page, now: number): void {
    vi.setSystemTime(now);
    p.croupier.noteTablesRunning(now);
    p.craps.tickManualCraps(craps, now, undefined);
    p.fair.tickFairSeeds(craps, 'craps', OWNER, now);
  }

  for (const second of [[3, 4], [1, 1]] as const) {
    it(`craps: the roll stands as its settle left it, the takeover throwing no other (${second.join('+')} second)`, async () => {
      vi.setSystemTime(T - 5_000);
      const x = await loadPage(1); // the house member whose ROLL holds the turn
      const y = await loadPage(2); // another house member, whose stamp wins ties
      x.casino.writeCrapsFairnessPref(craps, 'rng');
      x.casino.buyInChips(bettor, 100);
      expect(x.craps.pressManualRoll(craps, T - 5_000)).toMatch(/BETS OPEN/);
      x.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
      sync(x.doc, y.doc);
      for (let t = T - 5_000; t < T; t += 500) { frame(x, t); frame(y, t); }
      expect(x.craps.pressManualRoll(craps, T)).toBeNull(); // the stickman throws at T + 2.5 s
      sync(x.doc, y.doc);
      frame(x, T);
      // X's tab goes to the background (its frames stop) and comes back at
      // T + 24.5 s, to wait out a lapse; Y watches the turn all along.
      frame(x, T + 200);
      for (let t = T; t <= T + 30_000; t += 500) {
        frame(y, t);
        if (t >= T + 24_500) { frame(x, t); sync(x.doc, y.doc); }
      }
      // T + 30.5 s: X's hold ends and it throws, as Y's press takes the turn
      // over. Neither has heard the other.
      diceTo(3, 3); // X's roll: a six, the pass rides
      frame(y, T + 30_500);
      expect(y.craps.pressManualRoll(craps, T + 30_500)).toBeNull();
      frame(x, T + 30_500);
      await flush();
      expect(x.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', dice: [3, 3] });
      const thrown = x.casino.readDiceThrow(craps);
      sync(x.doc, y.doc);
      // The doc keeps Y's stamp, and the table reads as the book has it.
      expect(y.doc.getMap('casino').get(`table:${craps}`)).toMatchObject({ phase: 'closing', operator: y.backend.CRAPS_PAGE_ID });
      expect(y.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', dice: [3, 3] });
      diceTo(second[0], second[1]);
      for (let t = T + 31_000; t <= T + 33_000; t += 500) { frame(x, t); frame(y, t); await flush(); }
      sync(x.doc, y.doc);
      for (const page of [x, y]) {
        expect(page.casino.readCrapsTableState(craps)).toMatchObject({ phase: 'settled', round: 1, dice: [3, 3], point: 6 });
        expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'pass', amount: 10 }]);
        expect(page.casino.readChips(bettor)).toBe(90);
      }
      expect(y.casino.readDiceThrow(craps)).toEqual(thrown);
    });
  }

  for (const fair of [false, true]) {
    it(`craps: the settle itself puts the roll back, called after the stamp came back over it (${fair ? 'Fair: the takeover would void it' : 'RNG: it would roll again'})`, async () => {
      vi.setSystemTime(T);
      const x = await loadPage(1); // the ROLL's page, which holds the house seed
      const y = await loadPage(2); // a house member taking the turn over, whose stamp wins ties
      if (!fair) x.casino.writeCrapsFairnessPref(craps, 'rng');
      x.casino.buyInChips(bettor, 100);
      x.craps.openCrapsBetting(craps, 1, null);
      x.casino.writeMyCrapsBets(craps, bettor, [{ type: 'field', amount: 10 }]);
      x.craps.closeCrapsBetting(craps, x.casino.readCrapsTableState(craps)!, T, true);
      sync(x.doc, y.doc);
      // Y stamps itself operator as X settles, neither hearing the other.
      y.casino.writeCrapsTableState(craps, { ...y.casino.readCrapsTableState(craps)!, operator: y.backend.CRAPS_PAGE_ID });
      diceTo(1, 1);
      x.craps.rollAndSettleCraps(craps, 1, null);
      await flush();
      const left = x.casino.readCrapsTableState(craps)!;
      expect(left).toMatchObject({ phase: 'settled', round: 1 });
      const chips = x.casino.readChips(bettor);
      sync(x.doc, y.doc);
      expect(y.doc.getMap('casino').get(`table:${craps}`)).toMatchObject({ phase: 'closing', operator: y.backend.CRAPS_PAGE_ID });
      expect(y.casino.readCrapsTableState(craps)).toEqual(left); // as the book has it
      diceTo(3, 4);
      y.craps.rollAndSettleCraps(craps, 1, null); // straight to the settle, as an earlier check let it through
      await flush();
      expect(y.casino.readCrapsTableState(craps)).toEqual(left); // it settled nothing
      // Y's next write of the table's state (here a deadline stamp over the
      // doc's) puts the book's back up instead, in a fresh write of the book.
      y.casino.writeCrapsTableState(craps, { ...(y.doc.getMap('casino').get(`table:${craps}`) as import('./games/craps').CrapsTableState), phaseDeadline: T });
      sync(x.doc, y.doc);
      for (const page of [x, y]) {
        expect(page.casino.readCrapsTableState(craps)).toEqual({ ...left, bk: page.casino.readTableBook(craps, left.inc!)!.id });
        expect(page.casino.readTableBook(craps, left.inc!)!.id).not.toBe(left.bk);
        expect(page.casino.readChips(bettor)).toBe(chips);
      }
    });
  }

  it("craps: a void the doc keeps under the takeover's stamp gets no dice thrown for it", async () => {
    vi.setSystemTime(T);
    const x = await loadPage(1); // the ROLL's page, without the house seed
    const y = await loadPage(2); // the page that opened the round (it holds the seed), taking the turn over
    y.casino.buyInChips(bettor, 100);
    y.craps.openCrapsBetting(craps, 1, null);
    y.casino.writeMyCrapsBets(craps, bettor, [{ type: 'field', amount: 10 }]);
    sync(x.doc, y.doc);
    x.craps.closeCrapsBetting(craps, x.casino.readCrapsTableState(craps)!, T, true);
    sync(x.doc, y.doc);
    x.craps.rollAndSettleCraps(craps, 1, null); // X can't reveal the house seed: void
    await flush();
    const left = x.casino.readCrapsTableState(craps)!;
    expect(left).toMatchObject({ phase: 'settled', voided: true });
    y.casino.writeCrapsTableState(craps, { ...y.casino.readCrapsTableState(craps)!, operator: y.backend.CRAPS_PAGE_ID });
    sync(x.doc, y.doc);
    const s = y.doc.getMap('casino').get(`table:${craps}`) as import('./games/craps').CrapsTableState;
    expect(s).toMatchObject({ phase: 'closing', operator: y.backend.CRAPS_PAGE_ID });
    y.craps.tickCrapsClosing(craps, s, undefined, Infinity); // the takeover's stickman, at once
    await flush();
    sync(x.doc, y.doc);
    for (const page of [x, y]) {
      expect(page.casino.readCrapsTableState(craps)).toEqual({ ...left, bk: page.casino.readTableBook(craps, left.inc!)!.id });
      expect(page.casino.readDiceThrow(craps)).toBeNull();
      expect(page.casino.readMyCrapsBets(craps, bettor)).toEqual([{ type: 'field', amount: 10 }]);
    }
  });

  it('roulette: the spin stands as its settle left it, and pays once', async () => {
    vi.setSystemTime(T);
    const x = await loadPage(1); // the SPIN's page
    const y = await loadPage(2); // the robot's page, whose stamp wins ties
    x.casino.writeCrapsFairnessPref(TABLE, 'rng');
    x.casino.buyInChips(bettor, 100);
    x.croupier.openBetting(TABLE, 1);
    x.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    x.croupier.closeBetting(TABLE, x.casino.readTableState(TABLE)!, undefined, x.croupier.ROULETTE_PAGE_ID);
    sync(x.doc, y.doc);
    // The robot takes the SPIN over as X settles it, neither hearing the other.
    y.casino.writeTableState(TABLE, { ...y.casino.readTableState(TABLE)!, operator: y.croupier.ROULETTE_PAGE_ID });
    spinTo(1); // X's spin: red, Carol's 10 pays 20
    x.croupier.rollAndSettle(TABLE, 1);
    await flush();
    sync(x.doc, y.doc);
    expect(y.doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ phase: 'closing', operator: y.croupier.ROULETTE_PAGE_ID });
    expect(y.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', result: 1 }); // as the book has it
    spinTo(2); // what the robot would spin: black
    y.croupier.rollAndSettle(TABLE, 1, y.croupier.SHOW_MS);
    await flush();
    sync(x.doc, y.doc);
    for (const page of [x, y]) {
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1, result: 1, payouts: { [bettor]: 20 } });
      expect(page.casino.readChips(bettor)).toBe(110);
    }
  });
});

describe("a table's book (casinoDoc THE TABLE'S BOOK) and the table's removal", () => {
  const bettor = 'player-Carol';

  async function settleRound1(page: Page): Promise<void> {
    page.casino.writeCrapsFairnessPref(TABLE, 'rng'); // (a removal takes the table's settings with it)
    page.croupier.openBetting(TABLE, 1);
    page.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    page.croupier.closeBetting(TABLE, page.casino.readTableState(TABLE)!);
    spinTo(1); // red: the 10 pays 20
    page.croupier.rollAndSettle(TABLE, 1);
    await flush();
  }

  it('stays when the table is removed after the settle, holding what it paid; the table put back keeps a book of its own', async () => {
    a.casino.buyInChips(bettor, 100);
    await settleRound1(a);
    const { inc, book } = onlyBook(a, TABLE);
    expect(book).toMatchObject({ round: 1, recs: { [bettor]: { d: '10', r: 1 } }, st: { phase: 'settled', round: 1 } });
    expect(a.casino.readTableState(TABLE)?.bk).toBe(book.id);
    sync(a.doc, b.doc);
    b.croupier.closeTable(TABLE, 'local');
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readTableBook(TABLE, inc)).toEqual(book);
      expect(page.casino.readTableState(TABLE)).toBeNull();
      expect(page.casino.readChips(bettor)).toBe(110);
    }
    await settleRound1(b); // put back, its first round won
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readTableState(TABLE)!.inc).not.toBe(inc);
      expect(page.casino.readTableBook(TABLE, page.casino.readTableState(TABLE)!.inc!)).toMatchObject({ round: 1 });
      expect(page.casino.readChips(bettor)).toBe(120);
    }
  });

  it('left by a removal at the very moment of the settle, never stands for the table put back', async () => {
    a = await loadPage(1); // the driver, settling round 1
    b = await loadPage(2); // the owner's other page, removing the table
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    sync(a.doc, b.doc);
    spinTo(1);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    b.croupier.closeTable(TABLE, 'local');
    sync(a.doc, b.doc);
    // The settle's writes outlive the removal's deletes; its marks end them.
    const { inc } = onlyBook(a, TABLE);
    expect(a.doc.getMap('casino').get(`table:${TABLE}`)).toMatchObject({ phase: 'settled', inc });
    expect(a.casino.readTableState(TABLE)).toBeNull();
    const chips = a.casino.readChips(bettor);
    // The table is put back, and its first round plays.
    await settleRound1(a);
    sync(a.doc, b.doc);
    for (const page of [a, b]) {
      expect(page.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', round: 1, result: 1, payouts: { [bettor]: 20 } });
      expect(page.casino.readChips(bettor)).toBe(chips + 10);
    }
  });
});
