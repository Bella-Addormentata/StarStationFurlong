/**
 * 🧪🎲🌐 The craps simulation specs' shared finish (computedCrapsSim*.test.ts):
 * the heal, the quiet period, everything synced, then every assertion the
 * craps scenarios share, with the stall budgets by phase; and the craps
 * line each seed prints. A test kit: no app code imports it.
 */

import { expect } from 'vitest';
import { Sim, SIM_LONG, SIM_SEED_OFFSET } from './computedSim';
import type { FlipKind, PageSpec, SimPage, SimSummary } from './computedSim';
import { BET_TYPES } from './computedCrapsSim';
import type { CrapsHarness } from './computedCrapsSim';

/** (SIM_CRAPS_MINUTES=n runs n minutes a seed: a quick look while debugging.) */
export const MINUTES = Number(process.env.SIM_CRAPS_MINUTES ?? 0) || (SIM_LONG ? 30 : 10);
export const RUN_MS = MINUTES * 60_000;
/** A seed takes 20-60 s of wall time here alone; a slow CI runner, with the
 *  suite's other workers, many times that. */
export const TIMEOUT = SIM_LONG ? 3_600_000 : 900_000;
export const T = 'craps-1';
export const seed = (n: number): number => n + SIM_SEED_OFFSET;
export const named = (names: string, extra: Partial<PageSpec> = {}): PageSpec[] => names.split('').map((name) => ({ name, ...extra }));

/** The budgets computedSim.test.ts holds roulette to (a cold fold under
 *  300 ms, a warm transaction under 5 ms, CPU time, a CI margin of 3). */
const COLD_FOLD_MS = 3 * 300;
const WARM_MS = 3 * 5;
const QUIET_MAX_MS = 120_000;

export interface Finish {
  flips?: readonly FlipKind[];
  awayFlips?: readonly FlipKind[];
  /** Over the felts' stall budget, by the scenario's own rule (named in
   *  its spec): a crash or another tab (GRACE_MAX_MS, closeDue), a roll
   *  re-armed or re-shown (a window more), a seed out (ABANDON_MS). */
  feltsExtraMs?: number;
  tipExtraMs?: number;
  /** The checkpoints every page folds are all ones the checker played the
   *  close of (no scenario writes one by hand). */
  basesKnown?: boolean;
  /** Pages that bet (the close turns, n); default every page. */
  bettors?: number;
  /** Planned throws cut short by a close before the holder's wait was
   *  over may happen, by the scenario's own rule (named in its spec). */
  preemptedOk?: boolean;
}

/** The stall budgets at craps by phase (computedSim worstStallBy), from the
 *  timing rules (computedTable crapsCloseDue, closeDue):
 *  - felts, no close in: a felt goes down as betting opens at the earliest,
 *    the window runs CRAPS_BET_WINDOW_MS, the wait for the throw
 *    CRAPS_SHOOTER_MS at most (D), then the turns: every other page's from
 *    D + (1 + after)·STAGGER_MS, a page whose own felt changed late after
 *    every turn (n more), a frame's and the network's slack;
 *  - tip, a close in: its seeds by the grace (GRACE_MAX_MS at most) and a
 *    forfeit's answer, or the abandon (ABANDON_MS) on a seed that never
 *    comes, a grace each side for a page that heard the close late. */
export function crapsStallBudget(sim: Sim, n: number): { felts: number; tip: number } {
  const { table, croupier } = sim.pages[0].p;
  return {
    felts: croupier.CRAPS_BET_WINDOW_MS + croupier.CRAPS_SHOOTER_MS + (2 * n + 1) * table.STAGGER_MS + 1_000,
    tip: table.ABANDON_MS + 2 * table.GRACE_MAX_MS,
  };
}

/** The heal, the quiet period, everything synced; then every assertion the
 *  craps scenarios share (computedSim.test.ts finish, with craps's stall
 *  budgets by phase, the checker's final walk, its dice checks awaited).
 *  The run's numbers, printed on two lines. */
