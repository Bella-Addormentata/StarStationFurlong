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
import { asCheckpoint, canon, nextSid } from './computedFold';
import { HOUSE_HEARD_MS } from './computedHouse';
import type { Checkpoint, FoldCtx, FoldResult } from './computedFold';
import { PAGE_ROOM } from './computedPageKit';
import { ComputedKit, red, testIdentity } from './computedTestKit';
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
  /** How many rounds past TRIM_BYTES the live session may run (1 unless
   *  given): a trim waits for no close in (computedTable trimDuty), so a
   *  cheat standing over a round's show puts it off a round. */
  sessionRounds?: number;
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
  const line = `${Sim.line(s, sim.worstStall.at)}\n${sim.robots.line()}`;
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
  // (Nor in the robot frame it runs on every page first.)
  expect(sim.violations, sim.label).toEqual([]);
  for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
    expect(sim.ledgerProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
    expect(sim.cageProblems(sp), `${sim.label} ${sp.name}`).toEqual([]);
  }
  expect(s.maxDocBytes, sim.label).toBeLessThan(1_000_000);
  // The live session within a round of TRIM_BYTES: a trim runs in the show
  // of the round that takes it past.
  expect(s.maxSessionBytes, sim.label).toBeLessThanOrEqual(table.TRIM_BYTES + (opts.sessionRounds ?? 1) * s.maxRoundBytes);
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
    // seed lost on one link is asked for 2.5 s after the close (computedTable
    // askDuty), and the room's answer, 300-800 ms on, is mostly in before the
    // 4 s grace runs out; when it isn't (the answer lost too, or a seed out
    // late on a slow link), the page it was lost to forfeits it, and a
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
    // Scoped (pr2-pr-notes.md Known limits: a page away mid-round forfeits
    // unless it reveals within the grace; pr2-verdict.md Q4): a page that
    // crashed with its felt down and is loaded again just as the grace runs
    // out reveals from its store, its seed in time on some page and late on
    // another; the round reads the full set on the page back (and on any it
    // reached in time) until the forfeit of the page it was late on comes,
    // and beats it; such a page may answer. Only where a page frozen in the
    // round, or the forfeit's writer, was away as it closed (SIM_SEED=505
    // at 752ef48 already: E crashed at 12 s, round 1 closed at 19.2 s with
    // its felt, E back at 22.25 s, F's forfeit at 23.2 s).
    const s = await finish(sim, { awayFlips: ['forfeit over reveals', 'answer forfeit'] });
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
          // (A slip goes back once a close on its author's chain, or one
          // open there, froze it: computedTable reputDuty. While its round
          // is off that chain, a record before it gone too, and no open
          // close names the round, a burned felt is let go of for the
          // while, by design; its beat counts from when the chain is back.
          // SIM_SEED=3000: D's round-2 slip taken at 149 s, B's round-1
          // close at 149.25 s, D's beat at 150 s found no chain at all, and
          // the slip went back at 151 s, once B had put its close back.)
          if (key.startsWith('s:') && !res.rounds.some((round) => round.r === e.r) && !res.openCloses.some((c) => c.rec.r === e.r)) {
            e.missing = sim.T;
          }
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
    expect(sim.violations, sim.label).toEqual([]);
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
      // And beats its robot croupier, as its build's operator does (every
      // 3 s): no robot of this build's at the table moves for it.
      for (let b = at + 4_000; b < at + 12_000; b += 3_000) sim.at(b, () => sim.as(ghost, (now) => ghost.p.casino.writeCroupierBeat(T1, now)));
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

  it('lone stall: one page at a time cut off from everyone, or deaf to them, for 5-20 s, mostly just after a close reaches it, its frames running', async () => {
    // A wifi blip, or the node's link to the host stalling, for longer than
    // the grace right after a close: the page hears no seeds, and nobody.
    // Half the stalls are of its downlink alone (Net.deaf): what it sends
    // still goes, its own seed among them, so the rest of the room shows the
    // full set while it sees none of their seeds — the forfeit the hearing
    // gate keeps it from writing would beat that set (pr2-verdict.md Q4).
    const sim = await Sim.open({ name: 'lone-stall', seed: seed(18), pages: named('ABCDE') });
    const cuts: { name: string; from: number; to: number; aimed: boolean; deaf: boolean }[] = [];
    let cut: { sp: SimPage; until: number } | null = null;
    let target: { sp: SimPage; aimed: boolean; was: string | null; at: number | null } | null = null;
    let next = SIM_T0 + 15_000;
    let last: SimPage | null = null;
    /** The close of the tip on page sp, when its player has a felt in it. */
    const tipOf = (sp: SimPage): string | null => {
      sim.enter(sp);
      const tip = sp.p.casino.computedFoldOf(T1)?.tip;
      return tip?.present.includes(sp.pid) ? tip.close : null;
    };
    sim.every(() => {
      if (cut) {
        if (sim.T < cut.until && !sim.healed) return;
        sim.net.groups = null;
        sim.net.deaf.clear();
        cuts[cuts.length - 1].to = sim.T;
        cut = null;
        next = sim.T + between(sim.rand, 3_000, 10_000);
      }
      if (sim.healed || sim.T < next) return;
      // A page, never the one cut off last; four times in five as the next
      // close that freezes its player's felt reaches it (0-3 s on, half the
      // time at once or a tick or two on, while the seeds are still coming:
      // a stall then is the one that misses some, its own or the others'),
      // else at once, whatever it is doing.
      if (!target) {
        const cands = sim.pages.filter((sp) => sp !== last);
        const sp = cands[between(sim.rand, 0, cands.length - 1)];
        const aimed = sim.rand() < 0.8;
        target = { sp, aimed, was: tipOf(sp), at: aimed ? null : sim.T };
      }
      if (target.at === null) {
        const tip = tipOf(target.sp);
        if (tip === null || tip === target.was) {
          target.was = tip;
          return;
        }
        target.at = sim.T + (sim.rand() < 0.5 ? between(sim.rand, 0, 2) * SIM_STEP : between(sim.rand, 500, 3_000));
      }
      if (sim.T < target.at) return;
      const sp = target.sp;
      const deaf = sim.rand() < 0.5;
      if (deaf) sim.net.deaf.add(sp.name);
      else sim.net.groups = [[sp.name], sim.pages.filter((q) => q !== sp).map((q) => q.name)];
      cut = { sp, until: sim.T + between(sim.rand, 5_000, 20_000) };
      cuts.push({ name: sp.name, from: sim.T, to: cut.until, aimed: target.aimed, deaf });
      last = sp;
      target = null;
    });
    await sim.run(RUN_MS);
    if (cut) cuts[cuts.length - 1].to = sim.T;
    console.log(`[sim] lone-stall seed=${sim.opts.seed}: ${cuts.length} stalls (${cuts.filter((c) => c.aimed).length} aimed, ${cuts.filter((c) => c.deaf).length} deaf only), ${Math.round(cuts.reduce((n, c) => n + c.to - c.from, 0) / 1000)} s in all`);
    // Scoped: no page cut off alone forfeits what it couldn't hear (it hears
    // nobody: computedTable heardThrough), so no round the room showed
    // decided by its seeds is rewritten, and no answer is called for. Only
    // the page cut off may read a round otherwise, while it is cut off or as
    // it comes back (the next resync, a link's delay on): its own close of a
    // round the room closed without it (by the chain rule, the room's), a
    // trim's other side ('other branch', found once the run is over), or,
    // stalled as the round closed, a forfeit of its own seed, late, by a
    // page that heard the room, over the full set its doc showed as it
    // caught up (pr2-pr-notes.md Known limits: a page away mid-round
    // forfeits unless it reveals within the grace). And one exception,
    // counted: the rest of the room may read a round otherwise by a close
    // the page cut off wrote (just before its stall, the close lost on its
    // way, or, deaf, without seeing the room's), heard as it came back or as
    // it was written, that the chain rule picks by rank over the room's, no
    // round gone on from theirs yet, decided by no forfeit of the page cut
    // off (pr2-pr-notes.md Known limits: the close of a page whose link
    // stalled can rewrite a round on the heal; the tie-break of two decided
    // chains of one length is the design's, pr2-verdict.md Q2).
    const s = await finish(sim, { flips: ['other branch', 'rival close', 'forfeit over reveals'] });
    expect(cuts.filter((c) => c.aimed).length, sim.label).toBeGreaterThan(0);
    expect(cuts.filter((c) => c.deaf).length, sim.label).toBeGreaterThan(0);
    const stalled = (sp: SimPage, from: number, to: number): boolean => cuts.some((c) => c.name === sp.name && c.from <= to && from <= c.to);
    const cutOff = (sp: SimPage, T: number): boolean => stalled(sp, T - RESYNC_MS - 1_000, T);
    let theirs = 0;
    let late = 0;
    for (const sp of sim.pages) {
      sim.enter(sp);
      const rounds = sp.p.casino.computedFoldOf(T1)?.rounds ?? [];
      for (const f of sp.flipEvents) {
        const v = rounds.find((x) => x.close === f.close);
        const why = `${sim.label} ${sp.name} ${f.kind} at ${f.T - SIM_T0}: ${sp.flipLog.join('; ')}`;
        expect(f.kind, why).not.toBe('answer forfeit');
        if (f.kind === 'forfeit over reveals') {
          const at = sim.closeFirstAt(f.close) ?? f.T;
          const F = v?.forfeit?.rec;
          expect(stalled(sp, at, at) && F !== undefined && F.k !== sp.p.pub && !F.n.includes(sp.pid), why).toBe(true);
          late += 1;
          continue;
        }
        if (cutOff(sp, f.T)) continue;
        const writer = sim.pages.find((q) => q !== sp && q.p.pub === v?.closeRec.k);
        const rival = f.kind === 'rival close' && writer !== undefined && cutOff(writer, f.T) && f.fk !== writer.p.pub;
        expect(rival, why).toBe(true);
        theirs += 1;
      }
      // Every round decided or voided (the quiet period settled every page).
      expect(sp.p.casino.computedFoldOf(T1)?.tip ?? null, `${sim.label} ${sp.name}`).toBeNull();
    }
    console.log(`[sim] lone-stall seed=${sim.opts.seed}: ${theirs} flips on pages not stalled, by a stalled page's close; ${late} of a stalled page's own late seed`);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(15));
  }, TIMEOUT);

  it('two pages, one away: the other page sleeps (no frames, no ticks) for 10-60 s, often just after a close freezes it, before its reveal', async () => {
    // A backgrounded tab in a room of two: the page left awake hears nobody,
    // so it forfeits nothing; the round voids ABANDON_MS on (its stakes
    // back), or is decided by the sleeper's seed if it is back before then.
    const sim = await Sim.open({ name: 'two-page-away', seed: seed(19), pages: named('AB') });
    const [a, b] = sim.pages;
    const { table } = a.p;
    /** By close: rounds B slept through, frozen before its seed went (the
     *  room's time it went, and woke). */
    const slept = new Map<string, { r: number; from: number; to: number | null; syncing: boolean }>();
    const episodes: { aimed: boolean; from: number; ms: number; syncing: boolean; relink: number }[] = [];
    let armed: { aimed: boolean } | null = null;
    let away: { from: number; syncing: boolean } | null = null;
    /** B back in the room (its seed can reach A from now): the room's time. */
    const backInRoom = (): void => {
      for (const e of slept.values()) e.to ??= sim.T;
      away = null;
      if (!sim.healed) sim.at(sim.elapsed + between(sim.rand, 10_000, 30_000), () => { armed = { aimed: sim.rand() < 0.7 }; });
    };
    const goToSleep = (aimed: boolean): void => {
      const n = episodes.length;
      // (Long and short in turn: the void and the seed back in time both come.)
      const ms = n % 2 === 0 ? between(sim.rand, 35_000, 60_000) : between(sim.rand, 10_000, 25_000);
      // An offline sleep may wake to a link that takes 3-20 s to come back
      // (a laptop's lid opened: the page runs at once, its node's link to
      // the room dials again over the wifi), hearing nobody meanwhile: the
      // first two do (a long and a short one), the rest half the time.
      const syncing = n >= 2 && sim.rand() < 0.5;
      const relink = !syncing && (n < 2 || sim.rand() < 0.5) ? between(sim.rand, 3_000, 20_000) : 0;
      episodes.push({ aimed, from: sim.T, ms, syncing, relink });
      sim.sleep(b, syncing);
      away = { from: sim.T, syncing };
      armed = null;
      sim.at(sim.elapsed + ms, () => {
        if (relink > 0 && !sim.healed) sim.net.groups = [[a.name], [b.name]];
        if (b.mode === 'asleep') sim.wake(b);
        if (relink === 0 || sim.healed) {
          backInRoom();
          return;
        }
        sim.at(sim.elapsed + relink, () => {
          sim.net.groups = null;
          sim.net.connect(b);
          backInRoom();
        });
      });
    };
    sim.at(10_000, () => { armed = { aimed: true }; });
    b.beforeFrame = () => {
      if (!armed || sim.healed) return true;
      const tip = b.p.casino.computedFoldOf(T1)?.tip;
      if (armed.aimed && !(tip && tip.present.includes(b.pid) && !tip.revealed.includes(b.pid))) return true;
      goToSleep(armed.aimed);
      return false;
    };
    // A round's close that froze B's felt, B asleep before its seed went.
    sim.every(() => {
      if (!away) return;
      sim.enter(a);
      const tip = a.p.casino.computedFoldOf(T1)?.tip;
      if (tip && tip.present.includes(b.pid) && !tip.revealed.includes(b.pid) && !slept.has(tip.close)) {
        slept.set(tip.close, { r: tip.r, from: away.from, to: null, syncing: away.syncing });
      }
    });
    // When A first read each close come, and each round decided, and how.
    const closeAt = new Map<string, number>();
    const decidedAt = new Map<string, { T: number; how: string }>();
    sim.every(() => {
      sim.enter(a);
      for (const v of a.p.casino.computedFoldOf(T1)?.rounds ?? []) {
        if (!closeAt.has(v.close)) closeAt.set(v.close, sim.T);
        if (v.decided && !decidedAt.has(v.close)) decidedAt.set(v.close, { T: sim.T, how: v.decided });
      }
    });
    await sim.run(RUN_MS);
    // (Still asleep, or its link not back, as the run ends: the heal brings it back.)
    for (const e of slept.values()) e.to ??= sim.T;
    // Unscoped: no flips at all; the page left awake forfeits nothing.
    const s = await finish(sim);
    expect(episodes.filter((e) => e.aimed).length, sim.label).toBeGreaterThan(0);
    expect(slept.size, sim.label).toBeGreaterThan(0);
    expect(s.byForfeit, sim.label).toBe(0);
    sim.enter(a);
    const kept = new Map<string, string>();
    for (const f of sim.cold(a).folds.values()) for (const v of f.res.rounds) if (v.decided) kept.set(v.close, v.decided);
    let voids = 0;
    let back = 0;
    for (const [close, e] of slept) {
      const how = kept.get(close) ?? decidedAt.get(close)?.how;
      const label = `${sim.label} round ${e.r} (B away ${(e.from - SIM_T0) / 1000}-${e.to === null ? '…' : (e.to - SIM_T0) / 1000}s, ${e.syncing ? 'syncing' : 'offline'})`;
      // Void, or decided by B's seed once it was back in time: before A's
      // abandon (ABANDON_MS after it saw the close, in its turn of the two),
      // and as A first read it decided (a void the seed beat after is a flip).
      expect(['void', 'reveals'], label).toContain(how);
      expect(decidedAt.get(close)?.how, label).toBe(how);
      if (how === 'reveals') {
        back += 1;
        expect(e.to, label).not.toBeNull();
        expect(e.to! - closeAt.get(close)!, label).toBeLessThan(table.ABANDON_MS + 2 * table.STAGGER_MS + 2 * SIM_STEP);
      } else {
        voids += 1;
      }
    }
    expect(voids, sim.label).toBeGreaterThan(0);
    expect(s.voids, sim.label).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(10));
    // (How many came back in time, for the line.)
    console.log(`[sim] two-page-away seed=${sim.opts.seed}: ${episodes.length} sleeps (${episodes.filter((e) => e.aimed).length} aimed, ${episodes.filter((e) => e.relink > 0).length} its link back late), ${slept.size} rounds slept through: ${voids} void, ${back} by the seed back in time`);
  }, TIMEOUT);

  it("felt sleeps: two pages draw the table, and sleep right as their robot waits a frame for the felt to take a result", async () => {
    // (The robot's wake rule: a result not on screen yet isn't counted as
    // said. It is called after the wake while its show runs, or is the
    // design's silent one if its show passed meanwhile.)
    // (Slow links, so a page woken on a close still shows it a while
    // before the seeds come.)
    const sim = await Sim.open({ name: 'felt-sleeps', seed: seed(20), pages: named('ABCD'), link: { delay: [300, 800], loss: 0 } });
    /** The sleeps meant, in turn (whatever the draws), and how each came
     *  out, told on the page's first frame back. */
    const KINDS = ['wake in the show', 'pause', 'wake past the show'] as const;
    const meant: Record<string, number> = {};
    const came: Record<string, number> = {};
    type Sleep = { sp: SimPage; kind: string; wakes: number; r: number };
    let sleeps = 0;
    /** The sleep each page is in (one at a time: a waker of an earlier one
     *  wakes nothing), and those asleep until their doc has a later round
     *  closed, its result not in yet. */
    const asleep = new Map<SimPage, Sleep>();
    const past: Sleep[] = [];
    const wakeIf = (e: Sleep): void => {
      if (asleep.get(e.sp) === e && e.sp.mode === 'asleep') sim.wake(e.sp);
    };
    for (const sp of sim.pages.slice(0, 2)) {
      sp.robotMotion = () => ({ moving: false, drawn: true });
      sp.afterRobot = (now) => {
        const back = asleep.get(sp);
        if (back) {
          asleep.delete(sp);
          // (A wake moves the count on this frame's noteTablesRunning.)
          const v = sp.p.table.readComputedRoulette(T1, now);
          const k = sp.p.croupier.tablesWakeCount() === back.wakes ? 'paused'
            : v?.phase === 'settled' && v.round === back.r ? 'woke in the show'
              : v?.spinKey.startsWith(`${back.r}:`) ? 'woke past the show' : 'woke to a later result';
          came[k] = (came[k] ?? 0) + 1;
        }
        if (sim.healed || !sim.robots.stillComing(sp, T1)) return;
        const kind = KINDS[sleeps++ % KINDS.length];
        meant[kind] = (meant[kind] ?? 0) + 1;
        const e: Sleep = { sp, kind, wakes: sp.p.croupier.tablesWakeCount(), r: sp.p.table.readComputedRoulette(T1, now)?.round ?? 0 };
        asleep.set(sp, e);
        // A pause too short to be a wake: the robot calls it as it would
        // have. A wake back in the show it brings again. Or a wake once the
        // next round has closed (its doc hearing the room): the result's
        // show long past, its key still on screen.
        const ms = kind === 'pause' ? between(sim.rand, 1_000, 4_000) : kind === 'wake in the show' ? between(sim.rand, 7_000, 12_000) : 90_000;
        if (kind === 'wake past the show') past.push(e);
        sim.sleep(sp, kind === 'wake past the show' || sim.rand() < 0.5);
        sim.at(sim.elapsed + ms, () => wakeIf(e));
      };
    }
    sim.every(() => {
      for (const w of [...past]) {
        if (asleep.get(w.sp) !== w) {
          past.splice(past.indexOf(w), 1);
          continue;
        }
        // (Its own doc: a wake before a later close would show the last
        // result again, and one after that round's seeds, a new one.)
        sim.enter(w.sp);
        const tip = w.sp.p.casino.computedFoldOf(T1)?.tip;
        if (!tip || tip.r <= w.r) continue;
        past.splice(past.indexOf(w), 1);
        wakeIf(w);
      }
    });
    await sim.run(RUN_MS);
    // Scoped as clock steps are: a page asleep as a round closed reveals late.
    const s = await finish(sim, { awayFlips: ['forfeit over reveals', 'answer forfeit'] });
    // (A wake on a close shows it until the seeds come, or, if they come
    // that tick, the next result: either way the slept one's show passed.)
    for (const k of ['paused', 'woke in the show']) expect(came[k] ?? 0, `${sim.label} ${k}`).toBeGreaterThan(0);
    expect((came['woke past the show'] ?? 0) + (came['woke to a later result'] ?? 0), `${sim.label} woke past the show`).toBeGreaterThan(0);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(10));
    console.log(`[sim] felt-sleeps seed=${sim.opts.seed}: sleeps on the felt's frame ${JSON.stringify(meant)}, back ${JSON.stringify(came)}`);
  }, TIMEOUT);
});

