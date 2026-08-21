/**
 * HEADS-UP NO-LIMIT TEXAS HOLD'EM (2-player) — the third card-felt game (#45).
 *
 * Pure functional engine over plain-JSON PokerState (checkers.ts / chess.ts
 * discipline). The state lives in the room doc so seat rejoins are safe; two
 * peers computing the same successor state from the same (state,action) pair
 * write byte-identical values and LWW settles the race.
 *
 * VARIANT CHOICE — HEADS-UP NO-LIMIT TEXAS HOLD'EM
 *   The issue said "if we can't do a chip / chia integrated poker cleanly,
 *   a clean standard heads-up variant with betting is acceptable". Heads-up
 *   NL Hold'em is the canonical "clean standard" for two players and matches
 *   the industry-standard hand ranking and blind rotation. Chip integration
 *   is out of scope for this slice (games-plan.md phase 5, gated on B-7).
 *
 * WHITE-CARDS CAVEAT (games-plan.md phase 4)
 *   The room doc is public: v1 poker hole cards ARE visible to spectators
 *   inspecting the doc. The UI shows a banner and this is documented on the
 *   felt — full private hands need the commit-reveal / chia-gaming pass.
 *   The engine still hides `holeCards` in `readVisiblePokerState` for the UI
 *   when the caller isn't the seat holder, so casual spectators don't see
 *   them by default even though a determined peer could read the raw doc.
 *
 * RULES (standard heads-up NL Hold'em):
 *   - Two seats: 'button' (BTN/SB) and 'bigBlind' (BB).
 *   - Button posts small blind, other player posts big blind (defaults 5/10).
 *   - PREFLOP: BUTTON acts first (heads-up special).
 *   - POSTFLOP: BIG BLIND acts first (heads-up special).
 *   - Streets: preflop, flop (3 community), turn (4th), river (5th).
 *   - Actions: fold, check, call, bet, raise. NO-LIMIT: any bet ≥ big blind,
 *     any raise ≥ (previous raise) with legal minimum. All-in when a player
 *     has < the required call.
 *   - Showdown: best 5-card hand from each player's 2 hole + 5 community.
 *   - Pot to the winner (or split for identical rank tiebreak; heads-up ties
 *     are rare but real — two-pair on the board etc.).
 *   - Between hands the button rotates and blinds re-post from stacks.
 */

import type { Card } from './cards';
import {
  isCard, isDeck, rankOf, shuffledDeck, suitOf,
} from './cards';

// ── State ────────────────────────────────────────────────────────────────────

export type PokerSeat = 'button' | 'bigBlind';
export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
export type PokerStatus = 'waiting' | 'playing' | 'hand-over' | 'match-over';
export type PokerActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface PokerPlayer {
  /** S2 player id (null before claim). */
  id: string | null;
  /** Remaining chip stack (behind the felt). */
  stack: number;
  /** Chips committed on this street (reset when a street closes). */
  streetBet: number;
  /** Total chips committed this hand (all streets). */
  handBet: number;
  /** Hole cards (2). Read via `readVisiblePokerState` — omitted for the
   *  opposing seat in the UI. Written to the doc raw for engine determinism. */
  holeCards: [Card, Card] | null;
  /** True after the player folded on the current hand. */
  folded: boolean;
  /** True after the player pushed all their chips in this hand. */
  allIn: boolean;
}

/** One entry per action taken this hand — the UI can render a chat-log tape. */
export interface PokerAction {
  seat: PokerSeat;
  kind: PokerActionKind;
  amount: number;
  /** Street at which the action was taken. */
  street: PokerStreet;
}

export interface PokerState {
  kind: 'poker';
  players: { button: PokerPlayer; bigBlind: PokerPlayer };
  status: PokerStatus;
  street: PokerStreet;
  /** The 5 community cards, filled as streets open (0/3/4/5). */
  community: Card[];
  /** Seat whose turn it is to act (null when hand-over/waiting). */
  toAct: PokerSeat | null;
  /** Number of chips a player must have on this street to call. */
  currentBet: number;
  /** Minimum legal raise INCREMENT on this street (init = big blind). */
  minRaise: number;
  /** Pot main total (side pots not modelled — heads-up, so all-in ≡ main). */
  pot: number;
  /** Deck for the current hand (index 0 = TOP; drawn by the engine). */
  deck: Card[];
  /** Actions taken this hand (chronological). */
  actions: PokerAction[];
  /** Configured blinds. Immutable per match. */
  smallBlind: number;
  bigBlind: number;
  /** Deterministic seed for THIS hand's shuffle. Rotated per hand. */
  seed: number;
  /** Hands played (finished). Used to rotate the button. */
  handsPlayed: number;
  /** Last hand's showdown summary (null before any showdown). */
  lastShowdown: PokerShowdown | null;
  /** RIGHT-seat bot (played when heads-up alone at the table). */
  bot: boolean;
}

export interface PokerShowdown {
  buttonHand: PokerHand | null;      // null when folded
  bigBlindHand: PokerHand | null;    // null when folded
  winner: PokerSeat | 'split';
  pot: number;
}

// ── Actions descriptor ───────────────────────────────────────────────────────

export type PokerActionInput =
  | { seat: PokerSeat; kind: 'fold' }
  | { seat: PokerSeat; kind: 'check' }
  | { seat: PokerSeat; kind: 'call' }
  | { seat: PokerSeat; kind: 'bet'; amount: number }
  | { seat: PokerSeat; kind: 'raise'; amount: number };

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Fresh-table poker state — both seats empty, waiting for claims. Startup
 * blinds default to 5/10 with 1000-chip starting stacks (the match-config
 * knobs are `smallBlind`, `bigBlind`, `startingStack` from beginPoker).
 */
