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
import { getPlayerId } from './identity';
import { FURNITURE_DEFS } from './furniture';
import {
  casinoDocEpoch,
  clearTableKeys,
  creditChips,
  readAllCrapsBets,
  readCrapsTableState,
  readDiceThrow,
  readSeats,
  writeCrapsTableState,
  writeDiceThrow,
} from './casinoDoc';
import { CRAPS_DICE_SPOT } from './games/casinoLayout';
import { hasLineBet, pickShooter } from './games/craps';
import type { CrapsTableState, SeatedPlayer } from './games/craps';
// 🎲🔗 #69 G5 seam: the roll+settle is pluggable — local (crypto RNG + room-doc
// chips, default) or an optional Chia gaming backend. See crapsBackend.ts.
import { selectCrapsBackend } from './crapsBackend';

/** Betting window once the first chip lands (the clock arms on a real bet, so a
 *  quiet come-out table never throws to an empty felt). */
export const CRAPS_BET_WINDOW_MS = 16_000;
/** "No more bets" beat before the dice fly. */
export const CRAPS_CLOSING_MS = 2_500;
/** How long the settled roll + payouts stay up before the next window opens
 *  (≥ the local dice-tumble animation, so the number lingers after it stops). */
export const CRAPS_SHOW_MS = 6_000;
/** 🎲 #226: how long a shooter has to pick the dice up and fling them before
 *  the stickman throws for them. */
export const CRAPS_SHOOTER_MS = 20_000;
/** A seat whose heartbeat has not moved for this long (operator clock) is
 *  gone — the page crashed or lost its connection without clearing it. */
export const SEAT_STALE_MS = 15_000;
/** The stickman's spot on the felt (the layout's dice spot). */
export const STICKMAN_DICE_SPOT = CRAPS_DICE_SPOT;

// ── Phase transitions (the single settle/open implementation) ─────────────────

/** Tables mid-settle — guards the fire-and-forget async settle from re-entry.
 *  The operator's per-frame tick would otherwise call rollAndSettleCraps every
 *  frame while the phase is still 'closing' (the settled write lands a few ms
 *  later, after the fairness hashing), double-rolling. */
const settling = new Set<string>();

/** Throw the dice (via the table's fairness mode + settlement backend), resolve
 *  the roll, publish the settled record, credit winners, and PRUNE each felt.
 *  FIRE-AND-FORGET: the fairness modes hash (async), so this kicks off the settle
 *  and returns; the settled state lands when it completes and every client
 *  re-renders on the doc change. Re-entrant calls (same table, still settling)
 *  are ignored. Called by the operator's timer (with `autoShowMs`) AND the manual
 *  ROLL button (no `autoShowMs` — the house clicks NEXT ROLL). */
export function rollAndSettleCraps(
  tableId: string,
  round: number,
  pointBefore: number | null,
  autoShowMs?: number,
): void {
  if (settling.has(tableId)) return;
  settling.add(tableId);
  // ✋ Slam the window BEFORE the async settle (#87 review): the manual ROLL
  // fires from 'betting', and the fairness hashing keeps the settled write
  // ms-to-seconds away — without an immediate 'closing' write, every client
  // keeps accepting bets while the dice are already out. Mirror the auto
  // path's closing shape (same deadline beat) so a live operator's tick
  // treats it exactly like its own transition; the settle landing first
  // (typical) makes the deadline moot. The auto path arrives already
  // 'closing', so this is a no-op there.
  const s = readCrapsTableState(tableId);
  if (s?.phase === 'betting') {
    writeCrapsTableState(tableId, {
      ...s,
      phase: 'closing',
      phaseDeadline: Date.now() + CRAPS_CLOSING_MS,
    });
  }
  selectCrapsBackend(tableId)
    .rollAndSettle(tableId, round, pointBefore, autoShowMs)
    .catch((err) => console.error('[craps] settle failed:', err))
    .finally(() => settling.delete(tableId));
}

/** Open a fresh betting window carrying the point forward (idle — no timer until
 *  a bet, or a standing bet, arms it). `after` is the roll that just settled:
 *  its shooter keeps the dice, unless it sevened out — then the dice pass on
 *  (the next shooter is picked clockwise from them when the window closes). */
