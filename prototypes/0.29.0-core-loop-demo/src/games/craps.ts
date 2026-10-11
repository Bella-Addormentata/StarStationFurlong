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

/** The four hardway numbers (a pair: 2+2, 3+3, 4+4, 5+5). */
export const HARD_NUMBERS = new Set([4, 6, 8, 10]);

export type CrapsBetType =
  | 'pass'      // pass line — even money, travels with the point
  | 'dontpass'  // don't pass — even money, 12 pushes on the come-out
  | 'come'      // come — a pass line of its own, made while a point is on
  | 'dontcome'  // don't come — a don't pass of its own, made while a point is on
  | 'field'     // one-roll: 2,3,4,9,10,11,12 (2 & 12 pay double)
  | 'place'     // place 4/5/6/8/9/10 — working during the point, off on come-out
  | 'big6'      // big 6 — even money on a 6 before a 7, stays up
  | 'big8'      // big 8 — even money on an 8 before a 7, stays up
  | 'hard'      // hardway 4/6/8/10 — the pair before a 7 or the easy way
  | 'anyseven'  // one-roll: any 7, pays 4:1
  | 'anycraps'  // one-roll: 2/3/12, pays 7:1
  | 'two'       // one-roll: snake eyes, pays 30:1
  | 'three'     // one-roll: ace-deuce, pays 15:1
  | 'yo'        // one-roll: eleven, pays 15:1
  | 'twelve';   // one-roll: boxcars, pays 30:1

export interface CrapsBet {
  type: CrapsBetType;
  /** place: the number (4,5,6,8,9,10); hard: 4/6/8/10; come / dontcome: the
   *  number the bet TRAVELLED to (absent while it still sits in the come box).
   *  Absent for every other bet. */
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
  /** True when THIS roll was a SEVEN-OUT (a 7 with a point on) — the shooter's
   *  hand ends and the dice pass. Distinguishes a point-phase 7 (line loses, hand
   *  over) from a come-out 7 (a NATURAL, line wins), which the post-roll `point`
   *  alone cannot — both leave `point` null. Settled rolls only; absent on
   *  legacy/betting states ⇒ treated as false. The shooter-hand NETTING boundary
   *  (see the Chia backend plan) and the "new shooter" narration read it. */
  sevenOut?: boolean;
  /** 🎲🔒 How this roll's dice were produced + its verifiable transcript (absent
   *  for 'rng'). Settled rolls only; lets any client re-derive and check the dice. */
  fairness?: FairnessTranscript;
  /** 🤖 auto-stickman: absolute operator-clock ms at which THIS phase advances
   *  (the operator's Date.now() is the reference; everyone else's countdown is
   *  display-only). Absent ⇒ a manual/idle table with no timer. */
  phaseDeadline?: number;
  /** 🎲 #226: the player holding the dice for this hand (a player id), or
   *  absent when the stickman throws. Set by the operator when it slides the
   *  dice to a player at the table; kept roll to roll until a seven-out. */
  shooter?: string;
  /** 🎲 #226: on a manual table (no robot), the page whose ROLL slid the dice
   *  out — the one client that settles the shooter's throw or times them out,
   *  so several room editors never race one settle. Absent on robot tables. */
  operator?: string;
  /** 🎲 #226: who shot the hand that just ended (a seven-out) — the dice go
   *  clockwise from them to the next shooter. Absent ⇒ start anywhere. */
  lastShooter?: string;
}

/** Which fairness scheme produced a table's dice (see diceFairness.ts). All four
 *  coexist in dev; switch via `setCrapsFairnessMode` / the per-table pref. */
export type FairnessMode = 'rng' | 'commit-reveal' | 'multiparty' | 'block-beacon';

/** Public, verifiable transcript of HOW a settled roll's dice were produced —
 *  stored on the settled state so any client can re-derive and check them.
 *  Absent for 'rng' (no proof possible). `simulated` = dev-phase entropy/beacon
 *  generated locally: the mechanism is real and verifiable, but the trust
 *  property (independent parties / a real chain beacon) is not yet wired. */
