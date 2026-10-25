/**
 * 🔔 How often a bal: listener is told, and what readChips reads when it is:
 * once per transaction, a settle that writes both casino maps included, on
 * the page that writes it and on every page that hears it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

type Page = {
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  craps: typeof import('./crapsCroupier');
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
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  casino.bindCasinoDoc(doc);
  return { casino, croupier, craps, doc };
}

function sync(x: Y.Doc, y: Y.Doc): void {
  Y.applyUpdate(y, Y.encodeStateAsUpdate(x, Y.encodeStateVector(y)));
  Y.applyUpdate(x, Y.encodeStateAsUpdate(y, Y.encodeStateVector(x)));
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

const TABLE = 'roulette-1';
const bettor = 'player-Carol';

function listen(page: Page, pid: string): { calls: number; reads: number[] } {
  const seen = { calls: 0, reads: [] as number[] };
  page.casino.subscribeCasinoKey(`bal:${pid}`, () => {
    seen.calls += 1;
    seen.reads.push(page.casino.readChips(pid));
  });
  return seen;
}

describe('bal: listener on a roulette settle (a transaction of both maps)', () => {
  it('is told once on the settling page', async () => {
    const a = await loadPage(1);
    spinTo(1); // red
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    expect(a.casino.readChips(bettor)).toBe(90);
    const seen = listen(a, bettor);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    expect(a.casino.readChips(bettor)).toBe(110);
    expect(seen).toEqual({ calls: 1, reads: [110] });
  });

  it('is told once on a page that hears the settle', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    spinTo(1); // red
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    a.croupier.closeBetting(TABLE, a.casino.readTableState(TABLE)!);
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(90);
    const seen = listen(b, bettor);
    a.croupier.rollAndSettle(TABLE, 1);
    await flush();
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(110);
    expect(seen).toEqual({ calls: 1, reads: [110] });
  });
});

describe('bal: listener on a craps settle', () => {
  it('is told once on a page that hears the roll', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    const CRAPS = 'craps-1';
    a.casino.writeCrapsFairnessPref(CRAPS, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.craps.openCrapsBetting(CRAPS, 1, null);
    a.casino.writeMyCrapsBets(CRAPS, bettor, [{ type: 'pass', amount: 10 }]);
    a.craps.closeCrapsBetting(CRAPS, a.casino.readCrapsTableState(CRAPS)!);
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(90);
    const seen = listen(b, bettor);
    diceTo(3, 4); // a 7 on the come-out: the pass line wins
    a.craps.rollAndSettleCraps(CRAPS, 1, null);
    await flush();
    sync(a.doc, b.doc);
    expect(b.casino.readChips(bettor)).toBe(110);
    expect(seen).toEqual({ calls: 1, reads: [110] });
  });
});

describe('bal: listener on one transaction of the casino map, then the chips', () => {
  it('is told once, the held chips and the chips both moved', async () => {
    const a = await loadPage(1);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    const seen = listen(a, bettor);
    a.doc.transact(() => {
      a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
      a.casino.buyInChips(bettor, 5);
    });
    expect(seen).toEqual({ calls: 1, reads: [95] });
  });
});

describe('bal: listener on a bet and a removal', () => {
  it('a bet placed is told once, with the held chips off', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    sync(a.doc, b.doc);
    const seenA = listen(a, bettor);
    const seenB = listen(b, bettor);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    sync(a.doc, b.doc);
    expect(seenA).toEqual({ calls: 1, reads: [90] });
    expect(seenB).toEqual({ calls: 1, reads: [90] });
  });

  it('a removal is told once, with the chips back', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    sync(a.doc, b.doc);
    const seenA = listen(a, bettor);
    const seenB = listen(b, bettor);
    a.croupier.closeTable(TABLE, 'local');
    sync(a.doc, b.doc);
    expect(seenA).toEqual({ calls: 1, reads: [100] });
    expect(seenB).toEqual({ calls: 1, reads: [100] });
  });
});

describe('rebinding', () => {
  it('a fresh doc tells listeners and reads its own chips', async () => {
    const a = await loadPage(1);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    a.casino.buyInChips(bettor, 100);
    a.croupier.openBetting(TABLE, 1);
    a.casino.writeMyBets(TABLE, bettor, 1, [{ type: 'red', amount: 10 }]);
    expect(a.casino.readChips(bettor)).toBe(90);
    const seen = listen(a, bettor);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(a.doc));
    // the other room has Carol's list taken down
    fresh.getMap('casino').delete(`bets:${TABLE}:${bettor}`);
    a.casino.bindCasinoDoc(fresh);
    expect(seen.reads.at(-1)).toBe(100);
    // the old doc changing a list must not change what the bound doc reads
    a.doc.getMap('casino').set(`bets:${TABLE}:${bettor}`, { round: 1, held: [{ type: 'red', amount: 50 }], inc: a.doc.getMap('casino').get(`table:${TABLE}`) && (a.doc.getMap('casino').get(`table:${TABLE}`) as { inc: string }).inc });
    expect(a.casino.readChips(bettor)).toBe(100);
  });
});
