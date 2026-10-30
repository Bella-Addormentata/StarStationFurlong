/**
 * 🧪🎲🌐 Computed craps played by many pages over the simulated network
 * (computedSim.ts with computedCrapsSim.ts): the baseline. Four pages at one
 * computed craps table, a good network, clocks up to 5 s apart; every page's
 * player bets every one of the 19 bet types where the felt lets it (the odds
 * behind its flat bets, come odds behind a come bet that travelled), takes
 * spots down one at a time and all at once, moves between the stands, the
 * device front and off the table, and as the shooter throws the dice at a
 * time drawn into the 20 s wait (some past it: TIME'S UP); now and then it
 * tries what the table must refuse (a felt on a stale stamp, a contract bet
 * taken down or a pass put down with a point on, more chips than it has).
 * One page reloads in the middle of a roll's betting with a goodbye (a real
 * reload's pagehide), held to the goodbye oracle.
 *
 * Throughout, every decided roll each page folds is worked out afresh as a
 * chain from the session's base by the checker (computedCrapsSim: today's
 * owner-run rules from games/craps, its own reading of the design for the
 * stamp, the rule check, the room, a forfeit's cost, a void and the shooter;
 * the dice from the counted seeds), and the carries are held to the
 * invariants a craps table keeps. At the end the shared finish: no
 * violation, the room settles, every page agrees, the chips and the cage add
 * up, no flip, the stall and size budgets. Each seed prints the sim's line
 * and a craps line: rolls a minute next to an owner-run table's pace (its
 * 16 s window, the throw, its 6 s show), the coverage of the 19 types, the
 * tries refused and the shooter's numbers (run with --reporter=verbose).
 *
 * CI runs 10 simulated minutes a seed (3 minutes is ~5 rolls: too few to
 * reach the 19 types), then on a minute at a time until all 19 have been
 * placed and decided (10 minutes more at most); SIM_LONG=1 runs 30;
 * SIM_SEED=n moves every seed; SIM_CRAPS_MINUTES=n runs n.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sim } from './computedSim';
import { BET_TYPES } from './computedCrapsSim';
import { MINUTES, RUN_MS, T, TIMEOUT, finish, named, ownerRunPace, reloadMidBet, seed } from './computedCrapsSimKit';
import type { CrapsBetType } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The most a seed runs on past RUN_MS for the 19 types' coverage. */
const EXTRA_MS = 10 * 60_000;
const lines: string[] = [];

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

// ── The baseline ─────────────────────────────────────────────────────────────

