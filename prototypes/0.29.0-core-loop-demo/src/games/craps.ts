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
  | 'twelve'    // one-roll: boxcars, pays 30:1
  | 'passodds'      // odds behind the pass line — true odds on the point
  | 'dontpassodds'  // lay odds behind the don't pass — true odds against the point
  | 'comeodds'      // odds on a travelled come bet (pick = its number)
  | 'dontcomeodds'; // lay odds on a travelled don't come bet (pick = its number)

export interface CrapsBet {
  type: CrapsBetType;
  /** place: the number (4,5,6,8,9,10); hard: 4/6/8/10; come / dontcome: the
   *  number the bet TRAVELLED to (absent while it still sits in the come box);
   *  comeodds / dontcomeodds: the come point they back (required). Absent for
   *  every other bet — passodds / dontpassodds always back the table's point. */
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
  /** ⚖️ A Fair roll voided because the house seed couldn't be revealed: no
   *  dice, every bet stands (roulette: every stake returned). */
  voided?: boolean;
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
  /** 🧾 This table's incarnation (casinoDoc tableIncFor), kept roll to roll:
   *  a table set up again under the same id pays its own rolls. */
  inc?: string;
  /** ⚖️ This round's seed commitments (see SeedRoundFields). */
  houseCommit?: string;
  commits?: Record<string, string>;
  unseeded?: string[];
  wagers?: Record<string, string>;
  sigs?: Record<string, string>;
  stakes?: Record<string, number>;
  bettors?: string[];
  /** ⚖️ The fairness mode locked in when this window opened; the settle uses
   *  it, so an owner's switch mid-window applies from the next one. */
  fairMode?: FairnessMode;
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
  /** ⚖️ A LIVE multiparty roll (Fair by default): who each commit belongs to,
   *  index-aligned with `commits` and `seeds` — 'house' first, then each
   *  bettor's player id. A party that committed but never revealed has an
   *  empty seed: their bets were forfeited and the result came from the rest.
   *  Absent on the older dev-simulated transcripts. */
  parties?: string[];
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
    && (f.simulated === undefined || typeof f.simulated === 'boolean')
    && (f.parties === undefined || (
        isBoundedStringArray(f.parties)
        && f.commits?.length === f.parties.length
        && f.seeds?.length === f.parties.length
    ));
}

/** The party name a live multiparty transcript gives the house's seed. */
export const HOUSE_PARTY = 'house';

/** ⚖️ The per-round seed commitments on a Fair table's state (craps and
 *  roulette share them). `houseCommit` is written when the betting window
 *  opens; `commits` is the bettors' commitments FROZEN at "no more bets" —
 *  only these parties are asked to reveal, and only their seeds count. */
export interface SeedRoundFields {
  houseCommit?: string;
  commits?: Record<string, string>;
  /** Players with chips down at "no more bets" who added no seed (their
   *  client never committed in time, or the party cap was full). They are
   *  protected only by the other parties' seeds — shown on the table card. */
  unseeded?: string[];
  /** Each frozen bettor's wager list, hashed at "no more bets": the settle
   *  pays only lists that still match. */
  wagers?: Record<string, string>;
  /** Each frozen bettor's signature over its commitment (its identity key,
   *  players[pid].keyB64): nobody else can put a seed in under its name. */
  sigs?: Record<string, string>;
  /** 🪙 The chips each frozen bettor's list held on the felt at "no more
   *  bets" (0 for an earlier build's list, whose chips were taken): what the
   *  settle takes, whatever the list says by then. */
  stakes?: Record<string, number>;
  /** A round without the exchange (RNG): the players with chips down at "no
   *  more bets", the only ones its settle writes up. */
  bettors?: string[];
}

function isPidMap(v: unknown, max: number): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= max
    && entries.every(([pid, c]) => pid.length > 0 && pid.length <= 128
      && typeof c === 'string' && c.length <= FAIRNESS_MAX_STRING);
}

/** Chips per player, either sign (a stake held on the felt can be below 0:
 *  casinoDoc FeltStake), never past what one list can hold. */
function isPidStakeMap(v: unknown, max: number): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= max
    && entries.every(([pid, n]) => pid.length > 0 && pid.length <= 128 && Number.isSafeInteger(n)
      && Math.abs(n as number) <= MAX_BETS_PER_PLAYER * MAX_BET_AMOUNT);
}

