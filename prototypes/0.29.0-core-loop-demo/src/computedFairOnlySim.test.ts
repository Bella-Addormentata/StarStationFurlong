/**
 * 🧪🔒🌐 FAIR ONLY tables played end to end by many pages over the simulated
 * network (computedSim.ts; design §16.3, the steady 6c scenarios; PR 6c-5a-2):
 * the owner's page opens a game at each house table through the real opening
 * (computedTable switchFairOnlyOn, as the ⚙ card's line will press it), the
 * owner's node is the game's house (computedSimHouse: it joins, reveals, and
 * signs the checkpoints, which no page may), and the pages play on it.
 *
 * Each scenario ends in the shared finish of the roulette or the craps sims
 * (no violation, the room settles, every page agrees, the chips and the cage
 * add up, no flip, the budgets), and then what a FAIR ONLY game adds:
 *   - every round was decided by the house's reveal or, with the house away,
 *     voided: never by the bettors' seeds alone or a forfeit;
 *   - every base a page counted is the game's house's and honestly reachable
 *     (the checkpoint oracle, design §16.2: some honest page's own fold of
 *     the session it closes reached that round on that close with those nets,
 *     decided so, with that outcome, the carry and the next commitment);
 *   - no page wrote a checkpoint but the opening root (held while it runs);
 *   - no round was decided more than MAX_HELD_ROUNDS past a base (the same);
 *   - the pages agree on the base (in the finish's agreement);
 *   - the house's cross-check refused no trim.
 *
 * The cheats (junk, forgers, griefers) are computedFairOnlyCheats.test.ts.
 * Not here yet: sybils, the ends, transfers, two houses, migration back
 * (design §16.3's other 6c scenarios).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finish as crapsFinish, RUN_MS as CRAPS_RUN_MS, T as CRAPS, TIMEOUT as CRAPS_TIMEOUT } from './computedCrapsSimKit';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import { HOUSE_TRIM_ROUNDS } from './computedSimHouse';
import type { PageSpec } from './computedSim';
import { fairOnlyFinish, lines, rouletteFinish } from './computedFairOnlySimKit';

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

describe('FAIR ONLY roulette, end to end: the owner opens the game, the node is its house', () => {
  it('steady, heavy felts: the house decides every round and trims the session; every page counts from its checkpoints', async () => {
    const sim = await Sim.open({ name: 'fair-only', seed: seed(1201), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    const node = sim.node!;
    // The game opened as soon as the page's delegation was checked.
    expect(sim.opened.get(ROULETTE), sim.label).toBeLessThan(5_000);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(5);
    expect(s.voids, sim.label).toBe(0);
    // One join, at the game's first round; every commitment after it is
    // carried by its reveals and its checkpoints' `h`.
    expect(node.wrote.joins, sim.label).toBe(1);
    expect(node.refusals + node.blockedSeen, sim.label).toBe(0);
    expect(node.trims, sim.label).toBeGreaterThanOrEqual(3);
    expect(node.rowPutBacks + node.newSessions, sim.label).toBe(0);
  }, TIMEOUT);

  it('light felts: under no pressure the house leaves the session be, and the game plays on from its root (a long run trims on its rounds)', async () => {
    const sim = await Sim.open({ name: 'fair-only-light', seed: seed(1203), pages: named('ABC'), houseNode: true, fairOnly: true });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(4);
    expect(s.voids, sim.label).toBe(0);
    if (s.byHouse + s.voids < HOUSE_TRIM_ROUNDS) {
      expect(sim.node!.trims, sim.label).toBe(0);
      expect(s.maxSessionBytes, sim.label).toBeLessThan(sim.pages[0].p.table.TRIM_BYTES);
    } else {
      // (SIM_LONG: the session is long by its rounds alone.)
      expect(sim.node!.trims, sim.label).toBeGreaterThanOrEqual(1);
    }
  }, TIMEOUT);

  it('a page that comes late, after the house has trimmed, counts from the checkpoint it finds and plays on', async () => {
    const sim = await Sim.open({ name: 'fair-only-late', seed: seed(1204), pages: named('ABC'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    sim.at(100_000, () => sim.add({ name: 'L' }).then(() => undefined));
    await sim.run(RUN_MS);
    const trimsBefore = sim.node!.trims;
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    expect(trimsBefore, sim.label).toBeGreaterThanOrEqual(2);
    const late = sim.pages.find((sp) => sp.name === 'L')!;
    expect(late.writes.ok ?? 0, sim.label).toBeGreaterThan(0);
  }, TIMEOUT);

  it('the node goes down for 40 s twice: no round is decided without it (the round it left is voided), and it joins again', async () => {
    const sim = await Sim.open({ name: 'fair-only-outage', seed: seed(1205), pages: named('ABCD'), houseNode: true, fairOnly: true });
    for (const at of [40_000, 100_000]) {
      sim.at(at, () => { sim.nodeUp = false; });
      sim.at(at + 40_000, () => {
        sim.node!.restart();
        sim.nodeUp = true;
      });
    }
    // (What it had revealed when it came back the second time.)
    let revealsAtReturn = -1;
    sim.at(140_500, () => { revealsAtReturn = sim.node!.wrote.reveals; });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s);
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    expect(s.voids, sim.label).toBeLessThanOrEqual(4);
    expect(sim.node!.wrote.joins, sim.label).toBeGreaterThanOrEqual(2);
    // The table resumed: the house decided a round after its last return.
    expect(revealsAtReturn, sim.label).toBeGreaterThanOrEqual(0);
    expect(sim.node!.wrote.reveals, sim.label).toBeGreaterThan(revealsAtReturn);
  }, TIMEOUT);

  it("the owner's page reloads, and later sleeps for half a minute: the game is still the table's, and the house serves it again", async () => {
    const sim = await Sim.open({ name: 'fair-only-owner-away', seed: seed(1206), pages: named('ABCD'), houseNode: true, fairOnly: true });
    sim.at(60_000, () => sim.reload(sim.house));
    sim.at(110_000, () => sim.sleep(sim.house, false));
    sim.at(140_000, () => { if (sim.house.mode === 'asleep') sim.wake(sim.house); });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s);
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe('FAIR ONLY craps, end to end', () => {
  it('steady: the house decides every roll, its checkpoints carry the table (the point, the bets riding, the dice) and every page plays on from them', async () => {
    const sim = await Sim.open({ name: 'fair-only-craps', seed: seed(1202), pages: named('ABCD'), tables: [{ id: CRAPS, game: 'craps' }], houseNode: true, fairOnly: true });
    await sim.run(CRAPS_RUN_MS);
    const s = await crapsFinish(sim, lines, { basesKnown: true });
    fairOnlyFinish(sim, s);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(10);
    expect(s.voids, sim.label).toBe(0);
    expect(sim.node!.wrote.joins, sim.label).toBe(1);
    expect(sim.node!.trims, sim.label).toBeGreaterThanOrEqual(1);
    expect(sim.craps!.stats.basesChecked, sim.label).toBeGreaterThan(0);
  }, CRAPS_TIMEOUT);

  it('a roulette game and a craps game in one room, each at its own table: the house serves both', async () => {
    const sim = await Sim.open({
      name: 'fair-only-two', seed: seed(1207), pages: named('ABCD'), tables: [ROULETTE, { id: CRAPS, game: 'craps' }], houseNode: true, fairOnly: true,
    });
    await sim.run(CRAPS_RUN_MS);
    const s = await crapsFinish(sim, lines, { basesKnown: true });
    fairOnlyFinish(sim, s);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(20);
    expect(sim.node!.wrote.joins, sim.label).toBe(2);
  }, CRAPS_TIMEOUT);
});
