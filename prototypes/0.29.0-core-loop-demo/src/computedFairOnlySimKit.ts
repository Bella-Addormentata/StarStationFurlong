/**
 * 🧪🔒 What the FAIR ONLY simulations share (computedFairOnlySim.test.ts, the
 * steady scenarios; computedFairOnlyCheats.test.ts, the cheats): the roulette
 * sims' finish for a room of games, and what a FAIR ONLY room adds to one.
 */

import { expect } from 'vitest';
import { isFairOnlyInc } from './computedFairOnly';
import { Sim } from './computedSim';
import type { FlipKind, SimPage, SimSummary } from './computedSim';

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
export function fairOnlyFinish(sim: Sim, s: SimSummary, ended: readonly string[] = []): void {
  // (The owner's node, and after a hand-over the buyer's with it: what the two did, together.)
  const nodes = [sim.node!, ...(sim.node2 ? [sim.node2] : [])];
  const sum = (of: (n: typeof nodes[number]) => number): number => nodes.reduce((a, n) => a + of(n), 0);
  const node = {
    wrote: nodes.length === 1 ? nodes[0].wrote : nodes.map((n) => n.wrote), trims: sum((n) => n.trims), sweeps: sum((n) => n.sweeps), ends: sum((n) => n.ends),
    rowPutBacks: sum((n) => n.rowPutBacks), newSessions: sum((n) => n.newSessions), crossCheckMismatches: sum((n) => n.crossCheckMismatches),
    refusals: sum((n) => n.refusals), blockedSeen: sum((n) => n.blockedSeen),
  };
  const line = `[fair only] ${sim.label}: opened ${JSON.stringify([...sim.opened])} (refused before: ${JSON.stringify(sim.openRefusals)}), `
    + `house ${JSON.stringify(node.wrote)} trims ${node.trims} sweeps ${node.sweeps} put back: checkpoints ${node.rowPutBacks}, sessions ${node.newSessions}; `
    + `cross-check refusals ${node.crossCheckMismatches}, refused rounds ${node.refusals}, blocked closes ${node.blockedSeen}; `
    + `ends: the house's ${node.ends}, the holder's ${sim.ownerEndsWritten}; bases held to the oracle ${sim.basesCounted}${sim.buyer ? `; handed over to ${sim.buyer.name}, adoptions ${sim.adoptionsWritten}` : ''}`;
  lines.push(line);
  console.log(line);
  expect([...sim.opened.keys()].sort(), sim.label).toEqual([...sim.tables].sort());
  // Every page up plays the game at every table.
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
    sim.enter(sp);
    // (…but a table whose game its holder ended: `ended`. That plays none.)
    for (const t of sim.tables) {
      if (ended.includes(t)) expect(sp.p.casino.isComputedTable(t), `${sim.label} ${sp.name} ${t}`).toBe(false);
      else expect(isFairOnlyInc(sp.p.casino.computedIncOf(t)), `${sim.label} ${sp.name} ${t}`).toBe(true);
    }
  }
  expect(s.byReveals + s.byForfeit, sim.label).toBe(0);
  expect(sim.gameProblems(), sim.label).toEqual([]);
  expect(node.crossCheckMismatches, sim.label).toBe(0);
  // Every checkpoint past the roots is one the house wrote, and the pages counted from them.
  // (…or an end: the house's, or one the game's holder signed on its own page.)
  expect(sim.houseCheckpoints, sim.label).toBe(node.trims + node.sweeps + node.ends);
  if (node.trims > 0) expect(sim.basesCounted, sim.label).toBeGreaterThan(0);
  expect(sim.basesCounted, sim.label).toBeLessThanOrEqual(node.trims + node.sweeps + node.ends + sim.ownerEndsWritten + sim.adoptionsWritten);
  // One end to a game that ended, and none to one that plays.
  expect(node.ends + sim.ownerEndsWritten, sim.label).toBe(ended.length);
}

/** The holder's press at table `t`, on every tick from `from` ms into the run
 *  while `when()` (and, at craps, a second press after 'contract') until it
 *  answers 'ok'; with `once`, no press after one that answered 'ending' (the
 *  end is then the house's, or the page's own duty's). What each press
 *  answered, in order without repeats, and when the first one was made and
 *  the game was over on the holder's page; and how many presses were refused
 *  for contract bets riding. */
export function pressEnd(sim: Sim, t: string, game: 'roulette' | 'craps', from: number, when: () => boolean = () => true, once = false, by: () => SimPage = () => sim.house): { said: string[]; first: number | null; over: number | null; contracts: number } {
  const out: { said: string[]; first: number | null; over: number | null; contracts: number } = { said: [], first: null, over: null, contracts: 0 };
  let go = false;
  let again = false;
  let done = false;
  sim.at(from, () => { go = true; });
  sim.every(() => {
    const house = by();
    const now = sim.enter(house);
    if (go && out.over === null && out.first !== null && !house.p.casino.isComputedTable(t)) out.over = sim.elapsed;
    if (!go || done || house.mode !== 'up') return;
    if (out.first === null && !when()) return;
    const res = house.p.table.switchFairOnlyOff(t, game, now, again);
    if (out.first === null) out.first = sim.elapsed;
    if (out.said[out.said.length - 1] !== res) out.said.push(res);
    if (res === 'contract') {
      again = true;
      out.contracts += 1;
    }
    if (res === 'ending' && once) done = true;
    if (res === 'ok') {
      done = true;
      if (!house.p.casino.isComputedTable(t)) out.over = sim.elapsed;
    }
  });
  return out;
}

/** Whether a round of the game at `t` is in flight on the holder's page. */
export function inFlight(sim: Sim, t: string): boolean {
  const res = sim.house.p.casino.computedFoldOf(t);
  return !!res && !res.pending && (res.tip !== null || res.openCloses.some((c) => c.state !== 'invalid'));
}
