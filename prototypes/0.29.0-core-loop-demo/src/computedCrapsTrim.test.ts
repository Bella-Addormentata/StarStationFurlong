/**
 * 🎲🧮🧹 Trimming a computed craps table (computedTable trimDuty, noteResult,
 * windowOf): the checkpoint hands the table's state on (`s`: the point, the
 * bets riding, the dice), the open roll's latest felts go across byte for
 * byte with the stamps they were built on, every page keeps the window it
 * had, and nobody's chips move. A seven-out once the hand has run long is a
 * trim of its own, and a checkpoint that hands on another table than the
 * one a page played shows on that page's ⚙ card; one at a roll the page
 * played otherwise shows no roll there, and waits for a fling of its own.
 *
 * Each page is its own load of the casino modules with its own Y.Doc,
 * player id and identity key (computedPageKit), synced by hand, every clock
 * explicit, its table session standing where a spec puts it (standAt), the
 * dice chosen through the seeds (rigRoll). Who trims first is whoever
 * dutyRank puts first for that page's key, so specs work it out from the
 * keys. Most specs make the trim due at once with junk the fold weighs and
 * never reads (a session past TRIM_BYTES).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basisOf, EMPTY_CARRY, own } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
import { asCheckpointFor, nextSid } from './computedFold';
import type { Checkpoint, CrapsSlipRec } from './computedFold';
import {
  carryOf, clockOf, CRAPS_CTX as CTX, CRAPS_INC as INC, CRAPS_REF as REF, CRAPS_TABLE as TABLE, crapsBet, crapsOf, crapsPointOn, keysIn,
  loadPage, openCrapsRoom, putIn, rigRoll, run, standAt, sync, trimByHand,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import type { CrapsBet } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

// As in computedCrapsDuties: roulette's slip reader throws at a craps table.
vi.doMock('./computedFold', async (importOriginal) => {
  const real = await importOriginal<typeof import('./computedFold')>();
  const no = (): never => {
    throw new Error("roulette's slip reader at a craps table");
  };
  return { ...real, asSlip: no, slipKey: no };
});

const T0 = 2_000_000_000;
const STEP = 200;
const W_MS = 16_000;
const kit = new ComputedKit(CTX);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const bet = (type: CrapsBet['type'], amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const computedOf = (p: Page) => p.doc.getMap('casinoComputed');
const cpOf = (p: Page): Checkpoint | null => asCheckpointFor(CTX)(computedOf(p).get(`sum:${TABLE}:${INC}`));
const sessionsOf = (p: Page): string[] => [...computedOf(p).keys()].filter((k) => k.startsWith(`ses:${TABLE}:${INC}:`)).sort();
const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const slipsOf = (p: Page, r: number, pid: string): string[] => keysIn(p, 's', r, TABLE).filter((k) => k.startsWith(`s:${r}:${pid}:`));
const latestOf = (p: Page, pid: string): CrapsSlipRec => foldOf(p).felts.get(pid)!.rec as CrapsSlipRec;
const entry = (x: { key: string; rec: unknown }): [string, unknown] => [x.key, x.rec];
const feltKeys = (p: Page): string[] => [...foldOf(p).felts.values()].map((s) => s.key).sort();
const chipsOn = (on: Page, pages: Page[]): number[] => pages.map((q) => on.casino.readChips(q.pid));
const signer = (pages: Page[], k: string): string | undefined => pages.find((p) => p.pub === k)?.name;
const trimmedTo = (p: Page, u: number): boolean => foldOf(p).base.u >= u;
const go = (pages: Page[], from: number, to: number, until?: () => boolean): number =>
  run(pages, from, to, { step: STEP, tables: [REF], until });
const decide = (pages: Page[], r: number, from: number, to = from + 60_000): number =>
  go(pages, from, to, () => pages.every((p) => foldOf(p).rounds.some((v) => v.r === r && v.decided !== null)));
const roundOf = (p: Page, r: number) => foldOf(p).rounds.find((v) => v.r === r)!;
/** A duty due at `due` ran on the first tick at or after it. */
function expectAt(at: number, due: number): void {
  expect(at).toBeGreaterThanOrEqual(due);
  expect(at).toBeLessThan(due + STEP);
}

