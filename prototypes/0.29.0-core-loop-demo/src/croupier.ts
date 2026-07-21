/**
 * 🎰🤖 The auto-croupier (#77 Phase B) — the owner's robot runs a roulette
 * table on a timed betting cycle so a table plays itself, calling "place your
 * bets" / "no more bets" and paying out on a rhythm.
 *
 * THE SPLIT that makes this safe (see the #77B design):
 *   • The ROBOT is local ambience — every client renders its own walking to the
 *     wheel-head and narrating; nothing about the robot crosses the wire.
 *   • The GAME STATE is the synced `casino` Y.Map (`table:<id>`), whole-value
 *     LWW, written by ONE elected client. So the TIMER + roll + credit run on a
 *     single operator; the visuals run everywhere.
 *
 * ELECTION = the room's DEED HOLDER (main.ts currentRoomDeedIsMine — the raw
 * at-most-one owner, NOT the shareholder-extended `isHouse`). A personal or solo
 * room has exactly one deed holder ⇒ one croupier ⇒ no double-settle. Venture /
 * legacy 'Local-Clone' rooms (every shareholder is house) are NOT auto-driven —
 * they keep the manual SPIN button. main.ts registers the predicate at boot.
 *
 * NO SHARED CLOCK: the operator's Date.now() is the reference. It stamps an
 * absolute `phaseDeadline` into the record and is the only client that advances
 * the phase; everyone else renders `deadline − localNow` as a display-only
 * countdown (the offers.ts expiresAt precedent, single-writer for seconds-scale).
 *
 * FAIRNESS is dev-phase trust (the operator's client rolls the pocket), exactly
 * like the manual croupier — the G5 commit-reveal upgrade slots in unchanged.
 */

import {
  clearTableKeys,
  creditChips,
  readAllBets,
  readCroupierBeat,
  readTableState,
  writeCroupierBeat,
  writeTableState,
} from './casinoDoc';
import { pocketColor, resolveRound } from './games/roulette';
import type { RouletteTableState } from './games/roulette';

/** Betting window once the first chip lands (the clock arms on a real bet, so a
 *  quiet table never spins nothing). */
export const BET_WINDOW_MS = 18_000;
/** "No more bets" beat before the wheel resolves. */
export const CLOSING_MS = 3_000;
/** How long the settled result + payouts stay up before the next round opens
 *  (≥ the 4 s local wheel animation, so the number lingers after it stops). */
export const SHOW_MS = 9_000;
/** Operator heartbeat cadence — how often the driver refreshes `croupier:<id>`. */
export const HEARTBEAT_MS = 3_000;
/** A beat older than this ⇒ the operator is gone; fall back to manual controls. */
const HEARTBEAT_STALE_MS = 9_000;

// ── Operator election seam (mirrors editMode.canEditRoom) ────────────────────

/** Offline default: no sync ⇒ we are the only client ⇒ we operate. main.ts
 *  swaps in the real deed-holder check at boot. */
let solePredicate: () => boolean = () => true;

export function setSoleCroupierPredicate(fn: () => boolean): void {
  solePredicate = fn;
}

/** May THIS client drive the auto-croupier here? True on exactly one client in
 *  a personal/solo room; false in venture / legacy shared rooms (manual). */
export function canRunCroupier(): boolean {
  return solePredicate();
}

// ── Random pocket (operator-side; dev-phase trust — G5 adds commit-reveal) ────

/** Uniform pocket 0–36 via rejection sampling (no modulo bias). */
function spinPocket(): number {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294967289) return buf[0] % 37; // floor(2^32/37)*37
  }
}

// ── Phase transitions (the single settle/open implementation) ─────────────────

/** Roll, resolve, publish the settled record, and credit winners. Called by the
 *  operator's timer (with `autoShowMs` so it auto-opens the next round) AND by
 *  the manual SPIN button (no `autoShowMs` — the house clicks NEW ROUND). */
export function rollAndSettle(
  tableId: string,
  round: number,
  autoShowMs?: number,
): number {
  const result = spinPocket();
  const payouts = resolveRound(readAllBets(tableId, round), result);
  const now = Date.now();
  writeTableState(tableId, {
    kind: 'roulette',
    phase: 'settled',
    round,
    result,
    resultAt: now,
    payouts,
    ...(autoShowMs != null ? { phaseDeadline: now + autoShowMs } : {}),
  });
  for (const [pid, amount] of Object.entries(payouts)) creditChips(pid, amount);
  return result;
}

