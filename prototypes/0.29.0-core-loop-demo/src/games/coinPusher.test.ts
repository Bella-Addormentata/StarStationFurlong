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
 *   • one chip per drop, and the machine comes to rest after every drop
 *   • drop timing keeps the player's phase only inside the window, measured
 *     absolutely (a claim a whole cycle old never passes for a fresh one)
 *   • the sweep anchor never moves, so every client draws the same pusher
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
  computeConservation,
  currentPusherPhase,
  DROP_PHASE_MATCH_MS,
  emptyMachine,
  hashInts,
  HOLE_XS,
  initialCoinPusherState,
  insertOnPlatform,
  isCoinPusherState,
  isPusherEmptyRequest,
  isPusherInsertRequest,
  isPusherResult,
  MACHINE_MAX_CHIPS,
  MAX_DROP_LAG_MS,
  MAX_DROP_LEAD_MS,
  MAX_STACK_HEIGHT,
  normalizeCoinPusherState,
  PEG_ROWS,
  PILE_STEP,
  PLAT_LOW_BACK,
  PLAT_LOW_FRONT,
  PLAT_UP_FRONT,
  processInsert,
  PUSHER_ANTE,
  PUSHER_MAX_X,
  PUSHER_MIN_X,
  PUSHER_PERIOD_MS,
  pusherFaceX,
  RECENT_DROPS_MAX,
  resolveDropTiming,
  SETTLE_MS,
  settlePiles,
  simulatePeg,
  stepMachine,
  unseenDropHoles,
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
}

/** `perPlatform` piles of 8 chips on each platform, spaced one pile apart
 *  from each platform's back edge, with a balanced ledger. */
function fullMachine(perPlatform: number): CoinPusherState {
  const next = { id: 1 };
  const row = (from: number): Pile[] =>
    Array.from({ length: perPlatform }, (_, i) => pileN(from + CHIP_R + i * PILE_STEP, 8, next));
  const upper = row(0);
  const lower = row(PLAT_LOW_BACK);
  return {
    ...initialCoinPusherState(OWNER),
    upper,
    lower,
    nextChipId: next.id,
    totalInserted: 16 * perPlatform,
  };
}

