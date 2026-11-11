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
 * Not here yet: the cheats (junk, forgers, griefers, sybils), the ends,
 * transfers, two houses, migration back (design §16.3's other 6c scenarios).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finish as crapsFinish, RUN_MS as CRAPS_RUN_MS, T as CRAPS, TIMEOUT as CRAPS_TIMEOUT } from './computedCrapsSimKit';
import { isFairOnlyInc } from './computedFairOnly';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import { HOUSE_TRIM_ROUNDS } from './computedSimHouse';
import type { FlipKind, PageSpec, SimSummary } from './computedSim';

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
const lines: string[] = [];

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

/** computedSim.test.ts's budgets (a cold fold, a warm transaction, the quiet period). */
const COLD_FOLD_MS = 3 * 300;
const WARM_MS = 3 * 5;
const QUIET_MAX_MS = 120_000;

interface Finish {
  flips?: readonly FlipKind[];
  awayFlips?: readonly FlipKind[];
  /** The house is away for a while (the scenario's own doing): the table
   *  waits for it, so the roulette sims' stall budget is not held. */
  houseAway?: boolean;
}

/** The roulette sims' finish (computedSim.test.ts), for a room of roulette
 *  tables: the heal, the quiet period, everything synced, every shared
 *  assertion. The session's bound is the house's: it trims on what the fold
 *  used and on junk, a show after the round that took the session past either. */
async function rouletteFinish(sim: Sim, opts: Finish = {}): Promise<SimSummary> {
  const { table } = sim.pages[0].p;
  sim.heal();
  const quietMs = await sim.quiet(QUIET_MAX_MS);
  await sim.syncAll();
  sim.settleFlips();
  const s = sim.summary();
  const line = `${Sim.line(s, sim.worstStall.at)}\n${sim.robots.line()}`;
  lines.push(line);
  console.log(line);
  const log = sim.pages.flatMap((sp) => sp.flipLog.map((f) => `${sp.name} ${f}`));
  expect(sim.violations, sim.label).toEqual([]);
  expect(quietMs, sim.label).toBeLessThan(QUIET_MAX_MS);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) expect(sim.endProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  expect(sim.disagreements(), sim.label).toEqual([]);
  expect(sim.violations, sim.label).toEqual([]);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
    expect(sim.ledgerProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
    expect(sim.cageProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  }
  expect(s.maxDocBytes, sim.label).toBeLessThan(1_000_000);
  expect(s.maxSessionBytes, sim.label).toBeLessThanOrEqual(table.TRIM_BYTES + 2 * s.maxRoundBytes);
  // With its house there, a game stalls no longer than a house table does.
  if (!opts.houseAway) expect(s.worstStallMs, `${sim.label} ${sim.worstStall.at}`).toBeLessThanOrEqual(table.ABANDON_MS + 2 * table.GRACE_MAX_MS);
  expect(s.coldFoldMs, sim.label).toBeLessThan(COLD_FOLD_MS);
  expect(s.warmP95Ms, sim.label).toBeLessThan(WARM_MS);
  const allowed = new Set([...(opts.flips ?? []), ...(opts.awayFlips ?? [])]);
  const unexpected = sim.pages.flatMap((sp) => (Object.entries(sp.flipKinds) as [FlipKind, number][])
    .filter(([k]) => !allowed.has(k)).map(([k, n]) => `${sp.name}: ${n} × ${k}`));
  expect(unexpected, `${sim.label}\n${log.join('\n')}`).toEqual([]);
  expect(sim.unexplained(opts.awayFlips ?? []), `${sim.label}\n${log.join('\n')}`).toEqual([]);
  if (Object.values(s.flips).every((n) => n === 0)) expect([...sim.debts.values()], sim.label).toEqual([]);
  return s;
}

/** What a FAIR ONLY room adds to a finish (the header's list). */
function fairOnlyFinish(sim: Sim, s: SimSummary): void {
  const node = sim.node!;
  const line = `[fair only] ${sim.label}: opened ${JSON.stringify([...sim.opened])} (refused before: ${JSON.stringify(sim.openRefusals)}), `
    + `house ${JSON.stringify(node.wrote)} trims ${node.trims} put back: checkpoints ${node.rowPutBacks}, sessions ${node.newSessions}; `
    + `cross-check refusals ${node.crossCheckMismatches}, refused rounds ${node.refusals}, blocked closes ${node.blockedSeen}; bases held to the oracle ${sim.basesCounted}`;
  lines.push(line);
  console.log(line);
  expect([...sim.opened.keys()].sort(), sim.label).toEqual([...sim.tables].sort());
  // Every page up plays the game at every table.
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
    sim.enter(sp);
    for (const t of sim.tables) expect(isFairOnlyInc(sp.p.casino.computedIncOf(t)), `${sim.label} ${sp.name} ${t}`).toBe(true);
  }
  expect(s.byReveals + s.byForfeit, sim.label).toBe(0);
  expect(sim.gameProblems(), sim.label).toEqual([]);
  expect(node.crossCheckMismatches, sim.label).toBe(0);
  // Every checkpoint past the roots is one the house wrote, and the pages counted from them.
  expect(sim.houseCheckpoints, sim.label).toBe(node.trims);
  if (node.trims > 0) expect(sim.basesCounted, sim.label).toBeGreaterThan(0);
  expect(sim.basesCounted, sim.label).toBeLessThanOrEqual(node.trims);
}

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