export interface FairnessTranscript {
  mode: FairnessMode;
  /** commit-reveal / multiparty: each party's H(seed); block-beacon: [houseCommit]. */
  commits?: string[];
  /** the revealed seeds (commit-reveal / multiparty), or [houseSeed] (block-beacon). */
  seeds?: string[];
  /** block-beacon: the block hash the dice mixed in. */
  beacon?: string;
  simulated?: boolean;
}

const FAIRNESS_MODES: readonly string[] = ['rng', 'commit-reveal', 'multiparty', 'block-beacon'];

/** Bounds for peer-written transcripts: real ones carry 64-hex sha256 commits /
 *  seeds and at most one party per stand (8) + the house — the UI auto-verifies
 *  by hashing every entry, so unbounded arrays/strings from a hostile peer
 *  would freeze it. Generous ceilings, tight enough to keep hashing trivial. */
const FAIRNESS_MAX_PARTIES = 16;
const FAIRNESS_MAX_STRING = 128;

function isBoundedStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= FAIRNESS_MAX_PARTIES
    && v.every((s) => typeof s === 'string' && s.length <= FAIRNESS_MAX_STRING);
}

/** Shape guard for a peer-written fairness transcript — the UI dereferences
 *  `fairness.mode` (badge render + verification), so a malformed object from a
 *  peer must be rejected here, not crash there. */
export function isFairnessTranscript(value: unknown): value is FairnessTranscript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const f = value as Partial<FairnessTranscript>;
  return typeof f.mode === 'string' && FAIRNESS_MODES.includes(f.mode)
    && (f.commits === undefined || isBoundedStringArray(f.commits))
    && (f.seeds === undefined || isBoundedStringArray(f.seeds))
    && (f.beacon === undefined || (typeof f.beacon === 'string' && f.beacon.length <= FAIRNESS_MAX_STRING))
    && (f.simulated === undefined || typeof f.simulated === 'boolean');
}

export function initialCrapsState(): CrapsTableState {
  return {
    kind: 'craps', phase: 'betting', round: 1, point: null,
    dice: null, result: null, resultAt: 0, payouts: null,
  };
}

const BET_TYPES: readonly string[] = [
  'pass', 'dontpass', 'come', 'dontcome', 'field', 'place', 'big6', 'big8',
  'hard', 'anyseven', 'anycraps', 'two', 'three', 'yo', 'twelve',
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
  if (b.type === 'hard') {
    return Number.isInteger(b.pick) && HARD_NUMBERS.has(b.pick as number);
  }
  if (b.type === 'come' || b.type === 'dontcome') {
    return b.pick === undefined
      || (Number.isInteger(b.pick) && POINT_NUMBERS.has(b.pick as number));
  }
  return b.pick === undefined;
}

/** A player id as it may appear in a peer-written table record. */
function isPlayerIdField(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= 128);
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
    && typeof s.resultAt === 'number' && Number.isFinite(s.resultAt as number)
    && (s.payouts === null || (
        typeof s.payouts === 'object'
        && !Array.isArray(s.payouts)
        && Object.values(s.payouts).every(
            (v) => Number.isInteger(v) && (v as number) >= 0,
        )
    ))
    && (s.sevenOut === undefined || typeof s.sevenOut === 'boolean')
    && (s.fairness === undefined || isFairnessTranscript(s.fairness))
    && (s.phaseDeadline === undefined
        || (typeof s.phaseDeadline === 'number' && Number.isFinite(s.phaseDeadline)))
    && isPlayerIdField(s.shooter)
    && isPlayerIdField(s.lastShooter);
}

/** The point AFTER a roll of `sum`, given the point in force before it:
 *  come-out (null) sets the point on 4/5/6/8/9/10 (else stays a come-out);
 *  a point phase clears on the point (made) or a 7 (seven-out). */
export function nextPoint(pointBefore: number | null, sum: number): number | null {
  if (pointBefore === null) return POINT_NUMBERS.has(sum) ? sum : null;
  if (sum === pointBefore || sum === 7) return null;
  return pointBefore;
}

