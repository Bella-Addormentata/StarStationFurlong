/**
 * 🪙 Coin pusher — the pure engine (issue #135).
 *
 * A single-machine arcade coin-pusher: the player selects one of three DROP
 * HOLES at the top of the cabinet and TIMES the release relative to a moving
 * pusher on the upper stepped platform. The chip falls through a pin field
 * (deterministic left/right deflection per row from a seed hash), lands on the
 * upper platform, and, over the next few seconds of pusher motion, is shoved
 * toward the front edge. Chips can stack, cascade, tip off the upper edge onto
 * the LOWER platform, and, if pushed hard enough by additional falling chips,
 * finally tip off the front of the LOWER platform into the payout tray. Only
 * chips that fall off the FRONT of the LAST PLATFORM are paid out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE DISCIPLINE
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is PURE (no Yjs / DOM / THREE / wall-clock / Math.random), the
 * same layering contract as games/checkers.ts, games/craps.ts, games/slots.ts.
 * All randomness is derived by a stable non-cryptographic hash from a caller-
 * provided seed + (hole, timing quantum, peg row), so a peer with the same
 * seed reproduces the exact chip trajectory. All time enters as an explicit
 * dt in milliseconds — the wiring layer is responsible for reading Date.now().
 * Doc I/O is in casinoDoc.ts; UI/scene wiring is in devices.ts/furniture.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHYSICS MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 * A 1-D horizontal cross-section keeps the engine test-friendly and
 * deterministic. Two stepped platforms sit inside the cabinet:
 *
 *      UPPER PLATFORM ────  x ∈ [PLAT_UP_BACK, PLAT_UP_FRONT]
 *      LOWER PLATFORM ──────  x ∈ [PLAT_LOW_BACK, PLAT_LOW_FRONT]  (wider, in front)
 *
 * A "pile" is a vertical stack of chips at the same x-column. Piles are
 * kept sorted by x (back → front) and separated by ≥ 2·CHIP_R (chip
 * diameter): a settlement pass enforces both constraints on every mutation,
 * so peer-written states that arrive with overlap are re-settled before
 * a physics step, which keeps the engine total (never diverges).
 *
 * Only the UPPER platform has an active pusher (the sweep bar); the LOWER
 * platform is driven purely by the WEIGHT of chips landing onto it from
 * above (each falling pile shoves the underlying lower-platform pile
 * forward by one chip diameter, and the shove propagates through any
 * abutting piles ahead — this is the CASCADE mechanic in the spec).
 *
 * Sweep pusher motion: a cosine oscillation with period PUSHER_PERIOD_MS.
 * Only the FORWARD half of the cycle imparts push force (a retracting
 * pusher does not drag chips backward — chips advance monotonically, which
 * is the whole game). The pusher front-face position is a strict lower
 * bound on the leftmost upper pile; any upper pile pushed past PLAT_UP_FRONT
 * FALLS onto the lower platform.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSERVATION INVARIANT (essential — dev, playtest, and vitest all check)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *      totalInserted === chipsInMachine + totalPaid + totalEmptied
 *
 * Every path that adds or removes chips updates exactly one counter on
 * each side of this identity. Peer-written state that violates the guard's
 * numeric range is rejected wholesale (see isCoinPusherState). Peer-written
 * state that satisfies the guard but breaks conservation is REPAIRED by
 * settlePiles + re-checked at every physics step: piles are only ever
 * reordered/merged, never counted twice or dropped.
 *
 * The money side (casino chip balances) is enforced by the wiring layer
 * in casinoDoc.ts: an insert debits the player's `bal:<pid>` in the SAME
 * transaction as writing the escrow record, and a pending-credit claim
 * transfers value in the SAME transaction as zeroing the credit. See the
 * casinoDoc header for the LWW / whole-value / one-writer-per-key rules.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHORITY / CONVERGENCE MODEL (see brainstorming/coin-pusher-plan.md)
 * ─────────────────────────────────────────────────────────────────────────────
 * The machine's shared record is stored under the casino map key
 * `pusher:<machineId>` and follows the SLOTS.ts precedent:
 *
 *   • Insert requests are per-player records (`pusher-req:<mid>:<pid>`).
 *   • The MACHINE OWNER's client is the sole operator that drains the queue,
 *     advances physics, and publishes the whole-value LWW state.
 *   • Per-insert ESCROW records (`pusher-esc:<mid>:<pid>:<reqId>`) hold the
 *     debited chip until the operator settles or a reconciler refunds after
 *     the request's TTL — no operator, no chip loss.
 *   • Owner-empty is a same-transaction pair: state write with `upper/lower`
 *     cleared + `totalEmptied` incremented, and `creditChips(ownerId, N)`.
 *   • A hostile peer writing junk into the coinpusher key is REJECTED by
 *     isCoinPusherState() on every read; the wiring layer degrades to the
 *     last known-good state or falls back to `initialCoinPusherState`.
 *
 * Owner-offline: no one can operate the machine (documented limitation in
 * the plan doc + CHANGELOG). This matches the room-editor / slot-croupier
 * precedent and mint/burn safety is worth the loss of anonymous play.
 */

