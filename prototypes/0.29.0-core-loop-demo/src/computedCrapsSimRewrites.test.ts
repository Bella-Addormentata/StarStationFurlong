/**
 * 🧪🎲🌐 Computed craps over the simulated network: the rolls that change
 * after they showed, and the trims that make them final
 * (computedCrapsSimPlay.test.ts's harness, computedCrapsSimKit's finish).
 *
 * - cascade: a late forfeit beats the full set of seeds on roll k; the rolls
 *   after it pay again on the same dice, and in a second case the point
 *   moves, the bets on the rolls after come back, and the table UI says so.
 * - split-points: a 3-minute split where one side makes the point and the
 *   other sevens out; a felt given a fresh seed after it stays out of date.
 * - trim-mid-point, seven-out-trim, trim-during-wait: the trims a craps
 *   table takes mid-point and at a seven-out, and one during the wait for
 *   the throw whose window opened on a version later replaced.
 * - long-history: 500 rolls on each seed, the checkpoint's size bounded (and a
 *   fourth run with a second bettor's bets riding).
 *
 * Each scenario runs three seeds (seed bases of its own) through the shared
 * finish and asserts what the design says it must show, with counters that
 * prove the case happened on every seed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastDecided, Sim, SIM_LONG } from './computedSim';
import type { SimPage } from './computedSim';
import { canonList, CRAPS_BOT, stampOf } from './computedCrapsSim';
import { T, TIMEOUT, finish, seed } from './computedCrapsSimKit';
import { atCraps, stubDom, withUI } from './computedCrapsUiKit';
import type { AtCraps, UIPage } from './computedCrapsUiKit';
import { putIn, rigRoll, rigSplit } from './computedPageKit';
import { TRIM_SEVEN_OUT_MIN } from './computedCraps';
import type { Page } from './computedPageKit';
import type { Checkpoint, CrapsRoll, CrapsSlipRec, FoldCtx } from './computedFold';
import type { CrapsBet } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SEEDS = [1, 2, 3];
const lines: string[] = [];
const crapsTable = [{ id: T, game: 'craps' as const }];

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

/** A player whose bets the scenario writes (computedCrapsSim press): no
 *  moves, tries or stand moves of its own; it still throws the dice it is
 *  offered, at a time drawn into the wait. */
const SCRIPTED = { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0 };

/** The table UI's modules on every load (computedCrapsUiKit withUI), and a
 *  DOM whose timers do nothing (the sim drives the UI by hand). */
