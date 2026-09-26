/**
 * 🪙 Coin pusher — the pure engine (issue #135).
 *
 * A single-machine arcade coin pusher: the player picks one of three DROP
 * HOLES at the top of the cabinet and TIMES the drop against the sweeping
 * pusher on the upper platform. The chip falls through a pin field
 * (deterministic left/right deflection per row from a seed hash), lands on the
 * upper platform, and is shoved toward the front edge by the pusher. Chips
 * stack, cascade, tip off the upper edge onto the LOWER platform, and — pushed
 * by the chips behind them — finally tip off the front of the lower platform
 * into the payout tray. Only chips that fall off the FRONT of the LAST
 * PLATFORM are paid out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE DISCIPLINE
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is PURE (no Yjs / DOM / THREE / wall-clock / Math.random), the
 * same layering contract as games/checkers.ts, games/craps.ts, games/slots.ts.
 * All randomness is derived by a stable non-cryptographic hash from a caller-
 * provided seed + (hole, drop phase, peg row), so a peer with the same seed
 * reproduces the exact chip trajectory. All time enters as explicit
 * milliseconds — the wiring layer reads the clock. Doc I/O is in casinoDoc.ts,
 * the operator in pusherCroupier.ts, UI/scene wiring in devices.ts and
 * furniture.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHYSICS MODEL — a 1-D cross-section
 * ─────────────────────────────────────────────────────────────────────────────
 * The playfield is modelled as ONE back-to-front axis: every chip position is
 * a single x. There is no lateral coordinate and no side drain; the three drop
 * holes differ only in where along that axis a chip enters. Two stepped
 * platforms sit on the axis:
 *
 *      UPPER PLATFORM ────  x ∈ [PLAT_UP_BACK, PLAT_UP_FRONT]
 *      LOWER PLATFORM ──────  x ∈ [PLAT_LOW_BACK, PLAT_LOW_FRONT]  (in front)
 *
 * A "pile" is a vertical stack of chips at one x. Piles are kept sorted by x
 * (back → front) and separated by ≥ 2·CHIP_R (one chip diameter): a
 * settlement pass enforces both on every mutation, so a peer-written state
 * that arrives with overlap is re-settled before a physics step, which keeps
 * the engine total (it never diverges).
 *
 * Only the UPPER platform has an active pusher (the sweep bar); the LOWER
 * platform is driven by the weight of chips landing on it from above (each
 * falling pile shoves the pile under it forward, and the shove propagates
 * through any abutting piles ahead — the CASCADE mechanic of the issue).
 *
 * Sweep pusher: a cosine oscillation with period PUSHER_PERIOD_MS. Only the
 * FORWARD half imparts force (a retracting pusher does not drag chips back).
 * One full cycle compresses the piles as far as the pusher can reach, so a
 * second cycle moves nothing: the machine is at rest between inserts, and the
 * physics only runs when a chip is dropped (processInsert settles a full cycle
 * after every drop). Nothing leaves the machine on its own.
 *
 * The sweep itself is a free-running clock: (pusherPhase, pusherAtMs) anchor
 * it when the machine is created and drops never move it, so every client
 * draws the same pusher from its own wall clock (currentPusherPhase) and the
 * player times the drop against that. The drop's physics starts from the
 * phase the player saw (resolveDropTiming), not from the anchor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSERVATION INVARIANT (dev, playtest and vitest all check it)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *      totalInserted === chipsInMachine + totalPaid + totalEmptied
 *
 * Every path that adds or removes chips updates exactly one counter on each
 * side. The MONEY side is the operator's (pusherCroupier.ts): one settle
 * transaction debits the inserting player's one chip, credits exactly the
 * chips this insert paid out, publishes the new machine state and clears the
 * request (casinoDoc.settleCoinPusherInsert). Players never write money for
 * the machine and never claim payouts — there is nothing to forge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHORITY
 * ─────────────────────────────────────────────────────────────────────────────
 * The shared record is `pusher:<machineId>` in the casino map (whole-value
 * LWW), written only by the elected operator — the slot-croupier pattern:
 *   • a player writes an insert REQUEST (`pusher-req:<mid>:<pid>`: hole + the
 *     pusher phase they saw, and when, as they pressed DROP); no chips move;
 *   • the operator validates it (chips on hand, room in the machine, the
 *     claim inside the timing window — resolveDropTiming), runs
 *     processInsert with a seed it draws itself, and settles — or refuses,
 *     moving nothing. Either way it answers under the player's own
 *     `pusher-result:<mid>:<pid>` (PusherResult), which stays until that
 *     player's next request is answered;
 *   • only the machine OWNER may empty it, and that too goes through the
 *     operator (`pusher-empty:<mid>`), so an empty never races an insert. The
 *     operator answers under `pusher-door:<mid>` (PusherDoorResult).
 * Every doc read shape-guards (isCoinPusherState etc.): a hostile peer that
 * writes junk into these keys makes other clients see no machine, never a
 * corrupt one.
 */

// ── Physical constants (metres, millis) ──────────────────────────────────────
//
// The x-axis runs BACK → FRONT of the cabinet. Origin (x=0) is the back wall
// of the upper platform; positive x goes towards the payout tray. Both
// platforms live on the same x-axis (the lower one is IN FRONT of the upper,
// one geometric step down in y that the pure engine ignores):
//
//     x=0.00                  0.60                  1.20
//       ├──── UPPER ─────────┼──── LOWER ──────────┤
//       ▓ pusher                                     ▐ payout
//       ▓  rest  →  extends to 0.51    ...           ▐  tray
//
// A chip pushed past x=0.60 tips off the upper front and lands on the back of
// the lower (near x=0.63 after clamping). Chips pushed past x=1.20 tip off
// the front of the lower and are paid out to the player whose drop moved them.