export function initialPokerState(seed: number): PokerState {
  return {
    kind: 'poker',
    players: {
      button: makePlayer(),
      bigBlind: makePlayer(),
    },
    status: 'waiting',
    street: 'preflop',
    community: [],
    toAct: null,
    currentBet: 0,
    minRaise: 0,
    pot: 0,
    deck: [],
    actions: [],
    smallBlind: 5,
    bigBlind: 10,
    seed: seed | 0 || 1,
    handsPlayed: 0,
    lastShowdown: null,
    bot: false,
  };
}

function makePlayer(): PokerPlayer {
  return {
    id: null,
    stack: 0,
    streetBet: 0,
    handBet: 0,
    holeCards: null,
    folded: false,
    allIn: false,
  };
}

/**
 * Begin match — populate starting stacks, then deal hand #1. The two seat
 * ids are optional; a seat with a null id is a BOT (mirrors checkers/chess).
 */
export function beginPoker(
  state: PokerState,
  opts: { button: string | null; bigBlind: string | null; startingStack?: number; bot?: boolean },
): PokerState {
  const startingStack = Math.max(2 * state.bigBlind, opts.startingStack ?? 1000);
  return dealHand({
    ...state,
    players: {
      button: { ...makePlayer(), id: opts.button, stack: startingStack },
      bigBlind: { ...makePlayer(), id: opts.bigBlind, stack: startingStack },
    },
    status: 'playing',
    handsPlayed: 0,
    bot: opts.bot ?? state.bot,
  });
}

/**
 * Deal a fresh hand from the current stacks. Rotates the button on hands
 * after the first. Uses the current `seed`; caller rotates it externally so
 * successive hands are reproducible.
 */
export function dealHand(state: PokerState): PokerState {
  if (state.players.button.stack <= 0 || state.players.bigBlind.stack <= 0) {
    return { ...state, status: 'match-over', toAct: null };
  }
  // Rotate button on hand ≥ 2.
  const rotate = state.handsPlayed > 0;
  const buttonPlayer = rotate ? state.players.bigBlind : state.players.button;
  const bigBlindPlayer = rotate ? state.players.button : state.players.bigBlind;
  const buttonId = buttonPlayer.id;
  const bigBlindId = bigBlindPlayer.id;
  // Reset per-hand fields, shuffle a fresh deck, deal 2 to each.
  const deck = shuffledDeck(state.seed);
  const button: PokerPlayer = {
    id: buttonId,
    stack: buttonPlayer.stack,
    streetBet: 0,
    handBet: 0,
    holeCards: [deck[0], deck[2]],
    folded: false,
    allIn: false,
  };
  const bigBlind: PokerPlayer = {
    id: bigBlindId,
    stack: bigBlindPlayer.stack,
    streetBet: 0,
    handBet: 0,
    holeCards: [deck[1], deck[3]],
    folded: false,
    allIn: false,
  };
  const afterDeal = deck.slice(4);

  // Post blinds (BTN posts SB, BB posts BB in heads-up).
  const sb = Math.min(state.smallBlind, button.stack);
  const bb = Math.min(state.bigBlind, bigBlind.stack);
  button.stack -= sb;
  button.streetBet = sb;
  button.handBet = sb;
  if (button.stack === 0) button.allIn = true;
  bigBlind.stack -= bb;
  bigBlind.streetBet = bb;
  bigBlind.handBet = bb;
  if (bigBlind.stack === 0) bigBlind.allIn = true;

  // Post-blind current-bet normalization.
  //   The canonical case sets `currentBet = bb` (BB posted the higher blind).
  //   But when the BB seat's stack is smaller than the small blind (natural
  //   chip-bleed across many hands), `bb = min(BB, stack) < sb`, so the
  //   SB-poster's streetBet exceeds the standing bet — using bare `bb` here
  //   would leave callAmount computations underwater. Use the max of both
  //   posted amounts to keep `currentBet` = highest street bet, which is
  //   how every downstream rule (callAmount, legalActions, minRaiseTo)
  //   interprets it.
  const initialCurrentBet = Math.max(sb, bb);

  // toAct selection when a poster went all-in from the blinds.
  //   Default heads-up rule: BUTTON acts first preflop.
  //   Corner cases (audit finding #2 — natural chip-bleed produces stacks
  //   ≤ blinds; before this fix the engine set `toAct: 'button'`
  //   unconditionally, then applyPokerAction's `if (p.allIn) return state`
  //   guard rejected every action the all-in poster attempted, and no seat
  //   could ever move the doc — RESET was the only recovery):
  //     · button all-in from SB + BB has chips → toAct = 'bigBlind' (they
  //       still hold the fold-or-continue decision; a check on their turn
  //       cascades through the streets via advanceAfterAction's
  //       opponent-can-act check).
  //     · BB all-in from BB + button has chips → toAct = 'button' (they
  //       still hold the fold-or-continue decision).
  //     · Both all-in from blinds → toAct = null and run the streets to
  //       showdown immediately (same recursion openNextStreet uses for the
  //       both-in-during-play path).
  const buttonAllInFromPost = button.allIn;
  const bigBlindAllInFromPost = bigBlind.allIn;
  let toAct: PokerSeat | null;
  if (buttonAllInFromPost && bigBlindAllInFromPost) toAct = null;
  else if (buttonAllInFromPost) toAct = 'bigBlind';
  else toAct = 'button'; // default (also correct when only BB is all-in)

  const dealt: PokerState = {
    ...state,
    players: { button, bigBlind },
    status: 'playing',
    street: 'preflop',
    community: [],
    toAct,
    currentBet: initialCurrentBet,
    minRaise: state.bigBlind,
    pot: sb + bb,
    deck: afterDeal,
    actions: [],
  };

  // Both posted all-in → no action possible; run community out to showdown.
  if (buttonAllInFromPost && bigBlindAllInFromPost) return openNextStreet(dealt);
  return dealt;
}

// ── Legal action helpers ─────────────────────────────────────────────────────

/** Chips the given seat must add to call (0 if already matched). */
export function callAmount(state: PokerState, seat: PokerSeat): number {
  const p = state.players[seat];
  return Math.max(0, Math.min(p.stack, state.currentBet - p.streetBet));
}

