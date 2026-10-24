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
  const doc = new Y.Doc();
  casino.bindCasinoDoc(doc);
  return { casino, croupier, craps, doc };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function turn(page: Page, now: number): boolean {
  return page.croupier.takeTableTurn(now);
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
    a.croupier.rollAndSettle(TABLE, 1); // a plain RNG table settles at once
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

afterEach(() => {
  vi.restoreAllMocks();
});
