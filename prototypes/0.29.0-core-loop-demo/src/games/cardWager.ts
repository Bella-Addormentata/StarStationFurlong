/**
 * CARD-FELT WAGER — chip-escrowed table stakes for heads-up poker and war (#45).
 *
 * PLAIN LANGUAGE (owner directive)
 *   - WAGER: an optional match-scope agreement to play for chips.
 *   - BUY-IN: the per-player entry both sides post before dealing.
 *   - POT: the sum of both BUY-INs that the winner takes at the end.
 *   No token / channel / mempool / on-chain jargon in player-facing text.
 *
 * TRUST BOUNDARY
 *   The casino Y.Map (see `casinoDoc.ts`) is a public unauthenticated peer
 *   store. Peers can write anything under any key. This module owns TWO
 *   record shapes and their deterministic-value shape guards; every doc
 *   read in `casinoDoc.ts` is validated through `isCardWagerConfig` /
 *   `isCardWagerRecord` before the caller acts on it. A malformed peer
 *   write fails SAFE — it reads as "no record", never as a partial value
 *   that would drain, double-credit, or divert the pot.
 *
 * SINGLE-WRITER-PER-KEY DISCIPLINE
 *   - `cw-cfg:<tableId>` is written only by the wager OWNER (the player
 *     who created the config). Owner is the one authorized to settle at
 *     match end (mirrors the air-hockey fee owner, PR #116 reviewed clean).
 *   - `cw-escrow:<tableId>:<playerId>` is written only by that `playerId`
 *     (their own key), during PAY and self-REFUND. The OWNER-SWEEP path
 *     may also delete a `held` record during abandonment cleanup, mirroring
 *     the air-hockey owner sweep discipline.
 *   - Balance writes (`bal:<pid>`) happen on PAY (payer debit), REFUND
 *     (payer credit), and SETTLE (winner credit). Settle is a SINGLE
 *     transact by the owner, so no concurrent writer races the settle
 *     transition.
 *
 * CONSERVATION INVARIANT (locked by tests)
 *   escrowed_total = paid_out + refunded + still_held
 *   Equivalently:  Σ record.amount   ==   Σ pay-in amounts
 *                                       - Σ refund credits
 *                                       - Σ settle payouts
 *   Every path (pay / refund / settle / abandonment-refund) writes
 *   MATCHING deltas in the same transact so a mid-settle-throw is
 *   all-or-nothing at the Y.Doc level (Yjs `doc.transact` semantics).
 *
 * CRASH-RETRY / IDEMPOTENCY
 *   - `payCardWager` refuses to re-charge a payer whose record already
 *     exists in `held` at the SAME amount; a duplicate call is a no-op.
 *   - `refundCardWager` is idempotent — a missing record returns false
 *     (already refunded / never paid) and does not double-credit.
 *   - `settleCardWager` deletes both records in one transact; a second
 *     settle finds no records and no-ops.
 *
 * CHIA-GAMING COMPATIBILITY CONTRACT (issue-45 requirement)
 *   The real chia-gaming secure-wagering stack uses two-party state
 *   channels with a Chialisp REFEREE puzzle that pays out on chain.
 *   That's out of scope for this slice (blocked external — see
 *   `brainstorming/games-plan.md` Phase 5). The GAME-FIRST slice
 *   below deliberately mirrors the state-channel shape so the later
 *   Chia binding is a single-layer swap:
 *
 *     STATE CHANNEL / CHIA-GAMING             THIS MODULE (v1 casino chips)
 *     ---------------------------             -----------------------------
 *     Channel stake coin (2x buyIn locked)    `cw-cfg:<tableId>` + both
 *                                             `cw-escrow:<tableId>:<pid>`
 *                                             records (chips debited from
 *                                             `bal:<pid>`)
 *     Referee puzzle on the stake             `settleCardWager` (owner
 *                                             computes winner from public
 *                                             engine state and pays out
 *                                             from escrow — trusted for v1)
 *     Off-chain signed state updates          Yjs whole-value LWW writes
 *                                             to the games map (pure engine
 *                                             transitions; each successor
 *                                             is byte-identical across peers)
 *     Channel close (winner reveals final     Owner reads the terminal
 *     state, referee validates and pays)      poker/war state and calls
 *                                             settle with the deterministic
 *                                             winner seat
 *     Refund / timeout via channel-close      Owner (or self, before start)
 *     unilateral path                         calls refund; abandonment is
 *                                             an owner-sweep
 *
 *   WHAT UPGRADES on the Chia binding:
 *     - Escrow becomes a real coin locked by a Chialisp puzzle, not a
 *       trusted owner. Anybody can force settle by presenting the terminal
 *       engine state; the referee validates it.
 *     - Balance becomes a real CAT token or XCH mojo, not a room-doc
 *       counter. Settle payouts are mempool spends, not Yjs writes.
 *     - Signed off-chain moves replace the raw whole-value LWW writes so
 *       a hostile peer cannot rewind or forge the engine state.
 *
 *   WHAT STAYS:
 *     - The pure engine (poker.ts, war.ts) is the same referee re-validator
 *       in both worlds. `applyPokerAction` / `playWarRound` transitions
 *       become the puzzle's "is this state legal?" check.
 *     - Per-player escrow records with a fixed writer per key.
 *     - Atomic single-transact settle (Yjs transact today, Chialisp spend
 *       later).
 *     - Deterministic winner derivation from public engine state (both
 *       peers agree; the referee agrees; no signed message needed to
 *       communicate the outcome).
 *
 * WHITE-CARDS CAVEAT (games-plan.md phase 4)
 *   The poker doc reveals hole cards to any peer — hidden information is
 *   deferred to the commit-reveal pass. Wagered poker with hidden hole
 *   cards blocks on that same work; this slice ships the chip lane so
 *   the felt is money-aware even while hidden information waits its turn.
 */