export async function finish(sim: Sim, lines: string[], opts: Finish = {}): Promise<SimSummary> {
  const { table } = sim.pages[0].p;
  const craps = sim.craps!;
  sim.heal();
  const quietMs = await sim.quiet(QUIET_MAX_MS);
  await sim.syncAll();
  sim.settleFlips();
  // The checker's last walk: every up page's fold of each craps table to its
  // end, its screen checked; then every dice check under way.
  const unwalked = craps.finalCheck();
  await Promise.all(sim.pocketChecks.splice(0));
  const s = sim.summary();
  const budget = crapsStallBudget(sim, opts.bettors ?? sim.pages.length);
  const line = `${Sim.line(s, sim.worstStall.at)}\n${crapsLine(sim, s, craps, quietMs, budget)}`;
  lines.push(line);
  console.log(line);
  const log = sim.pages.flatMap((sp) => sp.flipLog.map((f) => `${sp.name} ${f}`));
  if (process.env.SIM_DEBUG) console.log(log.join('\n'));
  // No invariant broke while it ran: every roll worked out afresh and held
  // to the craps invariants, every player's chips against a cold fold, the
  // shooter's throws, every answer to a deliberate try, the goodbyes, every
  // slip version a page wrote on its own, the close's timing, the screens.
  expect(sim.violations, sim.label).toEqual([]);
  expect(unwalked, sim.label).toEqual([]);
  expect(quietMs, sim.label).toBeLessThan(QUIET_MAX_MS);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) expect(sim.endProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  expect(sim.disagreements(), sim.label).toEqual([]);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
    expect(sim.ledgerProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
    expect(sim.cageProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  }
  expect(s.maxDocBytes, sim.label).toBeLessThan(1_000_000);
  expect(s.maxSessionBytes, sim.label).toBeLessThanOrEqual(table.TRIM_BYTES + s.maxRoundBytes);
  const { felts, tip } = sim.worstStallBy;
  expect(felts.ms, `${sim.label} felts ${felts.at}`).toBeLessThanOrEqual(budget.felts + (opts.feltsExtraMs ?? 0));
  expect(tip.ms, `${sim.label} tip ${tip.at}`).toBeLessThanOrEqual(budget.tip + (opts.tipExtraMs ?? 0));
  expect(s.coldFoldMs, sim.label).toBeLessThan(COLD_FOLD_MS);
  expect(s.warmP95Ms, sim.label).toBeLessThan(WARM_MS);
  const allowed = new Set([...(opts.flips ?? []), ...(opts.awayFlips ?? [])]);
  const unexpected = sim.pages.flatMap((sp) => (Object.entries(sp.flipKinds) as [FlipKind, number][])
    .filter(([k]) => !allowed.has(k)).map(([k, n]) => `${sp.name}: ${n} × ${k}`));
  expect(unexpected, `${sim.label}\n${log.join('\n')}`).toEqual([]);
  expect(sim.unexplained(opts.awayFlips ?? []), `${sim.label}\n${log.join('\n')}`).toEqual([]);
  if (Object.values(s.flips).every((n) => n === 0)) expect([...sim.debts.values()], sim.label).toEqual([]);
  // The checker ran: rolls worked out, each fold's holds checked, the close
  // timed against the wait, the screens compared; every checkpoint a trim
  // wrote held to the close it names; no planned throw cut short.
  const st = craps.stats;
  expect(st.rollsChecked, sim.label).toBeGreaterThan(0);
  expect(st.heldChecked, sim.label).toBeGreaterThan(0);
  expect(st.closesChecked, sim.label).toBeGreaterThan(0);
  expect(st.viewsChecked, sim.label).toBeGreaterThan(0);
  if (s.trims > 0) expect(st.basesChecked, sim.label).toBeGreaterThan(0);
  if (opts.basesKnown) expect(st.basesUnchecked, sim.label).toBe(0);
  if (!opts.preemptedOk) expect(st.preempted, `${sim.label} ${craps.preemptLog.join('; ')}`).toBe(0);
  return s;
}

/** An owner-run table's pace (rolls a minute) over the run's throws: its
 *  16 s window, then the throw (each planned delay, the 20 s wait at most),
 *  then its 6 s show; and the mean throw it took. */
export function ownerRunPace(sim: Sim, craps: CrapsHarness): { perMin: number; meanThrow: number } {
  const thrown = craps.stats.delays.map((d) => Math.min(d, 20_000));
  const meanThrow = thrown.length ? thrown.reduce((a, b) => a + b, 0) / thrown.length : 0;
  // (The owner-run table's window and show: croupier.ts, as crapsCroupier runs them.)
  const { CRAPS_BET_WINDOW_MS, CRAPS_SHOW_MS } = sim.pages[0].p.croupier;
  return { perMin: 60_000 / (CRAPS_BET_WINDOW_MS + meanThrow + CRAPS_SHOW_MS), meanThrow };
}

/** The craps side's numbers on one line. Rolls a minute against an
 *  owner-run table's pace over the same throws (ownerRunPace). */
export function crapsLine(sim: Sim, s: SimSummary, craps: CrapsHarness, quietMs: number, budget: { felts: number; tip: number }): string {
  const st = craps.stats;
  const minutes = sim.elapsed / 60_000;
  const { perMin: ownerPace, meanThrow } = ownerRunPace(sim, craps);
  const cov = BET_TYPES.map((t) => `${t} ${craps.coverage.get(t)!.placed}/${craps.coverage.get(t)!.decided}`).join(', ');
  const { felts, tip } = sim.worstStallBy;
  return `[craps] ${s.name} seed=${s.seed}: rolls=${s.rounds} ${(s.rounds / minutes).toFixed(2)}/min (owner-run pace ${ownerPace.toFixed(2)}/min: `
    + `16 s + throw ${(meanThrow / 1000).toFixed(1)} s + 6 s) checked=${st.rollsChecked} memo=${st.memoHits} bases=${st.basesChecked}+${st.basesUnchecked} unchecked `
    + `stops=${JSON.stringify(st.stops)} closes=${st.closesChecked}+${st.closesUnchecked} unchecked views=${st.viewsChecked}+${st.viewsUnchecked} unchecked `
    + `ownSlips=${st.ownSlips} riders=${st.ridersSeen} oddsCapped=${st.oddsCapped} `
    + `stall felts≤${(felts.ms / 1000).toFixed(1)}s/${(budget.felts / 1000).toFixed(1)} [${felts.at}] tip≤${(tip.ms / 1000).toFixed(1)}s/${(budget.tip / 1000).toFixed(1)} [${tip.at}] `
    + `moves=${st.moves} (places ${st.places}, odds ${st.odds}, takeOne ${st.takeOne}, takeAll ${st.takeAll}, per-chip lists ${st.perChipLists}, chips held back ${st.chipsHeldBack}) `
    + `tries=${JSON.stringify(craps.tries)} offers=${st.offers} flings=${st.flings} timesUp=${st.timesUp} walkedOff=${st.walkedOff} preempted=${st.preempted} (after a return ${st.cutAfterReturn}, offers back ${st.offersBack}) `
    + `late=${st.delays.filter((d) => d > 20_000).length} fakes=${st.fakes} standMoves=${st.standMoves} goodbyes=${st.goodbyes} quiet=${(quietMs / 1000).toFixed(1)}s `
    + `coverage placed/decided: ${cov}`;
}

/** Page sp reloads (a real reload: pagehide's goodbye) on the first tick
 *  from `from` at which its view of table t is taking bets with its felt on
 *  it, its stamp's chips standing: a goodbye is due. */
export function reloadMidBet(sim: Sim, sp: SimPage, from: number, goodbye = true): void {
  let done = false;
  sim.every(async () => {
    if (done || sim.elapsed < from || sp.mode !== 'up') return;
    const now = sim.enter(sp);
    const v = sp.p.table.readComputedCraps(T, now);
    if (!v || v.phase !== 'betting' || v.phaseDeadline === undefined || now >= v.phaseDeadline - 2_000) return;
    if (sp.p.table.readMyComputedCrapsBets(T, sp.pid, v.round, now).felt.length === 0) return;
    done = true;
    await sim.reload(sp, { goodbye });
  });
}
