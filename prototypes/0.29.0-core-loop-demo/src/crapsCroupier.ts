/**
 * 🎲🤖 The auto-stickman (#69 G3, reusing the #77B auto-croupier split) — the
 * owner's robot runs a craps table on a timed roll cycle: it calls "place your
 * bets", throws the dice, resolves the felt, and pays the winners on a rhythm,
 * so a table plays itself.
 *
 * THE SPLIT (identical safety model to croupier.ts):
 *   • The ROBOT is local ambience — every client renders its own stickman at the
 *     table's `stickman` stand and narrates; nothing about the robot crosses the
 *     wire.
 *   • The GAME STATE is the synced `casino` Y.Map (`table:<id>`), whole-value
 *     LWW, written by ONE elected client (the room DEED HOLDER — see
 *     croupier.canRunCroupier, shared with roulette).
 *
 * CRAPS ≠ ROULETTE: a roulette settle clears the felt every spin. A craps roll
 * only settles the bets that GOT a decision — a pass line waiting on its point,
 * a working place bet, ride to the next roll. So the settle also PRUNES each
 * player's bet list (writeMyCrapsBets with the survivors) and carries the POINT
 * forward into the next betting window. This is the one place a client other
 * than the bet's owner rewrites `bets:<id>:<pid>` — safe because it happens at
 * the settle, disjoint from the players' betting window (documented v1; the G4
 * Registry chips + a claim lane close it for real).
 *
 * NO SHARED CLOCK, FAIRNESS = dev-phase trust — same as croupier.ts: the
 * operator's Date.now() drives the deadlines and its client throws the dice; the
 * G5 commit-reveal upgrade slots in around resolveCrapsRound untouched.
 */

import { canRunCroupier } from './croupier';
import {
  clearTableKeys,
  creditChips,
  readAllCrapsBets,
  readCrapsTableState,
  writeCrapsTableState,
  writeMyCrapsBets,
} from './casinoDoc';
import { nextPoint, resolveCrapsRound } from './games/craps';
import type { CrapsTableState } from './games/craps';

/** Betting window once the first chip lands (the clock arms on a real bet, so a
 *  quiet come-out table never throws to an empty felt). */
export const CRAPS_BET_WINDOW_MS = 16_000;
/** "No more bets" beat before the dice fly. */
export const CRAPS_CLOSING_MS = 2_500;
/** How long the settled roll + payouts stay up before the next window opens
 *  (≥ the local dice-tumble animation, so the number lingers after it stops). */
export const CRAPS_SHOW_MS = 6_000;

// ── Random dice (operator-side; dev-phase trust — G5 adds commit-reveal) ──────

/** One fair die 1–6 via rejection sampling (no modulo bias). */
function rollDie(): number {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294967292) return (buf[0] % 6) + 1; // floor(2^32/6)*6
  }
}

// ── Phase transitions (the single settle/open implementation) ─────────────────

/** Throw the dice, resolve the roll, publish the settled record, credit winners,
 *  and PRUNE each player's felt. Called by the operator's timer (with `autoShowMs`
 *  so it auto-opens the next window) AND by the manual ROLL button (no
 *  `autoShowMs` — the house clicks NEXT ROLL). Returns the two dice. */
export function rollAndSettleCraps(
  tableId: string,
  round: number,
  pointBefore: number | null,
  autoShowMs?: number,
): [number, number] {
  const d1 = rollDie();
  const d2 = rollDie();
  const sum = d1 + d2;
  const { payouts, remaining } = resolveCrapsRound(
    readAllCrapsBets(tableId),
    d1,
    d2,
    pointBefore,
  );
  const now = Date.now();
  writeCrapsTableState(tableId, {
    kind: 'craps',
    phase: 'settled',
    round,
    point: nextPoint(pointBefore, sum),
    dice: [d1, d2],
    result: sum,
    resultAt: now,
    payouts,
    ...(autoShowMs != null ? { phaseDeadline: now + autoShowMs } : {}),
  });
  for (const [pid, amount] of Object.entries(payouts)) creditChips(pid, amount);
  // Prune the felt: rewrite each player's list to only the bets that survived
  // (standing pass/place). Empty ⇒ their felt clears. Owner-key write by the
  // operator — see module header on why the disjoint window makes it safe.
  for (const [pid, bets] of Object.entries(remaining)) {
    writeMyCrapsBets(tableId, pid, bets);
  }
  return [d1, d2];
}

