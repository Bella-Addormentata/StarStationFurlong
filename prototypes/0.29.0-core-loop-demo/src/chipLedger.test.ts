/**
 * 🧾 Chip ledger tests (casinoDoc CHIP LEDGER).
 *
 * A player's chips are their old stored `bal:` (the opening balance) plus the
 * sum of their chip records. These specs pin what that buys: two pages paying
 * or charging one player at once both count on every page, whatever order the
 * updates arrive in; a room saved by an earlier build opens with its balances;
 * and the cage totals still come out of the ledger alone.
 *
 * Each "page" is its own load of casinoDoc (vi.resetModules), bound to its own
 * Y.Doc, the docs synced by hand like two peers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

type CasinoDoc = typeof import('./casinoDoc');

const PLAYER = 'player-Bob';
const OTHER = 'player-Carol';

async function loadPage(doc: Y.Doc): Promise<CasinoDoc> {
  vi.resetModules();
  const page = await import('./casinoDoc');
  page.bindCasinoDoc(doc);
  return page;
}

/** Send each doc what the other is missing. */
function sync(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB);
  Y.applyUpdate(a, toA);
}

let docA: Y.Doc;
let docB: Y.Doc;
let pageA: CasinoDoc;
let pageB: CasinoDoc;

beforeEach(async () => {
  docA = new Y.Doc();
  docB = new Y.Doc();
  pageA = await loadPage(docA);
  pageB = await loadPage(docB);
});

describe('two pages moving one player\'s chips at once', () => {
  it('both changes count, on both pages (a stored number kept only one)', () => {
    pageA.buyInChips(PLAYER, 100);
    sync(docA, docB);
    // Neither page has seen the other's change yet.
    expect(pageA.spendChips(PLAYER, 30)).toBe(true);
    pageB.creditChips(PLAYER, 50);
    expect(pageA.readChips(PLAYER)).toBe(70);
    expect(pageB.readChips(PLAYER)).toBe(150);
    sync(docA, docB);
    expect(pageA.readChips(PLAYER)).toBe(120);
    expect(pageB.readChips(PLAYER)).toBe(120);
  });

  it('comes out the same whichever update lands first', () => {
    pageA.buyInChips(PLAYER, 40);
    pageB.buyInChips(PLAYER, 5);
    pageA.creditChips(PLAYER, 7);
    pageB.spendChips(PLAYER, 5);
    const fromA = Y.encodeStateAsUpdate(docA);
    const fromB = Y.encodeStateAsUpdate(docB);
    const first = new Y.Doc();
    Y.applyUpdate(first, fromA);
    Y.applyUpdate(first, fromB);
    const second = new Y.Doc();
    Y.applyUpdate(second, fromB);
    Y.applyUpdate(second, fromA);
    sync(docA, docB);
    for (const page of [pageA, pageB]) expect(page.readChips(PLAYER)).toBe(47);
    pageA.bindCasinoDoc(first);
    expect(pageA.readChips(PLAYER)).toBe(47);
    pageA.bindCasinoDoc(second);
    expect(pageA.readChips(PLAYER)).toBe(47);
  });

  it('two pages staking the same chips both pay: the balance reads 0, and the next win pays off the debt first', () => {
    pageA.buyInChips(PLAYER, 10);
    sync(docA, docB);
    expect(pageA.spendChips(PLAYER, 10)).toBe(true);
    expect(pageB.spendChips(PLAYER, 10)).toBe(true);
    sync(docA, docB);
    expect(pageA.readChips(PLAYER)).toBe(0);
    pageA.creditChips(PLAYER, 15);
    expect(pageA.readChips(PLAYER)).toBe(5);
    expect(pageA.spendChips(PLAYER, 6)).toBe(false);
  });

  it('a slot payout and a coin pusher drop for one player on two pages both land', () => {
    pageA.buyInChips(PLAYER, 100);
    pageA.buyInChips(OTHER, 1_000);
    sync(docA, docB);
    // Page A runs a slot whose bankroll is OTHER's chips: stake 10, pay 25.
    pageA.writeSlotFundingConfig('slot-1', { mode: 'owner', ownerId: OTHER });
    expect(pageA.reserveSlotWager('slot-1', PLAYER, 10, { mode: 'owner', ownerId: OTHER }, 50)).toBe('ok');
    expect(pageA.settleSlotWager('slot-1', PLAYER, { mode: 'owner', ownerId: OTHER }, 25)).toBe(true);
    // Page B, meanwhile, charges the same player for something else.
    expect(pageB.spendChips(PLAYER, 4)).toBe(true);
    sync(docA, docB);
    for (const page of [pageA, pageB]) {
      expect(page.readChips(PLAYER)).toBe(100 - 10 + 25 - 4);
      expect(page.readChips(OTHER)).toBe(1_000 + 10 - 25);
    }
  });
});

describe('a room saved by an earlier build', () => {
  it('opens with each player\'s stored balance, and never writes it again', () => {
    const saved = new Y.Doc();
    saved.getMap('casino').set(`bal:${PLAYER}`, 40);
    pageA.bindCasinoDoc(saved);
    expect(pageA.readChips(PLAYER)).toBe(40);
    expect(pageA.spendChips(PLAYER, 15)).toBe(true);
    expect(pageA.readChips(PLAYER)).toBe(25);
    expect(saved.getMap('casino').get(`bal:${PLAYER}`)).toBe(40);
    expect(pageA.readChipRecords(PLAYER).map((r) => r.d)).toEqual([-15]);
  });

  it('an earlier build still in the room moves the opening balance, and the sum stays right', () => {
    const map = docA.getMap('casino');
    map.set(`bal:${PLAYER}`, 40);
    expect(pageA.spendChips(PLAYER, 10)).toBe(true);
    // The earlier build reads only `bal:` (40) and writes back 40 + 5 for a payout.
    map.set(`bal:${PLAYER}`, 45);
    expect(pageA.readChips(PLAYER)).toBe(35);
  });

  it('a junk stored balance reads as none', () => {
    docA.getMap('casino').set(`bal:${PLAYER}`, -3);
    pageA.creditChips(PLAYER, 2);
    expect(pageA.readChips(PLAYER)).toBe(2);
  });
});

