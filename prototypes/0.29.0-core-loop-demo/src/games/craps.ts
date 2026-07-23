/**
 * 🎲 Craps — the pure engine (#69 G3).
 *
 * House-banked bank craps: players bet CHIPS (casinoDoc balances) against the
 * house; the STICKMAN (the table owner, or their croupier robot) throws the
 * dice and resolves the roll. This module is PURE — no doc access, no DOM, no
 * randomness of its own (the stickman passes the two dice in) — so payout math
 * is console-testable and the G5 commit-reveal fairness upgrade slots in around
 * it untouched, exactly like games/roulette.ts.
 *
 * WHY CRAPS IS DIFFERENT FROM ROULETTE: a roulette round is one shot — every
 * bet resolves on a single spin and the felt clears. Craps carries state across
 * rolls: a PASS-LINE bet placed on the come-out "travels" with the POINT and is
 * only settled rolls later (when the point repeats or a 7 shows). So a bet has
 * an outcome AND a `keep` flag — resolved bets leave the felt, standing bets
 * (pass waiting on its point, place bets working) ride to the next roll. The
 * stickman prunes each player's list at settle using resolveCrapsRound.
 *
 * Payout convention (stakes are DEDUCTED at placement, like roulette):
 *   `credited` = chips RETURNED to the player for this bet right now.
 *   - A one-and-done win returns stake + winnings (e.g. even money → amount*2).
 *   - A PLACE bet that hits stays working, so only the WINNINGS are credited
 *     (the stake is still on the felt) and keep=true.
 *   - A loss credits 0 (the chips are already gone) and keep=false.
 *   - A standing bet with no decision credits 0 and keep=true.
 */

/** The six point numbers (a come-out roll of one of these sets the point). */
export const POINT_NUMBERS = new Set([4, 5, 6, 8, 9, 10]);

export type CrapsBetType =
  | 'pass'      // pass line — even money, travels with the point
  | 'dontpass'  // don't pass — even money, 12 pushes on the come-out
  | 'field'     // one-roll: 2,3,4,9,10,11,12 (2 & 12 pay double)
  | 'place'     // place 4/5/6/8/9/10 — working during the point, off on come-out
  | 'anyseven'  // one-roll: any 7, pays 4:1
  | 'anycraps'; // one-roll: 2/3/12, pays 7:1

export interface CrapsBet {
  type: CrapsBetType;
  /** place: the number (4,5,6,8,9,10). Absent for every other bet. */
  pick?: number;
  /** Chips staked (already deducted from the bettor's balance). */
  amount: number;
}

/** A settled (or open) roll on one craps table — the shared table record
 *  (casinoDoc key `table:<tableId>`). Whole-value LWW; only the stickman
 *  (elected operator / manual house) writes it. */
export interface CrapsTableState {
  kind: 'craps';
  /** betting → closing ("no more bets") → settled. 'closing' only appears on a
   *  robot-driven table (auto-stickman); manual tables jump betting→settled. */
  phase: 'betting' | 'closing' | 'settled';
  /** Increments once PER ROLL (drives the UI's "new roll" edge-detect). */
  round: number;
  /** The established point (4,5,6,8,9,10), or null on a come-out roll. This is
   *  the point IN FORCE for the current betting window — it carries across
   *  rounds until a roll makes the point or sevens out. */
  point: number | null;
  /** The two dice of the settled roll, or null while betting. */
  dice: [number, number] | null;
  /** Dice sum once settled (2–12), null while betting — for display/narration. */
  result: number | null;
  /** Stickman-clock ms timestamp of the settle write (display ordering only). */
  resultAt: number;
  /** playerId → total chips CREDITED this roll (see convention), settled only. */
  payouts: Record<string, number> | null;
  /** 🤖 auto-stickman: absolute operator-clock ms at which THIS phase advances
   *  (the operator's Date.now() is the reference; everyone else's countdown is
   *  display-only). Absent ⇒ a manual/idle table with no timer. */
  phaseDeadline?: number;
}

