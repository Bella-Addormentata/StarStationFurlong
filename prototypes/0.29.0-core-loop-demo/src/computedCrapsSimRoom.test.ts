/**
 * 🧪🎲🌐 Computed craps over the simulated network, past the baseline
 * (computedCrapsSimPlay.test.ts): the rolls a late seed decides by forfeit,
 * the void of a roll nobody can finish, a full table, the table's end (a
 * removal mid-roll, a switch-off with contract bets riding and back on),
 * churn, and the real table UI mounted on a page (computedCrapsUiKit: its
 * presses and the words it says). Each scenario runs three seeds through
 * the shared finish (computedCrapsSimKit: the checker's walk of every fold,
 * every oracle, the stall budgets by phase) and asserts what it is there
 * for.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { between, SIM_LONG, Sim, SIM_T0 } from './computedSim';
import type { SimPage } from './computedSim';
import { canonList, CRAPS_BOT } from './computedCrapsSim';
import { T, TIMEOUT, finish, named, seed } from './computedCrapsSimKit';
import { atCraps, stubDom, withUI } from './computedCrapsUiKit';
import type { AtCraps, UIPage } from './computedCrapsUiKit';
import { putIn, signAs, tagSeed } from './computedPageKit';
import type { Page } from './computedPageKit';
import { gameOfInc } from './computedFold';
import type { Checkpoint, CrapsRoll, CrapsSlipRec } from './computedFold';
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

// ── 🖥️ A table UI on a page (the late page, the full table's newcomer, the UI) ─

/** The table UI's modules on every load of a page (computedCrapsUiKit
 *  withUI, in its own generation), and a DOM whose timers do nothing: the
 *  sim drives the UI by hand (its seat beat is the harness's, sit). */