describe('computed craps: the baseline', () => {
  for (const n of [1, 2, 3]) {
    it(`baseline seed ${n}: 4 pages, a good network, clocks up to 5 s apart, every bet type, stands, throws, tries`, async () => {
      const sim = await Sim.open({ name: 'craps-baseline', seed: seed(100 + n), pages: named('ABCD'), tables: [{ id: T, game: 'craps' }] });
      const craps = sim.craps!;
      reloadMidBet(sim, sim.pages[1], Math.floor(RUN_MS / 2));
      await sim.run(RUN_MS);
      // Then on, a minute at a time, until every type has been placed and
      // won or lost (the dice decide when a bet that needs a point and a
      // flat bet first, the line's odds above all, is decided: 10 minutes is
      // ~18 rolls), EXTRA_MS at most.
      const short = (): CrapsBetType[] => BET_TYPES.filter((t) => craps.coverage.get(t)!.placed === 0 || craps.coverage.get(t)!.decided === 0);
      for (let extra = 0; extra < EXTRA_MS && short().length > 0; extra += 60_000) await sim.run(60_000);
      // (A reload with a goodbye: its page's felt goes as a goodbye, played
      // as the riding bets, and the new load bets again on the same roll:
      // the timing rules hold it as any felt, no extra.)
      const s = await finish(sim, lines, { basesKnown: true });
      const st = craps.stats;
      // It rolled: no stall, no void, no forfeit on a good network. And at
      // an owner-run table's pace over the same throws (the design's
      // baseline: "rolls per minute stay close to owner-run"), within 10%.
      expect(s.rounds, sim.label).toBeGreaterThanOrEqual(Math.floor(MINUTES * 1.2));
      expect(s.rounds / (sim.elapsed / 60_000), sim.label).toBeGreaterThanOrEqual(0.9 * ownerRunPace(sim, craps).perMin);
      expect(s.voids, sim.label).toBe(0);
      expect(s.byForfeit, sim.label).toBe(0);
      // Every roll checked by the chain, on every page.
      expect(st.rollsChecked, sim.label).toBeGreaterThanOrEqual(s.rounds);
      // The player did what a player does: places and odds, take-downs one
      // spot and all at once, lists merged and a chip a record, stand moves.
      expect(st.places, sim.label).toBeGreaterThan(0);
      expect(st.odds, sim.label).toBeGreaterThan(0);
      expect(st.takeOne, sim.label).toBeGreaterThan(0);
      expect(st.takeAll, sim.label).toBeGreaterThan(0);
      expect(st.perChipLists, sim.label).toBeGreaterThan(0);
      expect(st.standMoves, sim.label).toBeGreaterThan(0);
      // The shooters threw, at delays over the whole wait and past it.
      expect(st.flings, sim.label).toBeGreaterThan(0);
      expect(st.delays.some((d) => d > 20_000), sim.label).toBe(true);
      expect(st.timesUp, sim.label).toBeGreaterThan(0);
      // The deliberate tries, each refused as it must be (an 'ok' or another
      // answer is a violation, above). 'full' needs 31 other players: the
      // ghosts scenario's (computedCrapsSimRoom.test.ts).
      for (const kind of ['stale', 'contract', 'contract-part', 'line', 'dontpass-up', 'come-number', 'dontcome-number', 'over']) {
        expect(craps.tries[kind] ?? 0, `${sim.label} ${kind}`).toBeGreaterThan(0);
      }
      // What the pages wrote on their own was held to what it may say (ride
      // slips, stand rewrites, flushes, goodbyes), riders were seen at the
      // table with betting open (the rider oracle), honest odds held to the
      // cap, no walk stopped short.
      expect(st.ownSlips, sim.label).toBeGreaterThan(0);
      expect(st.ridersSeen, sim.label).toBeGreaterThan(0);
      expect(st.oddsCapped, sim.label).toBeGreaterThan(0);
      expect(st.stops, sim.label).toEqual({});
      // The reload's goodbye, as due.
      expect(st.goodbyes, sim.label).toBeGreaterThan(0);
      // Every one of the 19 bet types placed and paid or lost on this seed.
      expect(short(), sim.label).toEqual([]);
    }, TIMEOUT);
  }
});

// ── 🏠 The house (PR 5) ──────────────────────────────────────────────────────

describe("computed craps with the house: the owner's node adds its seed to the rolls (computedSimHouse)", () => {
  it('house seed 1: the node runs, goes down for 70 s at 4 minutes and restarts; the roll it left goes void, the rolls run Friendly, then it joins again', async () => {
    const sim = await Sim.open({ name: 'craps-house', seed: seed(901), pages: named('ABCD'), tables: [{ id: T, game: 'craps' }], houseNode: true });
    const craps = sim.craps!;
    sim.at(240_000, () => { sim.nodeUp = false; });
    sim.at(310_000, () => {
      sim.node!.restart();
      sim.nodeUp = true;
    });
    await sim.run(RUN_MS);
    const s = await finish(sim, lines, { basesKnown: true });
    const node = sim.node!;
    // The house's reveal decided the rolls either side of the outage, the
    // bettors' seeds the Friendly ones while it was away; at most the roll
    // whose close named it, and the one it may have joined just as it went,
    // void.
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    expect(s.byReveals, sim.label).toBeGreaterThan(0);
    expect(s.byForfeit, sim.label).toBe(0);
    expect(s.voids, sim.label).toBeGreaterThanOrEqual(1);
    expect(s.voids, sim.label).toBeLessThanOrEqual(2);
    expect(node.wrote.joins, sim.label).toBeGreaterThanOrEqual(2);
    expect(node.refusals + node.blockedSeen, sim.label).toBe(0);
    expect(craps.stats.rollsChecked, sim.label).toBeGreaterThanOrEqual(s.rounds);
  }, TIMEOUT);
});