describe('chip records', () => {
  it('junk under a record key counts for nothing, and a rewritten record is recounted exactly', () => {
    pageA.buyInChips(PLAYER, 20);
    const chips = docA.getMap('casinoChips');
    chips.set('junk:1', { p: PLAYER, d: 1.5, b: 0, c: 0, at: 0 });
    chips.set('junk:2', { p: PLAYER, d: 5, b: -5, c: 0, at: 0 });
    chips.set('junk:3', { p: PLAYER, d: 5 });
    chips.set('junk:4', 99);
    expect(pageA.readChips(PLAYER)).toBe(20);
    expect(pageA.readCageLedger().issued).toBe(20);
    // A peer rewriting a record (honest clients never do) is taken as it now stands.
    const [key] = [...chips.keys()].filter((k) => !k.startsWith('junk:'));
    chips.set(key, { p: PLAYER, d: 3, b: 3, c: 0, at: 0 });
    expect(pageA.readChips(PLAYER)).toBe(3);
    expect(pageA.readCageLedger().issued).toBe(3);
    chips.delete(key);
    expect(pageA.readChips(PLAYER)).toBe(0);
    expect(pageA.readCageLedger().issued).toBe(0);
  });

  it('a player\'s key listeners hear a change that arrives from another page', () => {
    const heard = vi.fn();
    pageA.subscribeCasinoKey(`bal:${PLAYER}`, heard);
    pageB.creditChips(PLAYER, 9);
    sync(docA, docB);
    expect(heard).toHaveBeenCalled();
    expect(pageA.readChips(PLAYER)).toBe(9);
  });

  it('a listener for another key written in the same update already reads the new chips', () => {
    pageA.buyInChips(PLAYER, 10);
    sync(docA, docB);
    const seen: number[] = [];
    pageA.subscribeCasinoKey(`slot:m1`, () => seen.push(pageA.readChips(PLAYER)));
    docB.transact(() => {
      docB.getMap('casino').set('slot:m1', { marker: true });
      pageB.creditChips(PLAYER, 5);
    });
    sync(docA, docB);
    expect(seen).toEqual([15]);
  });

  it('reads in the same transaction see a record written earlier in it', () => {
    pageA.buyInChips(PLAYER, 10);
    docA.transact(() => {
      expect(pageA.spendChips(PLAYER, 6)).toBe(true);
      expect(pageA.readChips(PLAYER)).toBe(4);
      expect(pageA.spendChips(PLAYER, 6)).toBe(false);
    });
  });

  it('a page keeps one record per player, however many bets it moves', () => {
    pageA.buyInChips(PLAYER, 500);
    for (let i = 0; i < 200; i++) {
      expect(pageA.spendChips(PLAYER, 2)).toBe(true);
      pageA.creditChips(PLAYER, 1);
      pageA.creditChips(OTHER, 1);
    }
    expect(pageA.cashOutChips(PLAYER, 50)).toBe(50);
    expect(docA.getMap('casinoChips').size).toBe(2);
    expect(pageA.readChipRecords(PLAYER)).toEqual([
      expect.objectContaining({ p: PLAYER, d: 500 - 200 - 50, b: 500, c: 50 }),
    ]);
    expect(pageA.readChips(PLAYER)).toBe(250);
    expect(pageA.readChips(OTHER)).toBe(200);
  });

  it('two pages, or two binds of one page, never write the same record', () => {
    pageA.creditChips(PLAYER, 1);
    pageB.creditChips(PLAYER, 1);
    sync(docA, docB);
    expect(docA.getMap('casinoChips').size).toBe(2);
    expect(pageA.readChips(PLAYER)).toBe(2);
    // Page A leaves and joins the room again on a fresh doc that hasn't
    // synced its old record yet: its new record can't overwrite the old one.
    const rejoined = new Y.Doc();
    pageA.bindCasinoDoc(rejoined);
    pageA.creditChips(PLAYER, 5);
    sync(rejoined, docB);
    expect(pageA.readChips(PLAYER)).toBe(7);
    expect(rejoined.getMap('casinoChips').size).toBe(3);
  });
});

describe('the cage ledger', () => {
  it('adds the ledger\'s buy-ins and cash-outs to an earlier build\'s lifetime totals', () => {
    const map = docA.getMap('casino');
    map.set(`bal:${OTHER}`, 30);
    map.set(`bought:${OTHER}`, 50);
    map.set(`cashed:${OTHER}`, 20);
    pageA.buyInChips(PLAYER, 100);
    expect(pageA.cashOutChips(PLAYER, 40)).toBe(40);
    expect(pageA.spendChips(PLAYER, 10)).toBe(true);
    pageA.creditChips(OTHER, 5);
    expect(pageA.readCageLedger()).toEqual({
      issued: 150,
      cashed: 60,
      outstanding: 50 + 35,
      houseNet: 150 - 60 - 85,
      balances: { [PLAYER]: 50, [OTHER]: 35 },
    });
  });

  it('counts a buy-in from another page once it arrives', () => {
    pageB.buyInChips(PLAYER, 25);
    expect(pageA.readCageLedger().issued).toBe(0);
    sync(docA, docB);
    expect(pageA.readCageLedger()).toMatchObject({ issued: 25, outstanding: 25, houseNet: 0 });
  });
});
