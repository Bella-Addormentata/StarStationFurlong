/**
 * 🧪🎲🌐 Computed craps over the simulated network: players coming and
 * going (the design's simulation scenarios fresh-table, lone-rider-gone,
 * full-of-gone-riders and reload-rider). Each scenario runs three seeds
 * through the shared finish (computedCrapsSimKit: the checker's walk of
 * every fold, every oracle, the stall budgets by phase) and asserts what the
 * design says it must show, with counters that prove each case happened on
 * every seed. Where the design names words on screen, the real table UI is
 * mounted on the page (computedCrapsUiKit) and its words are read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_STEP, Sim } from './computedSim';
import type { PageSpec, SimPage } from './computedSim';
import { canonList, CRAPS_BOT } from './computedCrapsSim';
import type { CrapsBotSpec } from './computedCrapsSim';
import { T, TIMEOUT, finish, seed } from './computedCrapsSimKit';
import { atCraps, stubDom, withUI } from './computedCrapsUiKit';
import type { AtCraps, FakeEl, UIPage } from './computedCrapsUiKit';
import { rigRoll } from './computedPageKit';
import type { Page } from './computedPageKit';
import type { CrapsSlipRec } from './computedFold';
import { RING } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
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

// ── 🧰 This file's kit (computedCrapsSimRiders.test.ts has its own copy) ─────

/** A player the scenario bets for by hand (bet): no moves, tries or stand
 *  moves of its own; it throws the dice it is offered 1–6 s into the wait
 *  (never past it). */
const QUIET: CrapsBotSpec = { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0, lateEvery: 0, fling: [1_000, 6_000] };