export function initialCrapsState(): CrapsTableState {
  return {
    kind: 'craps', phase: 'betting', round: 1, point: null,
    dice: null, result: null, resultAt: 0, payouts: null,
  };
}

const BET_TYPES: readonly string[] = [
  'pass', 'dontpass', 'field', 'place', 'anyseven', 'anycraps',
];

/** Shape guard — bets cross the room-doc trust boundary (peer writes). */
export function isCrapsBet(value: unknown): value is CrapsBet {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<CrapsBet>;
  if (typeof b.type !== 'string' || !BET_TYPES.includes(b.type)) return false;
  if (!Number.isInteger(b.amount) || (b.amount as number) <= 0) return false;
  if (b.type === 'place') {
    return Number.isInteger(b.pick) && POINT_NUMBERS.has(b.pick as number);
  }
  return true;
}

function isDicePair(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && Number.isInteger(value[0]) && value[0] >= 1 && value[0] <= 6
    && Number.isInteger(value[1]) && value[1] >= 1 && value[1] <= 6;
}

export function isCrapsTableState(value: unknown): value is CrapsTableState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<CrapsTableState>;
  return s.kind === 'craps'
    && (s.phase === 'betting' || s.phase === 'closing' || s.phase === 'settled')
    && Number.isInteger(s.round) && (s.round as number) >= 1
    && (s.point === null || POINT_NUMBERS.has(s.point as number))
    && (s.dice === null || isDicePair(s.dice))
    && (s.result === null || (Number.isInteger(s.result) && (s.result as number) >= 2 && (s.result as number) <= 12))
    && typeof s.resultAt === 'number'
    && (s.payouts === null || typeof s.payouts === 'object')
    && (s.phaseDeadline === undefined
        || (typeof s.phaseDeadline === 'number' && Number.isFinite(s.phaseDeadline)));
}

/** The point AFTER a roll of `sum`, given the point in force before it:
 *  come-out (null) sets the point on 4/5/6/8/9/10 (else stays a come-out);
 *  a point phase clears on the point (made) or a 7 (seven-out). */
export function nextPoint(pointBefore: number | null, sum: number): number | null {
  if (pointBefore === null) return POINT_NUMBERS.has(sum) ? sum : null;
  if (sum === pointBefore || sum === 7) return null;
  return pointBefore;
}

/** Whether a NEW bet of this type may be placed given the point in force.
 *  Pass / don't pass are come-out wagers (point must be OFF); everything else
 *  is always available. (Mirrors the felt: the line is "closed" during a point.) */
export function canPlaceBet(type: CrapsBetType, point: number | null): boolean {
  if (type === 'pass' || type === 'dontpass') return point === null;
  return true;
}

export interface BetResolution {
  /** Chips returned to the player for this bet right now (see convention). */
  credited: number;
  /** true ⇒ the bet stays on the felt for the next roll (unresolved / working). */
  keep: boolean;
  /** For narration/UI only. 'stay' = no decision this roll. */
  outcome: 'win' | 'lose' | 'push' | 'stay';
}

const won = (credited: number): BetResolution => ({ credited, keep: false, outcome: 'win' });
const lost: BetResolution = { credited: 0, keep: false, outcome: 'lose' };
const push = (credited: number): BetResolution => ({ credited, keep: false, outcome: 'push' });
const stay: BetResolution = { credited: 0, keep: true, outcome: 'stay' };

/** Place-bet payout NUMERATOR:DENOMINATOR by number (true casino odds). */
const PLACE_ODDS: Record<number, [number, number]> = {
  4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5],
};