/** Does THIS roll end the shooter's hand? A hand ends ONLY on a SEVEN-OUT — a 7
 *  rolled while a point is on. A come-out 7/11 (natural) or 2/3/12 (craps) keeps
 *  the SAME shooter coming out again, and making the point re-opens the come-out
 *  for the same shooter — so only the point-phase 7 passes the dice. This is the
 *  shooter-hand netting/checkpoint boundary and the "new shooter" beat. */
export function shooterHandOver(pointBefore: number | null, sum: number): boolean {
  return pointBefore !== null && sum === 7;
}

/** Whether a NEW bet of this type may be placed given the point in force.
 *  Pass / don't pass are come-out wagers (point must be OFF); come / don't come
 *  are their point-phase twins (point must be ON); everything else is always
 *  available. (Mirrors the felt: the line is "closed" during a point, and the
 *  come box only opens once there is one.) */
export function canPlaceBet(type: CrapsBetType, point: number | null): boolean {
  if (type === 'pass' || type === 'dontpass') return point === null;
  if (type === 'come' || type === 'dontcome') return point !== null;
  return true;
}

export interface BetResolution {
  /** Chips returned to the player for this bet right now (see convention). */
  credited: number;
  /** true ⇒ the bet stays on the felt for the next roll (unresolved / working). */
  keep: boolean;
  /** For narration/UI only. 'stay' = no decision this roll. */
  outcome: 'win' | 'lose' | 'push' | 'stay';
  /** A come / don't come bet that TRAVELLED this roll: the bet as it now
   *  stands (same stake, `pick` = the number it moved to). keep is true. */
  moved?: CrapsBet;
}

const won = (credited: number): BetResolution => ({ credited, keep: false, outcome: 'win' });
const lost: BetResolution = { credited: 0, keep: false, outcome: 'lose' };
const push = (credited: number): BetResolution => ({ credited, keep: false, outcome: 'push' });
const stay: BetResolution = { credited: 0, keep: true, outcome: 'stay' };

/** Place-bet payout NUMERATOR:DENOMINATOR by number (true casino odds). */
const PLACE_ODDS: Record<number, [number, number]> = {
  4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5],
};

/** Hardway payout X:1 by number (the casino's standard 7:1 / 9:1). */
const HARD_ODDS: Record<number, number> = { 4: 7, 6: 9, 8: 9, 10: 7 };

