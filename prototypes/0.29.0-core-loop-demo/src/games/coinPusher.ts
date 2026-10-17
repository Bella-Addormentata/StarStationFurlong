/**
 * 🪙 Coin pusher — the pure engine (issue #135).
 *
 * A single-machine arcade coin pusher: the player picks one of three DROP
 * HOLES along the top of a vertical DROP BOARD and TIMES the drop against the
 * sweeping pusher on the upper platform. The coin falls down the board,
 * bouncing off its pegs and side rails the way the air hockey puck bounces,
 * leaves through the bottom and lands STANDING ON ITS EDGE just in front of
 * the pusher bar, at the spot across the table where it left the board. It
 * stands there until something pushes it — the bar, or a pile shoved into
 * it — and then tips forward onto its face. Chips are shoved toward the front
 * edge by the pusher, stack, cascade, tip off the upper edge onto the LOWER
 * platform, and — pushed by the chips behind them — finally tip off the front
 * of the lower platform into the payout tray. Only chips that fall off the
 * FRONT of the LAST PLATFORM are paid out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE DISCIPLINE
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is PURE (no Yjs / DOM / THREE / wall-clock / Math.random), the
 * same layering contract as games/checkers.ts, games/craps.ts, games/slots.ts.
 * All randomness is derived by a stable non-cryptographic hash from a caller-
 * provided seed + (hole, drop phase), so a peer with the same seed reproduces
 * the exact chip trajectory (traceDrop: every cabinet replays each drop from
 * the seed the operator publishes with it). All time enters as explicit
 * milliseconds — the wiring layer reads the clock. Doc I/O is in casinoDoc.ts,
 * the operator in pusherCroupier.ts, UI/scene wiring in devices.ts and
 * furniture.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHYSICS MODEL — a table seen from above, a board seen from the front
 * ─────────────────────────────────────────────────────────────────────────────
 * The table has a back-to-front axis x and an across axis u. Two stepped
 * platforms sit on it:
 *
 *      UPPER PLATFORM ────  x ∈ [PLAT_UP_BACK, PLAT_UP_FRONT]
 *      LOWER PLATFORM ──────  x ∈ [PLAT_LOW_BACK, PLAT_LOW_FRONT]  (in front)
 *
 * A "pile" is a vertical stack of chips at one (x, u). Piles move only
 * FORWARD, never sideways, and never overlap: a settlement pass enforces it
 * on every mutation, so a peer-written state that arrives with overlap is
 * re-settled before a physics step, which keeps the engine total (it never
 * diverges). A chip standing on its edge is a pile of one, a slab CHIP_T deep
 * across the table; anything that moves it tips it flat.
 *
 * Only the UPPER platform has an active pusher (the sweep bar, the table's
 * full width); the LOWER platform is driven by the weight of chips landing on
 * it from above (each falling pile shoves the piles it touches forward, and
 * the shove propagates through any abutting piles ahead — the CASCADE
 * mechanic of the issue).
 *
 * Sweep pusher: a cosine oscillation with period PUSHER_PERIOD_MS. Only the
 * FORWARD half imparts force (a retracting pusher does not drag chips back).
 * One full cycle compresses the piles as far as the pusher can reach, so a
 * second cycle moves nothing: the machine is at rest between inserts, and the
 * physics only runs when a chip is dropped (processInsert settles a full cycle
 * after every landing). Nothing leaves the machine on its own. A coin that
 * lands while the bar is all the way forward is never reached by it, and
 * stays standing until another drop's chips push it.
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

// ── Physical constants (engine units, millis) ────────────────────────────────
//
// The table has two axes. x runs BACK → FRONT of the cabinet: origin (x=0) is
// the back wall of the upper platform and positive x goes towards the payout
// tray. u runs ACROSS it, left to right as the player sees it, 0 on the centre
// line. Both platforms share both axes (the lower one is IN FRONT of the
// upper, one geometric step down in height that the engine ignores):
//
//     x=0.00                  0.60                  1.20
//       ├──── UPPER ─────────┼──── LOWER ──────────┤
//       ▓ pusher                                     ▐ payout
//       ▓  rest  →  extends to 0.51    ...           ▐  tray
//
// A chip pushed past x=0.60 tips off the upper front and lands on the back of
// the lower at the same u. Chips pushed past x=1.20 tip off the front of the
// lower and are paid out to the player whose drop moved them. Nothing moves
// sideways on the table: a chip keeps the u the drop board gave it.
//
// The drop board is a vertical plane above the back of the upper platform,
// facing the player: its own axes are u (shared with the table) and h, the
// height above the board's bottom edge.

/** One chip's radius (its diameter is two of them). */
export const CHIP_R = 0.030;
/** A chip's thickness: how much depth a chip standing on its edge takes up. */
export const CHIP_T = 0.008;
/** Contact spacing between two flat piles on the same line. */
export const PILE_STEP = 2 * CHIP_R;

/** Upper platform x extent (back edge = pusher rest, front edge = drop-off). */
export const PLAT_UP_BACK = 0.00;
export const PLAT_UP_FRONT = 0.60;
/** Lower platform x extent — starts where upper ends (same front lip). */
export const PLAT_LOW_BACK = 0.60;
export const PLAT_LOW_FRONT = 1.20;

/** Half the table's width (and the drop board's): rails at u = ±FIELD_HALF_W. */
export const FIELD_HALF_W = 0.21;
/** Furthest a chip's centre sits from the centre line. */
export const U_MAX = FIELD_HALF_W - CHIP_R;