/** One chip's radius on the horizontal axis (also its diameter/2 for stacking). */
export const CHIP_R = 0.030;
/** Contact spacing between adjacent piles: two chips can't overlap horizontally. */
export const PILE_STEP = 2 * CHIP_R;

/** Upper platform x extent (back edge = pusher rest, front edge = drop-off). */
export const PLAT_UP_BACK = 0.00;
export const PLAT_UP_FRONT = 0.60;
/** Lower platform x extent — starts where upper ends (same front lip). */
export const PLAT_LOW_BACK = 0.60;
export const PLAT_LOW_FRONT = 1.20;

/** Pusher (sweep bar) travel. The front face moves from `MIN_X` (retracted
 *  at the back wall) to `MAX_X` (extended nearly to the upper front — the
 *  gap leaves room for ~1½ pile widths of front cushion). */
export const PUSHER_MIN_X = PLAT_UP_BACK;
export const PUSHER_MAX_X = PLAT_UP_FRONT - PILE_STEP * 1.5; // 0.51
/** One complete forward-and-back cycle of the sweep bar (ms). */
export const PUSHER_PERIOD_MS = 2400;

/** Positions of the three drop holes along the axis (over the upper
 *  platform), spread so each hole has a distinct landing zone even after the
 *  ±(TIMING_OFFSET + PEG_ROWS·PEG_DEFLECTION) drift. */
export const HOLE_XS: readonly number[] = [0.15, 0.30, 0.45] as const;
export const HOLE_COUNT = HOLE_XS.length;

/** Fixed substep for the pusher-driven physics — small enough that the front
 *  face moves ≪ CHIP_R per substep at peak velocity, so cascades resolve
 *  without tunnelling through piles. */
export const PHYSICS_SUBSTEP_MS = 40;

/** Pusher motion simulated after each drop (one full period + one substep),
 *  so the drop interacts with every pile the pusher can reach and the machine
 *  comes back to rest. */
export const SETTLE_MS = PUSHER_PERIOD_MS + PHYSICS_SUBSTEP_MS;

/** Peg field: rows of pins the chip deflects off between the hole and the
 *  upper platform. Five rows gives ~32 possible landing lanes, wide enough
 *  for real skill+luck but still small enough to test exhaustively. */
export const PEG_ROWS = 5;
/** Sideways displacement per peg row (metres). Tuned so a full ±5-bit walk
 *  spans about one hole spacing. */
export const PEG_DEFLECTION = 0.020;

/** How far the drop phase shifts the entry point: ±CHIP_R over a full cycle,
 *  so timing matters but never enough to bypass the peg field entirely. */
export const TIMING_OFFSET = CHIP_R;

/** Chips per insert. A coin pusher takes one coin per drop; the money side
 *  (casinoDoc.settleCoinPusherInsert) debits exactly this. */
export const PUSHER_ANTE = 1;

/** Physical stability cap on a chip column. When a landing pushes a column
 *  past this, the excess SPILLS forward to the pile ahead (which may itself
 *  spill, chain-cascading toward the front) — the issue's "groups of chips
 *  fall together, or off the front of a group". */
export const MAX_STACK_HEIGHT = 4;

/** How late an insert may reach the operator (its clock less the request's
 *  own timestamp: network + drain delay) and still drop at the phase the
 *  player saw. An older claim — or a phase that wasn't on screen at the
 *  claimed moment — drops at the operator's current phase instead
 *  (resolveDropTiming). */
export const MAX_DROP_LAG_MS = 1000;
/** How far AHEAD of the operator's clock a request's timestamp may be and its
 *  timing still be kept. Every client derives the pusher from its own wall
 *  clock (there is no shared clock on the mesh), so a player whose clock runs
 *  a little ahead of the operator's sees the pusher slightly ahead. */
export const MAX_DROP_LEAD_MS = 250;

/** How long a player's panel waits for the operator before withdrawing its
 *  own request. A request carries no chips, so a withdrawn one needs no
 *  refund. */
export const PUSHER_REQUEST_TTL_MS = 15_000;
/** The operator refuses (moving nothing) a request that has waited longer
 *  than this since it first saw it, measured on its own clock: the tail of a
 *  flood it is still working through. A request's own time (`requestedAt`) is
 *  the player's clock, so it decides only whether the drop's timing is kept;
 *  a device whose clock is off still plays. */
export const PUSHER_STALE_REQUEST_MS = 120_000;

/** Most chips the cabinet can physically hold. The platforms fit ~11 piles
 *  each at MAX_STACK_HEIGHT, i.e. ≤ 88 chips; this is the guard's aggregate
 *  ceiling (a peer state above it is rejected, so the renderer's per-chip
 *  meshes stay bounded) and the point at which processInsert refuses a drop. */
export const MACHINE_MAX_CHIPS = 128;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A vertical stack of chips at one x-column. `chipIds` is bottom-to-top and
 * its length is the source of truth for `count`; the guard enforces the
 * equality so peer states that disagree between the two are rejected.
 */
export interface Pile {
  x: number;
  count: number;
  chipIds: number[];
}

/** Which drop hole a chip goes through (0 = left, 1 = centre, 2 = right). */
export type PusherHole = 0 | 1 | 2;

/** The most recent settled drop — every client animates it on the cabinet,
 *  and the dropping player's panel reads its result. */
export interface PusherLastDrop {
  requestId: string;
  player: string;
  hole: PusherHole;
  chipId: number;
  landedX: number;
  /** Chips this drop paid out to `player`. */
  paid: number;
  /** The pusher phase the chip fell at. */
  phase: number;
  /** True when that is the phase the player saw (their timing was kept);
   *  false when the claim fell outside the window and the chip dropped at
   *  the operator's current phase. */
  honored: boolean;
  /** Operator clock when the drop settled. */
  atMs: number;
}

/** One settled drop as the cabinet shows it: the hole it came through. */
export interface PusherDropMark {
  /** The chip it dropped (a machine's chip ids rise by one a drop). */
  chipId: number;
  hole: PusherHole;
}