// ── Physical constants (metres, millis) ──────────────────────────────────────
//
// The x-axis runs BACK → FRONT of the cabinet. Origin (x=0) is the back wall
// of the upper platform; positive x goes towards the payout tray. Both
// platforms live on the same x-axis, side-by-side (the lower is IN FRONT of
// the upper, one geometric step down in y that the pure engine ignores):
//
//     x=0.00                  0.60                  1.20
//       ├──── UPPER ─────────┼──── LOWER ──────────┤
//       ▓ pusher                                     ▐ payout
//       ▓  rest  →  extends to 0.50    ...           ▐  tray
//
// A chip pushed past x=0.60 tips off the upper front and lands on the back
// of the lower (near x=0.63 after clamping). Chips pushed past x=1.20 tip
// off the front of the lower and become PAYOUT to the current inserter.

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

/** Horizontal positions of the three drop holes across the top of the cabinet.
 *  Spread evenly over the upper platform so each hole has a distinct landing
 *  zone even after the ±(TIMING_OFFSET + PEG rows·PEG_DEFLECTION) drift. */
export const HOLE_XS: readonly number[] = [0.15, 0.30, 0.45] as const;
export const HOLE_COUNT = HOLE_XS.length;

/** Fixed substep for the pusher-driven physics — small enough that the front
 *  face moves ≪ CHIP_R per substep at peak velocity, so cascades resolve
 *  without tunnelling through piles. Independent of the settle-step count. */
export const PHYSICS_SUBSTEP_MS = 40;

/** Simulate this many ms of pusher motion after each insert so the chip has
 *  a chance to interact with existing piles (one full period + one substep). */
export const SETTLE_MS = PUSHER_PERIOD_MS + PHYSICS_SUBSTEP_MS;

/** Peg field: rows of pins the chip deflects off between the hole and the
 *  upper platform. Five rows gives ~32 possible landing lanes, wide enough
 *  for real skill+luck but still small enough to test exhaustively. */
export const PEG_ROWS = 5;
/** Sideways displacement per peg row (metres). Tuned so a full ±5-bit walk
 *  spans about one hole spacing (a well-timed drop stays under its hole,
 *  a poorly-timed one wanders one hole over). */
export const PEG_DEFLECTION = 0.020;

/** Timing offset scale — a maximally miss-timed drop biases the entry x by
 *  ±CHIP_R (about one chip diameter), so timing matters but never enough to
 *  bypass the peg field entirely. */
export const TIMING_OFFSET = CHIP_R;

/** Owner-set per-insert fee ceiling (chips). One chip per insert is the
 *  classical price — but a room owner may configure their machine's ANTE
 *  higher in the wiring layer if they wish. */
export const PUSHER_MAX_ANTE = 100;

