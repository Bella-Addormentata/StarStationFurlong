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

// 🔒 #69 G5 house commit-reveal: the stickman COMMITS to a secret seed BEFORE
// bets close (publishing SHA-256(seed || tableId || round) on the round record)
// and REVEALS the seed at settle. Every client re-derives the two dice from
// the revealed seed and refuses to render the roll FAIR unless commit and
// derivation both check out. See games/fairness.ts — this file only carries
// the proof shape on the table state and shape-guards it against peer forgery.
// The G5 pre-commit sits ORTHOGONAL to the existing dev-phase FairnessTranscript
// (rng / commit-reveal / multiparty / block-beacon) that lives on `.fairness`:
// G5 is the ALWAYS-ON operator pre-commit, `.fairness` is the multi-mode
// transcript. Both fields coexist on legacy fallback rolls; on the G5 happy
// path the transcript is deliberately OMITTED (its dice would not match a
// G5-derived pair and would misread as tampering).
import type { FairnessProof } from './fairness';
import { isFairnessProof } from './fairness';

/** The six point numbers (a come-out roll of one of these sets the point). */
export const POINT_NUMBERS = new Set([4, 5, 6, 8, 9, 10]);

/** Every bet type the engine settles. Names match the felt vocabulary a player
 *  would say aloud; the payout math and placement rules are per bet type. */
export type CrapsBetType =
  | 'pass'          // pass line — even money, travels with the point
  | 'dontpass'      // don't pass — even money, 12 pushes on the come-out
  | 'come'          // come — a "personal pass line" placed while the point is on;
                    //   NEXT roll is its come-out, then it travels with a come point
  | 'dontcome'      // don't come — mirror of come (12 pushes on its come-out)
  | 'passodds'      // pass line ODDS (true odds, no house edge) — backing the pass
                    //   line's point once established; pick = the pass line's point
  | 'dontpassodds'  // don't pass LAY ODDS — laying against the pass line's point
  | 'comeodds'      // come ODDS — backing a come point (pick = the come point)
  | 'dontcomeodds'  // don't come LAY ODDS — laying against a come point
  | 'field'         // one-roll: 2,3,4,9,10,11,12 (2 & 12 pay double)
  | 'place'         // place 4/5/6/8/9/10 — working during the point, off on come-out
  | 'anyseven'      // one-roll: any 7, pays 4:1
  | 'anycraps';     // one-roll: 2/3/12, pays 7:1

export interface CrapsBet {
  type: CrapsBetType;
  /** place: the number (4,5,6,8,9,10). passodds/dontpassodds: the pass line's
   *  point being backed (4/5/6/8/9/10). comeodds/dontcomeodds: the come point
   *  being backed. Absent for every other bet. */
  pick?: number;
  /** come / dontcome ONLY: the come-point once it has traveled from the initial
   *  roll (undefined ⇒ next roll is the come bet's come-out). The engine STAMPS
   *  this in resolveCrapsRound when a come bet's first roll lands on 4/5/6/8/9/10;
   *  the UI never writes it. */
  point?: number;
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
  /** 🔒 #69 G5 house commit-reveal PROOF for THIS roll. Populated with only a
   *  COMMIT (SHA-256 of the seed || tableId || round) when the round opens; the
   *  matching REVEAL (the seed hex) is stamped on at settle. A settled roll
   *  with commit+reveal is verifiable by every client via verifyCraps. Absent
   *  ⇒ a LEGACY round (opened before G5 rolled out on this table, or on a
   *  legacy fallback path) — the UI labels it plainly instead of claiming
   *  either FAIR or UNVERIFIED. Peer-planted junk here is refused by the
   *  isCrapsTableState guard below (fail SAFE). */
  houseFairness?: FairnessProof;
  /** 🤖 auto-stickman: absolute operator-clock ms at which THIS phase advances
   *  (the operator's Date.now() is the reference; everyone else's countdown is
   *  display-only). Absent ⇒ a manual/idle table with no timer. */
  phaseDeadline?: number;
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
  'pass', 'dontpass',
  'come', 'dontcome',
  'passodds', 'dontpassodds',
  'comeodds', 'dontcomeodds',
  'field', 'place', 'anyseven', 'anycraps',
];