/** Minimum legal bet size when opening a street (no bet yet). */
export function minBet(state: PokerState): number {
  return state.bigBlind;
}

/** Minimum legal raise TOTAL bet size (as street bet). Below opponent all-in
 *  the min-raise increment can be zero — you can still call, but not raise
 *  under NL rules (simplified: we treat any legal raise as ≥ currentBet + minRaise
 *  unless it's an all-in raise). */
export function minRaiseTo(state: PokerState, seat: PokerSeat): number {
  const p = state.players[seat];
  const maxBet = p.stack + p.streetBet;
  const target = state.currentBet + state.minRaise;
  return Math.min(target, maxBet);
}

/** True when the given seat may legally act at all right now. */
export function canAct(state: PokerState, seat: PokerSeat): boolean {
  return state.status === 'playing' && state.toAct === seat;
}

export function legalActions(state: PokerState, seat: PokerSeat): PokerActionKind[] {
  if (!canAct(state, seat)) return [];
  const acts: PokerActionKind[] = [];
  const p = state.players[seat];
  const toCall = callAmount(state, seat);
  acts.push('fold');
  if (toCall === 0) {
    acts.push('check');
  } else {
    acts.push('call');
  }
  if (!p.allIn) {
    if (state.currentBet === 0) acts.push('bet');
    else acts.push('raise');
  }
  return acts;
}

// ── State transitions ────────────────────────────────────────────────────────

/**
 * Apply an action. Returns a new state on success, or the same state
 * unchanged if the action is illegal for `seat`. Never mutates inputs.
 */
export function applyPokerAction(state: PokerState, action: PokerActionInput): PokerState {
  if (state.status !== 'playing') return state;
  if (state.toAct !== action.seat) return state;
  const seat = action.seat;
  const other = otherSeat(seat);
  const p = state.players[seat];
  if (p.folded || p.allIn) return state; // engine invariant: they shouldn't be to-act

  switch (action.kind) {
    case 'fold': {
      const players = clonePlayers(state.players);
      players[seat].folded = true;
      const s: PokerState = { ...state, players };
      const recorded = logAction(s, { seat, kind: 'fold', amount: 0, street: state.street });
      return awardUncontested(recorded, other);
    }
    case 'check': {
      if (callAmount(state, seat) !== 0) return state; // illegal
      const recorded = logAction(state, { seat, kind: 'check', amount: 0, street: state.street });
      return advanceAfterAction(recorded, seat, /*aggressor*/ null);
    }
    case 'call': {
      const toCall = callAmount(state, seat);
      if (toCall === 0) return state; // must check instead
      const players = clonePlayers(state.players);
      players[seat].stack -= toCall;
      players[seat].streetBet += toCall;
      players[seat].handBet += toCall;
      if (players[seat].stack === 0) players[seat].allIn = true;
      const s: PokerState = { ...state, players, pot: state.pot + toCall };
      const recorded = logAction(s, { seat, kind: 'call', amount: toCall, street: state.street });
      return advanceAfterAction(recorded, seat, /*aggressor*/ null);
    }
    case 'bet': {
      if (state.currentBet !== 0) return state; // must raise instead
      const amount = Math.floor(action.amount);
      if (!Number.isFinite(amount) || amount <= 0) return state;
      if (amount < minBet(state) && amount < p.stack) return state; // sub-min not all-in
      if (amount > p.stack) return state;
      const players = clonePlayers(state.players);
      players[seat].stack -= amount;
      players[seat].streetBet += amount;
      players[seat].handBet += amount;
      if (players[seat].stack === 0) players[seat].allIn = true;
      const s: PokerState = {
        ...state, players,
        pot: state.pot + amount,
        currentBet: amount,
        minRaise: amount,
      };
      const recorded = logAction(s, { seat, kind: 'bet', amount, street: state.street });
      return advanceAfterAction(recorded, seat, seat);
    }
    case 'raise': {
      if (state.currentBet === 0) return state; // must bet instead
      // amount is the TOTAL new street bet size (not the delta).
      const amount = Math.floor(action.amount);
      if (!Number.isFinite(amount) || amount <= p.streetBet) return state;
      const maxTarget = p.stack + p.streetBet;
      if (amount > maxTarget) return state;
      const legalTarget = state.currentBet + state.minRaise;
      const isAllIn = amount === maxTarget;
      if (amount < legalTarget && !isAllIn) return state;
      const raiseInc = amount - state.currentBet;
      const delta = amount - p.streetBet;
      const players = clonePlayers(state.players);
      players[seat].stack -= delta;
      players[seat].streetBet = amount;
      players[seat].handBet += delta;
      if (players[seat].stack === 0) players[seat].allIn = true;
      const s: PokerState = {
        ...state, players,
        pot: state.pot + delta,
        currentBet: amount,
        // Only bump minRaise if the raise was ≥ the previous min-raise
        // (a short all-in doesn't reopen action for the opponent — but for
        // heads-up two-seat simplicity we still let the opponent respond).
        minRaise: raiseInc >= state.minRaise ? raiseInc : state.minRaise,
      };
      const recorded = logAction(s, { seat, kind: 'raise', amount, street: state.street });
      return advanceAfterAction(recorded, seat, seat);
    }
    default: {
      const never: never = action;
      void never;
      return state;
    }
  }
}

function logAction(state: PokerState, entry: PokerAction): PokerState {
  return { ...state, actions: [...state.actions, entry] };
}

function clonePlayers(p: PokerState['players']): PokerState['players'] {
  return { button: { ...p.button }, bigBlind: { ...p.bigBlind } };
}

/**
 * Called after any non-fold action. Decides whether the street closes,
 * whether we run to showdown (both all-in), or whether it's the opponent's
 * turn to act.
 */