/** Physical stability cap on a chip column. When a landing pushes a
 *  column's count past this, the excess chips SPILL forward to the pile
 *  ahead (which may itself spill, chain-cascading toward the front). This
 *  matches the spec's cascade language: "groups of chips can fall together,
 *  or off the front of a group". Beyond ~4 chips a stack becomes unstable
 *  and the top chip slides off the front toward the next pile. */
export const MAX_STACK_HEIGHT = 4;

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

/**
 * The full doc-synced machine state — plain JSON, whole-value LWW write per
 * machine key. `kind` discriminates it inside the shared casino map (the
 * slot-machine / roulette / craps precedent).
 */
export interface CoinPusherState {
  kind: 'coin-pusher';
  /** Machine owner (fixed at spawn). Only the owner may empty the machine. */
  ownerId: string;
  /** Upper platform piles, back-to-front (sorted by x ascending). */
  upper: Pile[];
  /** Lower platform piles, back-to-front (sorted by x ascending). */
  lower: Pile[];
  /** Monotonic chip identity for conservation checks + rendering continuity. */
  nextChipId: number;
  /** Pusher animation phase [0, 1) at `pusherAtMs`. */
  pusherPhase: number;
  /** Wall-clock ms when `pusherPhase` was last recorded. Used by the wiring
   *  layer to pick up where the last operator left off; the pure engine only
   *  uses it as a monotonic timestamp for `advanceSim`. */
  pusherAtMs: number;
  /** Monotonic write counter — every mutating helper bumps it. Peer readers
   *  can use it to detect stale updates; whole-value LWW resolves ties. */
  tick: number;
  /** playerId → chips owed for chips that fell off the LOWER FRONT. Cleared
   *  by the wiring layer's claim path in the same transaction as
   *  `creditChips`, so conservation across doc + casino is atomic. */
  pendingCredit: Record<string, number>;
  /** Lifetime chips inserted into THIS machine. */
  totalInserted: number;
  /** Lifetime chips that fell off the FRONT of the LOWER platform (paid out). */
  totalPaid: number;
  /** Lifetime chips removed by an owner-triggered door-open. */
  totalEmptied: number;
}

/** Which drop hole a chip goes through (0 = left, 1 = centre, 2 = right). */
export type PusherHole = 0 | 1 | 2;

/** Insert-request record placed by a would-be player under
 *  `pusher-req:<machineId>:<playerId>`, drained by the machine owner. */
export interface PusherInsertRequest {
  requestId: string;
  player: string;
  hole: PusherHole;
  /** Timing offset in [0, 1) selected by the player at insert time. */
  timing: number;
  /** Chip stake paid at insert (typically 1). Bounded by PUSHER_MAX_ANTE. */
  ante: number;
  /** Client-side ms timestamp for TTL / recency; not authoritative. */
  requestedAt: number;
}

/** Escrow record parked under `pusher-esc:<machineId>:<playerId>:<requestId>`
 *  while a request is waiting on the operator. The reconciler refunds this
 *  after the TTL if the operator never processed it. */
export interface PusherEscrow {
  requestId: string;
  player: string;
  ante: number;
  escrowedAt: number;
}

// ── Guards (peer trust boundary) ─────────────────────────────────────────────

/** A safe non-negative integer in the allowed chip-count range (0..MAX_SAFE). */
function isCountInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

/** Peer state MUST NOT ship an insanely large chip list — a hostile peer could
 *  otherwise stall render/settle loops with a length-2^30 pile. This ceiling
 *  is well above any realistic filled cabinet. */
const PILE_MAX_CHIPS = 4096;
const PLATFORM_MAX_PILES = 256;

function isPile(v: unknown): v is Pile {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<Pile>;
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return false;
  if (!isCountInt(p.count) || (p.count as number) > PILE_MAX_CHIPS) return false;
  if (!Array.isArray(p.chipIds)) return false;
  if ((p.chipIds as unknown[]).length !== p.count) return false;
  for (const id of p.chipIds as unknown[]) {
    if (!isCountInt(id)) return false;
  }
  return true;
}

