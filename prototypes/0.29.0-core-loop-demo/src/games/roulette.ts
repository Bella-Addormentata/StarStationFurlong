/**
 * 🎡 Roulette — the pure engine (#69 G2).
 *
 * European single-zero rules, house-banked: players bet CHIPS (casinoDoc.ts
 * balances) against the house; the croupier (owner-equivalent client) resolves
 * the spin. This module is PURE — no doc access, no DOM, no randomness of its
 * own (the croupier passes the result in) — so payout math is console-testable
 * and the G5 commit-reveal fairness upgrade slots in around it untouched.
 *
 * Payout convention: payoutFor returns the TOTAL RETURNED for a winning bet
 * (stake included), because stakes are DEDUCTED at placement time (the
 * player's client spends chips when the chip hits the felt). A losing bet
 * returns 0 — the chips are already gone.
 */

/** Numbers that pay RED (standard wheel). Everything 1–36 not here is black. */
export const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

/** Physical pocket order around a European wheel, clockwise from 0 —
 *  the focused UI draws and lands the wheel with this. */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

export type RouletteBetType =
  | 'straight'  // one number 0–36, pays 35:1
  | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high'  // even money
  | 'dozen'     // pick 0/1/2 → 1–12 / 13–24 / 25–36, pays 2:1
  | 'column';   // pick 0/1/2 → layout columns, pays 2:1

export interface RouletteBet {
  type: RouletteBetType;
  /** straight: the number 0–36; dozen/column: 0/1/2; others: absent. */
  pick?: number;
  /** Chips staked (already deducted from the bettor's balance). */
  amount: number;
}

/** A settled (or open) round on one roulette table — the shared table record
 *  (casinoDoc key `table:<tableId>`). Whole-value LWW; only the croupier
 *  writes it. */
export interface RouletteTableState {
  kind: 'roulette';
  phase: 'betting' | 'settled';
  round: number;
  /** Winning pocket 0–36 once settled, null while betting. */
  result: number | null;
  /** Croupier-clock ms timestamp of the settle write (display ordering only). */
  resultAt: number;
  /** playerId → total chips RETURNED this round (stakes included), settled only. */
  payouts: Record<string, number> | null;
}

export function initialRouletteState(): RouletteTableState {
  return { kind: 'roulette', phase: 'betting', round: 1, result: null, resultAt: 0, payouts: null };
}

const BET_TYPES: readonly string[] = [
  'straight', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen', 'column',
];

/** Shape guard — bets cross the room-doc trust boundary (peer writes). */
export function isRouletteBet(value: unknown): value is RouletteBet {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<RouletteBet>;
  if (typeof b.type !== 'string' || !BET_TYPES.includes(b.type)) return false;
  if (!Number.isInteger(b.amount) || (b.amount as number) <= 0) return false;
  if (b.type === 'straight') {
    return Number.isInteger(b.pick) && (b.pick as number) >= 0 && (b.pick as number) <= 36;
  }
  if (b.type === 'dozen' || b.type === 'column') {
    return Number.isInteger(b.pick) && (b.pick as number) >= 0 && (b.pick as number) <= 2;
  }
  return true;
}

export function isRouletteTableState(value: unknown): value is RouletteTableState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<RouletteTableState>;
  return s.kind === 'roulette'
    && (s.phase === 'betting' || s.phase === 'settled')
    && Number.isInteger(s.round) && (s.round as number) >= 1
    && (s.result === null || (Number.isInteger(s.result) && (s.result as number) >= 0 && (s.result as number) <= 36))
    && typeof s.resultAt === 'number'
    && (s.payouts === null || typeof s.payouts === 'object');
}

/** Layout column of a number (0/1/2 = bottom/middle/top row of the classic
 *  sideways layout): 1,4,…,34 → 0 · 2,5,…,35 → 1 · 3,6,…,36 → 2. */
export function columnOf(n: number): number {
  return (n - 1) % 3;
}

/** TOTAL chips returned for one bet given the winning pocket (0 if lost). */
export function payoutFor(bet: RouletteBet, result: number): number {
  const n = result;
  switch (bet.type) {
    case 'straight': return bet.pick === n ? bet.amount * 36 : 0;
    case 'red':      return n !== 0 && RED_NUMBERS.has(n) ? bet.amount * 2 : 0;
    case 'black':    return n !== 0 && !RED_NUMBERS.has(n) ? bet.amount * 2 : 0;
    case 'odd':      return n !== 0 && n % 2 === 1 ? bet.amount * 2 : 0;
    case 'even':     return n !== 0 && n % 2 === 0 ? bet.amount * 2 : 0;
    case 'low':      return n >= 1 && n <= 18 ? bet.amount * 2 : 0;
    case 'high':     return n >= 19 && n <= 36 ? bet.amount * 2 : 0;
    case 'dozen':    return n !== 0 && Math.floor((n - 1) / 12) === bet.pick ? bet.amount * 3 : 0;
    case 'column':   return n !== 0 && columnOf(n) === bet.pick ? bet.amount * 3 : 0;
    default:         return 0;
  }
}

/** Resolve a whole round: per-player bet lists → per-player total returns.
 *  Players whose every bet lost are OMITTED (a 0 entry says nothing). */
export function resolveRound(
  betsByPlayer: Record<string, RouletteBet[]>,
  result: number,
): Record<string, number> {
  const payouts: Record<string, number> = {};
  for (const [pid, bets] of Object.entries(betsByPlayer)) {
    let total = 0;
    for (const bet of bets) total += payoutFor(bet, result);
    if (total > 0) payouts[pid] = total;
  }
  return payouts;
}

/** Player-facing label for a bet (plain language, upper-case UI voice). */
export function betLabel(bet: RouletteBet): string {
  switch (bet.type) {
    case 'straight': return `Nº ${bet.pick}`;
    case 'red': return 'RED';
    case 'black': return 'BLACK';
    case 'odd': return 'ODD';
    case 'even': return 'EVEN';
    case 'low': return '1–18';
    case 'high': return '19–36';
    case 'dozen': return ['1st 12', '2nd 12', '3rd 12'][bet.pick ?? 0];
    case 'column': return `COLUMN ${['A', 'B', 'C'][bet.pick ?? 0]}`;
    default: return '?';
  }
}

/** Pocket color for display: 'green' (0) / 'red' / 'black'. */
export function pocketColor(n: number): 'green' | 'red' | 'black' {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}