// ── Kinds and constants ──────────────────────────────────────────────────────

/** Which card game a wager is scoped to. Enumerated (not free-form) so a
 *  hostile peer writing `kind: "solitaire"` fails the shape guard. */
export type CardWagerKind = 'poker' | 'war';
const CARD_WAGER_KINDS: readonly CardWagerKind[] = ['poker', 'war'];

/** Record states the escrow moves through. Both peers write their own
 *  record only; the owner may delete a `held` record during abandonment
 *  cleanup, and settle deletes both records in one transact. */
export type CardWagerRecordState = 'held';
const CARD_WAGER_RECORD_STATES: readonly CardWagerRecordState[] = ['held'];

/** Absolute floor on buy-in — a zero-chip "wager" would be a no-op that
 *  still occupies the escrow record and blocks the pay path. Rejected. */
export const MIN_CARD_WAGER_BUY_IN = 1;

/** Absolute ceiling on buy-in — pot = 2 * buyIn, so this bounds any single
 *  payout to a value comfortably inside a 32-bit integer. Prevents overflow
 *  attacks (a maliciously-large buyIn record trying to inflate the pot). */
export const MAX_CARD_WAGER_BUY_IN = 1_000_000;

/**
 * Poker-specific floor. `beginPoker` seats each stack at the wager buy-in
 * but clamps it UP to `2 × bigBlind` (= 20 with the engine's bigBlind: 10)
 * so the first hand can post blinds. A wager below that floor would play
 * with in-game stacks LARGER than the chips actually escrowed — the match
 * would be fought over more than the pot pays. Refused at the config
 * boundary instead of silently clamped.
 */
export const POKER_MIN_WAGER_BUY_IN = 20;

/** The per-kind buy-in floor (poker carries the engine blind floor; war has
 *  no blind structure, so the absolute floor applies). */
export function minCardWagerBuyIn(kind: CardWagerKind): number {
  return kind === 'poker' ? POKER_MIN_WAGER_BUY_IN : MIN_CARD_WAGER_BUY_IN;
}

// ── Data types ───────────────────────────────────────────────────────────────

/**
 * Owner-written config for a table's wager. Present ⇒ the felt is in
 * WAGER MODE. Absent ⇒ free play (today's default; bit-identical).
 *
 * `ownerId` is the WAGER OWNER — the player who enabled wager mode. Only
 * they may `settleCardWager`, `activateCardWager` (stamp `startedAt`),
 * and `refundCardWager` on any player's record (abandonment path).
 *
 * `startedAt` is null while both players are still paying in; owner
 * stamps it on BEGIN, after which self-refund is locked and only settle
 * (or owner-abandonment refund) can move the escrow chips. This mirrors
 * the two-phase channel-open in chia-gaming (both deposit → channel
 * opens → play → close).
 */
export interface CardWagerConfig {
  kind: CardWagerKind;
  /** Positive integer. Each player pays this into escrow on sit-down. */
  buyIn: number;
  /** Wager owner's player id — the sole settle authority for this table. */
  ownerId: string;
  /** ms wall-clock at config write (owner stamp). Used for freshness
   *  and — later — TTL of the whole wager if abandoned before BEGIN. */
  createdAt: number;
  /** ms wall-clock stamped by owner on BEGIN. Null until both `held`. */
  startedAt: number | null;
}