function isPileArray(v: unknown): v is Pile[] {
  return Array.isArray(v) && v.length <= PLATFORM_MAX_PILES && v.every(isPile);
}

function isPendingCredit(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null) return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 128) return false;
    if (!isCountInt(val)) return false;
  }
  return true;
}

/** Shape guard for a peer-written coin-pusher state. Everything the engine
 *  and UI dereference is checked; a rejection means the reader falls back to
 *  the last known-good state or the initial state. See module header. */
export function isCoinPusherState(v: unknown): v is CoinPusherState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<CoinPusherState>;
  return s.kind === 'coin-pusher'
    && typeof s.ownerId === 'string'
    && (s.ownerId as string).length > 0
    && (s.ownerId as string).length <= 128
    && isPileArray(s.upper)
    && isPileArray(s.lower)
    && isCountInt(s.nextChipId)
    && typeof s.pusherPhase === 'number'
    && Number.isFinite(s.pusherPhase)
    && (s.pusherPhase as number) >= 0 && (s.pusherPhase as number) < 1
    && typeof s.pusherAtMs === 'number' && Number.isFinite(s.pusherAtMs)
    && isCountInt(s.tick)
    && isPendingCredit(s.pendingCredit)
    && isCountInt(s.totalInserted)
    && isCountInt(s.totalPaid)
    && isCountInt(s.totalEmptied);
}

export function isPusherInsertRequest(v: unknown): v is PusherInsertRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<PusherInsertRequest>;
  return typeof r.requestId === 'string' && (r.requestId as string).length > 0 && (r.requestId as string).length <= 128
    && typeof r.player === 'string' && (r.player as string).length > 0 && (r.player as string).length <= 128
    && (r.hole === 0 || r.hole === 1 || r.hole === 2)
    && typeof r.timing === 'number' && Number.isFinite(r.timing)
    && (r.timing as number) >= 0 && (r.timing as number) <= 1
    && isCountInt(r.ante) && (r.ante as number) > 0 && (r.ante as number) <= PUSHER_MAX_ANTE
    && typeof r.requestedAt === 'number' && Number.isFinite(r.requestedAt);
}

export function isPusherEscrow(v: unknown): v is PusherEscrow {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<PusherEscrow>;
  return typeof e.requestId === 'string' && (e.requestId as string).length > 0 && (e.requestId as string).length <= 128
    && typeof e.player === 'string' && (e.player as string).length > 0 && (e.player as string).length <= 128
    && isCountInt(e.ante) && (e.ante as number) > 0 && (e.ante as number) <= PUSHER_MAX_ANTE
    && typeof e.escrowedAt === 'number' && Number.isFinite(e.escrowedAt);
}

// ── Initial state factories ──────────────────────────────────────────────────

export function initialCoinPusherState(ownerId: string, nowMs = 0): CoinPusherState {
  if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 128) {
    throw new RangeError('initialCoinPusherState: ownerId must be a bounded non-empty string');
  }
  return {
    kind: 'coin-pusher',
    ownerId,
    upper: [],
    lower: [],
    nextChipId: 1,
    pusherPhase: 0,
    pusherAtMs: Number.isFinite(nowMs) ? nowMs : 0,
    tick: 0,
    pendingCredit: {},
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
  // Guard the exact-1.0 float-rounding edge (Math.floor(0.999...) === 0 but
  // 1 - Math.floor(1) === 0 already; belt-and-braces for negative dt too).
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
 * diameter (they stack), else opening a new pile. Then a settle pass shoves
 * any piles AHEAD of the landing pile forward by contact — chips landing
 * on top of a pile press the front pile forward by exactly one chip
 * diameter (the cascade rule in the spec).
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
  if (idx >= 0) {
    merged[idx].count += chipIds.length;
    merged[idx].chipIds = [...merged[idx].chipIds, ...chipIds];
    merged.sort((a, b) => a.x - b.x);
    const landedIdx = merged.findIndex((p) => Math.abs(p.x - landX) <= CHIP_R);

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

    // (B) COLUMN OVERFLOW (spill cascade). Chip columns are physically
    //     unstable past ~MAX_STACK_HEIGHT chips: the top chip slides
    //     forward onto the next column. If the next column is also full,
    //     it spills further, and the chain propagates until the excess
    //     finds a partially-filled column or FALLS off the front edge.
    //     Combined with the pusher's steady forward stroke on the upper
    //     platform, this is the primary path that puts chips into the
    //     payout tray.
    let cur = landedIdx;
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
  } else {
    merged.push({ x: landX, count: chipIds.length, chipIds: [...chipIds] });
    merged.sort((a, b) => a.x - b.x);
  }

  // A final settle pass: it catches the edge case where a landing pile
  // opens BEHIND an existing pile that must be re-anchored to a valid x,
  // and evicts any pile whose centre is now past the front edge.
  return settlePiles(merged, -Infinity, frontEdge);
}