/** Open a fresh betting round (idle — no timer until a first bet arms it). */
export function openBetting(tableId: string, round: number): void {
  writeTableState(tableId, {
    kind: 'roulette',
    phase: 'betting',
    round,
    result: null,
    resultAt: 0,
    payouts: null,
  });
}

/**
 * One operator tick for one table. Idempotent per frame — only writes on a real
 * transition. The window ARMS on the first bet (so an empty table stays quiet),
 * then betting → closing → settled → next round on the deadlines. Call ONLY when
 * canRunCroupier() (the caller gates), else two clients race the settle.
 */
export function tickAutoCroupier(tableId: string): void {
  const now = Date.now();
  const s = readTableState(tableId);
  if (!s) {
    openBetting(tableId, 1);
    return;
  }
  if (s.phase === 'betting') {
    if (s.phaseDeadline == null) {
      // Arm the clock the moment the first chip is on the felt.
      if (Object.keys(readAllBets(tableId, s.round)).length > 0) {
        writeTableState(tableId, { ...s, phaseDeadline: now + BET_WINDOW_MS });
      }
    } else if (now >= s.phaseDeadline) {
      writeTableState(tableId, {
        ...s,
        phase: 'closing',
        phaseDeadline: now + CLOSING_MS,
      });
    }
  } else if (s.phase === 'closing') {
    if (now >= (s.phaseDeadline ?? now)) rollAndSettle(tableId, s.round, SHOW_MS);
  } else if (s.phase === 'settled') {
    if (s.phaseDeadline != null && now >= s.phaseDeadline) {
      openBetting(tableId, s.round + 1);
    }
  }
}

// ── Heartbeat (operator liveness, for the UI + narration) ─────────────────────

/**
 * Tear a table down cleanly on removal from a room. Safe to call on any client:
 * the REFUND of an unresolved round (stakes were debited at placement, and once
 * the records vanish there is no other credit-back path) runs ONLY on the elected
 * operator (canRunCroupier) so it happens exactly once and never double-credits;
 * every client then wipes the table's casino keys (idempotent LWW delete) so no
 * orphan records survive. In a manual venture/legacy room there is no operator,
 * so stakes are not refunded (matches the manual-mode limitation) — the keys are
 * still cleared.
 */
export function closeTable(tableId: string): void {
  if (canRunCroupier()) {
    const s = readTableState(tableId);
    if (s && s.phase !== 'settled') {
      for (const [pid, bets] of Object.entries(readAllBets(tableId, s.round))) {
        const staked = bets.reduce((sum, b) => sum + b.amount, 0);
        if (staked > 0) creditChips(pid, staked);
      }
    }
  }
  clearTableKeys(tableId);
}

export function beatCroupier(tableId: string): void {
  writeCroupierBeat(tableId, Date.now());
}

/** Is a robot croupier actively running this table right now? */
export function isCroupierLive(tableId: string): boolean {
  const beat = readCroupierBeat(tableId);
  return beat != null && Date.now() - beat < HEARTBEAT_STALE_MS;
}

// ── Narration ─────────────────────────────────────────────────────────────────

/** The croupier's call for the current state, plus a once-per-round-per-phase
 *  `key` for edge-detection (so each beat pops exactly one bubble per client).
 *  null between beats (idle betting, mid-animation nothing-new). */
export function croupierBeatLine(
  s: RouletteTableState,
): { key: string; text: string } | null {
  if (s.phase === 'betting' && s.phaseDeadline != null) {
    return { key: `${s.round}:open`, text: '🎲 Place your bets!' };
  }
  if (s.phase === 'closing') {
    return { key: `${s.round}:close`, text: '✋ No more bets!' };
  }
  if (s.phase === 'settled' && s.result != null) {
    const paid = s.payouts != null && Object.keys(s.payouts).length > 0;
    const col = pocketColor(s.result).toUpperCase();
    return {
      key: `${s.round}:settle`,
      text: `🎡 ${s.result} ${col} — ${paid ? 'winners paid!' : 'house wins'}`,
    };
  }
  return null;
}
