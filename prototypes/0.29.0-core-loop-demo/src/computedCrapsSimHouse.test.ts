/**
 * 🧪🎲🌐 Computed craps over the simulated network: the house's side of a
 * room (computedCrapsSimPlay.test.ts's harness, computedCrapsSimKit's
 * finish): what a modified page can do at the table and what it can't,
 * older builds in the room, and a room shared with a roulette table.
 *
 * - cheats: forged felts that break a table rule (a contract take-down, a
 *   don't pass mid-point, a pass line put up while a point is on: ignored
 *   and flagged); the end mark written mid-point; empty slips for made-up
 *   players plus a forced void (the next roll isn't full); 31 made-up
 *   riders that fill the table (a newcomer refused, the card naming them,
 *   the house's second switch-off press freeing it); a page that holds the
 *   window; a seed dropper and a re-drawer (their rates measured). The
 *   rest of the design's list is the full table's (computedCrapsSimRoom
 *   full: a forged don't come on a number, flagged; a stale stamp, not
 *   flagged; a 32nd bettor refused by the writer and left out by the fold)
 *   and the baseline's (computedCrapsSimPlay: the honest page's tries, each
 *   refused by its writer).
 * - old-build-ghost and pr2-ghost: an older build's owner-run roll on the
 *   computed table is cleared away, its bets back and what it paid
 *   standing; a page shaped like PR 2's never ends the table, except by
 *   removing it.
 * - mixed-room: a roulette and a craps table share the room's size budget.
 *
 * Each scenario runs three seeds (seed bases of its own) through the shared
 * finish and asserts what the design says it must show, with counters that
 * prove the case happened on every seed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastDecided, Sim } from './computedSim';
import type { SimPage } from './computedSim';
import { CRAPS_BOT, canonList } from './computedCrapsSim';
import { T, TIMEOUT, finish, named, seed } from './computedCrapsSimKit';
import { atCraps, stubDom, withUI } from './computedCrapsUiKit';
import type { UIPage } from './computedCrapsUiKit';
import { putIn, signAs, tagSeed } from './computedPageKit';
import type { Page } from './computedPageKit';
import { basisOf, diceOf, own, TRIM_SEVEN_OUT_MIN } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
import { seedTable } from './computedFold';
import { REVEAL_GRACE_MS } from './fairTableSeeds';
import type { Checkpoint, CloseRec, CrapsSlipRec, FoldCtx, FoldResult, RoundView } from './computedFold';
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

const pass = (amount: number): CrapsBet => ({ type: 'pass', amount });
const field = (amount: number): CrapsBet => ({ type: 'field', amount });
const isContract = (b: CrapsBet, point: number): boolean => (b.type === 'pass' && point !== 0) || (b.type === 'come' && b.pick !== undefined);

/** A player whose bets the scenario writes: no moves, tries or stand moves
 *  of its own; it still throws the dice it is offered. */
const SCRIPTED = { ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0 };

/** The table UI's modules on every load (computedCrapsUiKit withUI), and a
 *  DOM whose timers do nothing: the sim drives the UI by hand. */
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

/** The scenario's bettors' felts: each roll (once, while betting is open and
 *  3 s or more before its end), `want` gives page sp's whole felt for roll
 *  r (null: as it stands), written through the felt's writer as a press
 *  (computedCrapsSim press); the writer's answers counted by kind ('ok',
 *  'full', ...; any other than these and 'closed' or 'reconnecting' is a
 *  violation). */
function bettors(sim: Sim, pages: SimPage[], want: (sp: SimPage, r: number, felt: CrapsBet[], point: number | null) => CrapsBet[] | null, allow: string[] = []): Record<string, number> {
  const answers: Record<string, number> = {};
  const done = new Set<string>();
  sim.every(async () => {
    if (sim.healed) return;
    for (const sp of pages) {
      if (sp.mode !== 'up' || sim.T < sp.pauseUntil) continue;
      await sim.as(sp, (now) => {
        const { table } = sp.p;
        const v = table.readComputedCraps(T, now);
        if (!v || v.phase !== 'betting' || (v.phaseDeadline !== undefined && now >= v.phaseDeadline - 3_000)) return;
        const key = `${v.inc}|${v.round}|${sp.name}`;
        if (done.has(key)) return;
        const { felt, basis } = table.readMyComputedCrapsBets(T, sp.pid, v.round, now);
        const next = want(sp, v.round, felt, v.point ?? null);
        if (next === null) return;
        const res = sim.craps!.press(sp, T, v.round, next, basis, () => table.writeComputedCrapsSlip(T, next, basis, now));
        answers[res] = (answers[res] ?? 0) + 1;
        if (res === 'ok' || allow.includes(res)) done.add(key);
        else if (res !== 'closed' && res !== 'reconnecting') sim.violate(`${sp.name}'s felt ${JSON.stringify(next)} on roll ${v.round} at ${sim.elapsed} ms answered ${res}`);
      });
    }
  });
  return answers;
}

// ── 🃏 A cheat's hand ────────────────────────────────────────────────────────

/**
 * Page x, a modified page with no frames of its own (its records written
 * by hand, as computedCrapsSimRoom's ghosts write theirs): slips, closes,
 * reveals and forfeits signed with its own key, for its own player or any
 * pid it names; the seeds of its slips kept, to reveal when it chooses.
 */
class Cheat {
  /** Slip hash → the seed its commitment seals. */
  readonly seeds = new Map<string, string>();
  private readonly ver = new Map<string, number>();
  constructor(readonly sim: Sim, readonly x: SimPage) {
    x.cheats = true;
    x.beforeFrame = () => false;
  }

  get pid(): string {
    return this.x.pid;
  }

  ctx(): FoldCtx {
    return this.sim.ctxOf(T, this.x.p.casino.computedIncOf(T)!);
  }

  fold(): FoldResult | null {
    return this.x.p.casino.computedFoldOf(T);
  }

  /** A slip version of pid's on roll r: felt b on stamp o, under `seed`
   *  (default: a fresh one per version). Its key, hash and seed. */
  slip(r: number, pid: string, b: CrapsBet[], o: string, seed?: string): { key: string; hash: string; seed: string } {
    const ctx = this.ctx();
    const k = `${ctx.inc}|${r}|${pid}`;
    const v = (this.ver.get(k) ?? 0) + 1;
    this.ver.set(k, v);
    const s = seed ?? tagSeed(`${ctx.inc}:${pid}:${r}:${v}`);
    const c = this.x.p.fold.slipCommit(ctx, r, pid, s);
    const rec = signAs(this.x.p, 'slip', { r, p: pid, v, b: canonList(b), o, c }, ctx) as unknown as CrapsSlipRec;
    const key = this.x.p.fold.slipKeyFor(ctx)(rec)!;
    const hash = key.slice(key.lastIndexOf(':') + 1);
    this.seeds.set(hash, s);
    putIn(this.x.p, [[key, rec]], T);
    return { key, hash, seed: s };
  }

  /** The seed of pid's slip `hash` on roll r, out. */
  reveal(r: number, pid: string, hash: string): void {
    const s = this.seeds.get(hash);
    if (!s) return;
    const xr = { r, p: pid, s };
    putIn(this.x.p, [[this.x.p.fold.revealKey(xr)!, xr]], T);
  }

  /** A close of roll r on parent q freezing `f` (pid → slip hash). */
  close(r: number, q: string, f: Record<string, string>): { key: string; hash: string } {
    const rec = signAs(this.x.p, 'close', { r, q, f }, this.ctx()) as unknown as CloseRec;
    const key = this.x.p.fold.closeKey(rec)!;
    putIn(this.x.p, [[key, rec]], T);
    return { key, hash: this.x.p.fold.recHash(rec)! };
  }

  /** A forfeit of close `x` on roll r counting `n`. */
  forfeit(r: number, x: string, n: string[]): string {
    const rec = signAs(this.x.p, 'forfeit', { r, x, n: [...new Set(n)].sort() }, this.ctx());
    const key = this.x.p.fold.forfeitKey(rec as never)!;
    putIn(this.x.p, [[key, rec]], T);
    return key;
  }

  /** The seeds out for round v's frozen slips, as this page's session holds
   *  them (pid → seed; each opens its frozen slip's commitment). */
  seedsOf(v: RoundView): Map<string, string> {
    const ctx = this.ctx();
    const ses = this.x.p.casino.computedSessionForWrite(T);
    const out = new Map<string, string>();
    if (!ses) return out;
    for (const [pid, h] of Object.entries(v.frozen)) {
      const slip = ses.get(`s:${v.r}:${pid}:${h}`) as CrapsSlipRec | undefined;
      if (!slip) continue;
      for (const key of ses.keys()) {
        if (!key.startsWith(`x:${v.r}:${pid}:`)) continue;
        const s = (ses.get(key) as { s: string }).s;
        if (this.x.p.fold.slipCommit(ctx, v.r, pid, s) === slip.c) out.set(pid, s);
      }
    }
    return out;
  }

  /** The closes of the open roll in (the tip's, the open ones). */
  closesIn(res: FoldResult): CloseRec[] {
    return [res.tip?.closeRec, ...res.openCloses.map((o) => o.rec)].filter((c): c is CloseRec => !!c);
  }
}

/** Page sp's view of T now: betting on roll r with at least `ms` to go. */
function bettingFor(sim: Sim, sp: SimPage, ms: number): { r: number; left: number } | null {
  if (sp.mode !== 'up') return null;
  const now = sim.enter(sp);
  const v = sp.p.table.readComputedCraps(T, now);
  if (!v || v.phase !== 'betting' || v.phaseDeadline === undefined || v.phaseDeadline - now < ms) return null;
  return { r: v.round, left: v.phaseDeadline - now };
}

/** The roll page sp's fold of T has open now (0 with none). */
function openRoll(sim: Sim, sp: SimPage): number {
  sim.enter(sp);
  return sp.p.casino.computedFoldOf(T)?.open ?? 0;
}

/** Roll r as page sp's fold has it decided now (null: not yet, or gone). */
function decidedOn(sim: Sim, sp: SimPage, r: number): RoundView | null {
  sim.enter(sp);
  const res = sp.p.casino.computedFoldOf(T);
  return res?.rounds.find((v) => v.r === r && v.decided !== null) ?? null;
}

// ── 🚫 Forged felts ──────────────────────────────────────────────────────────