// ── Peg deflection ───────────────────────────────────────────────────────────

/**
 * Deterministic peg deflection: given a hole index, a timing offset ∈ [0, 1),
 * and a seed, walk the chip through PEG_ROWS binary left/right choices to
 * arrive at a landing x on the upper platform. This is the ONLY randomness
 * in chip motion — everything downstream is a rigid-body slide.
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

  const newPhase = mod1(state.pusherPhase + dtMs / PUSHER_PERIOD_MS);
  const newFace = pusherFaceX(newPhase);
  const prevFace = pusherFaceX(state.pusherPhase);

  // Pusher's front face constrains the leftmost upper pile's x. If the
  // pusher is retracting (newFace < prevFace) it does not DRAG piles
  // backward: pass the previous (higher) constraint so piles stay put.
  const constraint = Math.max(newFace, prevFace) + CHIP_R;

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
 * Payout attribution: the pending-credit is credited to `payoutTo` (usually
 * the current insert's player). Callers may pass `null` to leave payouts
 * UNATTRIBUTED — `totalPaid` is still bumped for conservation, but the
 * chips are NOT written to any `pendingCredit[]` entry and therefore
 * NEVER reach a real player balance. The wiring layer MUST NOT pass
 * `null` during idle physics ticks (audit finding #2): use `state.ownerId`
 * for ambient sweep — the machine owner earns what tips off between
 * inserts. `null` is reserved for dev-tool inspection where the caller
 * wants to see the pile settle without a ledger entry.
 */
export function advanceSim(
  state: CoinPusherState,
  elapsedMs: number,
  payoutTo: string | null,
): { state: CoinPusherState; paidChipIds: number[]; } {
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
  if (payoutTo && allPaid.length > 0) {
    const next: CoinPusherState = {
      ...cur,
      pendingCredit: {
        ...cur.pendingCredit,
        [payoutTo]: (cur.pendingCredit[payoutTo] ?? 0) + allPaid.length,
      },
    };
    return { state: next, paidChipIds: allPaid };
  }
  return { state: cur, paidChipIds: allPaid };
}

/**
 * Drop one chip through hole `hole` with player-chosen `timing`, then run
 * SETTLE_MS of pusher motion so the drop has time to interact. Returns the
 * new state plus a report so the caller can:
 *   1. Debit `ante` chips from the player's balance (one whole tx).
 *   2. Publish the new state to the doc.
 *   3. Credit `paidChipIds.length` chips to the player, and clear their
 *      pending-credit entry in the SAME transaction.
 *
 * The engine does NOT touch player balances — the wiring layer owns that
 * (see casinoDoc header for the LWW/whole-value/one-writer-per-key rules).
 * `ante` is only recorded as `totalInserted` so the conservation invariant
 * holds; the money side is the wiring layer's job.
 *
 * `nowMs` may be `null` to skip the between-insert pusher advance (rarely
 * useful — dev inspection or tests only).
 */