/** Settled drops the machine remembers for the cabinet (recentDrops). A poll
 *  settles at most a handful, so this covers several polls' worth landing
 *  between two frames. */
export const RECENT_DROPS_MAX = 8;

/** Why the operator turned an insert down. No chip moves on a refusal.
 *  `balance-full`: the player's balance couldn't take the most the drop could
 *  pay (it would leave the safe-integer range). */
export type PusherRefusalReason = 'no-chips' | 'machine-full' | 'expired' | 'balance-full';

/**
 * The operator's answer to one player's request, written in the same
 * transaction as the drop or refusal under `pusher-result:<mid>:<pid>` and
 * kept until that player's next request is answered. Unlike the machine-wide
 * `lastDrop` (which the next player's drop overwrites), a panel that missed
 * intermediate updates still finds its own answer here.
 */
export type PusherResult =
  | { kind: 'drop'; requestId: string; paid: number; honored: boolean; atMs: number }
  | { kind: 'refused'; requestId: string; reason: PusherRefusalReason; atMs: number };

/**
 * The operator's answer to the latest door request, under
 * `pusher-door:<mid>`, written in the same transaction that empties the
 * machine or turns the request down (its requester doesn't own the machine —
 * say, an owner whose deed has since changed hands). A door request that
 * merely vanished proves nothing, so the panel reads this. `emptied` is how
 * many chips went to the owner.
 */
export type PusherDoorResult =
  | { kind: 'opened'; requestId: string; emptied: number; atMs: number }
  | { kind: 'refused'; requestId: string; atMs: number };

/**
 * The full doc-synced machine state — plain JSON, whole-value LWW write per
 * machine key. `kind` discriminates it inside the shared casino map (the
 * slot-machine / roulette / craps precedent).
 */
export interface CoinPusherState {
  kind: 'coin-pusher';
  /** Machine owner — the only player who may open the door and empty it. */
  ownerId: string;
  /** Upper platform piles, back-to-front (sorted by x ascending). */
  upper: Pile[];
  /** Lower platform piles, back-to-front (sorted by x ascending). */
  lower: Pile[];
  /** Monotonic chip identity for conservation checks + rendering continuity. */
  nextChipId: number;
  /** Pusher phase [0, 1) at `pusherAtMs`: the anchor of the free-running
   *  sweep. Its phase at any time is currentPusherPhase(state, t). */
  pusherPhase: number;
  /** Wall-clock ms the phase is anchored at (set when the machine is created;
   *  drops never move it). */
  pusherAtMs: number;
  /** Monotonic write counter — every mutating helper bumps it. */
  tick: number;
  /** Lifetime chips inserted into THIS machine. */
  totalInserted: number;
  /** Lifetime chips that fell off the FRONT of the LOWER platform (paid out). */
  totalPaid: number;
  /** Lifetime chips removed by an owner-triggered door-open. */
  totalEmptied: number;
  /** The last settled drop (absent until the first one); each player's own
   *  answer is their PusherResult. */
  lastDrop?: PusherLastDrop;
  /** The last RECENT_DROPS_MAX settled drops, oldest first (absent until the
   *  first one). The cabinet lights the hole of every one it hasn't shown yet
   *  (unseenDropHoles), even when several land between two of its frames. */
  recentDrops?: PusherDropMark[];
}

/** Insert request a player writes under `pusher-req:<machineId>:<playerId>`.
 *  It carries no money: the operator debits the chip when it settles. */
export interface PusherInsertRequest {
  requestId: string;
  player: string;
  hole: PusherHole;
  /** The pusher phase ∈ [0, 1) on the player's screen when they pressed
   *  DROP — the timing the drop is made at (resolveDropTiming). */
  phase: number;
  /** When they pressed it, by their clock (ms). The operator keeps their
   *  timing only when `phase` is the pusher's phase at this moment and it is
   *  inside the timing window of the operator's own clock; it never moves
   *  chips. */
  requestedAt: number;
}

/** The owner's door-open request under `pusher-empty:<machineId>`, executed
 *  by the operator so it is ordered with the inserts. */
export interface PusherEmptyRequest {
  requestId: string;
  requester: string;
  requestedAt: number;
}

// ── Guards (peer trust boundary) ─────────────────────────────────────────────

/** A safe non-negative integer. */
function isCountInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function isBoundedId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

/** Per-pile and per-platform ceilings. The engine never builds a column above
 *  MAX_STACK_HEIGHT or more than ~11 piles on a platform; these leave headroom
 *  for a state mid-settle while keeping a hostile peer from shipping giant
 *  arrays. MACHINE_MAX_CHIPS bounds the total across both platforms. */
const PILE_MAX_CHIPS = 2 * MAX_STACK_HEIGHT;
const PLATFORM_MAX_PILES = 24;

/** A pile on a platform spanning [lo, hi] — a settled machine never holds a
 *  pile anywhere else (anything pushed past a front edge has fallen), and the
 *  renderer maps x linearly, so an unbounded x would reach it as Infinity. */
function isPile(v: unknown, lo: number, hi: number): v is Pile {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<Pile>;
  if (typeof p.x !== 'number' || !Number.isFinite(p.x) || p.x < lo || p.x > hi) return false;
  if (!isCountInt(p.count) || (p.count as number) > PILE_MAX_CHIPS) return false;
  if (!Array.isArray(p.chipIds)) return false;
  if ((p.chipIds as unknown[]).length !== p.count) return false;
  for (const id of p.chipIds as unknown[]) {
    if (!isCountInt(id)) return false;
  }
  return true;
}

function isPileArray(v: unknown, lo: number, hi: number): v is Pile[] {
  return Array.isArray(v) && v.length <= PLATFORM_MAX_PILES
    && v.every((p) => isPile(p, lo, hi));
}