/** Pusher (sweep bar) travel. The front face moves from `MIN_X` (retracted
 *  at the back wall) to `MAX_X` (extended nearly to the upper front — the
 *  gap leaves room for ~1½ pile widths of front cushion). The bar spans the
 *  table's full width. */
export const PUSHER_MIN_X = PLAT_UP_BACK;
export const PUSHER_MAX_X = PLAT_UP_FRONT - PILE_STEP * 1.5; // 0.51
/** One complete forward-and-back cycle of the sweep bar (ms). */
export const PUSHER_PERIOD_MS = 2400;

/** Fixed substep for the pusher-driven physics — small enough that the front
 *  face moves ≪ CHIP_R per substep at peak velocity, so cascades resolve
 *  without tunnelling through piles. */
export const PHYSICS_SUBSTEP_MS = 40;

/** Pusher motion simulated after each chip LANDS (one full period + one
 *  substep), so the drop interacts with every pile the pusher can reach and
 *  the machine comes back to rest. */
export const SETTLE_MS = PUSHER_PERIOD_MS + PHYSICS_SUBSTEP_MS;

/** How far one drop moves the machine's `tick`: one for the insert, then one
 *  for every substep of the settling cycle (advanceSim). */
export const TICKS_PER_DROP = 1 + Math.max(1, Math.ceil(SETTLE_MS / PHYSICS_SUBSTEP_MS));

/** Chips per insert. A coin pusher takes one coin per drop; the money side
 *  (casinoDoc.settleCoinPusherInsert) debits exactly this. */
export const PUSHER_ANTE = 1;

/** Physical stability cap on a chip column. When a landing pushes a column
 *  past this, the excess SPILLS forward to the pile ahead (which may itself
 *  spill, chain-cascading toward the front) — the issue's "groups of chips
 *  fall together, or off the front of a group". */
export const MAX_STACK_HEIGHT = 4;

// ── The drop board ───────────────────────────────────────────────────────────
//
// A coin drops into one of three holes along the top of the board and falls
// down it under gravity, bouncing off a staggered field of pegs and the two
// side rails the way the air hockey puck bounces off mallets and rails
// (games/airHockey.ts stepPuck: push out along the contact normal, reflect
// the approach velocity with restitution). It leaves through the open bottom
// edge, drops the short CHUTE onto the upper platform, and lands STANDING ON
// ITS EDGE, face to the player, just in front of the pusher bar wherever the
// bar is at that moment. It stays standing until something pushes it, then
// tips forward onto its face.
//
// The board is integrated with + − × ÷ and √ only, which IEEE 754 makes
// exact everywhere, so every peer that replays a drop (traceDrop) gets the
// same path the operator settled.

/** Board height: from its bottom edge (h=0) to the holes (h=BOARD_H). */
export const BOARD_H = 0.80;
/** Peg radius. */
export const PEG_R = 0.010;
/** Centre-to-centre spacing of the pegs in a row: a coin (2·CHIP_R) passes
 *  between two (spacing − 2·PEG_R = 0.08 > 0.06), with room to rattle. */
export const PEG_SPACING = 0.10;
/** Rows of pegs and their vertical pitch. */
export const PEG_ROWS = 6;
export const PEG_ROW_PITCH = 0.11;
/** Height of the top peg row: a coin falls a little before its first bounce. */
export const PEG_TOP_H = BOARD_H - 0.12;

/** The peg field: rows alternate between pegs on the centre line and pegs
 *  half a spacing off it (a Galton board), never closer to a rail than a
 *  coin can pass. */
export const BOARD_PEGS: readonly { u: number; h: number }[] = (() => {
  const pegs: { u: number; h: number }[] = [];
  for (let row = 0; row < PEG_ROWS; row++) {
    const h = PEG_TOP_H - row * PEG_ROW_PITCH;
    const offset = row % 2 === 0 ? 0 : PEG_SPACING / 2;
    let outer = 0;
    for (let k = -4; k <= 4; k++) {
      const u = offset + k * PEG_SPACING;
      if (Math.abs(u) + PEG_R > FIELD_HALF_W - 2 * CHIP_R) continue;
      pegs.push({ u, h });
      outer = Math.max(outer, Math.abs(u));
    }
    // A bump on each rail, so a coin can't slide all the way down a rail —
    // it is turned back into the field — on the rows where a coin still
    // passes between the bump and the row's outer peg (elsewhere the two
    // would wedge it).
    if (FIELD_HALF_W - outer - PEG_R >= 2 * CHIP_R) {
      const bump = FIELD_HALF_W - PEG_R + 0.002;
      pegs.push({ u: -bump, h }, { u: bump, h });
    }
  }
  return pegs;
})();

/** The three holes along the top of the board (0 = left, 1 = centre,
 *  2 = right as the player sees it). */
export const HOLE_US: readonly number[] = [-0.12, 0, 0.12] as const;
export const HOLE_COUNT = HOLE_US.length;

/** The board's own gravity (units/s²): the board leans back a little, so a
 *  coin falls slower than free fall and the bounces are easy to follow. */
export const BOARD_GRAVITY = 4.0;
/** Bounciness off a peg and off a side rail (restitution on the normal
 *  velocity, as the air hockey puck's mallet and rail bounces). A coin is
 *  deader than a puck. */
export const PEG_RESTITUTION = 0.3;
export const BOARD_RAIL_RESTITUTION = 0.5;
/** Least sideways speed a coin leaves a peg with (units/s). */
export const PEG_KICK = 0.12;
/** Fixed integration step of the board (ms). At the fastest a coin falls
 *  here (≈1.3 units/s) it moves ≈5 mm a step, well under a peg contact. */
export const BOARD_STEP_MS = 4;
/** A coin still on the board after this long (balanced on a peg, say) is let
 *  out where it is: the board never holds a drop up. */
