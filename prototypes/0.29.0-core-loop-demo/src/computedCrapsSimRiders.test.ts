/**
 * 🧪🎲🌐 Computed craps over the simulated network: riders, the players
 * whose bets stay on the felt from roll to roll (the design's simulation
 * scenarios slow-network, riders-only, riders-away and background-rider).
 * Each scenario runs three seeds through the shared finish
 * (computedCrapsSimKit: the checker's walk of every fold, every oracle, the
 * stall budgets by phase) and asserts what the design says it must show,
 * with counters that prove each case happened on every seed. Where the
 * design names words on screen, the real table UI is mounted on the page
 * (computedCrapsUiKit) and its words are read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_LONG, Sim } from './computedSim';
import type { SimPage } from './computedSim';
import { canonList, CRAPS_BOT } from './computedCrapsSim';
import type { CrapsBotSpec } from './computedCrapsSim';
import { T, TIMEOUT, finish, named, seed } from './computedCrapsSimKit';
import { atCraps, stubDom, withUI } from './computedCrapsUiKit';
import type { AtCraps, FakeEl, UIPage } from './computedCrapsUiKit';
import { rigRoll } from './computedPageKit';
import type { Page } from './computedPageKit';
import type { CrapsSlipRec } from './computedFold';
import type { CrapsCarry } from './computedCraps';
import { crapsBetLabel } from './games/craps';
import type { CrapsBet } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A scenario's run (SIM_LONG: 20 minutes). */
const RUN_MS = (SIM_LONG ? 20 : 6) * 60_000;
const SEEDS = [1, 2, 3];
const lines: string[] = [];
const crapsTable = [{ id: T, game: 'craps' as const }];

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

// ── 🧰 This file's kit ───────────────────────────────────────────────────────

/** A player the scenario bets for by hand (bet): no moves, tries or stand
 *  moves of its own; it throws the dice it is offered 1–6 s into the wait
 *  (never past it). */
const QUIET: CrapsBotSpec = { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0, lateEvery: 0, fling: [1_000, 6_000] };

/** The table UI's modules on every load of a page (computedCrapsUiKit
 *  withUI, in its own generation). */
const withTableUI = async (p: Page): Promise<void> => {
  await withUI(p);
};
/** A DOM whose timers do nothing (the sim drives the UI by hand): its body,
 *  where the HUD's hints go. */
