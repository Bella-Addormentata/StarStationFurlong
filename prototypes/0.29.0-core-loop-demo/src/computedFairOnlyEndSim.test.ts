/**
 * 🧪🔒🌐 The end of a FAIR ONLY game, end to end over the simulated network
 * (computedSim.ts; design §8.6, §8.5 N6; PR 6c-5b-1): the page that holds a
 * game ends it through the real press (computedTable switchFairOnlyOff, as
 * the ⚙ card's line will), and the game is over on every page with every
 * decided round counted and every chip where the folds put it.
 *
 * Each scenario ends in the shared finish (computedFairOnlySimKit), with the
 * ended tables named: no page plays a game there, exactly one ended
 * checkpoint was written for each (the holder's own, or its house's), and the
 * oracle holds that checkpoint to the honest pages' folds as it does a trim.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finish as crapsFinish, RUN_MS as CRAPS_RUN_MS, T as CRAPS, TIMEOUT as CRAPS_TIMEOUT } from './computedCrapsSimKit';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import type { PageSpec } from './computedSim';
import { fairOnlyFinish, inFlight, lines, pressEnd, rouletteFinish } from './computedFairOnlySimKit';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RUN_MS = SIM_MINUTES * 60_000;
const TIMEOUT = SIM_LONG ? 1_800_000 : 300_000;
const ROULETTE = 'roulette-1';
const seed = (n: number): number => n + SIM_SEED_OFFSET;
const named = (names: string, extra: Partial<PageSpec> = {}): PageSpec[] => names.split('').map((name) => ({ name, ...extra }));
afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

describe('FAIR ONLY roulette: the holder ends the game', () => {
  it('pressed while a round is in flight: the end order alone, the house decides the round, and its end counts it', async () => {
    const sim = await Sim.open({ name: 'fair-only-end-mid', seed: seed(1301), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const end = pressEnd(sim, ROULETTE, 'roulette', 60_000, () => inFlight(sim, ROULETTE), true);
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s, [ROULETTE]);
    expect(end.said, sim.label).toEqual(['ending']);
    expect(sim.node!.ends, sim.label).toBe(1);
    expect(sim.ownerEndsWritten, sim.label).toBe(0);
    expect(s.voids, sim.label).toBe(0);
    // Over within the round's reveal and the house's wait after it.
    expect(end.over! - end.first!, sim.label).toBeLessThan(20_000);
  }, TIMEOUT);

  it('pressed again once the round is decided: the second press ends the game at once, on the holder\'s page', async () => {
    const sim = await Sim.open({ name: 'fair-only-end-twice', seed: seed(1307), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const end = pressEnd(sim, ROULETTE, 'roulette', 60_000, () => inFlight(sim, ROULETTE));
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s, [ROULETTE]);
    expect(end.said, sim.label).toEqual(['ending', 'ok']);
    expect(sim.node!.ends + sim.ownerEndsWritten, sim.label).toBe(1);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it('pressed on a quiet table: over in the one write, the holder its signer, and the house writes nothing more', async () => {
    const sim = await Sim.open({ name: 'fair-only-end-quiet', seed: seed(1303), pages: named('ABC'), houseNode: true, fairOnly: true });
    sim.at(50_000, () => { for (const sp of sim.pages) sp.betting = false; });
    const end = pressEnd(sim, ROULETTE, 'roulette', 60_000, () => !inFlight(sim, ROULETTE));
    let trims = -1;
    sim.at(RUN_MS - 1_000, () => { trims = sim.node!.trims + sim.node!.sweeps; });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s, [ROULETTE]);
    expect(end.said, sim.label).toEqual(['ok']);
    expect(end.over, sim.label).toBe(end.first);
    expect(sim.ownerEndsWritten, sim.label).toBe(1);
    expect(sim.node!.ends, sim.label).toBe(0);
    expect(sim.node!.trims + sim.node!.sweeps, sim.label).toBe(trims);
  }, TIMEOUT);

  it("the house away at the press, a round in flight: the bettors void it, and the holder's own page writes the end", async () => {
    const sim = await Sim.open({ name: 'fair-only-end-away', seed: seed(1305), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    let down = false;
    sim.every(() => {
      // (Down the moment a close is in, from a minute into the run.)
      if (down || sim.elapsed < 60_000 || !inFlight(sim, ROULETTE)) return;
      sim.nodeUp = false;
      down = true;
    });
    const end = pressEnd(sim, ROULETTE, 'roulette', 60_000, () => down, true);
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s, [ROULETTE]);
    expect(end.said, sim.label).toEqual(['ending']);
    expect(end.over, sim.label).not.toBeNull();
    expect(sim.ownerEndsWritten, sim.label).toBe(1);
    expect(sim.node!.ends, sim.label).toBe(0);
    expect(s.voids, sim.label).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);
});

describe('FAIR ONLY craps: the holder ends the game', () => {
  it('with bets riding: refused once, ended on the second press, and every chip riding is its player’s again', async () => {
    const sim = await Sim.open({ name: 'fair-only-end-craps', seed: seed(1311), pages: named('ABCD'), tables: [{ id: CRAPS, game: 'craps' }], houseNode: true, fairOnly: true });
    // (Pressed once a contract bet rides on the holder's page: a pass with
    // the point on, or a come bet gone to its number.)
    const rides = (): boolean => {
      const carry = sim.house.p.casino.computedFoldOf(CRAPS)?.carry as { p: number; w: Record<string, { type: string; pick?: number }[]> } | null | undefined;
      return !!carry && Object.values(carry.w).some((bets) => bets.some((b) => (b.type === 'pass' && carry.p !== 0) || (b.type === 'come' && b.pick !== undefined)));
    };
    const end = pressEnd(sim, CRAPS, 'craps', 60_000, rides);
    await sim.run(CRAPS_RUN_MS);
    const s = await crapsFinish(sim, lines, { basesKnown: true });
    fairOnlyFinish(sim, s, [CRAPS]);
    expect(end.said[0], sim.label).toBe('contract');
    // (Once: the second press is the warning's answer.)
    expect(end.contracts, sim.label).toBe(1);
    expect(end.said[end.said.length - 1], sim.label).toBe('ok');
    expect(end.over, sim.label).not.toBeNull();
  }, CRAPS_TIMEOUT);
});