/**
 * Per-player escrow record. Written only by `playerId` (their own key
 * in the casino map). The record's presence and `state` govern what
 * transitions are legal:
 *
 *   'held' — chips escrowed. Refund path (self or owner-abandonment)
 *            or settle path may act next.
 *
 * The record's `amount` MUST match `CardWagerConfig.buyIn` (checked at
 * every read); a peer writing a mismatched amount fails the read-side
 * validation and the record reads as absent.
 */
export interface CardWagerRecord {
  kind: CardWagerKind;
  /** Chips escrowed (== config.buyIn at pay time). */
  amount: number;
  /** The wager owner's player id (must equal config.ownerId). */
  ownerId: string;
  /** The payer — this key's sole writer. */
  playerId: string;
  /** ms wall-clock at pay time (payer stamp). */
  paidAt: number;
  state: CardWagerRecordState;
}

/**
 * Per-player RESULT ACKNOWLEDGMENT. Written only by `playerId` (their own
 * `cw-ack:<tableId>:<playerId>` key) after the match reaches its terminal
 * state. Settle is gated on BOTH payers' acks agreeing — the owner alone
 * can no longer pick the winner.
 *
 * WHY: the owner is the sole settle authority, and pre-ack the winner was
 * derived from the poker doc the owner's client read. A hostile peer who
 * forged a terminal PokerState (raw whole-value LWW write — the doc is
 * unauthenticated until the chia-gaming referee lands) could steer an
 * HONEST owner into paying the wrong seat. With the ack gate, the losing
 * player's client independently derives the result from ITS view and
 * refuses to confirm a forged outcome — the settle then simply never
 * fires, and the owner's abandonment refund returns both buy-ins.
 *
 * WHAT THIS DOES NOT DEFEND (documented trust posture): a MALICIOUS owner
 * colluding with one payer, or raw-writing balances, is out of scope for
 * v1 — that is exactly the chia-gaming referee's job (see the contract
 * table above). The ack gate closes the "deceived honest owner" hole only.
 *
 * `matchStartedAt` echoes `config.startedAt` — an ack from a PREVIOUS
 * match on the same table (stale key, or a replayed value) fails the
 * freshness check and cannot gate a later match's settle.
 */
export interface CardWagerAck {
  kind: CardWagerKind;
  /** The acking payer — this key's sole writer. */
  playerId: string;
  /** The payer this ack names as winner, or 'split' for a tie. */
  winnerId: string | 'split';
  /** Echo of `config.startedAt` for the match being acked (freshness). */
  matchStartedAt: number;
  /** ms wall-clock at ack time (payer stamp). */
  ackedAt: number;
}

// ── Shape guards ─────────────────────────────────────────────────────────────

function isPositiveInt(v: unknown, max: number = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Guard for a `CardWagerConfig` read out of the casino map. A hostile
 *  peer can plant any object under `cw-cfg:<tableId>` — this rejects
 *  every malformed shape (wrong kind, non-integer buyIn, negative
 *  createdAt, non-null non-number startedAt, etc.). */
export function isCardWagerConfig(value: unknown): value is CardWagerConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<CardWagerConfig>;
  if (!CARD_WAGER_KINDS.includes(c.kind as CardWagerKind)) return false;
  if (!isPositiveInt(c.buyIn, MAX_CARD_WAGER_BUY_IN)) return false;
  if ((c.buyIn as number) < MIN_CARD_WAGER_BUY_IN) return false;
  if (!isNonEmptyString(c.ownerId)) return false;
  if (!isFiniteNumber(c.createdAt) || (c.createdAt as number) < 0) return false;
  if (c.startedAt !== null
    && (!isFiniteNumber(c.startedAt) || (c.startedAt as number) < 0)) return false;
  return true;
}

/** Guard for a `CardWagerRecord` read out of the casino map. Same
 *  hostile-peer surface as the config — every field is validated
 *  before any settle / refund path uses it. */
export function isCardWagerRecord(value: unknown): value is CardWagerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<CardWagerRecord>;
  if (!CARD_WAGER_KINDS.includes(r.kind as CardWagerKind)) return false;
  if (!isPositiveInt(r.amount, MAX_CARD_WAGER_BUY_IN)) return false;
  if ((r.amount as number) < MIN_CARD_WAGER_BUY_IN) return false;
  if (!isNonEmptyString(r.ownerId)) return false;
  if (!isNonEmptyString(r.playerId)) return false;
  if (!isFiniteNumber(r.paidAt) || (r.paidAt as number) < 0) return false;
  if (!CARD_WAGER_RECORD_STATES.includes(r.state as CardWagerRecordState)) return false;
  return true;
}

