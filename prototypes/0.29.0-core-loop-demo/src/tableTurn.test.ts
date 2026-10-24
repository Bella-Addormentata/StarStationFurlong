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
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  casino.bindCasinoDoc(doc);
  return { casino, croupier, craps, backend, doc };
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
      a.casino.writeCrapsTableState(craps, { ...s, phase: 'settled', point: null });
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
      a.casino.writeCrapsTableState(craps, { ...s, phase: 'settled' });
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
      a.casino.writeCrapsTableState(craps, { ...s, phase: 'settled', point: 6 });
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
      a.casino.writeCrapsTableState(craps, { ...s, phase: 'settled', point: 6 });
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

  it('leaves nothing behind for a table this page never saw up', () => {
    // A page leaving a room reconciles the last room's tables away against
    // the new room's doc.
    expect(updatesDuring(a, () => a.croupier.closeTable('casino-roulette-elsewhere'))).toBe(0);
    expect(updatesDuring(a, () => a.craps.closeCrapsTable('casino-craps-elsewhere'))).toBe(0);
  });

  it('nor does a table put back under the same id play the bets it left', () => {
    crapsBet();
    const s = a.casino.readCrapsTableState(craps)!;
    a.casino.writeCrapsTableState(craps, { ...s, phase: 'settled', point: 6 });
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