function advanceAfterAction(
  state: PokerState, actor: PokerSeat, _aggressor: PokerSeat | null,
): PokerState {
  // Street closes when both players have equal streetBet AND (a) both have
  // acted since the last aggressor OR (b) one is all-in and other matched.
  const button = state.players.button;
  const bigBlind = state.players.bigBlind;
  const matched = button.streetBet === bigBlind.streetBet;
  // Because heads-up has only two players, once the pot is matched AND the
  // opponent has had a chance to respond to any raise, the street closes.
  // The simple rule that works heads-up: the street closes when both players
  // have contributed to `actions` on this street AND their streetBets match.
  const streetActions = state.actions.filter((a) => a.street === state.street);
  const buttonActed = streetActions.some((a) => a.seat === 'button');
  const bigBlindActed = streetActions.some((a) => a.seat === 'bigBlind');
  const bothActed = buttonActed && bigBlindActed;
  // Preflop special: the big blind gets an option to raise even after the
  // button just calls (limps) — the street doesn't close on button-limp.
  const preflopLimp = state.street === 'preflop'
    && bothActed
    && matched
    && streetActions.filter((a) => a.seat === 'bigBlind').every((a) => a.kind === 'check');

  // Opponent-can-act gate (audit finding #2 hardening).
  //   If the opponent (the seat opposite the actor) can no longer legally
  //   act — because they're already all-in (posted blinds fully or shoved
  //   earlier) or folded — then passing them the action would just re-hit
  //   applyPokerAction's `if (p.allIn || p.folded) return state` guard and
  //   the doc would freeze at this state (no seat can move it, RESET only).
  //   In that case we close the street unconditionally: openNextStreet
  //   deals the next community and, when the all-in survivor still has no
  //   opponent capable of a call/raise, recurses through to showdown so
  //   the pot resolves cleanly. Refunds of an over-committed bet are not
  //   modelled here (heads-up no-side-pot demo scope; see the same
  //   simplification called out in the interface comment on `pot`).
  const opponent = state.players[otherSeat(actor)];
  const opponentCanAct = !opponent.allIn && !opponent.folded;

  // Continue-in-street condition (pass to other seat):
  //  - amounts not matched (opponent still needs to call/raise/fold),
  //  - or bothActed=false (someone hasn't spoken yet — e.g. button raise preflop
  //    means big blind hasn't acted yet since the raise),
  //  - or preflop limp waiting for BB option.
  //  AND opponent must still be able to act (else close the street).
  const streetOpen = opponentCanAct
    && (!matched || !bothActed || (preflopLimp && !hasBigBlindOption(state)));

  if (streetOpen) {
    return { ...state, toAct: otherSeat(actor) };
  }

  // Street closed — either open next street or go to showdown when all-in.
  return openNextStreet(state);
}

/** True when a preflop street already contained a BB raise/check-through
 *  action — meaning the BB already took the option. */
function hasBigBlindOption(state: PokerState): boolean {
  // If the BB has any action THIS street that isn't a blind post (blinds aren't
  // in the action log), they've taken their option.
  return state.actions.some((a) => a.street === 'preflop' && a.seat === 'bigBlind');
}

/** Advance to the next street (deal community cards) or showdown. */
function openNextStreet(state: PokerState): PokerState {
  // Reset street bets, but the pot already carries them (we accumulated
  // into pot as we went). We keep handBet as-is.
  const players = clonePlayers(state.players);
  players.button.streetBet = 0;
  players.bigBlind.streetBet = 0;

  const nextStreet: PokerStreet = nextStreetOf(state.street);
  if (nextStreet === 'showdown') {
    return showdown({ ...state, players, street: 'showdown', toAct: null });
  }

  // Deal community cards for the newly opened street.
  const [community, deck] = dealCommunity(state.deck, state.community, nextStreet);

  // Auto-run condition: if either player is all-in, no voluntary action can
  // change the outcome any more (the all-in seat can't call further, and the
  // other seat has no one to bet into — heads-up has no side pots by design;
  // see the interface comment on `pot`). Recurse through remaining streets
  // to showdown so the pot resolves in one write. Previously this recursed
  // only when BOTH were all-in — the audit's finding #2 hardening extends it
  // to the one-all-in case so the doc doesn't sit on a "playing" state where
  // the non-all-in seat's only sensible action is a series of checks.
  //
  // A folded player short-circuits earlier via `awardUncontested`, so
  // openNextStreet is never entered with a folded seat — the check on
  // `allIn` alone is sufficient here.
  const oneOrBothAllIn = players.button.allIn || players.bigBlind.allIn;

  const nextState: PokerState = {
    ...state,
    players,
    street: nextStreet,
    community,
    deck,
    currentBet: 0,
    minRaise: state.bigBlind,
    toAct: oneOrBothAllIn ? null : 'bigBlind', // heads-up: BB acts first postflop
  };
  if (oneOrBothAllIn) return openNextStreet(nextState); // recurse to showdown
  return nextState;
}

function nextStreetOf(s: PokerStreet): PokerStreet {
  if (s === 'preflop') return 'flop';
  if (s === 'flop') return 'turn';
  if (s === 'turn') return 'river';
  return 'showdown';
}

function dealCommunity(
  deck: Card[], community: Card[], next: PokerStreet,
): [Card[], Card[]] {
  const d = deck.slice();
  const c = community.slice();
  const burn = (): void => { if (d.length > 0) d.shift(); };
  if (next === 'flop') {
    burn();
    c.push(d.shift()!, d.shift()!, d.shift()!);
  } else if (next === 'turn') {
    burn();
    c.push(d.shift()!);
  } else if (next === 'river') {
    burn();
    c.push(d.shift()!);
  }
  return [c, d];
}

/** Uncontested (opponent folded) — award the pot to the survivor. */
function awardUncontested(state: PokerState, winner: PokerSeat): PokerState {
  const players = clonePlayers(state.players);
  players[winner].stack += state.pot;
  const lastShowdown: PokerShowdown = {
    buttonHand: null,
    bigBlindHand: null,
    winner,
    pot: state.pot,
  };
  return endHand({ ...state, players, pot: 0, toAct: null, lastShowdown });
}