export function openCrapsBetting(
  tableId: string,
  round: number,
  point: number | null,
  after?: CrapsTableState | null,
): void {
  const handOver = after?.sevenOut === true;
  const shooter = handOver ? undefined : after?.shooter;
  const lastShooter = handOver ? after?.shooter ?? after?.lastShooter : after?.lastShooter;
  writeCrapsTableState(tableId, {
    kind: 'craps',
    phase: 'betting',
    round,
    point,
    dice: null,
    result: null,
    resultAt: 0,
    payouts: null,
    ...(shooter !== undefined ? { shooter } : {}),
    ...(lastShooter !== undefined ? { lastShooter } : {}),
  });
}

// ── 🎲 #226: the shooter ──────────────────────────────────────────────────────

/** table:player → [its `at`, when THIS client last saw `at` change, and
 *  whether it has seen it change at all]. Scoped to one room doc: another
 *  room's table can share the id, the player and even the heartbeat value, so
 *  a rebind starts it over. */
const seatSeen = new Map<string, { at: number; seenAt: number; moved: boolean }>();
let seatSeenEpoch = -1;

/** Players standing at the table right now, judged on the operator's own clock:
 *  a seat counts once this client has watched its heartbeat move, and while it
 *  keeps moving. A seat left behind by a crashed page never moves, so it never
 *  counts — however fresh the operator. The operator samples every tick. */
export function seatedPlayers(tableId: string, now = Date.now()): SeatedPlayer[] {
  if (seatSeenEpoch !== casinoDocEpoch()) {
    seatSeenEpoch = casinoDocEpoch();
    seatSeen.clear();
  }
  const out: SeatedPlayer[] = [];
  for (const [pid, seat] of Object.entries(readSeats(tableId))) {
    const key = `${tableId}:${pid}`;
    const prev = seatSeen.get(key);
    if (!prev) seatSeen.set(key, { at: seat.at, seenAt: now, moved: false });
    else if (prev.at !== seat.at) seatSeen.set(key, { at: seat.at, seenAt: now, moved: true });
    const seen = seatSeen.get(key)!;
    // The seat is peer-written: only a real player stand counts, and its
    // place in the ring comes from the table's layout, not the stored angle.
    const t = FURNITURE_DEFS['craps-table'].stands?.[seat.stand];
    if (!t || t.role) continue;
    if (seen.moved && now - seen.seenAt < SEAT_STALE_MS) {
      out.push({ pid, angle: Math.atan2(t.stand.z, t.stand.x) });
    }
  }
  return out;
}

/** Who throws when betting closes on `s`: the hand's shooter while they are
 *  still at the table; on a come-out with nobody holding the dice, the next
 *  player clockwise with a line bet; otherwise nobody (the stickman throws). */
export function shooterForClose(tableId: string, s: CrapsTableState, now = Date.now()): string | undefined {
  const seated = seatedPlayers(tableId, now);
  const stillHere = s.shooter !== undefined && seated.some((p) => p.pid === s.shooter);
  if (s.point !== null) {
    // Mid-hand the shooter keeps the dice; if they left, the stickman finishes.
    return stillHere ? s.shooter : undefined;
  }
  // A come-out needs a line bet from whoever rolls — the shooter included.
  const bets = readAllCrapsBets(tableId);
  const eligible = (pid: string) => hasLineBet(bets[pid] ?? []);
  if (stillHere && eligible(s.shooter!)) return s.shooter;
  return pickShooter(seated, eligible, s.shooter ?? s.lastShooter) ?? undefined;
}

/** The stickman throws for the table (no shooter, or the shooter ran out of
 *  time): record the throw so every client animates it, then settle. */
export function stickmanThrows(tableId: string, s: CrapsTableState, autoShowMs?: number): void {
  // The operator ticks every frame while the async settle is in flight: one
  // throw per roll, or every client's dice would restart their tumble.
  if (settling.has(tableId)) return;
  writeDiceThrow(tableId, {
    round: s.round,
    by: 'stickman',
    sx: STICKMAN_DICE_SPOT.x,
    sz: STICKMAN_DICE_SPOT.z,
    dx: (Math.random() - 0.5) * 0.5,
    dz: -1,
    power: 0.55,
    seed: Math.floor(Math.random() * 2 ** 31),
  });
  rollAndSettleCraps(tableId, s.round, s.point, autoShowMs);
}