/** A tiny deterministic PRNG for randomised runs (no Math.random). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 2 ** 32;
  };
}

/** Drop `n` chips with varied holes / phases / seeds; returns the machine. */
function fill(n: number, player = PLAYER1, seed = 7, s0 = initialCoinPusherState(OWNER, 0)): CoinPusherState {
  const rand = lcg(seed);
  let s = s0;
  for (let i = 0; i < n; i++) {
    s = processInsert(s, player, Math.floor(rand() * 3) as PusherHole, rand() * 0.999, (rand() * 2 ** 32) >>> 0).state;
  }
  return s;
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

  it('rejects a state holding more chips than the cabinet can (aggregate cap)', () => {
    // Every pile sits on its platform and within its own limit, and the
    // ledger balances, but the total does not fit: 20 piles × 8 = 160.
    const over = fullMachine(10);
    expect(chipsInMachine(over)).toBe(160);
    expect(isCoinPusherState(over)).toBe(false);
    // …while a machine at exactly the cap is accepted.
    const atCap = fullMachine(8);
    expect(chipsInMachine(atCap)).toBe(MACHINE_MAX_CHIPS);
    expect(isCoinPusherState(atCap)).toBe(true);
  });

  it('rejects a pile off its own platform (the renderer maps x linearly)', () => {
    const s = fill(30);
    const off = (upper: Pile[], lower: Pile[]) => ({ ...s, upper, lower });
    const pile = (x: number): Pile => ({ ...s.upper.concat(s.lower)[0], x });
    expect(isCoinPusherState(s)).toBe(true);
    for (const x of [PLAT_UP_FRONT + 0.01, -0.01, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(isCoinPusherState(off([pile(x)], s.lower)), `upper at ${x}`).toBe(false);
    }
    for (const x of [PLAT_LOW_BACK - 0.01, PLAT_LOW_FRONT + 0.01, Number.MAX_VALUE]) {
      expect(isCoinPusherState(off(s.upper, [pile(x)])), `lower at ${x}`).toBe(false);
    }
  });

  it('rejects a state whose own ledger does not balance (an operator never writes one)', () => {
    const s = fill(20);
    expect(isCoinPusherState(s)).toBe(true);
    expect(isCoinPusherState({ ...s, totalInserted: s.totalInserted + 1 })).toBe(false);
    expect(isCoinPusherState({ ...s, totalPaid: s.totalPaid + 1 })).toBe(false);
    expect(isCoinPusherState({ ...s, totalEmptied: s.totalEmptied + 1 })).toBe(false);
  });

  it('checks lastDrop when present', () => {
    const s = initialCoinPusherState(OWNER);
    const drop = {
      requestId: 'r1', player: PLAYER1, hole: 1, chipId: 1, landedX: 0.3,
      paid: 0, phase: 0.25, honored: true, atMs: 5,
    };
    expect(isCoinPusherState({ ...s, lastDrop: drop })).toBe(true);
    expect(isCoinPusherState({ ...s, lastDrop: { ...drop, phase: 1 } })).toBe(false);
    expect(isCoinPusherState({ ...s, lastDrop: { ...drop, honored: 'yes' } })).toBe(false);
    expect(isCoinPusherState({ ...s, lastDrop: { ...drop, paid: MACHINE_MAX_CHIPS + 1 } })).toBe(false);
  });

  it('result guard accepts a drop or a refusal answer and rejects junk', () => {
    const drop = { kind: 'drop', requestId: 'r1', paid: 2, honored: true, atMs: 5 };
    const refused = { kind: 'refused', requestId: 'r2', reason: 'no-chips', atMs: 5 };
    expect(isPusherResult(drop)).toBe(true);
    expect(isPusherResult(refused)).toBe(true);
    expect(isPusherResult({ ...drop, paid: -1 })).toBe(false);
    expect(isPusherResult({ ...drop, paid: MACHINE_MAX_CHIPS + 1 })).toBe(false);
    expect(isPusherResult({ ...drop, honored: 'yes' })).toBe(false);
    expect(isPusherResult({ ...refused, reason: 'bored' })).toBe(false);
    expect(isPusherResult({ ...refused, kind: 'other' })).toBe(false);
    expect(isPusherResult({ ...drop, requestId: '' })).toBe(false);
    expect(isPusherResult(null)).toBe(false);
  });

  it('accepts a plausibly-large legitimate state (round-trip after JSON)', () => {
    const populated = buildState(
      (n) => [pileN(0.20, 2, n), pileN(0.28, 1, n)],
      (n) => [pileN(0.70, 1, n), pileN(0.76, 1, n)],
    );
    // JSON round-trip is what a real doc read looks like.
    expect(isCoinPusherState(JSON.parse(JSON.stringify(populated)))).toBe(true);
  });

  it('insert-request and door-request guards reject junk', () => {
    const ok = { requestId: 'r1', player: PLAYER1, hole: 1, phase: 0.5, requestedAt: 0 };
    expect(isPusherInsertRequest(ok)).toBe(true);
    expect(isPusherInsertRequest(null)).toBe(false);
    expect(isPusherInsertRequest({ ...ok, hole: 3 })).toBe(false);
    expect(isPusherInsertRequest({ ...ok, phase: 1 })).toBe(false);
    expect(isPusherInsertRequest({ ...ok, phase: -0.1 })).toBe(false);
    expect(isPusherInsertRequest({ ...ok, player: '' })).toBe(false);
    expect(isPusherInsertRequest({ ...ok, requestedAt: Number.NaN })).toBe(false);
    const door = { requestId: 'd1', requester: OWNER, requestedAt: 0 };
    expect(isPusherEmptyRequest(door)).toBe(true);
    expect(isPusherEmptyRequest({ ...door, requester: '' })).toBe(false);
    expect(isPusherEmptyRequest({ ...door, requestedAt: 'now' })).toBe(false);
  });
});