/** Bet types whose `pick` MUST be a point number (4/5/6/8/9/10). */
const REQUIRES_POINT_PICK = new Set<string>([
  'place', 'passodds', 'dontpassodds', 'comeodds', 'dontcomeodds',
]);

/** Shape guard — bets cross the room-doc trust boundary (peer writes). */
export function isCrapsBet(value: unknown): value is CrapsBet {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<CrapsBet>;
  if (typeof b.type !== 'string' || !BET_TYPES.includes(b.type)) return false;
  if (!Number.isInteger(b.amount) || (b.amount as number) <= 0) return false;
  // come/dontcome carry an optional stamped come point once traveled — reject a
  // corrupt one (a non-point number would make resolveCrapsBet win/lose wrong).
  if (b.point !== undefined) {
    if (!(b.type === 'come' || b.type === 'dontcome')) return false;
    if (!(Number.isInteger(b.point) && POINT_NUMBERS.has(b.point as number))) return false;
  }
  if (REQUIRES_POINT_PICK.has(b.type)) {
    return Number.isInteger(b.pick) && POINT_NUMBERS.has(b.pick as number);
  }
  // pass/dontpass/come/dontcome/field/anyseven/anycraps: no pick allowed.
  if (b.pick !== undefined) return false;
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
    // 🔒 #69 G5: trust boundary — a hostile peer that plants a malformed
    // houseFairness object would freeze the verifier. Fail SAFE and drop the
    // whole state so the operator's next write repairs. `undefined` remains
    // fine — that's the legacy posture.
    && (s.houseFairness === undefined || isFairnessProof(s.houseFairness))
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

/** Does THIS roll end the shooter's hand? A hand ends ONLY on a SEVEN-OUT — a 7
 *  rolled while a point is on. A come-out 7/11 (natural) or 2/3/12 (craps) keeps
 *  the SAME shooter coming out again, and making the point re-opens the come-out
 *  for the same shooter — so only the point-phase 7 passes the dice. This is the
 *  shooter-hand netting/checkpoint boundary and the "new shooter" beat. */
export function shooterHandOver(pointBefore: number | null, sum: number): boolean {
  return pointBefore !== null && sum === 7;
}

/** Whether a NEW bet of this type may be placed given the point in force.
 *  - pass / dontpass: come-out only (point OFF) — the line is closed during a
 *    point.
 *  - come / dontcome: point ON only — a come bet's next roll is its come-out,
 *    which is why they're the "personal pass line" a player takes DURING a point.
 *  - passodds / dontpassodds: point ON only — they back the pass line's point,
 *    which does not exist until the point is established.
 *  - comeodds / dontcomeodds: point ON only (a come point can only exist once a
 *    come bet has traveled, and come bets require the pass point to be ON). This
 *    is a necessary condition, not sufficient — the UI checks that a matching
 *    come-point bet actually exists before offering the ODDS button.
 *  - field / place / anyseven / anycraps: always available. (Place is OFF on the
 *    come-out — see resolveCrapsBet — but the felt lets you park them.) */
export function canPlaceBet(type: CrapsBetType, point: number | null): boolean {
  if (type === 'pass' || type === 'dontpass') return point === null;
  if (type === 'come' || type === 'dontcome') return point !== null;
  if (type === 'passodds' || type === 'dontpassodds') return point !== null;
  if (type === 'comeodds' || type === 'dontcomeodds') return point !== null;
  return true;
}

export interface BetResolution {
  /** Chips returned to the player for this bet right now (see convention). */
  credited: number;
  /** true ⇒ the bet stays on the felt for the next roll (unresolved / working). */
  keep: boolean;
  /** For narration/UI only. 'stay' = no decision this roll. */
  outcome: 'win' | 'lose' | 'push' | 'stay';
  /** come / dontcome ONLY: the come-point this bet just traveled to (set only
   *  when the bet's initial roll established one of 4/5/6/8/9/10 and keep=true).
   *  resolveCrapsRound stamps the surviving bet with this number so future rolls
   *  see it. Absent for every other bet and every non-travel outcome. */
  travelPoint?: number;
}

const won = (credited: number): BetResolution => ({ credited, keep: false, outcome: 'win' });
const lost: BetResolution = { credited: 0, keep: false, outcome: 'lose' };
const push = (credited: number): BetResolution => ({ credited, keep: false, outcome: 'push' });
const stay: BetResolution = { credited: 0, keep: true, outcome: 'stay' };
/** A come/dontcome bet whose first roll established a come point. It stays on
 *  the felt (keep=true) and travelPoint tells resolveCrapsRound to stamp it. */
const travel = (point: number): BetResolution =>
  ({ credited: 0, keep: true, outcome: 'stay', travelPoint: point });

/** Place-bet payout NUMERATOR:DENOMINATOR by number (true casino odds — the
 *  house's cut is the fixed 9:5/7:5/7:6 vs the mathematical 2:1/3:2/6:5). */
const PLACE_ODDS: Record<number, [number, number]> = {
  4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5],
};

