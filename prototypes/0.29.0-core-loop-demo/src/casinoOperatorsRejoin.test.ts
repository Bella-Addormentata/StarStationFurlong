/**
 * 🎰🪙 The slots' and the coin pusher's operators, each page its own module
 * load and Y.Doc:
 *  📒 a page whose doc holds part of the operator's update, where the
 *    operator's renewal parked there reads as no lease, claims none and
 *    writes no machine until the rest comes;
 *  🗄 a page back in the room on the room cache's copy takes their leases
 *    only once the room's state is in (croupier roomStateIn), so it refunds
 *    no spin and settles no drop the room ended while it was away. The
 *    machines have no book: both settles' chip records would count.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const OWNER = 'owner-Alice';
const BOB = 'player-Bob';
vi.stubGlobal('window', { location: { search: '' }, addEventListener: () => {}, removeEventListener: () => {} });
vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

type Page = {
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  slots: typeof import('./slotCroupier');
  pusher: typeof import('./pusherCroupier');
  slotGame: typeof import('./games/slots');
  game: typeof import('./games/coinPusher');
  doc: Y.Doc;
};

async function loadPage(clientID: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const slots = await import('./slotCroupier');
  const pusher = await import('./pusherCroupier');
  const slotGame = await import('./games/slots');
  const game = await import('./games/coinPusher');
  croupier.setSoleCroupierPredicate(() => true);
  const doc = new Y.Doc();
  doc.clientID = clientID;
  casino.bindCasinoDoc(doc);
  return { casino, croupier, slots, pusher, slotGame, game, doc };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

async function settleAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const PUSHER = 'pusher-1';
const SLOT = 'slot-machine-1';
const BET = 5;

afterEach(() => {
  vi.useRealTimers();
});

describe("a page holding part of the pusher operator's update", () => {
  for (const partial of [true, false]) it(`claims no pusher lease and writes no machine until the rest comes (partial: ${partial})`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 2_000_000_000;
    vi.setSystemTime(t0);
    const p = await loadPage(1); // operating
    const b = await loadPage(9); // another of the owner's pages
    // P becomes the operator and its machine takes 60 drops.
    let t = t0;
    for (; t <= t0 + 2_500; t += 100) { vi.setSystemTime(t); p.pusher.tickCoinPusherRoom([PUSHER], t); }
    let s = p.casino.readCoinPusherState(PUSHER)!;
    for (let i = 0; i < 60; i++) s = p.game.processInsert(s, 'player-Carol', (i % 3) as 0 | 1 | 2, (i * 0.37) % 1, i * 7919).state;
    p.casino.writeCoinPusherState(PUSHER, s);
    sync(p.doc, b.doc);
    for (let u = t0; u <= t; u += 100) b.pusher.tickCoinPusherRoom([PUSHER], u);
    expect(b.pusher.isCoinPusherOperator()).toBe(false);
    // P's next writes: a seat, then (later) its renewal and a settle.
    const ups: Uint8Array[] = [];
    p.doc.on('update', (u: Uint8Array) => ups.push(u));
    p.casino.writeMySeat('craps-1', 'player-Zed', { stand: 0, angle: 0, at: 1 });
    for (; t <= t0 + 6_000; t += 100) { vi.setSystemTime(t); p.pusher.tickCoinPusherRoom([PUSHER], t); }
    p.casino.writeCoinPusherState(PUSHER, p.game.processInsert(p.casino.readCoinPusherState(PUSHER)!, 'player-Carol', 1, 0.5, 42).state);
    const [first, ...rest] = ups;
    if (!partial) Y.applyUpdate(b.doc, first);
    for (const u of rest) Y.applyUpdate(b.doc, u);
    expect(b.casino.casinoWhole()).toBe(!partial);
    // B's frames while the rest is on its way.
    for (let u = t; u <= t + 3_000; u += 100) { vi.setSystemTime(u); b.pusher.tickCoinPusherRoom([PUSHER], u); }
    const bClaimed = b.pusher.isCoinPusherOperator();
    if (partial) Y.applyUpdate(b.doc, first);
    sync(p.doc, b.doc);
    const chips = (pg: Page): number => p.game.chipsInMachine(pg.casino.readCoinPusherState(PUSHER)!);
    expect({ bClaimed, chipsOnP: chips(p), chipsOnB: chips(b) }).toEqual({ bClaimed: false, chipsOnP: 61, chipsOnB: 61 });
  });
});

describe("slots, a page back in the room on the room cache's copy", () => {
  for (const arriveAfter of [1_000, 4_000]) it(`refunds no spin the room ended while it was away (room state in after ${arriveAfter} ms)`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 2_000_000_000;
    vi.setSystemTime(t0);
    const x = await loadPage(2);
    const y = await loadPage(5);
    let t = t0;
    const tick = async (pg: Page, ms: number): Promise<void> => {
      for (const end = t + ms; t <= end; t += 100) {
        vi.setSystemTime(t);
        pg.slots.tickSlotMachineRoom([SLOT], false, t);
        await settleAsync();
      }
    };
    x.casino.writeSlotFundingConfig(SLOT, { mode: 'owner', ownerId: OWNER });
    x.casino.buyInChips(OWNER, 1_000);
    x.casino.buyInChips(BOB, 100);
    const seed = x.slotGame.randomSlotSeed();
    x.casino.writeSlotPlayRequest(SLOT, {
      requestId: 'req-1', player: BOB, bet: BET, requestedAt: t,
      playerCommit: await x.slotGame.commitSlotSeed(seed),
      paytableHash: await x.slotGame.hashSlotPaytable(x.slotGame.DEFAULT_PAYTABLE),
    });
    await tick(x, 2_500); // x operates and accepts Bob's spin
    expect(x.casino.readSlotMachineState(SLOT)?.phase).toBe('spinning');
    let bound = x.doc;
    const all = (pg: Page): number => pg.casino.readChips(BOB) + pg.casino.readChips(OWNER)
      + ((pg === x ? bound : pg.doc).getMap('casino').get(`slot-escrow:${SLOT}`) as number ?? 0);
    expect(all(x)).toBe(1_100);
    x.slots.leaveSlotMachineRoom();
    const cached = Y.encodeStateAsUpdate(x.doc); // main.ts leaveRoomNow: release, flush, then cache.flushNow
    expect(x.casino.readSlotOperatorLease()).toBeNull();
    sync(x.doc, y.doc);
    await tick(y, 12_000); // y takes the slots over and ends the spin it didn't accept
    expect(y.casino.readSlotMachineState(SLOT)?.phase).toBe('settled');
    expect(all(y)).toBe(1_100);
    // x comes back on the cache's copy; the room's state isn't in yet.
    x.croupier.setRoomStateArrivedCheck(() => false);
    const back = new Y.Doc();
    back.clientID = 3;
    Y.applyUpdate(back, cached);
    x.casino.bindCasinoDoc(back);
    bound = back;
    await tick(x, arriveAfter);
    if (arriveAfter < 2_000) sync(back, y.doc);
    await tick(x, 4_000 - arriveAfter);
    sync(back, y.doc);
    expect({ onX: all(x), onY: all(y) }).toEqual({ onX: 1_100, onY: 1_100 });
  }, 30_000); // real-time awaits for the settle's hashing
});

describe("the coin pusher, a page back in the room on the room cache's copy", () => {
  for (const backClient of [3, 7]) for (const arriveAfter of [1_000, 4_000]) {
    it(`settles no drop the room settled while it was away (rejoined doc client ${backClient}, room state in after ${arriveAfter} ms)`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = 2_000_000_000;
      vi.setSystemTime(t0);
      const x = await loadPage(2);
      const y = await loadPage(5);
      let t = t0;
      const tick = (pg: Page, ms: number): void => {
        for (const end = t + ms; t <= end; t += 100) { vi.setSystemTime(t); pg.pusher.tickCoinPusherRoom([PUSHER], t); }
      };
      x.casino.buyInChips(BOB, 10);
      tick(x, 2_500); // x operates; the machine is made
      let s = x.casino.readCoinPusherState(PUSHER)!;
      for (let i = 0; i < 60; i++) s = x.game.processInsert(s, 'player-Carol', (i % 3) as 0 | 1 | 2, (i * 0.37) % 1, i * 7919).state;
      x.casino.writeCoinPusherState(PUSHER, s);
      const inside0 = x.game.chipsInMachine(s);
      // Bob drops a chip; x leaves the room before it settles (the cache keeps its doc).
      // main.ts leaveRoomNow: the lease is released, the sync flushed (up to
      // LEAVE_FLUSH_MS, the doc still taking updates: Bob's request lands),
      // and only then is the cache written.
      x.pusher.leaveCoinPusherRoom();
      expect(x.casino.readCoinPusherOperatorLease()).toBeNull();
      x.casino.writeCoinPusherRequest(PUSHER, { requestId: 'r1', player: BOB, hole: 1, phase: x.game.currentPusherPhase(s, t), requestedAt: t });
      tick(x, 500); // leaving: x operates nothing
      expect(x.casino.readCoinPusherResult(PUSHER, BOB)).toBeNull();
      const cached = Y.encodeStateAsUpdate(x.doc);
      sync(x.doc, y.doc);
      // y takes the pushers over and settles Bob's drop.
      tick(y, 4_000);
      expect(y.casino.readCoinPusherResult(PUSHER, BOB)?.requestId).toBe('r1');
      const total = (pg: Page): number => pg.casino.readChips(BOB) + pg.casino.readChips(OWNER) + pg.game.chipsInMachine(pg.casino.readCoinPusherState(PUSHER)!);
      expect(total(y)).toBe(10 + inside0);
      // x comes back on the cache's copy; the room's state isn't in yet.
      x.croupier.setRoomStateArrivedCheck(() => false);
      const back = new Y.Doc();
      back.clientID = backClient;
      Y.applyUpdate(back, cached);
      x.casino.bindCasinoDoc(back);
      tick(x, arriveAfter);
      if (arriveAfter < 2_000) sync(back, y.doc);
      tick(x, 4_000 - arriveAfter);
      // The room's state comes in.
      sync(back, y.doc);
      expect({ onX: total(x), onY: total(y), bob: y.casino.readChips(BOB) }).toEqual({ onX: 10 + inside0, onY: 10 + inside0, bob: 10 - 1 + (y.casino.readCoinPusherState(PUSHER)!.lastDrop?.player === BOB ? y.casino.readCoinPusherState(PUSHER)!.lastDrop!.paid : 0) });
    });
  }
});
