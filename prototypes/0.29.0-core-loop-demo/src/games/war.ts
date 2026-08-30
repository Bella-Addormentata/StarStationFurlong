/**
 * WAR (2-player) — the first card-felt game (#45).
 *
 * Pure functions over a plain-JSON WarState (no DOM, no THREE, no Yjs) — the
 * state is exactly what the room doc's `games` map stores, and every
 * transition is "read → pure compute → transacted write" (checkers.ts /
 * chess.ts discipline). WHITE-CARDS caveat baked in from games-plan.md: the
 * deck is public — that's fine for war (no hidden information matters).
 *
 * RULES (standard war, deterministic — this engine's authority):
 *  - Full 52-card deck, ACE HIGH (rank 14 > 13 > … > 2), suit ignored for
 *    rank comparison.
 *  - Two seats (LEFT, RIGHT). The deck is split evenly (26 each) using the
 *    state's `seed` — same seed on both peers ⇒ same initial deal.
 *  - Each ROUND: both players reveal the top card of their deck. The higher
 *    rank wins BOTH cards; winner appends [ownCard, opponentCard] to the
 *    BOTTOM of their deck in that order (a fixed, deterministic order — real
 *    war often shuffles, but a stable order is what makes the engine testable
 *    and identical across peers without an RNG per round).
 *  - TIE ⇒ WAR: each player places up to THREE face-down cards, then flips
 *    ONE more face-up. Higher face-up wins EVERYTHING on the field. A tie in
 *    the war triggers ANOTHER war (recursive).
 *  - Under-supply during a war: a player may only place as many face-down
 *    cards as they have (down to zero). If a player runs out of cards during
 *    a war (nothing left to face-up-reveal), the OTHER player wins the game.
 *  - No-shuffle rule + no-move detection: if BOTH players start a round with
 *    0 cards (impossible with the collect rule, but defensive) or a war
 *    resolves with one player at 0 cards, that player loses.
 *
 * DOC / RACE DISCIPLINE
 *   The engine is deterministic given the current state, so both seats can
 *   safely trigger `playRound` — two clients racing to advance the same
 *   round will write byte-identical successor states (Yjs LWW settles the
 *   collision). Only status transitions live in the state; no timer, no
 *   pending "revealed but not collected" step (the whole round resolves in
 *   one transacted write, with `lastRound` describing what happened for the
 *   UI). Simplicity keeps spectators and rejoins converging from the doc
 *   alone.
 */

import type { Card } from './cards';
import { createRng, isCard, isDeck, rankOf, shuffledDeck } from './cards';

// ── State ────────────────────────────────────────────────────────────────────

export type WarSeat = 'left' | 'right';
export type WarStatus = 'waiting' | 'playing' | 'left-won' | 'right-won';

export interface WarRound {
  /** Face-up cards each side revealed this round (1 in a quiet round; 1 per
   *  war phase in a war, so N+1 for N escalations). Order: oldest first. */
  leftUp: Card[];
  rightUp: Card[];
  /** Face-down cards each side burnt into the war (0 in a quiet round).
   *  Truncated when a side had fewer cards than the war called for. */
  leftDown: Card[];
  rightDown: Card[];
  /** Number of wars this round resolved (0 = quiet, 1 = one war, …). */
  warDepth: number;
  /** Round winner. null only for the sentinel initial round (never in play). */
  winner: WarSeat | null;
}

export interface WarState {
  kind: 'war';
  /** Seat claims — S2 player ids, first two claimants. */
  players: { left: string | null; right: string | null };
  status: WarStatus;
  /** Face-down draw piles: index 0 = TOP (drawn next). */
  leftDeck: Card[];
  rightDeck: Card[];
  /** Description of the most recently resolved round, or null before any. */
  lastRound: WarRound | null;
  /** Rounds resolved so far — UI decoration + optional stall detection. */
  roundsPlayed: number;
  /** Deterministic shuffle seed (locked at start; same on both peers). */
  seed: number;
  /** Single-player: RIGHT is a trivial bot pumped by the LEFT claimant. */
  bot: boolean;
}

// ── Construction ─────────────────────────────────────────────────────────────