describe('normalizeCoinPusherState', () => {
  it('drops fields an older revision or a peer added, and copies the piles', () => {
    const s = fill(20);
    const withJunk = { ...s, pendingCredit: { [PLAYER1]: 5 }, extra: 'x' } as unknown;
    const n = normalizeCoinPusherState(withJunk)!;
    expect(n).not.toBeNull();
    expect('pendingCredit' in n).toBe(false);
    expect('extra' in n).toBe(false);
    expect(n.upper).toEqual(s.upper);
    expect(n.upper).not.toBe(s.upper);
    expect(n.lastDrop).toBeUndefined();
    expect(isCoinPusherState(n)).toBe(true);
  });

  it('returns null for a state the guard rejects', () => {
    expect(normalizeCoinPusherState({ ...initialCoinPusherState(OWNER), tick: -1 })).toBeNull();
    expect(normalizeCoinPusherState('junk')).toBeNull();
  });

  it('keeps the recent drop marks, and only their known fields', () => {
    const s = { ...fill(5), recentDrops: [{ chipId: 4, hole: 2, extra: 'x' }, { chipId: 5, hole: 0 }] };
    expect(normalizeCoinPusherState(s)!.recentDrops).toEqual([{ chipId: 4, hole: 2 }, { chipId: 5, hole: 0 }]);
  });
});

// ── Recent drops (the cabinet's drop lights) ─────────────────────────────────