export const BOARD_MAX_MS = 6000;
/** From the board's bottom edge down the chute onto the upper platform. */
export const CHUTE_MS = 160;
/** A coin that lands with the bar's face within this of its furthest reach
 *  lands on its lip and slides off ahead of it: the bar never reaches it,
 *  and it stays standing until another drop's chips push it over. */
export const LIP_SLIDE = 0.012;
/** Spacing of the samples traceDrop keeps of the board path (ms). */
export const BOARD_SAMPLE_MS = 16;

/** Most the drop's seed moves the coin off its hole as it goes in, and how
 *  fast it may start sideways: the bounces do the rest. */
const ENTRY_JITTER = 0.010;
const ENTRY_SPIN = 0.06;

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
 *  than this since it arrived in the operator's doc, measured on its own
 *  clock: the tail of a flood it is still working through. A request's own time (`requestedAt`) is
 *  the player's clock, so it decides only whether the drop's timing is kept;
 *  a device whose clock is off still plays. */
export const PUSHER_STALE_REQUEST_MS = 120_000;

/** Most chips the cabinet can physically hold. This is the guard's aggregate
 *  ceiling (a peer state above it is rejected, so the renderer's per-chip
 *  meshes stay bounded) and the point at which processInsert refuses a drop.
 *  An honest machine settles far below it. */
export const MACHINE_MAX_CHIPS = 256;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A vertical stack of chips at one spot (x, u) on a platform. `chipIds` is
 * bottom-to-top and its length is the source of truth for `count`; the guard
 * enforces the equality so peer states that disagree between the two are
 * rejected. A `standing` pile is one chip on its edge, face to the player,
 * that nothing has pushed yet.
 */
export interface Pile {
  x: number;
  u: number;
  count: number;
  chipIds: number[];
  standing?: true;
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
  /** Where the chip landed: depth along the upper platform… */
  landedX: number;
  /** …and across it (absent on a drop settled before the drop board). */
  landedU?: number;
  /** Chips this drop paid out to `player`. */
  paid: number;
  /** The pusher phase the chip went into the hole at. */
  phase: number;
  /** True when that is the phase the player saw (their timing was kept);
   *  false when the claim fell outside the window and the chip dropped at
   *  the operator's current phase. */
  honored: boolean;
  /** Operator clock when the drop settled. */
  atMs: number;
  /** The seed the operator drew for it: with the machine as it was before,
   *  every client replays the drop exactly (traceDrop). Absent on a drop
   *  settled before the drop board. */
  seed?: number;
}

/** One settled drop as the cabinet shows it: the hole it came through, and
 *  what replays it (traceDrop) — so a cabinet that sees several drops settle
 *  between two of its frames replays each, not just the last. */
export interface PusherDropMark {
  /** The chip it dropped (a machine's chip ids rise by one a drop). */
  chipId: number;
  hole: PusherHole;
  /** As on PusherLastDrop; absent on a mark from before the drop board. */
  phase?: number;
  atMs?: number;
  seed?: number;
}

/** What a drop is replayed from (traceDrop, dropStartMs): a PusherLastDrop
 *  or a PusherDropMark. */
export type ReplayableDrop = Pick<PusherDropMark, 'chipId' | 'hole' | 'phase' | 'atMs' | 'seed'>;

/** Settled drops the machine remembers for the cabinet (recentDrops). A poll
 *  settles at most a handful, so this covers several polls' worth landing
 *  between two frames. */
export const RECENT_DROPS_MAX = 8;

/** Why the operator turned an insert down. No chip moves on a refusal.
 *  `balance-full`: the player's balance couldn't take the most the drop could
 *  pay (it would leave the safe-integer range). `jammed`: the machine can't
 *  record the drop (its meter has run out). */
export type PusherRefusalReason = 'no-chips' | 'machine-full' | 'expired' | 'balance-full' | 'jammed';

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
 *  MAX_STACK_HEIGHT; these leave headroom for a state mid-settle while
 *  keeping a hostile peer from shipping giant arrays. MACHINE_MAX_CHIPS
 *  bounds the total across both platforms. */
const PILE_MAX_CHIPS = 2 * MAX_STACK_HEIGHT;
const PLATFORM_MAX_PILES = 160;

/** A pile on a platform spanning [lo, hi] — a settled machine never holds a
 *  pile anywhere else (anything pushed past a front edge has fallen), and the
 *  renderer maps x and u linearly, so an unbounded one would reach it as
 *  Infinity. A pile with no `u` is one a machine from before the drop board
 *  stored (every chip on the centre line); normalizeCoinPusherState puts it
 *  at u = 0. */