export function processInsert(
  state: CoinPusherState,
  playerId: string,
  hole: PusherHole,
  timing: number,
  ante: number,
  seed: number,
  nowMs: number | null,
): {
  state: CoinPusherState;
  paidChipIds: number[];
  landedX: number;
  chipId: number;
} {
  if (!Number.isSafeInteger(ante) || ante <= 0 || ante > PUSHER_MAX_ANTE) {
    throw new RangeError(`processInsert: ante must be a safe integer 1..${PUSHER_MAX_ANTE}`);
  }
  if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > 128) {
    throw new RangeError('processInsert: playerId must be a bounded non-empty string');
  }

  // 1. Advance to now (pusher may have swept while no one was inserting).
  //    advanceSim() already credits any resulting payouts to the passed
  //    `playerId` — both `state.pendingCredit[playerId]` and `state.totalPaid`
  //    are updated on the returned state. Keep `betweenPaid` SEPARATE from
  //    `instantPaid` (below) so step 6 re-applies ONLY the step-3 fallouts,
  //    never the step-1 ones (audit finding #1: prior code double-credited
  //    step-1 fallouts, silently minting chips into `pendingCredit`).
  let cur = state;
  const betweenPaid: number[] = [];
  if (nowMs !== null && nowMs > state.pusherAtMs) {
    const between = advanceSim(cur, nowMs - state.pusherAtMs, playerId);
    cur = between.state;
    betweenPaid.push(...between.paidChipIds);
  }

  // 2. Compute the chip's landing x from the peg field (deterministic).
  const rawLandX = simulatePeg(hole, timing, seed);
  const landedX = clamp(rawLandX, PLAT_UP_BACK + CHIP_R, PLAT_UP_FRONT - CHIP_R);
  const chipId = cur.nextChipId;
  const inserted = insertOnPlatform(cur.upper, landedX, [chipId], PLAT_UP_FRONT);

  // 3. Any INSTANT fall-off from the drop itself lands on the lower and
  //    may cascade off (rare — needs a full front row). Route the same way
  //    stepMachine does. These chips are NOT tracked by any state field
  //    yet (the drop wrote only to the local `upper`/`lower` copies), so
  //    step 6 owns the accounting for them.
  let upper = inserted.piles;
  let lower = copyPiles(cur.lower);
  const instantPaid: number[] = [];
  for (const fallenPile of inserted.fallen) {
    const lowerLandX = clamp(fallenPile.x, PLAT_LOW_BACK + CHIP_R, PLAT_LOW_FRONT - CHIP_R);
    const landing = insertOnPlatform(lower, lowerLandX, fallenPile.chipIds, PLAT_LOW_FRONT);
    lower = landing.piles;
    for (const p of landing.fallen) instantPaid.push(...p.chipIds);
  }

  // 4. Bank the insert in the state — the ante is inserted CHIPS-wise
  //    (conservation), and the physics step later attributes payouts.
  cur = {
    ...cur,
    upper,
    lower,
    nextChipId: cur.nextChipId + 1,
    totalInserted: cur.totalInserted + ante,
    tick: cur.tick + 1,
  };

  // 5. Simulate SETTLE_MS of pusher motion so the freshly-inserted chip
  //    can be pushed. This is what makes an insert feel like an action:
  //    the chip lands, the pusher advances, chips cascade off the edges.
  //    advanceSim() attributes any settle-time payouts to `playerId` on
  //    the returned state (both `pendingCredit` and `totalPaid`).
  const settled = advanceSim(cur, SETTLE_MS, playerId);
  cur = settled.state;
  const settlePaid = settled.paidChipIds;

  // 6. Credit chips that fell during STEP 3 ONLY (the instant cascade off
  //    the freshly-inserted chip). Step 1 and step 5 already bumped both
  //    `pendingCredit[playerId]` and `totalPaid` inside advanceSim; only
  //    step 3 wrote directly into `upper`/`lower` without touching either
  //    counter, so exactly `instantPaid.length` chips need a manual credit
  //    to keep the conservation invariant balanced.
  if (instantPaid.length > 0) {
    cur = {
      ...cur,
      pendingCredit: {
        ...cur.pendingCredit,
        [playerId]: (cur.pendingCredit[playerId] ?? 0) + instantPaid.length,
      },
      totalPaid: cur.totalPaid + instantPaid.length,
      tick: cur.tick + 1,
    };
  }

  return {
    state: cur,
    paidChipIds: [...betweenPaid, ...instantPaid, ...settlePaid],
    landedX,
    chipId,
  };
}