/** TRUE ODDS payout NUMERATOR:DENOMINATOR by point (no house edge — the whole
 *  reason odds bets exist). Applied to passodds and comeodds when the point is
 *  MADE (the come/pass line wins first, then the odds pays true odds on top).
 *  These are the MATHEMATICALLY FAIR payoffs (dice-combination count of the 7
 *  vs the point):
 *    4 or 10 → 2:1  (six ways to roll 7 vs three ways to roll 4/10 → 6/3 = 2)
 *    5 or 9  → 3:2  (six ways to roll 7 vs four ways to roll 5/9  → 6/4 = 3/2)
 *    6 or 8  → 6:5  (six ways to roll 7 vs five ways to roll 6/8  → 6/5) */
const TRUE_ODDS: Record<number, [number, number]> = {
  4: [2, 1], 5: [3, 2], 6: [6, 5], 8: [6, 5], 9: [3, 2], 10: [2, 1],
};

/** LAY ODDS (dontpass/dontcome odds) — you're now the FAVOURITE (a 7 is more
 *  likely than the point), so the payout is the RECIPROCAL: the winner risks
 *  MORE to win the base. amount here is the amount at RISK (already staked); the
 *  win pays the reciprocal fraction. 4/10 → 1:2, 5/9 → 2:3, 6/8 → 5:6. */
const LAY_ODDS: Record<number, [number, number]> = {
  4: [1, 2], 5: [2, 3], 6: [5, 6], 8: [5, 6], 9: [2, 3], 10: [1, 2],
};

/** Numerator:denominator of the pass/come-line ODDS payout for a point, without
 *  the returned stake. Exported so `crapsMaxLine` (UI) and tests can quote what
 *  a winning true-odds bet would pay. */
export function trueOddsPayout(point: number): [number, number] {
  return TRUE_ODDS[point] ?? [1, 1];
}

/** Numerator:denominator of the DON'T pass/come LAY-ODDS payout for a point. */
export function layOddsPayout(point: number): [number, number] {
  return LAY_ODDS[point] ?? [1, 1];
}