/** Run showdown: evaluate both hands, split or award pot, record summary. */
function showdown(state: PokerState): PokerState {
  const b = state.players.button;
  const bb = state.players.bigBlind;
  const buttonHand = b.holeCards ? evaluate7([...b.holeCards, ...state.community]) : null;
  const bigBlindHand = bb.holeCards ? evaluate7([...bb.holeCards, ...state.community]) : null;
  let winner: PokerSeat | 'split' = 'split';
  if (b.folded || !buttonHand) winner = 'bigBlind';
  else if (bb.folded || !bigBlindHand) winner = 'button';
  else {
    const cmp = compareHands(buttonHand, bigBlindHand);
    if (cmp > 0) winner = 'button';
    else if (cmp < 0) winner = 'bigBlind';
    else winner = 'split';
  }
  const players = clonePlayers(state.players);
  if (winner === 'split') {
    const half = Math.floor(state.pot / 2);
    const remainder = state.pot - 2 * half;
    players.button.stack += half;
    players.bigBlind.stack += half;
    // Remainder chip goes to the button (deterministic).
    if (remainder > 0) players.button.stack += remainder;
  } else {
    players[winner].stack += state.pot;
  }
  const lastShowdown: PokerShowdown = {
    buttonHand, bigBlindHand, winner, pot: state.pot,
  };
  return endHand({ ...state, players, pot: 0, toAct: null, lastShowdown });
}

/** After a hand: mark hand-over; rotate handsPlayed; leave `dealHand()` to
 *  the caller who can choose to rotate the seed for the next hand. */
function endHand(state: PokerState): PokerState {
  const handsPlayed = state.handsPlayed + 1;
  const zero = state.players.button.stack === 0 || state.players.bigBlind.stack === 0;
  return {
    ...state,
    status: zero ? 'match-over' : 'hand-over',
    street: 'complete',
    handsPlayed,
  };
}

/** Roll to the next hand — advance seed and re-deal. Caller passes a NEW
 *  seed (bump `state.seed` locally, or thread a fresh randomSeed()). */
export function nextHand(state: PokerState, seed: number): PokerState {
  if (state.status !== 'hand-over') return state;
  return dealHand({ ...state, seed: seed | 0 || (state.seed + 1) | 0 });
}

/**
 * Rage-quit escape hatch — the seated player at `forfeiter` concedes the
 * whole match to their opponent. Standard-poker semantics for a mid-hand
 * concession:
 *   1. Any live pot is awarded to the opponent (as if the forfeiter folded
 *      first). Without this step the pot's chips would sit orphaned in the
 *      terminal state — the old `pokerForfeit` in devices.ts only transferred
 *      the residual STACK to the opponent and left `state.pot` untouched, so
 *      SB+BB (≥15) at forfeit time silently disappeared from the accounting
 *      (audit finding #3).
 *   2. The forfeiter's residual stack transfers to the opponent (they cannot
 *      cash it out — they've quit the match).
 *   3. `status = 'match-over'`, `street = 'complete'`, `toAct = null`, and
 *      `lastShowdown` records the concession as a fold-off (so the recap
 *      shows the opponent taking the pot).
 * Idempotent when `status !== 'playing'`: returns the input untouched (so
 * two concurrent doc writers converge on the same terminal state via LWW
 * instead of double-crediting stacks).
 */
export function pokerForfeit(state: PokerState, forfeiter: PokerSeat): PokerState {
  if (state.status !== 'playing') return state;
  const winner = otherSeat(forfeiter);
  const players = clonePlayers(state.players);
  const conceded = state.pot;
  const residual = players[forfeiter].stack;
  // Award the pot first (fold-equivalent), then transfer the residual stack.
  players[winner].stack += conceded;
  players[winner].stack += residual;
  players[forfeiter].stack = 0;
  const lastShowdown: PokerShowdown = {
    buttonHand: null,
    bigBlindHand: null,
    winner,
    pot: conceded,
  };
  return {
    ...state,
    players,
    pot: 0,
    status: 'match-over',
    street: 'complete',
    toAct: null,
    lastShowdown,
  };
}

export function otherSeat(s: PokerSeat): PokerSeat {
  return s === 'button' ? 'bigBlind' : 'button';
}

// ── Hand evaluation (7-card best-5) ──────────────────────────────────────────

export type HandCategory =
  | 'high-card' | 'pair' | 'two-pair' | 'three-of-a-kind'
  | 'straight' | 'flush' | 'full-house' | 'four-of-a-kind'
  | 'straight-flush';

export interface PokerHand {
  category: HandCategory;
  /** Ordinal for ranking (0 = high-card … 8 = straight-flush). */
  categoryRank: number;
  /** Tiebreak vector (highest-first). Comparing lexicographically settles ties. */
  tiebreak: number[];
  /** The 5 cards making the best hand — deterministic order (see evaluate7). */
  best5: Card[];
}

/** Evaluate the best 5-card hand out of exactly 7 cards. */
export function evaluate7(cards: Card[]): PokerHand {
  if (cards.length !== 7) {
    throw new RangeError(`evaluate7 requires 7 cards, got ${cards.length}`);
  }
  return bestOfN(cards);
}

/**
 * Best 5-card hand from any 5..7 real cards — the correct primitive for
 * postflop hand strength when the community isn't full yet (holeStrength on
 * the flop/turn). Never pad the input: duplicating a card lets evaluate5 see
 * impossible sets (three copies of one card → false trips/full-house/quads)
 * and inflates the score above its true value. See padCards removal (bot
 * heuristic used to feed evaluate7 with duplicates of community[0], flipping
 * high-card holdings into ranged-trip category on flop boards containing any
 * high card — that regression is asserted in poker.test.ts).
 */