const withTableUI = async (p: Page): Promise<void> => {
  await withUI(p);
};
/** A DOM whose timers do nothing (the sim drives the UI by hand). */
function uiDom(): FakeEl {
  return stubDom({ setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
}
function noDom(): void {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
}

const amt = (f: readonly CrapsBet[], type: CrapsBet['type'], pick?: number): number =>
  f.filter((b) => b.type === type && b.pick === pick).reduce((m, b) => m + b.amount, 0);
const canonText = (f: readonly CrapsBet[]): string => JSON.stringify(canonList(f));
const ridingOf = (k: CrapsCarry, pid: string): CrapsBet[] => k.w[pid] ?? [];
const sumOf = (f: readonly CrapsBet[]): number => f.reduce((m, b) => m + b.amount, 0);

/** Page sp's player puts a felt down as a press on its table would (`edit`
 *  gives the whole felt from the one it has and the point; null: no press),
 *  through the writer while betting is open with more than `margin` ms
 *  left, held to the slip oracle (CrapsHarness press). The writer's answer,
 *  or null when nothing was pressed. Any answer but 'ok', 'closed' or
 *  'reconnecting' is a violation unless `expect` names it. */
async function bet(
  sim: Sim, sp: SimPage, edit: (felt: CrapsBet[], point: number | null, round: number) => CrapsBet[] | null, margin = 2_000, expectAnswer?: string,
): Promise<string | null> {
  if (sp.mode !== 'up' || sp.leaving || sim.T < sp.pauseUntil) return null;
  return sim.as(sp, (now) => {
    const { table } = sp.p;
    const v = table.readComputedCraps(T, now);
    if (!v || v.phase !== 'betting' || (v.phaseDeadline !== undefined && now >= v.phaseDeadline - margin)) return null;
    const { felt, basis } = table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
    const want = edit(felt, v.point, v.round);
    if (want === null) return null;
    const list = canonList(want);
    const res = sim.craps!.press(sp, T, v.round, list, basis, () => table.writeComputedCrapsSlip(T, list, basis, now));
    if (res !== 'ok' && res !== 'closed' && res !== 'reconnecting' && res !== expectAnswer) {
      sim.violate(`${sp.name}'s felt ${JSON.stringify(list)} over ${JSON.stringify(felt)} at roll ${v.round} at ${sim.elapsed} ms answered ${res}`);
    }
    return res;
  });
}

/** A decided roll as the reference page's fold has it, with the slips its
 *  close froze. */
interface Roll {
  inc: string;
  r: number;
  close: string;
  decided: string;
  closer: string;
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
        sIn: v.craps.sIn, sOut: v.craps.sOut, fates: new Map(v.craps.fates), lost: new Map(v.craps.lost),
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

/** The first player counted at their stand on roll x, clockwise from the
 *  ring's start (craps.ts pickShooter, computedCraps RING): a slip with a
 *  stand and chips, its seed counted. */
function firstCounted(x: Roll): string | undefined {
  const seated = [...x.slips].filter(([pid, rec]) => rec.t !== undefined && x.counted.includes(pid) && sumOf(rec.b) > 0);
  seated.sort(([a, ra], [b, rb]) => RING.indexOf(ra.t!) - RING.indexOf(rb.t!) || (a < b ? -1 : 1));
  return seated[0]?.[0];
}

/** Player pid's name on page sp's screen (readPlayerDisplayName), as the
 *  status line says it. */
function nameOn(sp: SimPage, pid: string): string {
  const e = sp.p.doc.getMap('players').get(pid) as { name?: unknown } | undefined;
  return (typeof e?.name === 'string' && e.name.length > 0 ? e.name : pid.slice(0, 8)).toUpperCase();
}

/** Page sp's fold of the table caught up with page ref's: in the room, its
 *  doc whole and checked, the same rolls decided and the same open roll. */
function caughtUp(sim: Sim, sp: SimPage, ref: SimPage): boolean {
  if (sp.mode !== 'up' || !sp.roomIn || sp.partial) return false;
  sim.enter(sp);
  const { casino } = sp.p;
  if (!casino.casinoWhole() || !casino.computedSettled()) return false;
  const a = casino.computedFoldOf(T);
  const b = ref.p.casino.computedFoldOf(T);
  return !!a && !!b && a.open === b.open && a.parent === b.parent && casino.computedIncOf(T) === ref.p.casino.computedIncOf(T);
}

/** The status lines a mounted table UI showed, by roll and phase (its own
 *  view's), each tick it is updated. */
function statusLog(sim: Sim, sp: SimPage, t: () => AtCraps | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  sim.every(() => {
    const ui = t();
    if (!ui || sp.mode !== 'up' || sim.healed) return;
    const now = sim.enter(sp);
    ui.update();
    const v = sp.p.table.readComputedCraps(T, now);
    if (!v) return;
    const key = `${v.inc}|${v.round}|${v.phase}`;
    const line = ui.status();
    const got = out.get(key) ?? [];
    if (got[got.length - 1] !== line) got.push(line);
    out.set(key, got);
  });
  return out;
}

// ── 🆕 fresh-table ───────────────────────────────────────────────────────────

describe('computed craps: fresh-table', () => {
  for (const n of SEEDS) {
    it(`fresh-table ${n}: the stickman throws the first roll, the dice go at once to the first player counted at their stand, even mid-point, and that player's next roll waits for their throw`, async () => {
      uiDom();
      try {
        // H, the house's page, its table UI up at the device front. B and C at
        // stands 4 and 5 (B first clockwise), B's table UI up; D at the device
        // front (never counted at a stand).
        const sim = await Sim.open({
          name: 'craps-fresh-table', seed: seed(2500 + n), tables: crapsTable,
          pages: [
            { name: 'H', house: true, bot: null, onLoad: withTableUI },
            { name: 'B', place: 4, crapsBot: QUIET, onLoad: withTableUI },
            { name: 'C', place: 5, crapsBot: QUIET },
            { name: 'D', place: null, crapsBot: QUIET },
          ],
        });
        const [h, b, c, d] = sim.pages;
        const log = rollLog(sim, h);
        sim.enter(h);
        const th = atCraps(h.p as UIPage, { stand: null, house: true, table: T });
        sim.enter(b);
        const tb = atCraps(b.p as UIPage, { stand: 4, table: T });
        const hLines = statusLog(sim, h, () => th);
        const bLines = statusLog(sim, b, () => tb);
        // Which pages' views showed the wait for a throw on each roll, and
        // whose throw.
        const waited = new Map<string, Set<string>>();
        sim.every(() => {
          for (const sp of sim.pages) {
            if (sp.mode !== 'up') continue;
            const v = sp.p.table.readComputedCraps(T, sim.enter(sp));
            if (!v || v.phase !== 'closing' || v.phaseDeadline === undefined) continue;
            const key = `${v.inc}|${v.round}`;
            if (!waited.has(key)) waited.set(key, new Set());
            waited.get(key)!.add(`${sp.name}:${v.shooter ?? '-'}`);
          }
        });
        // The cases: 'first' (a fresh table: B and C bet on its first roll and
        // the one after), the switch off and on (a fresh table again), then
        // 'mid' (only D's pass, at the device front, until a point is on; then
        // C alone at a stand bets: the stickman's roll mid-point; then C's).
        let step = 'first' as 'first' | 'switch' | 'mid' | 'seat' | 'next' | 'done';
        const marks: { first?: Roll; second?: Roll; seat?: Roll; next?: Roll; stickman: Roll[] } = { stickman: [] };
        let incs: string[] = [];
        sim.every(async () => {
          if (sim.healed) return;
          const now = sim.enter(h);
          const inc = h.p.casino.computedIncOf(T)!;
          const res = h.p.casino.computedFoldOf(T);
          if (!res) return;
          const k = res.carry as CrapsCarry;
          const field = (felt: CrapsBet[]): CrapsBet[] | null => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null);
          const mine = log.filter((x) => x.inc === inc && x.dice);
          if (step === 'first') {
            if (incs.length === 0) incs = [inc];
            if (mine.length === 0) {
              await bet(sim, b, field);
              await bet(sim, c, field);
            } else if (mine.length === 1) {
              marks.first = mine[0];
              await bet(sim, b, field);
              await bet(sim, c, field);
            } else {
              marks.second = mine[1];
              step = 'switch';
            }
            return;
          }
          if (step === 'switch') {
            const off = h.p.table.switchComputedOff(T, now);
            const done = off === 'ok' || (off === 'contract' && h.p.table.switchComputedOff(T, now, true) === 'ok');
            if (!done) return;
            const on = h.p.table.switchComputedOn(T, 'craps', now);
            if (on !== 'ok') sim.violate(`the house's switch-on at ${sim.elapsed} ms answered ${on}`);
            incs.push(h.p.casino.computedIncOf(T)!);
            step = 'mid';
            return;
          }
          if (inc !== incs[1]) return;
          if (step === 'mid') {
            // The stickman's rolls: nobody at a stand bets.
            for (const x of mine) if (!marks.stickman.includes(x)) marks.stickman.push(x);
            if (k.p !== 0 && k.h === undefined && !res.tip) {
              step = 'seat';
              return;
            }
            await bet(sim, d, (felt, point) => (point === null && amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null));
            return;
          }
          if (step === 'seat') {
            const x = mine.find((y) => y.sIn.h === undefined && y.pointBefore !== null && y.slips.has(c.pid));
            if (x) {
              marks.seat = x;
              step = 'next';
              return;
            }
            await bet(sim, c, field);
            return;
          }
          if (step === 'next') {
            const x = mine.find((y) => marks.seat && y.r === marks.seat.r + 1);
            if (x) {
              marks.next = x;
              step = 'done';
              return;
            }
            await bet(sim, c, field);
          }
        });
        while (step !== 'done' && sim.elapsed < 15 * 60_000) await sim.run(5_000);
        sim.enter(h);
        th.unmount();
        sim.enter(b);
        tb.unmount();
        const s = await finish(sim, lines);
        const say = (x: Roll | undefined): string => (x ? `${x.r} ${x.sIn.h ?? 'stickman'}→${x.sOut.h ?? 'stickman'}${x.sOut.i ? ' in play' : ''} point ${x.pointBefore}→${x.pointAfter} closer ${sim.pages.find((q) => q.p.pub === x.closer)?.name}` : 'none');
        console.log(`[craps] ${sim.label}: first ${say(marks.first)}, second ${say(marks.second)}, stickman ${marks.stickman.length}, seat ${say(marks.seat)}, next ${say(marks.next)}, waits ${JSON.stringify([...waited].map(([key, v]) => [key.slice(-6), [...v].length]))}`);
        expect(step, sim.label).toBe('done');
        const all = sim.pages.map((sp) => sp.name).sort();
        const waitedBy = (x: Roll): string[] => [...(waited.get(`${x.inc}|${x.r}`) ?? [])].map((w) => w.split(':')[0]).sort();
        const throwsFor = (x: Roll): string[] => [...new Set([...(waited.get(`${x.inc}|${x.r}`) ?? [])].map((w) => w.split(':')[1]))];
        const H = (x: Roll): string[] => [...(hLines.get(`${x.inc}|${x.r}|closing`) ?? [])];
        // The first roll of the fresh table: the stickman's (no wait on any
        // page; "THE STICKMAN THROWS"), and the dice at once to the first
        // player counted at their stand on it: B.
        const first = marks.first!;
        expect(first.sIn.h, sim.label).toBeUndefined();
        expect(waitedBy(first), sim.label).toEqual([]);
        expect(H(first), sim.label).toContain('✋ NO MORE BETS — THE STICKMAN THROWS');
        expect(firstCounted(first), sim.label).toBe(b.pid);
        expect(first.sOut.h, sim.label).toBe(b.pid);
        expect(first.sOut.i, sim.label).toBe(1);
        // B's next roll waits for B's throw: every page shows the wait with B
        // shooting, B's screen offers the dice, H's says B is shooting, and B's
        // own page closes it (after its fling: the close oracle).
        const second = marks.second!;
        expect(second.sIn.h, sim.label).toBe(b.pid);
        expect(waitedBy(second), sim.label).toEqual(all);
        expect(throwsFor(second), sim.label).toEqual([b.pid]);
        expect(second.closer, sim.label).toBe(b.p.pub);
        expect(H(second).some((x) => x.startsWith(`✋ NO MORE BETS — ${nameOn(h, b.pid)} IS SHOOTING`)), `${sim.label} ${JSON.stringify(H(second))}`).toBe(true);
        expect([...(bLines.get(`${second.inc}|${second.r}|closing`) ?? [])].some((x) => x.startsWith('🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM ACROSS THE TABLE')), sim.label).toBe(true);
        // After the switch, the stickman's rolls (D's pass at the device
        // front, nobody counted at a stand): no wait, nobody given the dice.
        expect(marks.stickman.length, sim.label).toBeGreaterThan(0);
        for (const x of marks.stickman) {
          expect(x.sIn.h, sim.label).toBeUndefined();
          expect(x.sOut.h, sim.label).toBeUndefined();
          expect(waitedBy(x), sim.label).toEqual([]);
        }
        // Mid-point, the stickman's roll with C counted at its stand (B at
        // its stand bets nothing): the dice go at once to C.
        const seat = marks.seat!;
        expect(seat.pointBefore, sim.label).not.toBeNull();
        expect(waitedBy(seat), sim.label).toEqual([]);
        expect(H(seat), sim.label).toContain('✋ NO MORE BETS — THE STICKMAN THROWS');
        expect(firstCounted(seat), sim.label).toBe(c.pid);
        expect(seat.sOut.h, sim.label).toBe(c.pid);
        expect(seat.sOut.i, sim.label).toBe(1);
        // And C's next roll waits for C's throw.
        const next = marks.next!;
        expect(next.sIn.h, sim.label).toBe(c.pid);
        expect(next.sIn.i, sim.label).toBe(1);
        expect(waitedBy(next), sim.label).toEqual(all);
        expect(throwsFor(next), sim.label).toEqual([c.pid]);
        expect(next.closer, sim.label).toBe(c.p.pub);
        expect(H(next).some((x) => x.startsWith(`✋ NO MORE BETS — ${nameOn(h, c.pid)} IS SHOOTING`)), `${sim.label} ${JSON.stringify(H(next))}`).toBe(true);
        expect(incs.length, sim.label).toBe(2);
        expect(s.rounds, sim.label).toBeGreaterThan(0);
        void d;
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 👋 lone-rider-gone ───────────────────────────────────────────────────────

type GoneCase = 'bye' | 'crash' | 'crash-off' | 'bye-wait';

interface GoneEp {
  kind: GoneCase;
  inc: string;
  r: number;
  /** The newcomer's view of the roll: the end of betting (the window the
   *  rider's felt opened), the wait's end, when betting reopens; when it
   *  first saw the window let go; its first 'ok', and every answer. */
  W?: number;
  D?: number;
  stallUntil?: number;
  letGo?: number;
  okAt?: number;
  okDeadline?: number;
  answers: Record<string, number>;
  /** The house's switch-off presses: during the wait (busy), and what each
   *  answered; whether it went through, during the wait or after it; the
   *  players' chips before and after it, and what the felt held. */
  busy: number;
  offs: string[];
  offWait?: boolean;
  chips?: { before: bigint; held: bigint; after?: bigint };
  roll?: Roll;
}

describe('computed craps: lone-rider-gone', () => {
  for (const n of SEEDS) {
    it(`lone-rider-gone ${n}: a lone rider holding the dice closes the tab mid-window, with a goodbye (a newcomer bets at once) and without (a crash: about 10 s after the last close turn); the house's switch-off around the wait; and a holder's goodbye during the wait`, async () => {
      uiDom();
      try {
        // R, the lone rider at stand 3 (a pass on each come-out, place 6 once a
        // point is on), throws 3–8 s into its wait. N, the newcomer at the
        // device front with its table UI up, bets only when told. H, the
        // house's page, off the table.
        const sim = await Sim.open({
          name: 'craps-lone-rider-gone', seed: seed(2600 + n), tables: crapsTable,
          pages: [
            { name: 'H', house: true, bot: null },
            { name: 'R', place: 3, crapsBot: { ...QUIET, fling: [3_000, 8_000] } },
            { name: 'N', place: null, crapsBot: QUIET, onLoad: withTableUI },
          ],
        });
        const craps = sim.craps!;
        const [h, r, nn] = sim.pages;
        const log = rollLog(sim, h);
        sim.enter(nn);
        const tn = atCraps(nn.p as UIPage, { stand: null, table: T });
        const nLines = statusLog(sim, nn, () => tn);
        const { croupier, table } = h.p;
        const order: GoneCase[] = ['bye', 'crash', 'crash-off', 'bye-wait'];
        const got: GoneEp[] = [];
        let ep: GoneEp | null = null;
        let rBack = true;
        let nPlays = false;
        const pids = [r.pid, nn.pid];
        const chipsOf = (): bigint => pids.reduce((m, pid) => m + BigInt(h.p.casino.readChips(pid)), 0n);
        const heldOf = (res: { held: ReadonlyMap<string, bigint> }): bigint => [...res.held.values()].reduce((m, x) => m + x, 0n);
        const field = (felt: CrapsBet[]): CrapsBet[] | null => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null);
        sim.every(async () => {
          if (sim.healed) return;
          const hNow = sim.enter(h);
          const inc = h.p.casino.computedIncOf(T);
          const res = h.p.casino.computedFoldOf(T);
          if (!inc || !res) return;
          const k = res.carry as CrapsCarry;
          // R's play, while its page is here.
          if (r.mode === 'up' && !r.leaving) {
            await bet(sim, r, (felt, point) => {
              if (point === null) return amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
              return amt(felt, 'place', 6) === 0 ? [...felt, { type: 'place', pick: 6, amount: 12 }] : null;
            });
          }
          if (nPlays) await bet(sim, nn, field);
          if (!ep) {
            if (got.length === order.length || !rBack) return;
            // A lone rider holding the dice, in play: its own slip with chips
            // on the roll.
            const kind = order[got.length];
            const v = r.p.table.readComputedCraps(T, sim.enter(r));
            const rNow = Date.now();
            const f = res.felts.get(r.pid);
            const others = [...res.felts.values()].some((x) => x.rec.p !== r.pid && x.rec.b.length > 0);
            if (k.h !== r.pid || k.i !== 1 || ridingOf(k, r.pid).length === 0 || res.tip || !f || f.rec.b.length === 0 || (f.rec as CrapsSlipRec).l === 1) return;
            if (kind === 'bye-wait') {
              // In the wait for its throw (before it flings), the newcomer's
              // chips on the roll: it leaves the room, with a goodbye.
              nPlays = true;
              const W = v?.phaseDeadline !== undefined ? v.phaseDeadline - croupier.CRAPS_SHOOTER_MS : 0;
              if (v?.phase !== 'closing' || v.phaseDeadline === undefined || rNow < W + 500 || rNow >= W + 2_500) return;
              if ((res.felts.get(nn.pid)?.rec.b.length ?? 0) === 0) return;
              nPlays = false;
              ep = { kind, inc, r: res.open, answers: {}, busy: 0, offs: [] };
              const was = craps.stats.goodbyes;
              await sim.leave(r);
              if (craps.stats.goodbyes !== was + 1) sim.violate(`R's leave in the wait at ${sim.elapsed} ms said no goodbye`);
              rBack = false;
              return;
            }
            // Mid-window, nobody else's chips on the roll: the tab closes.
            if (others || v?.phase !== 'betting' || v.phaseDeadline === undefined || rNow < v.phaseDeadline - 12_000 || rNow >= v.phaseDeadline - 4_000) return;
            const nv = nn.p.table.readComputedCraps(T, sim.enter(nn));
            if (nv?.phase !== 'betting' || nv.phaseDeadline === undefined) return;
            ep = { kind, inc, r: res.open, W: nv.phaseDeadline, answers: {}, busy: 0, offs: [] };
            rBack = false;
            if (kind === 'bye') {
              // With its pagehide's goodbye (held to the goodbye oracle).
              const was = craps.stats.goodbyes;
              await craps.goodbye(r);
              if (craps.stats.goodbyes !== was + 1) sim.violate(`R's goodbye at ${sim.elapsed} ms wasn't written`);
            }
            sim.crash(r);
            return;
          }
          if (ep.inc !== inc) return;
          const nNow = sim.enter(nn);
          const nv = nn.p.table.readComputedCraps(T, nNow);
          const hv = h.p.table.readComputedCraps(T, sim.enter(h));
          if (ep.kind === 'bye' || ep.kind === 'crash') {
            // The newcomer's view until its bet goes in.
            if (ep.okAt === undefined && nv?.round === ep.r) {
              if (nv.phase === 'betting' && nv.phaseDeadline === undefined && ep.letGo === undefined) ep.letGo = nNow;
              if (nv.phase === 'closing' && nv.phaseDeadline !== undefined) ep.D = nv.phaseDeadline;
              if (nv.stallUntil !== undefined) ep.stallUntil = nv.stallUntil;
            }
            // From the end of the window the gone rider's felt opened, the
            // newcomer tries every frame (a press on any phase: the writer
            // says 'closed' while the roll is).
            if (ep.okAt === undefined && nNow >= ep.W!) {
              const a = await sim.as(nn, (now) => {
                const { table: tt } = nn.p;
                const vv = tt.readComputedCraps(T, now)!;
                const { felt, basis } = tt.readMyComputedCrapsBets(T, nn.pid, vv.round, now);
                const list = canonList([...felt, { type: 'field', amount: 5 }]);
                return craps.press(nn, T, vv.round, list, basis, () => tt.writeComputedCrapsSlip(T, list, basis, now));
              });
              ep.answers[a] = (ep.answers[a] ?? 0) + 1;
              if (a === 'ok') {
                ep.okAt = nNow;
                ep.okDeadline = nn.p.table.readComputedCraps(T, sim.enter(nn))?.phaseDeadline;
              } else if (a !== 'closed') {
                sim.violate(`N's bet at ${sim.elapsed} ms answered ${a}`);
              }
            }
          }
          // The house's switch-off while the roll waits on the gone holder:
          // during the wait refused while its slip has chips and isn't a
          // goodbye, through once it is one; after the wait, through.
          if (ep.kind === 'bye' || hv?.phase !== 'closing' || hv.round !== ep.r || res.tip || res.openCloses.length > 0 || ep.offWait !== undefined) return;
          const inWait = hv.phaseDeadline !== undefined;
          const holderBye = (res.felts.get(r.pid)?.rec as CrapsSlipRec | undefined)?.l === 1;
          // (Once off, on again at once: a fresh table for the next case.)
          const onAgain = (): void => {
            const on = h.p.table.switchComputedOn(T, 'craps', hNow);
            if (on !== 'ok') sim.violate(`the house's switch-on at ${sim.elapsed} ms answered ${on}`);
          };
          const press = (when: string, through: boolean): void => {
            ep!.chips = { before: chipsOf(), held: heldOf(res) };
            const a = h.p.table.switchComputedOff(T, hNow);
            ep!.offs.push(`${when}:${a}`);
            const b2 = a === 'contract' ? h.p.table.switchComputedOff(T, hNow, true) : a;
            if (a === 'contract') ep!.offs.push(`${when}-again:${b2}`);
            if (b2 === 'ok') {
              ep!.offWait = through;
              ep!.chips.after = chipsOf();
              onAgain();
            }
          };
          if (inWait && ep.kind !== 'bye-wait') {
            // (A press that goes during the wait is a failure: at the first
            // crash it would end the table before the newcomer's turn.)
            const a = h.p.table.switchComputedOff(T, hNow);
            if (a === 'busy') ep.busy += 1;
            else {
              ep.offs.push(`wait:${a}`);
              if (a === 'ok') {
                ep.offWait = true;
                onAgain();
              }
            }
          } else if (inWait && holderBye) {
            press('wait', true);
          } else if (!inWait && ep.kind === 'crash-off' && ep.busy > 0) {
            press('after', false);
          }
        });
        // Each case to its end: its roll decided (or the table switched off and
        // on again), then R back (a reload) to play into the next.
        sim.every(async () => {
          if (!ep || sim.healed) return;
          const roll = log.find((x) => x.inc === ep!.inc && x.r === ep!.r && x.dice);
          if (!roll && ep.offWait === undefined) return;
          if (roll) ep.roll = roll;
          got.push(ep);
          ep = null;
          if (r.mode !== 'up') {
            craps.moveTo(r, T, 3, sim.enter(r));
            await sim.reload(r);
          }
          rBack = true;
        });
        while (got.length < order.length && sim.elapsed < 20 * 60_000) await sim.run(5_000);
        await sim.run(30_000);
        sim.enter(nn);
        tn.unmount();
        // (After the crash the roll is taken back to betting GRACE_MAX_MS past
        // every close turn, and the newcomer's bet then opens a fresh window
        // and the gone holder's wait again: the stall measure counts from the
        // newcomer's felt, within the felts' budget.)
        const s = await finish(sim, lines);
        const byKind = new Map(got.map((g) => [g.kind, g]));
        console.log(`[craps] ${sim.label}: ${JSON.stringify(got.map((g) => ({ ...g, roll: g.roll ? `${g.roll.r} ${g.roll.decided} R ${g.roll.fates.get(r.pid)}` : undefined, chips: g.chips ? `${g.chips.before}+${g.chips.held}→${g.chips.after}` : undefined })))}`);
        expect(got.map((g) => g.kind), sim.label).toEqual(order);
        const N = (e: GoneEp, phase: string): string[] => nLines.get(`${e.inc}|${e.r}|${phase}`) ?? [];
        // 1. The goodbye: the window let go at once (betting with no end on
        // the newcomer's screen), so its bet after that window's end goes in
        // at the first try and starts the roll afresh; the roll then waits
        // out the gone holder ("PLAYER-R HAS GONE"), its bets playing as a
        // rider's.
        const bye = byKind.get('bye')!;
        expect(bye.letGo, sim.label).toBeDefined();
        expect(bye.letGo!, sim.label).toBeLessThan(bye.W!);
        expect(bye.answers, sim.label).toEqual({ ok: 1 });
        expect(bye.okDeadline, sim.label).toBe(bye.okAt! + croupier.CRAPS_BET_WINDOW_MS);
        expect(N(bye, 'closing').some((x) => x.startsWith(`✋ NO MORE BETS — ${nameOn(nn, r.pid)} HAS GONE · THE STICKMAN THROWS IN `)), `${sim.label} ${JSON.stringify(N(bye, 'closing'))}`).toBe(true);
        expect(bye.roll!.fates.get(r.pid), sim.label).toBe('rider');
        // 2. The crash: closed to the newcomer until betting reopened,
        // GRACE_MAX_MS after the last close turn (the shooter's wait, then two
        // turns: about 33 s after betting ended), "THE BETTORS HAVE GONE
        // QUIET" meanwhile; the house's switch-off during the wait refused.
        const crash = byKind.get('crash')!;
        const lastTurn = crash.W! + croupier.CRAPS_SHOOTER_MS + 2 * table.STAGGER_MS;
        // (No early let-go: betting shows no end only from the re-arm on.)
        expect(crash.letGo ?? Infinity, sim.label).toBeGreaterThanOrEqual(crash.stallUntil!);
        expect(crash.D, sim.label).toBe(crash.W! + croupier.CRAPS_SHOOTER_MS);
        expect(crash.stallUntil, sim.label).toBe(lastTurn + table.GRACE_MAX_MS);
        expect(crash.okAt! - lastTurn, sim.label).toBeGreaterThanOrEqual(table.GRACE_MAX_MS);
        expect(crash.okAt! - lastTurn, sim.label).toBeLessThanOrEqual(table.GRACE_MAX_MS + 2 * SIM_STEP);
        expect(crash.answers.closed ?? 0, sim.label).toBeGreaterThan(0);
        expect(N(crash, 'closing').some((x) => /^✋ NO MORE BETS — THE BETTORS HAVE GONE QUIET · BETTING REOPENS IN (10|[1-9])s$/.test(x)), `${sim.label} ${JSON.stringify(N(crash, 'closing'))}`).toBe(true);
        expect(crash.busy, sim.label).toBeGreaterThan(0);
        expect(crash.offWait, sim.label).toBeUndefined();
        // 3. The second crash: the switch-off refused during the wait, through
        // after it; every chip on the felt back to its player.
        const off = byKind.get('crash-off')!;
        expect(off.busy, sim.label).toBeGreaterThan(0);
        expect(off.offWait, sim.label).toBe(false);
        expect(off.chips!.held, sim.label).toBeGreaterThan(0n);
        expect(off.chips!.after, sim.label).toBe(off.chips!.before + off.chips!.held);
        // 4. The holder's goodbye during the wait, the newcomer's chips on the
        // roll: the switch-off press during the wait goes through.
        const byeWait = byKind.get('bye-wait')!;
        expect(byeWait.busy, sim.label).toBe(0);
        expect(byeWait.offWait, sim.label).toBe(true);
        expect(byeWait.chips!.after, sim.label).toBe(byeWait.chips!.before + byeWait.chips!.held);
        expect(s.rounds, sim.label).toBeGreaterThan(0);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🈵 full-of-gone-riders ───────────────────────────────────────────────────

describe('computed craps: full-of-gone-riders', () => {
  for (const n of SEEDS) {
    it(`full-of-gone-riders ${n}: 31 riders leave, a newcomer is told the table is full, and the house's second switch-off press hands the bets back`, async () => {
      uiDom();
      try {
        // 31 riders at the device front, each a pass on the first roll, which
        // their seeds make a 6 (a point: the pass can't come down); then R16 to
        // R30 leave with nothing on the next roll (no goodbye), R00 puts a
        // field bet on it, R01 to R15's pages join it (ride slips), and R00 to
        // R15 leave with a goodbye each. Gone riders hold their places, a
        // goodbye on the roll or none (design Q5).
        // N, the newcomer at stand 3 with its table UI up. H, the house.
        const riderSpecs: PageSpec[] = Array.from({ length: 31 }, (_, i) => ({ name: `R${String(i).padStart(2, '0')}`, place: null, crapsBot: QUIET }));
        const sim = await Sim.open({
          name: 'craps-full-of-gone-riders', seed: seed(2700 + n), tables: crapsTable,
          pages: [{ name: 'H', house: true, bot: null }, { name: 'N', place: 3, crapsBot: QUIET, onLoad: withTableUI }, ...riderSpecs],
        });
        const craps = sim.craps!;
        const [h, nn] = sim.pages;
        const riders = sim.pages.slice(2);
        const log = rollLog(sim, h);
        const inc0 = h.p.casino.computedIncOf(T)!;
        rigRoll(riders.map((sp) => sp.p), 1, 6, [], sim.ctxOf(T, inc0));
        sim.enter(nn);
        const tn = atCraps(nn.p as UIPage, { stand: 3, table: T });
        let step = 'bet' as 'bet' | 'join' | 'leave' | 'full' | 'off' | 'play' | 'done';
        const got = { full: 0, writerFull: 0, offs: [] as string[], before: 0n, held: 0n, after: 0n, pointOn: 0, rides: 0, plays: 0, joined: 0, byes: 0, byesOpen: 0, byesNone: -1 };
        let offAt = 0;
        sim.every(async () => {
          if (sim.healed) return;
          const now = sim.enter(h);
          const res = h.p.casino.computedFoldOf(T);
          if (!res) return;
          const k = res.carry as CrapsCarry;
          if (step === 'bet') {
            for (const sp of riders) await bet(sim, sp, (felt, point) => (point === null && amt(felt, 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null));
            if (k.p !== 0 && riders.every((sp) => amt(ridingOf(k, sp.pid), 'pass') === 10)) {
              got.pointOn = k.p;
              got.rides = Object.keys(k.w).length;
              const was = craps.stats.goodbyes;
              for (const sp of riders.slice(16)) await sim.leave(sp);
              got.byesNone = craps.stats.goodbyes - was;
              step = 'join';
            }
            return;
          }
          if (step === 'join') {
            // R00's field bet on the open roll (someone playing it): the other
            // riders' pages, off the table, put their riding bets down on it.
            const v = h.p.table.readComputedCraps(T, now);
            if (res.tip || v?.phase !== 'betting') return;
            await bet(sim, riders[0], (felt) => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null), 8_000);
            const rides = riders.slice(1, 16).filter((sp) => {
              const f = res.felts.get(sp.pid)?.rec as CrapsSlipRec | undefined;
              return f !== undefined && f.b.length > 0 && f.l !== 1;
            });
            if (amt(res.felts.get(riders[0].pid)?.rec.b as CrapsBet[] ?? [], 'field') > 0 && rides.length >= 10) {
              got.joined = rides.length;
              step = 'leave';
            }
            return;
          }
          if (step === 'leave') {
            const was = craps.stats.goodbyes;
            for (const sp of riders.slice(0, 16)) await sim.leave(sp);
            got.byes = craps.stats.goodbyes - was;
            step = 'full';
            return;
          }
          if (step === 'full') {
            // Every rider gone; the newcomer's press on its table UI, and its
            // write: the table is full (the riders hold all 31 places).
            if (riders.some((sp) => sp.mode !== 'gone') || !craps.fullFor(nn, T)) return;
            // (The gone riders' goodbyes on the roll N writes on.)
            got.byesOpen = riders.filter((sp) => (res.felts.get(sp.pid)?.rec as CrapsSlipRec | undefined)?.l === 1).length;
            const nNow = sim.enter(nn);
            const v = nn.p.table.readComputedCraps(T, nNow);
            if (!v || v.phase !== 'betting') return;
            const { basis } = nn.p.table.readMyComputedCrapsBets(T, nn.pid, v.round, nNow);
            tn.key('0');
            tn.key('2');
            craps.press(nn, T, v.round, null, basis, () => tn.click('field'));
            const said = tn.said();
            tn.key('0');
            if (said === 'THE TABLE IS FULL — WAIT FOR A PLACE') got.full += 1;
            else sim.violate(`N's press at the full table at ${sim.elapsed} ms said ${JSON.stringify(said)}`);
            const list = [{ type: 'field' as const, amount: 5 }];
            const w = craps.press(nn, T, v.round, list, basis, () => nn.p.table.writeComputedCrapsSlip(T, list, basis, nNow));
            if (w === 'full') got.writerFull += 1;
            else sim.violate(`N's write at the full table at ${sim.elapsed} ms answered ${w}`);
            step = 'off';
            return;
          }
          if (step === 'off') {
            // The house's switch-off: the first press warns (contract bets
            // riding), the second hands every bet back.
            const first = h.p.table.switchComputedOff(T, now);
            got.offs.push(first);
            if (first !== 'contract') {
              if (first === 'ok') sim.violate(`the switch-off at ${sim.elapsed} ms went with no warning, 31 pass bets riding`);
              return;
            }
            got.held = [...res.held.values()].reduce((m, x) => m + x, 0n);
            got.before = riders.reduce((m, sp) => m + BigInt(h.p.casino.readChips(sp.pid)), 0n);
            const second = h.p.table.switchComputedOff(T, now, true);
            got.offs.push(`again:${second}`);
            if (second !== 'ok') return;
            got.after = riders.reduce((m, sp) => m + BigInt(h.p.casino.readChips(sp.pid)), 0n);
            const on = h.p.table.switchComputedOn(T, 'craps', now);
            if (on !== 'ok') sim.violate(`the switch-on at ${sim.elapsed} ms answered ${on}`);
            offAt = sim.elapsed;
            step = 'play';
            return;
          }
          if (step === 'play') {
            // The newcomer plays the fresh table (the table is free again),
            // once its page has heard the switch.
            sim.enter(nn);
            const nInc = nn.p.casino.computedIncOf(T);
            if (nInc && nInc !== inc0) await bet(sim, nn, (felt) => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null));
            got.plays = log.filter((x) => x.dice && x.inc !== inc0 && x.at > offAt).length;
            if (got.plays >= 3) step = 'done';
          }
        });
        while (step !== 'done' && sim.elapsed < 15 * 60_000) await sim.run(5_000);
        sim.enter(nn);
        tn.unmount();
        const s = await finish(sim, lines, { bettors: 32 });
        console.log(`[craps] ${sim.label}: ${JSON.stringify(got, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}, rolls ${s.rounds}`);
        expect(step, sim.label).toBe('done');
        expect(got.pointOn, sim.label).not.toBe(0);
        expect(got.rides, sim.label).toBe(31);
        expect(got.byesNone, sim.label).toBe(0);
        expect(got.joined, sim.label).toBeGreaterThanOrEqual(10);
        expect(got.byes, sim.label).toBeGreaterThanOrEqual(11);
        expect(got.byesOpen, sim.label).toBe(got.byes);
        expect(got.full, sim.label).toBe(1);
        expect(got.writerFull, sim.label).toBe(1);
        expect(got.offs, sim.label).toEqual(['contract', 'again:ok']);
        expect(got.held, sim.label).toBe(310n);
        expect(got.after, sim.label).toBe(got.before + got.held);
        expect(got.plays, sim.label).toBeGreaterThanOrEqual(3);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🔄 reload-rider ──────────────────────────────────────────────────────────

type ReloadCase = 'same' | 'down' | 'new' | 'wait' | 'waitLate' | 'later' | 'lone' | 'comeout';

/** A rider's case: the roll it reloads on, the felt and chips it must see
 *  back (its page's own reading before the reload), and what it saw. */
interface RiderCase { kind: ReloadCase; inc: string; r: number; felt: string; chips: number; reloaded: boolean; seen?: { felt: string; chips: number; debt: boolean } }
/** A shooter's case: the roll (chosen as betting opens), the chips the
 *  shooter has with only its riding bets down, whether a re-arm showed, the
 *  wait's end and the close as the house's page saw them, the flings since
 *  the reload, and the roll as decided with the chips in hand after it. */
interface ShooterCase {
  kind: ReloadCase; inc: string; r: number; chips: number; reloaded: boolean; flings: number; rearm: boolean; hD?: number; hClose?: number; back: boolean;
  roll?: Roll; flung?: number; chipsAfter?: number;
  /** How far into the wait (from the end of betting) its page reloaded. */
  reloadIn?: number;
}

describe('computed craps: reload-rider', () => {
  for (const n of SEEDS) {
    it(`reload-rider ${n}: riders reload mid-point (same felt; a take-down stays down, no debt; a new bet's chips back) and a shooter reloads during the wait (with a second bettor: no throw, counted at the stand if back before the close; alone: throws after all; on a come-out with only a new bet: loses the dice)`, async () => {
      // S, the shooter at stand 3 (a pass on each come-out, odds twice the flat
      // once the point is on, a field bet on a point with no pass), throws
      // 5–10 s into its wait. O, the second
      // bettor at the device front, bets when a case says. B, the rider at the
      // device front, with 200 chips. H, the house's page.
      const sim = await Sim.open({
        name: 'craps-reload-rider', seed: seed(2800 + n), tables: crapsTable,
        pages: [
          { name: 'H', house: true, bot: null },
          { name: 'S', place: 3, crapsBot: { ...QUIET, fling: [5_000, 10_000] } },
          { name: 'O', place: null, crapsBot: QUIET },
          { name: 'B', place: null, crapsBot: QUIET, chips: 200 },
        ],
      });
      const craps = sim.craps!;
      const [h, sh, o, b] = sim.pages;
      const log = rollLog(sim, h);
      const { croupier } = h.p;
      const bOrder: ReloadCase[] = ['same', 'down', 'new'];
      const sOrder: ReloadCase[] = ['wait', 'waitLate', 'later', 'lone', 'comeout'];
      const riderDone = new Map<ReloadCase, RiderCase>();
      const shooterDone = new Map<ReloadCase, ShooterCase>();
      let bGone = false;
      let bc: RiderCase | null = null;
      let sc: ShooterCase | null = null;
      let retries = 0;
      const ownChips = (sp: SimPage): number => {
        sim.enter(sp);
        return sp.p.casino.readChips(sp.pid);
      };
      sim.every(async () => {
        if (sim.healed) return;
        sim.enter(h);
        const inc = h.p.casino.computedIncOf(T)!;
        const res = h.p.casino.computedFoldOf(T);
        if (!res) return;
        const k = res.carry as CrapsCarry;
        const hv = h.p.table.readComputedCraps(T, sim.enter(h));
        // ── A shooter's case, chosen as betting opens on a roll S holds the
        // dice for, in play (B gone): a come-out for 'comeout' (S's riding
        // bets none, its pass new), a point on for the others (its pass
        // riding: alone, a come-out's goodbye would leave nothing on the roll
        // to throw for).
        if (!sc && bGone && shooterDone.size < sOrder.length && hv?.phase === 'betting' && hv.round === res.open && !res.tip
          && k.h === sh.pid && k.i === 1 && !res.felts.has(o.pid)) {
          const left = sOrder.filter((x) => !shooterDone.has(x));
          const riding = ridingOf(k, sh.pid).length > 0;
          const kind = k.p === 0
            ? (riding ? undefined : left.find((x) => x === 'comeout'))
            : (riding ? left.find((x) => x === 'wait' || x === 'waitLate' || x === 'later' || x === 'lone') : undefined);
          const mine = (res.felts.get(sh.pid)?.rec.b ?? []) as CrapsBet[];
          if (kind) {
            sc = {
              kind, inc, r: res.open, reloaded: false, flings: 0, rearm: false, back: false,
              chips: h.p.casino.readChips(sh.pid) + sumOf(mine) - sumOf(ridingOf(k, sh.pid)),
            };
            // (Late in the wait: S's own throw held off this roll until its
            // page reloads, as a player who hasn't thrown yet.)
            if (kind === 'waitLate') sh.spec.botTables = [];
          }
        }
        // S's play (not on its case's roll once it has reloaded: the case is
        // what its goodbye left).
        if (!(sc && sc.reloaded)) {
          await bet(sim, sh, (felt, point) => {
            const pass = amt(felt, 'pass');
            if (point === null) return pass === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
            if (pass > 0) return amt(felt, 'passodds') === 0 ? [...felt, { type: 'passodds', amount: 2 * pass }] : null;
            // (No pass on a point it came to without one: a field bet, which
            // never rides, keeps it throwing.)
            return amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null;
          });
        }
        // O's field bet on a case's roll with a second bettor.
        if (sc && sc.inc === inc && sc.r === res.open && sc.kind !== 'lone' && !sc.reloaded) await bet(sim, o, (felt) => (amt(felt, 'field') === 0 ? [...felt, { type: 'field', amount: 5 }] : null));
        if (bGone) return;
        // ── B's cases.
        if (bc && bc.reloaded) {
          // B back: once its page has caught up and shows the same roll taking
          // bets, the felt it sees and its chips (its own page's reading).
          if (inc !== bc.inc || res.open !== bc.r) {
            // (The roll was played before B's page showed it again: again.)
            retries += 1;
            bc = null;
            return;
          }
          if (res.tip || !caughtUp(sim, b, h)) return;
          const now = sim.enter(b);
          const v = b.p.table.readComputedCraps(T, now);
          if (v?.phase !== 'betting' || v.round !== bc.r) return;
          bc.seen = { felt: canonText(b.p.table.readMyComputedCrapsBets(T, b.pid, v.round, now).felt), chips: b.p.casino.readChips(b.pid), debt: sim.debts.has(b.pid) };
          riderDone.set(bc.kind, bc);
          bc = null;
          return;
        }
        // B's play while its cases run: a pass on the come-out, place 6 and 8.
        await bet(sim, b, (felt, point) => {
          if (point === null) return amt(felt, 'pass') === 0 && amt(ridingOf(k, b.pid), 'pass') === 0 ? [...felt, { type: 'pass', amount: 10 }] : null;
          if (amt(felt, 'place', 6) === 0 && !riderDone.has('down')) return [...felt, { type: 'place', pick: 6, amount: 12 }];
          if (amt(felt, 'place', 8) === 0) return [...felt, { type: 'place', pick: 8, amount: 12 }];
          return null;
        });
        const kind = bOrder.find((x) => !riderDone.has(x));
        if (!kind) {
          // Done: B leaves (a goodbye), its bets riding on as a gone rider's.
          const v = b.p.table.readComputedCraps(T, sim.enter(b));
          if (v?.phase !== 'betting' || res.tip) return;
          await sim.leave(b);
          bGone = true;
          return;
        }
        // Mid-point, its riding bets on and its ride slip its latest, betting
        // open 10–14 s before its end (its ride slip seconds old: no change
        // held back to go with the coalescing).
        const C = ridingOf(k, b.pid);
        const f = res.felts.get(b.pid);
        const now = sim.enter(b);
        const v = b.p.table.readComputedCraps(T, now);
        if (k.p === 0 || res.tip || !f || canonText(f.rec.b as CrapsBet[]) !== canonText(C) || amt(C, 'pass') === 0 || amt(C, 'place', 8) === 0) return;
        if (kind !== 'new' && amt(C, 'place', 6) === 0) return;
        if (v?.phase !== 'betting' || v.round !== res.open || v.phaseDeadline === undefined || now < v.phaseDeadline - 14_000 || now >= v.phaseDeadline - 10_000) return;
        let chipsBefore = ownChips(b);
        if (kind === 'down') {
          // The place 6 comes down (its chips back to B), then the reload.
          const a = await bet(sim, b, (felt) => felt.filter((x) => !(x.type === 'place' && x.pick === 6)));
          const mine = b.p.casino.computedFoldOf(T)?.felts.get(b.pid);
          if (a !== 'ok' || !mine || amt(mine.rec.b as CrapsBet[], 'place', 6) !== 0) return;
          chipsBefore = ownChips(b);
        } else if (kind === 'new') {
          // A new bet with every chip B has, then the reload.
          const all = chipsBefore;
          const a = await bet(sim, b, (felt) => [...felt, { type: 'field', amount: all }]);
          const mine = b.p.casino.computedFoldOf(T)?.felts.get(b.pid);
          if (a !== 'ok' || !mine || amt(mine.rec.b as CrapsBet[], 'field') !== all) return;
          if (ownChips(b) !== 0) sim.violate(`B's field bet of all its ${all} chips leaves ${ownChips(b)}`);
        }
        const now2 = sim.enter(b);
        // What it must see back: the felt as it stood before this roll's new
        // chips (a take-down stays down), and the chips that leaves it.
        const felt = b.p.table.readMyComputedCrapsBets(T, b.pid, res.open, now2).felt;
        bc = { kind, inc, r: res.open, felt: canonText(kind === 'new' ? felt.filter((x) => x.type !== 'field') : felt), chips: chipsBefore, reloaded: false };
        await sim.reload(b, { goodbye: true });
        bc.reloaded = true;
      });
      // The shooter's reload: in the wait for its throw, 0.5–2.5 s in, before
      // its fling (waitLate: 18–19.5 s in, its throw held off till then, back
      // before the others close at the wait's end, 20 s in, but its own show
      // of the roll before, 6 s from its load, running past their close); for 'later' off
      // the table first, back at its stand once its page has the close.
      sim.every(async () => {
        if (!sc || sim.healed) return;
        const inc = h.p.casino.computedIncOf(T);
        const res = h.p.casino.computedFoldOf(T)!;
        if (inc !== sc.inc) {
          delete sh.spec.botTables;
          sc = null;
          return;
        }
        const hNow = sim.enter(h);
        const hv = h.p.table.readComputedCraps(T, hNow);
        if (hv?.round === sc.r && hv.phase === 'closing' && hv.phaseDeadline !== undefined) sc.hD = hv.phaseDeadline;
        if (hv?.round === sc.r && hv.rearmAt !== undefined && sc.reloaded) sc.rearm = true;
        if (sc.hClose === undefined && (res.tip?.r === sc.r || res.rounds.some((x) => x.r === sc!.r))) sc.hClose = hNow;
        if (!sc.reloaded) {
          if (sh.mode !== 'up') return;
          const now = sim.enter(sh);
          const v = sh.p.table.readComputedCraps(T, now);
          const W = v?.phaseDeadline !== undefined ? v.phaseDeadline - croupier.CRAPS_SHOOTER_MS : 0;
          if (res.open !== sc.r) {
            delete sh.spec.botTables;
            sc = null;
            return;
          }
          const [from, to] = sc.kind === 'waitLate' ? [18_000, 19_500] : [500, 2_500];
          if (v?.round !== sc.r || v.phase !== 'closing' || v.phaseDeadline === undefined || now < W + from || now >= W + to) return;
          if (sc.kind !== 'lone' && (res.felts.get(o.pid)?.rec.b.length ?? 0) === 0) {
            delete sh.spec.botTables;
            sc = null;
            return;
          }
          if (sc.kind === 'later') craps.moveTo(sh, T, 'off', now);
          sc.flings = craps.stats.flings;
          sc.reloadIn = now - W;
          await sim.reload(sh, { goodbye: true });
          delete sh.spec.botTables;
          sc.reloaded = true;
          return;
        }
        if (sc.kind === 'later' && !sc.back && sh.p.casino.computedFoldOf(T)?.tip?.r === sc.r) {
          craps.moveTo(sh, T, 3, sim.enter(sh));
          sc.back = true;
        }
        const roll = log.find((x) => x.inc === sc!.inc && x.r === sc!.r && x.dice);
        if (!roll) return;
        if (sc.kind === 'later' && !sc.back) {
          craps.moveTo(sh, T, 3, sim.enter(sh));
          sc.back = true;
        }
        sc.roll = roll;
        sc.flung = craps.stats.flings - sc.flings;
        sc.chipsAfter = h.p.casino.readChips(sh.pid);
        shooterDone.set(sc.kind, sc);
        sc = null;
      });
      while (shooterDone.size < sOrder.length && sim.elapsed < 25 * 60_000) await sim.run(5_000);
      const s = await finish(sim, lines);
      const say = (x: Roll | undefined): string => (x ? `${x.r} ${x.sIn.h === sh.pid ? 'S' : x.sIn.h ?? 'stickman'}→${x.sOut.h === sh.pid ? 'S' : x.sOut.h ?? 'stickman'}${x.sOut.i ? ' in play' : ''} p ${x.pointBefore}→${x.pointAfter} by ${sim.pages.find((q) => q.p.pub === x.closer)?.name}` : 'none');
      console.log(`[craps] ${sim.label}: riders ${JSON.stringify([...riderDone.values()].map((x) => ({ kind: x.kind, r: x.r, want: [x.felt, x.chips], seen: x.seen })))}, shooters ${JSON.stringify([...shooterDone.values()].map((x) => ({ kind: x.kind, roll: say(x.roll), flung: x.flung, chips: [x.chips, x.chipsAfter], rearm: x.rearm, close: (x.hClose ?? 0) - (x.hD ?? 0), reloadIn: x.reloadIn })))}, retries ${retries}, rolls ${s.rounds}`);
      expect([...riderDone.keys()], sim.label).toEqual(bOrder);
      expect([...shooterDone.keys()].sort(), sim.label).toEqual([...sOrder].sort());
      // A rider who reloads mid-point sees the same felt; one who took a bet
      // down still has it down, its chips where the take-down left them (no
      // debt); one who placed a new bet gets that bet's chips back.
      for (const x of riderDone.values()) {
        expect(x.seen!.felt, `${sim.label} ${x.kind}`).toBe(x.felt);
        expect(x.seen!.chips, `${sim.label} ${x.kind}`).toBe(x.chips);
        expect(x.seen!.debt, `${sim.label} ${x.kind}`).toBe(false);
        expect(x.seen!.chips, `${sim.label} ${x.kind}`).toBeGreaterThanOrEqual(0);
      }
      const felt = (kind: ReloadCase): CrapsBet[] => JSON.parse(riderDone.get(kind)!.seen!.felt) as CrapsBet[];
      expect(amt(felt('same'), 'place', 6), sim.label).toBe(12);
      expect(amt(felt('down'), 'place', 6), sim.label).toBe(0);
      expect(amt(felt('down'), 'place', 8), sim.label).toBe(12);
      expect(amt(felt('new'), 'field'), sim.label).toBe(0);
      expect(riderDone.get('new')!.seen!.chips, sim.label).toBeGreaterThan(0);
      const S = (kind: ReloadCase): ShooterCase & { roll: Roll } => shooterDone.get(kind) as ShooterCase & { roll: Roll };
      // With a second bettor on the roll, the shooter who reloads in the wait
      // can't throw that roll: O's page closes it once the wait is over (the
      // stickman's throw); its page back at the stand before that, with the
      // goodbye written again, the shooter is counted there and keeps the dice.
      const wait = S('wait');
      expect(wait.flung, sim.label).toBe(0);
      expect(wait.roll.closer, sim.label).toBe(o.p.pub);
      expect(wait.hClose! - wait.hD!, sim.label).toBeGreaterThanOrEqual(0);
      expect(wait.roll.pointBefore, sim.label).not.toBeNull();
      expect(wait.roll.slips.get(sh.pid)?.t, sim.label).toBe(3);
      expect(wait.roll.counted, sim.label).toContain(sh.pid);
      expect(wait.roll.sOut.h, sim.label).toBe(sh.pid);
      expect(wait.roll.sOut.i, sim.label).toBe(1);
      // The same with its page back 18–19.5 s into the 20 s wait, its throw
      // not made: its goodbye goes again at once, during its own show of the
      // roll before and the wait, whatever its view reads (design v5-AS2), so
      // it is counted at its stand and keeps the dice. (A page that put it
      // back only once its betting opened again, 6 s from its load, past O's
      // close at the wait's end, would be left out of that close and lose
      // them. Back 15–17 s in, that page too would be in time: R2.)
      const late = S('waitLate');
      expect(late.reloadIn!, sim.label).toBeGreaterThanOrEqual(18_000);
      // (Its own show, 6 s from its load, ends past the wait's end.)
      expect(late.reloadIn! + croupier.CRAPS_SHOW_MS, sim.label).toBeGreaterThan(croupier.CRAPS_SHOOTER_MS + (late.hClose! - late.hD!));
      expect(late.flung, sim.label).toBe(0);
      expect(late.roll.closer, sim.label).toBe(o.p.pub);
      expect(late.hClose! - late.hD!, sim.label).toBeGreaterThanOrEqual(0);
      expect(late.roll.pointBefore, sim.label).not.toBeNull();
      expect(late.roll.slips.get(sh.pid)?.t, sim.label).toBe(3);
      expect(late.roll.counted, sim.label).toContain(sh.pid);
      expect(late.roll.sOut.h, sim.label).toBe(sh.pid);
      expect(late.roll.sOut.i, sim.label).toBe(1);
      // Back at the stand only after the close: not counted there (in play no
      // more), the dice kept only while the point stays on.
      const later = S('later');
      expect(later.flung, sim.label).toBe(0);
      expect(later.roll.closer, sim.label).toBe(o.p.pub);
      expect(later.roll.slips.has(sh.pid), sim.label).toBe(true);
      expect(later.roll.slips.get(sh.pid)?.t, sim.label).toBeUndefined();
      expect(later.roll.sOut.i, sim.label).toBeUndefined();
      expect(later.roll.sOut.h === sh.pid, sim.label).toBe(later.roll.pointBefore !== null && later.roll.pointAfter !== null);
      // Alone, the shooter's goodbye frees the roll, its reloaded page starts
      // it again, and it throws it after all and keeps the dice.
      const lone = S('lone');
      expect(lone.rearm, sim.label).toBe(true);
      expect(lone.flung!, sim.label).toBeGreaterThan(0);
      expect(lone.roll.closer, sim.label).toBe(sh.p.pub);
      expect(lone.roll.sOut.h, sim.label).toBe(sh.pid);
      expect(lone.roll.sOut.i, sim.label).toBe(1);
      // On a come-out with only a new bet down, the second bettor's page
      // closing: the bet back to the shooter, the dice lost.
      const comeout = S('comeout');
      expect(comeout.roll.pointBefore, sim.label).toBeNull();
      expect(comeout.roll.closer, sim.label).toBe(o.p.pub);
      expect(comeout.flung, sim.label).toBe(0);
      expect(sumOf(comeout.roll.slips.get(sh.pid)?.b ?? []), sim.label).toBe(0);
      expect(comeout.roll.sOut.h, sim.label).not.toBe(sh.pid);
      expect(comeout.chipsAfter, sim.label).toBe(comeout.chips);
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});