function isHole(v: unknown): v is PusherHole {
  return v === 0 || v === 1 || v === 2;
}

function isPhase(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1;
}

/** The Date range (±8.64e15 ms, the ECMAScript time value limit). Every
 *  timestamp a record carries lies in it, so the difference of any two stays
 *  finite. A peer-written one outside it (±Number.MAX_VALUE, say) is refused
 *  at the trust boundary: against another at the other extreme, the phase
 *  arithmetic overflows to NaN. */
export const MAX_TIMESTAMP_MS = 8.64e15;

function isTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TIMESTAMP_MS;
}

function isLastDrop(v: unknown): v is PusherLastDrop {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Partial<PusherLastDrop>;
  return isBoundedId(d.requestId) && isBoundedId(d.player) && isHole(d.hole)
    && isCountInt(d.chipId)
    && typeof d.landedX === 'number' && Number.isFinite(d.landedX)
    && isCountInt(d.paid) && (d.paid as number) <= MACHINE_MAX_CHIPS
    && isPhase(d.phase) && typeof d.honored === 'boolean'
    && isTimestamp(d.atMs);
}

/** Marks of drops the machine has made: each chip id below its nextChipId. */
function isRecentDrops(v: unknown, nextChipId: number): v is PusherDropMark[] {
  return Array.isArray(v) && v.length <= RECENT_DROPS_MAX && v.every((d: unknown) => {
    if (typeof d !== 'object' || d === null) return false;
    const m = d as Partial<PusherDropMark>;
    return isCountInt(m.chipId) && (m.chipId as number) < nextChipId && isHole(m.hole);
  });
}

const REFUSAL_REASONS: readonly PusherRefusalReason[] = ['no-chips', 'machine-full', 'expired', 'balance-full'];

export function isPusherResult(v: unknown): v is PusherResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { kind?: unknown; requestId?: unknown; atMs?: unknown; paid?: unknown; honored?: unknown; reason?: unknown };
  if (!isBoundedId(r.requestId) || !isTimestamp(r.atMs)) return false;
  if (r.kind === 'drop') {
    return isCountInt(r.paid) && (r.paid as number) <= MACHINE_MAX_CHIPS && typeof r.honored === 'boolean';
  }
  return r.kind === 'refused' && REFUSAL_REASONS.includes(r.reason as PusherRefusalReason);
}

export function isPusherDoorResult(v: unknown): v is PusherDoorResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { kind?: unknown; requestId?: unknown; emptied?: unknown; atMs?: unknown };
  if (!isBoundedId(r.requestId) || !isTimestamp(r.atMs)) return false;
  if (r.kind === 'opened') return isCountInt(r.emptied) && (r.emptied as number) <= MACHINE_MAX_CHIPS;
  return r.kind === 'refused';
}

/** Shape guard for a peer-written coin-pusher state. Everything the engine
 *  and UI dereference is checked, including the aggregate chip ceiling and
 *  the machine's own ledger (an operator never writes a state that doesn't
 *  balance, so one that doesn't is not a machine); a rejection means readers
 *  see no machine. Unknown extra fields are ignored (normalizeCoinPusherState
 *  drops them). */
export function isCoinPusherState(v: unknown): v is CoinPusherState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<CoinPusherState>;
  if (!(s.kind === 'coin-pusher'
    && isBoundedId(s.ownerId)
    && isPileArray(s.upper, PLAT_UP_BACK, PLAT_UP_FRONT)
    && isPileArray(s.lower, PLAT_LOW_BACK, PLAT_LOW_FRONT)
    && isCountInt(s.nextChipId)
    && isPhase(s.pusherPhase)
    && isTimestamp(s.pusherAtMs)
    && isCountInt(s.tick)
    && isCountInt(s.totalInserted)
    && isCountInt(s.totalPaid)
    && isCountInt(s.totalEmptied)
    && (s.lastDrop === undefined || isLastDrop(s.lastDrop))
    && (s.recentDrops === undefined || isRecentDrops(s.recentDrops, s.nextChipId as number)))) return false;
  let chips = 0;
  for (const p of s.upper as Pile[]) chips += p.count;
  for (const p of s.lower as Pile[]) chips += p.count;
  return chips <= MACHINE_MAX_CHIPS
    && s.totalInserted === chips + (s.totalPaid as number) + (s.totalEmptied as number);
}

/** A guarded state with only the known fields — what the operator publishes
 *  (a field an earlier revision wrote, or a peer smuggled in, is dropped). */
export function normalizeCoinPusherState(v: unknown): CoinPusherState | null {
  if (!isCoinPusherState(v)) return null;
  const out: CoinPusherState = {
    kind: 'coin-pusher',
    ownerId: v.ownerId,
    upper: copyPiles(v.upper),
    lower: copyPiles(v.lower),
    nextChipId: v.nextChipId,
    pusherPhase: v.pusherPhase,
    pusherAtMs: v.pusherAtMs,
    tick: v.tick,
    totalInserted: v.totalInserted,
    totalPaid: v.totalPaid,
    totalEmptied: v.totalEmptied,
  };
  if (v.lastDrop) {
    const d = v.lastDrop;
    out.lastDrop = {
      requestId: d.requestId, player: d.player, hole: d.hole, chipId: d.chipId,
      landedX: d.landedX, paid: d.paid, phase: d.phase, honored: d.honored, atMs: d.atMs,
    };
  }
  if (v.recentDrops) {
    out.recentDrops = v.recentDrops.map((d) => ({ chipId: d.chipId, hole: d.hole }));
  }
  return out;
}

/**
 * The holes of the settled drops a viewer hasn't shown yet, oldest first:
 * every recent drop whose chip is at or past `shownUpTo`, the machine's
 * `nextChipId` when the viewer last looked. (A new machine's chip ids start
 * again below it, so none of its drops counts until the viewer looks again.)
 */