/** Shape guard for the peer-written seed fields (bounded like transcripts). */
export function isSeedRoundFields(s: SeedRoundFields): boolean {
  if (s.houseCommit !== undefined
    && (typeof s.houseCommit !== 'string' || s.houseCommit.length > FAIRNESS_MAX_STRING)) return false;
  if (s.unseeded !== undefined && !(isBoundedStringArray(s.unseeded) && s.unseeded.length <= FAIRNESS_MAX_PARTIES)) return false;
  if (s.wagers !== undefined && !isPidMap(s.wagers, 2 * FAIRNESS_MAX_PARTIES)) return false;
  if (s.sigs !== undefined && !isPidMap(s.sigs, FAIRNESS_MAX_PARTIES - 1)) return false;
  if (s.stakes !== undefined && !isPidStakeMap(s.stakes, 2 * FAIRNESS_MAX_PARTIES)) return false;
  if (s.bettors !== undefined && !(Array.isArray(s.bettors) && s.bettors.length <= 2 * FAIRNESS_MAX_PARTIES
    && s.bettors.every((pid) => typeof pid === 'string' && pid.length > 0 && pid.length <= 128))) return false;
  return s.commits === undefined || isPidMap(s.commits, FAIRNESS_MAX_PARTIES - 1);
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
  'passodds', 'dontpassodds', 'comeodds', 'dontcomeodds',
];

/** Shape guard — bets cross the room-doc trust boundary (peer writes). */
/** The most chips one bet record holds, and the most records one player's
 *  list holds (the felt puts down one chip a record, 1000 at most, and 400
 *  records a player). At the best odds on either table (36 for 1) a list's
 *  return stays far inside the safe-integer range, so no funded wager can
 *  win more than the chip ledger can pay. A list past either reads as no bets. */
export const MAX_BET_AMOUNT = 1_000_000_000;
export const MAX_BETS_PER_PLAYER = 1_000;