/** Test identities as players of the room: each pinned on page p. */
function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Junk the fold weighs (rawBytes) and never reads, a session's worth of
 *  it, in the live session on page p: due a trim. */
function weigh(p: Page): void {
  putIn(p, [['junk', 'x'.repeat(p.table.TRIM_BYTES)]], TABLE);
}

/** Frames until every page takes bets on roll 2 with a window (the riders'
 *  ride slips down): that time + STEP. */
function openRoll2(pages: Page[], decidedAt: number, showEnd: number): number {
  return go(pages, decidedAt + STEP, showEnd + 5_000, () => pages.every((p) => crapsOf(p)?.phaseDeadline !== undefined)) + STEP;
}

describe('a trim mid-betting', () => {
  it("takes the open felts across byte for byte, keeps every page's window and the table's state, and moves nobody's chips", async () => {
    // Roll 1: A's pass and place 8 at stand 1, field bets for B and C at 3
    // and 5. A 6: the point is on, A's bets ride, the fields lost.
    const pages = await openCrapsRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    pages.forEach((p, i) => standAt(p, 1 + 2 * i));
    rigRoll(pages, 1, 6);
    expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('field', 5)], T0)).toBe('ok');
    expect(crapsBet(c, [bet('field', 20)], T0)).toBe('ok');
    sync(T0, ...pages);
    const decidedAt = decide(pages, 1, T0 + STEP);
    const showEnd = crapsOf(a, decidedAt)!.resultAt + a.croupier.CRAPS_SHOW_MS;
    const carry = carryOf(a);
    expect(carry.p).toBe(6);
    expect(Object.keys(carry.w)).toEqual([a.pid]);
    const close1 = foldOf(a).rounds[0].close;
    rigRoll(pages, 2, 6);
    // Roll 2 opens with A's ride slip, the only one: it starts every page's
    // window. B and C bet two seconds on; then A puts a field bet with its
    // riding ones and B a place 9 with its field: the trim copies neither
    // version that came first.
    const opened = go(pages, decidedAt + STEP, showEnd + 5_000, () => pages.every((p) => crapsOf(p)?.phaseDeadline !== undefined));
    expect(opened).toBe(showEnd);
    const back = opened + 2_000;
    go(pages, opened + STEP, back - STEP);
    expect(crapsBet(b, [bet('field', 2)], back)).toBe('ok');
    expect(crapsBet(c, [bet('field', 10)], back)).toBe('ok');
    go(pages, back, back + 1_000);
    const T = back + 1_000 + STEP;
    expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8), bet('field', 5)], T)).toBe('ok');
    expect(crapsBet(b, [bet('field', 2), bet('place', 5, 9)], T)).toBe('ok');
    go(pages, T + STEP, T + 1_000);
    expect([a, b, c].map((p) => slipsOf(a, 2, p.pid).length)).toEqual([2, 2, 1]);
    const U = T + 1_000 + STEP;
    for (const p of pages) expect(crapsOf(p, U)!.phaseDeadline).toBe(showEnd + W_MS);
    const felts = feltKeys(a);
    const bytes = felts.map((k) => JSON.stringify(recOf(a, k)));
    for (const k of felts) expect((recOf<CrapsSlipRec>(a, k)).o).toBeDefined();
    const nets = foldOf(a).nets;
    const held = foldOf(a).held;
    const chips = chipsOn(a, pages);
    expect(chips).toEqual([979, 988, 970]);
    for (const p of pages) expect(chipsOn(p, pages)).toEqual(chips);

    // Due at once, and long past every bettor's turn: each trims on its next
    // tick (the same checkpoint but its signer, so one session).
    weigh(a);
    sync(U, ...pages);
    const trimmed = go(pages, U + STEP, U + 5_000, () => pages.every((p) => trimmedTo(p, 1)));
    expectAt(trimmed, U + STEP);
    const cp = cpOf(a)!;
    expect(signer(pages, cp.k)).toBeDefined();
    expect(cp).toMatchObject({ v: 1, b: 'g', u: 1, l: close1 });
    expect(cp.n).toEqual(Object.fromEntries([...nets].map(([pid, n]) => [pid, n.toString()])));
    expect(cp.s).toEqual(carry);
    for (const p of pages) {
      expect(cpOf(p)).toEqual(cp);
      expect(foldOf(p).base).toMatchObject({ u: 1, sid: nextSid(CTX, cp) });
      expect(foldOf(p).base.state).toEqual(carry);
      expect(carryOf(p)).toEqual(carry);
      expect(sessionsOf(p)).toEqual([`ses:${TABLE}:${INC}:${nextSid(CTX, cp)}`]);
      // The latest versions only, byte for byte, stamps and stands with them.
      expect(keysIn(p, 's', 2, TABLE).sort()).toEqual(felts);
      expect(felts.map((k) => JSON.stringify(recOf(p, k)))).toEqual(bytes);
      expect(foldOf(p).held).toEqual(held);
      expect(chipsOn(p, pages)).toEqual(chips);
      // The window as it was, the version that opened it gone.
      expect(crapsOf(p, trimmed)).toMatchObject({ phase: 'betting', round: 2, phaseDeadline: showEnd + W_MS });
      expect(p.table.computedRoundCheck(TABLE, trimmed)).toMatchObject({ round: 1, checkpointDiff: 0 });
    }

    // And the roll plays on the riding bets as carried: the point made, A's
    // pass paid and its place 8 still up, the fields lost.
    decide(pages, 2, trimmed + STEP, trimmed + 60_000);
    for (const p of pages) {
      expect(roundOf(p, 2)).toMatchObject({ decided: 'reveals' });
      expect(roundOf(p, 2).craps!.dice!.reduce((x, d) => x + d, 0)).toBe(6);
      expect(own(carryOf(p).w, a.pid)).toEqual([bet('place', 6, 8)]);
      expect(chipsOn(p, pages)).toEqual([999, 988, 970]);
    }
  });

  it('by two pages at once, neither hearing the other: one session, the same table state, its felts and windows intact', async () => {
    const { pages, decidedAt, showEnd } = await crapsPointOn(['A', 'B', 'C'], [1, 3, 5], T0);
    const [a, b, c] = pages;
    const carry = carryOf(a);
    const T = openRoll2(pages, decidedAt, showEnd);
    expect(crapsBet(b, [bet('pass', 5), bet('field', 2)], T + 1_000)).toBe('ok');
    sync(T + 1_000, ...pages);
    const felts = feltKeys(a);
    expect(felts).toHaveLength(3);
    const windows = pages.map((p) => crapsOf(p, T + 1_000)!.phaseDeadline);
    const chips = chipsOn(a, pages);
    // A and B each trim on their own (C quiet), then meet.
    const from = T + 1_000 + STEP;
    for (const p of [a, b]) {
      weigh(p);
      expect(go([p], from, from + 5_000, () => trimmedTo(p, 1))).toBeLessThan(from + 5_000);
    }
    const sids = [a, b].map((p) => foldOf(p).base.sid);
    expect(sids[0]).toBe(sids[1]);
    expect(cpOf(a)!.k).toBe(a.pub);
    expect(cpOf(b)!.k).toBe(b.pub);
    expect(cpOf(a)!.s).toEqual(cpOf(b)!.s);
    const meet = from + 6_000;
    sync(meet, ...pages);
    for (const [i, p] of pages.entries()) {
      expect(foldOf(p).base).toMatchObject({ u: 1, sid: sids[0] });
      expect([a.pub, b.pub]).toContain(cpOf(p)!.k);
      expect(cpOf(p)!.s).toEqual(carry);
      expect(sessionsOf(p)).toEqual([`ses:${TABLE}:${INC}:${sids[0]}`]);
      expect(feltKeys(p)).toEqual(felts);
      expect(carryOf(p)).toEqual(carry);
      expect(chipsOn(p, pages)).toEqual(chips);
      expect(crapsOf(p, meet)).toMatchObject({ phase: 'betting', round: 2, phaseDeadline: windows[i] });
    }
    // The roll plays on the one session.
    decide(pages, 2, meet + STEP, meet + 60_000);
    for (const p of pages) {
      expect(roundOf(p, 2)).toMatchObject({ decided: 'reveals', present: [a.pid, b.pid, c.pid].sort() });
      expect(chipsOn(p, pages)).toEqual(chipsOn(a, pages));
    }
  });

  it('after a void at a full table: a checkpoint that passes its own checks, every felt as its player left it', async () => {
    const pages = await openCrapsRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    pages.forEach((p, i) => standAt(p, 1 + 2 * i));
    // Roll 1: 28 more players, their slips written by hand, bet the pass
    // line with A (pass and place 8) and B (place 8, off on the come-out);
    // C bets the field. A 6: 30 riders, C none of them.
    const xs = Array.from({ length: 28 }, (_, i) => testIdentity(`void-x${i}`, `player-x${i}`));
    const m = testIdentity('void-m', 'player-m');
    const n = testIdentity('void-n', 'player-n');
    for (const p of pages) pinOn(p, ...xs, m, n);
    for (const id of [...xs, m, n]) a.casino.buyInChips(id.pid, 1_000);
    putIn(a, xs.map((id) => entry(kit.crapsSlip(id, 1, [bet('pass', 1)], basisOf(EMPTY_CARRY, id.pid)))), TABLE);
    rigRoll(pages, 1, 6, xs.map((id) => kit.seed(id.pid, 1)));
    expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('place', 5, 8)], T0)).toBe('ok');
    expect(crapsBet(c, [bet('field', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    const closed1 = go(pages, T0 + STEP, T0 + 60_000, () => keysIn(a, 'c', 1, TABLE).length > 0);
    putIn(a, xs.map((id) => entry(kit.reveal(1, id.pid))), TABLE);
    const decidedAt = decide(pages, 1, closed1 + STEP);
    const showEnd = crapsOf(a, decidedAt)!.resultAt + a.croupier.CRAPS_SHOW_MS;
    expect(roundOf(a, 1)).toMatchObject({ decided: 'reveals' });
    expect(carryOf(a).p).toBe(6);
    expect(Object.keys(carryOf(a).w)).toHaveLength(30);
    // Roll 2: B takes everything down, A adds a field bet, and M and N, new,
    // bet the field: M takes the last place, none is left for N (B rides
    // until the roll plays). B's page goes, and A's the moment it has
    // closed the roll.
    const T = openRoll2(pages, decidedAt, showEnd) + 1_000;
    expect(crapsBet(b, [], T)).toBe('ok');
    expect(crapsBet(a, [bet('pass', 10), bet('place', 6, 8), bet('field', 5)], T)).toBe('ok');
    putIn(a, [m, n].map((id) => entry(kit.crapsSlip(id, 2, [bet('field', 1)], basisOf(carryOf(a), id.pid)))), TABLE);
    sync(T, ...pages);
    const closed = go([a, c], T + STEP, T + 90_000, () => keysIn(c, 'c', 2, TABLE).length > 0);
    // The empty slip over B's riding bets is in the close, with M's and N's.
    expect(Object.keys(foldOf(c).tip!.frozen).sort()).toEqual([a.pid, b.pid, m.pid, n.pid].sort());
    expect(latestOf(c, b.pid).b).toEqual([]);
    // Nobody can finish it: C, a bettor of the session, abandons it in its turn.
    const voided = go([c], closed + STEP, closed + 120_000, () => roundOf(c, 2)?.decided === 'void');
    expect(voided).toBeGreaterThanOrEqual(closed + 30_000);
    expect(keysIn(c, 'z', 2, TABLE)).toHaveLength(1);
    const D = roundOf(c, 2);
    expect(D.craps!.fates.get(b.pid)).toBe('ok');
    expect(D.craps!.fates.get(m.pid)).toBe('ok');
    expect(D.craps!.fates.get(n.pid)).toBe('full');
    // Nothing moved: the point stays, B's take-down and the field bets of A
    // and M stand, N has nothing on, every rider gone from the room rides on.
    const sOut = D.craps!.sOut;
    expect(sOut.p).toBe(6);
    expect(own(sOut.w, b.pid)).toEqual([]);
    expect(own(sOut.w, n.pid)).toEqual([]);
    expect(own(sOut.w, c.pid)).toEqual([]);
    expect(own(sOut.w, a.pid)).toEqual([bet('field', 5), bet('pass', 10), bet('place', 6, 8)]);
    expect(own(sOut.w, m.pid)).toEqual([bet('field', 1)]);
    for (const id of xs) expect(own(sOut.w, id.pid)).toEqual([bet('pass', 1)]);
    expect(Object.keys(sOut.w)).toHaveLength(30);
    expect(carryOf(c)).toEqual(sOut);
    const chips = chipsOn(c, pages);
    expect(chips).toEqual([979, 1_000, 995]);
    expect(c.casino.readChips(n.pid)).toBe(1_000);
    // Due: C, on none of the void's felts, trims once nothing new has come
    // for TRIM_FALLBACK_MS, and its checkpoint reads back by the craps
    // checks (cpOf).
    weigh(c);
    const trimmed = go([c], voided + STEP, voided + 300_000, () => trimmedTo(c, 2));
    expect(trimmed).toBeLessThan(voided + 300_000);
    expect(cpOf(c)).toMatchObject({ u: 2, l: D.close, k: c.pub });
    expect(cpOf(c)!.s).toEqual(sOut);
    expect(carryOf(c)).toEqual(sOut);
    expect(chipsOn(c, pages)).toEqual(chips);
    expect(c.casino.readChips(n.pid)).toBe(1_000);
    expect(c.table.computedRoundCheck(TABLE, trimmed)).toMatchObject({ round: 2, decided: 'void', checkpointDiff: 0 });
    // A's and B's pages, back, read the same table and the same chips.
    sync(trimmed + STEP, ...pages);
    for (const p of [a, b]) {
      expect(carryOf(p)).toEqual(sOut);
      expect(chipsOn(p, pages)).toEqual(chips);
    }
  }, 30_000);
});

