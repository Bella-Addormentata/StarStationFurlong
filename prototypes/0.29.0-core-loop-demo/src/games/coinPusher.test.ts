/**
 * 🪙 Coin pusher engine tests (issue #135).
 *
 * These vitest specs exercise the pure engine surface of coinPusher.ts:
 *   • shape guard accepts valid + rejects hostile peer states
 *   • peg deflection is deterministic per (hole, timing bucket, seed)
 *   • the sweep pusher advances chips forward monotonically
 *   • chips stack at the same x-column (piles)
 *   • pushed piles cascade through contacting piles ahead
 *   • an upper-front-edge tip drops chips onto the lower platform
 *   • a chip landing on a full lower stack overflows to the front (spill)
 *   • only chips off the LAST platform pay out (never off the upper front)
 *   • only the owner can empty the machine
 *   • conservation `inserted = inMachine + paid + emptied` holds through
 *     hundreds of randomised operations
 *
 * The engine is fully deterministic — no Math.random, no Date.now — so the
 * tests are stable and can be exhaustively enumerated over small seed sweeps.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceSim,
  chipsInMachine,
  CHIP_R,
  claimPendingCredit,
  computeConservation,
  currentPusherPhase,
  emptyMachine,
  hashInts,
  HOLE_XS,
  initialCoinPusherState,
  insertOnPlatform,
  isCoinPusherState,
  isPusherEscrow,
  isPusherInsertRequest,
  MAX_STACK_HEIGHT,
  PEG_ROWS,
  PILE_STEP,
  PLAT_LOW_BACK,
  PLAT_UP_FRONT,
  processInsert,
  PUSHER_MAX_ANTE,
  PUSHER_MAX_X,
  PUSHER_MIN_X,
  PUSHER_PERIOD_MS,
  pusherFaceX,
  settlePiles,
  simulatePeg,
  stepMachine,
  type CoinPusherState,
  type Pile,
  type PusherHole,
} from './coinPusher';

// ── Fixture helpers ──────────────────────────────────────────────────────────

const OWNER = 'owner-Alice';
const PLAYER1 = 'player-Bob';
const PLAYER2 = 'player-Carol';

/** Build a single pile at x holding `count` fresh chip ids drawn from `next`
 *  (a mutable id counter). Used to keep fixtures conservation-balanced. */
function pileN(x: number, count: number, next: { id: number }): Pile {
  const chipIds: number[] = [];
  for (let i = 0; i < count; i++) chipIds.push(next.id++);
  return { x, count, chipIds };
}

/** Build a conservation-balanced state from a hand-authored pile layout so
 *  physics tests can assertConserved() without a false failure from a hand-
 *  authored `totalInserted: 0`. `nextChipId` is set past the last id used. */
function buildState(
  upper: (n: { id: number }) => Pile[],
  lower: (n: { id: number }) => Pile[],
  extra: Partial<CoinPusherState> = {},
): CoinPusherState {
  const next = { id: 1 };
  const u = upper(next);
  const l = lower(next);
  const chipTotal = u.reduce((s, p) => s + p.count, 0) + l.reduce((s, p) => s + p.count, 0);
  return {
    ...initialCoinPusherState(OWNER, 0),
    upper: u,
    lower: l,
    nextChipId: next.id,
    totalInserted: chipTotal,
    ...extra,
  };
}

function assertConserved(state: CoinPusherState, label = 'invariant') {
  const c = computeConservation(state);
  expect(c.balanced, `${label}: ${JSON.stringify(c)}`).toBe(true);
  expect(c.chipsInMachine).toBeGreaterThanOrEqual(0);
  expect(c.pendingCredit).toBeGreaterThanOrEqual(0);
}

// ── Guards ───────────────────────────────────────────────────────────────────