/** Resolve ONE bet against a roll, given the point in force BEFORE the roll.
 *  `bet.point` (come/dontcome only) indicates the come point that bet has
 *  already traveled to; undefined ⇒ this roll IS its come-out. Odds bets carry
 *  their backed point in `bet.pick` — they are one-and-done (they only decide
 *  on the point they back or a 7). */
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
    // ── COME / DON'T COME ────────────────────────────────────────────────────
    // A come bet placed with no come point yet acts as a "personal pass line" —
    // THIS very roll is its come-out. If the roll sets a point (4/5/6/8/9/10)
    // the bet TRAVELS: it stays on the felt with the come point stamped, and
    // subsequent rolls resolve it exactly like a pass line watching that number.
    // Rule note: come/dontcome bets with an established come point stay working
    // through the ensuing point-made cycle (their next come-out is the shooter's
    // next come-out) — a 7 there is a seven-out that kills them, and a match to
    // the come point wins them. That is the standard "come bets are always ON"
    // rule (some houses let players turn them off; we do not).
    case 'come':
      if (bet.point === undefined) {
        // Come bet's come-out (this roll).
        if (sum === 7 || sum === 11) return won(a * 2);
        if (sum === 2 || sum === 3 || sum === 12) return lost;
        if (POINT_NUMBERS.has(sum)) return travel(sum);
        return stay; // not reachable — sum 4–10 handled above, plus 7/11
      }
      // With an established come point.
      if (sum === bet.point) return won(a * 2);
      if (sum === 7) return lost;
      return stay;
    case 'dontcome':
      if (bet.point === undefined) {
        if (sum === 2 || sum === 3) return won(a * 2);
        if (sum === 12) return push(a);                    // bar 12
        if (sum === 7 || sum === 11) return lost;
        if (POINT_NUMBERS.has(sum)) return travel(sum);
        return stay;
      }
      if (sum === 7) return won(a * 2);                    // 7 before the come point
      if (sum === bet.point) return lost;
      return stay;
    // ── PASS-LINE ODDS (true odds — no house edge on this money) ────────────
    // Pass-line odds back the CURRENT PASS-LINE POINT. `bet.pick` must equal
    // `pointBefore`: canPlaceBet blocks a UI placement while pointBefore is
    // null OR when the picked number doesn't match, but a hostile peer can
    // bypass the felt and write `bets:<id>:<pid>` directly with a shape-valid
    // `{type:'passodds', pick:8, amount:X}` while the table's point is 6. If
    // we let that settle at true odds, the peer siphons pass-odds payouts on
    // the WRONG NUMBER (audit remediation, round 2). We FAIL CLOSED: any
    // passodds whose pick doesn't match pointBefore loses immediately (this
    // also handles the come-out case naturally — pointBefore is null then, so
    // no numeric pick can match, and the bet loses). The player's stake is
    // already spent when the bet was placed, so `lost` simply keeps those
    // chips on the house side rather than paying out fraudulent odds.
    case 'passodds': {
      const backed = bet.pick;
      if (backed == null) return lost;
      if (backed !== pointBefore) return lost;             // pick MUST bind to pass-line point
      if (sum === backed) {
        const [num, den] = TRUE_ODDS[backed] ?? [1, 1];
        // Stake returned + true-odds winnings, no house edge.
        return won(a + Math.floor((a * num) / den));
      }
      if (sum === 7) return lost;
      return stay;
    }
    // ── COME ODDS (true odds) ────────────────────────────────────────────────
    // Come odds back a COME POINT — which is INDEPENDENT of the pass-line's
    // point. A player's come bet that traveled to 8 backs 8 with `comeodds`
    // even after the pass line makes its own point and reverts to come-out.
    // So comeodds resolves against `bet.pick` regardless of pass-line phase
    // (per the standard rule that come bets and their odds are always on).
    case 'comeodds': {
      const backed = bet.pick;
      if (backed == null) return lost;
      if (sum === backed) {
        const [num, den] = TRUE_ODDS[backed] ?? [1, 1];
        return won(a + Math.floor((a * num) / den));
      }
      if (sum === 7) return lost;
      return stay;
    }
    // ── DON'T PASS LAY ODDS ──────────────────────────────────────────────────
    // Mirror of passodds: LAY against the CURRENT PASS-LINE POINT. `bet.pick`
    // must equal `pointBefore`; a peer-injected dontpassodds with mismatched
    // pick is a siphon attempt (would win on 7 without ever risking against
    // the actual pass-line point) and fails closed (audit remediation, round
    // 2). Come-out (pointBefore null) also falls under the mismatch — no lay
    // odds can back a point that doesn't yet exist.
    case 'dontpassodds': {
      const backed = bet.pick;
      if (backed == null) return lost;
      if (backed !== pointBefore) return lost;             // pick MUST bind to pass-line point
      if (sum === 7) {
        const [num, den] = LAY_ODDS[backed] ?? [1, 1];
        return won(a + Math.floor((a * num) / den));
      }
      if (sum === backed) return lost;
      return stay;
    }
    // ── DON'T COME LAY ODDS ──────────────────────────────────────────────────
    // Mirror of comeodds: lay against the bet's OWN come point, independent of
    // the pass-line phase (the traveled dontcome flat bet keeps working on the
    // pass-line come-out and so must its lay odds — per the standard "don't
    // come odds are always on" rule; audit remediation, round 2). The bet is
    // free to back any of its come-point numbers via `bet.pick`.
    case 'dontcomeodds': {
      const backed = bet.pick;
      if (backed == null) return lost;
      if (sum === 7) {
        const [num, den] = LAY_ODDS[backed] ?? [1, 1];
        return won(a + Math.floor((a * num) / den));
      }
      if (sum === backed) return lost;
      return stay;
    }
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