describe('recent drops', () => {
  const base = fill(6); // nextChipId 7
  const marks = (...holes: PusherHole[]) =>
    holes.map((hole, i) => ({ chipId: base.nextChipId - holes.length + i, hole }));

  it('the guard takes up to RECENT_DROPS_MAX well-formed marks and nothing else', () => {
    expect(isCoinPusherState({ ...base, recentDrops: marks(0, 1, 2) })).toBe(true);
    const many = Array.from({ length: RECENT_DROPS_MAX + 1 }, (_, i) => ({ chipId: i, hole: 0 }));
    for (const bad of [
      many,
      [{ chipId: 1, hole: 3 }],
      [{ chipId: -1, hole: 0 }],
      [{ chipId: 1.5, hole: 1 }],
      [{ hole: 1 }],
      // A mark for a chip the machine hasn't dropped.
      [{ chipId: base.nextChipId, hole: 0 }],
      'marks',
    ]) {
      expect(isCoinPusherState({ ...base, recentDrops: bad as never })).toBe(false);
    }
  });

  it('shows a viewer every drop since it last looked, however many landed at once', () => {
    const s = { ...base, recentDrops: marks(1, 0, 2, 2) };
    // It last looked when nextChipId was 4: chips 4, 5 and 6 are new.
    expect(unseenDropHoles(s, 4)).toEqual([0, 2, 2]);
    expect(unseenDropHoles(s, base.nextChipId)).toEqual([]);
  });

  it('shows nothing of a new machine whose chip ids start again', () => {
    const fresh = { ...fill(2), recentDrops: [{ chipId: 1, hole: 0 as PusherHole }, { chipId: 2, hole: 1 as PusherHole }] };
    expect(unseenDropHoles(fresh, 40)).toEqual([]);
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

  it('is one line through the anchor in both directions (a clock behind the anchor still gets its phase)', () => {
    const s = { ...initialCoinPusherState(OWNER, 10_000), pusherPhase: 0.25 };
    expect(currentPusherPhase(s, 10_000)).toBeCloseTo(0.25, 12);
    expect(currentPusherPhase(s, 10_000 + PUSHER_PERIOD_MS / 4)).toBeCloseTo(0.5, 12);
    expect(currentPusherPhase(s, 10_000 - PUSHER_PERIOD_MS / 4)).toBeCloseTo(0, 12);
    expect(currentPusherPhase(s, 10_000 - PUSHER_PERIOD_MS / 2)).toBeCloseTo(0.75, 12);
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

  it('caps a multi-chip pile that lands on open floor too', () => {
    // A tall pile falling onto an empty stretch of platform: no stack to
    // merge with, but the column still can't stand past MAX_STACK_HEIGHT.
    const n = { id: 1 };
    const tall = pileN(0.40, MAX_STACK_HEIGHT + 2, n);
    const { piles, fallen } = insertOnPlatform([], 0.80, tall.chipIds, PLAT_LOW_FRONT);
    expect(fallen).toEqual([]);
    expect(piles.map((p) => p.count)).toEqual([MAX_STACK_HEIGHT, 2]);
    expect(piles[1].x).toBeCloseTo(0.80 + PILE_STEP, 12);
    expect(piles.flatMap((p) => p.chipIds)).toEqual(tall.chipIds);
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

  it('pushes to the furthest reach within a substep, even between its end points', () => {
    // A substep straddling full extension (phase ½) without landing on it:
    // both end points fall short of PUSHER_MAX_X, the sweep in between does not.
    const x0 = PUSHER_MAX_X + CHIP_R - 0.0005;
    const s = buildState((next) => [pileN(x0, 1, next)], () => [], { pusherPhase: 0.49 });
    const r = stepMachine(s, PUSHER_PERIOD_MS * 0.02); // phase 0.49 → 0.51
    expect(pusherFaceX(0.49)).toBeLessThan(PUSHER_MAX_X);
    expect(pusherFaceX(0.51)).toBeLessThan(PUSHER_MAX_X);
    expect(r.state.upper[0].x).toBeCloseTo(PUSHER_MAX_X + CHIP_R, 12);
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
  it('counts every chip that falls off the lower front in totalPaid', () => {
    const s = buildState(
      (next) => [pileN(PLAT_UP_FRONT + 0.005, 3, next)],
      (next) => {
        const piles: Pile[] = [];
        const start = PLAT_LOW_BACK + CHIP_R;
        for (let i = 0; i < 10; i++) piles.push(pileN(start + i * PILE_STEP, 1, next));
        return piles;
      },
    );
    const r = advanceSim(s, 500);
    expect(r.paidChipIds.length).toBeGreaterThan(0);
    expect(r.state.totalPaid).toBe(r.paidChipIds.length);
    assertConserved(r.state, 'advanceSim');
  });

  it('no-ops on zero / NaN elapsed', () => {
    const s = initialCoinPusherState(OWNER, 0);
    expect(advanceSim(s, 0).state).toBe(s);
    expect(advanceSim(s, Number.NaN).state).toBe(s);
  });
});

// ── resolveDropTiming ────────────────────────────────────────────────────────

describe('resolveDropTiming', () => {
  const s = initialCoinPusherState(OWNER, 0); // phase 0 at t=0
  const phaseAt = (ms: number) => currentPusherPhase(s, ms);

  /** A claim as an honest panel makes it: the phase on screen at `at`. */
  const claim = (at: number, receivedAt: number) =>
    resolveDropTiming(s, phaseAt(at), at, receivedAt);

  it('keeps the phase the player saw when it arrives inside the lag window', () => {
    const r = claim(10_000, 10_000 + MAX_DROP_LAG_MS - 1);
    expect(r.honored).toBe(true);
    expect(r.dropPhase).toBe(phaseAt(10_000));
    expect(r.lagMs).toBe(MAX_DROP_LAG_MS - 1);
  });

  it('keeps a claim slightly ahead of the operator (a player clock running fast)', () => {
    const r = claim(10_000 + MAX_DROP_LEAD_MS - 1, 10_000);
    expect(r.honored).toBe(true);
    expect(r.lagMs).toBe(-(MAX_DROP_LEAD_MS - 1));
  });

  it('drops a stale or far-ahead claim at the operator\'s current phase', () => {
    for (const claimedAt of [10_000 - MAX_DROP_LAG_MS - 50, 10_000 + MAX_DROP_LEAD_MS + 50]) {
      const r = claim(claimedAt, 10_000);
      expect(r.honored).toBe(false);
      expect(r.dropPhase).toBeCloseTo(phaseAt(10_000), 12);
    }
  });

  it('never takes a claim a whole cycle (or more) old for a fresh one', () => {
    // Same phase on the pusher as 100 ms ago, but a cycle or two later.
    for (const receivedAt of [10_000 + PUSHER_PERIOD_MS + 100, 10_000 + 2 * PUSHER_PERIOD_MS + 50]) {
      const r = claim(10_000, receivedAt);
      expect(r.honored).toBe(false);
      expect(r.lagMs).toBe(receivedAt - 10_000);
      expect(r.dropPhase).toBeCloseTo(phaseAt(receivedAt), 12);
    }
  });

  it('keeps no phase that wasn\'t on screen at the claimed moment', () => {
    for (const off of [0.3, -0.1, 0.5]) {
      const phase = (phaseAt(10_000) + off + 1) % 1;
      expect(resolveDropTiming(s, phase, 10_000, 10_100).honored).toBe(false);
    }
    // Rounding room only.
    const nudged = phaseAt(10_000) + DROP_PHASE_MATCH_MS / PUSHER_PERIOD_MS / 2;
    expect(resolveDropTiming(s, nudged, 10_000, 10_100).honored).toBe(true);
  });

  it('measures the lag across the end of a cycle', () => {
    // Claimed just before the wrap (0.98), received just after it (0.02).
    const r = claim(PUSHER_PERIOD_MS * 0.98, PUSHER_PERIOD_MS * 1.02);
    expect(r.honored).toBe(true);
    expect(r.lagMs).toBeCloseTo(PUSHER_PERIOD_MS * 0.04, 6);
  });

  it('never honours junk (out-of-range phase, NaN time)', () => {
    expect(resolveDropTiming(s, 1, 5_000, 5_000).honored).toBe(false);
    expect(resolveDropTiming(s, -0.2, 5_000, 5_000).honored).toBe(false);
    expect(resolveDropTiming(s, Number.NaN, 5_000, 5_000).honored).toBe(false);
    expect(resolveDropTiming(s, phaseAt(5_000), Number.NaN, 5_000).honored).toBe(false);
    expect(resolveDropTiming(s, phaseAt(5_000), 5_000, Number.NaN).honored).toBe(false);
  });
});

// ── processInsert ────────────────────────────────────────────────────────────

describe('processInsert', () => {
  it('drops exactly one chip: one new id, totalInserted and nextChipId +1', () => {
    const s0 = fill(30);
    const r = processInsert(s0, PLAYER1, 1, 0.5, 42);
    expect(PUSHER_ANTE).toBe(1);
    expect(r.chipId).toBe(s0.nextChipId);
    expect(r.state.nextChipId).toBe(s0.nextChipId + 1);
    expect(r.state.totalInserted).toBe(s0.totalInserted + 1);
    expect(r.paid).toBe(r.paidChipIds.length);
    expect(r.state.totalPaid).toBe(s0.totalPaid + r.paid);
    const ids = [...r.state.upper, ...r.state.lower].flatMap((p) => p.chipIds).concat(r.paidChipIds);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain(r.chipId);
    assertConserved(r.state, 'one chip');
  });

  it('rejects a bad player id, hole or phase', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    expect(() => processInsert(s0, '', 1, 0.5, 42)).toThrow(RangeError);
    expect(() => processInsert(s0, 'x'.repeat(200), 1, 0.5, 42)).toThrow(RangeError);
    expect(() => processInsert(s0, PLAYER1, 3 as PusherHole, 0.5, 42)).toThrow(RangeError);
    expect(() => processInsert(s0, PLAYER1, 1, 1, 42)).toThrow(RangeError);
    expect(() => processInsert(s0, PLAYER1, 1, Number.NaN, 42)).toThrow(RangeError);
  });

  it('refuses a drop into a full machine', () => {
    const full = fullMachine(8);
    expect(chipsInMachine(full)).toBe(MACHINE_MAX_CHIPS);
    expect(() => processInsert(full, PLAYER1, 1, 0.5, 42)).toThrow(/full/);
  });

  it('same seed + phase + hole produces the same result', () => {
    const s0 = fill(25);
    const a = processInsert(s0, PLAYER1, 0, 0.3, 777);
    const b = processInsert(s0, PLAYER1, 0, 0.3, 777);
    expect(a.landedX).toBe(b.landedX);
    expect(a.state).toEqual(b.state);
  });

  it('never moves the sweep anchor, so the pusher every client draws never jumps', () => {
    let s = { ...initialCoinPusherState(OWNER, 1234), pusherPhase: 0.4 };
    const rand = lcg(3);
    for (let i = 0; i < 50; i++) {
      s = processInsert(s, PLAYER1, (i % 3) as PusherHole, rand() * 0.999, i).state;
      expect(s.pusherPhase).toBe(0.4);
      expect(s.pusherAtMs).toBe(1234);
    }
  });

  it('leaves the machine at rest: another full cycle moves and pays nothing', () => {
    const rand = lcg(11);
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 120; i++) {
      s = processInsert(s, PLAYER1, Math.floor(rand() * 3) as PusherHole, rand() * 0.999, i * 97).state;
      const idle = advanceSim(s, SETTLE_MS);
      expect(idle.paidChipIds, `drop ${i}`).toEqual([]);
      expect(idle.state.upper, `drop ${i}`).toEqual(s.upper);
      expect(idle.state.lower, `drop ${i}`).toEqual(s.lower);
    }
  });

  it('pays out over a long run, and the machine settles far below its cap', () => {
    const rand = lcg(99);
    let s = initialCoinPusherState(OWNER, 0);
    let most = 0;
    for (let i = 0; i < 2000; i++) {
      s = processInsert(s, PLAYER1, Math.floor(rand() * 3) as PusherHole, rand() * 0.999, (rand() * 2 ** 32) >>> 0).state;
      most = Math.max(most, chipsInMachine(s));
    }
    expect(s.totalInserted).toBe(2000);
    expect(s.totalPaid).toBeGreaterThan(1500);
    // The pile reaches a steady state (~40 chips); the cap is headroom, not a
    // limit honest play runs into.
    expect(most).toBeLessThan(MACHINE_MAX_CHIPS / 2);
    assertConserved(s, 'long run');
  });
});

// ── emptyMachine ─────────────────────────────────────────────────────────────

describe('emptyMachine', () => {
  it('refuses a non-owner (ok=false, state unchanged, no ledger change)', () => {
    const s = fill(10);
    const snapshot = JSON.stringify(s);
    const r = emptyMachine(s, PLAYER1);
    expect(r.ok).toBe(false);
    expect(r.emptied).toBe(0);
    expect(JSON.stringify(r.state)).toBe(snapshot);
  });

  it('empties every pile and grows totalEmptied by the count', () => {
    const s = fill(12);
    const before = chipsInMachine(s);
    const r = emptyMachine(s, OWNER);
    expect(r.ok).toBe(true);
    expect(r.emptied).toBe(before);
    expect(chipsInMachine(r.state)).toBe(0);
    expect(r.state.totalEmptied).toBe(before);
    expect(r.state.tick).toBe(s.tick + 1);
    assertConserved(r.state, 'after empty');
  });

  it('is a no-op on the chips when the machine is already empty', () => {
    const r = emptyMachine(initialCoinPusherState(OWNER, 0), OWNER);
    expect(r.ok).toBe(true);
    expect(r.emptied).toBe(0);
    assertConserved(r.state, 'empty-when-empty');
  });
});

// ── Conservation invariant across a long randomised run ──────────────────────

describe('conservation invariant', () => {
  it('holds through hundreds of drops by two players and periodic owner empties', () => {
    const rand = lcg(5);
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 500; i++) {
      const player = i % 2 === 0 ? PLAYER1 : PLAYER2;
      s = processInsert(s, player, (i % 3) as PusherHole, rand() * 0.999, i * 31 + 1).state;
      assertConserved(s, `drop-${i}`);
      if (i > 0 && i % 100 === 0) {
        s = emptyMachine(s, OWNER).state;
        assertConserved(s, `after-empty-${i}`);
      }
    }
    const c = computeConservation(s);
    expect(c.balanced).toBe(true);
    expect(c.totalInserted).toBe(500);
  });

  it('holds at the phase edges (every drop at phase 0)', () => {
    let s = initialCoinPusherState(OWNER, 0);
    for (let i = 0; i < 200; i++) {
      s = processInsert(s, PLAYER1, (i % 3) as PusherHole, 0, i).state;
      assertConserved(s, `phase-0-${i}`);
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