describe('shape guards', () => {
  it('accepts the initial state', () => {
    expect(isCoinPusherState(initialCoinPusherState(OWNER))).toBe(true);
  });

  it('rejects null / non-object / wrong-kind', () => {
    expect(isCoinPusherState(null)).toBe(false);
    expect(isCoinPusherState(undefined)).toBe(false);
    expect(isCoinPusherState(42)).toBe(false);
    expect(isCoinPusherState('nope')).toBe(false);
    expect(isCoinPusherState({ kind: 'slot-machine' })).toBe(false);
    expect(isCoinPusherState({ ...initialCoinPusherState(OWNER), kind: 'not-a-pusher' as never })).toBe(false);
  });

  it('rejects missing ownerId or empty / oversize ownerId', () => {
    const s = initialCoinPusherState(OWNER);
    expect(isCoinPusherState({ ...s, ownerId: '' })).toBe(false);
    expect(isCoinPusherState({ ...s, ownerId: 'x'.repeat(129) })).toBe(false);
    expect(isCoinPusherState({ ...s, ownerId: 42 as never })).toBe(false);
  });

  it('rejects malformed piles (count / chipIds mismatch)', () => {
    const bad: CoinPusherState = {
      ...initialCoinPusherState(OWNER),
      upper: [{ x: 0.30, count: 2, chipIds: [1] }], // count != length
    };
    expect(isCoinPusherState(bad)).toBe(false);
  });

  it('rejects non-integer / negative counters', () => {
    const s = initialCoinPusherState(OWNER);
    expect(isCoinPusherState({ ...s, totalInserted: -1 })).toBe(false);
    expect(isCoinPusherState({ ...s, totalPaid: 1.5 })).toBe(false);
    expect(isCoinPusherState({ ...s, nextChipId: NaN })).toBe(false);
  });

  it('rejects out-of-range pusher phase', () => {
    const s = initialCoinPusherState(OWNER);
    expect(isCoinPusherState({ ...s, pusherPhase: -0.1 })).toBe(false);
    expect(isCoinPusherState({ ...s, pusherPhase: 1 })).toBe(false);
    expect(isCoinPusherState({ ...s, pusherPhase: 1.2 })).toBe(false);
    expect(isCoinPusherState({ ...s, pusherPhase: Number.NaN })).toBe(false);
  });

  it('rejects hostile mega-pile that could stall the render loop', () => {
    const megaChips = Array.from({ length: 10_000 }, (_, i) => i + 1);
    const bad: CoinPusherState = {
      ...initialCoinPusherState(OWNER),
      upper: [{ x: 0.30, count: megaChips.length, chipIds: megaChips }],
    };
    expect(isCoinPusherState(bad)).toBe(false);
  });

  it('rejects hostile pending-credit with bad keys / values', () => {
    const s = initialCoinPusherState(OWNER);
    expect(isCoinPusherState({ ...s, pendingCredit: { '': 3 } })).toBe(false);
    expect(isCoinPusherState({ ...s, pendingCredit: { p: -3 } })).toBe(false);
    expect(isCoinPusherState({ ...s, pendingCredit: { p: 'nope' as never } })).toBe(false);
  });

  it('accepts a plausibly-large legitimate state (round-trip after JSON)', () => {
    const populated = buildState(
      (n) => [pileN(0.20, 2, n), pileN(0.28, 1, n)],
      (n) => [pileN(0.70, 1, n), pileN(0.76, 1, n)],
    );
    // JSON round-trip is what a real doc read looks like.
    expect(isCoinPusherState(JSON.parse(JSON.stringify(populated)))).toBe(true);
  });

  it('insert-request and escrow guards reject junk', () => {
    expect(isPusherInsertRequest(null)).toBe(false);
    expect(isPusherInsertRequest({
      requestId: 'r1', player: PLAYER1, hole: 3 as never, timing: 0.5, ante: 1, requestedAt: 0,
    })).toBe(false);
    expect(isPusherInsertRequest({
      requestId: 'r1', player: PLAYER1, hole: 1, timing: 0.5, ante: PUSHER_MAX_ANTE + 1, requestedAt: 0,
    })).toBe(false);
    expect(isPusherInsertRequest({
      requestId: 'r1', player: PLAYER1, hole: 1, timing: 0.5, ante: 1, requestedAt: 0,
    })).toBe(true);
    expect(isPusherEscrow({
      requestId: 'r1', player: PLAYER1, ante: 1, escrowedAt: 0,
    })).toBe(true);
    expect(isPusherEscrow({
      requestId: 'r1', player: PLAYER1, ante: 0, escrowedAt: 0,
    })).toBe(false);
  });
});

// ── initialCoinPusherState ───────────────────────────────────────────────────

describe('initialCoinPusherState', () => {
  it('produces a valid, empty, balanced state', () => {
    const s = initialCoinPusherState(OWNER, 1000);
    expect(isCoinPusherState(s)).toBe(true);
    expect(s.upper).toEqual([]);
    expect(s.lower).toEqual([]);
    expect(s.pusherAtMs).toBe(1000);
    assertConserved(s, 'initial');
  });

  it('throws on empty / oversize / non-string ownerId', () => {
    expect(() => initialCoinPusherState('')).toThrow(RangeError);
    expect(() => initialCoinPusherState('a'.repeat(129))).toThrow(RangeError);
    expect(() => initialCoinPusherState(42 as never)).toThrow(RangeError);
  });
});