function isPile(v: unknown, lo: number, hi: number): v is Pile {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<Pile> & { standing?: unknown };
  if (typeof p.x !== 'number' || !Number.isFinite(p.x) || p.x < lo || p.x > hi) return false;
  if (p.u !== undefined
    && (typeof p.u !== 'number' || !Number.isFinite(p.u) || Math.abs(p.u) > U_MAX)) return false;
  if (!isCountInt(p.count) || (p.count as number) > PILE_MAX_CHIPS) return false;
  if (!Array.isArray(p.chipIds)) return false;
  if ((p.chipIds as unknown[]).length !== p.count) return false;
  for (const id of p.chipIds as unknown[]) {
    if (!isCountInt(id)) return false;
  }
  if (p.standing !== undefined && !(p.standing === true && p.count === 1)) return false;
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

/** A drop seed: an unsigned 32-bit integer. */
function isSeed(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
}

function isLastDrop(v: unknown): v is PusherLastDrop {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Partial<PusherLastDrop>;
  return isBoundedId(d.requestId) && isBoundedId(d.player) && isHole(d.hole)
    && isCountInt(d.chipId)
    && typeof d.landedX === 'number' && Number.isFinite(d.landedX)
    && (d.landedU === undefined || (typeof d.landedU === 'number' && Number.isFinite(d.landedU)))
    && isCountInt(d.paid) && (d.paid as number) <= MACHINE_MAX_CHIPS
    && isPhase(d.phase) && typeof d.honored === 'boolean'
    && isTimestamp(d.atMs)
    && (d.seed === undefined || isSeed(d.seed));
}

/** Marks of drops the machine has made: each chip id below its nextChipId. */
function isRecentDrops(v: unknown, nextChipId: number): v is PusherDropMark[] {
  return Array.isArray(v) && v.length <= RECENT_DROPS_MAX && v.every((d: unknown) => {
    if (typeof d !== 'object' || d === null) return false;
    const m = d as Partial<PusherDropMark>;
    return isCountInt(m.chipId) && (m.chipId as number) < nextChipId && isHole(m.hole)
      && (m.phase === undefined || isPhase(m.phase))
      && (m.atMs === undefined || isTimestamp(m.atMs))
      && (m.seed === undefined || isSeed(m.seed));
  });
}

const REFUSAL_REASONS: readonly PusherRefusalReason[] = ['no-chips', 'machine-full', 'expired', 'balance-full', 'jammed'];

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
 *  drops them). A machine stored before the drop board (piles with no `u`)
 *  passes: normalizeCoinPusherState lifts it. */
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
 *  and what every reader gets (a field an earlier revision wrote, or a peer
 *  smuggled in, is dropped; a pile from before the drop board gets u = 0). */
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
    if (d.landedU !== undefined) out.lastDrop.landedU = d.landedU;
    if (d.seed !== undefined) out.lastDrop.seed = d.seed;
  }
  if (v.recentDrops) {
    out.recentDrops = v.recentDrops.map((d) => {
      const mark: PusherDropMark = { chipId: d.chipId, hole: d.hole };
      if (d.phase !== undefined) mark.phase = d.phase;
      if (d.atMs !== undefined) mark.atMs = d.atMs;
      if (d.seed !== undefined) mark.seed = d.seed;
      return mark;
    });
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
 * the drop board's entry jitter. Chip trajectories only need to be
 * deterministic and well-distributed, not unbiasable; there is no adversarial
 * incentive to grind them when the drop is the player's choice (the seed
 * comes from the operator on accept).
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

/** hashInts as a number in [−1, 1), from its well-mixed top bits (FNV-1a's
 *  low bits are a poor mix of small integer inputs). */