describe('computed craps: forged felts', () => {
  for (const n of SEEDS) {
    it(`forged ${n}: a modified page takes its pass down on a point, puts a don't pass up mid-point and adds to its pass line on a point; each felt is ignored (its bets play as they stood) and the card flags it`, async () => {
      const sim = await Sim.open({
        name: 'craps-forged', seed: seed(2100 + n), tables: crapsTable,
        pages: [...named('ABC'), { name: 'X', honest: false, bot: null, place: 'off' }],
      });
      const craps = sim.craps!;
      const [a] = sim.pages;
      const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
      type Kind = 'takedown' | 'dontpass' | 'passup';
      const kinds: Kind[] = ['takedown', 'dontpass', 'passup'];
      // Each forged felt: the roll, what it broke, the bets riding under it.
      const forged = new Map<number, { kind: Kind; C: CrapsBet[]; point: number; hash: string }>();
      const done = new Map<Kind, number>(kinds.map((k) => [k, 0]));
      const wrote = new Set<number>();
      let turn = 0;
      sim.every(async () => {
        if (sim.healed || cheat.x.mode !== 'up') return;
        const at = bettingFor(sim, a, 4_000);
        await sim.as(cheat.x, () => {
          const res = cheat.fold();
          if (!res) return;
          // Its seed out at once for any close that froze its slip.
          for (const c of cheat.closesIn(res)) if (c.f[cheat.pid]) cheat.reveal(c.r, cheat.pid, c.f[cheat.pid]);
          if (res.tip || !at || at.r !== res.open || wrote.has(res.open)) return;
          // Only on a roll an honest page will close (chips of its own on it).
          if (![...res.felts.values()].some((f) => f.rec.p !== cheat.pid && f.rec.b.length > 0)) return;
          const r = res.open;
          const carry = res.carry as CrapsCarry;
          const C = own(carry.w, cheat.pid);
          const o = basisOf(carry, cheat.pid);
          const pl = C.find((b) => b.type === 'pass');
          wrote.add(r);
          if (carry.p === 0) {
            // A come-out: its pass, honestly.
            if (!pl) cheat.slip(r, cheat.pid, [...C, pass(10)], o);
            return;
          }
          if (!pl) return;
          // A point on and its pass riding: the next cheat in turn.
          const kind = kinds[turn++ % kinds.length];
          const b = kind === 'takedown' ? C.filter((x) => x !== pl)
            : kind === 'dontpass' ? [...C, { type: 'dontpass', amount: 5 } as CrapsBet]
              : C.map((x) => (x === pl ? pass(pl.amount + 5) : x));
          const { hash } = cheat.slip(r, cheat.pid, b, o);
          forged.set(r, { kind, C, point: carry.p, hash });
        });
      });
      // Until each cheat has been played on a roll (6 minutes at most).
      const played = new Map<number, { kind: Kind; fate: string | undefined; flagged: boolean; stake: bigint | undefined; C: number; frozen: boolean }>();
      const count = (): void => {
        for (const [r, f] of forged) {
          if (played.has(r)) continue;
          const v = decidedOn(sim, a, r);
          if (!v) continue;
          const inc = a.p.casino.computedIncOf(T)!;
          played.set(r, {
            kind: f.kind, fate: v.craps?.fates.get(cheat.pid), flagged: craps.flagged.has(`${T}|${inc}|${r}|${cheat.pid}`),
            stake: v.stakes.get(cheat.pid), C: f.C.reduce((m, b) => m + b.amount, 0), frozen: v.frozen[cheat.pid] === f.hash,
          });
          if (v.frozen[cheat.pid] === f.hash) done.set(f.kind, done.get(f.kind)! + 1);
        }
      };
      for (let i = 0; i < 36 && kinds.some((k) => done.get(k)! === 0); i++) {
        await sim.run(10_000);
        count();
      }
      const s = await finish(sim, lines, { bettors: 4 });
      count();
      console.log(`[craps] ${sim.label}: forged ${JSON.stringify([...played].map(([r, p]) => ({ r, ...p, stake: p.stake?.toString() })))}`);
      // Each cheat frozen in a roll: its felt broke a rule, so its bets
      // played as they stood (the stake the riding bets), and the card
      // flagged it (A SLIP BROKE THE TABLE RULES — ITS CHANGES WERE IGNORED).
      for (const k of kinds) expect(done.get(k), `${sim.label} ${k}`).toBeGreaterThan(0);
      for (const p of [...played.values()].filter((q) => q.frozen)) {
        expect(p.fate, `${sim.label} ${p.kind}`).toBe('illegal');
        expect(p.flagged, `${sim.label} ${p.kind}`).toBe(true);
        expect(p.stake ?? 0n, `${sim.label} ${p.kind}`).toBe(BigInt(p.C));
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🔚 The end mark ──────────────────────────────────────────────────────────

describe('computed craps: the end mark', () => {
  for (const n of SEEDS) {
    it(`end mark ${n}: a modified page writes the table's end mark mid-point (a point on, line bets riding, a roll under way); the table ends as a removal ends it: every riding stake back, contract bets included, the nets kept, compaction finalising it, owner-run play fresh`, async () => {
      const sim = await Sim.open({
        name: 'craps-end-mark', seed: seed(2200 + n), tables: crapsTable,
        pages: [...named('ABCD'), { name: 'X', honest: false, bot: null, place: 'off' }],
      });
      const craps = sim.craps!;
      const { house } = sim;
      const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
      const honest = sim.pages.filter((sp) => sp !== cheat.x).map((sp) => sp.pid);
      let at: { inc: string; point: number; contracts: number; held: bigint; chips: bigint; after: bigint; nets: string } | null = null;
      let owner: { phase: string; round: number; point: number | null; inc?: string; incFor: string } | null = null;
      // From 70 s on, the first look (on the cheat's own doc) with a point
      // on, a contract bet riding, and a close in or chips on the felt.
      sim.every(async () => {
        if (at === null && sim.elapsed >= 70_000) {
          await sim.as(cheat.x, () => {
            const { casino, doc } = cheat.x.p;
            const res = cheat.fold();
            if (!res || (!res.tip && ![...res.felts.values()].some((f) => f.rec.b.length > 0))) return;
            const carry = res.carry as CrapsCarry;
            const contracts = Object.values(carry.w).flat().filter((b) => isContract(b, carry.p)).length;
            if (carry.p === 0 || contracts === 0) return;
            const inc = casino.computedIncOf(T)!;
            const held = [...res.held.values()].reduce((m, v) => m + v, 0n);
            const chips = honest.reduce((m, pid) => m + BigInt(casino.readChips(pid)), 0n);
            const nets = JSON.stringify([...res.nets].filter(([, v]) => v !== 0n).map(([p, v]) => [p, v.toString()]).sort());
            doc.transact(() => doc.getMap('casino').set(`gone:${T}:${inc}`, 1));
            at = { inc, point: carry.p, contracts, held, chips, after: honest.reduce((m, pid) => m + BigInt(casino.readChips(pid)), 0n), nets };
          });
          return;
        }
        // The owner-run table the house's stickman then opens, as it first reads.
        if (at !== null && owner === null) {
          sim.enter(house);
          const os = house.p.casino.readCrapsTableState(T);
          if (os) owner = { phase: os.phase, round: os.round, point: os.point, inc: (os as { inc?: string }).inc, incFor: house.p.casino.tableIncFor(T) };
        }
      });
      await sim.run(180_000);
      const s = await finish(sim, lines, { bettors: 4 });
      console.log(`[craps] ${sim.label}: end mark ${JSON.stringify(at, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}, owner-run ${JSON.stringify(owner)}`);
      expect(at, sim.label).not.toBeNull();
      const { inc } = at!;
      // Mid-point: the point on and contract bets riding as it went; every
      // chip on the felt back at once (the riding bets with the rest), no
      // net moved (the design's "The table ending": "Every riding stake
      // comes back to its player, contract bets included ... Decided wins
      // and losses keep counting").
      expect(at!.point, sim.label).not.toBe(0);
      expect(at!.contracts, sim.label).toBeGreaterThan(0);
      expect(at!.held, sim.label).toBeGreaterThan(0n);
      expect(at!.after, sim.label).toBe(at!.chips + at!.held);
      for (const sp of sim.pages) {
        sim.enter(sp);
        const { casino, table, doc } = sp.p;
        expect(casino.isComputedTable(T), `${sim.label} ${sp.name}`).toBe(false);
        expect(casino.computedIncEnded(T, inc), `${sim.label} ${sp.name}`).toBe(true);
        expect(table.computedCompactionPending(), `${sim.label} ${sp.name}`).toBe(false);
        const map = doc.getMap('casinoComputed');
        expect([...map.keys()].filter((k) => k.startsWith(`ses:${T}:`)), `${sim.label} ${sp.name}`).toEqual([]);
        const cp = map.get(`sum:${T}:${inc}`) as Checkpoint;
        expect(cp, `${sim.label} ${sp.name}`).toMatchObject({ v: 1, e: 1 });
        expect(JSON.stringify(Object.entries(cp.n).filter(([, v]) => String(v) !== '0').map(([p, v]) => [p, String(v)]).sort()), sim.label).toBe(at!.nets);
      }
      expect(craps.stats.endedChecked, sim.label).toBeGreaterThan(0);
      // Owner-run play then starts fresh on an incarnation of its own.
      expect(owner, sim.label).toMatchObject({ phase: 'betting', round: 1, point: null });
      expect(owner!.inc, sim.label).toBe(owner!.incFor);
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 👥 Made-up riders ────────────────────────────────────────────────────────

const MADE_UP = 'zz-made-up-';

describe('computed craps: made-up riders', () => {
  for (const n of SEEDS) {
    it(`made-up riders ${n}: a modified page puts line bets down for 31 made-up players (keys the room never saw: a pass on a come-out, a come on a point) in one close of its own, on dice it picked to make them contract bets; they fill the table: a newcomer is refused, the card names them, and the house's second switch-off press frees the table`, async () => {
      uiDom();
      try {
        const sim = await Sim.open({
          name: 'craps-made-up', seed: seed(2300 + n), tables: crapsTable,
          pages: [
            { name: 'A', place: 1, crapsBot: SCRIPTED, onLoad: withTableUI },
            { name: 'B', place: 3, crapsBot: SCRIPTED },
            { name: 'C', place: 5, crapsBot: SCRIPTED },
            { name: 'X', honest: false, bot: null, place: 'off' },
          ],
        });
        const { house } = sim;
        const [a, b, c] = sim.pages;
        const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
        // (The first with markup in its key: no line that names a player
        // carries it unescaped.)
        const pids = Array.from({ length: 31 }, (_, i) => `${i === 0 ? '<i>' : ''}${MADE_UP}${String(i).padStart(2, '0')}`);
        // Chips for them (a buy-in needs no key), and none in the players
        // map: their keys are none the room has seen.
        for (const pid of pids) sim.buyIn(cheat.x, pid, 1_000);
        // B and C put a chip on the field each roll (they keep the table
        // rolling, and are newcomers each roll); A bets once the table is full.
        let phase = 'before' as 'before' | 'filled' | 'off';
        const answers = bettors(sim, [b, c], () => (phase === 'before' ? [field(1)] : null));
        const tries = bettors(sim, [a], () => (phase === 'filled' ? [field(1)] : null), ['full']);
        let fill: { r: number; bet: string; riding: number } | null = null;
        let card = '';
        let unknown: string[] = [];
        let off: { first: string; second: string; back: number } | null = null;
        let owner: { phase: string; round: number; bet: boolean } | null = null;
        sim.every(async () => {
          // The fill: once an honest close has been checked against its
          // holder's wait (finish asks for one), at a come-out taking bets
          // with 4 s to go.
          if (phase === 'before' && fill === null && sim.craps!.stats.closesChecked > 0) {
            const at = bettingFor(sim, a, 4_000);
            if (!at) return;
            await sim.as(cheat.x, () => {
              const res = cheat.fold();
              if (!res || res.tip || res.open !== at.r) return;
              const r = res.open;
              const ctx = cheat.ctx();
              const carry = res.carry as CrapsCarry;
              // A pass bet each on a come-out, a come bet on a point: either
              // way a contract bet once the dice set a number, which it
              // picks before it closes (the last seed tried until the 31
              // make a number other than the point).
              const bet: CrapsBet = carry.p === 0 ? pass(1) : { type: 'come', amount: 1 };
              const base = pids.slice(0, -1).map((pid) => tagSeed(`${ctx.inc}:${pid}:${r}`));
              let last = '';
              for (let i = 0; i < 1_000 && !last; i++) {
                const s = tagSeed(`${ctx.inc}:${pids.at(-1)}:${r}:${i}`);
                const [d1, d2] = diceOf(seedTable(ctx), r, [...base, s]);
                if ([4, 5, 6, 8, 9, 10].includes(d1 + d2) && d1 + d2 !== carry.p) last = s;
              }
              const f: Record<string, string> = {};
              pids.forEach((pid, i) => { f[pid] = cheat.slip(r, pid, [bet], basisOf(carry, pid), i < base.length ? base[i] : last).hash; });
              cheat.close(r, res.parent, f);
              for (const pid of pids) cheat.reveal(r, pid, f[pid]);
              fill = { r, bet: bet.type, riding: 0 };
            });
            return;
          }
          if (phase === 'before' && fill !== null) {
            const v = decidedOn(sim, a, fill.r);
            if (!v) return;
            // The 31 riding a contract bet each as the roll after opens.
            const carry = a.p.casino.computedFoldOf(T)!.carry as CrapsCarry;
            fill.riding = pids.filter((pid) => own(carry.w, pid).some((x) => isContract(x, carry.p))).length;
            phase = 'filled';
            return;
          }
          // Full: once A's try was refused, the card read on A's table UI,
          // then the house's switch-off, twice.
          if (phase === 'filled' && (tries.full ?? 0) > 0 && off === null) {
            const now = sim.enter(a);
            unknown = a.p.table.computedUnknownRiders(T);
            card = atCraps(a.p as UIPage, { stand: 1, table: T }).card();
            sim.enter(house);
            const first = house.p.table.switchComputedOff(T, now);
            const second = house.p.table.switchComputedOff(T, now, true);
            off = { first, second, back: pids.reduce((m, pid) => m + house.p.casino.readChips(pid), 0) };
            phase = 'off';
            return;
          }
          // Off: the owner-run table the house's stickman opens takes A's bet.
          if (phase === 'off' && owner === null) {
            sim.enter(house);
            const os = house.p.casino.readCrapsTableState(T);
            if (!os || os.phase !== 'betting') return;
            await sim.as(a, () => {
              owner = { phase: os.phase, round: os.round, bet: a.p.casino.writeMyCrapsBets(T, a.pid, [field(1)]) };
            });
          }
        });
        // Until owner-run play has taken A's bet (6 minutes at most: the
        // fill waits for a come-out), then a little more.
        for (let i = 0; i < 36 && owner === null; i++) await sim.run(10_000);
        await sim.run(20_000);
        const s = await finish(sim, lines, { bettors: 4 });
        console.log(`[craps] ${sim.label}: fill ${JSON.stringify(fill)}, honest ${JSON.stringify(answers)}, A ${JSON.stringify(tries)}, unknown ${unknown.length}, off ${JSON.stringify(off)}, owner-run ${JSON.stringify(owner)}`);
        // The 31 ride a contract bet each: the table full, A's felt refused
        // by its writer.
        expect(fill, sim.label).not.toBeNull();
        expect(fill!.riding, sim.label).toBe(31);
        expect(tries.full ?? 0, sim.label).toBeGreaterThan(0);
        expect(tries.ok ?? 0, sim.label).toBe(0);
        // The card names them: riders whose key the room has never seen,
        // the first 4 named, then how many more (the design's lever 14 and
        // its card line).
        expect(unknown, sim.label).toEqual(pids);
        // (Names as the room shows a player's: their first 8 characters, the
        // markup escaped.)
        expect(card, sim.label).toContain('31 RIDERS HAVE A KEY THIS ROOM HAS NEVER SEEN · &lt;I&gt;ZZ-MA · ZZ-MADE- · ');
        expect(card, sim.label).toContain('· AND 27 MORE');
        expect(card, sim.label).not.toContain('<I>');
        // The first press warns (contract bets ride), the second goes: every
        // pass back to its made-up player, and owner-run play takes A's bet.
        expect(off, sim.label).toEqual({ first: 'contract', second: 'ok', back: 31 * 1_000 });
        expect(owner, sim.label).toMatchObject({ phase: 'betting', round: 1, bet: true });
        for (const sp of sim.pages) {
          sim.enter(sp);
          expect(sp.p.casino.isComputedTable(T), `${sim.label} ${sp.name}`).toBe(false);
        }
        expect(s.rounds, sim.label).toBeGreaterThan(0);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🕳️ Empty slips and a forced void ─────────────────────────────────────────

describe('computed craps: empty slips and a forced void', () => {
  for (const n of SEEDS) {
    it(`empty slips ${n}: a modified page closes a roll on its own felt and 30 empty slips for made-up players (31 places) and never reveals; the seated pages void it, the void carries only the felt with chips, and the next roll isn't full`, async () => {
      const sim = await Sim.open({
        name: 'craps-empty-slips', seed: seed(2400 + n), tables: crapsTable,
        pages: [
          { name: 'A', place: 1, crapsBot: SCRIPTED },
          { name: 'B', place: 3, crapsBot: SCRIPTED },
          { name: 'C', place: 5, crapsBot: SCRIPTED },
          { name: 'X', honest: false, bot: null, place: 'off' },
        ],
      });
      const craps = sim.craps!;
      const [a, b, c] = sim.pages;
      const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
      const pids = Array.from({ length: 30 }, (_, i) => `${MADE_UP}${String(i).padStart(2, '0')}`);
      // B and C put a chip on the field each roll (newcomers each roll); A,
      // a newcomer too, bets on the roll after the void.
      let phase = 'before' as 'before' | 'closed' | 'after';
      let at: { r: number; felt: CrapsBet[] } | null = null;
      const answers = bettors(sim, [b, c], () => [field(1)]);
      const tries = bettors(sim, [a], (_, r) => (phase === 'after' && r === at!.r + 1 ? [field(1)] : null));
      let voided: { present: number; empties: number; out: string[]; xOut: CrapsBet[]; next: number } | null = null;
      let next: { fate: string | undefined; stake: bigint | undefined; riders: number } | null = null;
      sim.every(async () => {
        // The close: once an honest close has been checked against its
        // holder's wait (finish asks for one), on a roll taking bets with 4 s
        // to go, before any page has closed it.
        if (phase === 'before' && craps.stats.closesChecked > 0) {
          const open = bettingFor(sim, a, 4_000);
          if (!open) return;
          await sim.as(cheat.x, () => {
            const res = cheat.fold();
            if (!res || res.tip || res.open !== open.r) return;
            const r = res.open;
            const carry = res.carry as CrapsCarry;
            const felt = [...own(carry.w, cheat.pid), field(5)];
            const f: Record<string, string> = { [cheat.pid]: cheat.slip(r, cheat.pid, felt, basisOf(carry, cheat.pid)).hash };
            for (const pid of pids) f[pid] = cheat.slip(r, pid, [], basisOf(carry, pid)).hash;
            cheat.close(r, res.parent, f);
            at = { r, felt: canonList(felt) };
            phase = 'closed';
          });
          return;
        }
        if (phase === 'closed') {
          const v = decidedOn(sim, a, at!.r);
          if (!v) return;
          const out = v.craps!.sOut;
          voided = {
            present: v.present.length, empties: pids.filter((pid) => v.present.includes(pid)).length,
            out: Object.keys(out.w).sort(), xOut: canonList(own(out.w, cheat.pid)), next: v.decided === 'void' ? 1 : 0,
          };
          phase = 'after';
          return;
        }
        if (phase === 'after' && next === null) {
          const v = decidedOn(sim, a, at!.r + 1);
          if (!v) return;
          next = { fate: v.craps?.fates.get(a.pid), stake: v.stakes.get(a.pid), riders: Object.keys(v.craps!.sIn.w).length };
        }
      });
      // Until the roll after the void has played (6 minutes at most), then a
      // little more.
      for (let i = 0; i < 36 && next === null; i++) await sim.run(10_000);
      await sim.run(20_000);
      const s = await finish(sim, lines, { bettors: 4 });
      console.log(`[craps] ${sim.label}: closed ${JSON.stringify(at)}, void ${JSON.stringify(voided)}, next ${JSON.stringify(next, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}, honest ${JSON.stringify(answers)}, A ${JSON.stringify(tries)}`);
      // The close held 31 places, 30 of them empty slips for made-up players
      // (a craps close may freeze an empty slip: open question 3, v2), and
      // nobody could finish it: the seated pages voided it (abandonDuty).
      expect(at, sim.label).not.toBeNull();
      expect(voided, sim.label).not.toBeNull();
      expect(voided!.next, sim.label).toBe(1);
      expect(voided!.present, sim.label).toBe(31);
      expect(voided!.empties, sim.label).toBe(30);
      expect(s.voids, sim.label).toBeGreaterThan(0);
      expect(s.abandonsChecked, sim.label).toBeGreaterThan(0);
      // The void carries only felts with chips (Safety 3): the cheat's felt,
      // as it froze it, rides on; no made-up player does.
      expect(voided!.xOut, sim.label).toEqual(at!.felt);
      expect(voided!.out.filter((pid) => pid.startsWith(MADE_UP)), sim.label).toEqual([]);
      // The next roll isn't full: A, a newcomer, bets on it ('ok' from its
      // writer) and its chip plays.
      expect(tries.ok ?? 0, sim.label).toBe(1);
      expect(tries.full ?? 0, sim.label).toBe(0);
      expect(next, sim.label).not.toBeNull();
      expect(next!.fate, sim.label).toBe('ok');
      expect(next!.stake, sim.label).toBe(1n);
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── ⏳ Holding the window ────────────────────────────────────────────────────

describe('computed craps: holding the window', () => {
  for (const n of SEEDS) {
    it(`window ${n}: a modified page bets each roll and never closes or reveals; players who bet inside a window roll normally (its slip forfeited), and a latecomer once betting is over waits for the table to give up on the roll and reopen it (about 13 s, 33 s with the throw wait), then plays`, async () => {
      const sim = await Sim.open({
        name: 'craps-window', seed: seed(2500 + n), tables: crapsTable,
        pages: [
          { name: 'A', place: 1, crapsBot: SCRIPTED },
          { name: 'B', place: 3, crapsBot: SCRIPTED },
          { name: 'C', place: 5, crapsBot: SCRIPTED },
          { name: 'X', honest: false, bot: null, place: 'off' },
        ],
      });
      const craps = sim.craps!;
      const [a, b, c] = sim.pages;
      const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
      const { table } = a.p;
      // The cheat: a chip on the field each roll it sees open (its own
      // version opening the window when nobody else has bet), never a close,
      // never a seed.
      const wrote = new Set<number>();
      sim.every(async () => {
        if (sim.healed || cheat.x.mode !== 'up') return;
        await sim.as(cheat.x, () => {
          const res = cheat.fold();
          if (!res || res.tip || wrote.has(res.open)) return;
          const carry = res.carry as CrapsCarry;
          wrote.add(res.open);
          cheat.slip(res.open, cheat.pid, [...own(carry.w, cheat.pid), field(1)], basisOf(carry, cheat.pid));
        });
      });
      // Inside: B and C bet in each window (as it opens), until two such
      // rolls have played with the cheat's slip frozen in them and an honest
      // close has been checked against its holder's wait (finish asks for
      // one). Then late: nobody bets in the window, and A tries once it is
      // over, twice.
      let phase = 'inside' as 'inside' | 'late' | 'done';
      const inside: { r: number; decided: string | null; fates: string[]; xLost: bigint | undefined; counted: boolean }[] = [];
      const insideRolls = new Set<number>();
      bettors(sim, [b, c], (_, r) => {
        if (phase !== 'inside') return null;
        insideRolls.add(r);
        return [field(1)];
      });
      type Lock = { r: number; W: number; waits: boolean; tried?: string; reopen?: number; stallUntil?: number; wrote?: string; decided?: string | null; fate?: string; xLost?: bigint };
      const locks = new Map<number, Lock>();
      sim.every(async () => {
        if (phase === 'inside') {
          for (const r of insideRolls) {
            if (inside.some((x) => x.r === r)) continue;
            const v = decidedOn(sim, a, r);
            if (!v) continue;
            const frozen = v.frozen[cheat.pid] !== undefined;
            if (frozen) {
              inside.push({
                r, decided: v.decided, fates: [b, c].map((sp) => v.craps!.fates.get(sp.pid) ?? '-'),
                xLost: v.craps!.lost.get(cheat.pid), counted: v.counted.includes(cheat.pid),
              });
            }
          }
          if (inside.length >= 2 && craps.stats.closesChecked > 0) phase = 'late';
          return;
        }
        if (phase !== 'late') return;
        const now = sim.enter(a);
        const v = table.readComputedCraps(T, now);
        if (!v) return;
        const r = v.round;
        // (A roll whose window opened inside, still playing out: not a lockout.)
        if (insideRolls.has(r)) return;
        let L = locks.get(r);
        if (v.phase === 'betting' && L?.tried === undefined) {
          if (v.phaseDeadline === undefined) return;
          if (!L) locks.set(r, (L = { r, W: v.phaseDeadline, waits: v.shooterInPlay }));
          L.W = v.phaseDeadline;
          L.waits = v.shooterInPlay;
          return;
        }
        if (!L) return;
        const press = (): string => {
          const { felt, basis } = table.readMyComputedCrapsBets(T, a.pid, r, now);
          const next = [...felt, field(1)];
          return craps.press(a, T, r, next, basis, () => table.writeComputedCrapsSlip(T, next, basis, now));
        };
        if (L.tried === undefined && v.phase === 'closing' && now >= L.W) {
          // Betting is over: A arrives, and its writer turns it away.
          await sim.as(a, () => { L!.tried = press(); });
          return;
        }
        if (L.tried !== undefined && L.reopen === undefined) {
          if (v.phase === 'closing' && v.stallUntil !== undefined) L.stallUntil = v.stallUntil;
          if (v.phase !== 'betting') return;
          // Betting open again on the same roll: A bets.
          L.reopen = now;
          await sim.as(a, () => { L!.wrote = press(); });
          return;
        }
        if (L.reopen !== undefined && L.decided === undefined) {
          const d = decidedOn(sim, a, r);
          if (!d) return;
          L.decided = d.decided;
          L.fate = d.craps!.fates.get(a.pid);
          L.xLost = d.craps!.lost.get(cheat.pid);
          if ([...locks.values()].filter((x) => x.decided !== undefined).length >= 2) phase = 'done';
        }
      });
      for (let i = 0; i < 48 && phase !== 'done'; i++) await sim.run(10_000);
      await sim.run(20_000);
      const s = await finish(sim, lines, { bettors: 4 });
      const done = [...locks.values()].filter((x) => x.decided !== undefined);
      const big = (_: string, x: unknown): unknown => (typeof x === 'bigint' ? x.toString() : x);
      console.log(`[craps] ${sim.label}: inside ${JSON.stringify(inside, big)}, latecomers ${JSON.stringify(done.map((x) => ({ ...x, lockout: x.reopen! - x.W })), big)}`);
      // Inside a window: the roll plays on the honest seeds, the cheat's
      // frozen slip forfeited (its new chip lost), the bettors' fates 'ok'.
      expect(inside.length, sim.label).toBeGreaterThanOrEqual(2);
      for (const x of inside) {
        expect(x.decided, `${sim.label} roll ${x.r}`).toBe('forfeit');
        expect(x.counted, `${sim.label} roll ${x.r}`).toBe(false);
        expect(x.fates, `${sim.label} roll ${x.r}`).toEqual(['ok', 'ok']);
        expect(x.xLost, `${sim.label} roll ${x.r}`).toBe(1n);
      }
      // Late: refused once betting is over; betting reopens on the same roll
      // once every close turn and GRACE_MAX_MS have passed (the L1d re-arm:
      // W' + (n + 1) × STAGGER_MS + GRACE_MAX_MS, n = 1, the cheat's key; W'
      // = W, plus CRAPS_SHOOTER_MS while the shooter is in play), on the
      // tick it comes; then A's chip plays and the cheat's slip is forfeited.
      expect(done.length, sim.label).toBeGreaterThanOrEqual(2);
      for (const x of done) {
        const want = (x.waits ? a.p.croupier.CRAPS_SHOOTER_MS : 0) + 2 * table.STAGGER_MS + table.GRACE_MAX_MS;
        expect(x.tried, `${sim.label} roll ${x.r}`).toBe('closed');
        expect(x.stallUntil, `${sim.label} roll ${x.r}`).toBe(x.W + want);
        expect(x.reopen! - x.W, `${sim.label} roll ${x.r}`).toBeGreaterThanOrEqual(want);
        expect(x.reopen! - x.W, `${sim.label} roll ${x.r}`).toBeLessThan(want + 250);
        expect(x.wrote, `${sim.label} roll ${x.r}`).toBe('ok');
        expect(x.decided, `${sim.label} roll ${x.r}`).toBe('forfeit');
        expect(x.fate, `${sim.label} roll ${x.r}`).toBe('ok');
        expect(x.xLost, `${sim.label} roll ${x.r}`).toBe(1n);
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── ✂️ A seed dropper ────────────────────────────────────────────────────────

const FIELD_WINS = new Set([2, 3, 4, 9, 10, 11, 12]);
const sumOf = (d: readonly [number, number] | null): number => (d ? d[0] + d[1] : 0);
const big = (_: string, x: unknown): unknown => (typeof x === 'bigint' ? x.toString() : x);

/** Three honest players at their stands (A, B, C), a chip on the field each
 *  roll, and the cheat X off the table. */
const threeAndX = (name: string, base: number, n: number) => Sim.open({
  name, seed: seed(base + n), tables: crapsTable,
  pages: [
    { name: 'A', place: 1, crapsBot: SCRIPTED },
    { name: 'B', place: 3, crapsBot: SCRIPTED },
    { name: 'C', place: 5, crapsBot: SCRIPTED },
    { name: 'X', honest: false, bot: null, place: 'off' },
  ],
});

describe('computed craps: a seed dropper', () => {
  // Over the three seeds: its forfeits, how many stood, the field's wins.
  const totals = { frozen: 0, fairWins: 0, drops: 0, stood: 0 };
  afterAll(() => {
    lines.push(`[craps] dropper, 3 seeds: ${totals.drops} forfeits dropping a seed, ${totals.stood} stood (${(totals.stood / Math.max(1, totals.drops)).toFixed(2)}); `
      + `the field won ${totals.fairWins + totals.stood} of ${totals.frozen} rolls (${totals.fairWins} on the full set of seeds)`);
  });
  for (const n of SEEDS) {
    it(`dropper ${n}: a modified page with a field bet holds its seed back until it has seen every other, and when the full set loses it writes the forfeit first, dropping one seed that makes the field win; a forfeit from a page with a better place in the order replaces it, the card flags it, and the rate it stands is measured`, async () => {
      const sim = await threeAndX('craps-dropper', 2600, n);
      const [a, b, c] = sim.pages;
      const honest = [a, b, c];
      const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
      bettors(sim, honest, () => [field(1)]);
      const fieldWins = (d: [number, number]): boolean => FIELD_WINS.has(d[0] + d[1]);
      // Each drop: the seed dropped, whether the cheat's place in the order
      // came first among the round's bettors, the pages whose card flagged
      // it, and how the round last read on A.
      type Drop = { close: string; h: string; xFirst: boolean; flaggedBy: Set<string>; last?: { byX: boolean; hCounted: boolean; hLost: bigint | undefined; xWon: boolean } };
      const drops = new Map<number, Drop>();
      const tally = { frozen: 0, fairWins: 0 };
      const wrote = new Set<number>();
      const acted = new Set<string>();
      sim.every(async () => {
        if (sim.healed || cheat.x.mode !== 'up') return;
        await sim.as(cheat.x, () => {
          const res = cheat.fold();
          if (!res) return;
          const ctx = cheat.ctx();
          const tip = res.tip;
          if (!tip) {
            // Its felt, on a roll an honest page will close.
            if (wrote.has(res.open) || ![...res.felts.values()].some((f) => f.rec.p !== cheat.pid && f.rec.b.length > 0)) return;
            const carry = res.carry as CrapsCarry;
            wrote.add(res.open);
            cheat.slip(res.open, cheat.pid, [...own(carry.w, cheat.pid), field(5)], basisOf(carry, cheat.pid));
            return;
          }
          const xh = tip.frozen[cheat.pid];
          if (!xh || !tip.present.includes(cheat.pid) || acted.has(tip.close)) return;
          const others = tip.present.filter((pid) => pid !== cheat.pid);
          const seeds = cheat.seedsOf(tip);
          if (!others.every((pid) => seeds.has(pid))) return;
          acted.add(tip.close);
          const mine = cheat.seeds.get(xh)!;
          const table = seedTable(ctx);
          const dice = (pids: string[]): [number, number] => diceOf(table, tip.r, [...pids.map((pid) => seeds.get(pid)!), mine]);
          tally.frozen += 1;
          cheat.reveal(tip.r, cheat.pid, xh);
          if (fieldWins(dice(others))) {
            tally.fairWins += 1;
            return;
          }
          const h = others.find((pid) => fieldWins(dice(others.filter((q) => q !== pid))));
          if (h === undefined) return;
          cheat.forfeit(tip.r, tip.close, tip.present.filter((pid) => pid !== h));
          const rank = (pub: string): string => cheat.x.p.fold.dutyRank('forfeit', ctx, tip.r, pub);
          const xFirst = honest.filter((sp) => others.includes(sp.pid)).every((sp) => rank(cheat.x.p.pub) < rank(sp.p.pub));
          drops.set(tip.r, { close: tip.close, h, xFirst, flaggedBy: new Set() });
        });
      });
      // Each honest page's card, every tick; and how each dropped round
      // reads on A (its last reading is its final one: a trim may take it
      // out of the session later).
      sim.every(() => {
        for (const sp of honest) {
          if (sp.mode !== 'up') continue;
          const now = sim.enter(sp);
          const chk = sp.p.table.computedRoundCheck(T, now);
          const d = chk ? drops.get(chk.round) : undefined;
          if (d && chk!.dropped.includes(d.h)) d.flaggedBy.add(sp.name);
          if (sp !== a) continue;
          for (const v of sp.p.casino.computedFoldOf(T)?.rounds ?? []) {
            const dv = drops.get(v.r);
            if (!dv || v.close !== dv.close || v.decided !== 'forfeit') continue;
            dv.last = {
              byX: v.forfeit!.rec.k === cheat.x.p.pub, hCounted: v.counted.includes(dv.h), hLost: v.craps!.lost.get(dv.h),
              xWon: (v.craps!.amounts.get(cheat.pid) ?? 0n) > 0n,
            };
          }
        }
      });
      // Until a drop has stood and one has been replaced (30 minutes at most).
      const both = (): boolean => [...drops.values()].some((d) => d.xFirst) && [...drops.values()].some((d) => !d.xFirst) && drops.size >= 4;
      for (let i = 0; i < 180 && !both(); i++) await sim.run(10_000);
      await sim.run(30_000);
      // (Its forfeit, written over the seeds it had seen, is the round's
      // first decision on every page, unless one read the full set before
      // it came ('forfeit over reveals'); an answer replaces it ('answer
      // forfeit'). Both are the cheat's own doing: lever 2.)
      const s = await finish(sim, lines, { bettors: 4, flips: ['answer forfeit', 'forfeit over reveals'] });
      const all = [...drops.values()];
      const stood = all.filter((d) => d.last?.byX);
      console.log(`[craps] ${sim.label}: dropper frozen ${tally.frozen}, field won fairly ${tally.fairWins}, drops ${all.length}, stood ${stood.length} (${(stood.length / Math.max(1, all.length)).toFixed(2)}; its place first ${all.filter((d) => d.xFirst).length}), `
        + `field won ${tally.fairWins + stood.length} of ${tally.frozen} (fair ${tally.fairWins}) ${JSON.stringify([...drops].map(([r, d]) => ({ r, ...d, flaggedBy: [...d.flaggedBy] })), big)}`);
      totals.frozen += tally.frozen;
      totals.fairWins += tally.fairWins;
      totals.drops += all.length;
      totals.stood += stood.length;
      expect(all.some((d) => d.xFirst), sim.label).toBe(true);
      expect(all.some((d) => !d.xFirst), sim.label).toBe(true);
      for (const [r, d] of drops) {
        const at = `${sim.label} roll ${r}`;
        expect(d.last, at).toBeDefined();
        // It stands exactly when no bettor with a better place in the order
        // saw the dropped seed: then the dropped player loses only the chip
        // it added, and the field pays the cheat. Otherwise an answer that
        // counts the dropped seed replaces it.
        expect(d.last!.byX, at).toBe(d.xFirst);
        expect(d.last!.hCounted, at).toBe(!d.xFirst);
        if (d.xFirst) {
          expect(d.last!.hLost, at).toBe(1n);
          expect(d.last!.xWon, at).toBe(true);
        }
        // Every honest page's card flagged the drop while it decided the roll
        // (A FORFEIT DROPPED A SEED THIS PAGE SAW IN TIME).
        expect([...d.flaggedBy].sort(), at).toEqual(['A', 'B', 'C']);
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🔁 A re-drawer ───────────────────────────────────────────────────────────

describe('computed craps: a re-drawer', () => {
  // Over the three seeds, per point roll: a win or a seven with its seed
  // (fair), and as played.
  const totals = { rolls: 0, held: 0, fairW: 0, fairL: 0, gotW: 0, gotL: 0 };
  afterAll(() => {
    const rate = (w: number, l: number): string => (w + l > 0 ? (w / (w + l)).toFixed(2) : '-');
    lines.push(`[craps] re-drawer, 3 seeds: ${totals.rolls} point rolls, ${totals.held} held back; per roll a win/a seven with its seed ${totals.fairW}/${totals.fairL} `
      + `(a pass wins ${rate(totals.fairW, totals.fairL)}), as played ${totals.gotW}/${totals.gotL} (${rate(totals.gotW, totals.gotL)})`);
  });
  for (const n of SEEDS) {
    it(`redraw ${n}: a modified page with a pass riding on a point adds nothing each roll and, once it has seen every other seed, reveals its own only when the dice with it do at least as well as the dice without it; otherwise the forfeit decides on the others' seeds (a second draw for free, the roll stalled 4 to 10 s); its pass's win rate is measured against the fair one`, async () => {
      const sim = await threeAndX('craps-redraw', 2700, n);
      const [a, b, c] = sim.pages;
      const honest = [a, b, c];
      const cheat = new Cheat(sim, sim.pages.find((sp) => sp.name === 'X')!);
      const { table } = a.p;
      bettors(sim, honest, () => [field(1)]);
      // Of a pass on point p: 2 the point (it wins), 0 a seven, 1 neither.
      const score = (d: readonly [number, number], p: number): number => (sumOf(d) === p ? 2 : sumOf(d) === 7 ? 0 : 1);
      type Look = { close: string; p: number; withD: [number, number]; withoutD: [number, number]; reveal: boolean; seenAt?: number; decidedAt?: number; decided?: string | null; dice?: [number, number] | null; xLost?: bigint; card?: { counted: number; of: number; by: string | null; late: string[] } };
      const looks = new Map<number, Look>();
      const wrote = new Set<number>();
      const acted = new Set<string>();
      sim.every(async () => {
        if (sim.healed || cheat.x.mode !== 'up') return;
        await sim.as(cheat.x, () => {
          const res = cheat.fold();
          if (!res) return;
          const ctx = cheat.ctx();
          const carry = res.carry as CrapsCarry;
          const tip = res.tip;
          if (!tip) {
            if (wrote.has(res.open) || ![...res.felts.values()].some((f) => f.rec.p !== cheat.pid && f.rec.b.length > 0)) return;
            const C = own(carry.w, cheat.pid);
            const pl = C.some((x) => x.type === 'pass');
            // A pass on a come-out; on a point with it riding, a ride slip
            // (it adds nothing).
            if (carry.p === 0 && !pl) cheat.slip(res.open, cheat.pid, [...C, pass(10)], basisOf(carry, cheat.pid));
            else if (carry.p !== 0 && pl) cheat.slip(res.open, cheat.pid, C, basisOf(carry, cheat.pid));
            wrote.add(res.open);
            return;
          }
          const xh = tip.frozen[cheat.pid];
          if (!xh || !tip.present.includes(cheat.pid) || acted.has(tip.close)) return;
          const others = tip.present.filter((pid) => pid !== cheat.pid);
          const seeds = cheat.seedsOf(tip);
          if (!others.every((pid) => seeds.has(pid))) return;
          acted.add(tip.close);
          const p = (tip.craps!.sIn as CrapsCarry).p;
          if (p === 0) {
            cheat.reveal(tip.r, cheat.pid, xh);
            return;
          }
          const st = seedTable(ctx);
          const withD = diceOf(st, tip.r, [...others.map((pid) => seeds.get(pid)!), cheat.seeds.get(xh)!]);
          const withoutD = diceOf(st, tip.r, others.map((pid) => seeds.get(pid)!));
          const reveal = score(withD, p) >= score(withoutD, p);
          if (reveal) cheat.reveal(tip.r, cheat.pid, xh);
          looks.set(tip.r, { close: tip.close, p, withD, withoutD, reveal });
        });
      });
      // How each such roll reads on A: when its close came, when and how it
      // was decided, and A's card for it.
      sim.every(() => {
        if (a.mode !== 'up') return;
        const now = sim.enter(a);
        const res = a.p.casino.computedFoldOf(T);
        for (const v of [...(res?.rounds ?? []), ...(res?.tip ? [res.tip] : [])]) {
          const L = looks.get(v.r);
          if (!L || v.close !== L.close) continue;
          L.seenAt ??= a.p.casino.computedSeenAt(T, `c:${v.r}:${v.close}`);
          if (v.decided !== null && L.decidedAt === undefined) {
            L.decidedAt = now;
            L.decided = v.decided;
            L.dice = v.craps!.dice;
            L.xLost = v.craps!.lost.get(cheat.pid) ?? 0n;
          }
        }
        const chk = a.p.table.computedRoundCheck(T, now);
        const L = chk ? looks.get(chk.round) : undefined;
        if (L && L.decided && !L.card) L.card = { counted: chk!.counted, of: chk!.of, by: chk!.forfeitBy, late: chk!.uncounted ?? [] };
      });
      // Until it has held its seed back four times and its pass has played
      // 20 point rolls (30 minutes at most).
      const enough = (): boolean => [...looks.values()].filter((L) => !L.reveal && L.decided).length >= 4 && looks.size >= 20;
      for (let i = 0; i < 180 && !enough(); i++) await sim.run(10_000);
      await sim.run(20_000);
      const s = await finish(sim, lines, { bettors: 4 });
      const all = [...looks.entries()].filter(([, L]) => L.decided);
      const per = (pick: (L: Look) => [number, number]) => {
        const w = all.filter(([, L]) => score(pick(L), L.p) === 2).length;
        const l = all.filter(([, L]) => score(pick(L), L.p) === 0).length;
        return { w, l, rate: w + l > 0 ? +(w / (w + l)).toFixed(2) : null };
      };
      const fair = per((L) => L.withD);
      const got = per((L) => L.dice!);
      const held = all.filter(([, L]) => !L.reveal);
      console.log(`[craps] ${sim.label}: re-drawer point rolls ${all.length}, held back ${held.length}; per roll a win/a seven with its seed (fair) ${fair.w}/${fair.l} (pass wins ${fair.rate}), as played ${got.w}/${got.l} (pass wins ${got.rate}); `
        + `stalls ${JSON.stringify(held.map(([, L]) => L.decidedAt! - L.seenAt!))} cards ${JSON.stringify(held.map(([, L]) => L.card))}`);
      totals.rolls += all.length;
      totals.held += held.length;
      totals.fairW += fair.w;
      totals.fairL += fair.l;
      totals.gotW += got.w;
      totals.gotL += got.l;
      expect(held.length, sim.label).toBeGreaterThanOrEqual(4);
      for (const [r, L] of all) {
        const at = `${sim.label} roll ${r}`;
        // The roll plays the draw it chose: its own seed in (all reveals) when
        // that did at least as well, else the others' seeds (a forfeit).
        expect(L.decided, at).toBe(L.reveal ? 'reveals' : 'forfeit');
        expect(L.dice, at).toEqual(L.reveal ? L.withD : L.withoutD);
        expect(score(L.dice!, L.p), at).toBe(Math.max(score(L.withD, L.p), score(L.withoutD, L.p)));
        // It added nothing, so its seed held back costs it nothing: its pass
        // plays (open question 4: a missing seed costs only new chips).
        expect(L.xLost, at).toBe(0n);
        if (L.reveal) continue;
        // Held back: the roll waits out the grace (REVEAL_GRACE_MS, 4 s) and
        // the first forfeit's turn: within the design's 4 to 10 s.
        const stall = L.decidedAt! - L.seenAt!;
        expect(stall, at).toBeGreaterThanOrEqual(REVEAL_GRACE_MS);
        expect(stall, at).toBeLessThanOrEqual(table.GRACE_MAX_MS);
        // A's card: n − 1 of n seeds counted, decided by an honest page's
        // forfeit, and the player whose seed didn't come named (the lever
        // table's "the card names the player").
        expect(L.card, at).toBeDefined();
        expect(L.card!.counted, at).toBe(L.card!.of - 1);
        expect(honest.map((sp) => sp.pid), at).toContain(L.card!.by);
        expect(L.card!.late, at).toEqual([cheat.pid]);
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🏚️ Older builds in the room ──────────────────────────────────────────────

type Stickman = typeof import('./crapsCroupier');

/** Each load's crapsCroupier (its own module instance, bound to its doc),
 *  for a page standing in for an older build's stickman. */
const stickmen = new WeakMap<Page, Stickman>();
const withStickman = async (p: Page): Promise<void> => {
  stickmen.set(p, await import('./crapsCroupier'));
};

/** Run `fn` with every throw rolling d1 and d2: the sim's own seeded
 *  crypto.getRandomValues (Sim.open) swapped for one that draws those faces
 *  (the plain RNG's dice, as computedCrapsOwnerRun's diceTo), and put back
 *  as `fn` returns. (A plain roll draws its dice before its settle's first
 *  await.) */
function withDice<R>(d1: number, d2: number, fn: () => R): R {
  const spy = vi.mocked(globalThis.crypto.getRandomValues);
  const prev = spy.getMockImplementation()!;
  const faces = [d1, d2];
  let i = 0;
  spy.mockImplementation(<A extends ArrayBufferView | null>(arr: A): A => {
    (arr as unknown as Uint32Array)[0] = faces[i++ % 2] - 1;
    return arr;
  });
  try {
    return fn();
  } finally {
    spy.mockImplementation(prev);
  }
}

/** An owner-run round as an older build's lease holder opens it on T
 *  (writeCrapsTableState with tableOpening, as its openCrapsBetting does). */
function ownerRunOpens(sp: SimPage, round: number, point: number | null): void {
  const { casino } = sp.p;
  casino.transactCasino(() => casino.writeCrapsTableState(T, {
    kind: 'craps', phase: 'betting', round, point, dice: null, result: null, resultAt: 0, payouts: null,
    fairMode: 'rng', ...casino.tableOpening(T),
  }));
}

describe('computed craps: an older build in the room', () => {
  for (const n of SEEDS) {
    it(`old-build-ghost ${n}: an older build's page takes the lease and plays two owner-run rolls on the computed table (a field win paid, a pass riding on the point, a place bet up), then goes; this build's house sweeps its round away: its bets back, what it paid standing, the computed table as it was`, async () => {
      const sim = await Sim.open({
        name: 'craps-old-build', seed: seed(2800 + n), tables: crapsTable,
        pages: [...named('ABCD'), { name: 'G', bot: null, place: 'off', onLoad: withStickman }],
      });
      const { house } = sim;
      const g = sim.pages.find((sp) => sp.name === 'G')!;
      const cinc = house.p.casino.computedIncOf(T)!;
      const lapse = house.p.croupier.TABLE_LEASE_LAPSE_MS;
      const t0 = 40_000;
      let legacyInc = '';
      let paid: Record<string, number> | null = null;
      let point: number | null = null;
      let afterRoll2 = 0;
      let crashedAt = 0;
      let sweptAt = 0;
      const rollsAt = { crash: 0, end: 0 };
      let driving = 0;
      // (Its lease names its own page, as its build writes it, with no
      // build: so its own settle goes through, stillDrivesTables.)
      const lease = (beat: number): void => g.p.casino.writeTableOperatorLease({ page: g.p.croupier.ROULETTE_PAGE_ID, player: house.pid, beat });
      // Roll 1: its pass and field down, closed, thrown (1 + 3: the field
      // paid, the pass riding on 4), settled. As computedCrapsOwnerRun's
      // earlierBuildRolls plays it.
      sim.at(t0, async () => {
        const now = sim.enter(g);
        const stick = stickmen.get(g.p)!;
        lease(1);
        ownerRunOpens(g, 1, null);
        expect(g.p.casino.writeMyCrapsBets(T, g.pid, [pass(10), field(5)]), sim.label).toBe(true);
        stick.closeCrapsBetting(T, g.p.casino.readCrapsTableState(T)!, now);
        const closing = g.p.casino.readCrapsTableState(T)!;
        expect(closing, sim.label).toMatchObject({ phase: 'closing', round: 1 });
        // (Thrown by the stickman at the close's deadline: its own shooter's
        // wait, when the close gave the dice to a player at the table.)
        withDice(1, 3, () => stick.tickCrapsClosing(T, closing, stick.CRAPS_SHOW_MS, Math.max(now + stick.CRAPS_CLOSING_MS, closing.phaseDeadline ?? 0)));
        // (Its settle's awaits: microtasks only. The sim's setTimeout is its
        // pages' own timers, which run in their frames, not here.)
        for (let i = 0; i < 50; i++) await Promise.resolve();
        const s = g.p.casino.readCrapsTableState(T)!;
        expect(s, sim.label).toMatchObject({ phase: 'settled', round: 1, dice: [1, 3] });
        paid = s.payouts;
        point = s.point;
        // (What it paid stands: the field's win, its own chip records; the
        // cage check counts it, Sim.ownerRunPaid.)
        sim.ownerRunPaid.set(g.pid, 5n);
      });
      // Roll 2: betting on the point, a place bet on 8 beside the pass. And
      // E, a player of that build's with no page here (G's doc stands in for
      // E's), puts a list down as that build does: the bets shape, its
      // chips taken from its count (bought on that build: counts, no chip
      // records), all of it taken, nothing held.
      const E = 'player-Earlier';
      const eList: CrapsBet[] = [{ type: 'place', pick: 6, amount: 12 }];
      let eAfterRoll2 = 0;
      sim.at(t0 + 8_000, async () => {
        await sim.as(g, () => {
          lease(2);
          ownerRunOpens(g, 2, point);
          expect(g.p.casino.readAllCrapsBets(T)[g.pid], sim.label).toEqual([pass(10)]);
          expect(g.p.casino.writeMyCrapsBets(T, g.pid, [pass(10), { type: 'place', pick: 8, amount: 6 }]), sim.label).toBe(true);
          g.p.casino.transactCasino(() => {
            const cas = g.p.doc.getMap('casino');
            cas.set(`bought:${E}`, 100);
            cas.set(`bal:${E}`, 100 - 12);
            cas.set(`bets:${T}:${E}`, { kind: 'craps', bets: eList });
          });
          // (The cage issued its 100; its sweep's refund of the 12 its list
          // took is a chip record of its own, counted with owner-run play's.)
          sim.bought.set(E, 100n);
          sim.legacyBought.set(E, 100n);
          sim.ownerRunPaid.set(E, 12n);
          expect(g.p.casino.readAllCrapsBets(T)[E], sim.label).toEqual(eList);
          legacyInc = g.p.casino.readCrapsTableState(T)!.inc!;
          afterRoll2 = g.p.casino.readChips(g.pid);
          eAfterRoll2 = g.p.casino.readChips(E);
        });
      });
      // It renews the lease as its build does, then goes.
      for (let beat = 3; beat <= 6; beat++) sim.at(t0 + 8_000 + (beat - 2) * 2_000, () => sim.as(g, () => lease(beat)));
      // And beats its robot croupier, as its build's operator does (every
      // 3 s): no robot of this build's at the table moves for it.
      for (let b = t0 + 1_000; b < t0 + 18_000; b += 3_000) sim.at(b, () => sim.as(g, (now) => g.p.casino.writeCroupierBeat(T, now)));
      sim.at(t0 + 18_000, () => {
        sim.crash(g);
        crashedAt = sim.elapsed;
        rollsAt.crash = openRoll(sim, house);
      });
      sim.every(() => {
        if (sim.elapsed % 1_000 === 0 && house.p.table.computedOldBuildDriving(T)) driving += 1;
        if (crashedAt > 0 && sweptAt === 0) {
          sim.enter(house);
          if (house.p.casino.readCrapsTableState(T) === null) sweptAt = sim.elapsed;
        }
      });
      await sim.run(180_000);
      rollsAt.end = openRoll(sim, house);
      const s = await finish(sim, lines, { bettors: 4 });
      console.log(`[craps] ${sim.label}: old build paid ${JSON.stringify(paid)}, point ${point}, G after roll 2 ${afterRoll2}, driving ${driving} s, crashed ${crashedAt} ms, swept ${sweptAt} ms, rolls ${JSON.stringify(rollsAt)}`);
      expect(paid, sim.label).toEqual({ [g.pid]: 10 });
      expect(point, sim.label).toBe(4);
      expect(afterRoll2, sim.label).toBe(1_000 - 15 + 10 - 6);
      expect(eAfterRoll2, sim.label).toBe(100 - 12);
      expect(driving, sim.label).toBeGreaterThan(0);
      // Swept once a lapse had passed after the lease's (the house's turn
      // back, then a lapse watching the round).
      expect(sweptAt - crashedAt, sim.label).toBeGreaterThanOrEqual(lapse);
      expect(sweptAt - crashedAt, sim.label).toBeLessThanOrEqual(4 * lapse);
      for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
        sim.enter(sp);
        const { casino, table } = sp.p;
        // Its round cleared away as a removal ends one; its bets back, the
        // pass that rode on the point too; the field's win kept.
        expect(casino.readCrapsTableState(T), `${sim.label} ${sp.name}`).toBeNull();
        expect(casino.readAllCrapsBets(T), `${sim.label} ${sp.name}`).toEqual({});
        expect(casino.tableIncRemoved(T, legacyInc), `${sim.label} ${sp.name}`).toBe(true);
        expect(casino.readChips(g.pid), `${sim.label} ${sp.name}`).toBe(1_000 + 5);
        // E's list, taken whole by its build, back exactly.
        expect(casino.readChips(E), `${sim.label} ${sp.name}`).toBe(100);
        expect(table.computedOldBuildDriving(T), `${sim.label} ${sp.name}`).toBe(false);
        // The computed table as it was, still rolling; this build's page
        // holds the lease again.
        expect(casino.computedIncOf(T), `${sim.label} ${sp.name}`).toBe(cinc);
        expect(casino.computedIncEnded(T, cinc), `${sim.label} ${sp.name}`).toBe(false);
        expect(casino.isComputedFor(T, 'craps'), `${sim.label} ${sp.name}`).toBe(true);
        expect(casino.readTableOperatorLease()?.build, `${sim.label} ${sp.name}`).toBe(casino.TABLE_BUILD);
      }
      expect(rollsAt.end, sim.label).toBeGreaterThan(rollsAt.crash);
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🏛 A page shaped like PR 2's ─────────────────────────────────────────────
// PR 2's name readers, copied exactly from computedCrapsRecords.test.ts (its
// own copies of the build PR 2 shipped: casinoDoc COMPUTED_INC,
// computedKeyParts and computedCfgInc at e03c1f4).

const PR2_COMPUTED_INC = /^c[0-9a-f]{24}$/;
const PR2_COMPUTED_SID = /^(?:g|[0-9a-f]{24})$/;
function pr2KeyParts(key: string): { t: string; inc: string; sid?: string } | null {
  let rest: string;
  let sid: string | undefined;
  if (key.startsWith('ses:')) {
    const cut = key.lastIndexOf(':');
    sid = key.slice(cut + 1);
    if (cut <= 'ses:'.length || !PR2_COMPUTED_SID.test(sid)) return null;
    rest = key.slice('ses:'.length, cut);
  } else if (key.startsWith('sum:')) {
    rest = key.slice('sum:'.length);
  } else {
    return null;
  }
  const cut = rest.lastIndexOf(':');
  const inc = rest.slice(cut + 1);
  return cut > 0 && PR2_COMPUTED_INC.test(inc) ? { t: rest.slice(0, cut), inc, ...(sid !== undefined ? { sid } : {}) } : null;
}
function pr2CfgInc(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const cfg = value as { v?: unknown; inc?: unknown };
  return Object.keys(cfg).length === 2 && cfg.v === 1 && typeof cfg.inc === 'string' && PR2_COMPUTED_INC.test(cfg.inc)
    ? cfg.inc : null;
}

/**
 * What this can show, and what it can't. The ghost P is this build's page
 * with no frames of its own (no duty of this build's runs on it): every
 * record it writes is one a PR 2 page writes, by PR 2's rules as the specs
 * pin them: it reads the room with PR 2's readers (copies, faithful by
 * computedCrapsRecords' spec) and finds no computed craps table, so it runs
 * the table as owner-run (its lease, build 2; a come-out with its pass on
 * it), and later removes it as PR 2's clearTableKeys does (the copy in
 * computedCrapsRecords' removal spec), the furniture leaving every page's
 * room. So it shows how this build's pages take those records: nothing but
 * the removal ends the table, and the removal does. It can't show PR 2's
 * own code running: what PR 2's tick loop, duties or screens would write
 * beyond these records (its own sweeps or computed duties, say) isn't
 * exercised here, nor a PR 2 page's own reading of this build's records
 * beyond its name readers.
 */
describe("computed craps: a page shaped like PR 2's", () => {
  for (const n of SEEDS) {
    it(`pr2-ghost ${n}: a page shaped like PR 2's reads no computed craps table, takes the lease (build 2) and opens an owner-run come-out with its pass on it, beats a minute, goes quiet, and later removes the table: the table is never ended until the removal, which ends it on every page`, async () => {
      const sim = await Sim.open({
        name: 'craps-pr2', seed: seed(2900 + n), tables: crapsTable,
        pages: [...named('ABCD'), { name: 'P', honest: false, bot: null, place: 'off' }],
      });
      const { house } = sim;
      const g = sim.pages.find((sp) => sp.name === 'P')!;
      g.beforeFrame = () => false;
      const cinc = house.p.casino.computedIncOf(T)!;
      const t0 = 40_000;
      const quietAt = t0 + 60_000;
      const removeAt = quietAt + 40_000;
      let seen: { cfg: string | null; keys: number; ours: number } | null = null;
      let legacyInc = '';
      const samples = { n: 0, ended: [] as string[], driving: 0 };
      const rolls = { at: 0, removed: 0 };
      let removal: { ended: string[]; still: string[] } | null = null;
      // What PR 2's readers make of the room: the switch, and the computed
      // records of T.
      sim.at(t0, async () => {
        await sim.as(g, () => {
          const { doc, casino } = g.p;
          const keys = [...doc.getMap('casinoComputed').keys()];
          seen = {
            cfg: pr2CfgInc(doc.getMap('casino').get(`cfg:computed:${T}`)),
            keys: keys.filter((k) => pr2KeyParts(k)?.t === T).length,
            ours: keys.filter((k) => k.startsWith(`ses:${T}:`) || k.startsWith(`sum:${T}:`)).length,
          };
          // No computed table, so an owner-run one: its lease (build 2), a
          // come-out, its pass down.
          casino.writeTableOperatorLease({ page: `pr2-${g.name}`, player: house.pid, beat: 1, build: 2 });
          ownerRunOpens(g, 1, null);
          expect(casino.writeMyCrapsBets(T, g.pid, [pass(10)]), sim.label).toBe(true);
          legacyInc = casino.readCrapsTableState(T)!.inc!;
        });
        rolls.at = openRoll(sim, house);
      });
      for (let beat = 2; t0 + (beat - 1) * 2_000 < quietAt; beat++) {
        sim.at(t0 + (beat - 1) * 2_000, () => sim.as(g, () => g.p.casino.writeTableOperatorLease({ page: `pr2-${g.name}`, player: house.pid, beat, build: 2 })));
      }
      // And its robot croupier's beat, as PR 2's operator writes it at an
      // owner-run table (every 3 s): no robot of this build's moves for it.
      for (let b = t0 + 1_000; b < quietAt; b += 3_000) sim.at(b, () => sim.as(g, (now) => g.p.casino.writeCroupierBeat(T, now)));
      // Its removal: the furniture out of its room, and PR 2's
      // clearTableKeys on its page (no state up as it reads it, the house
      // having swept its round: it marks the owner-run name a fresh round
      // would take, reads the switch's craps name as none, so marks nothing
      // of it, and deletes the switch); the others hear the furniture leave
      // 50 to 400 ms on (as Sim.remove has them), each page of this build
      // closing the table as it hears (closeTable 'heard').
      sim.at(removeAt, async () => {
        rolls.removed = openRoll(sim, house);
        g.inRoom.delete(T);
        await sim.as(g, () => {
          const { doc, casino } = g.p;
          doc.transact(() => {
            const m = doc.getMap('casino');
            m.set(`gone:${T}:${casino.tableIncFor(T)}`, 1);
            m.delete(`cfg:computed:${T}`);
            for (const key of [...m.keys()]) {
              if ([`table:${T}`, `croupier:${T}`, `cfg:backend:${T}`, `cfg:fairness:${T}`, `throw:${T}`].includes(key)
                || ['bets', 'seat', 'fseed'].some((x) => key.startsWith(`${x}:${T}:`))) m.delete(key);
            }
          });
        });
        for (const [i, sp] of sim.pages.filter((q) => q !== g).entries()) {
          sim.at(removeAt + 50 + i * 100, async () => {
            sp.inRoom.delete(T);
            if (sp.mode === 'gone') return;
            await sim.as(sp, () => sp.p.croupier.closeTable(T, 'heard'));
          });
        }
      });
      // A second on: every page reads the table ended.
      sim.at(removeAt + 1_000, () => {
        const ended: string[] = [];
        const still: string[] = [];
        for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
          sim.enter(sp);
          const { casino } = sp.p;
          (!casino.isComputedTable(T) && casino.computedIncEnded(T, cinc) ? ended : still).push(sp.name);
        }
        removal = { ended, still };
      });
      // Until then, each second: on every page the table as it was, never
      // ended; and whether the house reads an older build driving it.
      sim.every(() => {
        if (sim.elapsed % 1_000 !== 0 || sim.elapsed < t0 || sim.elapsed >= removeAt) return;
        samples.n += 1;
        for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
          sim.enter(sp);
          const { casino } = sp.p;
          if (!casino.isComputedTable(T) || casino.computedIncOf(T) !== cinc || casino.computedIncEnded(T, cinc)) samples.ended.push(`${sp.name} at ${sim.elapsed} ms`);
        }
        sim.enter(house);
        if (house.p.table.computedOldBuildDriving(T)) samples.driving += 1;
      });
      await sim.run(removeAt + 120_000);
      const s = await finish(sim, lines, { bettors: 4 });
      console.log(`[craps] ${sim.label}: PR 2's readers ${JSON.stringify(seen)}, samples ${samples.n} (ended ${samples.ended.length}, an older build driving ${samples.driving}), rolls ${JSON.stringify(rolls)}, removal ${JSON.stringify(removal)}`);
      // PR 2's readers see no switch and no records of T, though the room
      // holds them.
      expect(seen, sim.label).toEqual({ cfg: null, keys: 0, ours: seen!.ours });
      expect(seen!.ours, sim.label).toBeGreaterThan(0);
      // Never ended while it ran the table as owner-run and went quiet; the
      // computed table rolled on meanwhile.
      expect(samples.n, sim.label).toBeGreaterThanOrEqual((removeAt - t0) / 1_000 - 1);
      expect(samples.ended, sim.label).toEqual([]);
      expect(samples.driving, sim.label).toBeGreaterThan(0);
      expect(rolls.removed, sim.label).toBeGreaterThan(rolls.at);
      // The removal ends it, on every page, at once; compaction then
      // finalises it. (A page that hears the keys go before the furniture
      // puts the switch back, PR 2's put-back of a switch a peer took away,
      // until the furniture's leaving reaches it: then its own closeTable
      // ends it. Heard together, this build reads the incarnation as not
      // live and compacts it: design, casinoDoc, "A PR 2 page's removal".)
      expect(removal, sim.label).toEqual({ ended: sim.pages.filter((q) => q.mode === 'up').map((q) => q.name), still: [] });
      for (const sp of sim.pages.filter((q) => q.mode === 'up')) {
        sim.enter(sp);
        const { casino, doc } = sp.p;
        expect(casino.isComputedTable(T), `${sim.label} ${sp.name}`).toBe(false);
        expect(casino.computedIncEnded(T, cinc), `${sim.label} ${sp.name}`).toBe(true);
        expect([...doc.getMap('casinoComputed').keys()].filter((k) => k.startsWith(`ses:${T}:`)), `${sim.label} ${sp.name}`).toEqual([]);
        expect(doc.getMap('casinoComputed').get(`sum:${T}:${cinc}`), `${sim.label} ${sp.name}`).toMatchObject({ v: 1, e: 1 });
        // Its owner-run round swept away (its pass back) before the removal.
        expect(casino.tableIncRemoved(T, legacyInc), `${sim.label} ${sp.name}`).toBe(true);
        expect(casino.readChips(g.pid), `${sim.label} ${sp.name}`).toBe(1_000);
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

// ── 🏘️ A mixed room ──────────────────────────────────────────────────────────

const R = 'roulette-1';

describe('computed craps: a mixed room', () => {
  for (const n of SEEDS) {
    it(`mixed-room ${n}: a roulette and a craps table share the room's size budget: each table's weight counts toward it, and junk in one table's session (a modified page's, while that table's last round waits on a seed) makes the other trim on the room's pressure alone, both ways`, async () => {
      const sim = await Sim.open({
        name: 'craps-mixed-room', seed: seed(3000 + n), tables: [{ id: T, game: 'craps' }, { id: R, game: 'roulette' }],
        pages: [...named('ABCD'), { name: 'X', honest: false, bot: null, place: 'off' }],
      });
      const [a] = sim.pages;
      const honest = sim.pages.slice(0, 4);
      const x = sim.pages.find((sp) => sp.name === 'X')!;
      x.cheats = true;
      x.beforeFrame = () => false;
      const tbl = a.p.table;
      // Phase 1: junk into the roulette session, the craps table trims;
      // phase 2: junk into the craps session, the roulette table trims.
      const phases = [{ junk: R, trimmed: T }, { junk: T, trimmed: R }];
      type Seen = { u: number; at: number; pre: { rawBytes: number; rounds: number; sevenOut: boolean; room: number } | null };
      const got: { junkAt: number; junkBytes: number; paused: string; trim: Seen | null; junkTrimmedAt: number | null }[] = [];
      let k = 0;
      let ready = false;
      let junkDue: { bytes: number } | null = null;
      const lastCp = new Map<string, string>();
      const pre = new Map<string, Seen['pre']>();
      const sums = { n: 0, off: [] as string[] };
      const rawOf = (sp: SimPage, t: string): number => sp.p.casino.computedFoldOf(t)?.rawBytes ?? 0;
      // The trimmed table, as A reads it: no close in, weighing past the
      // room's floor but short of its own trim, short of TRIM_ROUNDS (and,
      // at craps, of a long hand's seven-out), betting with 6 s to go.
      const quiet = (t: string, now: number): boolean => {
        const res = a.p.casino.computedFoldOf(t);
        if (!res || res.tip) return false;
        const D = lastDecided(res);
        if (!D) return false;
        const rounds = D.r - res.base.u;
        if (res.rawBytes < tbl.ROOM_MIN_BYTES || res.rawBytes > tbl.TRIM_BYTES - 16_384 || rounds > tbl.TRIM_ROUNDS - 3) return false;
        if (D.craps?.sevenOut && rounds >= TRIM_SEVEN_OUT_MIN) return false;
        const v = t === T ? tbl.readComputedCraps(t, now) : tbl.readComputedRoulette(t, now);
        return !!v && v.phase === 'betting' && v.phaseDeadline !== undefined && v.phaseDeadline - now >= 6_000;
      };
      sim.every(async () => {
        if (a.mode !== 'up') return;
        const now = sim.enter(a);
        const { casino, doc } = a.p;
        // The room's weight is its tables' sessions', on every page.
        if (sim.elapsed % 1_000 === 0) {
          for (const sp of honest.filter((q) => q.mode === 'up')) {
            sim.enter(sp);
            sums.n += 1;
            const room = sp.p.casino.computedRoomBytes();
            const both = rawOf(sp, T) + rawOf(sp, R);
            if (room !== both) sums.off.push(`${sp.name} at ${sim.elapsed} ms: ${room} ≠ ${both}`);
          }
          sim.enter(a);
        }
        // Each table's checkpoints as A first sees them, with A's fold of
        // the session they closed the tick before.
        for (const t of [T, R]) {
          const inc = casino.computedIncOf(t)!;
          const cp = doc.getMap('casinoComputed').get(`sum:${t}:${inc}`) as Checkpoint | undefined;
          const key = cp ? `${cp.u}|${cp.l}` : '';
          if (key !== (lastCp.get(t) ?? '')) {
            lastCp.set(t, key);
            const g = got[k - 1];
            if (g && cp && g.trim === null && t === phases[k - 1].trimmed) g.trim = { u: cp.u, at: sim.elapsed, pre: pre.get(t) ?? null };
            if (g && cp && g.junkTrimmedAt === null && t === phases[k - 1].junk) g.junkTrimmedAt = sim.elapsed;
          }
          const res = casino.computedFoldOf(t);
          const D = res ? lastDecided(res) : null;
          if (res && D) pre.set(t, { rawBytes: res.rawBytes, rounds: D.r - res.base.u, sevenOut: D.craps?.sevenOut === true, room: casino.computedRoomBytes() });
        }
        // The junk, the tick after a slow page was caught (below).
        if (junkDue) {
          const { bytes } = junkDue;
          junkDue = null;
          const t = phases[k - 1].junk;
          await sim.as(x, () => {
            const ses = x.p.casino.computedSessionForWrite(t)!;
            x.p.doc.transact(() => ses.set(`zz:junk:${k}`, 'j'.repeat(bytes)));
          });
          return;
        }
        // Armed once the last phase's junk is out of the room.
        const prev = got[k - 1];
        ready = k < phases.length && (!prev || (prev.trim !== null && prev.junkTrimmedAt !== null)) && quiet(phases[k].trimmed, now);
      });
      // A page frozen in the junk table's close, its seed not yet out, goes
      // slow for 5 s (a throttled tab: under a lapse, no wake) while the room
      // is ready: that table's round waits on its seed (the grace, then a
      // forfeit), so no trim of its own takes the junk out meanwhile.
      for (const sp of honest) {
        sp.beforeFrame = () => {
          if (!ready || junkDue || k >= phases.length) return true;
          const tip = sp.p.casino.computedFoldOf(phases[k].junk)?.tip;
          if (!tip || !tip.present.includes(sp.pid) || tip.revealed.includes(sp.pid)) return true;
          sp.pauseUntil = sim.T + 5_000;
          const bytes = sp.p.table.ROOM_BYTES - (rawOf(sp, T) + rawOf(sp, R)) + 16_384;
          got.push({ junkAt: sim.elapsed, junkBytes: bytes, paused: sp.name, trim: null, junkTrimmedAt: null });
          junkDue = { bytes };
          ready = false;
          k += 1;
          return false;
        };
      }
      for (let i = 0; i < 90 && !(got.length === phases.length && got.every((g) => g.trim && g.junkTrimmedAt)); i++) await sim.run(10_000);
      await sim.run(20_000);
      // (The paused page's seed comes late: a forfeit decides the round
      // without it, or its reveal does after all; either way no round any
      // page showed changes.)
      const s = await finish(sim, lines, { bettors: 4 });
      console.log(`[craps] ${sim.label}: room sums ${sums.n} (off ${sums.off.length}), phases ${JSON.stringify(got)}`);
      expect(sums.n, sim.label).toBeGreaterThan(0);
      expect(sums.off, sim.label).toEqual([]);
      expect(got.length, sim.label).toBe(phases.length);
      for (const [i, g] of got.entries()) {
        const at = `${sim.label} phase ${i + 1} (${phases[i].trimmed} trims)`;
        // The trimmed table trimmed, its session past the room's floor but
        // pressed by nothing of its own: not its size (TRIM_BYTES), not its
        // rounds (TRIM_ROUNDS), not a long hand's seven-out; only the room's
        // weight past ROOM_BYTES (trimDuty).
        expect(g.trim, at).not.toBeNull();
        const p = g.trim!.pre!;
        expect(p.room, at).toBeGreaterThanOrEqual(tbl.ROOM_BYTES);
        expect(p.rawBytes, at).toBeGreaterThanOrEqual(tbl.ROOM_MIN_BYTES);
        expect(p.rawBytes, at).toBeLessThan(tbl.TRIM_BYTES);
        expect(p.rounds, at).toBeLessThan(tbl.TRIM_ROUNDS);
        expect(p.sevenOut && p.rounds >= TRIM_SEVEN_OUT_MIN, at).toBe(false);
        expect(g.trim!.at - g.junkAt, at).toBeLessThan(10_000);
        // And the junk table then trimmed the junk away.
        expect(g.junkTrimmedAt, at).not.toBeNull();
      }
      for (const sp of honest.filter((q) => q.mode === 'up')) {
        sim.enter(sp);
        expect(sp.p.casino.computedRoomBytes(), `${sim.label} ${sp.name}`).toBeLessThan(tbl.ROOM_BYTES);
      }
      expect(s.rounds, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});
