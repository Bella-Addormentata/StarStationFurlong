/**
 * 💰 What the crew does with the chips once a craps roll is down, worked
 * out from the shared settled state so every page shows the same thing:
 * the losing bets swept into the house in front of the stickman, then each
 * winner paid out of it onto their rail, the stakes that come down going
 * back with the payout. The table pieces play it (casinoTable3d.ts
 * settleChips); casinoTableSession.ts hands it the felt as it played and as
 * it stands after.
 *
 * The rules decide which way each spot's chips go and what it won
 * (crapsBettorSettle: resolveCrapsRound's money, spot by spot). The table's
 * own record has the last word: a bettor whose shared result isn't what the
 * rules make of the felt as shown (a forfeit, a list taken back at the
 * close) gets no pay-out drawn, and when that result paid them nothing every
 * chip of theirs that left the felt goes to the house.
 */

import type { FeltStack, SettleMoves } from './casinoTable3d';
import { CHIP_DENOMS } from './chipDisplay';
import type { FeltPoint } from './games/casinoLayout';
import { isOddsType, oddsFlat, resolveCrapsBet, resolveOddsStack } from './games/craps';
import type { CrapsBet, BetResolution } from './games/craps';

/** One spot of a bettor's felt after the roll: chips that come back to the
 *  rail (a win that comes down, a push, odds over the cap), the winnings
 *  the house pays, and chips the house takes. */
export interface SpotSettle {
  back: number;
  won: number;
  lost: number;
}

/** A bettor's roll, spot by spot (by spotKey). `credited`: everything the
 *  roll hands them (the owner-run record's payout); `net`: won less lost
 *  (a computed table's amount); `decided`: some spot of theirs had a
 *  decision (not every bet just stayed up). */
export interface BettorSettle {
  spots: Map<string, SpotSettle>;
  credited: number;
  net: number;
  decided: boolean;
}

const keyOf = (b: { type: string; pick?: number }): string => `${b.type}:${b.pick ?? ''}`;

/**
 * What a roll of d1, d2 does to one bettor's felt, spot by spot, with the
 * point in force before it: the same money as resolveCrapsRound (odds paid
 * by the stack against the flat bet as it stood, a place number's winnings
 * on its whole stake), split into what each spot gives back, wins and loses.
 */
export function crapsBettorSettle(bets: readonly CrapsBet[], d1: number, d2: number, pointBefore: number | null): BettorSettle {
  const spots = new Map<string, SpotSettle>();
  let decided = false;
  const at = (k: string): SpotSettle => {
    let s = spots.get(k);
    if (!s) {
      s = { back: 0, won: 0, lost: 0 };
      spots.set(k, s);
    }
    return s;
  };
  const take = (k: string, stake: number, r: BetResolution): void => {
    if (r.outcome === 'stay') return;
    decided = true;
    const s = at(k);
    if (r.outcome === 'lose') {
      // (Odds over the cap come back even when the rest loses.)
      s.back += r.credited;
      s.lost += stake - r.credited;
    } else if (r.outcome === 'push') {
      s.back += r.credited;
    } else if (r.keep) {
      // Paid, and the bet stays up: only the winnings come.
      s.won += r.credited;
    } else {
      s.back += stake;
      s.won += r.credited - stake;
    }
  };
  // Odds and place numbers settle by the whole stack on a spot, as
  // resolveCrapsRound pays them (no chip lost to rounding per record).
  const stacks = new Map<string, { bet: CrapsBet; stake: number }>();
  for (const b of bets) {
    if (!isOddsType(b.type) && b.type !== 'place') continue;
    const k = keyOf(b);
    const was = stacks.get(k);
    if (was) was.stake += b.amount;
    else stacks.set(k, { bet: b, stake: b.amount });
  }
  for (const [k, { bet, stake }] of stacks) {
    const r = isOddsType(bet.type)
      ? resolveOddsStack(bet.type, bet.pick, stake, oddsFlat(bets, bet.type, bet.pick), d1, d2, pointBefore)
      : resolveCrapsBet({ ...bet, amount: stake }, d1, d2, pointBefore);
    take(k, stake, r);
  }
  for (const b of bets) {
    if (isOddsType(b.type) || b.type === 'place') continue;
    take(keyOf(b), b.amount, resolveCrapsBet(b, d1, d2, pointBefore));
  }
  let credited = 0;
  let net = 0;
  for (const s of spots.values()) {
    credited += s.back + s.won;
    net += s.won - s.lost;
  }
  return { spots, credited, net, decided };
}

/** Stakes by spot. */
function stakes(bets: readonly CrapsBet[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bets ?? []) out.set(keyOf(b), (out.get(keyOf(b)) ?? 0) + b.amount);
  return out;
}

/** What left each spot of a felt between before and after: a come / don't
 *  come bet that travelled to its number didn't leave (its chips moved).
 *  Only for a settle the record doesn't agree with. One it agrees with
 *  leaves by the rules (leaving): a bet replaced on its number by one that
 *  travelled there shows no change between the two felts. */
function departed(before: Map<string, number>, after: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, n] of before) {
    const d = n - (after.get(k) ?? 0);
    if (d > 0) out.set(k, d);
  }
  for (const box of ['come', 'dontcome']) {
    const k = `${box}:`;
    let gone = out.get(k) ?? 0;
    if (gone <= 0) continue;
    for (const [a, n] of after) {
      if (a === k || !a.startsWith(k)) continue;
      gone -= Math.min(gone, Math.max(0, n - (before.get(a) ?? 0)));
    }
    if (gone > 0) out.set(k, gone);
    else out.delete(k);
  }
  return out;
}