export function unseenDropHoles(state: CoinPusherState, shownUpTo: number): PusherHole[] {
  return (state.recentDrops ?? []).filter((d) => d.chipId >= shownUpTo).map((d) => d.hole);
}

export function isPusherInsertRequest(v: unknown): v is PusherInsertRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<PusherInsertRequest>;
  return isBoundedId(r.requestId) && isBoundedId(r.player) && isHole(r.hole)
    && isPhase(r.phase)
    && isTimestamp(r.requestedAt);
}

export function isPusherEmptyRequest(v: unknown): v is PusherEmptyRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<PusherEmptyRequest>;
  return isBoundedId(r.requestId) && isBoundedId(r.requester)
    && isTimestamp(r.requestedAt);
}

// ── Initial state factory ────────────────────────────────────────────────────

export function initialCoinPusherState(ownerId: string, nowMs = 0): CoinPusherState {
  if (!isBoundedId(ownerId)) {
    throw new RangeError('initialCoinPusherState: ownerId must be a bounded non-empty string');
  }
  return {
    kind: 'coin-pusher',
    ownerId,
    upper: [],
    lower: [],
    nextChipId: 1,
    pusherPhase: 0,
    pusherAtMs: isTimestamp(nowMs) ? nowMs : 0,
    tick: 0,
    totalInserted: 0,
    totalPaid: 0,
    totalEmptied: 0,
  };
}

// ── Pure math helpers ────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mod1(v: number): number {
  const r = v - Math.floor(v);
  // Guard the exact-1.0 float-rounding edge (belt-and-braces for negative dt too).
  return r < 0 ? r + 1 : r >= 1 ? 0 : r;
}

/**
 * Cheap non-cryptographic hash (FNV-1a 32-bit) over integer inputs — feeds
 * the peg field's left/right choice. Chip trajectories only need to be
 * deterministic and well-distributed, not unbiasable; there is no adversarial
 * incentive to grind peg outcomes when the drop is the player's choice
 * (the seed comes from the operator on accept).
 */