// ── 🏠 The house (PR 5) ──────────────────────────────────────────────────────

describe("the house: the owner's node adds its seed to the rounds (computedSimHouse, house.rs's twin)", () => {
  it("fair: the owner's node runs the whole time; its reveal decides every round, none forfeited or void", async () => {
    // Heavy felts, so the session trims under the house's rounds.
    const sim = await Sim.open({ name: 'house-fair', seed: seed(901), pages: named('ABCD'), houseNode: true, bot: HEAVY_BOT });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    const node = sim.node!;
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(scaled(26));
    expect(s.byReveals + s.byForfeit + s.voids, sim.label).toBe(0);
    // It joined round 1 and carried every commitment on from there (its
    // reveals, and the checkpoints' `h` across each trim).
    expect(node.wrote.joins, sim.label).toBe(1);
    expect(node.wrote.reveals, sim.label).toBeGreaterThanOrEqual(s.byHouse);
    expect(node.wrote.beats, sim.label).toBeGreaterThan(0);
    expect(node.refusals + node.blockedSeen, sim.label).toBe(0);
    expect(s.trims, sim.label).toBeGreaterThan(0);
  }, TIMEOUT);

  it('outage: the node is down for 40 s twice and restarts; the round it left goes void, and it joins the next', async () => {
    const sim = await Sim.open({ name: 'house-outage', seed: seed(902), pages: named('ABCD'), houseNode: true });
    for (const at of [50_000, 115_000]) {
      sim.at(at, () => { sim.nodeUp = false; });
      sim.at(at + 40_000, () => {
        sim.node!.restart();
        sim.nodeUp = true;
      });
    }
    await sim.run(RUN_MS);
    const s = await finish(sim);
    const node = sim.node!;
    // 40 s is too short for a Friendly round between: the void takes the
    // round its close named the house in, and the node's join the next.
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    expect(s.voids, sim.label).toBeGreaterThanOrEqual(1);
    expect(s.voids, sim.label).toBeLessThanOrEqual(4);
    expect(node.wrote.joins, sim.label).toBeGreaterThanOrEqual(3);
  }, TIMEOUT);

  it('long outage: the node is down for 70 s; after the void the table runs Friendly on the bettors\' seeds, then the house joins again', async () => {
    const sim = await Sim.open({ name: 'house-long-outage', seed: seed(906), pages: named('ABCD'), houseNode: true });
    const episodes = SIM_LONG ? [40_000, 400_000, 700_000] : [40_000];
    for (const at of episodes) {
      sim.at(at, () => { sim.nodeUp = false; });
      sim.at(at + 70_000, () => {
        sim.node!.restart();
        sim.nodeUp = true;
      });
    }
    await sim.run(RUN_MS);
    const s = await finish(sim);
    const node = sim.node!;
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    expect(s.byReveals, sim.label).toBeGreaterThan(0);
    expect(s.voids, sim.label).toBeGreaterThanOrEqual(1);
    expect(s.voids, sim.label).toBeLessThanOrEqual(2 * episodes.length);
    expect(node.wrote.joins, sim.label).toBeGreaterThanOrEqual(1 + episodes.length);
  }, TIMEOUT);

  it('owner sets Friendly and back: the house steps down with no void, and joins again', async () => {
    const sim = await Sim.open({ name: 'house-friendly', seed: seed(903), pages: named('ABCD'), houseNode: true });
    const set = (mode: 'fair' | 'friendly') => async (): Promise<void> => {
      const answer = await sim.as(sim.house, (now) => sim.house.p.table.setComputedFairness(T1, mode, now));
      if (answer !== 'ok') sim.violate(`setComputedFairness ${mode} answered ${answer}`);
    };
    sim.at(55_000, set('friendly'));
    sim.at(110_000, set('fair'));
    await sim.run(RUN_MS);
    const s = await finish(sim);
    const node = sim.node!;
    expect(s.voids, sim.label).toBe(0);
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    expect(s.byReveals, sim.label).toBeGreaterThan(0);
    expect(node.wrote.joins, sim.label).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  it('the app quits: the node steps down and stops a second later; at most the round it closed on goes void', async () => {
    const sim = await Sim.open({ name: 'house-quit', seed: seed(904), pages: named('ABCD'), houseNode: true });
    sim.at(80_000, () => { sim.node!.steppingDown = true; });
    sim.at(81_000, () => { sim.nodeUp = false; });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    expect(s.byReveals, sim.label).toBeGreaterThan(0);
    expect(s.voids, sim.label).toBeLessThanOrEqual(1);
  }, TIMEOUT);

  it('split: the owner and one player apart from two for 50 s; the far side gives up the round that named the house, and the house side\'s chain stands', async () => {
    const sim = await Sim.open({ name: 'house-split', seed: seed(905), pages: named('ABCD'), houseNode: true });
    sim.at(60_000, () => { sim.net.groups = [['A', 'B'], ['C', 'D']]; });
    sim.at(110_000, () => { sim.net.groups = null; });
    await sim.run(RUN_MS);
    // The far side's rounds while apart are undone, or replaced by the house
    // side's (whose chain has the latest round the house decided).
    const s = await finish(sim, { flips: ['other branch', 'checkpoint', 'undone', 'rival close', 'forfeit over reveals', 'answer forfeit'] });
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
    // The far side gave up on the round that named the house (an abandon),
    // and its pages read the house side's rounds once healed. The house
    // side's chain, with the latest round the house decided, never flipped.
    expect(s.abandonsChecked, sim.label).toBeGreaterThanOrEqual(1);
    expect(s.flips.C + s.flips.D, sim.label).toBeGreaterThan(0);
    expect(s.flips.A + s.flips.B, sim.label).toBe(0);
  }, TIMEOUT);

  it("reveal, then deaf: a page has the house's reveal but not a seed it counted, and stops hearing anyone; it waits the full 30 s, not the 15 s of an unheard house", async () => {
    // C's uplink is slow, to the house's page (A) less so than to B and D:
    // its seed is the last the house sees, and D has the house's reveal of
    // the close before C's seed in it (the fold's houseWaits). Then D's downlink
    // stalls (Net.deaf) until 26 s after the close reached it: no seed and
    // no beat of the house's. An unheard house voids a Fair round at 15 s,
    // but not one whose reveal is in (computedTable abandonWait): D waits
    // 30 s, so it hears the seed as the stall ends and nothing goes void.
    // (The sim's own check holds every abandon to that: checkOwnAbandons.)
    const sim = await Sim.open({ name: 'house-reveal-deaf', seed: seed(907), pages: named('ABCD'), houseNode: true });
    const [a, b, c, d] = sim.pages;
    sim.net.setLink(c, a, { delay: [1_500, 2_000] });
    sim.net.setLink(c, b, { delay: [6_000, 7_000] });
    sim.net.setLink(c, d, { delay: [6_000, 7_000] });
    const stalls: { r: number; from: number; to: number; waits: string[] }[] = [];
    let until: number | null = null;
    let closeIn: { close: string; T: number } | null = null;
    sim.every(() => {
      if (until !== null) {
        if (sim.T < until && !sim.healed) return;
        sim.net.deaf.clear();
        until = null;
      }
      if (sim.healed || stalls.length >= 3) return;
      sim.enter(d);
      const tip = d.p.casino.computedFoldOf(T1)?.tip;
      if (!tip) return;
      if (closeIn?.close !== tip.close) closeIn = { close: tip.close, T: sim.T };
      if (tip.houseWaits === undefined || stalls.some((x) => sim.T < x.to + 30_000)) return;
      until = closeIn.T + 26_000;
      sim.net.deaf.add(d.name);
      stalls.push({ r: tip.r, from: sim.T, to: until, waits: tip.houseWaits });
    });
    await sim.run(RUN_MS);
    const s = await finish(sim);
    console.log(`[sim] house-reveal-deaf: ${stalls.map((x) => `round ${x.r} deaf ${x.from - SIM_T0}-${x.to - SIM_T0} ms waiting on ${x.waits.length}`).join('; ')}`);
    expect(stalls.length, sim.label).toBeGreaterThan(0);
    // Each stall began well over 15 s before D would hear again, with the
    // house's beats unheard for more than HOUSE_HEARD_MS by its end.
    for (const x of stalls) expect(x.to - x.from, sim.label).toBeGreaterThan(HOUSE_HEARD_MS + 5_000);
    expect(s.voids, sim.label).toBe(0);
    expect(s.byHouse, sim.label).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ── Added for PR 6a ──────────────────────────────────────────────────────────

describe('added for PR 6a', () => {
  it('checkpoint forger: junk once and every 4 s, a replay, a deleted session and a jump; a third of the pages on the build before', async () => {
    // E and F read as v0.50 pages do: no base held, no recovery duties.
    const before: Partial<PageSpec> = { onLoad: async (p) => { p.casino.setComputedRecoveryForTests(false); } };
    const sim = await Sim.open({
      name: 'checkpoint-forger', seed: seed(21), bot: HEAVY_BOT,
      pages: [...named('ABCD'), ...named('EF', before), { name: 'X', bot: null, honest: false }],
    });
    const x = sim.pages.find((sp) => sp.name === 'X')!;
    x.cheats = true;
    // A peer's doc writes and nothing more: it never runs its tables.
    x.beforeFrame = () => false;
    const honest = sim.pages.filter((sp) => sp !== x);
    const { table } = honest[0].p;
    const inc = x.p.casino.computedIncOf(T1)!;
    const SUM = `sum:${T1}:${inc}`;
    const ctx: FoldCtx = { room: PAGE_ROOM, t: T1, inc };
    const kit = new ComputedKit(ctx);
    const forger = testIdentity('forger');
    const map = (sp: SimPage): Y.Map<unknown> => sp.p.doc.getMap('casinoComputed');
    const liveOn = (sp: SimPage): Checkpoint | null => {
      const cp = asCheckpoint(map(sp).get(SUM));
      return cp && cp.e !== 1 ? cp : null;
    };
    // Every live checkpoint the room has had, in order (for the replay),
    // and the last of the honest pages' trims (the head; none forged).
    const seen: unknown[] = [];
    const forged = new Set<string>();
    let head: Checkpoint | null = null;
    sim.every(() => {
      const v = map(x).get(SUM);
      if (!liveOn(x) || forged.has(canon(v)!)) return;
      if (!seen.some((w) => canon(w) === canon(v))) seen.push(v);
      head = liveOn(x);
    });
    const write = (act: (m: Y.Map<unknown>) => void): void => x.p.doc.transact(() => act(map(x)));
    // What each cheat must have back on every honest page up, and by when:
    // the head before it (or a later trim) under the checkpoint's key, or
    // the session's map. In turn, a STAGGER_MS a place among at most the
    // honest pages' keys, the room's resync bringing it each way.
    const room = 2 * RESYNC_MS + 2_000;
    const turns = honest.length * table.STAGGER_MS;
    // Judged on each page from the first tick it holds the cheat's write
    // (`on`): back once it holds something else that is good (`ok`). (Back
    // once on a page is enough: a later cheat may take it again. A page
    // that never held it, a later write over it first, has nothing to
    // put back.)
    const checks: {
      what: string; due: number; on: (sp: SimPage) => boolean; ok: (sp: SimPage) => boolean; seen: Set<SimPage>; back: Set<SimPage>;
    }[] = [];
    const late: string[] = [];
    // (Each kind of cheat judged on some page: the oracle bites.)
    const judged = new Set<string>();
    const keyOf = (v: unknown): string => (v === undefined ? 'none' : canon(v) ?? JSON.stringify(v));
    const backFrom = (what: string, wait: number, bad: unknown): void => {
      const u = head!.u;
      const badKey = keyOf(bad);
      checks.push({
        what, due: sim.T + wait + turns + room,
        on: (sp) => keyOf(map(sp).get(SUM)) === badKey,
        // Live, no forgery, and the head or a later trim.
        ok: (sp) => (liveOn(sp)?.u ?? -1) >= u && !forged.has(keyOf(map(sp).get(SUM))),
        seen: new Set(), back: new Set(),
      });
    };
    sim.every(() => {
      for (const c of [...checks]) {
        for (const sp of honest) {
          if (c.on(sp)) c.seen.add(sp);
          else if (c.seen.has(sp) && c.ok(sp)) c.back.add(sp);
        }
        if (sim.T < c.due) continue;
        if (c.seen.size > 0) judged.add(c.what.split(' ')[0]);
        for (const sp of honest.filter((q) => q.mode === 'up' && c.seen.has(q) && !c.back.has(q))) late.push(`${c.what} at ${c.due - SIM_T0} ms: not back on ${sp.name}`);
        checks.splice(checks.indexOf(c), 1);
      }
    });
    const done = { junk: 0, replay: 0, deleted: 0, jump: 0 };
    const cycle = SIM_LONG ? 150_000 : RUN_MS;
    for (let c = 0; c + 140_000 <= RUN_MS; c += cycle) {
      // Junk in the checkpoint's place, once (at the first look past 20 s
      // with one there), then every 4 s for 16 s.
      const junk = (): void => {
        const bad = { junk: sim.T };
        backFrom(`junk ${sim.elapsed}`, 0, bad);
        write((m) => m.set(SUM, bad));
        done.junk += 1;
      };
      let once = false;
      sim.every(() => {
        if (once || sim.elapsed < c + 20_000 || !liveOn(x) || !head) return;
        once = true;
        junk();
      });
      for (const ms of [40_000, 44_000, 48_000, 52_000, 56_000]) sim.at(c + ms, () => { if (head) junk(); });
      // An older checkpoint written back, its session too.
      let replayed = false;
      sim.every(() => {
        if (replayed || sim.elapsed < c + 75_000 || sim.elapsed > c + 100_000) return;
        const old = seen.find((v) => canon(v) !== canon(map(x).get(SUM)) && asCheckpoint(v)!.u < (liveOn(x)?.u ?? -1));
        if (!old) return;
        replayed = true;
        forged.add(canon(old)!);
        backFrom(`replay ${sim.elapsed}`, table.RESTORE_WAIT_MS, old);
        const sid = nextSid(ctx, asCheckpoint(old)!);
        write((m) => {
          m.set(SUM, old);
          if (!(m.get(`ses:${T1}:${inc}:${sid}`) instanceof Y.Map)) m.set(`ses:${T1}:${inc}:${sid}`, new Y.Map());
        });
        done.replay += 1;
      });
      // The live session deleted, nothing in its place.
      sim.at(c + 105_000, () => {
        const cp = liveOn(x);
        if (!cp) return;
        const key = `ses:${T1}:${inc}:${nextSid(ctx, cp)}`;
        if (!(map(x).get(key) instanceof Y.Map)) return;
        checks.push({
          what: `deleted session ${c + 105_000}`, due: sim.T + table.OPEN_WAIT_MS + turns + room,
          on: (sp) => !(map(sp).get(key) instanceof Y.Map) && liveOn(sp)?.u === cp.u,
          ok: (sp) => map(sp).get(key) instanceof Y.Map || (liveOn(sp)?.u ?? -1) > cp.u, seen: new Set(), back: new Set(),
        });
        write((m) => m.delete(key));
        done.deleted += 1;
      });
      // MAX_SESSION_ROUNDS + 1 rounds past the head on its session, the
      // head's nets kept (a jump no trim could write), its session too.
      sim.at(c + 130_000, () => {
        const cp = liveOn(x);
        if (!cp) return;
        const nets = Object.fromEntries(Object.entries(cp.n).map(([pid, n]) => [pid, BigInt(n)]));
        const P = kit.checkpoint(forger, nextSid(ctx, cp), cp.u + 501, cp.l, nets, undefined, cp.s, cp.h);
        forged.add(canon(P)!);
        backFrom(`jump ${c + 130_000}`, table.RESTORE_WAIT_MS, P);
        write((m) => {
          m.set(SUM, P);
          m.set(`ses:${T1}:${inc}:${nextSid(ctx, P)}`, new Y.Map());
        });
        done.jump += 1;
      });
    }
    await sim.run(RUN_MS);
    // Scoped: while a forged checkpoint stands (RESTORE_WAIT_MS, in turn)
    // every page counts it, as a valid checkpoint (A1): the rounds of the
    // head's session read undecided, and come back alike with the head.
    // (And a forged checkpoint over a round's show, the pages counting its
    // empty session, puts that round's trim off to the next one's.)
    const s = await finish(sim, { flips: ['blip'], sessionRounds: 2 });
    console.log(`[sim] checkpoint-forger: ${JSON.stringify(done)}, ${seen.length} checkpoints`);
    expect(late, sim.label).toEqual([]);
    expect([...judged].sort(), sim.label).toEqual(['deleted', 'jump', 'junk', 'replay']);
    expect(done.junk, sim.label).toBeGreaterThanOrEqual(6);
    expect(done.replay, sim.label).toBeGreaterThanOrEqual(1);
    expect(done.deleted, sim.label).toBeGreaterThanOrEqual(1);
    expect(done.jump, sim.label).toBeGreaterThanOrEqual(1);
    // Every page ends on the head of the honest trims, none parked.
    for (const sp of honest.filter((q) => q.mode === 'up')) {
      sim.enter(sp);
      expect(sp.p.casino.casinoWhole(T1), `${sim.label} ${sp.name}`).toBe(true);
      expect(canon(map(sp).get(SUM)), `${sim.label} ${sp.name}`).toBe(canon(map(honest[0]).get(SUM)));
    }
    expect(forged.has(keyOf(map(honest[0]).get(SUM))), `${sim.label}: a forgery stands`).toBe(false);
    expect(s.trims, sim.label).toBeGreaterThanOrEqual(2);
    expect(s.rounds, sim.label).toBeGreaterThanOrEqual(scaled(20));
  }, TIMEOUT);
});