// ── Stack aggregation ────────────────────────────────────────────────────────
// Fractional-payout bets (place, and every odds variant) suffer per-chip floor
// loss under naive resolution: three $1 chips on lay 4 (1:2) each floor to $0,
// costing the player $1 vs a real dealer paying floor(3/2)=$1 on the stack. So
// for these types we SUM stake by (type, pick) and pay ONCE from the aggregate.
// Every stackable bet is one-decision-per-round (place: pay winnings, keep=true;
// odds: pay stake+winnings, keep=false), so paying "the stack" here without any
// per-chip credit reproduces the dealer's exact motion — you never double-pay.
const STACKABLE_ODDS = new Set<CrapsBetType>([
  'passodds', 'comeodds', 'dontpassodds', 'dontcomeodds',
]);

/** Aggregate payout for a stackable WIN, from the summed stake on that (type,pick).
 *  place → winnings only (stake stays working, credited=false-ish semantics
 *  handled by leaving the chips in `kept`). passodds/comeodds → stake + true
 *  odds. dontpassodds/dontcomeodds → stake + lay odds. */
function stackPayout(type: CrapsBetType, pick: number, totalStake: number): number {
  if (type === 'place') {
    const [num, den] = PLACE_ODDS[pick] ?? [1, 1];
    return Math.floor((totalStake * num) / den);
  }
  if (type === 'passodds' || type === 'comeodds') {
    const [num, den] = TRUE_ODDS[pick] ?? [1, 1];
    return totalStake + Math.floor((totalStake * num) / den);
  }
  if (type === 'dontpassodds' || type === 'dontcomeodds') {
    const [num, den] = LAY_ODDS[pick] ?? [1, 1];
    return totalStake + Math.floor((totalStake * num) / den);
  }
  return 0;
}

/** Per-player resolution of a whole roll: total credited + the pruned bet list
 *  each player carries to the next roll. Players with a positive credit appear
 *  in `payouts`; every player with any bet appears in `remaining` (an empty
 *  array clears their felt).
 *
 *  Travel semantics: when a come/dontcome bet's first roll establishes a come
 *  point, resolveCrapsBet returns `travel(sum)` (keep=true + travelPoint). We
 *  stamp the come point onto the kept copy of that bet so the NEXT roll sees
 *  `{type:'come', point:N}` and settles it correctly.
 *
 *  Stack aggregation: PLACE stakes AND every odds-type stake are summed by
 *  (type, pick) BEFORE rounding — so a stack of six 1-chip bets on PLACE 6 pays
 *  7 (not six 0-payouts from Math.floor(1*7/6) each), and five 1-chip passodds
 *  on point 6 pay 11 (5+floor(30/5)) not the 10 per-chip flooring would yield.
 *  This mirrors what a real dealer does on the felt. */
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
    // (type,pick) → summed stake, for the aggregate-payout types.
    const stack = new Map<string, number>();
    const isStackable = (t: CrapsBetType) => t === 'place' || STACKABLE_ODDS.has(t);
    for (const bet of bets) {
      if (isStackable(bet.type) && bet.pick != null) {
        const k = `${bet.type}:${bet.pick}`;
        stack.set(k, (stack.get(k) ?? 0) + bet.amount);
      }
    }
    // Track which stack keys we have already paid so we credit the aggregate ONCE
    // even though multiple bets under that key produced 'win' outcomes.
    const paidStack = new Set<string>();
    for (const bet of bets) {
      const r = resolveCrapsBet(bet, d1, d2, pointBefore);
      if (r.keep) {
        // Stamp the come point onto a traveling come/dontcome bet so subsequent
        // rolls resolve it against the right number. All other kept bets pass
        // through unchanged (immutably — we never mutate the caller's list).
        if (r.travelPoint !== undefined
            && (bet.type === 'come' || bet.type === 'dontcome')) {
          kept.push({ ...bet, point: r.travelPoint });
        } else {
          kept.push(bet);
        }
      }
      if (isStackable(bet.type) && bet.pick != null && r.outcome === 'win') {
        const k = `${bet.type}:${bet.pick}`;
        if (!paidStack.has(k)) {
          paidStack.add(k);
          total += stackPayout(bet.type, bet.pick, stack.get(k) ?? bet.amount);
        }
        // r.credited is deliberately dropped for stackable wins — the aggregate
        // above already pays the same money the per-chip resolver would return.
      } else {
        total += r.credited;
      }
    }
    if (total > 0) payouts[pid] = total;
    remaining[pid] = kept;
  }
  return { payouts, remaining };
}