/** Open a fresh betting window carrying the point forward (idle — no timer until
 *  a bet, or a standing bet, arms it). */
export function openCrapsBetting(tableId: string, round: number, point: number | null): void {
  writeCrapsTableState(tableId, {
    kind: 'craps',
    phase: 'betting',
    round,
    point,
    dice: null,
    result: null,
    resultAt: 0,
    payouts: null,
  });
}

/** Any chips on the felt (fresh bets OR standing pass/place from prior rolls)? */
function hasLiveBets(tableId: string): boolean {
  return Object.keys(readAllCrapsBets(tableId)).length > 0;
}

/**
 * One operator tick for one craps table. Idempotent per frame — only writes on a
 * real transition. The window ARMS when there are live bets (so an empty come-out
 * table stays quiet, but a point cycle with standing bets keeps rolling), then
 * betting → closing → settled → next window on the deadlines. Call ONLY when
 * canRunCroupier() (the caller gates), else two clients race the settle.
 */
export function tickAutoStickman(tableId: string): void {
  const now = Date.now();
  const s = readCrapsTableState(tableId);
  if (!s) {
    openCrapsBetting(tableId, 1, null);
    return;
  }
  if (s.phase === 'betting') {
    if (s.phaseDeadline == null) {
      if (hasLiveBets(tableId)) {
        writeCrapsTableState(tableId, { ...s, phaseDeadline: now + CRAPS_BET_WINDOW_MS });
      }
    } else if (now >= s.phaseDeadline) {
      writeCrapsTableState(tableId, {
        ...s,
        phase: 'closing',
        phaseDeadline: now + CRAPS_CLOSING_MS,
      });
    }
  } else if (s.phase === 'closing') {
    if (now >= (s.phaseDeadline ?? now)) {
      rollAndSettleCraps(tableId, s.round, s.point, CRAPS_SHOW_MS);
    }
  } else if (s.phase === 'settled') {
    if (s.phaseDeadline != null && now >= s.phaseDeadline) {
      openCrapsBetting(tableId, s.round + 1, s.point);
    }
  }
}

/**
 * Tear a craps table down cleanly on removal (mirrors croupier.closeTable). The
 * REFUND of every standing bet (stakes were debited at placement) runs ONLY on
 * the elected operator so it happens exactly once; every client then wipes the
 * table's casino keys (idempotent LWW delete). A manual venture/legacy room has
 * no operator, so stakes are not refunded (matches the manual-mode limitation).
 */
export function closeCrapsTable(tableId: string): void {
  if (canRunCroupier()) {
    for (const [pid, bets] of Object.entries(readAllCrapsBets(tableId))) {
      const staked = bets.reduce((sum, b) => sum + b.amount, 0);
      if (staked > 0) creditChips(pid, staked);
    }
  }
  clearTableKeys(tableId);
}

// ── Narration ─────────────────────────────────────────────────────────────────

/** The stickman's call for the current state, plus a once-per-round-per-phase
 *  `key` for edge-detection (so each beat pops exactly one bubble per client).
 *  null between beats (idle betting, mid-animation nothing-new). */
export function crapsBeatLine(
  s: CrapsTableState,
): { key: string; text: string } | null {
  if (s.phase === 'betting' && s.phaseDeadline != null) {
    const call = s.point == null
      ? '🎲 Coming out — place your bets!'
      : `🎲 The point is ${s.point} — place your bets!`;
    return { key: `${s.round}:open`, text: call };
  }
  if (s.phase === 'closing') {
    return { key: `${s.round}:close`, text: '✋ No more bets!' };
  }
  if (s.phase === 'settled' && s.dice != null && s.result != null) {
    const [a, b] = s.dice;
    const paid = s.payouts != null && Object.keys(s.payouts).length > 0;
    const tail = s.result === 7 && s.point == null ? ' — seven out'
      : paid ? ' — winners paid!' : ' — house collects';
    return { key: `${s.round}:settle`, text: `🎲 ${a}+${b} = ${s.result}${tail}` };
  }
  return null;
}
