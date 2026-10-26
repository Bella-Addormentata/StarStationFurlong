/**
 * 🧪🧮🌐 Computed roulette played by many pages over a network that delays,
 * drops, splits and heals (computedSim.ts): the guarantees the PR claims,
 * through the real code — casinoDoc's count, computedFold, computedTable's
 * duties and view, writeComputedSlip and its chip check.
 *
 * After each scenario's heal and a quiet period (the room settles in it),
 * every page that is up has caught up (whole, checked, awake) and agrees:
 * each table's fold, the last decided round its view shows, every
 * incarnation's nets, every player's chips and the cage, which issued what
 * the run bought and holds what the players' counts leave it. Throughout:
 * each player's chips are what a cold fold of every incarnation gives (at
 * every 5 s on every page whose doc is whole and checked), every decided
 * round reads as its records give it afresh (deltas, pocket), every forfeit
 * counts the seeds that came in its grace, every abandon waits ABANDON_MS
 * from the close or the page's last wake, no trim or ending moves chips,
 * no felt goes down past its player's chips, a page leaving takes its felt
 * down, the doc stays under 1 MB and the live session within a round of
 * TRIM_BYTES, no table sits with a tip or with felts and no close for longer
 * than ABANDON_MS + 2 × GRACE_MAX_MS while an honest page frozen or staked
 * there is up, and no frame throws. A round a page showed decided that later
 * reads otherwise (another pocket, other payouts, other chips moved) is a
 * flip: counted per page, and none without a cheat, a split or a lost update
 * (each scenario that allows some says which kinds and why); with none, no
 * player of one page ever reads below 0 chips. Each prints one line (run
 * with --reporter=verbose to see them).
 *
 * CI runs 3 simulated minutes a scenario; SIM_LONG=1 runs 15; SIM_SEED=n
 * moves every seed by n (a sweep).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import vectors from '../test-vectors/ed25519-strict.json';
import { canon } from './computedFold';
import type { Checkpoint, FoldCtx, FoldResult } from './computedFold';
import { PAGE_ROOM } from './computedPageKit';
import { ComputedKit, red } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import {
  between, BOT, HEAVY_BOT, RESYNC_MS, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET, SIM_STEP, SIM_T0,
} from './computedSim';
import type { BotSpec, FlipKind, PageSpec, SimPage, SimSummary } from './computedSim';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RUN_MS = SIM_MINUTES * 60_000;
const TIMEOUT = SIM_LONG ? 1_800_000 : 120_000;
const T1 = 'roulette-1';
const T2 = 'roulette-2';
const seed = (n: number): number => n + SIM_SEED_OFFSET;
const named = (names: string, extra: Partial<PageSpec> = {}): PageSpec[] => names.split('').map((name) => ({ name, ...extra }));
/** At least `per15` per 15 simulated minutes, scaled to the run. */
const scaled = (per15: number): number => Math.floor((per15 * SIM_MINUTES) / 15);
const lines: string[] = [];

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

/** The budgets, with a CI margin of 3: a cold fold of a session (the most a
 *  joining page folds: trims bound it) under 300 ms, a warm transaction under
 *  5 ms (the 95th percentile of every update a page applied). In CPU time,
 *  this process's: what the page's own work costs. The wall clock's is
 *  printed beside it, not held to a budget: under a parallel suite the
 *  machine runs other workers, and a transaction preempted in the middle
 *  reads tens of ms on the wall clock however little it did. */
const COLD_FOLD_MS = 3 * 300;
const WARM_MS = 3 * 5;
/** The quiet period's most (Sim.quiet): a room that has not settled by then
 *  is stuck. */
const QUIET_MAX_MS = 120_000;

interface Finish {
  /** The kinds of flip the scenario allows (none unless given), each for
   *  the reason its spec gives. */
  flips?: readonly FlipKind[];
  /** Kinds it allows only where a page was away or its clock moved: the
   *  forfeit that dropped a seed is of such a page (Sim.unexplained). */
  awayFlips?: readonly FlipKind[];
}

/** The heal, the quiet period, everything synced; then every assertion the
 *  scenarios share. The run's numbers, printed on one line. */