export function evaluateBest(cards: Card[]): PokerHand {
  if (cards.length < 5 || cards.length > 7) {
    throw new RangeError(`evaluateBest requires 5..7 cards, got ${cards.length}`);
  }
  return bestOfN(cards);
}

/**
 * Shared C(n,5) best-hand enumerator (n ∈ 5..7). Uses the standard next-
 * lexicographic-combination increment: at n=5 the loop runs once, at n=6 six
 * times, at n=7 twenty-one times.
 */
function bestOfN(cards: Card[]): PokerHand {
  const n = cards.length;
  let best: PokerHand | null = null;
  const idx = [0, 1, 2, 3, 4];
  while (true) {
    const combo = [cards[idx[0]], cards[idx[1]], cards[idx[2]], cards[idx[3]], cards[idx[4]]];
    const h = evaluate5(combo);
    if (best === null || compareHands(h, best) > 0) best = h;
    // Advance combination indices lexicographically.
    let i = 4;
    while (i >= 0 && idx[i] === n - 5 + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < 5; j++) idx[j] = idx[j - 1] + 1;
  }
  return best!;
}

/** Compare two hands: >0 = a stronger, <0 = b stronger, 0 = tie. */
export function compareHands(a: PokerHand, b: PokerHand): number {
  if (a.categoryRank !== b.categoryRank) return a.categoryRank - b.categoryRank;
  for (let i = 0; i < Math.min(a.tiebreak.length, b.tiebreak.length); i++) {
    if (a.tiebreak[i] !== b.tiebreak[i]) return a.tiebreak[i] - b.tiebreak[i];
  }
  return 0;
}

/**
 * Evaluate a 5-card hand. Deterministic tiebreak vector: category-specific
 * (e.g. pair rank first, then kickers descending) — see comments per branch.
 */
export function evaluate5(cards: Card[]): PokerHand {
  if (cards.length !== 5) {
    throw new RangeError(`evaluate5 requires 5 cards, got ${cards.length}`);
  }
  const ranks = cards.map(rankOf).slice().sort((a, b) => b - a); // desc
  const suits = cards.map(suitOf);
  const rankCounts = countRanks(ranks);
  const isFlush = suits.every((s) => s === suits[0]);
  const straightHigh = detectStraight(ranks);
  // Category detection.
  if (isFlush && straightHigh !== 0) {
    return {
      category: 'straight-flush',
      categoryRank: 8,
      tiebreak: [straightHigh],
      best5: cards.slice(),
    };
  }
  // Four-of-a-kind.
  const four = rankCounts.find((rc) => rc.count === 4);
  if (four) {
    const kicker = rankCounts.find((rc) => rc.count === 1)!.rank;
    return {
      category: 'four-of-a-kind',
      categoryRank: 7,
      tiebreak: [four.rank, kicker],
      best5: cards.slice(),
    };
  }
  // Full house.
  const three = rankCounts.find((rc) => rc.count === 3);
  const pair = rankCounts.find((rc) => rc.count === 2);
  if (three && pair) {
    return {
      category: 'full-house',
      categoryRank: 6,
      tiebreak: [three.rank, pair.rank],
      best5: cards.slice(),
    };
  }
  // Flush.
  if (isFlush) {
    return {
      category: 'flush',
      categoryRank: 5,
      tiebreak: ranks.slice(),
      best5: cards.slice(),
    };
  }
  // Straight.
  if (straightHigh !== 0) {
    return {
      category: 'straight',
      categoryRank: 4,
      tiebreak: [straightHigh],
      best5: cards.slice(),
    };
  }
  // Three-of-a-kind.
  if (three) {
    const kickers = rankCounts.filter((rc) => rc.count === 1).map((rc) => rc.rank).sort((a, b) => b - a);
    return {
      category: 'three-of-a-kind',
      categoryRank: 3,
      tiebreak: [three.rank, ...kickers],
      best5: cards.slice(),
    };
  }
  // Two pair.
  const pairs = rankCounts.filter((rc) => rc.count === 2).map((rc) => rc.rank).sort((a, b) => b - a);
  if (pairs.length >= 2) {
    const kicker = rankCounts.find((rc) => rc.count === 1)!.rank;
    return {
      category: 'two-pair',
      categoryRank: 2,
      tiebreak: [pairs[0], pairs[1], kicker],
      best5: cards.slice(),
    };
  }
  // One pair.
  if (pair) {
    const kickers = rankCounts.filter((rc) => rc.count === 1).map((rc) => rc.rank).sort((a, b) => b - a);
    return {
      category: 'pair',
      categoryRank: 1,
      tiebreak: [pair.rank, ...kickers],
      best5: cards.slice(),
    };
  }
  // High card.
  return {
    category: 'high-card',
    categoryRank: 0,
    tiebreak: ranks.slice(),
    best5: cards.slice(),
  };
}

interface RankCount { rank: number; count: number }

function countRanks(sortedRanksDesc: number[]): RankCount[] {
  const map = new Map<number, number>();
  for (const r of sortedRanksDesc) map.set(r, (map.get(r) ?? 0) + 1);
  const out: RankCount[] = [];
  for (const [rank, count] of map) out.push({ rank, count });
  // Sort by count desc, then rank desc — makes categorisation branches simpler.
  out.sort((a, b) => (b.count - a.count) || (b.rank - a.rank));
  return out;
}

/**
 * Return the high card of the straight (5..14) or 0 if not a straight.
 * Handles the ace-low wheel A-2-3-4-5 (high = 5).
 */
function detectStraight(sortedRanksDesc: number[]): number {
  // Deduplicate (there might be a pair among the 5 — evaluate5 also sees
  // straight-flush hands where all 5 are distinct anyway, but be safe).
  const uniq = Array.from(new Set(sortedRanksDesc));
  if (uniq.length < 5) return 0;
  // Normal straight: 5 consecutive desc.
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] === uniq[i - 1] - 1) run++;
    else run = 1;
    if (run === 5) return uniq[i - 4];
  }
  // Wheel A-2-3-4-5: ace present + 2..5 present.
  if (uniq.includes(14) && uniq.includes(2) && uniq.includes(3)
      && uniq.includes(4) && uniq.includes(5)) return 5;
  return 0;
}

