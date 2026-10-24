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

async function loadPage(): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const craps = await import('./crapsCroupier');
  const backend = await import('./crapsBackend');
  const doc = new Y.Doc();
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

  it('a lease an earlier deed holder\'s page left is taken at once', () => {
    a.casino.writeTableOperatorLease({ page: 'old-page', player: EARLIER_OWNER, beat: 9 });
    expect(turn(a, 0)).toBe(false);
    expect(a.casino.readTableOperatorLease()?.page).toBe(a.croupier.ROULETTE_PAGE_ID);
    expect(turn(a, 1_500)).toBe(true);
  });
});

describe('a table torn down on both pages', () => {
  const bettor = 'player-Carol';

  function betAndShare(): void {
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    expect(a.casino.spendChips(bettor, 30)).toBe(true);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
    turn(a, Date.now());
    sync(a.doc, b.doc);
    expect(turn(b, Date.now())).toBe(false); // a drives
  }

  it('refunds the stakes on it once, removed on both before either hears of the other', () => {
    betAndShare();
    a.croupier.closeTable(TABLE);
    b.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    expect(a.casino.readChips(bettor)).toBe(100);
    expect(b.casino.readChips(bettor)).toBe(100);
  });

  it('sends the refunds and the removal as one update, so no page sees one without the other', () => {
    betAndShare();
    expect(updatesDuring(b, () => b.croupier.closeTable(TABLE))).toBe(1);
    const craps = 'craps-1';
    a.craps.openCrapsBetting(craps, 1, null);
    a.casino.writeMyCrapsBets(craps, bettor, [{ type: 'pass', amount: 10 }]);
    expect(updatesDuring(a, () => a.craps.closeCrapsTable(craps))).toBe(1);
  });

  it('refunds them once when the page not driving removes it first and the driver hears after', () => {
    betAndShare();
    b.croupier.closeTable(TABLE); // refunds, then clears the bets
    sync(a.doc, b.doc);
    a.croupier.closeTable(TABLE); // finds no bets left
    sync(a.doc, b.doc);
    expect(a.casino.readChips(bettor)).toBe(100);
    expect(b.casino.readChips(bettor)).toBe(100);
  });

  it('refunds one page\'s view of the stakes, never both, when only one had heard of a late bet', () => {
    betAndShare();
    // The bettor's second chip reached page b only.
    expect(b.casino.spendChips(bettor, 10)).toBe(true);
    b.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }, { type: 'black', amount: 10 }]);
    a.croupier.closeTable(TABLE);
    b.croupier.closeTable(TABLE);
    sync(a.doc, b.doc);
    const chips = a.casino.readChips(bettor);
    expect([90, 100]).toContain(chips); // 60 left + 30 or 40 back (digests per view paid 70)
    expect(b.casino.readChips(bettor)).toBe(chips);
  });

  it('a round settled on the driver while the other page removed the table pays the win or the refund, never both', () => {
    // A red pocket every spin, so the 30 on red pays 60.
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      (arr as unknown as Uint32Array)[0] = 1;
      return arr;
    });
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    betAndShare();
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    sync(a.doc, b.doc);
    // A plain RNG table settles at once, the round and its pay in one update.
    expect(updatesDuring(a, () => a.croupier.rollAndSettle(TABLE, 1))).toBe(1);
    expect(a.casino.readTableState(TABLE)).toMatchObject({ phase: 'settled', result: 1 });
    expect(a.casino.readChips(bettor)).toBe(130);
    b.croupier.closeTable(TABLE); // b still sees the round closing
    sync(a.doc, b.doc);
    a.croupier.closeTable(TABLE); // a hears of the removal
    sync(a.doc, b.doc);
    const chips = a.casino.readChips(bettor);
    expect([130, 100]).toContain(chips);
    expect(b.casino.readChips(bettor)).toBe(chips);
  });
});

describe('a table set up again under the same id', () => {
  const bettor = 'player-Carol';

  it('refunds roulette stakes on its round 1 though the table before it was removed at round 1 with the same bets', () => {
    a.casino.buyInChips(bettor, 100);
    for (let n = 0; n < 2; n++) {
      a.croupier.openBetting(TABLE, 1);
      expect(a.casino.spendChips(bettor, 30)).toBe(true);
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 30 }]);
      a.croupier.closeTable(TABLE);
      expect(a.casino.readChips(bettor)).toBe(100);
    }
  });

  it('refunds craps stakes likewise', () => {
    const table = 'craps-1';
    a.casino.buyInChips(bettor, 100);
    for (let n = 0; n < 2; n++) {
      a.craps.openCrapsBetting(table, 1, null);
      expect(a.casino.spendChips(bettor, 30)).toBe(true);
      a.casino.writeMyCrapsBets(table, bettor, [{ type: 'pass', amount: 30 }]);
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

describe('bets the chip ledger could not pay', () => {
  it('a bet past the largest stake, or a list past the most records, reads as no bets', () => {
    a.casino.writeMyBets(TABLE, 'player-huge', 1, [{ type: 'red', amount: 2 ** 52 }]);
    a.casino.writeMyBets(TABLE, 'player-long', 1, Array.from({ length: 1001 }, () => ({ type: 'red' as const, amount: 1 })));
    a.casino.writeMyBets(TABLE, 'player-full', 1, Array.from({ length: 1000 }, () => ({ type: 'red' as const, amount: 1000 })));
    expect(Object.keys(a.casino.readAllBets(TABLE, 1))).toEqual(['player-full']);
    const craps = 'craps-1';
    a.casino.writeMyCrapsBets(craps, 'player-huge', [{ type: 'pass', amount: 2 ** 52 }]);
    a.casino.writeMyCrapsBets(craps, 'player-long', Array.from({ length: 1001 }, () => ({ type: 'pass' as const, amount: 1 })));
    a.casino.writeMyCrapsBets(craps, 'player-full', [{ type: 'pass', amount: 1000 }]);
    expect(Object.keys(a.casino.readAllCrapsBets(craps))).toEqual(['player-full']);
  });
});

describe('a manual craps roll held by the owner\'s page that is not driving', () => {
  const table = 'craps-1';
  let now = 2_000_000_000;
  const later = (ms: number): void => {
    now += ms;
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

afterEach(() => {
  vi.restoreAllMocks();
});