// ── Pure math: pusherFaceX, hashInts, currentPusherPhase ─────────────────────

describe('pusherFaceX', () => {
  it('is monotonic on the forward half and back on the retract half', () => {
    // Cosine profile: 0..0.5 accelerates forward, 0.5..1 retracts.
    let lastFwd = pusherFaceX(0);
    for (let p = 0.02; p <= 0.5; p += 0.02) {
      const fx = pusherFaceX(p);
      expect(fx).toBeGreaterThanOrEqual(lastFwd - 1e-9);
      lastFwd = fx;
    }
    let lastBack = pusherFaceX(0.5);
    for (let p = 0.52; p < 1; p += 0.02) {
      const fx = pusherFaceX(p);
      expect(fx).toBeLessThanOrEqual(lastBack + 1e-9);
      lastBack = fx;
    }
  });

  it('reaches min at phase=0 and max at phase=0.5', () => {
    expect(pusherFaceX(0)).toBeCloseTo(PUSHER_MIN_X, 9);
    expect(pusherFaceX(0.5)).toBeCloseTo(PUSHER_MAX_X, 9);
  });

  it('wraps phase modulo 1', () => {
    expect(pusherFaceX(1.25)).toBeCloseTo(pusherFaceX(0.25), 9);
    expect(pusherFaceX(-0.25)).toBeCloseTo(pusherFaceX(0.75), 9);
  });
});

describe('hashInts', () => {
  it('is deterministic and well-mixed across nearby inputs', () => {
    const a = hashInts(1, 2, 3);
    const b = hashInts(1, 2, 3);
    expect(a).toBe(b);
    // Changing any one input by 1 must produce a different hash for
    // most inputs — this is a spot check (guarantees peg walks don't lock).
    let differ = 0;
    for (let i = 0; i < 50; i++) {
      if (hashInts(i, 0, 0) !== hashInts(i + 1, 0, 0)) differ++;
    }
    expect(differ).toBeGreaterThan(45);
  });
});