/** Player-facing label for a bet (plain language, upper-case UI voice). Come /
 *  don't come labels include the traveled come point when stamped, so the felt
 *  and the cashier tape read "COME 8" instead of a bare "COME" after travel. */
export function crapsBetLabel(bet: CrapsBet): string {
  switch (bet.type) {
    case 'pass': return 'PASS LINE';
    case 'dontpass': return "DON'T PASS";
    case 'come': return bet.point != null ? `COME ${bet.point}` : 'COME';
    case 'dontcome': return bet.point != null ? `DON'T COME ${bet.point}` : "DON'T COME";
    case 'passodds': return `PASS ODDS ${bet.pick ?? ''}`.trim();
    case 'dontpassodds': return `DON'T PASS ODDS ${bet.pick ?? ''}`.trim();
    case 'comeodds': return `COME ODDS ${bet.pick ?? ''}`.trim();
    case 'dontcomeodds': return `DON'T COME ODDS ${bet.pick ?? ''}`.trim();
    case 'field': return 'FIELD';
    case 'place': return `PLACE ${bet.pick}`;
    case 'anyseven': return 'ANY 7';
    case 'anycraps': return 'ANY CRAPS';
    default: return '?';
  }
}

/** MAXIMUM ODDS the house lets a player back a flat pass/come bet with. The
 *  classic "3x/4x/5x" schedule (the standard modern casino cap): 3x on 4/10,
 *  4x on 5/9, 5x on 6/8. Payout stays true odds; the CAP limits stake weight
 *  and thus the WINNING amount. Exported for the UI to gate odds-chip placement
 *  and for tests to pin. Zero or negative flat stakes floor at 0. */
export function crapsMaxOdds(flatStake: number, point: number): number {
  const mult = point === 4 || point === 10 ? 3
             : point === 5 || point === 9 ? 4
             : point === 6 || point === 8 ? 5
             : 0;
  return Math.max(0, flatStake) * mult;
}

/** MAXIMUM LAY (dontpass/dontcome odds) the house lets a player put out. On the
 *  don't side the 3x/4x/5x schedule limits the POSSIBLE WIN, not the amount at
 *  risk — so the player may LAY MORE than they would BACK. Concretely, for a
 *  flat stake F:
 *    4/10 → win cap 3F, lay pays 1:2, so laid = 3F · 2 = 6F  (wins 3F)
 *    5/9  → win cap 4F, lay pays 2:3, so laid = 4F · 3/2 = 6F (wins 4F)
 *    6/8  → win cap 5F, lay pays 5:6, so laid = 5F · 6/5 = 6F (wins 5F)
 *  All points collapse to a uniform 6F lay cap under the modern schedule; the
 *  computation stays general so a bespoke schedule still lays the right amount.
 *  The felt uses this to allow the correct don't-side chip weight instead of
 *  the pass-side cap that undercuts the advertised maximum (audit remediation,
 *  round 2). Returns 0 for a non-point input or a zero/negative flat stake. */
export function crapsMaxLayOdds(flatStake: number, point: number): number {
  const winCap = crapsMaxOdds(flatStake, point);          // e.g., 3F for 4/10
  if (winCap <= 0) return 0;
  const [num, den] = LAY_ODDS[point] ?? [0, 0];
  if (num <= 0) return 0;                                  // non-point input
  // WIN = laid * num/den; solve for laid at the win cap. Floor because the
  // house always rounds a max-lay DOWN to what pays a clean integer win.
  return Math.floor((winCap * den) / num);
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