describe("a seven-out's trim", () => {
  it('comes once the hand has run TRIM_SEVEN_OUT_MIN rolls past the checkpoint: not on an earlier seven-out, nor on a seven on the come-out', async () => {
    // A alone, off the table: nobody holds the dice, so each roll closes
    // when its betting ends.
    const [a] = await openCrapsRoom(['A'], T0);
    standAt(a, null);
    const pass = bet('pass', 10);
    const field = bet('field', 1);
    let T = T0;
    /** Roll r with A's felt and the dice summing `sum`: when it decided. */
    const roll = (r: number, felt: CrapsBet[], sum: number): number => {
      expect(foldOf(a).open).toBe(r);
      rigRoll([a], r, sum);
      expect(crapsBet(a, felt, T)).toBe('ok');
      const at = decide([a], r, T + STEP);
      expect(roundOf(a, r)).toMatchObject({ decided: 'reveals' });
      expect(roundOf(a, r).craps!.dice!.reduce((x, d) => x + d, 0)).toBe(sum);
      T = go([a], at + STEP, at + 30_000, () => crapsOf(a)?.phase === 'betting' && crapsOf(a)?.round === r + 1);
      return at;
    };
    roll(1, [pass], 6);
    roll(2, [pass, field], 7);
    expect(roundOf(a, 2).craps!.sevenOut).toBe(true);
    // (Too soon in the hand: no trim.)
    expect(foldOf(a).base.u).toBe(0);
    roll(3, [pass], 8);
    for (const [r, sum] of [[4, 9], [5, 10], [6, 4], [7, 5]]) roll(r, [pass, field], sum);
    expect(foldOf(a).base.u).toBe(0);
    // Roll 8, a seven-out eight rolls past the checkpoint: a trim, a second
    // after A saw it decided.
    rigRoll([a], 8, 7);
    expect(crapsBet(a, [pass, field], T)).toBe('ok');
    const at8 = decide([a], 8, T + STEP);
    expect(roundOf(a, 8).craps!.sevenOut).toBe(true);
    const close8 = roundOf(a, 8).close;
    const carry = carryOf(a);
    expect(carry.p).toBe(0);
    expect(Object.keys(carry.w)).toEqual([]);
    const chips = a.casino.readChips(a.pid);
    const trimmed = go([a], at8 + STEP, at8 + 5_000, () => trimmedTo(a, 8));
    expectAt(trimmed, at8 + 1_000);
    expect(cpOf(a)).toMatchObject({ u: 8, l: close8 });
    expect(cpOf(a)!.s).toEqual(carry);
    expect(a.casino.readChips(a.pid)).toBe(chips);
    T = go([a], trimmed + STEP, trimmed + 30_000, () => crapsOf(a)?.phase === 'betting' && crapsOf(a)?.round === 9);
    // Eight rolls past it again, the last a seven on the come-out (no
    // seven-out: the point was off): no trim.
    for (const [r, sum] of [[9, 11], [10, 3], [11, 12], [12, 2], [13, 11], [14, 3], [15, 12], [16, 7]]) roll(r, [field], sum);
    expect(roundOf(a, 16).craps!.sevenOut).toBe(false);
    expect(foldOf(a).base.u).toBe(8);
  }, 60_000);
});