describe('currentPusherPhase', () => {
  it('interpolates smoothly and never returns >= 1', () => {
    const s = initialCoinPusherState(OWNER, 0);
    for (const dt of [0, 100, PUSHER_PERIOD_MS - 1, PUSHER_PERIOD_MS, PUSHER_PERIOD_MS * 3.7]) {
      const p = currentPusherPhase(s, dt);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});

// ── settlePiles ──────────────────────────────────────────────────────────────

describe('settlePiles', () => {
  it('sorts by x and enforces minimum spacing', () => {
    const n = { id: 1 };
    const piles = [pileN(0.30, 1, n), pileN(0.10, 1, n), pileN(0.32, 1, n)];
    const { piles: r, fallen } = settlePiles(piles, -Infinity, PLAT_UP_FRONT);
    expect(fallen).toHaveLength(0);
    expect(r[0].x).toBeCloseTo(0.10, 9);
    expect(r[1].x).toBeCloseTo(0.30, 9);
    // Third pile was too close to second; shoved to 0.30 + PILE_STEP.
    expect(r[2].x).toBeCloseTo(0.30 + PILE_STEP, 9);
  });

  it('enforces leftConstraint on the leftmost pile', () => {
    const n = { id: 1 };
    const piles = [pileN(0.02, 1, n)];
    const { piles: r } = settlePiles(piles, 0.10, PLAT_UP_FRONT);
    expect(r[0].x).toBeCloseTo(0.10, 9);
  });

  it('evicts any pile whose centre is past frontEdge', () => {
    const n = { id: 1 };
    const piles = [pileN(0.10, 1, n), pileN(0.65, 1, n)];
    const { piles: r, fallen } = settlePiles(piles, -Infinity, PLAT_UP_FRONT); // 0.60
    expect(r).toHaveLength(1);
    expect(fallen).toHaveLength(1);
    // The fallen chip is the one at 0.65.
    expect(fallen[0].x).toBeCloseTo(0.65, 9);
  });

  it('is pure — does not mutate the input array', () => {
    const n = { id: 1 };
    const original = [pileN(0.30, 1, n)];
    const snap = JSON.stringify(original);
    settlePiles(original, 0.05, PLAT_UP_FRONT);
    expect(JSON.stringify(original)).toBe(snap);
  });
});

// ── insertOnPlatform ─────────────────────────────────────────────────────────

describe('insertOnPlatform', () => {
  it('creates a new pile when landing on an empty platform', () => {
    const { piles, fallen } = insertOnPlatform([], 0.30, [1], PLAT_UP_FRONT);
    expect(piles).toHaveLength(1);
    expect(piles[0].chipIds).toEqual([1]);
    expect(fallen).toHaveLength(0);
  });

  it('stacks (merges) when landing atop an existing pile', () => {
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n)];
    const { piles } = insertOnPlatform(base, 0.30, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(1);
    expect(piles[0].count).toBe(2);
    expect(piles[0].chipIds).toEqual([1, 2]);
  });

  it('stacks when landing within CHIP_R of an existing pile (snap tolerance)', () => {
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n)];
    const { piles } = insertOnPlatform(base, 0.30 + CHIP_R * 0.9, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(1);
    expect(piles[0].count).toBe(2);
  });

  it('opens a distinct pile when landing beyond CHIP_R of any pile', () => {
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n)];
    // > CHIP_R off the existing centre → not a stack.
    const { piles } = insertOnPlatform(base, 0.30 + CHIP_R * 1.5, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(2);
  });

  it('shoves an abutting front pile forward when a chip stacks (contact impulse)', () => {
    // Two piles almost touching. New chip lands on the back pile; front pile
    // gets shoved forward by the landing impulse (chipCount × CHIP_R / 2).
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n), pileN(0.30 + PILE_STEP * 0.9, 1, n)];
    const startFrontX = base[1].x;
    const { piles } = insertOnPlatform(base, 0.30, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(2);
    expect(piles[0].count).toBe(2);
    expect(piles[1].count).toBe(1);
    // Front pile moved forward from its start position.
    expect(piles[1].x).toBeGreaterThan(startFrontX + 1e-9);
  });

  it('cascades a stack landing that pushes the front pile off the edge', () => {
    // A pile sitting almost at the front edge with one chip in a contact
    // chain behind it. A landing on the back pile shoves the front pile
    // past the edge.
    const n = { id: 1 };
    const back = pileN(PLAT_UP_FRONT - PILE_STEP * 1.05, 1, n);
    const front = pileN(PLAT_UP_FRONT - PILE_STEP * 0.05, 1, n);
    const base = [back, front];
    const { piles, fallen } = insertOnPlatform(base, back.x, [n.id++], PLAT_UP_FRONT);
    expect(fallen).toHaveLength(1);
    expect(fallen[0].chipIds).toEqual([2]);
    expect(piles).toHaveLength(1);
    expect(piles[0].chipIds).toEqual([1, 3]);
  });

  it('spills column overflow onto the pile ahead when a stack passes MAX_STACK_HEIGHT', () => {
    // A single column already at MAX gets an extra chip → overflow spills
    // forward as a NEW pile at x + PILE_STEP.
    const n = { id: 1 };
    const base = [pileN(0.30, MAX_STACK_HEIGHT, n)];
    const { piles } = insertOnPlatform(base, 0.30, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(2);
    // Landing pile stays capped, spill goes forward.
    const back = piles.find((p) => Math.abs(p.x - 0.30) <= CHIP_R)!;
    const front = piles.find((p) => Math.abs(p.x - (0.30 + PILE_STEP)) <= CHIP_R)!;
    expect(back.count).toBe(MAX_STACK_HEIGHT);
    expect(front.count).toBe(1);
    expect(front.chipIds).toEqual([MAX_STACK_HEIGHT + 1]);
  });

  it('propagates overflow through a full chain until it lands on a partial column', () => {
    // A chain of 3 fully-stacked columns, then a partial column ahead.
    const n = { id: 1 };
    const base = [
      pileN(0.30, MAX_STACK_HEIGHT, n),
      pileN(0.30 + PILE_STEP, MAX_STACK_HEIGHT, n),
      pileN(0.30 + PILE_STEP * 2, MAX_STACK_HEIGHT, n),
      pileN(0.30 + PILE_STEP * 3, 1, n),
    ];
    const initial = base.reduce((s, p) => s + p.count, 0);
    const { piles, fallen } = insertOnPlatform(base, 0.30, [n.id++], PLAT_UP_FRONT);
    // No chip lost — total conserved.
    const finalCount = piles.reduce((s, p) => s + p.count, 0) + fallen.reduce((s, p) => s + p.count, 0);
    expect(finalCount).toBe(initial + 1);
    // The partial column at 0.30 + 3*PILE_STEP absorbs the spilled chip.
    const target = piles.find((p) => Math.abs(p.x - (0.30 + PILE_STEP * 3)) <= CHIP_R)!;
    expect(target.count).toBe(2);
  });

  it('spills off the front when the overflow reaches the front edge', () => {
    // A chain filling all the way to the front edge; spill has nowhere to go.
    const n = { id: 1 };
    // Fill from mid-platform to just short of the front, all at MAX height.
    const startX = PLAT_UP_FRONT - PILE_STEP * 4;
    const base = [
      pileN(startX, MAX_STACK_HEIGHT, n),
      pileN(startX + PILE_STEP, MAX_STACK_HEIGHT, n),
      pileN(startX + PILE_STEP * 2, MAX_STACK_HEIGHT, n),
      pileN(startX + PILE_STEP * 3, MAX_STACK_HEIGHT, n),
    ];
    const initial = base.reduce((s, p) => s + p.count, 0);
    const { piles, fallen } = insertOnPlatform(base, startX, [n.id++], PLAT_UP_FRONT);
    const totalCount = piles.reduce((s, p) => s + p.count, 0) + fallen.reduce((s, p) => s + p.count, 0);
    expect(totalCount).toBe(initial + 1);
    // Something must have fallen off the front (the chain-cascaded overflow).
    expect(fallen.length).toBeGreaterThan(0);
  });
});