async function finish(sim: Sim, opts: Finish = {}): Promise<SimSummary> {
  const { table } = sim.pages[0].p;
  sim.heal();
  const quietMs = await sim.quiet(QUIET_MAX_MS);
  await sim.syncAll();
  sim.settleFlips();
  const s = sim.summary();
  const line = Sim.line(s, sim.worstStall.at);
  lines.push(line);
  console.log(line);
  const log = sim.pages.flatMap((sp) => sp.flipLog.map((f) => `${sp.name} ${f}`));
  // SIM_DEBUG=1: every flip, as it read.
  if (process.env.SIM_DEBUG) console.log(log.join('\n'));
  // No invariant broke while it ran (every player's chips against a cold
  // fold, every decided round worked out afresh, every forfeit against the
  // seeds that came in its grace, no trim or ending moving chips, no count
  // moving on a partial doc, no felt over what its player has, every felt
  // down on a leave, the doc's size, nothing written before the room's state).
  expect(sim.violations, sim.label).toEqual([]);
  // The room settled in the quiet period, and every page up caught up.
  expect(quietMs, sim.label).toBeLessThan(QUIET_MAX_MS);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) expect(sim.endProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  // Every page up agrees, and on each the books add up: each player's chips,
  // and the cage against what the run bought.
  expect(sim.disagreements(), sim.label).toEqual([]);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
    expect(sim.ledgerProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
    expect(sim.cageProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  }
  expect(s.maxDocBytes, sim.label).toBeLessThan(1_000_000);
  // The live session within a round of TRIM_BYTES: a trim runs in the show
  // of the round that takes it past.
  expect(s.maxSessionBytes, sim.label).toBeLessThanOrEqual(table.TRIM_BYTES + s.maxRoundBytes);
  expect(s.worstStallMs, `${sim.label} ${sim.worstStall.at}`).toBeLessThanOrEqual(table.ABANDON_MS + 2 * table.GRACE_MAX_MS);
  expect(s.coldFoldMs, sim.label).toBeLessThan(COLD_FOLD_MS);
  expect(s.warmP95Ms, sim.label).toBeLessThan(WARM_MS);
  const allowed = new Set([...(opts.flips ?? []), ...(opts.awayFlips ?? [])]);
  const unexpected = sim.pages.flatMap((sp) => (Object.entries(sp.flipKinds) as [FlipKind, number][])
    .filter(([k]) => !allowed.has(k)).map(([k, n]) => `${sp.name}: ${n} × ${k}`));
  expect(unexpected, `${sim.label}\n${log.join('\n')}`).toEqual([]);
  expect(sim.unexplained(opts.awayFlips ?? []), `${sim.label}\n${log.join('\n')}`).toEqual([]);
  // With no round rewritten, a player of one page never spends more than
  // they have: their count never reads below 0 (the chip check; a felt put
  // down on a result that was later rewritten can overspend).
  if (Object.values(s.flips).every((n) => n === 0)) expect([...sim.debts.values()], sim.label).toEqual([]);
  return s;
}

// ── 🧰 What the scenarios do to pages ────────────────────────────────────────

/** The live session of table t on page sp, its context, and a kit to build
 *  records with (null while the table has none). */
function sessionOf(sp: SimPage, t: string): { ses: Y.Map<unknown>; ctx: FoldCtx; kit: ComputedKit } | null {
  const ses = sp.p.casino.computedSessionForWrite(t);
  const inc = sp.p.casino.computedIncOf(t);
  if (!ses || !inc) return null;
  const ctx = { room: PAGE_ROOM, t, inc };
  return { ses, ctx, kit: new ComputedKit(ctx) };
}

/** Page sp's own key, signing as player `pid` (its own unless given). */
function identityOf(sp: SimPage, pid = sp.pid): TestIdentity {
  return { pid, pub: sp.p.pub, sign: (bytes) => sp.p.keypair.signIdentity(bytes) };
}

/** Records put straight into the live session (a modified page's writes). */
function putIn(sp: SimPage, ses: Y.Map<unknown>, recs: { key: string; rec: unknown }[]): void {
  sp.p.doc.transact(() => {
    for (const { key, rec } of recs) ses.set(key, rec);
  });
}

/** An earlier build's lease holder, as it writes the lease (no `build`) for
 *  the house's player (its other page, on the old build). */
function oldBuildLease(sp: SimPage, player: string, beat: number): void {
  sp.p.casino.writeTableOperatorLease({ page: `old-build-${sp.name}`, player, beat });
}

/** An owner-run round as an earlier build's lease holder opens one on table
 *  t (writeTableState and tableOpening, as its openBetting does). */
function oldBuildOpens(sp: SimPage, t: string): void {
  const { casino } = sp.p;
  casino.transactCasino(() => casino.writeTableState(t, {
    kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null, ...casino.tableOpening(t),
  }));
}

const ALL_IN: BotSpec = { ...BOT, place: 0.5, allIn: true };

/** The house's ⚙ switch, off at each of `at` and on again `gap` later,
 *  pressed on every tick until it goes ('ok'). The incarnations it ran, in
 *  order, and the refusals it met. */
function switchCycles(sim: Sim, at: number[], gap: number): { incs: string[]; refusals: Record<string, number>; pending: () => boolean } {
  const { house } = sim;
  const incs: string[] = [house.p.casino.computedIncOf(T1)!];
  const refusals: Record<string, number> = {};
  let want: 'off' | 'on' | null = null;
  for (const ms of at) {
    sim.at(ms, () => { want = 'off'; });
    sim.at(ms + gap, () => { want = 'on'; });
  }
  sim.every(() => {
    if (!want) return;
    const now = sim.enter(house);
    const { table, casino } = house.p;
    const res = want === 'off' ? table.switchComputedOff(T1, now) : table.switchComputedOn(T1, 'roulette', now);
    if (res !== 'ok') {
      refusals[`${want}:${res}`] = (refusals[`${want}:${res}`] ?? 0) + 1;
      return;
    }
    if (want === 'on') incs.push(casino.computedIncOf(T1)!);
    want = null;
  });
  return { incs, refusals, pending: () => want !== null };
}

// ── The spike's eight ────────────────────────────────────────────────────────

describe("the spike's eight", () => {
  it('baseline: 4 pages, a good network, clocks up to 5 s apart', async () => {
    const sim = await Sim.open({ name: 'baseline', seed: seed(1), pages: named('ABCD') });
    await sim.run(RUN_MS);
    // Then, the bots stopped, a page loaded again: it checks the session's
    // signatures as its budget allows (each recount spends it, the rest
    // waits for the next, or for a slice of its own: computedSettled false
    // meanwhile), and settles.
    for (const sp of sim.pages) sp.betting = false;
    await sim.run(20_000);
    const b = sim.pages[1];
    const slices = b.slices;
    await sim.reload(b);
    await sim.run(10_000);
    expect(b.pendingHeard, sim.label).toBeGreaterThan(0);
    expect(b.slices - slices, sim.label).toBeGreaterThan(0);
    expect(sim.endProblems(b), sim.label).toEqual([]);
    const s = await finish(sim);
    // No stall: at least 26 rounds per 15 minutes.
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(26));
    expect(s.voids, sim.label).toBe(0);
    expect(s.byForfeit, sim.label).toBe(0);
    // Felts of more than their players have were tried, and refused.
    expect(s.writes.chips ?? 0, sim.label).toBeGreaterThan(0);
  }, TIMEOUT);

  it('slow network: 300-800 ms on every link, 5% of updates lost (the 5 s resync brings them)', async () => {
    const sim = await Sim.open({ name: 'slow-network', seed: seed(2), pages: named('ABCDE'), link: { delay: [300, 800], loss: 0.05 } });
    await sim.run(RUN_MS);
    // Scoped: a lost update can rewrite a round some pages showed, in the
    // ways the design accepts (no cheat, no split, and still it happens). A
    // seed lost on one link comes with the next resync, up to 5 s on, past
    // the 4 s grace of the page it was lost to: that page forfeits it, and a
    // valid forfeit beats the full set the others already showed (pr2-
    // verdict.md Q4, kept so that a late seed never rewrites a forfeit's
    // result; Risks: a link slower than the grace still forfeits). A page
    // that saw the seed in time may answer with a forfeit that counts it,
    // which, ranked better, stands: the round reads as the full set had it
    // again. And a close lost on its way to the next closer in rank brings an
    // honest rival close, which can win by the chain rule ("ROUND n WAS
    // REWRITTEN"). Nothing else, and every page still agrees.
    const s = await finish(sim, { flips: ['forfeit over reveals', 'answer forfeit', 'rival close'] });
    expect(s.lost, sim.label).toBeGreaterThan(0);
    expect(s.partialEpisodes, sim.label).toBeGreaterThan(0);
    // A doc holding part of an update asked the room for the rest.
    expect(s.resyncAsks, sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(20));
  }, TIMEOUT);

  it('split with trims: 3 pages and 3 pages apart for 60 s, both sides playing and trimming, then healed', async () => {
    const sim = await Sim.open({ name: 'split', seed: seed(3), pages: named('ABCDEF'), bot: HEAVY_BOT });
    const sides = [['A', 'B', 'C'], ['D', 'E', 'F']];
    const sid = (name: string): string | undefined => sim.pages.find((sp) => sp.name === name)!.p.casino.computedFoldOf(T1)?.base.sid;
    let before: (string | undefined)[] = [];
    let during: (string | undefined)[] = [];
    sim.at(60_000, () => {
      before = [sid('A'), sid('D')];
      sim.net.groups = sides;
    });
    sim.at(119_750, () => {
      during = [sid('A'), sid('D')];
    });
    sim.at(120_000, () => {
      sim.net.groups = null;
    });
    await sim.run(RUN_MS);
    // Scoped: the doc's last write to `sum:` decides which side's trim
    // stands, and the other side's rounds since the split void, visibly
    // (pr2-verdict.md Risks, "Splits"): rounds its pages showed are undone,
    // or replaced by the winning side's.
    // (And the ⚙ card's check on the losing side: the checkpoint kept
    // differs from what its pages folded of the rounds it covers.)
    const s = await finish(sim, { flips: ['other branch', 'checkpoint', 'undone', 'rival close', 'forfeit over reveals', 'answer forfeit'] });
    // The losing side's rounds since the split read otherwise.
    expect(Object.values(s.flips).reduce((a, b) => a + b, 0), sim.label).toBeGreaterThan(0);
    // Each side trimmed while apart, into sessions of its own.
    expect(during[0], sim.label).not.toBe(before[0]);
    expect(during[1], sim.label).not.toBe(before[1]);
    expect(during[0], sim.label).not.toBe(during[1]);
    expect(s.trims, sim.label).toBeGreaterThanOrEqual(3);
  }, TIMEOUT);

  it('churn: pages leave, crash, reload and join, sometimes one player alone at the table', async () => {
    const sim = await Sim.open({ name: 'churn', seed: seed(4), pages: named('ABCDEF') });
    const others = (): SimPage[] => sim.pages.filter((sp) => sp.name !== 'A');
    const churn = async (): Promise<void> => {
      if (sim.healed) return;
      const r = sim.rand;
      const cands = others();
      const sp = cands[between(r, 0, cands.length - 1)];
      const x = r();
      if (sp.mode === 'gone') await sim.reload(sp);
      else if (x < 0.4) await sim.leave(sp);
      else if (x < 0.7) sim.crash(sp);
      else await sim.reload(sp);
      sim.at(sim.elapsed + between(r, 6_000, 20_000), churn);
    };
    sim.at(12_000, churn);
    sim.at(45_000, () => sim.add({ name: 'G' }).then(() => undefined));
    // A stretch with one player alone: every other page gone for 40 s.
    sim.at(100_000, async () => {
      for (const sp of others()) if (sp.mode !== 'gone') sim.crash(sp);
    });
    sim.at(140_000, async () => {
      for (const sp of others().slice(0, 3)) if (sp.mode === 'gone') await sim.reload(sp);
    });
    await sim.run(RUN_MS);
    for (const sp of others().slice(0, 2)) if (sp.mode === 'gone') await sim.reload(sp);
    const s = await finish(sim);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
    // Pages loaded again checked the session in slices.
    expect(s.slices, sim.label).toBeGreaterThan(0);
  }, TIMEOUT);

  it('cheats: one page forges slips under other players, writes junk, deletes records and the switch', async () => {
    const sim = await Sim.open({ name: 'cheats', seed: seed(5), pages: [...named('ABCD'), { name: 'X', honest: false }], backIsBlip: true });
    const x = sim.pages.find((sp) => sp.name === 'X')!;
    x.cheats = true;
    const honest = sim.pages.filter((sp) => sp !== x);
    const victims = honest.map((sp) => sp.pid);
    const pubs = new Set(honest.map((sp) => sp.p.pub));
    const { fold, table } = x.p;
    const inc = x.p.casino.computedIncOf(T1)!;
    const done: Record<string, number> = { forged: 0, junk: 0, over: 0, deleted: 0, switch: 0, witnessed: 0, reput: 0 };
    const forged = new Set<string>();
    // What it takes away (deleted, or junk written over it) that must come
    // back, byte for byte, on every honest page: an honest page's close,
    // forfeit, abandon or seed, and a slip a close froze. Its author puts it
    // back (REPUT_MS), or a witness in its turn (STAGGER_MS each, of up to 32
    // pubs), the room's resync bringing it (RESYNC_MS, each way). Unless a
    // checkpoint covers its round by then, or a trim took its session.
    const BACK_MS = table.REPUT_MS + 32 * table.STAGGER_MS + 2 * RESYNC_MS;
    // What a decided round rests on, taken while its author is away, goes
    // back by a witness alone, a page up whose player the round froze too
    // (computedTable witnessDuty: the frozen slips, and once the result has
    // shown, the close, the counted seeds and the deciding forfeit): in its
    // turn, REPUT_MS and STAGGER_MS for each place ahead of it.
    const WITNESS_MS = table.REPUT_MS + (1 + sim.pages.length) * table.STAGGER_MS + 2_000;
    const gone = new Map<string, { bytes: string; r: number; sid: string; T: number; late: boolean; away: boolean }>();
    // When the cheat first read each round decided (the room's time).
    const decidedAt = new Map<string, number>();
    const ctx: FoldCtx = { room: PAGE_ROOM, t: T1, inc };
    /** Whether a witness keeps a copy of `key`, `author`'s (computedTable
     *  noteWitness): a record a round the cheat read decided 2 s ago or more
     *  rests on (a forfeit's result shows after the grace: 15 s), another
     *  honest page's player frozen in it, that page up. */
    const witnessHeld = (res: FoldResult, ses: Y.Map<unknown>, key: string, rec: unknown, author: SimPage): boolean => {
      const pk = fold.parseKey(key);
      if (!pk) return false;
      const v = res.rounds.find((round) => round.r === pk.r);
      if (!v || v.decided === null || v.decided === 'void') return false;
      if (sim.T - (decidedAt.get(v.close) ?? sim.T) < (v.decided === 'forfeit' ? 15_000 : 2_000)) return false;
      if (!honest.some((q) => q !== author && q.mode === 'up' && v.present.includes(q.pid))) return false;
      if (pk.kind === 's') return v.present.includes(pk.pid!) && v.frozen[pk.pid!] === pk.h;
      if (pk.kind === 'c') return pk.h === v.close;
      if (pk.kind === 'f') return v.forfeit?.hash === pk.h;
      if (pk.kind !== 'x' || !v.revealed.includes(pk.pid!)) return false;
      const xr = fold.asReveal(rec);
      const slip = fold.asSlip(ses.get(`s:${v.r}:${pk.pid}:${v.frozen[pk.pid!]}`));
      return xr !== null && slip !== null && fold.slipCommit(ctx, v.r, pk.pid!, xr.s) === slip.c;
    };
    // And its author, up, puts back its own first: on its page, a slip or a
    // close of a decided round is back within REPUT_MS (its re-put's beat) of
    // going, while its duties run (computedTable reputDuty) — a witness's turn
    // comes a STAGGER_MS later at the soonest.
    const timed = new Map<string, { author: SimPage; bytes: string; r: number; sid: string; T: number; missing: number | null }>();
    const authorOf = (key: string, rec: unknown): SimPage | undefined => {
      const pk = fold.parseKey(key)!;
      if (pk.kind === 's' || pk.kind === 'x') return honest.find((q) => q.pid === pk.pid);
      return honest.find((q) => q.p.pub === (rec as { k?: unknown }).k);
    };
    const mustReturn = (ses: Y.Map<unknown>, res: FoldResult, key: string, rec: unknown): boolean => {
      const pk = fold.parseKey(key);
      const v = rec as { k?: unknown; r?: unknown; p?: unknown; s?: unknown };
      if (!pk || pk.r <= res.base.u) return false;
      if (pk.kind === 'c' || pk.kind === 'f' || pk.kind === 'z') return pubs.has(v.k as string);
      if (pk.kind === 's') {
        return pubs.has(v.k as string) && (res.rounds.some((round) => round.r === pk.r && round.frozen[pk.pid!] === pk.h)
          || res.openCloses.some((c) => c.rec.r === pk.r && c.rec.f[pk.pid!] === pk.h));
      }
      const xr = fold.asReveal(rec);
      if (!xr || fold.revealKey(xr) !== key) return false;
      const c = fold.slipCommit(ctx, xr.r, xr.p, xr.s);
      return [...ses.keys()].some((k) => {
        const s = k.startsWith(`s:${xr.r}:${xr.p}:`) ? fold.asSlip(ses.get(k)) : null;
        return s !== null && s.c === c && pubs.has(s.k);
      });
    };
    const takeAway = (ses: Y.Map<unknown>, res: FoldResult, key: string): void => {
      const rec = ses.get(key);
      if (rec === undefined || !mustReturn(ses, res, key, rec)) return;
      const pk = fold.parseKey(key)!;
      const author = authorOf(key, rec);
      const bytes = canon(rec)!;
      const away = author !== undefined && author.mode !== 'up' && witnessHeld(res, ses, key, rec, author);
      if (away) done.witnessed += 1;
      gone.set(key, { bytes, r: pk.r, sid: res.base.sid, T: sim.T, late: false, away });
      const decided = res.rounds.some((v) => v.r === pk.r && v.decided !== null);
      if (author?.mode === 'up' && decided && (pk.kind === 's' || pk.kind === 'c')) {
        timed.set(key, { author, bytes, r: pk.r, sid: res.base.sid, T: sim.T, missing: null });
      }
    };
    /** Back on page q (or no longer due there: covered, or of a session gone). */
    const backOn = (q: SimPage, key: string, g: { bytes: string; r: number; sid: string }): boolean => {
      sim.enter(q);
      const res = q.p.casino.computedFoldOf(T1);
      const ses = q.p.casino.computedSessionForWrite(T1);
      if (!res || !ses) return false;
      if (res.base.sid !== g.sid || res.base.u >= g.r) return true;
      const v = ses.get(key);
      return v !== undefined && canon(v) === g.bytes;
    };
    const notBack = (): string[] => [...gone].filter(([key, g]) => !honest.every((q) => q.mode !== 'up' || backOn(q, key, g)))
      .map(([key, g]) => `${key} taken at ${((g.T - SIM_T0) / 1000).toFixed(2)}s`);
    // The switch deleted: back on every honest page within a second (each
    // puts it back on its next frame, before any duty).
    const switchGone: number[] = [];
    sim.every(() => {
      for (const [key, g] of [...gone]) {
        // (Not before the take has reached every page: 40-150 ms a link.)
        if (sim.T - g.T < 2_000) continue;
        if (honest.every((q) => q.mode !== 'up' || backOn(q, key, g))) gone.delete(key);
        else if (!g.late && sim.T - g.T > (g.away ? WITNESS_MS : BACK_MS)) {
          g.late = true;
          sim.violate(`${key} (taken at ${sim.elapsed - (sim.T - g.T)} ms${g.away ? ', its author away' : ''}) not back after ${g.away ? WITNESS_MS : BACK_MS} ms`);
        }
      }
      for (const [key, e] of [...timed]) {
        const q = e.author;
        if (q.mode !== 'up') {
          timed.delete(key);
          continue;
        }
        sim.enter(q);
        const res = q.p.casino.computedFoldOf(T1);
        const ses = q.p.casino.computedSessionForWrite(T1);
        if (!res || !ses || res.base.sid !== e.sid || res.base.u >= e.r) {
          timed.delete(key);
          continue;
        }
        const v = ses.get(key);
        if (v === undefined || canon(v) !== e.bytes) {
          e.missing ??= sim.T;
          continue;
        }
        // (Never seen gone there: put back as the delete came, or the delete
        // not come yet.)
        if (e.missing === null) {
          if (sim.T - e.T > 3_000) timed.delete(key);
          continue;
        }
        timed.delete(key);
        // (Its duties held back meanwhile: its doc partial, a count waiting
        // on its checks, or a wake's lapse.)
        if (q.shutAt >= e.missing - SIM_STEP) continue;
        done.reput += 1;
        if (sim.T - e.missing > table.REPUT_MS + 2 * SIM_STEP) {
          sim.violate(`${key} (taken at ${e.T - SIM_T0} ms) back on its author ${q.name}'s page ${sim.T - e.missing} ms after it went there, not by its re-put`);
        }
      }
      while (switchGone.length > 0 && sim.T - switchGone[0] >= 1_000) {
        const at = switchGone.shift()!;
        for (const q of honest) {
          sim.enter(q);
          if (q.mode === 'up' && q.p.casino.computedIncOf(T1) !== inc) sim.violate(`${q.name}: the switch deleted at ${at - SIM_T0} ms not back a second on`);
        }
      }
    });
    let n = 0;
    let switchNow = false;
    sim.at(90_000, () => { switchNow = true; });
    sim.every(() => {
      sim.enter(x);
      for (const v of x.p.casino.computedFoldOf(T1)?.rounds ?? []) if (v.decided !== null && !decidedAt.has(v.close)) decidedAt.set(v.close, sim.T);
    });
    // Away: an honest page's computer sleeps for 30 s (its doc hearing the
    // room), and the cheat takes away its player's frozen slip or seed in a
    // decided round every 2.5 s, early enough for the witnesses' turns to pass
    // before it wakes. And every 20 s besides, an up player's.
    const AWAY_MS = 30_000;
    let away: SimPage | null = null;
    let aimUntil = 0;
    let nextAim = 0;
    let nextUpAim = 20_000 + SIM_T0;
    for (let at = 100_000, i = 0; at <= RUN_MS - 60_000; at += 300_000, i += 1) {
      const sp = honest[(honest.length - 1 + i) % honest.length];
      sim.at(at, () => {
        if (sp.mode !== 'up') return;
        sim.sleep(sp, true);
        away = sp;
        aimUntil = sim.T + AWAY_MS - WITNESS_MS - 3_000;
        nextAim = sim.T + 1_000;
        sim.at(sim.elapsed + AWAY_MS, () => {
          if (sp.mode === 'asleep') sim.wake(sp);
          away = null;
        });
      });
    }
    /** In a decided round past the checkpoint that a witness holds (2 s or
     *  more ago on the cheat's fold, another honest page's player frozen in
     *  it beside `of`'s): `of`'s frozen slip, or the seed opening it. */
    const aimAt = (res: FoldResult, ses: Y.Map<unknown>, of: SimPage, seed: boolean): string | null => {
      for (const v of res.rounds) {
        if (v.r <= res.base.u || !v.present.includes(of.pid)) continue;
        const slip = `s:${v.r}:${of.pid}:${v.frozen[of.pid]}`;
        const key = !seed ? slip : [...ses.keys()].find((k) => k.startsWith(`x:${v.r}:${of.pid}:`) && witnessHeld(res, ses, k, ses.get(k), of));
        if (key && ses.has(key) && witnessHeld(res, ses, key, ses.get(key), of)) return key;
      }
      return null;
    };
    x.beforeFrame = () => {
      const r = sim.rand;
      const aiming = away !== null ? sim.T >= nextAim && sim.T <= aimUntil : sim.T >= nextUpAim;
      if (aiming) {
        const at = sessionOf(x, T1);
        const res = x.p.casino.computedFoldOf(T1);
        const ups = honest.filter((q) => q.mode === 'up');
        const of = away ?? ups[between(r, 0, ups.length - 1)];
        const k = at && res && of ? aimAt(res, at.ses, of, r() < 0.5) : null;
        if (away !== null) nextAim = sim.T + 2_500;
        else nextUpAim = sim.T + 20_000;
        if (k) {
          takeAway(at!.ses, res!, k);
          x.p.doc.transact(() => at!.ses.delete(k));
          done.deleted += 1;
          return true;
        }
      }
      if (!switchNow && r() > 0.05) return true;
      const at = sessionOf(x, T1);
      const res = x.p.casino.computedFoldOf(T1);
      if (!at || !res) return true;
      const { ses, kit } = at;
      const what = switchNow ? 1 : r();
      n += 1;
      // Any record of another page's (forged ones too).
      const others = [...ses.keys()].filter((k) => !k.includes(x.pid));
      if (what < 0.3) {
        // A felt under another player's id, signed with this page's key: the
        // fold reads each player's felts under their pin alone.
        const victim = victims[between(r, 0, victims.length - 1)];
        const slip = kit.slip(identityOf(x, victim), res.open, [red(between(r, 50, 400))], { seed: kit.seed('forged', res.open, String(n)) });
        putIn(x, ses, [slip]);
        forged.add(slip.hash);
        done.forged += 1;
      } else if (what < 0.5) {
        // Junk: a well-formed slip key holding no slip, a key nothing reads,
        // a record of the right shape signed over nothing.
        const h = kit.seed('junk', res.open, String(n)).slice(0, 16);
        putIn(x, ses, [
          { key: `s:${res.open}:${x.pid}:${h}`, rec: { junk: n } },
          { key: `zz-${h}`, rec: 'junk' },
          { key: `x:${res.open}:${victims[0]}:${h}`, rec: { r: res.open, p: victims[0], s: 'f'.repeat(64) } },
        ]);
        done.junk += 1;
      } else if (what < 0.65) {
        // Junk written over a record of another page's.
        if (others.length > 0) {
          const k = others[between(r, 0, others.length - 1)];
          takeAway(ses, res, k);
          putIn(x, ses, [{ key: k, rec: { junk: n } }]);
          done.over += 1;
        }
      } else if (what < 0.9) {
        // A delete.
        if (others.length > 0) {
          const k = others[between(r, 0, others.length - 1)];
          takeAway(ses, res, k);
          x.p.doc.transact(() => ses.delete(k));
          done.deleted += 1;
        }
      } else {
        // The switch itself, deleted (now and then, and once at 90 s). (Its
        // own frame would put it back at once: it skips it.)
        switchNow = false;
        x.p.doc.transact(() => x.p.doc.getMap('casino').delete(`cfg:computed:${T1}`));
        switchGone.push(sim.T);
        done.switch += 1;
        return false;
      }
      return true;
    };
    await sim.run(RUN_MS);
    // Scoped (pr2-pr-notes.md lever 8, "Deletes"; pr2-verdict.md levers):
    // a deleted record a decided round rests on (its close, a seed, a slip)
    // takes that round and the ones after it off the chain until its author
    // or a witness puts it back (REPUT_MS): a blip; so is a round that reads
    // otherwise meanwhile and as shown once it is back (backIsBlip: a
    // deciding forfeit deleted after a late seed came lets the full set
    // decide the round until the forfeit is back). A seed deleted before a
    // page saw it is late there: that page forfeits it, and the forfeit beats
    // the full set others showed (answered, maybe, by a page that saw it in
    // time); a close deleted brings the next closer's. Every page still
    // agrees, every record taken away is back, and the books add up.
    const s = await finish(sim, { flips: ['blip', 'forfeit over reveals', 'answer forfeit', 'rival close'] });
    expect(notBack(), sim.label).toEqual([]);
    for (const k of ['forged', 'junk', 'over', 'deleted', 'switch', 'witnessed', 'reput']) expect(done[k], `${sim.label} ${k}`).toBeGreaterThan(0);
    // No close froze a forged felt: each player's felts are read under their
    // pin alone.
    for (const sp of sim.pages) {
      for (const f of sim.cold(sp).folds.values()) {
        for (const v of f.res.rounds) expect(Object.values(v.frozen).filter((h) => forged.has(h)), `${sim.label} ${sp.name}`).toEqual([]);
      }
    }
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it('late revealer: one page whose reveal lags 3-12 s behind the close (a throttled tab)', async () => {
    const sim = await Sim.open({ name: 'late-revealer', seed: seed(6), pages: named('ABCDE') });
    const late = sim.pages.find((sp) => sp.name === 'E')!;
    const lagged = new Set<string>();
    const lags: number[] = [];
    late.beforeFrame = () => {
      const tip = late.p.casino.computedFoldOf(T1)?.tip;
      if (!tip || !tip.present.includes(late.pid) || tip.revealed.includes(late.pid) || lagged.has(tip.close)) return true;
      lagged.add(tip.close);
      const lag = between(sim.rand, 3_000, 12_000);
      lags.push(lag);
      late.pauseUntil = sim.T + lag;
      return false;
    };
    await sim.run(RUN_MS);
    // Scoped: a seed that comes in around the grace's end is in time on some
    // pages and late on others; the page it is late on forfeits it, and its
    // forfeit beats the full set the others showed (pr2-verdict.md Q4),
    // answered maybe by a better-ranked page that saw the seed in time.
    const s = await finish(sim, { flips: ['forfeit over reveals', 'answer forfeit'] });
    expect(lags.length, sim.label).toBeGreaterThan(0);
    expect(s.byForfeit, sim.label).toBeGreaterThan(0);
    // Forfeits of the pages that waited, checked against the seeds' arrivals.
    expect(s.forfeitsChecked, sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it('forgery: bad signatures, small-order keys and the identity-R signature, thrown out without touching anyone', async () => {
    const sim = await Sim.open({ name: 'forgery', seed: seed(7), pages: [...named('ABCD'), { name: 'F', bot: null, honest: false }] });
    const f = sim.pages.find((sp) => sp.name === 'F')!;
    f.cheats = true;
    const vec = (name: string) => vectors.vectors.find((v) => v.name === name)!;
    const small = vec('small-order-key');
    const idr = vec('identity-r');
    // Identities that pass noble's default verify for every message: the
    // small-order key with its (42·B, 42), and the identity R under its key.
    const Z: TestIdentity = { pid: 'player-Z', pub: small.pub, sign: () => small.sig };
    const W: TestIdentity = { pid: 'player-W', pub: idr.pub, sign: () => idr.sig };
    // And F's own key, signing other bytes than the record's.
    const bad: TestIdentity = { pid: f.pid, pub: f.p.pub, sign: (bytes) => f.p.keypair.signIdentity(new Uint8Array([...bytes, 0])) };
    await sim.as(f, () => f.p.doc.transact(() => {
      for (const id of [Z, W]) f.p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
    }));
    let n = 0;
    f.beforeFrame = () => {
      if (sim.rand() > 0.08) return true;
      const at = sessionOf(f, T1);
      const res = f.p.casino.computedFoldOf(T1);
      if (!at || !res) return true;
      const { ses, kit } = at;
      n += 1;
      const recs: { key: string; rec: unknown }[] = [];
      const slips = [Z, W, bad].map((id) => kit.slip(id, res.open, [red(900)], { seed: kit.seed('forgery', res.open, `${id.pid}|${n}`) }));
      recs.push(...slips);
      // A close freezing every felt and the forged ones, signed by each.
      const frozen: Record<string, string> = {};
      for (const [pid, info] of res.felts) frozen[pid] = info.hash;
      for (const s of slips) frozen[s.rec.p] = s.hash;
      for (const id of [Z, W, bad]) recs.push(kit.close(id, res.open, res.parent, frozen));
      // Forfeits of the tip dropping everyone but the forger, each signer.
      if (res.tip) for (const id of [Z, W, bad]) recs.push(kit.forfeit(id, res.tip.r, res.tip.close, [id.pid]));
      putIn(f, ses, recs);
      return true;
    };
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(n, sim.label).toBeGreaterThan(0);
    // Nothing forged counted: no net, nothing held, for any forger; F's
    // chips are what it bought.
    for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
      const cold = sim.cold(sp);
      for (const pid of [Z.pid, W.pid, f.pid]) {
        expect(cold.nets.get(pid) ?? 0n, `${sim.label} ${sp.name} ${pid}`).toBe(0n);
        expect(cold.held.get(pid) ?? 0n, `${sim.label} ${sp.name} ${pid}`).toBe(0n);
      }
      expect(sp.p.casino.readChips(f.pid), sim.label).toBe(1_000);
      for (const fold of cold.folds.values()) for (const v of fold.res.rounds) for (const pid of [Z.pid, W.pid, f.pid]) expect(v.present).not.toContain(pid);
    }
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(20));
  }, TIMEOUT);

  it('long history with trims: heavy felts fill the session every round or two', async () => {
    const sim = await Sim.open({ name: 'long-history', seed: seed(8), pages: named('ABCD'), bot: HEAVY_BOT });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(s.trims, sim.label).toBeGreaterThanOrEqual(scaled(15));
    expect(s.maxPreTrimBytes, sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(20));
  }, TIMEOUT);
});

// ── Added for PR 2 ───────────────────────────────────────────────────────────

describe('added for PR 2', () => {
  it('two tabs of one player: one profile, one key, one seed store, both betting', async () => {
    const tabs: PageSpec[] = [{ name: 'P', pid: 'player-P', device: 'P' }, { name: 'Q', pid: 'player-P', device: 'P', chips: 0 }];
    const sim = await Sim.open({ name: 'two-tabs', seed: seed(9), pages: [...named('ABC'), ...tabs] });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    const [p, q] = sim.pages.filter((sp) => sp.pid === 'player-P');
    expect(p.p.pub, sim.label).toBe(q.p.pub);
    expect(p.writes.ok ?? 0, sim.label).toBeGreaterThan(0);
    expect(q.writes.ok ?? 0, sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(20));
  }, TIMEOUT);

  it('cross-table overspend: two tabs all in at two tables, the debt clamped to 0 and paid down', async () => {
    const tabs: PageSpec[] = [
      { name: 'X', pid: 'player-X', device: 'X', bot: ALL_IN, botTables: [T1] },
      { name: 'Y', pid: 'player-X', device: 'X', bot: ALL_IN, botTables: [T2], chips: 0 },
    ];
    const sim = await Sim.open({ name: 'overspend', seed: seed(10), tables: [T1, T2], pages: [...named('AB'), ...tabs] });
    const [x, y] = sim.pages.filter((sp) => sp.pid === 'player-X');
    // The tabs hear each other late: each bets all it has before the
    // other's felt is in.
    sim.net.setLink(x, y, { delay: [1_500, 3_000] });
    sim.net.setLink(y, x, { delay: [1_500, 3_000] });
    let least = 0n;
    let clamped = 0;
    sim.every(() => {
      if (sim.elapsed % 1_000 !== 0) return;
      for (const sp of [x, y]) {
        sim.enter(sp);
        const { casino } = sp.p;
        if (sp.partial || !casino.casinoWhole() || !casino.computedSettled()) continue;
        const total = sim.ledgerTotal(sp, 'player-X');
        if (total < least) least = total;
        if (total < 0n) {
          clamped += 1;
          expect(casino.readChips('player-X'), sim.label).toBe(0);
        }
      }
    });
    await sim.run(RUN_MS);
    await finish(sim);
    // The overspend happened (PR 1's debt rule: not prevented, clamped).
    expect(least, sim.label).toBeLessThan(0n);
    expect(clamped, sim.label).toBeGreaterThan(0);
    // And a debt is paid down: a buy-in covers it first.
    sim.enter(x);
    const total = sim.ledgerTotal(x, 'player-X');
    const debt = total < 0n ? Number(-total) : 0;
    await sim.as(x, () => x.p.casino.buyInChips('player-X', debt + 100));
    await sim.syncAll();
    for (const sp of sim.pages) expect(sp.p.casino.readChips('player-X'), `${sim.label} ${sp.name}`).toBe(Number(total > 0n ? total : 0n) + 100);
    expect(sim.disagreements(), sim.label).toEqual([]);
  }, TIMEOUT);

  it('removal mid-session: the house takes one of two tables out with a round under way; compaction finalises it', async () => {
    const sim = await Sim.open({ name: 'removal', seed: seed(11), tables: [T1, T2], pages: named('ABCD') });
    const { house } = sim;
    // From 70 s on, at the first look with a close in or chips on the felt.
    let removed: string | null = null;
    sim.every(async () => {
      if (removed || sim.elapsed < 70_000) return;
      sim.enter(house);
      const res = house.p.casino.computedFoldOf(T1);
      if (!res || (!res.tip && ![...res.felts.values()].some((f) => f.rec.b.length > 0))) return;
      removed = house.p.casino.computedIncOf(T1)!;
      await sim.remove(house, T1);
    });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(removed, sim.label).not.toBeNull();
    const inc = removed!;
    for (const sp of sim.pages) {
      const { casino, table, doc } = sp.p;
      sim.enter(sp);
      expect(casino.isComputedTable(T1), `${sim.label} ${sp.name}`).toBe(false);
      expect(casino.tableIncRemoved(T1, inc), `${sim.label} ${sp.name}`).toBe(true);
      expect(table.computedCompactionPending(), `${sim.label} ${sp.name}`).toBe(false);
      const map = doc.getMap('casinoComputed');
      expect([...map.keys()].filter((k) => k.startsWith(`ses:${T1}:`)), `${sim.label} ${sp.name}`).toEqual([]);
      expect(map.get(`sum:${T1}:${inc}`) as Checkpoint, `${sim.label} ${sp.name}`).toMatchObject({ v: 1, e: 1 });
      // The other table played on.
      expect(casino.isComputedTable(T2), `${sim.label} ${sp.name}`).toBe(true);
    }
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(30));
  }, TIMEOUT);

  it('switch off and on again: the house turns the table owner-run between rounds, then computed on a new incarnation', async () => {
    const sim = await Sim.open({ name: 'switch-off-on', seed: seed(12), pages: named('ABCD') });
    const offs: number[] = [];
    for (let at = 60_000; at < RUN_MS - 40_000; at += SIM_LONG ? 240_000 : 70_000) offs.push(at);
    const { incs, refusals, pending } = switchCycles(sim, offs, 20_000);
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(pending(), sim.label).toBe(false);
    expect(incs.length, sim.label).toBeGreaterThanOrEqual(2);
    expect(new Set(incs).size, sim.label).toBe(incs.length);
    // Refused only while a round was under way (or the doc unsettled).
    for (const k of Object.keys(refusals)) expect(['off:busy', 'off:reconnecting', 'on:reconnecting', 'on:busy'], sim.label).toContain(k);
    for (const sp of sim.pages) {
      sim.enter(sp);
      const { casino } = sp.p;
      expect(casino.computedIncOf(T1), sim.label).toBe(incs[incs.length - 1]);
      for (const inc of incs.slice(0, -1)) expect(casino.computedIncEnded(T1, inc), `${sim.label} ${sp.name} ${inc}`).toBe(true);
      // Every incarnation's nets still count (the cold fold the ledger checks).
      expect(sim.cold(sp).folds.size, sim.label).toBe(incs.length);
    }
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it("an earlier build's operator: it takes the lease, opens an owner-run round with a list on the computed table, and goes", async () => {
    const sim = await Sim.open({ name: 'old-build-ghost', seed: seed(13), pages: [...named('ABCD'), { name: 'G', bot: null }] });
    const { house } = sim;
    const ghost = sim.pages.find((sp) => sp.name === 'G')!;
    let driving = 0;
    const legacyIncs = new Set<string>();
    const episodes = SIM_LONG ? [40_000, 300_000, 600_000] : [40_000, 110_000];
    for (const at of episodes) {
      sim.at(at, async () => {
        if (ghost.mode === 'gone') await sim.reload(ghost);
      });
      sim.at(at + 3_000, async () => {
        await sim.as(ghost, () => {
          oldBuildLease(ghost, house.pid, 1);
          oldBuildOpens(ghost, T1);
          expect(ghost.p.casino.writeMyBets(T1, ghost.pid, 1, [red(25)]), sim.label).toBe(true);
        });
        legacyIncs.add(ghost.p.casino.readTableState(T1)!.inc!);
      });
      // It renews the lease as its build does (only what it read), then goes.
      for (let beat = 2; beat <= 5; beat++) sim.at(at + 3_000 + (beat - 1) * 2_000, () => sim.as(ghost, () => oldBuildLease(ghost, house.pid, beat)));
      sim.at(at + 12_000, () => sim.crash(ghost));
    }
    sim.every(() => {
      if (sim.elapsed % 1_000 === 0 && house.p.table.computedOldBuildDriving(T1)) driving += 1;
    });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(driving, sim.label).toBeGreaterThan(0);
    expect(legacyIncs.size, sim.label).toBe(episodes.length);
    for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
      sim.enter(sp);
      const { casino, table } = sp.p;
      // Swept: the old round's incarnation ended as a removal ends it, the
      // list's chips back, the computed table as it was.
      expect(casino.readTableState(T1), `${sim.label} ${sp.name}`).toBeNull();
      for (const inc of legacyIncs) expect(casino.tableIncRemoved(T1, inc), `${sim.label} ${sp.name}`).toBe(true);
      expect(table.computedOldBuildDriving(T1), sim.label).toBe(false);
      expect(casino.isComputedTable(T1), sim.label).toBe(true);
      expect(casino.readChips(ghost.pid), `${sim.label} ${sp.name}`).toBe(1_000);
      // This build's page holds the lease again.
      expect(casino.readTableOperatorLease()?.build, sim.label).toBe(casino.TABLE_BUILD);
    }
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(20));
  }, TIMEOUT);

  it("held partial updates: one page hears the house late, so the players' felts in a session the house just made reach it first", async () => {
    // (The house's page only runs the room: a felt of its own, heard late,
    // would start E's betting window on another slip than the others', and
    // two honest closes cross: the slow-network scenario's rival close.)
    const sim = await Sim.open({ name: 'held-partial', seed: seed(14), pages: [{ name: 'A', bot: null }, ...named('BCDE')] });
    const { house } = sim;
    const e = sim.pages.find((sp) => sp.name === 'E')!;
    // The house's updates reach E 2-3.5 s late, the others' at once; each
    // switch-on (a new incarnation, its first session the house's map) has
    // the players' felts in it at E before the map.
    sim.net.setLink(house, e, { delay: [2_000, 3_500] });
    const offs: number[] = [];
    for (let at = 40_000; at < RUN_MS - 40_000; at += 50_000) offs.push(at);
    const { incs } = switchCycles(sim, offs, 15_000);
    let held = 0;
    sim.every(() => {
      if (e.partial) held += 1;
    });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(incs.length, sim.label).toBe(offs.length + 1);
    expect(e.partialEpisodes, sim.label).toBeGreaterThan(0);
    expect(held, sim.label).toBeGreaterThan(0);
    // E's doc, holding part of an update, asked the room for the rest.
    expect(e.resyncAsks, sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it('clock steps and wakes: clocks jump back and forward, pages sleep (their docs syncing or not) and wake', async () => {
    const sim = await Sim.open({ name: 'clock-steps', seed: seed(15), pages: named('ABCDE') });
    const did: Record<string, number> = {};
    const count = (k: string): void => { did[k] = (did[k] ?? 0) + 1; };
    const sleep = (sp: SimPage, r: () => number, ms: number): void => {
      const syncing = r() < 0.5;
      sim.sleep(sp, syncing);
      count(syncing ? 'sleep' : 'sleep offline');
      sim.at(sim.elapsed + ms, () => {
        if (sp.mode === 'asleep') sim.wake(sp);
      });
    };
    const event = async (): Promise<void> => {
      if (sim.healed) return;
      const r = sim.rand;
      const ups = sim.pages.filter((sp) => sp.mode === 'up');
      // (Every page asleep: nothing to move this time.)
      if (ups.length > 0) {
        const sp = ups[between(r, 0, ups.length - 1)];
        const x = r();
        if (x < 0.3) {
          sim.step(sp, -between(r, 2_000, 20_000));
          count('back');
        } else if (x < 0.5) {
          sim.step(sp, between(r, 7_000, 30_000));
          count('forward');
        } else {
          sleep(sp, r, between(r, 3_000, 40_000));
        }
      }
      sim.at(sim.elapsed + between(r, 8_000, 20_000), event);
    };
    sim.at(10_000, event);
    // One step back at a set moment, whatever the draws.
    sim.at(30_000, () => {
      sim.step(sim.pages[2], -5_000);
      count('back');
    });
    // And aimed at the closing: a page frozen in a close, a third of the
    // times one comes, steps its clock or sleeps as it sees it (its reveal,
    // its grace, its forfeit or its answer run across the step or the wake).
    const aimed = new Set<string>();
    for (const sp of sim.pages) {
      sp.beforeFrame = () => {
        const tip = sp.p.casino.computedFoldOf(T1)?.tip;
        if (!tip || !tip.present.includes(sp.pid) || aimed.has(`${sp.name}|${tip.close}`)) return true;
        aimed.add(`${sp.name}|${tip.close}`);
        const r = sim.rand;
        if (r() > 0.35) return true;
        const x = r();
        if (x < 0.25) {
          sim.step(sp, -between(r, 2_000, 8_000));
          count('aimed back');
        } else if (x < 0.45) {
          sim.step(sp, between(r, 7_000, 15_000));
          count('aimed forward');
        } else {
          sleep(sp, r, between(r, 2_000, 12_000));
          count('aimed sleep');
          return false;
        }
        return true;
      };
    }
    await sim.run(RUN_MS);
    // Scoped (pr2-pr-notes.md Known limits: a page away mid-round forfeits
    // unless it reveals within the grace; pr2-verdict.md Q4): a page that
    // slept as a round closed, or whose clock moved, reveals late, or reads
    // late seeds that came to it while it was away (asleep offline for under
    // a lapse: no wake to tell it). Late on some page, a seed is forfeited
    // there, and that forfeit beats the full set the others showed; a page
    // that saw it in time may answer. Only where a page frozen in the round,
    // or the forfeit's writer, was away or stepped as it closed; every other
    // forfeit counts exactly the seeds that came in its grace (the run's
    // check), and every page still agrees.
    const s = await finish(sim, { awayFlips: ['forfeit over reveals', 'answer forfeit'] });
    expect(did.back ?? 0, sim.label).toBeGreaterThan(0);
    expect((did.sleep ?? 0) + (did['sleep offline'] ?? 0), sim.label).toBeGreaterThan(0);
    expect((did['aimed back'] ?? 0) + (did['aimed forward'] ?? 0) + (did['aimed sleep'] ?? 0), sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it("a stale-cache join: a page comes back on the room cache from when it went, and acts only once the room's state is in", async () => {
    const sim = await Sim.open({ name: 'stale-cache', seed: seed(16), pages: named('ABCDE') });
    const joins: { name: string; frozen: boolean }[] = [];
    const goAndComeBack = (sp: SimPage, frozen: boolean): void => {
      const cache = Y.encodeStateAsUpdate(sp.p.doc);
      sim.crash(sp);
      sim.at(sim.elapsed + between(sim.rand, 20_000, 50_000), async () => {
        // Its handshake slow both ways: frames on the stale doc meanwhile.
        for (const q of sim.pages) {
          if (q === sp) continue;
          sim.net.setLink(q, sp, { delay: [2_000, 3_000] });
          sim.net.setLink(sp, q, { delay: [2_000, 3_000] });
        }
        await sim.reload(sp, { cache });
        joins.push({ name: sp.name, frozen });
        sim.at(sim.elapsed + 6_000, () => {
          for (const q of sim.pages) {
            sim.net.setLink(q, sp, sim.net.base);
            sim.net.setLink(sp, q, sim.net.base);
          }
        });
      });
    };
    // Each goes as a close freezes its felt, before its reveal (its seed in
    // the store, the close in its cache), or at a random moment.
    for (const sp of sim.pages.slice(1)) {
      let armed = sim.rand() < 0.75;
      sp.beforeFrame = () => {
        if (!armed || sim.elapsed < 20_000) return true;
        const tip = sp.p.casino.computedFoldOf(T1)?.tip;
        if (tip && tip.present.includes(sp.pid) && !tip.revealed.includes(sp.pid)) {
          armed = false;
          goAndComeBack(sp, true);
          return false;
        }
        return true;
      };
    }
    sim.at(75_000, () => {
      const sp = sim.pages[1];
      if (sp.mode === 'up') goAndComeBack(sp, false);
    });
    await sim.run(RUN_MS);
    // Scoped (pr2-pr-notes.md Known limits: a page away mid-round forfeits
    // unless it reveals within the grace; pr2-verdict.md Q4): the page that
    // goes at a random moment leaves its felt on the table, a close may
    // freeze it while the page is away, and it may be back within some
    // page's grace and not another's. Its seed then comes late on a page
    // that forfeits it, and that forfeit beats the full set the page back
    // (or one that saw the seed in time) showed; such a page may answer.
    // Only where a page frozen in the round, or the forfeit's writer, was
    // away as it closed; every other forfeit counts exactly the seeds that
    // came in its grace (the run's check), and every page still agrees.
    const s = await finish(sim, { awayFlips: ['forfeit over reveals', 'answer forfeit'] });
    expect(joins.filter((j) => j.frozen).length, sim.label).toBeGreaterThan(0);
    // Nothing computed written before the room's state came (a violation each).
    expect(sim.pages.reduce((n, sp) => n + sp.earlyWrites, 0), sim.label).toBe(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it('abandoned: every bettor a close froze goes before its reveal; the seated page voids the round, and the void stands as they come back', async () => {
    // W sits at the table and bets nothing: a seat makes it one of the pages
    // that void a round nobody can finish (abandonDuty). Its computer sleeps
    // through part of the wait (its doc syncing), which starts again as it
    // wakes (checkOwnAbandons).
    const sim = await Sim.open({ name: 'abandoned', seed: seed(17), pages: [{ name: 'W', bot: { ...BOT, place: 0 } }, ...named('BCD')] });
    const w = sim.pages[0];
    const bettors = sim.pages.slice(1);
    const { table } = w.p;
    let armed = false;
    let target: string | null = null;
    const gone: SimPage[] = [];
    const firstSeen = new Map<string, number>();
    let voided: { at: number; r: number; held: bigint[]; stood: boolean } | null = null;
    let slept: { from: number; to: number | null } | null = null;
    sim.at(40_000, () => { armed = true; });
    // Each frozen bettor goes as it sees the close, before its reveal; and
    // the rest with them (W is the one page left to void it), until it has.
    for (const sp of bettors) {
      sp.beforeFrame = () => {
        const tip = sp.p.casino.computedFoldOf(T1)?.tip;
        if (armed && target === null && tip && tip.present.includes(sp.pid) && !tip.revealed.includes(sp.pid)) target = tip.close;
        if (target === null || voided !== null || (tip?.close === target && tip.revealed.includes(sp.pid))) return true;
        sim.crash(sp);
        gone.push(sp);
        return false;
      };
    }
    sim.every(() => {
      sim.enter(w);
      const res = w.p.casino.computedFoldOf(T1);
      if (!res) return;
      if (res.tip && !firstSeen.has(res.tip.close)) firstSeen.set(res.tip.close, sim.T);
      // A second after W saw the close, it sleeps for 8-14 s.
      if (target !== null && slept === null && firstSeen.has(target) && sim.T - firstSeen.get(target)! >= 1_000 && w.mode === 'up') {
        slept = { from: sim.T, to: null };
        sim.sleep(w, true);
        sim.at(sim.elapsed + between(sim.rand, 8_000, 14_000), () => {
          sim.wake(w);
          slept!.to = sim.T;
        });
      }
      const v = target === null ? undefined : res.rounds.find((x) => x.close === target);
      if (!v?.decided) return;
      if (!voided) {
        voided = { at: sim.T, r: v.r, held: v.present.map((pid) => res.held.get(pid) ?? 0n), stood: true };
        // They come back 10 s on, their seeds in their profiles' stores.
        sim.at(sim.elapsed + 10_000, async () => {
          for (const sp of gone) if (sp.mode === 'gone') await sim.reload(sp);
        });
      } else if (v.decided !== 'void' && voided.stood) {
        voided.stood = false;
        sim.violate(`round ${v.r}, voided at ${voided.at - SIM_T0} ms, reads ${v.decided} at ${sim.elapsed} ms`);
      }
    });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(target, sim.label).not.toBeNull();
    expect(gone.length, sim.label).toBeGreaterThan(0);
    expect(voided, sim.label).not.toBeNull();
    const { at, held } = voided!;
    // Voided, not before ABANDON_MS from W's wake (its wait started again
    // there), and within it plus every page's turn and a second's slack.
    const woke = (slept as { to: number | null } | null)?.to ?? null;
    expect(woke, sim.label).not.toBeNull();
    const from = Math.max(firstSeen.get(target!)!, woke!);
    expect(at - from, sim.label).toBeGreaterThanOrEqual(table.ABANDON_MS);
    expect(at - from, sim.label).toBeLessThanOrEqual(table.ABANDON_MS + sim.pages.length * table.STAGGER_MS + 1_000);
    expect(s.abandonsChecked, sim.label).toBeGreaterThan(0);
    // Its stakes released as it voided.
    expect(held, sim.label).toEqual(held.map(() => 0n));
    expect(s.voids, sim.label).toBeGreaterThan(0);
    expect(gone.every((sp) => sp.mode === 'up'), sim.label).toBe(true);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);
});