describe('a checkpoint handing on another table', () => {
  it("shows on the ⚙ card of every page that played the roll before: by the chips its riding bets differ, one for a point or a holder alone", async () => {
    const variants: [string, (s: CrapsCarry, a: Page, b: Page) => CrapsCarry, number][] = [
      ['the table as it is', (s) => s, 0],
      ["A's pass 30, not 10", (s, a) => ({ ...s, w: { ...s.w, [a.pid]: [bet('pass', 30)] } }), 20],
      ["B's pass gone", (s, _a, b) => ({ ...s, w: Object.fromEntries(Object.entries(s.w).filter(([pid]) => pid !== b.pid)) }), 5],
      ['the point an 8', (s) => ({ ...s, p: 8 }), 1],
      ['the dice with the other player', (s, a, b) => ({ ...s, h: s.h === a.pid ? b.pid : a.pid }), 1],
    ];
    for (const [i, [what, forge, diff]] of variants.entries()) {
      const { pages: [a, b], decidedAt } = await crapsPointOn(['A', 'B'], [1, 3], T0);
      const carry = carryOf(a);
      const forged = forge(carry, a, b);
      const T = decidedAt + STEP;
      for (const p of [a, b]) expect(p.table.computedRoundCheck(TABLE, T), what).toMatchObject({ round: 1, checkpointDiff: 0 });
      clockOf(a, T);
      trimByHand(a, testIdentity(`craps-forge-${i}`), undefined, TABLE, forged);
      sync(T, a, b);
      for (const p of [a, b]) {
        expect(foldOf(p).base.u, what).toBe(1);
        // The table plays from what the checkpoint says; the card says it differs.
        expect(carryOf(p), what).toEqual(forged);
        expect(p.table.computedRoundCheck(TABLE, T), what).toMatchObject({ round: 1, checkpointDiff: diff });
      }
    }
  });

  it('at a roll another page played as its own on the other side of a split: that page shows no roll there, and its card no verdict on its own', async () => {
    const pages = await openCrapsRoom(['A', 'B'], T0);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    // Apart: A's pass rolls a 6 and A trims at it; B's pass, on a roll 1 of
    // its own, an 8.
    rigRoll([a], 1, 6);
    rigRoll([b], 1, 8);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    const da = decide([a], 1, T0 + STEP);
    weigh(a);
    const ta = go([a], da + STEP, da + 60_000, () => trimmedTo(a, 1));
    expect(ta).toBeLessThan(da + 60_000);
    const db = decide([b], 1, T0 + STEP);
    expect(trimmedTo(b, 1)).toBe(false);
    const own = roundOf(b, 1).close;
    const T = Math.max(ta, db) + 10_000;
    const sum = (key: string): number => [...key.slice(key.indexOf(':') + 1)].reduce((n, d) => n + Number(d), 0);
    const shown = crapsOf(a, T)!.rollKey;
    expect(sum(shown)).toBe(6);
    expect(crapsOf(b, T)).toMatchObject({ phase: 'betting', round: 2, point: 8 });
    expect(sum(crapsOf(b, T)!.rollKey)).toBe(8);
    expect(b.table.computedRoundCheck(TABLE, T)).toMatchObject({ round: 1, roll: { pointAfter: 8 } });
    // They meet: A's checkpoint at roll 1 is the only one, and B's roll 1 is
    // gone with the session B played it in.
    sync(T, a, b);
    for (const p of pages) {
      expect([foldOf(p).base.u, foldOf(p).base.l, foldOf(p).rounds.length]).toEqual([1, foldOf(a).base.l, 0]);
      expect(carryOf(p).p).toBe(6);
    }
    expect(foldOf(b).base.l).not.toBe(own);
    // A shows its roll 1 through the trim, its card its verdict; B never saw
    // that roll 1, and shows no roll and no verdict, not its own.
    expect(crapsOf(a, T)!.rollKey).toBe(shown);
    expect(a.table.computedRoundCheck(TABLE, T)).toMatchObject({ round: 1, roll: { pointAfter: 6 } });
    expect(crapsOf(b, T)).toMatchObject({ phase: 'betting', round: 2, point: 6, dice: null, result: null, rollKey: '', rollBy: '' });
    expect(b.table.computedRoundCheck(TABLE, T)).toBeNull();
  });

  it('at a roll both sides saw decided, the other side playing a roll past it as its own: that side shows the roll the checkpoint kept again, and its card its verdict', async () => {
    const pages = await openCrapsRoom(['A', 'B'], T0);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    // Together: roll 1 a 6, the point on.
    rigRoll(pages, 1, 6);
    expect(crapsBet(a, [bet('pass', 10)], T0)).toBe('ok');
    expect(crapsBet(b, [bet('pass', 5)], T0)).toBe('ok');
    sync(T0, ...pages);
    const d1 = decide(pages, 1, T0 + STEP);
    const close1 = roundOf(a, 1).close;
    const T1 = d1 + 10_000;
    go(pages, d1 + STEP, T1);
    const sum = (key: string): number => [...key.slice(key.indexOf(':') + 1)].reduce((n, d) => n + Number(d), 0);
    const shown = crapsOf(a, T1)!.rollKey;
    expect(sum(shown)).toBe(6);
    expect(a.table.computedRoundCheck(TABLE, T1)).toMatchObject({ round: 1, roll: { pointAfter: 6 } });
    // Apart: B trims at roll 1; A plays a roll 2 alone.
    weigh(b);
    const tb = go([b], T1 + STEP, T1 + 60_000, () => trimmedTo(b, 1));
    expect(tb).toBeLessThan(T1 + 60_000);
    expect(crapsBet(a, [bet('pass', 10), bet('field', 5)], T1 + STEP)).toBe('ok');
    const d2 = decide([a], 2, T1 + 2 * STEP, T1 + 90_000);
    expect(trimmedTo(a, 1)).toBe(false);
    const T = Math.max(tb, d2) + 10_000;
    go([a], d2 + STEP, T - STEP);
    expect(crapsOf(a, T)!.rollKey).toMatch(/^2:\d\d$/);
    // They meet: B's checkpoint at roll 1, under the close A saw decide it,
    // is the only one, and A's roll 2 is gone with its session.
    sync(T, a, b);
    expect(foldOf(a).base).toMatchObject({ u: 1, l: close1 });
    expect(foldOf(a).rounds).toEqual([]);
    expect(carryOf(a).p).toBe(6);
    expect(a.table.computedDecidedTo(TABLE)).toBe(1);
    // A shows roll 1 again through the trim, as B does, and its verdict.
    expect(crapsOf(a, T)).toMatchObject({ round: 2, point: 6, rollKey: shown, rollBy: close1 });
    expect(a.table.computedRoundCheck(TABLE, T)).toMatchObject({ round: 1, roll: { pointAfter: 6 } });
  });

  it('at a roll the shooter flung and closed on the other side of a split: the roll on the chain waits for a fling of its own', async () => {
    const { pages, decidedAt } = await crapsPointOn(['A', 'B', 'C'], [1, 3, 5], T0);
    const [a, b, c] = pages;
    // Apart: A trims at roll 1; B, with the dice, and C play roll 2, B
    // flinging and closing it, C's seed not in yet.
    weigh(a);
    const ta = go([a], decidedAt + STEP, decidedAt + 60_000, () => trimmedTo(a, 1));
    expect(ta).toBeLessThan(decidedAt + 60_000);
    const opened = go([b, c], decidedAt + STEP, decidedAt + 30_000, () => [b, c].every((p) => crapsOf(p)?.phaseDeadline !== undefined));
    const W = crapsOf(b)!.phaseDeadline!;
    go([b, c], opened + STEP, W + 1_000);
    b.table.noteComputedFling(TABLE, 2, 9, W + 1_050);
    const closed = go([b], W + 1_000 + STEP, W + 3_000, () => keysIn(b, 'c', 2, TABLE).length > 0);
    expect(roundOf(b, 2).decided).toBeNull();
    expect(b.table.computedFlungFor(TABLE, closed)).toEqual({ r: 2, seed: 9 });
    // They meet: A's checkpoint at roll 1 is the only one, and B's roll 2 is
    // gone with the session B played it in. B's fling was for that roll.
    const T = closed + STEP;
    sync(T, ...pages);
    for (const p of pages) expect([foldOf(p).base.u, foldOf(p).rounds.length, carryOf(p).h]).toEqual([1, 0, b.pid]);
    expect(b.table.computedFlungFor(TABLE, T)).toBeNull();
    // Nobody closes the chain's roll 2 at the end of its betting: B's page
    // offers the fling, and the others wait for it.
    const reopened = go(pages, T + STEP, T + 30_000, () => crapsOf(b)?.phase === 'betting' && crapsOf(b)?.phaseDeadline !== undefined);
    const W2 = crapsOf(b)!.phaseDeadline!;
    go(pages, reopened + STEP, W2 + 3_000);
    expect(keysIn(a, 'c', 2, TABLE)).toEqual([]);
    expect(crapsOf(b, W2 + 3_000)).toMatchObject({ phase: 'closing', round: 2, shooter: b.pid, shooterSlip: 'here' });
  });
});