// ── simulatePeg ──────────────────────────────────────────────────────────────

describe('simulatePeg', () => {
  it('is deterministic for the same (hole, timing, seed)', () => {
    for (const h of [0, 1, 2] as const) {
      for (const t of [0, 0.25, 0.5, 0.75, 0.999]) {
        const a = simulatePeg(h, t, 12345);
        const b = simulatePeg(h, t, 12345);
        expect(a).toBe(b);
      }
    }
  });

  it('different seeds usually yield different trajectories', () => {
    let diff = 0;
    for (let s = 0; s < 20; s++) {
      if (simulatePeg(1, 0.5, s) !== simulatePeg(1, 0.5, s + 1000)) diff++;
    }
    expect(diff).toBeGreaterThan(10);
  });

  it('lands within +/-(TIMING_OFFSET + PEG_ROWS*PEG_DEFLECTION) of the hole', () => {
    // Every possible walk stays within this analytic bound.
    for (const h of [0, 1, 2] as const) {
      for (const s of [1, 2, 3, 42, 999]) {
        for (const t of [0, 0.5, 1]) {
          const x = simulatePeg(h, t, s);
          const maxDrift = CHIP_R + PEG_ROWS * 0.020;
          expect(Math.abs(x - HOLE_XS[h])).toBeLessThanOrEqual(maxDrift + 1e-9);
        }
      }
    }
  });

  it('exhausts a broad set of landing sites across a seed sweep', () => {
    // A 5-row symmetric walk of ±PEG_DEFLECTION yields (5 + 1) = 6 distinct
    // landing sums (from -5·d to +5·d in steps of 2·d). A well-distributed
    // hash must hit at least 5 of the 6 across a 500-seed sweep.
    const uniq = new Set<number>();
    for (let s = 0; s < 500; s++) {
      const x = simulatePeg(1, 0.5, s);
      uniq.add(Math.round(x * 1000)); // 1mm bucket
    }
    expect(uniq.size).toBeGreaterThanOrEqual(5);
  });

  it('handles out-of-range timing safely (clamps)', () => {
    // Not a crash / not a NaN — clamps into a normal walk.
    const x = simulatePeg(1, -0.5, 7);
    expect(Number.isFinite(x)).toBe(true);
    const y = simulatePeg(1, 2, 7);
    expect(Number.isFinite(y)).toBe(true);
    const z = simulatePeg(1, NaN, 7);
    expect(Number.isFinite(z)).toBe(true);
  });
});

// ── stepMachine (pusher physics) ─────────────────────────────────────────────