function hashSigned(...ns: number[]): number {
  return (hashInts(...ns) >>> 8) / 0x800000 - 1;
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

// ── The drop board ───────────────────────────────────────────────────────────

/** One sample of a coin's path down the board: `t` ms after it went into the
 *  hole, at (u, h), turned `spin` radians about its own axis. */
export interface BoardSample {
  t: number;
  u: number;
  h: number;
  spin: number;
}

export interface BoardRun {
  /** Where across the board the coin left its bottom edge. */
  exitU: number;
  /** How long it took from the hole to the bottom edge (ms). */
  fallMs: number;
  /** Its path, every BOARD_SAMPLE_MS and at the exit (only when asked for). */
  path?: BoardSample[];
}

/**
 * Drop a coin through `hole` and let it fall down the board: gravity, the
 * pegs and the side rails, bounced the air hockey way (push out along the
 * contact normal, reflect the approach velocity with restitution). The seed
 * moves it a little off the hole and sets it going a little sideways; the
 * timing (the drop's pusher phase) feeds the same hash, so two drops a moment
 * apart take different paths. Deterministic: + − × ÷ and √ only.
 */
export function simulateBoard(hole: PusherHole, timing: number, seed: number, trace = false): BoardRun {
  const t = Number.isFinite(timing) ? clamp(timing, 0, 1) : 0.5;
  const bucket = Math.min(999, Math.max(0, Math.floor(t * 1000)));
  const s = seed >>> 0;
  const railU = FIELD_HALF_W - CHIP_R;
  const contact = CHIP_R + PEG_R;
  const dt = BOARD_STEP_MS / 1000;
  let u = clamp(HOLE_US[hole] + hashSigned(s, hole, bucket, 0) * ENTRY_JITTER, -railU, railU);
  let h = BOARD_H;
  let vu = hashSigned(s, hole, bucket, 1) * ENTRY_SPIN;
  let vh = -0.15;
  let spin = 0;
  let omega = vu / CHIP_R;
  let bounces = 0;
  const path: BoardSample[] | undefined = trace ? [{ t: 0, u, h, spin }] : undefined;
  const maxSteps = BOARD_MAX_MS / BOARD_STEP_MS;
  let step = 0;
  while (h > 0 && step < maxSteps) {
    step++;
    vh -= BOARD_GRAVITY * dt;
    u += vu * dt;
    h += vh * dt;
    spin += omega * dt;

    // Side rails, as the air hockey table's side rails.
    if (u > railU) { u = railU; vu = -Math.abs(vu) * BOARD_RAIL_RESTITUTION; omega = vh / CHIP_R; }
    else if (u < -railU) { u = -railU; vu = Math.abs(vu) * BOARD_RAIL_RESTITUTION; omega = -vh / CHIP_R; }

    // Pegs: circle vs circle, as the puck against a mallet that never moves.
    for (const peg of BOARD_PEGS) {
      const du = u - peg.u;
      const dh = h - peg.h;
      const distSq = du * du + dh * dh;
      if (distSq >= contact * contact) continue;
      const dist = Math.sqrt(distSq);
      let nu = dist > 1e-9 ? du / dist : 0;
      let nh = dist > 1e-9 ? dh / dist : 1;
      // Dead on top of a peg a coin would balance there for ever: the seed
      // tips it off to one side.
      if (Math.abs(nu) < 0.02) {
        nu = hashSigned(s, hole, bucket, 2 + bounces) < 0 ? -0.02 : 0.02;
        nh = Math.sqrt(1 - nu * nu);
      }
      u = peg.u + nu * contact;
      h = peg.h + nh * contact;
      const vn = vu * nu + vh * nh;
      if (vn < 0) {
        vu -= (1 + PEG_RESTITUTION) * vn * nu;
        vh -= (1 + PEG_RESTITUTION) * vn * nh;
        // A coin glances off a pin, it never sits on one: at least
        // PEG_KICK sideways, away from the pin.
        if (Math.abs(vu) < PEG_KICK || vu * nu < 0) vu = (nu < 0 ? -1 : 1) * Math.max(PEG_KICK, Math.abs(vu));
        // It rolls off the peg: spin from the speed along the surface.
        omega = (vu * nh - vh * nu) / CHIP_R;
        bounces++;
      }
    }
    if (u > railU) u = railU;
    else if (u < -railU) u = -railU;
    if (path && (step * BOARD_STEP_MS) % BOARD_SAMPLE_MS === 0) {
      path.push({ t: step * BOARD_STEP_MS, u, h: Math.max(0, h), spin });
    }
  }
  const fallMs = step * BOARD_STEP_MS;
  if (path && path[path.length - 1].t !== fallMs) path.push({ t: fallMs, u, h: Math.max(0, h), spin });
  return path ? { exitU: u, fallMs, path } : { exitU: u, fallMs };
}

// ── Piles: settle, insert, push ──────────────────────────────────────────────

/**
 * Return a defensive copy of a pile so callers can mutate freely without
 * aliasing peer-shared arrays. The engine keeps state immutable per call. A
 * pile from before the drop board (no `u`) comes back on the centre line.
 */
function copyPile(p: Pile): Pile {
  const out: Pile = { x: p.x, u: p.u ?? 0, count: p.count, chipIds: [...p.chipIds] };
  if (p.standing === true) out.standing = true;
  return out;
}

function copyPiles(ps: Pile[]): Pile[] {
  return ps.map(copyPile);
}

/** How far a pile reaches behind and ahead of its centre along x. */
function halfDepth(p: Pile): number {
  return p.standing ? CHIP_T / 2 : CHIP_R;
}

/**
 * How far ahead of pile `back` the centre of pile `front` must sit for the
 * two not to overlap, or −Infinity when they are too far apart across the
 * table to touch at all. A flat pile is a disc of radius CHIP_R; a standing
 * chip is a slab CHIP_T deep and 2·CHIP_R wide.
 */
export function contactSpacing(back: Pile, front: Pile): number {
  const du = Math.abs(front.u - back.u);
  if (du >= 2 * CHIP_R) return -Infinity;
  if (!back.standing && !front.standing) return Math.sqrt(4 * CHIP_R * CHIP_R - du * du);
  if (back.standing && front.standing) return CHIP_T;
  // Disc against slab: the slab's nearest point across is du − CHIP_R away.
  const d = Math.max(0, du - CHIP_R);
  return Math.sqrt(CHIP_R * CHIP_R - d * d) + CHIP_T / 2;
}

/** Back-to-front order, ties broken by the bottom chip's id. */
function byX(a: Pile, b: Pile): number {
  return a.x - b.x || (a.chipIds[0] ?? 0) - (b.chipIds[0] ?? 0);
}

/** A push smaller than this moves nothing (it is rounding). */
const PUSH_EPS = 1e-9;

/**
 * Put `chipIds` down flat at (x, u): on the flat pile whose centre is within
 * CHIP_R (they stack), else as a new pile. A column taller than
 * MAX_STACK_HEIGHT spills its top chips forward onto the pile ahead (which
 * may spill in turn, chain-cascading toward the front). Mutates `piles`;
 * returns the pile the chips landed on.
 */
function placeFlat(piles: Pile[], x: number, u: number, chipIds: number[]): Pile {
  const near = (px: number, pu: number, skip?: Pile) => piles.find((p) => p !== skip && !p.standing
    && (p.x - px) * (p.x - px) + (p.u - pu) * (p.u - pu) <= CHIP_R * CHIP_R);
  let landed = near(x, u);
  if (landed) {
    landed.count += chipIds.length;
    landed.chipIds.push(...chipIds);
  } else {
    landed = { x, u, count: chipIds.length, chipIds: [...chipIds] };
    piles.push(landed);
  }
  // COLUMN OVERFLOW (spill cascade), for a new pile as for a stack — a
  // multi-chip pile can fall onto open floor. Chip columns are physically
  // unstable past ~MAX_STACK_HEIGHT chips: the top chip slides forward onto
  // the next column. If that is also full it spills further, and the chain
  // propagates until the excess finds a partly filled column or falls off
  // the front edge (the settle pass after evicts it). Safety cap: an
  // unbounded loop here would burn the physics substep.
  let cur = landed;
  for (let safety = 0; safety < PLATFORM_MAX_PILES * 4; safety++) {
    if (cur.count <= MAX_STACK_HEIGHT) break;
    const overflow = cur.count - MAX_STACK_HEIGHT;
    const overflowIds = cur.chipIds.splice(MAX_STACK_HEIGHT, overflow);
    cur.count = MAX_STACK_HEIGHT;
    const spillX = cur.x + PILE_STEP;
    const target = near(spillX, cur.u, cur);
    if (target) {
      target.count += overflow;
      target.chipIds.push(...overflowIds);
      cur = target;
    } else {
      cur = { x: spillX, u: cur.u, count: overflow, chipIds: overflowIds };
      piles.push(cur);
    }
  }
  return landed;
}

/**
 * Settle one platform. Piles only ever move FORWARD (+x) and never sideways:
 *   • the pusher's front face (`face`, −Infinity on the lower platform, which
 *     has none) holds every pile at least its half-depth ahead of it;
 *   • taken back to front, each pile sits at least contactSpacing ahead of
 *     every pile behind it that it touches across the table, so no two
 *     overlap;
 *   • a STANDING chip that either of those moves tips forward onto its face
 *     (pivoting on its front edge, so its centre lands CHIP_T/2 + CHIP_R
 *     ahead), stacking on a flat pile it falls onto — and the pass runs
 *     again, since a chip that fell may push the ones ahead in turn.
 * Any pile whose centre then sits past `frontEdge` FALLS off the front and is
 * returned in `fallen`, for the caller to route (upper→lower, or lower→payout
 * tray). `toppled` lists the chips that tipped over.
 */
export function settlePiles(
  piles: Pile[],
  face: number,
  frontEdge: number,
): { piles: Pile[]; fallen: Pile[]; toppled: number[] } {
  let work = copyPiles(piles);
  const toppled: number[] = [];
  // Every pass that repeats tips at least one standing chip, so this bound
  // is never reached by an honest platform; it keeps a hostile one total.
  for (let pass = 0; pass <= PLATFORM_MAX_PILES; pass++) {
    work.sort(byX);
    const tipping: Pile[] = [];
    for (let i = 0; i < work.length; i++) {
      const p = work[i];
      let need = face + halfDepth(p);
      for (let j = 0; j < i; j++) {
        const spacing = contactSpacing(work[j], p);
        if (spacing !== -Infinity) need = Math.max(need, work[j].x + spacing);
      }
      if (need > p.x + PUSH_EPS) {
        p.x = need;
        if (p.standing) tipping.push(p);
      }
    }
    if (tipping.length === 0) break;
    for (const p of tipping) {
      work.splice(work.indexOf(p), 1);
      toppled.push(...p.chipIds);
      placeFlat(work, p.x + CHIP_T / 2 + CHIP_R, p.u, p.chipIds);
    }
  }
  // A pile falls when its CENTRE has passed the front edge — "the centre of
  // gravity determines when a chip tips off". The engine does not
  // micro-model the tip; the transition is atomic.
  const remaining: Pile[] = [];
  const fallen: Pile[] = [];
  for (const p of work) {
    if (p.x > frontEdge) fallen.push(p);
    else remaining.push(p);
  }
  return { piles: remaining, fallen, toppled };
}

/**
 * Add chips flat at (landX, landU) on a platform with no pusher reaching
 * them — the lower platform, where piles fall from the upper. They stack on a
 * pile within CHIP_R, and chips landing on a stack shove the CONTACT CHAIN
 * ahead of it forward a little (the falling chips' impulse; a gap breaks the
 * chain — no contact, no transmission). A column taller than
 * MAX_STACK_HEIGHT spills forward. A settle pass then evicts anything pushed
 * past the front edge.
 */
export function insertOnPlatform(
  piles: Pile[],
  landX: number,
  landU: number,
  chipIds: number[],
  frontEdge: number,
): { piles: Pile[]; fallen: Pile[] } {
  if (chipIds.length === 0) return { piles: copyPiles(piles), fallen: [] };
  const merged = copyPiles(piles);
  const before = merged.length;
  const landed = placeFlat(merged, landX, clamp(landU, -U_MAX, U_MAX), chipIds);
  if (merged.length === before || merged.indexOf(landed) < before) {
    // CONTACT IMPULSE — only a landing on a stack delivers one.
    const shove = chipIds.length * CHIP_R * 0.5;
    merged.sort(byX);
    const chain: Pile[] = [landed];
    for (const p of merged) {
      if (p === landed || p.x <= landed.x) continue;
      const touches = chain.some((c) => {
        const spacing = contactSpacing(c, p);
        return spacing !== -Infinity && p.x - c.x <= spacing + PUSH_EPS;
      });
      if (touches) chain.push(p);
    }
    for (const p of chain) if (p !== landed) p.x += shove;
  }
  const settled = settlePiles(merged, -Infinity, frontEdge);
  return { piles: settled.piles, fallen: settled.fallen };
}

/** Route piles that fell off the upper front onto the lower platform at the
 *  same u; returns the lower platform and the chips that went on off its
 *  front into the tray. */
function dropToLower(lowerIn: Pile[], fallen: Pile[]): { lower: Pile[]; paid: number[] } {
  let lower = lowerIn;
  const paid: number[] = [];
  for (const fallenPile of fallen) {
    // Lands at (roughly) the same x, clamped to the lower platform's reach
    // so a pile can't fall through a wall.
    const lowerLandX = clamp(fallenPile.x, PLAT_LOW_BACK + CHIP_R, PLAT_LOW_FRONT - CHIP_R);
    const landing = insertOnPlatform(lower, lowerLandX, fallenPile.u, fallenPile.chipIds, PLAT_LOW_FRONT);
    lower = landing.piles;
    for (const p of landing.fallen) paid.push(...p.chipIds);
  }
  return { lower, paid };
}

// ── Physics step & insertion ─────────────────────────────────────────────────

/**
 * Advance the pusher by `dtMs`, push any contacted upper piles forward
 * (tipping any standing chip it reaches), cascade any upper piles that spill
 * onto the lower platform, and pay out any lower piles that spill off the
 * front. Pure — returns a fresh state and the ids of paid chips this step.
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
): { state: CoinPusherState; paidChipIds: number[]; upperFallen: number; toppled: number[] } {
  if (!(dtMs > 0) || !Number.isFinite(dtMs)) {
    // Zero/negative/NaN dt is a no-op — the wiring layer relies on this to
    // clamp jittery Date.now() diffs to safe values without special-casing.
    return { state, paidChipIds: [], upperFallen: 0, toppled: [] };
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

  const upperResult = settlePiles(state.upper, reach, PLAT_UP_FRONT);
  const { lower, paid } = dropToLower(copyPiles(state.lower), upperResult.fallen);

  const nextState: CoinPusherState = {
    ...state,
    upper: upperResult.piles,
    lower,
    pusherPhase: newPhase,
    pusherAtMs: state.pusherAtMs + dtMs,
    tick: state.tick + 1,
    totalPaid: state.totalPaid + paid.length,
  };
  return {
    state: nextState, paidChipIds: paid, upperFallen: upperResult.fallen.length, toppled: upperResult.toppled,
  };
}

/** The machine as one physics substep left it, for a replay (traceDrop). */
export interface TableFrame {
  /** ms after the coin went into the hole. */
  t: number;
  upper: Pile[];
  lower: Pile[];
  /** Chips that fell into the payout tray during this substep. */
  paid: number[];
}

/**
 * Advance the machine by `elapsedMs` in fixed PHYSICS_SUBSTEP_MS substeps.
 * Returns the chips that fell off the lower front (`totalPaid` is bumped for
 * them); whoever caused the run decides who they are paid to. Used by
 * processInsert's settle and by tests / dev inspection — the operator never
 * runs physics on its own (the machine is at rest between drops). With
 * `frames`, each substep's result is appended to it, timed from `startMs`.
 */
export function advanceSim(
  state: CoinPusherState,
  elapsedMs: number,
  frames?: TableFrame[],
  startMs = 0,
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
    frames?.push({ t: startMs + (i + 1) * dtPer, upper: cur.upper, lower: cur.lower, paid: r.paidChipIds });
  }
  return { state: cur, paidChipIds: allPaid };
}