const withTableUI = async (p: Page): Promise<void> => {
  await withUI(p);
};
function uiDom(): void {
  stubDom({ setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
}
function noDom(): void {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
}

/** Table T's fold context in the sim's room, its incarnation as page sp has it. */
function ctxOf(sim: Sim, sp: SimPage): FoldCtx {
  sim.enter(sp);
  return sim.ctxOf(T, sp.p.casino.computedIncOf(T)!);
}

/** The bettors' bets the scenario writes: each roll, once betting is open
 *  (3 s or more before its end), `want` gives page sp's whole felt for roll r
 *  from its felt and the point (null: as it stands; undefined: not yet, ask
 *  again next frame); written through the
 *  felt's own writer as a press (computedCrapsSim press: the version held to
 *  it), built on the stamp read with the felt. */
function script(sim: Sim, bettors: SimPage[], want: (sp: SimPage, r: number, felt: CrapsBet[], point: number | null) => CrapsBet[] | null | undefined): void {
  const done = new Set<string>();
  sim.every(async () => {
    if (sim.healed) return;
    for (const sp of bettors) {
      if (sp.mode !== 'up' || sim.T < sp.pauseUntil) continue;
      await sim.as(sp, (now) => {
        const { table } = sp.p;
        const v = table.readComputedCraps(T, now);
        if (!v || v.phase !== 'betting' || (v.phaseDeadline !== undefined && now >= v.phaseDeadline - 3_000)) return;
        const key = `${v.inc}|${v.round}|${sp.name}`;
        if (done.has(key)) return;
        const { felt, basis } = table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
        const next = want(sp, v.round, felt, v.point ?? null);
        if (next === undefined) return;
        if (next === null) {
          done.add(key);
          return;
        }
        const res = sim.craps!.press(sp, T, v.round, next, basis, () => table.writeComputedCrapsSlip(T, next, basis, now));
        if (res === 'ok') done.add(key);
        else if (res !== 'closed' && res !== 'reconnecting') sim.violate(`${sp.name}'s scripted felt ${JSON.stringify(next)} on roll ${v.round} at ${sim.elapsed} ms answered ${res}`);
      });
    }
  });
}

/** Like script, but each frame: `want` gives page sp's whole felt for the
 *  open roll now (null: leave it), written when it differs from the felt. */
function steer(sim: Sim, bettors: SimPage[], want: (sp: SimPage, r: number, felt: CrapsBet[], deadline: number | undefined, now: number) => CrapsBet[] | null): void {
  sim.every(async () => {
    if (sim.healed) return;
    for (const sp of bettors) {
      if (sp.mode !== 'up' || sim.T < sp.pauseUntil) continue;
      await sim.as(sp, (now) => {
        const { table } = sp.p;
        const v = table.readComputedCraps(T, now);
        if (!v || v.phase !== 'betting' || (v.phaseDeadline !== undefined && now >= v.phaseDeadline - 3_000)) return;
        const { felt, basis } = table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
        const next = want(sp, v.round, felt, v.phaseDeadline, now);
        if (next === null || JSON.stringify(canonList(next)) === JSON.stringify(canonList(felt))) return;
        const res = sim.craps!.press(sp, T, v.round, next, basis, () => table.writeComputedCrapsSlip(T, next, basis, now));
        if (res !== 'ok' && res !== 'closed' && res !== 'reconnecting') sim.violate(`${sp.name}'s steered felt ${JSON.stringify(next)} on roll ${v.round} at ${sim.elapsed} ms answered ${res}`);
      });
    }
  });
}

/** Run until page sp's fold of T has decided roll `r` (or `capMs` more). */
async function runTo(sim: Sim, sp: SimPage, r: number, capMs: number): Promise<void> {
  const end = sim.elapsed + capMs;
  const at = (): number => {
    sim.enter(sp);
    const res = sp.p.casino.computedFoldOf(T);
    return res ? lastDecided(res)?.r ?? res.base.u : 0;
  };
  while (at() < r && sim.elapsed < end) await sim.run(10_000);
}

/** How roll r is rigged: its sum from every bettor's seed, or (a split)
 *  the full set's sum `both` and `w`'s seed alone `alone`. */
type RollRig = { sum: number } | { both: number; w: SimPage; alone: number };

/** Rig the rolls `plan` names from roll `from` on (computedPageKit rigRoll,
 *  rigSplit): before any of `bettors` writes on roll r (roll 1 at once; roll
 *  r once the first of them shows roll r − 1 decided, betting on r a show
 *  away), each one's
 *  next seed queued so that the roll throws what `plan(r)` says (null: the
 *  roll and every one after it as drawn). Every bettor writes on each rigged
 *  roll (the scenario's script, or its ride slip), so its queued seed is the
 *  one its slip commits to. The rolls rigged, by number. */
function rigRolls(sim: Sim, bettors: SimPage[], plan: (r: number) => RollRig | null, from = 1): Set<number> {
  const queued = new Set<number>();
  let done = false;
  const queue = (r: number): void => {
    queued.add(r);
    const rig = plan(r);
    if (!rig) {
      done = true;
      return;
    }
    const pages = bettors.map((sp) => sp.p);
    const ctx = ctxOf(sim, bettors[0]);
    if ('sum' in rig) rigRoll(pages, r, rig.sum, [], ctx);
    else rigSplit(pages, r, rig.both, rig.w.p, rig.alone, ctx);
  };
  if (from === 1) queue(1);
  sim.every(() => {
    if (done) return;
    for (const sp of bettors) {
      if (sp.mode !== 'up' || done) continue;
      sim.enter(sp);
      const res = sp.p.casino.computedFoldOf(T);
      const D = res ? lastDecided(res) : null;
      if (D && D.r + 1 >= from && !queued.has(D.r + 1)) queue(D.r + 1);
    }
  });
  return queued;
}

/** Each checkpoint of table T page sp folds, as it first sees it: the
 *  round it covers, its point and riders, its size, and what sp's fold of
 *  the session it closed read the tick before (the trim's pressure). */
interface CpSeen {
  u: number;
  p: number;
  riders: number;
  w: Record<string, CrapsBet[]>;
  bytes: number;
  nets: number;
  at: number;
  pre: { rawBytes: number; baseU: number; D: number; sevenOut: boolean; room: number; tip: boolean } | null;
}
function watchCheckpoints(sim: Sim, sp: SimPage): CpSeen[] {
  const out: CpSeen[] = [];
  let last: string | null = null;
  let pre: CpSeen['pre'] = null;
  sim.every(() => {
    if (sp.mode !== 'up') return;
    sim.enter(sp);
    const { casino, doc } = sp.p;
    const inc = casino.computedIncOf(T);
    if (!inc) return;
    const cp = doc.getMap('casinoComputed').get(`sum:${T}:${inc}`) as Checkpoint | undefined;
    const key = cp ? `${cp.u}|${cp.l}` : null;
    if (cp && key !== last) {
      last = key;
      out.push({
        u: cp.u, p: cp.s?.p ?? 0, riders: Object.keys(cp.s?.w ?? {}).length, w: cp.s?.w ?? {}, bytes: JSON.stringify(cp).length,
        nets: Object.keys(cp.n).length, at: sim.elapsed, pre,
      });
    }
    const res = casino.computedFoldOf(T);
    if (res) {
      const D = lastDecided(res);
      pre = { rawBytes: res.rawBytes, baseU: res.base.u, D: D?.r ?? res.base.u, sevenOut: D?.craps?.sevenOut === true, room: casino.computedRoomBytes(), tip: res.tip !== null };
    }
  });
  return out;
}

/** A sum for a roll with point `p` on that decides nothing on the line: not
 *  the point, not a seven (nor any of `not`). */
function neutral(sim: Sim, p: number, not: number[] = []): number {
  const ok = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12].filter((x) => x !== p && !not.includes(x));
  return ok[Math.floor(sim.rand() * ok.length)];
}

// ── 🌊 Cascade ───────────────────────────────────────────────────────────────

interface Cascade {
  /** The roll the late forfeit decides again, its writer, and the sums. */
  k: number;
  L: string;
  both: number;
  alone: number;
  /** When the close came in, the forfeit was written, and landed on U. */
  closeAt: number | null;
  forfeitAt: number | null;
  landedAt: number | null;
  /** On U's fold: roll k before and after; the rolls after k with their
   *  dice and carry in, before the forfeit landed and after. */
  before: CrapsRoll | null;
  after: { decided: string; counted: string[]; roll: CrapsRoll } | null;
  later: Map<number, { close: string; dice: string; sIn: string }>;
  laterAfter: Map<number, { close: string; dice: string; sIn: string }>;
  /** What U's table UI said. */
  heard: string[];
}

/**
 * The cascade, both cases (the design's "cascade: A late forfeit beats a
 * full set of seeds on roll k, and later rolls pay again on the same dice.
 * In a second case the change moves the point: later bets come back, and
 * the notices show."). Pages U (the table UI), A and B bet as scripted; N,
 * off the table and betting nothing, is the room L keeps hearing.
 *
 * Roll k is the first (from `from`) on which A or B ranks first for the
 * forfeit among the three frozen bettors: that one is L, so no page answers
 * its forfeit (answerDuty: only a page ranking better). Rolls before k are
 * rigged to keep the table where the case needs it, and roll k so that the
 * full set throws `both` and L's seed alone `alone`.
 *
 * As roll k's close comes in, L's links from the others slow to 30 s and N
 * goes deaf (its resyncs carry no seeds to L; its heartbeats still come, so
 * L hears the room): L reveals in time, the others decide roll k by the
 * full set, and L, seeing only its own seed, forfeits once its grace is out,
 * counting itself. Its links to the others slow to 110 s as its reveal is
 * out, so the forfeit lands after the rolls after k have decided, two at
 * least (a roll takes 16 s of betting, up to 20 s of wait for the throw and
 * a 6 s show: k + 2 is decided some 90 s after k's close at the latest, and
 * the forfeit lands some 115 s after it); L goes as its
 * forfeit is written (a crash: what it sent still comes), and is back once
 * the forfeit is in everywhere.
 */
function cascade(sim: Sim, c: Cascade): AtCraps {
  const [u, , , n] = sim.pages;
  const l = sim.pages.find((sp) => sp.name === c.L)!;
  const others = sim.pages.filter((sp) => sp !== l);
  sim.enter(u);
  const tu = atCraps(u.p as UIPage, { stand: 1, table: T });
  tu.update();
  let phase: 'before' | 'slowIn' | 'slowOut' | 'out' | 'landed' | 'back' = 'before';
  sim.every(async () => {
    if (sim.healed) return;
    // U's table UI, each tick: its notices.
    if (u.mode === 'up') {
      sim.enter(u);
      tu.update();
    }
    const closeOf = (sp: SimPage): boolean => {
      sim.enter(sp);
      const res = sp.p.casino.computedFoldOf(T);
      return !!res && (res.tip?.r === c.k || res.openCloses.some((o) => o.rec.r === c.k) || res.rounds.some((v) => v.r === c.k));
    };
    if (phase === 'before') {
      // Roll k's close is in on the page that wrote it (this tick's
      // deliveries are to come): L hears the others 30 s late, N nothing.
      if (!sim.pages.some(closeOf)) return;
      c.closeAt = sim.elapsed;
      for (const sp of others) if (sp !== n) sim.net.setLink(sp, l, { delay: [30_000, 30_000] });
      sim.net.deaf.add(n.name);
      phase = 'slowIn';
      return;
    }
    if (phase === 'slowIn') {
      // L's reveal is out (it reveals as it sees the close): what it sends
      // from now comes 110 s late.
      sim.enter(l);
      const ses = l.p.casino.computedSessionForWrite(T);
      if (!ses || ![...ses.keys()].some((key) => key.startsWith(`x:${c.k}:${l.pid}:`))) return;
      for (const sp of others) sim.net.setLink(l, sp, { delay: [110_000, 110_000] });
      phase = 'slowOut';
      return;
    }
    if (phase === 'slowOut') {
      sim.enter(l);
      const ses = l.p.casino.computedSessionForWrite(T);
      if (!ses || ![...ses.keys()].some((key) => key.startsWith(`f:${c.k}:`))) return;
      // Its forfeit is written: L goes, the network heals (what is on its
      // way still comes, the forfeit 110 s on).
      c.forfeitAt = sim.elapsed;
      sim.crash(l);
      sim.net.reset();
      // U's view of roll k and of the rolls after it, until the forfeit lands.
      phase = 'out';
    }
    if (phase === 'out') {
      sim.enter(u);
      const res = u.p.casino.computedFoldOf(T)!;
      const vk = res.rounds.find((v) => v.r === c.k);
      if (vk?.decided === 'reveals') {
        c.before = vk.craps!;
        for (const v of res.rounds) if (v.r > c.k && v.decided && v.craps) c.later.set(v.r, { close: v.close, dice: JSON.stringify(v.craps.dice), sIn: JSON.stringify(v.craps.sIn) });
        return;
      }
      if (vk?.decided !== 'forfeit') return;
      c.landedAt = sim.elapsed;
      c.after = { decided: vk.decided, counted: [...vk.counted], roll: vk.craps! };
      for (const v of res.rounds) if (v.r > c.k && v.decided && v.craps) c.laterAfter.set(v.r, { close: v.close, dice: JSON.stringify(v.craps.dice), sIn: JSON.stringify(v.craps.sIn) });
      phase = 'landed';
      // L back once the forfeit is in everywhere.
      sim.at(sim.elapsed + 10_000, async () => {
        await sim.reload(l);
        phase = 'back';
      });
    }
  });
  return tu;
}

/** Roll k and L: the first roll from `from` on which A or B ranks first for
 *  the forfeit among U, A and B (computedFold dutyRank). */
function chooseK(sim: Sim, from: number): { k: number; L: SimPage } {
  const [u, a, b] = sim.pages;
  const ctx = ctxOf(sim, u);
  for (let r = from; r < from + 50; r++) {
    const rank = (sp: SimPage): string => u.p.fold.dutyRank('forfeit', ctx, r, sp.p.pub);
    const first = [u, a, b].sort((x, y) => (rank(x) < rank(y) ? -1 : 1))[0];
    if (first !== u) return { k: r, L: first };
  }
  throw new Error(`${sim.label}: no roll from ${from} where A or B ranks first`);
}

describe('computed craps: cascade', () => {
  for (const pointMoves of [false, true]) {
    for (const n of SEEDS) {
      const name = pointMoves ? 'point' : 'paid';
      it(`cascade ${name} ${n}: a late forfeit beats the full set on roll k; ${pointMoves
        ? 'the point moves, the bets on the rolls after come back, and the table UI says ROLL k CHANGED — YOUR BETS ON ROLLS … CAME BACK'
        : 'the rolls after pay again on the same dice, and the table UI says ROLL k CHANGED — THE ROLLS AFTER IT PAID AGAIN ON THE SAME DICE'}`, async () => {
        uiDom();
        try {
          const sim = await Sim.open({
            name: `craps-cascade-${name}`, seed: seed((pointMoves ? 1200 : 1100) + n), tables: crapsTable,
            pages: [
              { name: 'U', place: 1, crapsBot: SCRIPTED, onLoad: withTableUI },
              { name: 'A', place: 3, crapsBot: SCRIPTED },
              { name: 'B', place: 5, crapsBot: SCRIPTED },
              { name: 'N', place: 'off', bot: null },
            ],
          });
          const [u, a, b] = sim.pages;
          const bettors = [u, a, b];
          // Case 1 (paid): roll 1 makes the point 6, every pass riding; roll
          // k (2 on) is mid-point, A and B with a come bet in the box: the
          // full set throws 8, L alone 9 (neither the point nor a seven), so
          // the come bets travel elsewhere and the rolls after play from
          // another table. U holds only its pass: its stamp stands.
          // Case 2 (point): rolls before k come-out naturals (7); on roll k
          // every bettor puts a pass down: the full set makes the point 6, L
          // alone 8. U adds a field bet on roll k + 1: built on the point 6,
          // it comes back; on the rolls after that U only rides (its ride
          // slips, stamped on the point 6 too), and those rolls pay again:
          // nothing of U's was undone there.
          const { k, L } = chooseK(sim, pointMoves ? 1 : 2);
          const both = pointMoves ? 6 : 8;
          const alone = pointMoves ? 8 : 9;
          rigRolls(sim, bettors, (r) => (r < k ? { sum: pointMoves ? 7 : r === 1 ? 6 : 3 } : r === k ? { both, w: L, alone } : null));
          // Rolls k + 1 and k + 2 decide nothing on the line nor on the come
          // bets, before the forfeit or after it (not 6, 7, 8 nor 9): the
          // hand goes on, bets riding, so both are decided before the
          // forfeit lands, with nobody's bets gone and no idle trim past
          // roll k first. L, gone as its forfeit is written, writes on
          // neither: the others' seeds throw them.
          rigRolls(sim, bettors.filter((sp) => sp !== L), (r) => (r <= k + 2 ? { sum: neutral(sim, 6, [8, 9]) } : null), k + 1);
          script(sim, bettors, (sp, r, felt) => {
            if (r < k) {
              if (pointMoves) return canonList([...felt, { type: 'field', amount: 1 }]);
              if (r === 1) return [{ type: 'pass', amount: 10 }];
              return null;
            }
            if (r === k) {
              if (pointMoves) return canonList([...felt, { type: 'pass', amount: 10 }]);
              if (sp === u) return null;
              return canonList([...felt, { type: 'come', amount: 5 }]);
            }
            if (pointMoves && sp === u && r === k + 1) return canonList([...felt, { type: 'field', amount: 1 }]);
            return null;
          });
          const c: Cascade = {
            k, L: L.name, both, alone, closeAt: null, forfeitAt: null, landedAt: null, before: null, after: null,
            later: new Map(), laterAfter: new Map(), heard: [],
          };
          const tu = cascade(sim, c);
          await sim.run(4 * 60_000);
          // (A late roll k: on until 40 s past the forfeit's landing.)
          for (let i = 0; i < 8 && (c.landedAt === null || sim.elapsed < c.landedAt + 40_000); i++) await sim.run(30_000);
          sim.enter(u);
          c.heard = tu.heard();
          tu.unmount();
          const s = await finish(sim, lines, { flips: ['forfeit over reveals', 'repaid'] });
          console.log(`[craps] ${sim.label}: k=${k} L=${L.name} full ${both} / alone ${alone}, close ${c.closeAt} ms, forfeit ${c.forfeitAt} ms, landed ${c.landedAt} ms, later ${JSON.stringify([...c.later.keys()])}, flips ${JSON.stringify(s.flipKinds)}, U heard ${JSON.stringify(c.heard)}`);
          expect(c.closeAt, sim.label).not.toBeNull();
          expect(c.forfeitAt, sim.label).not.toBeNull();
          expect(c.landedAt, sim.label).not.toBeNull();
          // Roll k: decided by the full set first, then by L's forfeit,
          // counting L alone, on its seed's dice.
          const before = c.before!;
          const after = c.after!;
          expect(before.dice![0] + before.dice![1], sim.label).toBe(both);
          expect(after.counted, sim.label).toEqual([L.pid]);
          expect(after.roll.dice![0] + after.roll.dice![1], sim.label).toBe(alone);
          if (pointMoves) {
            expect(before.pointAfter, sim.label).toBe(6);
            expect(after.roll.pointAfter, sim.label).toBe(8);
          } else {
            expect(before.pointAfter, sim.label).toBe(6);
            expect(after.roll.pointAfter, sim.label).toBe(6);
          }
          // The rolls after k it decided before the forfeit came: each one
          // still on the chain on the same close and dice, from another
          // table (paid again: 'repaid', once a roll).
          expect(c.later.size, sim.label).toBeGreaterThan(0);
          let repaid = 0;
          for (const [r, was] of c.later) {
            const is = c.laterAfter.get(r);
            expect(is?.close, `${sim.label} roll ${r}`).toBe(was.close);
            expect(is?.dice, `${sim.label} roll ${r}`).toBe(was.dice);
            if (is!.sIn !== was.sIn) repaid += 1;
          }
          expect(repaid, sim.label).toBeGreaterThan(0);
          expect(u.flipKinds['forfeit over reveals'] ?? 0, sim.label).toBeGreaterThan(0);
          expect(u.flipKinds.repaid ?? 0, sim.label).toBeGreaterThan(0);
          expect(s.byForfeit, sim.label).toBeGreaterThan(0);
          // The notice U's table UI said.
          if (pointMoves) {
            // Exactly the roll U changed (k + 1, decided before the forfeit
            // came) comes back; a roll after it U only rode into, decided
            // then too, doesn't (it played again, on what rode).
            expect(c.later.has(k + 1), `${sim.label} later ${JSON.stringify([...c.later.keys()])}`).toBe(true);
            expect([...c.later.keys()].some((r) => r > k + 1), `${sim.label} later ${JSON.stringify([...c.later.keys()])}`).toBe(true);
            expect(c.heard, sim.label).toContain(`ROLL ${k} CHANGED — YOUR BETS ON ROLL ${k + 1} CAME BACK`);
            expect(c.heard.filter((h) => h.includes('CAME BACK')), sim.label).toEqual([`ROLL ${k} CHANGED — YOUR BETS ON ROLL ${k + 1} CAME BACK`]);
            expect(sim.craps!.stats.fates.basis ?? 0, sim.label).toBeGreaterThan(0);
          } else {
            expect(c.heard, sim.label).toContain(`ROLL ${k} CHANGED — THE ROLLS AFTER IT PAID AGAIN ON THE SAME DICE`);
          }
        } finally {
          noDom();
        }
      }, TIMEOUT);
    }
  }
});

/** Three scripted bettors at stands 1, 3 and 5. */
const trio = (extra: Partial<typeof SCRIPTED> = {}) => ['A', 'B', 'C'].map((name, i) => ({ name, place: 1 + 2 * i, crapsBot: { ...SCRIPTED, ...extra } }));
const pass = (amount: number): CrapsBet => ({ type: 'pass', amount });

// ── 🪓 Split points ──────────────────────────────────────────────────────────

describe('computed craps: split points', () => {
  for (const n of SEEDS) {
    it(`split-points ${n}: a 3-minute split where one side makes the point and the other sevens out; healed with both sides as many rolls on and the dropped side's close of the next roll in, one seed of it out: the felt put down again under a fresh seed keeps its stamp, out of date, and plays as the bets stood`, async () => {
      // Each side: a player at a stand (a shooter) and one at the device
      // front (no stand). The felt this scenario follows is the latter's: a
      // page at a stand rewrites a stale felt of its own to the riding bets
      // while betting is open, and so does any page while someone else has
      // chips on the roll (rideDuty, design "rideDuty ... latest version's
      // basis stale: rewrite to C"), before a re-commit could.
      const sim = await Sim.open({
        name: 'craps-split-points', seed: seed(1300 + n), tables: crapsTable,
        // (Each shooter flings within 2 s of the wait's start: see the pace
        // below.)
        pages: [['A', 1], ['B', null], ['C', 5], ['D', null]].map(([name, place]) => ({ name: name as string, place: place as number | null, crapsBot: { ...SCRIPTED, lateEvery: 0, fling: [0, 2_000] as [number, number] } })),
      });
      const [a, b, c, d] = sim.pages;
      const X = [a, b];
      const Y = [c, d];
      type Phase = 'before' | 'split' | 'steer' | 'healed';
      let phase = 'before' as Phase;
      let splitAt = 0;
      let healAt = 0;
      // Roll 1, everyone: a pass; the point 6. Apart, X makes it on roll 2
      // and Y sevens out; every roll after that, on both sides, a 3 (a craps
      // on the come-out). Each roll apart every bettor puts a chip on the
      // field: nothing rides on either side after roll 2.
      rigRolls(sim, sim.pages, (r) => (r === 1 ? { sum: 6 } : null));
      const apart = (r: number, make: boolean): RollRig | null => {
        if (r === 2) return { sum: make ? 6 : 7 };
        return phase === 'split' || phase === 'steer' ? { sum: 3 } : null;
      };
      rigRolls(sim, X, (r) => apart(r, true), 2);
      rigRolls(sim, Y, (r) => apart(r, false), 2);
      const lastOf = (sp: SimPage): number => {
        sim.enter(sp);
        const res = sp.p.casino.computedFoldOf(T);
        return res ? lastDecided(res)?.r ?? res.base.u : 0;
      };
      const foldOf = (sp: SimPage) => {
        sim.enter(sp);
        return sp.p.casino.computedFoldOf(T)!;
      };
      // After 3 minutes the steering: both sides play on to roll R, the side
      // whose rolls the chain drops (Lo) putting a place 8 down on roll R
      // (not before the kept side, W, has decided R − 1, so that W has
      // decided R before Lo closes R + 1). On R + 1 its device-front player
      // F adds a chip on the field, its stand player Q takes the place 8
      // down: an empty felt over riding bets, frozen too.
      let R = 0;
      let W: SimPage[] = [];
      let Lo: SimPage[] = [];
      let F: SimPage | null = null;
      let Q: SimPage | null = null;
      const field: CrapsBet = { type: 'field', amount: 1 };
      const place8: CrapsBet = { type: 'place', pick: 8, amount: 10 };
      // The pace: apart, from roll 3 on, a side bets a roll only once the
      // other has decided the roll before ("both sides as many rolls on"),
      // and each shooter flings at once. Neither side then writes nothing
      // for IDLE_MS (60 s) before the heal, so neither trims on idle apart:
      // a trim there takes the session the dropped side's close of R + 1 is
      // in, and F's felt frozen in it is then void, its stakes back, by
      // design (computedTable noteResult; PR 2's computedTrim.test.ts "a
      // split where one side trimmed: what the other side played in the
      // session the trim took away is void"), never put down again.
      const doneTo: Record<'X' | 'Y', number> = { X: 0, Y: 0 };
      const paced = (sp: SimPage, r: number): boolean => r < 3 || doneTo[X.includes(sp) ? 'Y' : 'X'] >= r - 1;
      script(sim, sim.pages, (sp, r, felt) => {
        if (r === 1) return [pass(10)];
        if (phase === 'split' || (phase === 'steer' && (W.includes(sp) ? r <= R : r < R))) return paced(sp, r) ? canonList([...felt, field]) : undefined;
        return null;
      });
      // (W's progress, and each side's, read each tick before the steering,
      // outside it: the steering's step runs as a page of Lo, and reading
      // W's folds there would run Lo's writes on W's clock, device and
      // timers.)
      let wReady = false;
      sim.every(() => {
        if (phase === 'split' || phase === 'steer') {
          doneTo.X = Math.min(...X.map(lastOf));
          doneTo.Y = Math.min(...Y.map(lastOf));
        }
        if (phase === 'steer' && !wReady) wReady = W.every((w) => lastOf(w) >= R - 1);
      });
      // Every close the pages' folds decide, by its hash: its parent (the
      // close of the roll before), and, for roll 2 on and before the heal,
      // the side whose fold it was on. The chain kept is the side its closes
      // lead back to, read even when the kept side trims past roll 2 (the
      // checkpoint naming only its last close, design lever 5).
      const links = new Map<string, string>();
      const sideOf = new Map<string, 'X' | 'Y'>();
      const seenRes = new WeakSet<object>();
      sim.every(() => {
        for (const sp of sim.pages) {
          if (sp.mode !== 'up') continue;
          sim.enter(sp);
          const res = sp.p.casino.computedFoldOf(T);
          if (!res || seenRes.has(res)) continue;
          seenRes.add(res);
          for (const v of res.rounds) {
            if (!v.decided) continue;
            links.set(v.close, v.closeRec.q);
            if (v.r >= 2 && (phase === 'split' || phase === 'steer')) sideOf.set(v.close, X.includes(sp) ? 'X' : 'Y');
          }
        }
      });
      const chainSide = (close: string | null): 'X' | 'Y' | null => {
        for (let h = close, i = 0; h !== null && h !== undefined && i < 10_000; h = links.get(h) ?? null, i++) {
          const side = sideOf.get(h);
          if (side) return side;
        }
        return null;
      };
      steer(sim, sim.pages, (sp, r) => {
        if (phase !== 'steer' || !Lo.includes(sp)) return null;
        if (r === R) return wReady ? canonList([field, place8]) : null;
        if (r === R + 1) return sp === F ? canonList([field, place8]) : [];
        return null;
      });
      const sides: Record<'make' | 'seven', CrapsRoll | null> = { make: null, seven: null };
      let slip: { key: string; o: string; c: string; b: string; v: number } | null = null;
      let again: { key: string; o: string; c: string; b: string; v: number } | null = null;
      let wAtHeal: number[] = [];
      let keptR2 = '';
      let qBackAt: number | null = null;
      let basesAtHeal: number[] = [];
      const slipOf = (sp: SimPage, key: string) => {
        sim.enter(sp);
        const rec = sp.p.casino.computedSessionForWrite(T)?.get(key) as CrapsSlipRec | undefined;
        return rec ? { key, o: rec.o, c: rec.c, b: JSON.stringify(canonList(rec.b)), v: rec.v } : null;
      };
      const keysOf = (sp: SimPage, prefix: string): string[] => {
        sim.enter(sp);
        return [...(sp.p.casino.computedSessionForWrite(T)?.keys() ?? [])].filter((k) => k.startsWith(prefix));
      };
      sim.every(async () => {
        if (phase === 'before') {
          if (!sim.pages.every((sp) => lastOf(sp) >= 1)) return;
          sim.net.groups = [X.map((sp) => sp.name), Y.map((sp) => sp.name)];
          splitAt = sim.elapsed;
          phase = 'split';
          return;
        }
        if (phase === 'split') {
          if (sim.elapsed - splitAt < 180_000) return;
          const r2 = (g: SimPage[]) => foldOf(g[0]).rounds.find((v) => v.r === 2);
          const [cm, cs] = [r2(X), r2(Y)];
          if (!cm?.decided || !cs?.decided) return;
          sides.make = cm.craps!;
          sides.seven = cs.craps!;
          // Which side the chain keeps at equal score (computedFold's chain
          // rule: the lower close rank of roll 2, then the hash).
          const ctx = ctxOf(sim, a);
          const rank = (k: string): string => a.p.fold.dutyRank('close', ctx, 2, k);
          const xFirst = rank(cm.closeRec.k) < rank(cs.closeRec.k) || (rank(cm.closeRec.k) === rank(cs.closeRec.k) && cm.close < cs.close);
          [W, Lo] = xFirst ? [X, Y] : [Y, X];
          keptR2 = xFirst ? cm.close : cs.close;
          [Q, F] = Lo;
          R = Math.max(...sim.pages.map(lastOf)) + 2;
          phase = 'steer';
          return;
        }
        if (phase === 'steer') {
          // Lo's close of R + 1 in: Q's page hears it and reveals nothing (a
          // tab in the background, a few seconds).
          if (Q!.pauseUntil === 0) {
            const closes = Lo.flatMap((sp) => keysOf(sp, `c:${R + 1}:`).map((k) => [sp, k] as const));
            if (closes.length === 0) return;
            Q!.pauseUntil = Infinity;
            const [sp, k] = closes[0];
            sim.enter(sp);
            const close = sp.p.casino.computedSessionForWrite(T)!.get(k) as { f: Record<string, string> };
            slip = slipOf(sp, `s:${R + 1}:${F!.pid}:${close.f[F!.pid]}`);
          }
          // F's seed out: healed, within the grace.
          if (keysOf(F!, `x:${R + 1}:${F!.pid}:`).length === 0) return;
          wAtHeal = W.map(lastOf);
          basesAtHeal = sim.pages.map((sp) => foldOf(sp).base.u);
          sim.net.groups = null;
          healAt = sim.elapsed;
          phase = 'healed';
          return;
        }
        // Q's page back 3 s after the heal's catch-up has reached it, its
        // fold on W's chain (W's roll 2 chosen: the full chain in, at equal
        // score). Back before that, its fold still reads Lo's close of R + 1
        // as the tip and its seed for it goes out (revealDuty), deciding
        // R + 1 there: Lo's chain then scores one more (computedFold: a
        // decided close scores one more than its best child) and is kept,
        // not the one this scenario follows.
        if (qBackAt === null && foldOf(Q!).rounds.find((v) => v.r === 2)?.close === keptR2) {
          qBackAt = sim.elapsed + 3_000;
          const q = Q!;
          sim.at(qBackAt, () => { q.pauseUntil = 0; });
        }
        // Healed: F's felt on the open roll put down again, the first
        // version past the one the close froze.
        if (again === null && slip !== null) {
          const later = keysOf(F!, `s:${R + 1}:${F!.pid}:`).map((k) => slipOf(F!, k)!).filter((x) => x.v > slip!.v).sort((x, y) => x.v - y.v)[0];
          if (later) again = later;
        }
      });
      for (let i = 0; i < 20 && phase !== 'healed'; i++) await sim.run(30_000);
      expect(phase, sim.label).toBe('healed');
      await runTo(sim, a, R + 1, 3 * 60_000);
      const merged = foldOf(a);
      const next = merged.rounds.find((v) => v.r === R + 1);
      const played = next ? slipOf(a, `s:${R + 1}:${F!.pid}:${next.frozen[F!.pid]}`) : null;
      // (A side may trim apart, on idle or on the rounds: the other side's
      // cards then flag the checkpoint that differs from what they saw, as
      // the design's lever 5 says the card does, and as roulette's split
      // allows it, computedSim.test.ts.)
      const s = await finish(sim, lines, { flips: ['rival close', 'other branch', 'undone', 'checkpoint'] });
      const fate = next?.craps?.fates.get(F!.pid);
      const stood = next ? stampOf(next.craps!.sIn.p, next.craps!.sIn.w[F!.pid] ?? []) : null;
      console.log(`[craps] ${sim.label}: split ${splitAt}-${healAt} ms, kept ${W.map((sp) => sp.name)} (decided ${wAtHeal}), R ${R}, F ${F!.name} Q ${Q!.name}, frozen ${JSON.stringify(slip)}, again ${JSON.stringify(again)}, roll ${R + 1} ${next?.decided} played v${played?.v} fate ${fate}, flips ${JSON.stringify(s.flipKinds)}`);
      // Apart for 3 minutes: X made the point on roll 2, Y sevened out.
      expect(healAt - splitAt, sim.label).toBeGreaterThanOrEqual(180_000);
      expect(sides.make!.pointBefore, sim.label).toBe(6);
      expect(sides.make!.dice![0] + sides.make!.dice![1], sim.label).toBe(6);
      expect(sides.make!.pointAfter, sim.label).toBeNull();
      expect(sides.make!.sevenOut, sim.label).toBe(false);
      expect(sides.seven!.sevenOut, sim.label).toBe(true);
      // Healed with the kept side at roll R and the dropped side's close of
      // R + 1 in: the chain kept W's roll 2.
      expect(wAtHeal, sim.label).toEqual(W.map(() => R));
      // (The pace kept every page from trimming apart: see above.)
      expect(basesAtHeal, `${sim.label}: checkpoints apart`).toEqual(sim.pages.map(() => 0));
      // (Or, the kept side trimmed past roll 2 apart, its checkpoint's
      // close: the chain leads back through it to W's roll 2.)
      const kept2 = merged.rounds.find((v) => v.r === 2);
      if (kept2) expect(kept2.craps!.sevenOut, sim.label).toBe(W === Y);
      else expect(merged.base.u, sim.label).toBeGreaterThanOrEqual(2);
      expect(chainSide(kept2 ? kept2.close : merged.base.l), sim.label).toBe(W === X ? 'X' : 'Y');
      // F's felt, its seed out for the dropped close, went down again under
      // a fresh seed with its own stamp and bets; the close froze that
      // version; on the kept chain the stamp is out of date, and the felt
      // played as the bets stood there ('basis': nothing rides for F).
      expect(slip, sim.label).not.toBeNull();
      expect(slip!.b, sim.label).toBe(JSON.stringify(canonList([field, place8])));
      expect(again, sim.label).not.toBeNull();
      expect(again!.o, sim.label).toBe(slip!.o);
      expect(again!.b, sim.label).toBe(slip!.b);
      expect(again!.c, sim.label).not.toBe(slip!.c);
      expect(next?.decided, sim.label).toBeTruthy();
      expect(played, sim.label).toEqual(again);
      expect(stood, sim.label).not.toBe(slip!.o);
      expect(fate, sim.label).toBe('basis');
      expect(next!.craps!.sOut.w[F!.pid] ?? [], sim.label).toEqual([]);
      // The dropped side's pages showed rolls the chain doesn't keep.
      expect(Lo.every((sp) => (sp.flipKinds['rival close'] ?? 0) > 0), sim.label).toBe(true);
    }, TIMEOUT);
  }
});

// ── ✂️ Trims ─────────────────────────────────────────────────────────────────

describe('computed craps: trims', () => {
  for (const n of SEEDS) {
    it(`trim-mid-point ${n}: a hand runs TRIM_ROUNDS rolls with the point on; the table trims mid-point, the checkpoint carrying the point and every bet riding, and those bets pay from it as the point is made`, async () => {
      const sim = await Sim.open({ name: 'craps-trim-mid-point', seed: seed(1400 + n), tables: crapsTable, pages: trio() });
      const [a, b] = sim.pages;
      const { table } = a.p;
      // Roll 1 makes the point 6, every pass riding (A's place 8 too); on
      // roll 2 A backs its pass with odds and B puts a come bet up, which
      // the roll's 9 carries to 9; then rolls that decide nothing on the
      // line nor on 9, until the point is made on roll TRIM_ROUNDS + 1 or + 2.
      const made = table.TRIM_ROUNDS + 1 + Math.floor(sim.rand() * 2);
      rigRolls(sim, sim.pages, (r) => (r === 1 || r === made ? { sum: 6 } : r === 2 ? { sum: 9 } : r < made ? { sum: neutral(sim, 6, [9]) } : null));
      script(sim, sim.pages, (sp, r, felt) => {
        if (r === 1) return sp === a ? [pass(10), { type: 'place', pick: 8, amount: 10 }] : [pass(10)];
        if (r === 2 && sp === a) return canonList([...felt, { type: 'passodds', amount: 10 }]);
        if (r === 2 && sp === b) return canonList([...felt, { type: 'come', amount: 5 }]);
        return null;
      });
      const cps = watchCheckpoints(sim, a);
      await runTo(sim, a, made + 1, 20 * 60_000);
      const s = await finish(sim, lines, { basesKnown: true });
      console.log(`[craps] ${sim.label}: made ${made}, checkpoints ${JSON.stringify(cps.map((c) => ({ u: c.u, p: c.p, riders: c.riders, bytes: c.bytes, pre: c.pre })))}`);
      // The trim at TRIM_ROUNDS, mid-point: the point on and the three
      // passes riding (A's odds and place 8, B's come bet on 9 with them),
      // pressed by the rounds alone (the session short of TRIM_BYTES).
      const cp = cps.find((c) => c.u === table.TRIM_ROUNDS);
      expect(cp, sim.label).toBeDefined();
      expect(cps.filter((c) => c.u < table.TRIM_ROUNDS), sim.label).toEqual([]);
      expect(cp!.p, sim.label).toBe(6);
      expect(cp!.riders, sim.label).toBe(3);
      expect(cp!.w[a.pid], sim.label).toEqual(canonList([pass(10), { type: 'passodds', amount: 10 }, { type: 'place', pick: 8, amount: 10 }]));
      expect(cp!.w[b.pid], sim.label).toEqual(canonList([pass(10), { type: 'come', pick: 9, amount: 5 }]));
      expect(cp!.pre!.D - cp!.pre!.baseU, sim.label).toBeGreaterThanOrEqual(table.TRIM_ROUNDS);
      expect(cp!.pre!.rawBytes, sim.label).toBeLessThan(table.TRIM_BYTES);
      expect(cp!.pre!.sevenOut, sim.label).toBe(false);
      // Past the trim, the point made: the bets the checkpoint carried pay
      // (A's pass and odds).
      sim.enter(a);
      const res = a.p.casino.computedFoldOf(T)!;
      expect(res.base.u, sim.label).toBe(table.TRIM_ROUNDS);
      const v = res.rounds.find((x) => x.r === made)!;
      expect(v.craps!.pointBefore, sim.label).toBe(6);
      expect(v.craps!.dice![0] + v.craps!.dice![1], sim.label).toBe(6);
      expect(v.craps!.amounts.get(a.pid) ?? 0n, sim.label).toBeGreaterThan(0n);
      expect(s.trims, sim.label).toBeGreaterThan(0);
      expect(sim.craps!.stats.basesChecked, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);

    it(`seven-out-trim ${n}: a hand that sevens out short of 8 rolls trims nothing; the next sevens out 8 rolls or more past the base, under TRIM_ROUNDS and TRIM_BYTES, and the table trims there, its checkpoint small with nothing riding`, async () => {
      const sim = await Sim.open({ name: 'craps-seven-out-trim', seed: seed(1500 + n), tables: crapsTable, pages: trio() });
      const [a] = sim.pages;
      const { table } = a.p;
      // Hand 1: the point 6 on roll 1, a seven-out on roll s1 (3-5). Hand
      // 2: a point on roll s1 + 1, a seven-out on roll s2: TRIM_SEVEN_OUT_MIN
      // rolls past the base exactly on the first seed (the trim's edge), one
      // and two more on the others. Every come-out the bettors put a pass
      // down; between, rolls that decide nothing on the line.
      const s1 = 3 + Math.floor(sim.rand() * 3);
      const s2 = TRIM_SEVEN_OUT_MIN + SEEDS.indexOf(n);
      const p2 = [4, 5, 8, 9, 10][Math.floor(sim.rand() * 5)];
      rigRolls(sim, sim.pages, (r) => (r === 1 ? { sum: 6 } : r < s1 ? { sum: neutral(sim, 6) } : r === s1 || r === s2 ? { sum: 7 }
        : r === s1 + 1 ? { sum: p2 } : r < s2 ? { sum: neutral(sim, p2) } : null));
      script(sim, sim.pages, (_sp, _r, felt, point) => (point === null && !felt.some((x) => x.type === 'pass') ? canonList([...felt, pass(10)]) : null));
      const cps = watchCheckpoints(sim, a);
      await runTo(sim, a, s2 + 2, 15 * 60_000);
      const s = await finish(sim, lines, { basesKnown: true });
      console.log(`[craps] ${sim.label}: seven-outs ${s1}, ${s2}, checkpoints ${JSON.stringify(cps.map((c) => ({ u: c.u, p: c.p, riders: c.riders, bytes: c.bytes, pre: c.pre })))}`);
      // Nothing at the short hand's seven-out (s1 rolls past the base:
      // under TRIM_SEVEN_OUT_MIN), the trim at the second's.
      expect(s1, sim.label).toBeLessThan(TRIM_SEVEN_OUT_MIN);
      expect(s2, sim.label).toBeGreaterThanOrEqual(TRIM_SEVEN_OUT_MIN);
      expect(cps.filter((c) => c.u < s2), sim.label).toEqual([]);
      const cp = cps.find((c) => c.u === s2);
      expect(cp, sim.label).toBeDefined();
      // Pressed by the seven-out alone: short of TRIM_ROUNDS, of TRIM_BYTES
      // and of the room's budget; nothing riding, so a small checkpoint
      // (the design's D2/D3: "the felt is empty there, so it costs one
      // small checkpoint").
      const pre = cp!.pre!;
      expect(pre.sevenOut, sim.label).toBe(true);
      expect(pre.D - pre.baseU, sim.label).toBeGreaterThanOrEqual(TRIM_SEVEN_OUT_MIN);
      expect(pre.D - pre.baseU, sim.label).toBeLessThan(table.TRIM_ROUNDS);
      expect(pre.rawBytes, sim.label).toBeLessThan(table.TRIM_BYTES);
      expect(pre.rawBytes < table.ROOM_MIN_BYTES || pre.room < table.ROOM_BYTES, sim.label).toBe(true);
      expect(cp!.p, sim.label).toBe(0);
      expect(cp!.riders, sim.label).toBe(0);
      expect(cp!.bytes, sim.label).toBeLessThan(1_024);
      expect(s.trims, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);

    it(`trim-during-wait ${n}: betting opens on a version its player then replaces; a trim during the wait for the throw copies only the latest versions, and the end of betting doesn't move on any page`, async () => {
      // The shooters throw late in the wait (14-18 s), so a trim the session
      // is due as the wait starts comes before the close. X, a page with no
      // frames, weighs the session to TRIM_BYTES with junk the fold weighs
      // and never reads (the trim specs' own device: computedCrapsTrim
      // weigh): the trim drops it, and the session never passes TRIM_BYTES.
      const sim = await Sim.open({
        name: 'craps-trim-during-wait', seed: seed(1600 + n), tables: crapsTable,
        pages: [...trio({ fling: [14_000, 18_000], lateEvery: 0 }), { name: 'X', place: 'off', bot: null, honest: false }],
      });
      const [a, b, c, x] = sim.pages;
      const bettors = [a, b, c];
      x.cheats = true;
      x.beforeFrame = () => false;
      const { table, croupier } = a.p;
      // A opens each roll's window with one chip on the field, and 2 s on
      // makes it two (a version that replaces the one that opened the
      // window); B and C put theirs down 4 s into the window.
      const field = (amount: number): CrapsBet[] => [{ type: 'field', amount }];
      steer(sim, bettors, (sp, _r, felt, deadline, now) => {
        const into = deadline === undefined ? -Infinity : now - (deadline - croupier.CRAPS_BET_WINDOW_MS);
        if (sp === a) return felt.length === 0 ? field(1) : into >= 2_000 && felt[0].amount === 1 ? field(2) : null;
        return felt.length === 0 && into >= 4_000 ? field(1) : null;
      });
      // Once, from the third roll: 0.5 s into the wait on A's screen, no
      // close in, the session weighed to TRIM_BYTES; A's versions on the
      // roll kept.
      let weighed: { r: number; at: number; v1: string; v2: string } | null = null;
      sim.every(async () => {
        if (weighed || sim.healed) return;
        const nowA = sim.enter(a);
        const v = a.p.table.readComputedCraps(T, nowA);
        if (!v || v.round < 3 || v.phase !== 'closing' || v.phaseDeadline === undefined || v.shooter === undefined) return;
        if (nowA < v.phaseDeadline - croupier.CRAPS_SHOOTER_MS + 500) return;
        await sim.as(x, () => {
          const res = x.p.casino.computedFoldOf(T);
          const ses = x.p.casino.computedSessionForWrite(T);
          if (!res || !ses || res.tip || res.openCloses.length > 0 || res.open !== v.round) return;
          const mine = [...ses.keys()].filter((k) => k.startsWith(`s:${v.round}:${a.pid}:`))
            .map((k) => ({ k, v: (ses.get(k) as { v: number }).v })).sort((p, q) => p.v - q.v);
          if (mine.length !== 2) return;
          putIn(x.p, [['junk', 'x'.repeat(table.TRIM_BYTES - res.rawBytes - 'junk'.length - 2)]], T);
          weighed = { r: v.round, at: sim.elapsed, v1: mine[0].k, v2: mine[1].k };
        });
      });
      // Each bettor's view of the weighed roll in the wait: the session it
      // read and the wait's end (D: the end of betting + the wait).
      const waits = new Map<string, { sid: string; D: number; keys: { v1: boolean; v2: boolean } }[]>();
      sim.every(() => {
        if (!weighed) return;
        for (const sp of bettors) {
          if (sp.mode !== 'up') continue;
          const now = sim.enter(sp);
          const v = sp.p.table.readComputedCraps(T, now);
          const res = sp.p.casino.computedFoldOf(T);
          const ses = sp.p.casino.computedSessionForWrite(T);
          if (!v || !res || !ses || v.round !== weighed.r || v.phase !== 'closing' || v.phaseDeadline === undefined || v.shooter === undefined) continue;
          let list = waits.get(sp.name);
          if (!list) waits.set(sp.name, list = []);
          list.push({ sid: res.base.sid, D: v.phaseDeadline, keys: { v1: ses.has(weighed.v1), v2: ses.has(weighed.v2) } });
        }
      });
      const cps = watchCheckpoints(sim, a);
      for (let i = 0; i < 16 && !weighed; i++) await sim.run(30_000);
      await sim.run(60_000);
      const s = await finish(sim, lines, { basesKnown: true });
      const summary = [...waits].map(([name, l]) => `${name}: ${[...new Set(l.map((w) => `${w.sid.slice(0, 6)} D=${w.D} v1=${w.keys.v1} v2=${w.keys.v2}`))].join(' / ')}`);
      console.log(`[craps] ${sim.label}: weighed ${JSON.stringify(weighed)}, checkpoints ${JSON.stringify(cps.map((c) => ({ u: c.u, at: c.at })))}, waits ${summary.join('; ')}`);
      expect(weighed, sim.label).not.toBeNull();
      const w = weighed!;
      // The trim came during the wait: a checkpoint of the roll before.
      const cp = cps.find((q) => q.u === w.r - 1 && q.at >= w.at);
      expect(cp, sim.label).toBeDefined();
      for (const sp of bettors) {
        const l = waits.get(sp.name) ?? [];
        const sids = [...new Set(l.map((q) => q.sid))];
        // Each page read the wait in the session before the trim (A's first
        // version in it, the one that opened the window) and after it (only
        // the version that replaced it), and the wait's end didn't move.
        expect(sids.length, `${sim.label} ${sp.name}`).toBe(2);
        expect(l.filter((q) => q.sid === sids[0]).every((q) => q.keys.v1 && q.keys.v2), `${sim.label} ${sp.name}`).toBe(true);
        expect(l.filter((q) => q.sid === sids[1]).every((q) => !q.keys.v1 && q.keys.v2), `${sim.label} ${sp.name}`).toBe(true);
        expect(new Set(l.map((q) => q.D)).size, `${sim.label} ${sp.name} ${JSON.stringify(l.map((q) => q.D))}`).toBe(1);
      }
      expect(s.trims, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 📜 Long history ──────────────────────────────────────────────────────────

/** The rolls each seed plays: the design's 500 (SIM_LONG: 1,000). */
const LONG_ROLLS = SIM_LONG ? 1_000 : 500;
/** The runs: the design's three seeds, a lone shooter each, then a fourth
 *  with a second bettor whose bets ride from roll to roll (the checkpoint
 *  carries more than one player's), over 150 rolls (SIM_LONG: the seeds'):
 *  a room of two costs each roll about 2.7 times one alone, and 150 rolls
 *  are 7 trims at least, each carrying both players' bets riding. */
const LONG_RUNS = [
  ...SEEDS.map((n) => ({ n, rolls: LONG_ROLLS, pair: false })),
  { n: SEEDS.length + 1, rolls: SIM_LONG ? LONG_ROLLS : 150, pair: true },
];

describe('computed craps: long history', () => {
  LONG_RUNS.forEach(({ n, rolls, pair }) => {
    it(`long-history ${n}: ${rolls} rolls${pair ? ", a second bettor's pass and place bets riding" : ''}; the table trims every TRIM_ROUNDS rolls at most, and the checkpoint's size stays bounded`, async () => {
      // A shooter (the room's cost is per page: one alone keeps 500 rolls
      // inside a minute of wall time) who throws at once, puts a chip on
      // the field as each roll opens unless bets ride, and plays every
      // type now and then; who never takes a bet down (a lone player who
      // takes everything down in the window's last second leaves nobody to
      // close: the re-arm of the design's "Nobody left to close", the
      // full and churn scenarios' case, not this one's). On the last seed
      // a second player, B, at stand 5: a pass on each come-out, place 6
      // and 8 once a point is on, riding until a seven-out takes them.
      const quick = { ...CRAPS_BOT, takeOne: 0, takeAll: 0, tries: 0, standMove: 0, fake: 0, fling: [0, 500] as [number, number], lateEvery: 0 };
      const sim = await Sim.open({
        name: 'craps-long-history', seed: seed(1700 + n), tables: crapsTable,
        pages: [
          { name: 'A', place: 1, crapsBot: { ...quick, move: 0.02 } },
          ...(pair ? [{ name: 'B', place: 5, chips: 5_000, crapsBot: { ...quick, move: 0 } }] : []),
        ],
      });
      const [a, b] = sim.pages;
      const { table } = a.p;
      script(sim, [a], (_sp, _r, felt) => (felt.length === 0 ? [{ type: 'field', amount: 1 }] : null));
      if (pair) {
        const has = (f: CrapsBet[], type: CrapsBet['type'], pick?: number): boolean => f.some((x) => x.type === type && x.pick === pick);
        script(sim, [b], (_sp, _r, felt, point) => {
          if (point === null) return has(felt, 'pass') ? null : canonList([...felt, pass(10)]);
          const add = [6, 8].filter((x) => !has(felt, 'place', x)).map((x): CrapsBet => ({ type: 'place', pick: x, amount: 12 }));
          return add.length > 0 ? canonList([...felt, ...add]) : null;
        });
      }
      const cps = watchCheckpoints(sim, a);
      const t0 = performance.now();
      await runTo(sim, a, rolls, rolls * 60_000);
      const wall = performance.now() - t0;
      const s = await finish(sim, lines, { basesKnown: true });
      const bytes = cps.map((c) => c.bytes);
      // What a checkpoint holds past the bets riding (its signature and
      // links, the round, the point, the dice's holder, the nets).
      const rest = cps.map((c) => c.bytes - JSON.stringify(c.w).length);
      console.log(`[craps] ${sim.label}: rolls ${s.rounds} in ${(sim.elapsed / 60_000).toFixed(0)} min (${(wall / 1000).toFixed(1)} s wall), checkpoints ${cps.length} (every ${JSON.stringify([...new Set(cps.slice(1).map((c, j) => c.u - cps[j].u))])} rolls), bytes ${Math.min(...bytes)}-${Math.max(...bytes)}, less the bets riding ${Math.min(...rest)}-${Math.max(...rest)}, riders ≤${Math.max(...cps.map((c) => c.riders))}, doc ≤${s.maxDocBytes}, session ≤${s.maxSessionBytes}`);
      expect(s.rounds, sim.label).toBeGreaterThanOrEqual(rolls);
      // A trim at least every TRIM_ROUNDS rolls, each covering more.
      expect(cps.length, sim.label).toBeGreaterThanOrEqual(Math.floor(rolls / table.TRIM_ROUNDS));
      for (let j = 1; j < cps.length; j++) {
        expect(cps[j].u, sim.label).toBeGreaterThan(cps[j - 1].u);
        expect(cps[j].u - cps[j - 1].u, sim.label).toBeLessThanOrEqual(table.TRIM_ROUNDS);
      }
      // Bounded: no checkpoint over 2 KB; what one carries is the point,
      // the bets riding (whatever is on the felt as it trims) and the nets,
      // and past the bets it is the same size from the first trim to the
      // last (the round's and the nets' digits aside: 64 bytes): nothing in
      // it grows with the rolls.
      expect(Math.max(...bytes), sim.label).toBeLessThan(2_048);
      expect(Math.max(...rest) - Math.min(...rest), sim.label).toBeLessThanOrEqual(64);
      expect(s.maxSessionBytes, sim.label).toBeLessThan(table.TRIM_BYTES);
      // The second bettor's bets did ride through a trim: some checkpoint
      // carries both players' (else the seed showed one player's only).
      if (pair) expect(Math.max(...cps.map((c) => c.riders)), sim.label).toBeGreaterThanOrEqual(2);
    }, TIMEOUT);
  });
});