describe('🪑 a checkpoint whose carry rides a player the nets do not name', () => {
  // computedTablePids bounds the next checkpoint's players, so that a full
  // table takes no newcomer (computedTable crowdedOut, MAX_TABLE_PIDS). A craps
  // checkpoint carries its riders in its state (CrapsCarry.w), not its nets: a
  // pass bet riding on the point is unsettled, so the rider holds no net of its
  // own, and after a trim it has no frozen round either. Counting nets and
  // frozen rounds alone left the riders out, so a rider at a table of
  // MAX_TABLE_PIDS read as a newcomer with no place; the membership now adds
  // the carried riders too.
  it('counts the rider toward the cap: at a full table a newcomer is crowded out, the rider itself is not', async () => {
    const { pages, decidedAt } = await crapsPointOn(['A'], [1], T0);
    const [a] = pages;
    // A rides its pass on the point.
    expect(own(carryOf(a).w, a.pid).length).toBeGreaterThan(0);
    // A checkpoint of MAX_TABLE_PIDS - 1 players in its nets — A not among them
    // — carrying A's ride on: with A counted, the table is exactly full.
    const ghosts: Record<string, bigint> = {};
    for (let i = 0; i < a.fold.MAX_TABLE_PIDS - 1; i++) ghosts[`ghost-${i}`] = 1n;
    expect(ghosts[a.pid]).toBeUndefined();
    // One short of the cap in the nets alone: A's carried ride is the member
    // that fills the last place, so the refusal below is its doing.
    expect(Object.keys(ghosts)).toHaveLength(a.fold.MAX_TABLE_PIDS - 1);
    const T = decidedAt + STEP;
    clockOf(a, T);
    trimByHand(a, testIdentity('cap'), ghosts, TABLE);
    // After the trim A is in neither the nets nor a frozen round: only the
    // carry names it.
    expect(foldOf(a).base.n.has(a.pid)).toBe(false);
    expect(foldOf(a).rounds).toHaveLength(0);
    expect(own(carryOf(a).w, a.pid).length).toBeGreaterThan(0);
    // A newcomer with chips and no ride: counting A's, the table is full, so its
    // field bet is refused — uncounted, A would leave room for a 4001st player.
    const n = await loadPage('N', 50);
    clockOf(n, T);
    n.casino.buyInChips(n.pid, 1_000);
    standAt(n, 5);
    sync(T, a, n);
    const open = go([a, n], T + STEP, T + 50_000, () => crapsOf(n)?.phase === 'betting' && crapsOf(n)?.phaseDeadline !== undefined);
    sync(open, a, n);
    expect(crapsBet(n, [bet('field', 5)], open)).toBe('crowded');
  }, 60_000);
});