describe('stepMachine', () => {
  it('advances phase and pusherAtMs, bumps tick', () => {
    const s = initialCoinPusherState(OWNER, 1000);
    const r = stepMachine(s, 200);
    expect(r.state.pusherPhase).not.toBe(s.pusherPhase);
    expect(r.state.pusherAtMs).toBe(1200);
    expect(r.state.tick).toBe(1);
    expect(r.paidChipIds).toEqual([]);
  });

  it('no-ops on zero / negative / NaN dt', () => {
    const s = initialCoinPusherState(OWNER, 1000);
    expect(stepMachine(s, 0).state).toBe(s);
    expect(stepMachine(s, -5).state).toBe(s);
    expect(stepMachine(s, Number.NaN).state).toBe(s);
  });

  it('pushes an upper pile forward when the pusher advances into it', () => {
    // Place a pile at the back of the platform (right at pusher rest + CHIP_R).
    const p0 = pusherFaceX(0) + CHIP_R;
    const s = buildState((next) => [pileN(p0, 1, next)], () => []);
    // Advance a quarter cycle — pusher goes from ~min to about halfway forward.
    const r = stepMachine(s, PUSHER_PERIOD_MS / 4);
    expect(r.state.upper).toHaveLength(1);
    expect(r.state.upper[0].x).toBeGreaterThan(p0);
    assertConserved(r.state, 'after push');
  });

  it('does not drag chips backward when the pusher retracts', () => {
    // Start at phase 0.5 (fully extended). Place a pile just past the
    // pusher's max-face constraint.
    const startX = PUSHER_MAX_X + CHIP_R + 0.03;
    const s = buildState(
      (next) => [pileN(startX, 1, next)],
      () => [],
      { pusherPhase: 0.5 },
    );
    // Advance through the retract half.
    const r = stepMachine(s, PUSHER_PERIOD_MS / 4);
    // Chip x is unchanged (or only shifted by settlement) — not dragged back.
    expect(r.state.upper[0].x).toBeCloseTo(startX, 9);
    assertConserved(r.state, 'after retract');
  });

  it('drops an upper pile onto the lower platform when pushed past the front', () => {
    // Pile sitting just past the upper front edge — one nudge and it tips.
    const s = buildState(
      (next) => [pileN(PLAT_UP_FRONT + 0.001, 1, next)],
      () => [],
    );
    const r = stepMachine(s, 50);
    // Chip is no longer on upper; it's on lower.
    expect(r.state.upper).toHaveLength(0);
    expect(r.state.lower.some((p) => p.count >= 1)).toBe(true);
    assertConserved(r.state, 'after upper tip');
  });

  it('pays out when a chain cascade off upper drops onto a filled lower', () => {
    // Upper pile just past the front edge — will fall onto lower back.
    // Lower has a contact chain from back edge nearly to the front edge:
    // when the falling weight cascades that chain forward, the front pile
    // tips off into the payout tray.
    const s = buildState(
      (next) => [pileN(PLAT_UP_FRONT + 0.005, 3, next)],
      (next) => {
        // Chain of 10 piles from PLAT_LOW_BACK + CHIP_R to PLAT_LOW_FRONT - 0.01,
        // touching at PILE_STEP intervals so the impulse propagates.
        const piles: Pile[] = [];
        const start = PLAT_LOW_BACK + CHIP_R;
        for (let i = 0; i < 10; i++) {
          piles.push(pileN(start + i * PILE_STEP, 1, next));
        }
        return piles;
      },
    );
    const r = stepMachine(s, 50);
    expect(r.paidChipIds.length).toBeGreaterThan(0);
    expect(r.state.totalPaid).toBeGreaterThan(0);
    assertConserved(r.state, 'after lower payout');
  });

  it('never overlaps two piles horizontally after a step', () => {
    const s = buildState(
      (next) => [
        pileN(0.10, 1, next),
        pileN(0.12, 1, next),
        pileN(0.15, 1, next),
        pileN(0.20, 1, next),
      ],
      () => [],
    );
    const r = stepMachine(s, PUSHER_PERIOD_MS / 4);
    for (let i = 1; i < r.state.upper.length; i++) {
      expect(r.state.upper[i].x).toBeGreaterThanOrEqual(
        r.state.upper[i - 1].x + PILE_STEP - 1e-9,
      );
    }
    assertConserved(r.state, 'no overlaps');
  });
});

// ── advanceSim ───────────────────────────────────────────────────────────────