/** A bet that stays up after it wins: only the winnings come back. */
const paidAndStays = (credited: number): BetResolution => ({ credited, keep: true, outcome: 'win' });

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
    case 'come':
      // In the come box: its own come-out roll, whatever the table's point.
      if (bet.pick === undefined) {
        if (sum === 7 || sum === 11) return won(a * 2);
        if (sum === 2 || sum === 3 || sum === 12) return lost;
        return { ...stay, moved: { type: 'come', pick: sum, amount: a } };
      }
      if (sum === bet.pick) return won(a * 2);              // its number came
      if (sum === 7) return lost;
      return stay;
    case 'dontcome':
      if (bet.pick === undefined) {
        if (sum === 2 || sum === 3) return won(a * 2);
        if (sum === 12) return push(a);                    // bar 12
        if (sum === 7 || sum === 11) return lost;
        return { ...stay, moved: { type: 'dontcome', pick: sum, amount: a } };
      }
      if (sum === 7) return won(a * 2);                    // 7 before its number
      if (sum === bet.pick) return lost;
      return stay;
    case 'big6':
    case 'big8': {
      const n = bet.type === 'big6' ? 6 : 8;
      if (sum === n) return paidAndStays(a);               // even money, stays up
      if (sum === 7) return lost;
      return stay;
    }
    case 'hard': {
      const n = bet.pick ?? 0;
      // Off on the come-out (the casino's default) — no decision, stays up.
      if (pointBefore === null) return stay;
      if (sum === 7) return lost;
      if (sum === n) {
        return d1 === d2 ? paidAndStays(a * (HARD_ODDS[n] ?? 0)) : lost; // easy way loses
      }
      return stay;
    }
    case 'two':
      return sum === 2 ? won(a * 31) : lost;               // 30:1
    case 'three':
      return sum === 3 ? won(a * 16) : lost;               // 15:1
    case 'yo':
      return sum === 11 ? won(a * 16) : lost;              // 15:1
    case 'twelve':
      return sum === 12 ? won(a * 31) : lost;              // 30:1
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
    // Aggregate stake per PLACE pick so payout rounding applies to the full stack,
    // not to each chip individually (e.g. six $1 chips on PLACE 6 should pay 7, not 6).
    const placeStake = new Map<number, number>();
    for (const bet of bets) {
      if (bet.type === 'place' && bet.pick != null) {
        placeStake.set(bet.pick, (placeStake.get(bet.pick) ?? 0) + bet.amount);
      }
    }
    const placePaidPick = new Set<number>();
    for (const bet of bets) {
      const r = resolveCrapsBet(bet, d1, d2, pointBefore);
      if (r.keep) kept.push(r.moved ?? bet);
      if (bet.type === 'place' && bet.pick != null && r.outcome === 'win') {
        // Credit the aggregate payout once per pick number to avoid per-chip floor loss.
        if (!placePaidPick.has(bet.pick)) {
          placePaidPick.add(bet.pick);
          const [num, den] = PLACE_ODDS[bet.pick] ?? [1, 1];
          total += Math.floor(((placeStake.get(bet.pick) ?? bet.amount) * num) / den);
        }
      } else {
        total += r.credited;
      }
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
    case 'come': return bet.pick === undefined ? 'COME' : `COME ${bet.pick}`;
    case 'dontcome': return bet.pick === undefined ? "DON'T COME" : `DON'T COME ${bet.pick}`;
    case 'field': return 'FIELD';
    case 'place': return `PLACE ${bet.pick}`;
    case 'big6': return 'BIG 6';
    case 'big8': return 'BIG 8';
    case 'hard': return `HARD ${bet.pick}`;
    case 'anyseven': return 'ANY 7';
    case 'anycraps': return 'ANY CRAPS';
    case 'two': return 'TWO';
    case 'three': return 'THREE';
    case 'yo': return 'YO 11';
    case 'twelve': return 'TWELVE';
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

// ── 🎲 #226: the shooter ──────────────────────────────────────────────────────

/** A player standing at the table, placed by the angle of their stand around
 *  the table centre (atan2(z, x) in the table's local frame — increasing angle
 *  runs clockwise seen from above, the way the dice travel). */
export interface SeatedPlayer {
  pid: string;
  angle: number;
}

/** True when the player has a line bet down (pass or don't pass) — the house
 *  rule for taking the dice on a come-out. */
export function hasLineBet(bets: readonly CrapsBet[]): boolean {
  return bets.some((b) => b.type === 'pass' || b.type === 'dontpass');
}

/**
 * Who gets the dice next: the first ELIGIBLE player clockwise after `after`
 * (the last shooter). `after` itself comes last in the ring, so a lone player
 * keeps shooting. When `after` is not standing at the table any more, the ring
 * starts from the lowest angle. null ⇒ nobody eligible: the stickman throws.
 */
export function pickShooter(
  seated: readonly SeatedPlayer[],
  eligible: (pid: string) => boolean,
  after?: string,
): string | null {
  const ring = [...seated].sort((a, b) => a.angle - b.angle || (a.pid < b.pid ? -1 : 1));
  const at = after === undefined ? -1 : ring.findIndex((p) => p.pid === after);
  for (let i = 1; i <= ring.length; i++) {
    const p = ring[(at + i + ring.length) % ring.length];
    if (eligible(p.pid)) return p.pid;
  }
  return null;
}

/** Was a point on going into this settled roll? The state carries only the
 *  point after it, but that, the sum and the seven-out flag pin it down:
 *  a made point clears it, a come-out 4–10 sets it equal to the sum, and a
 *  point-phase roll that decides nothing leaves it alone. */
export function pointWasOn(s: Pick<CrapsTableState, 'point' | 'result' | 'sevenOut'>): boolean {
  if (s.result === null) return s.point !== null;
  if (s.point !== null) return s.point !== s.result;
  if (s.result === 7) return s.sevenOut === true;
  return [4, 5, 6, 8, 9, 10].includes(s.result);
}