/** How far (ms of pusher travel) a claimed phase may sit from the pusher's
 *  phase at the claimed time and still be that phase — rounding room only: an
 *  honest panel computes it with this same function from the same anchor. */
export const DROP_PHASE_MATCH_MS = 1;

/**
 * The drop's timing: which pusher phase the chip goes into its hole at.
 *
 * The player's request carries the phase that was on their screen when they
 * pressed DROP and the time they pressed it, by their clock
 * (`claimedAtMs`). It reaches the operator a little later (sync + drain), by
 * which time the pusher has moved on. `lagMs` is that delay measured
 * absolutely: the operator's clock at `receivedAtMs` less the claimed time
 * (negative when the claim is ahead — a player clock running fast). The claim
 * is kept, and the chip goes in at exactly the phase the player saw, when:
 *   • the claimed phase is the pusher's phase at the claimed time (so the
 *     claim names one moment, not a phase that recurs every cycle), and
 *   • `lagMs` is inside [−maxLeadMs, maxLagMs].
 * Comparing phases alone would take a request one or more whole cycles old for
 * a fresh one. Anything else (a stale request, a phase that wasn't on screen
 * at that moment, junk) goes in at the operator's current phase, so it gains
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
 * Whether one more drop keeps every counter it moves a safe integer, as the
 * shape guard requires: `tick` moves by TICKS_PER_DROP, `nextChipId` and
 * `totalInserted` by one. The ledger keeps the paid-out total below the
 * inserted one. Only a record a peer wrote can come near the limit: an honest
 * machine would need some 10^14 drops.
 */