describe('advanceSim', () => {
  it('attributes payouts to payoutTo (pendingCredit)', () => {
    const s = buildState(
      (next) => [pileN(PLAT_UP_FRONT + 0.005, 3, next)],
      (next) => {
        const piles: Pile[] = [];
        const start = PLAT_LOW_BACK + CHIP_R;
        for (let i = 0; i < 10; i++) {
          piles.push(pileN(start + i * PILE_STEP, 1, next));
        }
        return piles;
      },
    );
    const r = advanceSim(s, 500, PLAYER1);
    expect(r.state.pendingCredit[PLAYER1]).toBeGreaterThan(0);
    assertConserved(r.state, 'advanceSim credit');
  });

  it('no-ops on zero / NaN elapsed', () => {
    const s = initialCoinPusherState(OWNER, 0);
    expect(advanceSim(s, 0, PLAYER1).state).toBe(s);
    expect(advanceSim(s, Number.NaN, PLAYER1).state).toBe(s);
  });

  it('leaves pendingCredit empty when payoutTo is null (still counts totalPaid)', () => {
    const s = buildState(
      (next) => [pileN(PLAT_UP_FRONT + 0.005, 3, next)],
      (next) => {
        const piles: Pile[] = [];
        const start = PLAT_LOW_BACK + CHIP_R;
        for (let i = 0; i < 10; i++) {
          piles.push(pileN(start + i * PILE_STEP, 1, next));
        }
        return piles;
      },
    );
    const r = advanceSim(s, 500, null);
    expect(Object.keys(r.state.pendingCredit)).toHaveLength(0);
    expect(r.state.totalPaid).toBeGreaterThan(0);
    assertConserved(r.state, 'advanceSim null payoutTo');
  });
});

// ── processInsert ────────────────────────────────────────────────────────────

describe('processInsert', () => {
  it('adds one chip to the upper platform and bumps totalInserted', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    const r = processInsert(s0, PLAYER1, 1, 0.5, 1, 42, 0);
    expect(r.state.totalInserted).toBe(1);
    // Chip ended up either in machine, paid out, or (impossible here) emptied.
    const total = chipsInMachine(r.state) + r.state.totalPaid + r.state.totalEmptied;
    expect(total).toBe(1);
    assertConserved(r.state, 'processInsert first');
  });

  it('rejects out-of-range ante', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    expect(() => processInsert(s0, PLAYER1, 1, 0.5, 0, 42, 0)).toThrow(RangeError);
    expect(() => processInsert(s0, PLAYER1, 1, 0.5, PUSHER_MAX_ANTE + 1, 42, 0)).toThrow(RangeError);
    expect(() => processInsert(s0, PLAYER1, 1, 0.5, 1.5, 42, 0)).toThrow(RangeError);
  });

  it('rejects bad playerId', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    expect(() => processInsert(s0, '', 1, 0.5, 1, 42, 0)).toThrow(RangeError);
    expect(() => processInsert(s0, 'x'.repeat(200), 1, 0.5, 1, 42, 0)).toThrow(RangeError);
  });

  it('same seed + timing + hole produces same trajectory', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    const a = processInsert(s0, PLAYER1, 0, 0.3, 1, 777, 0);
    const b = processInsert(s0, PLAYER1, 0, 0.3, 1, 777, 0);
    expect(a.landedX).toBe(b.landedX);
    // Same state (chips landing at same spot; deterministic settle).
    expect(JSON.stringify(a.state.upper)).toBe(JSON.stringify(b.state.upper));
  });

  it('cascades and pays out over many inserts (a full run must produce SOME payout)', () => {
    // Repeatedly insert with varied hole+timing — eventually the pusher
    // shoves piles off the upper front, they cascade onto lower, lower
    // overflows to payouts.
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 200; i++) {
      const hole = ((i % 3) as PusherHole);
      const t = (i * 0.017) % 1;
      const r = processInsert(s, PLAYER1, hole, t, 1, 4242 + i, i * 100);
      s = r.state;
      assertConserved(s, `insert ${i}`);
    }
    expect(s.totalInserted).toBe(200);
    expect(s.totalPaid).toBeGreaterThan(0);
    expect(s.pendingCredit[PLAYER1] ?? 0).toBeGreaterThan(0);
  });

  it('credits payouts only to the current inserter (not to earlier depositors)', () => {
    // PLAYER1 fills the machine, PLAYER2 triggers cascade. Payouts on
    // PLAYER2's insert accrue to PLAYER2 alone.
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 100; i++) {
      s = processInsert(s, PLAYER1, ((i % 3) as PusherHole), (i * 0.19) % 1, 1, 1000 + i, i * 50).state;
    }
    const paidToP1Before = s.pendingCredit[PLAYER1] ?? 0;
    const paidToP2Before = s.pendingCredit[PLAYER2] ?? 0;
    // Now flood with P2 inserts.
    let paidP2 = 0;
    for (let i = 0; i < 40; i++) {
      const r = processInsert(s, PLAYER2, ((i % 3) as PusherHole), (i * 0.23) % 1, 1, 5000 + i, (100 + i) * 50);
      paidP2 += r.paidChipIds.length;
      s = r.state;
    }
    if (paidP2 > 0) {
      // Any payout across P2's inserts must accumulate in P2's ledger,
      // not P1's — P1's balance is unchanged by P2's cycles.
      expect(s.pendingCredit[PLAYER2] ?? 0).toBeGreaterThan(paidToP2Before);
      expect(s.pendingCredit[PLAYER1] ?? 0).toBe(paidToP1Before);
    }
    assertConserved(s, 'mixed players');
  });
});