export function isCrapsBet(value: unknown): value is CrapsBet {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<CrapsBet>;
  if (typeof b.type !== 'string' || !BET_TYPES.includes(b.type)) return false;
  if (!Number.isInteger(b.amount) || (b.amount as number) <= 0 || (b.amount as number) > MAX_BET_AMOUNT) return false;
  if (b.type === 'place') {
    return Number.isInteger(b.pick) && POINT_NUMBERS.has(b.pick as number);
  }
  if (b.type === 'hard') {
    return Number.isInteger(b.pick) && HARD_NUMBERS.has(b.pick as number);
  }
  if (b.type === 'comeodds' || b.type === 'dontcomeodds') {
    return Number.isInteger(b.pick) && POINT_NUMBERS.has(b.pick as number);
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

/** A table state's incarnation (`inc`), when it has one. */
export function isTableIncField(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= 32);
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
    // A void is the canonical no-outcome shape: no dice, no transcript.
    && (s.voided === undefined || (typeof s.voided === 'boolean'
      && (!s.voided || (s.phase === 'settled' && s.dice === null && s.result === null && s.fairness === undefined
        && s.payouts !== null && Object.keys(s.payouts).length === 0))))
    && (s.fairness === undefined || isFairnessTranscript(s.fairness))
    && (s.phaseDeadline === undefined
        || (typeof s.phaseDeadline === 'number' && Number.isFinite(s.phaseDeadline)))
    && isPlayerIdField(s.shooter)
    && isPlayerIdField(s.lastShooter)
    && isPlayerIdField(s.operator)
    && isTableIncField(s.inc)
    && isSeedRoundFields(s)
    && (s.fairMode === undefined || FAIRNESS_MODES.includes(s.fairMode));
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
  // Line odds back the point, so there must be one. Come / don't come odds
  // can go up whenever their come bet stands (oddsRoom checks that).
  if (type === 'passodds' || type === 'dontpassodds') return point !== null;
  return true;
}

/** Whether a bet may come off the felt while betting is open ("take me
 *  down"). Real-casino rules: a pass line bet once its point is set, and a
 *  come bet once it has travelled to a number, are CONTRACT bets and stay
 *  until they win or lose. Everything else may come down: the don't side
 *  (the house is glad to see it go), place / big 6 / big 8 / hardways at any
 *  time, odds, and the one-roll bets before their roll. */
export function canTakeDown(bet: Pick<CrapsBet, 'type' | 'pick'>, point: number | null): boolean {
  if (bet.type === 'pass') return point === null;
  if (bet.type === 'come') return bet.pick === undefined;
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

// ── Odds ─────────────────────────────────────────────────────────────────────
// The one bet on the felt with no house edge. Once a line or come bet has a
// number, its owner may back it with ODDS (pass / come: paid at the true odds
// of that number before a 7) or LAY odds against it (don't pass / don't come:
// the inverse). Odds ride with their flat bet and are decided on the same
// roll; the flat bet is what earns the right to take them, so the stake is
// capped at a multiple of it (the house's 3-4-5x table).
//
// Standard working rules:
//  - Pass / don't pass odds exist only while a point is on (they back IT).
//  - Come odds are OFF on the come-out roll: if the come bet is decided on a
//    come-out roll (its number, or a 7), the flat bet wins / loses as usual
//    and its odds come back untouched.
//  - Don't come lay odds are always working.

/** The four odds bet types. */
export const ODDS_TYPES: ReadonlySet<CrapsBetType> = new Set<CrapsBetType>([
  'passodds', 'dontpassodds', 'comeodds', 'dontcomeodds',
]);

export function isOddsType(type: string): type is 'passodds' | 'dontpassodds' | 'comeodds' | 'dontcomeodds' {
  return ODDS_TYPES.has(type as CrapsBetType);
}

/** TRUE odds by number, winnings:stake — ways to roll a 7 (six) against ways
 *  to roll the number: 4/10 three → 2:1, 5/9 four → 3:2, 6/8 five → 6:5. */
const TRUE_ODDS: Record<number, [number, number]> = {
  4: [2, 1], 5: [3, 2], 6: [6, 5], 8: [6, 5], 9: [3, 2], 10: [2, 1],
};

/** Winnings:stake an odds bet of `type` pays on number `n` — true odds for
 *  pass / come, the inverse (1:2, 2:3, 5:6) for the lay side. */
export function oddsPayout(type: CrapsBetType, n: number): [number, number] {
  const [num, den] = TRUE_ODDS[n] ?? [1, 1];
  return type === 'dontpassodds' || type === 'dontcomeodds' ? [den, num] : [num, den];
}

/** 3-4-5x odds: how many times the flat bet the odds may be, by number. */
export const MAX_ODDS_MULTIPLE: Readonly<Record<number, number>> = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 };

/** Lay odds may be up to 6x the flat bet on every number — the lay that
 *  WINS 3x / 4x / 5x the flat, mirroring the right side's cap. */
export const MAX_LAY_MULTIPLE = 6;

/** Most chips odds of `type` on number `n` may hold behind `flat` chips. */
export function maxOddsStake(type: CrapsBetType, n: number, flat: number): number {
  if (!POINT_NUMBERS.has(n) || flat <= 0) return 0;
  const lay = type === 'dontpassodds' || type === 'dontcomeodds';
  return flat * (lay ? MAX_LAY_MULTIPLE : MAX_ODDS_MULTIPLE[n]);
}

/** The flat bet type an odds type rides on. */
function oddsBaseType(type: CrapsBetType): CrapsBetType {
  return type === 'passodds' ? 'pass' : type === 'dontpassodds' ? 'dontpass'
    : type === 'comeodds' ? 'come' : 'dontcome';
}

/** The chips of flat bet that odds of `type` (on come point `pick`) ride on,
 *  in one player's list: the pass / don't pass line, or the come / don't come
 *  bets that travelled to `pick`. */
export function oddsFlat(bets: readonly CrapsBet[], type: CrapsBetType, pick?: number): number {
  const base = oddsBaseType(type);
  const line = type === 'passodds' || type === 'dontpassodds';
  let flat = 0;
  for (const b of bets) {
    if (b.type !== base) continue;
    if (line || (b.pick !== undefined && b.pick === pick)) flat += b.amount;
  }
  return flat;
}

/** The number odds back: the table's point for line odds, the bet's own pick
 *  for come odds. null ⇒ nothing to back. */
function oddsNumber(type: CrapsBetType, pick: number | undefined, point: number | null): number | null {
  const n = type === 'passodds' || type === 'dontpassodds' ? point : pick ?? null;
  return n !== null && POINT_NUMBERS.has(n) ? n : null;
}

/**
 * How many more chips a player may put on odds of `type` (on come point
 * `pick`) right now, or why none: the felt's check before a chip lands. The
 * settle enforces the same cap (resolveCrapsRound), so a list written around
 * this is paid only up to it.
 */
export function oddsRoom(
  bets: readonly CrapsBet[],
  type: CrapsBetType,
  pick: number | undefined,
  point: number | null,
): { room: number; reason: string | null } {
  if ((type === 'passodds' || type === 'dontpassodds') && point === null) {
    return { room: 0, reason: 'ODDS GO UP ONCE A POINT IS ON' };
  }
  const n = oddsNumber(type, pick, point);
  const flat = n === null ? 0 : oddsFlat(bets, type, pick);
  if (n === null || flat <= 0) {
    const what = type === 'passodds' ? 'PASS LINE BET' : type === 'dontpassodds' ? "DON'T PASS BET"
      : type === 'comeodds' ? `COME BET ON ${pick}` : `DON'T COME BET ON ${pick}`;
    return { room: 0, reason: `NO ${what} TO BACK` };
  }
  const have = bets.filter((b) => b.type === type && b.pick === pick)
    .reduce((a, b) => a + b.amount, 0);
  const room = Math.max(0, maxOddsStake(type, n, flat) - have);
  return room > 0 ? { room, reason: null } : { room: 0, reason: 'THE ODDS ARE AT THE TABLE MAXIMUM' };
}

/**
 * Settle a whole STACK of odds (every chip one player has on one odds spot),
 * given the flat bet it rides on. Paying the stack at once keeps the
 * fractional true-odds payouts from losing a chip per record to rounding.
 * Chips over the cap (or with no flat bet / no point behind them) are not in
 * action: they come back whenever the stack is decided, or at once when
 * nothing backs them at all.
 */
export function resolveOddsStack(
  type: CrapsBetType,
  pick: number | undefined,
  stake: number,
  flat: number,
  d1: number,
  d2: number,
  pointBefore: number | null,
): BetResolution {
  const sum = d1 + d2;
  const n = oddsNumber(type, pick, pointBefore);
  if (n === null) return push(stake);                  // nothing to back
  const working = Math.min(stake, maxOddsStake(type, n, flat));
  if (working <= 0) return push(stake);                // no flat bet behind it
  const spare = stake - working;
  // Come odds are off on the come-out: the come bet is decided on its own and
  // the odds come back.
  if (type === 'comeodds' && pointBefore === null) {
    return sum === n || sum === 7 ? push(stake) : stay;
  }
  const [num, den] = oddsPayout(type, n);
  const win = (): BetResolution => won(working + Math.floor((working * num) / den) + spare);
  const lose = (): BetResolution => ({ credited: spare, keep: false, outcome: 'lose' });
  if (type === 'passodds' || type === 'comeodds') {
    if (sum === n) return win();
    if (sum === 7) return lose();
    return stay;
  }
  if (sum === 7) return win();
  if (sum === n) return lose();
  return stay;
}

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
    case 'passodds':
    case 'dontpassodds':
    case 'comeodds':
    case 'dontcomeodds':
      // On its own, an odds bet is taken as fully backed; resolveCrapsRound
      // checks the flat bet and the cap, and pays the whole stack at once.
      return resolveOddsStack(bet.type, bet.pick, a, Number.MAX_SAFE_INTEGER, d1, d2, pointBefore);
    default:
      return lost;
  }
}

const spotOf = (b: CrapsBet): string => `${b.type}:${b.pick ?? ''}`;

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
    // Odds settle by the stack, against the flat bet as it stood BEFORE this
    // roll (a come bet decided this roll still backs its odds this roll).
    const oddsStacks = new Map<string, BetResolution>();
    for (const bet of bets) {
      if (!isOddsType(bet.type)) continue;
      const k = spotOf(bet);
      if (oddsStacks.has(k)) continue;
      const stake = bets.filter((b) => spotOf(b) === k).reduce((x, b) => x + b.amount, 0);
      const r = resolveOddsStack(bet.type, bet.pick, stake, oddsFlat(bets, bet.type, bet.pick), d1, d2, pointBefore);
      oddsStacks.set(k, r);
      total += r.credited;
    }
    for (const bet of bets) {
      if (isOddsType(bet.type)) {
        if (oddsStacks.get(spotOf(bet))?.keep) kept.push(bet);
        continue;
      }
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
    case 'passodds': return 'PASS LINE ODDS';
    case 'dontpassodds': return "DON'T PASS LAY ODDS";
    case 'comeodds': return `COME ODDS ${bet.pick}`;
    case 'dontcomeodds': return `DON'T COME LAY ODDS ${bet.pick}`;
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