export function hasRoomForDrop(state: CoinPusherState): boolean {
  return state.tick <= Number.MAX_SAFE_INTEGER - TICKS_PER_DROP
    && state.nextChipId < Number.MAX_SAFE_INTEGER
    && state.totalInserted < Number.MAX_SAFE_INTEGER;
}

/** Everything a cabinet needs to replay one drop (traceDrop): the coin's path
 *  down the board, when it lands and where, and the table after every
 *  physics substep from the landing on. */
export interface DropTrace {
  board: BoardSample[];
  /** ms from the hole to the bottom of the board, and to the platform. */
  fallMs: number;
  landMs: number;
  /** Where it landed standing (x along the upper platform, u across). */
  landX: number;
  landU: number;
  chipId: number;
  /** The table just as the coin lands (it is standing there), then after
   *  every substep of the settle; the last one is the published machine. */
  frames: TableFrame[];
  /** The machine after the drop: what the next drop is replayed from. */
  after: CoinPusherState;
}

/**
 * Drop one chip through `hole` at pusher phase `dropPhase` (see
 * resolveDropTiming): it falls down the drop board (simulateBoard), drops the
 * chute and lands standing on its edge just in front of the pusher bar —
 * wherever the bar has got to by then — at the u it left the board. Then
 * SETTLE_MS of pusher motion runs so the drop plays out and the machine comes
 * back to rest. Returns the new state and `paid`: the chips this drop
 * knocked into the payout tray, which the operator credits to `playerId` in
 * the same transaction that debits their PUSHER_ANTE chip
 * (casinoDoc.settleCoinPusherInsert).
 *
 * The published sweep anchor (pusherPhase, pusherAtMs) comes back unchanged:
 * the physics runs from `dropPhase` internally, and the free-running pusher
 * every client draws never jumps.
 *
 * Throws RangeError on a bad player id / hole / phase, when the machine is
 * already holding MACHINE_MAX_CHIPS, and when its counters have no room for
 * another drop (hasRoomForDrop); the operator refuses the request without
 * moving money.
 */