/** A brand-new war table: no seats claimed, waiting-to-start. */
export function initialWarState(seed: number): WarState {
  return {
    kind: 'war',
    players: { left: null, right: null },
    status: 'waiting',
    leftDeck: [],
    rightDeck: [],
    lastRound: null,
    roundsPlayed: 0,
    seed: seed | 0 || 1, // 0 is a splitmix32 fixed point; caller-safe default
  bot: false,
  };
}

/** Fresh deal (both seats claimed, or one claimed + bot). 26 cards each. */
export function beginWar(state: WarState): WarState {
  const deck = shuffledDeck(state.seed);
  return {
    ...state,
    status: 'playing',
    leftDeck: deck.slice(0, 26),
    rightDeck: deck.slice(26),
    lastRound: null,
    roundsPlayed: 0,
  };
}

// ── Round engine ─────────────────────────────────────────────────────────────

/**
 * Advance the game by ONE round. Returns a new state — never mutates.
 * Pre-checked and idempotent-ish (calling on a finished game returns the
 * state unchanged). Callers that race the write are safe: two identical
 * successor states are byte-equal (LWW settles cheaply).
 */
export function playWarRound(state: WarState): WarState {
  if (state.status !== 'playing') return state;
  const left = state.leftDeck.slice();
  const right = state.rightDeck.slice();
  if (left.length === 0 || right.length === 0) {
    return endWar(state, left, right);
  }

  const leftUp: Card[] = [];
  const rightUp: Card[] = [];
  const leftDown: Card[] = [];
  const rightDown: Card[] = [];
  let warDepth = 0;

  // First reveal.
  leftUp.push(left.shift()!);
  rightUp.push(right.shift()!);

  // Resolve ties by escalating into war(s). Each war: place up to 3 face-down
  // then one face-up; higher face-up wins the whole field. If a side can't
  // reveal a face-up card at ANY point, the OTHER side wins the game — this
  // matches the standard "opponent wins if you can't continue" rule.
  while (rankOf(leftUp[leftUp.length - 1]) === rankOf(rightUp[rightUp.length - 1])) {
    warDepth += 1;
    // Face-down burn — up to 3 each, capped by available cards. The face-up
    // card the tie triggered on has already been drawn; each side reserves
    // one card for the NEXT face-up, so face-down burn caps at max(0, n-1).
    for (let k = 0; k < 3; k++) {
      if (left.length > 1) leftDown.push(left.shift()!);
      if (right.length > 1) rightDown.push(right.shift()!);
    }
    // Next reveal — if either side is empty here they lose the game (their
    // remaining played + burn cards are pooled with the opponent's on end).
    if (left.length === 0 || right.length === 0) {
      const round: WarRound = {
        leftUp, rightUp, leftDown, rightDown, warDepth,
        winner: left.length === 0 ? 'right' : 'left',
      };
      return finalize(state, left, right, round, 'gameover');
    }
    leftUp.push(left.shift()!);
    rightUp.push(right.shift()!);
  }

  const lastLeft = leftUp[leftUp.length - 1];
  const lastRight = rightUp[rightUp.length - 1];
  const winner: WarSeat = rankOf(lastLeft) > rankOf(lastRight) ? 'left' : 'right';

  // Collect: winner appends the entire field to the BOTTOM of their deck.
  // Fixed order (own played first, then opponent played, then own face-down,
  // then opponent face-down) — deterministic across peers, no per-round RNG.
  const field = winner === 'left'
    ? [...leftUp, ...rightUp, ...leftDown, ...rightDown]
    : [...rightUp, ...leftUp, ...rightDown, ...leftDown];
  if (winner === 'left') left.push(...field); else right.push(...field);

  const round: WarRound = { leftUp, rightUp, leftDown, rightDown, warDepth, winner };
  return finalize(state, left, right, round, 'continue');
}

/**
 * Assemble the new state after a round, decide game-over on empty piles.
 * mode='gameover' short-circuits on the war-under-supply branch.
 */