// ── Bot (right-seat, single-player parity with checkers/chess) ───────────────

/**
 * A trivial-but-competent heads-up bot. Not exploitable-safe, but plays
 * within legal action space (check/call when cheap; bet minbet with strong
 * pairs; fold to any bet with weak high cards). Sufficient for the demo
 * felt — real solver-quality play is not the goal here.
 */
export function chooseBotAction(state: PokerState, seat: PokerSeat): PokerActionInput | null {
  if (!canAct(state, seat)) return null;
  const p = state.players[seat];
  if (!p.holeCards) return { seat, kind: 'fold' };
  const strength = holeStrength(p.holeCards, state.community);
  const toCall = callAmount(state, seat);
  const canCheck = toCall === 0;
  const opponent = state.players[otherSeat(seat)];
  const opponentCanRespond = !opponent.allIn && !opponent.folded;

  // Fold gate: weak hand and non-trivial bet.
  const potOdds = state.pot === 0 ? 0 : toCall / (state.pot + toCall);
  if (!canCheck && strength < 0.35 && potOdds > 0.25) return { seat, kind: 'fold' };
  if (canCheck && strength < 0.65) return { seat, kind: 'check' };
  // Opponent already all-in (posted-blind edge or shove earlier) or folded
  // has no way to call a bet or raise — any additional chips just get stuck
  // in the pot with no meaningful contest. Take the free-showdown check so
  // the bot doesn't leak equity into an uncontestable pot.
  if (canCheck && !opponentCanRespond) return { seat, kind: 'check' };
  if (canCheck) {
    // Two distinct sub-cases share `canCheck` (toCall === 0):
    //   (a) `currentBet === 0`  → street is unopened, legal action is 'bet'.
    //   (b) `currentBet !== 0`  → someone matched the standing bet on this
    //       street (canonical case: preflop BB after a button-limp — the BB
    //       posted 10, button called for 10, BB's streetBet === currentBet
    //       === 10, so callAmount is 0 and canCheck is true — but the engine
    //       requires 'raise', not 'bet', because currentBet !== 0). If we
    //       return kind:'bet' here `applyPokerAction` silently rejects the
    //       action and the doc never advances; the bot pump keeps re-firing
    //       the same rejected action and the whole hand deadlocks with no
    //       UI signal (regressed in the initial ship). Route through raise
    //       whenever currentBet !== 0; if a min-raise is not legally
    //       available (short-stack edge), fall back to check.
    if (state.currentBet === 0) {
      const amount = Math.min(p.stack, minBet(state));
      return { seat, kind: 'bet', amount };
    }
    const target = minRaiseTo(state, seat);
    if (target > state.currentBet) return { seat, kind: 'raise', amount: target };
    return { seat, kind: 'check' };
  }
  if (strength >= 0.75) {
    // Raise if legal and enough chips.
    const target = minRaiseTo(state, seat);
    if (target > state.currentBet) return { seat, kind: 'raise', amount: target };
    return { seat, kind: 'call' };
  }
  return { seat, kind: 'call' };
}

/**
 * Rough 0..1 hand strength for the bot. Preflop: high-pair > high-suited-connector
 * > everything else. Postflop: check made-hand category and pair-vs-community.
 *
 * Postflop evaluates the best 5-card hand from EXACTLY the real cards on the
 * table — hole (2) + community (3..5) — via `evaluateBest`. A previous version
 * padded the input with duplicates of `community[0]` to reach 7 cards for
 * `evaluate7`; that made every high card on the flop look like trips because
 * the 21 C(7,5) combos included 3-of-the-same-card samples that evaluate5 has
 * no dedup for. Fixed here: no padding, real cards only, so `holeStrength`
 * actually computes what its docstring claims (made-hand category vs the
 * shared community).
 */
function holeStrength(hole: [Card, Card], community: Card[]): number {
  if (community.length === 0) {
    const [a, b] = hole;
    const ra = rankOf(a); const rb = rankOf(b);
    if (ra === rb) return 0.5 + (ra - 2) / 24; // pair: 0.5..≈1.0
    const hi = Math.max(ra, rb); const lo = Math.min(ra, rb);
    const suited = suitOf(a) === suitOf(b);
    const gap = hi - lo - 1;
    let score = (hi - 2) / 24; // high-card baseline
    if (suited) score += 0.1;
    if (gap === 0 && lo >= 8) score += 0.1;
    return Math.min(1, score);
  }
  if (community.length < 3) return 0.4; // shouldn't happen — postflop only
  const hand = evaluateBest([...hole, ...community]);
  // Category-based normalisation: 0.4 (highcard) .. 1 (straight-flush).
  return 0.4 + (hand.categoryRank / 8) * 0.6;
}

// ── Read-side helper — hide opponent hole cards for the UI ───────────────────

/**
 * Return a state copy safe to render for `viewerId`. If the viewer is not a
 * seated player, both hands are hidden until showdown. If they are seated,
 * their own hand stays visible; opponent hidden until showdown.
 *
 * A folded player's hand is MUCKED — after a fold-driven `awardUncontested`,
 * `street` reaches 'complete' but the folder's hole cards must stay hidden
 * from spectators (standard poker: the loser of a fold-off doesn't show).
 * The folder themselves still sees their own cards (they can review). The
 * winner's cards remain visible at showdown/complete; in real poker they may
 * muck too, but for the demo felt this keeps the recap informative (any peer
 * inspecting the raw doc could read it anyway — see white-cards caveat).
 *
 * NOTE: the raw doc still contains all cards; a determined peer can inspect
 * `readGame(tableId)` directly. See white-cards caveat at file top.
 */
