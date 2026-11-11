/**
 * 🧪🔒 What the FAIR ONLY simulations share (computedFairOnlySim.test.ts, the
 * steady scenarios; computedFairOnlyCheats.test.ts, the cheats): the roulette
 * sims' finish for a room of games, and what a FAIR ONLY room adds to one.
 */

import { expect } from 'vitest';
import { isFairOnlyInc } from './computedFairOnly';
import { Sim } from './computedSim';
import type { FlipKind, SimSummary } from './computedSim';

/** Each scenario's summary line, printed again once the file is done. */
export const lines: string[] = [];


/** computedSim.test.ts's budgets (a cold fold, a warm transaction, the quiet period). */
const COLD_FOLD_MS = 3 * 300;
const WARM_MS = 3 * 5;
const QUIET_MAX_MS = 120_000;

export interface Finish {
  flips?: readonly FlipKind[];
  awayFlips?: readonly FlipKind[];
  /** The house is away for a while (the scenario's own doing): the table
   *  waits for it, so the roulette sims' stall budget is not held. */
  houseAway?: boolean;
  /** Bytes of junk a cheat lays into a session at a time: the session's bound
   *  is the house's, on what the fold used, and junk lies there until its
   *  next trim or sweep. */
  junk?: number;
}

/** The roulette sims' finish (computedSim.test.ts), for a room of roulette
 *  tables: the heal, the quiet period, everything synced, every shared
 *  assertion. The session's bound is the house's: it trims on what the fold
 *  used and on junk, a show after the round that took the session past either. */
export async function rouletteFinish(sim: Sim, opts: Finish = {}): Promise<SimSummary> {
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
  expect(s.maxSessionBytes, sim.label).toBeLessThanOrEqual(table.TRIM_BYTES + 2 * s.maxRoundBytes + (opts.junk ?? 0));
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
export function fairOnlyFinish(sim: Sim, s: SimSummary): void {
  const node = sim.node!;
  const line = `[fair only] ${sim.label}: opened ${JSON.stringify([...sim.opened])} (refused before: ${JSON.stringify(sim.openRefusals)}), `
    + `house ${JSON.stringify(node.wrote)} trims ${node.trims} sweeps ${node.sweeps} put back: checkpoints ${node.rowPutBacks}, sessions ${node.newSessions}; `
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
  expect(sim.houseCheckpoints, sim.label).toBe(node.trims + node.sweeps);
  if (node.trims > 0) expect(sim.basesCounted, sim.label).toBeGreaterThan(0);
  expect(sim.basesCounted, sim.label).toBeLessThanOrEqual(node.trims + node.sweeps);
}