function finalize(
  state: WarState, left: Card[], right: Card[], round: WarRound, mode: 'continue' | 'gameover',
): WarState {
  const roundsPlayed = state.roundsPlayed + 1;
  if (mode === 'gameover') {
    // The winner already carries the field via `round.winner`. Force decks
    // to reflect the loss (loser drained; winner keeps their remaining pile
    // and — as if collected — the entire on-field ⇢ deck append).
    const survivor = round.winner === 'left' ? left : right;
    const field = [...round.leftUp, ...round.rightUp, ...round.leftDown, ...round.rightDown];
    if (round.winner === 'left') {
      return {
        ...state,
        leftDeck: [...survivor, ...field], rightDeck: [],
        lastRound: round, roundsPlayed,
        status: 'left-won',
      };
    }
    return {
      ...state,
      leftDeck: [], rightDeck: [...survivor, ...field],
      lastRound: round, roundsPlayed,
      status: 'right-won',
    };
  }
  // Normal end: whoever hit zero after collect loses.
  const status: WarStatus = left.length === 0
    ? 'right-won'
    : right.length === 0
      ? 'left-won'
      : 'playing';
  return { ...state, leftDeck: left, rightDeck: right, lastRound: round, roundsPlayed, status };
}

/** Zero-card check (defensive — not normally reachable in playing state). */
function endWar(state: WarState, left: Card[], right: Card[]): WarState {
  if (left.length === 0 && right.length === 0) {
    // A pathological tie both empty — treat as an immediate right-won
    // (deterministic and documented). Not reachable from beginWar (26/26).
    return { ...state, status: 'right-won', leftDeck: [], rightDeck: [] };
  }
  return {
    ...state,
    status: left.length === 0 ? 'right-won' : 'left-won',
    leftDeck: left, rightDeck: right,
  };
}

// ── Trivial single-player bot (mirrors checkers'/chess' capture-random) ──────

/**
 * The bot never picks — a war round is symmetric — but callers want a
 * uniform hook (checkers has chooseBotMove; chess has chooseChessBotMove).
 * Returns whether the bot would advance the round given the state. The LEFT
 * claimant's client actually writes; this just gates the "is there anything
 * to do?" question.
 */
export function shouldBotPlayWar(state: WarState): boolean {
  return state.bot && state.status === 'playing'
    && state.leftDeck.length > 0 && state.rightDeck.length > 0;
}

/**
 * Unused-but-parity RNG hook — some future war-with-shuffle-on-collect rule
 * variant could use it. Kept so tests can prove RNG creation is stable.
 */
export function warRng(state: WarState): ReturnType<typeof createRng> {
  return createRng(state.seed);
}

// ── Shape guard (peers write the doc; malformed reads render as no game) ─────

export function isWarState(value: unknown): value is WarState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<WarState>;
  if (s.kind !== 'war') return false;
  const playerOk = (p: unknown) => p === null || typeof p === 'string';
  const roundOk = (r: unknown): r is WarRound => {
    if (typeof r !== 'object' || r === null) return false;
    const x = r as Partial<WarRound>;
    return isDeck(x.leftUp) && isDeck(x.rightUp)
      && isDeck(x.leftDown) && isDeck(x.rightDown)
      && Number.isInteger(x.warDepth) && (x.warDepth as number) >= 0
      && (x.winner === null || x.winner === 'left' || x.winner === 'right');
  };
  return typeof s.players === 'object' && s.players !== null
    && playerOk(s.players.left) && playerOk(s.players.right)
    && ['waiting', 'playing', 'left-won', 'right-won'].includes(s.status as string)
    && isDeck(s.leftDeck) && isDeck(s.rightDeck)
    && (s.lastRound === null || roundOk(s.lastRound))
    && Number.isInteger(s.roundsPlayed) && (s.roundsPlayed as number) >= 0
    && Number.isInteger(s.seed)
    && typeof s.bot === 'boolean'
    // Belt-and-braces: card ints are already checked by isDeck, but a stray
    // decimal in leftUp/rightDown would collapse the whole notify loop.
    && ((s.lastRound === null)
      || (s.lastRound.leftUp.every(isCard) && s.lastRound.rightUp.every(isCard)
        && s.lastRound.leftDown.every(isCard) && s.lastRound.rightDown.every(isCard)));
}
