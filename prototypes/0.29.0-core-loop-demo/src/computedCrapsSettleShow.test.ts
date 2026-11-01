/**
 * 💰 The settle's chip moves at a COMPUTED craps table (nobody runs it: each
 * page shows the fold of the players' records), on two pages: both play the
 * same moves from the shared result, once a roll (losers into the house,
 * the winner paid out of it onto their rail), and the winner's rail shows
 * the payout only once its chips have landed there.
 *
 * Built on the kits computedCrapsTable.test.ts uses (computedPageKit,
 * computedCrapsUiKit): each page its own load of the casino modules, synced
 * by hand, every clock explicit, its dice chosen through the seeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockOf, CRAPS_INC as INC, CRAPS_REF as REF, CRAPS_TABLE as TABLE, rigRoll, switchOn, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { atCraps, loadUIPage, stubDom } from './computedCrapsUiKit';
import type { UIPage } from './computedCrapsUiKit';
import type { RailStack, SettleMoves } from './casinoTable3d';

stubDom();

const T0 = 2_000_000_000;
const STEP = 200;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function room(names: string[]): Promise<UIPage[]> {
  const pages: UIPage[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadUIPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  switchOn(pages[0], TABLE, INC);
  sync(T0, ...pages);
  return pages;
}

/** One frame of page p at T, as computedCrapsTable.test.ts runs one. */
function frameOf(p: UIPage, T: number): void {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  p.table.tickComputedTables([REF], now);
  p.session.casinoTablesFrame(1 / 60, new Map([[TABLE, p.dice.h]]));
  p.at?.update();
}

function go(pages: UIPage[], from: number, to: number, until?: () => boolean): number {
  for (let T = from; T <= to; T += STEP) {
    sync(T, ...pages);
    for (const p of pages) frameOf(p, T);
    sync(T, ...pages);
    if (until?.()) return T;
  }
  return to + STEP;
}

const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const railTotal = (rail: readonly RailStack[]): number => rail.reduce((a, s) => a + s.denom * s.count, 0);

/** A settle's moves with whose-screen-it-is taken out: what every page
 *  must agree on. */
const shared = (m: SettleMoves) => ({
  house: m.house,
  lost: m.lost.map(({ x, z, chips, pid, spot, lift }) => ({ x, z, chips, pid, spot, lift })),
  back: m.back.map(({ s, to, order }) => ({ x: s.x, z: s.z, chips: s.chips, pid: s.pid, spot: s.spot, to, order })),
  paid: m.paid.map(({ chips, to, order }) => ({ chips, to, order })),
});

describe('💰 the settle on screen at a computed craps table', () => {
  it('both pages play the same moves once: B’s don’t pass to the house, A’s pass line back with its winnings; A’s rail grows as they land', async () => {
    const pages = await room(['A', 'B']);
    const [a, b] = pages;
    const ta = atCraps(a, { stand: 3 });
    const tb = atCraps(b, { stand: 1 });
    go(pages, T0, T0 + STEP);
    rigRoll(pages, 1, 7);
    ta.pick('2', 2);
    ta.click('pass');
    tb.pick('2');
    tb.click('dontpass');
    // Up to the roll's result on both pages, A's rail as it shows then.
    let railBefore = -1;
    const at = go(pages, T0 + 2 * STEP, T0 + 120_000, () => {
      const decided = pages.every((p) => foldOf(p).rounds.some((v) => v.r === 1 && v.decided !== null));
      if (!decided && a.dice.settles.length === 0) railBefore = railTotal(a.dice.rail());
      return a.dice.settles.length > 0 && b.dice.settles.length > 0;
    });
    expect(at).toBeLessThan(T0 + 120_000);
    expect(a.dice.settles).toHaveLength(1);
    expect(b.dice.settles).toHaveLength(1);
    const [ma] = a.dice.settles;
    const [mb] = b.dice.settles;
    expect(shared(ma)).toEqual(shared(mb));
    expect(ma.lost.map((s) => [s.pid, s.spot, s.chips])).toEqual([[b.pid, 'dontpass:', [5]]]);
    expect(ma.back.map((x) => [x.s.pid, x.s.spot, x.s.chips])).toEqual([[a.pid, 'pass:', [5, 5]]]);
    expect(ma.paid.map((x) => x.chips)).toEqual([[5, 5]]);
    // Whose screen: A's chips are A's own on A's page, another's on B's.
    expect([ma.back[0].mine, ma.paid[0].mine, ma.paid[0].dim]).toEqual([true, true, false]);
    expect([mb.back[0].mine, mb.paid[0].mine, mb.paid[0].dim]).toEqual([false, false, true]);
    expect(ma.lost[0].dim).toBe(true);
    expect(mb.lost[0].dim).toBe(false);
    // A's rail holds what it had while the chips are on the way…
    expect(railBefore).toBeGreaterThan(0);
    expect(railTotal(a.dice.rail())).toBe(railBefore);
    // …and takes them once they've landed (the pieces' pay-out done).
    go(pages, at + STEP, at + 3 * STEP);
    expect(railTotal(a.dice.rail())).toBe(railBefore + 20);
    // Nothing plays twice, however long the show runs.
    go(pages, at + 4 * STEP, at + 10_000);
    expect(a.dice.settles).toHaveLength(1);
    expect(b.dice.settles).toHaveLength(1);
    ta.unmount();
    tb.unmount();
  });
});