export function readVisiblePokerState(state: PokerState, viewerId: string | null): PokerState {
  const showdownVisible = state.street === 'showdown' || state.street === 'complete';
  const button = { ...state.players.button };
  const bigBlind = { ...state.players.bigBlind };
  if (!showdownVisible) {
    if (viewerId !== button.id) button.holeCards = null;
    if (viewerId !== bigBlind.id) bigBlind.holeCards = null;
  } else {
    // Post-hand: the folder's cards stay mucked to spectators (and to the
    // opponent — they never earned the right to see). The folder themselves
    // still sees their own cards for review.
    if (button.folded && viewerId !== button.id) button.holeCards = null;
    if (bigBlind.folded && viewerId !== bigBlind.id) bigBlind.holeCards = null;
  }
  return { ...state, players: { button, bigBlind } };
}

// ── Shape guard (peers write the doc; malformed reads render as no game) ─────

/**
 * Runtime guard for a PokerHand summary (rank + tiebreaks + 5-card best hand).
 * Used by `isPokerShowdown` below — a hostile peer can plant any object shape
 * into the doc, so the read path validates every declared field before the UI
 * dereferences it (see devices.ts poker panel render loop).
 */
function isPokerHand(value: unknown): value is PokerHand {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Partial<PokerHand>;
  const catsOk = ['high-card', 'pair', 'two-pair', 'three-of-a-kind',
    'straight', 'flush', 'full-house', 'four-of-a-kind', 'straight-flush']
    .includes(h.category as string);
  const rankOk = Number.isInteger(h.categoryRank)
    && (h.categoryRank as number) >= 0 && (h.categoryRank as number) <= 8;
  const tbOk = Array.isArray(h.tiebreak)
    && h.tiebreak.every((x) => typeof x === 'number' && Number.isFinite(x));
  const best5Ok = Array.isArray(h.best5) && h.best5.length === 5
    && h.best5.every(isCard);
  return catsOk && rankOk && tbOk && best5Ok;
}

/**
 * Runtime guard for the PokerShowdown record embedded in `lastShowdown`.
 * CRITICAL: without this, a hostile peer writing `{ ...validState, status:
 * 'hand-over', lastShowdown: { winner: 'not-a-seat', pot: 0 } }` would pass
 * isPokerState, and devices.ts:pokerStatusText would deref
 * `s.players['not-a-seat'].id` on the render path — TypeError swallowed by the
 * gamesDoc notify try/catch, poker panel silently blanks. `winner` MUST match
 * the render-side seat lookup exactly, and every declared field is checked.
 */
function isPokerShowdown(value: unknown): value is PokerShowdown {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<PokerShowdown>;
  const winnerOk = s.winner === 'button' || s.winner === 'bigBlind' || s.winner === 'split';
  const btnHandOk = s.buttonHand === null || isPokerHand(s.buttonHand);
  const bbHandOk = s.bigBlindHand === null || isPokerHand(s.bigBlindHand);
  const potOk = Number.isInteger(s.pot) && (s.pot as number) >= 0;
  return winnerOk && btnHandOk && bbHandOk && potOk;
}

export function isPokerState(value: unknown): value is PokerState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<PokerState>;
  if (s.kind !== 'poker') return false;
  const streetOk = ['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'].includes(s.street as string);
  const statusOk = ['waiting', 'playing', 'hand-over', 'match-over'].includes(s.status as string);
  const toActOk = s.toAct === null || s.toAct === 'button' || s.toAct === 'bigBlind';
  const playerOk = (p: unknown): p is PokerPlayer => {
    if (typeof p !== 'object' || p === null) return false;
    const q = p as Partial<PokerPlayer>;
    const idOk = q.id === null || typeof q.id === 'string';
    const numsOk = Number.isInteger(q.stack) && (q.stack as number) >= 0
      && Number.isInteger(q.streetBet) && (q.streetBet as number) >= 0
      && Number.isInteger(q.handBet) && (q.handBet as number) >= 0;
    const holeOk = q.holeCards === null
      || (Array.isArray(q.holeCards) && q.holeCards.length === 2
        && isCard(q.holeCards[0]) && isCard(q.holeCards[1]));
    return idOk && numsOk && holeOk
      && typeof q.folded === 'boolean' && typeof q.allIn === 'boolean';
  };
  const playersOk = typeof s.players === 'object' && s.players !== null
    && playerOk((s.players as PokerState['players']).button)
    && playerOk((s.players as PokerState['players']).bigBlind);
  const actionOk = (a: unknown): a is PokerAction => {
    if (typeof a !== 'object' || a === null) return false;
    const x = a as Partial<PokerAction>;
    return (x.seat === 'button' || x.seat === 'bigBlind')
      && ['fold', 'check', 'call', 'bet', 'raise'].includes(x.kind as string)
      && Number.isInteger(x.amount) && (x.amount as number) >= 0
      && ['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'].includes(x.street as string);
  };
  // lastShowdown: PokerShowdown | null is a REQUIRED field on the interface
  // (see line 105) — validated here so downstream renderers (pokerStatusText,
  // pokerSeatLabel) can trust s.lastShowdown.winner as a valid seat token.
  const showdownOk = s.lastShowdown === null || isPokerShowdown(s.lastShowdown);
  return playersOk
    && statusOk
    && streetOk
    && toActOk
    && isDeck(s.community)
    && Number.isInteger(s.currentBet) && (s.currentBet as number) >= 0
    && Number.isInteger(s.minRaise) && (s.minRaise as number) >= 0
    && Number.isInteger(s.pot) && (s.pot as number) >= 0
    && isDeck(s.deck)
    && Array.isArray(s.actions) && s.actions.every(actionOk)
    && Number.isInteger(s.smallBlind) && (s.smallBlind as number) > 0
    && Number.isInteger(s.bigBlind) && (s.bigBlind as number) > 0
    && Number.isInteger(s.seed)
    && Number.isInteger(s.handsPlayed) && (s.handsPlayed as number) >= 0
    && showdownOk
    && typeof s.bot === 'boolean';
}