/** What leaves each spot by the rules: every bet with a decision comes off
 *  whole (the winnings of one that stays up come from the house). */
function leaving(settle: BettorSettle): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, sp] of settle.spots) if (sp.back + sp.lost > 0) out.set(k, sp.back + sp.lost);
  return out;
}

/** The largest chips first, at most `max` of them. */
export function chipsOf(amount: number, max: number): number[] {
  const out: number[] = [];
  let left = Math.max(0, Math.floor(amount));
  for (const d of CHIP_DENOMS) {
    const n = Math.min(Math.floor(left / d), max - out.length);
    for (let i = 0; i < n; i++) out.push(d);
    left -= n * d;
    if (out.length >= max) break;
  }
  return out;
}

/** The most chips one moving stack draws (a payout of any size). */
export const SETTLE_STACK_MAX = 20;

/** What the table's shared settled record says a bettor got, against what
 *  the rules make of the felt as shown. */
export interface SettleVerdict {
  /** The record agrees with `s` (the felt as shown is the one it settled). */
  agrees(pid: string, s: BettorSettle): boolean;
  /** The record paid the bettor nothing back (a forfeit, a loss). */
  paidNothing(pid: string): boolean;
}

export interface SettleInput {
  /** Each bettor's felt as the roll played it (as shown before the result). */
  before: Record<string, CrapsBet[]>;
  /** …and as it stands after (what rides on: what left a bettor's felt
   *  when their record disagrees with the rules). */
  after: Record<string, CrapsBet[]>;
  /** The before felt's stacks as drawn (layoutStacks, tagged pid / spot). */
  stacks: readonly FeltStack[];
  dice: readonly [number, number];
  pointBefore: number | null;
  verdict: SettleVerdict;
  /** Where on a bettor's rail their chips go (`near`: one of their stacks,
   *  for a bettor with no place at the table). */
  railOf(pid: string, near: FeltPoint): FeltPoint;
  /** In front of the stickman: where the house takes and pays. */
  house: FeltPoint;
  /** The viewer (whose stacks are drawn lit, and whose rail is theirs). */
  me: string;
}

/**
 * The chip moves of a settled craps roll, the same on every page given the
 * same shared state: every stack (or the part of it) that left the felt to
 * the house when it lost, to its bettor's rail when it came down a winner or
 * pushed; each winner's winnings out of the house to their rail, bettors
 * paid in player order. Stacks that stay up stay where they are (a place
 * bet's winnings still come).
 */
export function crapsSettleMoves(i: SettleInput): SettleMoves {
  const moves: SettleMoves = { house: i.house, lost: [], back: [], paid: [] };
  const [d1, d2] = i.dice;
  const pids = Object.keys(i.before).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let order = 0;
  for (const pid of pids) {
    const settle = crapsBettorSettle(i.before[pid], d1, d2, i.pointBefore);
    const agrees = i.verdict.agrees(pid, settle);
    const allLost = !agrees && i.verdict.paidNothing(pid);
    if (!agrees && !allLost) continue;
    const had = stakes(i.before[pid]);
    const gone = agrees ? leaving(settle) : departed(had, stakes(i.after[pid]));
    const mine = pid === i.me;
    let near: FeltPoint | null = null;
    let paysBack = false;
    for (const s of i.stacks) {
      if (s.pid !== pid || s.spot === undefined) continue;
      near ??= { x: s.x, z: s.z };
      const left = gone.get(s.spot) ?? 0;
      if (left <= 0) continue;
      const sp = settle.spots.get(s.spot);
      const lost = allLost ? left : Math.min(left, sp?.lost ?? 0);
      const back = allLost ? 0 : Math.min(left - lost, sp?.back ?? 0);
      if (lost + back <= 0) continue;
      const to = i.railOf(pid, { x: s.x, z: s.z });
      if (left >= (had.get(s.spot) ?? left) && (lost === 0 || back === 0)) {
        // The whole stack, as drawn, goes one way.
        if (lost > 0) moves.lost.push(s);
        else moves.back.push({ s, to, order, mine });
      } else {
        // Part of it (odds over the cap come back from a losing stack): the
        // chips each part breaks into, off the top of what stays.
        const backChips = chipsOf(back, SETTLE_STACK_MAX);
        const lostChips = chipsOf(lost, SETTLE_STACK_MAX);
        const under = (s.lift ?? 0) + Math.max(0, s.chips.length - backChips.length - lostChips.length);
        if (backChips.length > 0) moves.back.push({ s: { ...s, chips: backChips, lift: under }, to, order, mine });
        if (lostChips.length > 0) moves.lost.push({ ...s, chips: lostChips, lift: under + backChips.length });
      }
      if (back > 0) paysBack = true;
    }
    const won = agrees ? [...settle.spots.values()].reduce((a, sp) => a + sp.won, 0) : 0;
    if (won > 0) {
      const to = i.railOf(pid, near ?? i.house);
      const color = i.stacks.find((s) => s.pid === pid)?.color;
      moves.paid.push({ chips: chipsOf(won, SETTLE_STACK_MAX), to, order, mine, dim: !mine, ...(color ? { color } : {}) });
    }
    if (won > 0 || paysBack) order += 1;
  }
  return moves;
}