// ── Owner-only door: empty the machine ───────────────────────────────────────

/**
 * The owner opens the machine door and takes all chips inside. This is the
 * ONLY path that removes chips from the machine besides paying them out to
 * players; per the spec, there is NO auto-siphon. A non-owner call returns
 * `ok: false` and leaves state UNCHANGED so the wiring layer can refuse
 * cleanly.
 *
 * The wiring layer is responsible for the money side:
 *   1. Call `emptyMachine(state, ownerId)`. If `ok`, get `emptied` count.
 *   2. In the SAME transaction: publish the new state AND
 *      `creditChips(ownerId, emptied)`.
 * Conservation holds: chips left the machine (chipsInMachine → 0) and
 * `totalEmptied` grew by exactly the same amount.
 */
export function emptyMachine(
  state: CoinPusherState,
  requesterId: string,
): { state: CoinPusherState; emptied: number; ok: boolean } {
  if (requesterId !== state.ownerId) {
    return { state, emptied: 0, ok: false };
  }
  let emptied = 0;
  for (const p of state.upper) emptied += p.count;
  for (const p of state.lower) emptied += p.count;
  const next: CoinPusherState = {
    ...state,
    upper: [],
    lower: [],
    totalEmptied: state.totalEmptied + emptied,
    tick: state.tick + 1,
  };
  return { state: next, emptied, ok: true };
}

// ── Pending credit claim (money-side handoff) ────────────────────────────────

/**
 * Zero-out one player's pending credit and return the amount. The wiring
 * layer calls `creditChips(playerId, amount)` in the SAME transaction as
 * publishing this new state, so conservation across doc + casino stays
 * atomic. Idempotent when nothing is owed.
 */
export function claimPendingCredit(
  state: CoinPusherState,
  playerId: string,
): { state: CoinPusherState; amount: number } {
  const amount = state.pendingCredit[playerId] ?? 0;
  if (amount <= 0) return { state, amount: 0 };
  const nextCredit = { ...state.pendingCredit };
  delete nextCredit[playerId];
  return {
    state: { ...state, pendingCredit: nextCredit, tick: state.tick + 1 },
    amount,
  };
}

// ── Conservation invariant (public — dev tools + tests both use this) ────────

export interface Conservation {
  chipsInMachine: number;
  totalInserted: number;
  totalPaid: number;
  totalEmptied: number;
  pendingCredit: number;
  /** True iff totalInserted === chipsInMachine + totalPaid + totalEmptied. */
  balanced: boolean;
}

/** Compute the conservation snapshot. Every mutating helper preserves this. */
export function computeConservation(state: CoinPusherState): Conservation {
  let chipsInMachine = 0;
  for (const p of state.upper) chipsInMachine += p.count;
  for (const p of state.lower) chipsInMachine += p.count;
  let pendingCredit = 0;
  for (const n of Object.values(state.pendingCredit)) pendingCredit += n;
  return {
    chipsInMachine,
    totalInserted: state.totalInserted,
    totalPaid: state.totalPaid,
    totalEmptied: state.totalEmptied,
    pendingCredit,
    balanced: state.totalInserted === chipsInMachine + state.totalPaid + state.totalEmptied,
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

/** Compute the pusher's current phase from a stored (phase, atMs) snapshot
 *  and a new wall-clock time. The engine never calls Date.now(); the UI
 *  passes `nowMs` in. */
export function currentPusherPhase(state: CoinPusherState, nowMs: number): number {
  if (!Number.isFinite(nowMs)) return state.pusherPhase;
  const dt = Math.max(0, nowMs - state.pusherAtMs);
  return mod1(state.pusherPhase + dt / PUSHER_PERIOD_MS);
}