const withTableUI = async (p: Page): Promise<void> => {
  await withUI(p);
};
function uiDom(): void {
  stubDom({ setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
}
/** The globals as the file has them (a scenario with a table UI done). */
function noDom(): void {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
}

/** The design's 3-4-5x: how many times the flat its odds may be, by point
 *  (this spec's own copy, not games/craps's MAX_ODDS_MULTIPLE). */
const ODDS_X: Record<number, number> = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 };
const DENOM_KEY: Record<number, string> = { 1: '1', 5: '2', 25: '3', 100: '4' };

/** The hand on table UI t loaded with `amount` chips off the rail, the
 *  largest the rail has first (its keys 1-4: 1, 5, 25, 100): whether it
 *  holds exactly that (the rail may lack the chips). */
function loadHand(t: AtCraps, amount: number): boolean {
  t.key('0');
  let held = 0;
  const out = new Set<number>();
  for (let guard = 0; held < amount && guard < 60; guard++) {
    const d = [100, 25, 5, 1].find((x) => x <= amount - held && !out.has(x));
    if (d === undefined) return false;
    t.key(DENOM_KEY[d]);
    const m = /^Holding (\d+) in /.exec(t.said());
    if (!m) out.add(d);
    else held = Number(m[1]);
  }
  return held === amount;
}

// ── 🐢 A late seed ───────────────────────────────────────────────────────────

describe('computed craps: a late seed', () => {
  for (const n of SEEDS) {
    it(`late seed ${n}: one page's reveal lags 3-12 s behind the close (a throttled tab); its felt forfeits only the chips it added, and its table UI says so`, async () => {
      uiDom();
      try {
        // O, off the table with its table UI up, bets nothing: a bystander
        // whose page has no slip on any roll.
        const sim = await Sim.open({
          name: 'craps-late-seed', seed: seed(200 + n), tables: crapsTable,
          pages: [
            ...named('ABCD'), { name: 'E', place: 5, onLoad: withTableUI },
            { name: 'O', place: 'off', crapsBot: { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0, lateEvery: 0 }, onLoad: withTableUI },
          ],
        });
        const craps = sim.craps!;
        const late = sim.pages.find((sp) => sp.name === 'E')!;
        const by = sim.pages.find((sp) => sp.name === 'O')!;
        // Its table UI: on each roll a forfeit decided without its seed, the
        // line under the result says the seed missed it and what that cost,
        // as the checker played the felt (new chips lost, or the bets from
        // before the roll played without it).
        sim.enter(late);
        const te = atCraps(late.p as UIPage, { stand: 5, table: T });
        const told = new Map<string, string>();
        sim.every(() => {
          if (late.mode !== 'up' || sim.T < late.pauseUntil || sim.healed) return;
          const now = sim.enter(late);
          const v = late.p.table.readComputedCraps(T, now);
          if (!v || v.phase !== 'settled' || !v.dice) return;
          const inc = late.p.casino.computedIncOf(T);
          const rv = late.p.casino.computedFoldOf(T)?.rounds.find((x) => x.r === v.round);
          if (!inc || !rv || rv.decided !== 'forfeit' || told.has(rv.close)) return;
          const f = craps.forfeitOf.get(`${T}|${inc}|${rv.close}|${late.pid}`);
          if (!f || (f.lost === 0 && f.played === 0)) return;
          te.update();
          const line = te.status();
          told.set(rv.close, line);
          // (Bets from before the roll that played: THE REST PLAYED.)
          const want = f.lost > 0 ? `NEW BETS FORFEITED${f.played > 0 ? ' · THE REST PLAYED' : ''}` : 'YOUR BETS PLAYED WITHOUT IT';
          if (!/YOUR SEED (CAME IN LATE|NEVER CAME) — /.test(line) || !line.includes(want)) {
            sim.violate(`E's line on roll ${v.round} (its seed missed, ${f.lost} lost, ${f.played} played) at ${sim.elapsed} ms reads ${JSON.stringify(line)}, not ${want}`);
          }
        });
        // O's table UI on each roll a forfeit decided: the verdict is the
        // forfeit's writer's and its bettors', not a bystander's (its check
        // names no fate of its own), and its line has no seed tail.
        sim.enter(by);
        const to = atCraps(by.p as UIPage, { stand: null, table: T });
        const byTold = new Map<string, string>();
        sim.every(() => {
          if (by.mode !== 'up' || sim.healed) return;
          const now = sim.enter(by);
          const v = by.p.table.readComputedCraps(T, now);
          if (!v || v.phase !== 'settled' || !v.dice) return;
          const rv = by.p.casino.computedFoldOf(T)?.rounds.find((x) => x.r === v.round);
          if (!rv || rv.decided !== 'forfeit' || byTold.has(rv.close)) return;
          to.update();
          const line = to.status();
          const check = by.p.table.computedRoundCheck(T, now);
          byTold.set(rv.close, line);
          if (rv.present.includes(by.pid) || check?.mine !== null || line.includes('YOUR SEED')) {
            sim.violate(`O, a bystander, on forfeit roll ${v.round} at ${sim.elapsed} ms: its check's fate ${JSON.stringify(check?.mine)}, its line ${JSON.stringify(line)}`);
          }
        });
        const lagged = new Set<string>();
        const lags: number[] = [];
        // Late on every close it rides into (its bets from before the roll
        // on the felt), and on a third of the others: in time on the rest,
        // its bets ride on into the rolls after.
        late.beforeFrame = () => {
          const res = late.p.casino.computedFoldOf(T);
          const tip = res?.tip;
          if (!res || !tip || !tip.present.includes(late.pid) || tip.revealed.includes(late.pid) || lagged.has(tip.close)) return true;
          lagged.add(tip.close);
          const rides = (res.carry as { w: Record<string, unknown> }).w[late.pid] !== undefined;
          if (!rides && sim.rand() < 2 / 3) return true;
          const lag = between(sim.rand, 3_000, 12_000);
          lags.push(lag);
          late.pauseUntil = sim.T + lag;
          return false;
        };
        await sim.run(RUN_MS);
        sim.enter(late);
        te.unmount();
        sim.enter(by);
        to.unmount();
        // Scoped, as roulette's late revealer: a seed that comes in around the
        // grace's end is in time on some pages and late on others; the page it
        // is late on forfeits it, and its forfeit beats the full set the
        // others showed, answered maybe by a page that saw the seed in time.
        const s = await finish(sim, lines, { flips: ['forfeit over reveals', 'answer forfeit'] });
        const st = craps.stats;
        expect(lags.length, sim.label).toBeGreaterThan(0);
        expect(s.byForfeit, sim.label).toBeGreaterThan(0);
        expect(s.forfeitsChecked, sim.label).toBeGreaterThan(0);
        // A forfeited felt that added chips lost them (and only them), and
        // one with bets from before the roll played those on the dice: the
        // checker's minPer/addedOver against the fold's, every one.
        expect(st.forfeitLost, sim.label).toBeGreaterThan(0);
        expect(st.forfeitPlayed, sim.label).toBeGreaterThan(0);
        expect(told.size, sim.label).toBeGreaterThan(0);
        expect(byTold.size, sim.label).toBeGreaterThan(0);
        console.log(`[craps] ${sim.label}: lags ${lags.length}, forfeits ${s.byForfeit}, forfeited felts lost ${st.forfeitLost}, rode ${st.forfeitRode}, played ${st.forfeitPlayed}; E's lines ${JSON.stringify([...told.values()])}; O's ${JSON.stringify([...byTold.values()])}`);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🕳️ A void ────────────────────────────────────────────────────────────────

describe('computed craps: a void', () => {
  for (const n of SEEDS) {
    it(`void ${n}: with a point on and bets riding, every bettor a close froze goes before its reveal; the seated page voids the roll, which keeps this roll's changes, the riding bets standing and the point where it was, and the void stands as they come back`, async () => {
      // W stands at the table and bets nothing: its seat makes it one of the
      // pages that void a roll nobody can finish (abandonDuty). Its table UI
      // up: the words its status line gives the void.
      uiDom();
      try {
        const sim = await Sim.open({
          name: 'craps-void', seed: seed(300 + n), tables: crapsTable,
          pages: [{ name: 'W', place: 1, crapsBot: { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0 }, onLoad: withTableUI }, ...named('BCD')],
        });
        const craps = sim.craps!;
        const w = sim.pages[0];
        sim.enter(w);
        const tw = atCraps(w.p as UIPage, { stand: 1, table: T });
        let voidLine: string | null = null;
        const bettors = sim.pages.slice(1);
        const { table } = w.p;
        let armed = false;
        let target: string | null = null;
        const gone: SimPage[] = [];
        const firstSeen = new Map<string, number>();
        let voided: { at: number; r: number; stood: boolean; roll: CrapsRoll; felts: Map<string, CrapsBet[]> } | null = null;
        sim.at(60_000, () => { armed = true; });
        // (The design's void-riders: "An abandon with riders leaves the bets
        // standing and the point where it was." So the roll voided is one a
        // point is on for, bets riding into it.)
        const ridden = (roll: CrapsRoll | undefined): boolean => !!roll && roll.sIn.p !== 0 && Object.keys(roll.sIn.w).length > 0;
        // Each frozen bettor goes as it sees the close, before its reveal; and
        // the rest with them (W is the one page left to void it), until it has.
        for (const sp of bettors) {
          sp.beforeFrame = () => {
            const tip = sp.p.casino.computedFoldOf(T)?.tip;
            if (armed && target === null && tip && ridden(tip.craps) && tip.present.includes(sp.pid) && !tip.revealed.includes(sp.pid)) target = tip.close;
            if (target === null || voided !== null || (tip?.close === target && tip.revealed.includes(sp.pid))) return true;
            sim.crash(sp);
            gone.push(sp);
            return false;
          };
        }
        sim.every(() => {
          sim.enter(w);
          const res = w.p.casino.computedFoldOf(T);
          if (!res) return;
          if (res.tip && !firstSeen.has(res.tip.close)) firstSeen.set(res.tip.close, sim.T);
          const v = target === null ? undefined : res.rounds.find((x) => x.close === target);
          if (!v?.decided) return;
          if (!voided) {
            // Each frozen slip's felt as W's session holds it.
            const ses = w.p.casino.computedSessionForWrite(T)!;
            const felts = new Map(v.present.map((pid) => [pid, canonList((ses.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as CrapsSlipRec).b)]));
            voided = { at: sim.T, r: v.r, stood: true, roll: v.craps!, felts };
            // They come back 10 s on, their seeds in their profiles' stores.
            sim.at(sim.elapsed + 10_000, async () => {
              for (const sp of gone) if (sp.mode === 'gone') await sim.reload(sp);
            });
          } else if (v.decided !== 'void' && voided.stood) {
            voided.stood = false;
            sim.violate(`roll ${v.r}, voided at ${voided.at - SIM_T0} ms, reads ${v.decided} at ${sim.elapsed} ms`);
          }
          // W's line as its table shows the void (the design's words).
          if (voidLine === null) {
            const vw = table.readComputedCraps(T, sim.enter(w));
            if (vw?.phase === 'settled' && vw.round === voided.r && vw.voided) {
              tw.update();
              voidLine = tw.status();
            }
          }
        });
        await sim.run(RUN_MS);
        sim.enter(w);
        tw.unmount();
        // (The void's own wait: ABANDON_MS from the close, within the tip
        // budget; the pages gone, nobody closes the rolls after until they are
        // back, which no budget's turn waits for: the felts' stall is counted
        // only while a page with chips on the roll is up.)
        const s = await finish(sim, lines);
        expect(target, sim.label).not.toBeNull();
        expect(gone.length, sim.label).toBeGreaterThan(0);
        expect(voided, sim.label).not.toBeNull();
        expect(s.voids, sim.label).toBeGreaterThan(0);
        expect(s.abandonsChecked, sim.label).toBeGreaterThan(0);
        expect(voidLine, sim.label).toBe('⚠ ROLL VOID — NOBODY COULD FINISH IT · BETS STAND FOR THE NEXT ROLL');
        // Voided not before ABANDON_MS from W's sight of the close, and within
        // it plus every page's turn and a second's slack.
        const { at } = voided!;
        const from = firstSeen.get(target!)!;
        expect(at - from, sim.label).toBeGreaterThanOrEqual(table.ABANDON_MS);
        expect(at - from, sim.label).toBeLessThanOrEqual(table.ABANDON_MS + sim.pages.length * table.STAGGER_MS + 1_000);
        // A felt on the voided roll that changed on it (chips added, or taken
        // down) kept the change for the next roll, as the checker played it.
        expect(craps.stats.voidChanged, sim.label).toBeGreaterThan(0);
        expect(gone.every((sp) => sp.mode === 'up'), sim.label).toBe(true);
        // With riders: the point stays where it was, no dice, and every bet
        // that rode into the roll stands after it: a rider's bets as they
        // rode, or its frozen felt where that stood ('ok': the void keeps this
        // roll's changes, above); and every contract bet (it can't come down)
        // as it was. (The checker hands the carry on so too.)
        const { roll, felts } = voided!;
        const riders = Object.keys(roll.sIn.w);
        expect(roll.pointBefore, sim.label).not.toBeNull();
        expect(roll.sIn.p, sim.label).not.toBe(0);
        expect(roll.pointAfter, sim.label).toBe(roll.pointBefore);
        expect(roll.sOut.p, sim.label).toBe(roll.sIn.p);
        expect(roll.dice, sim.label).toBeNull();
        expect(riders.length, sim.label).toBeGreaterThan(0);
        const p = roll.sIn.p;
        const contract = (b: CrapsBet): boolean => (b.type === 'pass' && p !== 0) || (b.type === 'come' && b.pick !== undefined);
        let contracts = 0;
        for (const pid of new Set([...riders, ...felts.keys()])) {
          const out = canonList(roll.sOut.w[pid] ?? []);
          const stood = roll.fates.get(pid) === 'ok' ? felts.get(pid)! : canonList(roll.sIn.w[pid] ?? []);
          expect(JSON.stringify(out), `${sim.label} ${pid} (${roll.fates.get(pid)})`).toBe(JSON.stringify(stood));
          for (const b of (roll.sIn.w[pid] ?? []).filter(contract)) {
            contracts += 1;
            expect(out.find((x) => x.type === b.type && x.pick === b.pick)?.amount, `${sim.label} ${pid} ${b.type}${b.pick ?? ''}`).toBe(b.amount);
          }
        }
        console.log(`[craps] ${sim.label}: voided roll ${voided!.r}, point ${roll.pointBefore}, riders ${riders.length}, contract bets standing ${contracts}, fates ${JSON.stringify([...roll.fates])}`);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 👻 A full table ──────────────────────────────────────────────────────────

const GHOST = 'zz-ghost-';
const ghostPid = (i: number): string => `${GHOST}${String(i).padStart(2, '0')}`;

/**
 * Page x, a cheat with no frames of its own, plays ghosts: players it
 * registers under its own key (the players map pins it for them), funds and
 * signs for, whose felts and seeds it writes by hand. Each tick, while a roll
 * takes bets with an honest player's chips on it (so an honest page closes
 * it), it:
 * - 'exact': brings the writer's count for page `a` (every rider and every
 *   other newcomer with chips) to 31 exactly with one-chip field bets, so
 *   `a`'s player, a newcomer, is refused 'full' (and the 32nd would be the
 *   first past the room);
 * - 'flood': a rider of its own with no slip (a place 6 riding), then a felt
 *   on a stale stamp, a forged don't come on a number and (a point on) a
 *   pass put up, then 31 field bets: the close freezes 31 of them, and the
 *   newcomers past the room, the rider kept in it, are 'full'.
 * It reveals every ghost's seed a close freezes, at once.
 */
function ghosts(sim: Sim, x: SimPage, a: SimPage) {
  const seeds = new Map<string, string>();
  const ver = new Map<string, number>();
  const wrote = new Map<string, CrapsBet[]>();
  const revealed = new Set<string>();
  const pids = Array.from({ length: 41 }, (_, i) => ghostPid(i));
  const special = { stale: `${GHOST}st`, forged: `${GHOST}dc`, line: `${GHOST}il` };
  const all = [...pids, ...Object.values(special)];
  const state = { phase: 'off' as 'off' | 'exact' | 'flood' | 'done', floods: 0, exactRolls: 0, done: false };
  const registered = { done: false };
  const register = (): void => {
    const players = x.p.doc.getMap('players');
    x.p.doc.transact(() => {
      for (const pid of all) players.set(pid, { keyB64: x.p.pub, name: pid });
    });
    for (const pid of all) sim.buyIn(x, pid, 1_000);
    registered.done = true;
  };
  const write = (r: number, pid: string, b: CrapsBet[], o: string): void => {
    const inc = x.p.casino.computedIncOf(T)!;
    const ctx = sim.ctxOf(T, inc);
    const k = `${inc}|${r}|${pid}`;
    const v = (ver.get(k) ?? 0) + 1;
    ver.set(k, v);
    const s = tagSeed(`${inc}:${pid}:${r}:${v}`);
    const c = x.p.fold.slipCommit(ctx, r, pid, s);
    const rec = signAs(x.p, 'slip', { r, p: pid, v, b, o, c }, ctx) as unknown as CrapsSlipRec;
    const key = x.p.fold.slipKeyFor(ctx)(rec)!;
    seeds.set(key.slice(key.lastIndexOf(':') + 1), s);
    wrote.set(k, b);
    putIn(x.p, [[key, rec]], T);
  };
  sim.every(async () => {
    if (state.phase === 'off' || x.mode !== 'up') return;
    // (The roll's times as an honest page with frames has them: x runs
    // none, so its own window lags.)
    const aNow = sim.enter(a);
    const av = a.mode === 'up' ? a.p.table.readComputedCraps(T, aNow) : null;
    await sim.as(x, (now) => {
      if (!registered.done) register();
      const { casino, table } = x.p;
      const inc = casino.computedIncOf(T);
      const res = casino.computedFoldOf(T);
      if (!inc || gameOfInc(inc) !== 'craps' || !res) return;
      // Every ghost seed a close in freezes, out at once.
      const ses = casino.computedSessionForWrite(T);
      for (const cl of [res.tip?.closeRec, ...res.openCloses.map((o) => o.rec)]) {
        if (!cl || !ses) continue;
        for (const [pid, h] of Object.entries(cl.f)) {
          const s = seeds.get(h);
          const key = `${cl.r}|${pid}|${h}`;
          if (!s || revealed.has(key)) continue;
          revealed.add(key);
          const xr = { r: cl.r, p: pid, s };
          putIn(x.p, [[x.p.fold.revealKey(xr)!, xr]], T);
        }
      }
      if (res.tip) return;
      const r = res.open;
      if (!av || av.phase !== 'betting' || av.round !== r || av.phaseDeadline === undefined) return;
      const left = av.phaseDeadline - aNow;
      const carry = res.carry as { p: number; w: Record<string, CrapsBet[]> };
      const riders = new Set(Object.keys(carry.w));
      const ghost = (pid: string): boolean => pid.startsWith(GHOST);
      const { basis } = table.readMyComputedCrapsBets(T, x.pid, r, now);
      const mine = (pid: string): CrapsBet[] | undefined => wrote.get(`${inc}|${r}|${pid}`);
      // Only while an honest page will close the roll: one with chips of
      // its own on it (a rider with everything taken down closes nothing).
      // With none 2 s before betting ends, and once done, the ghosts take
      // their chips down (else nobody closes: lever 15, a re-arm).
      const honestChips = [...res.felts.values()].some((f) => !ghost(f.rec.p) && f.rec.b.length > 0 && (f.rec as CrapsSlipRec).l !== 1);
      if (state.phase === 'done' || (!honestChips && left < 2_000)) {
        for (const pid of all.filter((q) => (mine(q)?.length ?? 0) > 0)) write(r, pid, [], basis);
        return;
      }
      if (!honestChips || left < 3_000) return;
      if (state.phase === 'exact') {
        // The writer's count for a: every rider, and every other newcomer
        // with chips (an honest one as the fold has it, a ghost as written).
        let n = [...riders].filter((pid) => pid !== a.pid).length;
        for (const [pid, f] of res.felts) if (pid !== a.pid && !riders.has(pid) && !ghost(pid) && f.rec.b.length > 0) n += 1;
        const on = pids.filter((pid) => !riders.has(pid) && (mine(pid)?.length ?? 0) > 0);
        n += on.length;
        if (n < 31) {
          for (const pid of pids.filter((q) => !riders.has(q) && mine(q) === undefined).slice(0, 31 - n)) write(r, pid, [{ type: 'field', amount: 1 }], basis);
        } else if (n > 31) {
          for (const pid of on.slice(0, n - 31)) write(r, pid, [], basis);
        }
        return;
      }
      // Flood, once a roll, the rolls taking turns: the broken felts with a
      // few field bets (a close freezes them all: they take no place), or
      // 31 field bets past the room (the riders kept in it).
      if (mine(pids[1]) !== undefined) return;
      state.floods += 1;
      if (!riders.has(pids[0]) && mine(pids[0]) === undefined) write(r, pids[0], [{ type: 'place', pick: 6, amount: 6 }], basis);
      if (state.floods % 2 === 1) {
        write(r, special.stale, [{ type: 'field', amount: 1 }], '0'.repeat(32));
        write(r, special.forged, [{ type: 'dontcome', pick: 6, amount: 5 }], basis);
        if (carry.p !== 0) write(r, special.line, [{ type: 'pass', amount: 5 }], basis);
        for (const pid of pids.slice(1, 11)) write(r, pid, [{ type: 'field', amount: 1 }], basis);
      } else {
        for (const pid of pids.slice(1, 32)) write(r, pid, [{ type: 'field', amount: 1 }], basis);
      }
    });
  });
  return { state, special };
}

describe('computed craps: a full table', () => {
  for (const n of SEEDS) {
    it(`full ${n}: a cheat's ghosts fill the table to 31 and past it; a newcomer is refused (by the writer, and on its table UI), the fold leaves the 32nd out, stale and broken felts play as what rides`, async () => {
      // A stands at the table and bets nothing but its tries (a newcomer,
      // its 'full' try offered the first frame the table is full), its
      // table UI mounted.
      uiDom();
      try {
        const sim = await Sim.open({
          name: 'craps-full', seed: seed(400 + n), tables: crapsTable,
          pages: [
            { name: 'A', place: 1, crapsBot: { ...CRAPS_BOT, move: 0, standMove: 0, fake: 0, tries: 0.05 }, onLoad: withTableUI },
            ...named('BCD'),
            { name: 'X', honest: false, bot: null, place: 'off' },
          ],
        });
        const craps = sim.craps!;
        const x = sim.pages.find((sp) => sp.name === 'X')!;
        const a = sim.pages[0];
        x.cheats = true;
        x.beforeFrame = () => false;
        const g = ghosts(sim, x, a);
        sim.at(40_000, () => { g.state.phase = 'exact'; });
        // Once A's player was refused 'full' (or two minutes on), the flood.
        sim.every(() => {
          if (g.state.phase === 'exact' && ((craps.tries.full ?? 0) > 0 || sim.elapsed > 160_000)) g.state.phase = 'flood';
        });
        sim.at(RUN_MS - 60_000, () => { g.state.phase = 'done'; });
        // A's player, a newcomer at a full table (the checker's count, fullFor),
        // puts a chip on the field on its table UI once a roll: nothing goes
        // down, and the UI says so.
        sim.enter(a);
        const ta = atCraps(a.p as UIPage, { stand: 1, table: T });
        const fullPresses = new Set<number>();
        let fullSaid = 0;
        sim.every(() => {
          if (g.state.phase === 'off' || g.state.phase === 'done' || a.mode !== 'up' || sim.healed) return;
          const now = sim.enter(a);
          const v = a.p.table.readComputedCraps(T, now);
          if (!v || v.phase !== 'betting' || v.phaseDeadline === undefined || now >= v.phaseDeadline - 2_000 || fullPresses.has(v.round)) return;
          if (!craps.fullFor(a, T)) return;
          const { felt, basis } = a.p.table.readMyComputedCrapsBets(T, a.pid, v.round, now);
          if (felt.length > 0 || !loadHand(ta, 1)) return;
          fullPresses.add(v.round);
          craps.press(a, T, v.round, null, basis, () => ta.click('field'));
          const got = ta.said();
          ta.key('0');
          if (got === 'THE TABLE IS FULL — WAIT FOR A PLACE') fullSaid += 1;
          else sim.violate(`A's press at a full table at roll ${v.round} at ${sim.elapsed} ms said ${JSON.stringify(got)}`);
        });
        await sim.run(RUN_MS);
        sim.enter(a);
        ta.unmount();
        // (bettors: the honest three and X's key, which signs the ghosts'.)
        // Over the felts' budget by the design's lever 15 ("Nobody left to
        // close"): an honest felt taken down in the last 2 s of betting leaves
        // only the ghosts' chips, which nobody closes; the pages with none of
        // their own re-arm the roll GRACE_MAX_MS past every turn, and it takes
        // a fresh window, wait and turns.
        // And a throw may be cut short: the ghosts' chips gone, a page that
        // put a felt down just before W keeps its window (it saw chips at W;
        // "a page with its own felt closes itself instead") while the pages
        // with none re-arm to a fresh one, so its close at its own wait's end
        // lands in their fresh window before the holder throws (craps-full
        // seed=401: B at 196.5 s, D's wait to 211 s). The design takes that
        // close as it comes: it "lands in the newcomer's fresh window and
        // simply closes round o" (pr3-design-v6.md, "Nobody left to close"
        // and the L1d re-arm), the stickman's toss playing at it.
        const { table, croupier } = a.p;
        const s = await finish(sim, lines, {
          bettors: 5,
          preemptedOk: true,
          feltsExtraMs: table.GRACE_MAX_MS + croupier.CRAPS_BET_WINDOW_MS + croupier.CRAPS_SHOOTER_MS + 11 * table.STAGGER_MS,
        });
        const st = craps.stats;
        console.log(`[craps] ${sim.label}: floods ${g.state.floods}, fates ${JSON.stringify(st.fates)}, tries ${JSON.stringify(craps.tries)}, flagged ${[...craps.flagged].length}, UI full ${fullSaid}`);
        // The writer refused a 32nd player (A's try); the fold left newcomers
        // past the room out ('full'), played a stale stamp and broken felts as
        // what rides ('basis', 'illegal'), and the card flagged the broken
        // ones (not the stale one: it breaks no rule).
        expect(craps.tries.full ?? 0, sim.label).toBeGreaterThan(0);
        expect(g.state.floods, sim.label).toBeGreaterThan(0);
        expect(st.fates.full ?? 0, sim.label).toBeGreaterThan(0);
        expect(st.fates.basis ?? 0, sim.label).toBeGreaterThan(0);
        expect(st.fates.illegal ?? 0, sim.label).toBeGreaterThan(0);
        expect([...craps.flagged].some((k) => k.endsWith(`|${g.special.forged}`)), sim.label).toBe(true);
        expect([...craps.flagged].some((k) => k.endsWith(`|${g.special.stale}`)), sim.label).toBe(false);
        expect(fullSaid, sim.label).toBeGreaterThan(0);
        expect(s.rounds, sim.label).toBeGreaterThan(0);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🚪 The table's end ───────────────────────────────────────────────────────

describe("computed craps: the table's end", () => {
  for (const n of SEEDS) {
    it(`removal ${n}: the house takes the craps table out mid-point (a point on, line bets riding) with a roll under way; its felts stop holding at once, every bet riding goes back, and compaction finalises it`, async () => {
      const sim = await Sim.open({ name: 'craps-removal', seed: seed(500 + n), tables: crapsTable, pages: named('ABCD') });
      const craps = sim.craps!;
      const { house } = sim;
      const honest = sim.pages.map((sp) => sp.pid);
      let removed: string | null = null;
      let at: { point: number; contracts: number; held: bigint; chips: bigint; after: bigint; nets: string } | null = null;
      // From 70 s on, at the first look with a point on and a contract bet
      // riding (the design's "removal mid-point: the table is removed while
      // a point is on"), and a close in or chips on the felt.
      sim.every(async () => {
        if (removed || sim.elapsed < 70_000) return;
        sim.enter(house);
        const { casino } = house.p;
        const res = casino.computedFoldOf(T);
        if (!res || (!res.tip && ![...res.felts.values()].some((f) => f.rec.b.length > 0))) return;
        const carry = res.carry as { p: number; w: Record<string, CrapsBet[]> };
        const contracts = Object.values(carry.w).flat().filter((b) => b.type === 'pass' || (b.type === 'come' && b.pick !== undefined)).length;
        if (carry.p === 0 || contracts === 0) return;
        removed = casino.computedIncOf(T)!;
        const held = [...res.held.values()].reduce((m, v) => m + v, 0n);
        const chips = honest.reduce((m, pid) => m + BigInt(casino.readChips(pid)), 0n);
        const nets = JSON.stringify([...res.nets].filter(([, v]) => v !== 0n).map(([p, v]) => [p, v.toString()]).sort());
        await sim.remove(house, T);
        sim.enter(house);
        at = { point: carry.p, contracts, held, chips, after: honest.reduce((m, pid) => m + BigInt(casino.readChips(pid)), 0n), nets };
      });
      await sim.run(150_000);
      const s = await finish(sim, lines);
      expect(removed, sim.label).not.toBeNull();
      const inc = removed!;
      for (const sp of sim.pages) {
        const { casino, table, doc } = sp.p;
        sim.enter(sp);
        expect(casino.isComputedTable(T), `${sim.label} ${sp.name}`).toBe(false);
        expect(casino.tableIncRemoved(T, inc), `${sim.label} ${sp.name}`).toBe(true);
        expect(table.computedCompactionPending(), `${sim.label} ${sp.name}`).toBe(false);
        const map = doc.getMap('casinoComputed');
        expect([...map.keys()].filter((k) => k.startsWith(`ses:${T}:`)), `${sim.label} ${sp.name}`).toEqual([]);
        expect(map.get(`sum:${T}:${inc}`) as Checkpoint, `${sim.label} ${sp.name}`).toMatchObject({ v: 1, e: 1 });
      }
      // The final checkpoint's nets, those the checker handed on at the
      // close it names (checkEnded, from the cold folds' audits).
      expect(craps.stats.endedChecked, sim.label).toBeGreaterThan(0);
      expect(s.rounds, sim.label).toBeGreaterThan(0);
      // Mid-point: the point on and line or come bets riding as it went;
      // every chip on the felt (the riding bets with the rest) back on the
      // house's page at once, no net moved, the final checkpoint's nets the
      // fold's.
      console.log(`[craps] ${sim.label}: removed ${JSON.stringify(at, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      expect(at, sim.label).not.toBeNull();
      expect(at!.point, sim.label).not.toBe(0);
      expect(at!.contracts, sim.label).toBeGreaterThan(0);
      expect(at!.held, sim.label).toBeGreaterThan(0n);
      expect(at!.after, sim.label).toBe(at!.chips + at!.held);
      const cp = house.p.doc.getMap('casinoComputed').get(`sum:${T}:${inc}`) as Checkpoint;
      expect(JSON.stringify(Object.entries(cp.n).filter(([, v]) => String(v) !== '0').map(([p, v]) => [p, String(v)]).sort()), sim.label).toBe(at!.nets);
    }, TIMEOUT);

    it(`switch ${n}: the house switches the table off with contract bets riding (warned, then on the second press every bet goes back), owner-run play restarts fresh, and on again (fresh too)`, async () => {
      const sim = await Sim.open({ name: 'craps-switch', seed: seed(600 + n), tables: crapsTable, pages: named('ABCD') });
      const craps = sim.craps!;
      const { house } = sim;
      const honest = sim.pages.map((sp) => sp.pid);
      const refusals: Record<string, number> = {};
      const incs: string[] = [];
      let want: 'off' | 'on' | null = null;
      let off: { held: bigint; chips: bigint; after: bigint; nets: string; endNets: string; contracts: number; ownerInc: string } | null = null;
      // The owner-run table as the house's stickman opens it while the
      // table is off, and the computed incarnation the switch-on opens.
      let owner: { phase: string; round: number; point: number | null; inc: string | undefined; incFor: string; bets: number } | null = null;
      let reopened: { p: number; riders: number; rounds: number; held: number } | null = null;
      // From 90 s on, the first look with a contract bet riding; 20 s after
      // it went, back on (on a fresh incarnation).
      sim.every(() => {
        const now = sim.enter(house);
        const { table, casino } = house.p;
        if (incs.length === 0) incs.push(casino.computedIncOf(T)!);
        if (want === null && off === null && sim.elapsed >= 90_000) {
          const res = casino.computedFoldOf(T);
          const carry = res?.carry as { p: number; w: Record<string, CrapsBet[]> } | undefined;
          const contract = carry && Object.values(carry.w).some((f) => f.some((b) => (b.type === 'pass' && carry.p !== 0) || (b.type === 'come' && b.pick !== undefined)));
          if (contract) want = 'off';
        }
        if (want === 'off') {
          const res = casino.computedFoldOf(T)!;
          const first = table.switchComputedOff(T, now);
          if (first !== 'contract') {
            refusals[`off:${first}`] = (refusals[`off:${first}`] ?? 0) + 1;
            if (first === 'ok') sim.violate(`the switch-off at ${sim.elapsed} ms went with no warning, contract bets riding`);
            return;
          }
          refusals['off:contract'] = (refusals['off:contract'] ?? 0) + 1;
          const ownerInc = casino.tableIncFor(T);
          const riding = res.carry as { p: number; w: Record<string, CrapsBet[]> };
          const contracts = Object.values(riding.w).flat().filter((b) => (b.type === 'pass' && riding.p !== 0) || (b.type === 'come' && b.pick !== undefined)).length;
          const held = [...res.held.values()].reduce((m, v) => m + v, 0n);
          const chips = honest.reduce((m, pid) => m + BigInt(casino.readChips(pid)), 0n);
          const nets = JSON.stringify([...res.nets].filter(([, v]) => v !== 0n).map(([p, v]) => [p, v.toString()]).sort());
          const inc = casino.computedIncOf(T)!;
          const second = table.switchComputedOff(T, now, true);
          if (second !== 'ok') {
            refusals[`off-again:${second}`] = (refusals[`off-again:${second}`] ?? 0) + 1;
            return;
          }
          const cp = house.p.doc.getMap('casinoComputed').get(`sum:${T}:${inc}`) as Checkpoint;
          off = {
            held, chips, after: honest.reduce((m, pid) => m + BigInt(casino.readChips(pid)), 0n), nets,
            endNets: JSON.stringify(Object.entries(cp.n).map(([p, v]) => [p, String(v)]).sort()), contracts, ownerInc,
          };
          want = null;
          sim.at(sim.elapsed + 20_000, () => { want = 'on'; });
          return;
        }
        // While it is off: the owner-run table the house's stickman opens
        // (its tick, as World runs it), as it first reads.
        if (off !== null && owner === null && incs.length === 1) {
          const os = casino.readCrapsTableState(T);
          if (os) {
            owner = {
              phase: os.phase, round: os.round, point: os.point, inc: (os as { inc?: string }).inc, incFor: casino.tableIncFor(T),
              bets: honest.reduce((m, pid) => m + casino.readMyCrapsBets(T, pid).length, 0),
            };
          }
        }
        if (want === 'on') {
          const res = table.switchComputedOn(T, 'craps', now);
          if (res !== 'ok') {
            refusals[`on:${res}`] = (refusals[`on:${res}`] ?? 0) + 1;
            return;
          }
          incs.push(casino.computedIncOf(T)!);
          const fresh = casino.computedFoldOf(T)!;
          const carry = fresh.carry as { p: number; w: Record<string, CrapsBet[]> };
          reopened = { p: carry.p, riders: Object.keys(carry.w).length, rounds: fresh.rounds.length, held: fresh.held.size };
          want = null;
        }
      });
      await sim.run(RUN_MS);
      const s = await finish(sim, lines);
      console.log(`[craps] ${sim.label}: refusals ${JSON.stringify(refusals)}, incs ${incs.length}, off ${JSON.stringify(off, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}, owner-run ${JSON.stringify(owner)}, reopened ${JSON.stringify(reopened)}`);
      expect(off, sim.label).not.toBeNull();
      expect(off!.contracts, sim.label).toBeGreaterThan(0);
      // Owner-run play restarts fresh (the design's switch-off-on): its
      // first roll, no point, on an incarnation of its own past the
      // computed one's end, nobody's bets on it (the riding bets went back
      // to the rails, not onto the owner-run felt).
      expect(owner, sim.label).toMatchObject({ phase: 'betting', round: 1, point: null, bets: 0 });
      expect(owner!.inc, sim.label).toBe(owner!.incFor);
      expect(owner!.incFor, sim.label).not.toBe(off!.ownerInc);
      // And the computed table back on starts fresh too: a come-out, nobody
      // riding, no roll, nothing held.
      expect(reopened, sim.label).toEqual({ p: 0, riders: 0, rounds: 0, held: 0 });
      // The second press handed every chip on the felt back (the riding
      // bets with the rest), moving no nets.
      expect(off!.after, sim.label).toBe(off!.chips + off!.held);
      expect(off!.held, sim.label).toBeGreaterThan(0n);
      // Its final checkpoint carries the nets the fold had (an ending moves
      // no chips), which the checker held to its own (checkEnded).
      expect(off!.endNets, sim.label).toBe(off!.nets);
      expect(refusals['off:contract'], sim.label).toBeGreaterThan(0);
      expect(incs.length, sim.label).toBe(2);
      expect(craps.stats.endedChecked, sim.label).toBeGreaterThan(0);
      for (const sp of sim.pages) {
        sim.enter(sp);
        expect(sp.p.casino.computedIncOf(T), sim.label).toBe(incs[1]);
        expect(sp.p.casino.computedIncEnded(T, incs[0]), `${sim.label} ${sp.name}`).toBe(true);
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🔁 Churn ─────────────────────────────────────────────────────────────────

describe('computed craps: churn', () => {
  for (const n of SEEDS) {
    it(`churn ${n}: pages leave, crash, sleep and reload (with a goodbye or none) and join, the shooter among them`, async () => {
      const sim = await Sim.open({ name: 'craps-churn', seed: seed(700 + n), tables: crapsTable, pages: named('ABCDEF') });
      const others = (): SimPage[] => sim.pages.filter((sp) => sp.name !== 'A');
      const did: Record<string, number> = {};
      const churn = async (): Promise<void> => {
        if (sim.healed) return;
        const r = sim.rand;
        const cands = others();
        // The dice's holder, half the time.
        const res = sim.pages[0].p.casino.computedFoldOf(T);
        const h = (res?.carry as { h?: string } | undefined)?.h;
        const holder = cands.find((sp) => sp.pid === h);
        const sp = holder && r() < 0.5 ? holder : cands[between(r, 0, cands.length - 1)];
        const x = r();
        const what = sp.mode === 'gone' ? 'back' : sp.mode === 'asleep' ? 'wake' : x < 0.25 ? 'leave' : x < 0.45 ? 'crash' : x < 0.6 ? 'sleep' : x < 0.8 ? 'reload' : 'reload-bye';
        did[what] = (did[what] ?? 0) + 1;
        if (what === 'back') await sim.reload(sp);
        else if (what === 'wake') sim.wake(sp);
        else if (what === 'leave') await sim.leave(sp);
        else if (what === 'crash') sim.crash(sp);
        else if (what === 'sleep') sim.sleep(sp, r() < 0.5);
        else await sim.reload(sp, { goodbye: what === 'reload-bye' });
        sim.at(sim.elapsed + between(r, 8_000, 25_000), churn);
      };
      sim.at(20_000, churn);
      sim.at(60_000, () => sim.add({ name: 'G' }).then(() => undefined));
      await sim.run(RUN_MS);
      for (const sp of others()) if (sp.mode === 'gone') await sim.reload(sp);
      // Scoped, as roulette's churn: a page that crashed with its felt down
      // and is back just as the grace runs out reveals from its store, its
      // seed in time on some page and late on another (forfeit over reveals,
      // answered). Over the felts' budget by the timing rules: a page whose
      // turn was another tab's or that is back from a crash waits
      // GRACE_MAX_MS more (closeDue), and a roll whose bettors' pages all
      // went is taken back to betting past every turn (a re-arm: GRACE_MAX_MS,
      // then a fresh window and wait).
      const { table, croupier } = sim.pages[0].p;
      const s = await finish(sim, lines, {
        awayFlips: ['forfeit over reveals', 'answer forfeit'],
        feltsExtraMs: 2 * table.GRACE_MAX_MS + croupier.CRAPS_BET_WINDOW_MS + croupier.CRAPS_SHOOTER_MS,
      });
      console.log(`[craps] ${sim.label}: churn ${JSON.stringify(did)}`);
      expect(Object.values(did).reduce((m, v) => m + v, 0), sim.label).toBeGreaterThan(5);
      expect(sim.craps!.stats.goodbyes, sim.label).toBeGreaterThan(0);
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🖥️ The table UI ──────────────────────────────────────────────────────────

describe('computed craps: the table UI', () => {
  for (const n of SEEDS) {
    it(`ui ${n}: a player bets through the mounted table UI; it refuses odds past the 3-4-5x room with ODDS MAX, the line mid-point, the come box at a come-out, and any bet once betting is over`, async () => {
      uiDom();
      try {
        const sim = await Sim.open({
          name: 'craps-ui', seed: seed(800 + n), tables: crapsTable,
          pages: [
            { name: 'U', place: 1, crapsBot: { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0 }, onLoad: withTableUI },
            ...named('ABC'),
          ],
        });
        const craps = sim.craps!;
        const u = sim.pages[0];
        sim.enter(u);
        const t = atCraps(u.p as UIPage, { stand: 1, table: T });
        const said: Record<string, number> = {};
        const pressed = new Set<string>();
        sim.every(() => {
          if (u.mode !== 'up' || sim.healed) return;
          const now = sim.enter(u);
          const { table } = u.p;
          const v = table.readComputedCraps(T, now);
          if (!v) return;
          const r = v.round;
          const once = (kind: string): boolean => {
            const k = `${kind}|${r}`;
            if (pressed.has(k)) return false;
            pressed.add(k);
            return true;
          };
          const mine = (): { felt: CrapsBet[]; basis: string } => table.readMyComputedCrapsBets(T, u.pid, r, now);
          const amountOf = (f: readonly CrapsBet[], type: CrapsBet['type']): number => f.filter((b) => b.type === type && b.pick === undefined).reduce((m, b) => m + b.amount, 0);
          // A press the UI must refuse: nothing written, these words said.
          const refused = (kind: string, chips: number, type: CrapsBet['type'], want: string): void => {
            if (!loadHand(t, chips)) return;
            const { basis } = mine();
            craps.press(u, T, r, null, basis, () => t.click(type));
            const got = t.said();
            t.key('0');
            if (got === want) said[kind] = (said[kind] ?? 0) + 1;
            else sim.violate(`U's ${kind} press (${chips} on ${type}) at roll ${r} at ${sim.elapsed} ms said ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
          };
          // A press the UI must put down: the felt with `chips` more on `type`.
          const placed = (kind: string, chips: number, type: CrapsBet['type']): void => {
            if (!loadHand(t, chips)) return;
            const { felt, basis } = mine();
            const want = canonList([...felt, { type, amount: chips }]);
            craps.press(u, T, r, want, basis, () => t.click(type));
            t.key('0');
            const after = mine().felt;
            if (amountOf(after, type) === amountOf(felt, type) + chips) said[kind] = (said[kind] ?? 0) + 1;
            else sim.violate(`U's ${kind} press (${chips} on ${type}) at roll ${r} at ${sim.elapsed} ms left ${JSON.stringify(after)} (said ${JSON.stringify(t.said())}), not ${JSON.stringify(want)}`);
          };
          if (v.phase === 'betting' && (v.phaseDeadline === undefined || now < v.phaseDeadline - 2_000)) {
            const { felt } = mine();
            const point = v.point ?? null;
            if (point === null) {
              if (once('come')) refused('come box', 5, 'come', 'THE COME BOX OPENS ONCE A POINT IS ON');
              if (amountOf(felt, 'pass') === 0 && once('pass')) placed('pass', 10, 'pass');
              return;
            }
            if (once('line')) refused('line closed', 5, 'pass', 'THE LINE IS CLOSED WHILE A POINT IS ON');
            const flat = amountOf(felt, 'pass');
            const room = flat * ODDS_X[point] - amountOf(felt, 'passodds');
            if (flat > 0 && room > 0 && once('odds')) {
              refused('odds max', room + 1, 'passodds', `ODDS MAX — ${room} MORE FITS HERE`);
              placed('odds', room, 'passodds');
              refused('odds at the maximum', 1, 'passodds', 'THE ODDS ARE AT THE TABLE MAXIMUM');
            }
            return;
          }
          if (v.phase === 'closing' && once('closing')) refused('no more bets', 1, 'field', 'NO MORE BETS');
          if (v.phase === 'settled' && once('settled')) refused('wait', 1, 'field', 'WAIT FOR THE NEXT ROUND');
        });
        await sim.run(RUN_MS);
        // (At U's clock: its table module reads a clock step as a wake.)
        sim.enter(u);
        t.unmount();
        const s = await finish(sim, lines);
        console.log(`[craps] ${sim.label}: said ${JSON.stringify(said)}`);
        // Every one of them said, and the odds put down to the room exactly
        // (the felt read back, the slip held to it: ownSlip).
        for (const kind of ['come box', 'pass', 'line closed', 'odds max', 'odds', 'odds at the maximum', 'no more bets', 'wait']) {
          expect(said[kind] ?? 0, `${sim.label} ${kind}`).toBeGreaterThan(0);
        }
        expect(s.rounds, sim.label).toBeGreaterThan(0);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});