/** Resolve ONE bet against a roll, given the point in force BEFORE the roll. */
export function resolveCrapsBet(
  bet: CrapsBet,
  d1: number,
  d2: number,
  pointBefore: number | null,
): BetResolution {
  const sum = d1 + d2;
  const a = bet.amount;
  switch (bet.type) {
    case 'pass':
      if (pointBefore === null) {
        if (sum === 7 || sum === 11) return won(a * 2);   // natural
        if (sum === 2 || sum === 3 || sum === 12) return lost; // craps
        return stay;                                       // point set — travels
      }
      if (sum === pointBefore) return won(a * 2);          // point made
      if (sum === 7) return lost;                          // seven-out
      return stay;
    case 'dontpass':
      if (pointBefore === null) {
        if (sum === 2 || sum === 3) return won(a * 2);
        if (sum === 12) return push(a);                    // bar 12 — stake back
        if (sum === 7 || sum === 11) return lost;
        return stay;
      }
      if (sum === 7) return won(a * 2);                    // 7 before the point
      if (sum === pointBefore) return lost;                // point made
      return stay;
    case 'field':
      if (sum === 2 || sum === 12) return won(a * 3);      // 2:1
      if (sum === 3 || sum === 4 || sum === 9 || sum === 10 || sum === 11) return won(a * 2);
      return lost;
    case 'place': {
      // Off on the come-out (real-felt rule) — no win/lose, stays working.
      if (pointBefore === null) return stay;
      if (sum === 7) return lost;                          // seven-out kills it
      if (sum === bet.pick) {
        const [num, den] = PLACE_ODDS[bet.pick] ?? [1, 1];
        // Only the WINNINGS are paid; the stake stays working on the felt.
        return { credited: Math.floor((a * num) / den), keep: true, outcome: 'win' };
      }
      return stay;
    }
    case 'anyseven':
      return sum === 7 ? won(a * 5) : lost;                // 4:1
    case 'anycraps':
      return (sum === 2 || sum === 3 || sum === 12) ? won(a * 8) : lost; // 7:1
    default:
      return lost;
  }
}

/** Per-player resolution of a whole roll: total credited + the pruned bet list
 *  each player carries to the next roll. Players with a positive credit appear
 *  in `payouts`; every player with any bet appears in `remaining` (an empty
 *  array clears their felt). */
export function resolveCrapsRound(
  betsByPlayer: Record<string, CrapsBet[]>,
  d1: number,
  d2: number,
  pointBefore: number | null,
): { payouts: Record<string, number>; remaining: Record<string, CrapsBet[]> } {
  const payouts: Record<string, number> = {};
  const remaining: Record<string, CrapsBet[]> = {};
  for (const [pid, bets] of Object.entries(betsByPlayer)) {
    let total = 0;
    const kept: CrapsBet[] = [];
    for (const bet of bets) {
      const r = resolveCrapsBet(bet, d1, d2, pointBefore);
      total += r.credited;
      if (r.keep) kept.push(bet);
    }
    if (total > 0) payouts[pid] = total;
    remaining[pid] = kept;
  }
  return { payouts, remaining };
}

/** Player-facing label for a bet (plain language, upper-case UI voice). */
export function crapsBetLabel(bet: CrapsBet): string {
  switch (bet.type) {
    case 'pass': return 'PASS LINE';
    case 'dontpass': return "DON'T PASS";
    case 'field': return 'FIELD';
    case 'place': return `PLACE ${bet.pick}`;
    case 'anyseven': return 'ANY 7';
    case 'anycraps': return 'ANY CRAPS';
    default: return '?';
  }
}

/** Plain-language call for a settled roll (the stickman's shout). */
export function rollCall(sum: number, pointBefore: number | null, pointAfter: number | null): string {
  if (pointBefore === null) {
    if (sum === 7 || sum === 11) return `${sum} — A NATURAL, PASS WINS`;
    if (sum === 2 || sum === 3 || sum === 12) return `${sum} — CRAPS, LINE LOSES`;
    return `${sum} — THE POINT IS ${pointAfter}`;
  }
  if (sum === 7) return '7 — SEVEN OUT';
  if (sum === pointBefore) return `${sum} — WINNER, POINT MADE`;
  return `${sum} — ROLL AGAIN, POINT IS ${pointBefore}`;
}