/** Guard for a `CardWagerAck` read out of the casino map. Hostile-peer
 *  surface like the other two shapes — `winnerId` may be any non-empty
 *  string ('split' is the tie sentinel; whether it names a REAL payer is
 *  a read-side check in `readAgreedCardWagerResult`, which also binds
 *  `playerId` to the key it was read from). */
export function isCardWagerAck(value: unknown): value is CardWagerAck {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Partial<CardWagerAck>;
  if (!CARD_WAGER_KINDS.includes(a.kind as CardWagerKind)) return false;
  if (!isNonEmptyString(a.playerId)) return false;
  if (!isNonEmptyString(a.winnerId)) return false;
  if (!isFiniteNumber(a.matchStartedAt) || (a.matchStartedAt as number) < 0) return false;
  if (!isFiniteNumber(a.ackedAt) || (a.ackedAt as number) < 0) return false;
  return true;
}

// ── Key layout (import-friendly constants for casinoDoc.ts) ─────────────────

export const CARD_WAGER_CONFIG_PREFIX = 'cw-cfg:';
export const CARD_WAGER_ESCROW_PREFIX = 'cw-escrow:';
export const CARD_WAGER_ACK_PREFIX = 'cw-ack:';

/** Build the config key for one table (single writer: config owner). */
export function cardWagerConfigKey(tableId: string): string {
  return `${CARD_WAGER_CONFIG_PREFIX}${tableId}`;
}

/** Build the per-player escrow key (single writer: the payer). */
export function cardWagerEscrowKey(tableId: string, playerId: string): string {
  return `${CARD_WAGER_ESCROW_PREFIX}${tableId}:${playerId}`;
}

/** Build the per-player result-ack key (single writer: the acking payer). */
export function cardWagerAckKey(tableId: string, playerId: string): string {
  return `${CARD_WAGER_ACK_PREFIX}${tableId}:${playerId}`;
}

// ── Pure derivation helpers (no doc / DOM / clock) ──────────────────────────

/**
 * Conservation ledger derived from a set of escrow records + a running
 * count of payouts and refunds. Callers pass tallies from the doc; this
 * helper just returns the invariant we want to keep true.
 *
 * The invariant:
 *   sumHeld + sumPaidOut + sumRefunded  ==  sumPaidIn
 *
 * where:
 *   - sumHeld    = Σ amounts of `held` records currently in the doc
 *   - sumPaidOut = Σ chips credited to winners via settle
 *   - sumRefunded= Σ chips returned to payers via refund
 *   - sumPaidIn  = Σ chips debited from payers on their pay-in
 *
 * The pure form makes it trivially testable: any diverging observation
 * points to a leak / double-credit / drain.
 */
export interface CardWagerConservation {
  sumHeld: number;
  sumPaidOut: number;
  sumRefunded: number;
  sumPaidIn: number;
}

export function isCardWagerConservationBalanced(c: CardWagerConservation): boolean {
  return c.sumHeld + c.sumPaidOut + c.sumRefunded === c.sumPaidIn;
}

/**
 * Given a set of currently-held escrow records and the config's buy-in,
 * return the "well-formed" subset: records whose amount matches the
 * configured buyIn exactly. A hostile peer's record with a wrong amount
 * is dropped from the accounting so downstream math cannot be inflated.
 */
export function filterConformingHeld(
  records: readonly CardWagerRecord[],
  buyIn: number,
): CardWagerRecord[] {
  return records.filter((r) => r.state === 'held' && r.amount === buyIn);
}

/**
 * Derive the heads-up match result from two terminal seat stacks — the
 * SAME rule every client applies, so honest peers agree without any
 * message exchange:
 *
 *   - one seat holds all the chips, the other zero  → that seat's id
 *   - both seats still hold chips                   → 'split'
 *   - a seat id missing, or both stacks zero        → null (not derivable;
 *     a normal terminal PokerState never looks like this)
 *
 * Structural parameters (id + stack only) keep this module decoupled from
 * the poker engine's types; devices.ts passes the two seats straight in.
 * Used for the ACK default (each payer confirms what their OWN doc view
 * derives) and by the owner's settle trigger.
 */
export function deriveHeadsUpWinner(
  a: { id: string | null; stack: number },
  b: { id: string | null; stack: number },
): string | 'split' | null {
  if (a.id === null || b.id === null) return null;
  if (a.stack > 0 && b.stack === 0) return a.id;
  if (b.stack > 0 && a.stack === 0) return b.id;
  if (a.stack > 0 && b.stack > 0) return 'split';
  return null;
}