/** Any chips on the felt (fresh bets OR standing pass/place from prior rolls)? */
function hasLiveBets(tableId: string): boolean {
  return Object.keys(readAllCrapsBets(tableId)).length > 0;
}

/** When the operator last sampled each table's seats. */
const seatSampledAt = new Map<string, number>();

/** Watch the seats' heartbeats all window long (once a second: each look
 *  scans the room doc), so the shooter pick at the close judges them on what
 *  this client actually saw move. */
export function sampleSeats(tableId: string, now = Date.now()): void {
  if (now - (seatSampledAt.get(tableId) ?? 0) < 1000) return;
  seatSampledAt.set(tableId, now);
  seatedPlayers(tableId, now);
}

/** "No more bets": the stickman pushes the dice to the shooter, who then has
 *  CRAPS_SHOOTER_MS to fling them (#226); with no shooter the stickman throws
 *  after the usual beat. The robot's tick and the house's manual ROLL share it. */
export function closeCrapsBetting(tableId: string, s: CrapsTableState, now = Date.now(), manual = false): void {
  const shooter = shooterForClose(tableId, s, now);
  const next: CrapsTableState = {
    ...s,
    phase: 'closing',
    phaseDeadline: now + (shooter ? CRAPS_SHOOTER_MS : CRAPS_CLOSING_MS),
  };
  if (shooter) next.shooter = shooter;
  else delete next.shooter;
  if (manual) next.operator = PAGE_ID;
  else delete next.operator;
  writeCrapsTableState(tableId, next);
}

/** While the dice are with the shooter: settle their throw when it lands in
 *  the doc, or have the stickman throw at the deadline. */
export function tickCrapsClosing(tableId: string, s: CrapsTableState, autoShowMs?: number, now = Date.now()): void {
  if (s.shooter !== undefined) {
    const t = readDiceThrow(tableId);
    if (t && t.round === s.round && t.by === s.shooter) {
      rollAndSettleCraps(tableId, s.round, s.point, autoShowMs);
      return;
    }
  }
  if (now >= (s.phaseDeadline ?? now)) stickmanThrows(tableId, s, autoShowMs);
}

/** This page, as a manual table's operator: player id plus a per-load nonce,
 *  so two tabs of one player are still two operators. */
const PAGE_ID = `${getPlayerId()}:${Math.random().toString(36).slice(2, 10)}`;

/** A manual craps table (no robot stickman): the page whose ROLL slid the
 *  dice out runs only that shooter's turn — watching the seats, settling the
 *  shooter's throw, timing them out. World ticks it every frame on every
 *  editor's client whatever they're looking at; only the operator page acts,
 *  so shareholders in a venture room never race the settle. If that page
 *  goes away, any editor's next ROLL press finishes the turn. */
export function tickManualCraps(tableId: string, now = Date.now()): void {
  // Every editor samples (throttled), so whoever presses ROLL has already
  // seen the seated players' heartbeats move and can slide them the dice.
  sampleSeats(tableId, now);
  const s = readCrapsTableState(tableId);
  if (s?.phase !== 'closing' || s.operator !== PAGE_ID) return;
  tickCrapsClosing(tableId, s, undefined, now);
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
  sampleSeats(tableId, now);
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
      closeCrapsBetting(tableId, s, now);
    }
  } else if (s.phase === 'closing') {
    tickCrapsClosing(tableId, s, CRAPS_SHOW_MS, now);
  } else if (s.phase === 'settled') {
    if (s.phaseDeadline != null && now >= s.phaseDeadline) {
      openCrapsBetting(tableId, s.round + 1, s.point, s);
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
    // sevenOut distinguishes a point-phase 7 (hand over) from a come-out 7
    // (natural — line WINS); the post-roll point is null for both.
    const tail = s.sevenOut ? ' — seven out, new shooter'
      : paid ? ' — winners paid!' : ' — house collects';
    return { key: `${s.round}:settle`, text: `🎲 ${a}+${b} = ${s.result}${tail}` };
  }
  return null;
}