function uiDom(): FakeEl {
  return stubDom({ setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
}
/** The globals as the file has them (a scenario with a table UI done). */
function noDom(): void {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
}

/** Chips on felt f's spot (type, pick). */
const amt = (f: readonly CrapsBet[], type: CrapsBet['type'], pick?: number): number =>
  f.filter((b) => b.type === type && b.pick === pick).reduce((m, b) => m + b.amount, 0);
const canonText = (f: readonly CrapsBet[]): string => JSON.stringify(canonList(f));
const ridingOf = (k: CrapsCarry, pid: string): CrapsBet[] => k.w[pid] ?? [];

/** Page sp's player puts a felt down as a press on its table would: `edit`
 *  gives the whole felt from the one it has and the point (null: no
 *  press), written through the writer while betting is open with more than
 *  `margin` ms left, held to the slip oracle (CrapsHarness press). The
 *  writer's answer ('ok'; 'closed' or 'reconnecting' as a window shuts or a
 *  page catches up), or null when nothing was pressed. Any other answer is a
 *  violation: the scenarios bet within the rules and their chips. */
async function bet(
  sim: Sim, sp: SimPage, edit: (felt: CrapsBet[], point: number | null, round: number) => CrapsBet[] | null, margin = 2_000,
): Promise<string | null> {
  if (sp.mode !== 'up' || sp.leaving || sim.T < sp.pauseUntil) return null;
  const got = await sim.as(sp, (now) => {
    const { table } = sp.p;
    const v = table.readComputedCraps(T, now);
    if (!v || v.phase !== 'betting' || (v.phaseDeadline !== undefined && now >= v.phaseDeadline - margin)) return null;
    const { felt, basis } = table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
    const want = edit(felt, v.point, v.round);
    if (want === null) return null;
    const list = canonList(want);
    const res = sim.craps!.press(sp, T, v.round, list, basis, () => table.writeComputedCrapsSlip(T, list, basis, now));
    if (res !== 'ok' && res !== 'closed' && res !== 'reconnecting') {
      sim.violate(`${sp.name}'s felt ${JSON.stringify(list)} over ${JSON.stringify(felt)} at roll ${v.round} at ${sim.elapsed} ms answered ${res}`);
    }
    return res;
  });
  return got;
}

/** A decided roll as the reference page's fold has it (the latest close and
 *  decision of each roll), with the slips its close froze. */
interface Roll {
  inc: string;
  r: number;
  close: string;
  decided: string;
  /** The close's signer (a page's pub). */
  closer: string;
  /** When the reference page first held it so (ms into the run). */
  at: number;
  present: string[];
  revealed: string[];
  counted: string[];
  slips: Map<string, CrapsSlipRec>;
  dice: [number, number] | null;
  pointBefore: number | null;
  pointAfter: number | null;
  sevenOut: boolean;
  sIn: CrapsCarry;
  sOut: CrapsCarry;
  fates: Map<string, string>;
  amounts: Map<string, bigint>;
  lost: Map<string, bigint>;
}

/** Every decided roll page ref folds, each tick (in the order first held). */
function rollLog(sim: Sim, ref: SimPage): Roll[] {
  const out: Roll[] = [];
  const at = new Map<string, number>();
  sim.every(() => {
    if (ref.mode !== 'up') return;
    sim.enter(ref);
    const { casino } = ref.p;
    const inc = casino.computedIncOf(T);
    const res = casino.computedFoldOf(T);
    const ses = casino.computedSessionForWrite(T);
    if (!inc || !res) return;
    for (const v of res.rounds) {
      if (!v.decided || !v.craps) continue;
      const key = `${inc}|${v.r}`;
      const i = at.get(key);
      if (i !== undefined && out[i].close === v.close && out[i].decided === v.decided) continue;
      const slips = new Map<string, CrapsSlipRec>();
      for (const pid of v.present) {
        const rec = ses?.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as CrapsSlipRec | undefined;
        if (rec) slips.set(pid, rec);
      }
      const roll: Roll = {
        inc, r: v.r, close: v.close, decided: v.decided, closer: v.closeRec.k, at: sim.elapsed,
        present: [...v.present], revealed: [...v.revealed], counted: [...v.counted], slips,
        dice: v.craps.dice, pointBefore: v.craps.pointBefore, pointAfter: v.craps.pointAfter, sevenOut: v.craps.sevenOut,
        sIn: v.craps.sIn, sOut: v.craps.sOut, fates: new Map(v.craps.fates), amounts: new Map(v.craps.amounts), lost: new Map(v.craps.lost),
      };
      if (i === undefined) {
        at.set(key, out.length);
        out.push(roll);
      } else {
        out[i] = roll;
      }
    }
  });
  return out;
}

/** The last decided roll page sp folds (its number, 0 with none). */
function lastRollOf(sp: SimPage): number {
  const res = sp.p.casino.computedFoldOf(T);
  if (!res) return 0;
  let u = res.base.u;
  for (const v of res.rounds) if (v.decided) u = v.r;
  return u;
}

/** Page sp's player's walk-off notice as the design words it: the felt, at
 *  most 4 bets named, then how many more. */
function walkOffWords(felt: readonly CrapsBet[]): string {
  const named4 = felt.slice(0, 4).map((b) => `${crapsBetLabel(b)} ${b.amount}`);
  const more = felt.length > 4 ? ` · AND ${felt.length - 4} MORE` : '';
  return `YOUR BETS RIDE WHILE YOU'RE AWAY — ${named4.join(' · ')}${more}`;
}
const signedChips = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

// ── 🐢 slow-network ──────────────────────────────────────────────────────────

describe('computed craps: slow-network', () => {
  for (const n of SEEDS) {
    it(`slow-network ${n}: riders play over a slow network (300-800 ms on every link, 5% of updates lost)`, async () => {
      // A, B and C play every bet type (the baseline's bots); D and E are
      // riders at their stands: a pass on each come-out and place 6 and 8
      // once a point is on, then nothing but what rides.
      const sim = await Sim.open({
        name: 'craps-slow-network', seed: seed(2100 + n), tables: crapsTable, link: { delay: [300, 800], loss: 0.05 },
        pages: [...named('ABC'), { name: 'D', place: 6, crapsBot: QUIET }, { name: 'E', place: 7, crapsBot: QUIET }],
      });
      const craps = sim.craps!;
      const riders = sim.pages.slice(3);
      const log = rollLog(sim, sim.pages[0]);
      sim.every(async () => {
        if (sim.healed) return;
        for (const sp of riders) {
          await bet(sim, sp, (felt, point) => {
            if (point === null) return amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
            if (amt(felt, 'place', 6) === 0) return [...felt, { type: 'place', pick: 6, amount: 12 }];
            if (amt(felt, 'place', 8) === 0) return [...felt, { type: 'place', pick: 8, amount: 12 }];
            return null;
          });
        }
      });
      await sim.run(RUN_MS);
      // Scoped, as roulette's slow network (computedSim.test.ts): a lost
      // update can rewrite a roll some pages showed, in the ways the design
      // accepts: a seed lost on a link, its ask's answer too, is forfeited
      // by the page it was lost to, and a valid forfeit beats the full set
      // the others showed ('forfeit over reveals', pr2-verdict.md Q4), or a
      // page that saw it in time answers ('answer forfeit'); a close lost
      // on its way to the next closer brings an honest rival close, which
      // can win by the chain rule ('rival close'). And at craps a roll so
      // rewritten hands the rolls after it another table: "late changes to
      // earlier rolls are counted on their own, one count per roll paid
      // again" (pr3-design-v6.md, Simulation scenarios: 'repaid').
      const s = await finish(sim, lines, { flips: ['forfeit over reveals', 'answer forfeit', 'rival close', 'repaid'] });
      const rolls = log.filter((x) => x.dice);
      // Each rider's bets played on rolls with dice; on some its own ride
      // slip (its riding bets, no change, its seed counted) was frozen over
      // the slow links; and some of its bets were decided.
      const per = riders.map((sp) => {
        const rode = rolls.filter((x) => ridingOf(x.sIn, sp.pid).length > 0);
        const slipped = rode.filter((x) => {
          const rec = x.slips.get(sp.pid);
          return rec !== undefined && canonText(rec.b) === canonText(ridingOf(x.sIn, sp.pid)) && x.counted.includes(sp.pid);
        });
        const decided = rode.filter((x) => x.amounts.has(sp.pid));
        return { name: sp.name, rode: rode.length, slipped: slipped.length, decided: decided.length };
      });
      console.log(`[craps] ${sim.label}: lost ${s.lost}, asks ${s.resyncAsks}, partial ${s.partialEpisodes}, rolls ${rolls.length}, forfeits ${s.byForfeit}, flips ${JSON.stringify(s.flips)}, riders ${JSON.stringify(per)}, ownSlips ${craps.stats.ownSlips}`);
      expect(s.lost, sim.label).toBeGreaterThan(0);
      expect(s.resyncAsks, sim.label).toBeGreaterThan(0);
      expect(rolls.length, sim.label).toBeGreaterThanOrEqual(Math.floor(RUN_MS / 60_000) * 1.2);
      for (const p of per) {
        expect(p.rode, `${sim.label} ${p.name}`).toBeGreaterThan(0);
        expect(p.slipped, `${sim.label} ${p.name}`).toBeGreaterThan(0);
        expect(p.decided, `${sim.label} ${p.name}`).toBeGreaterThan(0);
      }
      expect(craps.stats.ownSlips, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🎯 riders-only ───────────────────────────────────────────────────────────

describe('computed craps: riders-only', () => {
  for (const n of SEEDS) {
    it(`riders-only ${n}: a lone shooter with pass and odds keeps rolling (ride slips alone close the rolls; the dice stay in their hand, through a seven-out too)`, async () => {
      // A, alone at stand 3, puts a pass down on each come-out and twice its
      // flat in odds once the point is on; nothing else. H is the house's
      // page, off the table (it bets nothing and closes nothing).
      const sim = await Sim.open({
        name: 'craps-riders-only', seed: seed(2200 + n), tables: crapsTable,
        pages: [{ name: 'A', place: 3, crapsBot: QUIET }, { name: 'H', house: true, bot: null }],
      });
      const craps = sim.craps!;
      const [a, h] = sim.pages;
      const log = rollLog(sim, h);
      sim.every(async () => {
        if (sim.healed) return;
        await bet(sim, a, (felt, point) => {
          const pass = amt(felt, 'pass');
          if (point === null) return pass === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
          return pass > 0 && amt(felt, 'passodds') === 0 ? [...felt, { type: 'passodds', amount: 2 * pass }] : null;
        });
      });
      await sim.run(RUN_MS);
      // Then on, a minute at a time, until the hand has sevened out once
      // (the dice back in the lone shooter's hand), 10 minutes more at most.
      for (let extra = 0; extra < 10 * 60_000 && !log.some((x) => x.sevenOut); extra += 60_000) await sim.run(60_000);
      const s = await finish(sim, lines, { bettors: 1 });
      const st = craps.stats;
      const { croupier, table } = h.p;
      const rolls = log.filter((x) => x.dice);
      // It kept rolling: from one roll's result to the next, a show, a
      // window, the throw (6 s at most) and the turns, never more.
      const gaps = rolls.slice(1).map((x, i) => x.at - rolls[i].at);
      const gapMax = croupier.CRAPS_SHOW_MS + croupier.CRAPS_BET_WINDOW_MS + QUIET.fling[1] + 3 * table.STAGGER_MS + 2_000;
      // Every roll after the stickman's first waited for A's throw and was
      // closed by A's own page; A held the dice after every roll, in play
      // (a lone shooter who sevens out gets them back).
      const thrown = rolls.filter((x) => x.sIn.h === a.pid && x.sIn.i === 1);
      const theirs = rolls.filter((x) => x.sOut.h === a.pid && x.sOut.i === 1);
      // Rolls the riding bets alone closed: A's frozen felt exactly what
      // rode in (its ride slip); and rolls with the pass and its odds riding.
      const rideOnly = rolls.filter((x) => {
        const rec = x.slips.get(a.pid);
        const C = ridingOf(x.sIn, a.pid);
        return rec !== undefined && C.length > 0 && canonText(rec.b) === canonText(C);
      });
      const withOdds = rolls.filter((x) => amt(ridingOf(x.sIn, a.pid), 'pass') > 0 && amt(ridingOf(x.sIn, a.pid), 'passodds') > 0);
      const sevenOuts = rolls.filter((x) => x.sevenOut);
      console.log(`[craps] ${sim.label}: rolls ${rolls.length}, gaps ≤${(Math.max(...gaps) / 1000).toFixed(1)}s/${(gapMax / 1000).toFixed(1)}, thrown ${thrown.length}, ride-only ${rideOnly.length}, with odds ${withOdds.length}, seven-outs ${sevenOuts.length}, flings ${st.flings}`);
      expect(rolls.length, sim.label).toBeGreaterThanOrEqual(Math.floor(RUN_MS / gapMax));
      expect(Math.max(...gaps), sim.label).toBeLessThanOrEqual(gapMax);
      expect(rolls[0].sIn.h, sim.label).toBeUndefined();
      expect(thrown.length, sim.label).toBe(rolls.length - 1);
      expect(theirs.length, sim.label).toBe(rolls.length);
      expect(thrown.every((x) => x.closer === a.p.pub), sim.label).toBe(true);
      expect(st.flings, sim.label).toBeGreaterThanOrEqual(thrown.length);
      expect(st.timesUp, sim.label).toBe(0);
      expect(rideOnly.length, sim.label).toBeGreaterThan(0);
      expect(withOdds.length, sim.label).toBeGreaterThan(0);
      expect(sevenOuts.length, sim.label).toBeGreaterThan(0);
      expect(s.voids, sim.label).toBe(0);
      expect(s.byForfeit, sim.label).toBe(0);
    }, TIMEOUT);
  }
});

// ── 🚶 riders-away ───────────────────────────────────────────────────────────

type AwayPhase = 'setup' | 'off' | 'pause' | 'resume' | 'cback' | 'leave' | 'away' | 'return' | 'done';

describe('computed craps: riders-away', () => {
  for (const n of SEEDS) {
    it(`riders-away ${n}: riders go off the table, then leave, mid-point; their bets play only on rolls others play, they see the right felt back, and the leaving second writes no slip (a reveal for a close in goes)`, async () => {
      const body = uiDom();
      try {
        // A, at stand 3, puts a field bet on every roll while it plays: the
        // rolls others play. B and C, the riders, at stands 4 and 5 with their
        // table UIs up: a pass on the come-out, place 6 and 8 once a point is
        // on. H is the house's page, off the table. Off the table, B leaves
        // as the pause starts, its ride slip on the open roll (A's field put
        // down and taken down again while C's page ran no frames): its
        // goodbye is the only felt with chips the pause's roll has, and is no
        // one playing it.
        const sim = await Sim.open({
          name: 'craps-riders-away', seed: seed(2300 + n), tables: crapsTable,
          pages: [
            { name: 'H', house: true, bot: null },
            { name: 'A', place: 3, crapsBot: QUIET },
            { name: 'B', place: 4, crapsBot: QUIET, onLoad: withTableUI },
            { name: 'C', place: 5, crapsBot: QUIET, onLoad: withTableUI },
          ],
        });
        const craps = sim.craps!;
        const [h, a, b, c] = sim.pages;
        const riders = [b, c];
        const standOf = new Map([[b, 4], [c, 5]]);
        const log = rollLog(sim, h);
        const ui = new Map<SimPage, AtCraps | null>();
        for (const sp of riders) {
          sim.enter(sp);
          ui.set(sp, atCraps(sp.p as UIPage, { stand: standOf.get(sp)!, table: T }));
        }
        const PAUSE_MS = 45_000;
        let phase = 'setup' as AwayPhase;
        let aPlays = true;
        const got = {
          cycles: 0, hints: 0, backSaid: 0, offRides: 0, offRolls: 0, pauseTicks: 0, pauseRolls: 0, resumeRolls: 0, byes: 0,
          revealLeaving: 0, goneRolls: 0, felts: 0, reloadQuiet: 0, othersPlayed: 0, leftMidPoint: 0, byeTicks: 0, restarts: 0,
        };
        /** The pause's start: A's field on the open roll (ready → aIn), B's
         *  ride slip on it, A's field taken down (aOut), B gone (bGone), then
         *  C's frames again and the pause proper (null). */
        let arm: 'ready' | 'aIn' | 'aOut' | 'bGone' | null = 'ready';
        let armRoll = 0;
        /** From the pause's roll until the riders are back, every roll a sum
         *  that decides nothing (not 7, not the point): a seven-out would take
         *  the riders' bets before the rolls their gone pages ride are seen.
         *  Its seeds queued on the pages whose slips count on it (A, and C
         *  until the roll it leaves on), before they write on it (each page's
         *  first version of a roll draws its seed; later ones keep it). */
        const rigged = new Set<string>();
        const rigNext = (r: number, point: number): void => {
          const inc = h.p.casino.computedIncOf(T)!;
          if (rigged.has(`${inc}|${r}`)) return;
          rigged.add(`${inc}|${r}`);
          const ok = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12].filter((x) => x !== point);
          rigRoll((cDue || cLeft ? [a] : [a, c]).map((sp) => sp.p), r, ok[Math.floor(sim.rand() * ok.length)], [], sim.ctxOf(T, inc));
        };
        const marks = new Map<SimPage, { roll: number; net: number; at: number }>();
        let offAt = 0;
        let pauseFrom: number | null = null;
        let pauseRoll = 0;
        let pauseEnd = 0;
        let cbackRoll = 0;
        let leftAt = 0;
        let bLeft = false;
        let cDue = false;
        let cClose: string | null = null;
        let cRoll = 0;
        let cLeft = false;
        let goneWrote = false;
        let returnAt = 0;
        const feltAtLeave = new Map<SimPage, string>();
        const checked = new Set<SimPage>();
        const view = (sp: SimPage) => sp.p.table.readComputedCraps(T, sim.enter(sp));
        const carryOf = (): CrapsCarry | null => (h.p.casino.computedFoldOf(T)?.carry as CrapsCarry | undefined) ?? null;
        const rollsSince = (ms: number) => log.filter((x) => x.dice && x.at > ms);
        /** Rider sp walks off the table: its table UI goes (the walk-off
         *  notice, its words held to the felt it shows), its stand with it. */
        const walkOff = (sp: SimPage): void => {
          const now = sim.enter(sp);
          const v = sp.p.table.readComputedCraps(T, now)!;
          const { felt } = sp.p.table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
          const tally = sp.p.table.computedTally(T)!;
          marks.set(sp, { roll: tally.roll, net: tally.net, at: sim.elapsed });
          // (Each load's HUD has a hint element of its own, in the order they
          // were made: what each one said since, not the flattened list's
          // tail, which an older element's new line doesn't reach.)
          const hintEls = (): FakeEl[] => body.children.filter((x) => x.id === 'hud-hint');
          const before = new Map(hintEls().map((x) => [x, x.texts.length]));
          ui.get(sp)!.unmount();
          ui.set(sp, null);
          const said = hintEls().flatMap((x) => x.texts.slice(before.get(x) ?? 0));
          const want = walkOffWords(felt);
          if (said.length === 1 && said[0] === want) got.hints += 1;
          else {
            const own = sp.p.casino.computedFoldOf(T);
            sim.violate(`${sp.name} walked off at ${sim.elapsed} ms with ${JSON.stringify(felt)} riding: the notice read ${JSON.stringify(said)}, not ${JSON.stringify(want)} `
              + `(roll ${v.round} ${v.phase}, its fold's open ${own?.open} riding ${JSON.stringify(own ? ridingOf(own.carry as CrapsCarry, sp.pid) : null)}, latest ${JSON.stringify(own?.felts.get(sp.pid)?.rec ?? null)}, loads ${sp.loads}, restarts ${got.restarts})`);
          }
          craps.moveTo(sp, T, 'off', now);
        };
        /** Rider sp back at its stand: its table UI up again. */
        const backAt = (sp: SimPage): AtCraps => {
          const now = sim.enter(sp);
          craps.moveTo(sp, T, standOf.get(sp)!, now);
          const t = atCraps(sp.p as UIPage, { stand: standOf.get(sp)!, table: T });
          ui.set(sp, t);
          return t;
        };
        // C goes as the close of the roll it leaves on freezes its slip, before
        // its frame reveals the seed: its leaving second reveals it.
        c.beforeFrame = () => {
          if (phase !== 'leave' || !bLeft || cLeft || cDue) return true;
          const res = c.p.casino.computedFoldOf(T);
          const tip = res?.tip;
          const k = res?.carry as CrapsCarry | undefined;
          if (!tip || !k || k.p === 0 || !tip.present.includes(c.pid) || tip.revealed.includes(c.pid)) return true;
          cDue = true;
          cClose = tip.close;
          cRoll = tip.r;
          return false;
        };
        sim.every(async () => {
          if (sim.healed) return;
          const k = carryOf();
          if (!k) return;
          // A's play: a field bet on every roll while it plays.
          if (aPlays) await bet(sim, a, (felt) => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null));
          if (phase === 'setup') {
            for (const sp of riders) {
              await bet(sim, sp, (felt, point) => {
                if (point === null) return amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
                if (amt(felt, 'place', 6) === 0) return [...felt, { type: 'place', pick: 6, amount: 12 }];
                if (amt(felt, 'place', 8) === 0) return [...felt, { type: 'place', pick: 8, amount: 12 }];
                return null;
              });
            }
            const set = riders.every((sp) => amt(ridingOf(k, sp.pid), 'pass') > 0 && amt(ridingOf(k, sp.pid), 'place', 6) > 0);
            const open = riders.every((sp) => {
              const v = view(sp);
              return v?.phase === 'betting' && v.phaseDeadline !== undefined && Date.now() < v.phaseDeadline - 4_000;
            });
            if (k.p !== 0 && set && open && !h.p.casino.computedFoldOf(T)!.tip) {
              for (const sp of riders) walkOff(sp);
              offAt = sim.elapsed;
              phase = 'off';
            }
            return;
          }
          // A seven-out took a rider's bets before they left: back to their
          // stands, and again.
          if (['off', 'pause', 'resume', 'cback', 'leave'].includes(phase) && !bLeft && riders.some((sp) => ridingOf(k, sp.pid).length === 0)) {
            got.cycles += 1;
            for (const sp of riders) if (!ui.get(sp)) backAt(sp);
            c.pauseUntil = 0;
            aPlays = true;
            pauseFrom = null;
            arm = 'ready';
            phase = 'setup';
            return;
          }
          // A seven-out took their bets after B left (on the roll C left on,
          // or one after it, before two of them played their bets): nothing
          // of theirs rides on, so back on a reload, at their stands, and the
          // whole run again.
          if (['resume', 'cback', 'leave', 'away'].includes(phase) && bLeft && riders.every((sp) => ridingOf(k, sp.pid).length === 0)) {
            if (riders.some((sp) => sp.leaving)) return;
            got.restarts += 1;
            for (const sp of [a, c]) sp.p.seeds.length = 0;
            for (const sp of riders) {
              if (sp.mode === 'up' && ui.get(sp)) continue;
              if (sp.mode === 'up') {
                backAt(sp);
                continue;
              }
              craps.moveTo(sp, T, standOf.get(sp)!, sim.enter(sp));
              await sim.reload(sp);
              sim.enter(sp);
              ui.set(sp, atCraps(sp.p as UIPage, { stand: standOf.get(sp)!, table: T }));
            }
            c.pauseUntil = 0;
            bLeft = false;
            cLeft = false;
            cDue = false;
            cClose = null;
            cRoll = 0;
            pauseFrom = null;
            arm = 'ready';
            Object.assign(got, { backSaid: 0, byes: 0, leftMidPoint: 0, pauseTicks: 0, byeTicks: 0, resumeRolls: 0, offRides: 0, offRolls: 0 });
            aPlays = true;
            phase = 'setup';
            return;
          }
          // Each roll from the pause's end until the riders are back rigged
          // as it opens (the pause's own as A's field went down).
          if (['resume', 'cback', 'leave', 'away'].includes(phase)) {
            const res = h.p.casino.computedFoldOf(T)!;
            if (!res.tip && res.openCloses.length === 0) rigNext(res.open, k.p);
          }
          if (phase === 'off') {
            // Off the table, their pages join every roll A plays: ride slips
            // with no stand, their seeds counted.
            const rolls = rollsSince(offAt).filter((x) => riders.every((sp) => ridingOf(x.sIn, sp.pid).length > 0));
            if (rolls.length >= 2) {
              got.offRolls = rolls.length;
              got.offRides = rolls.filter((x) => riders.every((sp) => {
                const rec = x.slips.get(sp.pid);
                return rec !== undefined && rec.t === undefined && x.counted.includes(sp.pid);
              })).length;
              aPlays = false;
              phase = 'pause';
            }
            return;
          }
          if (phase === 'pause') {
            const res = h.p.casino.computedFoldOf(T)!;
            const v = view(h);
            const feltOf = (sp: SimPage): CrapsSlipRec | undefined => res.felts.get(sp.pid)?.rec as CrapsSlipRec | undefined;
            if (arm === 'ready') {
              // A plays on while no point is on (B leaves mid-point); then a
              // roll it hasn't bet on, its window not started or 10 s of it
              // left: C's page runs no frames from here (a throttled tab) and
              // A puts a field bet down, which B's page joins.
              aPlays = k.p === 0;
              const aFelt = feltOf(a);
              if (k.p === 0 || res.tip || res.openCloses.length > 0 || v?.phase !== 'betting' || (aFelt !== undefined && aFelt.b.length > 0)) return;
              if (v.phaseDeadline !== undefined && Date.now() >= v.phaseDeadline - 10_000) return;
              if (feltOf(b) !== undefined || feltOf(c) !== undefined) return;
              // (The pause's roll is the one A plays as the pause ends: A's
              // seed the field it puts down now draws, C's its ride slip then.)
              rigNext(res.open, k.p);
              c.pauseUntil = sim.T + 60_000;
              const put = await bet(sim, a, (felt) => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null), 10_000);
              if (put === 'ok') {
                armRoll = res.open;
                arm = 'aIn';
              } else {
                c.pauseUntil = 0;
              }
              return;
            }
            if (arm !== null && (res.open !== armRoll || res.tip || res.openCloses.length > 0)) {
              sim.violate(`roll ${armRoll} closed at ${sim.elapsed} ms as the pause began (step ${arm})`);
              c.pauseUntil = 0;
              arm = null;
              pauseFrom = sim.elapsed;
              pauseRoll = lastRollOf(h);
            }
            if (arm === 'aIn') {
              // B's ride slip in (C's page wrote nothing): A takes its field
              // down.
              const fb = feltOf(b);
              if (feltOf(c) !== undefined) sim.violate(`C wrote on roll ${armRoll} at ${sim.elapsed} ms with its page running no frames`);
              if (!fb || fb.b.length === 0 || fb.l === 1 || (feltOf(a)?.b.length ?? 0) === 0) return;
              const off = await bet(sim, a, (felt) => (amt(felt, 'field') > 0 ? felt.filter((x) => x.type !== 'field') : null));
              if (off === 'ok') arm = 'aOut';
              return;
            }
            if (arm === 'aOut') {
              // A's felt down, B's ride slip its latest: B leaves the room
              // through the door, mid-point, a goodbye, and its leaving
              // second writes nothing more (the goodbye oracle).
              const fa = feltOf(a);
              const fb = feltOf(b);
              if (!fa || fa.b.length > 0 || !fb || fb.b.length === 0 || fb.l === 1 || k.p === 0) return;
              if (v?.phase !== 'betting' || (v.phaseDeadline !== undefined && Date.now() >= v.phaseDeadline - 3_000)) return;
              const was = craps.stats.goodbyes;
              feltAtLeave.set(b, canonText(ridingOf(k, b.pid)));
              await sim.leave(b);
              got.byes += craps.stats.goodbyes - was;
              got.leftMidPoint += 1;
              bLeft = true;
              leftAt = sim.elapsed;
              arm = 'bGone';
              return;
            }
            if (arm === 'bGone') {
              // B's goodbye in, with chips, the only felt the roll has with
              // any: C's frames again, and the pause proper.
              const fb = feltOf(b);
              if (!fb || fb.l !== 1 || fb.b.length === 0) return;
              c.pauseUntil = 0;
              arm = null;
              pauseFrom = sim.elapsed;
              pauseRoll = lastRollOf(h);
            }
            if (pauseFrom === null) return;
            // Nobody else plays: no roll, and no slip of C's on it; B's
            // goodbye the only felt with chips (no one playing it).
            got.pauseTicks += 1;
            if (lastRollOf(h) !== pauseRoll || res.tip) {
              got.pauseRolls += 1;
              sim.violate(`a roll was played at ${sim.elapsed} ms with only riders off the table and a gone rider's goodbye (from roll ${pauseRoll})`);
            }
            const fc = res.felts.get(c.pid);
            if (fc && fc.rec.b.length > 0) sim.violate(`C, off the table, wrote ${fc.key} at ${sim.elapsed} ms with nobody else playing (B's goodbye on the roll)`);
            const chips = [...res.felts.values()].filter((x) => x.rec.b.length > 0);
            if (chips.length === 1 && chips[0].rec.p === b.pid && (chips[0].rec as CrapsSlipRec).l === 1) got.byeTicks += 1;
            if (sim.elapsed >= pauseFrom + PAUSE_MS) {
              pauseEnd = sim.elapsed;
              aPlays = true;
              phase = 'resume';
            }
            return;
          }
          if (phase === 'resume') {
            if (rollsSince(pauseEnd).length >= 1) {
              got.resumeRolls = rollsSince(pauseEnd).length;
              // C comes back to its stand: its table UI says what happened
              // while it was away (the rolls played, what C's bets made).
              const mark = marks.get(c)!;
              const t = backAt(c);
              const tally = c.p.table.computedTally(T)!;
              const rolls = tally.roll - mark.roll;
              const want = `WHILE YOU WERE AWAY — ${rolls} ROLL${rolls === 1 ? '' : 'S'} · ${signedChips(tally.net - mark.net)}`;
              const away = log.filter((x) => x.at > mark.at && x.at <= sim.elapsed);
              if (t.said() === want && away.length === rolls) got.backSaid += 1;
              else sim.violate(`C back at ${sim.elapsed} ms heard ${JSON.stringify(t.said())}, not ${JSON.stringify(want)} (${away.length} rolls decided meanwhile)`);
              // Every one of them a roll A played.
              got.othersPlayed += away.filter((x) => (x.slips.get(a.pid)?.b.length ?? 0) > 0).length;
              if (away.some((x) => (x.slips.get(a.pid)?.b.length ?? 0) === 0)) sim.violate(`a roll played while C was away had no chips of A's on it`);
              cbackRoll = lastRollOf(h);
              phase = 'cback';
            }
            return;
          }
          if (phase === 'cback') {
            // One roll at the stand, then off the table again.
            const v = view(c);
            if (lastRollOf(h) > cbackRoll && v?.phase === 'betting' && v.phaseDeadline !== undefined && Date.now() < v.phaseDeadline - 4_000) {
              walkOff(c);
              phase = 'leave';
            }
            return;
          }
          if (phase === 'leave') {
            if (cDue && !cLeft) {
              // C leaves with a close of its roll in, its seed not out yet: no
              // goodbye (the close holds what it froze); its leaving second
              // reveals the seed.
              feltAtLeave.set(c, canonText(ridingOf(k, c.pid)));
              await sim.leave(c);
              cLeft = true;
              leftAt = sim.elapsed;
              phase = 'away';
            }
            return;
          }
          if (phase === 'away') {
            // The rolls after the one C left on: their bets play on the rolls A
            // plays, with no slip of theirs (riders: no seed).
            const inc = h.p.casino.computedIncOf(T);
            const rolls = log.filter((x) => x.dice && x.inc === inc && x.r > cRoll && riders.some((sp) => ridingOf(x.sIn, sp.pid).length > 0));
            const wrote = rolls.find((x) => riders.some((sp) => x.slips.has(sp.pid)));
            if (wrote && !goneWrote) {
              goneWrote = true;
              sim.violate(`a slip of a gone rider's was frozen on roll ${wrote.r}, after it left`);
            }
            if (rolls.length >= 2 && sim.elapsed >= leftAt + 30_000) {
              got.goneRolls = rolls.length;
              // Back on a reload, at their stands, their table UIs up.
              for (const sp of riders) {
                craps.moveTo(sp, T, standOf.get(sp)!, sim.enter(sp));
                await sim.reload(sp);
                sim.enter(sp);
                const t = atCraps(sp.p as UIPage, { stand: standOf.get(sp)!, table: T });
                ui.set(sp, t);
                // "Only a page that stayed open in the room can say this;
                // after a reload it stays quiet."
                if (!t.heard().some((x) => x.startsWith('WHILE YOU WERE AWAY'))) got.reloadQuiet += 1;
                else sim.violate(`${sp.name} reloaded at ${sim.elapsed} ms and heard ${JSON.stringify(t.heard())}`);
              }
              returnAt = sim.elapsed;
              phase = 'return';
            }
            return;
          }
          if (phase === 'return') {
            // The felt they see once their page is back with the room: the
            // bets riding for them, as the rolls played while they were gone
            // left them.
            const res = h.p.casino.computedFoldOf(T)!;
            for (const sp of riders) {
              if (checked.has(sp) || sp.mode !== 'up' || !sp.roomIn) continue;
              const now = sim.enter(sp);
              const mine = sp.p.casino.computedFoldOf(T);
              const v = sp.p.table.readComputedCraps(T, now);
              if (!mine || lastRollOf(sp) !== lastRollOf(h) || mine.open !== res.open || res.tip || v?.phase !== 'betting' || v.round !== res.open) continue;
              const { felt } = sp.p.table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
              const want = canonText(ridingOf(k, sp.pid));
              if (canonText(felt) === want) got.felts += 1;
              else sim.violate(`${sp.name} back at ${sim.elapsed} ms sees ${JSON.stringify(felt)}, the room's riding bets ${want} (left with ${feltAtLeave.get(sp)})`);
              checked.add(sp);
            }
            if (checked.size === riders.length || sim.elapsed > returnAt + 120_000) {
              aPlays = false;
              phase = 'done';
            }
          }
        });
        // C's leaving second: what its page wrote in it, a reveal of the close
        // it left on.
        const cap = 20 * 60_000;
        while (phase !== 'done' && sim.elapsed < cap) await sim.run(5_000);
        await sim.run(30_000);
        for (const sp of riders) {
          const t = ui.get(sp);
          if (t) {
            sim.enter(sp);
            t.unmount();
          }
        }
        const cLast = log.find((x) => x.close === cClose);
        if (cLast && cLast.revealed.includes(c.pid) && cLast.decided === 'reveals' && cLast.counted.includes(c.pid) && cLast.pointBefore !== null) got.revealLeaving += 1;
        // (A shooter that walked off still holds the table on its next roll:
        // about 21.5 s when its page can't close it, within the felts' budget.)
        const s = await finish(sim, lines);
        console.log(`[craps] ${sim.label}: ${JSON.stringify(got)}, phase ${phase}, C's close ${cLast ? `${cLast.r} ${cLast.decided} counted ${cLast.counted.length}` : 'none'}, goodbyes ${craps.stats.goodbyes}, rolls ${s.rounds}`);
        expect(phase, sim.label).toBe('done');
        expect(got.hints, sim.label).toBeGreaterThanOrEqual(3);
        expect(got.offRides, sim.label).toBeGreaterThan(0);
        expect(got.pauseTicks, sim.label).toBeGreaterThanOrEqual(PAUSE_MS / 250 - 1);
        expect(got.pauseRolls, sim.label).toBe(0);
        expect(got.byeTicks, sim.label).toBeGreaterThanOrEqual(PAUSE_MS / 250 - 1);
        expect(got.resumeRolls, sim.label).toBeGreaterThan(0);
        expect(got.backSaid, sim.label).toBe(1);
        expect(got.othersPlayed, sim.label).toBeGreaterThan(0);
        expect(got.byes, sim.label).toBe(1);
        expect(got.leftMidPoint, sim.label).toBe(1);
        expect(got.revealLeaving, sim.label).toBe(1);
        expect(got.goneRolls, sim.label).toBeGreaterThanOrEqual(2);
        expect(got.reloadQuiet, sim.label).toBe(2);
        expect(got.felts, sim.label).toBe(2);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🌙 background-rider ──────────────────────────────────────────────────────

describe('computed craps: background-rider', () => {
  for (const n of SEEDS) {
    it(`background-rider ${n}: a tab hides after its ride slip; the forfeit costs nothing, the bets play, and the settled line says YOUR BETS PLAYED WITHOUT IT`, async () => {
      uiDom();
      try {
        // A, at stand 3, plays every roll (a field bet, a pass on the
        // come-out). R, the rider at stand 4 with its table UI up: a pass on
        // the come-out, place 6 and 8 once a point is on. H, the house's page.
        const sim = await Sim.open({
          name: 'craps-background-rider', seed: seed(2400 + n), tables: crapsTable,
          pages: [
            { name: 'H', house: true, bot: null },
            { name: 'A', place: 3, crapsBot: QUIET },
            { name: 'R', place: 4, crapsBot: QUIET, onLoad: withTableUI },
          ],
        });
        const craps = sim.craps!;
        const [h, a, r] = sim.pages;
        const log = rollLog(sim, h);
        sim.enter(r);
        const tr = atCraps(r.p as UIPage, { stand: 4, table: T });
        const WANT = 2;
        const done: { r: number; lost: number; played: number; line: string }[] = [];
        let ep: { inc: string; r: number; lines: number; woke: boolean; close?: string; f?: { lost: number; played: number } } | null = null;
        let retries = 0;
        sim.every(async () => {
          if (sim.healed) return;
          await bet(sim, a, (felt, point) => {
            if (amt(felt, 'field') === 0) return [...felt, { type: 'field', amount: 5 }];
            return point === null && amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
          });
          if (!ep) {
            if (r.mode !== 'up' || done.length >= WANT) return;
            await bet(sim, r, (felt, point) => {
              if (point === null) return amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
              if (amt(felt, 'place', 6) === 0) return [...felt, { type: 'place', pick: 6, amount: 12 }];
              if (amt(felt, 'place', 8) === 0) return [...felt, { type: 'place', pick: 8, amount: 12 }];
              return null;
            });
            // Its ride slip is out (the riding bets, no change, at its stand)
            // with betting open: the tab hides, its doc still hearing.
            const res = h.p.casino.computedFoldOf(T)!;
            const k = res.carry as CrapsCarry;
            const C = ridingOf(k, r.pid);
            const f = res.felts.get(r.pid);
            const rec = f?.rec as CrapsSlipRec | undefined;
            const now = sim.enter(r);
            const v = r.p.table.readComputedCraps(T, now);
            if (res.tip || C.length === 0 || !rec || rec.l === 1 || rec.t !== 4 || canonText(rec.b) !== canonText(C)) return;
            if (v?.phase !== 'betting' || v.phaseDeadline === undefined || now >= v.phaseDeadline - 3_000) return;
            ep = { inc: h.p.casino.computedIncOf(T)!, r: res.open, lines: 0, woke: false };
            sim.sleep(r, true);
            return;
          }
          if (!ep.woke) {
            const roll = log.find((x) => x.inc === ep!.inc && x.r === ep!.r);
            if (!roll) return;
            if (roll.decided !== 'forfeit' || !roll.present.includes(r.pid) || roll.counted.includes(r.pid) || !roll.dice) {
              // (Its ride slip missed the close: it rode as a rider. Again.)
              retries += 1;
              sim.wake(r);
              ep = null;
              return;
            }
            ep.close = roll.close;
            ep.f = craps.forfeitOf.get(`${T}|${roll.inc}|${roll.close}|${r.pid}`);
            if ((roll.lost.get(r.pid) ?? 0n) !== 0n) sim.violate(`R's hidden ride slip lost ${roll.lost.get(r.pid)} chips on roll ${roll.r}`);
            sim.wake(r);
            sim.enter(r);
            ep.lines = tr.lines().length;
            ep.woke = true;
            return;
          }
          // Awake: its screen shows the roll it missed again, then moves on.
          const now = sim.enter(r);
          tr.update();
          const v = r.p.table.readComputedCraps(T, now);
          const shown = tr.lines().slice(ep.lines);
          const line = shown.find((x) => x.includes('YOUR BETS PLAYED WITHOUT IT'));
          if (line) {
            done.push({ r: ep.r, lost: ep.f?.lost ?? -1, played: ep.f?.played ?? -1, line });
            ep = null;
          } else if (v && v.round > ep.r && v.phase === 'betting') {
            sim.violate(`R woke after roll ${ep.r}'s forfeit and never read YOUR BETS PLAYED WITHOUT IT: ${JSON.stringify(shown)}`);
            ep = null;
          }
        });
        const cap = 15 * 60_000;
        while ((done.length < WANT || ep) && sim.elapsed < cap) await sim.run(5_000);
        sim.enter(r);
        tr.unmount();
        const s = await finish(sim, lines);
        console.log(`[craps] ${sim.label}: episodes ${JSON.stringify(done)}, retries ${retries}, forfeits ${s.byForfeit}, rolls ${s.rounds}`);
        expect(done.length, sim.label).toBe(WANT);
        for (const d of done) {
          // The forfeit cost nothing (no chips added on the roll), and the
          // bets from before it played on the dice, as the checker played the
          // felt (CrapsHarness forfeitOf); the settled line says so.
          expect(d.lost, `${sim.label} roll ${d.r}`).toBe(0);
          expect(d.played, `${sim.label} roll ${d.r}`).toBeGreaterThan(0);
          expect(d.line, `${sim.label} roll ${d.r}`).toMatch(/· YOUR SEED (NEVER CAME|CAME IN LATE) — YOUR BETS PLAYED WITHOUT IT$/);
        }
        expect(s.byForfeit, sim.label).toBeGreaterThanOrEqual(WANT);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});
