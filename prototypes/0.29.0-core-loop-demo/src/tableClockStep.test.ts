/**
 * ⏱ A clock that steps back by a little (a time sync's correction) is no
 * sleep (croupier noteTablesRunning): the page drives on, and a watch over
 * another page's turn runs on, however often it steps.
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
const TABLE = 'roulette-1';

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

const BASE = 2_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a lone driving page', () => {
  it('whose clock steps back 1 ms every 5 s drives again within a minute', async () => {
    const a = await loadPage();
    a.croupier.takeTableTurn(BASE);
    expect(a.croupier.takeTableTurn(BASE + 1_600)).toBe(true);
    let skew = 0;
    let drove = 0;
    const wakes0 = a.croupier.tablesWakeCount();
    for (let rt = 1_700; rt <= 61_700; rt += 100) {
      if (rt % 5_000 === 0) skew -= 101; // this frame reads 1 ms before the last
      const clock = BASE + rt + skew;
      a.croupier.noteTablesRunning(clock);
      if (a.croupier.takeTableTurn(clock)) drove += 1;
    }
    expect({ drove: drove > 300, wakes: a.croupier.tablesWakeCount() - wakes0 }).toEqual({ drove: true, wakes: 0 });
  });
});

describe('a settle resuming between frames', () => {
  it('may act after a step back of under a second: a time sync is no sleep', async () => {
    const a = await loadPage();
    for (let t = BASE; t <= BASE + 2_000; t += 100) a.croupier.noteTablesRunning(t);
    expect(a.croupier.tablesAwake(BASE + 1_700)).toBe(true);
    expect(a.croupier.tablesAwake(BASE + 900)).toBe(false); // a second or more: a wake
  });
});

describe("a robot watching another page's SPIN", () => {
  it('takes the abandoned round over though its clock steps back 1 ms every 10 s', async () => {
    const a = await loadPage(1);
    const b = await loadPage(2);
    a.casino.writeCrapsFairnessPref(TABLE, 'rng');
    // b (another of the owner's pages, not driving) pressed SPIN, then went away.
    a.croupier.openBetting(TABLE, 1);
    sync(a.doc, b.doc);
    b.croupier.closeBetting(TABLE, b.casino.readTableState(TABLE)!, undefined, b.croupier.ROULETTE_PAGE_ID);
    sync(a.doc, b.doc);
    a.croupier.takeTableTurn(BASE);
    let skew = 0;
    let tookAt = -1;
    for (let rt = 100; rt <= 120_000 && tookAt < 0; rt += 100) {
      if (rt % 10_000 === 0) skew -= 101;
      const clock = BASE + rt + skew;
      vi.setSystemTime(clock);
      a.croupier.noteTablesRunning(clock);
      if (a.croupier.takeTableTurn(clock)) a.croupier.tickAutoCroupier(TABLE);
      if (a.casino.readTableState(TABLE)?.operator === a.croupier.ROULETTE_PAGE_ID) tookAt = rt;
    }
    // Taken over once SPIN_TAKEOVER_MS (15 s) of watching has run.
    expect(tookAt).toBeGreaterThan(0);
    expect(tookAt).toBeLessThanOrEqual(60_000);
  });
});