export function processInsert(
  state: CoinPusherState,
  playerId: string,
  hole: PusherHole,
  dropPhase: number,
  seed: number,
  trace = false,
): {
  state: CoinPusherState;
  paid: number;
  paidChipIds: number[];
  landedX: number;
  landedU: number;
  chipId: number;
  trace?: DropTrace;
} {
  if (!isBoundedId(playerId)) {
    throw new RangeError('processInsert: playerId must be a bounded non-empty string');
  }
  if (!isHole(hole)) throw new RangeError('processInsert: hole must be 0, 1 or 2');
  if (!isPhase(dropPhase)) throw new RangeError('processInsert: dropPhase must be in [0, 1)');
  if (chipsInMachine(state) + PUSHER_ANTE > MACHINE_MAX_CHIPS) {
    throw new RangeError('processInsert: the machine is full');
  }
  if (!hasRoomForDrop(state)) {
    throw new RangeError('processInsert: the machine\'s counters have no room for another drop');
  }

  // 1. Down the board and the chute. The machine is at rest (a full cycle
  //    settled after the last drop), so any phase is consistent with the
  //    piles: none sits inside the pusher's reach, whatever its position.
  const board = simulateBoard(hole, dropPhase, seed, trace);
  const landMs = board.fallMs + CHUTE_MS;
  const landPhase = mod1(dropPhase + landMs / PUSHER_PERIOD_MS);

  // 2. It lands standing on its edge just in front of the bar's face — or,
  //    landing on the bar's front lip near the end of its stroke, slides
  //    off it to where the bar's furthest reach can't touch it.
  const chipId = state.nextChipId;
  const face = pusherFaceX(landPhase);
  const landedX = (PUSHER_MAX_X - face <= LIP_SLIDE ? PUSHER_MAX_X : face) + CHIP_T / 2;
  const landedU = clamp(board.exitU, -U_MAX, U_MAX);
  const standing: Pile = { x: landedX, u: landedU, count: 1, chipIds: [chipId], standing: true };
  const landing = settlePiles([...state.upper, standing], face, PLAT_UP_FRONT);

  // 3. Anything the landing itself moves off the upper front lands on the
  //    lower platform and may cascade off its front (rare — needs a full
  //    front row). Routed the same way stepMachine does.
  const dropped = dropToLower(copyPiles(state.lower), landing.fallen);
  let cur: CoinPusherState = {
    ...state,
    upper: landing.piles,
    lower: dropped.lower,
    pusherPhase: landPhase,
    nextChipId: state.nextChipId + 1,
    totalInserted: state.totalInserted + PUSHER_ANTE,
    totalPaid: state.totalPaid + dropped.paid.length,
    tick: state.tick + 1,
  };
  const frames: TableFrame[] | undefined = trace
    ? [{ t: landMs, upper: cur.upper, lower: cur.lower, paid: dropped.paid }]
    : undefined;

  // 4. One full pusher cycle: the drop plays out and the machine comes to
  //    rest. stepMachine bumps totalPaid for everything that falls.
  const settled = advanceSim(cur, SETTLE_MS, frames, landMs);
  const paidChipIds = [...dropped.paid, ...settled.paidChipIds];

  // 5. Hand back the untouched sweep anchor (see the doc comment).
  cur = { ...settled.state, pusherPhase: state.pusherPhase, pusherAtMs: state.pusherAtMs };

  const out = { state: cur, paid: paidChipIds.length, paidChipIds, landedX, landedU, chipId };
  if (!trace) return out;
  return {
    ...out,
    trace: {
      board: board.path!, fallMs: board.fallMs, landMs, landX: landedX, landU: landedU, chipId, frames: frames!,
      after: cur,
    },
  };
}

/**
 * Replay a settled drop for the cabinet: `before` is the machine as it was
 * just before it (its nextChipId is the drop's chip), `drop` the record the
 * operator published with it (lastDrop, or its recentDrops mark). Null when
 * the record can't be replayed (a drop from before the drop board carries no
 * seed) or doesn't follow `before`. Who dropped it doesn't change the drop.
 */
export function traceDrop(before: CoinPusherState, drop: ReplayableDrop): DropTrace | null {
  if (drop.seed === undefined || drop.phase === undefined || drop.chipId !== before.nextChipId) return null;
  try {
    return processInsert(before, 'replay', drop.hole, drop.phase, drop.seed, true).trace ?? null;
  } catch {
    return null;
  }
}

/**
 * When a drop went into its hole, on the shared sweep clock: the moment the
 * pusher stood at the drop's phase within the timing window around the
 * settle (`atMs`) — up to MAX_DROP_LEAD_MS after it (a press stamped by a
 * clock running ahead of the operator's) and up to the rest of a cycle
 * before it. The operator honours a press only inside that window (an older
 * one goes in at the operator's own phase), so this is that moment, and a
 * cabinet that replays the drop from it shows it in step with the pusher it
 * is drawing.
 */
export function dropStartMs(state: CoinPusherState, drop: { phase: number; atMs: number }): number {
  const lead = MAX_DROP_LEAD_MS / PUSHER_PERIOD_MS;
  const behind = mod1(currentPusherPhase(state, drop.atMs) - drop.phase + lead) - lead;
  return drop.atMs - behind * PUSHER_PERIOD_MS;
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