export function hashInts(...ns: number[]): number {
  let h = 2166136261 >>> 0;
  for (const n of ns) {
    let x = (n | 0) >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

/**
 * Sweep pusher's FRONT-FACE position at a given phase p ∈ [0, 1). A
 * cosine profile gives smooth acceleration at both ends; the front-face
 * lags the geometric centre of the sweep bar by exactly its half-thickness
 * (which we bake into the display layer, not here).
 */
export function pusherFaceX(phase: number): number {
  const p = mod1(phase);
  return PUSHER_MIN_X + (PUSHER_MAX_X - PUSHER_MIN_X) * (0.5 - 0.5 * Math.cos(2 * Math.PI * p));
}

// ── Piles: settle, insert, push ──────────────────────────────────────────────

/**
 * Return a defensive copy of a pile so callers can mutate freely without
 * aliasing peer-shared arrays. The engine keeps state immutable per call.
 */
function copyPile(p: Pile): Pile {
  return { x: p.x, count: p.count, chipIds: [...p.chipIds] };
}

function copyPiles(ps: Pile[]): Pile[] {
  return ps.map(copyPile);
}

/**
 * Re-order and de-overlap a platform's piles. Chips CANNOT overlap
 * horizontally: after any mutation we sort by x and enforce
 * pile[i+1].x >= pile[i].x + PILE_STEP. Any pile shoved past `frontEdge`
 * FALLS off the front — returned in `fallen` for the caller to route
 * (upper→lower, or lower→payout tray).
 *
 * A `leftConstraint` may pin the leftmost pile to at least that x, e.g. when
 * the sweep pusher's front face limits how far back the first pile can sit.
 */
export function settlePiles(
  piles: Pile[],
  leftConstraint: number,
  frontEdge: number,
): { piles: Pile[]; fallen: Pile[] } {
  const sorted = copyPiles(piles).sort((a, b) => a.x - b.x);
  let cursor = leftConstraint;
  for (const p of sorted) {
    if (p.x < cursor) p.x = cursor;
    cursor = p.x + PILE_STEP;
  }
  // A pile falls when its CENTRE has passed the front edge — that matches
  // the spec's "centre of gravity determines when a chip tips off". The
  // engine does not micro-model the tip animation; the transition is atomic.
  const remaining: Pile[] = [];
  const fallen: Pile[] = [];
  for (const p of sorted) {
    if (p.x > frontEdge) fallen.push(p);
    else remaining.push(p);
  }
  return { piles: remaining, fallen };
}

/**
 * Add chips at `landX` to a platform, merging with a pile within one chip
 * diameter (they stack), else opening a new pile. Chips landing on a stack
 * press the contact chain ahead of it forward, and either way a column taller
 * than MAX_STACK_HEIGHT spills forward (the cascade rules in the spec). A
 * settle pass then evicts anything pushed past the front edge.
 */
export function insertOnPlatform(
  piles: Pile[],
  landX: number,
  chipIds: number[],
  frontEdge: number,
): { piles: Pile[]; fallen: Pile[] } {
  if (chipIds.length === 0) return { piles: copyPiles(piles), fallen: [] };

  const merged = copyPiles(piles);
  // Find a pile whose centre is within a chip diameter — that's a physical
  // stack (chip stacks on top of chip). Snap tolerance ≤ CHIP_R keeps two
  // near-neighbour piles from being spuriously merged.
  const idx = merged.findIndex((p) => Math.abs(p.x - landX) <= CHIP_R);
  let landed: Pile;
  if (idx >= 0) {
    landed = merged[idx];
    landed.count += chipIds.length;
    landed.chipIds = [...landed.chipIds, ...chipIds];
    merged.sort((a, b) => a.x - b.x);
    const landedIdx = merged.indexOf(landed);

    // (A) CONTACT IMPULSE. The falling chips deliver a horizontal impulse
    //     to the underlying stack (via each disc's spin from the peg
    //     bounce). The impulse shoves the CONTACT CHAIN ahead of the
    //     landing pile forward by a small distance proportional to landed
    //     weight. What *breaks* the cascade is a gap larger than one chip
    //     diameter — no contact, no transmission.
    const shove = chipIds.length * CHIP_R * 0.5;
    for (let i = landedIdx + 1; i < merged.length; i++) {
      const gap = merged[i].x - merged[i - 1].x;
      if (gap > PILE_STEP + 1e-9) break;
      merged[i].x += shove;
    }
  } else {
    landed = { x: landX, count: chipIds.length, chipIds: [...chipIds] };
    merged.push(landed);
    merged.sort((a, b) => a.x - b.x);
  }

  // (B) COLUMN OVERFLOW (spill cascade), for a new pile as for a stack — a
  //     multi-chip pile can fall onto open floor. Chip columns are physically
  //     unstable past ~MAX_STACK_HEIGHT chips: the top chip slides forward
  //     onto the next column. If the next column is also full, it spills
  //     further, and the chain propagates until the excess finds a
  //     partially-filled column or FALLS off the front edge. Combined with
  //     the pusher's steady forward stroke on the upper platform, this is the
  //     primary path that puts chips into the payout tray.
  let cur = merged.indexOf(landed);
  // Safety cap: an unbounded loop here would burn the physics substep.
  // Even a fully-packed platform (~10 columns × MAX_STACK_HEIGHT) yields
  // a chain-length far below this ceiling.
  for (let safety = 0; safety < PLATFORM_MAX_PILES * 4; safety++) {
    if (merged[cur].count <= MAX_STACK_HEIGHT) break;
    const overflow = merged[cur].count - MAX_STACK_HEIGHT;
    const overflowIds = merged[cur].chipIds.splice(MAX_STACK_HEIGHT, overflow);
    merged[cur].count = MAX_STACK_HEIGHT;
    const spillX = merged[cur].x + PILE_STEP;
    // Look for a spill target within one chip radius of the spillX.
    let spillTarget = -1;
    for (let i = 0; i < merged.length; i++) {
      if (i !== cur && Math.abs(merged[i].x - spillX) <= CHIP_R) {
        spillTarget = i;
        break;
      }
    }
    if (spillTarget >= 0) {
      merged[spillTarget].count += overflow;
      merged[spillTarget].chipIds.push(...overflowIds);
      cur = spillTarget;
    } else {
      merged.push({ x: spillX, count: overflow, chipIds: overflowIds });
      cur = merged.length - 1;
    }
  }

  // A final settle pass: it catches the edge case where a landing pile
  // opens BEHIND an existing pile that must be re-anchored to a valid x,
  // and evicts any pile whose centre is now past the front edge.
  return settlePiles(merged, -Infinity, frontEdge);
}

// ── Peg deflection ───────────────────────────────────────────────────────────

/**
 * Deterministic peg deflection: given a hole index, the pusher PHASE at the
 * drop ∈ [0, 1) (the player's timing — see resolveDropTiming), and a seed,
 * walk the chip through PEG_ROWS binary left/right choices to arrive at a
 * landing x on the upper platform. This is the ONLY randomness in chip motion
 * — everything downstream is a rigid-body slide.
 */
export function simulatePeg(hole: PusherHole, timing: number, seed: number): number {
  const t = Number.isFinite(timing) ? clamp(timing, 0, 1) : 0.5;
  const holeX = HOLE_XS[hole];
  // Quantise timing to 1000 buckets — this is what feeds the hash. Two very
  // close timings collapse into the same trajectory (they are otherwise
  // indistinguishable to the player), while distinct timings deflect
  // differently, which keeps the drop "readable".
  const timingBucket = Math.min(999, Math.max(0, Math.floor(t * 1000)));
  let x = holeX + (t - 0.5) * 2 * TIMING_OFFSET;
  for (let row = 0; row < PEG_ROWS; row++) {
    const h = hashInts(seed >>> 0, hole, timingBucket, row);
    // Use a well-mixed high bit — FNV-1a's LSB is XOR of input LSBs
    // (odd prime multiply preserves LSB), giving a biased walk for small
    // integer inputs. Bit 24 sits in the top byte after every mix step.
    const bit = (h >>> 24) & 1;
    x += (bit ? +1 : -1) * PEG_DEFLECTION;
  }
  return x;
}

// ── Physics step & insertion ─────────────────────────────────────────────────

/**
 * Advance the pusher by `dtMs`, push any contacted upper piles forward,
 * cascade any upper piles that spill onto the lower platform, and pay
 * out any lower piles that spill off the front. Pure — returns a fresh
 * state and the count/ids of paid chips this step.
 *
 * The physics DOES NOT ATTRIBUTE payout to a player; that is a decision
 * for the caller (usually the current insert's owner) since chips paid
 * from ambient pusher motion (very small — the pusher only pushes chips
 * over the edge if there are already chips at the edge) are still "won"
 * by the player whose insert triggered the step.
 */
export function stepMachine(
  state: CoinPusherState,
  dtMs: number,
): { state: CoinPusherState; paidChipIds: number[]; upperFallen: number; } {
  if (!(dtMs > 0) || !Number.isFinite(dtMs)) {
    // Zero/negative/NaN dt is a no-op — the wiring layer relies on this to
    // clamp jittery Date.now() diffs to safe values without special-casing.
    return { state, paidChipIds: [], upperFallen: 0 };
  }

  const span = dtMs / PUSHER_PERIOD_MS;
  const newPhase = mod1(state.pusherPhase + span);
  // The furthest the front face reached during this substep: the full
  // extension if the substep swept through phase ½, else the further end.
  // (A retracting pusher does not DRAG piles backward, so the constraint is
  // this maximum, never the current face.) Taking the true maximum rather
  // than the substep endpoints means one full cycle compresses the piles all
  // the way, so the machine is exactly at rest afterwards.
  const reach = mod1(0.5 - state.pusherPhase) <= span
    ? PUSHER_MAX_X
    : Math.max(pusherFaceX(newPhase), pusherFaceX(state.pusherPhase));
  const constraint = reach + CHIP_R;

  const upperResult = settlePiles(state.upper, constraint, PLAT_UP_FRONT);
  let upper = upperResult.piles;
  let lower = copyPiles(state.lower);
  const paidChipIds: number[] = [];

  for (const fallenPile of upperResult.fallen) {
    // Falling pile lands on the lower platform at (roughly) the same x —
    // clamped to lower-platform reach so a pile can't fall through a wall.
    const lowerLandX = clamp(fallenPile.x, PLAT_LOW_BACK + CHIP_R, PLAT_LOW_FRONT - CHIP_R);
    const landing = insertOnPlatform(lower, lowerLandX, fallenPile.chipIds, PLAT_LOW_FRONT);
    lower = landing.piles;
    for (const p of landing.fallen) {
      paidChipIds.push(...p.chipIds);
    }
  }

  const nextState: CoinPusherState = {
    ...state,
    upper,
    lower,
    pusherPhase: newPhase,
    pusherAtMs: state.pusherAtMs + dtMs,
    tick: state.tick + 1,
    totalPaid: state.totalPaid + paidChipIds.length,
  };
  return { state: nextState, paidChipIds, upperFallen: upperResult.fallen.length };
}

/**
 * Advance the machine by `elapsedMs` in fixed PHYSICS_SUBSTEP_MS substeps.
 * Returns the chips that fell off the lower front (`totalPaid` is bumped for
 * them); whoever caused the run decides who they are paid to. Used by
 * processInsert's settle and by tests / dev inspection — the operator never
 * runs physics on its own (the machine is at rest between drops).
 */
export function advanceSim(
  state: CoinPusherState,
  elapsedMs: number,
): { state: CoinPusherState; paidChipIds: number[] } {
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) {
    return { state, paidChipIds: [] };
  }
  const substeps = Math.max(1, Math.ceil(elapsedMs / PHYSICS_SUBSTEP_MS));
  const dtPer = elapsedMs / substeps;
  let cur = state;
  const allPaid: number[] = [];
  for (let i = 0; i < substeps; i++) {
    const r = stepMachine(cur, dtPer);
    cur = r.state;
    allPaid.push(...r.paidChipIds);
  }
  return { state: cur, paidChipIds: allPaid };
}

/** How far (ms of pusher travel) a claimed phase may sit from the pusher's
 *  phase at the claimed time and still be that phase — rounding room only: an
 *  honest panel computes it with this same function from the same anchor. */
export const DROP_PHASE_MATCH_MS = 1;

/**
 * The drop's timing: which pusher phase the chip falls at.
 *
 * The player's request carries the phase that was on their screen when they
 * pressed DROP and the time they pressed it, by their clock
 * (`claimedAtMs`). It reaches the operator a little later (sync + drain), by
 * which time the pusher has moved on. `lagMs` is that delay measured
 * absolutely: the operator's clock at `receivedAtMs` less the claimed time
 * (negative when the claim is ahead — a player clock running fast). The claim
 * is kept, and the chip falls at exactly the phase the player saw, when:
 *   • the claimed phase is the pusher's phase at the claimed time (so the
 *     claim names one moment, not a phase that recurs every cycle), and
 *   • `lagMs` is inside [−maxLeadMs, maxLagMs].
 * Comparing phases alone would take a request one or more whole cycles old for
 * a fresh one. Anything else (a stale request, a phase that wasn't on screen
 * at that moment, junk) falls at the operator's current phase, so it gains
 * nothing. Browser clocks aren't synchronised: a device whose clock is off by
 * more than the window never has its timing kept, and is told so.
 */
export function resolveDropTiming(
  state: CoinPusherState,
  claimedPhase: number,
  claimedAtMs: number,
  receivedAtMs: number,
  maxLagMs: number = MAX_DROP_LAG_MS,
  maxLeadMs: number = MAX_DROP_LEAD_MS,
): { dropPhase: number; honored: boolean; lagMs: number } {
  const nowPhase = currentPusherPhase(state, receivedAtMs);
  if (!isPhase(claimedPhase) || !isTimestamp(claimedAtMs) || !isTimestamp(receivedAtMs)) {
    return { dropPhase: nowPhase, honored: false, lagMs: NaN };
  }
  const lagMs = receivedAtMs - claimedAtMs;
  // Signed distance in (−½, ½] of a cycle between the claim and the pusher's
  // phase at the claimed time.
  const mismatch = mod1(claimedPhase - currentPusherPhase(state, claimedAtMs) + 0.5) - 0.5;
  if (Math.abs(mismatch) * PUSHER_PERIOD_MS <= DROP_PHASE_MATCH_MS
    && lagMs <= maxLagMs && -lagMs <= maxLeadMs) {
    return { dropPhase: claimedPhase, honored: true, lagMs };
  }
  return { dropPhase: nowPhase, honored: false, lagMs };
}

/**
 * Drop one chip through `hole` at pusher phase `dropPhase` (see
 * resolveDropTiming), then run SETTLE_MS of pusher motion so the drop plays
 * out and the machine comes back to rest. Returns the new state and `paid`:
 * the chips this drop knocked into the payout tray, which the operator
 * credits to `playerId` in the same transaction that debits their
 * PUSHER_ANTE chip (casinoDoc.settleCoinPusherInsert).
 *
 * The published sweep anchor (pusherPhase, pusherAtMs) comes back unchanged:
 * the physics runs from `dropPhase` internally, and the free-running pusher
 * every client draws never jumps.
 *
 * Throws RangeError on a bad player id / hole / phase, and when the machine
 * is already holding MACHINE_MAX_CHIPS (the operator refuses the request
 * without moving money).
 */
export function processInsert(
  state: CoinPusherState,
  playerId: string,
  hole: PusherHole,
  dropPhase: number,
  seed: number,
): {
  state: CoinPusherState;
  paid: number;
  paidChipIds: number[];
  landedX: number;
  chipId: number;
} {
  if (!isBoundedId(playerId)) {
    throw new RangeError('processInsert: playerId must be a bounded non-empty string');
  }
  if (!isHole(hole)) throw new RangeError('processInsert: hole must be 0, 1 or 2');
  if (!isPhase(dropPhase)) throw new RangeError('processInsert: dropPhase must be in [0, 1)');
  if (chipsInMachine(state) + PUSHER_ANTE > MACHINE_MAX_CHIPS) {
    throw new RangeError('processInsert: the machine is full');
  }

  // 1. The pusher stands at the player's phase when the chip lands. The
  //    machine is at rest (a full cycle settled after the last drop), so any
  //    phase is consistent with the piles: none sits inside the pusher's
  //    reach, whatever its position.
  let cur: CoinPusherState = { ...state, pusherPhase: dropPhase };

  // 2. The chip falls through the peg field (deterministic) onto the upper
  //    platform.
  const rawLandX = simulatePeg(hole, dropPhase, seed);
  const landedX = clamp(rawLandX, PLAT_UP_BACK + CHIP_R, PLAT_UP_FRONT - CHIP_R);
  const chipId = cur.nextChipId;
  const inserted = insertOnPlatform(cur.upper, landedX, [chipId], PLAT_UP_FRONT);

  // 3. Anything the landing itself tips off the upper front lands on the
  //    lower platform and may cascade off its front (rare — needs a full
  //    front row). Route the same way stepMachine does.
  let lower = copyPiles(cur.lower);
  const instantPaid: number[] = [];
  for (const fallenPile of inserted.fallen) {
    const lowerLandX = clamp(fallenPile.x, PLAT_LOW_BACK + CHIP_R, PLAT_LOW_FRONT - CHIP_R);
    const landing = insertOnPlatform(lower, lowerLandX, fallenPile.chipIds, PLAT_LOW_FRONT);
    lower = landing.piles;
    for (const p of landing.fallen) instantPaid.push(...p.chipIds);
  }

  cur = {
    ...cur,
    upper: inserted.piles,
    lower,
    nextChipId: cur.nextChipId + 1,
    totalInserted: cur.totalInserted + PUSHER_ANTE,
    totalPaid: cur.totalPaid + instantPaid.length,
    tick: cur.tick + 1,
  };

  // 4. One full pusher cycle: the drop plays out and the machine comes to
  //    rest. stepMachine bumps totalPaid for everything that falls.
  const settled = advanceSim(cur, SETTLE_MS);
  const paidChipIds = [...instantPaid, ...settled.paidChipIds];

  // 5. Hand back the untouched sweep anchor (see the doc comment).
  cur = { ...settled.state, pusherPhase: state.pusherPhase, pusherAtMs: state.pusherAtMs };

  return { state: cur, paid: paidChipIds.length, paidChipIds, landedX, chipId };
}

// ── Owner-only door: empty the machine ───────────────────────────────────────

/**
 * The owner opens the machine door and takes all chips inside. This is the
 * ONLY path that removes chips from the machine besides paying them out to
 * the player whose drop pushed them; per the issue there is NO auto-siphon.
 * A non-owner call returns `ok: false` and leaves state UNCHANGED.
 *
 * The operator commits the money side: publish the new state AND credit the
 * owner `emptied` chips in ONE transaction (casinoDoc.commitCoinPusherEmpty).
 * Conservation holds: chipsInMachine → 0 and totalEmptied grows by the same.
 */
export function emptyMachine(
  state: CoinPusherState,
  requesterId: string,
): { state: CoinPusherState; emptied: number; ok: boolean } {
  if (requesterId !== state.ownerId) {
    return { state, emptied: 0, ok: false };
  }
  const emptied = chipsInMachine(state);
  const next: CoinPusherState = {
    ...state,
    upper: [],
    lower: [],
    totalEmptied: state.totalEmptied + emptied,
    tick: state.tick + 1,
  };
  return { state: next, emptied, ok: true };
}

// ── Conservation invariant (public — dev tools + tests both use this) ────────

export interface Conservation {
  chipsInMachine: number;
  totalInserted: number;
  totalPaid: number;
  totalEmptied: number;
  /** True iff totalInserted === chipsInMachine + totalPaid + totalEmptied. */
  balanced: boolean;
}

/** Compute the conservation snapshot. Every mutating helper preserves this. */
export function computeConservation(state: CoinPusherState): Conservation {
  const inMachine = chipsInMachine(state);
  return {
    chipsInMachine: inMachine,
    totalInserted: state.totalInserted,
    totalPaid: state.totalPaid,
    totalEmptied: state.totalEmptied,
    balanced: state.totalInserted === inMachine + state.totalPaid + state.totalEmptied,
  };
}

// ── Read-only introspection (UI) ─────────────────────────────────────────────

/** Chips currently inside the machine (both platforms). */
export function chipsInMachine(state: CoinPusherState): number {
  let n = 0;
  for (const p of state.upper) n += p.count;
  for (const p of state.lower) n += p.count;
  return n;
}

/** The pusher's phase at `nowMs` from the stored sweep anchor. The sweep is
 *  a line through (pusherAtMs, pusherPhase) in both directions, so a time
 *  before the anchor (another client's clock running behind) still gets its
 *  true phase. The engine never calls Date.now(); callers pass the time in. */
export function currentPusherPhase(state: CoinPusherState, nowMs: number): number {
  if (!isTimestamp(nowMs)) return state.pusherPhase;
  return mod1(state.pusherPhase + (nowMs - state.pusherAtMs) / PUSHER_PERIOD_MS);
}