// ── emptyMachine ─────────────────────────────────────────────────────────────

describe('emptyMachine', () => {
  it('refuses a non-owner (ok=false, state unchanged, no ledger change)', () => {
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 10; i++) s = processInsert(s, PLAYER1, 1, 0.5, 1, i, 0).state;
    const snapshot = JSON.stringify(s);
    const r = emptyMachine(s, PLAYER1);
    expect(r.ok).toBe(false);
    expect(r.emptied).toBe(0);
    expect(JSON.stringify(r.state)).toBe(snapshot);
  });

  it('empties every pile and grows totalEmptied by the count', () => {
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 12; i++) s = processInsert(s, PLAYER1, ((i % 3) as PusherHole), 0.5, 1, i * 7, 0).state;
    const before = chipsInMachine(s);
    const r = emptyMachine(s, OWNER);
    expect(r.ok).toBe(true);
    expect(r.emptied).toBe(before);
    expect(chipsInMachine(r.state)).toBe(0);
    expect(r.state.totalEmptied).toBe(before);
    assertConserved(r.state, 'after empty');
  });

  it('is a no-op when the machine is already empty', () => {
    const s = initialCoinPusherState(OWNER, 0);
    const r = emptyMachine(s, OWNER);
    expect(r.ok).toBe(true);
    expect(r.emptied).toBe(0);
    assertConserved(r.state, 'empty-when-empty');
  });
});

// ── claimPendingCredit ───────────────────────────────────────────────────────

describe('claimPendingCredit', () => {
  it('returns 0 and does not modify state when nothing owed', () => {
    const s = initialCoinPusherState(OWNER, 0);
    const r = claimPendingCredit(s, PLAYER1);
    expect(r.amount).toBe(0);
    expect(r.state).toBe(s);
  });

  it('zeros exactly one player credit and returns the amount', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    const s: CoinPusherState = {
      ...s0,
      pendingCredit: { [PLAYER1]: 3, [PLAYER2]: 2 },
    };
    const r = claimPendingCredit(s, PLAYER1);
    expect(r.amount).toBe(3);
    expect(r.state.pendingCredit[PLAYER1]).toBeUndefined();
    expect(r.state.pendingCredit[PLAYER2]).toBe(2);
  });
});

// ── Conservation invariant across a long randomised run ──────────────────────

describe('conservation invariant', () => {
  it('holds through hundreds of inserts and periodic owner empties', () => {
    let s = initialCoinPusherState(OWNER, 0);
    let now = 0;
    for (let i = 0; i < 500; i++) {
      const hole = (i % 3) as PusherHole;
      const t = (Math.sin(i) * 0.5 + 0.5); // deterministic pseudo-timing
      now += 137;
      s = processInsert(s, i % 2 === 0 ? PLAYER1 : PLAYER2, hole, t, 1, i * 31 + 1, now).state;
      assertConserved(s, `insert-${i}`);
      // Owner empties every 100 inserts.
      if (i > 0 && i % 100 === 0) {
        const r = emptyMachine(s, OWNER);
        s = r.state;
        assertConserved(s, `after-empty-${i}`);
      }
    }
    // Final: chipsInMachine + totalPaid + totalEmptied == totalInserted.
    const c = computeConservation(s);
    expect(c.balanced).toBe(true);
    expect(c.totalInserted).toBe(500);
  });

  it('is preserved even when a hostile timing produces edge cases', () => {
    // Every insert with timing=0 and consecutive seeds — corner cases like
    // early wall-hit, flat pile stacks, etc.
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 200; i++) {
      s = processInsert(s, PLAYER1, ((i % 3) as PusherHole), 0, 1, i, i * 10).state;
      assertConserved(s, `hostile-timing-${i}`);
    }
  });
});

// ── Read-only helpers ────────────────────────────────────────────────────────

describe('chipsInMachine', () => {
  it('sums both platforms', () => {
    const s = buildState(
      (n) => [pileN(0.20, 2, n)],
      (n) => [pileN(0.70, 3, n)],
    );
    expect(chipsInMachine(s)).toBe(5);
  });
});
